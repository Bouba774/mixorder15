/**
 * TempoKey / MixOrder — Key analysis engine (public types).
 *
 * This module is the OFFICIAL and only musical analysis engine of the app.
 * Today it computes:
 *   • Key (tonic + mode)
 *   • Camelot notation
 *   • Confidence + verification status
 *
 * The architecture is deliberately extensible: future descriptors (Energy,
 * Danceability, Mood, Loudness, Musical Color, Dynamic Range, Intro/Outro,
 * Hot cues, …) plug in by extending `TrackDescriptors` and adding stages
 * to the pipeline in `engine.ts`. No new engine should ever be created in
 * parallel — everything routes through this one.
 */

export const ENGINE_VERSION = "3.0.0-ensemble-learn";

export type EngineId = "essentia" | "libkeyfinder" | "hybrid";

/** Verification / confidence tiers surfaced to the UI. */
export type ConfidenceLevel = "high" | "medium" | "low" | "review";

export interface KeyResult {
  /** Musical notation, e.g. "C", "F#", "Am", "Bbm". */
  key: string;
  /** Camelot wheel notation, e.g. "8B", "5A". */
  camelot: string | null;
  /** 0..1 raw correlation strength (best key / margin over runner-up). */
  score: number;
}

export interface EngineOutput extends KeyResult {
  engine: EngineId;
  /** ms taken by this engine only. */
  durationMs: number;
}

export interface HybridOutput {
  primary: EngineOutput;
  verifier?: EngineOutput;
  /** Final decided key after hybrid arbitration. */
  key: string;
  camelot: string | null;
  confidence: ConfidenceLevel;
  /** 0..1 normalized confidence used for sorting / UI badges. */
  confidenceScore: number;
  /** True when the two engines disagreed and manual verification is advised. */
  needsReview: boolean;
  totalDurationMs: number;
  engineVersion: string;
  analyzedAt: number;
  /** Secondary key when the track changes tonality mid-way. */
  alternateKey?: string;
  /** Per-segment detections (in order) — used by the UI to show key changes. */
  segmentKeys?: Array<{ key: string; confidence: number }>;
  /** Post-correction note (5th, relative, parallel) if a correction fired. */
  correctionNote?: string;
  /** True when the learned user-correction bias tipped the final decision. */
  learnedBiasApplied?: boolean;
}

/** Persisted per-track descriptors — attached to AnalyzedTrackData. */
export interface KeyAnalysisData {
  key: string;
  camelot: string | null;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  engineVersion: string;
  analyzedAt: number;
  analysisMs: number;
  needsReview?: boolean;
  /** Raw per-engine outputs kept for diagnostics / re-arbitration. */
  engines?: Array<{ engine: EngineId; key: string; score: number }>;
  /** Set when analysis failed — track goes to the "à réanalyser" queue. */
  error?: string;
}

/** Queue entry state — surfaced by engine.subscribe(). */
export type QueueItemStatus =
  | "pending"
  | "analyzing"
  | "done"
  | "error"
  | "skipped";

export interface QueueItem {
  trackId: string;
  path: string;
  name: string;
  status: QueueItemStatus;
  attempts: number;
  lastError?: string | null;
  result?: KeyAnalysisData;
}

export interface EngineStats {
  total: number;
  done: number;
  pending: number;
  errors: number;
  currentTrackName: string | null;
  running: boolean;
  paused: boolean;
  slowMode: boolean;
  /** ms per track — moving average over the last 8 analyses. */
  avgMsPerTrack: number;
  /** Estimated milliseconds remaining. */
  etaMs: number;
  lastAnalyzed: { name: string; key: string; camelot: string | null } | null;
  /** Rolling log — most recent first. */
  log: Array<{
    ts: number;
    level: "info" | "warn" | "error";
    message: string;
  }>;
}

/** Input given to an engine. Kept minimal so future engines can chain. */
export interface EngineInput {
  /** Mono audio samples in [-1, 1], sampled at `sampleRate`. */
  samples: Float32Array;
  sampleRate: number;
}

export interface KeyDetectionEngine {
  readonly id: EngineId;
  readonly label: string;
  detect(input: EngineInput, signal?: AbortSignal): Promise<EngineOutput>;
}