// ==UserScript==
// @name         התראת סוללה ל-TP-Link M7200
// @namespace    HAKOL-MILEMALA
// @version      1.4.3
// @description  ניטור סוללת M7200 עם התראות קצרות, נודניק אוטומטי והערכת זמן לכיבוי
// @author       HAKOL-MILEMALA
// @homepageURL  https://github.com/HAKOL-MILEMALA/M7200CarAlert
// @supportURL   https://github.com/HAKOL-MILEMALA/M7200CarAlert/issues
// @downloadURL  https://raw.githubusercontent.com/HAKOL-MILEMALA/M7200CarAlert/main/M7200-Battery-Alert.user.js
// @updateURL    https://raw.githubusercontent.com/HAKOL-MILEMALA/M7200CarAlert/main/M7200-Battery-Alert.user.js
// @match        https://*/*
// @match        http://192.168.0.1/*
// @connect      192.168.0.1
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

(() => {
    'use strict';

    // ======================== הגדרות ========================
    const ROUTER = 'http://192.168.0.1';
    const IS_ROUTER_PAGE = location.origin === ROUTER;

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
    const ROUTER_TAB_ABSENT_AFTER = 90 * 1000;

    const K = {
        password: 'm7200_password',
        passwordTicket: 'm7200_password_ticket',
        passwordRequest: 'm7200_password_request',
        lastPasswordRequest: 'm7200_last_password_request',
        routerPresence: 'm7200_router_presence',
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

    const INSTANCE_ID = \`${Date.now()}-${Math.random().toString(36).slice(2)}\`;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    class NetworkError extends Error {}
    class AuthError extends Error {}
    class PasswordError extends Error {}

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

        throw new Error('תשובת הנתב אינה בפורמט הצפוי');
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
            GM_xmlhttpRequest({
                method: 'POST',
                url: \`${ROUTER}/cgi-bin/${endpoint}\`,
                headers: {
                    'Content-Type': 'application/json',
                    'Referer': \`${ROUTER}/\`,
                    'Origin': ROUTER,
                    'User-Agent': 'okhttp/3.11.0'
                },
                data: JSON.stringify(payload),
                timeout: 12000,

                onload: response => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        reject(new NetworkError(\`הנתב החזיר HTTP ${response.status}\`));
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
            ? \`key=${activeSession.key}&iv=${activeSession.iv}&h=${activeSession.hash}&s=${sequence}\`
            : \`h=${activeSession.hash}&s=${sequence}\`;

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
            throw new Error('הנתב לא החזיר פרטי התחברות תקינים');
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

    // ======================== הזנת סיסמה בדף הנתב ========================
    function openRouterTab() {
        try {
            GM_openInTab(\`${ROUTER}/\`, {
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

        const last = Number(GM_getValue(K.lastPasswordRequest, 0));

        if (now - last < PASSWORD_REQUEST_COOLDOWN) return;

        GM_setValue(K.lastPasswordRequest, now);

        notify(
            'M7200 – נדרשת סיסמת ניהול',
            'פתח את דף הנתב כדי להזין אותה.',
            {
                timeout: 20000,
                onclick: openRouterTab
            }
        );

        const presence = Number(GM_getValue(K.routerPresence, 0));

        if (now - presence > ROUTER_TAB_ABSENT_AFTER) {
            openRouterTab();
        }
    }

    function removePasswordPanel() {
        clearTimeout(pwTimeout);
        pwChecking = false;

        if (pwHost) pwHost.remove();

        pwHost = null;
        pwShadow = null;
    }

    function submitPassword() {
        if (!pwShadow) return;

        const input = pwShadow.getElementById('pw');
        const value = input.value;

        if (!value) {
            input.focus();
            return;
        }

        pwChecking = true;
        GM_setValue(K.password, value);
        GM_setValue(K.passwordTicket, Date.now());

        renderPasswordPanel('checking');

        clearTimeout(pwTimeout);

        pwTimeout = setTimeout(() => {
            if (pwChecking) {
                pwChecking = false;
                renderPasswordPanel('saved');
            }
        }, 30000);
    }

    // נבנה באמצעות createElement ו-textContent, ללא innerHTML.
    function renderPasswordPanel(status, request = null, failedNow = false) {
        if (!pwShadow) return;

        const reason = request && request.reason;
        let message;
        let accent = '#1967d2';

        if (status === 'checking') {
            message = 'שומר ובודק התחברות לנתב...';
        } else if (status === 'ok') {
            message = '✔ ההתחברות הצליחה. הניטור פעיל.';
            accent = '#188038';
        } else if (status === 'saved') {
            message = 'הסיסמה נשמרה. הבדיקה תתבצע כשתהיה לשונית HTTPS פעילה ואתה מחובר לרשת הנתב.';
        } else if (failedNow) {
            message = 'הנתב דחה את הסיסמה. נסה שוב.';
            accent = '#c5221f';
        } else if (reason === 'rejected') {
            message = 'הנתב דחה את הסיסמה השמורה. הזן את הסיסמה הנכונה.';
            accent = '#c5221f';
        } else {
            message = 'הזן את סיסמת הניהול של הנתב כדי להפעיל את הניטור.';
        }

        const showForm = status === 'ask' || status === 'saved';

        const style = makeElement('style');
        style.textContent = \`
            *{box-sizing:border-box}
            .panel{direction:rtl;width:min(380px,calc(100vw - 36px));font:14px Arial,sans-serif;background:#fff;color:#202124;border:1px solid #dadce0;border-top:5px solid ${accent};border-radius:12px;box-shadow:0 8px 28px #0003;padding:16px}
            .head{font-size:16px;font-weight:700;margin-bottom:8px}
            .msg{line-height:1.5;color:#444;margin-bottom:12px}
            .hint{font-size:12px;line-height:1.5;color:#5f6368;margin:10px 0 0}
            input{width:100%;font:15px Arial,sans-serif;padding:9px 10px;border:1px solid #bdc1c6;border-radius:7px;margin-bottom:10px;direction:ltr}
            .row{display:flex;gap:8px}
            button{font:600 13px Arial;border:0;border-radius:7px;padding:9px 14px;cursor:pointer}
            #save{background:#1967d2;color:#fff}
            #close{background:#e8eaed;color:#202124}
        \`;

        const panel = makeElement('div', 'panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-live', 'polite');

        panel.appendChild(makeElement(
            'div',
            'head',
            '🔑 ניטור סוללת M7200'
        ));

        panel.appendChild(makeElement('div', 'msg', message));

        if (showForm) {
            const input = makeElement('input');
            input.id = 'pw';
            input.type = 'password';
            input.autocomplete = 'current-password';
            input.placeholder = 'סיסמת ניהול של הנתב';
            panel.appendChild(input);

            const row = makeElement('div', 'row');

            const save = makeElement('button', '', 'שמירה');
            save.id = 'save';

            const close = makeElement('button', '', 'סגור');
            close.id = 'close';

            row.append(save, close);
            panel.appendChild(row);

            panel.appendChild(makeElement(
                'div',
                'hint',
                'הסיסמה נשמרת באחסון של Tampermonkey. הסקריפט אינו מצפין אותה בעצמו, והיא אינה נשלחת לשירות חיצוני.'
            ));
        }

        pwShadow.replaceChildren(style, panel);

        if (showForm) {
            const input = pwShadow.getElementById('pw');

            pwShadow.getElementById('save').addEventListener(
                'click',
                submitPassword
            );

            pwShadow.getElementById('close').addEventListener(
                'click',
                removePasswordPanel
            );

            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') submitPassword();
            });

            input.focus();
        }
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

        renderPasswordPanel('ask', request, failedNow);
    }

    function initRouterPage() {
        const beat = () => {
            GM_setValue(K.routerPresence, Date.now());
            markFocused();
        };

        beat();
        setInterval(beat, 5000);

        window.addEventListener('pagehide', () => {
            GM_setValue(K.routerPresence, 0);
        });

        const request = GM_getValue(K.passwordRequest, null);

        if (request) showPasswordPanel(request);
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

        return \`כ-${Math.max(1, Math.round(minutes))} דקות\`;
    }

    function etaSentence(level, minutes) {
        if (Number(level) <= SHUTDOWN_LEVEL) {
            return 'הנתב עלול להיכבות בכל רגע';
        }

        const estimate = formatEta(minutes);

        return estimate ? \`זמן משוער לכיבוי: ${estimate}\` : '';
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

        style.textContent = \`
            *{box-sizing:border-box}
            .panel{direction:rtl;width:min(340px,calc(100vw - 36px));font:14px Arial,sans-serif;background:#fff;color:#202124;border:1px solid #dadce0;border-top:5px solid ${urgent ? '#c5221f' : '#e37400'};border-radius:12px;box-shadow:0 8px 28px #0003;padding:15px}
            .head{font-size:16px;font-weight:700;margin-bottom:7px}
            .pct{font-size:30px;font-weight:800;color:${urgent ? '#c5221f' : '#b06000'};margin:4px 0}
            .eta{font-size:13px;font-weight:600;line-height:1.45;background:#f1f3f4;border-radius:7px;padding:7px 9px;margin:7px 0 11px}
            button{font:600 13px Arial;border:0;border-radius:7px;padding:9px 15px;background:#1967d2;color:white;cursor:pointer}
        \`;

        const panel = makeElement('div', 'panel');

        panel.setAttribute('role', 'alertdialog');
        panel.setAttribute('aria-live', 'assertive');

        panel.appendChild(makeElement(
            'div',
            'head',
            urgent ? '🚨 התראת סוללה דחופה' : '🔋 התראת סוללה'
        ));

        panel.appendChild(makeElement('div', 'pct', \`${level}%\`));

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
            id: \`${now}-${Math.random().toString(36).slice(2)}\`,
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
                ? \`🚨 M7200 – סוללה דחופה (${level}%)\`
                : \`🔋 M7200 – סוללה חלשה (${level}%)\`;

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
            throw new Error('הנתב לא החזיר אחוז סוללה תקין');
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
        if (!isLeader || pollInProgress || !ownsLock()) return;

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
        if (heartbeatInProgress) return;

        heartbeatInProgress = true;

        const now = Date.now();
        const gap = now - lastBeat;
        lastBeat = now;

        try {
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
                    \`${INSTANCE_ID}-${Date.now()}-${Math.random().toString(36).slice(2)}\`;

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

    GM_addValueChangeListener(K.passwordTicket, () => {
        if (!isLeader) return;

        session = null;
        pollNow();
    });

    GM_addValueChangeListener(
        K.passwordRequest,
        (_key, _oldValue, request) => {
            if (!IS_ROUTER_PAGE) return;

            const wasChecking = pwChecking;

            if (!request) {
                if (pwHost && wasChecking) {
                    pwChecking = false;
                    renderPasswordPanel('ok');
                    setTimeout(removePasswordPanel, 2500);
                } else {
                    removePasswordPanel();
                }

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
            heartbeat();
        } else {
            clearFocused();
            hideToast();
        }
    });

    window.addEventListener('focus', () => {
        markFocused();
        syncAlert();
        heartbeat();
    });

    window.addEventListener('blur', () => {
        clearFocused();
        hideToast();
    });

    window.addEventListener('pagehide', clearFocused);

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

    setTimeout(heartbeat, startupDelay);
    setInterval(heartbeat, HEARTBEAT_INTERVAL);
})();
