// ==UserScript==
// @name         התראת סוללה ל-TP-Link M7200
// @namespace    HAKOL-MILEMALA
// @version      1.5.4
// @description  ניטור סוללה לנתבי TP-Link MiFi תואמים, עם בדיקת תאימות ודיווח
// @author       HAKOL-MILEMALA
// @homepageURL  https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert
// @supportURL   https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/issues
// @downloadURL  https://raw.githubusercontent.com/HAKOL-MILEMALA/TPLink-Battery-Alert/main/TP-Link-MiFi-Battery-Alert.user.js
// @updateURL    https://raw.githubusercontent.com/HAKOL-MILEMALA/TPLink-Battery-Alert/main/TP-Link-MiFi-Battery-Alert.user.js
// @match        https://*/*
// eslint-disable-next-line userscripts/avoid-regexp-include -- Regex is required to match private LAN IPv4 ranges; @match cannot express IP subnets.
// @include    /^http:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})(?::\d+)?\/.*$/
// @match        http://tplinkmifi.net/*
// @match        http://tplinkwifi.net/*
// @match        http://tplinkmodem.net/*
// @connect      192.168.0.1
// @connect      192.168.1.1
// @connect      192.168.8.1
// @connect      10.0.0.1
// @connect      tplinkmifi.net
// @connect      tplinkwifi.net
// @connect      tplinkmodem.net
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
    'use strict';

    // ======================== הגדרות ========================
    const SCRIPT_VERSION = '1.5.4';
    const ROUTER_STORAGE_KEY = 'tplink_mifi_router_base';

    function isPrivateIPv4(host) {
        const parts = String(host || '').split('.').map(Number);
        if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
        return parts[0] === 10 ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            (parts[0] === 169 && parts[1] === 254);
    }

    function isAllowedRouterHost(host) {
        const value = String(host || '').toLowerCase();
        return isPrivateIPv4(value) ||
            value === 'tplinkmifi.net' ||
            value === 'tplinkwifi.net' ||
            value === 'tplinkmodem.net';
    }

    function isRouterManagementPage() {
        if (location.protocol !== 'http:') return false;
        const saved = String(GM_getValue(ROUTER_STORAGE_KEY, '') || '').replace(/\/+$/, '');
        if (saved && location.origin === saved) return true;
        if (!isAllowedRouterHost(location.hostname)) return false;

        const pageText = [
            document.title || '',
            document.body ? String(document.body.innerText || '').slice(0, 1800) : ''
        ].join(' ');

        return /TP[\s-]?Link|MiFi|Mobile\s*Wi-?Fi|tplink/i.test(pageText) ||
            /\/(?:login|index)\.html$/i.test(location.pathname);
    }

    const IS_ROUTER_PAGE = isRouterManagementPage();
    if (IS_ROUTER_PAGE) {
        const previousHost = String(GM_getValue(ROUTER_STORAGE_KEY, '') || '').replace(/\/+$/, '');
        if (previousHost !== location.origin) {
            if (previousHost) GM_deleteValue('m7200_password');
            GM_setValue('m7200_history', []);
            GM_setValue('m7200_alarm_state', {stage: 0, wasCharging: false});
            GM_setValue('m7200_snooze', null);
            GM_setValue('m7200_last_alert', null);
            GM_setValue('m7200_dismissed_alert', '');
            GM_setValue('m7200_last_status', null);
            GM_setValue('tplink_mifi_router_fingerprint', '');
            GM_setValue('tplink_mifi_compatibility_state', null);
            GM_setValue('m7200_panel_dismissed_origin', '');
        }
        GM_setValue(ROUTER_STORAGE_KEY, location.origin);
    }

    function getRouterBase() {
        const stored = String(GM_getValue(ROUTER_STORAGE_KEY, '') || '').trim();
        try {
            const url = new URL(stored || 'http://192.168.0.1');
            if (url.protocol !== 'http:' || !isAllowedRouterHost(url.hostname)) return 'http://192.168.0.1';
            return url.origin;
        } catch (_) {
            return 'http://192.168.0.1';
        }
    }

    const WARNING_LEVEL = 15;
    const URGENT_LEVEL = 10;
    const RESET_LEVEL = 20;
    const SHUTDOWN_LEVEL = 5;

    const NORMAL_INTERVAL = 3 * 60 * 1000;
    const LOW_INTERVAL = 60 * 1000;
    const NETWORK_RETRY_BASE = 30 * 1000;
    const PASSWORD_WAIT_INTERVAL = 30 * 1000;

    const AUTO_SNOOZE_AFTER = 30 * 1000;
    const SNOOZE_TIME = 3 * 60 * 1000;
    const SNOOZE_DROP = 2;
    const FOCUS_RECENT = 15 * 1000;

    const HISTORY_WINDOW = 30 * 60 * 1000;
    const MIN_ETA_DROPS = 3;
    const MIN_ETA_SPAN = 10 * 60 * 1000;

    const LOCK_TTL = 45 * 1000;
    const HEARTBEAT_INTERVAL = 12 * 1000;
    const RESUME_GAP = 90 * 1000;
    const LOCK_ELECTION_JITTER = 900;

    const AUTH_FAILURES_BEFORE_ASK = 2;
    const PASSWORD_REQUEST_COOLDOWN = 15 * 60 * 1000;
    const ROUTER_TAB_ABSENT_AFTER = 25 * 1000;
    const ROUTER_PRESENCE_TTL = 20 * 1000;
    const ROUTER_PRESENCE_INTERVAL = 5 * 1000;

    const K = {
        password: 'm7200_password',
        routerBase: ROUTER_STORAGE_KEY,
        routerFingerprint: 'tplink_mifi_router_fingerprint',
        compatibilityTicket: 'tplink_mifi_compatibility_ticket',
        compatibilityHandledTicket: 'tplink_mifi_compatibility_handled_ticket',
        compatibilityState: 'tplink_mifi_compatibility_state',
        passwordTicket: 'm7200_password_ticket',
        passwordRequest: 'm7200_password_request',
        lastPasswordRequest: 'm7200_last_password_request',
        routerPresence: 'm7200_router_presence',
        panelDismissed: 'm7200_panel_dismissed_origin',
        lock: 'm7200_monitor_lock',
        alarm: 'm7200_alarm_state',
        snooze: 'm7200_snooze',
        alert: 'm7200_last_alert',
        dismissed: 'm7200_dismissed_alert',
        history: 'm7200_history',
        focusAt: 'm7200_focus_at',
        lastError: 'm7200_last_error',
        lastStatus: 'm7200_last_status'
    };

    const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    class NetworkError extends Error {}
    class AuthError extends Error {}
    class PasswordError extends Error {}
    class ProtocolMismatchError extends Error {}

    let isLeader = false;
    let pollInProgress = false;
    let heartbeatInProgress = false;
    let lockToken = null;
    let pollTimer = null;
    let autoSnoozeTimer = null;
    let session = null;
    let lastBeat = Date.now();
    let netFailures = 0;
    let authFailures = 0;
    let rejectedPassword = null;
    let freshPassword = false;
    let compatibilityCheckInProgress = false;
    let handledCompatibilityTicket = Number(GM_getValue(
        K.compatibilityHandledTicket,
        GM_getValue(K.compatibilityTicket, 0)
    ));
    let handledTicket = Number(GM_getValue(K.passwordTicket, 0));

    let toastHost = null;
    let toastShadow = null;
    let toastAlertId = null;

    let pwHost = null;
    let pwShadow = null;
    let pwChecking = false;
    let pwTimeout = null;

    // ======================== בניית רכיבי DOM בטוחה ========================
    // אין שימוש ב-innerHTML: כך לא מתנגשים עם Trusted Types של Chrome.
    function makeElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null) {
            element.textContent = String(text);
        }
        return element;
    }

    // ======================== כלי עזר ========================
    function bytesToBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }

    function base64ToBytes(value) {
        const binary = atob(String(value).trim());
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function tryJson(text) {
        try {
            return JSON.parse(text);
        } catch (_) {
            return null;
        }
    }

    function decodePlainResponse(raw) {
        const text = String(raw || '').trim();
        const direct = tryJson(text);
        if (direct) return direct;

        try {
            const decoded = tryJson(decoder.decode(base64ToBytes(text)));
            if (decoded) return decoded;
        } catch (_) {}

        throw new ProtocolMismatchError('הנתב הגיב, אך תשובת ההתחברות אינה במבנה המוכר.');
    }

    function randomDigits(length) {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, value => String(value % 10)).join('');
    }

    function notify(title, text, options = {}) {
        try {
            GM_notification({
                title,
                text,
                timeout: 12000,
                silent: true,
                ...options
            });
        } catch (_) {}
    }

    // ======================== MD5 ========================
    function md5Hex(input) {
        const source = encoder.encode(input);
        const bitLength = source.length * 8;
        const totalLength = Math.ceil((source.length + 9) / 64) * 64;
        const data = new Uint8Array(totalLength);

        data.set(source);
        data[source.length] = 0x80;

        const view = new DataView(data.buffer);
        view.setUint32(totalLength - 8, bitLength >>> 0, true);
        view.setUint32(
            totalLength - 4,
            Math.floor(bitLength / 0x100000000),
            true
        );

        const shifts = [
            7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
            5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
            4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
            6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
        ];

        const constants = Array.from({length: 64}, (_, i) =>
            Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
        );

        let a0 = 0x67452301;
        let b0 = 0xefcdab89;
        let c0 = 0x98badcfe;
        let d0 = 0x10325476;

        for (let offset = 0; offset < totalLength; offset += 64) {
            const words = new Uint32Array(16);

            for (let i = 0; i < 16; i++) {
                words[i] = view.getUint32(offset + i * 4, true);
            }

            let a = a0, b = b0, c = c0, d = d0;

            for (let i = 0; i < 64; i++) {
                let f, g;

                if (i < 16) {
                    f = (b & c) | (~b & d);
                    g = i;
                } else if (i < 32) {
                    f = (d & b) | (~d & c);
                    g = (5 * i + 1) % 16;
                } else if (i < 48) {
                    f = b ^ c ^ d;
                    g = (3 * i + 5) % 16;
                } else {
                    f = c ^ (b | ~d);
                    g = (7 * i) % 16;
                }

                const sum = (a + f + constants[i] + words[g]) >>> 0;
                const shift = shifts[i];
                const rotated = (
                    (sum << shift) | (sum >>> (32 - shift))
                ) >>> 0;

                const nextB = (b + rotated) >>> 0;

                a = d;
                d = c;
                c = b;
                b = nextB;
            }

            a0 = (a0 + a) >>> 0;
            b0 = (b0 + b) >>> 0;
            c0 = (c0 + c) >>> 0;
            d0 = (d0 + d) >>> 0;
        }

        const result = new Uint8Array(16);
        const resultView = new DataView(result.buffer);

        [a0, b0, c0, d0].forEach((value, i) => {
            resultView.setUint32(i * 4, value, true);
        });

        return Array.from(
            result,
            value => value.toString(16).padStart(2, '0')
        ).join('');
    }

    // ======================== RSA ========================
    function bytesToBigInt(bytes) {
        let hex = '';
        for (const byte of bytes) {
            hex += byte.toString(16).padStart(2, '0');
        }
        return BigInt('0x' + (hex || '0'));
    }

    function modPow(base, exponent, modulus) {
        let result = 1n;
        base %= modulus;

        while (exponent > 0n) {
            if (exponent & 1n) {
                result = (result * base) % modulus;
            }
            exponent >>= 1n;
            base = (base * base) % modulus;
        }

        return result;
    }

    function rsaEncrypt(text, modulusHex, exponentHex) {
        const cleanModulus = String(modulusHex)
            .replace(/^0x/i, '')
            .replace(/^0+/, '');

        const cleanExponent = String(exponentHex).replace(/^0x/i, '');
        const modulus = BigInt('0x' + cleanModulus);
        const exponent = BigInt('0x' + cleanExponent);
        const keyBytes = Math.ceil(cleanModulus.length / 2);
        const maxChunk = keyBytes - 11;

        if (maxChunk < 1) {
            throw new Error('מפתח RSA של הנתב אינו תקין');
        }

        const source = encoder.encode(text);
        let output = '';

        for (let offset = 0; offset < source.length; offset += maxChunk) {
            const chunk = source.subarray(
                offset,
                Math.min(offset + maxChunk, source.length)
            );

            const paddingLength = keyBytes - chunk.length - 3;
            const block = new Uint8Array(keyBytes);

            block[0] = 0;
            block[1] = 2;

            let filled = 0;

            while (filled < paddingLength) {
                const random = new Uint8Array(
                    Math.max(16, paddingLength - filled)
                );

                crypto.getRandomValues(random);

                for (const value of random) {
                    if (value !== 0 && filled < paddingLength) {
                        block[2 + filled++] = value;
                    }
                }
            }

            block[2 + paddingLength] = 0;
            block.set(chunk, 3 + paddingLength);

            const encrypted = modPow(
                bytesToBigInt(block),
                exponent,
                modulus
            );

            output += encrypted.toString(16).padStart(keyBytes * 2, '0');
        }

        return output;
    }

    // ======================== AES ========================
    async function aesEncrypt(text, keyText, ivText) {
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(keyText),
            {name: 'AES-CBC'},
            false,
            ['encrypt']
        );

        const encrypted = await crypto.subtle.encrypt(
            {name: 'AES-CBC', iv: encoder.encode(ivText)},
            key,
            encoder.encode(text)
        );

        return bytesToBase64(new Uint8Array(encrypted));
    }

    async function aesDecrypt(text, keyText, ivText) {
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(keyText),
            {name: 'AES-CBC'},
            false,
            ['decrypt']
        );

        const decrypted = await crypto.subtle.decrypt(
            {name: 'AES-CBC', iv: encoder.encode(ivText)},
            key,
            base64ToBytes(text)
        );

        return decoder.decode(decrypted);
    }

    // ======================== תקשורת עם הנתב ========================
    function postRouter(endpoint, payload) {
        return new Promise((resolve, reject) => {
            const router = getRouterBase();
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${router}/cgi-bin/${endpoint}`,
                headers: {
                    'Content-Type': 'application/json',
                    'Referer': `${router}/`,
                    'Origin': router,
                    'User-Agent': 'okhttp/3.11.0'
                },
                data: JSON.stringify(payload),
                timeout: 12000,

                onload: response => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        reject(new NetworkError(`הנתב החזיר HTTP ${response.status}`));
                    }
                },

                onerror: () => reject(
                    new NetworkError('אין תקשורת עם הנתב. בדוק חיבור ל-Wi-Fi שלו.')
                ),

                ontimeout: () => reject(
                    new NetworkError('הנתב לא השיב בתוך 12 שניות')
                )
            });
        });
    }

    async function encryptedPayload(payload, activeSession, isLogin = false) {
        const data = await aesEncrypt(
            JSON.stringify(payload),
            activeSession.key,
            activeSession.iv
        );

        const sequence = Number(activeSession.seq) + data.length;

        const signatureText = isLogin
            ? `key=${activeSession.key}&iv=${activeSession.iv}&h=${activeSession.hash}&s=${sequence}`
            : `h=${activeSession.hash}&s=${sequence}`;

        return {
            data,
            sign: rsaEncrypt(
                signatureText,
                activeSession.rsaMod,
                activeSession.rsaExp
            )
        };
    }

    // ======================== התחברות ========================
    async function loginRouter(password) {
        const challengeRaw = await postRouter('auth_cgi', {
            data: bytesToBase64(encoder.encode(JSON.stringify({
                module: 'authenticator',
                action: 0
            })))
        });

        const challenge = decodePlainResponse(challengeRaw);

        if (!challenge.nonce || !challenge.rsaMod || !challenge.rsaPubKey) {
            throw new ProtocolMismatchError('הנתב הגיב, אך ממשק ההתחברות שלו שונה מהפרוטוקול המוכר.');
        }

        const activeSession = {
            key: randomDigits(16),
            iv: randomDigits(16),
            hash: md5Hex('admin' + password),
            rsaMod: String(challenge.rsaMod),
            rsaExp: String(challenge.rsaPubKey),
            seq: Number(challenge.seqNum || 0),
            password
        };

        const digest = md5Hex(password + ':' + challenge.nonce);

        const payload = await encryptedPayload({
            module: 'authenticator',
            action: 1,
            digest
        }, activeSession, true);

        const raw = await postRouter('auth_cgi', payload);

        let response;

        try {
            response = JSON.parse(
                await aesDecrypt(raw, activeSession.key, activeSession.iv)
            );
        } catch (_) {
            throw new AuthError('ההתחברות נכשלה. בדוק את סיסמת הנתב.');
        }

        if (Number(response.result) !== 0 || !response.token) {
            throw new AuthError('הנתב דחה את ההתחברות. בדוק את סיסמת הניהול.');
        }

        activeSession.token = String(response.token);
        session = activeSession;

        if (GM_getValue(K.passwordRequest, null)) {
            GM_setValue(K.passwordRequest, null);
        }
    }

    async function ensureLogin() {
        if (session) return;

        const ticket = Number(GM_getValue(K.passwordTicket, 0));

        if (ticket !== handledTicket) {
            handledTicket = ticket;
            rejectedPassword = null;
            freshPassword = true;
            authFailures = AUTH_FAILURES_BEFORE_ASK - 1;
        }

        const password = GM_getValue(K.password, '');

        if (!password) {
            requestPassword('missing');
            throw new PasswordError('לא הוגדרה סיסמת ניהול');
        }

        if (password === rejectedPassword) {
            requestPassword('rejected');
            throw new PasswordError('הסיסמה השמורה נדחתה');
        }

        try {
            await loginRouter(password);
            authFailures = 0;
            freshPassword = false;
        } catch (error) {
            if (!(error instanceof AuthError)) throw error;

            authFailures++;

            if (authFailures < AUTH_FAILURES_BEFORE_ASK) {
                throw error;
            }

            authFailures = 0;
            rejectedPassword = password;

            const quiet = freshPassword;
            freshPassword = false;

            requestPassword('rejected', {quiet});
            throw new PasswordError('הסיסמה נדחתה על ידי הנתב');
        }
    }

    async function invokeStatus() {
        const payload = await encryptedPayload({
            token: session.token,
            module: 'status',
            action: 0
        }, session);

        const raw = await postRouter('web_cgi', payload);

        const result = JSON.parse(
            await aesDecrypt(raw, session.key, session.iv)
        );

        if (Number(result.result) !== 0) {
            throw new Error('פג תוקף ההתחברות לנתב');
        }

        return result;
    }

    async function getStatus() {
        await ensureLogin();

        try {
            return await invokeStatus();
        } catch (error) {
            if (error instanceof NetworkError) throw error;

            session = null;
            await ensureLogin();

            return await invokeStatus();
        }
    }


    function firstNonEmpty(object, keys) {
        for (const key of keys) {
            const value = object && object[key] != null ? String(object[key]).trim() : '';
            if (value && value.toLowerCase() !== 'null') return value;
        }
        return '';
    }

    function routerIdentity(status) {
        const deviceInfo = status && status.deviceInfo && typeof status.deviceInfo === 'object'
            ? status.deviceInfo
            : {};
        return {
            model: firstNonEmpty(deviceInfo, ['model', 'modelName', 'deviceModel']) || 'לא דווח',
            hardwareVersion: firstNonEmpty(deviceInfo, ['hardwareVersion', 'hardwareVer', 'hwVersion', 'hardware_version']) || 'לא דווחה',
            firmwareVersion: firstNonEmpty(deviceInfo, ['firmwareVersion', 'firmwareVer', 'softwareVersion', 'fwVersion']) || 'לא דווחה'
        };
    }


    function resetRouterBatteryCycle() {
        GM_setValue(K.history, []);
        GM_setValue(K.alarm, {stage: 0, wasCharging: false});
        GM_setValue(K.snooze, null);
        GM_setValue(K.alert, null);
        GM_setValue(K.dismissed, '');
        closeToast();
    }

    function trackRouterFingerprint(identity) {
        const values = [identity.model, identity.hardwareVersion, identity.firmwareVersion]
            .map(value => String(value || '').trim())
            .filter(value => value && value !== 'לא דווח' && value !== 'לא דווחה');

        if (values.length === 0) return;

        const fingerprint = [
            identity.model || '',
            identity.hardwareVersion || '',
            identity.firmwareVersion || ''
        ].join('|');

        const previous = String(GM_getValue(K.routerFingerprint, '') || '');

        if (previous && previous !== fingerprint) {
            resetRouterBatteryCycle();
        }

        GM_setValue(K.routerFingerprint, fingerprint);
    }

    function safeReportValue(value, fallback = 'לא דווח') {
        let clean = String(value == null ? '' : value)
            .replace(/[\r\n\t]/g, ' ')
            .replace(/[<>]/g, '')
            .trim();
        if (!clean) clean = fallback;
        return clean.slice(0, 160);
    }

    function saveCompatibilityResult(result, status = null, details = '', batteryPercent = null, charging = null) {
        const identity = routerIdentity(status);
        GM_setValue(K.compatibilityState, {
            result,
            model: safeReportValue(identity.model),
            hardwareVersion: safeReportValue(identity.hardwareVersion),
            firmwareVersion: safeReportValue(identity.firmwareVersion),
            details: safeReportValue(details, ''),
            batteryPercent: Number.isFinite(Number(batteryPercent)) ? Number(batteryPercent) : null,
            charging: charging === true,
            time: Date.now(),
            scriptVersion: SCRIPT_VERSION
        });
    }

    async function runCompatibilityCheck() {
        if (!isLeader || compatibilityCheckInProgress) return;
        compatibilityCheckInProgress = true;

        while (pollInProgress) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        let status = null;
        try {
            session = null;
            status = await getStatus();
            const battery = status && status.battery ? status.battery : null;
            const level = battery ? Number(battery.voltage) : NaN;

            if (!battery || !Number.isFinite(level) || level < 0 || level > 100) {
                throw new ProtocolMismatchError(
                    'הנתב הגיב, אך לא החזיר שדה battery.voltage תקין בטווח 0–100.'
                );
            }

            const chargingValue = battery.charging;
            const charging = chargingValue === true ||
                chargingValue === 1 ||
                chargingValue === '1' ||
                String(chargingValue).toLowerCase() === 'true';

            saveCompatibilityResult(
                'LIVE_SUCCESS',
                status,
                'התחברות לנתב וקריאת אחוז הסוללה הצליחו.',
                Math.round(level),
                charging
            );

            GM_setValue(K.lastStatus, {
                level: Math.round(level),
                charging,
                connected: battery.connected !== false && battery.connected !== 0 && battery.connected !== '0',
                time: Date.now()
            });
        } catch (error) {
            let result = 'UNKNOWN';
            if (error instanceof ProtocolMismatchError) result = 'PROTOCOL_MISMATCH';
            else if (error instanceof PasswordError || error instanceof AuthError) result = 'AUTH_FAILED';
            else if (error instanceof NetworkError) result = 'NETWORK_ERROR';

            saveCompatibilityResult(
                result,
                status,
                error && error.message ? error.message : String(error)
            );
        } finally {
            compatibilityCheckInProgress = false;
            if (isRouterManagementPageOpen()) {
                loseLeadership();
            }
        }
    }

    function isRouterManagementPageOpen() {
        const lastSeen = Number(GM_getValue(K.routerPresence, 0));
        return lastSeen > 0 && Date.now() - lastSeen < ROUTER_PRESENCE_TTL;
    }

    function hasPendingCompatibilityCheck() {
        const ticket = Number(GM_getValue(K.compatibilityTicket, 0));
        const handled = Number(GM_getValue(
            K.compatibilityHandledTicket,
            handledCompatibilityTicket
        ));
        handledCompatibilityTicket = handled;
        return Boolean(ticket && ticket !== handled);
    }

    function handlePendingCompatibilityCheck() {
        if (!isLeader || compatibilityCheckInProgress) return false;

        const ticket = Number(GM_getValue(K.compatibilityTicket, 0));
        const handled = Number(GM_getValue(
            K.compatibilityHandledTicket,
            handledCompatibilityTicket
        ));

        if (!ticket || ticket === handled) {
            handledCompatibilityTicket = handled;
            return false;
        }

        // Persist the ticket globally so other tabs will not repeat this
        // one-time user-requested check after the leadership lock expires.
        handledCompatibilityTicket = ticket;
        GM_setValue(K.compatibilityHandledTicket, ticket);
        runCompatibilityCheck();
        return true;
    }

    // ======================== הזנת סיסמה בדף הנתב ========================
    function openRouterTab() {
        try {
            GM_openInTab(`${getRouterBase()}/`, {
                active: true,
                insert: true,
                setParent: true
            });
        } catch (_) {}
    }

    function requestPassword(reason, {quiet = false} = {}) {
        const now = Date.now();
        const existing = GM_getValue(K.passwordRequest, null);
        const request = {reason, time: now};

        if (quiet || !existing || existing.reason !== reason) {
            GM_setValue(K.passwordRequest, request);
        }

        if (IS_ROUTER_PAGE) {
            showPasswordPanel(request);
            return;
        }

        if (quiet) return;

        const manualRequest = reason === 'manual';
        const last = Number(GM_getValue(K.lastPasswordRequest, 0));

        if (!manualRequest && now - last < PASSWORD_REQUEST_COOLDOWN) return;

        GM_setValue(K.lastPasswordRequest, now);

        if (!manualRequest) {
            notify(
                'M7200 – נדרשת סיסמת ניהול',
                'פתח את דף הנתב כדי להזין אותה.',
                {
                    timeout: 20000,
                    onclick: openRouterTab
                }
            );
        }

        const presence = Number(GM_getValue(K.routerPresence, 0));

        if (now - presence > ROUTER_TAB_ABSENT_AFTER) {
            openRouterTab();
        }
    }

    function removePasswordPanel() {
        clearTimeout(pwTimeout);
        pwChecking = false;

        if (IS_ROUTER_PAGE) {
            GM_setValue(K.panelDismissed, location.origin);
            GM_setValue(K.passwordRequest, null);
        }

        if (pwHost) pwHost.remove();

        pwHost = null;
        pwShadow = null;
    }

    function submitPassword() {
        if (!pwShadow) return;
        const input = pwShadow.getElementById('pw');
        const value = input ? input.value.trim() : '';

        if (value) {
            GM_setValue(K.password, value);
            rejectedPassword = null;
        }

        if (!GM_getValue(K.password, '')) {
            renderPasswordPanel('ask', {reason: 'missing'});
            const field = pwShadow.getElementById('pw');
            if (field) field.focus();
            return;
        }

        const ticket = Date.now();
        pwChecking = false;
        if (value) GM_setValue(K.passwordTicket, ticket);
        GM_setValue(K.passwordRequest, null);
        GM_setValue(K.compatibilityTicket, ticket);
        renderPasswordPanel('queued');
    }


    function openCompatibilityReport() {
        const profile = GM_getValue(K.compatibilityState, null);
        if (!profile || !['LIVE_SUCCESS', 'PROTOCOL_MISMATCH'].includes(profile.result)) return;

        const model = safeReportValue(profile.model);
        const title = 'בדיקת תאימות TP-Link MiFi: ' + model;
        const outcome = profile.result === 'LIVE_SUCCESS'
            ? 'LIVE_SUCCESS – התחברות וקריאת אחוז סוללה הצליחו'
            : 'PROTOCOL_MISMATCH – הנתב הגיב אך הפרוטוקול או נתוני הסוללה אינם תואמים';

        const lines = [
            '### דוח בדיקת תאימות TP-Link MiFi',
            '',
            '- תוצאה: ' + outcome,
            '- דגם: ' + safeReportValue(profile.model),
            '- גרסת חומרה: ' + safeReportValue(profile.hardwareVersion),
            '- גרסת קושחה: ' + safeReportValue(profile.firmwareVersion),
            '- גרסת הסקריפט: ' + SCRIPT_VERSION,
            '- אחוז סוללה בבדיקה: ' + (profile.batteryPercent == null ? 'לא התקבל' : profile.batteryPercent + '%'),
            '- פרטים: ' + safeReportValue(profile.details, 'ללא פירוט'),
            '',
            'הדוח נוצר מתוך בדיקת קריאה בלבד.',
            'לא נכללו בו סיסמת ניהול, כתובת IP מקומית, שם רשת Wi-Fi, כתובת MAC או IMEI.'
        ];

        const issue = new URL('https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/issues/new');
        issue.searchParams.set('title', title);
        issue.searchParams.set('body', lines.join('\n'));

        try {
            GM_openInTab(issue.toString(), {active: true, insert: true});
        } catch (_) {
            notify('TP-Link MiFi', 'לא הצלחתי לפתוח טיוטת דיווח ב-GitHub.');
        }
    }

    function renderPasswordPanel(status, request = null, failedNow = false) {
        if (!pwShadow) return;

        const profile = GM_getValue(K.compatibilityState, null);
        const hasPassword = Boolean(GM_getValue(K.password, ''));
        const reason = request && request.reason;

        let message = 'בדיקת תאימות לנתב TP-Link MiFi';
        let accent = '#1967d2';

        if (status === 'testing') {
            message = 'בודק התחברות וקריאת סוללה מול הנתב...';
        } else if (failedNow || reason === 'rejected') {
            message = 'הנתב דחה את הסיסמה. הזן את סיסמת הניהול הנכונה ונסה שוב.';
            accent = '#c5221f';
        } else if (!hasPassword || reason === 'missing' || status === 'ask') {
            message = 'הזן את סיסמת הניהול של הנתב כדי לבדוק תאימות ולהפעיל ניטור.';
        }

        if (profile && profile.result === 'LIVE_SUCCESS') {
            const batteryText = profile.batteryPercent == null ? '' : ' • סוללה ' + profile.batteryPercent + '%';
            message = '✅ תואם בבדיקה חיה: ' + profile.model + batteryText;
            accent = '#188038';
        } else if (profile && profile.result === 'PROTOCOL_MISMATCH') {
            message = '⚠️ הנתב הגיב, אך הפרוטוקול או נתוני הסוללה אינם תואמים כרגע. ' + (profile.details || '');
            accent = '#c5221f';
        } else if (profile && profile.result === 'NETWORK_ERROR') {
            message = 'לא הצלחתי לתקשר עם הנתב. בדוק חיבור Wi-Fi ונסה שוב.';
            accent = '#c5221f';
        } else if (profile && profile.result === 'AUTH_FAILED') {
            message = 'ההתחברות לא הצליחה. בדוק את סיסמת הניהול ונסה שוב.';
            accent = '#c5221f';
        } else if (profile && profile.result === 'UNKNOWN' && status !== 'testing') {
            message = 'לא ניתן לקבוע תאימות כרגע. ' + (profile.details || '');
            accent = '#b06000';
        }

        if (status === 'queued') {
            message = 'הבקשה נשמרה. בדיקת התאימות תתבצע אוטומטית לאחר סגירת ממשק הנתב, כדי לא ליצור התחברות מקבילה.';
            accent = '#1967d2';
        }

        const showPasswordField = !hasPassword || status === 'ask' || reason === 'rejected' || failedNow;
        const canReport = profile &&
            (profile.result === 'LIVE_SUCCESS' || profile.result === 'PROTOCOL_MISMATCH');

        const style = makeElement('style');
        style.textContent =
            '*{box-sizing:border-box}' +
            '.panel{direction:rtl;width:min(390px,calc(100vw - 36px));font:14px Arial,sans-serif;background:#fff;color:#202124;border:1px solid #dadce0;border-top:5px solid ' + accent + ';border-radius:12px;box-shadow:0 8px 28px #0003;padding:16px}' +
            '.head{font-size:16px;font-weight:700;margin-bottom:8px}' +
            '.msg{line-height:1.5;color:#333;margin-bottom:12px;overflow-wrap:anywhere}' +
            '.hint{font-size:12px;line-height:1.45;color:#5f6368;margin:10px 0 0}' +
            'input{width:100%;font:15px Arial,sans-serif;padding:9px 10px;border:1px solid #bdc1c6;border-radius:7px;margin-bottom:10px;direction:ltr}' +
            '.buttons{display:flex;gap:7px;flex-wrap:wrap}' +
            'button{font:600 13px Arial;border:0;border-radius:7px;padding:9px 12px;cursor:pointer}' +
            'button:disabled{opacity:.55;cursor:default}' +
            '#check,#save{background:#1967d2;color:#fff}' +
            '#report{background:#188038;color:#fff}' +
            '#close{background:#e8eaed;color:#202124}' +
            '.meta{font-size:12px;line-height:1.45;color:#5f6368;margin-top:8px}';

        const panel = makeElement('div', 'panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-live', 'polite');
        panel.appendChild(makeElement('div', 'head', '🔋 TP-Link MiFi – בדיקת סוללה'));
        panel.appendChild(makeElement('div', 'msg', message));

        if (profile && (profile.result === 'LIVE_SUCCESS' || profile.result === 'PROTOCOL_MISMATCH')) {
            const identity = 'דגם: ' + (profile.model || 'לא דווח') +
                ' | חומרה: ' + (profile.hardwareVersion || 'לא דווחה') +
                ' | קושחה: ' + (profile.firmwareVersion || 'לא דווחה');
            panel.appendChild(makeElement('div', 'meta', identity));
        }

        if (showPasswordField) {
            const input = makeElement('input');
            input.id = 'pw';
            input.type = 'password';
            input.autocomplete = 'current-password';
            input.placeholder = 'סיסמת ניהול של הנתב';
            panel.appendChild(input);
        }

        const buttons = makeElement('div', 'buttons');

        if (showPasswordField) {
            const save = makeElement('button', '', 'שמור ובדוק');
            save.id = 'save';
            save.disabled = status === 'testing';
            save.addEventListener('click', submitPassword);
            buttons.appendChild(save);
        }

        const check = makeElement(
            'button',
            '',
            status === 'testing' ? 'בודק...' :
                status === 'queued' ? 'הבדיקה ממתינה לסגירת הנתב' : 'בדוק תאימות'
        );
        check.id = 'check';
        check.disabled = status === 'testing' || status === 'queued';
        check.addEventListener('click', () => {
            const field = pwShadow.getElementById('pw');
            if (field) {
                if (field.value.trim()) submitPassword();
                else field.focus();
                return;
            }
            if (!GM_getValue(K.password, '')) {
                renderPasswordPanel('ask', {reason: 'missing'});
                const passwordField = pwShadow.getElementById('pw');
                if (passwordField) passwordField.focus();
                return;
            }
            const ticket = Date.now();
            pwChecking = false;
            GM_setValue(K.compatibilityTicket, ticket);
            renderPasswordPanel('queued');
        });
        buttons.appendChild(check);

        if (canReport) {
            const report = makeElement('button', '', 'דווח ל-GitHub');
            report.id = 'report';
            report.addEventListener('click', openCompatibilityReport);
            buttons.appendChild(report);
        }

        const close = makeElement('button', '', 'סגור');
        close.id = 'close';
        close.addEventListener('click', removePasswordPanel);
        buttons.appendChild(close);

        panel.appendChild(buttons);
        panel.appendChild(makeElement('div', 'hint',
            'הדיווח ייפתח כטיוטה ב-GitHub ולא יישלח בלי אישורך. הדוח אינו כולל סיסמה, כתובת IP, שם רשת Wi-Fi או מזהי מכשיר.'));
        panel.appendChild(makeElement('div', 'hint',
            'הסיסמה נשמרת באחסון Tampermonkey. הסקריפט אינו מצפין אותה בעצמו ואינו שולח אותה לשירות חיצוני.'));
        panel.appendChild(makeElement('div', 'hint',
            'הניטור האוטומטי מושהה כל עוד ממשק הנתב פתוח. גם בדיקת תאימות שתבקש עכשיו תמתין לסגירת ממשק הנתב, ואז תתבצע פעם אחת בלבד.'));

        pwShadow.replaceChildren(style, panel);
        const field = pwShadow.getElementById('pw');
        if (field && showPasswordField) field.focus();
    }

    function showPasswordPanel(request, failedNow = false) {
        if (!IS_ROUTER_PAGE) return;

        if (!pwHost) {
            pwHost = document.createElement('div');
            pwHost.id = 'm7200-password-host';
            pwHost.style.cssText =
                'all:initial;position:fixed;z-index:2147483647;top:18px;left:50%;transform:translateX(-50%);';

            pwShadow = pwHost.attachShadow({mode: 'closed'});

            (document.documentElement || document.body).appendChild(pwHost);
        }

        renderPasswordPanel(
            failedNow || (request && request.reason === 'rejected') || !GM_getValue(K.password, '')
                ? 'ask'
                : 'settings',
            request,
            failedNow
        );
    }

    function initRouterPage() {
        const beat = () => {
            GM_setValue(K.routerPresence, Date.now());
            markFocused();
        };

        beat();
        setInterval(beat, ROUTER_PRESENCE_INTERVAL);

        // Keep a short presence grace period on reload/navigation so another
        // tab does not restart polling while the router UI is being reloaded.
        window.addEventListener('pagehide', () => {
            GM_setValue(K.routerPresence, Date.now());
        });

        const request = GM_getValue(K.passwordRequest, null);
        const requestIsFresh = request &&
            Number(request.time) > Date.now() - PASSWORD_REQUEST_COOLDOWN;
        const hasPassword = Boolean(GM_getValue(K.password, ''));
        const dismissedHere = GM_getValue(K.panelDismissed, '') === location.origin;

        // Do not cover the router UI on every visit. Show only for first-time
        // setup or a recent explicit password request. The panel can be opened
        // later from the Tampermonkey menu.
        if (requestIsFresh) {
            showPasswordPanel(request);
        } else if (!hasPassword && !dismissedHere) {
            showPasswordPanel({reason: 'missing'});
        }
    }

    // ======================== הערכת זמן לכיבוי ========================
    function recordSample(info) {
        if (info.charging) {
            GM_setValue(K.history, []);
            return;
        }

        let history = GM_getValue(K.history, []);

        if (!Array.isArray(history)) history = [];

        const cutoff = info.time - HISTORY_WINDOW;

        history = history.filter(
            sample => sample && Number(sample.t) >= cutoff
        );

        const last = history[history.length - 1];

        if (last && info.level > Number(last.level)) {
            history = [];
        }

        history.push({t: info.time, level: info.level});
        GM_setValue(K.history, history);
    }

    function estimateMinutesLeft(level) {
        let history = GM_getValue(K.history, []);

        if (!Array.isArray(history) || history.length < 5) return null;

        history = history
            .filter(sample =>
                sample &&
                Number.isFinite(Number(sample.t)) &&
                Number.isFinite(Number(sample.level)) &&
                Number(sample.level) >= 0 &&
                Number(sample.level) <= 100
            )
            .sort((a, b) => Number(a.t) - Number(b.t));

        if (history.length < 5) return null;

        const first = history[0];
        const last = history[history.length - 1];
        const span = Number(last.t) - Number(first.t);
        const totalDrop = Number(first.level) - Number(last.level);

        if (span < MIN_ETA_SPAN || totalDrop < MIN_ETA_DROPS) {
            return null;
        }

        let dropEvents = 0;

        for (let i = 1; i < history.length; i++) {
            if (Number(history[i].level) < Number(history[i - 1].level)) {
                dropEvents++;
            }
        }

        if (dropEvents < MIN_ETA_DROPS) return null;

        const origin = Number(first.t);

        const points = history.map(sample => ({
            x: (Number(sample.t) - origin) / 60000,
            y: Number(sample.level)
        }));

        const meanX = points.reduce(
            (sum, point) => sum + point.x,
            0
        ) / points.length;

        const meanY = points.reduce(
            (sum, point) => sum + point.y,
            0
        ) / points.length;

        let covariance = 0;
        let variance = 0;

        for (const point of points) {
            const dx = point.x - meanX;
            covariance += dx * (point.y - meanY);
            variance += dx * dx;
        }

        if (variance <= 0) return null;

        const slope = covariance / variance;
        const ratePerMinute = -slope;

        if (!Number.isFinite(ratePerMinute) || ratePerMinute <= 0) {
            return null;
        }

        return Math.max(Number(level) - SHUTDOWN_LEVEL, 0) / ratePerMinute;
    }

    function formatEta(minutes) {
        if (!Number.isFinite(minutes)) return '';
        if (minutes < 1) return 'פחות מדקה';
        if (minutes < 1.5) return 'כדקה';

        return `כ-${Math.max(1, Math.round(minutes))} דקות`;
    }

    function etaSentence(level, minutes) {
        if (Number(level) <= SHUTDOWN_LEVEL) {
            return 'הנתב עלול להיכבות בכל רגע';
        }

        const estimate = formatEta(minutes);

        return estimate ? `זמן משוער לכיבוי: ${estimate}` : '';
    }

    // ======================== חלונית ההתראה ========================
    function hideToast() {
        if (toastHost) toastHost.remove();

        toastHost = null;
        toastShadow = null;
        toastAlertId = null;
    }

    function closeToast() {
        hideToast();
        clearTimeout(autoSnoozeTimer);
        autoSnoozeTimer = null;
    }

    function isCurrentTab() {
        return document.visibilityState === 'visible' &&
            document.hasFocus();
    }

    function markFocused() {
        if (!isCurrentTab()) return;

        GM_setValue(K.focusAt, {
            owner: INSTANCE_ID,
            time: Date.now()
        });
    }

    function clearFocused() {
        const focus = GM_getValue(K.focusAt, null);

        if (
            focus &&
            typeof focus === 'object' &&
            focus.owner === INSTANCE_ID
        ) {
            GM_setValue(K.focusAt, null);
        }
    }

    function hasRecentFocus() {
        const focus = GM_getValue(K.focusAt, null);

        if (!focus || typeof focus !== 'object') return false;

        const age = Date.now() - Number(focus.time);

        return Boolean(focus.owner) &&
            age >= 0 &&
            age <= FOCUS_RECENT;
    }

    function autoSnoozeAt(alert) {
        const stored = Number(alert && alert.autoAt);
        const created = Number(alert && alert.time);

        return stored > 0
            ? stored
            : created + AUTO_SNOOZE_AFTER;
    }

    function setReminder(alert) {
        if (!alert || !alert.id) return;

        const current = GM_getValue(K.alert, null);

        if (!current || current.id !== alert.id) return;
        if (GM_getValue(K.dismissed, '') === alert.id) return;

        const existing = GM_getValue(K.snooze, null);

        if (existing && existing.alertId === alert.id) return;

        const level = Number(current.level);

        GM_setValue(K.snooze, {
            alertId: alert.id,
            remindAt: Date.now() + SNOOZE_TIME,
            remindBelow: Math.max(level - SNOOZE_DROP, 0)
        });

        GM_setValue(K.dismissed, alert.id);
        closeToast();
    }

    function scheduleAutoSnooze(alert) {
        clearTimeout(autoSnoozeTimer);
        autoSnoozeTimer = null;

        if (!alert || !alert.id) return;

        const current = GM_getValue(K.alert, null);

        if (!current || current.id !== alert.id) return;
        if (GM_getValue(K.dismissed, '') === alert.id) return;

        const delay = Math.max(
            0,
            autoSnoozeAt(alert) - Date.now()
        );

        autoSnoozeTimer = setTimeout(
            () => setReminder(alert),
            delay
        );
    }

    // נבנה באמצעות createElement ו-textContent, ללא innerHTML.
    function renderToast(alert) {
        if (!toastShadow) return;

        const urgent = Number(alert.stage) >= 2;
        const level = Number(alert.level);
        const eta = etaSentence(level, alert.eta);

        const style = makeElement('style');

        style.textContent = `
            *{box-sizing:border-box}
            .panel{direction:rtl;width:min(340px,calc(100vw - 36px));font:14px Arial,sans-serif;background:#fff;color:#202124;border:1px solid #dadce0;border-top:5px solid ${urgent ? '#c5221f' : '#e37400'};border-radius:12px;box-shadow:0 8px 28px #0003;padding:15px}
            .head{font-size:16px;font-weight:700;margin-bottom:7px}
            .pct{font-size:30px;font-weight:800;color:${urgent ? '#c5221f' : '#b06000'};margin:4px 0}
            .eta{font-size:13px;font-weight:600;line-height:1.45;background:#f1f3f4;border-radius:7px;padding:7px 9px;margin:7px 0 11px}
            button{font:600 13px Arial;border:0;border-radius:7px;padding:9px 15px;background:#1967d2;color:white;cursor:pointer}
        `;

        const panel = makeElement('div', 'panel');

        panel.setAttribute('role', 'alertdialog');
        panel.setAttribute('aria-live', 'assertive');

        panel.appendChild(makeElement(
            'div',
            'head',
            urgent ? '🚨 התראת סוללה דחופה' : '🔋 התראת סוללה'
        ));

        panel.appendChild(makeElement('div', 'pct', `${level}%`));

        if (eta) {
            panel.appendChild(makeElement('div', 'eta', eta));
        }

        const snoozeButton = makeElement('button', '', 'נודניק');
        snoozeButton.id = 'snooze';

        snoozeButton.addEventListener('click', () => {
            setReminder(alert);
        });

        panel.appendChild(snoozeButton);

        toastShadow.replaceChildren(style, panel);
    }

    function showToast(alert) {
        if (!alert || !alert.id || !isCurrentTab()) return;
        if (GM_getValue(K.dismissed, '') === alert.id) return;

        if (!toastHost || toastAlertId !== alert.id) {
            hideToast();

            toastAlertId = alert.id;
            toastHost = document.createElement('div');
            toastHost.id = 'm7200-battery-alert-host';

            toastHost.style.cssText =
                'all:initial;position:fixed;z-index:2147483647;top:18px;right:18px;';

            toastShadow = toastHost.attachShadow({mode: 'open'});

            (document.documentElement || document.body).appendChild(toastHost);
        }

        renderToast(alert);
    }

    function syncAlert() {
        const alert = GM_getValue(K.alert, null);

        if (
            !alert ||
            !alert.id ||
            GM_getValue(K.dismissed, '') === alert.id
        ) {
            closeToast();
            return;
        }

        if (Date.now() >= autoSnoozeAt(alert)) {
            setReminder(alert);
            return;
        }

        scheduleAutoSnooze(alert);

        if (isCurrentTab()) {
            showToast(alert);
        } else {
            hideToast();
        }
    }

    // ======================== יצירת התראה ========================
    function createAlert(level, stage, eta = null) {
        const now = Date.now();

        const alert = {
            id: `${now}-${Math.random().toString(36).slice(2)}`,
            level,
            triggerLevel: level,
            stage,
            eta,
            time: now,
            autoAt: now + AUTO_SNOOZE_AFTER
        };

        GM_setValue(K.alert, alert);
        GM_setValue(K.dismissed, '');

        const recentlyFocused = hasRecentFocus();

        if (stage >= 2 || !recentlyFocused) {
            const title = stage >= 2
                ? `🚨 M7200 – סוללה דחופה (${level}%)`
                : `🔋 M7200 – סוללה חלשה (${level}%)`;

            const etaLine = etaSentence(level, eta);
            const body = etaLine || 'זמן משוער לכיבוי עדיין לא זמין';

            notify(title, body, {
                tag: 'm7200-battery-alert',
                timeout: 30000,
                silent: false,
                onclick: () => {
                    try {
                        window.focus();
                    } catch (_) {}

                    syncAlert();
                }
            });
        }

        syncAlert();
    }

    function refreshActiveAlert(info, eta) {
        const active = GM_getValue(K.alert, null);

        if (!active || !active.id) return;
        if (GM_getValue(K.dismissed, '') === active.id) return;

        const sameLevel = Number(active.level) === info.level;

        const sameEta =
            etaSentence(info.level, active.eta) ===
            etaSentence(info.level, eta);

        if (sameLevel && sameEta) return;

        GM_setValue(K.alert, {
            ...active,
            level: info.level,
            triggerLevel: Number.isFinite(Number(active.triggerLevel))
                ? Number(active.triggerLevel)
                : Number(active.level),
            eta
        });
    }

    // ======================== עיבוד נתוני הסוללה ========================
    function levelStage(level) {
        return level <= URGENT_LEVEL
            ? 2
            : level <= WARNING_LEVEL
                ? 1
                : 0;
    }

    function processStatus(status) {
        const battery = status && status.battery
            ? status.battery
            : {};

        const level = Number(battery.voltage);
        const identity = routerIdentity(status);
        trackRouterFingerprint(identity);

        const asBool = (value, fallback = false) => {
            if (
                value === true ||
                value === 1 ||
                value === '1' ||
                String(value).toLowerCase() === 'true'
            ) return true;

            if (
                value === false ||
                value === 0 ||
                value === '0' ||
                String(value).toLowerCase() === 'false'
            ) return false;

            return fallback;
        };

        const charging = asBool(battery.charging);
        const connected = asBool(battery.connected, true);

        if (!Number.isFinite(level) || level < 0 || level > 100) {
            saveCompatibilityResult('PROTOCOL_MISMATCH', status, 'הנתב לא החזיר אחוז סוללה תקין בשדה battery.voltage.');
            throw new ProtocolMismatchError('הנתב הגיב, אך נתוני הסוללה אינם במבנה המוכר.');
        }

        const info = {
            level: Math.round(level),
            charging,
            connected,
            model: identity.model,
            hardwareVersion: identity.hardwareVersion,
            firmwareVersion: identity.firmwareVersion,
            time: Date.now()
        };

        GM_setValue(K.lastStatus, info);
        saveCompatibilityResult('LIVE_SUCCESS', status, 'התחברות וקריאת סוללה הצליחו.', info.level, charging);

        if (connected) recordSample(info);

        let alarm = GM_getValue(K.alarm, null);

        if (!alarm || typeof alarm !== 'object') {
            alarm = {stage: 0, wasCharging: false};
        }

        alarm = {
            stage: Number(alarm.stage || 0),
            wasCharging: Boolean(alarm.wasCharging)
        };

        if (info.level > RESET_LEVEL) {
            if (
                alarm.stage ||
                alarm.wasCharging ||
                GM_getValue(K.alert, null) ||
                GM_getValue(K.snooze, null)
            ) {
                GM_setValue(K.alarm, {stage: 0, wasCharging: false});
                GM_setValue(K.snooze, null);
                GM_setValue(K.alert, null);
                GM_setValue(K.dismissed, '');
                closeToast();
            }

            return info;
        }

        if (!connected) return info;

        const stage = levelStage(info.level);
        const eta = estimateMinutesLeft(info.level);

        if (charging) {
            GM_setValue(K.alarm, {stage: 0, wasCharging: true});
            GM_setValue(K.snooze, null);

            const activeAlert = GM_getValue(K.alert, null);

            if (activeAlert && activeAlert.id) {
                GM_setValue(K.dismissed, activeAlert.id);
            }

            closeToast();
            return info;
        }

        if (alarm.wasCharging) {
            alarm.wasCharging = false;

            if (stage > 0) {
                alarm.stage = stage;

                GM_setValue(K.alarm, alarm);
                GM_setValue(K.snooze, null);
                createAlert(info.level, stage, eta);

                return info;
            }
        }

        if (stage > alarm.stage) {
            alarm.stage = stage;

            GM_setValue(K.alarm, alarm);
            GM_setValue(K.snooze, null);
            createAlert(info.level, stage, eta);

            return info;
        }

        if (stage < alarm.stage) {
            alarm.stage = stage;
        }

        const snooze = GM_getValue(K.snooze, null);

        if (stage > 0 && snooze && snooze.alertId) {
            const timeUp = Date.now() >= Number(snooze.remindAt);

            const dropped =
                snooze.remindBelow != null &&
                info.level <= Number(snooze.remindBelow);

            if (timeUp || dropped) {
                GM_setValue(K.snooze, null);
                GM_setValue(K.alarm, alarm);
                createAlert(info.level, stage, eta);

                return info;
            }
        }

        refreshActiveAlert(info, eta);
        GM_setValue(K.alarm, alarm);

        return info;
    }

    // ======================== בקרה על קצב הבדיקות ========================
    function ownsLock() {
        const lock = GM_getValue(K.lock, null);

        return Boolean(
            lock &&
            lock.owner === INSTANCE_ID &&
            lockToken &&
            lock.token === lockToken &&
            Number(lock.until) > Date.now()
        );
    }

    function schedulePoll(delay) {
        clearTimeout(pollTimer);

        pollTimer = setTimeout(() => {
            pollTimer = null;

            if (isLeader && ownsLock()) {
                poll();
            } else {
                heartbeat();
            }
        }, delay);
    }

    function pollNow() {
        clearTimeout(pollTimer);
        pollTimer = null;
        poll();
    }

    function nextPollDelay(info) {
        let delay =
            info.level <= WARNING_LEVEL && !info.charging
                ? LOW_INTERVAL
                : NORMAL_INTERVAL;

        const snooze = GM_getValue(K.snooze, null);

        if (
            snooze &&
            snooze.remindAt &&
            !info.charging &&
            info.level <= WARNING_LEVEL
        ) {
            delay = Math.min(
                delay,
                Math.max(1000, Number(snooze.remindAt) - Date.now())
            );
        }

        return delay;
    }

    function reportError(error) {
        const now = Date.now();
        const previous = Number(GM_getValue(K.lastError, 0));

        if (now - previous > 15 * 60 * 1000) {
            GM_setValue(K.lastError, now);
            notify(
                'M7200 – בעיית ניטור',
                error.message || String(error)
            );
        }
    }

    function handlePollError(error) {
        if (error instanceof ProtocolMismatchError) {
            const current = GM_getValue(K.compatibilityState, null);
            if (!current || current.result !== 'PROTOCOL_MISMATCH') {
                saveCompatibilityResult('PROTOCOL_MISMATCH', null, error.message || 'פרוטוקול הנתב אינו תואם.');
            }
            return NORMAL_INTERVAL;
        }

        if (error instanceof PasswordError) {
            return PASSWORD_WAIT_INTERVAL;
        }

        if (error instanceof NetworkError) {
            netFailures++;

            return Math.min(
                NORMAL_INTERVAL,
                NETWORK_RETRY_BASE * 2 ** (netFailures - 1)
            );
        }

        netFailures = 0;

        if (!(error instanceof AuthError)) {
            reportError(error);
        }

        return NORMAL_INTERVAL;
    }

    async function poll() {
        if (IS_ROUTER_PAGE || isRouterManagementPageOpen()) {
            loseLeadership();
            return;
        }

        if (!isLeader || pollInProgress || compatibilityCheckInProgress || !ownsLock()) return;

        pollInProgress = true;
        let nextDelay = NORMAL_INTERVAL;

        try {
            const status = await getStatus();
            const info = processStatus(status);

            netFailures = 0;
            GM_deleteValue(K.lastError);

            nextDelay = nextPollDelay(info);
        } catch (error) {
            nextDelay = handlePollError(error);
        } finally {
            pollInProgress = false;

            if (isLeader) {
                schedulePoll(nextDelay);
            }
        }
    }

    // ======================== ניהול לשוניות ========================
    function loseLeadership() {
        isLeader = false;
        lockToken = null;
        clearTimeout(pollTimer);
        pollTimer = null;
    }

    async function heartbeat() {
        if (IS_ROUTER_PAGE) {
            loseLeadership();
            return;
        }

        if (heartbeatInProgress) return;

        heartbeatInProgress = true;

        const now = Date.now();
        const gap = now - lastBeat;
        lastBeat = now;

        try {
            const routerUiOpen = isRouterManagementPageOpen();

            // The router firmware supports only one management session.
            // Pause ALL API traffic while its web UI is open. A manual check
            // remains queued and will run once the UI has been closed.
            if (routerUiOpen) {
                loseLeadership();
                return;
            }

            markFocused();

            let lock = GM_getValue(K.lock, null);
            const lockAlive = lock && Number(lock.until) > now;

            if (lockAlive && lock.owner !== INSTANCE_ID) {
                loseLeadership();
                return;
            }

            const wasLeader = isLeader;

            if (
                lockAlive &&
                lock.owner === INSTANCE_ID &&
                lockToken &&
                lock.token === lockToken
            ) {
                GM_setValue(K.lock, {
                    owner: INSTANCE_ID,
                    token: lockToken,
                    until: Date.now() + LOCK_TTL
                });
            } else {
                const jitter = Math.floor(
                    Math.random() * LOCK_ELECTION_JITTER
                );

                await new Promise(resolve => setTimeout(resolve, jitter));

                lock = GM_getValue(K.lock, null);

                if (
                    lock &&
                    lock.owner !== INSTANCE_ID &&
                    Number(lock.until) > Date.now()
                ) {
                    loseLeadership();
                    return;
                }

                const candidateToken =
                    `${INSTANCE_ID}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

                GM_setValue(K.lock, {
                    owner: INSTANCE_ID,
                    token: candidateToken,
                    until: Date.now() + LOCK_TTL
                });

                await new Promise(resolve => setTimeout(resolve, 220));

                const verified = GM_getValue(K.lock, null);

                if (
                    !verified ||
                    verified.owner !== INSTANCE_ID ||
                    verified.token !== candidateToken
                ) {
                    loseLeadership();
                    return;
                }

                lockToken = candidateToken;
            }

            // Recheck after the asynchronous lock-election delay. The router
            // UI may have opened while this tab was waiting to acquire the lock.
            if (isRouterManagementPageOpen()) {
                loseLeadership();
                return;
            }

            isLeader = true;

            if (handlePendingCompatibilityCheck()) return;

            if (!wasLeader || gap > RESUME_GAP) {
                pollNow();
            } else if (!pollTimer && !pollInProgress) {
                poll();
            }
        } finally {
            heartbeatInProgress = false;
        }
    }

    // ======================== סנכרון בין לשוניות ========================
    GM_addValueChangeListener(K.alert, (_key, _oldValue, newValue) => {
        if (newValue) {
            syncAlert();
        } else {
            closeToast();
        }
    });

    GM_addValueChangeListener(K.dismissed, (_key, _oldValue, newValue) => {
        if (newValue && newValue === toastAlertId) {
            closeToast();
        }
    });

    GM_addValueChangeListener(K.routerPresence, () => {
        if (IS_ROUTER_PAGE || compatibilityCheckInProgress) return;
        if (isRouterManagementPageOpen()) {
            loseLeadership();
        } else {
            heartbeat();
        }
    });

    GM_addValueChangeListener(K.routerBase, () => {
        if (IS_ROUTER_PAGE) return;
        session = null;
        if (isLeader && !isRouterManagementPageOpen()) pollNow();
    });

    GM_addValueChangeListener(K.compatibilityHandledTicket, (_key, _oldValue, ticket) => {
        handledCompatibilityTicket = Number(ticket || 0);
    });

    GM_addValueChangeListener(K.compatibilityTicket, (_key, _oldValue, ticket) => {
        if (IS_ROUTER_PAGE) return;
        const value = Number(ticket || 0);
        const handled = Number(GM_getValue(
            K.compatibilityHandledTicket,
            handledCompatibilityTicket
        ));
        handledCompatibilityTicket = handled;
        if (!value || value === handled) return;

        if (isLeader) {
            handlePendingCompatibilityCheck();
        } else {
            heartbeat();
        }
    });

    GM_addValueChangeListener(K.compatibilityState, () => {
        if (IS_ROUTER_PAGE && pwHost) {
            pwChecking = false;
            renderPasswordPanel('settings');

            const state = GM_getValue(K.compatibilityState, null);
            if (state && ['LIVE_SUCCESS', 'PROTOCOL_MISMATCH'].includes(state.result)) {
                GM_setValue(K.passwordRequest, null);
            }
        }
    });

    GM_addValueChangeListener(K.passwordTicket, () => {
        if (IS_ROUTER_PAGE) return;
        session = null;

        if (hasPendingCompatibilityCheck()) return;
        if (isLeader && !isRouterManagementPageOpen()) pollNow();
    });

    GM_addValueChangeListener(
        K.passwordRequest,
        (_key, _oldValue, request) => {
            if (!IS_ROUTER_PAGE) return;

            const wasChecking = pwChecking;

            if (!request) {
                pwChecking = false;
                return;
            }

            pwChecking = false;
            showPasswordPanel(request, wasChecking);
        }
    );

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            markFocused();
            syncAlert();
            if (!IS_ROUTER_PAGE) heartbeat();
        } else {
            clearFocused();
            hideToast();
        }
    });

    window.addEventListener('focus', () => {
        markFocused();
        syncAlert();
        if (!IS_ROUTER_PAGE) heartbeat();
    });

    window.addEventListener('blur', () => {
        clearFocused();
        hideToast();
    });

    window.addEventListener('pagehide', clearFocused);

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('פתח חלונית בדיקת נתב TP-Link', () => {
            if (IS_ROUTER_PAGE) {
                showPasswordPanel(
                    GM_getValue(K.passwordRequest, null) || {reason: 'manual'}
                );
            } else {
                requestPassword('manual');
            }
        });
    }

    window.addEventListener('online', () => {
        if (!isLeader) return;

        netFailures = 0;
        pollNow();
    });

    // ======================== הפעלה ========================
    const startupDelay = 500 + Math.random() * 700;

    setTimeout(() => {
        markFocused();
        syncAlert();
    }, startupDelay);

    if (IS_ROUTER_PAGE) {
        initRouterPage();
    }

    if (
        typeof crypto === 'undefined' ||
        !crypto.subtle ||
        typeof BigInt !== 'function'
    ) {
        return;
    }

    if (!IS_ROUTER_PAGE) {
        setTimeout(heartbeat, startupDelay);
        setInterval(heartbeat, HEARTBEAT_INTERVAL);
    }
})();
