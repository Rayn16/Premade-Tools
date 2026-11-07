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
                if ("file".equals(u.getScheme()) || (u.getHost() + ":" + u.getPort()).equals(Vault.host(MainActivity.this))) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u)); // anything else opens outside the app
                return true;
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) v.loadUrl("file:///android_asset/offline.html");
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
        if (!handlePair(i)) show();
    }

    @Override protected void onResume() {
        super.onResume();
        visible = true;
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
            web.loadUrl("http://" + Vault.host(this) + "/m/#t=" + Vault.token(this));
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
                Vault.prefs(this).edit().putString("host", host).remove("token").apply();
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
        @JavascriptInterface public void watchDownloads() { WatchJob.downloads(MainActivity.this, null); }
        @JavascriptInterface public String clipboard() {
            android.content.ClipData c = getSystemService(android.content.ClipboardManager.class).getPrimaryClip();
            return c == null || c.getItemCount() == 0 ? "" : String.valueOf(c.getItemAt(0).coerceToText(MainActivity.this));
        }
    }
}
