//! Bringing the user's agents over, as a conversation with the Chief.
//!
//! First run asks one thing under the Chief's greeting: which assistant
//! their agents live in (Grok, ChatGPT, Claude, something else) or start
//! fresh. Picking one is the yes. From there the Chief walks them through
//! Remote Access one message at a time: Tailscale, the link, the assistant's
//! connector, the message to send it. Each step is an ordinary Chief message
//! (so it scrolls back, reaches the phone and reads as a conversation) with
//! a `guide` block the desk and the phone draw as that step's one action.
//!
//! The steps are scripted, not model turns: instant, free, and never wrong
//! about what comes next. The app decides which step is current from the
//! same checks Remote Access already shows (`lib/onboardingFlow.ts`'s
//! `guideStep`), and asks for it here; this side owns the words and posts
//! each step once. Anything the user types meanwhile goes to the real Chief,
//! briefed with where the guide stands ([`briefing_line`]).
//!
//! Saved beside the agents (`import-guide.json`); while it runs the import
//! choice is `Bringing`, so the "Already have agents?" ask is gone and the
//! interview's consent is the pick they already made.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;

use super::import_choice::{self, Choice};
use super::runner;
use super::store::{self, MessageKind};
use crate::errors::CommandError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    /// Install Tailscale on this Mac and sign in.
    Tailscale,
    /// Turn on the link (Remote Access).
    Link,
    /// Tailscale's one-time approval for a public link.
    Approve,
    /// Add the link to the assistant as a connector.
    Connect,
    /// Send the assistant the import message.
    Send,
    /// The assistant is telling the Chief about the agents.
    Talking,
}

impl Step {
    pub fn parse(value: &str) -> Result<Step, CommandError> {
        serde_json::from_value(serde_json::Value::String(value.trim().to_string())).map_err(|_| {
            super::err_invalid("step", "Pick tailscale, link, approve, connect, send or talking.")
        })
    }
}

/// The assistants the guide knows by name; anything else is "other".
pub fn assistant_name(id: &str) -> &'static str {
    match id {
        "grok" => "Grok",
        "chatgpt" => "ChatGPT",
        "claude" => "Claude",
        _ => "your assistant",
    }
}

fn known(id: &str) -> &'static str {
    match id.trim().to_ascii_lowercase().as_str() {
        "grok" => "grok",
        "chatgpt" => "chatgpt",
        "claude" => "claude",
        _ => "other",
    }
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// What the Chief says at each step. Short, warm, and each one says *why*,
/// so by the end they know how this works without having read anything.
pub fn words(step: Step, assistant: &str) -> String {
    let a = assistant_name(assistant);
    let a_cap = capital(a);
    match step {
        Step::Tailscale => format!(
            "Nice, let's bring them over. {a_cap} needs a private way to reach me on this Mac, \
             and that's a free app called Tailscale. Install it and sign in. \
             I'll notice the moment it's on."
        ),
        Step::Link => format!(
            "Tailscale's on. Now I'll open a private link to me that only you hand out. \
             {a_cap} uses it to talk to me, and nobody else can."
        ),
        Step::Approve => "Tailscale wants one OK before the link goes live. Approve it on the \
             page that opens and I'll carry on by myself."
            .to_string(),
        Step::Connect => format!(
            "My link is live. Now add me to {a} as a connector. It takes a minute, \
             and I'll see it the moment {a} connects."
        ),
        Step::Send => format!(
            "{a_cap} can reach me now. Last step: send {a} this message. \
             When it says hello I'll ask you once, right here, before I listen. \
             That's how I ask before anything that matters."
        ),
        Step::Talking => format!(
            "{a_cap} is telling me about your agents now. Sit back. \
             I'll show you the whole team before anything is created."
        ),
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Guide {
    /// `grok`, `chatgpt`, `claude` or `other`.
    pub assistant: String,
    /// Steps already said, in order.
    #[serde(default)]
    pub posted: Vec<Step>,
    #[serde(default)]
    pub started_at: i64,
}

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Result<std::path::PathBuf, CommandError> {
    Ok(store::agents_root()?.join("import-guide.json"))
}

fn read() -> Option<Guide> {
    let p = path().ok()?;
    let bytes = std::fs::read(p).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write(guide: &Guide) -> Result<(), CommandError> {
    let json = serde_json::to_vec_pretty(guide).map_err(super::err_other)?;
    store::write_atomic(&path()?, &json)
}

/// The guide, while one runs: the import choice is `Bringing`.
pub fn current() -> Option<Guide> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if import_choice::choice() != Choice::Bringing {
        return None;
    }
    read()
}

fn chief_id() -> Result<String, CommandError> {
    store::list()?
        .into_iter()
        .find(|a| a.is_main)
        .map(|a| a.id)
        .ok_or_else(|| CommandError::expected("The Chief of Staff isn't set up yet."))
}

/// The user picked their assistant under the greeting. Their pick shows as
/// their own message (the conversation reads right), the choice becomes
/// `Bringing`, and the app asks for the first step next.
pub fn start(app: &AppHandle, assistant: &str) -> Result<Guide, CommandError> {
    let chief = chief_id()?;
    let assistant = known(assistant);
    let now = store::now_ms();
    let guide = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        import_choice::set(Choice::Bringing, now)?;
        let guide = Guide {
            assistant: assistant.to_string(),
            posted: Vec::new(),
            started_at: now,
        };
        write(&guide)?;
        guide
    };
    let said = match assistant {
        "other" => "Another assistant".to_string(),
        a => assistant_name(a).to_string(),
    };
    runner::record(app, runner::new_message(&chief, MessageKind::User, said))?;
    Ok(guide)
}

/// The block that marks a Chief message as a guide step: drawn as that
/// step's action on the desk and the phone; a build that doesn't know it
/// shows the words alone.
pub fn block(step: Step, assistant: &str) -> serde_json::Value {
    serde_json::json!({
        "v": 1,
        "items": [{
            "kind": "guide",
            "summary": words(step, assistant),
            "step": step,
            "assistant": assistant,
        }],
    })
}

/// Say `step`, once. False when it was already said or no guide runs.
pub fn post(app: &AppHandle, step: Step) -> Result<bool, CommandError> {
    let chief = chief_id()?;
    let guide = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if import_choice::choice() != Choice::Bringing {
            return Ok(false);
        }
        let Some(mut guide) = read() else {
            return Ok(false);
        };
        if guide.posted.contains(&step) {
            return Ok(false);
        }
        guide.posted.push(step);
        write(&guide)?;
        guide
    };
    let mut message = runner::new_message(&chief, MessageKind::Agent, words(step, &guide.assistant));
    message.blocks = Some(block(step, &guide.assistant));
    runner::record(app, message)?;
    Ok(true)
}

/// "Start fresh" partway: the guide ends and the question is answered.
pub fn stop(now: i64) -> Result<(), CommandError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if import_choice::choice() == Choice::Bringing {
        import_choice::set(Choice::Declined, now)?;
    }
    Ok(())
}

/// One line for the Chief's own turn while the guide runs, so a question
/// mid-way ("what's Tailscale?") is answered knowing exactly where they are.
pub fn briefing_line() -> Option<String> {
    let guide = current()?;
    let a = assistant_name(&guide.assistant);
    let at = guide
        .posted
        .last()
        .map(|s| match s {
            Step::Tailscale => "installing Tailscale on this Mac",
            Step::Link => "turning on the private link (Remote Access)",
            Step::Approve => "approving the link in Tailscale",
            Step::Connect => "adding the link to the assistant as a connector",
            Step::Send => "sending the assistant the import message",
            Step::Talking => "the assistant is telling you about their agents",
        })
        .unwrap_or("just starting");
    Some(format!(
        "First run: the app is walking the user through bringing their agents over from {a} \
         over Remote Access, one step at a time in this chat (cards with buttons, ticked by the \
         app's own checks). They're at: {at}. Answer questions about it in a line or two, \
         calmly and simply, then let them carry on with the step's button; never repeat the \
         steps or post the link (only the app copies it)."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_plain_words() {
        assert_eq!(serde_json::to_value(Step::Connect).unwrap(), "connect");
        assert_eq!(Step::parse("talking").unwrap(), Step::Talking);
        assert!(Step::parse("dance").is_err());
    }

    #[test]
    fn every_step_names_the_assistant_and_never_the_link() {
        for a in ["grok", "chatgpt", "claude", "other"] {
            for step in [
                Step::Tailscale,
                Step::Link,
                Step::Connect,
                Step::Send,
                Step::Talking,
            ] {
                let w = words(step, a);
                assert!(w.contains(assistant_name(a)) || w.contains(&capital(assistant_name(a))), "{w}");
                assert!(!w.contains("http"), "{w}");
            }
        }
        assert!(words(Step::Send, "other").starts_with("Your assistant"));
    }

    #[test]
    fn a_guide_step_is_a_block_older_builds_skip() {
        let b = block(Step::Send, "grok");
        assert_eq!(b["v"], 1);
        assert_eq!(b["items"][0]["kind"], "guide");
        assert_eq!(b["items"][0]["step"], "send");
        // Not one of the kinds an agent may `show`.
        assert!(super::super::blocks::parse(&serde_json::json!({ "blocks": b["items"] })).is_err());
    }

    #[test]
    fn the_pick_starts_it_each_step_is_said_once_and_start_fresh_ends_it() {
        let _serial = store::tests_lock();
        let root = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(root.path().to_path_buf()));
        assert!(current().is_none());
        // What `start` saves, without the app to record the user's line.
        import_choice::set(Choice::Bringing, 1).unwrap();
        write(&Guide {
            assistant: known("Grok").into(),
            posted: vec![],
            started_at: 1,
        })
        .unwrap();
        let g = current().unwrap();
        assert_eq!(g.assistant, "grok");
        assert!(briefing_line().unwrap().contains("Grok"));
        stop(2).unwrap();
        assert_eq!(import_choice::choice(), Choice::Declined);
        assert!(current().is_none());
        assert!(briefing_line().is_none());
        store::set_root_for_tests(None);
    }
}
