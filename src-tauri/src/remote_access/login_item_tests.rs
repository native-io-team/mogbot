use super::*;

#[test]
fn a_dev_build_has_nothing_to_reopen() {
    for dev in [
        "/home/me/src/app/src-tauri/target/debug/app",
        "/home/me/src/app/target/release/app",
        "/home/me/.cache/cargo-shared/target/x86_64-pc-windows-msvc/release/app.exe",
    ] {
        assert_eq!(launch_target(Path::new(dev), None), None, "{dev}");
    }
    for installed in [
        "/usr/bin/mogbot",
        "/opt/Mogbot/mogbot",
        "/home/me/target-practice/app",
    ] {
        assert_eq!(
            launch_target(Path::new(installed), None),
            Some(PathBuf::from(installed))
        );
    }
}

#[test]
fn an_appimage_is_started_by_its_own_file_not_its_mount() {
    let mount = Path::new("/tmp/.mount_MogbotXy12/usr/bin/mogbot");
    assert_eq!(
        launch_target(mount, Some("/home/me/Apps/Mogbot_1.0.9.AppImage")),
        Some(PathBuf::from("/home/me/Apps/Mogbot_1.0.9.AppImage"))
    );
    // Empty or relative isn't a path to start.
    assert_eq!(launch_target(mount, Some("")), Some(mount.to_path_buf()));
    assert_eq!(
        launch_target(mount, Some("Mogbot.AppImage")),
        Some(mount.to_path_buf())
    );
}

#[test]
fn the_run_value_quotes_the_exe() {
    assert_eq!(
        windows_run_command(r"C:\Users\Ann Lee\AppData\Local\Mogbot\Mogbot.exe"),
        r#""C:\Users\Ann Lee\AppData\Local\Mogbot\Mogbot.exe""#
    );
    assert_eq!(
        WINDOWS_RUN_KEY,
        r"Software\Microsoft\Windows\CurrentVersion\Run"
    );
}

#[test]
fn autostart_honours_xdg_config_home() {
    let home = Path::new("/home/me");
    assert_eq!(
        xdg_autostart_dir(home, None),
        PathBuf::from("/home/me/.config/autostart")
    );
    assert_eq!(
        xdg_autostart_dir(home, Some("/data/cfg")),
        PathBuf::from("/data/cfg/autostart")
    );
    // Empty and relative values are ignored, as the spec says.
    assert_eq!(
        xdg_autostart_dir(home, Some("")),
        PathBuf::from("/home/me/.config/autostart")
    );
    assert_eq!(
        xdg_autostart_dir(home, Some("cfg")),
        PathBuf::from("/home/me/.config/autostart")
    );
    assert_eq!(
        desktop_file_name("io.example.app"),
        "io.example.app.desktop"
    );
}

#[test]
fn the_desktop_entry_starts_the_app() {
    let body = desktop_entry("Mogbot", Path::new("/home/me/Apps/Mogbot.AppImage")).unwrap();
    assert_eq!(
        body,
        "[Desktop Entry]\nType=Application\nName=Mogbot\nExec=\"/home/me/Apps/Mogbot.AppImage\"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    );
}

#[test]
fn exec_escapes_what_the_spec_reserves() {
    // Spaces are safe inside the quotes.
    assert_eq!(
        desktop_exec_arg("/home/me/My Apps/app").unwrap(),
        "\"/home/me/My Apps/app\""
    );
    // `%` doubles (a field code otherwise); `$` and `"` take a backslash,
    // which the string value then escapes again.
    assert_eq!(
        desktop_exec_arg("/a/100%/$x\"y").unwrap(),
        "\"/a/100%%/\\\\$x\\\\\"y\""
    );
    // A backslash: `\\` in the argument, `\\\\` in the file.
    assert_eq!(desktop_exec_arg("/a\\b").unwrap(), "\"/a\\\\\\\\b\"");
    // A newline would end the line and start another key.
    assert_eq!(desktop_exec_arg("/a\nExec=evil"), None);
    assert_eq!(desktop_entry("App", Path::new("/a\nb")), None);
}

#[test]
fn a_rename_moves_the_linux_entry() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("autostart");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("io.example.oldbot.desktop"),
        "[Desktop Entry]\nExec=\"/old/path\"\n",
    )
    .unwrap();
    let moved = carry_linux_entry(
        &dir,
        "io.example.oldbot",
        "io.example.newbot",
        "Newbot",
        Some(Path::new("/opt/newbot/newbot")),
    );
    assert_eq!(moved, Ok(true));
    assert!(!dir.join("io.example.oldbot.desktop").exists());
    let body = std::fs::read_to_string(dir.join("io.example.newbot.desktop")).unwrap();
    assert!(body.contains("Name=Newbot\n"));
    assert!(body.contains("Exec=\"/opt/newbot/newbot\"\n"));
    // Again: nothing left to move.
    assert_eq!(
        carry_linux_entry(
            &dir,
            "io.example.oldbot",
            "io.example.newbot",
            "Newbot",
            None
        ),
        Ok(false)
    );
}

#[test]
fn a_rename_from_a_dev_build_keeps_the_old_exec() {
    let tmp = tempfile::tempdir().unwrap();
    let old = "[Desktop Entry]\nType=Application\nExec=\"/opt/oldbot\"\n";
    std::fs::write(tmp.path().join("old.desktop"), old).unwrap();
    assert_eq!(
        carry_linux_entry(tmp.path(), "old", "new", "New", None),
        Ok(true)
    );
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("new.desktop")).unwrap(),
        old
    );
}

#[test]
fn the_launch_agent_is_this_apps_own() {
    let plist = launch_agent_plist(Path::new("/Applications/A & B.app"));
    assert!(plist.contains(&format!("<string>{}</string>", launch_agent_label())));
    assert!(plist.contains("<string>/Applications/A &amp; B.app</string>"));
    assert!(launch_agent_label().ends_with(".reopen-at-login"));
}
