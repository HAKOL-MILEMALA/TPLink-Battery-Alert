package il.hakolmilemala.m7200caralert;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores the router password encrypted with an Android Keystore AES-GCM key. */
public final class SecurePasswordStore {
    private static final String PREFS = "m7200_secure";
    private static final String KEY_ALIAS = "m7200_car_alert_password_key";
    private static final String CIPHER_TEXT = "password_ciphertext";
    private static final String IV_TEXT = "password_iv";

    private SecurePasswordStore() {}

    public static void save(Context context, String password) throws Exception {
        if (password == null || password.isEmpty()) {
            throw new IllegalArgumentException("סיסמה ריקה");
        }
        SecretKey key = getOrCreateKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] encrypted = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8));

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(CIPHER_TEXT, Base64.getEncoder().encodeToString(encrypted))
                .putString(IV_TEXT, Base64.getEncoder().encodeToString(cipher.getIV()))
                .apply();
    }

    public static String read(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String cipherText = prefs.getString(CIPHER_TEXT, null);
        String ivText = prefs.getString(IV_TEXT, null);
        if (cipherText == null || ivText == null) return null;

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                new GCMParameterSpec(128, Base64.getDecoder().decode(ivText))
        );
        byte[] plain = cipher.doFinal(Base64.getDecoder().decode(cipherText));
        return new String(plain, StandardCharsets.UTF_8);
    }

    public static boolean hasPassword(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.contains(CIPHER_TEXT) && prefs.contains(IV_TEXT);
    }

    public static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
        }
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }

        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                "AndroidKeyStore"
        );
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build();
        generator.init(spec);
        return generator.generateKey();
    }
}
