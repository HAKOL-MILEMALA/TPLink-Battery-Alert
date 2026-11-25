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

For first-time setup, open the router's local HTTP management page once so the script can save its local address. Keep Chrome open with at least one HTTPS tab while monitoring. The script requires a broad Tampermonkey `@connect *` grant for varying local router addresses, but validates that the selected target is a private IP address or a known TP-Link local hostname before making requests.

The script uses Tampermonkey `@updateURL` and `@downloadURL` metadata for automatic update checks.

See [README_HE.md](README_HE.md) for the full setup guide and [SUPPORTED_ROUTERS.md](SUPPORTED_ROUTERS.md) for current evidence.
