# Phase 8 checkpoint — Android App (Tauri), Optional Biometric Login, Guest and Location-Checked Attendance

Date: 2026-10-25 · Scope: the Phase 8 prompt (Android application with Tauri, optional biometric login, QR + geolocation attendance, guest attendance). No Android SDK/NDK, Google Maven access or Rust Android targets were available; **no APK/AAB was built and no Android device or emulator was used**. No credentials were invented.

## Definition of Done

"Biometric login is optional and for signing in only; attendance — signed in or as a guest — needs a valid QR code, the time window and the location policy; the backend stays authoritative; Phases 1–7 keep working; everything is tested and reported honestly."

| Phase 8 deliverable                                     | Result                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mandatory biometric check-in removed                    | ✅                        | The check-in options route, biometric challenge, fallback policy (`biometric_fallback`, `geolocation_policy` and their enums) and the `BIOMETRIC_REQUIRED` / `BIOMETRIC_NOT_ENROLLED` codes are gone. `attendance.e2e-spec.ts`: check-in works without enrollment, with biometric login enabled and after it is disabled; a biometric payload sent with a check-in is ignored. Browser: a signed-in check-in shows no biometric text and has no biometric step.                                                                                 |
| Optional biometric login (Profile → Security)           | ✅ (API, web) / ⚠️ native | Off by default; the exact explanatory sentence is shown. Android protocol: Keystore EC P-256 key (strong biometric per signature, invalidated by new enrollments), server challenge (32 bytes, single use, 5 min), registration proof of possession, signature verification, revocation first on turn-off, honest offline message. `device-keys.e2e-spec.ts` (7 tests) drives it with a Node P-256 key as the phone. Browser passkeys keep working (`attendance.spec.ts`). The Kotlin plugin is **not compiled** (no SDK).                      |
| Guest attendance (no login, account, password, OTP, ID) | ✅                        | `POST /attendance/guest/context`, `POST /attendance/guest/check-in` (public); typed full name + seat number + location; token, cancellation, window, form, location policy, per-IP limits; idempotent `submissionKey`; identical receipt for every outcome; `guest_check_ins` table; record-keeping match creates a `GUEST` record for a member without one and notifies them. `guest-attendance.e2e-spec.ts` (12 tests); browser: matched and unmatched guest submissions, from a scanned link and from the landing screen with a pasted link. |
| Location policy for every check-in                      | ✅                        | A reading is always required (`GEOLOCATION_REQUIRED`); optional maximum distance (visits with coordinates) and required accuracy per program (`LOCATION_OUTSIDE_AREA`, `LOCATION_INACCURATE`); settings form and displays; clear device-side guidance for denied, unavailable, inaccurate and outside-area readings. Tested for signed-in and guest check-ins.                                                                                                                                                                                  |
| Android app (Tauri 2)                                   | ✅ source / ❌ APK        | `apps/mobile`: launcher (connectivity, ar/en, retry), Rust shell with a navigation allow-list, least-privilege remote capability, barcode-scanner and geolocation plugins, own `device-key` plugin (Rust + Kotlin), official icons, configure script. `cargo check`/clippy `-D warnings`/`cargo test` pass on the host target; the desktop build ran under Xvfb and handed over from the launcher to the web app. **APK/AAB not built** — exact blockers below.                                                                                 |
| Native features in the shared web app                   | ✅                        | `lib/native.ts`: camera QR scanning (windowed, cancel, permission and settings), native location permission flow, device-key calls; `QrScan`, `LocationRule/Readout/Help`, `DeviceKeySetting`, `DeviceKeySignIn`, `AppCheckIn`; `/start` landing (**Log In** / **Continue as Guest**), `/guest`, `/check-in/<token>/guest`; refresh after resuming.                                                                                                                                                                                             |
| Staff view, exports, notifications, audit               | ✅                        | Guest submissions table per visit (typed values, result, matched student, name mismatch); `GUEST` source; exports drop the biometric column and include unmatched guest submissions; notification `attendance.guest_recorded`; audit `attendance.guest_submitted` without name or seat.                                                                                                                                                                                                                                                         |
| Database (no data loss)                                 | ✅                        | Two migrations (enum values first, then structure). Fresh deploy: no drift. Upgrade of a populated Phase 6 copy: all rows kept (attendance, credentials → `PASSKEY`, programs → no limits, audit, users), no drift.                                                                                                                                                                                                                                                                                                                             |
| Documentation (§14)                                     | ✅                        | New [`mobile.md`](../mobile.md); updated attendance rules, authentication, security review, environment (`FTMS_WEB_URL`), deployment, operations, testing, limitations (guest statement verbatim), features, database (generated), README, `apps/mobile/README.md`.                                                                                                                                                                                                                                                                             |

## Test results (actual output, final run)

Clean run: `pnpm install --frozen-lockfile`, `prettier --check .`, `pnpm scan:secrets` (526 files), `turbo run lint typecheck build test --force` (**14/14 tasks**, no cache, stand-in secrets) then `pnpm scan:bundle`, `pnpm docs:schema` (no difference), the mobile Rust checks, then `pnpm test:e2e` on a freshly migrated database (API suite, then the browser suite; 546 s). Migration upgrade of a populated Phase 6 copy: all rows kept, no drift.

| Suite                                | Runner               | Result                                            |
| ------------------------------------ | -------------------- | ------------------------------------------------- |
| `@ftms/core` unit                    | Vitest 5             | 99 passed (7 files)                               |
| `@ftms/web` unit                     | Vitest 5             | 39 passed (2 files)                               |
| `@ftms/api` unit                     | Jest 30              | 126 passed (14 suites)                            |
| `@ftms/mobile` (Node)                | `node --test`        | 13 passed (4 files)                               |
| `@ftms/mobile` native (host target)  | `cargo test`, clippy | 3 passed; rustfmt and clippy `-D warnings` clean  |
| `@ftms/api` e2e (real Postgres)      | Jest 30              | 888 passed (24 suites)                            |
| `@ftms/web` browser e2e (real stack) | Playwright 1.64      | 41 passed (Chromium)                              |
| Lint / typecheck / Prettier          | ESLint, TS 6.0       | 0 problems / 0 errors / all formatted             |
| Secret scan / bundle scan            | —                    | clean / clean (48 files)                          |
| Android APK/AAB build                | Tauri CLI 2.12.2     | **not run** — no Android SDK/NDK (blockers below) |
| Physical device / emulator           | —                    | **not run**                                       |

From Phase 7: API e2e 850 → 888 (`guest-attendance.e2e-spec.ts`, `device-keys.e2e-spec.ts`, revised check-in/export tests, matrix rows), core 90 → 99, web unit 34 → 39, new mobile suites; browser 41 (attendance flows rewritten, quality pages added). Full details: [`testing.md`](../testing.md).

## What was built

- **Core (`packages/core`):** `CheckInPolicySchema` (`radiusMeters`, `maxAccuracyMeters`) and `checkLocation`; guest contracts (`GuestContextRequest`, `GuestCheckInRequest` with name/seat validation, `GuestCheckInResult`, `GuestSubmission`); device-key contracts and `deviceKeyMessage`; source `GUEST`; error codes `LOCATION_INACCURATE`, `LOCATION_OUTSIDE_AREA`; notification and audit catalogue entries.
- **API:** `check-in-rules.ts` (shared token, window and location checks); `CheckInService` without biometrics; `GuestCheckInService` + public controller; device-key registration and login in `BiometricsService` (+ routes); program policy mapping; exports and audit resource labels; rate limits for guests and device-key failures.
- **Database:** `guest_check_ins` (append-only, RLS, consistency trigger, checks); `training_programs.location_radius_meters` / `location_max_accuracy_meters`; `webauthn_credentials.kind` (`PASSKEY` | `ANDROID_KEY`, immutable); challenge purposes `DEVICE_REGISTRATION` / `DEVICE_LOGIN` bound to a credential; attendance source `GUEST` with its rules.
- **Web:** the components and pages listed above; profile restructured into **Security → Biometric login** and change password; location policy fields; staff guest table; messages in Arabic and English; CSS for the scanner overlay.
- **Mobile:** `apps/mobile` (see [`mobile.md`](../mobile.md)); CI job `mobile-native` (rustfmt, clippy, Rust tests on the host target).

## Android build blockers (exact)

- `pnpm --filter @ftms/mobile android:init` → _"failed to ensure Android environment: Android SDK not found. Make sure the SDK and NDK are installed and the ANDROID_HOME and NDK_HOME environment variables are set."_
- `rustup target add aarch64-linux-android` → download of `rust-std-1.97.0-aarch64-linux-android.tar.xz` from `static.rust-lang.org` fails: _"unsuccessful tunnel"_ (blocked by the network allow-list).
- `dl.google.com` and `maven.google.com` (SDK, NDK, Android Gradle Plugin, AndroidX) answer _403_ through the proxy. JDK 21 and Gradle 8.14.3 are present but cannot fetch the Android dependencies.
- To build: on a machine with the SDK, NDK and network, `pnpm --filter @ftms/mobile android:init`, then `FTMS_WEB_URL=https://<web host> pnpm --filter @ftms/mobile android:build`, sign, install, and run the device checklist in [`mobile.md`](../mobile.md#device-checklist).

## Decisions taken (and why)

1. **The app loads the deployed web app** (remote URL behind a bundled launcher) instead of bundling a second frontend: one UI, one API contract, server-rendered pages and `httpOnly` cookie sessions unchanged; native features are added through Tauri plugins callable only from that origin.
2. **Android Keystore key, not WebAuthn, for biometric login in the app**: the Android web view cannot reliably use platform passkeys; a Keystore key with server challenge–response is the prompt's preferred mechanism and keeps the existing passkey flow for browsers. Both are stored as `webauthn_credentials` rows distinguished by `kind`, so listing, revocation and session ending stay shared.
3. **Guest identity is never verified** (policy). The seat number is matched only for record keeping: a member with no record gets a `GUEST` record (reviewable, notified); otherwise nothing changes. The guest always sees the same receipt, so the form cannot reveal who exists or who attended.
4. **No offline queue and no automatic retries** for attendance; the guest form's `submissionKey` makes a manual retry safe.
5. **Location is always required**, with optional distance and accuracy limits per program — replacing the old "location optional" policy that only applied to the biometric fallback.
6. **Historical `biometric_verified` values are kept** on old records (no data loss), but nothing new sets them and no screen or export shows them.

## Known limitations

See [`limitations.md`](../limitations.md), notably: guest identity is not verified (intentional); no APK/AAB built and no device testing; the Kotlin plugin is uncompiled; geolocation can be spoofed; the live services still need the institution's accounts.

## Handover

- Build and test the app on a machine with the Android SDK (above), commit `src-tauri/gen/android` after the first `android:init`, and keep the release signing key outside the repository.
- New routes must be added to the role matrix or the reviewed public list (the guest routes are on it).
- After a migration, run `pnpm docs:schema` and commit `docs/database.md`.
