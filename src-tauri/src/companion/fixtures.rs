//! Rust ↔ TypeScript: what the Mac actually serializes, checked by `tsc`.
//!
//! This test serializes a representative value of every wire type (every
//! optional field set, every enum variant) and writes it to
//! `packages/companion-protocol/src/fixtures.gen.ts` as
//! `export const x = {…} satisfies T`, so `tsc -p packages/companion-protocol`
//! checks real serde output against the protocol, excess properties included.
//! Method results go through the real router.
//!
//! The test fails when the file on disk differs from what it would write.
//! `UPDATE_FIXTURES=1 cargo test --lib companion::fixtures` rewrites it.

use serde::Serialize;
use serde_json::{json, Value};

use super::router::{self, Caller};
use super::testkit::{self, Stub, AGENT};
use super::wire::{
    BuildKind, Cursor, DevicePlatform, Event, IdentityResponse, PairRefusal, PairResponse,
    PairingLink, ProtocolCode, RefusedReason, ResumeMode, RouteKind, ServerFrame, ServerInfo,
    WireError,
};
use super::DeviceRecord;
use crate::errors::CommandError;

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../packages/companion-protocol/src/fixtures.gen.ts"
);

fn device(full: bool) -> DeviceRecord {
    DeviceRecord {
        id: "dev_0123456789abcdef".into(),
        name: "Sam’s iPhone".into(),
        platform: if full {
            DevicePlatform::Ios
        } else {
            DevicePlatform::Android
        },
        model: full.then(|| "iPhone 16 Pro".into()),
        app_version: "1.0.0".into(),
        build: if full {
            BuildKind::SelfBuilt
        } else {
            BuildKind::Official
        },
        paired_at: 1_762_200_000_000,
        last_seen_at: full.then_some(1_762_290_000_000),
        last_route: full.then_some(RouteKind::Tailscale),
        expires_at: full.then_some(1_762_800_000_000),
        token_hash: "never sent".into(),
        public_key: "never sent".into(),
        push: None,
        tailnet_login: None,
    }
}

fn cursor(seq: u64) -> Cursor {
    Cursor {
        epoch: "epoch-test".into(),
        seq,
    }
}

fn status_value(state: &'static str) -> Value {
    serde_json::to_value(crate::agents::runner::Status {
        state,
        activity: (state != "idle").then(|| "Running npm test".to_string()),
        since: (state != "idle").then_some(1_762_290_000_000),
        // The turn's steps so far, for a phone that says it shows them.
        work: (state != "idle").then(testkit::live_work),
        room: None,
    })
    .unwrap()
}

fn frames() -> Vec<ServerFrame> {
    let errors: Vec<WireError> = vec![
        CommandError::Timeout {
            cmd: "claude".into(),
            secs: 30,
        }
        .into(),
        CommandError::Process {
            cmd: "git".into(),
            exit_code: 1,
            stderr: "fatal".into(),
        }
        .into(),
        CommandError::Validation {
            field: "text".into(),
            reason: "Type a message first.".into(),
        }
        .into(),
        CommandError::NotAuthenticated {
            service: "GitHub".into(),
        }
        .into(),
        CommandError::Io {
            message: "disk full".into(),
        }
        .into(),
        CommandError::MergeConflict {
            pr_number: 12,
            stderr: "conflict".into(),
        }
        .into(),
        CommandError::Other {
            message: "Something broke.".into(),
        }
        .into(),
        CommandError::expected("That request was already answered.").into(),
    ];
    let protocol = [
        ProtocolCode::UnknownMethod,
        ProtocolCode::BadParams,
        ProtocolCode::RateLimited,
        ProtocolCode::TooLarge,
        ProtocolCode::Refused,
        ProtocolCode::NotConnected,
    ]
    .into_iter()
    .map(|code| WireError::protocol(code, "What happened, for the user."));
    let events = vec![
        (
            Some(1),
            Event::Message {
                message: serde_json::to_value(&testkit::messages()[4]).unwrap(),
            },
        ),
        (
            Some(1),
            // A login card with every way in, a sign-in under way and a key.
            Event::Message {
                message: serde_json::to_value(testkit::login_card()).unwrap(),
            },
        ),
        (
            Some(1),
            // "Change Hiring's settings?" (`propose_settings_change`).
            Event::Message {
                message: serde_json::to_value(testkit::settings_card()).unwrap(),
            },
        ),
        (
            Some(1),
            // "Do these under your name?" (`ask_plan`).
            Event::Message {
                message: serde_json::to_value(testkit::plan_card()).unwrap(),
            },
        ),
        (
            Some(2),
            Event::Status {
                agent_id: AGENT.into(),
                status: status_value("working"),
            },
        ),
        (
            Some(3),
            Event::Status {
                agent_id: AGENT.into(),
                status: status_value("idle"),
            },
        ),
        (
            Some(3),
            // Queued behind the cap on concurrent turns: working, no `since`.
            Event::Status {
                agent_id: AGENT.into(),
                status: serde_json::to_value(crate::agents::runner::Status {
                    state: "working",
                    activity: Some("Waiting for a free slot (4 agents already working)".into()),
                    since: None,
                    work: None,
                    room: None,
                })
                .unwrap(),
            },
        ),
        (
            Some(4),
            Event::Registry {
                overview: testkit::overview(),
            },
        ),
        (
            Some(4),
            Event::Rooms {
                rooms: serde_json::to_value(vec![testkit::room()]).unwrap(),
            },
        ),
        (
            Some(5),
            Event::System {
                status: testkit::mac_status(),
            },
        ),
        (
            Some(6),
            Event::ProjectChanged {
                project: serde_json::to_value(&testkit::projects()[0]).unwrap(),
            },
        ),
        (
            Some(7),
            Event::ProjectRemoved {
                path: "/Users/julian/ShipStudio/old-site".into(),
            },
        ),
        (
            None,
            Event::Draft {
                agent_id: AGENT.into(),
                id: "r1".into(),
                from: 5,
                text: " world".into(),
            },
        ),
        (
            None,
            Event::Snapshot {
                cursor: cursor(5),
                overview: testkit::overview(),
                status: testkit::mac_status(),
                projects: testkit::projects()
                    .iter()
                    .map(|p| serde_json::to_value(p).unwrap())
                    .collect(),
            },
        ),
        (None, Event::CaughtUp { cursor: cursor(5) }),
    ];

    let mut out = vec![ServerFrame::Identity {
        protocol: 2,
        server_id: "srv_0123456789abcdef".into(),
        hosts: vec![testkit::HOST.into()],
        identity: proof(),
    }];
    out.push(ServerFrame::Welcome {
        protocol: 2,
        server: ServerInfo {
            id: "srv_0123456789abcdef".into(),
            name: "Julian’s MacBook Pro".into(),
            app_version: "1.7.0".into(),
        },
        device_id: "dev_0123456789abcdef".into(),
        resume: ResumeMode::Replay,
        methods: router::METHODS.to_vec(),
        time_zone: Some("America/New_York".into()),
        features: super::wire::MAC_FEATURES.to_vec(),
    });
    for (reason, message) in [
        (
            RefusedReason::Unauthorized,
            "This phone isn't paired with this Mac.",
        ),
        (RefusedReason::Revoked, "This Mac removed this phone."),
        (
            RefusedReason::UpdateApp,
            "Update this app to connect to this Mac.",
        ),
        (
            RefusedReason::UpdateMac,
            "Update the app on Julian’s MacBook Pro.",
        ),
        (
            RefusedReason::TooManyConnections,
            "Too many connections from this phone.",
        ),
        (
            RefusedReason::Unavailable,
            "Your Mac can't read its identity key from the Keychain right now.",
        ),
    ] {
        out.push(ServerFrame::Refused {
            reason,
            message: message.into(),
        });
    }
    out.push(ServerFrame::response(1, Ok(Value::Null)));
    out.extend(
        errors
            .into_iter()
            .chain(protocol)
            .enumerate()
            .map(|(i, e)| ServerFrame::response(i as u64 + 2, Err(e))),
    );
    out.extend(
        events
            .into_iter()
            .map(|(seq, event)| ServerFrame::Evt { seq, event }),
    );
    out.push(ServerFrame::Pong);
    out
}

fn pair_responses() -> Vec<PairResponse> {
    let mut out = vec![PairResponse::Allowed {
        ok: true,
        device_id: "dev_0123456789abcdef".into(),
        token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        server_id: "srv_0123456789abcdef".into(),
        server_public_key: String::new(),
        hosts: vec![testkit::HOST.into()],
        identity: proof(),
    }];
    for reason in [
        PairRefusal::Expired,
        PairRefusal::Used,
        PairRefusal::Denied,
        PairRefusal::Timeout,
        PairRefusal::UpdateApp,
        PairRefusal::UpdateMac,
    ] {
        out.push(PairResponse::refused(
            reason,
            "What happened, for the user.",
        ));
    }
    out
}

fn proof() -> super::identity::IdentityProof {
    super::identity::IdentityProof {
        public_key: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo".into(),
        signature:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345"
                .into(),
    }
}

fn identity_responses() -> Vec<IdentityResponse> {
    let mut out = vec![IdentityResponse::Proven {
        ok: true,
        protocol: 2,
        server_id: "srv_0123456789abcdef".into(),
        hosts: vec![testkit::HOST.into()],
        identity: proof(),
    }];
    for reason in [
        RefusedReason::UpdateApp,
        RefusedReason::UpdateMac,
        RefusedReason::Unavailable,
    ] {
        out.push(IdentityResponse::Refused {
            ok: false,
            reason,
            message: "What happened, for the user.".into(),
        });
    }
    out
}

fn pairing_link() -> PairingLink {
    PairingLink {
        v: 1,
        code: "K7Q2MZX4A9PL3WRT8NBV6YHC5D".into(),
        server_id: "srv_0123456789abcdef".into(),
        name: "Julian’s MacBook Pro".into(),
        // One route, as the Mac makes them.
        routes: testkit::routes().into_iter().take(1).collect(),
        fingerprint: "Zmh6rfhivXdsj8GLjp-OIA".into(),
    }
}

fn entry(name: &str, ts_type: &str, value: impl Serialize) -> String {
    let json = serde_json::to_string_pretty(&value).unwrap();
    format!("export const {name} = {json} satisfies {ts_type};\n")
}

/// A blob id is random; the fixture keeps its shape, not its value.
fn normalize_blob(mut v: Value) -> Value {
    v["blobId"] = json!("blob_0123456789abcdef0123456789abcdef");
    v
}

async fn generate() -> String {
    let (c, stub) = Stub::companion();
    let caller = Caller {
        device_id: "dev_0123456789abcdef".into(),
        device_name: "Sam’s iPhone".into(),
        label: "companion:dev_0123456789abcdef:1".into(),
        route: super::wire::RouteKind::Tailscale,
        shows: super::wire::Shows {
            live_work: true,
            rooms: true,
        },
    };
    let call = |method: &'static str, params: Value| {
        let (c, caller) = (c.clone(), caller.clone());
        async move {
            router::dispatch(&c, &caller, method, params)
                .await
                .unwrap_or_else(|e| panic!("{method}: {}", e.summary()))
        }
    };
    let mut out = String::from(
        "// Generated by `cargo test --lib companion::fixtures` from what the Mac\n\
         // actually serializes. Do not edit: rewrite it with UPDATE_FIXTURES=1.\n\
         // `tsc -p packages/companion-protocol` checks every value against the protocol.\n\
         \n\
         import type {\n  Device,\n  IdentityResponse,\n  PairingLink,\n  PairResponse,\n  Result,\n  ServerFrame,\n} from './index';\n\n",
    );
    out += &entry(
        "systemStatus",
        "Result<'system.status'>",
        call("system.status", json!({})).await,
    );
    out += &entry(
        "devicesSelf",
        "Result<'devices.self'>",
        device(true).view(true),
    );
    out += &entry("deviceMinimal", "Device", device(false).view(false));
    // This build has no relay (fixtures never reach the network).
    c.push.set_relay(None);
    c.registry.write(|s| s.devices.push(device(false))).unwrap();
    out += &entry(
        "devicesSetPush",
        "Result<'devices.setPush'>",
        call(
            "devices.setPush",
            json!({ "token": "a1".repeat(32), "environment": "production" }),
        )
        .await,
    );
    {
        use super::push::PushStatus::*;
        out += &entry(
            "pushStatuses",
            "Result<'devices.setPush'>['status'][]",
            [On, Pending, Off, Unavailable, SelfBuild],
        );
    }
    out += &entry(
        "agentsOverview",
        "Result<'agents.overview'>",
        call("agents.overview", json!({})).await,
    );
    out += &entry(
        "agentsUsage",
        "Result<'agents.usage'>",
        call("agents.usage", json!({ "agentId": AGENT })).await,
    );
    out += &entry(
        "agentsQuota",
        "Result<'agents.quota'>",
        call("agents.quota", json!({})).await,
    );
    out += &entry(
        "agentsSetDefaults",
        "Result<'agents.setDefaults'>",
        call(
            "agents.setDefaults",
            json!({ "engine": "claude", "claudeModel": "opus", "codexModel": "" }),
        )
        .await,
    );
    out += &entry(
        "agentsSetIndependence",
        "Result<'agents.setIndependence'>",
        call("agents.setIndependence", json!({ "level": "go_hard" })).await,
    );
    out += &entry(
        "agentsSetImportChoice",
        "Result<'agents.setImportChoice'>",
        call("agents.setImportChoice", json!({ "choice": "declined" })).await,
    );
    out += &entry(
        "agentsSetAdmin",
        "Result<'agents.setAdmin'>",
        call(
            "agents.setAdmin",
            json!({ "agentId": AGENT, "admin": true }),
        )
        .await,
    );
    out += &entry(
        "agentsSetAgentIndependence",
        "Result<'agents.setAgentIndependence'>",
        call(
            "agents.setAgentIndependence",
            json!({ "agentId": AGENT, "level": "full_send" }),
        )
        .await,
    );
    out += &entry(
        "agentsImportStatus",
        "Result<'agents.import.status'>",
        call("agents.import.status", json!({})).await,
    );
    out += &entry(
        "agentsImportStarted",
        "Result<'agents.import.start'>",
        call("agents.import.start", json!({})).await,
    );
    out += &entry(
        "agentsImportReview",
        "Result<'agents.import.review'>",
        call(
            "agents.import.review",
            json!({ "agentId": "chief", "requestId": "r1", "keys": ["p1"] }),
        )
        .await,
    );
    out += &entry(
        "agentsTeamSetup",
        "Result<'agents.teamSetup'>",
        call("agents.teamSetup", json!({})).await,
    );
    out += &entry(
        "agentsAccounts",
        "Result<'agents.accounts'>",
        call("agents.accounts", json!({})).await,
    );
    out += &entry(
        "agentsUsagePlan",
        "Result<'agents.usagePlan'>",
        call("agents.usagePlan", json!({})).await,
    );
    out += &entry(
        "agentsMessages",
        "Result<'agents.messages'>",
        call("agents.messages", json!({ "agentId": AGENT, "limit": 100 })).await,
    );
    out += &entry(
        "agentsSend",
        "Result<'agents.send'>",
        &testkit::messages()[0],
    );
    out += &entry(
        "roomsList",
        "Result<'rooms.list'>",
        call("rooms.list", json!({})).await,
    );
    out += &entry(
        "roomsMessages",
        "Result<'rooms.messages'>",
        call("rooms.messages", json!({ "roomId": testkit::ROOM })).await,
    );
    out += &entry(
        "roomsSend",
        "Result<'rooms.send'>",
        call(
            "rooms.send",
            json!({ "roomId": testkit::ROOM, "text": "Status?", "clientId": "rc_fixture", "everyone": true }),
        )
        .await,
    );
    out += &entry(
        "roomsFocus",
        "Result<'rooms.focus'>",
        call("rooms.focus", json!({ "roomId": testkit::ROOM })).await,
    );
    out += &entry(
        "agentsStop",
        "Result<'agents.stop'>",
        call("agents.stop", json!({ "agentId": AGENT })).await,
    );
    out += &entry(
        "agentsAnswerApproval",
        "Result<'agents.answerApproval'>",
        call(
            "agents.answerApproval",
            json!({ "agentId": AGENT, "requestId": "q1", "allow": true, "always": true }),
        )
        .await,
    );
    assert_eq!(
        call(
            "agents.answerApproval",
            json!({ "agentId": AGENT, "requestId": "q6", "allow": true, "choice": 1 }),
        )
        .await,
        Value::Null
    );
    out += &entry(
        "agentsSaveSecret",
        "Result<'agents.saveSecret'>",
        call(
            "agents.saveSecret",
            json!({ "agentId": AGENT, "requestId": "q8", "values": ["julian", "hunter2"] }),
        )
        .await,
    );
    out += &entry(
        "agentsReach",
        "Result<'agents.reach'>",
        call("agents.reach", json!({ "agentId": AGENT })).await,
    );
    out += &entry(
        "agentsPolicy",
        "Result<'agents.policy'>",
        call("agents.policy", json!({ "agentId": AGENT })).await,
    );
    out += &entry(
        "agentsLoginsTeam",
        "Result<'agents.loginsTeam'>",
        call(
            "agents.loginsTeam",
            json!({ "since": 1_762_200_000_000_i64 }),
        )
        .await,
    );
    out += &entry(
        "agentsLoginStart",
        "Result<'agents.loginStart'>",
        call(
            "agents.loginStart",
            json!({ "agentId": AGENT, "requestId": "q12", "optionId": "oauth" }),
        )
        .await,
    );
    out += &entry(
        "agentsLoginPhoneBegin",
        "Result<'agents.loginPhoneBegin'>",
        call(
            "agents.loginPhoneBegin",
            json!({ "agentId": AGENT, "requestId": "q12", "optionId": "oauth" }),
        )
        .await,
    );
    out += &entry(
        "agentsApps",
        "Result<'agents.apps'>",
        call("agents.apps", json!({})).await,
    );
    out += &entry(
        "agentsAppsConnect",
        "Result<'agents.appsConnect'>",
        call(
            "agents.appsConnect",
            json!({ "service": "linear", "grants": [{ "agentId": AGENT, "access": "read" }] }),
        )
        .await,
    );
    out += &entry(
        "agentsAppsPhoneBegin",
        "Result<'agents.appsPhoneBegin'>",
        call(
            "agents.appsPhoneBegin",
            json!({ "service": "linear", "grants": [{ "agentId": AGENT, "access": "full" }], "again": "c2" }),
        )
        .await,
    );
    out += &entry(
        "agentsAppsCancel",
        "Result<'agents.appsCancel'>",
        call("agents.appsCancel", json!({ "service": "linear" })).await,
    );
    out += &entry(
        "agentsAppsSetGrants",
        "Result<'agents.appsSetGrants'>",
        call(
            "agents.appsSetGrants",
            json!({ "connectionId": "c2", "grants": [{ "agentId": AGENT, "access": "read" }] }),
        )
        .await,
    );
    out += &entry(
        "agentsAppsRemove",
        "Result<'agents.appsRemove'>",
        call("agents.appsRemove", json!({ "connectionId": "c2" })).await,
    );
    out += &entry(
        "agentsSigninBegin",
        "Result<'agents.signinBegin'>",
        call(
            "agents.signinBegin",
            json!({ "agentId": AGENT, "requestId": "q12" }),
        )
        .await,
    );
    out += &entry(
        "agentsSigninFrame",
        "Result<'agents.signinFrame'>",
        call("agents.signinFrame", json!({ "sessionId": "signin_0123" })).await,
    );
    out += &entry(
        "agentsSigninFrameOutside",
        "Result<'agents.signinFrame'>",
        call("agents.signinFrame", json!({ "sessionId": "outside" })).await,
    );
    out += &entry(
        "agentsSigninFrameBlocked",
        "Result<'agents.signinFrame'>",
        call(
            "agents.signinFrame",
            json!({ "sessionId": "blocked", "after": 2 }),
        )
        .await,
    );
    out += &entry(
        "agentsSigninFallback",
        "Result<'agents.signinFallback'>",
        call(
            "agents.signinFallback",
            json!({ "sessionId": "signin_0123" }),
        )
        .await,
    );
    out += &entry(
        "agentsSigninDone",
        "Result<'agents.signinDone'>",
        call("agents.signinDone", json!({ "sessionId": "signin_0123" })).await,
    );
    out += &entry(
        "agentsLoginSaveKey",
        "Result<'agents.loginSaveKey'>",
        call(
            "agents.loginSaveKey",
            json!({ "agentId": AGENT, "requestId": "q12", "value": "never-in-a-fixture" }),
        )
        .await,
    );
    out += &entry(
        "agentsMemory",
        "Result<'agents.memory'>",
        call("agents.memory", json!({ "agentId": AGENT })).await,
    );
    out += &entry(
        "agentsMemoryChange",
        "Result<'agents.memoryChange'>",
        call(
            "agents.memoryChange",
            json!({ "agentId": AGENT, "change": { "op": "delete", "index": 1, "original": "VAT is filed quarterly" } }),
        )
        .await,
    );
    out += &entry(
        "agentsMemorySuggest",
        "Result<'agents.memorySuggest'>",
        call(
            "agents.memorySuggest",
            json!({ "text": "Invoices over $5k need my OK first." }),
        )
        .await,
    );
    out += &entry(
        "agentsFiles",
        "Result<'agents.files'>",
        call("agents.files", json!({ "agentId": AGENT })).await,
    );
    std::fs::write(stub.home.path().join("report.md"), "# Q3").unwrap();
    out += &entry(
        "agentsFetchPath",
        "Result<'agents.fetchPath'>",
        normalize_blob(
            call(
                "agents.fetchPath",
                json!({ "agentId": AGENT, "path": "report.md" }),
            )
            .await,
        ),
    );
    out += &entry(
        "agentsSearch",
        "Result<'agents.search'>",
        call("agents.search", json!({ "query": "file" })).await,
    );
    for (name, when) in [
        ("schedulePreviewOnce", "in 2 hours"),
        ("schedulePreviewDays", "every weekday at 9am"),
        ("schedulePreviewEvery", "every 30 minutes"),
    ] {
        out += &entry(
            name,
            "Result<'agents.schedule.preview'>",
            call("agents.schedule.preview", json!({ "when": when })).await,
        );
    }
    out += &entry(
        "scheduleCreate",
        "Result<'agents.schedule.create'>",
        call(
            "agents.schedule.create",
            json!({ "agentId": AGENT, "when": "every weekday at 9am", "note": "Check the invoices" }),
        )
        .await,
    );
    out += &entry(
        "scheduleUpdate",
        "Result<'agents.schedule.update'>",
        call(
            "agents.schedule.update",
            json!({ "agentId": AGENT, "id": "c1", "when": "every 30 minutes", "note": "Look again" }),
        )
        .await,
    );
    for method in [
        "agents.schedule.pause",
        "agents.schedule.cancel",
        "agents.schedule.runNow",
    ] {
        let value = call(
            method,
            json!({ "agentId": AGENT, "id": "c1", "paused": true }),
        )
        .await;
        assert_eq!(value, Value::Null, "{method}");
    }
    out += &entry(
        "projectsList",
        "Result<'projects.list'>",
        call("projects.list", json!({})).await,
    );
    out += &entry(
        "sessionsRead",
        "Result<'sessions.read'>",
        call("sessions.read", json!({ "sessionId": "pty-1" })).await,
    );
    out += &entry(
        "agentsUpdate",
        "Result<'agents.update'>",
        call(
            "agents.update",
            json!({ "agentId": AGENT, "input": { "muted": true } }),
        )
        .await,
    );
    out += &entry(
        "agentsStartFresh",
        "Result<'agents.startFresh'>",
        call("agents.startFresh", json!({ "agentId": AGENT })).await,
    );
    out += &entry(
        "agentsCreate",
        "Result<'agents.create'>",
        call(
            "agents.create",
            json!({ "input": { "name": "Inbox", "role": "Keeps my inbox down to what matters", "color": "teal" }, "clientId": "n_1" }),
        )
        .await,
    );
    out += &entry(
        "agentsTemplates",
        "Result<'agents.templates'>",
        call("agents.templates", json!({})).await,
    );
    out += &entry(
        "sessionsSend",
        "Result<'sessions.send'>",
        call(
            "sessions.send",
            json!({ "project": "/Users/julian/ShipStudio/site", "sessionId": "pty-1", "text": "Fix the header", "clientId": "s_1" }),
        )
        .await,
    );
    assert_eq!(
        call("sessions.key", json!({ "sessionId": "pty-2", "key": "1" })).await,
        Value::Null
    );
    out += &entry("frames", "ServerFrame[]", frames());
    out += &entry("pairResponses", "PairResponse[]", pair_responses());
    out += &entry("pairingLink", "PairingLink", pairing_link());
    out += &entry(
        "identityResponses",
        "IdentityResponse[]",
        identity_responses(),
    );
    out
}

#[tokio::test]
async fn fixtures_match_what_the_mac_serializes() {
    let generated = generate().await;
    if std::env::var("UPDATE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::write(PATH, &generated).unwrap();
        return;
    }
    let on_disk = std::fs::read_to_string(PATH).unwrap_or_default();
    assert!(
        on_disk == generated,
        "packages/companion-protocol/src/fixtures.gen.ts is out of date with what the Mac \
         serializes. Rerun with UPDATE_FIXTURES=1, then `pnpm typecheck` to check it against \
         the protocol."
    );
}
