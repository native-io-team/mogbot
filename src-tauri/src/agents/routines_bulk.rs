//! "Pause all routines" / "Resume all": every agent's routines at once, for
//! a client freeze or a quiet week, from ⌘K or the Routines overview.
//!
//! Resume is the exact undo of pause and nothing more: it switches back on
//! only the routines a "Pause all" switched off ([`PAUSED_BY_BULK`]), never
//! one the user paused by hand, an admin paused, or an import paused for the
//! user's review (the bug `admin::pause` had, S4 in the developer review).
//! Changing a routine by hand clears the mark (`schedule::set_paused`).

use crate::agents::store::OrLog;
use serde_json::Value;

use super::schedule::{self, CheckIn};
use super::store;

/// The mark a "Pause all" leaves on each routine it switched off.
pub const PAUSED_BY_BULK: &str = "pausedByBulk";

/// The routines a pause (`on`) or resume switches: pause, every one running;
/// resume, only those a "Pause all" paused. Pure.
pub fn switches(check_ins: &[CheckIn], on: bool) -> Vec<String> {
    check_ins
        .iter()
        .filter(|c| {
            if on {
                !c.paused
            } else {
                c.paused && c.extra.contains_key(PAUSED_BY_BULK)
            }
        })
        .map(|c| c.id.clone())
        .collect()
}

fn switch_all(on: bool) -> usize {
    let mut total = 0;
    for agent in store::list().unwrap_or_default() {
        let mut switched = Vec::new();
        for id in switches(&agent.check_ins, on) {
            if schedule::set_paused(&agent.id, &id, on).is_ok() {
                switched.push(id);
            }
        }
        if switched.is_empty() {
            continue;
        }
        total += switched.len();
        if on {
            store::update(&agent.id, |a| {
                for c in a.check_ins.iter_mut().filter(|c| switched.contains(&c.id)) {
                    c.extra.insert(PAUSED_BY_BULK.into(), Value::Bool(true));
                }
            })
            .or_log("which routines Pause all paused");
        }
    }
    total
}

/// Pause every running routine on every agent. How many it paused.
pub fn pause_all() -> usize {
    switch_all(true)
}

/// Resume what "Pause all" paused. How many it resumed.
pub fn resume_all() -> usize {
    switch_all(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routine(id: &str, paused: bool, bulk: bool, import: bool) -> CheckIn {
        let mut extra = serde_json::Map::new();
        if bulk {
            extra.insert(PAUSED_BY_BULK.into(), Value::Bool(true));
        }
        CheckIn {
            id: id.into(),
            note: "x".into(),
            repeat: None,
            next_at: 0,
            created_at: 0,
            paused,
            paused_on_import: import,
            runs: Vec::new(),
            retry: None,
            watch: None,
            usage: Default::default(),
            follow_up: false,
            then: Vec::new(),
            waiting: None,
            model: None,
            extra,
        }
    }

    #[test]
    fn pause_all_switches_off_only_what_runs() {
        let all = [
            routine("on", false, false, false),
            routine("mine", true, false, false),
        ];
        assert_eq!(switches(&all, true), ["on"]);
    }

    #[test]
    fn resume_all_wakes_only_what_pause_all_paused() {
        let all = [
            routine("bulk", true, true, false),
            routine("by-hand", true, false, false),
            routine("import", true, false, true),
            routine("running", false, false, false),
        ];
        assert_eq!(switches(&all, false), ["bulk"]);
    }
}
