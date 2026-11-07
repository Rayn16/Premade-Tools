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
    private static final int PERIODIC = 1, ON_CHANGE = 2, NOW = 3;

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
        c.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(NOW, new ComponentName(c, WatchJob.class)).setExpedited(true).build());
    }

    @Override public boolean onStartJob(JobParameters p) {
        new Thread(() -> {
            Watcher.runOnce(this);
            if (p.getJobId() == ON_CHANGE) schedule(this);
            jobFinished(p, false);
        }).start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters p) { return true; }
}
