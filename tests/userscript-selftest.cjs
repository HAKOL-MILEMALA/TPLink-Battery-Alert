'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {TextEncoder, TextDecoder} = require('node:util');

const scriptPath = path.resolve(__dirname, '..', 'TP-Link-MiFi-Battery-Alert.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const storage = new Map([['tplink_mifi_router_base', 'http://192.168.0.1']]);
const errors = [];
const routerRequests = [];

const context = {
    console: {
        log: (...args) => process.stdout.write(args.join(' ') + '\n'),
        warn: (...args) => process.stdout.write('[warn] ' + args.join(' ') + '\n'),
        error: (...args) => errors.push(args.map(String).join(' '))
    },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    location: {
        protocol: 'https:',
        hostname: 'example.com',
        origin: 'https://example.com'
    },
    document: {
        visibilityState: 'visible',
        hasFocus: () => false,
        addEventListener: () => {},
        documentElement: {},
        body: {}
    },
    window: {addEventListener: () => {}, focus: () => {}},
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => storage.set(key, value),
    GM_deleteValue: key => storage.delete(key),
    GM_addValueChangeListener: () => 1,
    GM_notification: () => {},
    GM_openInTab: () => {},
    GM_xmlhttpRequest: options => {
        routerRequests.push(options && options.url);
        throw new Error('Unexpected router request during startup/self-test');
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary')
};

vm.runInNewContext(source, context, {filename: 'TP-Link-MiFi-Battery-Alert.user.js'});

if (errors.length) {
    throw new Error('Userscript reported a startup/self-test error:\n' + errors.join('\n'));
}
if (routerRequests.length) {
    throw new Error('Userscript contacted the router before an explicit monitoring check.');
}

process.stdout.write('PASS: userscript loaded; built-in AES/MD5 self-tests passed; no router request was made at startup.\n');
