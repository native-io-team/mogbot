//! Guided public GitHub issue submission.
//!
//! Issues always go to the canonical upstream repository named by
//! `links.issueRepo` in brand.json (`owner/repo`). With none configured the
//! feature is off: the UI hides it and submission refuses. The selected
//! project's remote is never consulted; only its workspace-scoped GitHub
//! credential is used when a project path is present.

use crate::commands::github::{
    get_gh_command, get_gh_command_for_project, gh_auth_error, gh_common_error,
};
use crate::errors::CommandError;
use crate::external_command::{run_with_timeout, run_with_timeout_stdin, truncate_output};
use crate::utils::validate_project_path;
use serde::Serialize;
use serde_json::Value;
use std::process::Command;

/// `owner/repo` issues are filed against, or `None` (feature off).
const UPSTREAM_ISSUE_REPO: Option<&str> = crate::brand::links::ISSUE_REPO;
const GH_TIMEOUT_SECS: u64 = 30;
const MAX_TITLE_CHARS: usize = 256;
const MAX_BODY_CHARS: usize = 65_536;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReportContext {
    pub app_version: String,
    pub operating_system: String,
    pub architecture: String,
    pub default_agent: Option<String>,
}

/// A timed-out or malformed POST response is represented as a normal result
/// so the frontend can require the user to check the issue list before retrying.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SubmitGitHubIssueResult {
    Created {
        number: u64,
        #[serde(rename = "issueUrl")]
        issue_url: String,
        login: String,
    },
    Uncertain {
        login: String,
        message: String,
        #[serde(rename = "issueListUrl")]
        issue_list_url: String,
    },
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn get_issue_report_context(
    app: tauri::AppHandle,
) -> Result<IssueReportContext, CommandError> {
    Ok(IssueReportContext {
        app_version: app.package_info().version.to_string(),
        operating_system: operating_system_name(std::env::consts::OS).to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        default_agent: crate::commands::setup::get_default_agent_id()
            .await
            .as_deref()
            .and_then(saved_agent_name)
            .map(str::to_string),
    })
}

fn saved_agent_name(agent_id: &str) -> Option<&'static str> {
    match agent_id {
        "claude-code" => Some("Claude Code"),
        "codex" => Some("Codex"),
        "opencode" => Some("Opencode"),
        "cursor" => Some("Cursor"),
        _ => None,
    }
}

/// Submit one public bug report or feature request to the canonical upstream.
/// The title/body are deliberately skipped from tracing: both may contain
/// sensitive user-authored text, including pasted logs.
#[tauri::command]
#[tracing::instrument(skip_all, fields(issue_kind = %kind))]
pub async fn submit_github_issue(
    kind: String,
    title: String,
    body: String,
    project_path: Option<String>,
    expected_login: String,
) -> Result<SubmitGitHubIssueResult, CommandError> {
    let Some(repo) = UPSTREAM_ISSUE_REPO else {
        return Err(CommandError::expected(
            "Issue reporting isn't available in this build.",
        ));
    };
    let issue_endpoint = format!("repos/{repo}/issues");
    let label = issue_label(&kind)?;
    let title = normalized_title(&kind, &title)?;
    validate_issue_body(&body)?;

    let mut gh = gh_command_for_project(project_path.as_deref())?;
    gh.args(["api", "user", "--jq", ".login"]);
    let identity = run_with_timeout(
        tokio::process::Command::from(gh),
        "gh api user",
        GH_TIMEOUT_SECS,
    )
    .await
    .map_err(|error| match error {
        CommandError::Timeout { .. } => CommandError::expected(
            "GitHub took too long to confirm your signed-in account. Check your connection and try again.",
        ),
        other => other,
    })?;

    if !identity.status.success() {
        let stderr = String::from_utf8_lossy(&identity.stderr);
        if let Some(error) = issue_auth_error(&stderr) {
            return Err(error);
        }
        if let Some(error) = gh_common_error(&stderr) {
            return Err(error);
        }
        return Err(CommandError::expected(format!(
            "Couldn't confirm which GitHub account will be used. {}",
            truncate_output(&stderr)
        )));
    }

    let login = String::from_utf8_lossy(&identity.stdout).trim().to_string();
    if login.is_empty() {
        return Err(CommandError::expected(
            "GitHub didn't return the signed-in account name. Sign in with `gh auth login` and try again.",
        ));
    }
    if !login.eq_ignore_ascii_case(expected_login.trim()) {
        return Err(CommandError::expected(format!(
            "The active GitHub account changed from @{expected_login} to @{login} after review. Confirm the account and review the draft again before submitting."
        )));
    }

    let request = serde_json::json!({
        "title": title,
        "body": body,
        "labels": [label],
    });
    let request_json = serde_json::to_string(&request).map_err(|error| {
        CommandError::expected(format!("Couldn't prepare the GitHub issue: {error}"))
    })?;

    let mut gh = gh_command_for_project(project_path.as_deref())?;
    gh.args(["api", "--method", "POST", &issue_endpoint, "--input", "-"]);

    let output = match run_with_timeout_stdin(
        tokio::process::Command::from(gh),
        &request_json,
        "gh api create issue",
        GH_TIMEOUT_SECS,
    )
    .await
    {
        Ok(output) => output,
        // The shared runner uses `Expected` for failures to launch the CLI
        // (e.g. gh is missing), before any POST can be sent. Other errors may
        // happen after the request was written, so the user must check first.
        Err(error @ CommandError::Expected { .. }) => return Err(error),
        Err(_) => return Ok(uncertain_result(login, repo)),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(error) = issue_auth_error(&stderr) {
            return Err(error);
        }
        if definite_rejection(&stderr) {
            return Err(CommandError::expected(format!(
                "GitHub rejected this issue request. {}",
                truncate_output(&stderr)
            )));
        }

        // A connection can close after GitHub accepted the POST. Keep the
        // draft and avoid suggesting a blind retry for every unrecognized
        // response shape.
        return Ok(uncertain_result(login, repo));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    match parse_created_issue(&stdout, &login, repo) {
        Some(created) => Ok(created),
        // Exit status zero without a complete, verified API response does not
        // prove whether the issue was created.
        None => Ok(uncertain_result(login, repo)),
    }
}

fn gh_command_for_project(project_path: Option<&str>) -> Result<Command, CommandError> {
    match project_path {
        Some(path) => {
            let validated = validate_project_path(path).map_err(CommandError::from)?;
            Ok(get_gh_command_for_project(&validated))
        }
        None => Ok(get_gh_command()),
    }
}

fn issue_label(kind: &str) -> Result<&'static str, CommandError> {
    match kind {
        "bug" => Ok("bug"),
        "feature" => Ok("enhancement"),
        _ => Err(CommandError::Validation {
            field: "kind".to_string(),
            reason: "Choose either a bug report or a feature request.".to_string(),
        }),
    }
}

fn normalized_title(kind: &str, title: &str) -> Result<String, CommandError> {
    let prefix = match kind {
        "bug" => "[Bug]",
        "feature" => "[Feature]",
        _ => {
            return Err(CommandError::Validation {
                field: "kind".to_string(),
                reason: "Choose either a bug report or a feature request.".to_string(),
            })
        }
    };
    let title = title.trim();
    if title.is_empty() || title == prefix {
        return Err(CommandError::Validation {
            field: "title".to_string(),
            reason: "Enter a title for the issue.".to_string(),
        });
    }
    let title = if title.starts_with(prefix) {
        title.to_string()
    } else {
        format!("{prefix} {title}")
    };
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(CommandError::Validation {
            field: "title".to_string(),
            reason: format!("Keep the title under {MAX_TITLE_CHARS} characters."),
        });
    }
    Ok(title)
}

fn validate_issue_body(body: &str) -> Result<(), CommandError> {
    if body.trim().is_empty() {
        return Err(CommandError::Validation {
            field: "body".to_string(),
            reason: "Add the details for this issue.".to_string(),
        });
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(CommandError::Validation {
            field: "body".to_string(),
            reason: format!("Keep the issue details under {MAX_BODY_CHARS} characters."),
        });
    }
    Ok(())
}

fn parse_created_issue(stdout: &str, login: &str, repo: &str) -> Option<SubmitGitHubIssueResult> {
    let issue: Value = serde_json::from_str(stdout).ok()?;
    let number = issue.get("number")?.as_u64()?;
    if number == 0 {
        return None;
    }
    let issue_url = issue.get("html_url")?.as_str()?;
    let canonical_path = format!("https://github.com/{repo}/issues/{number}");
    if issue_url != canonical_path {
        return None;
    }
    Some(SubmitGitHubIssueResult::Created {
        number,
        // Use GitHub's returned URL verbatim after validating it. Never build
        // a success link from an assumed issue number or destination.
        issue_url: issue_url.to_string(),
        login: login.to_string(),
    })
}

fn definite_rejection(stderr: &str) -> bool {
    ["HTTP 400", "HTTP 403", "HTTP 404", "HTTP 410", "HTTP 422"]
        .iter()
        .any(|status| stderr.contains(status))
}

fn issue_auth_error(stderr: &str) -> Option<CommandError> {
    let lower = stderr.to_lowercase();
    if lower.contains("http 401") || lower.contains("bad credentials") {
        return Some(CommandError::NotAuthenticated {
            service: "github".to_string(),
        });
    }
    gh_auth_error(stderr)
}

fn uncertain_result(login: String, repo: &str) -> SubmitGitHubIssueResult {
    SubmitGitHubIssueResult::Uncertain {
        login,
        message: "GitHub didn't confirm whether it created this issue. Check the issue list before retrying. Your draft is still here.".to_string(),
        issue_list_url: format!("https://github.com/{repo}/issues"),
    }
}

fn operating_system_name(os: &str) -> &str {
    match os {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        "ios" => "iOS",
        "android" => "Android",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bug_and_feature_titles_get_the_template_prefix() {
        assert_eq!(
            normalized_title("bug", " Preview gets stuck ").unwrap(),
            "[Bug] Preview gets stuck"
        );
        assert_eq!(
            normalized_title("feature", "[Feature] Add export").unwrap(),
            "[Feature] Add export"
        );
    }

    #[test]
    fn labels_match_the_repository_templates() {
        assert_eq!(issue_label("bug").unwrap(), "bug");
        assert_eq!(issue_label("feature").unwrap(), "enhancement");
        assert!(issue_label("security").is_err());
    }

    #[test]
    fn only_the_actual_canonical_issue_response_is_a_success() {
        let repo = "example-org/example-app";
        let created = parse_created_issue(
            r#"{"number":42,"html_url":"https://github.com/example-org/example-app/issues/42"}"#,
            "ship-user",
            repo,
        );
        assert!(matches!(
            created,
            Some(SubmitGitHubIssueResult::Created { number: 42, .. })
        ));
        for untrusted_url in [
            "https://github.com:443/example-org/example-app/issues/42",
            "https://github.com:444/example-org/example-app/issues/42",
            "https://user@github.com/example-org/example-app/issues/42",
            "https://github.com/example-org/example-app/issues/42?redirect=1",
            "https://github.com/another-fork/example-app/issues/42",
        ] {
            let response = format!(r#"{{"number":42,"html_url":"{untrusted_url}"}}"#);
            assert!(parse_created_issue(&response, "ship-user", repo).is_none());
        }
        assert!(parse_created_issue("not json", "ship-user", repo).is_none());
    }

    #[test]
    fn known_api_rejections_are_distinguished_from_uncertain_responses() {
        assert!(definite_rejection("gh: HTTP 422: Validation Failed"));
        assert!(!definite_rejection("gh: HTTP 503: Service Unavailable"));
    }

    #[test]
    fn context_os_name_uses_the_reported_target_name() {
        assert_eq!(operating_system_name("macos"), "macOS");
        assert_eq!(operating_system_name("windows"), "Windows");
        assert_eq!(operating_system_name("unrecognized"), "unrecognized");
    }

    #[test]
    fn context_only_names_an_explicitly_saved_known_agent() {
        assert_eq!(saved_agent_name("claude-code"), Some("Claude Code"));
        assert_eq!(saved_agent_name("codex"), Some("Codex"));
        assert_eq!(saved_agent_name("opencode"), Some("Opencode"));
        assert_eq!(saved_agent_name("cursor"), Some("Cursor"));
        assert_eq!(saved_agent_name("unknown"), None);
    }

    #[test]
    fn context_architecture_comes_from_the_runtime_target() {
        assert!(!std::env::consts::ARCH.is_empty());
    }
}
