package il.hakolmilemala.m7200caralert;

import android.Manifest;
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
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;


import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String GITHUB_URL =
            "https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert";
    private static final int REQUEST_POST_NOTIFICATIONS = 4702;

    private EditText passwordInput;
    private TextView batteryPercentText;
    private TextView batteryUpdatedText;
    private TextView statusText;
    private TextView appVersionText;
    private TextView updateStatusText;
    private Button checkUpdatesButton;
    private Button openUpdateBrowserButton;

    private boolean pendingMonitoringStartAfterPermission;
    private boolean updateCheckInProgress;
    private UpdateChecker.UpdateInfo availableUpdate;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refreshStatus = new Runnable() {
        @Override
        public void run() {
            updateStatus();
            handler.postDelayed(this, 1200L);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        passwordInput = findViewById(R.id.passwordInput);
        batteryPercentText = findViewById(R.id.batteryPercentText);
        batteryUpdatedText = findViewById(R.id.batteryUpdatedText);
        statusText = findViewById(R.id.statusText);
        appVersionText = findViewById(R.id.appVersionText);
        updateStatusText = findViewById(R.id.updateStatusText);
        checkUpdatesButton = findViewById(R.id.checkUpdatesButton);
        openUpdateBrowserButton = findViewById(R.id.downloadUpdateButton);

        Button startButton = findViewById(R.id.startButton);
        Button stopButton = findViewById(R.id.stopButton);
        Button githubButton = findViewById(R.id.githubButton);
        Button howToButton = findViewById(R.id.howToButton);
        Button backgroundSettingsButton = findViewById(R.id.backgroundSettingsButton);

        passwordInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        appVersionText.setText("גרסה מותקנת: " + BuildConfig.VERSION_NAME);

        startButton.setOnClickListener(v -> startMonitoring());
        stopButton.setOnClickListener(v -> stopMonitoring());
        githubButton.setOnClickListener(v -> openGithub());
        howToButton.setOnClickListener(v -> showSetupGuide());
        backgroundSettingsButton.setOnClickListener(v -> openBackgroundPermissionSettings());
        checkUpdatesButton.setOnClickListener(v -> checkForUpdates(true));
        openUpdateBrowserButton.setOnClickListener(v -> openUpdateInBrowser());

        if (SecurePasswordStore.hasPassword(this)) {
            passwordInput.setHint("הסיסמה כבר שמורה. אפשר להשאיר ריק.");
        }

        openUpdateBrowserButton.setVisibility(View.GONE);
        updateStatusText.setText("אפשר לבדוק עדכונים בכל רגע. בנוסף מתבצעת בדיקה אוטומטית ברקע אחת לשבוע.");
        updateStatus();
        UpdateCheckScheduler.schedule(this);

        if (getIntent() != null && getIntent().getBooleanExtra("check_updates_now", false)) {
            checkForUpdates(true);
        } else {
            maybeCheckUpdatesAutomatically();
        }

        if (!getSharedPreferences("onboarding", MODE_PRIVATE)
                .getBoolean("setup_guide_seen", false)) {
            handler.postDelayed(() -> {
                if (!isFinishing()) showSetupGuide();
            }, 450L);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.removeCallbacks(refreshStatus);
        handler.post(refreshStatus);

        SharedPreferences monitorState = getSharedPreferences("monitor_state", MODE_PRIVATE);
        if (monitorState.getBoolean("monitor_enabled", false)) {
            monitorState.edit()
                    .putBoolean("connection_checking", true)
                    .putString("connection_status", "בודק חיבור לנתב…")
                    .apply();
            startMonitorService(M7200MonitorService.ACTION_CHECK_NOW);
        }
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

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_POST_NOTIFICATIONS) return;

        boolean granted = grantResults.length > 0 &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED;
        boolean shouldStart = pendingMonitoringStartAfterPermission;
        pendingMonitoringStartAfterPermission = false;

        if (granted && shouldStart) {
            startMonitoring();
            return;
        }

        if (!granted) {
            new AlertDialog.Builder(this)
                    .setTitle("נדרשת הרשאת התראות")
                    .setMessage("כדי לקבל התראת סוללה בזמן, צריך לאפשר לאפליקציה להציג התראות.")
                    .setPositiveButton("פתיחת הגדרות", (dialog, which) -> openNotificationSettings())
                    .setNegativeButton("לא עכשיו", null)
                    .show();
        }
    }

    private void startMonitoring() {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            pendingMonitoringStartAfterPermission = true;
            requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQUEST_POST_NOTIFICATIONS
            );
            return;
        }

        String typedPassword = passwordInput.getText().toString();
        try {
            if (!typedPassword.isEmpty()) {
                SecurePasswordStore.save(this, typedPassword);
                passwordInput.setText("");
                passwordInput.setHint("הסיסמה שמורה. ניתן לעדכן אותה כאן.");
            } else if (!SecurePasswordStore.hasPassword(this)) {
                Toast.makeText(this, "צריך להזין את סיסמת הניהול של הנתב.", Toast.LENGTH_LONG).show();
                passwordInput.requestFocus();
                return;
            }
        } catch (Exception error) {
            Toast.makeText(this, "לא הצלחתי לשמור את הסיסמה בצורה מאובטחת.", Toast.LENGTH_LONG).show();
            return;
        }

        getSharedPreferences("monitor_state", MODE_PRIVATE).edit()
                .putBoolean("monitor_enabled", true)
                .putBoolean("initial_check_pending", true)
                .putBoolean("initial_check_completed", false)
                .putBoolean("connection_ok", false)
                .putBoolean("connection_checking", true)
                .putString("connection_status", "בודק חיבור לנתב…")
                .apply();

        startMonitorService(M7200MonitorService.ACTION_RELOAD);
        Toast.makeText(this, "בודק את החיבור לנתב…", Toast.LENGTH_SHORT).show();
        updateStatus();
    }

    private void stopMonitoring() {
        getSharedPreferences("monitor_state", MODE_PRIVATE).edit()
                .putBoolean("monitor_enabled", false)
                .putBoolean("initial_check_pending", false)
                .putBoolean("connection_checking", false)
                .putString("connection_status", "הניטור הופסק.")
                .apply();

        Intent service = new Intent(this, M7200MonitorService.class);
        service.setAction(M7200MonitorService.ACTION_STOP);
        try {
            startService(service);
        } catch (Exception ignored) {
            stopService(new Intent(this, M7200MonitorService.class));
        }

        Toast.makeText(this, "הניטור הופסק.", Toast.LENGTH_SHORT).show();
        updateStatus();
    }

    private void startMonitorService(String action) {
        Intent service = new Intent(this, M7200MonitorService.class);
        service.setAction(action);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(service);
            } else {
                startService(service);
            }
        } catch (Exception error) {
            String message = "Android לא אפשר להפעיל את הניטור ברקע. פתח את האפליקציה ונסה שוב.";
            getSharedPreferences("monitor_state", MODE_PRIVATE).edit()
                    .putBoolean("connection_ok", false)
                    .putBoolean("connection_checking", false)
                    .putString("connection_status", message)
                    .putLong("connection_checked_time", System.currentTimeMillis())
                    .apply();
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        }
    }

    private void updateStatus() {
        SharedPreferences state = getSharedPreferences("monitor_state", MODE_PRIVATE);
        boolean enabled = state.getBoolean("monitor_enabled", false);
        int lastPercent = state.getInt("last_battery_percent", -1);
        long lastRead = state.getLong("last_battery_time", 0L);
        boolean charging = state.getBoolean("last_battery_charging", false);

        boolean checking = state.getBoolean("connection_checking", false);
        if (lastPercent >= 0 && lastPercent <= 100 && lastRead > 0L) {
            batteryPercentText.setText(lastPercent + "%");
            batteryPercentText.setTextColor(lastPercent <= 10
                    ? 0xFFC0392B : 0xFF176B45);
            String freshness = checking
                    ? "בודק עדכון… • הקריאה הקודמת: " + formatReadTime(lastRead)
                    : state.getBoolean("connection_ok", false)
                        ? formatBatteryTimestamp(lastRead)
                        : formatReadTime(lastRead);
            batteryUpdatedText.setText(freshness +
                    (charging ? " • בטעינה" : " • לא בטעינה"));
        } else {
            batteryPercentText.setText("--");
            batteryPercentText.setTextColor(0xFF18324A);
            batteryUpdatedText.setText(checking
                    ? "בודק את קריאת הסוללה הראשונה…"
                    : "עדיין לא התקבלה קריאת סוללה.");
        }

        String connection = state.getString("connection_status", "עדיין לא בוצעה בדיקת חיבור.");
        boolean connectionChecked = state.getLong("connection_checked_time", 0L) > 0L;
        boolean connectionOk = state.getBoolean("connection_ok", false);

        String prefix = enabled ? "הניטור פעיל" : "הניטור כבוי";
        statusText.setText(prefix + "\n" + connection);
        statusText.setTextColor(checking ? 0xFF526579
                : !connectionChecked ? 0xFF526579
                : connectionOk ? 0xFF176B45 : 0xFFC0392B);

        if (state.getBoolean("initial_check_pending", false) &&
                state.getBoolean("initial_check_completed", false)) {
            boolean success = state.getBoolean("initial_check_success", false);
            String result = state.getString("connection_status", "");
            state.edit().putBoolean("initial_check_pending", false).apply();

            if (success) {
                int percent = state.getInt("last_battery_percent", -1);
                Toast.makeText(this, percent >= 0
                        ? "החיבור הצליח. הסוללה: " + percent + "%."
                        : "החיבור לנתב הצליח.", Toast.LENGTH_LONG).show();
            } else {
                Toast.makeText(this, "החיבור נכשל: " + result, Toast.LENGTH_LONG).show();
            }

            if (enabled) maybeAskForBackgroundPermission();
        }
    }

    private String formatBatteryTimestamp(long timestamp) {
        long age = Math.max(0L, System.currentTimeMillis() - timestamp);
        if (age < 90_000L) return "עודכן עכשיו";
        return formatReadTime(timestamp);
    }

    private String formatReadTime(long timestamp) {
        String formatted = new SimpleDateFormat("dd/MM HH:mm", Locale.getDefault())
                .format(new Date(timestamp));
        return "עודכן לאחרונה: " + formatted;
    }

    private void maybeAskForBackgroundPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;

        SharedPreferences setup = getSharedPreferences("app_setup", MODE_PRIVATE);
        if (setup.getBoolean("background_permission_prompted", false)) return;

        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power != null && power.isIgnoringBatteryOptimizations(getPackageName())) {
            setup.edit().putBoolean("background_permission_prompted", true).apply();
            return;
        }

        setup.edit().putBoolean("background_permission_prompted", true).apply();
        new AlertDialog.Builder(this)
                .setTitle("לאפשר ניטור גם כשהמסך כבוי?")
                .setMessage("כדי שהניטור ימשיך לעבוד בזמן שהמולטימדיה ישנה, מומלץ לאפשר לאפליקציה לפעול ללא אופטימיזציית סוללה. בחלק מהמולטימדיות צריך לאשר בנוסף Autostart בהגדרות היצרן.")
                .setPositiveButton("אפשר פעילות ברקע", (dialog, which) -> openBackgroundPermissionSettings())
                .setNegativeButton("אחר כך", null)
                .show();
    }

    private void openBackgroundPermissionSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            Toast.makeText(this, "ההגדרה הזו אינה זמינה בגרסת Android הנוכחית.", Toast.LENGTH_SHORT).show();
            return;
        }

        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power != null && power.isIgnoringBatteryOptimizations(getPackageName())) {
            Toast.makeText(this, "הפעילות ברקע כבר אינה מוגבלת.", Toast.LENGTH_SHORT).show();
            return;
        }

        try {
            Intent request = new Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())
            );
            startActivity(request);
        } catch (Exception requestError) {
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception settingsError) {
                try {
                    Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName()));
                    startActivity(details);
                } catch (Exception ignored) {
                    Toast.makeText(this, "לא הצלחתי לפתוח את הגדרות הפעילות ברקע.", Toast.LENGTH_LONG).show();
                }
            }
        }
    }

    private void openNotificationSettings() {
        try {
            Intent settings = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            settings.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(settings);
        } catch (Exception error) {
            Toast.makeText(this, "לא הצלחתי לפתוח את הגדרות ההתראות.", Toast.LENGTH_LONG).show();
        }
    }

    private void openGithub() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(GITHUB_URL)));
        } catch (Exception error) {
            Toast.makeText(this, "לא הצלחתי לפתוח את GitHub.", Toast.LENGTH_SHORT).show();
        }
    }

    private void showSetupGuide() {
        String guide =
                "1. התחבר לרשת ה-Wi-Fi של הנתב הנייד.\n\n" +
                "2. הזן את סיסמת הניהול של הנתב — לא את סיסמת ה-Wi-Fi (אלא אם הן זהות).\n\n" +
                "3. לחץ על ״שמור והפעל ניטור״. האפליקציה תבדוק מיד אם הצליחה להתחבר ולקרוא את אחוז הסוללה.\n\n" +
                "4. אשר את הרשאת ההתראות ואת הבקשה לאפשר פעילות ברקע ללא הגבלות סוללה.\n\n" +
                "5. בחלק מהמולטימדיות צריך לאפשר גם Autostart / הפעלה אוטומטית בהגדרות היצרן. אין באנדרואיד מסך אחיד להגדרה הזו.\n\n" +
                "בכל כניסה לאפליקציה תתבצע קריאה חדשה. הניטור מנסה להתחדש אחרי אתחול ואחרי שהמסך מתעורר משינה.";
        new AlertDialog.Builder(this)
                .setTitle("איך מתחילים?")
                .setMessage(guide)
                .setPositiveButton("הבנתי", (dialog, which) ->
                        getSharedPreferences("onboarding", MODE_PRIVATE).edit()
                                .putBoolean("setup_guide_seen", true).apply())
                .show();
    }

    private void maybeCheckUpdatesAutomatically() {
        SharedPreferences prefs = getSharedPreferences(
                UpdateCheckScheduler.PREFERENCES_NAME, MODE_PRIVATE);
        long lastCheck = prefs.getLong(UpdateCheckScheduler.KEY_LAST_SUCCESSFUL_CHECK, 0L);
        if (System.currentTimeMillis() - lastCheck >= UpdateCheckScheduler.CHECK_INTERVAL_MILLIS) {
            checkForUpdates(false);
        }
    }

    private void checkForUpdates(boolean manual) {
        if (updateCheckInProgress) return;

        updateCheckInProgress = true;
        checkUpdatesButton.setEnabled(false);
        openUpdateBrowserButton.setVisibility(View.GONE);
        availableUpdate = null;
        updateStatusText.setText("בודק אם קיימת גרסה חדשה…");

        new Thread(() -> {
            try {
                UpdateChecker.UpdateInfo found = UpdateChecker.checkForUpdate();
                UpdateCheckScheduler.recordSuccessfulCheck(getApplicationContext());

                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    availableUpdate = found;
                    if (found == null) {
                        openUpdateBrowserButton.setVisibility(View.GONE);
                        updateStatusText.setText(manual
                                ? "האפליקציה מעודכנת ✅ (גרסה " + BuildConfig.VERSION_NAME + ")."
                                : "לא נמצאה גרסה חדשה. האפליקציה מעודכנת.");
                    } else {
                        openUpdateBrowserButton.setVisibility(View.VISIBLE);
                        openUpdateBrowserButton.setEnabled(true);
                        updateStatusText.setText(
                                "נמצאה גרסה חדשה: " + found.version +
                                "\nמותקנת כרגע: " + BuildConfig.VERSION_NAME +
                                "\nלחץ על הכפתור כדי לפתוח את ההורדה בדפדפן."
                        );
                    }
                    updateCheckInProgress = false;
                    checkUpdatesButton.setEnabled(true);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    updateStatusText.setText("לא הצלחתי לבדוק עדכונים. בדוק את חיבור האינטרנט ונסה שוב.");
                    updateCheckInProgress = false;
                    checkUpdatesButton.setEnabled(true);
                    if (manual) {
                        Toast.makeText(this, "בדיקת העדכונים נכשלה.", Toast.LENGTH_LONG).show();
                    }
                });
            }
        }, "battery-alert-update-check").start();
    }

    private void openUpdateInBrowser() {
        if (availableUpdate == null ||
                !UpdateChecker.isTrustedDownloadUrl(availableUpdate.downloadUrl)) {
            updateStatusText.setText("קישור ההורדה אינו תקין. בדוק שוב אם יש עדכון.");
            return;
        }

        try {
            Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(availableUpdate.downloadUrl));
            browser.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(browser);
            updateStatusText.setText(
                    "הדפדפן נפתח להורדת גרסה " + availableUpdate.version +
                    ". לאחר ההורדה פתח את קובץ ה-APK ואשר את ההתקנה."
            );
        } catch (Exception error) {
            updateStatusText.setText("לא הצלחתי לפתוח דפדפן להורדת העדכון.");
            Toast.makeText(this, "לא הצלחתי לפתוח את קישור ההורדה.", Toast.LENGTH_LONG).show();
        }
    }
}
