//! Giving an agent access from the phone, away from the Mac, with the
//! credential ending up only in this Mac's Keychain.
//!
//! Each way in on a login card has a phone path (docs/agents.md, "From the
//! phone"):
//!
//! - **Our own OAuth** (Linear, Notion, Figma, Stripe, Vercel): the phone
//!   runs the provider's real sign-in in the system sign-in sheet
//!   (ASWebAuthenticationSession, ephemeral). This Mac prepares it
//!   ([`begin`]): discovery, registration with the companion app's redirect
//!   (`<companion scheme>://oauth`), and PKCE, whose verifier and `state`
//!   never leave this Mac. The phone gets only the authorization URL. The
//!   sheet comes back with a one-time code, which the phone hands to this
//!   Mac over the paired, Mac-identity-verified channel ([`finish`]); the Mac
//!   exchanges it with its verifier and keeps the token. The relay accepts a
//!   code once, within ten minutes, only from the device that started it,
//!   only on the registered redirect with the right `state`, and never logs
//!   it ([`Table::take`]).
//! - **GitHub** (`gh`): GitHub's device sign-in, run by `gh auth login` on
//!   this Mac ([`gh_device`]). The one-time code is shown on both devices;
//!   it's typed at github.com/login/device on either, and `gh` keeps the
//!   token in its own Keychain item here.
//! - **claude.ai connectors** (Gmail, Calendar, Drive, Slack): added on
//!   claude.ai on the phone, signed in to the same Claude account; this Mac
//!   notices (`logins::watch_claude_ai`). That sign-in is held by claude.ai,
//!   not this Mac, and the card says so.
//! - **An account already connected, the browser, a key**: no sign-in; a
//!   tap, or the masked field, from either device.
//!
//! "Finish on your Mac" is the fallback when a provider won't register the
//! phone's redirect.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

use super::logins::{self, Connector, FlowState, LoginRequest, Method, Origin, Run, TeamCard};
use super::oauth::{self, Callback};
use crate::errors::CommandError;

/// How long a phone sign-in may take, and how long its code is accepted.
pub const SHEET_TIMEOUT: Duration = oauth::SIGN_IN_TIMEOUT;

/// The redirect this Mac registers for a phone sign-in: the companion
/// app's own scheme, which the sign-in sheet hands back to the app that
/// opened it.
pub fn redirect_uri() -> String {
    format!("{}://oauth", crate::brand::COMPANION_SCHEME)
}

/* ---------------------------------------------------------------- relay */

struct Entry<T> {
    device: String,
    request_id: String,
    state: String,
    redirect: String,
    expires: Instant,
    value: T,
}

/// Phone sign-ins waiting for their code. Generic so its rules are tested
/// without a provider.
pub(crate) struct Table<T> {
    map: HashMap<String, Entry<T>>,
}

impl<T> Default for Table<T> {
    fn default() -> Self {
        Self {
            map: HashMap::new(),
        }
    }
}

/// Why a code wasn't taken. `Some(value)` when the sign-in is spent anyway
/// (its card should say so); `None` when it was left alone.
pub(crate) struct Refusal<T> {
    pub spent: Option<T>,
    pub error: CommandError,
}

impl<T> Table<T> {
    #[allow(clippy::too_many_arguments)]
    pub fn insert(
        &mut self,
        flow_id: &str,
        device: &str,
        request_id: &str,
        state: &str,
        redirect: &str,
        expires: Instant,
        value: T,
    ) {
        // One phone sign-in per card: a new one replaces the old.
        self.map.retain(|_, e| e.request_id != request_id);
        self.map.insert(
            flow_id.to_string(),
            Entry {
                device: device.to_string(),
                request_id: request_id.to_string(),
                state: state.to_string(),
                redirect: redirect.to_string(),
                expires,
                value,
            },
        );
    }

    pub fn forget_request(&mut self, request_id: &str) -> Vec<T> {
        let ids: Vec<String> = self
            .map
            .iter()
            .filter(|(_, e)| e.request_id == request_id)
            .map(|(k, _)| k.clone())
            .collect();
        ids.into_iter()
            .filter_map(|k| self.map.remove(&k).map(|e| e.value))
            .collect()
    }

    pub fn contains(&self, flow_id: &str) -> bool {
        self.map.contains_key(flow_id)
    }

    /// Expired sign-ins, removed.
    pub fn expire(&mut self, now: Instant) -> Vec<T> {
        let ids: Vec<String> = self
            .map
            .iter()
            .filter(|(_, e)| e.expires <= now)
            .map(|(k, _)| k.clone())
            .collect();
        ids.into_iter()
            .filter_map(|k| self.map.remove(&k).map(|e| e.value))
            .collect()
    }

    /// The sign-in's code from `callback`, if `device` started it, it hasn't
    /// expired, and the redirect and `state` are the ones this Mac made. The
    /// sign-in is spent by any answer from its own device, right or wrong:
    /// a code is tried once.
    pub fn take(
        &mut self,
        flow_id: &str,
        device: &str,
        callback: &str,
        now: Instant,
    ) -> Result<(T, String), Refusal<T>> {
        let gone = || Refusal {
            spent: None,
            error: CommandError::expected(
                "That sign-in has finished or expired. Start again from the card.",
            ),
        };
        let Some(entry) = self.map.get(flow_id) else {
            return Err(gone());
        };
        if entry.device != device {
            // Not this device's to answer, or to spend.
            return Err(Refusal {
                spent: None,
                error: CommandError::expected("That sign-in was started on another device."),
            });
        }
        let entry = self.map.remove(flow_id).expect("checked above");
        if entry.expires <= now {
            return Err(Refusal {
                spent: Some(entry.value),
                error: CommandError::expected(
                    "Sign-in took too long, so it was stopped. Try again.",
                ),
            });
        }
        match oauth::parse_redirect(callback, &entry.redirect) {
            Callback::Code { code, state } if state == entry.state => Ok((entry.value, code)),
            Callback::Error {
                error,
                state: Some(state),
            } if state == entry.state => Err(Refusal {
                spent: Some(entry.value),
                error: if error == "access_denied" {
                    CommandError::expected("Sign-in was declined.")
                } else {
                    CommandError::expected(format!(
                        "The app's sign-in said: {}.",
                        error.chars().take(80).collect::<String>()
                    ))
                },
            }),
            _ => Err(Refusal {
                spent: Some(entry.value),
                error: CommandError::expected(
                    "That isn't this sign-in's answer, so it was stopped. Try again.",
                ),
            }),
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }
}

/// What a waiting phone sign-in carries on this Mac (never sent anywhere).
struct SignIn {
    run: Run,
    request: LoginRequest,
    server_url: &'static str,
    prepared: oauth::Prepared,
    /// A team row's other cards for the same service, granted once it's in.
    fan: Option<(String, TeamCard, Vec<TeamCard>)>,
}

static TABLE: LazyLock<Mutex<Table<SignIn>>> = LazyLock::new(Default::default);

fn table() -> std::sync::MutexGuard<'static, Table<SignIn>> {
    TABLE.lock().unwrap_or_else(|e| e.into_inner())
}

/// A card's phone sign-in can't finish any more (cancelled, answered).
pub fn forget_request(request_id: &str) {
    let _ = table().forget_request(request_id);
}

/// Which card a phone sign-in is for: one card, or a team row's.
pub enum Target {
    Card {
        agent_id: String,
        request_id: String,
    },
    Team {
        key: String,
        skip: Vec<String>,
    },
}

/// What the phone needs to open the sign-in sheet. No secret: the
/// authorization URL carries the PKCE challenge, never the verifier.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneBegin {
    pub flow_id: String,
    /// The card it signs in for (a team row's first), to cancel it by.
    pub agent_id: String,
    pub request_id: String,
    pub url: String,
    pub redirect_uri: String,
}

pub(crate) fn new_flow_id() -> String {
    use base64::Engine as _;
    let mut buf = [0u8; 24];
    getrandom::getrandom(&mut buf).expect("the OS random source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// The team row's first card that offers `option_id`, and its same-service others.
fn team_pick(
    key: &str,
    option_id: &str,
    skip: &[String],
) -> Result<(String, TeamCard, Vec<TeamCard>), CommandError> {
    let need = logins::team(None)
        .needs
        .into_iter()
        .find(|n| n.key == key)
        .ok_or_else(|| CommandError::expected("Nothing is waiting for that any more."))?;
    let waiting: Vec<TeamCard> = need
        .cards
        .into_iter()
        .filter(|c| c.state == logins::CardState::Waiting && !skip.contains(&c.agent_id))
        .collect();
    let first = waiting
        .iter()
        .find(|c| {
            logins::pending_login(&c.agent_id, &c.request_id)
                .is_ok_and(|r| r.option(option_id).is_some())
        })
        .cloned()
        .ok_or_else(|| CommandError::expected("Nothing on that row can sign in that way."))?;
    let rest = waiting
        .into_iter()
        .filter(|c| c.service == first.service && c.request_id != first.request_id)
        .collect();
    Ok((first.service.clone(), first, rest))
}

/// Get a phone sign-in ready: everything but the sheet, on this Mac.
pub async fn begin(
    app: &AppHandle,
    device_id: &str,
    target: Target,
    option_id: &str,
) -> Result<PhoneBegin, CommandError> {
    let (agent_id, request_id, fan) = match target {
        Target::Card {
            agent_id,
            request_id,
        } => (agent_id, request_id, None),
        Target::Team { key, skip } => {
            let (service, first, rest) = team_pick(&key, option_id, &skip)?;
            (
                first.agent_id.clone(),
                first.request_id.clone(),
                Some((service, first, rest)),
            )
        }
    };
    let request = logins::pending_login(&agent_id, &request_id)?;
    let option = request
        .option(option_id)
        .cloned()
        .ok_or_else(|| super::err_invalid("option", "That isn't one of this card's choices."))?;
    if option.method != Method::Oauth {
        return Err(CommandError::expected(
            "That way in doesn't use a sign-in sheet.",
        ));
    }
    let Some(Connector::Oauth(server_url)) = logins::service(&request.service).map(|s| s.connector)
    else {
        return Err(CommandError::expected("That app has no connector."));
    };
    let run = Run {
        app: app.clone(),
        agent_id: agent_id.clone(),
        request_id: request_id.clone(),
        option: option.id.clone(),
        origin: Origin::phone(true),
    };
    {
        // Checked and marked as one step under the card's claim
        // (`answer_gate`), so the desk's Connect can't start one alongside.
        let _claim = super::answer_gate::claim(&agent_id, &request_id, "Signing in")?;
        if logins::busy(&request_id) {
            return Err(CommandError::expected("It's already signing in."));
        }
        run.set(FlowState::Starting, None);
    }
    let redirect = redirect_uri();
    let prepared = match oauth::prepare(server_url, &redirect).await {
        Ok(p) => p,
        Err(e) => {
            let said = format!(
                concat!(
                    "{} {} won't sign in from a phone, so finish on your ",
                    crate::computer::noun!(),
                    "."
                ),
                e, request.title
            );
            run.fail(said.clone());
            return Err(CommandError::expected(said));
        }
    };
    let flow_id = new_flow_id();
    let url = prepared.url.clone();
    let state = prepared.state.clone();
    run.set(
        FlowState::Waiting,
        Some(format!(
            "{}'s sign-in is open on your phone.",
            request.title
        )),
    );
    table().insert(
        &flow_id,
        device_id,
        &request_id,
        &state,
        &redirect,
        Instant::now() + SHEET_TIMEOUT,
        SignIn {
            run,
            request,
            server_url,
            prepared,
            fan,
        },
    );
    // Give up on it when its time is up, and say so on the card.
    tokio::spawn(async move {
        tokio::time::sleep(SHEET_TIMEOUT + Duration::from_secs(1)).await;
        for s in table().expire(Instant::now()) {
            s.run
                .fail("Sign-in took too long, so it was stopped. Try again.".into());
        }
    });
    Ok(PhoneBegin {
        flow_id,
        agent_id,
        request_id,
        url,
        redirect_uri: redirect,
    })
}

/// The sheet's answer, from the phone: the code is exchanged here, with the
/// verifier only this Mac has, and the token goes into its Keychain.
pub async fn finish(device_id: &str, flow_id: &str, callback: &str) -> Result<(), CommandError> {
    // A sign-in from the phone's apps screen has no card: its own table, the same rules.
    if !table().contains(flow_id) && super::app_connect::is_phone_flow(flow_id) {
        return super::app_connect::phone_finish(device_id, flow_id, callback).await;
    }
    let taken = table().take(flow_id, device_id, callback, Instant::now());
    let (sign_in, code) = match taken {
        Ok(ok) => ok,
        Err(Refusal { spent, error }) => {
            if let Some(s) = spent {
                s.run.fail(error.to_string());
            }
            return Err(error);
        }
    };
    let SignIn {
        run,
        request,
        server_url,
        prepared,
        fan,
    } = sign_in;
    let outcome = prepared
        .exchange(&code)
        .await
        .and_then(|done| logins::connect_oauth(&run, &request, server_url, done));
    match outcome {
        Ok(_) => {
            if let Some((service, first, rest)) = fan {
                logins::fan_out(&run.app, &service, first, rest);
            }
            Ok(())
        }
        Err(e) => {
            run.fail(e.to_string());
            Err(e)
        }
    }
}

/* ------------------------------------------------------- GitHub device */

const GITHUB_DEVICE: &str = "https://github.com/login/device";
/// GitHub's device codes last fifteen minutes.
const DEVICE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The one-time code in a line `gh auth login --web` prints.
pub(crate) fn device_code(line: &str) -> Option<String> {
    let at = line.find("one-time code:")? + "one-time code:".len();
    let code = line[at..].trim();
    let ok = code.len() >= 8
        && code.len() <= 12
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| code.to_string())
}

/// Sign `gh` in on this Mac with GitHub's device sign-in, the code shown on
/// the card (both devices). Returns the account once `gh` has it.
pub(crate) async fn gh_device(run: &Run) -> Result<String, CommandError> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut cmd = tokio::process::Command::from(crate::commands::github::get_gh_command());
    cmd.args([
        "auth",
        "login",
        "--web",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
    ])
    // With no terminal, gh prints the code and waits; it never opens a browser itself.
    .env("GH_BROWSER", "true")
    .env("BROWSER", "true")
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|_| {
        CommandError::expected(concat!(
            "The GitHub CLI isn't installed on this ",
            crate::computer::noun!(),
            ". ⌘K → Connect GitHub account sets it up."
        ))
    })?;
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
    for pipe in [
        stderr.map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        stdout.map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(code) = device_code(&line) {
                    let _ = tx.send(code).await;
                }
            }
        });
    }
    drop(tx);
    let code = tokio::time::timeout(Duration::from_secs(30), rx.recv())
        .await
        .ok()
        .flatten()
        .ok_or_else(|| CommandError::expected("GitHub didn't give a sign-in code. Try again."))?;
    let mut flow = run.flow(
        FlowState::Waiting,
        Some(if run.origin.on_phone {
            "Type this code at github.com/login/device, on your phone or anywhere.".into()
        } else {
            concat!(
                "Type this code at github.com/login/device. It's open in this ",
                crate::computer::noun!(),
                "'s browser."
            )
            .into()
        }),
    );
    flow.user_code = Some(code);
    flow.verification_uri = Some(GITHUB_DEVICE.into());
    run.set_flow(flow, None);
    if !run.origin.on_phone {
        let _ = tauri_plugin_opener::open_url(GITHUB_DEVICE, None::<&str>);
    }
    let status = tokio::time::timeout(DEVICE_TIMEOUT, child.wait())
        .await
        .map_err(|_| {
            CommandError::expected("Sign-in took too long, so it was stopped. Try again.")
        })?
        .map_err(super::err_io)?;
    if !status.success() {
        return Err(CommandError::expected(
            "GitHub's sign-in didn't finish. Try again.",
        ));
    }
    crate::commands::github::invalidate_github_username_cache();
    match crate::commands::github::get_github_username(None).await {
        Ok(login) if !login.trim().is_empty() => Ok(login.trim().to_string()),
        _ => Err(CommandError::expected(
            "GitHub signed in, but the account couldn't be read. Try again.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: &str = "mogbot-companion://oauth";

    fn table_with(flow: &str, device: &str, ttl: Duration) -> (Table<&'static str>, Instant) {
        let mut t = Table::default();
        let now = Instant::now();
        t.insert(flow, device, "req1", "st", R, now + ttl, "card");
        (t, now)
    }

    #[test]
    fn a_code_is_taken_once_from_the_device_that_started_it() {
        let (mut t, now) = table_with("f1", "phone-a", SHEET_TIMEOUT);
        let cb = format!("{R}?code=c1&state=st");
        // Another paired device can't answer it, or spend it.
        let other = t.take("f1", "phone-b", &cb, now).err().unwrap();
        assert!(other.spent.is_none());
        assert_eq!(t.len(), 1);
        // Its own device can, once.
        let (v, code) = t.take("f1", "phone-a", &cb, now).ok().unwrap();
        assert_eq!((v, code.as_str()), ("card", "c1"));
        let again = t.take("f1", "phone-a", &cb, now).err().unwrap();
        assert!(again.spent.is_none());
        assert!(again.error.to_string().contains("finished or expired"));
    }

    #[test]
    fn a_late_code_is_refused_and_spends_the_sign_in() {
        let (mut t, now) = table_with("f1", "phone-a", Duration::from_secs(60));
        let late = now + Duration::from_secs(61);
        let r = t
            .take("f1", "phone-a", &format!("{R}?code=c1&state=st"), late)
            .err()
            .unwrap();
        assert_eq!(r.spent, Some("card"));
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn a_wrong_state_or_redirect_spends_it_without_a_code() {
        for cb in [
            format!("{R}?code=c1&state=forged"),
            "https://evil.test/oauth?code=c1&state=st".to_string(),
            format!("{R}/other?code=c1&state=st"),
            "garbage".to_string(),
        ] {
            let (mut t, now) = table_with("f1", "phone-a", SHEET_TIMEOUT);
            let r = t.take("f1", "phone-a", &cb, now).err().unwrap();
            assert_eq!(r.spent, Some("card"), "{cb}");
            assert_eq!(t.len(), 0);
        }
        let (mut t, now) = table_with("f1", "phone-a", SHEET_TIMEOUT);
        let r = t
            .take(
                "f1",
                "phone-a",
                &format!("{R}?error=access_denied&state=st"),
                now,
            )
            .err()
            .unwrap();
        assert!(r.error.to_string().contains("declined"));
    }

    #[test]
    fn one_phone_sign_in_per_card_and_cancel_forgets_it() {
        let (mut t, now) = table_with("f1", "phone-a", SHEET_TIMEOUT);
        t.insert(
            "f2",
            "phone-a",
            "req1",
            "st2",
            R,
            now + SHEET_TIMEOUT,
            "card",
        );
        assert_eq!(t.len(), 1);
        assert!(t
            .take("f1", "phone-a", &format!("{R}?code=c&state=st"), now)
            .is_err());
        assert_eq!(t.forget_request("req1"), vec!["card"]);
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn expiry_removes_only_what_is_due() {
        let mut t = Table::default();
        let now = Instant::now();
        t.insert("a", "d", "r1", "s", R, now, "due");
        t.insert("b", "d", "r2", "s", R, now + SHEET_TIMEOUT, "later");
        assert_eq!(t.expire(now), vec!["due"]);
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn the_redirect_is_the_companion_apps_own_scheme() {
        assert_eq!(
            redirect_uri(),
            format!("{}://oauth", crate::brand::COMPANION_SCHEME)
        );
    }

    #[test]
    fn reads_gh_s_device_code_and_nothing_else() {
        // As gh 2.95 prints it with no terminal (observed 2026-11).
        assert_eq!(
            device_code("! First copy your one-time code: 9985-8448").as_deref(),
            Some("9985-8448")
        );
        assert!(device_code(
            "Open this URL to continue in your web browser: https://github.com/login/device"
        )
        .is_none());
        assert!(device_code("one-time code: rm -rf /").is_none());
    }
}
