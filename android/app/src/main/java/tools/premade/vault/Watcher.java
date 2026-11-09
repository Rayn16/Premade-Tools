package tools.premade.vault;

import android.content.Context;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The watcher. Each run (on every change in the phone's media, and every 15 min) it looks for new files in Samsung's Recycle bin (Android/.Trash) and Android's
 * own trash, copies each new one into the app's storage at once (so emptying the bin later can't lose it), and
 * sends what it holds to the PC whenever the PC is reachable. Every 5 min it compares the phone's file list with
 * the last one to spot files that vanished without passing the bin, and reports those as "couldn't be saved".
 */
final class Watcher {
    static final String TAG = "Vault";
    private static final Pattern MS = Pattern.compile("\\d{13}");
    private static final String MARK = ".!%#@$"; // Samsung's folder between the original path and the file name
    private static final String[] WATCHED = {"DCIM/", "Pictures/", "Movies/", "Download/", "Documents/", "Music/", "Recordings/", "Android/media/"};
    private static final Object LOCK = new Object();

    private final Context c;
    private final Set<String> done = new HashSet<>();
    private Set<String> binNames = new HashSet<>(); // "folder/name" of everything in the bins right now
    private final File pending, doneFile, listFile;

    private Watcher(Context c) {
        this.c = c;
        pending = new File(c.getFilesDir(), "pending");
        pending.mkdirs();
        doneFile = new File(c.getFilesDir(), "done.txt");
        listFile = new File(c.getFilesDir(), "list.tsv");
        try (BufferedReader r = new BufferedReader(new FileReader(doneFile))) {
            for (String l; (l = r.readLine()) != null; ) done.add(l);
        } catch (Exception ignored) {}
    }

    /** One round: look in the bins, now and then compare the file list, then talk to the PC. Runs from WatchJob. */
    static void runOnce(Context c) {
        synchronized (LOCK) {
            try {
                if (!Vault.paired(c)) return;
                Watcher w = new Watcher(c);
                if (Vault.allFiles()) {
                    w.scanBin();
                    long last = Vault.prefs(c).getLong("lastList", 0);
                    if (System.currentTimeMillis() - last > 5 * 60_000) {
                        w.checkList();
                        Vault.prefs(c).edit().putLong("lastList", System.currentTimeMillis()).apply();
                    }
                }
                w.sync();
                Updater.check(c, null);
            } catch (Throwable e) { Log.w(TAG, "run", e); }
        }
    }

    static int pendingCount(Context c) {
        String[] m = new File(c.getFilesDir(), "pending").list((d, n) -> n.endsWith(".json"));
        return m == null ? 0 : m.length;
    }

    // ---------- the bins ----------

    private void scanBin() {
        long base = Vault.prefs(c).getLong("baseline", 0);
        Set<String> names = new HashSet<>();
        walk(Vault.TRASH, names, base);
        mediaStoreTrash(names, base);
        binNames = names;
    }

    private void walk(File dir, Set<String> names, long base) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File f : kids) {
            if (f.isDirectory()) { walk(f, names, base); continue; }
            if (f.getName().equals(".nomedia") || f.getName().equals("is_legacy_not_exist_file")) continue;
            String rel = f.getPath().substring(Vault.TRASH.getPath().length() + 1);
            String[] p = parse(rel);
            names.add(p[0] + "/" + p[1]);
            long at = p[2] == null ? System.currentTimeMillis() : Long.parseLong(p[2]);
            if (at >= base) keep("bin/" + rel, f, p[1], p[0], at);
        }
    }

    /** Bin path → {folder, name, deleted-at ms or null}. Samsung: app/uuid/<ms>/storage/emulated/0/<folder>/.!%#@$/<name>. */
    static String[] parse(String rel) {
        String[] s = rel.split("/");
        String at = null;
        int start = -1, end = s.length - 1;
        for (int i = 0; i < s.length - 1; i++) {
            if (at == null && MS.matcher(s[i]).matches()) at = s[i];
            if (start < 0 && i + 2 < s.length && s[i].equals("storage") && s[i + 1].equals("emulated")) start = i + 3;
        }
        if (end > 0 && s[end - 1].equals(MARK)) end--;
        if (start < 0 || start > end) start = Math.min(1, end);
        String folder = String.join("/", Arrays.copyOfRange(s, start, end));
        return new String[]{folder, s[s.length - 1], at};
    }

    /** Android's own trash: files renamed to .trashed-<expiry>-<name> by apps such as Google Photos and Files. */
    private void mediaStoreTrash(Set<String> names, long base) {
        Bundle q = new Bundle();
        q.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_ONLY);
        String[] cols = {MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.DATE_EXPIRES, MediaStore.MediaColumns.DISPLAY_NAME};
        try (Cursor cur = c.getContentResolver().query(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL), cols, q, null)) {
            while (cur != null && cur.moveToNext()) {
                String path = cur.getString(0);
                if (path == null || !path.startsWith(Vault.ROOT.getPath())) continue;
                File f = new File(path);
                String name = f.getName().replaceFirst("^\\.trashed-\\d+-", "");
                String folder = f.getParent().substring(Math.min(f.getParent().length(), Vault.ROOT.getPath().length() + 1));
                names.add(folder + "/" + name);
                long at = cur.getLong(1) * 1000 - 30L * 86_400_000; // trashed items expire 30 days after deletion
                if (at >= base) keep("trash/" + path, f, name, folder, at);
            }
        } catch (Exception e) { Log.w(TAG, "trash", e); }
    }

    /** Copies a new bin file into the app's own storage, to be sent to the PC. */
    private void keep(String key, File f, String name, String folder, long at) {
        if (done.contains(key)) return;
        String id = Long.toString(System.nanoTime());
        File bin = new File(pending, id + ".bin");
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new FileInputStream(f); OutputStream o = new FileOutputStream(bin)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) { md.update(buf, 0, n); o.write(buf, 0, n); }
            }
            JSONObject m = new JSONObject().put("key", key).put("name", name).put("folder", folder).put("at", at).put("sha", hex(md.digest()));
            write(new File(pending, id + ".json"), m.toString());
            markDone(key);
            Log.i(TAG, "kept " + folder + "/" + name);
        } catch (Exception e) {
            bin.delete(); // try again next round
            Log.w(TAG, "keep " + key, e);
        }
    }

    private void markDone(String key) throws Exception {
        done.add(key);
        try (FileWriter w = new FileWriter(doneFile, true)) { w.write(key + "\n"); }
    }

    // ---------- files that vanished without the bin ----------

    private void checkList() {
        Map<String, String[]> now = new HashMap<>(); // path → {size, owner package, date added}
        String[] cols = {MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.OWNER_PACKAGE_NAME, MediaStore.MediaColumns.DATE_ADDED};
        try (Cursor cur = c.getContentResolver().query(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL), cols, null, null)) {
            String root = Vault.ROOT.getPath() + "/";
            while (cur != null && cur.moveToNext()) {
                String path = cur.getString(0);
                if (path == null || !path.startsWith(root) || path.contains("/.")) continue;
                String rel = path.substring(root.length());
                boolean watched = false;
                for (String w : WATCHED) watched |= rel.startsWith(w);
                if (watched) now.put(rel, new String[]{cur.getString(1), cur.getString(2), cur.getString(3)});
            }
        } catch (Exception e) { Log.w(TAG, "list", e); return; }

        Map<String, String[]> before = new HashMap<>();
        try (BufferedReader r = new BufferedReader(new FileReader(listFile))) {
            for (String l; (l = r.readLine()) != null; ) {
                String[] t = l.split("\t", -1);
                if (t.length == 4) before.put(t[0], new String[]{t[1], t[2], t[3]});
            }
        } catch (Exception ignored) {}

        if (!before.isEmpty()) {
            Set<String> nameSize = new HashSet<>();
            for (Map.Entry<String, String[]> e : now.entrySet()) nameSize.add(new File(e.getKey()).getName() + "|" + e.getValue()[0]);
            long nowS = System.currentTimeMillis() / 1000;
            Map<String, String[]> gone = new HashMap<>();
            for (Map.Entry<String, String[]> e : before.entrySet()) {
                String rel = e.getKey();
                if (now.containsKey(rel) || binNames.contains(rel)) continue; // still there, or went to the bin
                File f = new File(Vault.ROOT, rel);
                String[] v = e.getValue();
                if (f.exists() || nameSize.contains(f.getName() + "|" + v[0])) continue; // still there, or just moved
                if (nowS - parseLong(v[2]) < 15 * 60) continue; // short-lived temp files
                gone.put(rel, v);
            }
            if (!gone.isEmpty()) scanBin(); // it may have reached the bin since the last look
            for (Map.Entry<String, String[]> e : gone.entrySet()) {
                if (binNames.contains(e.getKey())) continue;
                reportMissed(new File(e.getKey()).getName(), new File(e.getKey()).getParent(), e.getValue()[1]);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String[]> e : now.entrySet())
            sb.append(e.getKey()).append('\t').append(e.getValue()[0]).append('\t').append(e.getValue()[1]).append('\t').append(e.getValue()[2]).append('\n');
        try { write(listFile, sb.toString()); } catch (Exception ignored) {}
    }

    private void reportMissed(String name, String folder, String owner) {
        String from = owner == null ? null : label(owner);
        String phone = deviceName(c);
        String note = "It left the " + phone + " without going through the Recycle bin" + (from != null ? " (it came from " + from + ")." : ".");
        try {
            JSONObject m = new JSONObject().put("missed", true).put("name", name).put("folder", folder == null ? "" : folder)
                    .put("note", note).put("at", System.currentTimeMillis());
            write(new File(pending, System.nanoTime() + ".json"), m.toString());
        } catch (Exception e) { Log.w(TAG, "missed", e); }
    }

    private String label(String pkg) {
        try { return c.getPackageManager().getApplicationLabel(c.getPackageManager().getApplicationInfo(pkg, 0)).toString(); }
        catch (Exception e) { return null; }
    }

    static String deviceName(Context c) {
        String n = Settings.Global.getString(c.getContentResolver(), "device_name");
        return n != null ? n : android.os.Build.MODEL;
    }

    // ---------- talking to the PC ----------

    private void sync() {
        if (!Vault.canReachHome(c)) return;
        Drops.check(c); // first: File drop works while the vault can't take files
        try {
            File[] metas = pending.listFiles((d, n) -> n.endsWith(".json"));
            if (metas != null) {
                Arrays.sort(metas);
                for (File meta : metas) send(meta);
            }
            JSONObject s = new JSONObject().put("allFiles", Vault.allFiles()).put("battery", Vault.battery(c))
                    .put("binOn", Vault.binOn()).put("watching", Vault.allFiles()).put("pending", pendingCount(c))
                    .put("app", Updater.myVersion(c));
            Vault.call(c, "POST", "/api/phone/checkin", s);
            restores();
        } catch (Exception e) {
            Log.w(TAG, "sync", e);
            if (e.getMessage() != null && e.getMessage().startsWith("401"))
                Vault.prefs(c).edit().remove("token").apply(); // the PC forgot this phone
        }
    }

    private void send(File meta) throws Exception {
        JSONObject m = new JSONObject(new String(Files.readAllBytes(meta.toPath()), StandardCharsets.UTF_8));
        File bin = new File(meta.getPath().replace(".json", ".bin"));
        if (m.optBoolean("missed")) {
            Vault.call(c, "POST", "/api/phone/missed", new JSONObject().put("Name", m.getString("name"))
                    .put("Folder", m.getString("folder")).put("Note", m.getString("note")).put("At", m.getLong("at")));
        } else {
            HttpURLConnection h = Vault.open(c, "PUT", "/api/phone/upload");
            h.setRequestProperty("X-Key", Vault.enc(m.getString("key")));
            h.setRequestProperty("X-Name", Vault.enc(m.getString("name")));
            h.setRequestProperty("X-Folder", Vault.enc(m.getString("folder")));
            h.setRequestProperty("X-Deleted-At", Long.toString(m.getLong("at")));
            h.setRequestProperty("X-Sha256", m.getString("sha"));
            h.setDoOutput(true);
            h.setFixedLengthStreamingMode(bin.length());
            try (InputStream in = new FileInputStream(bin); OutputStream o = h.getOutputStream()) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
            }
            int code = h.getResponseCode();
            String body = Vault.read(code < 400 ? h.getInputStream() : h.getErrorStream());
            h.disconnect();
            if (code >= 300) throw new Exception(code + " " + body);
        }
        bin.delete();
        meta.delete();
    }

    /** Files someone chose to restore to this phone, from the PC or the app: put back where they were. */
    private void restores() throws Exception {
        JSONArray list = new JSONArray(Vault.call(c, "GET", "/api/phone/restores", null));
        for (int i = 0; i < list.length(); i++) {
            JSONObject it = list.getJSONObject(i);
            String id = it.getString("id"), name = it.getString("name"), folder = it.optString("folder");
            File dir = new File(Vault.ROOT, folder.isEmpty() ? "Download" : folder);
            dir.mkdirs();
            File dst = new File(dir, name);
            for (int n = 1; dst.exists(); n++) {
                int dot = name.lastIndexOf('.');
                dst = new File(dir, dot > 0 ? name.substring(0, dot) + " (" + n + ")" + name.substring(dot) : name + " (" + n + ")");
            }
            File tmp = new File(dir, ".vault-" + id);
            HttpURLConnection h = Vault.open(c, "GET", "/api/phone/file/" + id);
            try (InputStream in = h.getInputStream(); OutputStream o = new FileOutputStream(tmp)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
            } finally { h.disconnect(); }
            if (!tmp.renameTo(dst)) { tmp.delete(); throw new Exception("couldn't write " + dst); }
            MediaScannerConnection.scanFile(c, new String[]{dst.getPath()}, null, null);
            Vault.call(c, "POST", "/api/phone/restored/" + id, new JSONObject());
            Log.i(TAG, "restored " + dst);
        }
    }

    // ---------- small helpers ----------

    private static void write(File f, String s) throws Exception {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(s.getBytes(StandardCharsets.UTF_8)); }
        if (!tmp.renameTo(f)) throw new Exception("rename " + f);
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    private static long parseLong(String s) {
        try { return Long.parseLong(s); } catch (Exception e) { return 0; }
    }
}
