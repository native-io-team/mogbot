//! The macOS menu bar: what each menu holds, which keys it owns, and which
//! window hears a choice.
//!
//! Every item either does something where you are or is greyed out; none
//! sits there doing nothing. The frontend says where you are
//! (`set_menu_context`: Agents, Projects or a project's workspace, the
//! preview showing, an agent open, the names ⌘1…⌘9 lead to) and the menu
//! follows it.
//!
//! A choice goes to the **focused** window only, as one `menu://action`
//! event whose payload is the item's id ([`ACTION_EVENT`]); the frontend
//! listens per window (`src/lib/nativeMenu.ts`). Broadcasting it, as this
//! used to, closed a terminal tab in every open project window at once.
//!
//! On macOS the menu owns its keys: a key handler in the page for the same
//! key steps aside there (`menuOwnsShortcuts`), so a press acts once, and
//! still works while the preview's iframe has focus. The full map is in
//! docs/keyboard-shortcuts.md.

use serde::Deserialize;

use crate::errors::CommandError;

/// One event for every menu choice; the payload is the item id.
pub const ACTION_EVENT: &str = "menu://action";

/// How many places ⌘1…⌘9 can lead to.
pub const GO_TO_SLOTS: usize = 9;

/// Where the focused window is, as the frontend reports it.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MenuContext {
    /// `agents`, `projects`, `workspace`, or anything else (onboarding,
    /// loading), where only the app-wide items work.
    #[serde(default)]
    pub view: String,
    /// A web preview is on screen (Capture / Crop Preview).
    #[serde(default)]
    pub preview: bool,
    /// An agent's chat is open (New Conversation).
    #[serde(default)]
    pub conversation: bool,
    /// What ⌘1…⌘9 open, in order: agents in Agents, projects elsewhere.
    #[serde(default)]
    pub go_to: Vec<String>,
}

/// What the context makes available. Pure, so it is tested without a menu.
#[derive(Debug, Clone, PartialEq)]
pub struct MenuState {
    pub in_agents: bool,
    pub in_workspace: bool,
    pub in_app: bool,
    pub preview: bool,
    pub conversation: bool,
    /// The Go menu's flip between the two halves of the app.
    pub toggle_label: &'static str,
    /// ⌘1…⌘n's names, cut to one short line each.
    pub go_to: Vec<String>,
}

const MAX_LABEL: usize = 40;

fn short(label: &str) -> String {
    let line = label.lines().next().unwrap_or_default().trim();
    if line.chars().count() <= MAX_LABEL {
        return line.to_string();
    }
    let kept: String = line.chars().take(MAX_LABEL - 1).collect();
    format!("{}…", kept.trim_end())
}

pub fn menu_state(ctx: &MenuContext) -> MenuState {
    let in_agents = ctx.view == "agents";
    let in_workspace = ctx.view == "workspace";
    let in_app = in_agents || in_workspace || ctx.view == "projects";
    MenuState {
        in_agents,
        in_workspace,
        in_app,
        preview: in_workspace && ctx.preview,
        conversation: in_agents && ctx.conversation,
        toggle_label: if in_agents {
            "Switch to Projects"
        } else {
            "Switch to Agents"
        },
        go_to: if in_app {
            ctx.go_to
                .iter()
                .map(|l| short(l))
                .filter(|l| !l.is_empty())
                .take(GO_TO_SLOTS)
                .collect()
        } else {
            Vec::new()
        },
    }
}

/// Apply where the focused window is to the menu bar. A no-op off macOS,
/// which has no app menu.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub fn set_menu_context(app: tauri::AppHandle, context: MenuContext) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    mac::apply(&app, &menu_state(&context));
    #[cfg(not(target_os = "macos"))]
    let _ = (&app, context);
    Ok(())
}

#[cfg(target_os = "macos")]
pub use mac::install;

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::{Mutex, OnceLock};

    use tauri::menu::{
        AboutMetadata, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu,
        SubmenuBuilder, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    };
    use tauri::{AppHandle, Emitter, Manager, Wry};

    use super::{MenuState, ACTION_EVENT, GO_TO_SLOTS};
    use crate::brand;

    /// The items that change with where you are.
    struct Live {
        toggle: MenuItem<Wry>,
        next_needing: MenuItem<Wry>,
        prev_agent: MenuItem<Wry>,
        next_agent: MenuItem<Wry>,
        new_conversation: MenuItem<Wry>,
        find: MenuItem<Wry>,
        close_tab: MenuItem<Wry>,
        capture: MenuItem<Wry>,
        crop: MenuItem<Wry>,
        workspace_only: Vec<MenuItem<Wry>>,
        /// Need the app proper (not onboarding): the palette and its Projects tab.
        app_only: Vec<MenuItem<Wry>>,
        go_menu: Submenu<Wry>,
        go_separator: PredefinedMenuItem<Wry>,
        go_to: Vec<MenuItem<Wry>>,
        /// How many of `go_to` are at the end of the Go menu now.
        go_shown: Mutex<usize>,
    }

    static LIVE: OnceLock<Live> = OnceLock::new();

    fn item(
        app: &AppHandle,
        id: &str,
        text: &str,
        keys: Option<&str>,
    ) -> tauri::Result<MenuItem<Wry>> {
        let mut b = MenuItemBuilder::with_id(id, text);
        if let Some(keys) = keys {
            b = b.accelerator(keys);
        }
        b.build(app)
    }

    /// Nine numbered items, `<prefix>_<n>`, on `<modifier>+<n>`.
    fn numbered(
        app: &AppHandle,
        prefix: &str,
        names: &[&str],
        modifier: &str,
    ) -> tauri::Result<Vec<MenuItem<Wry>>> {
        names
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let n = i + 1;
                item(
                    app,
                    &format!("{prefix}_{n}"),
                    name,
                    Some(&format!("{modifier}+Digit{n}")),
                )
            })
            .collect()
    }

    fn about(app: &AppHandle) -> AboutMetadata<'static> {
        AboutMetadata {
            name: Some(brand::NAME.to_string()),
            version: Some(app.package_info().version.to_string()),
            comments: Some(
                concat!(
                    "Your own team of AI agents, on this ",
                    crate::computer::noun!(),
                    "."
                )
                .to_string(),
            ),
            website: brand::links::WEBSITE.map(str::to_string),
            ..Default::default()
        }
    }

    /// Build the menu bar and route its choices. Called once from `setup`.
    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        // ── App menu
        let settings = item(app, "settings", "Settings…", Some("CmdOrCtrl+Comma"))?;
        let quit = item(
            app,
            "confirm_quit",
            &format!("Quit {}", brand::NAME),
            Some("CmdOrCtrl+Q"),
        )?;
        let app_menu = SubmenuBuilder::new(app, brand::NAME)
            .about(Some(about(app)))
            .separator()
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&quit)
            .build()?;

        // ── File
        let new_agent = item(app, "new_agent", "New Agent…", Some("CmdOrCtrl+N"))?;
        let new_conversation = item(
            app,
            "new_conversation",
            "New Conversation",
            Some("CmdOrCtrl+Shift+N"),
        )?;
        let new_window = item(app, "new_window", "New Window", Some("CmdOrCtrl+Alt+N"))?;
        let open_project = item(app, "open_project", "Open Project…", Some("CmdOrCtrl+O"))?;
        let new_tab = item(
            app,
            "new_terminal_tab",
            "New Terminal Tab",
            Some("CmdOrCtrl+T"),
        )?;
        let close_tab = item(app, "close_tab", "Close Tab", Some("CmdOrCtrl+W"))?;
        let close_window = item(
            app,
            "close_window",
            "Close Window",
            Some("CmdOrCtrl+Shift+W"),
        )?;
        let capture = item(
            app,
            "capture_screenshot",
            "Capture Preview",
            Some("CmdOrCtrl+Shift+S"),
        )?;
        let crop = item(
            app,
            "toggle_crop",
            "Crop Preview…",
            Some("CmdOrCtrl+Shift+C"),
        )?;
        let file_menu = SubmenuBuilder::new(app, "File")
            .item(&new_agent)
            .item(&new_conversation)
            .item(&new_window)
            .separator()
            .item(&open_project)
            .separator()
            .item(&new_tab)
            .item(&close_tab)
            .item(&close_window)
            .separator()
            .item(&capture)
            .item(&crop)
            .build()?;

        // ── Edit
        let find = item(app, "find", "Search Conversations…", Some("CmdOrCtrl+F"))?;
        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .separator()
            .item(&find)
            .build()?;

        // ── View
        let palette = item(app, "palette", "Command Palette…", Some("CmdOrCtrl+K"))?;
        let modes = numbered(
            app,
            "switch_workspace_mode",
            &["Preview", "Focus", "Code"],
            "CmdOrCtrl+Control",
        )?;
        let mut mode_menu = SubmenuBuilder::new(app, "Workspace Mode");
        for m in &modes {
            mode_menu = mode_menu.item(m);
        }
        let mode_menu = mode_menu.build()?;
        let edit_mode = item(app, "toggle_edit_mode", "Edit Mode", Some("CmdOrCtrl+E"))?;
        let inspector = item(app, "toggle_inspector", "Inspector", Some("CmdOrCtrl+I"))?;
        let view_menu = SubmenuBuilder::new(app, "View")
            .item(&palette)
            .separator()
            .item(&mode_menu)
            .item(&edit_mode)
            .item(&inspector)
            .separator()
            .fullscreen()
            .build()?;

        // ── Go
        let toggle = item(
            app,
            "toggle_mode",
            "Switch to Projects",
            Some("CmdOrCtrl+Shift+A"),
        )?;
        let next_needing = item(
            app,
            "next_needing_you",
            "Next Agent That Needs You",
            Some("CmdOrCtrl+J"),
        )?;
        let prev_agent = item(app, "prev_agent", "Previous Agent", Some("CmdOrCtrl+["))?;
        let next_agent = item(app, "next_agent", "Next Agent", Some("CmdOrCtrl+]"))?;
        let slots: Vec<String> = (1..=GO_TO_SLOTS).map(|n| format!("{n}")).collect();
        let slot_names: Vec<&str> = slots.iter().map(String::as_str).collect();
        let go_to = numbered(app, "go_to", &slot_names, "CmdOrCtrl")?;
        let workspaces: Vec<String> = (1..=9).map(|n| format!("Workspace {n}")).collect();
        let workspace_names: Vec<&str> = workspaces.iter().map(String::as_str).collect();
        let workspace_items = numbered(app, "switch_workspace", &workspace_names, "Alt")?;
        let mut workspace_menu = SubmenuBuilder::new(app, "Workspace");
        for w in &workspace_items {
            workspace_menu = workspace_menu.item(w);
        }
        let workspace_menu = workspace_menu.build()?;
        let tabs: Vec<String> = (1..=9).map(|n| format!("Tab {n}")).collect();
        let tab_names: Vec<&str> = tabs.iter().map(String::as_str).collect();
        let tab_items = numbered(app, "switch_terminal", &tab_names, "Control")?;
        let mut tab_menu = SubmenuBuilder::new(app, "Terminal Tab");
        for t in &tab_items {
            tab_menu = tab_menu.item(t);
        }
        let tab_menu = tab_menu.build()?;
        // The numbered places are appended last, with their separator,
        // only while there are some (`apply`).
        let go_menu = SubmenuBuilder::new(app, "Go")
            .item(&toggle)
            .separator()
            .item(&next_needing)
            .item(&prev_agent)
            .item(&next_agent)
            .separator()
            .item(&workspace_menu)
            .item(&tab_menu)
            .build()?;
        let go_separator = PredefinedMenuItem::separator(app)?;

        // ── Window: macOS lists the open windows here.
        let window_menu = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
            .minimize()
            .maximize()
            .separator()
            .bring_all_to_front()
            .build()?;

        // ── Help: macOS puts its search field here.
        let shortcuts = item(app, "help", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))?;
        let logs = item(app, "show_logs", "Show Logs", None)?;
        let mut help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help")
            .item(&shortcuts)
            .item(&logs);
        if brand::links::ISSUE_REPO.is_some() {
            help = help
                .separator()
                .item(&item(app, "report_bug", "Report a Bug…", None)?)
                .item(&item(app, "request_feature", "Request a Feature…", None)?);
        }
        if brand::links::WEBSITE.is_some() {
            help = help.separator().item(&item(
                app,
                "website",
                &format!("{} Website", brand::NAME),
                None,
            )?);
        }
        let help_menu = help.build()?;

        let menu = MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&go_menu)
            .item(&window_menu)
            .item(&help_menu)
            .build()?;
        app.set_menu(menu)?;

        let mut workspace_only = modes;
        workspace_only.extend(tab_items);
        workspace_only.extend([edit_mode, inspector, new_tab]);
        let _ = LIVE.set(Live {
            toggle,
            next_needing,
            prev_agent,
            next_agent,
            new_conversation,
            find,
            close_tab,
            capture,
            crop,
            workspace_only,
            app_only: vec![palette, open_project],
            go_menu,
            go_separator,
            go_to,
            go_shown: Mutex::new(0),
        });
        // Until the page says where it is: nothing that needs a place.
        apply(app, &super::menu_state(&Default::default()));

        app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
        Ok(())
    }

    /// Grey out what doesn't apply, and name ⌘1…⌘9.
    pub fn apply(_app: &AppHandle, state: &MenuState) {
        let Some(live) = LIVE.get() else { return };
        let _ = live.toggle.set_text(state.toggle_label);
        let _ = live.toggle.set_enabled(state.in_app);
        for agents_only in [
            &live.next_needing,
            &live.prev_agent,
            &live.next_agent,
            &live.find,
        ] {
            let _ = agents_only.set_enabled(state.in_agents);
        }
        let _ = live.new_conversation.set_enabled(state.conversation);
        let _ = live.close_tab.set_enabled(state.in_workspace);
        let _ = live.capture.set_enabled(state.preview);
        let _ = live.crop.set_enabled(state.preview);
        for w in &live.workspace_only {
            let _ = w.set_enabled(state.in_workspace);
        }
        for a in &live.app_only {
            let _ = a.set_enabled(state.in_app);
        }

        // Only as many numbered places as there are, so ⌘7 with six
        // projects is free for the page rather than a dead item.
        let mut shown = live.go_shown.lock().unwrap_or_else(|e| e.into_inner());
        if *shown > 0 {
            let _ = live.go_menu.remove(&live.go_separator);
        }
        for i in 0..*shown {
            let _ = live.go_menu.remove(&live.go_to[i]);
        }
        if !state.go_to.is_empty() {
            let _ = live.go_menu.append(&live.go_separator);
        }
        for (i, label) in state.go_to.iter().enumerate() {
            let _ = live.go_to[i].set_text(label);
            let _ = live.go_menu.append(&live.go_to[i]);
        }
        *shown = state.go_to.len();
    }

    /// The window a menu choice is for: the focused one, else the main one.
    fn target_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
        let windows = app.webview_windows();
        let usable = |w: &&tauri::WebviewWindow| w.label() != crate::agents::quick_entry::LABEL;
        windows
            .values()
            .filter(usable)
            .find(|w| w.is_focused().unwrap_or(false))
            .or_else(|| windows.get("main"))
            .or_else(|| windows.values().find(usable))
            .cloned()
    }

    /// Send an action to the window it's for, bringing the app forward
    /// first when `show` (the Dock menu, with every window hidden).
    pub fn send(app: &AppHandle, action: &str, show: bool) {
        let Some(window) = target_window(app) else {
            return;
        };
        if show {
            let _ = app.show();
            let _ = window.unminimize();
            let _ = window.show();
            crate::commands::window::forget_hidden_window(window.label());
            let _ = window.set_focus();
        }
        let _ = app.emit_to(window.label(), ACTION_EVENT, action);
    }

    fn on_menu(app: &AppHandle, id: &str) {
        match id {
            "new_window" => {
                if let Err(e) = crate::commands::projects::spawn_blank_window(app) {
                    tracing::error!("Failed to spawn new window: {}", e);
                }
            }
            "confirm_quit" => crate::agents::tray::request_quit(app, false),
            // The window's own close, as its red button: its close handler
            // decides (hide while agents keep running, or quit).
            "close_window" => {
                if let Some(w) = target_window(app) {
                    let _ = w.close();
                }
            }
            "show_logs" => {
                tauri::async_runtime::spawn(async {
                    if let Err(e) = crate::commands::agents_desk::agents_open_logs().await {
                        tracing::warn!("Show Logs: {e:?}");
                    }
                });
            }
            "website" => {
                if let Some(url) = brand::links::WEBSITE {
                    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
                        tracing::warn!("Opening the website: {e}");
                    }
                }
            }
            // Predefined items (Copy, Hide…) never reach here; everything
            // else is the page's to do, in the window it's for.
            other => send(app, other, false),
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::send;

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(view: &str) -> MenuContext {
        MenuContext {
            view: view.into(),
            ..Default::default()
        }
    }

    #[test]
    fn agents_items_work_only_in_agents() {
        let s = menu_state(&ctx("agents"));
        assert!(s.in_agents && s.in_app && !s.in_workspace);
        assert_eq!(s.toggle_label, "Switch to Projects");
        let s = menu_state(&ctx("projects"));
        assert!(!s.in_agents && s.in_app);
        assert_eq!(s.toggle_label, "Switch to Agents");
    }

    #[test]
    fn preview_items_need_the_workspace_and_a_preview() {
        let mut c = ctx("projects");
        c.preview = true;
        assert!(!menu_state(&c).preview, "a stale flag outside a project");
        c.view = "workspace".into();
        assert!(menu_state(&c).preview);
        c.preview = false;
        assert!(!menu_state(&c).preview);
    }

    #[test]
    fn a_new_conversation_needs_an_open_agent_in_agents() {
        let mut c = ctx("agents");
        assert!(!menu_state(&c).conversation);
        c.conversation = true;
        assert!(menu_state(&c).conversation);
        c.view = "workspace".into();
        assert!(!menu_state(&c).conversation);
    }

    #[test]
    fn go_to_names_are_short_capped_and_skip_blanks() {
        let mut c = ctx("agents");
        c.go_to = (0..12).map(|i| format!("Agent {i}")).collect();
        c.go_to[1] = "  ".into();
        c.go_to[2] = format!("{}\nsecond line", "x".repeat(80));
        let s = menu_state(&c);
        assert_eq!(s.go_to.len(), GO_TO_SLOTS);
        assert_eq!(s.go_to[0], "Agent 0");
        assert_eq!(s.go_to[1].chars().count(), MAX_LABEL);
        assert!(s.go_to[1].ends_with('…'));
        assert_eq!(s.go_to[2], "Agent 3");
    }

    #[test]
    fn nothing_numbered_before_the_app_is_up() {
        let mut c = ctx("onboarding");
        c.go_to = vec!["Chief".into()];
        let s = menu_state(&c);
        assert!(s.go_to.is_empty() && !s.in_app);
    }

    #[test]
    fn the_context_reads_the_frontends_casing() {
        let c: MenuContext = serde_json::from_str(
            r#"{"view":"workspace","preview":true,"conversation":false,"goTo":["acme"]}"#,
        )
        .unwrap();
        assert_eq!(c.go_to, vec!["acme".to_string()]);
        assert!(c.preview);
    }
}
