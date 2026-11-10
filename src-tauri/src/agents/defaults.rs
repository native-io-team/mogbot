//! What a new agent starts on when nobody picked: an engine, and per engine a
//! model. Settings → Agents sets it (and the phone, through
//! `agents.setDefaults`); `agents_create`, the Chief's `create_agent` and the
//! phone's New agent read it. Existing agents never change with it.
//!
//! Saved in the app's settings (`AppState::agent_defaults`). Never trusted on
//! the way out: a chosen engine that isn't ready now falls back to the rule
//! (`engine::default_for`), and a saved model the engine no longer offers is
//! the engine's own default, so nothing is put on a model nobody can run.

use serde::{Deserialize, Serialize};

use super::engine::{self, Engine, EngineInfo};
use crate::errors::CommandError;

/// What the user chose. Every field is optional: unset is "the rule decides"
/// for the engine and "the engine's own default" for a model.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Saved {
    /// An engine name this build doesn't know (a newer app's, a hand edit)
    /// reads as unset, the rule, rather than failing the whole app state.
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "lenient")]
    pub engine: Option<Engine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode_model: Option<String>,
}

/// Anything that doesn't parse as `T` is `None`: one bad value in the app's
/// settings must never fail `AppState` as a whole, since the next write would
/// then save defaults over every other field (`commands::setup`).
pub fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

impl Saved {
    fn model(&self, engine: Engine) -> Option<&str> {
        match engine {
            Engine::Claude => self.claude_model.as_deref(),
            Engine::Codex => self.codex_model.as_deref(),
            Engine::OpenCode => self.opencode_model.as_deref(),
        }
    }

    fn set_model(&mut self, engine: Engine, model: Option<String>) {
        match engine {
            Engine::Claude => self.claude_model = model,
            Engine::Codex => self.codex_model = model,
            Engine::OpenCode => self.opencode_model = model,
        }
    }
}

/// Each engine's default model, as far as it still holds (see [`View`]).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Models {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub opencode: Option<String>,
}

/// The setting as Settings and the phone show it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// The engine the user chose; `None` when they never have.
    pub engine: Option<Engine>,
    /// Each engine's chosen model, only while that engine still offers it;
    /// `None` is the engine's own default.
    pub models: Models,
    /// Where a new agent starts now: the chosen engine when it's installed
    /// and signed in, else the first that is (`engine::default_for`).
    pub starts_on: Engine,
    /// The model it starts on there; `None` is that engine's default.
    pub model: Option<String>,
    /// Why the chosen engine isn't `starts_on`, in words ("Codex isn't
    /// signed in"); `None` when it is, or nothing was chosen. Said where an
    /// agent is created, not sent: the phone and Settings word it themselves.
    #[serde(skip)]
    pub fallback: Option<String>,
}

/// A saved model, only while the engine still offers it.
fn offered(saved: &Saved, info: Option<&EngineInfo>, engine: Engine) -> Option<String> {
    let model = saved.model(engine)?;
    info?
        .models
        .iter()
        .any(|m| m.value == model)
        .then(|| model.to_string())
}

/// The saved choice against the engines as they are now.
pub fn view_of(saved: &Saved, engines: &[EngineInfo]) -> View {
    let find = |id: Engine| engines.iter().find(|e| e.id == id);
    let starts_on = match saved.engine {
        Some(chosen) if find(chosen).is_some_and(EngineInfo::ready) => chosen,
        _ => engine::default_for(engines),
    };
    View {
        engine: saved.engine,
        models: Models {
            claude: offered(saved, find(Engine::Claude), Engine::Claude),
            codex: offered(saved, find(Engine::Codex), Engine::Codex),
            opencode: offered(saved, find(Engine::OpenCode), Engine::OpenCode),
        },
        starts_on,
        model: offered(saved, find(starts_on), starts_on),
        fallback: saved
            .engine
            .filter(|chosen| *chosen != starts_on)
            .map(|chosen| {
                let state = match find(chosen) {
                    Some(info) if info.installed => "isn't signed in",
                    _ => "isn't installed",
                };
                format!("{} {state}", chosen.label())
            }),
    }
}

impl View {
    /// The model a new agent on `engine` starts on when none was given.
    pub fn model_for(&self, engine: Engine) -> Option<String> {
        match engine {
            Engine::Claude => self.models.claude.clone(),
            Engine::Codex => self.models.codex.clone(),
            Engine::OpenCode => self.models.opencode.clone(),
        }
    }

    /// Where a new agent went, as its creation says it: "on Codex", and when
    /// it went there because the chosen engine couldn't take it, why: "on
    /// Claude Code — Codex isn't signed in". `picked` is an engine somebody
    /// named for this one agent, which is never a fallback.
    pub fn started_on(&self, engine: Engine, picked: bool) -> String {
        match &self.fallback {
            Some(why) if !picked && engine == self.starts_on => {
                format!("on {} — {why}", engine.label())
            }
            _ => format!("on {}", engine.label()),
        }
    }
}

pub fn saved() -> Saved {
    crate::commands::setup::read_app_state()
        .agent_defaults
        .unwrap_or_default()
}

/// The setting now, against the engines as they are.
pub async fn view() -> View {
    view_of(&saved(), &engine::overview().await)
}

/// A change from Settings or the phone. `None` leaves a field as it is; an
/// empty model goes back to the engine's own default.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub claude_model: Option<String>,
    #[serde(default)]
    pub codex_model: Option<String>,
    #[serde(default)]
    pub opencode_model: Option<String>,
}

impl Change {
    pub fn is_empty(&self) -> bool {
        self.engine.is_none()
            && self.claude_model.is_none()
            && self.codex_model.is_none()
            && self.opencode_model.is_none()
    }
}

/// Check a change as `agents_create` would check the same choice: an engine
/// must be installed and signed in, a model one its engine offers. Nothing is
/// saved unless all of it holds.
pub async fn check(change: &Change) -> Result<Saved, CommandError> {
    if change.is_empty() {
        return Err(super::err_invalid(
            "defaults",
            "Say which engine or model to change.",
        ));
    }
    let mut next = saved();
    if let Some(engine) = change.engine.as_deref() {
        let engine = Engine::parse(engine)?;
        engine::require_ready(engine).await?;
        next.engine = Some(engine);
    }
    for (engine, model) in [
        (Engine::Claude, &change.claude_model),
        (Engine::Codex, &change.codex_model),
        (Engine::OpenCode, &change.opencode_model),
    ] {
        if let Some(model) = model {
            next.set_model(engine, engine::normalize_model(engine, model)?);
        }
    }
    Ok(next)
}

/// Save a checked change and say what it is now. Only the fields the change
/// names are written, so a concurrent change to another one isn't lost.
pub async fn set(change: Change) -> Result<View, CommandError> {
    let checked = check(&change).await?;
    crate::commands::setup::update_app_state(|s| {
        let mut saved = s.agent_defaults.clone().unwrap_or_default();
        if change.engine.is_some() {
            saved.engine = checked.engine;
        }
        if change.claude_model.is_some() {
            saved.claude_model = checked.claude_model.clone();
        }
        if change.codex_model.is_some() {
            saved.codex_model = checked.codex_model.clone();
        }
        if change.opencode_model.is_some() {
            saved.opencode_model = checked.opencode_model.clone();
        }
        s.agent_defaults = (saved != Saved::default()).then_some(saved);
    })?;
    Ok(view().await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::engine::ModelChoice;

    fn engine(id: Engine, ready: bool, models: &[&str]) -> EngineInfo {
        EngineInfo {
            id,
            label: id.label(),
            installed: ready,
            signed_in: ready,
            asks: true,
            models: models
                .iter()
                .map(|m| ModelChoice {
                    value: m.to_string(),
                    label: m.to_string(),
                })
                .collect(),
        }
    }

    fn both(codex_ready: bool) -> Vec<EngineInfo> {
        vec![
            engine(Engine::Claude, true, &["opus", "sonnet", "haiku"]),
            engine(Engine::Codex, codex_ready, &["gpt-a", "gpt-b"]),
        ]
    }

    #[test]
    fn nothing_saved_is_the_rule_on_the_engines_own_model() {
        let view = view_of(&Saved::default(), &both(true));
        assert_eq!(view.engine, None);
        assert_eq!(view.starts_on, Engine::Claude);
        assert_eq!(view.model, None);
        assert_eq!(view.models, Models::default());
    }

    #[test]
    fn a_chosen_engine_and_its_model_are_where_new_agents_start() {
        let saved = Saved {
            engine: Some(Engine::Codex),
            claude_model: Some("haiku".into()),
            codex_model: Some("gpt-b".into()),
            ..Saved::default()
        };
        let view = view_of(&saved, &both(true));
        assert_eq!(view.starts_on, Engine::Codex);
        assert_eq!(view.model.as_deref(), Some("gpt-b"));
        assert_eq!(view.model_for(Engine::Claude).as_deref(), Some("haiku"));
    }

    #[test]
    fn a_chosen_engine_that_isnt_ready_falls_back_to_the_rule() {
        let saved = Saved {
            engine: Some(Engine::Codex),
            claude_model: Some("sonnet".into()),
            codex_model: Some("gpt-a".into()),
            ..Saved::default()
        };
        let view = view_of(&saved, &both(false));
        // Still what the user chose, but a new agent goes where it can run.
        assert_eq!(view.engine, Some(Engine::Codex));
        assert_eq!(view.starts_on, Engine::Claude);
        assert_eq!(view.model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn a_model_the_engine_no_longer_offers_is_its_default() {
        let saved = Saved {
            engine: Some(Engine::Codex),
            claude_model: None,
            codex_model: Some("gpt-gone".into()),
            ..Saved::default()
        };
        let view = view_of(&saved, &both(true));
        assert_eq!(view.model, None);
        assert_eq!(view.models.codex, None);
        // Not found at all (no overview yet): nothing is claimed either.
        assert_eq!(view_of(&saved, &[]).models.codex, None);
    }

    #[test]
    fn saved_settings_are_plain_words_and_old_files_read_as_unset() {
        let saved = Saved {
            engine: Some(Engine::Codex),
            claude_model: Some("opus".into()),
            codex_model: None,
            ..Saved::default()
        };
        let json = serde_json::to_value(&saved).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "engine": "codex", "claudeModel": "opus" })
        );
        let state: crate::types::AppState = serde_json::from_str("{}").unwrap();
        assert_eq!(state.agent_defaults, None);
        let state: crate::types::AppState =
            serde_json::from_str(r#"{"agentDefaults":{"engine":"codex"}}"#).unwrap();
        assert_eq!(state.agent_defaults.unwrap().engine, Some(Engine::Codex));
    }

    #[test]
    fn a_creation_names_its_engine_and_says_why_on_a_fallback() {
        let saved = Saved {
            engine: Some(Engine::Codex),
            ..Saved::default()
        };
        let mut signed_out = both(true);
        signed_out[1].signed_in = false;
        let view = view_of(&saved, &signed_out);
        assert_eq!(
            view.started_on(Engine::Claude, false),
            "on Claude Code — Codex isn't signed in"
        );
        // Named for this agent: where it was asked to go, no excuse needed.
        assert_eq!(view.started_on(Engine::Claude, true), "on Claude Code");
        for missing in [
            view_of(&saved, &both(false)),
            view_of(&saved, &both(true)[..1]),
        ] {
            assert_eq!(
                missing.started_on(Engine::Claude, false),
                "on Claude Code — Codex isn't installed"
            );
        }
        // The choice holds: just the engine.
        let view = view_of(&saved, &both(true));
        assert_eq!(view.fallback, None);
        assert_eq!(view.started_on(Engine::Codex, false), "on Codex");
        assert_eq!(
            view_of(&Saved::default(), &both(true)).started_on(Engine::Claude, false),
            "on Claude Code"
        );
    }

    #[test]
    fn one_bad_value_never_fails_the_app_state() {
        let raw = r#"{
            "accounts": [],
            "activeAccountId": "work",
            "quickEntryShortcut": "Alt+K",
            "agentDefaults": {"engine": "gemini", "claudeModel": "opus"}
        }"#;
        let state: crate::types::AppState = serde_json::from_str(raw).unwrap();
        assert_eq!(state.active_account_id.as_deref(), Some("work"));
        assert_eq!(state.quick_entry_shortcut.as_deref(), Some("Alt+K"));
        // The engine it can't read is the rule; the model it can is kept.
        let saved = state.agent_defaults.unwrap();
        assert_eq!(saved.engine, None);
        assert_eq!(saved.claude_model.as_deref(), Some("opus"));
        // Nothing of it readable at all: unset, and the rest still loads.
        for bad in [
            r#"{"agentDefaults":"codex","quickEntry":true}"#,
            r#"{"agentDefaults":{"claudeModel":7},"quickEntry":true}"#,
            r#"{"agentDefaults":{"engine":null},"quickEntry":true}"#,
        ] {
            let state: crate::types::AppState = serde_json::from_str(bad).unwrap();
            assert_eq!(state.quick_entry, Some(true), "{bad}");
            assert!(state.agent_defaults.unwrap_or_default().engine.is_none());
        }
    }

    #[tokio::test]
    async fn a_change_must_say_something_and_models_must_be_offered() {
        assert!(check(&Change::default()).await.is_err());
        let bad = Change {
            claude_model: Some("--dangerously-skip-permissions".into()),
            ..Change::default()
        };
        assert!(check(&bad).await.is_err());
        let bad = Change {
            engine: Some("gpt".into()),
            ..Change::default()
        };
        assert!(check(&bad).await.is_err());
        let fine = Change {
            claude_model: Some("haiku".into()),
            ..Change::default()
        };
        assert_eq!(
            check(&fine).await.unwrap().claude_model.as_deref(),
            Some("haiku")
        );
        // Unknown fields are refused, not ignored (the phone sends JSON).
        assert!(serde_json::from_str::<Change>(r#"{"model":"opus"}"#).is_err());
    }
}
