//! The native messaging host: the small program Chrome starts when the
//! extension connects, which joins Chrome's pipe to the app's socket.
//!
//! It is the app's own binary, started by Chrome with the extension's
//! origin as its first argument (`main.rs` checks for that before anything
//! else and runs [`run`] instead of the app). One signed binary, nothing
//! extra to install or keep up to date.
//!
//! What it does, in order:
//!
//! 1. Refuses any origin but the app's extension (Chrome already only starts
//!    it for the ids in its manifest; this is the second check).
//! 2. Reads the link's token (0600, this user's) and connects to the socket
//!    (on Windows the pipe, checked to be served by this user, opened so
//!    the app can identify the host but never act as it).
//!    If the app isn't running it tells the extension so
//!    ([`ToExtension::Unavailable`]) and exits, and the extension backs off.
//! 3. The handshake: the app proves the token first, then the host does.
//! 4. Relays frames both ways, unchanged, until either side closes. It never
//!    reads what it relays beyond each frame's length, and never sends
//!    Chrome a frame over Chrome's 1 MiB limit.

use std::io::{self, Read, Write};
use std::path::Path;
use std::time::Duration;

#[cfg(windows)]
pub use pipe::PipeStream as LinkStream;
#[cfg(unix)]
pub use std::os::unix::net::UnixStream as LinkStream;

use super::auth;
use super::frame::{self, FrameError, MAX_FROM_CHROME, MAX_TO_CHROME};
use super::protocol::{Handshake, ToExtension, PROTOCOL};

/// Chrome's argument naming the extension that started the host.
pub fn origin_arg(args: &[String]) -> Option<&str> {
    args.get(1)
        .map(String::as_str)
        .filter(|a| a.starts_with("chrome-extension://"))
}

/// When the process was started by Chrome as the native host, run as the
/// host and return its exit code; otherwise `None` and the app starts.
pub fn from_argv() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    origin_arg(&args)?;
    Some(run(&args))
}

/// The host, start to end. Exit code 0 when it ran (or told the extension
/// why it couldn't), 1 when it refused to run.
pub fn run(args: &[String]) -> i32 {
    let Some(origin) = origin_arg(args) else {
        eprintln!("not started by Chrome");
        return 1;
    };
    if !auth::extension_allowed(origin) {
        eprintln!("not this app's extension: {origin}");
        return 1;
    }
    let dir = auth::link_dir();
    let mut stdout = io::stdout();
    let mut stdin = io::stdin();
    trace(&dir, &format!("started for {origin}"));
    match connect(&dir, origin) {
        Ok(stream) => {
            trace(&dir, "linked to the app");
            match relay(stream, &mut stdin, &mut stdout, true) {
                Ok(()) => 0,
                Err(e) => {
                    trace(&dir, &format!("relay ended: {e}"));
                    0
                }
            }
        }
        Err(reason) => {
            trace(&dir, &format!("no link: {reason}"));
            tell(&mut stdout, reason);
            0
        }
    }
}

/// Debug builds: a line in `host.log` beside the socket (Chrome throws a
/// host's stderr away). Release builds write nothing.
fn trace(dir: &Path, line: &str) {
    #[cfg(debug_assertions)]
    {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("host.log"))
        {
            let _ = writeln!(f, "{} {line}", std::process::id());
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (dir, line);
}

/// Tell the extension why there's no link.
fn tell<W: Write>(out: &mut W, reason: &str) {
    if let Ok(body) = serde_json::to_vec(&ToExtension::Unavailable {
        reason: reason.into(),
    }) {
        let _ = frame::write(out, &body, MAX_TO_CHROME);
    }
}

/// Connect and handshake. `Err`: the reason the extension is told.
pub fn connect(dir: &Path, origin: &str) -> Result<LinkStream, &'static str> {
    let token = auth::read_token(dir).map_err(|_| "app_not_running")?;
    #[cfg(unix)]
    let stream = LinkStream::connect(auth::socket_path(dir)).map_err(|_| "app_not_running")?;
    #[cfg(windows)]
    let stream = LinkStream::connect(&auth::pipe_name(dir)).map_err(|_| "app_not_running")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| "app_not_running")?;
    let stream = handshake(stream, &token, origin)?;
    stream
        .set_read_timeout(None)
        .map_err(|_| "app_not_running")?;
    Ok(stream)
}

fn send<W: Write>(w: &mut W, h: &Handshake) -> Result<(), &'static str> {
    let body = serde_json::to_vec(h).map_err(|_| "refused")?;
    frame::write(w, &body, MAX_TO_CHROME).map_err(|_| "app_not_running")
}

fn recv<R: Read>(r: &mut R) -> Result<Handshake, &'static str> {
    let body = frame::read(r, 4096).map_err(|_| "app_not_running")?;
    serde_json::from_slice(&body).map_err(|_| "refused")
}

/// The host's half of the handshake.
pub fn handshake(mut s: LinkStream, token: &str, origin: &str) -> Result<LinkStream, &'static str> {
    let host_nonce = auth::nonce();
    send(
        &mut s,
        &Handshake::HostHello {
            v: PROTOCOL,
            origin: origin.into(),
            host_nonce: host_nonce.clone(),
        },
    )?;
    let Handshake::AppChallenge { app_nonce, proof } = recv(&mut s)? else {
        return Err("refused");
    };
    if !auth::nonce_ok(&app_nonce) || !auth::check_app(token, &host_nonce, &app_nonce, &proof) {
        // Whoever is on the socket doesn't hold the token: not the app.
        return Err("refused");
    }
    send(
        &mut s,
        &Handshake::HostProof {
            proof: auth::host_proof(token, &app_nonce, &host_nonce),
        },
    )?;
    match recv(&mut s)? {
        Handshake::Ready => Ok(s),
        _ => Err("refused"),
    }
}

/// Frames both ways until either side closes.
/// `exit_with_app`: when the app closes its side, the process exits (the
/// real host; Chrome then sees the port close and the extension reconnects
/// later). Tests leave it off and close Chrome's side themselves.
pub fn relay<R: Read, W: Write + Send>(
    stream: LinkStream,
    from_chrome: &mut R,
    to_chrome: &mut W,
    exit_with_app: bool,
) -> io::Result<()> {
    let mut to_app = stream.try_clone()?;
    let mut from_app = stream;
    std::thread::scope(|scope| {
        // App → Chrome, on its own thread.
        let back = scope.spawn(move || -> io::Result<()> {
            let ended = loop {
                match frame::read(&mut from_app, MAX_TO_CHROME) {
                    Ok(body) => {
                        if let Err(e) = frame::write(to_chrome, &body, MAX_TO_CHROME) {
                            break Err(e);
                        }
                    }
                    Err(FrameError::Closed) => break Ok(()),
                    Err(e) => break Err(io::Error::other(e.to_string())),
                }
            };
            if exit_with_app {
                let _ = to_chrome.flush();
                std::process::exit(0);
            }
            ended
        });
        // Chrome → app, here. Chrome closing stdin ends the host.
        let forward = loop {
            match frame::read(from_chrome, MAX_FROM_CHROME) {
                Ok(body) => {
                    if let Err(e) = frame::write(&mut to_app, &body, MAX_FROM_CHROME) {
                        break Err(e);
                    }
                }
                Err(FrameError::Closed) => break Ok(()),
                Err(e) => break Err(io::Error::other(e.to_string())),
            }
        };
        let _ = to_app.shutdown(std::net::Shutdown::Both);
        let _ = back.join();
        forward
    })
}

/// Windows: the link's pipe as a blocking stream, for the host's two relay
/// threads. A synchronous pipe handle serialises every read and write on it
/// (one thread blocked reading would stop the other writing), so the pipe
/// is opened overlapped through tokio and each side's read or write is
/// driven on a one-thread runtime instead. Clones share the pipe; shutdown
/// ends every read with end-of-stream, so the relay's other thread stops.
#[cfg(windows)]
pub mod pipe {
    use std::io::{self, Read, Write};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
    use tokio_util::sync::CancellationToken;

    use super::super::win;

    struct Shared {
        rt: tokio::runtime::Runtime,
        pipe: NamedPipeClient,
        closed: CancellationToken,
        read_timeout: Mutex<Option<Duration>>,
    }

    pub struct PipeStream(Arc<Shared>);

    impl PipeStream {
        /// Open the app's pipe `name`: retried while every instance is busy
        /// for a moment, and refused unless the app serving it runs as this
        /// user.
        pub fn connect(name: &str) -> io::Result<PipeStream> {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()?;
            let pipe = {
                let _enter = rt.enter();
                let mut tries = 0;
                loop {
                    match ClientOptions::new()
                        .security_qos_flags(win::SECURITY_IDENTIFICATION)
                        .open(name)
                    {
                        Ok(p) => break p,
                        Err(e) if e.raw_os_error() == Some(win::ERROR_PIPE_BUSY) && tries < 50 => {
                            tries += 1;
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        Err(e) => return Err(e),
                    }
                }
            };
            if !win::peer_is_this_user(&pipe, false) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "the link's pipe isn't served by this user",
                ));
            }
            Ok(PipeStream(Arc::new(Shared {
                rt,
                pipe,
                closed: CancellationToken::new(),
                read_timeout: Mutex::new(None),
            })))
        }

        pub fn try_clone(&self) -> io::Result<PipeStream> {
            Ok(PipeStream(self.0.clone()))
        }

        pub fn set_read_timeout(&self, t: Option<Duration>) -> io::Result<()> {
            *self
                .0
                .read_timeout
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = t;
            Ok(())
        }

        /// Every read, now and later, ends as end-of-stream.
        pub fn shutdown(&self, _how: std::net::Shutdown) -> io::Result<()> {
            self.0.closed.cancel();
            Ok(())
        }
    }

    impl Read for PipeStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let s = &self.0;
            let wait = *s.read_timeout.lock().unwrap_or_else(|e| e.into_inner());
            s.rt.block_on(async {
                let read = async {
                    loop {
                        s.pipe.readable().await?;
                        match s.pipe.try_read(buf) {
                            Ok(n) => return Ok(n),
                            Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                            // The app closed its end: the end of the stream.
                            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => return Ok(0),
                            Err(e) => return Err(e),
                        }
                    }
                };
                let read = async {
                    match wait {
                        Some(w) => tokio::time::timeout(w, read)
                            .await
                            .unwrap_or_else(|_| Err(io::ErrorKind::TimedOut.into())),
                        None => read.await,
                    }
                };
                tokio::select! {
                    _ = s.closed.cancelled() => Ok(0),
                    r = read => r,
                }
            })
        }
    }

    impl Write for PipeStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let s = &self.0;
            if s.closed.is_cancelled() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            s.rt.block_on(async {
                loop {
                    s.pipe.writable().await?;
                    match s.pipe.try_write(buf) {
                        Ok(n) => return Ok(n),
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                        Err(e) => return Err(e),
                    }
                }
            })
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
