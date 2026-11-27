# TP-Link Battery Alert

An Android app that monitors a mobile router's battery and shows an alert when the battery reaches 10% or lower.

## Download

[Direct APK download – always the latest release](https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/releases/latest/download/M7200-Car-Alert.apk)

[All releases and changelogs](https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/releases)

## Features

- Connects to the router's Wi-Fi and reads battery information from its local management interface.
- Shows the latest successfully read battery percentage and when it was updated.
- Checks the connection immediately when monitoring is enabled and whenever the app is opened.
- Checks the battery approximately once per minute while monitoring is active.
- Attempts to resume monitoring after Android boots and to refresh the reading when the screen wakes.
- Shows a battery alert at 10% or lower while not charging, then repeats it every 3 minutes.
- Clears the alert and resets reminders when the battery reaches 15% or higher, or when charging begins.

The app performs local, read-only requests to the router. It does not upload battery data, does not include a community compatibility-reporting system, and does not require a GitHub account.

## Setup

1. Install the APK.
2. Connect the head unit or phone to the router's Wi-Fi network.
3. Open the app and enter the router's **administrator password** — not necessarily the Wi-Fi password.
4. Tap **Save and start monitoring**.
5. Grant Android's notification permission.
6. Approve Android's request to let the app run without battery optimization.

The app immediately reports whether it could connect and read the battery. On success, the battery percentage appears on the main screen. If a check fails, the last successful reading remains visible but is clearly marked as old.

## Automatic startup and sleep recovery

The app requests exemption from Android battery optimization, restarts its monitoring service after boot, and requests a fresh reading when the screen wakes (SCREEN_ON / USER_PRESENT).

Some head units also impose manufacturer-specific background restrictions. In that case, manually allow:
- Autostart.
- Unrestricted background activity.
- Automatic launch after boot, if available.

Android does not provide one universal Autostart setting for all manufacturers. The app therefore cannot guarantee that a manufacturer will not terminate its service during sleep; test the behavior on the actual head unit.

## Notifications

The battery-alert channel uses high importance, sound, and vibration. When the battery is at or below 10% and is not charging, the app posts an alert and repeats it every 3 minutes. The notification remains in the notification drawer until dismissed by the user or cleared after the battery recovers / charging begins.

The duration of the temporary heads-up popup is controlled by Android and the head unit, not by this app. Repeated reminders reduce the chance of missing it.

## Compatibility

The app attempts to read battery data using the local management-interface protocol implemented in the client. The repository does not maintain a list of guaranteed-supported router models. The in-app check is the practical test: success means battery data was actually received; failures are shown with the most useful reason available.

## In-app updates

The app can check GitHub Releases, download a newer APK, and open Android's installer. To install an update, allow the app to install packages from this source. Do not uninstall the existing app when updating; uninstalling deletes the saved password.

## Building

The project uses Gradle and Java 17. A signed APK build in GitHub Actions requires the repository secret M7200_SIGNING_BUNDLE_B64, containing the stable signing-key bundle. The signing key and application ID remain unchanged between versions so releases can update an existing installation.

Every successful build is published in [GitHub Releases](https://github.com/HAKOL-MILEMALA/TPLink-Battery-Alert/releases).
