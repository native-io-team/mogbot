# Phone ↔ Mac connection after pairing: reliability pass, 2026-11-10

Scope: the link once a phone is paired (transport, connection bar, outbox,
the companion server's route on the tailnet). Pairing and onboarding screens
were out of scope (another agent). Each scenario was checked against the code
and, where it says so, a test that drives the real `DirectTransport` (fake
socket and fake timers in `connectionReliability.node.test.ts`, the mock Mac
over real sockets in `connectionMock.node.test.ts`) or the real companion
server (`companion/server/tests.rs`, `companion/desktop.rs` `keep_tests`).

What "good" means for each: the phone reconnects by itself, quickly (backoff
that resets on foreground and network change); it says one clear thing with
one fix; nothing is lost or doubled; no spinner waits forever.

## Scenarios

| Scenario | Before | After |
| --- | --- | --- |
| **Slow link, 2–5 s round trips** (one bar, a relayed Tailscale path) | Broken. A try had 8 s before it was given up, but opening a socket is three round trips (12–15 s at 4–5 s) and the handshake two more. Every first try was cut off just before it opened; with one route the phone started the same slow handshake again, and only connected on the 3rd or 4th try (~40 s), every reconnect. Coming forward, the 4 s probe also tore a healthy slow socket down. | A socket gets 16–28 s to open; once open, the rest of the handshake gets at least 3× what opening took; the next try gets 2× the last whole handshake (cap 60 s, `tryBudgetMs`). The probe waits 3 measured round trips when slower than 4 s (cap 15 s, `probeWaitMs`). Mock test at 4 s RTT: connected on its first socket in ~14 s (failed before the fix, verified by running the test against the old transport). |
| **Mac asleep / awake** | Works: 40 s of silence is a dead link; foreground waits ≤ 5 s between tries, so the phone is back within seconds of the Mac waking. Bar: "Reconnecting…" for 15 s, then "Can’t reach your Mac", with keep-awake/battery as the first cause when known. | Unchanged. |
| **App on the Mac quit / relaunched** | Works: the Mac closes with 1001, the phone says "Waiting for the app on your Mac" for up to 2 min and resumes from its cursor (replay, or a snapshot after the epoch changed). | Unchanged. |
| **Tailscale off on the phone** | Works: the name doesn't resolve, tries fail fast, bar says "Can’t reach your Mac" with "Tailscale may be off on this phone or on your Mac…". Turning it on is a NetInfo change, which tries at once. | Unchanged. |
| **Tailscale off on the Mac** (or signed out, or it wasn't up yet when the app reopened at login) | Broken on the desk. `tailscale serve` was published only at launch, when switched on, or on Retry. A Mac whose app came up before Tailscale (the common case at login) kept `Failed` and no route until someone pressed Retry on the desk; the phone said "Can’t reach your Mac" the whole time, though everything was up. | The Mac reads Tailscale back every 30 s while the phone server is on (`keep_step`): Tailscale connected and no route → serves it again; off or signed out → the route is reported down ("Tailscale is off or signed out on this Mac."), once. Unit tested; the loop itself (real `tailscale` CLI) is not. |
| **Different Tailscale accounts** (phone on another tailnet) | Works as far as it can: unreachable, and the check says "with the same account on both". | Unchanged. |
| **Phone's Tailscale signed in as another user on the same tailnet** (shared node, multi-user tailnet) | Wrong fix. The Mac refuses a token from another tailnet user with `unauthorized`; the phone stops for good and says "Not paired any more · Pair again". Switching Tailscale back didn't help until the app was relaunched, and pairing again bound the phone to the wrong user. | New refusal `other_account`, sent only to apps listing `refused.otherAccount` (older apps get `unauthorized` as before) and only when the request named a person (a tagged node or local process still hears `unauthorized`). The phone keeps trying (≥ 15 s apart, at once on foreground or a network change) and says "Tailscale on this phone is on another account" with "switch to the account it was paired on". Rust test over a real socket; mock test switches the account and back and resumes by replay. Security: it is still a refusal; someone holding a stolen token as another tailnet user learns only that the token is real, which they already have. |
| **Wi‑Fi ↔ cellular** | Works: a NetInfo change tries at once; an open socket must answer a ping (now `probeWaitMs`) or is replaced. The Mac closes a phone's oldest socket past 4 rather than refusing it (`open_conn`). | Probe wait adapts to the link (above). |
| **Phone backgrounded for hours** | Works: background waits grow to 60 s; coming forward tries at once, starts the quick schedule and the calm 15 s again. Sends waiting more than 10 min become "Not sent · Send" (by design, `OUTBOX_WAIT_MS`). | Covered by a test now. |
| **Mac's tailnet IP changes** | Not an issue: the server binds loopback and the phone uses the `*.ts.net` name. | Unchanged. |
| **Mac's tailnet name changes** (renamed machine, another tailnet) | The Mac kept advertising (and signing) the old name; the route was gone. | The keeper republishes under the new name and the Mac signs the new host. A phone holding only the old name still can't reach it, so it needs pairing again; that limit stays (the phone has no way to learn the new name without reaching the Mac). |
| **MagicDNS / "Use Tailscale DNS" off on the phone** | Looked exactly like Tailscale off; nothing pointed at the setting. | A check under the bar: "If Tailscale is on here, check “Use Tailscale DNS” is on in its settings…". (MagicDNS off for the whole tailnet means no HTTPS certificates, which the desk already reports as needing approval.) |
| **Companion server restart mid-request** | Works: the socket drops, every pending request is rejected at once as `not_connected` (no hanging spinner), sends wait in the outbox and go by `clientId` on the next welcome; the Mac answers a seen `clientId` with the original. | Covered by a test now. |
| **Mac too busy to answer a send in time** (its 20 s deadline) | Wrong and could double. The Mac does the send (the work carries on past the deadline) but answers "Your Mac is busy…". The phone read that as a refusal: "Not sent", and Edit put it back in the composer, so sending it again made a second copy with a new `clientId`. | `unreached` now counts the Mac's busy/fault words and `rate_limited` as "may not have landed": the message keeps waiting and goes again by its `clientId`. Rust test pins the words. Mock test: a send answered busy, sent again, lands once. |
| **A send that timed out on a live link** | Stayed "waiting" until the next reconnect, which on a good link could be hours (then expired as "Not sent"). | Tried again after 3, 8, 20, then every 30 s while the link is up (`RETRY_WAITING_MS`), oldest first per chat. Untested end to end (the session module needs React Native); the pieces it calls are tested. |
| **The Mac's Keychain locked** (`unavailable`) / **too many connections in all** | The phone retried, but the bar said "Can’t reach your Mac · asleep or Tailscale off": wrong causes, since the Mac had answered. | The bar says what the Mac said (`LinkState.macSaid`): "Your Mac can’t open its Keychain right now" (log in on the Mac) / "Your Mac has too many connections open". Clears on the next welcome. |
| **Tailscale certificate renewal** | Not an issue: `tailscale serve` renews the `*.ts.net` certificate itself; the phone pins the Mac's Ed25519 identity, not the certificate, and open sockets aren't affected. A renewal on first request after a long sleep makes that handshake slower, which the longer first try now covers. | Unchanged; documented in docs/mobile.md. |
| **Clock skew** between phone and Mac | Nothing in the link depends on it: the identity proof is a signed challenge with no time, pairing codes expire on the Mac's clock, the outbox and "last heard" use only the phone's clock, and "x min ago" clamps a future time to "just now". One soft spot: Catch up's "since you last looked" compares the Mac's message times with the phone's clock, so a skew of minutes can file a message on the wrong side of that line. | Not changed (would need the Mac's time on the welcome). |
| **Approvals answered offline** | By design the card's answers are disabled while disconnected (an Allow landing later, unwatched, is the thing the app avoids), with the offline note. An answer in flight when the link drops fails with "Not connected…" and the card stays pending; the Mac's one-answer gate makes answering again safe. From a notification, the answer waits for the link and says so if it can't reach. | Unchanged. |
| **Drafts** | Saved to disk on every change and when the app goes to the background; the outbox is written before the composer's draft is cleared. | Unchanged. |

## Desk side

- **Bound correctly after Tailscale reconnects or changes IP**: the server binds
  `127.0.0.1` on a kept port, and Tailscale terminates TLS and proxies to it,
  so an IP change needs nothing. What was missing was putting the serve
  handler back (above).
- **Watchdog**: already probes the phone server's loopback port every few
  seconds and logs a stall with thread stacks (`watchdog.rs`); unchanged.
- **Busy answers**: every request is bounded at 20 s and answered "Your Mac is
  busy…" rather than left silent; 48 at once in all. The phone now treats that
  answer correctly (above).

## Not verified

- The keeper against a real `tailscale` CLI (start the app with Tailscale off,
  turn it on, watch the route come up within 30 s), and on a real phone.
- "Use Tailscale DNS" is the setting's name in the iOS Tailscale app as of
  writing; not re-checked on a device.
- The session-level retry timer for waiting sends (`retryWaitingSoon`) runs
  only in the app; its parts are unit tested, not the timer in place.
