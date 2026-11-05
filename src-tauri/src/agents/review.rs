//! What another assistant proposes over the import connector, staged for
//! the user, and the one place it becomes real.
//!
//! The interview (`agents::interview`) can only *propose*: its tools write
//! to a draft held by the talk (`agents::connector`). When it finishes, the
//! draft becomes one card in the Chief's chat ([`ConnectorCard`] with a
//! [`Review`]): every agent with its name, role, instructions, memory,
//! routines (they arrive paused) and the logins it asks for. Nothing exists
//! until the user presses Import on that card ([`apply`]), and then only
//! what they kept ticked.
//!
//! The rules the card enforces, whatever the other assistant sent:
//! - **Never overwrite.** A name already taken here becomes "<Name> (from
//!   Grok)", unless the user chose *Replace* on that agent, which the card
//!   offers only with the instruction diff shown. Replacing also clears the
//!   agent's "Always allow" rules, which were granted for other instructions.
//! - **No grants come across.** Imported agents have no permission rules and
//!   no project; their routines are paused; their login cards don't wake
//!   them (`secrets::Request::quiet`).
//! - **The Chief is never changed by the connector.** What the other
//!   assistant's managing agent knew is offered as one optional item, "Add
//!   to <Chief>'s notes", unticked unless the user ticks it.
//!
//! The card carries everything it shows, so it survives a restart: Import
//! still works from what the user is looking at.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::import::{self, ImportSummary, ImportedRoutine};
use super::store::{self, Approval, ApprovalStatus, MessageKind};
use super::{runner, schedule};
use crate::errors::CommandError;

/// Agents one review may hold.
pub const MAX_PROPOSALS: usize = 30;
/// Characters in one agent's instructions or memory.
pub const MAX_FIELD_CHARS: usize = 20_000;
const MAX_ROUTINES: usize = 20;
const MAX_LOGINS: usize = 10;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CardKind {
    /// "<source> wants to bring its agents over": Allow starts the interview.
    Consent,
    /// The staged agents: Import creates what's ticked.
    Review,
}

/// An import connector card, carried on an [`Approval`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCard {
    pub kind: CardKind,
    pub talk_id: String,
    /// The other assistant, as it named itself (cleaned: `connector::clean_source`).
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<Review>,
}

/// Whether this card is an import review (kept across restarts).
pub fn is_review(approval: &Approval) -> bool {
    approval
        .connector
        .as_ref()
        .is_some_and(|c| c.kind == CardKind::Review)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub proposals: Vec<Proposal>,
    /// What the other assistant's managing agent knew, offered as an optional
    /// addition to the Chief's notes. Never applied unless ticked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chief_notes: Option<String>,
    /// The interviewer's one-paragraph summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    /// Stable within the review: what a pick names.
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub memory: String,
    #[serde(default)]
    pub routines: Vec<ProposedRoutine>,
    #[serde(default)]
    pub logins: Vec<ProposedLogin>,
    /// An agent here already has this name: what it is now, for the diff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clash: Option<Clash>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedRoutine {
    pub when: String,
    pub what: String,
    /// What it would be, read by the same parser as every routine
    /// ("every weekday at 09:00"), or why it can't be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedLogin {
    pub name: String,
    pub purpose: String,
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clash {
    pub agent_id: String,
    pub role: String,
    pub instructions: String,
}

/// What the user kept on the card. `None` (the phone's Allow): every agent,
/// none replacing, no notes for the Chief.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Picks {
    pub agents: Vec<Pick>,
    #[serde(default)]
    pub chief_notes: bool,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub key: String,
    /// Replace the agent of the same name here, instead of adding a copy.
    #[serde(default)]
    pub replace: bool,
}

/* ---------------------------------------------------------------- text */

/// Text from the other assistant: no control or format characters (bidi
/// overrides, zero-width joiners), except newlines and tabs; trimmed; capped.
pub fn clean_text(raw: &str, max: usize) -> String {
    raw.chars()
        .filter(|c| *c == '\n' || *c == '\t' || !(c.is_control() || is_format(*c)))
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Unicode's format characters (category Cf) that can disguise text: bidi
/// embeddings and overrides, zero-width spaces and joiners, the BOM, and the
/// invisible operators and tag characters.
pub fn is_format(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x061C | 0x180E
        | 0x200B..=0x200F
        | 0x202A..=0x202E
        | 0x2060..=0x2064
        | 0x2066..=0x206F
        | 0xFEFF
        | 0xFFF9..=0xFFFB
        | 0xE0000..=0xE007F)
}

/// One line: what a name or a label may be.
pub fn clean_line(raw: &str, max: usize) -> String {
    clean_text(raw, max * 4)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// Names an import can't give an agent: the user, the Chief, or anything
/// passing for them.
pub fn reserved_name(name: &str, chief: &str) -> bool {
    let n = name.trim().to_lowercase();
    let n = n.trim_matches(|c: char| !c.is_alphanumeric());
    [
        "you",
        "user",
        "the user",
        "me",
        "chief",
        "chief of staff",
        "system",
    ]
    .contains(&n)
        || n == chief.trim().to_lowercase()
        || n == crate::brand::NAME.to_lowercase()
}

/// Whether any of an agent's fields carries something that looks like a
/// credential, and what.
pub fn secret_in(p: &Proposal) -> Option<&'static str> {
    let routine_text = p
        .routines
        .iter()
        .flat_map(|r| [r.when.as_str(), r.what.as_str()]);
    let login_text = p
        .logins
        .iter()
        .flat_map(|l| [l.name.as_str(), l.purpose.as_str()]);
    [
        p.name.as_str(),
        p.role.as_str(),
        p.instructions.as_str(),
        p.memory.as_str(),
    ]
    .into_iter()
    .chain(routine_text)
    .chain(login_text)
    .find_map(super::connector::looks_like_secret)
}

/// The agent here with exactly this name (never matched by id).
fn by_name(name: &str) -> Option<store::Agent> {
    store::list()
        .ok()?
        .into_iter()
        .find(|a| a.name.eq_ignore_ascii_case(name.trim()))
}

/// What a routine would become, read by the schedule's own parser.
pub fn read_routine(when: &str, what: &str) -> ProposedRoutine {
    let tz = chrono::Local;
    let (schedule, refused) = match schedule::check(&tz, when, what, store::now_ms()) {
        Ok((Some(repeat), _)) => (Some(schedule::describe(&repeat)), None),
        Ok((None, at)) => (Some(schedule::describe_schedule(&tz, None, at)), None),
        Err(refused) => (None, Some(refused.plain())),
    };
    ProposedRoutine {
        when: when.to_string(),
        what: what.to_string(),
        schedule,
        refused,
    }
}

/// A proposal as the other assistant sent it, cleaned and capped, or why it
/// can't be staged.
pub fn proposal(key: String, args: &serde_json::Value, chief: &str) -> Result<Proposal, String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let name = clean_line(s("name"), 40);
    if name.is_empty() {
        return Err("Give the agent a name.".into());
    }
    if reserved_name(&name, chief) {
        return Err(format!(
            "\"{name}\" is a name kept for the user or the Chief here. Give this agent its own name."
        ));
    }
    let routines: Vec<ProposedRoutine> = args
        .get("routines")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .take(MAX_ROUTINES)
        .filter_map(|r| {
            let when = clean_line(r.get("when")?.as_str()?, 120);
            let what = clean_text(r.get("what")?.as_str()?, 2_000);
            (!when.is_empty() && !what.is_empty()).then(|| read_routine(&when, &what))
        })
        .collect();
    let logins: Vec<ProposedLogin> = args
        .get("logins")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .take(MAX_LOGINS)
        .filter_map(|l| {
            let name = clean_line(l.get("name")?.as_str()?, 40);
            let purpose = clean_line(l.get("purpose").and_then(|v| v.as_str()).unwrap_or(""), 200);
            let kind = clean_line(
                l.get("kind").and_then(|v| v.as_str()).unwrap_or("other"),
                20,
            );
            (!name.is_empty()).then_some(ProposedLogin {
                name,
                purpose,
                kind,
            })
        })
        .collect();
    let p = Proposal {
        key,
        name,
        role: clean_line(s("role"), 200),
        instructions: clean_text(s("instructions"), MAX_FIELD_CHARS),
        memory: clean_text(s("memory"), MAX_FIELD_CHARS),
        routines,
        logins,
        clash: None,
    };
    if let Some(what) = secret_in(&p) {
        return Err(format!(
            "That looks like it contains {what}. Leave credentials out: list the login by name in `logins` and the user is asked for it here, on a secure card."
        ));
    }
    Ok(p)
}

/// The review as it's shown: each proposal checked against the agents here
/// now, so a clash shows what it would replace.
pub fn with_clashes(mut review: Review) -> Review {
    for p in &mut review.proposals {
        p.clash = by_name(&p.name).map(|a| Clash {
            role: a.role.clone(),
            instructions: store::read_instructions(&a.id).unwrap_or_default(),
            agent_id: a.id,
        });
    }
    review
}

/// "Finance (from Grok)", or "Finance (from Grok 2)" when that's taken too.
pub fn unique_name(name: &str, source: &str) -> String {
    let base: String = name.chars().take(20).collect();
    let src: String = source.chars().take(14).collect();
    let mut n = 1;
    loop {
        let candidate = if n == 1 {
            format!("{base} (from {src})")
        } else {
            format!("{base} (from {src} {n})")
        };
        if by_name(&candidate).is_none() || n > 50 {
            return candidate;
        }
        n += 1;
    }
}

/// The card's detail line: what the phone (and any client that only knows
/// Allow / Deny) shows. Allow there imports every agent as new, no notes
/// for the Chief.
pub fn detail(review: &Review) -> String {
    let mut lines: Vec<String> = review
        .proposals
        .iter()
        .map(|p| {
            let mut line = if p.role.is_empty() {
                p.name.clone()
            } else {
                format!("{} · {}", p.name, p.role)
            };
            if p.clash.is_some() {
                line.push_str(" (name taken here: comes in as a copy)");
            }
            line
        })
        .collect();
    lines.push(
        "Nothing is created until you import. Routines arrive paused; logins are asked for on secure cards.".into(),
    );
    lines.join("\n")
}

/// What came of pressing Import.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// The agents made or replaced, as named here.
    pub agents: Vec<String>,
    pub replaced: Vec<String>,
    pub skipped: Vec<(String, String)>,
    pub chief_notes: bool,
    /// Routines that couldn't be set, by agent, with why.
    pub routines_refused: Vec<String>,
}

/// Make what the user kept. The only path by which the connector's
/// proposals become agents.
pub fn apply(
    app: Option<&AppHandle>,
    chief: &store::Agent,
    card: &ConnectorCard,
    picks: Option<&Picks>,
) -> Result<Applied, CommandError> {
    let review = card
        .review
        .as_ref()
        .ok_or_else(|| CommandError::expected("That card has nothing to import."))?;
    let source = card.source.as_str();
    let mut out = Applied::default();
    let chosen: Vec<(&Proposal, bool)> = match picks {
        None => review.proposals.iter().map(|p| (p, false)).collect(),
        Some(picks) => picks
            .agents
            .iter()
            .filter_map(|pick| {
                let p = review.proposals.iter().find(|p| p.key == pick.key)?;
                // Replace is only on offer where the card showed a clash.
                Some((p, pick.replace && p.clash.is_some()))
            })
            .collect(),
    };
    for (p, replace) in chosen {
        match apply_one(app, p, replace, source) {
            Ok((name, replaced, refused)) => {
                if replaced {
                    out.replaced.push(name.clone());
                }
                out.routines_refused.extend(
                    refused
                        .into_iter()
                        .map(|r| format!("{name}: \"{}\" ({})", r.when, r.detail)),
                );
                out.agents.push(name);
            }
            Err(e) => out.skipped.push((p.name.clone(), e.to_string())),
        }
    }
    if picks.is_some_and(|p| p.chief_notes) {
        if let Some(notes) = review
            .chief_notes
            .as_deref()
            .filter(|n| !n.trim().is_empty())
        {
            import::add_memory(&chief.id, notes, &format!("{source} (you added these)"))?;
            out.chief_notes = true;
        }
    }
    Ok(out)
}

fn apply_one(
    app: Option<&AppHandle>,
    p: &Proposal,
    replace: bool,
    source: &str,
) -> Result<(String, bool, Vec<import::RoutineOutcome>), CommandError> {
    let routines: Vec<ImportedRoutine> = p
        .routines
        .iter()
        .map(|r| ImportedRoutine {
            when: r.when.clone(),
            what: r.what.clone(),
        })
        .collect();
    let mut summary = ImportSummary::default();
    let existing = by_name(&p.name);
    let (agent, replaced) = match existing {
        Some(current) if replace && !current.is_main => {
            // The user chose this, with the diff in front of them. Rules
            // granted for the old instructions don't carry over to new ones.
            let role = p.role.clone();
            let updated = store::update(&current.id, |a| {
                if !role.is_empty() {
                    a.role = role;
                }
                a.permissions.clear();
            })?;
            store::write_instructions(&store::agent_home(&updated.id)?, &updated, &p.instructions)?;
            (updated, true)
        }
        Some(_) => (create(&unique_name(&p.name, source), p)?, false),
        None => (create(&p.name, p)?, false),
    };
    import::add_memory(&agent.id, &p.memory, source)?;
    import::add_routines(&agent, &routines, true, &mut summary);
    if let Some(app) = app {
        for login in &p.logins {
            let purpose = if login.purpose.is_empty() {
                format!("A login {} used with {source}", agent.name)
            } else {
                login.purpose.clone()
            };
            let args = serde_json::json!({
                "name": login.name, "purpose": purpose, "kind": login.kind,
            });
            super::mcp::request_secret_quiet(app, &agent, &args);
        }
        let note = if replaced {
            format!(
                "Replaced from {source}: new instructions, your Always-allow rules for it removed."
            )
        } else {
            format!(
                "Imported from {source}. It starts when you message it; its routines are paused."
            )
        };
        let _ = runner::record(app, runner::new_message(&agent.id, MessageKind::Note, note));
    }
    Ok((agent.name, replaced, summary.routines_refused))
}

fn create(name: &str, p: &Proposal) -> Result<store::Agent, CommandError> {
    store::create(store::NewAgent {
        name: name.to_string(),
        role: p.role.clone(),
        instructions: p.instructions.clone(),
        shape: None,
        color: None,
        is_main: false,
    })
}

/// The pending review card in the Chief's chat with this request id.
pub fn find_card(
    chief_id: &str,
    request_id: &str,
) -> Result<(Approval, ConnectorCard), CommandError> {
    let approval = store::find_approval(chief_id, request_id)?
        .ok_or_else(|| CommandError::expected("That card no longer exists."))?;
    if approval.status != ApprovalStatus::Pending {
        return Err(CommandError::expected("That card was already answered."));
    }
    let card = approval
        .connector
        .clone()
        .ok_or_else(|| CommandError::expected("That isn't an import card."))?;
    Ok((approval, card))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hidden_characters_and_reserved_names_never_reach_the_card() {
        assert_eq!(clean_line("Fin\u{202E}ance\u{200B} ", 40), "Finance");
        assert_eq!(clean_text("a\u{2066}b\nc\u{7}", 100), "ab\nc");
        for name in ["You", "user", "Chief of Staff", "  chief ", "Morgan"] {
            assert!(reserved_name(name, "Morgan"), "{name}");
        }
        assert!(!reserved_name("Finance", "Morgan"));
        let err = proposal("k".into(), &json!({"name": "You"}), "Chief of Staff").unwrap_err();
        assert!(err.contains("kept for the user"), "{err}");
    }

    #[test]
    fn a_credential_anywhere_in_a_proposal_is_refused() {
        for args in [
            json!({"name": "Finance", "instructions": "use sk-ant-api03-abcdefghijklmnopqrstuv"}),
            json!({"name": "Finance", "routines": [{"when": "every day at 9am", "what": "log in with password: hunter22"}]}),
            json!({"name": "Finance", "logins": [{"name": "stripe", "purpose": "sk_live_51HxAbCdEfGhIjKlMnOp", "kind": "api_key"}]}),
        ] {
            assert!(proposal("k".into(), &args, "Chief").is_err(), "{args}");
        }
        let fine = proposal(
            "k".into(),
            &json!({"name": "Finance", "logins": [{"name": "stripe_key", "purpose": "Reads invoices", "kind": "api_key"}]}),
            "Chief",
        )
        .unwrap();
        assert_eq!(fine.logins[0].name, "stripe_key");
    }
}
