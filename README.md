# TP-Link Battery Alert

This repository provides two ways to monitor compatible TP-Link MiFi routers:

## Android app

- [Download latest APK](https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/releases/latest/download/M7200-Car-Alert.apk)
- [Hebrew documentation](README_HE.md)
- [Router compatibility evidence and status](SUPPORTED_ROUTERS.md)
- [Community compatibility reports](COMMUNITY_COMPATIBILITY.md)
- [GitHub releases](https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/releases)

The Android app performs a live, read-only compatibility check against the connected router. Router protocol support and Android notification delivery are tracked separately. Reports open a public, pre-filled GitHub issue draft after user confirmation; the user must sign in and submit it manually. GitHub Actions aggregates reports by exact model, hardware revision, firmware and distinct GitHub reporters.

## Browser userscript (Chrome + Tampermonkey)

- [Install Tampermonkey for Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- [Install TP-Link MiFi Battery Alert userscript](https://raw.githubusercontent.com/HAKOL-MILEMALA/TPLink-Battery-Alert/main/TP-Link-MiFi-Battery-Alert.user.js)

The userscript warns at 15% battery and raises an urgent alert at 10%. It estimates time to a 5% safety threshold when enough history is available, and supports manual and automatic snoozing.

The browser version performs a live compatibility check using the router's local API. It supports only devices that successfully complete the login flow and return a valid battery percentage; TP-Link branding or tpMiFi-app support alone is not enough to establish protocol compatibility. A report button opens a pre-filled GitHub issue draft for successful tests or protocol mismatches. Reports are never submitted automatically.

For first-time setup, open the router's local HTTP management page once so the script can save its local address. Keep Chrome open with at least one HTTPS tab while monitoring.

### Privacy and Tampermonkey's cross-origin permission prompt

Tampermonkey may ask permission before the userscript contacts a router address such as `http://192.168.0.1/cgi-bin/auth_cgi`. This is **not a GitHub data-collection warning**. The source URL is simply the HTTPS tab where the userscript is running (for example, GitHub or Gmail); the destination is the router on the local Wi-Fi network. The script uses the router's local `auth_cgi` endpoint to authenticate and `web_cgi` to read battery status.

The script declares several common router IPs and TP-Link local hostnames in `@connect`. The `@connect *` entry is a fallback for routers using other local IP addresses; it does not make the script send requests to every website. For an unlisted destination, Tampermonkey may still ask the user before the first request. The code itself validates that a router target is a private/link-local IPv4 address or one of the known TP-Link local hostnames before making a request. When prompted, **Always allow** applies to that specific host; there is no need to choose **Always allow all domains**.

The userscript stores the router address, battery history, alert state and router management password in Tampermonkey's local storage. The password is **not encrypted by the userscript itself**; it is used for router authentication and is not included in compatibility reports. The userscript code contains no analytics, tracking, or automatic upload of battery data to a remote server. Tampermonkey separately contacts GitHub for script updates. A compatibility report is opened only after the user clicks the report button; it is a pre-filled issue draft that the user must review and submit manually. It contains model/firmware information and the test result, but excludes the password, local IP address, Wi-Fi name, MAC address and IMEI.

### Using the router web interface

While a router management tab is open, automatic battery polling is paused. Some MiFi firmware allows only one management session, so background polling could otherwise disconnect the web UI while you change settings. Polling resumes automatically after you leave the router interface. An explicitly requested compatibility check made while the router UI is open is queued and runs once after the router UI closes.

After a router has been configured, only its exact saved origin is treated as the management interface. A different MiFi interface is not adopted automatically. If one is detected at another local address, the userscript asks for confirmation; choosing **Switch to this router** replaces the saved origin, clears the old router password and resets battery history and alerts. It does not silently erase credentials just because another local page looks like a TP-Link device.

The password/compatibility panel no longer opens on every router page visit or refresh. It appears for first-time setup or when credentials are needed. After closing it, a small **Battery settings** button remains in the lower-left corner of the router page and reopens the panel. From that panel you can also replace the saved router password; leave the field blank to test the existing password. The userscript does not add Tampermonkey menu commands.

The script uses Tampermonkey `@updateURL` and `@downloadURL` metadata for automatic update checks.

See [README_HE.md](README_HE.md) for the full setup guide and [SUPPORTED_ROUTERS.md](SUPPORTED_ROUTERS.md) for current evidence.
