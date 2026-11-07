package tools.premade.bintest;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;

/** One-screen test: can a normal app with All files access read Samsung's Recycle bin and Android's trash? */
public class MainActivity extends Activity {
    private TextView out;
    private Button allow;
    private final StringBuilder rep = new StringBuilder();
    private final SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US);
    private File newest;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setBackgroundColor(Color.parseColor("#0b0b0c"));
        col.setPadding(32, 96, 32, 32);
        TextView title = new TextView(this);
        title.setText("Vault · bin test");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);
        title.setTypeface(Typeface.SERIF, Typeface.BOLD);
        col.addView(title);
        allow = button("Allow All files access", v -> startActivity(new Intent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName()))));
        col.addView(allow);
        col.addView(button("Scan the bins", v -> scan()));
        col.addView(button("Copy report", v -> {
            ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("bin test", rep));
            out.append("\n\nCopied. Paste it in the chat.");
        }));
        out = new TextView(this);
        out.setTextColor(Color.parseColor("#d8d8d8"));
        out.setTypeface(Typeface.MONOSPACE);
        out.setTextSize(11);
        out.setTextIsSelectable(true);
        ScrollView sv = new ScrollView(this);
        sv.addView(out);
        col.addView(sv);
        setContentView(col);
    }

    @Override protected void onResume() {
        super.onResume();
        allow.setVisibility(Environment.isExternalStorageManager() ? View.GONE : View.VISIBLE);
    }

    private Button button(String label, View.OnClickListener l) {
        Button btn = new Button(this);
        btn.setText(label);
        btn.setAllCaps(false);
        btn.setTextColor(Color.WHITE);
        btn.setBackgroundColor(Color.parseColor("#b3121f"));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = 20;
        btn.setLayoutParams(lp);
        btn.setOnClickListener(l);
        return btn;
    }

    private void scan() {
        out.setText("Scanning…");
        new Thread(() -> {
            rep.setLength(0);
            newest = null;
            try { runScan(); } catch (Throwable t) { line("CRASH: " + t); }
            runOnUiThread(() -> out.setText(rep));
        }).start();
    }

    private void line(String s) { rep.append(s).append('\n'); }

    private void runScan() {
        line("Device: " + Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE
                + " (SDK " + Build.VERSION.SDK_INT + "), build " + Build.DISPLAY);
        line("All files access: " + (Environment.isExternalStorageManager() ? "YES" : "NO"));
        line("Time: " + fmt.format(new Date()));
        File root = Environment.getExternalStorageDirectory();

        line("\n== Samsung Recycle bin: Android/.Trash ==");
        File trash = new File(root, "Android/.Trash");
        listTree(trash, 0);

        line("\n== Other places to check ==");
        for (String p : new String[]{".Trash", "Android/data/com.sec.android.gallery3d",
                "Android/data/com.sec.android.app.myfiles", "Android/data/com.sec.android.app.voicenotes"}) {
            File f = new File(root, p);
            String[] k = f.list();
            line(p + ": " + (!f.exists() ? "not there" : k == null ? "exists, NOT readable" : k.length + " entries " + Arrays.toString(k)));
        }

        line("\n== Android trash (MediaStore, \".trashed-\" files) ==");
        mediaStoreTrash();

        line("\n== Copy test (newest bin file into the app's own storage) ==");
        if (newest == null) line("No bin file found. Delete a test photo in Gallery and scan again.");
        else {
            try {
                File dst = new File(getFilesDir(), "copy-" + newest.getName());
                try (InputStream in = new FileInputStream(newest); FileOutputStream o = new FileOutputStream(dst)) {
                    byte[] buf = new byte[1 << 16];
                    for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
                }
                String a = sha(newest), c = sha(dst);
                line(newest.getPath() + "\n -> copied " + dst.length() + " bytes, hashes " + (a.equals(c) ? "MATCH" : "DIFFER"));
                dst.delete();
            } catch (Exception e) { line("Copy FAILED: " + e); }
        }
        line("\nDone.");
    }

    private void listTree(File dir, int depth) {
        String pad = "  ".repeat(depth);
        if (!dir.exists()) { line(pad + dir.getName() + "/ not there"); return; }
        File[] kids = dir.listFiles();
        if (kids == null) { line(pad + dir.getName() + "/ exists, NOT readable"); return; }
        line(pad + dir.getName() + "/ (" + kids.length + " entries)");
        Arrays.sort(kids, (x, y) -> Long.compare(y.lastModified(), x.lastModified()));
        int shown = 0;
        for (File k : kids) {
            if (k.isDirectory()) { if (depth < 4) listTree(k, depth + 1); continue; }
            if (newest == null || k.lastModified() > newest.lastModified()) newest = k;
            if (shown++ >= 15) continue;
            String read;
            try { read = "read OK sha " + sha(k).substring(0, 10); } catch (Exception e) { read = "read FAILED " + e.getClass().getSimpleName(); }
            line(pad + "  " + k.getName() + "  " + k.length() + " B  " + fmt.format(new Date(k.lastModified())) + "  " + read);
        }
        if (shown > 15) line(pad + "  … " + (shown - 15) + " more files");
    }

    private void mediaStoreTrash() {
        Uri uri = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL);
        Bundle q = new Bundle();
        q.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_ONLY);
        String[] cols = {MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_EXPIRES, MediaStore.MediaColumns.OWNER_PACKAGE_NAME};
        try (Cursor c = getContentResolver().query(uri, cols, q, null)) {
            if (c == null) { line("query returned nothing"); return; }
            line(c.getCount() + " trashed items");
            int i = 0;
            while (c.moveToNext() && i++ < 15) {
                String path = c.getString(0);
                File f = path == null ? null : new File(path);
                String read;
                try { read = f != null && f.canRead() ? "read OK sha " + sha(f).substring(0, 10) : "NOT readable"; }
                catch (Exception e) { read = "read FAILED " + e.getClass().getSimpleName(); }
                line("  " + path + "  " + c.getLong(1) + " B  expires " + fmt.format(new Date(c.getLong(2) * 1000))
                        + "  by " + c.getString(3) + "  " + read);
            }
        } catch (Exception e) { line("query FAILED: " + e); }
    }

    private static String sha(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) md.update(buf, 0, n);
        }
        StringBuilder s = new StringBuilder();
        for (byte x : md.digest()) s.append(String.format("%02x", x));
        return s.toString();
    }
}
