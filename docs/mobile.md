# Android app (Phase 8)

The FTMS Android app is a [Tauri 2](https://tauri.app/) shell around the deployed web
app. It consumes the same NestJS API through the same web frontend — no backend or API
changes for the app, no second user interface to maintain — and adds three native
features that the web app uses when it runs inside the app (`apps/web/lib/native.ts`):

| Feature            | Native part                                                    | Used for                                                       |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| Camera QR scanning | `tauri-plugin-barcode-scanner` 2.5.2 (CameraX + ML Kit)        | Opening a visit's attendance QR code (signed in or as a guest) |
| Device location    | `tauri-plugin-geolocation` 2.4.2                               | The reading every check-in sends                               |
| Biometric login    | `tauri-plugin-device-key` (this repository, Kotlin + Keystore) | **Optional** sign-in convenience — never attendance            |

Biometric login is an optional convenience feature for signing in. It is not required for
attendance. Attendance — signed in or as a guest — needs the QR code, the time window and
a location reading, never biometrics.

## Structure

```
apps/mobile/
  package.json                    @ftms/mobile: configure, test, native:*, android:* scripts
  scripts/
    configure.mjs                 FTMS_WEB_URL → src/config.json + capabilities/remote.json
    web-url.mjs                   validation (https only; http for localhost/10.0.2.2)
    android-icons.mjs             official launcher icons → the generated Android project
    *.test.mjs                    Node tests (configuration, plugin contract)
  src/                            the only bundled page: the launcher
    index.html, launcher.js       connectivity check, Arabic/English, retry; then opens the web app
    launch.js, launch.test.mjs    the launcher's logic and its tests
  src-tauri/
    Cargo.toml, Cargo.lock        Rust shell (workspace with the plugin)
    tauri.conf.json               identifier eg.edu.asu.agr.ftms, minSdk 24, CSP of the launcher
    capabilities/launcher.json    the launcher page: no permissions
    capabilities/remote.json      generated: what pages of the web app may call (below)
    src/lib.rs                    plugins, the main window, the navigation allow-list
    src/navigation.rs             which URLs may load (tested)
    icons/                        desktop sizes + android/ (official adaptive icons)
  plugins/tauri-plugin-device-key/
    build.rs, src/lib.rs          plugin registration and command permissions
    permissions/                  default set (+ generated per-command permissions)
    android/                      Gradle library: DeviceKeyPlugin.kt, manifest (USE_BIOMETRIC)
```

`src-tauri/gen/android` (the Gradle app project) is created by `tauri android init` on a
machine with the Android SDK; commit it after the first init, as Tauri recommends.

## How it works

1. The app opens the bundled launcher. It checks that the configured web app answers
   (`HEAD /login`, 10 s), then replaces itself (`location.replace`, so the back button
   never returns to it) with the web app's landing screen `/start`: **Log In** or
   **Continue as Guest** (signed in, it forwards to the user's home page). Offline or
   unreachable: a message in the phone's
   language (Arabic by default, English when the phone prefers it) and **Try again**; it
   retries by itself when the connection returns. Nothing is stored and nothing is queued
   offline.
2. The web app detects the app (`isTauri()`) and switches to native features: a **Scan QR
   code** button (students' dashboard and attendance page; the guest page), the native
   location permission flow, and biometric login in Profile → Security.
3. Sessions are the web app's `httpOnly` cookies in the app's private web view storage —
   the same as in a browser. The app stores no password, code, token or attendance data;
   biometric login stores only a Keystore key (non-exportable) and its non-secret
   credential id.

### Security boundaries

- **Navigation allow-list** (`src/navigation.rs`): only the launcher (`tauri.localhost`)
  and the configured origin load; any other URL is blocked.
- **Native access** (`capabilities/remote.json`, generated): only pages of the configured
  origin, only these permissions — `barcode-scanner:allow-{scan,cancel,check-permissions,request-permissions,open-app-settings}`,
  `geolocation:allow-{check-permissions,request-permissions,get-current-position}` (no
  background or continuous tracking) and `device-key:default`. No `core:` permissions.
- **No secrets in the app:** only the web app's public origin is compiled in.
- **HTTPS:** required for the configured origin; HTTP is accepted only for local
  development hosts, and Android release builds refuse cleartext traffic.

## Prerequisites (build machine)

- Node 24 and pnpm 10 (the monorepo's), Rust stable ≥ 1.90 (`rustup`).
- JDK 17 or 21, Android Studio or the command-line tools with: Android SDK Platform 36,
  Build-Tools, Platform-Tools, and the **NDK** (side by side).
- Environment: `ANDROID_HOME` (SDK) and `NDK_HOME` (e.g. `$ANDROID_HOME/ndk/<version>`),
  `JAVA_HOME`.
- Rust Android targets:
  `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.
- Network access to Google Maven (`dl.google.com`, `maven.google.com`) and Maven Central
  for the Gradle build.

## Configure, build, install

The app needs the address of the **deployed web app** (not the API):

```bash
pnpm install
cd apps/mobile

# 1. Generate the Android project once (writes src-tauri/gen/android, copies the icons):
pnpm android:init

# 2. Development on an emulator against a local web app (http allowed for 10.0.2.2):
FTMS_WEB_URL=http://10.0.2.2:3000 pnpm android:dev

# 3. Release build against the deployment:
FTMS_WEB_URL=https://ftms.example.edu pnpm android:build
#   → src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
#   → src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab

# 4. Sign the APK for side-loading (keystore created and kept by the faculty, never committed):
#    zipalign -p -f 4 in.apk aligned.apk && apksigner sign --ks ftms-release.jks aligned.apk
# 5. Install on a connected phone:
#    adb install -r aligned.apk
```

`pnpm configure` refuses a missing, non-HTTPS (outside local development), path-bearing
or credential-bearing address. A release build also refuses the compile-check
placeholder.

### Checks that need no Android SDK

```bash
pnpm --filter @ftms/mobile test          # Node: configuration, launcher, plugin contract
pnpm --filter @ftms/mobile native:check  # rustfmt + clippy (-D warnings) of the shell and plugin, host target
pnpm --filter @ftms/mobile native:test   # Rust unit tests (navigation allow-list, configuration)
```

`native:*` need Rust and, on Linux, the WebKitGTK 4.1 development packages (Tauri's
desktop webview), because they compile for the host. They write a placeholder
configuration if none exists (kept otherwise).

## Permissions

| Android permission                  | From                   | Requested                                         |
| ----------------------------------- | ---------------------- | ------------------------------------------------- |
| `CAMERA`                            | barcode-scanner plugin | the first time the user taps **Scan QR code**     |
| `ACCESS_FINE_LOCATION` / `…COARSE…` | geolocation plugin     | the first time a check-in or guest form needs it  |
| `USE_BIOMETRIC`                     | device-key plugin      | normal permission (granted at install, no prompt) |
| `INTERNET`                          | Tauri template         | normal permission                                 |

If a permission was denied, the page explains it and (camera) offers **Open app
settings**; location denial shows recovery guidance. Nothing is requested at start-up.

## Biometric login in the app

Off by default. Profile → Security → **Turn on biometric login** (only after a password or
emailed-code sign-in):

1. the server issues a single-use challenge (5 minutes);
2. the phone creates an EC P-256 key in the Android Keystore that signs only right after
   a **strong** biometric check (`BIOMETRIC_STRONG`, one check per signature) and is
   invalidated when the phone's fingerprints or faces change;
3. the system biometric prompt unlocks the key, which signs the challenge; the public key
   and signature go to the server, which verifies them and registers the key;
4. the phone keeps the returned credential id (not secret).

Signing in: **Sign in with fingerprint or face** on the app's sign-in page → challenge for
this phone's credential → biometric prompt → signature → the server verifies it with the
stored public key and opens a session. Password and emailed-code sign-in always remain.

Turning it off revokes the credential on the server first, then deletes the key. Offline,
the app says it was **not** turned off and offers to remove the key from the phone only.
Protocol details: [authentication.md](authentication.md#in-the-android-app-a-keystore-key-phase-8).

## Guest workflow

From the sign-in page or a scanned code, **Continue as Guest** → scan the visit's QR code
(or paste its link) → type full name and seat number → **Submit attendance**: the location
is read and sent; the server applies the window and the location policy and answers with
a receipt. No login, account, password, code or identity verification. **The typed name
and seat number are not verified** — see
[attendance-rules.md](attendance-rules.md#guest-attendance-phase-8) and
[limitations.md](limitations.md).

## Timing and location policy

Unchanged rules, enforced only by the API with the server clock: check-in opens
_opens_ minutes before the start, is on time until _grace_ minutes after, late until
_closes_ minutes after ([attendance-rules.md](attendance-rules.md)). Every check-in sends
a fresh, high-accuracy reading (`maximumAge: 0`, 20 s timeout); the program's optional
maximum distance and required accuracy are applied by the API, which answers with a
specific error (inaccurate, outside the area) that the app explains.

## Lifecycle

- **Background/foreground:** the check-in and guest pages refresh the visit's window when
  the app returns after 30 s or more, keeping what was typed.
- **Scanning:** the camera preview runs behind a transparent page with a frame and a
  **Cancel** button; leaving the app cancels the scan.
- **Biometric prompt:** leaving the app cancels it (reported as cancelled, nothing changes).
- **Back button:** goes back in the web app's history; from the first page it leaves the
  app (the launcher is replaced, never returned to).
- **A submission interrupted by a lost connection** is not queued; the user retries. A
  guest retry from the same form reuses its submission key, so a request that did reach
  the server is not recorded twice.

## Tests

| What                                                                       | How              | Where                                                                  |
| -------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| Configuration validation, capability                                       | Node test runner | `scripts/web-url.test.mjs`                                             |
| Launcher logic                                                             | Node test runner | `src/launch.test.mjs`                                                  |
| Web ↔ build.rs ↔ Kotlin command names; key settings                        | Node test runner | `scripts/plugin-contract.test.mjs`                                     |
| Navigation allow-list, config parsing                                      | `cargo test`     | `src-tauri/src/navigation.rs`                                          |
| Guest attendance, location policy, no biometrics in attendance             | Jest + Postgres  | `apps/api/test/guest-attendance.e2e-spec.ts`, `attendance.e2e-spec.ts` |
| Android key registration/login/revocation (Node EC P-256 key as the phone) | Jest + Postgres  | `apps/api/test/device-keys.e2e-spec.ts`                                |
| QR token parsing, device-key error mapping, messages                       | Vitest           | `apps/web/lib/web.test.ts`                                             |
| Signed-in and guest check-in, optional biometric login in a browser        | Playwright       | `apps/web/e2e/attendance.spec.ts`                                      |

## Build status in this environment

Recorded honestly for Phase 8: **no APK or AAB was produced, and the app was not run on an
Android phone or emulator.** The build environment had no Android SDK/NDK, and its network
blocks `dl.google.com`/`maven.google.com` (SDK, NDK, Gradle Android plugin, AndroidX) and
`static.rust-lang.org` (`rustup target add aarch64-linux-android` fails: "unsuccessful
tunnel"). `pnpm android:init` stops with _"Android SDK not found. Make sure the SDK and NDK
are installed and the ANDROID_HOME and NDK_HOME environment variables are set."_
Consequently the Kotlin plugin has **never been compiled**.

What was verified: the Rust shell and plugin compile, pass clippy with `-D warnings` and
their tests for the host target; the capabilities' permission names were validated by
Tauri's build; the desktop debug build was run under Xvfb against a local web app and
showed the launcher handing over to the web app's sign-in page; the Node tests pass; the
web app's native paths are type-checked and unit-tested. Everything Android-specific
(camera scanning, the location permission flow, Keystore and BiometricPrompt, Gradle
manifest merging, icons) must be checked with the device checklist below.

## Device checklist

On at least two phones (one with fingerprint, one with face unlock, Android 9+):

1. Install the APK; first launch shows the launcher, then the sign-in page; airplane mode
   shows the offline message and **Try again** recovers.
2. **Continue as Guest** → **Scan QR code**: camera permission prompt; a printed attendance
   code opens the guest form; deny the permission once and use **Open app settings**.
3. Submit a guest form: location permission prompt; receipt; staff see the submission.
4. Sign in with a password; dashboard → **Scan QR code** → check in; location denied, GPS
   off and outside the radius each give their message.
5. Profile → Security → **Turn on biometric login**; sign out; **Sign in with fingerprint
   or face**; cancel the prompt once; enroll a new fingerprint on the phone and confirm the
   key is reported invalid; turn it off online (server revocation) and in airplane mode
   (must say it was **not** turned off).
6. Confirm a check-in works with biometric login **off**.
7. Background the app on the check-in page across the window's opening; on return the page
   updates.
