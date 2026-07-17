import { Capacitor } from "@capacitor/core";
import { DiscDJRobot } from "mixorder-discdj-robot";
import { isRectTarget, type CalibrationPoint, type CalibrationRect, type CalibrationTarget } from "./discdj-settings";


/**
 * DiscDJ automation bridge.
 *
 * Abstraction between the analysis robot and whatever channel we use to
 * drive the DiscDJ app on the device. Today the only ready implementation
 * is `simulatedBridge` (useful on web + on Android before the accessibility
 * service is calibrated). The native bridge — which will read the BPM area
 * with OCR and dispatch a tap on the "Next" button using an Android
 * AccessibilityService — plugs in through `registerBridge()` once the user
 * provides the annotated screenshots that pinpoint:
 *   - the BPM display region for deck 1 and deck 2
 *   - the (x, y) coordinates of the "Next" button
 *
 * All future improvements (smarter track matching, error recovery, richer
 * automation) live BEHIND this interface — the robot loop and the UI stay
 * untouched when we swap or upgrade the bridge.
 */

export type DeckId = 1 | 2;

export interface DiscDJReading {
  /** Detected BPM, or null if unreadable / out of plausible range. */
  bpm: number | null;
  /** Title text captured from DiscDJ's deck display (used for matching). */
  title: string | null;
  /** Duration in seconds read from DiscDJ, when available. */
  durationSec: number | null;
  /** Raw string captured before parsing — kept for debugging / calibration. */
  raw?: string;
  /** Every text node detected inside the calibrated BPM zone. */
  zoneTexts?: string[];
  ocrVariants?: string[];
  /** Human explanation when `bpm` is null. */
  parseReason?: string | null;
  /** Advanced BPM parser diagnostics, one item per raw OCR variant. */
  bpmDiagnostics?: BpmParseDiagnostic[];
  /** True when the capture source is confirmed to be DiscDJ, not MixOrder/overlay. */
  sourceOk?: boolean;
  /** True when DiscDJ/capture is confirmed in landscape orientation. */
  orientationOk?: boolean;
  /** Android package captured as the active OCR source. */
  sourcePackage?: string | null;
  /** Full DiscDJ screenshot used for OCR diagnostics. */
  fullScreenshot?: string | null;
  /** Rectangle actually cut from the full DiscDJ screenshot. */
  croppedImage?: string | null;
  /** Image actually transmitted to the OCR engine. */
  ocrInputImage?: string | null;
  /** Absolute OCR crop rectangle in display pixels. */
  ocrRect?: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
  /** Display size used for coordinate conversion. */
  display?: { width: number; height: number } | null;
  /** True when the deck reports no more tracks in the current playlist. */
  endOfPlaylist?: boolean;
}

export interface BpmParseDiagnostic {
  raw: string;
  cleaned: string;
  corrected: string;
  extracted: number | null;
  accepted: boolean;
  reason: string | null;
}

/**
 * Optional hint the robot passes to help simulated / debug bridges. The
 * native bridge ignores it — real BPM/title/duration come from the device.
 */
export interface ReadHint {
  title?: string | null;
  durationSec?: number | null;
  bpmZone?: CalibrationRect | null;
}

export interface TapOptions {
  point?: CalibrationPoint | null;
  pressDurationMs?: number;
}

/** Result of an interactive (in-DiscDJ) calibration capture. */
export interface CaptureResult {
  cancelled?: boolean;
  point?: CalibrationPoint;
  rect?: CalibrationRect;
}

export interface BackgroundRunTrack {
  id: string;
  path: string;
  name: string;
  originalName?: string;
  hasBpm: boolean;
}

export interface BackgroundRunOptions {
  analysisMode?: "auto-sync" | "autosync-name";
  deck: DeckId;
  startIndex: number;
  projectFingerprint: string;
  projectName: string;
  tracks: BackgroundRunTrack[];
  nextPoint: CalibrationPoint | null;
  bpmZone: CalibrationRect | null;
  playlistButton?: CalibrationPoint | null;
  backButton?: CalibrationPoint | null;
  /**
   * AutoSync-name: full playlist list rectangle. The native side scans it
   * for the currently-loaded blue row, isolates that row, and OCRs it.
   */
  playlistZone?: CalibrationRect | null;
  skipAlreadyBpm: boolean;
  replaceExisting: boolean;
  waitOnOpenMs: number;
  waitBeforeReadMs: number;
  waitAfterClickMs: number;
  waitAfterPlaylistOpenMs?: number;
  waitAfterBackMs?: number;
  pressDurationMs: number;
  maxAttempts: number;
  nameMaxOcrRetries?: number;
}

/**
 * AutoSync-name: read of the currently-loaded row inside a calibrated
 * playlist zone. The native side detects the blue "selected row" by pixel
 * analysis, crops it, then runs OCR on that row only.
 */
export interface PlaylistActiveNameReading {
  /** Cleaned/best OCR text for the active row; null when no row detected. */
  name: string | null;
  /** Raw joined OCR text (may include row noise). */
  raw?: string | null;
  /** Every OCR line captured on the isolated active row. */
  zoneTexts?: string[];
  /**
   * Diagnostic reason when `name` is null:
   *  - "no-active-row" : no blue selected row was detected inside the zone.
   *  - "ocr-empty"     : row detected but OCR returned no readable text.
   *  - "capture-failed" or freeform message from the native layer.
   */
  reason?: string | null;
  /** Full playlist zone image (data URL) — for the test-mode preview. */
  zoneImage?: string | null;
  /** Isolated active-row image (data URL) — for the test-mode preview. */
  activeRowImage?: string | null;
  /**
   * Active-row rectangle expressed as fractions of the CAPTURED ZONE
   * (0..1). Lets the UI paint an overlay on top of `zoneImage`.
   */
  activeRowFraction?: { x: number; y: number; width: number; height: number } | null;
  sourceOk?: boolean;
  orientationOk?: boolean;
  sourcePackage?: string | null;
}

export interface BackgroundStatus {
  running: boolean;
  phase?: string;
  index?: number;
  total?: number;
  bpm?: number | null;
  userPaused?: boolean;
  visibilityPaused?: boolean;
  currentName?: string | null;
  etaMs?: number;
  interrupted?: boolean;
  lastPath?: string | null;
  savedIndex?: number;
  savedTotal?: number;
  savedProjectFingerprint?: string | null;
  savedProjectName?: string | null;
  savedDeck?: number;
}

export type BackgroundEventName =
  | "discdjPhase"
  | "discdjProgress"
  | "discdjBpm"
  | "discdjLog"
  | "discdjDone"
  | "discdjVisibilityPaused"
  | "discdjResumeAvailable";

export interface DiscDJBridge {
  readonly id: string;
  /** Short human label shown in the UI ("Simulé", "AccessibilityService"…). */
  readonly label: string;
  /** Whether this bridge can drive DiscDJ right now on this device. */
  isReady(): Promise<{
    ready: boolean;
    reason?: string;
    accessibilityEnabled?: boolean;
    discdjInstalled?: boolean;
    foreground?: boolean;
    orientation?: "landscape" | "portrait";
    displayWidth?: number;
    displayHeight?: number;
    windowPackage?: string | null;
  }>;
  /** Bring DiscDJ to the foreground. */
  openApp(): Promise<void>;
  /** Preflight source/orientation/stability check before analysis. */
  checkReady?(): Promise<{ ok: boolean; reason?: string; sourceOk?: boolean; orientationOk?: boolean; stable?: boolean; displayWidth?: number; displayHeight?: number }>;
  /** Open Android accessibility settings when the service is not enabled. */
  openAccessibilitySettings?(): Promise<void>;
  /** Read BPM + title + duration from the requested deck. */
  readBpm(deck: DeckId, hint?: ReadHint): Promise<DiscDJReading>;
  /**
   * AutoSync-name: capture the full playlist zone, auto-detect the active
   * blue row, and OCR only that row. Returns diagnostic images/rects for
   * the test-mode preview.
   */
  readPlaylistActiveName?(deck: DeckId, playlistZone: CalibrationRect): Promise<PlaylistActiveNameReading>;
  /** Tap the "Next" button so DiscDJ loads the next track on the deck. */
  tapNext(deck: DeckId, options?: TapOptions): Promise<void>;
  /**
   * Interactive calibration: bring DiscDJ to the foreground, show a floating
   * capture overlay, and return the point / zone the user touched. Only the
   * native bridge implements this; simulated returns plausible defaults.
   */
  captureCalibration?(target: CalibrationTarget): Promise<CaptureResult>;
  /** Start a run inside the Android foreground service. */
  startBackgroundRun?(opts: BackgroundRunOptions): Promise<void>;
  pauseBackgroundRun?(): Promise<void>;
  resumeBackgroundRun?(): Promise<void>;
  stopBackgroundRun?(): Promise<void>;
  clearBackgroundState?(): Promise<void>;
  getBackgroundStatus?(): Promise<BackgroundStatus>;
  addBackgroundListener?(name: BackgroundEventName, cb: (payload: unknown) => void): { remove: () => void };
  /**
   * Native-backed sleep. When available, callers should prefer this over a
   * JS setTimeout during long-running loops: WebView setTimeout is heavily
   * throttled once MixOrder loses focus (which is exactly what happens
   * while DiscDJ owns the foreground during an analysis run).
   */
  nativeSleep?(ms: number): Promise<void>;
}

/**
 * Simulated bridge — no device driving, just plausible values.
 * Used to validate the robot loop + UX on web and until the native
 * AccessibilityService is calibrated. It intentionally mangles the hint
 * title (adds a "NNN_" prefix, swaps separators) so the matcher gets a
 * realistic-looking input to normalize.
 */
export const simulatedBridge: DiscDJBridge = {
  id: "simulated",
  label: "Simulé",
  async isReady() {
    return {
      ready: true,
      accessibilityEnabled: true,
      discdjInstalled: true,
      reason:
        "Pont simulé — les BPM sont générés pour tester le flux. Fournis les captures annotées pour activer le pont natif DiscDJ.",
    };
  },
  async openApp() {
    /* no-op */
  },
  async checkReady() {
    return { ok: true, sourceOk: true, orientationOk: true, stable: true };
  },
  async captureCalibration(target) {
    await sleep(400);
    if (target === "bpmDeck1") return { rect: { x: 0.14, y: 0.36, width: 0.12, height: 0.14 } };
    if (target === "bpmDeck2") return { rect: { x: 0.6, y: 0.36, width: 0.12, height: 0.14 } };
    if (target === "nextDeck1") return { point: { x: 0.22, y: 0.86 } };
    return { point: { x: 0.78, y: 0.86 } };
  },
  async readBpm(_deck, hint) {
    await sleep(500);
    const raw = (100 + Math.random() * 40).toFixed(1);
    const prefix = String(Math.floor(Math.random() * 200)).padStart(3, "0");
    const base = (hint?.title ?? "Unknown Track").replace(/\.[a-z0-9]+$/i, "");
    const mangled = `${prefix}_${base.replace(/[\s_-]+/g, " ")}`;
    return {
      bpm: parseFloat(raw),
      title: mangled,
      durationSec: hint?.durationSec ?? null,
      raw,
    };
  },
  async tapNext() {
    await sleep(300);
  },
};

let registered: DiscDJBridge | null = null;
let nativeAttempted = false;

/** Called by the native layer when it's ready to take over. */
export function registerBridge(bridge: DiscDJBridge) {
  registered = bridge;
}

/**
 * Returns the best bridge available. Order: explicitly registered > native
 * Android plugin (when installed) > simulated fallback.
 */
export function getBridge(): DiscDJBridge {
  if (registered) return registered;
  if (!nativeAttempted && Capacitor.isNativePlatform()) {
    nativeAttempted = true;
    try {
      registered = createNativeBridge();
    } catch {
      registered = null;
    }
  }
  return registered ?? simulatedBridge;
}

function createNativeBridge(): DiscDJBridge {
  const plugin = DiscDJRobot as unknown as NativeDiscDJRobot;
  return {
    id: "discdj-native",
    label: "DiscDJ (accessibilité)",
    async isReady() {
      const s = await plugin.isReady();
      return {
        ready: s.ready,
        reason: s.reason,
        accessibilityEnabled: s.accessibilityEnabled,
        discdjInstalled: s.discdjInstalled,
        foreground: s.foreground,
        orientation: s.orientation,
        displayWidth: s.displayWidth,
        displayHeight: s.displayHeight,
        windowPackage: s.windowPackage ?? null,
      };
    },
    async openApp() {
      await plugin.openApp();
    },
    async openAccessibilitySettings() {
      await plugin.openAccessibilitySettings();
    },
    async captureCalibration(target) {
      const kind: "point" | "zone" = isRectTarget(target) ? "zone" : "point";
      const instructions = calibrationInstruction(target);
      const r = await plugin.captureCalibration({ target, kind, instructions });
      if (r.cancelled) return { cancelled: true };
      if (kind === "zone" && typeof r.width === "number" && typeof r.height === "number") {
        return { rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
      }
      return { point: { x: r.x, y: r.y } };
    },
    async readBpm(deck, hint) {
      const r = await plugin.readBpm({ deck, bpmZone: hint?.bpmZone ?? null });
      const durationSec = parseDurationText(r.duration);
      return {
        bpm: typeof r.bpm === "number" ? r.bpm : null,
        title: r.title ?? null,
        durationSec,
        raw: r.raw ?? undefined,
        zoneTexts: Array.isArray(r.ocrVariants) ? r.ocrVariants : Array.isArray(r.zoneTexts) ? r.zoneTexts : [],
        bpmDiagnostics: Array.isArray(r.bpmDiagnostics) ? r.bpmDiagnostics : [],
        parseReason: r.parseReason ?? null,
        sourceOk: r.sourceOk,
        orientationOk: r.orientationOk,
        sourcePackage: r.sourcePackage ?? null,
        fullScreenshot: r.fullScreenshot ?? null,
        croppedImage: r.croppedImage ?? null,
        ocrInputImage: r.ocrInputImage ?? null,
        ocrRect: r.ocrRect ?? null,
        display: typeof r.displayWidth === "number" && typeof r.displayHeight === "number"
          ? { width: r.displayWidth, height: r.displayHeight }
          : null,
        endOfPlaylist: r.endOfPlaylist,
      };
    },
    async readPlaylistActiveName(deck, playlistZone) {
      if (typeof plugin.readPlaylistActiveName !== "function") {
        return { name: null, reason: "Le plugin natif n'expose pas readPlaylistActiveName." };
      }
      const r = await plugin.readPlaylistActiveName({ deck, playlistZone });
      return {
        name: r.name ?? null,
        raw: r.raw ?? null,
        zoneTexts: Array.isArray(r.zoneTexts) ? r.zoneTexts : [],
        reason: r.reason ?? null,
        zoneImage: r.zoneImage ?? null,
        activeRowImage: r.activeRowImage ?? null,
        activeRowFraction: r.activeRowFraction ?? null,
        sourceOk: r.sourceOk,
        orientationOk: r.orientationOk,
        sourcePackage: r.sourcePackage ?? null,
      };
    },
    async checkReady() {
      return plugin.checkReady();
    },
    async tapNext(deck, options) {
      // No offset is passed to the native side. The plugin taps EXACTLY
      // on the calibrated point.
      await withTimeout(
        plugin.tapNext({
          deck,
          point: options?.point ?? null,
          pressDurationMs: options?.pressDurationMs,
        }),
        Math.max(1200, (options?.pressDurationMs ?? 120) + 1500),
        "Geste Next sans réponse du système Android.",
      );
    },
    async startBackgroundRun(opts) {
      await plugin.startBackgroundRun(opts);
    },
    async pauseBackgroundRun() { await plugin.pauseBackgroundRun(); },
    async resumeBackgroundRun() { await plugin.resumeBackgroundRun(); },
    async stopBackgroundRun() { await plugin.stopBackgroundRun(); },
    async clearBackgroundState() { await plugin.clearBackgroundState(); },
    async getBackgroundStatus() { return plugin.getBackgroundStatus(); },
    addBackgroundListener(name, cb) {
      const handle = plugin.addListener(name, cb);
      return { remove: () => { void handle?.remove?.(); } };
    },
    async nativeSleep(ms) {
      if (typeof plugin.sleep === "function") {
        await plugin.sleep({ ms });
      } else {
        await new Promise<void>((r) => setTimeout(r, ms));
      }
    },
  };
}

interface NativeReading {
  bpm: number | null;
  raw: string | null;
  title: string | null;
  duration: string | null;
  zoneTexts?: string[];
  ocrVariants?: string[];
  bpmDiagnostics?: BpmParseDiagnostic[];
  parseReason?: string | null;
  sourceOk?: boolean;
  orientationOk?: boolean;
  sourcePackage?: string | null;
  fullScreenshot?: string | null;
  croppedImage?: string | null;
  ocrInputImage?: string | null;
  ocrRect?: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
  displayWidth?: number;
  displayHeight?: number;
  endOfPlaylist?: boolean;
}
interface NativeDiscDJRobot {
  isReady(): Promise<{
    ready: boolean;
    reason?: string;
    discdjInstalled: boolean;
    accessibilityEnabled: boolean;
    foreground?: boolean;
    orientation?: "landscape" | "portrait";
    displayWidth?: number;
    displayHeight?: number;
    windowPackage?: string | null;
  }>;
  openApp(): Promise<void>;
  checkReady(): Promise<{ ok: boolean; reason?: string; sourceOk?: boolean; orientationOk?: boolean; stable?: boolean; displayWidth?: number; displayHeight?: number }>;
  openAccessibilitySettings(): Promise<void>;
  captureCalibration(opts: { target: string; kind: "point" | "zone"; instructions: string }): Promise<{
    cancelled?: boolean;
    x: number;
    y: number;
    width?: number;
    height?: number;
  }>;
  readBpm(opts: { deck: DeckId; bpmZone?: CalibrationRect | null }): Promise<NativeReading>;
  readPlaylistActiveName?(opts: { deck: DeckId; playlistZone: CalibrationRect }): Promise<{
    name: string | null;
    raw?: string | null;
    zoneTexts?: string[];
    reason?: string | null;
    zoneImage?: string | null;
    activeRowImage?: string | null;
    activeRowFraction?: { x: number; y: number; width: number; height: number } | null;
    sourceOk?: boolean;
    orientationOk?: boolean;
    sourcePackage?: string | null;
  }>;
  tapNext(opts: {
    deck: DeckId;
    point?: CalibrationPoint | null;
    pressDurationMs?: number;
  }): Promise<void>;
  startBackgroundRun(opts: BackgroundRunOptions): Promise<void>;
  pauseBackgroundRun(): Promise<void>;
  resumeBackgroundRun(): Promise<void>;
  stopBackgroundRun(): Promise<void>;
  clearBackgroundState(): Promise<void>;
  getBackgroundStatus(): Promise<BackgroundStatus>;
  addListener(name: string, cb: (payload: unknown) => void): { remove: () => Promise<void> } | undefined;
  sleep?(opts: { ms: number }): Promise<void>;
}

function calibrationInstruction(target: CalibrationTarget): string {
  switch (target) {
    case "nextDeck1":
      return "Touche le bouton NEXT de la platine 1 dans DiscDJ";
    case "nextDeck2":
      return "Touche le bouton NEXT de la platine 2 dans DiscDJ";
    case "bpmDeck1":
      return "Encadre la zone BPM de la platine 1 (glisse un rectangle)";
    case "bpmDeck2":
      return "Encadre la zone BPM de la platine 2 (glisse un rectangle)";
    case "playlistButton":
      return "Touche le bouton PLAYLIST dans DiscDJ";
    case "backButton":
      return "Touche le bouton RETOUR (flèche haut) depuis la playlist";
    case "playlistZoneDeck1":
      return "Encadre la zone complète de la liste des morceaux (platine 1) — englobe toutes les lignes visibles";
    case "playlistZoneDeck2":
      return "Encadre la zone complète de la liste des morceaux (platine 2) — englobe toutes les lignes visibles";
    default:
      return "Touche l'emplacement à calibrer";
  }
}

function parseDurationText(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  const c = m[3] ? parseInt(m[3], 10) : null;
  return c != null ? a * 3600 + b * 60 + c : a * 60 + b;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export const BPM_MIN = 40;
export const BPM_MAX = 240;

export function isPlausibleBpm(v: number | null | undefined): v is number {
  return typeof v === "number" && isFinite(v) && v >= BPM_MIN && v <= BPM_MAX;
}
