//! The companion's wire types: the Rust side of `packages/companion-protocol`.
//!
//! Agent payloads (messages, the overview, statuses) are the desktop's own
//! types serialized as they are for the webview, so they travel here as
//! `serde_json::Value`. Everything new to the companion is typed below, and
//! `fixtures.rs` holds both to the TypeScript by generating
//! `fixtures.gen.ts` from real serialized values.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::CommandError;

// ---- Versions ---------------------------------------------------------------

/// 2: the Mac proves who it is before the phone sends its token
/// (`challenge` → `identity` → `hello`), and pairing signs the hosts. Nothing
/// shipped on 1, so it isn't answered any more (version.ts).
pub const PROTOCOL_VERSION: u32 = 2;
pub const MIN_PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolRange {
    pub min: u32,
    pub max: u32,
}

pub const SUPPORTED: ProtocolRange = ProtocolRange {
    min: MIN_PROTOCOL_VERSION,
    max: PROTOCOL_VERSION,
};

#[derive(Debug, PartialEq, Eq)]
pub enum Negotiation {
    Ok(u32),
    /// The phone is behind.
    UpdateApp,
    /// This Mac is behind.
    UpdateMac,
}

/// `negotiate` in version.ts: the highest version both speak.
pub fn negotiate(phone: ProtocolRange, mac: ProtocolRange) -> Negotiation {
    if phone.max < mac.min {
        Negotiation::UpdateApp
    } else if mac.max < phone.min {
        Negotiation::UpdateMac
    } else {
        Negotiation::Ok(phone.max.min(mac.max))
    }
}

// ---- The Mac, routes, devices -----------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cursor {
    pub epoch: String,
    pub seq: u64,
}

/// "We couldn't tell" is never shown as yes or no.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Known {
    Yes,
    No,
    Unknown,
}

impl From<Option<bool>> for Known {
    fn from(v: Option<bool>) -> Self {
        match v {
            Some(true) => Known::Yes,
            Some(false) => Known::No,
            None => Known::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Tailscale,
    Lan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Route {
    pub kind: RouteKind,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PowerInfo {
    pub keep_awake: bool,
    pub lid_closed_mode: Known,
    pub on_battery: Known,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery_percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    pub installed: bool,
    pub signed_in: Known,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacStatus {
    pub name: String,
    pub app_version: String,
    pub power: PowerInfo,
    pub claude: ClaudeInfo,
    pub routes: Vec<Route>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DevicePlatform {
    Ios,
    Android,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum BuildKind {
    #[serde(rename = "official")]
    Official,
    /// Built on this Mac (a fork or a self-install).
    #[serde(rename = "self")]
    SelfBuilt,
}

/// `Device` in model.ts: a paired phone as the phone and the Phone panel see it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub platform: DevicePlatform,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub app_version: String,
    pub build: BuildKind,
    pub paired_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_route: Option<RouteKind>,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

// ---- Pairing ----------------------------------------------------------------

/// From brand.json (`companion.scheme`); the phone reads the same value from
/// `@shipstudio/companion-protocol`'s generated brand file.
pub const PAIRING_SCHEME: &str = crate::brand::COMPANION_SCHEME;

/// What the pairing QR code carries. No long-lived secret.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingLink {
    pub v: u8,
    pub code: String,
    pub server_id: String,
    pub name: String,
    pub routes: Vec<Route>,
    /// The Mac's identity key, fingerprinted (`identity::fingerprint_of`):
    /// the phone pins it and refuses any server that can't sign for it.
    pub fingerprint: String,
}

impl PairingLink {
    /// `formatPairingLink` in pairing.ts: `<PAIRING_SCHEME>://pair?d=<base64url(JSON)>`.
    pub fn format(&self) -> String {
        use base64::Engine;
        let json = serde_json::to_string(self).unwrap_or_default();
        format!(
            "{PAIRING_SCHEME}://pair?d={}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairDevice {
    pub name: String,
    pub platform: DevicePlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub app_version: String,
    pub build: BuildKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    pub device: PairDevice,
    pub protocol: ProtocolRange,
    #[serde(default)]
    pub public_key: String,
    /// Random bytes, base64url, for the Mac to sign (`PairResponse.identity`).
    /// Optional here only so an app on protocol 1 is told to update rather
    /// than turned away as malformed; protocol 2 requires it.
    #[serde(default)]
    pub challenge: Option<String>,
}

/// `IdentityRequest` (`POST /v1/identity`).
#[derive(Debug, Clone, Deserialize)]
pub struct IdentityRequest {
    pub protocol: ProtocolRange,
    pub challenge: String,
}

/// `IdentityResponse`: the Mac proving who it is before a pairing code is sent.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum IdentityResponse {
    #[serde(rename_all = "camelCase")]
    Proven {
        ok: bool,
        protocol: u32,
        server_id: String,
        hosts: Vec<String>,
        identity: super::identity::IdentityProof,
    },
    Refused {
        ok: bool,
        reason: RefusedReason,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairRefusal {
    Expired,
    Used,
    Denied,
    Timeout,
    UpdateApp,
    UpdateMac,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum PairResponse {
    #[serde(rename_all = "camelCase")]
    Allowed {
        ok: bool,
        device_id: String,
        token: String,
        server_id: String,
        /// For the future relay's end-to-end encryption. Direct routes don't
        /// use it and P1 issues no server key, so it is empty rather than a
        /// key nothing holds the private half of.
        server_public_key: String,
        /// The hosts this Mac serves on (`identity::host_of`), as signed.
        hosts: Vec<String>,
        /// `identity::pair_message` signed by the key the pairing link's
        /// fingerprint names.
        identity: super::identity::IdentityProof,
    },
    Refused {
        ok: bool,
        reason: PairRefusal,
        message: String,
    },
}

impl PairResponse {
    pub fn refused(reason: PairRefusal, message: impl Into<String>) -> Self {
        PairResponse::Refused {
            ok: false,
            reason,
            message: message.into(),
        }
    }
}

// ---- Frames -----------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloApp {
    pub version: String,
    #[serde(default)]
    pub update_id: Option<String>,
    #[serde(default)]
    pub runtime_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloFrame {
    pub protocol: ProtocolRange,
    pub token: String,
    pub app: HelloApp,
    #[serde(default)]
    pub resume: Option<Cursor>,
    #[serde(default)]
    pub foreground: bool,
    /// What the app can show beyond the protocol version (`FEATURES` in
    /// frames.ts). An older app sends none.
    #[serde(default)]
    pub features: Vec<String>,
}

/// `hello.features`: the app shows a running turn's steps (`status.work`).
pub const FEATURE_LIVE_WORK: &str = "work.live";

/// `welcome.features`: `agents.send` takes `revises` (a result card's "Ask
/// for changes", `agents/results.rs`).
pub const MAC_FEATURE_REVISE_RESULTS: &str = "results.revise";

/// `welcome.features`: agents carry their "When…" routines as `watches`
/// (`agents/watch.rs`), which the phone shows read-only.
pub const MAC_FEATURE_WHEN_ROUTINES: &str = "routines.when";

/// `hello.features`: the app posts the Mac's `alert` events itself, and an
/// approval's with its card's buttons (`notify.ts`, `actionable.ts`), so it
/// no longer decides on its own which cards to post.
pub const FEATURE_ALERTS: &str = "alerts";

/// `welcome.features`: this Mac sends `alert` to apps that list
/// [`FEATURE_ALERTS`] (`companion/alerts.rs`), having applied mute, quiet
/// hours, "on screen" and "at the desk". An app talking to an older Mac keeps
/// posting approval cards it hears by itself.
pub const MAC_FEATURE_ALERTS: &str = "alerts";

/// `hello.features`: the app shows rooms, so it gets `rooms.changed` and the
/// lines only a room has (an empty `agentId`).
pub const FEATURE_ROOMS: &str = "rooms";

/// `welcome.features`: the `rooms.*` methods and `rooms.changed`.
pub const MAC_FEATURE_ROOMS: &str = "rooms";

/// `welcome.features`: login cards (`approval.login`) and the `agents.login*`
/// and `agents.reach` methods (`agents/logins.rs`).
pub const MAC_FEATURE_LOGINS: &str = "logins";

/// `welcome.features`: signing in on the phone itself
/// (`agents.loginPhoneBegin|loginPhoneFinish`, `onPhone`; `agents/login_relay.rs`).
pub const MAC_FEATURE_LOGINS_PHONE: &str = "logins.phone";

/// `welcome.features`: `agents.update` takes `color` from the phone. Older
/// phones also send `avatar` (a shape and a face from before keys) with
/// `agents.create` / `agents.update`: accepted and ignored, since nothing
/// draws one now, and agents no longer carry one.
pub const MAC_FEATURE_LOOKS: &str = "agents.looks";

/// `welcome.features`: kept for phones from before keys, which open their
/// look sheet (its colour) only on a Mac that lists this. The shape, face
/// and finish they send with it are accepted and ignored.
pub const MAC_FEATURE_KEYCAPS: &str = "agents.keycaps";

/// `welcome.features`: agents carry their key (`colorway`, `icon`,
/// `boundKey`; docs/internal/agent-keys.md), and `agents.create` /
/// `agents.update` take them from the phone. A bound key someone else has
/// is refused with a line saying whose it is.
pub const MAC_FEATURE_AGENT_KEYS: &str = "agents.keys";

/// `welcome.features`: signing in to a site in this Mac's Chrome from the
/// phone, the tab shown live there (`agents.signin*`; `agents/phone_signin.rs`).
pub const MAC_FEATURE_SIGNIN_PHONE: &str = "signin.phone";

/// `welcome.features`: stepping into an agent's own tab for its step-in
/// card from the phone (`agents.stepInBegin`, then the `agents.signin*`
/// frames and input; `agents/phone_signin.rs`, `agents/step_in.rs`).
pub const MAC_FEATURE_STEP_IN_PHONE: &str = "stepIn.phone";

/// `welcome.features`: `agents.watchLive` takes `link`, one of a message's
/// `localLinks` (`agents/local_links.rs`).
pub const MAC_FEATURE_WATCH_LINKS: &str = "watch.links";

/// `welcome.features`: `agents.update` takes `engine` and `model`.
pub const MAC_FEATURE_ENGINE: &str = "agents.engine";

/// `welcome.features`: `agents.update` takes `effort` (`low`, `medium`,
/// `high`, or empty for the engine's default), and agents carry theirs.
pub const MAC_FEATURE_EFFORT: &str = "agents.effort";

/// `welcome.features`: `agents.draft` ("Describe the agent you want"), and
/// `agents.create` takes `instructions` and `routines` (`agents/draft.rs`).
pub const MAC_FEATURE_DRAFT: &str = "agents.draft";

/// `welcome.features`: routines in steps (`agents/routine_steps.rs`):
/// `agents.schedule.create|update` take `then`, routines carry `then` and
/// `waiting`, and "OK to go on?" cards carry `gate`.
pub const MAC_FEATURE_STEPS: &str = "routines.steps";
/// Import without Remote access: `agents.import.exportPrompt|exportPreview|exportReview`
/// (a reply pasted back from the old assistant, read on the Mac, ending on the review card).
pub const MAC_FEATURE_IMPORT_EXPORT: &str = "import.export";

/// Everything `welcome.features` lists.
pub const MAC_FEATURES: &[&str] = &[
    MAC_FEATURE_REVISE_RESULTS,
    MAC_FEATURE_WHEN_ROUTINES,
    MAC_FEATURE_ROOMS,
    MAC_FEATURE_LOGINS,
    MAC_FEATURE_LOGINS_PHONE,
    MAC_FEATURE_LOOKS,
    MAC_FEATURE_KEYCAPS,
    MAC_FEATURE_AGENT_KEYS,
    MAC_FEATURE_SIGNIN_PHONE,
    MAC_FEATURE_STEP_IN_PHONE,
    MAC_FEATURE_WATCH_LINKS,
    MAC_FEATURE_ENGINE,
    MAC_FEATURE_EFFORT,
    MAC_FEATURE_DRAFT,
    MAC_FEATURE_STEPS,
    MAC_FEATURE_IMPORT_EXPORT,
    MAC_FEATURE_ALERTS,
];

/// What one connected app said it shows (`hello.features`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Shows {
    pub live_work: bool,
    pub rooms: bool,
    /// Posts the Mac's `alert` events ([`FEATURE_ALERTS`]).
    pub alerts: bool,
}

impl Shows {
    pub fn from_hello(features: &[String]) -> Self {
        Shows {
            live_work: features.iter().any(|f| f == FEATURE_LIVE_WORK),
            rooms: features.iter().any(|f| f == FEATURE_ROOMS),
            alerts: features.iter().any(|f| f == FEATURE_ALERTS),
        }
    }
}

/// Phone → Mac. Unknown frame types are ignored, as the protocol promises.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientFrame {
    /// The first frame of protocol 2: sign this before I say anything.
    Challenge {
        protocol: ProtocolRange,
        challenge: String,
    },
    Hello(HelloFrame),
    Req {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Presence {
        foreground: bool,
    },
    Ping,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResumeMode {
    Replay,
    Snapshot,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefusedReason {
    Unauthorized,
    Revoked,
    UpdateApp,
    UpdateMac,
    TooManyConnections,
    /// The identity key can't be read right now (Keychain locked or
    /// refusing): nothing can be proven, so try again later.
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    pub app_version: String,
}

/// The `type: 'Protocol'` error: the companion's own failures.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolCode {
    UnknownMethod,
    BadParams,
    RateLimited,
    TooLarge,
    Refused,
    NotConnected,
}

#[derive(Debug, Clone)]
pub enum WireError {
    Command(CommandError),
    Protocol { code: ProtocolCode, message: String },
}

impl WireError {
    pub fn protocol(code: ProtocolCode, message: impl Into<String>) -> Self {
        WireError::Protocol {
            code,
            message: message.into(),
        }
    }

    /// A one-line form for the audit log.
    pub fn summary(&self) -> String {
        match self {
            WireError::Command(e) => e.to_string(),
            WireError::Protocol { message, .. } => message.clone(),
        }
    }
}

impl From<CommandError> for WireError {
    fn from(e: CommandError) -> Self {
        WireError::Command(e)
    }
}

impl Serialize for WireError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(tag = "type")]
        enum Tagged<'a> {
            Protocol {
                code: ProtocolCode,
                message: &'a str,
            },
        }
        match self {
            WireError::Command(e) => e.serialize(serializer),
            WireError::Protocol { code, message } => Tagged::Protocol {
                code: *code,
                message,
            }
            .serialize(serializer),
        }
    }
}

/// Mac → phone.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum ServerFrame {
    /// The answer to `challenge`: who this Mac is, signed
    /// (`identity::mac_message`), before the phone sends its token.
    Identity {
        protocol: u32,
        server_id: String,
        hosts: Vec<String>,
        identity: super::identity::IdentityProof,
    },
    Welcome {
        protocol: u32,
        server: ServerInfo,
        device_id: String,
        resume: ResumeMode,
        methods: Vec<&'static str>,
        /// This Mac's IANA zone ("America/New_York"), the zone it reads a
        /// routine's times in. Absent when the system won't say. A Mac that
        /// sends it also keeps a check-in's schedule when an edit's `when`
        /// is empty.
        #[serde(skip_serializing_if = "Option::is_none")]
        time_zone: Option<String>,
        /// What this Mac does beyond its methods (`MAC_FEATURES`), so a newer
        /// app offers only what it can carry out. Older Macs send none.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        features: Vec<&'static str>,
    },
    Refused {
        reason: RefusedReason,
        message: String,
    },
    Res {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<WireError>,
    },
    Evt {
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
        event: Event,
    },
    Pong,
}

impl ServerFrame {
    pub fn response(id: u64, result: Result<Value, WireError>) -> Self {
        match result {
            Ok(value) => ServerFrame::Res {
                id,
                ok: true,
                result: Some(value),
                error: None,
            },
            Err(e) => ServerFrame::Res {
                id,
                ok: false,
                result: None,
                error: Some(e),
            },
        }
    }
}

/// Every event (events.ts). Agent payloads are the desktop's own JSON.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum Event {
    #[serde(rename = "agents.message")]
    Message { message: Value },
    #[serde(rename = "agents.status")]
    Status { agent_id: String, status: Value },
    #[serde(rename = "agents.registry")]
    Registry { overview: Value },
    /// Every room, after any change (`agents://rooms`).
    #[serde(rename = "rooms.changed")]
    Rooms { rooms: Value },
    #[serde(rename = "system.status")]
    System { status: MacStatus },
    #[serde(rename = "projects.changed")]
    ProjectChanged { project: Value },
    #[serde(rename = "projects.removed")]
    ProjectRemoved { path: String },
    #[serde(rename = "agents.draft")]
    Draft {
        agent_id: String,
        id: String,
        from: usize,
        text: String,
    },
    /// Post a notification (ephemeral; `companion/alerts.rs`). Only to apps
    /// that list [`FEATURE_ALERTS`], and never to the socket in front of
    /// that agent's chat.
    #[serde(rename = "alert")]
    Alert { alert: LiveAlert },
    #[serde(rename = "sync.snapshot")]
    Snapshot {
        cursor: Cursor,
        overview: Value,
        status: MacStatus,
        /// The project list, or `null` when it couldn't be read in time
        /// (the phone keeps the list it has).
        projects: Value,
    },
    #[serde(rename = "sync.caughtUp")]
    CaughtUp { cursor: Cursor },
}

/// What a phone's notification says (`Alert` in model.ts): ids and plain
/// words only, already through `agents::secrets::redact`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveAlert {
    pub agent_id: String,
    /// The message it is about: tapping opens the chat there, and the phone
    /// replaces (never stacks) a second alert for the same one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub title: String,
    pub body: String,
    pub kind: AlertKind,
}

/// `Alert['kind']` in model.ts.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlertKind {
    Reply,
    Approval,
    Error,
    CheckIn,
}

/// The desktop's `agents_overview`, as the phone gets it. Each agent's
/// lifetime `usage` totals are dropped: `Agent` in model.ts doesn't carry
/// them (the phone asks `agents.usage` when it shows them), and this goes
/// out on every registry change.
/// A running turn's steps are dropped too: they ride on `agents.status`,
/// which is sent on every step, to the phones that show them.
pub fn phone_overview(mut overview: Value) -> Value {
    if let Some(agents) = overview.get_mut("agents").and_then(Value::as_array_mut) {
        for agent in agents {
            if let Some(fields) = agent.as_object_mut() {
                fields.remove("usage");
                // Each routine's daily rows too: `agents.usage` has its week.
                if let Some(check_ins) = fields.get_mut("checkIns").and_then(Value::as_array_mut) {
                    for c in check_ins.iter_mut().filter_map(Value::as_object_mut) {
                        c.remove("usage");
                    }
                }
                if let Some(status) = fields.get_mut("status").and_then(Value::as_object_mut) {
                    status.remove("work");
                }
                // The phone shows that it's driven; the Mac's terminal id is
                // nothing it can use, so it never leaves the Mac.
                if let Some(t) = fields.get_mut("takeover").and_then(Value::as_object_mut) {
                    t.remove("ptySession");
                }
                // Other conversations' engine sessions stay on the Mac too.
                if let Some(c) = fields
                    .get_mut("conversations")
                    .and_then(Value::as_object_mut)
                {
                    c.remove("parked");
                }
                split_watches(fields);
            }
        }
    }
    overview
}

/// "When…" routines leave `checkIns` for `watches`: an older phone would
/// read one as a one-time check-in (it has a `nextAt` and no `repeat`) and
/// offer to edit its time. A phone that knows them reads `watches`. What a
/// routine has seen, and the items of its last firing, stay on the Mac.
fn split_watches(fields: &mut serde_json::Map<String, Value>) {
    let Some(Value::Array(check_ins)) = fields.remove("checkIns") else {
        return;
    };
    let (mut watches, timed): (Vec<Value>, Vec<Value>) = check_ins
        .into_iter()
        .partition(|c| c.get("watch").is_some_and(|w| !w.is_null()));
    for w in &mut watches {
        if let Some(watch) = w.get_mut("watch").and_then(Value::as_object_mut) {
            watch.remove("seen");
            watch.remove("pending");
        }
    }
    fields.insert("checkIns".into(), Value::Array(timed));
    if !watches.is_empty() {
        fields.insert("watches".into(), Value::Array(watches));
    }
}

/// An event as a phone that doesn't show a running turn's steps gets it:
/// without them.
pub fn without_live_work(mut event: Event) -> Event {
    if let Event::Status { status, .. } = &mut event {
        if let Some(fields) = status.as_object_mut() {
            fields.remove("work");
        }
    }
    event
}

/// A line only a room has: the user's message there, or a room note. It
/// names no agent, so an app without rooms would have nowhere to put it.
pub fn is_room_only(message: &Value) -> bool {
    message.get("room").is_some_and(|r| !r.is_null())
        && message
            .get("agentId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
}

/// `agents.search`'s hits for one app. One that doesn't show rooms gets no
/// room-only hit (the user's own line there has no agent to open), and a
/// member's line said in a room as a hit in that agent's chat, where an
/// older app shows it.
pub fn search_for_app(hits: serde_json::Value, shows: Shows) -> serde_json::Value {
    if shows.rooms {
        return hits;
    }
    let serde_json::Value::Array(hits) = hits else {
        return hits;
    };
    hits.into_iter()
        .filter_map(|mut hit| {
            let Some(o) = hit.as_object_mut() else {
                return Some(hit);
            };
            if o.remove("roomId").is_some() {
                o.remove("roomName");
                let speaker = o.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
                if speaker.is_empty() {
                    return None;
                }
            }
            Some(hit)
        })
        .collect::<Vec<_>>()
        .into()
}

/// An event as this app gets it, or `None` when it wouldn't show it: rooms
/// (and their room-only lines) only to an app that said it shows rooms; a
/// running turn's steps only to one that shows those. A member's own line
/// said in a room still reaches an older app, in that agent's chat.
pub fn for_app(event: Event, shows: Shows) -> Option<Event> {
    if !shows.rooms {
        match &event {
            Event::Rooms { .. } => return None,
            Event::Message { message } if is_room_only(message) => return None,
            _ => {}
        }
    }
    Some(if shows.live_work {
        event
    } else {
        without_live_work(event)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_phone_sees_a_take_over_but_not_its_terminal() {
        let overview = serde_json::json!({ "agents": [{
            "id": "a1",
            "status": { "state": "idle" },
            "takeover": { "since": 5, "ptySession": "takeover-1", "cli": "claude-code", "project": "/p" }
        }]});
        let shown = phone_overview(overview);
        assert_eq!(
            shown["agents"][0]["takeover"],
            serde_json::json!({ "since": 5, "cli": "claude-code", "project": "/p" })
        );
    }

    #[test]
    fn an_app_without_rooms_gets_no_room_events_or_room_only_lines() {
        let old = Shows {
            live_work: true,
            rooms: false,
            ..Default::default()
        };
        let new = Shows {
            live_work: true,
            rooms: true,
            ..Default::default()
        };
        let rooms = Event::Rooms {
            rooms: serde_json::json!([]),
        };
        assert_eq!(for_app(rooms.clone(), old), None);
        assert_eq!(for_app(rooms.clone(), new), Some(rooms));
        let users_line = Event::Message {
            message: serde_json::json!({"id": "m1", "agentId": "", "room": "r1", "kind": "user"}),
        };
        assert_eq!(for_app(users_line.clone(), old), None);
        assert!(for_app(users_line, new).is_some());
        // A member's reply in a room still shows in its own chat on an older app.
        let reply = Event::Message {
            message: serde_json::json!({"id": "m2", "agentId": "a1", "room": "r1", "kind": "agent"}),
        };
        assert!(for_app(reply, old).is_some());
        assert_eq!(
            Shows::from_hello(&["rooms".into(), "work.live".into()]),
            new
        );
    }

    #[test]
    fn an_app_without_rooms_gets_no_room_only_search_hits() {
        let hits = serde_json::json!([
            { "agentId": "a1", "messageId": "m1", "snippet": "own" },
            { "agentId": "", "messageId": "m2", "roomId": "r1", "roomName": "Launch" },
            { "agentId": "a2", "messageId": "m3", "roomId": "r1", "roomName": "Launch" }
        ]);
        let old = search_for_app(hits.clone(), Shows::default());
        assert_eq!(
            old,
            serde_json::json!([
                { "agentId": "a1", "messageId": "m1", "snippet": "own" },
                { "agentId": "a2", "messageId": "m3" }
            ])
        );
        let new = Shows {
            live_work: false,
            rooms: true,
            ..Default::default()
        };
        assert_eq!(search_for_app(hits.clone(), new), hits);
    }

    #[test]
    fn when_routines_reach_the_phone_apart_from_timed_ones() {
        let overview = serde_json::json!({ "agents": [{
            "id": "a1",
            "status": { "state": "idle" },
            "checkIns": [
                { "id": "t", "note": "Brief", "nextAt": 1, "createdAt": 0, "paused": false, "repeat": { "kind": "every", "minutes": 60 } },
                { "id": "w", "note": "Triage", "nextAt": 1, "createdAt": 0, "paused": false,
                  "watch": { "source": { "kind": "github_mentions" }, "everyMinutes": 10, "seen": ["x"], "pending": [{ "id": "x", "title": "t" }], "lastFound": 1, "failures": 0 } }
            ]
        }, { "id": "a2", "status": { "state": "idle" } }]});
        let shown = phone_overview(overview);
        let agent = &shown["agents"][0];
        assert_eq!(agent["checkIns"].as_array().unwrap().len(), 1);
        assert_eq!(agent["checkIns"][0]["id"], "t");
        assert_eq!(
            agent["watches"][0]["watch"],
            serde_json::json!({ "source": { "kind": "github_mentions" }, "everyMinutes": 10, "lastFound": 1, "failures": 0 })
        );
        assert!(shown["agents"][1].get("watches").is_none());
        assert!(shown["agents"][1].get("checkIns").is_none());
    }

    #[test]
    fn negotiation_matches_version_ts() {
        let r = |min, max| ProtocolRange { min, max };
        assert_eq!(negotiate(r(1, 3), r(2, 2)), Negotiation::Ok(2));
        assert_eq!(negotiate(r(1, 1), r(2, 3)), Negotiation::UpdateApp);
        assert_eq!(negotiate(r(3, 4), r(1, 2)), Negotiation::UpdateMac);
    }

    #[test]
    fn a_pairing_link_is_the_scheme_and_base64url_json() {
        let link = PairingLink {
            v: 1,
            code: "ABC".into(),
            server_id: "srv".into(),
            name: "Julian’s Mac".into(),
            routes: vec![Route {
                kind: RouteKind::Tailscale,
                url: "https://mac.ts.net:47443".into(),
                pin: None,
            }],
            fingerprint: "Zmh6rfhivXdsj8GLjp-OIA".into(),
        };
        let text = link.format();
        let d = text
            .strip_prefix(&format!("{PAIRING_SCHEME}://pair?d="))
            .unwrap();
        assert!(d
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        use base64::Engine;
        let json: Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(d)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["serverId"], "srv");
        assert_eq!(json["name"], "Julian’s Mac");
    }

    #[test]
    fn a_null_result_is_still_sent() {
        let frame = ServerFrame::response(4, Ok(Value::Null));
        let json = serde_json::to_value(frame).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"t": "res", "id": 4, "ok": true, "result": null})
        );
    }

    #[test]
    fn unknown_client_frames_fail_to_parse_rather_than_panic() {
        assert!(serde_json::from_str::<ClientFrame>(r#"{"t":"nope"}"#).is_err());
        assert!(matches!(
            serde_json::from_str::<ClientFrame>(r#"{"t":"ping"}"#),
            Ok(ClientFrame::Ping)
        ));
    }
}
