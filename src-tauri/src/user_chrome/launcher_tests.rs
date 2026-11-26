use super::*;
use std::cell::RefCell;

/// A bridge that records what it was sent and answers as told.
struct Fake {
    answer: Box<dyn Fn(&Value) -> Result<Reply, Down>>,
    seen: RefCell<Vec<(u16, String, Value)>>,
}

impl Fake {
    fn new(answer: impl Fn(&Value) -> Result<Reply, Down> + 'static) -> Fake {
        Fake {
            answer: Box::new(answer),
            seen: RefCell::new(Vec::new()),
        }
    }
}

impl Bridge for Fake {
    fn post(&self, port: u16, secret: &str, body: &[u8]) -> Result<Reply, Down> {
        let v: Value = serde_json::from_slice(body).unwrap();
        self.seen
            .borrow_mut()
            .push((port, secret.to_string(), v.clone()));
        (self.answer)(&v)
    }
}

fn endpoint() -> Option<Endpoint> {
    Some(Endpoint {
        port: 4100,
        token: "t".repeat(64),
    })
}

fn run(
    input: &str,
    ep: impl Fn() -> Option<Endpoint>,
    own: Option<String>,
    b: &Fake,
) -> Vec<Value> {
    let mut out = Vec::new();
    assert_eq!(serve(input.as_bytes(), &mut out, ep, own, b), 0);
    String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn relays_each_line_with_the_terminal_secret_and_prints_the_answer() {
    let b = Fake::new(|m| {
        Ok(match m.get("id") {
            Some(id) => {
                Reply::Json(json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true } }))
            }
            None => Reply::Empty,
        })
    });
    let out = run(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"tabs\"}}\n",
        endpoint,
        None,
        &b,
    );
    assert_eq!(out.len(), 2, "a notification gets no answer");
    assert_eq!(out[0]["id"], 1);
    assert_eq!(out[1]["id"], 2);
    let seen = b.seen.borrow();
    assert_eq!(seen.len(), 3, "the notification is relayed too");
    assert!(seen
        .iter()
        .all(|(port, s, _)| *port == 4100 && *s == "t".repeat(64)));
}

#[test]
fn inside_a_project_tab_it_uses_that_tabs_secret() {
    let b = Fake::new(|m| {
        Ok(Reply::Json(
            json!({ "jsonrpc": "2.0", "id": m["id"], "result": {} }),
        ))
    });
    run(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n",
        endpoint,
        Some("p".repeat(64)),
        &b,
    );
    assert_eq!(b.seen.borrow()[0].1, "p".repeat(64));
}

#[test]
fn with_the_app_closed_the_tools_stay_listed_and_a_call_says_so() {
    let b = Fake::new(|_| Err(Down));
    let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"open\",\"arguments\":{\"url\":\"https://example.com\"}}}\n";
    for out in [
        run(input, endpoint, None, &b),
        run(input, || None, None, &b),
    ] {
        assert_eq!(out[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(out[0]["result"]["serverInfo"]["name"], "user_chrome");
        assert!(out[0]["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("ask the user to sign in"));
        let tools = out[1]["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "open"));
        assert_eq!(out[2]["result"]["isError"], true);
        assert_eq!(out[2]["result"]["content"][0]["text"], closed_line());
    }
}

#[test]
fn with_your_chrome_off_a_call_says_turn_it_on() {
    let b = Fake::new(|_| Ok(Reply::Refused));
    let out = run(
        "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"tabs\"}}\n",
        endpoint,
        None,
        &b,
    );
    assert_eq!(out[0]["id"], 7);
    assert_eq!(out[0]["result"]["content"][0]["text"], off_line());
    assert!(off_line().contains("Settings → Chrome"));
}

#[test]
fn a_line_that_isnt_json_gets_a_parse_error_and_the_rest_carry_on() {
    let b = Fake::new(|m| {
        Ok(Reply::Json(
            json!({ "jsonrpc": "2.0", "id": m["id"], "result": {} }),
        ))
    });
    let out = run(
        "not json\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n",
        endpoint,
        None,
        &b,
    );
    assert_eq!(out[0]["error"]["code"], -32700);
    assert_eq!(out[1]["id"], 1);
}

#[test]
fn http_replies_are_read_by_status() {
    let ok = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{\"id\":1}   ";
    assert_eq!(parse_reply(ok), Some(Reply::Json(json!({ "id": 1 }))));
    assert_eq!(
        parse_reply(b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\n\r\n"),
        Some(Reply::Empty)
    );
    assert_eq!(
        parse_reply(b"HTTP/1.1 404 Not Found\r\n\r\nNot found"),
        Some(Reply::Refused)
    );
    assert_eq!(parse_reply(b"garbage"), None);
}

#[test]
fn only_its_own_two_words_start_it() {
    // The test binary's argv is not `mcp user-chrome`.
    assert!(from_argv().is_none());
}
