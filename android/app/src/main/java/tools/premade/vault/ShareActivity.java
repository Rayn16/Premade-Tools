package tools.premade.vault;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

/** Takes a link from the Share menu, asks video or sound, hands it to a background job and closes. */
public class ShareActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        String text = getIntent().getStringExtra(Intent.EXTRA_TEXT);
        if (!Vault.paired(this)) Toast.makeText(this, "Open Premade Tools and pair it with your PC first.", Toast.LENGTH_LONG).show();
        else if (text == null || text.isBlank()) Toast.makeText(this, "That didn't come with a link.", Toast.LENGTH_LONG).show();
        else {
            new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle("Download as")
                .setItems(new String[]{"Video (MP4)", "Sound only (MP3)"}, (d, w) -> {
                    Toast.makeText(this, "Sending to your PC…", Toast.LENGTH_SHORT).show();
                    WatchJob.downloads(this, (w == 1 ? Downloads.MP3 : "") + text);
                })
                .setOnDismissListener(d -> finish()).show();
            return;
        }
        finish();
    }
}
