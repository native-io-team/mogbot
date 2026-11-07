//! What an import has got out of the other assistant, area by area, and
//! the next thing to ask it for.
//!
//! We can't call the other assistant: it calls us (`import_conversation`).
//! So every answer we give it ends on a `NEXT:` naming the next concrete
//! gap ([`Coverage::next`]), and the import isn't finished until every area
//! here is *exhausted*: the assistant sent specifics (raw material, not a
//! summary) and then, asked "what else in this area haven't you sent?",
//! said there's nothing more. Saying "that's everything" for the whole
//! import in one line closes nothing: each area is confirmed on its own,
//! and an area can't be closed in the same breath it was first filled
//! ([`Coverage::record`]). Anything mentioned in passing (a name, a
//! project, a vehicle) becomes its own follow-up until it's answered.
//!
//! The sealed interview keeps this up to date with its `list_agents` and
//! `record_area` tools (`agents::connector`); it only ever stages. What it
//! gathered goes on the one review card, by area, with every gap named
//! ([`Coverage::report`]), and nothing reaches memory or an agent before
//! the user imports it there. The exchange cap (`connector::MAX_EXCHANGES`)
//! still holds: reaching it finishes with what's staged, and the card says
//! so.

use serde::{Deserialize, Serialize};

/// Facts kept per area, and characters per fact.
const MAX_FACTS: usize = 200;
const MAX_FACT_CHARS: usize = 2_000;
/// Things mentioned in passing, waiting for their own follow-up.
const MAX_MENTIONS: usize = 40;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Area {
    /// Every agent or project it runs, each in full.
    Agents,
    /// Routines and schedules, with exact times.
    Routines,
    People,
    /// Ongoing tasks and where each stands.
    Tasks,
    /// Preferences and standing rules.
    Preferences,
    /// Accounts, tools and connectors it uses, by name.
    Accounts,
    /// Family, home, vehicles, money; health only if offered.
    Personal,
    /// Recent conversations still open.
    Threads,
}

pub const AREAS: [Area; 8] = [
    Area::Agents,
    Area::Routines,
    Area::People,
    Area::Tasks,
    Area::Preferences,
    Area::Accounts,
    Area::Personal,
    Area::Threads,
];

impl Area {
    pub fn parse(s: &str) -> Option<Area> {
        AREAS.into_iter().find(|a| a.key() == s.trim())
    }

    pub fn key(self) -> &'static str {
        match self {
            Area::Agents => "agents",
            Area::Routines => "routines",
            Area::People => "people",
            Area::Tasks => "tasks",
            Area::Preferences => "preferences",
            Area::Accounts => "accounts",
            Area::Personal => "personal",
            Area::Threads => "threads",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Area::Agents => "Agents and projects",
            Area::Routines => "Routines and schedules",
            Area::People => "People and contacts",
            Area::Tasks => "Ongoing tasks",
            Area::Preferences => "Preferences and standing rules",
            Area::Accounts => "Accounts and tools",
            Area::Personal => "Personal facts",
            Area::Threads => "Open conversations",
        }
    }

    /// The first ask for this area: raw material, word for word.
    fn ask(self) -> &'static str {
        match self {
            Area::Agents => "every agent, project or persona you run for the user, each with its full system prompt or instructions word for word, its memory or notes files verbatim, and its open work",
            Area::Routines => "the full list of scheduled tasks and reminders, each with its exact time or cron expression, what it does, and which agent runs it",
            Area::People => "every person you know about: name, who they are to the user, how to reach them (by name of the channel only), and anything open with them",
            Area::Tasks => "every ongoing task or project, with where it stands, the next step, deadlines, amounts and who's involved",
            Area::Preferences => "every preference and standing rule the user gave you (tone, format, timing, what never to do), word for word as they said it",
            Area::Accounts => "every account, app, tool and connector you use for the user, by name, and what each is used for (never a password or key)",
            Area::Personal => "the saved facts about the user: family, home, vehicles, money and dates that matter (health only if the user shared it with you)",
            Area::Threads => "the recent conversations still open: what was asked, what you promised, and what's waiting on whom",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AreaStatus {
    /// Nothing sent yet.
    #[default]
    Missing,
    /// Specifics sent; not yet confirmed there's nothing more.
    Started,
    /// The assistant said, for this area, there's nothing more (or none).
    Exhausted,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AreaNote {
    pub status: AreaStatus,
    pub facts: Vec<String>,
    /// A pointed follow-up the interview wants answered next ("which
    /// client? what date? what amount?").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_up: Option<String>,
    /// The assistant said it has nothing at all in this area.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub none: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    /// The agents the assistant listed, before any was sent in full.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listed: Option<Vec<String>>,
    pub areas: Vec<(Area, AreaNote)>,
    /// Mentioned in passing, still to ask about.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<String>,
}

/// What `record_area` asks for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Record {
    pub facts: Vec<String>,
    /// The assistant said there's nothing more in this area.
    pub exhausted: bool,
    /// ... or nothing at all.
    pub none: bool,
    pub follow_up: Option<String>,
    pub mentions: Vec<String>,
    pub resolves: Vec<String>,
}

fn same(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// The next thing to ask the other assistant for.
#[derive(Debug, Clone, PartialEq)]
pub struct Gap {
    pub area: Option<Area>,
    pub ask: String,
}

impl Coverage {
    pub fn note(&self, area: Area) -> AreaNote {
        self.areas
            .iter()
            .find(|(a, _)| *a == area)
            .map(|(_, n)| n.clone())
            .unwrap_or_default()
    }

    fn note_mut(&mut self, area: Area) -> &mut AreaNote {
        if let Some(i) = self.areas.iter().position(|(a, _)| *a == area) {
            return &mut self.areas[i].1;
        }
        self.areas.push((area, AreaNote::default()));
        &mut self.areas.last_mut().expect("just pushed").1
    }

    pub fn list_agents(&mut self, names: &[String]) {
        let mut out: Vec<String> = Vec::new();
        for n in names {
            let n = super::review::clean_line(n, 80);
            if !n.is_empty() && !out.iter().any(|x| same(x, &n)) {
                out.push(n);
            }
        }
        self.listed = Some(out);
    }

    /// Record what the assistant sent for `area`. Closing an area needs a
    /// round of its own: specifics recorded in an earlier call, then the
    /// assistant saying there's nothing more, or that it has none at all.
    pub fn record(&mut self, area: Area, r: Record) -> Result<String, String> {
        for m in &r.resolves {
            self.mentions.retain(|x| !same(x, m));
        }
        for m in &r.mentions {
            let m = super::review::clean_line(m, 80);
            if m.is_empty() || self.mentions.iter().any(|x| same(x, &m)) {
                continue;
            }
            if self.mentions.len() < MAX_MENTIONS {
                self.mentions.push(m);
            }
        }
        let note = self.note_mut(area);
        // A round already happened: specifics came, or "what else" was asked.
        let had = !note.facts.is_empty() || note.status == AreaStatus::Started;
        for f in &r.facts {
            let f = super::review::clean_text(f, MAX_FACT_CHARS);
            let f = f.trim();
            if f.is_empty() || note.facts.iter().any(|x| x == f) {
                continue;
            }
            if let Some(what) = super::connector::looks_like_secret(f) {
                return Err(format!(
                    "That looks like it contains {what}: leave it out (the app asks the user for logins itself) and record the rest."
                ));
            }
            if note.facts.len() < MAX_FACTS {
                note.facts.push(f.to_string());
            }
        }
        note.follow_up = r
            .follow_up
            .as_deref()
            .map(|s| super::review::clean_line(s, 400))
            .filter(|s| !s.is_empty());
        if r.none && note.facts.is_empty() {
            note.none = true;
            note.status = AreaStatus::Exhausted;
            return Ok(format!("{}: recorded that there's none.", area.label()));
        }
        if r.exhausted {
            if !had {
                note.status = AreaStatus::Started;
                return Ok(format!(
                    "{}: recorded, but not closed. An area closes only after you've asked what else in it hasn't been sent and the answer is nothing more: ask that now.",
                    area.label()
                ));
            }
            note.status = AreaStatus::Exhausted;
            note.follow_up = None;
            return Ok(format!("{}: closed.", area.label()));
        }
        if !note.facts.is_empty() {
            note.status = AreaStatus::Started;
        }
        Ok(format!(
            "{}: {} recorded. Keep asking what else in it hasn't been sent.",
            area.label(),
            note.facts.len()
        ))
    }

    /// The next gap, given the agents staged in full (`staged`: name, has
    /// instructions). `None`: everything is covered.
    pub fn next(&self, staged: &[(String, bool)]) -> Option<Gap> {
        let Some(listed) = &self.listed else {
            return Some(Gap {
                area: Some(Area::Agents),
                ask: "List every agent, project or persona you run for the user, each with a one-line role, and say which one manages the others (or say there are none).".into(),
            });
        };
        let full = |name: &str| staged.iter().any(|(n, has)| *has && same(n, name));
        let total = listed.len();
        if let Some((i, name)) = listed.iter().enumerate().find(|(_, n)| !full(n)) {
            return Some(Gap {
                area: Some(Area::Agents),
                ask: format!(
                    "You listed {total} agent{}; send agent {} \"{name}\" in full: its system prompt or instructions word for word, its memory or notes verbatim, every routine with its exact time, what it watches for, the tools it uses and its open work.",
                    if total == 1 { "" } else { "s" },
                    i + 1
                ),
            });
        }
        if let Some(m) = self.mentions.first() {
            return Some(Gap {
                area: None,
                ask: format!(
                    "You mentioned \"{m}\" in passing. Tell me everything about it: who or what it is to the user, the specifics (names, dates, amounts, places) and anything open."
                ),
            });
        }
        for area in AREAS {
            let note = self.note(area);
            match note.status {
                AreaStatus::Exhausted => continue,
                AreaStatus::Missing if area == Area::Agents && total > 0 => {
                    return Some(Gap {
                        area: Some(area),
                        ask: format!("What else about {} haven't you sent? Any agent, project or persona not on your list, or anything about the ones you sent that you left out? Say \"nothing more in agents\" if that's all.", listed.join(", ")),
                    });
                }
                AreaStatus::Missing => {
                    return Some(Gap {
                        area: Some(area),
                        ask: format!("{}: send {}. Raw and word for word, not a summary; say \"none\" if there's nothing.", area.label(), area.ask()),
                    });
                }
                AreaStatus::Started => {
                    let ask = match &note.follow_up {
                        Some(f) => format!("{}: {f} Then: what else in {} haven't you sent?", area.label(), area.label().to_lowercase()),
                        None => format!(
                            "What else in {} haven't you sent? Send it word for word, or say \"nothing more in {}\" if that's all.",
                            area.label().to_lowercase(),
                            area.key()
                        ),
                    };
                    return Some(Gap {
                        area: Some(area),
                        ask,
                    });
                }
            }
        }
        None
    }

    /// Areas closed, of all of them (agents count once each is in full).
    pub fn progress(&self, staged: &[(String, bool)]) -> (usize, usize) {
        let gap = self.next(staged);
        let agents_open = matches!(
            &gap,
            Some(Gap {
                area: Some(Area::Agents),
                ..
            })
        );
        let done = AREAS
            .iter()
            .filter(|a| {
                if **a == Area::Agents {
                    !agents_open && self.note(Area::Agents).status == AreaStatus::Exhausted
                } else {
                    self.note(**a).status == AreaStatus::Exhausted
                }
            })
            .count();
        (done, AREAS.len())
    }

    /// The card's account: each area with what was gathered or what's
    /// missing, and every mention still open. `capped`: the exchange cap
    /// ended the import early.
    pub fn report(&self, staged: &[(String, bool)], capped: bool) -> CoverageReport {
        let missing_agents: Vec<String> = self
            .listed
            .iter()
            .flatten()
            .filter(|n| !staged.iter().any(|(s, has)| *has && same(s, n)))
            .cloned()
            .collect();
        let areas = AREAS
            .iter()
            .map(|a| {
                let n = self.note(*a);
                let mut gap = match n.status {
                    AreaStatus::Exhausted => None,
                    AreaStatus::Started => Some("Not confirmed complete".to_string()),
                    AreaStatus::Missing => Some("Not covered".to_string()),
                };
                if *a == Area::Agents && !missing_agents.is_empty() {
                    gap = Some(format!("Not sent in full: {}", missing_agents.join(", ")));
                }
                AreaLine {
                    area: *a,
                    label: a.label().to_string(),
                    facts: n.facts.len(),
                    none: n.none,
                    gap,
                }
            })
            .collect();
        CoverageReport {
            areas,
            open_mentions: self.mentions.clone(),
            capped,
        }
    }

    /// What was gathered, as notes for the Chief, by area.
    pub fn notes(&self) -> Option<String> {
        let mut out = String::new();
        for area in AREAS {
            let n = self.note(area);
            if n.facts.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(&format!("## {}\n", area.label()));
            out.push_str(
                &n.facts
                    .iter()
                    .map(|f| format!("- {f}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        (!out.is_empty()).then_some(out)
    }
}

/// One area on the review card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AreaLine {
    pub area: Area,
    pub label: String,
    pub facts: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub none: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<String>,
}

/// What the review card says the import gathered.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoverageReport {
    pub areas: Vec<AreaLine>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open_mentions: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub capped: bool,
}

impl CoverageReport {
    /// The card's lines in plain words, for clients that only read `detail`.
    pub fn lines(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .areas
            .iter()
            .map(|l| match (&l.gap, l.none) {
                (_, true) => format!("{}: none", l.label),
                (None, _) => format!("{}: {} gathered", l.label, l.facts),
                (Some(g), _) if l.facts > 0 => format!("{}: {} gathered · {g}", l.label, l.facts),
                (Some(g), _) => format!("{}: {g}", l.label),
            })
            .collect();
        if !self.open_mentions.is_empty() {
            out.push(format!(
                "Mentioned but not followed up: {}",
                self.open_mentions.join(", ")
            ));
        }
        if self.capped {
            out.push("Stopped at the message limit before everything was covered.".into());
        }
        out
    }
}

#[cfg(test)]
#[path = "coverage_tests.rs"]
mod tests;
