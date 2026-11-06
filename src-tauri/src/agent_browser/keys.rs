//! The keys an agent's `press` and the phone's key bar can send: editing
//! and moving, never a shortcut (no modifiers), so nothing opens, closes or
//! goes anywhere a key combination would take it.

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Enter,
    Tab,
    Backspace,
    Delete,
    Escape,
    Space,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    PageUp,
    PageDown,
    Home,
    End,
}

impl Key {
    /// A key by any of the names agents use ("Enter", "Return", "esc",
    /// "arrow_down", "Down").
    pub fn parse(name: &str) -> Option<Key> {
        let n: String = name
            .trim()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        Some(match n.as_str() {
            "enter" | "return" => Key::Enter,
            "tab" => Key::Tab,
            "backspace" => Key::Backspace,
            "delete" | "del" => Key::Delete,
            "escape" | "esc" => Key::Escape,
            "space" | "spacebar" => Key::Space,
            "arrowup" | "up" => Key::ArrowUp,
            "arrowdown" | "down" => Key::ArrowDown,
            "arrowleft" | "left" => Key::ArrowLeft,
            "arrowright" | "right" => Key::ArrowRight,
            "pageup" => Key::PageUp,
            "pagedown" => Key::PageDown,
            "home" => Key::Home,
            "end" => Key::End,
            _ => return None,
        })
    }

    /// (DOM `key`, DOM `code`, Windows virtual key code, text it types).
    fn parts(self) -> (&'static str, &'static str, i64, Option<&'static str>) {
        match self {
            Key::Enter => ("Enter", "Enter", 13, Some("\r")),
            Key::Tab => ("Tab", "Tab", 9, None),
            Key::Backspace => ("Backspace", "Backspace", 8, None),
            Key::Delete => ("Delete", "Delete", 46, None),
            Key::Escape => ("Escape", "Escape", 27, None),
            Key::Space => (" ", "Space", 32, Some(" ")),
            Key::ArrowUp => ("ArrowUp", "ArrowUp", 38, None),
            Key::ArrowDown => ("ArrowDown", "ArrowDown", 40, None),
            Key::ArrowLeft => ("ArrowLeft", "ArrowLeft", 37, None),
            Key::ArrowRight => ("ArrowRight", "ArrowRight", 39, None),
            Key::PageUp => ("PageUp", "PageUp", 33, None),
            Key::PageDown => ("PageDown", "PageDown", 34, None),
            Key::Home => ("Home", "Home", 36, None),
            Key::End => ("End", "End", 35, None),
        }
    }

    /// The name the gate reads ("Enter").
    pub fn name(self) -> &'static str {
        match self {
            Key::Space => "Space",
            k => k.parts().0,
        }
    }

    /// `Input.dispatchKeyEvent`'s key down and key up.
    pub fn events(self) -> (Value, Value) {
        let (key, code, vk, text) = self.parts();
        let mut down = json!({
            "type": if text.is_some() { "keyDown" } else { "rawKeyDown" },
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
        });
        if let Some(t) = text {
            down["text"] = json!(t);
            down["unmodifiedText"] = json!(t);
        }
        let up = json!({
            "type": "keyUp",
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
        });
        (down, up)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_agents_use() {
        assert_eq!(Key::parse("Return"), Some(Key::Enter));
        assert_eq!(Key::parse("arrow_down"), Some(Key::ArrowDown));
        assert_eq!(Key::parse("ESC"), Some(Key::Escape));
        assert_eq!(Key::parse("cmd+w"), None);
        assert_eq!(Key::parse("Meta"), None);
    }

    #[test]
    fn enter_types_a_return() {
        let (down, up) = Key::Enter.events();
        assert_eq!(down["type"], "keyDown");
        assert_eq!(down["text"], "\r");
        assert_eq!(up["type"], "keyUp");
        let (down, _) = Key::Tab.events();
        assert_eq!(down["type"], "rawKeyDown");
        assert!(down.get("modifiers").is_none());
    }
}
