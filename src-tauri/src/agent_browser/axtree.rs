//! A page as an agent reads it: Chrome's accessibility tree
//! (`Accessibility.getFullAXTree`), as indented lines, every control with a
//! `ref` the click and type tools take.
//!
//! Refs are the app's own (`ref_1`, `ref_2`, …), mapped to Chrome's
//! `backendDOMNodeId`; each line's label (`button "Send"`) is what the gate
//! reads to tell a send from a look (`agents::browser_gate::sends`), so it is
//! taken from the tree Chrome built, never from the page's own words about
//! itself. Pure, for tests.

use serde_json::Value;
use std::collections::HashMap;

/// Roles a person acts on: each gets a ref.
const CONTROLS: &[&str] = &[
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "option",
    "switch",
    "slider",
    "spinbutton",
    "listbox",
    "treeitem",
    "textarea",
];

/// Roles that add nothing but nesting.
const SKIP: &[&str] = &[
    "none",
    "generic",
    "InlineTextBox",
    "LineBreak",
    "presentation",
    "ignored",
    "LayoutTable",
    "LayoutTableRow",
    "LayoutTableCell",
];

/// Roles shown even without a name: they give the page its shape.
const LANDMARKS: &[&str] = &[
    "main",
    "navigation",
    "banner",
    "contentinfo",
    "form",
    "dialog",
    "alertdialog",
    "search",
    "region",
    "list",
    "table",
];

/// The most a page read returns, so one huge page can't fill a turn.
pub const MAX_CHARS: usize = 14_000;

/// One control a ref names.
#[derive(Debug, Clone, PartialEq)]
pub struct RefTarget {
    pub backend_node_id: i64,
    /// `button "Send"`: the role and Chrome's computed name.
    pub label: String,
}

/// What a read produced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Rendered {
    pub text: String,
    pub refs: HashMap<String, RefTarget>,
    /// The tree had more than fitted.
    pub truncated: bool,
}

fn field<'a>(n: &'a Value, k: &str) -> Option<&'a str> {
    n.get(k)?.get("value")?.as_str()
}

fn clip(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n {
        s.chars().take(n).collect::<String>() + "…"
    } else {
        s
    }
}

fn prop(n: &Value, name: &str) -> Option<Value> {
    n.get("properties")?
        .as_array()?
        .iter()
        .find(|p| p.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|p| p.get("value")?.get("value").cloned())
}

/// A field whose value must never be read out: a password, or anything
/// named like one.
fn secret_field(role: &str, name: &str, n: &Value) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(role, "textbox" | "searchbox" | "combobox")
        && (lower.contains("password")
            || lower.contains("passcode")
            || lower.contains("one-time")
            || lower.contains("verification code")
            || prop(n, "protected").and_then(|v| v.as_bool()) == Some(true))
}

/// The lines for `nodes`, numbering refs from `first_ref`. `interactive`:
/// controls only (and the headings around them), for a shorter read.
pub fn render(nodes: &[Value], interactive: bool) -> Rendered {
    let by_id: HashMap<&str, &Value> = nodes
        .iter()
        .filter_map(|n| Some((n.get("nodeId")?.as_str()?, n)))
        .collect();
    let root = nodes
        .iter()
        .find(|n| n.get("parentId").is_none())
        .or_else(|| nodes.first());
    let mut out = Rendered::default();
    let Some(root) = root else { return out };
    let mut next = 1usize;
    // Depth-first, iteratively: a deep page can't blow the stack.
    let mut stack: Vec<(&Value, usize)> = vec![(root, 0)];
    while let Some((n, depth)) = stack.pop() {
        let ignored = n.get("ignored").and_then(Value::as_bool) == Some(true);
        let role = field(n, "role").unwrap_or("");
        let name = field(n, "name").unwrap_or("").trim();
        let mut child_depth = depth;
        let show = !ignored && !SKIP.contains(&role) && !role.is_empty();
        if show {
            let control = CONTROLS.contains(&role);
            let heading = role == "heading";
            let text = role == "StaticText";
            let wanted = if interactive {
                control || heading
            } else {
                control || heading || !name.is_empty() || LANDMARKS.contains(&role)
            };
            // Text that only repeats its parent's name adds nothing.
            if wanted && !(text && name.is_empty()) && role != "RootWebArea" {
                let mut line = format!("{}- ", "  ".repeat(depth.min(12)));
                if text {
                    line.push_str(&format!("text \"{}\"", clip(name, 200)));
                } else {
                    line.push_str(role);
                    if !name.is_empty() {
                        line.push_str(&format!(" \"{}\"", clip(name, 120)));
                    }
                }
                if control {
                    if let Some(v) = field(n, "value").filter(|v| !v.is_empty()) {
                        if !secret_field(role, name, n) {
                            line.push_str(&format!(" value=\"{}\"", clip(v, 80)));
                        }
                    }
                    if prop(n, "disabled").and_then(|v| v.as_bool()) == Some(true) {
                        line.push_str(" (disabled)");
                    }
                    if prop(n, "checked").and_then(|v| v.as_str().map(str::to_string))
                        == Some("true".into())
                    {
                        line.push_str(" (checked)");
                    }
                    if let Some(id) = n.get("backendDOMNodeId").and_then(Value::as_i64) {
                        let r = format!("ref_{next}");
                        next += 1;
                        let label = if name.is_empty() {
                            role.to_string()
                        } else {
                            format!("{role} \"{}\"", clip(name, 120))
                        };
                        line.push_str(&format!(" [{r}]"));
                        out.refs.insert(
                            r,
                            RefTarget {
                                backend_node_id: id,
                                label,
                            },
                        );
                    }
                }
                if out.text.len() + line.len() + 1 > MAX_CHARS {
                    out.truncated = true;
                    break;
                }
                out.text.push_str(&line);
                out.text.push('\n');
                child_depth = depth + 1;
            }
        }
        // A text node's children are its line boxes: nothing new.
        if role == "StaticText" {
            continue;
        }
        let kids: Vec<&Value> = n
            .get("childIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(|i| i.as_str().and_then(|i| by_id.get(i).copied()))
                    .collect()
            })
            .unwrap_or_default();
        for k in kids.into_iter().rev() {
            stack.push((k, child_depth));
        }
    }
    if out.truncated {
        out.text
            .push_str("… (the page goes on: use find, or scroll and read again)\n");
    }
    out
}

/// The lines of `rendered` that mention `query` (any word, case aside).
pub fn find(rendered: &Rendered, query: &str) -> String {
    let words: Vec<String> = query
        .to_ascii_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if words.is_empty() {
        return String::new();
    }
    rendered
        .text
        .lines()
        .filter(|l| {
            let lower = l.to_ascii_lowercase();
            words.iter().all(|w| lower.contains(w))
        })
        .map(str::trim)
        .take(60)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(
        id: &str,
        parent: Option<&str>,
        role: &str,
        name: &str,
        kids: &[&str],
        backend: i64,
    ) -> Value {
        let mut n = json!({
            "nodeId": id,
            "ignored": false,
            "role": { "type": "role", "value": role },
            "name": { "type": "computedString", "value": name },
            "childIds": kids,
            "backendDOMNodeId": backend,
        });
        if let Some(p) = parent {
            n["parentId"] = json!(p);
        }
        n
    }

    fn page() -> Vec<Value> {
        let mut pw = node("6", Some("1"), "textbox", "Password", &[], 16);
        pw["value"] = json!({ "type": "string", "value": "hunter2" });
        let mut email = node("5", Some("1"), "textbox", "Email", &[], 15);
        email["value"] = json!({ "type": "string", "value": "me@example.com" });
        vec![
            node(
                "1",
                None,
                "RootWebArea",
                "Sign in",
                &["2", "3", "4", "5", "6", "7"],
                10,
            ),
            node("2", Some("1"), "heading", "Welcome back", &[], 11),
            node("3", Some("1"), "StaticText", "Use your account", &[], 12),
            node("4", Some("1"), "generic", "", &[], 13),
            email,
            pw,
            node("7", Some("1"), "button", "Send now", &[], 17),
        ]
    }

    #[test]
    fn controls_get_refs_and_labels_the_gate_reads() {
        let r = render(&page(), false);
        assert!(r.text.contains("heading \"Welcome back\""));
        assert!(r.text.contains("text \"Use your account\""));
        assert!(r.text.contains("button \"Send now\" [ref_3]"), "{}", r.text);
        assert_eq!(r.refs["ref_3"].label, "button \"Send now\"");
        assert_eq!(r.refs["ref_3"].backend_node_id, 17);
        assert!(!r.text.contains("generic"));
    }

    #[test]
    fn a_password_value_is_never_read_out() {
        let r = render(&page(), false);
        assert!(r.text.contains("value=\"me@example.com\""));
        assert!(!r.text.contains("hunter2"), "{}", r.text);
        assert!(r.text.contains("textbox \"Password\" [ref_2]"));
    }

    #[test]
    fn interactive_keeps_controls_and_headings() {
        let r = render(&page(), true);
        assert!(!r.text.contains("Use your account"));
        assert!(r.text.contains("Welcome back"));
        assert_eq!(r.refs.len(), 3);
    }

    #[test]
    fn a_huge_page_is_cut_and_says_so() {
        let mut nodes = vec![node("r", None, "RootWebArea", "", &[], 1)];
        let ids: Vec<String> = (0..3000).map(|i| format!("n{i}")).collect();
        nodes[0]["childIds"] = json!(ids);
        for (i, id) in ids.iter().enumerate() {
            nodes.push(node(
                id,
                Some("r"),
                "link",
                &format!("Link number {i}"),
                &[],
                100 + i as i64,
            ));
        }
        let r = render(&nodes, false);
        assert!(r.truncated);
        assert!(r.text.len() <= MAX_CHARS + 100);
        assert!(r.text.ends_with("read again)\n"));
    }

    #[test]
    fn find_matches_every_word() {
        let r = render(&page(), false);
        assert_eq!(find(&r, "send"), "- button \"Send now\" [ref_3]");
        assert_eq!(find(&r, "nothing here"), "");
    }
}
