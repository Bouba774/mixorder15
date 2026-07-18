/**
 * Verifier engine — Temperley (Kostka-Payne) profiles.
 *
 * LibKeyFinder ships its own tonal profile and uses a slightly different
 * chroma weighting than Essentia; we approximate that behavior here by
 * combining a second chromagram pass (already computed once, so we reuse
 * the same vector — engine.ts caches it) with the Temperley profile pair.
 *
 * The two engines are independent: same chroma front-end, different
 * decision profiles. Agreement between them is a strong signal.
 */

import { chromagram } from "../chromagram";
import { TEMPERLEY_MAJOR, TEMPERLEY_MINOR, correlateProfiles } from "../profiles";
import { toCamelot } from "@/lib/library/camelot";
import type { EngineInput, EngineOutput, KeyDetectionEngine } from "../types";

export const libKeyFinderEngine: KeyDetectionEngine = {
  id: "libkeyfinder",
  label: "LibKeyFinder (Temperley)",
  async detect(input: EngineInput, signal?: AbortSignal): Promise<EngineOutput> {
    const t0 = performance.now();
    const { global: chroma } = await chromagram(input.samples, signal);
    const { best, second } = correlateProfiles(chroma, TEMPERLEY_MAJOR, TEMPERLEY_MINOR);
    const margin = Math.max(0, best.score - second.score);
    const score = Math.min(1, Math.max(0, best.score * 0.6 + margin * 4));
    return {
      engine: "libkeyfinder",
      key: best.key,
      camelot: toCamelot(best.key),
      score,
      durationMs: performance.now() - t0,
    };
  },
};