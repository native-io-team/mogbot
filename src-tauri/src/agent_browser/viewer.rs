//! A stand-in for the phone's live view: a loopback HTTP server that shows
//! the latest screencast frame (long-polled JPEGs) and
//! sends taps and keys back. The real thing rides the companion channel
//! (docs/internal/agent-browser.md, "Phone live view"); this proves the
//! loop — frames out, input in — with nothing but std.
//!
//! Every request must carry the random token (`?t=`); it binds 127.0.0.1
//! only. Input arrives as fractions of the frame (`fx`, `fy` in 0..1) so the
//! viewer never needs the page's size; the caller maps them onto the page.

use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// What the viewer sent.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Input {
    Click { fx: f64, fy: f64 },
    Key { text: String },
}

#[derive(Default)]
struct Latest {
    jpeg: Vec<u8>,
    seq: u64,
}

/// Where frames go in.
#[derive(Clone)]
pub struct Frames(Arc<(Mutex<Latest>, Condvar)>);

impl Frames {
    pub fn push(&self, jpeg: Vec<u8>) {
        let (m, cv) = &*self.0;
        if let Ok(mut l) = m.lock() {
            l.jpeg = jpeg;
            l.seq += 1;
        }
        cv.notify_all();
    }
}

pub struct Viewer {
    pub port: u16,
    pub token: String,
    pub frames: Frames,
    pub input: Receiver<Input>,
}

impl Viewer {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/?t={}", self.port, self.token)
    }
}

const PAGE: &str = r#"<!doctype html><meta name=viewport content="width=device-width">
<title>Live view</title>
<style>body{margin:0;background:#111;display:flex;justify-content:center}img{max-width:100%;cursor:pointer}</style>
<img id=v alt="">
<script>
const t=new URLSearchParams(location.search).get('t');
let seq=0;
(async function pull(){for(;;){try{const r=await fetch('/frame?t='+t+'&after='+seq);if(r.status===200){seq=+r.headers.get('X-Seq');const u=URL.createObjectURL(await r.blob());const old=v.src;v.src=u;if(old.startsWith('blob:'))URL.revokeObjectURL(old)}}catch(e){await new Promise(r=>setTimeout(r,500))}}})();
const send=b=>fetch('/input?t='+t,{method:'POST',body:JSON.stringify(b)});
v.addEventListener('click',e=>{const r=v.getBoundingClientRect();send({kind:'click',fx:(e.clientX-r.left)/r.width,fy:(e.clientY-r.top)/r.height})});
addEventListener('keydown',e=>{if(e.key.length===1){send({kind:'key',text:e.key});e.preventDefault()}});
</script>"#;

/// Start the server on a random loopback port.
pub fn start(token: String) -> std::io::Result<Viewer> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let frames = Frames(Arc::new((Mutex::new(Latest::default()), Condvar::new())));
    let (tx, rx) = mpsc::channel();
    let f = frames.clone();
    let tok = token.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (f, tx, tok) = (f.clone(), tx.clone(), tok.clone());
            std::thread::spawn(move || {
                let _ = serve(stream, &f, &tx, &tok);
            });
        }
    });
    Ok(Viewer {
        port,
        token,
        frames,
        input: rx,
    })
}

fn serve(
    mut s: TcpStream,
    frames: &Frames,
    tx: &Sender<Input>,
    token: &str,
) -> std::io::Result<()> {
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut r = BufReader::new(s.try_clone()?);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if r.read_line(&mut h)? == 0 || h == "\r\n" {
            break;
        }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0).min(4096);
        }
    }
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let ok_token = query.split('&').any(|kv| kv == format!("t={token}"));
    if !ok_token {
        return s.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    }
    match (method.as_str(), path) {
        ("GET", "/") => {
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n",
                PAGE.len()
            );
            s.write_all(head.as_bytes())?;
            s.write_all(PAGE.as_bytes())
        }
        ("GET", "/frame") => {
            // Long poll: the newest frame after `after`, or wait for one (up
            // to 10 s). The phone will get frames pushed on its socket; this
            // stand-in pulls, which needs nothing but fetch.
            let after: u64 = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("after="))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let (m, cv) = &*frames.0;
            let (seq, jpeg) = {
                let l = m.lock().map_err(|_| std::io::ErrorKind::Other)?;
                let (l, _) = cv
                    .wait_timeout_while(l, Duration::from_secs(10), |l| l.seq <= after)
                    .map_err(|_| std::io::ErrorKind::Other)?;
                (l.seq, l.jpeg.clone())
            };
            if seq <= after {
                return s.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nCache-Control: no-store\r\nX-Seq: {seq}\r\nAccess-Control-Expose-Headers: X-Seq\r\nContent-Length: {}\r\n\r\n",
                jpeg.len()
            );
            s.write_all(head.as_bytes())?;
            s.write_all(&jpeg)
        }
        ("POST", "/input") => {
            let mut body = vec![0u8; len];
            r.read_exact(&mut body)?;
            if let Ok(i) = serde_json::from_slice::<Input>(&body) {
                let valid = match &i {
                    Input::Click { fx, fy } => (0.0..=1.0).contains(fx) && (0.0..=1.0).contains(fy),
                    Input::Key { text } => {
                        text.chars().count() == 1 && !text.chars().any(char::is_control)
                    }
                };
                if valid {
                    let _ = tx.send(i);
                }
            }
            s.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
        }
        _ => s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_parses_and_rejects() {
        let c: Input = serde_json::from_str(r#"{"kind":"click","fx":0.5,"fy":0.25}"#).unwrap();
        assert_eq!(c, Input::Click { fx: 0.5, fy: 0.25 });
        assert!(serde_json::from_str::<Input>(r#"{"kind":"script","src":"x"}"#).is_err());
    }

    #[test]
    fn token_required() {
        let v = start("abc".into()).unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", v.port)).unwrap();
        s.write_all(b"GET /?t=wrong HTTP/1.1\r\n\r\n").unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 403"));
    }
}
