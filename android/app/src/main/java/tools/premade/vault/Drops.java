package tools.premade.vault;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;

/**
 * File drop on Android: a notification for each drop sent to this phone, the shared clipboard, and sending what
 * the Share menu hands us. The screens themselves come from the PC.
 */
final class Drops {
    private static final String CHANNEL = "drops";

    /** From the background job or a Firebase push: notify about new drops, and put a newer copy from elsewhere on the
     *  clipboard. False when the PC couldn't be asked. */
    static boolean check(Context c) {
        try {
            JSONObject s = new JSONObject(Vault.call(c, "GET", "/api/phone/drop", null));
            String me = s.optString("me");
            JSONArray jobs = s.getJSONArray("jobs");
            for (int i = 0; i < jobs.length(); i++) {
                JSONObject j = jobs.getJSONObject(i);
                if (!me.equals(j.optString("to")) || j.optBoolean("seen") || j.optBoolean("fetched")) continue;
                notifyDrop(c, j, name(s, j.optString("from")));
                Vault.call(c, "POST", "/api/phone/drop/seen/" + j.getString("id"), null);
            }
            if (s.optBoolean("clipSync")) syncClip(c, me, s.optJSONObject("clip"), false);
            return true;
        } catch (Exception e) { Log.w(Watcher.TAG, "drops", e); return false; }
    }

    /** Hands this phone's Firebase token to the PC, so a drop can wake the phone at once (PushService). Quietly does
     *  nothing in a build without Firebase set up. */
    static void registerPush(Context c) {
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken()
                    .addOnSuccessListener((t) -> new Thread(() -> sendToken(c, t)).start());
        } catch (Exception e) { Log.i(Watcher.TAG, "no Firebase in this build"); }
    }

    static void sendToken(Context c, String token) {
        try { Vault.call(c, "POST", "/api/phone/drop/fcm", new JSONObject().put("token", token)); }
        catch (Exception e) { Log.w(Watcher.TAG, "fcm token", e); }
    }

    private static String name(JSONObject s, String id) {
        JSONArray d = s.optJSONArray("devices");
        for (int i = 0; d != null && i < d.length(); i++)
            if (id.equals(d.optJSONObject(i).optString("id"))) return d.optJSONObject(i).optString("name");
        return id.replaceFirst("^friend:", "");
    }

    private static void notifyDrop(Context c, JSONObject j, String from) {
        String kind = j.optString("kind"), text;
        JSONArray files = j.optJSONArray("files");
        if (kind.equals("files")) {
            int n = files == null ? 0 : files.length();
            text = (n == 1 ? files.optJSONObject(0).optString("name") : n + " files") + (j.optString("text").isEmpty() ? "" : ": " + j.optString("text"));
        } else text = j.optString("text");
        show(c, j.optString("id").hashCode(), from + " sent " + (kind.equals("files") ? "you something" : kind.equals("link") ? "a link" : "text"), text);
    }

    /** A File drop notification; tapping it opens File drop. */
    static void show(Context c, int id, String title, String text) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "File drop", NotificationManager.IMPORTANCE_HIGH));
        Intent open = new Intent(c, MainActivity.class).putExtra("tool", "drop").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_mono)
                .setContentTitle(title).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pi).setAutoCancel(true).build();
        try { nm.notify(id, n); } catch (SecurityException e) { Log.w(Watcher.TAG, "notify off", e); }
    }

    /**
     * The clipboard, both ways. A copy from another device newer than the last one taken goes onto this phone;
     * otherwise, when canRead (the app is on screen; Android hides the clipboard in the background), a new copy
     * made here goes to the PC. Remembering both stops a copy bouncing back.
     */
    static synchronized void syncClip(Context c, String me, JSONObject clip, boolean canRead) {
        if (clip == null) return;
        String text = clip.optString("text"), at = clip.optString("at"), from = clip.optString("from");
        android.content.SharedPreferences p = Vault.prefs(c);
        if (!text.isEmpty() && !from.equals(me) && !at.equals(p.getString("clipAt", ""))) {
            p.edit().putString("clipAt", at).putString("clipLocal", text).apply();
            onMain(() -> c.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("From " + from, text)));
            return;
        }
        if (!canRead) return;
        String[] local = {""};
        onMain(() -> {
            ClipData d = c.getSystemService(ClipboardManager.class).getPrimaryClip();
            if (d != null && d.getItemCount() > 0) local[0] = String.valueOf(d.getItemAt(0).coerceToText(c));
        });
        String mine = local[0];
        if (mine.isEmpty() || mine.equals(p.getString("clipLocal", "")) || mine.equals(text)) return;
        p.edit().putString("clipLocal", mine).apply();
        try {
            JSONObject r = new JSONObject(Vault.call(c, "POST", "/api/phone/drop/clip", new JSONObject().put("text", mine)));
            p.edit().putString("clipAt", r.optString("at")).apply();
        } catch (Exception e) { Log.w(Watcher.TAG, "clip", e); }
    }

    /** Runs f on the main thread and waits for it (the clipboard wants the main thread). */
    private static void onMain(Runnable f) {
        if (Looper.myLooper() == Looper.getMainLooper()) { f.run(); return; }
        CountDownLatch done = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> { try { f.run(); } finally { done.countDown(); } });
        try { done.await(); } catch (InterruptedException ignored) {}
    }

    /** What the Share menu gave: files, or text and links. Returns what to tell the person. */
    static String send(Context c, Intent in) {
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(in.getAction())) {
            ArrayList<Uri> l = in.getParcelableArrayListExtra(Intent.EXTRA_STREAM); // the typed version needs Android 13; the app runs from 11
            if (l != null) uris.addAll(l);
        } else {
            Uri u = in.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        }
        String text = in.getStringExtra(Intent.EXTRA_TEXT), last = "Nothing to send.";
        try {
            if (uris.isEmpty() && text != null && !text.isBlank()) return post(c, "", text.getBytes(java.nio.charset.StandardCharsets.UTF_8), null);
            for (Uri u : uris) last = post(c, displayName(c, u), null, u);
            return uris.size() > 1 && last.startsWith("OK") ? "Sent " + uris.size() + " files to your PC." : last.replaceFirst("^(OK|ERR): ", "");
        } catch (Exception e) {
            return "Couldn't reach your PC. Is it on, and is this phone on home Wi-Fi?";
        }
    }

    private static String post(Context c, String name, byte[] body, Uri u) throws Exception {
        HttpURLConnection h = Vault.open(c, "POST", "/api/phone/drop/ios?to=pc&name=" + Vault.enc(name));
        try {
            h.setDoOutput(true);
            h.setReadTimeout(300_000);
            if (body != null) h.setFixedLengthStreamingMode(body.length); else h.setChunkedStreamingMode(65536);
            try (OutputStream o = h.getOutputStream()) {
                if (body != null) o.write(body);
                else try (InputStream i = c.getContentResolver().openInputStream(u)) {
                    byte[] buf = new byte[65536];
                    for (int r; (r = i.read(buf)) > 0; ) o.write(buf, 0, r);
                }
            }
            int code = h.getResponseCode(); // 413: away from home, through the relay, which takes nothing over 100 MB
            String r = code == 200 ? Vault.read(h.getInputStream()).trim() : code == 413 ? "ERR: That's over 100 MB, more than goes through the internet. Send it on home Wi-Fi."
                    : "ERR: The PC said " + code + ".";
            return body != null ? r.replaceFirst("^(OK|ERR): ", "") : r;
        } finally { h.disconnect(); }
    }

    private static String displayName(Context c, Uri u) {
        try (Cursor k = c.getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (k != null && k.moveToFirst() && k.getString(0) != null) return k.getString(0);
        } catch (Exception ignored) {}
        String s = u.getLastPathSegment();
        return s == null ? "file" : s;
    }

    private Drops() {}
}
