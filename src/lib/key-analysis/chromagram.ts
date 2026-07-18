/**
 * Chromagram extraction — audio → 12-D pitch class vector(s).
 *
 * v2 improvements (2026-07):
 *   • Higher-resolution front-end (22050 Hz / 8192-point FFT) → clean
 *     bass resolution, no more octave folding errors on low notes.
 *   • Log-frequency binning over MIDI 24..108 (C1..C8) with a harmonic
 *     product (H=1..4) so pitched content dominates over broadband noise.
 *   • Percussive-frame rejection via spectral flatness — kick/snare
 *     transients no longer bias the tonal profile.
 *   • Segmented output: returns one chroma vector per ~8 s segment PLUS
 *     the global average, so the hybrid stage can vote across the track
 *     and detect key changes / dominant key.
 *
 * This is now on par with the front-end used by KeyFinder / Mixed-In-Key:
 *   decode → mono → resample → HPCP-style harmonic chroma → normalize.
 */

import FFTLib from "fft.js";

const TARGET_SR = 22050;
const FFT_SIZE = 8192;
const HOP = 4096;
/** Analyze pitches from C1 (32.7 Hz) to C8 (4186 Hz). */
const MIN_MIDI = 24;
const MAX_MIDI = 108;
/** Number of harmonics summed into the HPCP-like chroma. */
const HARMONICS = 4;
/** Weight per harmonic (1/h) — fundamental dominates but overtones support. */
const HARMONIC_WEIGHTS = Array.from({ length: HARMONICS }, (_, h) => 1 / (h + 1));
/** Segment length (~ 8 s) — enough to capture a full harmonic phrase. */
const SEGMENT_FRAMES = Math.max(1, Math.round((8 * TARGET_SR) / HOP));
/** Reject frames whose spectral flatness exceeds this (broadband/noisy). */
const FLATNESS_THRESHOLD = 0.35;

export interface SegmentedChroma {
  /** Global mean chroma over kept (tonal) frames — L1 normalized. */
  global: Float32Array;
  /** Per-segment mean chroma — L1 normalized. */
  segments: Float32Array[];
  /** Total frames processed / kept (diagnostics). */
  framesTotal: number;
  framesKept: number;
}

/** Cheap linear resampler — accurate enough for chroma. */
function resampleLinear(input: Float32Array, srcSr: number, dstSr: number): Float32Array {
  if (srcSr === dstSr) return input;
  const ratio = srcSr / dstSr;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const t = x - i0;
    out[i] = input[i0] * (1 - t) + (input[i0 + 1] ?? input[i0]) * t;
  }
  return out;
}

function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = 0.5 * (l[i] + r[i]);
  return out;
}

/** Precomputed Hann window. */
const hann = (() => {
  const w = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  }
  return w;
})();

/**
 * For every MIDI note n in [MIN_MIDI..MAX_MIDI], precompute the list of
 * FFT bins (and their gain) contributing to that note across HARMONICS.
 * A note's fundamental at freq f_n is a triangular window of ±0.5 semitone
 * around the target bin for h=1; the h-th harmonic looks up bin at h*f_n.
 *
 * This is the HPCP idea (Gómez 2006) simplified: log-frequency binning
 * with harmonic aggregation → chroma folding.
 */
interface NoteBin { bin: number; gain: number }
const noteToBins: NoteBin[][] = (() => {
  const table: NoteBin[][] = [];
  const nyquist = TARGET_SR / 2;
  const binHz = TARGET_SR / FFT_SIZE;
  for (let n = MIN_MIDI; n <= MAX_MIDI; n++) {
    const f0 = 440 * Math.pow(2, (n - 69) / 12);
    const bins: NoteBin[] = [];
    for (let h = 0; h < HARMONICS; h++) {
      const fh = f0 * (h + 1);
      if (fh >= nyquist) break;
      const centerBin = fh / binHz;
      const semitoneBW = fh * (Math.pow(2, 1 / 24) - Math.pow(2, -1 / 24)); // ±0.5 semitone in Hz
      const binBW = Math.max(1, semitoneBW / binHz);
      const kMin = Math.max(1, Math.floor(centerBin - binBW));
      const kMax = Math.min(FFT_SIZE / 2 - 1, Math.ceil(centerBin + binBW));
      for (let k = kMin; k <= kMax; k++) {
        const d = Math.abs(k - centerBin) / binBW;
        if (d >= 1) continue;
        // Triangular kernel × harmonic weight.
        bins.push({ bin: k, gain: (1 - d) * HARMONIC_WEIGHTS[h] });
      }
    }
    table.push(bins);
  }
  return table;
})();

/**
 * Fetch the audio file and decode it with WebAudio.
 */
export async function decodeToMono(url: string, signal?: AbortSignal): Promise<{
  samples: Float32Array;
  sampleRate: number;
}> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  const AC: typeof AudioContext =
    (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext!;
  if (!AC) throw new Error("WebAudio unavailable");
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const mono = toMono(decoded);
    const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_SR);
    return { samples: resampled, sampleRate: TARGET_SR };
  } finally {
    try { await ctx.close(); } catch { /* Safari sometimes throws */ }
  }
}

/**
 * Spectral flatness — geomean/arithmean over the mid-band magnitudes.
 * High (≈1) = white-noise-like (percussive/hi-hats); low (≈0) = tonal.
 */
function spectralFlatness(mags: Float32Array, kMin: number, kMax: number): number {
  let sumLog = 0, sum = 0, n = 0;
  for (let k = kMin; k <= kMax; k++) {
    const m = mags[k] + 1e-12;
    sumLog += Math.log(m);
    sum += m;
    n++;
  }
  if (n === 0 || sum === 0) return 1;
  const geo = Math.exp(sumLog / n);
  const arith = sum / n;
  return geo / arith;
}

function l1Normalize(v: Float32Array): void {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  if (s > 0) for (let i = 0; i < v.length; i++) v[i] /= s;
}

/**
 * Compute a segmented chromagram for the full track. Percussive frames
 * are filtered out; harmonics are summed HPCP-style; per-segment
 * averages plus the global average are returned.
 */
export async function chromagram(
  samples: Float32Array,
  signal?: AbortSignal,
): Promise<SegmentedChroma> {
  const fft = new FFTLib(FFT_SIZE);
  const complex = fft.createComplexArray();
  const frame = new Float32Array(FFT_SIZE);
  const mags = new Float32Array(FFT_SIZE / 2);

  const global = new Float32Array(12);
  const segments: Float32Array[] = [];
  let seg = new Float32Array(12);
  let segFrames = 0;
  let framesTotal = 0;
  let framesKept = 0;
  let winCount = 0;

  // Flatness measured over ~ MIDI 30..96 range where tonal energy lives.
  const flatKMin = Math.max(1, Math.floor((30 * TARGET_SR) / FFT_SIZE / 100));
  const flatKMax = Math.min(FFT_SIZE / 2 - 1, Math.floor(4000 / (TARGET_SR / FFT_SIZE)));

  for (let start = 0; start + FFT_SIZE <= samples.length; start += HOP) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    framesTotal++;

    for (let i = 0; i < FFT_SIZE; i++) frame[i] = samples[start + i] * hann[i];
    fft.realTransform(complex, frame);

    // Magnitudes
    let peakMag = 0;
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const re = complex[2 * k];
      const im = complex[2 * k + 1];
      const m = Math.sqrt(re * re + im * im);
      mags[k] = m;
      if (m > peakMag) peakMag = m;
    }

    const isPercussive =
      peakMag > 0 && spectralFlatness(mags, flatKMin, flatKMax) > FLATNESS_THRESHOLD;

    if (!isPercussive && peakMag > 0) {
      framesKept++;
      // Aggregate energy per MIDI note, then fold to chroma.
      const noteEnergy = new Float32Array(MAX_MIDI - MIN_MIDI + 1);
      for (let n = 0; n < noteEnergy.length; n++) {
        const bins = noteToBins[n];
        let e = 0;
        for (let b = 0; b < bins.length; b++) e += bins[b].gain * mags[bins[b].bin];
        noteEnergy[n] = e;
      }
      // Log-compression to tame very loud partials.
      for (let n = 0; n < noteEnergy.length; n++) {
        noteEnergy[n] = Math.log1p(noteEnergy[n]);
      }
      for (let n = 0; n < noteEnergy.length; n++) {
        const pc = ((MIN_MIDI + n) % 12 + 12) % 12;
        seg[pc] += noteEnergy[n];
        global[pc] += noteEnergy[n];
      }
    }

    segFrames++;
    if (segFrames >= SEGMENT_FRAMES) {
      l1Normalize(seg);
      // Only keep segments with meaningful tonal content.
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += seg[i];
      if (sum > 0) segments.push(seg);
      seg = new Float32Array(12);
      segFrames = 0;
    }

    winCount++;
    if ((winCount & 0x7f) === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Flush tail segment if it has enough content.
  if (segFrames > SEGMENT_FRAMES / 3) {
    let sum = 0; for (let i = 0; i < 12; i++) sum += seg[i];
    if (sum > 0) { l1Normalize(seg); segments.push(seg); }
  }
  l1Normalize(global);

  return { global, segments, framesTotal, framesKept };
}
