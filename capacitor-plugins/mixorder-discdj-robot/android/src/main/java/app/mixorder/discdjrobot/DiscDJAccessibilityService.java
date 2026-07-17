package app.mixorder.discdjrobot;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Path;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executor;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * MixOrder DiscDJ AccessibilityService.
 *
 * Coordinate contract: every calibration is stored in a single canonical
 * LANDSCAPE frame. If Android is portrait during capture, touch coordinates
 * are rotated into that frame. During execution the canonical point/rectangle
 * is converted back to the real display/screenshot pixels exactly once.
 */
public class DiscDJAccessibilityService extends AccessibilityService {

    private static DiscDJAccessibilityService instance;

    private static final Pattern DURATION_PATTERN =
            Pattern.compile("\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b");

    private static final String[] BAD_SOURCE_KEYWORDS = new String[] {
            "mixorder", "robot discdj", "diagnostic", "calibration", "zone ocr",
            "attente de chargement", "tester la calibration", "pont :", "ouvrir les paramètres",
            "bpm final", "texte ocr brut", "recalibrer", "récapitulatif"
    };

    public static DiscDJAccessibilityService getInstance() {
        return instance;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Passive service: the Capacitor plugin drives all reads/taps on demand.
    }

    @Override
    public void onInterrupt() {
        // no-op
    }

    public static class TextHit {
        public final String text;
        public final Rect bounds;
        public TextHit(String text, Rect bounds) {
            this.text = text;
            this.bounds = bounds;
        }
    }

    public static class ScanResult {
        public final List<TextHit> allText = new ArrayList<>();
        public int displayWidth;
        public int displayHeight;
        public String sourcePackage;
        public boolean sourceOk;
    }

    public static class WindowSnapshot {
        public String packageName;
        public Rect bounds = new Rect();
        public int childCount;
        public int displayWidth;
        public int displayHeight;
        public boolean landscape;
        public boolean foregroundMatches;
    }

    public static class OcrResult {
        public Double bpm;
        public String raw;
        public final List<String> zoneTexts = new ArrayList<>();
        public final List<BpmParseDiagnostic> bpmDiagnostics = new ArrayList<>();
        public String parseReason;
        public String sourcePackage;
        public boolean sourceOk;
        public int displayWidth;
        public int displayHeight;
        public Rect cropRect = new Rect();
        public String fullScreenshotDataUrl;
        public String croppedDataUrl;
        public String ocrInputDataUrl;
    }

    public static class BpmParseDiagnostic {
        public String raw;
        public String cleaned;
        public String corrected;
        public Integer extracted;
        public boolean accepted;
        public String reason;
    }

    private static class BpmParseDecision {
        Double bpm;
        String reason;
        final List<BpmParseDiagnostic> diagnostics = new ArrayList<>();
    }

    public interface OcrCallback {
        void onResult(OcrResult result);
    }

    /** Callback for `captureZoneBitmap`. `zone` is null when capture failed. */
    public interface ZoneBitmapCallback {
        void onResult(Bitmap zone, String zoneDataUrl, String errorReason);
    }

    /** Callback for `ocrBitmapLines`. */
    public interface OcrLinesCallback {
        void onResult(java.util.List<String> lines);
    }

    /** Real display metrics in the current Android orientation. */
    public int[] getDisplaySize() {
        DisplayMetrics dm = new DisplayMetrics();
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        if (wm != null && wm.getDefaultDisplay() != null) {
            wm.getDefaultDisplay().getRealMetrics(dm);
        } else {
            dm = getResources().getDisplayMetrics();
        }
        return new int[] { dm.widthPixels, dm.heightPixels };
    }

    /** Current app-window snapshot, used for foreground + stability checks. */
    public WindowSnapshot getWindowSnapshot(String expectedPackage) {
        WindowSnapshot s = new WindowSnapshot();
        int[] size = getDisplaySize();
        s.displayWidth = size[0];
        s.displayHeight = size[1];
        s.landscape = size[0] >= size[1];

        AccessibilityNodeInfo root = getDiscDJRoot(expectedPackage);
        if (root == null) root = getRootInActiveWindow();
        if (root != null) {
            CharSequence pkg = root.getPackageName();
            s.packageName = pkg != null ? pkg.toString() : null;
            root.getBoundsInScreen(s.bounds);
            s.childCount = countNodes(root, 0);
            s.foregroundMatches = packageMatches(s.packageName, expectedPackage);
        } else {
            s.foregroundMatches = false;
        }
        return s;
    }

    /** Scan only DiscDJ's app window; foreign overlays/windows are ignored. */
    public ScanResult scanDiscDJWindow(String expectedPackage) {
        ScanResult res = new ScanResult();
        int[] size = getDisplaySize();
        res.displayWidth = size[0];
        res.displayHeight = size[1];
        AccessibilityNodeInfo root = getDiscDJRoot(expectedPackage);
        if (root == null) root = getRootInActiveWindow();
        if (root != null) {
            CharSequence pkg = root.getPackageName();
            res.sourcePackage = pkg != null ? pkg.toString() : null;
            res.sourceOk = packageMatches(res.sourcePackage, expectedPackage);
            if (res.sourceOk) walk(root, res);
        }
        return res;
    }

    private AccessibilityNodeInfo getDiscDJRoot(String expectedPackage) {
        List<AccessibilityWindowInfo> windows = getWindows();
        if (windows != null) {
            for (AccessibilityWindowInfo w : windows) {
                if (w == null || w.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                AccessibilityNodeInfo root = w.getRoot();
                if (root == null) continue;
                CharSequence pkg = root.getPackageName();
                if (packageMatches(pkg != null ? pkg.toString() : null, expectedPackage)) return root;
            }
        }
        AccessibilityNodeInfo active = getRootInActiveWindow();
        if (active == null) return null;
        CharSequence pkg = active.getPackageName();
        return packageMatches(pkg != null ? pkg.toString() : null, expectedPackage) ? active : null;
    }

    private void walk(AccessibilityNodeInfo node, ScanResult res) {
        if (node == null) return;
        CharSequence textCs = node.getText();
        CharSequence descCs = node.getContentDescription();
        String[] sources = new String[] {
                textCs != null ? textCs.toString() : null,
                descCs != null ? descCs.toString() : null,
        };
        for (String s : sources) {
            if (s == null || s.trim().isEmpty()) continue;
            Rect r = new Rect();
            node.getBoundsInScreen(r);
            if (r.width() <= 0 || r.height() <= 0) continue;
            res.allText.add(new TextHit(s.trim(), r));
        }
        int n = node.getChildCount();
        for (int i = 0; i < n; i++) walk(node.getChild(i), res);
    }

    private int countNodes(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 8) return 0;
        int total = 1;
        for (int i = 0; i < node.getChildCount(); i++) total += countNodes(node.getChild(i), depth + 1);
        return total;
    }

    public static boolean packageMatches(String actual, String expected) {
        if (actual == null || expected == null || expected.isEmpty()) return false;
        return actual.equals(expected);
    }

    /** Convert canonical-landscape point to current display coordinates. */
    public static float[] pointFromCanonical(float nx, float ny, int screenW, int screenH) {
        nx = clamp(nx); ny = clamp(ny);
        if (screenW >= screenH) return new float[] { nx * screenW, ny * screenH };
        return new float[] { (1f - ny) * screenW, nx * screenH };
    }

    /** Convert current display coordinates to canonical landscape fractions. */
    private static float[] pointToCanonical(float rawX, float rawY, int screenW, int screenH) {
        if (screenW >= screenH) return new float[] { clamp(rawX / screenW), clamp(rawY / screenH) };
        return new float[] { clamp(rawY / screenH), clamp(1f - (rawX / screenW)) };
    }

    public static Rect rectFromCanonical(double x, double y, double w, double h, int screenW, int screenH) {
        float x1 = (float) x, y1 = (float) y, x2 = (float) (x + w), y2 = (float) (y + h);
        float[] p1 = pointFromCanonical(x1, y1, screenW, screenH);
        float[] p2 = pointFromCanonical(x2, y1, screenW, screenH);
        float[] p3 = pointFromCanonical(x2, y2, screenW, screenH);
        float[] p4 = pointFromCanonical(x1, y2, screenW, screenH);
        int l = Math.round(Math.min(Math.min(p1[0], p2[0]), Math.min(p3[0], p4[0])));
        int t = Math.round(Math.min(Math.min(p1[1], p2[1]), Math.min(p3[1], p4[1])));
        int r = Math.round(Math.max(Math.max(p1[0], p2[0]), Math.max(p3[0], p4[0])));
        int b = Math.round(Math.max(Math.max(p1[1], p2[1]), Math.max(p3[1], p4[1])));
        return new Rect(l, t, r, b);
    }

    public static boolean rectFullyVisible(Rect rect, int w, int h) {
        return rect != null && rect.left >= 0 && rect.top >= 0 && rect.right <= w && rect.bottom <= h
                && rect.width() > 0 && rect.height() > 0;
    }

    /** Strict screenshot crop + ML Kit OCR, never using MixOrder UI as source. */
    public void readBpmFromScreenshot(final Rect displayCropRect, final String expectedPackage, final OcrCallback cb) {
        removeOverlay();
        OcrResult early = new OcrResult();
        int[] display = getDisplaySize();
        early.displayWidth = display[0];
        early.displayHeight = display[1];
        early.cropRect = displayCropRect != null ? new Rect(displayCropRect) : new Rect();
        WindowSnapshot snap = getWindowSnapshot(expectedPackage);
        early.sourcePackage = snap.packageName;
        early.sourceOk = snap.foregroundMatches;

        if (!snap.foregroundMatches) {
            early.parseReason = "Mauvaise source de capture : DiscDJ n'est pas au premier plan.";
            cb.onResult(early);
            return;
        }
        if (!snap.landscape) {
            early.parseReason = "Orientation incorrecte : DiscDJ doit être affiché en mode paysage avant la lecture OCR.";
            cb.onResult(early);
            return;
        }
        if (!rectFullyVisible(displayCropRect, display[0], display[1])) {
            early.parseReason = "Zone OCR invalide ou partiellement hors écran.";
            cb.onResult(early);
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            early.parseReason = "Capture OCR indisponible : Android 11 ou plus récent est requis pour capturer strictement l'écran DiscDJ.";
            cb.onResult(early);
            return;
        }

        Executor executor = command -> new Handler(Looper.getMainLooper()).post(command);
        try {
        takeScreenshot(Display.DEFAULT_DISPLAY, executor, new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult screenshot) {
                Bitmap full;
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(screenshot.getHardwareBuffer(), screenshot.getColorSpace());
                    if (hw == null) throw new IllegalStateException("buffer vide");
                    full = hw.copy(Bitmap.Config.ARGB_8888, false);
                    screenshot.getHardwareBuffer().close();
                } catch (Exception e) {
                    OcrResult r = baseResult(displayCropRect, expectedPackage);
                    r.parseReason = "Capture DiscDJ impossible : " + e.getMessage();
                    cb.onResult(r);
                    return;
                }
                if (full.getWidth() < full.getHeight()) {
                    OcrResult r = baseResult(displayCropRect, expectedPackage);
                    r.fullScreenshotDataUrl = bitmapDataUrl(full, Bitmap.CompressFormat.JPEG, 45);
                    r.parseReason = "Orientation incorrecte : la capture reçue est en portrait alors que DiscDJ doit être en paysage.";
                    cb.onResult(r);
                    return;
                }

                float sx = full.getWidth() / (float) display[0];
                float sy = full.getHeight() / (float) display[1];
                Rect crop = new Rect(
                        Math.round(displayCropRect.left * sx),
                        Math.round(displayCropRect.top * sy),
                        Math.round(displayCropRect.right * sx),
                        Math.round(displayCropRect.bottom * sy)
                );
                if (!rectFullyVisible(crop, full.getWidth(), full.getHeight())) {
                    OcrResult r = baseResult(displayCropRect, expectedPackage);
                    r.fullScreenshotDataUrl = bitmapDataUrl(full, Bitmap.CompressFormat.JPEG, 45);
                    r.parseReason = "Zone OCR invalide dans la capture DiscDJ.";
                    cb.onResult(r);
                    return;
                }

                Bitmap cropped = Bitmap.createBitmap(full, crop.left, crop.top, crop.width(), crop.height());
                OcrResult result = baseResult(displayCropRect, expectedPackage);
                result.fullScreenshotDataUrl = bitmapDataUrl(full, Bitmap.CompressFormat.JPEG, 45);
                result.croppedDataUrl = bitmapDataUrl(cropped, Bitmap.CompressFormat.PNG, 100);

                // Build several OCR-ready variants of the crop (different
                // preprocessing strategies) so text of any polarity — dark on
                // light, white on blue "selected row", low contrast, noisy —
                // has a real chance of being recognized. All variants are
                // OCR'd and their outputs merged, then voted on.
                final List<Bitmap> variants = prepareOcrVariants(cropped);
                if (variants.isEmpty()) variants.add(cropped);
                result.ocrInputDataUrl = bitmapDataUrl(buildVariantSheet(variants), Bitmap.CompressFormat.PNG, 100);

                final List<String> allTexts = new ArrayList<>();
                final int[] remaining = new int[] { variants.size() };
                for (int idx = 0; idx < variants.size(); idx++) {
                    TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                    recognizer.process(InputImage.fromBitmap(variants.get(idx), 0))
                            .addOnSuccessListener(text -> {
                                synchronized (allTexts) { allTexts.addAll(extractOcrTexts(text)); }
                                recognizer.close();
                                synchronized (remaining) {
                                    if (--remaining[0] == 0) finalizeOcr(result, allTexts, cb);
                                }
                            })
                            .addOnFailureListener(e -> {
                                recognizer.close();
                                synchronized (remaining) {
                                    if (--remaining[0] == 0) finalizeOcr(result, allTexts, cb);
                                }
                            });
                }
            }

            @Override
            public void onFailure(int errorCode) {
                OcrResult r = baseResult(displayCropRect, expectedPackage);
                r.parseReason = "Capture DiscDJ refusée par Android (code " + errorCode + ").";
                cb.onResult(r);
            }
        });
        } catch (Exception e) {
            OcrResult r = baseResult(displayCropRect, expectedPackage);
            r.parseReason = "Capture DiscDJ impossible : " + e.getMessage();
            cb.onResult(r);
        }
    }

    private void finalizeOcr(OcrResult result, List<String> allTexts, OcrCallback cb) {
        List<String> uniq = new ArrayList<>();
        for (String s : allTexts) {
            if (s == null) continue;
            String t = s.trim();
            if (t.isEmpty()) continue;
            if (!uniq.contains(t)) uniq.add(t);
        }
        result.zoneTexts.addAll(uniq);
        result.raw = uniq.isEmpty() ? "" : uniq.get(0);
        String allTextForSafety = join(uniq);
        if (containsBadSourceText(allTextForSafety)) {
            result.sourceOk = false;
            result.parseReason = "Mauvaise source d'image capturée : le texte OCR contient des éléments de MixOrder ou d'un overlay.";
        } else {
            BpmParseDecision decision = parseBestBpmDetailed(uniq);
            result.bpm = decision.bpm;
            result.bpmDiagnostics.addAll(decision.diagnostics);
            if (result.bpm == null) {
                result.parseReason = uniq.isEmpty()
                        ? "OCR vide dans le rectangle BPM calibré (toutes variantes de prétraitement)."
                        : (decision.reason != null ? decision.reason : "Texte OCR lu sur " + uniq.size() + " variantes séparées, mais aucun BPM valide entre 40 et 240.");
            } else {
                result.parseReason = decision.reason;
            }
        }
        cb.onResult(result);
    }

    private OcrResult baseResult(Rect crop, String expectedPackage) {
        OcrResult r = new OcrResult();
        int[] display = getDisplaySize();
        r.displayWidth = display[0];
        r.displayHeight = display[1];
        r.cropRect = crop != null ? new Rect(crop) : new Rect();
        WindowSnapshot snap = getWindowSnapshot(expectedPackage);
        r.sourcePackage = snap.packageName;
        r.sourceOk = snap.foregroundMatches;
        return r;
    }

    private static List<String> extractOcrTexts(Text text) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                String s = line.getText();
                if (s != null && !s.trim().isEmpty()) out.add(s.trim());
            }
        }
        if (out.isEmpty() && text.getText() != null && !text.getText().trim().isEmpty()) {
            out.add(text.getText().trim());
        }
        return out;
    }

    private static String join(List<String> texts) {
        StringBuilder b = new StringBuilder();
        if (texts == null) return "";
        for (String s : texts) {
            if (s == null || s.trim().isEmpty()) continue;
            if (b.length() > 0) b.append(' ');
            b.append(s.trim());
        }
        return b.toString();
    }

    private static boolean containsBadSourceText(String raw) {
        if (raw == null) return false;
        String lower = raw.toLowerCase(Locale.ROOT);
        for (String k : BAD_SOURCE_KEYWORDS) if (lower.contains(k)) return true;
        return false;
    }

    private static String bitmapDataUrl(Bitmap bitmap, Bitmap.CompressFormat format, int quality) {
        if (bitmap == null) return null;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(format, quality, out);
        String mime = format == Bitmap.CompressFormat.PNG ? "image/png" : "image/jpeg";
        return "data:" + mime + ";base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    /**
     * Build several OCR-ready variants of a source bitmap. The OCR engine is
     * fed each variant independently and their outputs merged. This is what
     * makes white-on-blue playlist rows (and low-contrast BPM digits) actually
     * readable without asking the user to recalibrate.
     *
     * Variants produced, in order of usual usefulness:
     *  1. Upscaled + adaptive binarization (dark text on light bg)
     *  2. Upscaled + adaptive binarization INVERTED (light text on dark bg —
     *     the white-on-blue "selected row" case)
     *  3. Upscaled + contrast/sharpen only (no threshold — helps ML Kit on
     *     colored backgrounds where binarization eats the strokes)
     *  4. Upscaled grayscale (baseline)
     */
    private static List<Bitmap> prepareOcrVariants(Bitmap source) {
        List<Bitmap> out = new ArrayList<>();
        if (source == null) return out;
        int scale = Math.max(2, Math.min(4, 1500 / Math.max(1, Math.max(source.getWidth(), source.getHeight()))));
        Bitmap scaled = Bitmap.createScaledBitmap(source, source.getWidth() * scale, source.getHeight() * scale, true);
        int w = scaled.getWidth();
        int h = scaled.getHeight();
        int[] pixels = new int[w * h];
        scaled.getPixels(pixels, 0, w, 0, 0, w, h);
        int[] lum = new int[pixels.length];
        long sum = 0;
        int min = 255, max = 0;
        for (int i = 0; i < pixels.length; i++) {
            int c = pixels[i];
            int l = (int) (Color.red(c) * 0.299 + Color.green(c) * 0.587 + Color.blue(c) * 0.114);
            lum[i] = l; sum += l;
            if (l < min) min = l;
            if (l > max) max = l;
        }
        int avg = pixels.length > 0 ? (int) (sum / pixels.length) : 128;
        boolean brightTextOnDark = avg < 128;
        int margin = 18;

        // Variant 1 — adaptive binarization matched to detected polarity
        out.add(binarize(pixels, lum, avg, margin, w, h, brightTextOnDark));
        // Variant 2 — same but OPPOSITE polarity assumption (crucial for
        // white-on-blue playlist rows when the average luminance is fooled
        // by large bright background patches).
        out.add(binarize(pixels, lum, avg, margin, w, h, !brightTextOnDark));
        // Variant 3 — contrast + sharpen only, no threshold, output still
        // grayscale-ish. Great for colored backgrounds where any hard
        // threshold destroys thin strokes.
        out.add(contrastStretch(pixels, lum, min, max, w, h));
        // Variant 4 — inverted grayscale (helps when text is light on a
        // mid-tone background and neither binarization catches it).
        out.add(invertedGrayscale(pixels, lum, w, h));
        return out;
    }

    private static Bitmap buildVariantSheet(List<Bitmap> variants) {
        if (variants == null || variants.isEmpty()) return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        int width = 0;
        int height = 0;
        for (Bitmap b : variants) {
            if (b == null) continue;
            width = Math.max(width, b.getWidth());
            height += b.getHeight();
        }
        width = Math.max(1, width);
        height = Math.max(1, height);
        Bitmap sheet = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(sheet);
        c.drawColor(Color.WHITE);
        int y = 0;
        for (Bitmap b : variants) {
            if (b == null) continue;
            c.drawBitmap(b, 0, y, null);
            y += b.getHeight();
        }
        return sheet;
    }

    private static Bitmap binarize(int[] src, int[] lum, int avg, int margin, int w, int h, boolean brightTextOnDark) {
        int[] px = new int[src.length];
        for (int i = 0; i < src.length; i++) {
            boolean textPixel = brightTextOnDark ? lum[i] > avg + margin : lum[i] < avg - margin;
            px[i] = textPixel ? Color.BLACK : Color.WHITE;
        }
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        out.setPixels(px, 0, w, 0, 0, w, h);
        return out;
    }

    private static Bitmap contrastStretch(int[] src, int[] lum, int min, int max, int w, int h) {
        int range = Math.max(1, max - min);
        int[] px = new int[src.length];
        for (int i = 0; i < src.length; i++) {
            int v = Math.max(0, Math.min(255, ((lum[i] - min) * 255) / range));
            px[i] = Color.rgb(v, v, v);
        }
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        out.setPixels(px, 0, w, 0, 0, w, h);
        return out;
    }

    private static Bitmap invertedGrayscale(int[] src, int[] lum, int w, int h) {
        int[] px = new int[src.length];
        for (int i = 0; i < src.length; i++) {
            int v = 255 - lum[i];
            px[i] = Color.rgb(v, v, v);
        }
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        out.setPixels(px, 0, w, 0, 0, w, h);
        return out;
    }

    public static Double parseBestBpm(List<String> texts) {
        return parseBestBpmDetailed(texts).bpm;
    }

    public static Double parseSingleBpmVariant(String text) {
        if (text == null || text.trim().isEmpty()) return null;
        BpmParseDiagnostic d = parseBpmVariantDetailed(text);
        return d.accepted && d.extracted != null ? (double) d.extracted : null;
    }

    public static Double parseBpm(String raw) {
        if (raw == null) return null;
        return parseSingleBpmVariant(raw);
    }

    private static BpmParseDecision parseBestBpmDetailed(List<String> texts) {
        BpmParseDecision decision = new BpmParseDecision();
        if (texts == null || texts.isEmpty()) {
            decision.reason = "Rejet : aucun texte OCR brut reçu.";
            return decision;
        }

        java.util.Map<Integer, Integer> votes = new java.util.LinkedHashMap<>();
        Integer firstAccepted = null;
        for (String text : texts) {
            BpmParseDiagnostic d = parseBpmVariantDetailed(text);
            decision.diagnostics.add(d);
            if (d.accepted && d.extracted != null) {
                if (firstAccepted == null) firstAccepted = d.extracted;
                votes.merge(d.extracted, 1, Integer::sum);
            }
        }

        if (votes.isEmpty()) {
            StringBuilder why = new StringBuilder("Rejet : aucun BPM valide entre 40 et 240 après nettoyage/correction OCR.");
            for (BpmParseDiagnostic d : decision.diagnostics) {
                if (d.reason != null && !d.reason.isEmpty()) {
                    why.append(" Variante « ").append(previewForReason(d.raw)).append(" » : ").append(d.reason).append(".");
                }
            }
            decision.reason = why.toString();
            return decision;
        }

        int best = firstAccepted != null ? firstAccepted : votes.keySet().iterator().next();
        int bestCount = votes.getOrDefault(best, 0);
        for (java.util.Map.Entry<Integer, Integer> e : votes.entrySet()) {
            if (e.getValue() > bestCount) {
                best = e.getKey();
                bestCount = e.getValue();
            }
        }
        decision.bpm = (double) best;
        decision.reason = "Accepté : BPM " + best + " extrait après nettoyage/correction OCR (" + bestCount + " occurrence" + (bestCount > 1 ? "s" : "") + ").";
        return decision;
    }

    private static BpmParseDiagnostic parseBpmVariantDetailed(String raw) {
        BpmParseDiagnostic d = new BpmParseDiagnostic();
        d.raw = raw == null ? "" : raw;
        d.cleaned = cleanBpmOcrText(d.raw);
        d.corrected = correctBpmOcrText(d.cleaned);
        Integer labelled = extractLabelledBpm(d.corrected);
        if (labelled != null) {
            d.extracted = labelled;
            d.accepted = true;
            d.reason = "Accepté : nombre extrait après libellé BPM.";
            return d;
        }
        Integer loose = extractLooseBpm(d.corrected);
        if (loose != null) {
            d.extracted = loose;
            d.accepted = true;
            d.reason = "Accepté : nombre plausible extrait sans libellé BPM.";
            return d;
        }
        d.accepted = false;
        d.reason = "aucun nombre 40–240 détecté après suppression des espaces et correction des caractères ambigus";
        return d;
    }

    private static String cleanBpmOcrText(String input) {
        if (input == null) return "";
        String s = java.text.Normalizer.normalize(input, java.text.Normalizer.Form.NFKC);
        return s
                .replace('\u00A0', ' ')
                .replace('\u202F', ' ')
                .replace('\u2007', ' ')
                .replaceAll("[\\u200B-\\u200D\\uFEFF]", "")
                .replaceAll("[\\p{Cntrl}]+", " ")
                .replace('：', ':')
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static String correctBpmOcrText(String input) {
        if (input == null || input.isEmpty()) return "";
        String compactLabel = input
                .replaceAll("(?i)\\bB\\s*P\\s*M\\b", "BPM")
                .replaceAll("(?i)(?<![A-Z0-9])8\\s*P\\s*M\\b", "BPM")
                .replaceAll("(?i)B\\.\\s*P\\.\\s*M\\.", "BPM");
        StringBuilder out = new StringBuilder(compactLabel.length());
        for (int i = 0; i < compactLabel.length(); i++) {
            char ch = compactLabel.charAt(i);
            char prev = i > 0 ? compactLabel.charAt(i - 1) : '\0';
            char next = i + 1 < compactLabel.length() ? compactLabel.charAt(i + 1) : '\0';
            boolean digitContext = Character.isDigit(prev) || Character.isDigit(next) || prev == ':' || prev == '=' || prev == '-' || prev == ' ';
            if ((ch == 'I' || ch == 'i' || ch == 'l' || ch == '|' || ch == '!') && digitContext) out.append('1');
            else if ((ch == 'O' || ch == 'o') && digitContext) out.append('0');
            else if ((ch == 'S' || ch == 's') && digitContext) out.append('5');
            else if ((ch == 'Z' || ch == 'z') && digitContext) out.append('2');
            else if ((ch == 'G' || ch == 'g' || ch == 'Q' || ch == 'q') && digitContext) out.append('9');
            else if ((ch == 'B' || ch == 'b') && (Character.isDigit(prev) || Character.isDigit(next))) out.append('8');
            else out.append(ch);
        }
        return out.toString()
                .replaceAll("(?<=\\d)\\s+(?=\\d)", "")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static Integer extractLabelledBpm(String corrected) {
        if (corrected == null || corrected.isEmpty()) return null;
        Pattern labelled = Pattern.compile("(?i)B\\s*P\\s*M\\s*[:=\\-]?\\s*([0-9][0-9\\s\\u00A0\\u202F.,]{0,8})");
        Matcher m = labelled.matcher(corrected);
        while (m.find()) {
            Integer n = firstValidBpmFromToken(m.group(1));
            if (n != null) return n;
        }
        return null;
    }

    private static Integer extractLooseBpm(String corrected) {
        if (corrected == null || corrected.isEmpty()) return null;
        Pattern loose = Pattern.compile("(?<!\\d)([0-9](?:[0-9\\s\\u00A0\\u202F.,]{0,8}[0-9])?)(?!\\d)");
        Matcher m = loose.matcher(corrected);
        while (m.find()) {
            Integer n = firstValidBpmFromToken(m.group(1));
            if (n != null) return n;
        }
        return null;
    }

    private static Integer firstValidBpmFromToken(String token) {
        if (token == null) return null;
        String digits = token.replaceAll("\\D+", "");
        if (digits.length() < 2) return null;
        if (digits.length() <= 3) {
            Integer n = parseBpmInt(digits);
            if (n != null) return n;
        }
        for (int len : new int[] { 3, 2 }) {
            for (int i = 0; i + len <= digits.length(); i++) {
                Integer n = parseBpmInt(digits.substring(i, i + len));
                if (n != null) return n;
            }
        }
        return null;
    }

    private static Integer parseBpmInt(String s) {
        try {
            int v = Integer.parseInt(s);
            return v >= 40 && v <= 240 ? v : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String previewForReason(String text) {
        if (text == null) return "∅";
        String s = text.replaceAll("\\s+", " ").trim();
        return s.length() > 40 ? s.substring(0, 40) + "…" : s;
    }

    public static String extractDuration(String raw) {
        if (raw == null) return null;
        Matcher m = DURATION_PATTERN.matcher(raw);
        return m.find() ? m.group(0) : null;
    }

    public interface TapCallback {
        void onResult(boolean ok, String reason);
    }

    public void tapAt(final float x, final float y, final int durationMs, final TapCallback callback) {
        Path p = new Path();
        p.moveTo(x, y);
        GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(p, 0, Math.max(45, durationMs));
        GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();

        new Handler(Looper.getMainLooper()).post(() -> {
            boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
                @Override public void onCompleted(GestureDescription g) { callback.onResult(true, "completed"); }
                @Override public void onCancelled(GestureDescription g) { callback.onResult(false, "cancelled"); }
            }, null);
            if (!accepted) callback.onResult(false, "not-accepted");
        });
    }

    /**
     * Capture the current DiscDJ screen and return the bitmap crop
     * corresponding to a canonical-landscape rect. Used by the playlist
     * active-row detector.
     */
    public void captureZoneBitmap(final Rect displayCropRect, final String expectedPackage, final ZoneBitmapCallback cb) {
        int[] display = getDisplaySize();
        WindowSnapshot snap = getWindowSnapshot(expectedPackage);
        if (!snap.foregroundMatches) { cb.onResult(null, null, "DiscDJ n'est pas au premier plan."); return; }
        if (!snap.landscape) { cb.onResult(null, null, "DiscDJ doit être en mode paysage."); return; }
        if (!rectFullyVisible(displayCropRect, display[0], display[1])) { cb.onResult(null, null, "Zone playlist hors écran."); return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) { cb.onResult(null, null, "Capture indisponible : Android 11+ requis."); return; }
        Executor executor = command -> new Handler(Looper.getMainLooper()).post(command);
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, executor, new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult screenshot) {
                    Bitmap full;
                    try {
                        Bitmap hw = Bitmap.wrapHardwareBuffer(screenshot.getHardwareBuffer(), screenshot.getColorSpace());
                        if (hw == null) throw new IllegalStateException("buffer vide");
                        full = hw.copy(Bitmap.Config.ARGB_8888, false);
                        screenshot.getHardwareBuffer().close();
                    } catch (Exception e) {
                        cb.onResult(null, null, "Capture impossible : " + e.getMessage()); return;
                    }
                    if (full.getWidth() < full.getHeight()) { cb.onResult(null, null, "Capture reçue en portrait."); return; }
                    float sx = full.getWidth() / (float) display[0];
                    float sy = full.getHeight() / (float) display[1];
                    Rect crop = new Rect(
                            Math.round(displayCropRect.left * sx),
                            Math.round(displayCropRect.top * sy),
                            Math.round(displayCropRect.right * sx),
                            Math.round(displayCropRect.bottom * sy));
                    if (!rectFullyVisible(crop, full.getWidth(), full.getHeight())) { cb.onResult(null, null, "Zone playlist invalide dans la capture."); return; }
                    Bitmap cropped = Bitmap.createBitmap(full, crop.left, crop.top, crop.width(), crop.height());
                    String url = bitmapDataUrl(cropped, Bitmap.CompressFormat.JPEG, 70);
                    cb.onResult(cropped, url, null);
                }
                @Override public void onFailure(int errorCode) {
                    cb.onResult(null, null, "Capture refusée (code " + errorCode + ").");
                }
            });
        } catch (Exception e) {
            cb.onResult(null, null, "Capture impossible : " + e.getMessage());
        }
    }

    /** Run ML Kit OCR on all polarity variants of `bitmap` and merge line results. */
    public void ocrBitmapLines(final Bitmap bitmap, final OcrLinesCallback cb) {
        if (bitmap == null) { cb.onResult(new ArrayList<>()); return; }
        final List<Bitmap> variants = prepareOcrVariants(bitmap);
        if (variants.isEmpty()) variants.add(bitmap);
        final List<String> allTexts = new ArrayList<>();
        final int[] remaining = new int[] { variants.size() };
        for (Bitmap variant : variants) {
            TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
            recognizer.process(InputImage.fromBitmap(variant, 0))
                    .addOnSuccessListener(text -> {
                        synchronized (allTexts) { allTexts.addAll(extractOcrTexts(text)); }
                        recognizer.close();
                        synchronized (remaining) { if (--remaining[0] == 0) cb.onResult(uniq(allTexts)); }
                    })
                    .addOnFailureListener(e -> {
                        recognizer.close();
                        synchronized (remaining) { if (--remaining[0] == 0) cb.onResult(uniq(allTexts)); }
                    });
        }
    }

    private static List<String> uniq(List<String> in) {
        List<String> out = new ArrayList<>();
        for (String s : in) {
            if (s == null) continue;
            String t = s.trim();
            if (!t.isEmpty() && !out.contains(t)) out.add(t);
        }
        return out;
    }

    /** Expose the shared data-URL encoder for the plugin. */
    public static String bitmapToDataUrl(Bitmap bitmap, boolean png) {
        return bitmapDataUrl(bitmap, png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, png ? 100 : 80);
    }



    public interface CaptureCallback {
        void onResult(boolean cancelled, float nx, float ny, float nw, float nh);
    }

    private WindowManager windowManager;
    private View overlayView;

    private void removeOverlay() {
        if (overlayView != null && windowManager != null) {
            try { windowManager.removeView(overlayView); } catch (Exception ignored) {}
        }
        overlayView = null;
    }

    public void startCalibration(final boolean zone, final String instructions, final CaptureCallback cb) {
        new Handler(Looper.getMainLooper()).post(() -> {
            removeOverlay();
            windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            int[] size = getDisplaySize();
            CalibrationOverlay view = new CalibrationOverlay(this, zone, instructions, size[0], size[1], (cancelled, nx, ny, nw, nh) -> {
                removeOverlay();
                cb.onResult(cancelled, nx, ny, nw, nh);
            });
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            }
            overlayView = view;
            try {
                windowManager.addView(view, lp);
            } catch (Exception e) {
                overlayView = null;
                cb.onResult(true, 0, 0, 0, 0);
            }
        });
    }

    private static class CalibrationOverlay extends View {
        private final boolean zone;
        private final String instructions;
        private final CaptureCallback cb;
        private final int refW;
        private final int refH;
        private final Paint scrim = new Paint();
        private final Paint markerStroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint markerDot = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint zoneFill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint textBg = new Paint();
        private float downX, downY, curX, curY;
        private boolean hasPoint = false;

        CalibrationOverlay(Context ctx, boolean zone, String instructions, int refW, int refH, CaptureCallback cb) {
            super(ctx);
            this.zone = zone;
            this.instructions = instructions != null ? instructions : "";
            this.cb = cb;
            this.refW = refW;
            this.refH = refH;
            scrim.setColor(Color.argb(60, 0, 0, 0));
            markerStroke.setColor(Color.rgb(250, 204, 21));
            markerStroke.setStyle(Paint.Style.STROKE);
            markerStroke.setStrokeWidth(2f);
            markerDot.setColor(Color.rgb(250, 204, 21));
            markerDot.setStyle(Paint.Style.FILL);
            zoneFill.setColor(Color.argb(70, 250, 204, 21));
            zoneFill.setStyle(Paint.Style.FILL);
            text.setColor(Color.WHITE);
            text.setTextSize(36f);
            text.setFakeBoldText(true);
            textBg.setColor(Color.argb(210, 15, 23, 42));
            setFocusableInTouchMode(true);
        }

        @Override
        protected void onDraw(Canvas c) {
            super.onDraw(c);
            c.drawRect(0, 0, getWidth(), getHeight(), scrim);
            float pad = 24f;
            c.drawRect(0, 28, getWidth(), 138, textBg);
            drawWrapped(c, instructions, pad, 60f);
            c.drawText("Appuie sur RETOUR pour annuler.", pad, 124f, hintPaint());
            if (!hasPoint) return;
            if (zone) {
                float l = Math.min(downX, curX), t = Math.min(downY, curY);
                float r = Math.max(downX, curX), b = Math.max(downY, curY);
                c.drawRect(l, t, r, b, zoneFill);
                Paint stroke = new Paint(markerStroke);
                stroke.setStrokeWidth(3f);
                c.drawRect(l, t, r, b, stroke);
            } else {
                c.drawCircle(curX, curY, 1.5f, markerDot);
                c.drawCircle(curX, curY, 6f, markerStroke);
                c.drawLine(curX - 10, curY, curX - 3, curY, markerStroke);
                c.drawLine(curX + 3, curY, curX + 10, curY, markerStroke);
                c.drawLine(curX, curY - 10, curX, curY - 3, markerStroke);
                c.drawLine(curX, curY + 3, curX, curY + 10, markerStroke);
            }
        }

        private Paint hintPaint() {
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            p.setColor(Color.rgb(148, 163, 184));
            p.setTextSize(24f);
            return p;
        }

        private void drawWrapped(Canvas c, String s, float x, float y) {
            String[] words = s.split(" ");
            StringBuilder line = new StringBuilder();
            float maxW = getWidth() - x * 2;
            float ly = y;
            for (String w : words) {
                String test = line.length() == 0 ? w : line + " " + w;
                if (text.measureText(test) > maxW && line.length() > 0) {
                    c.drawText(line.toString(), x, ly, text);
                    ly += 40f;
                    line = new StringBuilder(w);
                } else line = new StringBuilder(test);
            }
            if (line.length() > 0) c.drawText(line.toString(), x, ly, text);
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = curX = e.getRawX(); downY = curY = e.getRawY(); hasPoint = true; invalidate(); return true;
                case MotionEvent.ACTION_MOVE:
                    curX = e.getRawX(); curY = e.getRawY(); invalidate(); return true;
                case MotionEvent.ACTION_UP:
                    curX = e.getRawX(); curY = e.getRawY(); finish(); return true;
            }
            return true;
        }

        @Override
        public boolean dispatchKeyEventPreIme(android.view.KeyEvent event) {
            int keyCode = event != null ? event.getKeyCode() : 0;
            if (keyCode == android.view.KeyEvent.KEYCODE_BACK) { cb.onResult(true, 0, 0, 0, 0); return true; }
            return super.dispatchKeyEventPreIme(event);
        }

        private void finish() {
            float sw = refW > 0 ? refW : getWidth();
            float sh = refH > 0 ? refH : getHeight();
            if (sw <= 0 || sh <= 0) { cb.onResult(true, 0, 0, 0, 0); return; }
            if (zone) {
                float l = Math.min(downX, curX), t = Math.min(downY, curY);
                float r = Math.max(downX, curX), b = Math.max(downY, curY);
                if (r - l < 12 || b - t < 12) { cb.onResult(true, 0, 0, 0, 0); return; }
                float[] a = pointToCanonical(l, t, (int) sw, (int) sh);
                float[] btm = pointToCanonical(r, b, (int) sw, (int) sh);
                float x1 = Math.min(a[0], btm[0]), y1 = Math.min(a[1], btm[1]);
                float x2 = Math.max(a[0], btm[0]), y2 = Math.max(a[1], btm[1]);
                cb.onResult(false, x1, y1, x2 - x1, y2 - y1);
            } else {
                float[] p = pointToCanonical(curX, curY, (int) sw, (int) sh);
                cb.onResult(false, p[0], p[1], 0, 0);
            }
        }
    }

    private static float clamp(float v) {
        if (Float.isNaN(v) || Float.isInfinite(v)) return 0f;
        return Math.max(0f, Math.min(1f, v));
    }
}