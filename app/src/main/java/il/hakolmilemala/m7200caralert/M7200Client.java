package il.hakolmilemala.m7200caralert;

import org.json.JSONObject;

import android.net.Network;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.security.KeyFactory;

/** Minimal read-only client for the M7200 status API. */
public final class M7200Client {
    private volatile String routerBaseUrl = "http://192.168.0.1";
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 10000;
    private static final SecureRandom RANDOM = new SecureRandom();

    private Session session;
    private String rejectedPassword;
    private volatile Network wifiNetwork;

    /** Route router requests through the Wi-Fi network connected to the M7200. */
    public void setWifiNetwork(Network network) {
        this.wifiNetwork = network;
    }

    /** Use the connected MiFi gateway instead of assuming a fixed router IP. */
    public void setRouterHost(String host) {
        String value = host == null ? "" : host.trim();
        value = value.replaceFirst("^https?://", "").replaceAll("/+$", "");
        if (value.isEmpty() || value.contains("/") || value.contains(" ")) value = "192.168.0.1";
        routerBaseUrl = "http://" + value;
    }

    public static final class PasswordRejectedException extends Exception {
        PasswordRejectedException(String message, Throwable cause) { super(message, cause); }
        PasswordRejectedException(String message) { super(message); }
    }

    public static final class ProtocolMismatchException extends Exception {
        ProtocolMismatchException(String message) { super(message); }
        ProtocolMismatchException(String message, Throwable cause) { super(message, cause); }
    }

    public static final class BatteryStatus {
        public final int percent;
        public final boolean charging;
        public final boolean batteryConnected;
        public final String model;
        public final String hardwareVersion;
        public final String firmwareVersion;

        BatteryStatus(int percent, boolean charging, boolean batteryConnected,
                      String model, String hardwareVersion, String firmwareVersion) {
            this.percent = percent;
            this.charging = charging;
            this.batteryConnected = batteryConnected;
            this.model = model;
            this.hardwareVersion = hardwareVersion;
            this.firmwareVersion = firmwareVersion;
        }
    }

    private static final class Session {
        String key;
        String iv;
        String hash;
        String rsaMod;
        String rsaExp;
        long seq;
        String token;
    }

    public synchronized BatteryStatus readBattery(String password) throws Exception {
        if (password.equals(rejectedPassword)) {
            throw new PasswordRejectedException("סיסמת הניהול נדחתה. הזן סיסמה חדשה באפליקציה.");
        }
        if (session == null) {
            try {
                login(password);
            } catch (PasswordRejectedException e) {
                rejectedPassword = password;
                throw e;
            }
        }
        try {
            return invokeStatus();
        } catch (java.io.IOException networkError) {
            throw networkError;
        } catch (Exception sessionError) {
            // Session expiration or malformed encrypted response: obtain a fresh challenge once.
            session = null;
            try {
                login(password);
            } catch (PasswordRejectedException e) {
                rejectedPassword = password;
                throw e;
            }
            return invokeStatus();
        }
    }

    private void login(String password) throws Exception {
        JSONObject authCommand = new JSONObject()
                .put("module", "authenticator")
                .put("action", 0);
        JSONObject challengeEnvelope = new JSONObject()
                .put("data", b64(authCommand.toString().getBytes(StandardCharsets.UTF_8)));

        JSONObject challenge = decodePlainResponse(post("auth_cgi", challengeEnvelope));
        String nonce = challenge.optString("nonce", "");
        String rsaMod = challenge.optString("rsaMod", "");
        String rsaExp = challenge.optString("rsaPubKey", "");
        if (nonce.isEmpty() || rsaMod.isEmpty() || rsaExp.isEmpty()) {
            throw new ProtocolMismatchException("הנתב הגיב, אך ממשק ההתחברות שלו שונה מהפרוטוקול שהאפליקציה מכירה.");
        }

        Session candidate = new Session();
        candidate.key = randomDigits(16);
        candidate.iv = randomDigits(16);
        candidate.hash = md5Hex("admin" + password);
        candidate.rsaMod = rsaMod;
        candidate.rsaExp = rsaExp;
        candidate.seq = challenge.optLong("seqNum", 0L);

        String digest = md5Hex(password + ":" + nonce);
        JSONObject loginCommand = new JSONObject()
                .put("module", "authenticator")
                .put("action", 1)
                .put("digest", digest);

        JSONObject loginPayload = encryptedPayload(loginCommand, candidate, true);
        String encryptedResponse = post("auth_cgi", loginPayload);
        JSONObject loginResponse;
        try {
            loginResponse = new JSONObject(aesDecrypt(encryptedResponse, candidate.key, candidate.iv));
        } catch (Exception e) {
            // A failed decrypt can also happen with a wrong admin password.
            // Do not classify the router as unsupported without a successful login.
            throw new PasswordRejectedException("לא ניתן לפענח את תגובת ההתחברות. ייתכן שסיסמת הניהול שגויה או שפרוטוקול ההצפנה שונה.", e);
        }

        if (loginResponse.optInt("result", -1) != 0 || loginResponse.optString("token", "").isEmpty()) {
            throw new PasswordRejectedException("הנתב דחה את סיסמת הניהול. הזן סיסמה נכונה באפליקציה.");
        }
        candidate.token = loginResponse.getString("token");
        session = candidate;
    }

    private BatteryStatus invokeStatus() throws Exception {
        JSONObject command = new JSONObject()
                .put("token", session.token)
                .put("module", "status")
                .put("action", 0);
        JSONObject payload = encryptedPayload(command, session, false);
        String raw = post("web_cgi", payload);
        JSONObject response = new JSONObject(aesDecrypt(raw, session.key, session.iv));

        if (response.optInt("result", -1) != 0) {
            throw new Exception("פג תוקף ההתחברות לנתב");
        }

        JSONObject battery = response.optJSONObject("battery");
        if (battery == null) {
            throw new ProtocolMismatchException("ההתחברות לנתב הצליחה, אך הוא לא החזיר נתוני סוללה במבנה המוכר.");
        }
        int percent = (int) Math.round(battery.optDouble("voltage", -1));
        if (percent < 0 || percent > 100) {
            throw new ProtocolMismatchException("הנתב החזיר נתוני סוללה, אך שדה אחוז הסוללה אינו בפורמט מוכר.");
        }
        boolean charging = jsonBoolean(battery, "charging", false);
        boolean connected = jsonBoolean(battery, "connected", true);
        JSONObject deviceInfo = response.optJSONObject("deviceInfo");
        if (deviceInfo == null) deviceInfo = new JSONObject();
        String model = firstNonEmpty(deviceInfo, "model", "modelName", "deviceModel");
        String hardware = firstNonEmpty(deviceInfo, "hardwareVersion", "hardwareVer", "hwVersion", "hardware_version");
        String firmware = firstNonEmpty(deviceInfo, "firmwareVersion", "firmwareVer", "softwareVersion", "fwVersion");
        return new BatteryStatus(percent, charging, connected, model, hardware, firmware);
    }

    private JSONObject encryptedPayload(JSONObject command, Session active, boolean login) throws Exception {
        String encrypted = aesEncrypt(command.toString(), active.key, active.iv);
        long sequence = active.seq + encrypted.length();
        String signatureText = login
                ? "key=" + active.key + "&iv=" + active.iv + "&h=" + active.hash + "&s=" + sequence
                : "h=" + active.hash + "&s=" + sequence;
        return new JSONObject()
                .put("data", encrypted)
                .put("sign", rsaEncrypt(signatureText, active.rsaMod, active.rsaExp));
    }

    private String post(String endpoint, JSONObject payload) throws Exception {
        HttpURLConnection connection = null;
        try {
            String router = routerBaseUrl;
            URL url = new URL(router + "/cgi-bin/" + endpoint);
            Network selectedNetwork = wifiNetwork;
            connection = (HttpURLConnection) (selectedNetwork != null
                    ? selectedNetwork.openConnection(url)
                    : url.openConnection());
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Referer", router + "/");
            connection.setRequestProperty("Origin", router);
            connection.setRequestProperty("User-Agent", "okhttp/3.11.0");

            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }

            int code = connection.getResponseCode();
            InputStream input = (code >= 200 && code < 300)
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String response = input == null ? "" : readAll(input);
            if (code < 200 || code >= 300) {
                throw new java.io.IOException("הנתב החזיר HTTP " + code + ": " + response);
            }
            return response.trim();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readAll(InputStream input) throws Exception {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String firstNonEmpty(JSONObject object, String... keys) {
        for (String key : keys) {
            String value = object.optString(key, "").trim();
            if (!value.isEmpty() && !"null".equalsIgnoreCase(value)) return value;
        }
        return "";
    }

    private static JSONObject decodePlainResponse(String raw) throws Exception {
        String value = raw == null ? "" : raw.trim();
        try {
            return new JSONObject(value);
        } catch (Exception ignored) {
            byte[] decoded = Base64.getDecoder().decode(value);
            return new JSONObject(new String(decoded, StandardCharsets.UTF_8));
        }
    }

    private static String aesEncrypt(String text, String key, String iv) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(
                Cipher.ENCRYPT_MODE,
                new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES"),
                new IvParameterSpec(iv.getBytes(StandardCharsets.UTF_8))
        );
        return b64(cipher.doFinal(text.getBytes(StandardCharsets.UTF_8)));
    }

    private static String aesDecrypt(String value, String key, String iv) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(
                Cipher.DECRYPT_MODE,
                new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES"),
                new IvParameterSpec(iv.getBytes(StandardCharsets.UTF_8))
        );
        byte[] plain = cipher.doFinal(Base64.getDecoder().decode(value.trim()));
        return new String(plain, StandardCharsets.UTF_8);
    }

    private static String rsaEncrypt(String text, String modulusHex, String exponentHex) throws Exception {
        BigInteger modulus = new BigInteger(cleanHex(modulusHex), 16);
        BigInteger exponent = new BigInteger(cleanHex(exponentHex), 16);
        int keyBytes = (modulus.bitLength() + 7) / 8;
        int maxChunk = keyBytes - 11;
        if (maxChunk < 1) throw new Exception("מפתח RSA של הנתב אינו תקין");

        RSAPublicKey publicKey = (RSAPublicKey) KeyFactory.getInstance("RSA")
                .generatePublic(new RSAPublicKeySpec(modulus, exponent));
        Cipher cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        cipher.init(Cipher.ENCRYPT_MODE, publicKey);

        byte[] source = text.getBytes(StandardCharsets.UTF_8);
        StringBuilder result = new StringBuilder();
        for (int offset = 0; offset < source.length; offset += maxChunk) {
            int end = Math.min(source.length, offset + maxChunk);
            byte[] encrypted = cipher.doFinal(source, offset, end - offset);
            result.append(toFixedHex(encrypted, keyBytes));
        }
        return result.toString();
    }

    private static String cleanHex(String value) {
        String hex = value == null ? "" : value.trim().replaceFirst("(?i)^0x", "");
        hex = hex.replaceFirst("^0+", "");
        return hex.isEmpty() ? "0" : hex;
    }

    private static String toFixedHex(byte[] bytes, int expectedLength) {
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        while (hex.length() < expectedLength * 2) hex.insert(0, '0');
        return hex.toString();
    }

    private static String md5Hex(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("MD5").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        return hex.toString();
    }

    private static String randomDigits(int length) {
        StringBuilder value = new StringBuilder(length);
        for (int i = 0; i < length; i++) value.append(RANDOM.nextInt(10));
        return value.toString();
    }

    private static String b64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    private static boolean jsonBoolean(JSONObject object, String key, boolean fallback) {
        Object value = object.opt(key);
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof Number) return ((Number) value).intValue() != 0;
        if (value instanceof String) {
            String text = ((String) value).trim();
            if ("1".equals(text) || "true".equalsIgnoreCase(text)) return true;
            if ("0".equals(text) || "false".equalsIgnoreCase(text)) return false;
        }
        return fallback;
    }
}
