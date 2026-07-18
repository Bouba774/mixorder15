/**
 * Primary engine — Krumhansl-Schmuckler correlation over the chroma vector.
 *
 * Named after Essentia because Essentia's `KeyExtractor` uses the very same
 * algorithm family (chromagram + tonal profile correlation). We implement it
 * natively in TypeScript so the engine ships zero WASM download and works
 * fully offline in the WebView.
 */

import { chromagram } from "../chromagram";
import { KRUMHANSL_MAJOR, KRUMHANSL_MINOR, correlateProfiles } from "../profiles";
import { toCamelot } from "@/lib/library/camelot";
import type { EngineInput, EngineOutput, KeyDetectionEngine } from "../types";

export const essentiaEngine: KeyDetectionEngine = {
  id: "essentia",
  label: "Essentia (Krumhansl)",
  async detect(input: EngineInput, signal?: AbortSignal): Promise<EngineOutput> {
    const t0 = performance.now();
    const { global: chroma } = await chromagram(input.samples, signal);
    const { best, second } = correlateProfiles(chroma, KRUMHANSL_MAJOR, KRUMHANSL_MINOR);
    // Confidence from margin over runner-up, clamped to [0..1].
    const margin = Math.max(0, best.score - second.score);
    const score = Math.min(1, Math.max(0, best.score * 0.65 + margin * 4));
    return {
      engine: "essentia",
      key: best.key,
      camelot: toCamelot(best.key),
      score,
      durationMs: performance.now() - t0,
    };
  },
};