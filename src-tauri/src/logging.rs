//! # Logging Infrastructure
//!
//! Structured logging using the `tracing` ecosystem.
//! Logs are written to daily rotating files in the app's log directory.

use std::path::PathBuf;
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{
    fmt::{self},
    layer::SubscriberExt,
    util::SubscriberInitExt,
    EnvFilter,
};

// Hold the guard to keep the non-blocking writer alive
static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

// Hold the Sentry guard for the lifetime of the process so events get flushed on exit.
static SENTRY_GUARD: OnceLock<sentry::ClientInitGuard> = OnceLock::new();

/// Crash reporting is off unless brand.json names a Sentry DSN of our own.
const SENTRY_DSN: Option<&str> = crate::brand::telemetry::SENTRY_DSN;

/// Initialize Sentry. Must be called before `init_logging()` so the
/// `sentry_tracing` layer can forward events. Skipped in debug builds unless
/// the `SENTRY_FORCE=1` env var is set.
pub fn init_sentry() {
    let Some(dsn) = SENTRY_DSN else {
        return;
    };
    let force = std::env::var("SENTRY_FORCE").ok().as_deref() == Some("1");
    let enabled = !cfg!(debug_assertions) || force;
    if !enabled {
        return;
    }

    let environment = if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    };

    // `ClientOptions` is non-exhaustive, so it's built from the default and
    // then filled in rather than with a struct literal.
    let mut options = sentry::ClientOptions::default();
    options.release = Some(env!("CARGO_PKG_VERSION").into());
    options.environment = Some(environment.into());
    options.send_default_pii = false;
    options.before_send = Some(std::sync::Arc::new(|mut event| {
        scrub_event(&mut event);
        Some(event)
    }));
    options.before_breadcrumb = Some(std::sync::Arc::new(|mut breadcrumb| {
        if let Some(msg) = breadcrumb.message.as_mut() {
            *msg = scrub_string(msg);
        }
        Some(breadcrumb)
    }));
    let guard = sentry::init((dsn, options));
    let _ = SENTRY_GUARD.set(guard);
}

pub(crate) fn scrub_string(s: &str) -> String {
    // Strip local paths so Sentry doesn't see usernames or project folder names.
    let re_unix = regex_lite_replace(s, "/Users/", "/Users/<redacted>");
    let re_home = regex_lite_replace(&re_unix, "/home/", "/home/<redacted>");
    regex_lite_replace(&re_home, "C:\\Users\\", "C:\\Users\\<redacted>")
}

fn regex_lite_replace(input: &str, prefix: &str, replacement: &str) -> String {
    // Replace `<prefix><username>/<folders…>/<file>` with
    // `<replacement>/…/<file>`: the user name and every folder under it go
    // (project and client names live there), the file name stays because
    // it's what makes a report useful. The path runs to whitespace or a
    // quote. Avoids a full regex crate dependency.
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(prefix) {
        out.push_str(&rest[..idx]);
        out.push_str(replacement);
        let after = &rest[idx + prefix.len()..];
        let end = after
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')' || c == ',')
            .unwrap_or(after.len());
        let path = &after[..end];
        let sep = if prefix.contains('\\') { '\\' } else { '/' };
        let parts: Vec<&str> = path.split(sep).collect();
        // parts[0] is the user name; then folders; the last is the file.
        match parts.len() {
            0 | 1 => {}
            2 => {
                out.push(sep);
                out.push_str(parts[1]);
            }
            n => {
                out.push(sep);
                out.push('…');
                out.push(sep);
                out.push_str(parts[n - 1]);
            }
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod scrub_tests {
    use super::scrub_string;

    #[test]
    fn user_names_and_folders_go_the_file_name_stays() {
        assert_eq!(
            scrub_string("failed at /Users/julian/ShipStudio/acme-client/src/page.tsx: boom"),
            "failed at /Users/<redacted>/…/page.tsx: boom"
        );
        assert_eq!(scrub_string("in /Users/julian"), "in /Users/<redacted>");
        assert_eq!(
            scrub_string("'/Users/julian/notes.md'"),
            "'/Users/<redacted>/notes.md'"
        );
        assert_eq!(
            scrub_string(r"C:\Users\pat\Work\Client\a.txt"),
            r"C:\Users\<redacted>\…\a.txt"
        );
        assert_eq!(
            scrub_string("/home/pat/x/y (os error 2)"),
            "/home/<redacted>/…/y (os error 2)"
        );
        assert_eq!(scrub_string("nothing here"), "nothing here");
    }
}

fn scrub_event(event: &mut sentry::protocol::Event<'static>) {
    if let Some(msg) = event.message.as_mut() {
        *msg = scrub_string(msg);
    }
    for exception in event.exception.values.iter_mut() {
        if let Some(value) = exception.value.as_mut() {
            *value = scrub_string(value);
        }
    }
    for breadcrumb in event.breadcrumbs.values.iter_mut() {
        if let Some(msg) = breadcrumb.message.as_mut() {
            *msg = scrub_string(msg);
        }
    }
}

/// Get the log directory path
pub(crate) fn get_log_dir() -> PathBuf {
    crate::brand::logs_dir()
}

/// Initialize the logging system
///
/// Sets up:
/// - Daily rotating log files
/// - JSON formatted logs for easy parsing
/// - Console output in debug builds
/// - Environment-based log level filtering
pub fn init_logging() -> Result<(), String> {
    let log_dir = get_log_dir();

    // File logging is best-effort: a full disk (or a log directory we can't
    // create or open) must not take the whole app down at startup. Both the
    // directory creation and the appender build used to abort — the appender
    // via `rolling::daily`'s internal panic — leaving the user with a crash
    // instead of a running app (issue #827). Fall back to no file layer; Sentry
    // and admin-agent reporting below still work.
    let file_writer = match std::fs::create_dir_all(&log_dir).and_then(|()| {
        tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(crate::brand::log_file_prefix())
            // Uncapped rotation was an unbounded-disk-growth bug: daily files
            // were never deleted, so the log directory grew forever (measured
            // at ~45MB/day per running instance before the span-close noise
            // cut below). Two weeks is generous for support/debugging and
            // now costs single-digit MB/day per file after that cut.
            .max_log_files(14)
            .build(&log_dir)
            .map_err(std::io::Error::other)
    }) {
        Ok(appender) => {
            let (non_blocking, guard) = tracing_appender::non_blocking(appender);
            // Store the guard to keep the writer alive
            LOG_GUARD
                .set(guard)
                .map_err(|_| "Logging already initialized")?;
            Some(non_blocking)
        }
        Err(e) => {
            eprintln!(
                "{}: file logging disabled ({}): {e}",
                crate::brand::NAME,
                log_dir.display()
            );
            None
        }
    };

    // Create the file layer with JSON formatting. `Option<Layer>` is itself a
    // layer, so the disabled case is a no-op rather than a separate build path.
    //
    // No `with_span_events(FmtSpan::CLOSE)` here (deliberately — it used to be
    // on). Every `#[tracing::instrument]`'d command emits one INFO-level
    // "close" record per call with a busy/idle duration, and on a real
    // release-build log this was measured at 91.5% of all lines and 90.2% of
    // all bytes (112,417 of 122,916 lines; ~41MB of a 45MB daily file) —
    // almost entirely microsecond-scale entries like
    // `get_dashboard_projects`/`list_accounts`/`snapshot_status` that nobody
    // reads. Turning it off removes that volume without touching a single
    // `info!`/`warn!`/`error!` call site: those keep firing at their own
    // level with the same span context (the span's fields still populate the
    // "span" object on every event via `with_current_span` below) because
    // this only stops the *synthetic* close record, not span creation. The
    // actual diagnostic signal — ~10.5k lines/day of real messages — is
    // unaffected.
    let file_layer = file_writer.map(|writer| {
        fmt::layer()
            .json()
            .with_writer(writer)
            .with_current_span(true)
            .with_target(true)
            .with_file(true)
            .with_line_number(true)
    });

    // Create environment filter
    // Default to info level, can be overridden with RUST_LOG env var
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("app_lib=info,warn"));

    // Build the subscriber
    let subscriber = tracing_subscriber::registry().with(filter).with(file_layer);

    // In debug builds, also log to console
    #[cfg(debug_assertions)]
    let subscriber = subscriber.with(fmt::layer().with_target(true).with_level(true).compact());

    // Forward tracing events to Sentry. The layer is a no-op if Sentry wasn't
    // initialized (e.g. debug builds without SENTRY_FORCE=1), so it's safe to
    // attach unconditionally.
    let subscriber = subscriber.with(sentry_tracing::layer());

    // Forward error-level events to the admin agent (docs/error-reporting.md).
    // Also a no-op outside production builds and gated/throttled internally.
    let subscriber = subscriber.with(crate::error_reporting::AdminAgentLayer);

    subscriber.init();

    tracing::info!(
        log_dir = %log_dir.display(),
        version = env!("CARGO_PKG_VERSION"),
        "Logging initialized"
    );

    Ok(())
}

/// Get the current log file path (for debugging/support)
#[tauri::command]
pub fn get_log_path() -> String {
    get_log_dir().to_string_lossy().to_string()
}

/// Log a message from the frontend
#[tauri::command]
pub fn log_frontend_event(level: String, message: String, context: Option<serde_json::Value>) {
    let ctx = context.map(|c| c.to_string()).unwrap_or_default();

    match level.as_str() {
        "error" => tracing::error!(source = "frontend", context = %ctx, "{}", message),
        "warn" => tracing::warn!(source = "frontend", context = %ctx, "{}", message),
        "debug" => tracing::debug!(source = "frontend", context = %ctx, "{}", message),
        _ => tracing::info!(source = "frontend", context = %ctx, "{}", message),
    }
}
