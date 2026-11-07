package tools.premade.vault;

import android.Manifest;
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
    private WebView web;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(Color.parseColor("#151012"));
        getWindow().setNavigationBarColor(Color.parseColor("#151012"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0809"));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "Vault");
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
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != 0)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        if (!handlePair(getIntent())) show();
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        if (!handlePair(i)) show();
    }

    @Override protected void onResume() {
        super.onResume();
        web.evaluateJavascript("window.vaultRefresh && vaultRefresh()", null);
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    private void show() {
        if (!Vault.paired(this)) web.loadUrl("file:///android_asset/setup.html#pair");
        else if (!Vault.allFiles() || !Vault.prefs(this).getBoolean("setupDone", false)) web.loadUrl("file:///android_asset/setup.html");
        else {
            WatchService.start(this);
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
                        .put("code", code).put("name", WatchService.deviceName(this)).put("kind", "android")));
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
                String[] p = new java.io.File(getFilesDir(), "pending").list((d, n) -> n.endsWith(".json"));
                return new JSONObject().put("paired", Vault.paired(MainActivity.this)).put("allFiles", Vault.allFiles())
                        .put("battery", Vault.battery(MainActivity.this)).put("binOn", Vault.binOn())
                        .put("pending", p == null ? 0 : p.length).put("phone", WatchService.deviceName(MainActivity.this)).toString();
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
            startService(new Intent(MainActivity.this, WatchService.class).setAction(WatchService.ACTION_SYNC));
        }
        @JavascriptInterface public void done() {
            Vault.prefs(MainActivity.this).edit().putBoolean("setupDone", true).apply();
            runOnUiThread(MainActivity.this::show);
        }
        @JavascriptInterface public void reload() { runOnUiThread(MainActivity.this::show); }
    }
}
