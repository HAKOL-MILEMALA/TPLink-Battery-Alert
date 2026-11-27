# Security Policy

## Supported versions

Security fixes are made for the latest published APK release. Older versions may contain issues that have been fixed in a newer release; update from the official GitHub Releases page when possible.

## Reporting a vulnerability

Please do not publish suspected security vulnerabilities in a public issue.

Use GitHub's **Report a vulnerability** feature to send a private report:
https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/security/advisories/new

Include the affected app version, the Android version/device where relevant, the impact, and clear reproduction steps. Do not include router administrator passwords, Wi-Fi passwords, personal information, or other secrets. Please allow maintainers a reasonable opportunity to investigate and prepare a fix before publicly disclosing the issue.

There is no guaranteed response or remediation timeline.

## Security design notes

- The router administrator password is stored encrypted using Android Keystore-backed encryption.
- The app reads battery information from the router's local management interface. It does not upload the password or battery readings to the project maintainers.
- The router's local management interface may use HTTP, depending on the router firmware. Use the app only while connected to a trusted router network.
- Update checks retrieve public release metadata from GitHub over HTTPS. APK downloads are opened in the device's browser from the project's official GitHub Releases assets.
- The app does not download APKs itself, invoke the package installer, or request REQUEST_INSTALL_PACKAGES permission. Android and the browser handle the user's download and installation confirmation.
