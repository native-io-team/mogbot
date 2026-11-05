//! The Chief of Staff's room tools: `create_room`, `add_to_room` and
//! `remove_from_room`. They follow the other management tools' rules
//! (`mcp.rs`): Chief-only, and a turn answering text from outside (a
//! "When…" routine's items, or a message or room hand-off that carries that
//! taint, `runner::from_outside`) asks the user on a card first. The room's
//! own limits are `rooms`'s: two to six members, and at most
//! [`rooms::TURN_CAP`] agent turns per message once people talk in it (these
//! tools send nothing into a room, so they start no turns).
//!
//! Every call is checked in full before any card ([`gate`]), so the user is
//! never asked about a room that couldn't be made.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::rooms::{self, Made, Room, RoomChange};
use super::runner;
use super::store::{self, AgentRef, MessageKind};

pub struct Def {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: fn() -> Value,
}

pub const TOOLS: &[Def] = &[
    Def {
        name: "create_room",
        description: "Make a room: one thread where the user talks to two to six agents at once (each keeps its own memory and session; a message goes to whoever the user @mentions, @everyone, or the room's lead). It appears in the user's sidebar under Rooms. Use it when a team should be talked to together (a launch, a project crew). Agents must exist first (create_agent). Include yourself as a member if you'll lead it. You speak in a room only when you're asked there, so tell the user it's there and how to use it.",
        schema: || json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Short: \"Launch\", \"Month end\". Under 60 characters." },
                "members": { "type": "array", "items": { "type": "string" }, "description": "Two to six agents, by name or id." },
                "lead": { "type": "string", "description": "Optional: the member who answers a message that mentions nobody. Left out, it's you when you're a member; otherwise the user is asked who should answer." },
                "purpose": { "type": "string", "description": "One line on what the room is for. Shown on the room and to every member when it answers there." }
            },
            "required": ["name", "members", "purpose"]
        }),
    },
    Def {
        name: "add_to_room",
        description: "Add an agent to a room (at most six). It's given a copy of every file sent there so far, and sees the room's recent messages the next time it answers there.",
        schema: || json!({
            "type": "object",
            "properties": {
                "room": { "type": "string", "description": "The room's name or id." },
                "agent": { "type": "string", "description": "The agent's name or id." }
            },
            "required": ["room", "agent"]
        }),
    },
    Def {
        name: "remove_from_room",
        description: "Take an agent out of a room. A room keeps at least two members; to end one, ask the user to delete it from its menu.",
        schema: || json!({
            "type": "object",
            "properties": {
                "room": { "type": "string", "description": "The room's name or id." },
                "agent": { "type": "string", "description": "The agent's name or id." }
            },
            "required": ["room", "agent"]
        }),
    },
];

pub fn find(name: &str) -> Option<&'static Def> {
    TOOLS.iter().find(|t| t.name == name)
}

fn text(message: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": message.into() }] })
}

fn error(message: impl Into<String>) -> Value {
    crate::agent_bridge::tool_error_result(&message.into())
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// What a call would do, checked.
#[derive(Debug)]
pub enum Plan {
    Create {
        name: String,
        members: Vec<store::Agent>,
        lead: Option<store::Agent>,
        purpose: Option<String>,
    },
    Add {
        room: Room,
        agent: store::Agent,
    },
    Remove {
        room: Room,
        agent: store::Agent,
    },
}

/// Go ahead, or ask the user first (a turn answering outside text).
#[derive(Debug)]
pub enum Gate {
    Go(Plan),
    Ask {
        title: String,
        detail: String,
        plan: Plan,
    },
}

/// Whether `caller` may make this call, and whether the user is asked first.
/// `outside`: the turn in progress answers text from outside.
pub fn gate(
    caller: &store::Agent,
    outside: bool,
    tool: &str,
    args: &Value,
) -> Result<Gate, String> {
    if !caller.is_main {
        return Err("Only the Chief of Staff can do that. Ask it with message_agent.".into());
    }
    let plan = plan(tool, args)?;
    if !outside {
        return Ok(Gate::Go(plan));
    }
    let (title, what) = card(&plan);
    Ok(Gate::Ask {
        title,
        detail: format!("{what}\n\n{}", super::mcp::OUTSIDE_WHY),
        plan,
    })
}

fn agent_named(name: &str) -> Result<store::Agent, String> {
    match store::find(name) {
        Ok(Some(a)) => Ok(a),
        _ => Err(format!("There's no agent called {name}.")),
    }
}

fn room_named(name: &str) -> Result<Room, String> {
    match rooms::find(name) {
        Ok(Some(r)) => Ok(r),
        _ => Err(format!("There's no room called {name}.")),
    }
}

fn ids(agents: &[store::Agent]) -> Vec<String> {
    agents.iter().map(|a| a.id.clone()).collect()
}

fn names(agents: &[store::Agent]) -> String {
    rooms::default_name(&agents.iter().map(|a| a.name.clone()).collect::<Vec<_>>())
}

/// The members a room has now, as agents (one deleted since is left out).
fn members_of(room: &Room) -> Vec<store::Agent> {
    room.members
        .iter()
        .filter_map(|m| store::get(m).ok())
        .collect()
}

pub fn plan(tool: &str, args: &Value) -> Result<Plan, String> {
    match tool {
        "create_room" => {
            let Some(name) = arg(args, "name") else {
                return Err("`name` is required.".into());
            };
            let given: Vec<&str> = args
                .get("members")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let members = given
                .iter()
                .map(|m| agent_named(m.trim()))
                .collect::<Result<Vec<_>, _>>()?;
            let lead = arg(args, "lead").map(agent_named).transpose()?;
            if rooms::find(name).ok().flatten().is_some() {
                return Err(format!(
                    "There's already a room called {name}. Use add_to_room or remove_from_room to change who's in it."
                ));
            }
            let made = Made {
                lead: lead.as_ref().map(|l| l.id.clone()),
                purpose: arg(args, "purpose").map(String::from),
                by: None,
            };
            // Two to six real agents, a name that fits, a lead who is in it.
            let rooms::Checked {
                members,
                name,
                lead: lead_id,
                purpose,
            } = rooms::check_new(Some(name), &ids(&members), &made).map_err(|e| e.to_string())?;
            let lead = lead_id.and_then(|id| members.iter().find(|m| m.id == id).cloned());
            Ok(Plan::Create {
                name,
                members,
                lead,
                purpose,
            })
        }
        "add_to_room" | "remove_from_room" => {
            let (Some(room), Some(agent)) = (arg(args, "room"), arg(args, "agent")) else {
                return Err("Both `room` and `agent` are required.".into());
            };
            let room = room_named(room)?;
            let agent = agent_named(agent)?;
            let current = members_of(&room);
            let inside = current.iter().any(|m| m.id == agent.id);
            if tool == "add_to_room" {
                if inside {
                    return Err(format!("{} is already in {}.", agent.name, room.name));
                }
                if current.len() >= rooms::MAX_MEMBERS {
                    return Err("A room can have up to six agents.".into());
                }
                Ok(Plan::Add { room, agent })
            } else {
                if !inside {
                    return Err(format!("{} isn't in {}.", agent.name, room.name));
                }
                if current.len() <= rooms::MIN_MEMBERS {
                    return Err(format!(
                        "A room needs at least two agents, so {} can't leave {}. To end the room, ask the user to delete it from its menu.",
                        agent.name, room.name
                    ));
                }
                Ok(Plan::Remove { room, agent })
            }
        }
        _ => Err("Unknown tool".into()),
    }
}

/// The card for a call, in the user's words: what would change.
pub fn card(plan: &Plan) -> (String, String) {
    match plan {
        Plan::Create {
            name,
            members,
            lead,
            purpose,
        } => {
            let mut lines = vec![format!("With {}", names(members))];
            lines.push(match lead {
                Some(l) => format!("{} answers unless you @ someone", l.name),
                None => "No lead: you're asked who should answer".to_string(),
            });
            if let Some(p) = purpose {
                lines.push(format!("For: {p}"));
            }
            (format!("Make a room: {name}"), lines.join("\n"))
        }
        Plan::Add { room, agent } => (
            format!("Add {} to {}", agent.name, room.name),
            "It's given a copy of the files sent there so far.".to_string(),
        ),
        Plan::Remove { room, agent } => (
            format!("Take {} out of {}", agent.name, room.name),
            "Its own chat and memory stay.".to_string(),
        ),
    }
}

fn peer(agent: &store::Agent) -> AgentRef {
    AgentRef {
        id: agent.id.clone(),
        name: agent.name.clone(),
    }
}

/// A quiet line in the Chief's own chat: nothing it does to the team is
/// invisible. Its own chat's, even while it answers in a room.
fn audit(app: &AppHandle, caller: &store::Agent, line: String, about: Option<&store::Agent>) {
    let mut note = runner::new_message(&caller.id, MessageKind::Note, line);
    note.peer = about.map(peer);
    let _ = runner::record_own(app, note);
}

/// Do what was planned (and, when it had to be, allowed).
pub fn apply(app: &AppHandle, caller: &store::Agent, plan: Plan) -> Value {
    let done = match plan {
        Plan::Create {
            name,
            members,
            lead,
            purpose,
        } => {
            let made = Made {
                lead: lead.as_ref().map(|l| l.id.clone()),
                purpose,
                by: Some(caller.id.clone()),
            };
            rooms::create_with(Some(&name), &ids(&members), &made).map(|room| {
                audit(
                    app,
                    caller,
                    format!("Made a room, {}, with {}", room.name, names(&members)),
                    None,
                );
                let lead = match &lead {
                    Some(l) if l.id == caller.id => "You answer a message that mentions nobody.".to_string(),
                    Some(l) => format!("{} answers a message that mentions nobody.", l.name),
                    None => "It has no lead, so a message that mentions nobody asks the user who should answer.".to_string(),
                };
                format!(
                    "Made the room {} with {}. It's in the user's sidebar under Rooms. {lead} Tell the user it's there: they talk to everyone in it at once, @mention whoever should answer, or @everyone.",
                    room.name,
                    names(&members)
                )
            })
        }
        Plan::Add { room, agent } => {
            let mut ids = room.members.clone();
            ids.push(agent.id.clone());
            change_members(&room, ids).map(|room| {
                audit(
                    app,
                    caller,
                    format!("Added {} to {}", agent.name, room.name),
                    Some(&agent),
                );
                rooms::say(
                    app,
                    &room.id,
                    format!("{} added {}.", caller.name, agent.name),
                );
                format!("Added {} to {}.", agent.name, room.name)
            })
        }
        Plan::Remove { room, agent } => {
            let ids = room
                .members
                .iter()
                .filter(|m| **m != agent.id)
                .cloned()
                .collect();
            change_members(&room, ids).map(|room| {
                audit(
                    app,
                    caller,
                    format!("Took {} out of {}", agent.name, room.name),
                    Some(&agent),
                );
                rooms::say(
                    app,
                    &room.id,
                    format!("{} took {} out of the room.", caller.name, agent.name),
                );
                format!("Took {} out of {}.", agent.name, room.name)
            })
        }
    };
    match done {
        Ok(line) => {
            let _ = tauri::Emitter::emit(app, rooms::EVENT_ROOMS, ());
            text(line)
        }
        Err(e) => error(e.to_string()),
    }
}

fn change_members(room: &Room, members: Vec<String>) -> Result<Room, crate::errors::CommandError> {
    rooms::change(
        &room.id,
        RoomChange {
            members: Some(members),
            ..Default::default()
        },
    )
}

/// The plan again after a card: only when it still says what the card said.
pub fn plan_again(tool: &str, args: &Value, shown: &Plan) -> Result<Plan, String> {
    let fresh = plan(tool, args)?;
    if card(&fresh) != card(shown) {
        return Err(
            "The team or the room changed while the user was deciding, so nothing was done. Check again and ask them anew."
                .into(),
        );
    }
    Ok(fresh)
}

/// One room tool call, from `mcp::handle_rpc`.
pub async fn call(
    app: &AppHandle,
    caller: &store::Agent,
    turn: Option<u64>,
    tool: &Def,
    args: &Value,
) -> Value {
    let outside = runner::from_outside(&caller.id) && super::broker::is_live(&caller.id, turn);
    let plan = match gate(caller, outside, tool.name, args) {
        Ok(Gate::Go(plan)) => plan,
        Ok(Gate::Ask {
            title,
            detail,
            plan,
        }) => {
            let answer = super::mcp::ask_user(app, caller, title, detail, None).await;
            if let Some(refused) = super::mcp::refused_reply(&answer, "do it") {
                return error(refused);
            }
            // Checked again: the team or the room may have changed while the
            // card waited. Anything else than what was shown isn't done.
            match plan_again(tool.name, args, &plan) {
                Ok(fresh) => fresh,
                Err(e) => return error(e),
            }
        }
        Err(e) => return error(e),
    };
    // `rooms::change` copies files and reads the thread: off the async pool.
    let (app2, caller2) = (app.clone(), caller.clone());
    tauri::async_runtime::spawn_blocking(move || apply(&app2, &caller2, plan))
        .await
        .unwrap_or_else(|_| error("Something went wrong changing the room."))
}

#[cfg(test)]
#[path = "room_tools_tests.rs"]
mod tests;
