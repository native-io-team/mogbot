//! The live notifier: the Mac tells each connected phone what to post.
//!
//! `agents::notify` decides whether something is news (mute, quiet hours,
//! the chat on screen anywhere, the per-turn coalescing) and, when the user
//! isn't at the desk, hands it here as well as to the push relay. Every
//! socket whose app lists `alerts` in its hello gets one `alert` event,
//! except a socket in front with that agent's chat open. The phone posts it
//! (an approval with its card's own words and buttons, `actionable.ts`) and
//! takes it back when the card's new state arrives over the journal.
//!
//! - **What it carries**: the agent's and message's ids, the agent's name and
//!   one plain line, clipped. Both go through `agents::secrets::redact` again
//!   (messages are redacted when recorded) and `agents::work::scrub`, which
//!   blanks anything shaped like a credential; the phone's own `redact` is a
//!   third wall.
//! - **Never journaled**: a reconnecting phone gets the cards themselves,
//!   not a pile of old alerts.
//! - **Bursts**: past a few non-approval alerts in a short window the rest
//!   stay silent, as on the desk; an approval always goes (an agent is
//!   blocked on it).
//! - **Where it can't reach**: a phone whose app iOS has suspended. That is
//!   what the relay's push is for (`push.rs`); see docs/mobile.md,
//!   "Notifications".

use std::sync::Mutex;
use std::time::Instant;

use super::hub::HubItem;
use super::wire::{AlertKind, LiveAlert};
use super::Companion;
use crate::agents::notify::Limiter;

/// Known secret values, then credential shapes, then one line.
fn plain(text: &str, max: usize) -> String {
    let known = crate::agents::secrets::redact(text);
    let line = known
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    clip(&crate::agents::work::scrub(line), max)
}

/// A notification's title and body, in characters: what a Lock Screen shows.
const TITLE_MAX: usize = 60;
const BODY_MAX: usize = 180;

#[derive(Default)]
pub struct Alerts {
    limiter: Mutex<Limiter>,
}

fn clip(line: &str, max: usize) -> String {
    if line.chars().count() <= max {
        return line.to_string();
    }
    let mut out: String = line.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// An alert as phones get it: ids, the agent's name and one redacted line.
pub fn alert(
    agent_id: &str,
    message_id: Option<&str>,
    title: &str,
    body: &str,
    kind: AlertKind,
) -> LiveAlert {
    LiveAlert {
        agent_id: agent_id.to_string(),
        message_id: message_id.map(str::to_string),
        title: plain(title, TITLE_MAX),
        body: plain(body, BODY_MAX),
        kind,
    }
}

/// Send one alert to every connected phone that posts them. False when
/// nothing went out: the phone server is off, nobody is connected, or the
/// burst cap held it back.
pub fn send(c: &Companion, alert: LiveAlert) -> bool {
    if !c.registry.read(|s| s.enabled) || c.hub.listeners() == 0 {
        return false;
    }
    if alert.kind != AlertKind::Approval
        && !c
            .alerts
            .limiter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .allow(Instant::now())
    {
        tracing::debug!("[Companion] alert for {} held back (burst)", alert.agent_id);
        return false;
    }
    c.hub.signal(HubItem::Alert { alert });
    true
}

/// The hook in `agents::notify`, beside the push relay's.
pub fn raise(alert: LiveAlert) {
    if let Some(c) = super::desktop::get() {
        send(&c, alert);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_alert_says_one_clipped_line_and_no_secret() {
        let a = alert(
            "a1",
            Some("m1"),
            "Acme Site",
            "\n  Deploy with token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB now\nsecond line",
            AlertKind::Reply,
        );
        assert_eq!(a.message_id.as_deref(), Some("m1"));
        assert!(!a.body.contains("ghp_0123456789"), "{}", a.body);
        assert!(!a.body.contains("second line"), "{}", a.body);
        let long = alert("a1", None, "x", &"word ".repeat(100), AlertKind::Reply);
        assert_eq!(long.body.chars().count(), BODY_MAX);
        assert!(long.body.ends_with('…'));
    }

    #[test]
    fn the_wire_shape_is_models_alert() {
        let a = alert(
            "a1",
            Some("m1"),
            "Acme",
            "Needs your OK",
            AlertKind::CheckIn,
        );
        let v = serde_json::to_value(super::super::wire::Event::Alert { alert: a }).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "type": "alert",
                "alert": { "agentId": "a1", "messageId": "m1", "title": "Acme",
                           "body": "Needs your OK", "kind": "check_in" }
            })
        );
    }
}
