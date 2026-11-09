package tools.premade.vault;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Firebase wakes the app the moment something is dropped on this phone. It asks the PC what arrived (the normal
 *  notification); when the PC can't be reached, it shows what the push itself said. */
public class PushService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) { Drops.sendToken(this, token); }

    @Override public void onMessageReceived(RemoteMessage m) {
        if (Drops.check(this)) return;
        String title = m.getData().get("title"), body = m.getData().get("body");
        Drops.show(this, (int) System.currentTimeMillis(), title != null ? title : "Premade Tools", body != null ? body : "");
    }
}
