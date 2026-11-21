// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by Chrome as the extension's native messaging host (its first
    // argument is the extension's origin): relay, never open the app.
    if let Some(code) = app_lib::user_chrome::host::from_argv() {
        std::process::exit(code);
    }
    // `mcp user-chrome`: the user's Chrome as a stdio MCP server for a
    // Terminal session (`user_chrome::launcher`), never the app.
    if let Some(code) = app_lib::user_chrome::launcher::from_argv() {
        std::process::exit(code);
    }
    app_lib::run()
}
