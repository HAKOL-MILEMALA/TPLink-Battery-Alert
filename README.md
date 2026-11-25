# TP-Link MiFi Battery Alert

Android app for monitoring TP-Link mobile Wi-Fi router battery level and notifying when it reaches 10% or below.

## Android app

- [Download latest APK](https://github.com/HAKOL-MILEMALA/M7200CarAlert/releases/latest/download/M7200-Car-Alert.apk)
- [Hebrew documentation](README_HE.md)
- [Router compatibility evidence and status](SUPPORTED_ROUTERS.md)
- [GitHub releases](https://github.com/HAKOL-MILEMALA/M7200CarAlert/releases)

The app performs a live, read-only compatibility check against the connected router. It reports a device as supported only after it successfully reads a valid battery percentage. Compatibility reports open a pre-filled GitHub issue draft; the user must review and submit it.

## Browser userscript (TP-Link M7200)

For desktop Chrome, the repository also provides a Tampermonkey userscript dedicated to the TP-Link M7200:

- [Install Tampermonkey for Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- [Install M7200 Battery Alert userscript](https://raw.githubusercontent.com/HAKOL-MILEMALA/M7200CarAlert/main/M7200-Battery-Alert.user.js)

The userscript warns at 15% battery and raises an urgent alert at 10%. It estimates time to a 5% safety threshold when enough history is available, and supports manual and automatic snoozing.

The computer must be connected to the M7200 Wi-Fi. Keep Chrome open with at least one HTTPS tab open; the router's HTTP page is used for entering the router password. The script includes Tampermonkey `@updateURL` and `@downloadURL` metadata for update checks.

See the [Hebrew documentation](README_HE.md) for setup details and limitations.
