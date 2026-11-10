//! A watchdog for the two local servers everything else rides on: the
//! phone's companion server and the agent bridge.
//!
//! The night the app hung, both were accepting sockets and answering
//! nothing, and nothing said so: the log was quiet because the threads that
//! would have written to it were the ones stuck. This runs on a plain
//! thread of its own (never the async runtime it is watching), asks each
//! server for a path that doesn't exist every [`PERIOD`] over loopback, and
//! counts any HTTP answer at all as alive (a 404 still means the runtime
//! accepted, routed and answered). When one has given no answer for
//! [`STALL`], the log gets one loud error naming it and how long, where the
//! agents list's lock is held from, and the path of a `sample` of every
//! thread in the process (macOS's own profiler), so the next hang can be
//! read rather than guessed at. Once it answers again, that is logged too.
//!
//! A server that isn't running (no port, or the port refuses) is not a hang
//! and says nothing.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// How often each server is asked.
const PERIOD: Duration = Duration::from_secs(10);
/// How long one probe waits for an answer.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a server goes without answering before it's reported.
const STALL: Duration = Duration::from_secs(20);
/// At most one `sample` of the process in this long, whatever stalls.
const SAMPLE_EVERY: Duration = Duration::from_secs(600);

/// What a probe found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// Some HTTP answer came back.
    Answered,
    /// Connected (or tried to) and heard nothing in time.
    Silent,
    /// Nothing listening: off, not hung.
    NotRunning,
}

/// Ask the server on `port` for a path that doesn't exist, within `timeout`.
pub fn probe(port: u16, timeout: Duration) -> Probe {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => return Probe::NotRunning,
        // A full backlog (an accept loop that stopped) times out here.
        Err(_) => return Probe::Silent,
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    // A loopback Host and no Origin: both servers refuse anything else.
    let ask = "GET /watchdog HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(ask.as_bytes()).is_err() {
        return Probe::Silent;
    }
    let mut first = [0u8; 5];
    match stream.read_exact(&mut first) {
        Ok(()) if &first == b"HTTP/" => Probe::Answered,
        _ => Probe::Silent,
    }
}

/// What one server's run of probes adds up to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Silent for `for_` now: report it.
    Stalled { for_: Duration },
    /// Answering again after a stall that was reported.
    Recovered { after: Duration },
}

/// One server's state between probes.
#[derive(Debug, Default)]
pub struct Tracker {
    silent_since: Option<Instant>,
    reported: bool,
}

impl Tracker {
    /// Take one probe's result at `now`; a verdict when one is due. A stall
    /// is reported once, however long it lasts.
    pub fn observe(&mut self, probe: Probe, now: Instant, stall: Duration) -> Option<Verdict> {
        match probe {
            Probe::Silent => {
                let since = *self.silent_since.get_or_insert(now);
                let for_ = now.saturating_duration_since(since);
                if !self.reported && for_ >= stall {
                    self.reported = true;
                    return Some(Verdict::Stalled { for_ });
                }
                None
            }
            Probe::Answered | Probe::NotRunning => {
                let since = self.silent_since.take();
                let was_reported = std::mem::take(&mut self.reported);
                match (since, was_reported, probe) {
                    (Some(since), true, Probe::Answered) => Some(Verdict::Recovered {
                        after: now.saturating_duration_since(since),
                    }),
                    _ => None,
                }
            }
        }
    }
}

struct Watched {
    name: &'static str,
    port: fn() -> Option<u16>,
    tracker: Tracker,
}

/// Start watching, on a thread of its own. Once per process.
pub fn spawn() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let started = std::thread::Builder::new()
            .name("watchdog".into())
            .spawn(run);
        if let Err(e) = started {
            tracing::warn!("[Watchdog] couldn't start: {e}");
        }
    });
}

fn run() {
    let mut watched = [
        Watched {
            name: "phone server",
            port: crate::companion::desktop::running_port,
            tracker: Tracker::default(),
        },
        Watched {
            name: "agent bridge",
            port: crate::agent_bridge::running_port,
            tracker: Tracker::default(),
        },
    ];
    let mut last_sample: Option<Instant> = None;
    loop {
        std::thread::sleep(PERIOD);
        for w in watched.iter_mut() {
            let result = match (w.port)() {
                Some(port) => probe(port, PROBE_TIMEOUT),
                None => Probe::NotRunning,
            };
            match w.tracker.observe(result, Instant::now(), STALL) {
                Some(Verdict::Stalled { for_ }) => {
                    let sample = if last_sample.is_none_or(|t| t.elapsed() >= SAMPLE_EVERY) {
                        last_sample = Some(Instant::now());
                        sample_threads()
                    } else {
                        None
                    };
                    tracing::error!(
                        "[Watchdog] the {} hasn't answered on this Mac for {}s. {}",
                        w.name,
                        for_.as_secs(),
                        summary(sample.as_deref())
                    );
                }
                Some(Verdict::Recovered { after }) => tracing::warn!(
                    "[Watchdog] the {} is answering again, after {}s without",
                    w.name,
                    after.as_secs()
                ),
                None => {}
            }
        }
    }
}

/// What the report says beyond the server's name: who holds the agents
/// list's lock, and where the threads' stacks were written.
fn summary(sample: Option<&std::path::Path>) -> String {
    let lock = match crate::agents::store::lock::holder() {
        Some((at, held)) => format!(
            "The agents list's lock is held from {at} for {}s.",
            held.as_secs()
        ),
        None => "The agents list's lock is free.".to_string(),
    };
    let threads = match sample {
        Some(path) => format!(" Every thread's stack: {}", path.display()),
        None => " (No thread sample this time.)".to_string(),
    };
    format!("{lock}{threads}")
}

/// `sample` every thread of this process for two seconds into the logs
/// folder: the stacks say what each one is waiting on. None when it can't.
fn sample_threads() -> Option<std::path::PathBuf> {
    let dir = crate::brand::logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!(
        "hang-{}.txt",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    let mut child = std::process::Command::new("/usr/bin/sample")
        .arg(std::process::id().to_string())
        .arg("2")
        .arg("-file")
        .arg(&path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    // `sample` takes its two seconds and a little to symbolicate.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Some(path),
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A server that accepts and never says a word (the hang): the probe
    /// gives up within its timeout and calls it silent.
    #[test]
    fn a_silent_server_is_silent_within_the_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let held = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_secs(2));
            drop(socket);
        });
        let started = Instant::now();
        assert_eq!(probe(port, Duration::from_millis(300)), Probe::Silent);
        assert!(started.elapsed() < Duration::from_secs(2));
        held.join().unwrap();
    }

    /// Any HTTP answer is alive, a 404 included.
    #[test]
    fn any_http_answer_is_alive() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0u8; 256];
            let _ = socket.read(&mut buf);
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        });
        assert_eq!(probe(port, Duration::from_secs(2)), Probe::Answered);
        server.join().unwrap();
    }

    /// Nothing listening is off, not hung.
    #[test]
    fn nothing_listening_is_not_running() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        assert_eq!(probe(port, Duration::from_millis(300)), Probe::NotRunning);
    }

    /// Reported once when silent past the stall, and once when it's back.
    #[test]
    fn a_stall_is_reported_once_and_its_end_too() {
        let stall = Duration::from_secs(20);
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut t = Tracker::default();
        assert_eq!(t.observe(Probe::Silent, at(0), stall), None);
        assert_eq!(t.observe(Probe::Silent, at(10), stall), None);
        assert_eq!(
            t.observe(Probe::Silent, at(20), stall),
            Some(Verdict::Stalled {
                for_: Duration::from_secs(20)
            })
        );
        assert_eq!(t.observe(Probe::Silent, at(30), stall), None);
        assert_eq!(
            t.observe(Probe::Answered, at(40), stall),
            Some(Verdict::Recovered {
                after: Duration::from_secs(40)
            })
        );
        // A blip shorter than the stall says nothing either way.
        assert_eq!(t.observe(Probe::Silent, at(50), stall), None);
        assert_eq!(t.observe(Probe::Answered, at(60), stall), None);
        // A server switched off mid-stall isn't "answering again".
        assert_eq!(t.observe(Probe::Silent, at(70), stall), None);
        assert!(t.observe(Probe::Silent, at(95), stall).is_some());
        assert_eq!(t.observe(Probe::NotRunning, at(100), stall), None);
    }
}
