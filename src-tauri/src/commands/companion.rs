//! The Phone panel's commands: turn the companion on, show a pairing code,
//! Allow or Deny a phone, and see or remove paired devices. The server
//! itself is `crate::companion`.

use serde::Serialize;
use tauri::AppHandle;

use crate::companion::pairing::{Decision, PairingView};
use crate::companion::{actor_for, desktop, now_ms, wire};
use crate::errors::CommandError;
use crate::remote_access::tailscale;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    pub enabled: bool,
    /// The loopback server is up.
    pub running: bool,
    /// The tailnet route, as read back from Tailscale.
    pub serve: desktop::ServeState,
    pub tailscale: tailscale::TailscaleState,
    pub devices: Vec<wire::Device>,
    pub pairing: PairingView,
    /// Each device's latest action, by device id (absent: none recorded).
    pub activity: std::collections::HashMap<String, PhoneActivity>,
    /// What a paired phone can call on this Mac (`welcome.methods`).
    pub methods: Vec<&'static str>,
    /// Phone notifications through the push relay.
    pub push: crate::companion::push::PushView,
    /// The phone relay (docs/relay.md): whether this Mac is signed in there,
    /// and the account its key is linked to. Connected with an account is a
    /// route by itself, with or without Tailscale.
    pub relay: crate::companion::relay::RelayStatus,
}

/// One line of a phone's audit trail: what it did, and when.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneActivity {
    pub tool: String,
    pub detail: String,
    pub ok: bool,
    pub at_ms: u64,
}

/// Audit lines that are presence or pairing, not something the phone did
/// (connecting is already "Connected now" / "Last seen"). `agents.focus` is a
/// chat coming on screen, logged often and saying little.
const NOT_ACTIVITY: &[&str] = &[
    "connected",
    "refused",
    "pair_request",
    "paired",
    "pair_denied",
    "pair_timeout",
    "revoked",
    "agents.focus",
];

fn activity(devices: &[wire::Device]) -> std::collections::HashMap<String, PhoneActivity> {
    let actors: Vec<String> = devices.iter().map(|d| actor_for(&d.name)).collect();
    let mut latest = crate::remote_access::latest_by_actor(&actors, NOT_ACTIVITY);
    devices
        .iter()
        .filter_map(|d| {
            let e = latest.remove(&actor_for(&d.name))?;
            Some((
                d.id.clone(),
                PhoneActivity {
                    tool: e.tool,
                    detail: e.detail,
                    ok: e.ok,
                    at_ms: e.at_ms,
                },
            ))
        })
        .collect()
}

async fn read_status(app: &AppHandle) -> PhoneStatus {
    let c = desktop::ensure(app);
    let devices = c.device_views();
    let activity = {
        let devices = devices.clone();
        tokio::task::spawn_blocking(move || activity(&devices))
            .await
            .unwrap_or_default()
    };
    let mut pairing = c.pairing.view(now_ms());
    if let Some(request) = pairing.request.as_mut() {
        // Phones it looks like: offered for replacing, never replaced unasked.
        request.replaces = c
            .registry
            .same_phones(&request.device)
            .iter()
            .map(|d| d.view(c.is_connected(&d.id)))
            .collect();
    }
    PhoneStatus {
        enabled: c.registry.read(|s| s.enabled),
        running: desktop::running_port().is_some(),
        serve: desktop::serve_state(),
        tailscale: tailscale::status().await,
        devices,
        pairing,
        activity,
        methods: crate::companion::router::METHODS.to_vec(),
        push: c.push.view(&c),
        relay: crate::companion::relay::status(),
    }
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_status(app: AppHandle) -> Result<PhoneStatus, CommandError> {
    Ok(read_status(&app).await)
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<PhoneStatus, CommandError> {
    desktop::set_enabled(&app, enabled).await?;
    Ok(read_status(&app).await)
}

/// "Phone notifications via Ship Studio's push service". Off tells the
/// relay to forget this Mac and every token it registered.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_set_push(
    app: AppHandle,
    enabled: bool,
) -> Result<PhoneStatus, CommandError> {
    let c = desktop::ensure(&app);
    crate::companion::push::set_enabled(&c, enabled).await?;
    Ok(read_status(&app).await)
}

/// "Sign in": link this Mac's key to an account at the relay. The code goes
/// on the Mac's own signed-in relay socket and the sign-in page opens in the
/// browser; the account arrives on that socket, and the desk hears it as a
/// status change.
#[tauri::command]
#[tracing::instrument]
pub async fn companion_account_sign_in() -> Result<(), CommandError> {
    if crate::companion::relay::relay_url().is_none() {
        return Err(CommandError::expected(
            "This build has no relay to sign in to. Your phone reaches this Mac over Tailscale.",
        ));
    }
    if crate::companion::relay::status().state == crate::companion::relay::RelayState::Off {
        return Err(CommandError::expected(
            "Turn on phone access first: signing in goes through this Mac's connection to the relay.",
        ));
    }
    let page = crate::companion::relay::link_start()
        .await
        .map_err(CommandError::expected)?;
    tauri_plugin_opener::open_url(&page, None::<&str>).map_err(|e| {
        tracing::warn!("[Relay] couldn't open the sign-in page: {e}");
        CommandError::expected("The sign-in page didn't open in your browser. Try again.")
    })
}

/// "Sign out": unlink this Mac from its account at the relay. Phones go on
/// reaching it over Tailscale; over the relay, only once it's signed in again.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_account_sign_out(app: AppHandle) -> Result<(), CommandError> {
    crate::companion::relay::unlink()
        .await
        .map_err(CommandError::expected)?;
    desktop::ensure(&app).backend.changed();
    Ok(())
}

/// "Delete my account": the relay removes the account at the sign-in
/// service (its email and id) and unlinks this Mac. Nothing on this Mac is
/// deleted: agents, chats and phones stay; phones keep Tailscale if they had it.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_account_delete(app: AppHandle) -> Result<(), CommandError> {
    crate::companion::relay::delete_account()
        .await
        .map_err(CommandError::expected)?;
    desktop::ensure(&app).backend.changed();
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_retry_tailscale(app: AppHandle) -> Result<PhoneStatus, CommandError> {
    desktop::retry_publish(&app).await?;
    Ok(read_status(&app).await)
}

/// The phones signed in to this Mac's Tailscale account: onboarding's live
/// check that Tailscale is on the phone, on the same account.
#[tauri::command]
#[tracing::instrument]
pub async fn companion_tailnet_phones() -> Result<Vec<tailscale::TailnetPhone>, CommandError> {
    Ok(tailscale::phones().await)
}

/// A QR code for a store or download page, so a phone can open it by
/// pointing its camera at the screen (Tailscale on the App Store, the
/// phone app's TestFlight). Web pages only.
#[tauri::command]
#[tracing::instrument]
pub async fn companion_link_qr(url: String) -> Result<QrMatrix, CommandError> {
    if !url.starts_with("https://") || url.len() > 512 || url.chars().any(char::is_whitespace) {
        return Err(CommandError::expected(
            "Only a web page's address can be shown as a code.",
        ));
    }
    qr_matrix(&url)
}

/// A QR code's modules, row by row, `1` for dark.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrMatrix {
    pub size: u32,
    pub modules: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    /// `<PAIRING_SCHEME>://pair?d=…`: what the QR code says, for pasting.
    pub link: String,
    pub qr: QrMatrix,
    pub expires_at: u64,
}

/// Low error correction: the code is read off a screen, not a crumpled
/// label, and fewer modules make each one bigger for the camera.
fn qr_matrix(text: &str) -> Result<QrMatrix, CommandError> {
    use qrcodegen::{QrCode, QrCodeEcc};
    let qr = QrCode::encode_text(text, QrCodeEcc::Low)
        .map_err(|e| CommandError::from(format!("QR code: {e:?}")))?;
    let size = qr.size();
    let modules = (0..size)
        .flat_map(|y| (0..size).map(move |x| (x, y)))
        .map(|(x, y)| if qr.get_module(x, y) { '1' } else { '0' })
        .collect();
    Ok(QrMatrix {
        size: size as u32,
        modules,
    })
}

/// Issue a one-time code (replacing any earlier one) and the QR code for it.
/// Only offered once the phone has a route to this Mac.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_pair_start(app: AppHandle) -> Result<PairingCode, CommandError> {
    let c = desktop::ensure(&app);
    let routes = desktop::routes();
    if routes.is_empty() {
        // With our relay, Tailscale is one of two ways; without it, the only one.
        return Err(CommandError::expected(
            if crate::companion::relay::relay_url().is_some() {
                "Your phone can't reach this Mac yet. Turn on phone access, then sign in or use your own Tailscale."
            } else {
                "Your phone can't reach this Mac yet. Turn on phone access and wait for Tailscale."
            },
        ));
    }
    // The phone pins this key for good: only offer it once it's kept where
    // the next launch will find it (and after any reset that changes the id).
    let identity = c
        .registry
        .identity()
        .filter(|_| c.registry.identity_is_durable());
    let Some(identity) = identity else {
        return Err(CommandError::expected(
            "This Mac can't keep its identity key in the Keychain, so it can't pair a phone safely. Unlock the Keychain (or check Keychain Access) and try again.",
        ));
    };
    // Exactly one route: the host the phone shows is the only one it tries.
    // The relay's when this Mac is signed in there, else Tailscale's; the
    // phone learns the others from the Mac's status once it's connected.
    let routes = routes.into_iter().take(1).collect();
    let (code, expires_at) = c.pairing.start(now_ms());
    let link = wire::PairingLink {
        v: 1,
        code,
        server_id: c.registry.server_id(),
        name: c.backend.server_name(),
        routes,
        fingerprint: identity.fingerprint(),
    }
    .format();
    let qr = qr_matrix(&link)?;
    c.backend.changed();
    Ok(PairingCode {
        link,
        qr,
        expires_at,
    })
}

#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_pair_cancel(app: AppHandle) -> Result<(), CommandError> {
    let c = desktop::ensure(&app);
    c.pairing.cancel();
    c.backend.changed();
    Ok(())
}

/// Allow or Deny the phone waiting at the desk: the request the panel was
/// showing (`request_id`), so a click can't land on another that arrived
/// meanwhile. `replace` lists paired phones to remove on Allow, and only
/// ones the panel offered (`PairingView.request.replaces`) are taken.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_pair_decide(
    app: AppHandle,
    request_id: String,
    allow: bool,
    replace: Option<Vec<String>>,
) -> Result<(), CommandError> {
    let c = desktop::ensure(&app);
    let decision = decision_for(&c, &request_id, allow, replace.unwrap_or_default());
    let answered = c.pairing.decide(&request_id, decision);
    c.backend.changed();
    answered.map(|_| ()).ok_or_else(|| {
        CommandError::expected("That phone stopped waiting, or another one asked. Look again.")
    })
}

/// Allow (replacing only phones the desk was offered) or Deny.
fn decision_for(
    c: &crate::companion::Companion,
    request_id: &str,
    allow: bool,
    replace: Vec<String>,
) -> Decision {
    if !allow {
        return Decision::Deny;
    }
    let view = c.pairing.view(now_ms());
    let offered: Vec<String> = view
        .request
        .filter(|r| r.id == request_id)
        .map(|r| {
            c.registry
                .same_phones(&r.device)
                .into_iter()
                .map(|d| d.id)
                .collect()
        })
        .unwrap_or_default();
    Decision::Allow {
        replace: replace
            .into_iter()
            .filter(|id| offered.contains(id))
            .collect(),
    }
}

/// Remove a paired phone: its token stops working and its sockets close now.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn companion_revoke(
    app: AppHandle,
    device_id: String,
) -> Result<PhoneStatus, CommandError> {
    desktop::ensure(&app).revoke(&device_id)?;
    Ok(read_status(&app).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pairing_link_fits_a_scannable_qr_code() {
        let link = wire::PairingLink {
            v: 1,
            code: crate::companion::pairing::new_code(),
            server_id: "srv_0123456789abcdef".into(),
            name: "Julian’s MacBook Pro".into(),
            routes: vec![wire::Route {
                kind: wire::RouteKind::Tailscale,
                url: "https://julians-macbook-pro.tail1234.ts.net:47443".into(),
                pin: None,
            }],
            fingerprint: "Zmh6rfhivXdsj8GLjp-OIA".into(),
        }
        .format();
        let qr = qr_matrix(&link).unwrap();
        assert_eq!(qr.modules.len(), (qr.size * qr.size) as usize);
        assert!(qr.modules.chars().all(|c| c == '0' || c == '1'));
        // Small enough to scan comfortably off a laptop screen.
        assert!(qr.size <= 81, "version {} is too dense", (qr.size - 17) / 4);
    }

    #[tokio::test]
    async fn allow_replaces_only_a_phone_the_desk_was_offered() {
        use crate::companion::pairing::Claim;
        use crate::companion::testkit::Stub;
        let (c, _) = Stub::companion();
        let phone = wire::PairDevice {
            name: "Sam’s iPhone".into(),
            platform: wire::DevicePlatform::Ios,
            model: Some("iPhone 16".into()),
            app_version: "1.0.0".into(),
            build: wire::BuildKind::Official,
        };
        let (old, _, _) = c.registry.add(&phone, String::new(), 1, &[], None).unwrap();
        let (other, _, _) = c
            .registry
            .add(
                &wire::PairDevice {
                    name: "iPad".into(),
                    ..phone.clone()
                },
                String::new(),
                1,
                &[],
                None,
            )
            .unwrap();
        let (code, _) = c.pairing.start(now_ms());
        let Claim::Waiting(_rx) =
            c.pairing
                .claim(&code, phone.clone(), String::new(), "s", None, now_ms())
        else {
            panic!()
        };
        let id = c.pairing.view(now_ms()).request.unwrap().id;
        // The iPad wasn't offered, so asking to replace it does nothing.
        let d = decision_for(&c, &id, true, vec![old.id.clone(), other.id.clone()]);
        assert_eq!(
            d,
            Decision::Allow {
                replace: vec![old.id.clone()]
            }
        );
        assert_eq!(
            decision_for(&c, "pr_other", true, vec![old.id.clone()]),
            Decision::Allow { replace: vec![] }
        );
        assert_eq!(decision_for(&c, &id, false, vec![old.id]), Decision::Deny);
    }
}
