package il.hakolmilemala.m7200caralert;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import java.util.concurrent.atomic.AtomicBoolean;

public final class UpdateCheckJobService extends JobService {
    private static final String CHANNEL_ID = "app_update_available";
    private static final int NOTIFICATION_ID = 7318;

    private volatile Thread workerThread;
    private volatile AtomicBoolean cancellation;

    @Override
    public boolean onStartJob(JobParameters params) {
        AtomicBoolean cancelled = new AtomicBoolean(false);
        cancellation = cancelled;

        Thread worker = new Thread(() -> {
            boolean retry = false;
            try {
                UpdateChecker.UpdateInfo update = UpdateChecker.checkForUpdate();
                if (!cancelled.get()) {
                    UpdateCheckScheduler.recordSuccessfulCheck(getApplicationContext());
                    if (update != null) showUpdateNotification(update);
                }
            } catch (Exception error) {
                retry = true;
            } finally {
                if (!cancelled.get()) jobFinished(params, retry);
            }
        }, "battery-alert-weekly-update-check");

        workerThread = worker;
        worker.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        AtomicBoolean currentCancellation = cancellation;
        if (currentCancellation != null) currentCancellation.set(true);
        Thread worker = workerThread;
        if (worker != null) worker.interrupt();
        return true;
    }

    private void showUpdateNotification(UpdateChecker.UpdateInfo update) {
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        NotificationManager manager =
                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "עדכוני אפליקציה",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("התראה כאשר מתפרסמת גרסה חדשה של האפליקציה");
        manager.createNotificationChannel(channel);

        Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(update.downloadUrl));
        browser.addCategory(Intent.CATEGORY_BROWSABLE);
        browser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        PendingIntent openDownload = PendingIntent.getActivity(
                this,
                NOTIFICATION_ID,
                browser,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String message = "גרסה " + update.version +
                " זמינה. לחיצה תפתח את הדפדפן להורדה ישירה.";
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle("נמצא עדכון לאפליקציה")
                .setContentText(message)
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setContentIntent(openDownload)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_STATUS)
                .build();

        manager.notify(NOTIFICATION_ID, notification);
    }
}