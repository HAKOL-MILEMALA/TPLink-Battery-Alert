package il.hakolmilemala.m7200caralert;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Checks public GitHub Releases and downloads a verified APK update. */
public final class UpdateChecker {
    private static final String REPOSITORY = "HAKOL-MILEMALA/M7200CarAlert";
    private static final String RELEASE_API =
            "https://api.github.com/repos/" + REPOSITORY + "/releases/latest";
    private static final String RELEASE_DOWNLOAD_PREFIX =
            "https://github.com/" + REPOSITORY + "/releases/download/";
    private static final Pattern VERSION_PATTERN =
            Pattern.compile("(\\d+(?:\\.\\d+){1,3})");

    private UpdateChecker() {}

    public static final class UpdateInfo {
        public final String version;
        public final String title;
        public final String notes;
        public final String downloadUrl;
        public final String sha256;
        public final String releaseUrl;

        UpdateInfo(String version, String title, String notes,
                   String downloadUrl, String sha256, String releaseUrl) {
            this.version = version;
            this.title = title;
            this.notes = notes;
            this.downloadUrl = downloadUrl;
            this.sha256 = sha256;
            this.releaseUrl = releaseUrl;
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
            connection.setRequestProperty("User-Agent", "M7200-Car-Alert-Android");
            connection.setInstanceFollowRedirects(true);

            int code = connection.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new Exception("GitHub החזיר קוד " + code);
            }

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    body.append(line);
                }
            }

            JSONObject release = new JSONObject(body.toString());
            if (release.optBoolean("draft", false) || release.optBoolean("prerelease", false)) {
                throw new Exception("הגרסה האחרונה ב-GitHub אינה Release יציב");
            }

            String tag = release.optString("tag_name", "");
            String version = extractVersion(tag);
            if (version == null) {
                throw new Exception("לא הצלחתי לזהות מספר גרסה ב-GitHub");
            }

            if (compareVersions(version, il.hakolmilemala.m7200caralert.BuildConfig.VERSION_NAME) <= 0) {
                return null;
            }

            JSONArray assets = release.optJSONArray("assets");
            if (assets == null) throw new Exception("לא נמצא קובץ APK ב-Release");

            JSONObject apk = null;
            for (int i = 0; i < assets.length(); i++) {
                JSONObject candidate = assets.optJSONObject(i);
                if (candidate == null) continue;
                String name = candidate.optString("name", "").toLowerCase(Locale.ROOT);
                if (name.endsWith(".apk") && !name.endsWith(".apk.sha256")) {
                    apk = candidate;
                    break;
                }
            }

            if (apk == null) throw new Exception("לא נמצא קובץ APK ב-Release");
            String downloadUrl = apk.optString("browser_download_url", "");
            if (!downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)) {
                throw new Exception("קישור ההורדה אינו שייך למאגר הרשמי");
            }

            String digest = apk.optString("digest", "");
            if (digest.startsWith("sha256:")) digest = digest.substring("sha256:".length());
            else digest = "";

            String releaseUrl = release.optString(
                    "html_url",
                    "https://github.com/" + REPOSITORY + "/releases"
            );

            return new UpdateInfo(
                    version,
                    release.optString("name", "M7200 Car Alert " + version),
                    release.optString("body", ""),
                    downloadUrl,
                    digest,
                    releaseUrl
            );
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    public static File downloadApk(Context context, UpdateInfo update) throws Exception {
        if (update == null || update.downloadUrl == null ||
                !update.downloadUrl.startsWith(RELEASE_DOWNLOAD_PREFIX)) {
            throw new IllegalArgumentException("קישור עדכון לא תקין");
        }

        HttpURLConnection connection = null;
        File outputFile = null;
        try {
            connection = (HttpURLConnection) new URL(update.downloadUrl).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("User-Agent", "M7200-Car-Alert-Android");
            connection.setInstanceFollowRedirects(true);

            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new Exception("הורדת העדכון נכשלה (HTTP " + code + ")");
            }

            File directory = new File(context.getFilesDir(), "updates");
            if (!directory.exists() && !directory.mkdirs()) {
                throw new Exception("לא הצלחתי ליצור תיקיית עדכונים");
            }

            outputFile = new File(directory, "M7200-Car-Alert-" + update.version + ".apk");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");

            try (InputStream input = new BufferedInputStream(connection.getInputStream());
                 FileOutputStream output = new FileOutputStream(outputFile)) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
                output.flush();
            }

            if (!outputFile.isFile() || outputFile.length() < 1024) {
                throw new Exception("קובץ העדכון שהורד קטן או פגום");
            }

            if (!update.sha256.isEmpty()) {
                String actual = toHex(digest.digest());
                if (!actual.equalsIgnoreCase(update.sha256)) {
                    throw new Exception("בדיקת תקינות SHA-256 נכשלה. העדכון נמחק.");
                }
            } else {
                // Still consume the digest so the stream is processed consistently.
                digest.digest();
            }

            try (InputStream input = new BufferedInputStream(
                    new java.io.FileInputStream(outputFile))) {
                if (input.read() != 'P' || input.read() != 'K') {
                    throw new Exception("הקובץ שהורד אינו APK תקין");
                }
            }

            return outputFile;
        } catch (Exception error) {
            if (outputFile != null && outputFile.exists()) {
                // Never leave a partial or unverified installer behind.
                //noinspection ResultOfMethodCallIgnored
                outputFile.delete();
            }
            throw error;
        } finally {
            if (connection != null) connection.disconnect();
        }
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

    private static String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }
}
