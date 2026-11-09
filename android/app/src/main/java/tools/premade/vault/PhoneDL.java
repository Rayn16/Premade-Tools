package tools.premade.vault;

import android.content.Context;
import android.media.MediaScannerConnection;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.function.IntConsumer;

/** The Downloader on the phone alone, for when the PC can't be reached: the same yt-dlp the PC uses, built into
 *  the app with its Python and FFmpeg. Results go into Movies, Pictures or Music › Premade, like the PC's do. */
final class PhoneDL {
    private static boolean ready;

    private static synchronized void init(Context c) throws Exception {
        if (ready) return;
        YoutubeDL.getInstance().init(c.getApplicationContext());
        FFmpeg.getInstance().init(c.getApplicationContext());
        ready = true;
    }

    /** Blocks until done. Returns the saved names, one per line, or "ERR:" and why. */
    static synchronized String run(Context c, String url, boolean audio, IntConsumer progress) {
        File dir = new File(c.getCacheDir(), "phonedl");
        try {
            init(c);
            for (int round = 0; ; round++) {
                deleteAll(dir);
                dir.mkdirs();
                YoutubeDLRequest r = new YoutubeDLRequest(url);
                r.addOption("-o", dir.getAbsolutePath() + "/%(title).80B [%(id)s].%(ext)s");
                r.addOption("--no-playlist");
                if (audio) { r.addOption("-x"); r.addOption("--audio-format", "mp3"); }
                else { r.addOption("-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"); r.addOption("--merge-output-format", "mp4"); }
                try {
                    YoutubeDL.getInstance().execute(r, null, (pct, eta, line) -> { progress.accept(Math.round(pct)); return kotlin.Unit.INSTANCE; });
                    break;
                } catch (Exception e) {
                    // Sites change often; a newer yt-dlp usually fixes it. Try that once.
                    if (round > 0) throw e;
                    YoutubeDL.getInstance().updateYoutubeDL(c.getApplicationContext(), YoutubeDL.UpdateChannel._STABLE);
                }
            }
            List<String> names = new ArrayList<>();
            File[] got = dir.listFiles();
            for (int k = 0; got != null && k < got.length; k++) {
                File f = got[k];
                File d = Downloads.dir();
                File out = new File(d, f.getName());
                for (int i = 2; out.exists(); i++) out = new File(d, i + " " + f.getName());
                if (!f.renameTo(out)) { java.nio.file.Files.copy(f.toPath(), out.toPath()); f.delete(); }
                MediaScannerConnection.scanFile(c, new String[]{out.getPath()}, null, null);
                names.add(out.getName());
            }
            if (names.isEmpty()) return "ERR:Nothing was downloaded from that link.";
            return String.join("\n", names);
        } catch (Throwable e) {
            String m = String.valueOf(e.getMessage());
            int at = m.lastIndexOf("ERROR:");
            return "ERR:" + (at >= 0 ? m.substring(at + 6).trim().split("\n")[0] : "That link didn't download on this phone.");
        } finally { deleteAll(dir); }
    }

    private static void deleteAll(File d) {
        File[] l = d.listFiles();
        for (int k = 0; l != null && k < l.length; k++) { if (l[k].isDirectory()) deleteAll(l[k]); l[k].delete(); }
    }
}
