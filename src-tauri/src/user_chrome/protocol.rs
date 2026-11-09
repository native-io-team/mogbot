//! The messages between the app and its Chrome extension, typed and
//! versioned. The extension's copy is `chrome-extension/src/protocol.js`;
//! `protocol_tests.rs` holds the two to the same shapes.
//!
//! Two layers travel on one socket:
//!
//! 1. **The handshake** ([`Handshake`]), between the app and the native host
//!    Chrome started. Each proves it holds the link's token without sending
//!    it (`auth`). The extension never sees the token.
//! 2. **The link** ([`FromExtension`], [`ToExtension`]), relayed byte for byte
//!    by the host once the handshake is done. The extension speaks first
//!    with [`FromExtension::Hello`]; the app answers [`ToExtension::Welcome`]
//!    or [`ToExtension::Bye`].
//!
//! The protocol version is [`PROTOCOL`]. A side that sees a version outside
//! what it supports says so in a `Bye` (`version`), and the extension shows
//! "update needed" instead of retrying for ever.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// This build's protocol version.
pub const PROTOCOL: u32 = 1;
/// The oldest extension protocol this build still speaks.
pub const MIN_PROTOCOL: u32 = 1;

/* ------------------------------------------------------- handshake */

/// The handshake between the native host and the app, before any relaying.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Handshake {
    /// Host → app: who started it (Chrome's `chrome-extension://<id>/`), and
    /// a fresh nonce the app must prove the token over.
    HostHello {
        v: u32,
        origin: String,
        host_nonce: String,
    },
    /// App → host: the app's proof over both nonces, and its own nonce.
    AppChallenge { app_nonce: String, proof: String },
    /// Host → app: the host's proof.
    HostProof { proof: String },
    /// App → host: relaying starts.
    Ready,
    /// Either side: no.
    Refused { reason: String },
}

/* ---------------------------------------------- extension → the app */

/// What the extension sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum FromExtension {
    /// The first message on a link.
    Hello {
        v: u32,
        extension_version: String,
        /// A random id the extension keeps in `chrome.storage.local`: one
        /// per Chrome profile it is installed in.
        profile_id: String,
        /// What the user calls this profile, when they named it in the
        /// extension; else empty.
        #[serde(default)]
        profile_label: String,
        #[serde(default)]
        user_agent: String,
    },
    /// The answer to a [`ToExtension::Req`].
    Res {
        id: u64,
        ok: bool,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        error: Option<ExtError>,
    },
    /// Something happened the app should know about.
    Event { event: ExtEvent },
}

/// Something the extension noticed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExtEvent {
    /// An agent's tab was closed (by the user, or by the site).
    TabClosed { tab_id: i64, agent: String },
    /// An agent's tab moved to another page.
    TabUpdated {
        tab_id: i64,
        agent: String,
        url: String,
        title: String,
    },
    /// Chrome stopped letting the extension drive a tab: the user pressed
    /// Cancel on Chrome's "is debugging this browser" bar, or opened
    /// DevTools on it.
    DebuggerDetached {
        tab_id: i64,
        agent: String,
        reason: String,
    },
}

/// Why the extension couldn't do something, in a code the app acts on and
/// a line a person can read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request wasn't one this extension understands.
    BadRequest,
    /// The tab isn't one this agent opened.
    NotOwned,
    /// The tab is gone.
    NoTab,
    /// The CDP method or expression isn't on the extension's list.
    NotAllowed,
    /// Chrome wouldn't let the extension drive the tab (DevTools open on
    /// it, another extension debugging it, a page Chrome protects).
    AttachFailed,
    /// Chrome answered the command with an error.
    Cdp,
    /// The page is one extensions may not touch (`chrome://`, the Web Store).
    Protected,
    /// The tab hasn't answered the last input event yet, so no other is
    /// sent to it (one sent now would wait behind it and land late).
    Busy,
    /// Anything else.
    Internal,
    /// A code from a newer extension this build doesn't know.
    #[serde(other)]
    Unknown,
}

/* ---------------------------------------------- the app → extension */

/// What the app sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ToExtension {
    /// The link is up.
    Welcome { v: u32, app_version: String },
    /// Do something; answered by a `Res` with the same `id`.
    Req { id: u64, op: Op },
    /// The app is closing the link, and why (`version`, `replaced`, `off`).
    Bye { reason: String },
    /// Sent by the native host, not the app: it couldn't reach the app
    /// (`app_not_running`, `refused`, `no_token`), and is about to exit.
    Unavailable { reason: String },
}

/// One thing the extension does. Every op that touches a tab names the
/// agent, and the extension acts only on tabs that agent opened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Op {
    /// Nothing; answered at once.
    Ping,
    /// The tabs agents opened in this profile, each with its agent.
    TabsList,
    /// A new tab for `agent`, in its own tab group named `label`.
    TabsOpen {
        agent: String,
        label: String,
        url: String,
        #[serde(default)]
        color: Option<String>,
    },
    /// One of the agent's tabs, as it is now.
    TabGet { agent: String, tab_id: i64 },
    /// Close one of the agent's tabs.
    TabClose { agent: String, tab_id: i64 },
    /// Make one of the agent's tabs the shown tab of its window (Chrome
    /// paints only shown tabs, so a screenshot needs it).
    TabFocus { agent: String, tab_id: i64 },
    /// Close every tab the agent opened.
    Release { agent: String },
    /// One allow-listed CDP command on one of the agent's tabs, through
    /// `chrome.debugger`.
    Cdp {
        agent: String,
        tab_id: i64,
        method: String,
        #[serde(default)]
        params: Value,
    },
}

impl Op {
    /// The agent the op is for, if it names one.
    pub fn agent(&self) -> Option<&str> {
        match self {
            Op::Ping | Op::TabsList => None,
            Op::TabsOpen { agent, .. }
            | Op::TabGet { agent, .. }
            | Op::TabClose { agent, .. }
            | Op::TabFocus { agent, .. }
            | Op::Release { agent }
            | Op::Cdp { agent, .. } => Some(agent),
        }
    }
}

/// One tab, as the extension reports it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabInfo {
    pub tab_id: i64,
    pub window_id: i64,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub active: bool,
    /// "loading" or "complete".
    #[serde(default)]
    pub status: String,
    pub agent: String,
}

/// Whether this build speaks the extension's version.
pub fn supported(v: u32) -> bool {
    (MIN_PROTOCOL..=PROTOCOL).contains(&v)
}
