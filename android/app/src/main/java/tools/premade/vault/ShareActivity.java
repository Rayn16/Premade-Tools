package tools.premade.vault;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

/** Takes a link from the Share menu, hands it to a background job and closes at once. */
public class ShareActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        String text = getIntent().getStringExtra(Intent.EXTRA_TEXT);
        if (!Vault.paired(this)) Toast.makeText(this, "Open Premade Tools and pair it with your PC first.", Toast.LENGTH_LONG).show();
        else if (text == null || text.isBlank()) Toast.makeText(this, "That didn't come with a link.", Toast.LENGTH_LONG).show();
        else {
            Toast.makeText(this, "Sending to your PC…", Toast.LENGTH_SHORT).show();
            WatchJob.downloads(this, text);
        }
        finish();
    }
}
