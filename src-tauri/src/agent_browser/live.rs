//! The live preview in the chat: what an agent's own browser shows right
//! now, as a small picture under its working line, and larger in the pane
//! beside the chat. Read-only: nothing here reaches the page.
//!
//! - **Pulled, never pushed.** The desk asks for the next frame
//!   ([`frame`]); each ask renews a short lease ([`LEASE`]). When the chat
//!   isn't on screen it stops asking, the lease lapses and the screencast
//!   stops, so a hidden window costs Chrome nothing. The reaper also stops
//!   it when the agent's tab goes away.
//! - **Slow and small.** About [`THUMB`]'s two frames a second at 640 px
//!   for the thumbnail; [`LARGE`] for the pane. Chrome is held to the rate by
//!   the ack's delay (`service::Screencast::gap`).
//! - **The agent's own tab only.** Its current one (`tab_for`), never a
//!   sign-in's or another agent's.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::service::{self, Screencast, Service, Tab};

/// The thumbnail under the working line.
pub const THUMB: Screencast = Screencast {
    fps: 2,
    max_width: 640,
    max_height: 400,
    quality: 55,
};

/// The pane beside the chat.
pub const LARGE: Screencast = Screencast {
    fps: 4,
    max_width: 1280,
    max_height: 860,
    quality: 65,
};

/// A watch nobody has asked about for this long is stopped.
pub const LEASE: Duration = Duration::from_secs(4);
/// The longest one ask waits for a new frame.
pub const WAIT: Duration = Duration::from_millis(1500);

/// One frame for the desk.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveFrame {
    /// Ask again with this as `after` for the one after.
    pub seq: u64,
    /// `data:image/jpeg;base64,…`, ready for an `<img>`.
    pub src: String,
    pub width: u32,
    pub height: u32,
    /// The page it's on, as Chrome says.
    pub url: String,
    pub title: String,
}

/// What the desk is watching, per agent.
#[derive(Debug, Clone)]
struct Lease {
    session_id: String,
    cast: Screencast,
    asked: Instant,
}

static LEASES: Mutex<Option<HashMap<String, Lease>>> = Mutex::new(None);
static REAPER: AtomicBool = AtomicBool::new(false);

fn leases() -> std::sync::MutexGuard<'static, Option<HashMap<String, Lease>>> {
    LEASES.lock().unwrap_or_else(|e| e.into_inner())
}

/// What one ask must do about the screencast.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// It's running as asked: just read the slot.
    Keep,
    /// Start it on this tab (nothing ran, or the agent moved to another tab).
    Start,
    /// Same tab, another size or rate: start again with the new one.
    Restart,
}

/// [`frame`]'s decision, pure.
pub fn plan(lease: Option<(&str, Screencast)>, session_id: &str, cast: Screencast) -> Plan {
    match lease {
        None => Plan::Start,
        Some((s, _)) if s != session_id => Plan::Start,
        Some((_, c)) if c != cast => Plan::Restart,
        Some(_) => Plan::Keep,
    }
}

/// The lease has lapsed: nobody has asked for [`LEASE`].
pub fn lapsed(asked: Instant, now: Instant) -> bool {
    now.saturating_duration_since(asked) >= LEASE
}

/// The next frame of `agent`'s current page after `after` (waiting up to
/// [`WAIT`]), at `cast`. `None` when it has no page open or no new frame
/// came. Blocks: call through `spawn_blocking`.
pub fn frame(agent: &str, after: u64, cast: Screencast) -> Option<LiveFrame> {
    let svc = service::running()?;
    frame_on(&svc, agent, after, cast)
}

/// [`frame`] against a given Chrome (tests use a fake one).
pub fn frame_on(
    svc: &Arc<Service>,
    agent: &str,
    after: u64,
    cast: Screencast,
) -> Option<LiveFrame> {
    let tab = svc.tab_for(agent, None).ok()?;
    let previous = {
        let g = leases();
        g.as_ref()
            .and_then(|m| m.get(agent))
            .map(|l| (l.session_id.clone(), l.cast))
    };
    let decided = plan(
        previous.as_ref().map(|(s, c)| (s.as_str(), *c)),
        &tab.session_id,
        cast,
    );
    // Its slot can be gone with the lease still held (Chrome closed the tab).
    let slot = match (decided, svc.slot(&tab.session_id)) {
        (Plan::Keep, Some(slot)) => slot,
        _ => {
            if let Some((old, _)) = previous.filter(|(s, _)| *s != tab.session_id) {
                stop_session(svc, &old);
            }
            svc.watch_with(&tab, cast).ok()?
        }
    };
    leases().get_or_insert_with(HashMap::new).insert(
        agent.to_string(),
        Lease {
            session_id: tab.session_id.clone(),
            cast,
            asked: Instant::now(),
        },
    );
    spawn_reaper();
    // A new watcher gets the newest frame at once, however old.
    let f = if after == 0 {
        slot.last().or_else(|| slot.next(0, WAIT))
    } else {
        slot.next(after, WAIT)
    }?;
    let tab = svc.refreshed(&tab);
    Some(to_live(&tab, &f))
}

fn to_live(tab: &Tab, f: &service::Frame) -> LiveFrame {
    use base64::Engine as _;
    LiveFrame {
        seq: f.seq,
        src: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(f.jpeg.as_slice())
        ),
        width: f.width,
        height: f.height,
        url: tab.url.clone(),
        title: tab.title.clone(),
    }
}

/// Stop watching `agent`'s page now (the chat went away), if it is being
/// watched at `cast`: a thumbnail going away as the pane opens doesn't stop
/// the pane's.
pub fn stop(agent: &str, cast: Screencast) {
    let lease = {
        let mut g = leases();
        let Some(m) = g.as_mut() else { return };
        if m.get(agent).is_none_or(|l| l.cast != cast) {
            return;
        }
        m.remove(agent)
    };
    if let (Some(l), Some(svc)) = (lease, service::running()) {
        stop_session(&svc, &l.session_id);
    }
}

fn stop_session(svc: &Service, session_id: &str) {
    if let Some(tab) = svc.tab_by_session(session_id) {
        svc.unwatch(&tab);
    }
}

/// Every lapsed lease is stopped, once a second, until none is left.
fn spawn_reaper() {
    if REAPER.swap(true, Ordering::Relaxed) {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(1));
        let now = Instant::now();
        let (gone, empty) = {
            let mut g = leases();
            let m = g.get_or_insert_with(HashMap::new);
            let ids: Vec<String> = m
                .iter()
                .filter(|(_, l)| lapsed(l.asked, now))
                .map(|(a, _)| a.clone())
                .collect();
            let gone: Vec<Lease> = ids.iter().filter_map(|a| m.remove(a)).collect();
            let empty = m.is_empty();
            if empty {
                // Checked under the lock: the next ask starts a new reaper.
                REAPER.store(false, Ordering::Relaxed);
            }
            (gone, empty)
        };
        if let Some(svc) = service::running() {
            for l in &gone {
                stop_session(&svc, &l.session_id);
            }
        }
        if empty {
            return;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::super::service::tests::fake_browser;
    use super::super::service::Owner;
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_preview_is_slow_and_small() {
        assert_eq!(THUMB.gap(), Duration::from_millis(500));
        const _: () = assert!(THUMB.max_width <= 640 && THUMB.quality <= 60);
        assert!(LARGE.gap() >= Duration::from_millis(250));
        // Never faster than a sign-in, which someone is driving.
        assert!(THUMB.gap() > Screencast::SIGNIN.gap());
    }

    #[test]
    fn plan_starts_restarts_or_keeps() {
        assert_eq!(plan(None, "S1", THUMB), Plan::Start);
        assert_eq!(plan(Some(("S1", THUMB)), "S1", THUMB), Plan::Keep);
        assert_eq!(plan(Some(("S1", THUMB)), "S1", LARGE), Plan::Restart);
        // The agent moved to another tab.
        assert_eq!(plan(Some(("S1", THUMB)), "S2", THUMB), Plan::Start);
    }

    #[test]
    fn a_lease_lapses_when_nobody_asks() {
        let t = Instant::now();
        assert!(!lapsed(t, t + Duration::from_secs(1)));
        assert!(lapsed(t, t + LEASE));
        // A clock that went backwards isn't a lapse.
        assert!(!lapsed(t + Duration::from_secs(9), t));
    }

    #[test]
    fn the_queue_acks_the_soonest_first() {
        use super::super::service::AckQueue;
        let now = Instant::now();
        let mut q = AckQueue::default();
        assert_eq!(q.wait(now), None);
        q.push("slow".into(), 1, now + THUMB.gap());
        q.push("quick".into(), 2, now + Screencast::SIGNIN.gap());
        assert_eq!(q.wait(now), Some(Screencast::SIGNIN.gap()));
        assert!(q.take_due(now).is_empty());
        assert_eq!(
            q.take_due(now + Screencast::SIGNIN.gap()),
            vec![("quick".to_string(), 2)]
        );
        assert_eq!(q.take_due(now + THUMB.gap()), vec![("slow".to_string(), 1)]);
        assert!(q.is_empty());
    }

    #[test]
    fn an_agents_page_comes_as_a_data_url_and_only_its_own() {
        let (b, fake) = fake_browser();
        let svc = Service::start(b, PathBuf::from("/tmp/none")).unwrap();
        let agent = "live_preview_agent";
        assert!(
            frame_on(&svc, agent, 0, THUMB).is_none(),
            "no tab, no frame"
        );
        let tab = svc
            .open(Owner::Agent(agent.into()), "https://example.com/")
            .unwrap();
        let f = frame_on(&svc, agent, 0, THUMB).expect("a frame");
        assert!(f.src.starts_with("data:image/jpeg;base64,"));
        assert_eq!((f.width, f.height), (390, 270));
        assert_eq!(f.url, "https://example.com/");
        assert_eq!(f.title, "Example Domain");
        // The thumbnail's rate is on the slot that acks are held to.
        assert_eq!(svc.slot(&tab.session_id).unwrap().gap(), THUMB.gap());
        let calls = fake.calls.lock().unwrap().clone();
        assert_eq!(
            calls
                .iter()
                .filter(|c| *c == "Page.startScreencast")
                .count(),
            1
        );
        // Asking again keeps the one screencast; the next frame is newer.
        if let Some(g) = frame_on(&svc, agent, f.seq, THUMB) {
            assert!(g.seq > f.seq);
        }
        assert_eq!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| *c == "Page.startScreencast")
                .count(),
            1
        );
        // Another agent sees nothing of it.
        assert!(frame_on(&svc, "someone_else", 0, THUMB).is_none());
        // Stopping drops the slot and the screencast.
        let lease = leases().as_mut().and_then(|m| m.remove(agent)).unwrap();
        stop_session(&svc, &lease.session_id);
        assert!(svc.slot(&tab.session_id).is_none());
        assert!(fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c == "Page.stopScreencast"));
    }
}
