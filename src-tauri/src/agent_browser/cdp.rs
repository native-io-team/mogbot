//! The Chrome DevTools Protocol over `--remote-debugging-pipe`.
//!
//! Chrome reads commands from fd 3 and writes replies and events to fd 4,
//! each message JSON terminated by a NUL byte. There is no port, so no other
//! process on the Mac can attach, and the connection ends with the child.
//!
//! One reader thread splits the stream; replies are matched to callers by
//! `id`, everything else (events) goes to one channel. Sessions use the
//! flattened protocol (`Target.attachToTarget { flatten: true }`): a page's
//! commands carry its `sessionId` on the same pipe.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// An event from Chrome (`method`, `params`, and the page session it came
/// from, if any).
#[derive(Debug, Clone)]
pub struct Event {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

type Waiters = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// A running Chrome and its pipe.
pub struct Browser {
    child: Child,
    writer: Mutex<File>,
    next_id: AtomicU64,
    waiters: Waiters,
    events: Mutex<Option<Receiver<Event>>>,
}

fn pipe() -> std::io::Result<(RawFd, RawFd)> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: fds is a valid two-int buffer.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    for fd in fds {
        // Close-on-exec in this process; the child's copies at 3/4 are made
        // by dup2 in pre_exec, which clears the flag on the new descriptor.
        // SAFETY: fd was just returned by pipe().
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    Ok((fds[0], fds[1]))
}

impl Browser {
    /// Start `chrome` with `args` (which must include
    /// `--remote-debugging-pipe`) and connect to it.
    pub fn launch(chrome: &Path, args: &[String]) -> std::io::Result<Browser> {
        let (to_chrome_r, to_chrome_w) = pipe()?;
        let (from_chrome_r, from_chrome_w) = pipe()?;

        let mut cmd = Command::new(chrome);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: only async-signal-safe libc calls between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                // Move both ends above 4 first, so neither dup2 below can
                // clobber the other if pipe() handed out 3 or 4.
                let r = libc::fcntl(to_chrome_r, libc::F_DUPFD, 10);
                let w = libc::fcntl(from_chrome_w, libc::F_DUPFD, 10);
                if r < 0 || w < 0 || libc::dup2(r, 3) < 0 || libc::dup2(w, 4) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd.spawn();
        // SAFETY: closing our copies of the child's ends; they are ours.
        unsafe {
            libc::close(to_chrome_r);
            libc::close(from_chrome_w);
        }
        let child = match child {
            Ok(c) => c,
            Err(e) => {
                unsafe {
                    libc::close(to_chrome_w);
                    libc::close(from_chrome_r);
                }
                return Err(e);
            }
        };
        // SAFETY: each fd is owned exactly once from here on.
        let writer = unsafe { File::from_raw_fd(to_chrome_w) };
        let reader = unsafe { File::from_raw_fd(from_chrome_r) };

        let waiters: Waiters = Arc::new(Mutex::new(HashMap::new()));
        let (ev_tx, ev_rx) = mpsc::channel();
        spawn_reader(reader, waiters.clone(), ev_tx);

        Ok(Browser {
            child,
            writer: Mutex::new(writer),
            next_id: AtomicU64::new(1),
            waiters,
            events: Mutex::new(Some(ev_rx)),
        })
    }

    /// The event stream. Taken once.
    pub fn take_events(&self) -> Option<Receiver<Event>> {
        self.events.lock().ok()?.take()
    }

    /// Send a command and wait for its reply.
    pub fn call(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session_id {
            msg["sessionId"] = json!(s);
        }
        let (tx, rx) = mpsc::channel();
        self.waiters
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, tx);
        {
            let mut w = self.writer.lock().map_err(|e| e.to_string())?;
            let mut bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
            bytes.push(0);
            w.write_all(&bytes)
                .map_err(|e| format!("pipe write: {e}"))?;
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                if let Ok(mut w) = self.waiters.lock() {
                    w.remove(&id);
                }
                Err(format!("{method}: no reply in {timeout:?}"))
            }
        }
    }

    /// Ask Chrome to close, then make sure it's gone.
    pub fn close(mut self) {
        let _ = self.call("Browser.close", json!({}), None, Duration::from_secs(5));
        for _ in 0..50 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn spawn_reader(reader: File, waiters: Waiters, events: Sender<Event>) {
    std::thread::spawn(move || {
        let mut r = BufReader::with_capacity(1 << 20, reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(0, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if buf.last() == Some(&0) {
                buf.pop();
            }
            let Ok(v) = serde_json::from_slice::<Value>(&buf) else {
                continue;
            };
            if let Some(id) = v.get("id").and_then(Value::as_u64) {
                let tx = waiters.lock().ok().and_then(|mut w| w.remove(&id));
                if let Some(tx) = tx {
                    let res = match v.get("error") {
                        Some(e) => Err(e.to_string()),
                        None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(res);
                }
            } else if let Some(m) = v.get("method").and_then(Value::as_str) {
                let _ = events.send(Event {
                    method: m.to_string(),
                    params: v.get("params").cloned().unwrap_or(Value::Null),
                    session_id: v.get("sessionId").and_then(Value::as_str).map(String::from),
                });
            }
        }
        // Chrome is gone: fail everyone still waiting.
        if let Ok(mut w) = waiters.lock() {
            for (_, tx) in w.drain() {
                let _ = tx.send(Err("Chrome closed the pipe".to_string()));
            }
        }
    });
}

/// A page (tab) the agent browser opened, attached with a flat session.
pub struct Page<'a> {
    pub browser: &'a Browser,
    pub target_id: String,
    pub session_id: String,
}

pub const T: Duration = Duration::from_secs(20);

impl<'a> Page<'a> {
    /// A new tab at `url`, attached.
    pub fn open(browser: &'a Browser, url: &str) -> Result<Page<'a>, String> {
        Self::open_in(browser, url, false)
    }

    /// A new tab in a window of its own. Each agent gets its own window, so
    /// every agent's page is the visible tab of its window and keeps painting
    /// (a background tab gets no screencast frames).
    pub fn open_window(browser: &'a Browser, url: &str) -> Result<Page<'a>, String> {
        Self::open_in(browser, url, true)
    }

    fn open_in(browser: &'a Browser, url: &str, new_window: bool) -> Result<Page<'a>, String> {
        let t = browser.call(
            "Target.createTarget",
            json!({ "url": url, "newWindow": new_window }),
            None,
            T,
        )?;
        let target_id = t["targetId"].as_str().ok_or("no targetId")?.to_string();
        let s = browser.call(
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
            T,
        )?;
        let session_id = s["sessionId"].as_str().ok_or("no sessionId")?.to_string();
        Ok(Page {
            browser,
            target_id,
            session_id,
        })
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.browser.call(method, params, Some(&self.session_id), T)
    }

    /// The centre of the first element matching `selector`, in CSS pixels
    /// of the viewport. DOM domain only: no script runs in the page.
    pub fn center_of(&self, selector: &str) -> Result<(f64, f64), String> {
        let doc = self.call("DOM.getDocument", json!({ "depth": 0 }))?;
        let root = doc["root"]["nodeId"].as_i64().ok_or("no document")?;
        let q = self.call(
            "DOM.querySelector",
            json!({ "nodeId": root, "selector": selector }),
        )?;
        let node = q["nodeId"]
            .as_i64()
            .filter(|n| *n != 0)
            .ok_or("no such element")?;
        // Bring it into the viewport first, as a person would scroll to it.
        self.call("DOM.scrollIntoViewIfNeeded", json!({ "nodeId": node }))?;
        let bm = self.call("DOM.getBoxModel", json!({ "nodeId": node }))?;
        let quad: Vec<f64> = bm["model"]["content"]
            .as_array()
            .ok_or("no box")?
            .iter()
            .filter_map(Value::as_f64)
            .collect();
        if quad.len() != 8 {
            return Err("bad box".into());
        }
        let x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4.0;
        let y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4.0;
        Ok((x, y))
    }

    /// The centre of the first element with one of `roles` in the page's
    /// accessibility tree (what an agent addresses: "the search box", not a
    /// CSS selector that changes with every redesign). Scrolled into view.
    pub fn center_of_role(&self, roles: &[&str]) -> Result<(f64, f64), String> {
        let doc = self.call("DOM.getDocument", json!({ "depth": 0 }))?;
        let root = doc["root"]["backendNodeId"].as_i64().ok_or("no document")?;
        for role in roles {
            let r = self.call(
                "Accessibility.queryAXTree",
                json!({ "backendNodeId": root, "role": role }),
            )?;
            let nodes = r["nodes"].as_array().cloned().unwrap_or_default();
            for n in nodes {
                if n["ignored"].as_bool() == Some(true) {
                    continue;
                }
                let Some(id) = n["backendDOMNodeId"].as_i64() else {
                    continue;
                };
                if self
                    .call("DOM.scrollIntoViewIfNeeded", json!({ "backendNodeId": id }))
                    .is_err()
                {
                    continue;
                }
                let Ok(bm) = self.call("DOM.getBoxModel", json!({ "backendNodeId": id })) else {
                    continue;
                };
                let q: Vec<f64> = bm["model"]["content"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_f64).collect())
                    .unwrap_or_default();
                if q.len() == 8 && (q[2] - q[0]).abs() > 1.0 {
                    return Ok((
                        (q[0] + q[2] + q[4] + q[6]) / 4.0,
                        (q[1] + q[3] + q[5] + q[7]) / 4.0,
                    ));
                }
            }
        }
        Err(format!("nothing with role {roles:?}"))
    }

    /// Retry `f` for up to `secs` while the page is still building itself.
    pub fn settle<R>(
        &self,
        secs: u64,
        mut f: impl FnMut(&Self) -> Result<R, String>,
    ) -> Result<R, String> {
        let end = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            match f(self) {
                Ok(r) => return Ok(r),
                Err(e) if std::time::Instant::now() >= end => return Err(e),
                Err(_) => std::thread::sleep(Duration::from_millis(250)),
            }
        }
    }

    /// Set this page's window state: "normal", "minimized", "maximized".
    pub fn window_state(&self, state: &str) -> Result<(), String> {
        let w = self.browser.call(
            "Browser.getWindowForTarget",
            json!({ "targetId": self.target_id }),
            None,
            T,
        )?;
        let id = w["windowId"].as_i64().ok_or("no window")?;
        self.browser.call(
            "Browser.setWindowBounds",
            json!({ "windowId": id, "bounds": { "windowState": state } }),
            None,
            T,
        )?;
        Ok(())
    }

    /// Move this page's window (normal state only).
    pub fn window_move(&self, left: i64, top: i64) -> Result<Value, String> {
        let w = self.browser.call(
            "Browser.getWindowForTarget",
            json!({ "targetId": self.target_id }),
            None,
            T,
        )?;
        let id = w["windowId"].as_i64().ok_or("no window")?;
        self.browser.call(
            "Browser.setWindowBounds",
            json!({ "windowId": id, "bounds": { "left": left, "top": top } }),
            None,
            T,
        )?;
        let after = self.browser.call(
            "Browser.getWindowBounds",
            json!({ "windowId": id }),
            None,
            T,
        )?;
        Ok(after["bounds"].clone())
    }

    /// A real mouse click at (x, y): move, press, release, like a hand.
    pub fn click(&self, x: f64, y: f64) -> Result<(), String> {
        self.call(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y }),
        )?;
        for t in ["mousePressed", "mouseReleased"] {
            self.call(
                "Input.dispatchMouseEvent",
                json!({ "type": t, "x": x, "y": y, "button": "left", "clickCount": 1 }),
            )?;
        }
        Ok(())
    }

    /// Press Enter in whatever has focus.
    pub fn press_enter(&self) -> Result<(), String> {
        self.call(
            "Input.dispatchKeyEvent",
            json!({ "type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r" }),
        )?;
        self.call(
            "Input.dispatchKeyEvent",
            json!({ "type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 }),
        )?;
        Ok(())
    }

    /// Type text as key events (what the phone's keyboard would send).
    pub fn type_text(&self, text: &str) -> Result<(), String> {
        for ch in text.chars() {
            let s = ch.to_string();
            self.call(
                "Input.dispatchKeyEvent",
                json!({ "type": "keyDown", "text": s, "key": s }),
            )?;
            self.call(
                "Input.dispatchKeyEvent",
                json!({ "type": "keyUp", "key": s }),
            )?;
        }
        Ok(())
    }
}
