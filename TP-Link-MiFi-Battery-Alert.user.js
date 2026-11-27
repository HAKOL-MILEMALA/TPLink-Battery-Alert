
/* eslint-disable userscripts/avoid-regexp-include -- Regex is required to match private LAN IPv4 ranges; @match cannot express IP subnets. */
// ==UserScript==
// @name         התראת סוללה ל-TP-Link
// @namespace    HAKOL-MILEMALA
// @version      2.1.7
// @description  ניטור סוללה לנתבים ניידים של TP-Link
// @author       HAKOL-MILEMALA
// @homepageURL  https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert
// @supportURL   https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/issues
// @downloadURL  https://raw.githubusercontent.com/HAKOL-MILEMALA/TPLink-Battery-Alert/main/TP-Link-MiFi-Battery-Alert.user.js
// @updateURL    https://raw.githubusercontent.com/HAKOL-MILEMALA/TPLink-Battery-Alert/main/TP-Link-MiFi-Battery-Alert.user.js
// @match        https://*/*
// @include    /^http:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})(?::\d+)?\/.*$/
// @match        http://tplinkmifi.net/*
// @connect      192.168.0.1
// @connect      192.168.1.1
// @connect      192.168.8.1
// @connect      10.0.0.1
// @connect      tplinkmifi.net
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @run-at       document-idle
// @noframes
// ==/UserScript==
/* eslint-enable userscripts/avoid-regexp-include */

(() => {
    'use strict';

    // ======================== הגדרות ========================
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
        return isPrivateIPv4(value) || value === 'tplinkmifi.net';
    }

    // Normalize router URLs without losing the MiFi hostname alias.
    // The alias may resolve to a custom LAN address, so never force it to
    // 192.168.0.1. The first-run default remains 192.168.0.1 separately.
    function normalizeRouterOrigin(value) {
        try {
            const url = new URL(String(value || '').trim());
            if (url.protocol !== 'http:' || !isAllowedRouterHost(url.hostname)) return '';
            return url.origin;
        } catch (_) {
            return '';
        }
    }

    function saveRouterOrigin(value) {
        const normalized = normalizeRouterOrigin(value);
        if (!normalized) return '';
        GM_setValue(ROUTER_STORAGE_KEY, normalized);
        return normalized;
    }

    function isPotentialMiFiManagementPage() {
        if (location.protocol !== 'http:' || !isAllowedRouterHost(location.hostname)) return false;
        if (location.hostname.toLowerCase() === 'tplinkmifi.net') return true;

        const pageText = [
            document.title || '',
            document.body ? String(document.body.innerText || '').slice(0, 2500) : ''
        ].join(' ');

        const hasMiFiLabel = /\btpmiFi\b|\bMiFi\b|Mobile\s*Wi-?Fi/i.test(pageText);
        const hasTpLinkBrand = /TP[\s-]?Link/i.test(pageText);
        const hasMiFiModel = /\bM\d{3,5}\b/i.test(pageText);

        // Do not mistake Huawei/ZTE MiFi pages for TP-Link devices.
        return hasTpLinkBrand && (hasMiFiLabel || hasMiFiModel);
    }

    const RAW_SAVED_ROUTER_ORIGIN = String(
        GM_getValue(ROUTER_STORAGE_KEY, '') || ''
    ).replace(/\/+$/, '');
    const SAVED_ROUTER_ORIGIN = normalizeRouterOrigin(RAW_SAVED_ROUTER_ORIGIN);

    // Migrate any previously saved hostname (or non-canonical URL) once.
    if (SAVED_ROUTER_ORIGIN && SAVED_ROUTER_ORIGIN !== RAW_SAVED_ROUTER_ORIGIN) {
        GM_setValue(ROUTER_STORAGE_KEY, SAVED_ROUTER_ORIGIN);
    }

    function isRouterManagementPage() {
        if (location.protocol !== 'http:') return false;

        // A saved IP and the MiFi hostname are kept distinct. When the user
        // enters through the hostname, preserve that endpoint because it may
        // resolve to a non-default LAN address.
        if (SAVED_ROUTER_ORIGIN) return location.origin === SAVED_ROUTER_ORIGIN;

        return isPotentialMiFiManagementPage();
    }

    const IS_ROUTER_PAGE = isRouterManagementPage();
    const IS_ROUTER_SWITCH_CANDIDATE = Boolean(
        SAVED_ROUTER_ORIGIN &&
        location.origin !== SAVED_ROUTER_ORIGIN &&
        !IS_ROUTER_PAGE &&
        isPotentialMiFiManagementPage()
    );
    const IS_ROUTER_UI_PAGE = IS_ROUTER_PAGE || IS_ROUTER_SWITCH_CANDIDATE;

    // Mark a router UI as open immediately, before the rest of the script initializes.
    if (IS_ROUTER_UI_PAGE) {
        const key = 'tplink_mifi_router_presence_v2';
        const current = GM_getValue(key, {});
        const presence = current && typeof current === 'object' && !Array.isArray(current)
            ? {...current}
            : {};
        presence.__opening = Date.now();
        GM_setValue(key, presence);
    }

    function getRouterBase() {
        const stored = String(GM_getValue(ROUTER_STORAGE_KEY, '') || '').trim();
        const normalized = normalizeRouterOrigin(stored) || 'http://192.168.0.1';
        if (stored && normalized !== stored) {
            GM_setValue(ROUTER_STORAGE_KEY, normalized);
        }
        return normalized;
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

    const LOCK_TTL = 120 * 1000;
    const HEARTBEAT_INTERVAL = 12 * 1000;
    const RESUME_GAP = 90 * 1000;
    const LOCK_ELECTION_JITTER = 900;

    const AUTH_FAILURES_BEFORE_ASK = 2;
    const PASSWORD_REQUEST_COOLDOWN = 15 * 60 * 1000;
    const ROUTER_PRESENCE_TTL = 150 * 1000;
    const ROUTER_PRESENCE_INTERVAL = 15 * 1000;

    const K = {
        password: 'tplink_mifi_password',
        routerBase: ROUTER_STORAGE_KEY,
        routerFingerprint: 'tplink_mifi_router_fingerprint',
        connectionState: 'tplink_mifi_connection_state',
        connectionResultSeen: 'tplink_mifi_connection_result_seen',
        setupPromptSeen: 'tplink_mifi_setup_prompt_seen',
        firstRunSetupLaunched: 'tplink_mifi_first_run_setup_launched_v2',
        passwordTicket: 'tplink_mifi_password_ticket',
        passwordRequest: 'tplink_mifi_password_request',
        lastPasswordRequest: 'tplink_mifi_last_password_request',
        routerPresence: 'tplink_mifi_router_presence_v2',
        lock: 'tplink_mifi_monitor_lock',
        alarm: 'tplink_mifi_alarm_state',
        snooze: 'tplink_mifi_snooze',
        alert: 'tplink_mifi_last_alert',
        dismissed: 'tplink_mifi_dismissed_alert',
        history: 'tplink_mifi_history',
        focusAt: 'tplink_mifi_focus_at',
        lastError: 'tplink_mifi_last_error',
        lastStatus: 'tplink_mifi_last_status'
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
    let connectionCheckInProgress = false;
    let handledTicket = Number(GM_getValue(K.passwordTicket, 0));

    let toastHost = null;
    let toastShadow = null;
    let toastAlertId = null;

    let pwHost = null;
    let pwShadow = null;
    let pwLauncherHost = null;
    let pwLauncherShadow = null;
    let routerSwitchHost = null;
    let routerSwitchShadow = null;

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

    // ======================== AES-128-CBC (Pure JavaScript) ========================
    // Web Crypto (crypto.subtle) is unavailable on ordinary HTTP router pages.
    // This AES-128 implementation keeps encryption local and works there too.
    const AES_SBOX = new Uint8Array([
        0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
        0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
        0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
        0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
        0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
        0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
        0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
        0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
        0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
        0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
        0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
        0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
        0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
        0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
        0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
        0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
    ]);
    const AES_INV_SBOX = new Uint8Array([
        0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,
        0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,
        0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,
        0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,
        0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,
        0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,
        0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,
        0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,
        0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,
        0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,
        0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,
        0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,
        0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,
        0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,
        0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,
        0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d
    ]);

    function aesGfMultiply(a, b) {
        let result = 0;
        for (let i = 0; i < 8; i++) {
            if (b & 1) result ^= a;
            const high = a & 0x80;
            a = (a << 1) & 0xff;
            if (high) a ^= 0x1b;
            b >>>= 1;
        }
        return result;
    }

    function aesExpandKey(key) {
        if (key.length !== 16) throw new Error('מפתח AES חייב להכיל 16 בתים');
        const expanded = new Uint8Array(176);
        expanded.set(key);
        let generated = 16;
        let rcon = 1;
        const temp = new Uint8Array(4);

        while (generated < 176) {
            temp.set(expanded.subarray(generated - 4, generated));
            if (generated % 16 === 0) {
                const first = temp[0];
                temp[0] = AES_SBOX[temp[1]] ^ rcon;
                temp[1] = AES_SBOX[temp[2]];
                temp[2] = AES_SBOX[temp[3]];
                temp[3] = AES_SBOX[first];
                rcon = aesGfMultiply(rcon, 2);
            }
            for (let i = 0; i < 4; i++) {
                expanded[generated] = expanded[generated - 16] ^ temp[i];
                generated++;
            }
        }
        return expanded;
    }

    function aesAddRoundKey(state, expandedKey, round) {
        const offset = round * 16;
        for (let i = 0; i < 16; i++) state[i] ^= expandedKey[offset + i];
    }

    function aesShiftRows(state, inverse = false) {
        const copy = state.slice();
        for (let row = 1; row < 4; row++) {
            for (let col = 0; col < 4; col++) {
                const sourceCol = inverse
                    ? (col - row + 4) % 4
                    : (col + row) % 4;
                state[col * 4 + row] = copy[sourceCol * 4 + row];
            }
        }
    }

    function aesSubBytes(state, inverse = false) {
        const box = inverse ? AES_INV_SBOX : AES_SBOX;
        for (let i = 0; i < 16; i++) state[i] = box[state[i]];
    }

    function aesMixColumns(state, inverse = false) {
        for (let col = 0; col < 4; col++) {
            const i = col * 4;
            const a = state[i], b = state[i + 1], c = state[i + 2], d = state[i + 3];
            if (inverse) {
                state[i]     = aesGfMultiply(a,14) ^ aesGfMultiply(b,11) ^ aesGfMultiply(c,13) ^ aesGfMultiply(d,9);
                state[i + 1] = aesGfMultiply(a,9)  ^ aesGfMultiply(b,14) ^ aesGfMultiply(c,11) ^ aesGfMultiply(d,13);
                state[i + 2] = aesGfMultiply(a,13) ^ aesGfMultiply(b,9)  ^ aesGfMultiply(c,14) ^ aesGfMultiply(d,11);
                state[i + 3] = aesGfMultiply(a,11) ^ aesGfMultiply(b,13) ^ aesGfMultiply(c,9)  ^ aesGfMultiply(d,14);
            } else {
                state[i]     = aesGfMultiply(a,2) ^ aesGfMultiply(b,3) ^ c ^ d;
                state[i + 1] = a ^ aesGfMultiply(b,2) ^ aesGfMultiply(c,3) ^ d;
                state[i + 2] = a ^ b ^ aesGfMultiply(c,2) ^ aesGfMultiply(d,3);
                state[i + 3] = aesGfMultiply(a,3) ^ b ^ c ^ aesGfMultiply(d,2);
            }
        }
    }

    function aesEncryptBlock(block, expandedKey) {
        const state = block.slice();
        aesAddRoundKey(state, expandedKey, 0);
        for (let round = 1; round < 10; round++) {
            aesSubBytes(state);
            aesShiftRows(state);
            aesMixColumns(state);
            aesAddRoundKey(state, expandedKey, round);
        }
        aesSubBytes(state);
        aesShiftRows(state);
        aesAddRoundKey(state, expandedKey, 10);
        return state;
    }

    function aesDecryptBlock(block, expandedKey) {
        const state = block.slice();
        aesAddRoundKey(state, expandedKey, 10);
        for (let round = 9; round > 0; round--) {
            aesShiftRows(state, true);
            aesSubBytes(state, true);
            aesAddRoundKey(state, expandedKey, round);
            aesMixColumns(state, true);
        }
        aesShiftRows(state, true);
        aesSubBytes(state, true);
        aesAddRoundKey(state, expandedKey, 0);
        return state;
    }

    async function aesEncrypt(text, keyText, ivText) {
        const key = encoder.encode(String(keyText));
        const iv = encoder.encode(String(ivText));
        if (key.length !== 16 || iv.length !== 16) {
            throw new Error('מפתח או וקטור AES אינם באורך תקין');
        }

        const source = encoder.encode(String(text));
        const padding = 16 - (source.length % 16);
        const padded = new Uint8Array(source.length + padding);
        padded.set(source);
        padded.fill(padding, source.length);

        const expandedKey = aesExpandKey(key);
        const output = new Uint8Array(padded.length);
        let previous = iv.slice();

        for (let offset = 0; offset < padded.length; offset += 16) {
            const block = padded.slice(offset, offset + 16);
            for (let i = 0; i < 16; i++) block[i] ^= previous[i];
            const encrypted = aesEncryptBlock(block, expandedKey);
            output.set(encrypted, offset);
            previous = encrypted;
        }

        return bytesToBase64(output);
    }

    async function aesDecrypt(text, keyText, ivText) {
        const key = encoder.encode(String(keyText));
        const iv = encoder.encode(String(ivText));
        const encrypted = base64ToBytes(text);
        if (key.length !== 16 || iv.length !== 16 || encrypted.length === 0 || encrypted.length % 16 !== 0) {
            throw new Error('נתוני AES שהתקבלו מהנתב אינם תקינים');
        }

        const expandedKey = aesExpandKey(key);
        const output = new Uint8Array(encrypted.length);
        let previous = iv.slice();

        for (let offset = 0; offset < encrypted.length; offset += 16) {
            const block = encrypted.slice(offset, offset + 16);
            const decrypted = aesDecryptBlock(block, expandedKey);
            for (let i = 0; i < 16; i++) decrypted[i] ^= previous[i];
            output.set(decrypted, offset);
            previous = block;
        }

        const padding = output[output.length - 1];
        if (padding < 1 || padding > 16) throw new Error('ריפוד AES אינו תקין');
        for (let i = output.length - padding; i < output.length; i++) {
            if (output[i] !== padding) throw new Error('ריפוד AES אינו תקין');
        }
        return decoder.decode(output.subarray(0, output.length - padding));
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
            : status && status.device_info && typeof status.device_info === 'object'
                ? status.device_info
                : status && status.device && typeof status.device === 'object'
                    ? status.device
                    : {};
        return {
            model: firstNonEmpty(deviceInfo, ['model', 'modelName', 'deviceModel']) ||
                firstNonEmpty(status, ['model', 'modelName', 'deviceModel']) || 'לא דווח',
            hardwareVersion: firstNonEmpty(deviceInfo, ['hardwareVersion', 'hardwareVer', 'hwVersion', 'hardware_version']) ||
                firstNonEmpty(status, ['hardwareVersion', 'hardwareVer', 'hwVersion', 'hardware_version']) || 'לא דווחה',
            firmwareVersion: firstNonEmpty(deviceInfo, ['firmwareVersion', 'firmwareVer', 'softwareVersion', 'fwVersion']) ||
                firstNonEmpty(status, ['firmwareVersion', 'firmwareVer', 'softwareVersion', 'fwVersion']) || 'לא דווחה'
        };
    }


    function resetBatteryState({clearReading = true} = {}) {
        GM_setValue(K.history, []);
        GM_setValue(K.alarm, {stage: 0, wasCharging: false});
        GM_setValue(K.snooze, null);
        GM_setValue(K.alert, null);
        GM_setValue(K.dismissed, '');
        if (clearReading) GM_setValue(K.lastStatus, null);
        closeToast();
    }

    function resetRouterBatteryCycle() {
        // A firmware/model fingerprint change resets the battery cycle but
        // keeps the last visible reading until the next successful poll.
        resetBatteryState({clearReading: false});
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

    function saveConnectionState(status) {
        // A CHECKING state belongs to this specific router-page instance.
        // This lets another page detect a check abandoned by navigation/close.
        const state = {status, time: Date.now()};
        if (status === 'CHECKING') state.owner = INSTANCE_ID;
        GM_setValue(K.connectionState, state);

        if (status === 'CONNECTED' || status === 'FAILED') {
            GM_setValue(K.connectionResultSeen, false);
        }
    }

    function markProtocolMismatch(_status, message) {
        console.warn('[התראת סוללה] לא ניתן לקרוא את נתוני הסוללה:', message || 'מבנה תשובה לא מוכר');

        const previous = GM_getValue(K.connectionState, null);
        if (previous && previous.status === 'CONNECTED' && !connectionCheckInProgress) {
            saveConnectionState('FAILED');
            notify(
                'התראת סוללה',
                'הניטור הופסק כי לא ניתן לקרוא את נתוני הסוללה של הנתב הנייד.'
            );
        }
    }

    async function runImmediateConnectionCheck() {
        // The one-time test runs in the router tab itself so its result can be
        // shown immediately in the password panel. Background polling remains
        // paused while this management page is open.
        if (!IS_ROUTER_PAGE || !pwHost || connectionCheckInProgress) return;

        connectionCheckInProgress = true;
        // Always use a fresh authentication session for a manual/initial check.
        session = null;
        saveConnectionState('CHECKING');
        renderPasswordPanel();

        try {
            // Intentionally perform one login and one status read only.
            // Do not retry authentication here: a second login could interfere
            // with the router's own management session.
            await ensureLogin();
            const status = await invokeStatus();
            processStatus(status);
            netFailures = 0;
            saveConnectionState('CONNECTED');
        } catch (error) {
            session = null;
            saveConnectionState('FAILED');
            console.warn(
                '[התראת סוללה] בדיקת החיבור נכשלה:',
                error && error.name ? error.name : 'Error',
                error && error.message ? error.message : String(error)
            );
        } finally {
            connectionCheckInProgress = false;
            if (pwHost) renderPasswordPanel(GM_getValue(K.passwordRequest, null));
        }
    }

    function readRouterPresenceMap() {
        const value = GM_getValue(K.routerPresence, {});
        return value && typeof value === 'object' && !Array.isArray(value)
            ? {...value}
            : {};
    }

    function updateRouterPresence(active) {
        const now = Date.now();
        const presence = readRouterPresenceMap();

        for (const [owner, value] of Object.entries(presence)) {
            const timestamp = Number(value);
            if (!Number.isFinite(timestamp) || timestamp <= 0 ||
                now < timestamp || now - timestamp >= ROUTER_PRESENCE_TTL) {
                delete presence[owner];
            }
        }

        if (active) {
            delete presence.__opening;
            delete presence.__switching;
            presence[INSTANCE_ID] = now;
        } else {
            // Keep a 12-second grace period for navigation/reload of the router UI.
            presence[INSTANCE_ID] = now - ROUTER_PRESENCE_TTL + 12000;
        }

        GM_setValue(K.routerPresence, presence);
    }

    function isRouterPresenceOwnerActive(owner) {
        if (!owner) return false;
        const timestamp = Number(readRouterPresenceMap()[owner]);
        const age = Date.now() - timestamp;
        // updateRouterPresence(false) intentionally leaves a 12-second grace
        // marker; exclude that grace when deciding whether a check is still alive.
        return Number.isFinite(timestamp) && timestamp > 0 &&
            age >= 0 && age < ROUTER_PRESENCE_TTL - 12000;
    }

    function recoverAbandonedConnectionCheck() {
        const state = GM_getValue(K.connectionState, null);
        if (!state || !['CHECKING', 'PENDING'].includes(state.status)) return; // PENDING is legacy data from older builds.

        const now = Date.now();
        const startedAt = Number(state.time);
        const age = now - startedAt;
        const owner = String(state.owner || '');
        const ownerActive = owner === INSTANCE_ID || isRouterPresenceOwnerActive(owner);
        const timedOut = !Number.isFinite(startedAt) || age < 0 || age > 90 * 1000;

        // Old versions did not store an owner. Such a state cannot be proven
        // to belong to a running check, so release the UI instead of freezing it.
        if (!ownerActive || timedOut) {
            GM_setValue(K.connectionState, null);
            GM_setValue(K.setupPromptSeen, false);
            console.warn('[התראת סוללה] בוטלה בדיקת חיבור שננטשה או פג תוקפה.');
        }
    }

    function isRouterManagementPageOpen() {
        const now = Date.now();

        const presence = readRouterPresenceMap();
        return Object.values(presence).some(value => {
            const timestamp = Number(value);
            return Number.isFinite(timestamp) &&
                timestamp > 0 &&
                now >= timestamp &&
                now - timestamp < ROUTER_PRESENCE_TTL;
        });
    }

    // ======================== פתיחת הנתב בהתקנה ראשונה ========================
    function launchInitialRouterSetup() {
        // Run only from an ordinary HTTPS page with no configured router.
        // When installed directly on the router page, that page shows the panel.
        if (IS_ROUTER_UI_PAGE || location.protocol !== 'https:') return;
        if (GM_getValue(K.routerBase, '')) return;
        if (GM_getValue(K.firstRunSetupLaunched, false)) return;

        GM_setValue(K.firstRunSetupLaunched, true);
        try {
            GM_openInTab('http://192.168.0.1/', {
                active: true,
                insert: true,
                setParent: true
            });
        } catch (error) {
            GM_setValue(K.firstRunSetupLaunched, false);
            console.warn('[התראת סוללה] לא ניתן לפתוח את ממשק הנתב בהתקנה הראשונה:', error);
        }
    }

    // ======================== הזנת סיסמה בדף הנתב ========================
    function openRouterTab() {
        try {
            GM_openInTab(`${getRouterBase()}/`, {
                active: true,
                insert: true,
                setParent: true
            });
        } catch (error) {
            console.warn('[התראת סוללה] לא ניתן לפתוח את ממשק הנתב:', error);
        }
    }

    function requestPassword(reason, {quiet = false} = {}) {
        const now = Date.now();
        const existing = GM_getValue(K.passwordRequest, null);
        const request = {reason, time: now};

        if (!existing || existing.reason !== reason || quiet) {
            GM_setValue(K.passwordRequest, request);
        }

        if (IS_ROUTER_UI_PAGE) {
            if (IS_ROUTER_PAGE) showPasswordPanel(request);
            return;
        }

        if (quiet) {
            GM_setValue(K.lastPasswordRequest, now);
            return;
        }

        const last = Number(GM_getValue(K.lastPasswordRequest, 0));
        if (now - last < PASSWORD_REQUEST_COOLDOWN) return;

        GM_setValue(K.lastPasswordRequest, now);
        notify(
            'התראת סוללה',
            'כדי להמשיך בניטור, פתח את הגדרות הסוללה והזן את סיסמת הניהול.',
            {
                timeout: 20000,
                onclick: openRouterTab
            }
        );
    }

    function createPasswordPanelLauncher() {
        if (!IS_ROUTER_PAGE || pwHost || pwLauncherHost) return;

        pwLauncherHost = document.createElement('div');
        pwLauncherHost.id = 'tplink-mifi-password-launcher';
        pwLauncherHost.style.cssText =
            'all:initial;position:fixed;z-index:2147483646;bottom:calc(16px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);';
        pwLauncherShadow = pwLauncherHost.attachShadow({mode: 'closed'});

        const style = makeElement('style');
        style.textContent =
            '*{box-sizing:border-box}' +
            'button{font:600 14px Arial,sans-serif;background:#1967d2;color:#fff;border:0;border-radius:24px;padding:11px 19px;box-shadow:0 3px 14px #0004;cursor:pointer;white-space:nowrap}' +
            'button:hover{background:#1558b0}button:focus-visible{outline:3px solid #8ab4f8;outline-offset:3px}';

        const button = makeElement('button', '', '🔋 הגדרות סוללה');
        button.type = 'button';
        button.title = 'פתיחת הגדרות ניטור הסוללה';
        button.addEventListener('click', () => {
            showPasswordPanel(GM_getValue(K.passwordRequest, null));
        });

        pwLauncherShadow.replaceChildren(style, button);
        (document.documentElement || document.body).appendChild(pwLauncherHost);
    }

    function removePasswordPanel() {
        if (IS_ROUTER_PAGE) GM_setValue(K.passwordRequest, null);

        if (pwHost) pwHost.remove();
        pwHost = null;
        pwShadow = null;
        createPasswordPanelLauncher();
    }

    function submitPassword() {
        if (!pwShadow) return;

        const input = pwShadow.getElementById('pw');
        const value = input ? input.value : '';
        const savedPassword = String(GM_getValue(K.password, '') || '');

        if (value.length > 0) {
            GM_setValue(K.password, value);
            rejectedPassword = null;
        } else if (!savedPassword) {
            renderPasswordPanel({reason: 'missing'});
            const field = pwShadow && pwShadow.getElementById('pw');
            if (field) field.focus();
            return;
        }

        const previousTicket = Number(GM_getValue(K.passwordTicket, 0));
        const ticket = Math.max(Date.now(), previousTicket + 1);

        // A manual retry must be allowed even when the previous password failed.
        rejectedPassword = null;
        authFailures = 0;
        freshPassword = true;
        session = null;
        GM_setValue(K.passwordTicket, ticket);
        saveConnectionState('CHECKING');
        GM_setValue(K.connectionResultSeen, false);
        GM_setValue(K.passwordRequest, null);

        renderPasswordPanel();
        runImmediateConnectionCheck();
    }

    function renderPasswordPanel(request = null) {
        if (!pwShadow) return;

        const connection = GM_getValue(K.connectionState, null);
        const hasPassword = Boolean(GM_getValue(K.password, ''));
        const status = connection && connection.status;
        const reason = request && request.reason;
        const lastStatus = GM_getValue(K.lastStatus, null);
        const hasBatteryReading = Boolean(
            lastStatus &&
            Number.isFinite(Number(lastStatus.level)) &&
            Number(lastStatus.level) >= 0 &&
            Number(lastStatus.level) <= 100
        );

        let message = hasPassword
            ? 'הסיסמה השמורה תשמש להתחברות. אפשר להזין סיסמה אחרת כדי להחליף אותה.'
            : 'הזן את סיסמת הניהול של הנתב כדי להתחיל בניטור.';
        let accent = '#1967d2';

        if (status === 'CHECKING') {
            message = 'בודק את החיבור לנתב...';
        } else if (status === 'CONNECTED') {
            message = 'החיבור הצליח. ניטור הסוללה הופעל.';
            accent = '#188038';
        } else if (status === 'FAILED' || reason === 'rejected') {
            message = 'החיבור נכשל. בדוק את סיסמת הניהול ואת חיבור ה-Wi-Fi ונסה שוב.';
            accent = '#c5221f';
        } else if (reason === 'missing') {
            message = 'הזן את סיסמת הניהול של הנתב כדי להתחיל בניטור.';
        }

        const style = makeElement('style');
        style.textContent =
            '*{box-sizing:border-box}' +
            '.overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(20,25,35,.28);font:14px Arial,sans-serif;direction:rtl}' +
            '.panel{position:relative;width:min(390px,calc(100vw - 36px));max-height:calc(100vh - 36px);overflow:auto;background:#fff;color:#202124;border:1px solid #dadce0;border-top:5px solid ' + accent + ';border-radius:14px;box-shadow:0 10px 34px #0004;padding:20px}' +
            '.head{font-size:18px;font-weight:700;margin:0 30px 10px 0}' +
            '.msg{font-size:14px;line-height:1.55;color:#333;margin-bottom:15px;overflow-wrap:anywhere}' +
            '.hint{font-size:12px;line-height:1.5;color:#5f6368;margin:9px 0 13px}' +
            '.battery{border:1px solid #c8e6c9;background:#f4fbf4;border-radius:10px;padding:12px;margin:0 0 14px;text-align:center}' +
            '.battery.empty{border-color:#dadce0;background:#f8f9fa}' +
            '.battery-label{font-size:12px;color:#5f6368;margin-bottom:4px}' +
            '.battery-value{font-size:29px;font-weight:700;color:#188038;line-height:1.2}' +
            '.battery.empty .battery-value{font-size:14px;font-weight:400;color:#5f6368}' +
            '.battery-meta{font-size:12px;color:#5f6368;margin-top:5px}' +
            'input{display:block;width:100%;font:15px Arial,sans-serif;padding:11px 12px;border:1px solid #bdc1c6;border-radius:8px;margin-bottom:12px;direction:ltr}' +
            'input:focus{outline:2px solid #8ab4f8;border-color:#1967d2}' +
            '.actions{display:flex;gap:8px;align-items:center}' +
            'button{font:600 14px Arial;border:0;border-radius:8px;padding:10px 14px;cursor:pointer}' +
            '#save{background:#1967d2;color:#fff;flex:1}' +
            '#refresh{background:#e8eaed;color:#202124;white-space:nowrap}' +
            '#save:disabled,#refresh:disabled{opacity:.55;cursor:default}' +
            '#close{position:absolute;top:12px;left:12px;background:transparent;color:#5f6368;font-size:21px;padding:3px 8px}' +
            '.project{display:inline-block;margin-top:14px;color:#1967d2;font-size:12px;text-decoration:underline}';

        const overlay = makeElement('div', 'overlay');
        const panel = makeElement('div', 'panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-live', 'polite');

        const close = makeElement('button', '', '×');
        close.id = 'close';
        close.type = 'button';
        close.setAttribute('aria-label', 'סגירה');
        close.addEventListener('click', removePasswordPanel);
        panel.appendChild(close);

        panel.appendChild(makeElement('div', 'head', '🔋 הגדרות ניטור סוללה'));
        panel.appendChild(makeElement('div', 'msg', message));

        const batteryBox = makeElement('div', hasBatteryReading ? 'battery' : 'battery empty');
        const batteryLabel = status === 'CONNECTED'
            ? 'קריאת הסוללה האחרונה מהנתב'
            : 'נתון הסוללה האחרון שנשמר';
        batteryBox.appendChild(makeElement('div', 'battery-label', batteryLabel));
        batteryBox.appendChild(makeElement(
            'div',
            'battery-value',
            hasBatteryReading ? `${Math.round(Number(lastStatus.level))}%` : 'טרם התקבלה קריאת סוללה'
        ));

        if (hasBatteryReading) {
            const details = [];
            details.push(lastStatus.charging ? 'בטעינה' : 'לא בטעינה');

            const readingTime = Number(lastStatus.time);
            if (Number.isFinite(readingTime) && readingTime > 0) {
                details.push(`עודכן בשעה ${new Date(readingTime).toLocaleTimeString('he-IL', {hour: '2-digit', minute: '2-digit'})}`);
            }

            batteryBox.appendChild(makeElement('div', 'battery-meta', details.join(' · ')));
        } else {
            batteryBox.appendChild(makeElement('div', 'battery-meta', 'הנתון יופיע לאחר בדיקת חיבור מוצלחת.'));
        }

        panel.appendChild(batteryBox);

        const input = makeElement('input');
        input.id = 'pw';
        input.type = 'password';
        input.autocomplete = 'current-password';
        input.placeholder = hasPassword
            ? 'סיסמת ניהול (ריק = שימוש בסיסמה השמורה)'
            : 'סיסמת ניהול של הנתב';
        input.disabled = status === 'CHECKING';
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !save.disabled) submitPassword();
        });
        panel.appendChild(input);

        if (hasPassword) {
            panel.appendChild(makeElement('div', 'hint', 'השאר את השדה ריק כדי להשתמש בסיסמה השמורה.'));
        }

        const actions = makeElement('div', 'actions');
        const save = makeElement('button', '', 'שמור');
        save.id = 'save';
        save.type = 'button';
        save.disabled = status === 'CHECKING';
        save.addEventListener('click', submitPassword);
        actions.appendChild(save);

        if (hasPassword) {
            const refresh = makeElement('button', '', 'רענן סוללה');
            refresh.id = 'refresh';
            refresh.type = 'button';
            refresh.disabled = status === 'CHECKING';
            refresh.title = 'בדיקת סוללה חדשה מול הנתב';
            refresh.addEventListener('click', runImmediateConnectionCheck);
            actions.appendChild(refresh);
        }

        panel.appendChild(actions);

        panel.appendChild(makeElement('div', 'hint', 'הסיסמה נשמרת באחסון המקומי של Tampermonkey. הסקריפט אינו מצפין אותה בעצמו.'));

        const project = makeElement('a', 'project', 'פרויקט GitHub');
        project.href = 'https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert';
        project.target = '_blank';
        project.rel = 'noopener noreferrer';
        project.setAttribute('aria-label', 'פתיחת פרויקט התראת סוללה ב-GitHub');
        panel.appendChild(project);

        overlay.addEventListener('click', event => {
            if (event.target === overlay) removePasswordPanel();
        });

        overlay.appendChild(panel);
        pwShadow.replaceChildren(style, overlay);

        if (!input.disabled) input.focus();
    }

    function showPasswordPanel(request = null) {
        if (!IS_ROUTER_PAGE) return;

        if (pwLauncherHost) {
            pwLauncherHost.remove();
            pwLauncherHost = null;
            pwLauncherShadow = null;
        }

        if (!pwHost) {
            pwHost = document.createElement('div');
            pwHost.id = 'tplink-mifi-password-host';
            pwHost.style.cssText =
                'all:initial;position:fixed;inset:0;z-index:2147483647;';
            pwShadow = pwHost.attachShadow({mode: 'closed'});
            (document.documentElement || document.body).appendChild(pwHost);
        }

        renderPasswordPanel(request);
    }

    function showRouterSwitchPrompt() {
        const isCandidateNow = Boolean(
            SAVED_ROUTER_ORIGIN &&
            location.origin !== SAVED_ROUTER_ORIGIN &&
            isPotentialMiFiManagementPage()
        );
        if (!isCandidateNow || routerSwitchHost) return;

        // A newly detected candidate page is also a management UI: pause API
        // traffic until the user either switches or closes this tab.
        if (!IS_ROUTER_UI_PAGE) {
            updateRouterPresence(true);
            const beat = () => updateRouterPresence(true);
            const timer = setInterval(beat, ROUTER_PRESENCE_INTERVAL);
            window.addEventListener('pagehide', () => {
                clearInterval(timer);
                updateRouterPresence(false);
            }, {once: true});
        }

        routerSwitchHost = document.createElement('div');
        routerSwitchHost.id = 'tplink-mifi-switch-host';
        routerSwitchHost.style.cssText =
            'all:initial;position:fixed;z-index:2147483647;top:18px;left:50%;transform:translateX(-50%);';
        routerSwitchShadow = routerSwitchHost.attachShadow({mode: 'closed'});

        const style = makeElement('style');
        style.textContent =
            '*{box-sizing:border-box}' +
            '.panel{direction:rtl;width:min(390px,calc(100vw - 36px));font:14px Arial,sans-serif;background:#fff;color:#202124;border:1px solid #dadce0;border-top:5px solid #b06000;border-radius:12px;box-shadow:0 8px 28px #0003;padding:16px}' +
            '.head{font-size:16px;font-weight:700;margin-bottom:8px}' +
            '.msg{line-height:1.55;color:#333;margin-bottom:13px}' +
            '.buttons{display:flex;gap:8px;flex-wrap:wrap}' +
            'button{font:600 13px Arial;border:0;border-radius:7px;padding:9px 12px;cursor:pointer}' +
            '#switch{background:#b06000;color:#fff}' +
            '#cancel{background:#e8eaed;color:#202124}';

        const panel = makeElement('div', 'panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-live', 'polite');
        panel.appendChild(makeElement('div', 'head', 'זוהה נתב בכתובת אחרת'));
        panel.appendChild(makeElement(
            'div',
            'msg',
            'נמצא נתב בכתובת אחרת. האם להגדיר אותו במקום הנתב הנוכחי? פעולה זו תחליף את סיסמת הניהול ותאפס את היסטוריית הסוללה וההתראות.'
        ));

        const buttons = makeElement('div', 'buttons');
        const switchButton = makeElement('button', '', 'הגדר נתב זה');
        switchButton.id = 'switch';
        switchButton.addEventListener('click', () => {
            resetBatteryState();
            const keysToClear = [
                K.password, K.routerFingerprint, K.connectionState, K.connectionResultSeen, K.setupPromptSeen,
                K.passwordTicket, K.passwordRequest, K.lastPasswordRequest,
                K.lock, K.lastError, K.focusAt
            ];
            keysToClear.forEach(key => GM_deleteValue(key));

            // Hold polling tabs while the new origin is installed and reloaded.
            GM_setValue(K.routerPresence, {__switching: Date.now()});
            saveRouterOrigin(location.origin);
            location.reload();
        });
        buttons.appendChild(switchButton);

        const cancelButton = makeElement('button', '', 'לא עכשיו');
        cancelButton.id = 'cancel';
        cancelButton.addEventListener('click', () => {
            routerSwitchHost.remove();
            routerSwitchHost = null;
            routerSwitchShadow = null;
        });
        buttons.appendChild(cancelButton);
        panel.appendChild(buttons);

        routerSwitchShadow.replaceChildren(style, panel);
        (document.documentElement || document.body).appendChild(routerSwitchHost);
    }

    function watchForDelayedMiFiIdentification() {
        if (IS_ROUTER_UI_PAGE || location.protocol !== 'http:' ||
            !isAllowedRouterHost(location.hostname) ||
            typeof MutationObserver !== 'function') return;

        let scanTimer = null;

        const observer = new MutationObserver(() => {
            // Coalesce frequent DOM updates; avoid repeatedly forcing innerText layout.
            if (scanTimer !== null) return;

            scanTimer = setTimeout(() => {
                scanTimer = null;
                if (!isPotentialMiFiManagementPage()) return;

                observer.disconnect();

                if (SAVED_ROUTER_ORIGIN) {
                    // A different MiFi origin needs explicit user confirmation.
                    showRouterSwitchPrompt();
                    return;
                }

                // First-time detection: reserve presence before publishing the
                // router origin, then reload so the page initializes as a router UI.
                GM_setValue(K.routerPresence, {__opening: Date.now()});
                resetBatteryState();
                GM_setValue(K.routerFingerprint, '');
                GM_setValue(K.connectionState, null);
                GM_setValue(K.connectionResultSeen, false);
                GM_setValue(K.setupPromptSeen, false);
                saveRouterOrigin(location.origin);
                location.reload();
            }, 500);
        });

        if (document.documentElement) {
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                characterData: true
            });
            setTimeout(() => {
                observer.disconnect();
                if (scanTimer !== null) {
                    clearTimeout(scanTimer);
                    scanTimer = null;
                }
            }, 30000);
        }
    }

    function initializeRouterStorage() {
        if (!IS_ROUTER_PAGE) return;

        const stored = normalizeRouterOrigin(GM_getValue(K.routerBase, ''));
        if (stored) {
            if (stored !== GM_getValue(K.routerBase, '')) saveRouterOrigin(stored);
            return;
        }

        // First-time router discovery starts with a clean battery history.
        resetBatteryState();
        GM_setValue(K.routerFingerprint, '');
        GM_setValue(K.connectionState, null);
        GM_setValue(K.connectionResultSeen, false);
        GM_setValue(K.setupPromptSeen, false);
        saveRouterOrigin(location.origin);
    }

    function initRouterPage({showPanel = IS_ROUTER_PAGE} = {}) {
        const beat = () => {
            updateRouterPresence(true);
            recoverAbandonedConnectionCheck();
            markFocused();
        };

        beat();
        setInterval(beat, ROUTER_PRESENCE_INTERVAL);
        window.addEventListener('pageshow', beat);

        window.addEventListener('pagehide', () => {
            const state = GM_getValue(K.connectionState, null);
            if (state && state.status === 'CHECKING' && state.owner === INSTANCE_ID) {
                GM_setValue(K.connectionState, null);
                GM_setValue(K.setupPromptSeen, false);
            }
            updateRouterPresence(false);
            clearFocused();
        });

        if (!showPanel) return;

        const request = GM_getValue(K.passwordRequest, null);
        const requestIsFresh = request &&
            Number(request.time) > Date.now() - PASSWORD_REQUEST_COOLDOWN;
        const connection = GM_getValue(K.connectionState, null);
        const setupPromptSeen = Boolean(GM_getValue(K.setupPromptSeen, false));
        const hasUnseenResult = Boolean(
            connection &&
            ['CONNECTED', 'FAILED'].includes(connection.status) &&
            !GM_getValue(K.connectionResultSeen, false)
        );

        if (!setupPromptSeen || requestIsFresh || hasUnseenResult) {
            GM_setValue(K.setupPromptSeen, true);
            if (hasUnseenResult) GM_setValue(K.connectionResultSeen, true);
            showPasswordPanel(request);
        } else {
            createPasswordPanelLauncher();
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

        panel.appendChild(makeElement(
            'div',
            'eta',
            urgent
                ? 'סוללת הנתב הנייד עומדת להתרוקן. חבר אותו למטען בהקדם!'
                : 'סוללת הנתב הנייד חלשה. מומלץ לחבר אותו למטען.'
        ));

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
            toastHost.id = 'tplink-mifi-battery-alert-host';

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
                ? 'התראת סוללה דחופה'
                : 'התראת סוללה';

            const instruction = stage >= 2
                ? `סוללת הנתב הנייד עומדת להתרוקן (${level}%). חבר אותו למטען בהקדם!`
                : `סוללת הנתב הנייד חלשה (${level}%). מומלץ לחבר אותו למטען.`;
            const etaLine = etaSentence(level, eta);
            const body = etaLine ? `${instruction}\n${etaLine}` : instruction;

            notify(title, body, {
                tag: 'tplink-mifi-battery-alert',
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
            markProtocolMismatch(status, 'הנתב לא החזיר אחוז סוללה תקין בשדה battery.voltage.');
            throw new ProtocolMismatchError('הנתב הגיב, אך נתוני הסוללה אינם במבנה המוכר.');
        }

        const info = {
            level: Math.round(level),
            charging,
            connected,
            time: Date.now()
        };

        GM_setValue(K.lastStatus, info);

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

    function handleUnexpectedError(error) {
        const now = Date.now();
        const previous = Number(GM_getValue(K.lastError, 0));

        console.warn(
            '[התראת סוללה] שגיאה בעדכון מצב הסוללה:',
            error && error.name ? error.name : 'Error',
            error && error.message ? error.message : String(error)
        );

        if (now - previous > 15 * 60 * 1000) {
            GM_setValue(K.lastError, now);
            notify(
                'התראת סוללה',
                'לא ניתן לעדכן את מצב הסוללה של הנתב הנייד. בדוק את החיבור ונסה שוב.'
            );
        }
    }

    function handlePollError(error) {
        if (error instanceof ProtocolMismatchError) {
            markProtocolMismatch(null, error.message || 'מבנה תשובה לא מוכר');
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
            handleUnexpectedError(error);
        }

        return NORMAL_INTERVAL;
    }

    async function poll() {
        if (IS_ROUTER_UI_PAGE || isRouterManagementPageOpen()) {
            pauseForRouterUi();
            return;
        }

        if (!GM_getValue(K.routerBase, '')) {
            loseLeadership();
            return;
        }

        if (!isLeader || pollInProgress || connectionCheckInProgress || !ownsLock()) return;

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

    function pauseForRouterUi() {
        // Release our lease so monitoring can resume promptly after the
        // router management tab closes instead of waiting for LOCK_TTL.
        if (ownsLock()) GM_deleteValue(K.lock);
        loseLeadership();
    }

    async function heartbeat() {
        if (IS_ROUTER_UI_PAGE) {
            loseLeadership();
            return;
        }

        if (!GM_getValue(K.routerBase, '')) {
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

            // The router firmware may support only one management session.
            // The one-time connection test is performed inside the router tab;
            // background polling remains paused until the UI has been closed.
            if (routerUiOpen) {
                pauseForRouterUi();
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
                pauseForRouterUi();
                return;
            }

            isLeader = true;


            if (!wasLeader || gap > RESUME_GAP) {
                pollNow();
            } else if (!pollTimer && !pollInProgress) {
                poll();
            }
        } finally {
            heartbeatInProgress = false;
        }
    }

    // ======================== בדיקה עצמית להצפנה ========================
    function runCryptoSelfTests() {
        const hexToBytes = hex => Uint8Array.from(
            hex.match(/../g) || [],
            pair => parseInt(pair, 16)
        );
        const toHex = bytes => Array.from(
            bytes,
            value => value.toString(16).padStart(2, '0')
        ).join('');

        try {
            const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
            const plaintext = hexToBytes('00112233445566778899aabbccddeeff');
            const expectedCiphertext = hexToBytes('69c4e0d86a7b0430d8cdb78070b4c55a');
            const expandedKey = aesExpandKey(key);
            const encrypted = aesEncryptBlock(plaintext, expandedKey);
            const decrypted = aesDecryptBlock(expectedCiphertext, expandedKey);

            const passed =
                AES_SBOX.length === 256 &&
                AES_INV_SBOX.length === 256 &&
                toHex(encrypted) === '69c4e0d86a7b0430d8cdb78070b4c55a' &&
                toHex(decrypted) === '00112233445566778899aabbccddeeff' &&
                md5Hex('') === 'd41d8cd98f00b204e9800998ecf8427e';

            if (!passed) {
                console.error('[התראת סוללה] בדיקת האבטחה העצמית נכשלה. הניטור לא יופעל.');
            }
            return passed;
        } catch (error) {
            console.error('[התראת סוללה] שגיאה בבדיקה העצמית של מנגנון ההצפנה. הניטור לא יופעל:', error);
            return false;
        }
    }

    // Validate AES and MD5 before the script can contact the router.
    if (!runCryptoSelfTests()) return;

    if (
        typeof crypto === 'undefined' ||
        typeof crypto.getRandomValues !== 'function' ||
        typeof BigInt !== 'function'
    ) {
        console.error('[התראת סוללה] הדפדפן אינו תומך ברכיבי ההצפנה הנדרשים. הניטור לא יופעל.');
        return;
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
        if (IS_ROUTER_UI_PAGE || connectionCheckInProgress) return;
        if (isRouterManagementPageOpen()) {
            pauseForRouterUi();
        } else {
            heartbeat();
        }
    });

    GM_addValueChangeListener(K.routerBase, () => {
        if (IS_ROUTER_UI_PAGE) return;
        session = null;
        if (!GM_getValue(K.routerBase, '')) {
            loseLeadership();
            return;
        }
        heartbeat();
    });

    GM_addValueChangeListener(K.connectionState, (_key, oldState, newState) => {
        if (!IS_ROUTER_PAGE || !pwHost) return;

        const oldInput = pwShadow && pwShadow.getElementById('pw');
        const typedValue = oldInput ? oldInput.value : '';
        const hadFocus = oldInput === document.activeElement;
        renderPasswordPanel(GM_getValue(K.passwordRequest, null));

        const newInput = pwShadow && pwShadow.getElementById('pw');
        const stateNow = GM_getValue(K.connectionState, null);
        const isWaitingForCheck = stateNow && stateNow.status === 'CHECKING';
        if (newInput && typedValue && !isWaitingForCheck) {
            newInput.value = typedValue;
            if (hadFocus) newInput.focus();
        }
    });

    GM_addValueChangeListener(K.passwordTicket, () => {
        if (IS_ROUTER_UI_PAGE) return;
        session = null;

        if (isLeader && !isRouterManagementPageOpen()) pollNow();
    });

    GM_addValueChangeListener(
        K.passwordRequest,
        (_key, _oldValue, request) => {
            if (!IS_ROUTER_PAGE || !request) return;
            showPasswordPanel(request);
        }
    );

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            markFocused();
            syncAlert();
            if (!IS_ROUTER_UI_PAGE) heartbeat();
        } else {
            clearFocused();
            hideToast();
        }
    });

    window.addEventListener('focus', () => {
        markFocused();
        syncAlert();
        if (!IS_ROUTER_UI_PAGE) heartbeat();
    });

    window.addEventListener('blur', () => {
        clearFocused();
        hideToast();
    });

    window.addEventListener('pagehide', () => {
        clearFocused();
        if (ownsLock()) GM_deleteValue(K.lock);
    });

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

    initializeRouterStorage();

    if (IS_ROUTER_UI_PAGE) {
        initRouterPage({showPanel: IS_ROUTER_PAGE});
    } else {
        launchInitialRouterSetup();
    }

    if (IS_ROUTER_SWITCH_CANDIDATE) {
        showRouterSwitchPrompt();
    } else {
        watchForDelayedMiFiIdentification();
    }

    if (!IS_ROUTER_UI_PAGE) {
        setTimeout(heartbeat, startupDelay);
        setInterval(heartbeat, HEARTBEAT_INTERVAL);
    }
})();
