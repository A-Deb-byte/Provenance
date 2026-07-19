#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = provenance_desktop_lib::native_release_runner_exit_code() {
        std::process::exit(code);
    }
    provenance_desktop_lib::run();
}
