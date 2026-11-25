package il.hakolmilemala.m7200caralert;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.RouteInfo;

import java.net.Inet4Address;
import java.net.InetAddress;

public final class RouterNetworkHelper {
    private static final String FALLBACK_GATEWAY = "192.168.0.1";

    private RouterNetworkHelper() {}

    public static Network findWifiNetwork(Context context) {
        try {
            ConnectivityManager manager =
                    (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return null;

            Network active = manager.getActiveNetwork();
            if (active != null) {
                NetworkCapabilities caps = manager.getNetworkCapabilities(active);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return active;
            }

            for (Network network : manager.getAllNetworks()) {
                NetworkCapabilities caps = manager.getNetworkCapabilities(network);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return network;
            }
        } catch (Exception ignored) {
            // A later user action or polling cycle will retry.
        }
        return null;
    }

    public static String findRouterHost(Context context, Network wifiNetwork) {
        if (wifiNetwork == null) return FALLBACK_GATEWAY;
        try {
            ConnectivityManager manager =
                    (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return FALLBACK_GATEWAY;
            LinkProperties links = manager.getLinkProperties(wifiNetwork);
            if (links == null) return FALLBACK_GATEWAY;

            for (RouteInfo route : links.getRoutes()) {
                if (!route.isDefaultRoute()) continue;
                InetAddress gateway = route.getGateway();
                if (gateway instanceof Inet4Address) return gateway.getHostAddress();
            }
        } catch (Exception ignored) {
            // Keep the historical M7200 gateway as a fallback.
        }
        return FALLBACK_GATEWAY;
    }
}
