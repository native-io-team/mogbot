//! What the tools do to one page, over any CDP transport.
//!
//! The agents' browser reaches a page over its own CDP pipe (`service`);
//! the user's own Chrome reaches one through the app's extension, which
//! relays an allow-listed set of CDP commands with `chrome.debugger`
//! (`user_chrome`). Both answer the same calls, so both run the same page
//! logic: what a ref's centre is, whether a field takes a password, how a
//! click, a key or a screenshot is made. One copy, so the two browsers
//! can't drift apart in what "click ref_4" or "is this a password" means.
//!
//! Every expression evaluated in a page is one of [`EXPRESSIONS`]: the app's
//! own, never an agent's. The extension refuses any other (a test holds its
//! copy of the list to this one).

use serde_json::{json, Value};
use std::time::{Duration, Instant};

use super::keys::Key;

/// What the focused field is, before anything is typed into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    /// Not a password or a code.
    Plain,
    /// A password or one-time-code field.
    Secret,
    /// Couldn't be told: focus in another site's frame, or no answer.
    Unknown,
}

impl Focus {
    /// [`FOCUSED_FIELD_JS`]'s answer. Anything but a plain "plain" fails
    /// closed.
    pub fn from_answer(answer: Result<Value, String>) -> Focus {
        match answer.ok().as_ref().and_then(Value::as_str) {
            Some("plain") => Focus::Plain,
            Some("secret") => Focus::Secret,
            _ => Focus::Unknown,
        }
    }
}

/// Follows focus through shadow roots and into same-origin frames; a frame
/// whose document it can't read (another site's) is "unknown", as is a
/// chain too deep to follow.
pub const FOCUSED_FIELD_JS: &str = "(() => { let e = document.activeElement; for (let i = 0; e; i++) { if (i > 32) return 'unknown'; if (e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; } const tag = (e.tagName || '').toUpperCase(); if (tag === 'IFRAME' || tag === 'FRAME') { let d = null; try { d = e.contentDocument; } catch (_) { return 'unknown'; } if (!d) return 'unknown'; e = d.activeElement; continue; } break; } if (!e || (e.tagName || '').toUpperCase() !== 'INPUT') return 'plain'; const t = (e.type || '').toLowerCase(); const a = (e.autocomplete || '').toLowerCase(); return (t === 'password' || a.includes('one-time-code') || a.includes('current-password') || a.includes('new-password')) ? 'secret' : 'plain'; })()";

/// The page's visible text.
pub const TEXT_JS: &str = "document.body ? document.body.innerText : ''";
/// Whether the document has finished loading.
pub const READY_JS: &str = "document.readyState";
/// Whether Chrome is painting the page: "hidden" in a background tab or a
/// minimised (or fully covered) window. A pointer move waits for a frame,
/// so one sent there waits out Chrome's 5 s input timeout.
pub const VISIBILITY_JS: &str = "document.visibilityState";

/// One scroll step of the page itself, by direction. A wheel event waits
/// for the page to paint, which a window Chrome thinks is hidden (behind
/// others, on another Space) never does; scrolling the document doesn't.
pub const SCROLL_UP_JS: &str = "window.scrollBy(0, -120)";
pub const SCROLL_DOWN_JS: &str = "window.scrollBy(0, 120)";
pub const SCROLL_LEFT_JS: &str = "window.scrollBy(-120, 0)";
pub const SCROLL_RIGHT_JS: &str = "window.scrollBy(120, 0)";

/// The step for a direction.
pub fn scroll_step_js(direction: &str) -> Option<&'static str> {
    Some(match direction {
        "up" => SCROLL_UP_JS,
        "down" => SCROLL_DOWN_JS,
        "left" => SCROLL_LEFT_JS,
        "right" => SCROLL_RIGHT_JS,
        _ => return None,
    })
}

/// Scroll the box a node is in: the node itself or its nearest ancestor that
/// scrolls that way (through shadow roots), by `dx`, `dy` CSS pixels, at
/// once (never smooth: a page Chrome isn't painting never animates). Says
/// `moved`, `end` (it scrolls, but is already at that end) or `none`
/// (nothing around the node scrolls that way).
///
/// Run on the node with `Runtime.callFunctionOn`, never a wheel: a wheel
/// event waits for a frame, and a tab Chrome isn't painting (a background
/// tab, an unfocused window behind others, a minimised one) never makes
/// one, so the wheel waited out the whole 20 s and left the tab's input
/// queue stuck behind it.
pub const SCROLL_WITHIN_FN: &str = "function (dx, dy) { let e = this && this.nodeType === 1 ? this : this && this.parentElement; for (let i = 0; e && i < 64; i++) { if (e.nodeType === 1 && e !== document.body && e !== document.documentElement) { const s = getComputedStyle(e); const y = dy !== 0 && /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight; const x = dx !== 0 && /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth; if (x || y) { const t = e.scrollTop, l = e.scrollLeft; e.scrollBy({ left: dx, top: dy, behavior: 'instant' }); return e.scrollTop !== t || e.scrollLeft !== l ? 'moved' : 'end'; } } const r = e.getRootNode && e.getRootNode(); e = e.parentElement || (r && r.host) || null; } return 'none'; }";

/// Every function the app calls on a page's node (`Runtime.callFunctionOn`,
/// numbers as its only arguments). The extension holds a copy and refuses
/// anything else.
pub const FUNCTIONS: &[&str] = &[SCROLL_WITHIN_FN];

/// What [`PageCdp::scroll_within`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scrolled {
    /// The box around the node moved.
    Moved,
    /// It scrolls, but is already at that end.
    AtEnd,
    /// Nothing around the node scrolls that way.
    Nothing,
}

/// Every expression the app evaluates in a page. The extension holds a copy
/// and refuses anything else (`chrome-extension/src/cdp.js`).
pub const EXPRESSIONS: &[&str] = &[
    FOCUSED_FIELD_JS,
    TEXT_JS,
    READY_JS,
    VISIBILITY_JS,
    SCROLL_UP_JS,
    SCROLL_DOWN_JS,
    SCROLL_LEFT_JS,
    SCROLL_RIGHT_JS,
];

/// Every CDP method the page logic sends. The extension relays these and
/// nothing else.
pub const METHODS: &[&str] = &[
    "Accessibility.getFullAXTree",
    "DOM.describeNode",
    "DOM.getBoxModel",
    "DOM.resolveNode",
    "DOM.scrollIntoViewIfNeeded",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Page.captureScreenshot",
    "Page.getLayoutMetrics",
    "Page.getNavigationHistory",
    "Page.navigate",
    "Page.navigateToHistoryEntry",
    "Runtime.callFunctionOn",
    "Runtime.evaluate",
];

/// The viewport used when the page doesn't say.
pub const FALLBACK_VIEWPORT: (f64, f64) = (1280.0, 860.0);

/// One page, reached over some CDP transport. Implementors provide [`cdp`];
/// everything else is the shared page logic.
///
/// [`cdp`]: PageCdp::cdp
pub trait PageCdp {
    /// Send one CDP command to this page and wait for its answer.
    fn cdp(&self, method: &str, params: Value) -> Result<Value, String>;

    /// Go to `url` (or "back"/"forward"), then wait for it to settle.
    fn navigate(&self, url: &str) -> Result<(), String> {
        match url.trim() {
            "back" | "forward" => {
                let h = self.cdp("Page.getNavigationHistory", json!({}))?;
                let at = h["currentIndex"].as_i64().unwrap_or(0);
                let entries = h["entries"].as_array().cloned().unwrap_or_default();
                let to = if url.trim() == "back" { at - 1 } else { at + 1 };
                let entry = usize::try_from(to)
                    .ok()
                    .and_then(|i| entries.get(i))
                    .ok_or("There's no page to go to that way.")?;
                self.cdp(
                    "Page.navigateToHistoryEntry",
                    json!({ "entryId": entry["id"] }),
                )?;
            }
            u => {
                let r = self.cdp("Page.navigate", json!({ "url": u }))?;
                if let Some(e) = r["errorText"].as_str().filter(|e| !e.is_empty()) {
                    return Err(format!("The page didn't load ({e})."));
                }
            }
        }
        self.settle(Duration::from_secs(15));
        Ok(())
    }

    /// Wait until the document has loaded (or `max` passes).
    fn settle(&self, max: Duration) {
        let end = Instant::now() + max;
        std::thread::sleep(Duration::from_millis(150));
        while Instant::now() < end {
            let ready = self
                .eval(READY_JS)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string));
            if ready.as_deref() == Some("complete") {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// One of the app's own [`EXPRESSIONS`] in the page, its value returned.
    fn eval(&self, expression: &str) -> Result<Value, String> {
        let r = self.cdp(
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true, "silent": true }),
        )?;
        if r.get("exceptionDetails").is_some() {
            return Err("The page didn't answer.".into());
        }
        Ok(r["result"]["value"].clone())
    }

    /// The page's visible text, cut at `max` characters.
    fn text(&self, max: usize) -> String {
        let t = self
            .eval(TEXT_JS)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        cut(t, max)
    }

    /// What the focused field is, followed into shadow roots and same-origin
    /// frames. Focus in a frame the page can't see into (another site's), or
    /// a check that didn't answer, is [`Focus::Unknown`]: never typed into.
    fn focused_field(&self) -> Focus {
        Focus::from_answer(self.eval(FOCUSED_FIELD_JS))
    }

    fn ax_nodes(&self) -> Result<Vec<Value>, String> {
        let r = self.cdp("Accessibility.getFullAXTree", json!({}))?;
        Ok(r["nodes"].as_array().cloned().unwrap_or_default())
    }

    /// The centre of a node, scrolled into view, in CSS pixels.
    fn center_of(&self, backend_node_id: i64) -> Result<(f64, f64), String> {
        let _ = self.cdp(
            "DOM.scrollIntoViewIfNeeded",
            json!({ "backendNodeId": backend_node_id }),
        );
        let bm = self
            .cdp(
                "DOM.getBoxModel",
                json!({ "backendNodeId": backend_node_id }),
            )
            .map_err(|_| "That control isn't on the page any more. Read the page again.")?;
        quad_center(&bm["model"]["content"])
            .ok_or_else(|| "That control has no size on the page.".into())
    }

    /// The node is a password (or one-time code) input, or couldn't be
    /// described: either way nothing is typed into it.
    fn node_is_secret(&self, backend_node_id: i64) -> bool {
        match self.cdp(
            "DOM.describeNode",
            json!({ "backendNodeId": backend_node_id }),
        ) {
            Ok(d) => attrs_are_secret(&d["node"]["attributes"]),
            Err(_) => true,
        }
    }

    /// A real click: move, press, release.
    fn click(&self, x: f64, y: f64) -> Result<(), String> {
        self.cdp(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y }),
        )?;
        self.press_at(x, y)
    }

    /// Whether Chrome is painting the page ([`VISIBILITY_JS`]). No answer
    /// counts as painted: the caller then does what it always did.
    fn painted(&self) -> bool {
        self.eval(VISIBILITY_JS)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .is_none_or(|v| v != "hidden")
    }

    /// Press and release at a point, with no move first: for a page Chrome
    /// isn't painting, where a move waits for a frame that never comes (a
    /// press carries its own position, so the click lands the same).
    fn press_at(&self, x: f64, y: f64) -> Result<(), String> {
        for t in ["mousePressed", "mouseReleased"] {
            self.cdp(
                "Input.dispatchMouseEvent",
                json!({ "type": t, "x": x, "y": y, "button": "left", "clickCount": 1 }),
            )?;
        }
        Ok(())
    }

    /// The pointer over a point, nothing pressed.
    fn hover(&self, x: f64, y: f64) -> Result<(), String> {
        self.cdp(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y }),
        )
        .map(|_| ())
    }

    /// Text at the focused field, as typing would put it there.
    fn insert_text(&self, text: &str) -> Result<(), String> {
        self.cdp("Input.insertText", json!({ "text": text }))
            .map(|_| ())
    }

    fn key(&self, key: Key) -> Result<(), String> {
        let (down, up) = key.events();
        self.cdp("Input.dispatchKeyEvent", down)?;
        self.cdp("Input.dispatchKeyEvent", up)?;
        Ok(())
    }

    /// Scroll the box `backend_node_id` is in by `dx`, `dy` CSS pixels
    /// ([`SCROLL_WITHIN_FN`]): works whether or not Chrome paints the tab.
    fn scroll_within(&self, backend_node_id: i64, dx: f64, dy: f64) -> Result<Scrolled, String> {
        let gone = "That control isn't on the page any more. Read the page again.";
        let node = self
            .cdp(
                "DOM.resolveNode",
                json!({ "backendNodeId": backend_node_id }),
            )
            .map_err(|_| gone.to_string())?;
        let object = node["object"]["objectId"]
            .as_str()
            .ok_or_else(|| gone.to_string())?
            .to_string();
        let r = self.cdp(
            "Runtime.callFunctionOn",
            json!({
                "objectId": object,
                "functionDeclaration": SCROLL_WITHIN_FN,
                "arguments": [{ "value": dx }, { "value": dy }],
                "returnByValue": true,
                "silent": true,
            }),
        )?;
        if r.get("exceptionDetails").is_some() {
            return Err("The page didn't answer.".into());
        }
        Ok(match r["result"]["value"].as_str() {
            Some("moved") => Scrolled::Moved,
            Some("end") => Scrolled::AtEnd,
            _ => Scrolled::Nothing,
        })
    }

    fn wheel(&self, x: f64, y: f64, dx: f64, dy: f64) -> Result<(), String> {
        self.cdp(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy }),
        )
        .map(|_| ())
    }

    /// The viewport's size in CSS pixels.
    fn viewport(&self) -> (f64, f64) {
        self.cdp("Page.getLayoutMetrics", json!({}))
            .ok()
            .and_then(|m| {
                let v = m.get("cssLayoutViewport")?;
                Some((v["clientWidth"].as_f64()?, v["clientHeight"].as_f64()?))
            })
            .unwrap_or(FALLBACK_VIEWPORT)
    }

    /// A JPEG of the viewport, at CSS-pixel size (so a point on it is a
    /// point `click` takes).
    fn screenshot(&self) -> Result<(Vec<u8>, u32, u32), String> {
        let (cw, ch) = self.viewport();
        let r = self.cdp(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": 70, "optimizeForSpeed": true }),
        )?;
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(r["data"].as_str().unwrap_or(""))
            .map_err(|e| e.to_string())?;
        to_css_jpeg(&raw, cw, ch)
    }
}

/// `t`, cut at `max` characters with a note saying so.
pub fn cut(t: String, max: usize) -> String {
    if t.chars().count() > max {
        t.chars().take(max).collect::<String>() + "\n… (cut)"
    } else {
        t
    }
}

/// The centre of a CDP quad (`[x1,y1,…,x4,y4]`).
pub fn quad_center(quad: &Value) -> Option<(f64, f64)> {
    let q: Vec<f64> = quad
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    (q.len() == 8).then(|| {
        (
            (q[0] + q[2] + q[4] + q[6]) / 4.0,
            (q[1] + q[3] + q[5] + q[7]) / 4.0,
        )
    })
}

/// A described node's flat `[name, value, …]` attributes name a password or
/// one-time-code input.
pub fn attrs_are_secret(attributes: &Value) -> bool {
    let attrs: Vec<String> = attributes
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_ascii_lowercase()))
                .collect()
        })
        .unwrap_or_default();
    attrs.chunks(2).any(|kv| match kv {
        [k, v] => {
            (k == "type" && v == "password")
                || (k == "autocomplete" && (v.contains("password") || v.contains("one-time-code")))
        }
        _ => false,
    })
}

/// A screenshot scaled down to the viewport's CSS size, as JPEG.
pub fn to_css_jpeg(raw: &[u8], cw: f64, ch: f64) -> Result<(Vec<u8>, u32, u32), String> {
    let img = image::load_from_memory(raw).map_err(|e| e.to_string())?;
    let (w, h) = (cw.round().max(1.0) as u32, ch.round().max(1.0) as u32);
    let img = if img.width() > w {
        img.resize_exact(w, h, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 70)
        .encode_image(&rgb)
        .map_err(|e| e.to_string())?;
    Ok((out, rgb.width(), rgb.height()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Answers from a script and records what was sent.
    struct Fake {
        sent: RefCell<Vec<(String, Value)>>,
        answer: fn(&str, &Value) -> Result<Value, String>,
    }

    impl PageCdp for Fake {
        fn cdp(&self, method: &str, params: Value) -> Result<Value, String> {
            self.sent.borrow_mut().push((method.into(), params.clone()));
            (self.answer)(method, &params)
        }
    }

    fn fake(answer: fn(&str, &Value) -> Result<Value, String>) -> Fake {
        Fake {
            sent: RefCell::new(Vec::new()),
            answer,
        }
    }

    #[test]
    fn every_method_sent_is_on_the_list() {
        let f = fake(|m, _| {
            Ok(match m {
                "DOM.getBoxModel" => json!({ "model": { "content": [0,0, 10,0, 10,10, 0,10] } }),
                "Runtime.evaluate" => json!({ "result": { "value": "complete" } }),
                _ => json!({}),
            })
        });
        let _ = f.center_of(4);
        let _ = f.click(1.0, 2.0);
        let _ = f.hover(1.0, 2.0);
        let _ = f.key(Key::Enter);
        let _ = f.insert_text("hi");
        let _ = f.wheel(1.0, 1.0, 0.0, 120.0);
        let _ = f.scroll_within(5, 0.0, 120.0);
        let _ = f.viewport();
        let _ = f.text(10);
        let _ = f.focused_field();
        let _ = f.node_is_secret(3);
        let _ = f.ax_nodes();
        let _ = f.navigate("https://example.com/");
        let _ = f.screenshot();
        for (m, p) in f.sent.borrow().iter() {
            assert!(METHODS.contains(&m.as_str()), "{m} isn't allow-listed");
            if m == "Runtime.evaluate" {
                let e = p["expression"].as_str().unwrap();
                assert!(EXPRESSIONS.contains(&e), "an unlisted expression: {e}");
            }
            if m == "Runtime.callFunctionOn" {
                let d = p["functionDeclaration"].as_str().unwrap();
                assert!(FUNCTIONS.contains(&d), "an unlisted function: {d}");
                assert!(p["arguments"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|a| a["value"].is_number()));
            }
        }
    }

    #[test]
    fn scrolling_inside_a_control_is_a_script_on_the_node_never_a_wheel() {
        let f = fake(|m, _| {
            Ok(match m {
                "DOM.resolveNode" => json!({ "object": { "objectId": "obj-1" } }),
                "Runtime.callFunctionOn" => json!({ "result": { "value": "moved" } }),
                _ => json!({}),
            })
        });
        assert_eq!(f.scroll_within(9, 0.0, 120.0).unwrap(), Scrolled::Moved);
        let sent = f.sent.borrow();
        assert!(sent.iter().all(|(m, _)| m != "Input.dispatchMouseEvent"));
        assert_eq!(sent[0].1["backendNodeId"], 9);
        assert_eq!(sent[1].1["objectId"], "obj-1");
        assert_eq!(sent[1].1["arguments"][1]["value"], 120.0);
        drop(sent);
        let f = fake(|m, _| {
            Ok(match m {
                "DOM.resolveNode" => json!({ "object": { "objectId": "o" } }),
                _ => json!({ "result": { "value": "end" } }),
            })
        });
        assert_eq!(f.scroll_within(1, 0.0, -120.0).unwrap(), Scrolled::AtEnd);
        let f = fake(|m, _| {
            Ok(match m {
                "DOM.resolveNode" => json!({ "object": { "objectId": "o" } }),
                _ => json!({ "result": { "value": "none" } }),
            })
        });
        assert_eq!(f.scroll_within(1, 0.0, 120.0).unwrap(), Scrolled::Nothing);
        let f = fake(|_, _| Err("No node with given id found".into()));
        assert!(f
            .scroll_within(1, 0.0, 120.0)
            .unwrap_err()
            .contains("Read the page again"));
        // Never smooth: a tab Chrome isn't painting never animates.
        assert!(SCROLL_WITHIN_FN.contains("behavior: 'instant'"));
    }

    #[test]
    fn centre_of_a_box() {
        let f = fake(|_, _| Ok(json!({ "model": { "content": [0,0, 10,0, 10,20, 0,20] } })));
        assert_eq!(f.center_of(1).unwrap(), (5.0, 10.0));
        let f = fake(|_, _| Ok(json!({ "model": { "content": [] } })));
        assert!(f.center_of(1).is_err());
        let f = fake(|_, _| Err("gone".into()));
        assert!(f.center_of(1).unwrap_err().contains("Read the page again"));
    }

    #[test]
    fn secrets_fail_closed() {
        let f = fake(|_, _| Ok(json!({ "node": { "attributes": ["type", "PASSWORD"] } })));
        assert!(f.node_is_secret(1));
        let f =
            fake(|_, _| Ok(json!({ "node": { "attributes": ["autocomplete", "one-time-code"] } })));
        assert!(f.node_is_secret(1));
        let f = fake(|_, _| Ok(json!({ "node": { "attributes": ["type", "text"] } })));
        assert!(!f.node_is_secret(1));
        let f = fake(|_, _| Err("no".into()));
        assert!(f.node_is_secret(1));
        let f = fake(|_, _| Err("no".into()));
        assert_eq!(f.focused_field(), Focus::Unknown);
    }

    #[test]
    fn a_failed_load_says_why() {
        let f = fake(|m, _| {
            Ok(if m == "Page.navigate" {
                json!({ "errorText": "net::ERR_NAME_NOT_RESOLVED" })
            } else {
                json!({})
            })
        });
        assert!(f
            .navigate("https://nope.invalid/")
            .unwrap_err()
            .contains("ERR_NAME"));
    }

    #[test]
    fn long_text_is_cut_and_says_so() {
        assert_eq!(cut("abc".into(), 5), "abc");
        assert!(cut("abcdef".into(), 3).starts_with("abc\n… (cut)"));
    }
}
