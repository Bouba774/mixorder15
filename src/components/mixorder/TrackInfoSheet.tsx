import { useEffect, useMemo, useState } from "react";
import {
  X,
  Copy,
  FolderOpen,
  RotateCcw,
  Sparkles,
  Check,
  Music4,
  History,
} from "lucide-react";
import { formatDuration, useWorkspace, type Track } from "@/lib/workspace-context";
import { toCamelot } from "@/lib/library/camelot";
import { recordCorrection, clearOverride } from "@/lib/key-analysis/corrections";

/**
 * TrackInfoSheet — bottom sheet showing full metadata for a single track,
 * with inline BPM and musical-key editing plus quick actions.
 *
 * Every edit routes through `useWorkspace().setTrackAnalysis`, which
 * persists the change to the project snapshot and mirrors it across the
 * app instantly.
 */

const MUSICAL_KEYS: string[] = [
  // Major (Camelot B)
  "C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F",
  // Minor (Camelot A)
  "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "Bbm", "Fm", "Cm", "Gm", "Dm",
];

const BPM_MIN = 40;
const BPM_MAX = 220;

export interface TrackInfoSheetProps {
  trackId: string | null;
  onClose: () => void;
}

export function TrackInfoSheet({ trackId, onClose }: TrackInfoSheetProps) {
  const { project, setTrackAnalysis } = useWorkspace();
  const track = useMemo<Track | null>(
    () => project?.tracks.find((t) => t.id === trackId) ?? null,
    [project, trackId],
  );

  const open = trackId != null && track != null;

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Close on ESC.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-[60] ${open ? "" : "pointer-events-none"}`}
    >
      {/* Scrim */}
      <button
        type="button"
        aria-label="Fermer"
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Informations du morceau"
        className={`absolute inset-x-0 bottom-0 max-h-[92dvh] transform overflow-hidden rounded-t-3xl border-t border-border bg-surface shadow-2xl transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {track && <SheetBody track={track} onClose={onClose} setTrackAnalysis={setTrackAnalysis} />}
      </div>
    </div>
  );
}

function SheetBody({
  track,
  onClose,
  setTrackAnalysis,
}: {
  track: Track;
  onClose: () => void;
  setTrackAnalysis: ReturnType<typeof useWorkspace>["setTrackAnalysis"];
}) {
  const [bpmDraft, setBpmDraft] = useState<string>(
    track.bpm != null ? String(Math.round(track.bpm)) : "",
  );
  const [flash, setFlash] = useState<string | null>(null);

  // Sync draft when switching tracks.
  useEffect(() => {
    setBpmDraft(track.bpm != null ? String(Math.round(track.bpm)) : "");
  }, [track.id, track.bpm]);

  const commitBpm = () => {
    const trimmed = bpmDraft.trim();
    if (trimmed === "") {
      setTrackAnalysis(track.id, { bpm: null }, "manual-discdj");
      return;
    }
    const parsed = Math.round(Number(trimmed));
    if (!Number.isFinite(parsed) || parsed < BPM_MIN || parsed > BPM_MAX) {
      setBpmDraft(track.bpm != null ? String(Math.round(track.bpm)) : "");
      setFlash(`BPM invalide (${BPM_MIN}–${BPM_MAX})`);
      return;
    }
    if (parsed !== Math.round(track.bpm ?? -1)) {
      setTrackAnalysis(track.id, { bpm: parsed }, "manual-discdj");
      quickFlash(setFlash, "BPM enregistré");
    }
  };

  const onKeyChange = (nextKey: string) => {
    setTrackAnalysis(track.id, { musicalKey: nextKey || null }, "manual-discdj");
    recordCorrection(track.id, nextKey || null, track.musicalKey ?? null);
    quickFlash(setFlash, "Tonalité enregistrée");
  };

  const resetBpm = () => {
    setTrackAnalysis(track.id, { bpm: null }, "manual-discdj");
    quickFlash(setFlash, "BPM réinitialisé");
  };
  const resetKey = () => {
    setTrackAnalysis(track.id, { musicalKey: null }, "manual-discdj");
    clearOverride(track.id);
    quickFlash(setFlash, "Tonalité réinitialisée");
  };
  const reanalyze = () => {
    setTrackAnalysis(track.id, { bpm: null, musicalKey: null }, "manual-discdj");
    clearOverride(track.id);
    quickFlash(setFlash, "Réanalyse en cours…");
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(track.path);
      quickFlash(setFlash, "Chemin copié");
    } catch {
      quickFlash(setFlash, "Impossible de copier");
    }
  };

  const openFolder = async () => {
    // Best-effort: not all runtimes support opening the containing folder.
    try {
      await navigator.clipboard.writeText(track.path);
      quickFlash(setFlash, "Chemin copié — ouvre-le dans ton gestionnaire de fichiers");
    } catch {
      quickFlash(setFlash, "Action indisponible sur cet appareil");
    }
  };

  const camelot = toCamelot(track.musicalKey);
  const bitrateKbps =
    track.durationSec && track.size
      ? Math.round((track.size * 8) / track.durationSec / 1000)
      : null;
  const sizeMb = track.size ? track.size / (1024 * 1024) : 0;
  const analysisStatus = statusLabel(track);

  return (
    <div className="flex h-full max-h-[92dvh] flex-col">
      {/* Drag handle + header */}
      <div className="shrink-0 pt-2">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-muted-foreground/25" />
        <div className="flex items-start justify-between gap-3 px-5 pb-4 pt-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary/15 text-primary">
              <Music4 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate font-display text-[17px] font-semibold leading-tight text-foreground">
                {track.name}
              </h2>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {analysisStatus}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* Edit block */}
        <Section title="Édition rapide">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                BPM
              </label>
              <input
                type="number"
                inputMode="numeric"
                min={BPM_MIN}
                max={BPM_MAX}
                step={1}
                value={bpmDraft}
                onChange={(e) => setBpmDraft(e.target.value)}
                onBlur={commitBpm}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                placeholder="—"
                className="mt-1.5 h-11 w-full rounded-xl border border-border bg-background px-3 text-[15px] font-semibold tabular-nums text-foreground outline-none transition-colors focus:border-primary"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                Tonalité
              </label>
              <select
                value={track.musicalKey ?? ""}
                onChange={(e) => onKeyChange(e.target.value)}
                className="mt-1.5 h-11 w-full appearance-none rounded-xl border border-border bg-background px-3 text-[15px] font-semibold text-foreground outline-none transition-colors focus:border-primary"
              >
                <option value="">—</option>
                {MUSICAL_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k} {toCamelot(k) ? `· ${toCamelot(k)}` : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            Notation Camelot :{" "}
            <span className="font-semibold text-foreground">{camelot ?? "—"}</span>
            {" · "}Enregistrement instantané dans la bibliothèque.
          </p>
          {flash && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-primary">
              <Check className="h-3.5 w-3.5" />
              {flash}
            </p>
          )}
        </Section>

        {/* Metadata */}
        <Section title="Fichier">
          <Row label="Nom du fichier" value={track.originalName} mono />
          <Row label="Nom affiché" value={track.name} />
          <Row label="Format" value={track.extension ? track.extension.toUpperCase() : "—"} />
          <Row label="MIME" value={track.mimeType || "—"} />
          <Row
            label="Taille"
            value={track.size ? `${sizeMb.toFixed(2)} MB` : "—"}
          />
          <Row
            label="Débit estimé"
            value={bitrateKbps ? `${bitrateKbps} kbps` : "—"}
          />
          <Row label="Fréquence" value="—" hint="Non détectée sur ce fichier" />
          <Row label="Chemin" value={track.path} mono wrap />
        </Section>

        <Section title="Analyse">
          <Row label="Durée" value={formatDuration(track.durationSec)} />
          <Row
            label="BPM"
            value={track.bpm != null ? `${Math.round(track.bpm)} BPM` : "—"}
          />
          <Row label="Tonalité" value={track.musicalKey ?? "—"} />
          <Row label="Camelot" value={camelot ?? "—"} />
          <Row label="Statut" value={analysisStatus} />
        </Section>

        <Section title="Dates">
          <Row label="Ajouté le" value={formatDate(track.addedAt)} />
          <Row label="Modifié le" value={formatDate(track.modifiedAt)} />
        </Section>

        {track.renameHistory.length > 0 && (
          <Section
            title="Historique des renommages"
            icon={<History className="h-3.5 w-3.5" />}
          >
            <ul className="space-y-1.5">
              {track.renameHistory.slice(-6).reverse().map((h, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-border bg-background/50 px-3 py-2 text-[12px]"
                >
                  <p className="truncate text-muted-foreground">
                    <span className="line-through">{h.from}</span>
                  </p>
                  <p className="truncate font-medium text-foreground">→ {h.to}</p>
                  <p className="mt-0.5 text-[10.5px] text-muted-foreground/70">
                    {formatDate(h.at)}
                  </p>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Quick actions */}
        <Section title="Actions">
          <div className="grid grid-cols-2 gap-2">
            <ActionButton icon={Copy} label="Copier le chemin" onClick={copyPath} />
            <ActionButton icon={FolderOpen} label="Ouvrir le dossier" onClick={openFolder} />
            <ActionButton icon={Sparkles} label="Réanalyser" onClick={reanalyze} />
            <ActionButton icon={RotateCcw} label="Reset BPM" onClick={resetBpm} />
            <ActionButton icon={RotateCcw} label="Reset tonalité" onClick={resetKey} />
          </div>
        </Section>
      </div>
    </div>
  );
}

/* ─────────── helpers ─────────── */

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 first:mt-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {icon}
        {title}
      </h3>
      <div className="rounded-2xl border border-border bg-background/40 p-3">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  wrap,
  hint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/40 py-2 last:border-b-0">
      <span className="shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 text-right text-[12.5px] font-medium text-foreground ${
          mono ? "font-mono text-[11.5px]" : ""
        } ${wrap ? "break-all" : "truncate"}`}
        title={value}
      >
        {value}
        {hint && (
          <span className="ml-1 text-[10.5px] font-normal text-muted-foreground">
            ({hint})
          </span>
        )}
      </span>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-xl border border-border bg-background/60 px-3 py-2.5 text-[12.5px] font-medium text-foreground transition-colors hover:border-border-strong hover:bg-surface-elevated active:scale-[0.98]"
    >
      <Icon className="h-4 w-4 text-primary" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function statusLabel(t: Track): string {
  const bits: string[] = [];
  bits.push(t.bpm != null ? "BPM détecté" : "BPM manquant");
  bits.push(t.musicalKey ? "Tonalité détectée" : "Tonalité manquante");
  if (t.analysisStatus === "analyzing") bits.push("Analyse en cours");
  else if (t.analysisStatus === "error") bits.push("Erreur d'analyse");
  return bits.join(" · ");
}

function formatDate(ts: number | undefined | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("fr-FR", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function quickFlash(setter: (s: string | null) => void, msg: string) {
  setter(msg);
  window.setTimeout(() => setter(null), 1800);
}
