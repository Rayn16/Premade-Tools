package tools.premade.vault;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Environment;
import android.os.PowerManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** Settings and the small HTTP client shared by the app screen and the watch service. */
final class Vault {
    static final File ROOT = Environment.getExternalStorageDirectory();
    static final File TRASH = new File(ROOT, "Android/.Trash");

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("vault", Context.MODE_PRIVATE); }
    static String host(Context c) { return prefs(c).getString("host", null); }
    static String token(Context c) { return prefs(c).getString("token", null); }
    static boolean paired(Context c) { return token(c) != null; }

    static boolean allFiles() { return Environment.isExternalStorageManager(); }
    static boolean battery(Context c) {
        return ((PowerManager) c.getSystemService(Context.POWER_SERVICE)).isIgnoringBatteryOptimizations(c.getPackageName());
    }
    /** Gallery keeps a folder in the bin while its Recycle bin is on. */
    static boolean binOn() { return new File(TRASH, "com.sec.android.gallery3d").exists(); }

    /** Home Wi-Fi, or a VPN such as Tailscale. Mobile data alone can't reach the PC. */
    static boolean canReachHome(Context c) {
        ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
        return nc != null && (nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || nc.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) || nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
    }

    static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8").replace("+", "%20"); } catch (Exception e) { return s; }
    }

    static HttpURLConnection open(Context c, String method, String path) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL("http://" + host(c) + path).openConnection();
        h.setRequestMethod(method);
        h.setConnectTimeout(5000);
        h.setReadTimeout(60000);
        String t = token(c);
        if (t != null) h.setRequestProperty("Authorization", "Bearer " + t);
        return h;
    }

    /** Sends JSON (or nothing) and returns the reply body; throws on any non-2xx. */
    static String call(Context c, String method, String path, JSONObject body) throws Exception {
        HttpURLConnection h = open(c, method, path);
        try {
            if (body != null) {
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = h.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            }
            int code = h.getResponseCode();
            String txt = read(code < 400 ? h.getInputStream() : h.getErrorStream());
            if (code >= 300) throw new Exception(code + " " + txt.trim());
            return txt;
        } finally { h.disconnect(); }
    }

    static String read(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        in.close();
        return b.toString("UTF-8");
    }

    private Vault() {}
}
