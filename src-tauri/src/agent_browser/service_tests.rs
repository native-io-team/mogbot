//! The service against a fake Chrome: one that speaks CDP over a socket
//! pair in this process (tabs, frames, owners), and one that is a real
//! child process reading fd 3 and writing fd 4 (launch and close).

use super::*;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

/// A Chrome that answers what the service asks, and records it.
pub(crate) struct Fake {
    pub calls: Arc<Mutex<Vec<String>>>,
}

pub(crate) fn tiny_jpeg(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(w, h, image::Rgb([200, 30, 30]));
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 60)
        .encode_image(&img)
        .unwrap();
    out
}

/// A connected [`Browser`] whose other end is the fake.
pub(crate) fn fake_browser() -> (Browser, Fake) {
    let (ours, theirs) = UnixStream::pair().unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let rec = calls.clone();
    std::thread::spawn(move || {
        let mut w = theirs.try_clone().unwrap();
        let mut r = BufReader::new(theirs);
        let mut next_target = 1;
        let mut buf = Vec::new();
        let send = |w: &mut UnixStream, v: Value| {
            let mut b = serde_json::to_vec(&v).unwrap();
            b.push(0);
            let _ = w.write_all(&b);
        };
        loop {
            buf.clear();
            if r.read_until(0, &mut buf).unwrap_or(0) == 0 {
                return;
            }
            buf.pop();
            let Ok(m) = serde_json::from_slice::<Value>(&buf) else {
                continue;
            };
            let id = m["id"].clone();
            let method = m["method"].as_str().unwrap_or("").to_string();
            let session = m["sessionId"].as_str().map(str::to_string);
            rec.lock().unwrap().push(method.clone());
            let result = match method.as_str() {
                "Browser.getVersion" => json!({ "product": "Chrome/156.0.0.0" }),
                "Target.createTarget" => {
                    let t = format!("T{next_target}");
                    next_target += 1;
                    json!({ "targetId": t })
                }
                "Target.attachToTarget" => {
                    json!({ "sessionId": format!("S-{}", m["params"]["targetId"].as_str().unwrap_or("")) })
                }
                "Target.getTargetInfo" => json!({ "targetInfo": {
                    "targetId": m["params"]["targetId"], "url": "https://example.com/", "title": "Example Domain"
                }}),
                "Browser.getWindowForTarget" => json!({ "windowId": 7 }),
                "Runtime.evaluate" => {
                    let e = m["params"]["expression"].as_str().unwrap_or("");
                    if e.contains("activeElement") {
                        json!({ "result": { "type": "string", "value": "plain" } })
                    } else if e.contains("innerText") {
                        json!({ "result": { "type": "string", "value": "Example Domain" } })
                    } else {
                        json!({ "result": { "type": "string", "value": "complete" } })
                    }
                }
                // Node 66 is a password field; the rest are not.
                "DOM.describeNode" => {
                    if m["params"]["backendNodeId"] == 66 {
                        json!({ "node": { "nodeName": "INPUT", "attributes": ["type", "password", "name", "pw"] } })
                    } else {
                        json!({ "node": { "nodeName": "INPUT", "attributes": ["type", "text"] } })
                    }
                }
                "DOM.getBoxModel" => {
                    json!({ "model": { "content": [10.0, 10.0, 110.0, 10.0, 110.0, 40.0, 10.0, 40.0] } })
                }
                "Accessibility.getFullAXTree" => json!({ "nodes": [
                    { "nodeId": "1", "ignored": false, "role": { "value": "RootWebArea" }, "name": { "value": "Example" }, "childIds": ["2", "3"], "backendDOMNodeId": 1 },
                    { "nodeId": "2", "parentId": "1", "ignored": false, "role": { "value": "textbox" }, "name": { "value": "Password" }, "childIds": [], "backendDOMNodeId": 66 },
                    { "nodeId": "3", "parentId": "1", "ignored": false, "role": { "value": "button" }, "name": { "value": "Send" }, "childIds": [], "backendDOMNodeId": 67 },
                ]}),
                "Page.navigate" => json!({ "frameId": "F" }),
                "Target.closeTarget" => {
                    send(
                        &mut w,
                        json!({ "method": "Target.targetDestroyed", "params": { "targetId": m["params"]["targetId"] } }),
                    );
                    json!({ "success": true })
                }
                _ => json!({}),
            };
            send(&mut w, json!({ "id": id, "result": result }));
            if method == "Page.startScreencast" || method == "Page.screencastFrameAck" {
                // A frame, as Chrome sends one after a start or an ack (only
                // the first two, so the test ends).
                let n = rec
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|c| *c == "Page.screencastFrameAck")
                    .count();
                if n < 2 {
                    use base64::Engine as _;
                    let data =
                        base64::engine::general_purpose::STANDARD.encode(tiny_jpeg(390, 270));
                    send(
                        &mut w,
                        json!({
                            "method": "Page.screencastFrame",
                            "sessionId": session,
                            "params": { "data": data, "sessionId": n + 1,
                                "metadata": { "deviceWidth": 1280.0, "deviceHeight": 886.0, "offsetTop": 0, "pageScaleFactor": 1 } },
                        }),
                    );
                }
            }
        }
    });
    let reader = ours.try_clone().unwrap();
    (Browser::connect(reader, ours, None), Fake { calls })
}

fn agent(a: &str) -> Owner {
    Owner::Agent(a.into())
}

#[test]
fn the_focus_check_fails_closed() {
    let ok = |v: Value| Focus::from_answer(Ok(v));
    assert_eq!(ok(json!("plain")), Focus::Plain);
    assert_eq!(ok(json!("secret")), Focus::Secret);
    // Another site's frame, an old boolean answer, nothing, or an error.
    assert_eq!(ok(json!("unknown")), Focus::Unknown);
    assert_eq!(ok(json!(false)), Focus::Unknown);
    assert_eq!(ok(Value::Null), Focus::Unknown);
    assert_eq!(
        Focus::from_answer(Err("The page didn't answer.".into())),
        Focus::Unknown
    );
    // It looks inside frames rather than stopping at the IFRAME element.
    assert!(FOCUSED_FIELD_JS.contains("contentDocument"));
}

#[test]
fn tabs_belong_to_their_owner() {
    let (b, _fake) = fake_browser();
    let svc = Service::start(b, PathBuf::from("/tmp/none")).unwrap();
    let t1 = svc.open(agent("a1"), "https://example.com/").unwrap();
    let t2 = svc.open(agent("a2"), "https://example.com/").unwrap();
    let s = svc
        .open(Owner::Signin("signin_1".into()), "https://example.com/")
        .unwrap();
    assert_eq!(t1.title, "Example Domain");
    assert_eq!(
        svc.tabs_of(&agent("a1")),
        vec![svc.tab_for("a1", None).unwrap()]
    );
    // Another agent's tab, and a sign-in's, aren't reachable by id.
    assert!(svc.tab_for("a1", Some(t2.id)).is_err());
    assert!(svc.tab_for("a1", Some(s.id)).is_err());
    assert!(svc.tab_for("a3", None).is_err());
    assert!(svc.has_owner(&Owner::Signin("signin_1".into())));
    svc.close_tab(&t1);
    // Closed by Chrome's own event too; either way it's gone.
    assert!(svc.tab_for("a1", None).is_err());
    assert_eq!(svc.tabs_of(&agent("a2")).len(), 1);
}

#[test]
fn an_agent_can_hold_only_so_many_tabs() {
    let (b, _fake) = fake_browser();
    let svc = Service::start(b, PathBuf::from("/tmp/none")).unwrap();
    for _ in 0..MAX_TABS {
        svc.open(agent("a1"), "about:blank").unwrap();
    }
    let err = svc.open(agent("a1"), "about:blank").unwrap_err();
    assert!(err.contains("close_tab"), "{err}");
    // Someone else's count is their own.
    svc.open(agent("a2"), "about:blank").unwrap();
}

#[test]
fn every_window_is_parked_never_minimized() {
    let (b, fake) = fake_browser();
    let svc = Service::start(b, PathBuf::from("/tmp/none")).unwrap();
    svc.open(agent("a1"), "about:blank").unwrap();
    let calls = fake.calls.lock().unwrap().clone();
    assert!(calls.contains(&"Browser.setWindowBounds".to_string()));
    assert!(calls.iter().any(|c| c == "Target.createTarget"));
}

#[test]
fn a_watched_tab_streams_its_newest_frame_and_acks_it() {
    let (b, fake) = fake_browser();
    let svc = Service::start(b, PathBuf::from("/tmp/none")).unwrap();
    let tab = svc
        .open(Owner::Signin("signin_1".into()), "https://example.com/")
        .unwrap();
    let slot = svc.watch(&tab).unwrap();
    let f = slot.next(0, Duration::from_secs(3)).expect("a frame");
    assert_eq!((f.width, f.height), (390, 270));
    assert_eq!((f.css_width, f.css_height), (1280.0, 886.0));
    // A tap on the picture's middle is the page's middle.
    let (x, y) = f.to_css(195.0, 135.0);
    assert!((x - 640.0).abs() < 0.01 && (y - 443.0).abs() < 0.01);
    // Acked after the gap, which brings the next.
    let g = slot
        .next(f.seq, Duration::from_secs(3))
        .expect("a second frame");
    assert!(g.seq > f.seq);
    assert!(fake
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c == "Page.screencastFrameAck"));
    // Nothing newer: the wait ends empty.
    assert!(slot.next(g.seq + 5, Duration::from_millis(100)).is_none());
    svc.unwatch(&tab);
}

#[test]
fn frames_are_not_kept_for_an_unwatched_tab() {
    let (b, _fake) = fake_browser();
    let svc = Service::start(b, PathBuf::from("/tmp/none")).unwrap();
    let tab = svc.open(agent("a1"), "https://example.com/").unwrap();
    assert!(svc.slot(&tab.session_id).is_none());
    let _ = svc.watch(&tab).unwrap();
    svc.unwatch(&tab);
    assert!(svc.slot(&tab.session_id).is_none());
}

#[test]
fn jpeg_size_reads_the_header() {
    assert_eq!(jpeg_size(&tiny_jpeg(33, 21)), Some((33, 21)));
    assert_eq!(jpeg_size(b"not a jpeg"), None);
}

/* --------------------------------------- a real process, a fake Chrome */

/// A "Chrome" that is a Perl script: writes its arguments to a file, then
/// answers every CDP message on fd 3 through fd 4, and exits on
/// `Browser.close`.
fn fake_chrome(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let perl = Path::new("/usr/bin/perl");
    if !perl.is_file() {
        return None;
    }
    let argv = dir.join("argv.txt");
    let script = dir.join("Google Chrome");
    let body = format!(
        r#"#!/usr/bin/perl
use strict; use warnings; use IO::Handle;
open(my $a, '>', '{argv}') or die; print $a join("\n", @ARGV); close($a);
open(my $in, '<&=', 3) or die "fd3"; open(my $out, '>&=', 4) or die "fd4"; $out->autoflush(1);
local $/ = "\0";
while (my $m = <$in>) {{
  chomp $m;
  my ($id) = $m =~ /"id":(\d+)/;
  next unless defined $id;
  print $out "{{\"id\":$id,\"result\":{{}}}}\0";
  exit 0 if $m =~ /"Browser\.close"/;
}}
"#,
        argv = argv.display()
    );
    std::fs::write(&script, body).ok()?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).ok()?;
    Some((script, argv))
}

#[test]
fn launch_speaks_over_the_pipe_and_closes_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let Some((chrome, argv)) = fake_chrome(dir.path()) else {
        return;
    };
    let root = dir.path().join("agent-browser");
    let profile = root.join("Agents");
    let svc = launch_at(&chrome, &profile, &root).expect("started");
    assert!(profile.is_dir());
    let args = std::fs::read_to_string(&argv).unwrap();
    assert!(
        args.lines().any(|l| l == "--remote-debugging-pipe"),
        "{args}"
    );
    assert!(args
        .lines()
        .any(|l| l == format!("--user-data-dir={}", profile.display())));
    assert!(!args.contains("--remote-debugging-port"));
    assert!(!args.contains("--enable-automation"));
    assert!(!svc.dead());
    svc.browser.shutdown();
    // It exited on Browser.close, without being killed.
    assert!(svc.browser.exited());
}

#[test]
fn launch_refuses_a_profile_that_isnt_ours() {
    let dir = tempfile::tempdir().unwrap();
    let Some((chrome, _)) = fake_chrome(dir.path()) else {
        return;
    };
    let root = dir.path().join("agent-browser");
    let err = launch_at(&chrome, &dir.path().join("elsewhere"), &root)
        .err()
        .unwrap();
    assert!(err.contains("isn't the app's own"));
    if let Some(home) = std::env::var_os("HOME") {
        let theirs = PathBuf::from(home).join("Library/Application Support/Google/Chrome/Default");
        assert!(launch_at(&chrome, &theirs, &theirs).is_err());
    }
}

#[test]
fn a_chrome_that_dies_is_seen_dead() {
    let dir = tempfile::tempdir().unwrap();
    let Some((chrome, _)) = fake_chrome(dir.path()) else {
        return;
    };
    let root = dir.path().join("agent-browser");
    let svc = launch_at(&chrome, &root.join("Agents"), &root).unwrap();
    let pid = svc.browser.pid() as i32;
    // SAFETY: signalling our own child.
    unsafe { libc::kill(pid, libc::SIGKILL) };
    let end = Instant::now() + Duration::from_secs(5);
    while !svc.dead() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(svc.dead());
}
