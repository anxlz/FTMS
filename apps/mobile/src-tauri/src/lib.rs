//! The FTMS Android app (Phase 8).
//!
//! A Tauri shell around the deployed FTMS web app: the bundled launcher page checks
//! the connection, then opens the web app in the same web view. The backend stays
//! authoritative for everything; the app adds native features the web app uses when
//! it runs inside it (see `apps/web/lib/native.ts`):
//!
//! - camera QR scanning (`barcode-scanner`),
//! - the device location, asked for only when attendance needs it (`geolocation`),
//! - optional biometric login with an Android Keystore key (`device-key`, this repo).
//!
//! The app holds no API keys, database credentials or server secrets.

mod navigation;

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Written by `scripts/configure.mjs`; see `navigation::AppConfig`.
const CONFIG_JSON: &str = include_str!("../../src/config.json");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let web = navigation::web_origin(CONFIG_JSON).expect("src/config.json (run `pnpm configure`)");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_device_key::init());
    // The scanner exists on mobile only (desktop builds are compile checks).
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .setup(move |app| {
            let allowed = web.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Field Training")
                // Only the launcher and the web app; links elsewhere do not load in the app.
                .on_navigation(move |url| navigation::allowed(url, &allowed))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the FTMS app");
}
