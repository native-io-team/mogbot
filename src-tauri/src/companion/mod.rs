//! # Mobile companion
//!
//! Serves the Ship Studio phone app from this Mac: pairing by QR code with a
//! click to Allow at the desk, then one WebSocket per phone carrying requests
//! (routed to the same command functions the desktop runs) and a journal of
//! events the phone resumes from by cursor.
//!
//! P1 is Tailscale only: the server binds loopback and `tailscale serve`
//! publishes it to the user's own tailnet at `https://<mac>.ts.net:47443`,
//! with Tailscale's certificate. Nothing passes through anything we run.
//!
//! - `wire` — the Rust side of `packages/companion-protocol`
//! - `pairing` — codes, the desk confirmation, token hashing
//! - `hub` — the event journal, replay, and draft appends
//! - `router` — method → command function, refusals, idempotent send, audit
//! - `server` — HTTP (`/v1/pair`) and the WebSocket (`/v1/ws`)
//! - `desktop` — the real backend, event wiring, Tailscale, lifecycle
//!
//! Full design: docs/mobile.md.

pub mod alerts;
pub mod blobs;
pub mod desktop;
pub mod files;
#[cfg(test)]
mod fixtures;
pub mod hub;
pub mod identity;
pub mod keystore;
pub mod limits;
pub mod pairing;
pub mod projects;
pub mod push;
pub mod relay;
pub mod router;
pub mod server;
#[cfg(test)]
pub(crate) mod testkit;
pub mod watch;
pub mod wire;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::errors::CommandError;
use wire::{BuildKind, Device, DevicePlatform, PairDevice, RouteKind};

pub use desktop::{is_showing, resume_on_launch, say_goodbye_sync};

/// The HTTPS port `tailscale serve` publishes on. Deliberately not 443, 8443
/// or 10000: those are the only ports Funnel can open to the internet, and
/// Remote Access already funnels 443. Not Ship Studio's 47443 either: one
/// `tailscale serve` slot per port, so the two apps would take it in turns.
/// From brand.json (`companion.tailnetPort`), mirrored in companion-protocol.
pub const TAILNET_HTTPS_PORT: u16 = crate::brand::COMPANION_TAILNET_PORT;
/// Sockets per device and in total.
pub const MAX_SOCKETS_PER_DEVICE: usize = 4;
pub const MAX_SOCKETS: usize = 16;
/// Requests per rolling minute per device.
pub const MAX_REQUESTS_PER_MINUTE: usize = 600;
/// Agents a device may create per rolling minute: far more than anyone sets
/// up by hand, far fewer than a stolen token could fill the team (and the
/// Chief of Staff's prompt) with.
pub const MAX_AGENTS_CREATED_PER_MINUTE: usize = 10;
/// Revoked token hashes remembered, so a removed phone hears "removed"
/// rather than "unknown".
const REVOKED_KEPT: usize = 64;
/// A phone's name and model as the desk shows them and the audit log names
/// them: one line, this many characters at most.
pub const MAX_DEVICE_NAME_CHARS: usize = 40;

/// Characters that change how text around them is shown without being
/// visible themselves: bidi overrides and isolates, zero-width joiners and
/// spaces, the BOM, soft hyphens, variation selectors, Hangul fillers and
/// the rest of Unicode's format (Cf) class. A name made with them can read
/// as "Sam's iPhone" while being something else, or flip the words after it.
fn is_invisible_format(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F
        | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFFB | 0x0600..=0x0605 | 0x06DD | 0x070F
        | 0x0890..=0x0891 | 0x08E2 | 0x110BD | 0x110CD | 0x13430..=0x1343F
        | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
}

/// A device's own words (its name, its model), fit to show: control and
/// invisible format characters removed, runs of whitespace made one space,
/// trimmed and cut to `max` characters. `None` when nothing visible is left.
pub fn clean_device_text(raw: &str, max: usize) -> Option<String> {
    let kept: String = raw
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control() && !is_invisible_format(*c))
        .collect();
    let flat = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = flat.chars().take(max).collect();
    let cut = cut.trim().to_string();
    (!cut.is_empty()).then_some(cut)
}

/// [`clean_device_text`] over everything the desk shows of a pairing phone.
pub fn clean_pair_device(d: &PairDevice) -> PairDevice {
    PairDevice {
        name: clean_device_text(&d.name, MAX_DEVICE_NAME_CHARS)
            .unwrap_or_else(|| "Unnamed phone".into()),
        platform: d.platform,
        model: d
            .model
            .as_deref()
            .and_then(|m| clean_device_text(m, MAX_DEVICE_NAME_CHARS)),
        app_version: clean_device_text(&d.app_version, 40).unwrap_or_else(|| "?".into()),
        build: d.build,
    }
}

/// A rolling one-minute window per device: counts `now` and says yes while
/// under `max`.
fn within_minute(
    windows: &Mutex<HashMap<String, VecDeque<u64>>>,
    device_id: &str,
    now: u64,
    max: usize,
) -> bool {
    let mut all = windows.lock().unwrap_or_else(|e| e.into_inner());
    let window = all.entry(device_id.to_string()).or_default();
    while window
        .front()
        .is_some_and(|t| now.saturating_sub(*t) >= 60_000)
    {
        window.pop_front();
    }
    if window.len() >= max {
        return false;
    }
    window.push_back(now);
    true
}

pub(crate) fn now_ms() -> u64 {
    crate::remote_access::now_ms()
}

/// Who acted, as the audit log names a phone.
pub fn actor_for(device_name: &str) -> String {
    format!("Phone · {device_name}")
}

// ============================================================================
// The device registry (companion.json, 0600)
// ============================================================================

/// A paired phone as stored on the Mac: the token only as its SHA-256.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    pub platform: DevicePlatform,
    #[serde(default)]
    pub model: Option<String>,
    pub app_version: String,
    pub build: BuildKind,
    pub paired_at: i64,
    #[serde(default)]
    pub last_seen_at: Option<i64>,
    #[serde(default)]
    pub last_route: Option<RouteKind>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    pub token_hash: String,
    /// The phone's X25519 key from pairing, kept for the future relay.
    #[serde(default)]
    pub public_key: String,
    /// Its push token, once it sent one (`devices.setPush`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push: Option<push::PushToken>,
    /// The tailnet user `tailscale serve` said was pairing
    /// (`Tailscale-User-Login`), when it said. A later request with this
    /// token from another tailnet user is refused (docs/mobile.md).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tailnet_login: Option<String>,
}

impl DeviceRecord {
    pub fn view(&self, connected: bool) -> Device {
        Device {
            id: self.id.clone(),
            name: self.name.clone(),
            platform: self.platform,
            model: self.model.clone(),
            app_version: self.app_version.clone(),
            build: self.build,
            paired_at: self.paired_at,
            last_seen_at: self.last_seen_at,
            last_route: self.last_route,
            connected,
            expires_at: self.expires_at,
        }
    }

    /// Looks like the same phone pairing again. Everything compared is the
    /// phone's own say-so, so this only ever picks what the desk *offers*
    /// to replace; nothing is removed unless the person there says so.
    fn same_phone(&self, d: &PairDevice) -> bool {
        self.name == d.name && self.platform == d.platform && self.model == d.model
    }

    /// Whether a request that came with `login` may use this record. A
    /// phone paired by a tailnet user is that user's on every request: the
    /// header must name the same user, and a request naming nobody (a tagged
    /// node, or a local process) is refused, even with the right token. A
    /// phone paired with no login (over loopback) takes any.
    pub fn login_matches(&self, login: Option<&str>) -> bool {
        match (&self.tailnet_login, login) {
            (Some(paired), Some(now)) => paired.eq_ignore_ascii_case(now),
            (Some(_), None) => false,
            (None, _) => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Stored {
    pub enabled: bool,
    /// This Mac's stable id, so a re-pair replaces the old entry on the phone.
    pub server_id: String,
    /// The loopback port, kept so the serve handler stays valid across restarts.
    pub port: Option<u16>,
    pub devices: Vec<DeviceRecord>,
    /// Hashes of revoked tokens, newest last.
    pub revoked: Vec<String>,
    /// Phone notifications through the push relay (`push.rs`).
    pub push: push::PushConfig,
    /// Where this Mac's Ed25519 identity key was kept before the Keychain
    /// (PKCS#8, base64url). Read once to move it there, then emptied.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub identity_key: String,
}

// Short-lived (one per connection); boxing the record would buy nothing.
#[allow(clippy::large_enum_variant)]
pub enum Auth {
    Device(DeviceRecord),
    Revoked,
    Unknown,
}

pub struct Registry {
    /// `None` keeps it in memory (tests).
    path: Option<PathBuf>,
    stored: Mutex<Stored>,
    /// Where the identity key is kept (the Keychain; memory in tests).
    keys: Box<dyn keystore::KeyStore>,
    /// The identity once it's known. Not set while the Keychain won't answer,
    /// so the next caller asks again.
    identity: Mutex<Option<Kept>>,
}

#[derive(Clone)]
struct Kept {
    id: Arc<identity::Identity>,
    /// It will be the same key next launch. A pairing code is only offered
    /// when it is: a phone must never pin a key the Mac is about to lose.
    durable: bool,
}

/// The real Keychain in the app; a memory store under test, so no test can
/// ever touch (or replace) the user's real key.
fn default_keys() -> Box<dyn keystore::KeyStore> {
    #[cfg(not(test))]
    {
        Box::new(keystore::Keychain::app())
    }
    #[cfg(test)]
    {
        Box::new(Arc::new(keystore::Memory::default()))
    }
}

impl Registry {
    pub fn load(path: PathBuf) -> Self {
        Self::load_with(path, default_keys())
    }

    /// [`Registry::load`] with the identity key kept in `keys`.
    pub fn load_with(path: PathBuf, keys: Box<dyn keystore::KeyStore>) -> Self {
        let stored = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self::new(Some(path), stored, keys)
    }

    pub fn in_memory() -> Self {
        Self::new(None, Stored::default(), default_keys())
    }

    fn new(path: Option<PathBuf>, stored: Stored, keys: Box<dyn keystore::KeyStore>) -> Self {
        let r = Registry {
            path,
            stored: Mutex::new(stored),
            keys,
            identity: Mutex::new(None),
        };
        r.ensure_server_id();
        // With phones paired (or a key to move), settle the key now, before
        // any is shown: a key that was lost resets them here, not halfway
        // through a connection. Otherwise it waits until it's needed, so a
        // Mac that never pairs a phone never touches the Keychain.
        if r.read(|s| !s.devices.is_empty() || !s.identity_key.is_empty()) {
            r.kept();
        }
        r
    }

    /// This Mac's identity key, or `None` while the Keychain won't give it
    /// (locked, or refusing): then nothing can be proven and every phone is
    /// told to try again, rather than a new key quietly replacing the one
    /// they pinned.
    pub fn identity(&self) -> Option<Arc<identity::Identity>> {
        self.kept().map(|k| k.id)
    }

    /// The key will survive a restart (it is in the Keychain, or still in
    /// the old file waiting to move). No pairing code is offered otherwise.
    pub fn identity_is_durable(&self) -> bool {
        self.kept().is_some_and(|k| k.durable)
    }

    fn kept(&self) -> Option<Kept> {
        let mut slot = self.identity.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = self.resolve_identity();
        }
        slot.clone()
    }

    fn resolve_identity(&self) -> Option<Kept> {
        let old = self.read(|s| s.identity_key.clone());
        let old_key = (!old.is_empty())
            .then(|| identity::Identity::from_stored(&old))
            .flatten();
        match self.keys.load() {
            Ok(Some(doc)) => {
                if let Some(id) = identity::Identity::from_stored(&doc) {
                    if !old.is_empty() {
                        let _ = self.write(|s| s.identity_key.clear());
                    }
                    return Some(Kept {
                        id: Arc::new(id),
                        durable: true,
                    });
                }
                tracing::error!("[Companion] The identity key in the Keychain doesn't parse");
                Some(self.fresh_identity())
            }
            Ok(None) => match old_key {
                // Kept in companion.json by an earlier build: move it, and
                // empty the file's copy only once the Keychain gives it back.
                Some(id) => {
                    let moved = self.keys.save(&old).is_ok()
                        && self.keys.load().ok().flatten().as_deref() == Some(old.as_str());
                    if moved {
                        if let Err(e) = self.write(|s| s.identity_key.clear()) {
                            tracing::warn!("[Companion] Moved the identity key, but couldn't clear the old copy: {}", e);
                        }
                    } else {
                        tracing::warn!("[Companion] Couldn't move the identity key to the Keychain; keeping it where it was");
                    }
                    Some(Kept {
                        id: Arc::new(id),
                        durable: true,
                    })
                }
                None => Some(self.fresh_identity()),
            },
            Err(e) => {
                tracing::warn!("[Companion] Couldn't read the identity key: {}", e);
                old_key.map(|id| Kept {
                    id: Arc::new(id),
                    durable: true,
                })
            }
        }
    }

    /// A new key. If phones were paired, they pinned the key that's gone:
    /// this is a different Mac to them now, so it gets a new server id and
    /// every phone is removed. They hear "this Mac was set up again, pair
    /// again" rather than "this isn't your Mac".
    fn fresh_identity(&self) -> Kept {
        // As for pairing codes: no RNG, no safe key.
        #[allow(clippy::expect_used)]
        let (id, doc) =
            identity::Identity::generate().expect("the OS random number generator is unavailable");
        let durable = match self.keys.save(&doc) {
            Ok(()) => self.keys.load().ok().flatten().as_deref() == Some(doc.as_str()),
            Err(e) => {
                tracing::error!(
                    "[Companion] Couldn't keep the identity key in the Keychain: {}",
                    e
                );
                false
            }
        };
        let had_phones = self.read(|s| !s.devices.is_empty());
        let result = self.write(|s| {
            s.identity_key.clear();
            if had_phones {
                s.server_id = new_server_id();
                for d in std::mem::take(&mut s.devices) {
                    remember_revoked(s, d.token_hash);
                }
            }
        });
        if had_phones {
            tracing::warn!("[Companion] New identity key with phones paired: they were removed and must pair again");
        }
        if let Err(e) = result {
            tracing::error!("[Companion] Couldn't save the reset: {}", e);
        }
        Kept {
            id: Arc::new(id),
            durable,
        }
    }

    fn ensure_server_id(&self) {
        let missing = self.read(|s| s.server_id.is_empty());
        if missing {
            let _ = self.write(|s| s.server_id = new_server_id());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Stored> {
        self.stored.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn read<T>(&self, f: impl FnOnce(&Stored) -> T) -> T {
        f(&self.lock())
    }

    /// Change and persist, under one lock.
    pub fn write<T>(&self, f: impl FnOnce(&mut Stored) -> T) -> Result<T, CommandError> {
        let mut s = self.lock();
        let out = f(&mut s);
        if let Some(path) = &self.path {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let json = serde_json::to_string_pretty(&*s)
                .map_err(|e| CommandError::from(format!("serialize companion config: {e}")))?;
            crate::remote_access::write_private(path, json.as_bytes())?;
        }
        Ok(out)
    }

    pub fn server_id(&self) -> String {
        self.read(|s| s.server_id.clone())
    }

    pub fn get(&self, device_id: &str) -> Option<DeviceRecord> {
        self.read(|s| s.devices.iter().find(|d| d.id == device_id).cloned())
    }

    pub fn devices(&self) -> Vec<DeviceRecord> {
        self.read(|s| s.devices.clone())
    }

    /// Which device a token belongs to. Every stored hash is compared in
    /// constant time, so timing says nothing about which one nearly matched.
    pub fn authenticate(&self, token: &str) -> Auth {
        let hash = pairing::hash_token(token);
        self.read(|s| {
            let mut found = None;
            for d in &s.devices {
                if pairing::constant_time_eq(d.token_hash.as_bytes(), hash.as_bytes()) {
                    found = Some(d.clone());
                }
            }
            if let Some(d) = found {
                return Auth::Device(d);
            }
            let revoked = s.revoked.iter().fold(false, |acc, r| {
                acc | pairing::constant_time_eq(r.as_bytes(), hash.as_bytes())
            });
            if revoked {
                Auth::Revoked
            } else {
                Auth::Unknown
            }
        })
    }

    /// Paired phones that look like `device` pairing again: what the desk
    /// offers to replace.
    pub fn same_phones(&self, device: &PairDevice) -> Vec<DeviceRecord> {
        let device = clean_pair_device(device);
        self.read(|s| {
            s.devices
                .iter()
                .filter(|d| d.same_phone(&device))
                .cloned()
                .collect()
        })
    }

    /// Record an allowed phone and mint its token. Only the phones named in
    /// `replace` (ids the desk showed, and the person there chose to
    /// replace) are revoked; returns their ids so their sockets can close.
    pub fn add(
        &self,
        device: &PairDevice,
        public_key: String,
        now: i64,
        replace: &[String],
        tailnet_login: Option<String>,
    ) -> Result<(DeviceRecord, String, Vec<String>), CommandError> {
        // No phone without a key: one made after it would reset it.
        self.kept();
        let token = pairing::new_token();
        let device = clean_pair_device(device);
        let record = DeviceRecord {
            id: format!("dev_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]),
            name: device.name.clone(),
            platform: device.platform,
            model: device.model.clone(),
            app_version: device.app_version.clone(),
            build: device.build,
            paired_at: now,
            last_seen_at: None,
            last_route: None,
            expires_at: None,
            token_hash: pairing::hash_token(&token),
            public_key: public_key.chars().take(128).collect(),
            push: None,
            tailnet_login,
        };
        let replaced = self.write(|s| {
            let (old, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut s.devices)
                .into_iter()
                .partition(|d| replace.contains(&d.id));
            s.devices = keep;
            for d in &old {
                remember_revoked(s, d.token_hash.clone());
            }
            s.devices.push(record.clone());
            old.into_iter().map(|d| d.id).collect::<Vec<_>>()
        })?;
        Ok((record, token, replaced))
    }

    /// Forget a device. Returns it, if it was there.
    pub fn revoke(&self, device_id: &str) -> Result<Option<DeviceRecord>, CommandError> {
        self.write(|s| {
            let index = s.devices.iter().position(|d| d.id == device_id)?;
            let gone = s.devices.remove(index);
            remember_revoked(s, gone.token_hash.clone());
            Some(gone)
        })
    }

    /// Last seen, over which route. Persisted only when asked (connect and
    /// disconnect), not on every frame.
    pub fn touch(&self, device_id: &str, now: i64, route: RouteKind, persist: bool) {
        let apply = |s: &mut Stored| {
            if let Some(d) = s.devices.iter_mut().find(|d| d.id == device_id) {
                d.last_seen_at = Some(now);
                d.last_route = Some(route);
            }
        };
        if persist {
            if let Err(e) = self.write(apply) {
                tracing::warn!("[Companion] Could not save last seen: {}", e);
            }
        } else {
            apply(&mut self.lock());
        }
    }
}

fn new_server_id() -> String {
    format!("srv_{}", &uuid::Uuid::new_v4().simple().to_string()[..16])
}

fn remember_revoked(s: &mut Stored, hash: String) {
    s.revoked.push(hash);
    let excess = s.revoked.len().saturating_sub(REVOKED_KEPT);
    s.revoked.drain(..excess);
}

// ============================================================================
// The companion: everything a connection needs
// ============================================================================

/// The socket id at the end of a [`Companion::label`].
fn conn_of_label(label: &str) -> Option<u64> {
    label.rsplit(':').next().and_then(|n| n.parse::<u64>().ok())
}

#[derive(Debug, Clone)]
struct Conn {
    device_id: String,
    foreground: bool,
    /// When `foreground` last changed (ms), for [`Companion::presence`].
    since: u64,
    /// The agent whose chat this socket has open (`agents.focus`).
    showing: Option<String>,
}

pub struct Companion {
    pub registry: Registry,
    pub hub: hub::Hub,
    pub pairing: pairing::Pairing,
    pub backend: Arc<dyn router::Backend>,
    pub sends: router::SendCache,
    pub blobs: blobs::Blobs,
    pub push: push::Push,
    /// The live notifier's burst cap (`alerts`).
    pub alerts: alerts::Alerts,
    conns: Mutex<HashMap<u64, Conn>>,
    /// A phone came to the foreground: the projects watch wakes (it sleeps
    /// without a timer while no phone is looking).
    pub foreground_changed: tokio::sync::Notify,
    next_conn: AtomicU64,
    requests: Mutex<HashMap<String, VecDeque<u64>>>,
    creates: Mutex<HashMap<String, VecDeque<u64>>>,
    last_status: Mutex<Option<wire::MacStatus>>,
    /// Requests in flight per source (`limits::source_of`).
    pub sources: limits::Counter,
    /// Sockets per source that haven't said a good hello yet.
    pub prehello: limits::Counter,
    /// Uploads in flight per device.
    pub uploads: limits::Counter,
    /// `agents.memorySuggest` runs in flight (one key: all phones).
    pub suggests: limits::Counter,
    /// Failed connections, folded to a line a minute per source.
    pub refusals: limits::RefusalLog,
    /// Thumbnails decoding now, and the ones already made.
    pub thumbs: files::Thumbs,
    /// "Watch live" links and sessions (`watch`).
    pub watch: watch::Watch,
}

impl Companion {
    pub fn new(registry: Registry, backend: Arc<dyn router::Backend>) -> Self {
        Self::with_epoch(registry, backend, uuid::Uuid::new_v4().simple().to_string())
    }

    /// With a known journal epoch (tests and fixtures).
    pub fn with_epoch(
        registry: Registry,
        backend: Arc<dyn router::Backend>,
        epoch: String,
    ) -> Self {
        // Staged files live beside companion.json; an in-memory registry
        // (tests) gets a temporary folder that goes with it.
        let blobs = match registry.path.as_ref().and_then(|p| p.parent()) {
            Some(dir) => blobs::Blobs::new(dir.join("companion-blobs")),
            None => blobs::Blobs::temporary(),
        };
        Companion {
            registry,
            blobs,
            hub: hub::Hub::new(epoch),
            pairing: pairing::Pairing::default(),
            backend,
            sends: router::SendCache::default(),
            push: push::Push::default(),
            alerts: alerts::Alerts::default(),
            conns: Mutex::new(HashMap::new()),
            foreground_changed: tokio::sync::Notify::new(),
            next_conn: AtomicU64::new(1),
            requests: Mutex::new(HashMap::new()),
            creates: Mutex::new(HashMap::new()),
            last_status: Mutex::new(None),
            sources: limits::Counter::default(),
            prehello: limits::Counter::default(),
            uploads: limits::Counter::default(),
            suggests: limits::Counter::default(),
            refusals: limits::RefusalLog::default(),
            thumbs: files::Thumbs::default(),
            watch: watch::Watch::default(),
        }
    }

    /// A connection that failed to authenticate, for the audit log: the
    /// first from a source in a minute is written now, the rest as a count
    /// once the minute is over ([`Companion::flush_refusals`]).
    pub fn note_refused(&self, source: &str, what: &str) {
        for line in self.refusals.note(source, what, now_ms()) {
            self.backend.audit("Phone", "refused", line, false);
        }
    }

    /// Write the counts for minutes of failures that have ended.
    pub fn flush_refusals(&self) {
        for line in self.refusals.flush(now_ms()) {
            self.backend.audit("Phone", "refused", line, false);
        }
    }

    /// Keep the latest Mac status; true when it differs from the last one.
    pub fn remember_status(&self, status: &wire::MacStatus) -> bool {
        let mut last = self.last_status.lock().unwrap_or_else(|e| e.into_inner());
        if last.as_ref() == Some(status) {
            return false;
        }
        *last = Some(status.clone());
        true
    }

    /// The Mac status last sent, if any.
    pub fn last_status(&self) -> Option<wire::MacStatus> {
        self.last_status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn conns(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Conn>> {
        self.conns.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Admit a socket for `device_id`, within the per-device and total caps.
    ///
    /// A phone at its own cap gets in, and its oldest socket goes. A phone
    /// that changes network (Wi-Fi to cellular, a lift, a tunnel) leaves
    /// sockets the Mac can't tell are dead: writes into a vanished TCP peer
    /// succeed for minutes. After four such hops the phone was refused with
    /// "Too many connections from this phone. Close the app and try again",
    /// which closing the app couldn't fix, until the dead ones timed out.
    /// The token proved it is the same phone, and its newest socket is the
    /// one it is using; the cap still bounds what one phone can hold.
    pub fn open_conn(&self, device_id: &str, foreground: bool) -> Option<u64> {
        let mut conns = self.conns();
        let mine: Vec<u64> = conns
            .iter()
            .filter(|(_, c)| c.device_id == device_id)
            .map(|(id, _)| *id)
            .collect();
        if mine.len() >= MAX_SOCKETS_PER_DEVICE {
            // Ids only grow: the smallest is the oldest.
            let oldest = mine.into_iter().min()?;
            conns.remove(&oldest);
            self.hub.signal(hub::HubItem::Replaced { conn: oldest });
        } else if conns.len() >= MAX_SOCKETS {
            return None;
        }
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        conns.insert(
            id,
            Conn {
                device_id: device_id.to_string(),
                foreground,
                since: now_ms(),
                showing: None,
            },
        );
        if foreground {
            self.foreground_changed.notify_one();
        }
        Some(id)
    }

    pub fn close_conn(&self, conn: u64) {
        self.conns().remove(&conn);
    }

    pub fn set_foreground(&self, conn: u64, foreground: bool) {
        if let Some(c) = self.conns().get_mut(&conn) {
            if c.foreground != foreground {
                c.foreground = foreground;
                c.since = now_ms();
                if foreground {
                    self.foreground_changed.notify_one();
                }
            }
        }
    }

    /// Whether a phone can see changes itself, for deciding on a push.
    pub fn presence(&self, device_id: &str) -> push::Presence {
        let conns = self.conns();
        let mine: Vec<&Conn> = conns
            .values()
            .filter(|c| c.device_id == device_id)
            .collect();
        if mine.iter().any(|c| c.foreground) {
            push::Presence::Foreground
        } else if let Some(since) = mine.iter().map(|c| c.since).max() {
            push::Presence::Background { since }
        } else {
            push::Presence::Away
        }
    }

    /// Some phone has the app open: worth watching the projects for.
    pub fn any_foreground(&self) -> bool {
        self.conns().values().any(|c| c.foreground)
    }

    pub fn is_connected(&self, device_id: &str) -> bool {
        self.conns().values().any(|c| c.device_id == device_id)
    }

    /// The `notify::set_showing` label for one socket. Per socket rather than
    /// per device, so a stale socket closing can't clear a newer one's chat.
    pub fn label(device_id: &str, conn: u64) -> String {
        format!("companion:{device_id}:{conn}")
    }

    /// Whether the socket behind `label` is open with the app in front:
    /// only then does a chat on the phone count as on screen.
    pub fn label_on_screen(&self, label: &str) -> bool {
        let Some(conn) = conn_of_label(label) else {
            return false;
        };
        self.conns().get(&conn).is_some_and(|c| c.foreground)
    }

    /// `agents.focus` on the socket behind `label`: the chat it has open.
    pub fn set_showing(&self, label: &str, agent_id: Option<String>) {
        let Some(conn) = conn_of_label(label) else {
            return;
        };
        if let Some(c) = self.conns().get_mut(&conn) {
            c.showing = agent_id;
        }
    }

    /// The socket behind `label` is in front with `agent_id`'s chat open:
    /// it sees that agent's news itself, so it gets no alert for it.
    pub fn in_front_of(&self, label: &str, agent_id: &str) -> bool {
        let Some(conn) = conn_of_label(label) else {
            return false;
        };
        self.conns()
            .get(&conn)
            .is_some_and(|c| c.foreground && c.showing.as_deref() == Some(agent_id))
    }

    /// Paired devices, with whether each is connected now.
    pub fn device_views(&self) -> Vec<Device> {
        self.registry
            .devices()
            .iter()
            .map(|d| d.view(self.is_connected(&d.id)))
            .collect()
    }

    /// Sliding-minute rate limit per device.
    pub fn allow_request(&self, device_id: &str, now: u64) -> bool {
        within_minute(&self.requests, device_id, now, MAX_REQUESTS_PER_MINUTE)
    }

    /// One more agent created from `device_id`, if it's under
    /// `MAX_AGENTS_CREATED_PER_MINUTE` in the last minute.
    pub fn allow_create(&self, device_id: &str, now: u64) -> bool {
        within_minute(&self.creates, device_id, now, MAX_AGENTS_CREATED_PER_MINUTE)
    }

    /// Revoke at the Mac: the token stops working and its sockets close now.
    pub fn revoke(&self, device_id: &str) -> Result<Option<DeviceRecord>, CommandError> {
        let gone = self.registry.revoke(device_id)?;
        if let Some(d) = &gone {
            self.blobs.forget_device(&d.id);
            self.watch.forget_device(&d.id);
            self.forget_push_later(d);
            self.hub.signal(hub::HubItem::Revoked {
                device_id: d.id.clone(),
            });
            self.backend.audit(
                &actor_for(&d.name),
                "revoked",
                "removed on this Mac".into(),
                true,
            );
            self.backend.changed();
        }
        Ok(gone)
    }

    /// A removed phone's token comes off the relay too, in the background.
    pub fn forget_push_later(&self, device: &DeviceRecord) {
        if device.push.as_ref().is_some_and(|t| t.registered) {
            if let Some(c) = desktop::get() {
                let device = device.clone();
                tauri::async_runtime::spawn(async move { push::forget_device(&c, &device).await });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone(name: &str) -> PairDevice {
        PairDevice {
            name: name.into(),
            platform: DevicePlatform::Ios,
            model: Some("iPhone 16".into()),
            app_version: "1.0.0".into(),
            build: BuildKind::Official,
        }
    }

    #[test]
    fn tokens_authenticate_and_only_their_hash_is_stored() {
        let r = Registry::in_memory();
        let (record, token, replaced) = r.add(&phone("A"), "pk".into(), 1, &[], None).unwrap();
        assert!(replaced.is_empty());
        assert_ne!(record.token_hash, token);
        let stored = serde_json::to_string(&r.read(|s| s.clone())).unwrap();
        assert!(
            !stored.contains(&token),
            "the token itself is never written"
        );
        assert!(matches!(r.authenticate(&token), Auth::Device(d) if d.id == record.id));
        assert!(matches!(r.authenticate("nope"), Auth::Unknown));
    }

    #[test]
    fn revoking_turns_the_token_into_revoked() {
        let r = Registry::in_memory();
        let (record, token, _) = r.add(&phone("A"), String::new(), 1, &[], None).unwrap();
        assert!(r.revoke(&record.id).unwrap().is_some());
        assert!(matches!(r.authenticate(&token), Auth::Revoked));
        assert!(r.revoke(&record.id).unwrap().is_none(), "already gone");
    }

    #[test]
    fn a_look_alike_phone_replaces_another_only_when_the_desk_says_so() {
        let r = Registry::in_memory();
        let (first, old_token, _) = r.add(&phone("A"), String::new(), 1, &[], None).unwrap();
        r.add(&phone("B"), String::new(), 2, &[], None).unwrap();
        // Same name, platform and model: offered for replacing, nothing more.
        let offered = r.same_phones(&phone("A"));
        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0].id, first.id);
        let (kept_both, both_token, replaced) =
            r.add(&phone("A"), String::new(), 3, &[], None).unwrap();
        assert!(replaced.is_empty(), "never silently");
        assert_eq!(r.devices().len(), 3);
        assert!(matches!(r.authenticate(&old_token), Auth::Device(_)));
        // The desk chose to replace the first one.
        let (second, new_token, replaced) = r
            .add(&phone("A"), String::new(), 4, &[first.id.clone()], None)
            .unwrap();
        assert_eq!(replaced, vec![first.id.clone()]);
        assert_eq!(r.devices().len(), 3);
        assert!(matches!(r.authenticate(&old_token), Auth::Revoked));
        assert!(matches!(r.authenticate(&new_token), Auth::Device(d) if d.id == second.id));
        assert!(matches!(r.authenticate(&both_token), Auth::Device(d) if d.id == kept_both.id));
    }

    #[test]
    fn device_names_lose_invisible_and_control_characters() {
        // U+202E flips what follows; U+200B and U+FEFF are invisible.
        let spoof = "Julian\u{2019}s iP\u{200B}hone\u{202E}enohp\u{FEFF}\n\tX";
        assert_eq!(
            clean_device_text(spoof, MAX_DEVICE_NAME_CHARS).unwrap(),
            "Julian\u{2019}s iPhoneenohp X"
        );
        assert_eq!(clean_device_text("\u{202E}\u{200D} ", 40), None);
        assert_eq!(clean_device_text(&"a".repeat(500), 40).unwrap().len(), 40);
        let stored = r_with(&PairDevice {
            name: "\u{202E}Evil\u{2066}".into(),
            model: Some("iPhone\u{0007} 16".into()),
            ..phone("x")
        });
        assert_eq!(stored.name, "Evil");
        assert_eq!(stored.model.as_deref(), Some("iPhone 16"));
        let blank = r_with(&PairDevice {
            name: "\u{200B}".into(),
            ..phone("x")
        });
        assert_eq!(blank.name, "Unnamed phone");
    }

    fn r_with(d: &PairDevice) -> DeviceRecord {
        Registry::in_memory()
            .add(d, String::new(), 1, &[], None)
            .unwrap()
            .0
    }

    #[test]
    fn a_token_paired_by_one_tailnet_user_refuses_another() {
        let r = Registry::in_memory();
        let (rec, _, _) = r
            .add(&phone("A"), String::new(), 1, &[], Some("j@x.com".into()))
            .unwrap();
        assert!(rec.login_matches(Some("J@x.com")));
        assert!(
            !rec.login_matches(None),
            "paired by a user: a request naming nobody is refused, token or not"
        );
        assert!(!rec.login_matches(Some("someone@else.com")));
        let (anon, _, _) = r.add(&phone("B"), String::new(), 1, &[], None).unwrap();
        assert!(anon.login_matches(Some("anyone@x.com")));
    }

    use keystore::Memory;
    use std::sync::atomic::Ordering;

    fn with_keys(path: &std::path::Path, keys: &Arc<Memory>) -> Registry {
        Registry::load_with(path.to_path_buf(), Box::new(keys.clone()))
    }

    fn fingerprint(r: &Registry) -> String {
        r.identity().unwrap().fingerprint()
    }

    #[test]
    fn the_identity_key_is_made_once_and_kept_in_the_keychain_not_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("companion.json");
        let keys = Arc::new(Memory::default());
        let r = with_keys(&path, &keys);
        assert!(
            keys.key.lock().unwrap().is_none(),
            "not made until it's needed"
        );
        let first = fingerprint(&r);
        assert!(r.identity_is_durable());
        assert_eq!(fingerprint(&with_keys(&path, &keys)), first);
        assert!(keys.key.lock().unwrap().is_some());
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("identityKey"), "never in companion.json");
    }

    #[test]
    fn a_key_in_the_old_file_moves_to_the_keychain_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("companion.json");
        let (old, doc) = identity::Identity::generate().unwrap();
        let stored = Stored {
            server_id: "srv_old".into(),
            identity_key: doc.clone(),
            ..Stored::default()
        };
        std::fs::write(&path, serde_json::to_string(&stored).unwrap()).unwrap();

        // The Keychain refuses the move: the key is kept where it was.
        let refusing = Arc::new(Memory::default());
        refusing.fail_save.store(true, Ordering::SeqCst);
        let r = with_keys(&path, &refusing);
        assert_eq!(fingerprint(&r), old.fingerprint());
        assert!(r.identity_is_durable(), "still in the file, so still kept");
        assert!(std::fs::read_to_string(&path).unwrap().contains(&doc));

        // It takes it: moved, and the file's copy is gone.
        let keys = Arc::new(Memory::default());
        let r = with_keys(&path, &keys);
        assert_eq!(fingerprint(&r), old.fingerprint());
        assert_eq!(keys.key.lock().unwrap().as_deref(), Some(doc.as_str()));
        assert!(!std::fs::read_to_string(&path).unwrap().contains(&doc));
        assert_eq!(r.server_id(), "srv_old", "the same Mac");
        assert_eq!(fingerprint(&with_keys(&path, &keys)), old.fingerprint());
    }

    #[test]
    fn a_keychain_that_wont_answer_never_means_a_new_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("companion.json");
        let keys = Arc::new(Memory::default());
        let r = with_keys(&path, &keys);
        let first = fingerprint(&r);
        r.add(&phone("A"), String::new(), 1, &[], None).unwrap();

        keys.fail_load.store(true, Ordering::SeqCst);
        let locked = with_keys(&path, &keys);
        assert!(locked.identity().is_none(), "nothing to prove with");
        assert!(!locked.identity_is_durable());
        assert_eq!(locked.devices().len(), 1, "and nobody removed");
        // Unlocked: the same key, asked again rather than remembered as missing.
        keys.fail_load.store(false, Ordering::SeqCst);
        assert_eq!(fingerprint(&locked), first);
    }

    #[test]
    fn a_lost_key_with_phones_paired_starts_this_mac_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("companion.json");
        let keys = Arc::new(Memory::default());
        let r = with_keys(&path, &keys);
        let first = fingerprint(&r);
        let server_id = r.server_id();
        let (_, token, _) = r.add(&phone("A"), String::new(), 1, &[], None).unwrap();

        // The key is gone (the item was deleted): a new one, a new id, and
        // the phones that pinned the old key are removed.
        *keys.key.lock().unwrap() = None;
        let again = with_keys(&path, &keys);
        assert_ne!(fingerprint(&again), first);
        assert_ne!(again.server_id(), server_id);
        assert!(again.devices().is_empty());
        assert!(matches!(again.authenticate(&token), Auth::Revoked));
        // Kept, so the next launch is the same Mac again.
        let next = with_keys(&path, &keys);
        assert_eq!(fingerprint(&next), fingerprint(&again));
        assert_eq!(next.server_id(), again.server_id());
    }

    #[test]
    fn a_key_the_keychain_wont_keep_is_never_offered_for_pairing() {
        let keys = Arc::new(Memory::default());
        keys.fail_save.store(true, Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        let r = with_keys(&dir.path().join("companion.json"), &keys);
        assert!(
            r.identity().is_some(),
            "it can still answer for this launch"
        );
        assert!(!r.identity_is_durable());
    }

    #[test]
    fn the_registry_file_is_owner_only_and_survives_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("companion.json");
        let keys = Arc::new(Memory::default());
        let r = with_keys(&path, &keys);
        let server_id = r.server_id();
        let (record, token, _) = r.add(&phone("A"), String::new(), 1, &[], None).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let again = with_keys(&path, &keys);
        assert_eq!(again.server_id(), server_id, "the server id is stable");
        assert!(matches!(again.authenticate(&token), Auth::Device(d) if d.id == record.id));
    }

    #[test]
    fn revoked_hashes_are_bounded() {
        let mut s = Stored::default();
        for i in 0..(REVOKED_KEPT + 10) {
            remember_revoked(&mut s, i.to_string());
        }
        assert_eq!(s.revoked.len(), REVOKED_KEPT);
        assert_eq!(s.revoked.last().unwrap(), &(REVOKED_KEPT + 9).to_string());
    }
}
