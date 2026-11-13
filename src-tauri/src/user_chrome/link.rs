//! The app's end of the link: a Unix socket in the app's own folder (a
//! named pipe on Windows), the handshake with each native host Chrome
//! starts, and the connections that come out of it, one per Chrome profile
//! the extension is in.
//!
//! A Unix socket or a named pipe, never a TCP port: nothing on the network,
//! and nothing a web page can reach (no DNS rebinding, no `fetch` to
//! localhost). The socket is 0600 in a 0700 folder; the pipe admits only
//! this user's SID and no remote clients (`win`); every peer is checked to
//! run as this user, and each side still proves the token.
//!
//! Requests are blocking ([`Conn::call`]): the tools run on a blocking
//! thread, like the agents' browser's. The socket itself is read and
//! written on the async runtime.

use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc as tmpsc;

use super::auth;
use super::frame::{tokio_io, FrameError, MAX_FROM_CHROME, MAX_TO_CHROME};
use super::protocol::{
    self, ErrorCode, ExtError, ExtEvent, FromExtension, Handshake, Op, ToExtension,
};

/// The handshake and the extension's hello must arrive within this.
pub const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);

/// Why a call didn't get an answer.
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// The link was already closed (Chrome quit, the extension was turned
    /// off or reloaded, the app stopped the link): nothing was sent.
    Gone,
    /// The link closed while the request was out (the extension's service
    /// worker stopped or restarted, Chrome quit): it may or may not have
    /// been carried out, and it is never sent again on its own.
    Interrupted,
    /// No answer in time. The request may still be carried out.
    Timeout,
    /// The extension answered with an error.
    Ext(ExtError),
    /// The request was too big for Chrome to take.
    TooBig,
}

impl CallError {
    /// The line an agent is told.
    pub fn line(&self) -> String {
        match self {
            CallError::Gone => "Chrome stopped answering (it was closed, or the extension was turned off). Ask the user to open Chrome, then try again.".into(),
            CallError::Interrupted => "The link to Chrome dropped while that step was running (Chrome or the app's extension restarted), so it may or may not have happened. Read the page before you try it again, and don't repeat anything that sends or posts without checking.".into(),
            CallError::Timeout => "Chrome didn't answer in time, and the step may still happen. Read the page before you try it again; if it keeps happening, the tab may be stuck.".into(),
            CallError::TooBig => "That was too much to send to Chrome at once.".into(),
            CallError::Ext(e) => match e.code {
                ErrorCode::NotOwned => "That tab isn't one you opened. Use `tabs` to see yours, or `open` a new one.".into(),
                ErrorCode::NoTab => "That tab is gone (it was closed). Use `tabs` to see yours, or `open` a new one.".into(),
                ErrorCode::AttachFailed => format!("Chrome wouldn't let the app drive that tab ({}). If DevTools is open on it, it has to be closed first.", e.message),
                ErrorCode::Protected => "Chrome doesn't let extensions use that page (Chrome's own pages and the Web Store). Use another page.".into(),
                ErrorCode::NotAllowed => format!("The extension refused that ({}).", e.message),
                ErrorCode::Busy => "Chrome hasn't finished your last click or key on that tab yet (it may not be painting the tab), so nothing more was sent. Read the page to see where it got to, then try again.".into(),
                _ => format!("Chrome said: {}", e.message),
            },
        }
    }
}

/// One Chrome profile's live link.
pub struct Conn {
    /// Unique for this run of the app.
    pub serial: u64,
    pub profile_id: String,
    pub profile_label: String,
    pub extension_version: String,
    pub protocol: u32,
    pub connected_at_ms: i64,
    /// Frames for the writer; taken (dropped) on close, so the writer sends
    /// what's queued (a Bye) and ends.
    tx: Mutex<Option<tmpsc::UnboundedSender<Vec<u8>>>>,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Result<Value, ExtError>>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    /// Wakes the reader, so a link the app closes ends its socket too.
    closing: tokio::sync::Notify,
}

impl Conn {
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Send `op` and wait for its answer. Blocking: never call it on the
    /// async runtime's own threads.
    pub fn call(&self, op: Op, wait: Duration) -> Result<Value, CallError> {
        if self.is_closed() {
            return Err(CallError::Gone);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body =
            serde_json::to_vec(&ToExtension::Req { id, op }).map_err(|_| CallError::TooBig)?;
        if body.len() > MAX_TO_CHROME {
            return Err(CallError::TooBig);
        }
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        if !self.push(body) {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(CallError::Gone);
        }
        let got = rx.recv_timeout(wait);
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        match got {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(CallError::Ext(e)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(CallError::Timeout),
            // Sent, and the link closed before an answer came back.
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(CallError::Interrupted),
        }
    }

    fn push(&self, body: Vec<u8>) -> bool {
        self.tx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|tx| tx.send(body).is_ok())
    }

    fn send(&self, msg: &ToExtension) {
        if let Ok(body) = serde_json::to_vec(msg) {
            let _ = self.push(body);
        }
    }

    /// An answer arrived.
    fn answer(&self, id: u64, outcome: Result<Value, ExtError>) {
        if let Some(tx) = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
        {
            let _ = tx.try_send(outcome);
        }
    }

    /// The link is gone: every waiting call hears so at once.
    /// The socket ends too, once what's queued is written.
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.tx.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.closing.notify_one();
    }
}

/// Something that wants to hear the extension's events (the tools' tab
/// bookkeeping).
pub type EventHook = fn(&Conn, &ExtEvent);

/// Every live connection.
#[derive(Default)]
pub struct Registry {
    conns: Mutex<Vec<Arc<Conn>>>,
    hook: OnceLock<EventHook>,
    serial: AtomicU64,
}

impl Registry {
    pub fn new() -> Arc<Registry> {
        Arc::new(Registry::default())
    }

    pub fn set_hook(&self, hook: EventHook) {
        let _ = self.hook.set(hook);
    }

    /// Live connections, newest first.
    pub fn conns(&self) -> Vec<Arc<Conn>> {
        let mut v: Vec<Arc<Conn>> = self
            .conns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|c| !c.is_closed())
            .cloned()
            .collect();
        v.sort_by(|a, b| b.serial.cmp(&a.serial));
        v
    }

    pub fn by_profile(&self, profile_id: &str) -> Option<Arc<Conn>> {
        self.conns()
            .into_iter()
            .find(|c| c.profile_id == profile_id)
    }

    /// Add a connection; one already there for the same profile (a reloaded
    /// extension, a restarted service worker) is told it was replaced.
    fn add(&self, c: Arc<Conn>) {
        let mut v = self.conns.lock().unwrap_or_else(|e| e.into_inner());
        for old in v.iter().filter(|o| o.profile_id == c.profile_id) {
            old.send(&ToExtension::Bye {
                reason: "replaced".into(),
            });
            old.close();
        }
        v.retain(|o| o.profile_id != c.profile_id && !o.is_closed());
        v.push(c);
    }

    fn remove(&self, serial: u64) {
        let mut v = self.conns.lock().unwrap_or_else(|e| e.into_inner());
        v.retain(|o| o.serial != serial);
    }

    /// Close every connection, saying why.
    pub fn close_all(&self, reason: &str) {
        let v: Vec<Arc<Conn>> =
            std::mem::take(&mut *self.conns.lock().unwrap_or_else(|e| e.into_inner()));
        for c in v {
            c.send(&ToExtension::Bye {
                reason: reason.into(),
            });
            c.close();
        }
    }
}

/* -------------------------------------------------------- the socket */

#[cfg(unix)]
/// Bind the link's socket in `dir`: 0600, a stale one from a crashed run
/// replaced, a live one (another copy of the app) left alone.
pub fn bind(dir: &Path) -> std::io::Result<(tokio::net::UnixListener, std::path::PathBuf)> {
    let path = auth::socket_path(dir);
    if path.as_os_str().len() > auth::MAX_SOCKET_PATH {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the link's folder path is too long for a socket",
        ));
    }
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        use std::os::unix::fs::FileTypeExt;
        if !meta.file_type().is_socket() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "something that isn't the link's socket is in its place",
            ));
        }
        if std::os::unix::net::UnixStream::connect(&path).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "another copy of the app holds the Chrome link",
            ));
        }
        std::fs::remove_file(&path)?;
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok((listener, path))
}

#[cfg(unix)]
/// Accept hosts for ever (until the task is aborted).
pub async fn serve(listener: tokio::net::UnixListener, token: String, registry: Arc<Registry>) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                if !same_user(&stream) {
                    tracing::warn!("[UserChrome] refused a connection from another user");
                    continue;
                }
                let (token, registry) = (token.clone(), registry.clone());
                tokio::spawn(async move {
                    if let Err(why) = handle(stream, &token, &registry).await {
                        tracing::info!(why, "[UserChrome] a link ended");
                    }
                });
            }
            Err(e) => {
                tracing::warn!(error = %e, "[UserChrome] accept failed");
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
}

#[cfg(unix)]
/// The peer runs as this user (the socket's mode already says so; this is
/// the second wall).
fn same_user(stream: &tokio::net::UnixStream) -> bool {
    match stream.peer_cred() {
        // SAFETY: getuid has no preconditions.
        Ok(c) => c.uid() == unsafe { libc::getuid() },
        Err(_) => false,
    }
}

#[cfg(windows)]
/// The link's pipe, ready for the next host: always one instance waiting,
/// so a host never finds the name gone between two connections.
pub struct Listener {
    name: String,
    security: super::win::PipeSecurity,
    next: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
}

#[cfg(windows)]
/// Claim the link's pipe for `dir`, admitting only this user. A name
/// already taken (another copy of the app, or anything squatting on it)
/// fails rather than shares: `first_pipe_instance`.
pub fn bind(dir: &Path) -> std::io::Result<(Listener, std::path::PathBuf)> {
    let name = auth::pipe_name(dir);
    let security = super::win::PipeSecurity::this_user_only()?;
    let first = super::win::create_pipe(&name, &security, true).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "another copy of the app holds the Chrome link",
            )
        } else {
            e
        }
    })?;
    Ok((
        Listener {
            name: name.clone(),
            security,
            next: Some(first),
        },
        std::path::PathBuf::from(name),
    ))
}

#[cfg(windows)]
/// Accept hosts for ever (until the task is aborted).
pub async fn serve(mut listener: Listener, token: String, registry: Arc<Registry>) {
    loop {
        let pipe = match listener.next.take() {
            Some(p) => p,
            None => match super::win::create_pipe(&listener.name, &listener.security, false) {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!(error = %e, "[UserChrome] couldn't open the pipe for the next host");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
            },
        };
        if let Err(e) = pipe.connect().await {
            tracing::warn!(error = %e, "[UserChrome] accept failed");
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        // The next instance before this one is handed off.
        listener.next = super::win::create_pipe(&listener.name, &listener.security, false).ok();
        if !super::win::peer_is_this_user(&pipe, true) {
            tracing::warn!("[UserChrome] refused a connection from another user");
            continue;
        }
        let (token, registry) = (token.clone(), registry.clone());
        tokio::spawn(async move {
            if let Err(why) = handle(pipe, &token, &registry).await {
                tracing::info!(why, "[UserChrome] a link ended");
            }
        });
    }
}

async fn read_json<R: AsyncRead + Unpin, T: serde::de::DeserializeOwned>(
    r: &mut R,
    max: usize,
) -> Result<T, String> {
    let body = tokio_io::read(r, max).await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|e| format!("not a message: {e}"))
}

async fn write_json<W: AsyncWrite + Unpin, T: serde::Serialize>(
    w: &mut W,
    v: &T,
) -> Result<(), String> {
    let body = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    tokio_io::write(w, &body, MAX_TO_CHROME)
        .await
        .map_err(|e| e.to_string())
}

/// The app's half of the handshake, on any stream. `Ok` once the host has
/// proved itself and been told Ready.
pub async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    token: &str,
) -> Result<String, String> {
    let hello: Handshake = read_json(s, 4096).await?;
    let Handshake::HostHello {
        v,
        origin,
        host_nonce,
    } = hello
    else {
        return Err("the host didn't say hello".into());
    };
    let refuse = |reason: &str| Handshake::Refused {
        reason: reason.into(),
    };
    if !protocol::supported(v) {
        let _ = write_json(s, &refuse("version")).await;
        return Err(format!("the host speaks protocol {v}"));
    }
    if !auth::extension_allowed(&origin) {
        let _ = write_json(s, &refuse("origin")).await;
        return Err(format!("not our extension: {origin}"));
    }
    if !auth::nonce_ok(&host_nonce) {
        let _ = write_json(s, &refuse("nonce")).await;
        return Err("a malformed nonce".into());
    }
    let app_nonce = auth::nonce();
    write_json(
        s,
        &Handshake::AppChallenge {
            proof: auth::app_proof(token, &host_nonce, &app_nonce),
            app_nonce: app_nonce.clone(),
        },
    )
    .await?;
    let Handshake::HostProof { proof } = read_json(s, 4096).await? else {
        return Err("the host didn't prove itself".into());
    };
    if !auth::check_host(token, &app_nonce, &host_nonce, &proof) {
        let _ = write_json(s, &refuse("proof")).await;
        return Err("the host's proof is wrong".into());
    }
    write_json(s, &Handshake::Ready).await?;
    Ok(origin)
}

/// One host's link, from handshake to close.
pub async fn handle<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    mut stream: S,
    token: &str,
    registry: &Arc<Registry>,
) -> Result<(), String> {
    tokio::time::timeout(HANDSHAKE_WAIT, handshake(&mut stream, token))
        .await
        .map_err(|_| "the handshake took too long".to_string())??;
    let hello: FromExtension =
        tokio::time::timeout(HANDSHAKE_WAIT, read_json(&mut stream, 64 * 1024))
            .await
            .map_err(|_| "the extension didn't say hello".to_string())??;
    let FromExtension::Hello {
        v,
        extension_version,
        profile_id,
        profile_label,
        ..
    } = hello
    else {
        return Err("the extension's first message wasn't hello".into());
    };
    if !protocol::supported(v) {
        let _ = write_json(
            &mut stream,
            &ToExtension::Bye {
                reason: "version".into(),
            },
        )
        .await;
        return Err(format!("the extension speaks protocol {v}"));
    }
    if profile_id.is_empty()
        || profile_id.len() > 64
        || !profile_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        let _ = write_json(
            &mut stream,
            &ToExtension::Bye {
                reason: "profile".into(),
            },
        )
        .await;
        return Err("a malformed profile id".into());
    }
    write_json(
        &mut stream,
        &ToExtension::Welcome {
            v: protocol::PROTOCOL,
            app_version: env!("CARGO_PKG_VERSION").into(),
        },
    )
    .await?;

    let (tx, mut rx) = tmpsc::unbounded_channel::<Vec<u8>>();
    let conn = Arc::new(Conn {
        serial: registry.serial.fetch_add(1, Ordering::SeqCst) + 1,
        profile_id,
        profile_label: profile_label.chars().take(60).collect(),
        extension_version: extension_version.chars().take(32).collect(),
        protocol: v,
        connected_at_ms: crate::agents::store::now_ms(),
        tx: Mutex::new(Some(tx)),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        closed: AtomicBool::new(false),
        closing: tokio::sync::Notify::new(),
    });
    registry.add(conn.clone());
    tracing::info!(
        profile = conn.profile_id,
        version = conn.extension_version,
        "[UserChrome] extension connected"
    );

    let (mut rd, mut wr) = tokio::io::split(stream);
    let writer = tokio::spawn(async move {
        while let Some(body) = rx.recv().await {
            if tokio_io::write(&mut wr, &body, MAX_TO_CHROME)
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let ended = loop {
        // The app closing the link (off, quit, replaced) ends the read too,
        // so the host sees the socket close and exits.
        let read = tokio::select! {
            r = tokio_io::read(&mut rd, MAX_FROM_CHROME) => r,
            _ = conn.closing.notified() => break "closed by the app".to_string(),
        };
        let body = match read {
            Ok(b) => b,
            Err(FrameError::Closed) => break "closed".to_string(),
            Err(e) => break e.to_string(),
        };
        if conn.is_closed() {
            break "replaced".into();
        }
        match serde_json::from_slice::<FromExtension>(&body) {
            Ok(FromExtension::Res {
                id,
                ok,
                result,
                error,
            }) => {
                let outcome = if ok {
                    Ok(result)
                } else {
                    Err(error.unwrap_or(ExtError {
                        code: ErrorCode::Internal,
                        message: "no reason given".into(),
                    }))
                };
                conn.answer(id, outcome);
            }
            Ok(FromExtension::Event { event }) => {
                if let Some(hook) = registry.hook.get() {
                    hook(&conn, &event);
                }
            }
            Ok(FromExtension::Hello { .. }) => {}
            Err(e) => tracing::warn!(error = %e, "[UserChrome] a message the app doesn't know"),
        }
    };
    conn.close();
    registry.remove(conn.serial);
    // The sender is gone: the writer flushes what's queued (a Bye) and ends.
    if tokio::time::timeout(Duration::from_secs(2), writer)
        .await
        .is_err()
    {
        tracing::info!("[UserChrome] a link's last frames didn't go out in time");
    }
    tracing::info!(
        profile = conn.profile_id,
        ended,
        "[UserChrome] extension disconnected"
    );
    Ok(())
}
