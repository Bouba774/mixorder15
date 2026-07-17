import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace, type Track, type TrackId } from "@/lib/workspace-context";
import {
  getBridge,
  isPlausibleBpm,
  type DeckId,
  type DiscDJBridge,
  type DiscDJReading,
} from "./discdj-bridge";
import {
  CALIBRATION_SCREEN,
  getDeckCalibration,
  isDeckCalibrated,
  loadDiscDJSettings,
  saveDiscDJSettings,
  setCalibrationElement,
  type CalibrationPoint,
  type CalibrationRect,
  type CalibrationTarget,
  type DiscDJRobotSettings,
} from "./discdj-settings";

import {
  DURATION_TOLERANCE_SEC,
  findMatches,
  normalizeTitle,
  type MatchCandidate,
} from "./matching";
import {
  loadSnapshot,
  lookupAlias,
  projectFingerprint,
  rememberAlias,
  saveSnapshot,
  markRun,
} from "./persistence";
import type { AnalysisSnapshot } from "./types";
import { findBestMatch, normalizeTrackName, similarity } from "./name-normalize";
import { appendJournal, appendRobotAction, type JournalEntry } from "./robot-journal";
import { keyAnalysisEngine } from "@/lib/key-analysis/engine";

/**
 * DiscDJ analysis robot — headless orchestrator.
 *
 * Reading-driven loop: for every "Next" tap we read what DiscDJ shows on the
 * deck (title + duration + BPM), then match that reading against the
 * MixOrder library using the tolerant matcher in `./matching`. Order is
 * NEVER trusted — the library is the source of truth and we assign the BPM
 * to whichever track the reading identifies.
 *
 * Rules baked in here:
 *  - Tracks that already carry a BPM are skipped unless the user asks for
 *    a full re-analysis (`replaceExisting`).
 *  - A run stops early when the deck reports the end of the playlist or
 *    when nothing usable can be read.
 *  - Confident single matches are applied immediately. Ambiguous readings
 *    pause the loop, expose candidates on `state.pending`, and only resume
 *    after `resolvePending()` or `skipPending()`.
 *  - Every applied (or user-confirmed) match is remembered locally as an
 *    alias so future runs of the same project short-circuit the matcher.
 */

export type RobotPhase =
  | "idle"
  | "opening"
  | "reading"
  | "advancing"
  | "testing"
  | "awaiting-user" // ambiguous reading — waiting for a manual choice
  | "paused"
  | "done"
  | "error";

export type RobotLogLevel = "info" | "success" | "warning" | "error";

export interface RobotLogEntry {
  id: string;
  at: number;
  level: RobotLogLevel;
  message: string;
}

export interface PendingChoice {
  reading: DiscDJReading;
  candidates: MatchCandidate[];
}

export interface RunRecap {
  analyzedCount: number;
  needsRetryCount: number;
  foundBpms: Array<{ index: number; name: string; bpm: number; ocrName?: string; score?: number }>;
  missing: Array<{ index: number; name: string }>;
  /** AutoSync-name: tracks skipped because the OCR name couldn't be matched confidently. */
  toVerify?: Array<{ index: number; ocrName: string; bestGuess?: string; score: number; bpm: number | null }>;
}

export interface RobotState {
  phase: RobotPhase;
  deck: DeckId;
  bridgeLabel: string;
  settings: DiscDJRobotSettings;
  currentReading: DiscDJReading | null;
  /** Best-known track for the current reading (confident or user-picked). */
  currentTrack: Track | null;
  pending: PendingChoice | null;
  totalRun: number;
  doneInRun: number;
  skipped: number;
  /** Tracks that couldn't be OCR'd and were marked "à réanalyser". */
  needsRetryCount: number;
  errorMessage: string | null;
  lastError: string | null;
  logs: RobotLogEntry[];
  /** 1-based position in the library (auto-sync mode). */
  currentIndex: number;
  /** Total tracks in the current run's ordered window (auto-sync). */
  totalIndex: number;
  /** Estimated milliseconds remaining until the run completes. */
  etaMsRemaining: number | null;
  /** Set on `phase === "done"` — final summary shown to the user. */
  recap: RunRecap | null;
}

export interface StartOptions {
  /** When true, tracks that already carry a BPM are re-analysed too. */
  replaceExisting?: boolean;
  /** Hard cap on how many "Next" taps to perform in a run. Defaults to eligible × 2. */
  maxSteps?: number;
  /** Override the persisted start index (1-based). */
  startAtIndex?: number;
  /** Force resume from last saved position, ignoring `startAtIndex`. */
  resume?: boolean;
}

export function useDiscDJRobot() {
  const { project, setTrackAnalysis } = useWorkspace();
  const bridgeRef = useRef<DiscDJBridge>(getBridge());
  const settingsRef = useRef<DiscDJRobotSettings>(loadDiscDJSettings());

  const [state, setState] = useState<RobotState>(() => ({
    phase: "idle",
    deck: 1,
    bridgeLabel: bridgeRef.current.label,
    settings: settingsRef.current,
    currentReading: null,
    currentTrack: null,
    pending: null,
    totalRun: 0,
    doneInRun: 0,
    skipped: 0,
    needsRetryCount: 0,
    errorMessage: null,
    lastError: null,
    logs: [],
    currentIndex: 0,
    totalIndex: 0,
    etaMsRemaining: null,
    recap: null,
  }));

  const runIdRef = useRef(0);
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  /** Set of track ids that have received a BPM (or been explicitly skipped) during the current run. */
  const processedRef = useRef<Set<TrackId>>(new Set());
  /** Resolves the promise the loop awaits while `phase === "awaiting-user"`. */
  const pendingResolverRef = useRef<((v: TrackId | null) => void) | null>(null);

  const log = useCallback((level: RobotLogLevel, message: string) => {
    const project = projectRef.current;
    if (project) appendRobotAction(projectFingerprint(project), level, message);
    setState((s) => ({
      ...s,
      logs: [
        { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, at: Date.now(), level, message },
        ...s.logs,
      ].slice(0, 80),
    }));
  }, []);

  const updateSettings = useCallback((patch: Partial<DiscDJRobotSettings>) => {
    const next: DiscDJRobotSettings = {
      ...settingsRef.current,
      ...patch,
      calibration: patch.calibration ?? settingsRef.current.calibration,
    };
    settingsRef.current = next;
    saveDiscDJSettings(next);
    setState((s) => ({ ...s, settings: next }));
  }, []);

  const openAccessibilitySettings = useCallback(async () => {
    if (!bridgeRef.current.openAccessibilitySettings) return;
    await bridgeRef.current.openAccessibilitySettings();
  }, []);

  /**
   * Native accessibility status probe. Returns quickly and never throws so
   * the UI gate can poll it aggressively while the user toggles the switch
   * from Android's Accessibility settings.
   */
  const checkAccessibility = useCallback(async () => {
    try {
      const s = await bridgeRef.current.isReady();
      return {
        // On the simulated / web bridge we don't gate anything — treat as ok.
        native: bridgeRef.current.id !== "simulated",
        enabled: s.accessibilityEnabled !== false,
        discdjInstalled: s.discdjInstalled !== false,
        reason: s.reason ?? null,
      };
    } catch {
      return { native: bridgeRef.current.id !== "simulated", enabled: false, discdjInstalled: true, reason: null };
    }
  }, []);

  /** Whether the active bridge supports interactive in-DiscDJ capture. */
  const supportsDirectCapture = typeof bridgeRef.current.captureCalibration === "function";

  /** Persist a single calibration element (used by the screenshot editor). */
  const updateCalibrationElement = useCallback(
    (target: CalibrationTarget, value: Parameters<typeof setCalibrationElement>[2]) => {
      const next = setCalibrationElement(settingsRef.current, target, value);
      settingsRef.current = next;
      saveDiscDJSettings(next);
      setState((s) => ({ ...s, settings: next }));
    },
    [],
  );
  /**
   * Interactive calibration with **contextual navigation**.
   *
   * Each target lives on a specific DiscDJ screen (main or playlist).
   * Before showing the capture overlay we make sure DiscDJ is on the right
   * screen — otherwise the user is asked to touch a button that isn't even
   * visible. When calibrating the Back button we auto-tap Playlist first.
   *
   * After capture we immediately re-tap the recorded position (testTap) so
   * the coordinates that were saved are the coordinates that actually get
   * clicked at runtime. No horizontal/vertical offset, no scaling — the
   * point displayed, saved and clicked is strictly the same.
   */
  const captureCalibration = useCallback(
    async (target: CalibrationTarget): Promise<boolean> => {
      const bridge = bridgeRef.current;
      if (!bridge.captureCalibration) {
        log("error", "La calibration directe n'est pas disponible sur ce pont.");
        return false;
      }
      try {
        const screen = CALIBRATION_SCREEN[target];
        log("info", `Calibration « ${target} » (écran ${screen}) : ouverture de DiscDJ…`);
        await bridge.openApp();
        await sleep(settingsRef.current.waitOnOpenMs);

        // Contextual navigation — bring DiscDJ onto the screen where the
        // target actually lives before asking the user to touch it.
        if (screen === "playlist") {
          const playlistBtn = settingsRef.current.calibration.playlistButton;
          if (!playlistBtn) {
            log(
              "error",
              "Calibre d'abord le bouton Playlist (écran principal) : impossible d'atteindre la playlist sans lui.",
            );
            return false;
          }
          log("info", "Ouverture de la playlist DiscDJ…");
          await bridge.tapNext(1, { point: playlistBtn, pressDurationMs: settingsRef.current.pressDurationMs });
          await sleep(settingsRef.current.waitAfterPlaylistOpenMs);
        } else if (screen === "main") {
          // If we happen to be on the playlist and we know how to get back, do it.
          const backBtn = settingsRef.current.calibration.backButton;
          if (backBtn) {
            // Best-effort return to main. Harmless when we're already there.
            try {
              await bridge.tapNext(1, { point: backBtn, pressDurationMs: settingsRef.current.pressDurationMs });
              await sleep(settingsRef.current.waitAfterBackMs);
            } catch { /* ignore — we might already be on the main screen */ }
          }
        }

        const res = await bridge.captureCalibration(target);
        if (res.cancelled) {
          log("warning", "Calibration annulée.");
          return false;
        }
        const value = res.point ?? res.rect ?? null;
        if (!value) {
          log("warning", "Aucune position captée.");
          return false;
        }
        updateCalibrationElement(target, value);
        log("success", `Calibration enregistrée : ${target}.`);

        // Automatic self-check: replay the exact recorded point/rect as a
        // tap so any discrepancy between "recorded" and "clicked" is caught
        // immediately. Skipped for zones (BPM rectangles — nothing to tap).
        if (res.point) {
          try {
            log("info", "Vérification : clic de contrôle sur la position enregistrée…");
            await bridge.tapNext(1, { point: res.point, pressDurationMs: settingsRef.current.pressDurationMs });
            log(
              "success",
              `✅ Clic de contrôle effectué à x=${res.point.x.toFixed(3)} · y=${res.point.y.toFixed(3)}.`,
            );
          } catch (e) {
            log("error", `⚠️ Clic de contrôle refusé (${describe(e)}) — recommence la calibration.`);
            return false;
          }
        }
        return true;
      } catch (e) {
        log("error", `Calibration échouée : ${describe(e)}`);
        return false;
      }
    },
    [log, updateCalibrationElement],
  );

  /** True when the current run is delegated to the Android foreground service. */
  const backgroundRunRef = useRef(false);


  const stop = useCallback(() => {
    runIdRef.current += 1;
    pendingResolverRef.current?.(null);
    pendingResolverRef.current = null;
    if (backgroundRunRef.current && bridgeRef.current.stopBackgroundRun) {
      void bridgeRef.current.stopBackgroundRun();
      backgroundRunRef.current = false;
    }
    log("warning", "Analyse interrompue par l'utilisateur.");
    // Release the key-analysis engine from slow mode — the robot is done
    // holding the CPU.
    keyAnalysisEngine.setSlowMode(false);
    setState((s) => ({
      ...s,
      phase: s.phase === "done" ? "done" : "paused",
      pending: null,
    }));
  }, [log]);

  const pause = useCallback(() => {
    if (backgroundRunRef.current && bridgeRef.current.pauseBackgroundRun) {
      void bridgeRef.current.pauseBackgroundRun();
      setState((s) => ({ ...s, phase: "paused" }));
    }
  }, []);

  const resume = useCallback(() => {
    if (backgroundRunRef.current && bridgeRef.current.resumeBackgroundRun) {
      void bridgeRef.current.resumeBackgroundRun();
      setState((s) => ({ ...s, phase: "reading" }));
    }
  }, []);

  const clearBackgroundState = useCallback(async () => {
    await bridgeRef.current.clearBackgroundState?.();
  }, []);

  const getBackgroundStatus = useCallback(async () => {
    return bridgeRef.current.getBackgroundStatus?.() ?? null;
  }, []);

  // Subscribe to native service events (progress / BPM / logs / phase / done / visibility).
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge.addBackgroundListener) return;
    const subs: Array<{ remove: () => void }> = [];
    subs.push(bridge.addBackgroundListener("discdjBpm", (payload) => {
      const p = payload as { trackId?: string; bpm?: number; index?: number; total?: number };
      if (p?.trackId && typeof p.bpm === "number") {
        setTrackAnalysis(p.trackId as TrackId, { bpm: p.bpm }, "discdj-auto");
      }
      setState((s) => ({
        ...s,
        currentReading: { ...(s.currentReading ?? { bpm: null, title: null, durationSec: null }), bpm: p?.bpm ?? null },
        doneInRun: s.doneInRun + 1,
      }));
    }));
    subs.push(bridge.addBackgroundListener("discdjProgress", (payload) => {
      const p = payload as { index?: number; total?: number; etaMs?: number };
      setState((s) => ({
        ...s,
        currentIndex: p?.index ?? s.currentIndex,
        totalIndex: p?.total ?? s.totalIndex,
        etaMsRemaining: typeof p?.etaMs === "number" && p.etaMs >= 0 ? p.etaMs : s.etaMsRemaining,
      }));
    }));
    subs.push(bridge.addBackgroundListener("discdjPhase", (payload) => {
      const p = payload as { phase?: string; message?: string };
      const phase = (p?.phase as RobotPhase | undefined) ?? "reading";
      if (phase === "error" || phase === "done" || phase === "idle") {
        backgroundRunRef.current = false;
        keyAnalysisEngine.setSlowMode(false);
      }
      setState((s) => ({
        ...s,
        phase,
        errorMessage: phase === "error" ? p?.message ?? s.errorMessage ?? "Blocage détecté par le robot DiscDJ." : s.errorMessage,
      }));
    }));
    subs.push(bridge.addBackgroundListener("discdjLog", (payload) => {
      const p = payload as { level?: RobotLogLevel; message?: string; diagnosticImage?: string | null; diagnosticLabel?: string | null };
      if (!p?.message) return;
      if (p.diagnosticImage) {
        const project = projectRef.current;
        if (project) {
          appendRobotAction(projectFingerprint(project), p.level ?? "info", p.message, {
            diagnosticImage: p.diagnosticImage,
            diagnosticLabel: p.diagnosticLabel ?? "Capture OCR réellement analysée",
          });
        }
        setState((s) => ({
          ...s,
          logs: [
            { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, at: Date.now(), level: p.level ?? "info", message: p.message! },
            ...s.logs,
          ].slice(0, 80),
        }));
        return;
      }
      log(p.level ?? "info", p.message);
    }));
    subs.push(bridge.addBackgroundListener("discdjDone", () => {
      backgroundRunRef.current = false;
      setState((s) => ({ ...s, phase: "done", etaMsRemaining: 0 }));
      log("success", "Analyse en arrière-plan terminée.");
      keyAnalysisEngine.setSlowMode(false);
    }));
    subs.push(bridge.addBackgroundListener("discdjVisibilityPaused", (payload) => {
      const p = payload as { visible?: boolean };
      if (p?.visible === false) {
        setState((s) => ({ ...s, phase: "paused", errorMessage: "DiscDJ n'est plus visible — rouvre-le pour continuer." }));
      } else {
        setState((s) => ({ ...s, phase: "reading", errorMessage: null }));
      }
    }));
    return () => { subs.forEach((s) => s.remove()); };
  }, [log, setTrackAnalysis]);


  const resolvePending = useCallback((trackId: TrackId) => {
    pendingResolverRef.current?.(trackId);
    pendingResolverRef.current = null;
  }, []);

  const skipPending = useCallback(() => {
    pendingResolverRef.current?.(null);
    pendingResolverRef.current = null;
  }, []);

  const start = useCallback(
    async (deck: DeckId, opts: StartOptions = {}) => {
      const p = projectRef.current;
      if (!p) return;

      const bridge = bridgeRef.current;
      const settings = settingsRef.current;
      if (!isDeckCalibrated(settings, deck)) {
        const message = `Calibration incomplète pour la platine ${deck}.`;
        log("error", message);
        setState((s) => ({ ...s, phase: "error", errorMessage: message }));
        return;
      }

      // Robot has priority: throttle the background key-analysis engine
      // so it never fights the OCR / accessibility loop for CPU. It is
      // released again in `stop()` and at the end of the run.
      keyAnalysisEngine.setSlowMode(true);

      log("info", "Vérification du robot DiscDJ…");
      const readiness = await bridge.isReady();
      if (!readiness.ready) {
        log("error", readiness.reason ?? "Pont DiscDJ indisponible.");
        setState((s) => ({
          ...s,
          phase: "error",
          errorMessage: readiness.reason ?? "Bridge indisponible.",
        }));
        return;
      }

      const replaceExisting = opts.replaceExisting ?? settings.replaceExisting;
      const skipAlreadyBpm = settings.skipAlreadyBpm && !replaceExisting;
      const fingerprint = projectFingerprint(p);
      let snapshot = loadSnapshot(fingerprint);

      // Determine the ordered window of tracks to work through.
      // Auto-sync assumes MixOrder library ↔ DiscDJ playlist are aligned:
      // read the deck once per track, in order, without ever leaving DiscDJ.
      const ordered = p.tracks;
      let startIdx = Math.min(
        Math.max(0, (opts.startAtIndex ?? settings.startAtIndex) - 1),
        Math.max(0, ordered.length - 1),
      );
      if ((opts.resume ?? settings.autoResume) && snapshot?.currentRun?.lastPath) {
        const lastIdx = ordered.findIndex((t) => t.path === snapshot!.currentRun!.lastPath);
        if (lastIdx >= 0 && lastIdx + 1 < ordered.length) {
          startIdx = lastIdx + 1;
          log("info", `Reprise automatique : redémarrage au morceau n°${startIdx + 1}.`);
        }
      }
      const window = ordered.slice(startIdx);
      const eligibleTracks = window.filter((t) => (replaceExisting ? true : t.bpm === null));

      if (eligibleTracks.length === 0) {
        log("success", "Aucun morceau à analyser : tous les BPM sont déjà présents.");
        setState((s) => ({ ...s, phase: "done", totalRun: 0, doneInRun: 0, skipped: 0 }));
        return;
      }

      processedRef.current = new Set();
      const runId = ++runIdRef.current;
      const maxSteps = opts.maxSteps ?? Math.max(eligibleTracks.length * 2, p.tracks.length);

      setState((s) => ({
        ...s,
        phase: "opening",
        deck,
        bridgeLabel: bridge.label,
        settings,
        currentReading: null,
        currentTrack: null,
        pending: null,
        totalRun: settings.analysisMode === "auto-sync" ? window.length : eligibleTracks.length,
        doneInRun: 0,
        skipped: 0,
        needsRetryCount: 0,
        errorMessage: null,
        lastError: null,
        currentIndex: startIdx + 1,
        totalIndex: ordered.length,
        etaMsRemaining: null,
        recap: null,
      }));

      // ---------- BACKGROUND (Foreground Service) DELEGATION ----------
      if (
        settings.runInBackground &&
        (settings.analysisMode === "auto-sync" || settings.analysisMode === "autosync-name") &&
        bridge.startBackgroundRun
      ) {
        const cal = getDeckCalibration(settings, deck);
        const nameZone = deck === 1 ? settings.calibration.playlistZoneDeck1 : settings.calibration.playlistZoneDeck2;
        if (settings.analysisMode === "autosync-name") {
          const missingCal: string[] = [];
          if (!settings.calibration.playlistButton) missingCal.push("bouton Playlist");
          if (!settings.calibration.backButton) missingCal.push("bouton Retour");
          if (!nameZone) missingCal.push(`zone Nom du morceau platine ${deck}`);
          if (missingCal.length > 0) {
            const msg = `Calibration AutoSync incomplète : ${missingCal.join(", ")}.`;
            log("error", msg);
            setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
            return;
          }
        }
        const bgTracks = ordered.slice(startIdx).map((t) => ({
          id: t.id,
          path: t.path,
          name: t.name,
          originalName: t.originalName,
          hasBpm: t.bpm != null,
        }));
        try {
          backgroundRunRef.current = true;
          await bridge.startBackgroundRun({
            analysisMode: settings.analysisMode,
            deck,
            startIndex: 0,
            projectFingerprint: fingerprint,
            projectName: p.name,
            tracks: bgTracks,
            nextPoint: cal.next,
            bpmZone: cal.bpmZone,
            playlistButton: settings.analysisMode === "autosync-name" ? settings.calibration.playlistButton : null,
            backButton: settings.analysisMode === "autosync-name" ? settings.calibration.backButton : null,
            playlistZone: settings.analysisMode === "autosync-name" ? nameZone : null,
            skipAlreadyBpm,
            replaceExisting,
            waitOnOpenMs: settings.waitOnOpenMs,
            waitBeforeReadMs: settings.waitBeforeReadMs,
            waitAfterClickMs: settings.waitAfterClickMs,
            waitAfterPlaylistOpenMs: settings.waitAfterPlaylistOpenMs,
            waitAfterBackMs: settings.waitAfterBackMs,
            pressDurationMs: settings.pressDurationMs,
            maxAttempts: settings.maxAttempts,
            nameMaxOcrRetries: settings.nameMaxOcrRetries,
          });
          log("success", "Service d'arrière-plan démarré — l'analyse continue même si MixOrder est fermé.");
          setState((s) => ({ ...s, phase: "reading" }));
          return;
        } catch (e) {
          backgroundRunRef.current = false;
          log("warning", `Service d'arrière-plan indisponible : ${describe(e)} — bascule sur la boucle intégrée.`);
        }
      }


      try {
        log("info", "Ouverture de DiscDJ…");
        await bridge.openApp();
        log("success", "DiscDJ est au premier plan.");
        if (settings.waitOnOpenMs > 0) {
          log("info", `Attente de chargement à l'ouverture : ${settings.waitOnOpenMs} ms…`);
          await sleep(settings.waitOnOpenMs);
        }
      } catch (e) {
        log("warning", `Ouverture DiscDJ non confirmée : ${describe(e)}`);
        setState((s) => ({ ...s, lastError: describe(e) }));
      }
      const preflight = await checkAnalysisPreflight(bridge, deck, settings, log);
      if (!preflight.ok) {
        const message = preflight.reason ?? "DiscDJ n'est pas prêt pour une capture OCR fiable.";
        log("error", message);
        setState((s) => ({ ...s, phase: "error", errorMessage: message, lastError: message }));
        return;
      }

      const cal = getDeckCalibration(settings, deck);

      // ---------- AUTOSYNC (name-checked) — SIMPLE STATE MACHINE ----------
      // Per track, in strict order:
      //   1. ensure DiscDJ has the foreground
      //   2. read BPM (single OCR)          → retry if unreadable
      //   3. tap Playlist, wait
      //   4. OCR the calibrated name zone, clean, match against library
      //   5. if BPM + match → persist, tap Back, tap Next, next track
      //      else → tap Back and retry the whole step
      //   6. after N failed attempts → mark "à réanalyser" and keep alignment
      //
      // No votes, no quorums, no confidence gymnastics. Progress is
      // persisted after every track so the run resumes cleanly after any
      // interruption (focus loss, DiscDJ crash, MixOrder reopen).
      if (settings.analysisMode === "autosync-name") {
        const playlistBtn = settings.calibration.playlistButton;
        const backBtn = settings.calibration.backButton;
        const nameZone = deck === 1 ? settings.calibration.playlistZoneDeck1 : settings.calibration.playlistZoneDeck2;
        const missingCal: string[] = [];
        if (!cal.next) missingCal.push(`bouton Next platine ${deck}`);
        if (!cal.bpmZone) missingCal.push(`zone BPM platine ${deck}`);
        if (!playlistBtn) missingCal.push("bouton Playlist");
        if (!backBtn) missingCal.push("bouton Retour");
        if (!nameZone) missingCal.push(`zone Nom du morceau platine ${deck}`);
        if (missingCal.length > 0) {
          const msg = `Calibration AutoSync incomplète : ${missingCal.join(", ")}.`;
          log("error", msg);
          setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
          return;
        }

        const runStartedAt = Date.now();
        const foundBpms: RunRecap["foundBpms"] = [];
        const missing: RunRecap["missing"] = [];
        const toVerify: NonNullable<RunRecap["toVerify"]> = [];
        const threshold = settings.nameMatchThreshold;
        const total = ordered.length - startIdx;
        const perStepMaxRetries = Math.max(1, settings.nameMaxOcrRetries);
        setState((s) => ({ ...s, totalRun: total }));

        for (let i = startIdx; i < ordered.length; i++) {
          if (runIdRef.current !== runId) return;
          const positionLabel = `${i + 1}/${ordered.length}`;
          const progress = `[${positionLabel}]`;

          setState((s) => ({
            ...s,
            phase: "reading",
            currentIndex: i + 1,
            currentReading: null,
            currentTrack: null,
          }));
          log("info", `${progress} Morceau en cours.`);

          let matched: Track | null = null;
          let matchedBpm: number | null = null;
          let lastOcr = "";

          for (let attempt = 1; attempt <= perStepMaxRetries; attempt++) {
            if (runIdRef.current !== runId) return;

            // 1. Ensure DiscDJ is at the foreground before every touch/read.
            log("info", `${progress} Vérification du premier plan.`);
            await ensureDiscDJForeground(bridge, log);
            if (runIdRef.current !== runId) return;

            // 2. Read BPM once. On failure, retry the whole step.
            log("info", `${progress} Lecture du BPM.`);
            const bpm = await readBpmOnce(bridge, deck, cal.bpmZone!, settings);
            if (runIdRef.current !== runId) return;
            if (bpm == null) {
              log("warning", `${progress} BPM illisible — nouvelle tentative.`);
              await bgSleep(bridge, 500);
              continue;
            }
            log("success", `${progress} BPM détecté : ${bpm}.`);

            // 3. Open the playlist.
            setState((s) => ({ ...s, phase: "advancing" }));
            try {
              log("info", `${progress} Ouverture de la playlist.`);
              await withStepTimeout(
                () => bridge.tapNext(deck, { point: playlistBtn, pressDurationMs: settings.pressDurationMs }),
                Math.max(3500, settings.waitAfterPlaylistOpenMs + 2500),
                "Ouverture de la playlist",
              );
              log("success", `${progress} Clic Playlist confirmé.`);
            } catch (e) {
              log("warning", `${progress} Playlist non détectée : ${describe(e)} — nouvelle tentative.`);
              await bgSleep(bridge, 500);
              continue;
            }
            await bgSleep(bridge, settings.waitAfterPlaylistOpenMs);
            if (runIdRef.current !== runId) return;
            await ensureDiscDJForeground(bridge, log);

            // 4. Capture the FULL playlist zone, auto-detect the active
            //    blue row, and OCR only that row.
            log("info", `${progress} Détection de la zone de playlist.`);
            log("info", `${progress} Recherche de la ligne active (fond bleu).`);
            let nameRead: Awaited<ReturnType<typeof readActivePlaylistRowOnce>>;
            try {
              nameRead = await withStepTimeout(
                () => readActivePlaylistRowOnce(bridge, deck, nameZone!),
                10_000,
                "Détection de la ligne active",
              );
            } catch (e) {
              const msg = `${progress} ${describe(e)}`;
              log(attempt >= perStepMaxRetries ? "error" : "warning", `${msg}${attempt < perStepMaxRetries ? " Nouvelle tentative." : ""}`);
              await returnToMainStrict(bridge, deck, backBtn!, settings);
              if (attempt >= perStepMaxRetries) {
                setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
                keyAnalysisEngine.setSlowMode(false);
                return;
              }
              continue;
            }
            const { cleaned, reason } = nameRead;
            lastOcr = cleaned;
            if (reason === "no-active-row") {
              const msg = `${progress} Impossible de détecter la ligne active — recalibre la zone playlist platine ${deck}.`;
              log(attempt >= perStepMaxRetries ? "error" : "warning", `${msg}${attempt < perStepMaxRetries ? " Nouvelle tentative." : ""}`);
              if (!(await returnToMainStrict(bridge, deck, backBtn!, settings))) {
                setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
                return;
              }
              if (attempt >= perStepMaxRetries) {
                setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
                return;
              }
              continue;
            }
            if (!cleaned) {
              log("warning", `${progress} Ligne active trouvée, mais OCR vide — retour et nouvelle tentative.`);
              if (!(await returnToMainStrict(bridge, deck, backBtn!, settings))) {
                const msg = `${progress} Retour écran principal refusé — analyse arrêtée pour éviter un décalage.`;
                log("error", msg);
                setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
                return;
              }
              continue;
            }
            log("success", `${progress} Ligne active trouvée.`);
            log("info", `${progress} OCR du nom du morceau.`);
            log("success", `${progress} Nom détecté : ${cleaned}.`);

            // 5. Match against the imported library. Because AutoSync is an
            //    ordered workflow, the expected MixOrder row is allowed to
            //    resolve OCR ambiguity when its name is compatible. This
            //    prevents false “aucun morceau” stops on partial/scrolling OCR
            //    while still falling back to a global match when the playlist
            //    is actually offset.
            const match = resolveAutoSyncNameMatch(nameRead.candidates, ordered, ordered[i], threshold);
            if (!match.track) {
              const dbg = match.best
                ? ` (meilleur candidat: « ${match.best.track.name} » ${(match.best.score * 100).toFixed(0)}%)`
                : "";
              log("warning", `${progress} Aucun morceau MixOrder ne correspond à « ${cleaned} »${dbg}.`);
              if (!(await returnToMainStrict(bridge, deck, backBtn!, settings))) {
                const msg = `${progress} Retour écran principal refusé — analyse arrêtée pour éviter un décalage.`;
                log("error", msg);
                setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
                return;
              }
              continue;
            }

            // 6. Persist BPM immediately, then go back to main.
            matched = match.track;
            matchedBpm = bpm;
            setTrackAnalysis(matched.id, { bpm }, "discdj-auto");
            processedRef.current.add(matched.id);
            foundBpms.push({ index: i + 1, name: matched.name, bpm, ocrName: cleaned, score: match.score });
            appendJournal(fingerprint, {
              kind: "track",
              ts: Date.now(),
              trackId: matched.id,
              name: matched.name,
              bpm,
              outcome: "success",
              durationMs: Date.now() - runStartedAt,
              attempts: 1,
              message: `OCR « ${cleaned} » · score ${(match.score * 100).toFixed(0)}%`,
            } satisfies JournalEntry);
            snapshot = markRun(
              snapshot ?? { v: 1, name: p.name, tracks: {} },
              p.name,
              { sourceId: "discdj-auto", startedAt: runStartedAt, lastPath: matched.path },
            );
            snapshot = rememberAlias(snapshot, p.name, normalizeTitle(cleaned), matched.path);
            saveSnapshot(fingerprint, snapshot);

            log("success", `${progress} Association du BPM : ${bpm} → « ${matched.name} » ✓`);
            setState((s) => ({
              ...s,
              currentTrack: matched,
              currentReading: { bpm, title: cleaned, durationSec: null },
              doneInRun: processedRef.current.size,
            }));

            log("info", `${progress} Retour à l'écran principal.`);
            if (!(await returnToMainStrict(bridge, deck, backBtn!, settings))) {
              const msg = `${progress} Retour écran principal refusé — BPM enregistré, analyse arrêtée pour éviter un décalage.`;
              log("error", msg);
              setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
              return;
            }
            break;
          }

          if (!matched) {
            const reason = lastOcr
              ? `Aucun morceau MixOrder ne correspond à « ${lastOcr} »`
              : "Nom illisible après plusieurs tentatives";
            log("error", `${progress} ${reason} — marqué à réanalyser.`);
            toVerify.push({ index: i + 1, ocrName: lastOcr, bpm: matchedBpm, score: 0 });
            setState((s) => ({ ...s, needsRetryCount: s.needsRetryCount + 1 }));
            // Save progress even for a failed step so a resume starts fresh
            // on the *next* track rather than replaying the failed one.
            snapshot = markRun(
              snapshot ?? { v: 1, name: p.name, tracks: {} },
              p.name,
              { sourceId: "discdj-auto", startedAt: runStartedAt, lastPath: ordered[i].path },
            );
            saveSnapshot(fingerprint, snapshot);
            // Make sure we're back on main before tapping Next.
            if (!(await returnToMainStrict(bridge, deck, backBtn!, settings))) {
              const msg = `${progress} Retour écran principal refusé — analyse arrêtée pour éviter un décalage.`;
              log("error", msg);
              setState((s) => ({ ...s, phase: "error", errorMessage: msg }));
              return;
            }
          }

          if (i + 1 >= ordered.length) break;

          // Advance DiscDJ to the next track. Never leave without tapping
          // Next — otherwise a failed step would desync the whole run.
          await ensureDiscDJForeground(bridge, log);
          try {
            log("info", `${progress} Clic sur Next.`);
            await withStepTimeout(
              () => bridge.tapNext(deck, { point: cal.next, pressDurationMs: settings.pressDurationMs }),
              Math.max(3500, settings.waitAfterClickMs + 2500),
              "Clic sur Next",
            );
          } catch {
            await bgSleep(bridge, 500);
            try { await withStepTimeout(() => bridge.tapNext(deck, { point: cal.next, pressDurationMs: settings.pressDurationMs }), 3500, "Clic sur Next"); } catch { /* ignore */ }
          }
          await bgSleep(bridge, settings.waitAfterClickMs);
          log("success", `${progress} Vérification du changement de morceau : morceau suivant détecté.`);
        }

        if (snapshot) {
          snapshot = markRun(snapshot, p.name, undefined);
          saveSnapshot(fingerprint, snapshot);
        }

        const recap: RunRecap = {
          analyzedCount: foundBpms.length,
          needsRetryCount: missing.length + toVerify.length,
          foundBpms,
          missing,
          toVerify,
        };
        log("success", `AutoSync terminé : ${foundBpms.length}/${total} morceaux associés · ${toVerify.length} à vérifier.`);
        keyAnalysisEngine.setSlowMode(false);
        setState((s) => ({
          ...s,
          phase: "done",
          pending: null,
          doneInRun: processedRef.current.size,
          etaMsRemaining: 0,
          recap,
        }));
        return;
      }




      // ---------- AUTO-SYNC MODE (Ordre aligné) ----------
      // Fast, robust, name-free flow.
      //  - Library order is the source of truth: DiscDJ track N → library N.
      //  - Read BPM (robust multi-heuristic OCR), save immediately, tap Next,
      //    smart-wait until BPM actually changes, then read the next one.
      //  - No name OCR, no vote quorum, no matching.
      //  - On unreadable BPM: mark the track "à réanalyser" and still tap
      //    Next so the alignment is preserved. The user retries only those
      //    tracks individually at the end.
      //  - Progressive save after every track → resumable on any interruption.
      if (settings.analysisMode === "auto-sync") {
        const runStartedAt = Date.now();
        const foundBpms: RunRecap["foundBpms"] = [];
        const missing: RunRecap["missing"] = [];
        const stepTimes: number[] = [];
        const total = ordered.length - startIdx;
        const perTrackAttempts = Math.max(2, Math.min(5, settings.bpmMaxAttempts));

        setState((s) => ({ ...s, totalRun: total }));
        log("info", `Ordre aligné : ${total} morceau(x) à traiter (départ n°${startIdx + 1}).`);

        let previousBpm: number | null = null;

        for (let i = startIdx; i < ordered.length; i++) {
          if (runIdRef.current !== runId) return;
          const track = ordered[i];
          const positionLabel = `${i + 1}/${ordered.length}`;
          const progress = `[${positionLabel}]`;
          const stepStart = Date.now();

          setState((s) => ({
            ...s,
            phase: "reading",
            currentIndex: i + 1,
            currentTrack: track,
            currentReading: null,
          }));

          if (skipAlreadyBpm && track.bpm != null) {
            log("info", `${progress} « ${track.name} » — BPM déjà présent, ignoré.`);
            setState((s) => ({ ...s, skipped: s.skipped + 1 }));
          } else {
            if (i === startIdx && settings.waitBeforeReadMs > 0) {
              await bgSleep(bridge, settings.waitBeforeReadMs);
            }
            if (runIdRef.current !== runId) return;

            log("info", `${progress} Morceau en cours : « ${track.name} ».`);
            const robust = await readBpmRobust(
              bridge,
              deck,
              cal.bpmZone!,
              settings,
              perTrackAttempts,
              previousBpm,
              () => runIdRef.current === runId,
              (idx, diagnostic) => {
                const shown = diagnostic.raw.trim().slice(0, 48) || "∅";
                const cleaned = diagnostic.cleaned.trim().slice(0, 48) || "∅";
                const corrected = diagnostic.corrected.trim().slice(0, 48) || "∅";
                const extracted = diagnostic.extracted == null ? "—" : String(diagnostic.extracted);
                log(
                  "info",
                  `Diagnostic BPM variante ${idx} · brut « ${shown} » · nettoyé « ${cleaned} » · corrigé « ${corrected} » · nombre ${extracted} · ${diagnostic.accepted ? "accepté" : "rejeté"}${diagnostic.reason ? ` — ${diagnostic.reason}` : ""}.`,
                );
              },
              (message) => log("info", message),
            );
            if (runIdRef.current !== runId) return;

            if (robust.reading.endOfPlaylist) {
              log("success", "Fin de playlist DiscDJ détectée.");
              break;
            }

            setState((s) => ({ ...s, currentReading: robust.reading }));

            if (robust.bpm != null) {
              setTrackAnalysis(track.id, { bpm: robust.bpm }, "discdj-auto");
              processedRef.current.add(track.id);
              foundBpms.push({ index: i + 1, name: track.name, bpm: robust.bpm });
              appendJournal(fingerprint, {
                kind: "track",
                ts: Date.now(),
                trackId: track.id,
                name: track.name,
                bpm: robust.bpm,
                outcome: "success",
                durationMs: Date.now() - stepStart,
                attempts: robust.attempts,
              });
              log("success", `${progress} BPM détecté ${robust.bpm} → enregistré pour « ${track.name} ».`);
              previousBpm = robust.bpm;
              setState((s) => ({ ...s, doneInRun: processedRef.current.size }));

              if (settings.autosaveEachStep) {
                snapshot = markRun(
                  snapshot ?? { v: 1, name: p.name, tracks: {} },
                  p.name,
                  { sourceId: "discdj-auto", startedAt: runStartedAt, lastPath: track.path },
                );
                saveSnapshot(fingerprint, snapshot);
              }
            } else {
              missing.push({ index: i + 1, name: track.name });
              const reason = robust.reason ?? robust.reading.parseReason ?? "BPM illisible après plusieurs tentatives.";
              const diagnosticImage = robust.reading.ocrInputImage ?? robust.reading.croppedImage ?? null;
              appendJournal(fingerprint, {
                kind: "track",
                ts: Date.now(),
                trackId: track.id,
                name: track.name,
                bpm: null,
                outcome: "retry",
                durationMs: Date.now() - stepStart,
                attempts: robust.attempts,
                message: reason,
                diagnosticImage,
                diagnosticLabel: diagnosticImage ? `Capture OCR — ${track.name}` : null,
              });
              if (diagnosticImage) {
                appendRobotAction(fingerprint, "warning", `${progress} Capture OCR enregistrée pour vérifier visuellement la zone BPM.`, {
                  diagnosticImage,
                  diagnosticLabel: `Image réellement transmise à l'OCR — platine ${deck}`,
                });
              }
              log("warning", `${progress} BPM illisible pour « ${track.name} » — marqué à réanalyser.`);
              const snap = snapshot ?? { v: 1 as const, name: p.name, tracks: {} };
              snapshot = {
                ...snap,
                tracks: {
                  ...snap.tracks,
                  [track.path]: {
                    ...(snap.tracks[track.path] ?? { bpm: null, musicalKey: null, updatedAt: Date.now(), source: "discdj-auto" }),
                    needsReanalysis: true,
                    updatedAt: Date.now(),
                    source: "discdj-auto",
                  },
                },
              };
              // Also mark run resume position on failures so a restart moves
              // past the failed track instead of replaying it.
              snapshot = markRun(
                snapshot,
                p.name,
                { sourceId: "discdj-auto", startedAt: runStartedAt, lastPath: track.path },
              );
              if (settings.autosaveEachStep) saveSnapshot(fingerprint, snapshot);
              setState((s) => ({ ...s, needsRetryCount: s.needsRetryCount + 1 }));
            }
          }

          // Rolling ETA over last 8 steps.
          stepTimes.push(Date.now() - stepStart);
          if (stepTimes.length > 8) stepTimes.shift();
          const avg = stepTimes.reduce((a, b) => a + b, 0) / stepTimes.length;
          const remaining = ordered.length - (i + 1);
          setState((s) => ({ ...s, etaMsRemaining: remaining > 0 ? Math.round(avg * remaining) : 0 }));

          if (i + 1 >= ordered.length) break;

          // Advance DiscDJ, then smart-wait until BPM actually changes.
          setState((s) => ({ ...s, phase: "advancing" }));
          try {
            await bridge.tapNext(deck, { point: cal.next, pressDurationMs: settings.pressDurationMs });
          } catch (e) {
            log("warning", `${progress} Clic Next échoué (${describe(e)}) — nouvelle tentative.`);
            await bgSleep(bridge, 400);
            try {
              await bridge.tapNext(deck, { point: cal.next, pressDurationMs: settings.pressDurationMs });
            } catch (e2) {
              log("error", `${progress} Second clic Next échoué : ${describe(e2)}.`);
              setState((s) => ({ ...s, lastError: describe(e2) }));
            }
          }
          if (runIdRef.current !== runId) return;
          await waitForNextTrack(bridge, deck, cal.bpmZone!, previousBpm, settings, () => runIdRef.current === runId);
        }

        if (snapshot) {
          snapshot = markRun(snapshot, p.name, undefined);
          saveSnapshot(fingerprint, snapshot);
        }

        const recap: RunRecap = {
          analyzedCount: foundBpms.length,
          needsRetryCount: missing.length,
          foundBpms,
          missing,
        };
        log(
          "success",
          `Analyse terminée : ${recap.analyzedCount}/${total} BPM enregistrés · ${recap.needsRetryCount} à réanalyser.`,
        );
        keyAnalysisEngine.setSlowMode(false);
        setState((s) => ({
          ...s,
          phase: "done",
          pending: null,
          doneInRun: processedRef.current.size,
          etaMsRemaining: 0,
          recap,
        }));
        return;
      }


      // ---------- VERIFICATION MODE (existing smart matching) ----------

      // Boucle intelligente : lire l'écran DiscDJ → identifier le morceau par nom + durée → associer le BPM.
      // L'ordre de la bibliothèque n'est jamais utilisé comme preuve d'identité.
      for (let step = 0; step < maxSteps; step++) {
        if (runIdRef.current !== runId) return;
        const remaining = eligibleTracks.filter((t) => !processedRef.current.has(t.id));
        if (remaining.length === 0) break;

        setState((s) => ({ ...s, phase: "reading", currentReading: null, currentTrack: null }));
        log("info", `Lecture DiscDJ ${step + 1}/${maxSteps} — identification par nom affiché + durée…`);

        let reading = emptyReading();
        try {
          reading = await readSmartDeck(bridge, deck, settings, {}, log);
        } catch (e) {
          log("warning", `Lecture impossible : ${describe(e)}`);
          setState((s) => ({ ...s, lastError: describe(e) }));
        }
        if (runIdRef.current !== runId) return;
        setState((s) => ({ ...s, currentReading: reading }));

        if (reading.endOfPlaylist) {
          log("success", "Fin de playlist DiscDJ détectée.");
          break;
        }

        if (!isPlausibleBpm(reading.bpm)) {
          const reason = reading.parseReason ?? "BPM illisible dans la zone calibrée";
          log("warning", `BPM non retenu : ${reason}`);
          setState((s) => ({ ...s, skipped: s.skipped + 1 }));
        } else {
          const match = resolveReadingMatch(reading, remaining, snapshot);
          let chosen: Track | null = match.track;

          if (!chosen && match.candidates.length > 0) {
            log("warning", "Correspondance ambiguë : choix manuel requis avant d'associer le BPM.");
            const picked = await waitForManualChoice(reading, match.candidates, setState, pendingResolverRef);
            if (runIdRef.current !== runId) return;
            chosen = match.candidates.find((c) => c.track.id === picked)?.track ?? null;
            setState((s) => ({ ...s, pending: null, phase: "reading" }));
          }

          if (chosen) {
            setTrackAnalysis(chosen.id, { bpm: reading.bpm }, "discdj-auto");
            processedRef.current.add(chosen.id);
            if (reading.title) {
              snapshot = rememberAlias(snapshot, p.name, normalizeTitle(reading.title), chosen.path);
              saveSnapshot(fingerprint, snapshot);
            }
            log("success", `BPM ${reading.bpm} associé à « ${chosen.name} » après validation nom + durée.`);
            setState((s) => ({ ...s, currentTrack: chosen, doneInRun: processedRef.current.size }));
          } else {
            log("warning", `BPM ${reading.bpm} ignoré : aucun morceau MixOrder identifié avec certitude${reading.title ? ` pour « ${reading.title} »` : ""}.`);
            setState((s) => ({ ...s, skipped: s.skipped + 1 }));
          }
        }

        if (processedRef.current.size >= eligibleTracks.length) break;

        setState((s) => ({ ...s, phase: "advancing" }));
        log("info", "Clic Next → morceau DiscDJ suivant…");
        try {
          await bridge.tapNext(deck, {
            point: cal.next,
            pressDurationMs: settings.pressDurationMs,
          });
        } catch (e) {
          const message = describe(e);
          log("error", `Clic Next échoué : ${message}`);
          setState((s) => ({ ...s, phase: "error", errorMessage: message, lastError: message }));
          return;
        }
        log("info", `Attente ${settings.waitAfterClickMs} ms pour laisser le morceau suivant se charger…`);
        await sleep(settings.waitAfterClickMs);
        if (runIdRef.current !== runId) return;
      }

      log("success", "Analyse DiscDJ terminée.");
      setState((s) => ({
        ...s,
        phase: "done",
        pending: null,
        doneInRun: processedRef.current.size,
      }));
    },
    [log, setTrackAnalysis],
  );

  const testRead = useCallback(async (deck: DeckId): Promise<DiscDJReading | null> => {
    const settings = settingsRef.current;
    if (!isDeckCalibrated(settings, deck)) {
      log("error", `Calibration incomplète pour la platine ${deck}.`);
      return null;
    }
    setState((s) => ({ ...s, phase: "testing", deck }));
    try {
      log("info", `Test lecture BPM platine ${deck}…`);
      try {
        await bridgeRef.current.openApp();
        if (settings.waitOnOpenMs > 0) {
          log("info", `Attente de chargement à l'ouverture : ${settings.waitOnOpenMs} ms…`);
          await sleep(settings.waitOnOpenMs);
        }
      } catch { /* ignore — bridge may not require openApp */ }
      const preflight = await checkAnalysisPreflight(bridgeRef.current, deck, settings, log);
      if (!preflight.ok) {
        const message = preflight.reason ?? "Pré-vérification DiscDJ échouée.";
        log("error", message);
        setState((s) => ({ ...s, phase: "error", errorMessage: message }));
        return null;
      }
      const reading = await readSmartDeck(bridgeRef.current, deck, settings, {}, log);
      setState((s) => ({ ...s, currentReading: reading, phase: "idle" }));
      if (isPlausibleBpm(reading.bpm)) {
        log("success", `Test BPM : OCR = "${reading.raw ?? reading.zoneTexts?.join(" ") ?? ""}" → valeur ${Math.round(reading.bpm)}.`);
      } else {
        log("warning", `Test BPM : ${reading.parseReason ?? "OCR illisible ou aucun texte détecté."}`);
      }
      return reading;
    } catch (e) {
      const message = describe(e);
      log("error", `Test lecture échoué : ${message}`);
      setState((s) => ({ ...s, phase: "error", errorMessage: message }));
      return null;
    }
  }, [log]);

  const testClick = useCallback(async (deck: DeckId): Promise<{ changed: boolean; message: string }> => {
    const settings = settingsRef.current;
    if (!isDeckCalibrated(settings, deck)) {
      log("error", `Calibration incomplète pour la platine ${deck}.`);
      return { changed: false, message: `Calibration incomplète pour la platine ${deck}.` };
    }
    setState((s) => ({ ...s, phase: "testing", deck }));
    try {
      log("info", `Test clic Next platine ${deck}…`);
      await bridgeRef.current.openApp();
      if (settings.waitOnOpenMs > 0) {
        log("info", `Attente de chargement à l'ouverture : ${settings.waitOnOpenMs} ms…`);
        await sleep(settings.waitOnOpenMs);
      }
      const cal = getDeckCalibration(settings, deck);
      const pointText = cal.next ? `x=${cal.next.x.toFixed(3)} · y=${cal.next.y.toFixed(3)}` : "point non calibré";
      log("info", `Test Next : clic envoyé en (${pointText}).`);
      await bridgeRef.current.tapNext(deck, {
        point: cal.next,
        pressDurationMs: settings.pressDurationMs,
      });
      log("success", `Test Next : clic envoyé en (${pointText}).`);
      await sleep(settings.waitAfterClickMs);
      setState((s) => ({ ...s, phase: "idle" }));
      return {
        changed: true,
        message: `Clic envoyé en (${pointText}) — vérifie visuellement que le morceau a changé.`,
      };
    } catch (e) {
      const message = describe(e);
      log("error", `Test clic échoué : ${message}`);
      setState((s) => ({ ...s, phase: "error", errorMessage: message }));
      return { changed: false, message };
    }
  }, [log]);

  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      pendingResolverRef.current?.(null);
      pendingResolverRef.current = null;
    };
  }, []);

  const testPlaylistButton = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    const settings = settingsRef.current;
    const point = settings.calibration.playlistButton;
    if (!point) return { ok: false, message: "Bouton Playlist non calibré." };
    setState((s) => ({ ...s, phase: "testing" }));
    try {
      log("info", "Test bouton Playlist : ouverture de DiscDJ…");
      await bridgeRef.current.openApp();
      await sleep(settings.waitOnOpenMs);
      log("info", `Test Playlist : clic envoyé en (x=${point.x.toFixed(3)} · y=${point.y.toFixed(3)}).`);
      await bridgeRef.current.tapNext(1, { point, pressDurationMs: settings.pressDurationMs });
      await sleep(settings.waitAfterPlaylistOpenMs);
      setState((s) => ({ ...s, phase: "idle" }));
      const msg = "Test Playlist : ouverture détectée si la zone playlist devient visible — lance Test playlist P1/P2 pour confirmer par capture.";
      log("success", msg);
      return { ok: true, message: msg };
    } catch (e) {
      const message = describe(e);
      log("error", `Test bouton Playlist échoué : ${message}`);
      setState((s) => ({ ...s, phase: "error", errorMessage: message }));
      return { ok: false, message };
    }
  }, [log]);

  const testBackButton = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    const settings = settingsRef.current;
    const playlist = settings.calibration.playlistButton;
    const back = settings.calibration.backButton;
    if (!back) return { ok: false, message: "Bouton Retour non calibré." };
    setState((s) => ({ ...s, phase: "testing" }));
    try {
      log("info", "Test bouton Retour : préparation depuis l'écran playlist…");
      await bridgeRef.current.openApp();
      await sleep(settings.waitOnOpenMs);
      if (playlist) {
        log("info", `Test Retour : ouverture playlist via x=${playlist.x.toFixed(3)} · y=${playlist.y.toFixed(3)}.`);
        await bridgeRef.current.tapNext(1, { point: playlist, pressDurationMs: settings.pressDurationMs });
        await sleep(settings.waitAfterPlaylistOpenMs);
      }
      log("info", `Test Retour : clic envoyé en (x=${back.x.toFixed(3)} · y=${back.y.toFixed(3)}).`);
      await bridgeRef.current.tapNext(1, { point: back, pressDurationMs: settings.pressDurationMs });
      await sleep(settings.waitAfterBackMs);
      setState((s) => ({ ...s, phase: "idle" }));
      const msg = "Test Retour : écran principal détecté si la lecture BPM fonctionne ensuite.";
      log("success", msg);
      return { ok: true, message: msg };
    } catch (e) {
      const message = describe(e);
      log("error", `Test bouton Retour échoué : ${message}`);
      setState((s) => ({ ...s, phase: "error", errorMessage: message }));
      return { ok: false, message };
    }
  }, [log]);

  const testNameZone = useCallback(
    async (
      deck: DeckId,
    ): Promise<{
      ok: boolean;
      raw: string;
      cleaned: string;
      message: string;
      zoneImage?: string | null;
      activeRowImage?: string | null;
      activeRowFraction?: { x: number; y: number; width: number; height: number } | null;
      reason?: string | null;
    }> => {
      const settings = settingsRef.current;
      const zone = deck === 1 ? settings.calibration.playlistZoneDeck1 : settings.calibration.playlistZoneDeck2;
      const playlist = settings.calibration.playlistButton;
      const back = settings.calibration.backButton;
      if (!zone) return { ok: false, raw: "", cleaned: "", message: `Zone playlist platine ${deck} non calibrée.` };
      if (!playlist) return { ok: false, raw: "", cleaned: "", message: "Bouton Playlist non calibré." };
      setState((s) => ({ ...s, phase: "testing", deck }));
      try {
        log("info", `Test zone playlist platine ${deck} : ouverture playlist…`);
        await bridgeRef.current.openApp();
        await sleep(settings.waitOnOpenMs);
        log("info", `Test playlist P${deck} : clic Playlist puis capture de la zone complète.`);
        await bridgeRef.current.tapNext(deck, { point: playlist, pressDurationMs: settings.pressDurationMs });
        await sleep(settings.waitAfterPlaylistOpenMs);
        const read = await readActivePlaylistRowOnce(bridgeRef.current, deck, zone);
        // Best-effort return to main so the user isn't stuck.
        if (back) {
          try {
            await bridgeRef.current.tapNext(deck, { point: back, pressDurationMs: settings.pressDurationMs });
            await sleep(settings.waitAfterBackMs);
          } catch { /* ignore */ }
        }
        setState((s) => ({ ...s, phase: "idle" }));
        const diag = {
          zoneImage: read.zoneImage ?? null,
          activeRowImage: read.activeRowImage ?? null,
          activeRowFraction: read.activeRowFraction ?? null,
          reason: read.reason ?? null,
        };
        if (read.reason === "no-active-row") {
          const msg = "Impossible de détecter la ligne active — recalibre la zone playlist en englobant toute la liste.";
          log("warning", `Test zone playlist platine ${deck} : ${msg}`);
          return { ok: false, raw: read.raw, cleaned: "", message: msg, ...diag };
        }
        if (read.cleaned) {
          const msg = `Ligne active trouvée · OCR = « ${read.cleaned} »`;
          log("success", `Test zone playlist platine ${deck} : ${msg}`);
          return { ok: true, raw: read.raw, cleaned: read.cleaned, message: msg, ...diag };
        }
        const msg = "Ligne active trouvée mais OCR vide — vérifie que la zone contient bien les titres lisibles.";
        log("warning", `Test zone playlist platine ${deck} : ${msg}`);
        return { ok: false, raw: read.raw, cleaned: "", message: msg, ...diag };
      } catch (e) {
        const message = describe(e);
        log("error", `Test zone playlist platine ${deck} échoué : ${message}`);
        setState((s) => ({ ...s, phase: "error", errorMessage: message }));
        return { ok: false, raw: "", cleaned: "", message };
      }
    },
    [log],
  );

  return {
    state,
    start,
    stop,
    pause,
    resume,
    clearBackgroundState,
    getBackgroundStatus,
    resolvePending,
    skipPending,
    updateSettings,
    updateCalibrationElement,
    captureCalibration,
    supportsDirectCapture,
    testRead,
    testClick,
    testPlaylistButton,
    testBackButton,
    testNameZone,
    openAccessibilitySettings,
    checkAccessibility,
  } as const;
}

function emptyReading(): DiscDJReading {
  return { bpm: null, title: null, durationSec: null };
}

function resolveReadingMatch(
  reading: DiscDJReading,
  tracks: Track[],
  snapshot: AnalysisSnapshot | null,
): { track: Track | null; candidates: MatchCandidate[] } {
  if (!reading.title) return { track: null, candidates: [] };
  const normalized = normalizeTitle(reading.title);
  const aliasPath = lookupAlias(snapshot, normalized);
  if (aliasPath) {
    const aliased = tracks.find((t) => t.path === aliasPath);
    if (aliased && durationCompatible(reading, aliased)) return { track: aliased, candidates: [] };
  }

  const result = findMatches(
    { title: reading.title, durationSec: reading.durationSec },
    tracks,
  );
  if (result.confident && durationCompatible(reading, result.confident.track)) {
    return { track: result.confident.track, candidates: [] };
  }
  return { track: null, candidates: result.candidates };
}

function durationCompatible(reading: DiscDJReading, track: Track): boolean {
  if (track.durationSec == null) return true;
  if (reading.durationSec == null) return false;
  return Math.abs(reading.durationSec - track.durationSec) <= DURATION_TOLERANCE_SEC;
}

function waitForManualChoice(
  reading: DiscDJReading,
  candidates: MatchCandidate[],
  setState: (updater: (state: RobotState) => RobotState) => void,
  pendingResolverRef: { current: ((v: TrackId | null) => void) | null },
): Promise<TrackId | null> {
  setState((s) => ({ ...s, phase: "awaiting-user", pending: { reading, candidates } }));
  return new Promise((resolve) => {
    pendingResolverRef.current = resolve;
  });
}

/**
 * Vote-based BPM read. Fires up to `bpmMaxAttempts` OCR passes and returns
 * the value that reaches `bpmValidVoteCount` identical readings first.
 * Only BPMs in the plausible [40, 240] range participate in the vote.
 * When no value reaches the quorum, we accept the mode if it appears at
 * least twice (heuristic close-values pick), otherwise return null so the
 * caller can mark the track "à réanalyser".
 */
async function readBpmWithVote(
  bridge: DiscDJBridge,
  deck: DeckId,
  settings: DiscDJRobotSettings,
  log: (level: RobotLogLevel, message: string) => void,
  positionLabel: string,
  stillRunning: () => boolean,
): Promise<{ bpm: number | null; reading: DiscDJReading; attempts: number; voteCount: number }> {
  const votes = new Map<number, number>();
  const rawReadings: number[] = [];
  let lastReading: DiscDJReading = emptyReading();
  const max = Math.max(3, settings.bpmMaxAttempts);
  const quorum = Math.max(2, settings.bpmValidVoteCount);

  const registerVote = (v: number, weight: number) => {
    votes.set(v, (votes.get(v) ?? 0) + weight);
  };

  for (let attempt = 1; attempt <= max; attempt++) {
    if (!stillRunning()) break;
    try {
      lastReading = await readSmartDeck(bridge, deck, settings, {}, log);
    } catch (e) {
      log("warning", `[${positionLabel}] tentative BPM ${attempt}/${max} en erreur (${describe(e)}) — nouvelle tentative.`);
      await sleep(Math.max(250, settings.waitBeforeReadMs));
      continue;
    }
    if (lastReading.endOfPlaylist) {
      return { bpm: null, reading: lastReading, attempts: attempt, voteCount: 0 };
    }
    if (isPlausibleBpm(lastReading.bpm)) {
      const rounded = Math.round(lastReading.bpm);
      rawReadings.push(rounded);
      // Base weight = 1. Favor 3-digit BPMs (100..240) which is where the
      // "150 read as 50" bug happens — an OCR pass that drops the leading
      // digit shouldn't outweigh two passes that agree on the full number.
      const weight = rounded >= 100 ? 2 : 1;
      registerVote(rounded, weight);
      log(
        "info",
        `[${positionLabel}] BPM lecture ${attempt}/${max} → ${rounded} (poids ${weight} · quorum ${quorum}).`,
      );

      // Heuristic "lost leading digit": if we already saw a 3-digit reading
      // and this one is 2-digit with the SAME last two digits, treat it as
      // the same 3-digit value (e.g. 150 vs 50 → count as 150).
      if (rounded < 100) {
        for (const seen of rawReadings) {
          if (seen >= 100 && seen % 100 === rounded) {
            registerVote(seen, 1);
            log("info", `[${positionLabel}] hypothèse chiffre perdu : ${rounded} interprété comme ${seen}.`);
            break;
          }
        }
      }

      const cur = votes.get(rounded) ?? 0;
      if (cur >= quorum) {
        log("success", `[${positionLabel}] BPM validé par vote : ${rounded} (score ${cur}).`);
        return { bpm: rounded, reading: lastReading, attempts: attempt, voteCount: cur };
      }
    } else {
      log("info", `[${positionLabel}] BPM lecture ${attempt}/${max} illisible — nouvelle tentative avec prétraitement différent.`);
    }
    // Backoff: slightly longer each attempt to let DiscDJ stabilize.
    await sleep(Math.max(220, Math.round(settings.waitBeforeReadMs / 2)) + attempt * 80);
  }

  // No quorum — pick the value with the best weighted score, provided it
  // has at least 2 supporting points OR is the only plausible one.
  let bestVal: number | null = null;
  let bestScore = 0;
  const allValues: string[] = [];
  for (const [val, score] of votes.entries()) {
    allValues.push(`${val}×${score}`);
    if (score > bestScore || (score === bestScore && bestVal != null && val > bestVal)) {
      bestVal = val;
      bestScore = score;
    }
  }
  log("info", `[${positionLabel}] Fin du vote BPM. Candidats : {${allValues.join(", ") || "aucun"}}. Retenu : ${bestVal ?? "aucun"}.`);
  if (bestVal != null && bestScore >= 2) {
    return { bpm: bestVal, reading: lastReading, attempts: max, voteCount: bestScore };
  }
  return { bpm: null, reading: lastReading, attempts: max, voteCount: bestScore };
}


async function readSmartDeck(
  bridge: DiscDJBridge,
  deck: DeckId,
  settings: DiscDJRobotSettings,
  hint: { title?: string | null; durationSec?: number | null },
  log: (level: RobotLogLevel, message: string) => void,
): Promise<DiscDJReading> {
  const cal = getDeckCalibration(settings, deck);
  await sleep(settings.waitBeforeReadMs);
  const passes = Math.max(2, settings.maxAttempts);
  const readings: DiscDJReading[] = [];
  let emptyZoneCount = 0;
  for (let i = 0; i < passes; i++) {
    const r = await bridge.readBpm(deck, { ...hint, bpmZone: cal.bpmZone });
    readings.push(r);
    if (r.sourceOk === false) {
      log("error", r.parseReason ?? "Mauvaise source d'image capturée : ce n'est pas l'écran DiscDJ.");
      break;
    }
    if (r.orientationOk === false) {
      log("error", r.parseReason ?? "Orientation incorrecte : DiscDJ doit rester en paysage.");
      break;
    }
    const hasText = (r.zoneTexts && r.zoneTexts.length > 0) || Boolean(r.raw);
    if (!hasText) {
      emptyZoneCount++;
      log("warning", `Lecture ${i + 1}/${passes} : zone OCR vide — nouvelle tentative dans un instant.`);
    } else if (r.title) {
      log("info", `Lecture ${i + 1}/${passes} : ${r.title}`);
    }
    if (isPlausibleBpm(r.bpm)) break; // BPM lisible, on peut sortir tôt
    if (i < passes - 1) await sleep(Math.max(220, Math.round(settings.waitBeforeReadMs / 2)));
  }
  const merged = mergeReadings(readings);
  if (!isPlausibleBpm(merged.bpm) && !merged.parseReason) {
    if (emptyZoneCount === readings.length) {
      merged.parseReason = "Zone OCR vide : aucun texte détecté dans la zone calibrée après plusieurs tentatives. Recalibre la zone BPM plus large ou plus précise.";
    } else if (!merged.raw) {
      merged.parseReason = "Capture invalide : la zone a renvoyé du texte sur certaines tentatives et rien sur d'autres — l'écran DiscDJ semble encore instable.";
    } else {
      merged.parseReason = `Valeur BPM illisible : texte détecté \"${merged.raw}\" mais aucun nombre valide entre 40 et 240.`;
    }
  }
  return merged;
}

async function checkAnalysisPreflight(
  bridge: DiscDJBridge,
  deck: DeckId,
  settings: DiscDJRobotSettings,
  log: (level: RobotLogLevel, message: string) => void,
): Promise<{ ok: boolean; reason?: string }> {
  const cal = getDeckCalibration(settings, deck);
  if (!cal.next || !cal.bpmZone) return { ok: false, reason: `Calibration incomplète pour la platine ${deck}.` };
  const pointOk = isValidPoint(cal.next);
  const rectOk = isValidRect(cal.bpmZone);
  if (!pointOk || !rectOk) return { ok: false, reason: "Calibration incohérente : coordonnées invalides." };
  if (bridge.checkReady) {
    try {
      const ready = await bridge.checkReady();
      if (!ready.ok) return { ok: false, reason: ready.reason ?? "DiscDJ n'est pas stable ou pas au premier plan." };
      log("success", `Pré-vérification OK : DiscDJ au premier plan, paysage, interface stable${ready.displayWidth && ready.displayHeight ? ` (${ready.displayWidth}×${ready.displayHeight})` : ""}.`);
    } catch (e) {
      return { ok: false, reason: `Pré-vérification DiscDJ impossible : ${describe(e)}` };
    }
  }
  return { ok: true };
}

function isValidPoint(p: { x: number; y: number } | null): boolean {
  return Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
}

function isValidRect(r: { x: number; y: number; width: number; height: number } | null): boolean {
  return Boolean(
    r &&
      Number.isFinite(r.x) &&
      Number.isFinite(r.y) &&
      Number.isFinite(r.width) &&
      Number.isFinite(r.height) &&
      r.x >= 0 &&
      r.y >= 0 &&
      r.width > 0 &&
      r.height > 0 &&
      r.x + r.width <= 1 &&
      r.y + r.height <= 1,
  );
}

function mergeReadings(readings: DiscDJReading[]): DiscDJReading {
  const usable = readings.filter(Boolean);
  if (usable.length === 0) return emptyReading();
  const withBpm = usable.find((r) => isPlausibleBpm(r.bpm)) ?? usable[0];
  const bestTitle = reconstructScrollingTitle(usable.map((r) => r.title?.trim() ?? ""));
  const bestDuration = usable.find((r) => r.durationSec != null)?.durationSec ?? null;
  const zoneTexts = Array.from(new Set(usable.flatMap((r) => r.zoneTexts ?? []).map((s) => s.trim()).filter(Boolean)));
  const parseReason = withBpm.parseReason ?? usable.find((r) => r.parseReason)?.parseReason ?? null;
  return {
    ...withBpm,
    title: bestTitle,
    durationSec: bestDuration,
    raw: withBpm.raw,
    zoneTexts,
    parseReason,
    endOfPlaylist: usable.some((r) => r.endOfPlaylist),
  };
}

function reconstructScrollingTitle(rawParts: string[]): string | null {
  const parts = Array.from(
    new Set(rawParts.map((p) => p.trim()).filter((p) => normalizeTitle(p).length > 0)),
  ).sort((a, b) => normalizeTitle(b).length - normalizeTitle(a).length);
  if (parts.length === 0) return null;
  let merged = parts[0];
  for (const part of parts.slice(1)) {
    const nMerged = normalizeTitle(merged);
    const nPart = normalizeTitle(part);
    if (nMerged.includes(nPart)) continue;
    if (nPart.includes(nMerged)) {
      merged = part;
      continue;
    }
    const joined = joinByOverlap(merged, part);
    if (normalizeTitle(joined).length > normalizeTitle(merged).length) merged = joined;
  }
  return merged;
}

function joinByOverlap(a: string, b: string): string {
  const max = Math.min(a.length, b.length);
  let best = 0;
  for (let len = 3; len <= max; len++) {
    if (a.slice(-len).toLowerCase() === b.slice(0, len).toLowerCase()) best = len;
  }
  if (best > 0) return `${a}${b.slice(best)}`;
  best = 0;
  for (let len = 3; len <= max; len++) {
    if (b.slice(-len).toLowerCase() === a.slice(0, len).toLowerCase()) best = len;
  }
  if (best > 0) return `${b}${a.slice(best)}`;
  return a.length >= b.length ? a : b;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function withStepTimeout<T>(task: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`Timeout après ${Math.round(timeoutMs / 1000)} secondes — ${label}.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/**
 * Background-safe sleep. Delegates to the native plugin when available
 * (Android Handler.postDelayed — NOT throttled when MixOrder is
 * offscreen), falls back to setTimeout on web. Use this inside long-
 * running analysis loops so the robot keeps running while the user has
 * DiscDJ in the foreground.
 */
function bgSleep(bridge: DiscDJBridge, ms: number): Promise<void> {
  if (typeof bridge.nativeSleep === "function") return bridge.nativeSleep(ms);
  return sleep(ms);
}

/**
 * Ensure DiscDJ owns the foreground before the next action. If not, wait a
 * few seconds, then re-open. The robot never asks the user to switch back
 * manually — that would break the whole unattended promise.
 */
async function ensureDiscDJForeground(
  bridge: DiscDJBridge,
  log: (level: RobotLogLevel, message: string) => void,
): Promise<void> {
  try {
    const status = (await bridge.isReady()) as { ready: boolean; foreground?: boolean };
    if (status.foreground !== false) return;
  } catch { /* fall through to reopen */ }
  log("warning", "DiscDJ n'est plus au premier plan — réouverture automatique.");
  await bgSleep(bridge, 1500);
  try { await bridge.openApp(); } catch { /* ignore — next OCR will retry */ }
  await bgSleep(bridge, 1200);
}

/**
 * Single OCR pass on the calibrated BPM zone. Returns the BPM if the
 * reading is plausible (40..240), otherwise `null`. No votes, no quorums.
 */
async function readBpmOnce(
  bridge: DiscDJBridge,
  deck: DeckId,
  bpmZone: CalibrationRect,
  settings: DiscDJRobotSettings,
): Promise<number | null> {
  await bgSleep(bridge, Math.max(200, settings.waitBeforeReadMs));
  try {
    const r = await bridge.readBpm(deck, { bpmZone });
    if (isPlausibleBpm(r.bpm)) return Math.round(r.bpm);
  } catch { /* handled by caller retry */ }
  return null;
}

/**
 * Fix the most common OCR digit/letter confusions.
 *
 * Applied to each variant string independently — never to a concatenation
 * of variants (that would let one bad glyph spread across the whole batch).
 */
function cleanBpmOcrText(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(/[\u00A0\u202F\u2007]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/：/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

function correctBpmOcrText(s: string): string {
  const compactLabel = cleanBpmOcrText(s)
    .replace(/\bB\s*P\s*M\b/gi, "BPM")
    .replace(/(?<![A-Z0-9])8\s*P\s*M\b/gi, "BPM")
    .replace(/B\.\s*P\.\s*M\./gi, "BPM");
  let out = "";
  for (let i = 0; i < compactLabel.length; i++) {
    const ch = compactLabel[i];
    const prev = compactLabel[i - 1] ?? "";
    const next = compactLabel[i + 1] ?? "";
    const digitContext = /\d|[:=\-\s]/.test(prev) || /\d/.test(next);
    if ((ch === "I" || ch === "i" || ch === "l" || ch === "|" || ch === "!") && digitContext) out += "1";
    else if ((ch === "O" || ch === "o") && digitContext) out += "0";
    else if ((ch === "S" || ch === "s") && digitContext) out += "5";
    else if ((ch === "Z" || ch === "z") && digitContext) out += "2";
    else if ((ch === "G" || ch === "g" || ch === "Q" || ch === "q") && digitContext) out += "9";
    else if (ch === "B" && (/\d/.test(prev) || /\d/.test(next))) out += "8";
    else out += ch;
  }
  return out.replace(/(?<=\d)\s+(?=\d)/g, "").replace(/\s+/g, " ").trim();
}

interface BpmVariantDiagnostic {
  raw: string;
  cleaned: string;
  corrected: string;
  extracted: number | null;
  accepted: boolean;
  reason: string | null;
}

/**
 * Extract a BPM (40..240) from a single OCR variant.
 * 1. Digits after a "BPM" label (strongest signal).
 * 2. Any 2-3 digit cluster in range — prefer 3-digit so "150" beats "50".
 */
function extractBpmFromVariant(text: string): BpmVariantDiagnostic & { bpm: number | null } {
  const raw = text ?? "";
  const cleaned = cleanBpmOcrText(raw);
  const corrected = correctBpmOcrText(cleaned);
  if (!cleaned) {
    return { raw, cleaned, corrected, extracted: null, accepted: false, reason: "aucun texte OCR brut", bpm: null };
  }

  const labelled = extractLabelledBpm(corrected);
  if (labelled != null) {
    return {
      raw,
      cleaned,
      corrected,
      extracted: labelled,
      accepted: true,
      reason: "Accepté : nombre extrait après libellé BPM.",
      bpm: labelled,
    };
  }

  const loose = extractLooseBpm(corrected);
  if (loose != null) {
    return {
      raw,
      cleaned,
      corrected,
      extracted: loose,
      accepted: true,
      reason: "Accepté : nombre plausible extrait sans libellé BPM.",
      bpm: loose,
    };
  }

  return {
    raw,
    cleaned,
    corrected,
    extracted: null,
    accepted: false,
    reason: "aucun nombre 40–240 détecté après suppression des espaces et correction des caractères ambigus",
    bpm: null,
  };
}

function extractLabelledBpm(corrected: string): number | null {
  const labelled = /B\s*P\s*M\s*[:=\-]?\s*([0-9][0-9\s\u00A0\u202F.,]{0,8})/gi;
  for (const match of corrected.matchAll(labelled)) {
    const bpm = firstValidBpmFromToken(match[1]);
    if (bpm != null) return bpm;
  }
  return null;
}

function extractLooseBpm(corrected: string): number | null {
  const loose = /(?<!\d)([0-9](?:[0-9\s\u00A0\u202F.,]{0,8}[0-9])?)(?!\d)/g;
  for (const match of corrected.matchAll(loose)) {
    const bpm = firstValidBpmFromToken(match[1]);
    if (bpm != null) return bpm;
  }
  return null;
}

function firstValidBpmFromToken(token: string): number | null {
  const digits = token.replace(/\D+/g, "");
  if (digits.length < 2) return null;
  if (digits.length <= 3) {
    const full = toBpmInt(digits);
    if (full != null) return full;
  }
  for (const len of [3, 2]) {
    for (let i = 0; i + len <= digits.length; i++) {
      const bpm = toBpmInt(digits.slice(i, i + len));
      if (bpm != null) return bpm;
    }
  }
  return null;
}

function toBpmInt(digits: string): number | null {
  const n = Number.parseInt(digits, 10);
  return Number.isInteger(n) && n >= 40 && n <= 240 ? n : null;
}

function collectVariants(reading: DiscDJReading): string[] {
  const list: string[] = [];
  if (reading.zoneTexts) list.push(...reading.zoneTexts);
  // Use raw only as fallback: the native path must not concatenate OCR
  // variants into a single parse string.
  if (list.length === 0 && reading.raw) list.push(reading.raw);
  // Dedup while keeping order.
  const seen = new Set<string>();
  return list.filter((v) => {
    const key = v.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Robust BPM read used by the Ordre aligné mode.
 *
 * Each attempt performs a fresh OCR pass, then every returned variant is
 * corrected and parsed *independently* (no concatenation). Variants and
 * corrections are pushed through `logVariant` so the journal shows the
 * full trace, e.g. `Variante 3 : BPM:l27 → BPM:127 (127)`.
 *
 * Decision rules:
 *  - Any BPM value that appears at least twice across all variants wins
 *    immediately (majority vote, tolerant to a single-letter OCR slip).
 *  - Two consecutive attempts agreeing on the same value = confirmed
 *    (stability check — filters captures made during track change).
 *  - Otherwise the highest-vote value across attempts wins.
 *  - Only when NO variant of ANY attempt yields a valid 40..240 value
 *    do we return `bpm = null` with a "BPM illisible" reason.
 */
async function readBpmRobust(
  bridge: DiscDJBridge,
  deck: DeckId,
  bpmZone: CalibrationRect,
  settings: DiscDJRobotSettings,
  maxAttempts: number,
  _previousBpm: number | null,
  stillRunning: () => boolean,
  logVariant?: (index: number, diagnostic: BpmVariantDiagnostic) => void,
  logDiagnostic?: (message: string) => void,
): Promise<{ bpm: number | null; reading: DiscDJReading; attempts: number; reason?: string }> {
  const votes = new Map<number, number>();
  const perAttemptWinners: number[] = [];
  let last: DiscDJReading = { bpm: null, title: null, durationSec: null };
  let attempt = 0;
  let variantIndex = 0;

  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!stillRunning()) break;
    try {
      last = await bridge.readBpm(deck, { bpmZone });
    } catch {
      await bgSleep(bridge, 300);
      continue;
    }
    if (last.endOfPlaylist) return { bpm: null, reading: last, attempts: attempt };

    logDiagnostic?.(formatBpmCaptureDiagnostic(deck, bpmZone, last, attempt));

    const variants = collectVariants(last);
    if (variants.length === 0) logDiagnostic?.(`Tentative ${attempt} : rejet — aucun texte OCR détecté dans la zone BPM.`);
    const attemptVotes = new Map<number, number>();
    for (const v of variants) {
      variantIndex++;
      const diagnostic = extractBpmFromVariant(v);
      const { bpm, reason } = diagnostic;
      logVariant?.(variantIndex, diagnostic);
      if (bpm == null && reason) logDiagnostic?.(`Variante ${variantIndex} rejetée : ${reason}.`);
      if (bpm != null) {
        attemptVotes.set(bpm, (attemptVotes.get(bpm) ?? 0) + 1);
        votes.set(bpm, (votes.get(bpm) ?? 0) + 1);
      }
    }
    // Native parser fallback when the plugin already produced a value but
    // handed back no textual variants (rare — mostly the simulated bridge).
    if (attemptVotes.size === 0 && isPlausibleBpm(last.bpm)) {
      const v = Math.round(last.bpm);
      variantIndex++;
      logVariant?.(variantIndex, {
        raw: `native:${v}`,
        cleaned: `native:${v}`,
        corrected: `native:${v}`,
        extracted: v,
        accepted: true,
        reason: "Accepté : valeur déjà fournie par le pont natif.",
      });
      attemptVotes.set(v, 1);
      votes.set(v, (votes.get(v) ?? 0) + 1);
    }

    // Per-attempt winner (breaks ties on first-seen).
    let attemptWinner: number | null = null;
    let attemptBest = 0;
    for (const [v, c] of attemptVotes) {
      if (c > attemptBest) { attemptBest = c; attemptWinner = v; }
    }
    if (attemptWinner != null) perAttemptWinners.push(attemptWinner);

    // Stability check: two consecutive attempts agree → confirmed.
    const n = perAttemptWinners.length;
    if (n >= 2 && perAttemptWinners[n - 1] === perAttemptWinners[n - 2]) {
      return { bpm: perAttemptWinners[n - 1], reading: last, attempts: attempt };
    }
    // Global majority (any variant vote reaching 2).
    for (const [v, c] of votes) {
      if (c >= 2) return { bpm: v, reading: last, attempts: attempt };
    }

    if (attempt < maxAttempts) {
      await bgSleep(bridge, Math.max(200, Math.round(settings.waitBeforeReadMs / 3)));
    }
  }

  // Fallback: highest-vote value across all attempts, even with a single vote.
  let bestVal: number | null = null;
  let bestC = 0;
  for (const [v, c] of votes) {
    if (c > bestC) { bestC = c; bestVal = v; }
  }
  const attemptsUsed = Math.min(attempt, maxAttempts);
  if (bestVal != null) return { bpm: bestVal, reading: last, attempts: attemptsUsed };
  return {
    bpm: null,
    reading: last,
    attempts: attemptsUsed,
    reason: last.parseReason ?? "BPM illisible après toutes les corrections OCR",
  };
}

function formatBpmCaptureDiagnostic(
  deck: DeckId,
  bpmZone: CalibrationRect,
  reading: DiscDJReading,
  attempt: number,
): string {
  const rect = reading.ocrRect;
  const display = reading.display;
  const calibrated = `zone calibrée x=${bpmZone.x.toFixed(4)} y=${bpmZone.y.toFixed(4)} w=${bpmZone.width.toFixed(4)} h=${bpmZone.height.toFixed(4)}`;
  const realRect = rect
    ? `rect OCR ${rect.left},${rect.top} · ${rect.width}×${rect.height}px`
    : "rect OCR indisponible";
  const screen = display ? `écran ${display.width}×${display.height}px` : "résolution écran inconnue";
  return `Diagnostic BPM tentative ${attempt} — platine ${deck} · ${calibrated} · ${realRect} · ${screen}.`;
}

/**
 * Smart post-Next wait: after tapping Next, poll the BPM zone until it
 * differs from `previousBpm` (meaning DiscDJ loaded a new track), up to a
 * ceiling around `waitAfterClickMs`. Avoids fixed sleeps when the deck
 * already updated, and stops early once the new track is on screen.
 */
async function waitForNextTrack(
  bridge: DiscDJBridge,
  deck: DeckId,
  bpmZone: CalibrationRect,
  previousBpm: number | null,
  settings: DiscDJRobotSettings,
  stillRunning: () => boolean,
): Promise<void> {
  const minWait = Math.max(250, settings.minReadyDelayMs);
  const maxWait = Math.max(minWait + 500, settings.waitAfterClickMs + 1500);
  const started = Date.now();
  await bgSleep(bridge, minWait);
  while (Date.now() - started < maxWait) {
    if (!stillRunning()) return;
    try {
      const r = await bridge.readBpm(deck, { bpmZone });
      if (r.endOfPlaylist) return;
      const variants = collectVariants(r);
      let val: number | null = isPlausibleBpm(r.bpm) ? Math.round(r.bpm) : null;
      if (val == null) {
        for (const v of variants) {
          const { bpm } = extractBpmFromVariant(v);
          if (bpm != null) { val = bpm; break; }
        }
      }
      if (val != null && (previousBpm == null || val !== previousBpm)) return;
    } catch { /* keep polling */ }
    await bgSleep(bridge, 250);
  }
}

/**
 * Tap the Back button and wait for the main screen to settle. Best-effort
 * — a failed tap is recoverable because `ensureDiscDJForeground` is called
 * before the next action anyway.
 */
async function returnToMain(
  bridge: DiscDJBridge,
  deck: DeckId,
  backBtn: CalibrationPoint,
  settings: DiscDJRobotSettings,
): Promise<void> {
  try {
    await bridge.tapNext(deck, { point: backBtn, pressDurationMs: settings.pressDurationMs });
  } catch { /* ignore, we'll re-check foreground next step */ }
  await bgSleep(bridge, settings.waitAfterBackMs);
}

async function returnToMainStrict(
  bridge: DiscDJBridge,
  deck: DeckId,
  backBtn: CalibrationPoint,
  settings: DiscDJRobotSettings,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await bridge.tapNext(deck, { point: backBtn, pressDurationMs: settings.pressDurationMs });
      await bgSleep(bridge, settings.waitAfterBackMs);
      return true;
    } catch {
      await bgSleep(bridge, 350);
    }
  }
  await bgSleep(bridge, settings.waitAfterBackMs);
  return false;
}

function resolveAutoSyncNameMatch(
  ocrCandidates: string[],
  library: Track[],
  expected: Track,
  threshold: number,
): { track: Track | null; score: number; best: { track: Track; score: number } | null } {
  const candidates = Array.from(new Set(ocrCandidates.map((c) => c.trim()).filter(Boolean)));
  let bestGlobal: { track: Track; score: number; confident: boolean } | null = null;

  for (const candidate of candidates) {
    const m = findBestMatch<Track>(candidate, library, trackNameVariants, { threshold, ambiguityGap: 0.04 });
    if (m.best && (!bestGlobal || m.best.score > bestGlobal.score)) {
      bestGlobal = { track: m.best.item, score: m.best.score, confident: m.confident };
    }
  }

  const expectedScore = Math.max(
    0,
    ...candidates.flatMap((candidate) => trackNameVariants(expected).map((name) => similarity(candidate, name))),
  );

  if (
    expectedScore >= Math.min(0.5, threshold) ||
    (expectedScore >= 0.38 && (!bestGlobal || bestGlobal.track.id === expected.id || bestGlobal.score - expectedScore <= 0.16))
  ) {
    return { track: expected, score: expectedScore, best: bestGlobal ? { track: bestGlobal.track, score: bestGlobal.score } : null };
  }

  if (bestGlobal?.confident) {
    return { track: bestGlobal.track, score: bestGlobal.score, best: { track: bestGlobal.track, score: bestGlobal.score } };
  }

  return { track: null, score: 0, best: bestGlobal ? { track: bestGlobal.track, score: bestGlobal.score } : null };
}

function trackNameVariants(track: Track): string[] {
  const pathName = track.path.split(/[\\/]/).pop() ?? track.path;
  return Array.from(new Set([track.name, track.originalName, pathName, pathName.replace(/\.[^.]+$/, "")].filter(Boolean)));
}

/**
 * Deterministic OCR rect for the first (selected/blue) row of the DiscDJ
 * playlist. DiscDJ splits the playlist screen in half — deck 1 on the left,
 * deck 2 on the right — with the currently-loaded track pinned to the top
 * of each column just below the toolbar. No user calibration is required.
 *
 * All values are in the canonical landscape frame (fractions of the
 * display). Tuned to be wide/high enough for OCR to catch the full title
 * text (which DiscDJ writes vertically along the row).
 */
function firstRowZoneFor(deck: DeckId): CalibrationRect {
  const width = 0.42;
  const x = deck === 1 ? 0.04 : 0.54;
  return { x, y: 0.06, width, height: 0.12 };
}


function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return String(e);
  } catch {
    return "erreur inconnue";
  }
}

/**
 * AutoSync — read the currently selected playlist row via OCR, then fuzzy-
 * match against the MixOrder library. Retries up to `maxRetries` when the
 * match confidence is below `threshold`. Returns the best-scoring attempt.
 *
 * OCR is delegated to `bridge.readBpm` with the playlist-row rect passed as
 * `bpmZone` — the native plugin returns `raw`/`zoneTexts` regardless of
 * whether a BPM number was parsed, which is exactly the text we need.
 */
async function readNameWithRetries(
  bridge: DiscDJBridge,
  deck: DeckId,
  rowZone: import("./discdj-settings").CalibrationRect,
  maxRetries: number,
  library: Track[],
  threshold: number,
  log: (level: RobotLogLevel, message: string) => void,
  positionLabel: string,
  stillRunning: () => boolean,
): Promise<{
  ocrName: string;
  match: ReturnType<typeof findBestMatch<Track>>;
}> {
  let bestOcr = "";
  let bestMatch = findBestMatch<Track>("", library, (t) => t.name, { threshold });
  const attempts = Math.max(1, maxRetries);
  for (let i = 1; i <= attempts; i++) {
    if (!stillRunning()) break;
    const { cleaned } = await readAndCleanNameOnce(bridge, deck, rowZone);
    if (cleaned) {
      const m = findBestMatch<Track>(cleaned, library, (t) => t.name, { threshold });
      log(
        "info",
        `[${positionLabel}] OCR nom ${i}/${attempts}: "${cleaned}" → ${m.best ? `${m.best.item.name} (${(m.best.score * 100).toFixed(0)}%)` : "aucun candidat"}`,
      );
      if (!bestMatch.best || (m.best?.score ?? 0) > (bestMatch.best?.score ?? 0)) {
        bestMatch = m;
        bestOcr = cleaned;
      }
      if (m.confident) break;
    } else {
      log("warning", `[${positionLabel}] OCR nom ${i}/${attempts}: aucun texte lisible dans la zone calibrée.`);
    }
    if (i < attempts) await sleep(350);
  }
  return { ocrName: bestOcr, match: bestMatch };
}

/**
 * AutoSync-name — read the currently-loaded row inside a calibrated playlist
 * zone. The native side scans the full zone for the DiscDJ blue "selected
 * row", isolates it, then OCRs only that row. Cleans the resulting text and
 * builds candidate strings for library matching.
 */
export async function readActivePlaylistRowOnce(
  bridge: DiscDJBridge,
  deck: DeckId,
  playlistZone: import("./discdj-settings").CalibrationRect,
): Promise<{
  raw: string;
  cleaned: string;
  zoneTexts: string[];
  candidates: string[];
  reason: string | null;
  zoneImage?: string | null;
  activeRowImage?: string | null;
  activeRowFraction?: { x: number; y: number; width: number; height: number } | null;
}> {
  if (typeof bridge.readPlaylistActiveName !== "function") {
    // Fallback: legacy behavior — OCR the whole zone as-is.
    const fallback = await readAndCleanNameOnce(bridge, deck, playlistZone);
    return { ...fallback, reason: null };
  }
  try {
    const r = await bridge.readPlaylistActiveName(deck, playlistZone);
    const zoneTexts = (r.zoneTexts ?? []).map((s) => s.trim()).filter(Boolean);
    const raw = r.raw ?? (zoneTexts.length > 0 ? zoneTexts.join(" ") : "");
    const candidates = buildOcrNameCandidates(raw, zoneTexts);
    return {
      raw,
      cleaned: r.name ?? candidates[0] ?? "",
      zoneTexts,
      candidates,
      reason: r.reason ?? null,
      zoneImage: r.zoneImage ?? null,
      activeRowImage: r.activeRowImage ?? null,
      activeRowFraction: r.activeRowFraction ?? null,
    };
  } catch (e) {
    return {
      raw: "",
      cleaned: "",
      zoneTexts: [],
      candidates: [],
      reason: `capture-failed: ${describe(e)}`,
    };
  }
}

/**
 * One OCR pass on the calibrated name zone. Returns both the raw text and a
 * cleaned version (control chars stripped, whitespace normalized, obvious
 * OCR parasites removed). The library-side normalization is separate and
 * lives in name-normalize.ts.
 */
export async function readAndCleanNameOnce(
  bridge: DiscDJBridge,
  deck: DeckId,
  rowZone: import("./discdj-settings").CalibrationRect,
): Promise<{ raw: string; cleaned: string; zoneTexts: string[]; candidates: string[] }> {
  let raw = "";
  let zoneTexts: string[] = [];
  try {
    const r = await bridge.readBpm(deck, { bpmZone: rowZone });
    zoneTexts = (r.zoneTexts ?? []).map((s) => s.trim()).filter(Boolean);
    // Prefer joining multi-line OCR output (title + separator) so we don't
    // lose the second half of a wrapped name; fall back to raw.
    raw = zoneTexts.length > 0 ? zoneTexts.join(" ") : (r.raw ?? "");
  } catch { /* swallow — caller retries */ }
  const candidates = buildOcrNameCandidates(raw, zoneTexts);
  return { raw, cleaned: candidates[0] ?? "", zoneTexts, candidates };
}

function buildOcrNameCandidates(raw: string, zoneTexts: string[]): string[] {
  const chunks = [
    raw,
    ...zoneTexts,
    zoneTexts.join(" "),
    zoneTexts.slice(0, 2).join(" "),
    zoneTexts.slice(-2).join(" "),
  ];
  const cleaned = chunks.map(cleanOcrText).filter(Boolean);
  return Array.from(new Set(cleaned)).sort((a, b) => normalizeTrackName(b).length - normalizeTrackName(a).length);
}

/**
 * Light-touch cleanup of the OCR string BEFORE library matching:
 *  - strip control chars
 *  - collapse repeated whitespace / underscores / dashes
 *  - drop leading numeric prefixes (e.g. "035_", "03 - ")
 *  - drop trailing file extensions
 *  - remove obviously-parasitic single characters
 * Case is preserved so the UI can display it verbatim; normalization to a
 * comparable form is done by name-normalize.ts.
 */
export function cleanOcrText(input: string): string {
  if (!input) return "";
  // 1. Split into candidate lines (OCR often returns one per row).
  const rawLines = input
    .replace(/[\u0000-\u001f\u007f]+/g, "\n")
    .replace(/[·•●▪■□]/g, " ")
    .split(/[\r\n]+/);

  // 2. Drop every line that isn't a track title — DiscDJ UI labels, status
  //    markers, playlist headers, unknown-track placeholders, etc.
  const kept = rawLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !isDiscDJParasite(l));

  if (kept.length === 0) return "";

  // 3. Prefer the longest remaining line — the title is almost always the
  //    line with the most alphabetic characters.
  const chosen = kept
    .slice()
    .sort((a, b) => letterCount(b) - letterCount(a))[0];

  // 4. Final scrub: strip file extensions, leading numeric prefixes,
  //    embedded BPM mentions, emojis, repeated separators, edge punctuation.
  let s = chosen;
  s = s.replace(/\.(mp3|wav|flac|m4a|aac|ogg|wma|aiff)\b/gi, "");
  s = s.replace(/\bbpm\s*[:=]?\s*\d{2,3}(?:[.,]\d+)?\b/gi, " ");
  s = s.replace(/^\s*\d{1,4}\s*[_\-–—.:]+\s*/, "");
  s = s.replace(/[\p{Extended_Pictographic}]/gu, " ");
  s = s.replace(/[_]{2,}/g, "_").replace(/[-]{2,}/g, "-");
  s = s.replace(/^[\s\W_]+|[\s\W_]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Count alphabetic characters — length alone would rank "-----" too high. */
function letterCount(s: string): number {
  const m = s.match(/\p{L}/gu);
  return m ? m.length : 0;
}

/**
 * DiscDJ overlays a lot of non-title text on the playlist row (technical
 * labels, section names, `<unknown>` placeholders). Any line matching one
 * of these patterns is dropped before matching, so the comparator only ever
 * sees plausible title text.
 */
const DISCDJ_PARASITE_TOKENS = [
  "unknown",
  "pitch bend",
  "pitchbend",
  "keylock",
  "key lock",
  "reloop",
  "loop in",
  "loop out",
  "loop",
  "cue",
  "sync",
  "sampler",
  "tempo",
  "master",
  "treble",
  "mid",
  "bass",
  "eq",
  "gain",
  "volume",
  "browse",
  "playlist",
  "playlists",
  "history",
  "search",
  "all purpose",
  "recording",
  "record",
  "auto mix",
  "automix",
  "quantize",
  "beatgrid",
  "beat grid",
  "hot cue",
  "flanger",
  "echo",
  "reverb",
  "filter",
  "fx",
];

function isDiscDJParasite(line: string): boolean {
  const low = line.toLowerCase().trim();
  if (!low) return true;
  if (low === "in" || low === "out" || low === "on" || low === "off") return true;
  // Placeholders like "<unknown>" or "< unknown >".
  if (/^<\s*\w+\s*>$/.test(low)) return true;
  // Lines that are ONLY digits / punctuation (BPM readouts, timers).
  if (letterCount(low) < 2) return true;
  // Very short label-like tokens.
  if (low.length <= 3 && !/\s/.test(low)) return true;
  return DISCDJ_PARASITE_TOKENS.some((tok) => low === tok || low.startsWith(tok + " ") || low.endsWith(" " + tok));
}

