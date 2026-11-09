package tools.premade.vault;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/**
 * One WebView. Not paired: a local page that says how to pair. Paired but missing a permission: the local
 * setup page. Otherwise the Vault screens served by the PC, with a local page when the PC can't be reached.
 */
public class MainActivity extends Activity {
    static volatile boolean visible;
    private WebView web;
    private android.webkit.ValueCallback<Uri[]> picked; // the page's file picker (Converter), waiting for a choice
    private static final int PICK = 7;
    private android.media.MediaRecorder rec; // Transcribe's Record button
    private java.io.File recFile;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(Color.parseColor("#151012"));
        getWindow().setNavigationBarColor(Color.parseColor("#151012"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0809"));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "Vault");
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override public android.graphics.Bitmap getDefaultVideoPoster() {
                return android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888); // no grey play-button poster
            }
            @Override public boolean onShowFileChooser(WebView v, android.webkit.ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (picked != null) picked.onReceiveValue(null);
                picked = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(Intent.createChooser(i, "Pick files"), PICK); }
                catch (Exception e) { picked = null; return false; }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("file".equals(u.getScheme()) || (u.getHost() + ":" + u.getPort()).equals(Vault.host(MainActivity.this))
                        || u.getHost() != null && u.getHost().equals(Uri.parse(Vault.prefs(MainActivity.this).getString("away", "")).getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u)); // anything else opens outside the app
                return true;
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (!r.isForMainFrame()) return;
                String away = Vault.prefs(MainActivity.this).getString("away", null);
                // The PC is out of reach: the same app from the relay, which works on the phone alone (once it was opened there with a signal, it's kept offline too).
                if (away != null && !r.getUrl().toString().startsWith(away.substring(0, away.indexOf("/m/")))) v.loadUrl(away);
                else v.loadUrl("file:///android_asset/offline.html");
            }
        });
        web.setDownloadListener((url, ua, disposition, mime, len) -> {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, disposition, mime));
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            getSystemService(DownloadManager.class).enqueue(req);
        });
        setContentView(web);
        if (!handlePair(getIntent())) show();
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        if (!handlePair(i)) show();
    }

    @Override protected void onResume() {
        super.onResume();
        visible = true;
        Updater.opened(this);
        web.evaluateJavascript("window.vaultRefresh && vaultRefresh()", null);
        if (Vault.paired(this)) new Thread(() -> Updater.check(this, this)).start();
    }

    @Override protected void onPause() {
        super.onPause();
        visible = false;
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != PICK || picked == null) return;
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                out = new Uri[data.getClipData().getItemCount()];
                for (int k = 0; k < out.length; k++) out[k] = data.getClipData().getItemAt(k).getUri();
            } else if (data.getData() != null) out = new Uri[]{data.getData()};
        }
        picked.onReceiveValue(out);
        picked = null;
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    private void show() {
        if (!Vault.paired(this)) web.loadUrl("file:///android_asset/setup.html#pair");
        else if (!Vault.allFiles() || !Vault.prefs(this).getBoolean("setupDone", false)) web.loadUrl("file:///android_asset/setup.html");
        else {
            WatchJob.schedule(this);
            WatchJob.now(this);
            Drops.registerPush(this);
            String tool = getIntent().getStringExtra("tool"); // a File drop notification was tapped
            setIntent(new Intent());
            new Thread(() -> {
                boolean home = Vault.canReachHome(this); // picks the home or the Tailscale address
                String away = Vault.prefs(this).getString("away", null);
                runOnUiThread(() -> web.loadUrl(!home && away != null ? away
                        : "http://" + Vault.host(this) + "/m/#t=" + Vault.token(this) + (tool != null ? "&tool=" + Uri.encode(tool) : "")));
            }).start();
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
                    && !Vault.prefs(this).getBoolean("askedNotify", false)) { // once: File drop says when something arrives
                Vault.prefs(this).edit().putBoolean("askedNotify", true).apply();
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 9);
            }
        }
    }

    /** premadetools://pair?host=…&code=… from the pairing page the PC's QR code opens. */
    private boolean handlePair(Intent i) {
        Uri u = i.getData();
        if (u == null || !"premadetools".equals(u.getScheme())) return false;
        String host = u.getQueryParameter("host"), code = u.getQueryParameter("code");
        setIntent(new Intent());
        web.loadUrl("file:///android_asset/setup.html#pairing");
        new Thread(() -> {
            String err = null;
            try {
                Vault.prefs(this).edit().putString("host", host).putString("lan", host).remove("ts").remove("away").remove("token").apply();
                JSONObject r = new JSONObject(Vault.call(this, "POST", "/api/pair", new JSONObject()
                        .put("code", code).put("name", Watcher.deviceName(this)).put("kind", "android")));
                // Files deleted before pairing aren't saved: Vault protects from today on.
                Vault.prefs(this).edit().putString("token", r.getString("token"))
                        .putLong("baseline", System.currentTimeMillis()).putBoolean("setupDone", false).apply();
            } catch (Exception e) { err = e.getMessage(); }
            final String msg = err;
            runOnUiThread(() -> {
                if (msg == null) show();
                else web.loadUrl("file:///android_asset/setup.html#failed:" + Uri.encode(msg));
            });
        }).start();
        return true;
    }

    /** What the pages can ask of the phone. */
    class Bridge {
        @JavascriptInterface public String status() {
            try {
                return new JSONObject().put("paired", Vault.paired(MainActivity.this)).put("allFiles", Vault.allFiles())
                        .put("battery", Vault.battery(MainActivity.this)).put("binOn", Vault.binOn())
                        .put("pending", Watcher.pendingCount(MainActivity.this)).put("phone", Watcher.deviceName(MainActivity.this)).toString();
            } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public void fix(String what) {
            Intent i;
            switch (what) {
                case "files": i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())); break;
                case "battery": i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())); break;
                case "bin": i = getPackageManager().getLaunchIntentForPackage("com.sec.android.gallery3d"); break;
                default: return;
            }
            if (i != null) runOnUiThread(() -> startActivity(i));
        }
        @JavascriptInterface public void syncNow() {
            WatchJob.now(MainActivity.this);
        }
        @JavascriptInterface public void done() {
            Vault.prefs(MainActivity.this).edit().putBoolean("setupDone", true).apply();
            runOnUiThread(MainActivity.this::show);
        }
        /** The PC just updated: fetch the new app from it now (Android asks for the OK). */
        @JavascriptInterface public void update() { new Thread(() -> Updater.check(MainActivity.this, MainActivity.this)).start(); }
        @JavascriptInterface public void reload() { runOnUiThread(MainActivity.this::show); }
        @JavascriptInterface public void saveDownload(String id) {
            new Thread(() -> {
                Downloads.saveOne(MainActivity.this, id);
                runOnUiThread(() -> web.evaluateJavascript("window.vaultRefresh && vaultRefresh()", null));
            }).start();
        }
        @JavascriptInterface public void saveConverted(String id) {
            new Thread(() -> {
                Downloads.saveOne(MainActivity.this, id, "/api/phone/cv");
                runOnUiThread(() -> web.evaluateJavascript("window.vaultRefresh && vaultRefresh()", null));
            }).start();
        }
        @JavascriptInterface public void savePdf(String id) {
            new Thread(() -> {
                Downloads.saveOne(MainActivity.this, id, "/api/phone/pdf");
                runOnUiThread(() -> web.evaluateJavascript("window.vaultRefresh && vaultRefresh()", null));
            }).start();
        }
        @JavascriptInterface public void saveDrop(String id) {
            new Thread(() -> {
                if (Downloads.saveOne(MainActivity.this, id, "/api/phone/drop")) Downloads.toast(MainActivity.this, "Saved into Download › Premade on this phone.");
                runOnUiThread(() -> web.evaluateJavascript("window.vaultRefresh && vaultRefresh()", null));
            }).start();
        }
        /** File drop's clipboard sync while the app is on screen: state is {me, clip} from /api/phone/drop. */
        @JavascriptInterface public void dropClip(String state, boolean canRead) {
            try {
                JSONObject s = new JSONObject(state);
                new Thread(() -> Drops.syncClip(MainActivity.this, s.optString("me"), s.optJSONObject("clip"), canRead && visible)).start();
            } catch (Exception ignored) {}
        }
        /** The page passes on the PC's Tailscale address and the relay's copy of the app, for when home can't be reached. */
        @JavascriptInterface public void keepAway(String ts, String away) {
            Vault.prefs(MainActivity.this).edit().putString("ts", ts.isEmpty() ? null : ts).putString("away", away.isEmpty() ? null : away).apply();
        }
        /** Saves something the phone made itself (local.js): into Download › Premade like everything else. */
        @JavascriptInterface public String saveLocal(String name, String type, String b64) {
            try {
                java.io.File d = Downloads.dir();
                name = new java.io.File(name).getName();
                java.io.File out = new java.io.File(d, name);
                int dot = name.lastIndexOf('.');
                for (int k = 2; out.exists(); k++) out = new java.io.File(d, dot > 0 ? name.substring(0, dot) + " (" + k + ")" + name.substring(dot) : name + " (" + k + ")");
                try (java.io.FileOutputStream o = new java.io.FileOutputStream(out)) { o.write(android.util.Base64.decode(b64, android.util.Base64.DEFAULT)); }
                android.media.MediaScannerConnection.scanFile(MainActivity.this, new String[]{out.getPath()}, null, null);
                return "ok";
            } catch (Exception e) { return e.getMessage(); }
        }
        /** Downloads a link on the phone itself (PC out of reach). Tells the page phoneDlProgress(pct), then phoneDlDone(result). */
        @JavascriptInterface public void phoneDownload(String url, boolean audio) {
            new Thread(() -> {
                String res = PhoneDL.run(MainActivity.this, url, audio,
                        (pct) -> runOnUiThread(() -> web.evaluateJavascript("window.phoneDlProgress && phoneDlProgress(" + pct + ")", null)));
                runOnUiThread(() -> web.evaluateJavascript("window.phoneDlDone && phoneDlDone(" + JSONObject.quote(res) + ")", null));
            }).start();
        }
        @JavascriptInterface public void watchDownloads() { WatchJob.downloads(MainActivity.this, null); }
        /** Transcribe's Record button: "ok", "perm" (Android is asking for the mic; tap again) or "error". The
         *  page can't use the mic itself, because it comes from the PC over plain http. */
        @JavascriptInterface public synchronized String recordStart() {
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, 8));
                return "perm";
            }
            try {
                recFile = new java.io.File(getCacheDir(), "recording.m4a");
                rec = new android.media.MediaRecorder();
                rec.setAudioSource(android.media.MediaRecorder.AudioSource.MIC);
                rec.setOutputFormat(android.media.MediaRecorder.OutputFormat.MPEG_4);
                rec.setAudioEncoder(android.media.MediaRecorder.AudioEncoder.AAC);
                rec.setAudioSamplingRate(44100);
                rec.setAudioEncodingBitRate(96000);
                rec.setOutputFile(recFile.getPath());
                rec.prepare();
                rec.start();
                return "ok";
            } catch (Exception e) {
                if (rec != null) rec.release();
                rec = null;
                return "error";
            }
        }
        /** Stops recording; when keep is set, sends it to the PC to transcribe (to: text or en) and tells the page
         *  through trRecorded(job id or "ERR: why"). */
        @JavascriptInterface public synchronized void recordStop(boolean keep, String to) {
            if (rec == null) return;
            boolean ok;
            try { rec.stop(); ok = true; } catch (Exception e) { ok = false; } // stopped within a moment of starting
            rec.release();
            rec = null;
            if (!keep) return;
            final boolean got = ok;
            final String name = "Recording " + new java.text.SimpleDateFormat("yyyy-MM-dd HH.mm", java.util.Locale.US).format(new java.util.Date()) + ".m4a";
            new Thread(() -> {
                String res;
                if (!got) res = "ERR: The recording was too short.";
                else try {
                    java.net.HttpURLConnection h = Vault.open(MainActivity.this, "POST", "/api/phone/tr/ios/start?name="
                            + java.net.URLEncoder.encode(name, "UTF-8") + "&to=" + ("en".equals(to) ? "en" : "text"));
                    try {
                        h.setDoOutput(true);
                        h.setFixedLengthStreamingMode(recFile.length());
                        h.setReadTimeout(120_000);
                        try (java.io.OutputStream o = h.getOutputStream()) { java.nio.file.Files.copy(recFile.toPath(), o); }
                        res = h.getResponseCode() == 200 ? Vault.read(h.getInputStream()) : "ERR: The PC said " + h.getResponseCode() + ".";
                    } finally { h.disconnect(); }
                } catch (Exception e) { res = "ERR: Couldn't reach your PC."; }
                if (got && res.startsWith("ERR")) try { // never lose it: into Download › Premade, to send or transcribe later
                    java.io.File d = Downloads.dir(), out = new java.io.File(d, name);
                    for (int k = 2; out.exists(); k++) out = new java.io.File(d, name.replace(".m4a", " (" + k + ").m4a"));
                    java.nio.file.Files.copy(recFile.toPath(), out.toPath());
                    android.media.MediaScannerConnection.scanFile(MainActivity.this, new String[]{out.getPath()}, null, null);
                    res += " The recording is saved in Download › Premade.";
                } catch (Exception ignored) {}
                recFile.delete();
                final String js = "window.trRecorded && trRecorded(" + JSONObject.quote(res) + ")";
                runOnUiThread(() -> web.evaluateJavascript(js, null));
            }).start();
        }
        @JavascriptInterface public String clipboard() {
            android.content.ClipData c = getSystemService(android.content.ClipboardManager.class).getPrimaryClip();
            return c == null || c.getItemCount() == 0 ? "" : String.valueOf(c.getItemAt(0).coerceToText(MainActivity.this));
        }
    }
}
