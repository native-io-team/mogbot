use super::*;
use serde_json::json;

const SECRET: &str = "hunter2-correct-horse";

fn opening(device: &str) -> Opening {
    Opening {
        device_id: device.into(),
        device_name: "Sam’s iPhone".into(),
        agent_id: "agent-1".into(),
        request_id: "req-1".into(),
        scope: Scope::for_site("www.figma.com"),
    }
}

fn geom() -> Option<FrameGeom> {
    Some(FrameGeom {
        width: 1000,
        height: 640,
        scale: 2.0,
    })
}

/* ---------------------------------------------------------------- scope */

#[test]
fn the_tab_may_be_on_the_site_and_its_sign_in_providers_only() {
    let figma = Scope::for_site("www.figma.com");
    assert_eq!(figma.domain, "figma.com");
    for ok in [
        "https://www.figma.com/login",
        "https://figma.com/",
        "https://help.figma.com/x",
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https://www.figma.com/finish",
        "https://login.microsoftonline.com/common/oauth2",
        "https://appleid.apple.com/auth/authorize",
        "https://acme.okta.com/login",
        "https://github.com/login/oauth/authorize",
    ] {
        assert!(figma.allows(ok), "{ok}");
    }
    for no in [
        // Lookalikes and tricks.
        "https://figma.com.evil.test/login",
        "https://evilfigma.com/",
        "https://www.figma.com@evil.test/",
        "https://okta.com.evil.test/",
        "https://accounts.google.com.evil.test/",
        // Not https, not the web.
        "http://www.figma.com/login",
        "chrome://settings",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "about:blank",
        // Somewhere else entirely.
        "https://mail.google.com/mail/u/0/",
        "https://example.com/",
        "",
    ] {
        assert!(!figma.allows(no), "{no}");
    }
}

#[test]
fn a_google_site_is_its_own_domain_and_x_signs_in_on_twitter_too() {
    let gmail = Scope::for_site("mail.google.com");
    assert_eq!(gmail.domain, "google.com");
    assert!(gmail.allows("https://mail.google.com/mail/u/0/"));
    assert!(gmail.allows("https://accounts.google.com/signin"));
    let x = Scope::for_site("x.com");
    assert!(x.allows("https://twitter.com/i/flow/login"));
    assert!(!Scope::for_site("www.figma.com").allows("https://twitter.com/"));
}

#[test]
fn it_opens_on_the_account_page_or_the_front_page() {
    assert_eq!(
        start_url("figma", "www.figma.com"),
        "https://www.figma.com/files/recents-and-sharing"
    );
    assert_eq!(start_url("acme", "acme.example"), "https://acme.example/");
}

/* ---------------------------------------------------------------- input */

#[test]
fn what_is_typed_never_shows_in_debug_or_in_an_op() {
    for secure in [true, false] {
        let i = Input::Type {
            text: SECRET.into(),
            secure,
        };
        let d = format!("{i:?}");
        assert!(!d.contains(SECRET) && !d.contains("hunter"), "{d}");
        assert!(d.contains(&SECRET.chars().count().to_string()));
        let op = Op::Input {
            session_id: "s".into(),
            input: i,
        };
        assert!(!format!("{op:?}").contains(SECRET));
        assert!(!format!("{op:#?}").contains(SECRET));
    }
}

#[test]
fn refusals_never_quote_what_was_typed() {
    let long = Input::Type {
        text: format!("{SECRET}{}", "x".repeat(MAX_TEXT)),
        secure: true,
    };
    let why = long.check(geom()).unwrap_err();
    assert!(!why.contains(SECRET));
    let control = Input::Type {
        text: format!("{SECRET}\n"),
        secure: true,
    };
    assert!(!control.check(geom()).unwrap_err().contains(SECRET));
    assert!(Input::Type {
        text: String::new(),
        secure: false
    }
    .check(geom())
    .is_err());
    assert!(Input::Type {
        text: SECRET.into(),
        secure: true
    }
    .check(geom())
    .is_ok());
}

#[test]
fn taps_are_inside_the_frame_and_mapped_onto_the_tab() {
    assert!(Input::Tap { x: 10.0, y: 10.0 }.check(None).is_err());
    assert!(Input::Tap { x: -1.0, y: 10.0 }.check(geom()).is_err());
    assert!(Input::Tap { x: 1001.0, y: 10.0 }.check(geom()).is_err());
    assert!(Input::Tap {
        x: f64::NAN,
        y: 1.0
    }
    .check(geom())
    .is_err());
    let tap = Input::Tap { x: 100.4, y: 50.0 };
    assert!(tap.check(geom()).is_ok());
    let (tool, args) = tap.call(7, geom(), "https://www.figma.com/login");
    assert_eq!(tool, "computer");
    assert_eq!(
        args,
        json!({ "action": "left_click", "coordinate": [201, 100], "tabId": 7 })
    );
    let scroll = Input::Scroll {
        x: 10.0,
        y: 10.0,
        direction: Direction::Down,
        amount: 11,
    };
    assert!(scroll.check(geom()).is_err());
}

#[test]
fn keys_are_a_short_list_with_no_shortcuts() {
    for bad in [
        json!({ "kind": "key", "key": "cmd+l" }),
        json!({ "kind": "key", "key": "cmd+w" }),
        json!({ "kind": "key", "key": "F12" }),
        json!({ "kind": "navigate", "url": "https://evil.test" }),
        json!({ "kind": "javascript", "text": "1" }),
    ] {
        assert!(
            serde_json::from_value::<Input>(bad.clone()).is_err(),
            "{bad}"
        );
    }
    let enter: Input = serde_json::from_value(json!({ "kind": "key", "key": "enter" })).unwrap();
    assert_eq!(
        enter.call(3, None, "").1,
        json!({ "action": "key", "text": "Enter", "tabId": 3 })
    );
    let back: Input = serde_json::from_value(json!({ "kind": "back" })).unwrap();
    assert_eq!(back.call(3, None, "").0, "navigate");
    assert_eq!(back.call(3, None, "").1["url"], "back");
    // Reload goes where the tab already is: the phone names no URL.
    let reload: Input = serde_json::from_value(json!({ "kind": "reload" })).unwrap();
    assert_eq!(
        reload.call(3, None, "https://www.figma.com/login").1["url"],
        "https://www.figma.com/login"
    );
}

/* ---------------------------------------------------------------- table */

#[test]
fn only_the_device_that_began_it_can_use_it() {
    let now = Instant::now();
    let mut t: Table<()> = Table::default();
    let (id, _) = t.begin(opening("phone-a"), (), now, 0).ok().unwrap();
    assert!(t.check("phone-a", &id, now).is_ok());
    assert_eq!(t.check("phone-b", &id, now).err(), Some(Refusal::NotYours));
    assert_eq!(t.touch("phone-b", &id, now), Err(Refusal::NotYours));
    // Another device's refusal leaves it alone.
    assert!(t.check("phone-a", &id, now).is_ok());
    assert_eq!(
        t.check("phone-a", "signin_guess", now).err(),
        Some(Refusal::Gone)
    );
}

#[test]
fn one_at_a_time_and_another_phone_is_refused() {
    let now = Instant::now();
    let mut t: Table<u8> = Table::default();
    let (first, _) = t.begin(opening("phone-a"), 1, now, 0).ok().unwrap();
    let Err((why, back)) = t.begin(opening("phone-b"), 2, now, 0) else {
        panic!("a second phone got in");
    };
    assert_eq!((why, back), (Refusal::Busy, 2));
    // The same phone starting again replaces its own (and gets it back to close).
    let (second, replaced) = t.begin(opening("phone-a"), 3, now, 0).ok().unwrap();
    assert_ne!(first, second);
    assert_eq!(replaced.map(|l| l.extra), Some(1));
    assert_eq!(t.check("phone-a", &first, now).err(), Some(Refusal::Gone));
}

#[test]
fn five_idle_minutes_end_it_and_input_keeps_it_going() {
    let start = Instant::now();
    let mut t: Table<()> = Table::default();
    let (id, _) = t.begin(opening("phone-a"), (), start, 0).ok().unwrap();
    let four = start + Duration::from_secs(4 * 60);
    t.touch("phone-a", &id, four).unwrap();
    // Eight minutes in, four since the last input: still going.
    let eight = start + Duration::from_secs(8 * 60);
    assert!(t.check("phone-a", &id, eight).is_ok());
    assert!(t.expire(eight).is_none());
    // Five since the last input: gone, and it says why.
    let nine = four + IDLE;
    assert_eq!(t.check("phone-a", &id, nine).err(), Some(Refusal::TimedOut));
    assert!(t.current().is_none());
    // A frame poll isn't input: looking alone doesn't keep it open.
    let (id, _) = t.begin(opening("phone-a"), (), start, 0).ok().unwrap();
    for m in 1..5 {
        assert!(t
            .check("phone-a", &id, start + Duration::from_secs(m * 60))
            .is_ok());
    }
    assert!(t.expire(start + IDLE).is_some());
}

#[test]
fn twenty_minutes_ends_it_however_busy() {
    let start = Instant::now();
    let mut t: Table<()> = Table::default();
    let (id, _) = t.begin(opening("phone-a"), (), start, 0).ok().unwrap();
    for m in 1..20 {
        t.touch("phone-a", &id, start + Duration::from_secs(m * 60))
            .unwrap();
    }
    assert_eq!(
        t.touch("phone-a", &id, start + MAX_AGE),
        Err(Refusal::TimedOut)
    );
}

#[test]
fn an_expired_session_lets_another_phone_in() {
    let start = Instant::now();
    let mut t: Table<()> = Table::default();
    t.begin(opening("phone-a"), (), start, 0).ok().unwrap();
    assert!(t.begin(opening("phone-b"), (), start + IDLE, 0).is_ok());
}

#[test]
fn the_desk_can_stop_any_session() {
    let now = Instant::now();
    let mut t: Table<()> = Table::default();
    let (id, _) = t.begin(opening("phone-a"), (), now, 0).ok().unwrap();
    assert!(t.take("other").is_none());
    assert!(t.take_any().is_some());
    assert_eq!(t.check("phone-a", &id, now).err(), Some(Refusal::Gone));
}

/* --------------------------------------------------------------- frames */

#[test]
fn a_screenshot_becomes_a_jpeg_no_wider_than_the_phone_needs() {
    use base64::Engine as _;
    let mut png = Vec::new();
    image::RgbImage::from_pixel(2000, 1250, image::Rgb([200, 200, 200]))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let result = json!({ "content": [
        { "type": "text", "text": "Took a screenshot" },
        { "type": "image", "mimeType": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(&png) },
    ]});
    let (jpeg, g) = scale_frame(&result).unwrap();
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
    assert_eq!((g.width, g.height), (FRAME_WIDTH, 625));
    assert!((g.scale - 2.0).abs() < 1e-9);
    assert!(scale_frame(&json!({ "content": [{ "type": "text", "text": "no" }] })).is_err());
}

#[test]
fn chromes_own_permission_prompt_is_recognised() {
    assert!(waiting_on_mac("No response to the Claude in Chrome permission prompt before it timed out, so the action was not run."));
    assert!(!waiting_on_mac("Navigation failed"));
}

#[test]
fn the_wire_shapes() {
    let f = Frame {
        state: FrameState::Outside,
        host: Some("example.com".into()),
        image: None,
        width: 0,
        height: 0,
    };
    assert_eq!(
        serde_json::to_value(&f).unwrap(),
        json!({ "state": "outside", "host": "example.com", "width": 0, "height": 0 })
    );
    assert_eq!(
        serde_json::to_value(Outcome::SignedOut).unwrap(),
        json!("signed_out")
    );
}

/* ------------------------------------------------------ who can call it */

#[test]
fn no_agent_tool_reaches_it() {
    // The agents' MCP tools (every role's list) name nothing that drives a
    // phone sign-in: it's a companion method, for a paired phone only.
    let src = include_str!("mcp.rs");
    for word in ["signin", "phone_signin", "sign_in_from"] {
        assert!(
            !src.contains(&format!("name: \"{word}")),
            "an agent tool named {word}"
        );
    }
    assert!(!src.contains("phone_signin::"));
}

#[test]
fn agents_are_kept_out_of_the_browser_while_it_runs() {
    use super::super::browser_gate::{while_phone_signs_in, Gate, PHONE_SIGNIN_REFUSAL};
    assert_eq!(
        while_phone_signs_in(true),
        Some(Gate::Refuse(PHONE_SIGNIN_REFUSAL.into()))
    );
    assert_eq!(while_phone_signs_in(false), None);
    // `gate` asks it first, before any level or rule.
    let src = include_str!("browser_gate.rs");
    let gate = &src[src.find("pub fn gate(").unwrap()..];
    let check = gate
        .find("while_phone_signs_in(super::phone_signin::live())")
        .unwrap();
    assert!(check < gate.find("independence::for_turn").unwrap());
}
