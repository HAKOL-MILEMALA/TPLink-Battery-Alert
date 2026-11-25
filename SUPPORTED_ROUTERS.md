# TP-Link MiFi – Router compatibility

This list distinguishes protocol evidence from live validation with this Android app. A model is not considered fully validated merely because TP-Link manufactures it or because the official tpMiFi application supports it.

## Status definitions

- **Live success required:** The Android app successfully logs in and reads a valid battery percentage on the exact hardware/firmware combination.
- **External protocol evidence:** An independent implementation has probed the same protocol, but this Android app has not yet been verified on that exact router.
- **Candidate / unverified:** There is evidence of a TP-Link MiFi management interface, but no reliable evidence yet that it uses the protocol implemented here.

| Model / revision | Current evidence | Status in this app |
| --- | --- | --- |
| M7200 | Original target of this project's implementation; still verify the exact device using the in-app test | Baseline; confirm by live test |
| M7000 | An independent MiFi monitor project documents M7000 as expected to use the same web API family as M7200/M7350 | External evidence; live test required |
| M7350 EU V9.0, firmware 9.0.5 | Independently probed by the TP-Link MiFi Battery Monitor project; it documents the same auth_cgi/web_cgi API and battery response | External protocol evidence; live test required in this Android app |
| M7300 | Included in TP-Link's official tpMiFi compatibility list; protocol for this app not confirmed | Candidate / unverified |
| M7310 | Included in TP-Link's official tpMiFi compatibility list; protocol for this app not confirmed | Candidate / unverified |
| M7450 | Included in TP-Link's official tpMiFi compatibility list; protocol for this app not confirmed | Candidate / unverified |
| M7650 | Included in TP-Link's official tpMiFi compatibility list; protocol for this app not confirmed | Candidate / unverified |
| M7400, M7750, M8550 | TP-Link documents web management for these MiFi models, but that alone does not establish this app's CGI protocol compatibility | Candidate / unverified |

## Technical basis

The current client uses the local JSON API endpoints `/cgi-bin/auth_cgi` and `/cgi-bin/web_cgi`, including the authenticator challenge/login flow and the encrypted `status` action. A successful compatibility test requires the app to log in and receive a valid `battery.voltage` value between 0 and 100.

The status response may also expose `deviceInfo.model`, `deviceInfo.firmwareVersion` or `deviceInfo.firmwareVer`. Hardware revision is not guaranteed to be returned by all firmware versions; when absent, the app shows that it was not reported rather than guessing.

## Sources

- [TP-Link tpMiFi on Google Play – official supported models](https://play.google.com/store/apps/details?id=com.tplink.tpmifi)
- [TP-Link FAQ – Mobile Wi-Fi web-management models](https://www.tp-link.com/us/support/faq/1647/)
- [Independent protocol documentation – tested on M7350 EU V9.0 / firmware 9.0.5](https://github.com/gioelerosana/tplink-battery-monitor/blob/main/docs/protocol.md)
- [Independent TP-Link MiFi monitor – tested on M7350 V9 and notes M7000/M7200 API family](https://github.com/gioelerosana/tplink-battery-monitor)

## Adding a model

1. Run the in-app live compatibility test on the device.
2. Submit the pre-filled compatibility report from the app.
3. Review the report and, when possible, reproduce the test on the same hardware/firmware revision.
4. Update this file only after the evidence supports the new status.

The app never uploads router credentials or device identifiers as part of a compatibility report.
