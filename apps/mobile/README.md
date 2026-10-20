# apps/mobile — reserved

This directory is intentionally empty. It is reserved for the future **Tauri**-based mobile
app ([tauri.app](https://tauri.app/)), which will wrap the web frontend and consume the same
JWT-authenticated NestJS API (`apps/api`) without backend changes.

Do not build the mobile app until it is assigned as its own phase.

When that phase starts, the Android launcher icons are already derived from the official logo:

- `assets/branding/generated/app-icon-1024.png` — square master for `tauri icon`.
- `assets/branding/generated/android/res/` — ready-made `mipmap-*` adaptive and legacy icons.

See the root README, section "App icons and branding", for how they are regenerated.
