package live.daebot.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    private static final String PAGE_HOST = "daebot.live";
    private static final String DOWNLOAD_HOST = "download.m-i-n-d.ai";
    private static final String UPDATE_FILE = "Daebot-update.apk";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean busy = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView wv = getBridge().getWebView();
        wv.addJavascriptInterface(new DaebotBridge(), "DaebotAndroid");
    }

    /** True only when the top-level page is https://daebot.live. */
    private boolean originAllowed() {
        final boolean[] ok = {false};
        if (Looper.myLooper() == Looper.getMainLooper()) {
            ok[0] = checkOrigin();
            return ok[0];
        }
        final Object lock = new Object();
        ui.post(() -> {
            synchronized (lock) { ok[0] = checkOrigin(); lock.notifyAll(); }
        });
        synchronized (lock) {
            try { lock.wait(2000); } catch (InterruptedException ignored) {}
        }
        return ok[0];
    }

    private boolean checkOrigin() {
        try {
            String url = getBridge().getWebView().getUrl();
            if (url == null) return false;
            Uri u = Uri.parse(url);
            return "https".equals(u.getScheme()) && PAGE_HOST.equalsIgnoreCase(u.getHost());
        } catch (Exception e) {
            return false;
        }
    }

    private void emit(int pct, String state, String message) {
        try {
            JSONObject d = new JSONObject();
            d.put("pct", pct);
            d.put("state", state);
            d.put("message", message == null ? "" : message);
            final String js = "window.dispatchEvent(new CustomEvent('daebot-update-progress',{detail:"
                    + d.toString() + "}));";
            runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(js, null));
        } catch (Exception ignored) {}
    }

    private void fail(String message) {
        busy = false;
        emit(0, "error", message);
    }

    public class DaebotBridge {
        @JavascriptInterface
        public String getVersion() {
            try {
                android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
                JSONObject o = new JSONObject();
                o.put("versionName", pi.versionName);
                o.put("versionCode", code);
                return o.toString();
            } catch (Exception e) {
                return "{\"versionName\":\"\",\"versionCode\":0}";
            }
        }

        @JavascriptInterface
        public void downloadAndInstall(final String url, final String sha256) {
            if (!originAllowed()) return;
            if (busy) { emit(0, "error", "An update is already in progress."); return; }
            Uri uri;
            try {
                uri = Uri.parse(url);
                if (!"https".equals(uri.getScheme()) || uri.getHost() == null
                        || !DOWNLOAD_HOST.equalsIgnoreCase(uri.getHost()) || uri.getUserInfo() != null) {
                    emit(0, "error", "Update source is not allowed.");
                    return;
                }
            } catch (Exception e) {
                emit(0, "error", "Invalid update URL.");
                return;
            }
            if (sha256 == null || !sha256.trim().matches("(?i)[0-9a-f]{64}")) {
                emit(0, "error", "Missing or invalid checksum.");
                return;
            }
            final String expected = sha256.trim().toLowerCase(Locale.ROOT);
            final Uri dl = uri;
            ui.post(() -> start(dl, expected));
        }
    }

    private void start(Uri uri, String expected) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(s);
            emit(0, "error", "Allow Daebot to install updates, then go back and tap Update again.");
            return;
        }
        busy = true;
        final File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        final File out = new File(dir, UPDATE_FILE);
        if (out.exists()) out.delete();
        final DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Request r = new DownloadManager.Request(uri);
        r.setTitle("Daebot update");
        r.setMimeType("application/vnd.android.package-archive");
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
        r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, UPDATE_FILE);
        final long id;
        try {
            id = dm.enqueue(r);
        } catch (Exception e) {
            fail("Could not start the download.");
            return;
        }
        emit(0, "downloading", "");
        poll(dm, id, out, expected);
    }

    private void poll(final DownloadManager dm, final long id, final File out, final String expected) {
        ui.postDelayed(() -> {
            try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
                if (c == null || !c.moveToFirst()) { fail("Download was cancelled."); return; }
                int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                long done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    verifyAndInstall(out, expected);
                } else if (status == DownloadManager.STATUS_FAILED) {
                    fail("Download failed.");
                } else {
                    int pct = total > 0 ? (int) Math.min(99, done * 100 / total) : 0;
                    emit(pct, "downloading", "");
                    poll(dm, id, out, expected);
                }
            } catch (Exception e) {
                fail("Download error.");
            }
        }, 400);
    }

    private void verifyAndInstall(final File apk, final String expected) {
        emit(100, "verifying", "");
        new Thread(() -> {
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                try (InputStream in = new FileInputStream(apk)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
                }
                StringBuilder sb = new StringBuilder();
                for (byte b : md.digest()) sb.append(String.format("%02x", b));
                if (!sb.toString().equals(expected)) {
                    apk.delete();
                    fail("Update failed the integrity check and was discarded.");
                    return;
                }
                runOnUiThread(() -> install(apk));
            } catch (Exception e) {
                fail("Could not verify the update.");
            }
        }).start();
    }

    private void install(File apk) {
        try {
            Uri content = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(content, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            emit(100, "installing", "");
            startActivity(i);
            busy = false;
        } catch (Exception e) {
            fail("Could not open the installer.");
        }
    }
}
