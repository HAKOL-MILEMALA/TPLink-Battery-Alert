package il.hakolmilemala.m7200caralert;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) &&
                !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }

        boolean enabled = context.getSharedPreferences("monitor_state", Context.MODE_PRIVATE)
                .getBoolean("monitor_enabled", false);
        if (!enabled) return;

        Intent service = new Intent(context, M7200MonitorService.class);
        service.setAction(M7200MonitorService.ACTION_RELOAD);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (RuntimeException error) {
            context.getSharedPreferences("monitor_state", Context.MODE_PRIVATE).edit()
                    .putBoolean("connection_ok", false)
                    .putBoolean("connection_checking", false)
                    .putString("connection_status",
                            "Android לא אפשר להפעיל מחדש את הניטור. פתח את האפליקציה כדי לחדש אותו.")
                    .putLong("connection_checked_time", System.currentTimeMillis())
                    .apply();
        }
    }
}
