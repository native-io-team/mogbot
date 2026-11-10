//! The Dock icon's menu (right-click or hold on the icon): the agents that
//! need you, then New Agent…, the Chief, and Quick Message…. macOS adds the
//! open windows, Options, Hide and Quit below it.
//!
//! Built fresh each time it opens from the same model as the menu-bar icon
//! (`agents::tray::menu_model`), so the two never disagree. Tauri has no
//! Dock-menu API, so the app delegate (Tao's) is taught
//! `applicationDockMenu:` at launch, and a small target object hears the
//! clicks. Everything the choices do already exists: `notify::open_agent`
//! (a notification's click), the menu bar's New Agent, quick entry.

use crate::agents::tray::TrayModel;

/// One line of the Dock menu.
#[derive(Debug, Clone, PartialEq)]
pub enum DockItem {
    Separator,
    /// `id` is what a click does: `agent:<id>`, `new_agent` or `quick`.
    Item {
        id: String,
        label: String,
        enabled: bool,
    },
}

fn line(id: &str, label: impl Into<String>, enabled: bool) -> DockItem {
    DockItem::Item {
        id: id.to_string(),
        label: label.into(),
        enabled,
    }
}

/// What the Dock menu shows. `chief` is the Chief of Staff's id and name.
pub fn dock_items(model: &TrayModel, chief: Option<(&str, &str)>) -> Vec<DockItem> {
    let mut items = Vec::new();
    if !model.needs_you.is_empty() {
        items.push(line("", "Needs you", false));
        for row in &model.needs_you {
            items.push(line(&format!("agent:{}", row.agent_id), &row.label, true));
        }
        if model.needs_you_more > 0 {
            items.push(line("", format!("{} more", model.needs_you_more), false));
        }
        items.push(DockItem::Separator);
    }
    items.push(line("new_agent", "New Agent…", true));
    if let Some((id, name)) = chief {
        let name = name.trim();
        if !name.is_empty() {
            items.push(line(&format!("agent:{id}"), format!("Open {name}"), true));
        }
    }
    items.push(line("quick", "Quick Message…", true));
    items
}

#[cfg(target_os = "macos")]
pub use mac::install;

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    use super::{dock_items, DockItem};
    use crate::agents::{store, tray};

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// The object the Dock menu's items send `choose:` to; lives for the app.
    static TARGET: OnceLock<usize> = OnceLock::new();

    /// Teach the app delegate `applicationDockMenu:`. Called once, from
    /// `setup` on the main thread, after Tao has set its delegate.
    pub fn install(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        // SAFETY: main thread; the selectors and type encodings below match
        // the methods' Rust signatures (`v@:@` / `@@:@`).
        unsafe {
            let Some(mut builder) = ClassBuilder::new("AgentsDockMenuTarget", class!(NSObject))
            else {
                tracing::warn!("[Dock menu] target class already exists");
                return;
            };
            builder.add_method(sel!(choose:), choose as extern "C" fn(_, _, _));
            let cls: &AnyClass = builder.register();
            let target: *mut AnyObject = msg_send![cls, new];
            let _ = TARGET.set(target as usize);

            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            if delegate.is_null() {
                tracing::warn!("[Dock menu] no app delegate");
                return;
            }
            let delegate_class = (*delegate).class();
            let imp: objc2::ffi::IMP = std::mem::transmute(
                dock_menu as extern "C" fn(&AnyObject, Sel, *mut AnyObject) -> *mut AnyObject,
            );
            let added = objc2::ffi::class_addMethod(
                delegate_class as *const AnyClass as *mut objc2::ffi::objc_class,
                sel!(applicationDockMenu:).as_ptr(),
                imp,
                c"@@:@".as_ptr(),
            );
            if added == objc2::ffi::NO {
                tracing::warn!("[Dock menu] the delegate already answers applicationDockMenu:");
                return;
            }
            // NSApplication caches which methods its delegate answers when
            // the delegate is set; setting the same one again refreshes it.
            let _: () = msg_send![ns_app, setDelegate: delegate];
        }
    }

    fn current_items() -> Vec<DockItem> {
        let agents = store::list().unwrap_or_default();
        let seen: Vec<tray::Seen> = agents.iter().map(tray::Seen::of).collect();
        let chief = agents
            .iter()
            .find(|a| a.is_main)
            .map(|a| (a.id.as_str(), a.name.as_str()));
        dock_items(&tray::menu_model(&seen), chief)
    }

    extern "C" fn dock_menu(
        _this: &AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> *mut AnyObject {
        let Some(&target) = TARGET.get() else {
            return std::ptr::null_mut();
        };
        // A panic must not cross into Objective-C.
        let items = std::panic::catch_unwind(current_items).unwrap_or_default();
        // SAFETY: AppKit calls this on the main thread; every object made
        // here is either autoreleased (the menu) or owned by the menu.
        unsafe { build(&items, target as *mut AnyObject) }
    }

    unsafe fn build(items: &[DockItem], target: *mut AnyObject) -> *mut AnyObject {
        let menu: *mut AnyObject = msg_send![class!(NSMenu), new];
        let _: () = msg_send![menu, setAutoenablesItems: false];
        let no_key = NSString::from_str("");
        for item in items {
            match item {
                DockItem::Separator => {
                    let sep: *mut AnyObject = msg_send![class!(NSMenuItem), separatorItem];
                    let _: () = msg_send![menu, addItem: sep];
                }
                DockItem::Item { id, label, enabled } => {
                    let title = NSString::from_str(label);
                    let alloc: *mut AnyObject = msg_send![class!(NSMenuItem), alloc];
                    let it: *mut AnyObject = msg_send![
                        alloc,
                        initWithTitle: &*title,
                        action: sel!(choose:),
                        keyEquivalent: &*no_key
                    ];
                    if !id.is_empty() {
                        let rep = NSString::from_str(id);
                        let _: () = msg_send![it, setRepresentedObject: &*rep];
                        let _: () = msg_send![it, setTarget: target];
                    }
                    let _: () = msg_send![it, setEnabled: *enabled];
                    let _: () = msg_send![menu, addItem: it];
                    let _: () = msg_send![it, release];
                }
            }
        }
        let menu: *mut AnyObject = msg_send![menu, autorelease];
        menu
    }

    extern "C" fn choose(_this: &AnyObject, _cmd: Sel, sender: *mut AnyObject) {
        if sender.is_null() {
            return;
        }
        // SAFETY: `sender` is the NSMenuItem we built, whose represented
        // object is an NSString or nil.
        let id = unsafe {
            let rep: *mut NSString = msg_send![sender, representedObject];
            if rep.is_null() {
                return;
            }
            (*rep).to_string()
        };
        let Some(app) = APP.get() else { return };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_choose(app, &id)));
    }

    fn on_choose(app: &AppHandle, id: &str) {
        if let Some(agent_id) = id.strip_prefix("agent:") {
            crate::agents::notify::open_agent(app, agent_id);
            return;
        }
        match id {
            "new_agent" => crate::app_menu::send(app, "new_agent", true),
            "quick" => crate::agents::quick_entry::show(app),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::tray::Row;

    fn ids(items: &[DockItem]) -> Vec<String> {
        items
            .iter()
            .map(|i| match i {
                DockItem::Separator => "-".into(),
                DockItem::Item { id, label, enabled } => {
                    format!("{id}|{label}|{}", if *enabled { "on" } else { "off" })
                }
            })
            .collect()
    }

    #[test]
    fn nothing_waiting_offers_the_three_ways_in() {
        let items = dock_items(&TrayModel::default(), Some(("c1", "Chief of Staff")));
        assert_eq!(
            ids(&items),
            [
                "new_agent|New Agent…|on",
                "agent:c1|Open Chief of Staff|on",
                "quick|Quick Message…|on",
            ]
        );
    }

    #[test]
    fn agents_needing_you_come_first_with_the_rest_counted() {
        let model = TrayModel {
            needs_you: vec![Row {
                agent_id: "fin".into(),
                label: "Finance · Needs your OK".into(),
            }],
            needs_you_more: 2,
            ..Default::default()
        };
        let items = dock_items(&model, None);
        assert_eq!(
            ids(&items),
            [
                "|Needs you|off",
                "agent:fin|Finance · Needs your OK|on",
                "|2 more|off",
                "-",
                "new_agent|New Agent…|on",
                "quick|Quick Message…|on",
            ]
        );
    }

    #[test]
    fn a_blank_chief_name_is_left_out() {
        let items = dock_items(&TrayModel::default(), Some(("c1", "  ")));
        assert!(!ids(&items).iter().any(|l| l.starts_with("agent:c1")));
    }
}
