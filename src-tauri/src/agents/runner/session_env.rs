//! Running `claude` outside the session that may have launched the app: the inherited session variables, stripped from every turn.

/// A Ship Studio launched from inside a Claude Code session (a terminal
/// running `claude`, or a dev build started by one) inherits that session's
/// variables. With them, each agent runs as a nested child session that is
/// never written to disk, so the next `--resume` finds nothing. Observed:
/// every agent lost its memory between turns. Every `claude` we run for
/// Agents goes through this.
pub fn strip_session_env(cmd: &mut std::process::Command) {
    for key in inherited_session_vars() {
        cmd.env_remove(key);
    }
}

/// The variables of this app's own environment that [`strip_session_env`]
/// removes: one list for every process Agents runs (a turn's, and a
/// take-over's terminal).
pub fn inherited_session_vars() -> Vec<String> {
    session_vars(std::env::vars_os().map(|(k, _)| k.to_string_lossy().into_owned()))
}

/// Which of `names` mark a nested Claude Code session.
pub fn session_vars(names: impl IntoIterator<Item = String>) -> Vec<String> {
    names.into_iter().filter(|k| is_session_var(k)).collect()
}

pub(super) fn is_session_var(key: &str) -> bool {
    key == "CLAUDECODE"
        || key == "CLAUDE_PID"
        || key == "CLAUDE_EFFORT"
        || key.starts_with("CLAUDE_CODE_")
}
