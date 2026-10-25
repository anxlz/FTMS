# apps/mobile — FTMS Android app (Tauri 2)

A native Android shell around the deployed FTMS web app (Phase 8). The bundled launcher
checks the connection and opens the web app; inside the app the web app uses native QR
scanning, the device location and the **optional** biometric login (a Keystore key —
never needed for attendance). The app holds no API keys or server secrets.

Full documentation — structure, security boundaries, prerequisites, build, permissions,
biometric login, guest workflow, lifecycle, tests and the device checklist — is in
[docs/mobile.md](../../docs/mobile.md).

```bash
pnpm --filter @ftms/mobile test            # Node tests (no Android SDK needed)
pnpm --filter @ftms/mobile native:check    # rustfmt + clippy, host target
pnpm --filter @ftms/mobile native:test     # Rust unit tests, host target

# On a machine with the Android SDK + NDK and the Rust Android targets:
pnpm --filter @ftms/mobile android:init
FTMS_WEB_URL=https://ftms.example.edu pnpm --filter @ftms/mobile android:build
```

**Status:** no APK/AAB has been built yet — the Phase 8 environment had no Android SDK/NDK
and no access to Google Maven or the Rust Android targets. See
[docs/mobile.md](../../docs/mobile.md#build-status-in-this-environment).

Launcher icons come from `assets/branding/generated/android/res` (copied to
`src-tauri/icons/android`, and into the Android project by `android:init`); the desktop
sizes in `src-tauri/icons` were generated with `tauri icon` from
`assets/branding/generated/app-icon-1024.png`.
