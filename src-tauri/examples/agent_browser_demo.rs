//! End-to-end proof of the agent browser: control, streaming, the phone
//! viewer loop, several agents at once, a persistent profile, and how real
//! sites react. Nothing here signs in to anything.
//!
//! `cargo run --features agent-browser,browser-demo --example agent_browser_demo -- <scratch> <cmd>`
//!
//! - `demo`    throwaway profile: what a page sees, screenshot, screencast
//!   fps/latency, keystroke→frame, window states, a link click
//! - `tabs`    three agent windows streaming at once, and a background tab
//! - `viewer`  the phone stand-in: frames out to a page, its taps/keys back in
//! - `persist` the "Agents" profile keeps cookies across relaunches
//! - `sites`   a handful of public tasks, 3 tries each, plus sign-in PAGES
//!   (loaded and looked at; nothing typed into them)
//!
//! All but `demo` use the persistent profile `<scratch>/Agents`. Chrome is
//! muted; windows are parked in a screen corner (`ONSCREEN=1` leaves them,
//! `MINIMIZED=1` minimizes them).

// A dev harness: panics and plain `ps` are fine here.
#![allow(clippy::disallowed_methods, clippy::unwrap_used, clippy::expect_used)]
use app_lib::agent_browser::cdp::{Browser, Event, Page, T};
use app_lib::agent_browser::chrome::{self, LaunchSpec, Window};
use app_lib::agent_browser::viewer::{self, Input};
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        * 1000.0
}
fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}
fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .unwrap_or_default()
}

/* ------------------------------------------------------------ helpers */

fn ack(b: &Browser, ev: &Event) {
    if let (Some(sid), Some(sess)) = (ev.params["sessionId"].as_i64(), ev.session_id.as_deref()) {
        let _ = b.call(
            "Page.screencastFrameAck",
            json!({ "sessionId": sid }),
            Some(sess),
            T,
        );
    }
}

/// Next event from `page`'s session matching `pred`, acking frames on the way.
fn wait_for(
    page: &Page,
    rx: &Receiver<Event>,
    timeout: Duration,
    mut pred: impl FnMut(&Event) -> bool,
) -> Option<Event> {
    let end = Instant::now() + timeout;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        let Ok(ev) = rx.recv_timeout(left) else { break };
        if ev.method == "Page.screencastFrame" {
            ack(page.browser, &ev);
        }
        if ev.session_id.as_deref() == Some(page.session_id.as_str()) && pred(&ev) {
            return Some(ev);
        }
    }
    None
}

fn drain(b: &Browser, rx: &Receiver<Event>) {
    while let Ok(ev) = rx.try_recv() {
        if ev.method == "Page.screencastFrame" {
            ack(b, &ev);
        }
    }
}

fn eval(page: &Page, expr: &str) -> Value {
    page.call(
        "Runtime.evaluate",
        json!({ "expression": expr, "returnByValue": true }),
    )
    .map(|r| r["result"]["value"].clone())
    .unwrap_or(Value::Null)
}

fn navigate(page: &Page, rx: &Receiver<Event>, url: &str) -> Result<f64, String> {
    drain(page.browser, rx);
    let t = Instant::now();
    let r = page.call("Page.navigate", json!({ "url": url }))?;
    if let Some(e) = r["errorText"].as_str() {
        return Err(format!("navigate: {e}"));
    }
    wait_for(page, rx, Duration::from_secs(30), |e| {
        e.method == "Page.loadEventFired"
    })
    .ok_or("no load event in 30 s")?;
    // A load event can belong to the page we just left; make sure this is
    // the new document, complete.
    if let Some(host) = url
        .strip_prefix("https://")
        .and_then(|r| r.split('/').next())
    {
        let check = format!("location.host === '{host}' && document.readyState === 'complete'");
        if !until(page, &check, Duration::from_secs(15)) {
            return Err(format!("not at {host}"));
        }
    }
    Ok(ms(t))
}

/// Poll until `expr` is truthy (no events needed).
fn until(page: &Page, expr: &str, timeout: Duration) -> bool {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if eval(page, expr).as_bool() == Some(true) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

fn shot(page: &Page, path: &Path) -> Result<usize, String> {
    let s = page.call(
        "Page.captureScreenshot",
        json!({ "format": "jpeg", "quality": 70 }),
    )?;
    let bytes = b64(s["data"].as_str().unwrap_or(""));
    std::fs::write(path, &bytes).map_err(|e| e.to_string())?;
    Ok(bytes.len())
}

struct Stream {
    frames: usize,
    fps: f64,
    lat_median: f64,
    bytes_avg: usize,
}

/// Screencast every page in `pages` at once for `secs`; one result each.
fn screencast(
    pages: &[&Page],
    rx: &Receiver<Event>,
    secs: f64,
    max_w: u32,
) -> Result<Vec<Stream>, String> {
    let b = pages[0].browser;
    drain(b, rx);
    for p in pages {
        p.call(
            "Page.startScreencast",
            json!({ "format": "jpeg", "quality": 60, "maxWidth": max_w, "maxHeight": max_w }),
        )?;
    }
    let start = Instant::now();
    let mut per: HashMap<String, (Vec<f64>, usize, Option<Instant>)> = HashMap::new();
    while start.elapsed().as_secs_f64() < secs {
        let Ok(ev) = rx.recv_timeout(Duration::from_millis(100)) else {
            continue;
        };
        if ev.method != "Page.screencastFrame" {
            continue;
        }
        let recv = now_ms();
        ack(b, &ev);
        let e = per
            .entry(ev.session_id.clone().unwrap_or_default())
            .or_default();
        e.2.get_or_insert_with(Instant::now);
        if let Some(ts) = ev.params["metadata"]["timestamp"].as_f64() {
            e.0.push(recv - ts * 1000.0);
        }
        e.1 += ev.params["data"].as_str().map_or(0, |d| d.len() * 3 / 4);
    }
    for p in pages {
        p.call("Page.stopScreencast", json!({}))?;
    }
    Ok(pages
        .iter()
        .map(|p| {
            let (mut l, bytes, first) = per.remove(&p.session_id).unwrap_or_default();
            l.sort_by(|a, b| a.total_cmp(b));
            let n = l.len();
            let span = first.map_or(secs, |f| f.elapsed().as_secs_f64().max(0.001));
            Stream {
                frames: n,
                fps: if n > 1 {
                    (n - 1) as f64 / span
                } else {
                    n as f64 / secs
                },
                lat_median: if n > 0 { l[n / 2] } else { f64::NAN },
                bytes_avg: if n > 0 { bytes / n } else { 0 },
            }
        })
        .collect())
}

/// Resident memory of Chrome and everything under it, in MB (an
/// over-count: shared pages are counted once per process).
fn tree_rss_mb(root: u32) -> f64 {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,rss="])
        .output()
    else {
        return f64::NAN;
    };
    let rows: Vec<(u32, u32, u64)> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace().map(|x| x.parse::<u64>().ok());
            Some((it.next()?? as u32, it.next()?? as u32, it.next()??))
        })
        .collect();
    let mut set = vec![root];
    let mut i = 0;
    while i < set.len() {
        let p = set[i];
        set.extend(rows.iter().filter(|r| r.1 == p).map(|r| r.0));
        i += 1;
    }
    rows.iter()
        .filter(|r| set.contains(&r.0))
        .map(|r| r.2)
        .sum::<u64>() as f64
        / 1024.0
}

const ANIM: &str = "data:text/html,<body style='margin:0;font:48px sans-serif'><div id=c></div><script>let n=0;(function f(){c.textContent=n++;requestAnimationFrame(f)})()</script>";
const INPUT: &str = "data:text/html,<body style='margin:20px'><input id=i style='font-size:40px;width:600px'></body>";

fn launch(profile: &Path) -> Result<(Browser, Receiver<Event>), String> {
    let onscreen = std::env::var("ONSCREEN").is_ok();
    let spec = LaunchSpec {
        user_data_dir: profile.to_path_buf(),
        window: if onscreen {
            Window::OnScreen {
                width: 1280,
                height: 800,
            }
        } else {
            Window::OffScreen {
                width: 1280,
                height: 800,
            }
        },
        mute: true,
    };
    let bin = chrome::find_chrome().ok_or("Google Chrome isn't installed")?;
    let b = Browser::launch(&bin, &chrome::args(&spec)).map_err(|e| e.to_string())?;
    let rx = b.take_events().ok_or("no events")?;
    b.call(
        "Browser.getVersion",
        json!({}),
        None,
        Duration::from_secs(30),
    )?;
    Ok((b, rx))
}

/// The first page Chrome opened (about:blank), attached.
fn first_page(b: &Browser) -> Result<Page<'_>, String> {
    let t = b.call("Target.getTargets", json!({}), None, T)?;
    let id = t["targetInfos"]
        .as_array()
        .and_then(|a| a.iter().find(|i| i["type"] == "page"))
        .and_then(|i| i["targetId"].as_str())
        .ok_or("no page")?
        .to_string();
    let s = b.call(
        "Target.attachToTarget",
        json!({ "targetId": id, "flatten": true }),
        None,
        T,
    )?;
    let page = Page {
        browser: b,
        target_id: id,
        session_id: s["sessionId"].as_str().ok_or("no session")?.to_string(),
    };
    page.call("Page.enable", json!({}))?;
    Ok(page)
}

/// Park the window as far off screen as macOS allows. Minimizing would
/// hide it completely, but a minimized page is `hidden` and sends no
/// screencast frames (measured), so the phone would see nothing.
fn hide(page: &Page) {
    if std::env::var("MINIMIZED").is_ok() {
        let _ = page.window_state("minimized");
    } else if std::env::var("ONSCREEN").is_err() {
        let _ = page.window_move(100_000, 100_000);
    }
}

/* --------------------------------------------------------------- demo */

fn demo(scratch: &Path) -> Result<(), String> {
    let profile = scratch.join("throwaway");
    let _ = std::fs::remove_dir_all(&profile);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let (b, rx) = launch(&profile)?;
    println!("launch → first CDP reply: {:.0} ms", ms(t0));
    let page = first_page(&b)?;

    // Where did "off screen" actually put the window?
    println!(
        "window bounds after --window-position=-32000,-32000: {}",
        page.window_move(-32000, -32000)?
    );
    for (l, t) in [(100_000, 100_000), (0, 100_000), (100_000, 0)] {
        println!("  asked for ({l},{t}) → {}", page.window_move(l, t)?);
    }

    navigate(&page, &rx, "https://example.com/")?;
    println!(
        "page sees: webdriver={} UA={} brands={}",
        eval(&page, "navigator.webdriver"),
        eval(&page, "navigator.userAgent"),
        eval(
            &page,
            "JSON.stringify(navigator.userAgentData.brands.map(b=>b.brand))"
        )
    );
    let t = Instant::now();
    let n = shot(&page, &scratch.join("demo-example.jpg"))?;
    println!("screenshot {n} bytes in {:.0} ms", ms(t));

    // Window state vs. painting.
    navigate(&page, &rx, ANIM)?;
    for state in ["normal", "minimized"] {
        page.window_state(state)?;
        std::thread::sleep(Duration::from_millis(600));
        let vis = eval(&page, "document.visibilityState");
        let s = &screencast(&[&page], &rx, 3.0, 1280)?[0];
        println!(
            "window {state:9}: visibility={vis}, screencast {} frames = {:.1} fps, capture→receive median {:.0} ms, ~{} KB/frame",
            s.frames, s.fps, s.lat_median, s.bytes_avg / 1024
        );
        let t = Instant::now();
        let n = shot(&page, &scratch.join(format!("demo-{state}.jpg")));
        println!("  screenshot while {state}: {n:?} in {:.0} ms", ms(t));
        // Polling screenshots instead of a screencast: does a hidden page
        // still give fresh pictures?
        let t = Instant::now();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..20 {
            let s = page.call(
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": 60 }),
            )?;
            seen.insert(s["data"].as_str().unwrap_or("").to_string());
        }
        println!(
            "  20 polled screenshots while {state}: {} distinct, {:.1} per second",
            seen.len(),
            20.0 / t.elapsed().as_secs_f64()
        );
    }
    page.window_state("normal")?;
    println!("parked: {}", page.window_move(100_000, 100_000)?);
    println!("chrome tree RSS (1 tab): {:.0} MB", tree_rss_mb(b.pid()));

    // Keystroke → next frame, minimized.
    navigate(&page, &rx, INPUT)?;
    let (x, y) = page.center_of("#i")?;
    page.click(x, y)?;
    page.call(
        "Page.startScreencast",
        json!({ "format": "jpeg", "quality": 60, "maxWidth": 800, "maxHeight": 800 }),
    )?;
    wait_for(&page, &rx, Duration::from_secs(3), |e| {
        e.method == "Page.screencastFrame"
    });
    std::thread::sleep(Duration::from_millis(300));
    drain(&b, &rx);
    let mut lats = Vec::new();
    for i in 0..15u8 {
        let t = Instant::now();
        page.type_text(&((b'a' + i) as char).to_string())?;
        if wait_for(&page, &rx, Duration::from_secs(2), |e| {
            e.method == "Page.screencastFrame"
        })
        .is_some()
        {
            lats.push(ms(t));
        }
        std::thread::sleep(Duration::from_millis(200));
        drain(&b, &rx);
    }
    page.call("Page.stopScreencast", json!({}))?;
    lats.sort_by(|a, b| a.total_cmp(b));
    println!(
        "keystroke→frame: {}/15 frames, median {:.0} ms, max {:.0} ms; field holds {}",
        lats.len(),
        lats.get(lats.len() / 2).copied().unwrap_or(f64::NAN),
        lats.last().copied().unwrap_or(f64::NAN),
        eval(&page, "i.value")
    );

    // Click the link, scrolled to like a person would.
    navigate(&page, &rx, "https://example.com/")?;
    let (x, y) = page.center_of("a")?;
    drain(&b, &rx);
    let t = Instant::now();
    page.click(x, y)?;
    let nav = wait_for(&page, &rx, T, |e| {
        e.method == "Page.frameNavigated" && e.params["frame"]["parentId"].is_null()
    });
    println!(
        "clicked link at ({x:.0},{y:.0}) → {} in {:.0} ms",
        nav.as_ref()
            .and_then(|e| e.params["frame"]["url"].as_str())
            .unwrap_or("NO NAVIGATION"),
        ms(t)
    );
    let t = Instant::now();
    b.close();
    println!("closed in {:.0} ms", ms(t));
    let _ = std::fs::remove_dir_all(&profile);
    Ok(())
}

/* --------------------------------------------------------------- tabs */

fn tabs(scratch: &Path) -> Result<(), String> {
    let (b, rx) = launch(&scratch.join("Agents"))?;
    let first = first_page(&b)?;
    let mut wins = Vec::new();
    for _ in 0..3 {
        let p = Page::open_window(&b, "about:blank")?;
        p.call("Page.enable", json!({}))?;
        navigate(&p, &rx, ANIM)?;
        hide(&p);
        wins.push(p);
    }
    // A background tab in the first agent's window.
    let bg = Page::open(&b, "about:blank")?;
    bg.call("Page.enable", json!({}))?;
    navigate(&bg, &rx, ANIM)?;
    // Bring the window's original tab back to the front so `bg` is behind.
    b.call(
        "Target.activateTarget",
        json!({ "targetId": wins[0].target_id }),
        None,
        T,
    )?;
    hide(&first);
    std::thread::sleep(Duration::from_millis(500));
    let mut all: Vec<&Page> = wins.iter().collect();
    all.push(&bg);
    let res = screencast(&all, &rx, 4.0, 800)?;
    for (i, s) in res.iter().enumerate() {
        let what = if i < 3 {
            format!("agent window {}", i + 1)
        } else {
            "background tab".into()
        };
        println!(
            "{what:16}: {} frames = {:.1} fps (visibility {})",
            s.frames,
            s.fps,
            eval(all[i], "document.visibilityState")
        );
    }
    println!(
        "chrome tree RSS (4 windows/tabs): {:.0} MB",
        tree_rss_mb(b.pid())
    );
    b.close();
    Ok(())
}

/* ------------------------------------------------------------- viewer */

fn viewer_loop(scratch: &Path) -> Result<(), String> {
    let (b, rx) = launch(&scratch.join("Agents"))?;
    let agent = first_page(&b)?;
    navigate(&agent, &rx, INPUT)?;
    hide(&agent);
    let mut raw = [0u8; 16];
    std::io::Read::read_exact(
        &mut std::fs::File::open("/dev/urandom").map_err(|e| e.to_string())?,
        &mut raw,
    )
    .map_err(|e| e.to_string())?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let v = viewer::start(token).map_err(|e| e.to_string())?;
    let phone = Page::open_window(&b, "about:blank")?;
    phone.call("Page.enable", json!({}))?;
    // Not waiting for the load event: the page long-polls for frames.
    phone.call("Page.navigate", json!({ "url": v.url() }))?;
    hide(&phone);

    let stop = AtomicBool::new(false);
    let frames = v.frames.clone();
    let (vw, vh) = (
        eval(&agent, "innerWidth").as_f64().unwrap_or(1280.0),
        eval(&agent, "innerHeight").as_f64().unwrap_or(700.0),
    );
    agent.call(
        "Page.startScreencast",
        json!({ "format": "jpeg", "quality": 60, "maxWidth": 1280, "maxHeight": 1280 }),
    )?;

    let (port, tok) = (v.port, v.token.clone());
    let input = v.input;
    let (stop_r, agent_r, b_r) = (&stop, &agent, &b);
    std::thread::scope(|s| -> Result<(), String> {
        // The Mac side: frames out to the viewer, its input in to the page.
        s.spawn(move || {
            let (stop, agent, b) = (stop_r, agent_r, b_r);
            let mut sent = 0usize;
            while !stop.load(Ordering::Relaxed) {
                if let Ok(ev) = rx.recv_timeout(Duration::from_millis(5)) {
                    if ev.method == "Page.screencastFrame" {
                        ack(b, &ev);
                        if ev.session_id.as_deref() == Some(agent.session_id.as_str()) {
                            frames.push(b64(ev.params["data"].as_str().unwrap_or("")));
                            sent += 1;
                        }
                    }
                }
                while let Ok(i) = input.try_recv() {
                    let _ = match i {
                        Input::Click { fx, fy } => agent.click(fx * vw, fy * vh),
                        Input::Key { text } => agent.type_text(&text),
                    };
                }
            }
            println!("frames relayed to the viewer: {sent}");
        });

        // The "phone": wait for its image, tap where the field is, type.
        if !until(
            &phone,
            "typeof v !== 'undefined' && v.naturalWidth > 0",
            Duration::from_secs(10),
        ) {
            stop.store(true, Ordering::Relaxed);
            let mut raw =
                std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
            let _ = std::io::Write::write_all(
                &mut raw,
                format!("GET /stream?t={tok} HTTP/1.1\r\n\r\n").as_bytes(),
            );
            raw.set_read_timeout(Some(Duration::from_secs(2))).ok();
            let mut buf = vec![0u8; 400];
            let n = std::io::Read::read(&mut raw, &mut buf).unwrap_or(0);
            println!(
                "raw stream head ({n} bytes): {:?}",
                String::from_utf8_lossy(&buf[..n.min(200)])
            );
            return Err(format!(
                "viewer never showed a frame: {}",
                eval(&phone, "JSON.stringify({href: location.href, ready: document.readyState, src: typeof v !== 'undefined' && v.src, w: typeof v !== 'undefined' && v.naturalWidth, complete: typeof v !== 'undefined' && v.complete, vis: document.visibilityState})")
            ));
        }
        let (ix, iy) = agent.center_of("#i")?;
        let rect = eval(&phone, "JSON.stringify(v.getBoundingClientRect())");
        let r: Value = serde_json::from_str(rect.as_str().unwrap_or("{}")).unwrap_or_default();
        let (rl, rt, rw, rh) = (
            r["left"].as_f64().unwrap_or(0.0),
            r["top"].as_f64().unwrap_or(0.0),
            r["width"].as_f64().unwrap_or(1.0),
            r["height"].as_f64().unwrap_or(1.0),
        );
        let t = Instant::now();
        phone.click(rl + ix / vw * rw, rt + iy / vh * rh)?;
        let focused = until(
            &agent,
            "document.activeElement && document.activeElement.id === 'i'",
            Duration::from_secs(3),
        );
        println!(
            "tap on the viewer focused the agent page's field: {focused} ({:.0} ms)",
            ms(t)
        );
        let mut lats = Vec::new();
        for (n, ch) in "hello".chars().enumerate() {
            let t = Instant::now();
            phone.type_text(&ch.to_string())?;
            if until(
                &agent,
                &format!("i.value.length === {}", n + 1),
                Duration::from_secs(3),
            ) {
                lats.push(ms(t));
            }
        }
        println!(
            "viewer key → agent page: {}/5 applied, {:?} ms; field holds {}",
            lats.len(),
            lats.iter().map(|l| l.round() as i64).collect::<Vec<_>>(),
            eval(&agent, "i.value")
        );
        std::thread::sleep(Duration::from_millis(800));
        let _ = shot(&phone, &scratch.join("viewer.jpg"));
        stop.store(true, Ordering::Relaxed);
        Ok(())
    })?;
    let _ = agent.call("Page.stopScreencast", json!({}));
    b.close();
    Ok(())
}

/* ------------------------------------------------------------ persist */

fn cookie_names(b: &Browser, page: &Page, url: &str) -> Vec<String> {
    let _ = b;
    page.call("Network.getCookies", json!({ "urls": [url] }))
        .ok()
        .and_then(|r| r["cookies"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|c| c["name"].as_str().map(String::from))
        .collect()
}

fn persist(scratch: &Path) -> Result<(), String> {
    let profile = scratch.join("Agents");
    {
        let (b, rx) = launch(&profile)?;
        let p = first_page(&b)?;
        hide(&p);
        navigate(&p, &rx, "https://github.com/")?;
        println!(
            "run 1, after visiting github.com: cookies {:?}",
            cookie_names(&b, &p, "https://github.com/")
        );
        b.close();
    }
    let (b, _rx) = launch(&profile)?;
    let p = first_page(&b)?;
    hide(&p);
    println!(
        "run 2, before any navigation: cookies {:?}",
        cookie_names(&b, &p, "https://github.com/")
    );
    b.close();
    Ok(())
}

/* -------------------------------------------------------------- sites */

/// One task: what it does, and how we know it worked.
fn task(page: &Page, rx: &Receiver<Event>, name: &str) -> Result<String, String> {
    match name {
        "example.com: click the link" => {
            navigate(page, rx, "https://example.com/")?;
            let (x, y) = page.center_of("a")?;
            page.click(x, y)?;
            until(
                page,
                "location.host !== 'example.com'",
                Duration::from_secs(15),
            )
            .then(|| eval(page, "location.host").to_string())
            .ok_or("didn't leave example.com".into())
        }
        "wikipedia: search by typing" => {
            navigate(page, rx, "https://en.wikipedia.org/wiki/Main_Page")?;
            let (x, y) = page.settle(5, |p| p.center_of_role(&["searchbox", "combobox"]))?;
            page.click(x, y)?;
            page.type_text("Alan Turing")?;
            page.press_enter()?;
            until(
                page,
                "document.title.startsWith('Alan Turing')",
                Duration::from_secs(15),
            )
            .then(|| eval(page, "document.title").to_string())
            .ok_or(format!("title is {}", eval(page, "document.title")))
        }
        "hacker news: open the top story" => {
            navigate(page, rx, "https://news.ycombinator.com/")?;
            let (x, y) = page.settle(5, |p| p.center_of(".titleline a"))?;
            page.click(x, y)?;
            until(
                page,
                "location.host !== 'news.ycombinator.com'",
                Duration::from_secs(20),
            )
            .then(|| eval(page, "location.host").to_string())
            .ok_or("didn't leave HN".into())
        }
        "duckduckgo: search by typing" => {
            navigate(page, rx, "https://duckduckgo.com/")?;
            let (x, y) = page.settle(5, |p| {
                p.center_of_role(&["combobox", "searchbox", "textbox"])
            })?;
            page.click(x, y)?;
            page.type_text("chrome devtools protocol")?;
            page.press_enter()?;
            until(
                page,
                "location.search.includes('q=')",
                Duration::from_secs(15),
            )
            .then(|| eval(page, "document.title").to_string())
            .ok_or("no results page".into())
        }
        "github: open explore" => {
            navigate(page, rx, "https://github.com/explore")?;
            let t = eval(page, "document.title");
            t.as_str()
                .filter(|t| t.contains("Explore"))
                .map(|_| t.to_string())
                .ok_or(format!("title {t}"))
        }
        "google: search by typing" => {
            navigate(page, rx, "https://www.google.com/")?;
            let (x, y) = page.settle(5, |p| p.center_of_role(&["combobox", "searchbox"]))?;
            page.click(x, y)?;
            page.type_text("chrome devtools protocol")?;
            page.press_enter()?;
            if !until(
                page,
                "location.pathname === '/search' || location.pathname.startsWith('/sorry')",
                Duration::from_secs(15),
            ) {
                return Err(format!("still at {}", eval(page, "location.href")));
            }
            std::thread::sleep(Duration::from_millis(800));
            let blocked = eval(page, "location.pathname.startsWith('/sorry') || /unusual traffic|not a robot/i.test(document.body.innerText)");
            if blocked.as_bool() == Some(true) {
                Err("Google showed its unusual-traffic page".into())
            } else {
                Ok(eval(page, "document.title").to_string())
            }
        }
        _ => Err("unknown task".into()),
    }
}

/// Words that mean a site pushed back, looked for in the page's own text.
const PUSHBACK: &[&str] = &[
    "may not be secure",
    "couldn't sign you in",
    "unusual traffic",
    "verify you are human",
    "are you a robot",
    "captcha",
    "access denied",
    "automated",
    "just a moment",
    "checking your browser",
];

fn look(page: &Page, rx: &Receiver<Event>, url: &str, out: &Path) -> String {
    let load = navigate(page, rx, url);
    std::thread::sleep(Duration::from_millis(2500));
    let text = eval(
        page,
        "document.body ? document.body.innerText.slice(0, 20000).toLowerCase() : ''",
    );
    let hits: Vec<&str> = PUSHBACK
        .iter()
        .copied()
        .filter(|w| text.as_str().is_some_and(|t| t.contains(w)))
        .collect();
    let _ = shot(page, out);
    format!(
        "{} | title {} | final {} | flags {:?} | load {}",
        url,
        eval(page, "document.title"),
        eval(page, "location.host"),
        hits,
        load.map(|m| format!("{m:.0} ms")).unwrap_or_else(|e| e)
    )
}

fn sites(scratch: &Path) -> Result<(), String> {
    let (b, rx) = launch(&scratch.join("Agents"))?;
    let page = first_page(&b)?;
    hide(&page);
    let tasks = [
        "example.com: click the link",
        "wikipedia: search by typing",
        "hacker news: open the top story",
        "duckduckgo: search by typing",
        "github: open explore",
        "google: search by typing",
    ];
    let mut total = (0, 0);
    for name in tasks {
        let mut ok = 0;
        let mut notes = Vec::new();
        for _ in 0..3 {
            let t = Instant::now();
            match task(&page, &rx, name) {
                Ok(r) => {
                    ok += 1;
                    notes.push(format!("ok {:.1}s {r}", t.elapsed().as_secs_f64()));
                }
                Err(e) => notes.push(format!("FAIL {e}")),
            }
        }
        total.0 += ok;
        total.1 += 3;
        println!("{name}: {ok}/3  [{}]", notes.join(" | "));
    }
    println!("tasks: {}/{} succeeded", total.0, total.1);

    let shots = scratch.join("shots");
    let _ = std::fs::create_dir_all(&shots);
    println!("--- bot checks and sign-in pages (looked at, nothing typed) ---");
    for (i, url) in [
        "https://bot.sannysoft.com/",
        "https://nowsecure.nl/",
        "https://www.cloudflare.com/",
        "https://accounts.google.com/signin",
        "https://login.live.com/",
        "https://www.linkedin.com/login",
        "https://www.amazon.com/",
        "https://x.com/i/flow/login",
    ]
    .iter()
    .enumerate()
    {
        println!("{}", look(&page, &rx, url, &shots.join(format!("{i}.jpg"))));
    }
    // sannysoft's own verdicts.
    navigate(&page, &rx, "https://bot.sannysoft.com/")?;
    std::thread::sleep(Duration::from_secs(2));
    println!(
        "sannysoft rows marked failed: {}",
        eval(&page, "JSON.stringify([...document.querySelectorAll('td.failed, td.result.failed')].map(td => (td.previousElementSibling||{}).innerText || td.id))")
    );
    b.close();
    Ok(())
}

fn main() {
    let mut a = std::env::args().skip(1);
    let scratch = PathBuf::from(
        a.next()
            .expect("usage: agent_browser_demo <scratch> <demo|tabs|viewer|persist|sites>"),
    );
    let cmd = a.next().unwrap_or_else(|| "demo".into());
    let r = match cmd.as_str() {
        "demo" => demo(&scratch),
        "tabs" => tabs(&scratch),
        "viewer" => viewer_loop(&scratch),
        "persist" => persist(&scratch),
        "sites" => sites(&scratch),
        _ => Err(format!("unknown command {cmd}")),
    };
    if let Err(e) = r {
        eprintln!("FAILED: {e}");
        std::process::exit(1);
    }
}
