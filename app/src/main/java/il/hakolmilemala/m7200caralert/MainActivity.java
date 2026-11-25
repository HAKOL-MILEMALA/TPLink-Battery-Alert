package il.hakolmilemala.m7200caralert;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Network;
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
    private TextView routerCompatibilityText;
    private Button checkRouterButton;
    private Button reportRouterButton;
    private boolean routerCheckInProgress = false;
    private String lastRouterReportTitle = "";
    private String lastRouterReportBody = "";
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
        routerCompatibilityText = findViewById(R.id.routerCompatibilityText);
        checkRouterButton = findViewById(R.id.checkRouterButton);
        reportRouterButton = findViewById(R.id.reportRouterButton);

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
        checkRouterButton.setOnClickListener(v -> checkRouterCompatibility());
        reportRouterButton.setOnClickListener(v -> openCompatibilityReport());

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

    private void checkRouterCompatibility() {
        if (routerCheckInProgress) return;
        String password = passwordInput.getText().toString();
        if (password.isEmpty()) {
            try {
                password = SecurePasswordStore.read(this);
            } catch (Exception error) {
                routerCompatibilityText.setText("לא הצלחתי לקרוא את הסיסמה השמורה. הזן את סיסמת הניהול ונסה שוב.");
                return;
            }
        }
        if (password == null || password.isEmpty()) {
            routerCompatibilityText.setText("כדי לבדוק תאימות צריך להזין את סיסמת הניהול של הנתב. הבדיקה אינה משנה הגדרות.");
            passwordInput.requestFocus();
            return;
        }
        Network wifiNetwork = RouterNetworkHelper.findWifiNetwork(this);
        if (wifiNetwork == null) {
            routerCompatibilityText.setText("המולטימדיה אינה מחוברת כרגע לרשת Wi-Fi של הנתב. התחבר לרשת ה-MiFi ונסה שוב.");
            return;
        }
        final String routerPassword = password;
        final String routerHost = RouterNetworkHelper.findRouterHost(this, wifiNetwork);
        routerCheckInProgress = true;
        checkRouterButton.setEnabled(false);
        reportRouterButton.setVisibility(View.GONE);
        routerCompatibilityText.setText("מתחבר לנתב, מזהה דגם וקושחה ובודק אם ניתן לקרוא את הסוללה…");
        new Thread(() -> {
            M7200Client client = new M7200Client();
            client.setWifiNetwork(wifiNetwork);
            client.setRouterHost(routerHost);
            try {
                M7200Client.BatteryStatus result = client.readBattery(routerPassword);
                String model = result.model.isEmpty() ? "לא דווח על ידי הנתב" : result.model;
                String hardware = result.hardwareVersion.isEmpty() ? "לא דווחה" : result.hardwareVersion;
                String firmware = result.firmwareVersion.isEmpty() ? "לא דווחה" : result.firmwareVersion;
                getSharedPreferences("router_profile", MODE_PRIVATE).edit()
                        .putString("model", result.model)
                        .putString("hardware_version", result.hardwareVersion)
                        .putString("firmware_version", result.firmwareVersion)
                        .putLong("last_checked", System.currentTimeMillis())
                        .putBoolean("compatible", true)
                        .apply();
                String message = "✅ הנתב תואם – קריאת הסוללה הצליחה.\n" +
                        "דגם: " + model + "\n" +
                        "גרסת חומרה: " + hardware + "\n" +
                        "גרסת קושחה: " + firmware + "\n" +
                        "קריאת סוללה: " + result.percent + "%" +
                        (result.charging ? " • בטעינה" : "");
                final String reportModel = model;
                final String reportHardware = hardware;
                final String reportFirmware = firmware;
                runOnUiThread(() -> {
                    routerCompatibilityText.setText(message);
                    prepareCompatibilityReport("LIVE_SUCCESS", reportModel, reportHardware, reportFirmware,
                            "התחברות הצליחה ונתוני הסוללה נקראו בהצלחה.");
                    routerCheckInProgress = false;
                    checkRouterButton.setEnabled(true);
                });
            } catch (Exception error) {
                final String detail = safeReportValue(error.getMessage(), "לא התקבל פירוט נוסף");
                getSharedPreferences("router_profile", MODE_PRIVATE).edit()
                        .putLong("last_checked", System.currentTimeMillis())
                        .putBoolean("compatible", false)
                        .apply();
                runOnUiThread(() -> {
                    if (error instanceof M7200Client.PasswordRejectedException) {
                        routerCompatibilityText.setText("🔒 לא ניתן להשלים אימות מול הנתב. ייתכן שסיסמת הניהול שגויה או שפרוטוקול ההצפנה שונה.\nהדגם לא סומן כלא נתמך. בדוק את הסיסמה ונסה שוב.");
                        reportRouterButton.setVisibility(View.GONE);
                    } else if (error instanceof M7200Client.ProtocolMismatchException) {
                        routerCompatibilityText.setText("⚠️ הנתב הגיב, אך ממשק התקשורת או מבנה נתוני הסוללה אינם תואמים לפרוטוקול הנוכחי.\nהדגם הזה אינו נתמך כרגע בגרסה הנוכחית. אפשר לשלוח דוח כדי לבדוק הוספת תמיכה.\nפרטים: " + detail);
                        prepareCompatibilityReport("PROTOCOL_MISMATCH", "לא זוהה", "לא ידועה", "לא ידועה", detail);
                    } else {
                        routerCompatibilityText.setText("לא ניתן לקבוע כרגע אם הנתב נתמך.\nבדוק שהמולטימדיה מחוברת ל-Wi-Fi של הנתב ונסה שוב.\nפרטים: " + detail);
                        reportRouterButton.setVisibility(View.GONE);
                    }
                    routerCheckInProgress = false;
                    checkRouterButton.setEnabled(true);
                });
            }
        }, "TP-Link-router-compatibility").start();
    }

    private void prepareCompatibilityReport(String result, String model,
                                            String hardware, String firmware, String details) {
        String safeModel = safeReportValue(model, "לא זוהה");
        String safeHardware = safeReportValue(hardware, "לא ידועה");
        String safeFirmware = safeReportValue(firmware, "לא ידועה");
        String safeDetails = safeReportValue(details, "ללא פירוט");
        lastRouterReportTitle = "בדיקת תאימות נתב: " + safeModel;
        lastRouterReportBody =
                "### דוח בדיקת תאימות TP-Link MiFi\n\n" +
                "- תוצאת בדיקה: " + result + "\n" +
                "- דגם: " + safeModel + "\n" +
                "- גרסת חומרה: " + safeHardware + "\n" +
                "- גרסת קושחה: " + safeFirmware + "\n" +
                "- גרסת האפליקציה: " + BuildConfig.VERSION_NAME + "\n" +
                "- פרטים: " + safeDetails + "\n\n" +
                "הדוח נוצר מתוך בדיקת קריאה בלבד. לא נכללו בו סיסמת ניהול, כתובת IP מקומית, שם רשת Wi-Fi, כתובת MAC או IMEI.\n";
        reportRouterButton.setVisibility(View.VISIBLE);
    }

    private static String safeReportValue(String value, String fallback) {
        if (value == null || value.trim().isEmpty()) return fallback;
        String clean = value.replace('\n', ' ').replace('\r', ' ').trim();
        if (clean.length() > 140) clean = clean.substring(0, 140);
        return clean;
    }

    private void openCompatibilityReport() {
        if (lastRouterReportBody.isEmpty()) return;
        try {
            Uri issue = Uri.parse("https://github.com/HAKOL-MILEMALA/M7200CarAlert/issues/new")
                    .buildUpon()
                    .appendQueryParameter("title", lastRouterReportTitle)
                    .appendQueryParameter("body", lastRouterReportBody)
                    .build();
            startActivity(new Intent(Intent.ACTION_VIEW, issue));
        } catch (Exception error) {
            Toast.makeText(this, "לא הצלחתי לפתוח טופס דיווח ב-GitHub.", Toast.LENGTH_LONG).show();
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
