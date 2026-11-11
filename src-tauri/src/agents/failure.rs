//! A failed turn in Agents' own words, and what the UI can offer for it.
//!
//! Claude Code's failures reach us raw (stderr, a `result` error) or already
//! classified for another feature (`commands::ai`, whose copy talks about "AI
//! generation"). The two states people actually hit — the usage limit and an
//! expired sign-in — are said plainly here, and tagged so the chat and the
//! sidebar can treat them as the expected, self-healing states they are.
//!
//! The reset time is only ever Claude Code's own: an epoch it printed, or a
//! clock time in this Mac's time zone. A time in another zone is quoted, not
//! converted, because we carry no time-zone database to convert it with.

use chrono::{Datelike, Duration, TimeZone};
use serde::{Deserialize, Serialize};

use super::engine::Engine;
use super::schedule;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    UsageLimit,
    SignedOut,
    /// Cut off part-way (the app restarted, or its engine died) and not
    /// picked up on its own: Continue carries on in the same conversation.
    Interrupted,
    /// Its engine isn't on this Mac any more (uninstalled, moved, or it
    /// won't run): the fix is installing it again, not retrying.
    EngineMissing,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub kind: FailureKind,
    /// When the usage limit resets (epoch ms), when Claude Code said so in a
    /// form that can be put on this Mac's clock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

impl Failure {
    pub const OTHER: Failure = Failure {
        kind: FailureKind::Other,
        resets_at: None,
    };
    pub const INTERRUPTED: Failure = Failure {
        kind: FailureKind::Interrupted,
        resets_at: None,
    };
}

/// The chat line and its tag for a failed turn, on this Mac's clock. A
/// usage limit whose message gave no reset time takes the one the engine
/// last reported for its used-up window (`super::quota`), if any.
pub fn describe_now(engine: Engine, detail: &str) -> (String, Failure) {
    let zone = iana_time_zone::get_timezone().ok();
    let now = super::store::now_ms();
    let described = describe(engine, detail, &chrono::Local, zone.as_deref(), now);
    let reported = super::quota::limited_until(&super::quota::load(), engine, now);
    with_reported_reset(engine, described, reported, &chrono::Local, now)
}

/// `describe`'s answer, given the reset time the engine's quota reading
/// says (only used when the message itself named none).
pub fn with_reported_reset<Tz: TimeZone>(
    engine: Engine,
    (text, failure): (String, Failure),
    reported: Option<i64>,
    tz: &Tz,
    now: i64,
) -> (String, Failure)
where
    Tz::Offset: std::fmt::Display,
{
    match (failure.kind, failure.resets_at, reported) {
        (FailureKind::UsageLimit, None, Some(at)) if at > now => (
            format!(
                "{} is out of usage until {}.",
                engine.label(),
                until_phrase(&clock_phrase(tz, at, now))
            ),
            Failure {
                kind: FailureKind::UsageLimit,
                resets_at: Some(at),
            },
        ),
        _ => (text, failure),
    }
}

pub fn describe<Tz: TimeZone>(
    engine: Engine,
    detail: &str,
    tz: &Tz,
    zone: Option<&str>,
    now: i64,
) -> (String, Failure)
where
    Tz::Offset: std::fmt::Display,
{
    let who = engine.label();
    let lower = detail.to_lowercase();
    if is_usage_limit(&lower) {
        let reset = reset_words(&lower);
        let resets_at = reset_epoch(&lower).or_else(|| {
            let (words, named_zone) = reset.as_ref()?;
            // Another zone's clock time can't be placed without a tz database.
            if named_zone.is_some()
                && named_zone.as_deref() != zone.map(str::to_lowercase).as_deref()
            {
                return None;
            }
            next_clock_time(tz, words, now)
        });
        // One phrase for it everywhere: "out of usage until …".
        let text = match (resets_at, &reset) {
            (Some(at), _) => format!(
                "{who} is out of usage until {}.",
                until_phrase(&clock_phrase(tz, at, now))
            ),
            (None, Some((words, zone))) => match zone {
                Some(_) => format!(
                    "{who} is out of usage. {who} says it refills {}.",
                    original_case(detail, words)
                ),
                None => format!("{who} is out of usage. {who} says it refills at {words}."),
            },
            (None, None) => {
                format!("{who} is out of usage. It refills on its own; try again later.")
            }
        };
        return (
            text,
            Failure {
                kind: FailureKind::UsageLimit,
                resets_at,
            },
        );
    }
    if is_signed_out(&lower) {
        return (
            format!("{who} is signed out."),
            Failure {
                kind: FailureKind::SignedOut,
                resets_at: None,
            },
        );
    }
    // A per-minute rate limit (an API 429) is a blip, not the usage limit:
    // it says so, and stays a plain failure the user can retry.
    if is_rate_limited(&lower) {
        return (
            format!("{who} is being rate-limited right now. Try again in a minute."),
            Failure::OTHER,
        );
    }
    if is_engine_missing(&lower) {
        return (
            missing_engine_line(who),
            Failure {
                kind: FailureKind::EngineMissing,
                resets_at: None,
            },
        );
    }
    (plain_other(engine, detail), Failure::OTHER)
}

/// The one sentence for an engine this Mac can't run: what happened and the
/// fix, which the chat's Install button does.
pub fn missing_engine_line(who: &str) -> String {
    format!("{who} isn't on this Mac any more, or the app can't find it. Install it again, then send this again.")
}

fn is_engine_missing(lower: &str) -> bool {
    [
        // `missing_engine_line`, and older builds' sentences.
        "isn't on this mac any more",
        "isn't installed, or the app can't find it",
        "isn't installed on this mac",
    ]
    .iter()
    .any(|w| lower.contains(w))
}

/// Who runs the model an engine talks to, for "couldn't reach Anthropic".
fn provider(engine: Engine) -> &'static str {
    match engine {
        Engine::Claude => "Anthropic",
        Engine::Codex => "OpenAI",
        // Whichever provider it is set up with.
        Engine::OpenCode => "its model provider",
    }
}

/// Anything else, in a sentence a person can act on. The network and the
/// provider's own trouble are named (and still read as temporary to
/// `is_temporary`, so a routine tries again); a sentence the app already
/// wrote is kept; raw output (exit codes, stack traces, JSON, os errors) is
/// logged, never put in the chat.
fn plain_other(engine: Engine, detail: &str) -> String {
    let who = engine.label();
    let by = provider(engine);
    let lower = detail.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    if has(&[
        "enotfound",
        "eai_again",
        "getaddrinfo",
        "network is unreachable",
        "no route to host",
        "not connected to the internet",
        "internet connection appears to be offline",
        "dns error",
        "failed to lookup address",
        "error sending request",
        "fetch failed",
        "connection error",
        "connection refused",
        "connection reset",
        "econnreset",
        "econnrefused",
        "etimedout",
        "socket hang up",
        "stream disconnected",
        "request timed out",
    ]) {
        return format!(
            "{who} couldn't reach {by} over the network. Retry once this Mac is back online."
        );
    }
    if has(&["overloaded", "api error: 529", "status 529"]) {
        return format!(
            "{by}'s servers are overloaded right now, so {who} stopped. Retry in a few minutes."
        );
    }
    if has(&[
        "api error: 5",
        "api error (5",
        "status 5",
        "status: 5",
        "status code 5",
        "internal server error",
        "service unavailable",
        "bad gateway",
        "gateway timeout",
    ]) {
        return format!("{by} is temporarily unavailable (a problem on their side), so {who} stopped. Retry in a few minutes.");
    }
    if has(&[
        "prompt is too long",
        "context_length_exceeded",
        "maximum context length",
    ]) {
        return format!("This conversation is too long for {who} to carry on. Start fresh (the agent keeps its memory), then send this again.");
    }
    if is_raw(detail) {
        tracing::warn!(
            "[Agents] {who} failed with output we can't name: {}",
            detail.trim()
        );
        return format!("{who} stopped with an error it didn't explain. Retry; if it happens again, start a fresh conversation.");
    }
    detail.trim().to_string()
}

/// Output meant for a developer, not a sentence: several lines, an exit
/// code, an os error, a stack frame, JSON, a typed error code.
fn is_raw(detail: &str) -> bool {
    let t = detail.trim();
    if t.is_empty() {
        return true;
    }
    let lower = t.to_lowercase();
    let typed_code = t
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|w| {
            w.len() > 4
                && w.contains('_')
                && w.chars()
                    .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
        });
    t.lines().filter(|l| !l.trim().is_empty()).count() > 2
        || t.contains('{')
        || t.contains('\u{1b}')
        || typed_code
        || [
            "os error",
            "exit code",
            "exit status",
            "errno",
            "panicked",
            "traceback",
            "stack backtrace",
            "    at ",
            "error[",
            "thread '",
            "signal: ",
            "sigkill",
            "sigsegv",
            "no such file or directory",
            "permission denied",
        ]
        .iter()
        .any(|w| lower.contains(w))
}

/// Agents' own words for the CLI failures people hit that aren't the usage
/// limit or a sign-in (those are [`describe`]'s): the remedy in this app's
/// terms, never another feature's copy ("AI generation") or a terminal to
/// live in. `None` for anything else, which is shown as the CLI said it,
/// and for the usage limit or a sign-in, so [`describe`] says those (and
/// tags them) even when other words come with them: the usage limit is
/// checked before usage credits, as `commands::ai` always did.
pub fn cli_failure(who: &str, detail: &str) -> Option<String> {
    let lower = detail.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    // The sign-in race says "sign in again" too, but is its own case below.
    let refresh_race = has(&[
        "failed to refresh oauth token",
        "another claude code process is refreshing it",
    ]);
    if is_usage_limit(&lower) || (is_signed_out(&lower) && !refresh_race) {
        return None;
    }
    let text = if has(&["usage credits", "usage-credits"]) {
        format!("{who} needs usage credits for the model this agent uses. Add credits to your account, or pick another model in Edit agent, then send this again.")
    } else if has(&["not supported when using codex with a chatgpt account"]) {
        format!("{who} is set to a model your ChatGPT plan doesn't include. Pick another model in Edit agent, then send this again.")
    } else if has(&["selected model is at capacity"]) {
        "The model this agent uses is at capacity right now. Try again in a few minutes, or pick another model in Edit agent.".to_string()
    } else if has(&["failed to load skill"]) {
        format!("{who} couldn't load one of your installed skills: its SKILL.md is missing a required field. Fix or remove that skill, then send this again.")
    } else if has(&[
        "has not been trusted",
        "hastrustdialogaccepted",
        "workspace trust required",
        "do you trust the contents of this directory",
    ]) {
        format!("{who} hasn't been allowed to work in this folder yet, so it won't start here. Open the project, start {who} there once and accept its trust question, then send this again.")
    } else if refresh_race {
        format!("{who} couldn't refresh its sign-in because another {who} was doing the same. Try again in a minute.")
    } else if has(&["api key has expired"]) {
        format!("{who}'s API key has expired. Make a new one with your provider and update it in {who}'s settings, then send this again.")
    } else if has(&["subscription access", "ask your admin"]) {
        format!("Your organization has turned off subscription access to {who}. Use an API key instead, or ask your admin to turn it back on.")
    } else if has(&[
        "permission allow rule",
        "permission deny rule",
        "wildcard before the rest of the command",
    ]) {
        format!("{who} refused to start because a permission rule in this project's .claude/settings.json (or settings.local.json) is invalid: it has a wildcard before the rest of the command. Fix or remove that rule, then send this again.")
    } else if has(&["failed to load models cache", "codex_models_manager::cache"]) {
        format!("{who}'s list of models is out of date. Delete ~/.codex/models_cache.json, then send this again.")
    } else if lower.contains("no stdin data received")
        && lower.contains("input must be provided either through stdin")
    {
        format!("{who} started too slowly to read the message. Send it again.")
    } else {
        return None;
    };
    Some(text)
}

/// An API 429 or the CLI saying it's being rate-limited, in either engine's
/// wording ("rate_limit_error", Codex's "Rate limit exceeded, retry later").
fn is_rate_limited(lower: &str) -> bool {
    [
        "rate limit",
        "rate_limit",
        "rate-limit",
        "too many requests",
        "api error: 429",
        "status 429",
        "status: 429",
    ]
    .iter()
    .any(|w| lower.contains(w))
}

/// A failure that heals on its own, so a scheduled run is worth trying again:
/// the usage limit, the provider (Anthropic or OpenAI) overloaded or
/// erroring, or the network, in either engine's wording. Not a
/// sign-in (that needs the user), and not anything we can't name.
pub fn is_temporary(detail: &str, failure: &Failure) -> bool {
    match failure.kind {
        FailureKind::UsageLimit => true,
        // Not run again by itself: it may have done half its work; or
        // only installing the engine fixes it.
        FailureKind::SignedOut | FailureKind::Interrupted | FailureKind::EngineMissing => false,
        FailureKind::Other => {
            let lower = detail.to_lowercase();
            let server_error = [
                "api error: 5",
                "api error (5",
                "status 5",
                "status: 5",
                "status code 5",
            ]
            .iter()
            .any(|w| lower.contains(w));
            server_error
                || [
                    "overloaded",
                    "internal server error",
                    "service unavailable",
                    "bad gateway",
                    "gateway timeout",
                    "connection error",
                    "connection reset",
                    "connection refused",
                    "network",
                    "econnreset",
                    "econnrefused",
                    "etimedout",
                    "enotfound",
                    "eai_again",
                    "socket hang up",
                    "fetch failed",
                    "timed out",
                    "temporarily unavailable",
                    // Codex, when its connection to OpenAI drops mid-turn.
                    "stream disconnected",
                    // `cli_failure`'s own sentence for a slow cold start.
                    "started too slowly",
                ]
                .iter()
                .any(|w| lower.contains(w))
                || is_rate_limited(&lower)
        }
    }
}

fn is_usage_limit(lower: &str) -> bool {
    // Not "usage credits": that one resets when the user tops up, not on a
    // clock. "Quota exceeded" is `commands::ai`'s usage-limit wording too.
    let is = [
        "usage limit",
        "session limit",
        "weekly limit",
        "hour limit",
        "quota exceeded",
        // Claude Code 2.1's per-model plan limits ("You've hit your Opus
        // limit · resets …"), and the typed codes when they're quoted.
        "opus limit",
        "sonnet limit",
        "fable limit",
        "usage_limit_reached",
        "usagelimitexceeded",
    ]
    .iter()
    .any(|w| lower.contains(w))
        // Both engines open with it; Codex's apostrophe is U+2019.
        || ((lower.contains("you've hit your") || lower.contains("you\u{2019}ve hit your"))
            && lower.contains("limit")
            && !lower.contains("spend cap"))
    // Claude Code's server throttling says, in so many words, it isn't.
    ;
    is && !lower.contains("not your usage limit")
}

/// Claude Code's and Codex's own wordings, and `commands::ai`'s classified
/// sentence. Codex signed out, against OpenAI (observed): "unexpected status
/// 401 Unauthorized: Missing bearer or basic authentication in header".
fn is_signed_out(lower: &str) -> bool {
    [
        "please run /login",
        "401 unauthorized",
        "sign in again",
        "oauth token has expired",
        "isn't signed in anymore",
        "session expired",
        "not logged in",
        "invalid api key",
        // Codex's refresh-token rotation failing: only signing in again fixes it.
        "failed to refresh token",
        "refresh_token_reused",
    ]
    .iter()
    .any(|w| lower.contains(w))
}

/// "Claude AI usage limit reached|1730000000": the reset as epoch seconds.
fn reset_epoch(lower: &str) -> Option<i64> {
    let (_, rest) = lower.split_once("limit reached|")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    (digits.len() >= 9).then(|| digits.parse::<i64>().ok().map(|s| s * 1000))?
}

/// "resets 4:40pm (asia/dubai)" → ("4:40pm", Some("asia/dubai")). Only a clock
/// time counts; "resets Nov 7" and the like are left to the generic line.
/// Codex says "try again at 7:18 pm." (observed), in this Mac's time.
fn reset_words(lower: &str) -> Option<(String, Option<String>)> {
    let (_, rest) = lower
        .split_once("resets ")
        .or_else(|| lower.split_once("reset at "))
        .or_else(|| lower.split_once("try again at "))?;
    let rest = rest.trim_start_matches("at ").trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == ':' || c == 'a' || c == 'p' || c == 'm'))
        .unwrap_or(rest.len());
    // "7:18 pm" (Codex) reads as "7:18pm" (Claude Code).
    let spaced = [" am", " pm"]
        .into_iter()
        .find(|m| rest[end..].starts_with(m));
    let time = match spaced {
        Some(m) => format!("{}{}", &rest[..end], m.trim()),
        None => rest[..end].to_string(),
    };
    let end = end + spaced.map_or(0, str::len);
    parse_clock(&time)?;
    let after = rest[end..].trim_start();
    let zone = after
        .strip_prefix('(')
        .and_then(|z| z.split_once(')'))
        .map(|(z, _)| z.trim().to_string())
        .filter(|z| !z.is_empty());
    Some((time, zone))
}

/// The span of `words` as Claude Code wrote it (case and zone included), for quoting.
fn original_case(detail: &str, words: &str) -> String {
    let lower = detail.to_lowercase();
    let Some(start) = lower.find(&format!("resets {words}")).map(|i| i + 7) else {
        return words.to_string();
    };
    let Some(tail) = detail.get(start..) else {
        return words.to_string();
    };
    let end = tail.find(')').map(|i| i + 1).unwrap_or(words.len());
    tail.get(..end).unwrap_or(words).to_string()
}

/// "4:40pm" / "3pm" / "15:00" → (hour, minute).
fn parse_clock(time: &str) -> Option<(u32, u32)> {
    let (digits, meridiem) = match time.strip_suffix("am").or_else(|| time.strip_suffix("pm")) {
        Some(d) => (d, Some(time.ends_with("pm"))),
        None => (time, None),
    };
    let (h, m) = match digits.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => (digits.parse::<u32>().ok()?, 0),
    };
    if m > 59 {
        return None;
    }
    let hour = match meridiem {
        Some(pm) if (1..=12).contains(&h) => (h % 12) + if pm { 12 } else { 0 },
        Some(_) => return None,
        // A bare number isn't a time ("resets 5" could be anything).
        None if digits.contains(':') && h < 24 => h,
        None => return None,
    };
    Some((hour, m))
}

/// The next time the clock reads `words`, from `now`.
fn next_clock_time<Tz: TimeZone>(tz: &Tz, words: &str, now: i64) -> Option<i64> {
    let (hour, minute) = parse_clock(words)?;
    let today = tz.timestamp_millis_opt(now).single()?.date_naive();
    let at = schedule::resolve(tz, today, hour, minute)?;
    if at > now {
        return Some(at);
    }
    schedule::resolve(tz, today + Duration::days(1), hour, minute)
}

/// "at 3:00 PM", "tomorrow at 3:00 PM", "Sat at 3:00 PM" within the week,
/// else "on Nov 14". The same rule for naming a day as everywhere else a
/// reset is said (`resetPhrase` in the companion protocol's quota.ts: the
/// Retry button, the sidebar), so the chat's sentence and the button beside
/// it never disagree about the day.
/// "at 3:00 PM" reads "until 3:00 PM"; "tomorrow at …", "Sat at …" stay.
pub fn until_phrase(phrase: &str) -> String {
    phrase.strip_prefix("at ").unwrap_or(phrase).to_string()
}

pub fn clock_phrase<Tz: TimeZone>(tz: &Tz, at: i64, now: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let (Some(then), Some(today)) = (
        tz.timestamp_millis_opt(at).single(),
        tz.timestamp_millis_opt(now).single(),
    ) else {
        return "soon".to_string();
    };
    let time = super::clock::of(&then);
    let days = (then.date_naive() - today.date_naive()).num_days();
    match days {
        ..=0 => format!("at {time}"),
        1 => format!("tomorrow at {time}"),
        2..=6 => format!("{} at {time}", then.format("%a")),
        _ => format!("on {} {}", then.format("%b"), then.day()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, Utc};

    /// The run path: `cli_failure` first, then `describe` on what it leaves.
    fn turn_failure(engine: Engine, raw: &str) -> (String, Failure) {
        let who = engine.label();
        let text = cli_failure(who, raw).unwrap_or_else(|| raw.to_string());
        describe(engine, &text, &Utc, None, NOW)
    }

    /// The wordings `commands::ai` used to classify for Agents, and the
    /// order it classified them in.
    #[test]
    fn expired_sessions_quotas_and_mixed_wordings_keep_ais_classification() {
        // An expired session is a sign-out (the sidebar says so).
        for raw in [
            "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"Session expired. Please log in again.\"}}",
            "Error: Your session expired. Sign in to continue.",
        ] {
            let (_, f) = turn_failure(Engine::Claude, raw);
            assert_eq!(f.kind, FailureKind::SignedOut, "{raw}");
        }
        // "Quota exceeded" is the usage limit, with the reset when it gives one.
        let (text, f) = turn_failure(
            Engine::Codex,
            "stream error: Quota exceeded for this account. Try again at 7:18 PM.",
        );
        assert_eq!(f.kind, FailureKind::UsageLimit);
        assert!(text.contains("is out of usage"), "{text}");
        assert!(is_temporary(&text, &f));
        let (_, f) = turn_failure(Engine::Claude, "Error: quota exceeded");
        assert_eq!(f.kind, FailureKind::UsageLimit);
        // Usage limit and usage credits in one message: the limit wins (it
        // resets on a clock), as it did in `commands::ai`.
        let (text, f) = turn_failure(
            Engine::Claude,
            "You've hit your usage limit · resets 4:40pm. Run /usage-credits to keep going, or wait.",
        );
        assert_eq!(f.kind, FailureKind::UsageLimit, "{text}");
        assert!(!text.contains("needs usage credits"), "{text}");
        // A sign-out that mentions a cli_failure wording is still a sign-out.
        let (_, f) = turn_failure(
            Engine::Claude,
            "Invalid API key · Please run /login. (this model requires usage credits)",
        );
        assert_eq!(f.kind, FailureKind::SignedOut);
        // The refresh race says "sign in again", but is its own sentence.
        let (text, f) = turn_failure(
            Engine::Claude,
            "Failed to refresh OAuth token: another Claude Code process is refreshing it. If this persists, sign in again.",
        );
        assert_eq!(f.kind, FailureKind::Other);
        assert!(
            text.contains("another Claude Code was doing the same"),
            "{text}"
        );
        // Credits alone are still credits.
        let (text, f) = turn_failure(
            Engine::Claude,
            "Fable 5 requires usage credits. Run /usage-credits to continue or switch models with /model.",
        );
        assert_eq!(f.kind, FailureKind::Other);
        assert!(text.contains("needs usage credits"), "{text}");
    }

    #[test]
    fn a_limit_without_a_time_takes_the_engines_reported_reset() {
        let bare = describe(
            Engine::Claude,
            "Claude AI usage limit reached",
            &Utc,
            None,
            NOW,
        );
        assert_eq!(bare.1.resets_at, None);
        let at = NOW + 3 * 3_600_000;
        let (text, failure) =
            with_reported_reset(Engine::Claude, bare.clone(), Some(at), &Utc, NOW);
        assert_eq!(failure.resets_at, Some(at));
        assert!(
            text.starts_with("Claude Code is out of usage until "),
            "{text}"
        );
        // A time the message gave wins; a reported reset already past is no help.
        let timed = describe(
            Engine::Claude,
            "Claude AI usage limit reached|1793620800",
            &Utc,
            None,
            NOW,
        );
        assert_eq!(
            with_reported_reset(Engine::Claude, timed.clone(), Some(at), &Utc, NOW),
            timed
        );
        assert_eq!(
            with_reported_reset(Engine::Claude, bare.clone(), Some(NOW - 1), &Utc, NOW),
            bare
        );
        // Not a usage limit: untouched.
        let other = describe(Engine::Claude, "boom", &Utc, None, NOW);
        assert_eq!(
            with_reported_reset(Engine::Claude, other.clone(), Some(at), &Utc, NOW),
            other
        );
    }

    #[test]
    fn only_failures_that_heal_on_their_own_are_temporary() {
        let temp = |d: &str| is_temporary(d, &describe(Engine::Claude, d, &Utc, None, NOW).1);
        let codex = |d: &str| is_temporary(d, &describe(Engine::Codex, d, &Utc, None, NOW).1);
        assert!(temp("Claude AI usage limit reached|1793620800"));
        assert!(temp(
            "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}"
        ));
        assert!(temp("API Error: 500 Internal server error"));
        assert!(temp("API Error: Connection error."));
        assert!(temp("API Error (Request timed out.)"));
        assert!(temp(
            "fetch failed: getaddrinfo ENOTFOUND api.anthropic.com"
        ));
        assert!(!temp("Claude Code is signed out. Please run /login"));
        assert!(!temp(
            "API Error: 400 invalid_request_error: prompt is too long"
        ));
        assert!(!temp("exit code Some(1), no output"));
        assert!(!temp("Spent 500 tokens"));
        // Codex's own wordings (observed).
        assert!(codex("You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:18 PM."));
        assert!(codex("stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)"));
        assert!(codex(
            "exceeded retry limit, last status: 503 Service Unavailable"
        ));
        assert!(codex("unexpected status 502 Bad Gateway"));
        assert!(!codex(
            "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"
        ));
        assert!(!codex("Codex says: Not logged in."));
        assert!(!codex("exceeded retry limit, last status: 400 Bad Request"));
    }

    /// Mon 2 Nov 2026, 10:00 UTC.
    const NOW: i64 = 1_793_613_600_000;

    #[test]
    fn a_reset_names_its_day_as_the_button_does() {
        // 2026-11-05 14:00 UTC, a Thursday.
        let now = Utc
            .with_ymd_and_hms(2026, 11, 5, 14, 0, 0)
            .unwrap()
            .timestamp_millis();
        let at = |d: u32, h: u32| {
            Utc.with_ymd_and_hms(2026, 11, d, h, 0, 0)
                .unwrap()
                .timestamp_millis()
        };
        assert_eq!(clock_phrase(&Utc, at(5, 17), now), "at 5:00 PM");
        assert_eq!(clock_phrase(&Utc, at(6, 9), now), "tomorrow at 9:00 AM");
        // Within the week: its weekday, never a date (the Retry button says "Sat").
        assert_eq!(clock_phrase(&Utc, at(7, 14), now), "Sat at 2:00 PM");
        assert_eq!(clock_phrase(&Utc, at(11, 9), now), "Wed at 9:00 AM");
        // A week or more away: the date.
        assert_eq!(clock_phrase(&Utc, at(12, 9), now), "on Nov 12");
    }

    #[test]
    fn a_local_clock_time_becomes_a_reset_time() {
        let (text, failure) = describe(
            Engine::Claude,
            "exit code Some(1): You've hit your session limit · resets 4:40pm",
            &Utc,
            Some("Etc/UTC"),
            NOW,
        );
        assert_eq!(failure.kind, FailureKind::UsageLimit);
        let at = failure.resets_at.expect("placed on the clock");
        assert_eq!(at, NOW + (6 * 60 + 40) * 60_000);
        assert_eq!(text, "Claude Code is out of usage until 4:40 PM.");
    }

    #[test]
    fn a_time_already_passed_today_is_tomorrow() {
        let (text, failure) = describe(
            Engine::Claude,
            "usage limit reached · resets 9am",
            &Utc,
            None,
            NOW,
        );
        assert_eq!(failure.resets_at, Some(NOW + 23 * 60 * 60_000));
        assert!(
            text.ends_with("out of usage until tomorrow at 9:00 AM."),
            "{text}"
        );
    }

    #[test]
    fn this_macs_named_zone_is_placed_and_another_is_only_quoted() {
        let here = describe(
            Engine::Claude,
            "You've hit your session limit · resets 4:40pm (Asia/Dubai)",
            &FixedOffset::east_opt(4 * 3600).unwrap(),
            Some("Asia/Dubai"),
            NOW,
        );
        assert!(here.1.resets_at.is_some());

        let (text, failure) = describe(
            Engine::Claude,
            "You've hit your session limit · resets 4:40pm (Asia/Dubai)",
            &Utc,
            Some("Europe/London"),
            NOW,
        );
        assert_eq!(failure.kind, FailureKind::UsageLimit);
        assert_eq!(failure.resets_at, None, "never invented");
        assert!(
            text.contains("Claude Code says it refills 4:40pm (Asia/Dubai)."),
            "{text}"
        );
    }

    #[test]
    fn an_epoch_reset_is_exact() {
        let (_, failure) = describe(
            Engine::Claude,
            "Claude AI usage limit reached|1793635200",
            &Utc,
            None,
            NOW,
        );
        assert_eq!(failure.resets_at, Some(1_793_635_200_000));
    }

    #[test]
    fn no_reset_time_offers_none() {
        let (text, failure) = describe(
            Engine::Claude,
            "Claude AI usage limit reached",
            &Utc,
            None,
            NOW,
        );
        assert_eq!(failure.resets_at, None);
        assert!(text.ends_with("It refills on its own; try again later."));
        // Nor does a bare number pass for a time.
        assert_eq!(
            describe(Engine::Claude, "usage limit · resets 5", &Utc, None, NOW)
                .1
                .resets_at,
            None
        );
    }

    #[test]
    fn the_other_features_wording_never_reaches_the_chat() {
        let classified =
            "Claude Code hit its usage limit, so AI generation isn't available right now. \
                          The limit resets automatically — try again later. (resets 4:40pm)";
        let (text, _) = describe(Engine::Claude, classified, &Utc, None, NOW);
        assert!(!text.contains("AI generation"), "{text}");

        let signed_out = "Claude Code isn't signed in anymore (its session expired). Open an agent \
                          terminal and sign in again — for Claude Code, run /login — then try again.";
        let (text, failure) = describe(Engine::Claude, signed_out, &Utc, None, NOW);
        assert_eq!(failure.kind, FailureKind::SignedOut);
        assert_eq!(text, "Claude Code is signed out.");
    }

    #[test]
    fn codex_says_its_own_failures_and_they_read_the_same() {
        // Codex 0.166's own words (observed), its clock time on this Mac's clock.
        let limit = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:18 PM.";
        let (text, failure) = describe(Engine::Codex, limit, &Utc, None, NOW);
        assert_eq!(failure.kind, FailureKind::UsageLimit);
        assert_eq!(failure.resets_at, Some(NOW + (9 * 60 + 18) * 60_000));
        assert_eq!(text, "Codex is out of usage until 7:18 PM.");
        let signed_out = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
        let (text, failure) = describe(Engine::Codex, signed_out, &Utc, None, NOW);
        assert_eq!(failure.kind, FailureKind::SignedOut);
        assert_eq!(text, "Codex is signed out.");
        let (_, failure) = describe(Engine::Codex, "Not logged in", &Utc, None, NOW);
        assert_eq!(failure.kind, FailureKind::SignedOut);
    }

    /// Wordings captured from Claude Code 2.1.304–2.1.318 (its binary and
    /// anthropics/claude-code#103820) and Codex 0.166 (`protocol/src/error.rs`).
    #[test]
    fn every_real_usage_limit_wording_is_the_usage_limit() {
        for raw in [
            "You've hit your weekly limit · resets 11am (UTC)",
            "You've hit your 5-hour limit · resets 3pm",
            "You've hit your Opus limit · resets Nov 7 at 10am",
            "You've hit your Sonnet limit",
            "You\u{2019}ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:15 PM.",
            "You\u{2019}ve hit your usage limit. To get more access now, send a request to your admin or try again at Nov 7th, 2026 3:15 PM.",
            "You\u{2019}ve hit your usage limit for GPT-5.5-Codex. Switch to another model now, or try again at 3:15 PM.",
            "You\u{2019}ve hit your usage limit. Try again later.",
        ] {
            let (_, f) = describe(Engine::Claude, raw, &Utc, None, NOW);
            assert_eq!(f.kind, FailureKind::UsageLimit, "{raw}");
        }
        // Throttling and overload are not the plan's limit: no account switch.
        for raw in [
            "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
            "Server is temporarily limiting requests (not your usage limit)",
            "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}",
        ] {
            let (_, f) = describe(Engine::Claude, raw, &Utc, None, NOW);
            assert_ne!(f.kind, FailureKind::UsageLimit, "{raw}");
        }
    }

    #[test]
    fn usage_credits_and_anything_else_pass_through() {
        let credits = "Fable 5 requires usage credits. Run /usage-credits to continue.";
        assert_eq!(
            describe(Engine::Claude, credits, &Utc, None, NOW),
            (credits.to_string(), Failure::OTHER)
        );
    }

    /// docs/design/failure-states.md: the network, the provider's own
    /// trouble and an engine that's gone each get one plain sentence with
    /// its fix, and still read as temporary (or not) as before.
    #[test]
    fn the_network_the_provider_and_a_missing_engine_are_said_plainly() {
        let said = |e: Engine, d: &str| describe(e, d, &Utc, None, NOW);
        for raw in [
            "fetch failed: getaddrinfo ENOTFOUND api.anthropic.com",
            "API Error: Connection error.",
            "API Error (Request timed out.)",
            "Error: connect ECONNREFUSED 127.0.0.1:443",
        ] {
            let (text, f) = said(Engine::Claude, raw);
            assert_eq!(
                text,
                "Claude Code couldn't reach Anthropic over the network. Retry once this Mac is back online.",
                "{raw}"
            );
            assert_eq!(f.kind, FailureKind::Other);
            assert!(is_temporary(&text, &f), "retried: {text}");
        }
        let (text, f) = said(
            Engine::Codex,
            "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
        );
        assert!(text.starts_with("Codex couldn't reach OpenAI"), "{text}");
        assert!(is_temporary(&text, &f));

        let (text, f) = said(
            Engine::Claude,
            "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}",
        );
        assert_eq!(
            text,
            "Anthropic's servers are overloaded right now, so Claude Code stopped. Retry in a few minutes."
        );
        assert!(is_temporary(&text, &f));
        let (text, f) = said(Engine::Codex, "unexpected status 502 Bad Gateway");
        assert!(
            text.starts_with("OpenAI is temporarily unavailable"),
            "{text}"
        );
        assert!(is_temporary(&text, &f));

        // Gone since it was found: the os error never reaches the chat.
        for raw in [
            &missing_engine_line("Claude Code"),
            "Claude Code isn't installed, or the app can't find it. Install it, or move this agent to another engine in Edit agent, then send this again.",
        ] {
            let (text, f) = said(Engine::Claude, raw);
            assert_eq!(f.kind, FailureKind::EngineMissing, "{raw}");
            assert_eq!(text, missing_engine_line("Claude Code"));
            assert!(!is_temporary(&text, &f));
        }

        let (text, _) = said(
            Engine::Claude,
            "API Error: 400 invalid_request_error: prompt is too long: 210000 tokens > 200000 maximum",
        );
        assert!(text.contains("Start fresh"), "{text}");
    }

    #[test]
    fn raw_output_never_reaches_the_chat_but_a_sentence_does() {
        let said = |d: &str| describe(Engine::Claude, d, &Utc, None, NOW).0;
        let unexplained = "Claude Code stopped with an error it didn't explain. Retry; if it happens again, start a fresh conversation.";
        for raw in [
            "exit code Some(1), no output",
            "No such file or directory (os error 2)",
            "thread 'main' panicked at src/main.rs:4:5",
            "TypeError: x is undefined\n    at run (cli.js:1:2)\n    at main (cli.js:3:4)",
            "ERR_INVALID_ARG_TYPE",
            "",
        ] {
            assert_eq!(said(raw), unexplained, "{raw:?}");
        }
        // The app's own sentences are kept as they are.
        let own = "Claude Code stopped before it replied. Retry, and if it happens again, check it's still signed in.";
        assert_eq!(said(own), own);
    }
}
