package il.hakolmilemala.m7200caralert;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.Manifest;
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
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.io.File;

public final class MainActivity extends Activity {
    private static final String GITHUB_URL = "https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert";
    private static final String UPDATE_PREFS = "app_updates";
    private static final String KEY_LAST_UPDATE_CHECK = "last_update_check";
    private static final String KEY_PENDING_INSTALL = "pending_install_path";
    private static final long AUTO_CHECK_INTERVAL = 7L * 24L * 60L * 60L * 1000L;
    private static final int REQUEST_INSTALL_PERMISSION = 4701;
    private static final int REQUEST_POST_NOTIFICATIONS = 4702;
    private static final int TEST_NOTIFICATION_ID = 7103;
    private static final String TEST_NOTIFICATION_CHANNEL = "tplink_battery_alert_test";

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
    private String lastRouterReportResult = "";
    private String lastRouterReportModel = "";
    private String lastRouterReportHardware = "";
    private String lastRouterReportFirmware = "";
    private String lastRouterReportDetails = "";
    private boolean pendingMonitoringStartAfterPermission = false;
    private boolean pendingTestAfterPermission = false;
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
        Button howToButton = findViewById(R.id.howToButton);
        Button testNotificationButton = findViewById(R.id.testNotificationButton);

        createTestNotificationChannel();
        howToButton.setOnClickListener(v -> showSetupGuide());
        testNotificationButton.setOnClickListener(v -> requestTestNotification());

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

        if (!getSharedPreferences("onboarding", MODE_PRIVATE).getBoolean("setup_guide_seen", false)) {
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

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_POST_NOTIFICATIONS) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        boolean shouldStart = pendingMonitoringStartAfterPermission;
        boolean shouldTest = pendingTestAfterPermission;
        pendingMonitoringStartAfterPermission = false;
        pendingTestAfterPermission = false;
        if (!granted) {
            new AlertDialog.Builder(this)
                    .setTitle("נדרשת הרשאת התראות")
                    .setMessage("בלי הרשאת התראות Android עלול להסתיר את התראת הסוללה. אפשר לאשר אותה בהגדרות האפליקציה.")
                    .setPositiveButton("פתיחת הגדרות", (dialog, which) -> openNotificationSettings())
                    .setNegativeButton("לא עכשיו", null)
                    .show();
            return;
        }
        if (shouldStart) startMonitoring();
        else if (shouldTest) postTestNotification();
    }

    private void startMonitoring() {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            pendingMonitoringStartAfterPermission = true;
            pendingTestAfterPermission = false;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_POST_NOTIFICATIONS);
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

    private void showSetupGuide() {
        String guide =
                "1. התחברו בטלפון או במולטימדיה לרשת ה-Wi-Fi של נתב TP-Link MiFi.\n\n" +
                "2. הזינו את סיסמת הניהול של הנתב — לא את סיסמת ה-Wi-Fi (אלא אם הן זהות).\n\n" +
                "3. לחצו על ״בדוק דגם, גרסה ותאימות״. האפליקציה תתחבר לנתב בקריאה בלבד ותנסה לקרוא את אחוז הסוללה.\n\n" +
                "4. לחצו על ״שמור והפעל ניטור״ ואשרו את הרשאת ההתראות של Android.\n\n" +
                "5. לחצו על ״שלח התראת ניסיון״ כדי לוודא שהטלפון מציג התראות. בדיקה זו בודקת את הטלפון, לא את הנתב.\n\n" +
                "אם ההתראות אינן מופיעות, בדקו שהן מותרות בהגדרות Android ושאין הגבלת פעילות ברקע / חיסכון בסוללה. במולטימדיה מסוימת צריך לאפשר גם Autostart.";
        new AlertDialog.Builder(this)
                .setTitle("ברוכים הבאים ל-TP-Link Battery Alert")
                .setMessage(guide)
                .setPositiveButton("הבנתי", (dialog, which) ->
                        getSharedPreferences("onboarding", MODE_PRIVATE).edit().putBoolean("setup_guide_seen", true).apply())
                .setNegativeButton("סגור", (dialog, which) ->
                        getSharedPreferences("onboarding", MODE_PRIVATE).edit().putBoolean("setup_guide_seen", true).apply())
                .show();
    }

    private void createTestNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(TEST_NOTIFICATION_CHANNEL,
                "בדיקת התראות", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("התראת ניסיון לבדיקת הצגת התראות בטלפון");
        channel.enableVibration(true);
        manager.createNotificationChannel(channel);
    }

    private void requestTestNotification() {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            pendingMonitoringStartAfterPermission = false;
            pendingTestAfterPermission = true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_POST_NOTIFICATIONS);
            return;
        }
        postTestNotification();
    }

    private void postTestNotification() {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            new AlertDialog.Builder(this)
                    .setTitle("ההתראות חסומות")
                    .setMessage("Android חוסם כרגע התראות מהאפליקציה. פתח את הגדרות ההתראות, אפשר אותן ונסה שוב.")
                    .setPositiveButton("פתיחת הגדרות", (dialog, which) -> openNotificationSettings())
                    .setNegativeButton("סגור", null).show();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            NotificationChannel channel = manager == null ? null : manager.getNotificationChannel(TEST_NOTIFICATION_CHANNEL);
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                openNotificationSettings();
                Toast.makeText(this, "ערוץ ההתראות של בדיקת הניסיון חסום. אפשר אותו בהגדרות.", Toast.LENGTH_LONG).show();
                return;
            }
        }
        try {
            NotificationCompat.Builder notification = new NotificationCompat.Builder(this, TEST_NOTIFICATION_CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_warning)
                    .setContentTitle("בדיקת התראות — TP-Link Battery Alert")
                    .setContentText("מצוין! הטלפון מציג התראות מהאפליקציה.")
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(
                            "זו התראת ניסיון בלבד. היא לא מעידה על מצב הסוללה או על תאימות הנתב."))
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setDefaults(NotificationCompat.DEFAULT_ALL)
                    .setAutoCancel(true);
            NotificationManagerCompat.from(this).notify(TEST_NOTIFICATION_ID, notification.build());
            Toast.makeText(this, "נשלחה התראת ניסיון. בדוק שהיא הופיעה בשורת ההתראות.", Toast.LENGTH_LONG).show();
        } catch (SecurityException error) {
            Toast.makeText(this, "Android חסם את הצגת ההתראה. בדוק את הרשאות ההתראות.", Toast.LENGTH_LONG).show();
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

    private void checkRouterCompatibility() {
        if (routerCheckInProgress) return;
        String password = passwordInput.getText().toString();
        if (password.isEmpty()) {
            try { password = SecurePasswordStore.read(this); }
            catch (Exception error) {
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
                String model = isUnknownIdentity(result.model) ? "לא דווח על ידי הנתב" : result.model;
                String hardware = isUnknownIdentity(result.hardwareVersion) ? "לא דווחה" : result.hardwareVersion;
                String firmware = isUnknownIdentity(result.firmwareVersion) ? "לא דווחה" : result.firmwareVersion;
                getSharedPreferences("router_profile", MODE_PRIVATE).edit()
                        .putString("model", result.model)
                        .putString("hardware_version", result.hardwareVersion)
                        .putString("firmware_version", result.firmwareVersion)
                        .putLong("last_checked", System.currentTimeMillis())
                        .putBoolean("compatible", true).apply();
                String message = "✅ הנתב תואם – קריאת הסוללה הצליחה.\n" +
                        "דגם: " + model + "\n" +
                        "גרסת חומרה: " + hardware + "\n" +
                        "גרסת קושחה: " + firmware + "\n" +
                        "קריאת סוללה: " + result.percent + "%" + (result.charging ? " • בטעינה" : "");
                runOnUiThread(() -> {
                    routerCompatibilityText.setText(message);
                    prepareCompatibilityReport("LIVE_SUCCESS", result.model, result.hardwareVersion,
                            result.firmwareVersion, "התחברות הצליחה ונתוני הסוללה נקראו בהצלחה.");
                    routerCheckInProgress = false;
                    checkRouterButton.setEnabled(true);
                });
            } catch (Exception error) {
                final String detail = safeReportValue(error.getMessage(), "לא התקבל פירוט נוסף");
                if (error instanceof M7200Client.ProtocolMismatchException) {
                    getSharedPreferences("router_profile", MODE_PRIVATE).edit()
                            .putLong("last_checked", System.currentTimeMillis())
                            .putBoolean("compatible", false).apply();
                }
                runOnUiThread(() -> {
                    if (error instanceof M7200Client.PasswordRejectedException) {
                        routerCompatibilityText.setText("🔒 לא ניתן להשלים אימות מול הנתב. ייתכן שסיסמת הניהול שגויה או שפרוטוקול ההצפנה שונה.\nהדגם לא סומן כלא נתמך. בדוק את הסיסמה ונסה שוב.");
                        reportRouterButton.setVisibility(View.GONE);
                    } else if (error instanceof M7200Client.ProtocolMismatchException) {
                        routerCompatibilityText.setText("⚠️ הנתב הגיב, אך ממשק התקשורת או מבנה נתוני הסוללה אינם תואמים לפרוטוקול הנוכחי.\nלפני דיווח שלילי נוודא שהחיבור והסיסמה נכונים.\nפרטים: " + detail);
                        prepareCompatibilityReport("PROTOCOL_MISMATCH", "", "", "", detail);
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

    private void prepareCompatibilityReport(String result, String model, String hardware,
                                            String firmware, String details) {
        lastRouterReportResult = result;
        lastRouterReportModel = safeReportValue(model, "");
        lastRouterReportHardware = safeReportValue(hardware, "");
        lastRouterReportFirmware = safeReportValue(firmware, "");
        lastRouterReportDetails = safeReportValue(details, "ללא פירוט");
        String displayModel = isUnknownIdentity(lastRouterReportModel) ? "דגם לא זוהה" : lastRouterReportModel;
        lastRouterReportTitle = "TP-Link Battery Alert – בדיקת תאימות: " + displayModel;
        reportRouterButton.setVisibility(View.VISIBLE);
    }

    private static String safeReportValue(String value, String fallback) {
        if (value == null || value.trim().isEmpty()) return fallback;
        String clean = value.replace('\n', ' ').replace('\r', ' ').trim();
        clean = clean.replace("<!--", "").replace("-->", "").replace("=", ":");
        return clean.length() > 140 ? clean.substring(0, 140) : clean;
    }

    private static boolean isUnknownIdentity(String value) {
        if (value == null || value.trim().isEmpty()) return true;
        String lower = value.trim().toLowerCase(java.util.Locale.ROOT);
        return lower.equals("unknown") || lower.equals("n/a") ||
                lower.startsWith("לא דווח") || lower.startsWith("לא זוהה") ||
                lower.startsWith("לא ידוע") || lower.equals("לא דווחה");
    }

    private void openCompatibilityReport() {
        if (lastRouterReportResult.isEmpty()) return;
        if ("LIVE_SUCCESS".equals(lastRouterReportResult)) {
            String[] choices = {
                    "כן, קיבלתי בפועל התראת סוללה",
                    "הסוללה עדיין לא הגיעה לסף ההתראה",
                    "הסוללה הגיעה לסף ולא קיבלתי התראה"
            };
            int[] selected = {-1};
            AlertDialog dialog = new AlertDialog.Builder(this)
                    .setTitle("בדיקת ההתראה בפועל")
                    .setMessage("קריאת הסוללה הצליחה. האם התראת הסוללה עצמה הופיעה כשהיה צריך? התשובה הזאת נרשמת בנפרד מתאימות הנתב.")
                    .setSingleChoiceItems(choices, -1, (d, which) -> selected[0] = which)
                    .setPositiveButton("המשך", null).setNegativeButton("ביטול", null).create();
            dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                if (selected[0] < 0) {
                    Toast.makeText(this, "בחר תשובה כדי להמשיך.", Toast.LENGTH_SHORT).show();
                    return;
                }
                String notificationResult = selected[0] == 0 ? "RECEIVED" :
                        selected[0] == 1 ? "NOT_REACHED" : "NOT_RECEIVED";
                dialog.dismiss();
                continueWithReport(notificationResult, true);
            }));
            dialog.show();
        } else {
            boolean[] confirmed = new boolean[3];
            String[] checks = {
                    "הטלפון מחובר לרשת ה-Wi-Fi של הנתב המדווח",
                    "הוזנה סיסמת מנהל הנתב (ולא רק סיסמת ה-Wi-Fi)",
                    "בדקתי את החיבור והסיסמה וניסיתי שוב"
            };
            AlertDialog dialog = new AlertDialog.Builder(this)
                    .setTitle("וידוא לפני דיווח על אי-תאימות")
                    .setMessage("כישלון בגלל רשת או סיסמה לא נכונה אינו אומר שהנתב אינו נתמך. אשר את שלושת הסעיפים לפני שליחת דיווח שלילי.")
                    .setMultiChoiceItems(checks, confirmed, (d, which, checked) -> confirmed[which] = checked)
                    .setPositiveButton("המשך", null).setNegativeButton("ביטול", null).create();
            dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                if (!confirmed[0] || !confirmed[1] || !confirmed[2]) {
                    Toast.makeText(this, "צריך לאשר את כל שלושת הסעיפים לפני הדיווח.", Toast.LENGTH_LONG).show();
                    return;
                }
                dialog.dismiss();
                continueWithReport("NOT_APPLICABLE", true);
            }));
            dialog.show();
        }
    }

    private void continueWithReport(String notificationResult, boolean preconditionsConfirmed) {
        if (isUnknownIdentity(lastRouterReportModel) ||
                isUnknownIdentity(lastRouterReportHardware) || isUnknownIdentity(lastRouterReportFirmware)) {
            showManualRouterIdentityDialog(notificationResult, preconditionsConfirmed);
        } else {
            showPublicReportConfirmation(notificationResult, preconditionsConfirmed);
        }
    }

    private void showManualRouterIdentityDialog(String notificationResult, boolean preconditionsConfirmed) {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (18 * getResources().getDisplayMetrics().density);
        panel.setPadding(pad, pad / 2, pad, 0);
        TextView explanation = new TextView(this);
        explanation.setText("כדי שלא נאחד בטעות גרסאות שונות, יש להשלים את פרטי הנתב לפי המדבקה שעל הנתב או ממשק הניהול. אם גרסת חומרה או קושחה אינה מופיעה, אפשר להשאיר ריק.");
        panel.addView(explanation);

        EditText modelInput = new EditText(this);
        modelInput.setSingleLine(true);
        modelInput.setHint("דגם מדויק, למשל M7350");
        if (!isUnknownIdentity(lastRouterReportModel)) modelInput.setText(lastRouterReportModel);
        panel.addView(modelInput);
        EditText hardwareInput = new EditText(this);
        hardwareInput.setSingleLine(true);
        hardwareInput.setHint("גרסת חומרה, למשל V9");
        if (!isUnknownIdentity(lastRouterReportHardware)) hardwareInput.setText(lastRouterReportHardware);
        panel.addView(hardwareInput);
        EditText firmwareInput = new EditText(this);
        firmwareInput.setSingleLine(true);
        firmwareInput.setHint("גרסת קושחה");
        if (!isUnknownIdentity(lastRouterReportFirmware)) firmwareInput.setText(lastRouterReportFirmware);
        panel.addView(firmwareInput);

        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("השלמת פרטי הנתב")
                .setView(panel).setPositiveButton("המשך", null).setNegativeButton("ביטול", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String model = safeReportValue(modelInput.getText().toString(), "");
            if (isUnknownIdentity(model)) {
                modelInput.setError("צריך להזין דגם מדויק");
                return;
            }
            lastRouterReportModel = model;
            lastRouterReportHardware = safeReportValue(hardwareInput.getText().toString(), "לא דווחה");
            lastRouterReportFirmware = safeReportValue(firmwareInput.getText().toString(), "לא דווחה");
            dialog.dismiss();
            showPublicReportConfirmation(notificationResult, preconditionsConfirmed);
        }));
        dialog.show();
    }

    private void showPublicReportConfirmation(String notificationResult, boolean preconditionsConfirmed) {
        String message =
                "ייפתח טופס דיווח ציבורי ב-GitHub, אבל שום דבר לא יישלח עד שתבדוק את הטיוטה ותלחץ Submit new issue.\n\n" +
                "נדרשת התחברות לחשבון GitHub, ושם המשתמש שלך יהיה גלוי בדיווח.\n\n" +
                "הדוח כולל רק דגם, גרסאות, תוצאת הבדיקה, תשובת ההתראה וגרסת האפליקציה. הוא אינו כולל סיסמאות, כתובת IP, שם Wi-Fi, MAC או IMEI.";
        new AlertDialog.Builder(this).setTitle("לאשר פתיחת טיוטת דיווח?")
                .setMessage(message)
                .setPositiveButton("פתח טיוטה ב-GitHub", (dialog, which) ->
                        launchCompatibilityIssue(notificationResult, preconditionsConfirmed))
                .setNegativeButton("ביטול", null).show();
    }

    private void launchCompatibilityIssue(String notificationResult, boolean preconditionsConfirmed) {
        String body =
                "<!-- tplink-battery-report:v2\n" +
                "result=" + safeReportValue(lastRouterReportResult, "UNKNOWN") + "\n" +
                "model=" + safeReportValue(lastRouterReportModel, "לא דווחה") + "\n" +
                "hardware=" + safeReportValue(lastRouterReportHardware, "לא דווחה") + "\n" +
                "firmware=" + safeReportValue(lastRouterReportFirmware, "לא דווחה") + "\n" +
                "notification_result=" + safeReportValue(notificationResult, "NOT_APPLICABLE") + "\n" +
                "preconditions_confirmed=" + preconditionsConfirmed + "\n" +
                "app_version=" + BuildConfig.VERSION_NAME + "\n" +
                "detail=" + safeReportValue(lastRouterReportDetails, "ללא פירוט") + "\n" +
                "-->\n\n" +
                "### דוח תאימות TP-Link Battery Alert\n\n" +
                "- תוצאת בדיקת הנתב: " + lastRouterReportResult + "\n" +
                "- דגם: " + lastRouterReportModel + "\n" +
                "- גרסת חומרה: " + lastRouterReportHardware + "\n" +
                "- גרסת קושחה: " + lastRouterReportFirmware + "\n" +
                "- תוצאת התראת סוללה: " + notificationResult + "\n" +
                "- גרסת האפליקציה: " + BuildConfig.VERSION_NAME + "\n" +
                "- פרטים: " + lastRouterReportDetails + "\n\n" +
                "הדיווח נוצר מתוך בדיקה בקריאה בלבד. לא נכללו בו סיסמת מנהל, סיסמת Wi-Fi, כתובת IP, שם רשת, כתובת MAC או IMEI.\n";
        String title = "TP-Link Battery Alert – בדיקת תאימות: " + lastRouterReportModel;
        try {
            Uri issue = Uri.parse("https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/issues/new")
                    .buildUpon().appendQueryParameter("title", title).appendQueryParameter("body", body).build();
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
                            "הניטור המקומי ממשיך לפעול כרגיל."
                    );
                    updateCheckInProgress = false;
                    checkUpdatesButton.setEnabled(true);
                    if (manual) {
                        Toast.makeText(this, "בדיקת העדכונים נכשלה. בדוק את חיבור האינטרנט.", Toast.LENGTH_LONG).show();
                    }
                });
            }
        }, "TP-Link-Battery-Alert-update-check").start();
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
