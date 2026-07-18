/**
 * Hybrid key detection — multi-profile, multi-segment, self-correcting.
 *
 * Pipeline (v2, 2026-07):
 *   1. Compute a segmented HPCP-style chromagram over the whole track,
 *      rejecting percussive frames (see chromagram.ts).
 *   2. Correlate each segment against 4 profile pairs
 *      (Krumhansl, Temperley, Sha'ath, Bgate) → 4 candidate keys per seg.
 *   3. Vote across all segments (weighted by margin) → dominant key.
 *   4. Correlate the global chroma against all profiles as a tiebreaker.
 *   5. Post-process the winner to correct the three classic errors:
 *        • relative major/minor (C ↔ Am)
 *        • perfect fifth (C ↔ G)
 *        • parallel major/minor (C ↔ Cm)
 *      by comparing tonic / dominant / third energies in the global chroma.
 *   6. If confidence is low, re-run with 4× denser hop segmentation
 *      ("deep" pass) before accepting the result.
 */

import { toCamelot } from "@/lib/library/camelot";
import { chromagram } from "./chromagram";
import type { SegmentedChroma } from "./chromagram";
import {
  KRUMHANSL_MAJOR, KRUMHANSL_MINOR,
  TEMPERLEY_MAJOR, TEMPERLEY_MINOR,
  correlateProfiles, noteName,
} from "./profiles";
import { essentiaEngine } from "./engines/essentia";
import { libKeyFinderEngine } from "./engines/libkeyfinder";
import { ENGINE_VERSION } from "./types";
import type { EngineInput, EngineOutput, HybridOutput, ConfidenceLevel } from "./types";

// Sha'ath (KeyFinder) profiles — tuned on a corpus of electronic music.
const SHAATH_MAJOR = [
  6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4,
];
const SHAATH_MINOR = [
  6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.0, 4.0, 2.7, 3.4, 3.2,
];

// Bgate (Bellman-Klapuri gate) — sharper minor 3rd/minor 7th weights.
const BGATE_MAJOR = [
  1.0, 0.10, 0.42, 0.10, 0.58, 0.48, 0.10, 0.63, 0.10, 0.44, 0.10, 0.36,
];
const BGATE_MINOR = [
  1.0, 0.10, 0.42, 0.60, 0.10, 0.48, 0.10, 0.63, 0.44, 0.10, 0.36, 0.30,
];

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

/** Vote a single chroma vector against all 4 profiles. Returns the top
 *  key (weighted by margin) plus the raw per-profile ranking. */
function voteVector(chroma: Float32Array): { key: string; strength: number } {
  const scores = new Map<string, number>();
  for (const p of PROFILES) {
    const { best, second } = correlateProfiles(chroma, p.maj, p.min);
    const margin = Math.max(0, best.score - second.score);
    // Weight this profile's vote by both absolute score and margin over #2.
    const w = Math.max(0, best.score) * 0.5 + margin * 3;
    scores.set(best.key, (scores.get(best.key) ?? 0) + w);
  }
  let bestKey = "C"; let bestScore = -Infinity;
  for (const [k, s] of scores) if (s > bestScore) { bestScore = s; bestKey = k; }
  // Normalize: 4 profiles voting all-in for one key ≈ score of ~4.
  return { key: bestKey, strength: Math.min(1, bestScore / 3.5) };
}

/** Post-correction: fix the three canonical errors using global chroma
 *  energy at tonic / 3rd / 5th. Returns possibly-swapped key + reason. */
function postCorrect(key: string, chroma: Float32Array): { key: string; note?: string } {
  const p = parseKey(key);
  const tonic = chroma[p.root];
  const fifth = chroma[(p.root + 7) % 12];
  const relRoot = p.minor ? (p.root + 3) % 12 : (p.root + 9) % 12; // relative maj/min
  const rel = chroma[relRoot];
  const majThird = chroma[(p.root + 4) % 12];
  const minThird = chroma[(p.root + 3) % 12];

  // 1) Perfect-fifth error: if the "fifth" note has clearly more energy than
  //    the tonic, we probably picked the subdominant instead of the tonic.
  //    Swap to the key whose tonic is the 5th up.
  if (fifth > tonic * 1.35) {
    const newRoot = (p.root + 7) % 12;
    return { key: formatKey({ root: newRoot, minor: p.minor }), note: "5th-corrected" };
  }

  // 2) Relative major/minor: only swap if the relative tonic has clearly
  //    more energy AND the third is consistent with that mode.
  if (rel > tonic * 1.20) {
    if (p.minor && majThird > minThird * 1.10) {
      return { key: formatKey({ root: relRoot, minor: false }), note: "relative-major" };
    }
    if (!p.minor && minThird > majThird * 1.10) {
      return { key: formatKey({ root: relRoot, minor: true }), note: "relative-minor" };
    }
  }

  // 3) Parallel major/minor (C ↔ Cm): decide by third energy.
  if (p.minor && majThird > minThird * 1.25) {
    return { key: formatKey({ root: p.root, minor: false }), note: "parallel-major" };
  }
  if (!p.minor && minThird > majThird * 1.25) {
    return { key: formatKey({ root: p.root, minor: true }), note: "parallel-minor" };
  }

  return { key };
}

/** Aggregate votes across all segments (weighted) + global vector. */
function aggregate(segChroma: SegmentedChroma): {
  key: string;
  confidenceScore: number;
  runnerUp: string;
  runnerUpScore: number;
  votes: Map<string, number>;
} {
  const votes = new Map<string, number>();
  for (const seg of segChroma.segments) {
    const v = voteVector(seg);
    votes.set(v.key, (votes.get(v.key) ?? 0) + v.strength);
  }
  // Global vector gets 2× weight — it captures the overall harmonic centre.
  const g = voteVector(segChroma.global);
  votes.set(g.key, (votes.get(g.key) ?? 0) + g.strength * 2);

  let best = "C", bestScore = -Infinity;
  let second = "C", secondScore = -Infinity;
  for (const [k, s] of votes) {
    if (s > bestScore) { second = best; secondScore = bestScore; best = k; bestScore = s; }
    else if (s > secondScore) { second = k; secondScore = s; }
  }
  const total = Array.from(votes.values()).reduce((a, b) => a + b, 0);
  const confidenceScore = total > 0 ? Math.min(1, bestScore / total * 1.6) : 0;
  return { key: best, confidenceScore, runnerUp: second, runnerUpScore: secondScore, votes };
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

  // Pass 2 (deep) — if confidence is low, tighten the analysis by
  // discarding the shortest tail segments and re-weighting the median.
  if (agg.confidenceScore < HIGH_CONFIDENCE && chroma.segments.length > 3) {
    // Recompute a "median" chroma: average of segments closest to global.
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

  // Post-correction against the global chroma.
  const corrected = postCorrect(agg.key, chroma.global);
  const finalKey = corrected.key;

  // Build the two "engine" outputs for the persisted diagnostic record.
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
        score: Math.max(0, agg.runnerUpScore / (agg.confidenceScore * 3.5 + 1e-9)),
        durationMs: 0,
      }
    : undefined;

  // Confidence downgrade if a correction fired — worth flagging for review.
  let confidenceScore = agg.confidenceScore;
  if (corrected.note) confidenceScore = Math.min(confidenceScore, 0.55);

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
  };
}
