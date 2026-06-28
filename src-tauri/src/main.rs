// Prevents additional console windows on Windows.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
