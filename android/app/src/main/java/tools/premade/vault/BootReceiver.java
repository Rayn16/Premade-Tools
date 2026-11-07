package tools.premade.vault;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts watching again after the phone restarts or the app updates. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) { WatchService.start(c); }
}
