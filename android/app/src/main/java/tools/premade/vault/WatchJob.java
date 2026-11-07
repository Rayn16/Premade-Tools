package tools.premade.vault;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.provider.MediaStore;

/**
 * Runs the watcher with no notification: right after anything changes in the phone's files (a delete into the
 * bin changes them), every 15 minutes as a safety net, and at once when the app asks.
 */
public class WatchJob extends JobService {
    private static final int PERIODIC = 1, ON_CHANGE = 2, NOW = 3, DOWNLOADS = 4;

    static void schedule(Context c) {
        if (!Vault.paired(c)) return;
        JobScheduler js = c.getSystemService(JobScheduler.class);
        ComponentName me = new ComponentName(c, WatchJob.class);
        if (js.getPendingJob(PERIODIC) == null)
            js.schedule(new JobInfo.Builder(PERIODIC, me).setPeriodic(15 * 60_000).setPersisted(true).build());
        // Content-change jobs fire once, so this is scheduled again after every run.
        js.schedule(new JobInfo.Builder(ON_CHANGE, me)
                .addTriggerContentUri(new JobInfo.TriggerContentUri(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL),
                        JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
                .setTriggerContentUpdateDelay(2000).setTriggerContentMaxDelay(10_000).build());
    }

    static void now(Context c) {
        JobInfo.Builder b = new JobInfo.Builder(NOW, new ComponentName(c, WatchJob.class));
        if (android.os.Build.VERSION.SDK_INT >= 31) b.setExpedited(true); else b.setOverrideDeadline(0);
        c.getSystemService(JobScheduler.class).schedule(b.build());
    }

    /** Sends a shared link (if any), then saves this phone's downloads into Gallery as they finish. */
    static void downloads(Context c, String link) {
        android.os.PersistableBundle x = new android.os.PersistableBundle();
        if (link != null) x.putString("link", link);
        // A new share replaces a watch that's already going; the new one picks up everything.
        c.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(DOWNLOADS, new ComponentName(c, WatchJob.class))
                .setExtras(x).setOverrideDeadline(0).build());
    }

    @Override public boolean onStartJob(JobParameters p) {
        if (p.getJobId() == DOWNLOADS) {
            new Thread(() -> {
                String link = p.getExtras().getString("link");
                if (link == null || Downloads.share(this, link)) {
                    long end = System.currentTimeMillis() + 9 * 60_000; // jobs get 10 minutes
                    while (Downloads.saveAll(this) && System.currentTimeMillis() < end)
                        try { Thread.sleep(3000); } catch (InterruptedException e) { break; }
                }
                jobFinished(p, false);
            }).start();
            return true;
        }
        new Thread(() -> {
            Watcher.runOnce(this);
            Downloads.saveAll(this); // anything that finished while the phone was away
            if (p.getJobId() == ON_CHANGE) schedule(this);
            jobFinished(p, false);
        }).start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters p) { return true; }
}
