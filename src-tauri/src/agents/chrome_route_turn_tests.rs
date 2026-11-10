//! The owner's problem, end to end through what a turn is actually given:
//! "I keep having to log in and out with the Claude in Chrome extension once
//! we switch accounts." With Your Chrome connected, a turn the wallet moved
//! to another Claude account, a Codex turn, an OpenCode turn and a turn
//! carried over to the other engine all get the `user_chrome` server, never
//! Claude in Chrome (`--no-chrome` and its tools kept from Claude Code), and
//! never the per-account Claude in Chrome stand-in (`account_reach`).
//!
//! The pieces are the ones the runner uses, in its order: `wallet::choose`
//! picks the account, `crossover::as_on` the engine, `chrome_route::decide`
//! the route (from `facts_for`, which has no account in it),
//! `connections::lay_in_chrome` the servers and words,
//! `account_reach::chrome_as_this_mac` the only account-dependent step, and
//! `Driver::args` the command line.

use super::account_reach;
use super::chrome_route::{decide, facts_for, Facts, Now, Route, Why, CLAUDE_IN_CHROME_BLOCK};
use super::connections::{lay_in_chrome, TurnAccess, TurnServer, USER_CHROME_PROMPT};
use super::driver::{Driver, TurnSpec};
use super::engine::Engine;
use super::store::Agent;
use super::wallet::{self, Account, Candidate, Choice, LimitHit};
use serde_json::json;

const PORT: u16 = 4321;

fn agent(engine: Engine, account: Option<&str>) -> Agent {
    let mut a: Agent = serde_json::from_value(json!({
        "id": "ops", "name": "Ops", "shape": 0, "color": "teal", "createdAt": 0
    }))
    .unwrap();
    a.engine = engine;
    a.account = account.map(str::to_string);
    a
}

fn account(id: &str, engine: Engine, out_until: Option<i64>) -> Account {
    Account {
        id: id.into(),
        engine,
        name: id.into(),
        added_at: 0,
        limit: out_until.map(|resets_at| LimitHit {
            at: 0,
            resets_at: Some(resets_at),
        }),
    }
}

/// Your Chrome on and connected, Claude in Chrome set up and answering too:
/// the case where the wrong choice would be easy.
fn connected(engine: Engine) -> Facts {
    Facts {
        ours_on: true,
        ours_connected: true,
        cic_on: true,
        cic_down: false,
        claude_engine: engine == Engine::Claude,
        agent_off: false,
        policy: true,
        outside: false,
    }
}

/// What a turn of `engine` gets for `now`: its access, as the runner lays
/// it in before any account-specific step. An app it's kept from is there
/// too, so the browser block is added beside it, not instead of it.
fn access_for(now: Now, engine: Engine) -> TurnAccess {
    let mut access = TurnAccess {
        servers: vec![TurnServer {
            key: "linear".into(),
            url: "http://127.0.0.1:4321/mcp/conn/linear".into(),
        }],
        blocked: vec!["mcp__claude_ai_Gmail".into()],
        browser: false,
        prompt: String::new(),
    };
    lay_in_chrome(&mut access, now, engine, PORT);
    access
}

fn args(driver: Driver, access: &TurnAccess) -> Vec<String> {
    let writable: Vec<String> = Vec::new();
    driver.args(&TurnSpec {
        model: None,
        effort: None,
        session: "sid",
        resuming: true,
        url: "http://127.0.0.1:4321/mcp/agent",
        mcp_config: "/s/mcp.json",
        system_prompt: "be useful",
        writable: &writable,
        protected: None,
        access: Some(access),
        window: None,
    })
}

fn drivers(engine: Engine) -> Vec<Driver> {
    match engine {
        Engine::Claude => vec![Driver::ClaudePrint],
        Engine::Codex => vec![Driver::CodexApp, Driver::CodexExec],
        Engine::OpenCode => vec![Driver::OpenCodeAcp],
    }
}

/// Everything that says a turn has Your Chrome and nothing else into the
/// user's Chrome, for `engine` on an account that is this Mac's or not.
fn assert_your_chrome_only(engine: Engine, this_mac: bool, access: &TurnAccess, on: &str) {
    let server = crate::user_chrome::tools::SERVER_KEY;
    assert!(
        access
            .servers
            .iter()
            .any(|s| s.key == server && s.url == crate::user_chrome::tools::url(PORT)),
        "{on}: no Your Chrome server"
    );
    assert!(!access.browser, "{on}: Claude in Chrome too");
    assert!(access.prompt.contains(USER_CHROME_PROMPT), "{on}: not told");
    // The account-dependent stand-in for Claude in Chrome never applies.
    assert!(
        !account_reach::chrome_as_this_mac(engine, access.browser, this_mac),
        "{on}: Claude in Chrome as this Mac's sign-in"
    );
    for driver in drivers(engine) {
        let a = args(driver, access);
        match driver {
            Driver::ClaudePrint => {
                assert!(
                    a.contains(&"--no-chrome".to_string()),
                    "{on}: no --no-chrome"
                );
                assert!(!a.contains(&"--chrome".to_string()), "{on}: --chrome");
                let at = a.iter().position(|x| x == "--disallowedTools").unwrap();
                let blocked = &a[at + 1..];
                assert!(
                    blocked.iter().any(|x| x == CLAUDE_IN_CHROME_BLOCK),
                    "{on}: Claude in Chrome's tools not kept from it"
                );
                assert!(blocked.iter().any(|x| x == "mcp__claude_ai_Gmail"));
                let servers = access.claude_servers("turn-secret");
                assert!(servers.contains_key(server), "{on}: not in --mcp-config");
                assert!(
                    !servers.contains_key(account_reach::CHROME_SERVER),
                    "{on}: the per-account stand-in is in --mcp-config"
                );
            }
            Driver::CodexApp | Driver::CodexExec => {
                assert!(
                    a.iter()
                        .any(|x| x.starts_with(&format!("mcp_servers.{server}="))
                            && x.contains("/mcp/user-chrome")),
                    "{on} {driver:?}: no Your Chrome server"
                );
                assert!(!a.iter().any(|x| x.contains("--chrome")));
            }
            Driver::OpenCodeAcp => {
                // Its servers go in `session/new` from `access.servers`, and
                // its inline permissions let the server decide its own calls.
                let given: Vec<String> = access.servers.iter().map(|s| s.key.clone()).collect();
                let p = super::opencode::permissions(&given);
                assert_eq!(p[format!("{server}_*")], "allow", "{on}");
            }
        }
    }
}

/// The owner's case: the turn starts on this Mac's sign-in, that account
/// runs out, and the wallet moves the turn to an added Claude account. Both
/// tries get Your Chrome, and the second needs no browser sign-in.
#[test]
fn a_turn_the_wallet_moves_to_another_claude_account_keeps_your_chrome() {
    let now = 1_000_000;
    let candidates = vec![
        Candidate {
            account: account(wallet::THIS_MAC, Engine::Claude, None),
            signed_in: true,
        },
        Candidate {
            account: account("work-max", Engine::Claude, None),
            signed_in: true,
        },
    ];
    let Choice::Run(first) = wallet::choose(&candidates, &[], now) else {
        panic!("nothing to run on");
    };
    assert!(first.is_this_mac());
    // It ran out on this Mac's account: the next try is on the added one.
    let Choice::Run(second) = wallet::choose(&candidates, &[first.id.clone()], now) else {
        panic!("no account to move to");
    };
    assert_eq!(second.id, "work-max");
    assert!(!second.is_this_mac());

    for acct in [&first, &second] {
        let route = decide(connected(Engine::Claude));
        assert_eq!(
            route,
            Now {
                route: Route::YourChrome,
                why: Why::YourChromeConnected
            }
        );
        let access = access_for(route, Engine::Claude);
        assert_your_chrome_only(Engine::Claude, acct.is_this_mac(), &access, &acct.id);
    }
}

/// The account a turn runs on isn't an input to the route at all: the same
/// agent set to this Mac, to an added account, or to any account reads the
/// same facts.
#[test]
fn the_route_reads_nothing_about_the_account() {
    for engine in [Engine::Claude, Engine::Codex, Engine::OpenCode] {
        let any = facts_for(&agent(engine, None), false);
        for pinned in [wallet::THIS_MAC, "work-max", "personal"] {
            assert_eq!(facts_for(&agent(engine, Some(pinned)), false), any);
        }
    }
}

/// Codex and OpenCode, on this Mac's sign-in and on added accounts.
#[test]
fn codex_and_opencode_turns_get_your_chrome_on_every_account() {
    for engine in [Engine::Codex, Engine::OpenCode] {
        let route = decide(connected(engine));
        assert_eq!(route.route, Route::YourChrome, "{engine:?}");
        for this_mac in [true, false] {
            let access = access_for(route, engine);
            // Claude in Chrome's block is Claude Code's flag; nothing to keep
            // from an engine that never had it.
            assert!(!access.blocked.iter().any(|b| b == CLAUDE_IN_CHROME_BLOCK));
            assert_your_chrome_only(engine, this_mac, &access, &format!("{engine:?}"));
        }
    }
}

/// Every account out on its own engine, the turn carried to the other
/// (`crossover::as_on`): it reads the facts as the engine it runs on, and
/// Your Chrome follows it there, both ways.
#[test]
fn a_turn_carried_over_to_the_other_engine_keeps_your_chrome() {
    for (home, to) in [
        (Engine::Claude, Engine::Codex),
        (Engine::Codex, Engine::Claude),
    ] {
        let carried = super::crossover::as_on(agent(home, Some("work-max")), to);
        assert_eq!(carried.engine, to);
        assert_eq!(carried.account, None, "an account is per engine");
        let route = decide(Facts {
            claude_engine: carried.engine == Engine::Claude,
            ..connected(to)
        });
        assert_eq!(route.route, Route::YourChrome);
        let access = access_for(route, carried.engine);
        assert_your_chrome_only(carried.engine, false, &access, &format!("{home:?}->{to:?}"));
    }
}

/// The contrast, which is the bug Your Chrome removes: with only Claude in
/// Chrome, the same failover changes what the turn gets. On this Mac's
/// account it's `--chrome`; on an added one it needs the stand-in run as
/// this Mac's sign-in, which still depends on the extension's own sign-in.
#[test]
fn without_your_chrome_the_account_changes_what_the_turn_gets() {
    let route = decide(Facts {
        ours_on: false,
        ours_connected: false,
        ..connected(Engine::Claude)
    });
    assert_eq!(route.route, Route::ClaudeInChrome);
    let access = access_for(route, Engine::Claude);
    assert!(access.browser);
    assert!(!access
        .servers
        .iter()
        .any(|s| s.key == crate::user_chrome::tools::SERVER_KEY));
    assert!(args(Driver::ClaudePrint, &access).contains(&"--chrome".to_string()));
    assert!(!account_reach::chrome_as_this_mac(
        Engine::Claude,
        access.browser,
        true
    ));
    assert!(account_reach::chrome_as_this_mac(
        Engine::Claude,
        access.browser,
        false
    ));
}

/// Claude in Chrome down and Your Chrome not connected: `--no-chrome`, told
/// why, and nothing claims a browser it hasn't got.
#[test]
fn claude_in_chrome_down_runs_without_a_browser_and_says_so() {
    let route = decide(Facts {
        ours_connected: false,
        cic_down: true,
        ..connected(Engine::Claude)
    });
    assert_eq!(route.why, Why::ClaudeInChromeDown);
    let access = access_for(route, Engine::Claude);
    assert!(!access.browser);
    assert!(access
        .prompt
        .contains(super::connections::CHROME_DOWN_PROMPT));
    let a = args(Driver::ClaudePrint, &access);
    assert!(a.contains(&"--no-chrome".to_string()));
    assert!(!access
        .servers
        .iter()
        .any(|s| s.key == crate::user_chrome::tools::SERVER_KEY));
}
