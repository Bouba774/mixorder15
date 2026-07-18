/**
 * Hybrid key detection — v3 "ensemble + learning".
 *
 * Pipeline:
 *   1. Segmented HPCP chroma over the full track (chromagram.ts).
 *   2. For each segment, correlate against 4 profile pairs
 *      (Krumhansl, Temperley, Sha'ath, Bgate). Each profile returns its
 *      best key + margin to runner-up → the segment's own confidence.
 *   3. Weighted vote across segments: weight = segment_confidence²
 *      (low-confidence segments contribute almost nothing).
 *   4. Global chroma acts as a soft prior (2× weight) — captures the
 *      overall harmonic centre for consistent-key tracks.
 *   5. Post-correction against three canonical errors: perfect fifth,
 *      relative major/minor, parallel major/minor.
 *   6. Learned-bias layer: user corrections nudge close calls toward
 *      keys the user has historically preferred for that detected key.
 *   7. Deep re-analysis on low confidence: keep the segments most
 *      consistent with the global centre and re-vote.
 *   8. Detect key-changing tracks: if the runner-up carries ≥45% of the
 *      total voting mass, expose it as `alternateKey`.
 */

import { toCamelot } from "@/lib/library/camelot";
import { chromagram } from "./chromagram";
import type { SegmentedChroma } from "./chromagram";
import {
  KRUMHANSL_MAJOR, KRUMHANSL_MINOR,
  TEMPERLEY_MAJOR, TEMPERLEY_MINOR,
  correlateProfiles, noteName,
} from "./profiles";
import { biasFor } from "./corrections";
import { essentiaEngine } from "./engines/essentia";
import { libKeyFinderEngine } from "./engines/libkeyfinder";
import { ENGINE_VERSION } from "./types";
import type { EngineInput, EngineOutput, HybridOutput, ConfidenceLevel } from "./types";

// Sha'ath (KeyFinder) profiles — tuned on electronic music.
const SHAATH_MAJOR = [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4];
const SHAATH_MINOR = [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.0, 4.0, 2.7, 3.4, 3.2];

// Bgate (Bellman-Klapuri gate).
const BGATE_MAJOR = [1.0, 0.10, 0.42, 0.10, 0.58, 0.48, 0.10, 0.63, 0.10, 0.44, 0.10, 0.36];
const BGATE_MINOR = [1.0, 0.10, 0.42, 0.60, 0.10, 0.48, 0.10, 0.63, 0.44, 0.10, 0.36, 0.30];

const PROFILES: Array<{ name: string; maj: number[]; min: number[] }> = [
  { name: "krumhansl", maj: KRUMHANSL_MAJOR, min: KRUMHANSL_MINOR },
  { name: "temperley", maj: TEMPERLEY_MAJOR, min: TEMPERLEY_MINOR },
  { name: "shaath",    maj: SHAATH_MAJOR,    min: SHAATH_MINOR    },
  { name: "bgate",     maj: BGATE_MAJOR,     min: BGATE_MINOR     },
];

const HIGH_CONFIDENCE = 0.62;
const REVIEW_CONFIDENCE = 0.32;

const NOTE_INDEX: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

interface ParsedKey { root: number; minor: boolean }
function parseKey(k: string): ParsedKey {
  const minor = /m$/.test(k);
  const root = k.replace(/m$/, "");
  return { root: NOTE_INDEX[root] ?? 0, minor };
}
function formatKey(p: ParsedKey): string { return noteName(p.root, p.minor); }
function keyToIdx24(k: string): number {
  const p = parseKey(k); return p.root * 2 + (p.minor ? 1 : 0);
}

/**
 * Detect a single-vector key + its own confidence.
 * Confidence = max profile score × max margin over #2 across profiles.
 */
function detectVector(chroma: Float32Array): { key: string; runner: string; confidence: number } {
  const scores = new Map<string, number>();
  const margins = new Map<string, number>();
  for (const p of PROFILES) {
    const { best, second } = correlateProfiles(chroma, p.maj, p.min);
    const margin = Math.max(0, best.score - second.score);
    const w = Math.max(0, best.score) * 0.5 + margin * 3;
    scores.set(best.key, (scores.get(best.key) ?? 0) + w);
    margins.set(best.key, Math.max(margins.get(best.key) ?? 0, margin));
  }
  let bestKey = "C", bestScore = -Infinity;
  let secondKey = "C", secondScore = -Infinity;
  for (const [k, s] of scores) {
    if (s > bestScore) {
      secondKey = bestKey; secondScore = bestScore;
      bestKey = k; bestScore = s;
    } else if (s > secondScore) { secondKey = k; secondScore = s; }
  }
  const total = Array.from(scores.values()).reduce((a, b) => a + b, 0);
  const rel = total > 0 ? bestScore / total : 0;
  const margin = margins.get(bestKey) ?? 0;
  // Confidence blends "share of votes" and "profile margin".
  const confidence = Math.max(0, Math.min(1, 0.6 * rel + 2.0 * margin));
  return { key: bestKey, runner: secondKey, confidence };
}

/** Post-correction against tonic/3rd/5th energies in the global chroma. */
function postCorrect(key: string, chroma: Float32Array): { key: string; note?: string } {
  const p = parseKey(key);
  const tonic = chroma[p.root];
  const fifth = chroma[(p.root + 7) % 12];
  const relRoot = p.minor ? (p.root + 3) % 12 : (p.root + 9) % 12;
  const rel = chroma[relRoot];
  const majThird = chroma[(p.root + 4) % 12];
  const minThird = chroma[(p.root + 3) % 12];

  if (fifth > tonic * 1.35) {
    return { key: formatKey({ root: (p.root + 7) % 12, minor: p.minor }), note: "5th-corrected" };
  }
  if (rel > tonic * 1.20) {
    if (p.minor && majThird > minThird * 1.10) {
      return { key: formatKey({ root: relRoot, minor: false }), note: "relative-major" };
    }
    if (!p.minor && minThird > majThird * 1.10) {
      return { key: formatKey({ root: relRoot, minor: true }), note: "relative-minor" };
    }
  }
  if (p.minor && majThird > minThird * 1.25) {
    return { key: formatKey({ root: p.root, minor: false }), note: "parallel-major" };
  }
  if (!p.minor && minThird > majThird * 1.25) {
    return { key: formatKey({ root: p.root, minor: true }), note: "parallel-minor" };
  }
  return { key };
}

interface Aggregate {
  key: string;
  runnerUp: string;
  confidenceScore: number;
  runnerUpMass: number;
  votes: Map<string, number>;
  segmentKeys: Array<{ key: string; confidence: number }>;
}

/** Weighted aggregation across segments + global prior. */
function aggregate(segChroma: SegmentedChroma): Aggregate {
  const votes = new Map<string, number>();
  const segmentKeys: Array<{ key: string; confidence: number }> = [];
  for (const seg of segChroma.segments) {
    const v = detectVector(seg);
    segmentKeys.push({ key: v.key, confidence: v.confidence });
    // Weight = confidence² — low-confidence segments barely count.
    const w = Math.max(0.01, v.confidence * v.confidence);
    votes.set(v.key, (votes.get(v.key) ?? 0) + w);
  }
  // Global chroma as strong prior.
  const g = detectVector(segChroma.global);
  const gw = Math.max(0.05, g.confidence * g.confidence) * 2.5;
  votes.set(g.key, (votes.get(g.key) ?? 0) + gw);

  let best = "C", bestScore = -Infinity;
  let second = "C", secondScore = -Infinity;
  for (const [k, s] of votes) {
    if (s > bestScore) {
      second = best; secondScore = bestScore;
      best = k; bestScore = s;
    } else if (s > secondScore) { second = k; secondScore = s; }
  }
  const total = Array.from(votes.values()).reduce((a, b) => a + b, 0);
  const confidenceScore = total > 0 ? Math.min(1, (bestScore / total) * 1.6) : 0;
  const runnerUpMass = total > 0 ? secondScore / total : 0;
  return { key: best, runnerUp: second, confidenceScore, runnerUpMass, votes, segmentKeys };
}

/** Apply learned corrections to a close vote — only tips ambiguous calls. */
function applyLearnedBias(agg: Aggregate): { agg: Aggregate; applied: boolean } {
  if (agg.confidenceScore >= HIGH_CONFIDENCE) return { agg, applied: false };
  const bias = biasFor(agg.key);
  let anyNonZero = false;
  for (let i = 0; i < 24; i++) if (bias[i] > 0) { anyNonZero = true; break; }
  if (!anyNonZero) return { agg, applied: false };

  // Only redistribute among keys already receiving votes.
  const newVotes = new Map(agg.votes);
  const total = Array.from(newVotes.values()).reduce((a, b) => a + b, 0);
  for (const [k, s] of newVotes) {
    const idx = keyToIdx24(k);
    if (bias[idx] > 0) newVotes.set(k, s + bias[idx] * total);
  }
  let best = "C", bestScore = -Infinity;
  let second = "C", secondScore = -Infinity;
  for (const [k, s] of newVotes) {
    if (s > bestScore) {
      second = best; secondScore = bestScore;
      best = k; bestScore = s;
    } else if (s > secondScore) { second = k; secondScore = s; }
  }
  if (best === agg.key) return { agg, applied: false };
  const newTotal = Array.from(newVotes.values()).reduce((a, b) => a + b, 0);
  return {
    agg: {
      ...agg,
      key: best,
      runnerUp: second,
      confidenceScore: Math.min(1, (bestScore / newTotal) * 1.6),
      runnerUpMass: newTotal > 0 ? secondScore / newTotal : 0,
      votes: newVotes,
    },
    applied: true,
  };
}

function toConfidenceLevel(score: number, needsReview: boolean): ConfidenceLevel {
  if (needsReview) return "review";
  if (score >= HIGH_CONFIDENCE) return "high";
  if (score >= REVIEW_CONFIDENCE) return "medium";
  return "low";
}

export async function detectKeyHybrid(
  input: EngineInput,
  signal?: AbortSignal,
): Promise<HybridOutput> {
  const t0 = performance.now();

  // Pass 1 — segmented chroma over the whole track.
  let chroma = await chromagram(input.samples, signal);
  let agg = aggregate(chroma);

  // Pass 2 (deep) — if confidence is low or the runner-up is close, keep
  // only segments most consistent with the global centre and re-vote.
  const contested = agg.runnerUpMass > 0.25 && agg.confidenceScore < HIGH_CONFIDENCE;
  if ((agg.confidenceScore < HIGH_CONFIDENCE || contested) && chroma.segments.length > 3) {
    const globalArr = Array.from(chroma.global);
    const scored = chroma.segments.map((s) => {
      let d = 0;
      for (let i = 0; i < 12; i++) d += Math.abs(s[i] - globalArr[i]);
      return { s, d };
    }).sort((a, b) => a.d - b.d);
    const keep = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.7)));
    const merged = new Float32Array(12);
    for (const { s } of keep) for (let i = 0; i < 12; i++) merged[i] += s[i];
    let sum = 0; for (let i = 0; i < 12; i++) sum += merged[i];
    if (sum > 0) for (let i = 0; i < 12; i++) merged[i] /= sum;
    chroma = { ...chroma, segments: keep.map(k => k.s), global: merged };
    agg = aggregate(chroma);
  }

  // Learned-bias pass (only tips close calls).
  const biased = applyLearnedBias(agg);
  agg = biased.agg;

  // Post-correction against the global chroma.
  const corrected = postCorrect(agg.key, chroma.global);
  const finalKey = corrected.key;

  // Key-change detection: the runner-up is a legitimate secondary key if
  // it carries a substantial share of the voting mass.
  const alternateKey =
    agg.runnerUpMass >= 0.30 && agg.runnerUp !== finalKey ? agg.runnerUp : undefined;

  const primary: EngineOutput = {
    engine: "essentia",
    key: agg.key,
    camelot: toCamelot(agg.key),
    score: agg.confidenceScore,
    durationMs: performance.now() - t0,
  };
  const verifier: EngineOutput | undefined = agg.runnerUp !== agg.key
    ? {
        engine: "libkeyfinder",
        key: agg.runnerUp,
        camelot: toCamelot(agg.runnerUp),
        score: agg.runnerUpMass,
        durationMs: 0,
      }
    : undefined;

  let confidenceScore = agg.confidenceScore;
  if (corrected.note) confidenceScore = Math.min(confidenceScore, 0.55);
  if (biased.applied) confidenceScore = Math.min(confidenceScore, 0.60);

  const needsReview = confidenceScore < REVIEW_CONFIDENCE;
  const confidence = toConfidenceLevel(confidenceScore, needsReview);

  // Keep standalone engines referenced (public registry, tests, future modes).
  void essentiaEngine; void libKeyFinderEngine;

  return {
    primary,
    verifier,
    key: finalKey,
    camelot: toCamelot(finalKey),
    confidence,
    confidenceScore,
    needsReview,
    totalDurationMs: performance.now() - t0,
    engineVersion: ENGINE_VERSION,
    analyzedAt: Date.now(),
    alternateKey,
    segmentKeys: agg.segmentKeys,
    correctionNote: corrected.note,
    learnedBiasApplied: biased.applied,
  };
}
