# Mobile companion

The app on your phone. The Mac does all the work; the phone is a thin
client paired by QR code. It shows the same agents, chats, approvals,
check-ins, projects and sessions as the desk, in sync both ways, over your own
Tailscale tailnet.

| Part | Where |
| --- | --- |
| Wire types (the contract) | [`packages/companion-protocol`](../packages/companion-protocol/src/index.ts) |
| Desktop server | `src-tauri/src/companion/`, commands in `src-tauri/src/commands/companion*.rs` |
| Desktop Phone page (Settings → Phone) | `src/components/phone/`, `src/lib/companion.ts`, `src/lib/companionInstall.ts` |
| Expo app | `mobile/` (running it and the mock Mac: [mobile/README.md](../mobile/README.md)) |
| Push relay | `services/push-relay/` ([push-relay.md](push-relay.md)) |

Where this doc and the types disagree, fix whichever is wrong in the same
commit.

## Principles

- **Mirror, don't invent.** Every method calls an existing desktop command,
  and every event mirrors a desktop event (`agents://*`) or the state behind
  one. The logic the desk runs is the logic the phone runs.
- **Nothing in the middle.** The phone talks to the Mac directly. Funnel is
  never used; the only service of ours involved is the optional, content-free
  push relay.
- **Say what's known.** The phone shows whether the Mac can be reached, is
  awake, is running the app and has an engine signed in. What it can't
  observe it calls unknown, never guesses.
- **The phone is a remote surface.** It gets the agents' own refusals and a
  few stricter ones (below), and it can't push to git, manage other devices,
  or type into a plain terminal.

## Architecture

```
 iPhone / Android (Expo)                     Mac (desktop app, Tauri)
┌──────────────────────────┐            ┌──────────────────────────────────────────┐
│ screens (expo-router)    │            │ companion::server (hyper)                │
│ store (zustand) + JSON   │  tailnet   │   127.0.0.1:P ◀── tailscale serve        │
│   cache, drafts, outbox  │ ─ HTTPS ─▶ │                   --https=47443          │
│ DirectTransport          │ (ts.net    │   auth · rate limit · audit              │
│   one WebSocket + HTTP   │  cert)     │ hub: journal (epoch, seq) ◀── agents://* │
│ expo-notifications       │            │ router ─▶ commands/agents.rs (same fns)  │
└──────────────────────────┘            │        ─▶ remote_access::tools cores     │
              ▲                         │ push ─▶ push relay (Worker) ─▶ APNs/FCM  │
              └──── APNs / FCM ◀────────┴──────────────────────────────────────────┘
```

**Server modules** (`src-tauri/src/companion/`):

| File | Contents |
| --- | --- |
| `mod.rs` | Config and the device registry (`companion.json`, 0600), lifecycle, limits |
| `server.rs` | The listener, HTTP routes, WebSocket upgrade and socket loop |
| `pairing.rs` | Codes, the desk confirmation (by request id), token issue, per-source backoff |
| `identity.rs` | The Mac's Ed25519 identity key: the pairing link's fingerprint, and the proofs it gives before any secret is sent (`/v1/identity`, the socket's `identity` frame, pairing answers), each covering the hosts it serves on |
| `keystore.rs` | Where that key is kept: the login Keychain (moved there once from `companion.json`) |
| `limits.rs` | The connection gate (strangers evicted first, authenticated sockets never), per-source caps, Host/Origin checks, failed-connection audit folding |
| `hub.rs` | Event journal, fan-out, draft appends |
| `router.rs` | `method` → command function; `METHODS` and `READ_ONLY_METHODS` |
| `desktop.rs` | The bridge to the running app: events in, status and projects out |
| `projects.rs` | The project watcher behind `projects.changed` / `projects.removed` |
| `blobs.rs`, `files.rs` | Staged uploads, and serving blobs and attachments |
| `push.rs` | The `Notifier` trait, `ApnsPush` through the relay, `devices.setPush` |
| `wire.rs` | The Rust side of the wire types |
| `fixtures.rs`, `testkit.rs` | Test-only: the fixture generator and shared test data |

The router calls the **command functions** in `commands/agents.rs`, not the
store, so emits, badge refresh and the "Always allow" covering pass all
happen. `notify::set_showing` is keyed per socket (`companion:<device>:<socket>`):
a phone counts as showing a chat only while that socket is open and in front,
and a stale socket closing can't clear a newer one's chat.

**Projects and sessions** reuse Remote Access: `remote_access/tools.rs` has
structured cores (`project_views`, `session_screen`) under its MCP text, so
both get the same session list, states and refusals.

## Protocol

### Transport

Everything except file bytes goes over **one WebSocket**
([`frames.ts`](../packages/companion-protocol/src/frames.ts)): requests
`{t:'req', id, method, params}` → `{t:'res', id, ok, result|error}`, plus
events. Errors are the desktop's `CommandError` plus a `Protocol` variant.
WebSocket rather than SSE because React Native has it built in, one socket is
one ordering domain (a request's response can't overtake the event it caused),
auth happens once per connection, and revoking a device closes it at once.

**Files go over HTTP**, so a 25 MB upload never holds up a message and
downloads get `Range`:

| Route | |
| --- | --- |
| `PUT /v1/blobs` | Raw body, `X-Name` and `Content-Type`; answers a `BlobRef`, staged for 1 h |
| `GET /v1/blobs/:id` | A blob the Mac produced (screenshot, fetched path) |
| `GET /v1/agents/:id/attachments/*` | A chat attachment; `?w=` (16–1024) for a JPEG thumbnail |

Every route checks `Authorization: Bearer`. An unknown token is a bare 401;
another device's blob or a path outside the agent's `attachments/` is a bare
404. Responses carry `nosniff`, `Content-Disposition: inline`, and
`private` caching (attachments never change; blobs are `no-store`).

**Heartbeat:** the Mac pings every 15 s; the phone treats 40 s of silence as
a dead link, which catches sleep and Wi-Fi handoffs faster than TCP.

**Reconnecting** (`lib/transport.ts`): with the app in front the phone waits
1, 2, 4, then at most 5 s between tries (in the background 2 s up to 60 s, to
spare the battery). A try not welcomed within 8–20 s is given up and the next
route tried (a route that drops packets, like a home address from cellular,
otherwise hangs for the OS's own minute). A route that was working is tried
again first. Coming forward, a network change (NetInfo: online, Wi-Fi to
cellular, a VPN like Tailscale coming up) or Try again tries at once; on a
socket that looks open they send a ping that must be answered within 4 s. As
its app exits (a quit or an update's restart) the Mac closes every socket
with 1001 "going away" (`CLOSE_MAC_CLOSING`, `HubItem::AppClosing`), and the
phone says "Waiting for the app on your Mac" for up to 2 minutes. A socket
that opens and then says nothing, or a request that times out while the
heartbeat still comes, marks the app as stuck rather than the Mac as away
(see "The connection bar").

**Limits:** 600 requests a minute per device, socket and HTTP together,
of which at most 10 may create an agent (`MAX_AGENTS_CREATED_PER_MINUTE`;
a retry answered from the `clientId` cache doesn't count); 4 sockets per
device (a fifth from the same phone closes its oldest, since a phone that
changes network leaves sockets the Mac can't yet tell are dead), 16 in all;
1 MB frames; 25 MB a file and 10 files a message
(`MAX_ATTACHMENT*`); 30 staged files or 300 MB per device, held before an
upload's first byte is read; 3 uploads at once per device; a 10 s wait for
each of `challenge` and `hello`. Before any of that (`limits.rs`): at most
64 connections open at once, so a flood can't take the desktop app's file
descriptors. Of those, at most 48 may be **strangers** (anything that hasn't
authenticated: a socket before its hello checks out, a plain request); when
a new one arrives with 48 open, the oldest stranger is closed to make room,
and a socket that authenticated (or a pair request holding a live code) is
never evicted, so a flood can't keep a paired phone out. Each source may
have at most 4 sockets before their hello (`MAX_PREHELLO_PER_SOURCE`) and
32 requests in flight (an open socket counts as one). A paired socket's
requests each run on the blocking pool with a 20 s deadline
(`server::bounded`, `REQUEST_DEADLINE`), answered "Your Mac is busy" past
it; at most 48 hold a thread at once across every socket, counting ones
still running past their deadline (`MAX_IN_FLIGHT`), and the rest are
answered busy at once, so no device can take the pool the whole app
shares; 10 s for headers,
10 s for the whole pair body, and no 30 s gap in an upload. Uploads go straight to disk with a running cap,
never whole into memory. Thumbnails are refused (422) for images over
40 MP by their own header, before decoding; two decode at a time, and the
last 128 are cached. `agents.memorySuggest` runs two at a time and is
audited. `agents.fetchPath` copies at most 25 MB even if the file grows.

**Requests the phone makes** (`lib/reads.ts`, through `session.call`): a
read (`READ_ONLY_METHODS`) already on its way with the same params answers
every asker, so two screens or a quick tap back and forth are one request;
at most 6 reads are at the Mac at once and the rest wait their turn (changes
never wait); and the last answer to each read is kept for this Mac. Usage,
accounts and quota start from it and read again only when it is 20 s old
(`READ_FRESH_MS`) or a change was sent since (`agents.focus` and
`rooms.focus` aren't changes), so switching tabs asks nothing. Focus is sent
150 ms after the chat on screen settles, and only when it differs from what
the socket holds: tapping in and out of chats is one `agents.focus`. The
agents list reads a waiting agent's newest page once per connection, not on
every reconnect; after a snapshot (the Mac restarted) every chat is read
again. The offline copy is written at most every 4 s while events arrive,
and at once when the app goes to the background.

### Methods

`router::METHODS` is what the Mac serves and lists in `welcome.methods`; the
phone hides anything not listed (`canCall`), so an older Mac just shows less.
`welcome.timeZone` (optional) is the Mac's IANA zone, the clock routines are
read on (see "Routines" below). `welcome.features` (optional, `MAC_FEATURES`)
says what the Mac does beyond its methods: `results.revise` means
`agents.send` takes `revises`, so the phone offers **Ask for changes** on a
result card only then. The card itself (`message.result`, see
[agents.md](agents.md), "Result cards") is drawn by every phone that knows
it (`components/result.tsx`): title, summary, Not verified, before/after,
files (the chat's own attachment tiles), links (http/https only), Checked;
older versions fold to a line. On a copy's live card Keep / Discard sit
inside it.

- `system.status`, `devices.self|unpairSelf|setPush`
- `agents.overview|messages|send|stop|interrupt|answerApproval|focus|markUnread`
  (`answerApproval` takes `choice` for a session's question)
- `agents.saveSecret` (Tailscale only, never audited with a value), `agents.memory|memoryChange|memorySuggest`
- Logins (Mac feature `logins`, docs/agents.md "Logins"): `agents.loginStart|loginCancel|loginDecline|loginDismiss`,
  `agents.loginSaveKey` (as `saveSecret`), `agents.loginsTeam|loginsConnect` ("What your team needs"),
  `agents.reach` (read-only); Mac feature `logins.phone`: `agents.loginPhoneBegin|loginPhoneFinish`
  (the sign-in sheet; the finish goes only to an identity-verified Mac) and `onPhone` on
  `agents.loginStart|loginsConnect`; Mac feature `signin.phone`:
  `agents.signinBegin|signinFrame|signinInput|signinDone|signinStop|signinFallback` (signing
  in to a site from the phone, in a window of the agents' own Chrome on the Mac, streamed with
  `after: seq`; never audited by the router, see docs/agents.md, "The agents' browser"); Mac
  feature `stepIn.phone`: `agents.stepInBegin` (step into an agent's own held tab for its
  step-in card, then the same frames and input; `signinDone` answers `handed_back`; see
  docs/agents.md, "Step in"); "Not
  needed" for the team (docs/agents.md, "Not needed"):
  `agents.loginNotNeeded|loginsNotNeeded|loginsUndecline` (shown only when the Mac lists them),
  `agents.reach`'s `declined` (each with "Turn back on"), and `agents.loginsRecheck` when the app
  comes back while claude.ai is being connected here
- "Apps your agents can use" (docs/agents.md, "Connecting before anyone asks"): `agents.apps`
  (read-only; never a token), `agents.appsConnect|appsPhoneBegin|appsCancel` (connect on the Mac's
  browser or this phone's sign-in sheet, finished by `agents.loginPhoneFinish`),
  `agents.appsSetGrants` (the user's own answer: narrows or widens, as on the desk) and
  `agents.appsRemove`; shown only when the Mac lists them
- `agents.update` (`pinned`, `muted`, `hidden`, `instructions`, and from a Mac listing the
  `agents.engine` feature, `engine` and `model`: the desk's own `agents_update` checks the engine is
  ready and starts a new session that carries the conversation over as a recap),
  `agents.instructions|usage|revokePermission|changeDiff`
- `agents.files|fetchPath|search`, `agents.schedule.preview|create|update|pause|cancel|runNow`
- `agents.create` (`name`, `role`, `color`, and from a Mac listing
  `agents.draft` a draft's `instructions` and `routines`; idempotent by an
  optional `clientId`; see "Starting things"), `agents.draft|templates|setDefaults`
- `agents.watch.options|create|update|checkNow` ("When…" routines),
  `agents.conversations|conversationNew|conversationSelect|conversationRename|conversationRewind|conversationFork|conversationRoutine`,
  `agents.page|pageVersion|pagePin`, `agents.skills|skillEdit|skillRemove`,
  usage (`agents.quota|accounts|accounts.use|accounts.reorder|usagePlan|usage.setMode|spare.add|spare.spendNow`),
  `agents.quietHours|setQuietHours|morningBrief|setMorningBrief`; the full list is
  `router::METHODS`
- `projects.list`, `sessions.read|send|key|start`, `preview.screenshot`
- `rooms.list|messages|send|focus` (a Mac whose `welcome.features` has
  `rooms`; see "Rooms")
- `agents.import.status|start|stop|review` and, without Remote Access,
  `agents.import.exportPrompt|exportPreview|exportReview` (a pasted reply;
  see "Starting things", Import)

Declared in the package but not served: `agents.delete` and
`agents.import.pastePrompt|pastePreview|paste`. Pure reads (`READ_ONLY_METHODS`, mirrored in Rust) are not audited.

### Events, cursors and resync

The hub listens to the desktop's own events, stamps each journaled one with a
`seq` that only increases, and keeps them in memory (24 h or 20k entries)
under a random **epoch** made at app start. Messages are all kept; `status`,
`registry`, `projects` and `system` keep only the latest per key; drafts and
alerts are never journaled ([`events.ts`](../packages/companion-protocol/src/events.ts)).

The phone stores its cursor `{epoch, seq}` only after an event is applied and
saved, so a crash in between re-applies (harmless) and never skips. On
connect it sends `hello.resume`:

- **Same epoch, still in the journal:** `welcome{resume:'replay'}`, every
  event after the cursor in order, then `sync.caughtUp`. Nothing is missed.
- **Otherwise** (the app restarted, or a day away): `welcome{resume:'snapshot'}`,
  `sync.snapshot` (overview, Mac status, projects, cursor), `sync.caughtUp`;
  the phone re-reads the chats it has cached. Each part is worked out within
  6 s (`server::snapshot`, on the blocking pool): one that's slow goes as
  `null` (overview, projects: the phone keeps what it has) or as the last
  status sent, and a late status follows as `system.status`, so a busy Mac
  sends a partial snapshot rather than a silent socket.

Nothing is ever doubled: messages are upserts by id (an answered approval
replaces its card), and `agents.send` requires a `clientId` that the Mac
remembers for 24 h and echoes on the message, so a retried send returns the
original. A page from `agents.messages` carries `asOf`, and only rows whose
last-applied `seq` ≤ `asOf.seq` are overwritten, so a fetch can't undo an
event that beat it. The phone asks for pages with `work: 'summary'`: each
"What it did" comes as its folded line (`stepsOmitted`) and its steps are read
with `agents.workSteps` when it opens. An older Mac ignores the field and sends
steps inline, which the phone shows as they are; an older phone never asks.

**Drafts** are appends, `{id, from, text}`, throttled to 50 ms per socket and
restarted from 0 on a new connection. A `from` that doesn't match is dropped;
the next frame or the final message puts it right. (The desktop resends the
whole draft every 40 ms, which over cellular is most of the traffic.)

### Versions

`PROTOCOL_VERSION` ([`version.ts`](../packages/companion-protocol/src/version.ts))
is one integer, bumped only for a breaking change; additions don't bump it,
and both sides ignore unknown fields and events. The Mac keeps speaking the
previous version for at least a release. A mismatch is refused with the side
to update named: "Update <name> on …" or "Update this app".

**Version 2** made the Mac prove itself first (below). Nothing had shipped
on 1, so the Mac stopped answering it: an app on 1 sends its hello first and
is told to update without its token being read. An app on 2 that reaches a
Mac on 1 sees its challenge closed without a word; it then asks
`POST /v1/identity`, which a Mac on 1 doesn't have, and a 404 there says
"Update the app on your Mac" instead of reconnecting forever. A pairing link
without a fingerprint (a Mac from before identity keys) says the same rather
than "that isn't a pairing code".

### Keeping the types honest

Rust is the truth; the desktop's `src/lib/agents.ts` mirrors it by hand and
the package copies those types so the app needn't import Tauri. Drift fails
at both seams:

1. **TS ↔ TS.** `desktop-conformance.ts` asserts each copied type is
   identical to the desktop's; root `pnpm typecheck` includes the package.
2. **Rust ↔ TS.** `cargo test --lib companion::fixtures` serializes a value of
   every wire type (every optional field set, every enum variant, method
   results through the real router) into `fixtures.gen.ts` as
   `satisfies` literals, so tsc checks what serde actually emits. The test
   fails if the file on disk differs; `UPDATE_FIXTURES=1` rewrites it. This
   was chosen over ts-rs, which checks declarations rather than output and
   would mean deriving on ~30 desktop types.

## Routes and TLS

The phone connects over **Tailscale**: the Mac binds `127.0.0.1:<port>` (kept
in `companion.json` so the handler stays valid) and runs
`tailscale serve --bg --https=47443 http://127.0.0.1:<port>`, so the phone
sees the real `*.ts.net` certificate with stock `fetch` and `WebSocket`. The
route is reported on only when `tailscale serve status --json` shows that exact
handler, unfunnelled. Off runs `tailscale serve --https=47443 off`; nothing
else in the serve config is touched.

**Why 47443:** Funnel can only publish 443, 8443 and 10000, per port, and
Remote Access already funnels 443. A mount on a Funnel port would be one
toggle from the public internet.

**A LAN route is designed but not built** (`RouteKind::Lan` exists on the
wire). It would be rustls with a self-signed key whose SPKI hash rides in the
QR code and is pinned by a small native module. Plain HTTP is never an
option: the token controls your agents, and anyone on the café Wi-Fi could
read it. The QR code is already an out-of-band channel, so pinning needs no
CA and no trust-on-first-use.

## Pairing

1. **Mac:** Settings → Phone (the same panel, titled "Phone" whether opened from Settings or the
   sidebar's phone line, so the phone's "Phone (in Settings, or the phone line
   at the foot of the sidebar) → Show code", `WHERE_TO_PAIR`, names what's on
   screen) → **Show code** (or Cmd+K). A one-time code
   (128-bit, 5 minutes, single use) is shown as a QR code of
   `<companion.scheme>://pair?d=…` (`mogbot-companion` today) carrying the code, server id, Mac name,
   **exactly one route** and the **fingerprint of the Mac's identity key**,
   and no long-lived secret (`PairingLink`). No code is shown unless that
   key is kept in the Keychain: a phone must never pin a key the Mac is
   about to lose.
2. **Phone:** scan in the app or with the Camera, or paste the link. A link
   is untrusted input (any page or message can open one), so the phone
   **always asks first**: "Pair with *Sam's MacBook Pro*? at
   *sams-mbp.tail1234.ts.net:47443*", the code's last four characters,
   and, when a Mac is already paired, "This replaces *that Mac*". A
   Tailscale route must be `https://<name>.ts.net[:port]`
   (`parsePairingLink`); a link with more than one route is refused, so the
   host shown is the only one tried. A link naming the paired Mac's id with
   a different fingerprint stops there: "This isn't your Mac". "Already
   paired with" is said only when the fingerprint matches the pinned one.
   On Pair, the **Mac proves itself first**: `POST /v1/identity` with a
   fresh challenge; the answer must be signed by the key the link
   fingerprinted, for that server id, with the host the phone reached among
   the hosts it signs (`checkMac`). Only then does the phone send
   `POST /v1/pair` (JSON only) with the code, its name, model, an X25519
   public key and another fresh 32-byte **challenge**.

   **The phone says only what has happened** (`pairWith`'s `onStep`):
   "Reaching *Mac*…" while `/v1/identity` is out, and "Allow on your Mac"
   only once the Mac has proved itself and `/v1/pair` has gone. A tailnet
   host the phone can't reach doesn't fail, it hangs, so the identity
   request gets 12 s (`IDENTITY_TIMEOUT_MS`), and one more try on a fresh
   connection if that ran out (a first request over a DERP relay, or a
   phone whose Tailscale is waking on demand, can be slow but working; a
   fast failure isn't retried), and is then diagnosed
   (`diagnose`: a `*.ts.net` name that doesn't resolve means Tailscale is
   off here, anything else that nothing answered). Either way the screen is
   "Can't reach *Mac*" and a three-line checklist (`lib/reachChecklist.ts`,
   `components/ReachChecklist.tsx`): the Mac awake with the app open (always
   "can't tell": asleep and closed look the same), Tailscale on with the same
   account on both (wrong when the name didn't resolve, the phone is offline
   or Tailscale isn't installed, asked again whenever the app comes back to
   the front; Open or Get Tailscale), and this phone paired (not yet). Each
   row says what the phone sees and its one fix; the host is folded under
   Details, never the first line, because a beginner read "Nothing answered
   at localhost:50898" as the problem. The Connection sheet leads with the
   same checklist while a paired phone's Mac is quiet, the layers folded
   under it. The pairing request keeps the desk's 120 s plus 15
   (`PAIR_TIMEOUT_MS`), then says "No answer from *Mac*" rather than
   waiting forever.

   **Tailscale on the phone is said before the scan, on both sides.** The
   phone's welcome opens on a "Before you scan" card (installed, connected,
   same account as the Mac; Get / Open Tailscale). On the desk the code's
   first step is "Install Tailscale on your phone and sign in as
   *login*", with Tailscale's App Store and Google Play links, the login
   read from `tailscale status --json` (`User[Self.UserID].LoginName`;
   none for a tagged machine, and then "the same account as this Mac"),
   never guessed. The "Get the phone app" flow lists it too. The code
   isn't shown until this Mac's own Tailscale is up. While a code is out,
   the first `/v1/identity` that reaches the Mac shows "A device reached
   this Mac at *time*. Waiting for it to send the code…" under the code
   (`PairingView.reachedAt`, once per code). It is unauthenticated, so it
   says "a device", never "your phone"; its absence while the phone spins
   is the tell that the phone isn't on the tailnet.
3. **Mac:** "Allow **Sam's iPhone** to use your agents?" with the model,
   when it asked, the code's last four characters and the tailnet user
   `tailscale serve` named (`Tailscale-User-Login`), open for 120 s. The
   name and model are cleaned of control, bidi and zero-width characters and
   cut to 40. This is what makes a QR code photographed over your shoulder
   useless. The answer is for that request's id, so a click can't land on a
   phone that asked meanwhile. If a paired phone has the same name, platform
   and model, the prompt says so and offers **Allow, keep both** or **Allow
   and replace**: nothing is removed unless the desk says so.
4. **On Allow** the Mac returns a 256-bit token, keeps only its SHA-256, and
   signs the challenge, its hosts and the new device id with its identity
   key (`pairProofMessage`). The phone keeps the answer only if that checks
   out for the host it reached, **pins** the fingerprint, and keeps only the
   route that answered. It keeps the token in `expo-secure-store`
   (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so never in a backup).
5. **Pairing again** with the same server replaces that Mac on the phone.

Codes are compared in constant time; a wrong one gets a bare 404 after
400 ms. Wrong codes slow down their own source (three free, then a wait
that doubles from 1 s to 5 minutes), never the code: 128 bits can't be
guessed, and burning the code would only let anyone who can reach the port
spoil the real phone's pairing.

**The Mac's identity.** `identity.rs` has an Ed25519 key, kept in the login
Keychain (`keystore.rs`); a key an earlier build left in `companion.json` is
moved there once, and the file's copy is emptied only after the Keychain
gives it back. TLS is the `*.ts.net` certificate, which a Funnel host has
too, so the pinned key is what tells *your* Mac from another.

**The Mac proves itself before any secret is sent.** On every socket the
phone's first frame is `challenge` (fresh random bytes, no token). The Mac
answers `identity`: its server id and the hosts `tailscale serve` publishes
it on, signed with the challenge (`macProofMessage`,
`<scheme>:identity:v2\n…`; each signed message has its own prefix, so a
pairing proof is never a socket proof). The phone sends `hello` with its
token only when that is the pinned key, the pinned server id, and the host
this socket reached is in the signed list. Otherwise it stops for good,
having sent only the challenge:

- another key, nothing signed, or a host the Mac didn't sign (a relay on
  another `*.ts.net` name passing the real Mac's answers along) → "This
  isn't your Mac … this phone sent it nothing private";
- another server id → "pair again": either the Mac lost its key and started
  over (below), or it isn't the Mac; either way nothing was sent.

Before the proof, only refusals that can honestly come first (versions, a
locked Keychain) are heeded; "removed" or "not paired" from a server that
hasn't proved itself is ignored, so a stranger can't talk the phone into
forgetting its Mac. Secret cards still check `identityVerified`.

**Losing the key.** If the Keychain can't be read (locked, refusing), the
Mac doesn't make a new key: sockets are refused `unavailable` ("unlock your
Mac") and retried, and no pairing code is offered. Only when the key is
definitely gone does it make a new one, and if phones were paired it
**starts over**: a new server id, every phone revoked. Those phones see the
new id and say "pair again" instead of "this isn't your Mac". A key the
Keychain won't keep is used for this launch only and no code is shown.

**No trust on first use.** The app hadn't shipped, so there is no unpinned
pairing to carry: a pairing from before identity keys is never used (it
says "pair again", and a forget queued for it is never offered to a
server), and every link must carry a fingerprint.

## Auth, revocation and audit

- HTTP sends `Authorization: Bearer`; the socket sends the token in its first
  frame (`hello.token`), never in the URL, so no log records it.
- **Browsers and other names are refused** before anything else: a request
  with an `Origin` that isn't the server's own (React Native's WebSocket
  sends the server's own; its `fetch` none) and any `Host` but a `*.ts.net`
  name or loopback (DNS rebinding) get a bare 403. `/v1/pair` takes only
  `application/json`, which a page can't send cross-origin without asking.
- **Tailnet user.** The `Tailscale-User-Login` that `tailscale serve` set
  at pairing is kept on the device, and every later request with that
  token must carry the same user: a different user, or none at all (a
  tagged node holding a stolen token), is refused. A phone paired with no
  user (over loopback, in development) takes any. This trusts `tailscale
  serve` to strip a client's own `Tailscale-User-*` headers, which is
  documented behaviour but not tested here against a real tailscaled.
- The device is re-checked on every frame (a re-pair mints a new id, so this
  is the token check). **Revoke** in Settings → Phone deletes the hash and
  closes that device's sockets at once, **aborts the requests those sockets
  had running**, stops an upload mid-body, and deletes its staged files
  right away; the phone says "This Mac removed this phone" and offers to
  pair again. An ordinary disconnect lets running requests finish (a send
  the phone retries by `clientId` is better done once than cut in half).
- **Forget this Mac** on the phone sends `devices.unpairSelf`. Offline, the
  revoke is queued in the keychain and finished on the next launch or
  network change, and the phone says the Mac keeps it until then. The queue
  is one entry per pairing (server id *and* device id), so finishing an old
  forget never touches a newer pairing with the same Mac, and nothing it
  does saves credentials. An entry is done when the Mac confirms, says the
  token is gone, or turns out not to be that Mac (`not_your_mac`, a new
  server id), so an old token isn't offered to whoever answers forever.
- Turning the companion off stops the listener and removes the serve handler;
  paired devices are kept.
- **Audit:** every action goes into `companion_audit.jsonl` (its own file,
  apart from Remote Access's) as `"Phone · <device>"`, with the method and a
  preview, never a token. Past 1 MB it rotates to `.1`, keeping the last two
  files. Failed connections are folded to one line per source per minute
  ("199 more failed connections from … in the last minute"), so a flood of
  bad hellos can't roll out the record of what a real token did. The Phone
  panel shows each phone's latest action.
- **What a token reaches.** A device token is the user's agents: every paired
  phone sees every agent, and `agents.fetchPath` hands it any file under a
  registered project or agent home (`.env`, `.git/config` included), with no
  agent involved. That is by design; it is why the token lives only in the
  keychain and why pairing needs the desk. Attachments are served only from
  `attachments/`, never through a symlink.
- **Text refusals:** `agents.send`, `sessions.send` and `sessions.start` apply
  Remote Access's `sanitize_message` / `check_message_kind`: no control
  characters, no leading `!`, `/` commands only from the allowlist, at most
  20k characters, and an opening prompt never starting with `-`. An agent's
  instructions (`agents.update`) and a routine's note
  (`agents.schedule.*`), which become its words later with nobody watching,
  are refused on the same rules rather than cleaned. Sessions only ever
  reach agent tabs. A refusal comes back as `Protocol/refused` with the
  sentence to show.

## The app

### Screens

**Navigation:** native tabs for Catch up, Agents, Projects and Search; chat, the agent sheet, files, a session, a
request, the diff and the photo viewer push over them. At
700 pt and wider (iPad, landscape) the Agents list and a chat sit side by side.

- **Agents (home).** The Chief first, then pinned agents, then the rest by
  activity, then Rooms. What waits on you is Catch up's (below), counted on
  its tab badge: here a waiting agent's row keeps only its own words
  ("Needs your OK · …"), with no header, summary card or dot over it (rooms
  too). Every other state keeps its mark. Swipe to mute, hide (with Undo) or pin; hold for the
  context menu. Quick actions on the icon: "Needs your OK" (with how many,
  while something waits) and "New message to Chief of Staff".
- **Catch up** (`app/(tabs)/catch-up/index.tsx`, `lib/needsYou.ts`,
  `lib/catchUpTab.ts`), the first tab: the phone's inbox for its agents and
  its one place for everything waiting on you, across every agent. The tab
  carries the one count: its rows (`feedItems(...).length`), so cards, not
  agents, and always the number the list shows. Home has no bar for it: a
  waiting agent's row keeps only its own label, as the desk's sidebar row
  does (docs/agents.md, "Needs you: one place per surface").
  - **Header.** The large title, then "3 things need you" and "From 2
    agents" (offline, the connection bar above says when it last heard). Nothing waiting: a calm check, "All
    caught up", one line, and **Go to Agents**.
  - **Grouped by agent.** One card per agent, in the order of its most
    urgent row (what blocks an agent first, then the rest; newest first
    within each; `groupByAgent`). Its head is the agent's key (lit while it
    needs you, `agentKeyState`), its name and how many; tapping it opens the
    chat. Each row is one line of what's asked, the agent's one line of why,
    and when: approvals, plans, "OK to go on?", keys, logins, a session's
    question, changes in a task copy, a turn only you can fix, setting up
    your team, and an import only the Mac can review.
  - **Answers on the row.** A short plain request the Mac marked low-risk
    is answered there (Deny · Allow, compact and neutral, the same 400 ms
    arming; `answersInPlace`), its whole text shown (the exact command in
    mono when there's no plain line). Anything risky (`approval.risk:
    'high'`, decided on the Mac by `mcp::risk_of` from Bold's floor:
    deleting for good, money, credentials, `sudo`, pushing, publishing,
    sending, system files; plans and push cards too) wears the warning icon
    and has **Review**, and so does a card the Mac didn't classify (an older
    Mac, a card from before) and one that doesn't fit whole (`fitsWhole`:
    over 160 characters or 3 lines, a plan over 3 steps). Review opens it in
    full, where a risky Allow is in the danger style. The phone never works
    risk out from a command's words. A key, a login or a question has its one
    action ("Enter key", "Sign in", "Answer") beside the words, opening it
    where it's answered; changes in a copy have Discard (confirmed) · Keep
    changes on the row (`useCopyParts`, compact).
  - **Swipe** a row left for **Chat** (its chat at the card), also in the
    VoiceOver actions rotor. Swiping never answers.
  - **Answered rows leave** by themselves, here or at the desk, fading out
    while the rest close up (still under Reduce Motion), and an agent's card
    goes with its last row.
  - **Since you last caught up.** Below, a quiet list of what happened that
    didn't ask anything, from the agents' saved chats only
    (`sinceItems`): results shared (the newest version of each), routines
    that ran, turns that ended in an error, and "2 new messages" for an
    agent with unread replies and nothing else listed. Up to 6, newest
    first, each opening its chat at the message. "Since" is when you last
    left the tab (`catch-up.json`, frozen for the visit so nothing vanishes
    while you read); with none on record the section is "Recently" (the last
    24 hours). The chats it needs (cards, copies, unread) are loaded as the
    tab opens.
  - **One at a time** (header, with two or more) goes through them full
    screen (below). A pushed "needs you" opens this tab.
  - **Where the app opens** (`lib/landing.ts`): at launch, Catch up when
    anything waits (from the saved copy), else Agents; the Mac's first answer
    within 4 s may put that right once, only if you haven't moved. Coming
    back after 10 minutes or more away, from one of the tabs, it opens Catch
    up when anything waits, and an emptied Catch up hands you to Agents.
    Never from a chat, a request or a sheet, and a tapped notification or
    quick action wins (it moves the app first; nothing here moves it
    again).
- **Request** (`app/request.tsx`, `/request?agent=&id=`): one card in full,
  from a Catch up row, a tapped approval notification or Review on the Lock
  Screen. Nothing capped (`ApprovalCard`'s `full`): a long command line by
  line, every step of a plan, an email's whole body, details open; the page
  scrolls and Deny · Allow stay pinned at the bottom. A key, a login or a
  question has its one action, which opens it in its chat. Answered or
  expired while open: it says so, with Open chat and Done.
- **Usage** (`app/usage.tsx`, `app/usage-account.tsx`,
  `components/usageStack.tsx`), as the desk's Usage view says it
  (`usageGlance`, the same words and figures): the Agents list's glance (one
  compact card: the total and how many accounts it is of, a refill chip, the
  total bar in the work order) and the ring left of ⓘ in a chat's header open
  it; on a Mac that serves Usage, Settings shows that same card (Accounts &
  usage) instead of an account list of its own. Every one of them builds the
  glance with `lib/glance.ts` `glanceFor`, the desk's engines and pins, so they
  count the same accounts.
  Under a putty gauge key: this agent's context when its engine reported it,
  then the total first ("72% left across 2 Max accounts", "Next refill in …",
  the bar; `totalWords`, as the desk's hero), then **Accounts**, one list per
  engine in the order turns try them (keycap numbered within its engine, the
  heading names it; name, plan, room, pill, refill chip). An account opens its own screen, the desk's account page: its place
  and state, **Use this one now** and the ↑/↓ for its place (where the Mac
  takes `agents.accounts.use|reorder`), then **Limits | Tokens**: each limit a
  card (countdown chip, big "% left", the pace-marked bar, the Mac's run-out
  estimate between now and the refill, said as one, the pace sentence), or
  who used it this week with their keys and share; then "Where it went".
  On a Mac that serves `agents.usage.setMode`, the Usage screen also has
  "How agents use your limits" (Normal, Save my limits, Use it all before
  the refill) and "Ideas for leftover usage" (Add, and "Give agents
  something to do"; `components/usagePlanControls.tsx`). A Mac with no accounts list falls back to the per-account sheet
  (`usageSheet`, shared with the desk's popover). ↻ reads it all again.
  Adding and signing in to accounts stay on the Mac.
- **One at a time** (`app/one-at-a-time.tsx`, `lib/catchUp.ts`), from
  Catch up's **One at a time**: everything waiting, one card
  at a time, full screen. Setting up your team first, then every request
  this phone can answer (oldest first), then each agent with something new
  to read or a turn that needs you. A card is the agent, what it said since
  you last spoke (up to three messages, markdown and pictures as in the
  chat) and the request, with Deny · Allow as two big buttons at the bottom (Chat and Next quiet above them; the card's own
  answers hidden, the same 400 ms arming); a login, a key or a task's
  question has one action instead ("Sign in", "Enter key", "Answer") that
  opens it in its chat. **Chat** opens the agent's chat at the card, and back
  returns to the same card; **Next** or a swipe left moves on. Swiping right
  never allows: an Allow can't be undone and a command scrolls sideways
  under the same finger. "3 of 8" and a thin bar; success haptic on Allow,
  light on Next. A card on screen counts as read (`setOpenChat`). Passed
  cards stay counted, cards ahead answered or read elsewhere drop out, new
  ones join the end; the card in front of you, answered on the desk or
  expired, says so for a beat and moves on. Done: "All caught up" and Done,
  back to Catch up. Chats the cards need are loaded once before it starts (up to
  5 s; offline it uses what's cached), so the order doesn't shift.
- **Chat.** An inverted list: newest on the composer, older pages loaded on
  scroll. While the Chief's stored greeting is all there is, the desk's three
  ideas sit under it (`components/ChiefStarters.tsx`, the shared
  `CHIEF_CHIPS`): a tap types the idea's whole brief into the composer and puts
  the cursor there; nothing goes until Send, and they stay until you've said
  something (docs/agents.md, "A first real result").
  Replies stream one display frame at a time (`lib/reveal.ts`) and the
  finished message carries on from where its draft got to. **Following**
  (`lib/follow.ts`): at the newest line the chat is pinned, so your message
  glides in on the composer and a reply grows up from it, its newest words
  always in view, however long it gets. Only your own finger lets go: scroll
  back and the rows on screen hold still (`maintainVisibleContentPosition`)
  while the reply carries on below, and a "↓ New" pill rides the keyboard
  ("Needs your OK" first, a bare arrow when far back with nothing new). The
  keyboard, a card unfolding or a page of older messages never unpin it.
  Distances count from the keyboard-lifted end (`-inset`), so Send and the
  pill land on the newest line with the keyboard up; scrolling to offset 0
  left it behind the keyboard. Checked natively on the iOS 26.1 simulator
  (send, a streamed reply, scrolling back mid-stream, the keyboard). Where the
  list meets the composer and the header the words fade into the background
  over 28pt (`chatFade`, bands of the surface colour, no native module), and
  the list keeps that room at both ends so nothing rests under a fade. With
  the keyboard up the composer sits `composer.keyboardGap` (10pt) above the
  keys: the sticky view, the list's lift and the pill share one offset
  (`lift`), so they move with the keyboard frame for frame. Hold a
  message to copy, quote or select text; paths in a reply open through
  `agents.fetchPath`.
- **Lines, cards and bars** (`components/surfaces.tsx`, the desk's
  `AgentCard.tsx`; docs/agents.md "Lines, cards and bars"). Everything in a
  chat that isn't something someone said is one of three. A **Line** is one
  quiet centred sentence that wraps, never cut: a note ("Started fresh · memory
  kept", a take-over that closed), a routine's run, a time between messages
  (consecutive Lines sit at the Line gap), "Start of your conversation", a
  usage limit, an answered card's outcome ("✓ Allowed · …", a tap unfolds what
  it was about), "Started a task in …" and what changed (a tap opens them), an
  older version of a result. One agent writing to another ("To Ops" / "From
  Ops") is neither: the other agent's face and the words under a rule, so it
  never reads as part of a reply. A **Card** is the one anatomy every request and result shares —
  icon and title (a quiet meta such as "v2" or the time at the right, plain
  text, never a chip), a muted source
  line ("Acme Site · in acme-site"), the body, a muted note, then the answers
  right-aligned with the single affirmative last, in the neutral `answer`
  style (never the agent's colour); the rest are `outline`. Approvals, a
  task's question, secrets, results, a copy's Keep / Discard, an import's
  consent, playback and review and a real failure (what it ran on, what to do) all use it;
  answered, a card becomes its outcome line. Offline every card keeps its
  answers, disabled, with one note (`OFFLINE_NOTE`), drawn from what the Mac
  last said it serves (`served`, kept in the offline copy). A **Bar** is this conversation's state, directly above
  the composer in a fixed order (`lib/bars.ts`): the Mac out of reach, you
  driving the agent on your Mac, an import, "Changes to …" for the message
  being written, what the engine can't do. At most two show; the rest fold
  into "N more". The chat header is identity only (name and role): status is
  in the list row and in the conversation, never a third time up there.
  `__tests__/surfaces.test.tsx` holds the anatomy and the order;
  `__tests__/vocabulary.node.test.ts` reads every user-facing string out of
  the source and fails on the desk's retired words ("session", "Waiting for
  your decision", "via connector", "Claude Code 1", the noun "take-over",
  "Denied" — answered requests are "Declined"), with a snapshot of the rest.
- **Approvals** (`ApprovalCard`): the exact command, scrolling sideways rather
  than re-wrapped; ⋯ · Deny · Allow, with Always allow (with
  `describeScope`'s sentence) and Deny with a note… behind ⋯. The answers are
  inert for 400 ms after the card lands, the desk's anti-misclick; Allow is
  the one tap the app must never take by accident. A pending card's detail
  (a command, a connector's fields, a task's diff) shows `DETAIL_LINES` (8;
  6 at large text) with "Show all", so the question and the answers fit
  together without scrolling (`__tests__/detailCap.test.tsx`); a new card
  landing while you're at or near the newest line scrolls its answers into
  view (`revealsCard`, never when you'd scrolled back to read). "New" means
  a card this chat hasn't shown waiting before (`seeCards`): with two
  waiting, answering the newer on the Mac used to make the older one look
  new and scroll the chat back up to it, past everything said since.
- **A task's questions** (`PromptCard`): the question, whose task it is and
  where, the diff (tinted) or text it shows, and every option it offers,
  answered with `agents.answerApproval`'s `choice`; the same 400 ms guard.
- **Login cards** (`approval.login`): which app, which account, read vs
  send, and the ways in. With a Mac that has `logins.phone`, the sign-in
  happens here, away from the Mac (docs/agents.md, "From the phone"): an
  OAuth connector in the system sign-in sheet (`expo-web-browser`,
  ephemeral; the one-time code goes to the Mac once and is never kept),
  GitHub's one-time code (Copy code, Open GitHub), or claude.ai opened
  here. The token is always made and kept in the Mac's Keychain. With an
  older Mac, or a build without the sheet's native module, Connect starts
  the sign-in on the Mac and the card says "Finish signing in on your Mac —
  it's open there". It follows `login.flow` live, then shows the answer. A Mac without `logins` never sends one; a phone without it
  sees Allow / Deny, and its Allow starts the first way in on the Mac.
  "What your team needs" (`agents.loginsTeam`) and "What it can reach"
  (`agents.reach`, read-only; its footer opens Apps on that agent, where
  who can use each app is changed or the app removed) are on the phone too.
- **Step-in cards** (`approval.stepIn`): "<Agent> needs you in its browser:
  <reason>". With a Mac that has `stepIn.phone`, **Step in** opens the
  sign-in screen (`app/signin.tsx`, `stepIn=1`) on the agent's own tab: the
  Mac holds it so the agent can't use it, its window stays parked there, and
  the page shows here, driven by touch, on the card's site and the sign-in
  providers only. The top button is **Hand back**; leaving the screen hands
  back too, so the agent is always woken (with where the page ended up,
  never what was typed). While any device is in it the card offers nothing
  and names where ("Sam's iPhone is in its browser"). An older Mac: Not now
  only, and "Step in on your Mac".
- **Secret cards** (`SecretCard`): masked fields straight to the Mac's
  Keychain via `agents.saveSecret`. Only over HTTPS on Tailscale, and only on
  a socket where the Mac proved the pinned identity (refused on the
  phone before sending; the Mac has no route check, since every socket
  reaches it the same way); the value
  lives in a ref, is wiped on save, backgrounding and unmount, and never
  reaches the store, cache, drafts, outbox, notifications or logs
  (`__tests__/secrets.node.test.ts`).
- **Composer.** Send, Queue while working (with Send now and Stop), Stop; no
  Stop while an approval waits. @mentions, quotes as `> ` blockquotes (the
  helpers live in the package), and files from the camera, Photos or Files,
  each uploading as soon as it's picked with progress, retry and remove.
  Drafts, including uploaded files (kept 55 min), survive leaving the chat and
  a cold start (`lib/drafts.ts`). A mic in the field dictates into the draft
  (see "Dictation" below).
- **Agent sheet.** "Claude · Opus" / "Codex · …" / "OpenCode · …", Runs on and Model shown (changed from the model chip's Agent controls, below), Memory (view, edit, forget with
  Undo, add; "Remember this" in a message's menu), Instructions (view and edit), pin/mute/hide, check-ins and
  routines (create and edit with the picker below, past runs, pause, run now,
  cancel), usage, "What it knows how to do" (its saved skills, each opening
  `app/skill.tsx` to correct or remove, and its Automatically / Ask me / Off
  setting; docs/agents.md, "What it knows how to do"), and "Allowed without
  asking" with Revoke. A skill offer arrives as a Save / Not now card that
  never counts as needing your OK: Catch up lists it after everything that
  blocks an agent, out of the headline and the tab badge ("And 1 offer that
  can wait", `waitingCount`), One at a time puts it last and out of "3 of 8"
  ("An offer, no rush"), and its notification has no lock-screen buttons
  (`opensOnly`): it opens the app.
- **Files** per agent; **search** across every chat, which pages a chat back
  (40 pages at most) to the hit and lights it.
- **Projects and sessions.** Live from `projects.changed` events (the Mac
  watches tabs every 2 s and git every 10 s, only while a phone is connected).
  A task (`app/session/[id].tsx`, every 2.5 s while open) reads as a
  conversation, not a terminal: its state in plain words ("Working ·
  Checking the hero at 390px", the Mac's `agent_state` reading without the
  timer), its question with each option's words as neutral answers (no key
  numbers), what it was asked as your bubble, its steps in plain words
  ("Read Hero.tsx", "Took a screenshot") and what it said. `lib/taskScreen.ts`
  reads that off `sessions.read`'s screen (the Mac's `reply` when the screen
  has no words of the agent's), leaving out the input box, the spinner and
  "esc to interrupt", shortcut hints, tool output and boxes. **Show
  terminal** opens the raw screen in a sideways-scrolling well with a fading
  right edge. You can type to it, start a new task or take a preview
  screenshot (a private blob, never a public link).
- **Connection screen.** Every layer of the link (below).
- **Settings.** The paired Mac; Accounts & usage (the Usage card, Without
  asking, Logins, Bring agents in); New agents start on; Notifications, Quiet
  hours and Morning brief; Appearance, Text size, Feel, Voice; Updates;
  About. **New agents start on** lists
  the Mac's engines (one not installed or signed in is dimmed, saying which),
  and a **Model on …** section per installed engine offers "Default"
  and only the models that engine listed (`lib/newAgentDefaults.ts`). Read
  from the overview's `defaults`; a tap sends `agents.setDefaults`, which the
  Mac checks as the desk does (a ready engine, a model it lists), audits
  ("new agents: engine codex"), and answers with an `agents.registry` event.
  On a Mac without the method the choice shows but isn't tappable. Existing
  agents keep theirs ([agents.md](agents.md), "Defaults for new agents").
- **What it's doing right now** (`LiveStep` in `components/work.tsx`): the
  working row is the desk's one line: the agent's key, pressed while it
  works (`AgentKey`, as the desk's working line; still, no clock),
  what it's doing in plain words (gently breathing while it's live,
  `Shimmer`), then muted "· 5 steps · 6:02" (the turn's time). Tapping the
  line opens the steps so far under it, ending on the call it's on (the
  call's `status.work.current`) with its own timer, when it last showed life
  ("Last activity 4s ago · using the CPU") and "Show output" (the last lines
  the command printed; Codex streams them, under Claude Code it says "Output
  appears when it finishes"). Under the line, on the words' edge: after a
  minute on a known slow tool a quiet "Test runs usually take a few
  minutes". Quiet text actions sit at the right edge on a row of their own:
  after ten minutes "Stop this step" (`agents.stopStep`, the turn carries
  on); once the Mac reports no progress (`quietSince`) the line reads "No
  progress for 5 min · …", stops breathing, and offers "Check on it"
  (`agents.checkOn`: what the Mac can see, one line, never interrupting)
  and Stop. Finished steps read "Ran the Cypress tests · 6m 12s
  · 42 passed, 3 failed", and a long or failed command keeps "Show output".
  On the list a working agent's key (see "Agent keys" below) sits pressed
  in place of the spinner (never a ring around it), and
  its line says the step and how long ("Running the Cypress tests · 5m");
  the overview carries no steps, so until a live status arrives it is the
  status's words and the turn's time. The words come from
  `@shipstudio/companion-protocol`'s `work.ts`, shared with the desk; the
  methods show only on a Mac that lists them.

### Agent keys

Every agent is its keycap, as on the desk (docs/internal/agent-keys.md):
`components/AgentKey.tsx` draws it from the shared spec
(`packages/companion-protocol/src/agentKeys.ts`, `agentKeyIcons.ts`):
Views for the skirt, the inset face and the solid depth under them, one
soft ambient shadow, and the legend in react-native-svg. The geometry is
the desk's (`lib/agentKey.ts`): one unit of size/112, the small key (36pt
and under) its own drawing on a 30pt unit. Sizes are the desk's
(`keySize` in theme.ts: 16 a line, 20 a menu, mention or room, 30 a header
or the Needs-you feed, 44 a list row, 112 the agent sheet); the sublegend
(its keyboard key) and the four independence pips show at 64pt and up.
The colourways and the socket's neutrals are named colours in theme.ts,
which the theme test holds to `agent-keys.json`.

States come from `agentKeyState` (lib/agents.ts, the desk's) and look as
on the desk and the site (`keyPose`, `keyPaint` in lib/agentKey.ts): Needs
your OK, the loudest, sits proud with an amber-gold legend, an amber light in
its face and an amber spill under it, pulsing; Working is pressed and
warm-lit, its light breathing and spilling under it in its own colour; Live
(you drive it at the desk) is lit and still; Paused (a usage limit) keeps its
cap, drained of colour, faded and sunk; a new agent is an empty socket that
fades in. A lit face deepens in its own hue (`KEY_LIT_MIX`). A row's key goes
all the way down while your finger is on it (`pressed`). Only opacity loops
(Reanimated, on the UI thread), only on a working key or one that needs your
OK, and it holds still with Reduce Motion, in the background or off screen;
the states still differ when nothing moves. The agent list has no "N working"
line and no unread dot: the keys say who is working, free or waiting, and an
unread row's line is in strong ink (its accessible name says "working",
"unread"). An agent
from an older Mac is drawn by `keyLookFor` (its colour's nearest
colourway, an icon from its name and role).

The agent sheet's key opens its colour, icon and keyboard key (a letter or
digit nobody else has), sent as `agents.update` `colorway` / `icon` /
`boundKey` only to a Mac listing `agents.keys`; one listing only
`agents.keycaps` gets its colour. New agent offers the same three on such
a Mac, seeded with a colourway nobody wears, an icon read from what it's
for and the first free letter of its name.

Icons beyond the 22 featured legends come from the shared Lucide pack
(docs/internal/agent-keys.md, "The icon pack"): under the featured row,
"Search 2,029 more icons" opens `components/KeyIconSheet.tsx`, a sheet with
the 112pt key, a search focused on open (the desk's `searchIcons`), the
categories as chips, the icons picked this session and a virtualised grid.
A pack icon is drawn round-capped once its drawings file has been required
(blank for that moment). Metro doesn't split `import()` into bundles, so
`metro.config.js` (and the Jest config) resolve the pack's loaders to
`agentKeyPackShards.require.ts`: each drawings file a bundled module,
evaluated the first time it's required.

### Conversations

Several conversations with one agent ([agents.md](agents.md), "Several
conversations with one agent"), on a Mac that lists `agents.conversations`
(`conversationsOffered`, `lib/conversations.ts`). An older Mac has one
conversation per agent and the chat is as it was.

- **Store.** `chats[agentId]` stays every line the agent has, whatever the
  conversation: the Catch up tab, the agent rows, One at a time and the request
  screens read its cards there. One conversation's chat is kept beside it
  under `conversationKey(agentId, id)` (`<agent>#conversation:<id>`), read a
  page at a time with `agents.messages`' `conversation`; every event lands in
  both (`chatKeysOf`), so paging, upserts and resync work unchanged.
- **Which one.** The chat opens on the Mac's `current` (where the user last
  was, on any device; `ensureViewing`). Picking one calls
  `agents.conversationSelect`; `agents.send` carries the one on screen, so
  replies land where the user asked. A reply streaming in another conversation
  isn't drawn in this one.
- **Screens.** A speech-bubble button beside ⓘ in the chat's header opens
  Conversations (`app/conversations.tsx`): New conversation, a search, every
  conversation newest first (a check on the one on screen, "Needs your OK",
  "Working" or how long ago) and Rename for the one on screen. With more than
  one, a slim bar under the header names the one on screen, with an amber dot
  when another waits on you (`ConversationSwitch`). The agent sheet's Start
  fresh is New conversation on such a Mac: no confirm, nothing waits, and it
  opens the chat.
- **Search.** A hit carries the conversation it was said in
  (`SearchHit.conversation`); the chat opens that conversation first
  (`chat/[id]` `conversation`, `jumpStep`), then pages that conversation's
  own chat back to the line (`loadUntil(key, …)`) and lights it up. It
  switches once: moving to another conversation afterwards stays there. A
  hit from an older Mac says no conversation and is looked for in the one
  on screen.
- **Routines.** With more than one conversation, each routine on the agent
  sheet says which it runs in ("In “Launch plan”",
  `routineConversationLine`), and its menu has "Run it in another
  conversation" on a Mac that lists `agents.conversationRoutine` (the most
  recent six, `routineMoveChoices`).
- **Pages.** A conversation's living page ([agents.md](agents.md), "A
  living page per conversation") sits above the messages on a Mac that lists
  `agents.page` (`components/ConversationPage.tsx`, `lib/page.ts`).
- **Rewind, fork and edit** (docs/agents.md, "Rewind, fork and edit").
  Long-press one of your own messages for Edit and resend, Fork from here
  and Rewind to here (on a Mac that serves `agents.conversationRewind` and
  `agents.conversationFork`). Rewind and Fork confirm first, in the desk's
  words (`rewindConfirm` / `forkConfirm`), naming the agent's copy when it
  has one. Edit puts the message back in the field under an "Editing your
  message" bar; sending goes back to just before it (`sendEdited`: the
  rewind first, then the send), and a refused rewind leaves the words in the
  field. Going back in place waits while the agent works or you drive it; a
  fork never does, and opens the new conversation. What a rewind passed over
  folds into one "Rewound · N messages" row that opens in place
  (`lib/goBack.ts`, `foldRewound`), drawn as past as on the desk: a rule
  down the left from that row to "End of what was rewound", the lines muted
  (`PAST` in `lib/theme.ts`). On the web build, rows that rise in while
  a rewind reshapes the list can overlap until the chat is drawn again;
  qa:web's `goback-rewound` reloads before its shot.

### Rooms

Group conversations of 2–6 agents ([agents.md](agents.md), "Rooms"), on a
Mac whose `welcome.features` has `rooms` (`roomsOffered`, `lib/rooms.ts`).
An older Mac, or one without rooms, shows none, and nothing kept from
before is drawn.

- **Gating, both ways.** The phone says `hello.features: ["rooms"]`. Only
  then does the Mac send `rooms.changed` (every room, after any change;
  journaled, latest only) and the lines only a room has: the user's message
  there and room notes, which carry `room` and an empty `agentId`
  (`wire::for_app`). A member's own line said in a room carries its
  `agentId` and `room`, so an older app still gets it, in that agent's chat
  (as older builds show it).
- **Store.** A room's thread is a chat under `room:<id>` beside the agents'
  chats, so paging (`rooms.messages`, same `asOf` merge), upserts and the
  outbox are the chats' own. A member's line goes in both its room and its
  own chat (`chatKeysOf`), where runs of it fold into one quiet line, "In
  Month end · 2 messages · 4:12 PM", that opens the room; a card still
  waiting on you stays whole there too. A reply being written in a room
  streams in the room, not in the agent's chat.
- **List.** A **Rooms** section under the agents (most recent first; the
  agents get their own label once it's there): two whole member badges
  corner to corner and "+N" for the rest (never a third tile cutting
  initials), the name, "Needs your OK" while a member's card waits (no dot
  beside it), "Ops is replying",
  else the Mac's preview ("Ops: Filed."), unread as a dot.
- **Room.** Neutral accent (`AccentProvider color={null}`): no single
  agent's. The header is the room, two badges side by side (+N), and its
  members ("Finance and Ops", joined as the desk's `listNames`), or who is
  replying. Each member's name and badge sit over its first line in a run,
  in its own colour; the rows are the chat's own `MessageRow`, so approval,
  secret and session cards answer for the agent that asked (by the line's
  `agentId`). As in the member's own chat (the desk's `RoomChat`), the
  newest change card for a member's open copy offers Discard / Keep changes
  (`liveCopyCards`), and that card also stays whole in the member's own
  chat; a result card's **Ask for changes** opens the member's own chat with
  the request staged ("Changes to …"), since a room message can't revise a
  result. A member's @mention of another in its reply is drawn in that
  member's colour (whole names, as `rooms::mentioned_in`). Your lines are
  bubbles with "To Finance and Ops" (or "To everyone" when every member was
  asked) under them, from the `mentions` the Mac recorded. Members whose
  `status.room` is this room show their draft or working line. The room
  opens on what it is: everything said there is posted for everyone in it,
  and each agent keeps its own memory and remembers its own chat when it
  answers there (a room turn resumes its own session).
- **Composer.** `@` offers the room's members and `@everyone`, nobody else.
  Sending settles who answers the way the Mac does (`answerers`: named,
  everyone, else the lead); with nobody, it asks **Who should answer?** with
  each member and Everyone, and sends nothing until one is picked. The foot
  line is the desk's `addressLine`, word for word: "To Finance · @ someone
  else, or @everyone", "To Finance and Ops", "To everyone · 3 replies", or
  "Who should answer? @ someone"; while members reply, the turn cap ("3 of 8 replies for this
  message"). Text only: no attachments or quotes in a room yet. Offline, a
  room send waits in the outbox like any other (`PendingSend.roomId`).
- **Search.** A hit with `roomId` groups under its room and opens it.

### Starting things

The phone can start work as well as answer it. Each piece is gated by
`welcome.methods`, so an older Mac shows less instead of failing.

- **Import agents** (the ⋯ menu beside New agent on Agents, or the home's
  one-time "Already have agents in another assistant?" card while the Mac
  says it's undecided and serves `agents.setImportChoice`;
  `app/import.tsx`, on a Mac that serves `agents.import.status`). Three
  steps, one screen at a time (`lib/importChoice.ts`, "Step n of 3"),
  polled every 3 s while open: (1) Remote access on and the
  assistant connected, ticked from what the Mac reports
  (`remoteAccess.enabled|funnelOn|everConnected`); when it isn't, the screen
  says exactly what to do **at the Mac**, once: turn on Remote access (this
  app's own Funnel mount, beside Ship Studio's) and Copy link into the
  assistant's connectors. The link is a key, so it never comes to the phone
  (docs/remote-access.md, "Security"). (2) **Start** (`agents.import.start`,
  the desk's `connector::arm`), then **Copy message**: the import prompt,
  which holds no secret. (3) Where it has got to, in one line, and **Open
  Chief of Staff**, where every import card is answerable here: the consent
  card (Allow / Deny), the plan played back ("Add something" sends the
  words as the card's note, "That's all" is its Allow), and the review card
  (`PhoneReviewCard`: each agent's role and instructions, then **Import N
  agents** through `agents.import.review`). From the phone every kept agent
  comes in new (a name already here arrives as a copy) and the Chief's
  notes aren't added: Replace, with its diff and consequences, stays on the
  Mac's card. An older Mac's review card still says "Review on your Mac".
  **Stop import** is `agents.import.stop`.
  Without Remote access, a Mac listing `import.export` also takes the old
  assistant's reply pasted here (`components/ImportPaste.tsx`: Copy the
  message, paste the reply back, `agents.import.exportReview`); a cut-off
  or JSON-less paste says its own fix, and it ends on the same review card
  in the Chief's chat (docs/agents.md, "Import").

- **New agent** (the pencil on Agents, or the empty list's button;
  `app/new-agent.tsx`). On a Mac listing `MAC_FEATURES.draft` it opens as
  the desk's dialog does, describe-first: "Describe the agent you want", one
  big box and **Draft it** alone, with "Its name, what it does and when it runs, for
  you to check before anything is made." under it, then the other ways in as
  quiet links in the desk's words: "Or fill it in yourself, start from
  <ready-made agents>, or ask your Chief of Staff." Fill it in yourself (or
  a ready-made agent) shows the form, with "Or describe it instead" back to
  the box. The form: "What should it do?", then an optional
  name and colour. With no name, one comes from what you wrote ("Keeps my
  inbox down to what matters" → "Inbox", made unique against the team;
  `lib/newAgent.ts`): it's the field's placeholder and the Create button's
  words, so nothing is named unseen. The colour starts on the first one
  nobody wears, as the desk's editor does. `agents.create` calls the desk's
  own `agents_create` with no engine or model, so it starts on the defaults
  for new agents (Settings → Agents, falling back to the first ready engine
  when the chosen one isn't). **Draft it** asks the Mac to draft the agent
  (`agents.draft`, see docs/agents.md, "Describe the agent you want"): the
  draft fills the name and colour and adds a review (`components/draftReview.tsx`:
  "What it knows" to edit, a switch per routine, the apps line), and Create
  sends the reviewed `instructions` and kept `routines`; "Start over" goes
  back to the box with your words in it. The routine sheet's **Then…** adds steps
  (`components/stepsEditor.tsx`) on a Mac listing `MAC_FEATURES.steps`, and an
  "OK to go on?" card answers Stop here / Go ahead (`components/gateBody.tsx`).
  Otherwise the phone can't set the engine, model,
  project or instructions at creation (refused with `bad_params`): the
  instructions are edited afterwards from the agent sheet, on either side,
  the engine and model from Agent controls (below) or the desk, and the
  project at the desk. The name and role are one
  line each, without control characters, at most 40 and 500 characters, and
  a phone can make at most 10 agents a minute (refused with `rate_limited`). The create is audited as `create <name> — <role>`,
  and a retry with the same `clientId` returns the first agent. Once the
  overview has it, its chat opens with the composer up.
  **Ask your Chief of Staff to set it up** (on the form; "ask your Chief of
  Staff" on the describe page) writes the request into the Chief's
  draft ("Can you set up a new agent? What it's for: …") for you to read and
  send. On a Mac without `agents.create`, that is all the sheet offers.
- **Routines** (`app/schedule.tsx`). A picker instead of the "when: what"
  line: When is chips (Every day, Weekdays, Weekly with day chips, Monthly
  with Every month / Every 3 months and one "On the [15th] [day]" row whose
  two parts open the system's list, Every few hours, Once with Today /
  Tomorrow / the next five days) and the platform's
  own time picker; What is one line. Above Save it echoes the routine
  ("Every weekday at 9:00 AM — Draft my day", `routineEcho`) and the Mac's
  parser confirms the first run. The picker writes the grammar's own words
  (`routineWhenPhrase`: "every monday and thursday at 08:30",
  "2026-11-20 09:00"), so it uses the existing `agents.schedule.*` methods
  and makes exactly what the desk's composer would. Edit opens a check-in on
  the chips that made it; a routine every few months is re-sent "starting
  <month of its next run>" so an edit keeps it on its months.
  `packages/companion-protocol/src/routine-phrases.json`
  lists every kind of phrase the picker writes; the mobile tests check the
  picker writes them and a Rust test (`agents::schedule`) checks the Mac's
  grammar reads each back as the same schedule.
  **"When…" routines.** On a Mac that lists `agents.watch.create`, a new
  routine opens with "At a time / When…" (`ROUTINE_MODES`), and When… is the
  desk's composer (`components/whenComposer.tsx`, words and rules from
  `whenComposer.ts` in companion-protocol): When this happens over the
  sources (including an email arriving in the Mac's Mail or a text in its
  Messages, free once Full Disk Access is on there, which the phone can only
  name), a folder chosen from the Mac's own list (`agents.watch.options`;
  never a typed path, which the Mac refuses), Through, Check every, What, the
  echo and what each check costs. A "When…" row on the agent sheet offers
  Check now, Pause, Edit and Cancel; on an older Mac it stays read-only.
  docs/agents.md, "“When…” routines", has the rules. Captured as
  `schedule-when`, `schedule-when-folder`, `schedule-when-custom` and
  `agent-sheet-when`.
  **Times are the Mac's.** The Mac reads the words on its own clock
  (`chrono::Local`), so the picker works in `welcome.timeZone`: "Today", the
  date chips, the past check and a one-off's Edit are the Mac's, and when
  that clock isn't the phone's the echo, the first run and the time row say
  "Mac time" ("Every weekday at 9:00 AM Mac time"). An older Mac sends no
  zone, and the phone's clock is used as before. An edit that leaves the
  When as it opened sends an empty `when`, which keeps the schedule (and a
  pending retry) and changes only the note, so "every 2 hours" isn't
  re-anchored to now and a one-off isn't moved; only a Mac that sends
  `timeZone` gets that, since an older one refuses an empty `when`.
- **Dictation** (`lib/dictation.ts`, `components/Waveform.tsx`, the mic in
  the composer). Tap the mic: a haptic, the keyboard steps away (and comes
  back afterwards if it was up), and the field listens. The words stream into
  it as you speak, the last few lighter while the recognizer is still
  deciding them (`stablePrefix`: what a partial shares with the one before,
  never its last word), with the recognizer's own punctuation, at the
  field's full width, wrapping exactly as typing does. The field is a card
  while it listens, as Claude's dictation is: the words on top, and one row
  under them of ×, the waveform filling the middle, **Stop** and **Send**.
  The mic stays while an agent works, so what you say then queues. **Stop
  keeps the words in the draft** to read and edit; **Send** sends exactly
  what's on screen at once (the reducer's `send`: the partial too, then the
  recognizer is aborted so no late word lands in the emptied field).
  Nothing is sent unless you press Send (the desk's rule too). × puts the
  draft back as it was. Tapping the words is Stop and edit. After about 3 s
  of quiet following speech it stops by itself, as Stop does
  (`AUTO_STOP_SILENCE_MS`), and gives up after 8 s if it heard nothing
  (`NOTHING_HEARD_MS`), saying so.
  **The waveform** is driven by the recognizer's own input level
  (`volumechange`, every 50 ms) through a shared value: on the UI thread a
  frame callback eases it (quick rise, slower fall), pushes a bar every
  70 ms and slides the strip between pushes, so it scrolls at the display's
  rate however the events arrive; bars settle to dots in silence
  (`lib/waveform.ts`, geometry in `theme.waveform`). Under Reduce Motion a
  thin meter fills with the level instead and nothing travels.
  **Where the words are recognised:** on the phone whenever it can be
  (`requiresOnDeviceRecognition`, iOS and Android 13+), else through the
  platform's speech service, and then the line over the field says so
  ("Recognised by Apple, off this phone"; on Android it names nobody, since
  the service is whichever the phone has). An on-device start that fails
  before hearing anything (model not downloaded, "Failed to initialize
  recognizer") tries the platform's service once (`fallsBackToServer`). The
  desk does the same (`commands/dictation.rs`).
  **Problems** come back as one plain line over the field with a fix chip
  (`problemCopy`): permission → Open Settings; no network, recognizer busy,
  interrupted, didn't start, nothing heard → Try again. The mic is never left
  dead: every path ends in idle. The phases are a pure reducer
  (`dictationReducer`: idle → starting → listening → stopping → idle, ending
  `done`, `cancelled`, `sent` or `error`). The team's names are passed as
  contextual strings. Nothing is recorded to a file (a voice message's
  recording, below, only when asked for).
  **Expo Go has no recognizer module**, so there the mic focuses the field
  and points at the keyboard's own mic; a development or release build
  (`pnpm ios`, `expo run:ios --configuration Release`) has it. The config
  plugin adds the microphone and speech-recognition usage strings. iOS has
  one microphone string for the app (expo-camera and expo-image-picker
  write it too), so it says only what the mic is for; where the words are
  recognised is in the speech-recognition string.
  **The simulator's recognizer doesn't start** (iOS 27.2: "Failed to
  initialize recognizer", on-device and server alike), so the flow there was
  checked by feeding the native module's events (levels and partials) from
  outside; the web QA build uses a scripted stand-in
  (`dev/web/expo-speech-recognition.ts`), and `QA_SCRIPTED_DICTATION=1 npx
  expo start --dev-client` gives a simulator build the same one (silent: no
  microphone, no sound). Real recognition, real levels and the fallback need
  a phone.
- **Voice messages** (the same `lib/dictation.ts`: `held`, `release`,
  `sendsOnRelease`, `holdEnds`). **Hold the mic** (300 ms) and it listens
  while you hold, the words streaming into the field as a tap's do; **let
  go** and once its last words are in, the draft is sent as Send would send
  it; **slide away** more than 64 pt before letting go and nothing is sent
  (the draft goes back as it was). The field keeps the shape it had when the
  hold began (`ComposerField`'s `hold`), so the mic isn't moved out from
  under the finger, which would end the press; the held mic is the accent
  and the line over the field says "Let go to send · slide away to cancel".
  A pause never stops a hold that has heard you; letting go does. Nothing is
  sent when it heard nothing or ended on an error (the words stay to read),
  and a request the recognizer ended by itself while still held sends on
  letting go. Recognition is dictation's: on the phone when it can be.
  **The recording** is kept only with Settings → Voice → **Attach the
  recording** on (off by default): a 16 kHz 16-bit WAV (about 2 MB a
  minute, under the Mac's 25 MB a file) that the recognizer writes to the
  phone's cache, uploaded with the words to the paired Mac as "Voice
  message.wav" and deleted from the phone once sent; a failed upload sends
  the words and says so. Otherwise nothing is written to a file. No audio
  ever goes anywhere but the paired Mac.
- **Listen** (`lib/readAloud.ts`). Hold an agent's reply → **Listen**: the
  phone's own voice reads it (expo-speech: AVSpeechSynthesizer, Android's
  TextToSpeech), never a service. It reads the reply as it would be said
  (`speakable`: markdown's marks gone, a code block as "Code.", a bare link
  as "a link to example.com"), in pieces of at most 4,000 characters cut at
  sentence ends. One reply at a time; another stops the first. A bar over
  the composer ("Reading aloud", `BAR_ORDER`'s `reading`) pauses and carries
  on with a tap (iOS; Android's engine can only stop) and stops with its ✕;
  leaving the chat or the app stops it. **Silent mode:** on iOS it plays in
  the app's own audio session, set to `soloAmbient` before every reading
  (dictation leaves it set for recording), so the Ring/Silent switch mutes
  it as it mutes a game, and the bar says so. Android has no silent switch
  for media and plays at media volume, which its bar says instead.
- **Talk** (`app/talk.tsx`, the loop in `lib/talk.ts`). A hands-free
  conversation with one agent: the waveform button in any chat's header
  (the Chief's too, and on the Agents tab's embedded chat), or Home Screen →
  **Talk to <Chief>** (`lib/quickActions.ts`). A whole screen, not a sheet,
  so a request it opens goes on top of it: the agent's big key, a status
  line, a level meter (the dictation `Waveform`: a thin bar under Reduce
  Motion), the last four lines (what you said, what it answered, what it's
  hearing now), and End. Nothing new underneath: listening is dictation's
  recognizer (`useDictation`, held, so its own 3 s silence stop never ends
  your turn), sending is `send` (the outbox while the Mac is away, and the
  screen says so), speaking is Listen's voice (`readAloud`).
  **The loop** is a pure reducer (`talkReducer`): listening → countdown →
  sending → waiting → speaking → listening, until End or leaving. After you
  speak, 1.2 s of quiet (`TALK_SILENCE_MS`) starts a visible countdown of
  2 s (`TALK_COUNTDOWN_MS`, "Sending in 2" and a filling bar, the bar left
  out under Reduce Motion) with **Cancel** (drops the words, listens again)
  and **Send now**; talking again goes back to listening with the words
  kept. Each reply is read once it lands (not word by word while it
  streams), in order; a failed turn's line is read too; **Talk now** skips
  the rest and listens. A turn that ends with nothing to read hands back to
  you. What was in the chat when Talk opened is never read; a chat not yet
  loaded counts from its first load. Three listening sessions in a row that
  heard nothing (about 24 s) stop listening until you tap **Carry on**.
  **Approvals are never answered by voice.** A card (or `needsYou`) pauses
  the loop wherever it is: the mic stops and drops what it heard, a reply
  being read stops (and is read again after), it says once, aloud, "<name>
  needs your OK. Tap the screen to look at it. I won't answer it by voice",
  and the only way on is **Open the request** (`/request`, Deny · Allow
  under the thumb). Carry on does nothing while a card waits; once it's
  answered, the loop carries on by itself. Talk opened on an agent that
  already waits opens paused.
  **Interruptions:** the recognizer's `interrupted` (a call, another app
  taking the mic) and the app going to the background pause it with a line
  and Carry on ("inactive" doesn't: the permission sheet and Control Center
  cause it). A refused microphone or a failed send pauses with the plain
  reason. **Silent mode** is Listen's: on iOS the Ring/Silent switch mutes
  the replies (the screen says "On silent, replies show here but aren't
  read aloud"); headphones and AirPods take the audio and the mic as the
  system routes them; Android plays at media volume. Half duplex: it never
  listens while it speaks, so the phone's own voice isn't heard as yours.
  With no recognizer in the build (Expo Go) the screen says so instead of
  listening. Recognition stays on the phone when it can (dictation's rule);
  no new service, no audio kept.
- **The composer** is the system's glass where the phone has it
  (`components/Glass.tsx`, expo-glass-effect: iOS 26 Liquid Glass, the tab
  bar's material), shaped as Claude's own input: empty or one line, a 48pt
  capsule with 17pt text and everything inside it as 40pt circles (the + at
  the left; the mic, Stop while a turn runs, and Send as accent-tinted glass,
  dimmed until there's something to send). The mic is always there, so you
  can talk while an agent works; what you say queues as typing does. Once
  the words would wrap, or files are attached, or it listens, the capsule
  becomes a card: the files as thumbnails at its top, each with its ×, the
  words across its whole width, and a row under them with the + and the
  model chip at the left and the buttons at the right. An empty field is
  always the capsule, at any width (`fieldIsCard`), and its placeholder is
  drawn by the app on one line, clipped with an ellipsis, never by the input
  (a multiline input wraps it while the field lays out).
- **The model chip and Agent controls** (`lib/agentControls.ts`,
  `components/AgentControls.tsx`, the `controls` sheet). The chip says what
  the next message runs on as Claude's own does: the model ("Opus 5.5"),
  and its effort lighter after a dot ("· High") when one is set. The
  version is only ever the engine's: `context.model`, its own id for the
  model of the last request (`claude-opus-5-5`), named by `claudeModelName`;
  without a reading it is the name the engine lists the model under
  ("Opus"), and on the engine's default with nothing reported, the engine
  ("Claude Code"). A reading from another family than the one chosen (from
  before a switch reached a turn) never wins. A tap opens Agent controls, a
  sheet with only what exists and can change mid-conversation: **Model**
  (the engine's models by name, what each is for under it, "Engine's
  default" saying which model that is now; then "Switch to …" for each other
  ready engine, which keeps the conversation), on a Mac listing
  `agents.engine`; **Effort** (Default, Low, Medium, High) on one
  listing `agents.effort`; **How much it does on its own** ("Same as team"
  and the four levels, `agents.setAgentIndependence`; going past the team's
  level asks first, with what it then does and what still asks); **Usage**,
  the team's mode read-only (there is no per-agent budget; `agents.usagePlan`)
  and a tap to the usage sheet; and **More about** the agent. Model and
  effort apply from its next message and the Mac writes one quiet line in
  the chat ("Now on Opus · High from its next message"). While a turn runs,
  or the Mac is being driven, they're dimmed with why; the level stays open,
  since it applies at the turn's next step. On a Mac with none of these the
  chip is a label. The queued line ("… reads it when this turn
  ends") runs full width over it with Send now at its right. On iOS
  before 26, Android and the web build it's `composerFill` with its
  hairline. The chat header's ⓘ is a native bar button (`Stack.Toolbar`) on
  iOS, so the system draws it as a true circle.
- **Crash-safe drafts** (`lib/drafts.ts`, `lib/crash.ts`). The draft (typed
  and dictated words, quotes, @mentions, uploaded files) is on disk within
  `DRAFT_SAVE_MS` (300 ms) of every change and at once when the app leaves
  the foreground; a send puts its message in the outbox file before the
  emptied draft is written, so the words are always in one or the other. A
  draft brought back at launch says "Restored your draft" once. A send in
  flight when the app died comes back waiting with the same `clientId`, so it
  goes once (the Mac returns the original for an id it has seen), or after
  `OUTBOX_WAIT_MS` shows "Not sent · Send". An uncaught JS error writes the
  drafts and the outbox (for up to 1.5 s) and logs to `crash-log.json` on the
  phone (nowhere else) before the app ends; a run that ended while on screen
  (a native crash) is caught by a foreground marker (release builds only).
  The next launch says "The app closed unexpectedly. Your draft is safe."
  on Agents. A screen that fails to draw shows its own `ErrorBoundary`
  (`components/ScreenError.tsx`, exported by every route) with Try again and
  Go back, so the navigator keeps working; the root layout's is the last
  resort and also lets the splash go. Worklets in `lib/` are rebuilt as the
  UI runtime runs them in tests (`__tests__/uiRuntime.ts`): a throw there
  ends the app.
- **"Send to agent…"** (`app/share.tsx`, `lib/share.ts`). Something shared
  into the app (a page, text, photos, files) lists your agents, with the
  shared text in full; picking one puts the link and text in that agent's
  draft as a quote (sent as a `> ` blockquote, never mixed into what you'd
  typed, which stays as it was) and uploads the files as its attachments,
  then opens the chat to add a line and send. Nothing is sent from the
  sheet. Two ways in:
  - **The share sheet**, through expo-share-intent's native extension
    (`lib/shareIntent.tsx`, `app/+native-intent.tsx` for its
    `<scheme>://dataUrl=…` link). What it hands over waits in memory under
    a one-time key (`stashShare`), and the route carries only that key
    (`/share?k=…`): this is the only way files reach the sheet. The
    extension target needs an App Group, which a free Apple team can't
    always sign, so its config plugin is
    **off unless `SHIPSTUDIO_SHARE_EXTENSION=1`** is set for `expo prebuild`
    (`app.config.ts`: text, one web URL or page, up to 10 images or files;
    Android `text/*`, `image/*`, `*/*`). The flag also reaches the app as
    `extra.shareExtension`, and that is what the app checks: autolinking
    links expo-share-intent's native module into every dev and release
    build (it can't be excluded per build from `app.config.ts`), so
    without the flag the module is present but inert. The app never loads
    the package's JS, so its hook never runs, never refreshes on
    foreground and never reads an intent another app sends. A free-team
    build's config and behaviour are otherwise unchanged. The package is
    pinned to an exact version (9.0.0), as a native module with a config
    plugin should be. To build
    it: `SHIPSTUDIO_SHARE_EXTENSION=1 npx expo prebuild --clean`, then
    `npx expo run:ios` with a team that has App Groups. EAS needs the
    extension's bundle id registered too (expo-share-intent's README,
    "iOS Extension Target"). **Not verified on a device yet.**
  - **A link**, `<scheme>://share?text=…&url=…&title=…` (in Expo Go,
    `exp://<host>:<port>/--/share?…`). Any web page or app can open one,
    so it brings words only: `text`, `title` and an `http(s)` `url`.
    **Never files**: a `files=` param is ignored, since a link could
    otherwise name a file in the app's own storage, under a harmless name,
    and have it uploaded to the Mac. The sheet says the words came from a
    link and asks you to read them before sending.

### Siri, Shortcuts and the Action button

"**Tell** / **Ask** / **Message** \<app\>" asks for the words and sends them
to the Chief of Staff; "**Tell \<agent\> in \<app\>**" to that agent. Both
are also actions in Shortcuts ("Tell Your Chief of Staff", "Tell an
Agent"), so they can sit on the Action button or a Home Screen shortcut.
Built on **expo-app-intents** (`lib/siri.ts`, `lib/siriBridge.tsx`):

- **The intents are Swift in `mobile/app-intents/`** (`TellAgentIntent.swift`,
  `AppIntentsSetup.swift`), compiled into the app target by Expo inline
  modules (`experiments.inlineModules.watchedDirectories`), since Apple's
  App Intents metadata extraction can't see code in a pod. The intent only
  records the request (`AppIntentDispatcher.dispatch("tellAgent")`) and opens
  the app; Siri says "Opening the app to send that", never that it was sent,
  because nothing comes back from JavaScript.
- **The app sends it** once paired and holding its team: to the agent named
  (by id from the catalog), else the Chief; trimmed; through the outbox as
  typing would, then opens that chat. Each request sends with the `clientId`
  `siri-<request id>` (`sendOnce`), so a replay after the app died mid-way
  is one message: the system keeps a request until the app removes it. An
  empty request, an agent since deleted, or no team yet sends nothing and
  says why.
- **No link sends.** There is deliberately no URL for this: any page or app
  can open a link, and it must never speak as you. Only the system's intent
  runner (something you said, or a shortcut you set up) gets here.
- **Agents' names** are published as the `agent` catalog Siri matches
  ("Inbox", the Chief also as "Chief"), in the app's own storage on the
  phone, and re-published when a name changes. Names only.
- **No entitlement**: App Intents need none, so every build has them,
  self-built on a free team included. Phrases are compiled in; a new phrase
  needs a new build, not an update.

Checked: the Swift typechecks against expo-app-intents' signatures (iOS 16.4,
Swift 5 and 6), `expo prebuild` puts `app-intents/` in the app target, and
jest covers the plan (`siri.node.test.ts`). **Not yet tried on a device or
built in Xcode**: Siri's phrases, the follow-up question, the catalog's
matching, and the cold-start hand-over all need a phone.

### Live Activity while an agent works

The Lock Screen and Dynamic Island show one activity for the whole team
while anyone is busy (`lib/liveActivity.ts`, `lib/liveActivityLayout.tsx`,
`lib/liveActivityBridge.tsx`): the lead agent's key colour and name,
"Working…" with a clock from when its turn began (only when the Mac sent
`status.since`; no clock is drawn from a guess), or "Needs your OK" in the
warning colour, and "+2 more". Waiting on you leads, then the longest turn.
Tapping it opens that chat.

- **What it may say:** the agent's name through `redact` (as a notification's
  title is) and fixed words. Never a card's text, a step, a reply or a
  preview: `activityProps` builds the only props there are and the test
  holds them to exactly those fields.
- **When:** ActivityKit starts one only while the app is in front, and only
  while the Mac is connected (a saved overview is last-known). While open it
  updates as the team changes and pushes its stale date on every 4 minutes.
  A suspended app can't update it (that needs ActivityKit push through the
  relay, not built), so after 10 minutes without an update it reads "Open
  the app for the latest", and opening the app brings it up to date or ends
  it. Ended activities go at once.
- **Where it's built:** expo-widgets' config plugin adds the widget
  extension, which needs an App Group a free Apple team can't always sign.
  So, like the share extension, it's only in a build made with
  **`SHIPSTUDIO_LIVE_ACTIVITY=1`** (`app.config.ts`: the extension
  `<bundle id>.LiveActivity`, the group `group.<bundle id>`, and
  `extra.liveActivity`, which is what the app checks). Without the flag
  expo-widgets is kept out of the Podfile (`withoutWidgets`, so no widget
  bundle is built at Xcode time) and out of Android autolinking with
  @expo/ui (`expo.autolinking.android.exclude` in `mobile/package.json`).
  The look is SwiftUI through @expo/ui, written as a `'widget'` function
  that babel turns into a string and the extension runs.

Checked: `expo prebuild -p ios` with and without the flag (the
`ExpoWidgetsTarget` target, the App Group, `NSSupportsLiveActivities`), and
jest for what it shows and when (`liveActivity.test.ts`,
`voiceBuild.node.test.ts`). **Not built in Xcode or seen on a device.**

### Connection status

The Connection screen lists each layer in order, ok / problem / unknown with
when it was last known: this phone online (NetInfo); Mac reachable (route,
latency, last seen, likely causes from the last status); Mac awake
(keep-awake, lid mode, battery); the app running (only ever yes when the
server answered, since silence looks the same either way); Claude Code
installed and signed in (a `signed_out` turn makes it a problem whatever the
check says); each agent's capabilities; this device.

**The connection bar** (`ConnectionBar` in `components/ConnectionPill.tsx`,
worded by `linkBar` in `lib/connection.ts`). Screens say nothing while all is
well. When something isn't, every tab (Catch up, Agents, Projects) shows one
bar at its top, on the content margin, in the chat bars' surface: what's
wrong, when the phone last heard from the Mac ("Last heard from it 2 min ago
· showing what was saved"), one **Try again**, and **What to check** folded
under it, ending in Connection details. In a chat the same words are the
first bar above the composer. It's the only place the link is said: no "as
of" on Catch up's header, the Agents list or Projects (only a refusal, which
has its own card, keeps "as of" there), no toast for a refresh that failed
because of it, and a pull's "Couldn't reach your Mac" line stays folded while
the bar shows. What's listed under it stays readable.

What it says, in order: this phone offline; the Mac's app said it was closing
("Waiting for the app on your Mac", up to 2 minutes); the first 15 s of
trying (counted again from when the app comes forward), and a reconnect
under 2 minutes old, read "Reconnecting to your Mac…" (`CALM_MS`), held back
for the first 2 s; past that, **"The app on your Mac isn't responding"** when
the phone saw something at the Mac's address take the connection but the
app not answer (a request that timed out while the Mac's heartbeat still
came, `connected.stuck`; or a socket that opened and stayed silent,
`appStuck` on the trying states: restart the app), else **"Can't reach your
Mac"** (nothing answered: asleep or shut, Tailscale off or another account,
or the app stuck). Every cause is a "may"; none is the user's fault. When a
bar that was shown clears, "Back in touch with your Mac" shows for 2.5 s,
then nothing. `pnpm qa:web --phases link-down` captures each of these
(`--hung` makes the mock take sockets and say nothing).

### Offline cache and outbox

Two places, by what losing the file costs (`lib/persist.ts`):

- **The chat history copy** (`cache-<serverId>.json`) is in the caches
  folder (iOS `Library/Caches`, Android's cache dir). The OS may clear it
  when the phone is nearly full; it all comes back from the Mac. Backups
  don't copy it.
- **What only the phone has**: the outbox (`outbox-<serverId>.json`),
  drafts and preferences, in iOS `Library/Application Support` (Android's
  files dir), which the OS never clears. expo-file-system 58 can't set
  `NSURLIsExcludedFromBackupKey`, so these few kilobytes of the user's own
  words are in device backups; the token (keychain) and secrets (never
  written) are not.

Files an earlier version left (everything in Documents, then everything in
caches) move once per file: copy, read the copy back, and only when it
matches delete the original. A file that didn't copy stays where it was and
is tried again next launch; the old folder goes only when it's empty. The
Application Support path is built from the caches path, since
expo-file-system has no constant for it; that it resolves on a real device
is not yet verified.

The copy (`lib/cache.ts`) holds the overview, Mac status, projects, the last
400 messages of each opened chat and the cursor, written together so replay
after a restart starts exactly where the copy ends. Downloads are cached by blob id or agent + path.
While disconnected, status marks go grey, the connection bar says when the
phone last heard from the Mac, and actions are disabled. A message sent offline waits ("Waiting for …") and goes by
itself, idempotent by `clientId`, for **10 minutes** (`OUTBOX_WAIT_MS`);
after that it is **Not sent · Send · Discard** and never sent on its own,
because a message landing hours later with no one watching is worse than one
that waits. A refusal is final. Forgetting a Mac wipes its files.

Sheets that read on opening (the agent sheet's What it can do and What it
can reach, Memory, Instructions, Files, Without asking) keep their last
answer in memory for the app's run (`lib/remembered.ts`, per paired Mac,
bounded, never on disk, cleared by Forget this Mac). Opening one again draws
that at once and the read refreshes it, so nothing arrives a beat late and
pushes what's under it down; Memory and Instructions opened offline say
they are as last read.

### The demo

**Try the demo** on the welcome screen (or `<scheme>://demo`) opens sample
agents for a fictional café with no Mac at all, for App Review and anyone
without a Mac to pair (`lib/demo.ts`). `DemoTransport` has the transport's
shape and no socket: it answers a short list of methods (`DEMO_METHODS`, so
every other screen hides itself as for an older Mac) and refuses the rest
with "That isn't in the demo". Nothing is kept (credentials are never saved,
and the offline copy, drafts, outbox, badge and quick actions skip it), so a
relaunch is back at the welcome screen. It says what it is everywhere: the
Mac is "Demo Mac", the lists open on "This is the demo" with Pair your Mac,
every chat has the `demo` bar first (`BAR_ORDER`), a send is answered "This
is the demo, so I can't do real work…", and Settings has Leave the demo in
place of Forget this Mac. It never replaces a pairing, and pairing ends it.
Tests: `demo.node.test.ts`; screens: `pnpm qa:web --phases demo`.

### Feel and access

A conversation reads at 17 on a 26 line (`type.read`, `READ_LINE`), with a
paragraph's air between blocks and list items, 14×10 inside your bubble and
28 between speakers; chrome is body 16, secondary 14, and times and meta stay
quiet captions. `textMuted` meets 4.5:1 on panels and Increase
Contrast brightens each grey a step. Every Text scales with Dynamic Type:
chrome clamped at 1.3×, card titles at 1.5×, words at 2× (`READ_MAX_SCALE`,
so a reply still sets a sentence a line at AX3), and at accessibility sizes
the approval card folds its explanation so the answers stay on screen.
From ×1.6 (`LARGE_TEXT`, `useLargeText`: Dynamic Type times Text size) rows
stack rather than truncate: Catch up's action goes under its words, a name
gets its own whole line in usage, and words go under a row's pill; tables
measure their columns at the size the words are set, so a header never
breaks mid-word (the table scrolls). Chips drawn 36 tall carry
`tapSlop(CHIP_H)` to reach 44.
**Settings → Text size** (Smaller 0.88×, Default, Larger 1.12×, Largest
1.25×) multiplies the whole type scale on top of Dynamic Type, saved in
`prefs.json`: `type` reads the size in force and `makeStyles` rebuilds each
sheet per appearance and size, so anything sized from `type` follows it. VoiceOver and TalkBack hear
replies, approvals, failures and toasts (`lib/a11y.ts`, not during replay):
a reply that lands in the chat that's open is read (as said aloud, cut at a
sentence near 280 characters, `replyAnnouncement`), anywhere else "X replied";
the connection bar's verdict is said once across tabs when it appears or
changes (live regions are Android's only). A chart's accessible name says
its values (`chartSummary`: each slice and share, a short series point by
point, a long one by start, end, low and high), and every chart series is 3:1
on app, panel and control in both themes.
A command, code block, table or diff that runs past the edge scrolls sideways
and says so: its far edge fades into the well while there's more, and the
indicator flashes once (`SideScroll`), so a cut-off command never reads as the
whole one. A role squeezed to a stub ("Desig…") beside a name or an account is
dropped instead (`roleCutPastReading`).
Haptics only for send, stop, approvals (after the Mac confirms), failures and
toggles, and can be turned off. Android gets Material symbols, ripples and
predictive back.

### A tested card, and Watch live

When the desk's **Test it** has run (docs/agents.md), the result card's new
version carries `test`. The phone shows it in the card: the outcome in one
line (a warning icon only when something is broken), the agent's summary and
its list of what's broken, "N console errors" (the preview's own capture), and
the screenshots as a sideways-paging strip, each captioned "2 of 3 · <step>"
with the app's own step label. Tapping a picture opens the usual viewer. The
"Changes since v1" line is left off a tested card: the test section says it.

**Watch live** (a text action, like Ask for changes; shown when the Mac serves
`agents.watchLive` and the card names a project or is a copy's card) opens the
card's running site in the in-app browser, read-only:

- The phone asks over its paired socket; the Mac resolves the folder from the
  card exactly as the desk's Preview does (`preview_test::resolve`) and needs a
  dev server already up for it (`proxy::dev_server_port_for`). None: "Open
  Preview on the Mac first — the site isn't running there." The phone can't
  start one.
- The answer is a one-time link: `https://<mac>.ts.net:<companion port + 1>/__<slug>-watch/<ticket>`.
  The ticket is 256 bits, kept only as a hash, bound to that phone and that
  port, and good for a minute. Opening it trades it for an HttpOnly, Secure,
  SameSite=Strict cookie good for 30 minutes (`companion/watch.rs`).
- **Tailnet only**: the proxy binds loopback and is published with `tailscale
  serve` on its own port, never Funnel (the port is never 443/8443/10000, and
  a request Tailscale marks `Tailscale-Funnel-Request` is refused). Started on
  the first Watch live, stopped with the phone server.
- **Read-only**: GET and HEAD only; forms that post and WebSockets are
  refused, so there's no live reload (reload the page). Every request re-checks
  the phone is still paired: removing it on the Mac ends its sessions.
- Passed through untouched: no script injection; our cookie and Tailscale's
  identity headers are stripped, Host is the dev server's own.

Verified: `cargo test --lib companion` (the decision function: one-use and
expired tickets, revoked phones, cookie per port, Funnel and non-loopback
refused, every write method refused, upgrades refused, cookie stripping;
`agents.watchLive` served and audited), `mobile/__tests__/resultTest.test.tsx`,
and the `result-tested` qa:web shot in both themes. **Not verified**:
`tailscale serve` on the second port against a real tailnet, and a real dev
server (Next, Vite) rendering through the proxy on a phone; with HMR refused,
some dev clients may log reconnect attempts.

## Notifications

`lib/notify.ts` keeps them honest: one per alert, grouped per agent
(`threadIdentifier`, the same thread id the relay sets), taken back once
handled anywhere (an approval answered or a chat read, here or at the desk),
the icon badge equal to the desk's Dock badge (`needsYouCount`, the rule `notify::badge_now` mirrors; it once added unread replies and every open card, and disagreed with the Dock), and all cleared on Forget
this Mac. Android has "Needs you" (high) and "Replies" channels. A tap waits
for fonts and credentials, opens at the message, and replaces a chat already
on top instead of stacking.

**Push** goes through `ApnsPush` (`companion/push.rs`) and the content-free
Worker in `services/push-relay`, which holds the APNs/FCM key. The Mac sends
only an opaque device handle, a kind (`needs_you`, `finished`, `message`), the
agent's random id and the badge; the words are fixed in the Worker. An alert
the desk would post (`agents::notify`, which already applies mute, on-screen
and coalescing) is pushed to each phone not in front. It's for official builds
only (a self-built app has no push entitlement), switched on in Settings →
Phone, and **built but not deployed**: design, threat model and deploy steps
are in [push-relay.md](push-relay.md).

**The live notifier** (`companion/alerts.rs`, `lib/liveAlerts.ts`). Every
alert the desk decides on (`agents::notify::post`: a reply or failure at the
end of a turn, a fired routine, and at once every card that needs you:
approvals, plans, "OK to go on?", logins, keys) also goes as an `alert` event
to every connected phone whose hello lists `alerts`, except the socket in
front with that agent's chat open. The Mac has already applied mute, quiet
hours (approvals still go), "on screen" anywhere and the per-turn coalescing;
non-approval alerts are capped at 3 per 20 s, as on the desk. An alert carries
ids, the agent's name and one line through `secrets::redact` and
`work::scrub`, and the phone runs `redact` again. It is never journaled.

- **Where the user is.** The desk's rule is "on screen": a focused window, or
  a phone in front, showing that agent; then nothing notifies anywhere. On top
  of it, **at the desk** (`notify::at_desk`: any of the app's windows has
  focus) the desk's banner is the notification and neither the socket nor the
  relay tells a phone. With the app in the background the Mac can't tell
  where the user is, so desk and phone both hear it. A phone in front on
  another screen does get the alert, as a focused desk window on another
  chat gets a banner.
- **On the phone.** An approval is posted as its card's own notification
  (`approvalNotice`: Allow / Deny when it fits, else Review), whichever of the
  card and the alert arrives first: a plain one first is replaced by the
  card's (same identifier). Everything else posts as said. The same alert
  twice posts once; a muted or hidden agent, or that chat open in front, posts
  nothing. Posting one takes back the relay's content-free banner for that
  agent. With a Mac older than `alerts` the phone keeps posting cards it hears
  in the background itself (`alertApproval`).
- **Taken back** when the card's new state (answered anywhere, expired)
  arrives as `agents.message`, live or on replay after a reconnect, whether or
  not that chat was ever loaded on the phone.
- **Backgrounded vs killed.** iOS gives the app seconds in the background
  (it asks for no background time), then suspends it; its socket still looks
  open from the Mac for minutes. So the socket reaches a phone in front, or
  one that left the screen moments ago. Suspended or killed, only the relay's
  push reaches it, which is why `LIVE_WINDOW_MS` stays 0: a phone not in front
  gets both, and the awake one keeps the banner with words. Until the relay is
  deployed, a phone in the background or killed gets nothing until it opens;
  then the badge and Catch up say what's waiting.

Settings says plainly what arrives when, including that only the Mac notifies while you're using it.

**Answering from the Lock Screen** (`lib/actionable.ts`). An approval the Mac
alerts for (above), or with an older Mac a new card the phone hears in the
background (`agents.message`, after catch-up, not muted or hidden), is posted
as a local notification with the card's words. A card the Mac marked
low-risk (`approval.risk: 'low'`) whose whole content fits and has a plain
pair of answers gets them as buttons (Deny · Allow, or its own words: Stop here · Go ahead, Not now ·
Check again, Ignore · Save to memory); everything else gets **Review**,
which opens it in full: keys, logins, a session's question, step-in,
three-way and import cards always, anything risky or unclassified
(`approval.risk`, decided on the Mac; never re-derived from the words), and
any card where something was redacted. Rules:

- **Allow needs the phone unlocked.** Every card that reaches the phone is
  above the user's independence level (the rest were answered for them), so
  Allow is `isAuthenticationRequired` on iOS; Android actions can't ask for
  that, so there Allow opens the app (unlocking it) and answers. Deny works
  locked and never opens the app.
- **No secret on a Lock Screen.** The words go through `redact` (known key
  and token shapes, `Bearer`, `user:pass@`, `password=`/`token=`-style pairs,
  private keys, long random runs); a key or login card says only what it
  wants. The data is ids only: agent, message, request.
- **The Mac decides.** Allow / Deny is `agents.answerApproval`, the same
  request as the card in the app, so the card's claim (`answer_gate.rs`)
  takes exactly one answer. The phone waits up to 20 s for the Mac
  (`waitLive`); if it isn't reached, or the Mac refuses ("already
  answered"), a "Not answered" notification says so and opens the card.
- **One banner.** The card's notification replaces the relay's content-free
  "needs you" for the same agent (`dismissPushFor`, at once and after 4 s).
  A push itself has no buttons: it carries no words, so there's nothing to
  agree to; tapping it opens Catch up, and a tapped approval opens the
  request in full.

Verified in jest and on the web build only. On a device: whether iOS keeps
the socket long enough after backgrounding to hear a card (it suspends apps
within seconds unless they hold a background task), and whether a button
pressed after iOS has ended the app reaches it (Expo delivers a
non-foreground action to a killed app's listener only on some versions). A
self-built app gets the same local notifications; it just has no push
behind them.

## Installing the app

There is no App Store listing yet. The store build (`COMPANION_STORE_BUILD=1`),
what was checked, the review notes, listing drafts and what only the owner
can do are in [app-store.md](app-store.md). `TESTFLIGHT_URL` and `ANDROID_APK_URL` in
`src/lib/companionInstall.ts` are unset, so those cards say "Not available
yet"; when set, maintainers ship through EAS (`eas.json` profiles map to
`expo-updates` channels), with a build at least every 60 days because
TestFlight builds expire at 90.

**Get the phone app** (the sidebar's foot, Settings → Phone or Cmd+K) is the route today, and follows
the agent-led onboarding pattern: **the agent drives, the app verifies.** It
spawns the user's agent (their engine: Codex when that's the default agent,
else Claude Code, `installAgent`) beside a checklist with a prescriptive prompt
(`buildIosInstallPrompt` / `buildAndroidInstallPrompt`); every check is a
read-only command in `commands/companion_install.rs`, and nothing runs until
the user clicks Start (or Reinstall). The source is a sparse checkout of
`mobile/` and the protocol package into `~/ShipStudio/.companion-build/` at the
**tag matching the desktop's version**, so the protocols match; a dev build
uses its own checkout, and `SHIPSTUDIO_COMPANION_SOURCE` overrides both.

| iOS step | Who | The app's check |
| --- | --- | --- |
| Full Xcode (outdated or missing disables Start) | User, from the App Store | `xcode-select -p` inside an `.app`, `xcodebuild -version` (or the `.app`'s `version.plist` when xcodebuild won't run) |
| License, after every install or update (git and builds fail until then) | Agent (`sudo xcodebuild -license accept`) | `xcodebuild -license check` |
| First-launch components | Agent (`sudo xcodebuild -runFirstLaunch`) | `xcodebuild -checkFirstLaunchStatus` |
| CocoaPods, Node | Agent | `pod --version`, the node check |
| Phone plugged in and trusted, Developer Mode | User (waits while there's no Xcode: devicectl comes with it) | `xcrun devicectl list devices` (physical only; Xcode 27 lists simulators there too, as `simulated`) |
| Signing | User, guided (Xcode → Settings → Accounts) | An "Apple Development" identity's team; else a team of an Apple ID signed in to Xcode (`IDEProvisioningTeamByIdentifier` in Xcode's preferences, the free personal team first), which ticks before any certificate exists because the first build's `-allowProvisioningUpdates` makes it. Xcode's `isFreeProvisioningTeam` says whether builds last 7 days or a year |
| Build and install (Release, so no Metro) | Agent: `expo prebuild`, then `xcodebuild … -destination id=<hardware UDID> -allowProvisioningUpdates DEVELOPMENT_TEAM=<team> CODE_SIGN_STYLE=Automatic build`, then `devicectl device install app` (`iosBuildSteps`) | `devicectl device info apps` lists the bundle id |
| Trust the developer, pair | User (Settings → General → VPN & Device Management) | The device appears in the registry |

**A free Apple ID (personal team)** trips over four things, and the build
handles or explains each:

- **The device id.** `xcodebuild -destination id=` takes the phone's hardware
  UDID (`00008140-…`, `hardwareProperties.udid` in devicectl's JSON, or the
  bracket in `xcrun xctrace list devices`), not devicectl's CoreDevice
  identifier. The status keeps both (`udid` for devicectl, `hardwareUdid` for
  the build); with no hardware UDID there is no Reinstall, and the prompt
  tells the agent to read it from xctrace.
- **Push.** A personal team can't sign the Push Notifications capability,
  which expo-notifications adds as `aps-environment` by default.
  `app.config.ts` passes `enableRemoteNotifications: pushEntitlement()`: on
  only with `EAS_PROJECT_ID` (official builds) or
  `COMPANION_PUSH_ENTITLEMENT=1`, so a self-build leaves it out with nothing
  set. The app already copes (`src/lib/push.ts`, "Needs the official build").
- **Provisioning.** `expo run:ios` doesn't pass `-allowProvisioningUpdates`,
  so a first build can't make its profile. Hence xcodebuild directly.
- **An old Xcode.** Below what the Expo SDK needs, the build fails in
  `expo-modules-jsi` with a Swift "sending 'slot' risks causing data races"
  error; the prompt reads that as "update Xcode", not a code problem.

The bundle id is `<companion.bundleId>.<6 hex of the team id's sha256>` (from `brand.json`): a
free team can't take an id someone else holds, and it never collides with
the official app or Ship Studio's. **A free Apple ID's build stops opening after 7 days**, and
the panel says so before the build starts. Expiry is read from the newest
provisioning profile for that id; the panel shows "Works until …" with a
one-click **Reinstall**, and a reminder fires 24 h before. Android self-builds
`<companion.bundleId>.self` over adb, and doesn't expire.

**Updates and forks.** `expo-updates` with `runtimeVersion: { policy:
'fingerprint' }` (a JS update reaches only binaries that can run it), applied
on the next cold start, with **Restart to update** in Settings. Drafts and the
outbox are on disk, so a restart loses nothing. `app.config.ts` reads
`COMPANION_BUNDLE_ID`, `EAS_PROJECT_ID`, `UPDATES_URL` and `APPLE_TEAM_ID`;
with no `EAS_PROJECT_ID` updates are off, so an official update can never land
on a fork's binary. For self-builders, Reinstall is the update.

**When a Reinstall fails.** Reinstall runs the build with no agent, so it also
`tee`s it (with `pipefail`) into `companion-build/last-build.log` in the app's
own folder. On a non-zero exit the panel reads the log's end back
(`companion_install_build_log`, a fixed path, read-only; the terminal's own
tail stands in if it can't) and `diagnoseBuildLog` (`src/lib/companionBuildLog.ts`)
names the one fix for what a self-build actually meets: Xcode's sign-in
lapsed ("No Account for Team"), a free Apple ID's 3-apps-on-a-phone and
10-app-ids-a-week limits, Developer Mode off, a locked or unreachable phone,
the license after an Xcode update, an Xcode too old for the SDK, a full disk,
no profile. A fix that's the user's offers Reinstall again; every failure
offers **Hand it to** the agent, whose prompt then starts from that log. No
match is never guessed at: it goes to the agent. A phone that won't answer
`devicectl device info apps` with Developer Mode on is a locked phone, and the
build row says to unlock it rather than waiting silently.

## Testing

- **Mock Mac:** `mobile/dev/mock-server.ts`, built on the generated fixtures;
  `pnpm mock` serves it and prints a pairing link (see the mobile README).
- **App:** `pnpm test` in `mobile/` runs the sync rules, chat logic and
  markdown under `jest-expo`, and the real `DirectTransport` against the mock
  (`*.node.test.ts`): a dropped socket mid-turn, a Mac restart, retried sends,
  files, search and schedules. Nothing may be missed or doubled.
  `start.node.test.ts` covers creating an agent, the routine picker's
  phrases (against the mock's parser and `routine-phrases.json`), the Mac's
  clock, and share payloads; `share.test.tsx` the share sheet (a crafted
  `files=` link uploads nothing); `dictation.test.tsx` the state machine on its own and the mic against a
  fake recognizer (streaming, Stop, Send, ×, silence, errors, the fallback,
  Android 12) and holding it for a voice message (let go, slide away, the
  recording only when asked for); `waveform.node.test.ts` the level→bar
  mapping and easing; `readAloud.test.ts` Listen (what's said, pieces,
  pause, stop, a stopped reading's late callbacks); `siri.node.test.ts` and
  `liveActivity.test.ts` what Siri sends and what the Lock Screen may show;
  `voiceBuild.node.test.ts` the app config for both.
  `talk.test.ts` Talk's loop (round trip, countdown, Cancel, Send now, a
  voice mid-countdown, skip, quiet, interruptions, a card pausing it and
  never answered by voice, what's read and shown).
- **Rooms:** `rooms.test.ts` (routing, gating, store keys, folding, the
  room's list), `roomParity.test.ts` (open copies, the foot line, @mentions,
  the intro's claim), `roomView.test.tsx` (the thread, Keep / Discard and Ask
  for changes in a room, the @ menu, "Who should answer?"), `roomsList.test.tsx` (the section only from a Mac with rooms);
  server: `companion::server::tests::rooms_reach_only_phones_that_show_them`
  and `wire::tests::an_app_without_rooms_gets_no_room_events_or_room_only_lines`.
  The mock Mac has two rooms (Launch, led by the Chief; Month end, no lead)
  whose members reply in turn.
- **Server:** `cargo test --lib companion::` (including the fixture drift
  check); **relay:** `pnpm test` in `services/push-relay`.

### Phone screens without a simulator

`pnpm qa:web` (in `mobile/`) renders the app with react-native-web against the
mock Mac and screenshots a fixed list of screens, light and dark, at 402×874
@3x, with headless Chrome over the DevTools Protocol (no Playwright; the same
approach as the desktop's `scripts/harness-capture.mjs`). It starts the mock
(`--http --cors`) and `expo start --web`, pairs through the real `/pair?d=`
confirm screen, then walks the states only a Mac can cause by restarting or
stopping the mock: a deep-linked chat offline with nothing saved, every screen
live (rooms and a task with its terminal shown included), the same chats
offline from the saved copy, "This isn't your Mac"
(`--impostor`), the bar fold (`--bars`), and things going on (`--importing`: the
Chief mid-import with its live bar, the Designer working, the Import screen's
counts, and an 8-frame close-up of the typing dots 150 ms apart with each dot's
opacity per frame in the report), and an account in daily use
(`--heavy`: 17 agents, ~40 cards waiting with logins and keys among them,
paused routines, long chats, an import an hour in), live and offline, and
what agents are doing (`--live-work`: QA 2 five minutes into a Cypress run
with its output open, Finance gone quiet with "Check on it" answered, a
finished Cypress step with its time, counts and output), and the states the
others miss (`--probe`: fifty agents, a very long name, a step-in card with
only Not now, a card answered on the desk while open here, an agent deleted
on the desk while its card is open, three Claude accounts with one out of
usage and one signed out, Runs on, quiet hours, and a turn cut off by the Mac
restarting). Out: `mobile/qa-shots/` (PNGs and
`report.md`, which lists each shot's route, what to check, console errors and
any text cut off with an ellipsis), rewritten after every phase so a run stopped part-way still reports. It exits non-zero when a screen failed or threw; a run is stopped after 75 minutes (`--max-ms`).

```bash
cd mobile && pnpm qa:web
pnpm qa:web --only chat-fixtures --themes dark --out /tmp/shots
pnpm qa:web --phases heavy          # demo,fresh,live,cached,impostor,bars,usage-accounts,heavy,importing,team-setup,live-work,engine,probe,torture
pnpm qa:web --web-port 8098 --mock-port 47498 --cdp-port 9681   # the defaults
pnpm qa:web --font-scale 3.1 --themes light   # large text (AX5)
```

`--font-scale N` stands in for Dynamic Type, which the web doesn't have
(react-native-web reports 1 and ignores `maxFontSizeMultiplier`): the app
reports N as its font scale, so layouts that stack at accessibility sizes
stack, and every `T` is set at N or its own clamp, whichever is less
(`lib/qaFontScale.ts`). Plain `Text` and inputs aren't scaled, so it's a close
stand-in for the device, not the device.

`--phases perf` (not in the default run) times the torture mock's "Long Rich"
chat, 5,000 lines of every kind (markdown, code, timelines, result and
approval cards, pictures): a deep link's cold open to the newest line, a tap
in from the agents list, and 20 s of scrolling back (frame times, long tasks,
how far it got), into `perf-long-chat.json` in `--out`. It runs against Metro's
development build, so read the numbers as relative. `QA_PROFILE=1` adds
`perf-open.cpuprofile` (the last open from the agents list) and `perf-scroll.cpuprofile`.

`--phases net` (not in the default run) counts what the phone costs the Mac
and itself: every request the mock saw (`GET /dev/requests` on the mock, by
method, with the most inside any 250 ms) and, through a stand-in React
DevTools hook, commits, component renders and the component each render
started at. Scenarios: a cold start on a saved copy, 10 s idle, the tabs
three times round, a chat opened three times, tapping between two chats,
the Mac killed and back, and a reply streaming in (in the chat, then from
the agents list). Into `net.json` in `--out`.

The ports also read `QA_WEB_PORT`, `QA_MOCK_PORT` and `QA_CDP_PORT`; `--verbose`
streams the mock's and Expo's output. With a `TMPDIR` longer than 60 characters
(a sandbox's), it works under `/tmp/qa-web-*` and gives its children a `TMPDIR`
there, since tsx's IPC pipe and Chrome's singleton socket would pass macOS's
104-byte socket-path limit; Metro bundles cold in that case. The native-only modules (notifications,
secure store, SF Symbols, the date picker, keyboard controller, file system) are
swapped for stand-ins in `mobile/dev/web/` by `metro.config.js`, **only on the
web platform**, so native builds, Expo Go and jest never see them.

What the web build can't show, so don't file it:

- The tab bar is a dark pill over the large title (NativeTabs draws the system
  bar at the bottom on iOS).
- No safe areas or status bar; headers are JS headers, so no iOS large titles,
  no back buttons on deep-linked routes, and a small Settings title.
- Images behind auth (screenshots, Before/After, the Phone and Preview cards)
  are grey placeholders.
- Icons are Material Symbols (the Android set), not SF Symbols.
- Chrome's focus ring on a focused field; rn-web's Switch look and colour; the
  "0.0.0 (0)" version, the device name "Macintosh" and a grey block for the
  time picker.
- The composer field is two lines tall, and the task header's title can sit off
  centre: rn-web layout, check on a device.
- Nothing rises in: a row arriving in a chat, or your own message, just
  appears. Reanimated's web entering animation for the arrival preset can end
  on its timer before `animationend` and pin the row `position: absolute` at
  window coordinates, which inside the inverted chat drew it ~1,300px from its
  place (`torture-events`: "Written second" above "Written first", the
  burst's replies blank). `arriving()` (`components/Arrive.tsx`) is off on
  the web for that reason; the same events in the iOS Simulator land in order.
- The chat draws only `windowSize` screens around where you are, so a line far
  back isn't in the page's text until you scroll to it: `torture-reconnect`
  reads back to "Plan for the week?" before counting it (counted at the newest
  end it was sometimes 0 with nothing missing).

It says nothing about native-only surfaces (action sheets, Alerts, sheet detents,
the share extension, the camera, real keyboard behaviour).

## Not built

- The LAN route and its pinned-transport module; Bonjour discovery; more than
  one Mac at a time.
- Buttons on a pushed alert, background refresh, and withdrawing a delivered
  push once its card is answered while the app stays suspended (it goes when
  the app next opens). The live notifier is verified in Rust and jest only:
  a banner and its Allow / Deny on a real iPhone, backgrounded and locked,
  are not yet.
- Deleting agents from the phone, and setting a new agent's engine, model or
  project there (it starts on the defaults for new agents).
- Pushing to git from the phone: Remote Access gates it behind a PIN, and the
  phone gets nothing until the owner decides how.
- A needs-you Home Screen widget. The Live Activity is built behind
  `SHIPSTUDIO_LIVE_ACTIVITY=1` but not yet built in Xcode or tried on a
  device, and can't update while the app is suspended (ActivityKit push
  through the relay). Siri and Shortcuts, holding the mic, Listen and the
  silent switch, and the attached recording are checked in tests and
  prebuild only, not yet on a phone. Talk is checked in jest and in
  `qa:web` (`talk-*`, the scripted recognizer and the silent voice) only:
  real end-of-speech timing, the recognizer and the voice taking turns on
  one audio session, AirPods, a phone call mid-loop, and the silent switch
  during Talk are not yet tried on a phone. The "Send to agent…" extension is
  configured behind `SHIPSTUDIO_SHARE_EXTENSION=1` but not yet built or
  tried on a device. Dictation's live waveform, streaming words and
  on-device → server fallback are checked on the simulator against fed
  recognizer events and in tests; the real level, partials and fallback on a
  phone are not yet.
- Verification on Android hardware.
- Rooms on the phone: creating, renaming, muting or deleting one, changing
  its members or lead, Stop for a room, attachments in a room, and opening a
  room's search hit at the line. All are done on the Mac. Room screens have
  not been looked at on a simulator or device yet (in tests and `qa:web`'s
  `room-*` shots only).
