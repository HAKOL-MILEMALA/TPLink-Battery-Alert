# Browser userscript for router battery monitoring

This userscript displays a mobile router's battery status, tracks battery drain, and shows alerts. It is separate from the Android app also hosted in this repository.

## Installation

1. Install and enable the **Tampermonkey** browser extension.
2. Open the [official userscript file](https://raw.githubusercontent.com/HAKOL-MILEMALA/TPLink-Battery-Alert/main/TP-Link-MiFi-Battery-Alert.user.js). Tampermonkey should display its installation page.
3. Confirm the installation.
4. Connect to the router's Wi-Fi and open its management interface, for example `http://tplinkmifi.net/` or the router's local IP address.
5. In the battery settings panel, enter the **router administrator password** — not necessarily the Wi-Fi password. After the connection check succeeds, the battery percentage should appear.

On first run, when launched from an HTTPS website and no router address has been configured, the script attempts to open `http://192.168.0.1/`. If your router uses another address, open its local management address manually.

## Features

- Reads battery percentage and charging status from the router's local management interface.
- Checks approximately every 3 minutes during normal operation; at 15% or lower, checks approximately once per minute.
- Shows a warning at 15% or lower and an urgent alert at 10% or lower when the router is not charging.
- Shows an estimated time to shutdown only when enough battery samples are available to estimate the drain rate.
- Pauses background polling while the router management interface is open, avoiding conflicts with firmware that allows only one management session.
- Lets you reopen the battery settings panel from the router interface.

## Compatibility and troubleshooting

The userscript is intended for TP-Link mobile-router management interfaces that use the protocol implemented by the script. Not every router model or firmware version is guaranteed to be supported.

When a connection check fails:
- Confirm that the computer is connected to the router's Wi-Fi.
- Confirm that the router administrator password is correct.
- Open the router's actual local management address.
- If the interface responds but its data structure differs, the firmware may not be compatible.

## Updates

The userscript defines `@updateURL` and `@downloadURL` pointing to the official GitHub raw file. You can check for updates from the Tampermonkey dashboard; there is no need to install a different script or copy code manually.

## Security and privacy

**Important:** The router administrator password is stored in Tampermonkey's local userscript storage using `GM_setValue`. The userscript does not encrypt the saved password itself. Protect your operating-system account and browser profile, and do not share your browser profile or its backups.

The userscript sends management requests only to the configured local router origin. Its code does not upload the password or battery readings to the project maintainers and does not include analytics or telemetry. The router management interface may use HTTP without TLS, so use the script only on a trusted local network.

- [Security policy and vulnerability reporting](SECURITY.md)
- [Report a bug or request an improvement](https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/issues)
- [Source code](https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/blob/main/TP-Link-MiFi-Battery-Alert.user.js)
