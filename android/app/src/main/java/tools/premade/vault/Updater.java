package tools.premade.vault;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;

/**
 * Keeps the app as new as the PC program: the PC carries the latest app, and when it's newer than this one the
 * phone installs it. Android asks the user once ("Allow from this source", then Update); after that it's quiet.
 */
final class Updater {
    static long myVersion(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).getLongVersionCode(); }
        catch (Exception e) { return 0; }
    }

    private static final java.util.concurrent.atomic.AtomicBoolean busy = new java.util.concurrent.atomic.AtomicBoolean();
    private static final String CHANNEL = "updates";
    private static final int NOTE = 7001;

    /** a is the open app screen, or null from the background. One check at a time: opening the app and the
     *  page's update() both ask, and two installs at once make Android drop both. */
    static void check(Context c, Activity a) {
        if (!busy.compareAndSet(false, true)) return;
        try {
            if (!Vault.paired(c) || !Vault.canReachHome(c)) return;
            long v = new JSONObject(Vault.call(c, "GET", "/api/phone/app", null)).optLong("version");
            if (v <= myVersion(c)) return;
            if (!c.getPackageManager().canRequestPackageInstalls()) {
                if (a != null) a.runOnUiThread(() -> a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + c.getPackageName()))));
                return;
            }
            long tried = Vault.prefs(c).getLong("triedUpdate", 0), at = Vault.prefs(c).getLong("triedAt", 0);
            if (a == null && tried == v) return; // waiting for the user's tap; try again when the app opens
            if (tried == v && System.currentTimeMillis() - at < 60_000) return; // just asked: coming back from Android's prompt isn't a new ask
            // Tapped from the open app: open it again once the new version is in.
            Vault.prefs(c).edit().putLong("triedUpdate", v).putLong("triedAt", System.currentTimeMillis()).putLong("reopenBy", a != null ? System.currentTimeMillis() + 10 * 60_000 : 0).apply();
            install(c);
        } catch (Exception e) { Log.w(Watcher.TAG, "update", e); }
        finally { busy.set(false); }
    }

    /** Runs in the new version, from Android's "done" answer or MY_PACKAGE_REPLACED (whichever comes first).
     *  Opens the app again if the update started from it. Android may block an app opening itself from the
     *  background, so a notification says it's ready too; opening the app clears it. */
    static void reopen(Context c) {
        android.content.SharedPreferences p = Vault.prefs(c);
        if (p.getLong("reopenBy", 0) < System.currentTimeMillis()) return;
        p.edit().putLong("reopenBy", 0).apply();
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        android.app.NotificationManager nm = c.getSystemService(android.app.NotificationManager.class);
        nm.createNotificationChannel(new android.app.NotificationChannel(CHANNEL, "Updates", android.app.NotificationManager.IMPORTANCE_HIGH));
        android.app.Notification n = new android.app.Notification.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_mono)
                .setContentTitle("Premade Tools is updated").setContentText("Tap to open it.")
                .setContentIntent(PendingIntent.getActivity(c, NOTE, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .setAutoCancel(true).build();
        try { nm.notify(NOTE, n); } catch (SecurityException e) { Log.w(Watcher.TAG, "notify off", e); }
        try { c.startActivity(open); } catch (Exception e) { Log.w(Watcher.TAG, "reopen", e); }
    }

    /** The app is on screen: the "updated" notification has done its job. */
    static void opened(Context c) { c.getSystemService(android.app.NotificationManager.class).cancel(NOTE); }

    private static void install(Context c) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        sp.setAppPackageName(c.getPackageName());
        if (android.os.Build.VERSION.SDK_INT >= 31) sp.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(sp);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            HttpURLConnection h = Vault.open(c, "GET", "/download/PremadeTools.apk");
            try (InputStream in = h.getInputStream(); OutputStream o = s.openWrite("app.apk", 0, -1)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
                s.fsync(o);
            } finally { h.disconnect(); }
            PendingIntent done = PendingIntent.getBroadcast(c, id, new Intent(c, Result.class), PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            s.commit(done.getIntentSender());
        }
    }

    /** Android's answer. If it needs the user's OK and the app is on screen, show the Update prompt. */
    public static class Result extends BroadcastReceiver {
        @Override public void onReceive(Context c, Intent i) {
            int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
            if (st == PackageInstaller.STATUS_PENDING_USER_ACTION && MainActivity.visible) {
                Intent ask = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (ask != null) c.startActivity(ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else if (st == PackageInstaller.STATUS_SUCCESS) {
                reopen(c);
            } else {
                Log.w(Watcher.TAG, "update status " + st + " " + i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            }
        }
    }

    private Updater() {}
}
