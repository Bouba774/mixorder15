export type DeckId = 1 | 2;

export interface DiscDJReadyStatus {
  ready: boolean;
  reason?: string;
  /** True when DiscDJ is installed on the device. */
  discdjInstalled: boolean;
  /** True when our accessibility service is enabled by the user. */
  accessibilityEnabled: boolean;
  packageName?: string | null;
  foreground?: boolean;
  orientation?: "landscape" | "portrait";
  displayWidth?: number;
  displayHeight?: number;
  windowPackage?: string | null;
}

export interface DiscDJBpmReading {
  /** Parsed BPM value (integer), or null when nothing readable was found. */
  bpm: number | null;
  /** The raw joined text captured inside the calibrated BPM zone. */
  raw: string | null;
  /** DiscDJ track title text captured near the deck, when available. */
  title: string | null;
  /** Duration text (e.g. "04:17") captured near the deck, when available. */
  duration: string | null;
  /** Every text node whose center falls inside the calibrated BPM zone. */
  zoneTexts?: string[];
  /** Raw OCR variant lines, never concatenated. Mirrors zoneTexts on recent APKs. */
  ocrVariants?: string[];
  /** Advanced BPM parser diagnostics, one item per raw OCR variant. */
  bpmDiagnostics?: Array<{
    raw: string;
    cleaned: string;
    corrected: string;
    extracted: number | null;
    accepted: boolean;
    reason: string | null;
  }>;
  /** Human-readable explanation when `bpm` is null (missing zone, no digit, etc.). */
  parseReason?: string | null;
  /** True only when the captured source is DiscDJ, never MixOrder/overlay. */
  sourceOk?: boolean;
  /** True only when the capture was made in DiscDJ landscape mode. */
  orientationOk?: boolean;
  sourcePackage?: string | null;
  fullScreenshot?: string | null;
  croppedImage?: string | null;
  ocrInputImage?: string | null;
  ocrRect?: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
  displayWidth?: number;
  displayHeight?: number;
  /** True when DiscDJ reports no more tracks (best effort). */
  endOfPlaylist?: boolean;
}

export interface DiscDJCalibrationPoint {
  x: number;
  y: number;
}

export interface DiscDJCalibrationRect extends DiscDJCalibrationPoint {
  width: number;
  height: number;
}

export interface DiscDJCaptureResult {
  cancelled?: boolean;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface DiscDJRobotPlugin {
  isReady(): Promise<DiscDJReadyStatus>;
  openApp(): Promise<void>;
  checkReady(): Promise<{
    ok: boolean;
    reason?: string;
    sourceOk?: boolean;
    orientationOk?: boolean;
    stable?: boolean;
    displayWidth?: number;
    displayHeight?: number;
  }>;
  /** Open the Android Accessibility settings so the user enables our service. */
  openAccessibilitySettings(): Promise<void>;
  /**
   * Show a floating overlay over the current (DiscDJ) screen and capture a
   * single tap ("point") or a dragged rectangle ("zone"). Coordinates are
   * returned as fractions of MixOrder's canonical landscape reference frame.
   */
  captureCalibration(options: {
    target: string;
    kind: "point" | "zone";
    instructions: string;
  }): Promise<DiscDJCaptureResult>;
  readBpm(options: { deck: DeckId; bpmZone?: DiscDJCalibrationRect | null }): Promise<DiscDJBpmReading>;
  /**
   * AutoSync-name: capture the full playlist zone, detect the currently
   * loaded row by its blue background color, isolate that row and OCR it.
   */
  readPlaylistActiveName(options: { deck: DeckId; playlistZone: DiscDJCalibrationRect }): Promise<{
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
  tapNext(options: {
    deck: DeckId;
    point?: DiscDJCalibrationPoint | null;
    pressDurationMs?: number;
  }): Promise<void>;
  startBackgroundRun?(options: unknown): Promise<void>;
  pauseBackgroundRun?(): Promise<void>;
  resumeBackgroundRun?(): Promise<void>;
  stopBackgroundRun?(): Promise<void>;
  clearBackgroundState?(): Promise<void>;
  getBackgroundStatus?(): Promise<unknown>;
  addListener?(name: string, cb: (payload: unknown) => void): { remove: () => Promise<void> } | undefined;
  /** Native-backed sleep — not throttled when MixOrder is backgrounded. */
  sleep(options: { ms: number }): Promise<void>;
}

export declare const DiscDJRobot: DiscDJRobotPlugin;
export default DiscDJRobot;
