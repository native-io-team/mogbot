//! Ready-made agents ("role templates"): a name, a role and a briefing
//! written for a job most people have, so a first agent is good from its
//! first message.
//!
//! One catalogue, `templates.json`, read here (the Chief's prompt, its
//! `create_agent` tool, the phone's `agents.templates`) and imported as-is by
//! the desktop (`src/lib/agentTemplates.ts`), so the New agent dialog shows
//! exactly the briefing an agent made from it gets.
//!
//! `needs` says what a template can't work without. Only `"mail"` exists:
//! an inbox agent reads email through an app the user connects. Nothing
//! checks for one ahead of time (the engine lists its apps only once a turn
//! starts), so the UI offers "Connect an app" where it is needed and the
//! briefing tells the agent to say so, never to invent mail.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Starter {
    /// The button.
    pub label: String,
    /// What it sends, or puts in the composer for the user to finish.
    pub text: String,
    /// Sent at once; otherwise typed into the composer, caret at the end.
    pub send: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Template {
    pub id: String,
    /// What the picker calls it ("Research assistant").
    pub title: String,
    /// The agent's name when nobody picks another.
    pub name: String,
    pub role: String,
    pub color: String,
    pub needs: Option<String>,
    /// Its chat's first-open buttons, instead of the generic ones.
    pub starters: Vec<Starter>,
    /// The briefing, one line per entry (JSON has no multi-line strings).
    pub instructions: Vec<String>,
}

impl Template {
    pub fn instructions(&self) -> String {
        self.instructions.join("\n")
    }

    /// The briefing plus what whoever created it knew about the user.
    pub fn instructions_with(&self, context: Option<&str>) -> String {
        match context.map(str::trim).filter(|c| !c.is_empty()) {
            None => self.instructions(),
            Some(c) => format!("{}\n\n## About the user\n\n{c}", self.instructions()),
        }
    }
}

#[derive(Deserialize)]
struct Catalogue {
    templates: Vec<Template>,
}

static CATALOGUE: LazyLock<Vec<Template>> = LazyLock::new(|| {
    serde_json::from_str::<Catalogue>(include_str!("templates.json"))
        .expect("templates.json is checked by the tests below")
        .templates
});

pub fn all() -> &'static [Template] {
    &CATALOGUE
}

pub fn find(id: &str) -> Option<&'static Template> {
    let id = id.trim();
    all().iter().find(|t| t.id == id)
}

pub fn ids() -> Vec<&'static str> {
    all().iter().map(|t| t.id.as_str()).collect()
}

/// The Chief's part: what it can offer, and how.
pub fn chief_section() -> String {
    let lines: Vec<String> = all()
        .iter()
        .map(|t| {
            let needs = match t.needs.as_deref() {
                Some("mail") => {
                    " It needs their email connected as an app (such as Gmail): say so when you offer it."
                }
                _ => "",
            };
            format!("- {} (`{}`): {}{needs}", t.title, t.id, t.role)
        })
        .collect();
    format!(
        "### Ready-made agents\n\nThese come with a briefing already written. When what the user \
describes fits one, offer it by name in one line, and create it only once they agree: \
`create_agent` with its `template`. Put what you know about them (their work, people, \
preferences) in `instructions`; it is added to the template's briefing, not a replacement \
for it. You can still pick another name.\n\n{}",
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::store;

    #[test]
    fn the_catalogue_parses_and_every_entry_is_usable() {
        assert!(all().len() >= 3);
        let mut ids = ids();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), all().len(), "template ids are unique");
        for t in all() {
            assert!(
                t.id.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{}",
                t.id
            );
            assert_eq!(store::validate_name(&t.name).unwrap(), t.name);
            assert!(store::COLORS.contains(&t.color.as_str()), "{}", t.color);
            assert!(!t.role.is_empty() && t.role.chars().count() <= 500);
            assert!(!t.instructions().trim().is_empty());
            assert!(
                matches!(t.needs.as_deref(), None | Some("mail")),
                "{}",
                t.id
            );
            assert!(!t.starters.is_empty() && t.starters.len() <= 3);
            for s in &t.starters {
                assert!(!s.label.is_empty() && !s.text.trim().is_empty());
                // A starter that waits for you ends where you type.
                if !s.send {
                    assert!(s.text.ends_with(' '), "{}", s.label);
                }
            }
        }
    }

    #[test]
    fn a_template_that_needs_mail_says_what_to_do_without_it() {
        let inbox = all()
            .iter()
            .find(|t| t.needs.as_deref() == Some("mail"))
            .unwrap();
        let brief = inbox.instructions();
        assert!(brief.contains("connect their email as an app"));
        assert!(brief.contains("Never guess at or invent"));
        assert!(chief_section().contains("needs their email connected"));
    }

    #[test]
    fn deliverables_end_on_a_result_card() {
        for id in ["research", "weekly-review"] {
            assert!(
                find(id).unwrap().instructions().contains("share_result"),
                "{id}"
            );
        }
    }

    #[test]
    fn research_mentions_always_allow_only_once_a_search_asks() {
        let brief = find("research").unwrap().instructions();
        // At Steady and above a search runs without a card: it mentions
        // Always allow only once one shows, never "I'll ask" up front.
        assert!(!brief.contains("I'll ask before searching the web"));
        assert!(brief.contains("Only if a search or page puts a card"));
        assert!(brief.contains("Always allow web searches"));
        // At Steady and above a search runs without a card, so the Chief
        // mentions Always allow only once one shows.
        assert!(!crate::agents::prompts::CHIEF_INSTRUCTIONS
            .contains("I'll ask before searching the web"));
    }

    #[test]
    fn nothing_that_sets_up_a_routine_sends_by_itself() {
        // A routine runs later on its own: the user reads it before it's sent.
        for t in all() {
            for s in &t.starters {
                let text = s.text.to_lowercase();
                if text.contains("every ") || text.contains("check in with me") {
                    assert!(!s.send, "{}: {}", t.id, s.label);
                }
            }
        }
    }

    #[test]
    fn the_chiefs_section_names_every_template() {
        let section = chief_section();
        for t in all() {
            assert!(section.contains(&format!("`{}`", t.id)));
            assert!(section.contains(&t.title));
        }
    }

    #[test]
    fn context_is_added_to_the_briefing_never_instead_of_it() {
        let t = find("research").unwrap();
        assert_eq!(t.instructions_with(None), t.instructions());
        assert_eq!(t.instructions_with(Some("  ")), t.instructions());
        let with = t.instructions_with(Some("Works in climate policy."));
        assert!(with.starts_with(&t.instructions()));
        assert!(with.ends_with("## About the user\n\nWorks in climate policy."));
        assert!(find(" inbox ").is_some());
        assert!(find("nope").is_none());
    }
}
