package il.hakolmilemala.m7200caralert;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Checks public GitHub Releases and returns a trusted browser download link. */
public final class UpdateChecker {
    private static final String REPOSITORY = "HAKOL-MILEMALA/TPLink-Battery-Alert";
    private static final String RELEASE_API =
            "https://api.github.com/repos/" + REPOSITORY + "/releases/latest";
    private static final String RELEASE_DOWNLOAD_PREFIX =
            "https://github.com/" + REPOSITORY + "/releases/download/";
    private static final Pattern VERSION_PATTERN =
            Pattern.compile("(\\d+(?:\\.\\d+){1,3})");

    private UpdateChecker() {}

    public static final class UpdateInfo {
        public final String version;
        public final String downloadUrl;

        UpdateInfo(String version, String downloadUrl) {
            this.version = version;
            this.downloadUrl = downloadUrl;
        }
    }

    public static UpdateInfo checkForUpdate() throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(RELEASE_API).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(12000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "TP-Link-Battery-Alert-Android");
            connection.setInstanceFollowRedirects(true);

            int code = connection.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new Exception("GitHub החזיר קוד " + code);
            }

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }

            JSONObject release = new JSONObject(body.toString());
            if (release.optBoolean("draft", false) || release.optBoolean("prerelease", false)) {
                throw new Exception("הגרסה האחרונה ב-GitHub אינה Release יציב");
            }

            String version = extractVersion(release.optString("tag_name", ""));
            if (version == null) throw new Exception("לא הצלחתי לזהות מספר גרסה ב-GitHub");

            if (compareVersions(version, BuildConfig.VERSION_NAME) <= 0) return null;

            JSONArray assets = release.optJSONArray("assets");
            if (assets == null) throw new Exception("לא נמצא קובץ APK ב-Release");

            String downloadUrl = null;
            for (int i = 0; i < assets.length(); i++) {
                JSONObject candidate = assets.optJSONObject(i);
                if (candidate == null) continue;
                String name = candidate.optString("name", "").toLowerCase(Locale.ROOT);
                if (name.endsWith(".apk") && !name.endsWith(".apk.sha256")) {
                    downloadUrl = candidate.optString("browser_download_url", "");
                    break;
                }
            }

            if (!isTrustedDownloadUrl(downloadUrl)) {
                throw new Exception("לא נמצא קישור APK תקין מהמאגר הרשמי");
            }

            return new UpdateInfo(version, downloadUrl);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    public static boolean isTrustedDownloadUrl(String url) {
        return url != null && url.startsWith(RELEASE_DOWNLOAD_PREFIX);
    }

    private static String extractVersion(String value) {
        Matcher matcher = VERSION_PATTERN.matcher(value == null ? "" : value);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static int compareVersions(String first, String second) {
        String[] a = first.split("\\.");
        String[] b = second.split("\\.");
        int length = Math.max(a.length, b.length);
        for (int i = 0; i < length; i++) {
            int left = i < a.length ? parsePart(a[i]) : 0;
            int right = i < b.length ? parsePart(b[i]) : 0;
            if (left != right) return Integer.compare(left, right);
        }
        return 0;
    }

    private static int parsePart(String value) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }
}