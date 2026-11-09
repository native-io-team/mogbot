//! The native host on its own, for the end-to-end check
//! (`user_chrome_e2e`): the same code the app's binary runs when Chrome
//! starts it (`user_chrome::host`), without building the whole app bundle.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    std::process::exit(app_lib::user_chrome::host::run(&args));
}
