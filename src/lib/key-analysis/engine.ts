/**
 * TempoKey — public key-analysis engine.
 *
 * Singleton orchestrator: owns the queue, runs one track at a time in the
 * background, persists results through the workspace, pushes progress
 * updates via pub/sub, survives navigation (lives outside React) and
 * resumes automatically when the app reopens.
 *
 * Priority coordination with the DiscDJ robot is handled via
 * `setSlowMode(true)` — when the robot is busy analysing BPMs, the key
 * engine pauses between tracks to keep CPU free. The robot layer calls
 * this hook whenever its background service starts/stops.
 */

import { toCamelot } from "@/lib/library/camelot";
import { detectKeyHybrid } from "./hybrid";
import { decodeToMono } from "./chromagram";
import { getOverride } from "./corrections";
import type {
  EngineStats, KeyAnalysisData, QueueItem, QueueItemStatus,
} from "./types";
import { ENGINE_VERSION } from "./types";

type EnqueueTrack = {
  trackId: string;
  path: string;
  name: string;
  url: string;
  /** True when the caller wants to force a re-analysis even if a key exists. */
  force?: boolean;
};

type Persist = (
  trackId: string,
  key: string,
  data: KeyAnalysisData,
) => void;

type Listener = (stats: EngineStats) => void;

const LOG_MAX = 40;
const RECENT_TIMES = 8;
const SLOW_MODE_DELAY_MS = 800;
const NORMAL_DELAY_MS = 30;

class KeyAnalysisEngine {
  private queue: QueueItem[] = [];
  private index = new Map<string, QueueItem>();
  private urlByTrackId = new Map<string, string>();
  private listeners = new Set<Listener>();
  private persist: Persist | null = null;
  private running = false;
  private paused = false;
  private slowMode = false;
  private abort: AbortController | null = null;
  private recent: number[] = [];
  private log: EngineStats["log"] = [];
  private lastAnalyzed: EngineStats["lastAnalyzed"] = null;
  private currentTrackName: string | null = null;

  /** Called once from WorkspaceProvider so the engine can persist results. */
  setPersistHandler(fn: Persist | null) {
    this.persist = fn;
  }

  /**
   * Sync the queue with the current library. Existing entries are kept
   * (idempotent), missing tracks are dropped, new tracks are appended.
   * Tracks that already have a valid key are marked "done" and never
   * re-analysed unless `force` is set on `enqueue`.
   */
  syncLibrary(tracks: Array<{
    id: string;
    path: string;
    name: string;
    url: string;
    musicalKey: string | null;
  }>) {
    const seen = new Set<string>();
    for (const t of tracks) {
      seen.add(t.id);
      this.urlByTrackId.set(t.id, t.url);
      let item = this.index.get(t.id);
      if (!item) {
        item = {
          trackId: t.id,
          path: t.path,
          name: t.name,
          status: t.musicalKey ? "done" : "pending",
          attempts: 0,
        };
        this.index.set(t.id, item);
        this.queue.push(item);
      } else {
        item.name = t.name;
        item.path = t.path;
        if (t.musicalKey && item.status === "pending") item.status = "done";
      }
    }
    // Drop items whose track is gone from the library.
    for (const [id, item] of this.index) {
      if (!seen.has(id)) {
        this.index.delete(id);
        this.urlByTrackId.delete(id);
        const i = this.queue.indexOf(item);
        if (i >= 0) this.queue.splice(i, 1);
      }
    }
    this.notify();
  }

  /** Force-requeue selected tracks (or all of them) for re-analysis. */
  requeue(trackIds: string[] | "errors" | "all") {
    const target =
      trackIds === "errors"
        ? this.queue.filter((q) => q.status === "error").map((q) => q.trackId)
        : trackIds === "all"
          ? this.queue.map((q) => q.trackId)
          : trackIds;
    for (const id of target) {
      const item = this.index.get(id);
      if (!item) continue;
      item.status = "pending";
      item.attempts = 0;
      item.lastError = null;
    }
    this.pushLog("info", `${target.length} morceau(x) remis en file.`);
    this.notify();
  }

  start() {
    if (this.running) return;
    this.paused = false;
    this.running = true;
    this.pushLog("info", "Analyse démarrée.");
    void this.pump();
  }

  pause() {
    this.paused = true;
    this.abort?.abort();
    this.pushLog("info", "Analyse suspendue.");
    this.notify();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pushLog("info", "Analyse reprise.");
    if (!this.running) {
      this.running = true;
      void this.pump();
    } else this.notify();
  }

  /**
   * Priority hook — the DiscDJ Robot layer calls this whenever its
   * background service starts/stops.
   */
  setSlowMode(slow: boolean) {
    if (this.slowMode === slow) return;
    this.slowMode = slow;
    this.pushLog("info", slow
      ? "Mode ralenti (Robot DiscDJ prioritaire)."
      : "Vitesse normale rétablie.");
    this.notify();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.snapshot());
    return () => { this.listeners.delete(l); };
  }

  snapshot(): EngineStats {
    const total = this.queue.length;
    const done = this.queue.filter((q) => q.status === "done").length;
    const errors = this.queue.filter((q) => q.status === "error").length;
    const pending = total - done - errors;
    const avg =
      this.recent.length > 0
        ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length
        : 0;
    const etaMs = avg > 0 ? pending * avg : 0;
    return {
      total, done, pending, errors,
      currentTrackName: this.currentTrackName,
      running: this.running,
      paused: this.paused,
      slowMode: this.slowMode,
      avgMsPerTrack: avg,
      etaMs,
      lastAnalyzed: this.lastAnalyzed,
      log: this.log.slice(),
    };
  }

  getQueue(): QueueItem[] {
    return this.queue.slice();
  }

  // ---------- internals ----------

  private notify() {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private pushLog(level: EngineStats["log"][number]["level"], message: string) {
    this.log.unshift({ ts: Date.now(), level, message });
    if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
  }

  private nextPending(): QueueItem | null {
    for (const q of this.queue) if (q.status === "pending") return q;
    return null;
  }

  private updateStatus(item: QueueItem, status: QueueItemStatus) {
    item.status = status;
    this.notify();
  }

  private async pump() {
    while (this.running) {
      if (this.paused) { this.running = false; this.notify(); return; }
      const item = this.nextPending();
      if (!item) {
        this.running = false;
        this.currentTrackName = null;
        this.pushLog("info", "File d'attente vide — analyse terminée.");
        this.notify();
        return;
      }
      this.currentTrackName = item.name;
      this.updateStatus(item, "analyzing");
      const t0 = performance.now();
      this.abort = new AbortController();
      try {
        // Respect the user's manual override — never overwrite a track
        // whose key was set by hand.
        const override = getOverride(item.trackId);
        if (override) {
          const data: KeyAnalysisData = {
            key: override,
            camelot: toCamelot(override),
            confidence: "high",
            confidenceScore: 1,
            engineVersion: ENGINE_VERSION,
            analyzedAt: Date.now(),
            analysisMs: 0,
          };
          this.persist?.(item.trackId, override, data);
          item.result = data;
          this.pushLog("info", `${item.name} → ${override} (correction utilisateur)`);
          this.updateStatus(item, "done");
          this.abort = null;
          await new Promise((r) => setTimeout(r, NORMAL_DELAY_MS));
          continue;
        }
        const url = this.urlByTrackId.get(item.trackId);
        if (!url) throw new Error("URL indisponible");
        const decoded = await decodeToMono(url, this.abort.signal);
        const result = await detectKeyHybrid(decoded, this.abort.signal);
        const durationMs = performance.now() - t0;
        const data: KeyAnalysisData = {
          key: result.key,
          camelot: result.camelot ?? toCamelot(result.key),
          confidence: result.confidence,
          confidenceScore: result.confidenceScore,
          engineVersion: ENGINE_VERSION,
          analyzedAt: result.analyzedAt,
          analysisMs: durationMs,
          needsReview: result.needsReview || undefined,
          engines: [
            { engine: result.primary.engine, key: result.primary.key, score: result.primary.score },
            ...(result.verifier
              ? [{ engine: result.verifier.engine, key: result.verifier.key, score: result.verifier.score }]
              : []),
          ],
        };
        this.persist?.(item.trackId, result.key, data);
        item.result = data;
        item.attempts += 1;
        this.recent.push(durationMs);
        if (this.recent.length > RECENT_TIMES) this.recent.shift();
        this.lastAnalyzed = {
          name: item.name,
          key: result.key,
          camelot: result.camelot ?? null,
        };
        this.pushLog(
          result.needsReview ? "warn" : "info",
          `${item.name} → ${result.key}${result.camelot ? ` (${result.camelot})` : ""}${
            result.needsReview ? " — à vérifier" : ""
          } · ${(durationMs / 1000).toFixed(1)}s`,
        );
        this.updateStatus(item, "done");
      } catch (err) {
        item.attempts += 1;
        item.lastError = err instanceof Error ? err.message : String(err);
        const isAbort = item.lastError.includes("aborted");
        if (isAbort) {
          // Not an error — user paused / library reloaded. Requeue.
          item.status = "pending";
          item.lastError = null;
        } else {
          this.pushLog("error", `${item.name} — ${item.lastError}`);
          this.updateStatus(item, "error");
        }
      } finally {
        this.abort = null;
      }

      // Cooperative delay (bigger in slow mode when the robot needs CPU).
      const delay = this.slowMode ? SLOW_MODE_DELAY_MS : NORMAL_DELAY_MS;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Singleton — survives navigation, feature panels and route changes.
export const keyAnalysisEngine = new KeyAnalysisEngine();