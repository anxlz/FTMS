// The commands are implemented natively (Kotlin, `android/`); this declares them
// so Tauri generates one permission per command plus the `default` set.
const COMMANDS: &[&str] = &["status", "create_key", "sign", "set_credential", "remove"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
