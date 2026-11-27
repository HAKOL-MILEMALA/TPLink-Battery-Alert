package il.hakolmilemala.m7200caralert;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;

public final class UpdateCheckScheduler {
    public static final String PREFERENCES_NAME = "app_updates";
    public static final String KEY_LAST_SUCCESSFUL_CHECK = "last_update_check";
    public static final long CHECK_INTERVAL_MILLIS = 7L * 24L * 60L * 60L * 1000L;

    private static final int JOB_ID = 7317;

    private UpdateCheckScheduler() {}

    public static synchronized void schedule(Context context) {
        JobScheduler scheduler = (JobScheduler)
                context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null || scheduler.getPendingJob(JOB_ID) != null) return;

        ComponentName service = new ComponentName(context, UpdateCheckJobService.class);
        JobInfo job = new JobInfo.Builder(JOB_ID, service)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .setPeriodic(CHECK_INTERVAL_MILLIS)
                .build();

        scheduler.schedule(job);
    }

    public static void recordSuccessfulCheck(Context context) {
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                .edit()
                .putLong(KEY_LAST_SUCCESSFUL_CHECK, System.currentTimeMillis())
                .apply();
    }
}