//! "Your Chrome" end to end on this Mac, in a real Google Chrome with the
//! app's extension, entirely on throwaway state:
//!
//! - Chrome runs on a scratch `--user-data-dir` (never the user's own
//!   profile) and is closed at the end. Branded Chrome 137+ ignores
//!   `--load-extension`, so the unpacked extension is loaded the way
//!   Chrome allows on a scratch profile: `Extensions.loadUnpacked` over a
//!   `--remote-debugging-pipe` with `--enable-unsafe-extension-debugging`.
//! - The native host manifest goes into that scratch profile's own
//!   `NativeMessagingHosts`, naming the `user_chrome_host` example.
//! - The link runs in a scratch folder (`DASHBOT_CHROME_LINK_DIR`, honoured
//!   by debug builds only), and the app's data under a scratch `HOME`.
//!
//! Then, through the same MCP dispatch the agent bridge's
//! `/mcp/user-chrome` uses: a turn would get the server; `tabs`, `open` a
//! local page, `get_text`, `read_page`, `find`, `type`, `click` a plain
//! button (no card), a Send button (asks, and with nobody to ask is
//! refused), a password field (refused), `screenshot`, `close_tab`. Then
//! Chrome is closed and the link notices.
//!
//! Build both examples, then run this one with a scratch HOME:
//! `cargo build --example user_chrome_host --example user_chrome_e2e`
//! `HOME=<scratch>/home target/debug/examples/user_chrome_e2e <scratch>`

#![allow(clippy::disallowed_methods, clippy::unwrap_used, clippy::expect_used)]
use app_lib::agent_browser::{cdp, chrome};
use app_lib::agents::store::Agent;
use app_lib::user_chrome::{self, auth, install, tools};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const PAGE: &str = r#"<!doctype html><html><head><title>Dashbot e2e</title></head><body>
<h1>Hello from the e2e page</h1>
<input aria-label="Search" id="q">
<input type="password" aria-label="Password" id="pw">
<button onclick="document.getElementById('out').textContent='shown:'+document.getElementById('q').value">Show</button>
<button onclick="document.getElementById('out').textContent='SENT'">Send</button>
<p id="out">nothing yet</p>
</body></html>"#;

/// A one-page web server on loopback.
static HITS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn serve_page() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        // A thread per connection: Chrome preconnects sockets it may never
        // send a request on.
        for s in l.incoming().flatten() {
            HITS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            std::thread::spawn(move || {
                let mut s = s;
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{PAGE}",
                    PAGE.len()
                );
            });
        }
    });
    port
}

fn text(v: &Value) -> String {
    v["result"]["content"]
        .as_array()
        .map(|c| {
            c.iter()
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn is_error(v: &Value) -> bool {
    v["result"]["isError"] == true
}

fn main() {
    let scratch = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("usage: user_chrome_e2e <scratch dir>"),
    );
    let home = dirs::home_dir().unwrap();
    assert!(
        home.starts_with(&scratch),
        "run with HOME inside the scratch folder, so the app's data is throwaway"
    );
    let link_dir =
        PathBuf::from(std::env::var(auth::DIR_ENV).expect("set DASHBOT_CHROME_LINK_DIR"));
    let udd = scratch.join("chrome-profile");
    let _ = std::fs::remove_dir_all(&udd);
    std::fs::create_dir_all(&udd).unwrap();
    let mut failed: Vec<String> = Vec::new();
    let mut check = |what: &str, ok: bool| {
        println!("{} {what}", if ok { "✓" } else { "✗" });
        if !ok {
            failed.push(what.to_string());
        }
    };

    // --- the host manifest, in the scratch profile only
    // Copied out of the checkout: a binary Chrome starts from ~/Desktop or
    // ~/Documents waits on macOS's folder-access prompt (Chrome is the
    // responsible app), which looks exactly like a hung host. The app's own
    // binary lives in /Applications, where that doesn't arise.
    let built = std::env::current_exe()
        .unwrap()
        .with_file_name("user_chrome_host");
    assert!(built.is_file(), "build the user_chrome_host example first");
    std::fs::create_dir_all(scratch.join("bin")).unwrap();
    let host_exe = scratch.join("bin/user_chrome_host");
    std::fs::copy(&built, &host_exe).unwrap();
    let manifest = install::install_host(&udd, &host_exe).unwrap();
    check(
        "host manifest written into the scratch profile",
        manifest.starts_with(&udd)
            && install::host_state(&udd, &host_exe) == install::HostState::Current,
    );

    // --- the switch on, in the scratch app data
    user_chrome::settings::set_enabled(true).unwrap();
    check(
        "Your Chrome switched on (scratch app data)",
        user_chrome::settings::enabled(),
    );

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let running = rt
        .block_on(user_chrome::start_at(&link_dir, user_chrome::registry()))
        .unwrap();
    check("link listening", running.socket().exists());

    // --- a real Chrome on the scratch profile, the extension loaded unpacked
    let chrome_bin = chrome::find_chrome().expect("Google Chrome is installed");
    // Staged the way the app stages it (and out of ~/Desktop, as above).
    let ext_dir = scratch.join("extension");
    install::stage_extension(
        &install::extension_source().expect("the extension's files"),
        &ext_dir,
    )
    .unwrap();
    let mut args: Vec<String> = vec![
        format!("--user-data-dir={}", udd.display()),
        "--remote-debugging-pipe".into(),
        "--enable-unsafe-extension-debugging".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-sync".into(),
        // HOME is a scratch folder, so there's no login keychain: without
        // this Chrome waits for its "Safe Storage" key before any request
        // goes out, and every page hangs at "loading".
        "--use-mock-keychain".into(),
        "--window-size=1100,800".into(),
    ];
    // Headless (Chrome's new headless runs extensions) where no window can
    // be shown, e.g. a sandboxed shell with no window server: headful
    // windows there are "hidden", never paint, and never load.
    if std::env::var("E2E_HEADLESS").is_ok() {
        args.push("--headless=new".into());
    }
    args.push("about:blank".into());
    let browser = cdp::Browser::launch(&chrome_bin, &args).unwrap();
    let version = browser
        .call(
            "Browser.getVersion",
            json!({}),
            None,
            Duration::from_secs(20),
        )
        .unwrap();
    println!("  Chrome: {}", version["product"].as_str().unwrap_or("?"));
    let loaded = browser.call(
        "Extensions.loadUnpacked",
        json!({ "path": ext_dir.to_string_lossy() }),
        None,
        Duration::from_secs(20),
    );
    let id = loaded
        .as_ref()
        .ok()
        .and_then(|v| v["id"].as_str())
        .unwrap_or("")
        .to_string();
    println!("  loadUnpacked: {loaded:?}");
    check(
        "the extension loads with its fixed dev id",
        id == auth::DEV_EXTENSION_ID,
    );

    // --- the extension finds the host, the host finds the app
    let start = Instant::now();
    while user_chrome::registry().conns().is_empty() && start.elapsed() < Duration::from_secs(30) {
        std::thread::sleep(Duration::from_millis(200));
    }
    let conns = user_chrome::registry().conns();
    if conns.is_empty() {
        sw_state(&browser);
    }
    check(
        "the extension connected through the native host",
        conns.len() == 1,
    );
    if let Some(c) = conns.first() {
        println!(
            "  connected in {:.1}s: profile {} extension {} protocol {}",
            start.elapsed().as_secs_f32(),
            c.profile_id,
            c.extension_version,
            c.protocol
        );
    }

    // --- what a turn sees
    let agent: Agent = serde_json::from_value(json!({
        "id": "e2e_agent", "name": "E2E", "shape": 0, "color": "teal", "createdAt": 0
    }))
    .unwrap();
    let mut codex = agent.clone();
    codex.engine = app_lib::agents::engine::Engine::Codex;
    check(
        "a turn gets the user_chrome server",
        user_chrome::for_turn(&agent, false),
    );
    check(
        "a Codex turn does too",
        user_chrome::for_turn(&codex, false),
    );
    check(
        "a turn answering outside text doesn't",
        !user_chrome::for_turn(&agent, true),
    );

    let port = serve_page();
    let url = format!("http://127.0.0.1:{port}/");
    {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut got = String::new();
        let _ = s.read_to_string(&mut got);
        check(
            "the test page serves",
            got.contains("Hello from the e2e page"),
        );
        // The same page opened by CDP itself, as a baseline.
        let t = browser
            .call(
                "Target.createTarget",
                json!({ "url": std::env::var("E2E_BASELINE").unwrap_or(url.clone()) }),
                None,
                Duration::from_secs(10),
            )
            .unwrap();
        std::thread::sleep(Duration::from_secs(3));
        let targets = browser
            .call("Target.getTargets", json!({}), None, Duration::from_secs(5))
            .unwrap_or_default();
        for x in targets["targetInfos"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            if x["targetId"] == t["targetId"] {
                println!("  baseline via CDP: {} {}", x["url"], x["title"]);
            }
        }
        let _ = browser.call(
            "Target.closeTarget",
            json!({ "targetId": t["targetId"] }),
            None,
            Duration::from_secs(5),
        );
    }
    let mut id = 0;
    let mut call = |name: &str, arguments: Value| -> Value {
        id += 1;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": arguments } });
        let t = Instant::now();
        let out = rt.block_on(tools::dispatch(None, &codex, Some(1), &msg));
        println!(
            "  {name} ({:.0} ms): {}",
            t.elapsed().as_millis(),
            text(&out)
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(110)
                .collect::<String>()
        );
        out
    };

    let r = call("tabs", json!({}));
    check("tabs: none yet", text(&r).contains("No tabs open"));
    let r = call("open", json!({ "url": url }));
    if !text(&r).contains("Dashbot e2e") {
        let targets = browser
            .call("Target.getTargets", json!({}), None, Duration::from_secs(5))
            .unwrap_or_default();
        std::thread::sleep(Duration::from_secs(3));
        for t in targets["targetInfos"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            if t["type"] != "page" {
                continue;
            }
            println!(
                "  target: {} {} {} attached={} (server hits {})",
                t["type"],
                t["url"],
                t["title"],
                t["attached"],
                HITS.load(std::sync::atomic::Ordering::SeqCst)
            );
            let a = browser.call(
                "Target.attachToTarget",
                json!({ "targetId": t["targetId"], "flatten": true }),
                None,
                Duration::from_secs(5),
            );
            if let Ok(a) = a {
                let s = a["sessionId"].as_str().unwrap_or("").to_string();
                let r = browser.call("Runtime.evaluate", json!({ "expression": "JSON.stringify({rs: document.readyState, t: document.title, b: document.body && document.body.innerText.slice(0,40), v: document.visibilityState})", "returnByValue": true }), Some(&s), Duration::from_secs(5));
                println!("    page says: {r:?}");
            }
        }
    }
    check(
        "open: lands on the page",
        !is_error(&r) && text(&r).contains("Dashbot e2e"),
    );
    let r = call("tabs", json!({}));
    check("tabs: lists it", text(&r).contains("Dashbot e2e"));
    let r = call("get_text", json!({}));
    check(
        "get_text: reads the page",
        text(&r).contains("Hello from the e2e page"),
    );
    let r = call("read_page", json!({}));
    let tree = text(&r);
    check(
        "read_page: controls with refs",
        tree.contains("ref_") && tree.contains("\"Send\"") && tree.contains("\"Search\""),
    );
    let ref_for = |label: &str| -> Option<String> {
        tree.lines()
            .find(|l| l.contains(label))
            .and_then(|l| {
                l.split_whitespace()
                    .find(|w| w.starts_with("[ref_") || w.starts_with("ref_"))
            })
            .map(|w| w.trim_matches(|c| c == '[' || c == ']').to_string())
    };
    let (search, show, send, pw) = (
        ref_for("\"Search\""),
        ref_for("\"Show\""),
        ref_for("\"Send\""),
        ref_for("\"Password\""),
    );
    println!("  refs: search {search:?} show {show:?} send {send:?} password {pw:?}");
    let r = call("find", json!({ "query": "Send" }));
    check("find: finds the button", text(&r).contains("Send"));
    if let Some(s) = &search {
        let r = call("type", json!({ "ref": s, "text": "hello chrome" }));
        check("type: into the search box", !is_error(&r));
    }
    if let Some(s) = &show {
        let r = call("click", json!({ "ref": s }));
        check("click: a plain button runs without a card", !is_error(&r));
        let r = call("get_text", json!({}));
        check(
            "the click happened (trusted input)",
            text(&r).contains("shown:hello chrome"),
        );
    }
    if let Some(s) = &send {
        let r = call("click", json!({ "ref": s }));
        check(
            "click Send: asks, and with nobody to ask is refused",
            is_error(&r) && text(&r).contains("user's OK"),
        );
        let r = call("get_text", json!({}));
        check("Send was not clicked", !text(&r).contains("SENT"));
    }
    // A click clears refs (the page may have changed): read again first.
    let _ = call("read_page", json!({}));
    if let Some(p) = &pw {
        let r = call("type", json!({ "ref": p, "text": "hunter2" }));
        check(
            "type into a password field: refused",
            is_error(&r) && text(&r).contains("password"),
        );
    }
    let r = call("screenshot", json!({}));
    let img = r["result"]["content"][0]["data"].as_str().unwrap_or("");
    check(
        "screenshot: a picture",
        r["result"]["content"][0]["type"] == "image" && img.len() > 1000,
    );
    let r = call("scroll", json!({ "direction": "down" }));
    check("scroll", !is_error(&r));
    let r = call("open", json!({ "url": "file:///etc/hosts" }));
    check("open file://: asks (refused here)", is_error(&r));
    let r = call("javascript_tool", json!({}));
    check("no script tool", r["error"]["code"] == -32602);
    let tab = rt
        .block_on(tools::dispatch(None, &codex, Some(1), &json!({ "jsonrpc": "2.0", "id": 99, "method": "tools/call", "params": { "name": "tabs", "arguments": {} } })));
    let tab_id: i64 = text(&tab)
        .split(' ')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    // Another agent can't touch it.
    let other: Agent = serde_json::from_value(json!({
        "id": "someone_else", "name": "Else", "shape": 0, "color": "red", "createdAt": 0
    }))
    .unwrap();
    let r = rt.block_on(tools::dispatch(None, &other, Some(1), &json!({ "jsonrpc": "2.0", "id": 100, "method": "tools/call", "params": { "name": "get_text", "arguments": { "tab": tab_id } } })));
    check("another agent can't read that tab", is_error(&r));
    let r = call("close_tab", json!({ "tab": tab_id }));
    check("close_tab", !is_error(&r));

    // --- the app quits and comes back: the extension reconnects by itself
    running.stop(&user_chrome::registry(), "quit");
    std::thread::sleep(Duration::from_secs(3));
    check(
        "app gone: no connection",
        user_chrome::registry().conns().is_empty(),
    );
    let running = rt
        .block_on(user_chrome::start_at(&link_dir, user_chrome::registry()))
        .unwrap();
    let start = Instant::now();
    while user_chrome::registry().conns().is_empty() && start.elapsed() < Duration::from_secs(90) {
        std::thread::sleep(Duration::from_millis(250));
    }
    check(
        &format!(
            "app back (new token): the extension reconnected on its own in {:.0}s",
            start.elapsed().as_secs_f32()
        ),
        !user_chrome::registry().conns().is_empty(),
    );
    let r = call("open", json!({ "url": url }));
    check("and works again", text(&r).contains("Dashbot e2e"));

    // --- Chrome goes away: the link notices
    browser.close();
    let start = Instant::now();
    while !user_chrome::registry().conns().is_empty() && start.elapsed() < Duration::from_secs(15) {
        std::thread::sleep(Duration::from_millis(200));
    }
    check(
        "Chrome closed: the link drops it",
        user_chrome::registry().conns().is_empty(),
    );
    running.stop(&user_chrome::registry(), "test");
    let _ = std::fs::remove_dir_all(&udd);
    let _ = std::fs::remove_dir_all(&link_dir);

    if failed.is_empty() {
        println!("\nall checks passed");
    } else {
        println!("\nFAILED: {failed:?}");
        std::process::exit(1);
    }
}

/// What the extension's service worker says its link is doing.
fn sw_state(browser: &cdp::Browser) {
    let t = Duration::from_secs(10);
    let targets = browser
        .call("Target.getTargets", json!({}), None, t)
        .unwrap_or_default();
    for target in targets["targetInfos"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        if target["type"] != "service_worker" {
            continue;
        }
        println!("  service worker: {}", target["url"]);
        let Ok(a) = browser.call(
            "Target.attachToTarget",
            json!({ "targetId": target["targetId"], "flatten": true }),
            None,
            t,
        ) else {
            continue;
        };
        let session = a["sessionId"].as_str().unwrap_or("").to_string();
        let r = browser.call(
            "Runtime.evaluate",
            json!({ "expression": "JSON.stringify({state: globalThis.dashbotLink && dashbotLink.state, err: globalThis.dashbotLink && dashbotLink.lastError})", "returnByValue": true }),
            Some(&session),
            t,
        );
        println!("  link: {r:?}");
    }
}
