package tools.premade.vault;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Toast;

/** "Send with Premade" in the Share menu: sends photos, files, links or text to the PC's File drop. It stays
 *  open (and invisible) until the upload ends, so the Share menu's permission to read the files lasts. */
public class SendActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (!Vault.paired(this)) {
            Toast.makeText(this, "Open Premade Tools and pair it with your PC first.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        Toast.makeText(this, "Sending to your PC…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            String msg = Drops.send(this, getIntent());
            runOnUiThread(() -> { Toast.makeText(getApplicationContext(), msg, Toast.LENGTH_LONG).show(); finish(); });
        }).start();
    }
}
