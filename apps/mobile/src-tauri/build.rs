fn main() {
    // The web app's address is compiled in (navigation allow-list); see scripts/configure.mjs.
    println!("cargo:rerun-if-changed=../src/config.json");
    tauri_build::build()
}
