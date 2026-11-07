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

    /** a is the open app screen, or null from the background. */
    static void check(Context c, Activity a) {
        try {
            if (!Vault.paired(c) || !Vault.canReachHome(c)) return;
            long v = new JSONObject(Vault.call(c, "GET", "/api/phone/app", null)).optLong("version");
            if (v <= myVersion(c)) return;
            if (!c.getPackageManager().canRequestPackageInstalls()) {
                if (a != null) a.runOnUiThread(() -> a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + c.getPackageName()))));
                return;
            }
            long tried = Vault.prefs(c).getLong("triedUpdate", 0);
            if (a == null && tried == v) return; // waiting for the user's tap; try again when the app opens
            Vault.prefs(c).edit().putLong("triedUpdate", v).apply();
            install(c);
        } catch (Exception e) { Log.w(Watcher.TAG, "update", e); }
    }

    private static void install(Context c) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        sp.setAppPackageName(c.getPackageName());
        sp.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
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
                Intent ask = i.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
                if (ask != null) c.startActivity(ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else if (st != PackageInstaller.STATUS_SUCCESS) {
                Log.w(Watcher.TAG, "update status " + st + " " + i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            }
        }
    }

    private Updater() {}
}
