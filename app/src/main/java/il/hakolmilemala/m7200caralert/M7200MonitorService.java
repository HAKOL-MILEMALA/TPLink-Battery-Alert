package il.hakolmilemala.m7200caralert;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.IBinder;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class M7200MonitorService extends Service {
    public static final String ACTION_STOP = "il.hakolmilemala.m7200caralert.STOP";
    public static final String ACTION_RELOAD = "il.hakolmilemala.m7200caralert.RELOAD";
    private static final String CHANNEL_SERVICE = "m7200_monitor_service";
    private static final String CHANNEL_ALERT = "m7200_low_battery_alert";
    private static final String CHANNEL_UPDATE = "m7200_app_updates";
    private static final int NOTIFICATION_SERVICE_ID = 7100;
    private static final int NOTIFICATION_ALERT_ID = 7101;
    private static final int NOTIFICATION_UPDATE_ID = 7102;
    private static final int WARNING_LEVEL = 10;
    private static final int RESET_LEVEL = 15;
    private static final long POLL_INTERVAL_SECONDS = 60;

    private ScheduledExecutorService executor;
    private volatile M7200Client client = new M7200Client();
    private volatile boolean stopping = false;
    private boolean loopStarted = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        executor = createMonitorExecutor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopMonitoring();
            return START_NOT_STICKY;
        }

        stopping = false;
        boolean reloadRequested = intent != null && ACTION_RELOAD.equals(intent.getAction());
        if (reloadRequested) {
            client = new M7200Client();
        }

        promoteToForeground(buildServiceNotification("מפעיל ניטור…"));
        if (executor == null || executor.isShutdown()) {
            executor = createMonitorExecutor();
            loopStarted = false;
        }

        // Schedule one non-overlapping polling loop. If settings/password were
        // reloaded while it was already running, queue an immediate fresh poll.
        if (!loopStarted) {
            loopStarted = true;
            executor.scheduleWithFixedDelay(
                    this::pollSafely,
                    2,
                    POLL_INTERVAL_SECONDS,
                    TimeUnit.SECONDS
            );
        } else if (reloadRequested) {
            executor.execute(this::pollSafely);
        }
        return START_STICKY;
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
            Thread thread = new Thread(r, "M7200-battery-monitor");
            thread.setDaemon(true);
            return thread;
        });
    }

    private void pollSafely() {
        if (stopping) return;
        try {
            pollOnce();
        } catch (Exception error) {
            String message = error.getMessage();
            if (message == null || message.trim().isEmpty()) message = "שגיאה לא מזוהה";
            saveStatus("לא הצלחתי לקרוא את מצב הסוללה: " + message + "\nאנסה שוב בעוד דקה.");
            updateServiceNotification("ממתין לנתב או לסיסמה תקינה");
        }
    }

    private void pollOnce() throws Exception {
        Network wifiNetwork = findWifiNetwork();
        if (wifiNetwork == null) {
            saveStatus("המולטימדיה אינה מחוברת כרגע לרשת Wi-Fi. הניטור ממתין לחיבור.");
            updateServiceNotification("ממתין לחיבור Wi-Fi של M7200");
            return;
        }
        // Force the HTTP requests through Wi-Fi even when Android considers
        // that network "no internet" or has another default network available.
        client.setWifiNetwork(wifiNetwork);

        String password = SecurePasswordStore.read(this);
        if (password == null || password.isEmpty()) {
            saveStatus("לא נשמרה סיסמת נתב. פתח את האפליקציה והזן אותה.");
            updateServiceNotification("נדרשת סיסמת ניהול");
            return;
        }

        M7200Client.BatteryStatus battery = client.readBattery(password);
        if (!battery.batteryConnected) {
            saveStatus("הנתב מחובר, אך הסוללה אינה מזוהה.");
            updateServiceNotification("הסוללה אינה מזוהה");
            return;
        }

        SharedPreferences state = getSharedPreferences("monitor_state", MODE_PRIVATE);
        boolean alreadyAlerted = state.getBoolean("low_battery_alert_sent", false);

        // Re-arm only after the battery has recovered to 15%.
        // Merely plugging in briefly while still below 15% must not cause a duplicate warning.
        if (battery.percent >= RESET_LEVEL) {
            alreadyAlerted = false;
            state.edit().putBoolean("low_battery_alert_sent", false).apply();
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.cancel(NOTIFICATION_ALERT_ID);
        }

        saveBattery(battery.percent, battery.charging);
        updateServiceNotification("ניטור פעיל • סוללה " + battery.percent + "%");

        if (!battery.charging && battery.percent <= WARNING_LEVEL && !alreadyAlerted) {
            state.edit().putBoolean("low_battery_alert_sent", true).apply();
            showLowBatteryAlert(battery.percent);
        }

        // A quiet daily GitHub check runs while monitoring is active.
        // When internet is unavailable, retry after six hours; the local
        // M7200 battery monitoring remains independent of GitHub.
        maybeCheckForAppUpdate();
    }

    private Network findWifiNetwork() {
        try {
            ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return null;

            // Prefer Android's active network when it is Wi-Fi.
            Network active = manager.getActiveNetwork();
            if (active != null) {
                NetworkCapabilities activeCaps = manager.getNetworkCapabilities(active);
                if (activeCaps != null && activeCaps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    return active;
                }
            }

            // Do not require NET_CAPABILITY_VALIDATED: the M7200 may have no
            // internet access while its local management API is still reachable.
            for (Network network : manager.getAllNetworks()) {
                NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
                if (capabilities != null &&
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    return network;
                }
            }
        } catch (Exception ignored) {
            // The next polling cycle will retry when connectivity is available.
        }
        return null;
    }

    private void saveBattery(int percent, boolean charging) {
        String text = "מחובר ל-M7200\nסוללה: " + percent + "%" +
                (charging ? " • בטעינה" : " • לא בטעינה");
        saveStatus(text);
    }

    private void saveStatus(String status) {
        getSharedPreferences("monitor_state", MODE_PRIVATE)
                .edit()
                .putString("status_text", status)
                .putLong("status_time", System.currentTimeMillis())
                .apply();
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
                .setContentTitle("התראת סוללת M7200")
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .build();
    }

    private void updateServiceNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_SERVICE_ID, buildServiceNotification(text));
    }

    private void showLowBatteryAlert(int percent) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
                this,
                2,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new Notification.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle("🔋 סוללת ה־M7200 חלשה")
                .setContentText("נותרו " + percent + "% סוללה. כדאי לחבר את המטען עכשיו.")
                .setStyle(new Notification.BigTextStyle().bigText(
                        "נותרו " + percent + "% סוללה בסטיק ה־TP-Link M7200. " +
                                "כדאי לחבר אותו למטען לפני שייכבה."
                ))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_ALARM)
                .setPriority(Notification.PRIORITY_MAX)
                .setDefaults(Notification.DEFAULT_ALL)
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
                "פעילות ניטור M7200",
                NotificationManager.IMPORTANCE_LOW
        );
        serviceChannel.setDescription("חיווי שקט שהניטור פועל ברקע");
        serviceChannel.setSound(null, null);
        serviceChannel.enableVibration(false);
        serviceChannel.setShowBadge(false);
        manager.createNotificationChannel(serviceChannel);

        NotificationChannel updateChannel = new NotificationChannel(
                CHANNEL_UPDATE,
                "עדכוני אפליקציה",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        updateChannel.setDescription("הודעה שקטה יחסית כאשר קיימת גרסה חדשה לאפליקציה");
        updateChannel.setShowBadge(false);
        manager.createNotificationChannel(updateChannel);

        NotificationChannel alertChannel = new NotificationChannel(
                CHANNEL_ALERT,
                "התראת סוללה נמוכה",
                NotificationManager.IMPORTANCE_HIGH
        );
        alertChannel.setDescription("התראה בולטת כאשר סוללת ה-M7200 מגיעה ל-10%");
        alertChannel.enableVibration(true);
        alertChannel.setVibrationPattern(new long[]{0, 400, 200, 400});
        manager.createNotificationChannel(alertChannel);
    }

    private void maybeCheckForAppUpdate() {
        SharedPreferences prefs = getSharedPreferences("app_updates", MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long nextCheck = prefs.getLong("background_next_check", 0L);
        if (now < nextCheck) return;

        // Set a retry window before the request, so a missing internet link
        // does not cause a GitHub request on every 60-second battery poll.
        prefs.edit().putLong("background_next_check", now + 6L * 60L * 60L * 1000L).apply();

        try {
            UpdateChecker.UpdateInfo update = UpdateChecker.checkForUpdate();
            prefs.edit()
                    .putLong("background_next_check", now + 24L * 60L * 60L * 1000L)
                    .putLong("last_update_check", now)
                    .apply();

            NotificationManager manager =
                    (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager == null) return;

            if (update == null) {
                manager.cancel(NOTIFICATION_UPDATE_ID);
                prefs.edit().remove("last_notified_update_version").apply();
                return;
            }

            String lastNotified = prefs.getString("last_notified_update_version", "");
            if (update.version.equals(lastNotified)) return;

            Intent open = new Intent(this, MainActivity.class);
            open.putExtra("check_updates_now", true);
            PendingIntent pending = PendingIntent.getActivity(
                    this,
                    3,
                    open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Notification notification = new Notification.Builder(this, CHANNEL_UPDATE)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("קיים עדכון ל-M7200 Car Alert")
                    .setContentText("גרסה " + update.version + " זמינה. לחץ לפתיחת האפליקציה.")
                    .setContentIntent(pending)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true)
                    .build();
            manager.notify(NOTIFICATION_UPDATE_ID, notification);
            prefs.edit().putString("last_notified_update_version", update.version).apply();
        } catch (Exception ignored) {
            // A failed online check must never interfere with battery monitoring.
        }
    }

    private void stopMonitoring() {
        stopping = true;
        getSharedPreferences("monitor_state", MODE_PRIVATE)
                .edit()
                .putBoolean("monitor_enabled", false)
                .apply();
        if (executor != null) executor.shutdownNow();
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopping = true;
        if (executor != null) executor.shutdownNow();
        loopStarted = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
