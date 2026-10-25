// Prevents an extra console window on Windows in release (desktop builds are for checks only).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ftms_mobile_lib::run()
}
