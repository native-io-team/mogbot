//! Which CLI an agent's turns run on: Claude Code (the default), Codex or
//! OpenCode, so an agent can run on a Claude or a ChatGPT subscription, or on
//! any provider OpenCode is set up with (local models included), with the
//! same chat, tools and approvals around it. The turn itself is in `runner` (and
//! `codex` for Codex's command line and stream); this is what the editor and
//! the Chief need to choose: which engines are here, signed in, and which
//! models each offers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::errors::CommandError;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Claude,
    Codex,
    #[serde(rename = "opencode")]
    OpenCode,
}

impl Engine {
    pub const ALL: [Engine; 3] = [Engine::Claude, Engine::Codex, Engine::OpenCode];

    /// The engines that run on a subscription plan with limits the engine
    /// reports (Claude Code, Codex): the wallet's added accounts, usage
    /// readings and carrying on with the other one are about these. OpenCode
    /// runs on whatever providers it is set up with and reports no plan.
    pub const PLANS: [Engine; 2] = [Engine::Claude, Engine::Codex];

    /// Whether the engine runs on a plan with reported limits ([`Self::PLANS`]).
    pub fn has_plan(self) -> bool {
        Self::PLANS.contains(&self)
    }

    pub fn label(self) -> &'static str {
        match self {
            Engine::Claude => "Claude Code",
            Engine::Codex => "Codex",
            Engine::OpenCode => "OpenCode",
        }
    }

    /// How it is stored and named on a command line or in a file.
    pub fn word(self) -> &'static str {
        match self {
            Engine::Claude => "claude",
            Engine::Codex => "codex",
            Engine::OpenCode => "opencode",
        }
    }

    fn binary_name(self) -> &'static str {
        match self {
            Engine::Claude => "claude",
            Engine::Codex => "codex",
            Engine::OpenCode => "opencode",
        }
    }

    /// What the editor, the Chief and the registry call it.
    pub fn parse(value: &str) -> Result<Engine, CommandError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude code" | "claude-code" => Ok(Engine::Claude),
            "codex" | "chatgpt" => Ok(Engine::Codex),
            "opencode" | "open code" | "open-code" => Ok(Engine::OpenCode),
            _ => Err(super::err_invalid(
                "engine",
                "Pick Claude Code (`claude`), Codex (`codex`) or OpenCode (`opencode`).",
            )),
        }
    }
}

/// A model an engine offers. `value` is passed as `--model` / `-m`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: Engine,
    pub label: &'static str,
    pub installed: bool,
    /// Codex: `codex login status` says so. Claude Code: `claude auth
    /// status` (setup's own check), so a lapsed sign-in shows before a turn.
    /// OpenCode has no one sign-in: it counts once it lists a model it can
    /// run (its providers are set up in OpenCode itself).
    pub signed_in: bool,
    /// Whether its turns can stop and ask the user (an Allow / Deny card)
    /// before going past what it may do alone. Claude Code always can
    /// (`--permission-prompt-tool`); Codex only over `app-server`, since
    /// `codex exec` forces approvals to "never". The editor says which.
    pub asks: bool,
    /// The engine's own models, without "Default" (no `--model` at all).
    pub models: Vec<ModelChoice>,
}

impl EngineInfo {
    pub fn ready(&self) -> bool {
        self.installed && self.signed_in
    }
}

type Probe<T> = LazyLock<Mutex<HashMap<Engine, (T, String, Instant)>>>;

/// Each engine's binary, found and validated once per PATH.
static BINARIES: Probe<PathBuf> = LazyLock::new(Default::default);

/// The engine's binary, found and validated (`--version`, which spawns a
/// process and costs ~100ms) once per PATH, not per turn. It is looked for
/// again if the file goes away, or fails to start ([`forget_binary`]).
pub async fn binary(engine: Engine) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    if let Some((binary, for_path, _)) = BINARIES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&engine)
    {
        if *for_path == path_var && binary.exists() {
            return Some(binary.clone());
        }
    }
    let name = engine.binary_name();
    let binary = tokio::task::spawn_blocking(move || {
        crate::commands::claude::find_validated_binary(name, "--version")
    })
    .await
    .ok()
    .flatten()?;
    BINARIES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(engine, (binary.clone(), path_var, Instant::now()));
    Some(binary)
}

/// The cached binary failed to start: look for it again next time.
pub fn forget_binary(engine: Engine) {
    BINARIES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&engine);
}

/// Whether the engine can run a turn on some account: this Mac's own
/// sign-in, or one added to its usage wallet (`agents::wallet`).
pub async fn signed_in(engine: Engine) -> bool {
    signed_in_here(engine).await || super::wallet::any_added_signed_in(engine).await
}

/// Whether this Mac's own sign-in of the engine is signed in. A yes is kept
/// for a minute; a no only for a few seconds, so signing in shows up as soon
/// as the editor looks again.
pub async fn signed_in_here(engine: Engine) -> bool {
    static CACHE: Probe<bool> = LazyLock::new(Default::default);
    let Some(binary) = binary(engine).await else {
        return false;
    };
    // The e2e suite's scripted model needs no account (debug builds only).
    if super::codex::scripted() {
        return true;
    }
    // One probe per engine at a time: an asker that arrives mid-probe (the
    // Usage view's accounts beside the engines' overview) waits for its answer.
    static PROBING: LazyLock<[tokio::sync::Mutex<()>; Engine::ALL.len()]> =
        LazyLock::new(Default::default);
    let _probing = PROBING[engine as usize].lock().await;
    if let Some((yes, _, at)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&engine) {
        let keep = if *yes { 60 } else { 5 };
        if at.elapsed() < Duration::from_secs(keep) {
            return *yes;
        }
    }
    let yes = match engine {
        // The same answer setup gives (`claude auth status`, then its files),
        // so the chat says "signed out" before a message fails on it.
        Engine::Claude => {
            let account = crate::commands::accounts::get_active_account_id()
                .unwrap_or_else(|_| crate::commands::accounts::DEFAULT_ACCOUNT_ID.to_string());
            crate::commands::setup::claude_auth_truth(&account).await
        }
        Engine::Codex => {
            // Callers asking while one is running share it (`joined`).
            static PROBE: crate::joined::Joined<bool> = crate::joined::Joined::new();
            PROBE
                .run(|| async move {
                    let mut cmd = tokio::process::Command::new(binary);
                    cmd.args(["login", "status"])
                        .env("PATH", crate::utils::get_extended_path());
                    crate::external_command::run_with_timeout(cmd, "codex login status", 15)
                        .await
                        .is_ok_and(|out| out.status.success())
                })
                .await
        }
        // Ready once it lists a model it can run (OpenCode's own free models
        // need no account; a provider set up in OpenCode adds its own).
        Engine::OpenCode => !super::opencode::refresh(&binary).await.is_empty(),
    };
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(engine, (yes, String::new(), Instant::now()));
    yes
}

pub async fn info(engine: Engine) -> EngineInfo {
    let found = binary(engine).await;
    let installed = found.is_some();
    // Its models are what makes it ready: looked at (a minute's cache) first.
    if let (Engine::OpenCode, Some(binary)) = (engine, found.as_deref()) {
        super::opencode::refresh(binary).await;
    }
    let asks = asks(engine, found.as_deref()).await;
    EngineInfo {
        id: engine,
        label: engine.label(),
        installed,
        signed_in: installed && signed_in(engine).await,
        asks,
        models: models(engine),
    }
}

/// Whether its turns can ask (`EngineInfo::asks`), given its binary.
async fn asks(engine: Engine, binary: Option<&std::path::Path>) -> bool {
    match (binary, engine) {
        (_, Engine::Claude) => true,
        (Some(binary), Engine::Codex) => super::codex_app::available(binary).await,
        // `opencode acp` sends every permission it asks for to us.
        (Some(_), Engine::OpenCode) => true,
        // Not installed: unknown, so not claimed.
        (None, Engine::Codex | Engine::OpenCode) => false,
    }
}

pub async fn overview() -> Vec<EngineInfo> {
    // One look at a time: a second asker (the launch's early look, then the
    // Agents view's; the view and the Usage view) waits for the first and
    // answers from what it just cached, instead of starting every CLI again.
    static ONE_AT_A_TIME: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(Default::default);
    let _turn = ONE_AT_A_TIME.lock().await;
    let (claude, codex, opencode) = tokio::join!(
        info(Engine::Claude),
        info(Engine::Codex),
        info(Engine::OpenCode)
    );
    vec![claude, codex, opencode]
}

/// Look at the engines once at launch, while the window loads: the Agents
/// view's first overview then reads the binaries and sign-ins from cache
/// rather than waiting on each CLI.
pub fn look_early() {
    tauri::async_runtime::spawn(async {
        let _ = overview().await;
    });
}

/// The engine a new agent goes on when nobody picked one: Claude Code when
/// it's ready, else the first that is, else Claude Code (whose chat then
/// offers to set it up).
pub fn default_for(engines: &[EngineInfo]) -> Engine {
    if engines.iter().any(|e| e.id == Engine::Claude && e.ready()) {
        return Engine::Claude;
    }
    engines
        .iter()
        .find(|e| e.ready())
        .map(|e| e.id)
        .unwrap_or_default()
}

/// Refuse to put an agent on an engine that can't run it, in words.
pub async fn require_ready(engine: Engine) -> Result<(), CommandError> {
    let info = info(engine).await;
    if !info.installed {
        return Err(CommandError::expected(format!(
            concat!("{} isn't installed on this ", crate::computer::noun!(), "."),
            engine.label()
        )));
    }
    if !info.signed_in {
        return Err(CommandError::expected(format!(
            "{} isn't signed in. Sign in to it first.",
            engine.label()
        )));
    }
    Ok(())
}

/// Claude Code's own aliases, which always mean the current model of that
/// family; Codex's, as Codex itself lists them (see [`super::codex::models`]);
/// OpenCode's, as `opencode models` last listed them (`opencode::refresh`).
pub fn models(engine: Engine) -> Vec<ModelChoice> {
    match engine {
        Engine::Claude => super::store::MODELS
            .iter()
            .map(|m| ModelChoice {
                value: m.to_string(),
                label: m[..1].to_uppercase() + &m[1..],
            })
            .collect(),
        Engine::Codex => super::codex::models(),
        Engine::OpenCode => super::opencode::models(),
    }
}

/// A model for this engine: empty is the engine's own default; anything
/// else must be one it offers. It becomes a CLI argument, so nothing else
/// gets through.
pub fn normalize_model(engine: Engine, model: &str) -> Result<Option<String>, CommandError> {
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    let offered = models(engine);
    if offered.iter().any(|m| m.value == model) {
        return Ok(Some(model.to_string()));
    }
    let names: Vec<&str> = offered.iter().map(|m| m.label.as_str()).collect();
    Err(super::err_invalid(
        "model",
        if names.is_empty() {
            format!(
                "{} has no models to pick from yet; use Default.",
                engine.label()
            )
        } else {
            format!("Pick {} or Default.", names.join(", "))
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(id: Engine, installed: bool, signed_in: bool) -> EngineInfo {
        EngineInfo {
            id,
            label: "",
            installed,
            signed_in,
            asks: true,
            models: Vec::new(),
        }
    }

    #[test]
    fn a_new_agent_goes_on_claude_when_ready_else_the_first_ready_engine() {
        let both = [
            engine(Engine::Claude, true, true),
            engine(Engine::Codex, true, true),
        ];
        assert_eq!(default_for(&both), Engine::Claude);
        let codex_only = [
            engine(Engine::Claude, false, false),
            engine(Engine::Codex, true, true),
        ];
        assert_eq!(default_for(&codex_only), Engine::Codex);
        // Claude signed out counts as not ready.
        let claude_out = [
            engine(Engine::Claude, true, false),
            engine(Engine::Codex, true, true),
        ];
        assert_eq!(default_for(&claude_out), Engine::Codex);
        // Nothing ready: Claude Code, whose chat offers to set it up.
        let none = [
            engine(Engine::Claude, false, false),
            engine(Engine::Codex, true, false),
        ];
        assert_eq!(default_for(&none), Engine::Claude);
        assert_eq!(default_for(&[]), Engine::Claude);
    }

    #[test]
    fn engines_are_stored_as_plain_words_and_read_leniently() {
        assert_eq!(serde_json::to_string(&Engine::Codex).unwrap(), "\"codex\"");
        assert_eq!(Engine::default(), Engine::Claude);
        assert_eq!(Engine::parse(" Codex ").unwrap(), Engine::Codex);
        assert_eq!(Engine::parse("claude-code").unwrap(), Engine::Claude);
        assert!(Engine::parse("gpt").is_err());
    }

    #[test]
    fn a_claude_model_is_only_ever_one_of_its_aliases() {
        assert_eq!(normalize_model(Engine::Claude, "").unwrap(), None);
        assert_eq!(
            normalize_model(Engine::Claude, "haiku").unwrap().as_deref(),
            Some("haiku")
        );
        assert!(normalize_model(Engine::Claude, "--dangerously-skip-permissions").is_err());
        assert!(normalize_model(Engine::Codex, "opus").is_err());
    }

    // Unix only: the stand-in codex is a /bin/sh script.
    #[cfg(unix)]
    #[tokio::test]
    async fn only_a_codex_with_an_app_server_is_said_to_ask() {
        use crate::agents::codex_app::fake;
        let dir = tempfile::tempdir().unwrap();
        let app = fake::codex(&fake::folder(dir.path(), "app"), fake::Kind::AppServer);
        let old = fake::codex(&fake::folder(dir.path(), "old"), fake::Kind::ExecOnly);
        assert!(asks(Engine::Claude, None).await);
        assert!(asks(Engine::Codex, Some(&app)).await);
        // `codex exec` forces approvals to "never": nothing can ask.
        assert!(!asks(Engine::Codex, Some(&old)).await);
        // Not installed: nothing is claimed.
        assert!(!asks(Engine::Codex, None).await);
    }
}
