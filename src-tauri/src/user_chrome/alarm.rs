//! One alarm when Your Chrome stays down: while the switch is on and no
//! Chrome has been linked for [`DOWN_FOR`] (Chrome closed, the extension
//! off, or the app's link not running), the app says so once: a line in
//! the Chief of Staff's chat with a button to Settings → Chrome, and one
//! notification. Not once per agent, and not again until the link has
//! come back and gone down again.

use std::time::Duration;

use tauri::AppHandle;

/// How long the link may be down before the user hears of it.
pub const DOWN_FOR: Duration = Duration::from_secs(5 * 60);
/// How often it looks.
pub const LOOK_EVERY: Duration = Duration::from_secs(30);

/// The outage being watched. Pure: the loop feeds it what it sees.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Watch {
    /// When the current outage started (epoch ms).
    down_since: Option<i64>,
    /// The user was told about this outage.
    told: bool,
}

impl Watch {
    /// One look at `now` (epoch ms). `on`: the switch; `down`: no Chrome
    /// linked. `true` exactly once per outage, once it has lasted
    /// [`DOWN_FOR`].
    pub fn look(&mut self, on: bool, down: bool, now: i64) -> bool {
        if !on || !down {
            *self = Watch::default();
            return false;
        }
        let since = *self.down_since.get_or_insert(now);
        if !self.told && now.saturating_sub(since) >= DOWN_FOR.as_millis() as i64 {
            self.told = true;
            return true;
        }
        false
    }
}

/// What the user is told. `listening`: the app's link is running (so it's
/// Chrome that isn't there). Pure.
pub fn line(listening: bool) -> String {
    let why = if listening {
        "no Chrome has been connected for 5 minutes (Chrome is closed, or the extension is off)"
    } else {
        "the app's Chrome link hasn't been running for 5 minutes"
    };
    format!(
        "Your Chrome is down: {why}. Agents, project tabs and Terminal sessions can't use the user's Chrome until it's back. Open Chrome and it reconnects by itself; Settings → Chrome shows what's wrong."
    )
}

/// Watch for as long as the app runs.
pub fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut w = Watch::default();
        loop {
            tokio::time::sleep(LOOK_EVERY).await;
            let on = super::SUPPORTED && super::settings::enabled();
            let listening = super::listening();
            let down = !listening || !super::connected();
            if w.look(on, down, chrono::Utc::now().timestamp_millis()) {
                tell(&app, listening);
            }
        }
    });
}

fn tell(app: &AppHandle, listening: bool) {
    let text = line(listening);
    tracing::warn!(
        "[UserChrome] down for {}s: told the user",
        DOWN_FOR.as_secs()
    );
    let chief = crate::agents::store::list()
        .ok()
        .and_then(|l| l.into_iter().find(|a| a.is_main));
    let Some(chief) = chief else {
        return;
    };
    let mut m = crate::agents::runner::new_message(
        &chief.id,
        crate::agents::store::MessageKind::Note,
        text.clone(),
    );
    m.fix = Some(crate::agents::store::NoteFix::UserChromeCheck);
    if let Err(e) = crate::agents::runner::record(app, m) {
        tracing::warn!("[UserChrome] couldn't say Your Chrome is down: {e}");
    }
    crate::agents::notify::alert_user(app, &chief.id, &text);
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    #[test]
    fn told_once_after_five_minutes_down_and_again_only_after_it_came_back() {
        let mut w = Watch::default();
        assert!(!w.look(true, true, 0), "just went down");
        assert!(!w.look(true, true, 4 * MIN + 59_000));
        assert!(w.look(true, true, 5 * MIN), "five minutes: told");
        assert!(!w.look(true, true, 6 * MIN), "once");
        assert!(!w.look(true, true, 60 * MIN), "still once an hour later");
        // Back, then down again: a new outage, told again after five minutes.
        assert!(!w.look(true, false, 61 * MIN));
        assert!(!w.look(true, true, 62 * MIN));
        assert!(!w.look(true, true, 66 * MIN));
        assert!(w.look(true, true, 67 * MIN));
    }

    #[test]
    fn nothing_while_switched_off() {
        let mut w = Watch::default();
        assert!(!w.look(false, true, 0));
        assert!(!w.look(false, true, 30 * MIN));
        // Switched on while down: the five minutes start then.
        assert!(!w.look(true, true, 31 * MIN));
        assert!(!w.look(true, true, 35 * MIN));
        assert!(w.look(true, true, 36 * MIN));
    }

    #[test]
    fn the_line_says_what_and_where_never_the_claude_extension() {
        assert!(line(true).contains("no Chrome has been connected"));
        assert!(line(false).contains("link hasn't been running"));
        for l in [line(true), line(false)] {
            assert!(l.contains("Settings → Chrome"));
            assert!(!l.to_lowercase().contains("claude"), "{l}");
        }
    }
}
