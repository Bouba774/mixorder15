package app.mixorder.discdjrobot;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Rect;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * DiscDJ robot Capacitor plugin.
 *
 * Thin JS ⇄ Android bridge: readiness reporting, launching DiscDJ, taking a
 * BPM reading (delegated to the AccessibilityService), and dispatching a
 * tap on the calibrated deck's "Next" button.
 *
 * ALL coordinates flowing through this plugin are fractions of one canonical
 * LANDSCAPE display frame. Direct overlay calibration and screenshot import
 * both convert into that frame; tap/crop operations convert it back to the
 * current display pixels exactly once, with no offset or zone adjustment.
 */
@CapacitorPlugin(name = "DiscDJRobot")
public class DiscDJRobotPlugin extends Plugin {

    private static final String[] DISCDJ_PACKAGES = new String[] {
            "com.beatronik.djstudio",
            "com.beatronik.djstudiodemo",
            "com.beatronik.discdj",
    };

    private static final String[] PKG_HINTS = new String[] {
            "discdj", "disc.dj", "beatronik", "djstudio", "dj.studio",
    };
    private static final String[] LABEL_HINTS = new String[] {
            "discdj", "disc dj", "dj studio",
    };

    @PluginMethod
    public void isReady(PluginCall call) {
        Context ctx = getContext();
        String pkg = findInstalledDiscDJPackage(ctx);
        boolean installed = pkg != null;
        boolean a11y = isAccessibilityServiceEnabled(ctx);

        JSObject r = new JSObject();
        r.put("discdjInstalled", installed);
        r.put("accessibilityEnabled", a11y);
        r.put("packageName", pkg);

        DiscDJAccessibilityService svc = DiscDJAccessibilityService.getInstance();
        if (svc != null && pkg != null) {
            DiscDJAccessibilityService.WindowSnapshot snap = svc.getWindowSnapshot(pkg);
            r.put("foreground", snap.foregroundMatches);
            r.put("orientation", snap.landscape ? "landscape" : "portrait");
            r.put("displayWidth", snap.displayWidth);
            r.put("displayHeight", snap.displayHeight);
            r.put("windowPackage", snap.packageName);
        }

        // Readiness is capability-based, not OCR-based. Once DiscDJ is opened
        // and the configured load delay has elapsed, the robot considers it
        // ready unless a real anomaly is found by the preflight/read path.
        boolean ready = installed && a11y;
        r.put("ready", ready);
        if (!installed) {
            r.put("reason", "DiscDJ n'est pas installé sur cet appareil.");
        } else if (!a11y) {
            r.put("reason", "Active le service d'accessibilité \"MixOrder DiscDJ Robot\" dans les paramètres Android.");
        }
        call.resolve(r);
    }

    @PluginMethod
    public void openApp(PluginCall call) {
        Context ctx = getContext();
        String pkg = findInstalledDiscDJPackage(ctx);
        if (pkg == null) {
            call.reject("DiscDJ n'est pas installé.");
            return;
        }
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
        if (launch == null) {
            call.reject("Impossible de lancer DiscDJ.");
            return;
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        ctx.startActivity(launch);
        call.resolve();
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void captureCalibration(PluginCall call) {
        DiscDJAccessibilityService svc = DiscDJAccessibilityService.getInstance();
        if (svc == null) {
            call.reject("Service d'accessibilité désactivé.");
            return;
        }
        String kind = call.getString("kind", "point");
        String instructions = call.getString("instructions", "Touche l'emplacement à calibrer");
        final boolean zone = "zone".equals(kind);
        svc.startCalibration(zone, instructions, (cancelled, nx, ny, nw, nh) -> {
            JSObject r = new JSObject();
            if (cancelled) {
                r.put("cancelled", true);
                r.put("x", 0);
                r.put("y", 0);
                call.resolve(r);
                return;
            }
            r.put("x", (double) nx);
            r.put("y", (double) ny);
            if (zone) {
                r.put("width", (double) nw);
                r.put("height", (double) nh);
            }
            call.resolve(r);
        });
    }

    @PluginMethod
    public void readBpm(PluginCall call) {
        JSObject bpmZone = call.getObject("bpmZone");
        DiscDJAccessibilityService svc = DiscDJAccessibilityService.getInstance();
        String pkg = findInstalledDiscDJPackage(getContext());

        JSObject out = new JSObject();
        out.put("bpm", (Double) null);
        out.put("raw", (String) null);
        out.put("title", (String) null);
        out.put("duration", (String) null);
        out.put("zoneTexts", new JSArray());
        out.put("parseReason", (String) null);
        out.put("sourceOk", false);
        out.put("orientationOk", false);
        out.put("displayWidth", 0);
        out.put("displayHeight", 0);

        if (svc == null) {
            out.put("parseReason", "Service d'accessibilité désactivé.");
            call.resolve(out);
            return;
        }
        if (pkg == null) {
            out.put("parseReason", "DiscDJ n'est pas installé ou son package est introuvable.");
            call.resolve(out);
            return;
        }

        DiscDJAccessibilityService.WindowSnapshot snap = svc.getWindowSnapshot(pkg);
        out.put("sourcePackage", snap.packageName);
        out.put("sourceOk", snap.foregroundMatches);
        out.put("orientationOk", snap.landscape);
        out.put("displayWidth", snap.displayWidth);
        out.put("displayHeight", snap.displayHeight);

        if (!snap.foregroundMatches) {
            out.put("parseReason", "Mauvaise source de capture : DiscDJ n'est pas au premier plan.");
            call.resolve(out);
            return;
        }
        if (!snap.landscape) {
            out.put("parseReason", "Orientation incorrecte : DiscDJ doit être en mode paysage pour conserver des coordonnées cohérentes.");
            call.resolve(out);
            return;
        }

        DiscDJAccessibilityService.ScanResult scan = svc.scanDiscDJWindow(pkg);

        int screenW = scan.displayWidth > 0 ? scan.displayWidth : svc.getDisplaySize()[0];
        int screenH = scan.displayHeight > 0 ? scan.displayHeight : svc.getDisplaySize()[1];

        Rect zone = rectFromNormalized(bpmZone, screenW, screenH);
        if (zone == null) {
            out.put("parseReason", "Zone BPM non calibrée.");
            call.resolve(out);
            return;
        }
        if (!DiscDJAccessibilityService.rectFullyVisible(zone, screenW, screenH)) {
            out.put("parseReason", "Zone OCR hors écran ou invalide après conversion des coordonnées.");
            call.resolve(out);
            return;
        }

        JSObject rect = new JSObject();
        rect.put("left", zone.left);
        rect.put("top", zone.top);
        rect.put("right", zone.right);
        rect.put("bottom", zone.bottom);
        rect.put("width", zone.width());
        rect.put("height", zone.height());
        out.put("ocrRect", rect);

        // Best-effort title / duration lookup from DiscDJ's app window only.
        String title = findLikelyTitle(scan.allText, zone, screenW);
        String duration = null;
        for (DiscDJAccessibilityService.TextHit h : scan.allText) {
            String d = DiscDJAccessibilityService.extractDuration(h.text);
            if (d != null) { duration = d; break; }
        }
        out.put("title", title);
        out.put("duration", duration);

        svc.readBpmFromScreenshot(zone, pkg, result -> {
            out.put("bpm", result.bpm);
            out.put("raw", result.raw);
            JSArray zoneTexts = new JSArray();
            for (String text : result.zoneTexts) zoneTexts.put(text);
            out.put("zoneTexts", zoneTexts);
            out.put("ocrVariants", zoneTexts);
            JSArray bpmDiagnostics = new JSArray();
            for (DiscDJAccessibilityService.BpmParseDiagnostic d : result.bpmDiagnostics) {
                JSObject item = new JSObject();
                item.put("raw", d.raw);
                item.put("cleaned", d.cleaned);
                item.put("corrected", d.corrected);
                if (d.extracted != null) item.put("extracted", d.extracted);
                else item.put("extracted", (Integer) null);
                item.put("accepted", d.accepted);
                item.put("reason", d.reason);
                bpmDiagnostics.put(item);
            }
            out.put("bpmDiagnostics", bpmDiagnostics);
            out.put("parseReason", result.parseReason);
            out.put("sourcePackage", result.sourcePackage);
            out.put("sourceOk", result.sourceOk);
            out.put("displayWidth", result.displayWidth);
            out.put("displayHeight", result.displayHeight);
            out.put("fullScreenshot", result.fullScreenshotDataUrl);
            out.put("croppedImage", result.croppedDataUrl);
            out.put("ocrInputImage", result.ocrInputDataUrl);
            JSObject crop = new JSObject();
            crop.put("left", result.cropRect.left);
            crop.put("top", result.cropRect.top);
            crop.put("right", result.cropRect.right);
            crop.put("bottom", result.cropRect.bottom);
            crop.put("width", result.cropRect.width());
            crop.put("height", result.cropRect.height());
            out.put("ocrRect", crop);
            call.resolve(out);
        });
    }

    /**
     * AutoSync-name: capture the full playlist zone, run the blue-row
     * detector to find the currently loaded row, then OCR only that row.
     */
    @PluginMethod
    public void readPlaylistActiveName(PluginCall call) {
        JSObject playlistZone = call.getObject("playlistZone");
        DiscDJAccessibilityService svc = DiscDJAccessibilityService.getInstance();
        String pkg = findInstalledDiscDJPackage(getContext());

        JSObject out = new JSObject();
        out.put("name", (String) null);
        out.put("raw", (String) null);
        out.put("zoneTexts", new JSArray());
        out.put("reason", (String) null);
        out.put("zoneImage", (String) null);
        out.put("activeRowImage", (String) null);
        out.put("activeRowFraction", (JSObject) null);

        if (svc == null) { out.put("reason", "accessibility-disabled"); call.resolve(out); return; }
        if (pkg == null) { out.put("reason", "discdj-not-installed"); call.resolve(out); return; }

        int[] size = svc.getDisplaySize();
        Rect zone = rectFromNormalized(playlistZone, size[0], size[1]);
        if (zone == null) { out.put("reason", "playlist-zone-not-calibrated"); call.resolve(out); return; }

        svc.captureZoneBitmap(zone, pkg, (bitmap, zoneDataUrl, err) -> {
            if (bitmap == null) {
                out.put("reason", err != null ? err : "capture-failed");
                if (zoneDataUrl != null) out.put("zoneImage", zoneDataUrl);
                call.resolve(out);
                return;
            }
            out.put("zoneImage", zoneDataUrl);
            PlaylistRowDetector.Result det = PlaylistRowDetector.findActiveRow(bitmap);
            if (det.rowRect == null) {
                out.put("reason", "no-active-row");
                call.resolve(out);
                return;
            }
            int bw = bitmap.getWidth();
            int bh = bitmap.getHeight();
            JSObject frac = new JSObject();
            frac.put("x", det.rowRect.left / (double) bw);
            frac.put("y", det.rowRect.top / (double) bh);
            frac.put("width", det.rowRect.width() / (double) bw);
            frac.put("height", det.rowRect.height() / (double) bh);
            out.put("activeRowFraction", frac);

            android.graphics.Bitmap row = android.graphics.Bitmap.createBitmap(
                    bitmap,
                    det.rowRect.left, det.rowRect.top,
                    det.rowRect.width(), det.rowRect.height());
            out.put("activeRowImage", DiscDJAccessibilityService.bitmapToDataUrl(row, true));

            svc.ocrBitmapLines(row, lines -> {
                JSArray arr = new JSArray();
                StringBuilder joined = new StringBuilder();
                for (String s : lines) {
                    arr.put(s);
                    if (joined.length() > 0) joined.append(' ');
                    joined.append(s);
                }
                out.put("zoneTexts", arr);
                String raw = joined.toString();
                out.put("raw", raw);
                String name = cleanPlaylistRowText(raw);
                out.put("name", name.isEmpty() ? null : name);
                if (name.isEmpty()) out.put("reason", "ocr-empty");
                call.resolve(out);
            });
        });
    }

    /** Light cleanup mirroring the JS-side cleanOcrText — DiscDJ overlays a lot of parasitic labels. */
    private static String cleanPlaylistRowText(String input) {
        if (input == null) return "";
        String s = input.replaceAll("[\\p{Cntrl}]+", " ")
                .replaceAll("[·•●▪■□]", " ")
                .replaceAll("(?i)\\.(mp3|wav|flac|m4a|aac|ogg|wma|aiff)\\b", "")
                .replaceAll("(?i)\\bbpm\\s*[:=]?\\s*\\d{2,3}(?:[.,]\\d+)?\\b", " ")
                .replaceAll("^\\s*\\d{1,4}\\s*[_\\-–—.:]+\\s*", "")
                .replaceAll("[_\\-–—.·|/\\\\]+", " ")
                .replaceAll("\\s+", " ")
                .trim();
        return s;
    }

    @PluginMethod
    public void checkReady(PluginCall call) {
        DiscDJAccessibilityService svc = DiscDJAccessibilityService.getInstance();
        String pkg = findInstalledDiscDJPackage(getContext());
        JSObject out = new JSObject();
        out.put("ok", false);
        out.put("sourceOk", false);
        out.put("orientationOk", false);
        if (svc == null) {
            out.put("reason", "Service d'accessibilité désactivé.");
            call.resolve(out);
            return;
        }
        if (pkg == null) {
            out.put("reason", "DiscDJ est introuvable sur cet appareil.");
            call.resolve(out);
            return;
        }
        DiscDJAccessibilityService.WindowSnapshot a = svc.getWindowSnapshot(pkg);
        try { Thread.sleep(180); } catch (InterruptedException ignored) {}
        DiscDJAccessibilityService.WindowSnapshot b = svc.getWindowSnapshot(pkg);
        boolean stable = a.foregroundMatches && b.foregroundMatches
                && a.landscape && b.landscape
                && Math.abs(a.childCount - b.childCount) <= 4;
        boolean ok = b.foregroundMatches && b.landscape && stable;
        out.put("ok", ok);
        out.put("sourceOk", b.foregroundMatches);
        out.put("orientationOk", b.landscape);
        out.put("stable", stable);
        out.put("packageName", pkg);
        out.put("windowPackage", b.packageName);
        out.put("displayWidth", b.displayWidth);
        out.put("displayHeight", b.displayHeight);
        if (!b.foregroundMatches) out.put("reason", "DiscDJ n'est pas au premier plan.");
        else if (!b.landscape) out.put("reason", "DiscDJ doit être en mode paysage.");
        else if (!stable) out.put("reason", "Interface DiscDJ encore instable : augmente l'attente de chargement ou réessaie.");
        call.resolve(out);
    }

    @SuppressWarnings("unused")
    private void legacyAccessibilityRead(PluginCall call) {
        // Kept out of the runtime path intentionally: OCR must use a real
        // screenshot crop of DiscDJ, not global node text that may include
        // overlays or MixOrder panels.
        /*

        // Collect every text hit whose CENTER lies inside the calibrated
        // zone. No expansion, no shifting — strictly what the user drew.
        JSArray zoneTexts = new JSArray();
        StringBuilder combined = new StringBuilder();
        DiscDJAccessibilityService.TextHit bpmHit = null;
        for (DiscDJAccessibilityService.TextHit h : scan.allText) {
            int cx = h.bounds.centerX();
            int cy = h.bounds.centerY();
            if (!zone.contains(cx, cy)) continue;
            zoneTexts.put(h.text);
            if (combined.length() > 0) combined.append(' ');
            combined.append(h.text);
            if (bpmHit == null) bpmHit = h;
        }
        out.put("zoneTexts", zoneTexts);

        if (combined.length() == 0) {
            out.put("parseReason", "Aucun texte détecté dans la zone calibrée. Recalibre la zone BPM plus large ou plus précise.");
            call.resolve(out);
            return;
        }

        String rawJoined = combined.toString();
        out.put("raw", rawJoined);

        Double bpm = DiscDJAccessibilityService.parseBpm(rawJoined);
        if (bpm != null) {
            out.put("bpm", bpm);
        } else {
            out.put("parseReason",
                    "Texte lu \"" + rawJoined + "\" mais aucun nombre valide entre 40 et 240 après \"BPM:\".");
        }

        // Best-effort title / duration lookup — searches the full window
        // (not the tiny BPM zone). Only heuristics, never used for the BPM.
        String title = findLikelyTitle(scan.allText, zone, screenW);
        String duration = null;
        for (DiscDJAccessibilityService.TextHit h : scan.allText) {
            String d = DiscDJAccessibilityService.extractDuration(h.text);
            if (d != null) { duration = d; break; }
        }
        out.put("title", title);
        out.put("duration", duration);
        call.resolve(out);
         */
    }

    private static String findLikelyTitle(
            List<DiscDJAccessibilityService.TextHit> hits,
            Rect bpmZone,
            int screenW
    ) {
        // Prefer the longest text on the SAME horizontal half of the screen
        // as the calibrated BPM zone, excluding the BPM line itself.
        boolean bpmIsLeft = bpmZone.centerX() < screenW / 2;
        int longest = 0;
        String best = null;
        for (DiscDJAccessibilityService.TextHit h : hits) {
            String t = h.text;
            if (t == null || t.isEmpty()) continue;
            if (t.toUpperCase().contains("BPM")) continue;
            boolean isLeft = h.bounds.centerX() < screenW / 2;
            if (isLeft != bpmIsLeft) continue;
            if (t.length() > longest) {
                longest = t.length();
                best = t;
            }
        }
        if (best != null) {
            String cleaned = best.replaceAll("\\d{1,2}:\\d{2}(?::\\d{2})?", "").trim();
            if (!cleaned.isEmpty()) return cleaned;
        }
        return best;
    }

    @PluginMethod
    public void tapNext(PluginCall call) {
        DiscDJAccessibilityService svc = DiscDJAccessibilityService.getInstance();
        if (svc == null) {
            call.reject("Service d'accessibilité désactivé.");
            return;
        }
        JSObject point = call.getObject("point");
        if (point == null) {
            call.reject("Point Next non calibré.");
            return;
        }

        int[] size = svc.getDisplaySize();
        int screenW = size[0], screenH = size[1];
        float[] xy = pointFromNormalized(point, screenW, screenH);
        if (xy == null) {
            call.reject("Point Next invalide.");
            return;
        }

        // IMPORTANT: no click offset is applied. The tap lands EXACTLY on
        // the point the user calibrated. clickOffsetX/Y are accepted only
        // for backwards compatibility and are always ignored.
        int pressDurationMs = call.getInt("pressDurationMs", 120);

        svc.tapAt(xy[0], xy[1], pressDurationMs, (ok, reason) -> {
            if (ok) {
                JSObject r = new JSObject();
                r.put("ok", true);
                r.put("x", xy[0]);
                r.put("y", xy[1]);
                call.resolve(r);
            } else {
                call.reject("Geste annulé ou refusé: " + reason);
            }
        });
    }

    // ─── helpers ────────────────────────────────────────────────────────

    private static String findInstalledDiscDJPackage(Context ctx) {
        PackageManager pm = ctx.getPackageManager();

        for (String pkg : DISCDJ_PACKAGES) {
            if (pm.getLaunchIntentForPackage(pkg) != null) return pkg;
            try {
                pm.getPackageInfo(pkg, 0);
                return pkg;
            } catch (PackageManager.NameNotFoundException ignored) {
                // try next
            }
        }

        try {
            List<ApplicationInfo> apps = pm.getInstalledApplications(0);
            String labelMatch = null;
            for (ApplicationInfo ai : apps) {
                if (ai == null || ai.packageName == null) continue;
                if (pm.getLaunchIntentForPackage(ai.packageName) == null) continue;

                String pkg = ai.packageName.toLowerCase();
                for (String hint : PKG_HINTS) {
                    if (pkg.contains(hint)) return ai.packageName;
                }

                if (labelMatch == null) {
                    CharSequence lbl = pm.getApplicationLabel(ai);
                    if (!TextUtils.isEmpty(lbl)) {
                        String label = lbl.toString().toLowerCase();
                        for (String hint : LABEL_HINTS) {
                            if (label.contains(hint)) {
                                labelMatch = ai.packageName;
                                break;
                            }
                        }
                    }
                }
            }
            if (labelMatch != null) return labelMatch;
        } catch (Exception ignored) {
            // enumeration may be blocked on some devices — fall through
        }
        return null;
    }

    private static boolean isAccessibilityServiceEnabled(Context ctx) {
        AccessibilityManager am = (AccessibilityManager) ctx.getSystemService(Context.ACCESSIBILITY_SERVICE);
        if (am == null || !am.isEnabled()) return false;
        List<AccessibilityServiceInfo> services =
                am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
        String ours = new ComponentName(ctx, DiscDJAccessibilityService.class).flattenToString();
        String oursShort = new ComponentName(ctx, DiscDJAccessibilityService.class).flattenToShortString();
        for (AccessibilityServiceInfo info : services) {
            String id = info.getId();
            if (id == null) continue;
            if (id.equals(ours) || id.equals(oursShort) || id.endsWith(DiscDJAccessibilityService.class.getName())) {
                return true;
            }
        }
        return false;
    }

    /** Canonical landscape (nx, ny) → absolute screen (x, y) in current orientation. */
    private static float[] pointFromNormalized(JSObject point, int screenW, int screenH) {
        if (point == null || screenW <= 0 || screenH <= 0) return null;
        double nx = point.optDouble("x", -1.0);
        double ny = point.optDouble("y", -1.0);
        if (nx < 0 || ny < 0) return null;
        nx = Math.max(0, Math.min(1, nx));
        ny = Math.max(0, Math.min(1, ny));
        return DiscDJAccessibilityService.pointFromCanonical((float) nx, (float) ny, screenW, screenH);
    }

    /** Canonical landscape rect → absolute screen rect in current orientation. */
    private static Rect rectFromNormalized(JSObject rect, int screenW, int screenH) {
        if (rect == null || screenW <= 0 || screenH <= 0) return null;
        double x = rect.optDouble("x", -1.0);
        double y = rect.optDouble("y", -1.0);
        double w = rect.optDouble("width", -1.0);
        double h = rect.optDouble("height", -1.0);
        if (x < 0 || y < 0 || w <= 0 || h <= 0) return null;
        x = Math.max(0, Math.min(1, x));
        y = Math.max(0, Math.min(1, y));
        w = Math.max(0.005, Math.min(1 - x, w));
        h = Math.max(0.005, Math.min(1 - y, h));
        return DiscDJAccessibilityService.rectFromCanonical(x, y, w, h, screenW, screenH);
    }

    // ─── Background foreground service bridge ─────────────────────────────

    @Override
    public void load() {
        super.load();
        DiscDJRobotService.setListener((name, payload) -> {
            JSObject js = new JSObject();
            try {
                java.util.Iterator<String> keys = payload.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    js.put(k, payload.get(k));
                }
            } catch (Exception ignored) {}
            notifyListeners(name, js);
        });
        try {
            org.json.JSONObject saved = DiscDJRobotService.readSavedState(getContext());
            if (saved != null && saved.optBoolean("interrupted", false)) {
                JSObject js = new JSObject();
                java.util.Iterator<String> keys = saved.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    js.put(k, saved.get(k));
                }
                notifyListeners("discdjResumeAvailable", js);
            }
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void startBackgroundRun(PluginCall call) {
        Context ctx = getContext();
        String pkg = findInstalledDiscDJPackage(ctx);
        if (pkg == null) { call.reject("DiscDJ introuvable."); return; }
        JSObject data = call.getData();
        try {
            org.json.JSONObject payload = new org.json.JSONObject(data.toString());
            payload.put("discdjPackage", pkg);
            Intent i = new Intent(ctx, DiscDJRobotService.class);
            i.setAction(DiscDJRobotService.ACTION_START);
            i.putExtra("payload", payload.toString());
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Payload invalide: " + e.getMessage());
        }
    }

    @PluginMethod
    public void pauseBackgroundRun(PluginCall call) {
        sendServiceAction(DiscDJRobotReceiver.ACTION_PAUSE);
        call.resolve();
    }

    @PluginMethod
    public void resumeBackgroundRun(PluginCall call) {
        sendServiceAction(DiscDJRobotReceiver.ACTION_RESUME);
        call.resolve();
    }

    @PluginMethod
    public void stopBackgroundRun(PluginCall call) {
        sendServiceAction(DiscDJRobotReceiver.ACTION_STOP);
        call.resolve();
    }

    @PluginMethod
    public void clearBackgroundState(PluginCall call) {
        DiscDJRobotService.clearSavedState(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getBackgroundStatus(PluginCall call) {
        JSObject r = new JSObject();
        DiscDJRobotService svc = DiscDJRobotService.getInstance();
        try {
            org.json.JSONObject status;
            if (svc != null) {
                status = svc.getStatus();
            } else {
                org.json.JSONObject saved = DiscDJRobotService.readSavedState(getContext());
                status = new org.json.JSONObject();
                status.put("running", false);
                status.put("interrupted", saved != null && saved.optBoolean("interrupted", false));
                if (saved != null) {
                    status.put("lastPath", saved.optString("lastPath", null));
                    status.put("savedIndex", saved.optInt("index", 0));
                    status.put("savedTotal", saved.optInt("total", 0));
                    status.put("savedProjectFingerprint", saved.optString("projectFingerprint", null));
                    status.put("savedProjectName", saved.optString("projectName", null));
                    status.put("savedDeck", saved.optInt("deck", 1));
                }
            }
            java.util.Iterator<String> keys = status.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                r.put(k, status.get(k));
            }
        } catch (Exception ignored) {}
        call.resolve(r);
    }

    private void sendServiceAction(String action) {
        Intent i = new Intent(getContext(), DiscDJRobotService.class);
        i.setAction(action);
        try { getContext().startService(i); } catch (Exception ignored) {}
    }

    /**
     * Native-backed sleep. Resolves after `ms` milliseconds using a background
     * Handler that Android does NOT throttle when the WebView is offscreen —
     * unlike JS setTimeout, which is heavily throttled once MixOrder loses
     * focus (typical when the user switches to DiscDJ during a run).
     */
    @PluginMethod
    public void sleep(PluginCall call) {
        long ms = Math.max(0, call.getLong("ms", 0L));
        new android.os.Handler(android.os.Looper.getMainLooper())
                .postDelayed(call::resolve, ms);
    }
}

