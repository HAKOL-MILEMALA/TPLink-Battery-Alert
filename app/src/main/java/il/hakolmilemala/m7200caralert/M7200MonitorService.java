package il.hakolmilemala.m7200caralert;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;

import java.io.IOException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class M7200MonitorService extends Service {
    public static final String ACTION_STOP = "il.hakolmilemala.m7200caralert.STOP";
    public static final String ACTION_RELOAD = "il.hakolmilemala.m7200caralert.RELOAD";
    public static final String ACTION_CHECK_NOW = "il.hakolmilemala.m7200caralert.CHECK_NOW";

    private static final String CHANNEL_SERVICE = "m7200_monitor_service";
    private static final String CHANNEL_ALERT = "m7200_low_battery_alert";
    private static final int NOTIFICATION_SERVICE_ID = 7100;
    private static final int NOTIFICATION_ALERT_ID = 7101;
    private static final int WARNING_LEVEL = 10;
    private static final int RESET_LEVEL = 15;
    private static final long POLL_INTERVAL_SECONDS = 60L;
    private static final long ALERT_REPEAT_INTERVAL_MS = 3L * 60L * 1000L;
    private static final long WAKE_EVENT_COOLDOWN_MS = 15_000L;

    private ScheduledExecutorService executor;
    private volatile M7200Client client = new M7200Client();
    private volatile boolean stopping;
    private boolean loopStarted;
    private boolean wakeReceiverRegistered;
    private long lastWakeCheckAt;

    private final BroadcastReceiver wakeReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || !isMonitoringEnabled()) return;
            requestWakeCheck();
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        executor = createMonitorExecutor();
        registerWakeReceiver();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopMonitoring();
            return START_NOT_STICKY;
        }

        if (!isMonitoringEnabled()) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        stopping = false;
        boolean reloadRequested = intent != null && ACTION_RELOAD.equals(intent.getAction());
        boolean checkRequested = intent == null ||
                ACTION_CHECK_NOW.equals(intent.getAction()) || reloadRequested;

        if (reloadRequested) {
            client = new M7200Client();
        }

        promoteToForeground(buildServiceNotification("מתחבר לנתב…"));
        if (executor == null || executor.isShutdown()) {
            executor = createMonitorExecutor();
            loopStarted = false;
        }

        if (!loopStarted) {
            loopStarted = true;
            executor.scheduleWithFixedDelay(
                    this::pollSafely,
                    checkRequested ? 0L : 2L,
                    POLL_INTERVAL_SECONDS,
                    TimeUnit.SECONDS
            );
        } else if (checkRequested) {
            executor.execute(this::pollSafely);
        }

        return START_STICKY;
    }

    private boolean isMonitoringEnabled() {
        return getSharedPreferences("monitor_state", MODE_PRIVATE)
                .getBoolean("monitor_enabled", false);
    }

    private void registerWakeReceiver() {
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_USER_PRESENT);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(wakeReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(wakeReceiver, filter);
            }
            wakeReceiverRegistered = true;
        } catch (Exception ignored) {
            wakeReceiverRegistered = false;
        }
    }

    private void requestWakeCheck() {
        long now = System.currentTimeMillis();
        if (now - lastWakeCheckAt < WAKE_EVENT_COOLDOWN_MS) return;
        lastWakeCheckAt = now;

        ScheduledExecutorService current = executor;
        if (current == null || current.isShutdown() || stopping) return;

        current.execute(this::pollSafely);
        // Some car head units wake the screen before the Wi-Fi radio is ready.
        // A second check shortly afterwards avoids waiting for the normal minute interval.
        current.schedule(this::pollSafely, 8L, TimeUnit.SECONDS);
    }

    private void promoteToForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFICATION_SERVICE_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(NOTIFICATION_SERVICE_ID, notification);
        }
    }

    private ScheduledExecutorService createMonitorExecutor() {
        return Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "battery-monitor");
            thread.setDaemon(true);
            return thread;
        });
    }

    private void pollSafely() {
        if (stopping || !isMonitoringEnabled()) return;

        getSharedPreferences("monitor_state", MODE_PRIVATE).edit()
                .putBoolean("connection_checking", true)
                .putString("connection_status", "בודק חיבור לנתב…")
                .apply();

        try {
            boolean success = pollOnce();
            completeInitialCheck(success);
        } catch (Exception error) {
            String message = readableError(error);
            saveConnectionFailure(message);
            updateServiceNotification("החיבור נכשל • מנסה שוב");
            completeInitialCheck(false);
        }
    }

    private boolean pollOnce() throws Exception {
        Network wifiNetwork = RouterNetworkHelper.findWifiNetwork(this);
        if (wifiNetwork == null) {
            saveConnectionFailure("המכשיר אינו מחובר כרגע לרשת ה-Wi-Fi של הנתב.");
            updateServiceNotification("ממתין לחיבור Wi-Fi");
            return false;
        }

        // Send router requests through its Wi-Fi network, even when Android
        // considers the router network to have no internet access.
        client.setWifiNetwork(wifiNetwork);
        client.setRouterHost(RouterNetworkHelper.findRouterHost(this, wifiNetwork));

        String password = SecurePasswordStore.read(this);
        if (password == null || password.isEmpty()) {
            saveConnectionFailure("לא נשמרה סיסמת ניהול. פתח את האפליקציה והזן אותה.");
            updateServiceNotification("נדרשת סיסמת ניהול");
            return false;
        }

        M7200Client.BatteryStatus battery = client.readBattery(password);
        if (!battery.batteryConnected) {
            saveConnectionFailure("הנתב ענה, אך לא התקבלו נתוני סוללה מוכרים.");
            updateServiceNotification("נתוני הסוללה לא זוהו");
            return false;
        }

        saveBattery(battery);
        updateServiceNotification("סוללה: " + battery.percent + "%" +
                (battery.charging ? " • בטעינה" : ""));

        handleLowBattery(battery);
        return true;
    }

    private String readableError(Exception error) {
        if (error instanceof M7200Client.PasswordRejectedException) {
            return "סיסמת הניהול נדחתה. בדוק את הסיסמה שהזנת.";
        }
        if (error instanceof M7200Client.ProtocolMismatchException) {
            return "הנתב הגיב, אבל מבנה התקשורת או נתוני הסוללה אינו מוכר.";
        }
        if (error instanceof IOException) {
            return "לא הצלחתי לתקשר עם הנתב. בדוק שה-Wi-Fi מחובר ושהנתב זמין.";
        }

        String detail = error.getMessage();
        if (detail == null || detail.trim().isEmpty()) {
            return "החיבור נכשל בגלל שגיאה לא מזוהה.";
        }
        detail = detail.replace('\n', ' ').replace('\r', ' ').trim();
        if (detail.length() > 170) detail = detail.substring(0, 170);
        return "החיבור נכשל: " + detail;
    }

    private void saveBattery(M7200Client.BatteryStatus battery) {
        long now = System.currentTimeMillis();
        getSharedPreferences("monitor_state", MODE_PRIVATE).edit()
                .putInt("last_battery_percent", battery.percent)
                .putLong("last_battery_time", now)
                .putBoolean("last_battery_charging", battery.charging)
                .putBoolean("connection_ok", true)
                .putBoolean("connection_checking", false)
                .putString("connection_status", "החיבור הצליח. נתוני הסוללה התקבלו.")
                .putLong("connection_checked_time", now)
                .putString("status_text", "החיבור הצליח.")
                .putLong("status_time", now)
                .apply();
    }

    private void saveConnectionFailure(String message) {
        long now = System.currentTimeMillis();
        getSharedPreferences("monitor_state", MODE_PRIVATE).edit()
                .putBoolean("connection_ok", false)
                .putBoolean("connection_checking", false)
                .putString("connection_status", message)
                .putLong("connection_checked_time", now)
                .putString("status_text", message)
                .putLong("status_time", now)
                .apply();
        // Keep the last real reading so the UI can display it as an older value.
    }

    private void completeInitialCheck(boolean success) {
        SharedPreferences state = getSharedPreferences("monitor_state", MODE_PRIVATE);
        if (!state.getBoolean("initial_check_pending", false)) return;
        state.edit()
                .putBoolean("initial_check_success", success)
                .putBoolean("initial_check_completed", true)
                .apply();
    }

    private void handleLowBattery(M7200Client.BatteryStatus battery) {
        SharedPreferences state = getSharedPreferences("monitor_state", MODE_PRIVATE);
        NotificationManager manager =
                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);

        if (battery.percent >= RESET_LEVEL) {
            state.edit().putLong("low_battery_alert_last_time", 0L).apply();
            if (manager != null) manager.cancel(NOTIFICATION_ALERT_ID);
            return;
        }

        if (battery.charging) {
            state.edit().putLong("low_battery_alert_last_time", 0L).apply();
            if (manager != null) manager.cancel(NOTIFICATION_ALERT_ID);
            return;
        }

        if (battery.percent > WARNING_LEVEL) return;

        long now = System.currentTimeMillis();
        long lastAlert = state.getLong("low_battery_alert_last_time", 0L);
        if (lastAlert == 0L || now - lastAlert >= ALERT_REPEAT_INTERVAL_MS) {
            showLowBatteryAlert(battery.percent);
            state.edit().putLong("low_battery_alert_last_time", now).apply();
        }
    }

    private Notification buildServiceNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
                this,
                1,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new Notification.Builder(this, CHANNEL_SERVICE)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle("ניטור סוללה פעיל")
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .build();
    }

    private void updateServiceNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_SERVICE_ID, buildServiceNotification(text));
        }
    }

    private void showLowBatteryAlert(int percent) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
                this,
                2,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String message = "נותרו " + percent + "% סוללה. חבר את הנתב הנייד למטען.";
        Notification notification = new Notification.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle("התראת סוללה")
                .setContentText(message)
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setContentIntent(pending)
                .setAutoCancel(false)
                .setOnlyAlertOnce(false)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .setCategory(Notification.CATEGORY_ALARM)
                .setPriority(Notification.PRIORITY_MAX)
                .setDefaults(Notification.DEFAULT_ALL)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .build();

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ALERT_ID, notification);
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel serviceChannel = new NotificationChannel(
                CHANNEL_SERVICE,
                "פעילות ניטור סוללה",
                NotificationManager.IMPORTANCE_LOW
        );
        serviceChannel.setDescription("חיווי שקט שהניטור פועל ברקע");
        serviceChannel.setSound(null, null);
        serviceChannel.enableVibration(false);
        serviceChannel.setShowBadge(false);
        manager.createNotificationChannel(serviceChannel);

        NotificationChannel alertChannel = new NotificationChannel(
                CHANNEL_ALERT,
                "התראת סוללה נמוכה",
                NotificationManager.IMPORTANCE_HIGH
        );
        alertChannel.setDescription("התראה בולטת ותזכורת כל 3 דקות כשהסוללה ב-10% ומטה ואינה בטעינה");
        alertChannel.enableVibration(true);
        alertChannel.setVibrationPattern(new long[]{0L, 550L, 220L, 550L, 220L, 750L});
        alertChannel.setSound(
                Settings.System.DEFAULT_NOTIFICATION_URI,
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .build()
        );
        manager.createNotificationChannel(alertChannel);
    }

    private void stopMonitoring() {
        stopping = true;
        getSharedPreferences("monitor_state", MODE_PRIVATE).edit()
                .putBoolean("monitor_enabled", false)
                .putBoolean("initial_check_pending", false)
                .putString("connection_status", "הניטור הופסק.")
                .apply();

        if (executor != null) executor.shutdownNow();
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(NOTIFICATION_ALERT_ID);
            manager.cancel(NOTIFICATION_SERVICE_ID);
        }

        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopping = true;
        if (wakeReceiverRegistered) {
            try {
                unregisterReceiver(wakeReceiver);
            } catch (Exception ignored) {
            }
            wakeReceiverRegistered = false;
        }
        if (executor != null) executor.shutdownNow();
        loopStarted = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
