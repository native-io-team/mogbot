//! A frame for the phone that fits the relay (`channel::MAX_PAYLOAD`, 1 MiB less 64 since e02e65e9a).
//!
//! The relay closes a phone's socket with 1009 for any payload past 256 KiB,
//! and the phone asks again at once, so one reply that is too big becomes a
//! loop every couple of seconds (20 Nov: a chat whose latest 100 messages
//! came to 270–299 KB). Over the relay every frame goes through [`fit`]:
//! a reply to a messages read gives up its *oldest* messages and says there
//! are more (the phone pages back with `before`, as it always does); any
//! other long text is cut with a marker; a reply that still can't fit becomes
//! an error the phone can show, never a frame that kills its socket. The
//! direct (Tailscale) path has no such limit and is never touched.

use serde_json::Value;

use super::super::wire::{ProtocolCode, ServerFrame, WireError};

/// What a frame's text may be before sealing: the payload limit (one constant,
/// `channel::MAX_PAYLOAD`) less 1 KiB for the seal's tag, the channel header
/// and the session wrapper.
pub const FRAME_MAX: usize = super::channel::MAX_PAYLOAD - 1024;
/// Text longer than these is cut, longest limit first, until the frame fits.
const CUTS: [usize; 5] = [16 * 1024, 8 * 1024, 4 * 1024, 2 * 1024, 512];
const MARKER: &str = "… [cut: too long to send to the phone]";

fn size(v: &Value) -> usize {
    serde_json::to_string(v).map_or(usize::MAX, |s| s.len())
}

/// Drop the oldest of `messages` until `v` fits, and say there is more.
fn drop_oldest(v: &mut Value) {
    let Some(obj) = v.as_object_mut() else { return };
    let Some(Value::Array(list)) = obj.get("messages") else {
        return;
    };
    let sizes: Vec<usize> = list.iter().map(size).collect();
    let mut total = size(&Value::Object(obj.clone()));
    let mut drop = 0;
    while total > FRAME_MAX && drop + 1 < sizes.len() {
        total = total.saturating_sub(sizes[drop] + 1);
        drop += 1;
    }
    if drop > 0 {
        if let Some(Value::Array(list)) = obj.get_mut("messages") {
            list.drain(..drop);
        }
        obj.insert("more".into(), Value::Bool(true));
    }
}

fn cut_strings(v: &mut Value, limit: usize) {
    match v {
        Value::String(s) if s.len() > limit => {
            let mut end = limit;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            s.truncate(end);
            s.push_str(MARKER);
        }
        Value::Array(a) => a.iter_mut().for_each(|x| cut_strings(x, limit)),
        Value::Object(o) => o.values_mut().for_each(|x| cut_strings(x, limit)),
        _ => {}
    }
}

/// `v` made to fit, or false when nothing short of dropping it would.
fn shrink(v: &mut Value) -> bool {
    if size(v) <= FRAME_MAX {
        return true;
    }
    drop_oldest(v);
    for limit in CUTS {
        if size(v) <= FRAME_MAX {
            return true;
        }
        cut_strings(v, limit);
    }
    size(v) <= FRAME_MAX
}

/// The text to send for `text`: itself when it fits, a smaller one when it
/// can be made to, an error reply for a reply that can't, `None` for an
/// event that can't (the phone catches up from its cursor).
pub fn fit(text: String) -> Option<String> {
    if text.len() <= FRAME_MAX {
        return Some(text);
    }
    let Ok(mut frame) = serde_json::from_str::<Value>(&text) else {
        return None;
    };
    let kind = frame
        .get("t")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let slot = match kind.as_str() {
        "res" => "result",
        "evt" => "event",
        _ => return None,
    };
    let fitted = frame.get_mut(slot).is_some_and(shrink);
    if fitted {
        if let Ok(s) = serde_json::to_string(&frame) {
            if s.len() <= FRAME_MAX {
                tracing::warn!(
                    from = text.len(),
                    to = s.len(),
                    "[Relay] a frame for the phone was trimmed to fit the relay"
                );
                return Some(s);
            }
        }
    }
    if kind == "res" {
        let id = frame.get("id").and_then(Value::as_u64).unwrap_or(0);
        let err = ServerFrame::response(
            id,
            Err(WireError::protocol(
                ProtocolCode::TooLarge,
                "This answer is too big to send to the phone.",
            )),
        );
        tracing::warn!(
            from = text.len(),
            "[Relay] a reply for the phone was too big even trimmed"
        );
        return serde_json::to_string(&err).ok();
    }
    tracing::warn!(
        from = text.len(),
        "[Relay] an event for the phone was too big and was left out"
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chat(n: usize, each: usize) -> String {
        let messages: Vec<Value> = (0..n)
            .map(|i| json!({ "id": format!("m{i:03}"), "ts": i, "kind": "agent", "text": "x".repeat(each) }))
            .collect();
        json!({ "t": "res", "id": 7, "ok": true,
                "result": { "messages": messages, "asOf": {"epoch": "e", "seq": 1}, "more": false } })
        .to_string()
    }

    #[test]
    fn a_frame_that_fits_is_untouched() {
        let t = chat(3, 100);
        assert_eq!(fit(t.clone()).unwrap(), t);
    }

    #[test]
    fn a_chat_one_and_a_half_times_the_limit_gives_up_its_oldest_and_says_there_is_more() {
        let each = FRAME_MAX * 3 / 2 / 100;
        let t = chat(100, each);
        assert!(t.len() > FRAME_MAX);
        let out = fit(t).unwrap();
        assert!(out.len() <= FRAME_MAX, "{}", out.len());
        let v: Value = serde_json::from_str(&out).unwrap();
        let list = v["result"]["messages"].as_array().unwrap();
        assert!(list.len() > 40 && list.len() < 100);
        // The newest are kept, in order, untouched.
        assert_eq!(list.last().unwrap()["id"], "m099");
        assert_eq!(list.last().unwrap()["text"].as_str().unwrap().len(), each);
        assert_eq!(v["result"]["more"], true);
        assert_eq!(v["id"], 7);
    }

    #[test]
    fn one_enormous_message_is_cut_with_a_marker() {
        let out = fit(chat(1, FRAME_MAX * 2)).unwrap();
        assert!(out.len() <= FRAME_MAX);
        assert!(out.contains("cut: too long"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["result"]["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn many_enormous_messages_still_fit() {
        let out = fit(chat(40, FRAME_MAX / 10)).unwrap();
        assert!(out.len() <= FRAME_MAX);
    }

    #[test]
    fn a_reply_with_nothing_to_trim_becomes_an_error() {
        let keys: serde_json::Map<String, Value> = (0..FRAME_MAX / 6)
            .map(|i| (format!("k{i}"), json!(i)))
            .collect();
        let t = json!({ "t": "res", "id": 9, "ok": true, "result": keys }).to_string();
        assert!(t.len() > FRAME_MAX);
        let out = fit(t).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["t"], "res");
        assert_eq!(v["id"], 9);
        assert_eq!(v["ok"], false);
    }

    #[test]
    fn an_event_that_cannot_fit_is_left_out_and_a_big_one_is_cut() {
        let big = json!({ "t": "evt", "seq": 3, "event": { "type": "agents.message",
            "message": { "id": "m", "text": "y".repeat(FRAME_MAX * 2) } } })
        .to_string();
        let out = fit(big).unwrap();
        assert!(out.len() <= FRAME_MAX);
        assert!(out.contains(r#""seq":3"#));
        assert!(fit("z".repeat(FRAME_MAX * 2)).is_none());
    }

    #[test]
    fn text_is_cut_on_a_character_boundary() {
        let t = json!({ "t": "res", "id": 1, "ok": true,
            "result": { "text": "é".repeat(FRAME_MAX) } })
        .to_string();
        let out = fit(t).unwrap();
        assert!(serde_json::from_str::<Value>(&out).is_ok());
    }
}
