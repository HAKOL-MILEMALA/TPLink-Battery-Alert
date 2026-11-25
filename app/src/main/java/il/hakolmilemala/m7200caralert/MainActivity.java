package il.hakolmilemala.m7200caralert;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;

public final class MainActivity extends Activity {
    private static final String GITHUB_URL = "https://github.com/HAKOL-MILEMALA/M7200CarAlert";
    private static final String UPDATE_PREFS = "app_updates";
    private static final String KEY_LAST_UPDATE_CHECK = "last_update_check";
    private static final String KEY_PENDING_INSTALL = "pending_install_path";
    private static final long AUTO_CHECK_INTERVAL = 7L * 24L * 60L * 60L * 1000L;
    private static final int REQUEST_INSTALL_PERMISSION = 4701;

    private EditText passwordInput;
    private TextView statusText;
    private TextView appVersionText;
    private TextView updateStatusText;
    private Button checkUpdatesButton;
    private Button downloadUpdateButton;
    private boolean updateCheckInProgress = false;
    private boolean updateDownloadInProgress = false;
    private UpdateChecker.UpdateInfo availableUpdate;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refreshStatus = new Runnable() {
        @Override
        public void run() {
            updateStatus();
            handler.postDelayed(this, 2500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        passwordInput = findViewById(R.id.passwordInput);
        statusText = findViewById(R.id.statusText);
        appVersionText = findViewById(R.id.appVersionText);
        updateStatusText = findViewById(R.id.updateStatusText);
        checkUpdatesButton = findViewById(R.id.checkUpdatesButton);
        downloadUpdateButton = findViewById(R.id.downloadUpdateButton);

        Button startButton = findViewById(R.id.startButton);
        Button stopButton = findViewById(R.id.stopButton);
        Button githubButton = findViewById(R.id.githubButton);

        passwordInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        appVersionText.setText("גרסה מותקנת: " + BuildConfig.VERSION_NAME);

        startButton.setOnClickListener(v -> startMonitoring());
        stopButton.setOnClickListener(v -> stopMonitoring());
        githubButton.setOnClickListener(v -> openGithub());
        checkUpdatesButton.setOnClickListener(v -> checkForUpdates(true));
        downloadUpdateButton.setOnClickListener(v -> downloadAndInstallUpdate());

        if (SecurePasswordStore.hasPassword(this)) {
            passwordInput.setHint("הסיסמה כבר שמורה. אפשר להשאיר ריק.");
        }

        updateStatusText.setText("בדיקת עדכונים אוטומטית מתבצעת לכל היותר פעם בשבוע. אפשר לבדוק ידנית בכל רגע.");
        if (getIntent() != null && getIntent().getBooleanExtra("check_updates_now", false)) {
            checkForUpdates(true);
        } else {
            maybeCheckUpdatesAutomatically();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.removeCallbacks(refreshStatus);
        handler.post(refreshStatus);
        resumePendingInstallIfAllowed();
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(refreshStatus);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(refreshStatus);
        super.onDestroy();
    }

    private void startMonitoring() {
        String typedPassword = passwordInput.getText().toString();
        try {
            if (!typedPassword.isEmpty()) {
                SecurePasswordStore.save(this, typedPassword);
                passwordInput.setText("");
                passwordInput.setHint("הסיסמה שמורה. ניתן לעדכן אותה כאן.");
            } else if (!SecurePasswordStore.hasPassword(this)) {
                Toast.makeText(this, "צריך להזין את סיסמת הניהול של הנתב.", Toast.LENGTH_LONG).show();
                return;
            }
        } catch (Exception e) {
            Toast.makeText(this, "לא הצלחתי לשמור את הסיסמה בצורה מאובטחת.", Toast.LENGTH_LONG).show();
            return;
        }

        SharedPreferences state = getSharedPreferences("monitor_state", MODE_PRIVATE);
        state.edit()
                .putBoolean("monitor_enabled", true)
                .apply();

        Intent service = new Intent(this, M7200MonitorService.class);
        service.setAction(M7200MonitorService.ACTION_RELOAD);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
        Toast.makeText(this, "הניטור הופעל. תופיע התראה כשהסוללה תגיע ל-10%.", Toast.LENGTH_LONG).show();
        updateStatus();
    }

    private void stopMonitoring() {
        getSharedPreferences("monitor_state", MODE_PRIVATE)
                .edit()
                .putBoolean("monitor_enabled", false)
                .apply();
        stopService(new Intent(this, M7200MonitorService.class));
        Toast.makeText(this, "הניטור הופסק.", Toast.LENGTH_SHORT).show();
        updateStatus();
    }

    private void updateStatus() {
        SharedPreferences state = getSharedPreferences("monitor_state", MODE_PRIVATE);
        boolean enabled = state.getBoolean("monitor_enabled", false);
        String text = state.getString("status_text", "עדיין לא התקבל מידע מהנתב.");
        String prefix = enabled ? "הניטור מופעל\n\n" : "הניטור כבוי\n\n";
        statusText.setText(prefix + text);
    }

    private void openGithub() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(GITHUB_URL)));
        } catch (Exception error) {
            Toast.makeText(this, "לא הצלחתי לפתוח את GitHub.", Toast.LENGTH_SHORT).show();
        }
    }

    private void maybeCheckUpdatesAutomatically() {
        SharedPreferences prefs = getSharedPreferences(UPDATE_PREFS, MODE_PRIVATE);
        long lastCheck = prefs.getLong(KEY_LAST_UPDATE_CHECK, 0L);
        if (System.currentTimeMillis() - lastCheck >= AUTO_CHECK_INTERVAL) {
            checkForUpdates(false);
        }
    }

    private void checkForUpdates(boolean manual) {
        if (updateCheckInProgress) return;

        updateCheckInProgress = true;
        checkUpdatesButton.setEnabled(false);
        updateStatusText.setText("בודק אם קיימת גרסה חדשה ב-GitHub…");

        getSharedPreferences(UPDATE_PREFS, MODE_PRIVATE)
                .edit()
                .putLong(KEY_LAST_UPDATE_CHECK, System.currentTimeMillis())
                .apply();

        new Thread(() -> {
            try {
                UpdateChecker.UpdateInfo found = UpdateChecker.checkForUpdate();
                runOnUiThread(() -> {
                    availableUpdate = found;
                    if (found == null) {
                        downloadUpdateButton.setVisibility(View.GONE);
                        updateStatusText.setText(manual
                                ? "האפליקציה מעודכנת ✅ (גרסה " + BuildConfig.VERSION_NAME + ")."
                                : "לא נמצאה גרסה חדשה. האפליקציה מעודכנת.");
                    } else if ("1.0.1".equals(BuildConfig.VERSION_NAME) && "1.0.2".equals(found.version)) {
                        // The first APK was signed with a temporary CI debug key.
                        // Android cannot replace that installation with the new stable signing key.
                        downloadUpdateButton.setVisibility(View.GONE);
                        updateStatusText.setText(
                                "נמצאה גרסה 1.0.2. זו החלפה חד-פעמית למפתח חתימה קבוע. " +
                                "Android לא יאפשר עדכון ישיר מעל גרסה 1.0.1.\\n" +
                                "יש להסיר את 1.0.1 ולהתקין את 1.0.2 מה-Releases ב-GitHub. " +
                                "ההסרה מוחקת את סיסמת הנתב וההעדפות. לאחר מכן העדכונים יעבדו מתוך האפליקציה."
                        );
                    } else {
                        downloadUpdateButton.setVisibility(View.VISIBLE);
                        downloadUpdateButton.setEnabled(true);
                        updateStatusText.setText(
                                "נמצאה גרסה חדשה: " + found.version +
                                "\nמותקנת כרגע: " + BuildConfig.VERSION_NAME +
                                "\nאפשר להוריד ולהתקין בלחיצה."
                        );
                    }
                    updateCheckInProgress = false;
                    checkUpdatesButton.setEnabled(true);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    updateStatusText.setText(
                            "לא הצלחתי לבדוק עדכונים. ודא שיש אינטרנט ונסה שוב.\n" +
                            "הניטור המקומי של ה-M7200 ממשיך לפעול כרגיל."
                    );
                    updateCheckInProgress = false;
                    checkUpdatesButton.setEnabled(true);
                    if (manual) {
                        Toast.makeText(this, "בדיקת העדכונים נכשלה. בדוק את חיבור האינטרנט.", Toast.LENGTH_LONG).show();
                    }
                });
            }
        }, "M7200-update-check").start();
    }

    private void downloadAndInstallUpdate() {
        if (availableUpdate == null || updateDownloadInProgress) return;

        updateDownloadInProgress = true;
        downloadUpdateButton.setEnabled(false);
        checkUpdatesButton.setEnabled(false);
        updateStatusText.setText("מוריד את גרסה " + availableUpdate.version + "…");

        UpdateChecker.UpdateInfo update = availableUpdate;
        new Thread(() -> {
            try {
                File apk = UpdateChecker.downloadApk(this, update);
                runOnUiThread(() -> {
                    updateDownloadInProgress = false;
                    downloadUpdateButton.setEnabled(true);
                    checkUpdatesButton.setEnabled(true);
                    updateStatusText.setText("ההורדה הושלמה. פותח את מתקין Android…");
                    requestInstallOrOpenInstaller(apk);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    updateDownloadInProgress = false;
                    downloadUpdateButton.setEnabled(true);
                    checkUpdatesButton.setEnabled(true);
                    updateStatusText.setText("הורדת העדכון נכשלה. אפשר לנסות שוב.");
                    Toast.makeText(this, error.getMessage() == null
                            ? "שגיאה בהורדת העדכון."
                            : error.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }, "M7200-update-download").start();
    }

    private void requestInstallOrOpenInstaller(File apk) {
        if (apk == null || !apk.isFile()) {
            updateStatusText.setText("קובץ העדכון לא נמצא. נסה להוריד שוב.");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !getPackageManager().canRequestPackageInstalls()) {
            getSharedPreferences(UPDATE_PREFS, MODE_PRIVATE)
                    .edit()
                    .putString(KEY_PENDING_INSTALL, apk.getAbsolutePath())
                    .apply();

            new AlertDialog.Builder(this)
                    .setTitle("נדרשת הרשאת התקנה")
                    .setMessage("כדי להתקין עדכון, Android צריך לאפשר לאפליקציה להתקין קובץ APK. במסך שייפתח הפעל את האפשרות 'אפשר ממקור זה', ואז חזור לאפליקציה.")
                    .setPositiveButton("פתיחת הגדרות", (dialog, which) -> {
                        try {
                            Intent settings = new Intent(
                                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getPackageName())
                            );
                            startActivityForResult(settings, REQUEST_INSTALL_PERMISSION);
                        } catch (Exception error) {
                            updateStatusText.setText("לא הצלחתי לפתוח את הגדרות ההתקנה. אפשר לאשר התקנה ממקור זה בהגדרות Android.");
                        }
                    })
                    .setNegativeButton("לא עכשיו", (dialog, which) -> {
                        updateStatusText.setText("העדכון הורד ונשמר. אפשר לאפשר התקנה ממקור זה ולחזור לכאן.");
                    })
                    .show();
            return;
        }

        launchInstaller(apk);
    }

    private void resumePendingInstallIfAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
                !getPackageManager().canRequestPackageInstalls()) return;

        SharedPreferences prefs = getSharedPreferences(UPDATE_PREFS, MODE_PRIVATE);
        String path = prefs.getString(KEY_PENDING_INSTALL, null);
        if (path == null || path.isEmpty()) return;

        prefs.edit().remove(KEY_PENDING_INSTALL).apply();
        File apk = new File(path);
        if (apk.isFile()) launchInstaller(apk);
    }

    private void launchInstaller(File apk) {
        try {
            Uri apkUri = FileProvider.getUriForFile(
                    this,
                    getPackageName() + ".fileprovider",
                    apk
            );
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(apkUri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(install);
        } catch (Exception error) {
            updateStatusText.setText("Android לא הצליח לפתוח את מתקין החבילות. אפשר להתקין את קובץ ה-APK דרך מנהל הקבצים.");
            Toast.makeText(this, "לא הצלחתי לפתוח את מתקין Android.", Toast.LENGTH_LONG).show();
        }
    }
}
