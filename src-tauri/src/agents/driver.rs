//! How one turn talks to its engine, decided once at the start of the turn.
//!
//! `engine::Engine` is what an agent is *on* (stored in the registry, chosen
//! in the editor or by the Chief). A [`Driver`] is how this particular turn
//! runs it: Codex has two ways in, depending on what the installed binary
//! speaks. Everything engine-specific about starting a turn is answered
//! here, so the runner's turn loop is the same for all of them; what comes
//! back is mapped onto the shared `stream::Step`s by each engine's own
//! module (`stream` for Claude Code, `codex` / `codex_app` for Codex).
//!
//! A third engine is a new `Engine` variant (label, binary, sign-in, models
//! in `engine`), a module for its command line and its stream, and a
//! variant here. The compiler then names every place left to decide.

use std::path::Path;

use super::capabilities::Capabilities;
use super::engine::Engine;
use super::store::Agent;
use crate::errors::CommandError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Driver {
    /// `claude --print --resume`: stream-json out, the prompt on stdin,
    /// approvals through our `approve` tool (`--permission-prompt-tool`).
    ClaudePrint,
    /// `codex app-server`: JSON-RPC both ways for the whole turn, so
    /// replies stream, escalations become cards, and Stop interrupts.
    CodexApp,
    /// `codex exec [resume]`, for a Codex without the app-server methods we
    /// need: JSONL out, the prompt on stdin, and nothing can ask (exec forces
    /// approvals to "never"; the prompt says so).
    CodexExec,
}

/// What every driver needs to build a turn's command line.
pub struct TurnSpec<'a> {
    pub model: Option<&'a str>,
    /// The session to resume, or for a new one what [`Driver::new_session`] gave.
    pub session: &'a str,
    pub resuming: bool,
    /// The agents endpoint of the bridge. It names no one: the turn's
    /// secret does (`reach`).
    pub url: &'a str,
    /// Claude Code: the path of the turn's 0600 `--mcp-config` file.
    pub mcp_config: &'a str,
    pub system_prompt: &'a str,
    /// Folders it may work in without asking, besides its cwd.
    pub writable: &'a [String],
    /// Codex with permission profiles: the `.git` / `.shipstudio` folders
    /// its commands may not write (`reach::protected_paths`).
    pub protected: Option<&'a [std::path::PathBuf]>,
    /// What it can reach (`connections::for_turn`): its browser, the
    /// claude.ai connectors it's kept from, Codex's connection servers.
    /// `None` is the defaults (browser on, nothing blocked or added).
    pub access: Option<&'a super::connections::TurnAccess>,
    /// The model's context window from the agent's last reading, for
    /// Codex's compaction threshold (`tidy::codex_config`).
    pub window: Option<u64>,
}

impl Driver {
    /// How this turn runs `engine`, given its binary.
    pub async fn pick(engine: Engine, binary: &Path) -> Driver {
        match engine {
            Engine::Claude => Driver::ClaudePrint,
            Engine::Codex if super::codex_app::available(binary).await => Driver::CodexApp,
            Engine::Codex => Driver::CodexExec,
        }
    }

    pub fn engine(self) -> Engine {
        match self {
            Driver::ClaudePrint => Engine::Claude,
            Driver::CodexApp | Driver::CodexExec => Engine::Codex,
        }
    }

    /// Checked before spawning. Claude Code's sign-in is checked by its turn
    /// (a signed-out turn says so in the chat); a signed-out Codex retries a
    /// 401 for twenty seconds before saying so, so it is asked first.
    pub async fn ready(self) -> Result<(), CommandError> {
        self.ready_if(|| super::engine::signed_in(Engine::Codex))
            .await
    }

    /// [`Driver::ready`] for a turn on one account of the engine's wallet.
    pub async fn ready_as(self, account: &super::wallet::Account) -> Result<(), CommandError> {
        self.ready_if(|| super::wallet::signed_in(account)).await
    }

    /// [`Driver::ready`], given how to ask whether Codex is signed in (only
    /// asked for a Codex turn).
    async fn ready_if<F>(self, codex_signed_in: impl FnOnce() -> F) -> Result<(), CommandError>
    where
        F: std::future::Future<Output = bool>,
    {
        match self.engine() {
            Engine::Claude => Ok(()),
            Engine::Codex if codex_signed_in().await => Ok(()),
            Engine::Codex => Err(CommandError::expected("Codex says: Not logged in.")),
        }
    }

    /// The session id for a turn with none yet. Claude Code takes ours;
    /// Codex names its own (its thread id arrives as `Step::Session`).
    pub fn new_session(self) -> String {
        match self {
            Driver::ClaudePrint => uuid::Uuid::new_v4().to_string(),
            Driver::CodexApp | Driver::CodexExec => String::new(),
        }
    }

    /// Every argument the turn's process gets.
    pub fn args(self, spec: &TurnSpec) -> Vec<String> {
        let args = with_compaction(self, self.base_args(spec), spec.window);
        match spec.access {
            Some(access) => with_access(self, args, access),
            // Fail closed: a turn nobody worked out the reach of gets no
            // browser.
            None => with_access(self, args, &super::connections::TurnAccess::default()),
        }
    }

    fn base_args(self, spec: &TurnSpec) -> Vec<String> {
        match self {
            Driver::ClaudePrint => super::claude::args(
                spec.model,
                spec.session,
                spec.resuming,
                spec.mcp_config,
                spec.system_prompt,
                spec.writable,
            ),
            // Model, session and instructions go in `thread/start` instead.
            Driver::CodexApp => super::codex_app::args(spec.url, spec.writable, spec.protected),
            Driver::CodexExec => super::codex::args(
                spec.model,
                spec.resuming.then_some(spec.session),
                spec.url,
                &super::prompts::for_codex_exec(spec.system_prompt),
                spec.writable,
                spec.protected,
            ),
        }
    }

    /// Whether stdin stays open for the turn (a conversation), rather than
    /// carrying the prompt and closing.
    pub fn converses(self) -> bool {
        self == Driver::CodexApp
    }

    /// What identifies this turn's process on its command line, for the next
    /// launch to recognise a leftover: the session, or for Codex (whose new
    /// session has no id until it starts) the agent's home, a writable root.
    pub fn process_mark(self, session: &str, home: &Path) -> String {
        match self.engine() {
            Engine::Claude => session.to_string(),
            Engine::Codex => home.to_string_lossy().into_owned(),
        }
    }

    /// What the agent can use, when the engine doesn't announce it during the
    /// turn. Claude Code's `init` event does (`Step::Capabilities`); Codex
    /// announces no tools, so they are read before the turn.
    pub async fn capabilities_before(
        self,
        agent: &Agent,
        binary: &Path,
        now: i64,
    ) -> Option<Capabilities> {
        match self {
            Driver::ClaudePrint => None,
            Driver::CodexApp | Driver::CodexExec => {
                Some(super::codex::capabilities(agent, binary, now, self == Driver::CodexApp).await)
            }
        }
    }
}

/// Codex's compaction, on and tuned (`tidy`), as `-c` overrides placed where
/// [`with_access`] puts its own. Claude Code's is in its own command line.
fn with_compaction(driver: Driver, mut args: Vec<String>, window: Option<u64>) -> Vec<String> {
    if driver.engine() != Engine::Codex {
        return args;
    }
    let extra: Vec<String> = super::tidy::codex_config(window)
        .into_iter()
        .flat_map(|c| ["-c".to_string(), c])
        .collect();
    let at = args
        .iter()
        .position(|a| a == "--skip-git-repo-check")
        .map(|i| i + 1)
        .unwrap_or(args.len());
    args.splice(at..at, extra);
    args
}

/// A turn's command line with what this agent can reach laid in:
/// Claude Code without its browser (`--no-chrome`) when the user took it
/// away, and kept from the claude.ai connectors it isn't granted (added to
/// the existing `--disallowedTools` list, which another flag always ends);
/// Codex with one `-c` per connection server, before the trailing session
/// and `-` of `exec`. Never a token: connection servers are the bridge's
/// relay (`conn_relay`), reached with the turn's own bridge secret.
fn with_access(
    driver: Driver,
    mut args: Vec<String>,
    access: &super::connections::TurnAccess,
) -> Vec<String> {
    match driver {
        Driver::ClaudePrint => {
            if !access.browser {
                for a in args.iter_mut().filter(|a| a.as_str() == "--chrome") {
                    *a = "--no-chrome".into();
                }
            }
            if let Some(at) = args.iter().position(|a| a == "--disallowedTools") {
                for (i, entry) in access.blocked.iter().enumerate() {
                    args.insert(at + 1 + i, entry.clone());
                }
            }
            args
        }
        Driver::CodexApp | Driver::CodexExec => {
            let extra: Vec<String> = access
                .codex_config()
                .into_iter()
                .flat_map(|c| ["-c".to_string(), c])
                .collect();
            let at = args
                .iter()
                .position(|a| a == "--skip-git-repo-check")
                .map(|i| i + 1)
                .unwrap_or(args.len());
            args.splice(at..at, extra);
            args
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec<'a>(session: &'a str, resuming: bool, writable: &'a [String]) -> TurnSpec<'a> {
        TurnSpec {
            model: None,
            session,
            resuming,
            url: "http://x",
            mcp_config: "/s/mcp.json",
            system_prompt: "be useful",
            writable,
            protected: None,
            access: None,
            window: None,
        }
    }

    #[test]
    fn every_turn_has_compaction_on_whichever_engine() {
        let writable: Vec<String> = Vec::new();
        let mut s = spec("sid", true, &writable);
        s.window = Some(258_400);
        let claude = Driver::ClaudePrint.args(&s);
        assert!(claude
            .windows(2)
            .any(|w| w[0] == "--settings" && w[1] == r#"{"autoCompactEnabled":true}"#));
        for driver in [Driver::CodexApp, Driver::CodexExec] {
            let args = driver.args(&s);
            let config: Vec<&str> = args
                .windows(2)
                .filter(|w| w[0] == "-c")
                .map(|w| w[1].as_str())
                .collect();
            assert!(config.iter().any(|c| c.starts_with("compact_prompt=")));
            assert!(config.contains(&"model_auto_compact_token_limit=219640"));
            assert!(!args.iter().any(|a| a == "--settings"));
        }
        assert_eq!(
            Driver::CodexExec.args(&s).last().map(String::as_str),
            Some("-")
        );
    }

    #[test]
    fn what_an_agent_can_reach_shapes_its_command_line_but_never_carries_a_token() {
        use crate::agents::connections::{TurnAccess, TurnServer};
        let access = TurnAccess {
            servers: vec![TurnServer {
                key: "linear".into(),
                url: "http://127.0.0.1:4321/mcp/conn/linear".into(),
            }],
            blocked: vec!["mcp__claude_ai_Gmail".into()],
            browser: false,
            prompt: String::new(),
        };
        let writable: Vec<String> = Vec::new();
        let mut s = spec("sid", true, &writable);
        s.access = Some(&access);
        let claude = Driver::ClaudePrint.args(&s);
        assert!(claude.contains(&"--no-chrome".to_string()));
        assert!(!claude.contains(&"--chrome".to_string()));
        let at = claude
            .iter()
            .position(|a| a == "--disallowedTools")
            .unwrap();
        assert_eq!(claude[at + 1], "mcp__claude_ai_Gmail");
        for driver in [Driver::ClaudePrint, Driver::CodexApp, Driver::CodexExec] {
            assert!(
                !driver.args(&s).concat().contains("mcp.linear.app"),
                "{driver:?} reaches the app only through the relay"
            );
        }
        let exec = Driver::CodexExec.args(&s);
        assert_eq!(
            exec.last().map(String::as_str),
            Some("-"),
            "exec still ends on stdin"
        );
        assert!(exec.iter().any(|a| a.starts_with("mcp_servers.linear=")));
        let app = Driver::CodexApp.args(&s);
        assert!(app
            .iter()
            .any(|a| a.contains("mcp_servers.linear=")
                && a.contains("SHIPSTUDIO_AGENTS_BRIDGE_TOKEN")));
        // No reach worked out: no browser.
        s.access = None;
        assert!(Driver::ClaudePrint
            .args(&s)
            .contains(&"--no-chrome".to_string()));
    }

    #[tokio::test]
    async fn the_turn_runs_codex_over_the_app_server_only_when_it_has_one() {
        use crate::agents::codex_app::fake;
        let dir = tempfile::tempdir().unwrap();
        let app = fake::codex(&fake::folder(dir.path(), "app"), fake::Kind::AppServer);
        let old = fake::codex(&fake::folder(dir.path(), "old"), fake::Kind::ExecOnly);
        assert_eq!(Driver::pick(Engine::Codex, &app).await, Driver::CodexApp);
        assert_eq!(Driver::pick(Engine::Codex, &old).await, Driver::CodexExec);
        // Claude Code's binary is never probed for an app-server.
        assert_eq!(
            Driver::pick(Engine::Claude, Path::new("/nonexistent/claude")).await,
            Driver::ClaudePrint
        );
    }

    #[tokio::test]
    async fn only_a_codex_turn_waits_on_a_sign_in_check() {
        let never = || async { panic!("Claude Code's sign-in is the turn's to check") };
        assert!(Driver::ClaudePrint.ready_if(never).await.is_ok());
        for codex in [Driver::CodexApp, Driver::CodexExec] {
            assert!(codex.ready_if(|| async { true }).await.is_ok());
            let refused = codex.ready_if(|| async { false }).await.unwrap_err();
            assert!(refused.to_string().contains("Not logged in"));
        }
    }

    #[test]
    fn the_command_lines_are_each_engines_own() {
        let dirs = vec!["/u/ShipStudio".to_string()];
        let claude = Driver::ClaudePrint.args(&spec("sid", true, &dirs));
        assert!(claude.windows(2).any(|w| w == ["--resume", "sid"]));
        assert!(claude.contains(&"--permission-prompt-tool".to_string()));

        let app = Driver::CodexApp.args(&spec("t1", true, &dirs));
        assert_eq!(app[0], "app-server");
        // The thread is resumed over JSON-RPC, not on the command line.
        assert!(!app.contains(&"t1".to_string()));

        let exec = Driver::CodexExec.args(&spec("t1", true, &dirs));
        assert_eq!(&exec[..2], ["exec", "resume"]);
        assert!(exec.contains(&"approval_policy=\"never\"".to_string()));
        assert_eq!(exec.last().map(String::as_str), Some("-"));
        assert_eq!(exec[exec.len() - 2], "t1");

        let fresh = Driver::CodexExec.args(&spec("", false, &dirs));
        assert_eq!(fresh[0], "exec");
        assert_ne!(fresh[1], "resume");
    }

    #[test]
    fn a_leftover_process_is_known_by_its_session_or_its_home() {
        let home = Path::new("/h/agent");
        assert_eq!(Driver::ClaudePrint.process_mark("sid", home), "sid");
        assert_eq!(Driver::CodexApp.process_mark("", home), "/h/agent");
    }
}
