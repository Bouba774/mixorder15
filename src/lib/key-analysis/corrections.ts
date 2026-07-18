/**
 * User-correction memory — the "learning" layer of the key engine.
 *
 * Every time the user manually overrides a detected key, we store the pair
 * (detected → corrected) in localStorage. Over time we build a confusion
 * matrix that biases future detections: if the engine consistently confuses
 * C ↔ Am on this user's library (a common relative-minor error), the next
 * time C is a close call against Am, Am wins.
 *
 * Two levels of memory:
 *   • per-track overrides — a manually set key on a specific track always
 *     wins, even after re-analysis (never silently overwrite the user).
 *   • global confusion bias — 12×2 × 12×2 matrix aggregated across
 *     corrections; applied as a small additive score bump to candidates.
 */

const LS_KEY = "mixorder.key-corrections.v1";
const NOTE_INDEX: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

function keyIndex(k: string | null | undefined): number | null {
  if (!k) return null;
  const minor = /m$/.test(k);
  const root = k.replace(/m$/, "");
  const pc = NOTE_INDEX[root];
  if (pc == null) return null;
  return pc * 2 + (minor ? 1 : 0);
}

function indexToKey(i: number): string {
  const pc = Math.floor(i / 2);
  const minor = i % 2 === 1;
  const names = minor
    ? ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]
    : ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return minor ? `${names[pc]}m` : names[pc];
}

interface Store {
  /** trackId → manually set key (never overwritten by auto-analysis). */
  overrides: Record<string, string>;
  /** Flattened 24×24 matrix — counts of (detectedIdx*24 + correctedIdx). */
  confusion: number[];
  /** Total corrections recorded — used to normalize bias weight. */
  total: number;
}

function empty(): Store {
  return { overrides: {}, confusion: new Array(24 * 24).fill(0), total: 0 };
}

function load(): Store {
  if (typeof localStorage === "undefined") return empty();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<Store>;
    const store = empty();
    if (parsed.overrides && typeof parsed.overrides === "object") {
      store.overrides = parsed.overrides as Record<string, string>;
    }
    if (Array.isArray(parsed.confusion) && parsed.confusion.length === 24 * 24) {
      store.confusion = parsed.confusion as number[];
    }
    if (typeof parsed.total === "number") store.total = parsed.total;
    return store;
  } catch {
    return empty();
  }
}

function save(store: Store) {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch { /* quota */ }
}

let cache: Store | null = null;
function state(): Store {
  if (!cache) cache = load();
  return cache;
}

/** Explicit override for a specific track — bypasses auto-analysis. */
export function getOverride(trackId: string): string | null {
  return state().overrides[trackId] ?? null;
}

export function clearOverride(trackId: string): void {
  const s = state();
  if (s.overrides[trackId]) {
    delete s.overrides[trackId];
    save(s);
  }
}

/**
 * Record a manual correction. If the auto-detected key differs from what
 * the user typed, update the confusion matrix so similar future confusions
 * are corrected automatically.
 */
export function recordCorrection(
  trackId: string,
  correctedKey: string | null,
  detectedKey: string | null,
): void {
  const s = state();
  if (!correctedKey) {
    // User cleared → remove override, don't touch confusion.
    if (s.overrides[trackId]) delete s.overrides[trackId];
    save(s);
    return;
  }
  s.overrides[trackId] = correctedKey;
  const di = keyIndex(detectedKey);
  const ci = keyIndex(correctedKey);
  if (di != null && ci != null && di !== ci) {
    s.confusion[di * 24 + ci] += 1;
    s.total += 1;
  }
  save(s);
}

/**
 * Return an additive bias vector (length 24) for a given detected key.
 * Values in [0, 0.15] — small enough that they only tip genuine
 * ambiguities, never override a confident detection.
 */
export function biasFor(detectedKey: string): Float32Array {
  const bias = new Float32Array(24);
  const s = state();
  if (s.total < 3) return bias; // Not enough data — no learning yet.
  const di = keyIndex(detectedKey);
  if (di == null) return bias;
  let rowSum = 0;
  for (let ci = 0; ci < 24; ci++) rowSum += s.confusion[di * 24 + ci];
  if (rowSum < 2) return bias;
  const cap = 0.15;
  for (let ci = 0; ci < 24; ci++) {
    const p = s.confusion[di * 24 + ci] / rowSum;
    // Sqrt so a single confusion gives meaningful (but bounded) pull.
    bias[ci] = Math.min(cap, Math.sqrt(p) * cap);
  }
  // The detected key itself should keep its full baseline weight — the
  // bias only tips the runner-up if the user has consistently corrected
  // this direction. Zero out the diagonal.
  bias[di] = 0;
  return bias;
}

/** Debug helper — surface the current top confusions. */
export function topConfusions(limit = 5): Array<{ from: string; to: string; count: number }> {
  const s = state();
  const list: Array<{ from: string; to: string; count: number }> = [];
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 24; j++) {
      const c = s.confusion[i * 24 + j];
      if (c > 0) list.push({ from: indexToKey(i), to: indexToKey(j), count: c });
    }
  }
  return list.sort((a, b) => b.count - a.count).slice(0, limit);
}
