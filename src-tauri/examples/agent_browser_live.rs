//! The shipped agents' browser, end to end against the real Chrome on this
//! Mac, on a scratch profile (never the app's own): the `browser` MCP
//! tools an agent calls, and a phone sign-in window's frames, taps and
//! checks. Public sites only; nothing is typed into a sign-in page and
//! nothing is submitted.
//!
//! `cargo run --example agent_browser_live -- <scratch dir>`

#![allow(clippy::disallowed_methods, clippy::unwrap_used, clippy::expect_used)]
use app_lib::agent_browser::{chrome, macos, service, signin::SigninWindow, tools};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn text(v: &[Value]) -> String {
    v.iter()
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn step(name: &str, args: Value) -> Result<String, String> {
    let t = Instant::now();
    let r = tools::run("live", name, &args).map(|v| {
        let images = v.iter().filter(|c| c["type"] == "image").count();
        let t = text(&v);
        if images > 0 {
            format!("[{images} image] {t}")
        } else {
            t
        }
    });
    let ms = t.elapsed().as_millis();
    match &r {
        Ok(out) => println!(
            "✓ {name} {args} ({ms} ms)\n    {}",
            out.lines().take(4).collect::<Vec<_>>().join("\n    ")
        ),
        Err(e) => println!("✗ {name} {args} ({ms} ms): {e}"),
    }
    r
}

fn main() {
    let scratch = std::env::args()
        .nth(1)
        .expect("usage: agent_browser_live <scratch dir>");
    let root = std::path::PathBuf::from(scratch).join("agent-browser");
    let profile = root.join("Agents");
    let chrome = chrome::find_chrome().expect("Google Chrome");
    let t = Instant::now();
    let svc = service::launch_at(&chrome, &profile, &root).expect("launched");
    println!(
        "launched pid {} in {} ms",
        svc.browser.pid(),
        t.elapsed().as_millis()
    );
    service::install_for_tests(svc.clone());

    // --- the tools, as an agent calls them
    step("open", json!({ "url": "https://example.com/" })).unwrap();
    let read = step("read_page", json!({})).unwrap();
    let r = read
        .lines()
        .find(|l| l.contains("link"))
        .and_then(|l| l.split("[ref_").nth(1))
        .map(|x| format!("ref_{}", x.trim_end_matches(']')));
    step("screenshot", json!({})).unwrap();
    if let Some(r) = r {
        step("click", json!({ "ref": r })).unwrap();
    }
    step("tabs", json!({})).unwrap();
    step(
        "navigate",
        json!({ "url": "https://en.wikipedia.org/wiki/Main_Page" }),
    )
    .unwrap();
    let found = step("find", json!({ "query": "search" })).unwrap_or_default();
    let search = found
        .lines()
        .find(|l| l.contains("searchbox") || l.contains("combobox"))
        .and_then(|l| l.split("[ref_").nth(1))
        .map(|x| format!("ref_{}", x.trim_end_matches(']')));
    if let Some(s) = search {
        step(
            "type",
            json!({ "ref": s, "text": "Rust (programming language)" }),
        )
        .unwrap();
        step("press", json!({ "key": "Enter" })).unwrap();
        let body = step("get_text", json!({})).unwrap();
        println!("    wikipedia search landed: {}", body.contains("Rust"));
    }
    let _ = step("open", json!({ "url": "file:///etc/hosts" }));
    let _ = step("press", json!({ "key": "cmd+w" }));

    // --- a phone sign-in window: the page loads, frames stream, nothing typed
    for (site, url) in [
        ("github.com", "https://github.com/login"),
        ("google", "https://accounts.google.com/"),
    ] {
        let w = SigninWindow::open(&format!("req_{site}"), "someone_else", url, false).unwrap();
        // The agent it's for waits; this one ("live") is someone else.
        let refused = app_lib::agent_browser::signin::refusal_for("someone_else");
        let t = Instant::now();
        let mut seqs = Vec::new();
        let mut last = 0;
        while t.elapsed() < Duration::from_secs(3) {
            if let Ok(s) = w.frame(last, Duration::from_millis(1500)) {
                if s.seq > last {
                    seqs.push((t.elapsed().as_millis(), s.width, s.height, s.jpeg.len()));
                    last = s.seq;
                }
            }
        }
        let landed = w.location().unwrap();
        println!(
            "sign-in window {site}: {} frames in 3 s (first at {} ms, {}×{}, {} B), at {} \"{}\", sign-in page: {:?}, refuses this window: {:?}, agent waits: {}",
            seqs.len(),
            seqs.first().map(|f| f.0).unwrap_or(0),
            seqs.first().map(|f| f.1).unwrap_or(0),
            seqs.first().map(|f| f.2).unwrap_or(0),
            seqs.first().map(|f| f.3).unwrap_or(0),
            landed.url,
            landed.title,
            app_lib::agents::browser::signed_in("github.com", &landed),
            w.refused_now(),
            refused.is_some(),
        );
        // A tap in the middle of the picture: a real click there (focus only).
        if let Ok(s) = w.frame(0, Duration::from_millis(200)) {
            let _ = w.tap(s.width as f64 / 2.0, s.height as f64 * 0.35);
            std::thread::sleep(Duration::from_millis(300));
            if let Ok(after) = w.frame(s.seq, Duration::from_millis(1500)) {
                println!(
                    "    after a tap: new frame {}, focused field is secret: {}",
                    after.seq > s.seq,
                    after.secret
                );
            }
        }
        w.close();
        println!(
            "    closed; agent waits now: {}",
            app_lib::agent_browser::signin::refusal_for("someone_else").is_some()
        );
    }

    // --- macOS: the agents' Chrome's window, permissions (read only)
    println!("permissions: {:?}", macos::permissions());
    println!(
        "agents' Chrome window: {:?}",
        macos::window_of(svc.browser.pid())
    );
    // The plain window's picture path, on this (scratch) window: one window
    // captured, never the screen. No input is posted (it would move the
    // real cursor on this Mac).
    let win = macos::window_of(svc.browser.pid());
    if let (Some(w), true) = (win, macos::permissions().screen_recording) {
        let dir = root.join("captures");
        std::fs::create_dir_all(&dir).unwrap();
        let t = Instant::now();
        match macos::capture(w.id, &dir, service::FRAME_MAX_WIDTH) {
            Ok((jpeg, fw, fh)) => println!(
                "window capture: {fw}×{fh}, {} B, {} ms; files left: {}",
                jpeg.len(),
                t.elapsed().as_millis(),
                std::fs::read_dir(&dir).unwrap().count()
            ),
            Err(e) => println!("window capture failed: {e}"),
        }
    }

    tools::close_agent("live");
    let t = Instant::now();
    service::shutdown();
    println!(
        "closed in {} ms; exited: {}",
        t.elapsed().as_millis(),
        svc.browser.exited()
    );
}
