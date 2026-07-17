import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import {
  Play,
  Pause,
  Waves,
  Music2,
  AlertTriangle,
  Check,
  Disc,
  Loader2,
  HelpCircle,
  SkipForward,
  Crosshair,
  MousePointer2,
  ScanLine,
  SlidersHorizontal,
  ClipboardList,
  Eye,
  RotateCcw,
  Smartphone,
  Image as ImageIcon,
  CircleCheck,
  CircleX,
  Upload,
} from "lucide-react";
import {
  useDiscDJRobot,
  type RobotLogLevel,
  type RobotPhase,
} from "@/lib/analysis/discdj-robot";
import type { DeckId } from "@/lib/analysis/discdj-bridge";
import {
  DEFAULT_DISCDJ_SETTINGS,
  clamp01,
  isDiscDJCalibrationComplete,
  isElementCalibrated,
  getElementTimestamp,
  type CalibrationTarget,
  type CalibrationPoint,
  type CalibrationRect,
  type DiscDJCalibration,
  type DiscDJRobotSettings,
  type DiscDJAnalysisMode,
} from "@/lib/analysis/discdj-settings";

const TARGETS: Array<{ id: CalibrationTarget; label: string; icon: "point" | "zone"; deck: DeckId }> = [
  { id: "nextDeck1", label: "Bouton Next · platine 1", icon: "point", deck: 1 },
  { id: "nextDeck2", label: "Bouton Next · platine 2", icon: "point", deck: 2 },
  { id: "bpmDeck1", label: "Zone BPM · platine 1", icon: "zone", deck: 1 },
  { id: "bpmDeck2", label: "Zone BPM · platine 2", icon: "zone", deck: 2 },
];

const AUTOSYNC_TARGETS: Array<{ id: CalibrationTarget; label: string; icon: "point" | "zone"; screen: "main" | "playlist" }> = [
  { id: "playlistButton", label: "Bouton Playlist (écran principal)", icon: "point", screen: "main" },
  { id: "backButton", label: "Bouton Retour (dans la playlist)", icon: "point", screen: "playlist" },
  { id: "playlistZoneDeck1", label: "Zone complète playlist · platine 1 (englobe toute la liste)", icon: "zone", screen: "playlist" },
  { id: "playlistZoneDeck2", label: "Zone complète playlist · platine 2 (englobe toute la liste)", icon: "zone", screen: "playlist" },
];


export function DiscDJRobotPanel() {
  const {
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
  } = useDiscDJRobot();
  const [deckSheetOpen, setDeckSheetOpen] = useState(false);
  const [pendingDeck, setPendingDeck] = useState<DeckId>(1);
  const [panel, setPanel] = useState<"calibration" | "settings" | "diagnostic">("calibration");
  const [resumeBanner, setResumeBanner] = useState<{ index: number; total: number; deck: DeckId } | null>(null);

  const running = !["idle", "paused", "done", "error"].includes(state.phase);
  const calibrationComplete = isDiscDJCalibrationComplete(state.settings);
  const progressPct =
    state.totalRun > 0 ? Math.min(100, Math.round((state.doneInRun / state.totalRun) * 100)) : 0;
  const autoSync = state.settings.analysisMode === "auto-sync" || state.settings.analysisMode === "autosync-name";
  const visibilityWarning = state.phase === "paused" && state.errorMessage?.toLowerCase().includes("discdj");

  // Detect an interrupted background run at mount and offer to resume.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await getBackgroundStatus();
      if (cancelled || !status) return;
      if (status.running || status.interrupted) {
        setResumeBanner({
          index: status.savedIndex ?? status.index ?? 0,
          total: status.savedTotal ?? status.total ?? 0,
          deck: (status.savedDeck as DeckId) ?? 1,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [getBackgroundStatus]);

  return (
    <section className="animate-fade-up space-y-3" style={{ animationDelay: "60ms" }}>
      {resumeBanner && (
        <div className="rounded-xl border border-primary/50 bg-primary/10 p-3 text-[12px]">
          <p className="font-semibold">Analyse interrompue détectée</p>
          <p className="mt-0.5 text-muted-foreground">Reprendre au morceau {resumeBanner.index}/{resumeBanner.total} sur la platine {resumeBanner.deck} ?</p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => { const d = resumeBanner.deck; setResumeBanner(null); void start(d, { resume: true }); }} className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[11px] font-semibold text-primary-foreground">Reprendre</button>
            <button onClick={() => { setResumeBanner(null); void clearBackgroundState(); }} className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-[11px] font-semibold">Ignorer</button>
          </div>
        </div>
      )}
      {visibilityWarning && (
        <div className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-3 text-[12px] text-amber-700 dark:text-amber-300">
          Rouvre DiscDJ (mode paysage) — l'analyse reprendra automatiquement dès qu'il est visible.
        </div>
      )}
      <div className="rounded-2xl border border-primary/30 bg-accent/20 p-4">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary/15 text-primary">
            <Waves className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-display text-sm font-semibold leading-tight">Robot DiscDJ</p>
            <p className="truncate text-[11px] text-muted-foreground">
              Pont : {state.bridgeLabel}{running && state.deck ? ` · Platine ${state.deck}` : ""}
            </p>
          </div>
          {running || state.phase === "awaiting-user" ? (
            <div className="flex items-center gap-1.5">
              <button onClick={pause} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-[11px] font-semibold">
                <Pause className="h-3.5 w-3.5" />
                Pause
              </button>
              <button onClick={stop} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-destructive px-3 text-xs font-semibold text-destructive-foreground shadow-sm transition-transform active:scale-[0.98]">
                Arrêter
              </button>
            </div>
          ) : state.phase === "paused" ? (
            <div className="flex items-center gap-1.5">
              <button onClick={resume} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground">
                <Play className="h-3.5 w-3.5" />
                Reprendre
              </button>
              <button onClick={stop} className="inline-flex h-9 items-center rounded-lg border border-border px-2.5 text-[11px] font-semibold">Arrêter</button>
            </div>
          ) : (
            <button onClick={() => setDeckSheetOpen(true)} disabled={!calibrationComplete} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-sm transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50">
              <Play className="h-3.5 w-3.5" />
              {state.phase === "done" ? "Relancer" : "Démarrer"}
            </button>
          )}
        </div>

        {!calibrationComplete && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-[11px] text-foreground">
            <Crosshair className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>Calibration requise : les clics Next et les zones BPM doivent être définis avant toute analyse.</span>
          </div>
        )}

        {(running || state.phase === "paused" || state.phase === "done" || state.phase === "awaiting-user") && (
          <div className="mt-4 rounded-xl border border-border/60 bg-background/60 p-3">
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/40 text-primary">
                <PhaseIcon phase={state.phase} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-sm font-semibold leading-tight">
                  {autoSync && state.totalIndex > 0
                    ? `Morceau ${state.currentIndex}/${state.totalIndex}`
                    : state.currentTrack?.name ?? state.currentReading?.title ?? (state.phase === "done" ? "Analyse terminée" : "En attente…")}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {phaseLabel(state.phase)}
                  {autoSync && state.etaMsRemaining != null && running ? ` · reste ~${formatEta(state.etaMsRemaining)}` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="font-display text-xl font-semibold tabular-nums text-primary">
                  {state.currentReading?.bpm != null ? state.currentReading.bpm.toFixed(1) : "—"}
                </p>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">BPM</p>
              </div>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
              <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
              <span>{state.doneInRun} / {state.totalRun}{state.skipped > 0 ? ` · ${state.skipped} ignoré(s)` : ""}{state.needsRetryCount > 0 ? ` · ${state.needsRetryCount} à réanalyser` : ""}</span>
              <span>{Math.max(0, state.totalRun - state.doneInRun)} restants</span>
            </div>
            {state.phase === "done" && state.recap && (
              <div className="mt-3 space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-[11px]">
                <p className="font-display text-[12px] font-semibold text-foreground">Récapitulatif</p>
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="rounded-md bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
                    <p className="text-[10px] uppercase tracking-widest">Analysés</p>
                    <p className="font-display text-base font-semibold tabular-nums">{state.recap.analyzedCount}</p>
                  </div>
                  <div className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">
                    <p className="text-[10px] uppercase tracking-widest">À réanalyser</p>
                    <p className="font-display text-base font-semibold tabular-nums">{state.recap.needsRetryCount}</p>
                  </div>
                </div>
                {state.recap.missing.length > 0 && (
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer text-[11px]">Morceaux à réanalyser ({state.recap.missing.length})</summary>
                    <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-3 text-[10px]">
                      {state.recap.missing.map((m) => (
                        <li key={m.index} className="truncate">#{m.index} — {m.name}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {state.recap.toVerify && state.recap.toVerify.length > 0 && (
                  <details className="text-muted-foreground" open>
                    <summary className="cursor-pointer text-[11px] font-semibold text-amber-700 dark:text-amber-300">À vérifier ({state.recap.toVerify.length})</summary>
                    <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto pl-1 text-[10px]">
                      {state.recap.toVerify.map((v) => (
                        <li key={v.index} className="rounded border border-amber-500/30 bg-amber-500/5 px-1.5 py-1">
                          <p className="truncate text-foreground">#{v.index} · OCR : « {v.ocrName || "?"} »</p>
                          <p className="truncate text-muted-foreground">
                            {v.bestGuess ? `Suggestion : ${v.bestGuess} · score ${(v.score * 100).toFixed(0)}%` : "aucune suggestion"}
                            {v.bpm != null ? ` · BPM lu ${v.bpm}` : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {state.recap.foundBpms.length > 0 && (
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer text-[11px]">BPM trouvés ({state.recap.foundBpms.length})</summary>
                    <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-3 text-[10px] tabular-nums">
                      {state.recap.foundBpms.map((f) => (
                        <li key={f.index} className="truncate">#{f.index} — {f.name} · {f.bpm} BPM</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        )}


        {!autoSync && state.pending && state.phase === "awaiting-user" && (
          <div className="mt-3 rounded-xl border border-primary/40 bg-primary/10 p-3">
            <div className="mb-2 flex items-start gap-2 text-[11px] text-foreground">
              <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <span>
                Plusieurs correspondances possibles pour <strong className="font-semibold">« {state.pending.reading.title ?? "?"} »</strong>{state.pending.reading.durationSec != null ? ` · ${formatDuration(state.pending.reading.durationSec)}` : ""}. Choisis le bon morceau pour poursuivre.
              </span>
            </div>
            <div className="space-y-1.5">
              {state.pending.candidates.map((c) => (
                <button key={c.track.id} onClick={() => resolvePending(c.track.id)} className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-2 text-left transition-colors hover:border-primary/50 hover:bg-accent/30">
                  <Music2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{c.track.name}</p>
                    <p className="text-[10px] text-muted-foreground">{c.track.durationSec != null ? formatDuration(c.track.durationSec) : "durée ?"} · similarité {Math.round(c.combined * 100)}%</p>
                  </div>
                </button>
              ))}
              <button onClick={skipPending} className="mt-1 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-background px-2.5 py-2 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground">
                <SkipForward className="h-3.5 w-3.5" />
                Aucun ne correspond — ignorer
              </button>
            </div>
          </div>
        )}

        {!running && state.phase !== "awaiting-user" && (
          <RunOptions settings={state.settings} onSettingsChange={updateSettings} />
        )}

        {state.errorMessage && (
          <div className="mt-3 space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{state.errorMessage}</span></div>
            {state.errorMessage.toLowerCase().includes("accessibilité") && (
              <button onClick={openAccessibilitySettings} className="inline-flex h-8 items-center justify-center rounded-lg border border-destructive/30 px-2.5 text-[11px] font-semibold">Ouvrir les paramètres Android</button>
            )}
          </div>
        )}
        {state.lastError && !state.errorMessage && <p className="mt-3 text-[11px] text-muted-foreground/70">Dernier avertissement : {state.lastError}</p>}
      </div>

      <div className="rounded-2xl border border-border/70 bg-surface p-3">
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-background/70 p-1">
          <PanelTab active={panel === "calibration"} onClick={() => setPanel("calibration")} icon={<Crosshair className="h-3.5 w-3.5" />} label="Calibration" />
          <PanelTab active={panel === "settings"} onClick={() => setPanel("settings")} icon={<SlidersHorizontal className="h-3.5 w-3.5" />} label="Réglages" />
          <PanelTab active={panel === "diagnostic"} onClick={() => setPanel("diagnostic")} icon={<ClipboardList className="h-3.5 w-3.5" />} label="Diagnostic" />
        </div>
        {panel === "calibration" && (
          <CalibrationPanel
            settings={state.settings}
            supportsDirectCapture={supportsDirectCapture}
            onSettingsChange={updateSettings}
            onCapture={captureCalibration}
            onSetElement={updateCalibrationElement}
            onTestRead={testRead}
            onTestClick={testClick}
            onTestPlaylist={testPlaylistButton}
            onTestBack={testBackButton}
            onTestNameZone={testNameZone}
          />
        )}
        {panel === "settings" && <SettingsPanel settings={state.settings} onSettingsChange={updateSettings} />}
        {panel === "diagnostic" && <DiagnosticPanel logs={state.logs} />}
      </div>

      {deckSheetOpen && (
        <DeckSheet value={pendingDeck} onChange={setPendingDeck} onClose={() => setDeckSheetOpen(false)} onConfirm={async () => {
          const missing = missingCalibrationForStart(state.settings, pendingDeck);
          if (missing.length > 0) {
            alert(`Calibration incomplète — recalibre : ${missing.join(", ")}`);
            return;
          }
          // Final safety net: re-check the accessibility service right before
          // launching the robot. If the user disabled it since opening the
          // panel, force them through the gate again.
          const acc = await checkAccessibility();
          if (acc.native && !acc.enabled) {
            try { await openAccessibilitySettings(); } catch { /* ignore */ }
            alert("Active le service d'accessibilité MixOrder puis reviens pour démarrer le robot.");
            return;
          }
          setDeckSheetOpen(false);
          start(pendingDeck);
        }} />

      )}
    </section>
  );
}

function RunOptions({ settings, onSettingsChange }: { settings: DiscDJRobotSettings; onSettingsChange: (patch: Partial<DiscDJRobotSettings>) => void }) {
  const mode = settings.analysisMode;
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-border/60 bg-background/60 p-2.5">
      <p className="text-[11px] font-semibold text-foreground">Mode d'analyse</p>
      <div className="grid grid-cols-3 gap-1.5">
        <ModeCard active={mode === "auto-sync"} onClick={() => onSettingsChange({ analysisMode: "auto-sync" })} title="Auto" subtitle="Ordre aligné" />
        <ModeCard active={mode === "autosync-name"} onClick={() => onSettingsChange({ analysisMode: "autosync-name" })} title="AutoSync" subtitle="Nom vérifié" />
        <ModeCard active={mode === "verification"} onClick={() => onSettingsChange({ analysisMode: "verification" })} title="Vérif." subtitle="Manuel" />
      </div>
      {mode === "autosync-name" && (
        <p className="rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[10px] leading-tight text-foreground">
          Le robot lit le BPM sur le deck, ouvre la playlist, lit le 1er morceau affiché en bleu (= morceau chargé), associe le BPM après validation du nom, revient à l'écran principal et clique Next.
        </p>
      )}

      <div className="grid grid-cols-2 gap-1.5 pt-1">
        <StartIndexField value={settings.startAtIndex} onCommit={(v) => onSettingsChange({ startAtIndex: v })} />

        <OptionToggle label="Reprise auto" checked={settings.autoResume} onChange={(v) => onSettingsChange({ autoResume: v })} />
        {mode === "auto-sync" && (
          <OptionToggle label="Continuer en arrière-plan" checked={settings.runInBackground} onChange={(v) => onSettingsChange({ runInBackground: v })} />
        )}
        <OptionToggle label="Ignorer BPM déjà présents" checked={settings.skipAlreadyBpm} onChange={(v) => onSettingsChange({ skipAlreadyBpm: v })} />
        <OptionToggle label="Remplacer les BPM" checked={settings.replaceExisting} onChange={(v) => onSettingsChange({ replaceExisting: v })} />
        <OptionToggle label="Sauvegarde après chaque morceau" checked={settings.autosaveEachStep} onChange={(v) => onSettingsChange({ autosaveEachStep: v })} />
      </div>
    </div>
  );
}

/**
 * Editable "start at track n°" input. Kept as a local string state so the
 * user can clear the field to type a new value; only committed on blur or
 * Enter with a positive integer. Otherwise reverts to the last valid value.
 */
function StartIndexField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string>(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 1) {
      if (n !== value) onCommit(n);
      setDraft(String(n));
    } else {
      setDraft(String(value));
    }
  };
  return (
    <label className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-background px-2 py-1.5 text-[10px]">
      <span className="text-muted-foreground">Commencer au n°</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-full bg-transparent text-[12px] font-semibold tabular-nums text-foreground outline-none"
      />
    </label>
  );
}

function ModeCard({ active, onClick, title, subtitle }: { active: boolean; onClick: () => void; title: string; subtitle: string }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-start gap-0.5 rounded-lg border p-2 text-left transition-colors ${active ? "border-primary/60 bg-accent/40" : "border-border bg-background/70"}`}>
      <span className="text-[11px] font-semibold text-foreground">{title}</span>
      <span className="text-[10px] text-muted-foreground">{subtitle}</span>
    </button>
  );
}

function OptionToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-background px-2 py-1.5 text-[10px] text-foreground">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 rounded border-border accent-primary" />
      <span className="min-w-0 flex-1 leading-tight">{label}</span>
    </label>
  );
}

function formatEta(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m} min ${r.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

function PanelTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return <button onClick={onClick} className={`inline-flex h-9 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold transition-colors ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"}`}>{icon}<span className="hidden min-[380px]:inline">{label}</span></button>;
}

type BpmDiagnostic = {
  raw: string;
  cleaned: string;
  corrected: string;
  extracted: number | null;
  accepted: boolean;
  reason: string | null;
};

type TestResult = { ok: boolean; text: string; details?: { bpm: number | null; title: string | null; durationSec: number | null; raw?: string | null; zoneTexts?: string[]; bpmDiagnostics?: BpmDiagnostic[]; parseReason?: string | null; bpmZone?: CalibrationRect | null; sourceOk?: boolean; orientationOk?: boolean; sourcePackage?: string | null; fullScreenshot?: string | null; croppedImage?: string | null; ocrInputImage?: string | null; ocrRect?: { left: number; top: number; width: number; height: number } | null; display?: { width: number; height: number } | null } };

function CalibrationPanel({
  settings,
  supportsDirectCapture,
  onSettingsChange,
  onCapture,
  onSetElement,
  onTestRead,
  onTestClick,
  onTestPlaylist,
  onTestBack,
  onTestNameZone,
}: {
  settings: DiscDJRobotSettings;
  supportsDirectCapture: boolean;
  onSettingsChange: (patch: Partial<DiscDJRobotSettings>) => void;
  onCapture: (target: CalibrationTarget) => Promise<boolean>;
  onSetElement: (target: CalibrationTarget, value: CalibrationPoint | CalibrationRect | null) => void;
  onTestRead: (deck: DeckId) => Promise<import("@/lib/analysis/discdj-bridge").DiscDJReading | null>;
  onTestClick: (deck: DeckId) => Promise<{ changed: boolean; message: string }>;
  onTestPlaylist: () => Promise<{ ok: boolean; message: string }>;
  onTestBack: () => Promise<{ ok: boolean; message: string }>;
  onTestNameZone: (deck: DeckId) => Promise<{ ok: boolean; raw: string; cleaned: string; message: string; zoneImage?: string | null; activeRowImage?: string | null; activeRowFraction?: { x: number; y: number; width: number; height: number } | null; reason?: string | null }>;
}) {
  const [method, setMethod] = useState<"direct" | "screenshot">("direct");
  const [busy, setBusy] = useState<CalibrationTarget | null>(null);
  const [shotTarget, setShotTarget] = useState<CalibrationTarget>("nextDeck1");
  const [testResult, setTestResult] = useState<Record<number, TestResult | null>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [autoSyncTestResult, setAutoSyncTestResult] = useState<string | null>(null);
  const [playlistZoneDiag, setPlaylistZoneDiag] = useState<{
    deck: DeckId;
    ok: boolean;
    message: string;
    cleaned: string;
    zoneImage?: string | null;
    activeRowImage?: string | null;
    activeRowFraction?: { x: number; y: number; width: number; height: number } | null;
    reason?: string | null;
  } | null>(null);
  const complete = isDiscDJCalibrationComplete(settings);

  const handleDirect = async (t: CalibrationTarget) => {
    setBusy(t);
    await onCapture(t);
    setBusy(null);
  };
  const handleRecalibrate = (t: CalibrationTarget) => {
    if (method === "direct") void handleDirect(t);
    else setShotTarget(t);
  };
  const runTestRead = async (deck: DeckId) => {
    setTesting(`read${deck}`);
    const r = await onTestRead(deck);
    setTesting(null);
    const zone = deck === 1 ? settings.calibration.bpmDeck1 : settings.calibration.bpmDeck2;
    const details = r ? { bpm: r.bpm, title: r.title, durationSec: r.durationSec, raw: r.raw ?? null, zoneTexts: r.zoneTexts, bpmDiagnostics: r.bpmDiagnostics, parseReason: r.parseReason ?? null, bpmZone: zone, sourceOk: r.sourceOk, orientationOk: r.orientationOk, sourcePackage: r.sourcePackage ?? null, fullScreenshot: r.fullScreenshot ?? null, croppedImage: r.croppedImage ?? null, ocrInputImage: r.ocrInputImage ?? null, ocrRect: r.ocrRect ? { left: r.ocrRect.left, top: r.ocrRect.top, width: r.ocrRect.width, height: r.ocrRect.height } : null, display: r.display ?? null } : null;
    if (r && r.bpm != null) {
      setTestResult((p) => ({ ...p, [deck]: { ok: true, text: `BPM lu : ${r.bpm}`, details: details ?? undefined } }));
    } else {
      const why = r?.parseReason ?? (r == null ? "Autre erreur identifiée : aucune lecture reçue du pont natif." : (!r.raw && !(r.zoneTexts?.length)) ? "Zone OCR vide : aucun texte détecté dans la zone calibrée." : "Valeur BPM illisible : texte détecté mais aucun nombre entre 40 et 240.");
      setTestResult((p) => ({ ...p, [deck]: { ok: false, text: why, details: details ?? { bpm: null, title: null, durationSec: null, bpmZone: zone } } }));
    }
  };
  const runTestClick = async (deck: DeckId) => {
    setTesting(`click${deck}`);
    const r = await onTestClick(deck);
    setTesting(null);
    setTestResult((p) => ({ ...p, [deck]: { ok: r.changed, text: r.message } }));
  };

  return (
    <div className="mt-3 space-y-3">
      {/* Method chooser */}
      <div className="grid grid-cols-2 gap-2">
        <MethodCard active={method === "direct"} onClick={() => setMethod("direct")} icon={<Smartphone className="h-4 w-4" />} title="Directe dans DiscDJ" subtitle="Recommandé" disabled={!supportsDirectCapture} />
        <MethodCard active={method === "screenshot"} onClick={() => setMethod("screenshot")} icon={<ImageIcon className="h-4 w-4" />} title="Depuis une capture" subtitle="Image importée" />
      </div>
      {!supportsDirectCapture && method === "direct" && (
        <p className="rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-[10px] text-muted-foreground">La calibration directe nécessite l'app Android (service d'accessibilité). Sur le web, utilise la capture d'écran.</p>
      )}
      {method === "direct" ? (
        <p className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-[11px] text-foreground">Touche « Recalibrer » : DiscDJ s'ouvre avec une fenêtre flottante. Touche l'emplacement exact (ou glisse un rectangle pour les zones BPM).</p>
      ) : (
        <ScreenshotCalibrator target={shotTarget} onTargetChange={setShotTarget} calibration={settings.calibration} onSetElement={onSetElement} />
      )}

      {/* Recap */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold text-foreground">Récapitulatif</p>
        {TARGETS.map((item) => (
          <ElementRow key={item.id} item={item} valid={isElementCalibrated(settings, item.id)} ts={getElementTimestamp(settings, item.id)} busy={busy === item.id} active={method === "screenshot" && shotTarget === item.id} onRecalibrate={() => handleRecalibrate(item.id)} />
        ))}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-[10px] text-muted-foreground">{complete ? "Calibration complète ✓" : "Calibration incomplète"}</span>
          <button onClick={() => onSettingsChange({ calibration: DEFAULT_DISCDJ_SETTINGS.calibration })} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-[11px] font-semibold text-muted-foreground"><RotateCcw className="h-3.5 w-3.5" />Tout réinitialiser</button>
        </div>
      </div>

      {/* AutoSync (name-checked) calibration */}
      {settings.analysisMode === "autosync-name" && (
        <div className="space-y-1.5 rounded-lg border border-primary/40 bg-primary/5 p-2">
          <p className="text-[11px] font-semibold text-foreground">Calibration AutoSync</p>
          <p className="text-[10px] text-muted-foreground">Nécessaire pour vérifier le nom avant chaque association BPM.</p>
          {AUTOSYNC_TARGETS.map((item) => (
            <ElementRow
              key={item.id}
              item={item}
              valid={isElementCalibrated(settings, item.id)}
              ts={getElementTimestamp(settings, item.id)}
              busy={busy === item.id}
              active={method === "screenshot" && shotTarget === item.id}
              onRecalibrate={() => handleRecalibrate(item.id)}
            />
          ))}
        </div>
      )}

      {/* AutoSync tests */}
      {settings.analysisMode === "autosync-name" && (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-2">
          <p className="text-[11px] font-semibold text-foreground">Tests AutoSync</p>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              disabled={testing !== null}
              onClick={async () => {
                setTesting("playlistBtn");
                const r = await onTestPlaylist();
                setTesting(null);
                setAutoSyncTestResult(`${r.ok ? "✓" : "✗"} Playlist : ${r.message}`);
              }}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-accent/40 px-2 text-[10px] font-semibold disabled:opacity-50"
            >
              {testing === "playlistBtn" ? <Loader2 className="h-3 w-3 animate-spin" /> : <MousePointer2 className="h-3 w-3" />}
              Test Playlist
            </button>
            <button
              disabled={testing !== null}
              onClick={async () => {
                setTesting("backBtn");
                const r = await onTestBack();
                setTesting(null);
                setAutoSyncTestResult(`${r.ok ? "✓" : "✗"} Retour : ${r.message}`);
              }}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-accent/40 px-2 text-[10px] font-semibold disabled:opacity-50"
            >
              {testing === "backBtn" ? <Loader2 className="h-3 w-3 animate-spin" /> : <MousePointer2 className="h-3 w-3" />}
              Test Retour
            </button>
            {[1, 2].map((d) => {
              const deck = d as DeckId;
              const key = `playlistZone${deck}`;
              return (
                <button
                  key={key}
                  disabled={testing !== null}
                  onClick={async () => {
                    setTesting(key);
                    const r = await onTestNameZone(deck);
                    setTesting(null);
                    setAutoSyncTestResult(`${r.ok ? "✓" : "✗"} Zone playlist P${deck} — ${r.message}`);
                    setPlaylistZoneDiag({
                      deck,
                      ok: r.ok,
                      message: r.message,
                      cleaned: r.cleaned,
                      zoneImage: r.zoneImage,
                      activeRowImage: r.activeRowImage,
                      activeRowFraction: r.activeRowFraction,
                      reason: r.reason,
                    });
                  }}
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-primary px-2 text-[10px] font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {testing === key ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanLine className="h-3 w-3" />}
                  Test playlist P{deck}
                </button>
              );
            })}
          </div>
          {autoSyncTestResult && (
            <div className={`rounded-md px-2 py-1.5 text-[10px] ${autoSyncTestResult.startsWith("✓") ? "bg-primary/10 text-foreground" : "bg-destructive/10 text-destructive"}`}>
              {autoSyncTestResult}
            </div>
          )}
          {playlistZoneDiag && (
            <PlaylistZonePreview diag={playlistZoneDiag} onClose={() => setPlaylistZoneDiag(null)} />
          )}
        </div>
      )}

      {/* Test mode */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold text-foreground">Tester la calibration</p>
        {[1, 2].map((d) => {
          const deck = d as DeckId;
          const res = testResult[deck];
          return (
            <div key={deck} className="rounded-lg border border-border/60 bg-background/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold">Platine {deck}</p>
                <div className="flex gap-1.5">
                  <button onClick={() => runTestRead(deck)} disabled={testing !== null} className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-accent/40 px-2 text-[10px] font-semibold disabled:opacity-50">{testing === `read${deck}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}Test BPM</button>
                  <button onClick={() => runTestClick(deck)} disabled={testing !== null} className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-primary px-2 text-[10px] font-semibold text-primary-foreground disabled:opacity-50">{testing === `click${deck}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <MousePointer2 className="h-3 w-3" />}Test Next</button>
                </div>
              </div>
              {res && (
                <div className={`mt-2 space-y-1 rounded-md px-2 py-1.5 text-[10px] ${res.ok ? "bg-primary/10 text-foreground" : "bg-destructive/10 text-destructive"}`}>
                  <div className="flex items-start gap-1.5">
                    {res.ok ? <CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-primary" /> : <CircleX className="mt-0.5 h-3 w-3 shrink-0" />}
                    <span>{res.text}</span>
                  </div>
                  {res.details && (
                    <div className="space-y-1.5 pl-4">
                      <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                        <dt>BPM final</dt><dd className="tabular-nums font-semibold text-foreground">{res.details.bpm ?? "—"}</dd>
                        <dt>Nom</dt><dd className="truncate text-foreground">{res.details.title ?? "—"}</dd>
                        <dt>Durée</dt><dd className="tabular-nums text-foreground">{res.details.durationSec != null ? `${Math.round(res.details.durationSec)} s` : "—"}</dd>
                        <dt>OCR brut</dt><dd className="break-all font-mono text-foreground">{res.details.raw ?? "—"}</dd>
                        <dt>Textes zone</dt><dd className="break-all text-foreground">{res.details.zoneTexts && res.details.zoneTexts.length > 0 ? res.details.zoneTexts.join(" · ") : "—"}</dd>
                        <dt>Zone OCR</dt><dd className="tabular-nums text-foreground">{res.details.bpmZone ? `x=${res.details.bpmZone.x.toFixed(3)} · y=${res.details.bpmZone.y.toFixed(3)} · w=${res.details.bpmZone.width.toFixed(3)} · h=${res.details.bpmZone.height.toFixed(3)}` : "non calibrée"}</dd>
                        <dt>Source</dt><dd className="break-all text-foreground">{res.details.sourcePackage ?? "—"}{res.details.sourceOk === false ? " · mauvaise source" : ""}</dd>
                        <dt>Orientation</dt><dd className="text-foreground">{res.details.orientationOk === false ? "incorrecte" : res.details.orientationOk === true ? "paysage OK" : "—"}</dd>
                        <dt>Rectangle réel</dt><dd className="tabular-nums text-foreground">{res.details.ocrRect ? `${res.details.ocrRect.left},${res.details.ocrRect.top} · ${res.details.ocrRect.width}×${res.details.ocrRect.height}px` : "—"}</dd>
                      </dl>
                      {res.details.bpmZone && (
                        <div>
                          <p className="text-[10px] text-muted-foreground">Prévisualisation exacte du rectangle calibré :</p>
                          <div className="relative mt-1 h-14 w-full overflow-hidden rounded border border-border/60 bg-background/40">
                            <div className="absolute rounded border border-primary bg-primary/20" style={{ left: `${res.details.bpmZone.x * 100}%`, top: `${res.details.bpmZone.y * 100}%`, width: `${res.details.bpmZone.width * 100}%`, height: `${res.details.bpmZone.height * 100}%` }} />
                          </div>
                        </div>
                      )}
                      {(res.details.fullScreenshot || res.details.croppedImage || res.details.ocrInputImage) && (
                        <div className="space-y-2">
                          <DiagnosticImage label="Capture complète DiscDJ utilisée" src={res.details.fullScreenshot} />
                          <DiagnosticImage label="Rectangle OCR réellement découpé" src={res.details.croppedImage} />
                          <DiagnosticImage label="Image transmise au moteur OCR" src={res.details.ocrInputImage} />
                        </div>
                      )}
                      {res.details.bpmDiagnostics && res.details.bpmDiagnostics.length > 0 && (
                        <div className="space-y-1 rounded-md border border-border/60 bg-background/60 p-2">
                          <p className="text-[10px] font-semibold text-foreground">Diagnostic avancé BPM</p>
                          <div className="max-h-40 space-y-1 overflow-auto">
                            {res.details.bpmDiagnostics.map((diag, index) => (
                              <div key={`${diag.raw}-${index}`} className={`rounded border px-2 py-1 ${diag.accepted ? "border-primary/30 bg-primary/5" : "border-destructive/30 bg-destructive/5"}`}>
                                <p className="font-semibold text-foreground">Variante {index + 1} · {diag.accepted ? "acceptée" : "rejetée"} · nombre {diag.extracted ?? "—"}</p>
                                <dl className="mt-0.5 grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
                                  <dt>brut</dt><dd className="break-all font-mono text-foreground">{diag.raw || "—"}</dd>
                                  <dt>nettoyé</dt><dd className="break-all font-mono text-foreground">{diag.cleaned || "—"}</dd>
                                  <dt>corrigé</dt><dd className="break-all font-mono text-foreground">{diag.corrected || "—"}</dd>
                                  <dt>raison</dt><dd className="text-foreground">{diag.reason ?? "—"}</dd>
                                </dl>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {!res.ok && res.details.parseReason && (
                        <p className="rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive">{res.details.parseReason}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PlaylistZoneDiag {
  deck: DeckId;
  ok: boolean;
  message: string;
  cleaned: string;
  zoneImage?: string | null;
  activeRowImage?: string | null;
  activeRowFraction?: { x: number; y: number; width: number; height: number } | null;
  reason?: string | null;
}

/**
 * Test-mode preview for the playlist zone: shows the captured zone with the
 * detected active (blue) row highlighted, plus the isolated row and OCR text.
 * Lets the user visually verify that the row detector picked the right line.
 */
function PlaylistZonePreview({ diag, onClose }: { diag: PlaylistZoneDiag; onClose: () => void }) {
  const frac = diag.activeRowFraction;
  const rowDetected = !!frac;
  const badge = diag.reason === "no-active-row"
    ? { label: "Aucune ligne bleue", tone: "bg-destructive/15 text-destructive" }
    : rowDetected && diag.cleaned
      ? { label: "Ligne active détectée · OCR ✓", tone: "bg-primary/15 text-primary" }
      : rowDetected
        ? { label: "Ligne détectée · OCR vide", tone: "bg-accent/40 text-foreground" }
        : { label: "Diagnostic", tone: "bg-accent/40 text-foreground" };
  return (
    <div className="animate-fade-in space-y-2 rounded-lg border border-primary/30 bg-background/70 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.tone}`}>
          {badge.label} · P{diag.deck}
        </span>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Fermer">
          <CircleX className="h-3 w-3" />
        </button>
      </div>
      {diag.zoneImage ? (
        <div className="relative overflow-hidden rounded-md border border-border/60 bg-background">
          <img src={diag.zoneImage} alt={`Zone playlist P${diag.deck}`} className="block max-h-64 w-full object-contain" />
          {frac && (
            <div
              className="pointer-events-none absolute rounded-sm border-2 border-primary shadow-[0_0_0_2px_rgba(93,214,44,0.35)]"
              style={{
                left: `${frac.x * 100}%`,
                top: `${frac.y * 100}%`,
                width: `${frac.width * 100}%`,
                height: `${frac.height * 100}%`,
                background: "rgba(93,214,44,0.15)",
              }}
            />
          )}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-2 py-3 text-[10px] text-muted-foreground">
          Aucune image de zone reçue.
        </div>
      )}
      {diag.activeRowImage && (
        <div>
          <p className="mb-1 text-[10px] text-muted-foreground">Ligne active isolée (utilisée pour l'OCR) :</p>
          <img src={diag.activeRowImage} alt="Ligne active" className="block max-h-16 w-full rounded border border-border/60 object-contain bg-background" />
        </div>
      )}
      <div className="rounded-md bg-background/60 px-2 py-1.5 text-[10px]">
        <p className="text-muted-foreground">Texte OCR :</p>
        <p className="font-mono text-foreground">{diag.cleaned || <span className="italic text-muted-foreground">(vide)</span>}</p>
      </div>
      {diag.reason === "no-active-row" && (
        <p className="rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          Aucune ligne au fond bleu n'a été trouvée. Recalibre la zone playlist en englobant toute la liste des morceaux visibles.
        </p>
      )}
    </div>
  );
}

function MethodCard({ active, onClick, icon, title, subtitle, disabled }: { active: boolean; onClick: () => void; icon: ReactNode; title: string; subtitle: string; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className={`flex flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition-colors disabled:opacity-50 ${active ? "border-primary/60 bg-accent/40" : "border-border bg-background/70"}`}><span className={`grid h-7 w-7 place-items-center rounded-lg ${active ? "bg-primary/15 text-primary" : "bg-surface-elevated text-muted-foreground"}`}>{icon}</span><span className="text-[11px] font-semibold leading-tight">{title}</span><span className="text-[9px] uppercase tracking-wide text-muted-foreground">{subtitle}</span></button>;
}

function DiagnosticImage({ label, src }: { label: string; src?: string | null }) {
  return (
    <div>
      <p className="mb-1 text-[10px] text-muted-foreground">{label}</p>
      {src ? <img src={src} alt={label} className="max-h-40 w-full rounded border border-border/60 object-contain" /> : <div className="rounded border border-border/60 bg-background/40 px-2 py-3 text-[10px] text-muted-foreground">Non disponible</div>}
    </div>
  );
}

function ElementRow({ item, valid, ts, busy, active, onRecalibrate }: { item: { id: CalibrationTarget; label: string; icon: "point" | "zone"; screen?: "main" | "playlist" }; valid: boolean; ts: number | null; busy: boolean; active: boolean; onRecalibrate: () => void }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${active ? "border-primary/60 bg-accent/30" : "border-border/60 bg-background/60"}`}>
      {valid ? <CircleCheck className="h-4 w-4 shrink-0 text-primary" /> : <CircleX className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 truncate text-[11px] font-semibold leading-tight">{item.icon === "point" ? <MousePointer2 className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ScanLine className="h-3 w-3 shrink-0 text-muted-foreground" />}{item.label}</p>
        <p className="truncate text-[10px] text-muted-foreground">
          {item.screen && <span className="mr-1 rounded bg-accent/40 px-1 py-px text-[9px] font-semibold uppercase text-primary">{item.screen === "playlist" ? "Playlist" : "Principal"}</span>}
          {valid ? (ts ? `Calibré le ${new Date(ts).toLocaleString()}` : "Calibré") : "Non calibré"}
        </p>
      </div>
      <button onClick={onRecalibrate} disabled={busy} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-[10px] font-semibold text-foreground disabled:opacity-50">{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Crosshair className="h-3 w-3" />}Recalibrer</button>
    </div>
  );
}


function ScreenshotCalibrator({ target, onTargetChange, calibration, onSetElement }: { target: CalibrationTarget; onTargetChange: (t: CalibrationTarget) => void; calibration: DiscDJCalibration; onSetElement: (target: CalibrationTarget, value: CalibrationPoint | CalibrationRect | null) => void }) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imageLandscape, setImageLandscape] = useState(true);
  const [dragStart, setDragStart] = useState<CalibrationPoint | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isZone = target.startsWith("bpm");
  const activeLabel = TARGETS.find((t) => t.id === target)?.label ?? "";

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImgSrc(typeof reader.result === "string" ? reader.result : null);
      setDragStart(null);
    };
    reader.readAsDataURL(file);
  };
  const updateFromPointer = (event: PointerEvent<HTMLDivElement>, isEnd = false) => {
    const point = pointFromPointer(event);
    if (!point) return;
    if (isZone) onSetElement(target, rectFromPoints(dragStart ?? point, point));
    else onSetElement(target, point);
    if (isEnd) setDragStart(null);
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5">
        {TARGETS.map((item) => (
          <button key={item.id} onClick={() => onTargetChange(item.id)} className={`flex min-h-10 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-[10px] font-semibold transition-colors ${target === item.id ? "border-primary/60 bg-accent/40 text-foreground" : "border-border bg-background/70 text-muted-foreground"}`}>{item.icon === "point" ? <MousePointer2 className="h-3 w-3 shrink-0" /> : <ScanLine className="h-3 w-3 shrink-0" />}<span className="min-w-0 flex-1 leading-tight">{item.label}</span>{calibration[item.id] ? <Check className="h-3 w-3 shrink-0 text-primary" /> : null}</button>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">Cible : <span className="font-semibold text-foreground">{activeLabel}</span> — {isZone ? "glisse un rectangle sur la zone BPM." : "touche le bouton exact."}</p>
      {!imgSrc ? (
        <button onClick={() => fileRef.current?.click()} className="flex h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-background/60 text-muted-foreground"><Upload className="h-5 w-5" /><span className="text-[11px] font-semibold">Importer une capture d'écran DiscDJ</span><span className="text-[10px]">Mode paysage recommandé</span></button>
      ) : (
        <div className="relative touch-none select-none overflow-hidden rounded-xl border border-border-strong" onPointerDown={(e) => { const p = pointFromPointer(e); setDragStart(p); updateFromPointer(e); }} onPointerMove={(e) => { if (e.buttons === 1) updateFromPointer(e); }} onPointerUp={(e) => updateFromPointer(e, true)}>
          <img src={imgSrc} alt="Capture DiscDJ" className="pointer-events-none block w-full" draggable={false} onLoad={(e) => setImageLandscape(e.currentTarget.naturalWidth >= e.currentTarget.naturalHeight)} />
          <PointMark point={displayPoint(calibration.nextDeck1, imageLandscape)} label="N1" active={target === "nextDeck1"} />
          <PointMark point={displayPoint(calibration.nextDeck2, imageLandscape)} label="N2" active={target === "nextDeck2"} />
          <RectMark rect={displayRect(calibration.bpmDeck1, imageLandscape)} label="BPM 1" active={target === "bpmDeck1"} />
          <RectMark rect={displayRect(calibration.bpmDeck2, imageLandscape)} label="BPM 2" active={target === "bpmDeck2"} />
        </div>
      )}
      {imgSrc && <button onClick={() => fileRef.current?.click()} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-[10px] font-semibold text-muted-foreground"><ImageIcon className="h-3 w-3" />Changer d'image</button>}
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
    </div>
  );
}

function PointMark({ point, label, active }: { point: CalibrationPoint | null; label: string; active: boolean }) {
  if (!point) return null;
  return (
    <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>
      <div className={`relative h-3 w-3 ${active ? "text-primary" : "text-primary/80"}`}>
        <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-current" />
        <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-current" />
        <span className={`absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ${active ? "bg-primary" : "bg-primary/80"}`} />
      </div>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-surface/90 px-1 py-px text-[9px] font-bold text-primary">{label}</span>
    </div>
  );
}


function RectMark({ rect, label, active }: { rect: CalibrationRect | null; label: string; active: boolean }) {
  if (!rect) return null;
  return <div className={`absolute rounded border ${active ? "border-primary bg-primary/20" : "border-primary/70 bg-primary/10"}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}><span className="absolute left-1 top-1 rounded bg-surface/90 px-1 text-[10px] font-bold text-primary">{label}</span></div>;
}

function SettingsPanel({ settings, onSettingsChange }: { settings: DiscDJRobotSettings; onSettingsChange: (patch: Partial<DiscDJRobotSettings>) => void }) {
  const rows = useMemo(() => [
    { key: "waitOnOpenMs", label: "Attente de chargement à l'ouverture", min: 0, max: 10000, step: 100, unit: "ms" },
    { key: "waitBeforeReadMs", label: "Attente avant lecture BPM", min: 150, max: 5000, step: 50, unit: "ms" },
    { key: "waitAfterClickMs", label: "Attente après clic Next", min: 250, max: 7000, step: 50, unit: "ms" },
    { key: "maxAttempts", label: "Tentatives max", min: 1, max: 8, step: 1, unit: "" },
    { key: "pressDurationMs", label: "Durée de pression", min: 45, max: 900, step: 5, unit: "ms" },
  ] as const, []);
  return <div className="mt-3 space-y-3"><div className="rounded-lg border border-border/60 bg-background/60 p-2"><p className="mb-1 text-[11px] font-semibold text-foreground">Correspondance des morceaux</p><p className="text-[10px] leading-snug text-muted-foreground">Toujours par nom DiscDJ + durée MixOrder. Aucun BPM n'est associé par ordre de playlist.</p></div>{rows.map((row) => { const value = settings[row.key]; return <label key={row.key} className="block rounded-lg border border-border/60 bg-background/60 p-2"><span className="mb-2 flex items-center justify-between gap-2 text-[11px] font-semibold text-foreground"><span>{row.label}</span><span className="tabular-nums text-primary">{value}{row.unit}</span></span><input type="range" min={row.min} max={row.max} step={row.step} value={value} onChange={(e) => onSettingsChange({ [row.key]: Number(e.target.value) } as Partial<DiscDJRobotSettings>)} className="w-full accent-primary" /></label>; })}</div>;
}

function DiagnosticPanel({ logs }: { logs: Array<{ id: string; at: number; level: RobotLogLevel; message: string }> }) {
  return <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-1">{logs.length === 0 ? <div className="rounded-lg border border-border/60 bg-background/60 p-3 text-[11px] text-muted-foreground">Aucun diagnostic pour le moment.</div> : logs.map((log) => <div key={log.id} className="flex gap-2 rounded-lg border border-border/60 bg-background/60 p-2"><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${logDotClass(log.level)}`} /><div className="min-w-0 flex-1"><p className="break-words text-[11px] leading-snug text-foreground">{log.message}</p><p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">{new Date(log.at).toLocaleTimeString()}</p></div></div>)}</div>;
}

function logDotClass(level: RobotLogLevel): string {
  if (level === "success") return "bg-primary";
  if (level === "warning") return "bg-accent-foreground";
  if (level === "error") return "bg-destructive";
  return "bg-muted-foreground";
}

function pointFromPointer(event: PointerEvent<HTMLDivElement>): CalibrationPoint | null {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = clamp01((event.clientX - rect.left) / rect.width);
  const y = clamp01((event.clientY - rect.top) / rect.height);
  // Screenshot imports and direct overlay captures both land in the same
  // canonical landscape frame. Portrait screenshots are rotated into it.
  return rect.width >= rect.height ? { x, y } : { x: y, y: clamp01(1 - x) };
}

function displayPoint(point: CalibrationPoint | null, landscape: boolean): CalibrationPoint | null {
  if (!point) return null;
  return landscape ? point : { x: clamp01(1 - point.y), y: clamp01(point.x) };
}

function displayRect(rect: CalibrationRect | null, landscape: boolean): CalibrationRect | null {
  if (!rect) return null;
  if (landscape) return rect;
  const corners = [
    displayPoint({ x: rect.x, y: rect.y }, false),
    displayPoint({ x: rect.x + rect.width, y: rect.y }, false),
    displayPoint({ x: rect.x + rect.width, y: rect.y + rect.height }, false),
    displayPoint({ x: rect.x, y: rect.y + rect.height }, false),
  ].filter(Boolean) as CalibrationPoint[];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x1 = Math.min(...xs), y1 = Math.min(...ys), x2 = Math.max(...xs), y2 = Math.max(...ys);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function rectFromPoints(a: CalibrationPoint, b: CalibrationPoint): CalibrationRect {
  const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y), x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
  return { x: x1, y: y1, width: Math.max(0.02, x2 - x1), height: Math.max(0.02, y2 - y1) };
}

function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function PhaseIcon({ phase }: { phase: RobotPhase }) {
  switch (phase) {
    case "reading":
    case "opening":
    case "testing":
      return <Loader2 className="h-5 w-5 animate-spin" />;
    case "advancing":
      return <Disc className="h-5 w-5 animate-spin" />;
    case "awaiting-user":
      return <HelpCircle className="h-5 w-5" />;
    case "done":
      return <Check className="h-5 w-5" />;
    case "paused":
      return <Pause className="h-5 w-5" />;
    case "error":
      return <AlertTriangle className="h-5 w-5" />;
    default:
      return <Music2 className="h-5 w-5" />;
  }
}

function phaseLabel(phase: RobotPhase): string {
  switch (phase) {
    case "opening": return "Ouverture de DiscDJ…";
    case "reading": return "Lecture du BPM…";
    case "advancing": return "Passage au morceau suivant…";
    case "testing": return "Test de calibration en cours…";
    case "awaiting-user": return "Choix manuel requis.";
    case "paused": return "En pause — reprise possible à tout moment.";
    case "done": return "Toutes les pistes de cette session ont été traitées.";
    case "error": return "Blocage détecté — voir Diagnostic.";
    default: return "Prêt à démarrer.";
  }
}

function DeckSheet({ value, onChange, onClose, onConfirm }: { value: DeckId; onChange: (d: DeckId) => void; onClose: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-50 flex flex-col justify-end bg-background/70 backdrop-blur-sm" onClick={onClose}><div onClick={(e) => e.stopPropagation()} className="animate-fade-up rounded-t-2xl border-t border-border bg-surface px-4 pb-8 pt-4 shadow-2xl"><div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border-strong" /><h3 className="mb-1 font-display text-sm font-semibold">Sur quelle platine se jouent les morceaux ?</h3><p className="mb-4 text-[11px] text-muted-foreground">Le robot utilisera uniquement les points calibrés pour cette platine.</p><div className="grid grid-cols-2 gap-2">{[1, 2].map((d) => { const deck = d as DeckId; const active = value === deck; return <button key={deck} onClick={() => onChange(deck)} className={`flex flex-col items-center gap-1 rounded-xl border py-4 transition-colors ${active ? "border-primary/50 bg-accent/40 text-foreground" : "border-border bg-background text-muted-foreground hover:border-border-strong"}`}><Disc className={`h-6 w-6 ${active ? "text-primary" : ""}`} /><span className="text-sm font-semibold">Platine {deck}</span></button>; })}</div><button onClick={onConfirm} className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition-transform active:scale-[0.99]"><Play className="h-4 w-4" />Lancer sur la platine {value}</button></div></div>;
}

/**
 * List missing calibration elements that must exist before AutoSync can start.
 * When the analysis mode is `autosync-name` this includes the playlist/back
 * buttons and the per-deck name-zone rectangle. Otherwise only the deck
 * Next/BPM calibration is required.
 */
function missingCalibrationForStart(settings: DiscDJRobotSettings, deck: DeckId): string[] {
  const missing: string[] = [];
  const cal = settings.calibration;
  if (!(deck === 1 ? cal.nextDeck1 : cal.nextDeck2)) missing.push(`bouton Next platine ${deck}`);
  if (!(deck === 1 ? cal.bpmDeck1 : cal.bpmDeck2)) missing.push(`zone BPM platine ${deck}`);
  if (settings.analysisMode === "autosync-name") {
    if (!cal.playlistButton) missing.push("bouton Playlist");
    if (!cal.backButton) missing.push("bouton Retour");
    if (!(deck === 1 ? cal.playlistZoneDeck1 : cal.playlistZoneDeck2)) missing.push(`zone Nom du morceau platine ${deck}`);
  }
  return missing;
}
