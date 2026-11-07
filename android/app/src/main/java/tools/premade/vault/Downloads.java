package tools.premade.vault;

import android.content.Context;
import android.media.MediaScannerConnection;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

/**
 * The Downloader on Android. The PC downloads; this sends it links from the Share menu (keeping them for later
 * when the PC can't be reached) and saves what's done into the phone's own folders, so it shows in Gallery.
 */
final class Downloads {
    private static final Object LOCK = new Object();

    /** A link from the Share menu. False when the PC couldn't be reached and it was kept for later. */
    static boolean share(Context c, String text) {
        String r;
        try { r = post(c, text).trim(); } catch (Exception e) {
            synchronized (LOCK) {
                String q = Vault.prefs(c).getString("dlQueue", "");
                Vault.prefs(c).edit().putString("dlQueue", q + text.replace('\n', ' ') + "\n").apply();
            }
            toast(c, "Your PC can't be reached. Premade will send the link when it can.");
            return false;
        }
        toast(c, r.startsWith("ERR") ? r.substring(4).trim() : "Downloading on your PC. It'll land in Gallery.");
        return !r.startsWith("ERR");
    }

    /** Sends links kept from earlier, then saves finished downloads. True while any of this phone's are still going. */
    static boolean saveAll(Context c) {
        synchronized (LOCK) {
            try {
                String q = Vault.prefs(c).getString("dlQueue", "");
                if (!q.isEmpty()) {
                    for (String l : q.split("\n")) if (!l.isEmpty()) post(c, l); // throws while the PC is away, keeping the queue
                    Vault.prefs(c).edit().remove("dlQueue").apply();
                }
                JSONObject s = new JSONObject(Vault.call(c, "GET", "/api/phone/dl", null));
                String me = s.optString("me");
                JSONArray jobs = s.getJSONArray("jobs");
                boolean busy = false;
                for (int i = 0; i < jobs.length(); i++) {
                    JSONObject j = jobs.getJSONObject(i);
                    if (!me.equals(j.optString("from"))) continue;
                    String st = j.optString("state");
                    if (st.equals("queued") || st.equals("running")) busy = true;
                    else if (st.equals("done") && !j.optBoolean("fetched")) { save(c, j); toast(c, "Saved: " + j.optString("title")); }
                }
                return busy;
            } catch (Exception e) { Log.w(Watcher.TAG, "downloads", e); return false; }
        }
    }

    /** The Save button: any finished download, including ones started on the PC. */
    static boolean saveOne(Context c, String id) {
        synchronized (LOCK) {
            try {
                JSONArray jobs = new JSONObject(Vault.call(c, "GET", "/api/phone/dl", null)).getJSONArray("jobs");
                for (int i = 0; i < jobs.length(); i++)
                    if (jobs.getJSONObject(i).optString("id").equals(id)) { save(c, jobs.getJSONObject(i)); return true; }
            } catch (Exception e) { Log.w(Watcher.TAG, "save", e); toast(c, "Couldn't save it: " + e.getMessage()); }
            return false;
        }
    }

    private static String post(Context c, String text) throws Exception {
        HttpURLConnection h = Vault.open(c, "POST", "/api/phone/dl/ios/start");
        try {
            h.setDoOutput(true);
            h.setReadTimeout(120_000); // the PC looks at the link first
            try (OutputStream o = h.getOutputStream()) { o.write(text.getBytes(StandardCharsets.UTF_8)); }
            if (h.getResponseCode() != 200) throw new Exception("HTTP " + h.getResponseCode());
            return Vault.read(h.getInputStream());
        } finally { h.disconnect(); }
    }

    /** Videos to Movies/Premade, photos to Pictures/Premade, audio to Music/Premade. A file already there is kept. */
    private static void save(Context c, JSONObject j) throws Exception {
        String id = j.getString("id");
        JSONArray files = j.optJSONArray("files");
        for (int n = 0; files != null && n < files.length(); n++) {
            JSONObject f = files.getJSONObject(n);
            String dir;
            switch (f.optString("kind")) {
                case "video": dir = Environment.DIRECTORY_MOVIES; break;
                case "photo": dir = Environment.DIRECTORY_PICTURES; break;
                case "audio": dir = Environment.DIRECTORY_MUSIC; break;
                default: dir = Environment.DIRECTORY_DOWNLOADS;
            }
            File d = new File(Environment.getExternalStoragePublicDirectory(dir), "Premade");
            d.mkdirs();
            String name = new File(f.getString("name")).getName();
            File out = new File(d, name);
            if (out.exists() && out.length() == f.optLong("size")) continue;
            int dot = name.lastIndexOf('.');
            for (int k = 2; out.exists(); k++) out = new File(d, dot > 0 ? name.substring(0, dot) + " (" + k + ")" + name.substring(dot) : name + " (" + k + ")");
            File tmp = new File(d, "." + out.getName() + ".part");
            HttpURLConnection h = Vault.open(c, "GET", "/api/phone/dl/file/" + id + "/" + n);
            try (InputStream in = h.getInputStream(); OutputStream o = new FileOutputStream(tmp)) {
                if (h.getResponseCode() != 200) throw new Exception("HTTP " + h.getResponseCode());
                byte[] buf = new byte[65536];
                for (int r; (r = in.read(buf)) > 0; ) o.write(buf, 0, r);
            } catch (Exception e) { tmp.delete(); throw e; } finally { h.disconnect(); }
            if (!tmp.renameTo(out)) throw new Exception("couldn't write " + out);
            MediaScannerConnection.scanFile(c, new String[]{out.getPath()}, null, null);
        }
        try { Vault.call(c, "POST", "/api/phone/dl/fetched/" + id, null); } catch (Exception ignored) {} // someone else's: nothing to mark
    }

    static void toast(Context c, String msg) {
        new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(c.getApplicationContext(), msg, Toast.LENGTH_LONG).show());
    }

    private Downloads() {}
}
