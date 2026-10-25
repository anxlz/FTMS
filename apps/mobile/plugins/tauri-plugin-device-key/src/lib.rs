//! Optional biometric login for the FTMS Android app (Phase 8).
//!
//! The commands run natively on Android (`android/src/main/java/.../DeviceKeyPlugin.kt`):
//!
//! - `status` — whether strong biometrics are set up, and whether this phone has a key
//!   registered (`credentialId`, not secret);
//! - `create_key` — a new EC P-256 key in the Android Keystore that can sign only right
//!   after a strong biometric check, and is invalidated when the phone's fingerprints or
//!   faces change; returns its public key (DER SubjectPublicKeyInfo, base64);
//! - `sign` — shows the system biometric prompt, then signs a server challenge message;
//! - `set_credential` / `remove` — remember the server's id for the key / delete both.
//!
//! The private key never leaves the Keystore and no biometric data is ever read: the
//! phone's own biometric check unlocks the key. The server verifies signatures with the
//! registered public key. This is a sign-in convenience only — attendance never uses it.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Package of the Kotlin plugin class.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "eg.edu.asu.agr.ftms.devicekey";

/// Registers the plugin. On platforms other than Android it registers nothing native,
/// so the commands are unavailable there (the web app only calls them inside the app).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("device-key")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(PLUGIN_IDENTIFIER, "DeviceKeyPlugin")?;
            Ok(())
        })
        .build()
}
