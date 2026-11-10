//! Which way into the user's Chrome a turn uses, and why: one place.
//!
//! Observed (the owner, 2026-11): "I keep having to log in and out with the
//! Claude in Chrome extension once we switch accounts." Claude in Chrome is
//! tied to the claude.ai account signed in to both Claude Code and its
//! extension, so a turn moved to another Claude account can find no browser
//! until the extension is signed in again. Your Chrome (`user_chrome`, the
//! app's own extension on the agent bridge) belongs to no account and no
//! engine. So:
//!
//! 1. **Your Chrome whenever it's connected**, for every engine and every
//!    account: the turn gets `mcp__user_chrome__*`, runs `--no-chrome`, and
//!    Claude in Chrome's tools are kept from it too (`--disallowedTools`), so
//!    a turn never holds two ways into the same Chrome.
//! 2. **Claude in Chrome only as the fallback**: Your Chrome isn't connected,
//!    the team set Claude in Chrome up, the agent runs on Claude Code, and the
//!    app's last check found a browser answering it (`chrome_health`).
//! 3. Otherwise **none**, with the reason, so Settings → Chrome and "What it
//!    can reach" say which path agents use now and why, rather than leaving
//!    it to be guessed.
//!
//! The same `browser_gate` decides every call on either path. [`decide`] is
//! pure; a test holds it to `user_chrome::allowed` and `browser::allowed`
//! over every combination, so the precedence can't drift from the per-turn
//! checks it summarises.

use serde::Serialize;

use super::engine::Engine;
use super::store::Agent;

/// The way a turn reaches the user's Chrome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    /// The app's own extension (`user_chrome`): any engine, any account.
    YourChrome,
    /// Claude Code's `--chrome`, tied to the claude.ai account signed in to
    /// the extension.
    ClaudeInChrome,
    /// No way into the user's Chrome this turn.
    #[default]
    None,
}

/// Why [`Route`] is what it is, for the words the UI shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Why {
    /// Your Chrome is on and a Chrome is connected.
    YourChromeConnected,
    /// Your Chrome is on, but no Chrome is connected right now.
    YourChromeNotConnected,
    /// Your Chrome isn't set up (its switch is off).
    YourChromeOff,
    /// Claude in Chrome was the fallback, and no browser answers it.
    ClaudeInChromeDown,
    /// Neither way is set up.
    NotSetUp,
    /// The agent runs on Codex, which has only Your Chrome.
    CodexNeedsYourChrome,
    /// The user took the browser away from this agent.
    OffForAgent,
    /// Its settings don't let it use a browser.
    NotAllowed,
    /// The turn answers outside text: never the user's browser.
    OutsideText,
}

/// The route and its reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Now {
    pub route: Route,
    pub why: Why,
}

/// Everything the choice depends on, read once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Facts {
    /// Your Chrome's switch.
    pub ours_on: bool,
    /// A Chrome is connected to the app's link right now.
    pub ours_connected: bool,
    /// The team's Claude in Chrome switch.
    pub cic_on: bool,
    /// The app's last check found no browser answering Claude in Chrome.
    pub cic_down: bool,
    /// The agent runs on Claude Code (the only engine with Claude in Chrome).
    pub claude_engine: bool,
    /// The user took the browser away from this agent.
    pub agent_off: bool,
    /// Its settings' browser rule allows a browser.
    pub policy: bool,
    /// The turn answers outside text.
    pub outside: bool,
}

/// The route for `f`. Pure; the order is the precedence above.
pub fn decide(f: Facts) -> Now {
    let now = |route, why| Now { route, why };
    if f.outside {
        return now(Route::None, Why::OutsideText);
    }
    if f.agent_off {
        return now(Route::None, Why::OffForAgent);
    }
    let ours = f.ours_on && f.ours_connected && f.policy;
    if ours {
        return now(Route::YourChrome, Why::YourChromeConnected);
    }
    let fallback = if f.ours_on {
        Why::YourChromeNotConnected
    } else {
        Why::YourChromeOff
    };
    if f.cic_on && f.claude_engine {
        if f.cic_down {
            return now(Route::None, Why::ClaudeInChromeDown);
        }
        return now(Route::ClaudeInChrome, fallback);
    }
    if f.ours_on && f.ours_connected {
        // Connected, but this agent's settings say no browser.
        return now(Route::None, Why::NotAllowed);
    }
    if f.ours_on {
        return now(Route::None, Why::YourChromeNotConnected);
    }
    if !f.claude_engine {
        return now(Route::None, Why::CodexNeedsYourChrome);
    }
    now(Route::None, Why::NotSetUp)
}

/// The facts for a turn of `agent` as things are now.
pub fn facts_for(agent: &Agent, outside: bool) -> Facts {
    let ours_on = crate::user_chrome::settings::enabled();
    Facts {
        ours_on,
        ours_connected: ours_on && crate::user_chrome::connected(),
        cic_on: super::browser::team_enabled(),
        cic_down: super::chrome_health::known_down(),
        claude_engine: agent.engine == Engine::Claude,
        agent_off: agent.reach.browser_off,
        policy: super::policy::effective(agent).browser,
        outside,
    }
}

/// The route a turn of `agent` uses right now.
pub fn for_turn(agent: &Agent, outside: bool) -> Now {
    decide(facts_for(agent, outside))
}

/// The route for the team as a whole (Settings → Chrome): as for an agent
/// on Claude Code with nothing taken away.
pub fn team() -> Now {
    let ours_on = crate::user_chrome::settings::enabled();
    decide(Facts {
        ours_on,
        ours_connected: ours_on && crate::user_chrome::connected(),
        cic_on: super::browser::team_enabled(),
        cic_down: super::chrome_health::known_down(),
        claude_engine: true,
        agent_off: false,
        policy: true,
        outside: false,
    })
}

/// What a turn on Claude Code is kept from when it has Your Chrome: Claude
/// in Chrome's tools, by server, for `--disallowedTools`.
pub const CLAUDE_IN_CHROME_BLOCK: &str = "mcp__claude-in-chrome";

#[cfg(test)]
#[path = "chrome_route_turn_tests.rs"]
mod turn_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent(engine: Engine, account: Option<&str>, off: bool) -> Agent {
        let mut a: Agent = serde_json::from_value(json!({
            "id": "ops", "name": "Ops", "shape": 0, "color": "teal", "createdAt": 0
        }))
        .unwrap();
        a.engine = engine;
        a.account = account.map(str::to_string);
        a.reach.browser_off = off;
        a
    }

    fn all_facts() -> Vec<Facts> {
        let mut out = Vec::new();
        for bits in 0u16..256 {
            let b = |i: u16| bits & (1 << i) != 0;
            out.push(Facts {
                ours_on: b(0),
                ours_connected: b(1),
                cic_on: b(2),
                cic_down: b(3),
                claude_engine: b(4),
                agent_off: b(5),
                policy: b(6),
                outside: b(7),
            });
        }
        out
    }

    /// The owner's problem: switching accounts must never need a browser
    /// sign-in. With Your Chrome connected, every engine on every account
    /// gets it, and never Claude in Chrome, even when Claude in Chrome is set
    /// up and answering.
    #[test]
    fn your_chrome_wins_on_every_engine_and_every_account() {
        for engine in [Engine::Claude, Engine::Codex] {
            for account in [None, Some("this-mac"), Some("work-max"), Some("personal")] {
                let a = agent(engine, account, false);
                let f = Facts {
                    ours_on: true,
                    ours_connected: true,
                    cic_on: true,
                    cic_down: false,
                    claude_engine: a.engine == Engine::Claude,
                    agent_off: a.reach.browser_off,
                    policy: true,
                    outside: false,
                };
                let now = decide(f);
                assert_eq!(now.route, Route::YourChrome, "{engine:?} on {account:?}");
                assert_eq!(now.why, Why::YourChromeConnected);
                // And the per-turn checks agree.
                assert!(crate::user_chrome::allowed(true, true, true, &a, false));
            }
        }
    }

    #[test]
    fn claude_in_chrome_is_only_the_fallback() {
        let base = Facts {
            ours_on: true,
            ours_connected: false,
            cic_on: true,
            cic_down: false,
            claude_engine: true,
            agent_off: false,
            policy: true,
            outside: false,
        };
        assert_eq!(
            decide(base),
            Now {
                route: Route::ClaudeInChrome,
                why: Why::YourChromeNotConnected
            }
        );
        let off = Facts {
            ours_on: false,
            ..base
        };
        assert_eq!(decide(off).why, Why::YourChromeOff);
        let down = Facts {
            cic_down: true,
            ..base
        };
        assert_eq!(
            decide(down),
            Now {
                route: Route::None,
                why: Why::ClaudeInChromeDown
            }
        );
        let codex = Facts {
            claude_engine: false,
            ..base
        };
        assert_eq!(
            decide(codex),
            Now {
                route: Route::None,
                why: Why::YourChromeNotConnected
            }
        );
        let codex_off = Facts {
            ours_on: false,
            ..codex
        };
        assert_eq!(decide(codex_off).why, Why::CodexNeedsYourChrome);
        let nothing = Facts {
            ours_on: false,
            cic_on: false,
            ..base
        };
        assert_eq!(decide(nothing).why, Why::NotSetUp);
    }

    #[test]
    fn outside_text_and_a_browser_taken_away_get_nothing() {
        for f in all_facts() {
            let now = decide(f);
            if f.outside {
                assert_eq!(
                    now,
                    Now {
                        route: Route::None,
                        why: Why::OutsideText
                    }
                );
            } else if f.agent_off {
                assert_eq!(
                    now,
                    Now {
                        route: Route::None,
                        why: Why::OffForAgent
                    }
                );
            }
        }
    }

    /// [`decide`] says exactly what the per-turn checks do: Your Chrome is
    /// `user_chrome::allowed`; Claude in Chrome is `browser::allowed`, not
    /// known down, and only when Your Chrome didn't take its place.
    #[test]
    fn decide_agrees_with_the_per_turn_checks_everywhere() {
        for f in all_facts() {
            let a = agent(
                if f.claude_engine {
                    Engine::Claude
                } else {
                    Engine::Codex
                },
                None,
                f.agent_off,
            );
            let ours =
                crate::user_chrome::allowed(f.ours_on, f.ours_connected, f.policy, &a, f.outside);
            let cic = super::super::browser::allowed(f.cic_on, &a, f.outside) && !f.cic_down;
            let expected = if ours {
                Route::YourChrome
            } else if cic {
                Route::ClaudeInChrome
            } else {
                Route::None
            };
            assert_eq!(decide(f).route, expected, "{f:?}");
        }
    }

    #[test]
    fn the_wire_words_are_stable() {
        assert_eq!(
            serde_json::to_value(Now {
                route: Route::YourChrome,
                why: Why::YourChromeConnected
            })
            .unwrap(),
            json!({ "route": "your_chrome", "why": "your_chrome_connected" })
        );
        assert_eq!(
            serde_json::to_value(Why::CodexNeedsYourChrome).unwrap(),
            "codex_needs_your_chrome"
        );
    }
}
