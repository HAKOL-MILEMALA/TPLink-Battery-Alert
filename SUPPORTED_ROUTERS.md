# TP-Link MiFi – Router compatibility

This list distinguishes protocol evidence from live validation with the Android app or browser userscript. A model is not considered fully validated merely because TP-Link manufactures it or because the official tpMiFi application supports it.

## Status definitions

- **Live success required:** The Android app or browser userscript successfully logs in and reads a valid battery percentage on the exact hardware/firmware combination.
- **External protocol evidence:** An independent implementation has probed the same protocol, but the Android app or browser userscript has not yet been verified on that exact router.
- **Candidate / unverified:** There is evidence of a TP-Link MiFi management interface, but no reliable evidence yet that it uses the protocol implemented here.

| Model / revision | Current evidence | Project status |
| --- | --- | --- |
| M7200 | Original target of this project's implementation; still verify the exact device using the in-app test | Baseline; confirm by live test |
| M7000 | The independent mt-ks API client reports tests with both M7000 and M7200; another MiFi monitor project also identifies this API family | External protocol evidence; live test still required in this project |
| M7350 EU V9.0, firmware 9.0.5 | Independently probed by the TP-Link MiFi Battery Monitor project; it documents the same auth_cgi/web_cgi API and battery response | External protocol evidence; live test required in the Android app or browser userscript |
| M7010 | Listed in TP-Link's official tpMiFi compatibility list in the App Store; the exact API used by this project is not confirmed | Candidate / unverified |
| M7300 | Included in TP-Link's official tpMiFi compatibility list; protocol for this project not confirmed | Candidate / unverified |
| M7310 | Included in TP-Link's official tpMiFi compatibility list; protocol for this app not confirmed | Candidate / unverified |
| M7450 | Included in TP-Link's official tpMiFi compatibility list; protocol for this app not confirmed | Candidate / unverified |
| M7650 | Included in TP-Link's official tpMiFi compatibility list; protocol for this app not confirmed | Candidate / unverified |
| M7400, M7750, M8550 | TP-Link documents web management for these MiFi models, but that alone does not establish this app's CGI protocol compatibility | Candidate / unverified |

## Browser userscript status

The Tampermonkey client follows the same live-validation rule as the Android app. It can discover the current local management host when the user opens the router's TP-Link MiFi page, then tests the read-only login and battery-status API. A device is marked live-compatible only after a valid battery percentage is read. A report button can prepare a GitHub issue draft; reports require the user's manual review and submission.

The browser cannot reliably read the Wi-Fi default gateway, so the user must open the local router management page once. The script then stores that local host in Tampermonkey storage.

## Technical basis

The current client uses the local JSON API endpoints `/cgi-bin/auth_cgi` and `/cgi-bin/web_cgi`, including the authenticator challenge/login flow and the encrypted `status` action. A successful compatibility test requires the app to log in and receive a valid `battery.voltage` value between 0 and 100.

The status response may also expose `deviceInfo.model`, `deviceInfo.firmwareVersion` or `deviceInfo.firmwareVer`. Hardware revision is not guaranteed to be returned by all firmware versions; when absent, the app shows that it was not reported rather than guessing.

## Sources

- [TP-Link tpMiFi on Google Play – official supported models](https://play.google.com/store/apps/details?id=com.tplink.tpmifi)
- [TP-Link tpMiFi on Apple App Store – official compatible model list, including M7010](https://apps.apple.com/us/app/tpmifi/id999189880)
- [Independent M7200/M7000 API client – mt-ks/tp-link-m7200-api](https://github.com/mt-ks/tp-link-m7200-api)
- [TP-Link FAQ – Mobile Wi-Fi web-management models](https://www.tp-link.com/us/support/faq/1647/)
- [Independent protocol documentation – tested on M7350 EU V9.0 / firmware 9.0.5](https://github.com/gioelerosana/tplink-battery-monitor/blob/main/docs/protocol.md)
- [Independent TP-Link MiFi monitor – tested on M7350 V9 and notes M7000/M7200 API family](https://github.com/gioelerosana/tplink-battery-monitor)

## Adding a model

1. Run the live compatibility test in the Android app or browser userscript.
2. Use the report button to open a pre-filled GitHub issue draft.
3. Review the report and submit it manually; it is never sent automatically.
4. Reproduce the test on the same hardware/firmware revision when possible.
5. Update this file only after the evidence supports the new status.

Neither client includes router credentials, local IP address, Wi-Fi network name, MAC address, or IMEI in the compatibility report.
