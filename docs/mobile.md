# Mobile companion

The app on your phone. The Mac does all the work; the phone is a thin
client paired by QR code. It shows the same agents, chats, approvals,
check-ins, projects and sessions as the desk, in sync both ways, over your own
Tailscale tailnet.

| Part | Where |
| --- | --- |
| Wire types (the contract) | [`packages/companion-protocol`](../packages/companion-protocol/src/index.ts) |
| Desktop server | `src-tauri/src/companion/`, commands in `src-tauri/src/commands/companion*.rs` |
| Desktop Phone panel | `src/components/phone/`, `src/lib/companion.ts`, `src/lib/companionInstall.ts` |
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

**Limits:** 600 requests a minute per device, socket and HTTP together,
of which at most 10 may create an agent (`MAX_AGENTS_CREATED_PER_MINUTE`;
a retry answered from the `clientId` cache doesn't count); 4 sockets per
device, 16 in all; 1 MB frames; 25 MB a file and 10 files a message
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
32 requests in flight (an open socket counts as one); 10 s for headers,
10 s for the whole pair body, and no 30 s gap in an upload. Uploads go straight to disk with a running cap,
never whole into memory. Thumbnails are refused (422) for images over
40 MP by their own header, before decoding; two decode at a time, and the
last 128 are cached. `agents.memorySuggest` runs two at a time and is
audited. `agents.fetchPath` copies at most 25 MB even if the file grows.

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
  `agents.loginStart|loginsConnect`
- `agents.update` (`pinned`, `muted`, `hidden`, `instructions`),
  `agents.instructions|usage|revokePermission|changeDiff`
- `agents.files|fetchPath|search`, `agents.schedule.preview|create|update|pause|cancel|runNow`
- `agents.create` (`name`, `role`, `color` only; idempotent by an optional
  `clientId`; see "Starting things")
- `projects.list`, `sessions.read|send|key|start`, `preview.screenshot`
- `rooms.list|messages|send|focus` (a Mac whose `welcome.features` has
  `rooms`; see "Rooms")
- `agents.import.status|start|stop|review` (see "Starting things", Import)

Declared in the package but not served: `agents.delete`, the paste import
methods. Pure reads (`READ_ONLY_METHODS`, mirrored in Rust) are not audited.

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
  the phone re-reads the chats it has cached.

Nothing is ever doubled: messages are upserts by id (an answered approval
replaces its card), and `agents.send` requires a `clientId` that the Mac
remembers for 24 h and echoes on the message, so a retried send returns the
original. A page from `agents.messages` carries `asOf`, and only rows whose
last-applied `seq` ≤ `asOf.seq` are overwritten, so a fetch can't undo an
event that beat it.

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

1. **Mac:** Phone panel → **Pair a phone** (or Cmd+K). A one-time code
   (128-bit, 5 minutes, single use) is shown as a QR code of
   `<companion.scheme>://pair?d=…` (`dashbot-companion` today) carrying the code, server id, Mac name,
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
   (`diagnose`: a `*.ts.net` name that doesn't resolve is "this phone isn't
   on your Mac's tailnet", anything else "can't reach *Mac*"), each naming
   the host and the checks: Tailscale connected here, signed in to the same
   account as the Mac. The pairing request keeps the desk's 120 s plus 15
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
  is the token check). **Revoke** in the Phone panel deletes the hash and
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

**Navigation:** native tabs for Agents, Projects and Search; chat, the agent
sheet, files, a session, the diff and the photo viewer push over them. At
700 pt and wider (iPad, landscape) the Agents list and a chat sit side by side.

- **Agents (home).** Needs you (approvals, signed out, usage limit) first,
  then the Chief and pinned agents, then the rest by activity. Attention is
  said once: the Needs you header, with **Open next** (straight to the first
  card waiting) at its right, and each row's own words ("Needs your OK ·
  …", the state word in amber). No summary card over the list and no dot
  beside a row that already says it (rooms too); the tab badge counts it
  from the other tabs. Every other state keeps its mark. Swipe to mute, hide (with Undo) or pin; hold for the
  context menu. Quick actions on the icon: "Needs you" and "New message to
  Chief of Staff".
- **Chat.** An inverted list: newest on the composer, older pages loaded on
  scroll. Replies stream one display frame at a time (`lib/reveal.ts`) and the
  finished message carries on from where its draft got to. What you're
  reading holds still while you're scrolled up or a long reply grows, and the
  jump button says "New reply" when one finished below. Hold a message to
  copy, quote or select text; paths in a reply open through `agents.fetchPath`.
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
  `describeScope`'s sentence) and Deny with note behind ⋯. The answers are
  inert for 400 ms after the card lands, the desk's anti-misclick; Allow is
  the one tap the app must never take by accident.
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
  (`agents.reach`, read-only) are on the phone too.
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
- **Agent sheet.** "Claude · Opus" / "Codex · …", Runs on and Model read-only, Memory (view, edit, forget with
  Undo, add; "Remember This" in a message's menu), Instructions (view and edit), pin/mute/hide, check-ins and
  routines (create and edit with the picker below, past runs, pause, run now,
  cancel), usage, and "Allowed without asking" with Revoke.
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
- **Settings.** The paired Mac, plan usage, what new agents start on, alerts
  (with their limits), haptics, updates, about. **New agents start on** lists
  the Mac's engines (one not installed or signed in is dimmed, saying which),
  and a **Model on …** section per installed engine offers "Engine's default"
  and only the models that engine listed (`lib/newAgentDefaults.ts`). Read
  from the overview's `defaults`; a tap sends `agents.setDefaults`, which the
  Mac checks as the desk does (a ready engine, a model it lists), audits
  ("new agents: engine codex"), and answers with an `agents.registry` event.
  On a Mac without the method the choice shows but isn't tappable. Existing
  agents keep theirs ([agents.md](agents.md), "Defaults for new agents").

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

- **Import agents** (the download mark beside New agent on Agents;
  `app/import.tsx`, on a Mac that serves `agents.import.status`). Three
  steps, polled every 3 s while open: (1) Remote access on and the
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

- **New agent** (the pencil on Agents, or the empty list's button;
  `app/new-agent.tsx`). One question, "What should it do?", then an optional
  name and colour. With no name, one comes from what you wrote ("Keeps my
  inbox down to what matters" → "Inbox", made unique against the team;
  `lib/newAgent.ts`): it's the field's placeholder and the Create button's
  words, so nothing is named unseen. The colour starts on the first one
  nobody wears, as the desk's editor does. `agents.create` calls the desk's
  own `agents_create` with no engine or model, so it starts on the defaults
  for new agents (Settings → Agents, falling back to the first ready engine
  when the chosen one isn't); the phone can't set the engine, model,
  project or instructions at creation (refused with `bad_params`): the
  instructions are edited afterwards from the agent sheet, on either side,
  and the engine, model and project at the desk. The name and role are one
  line each, without control characters, at most 40 and 500 characters, and
  a phone can make at most 10 agents a minute (refused with `rate_limited`). The create is audited as `create <name> — <role>`,
  and a retry with the same `clientId` returns the first agent. Once the
  overview has it, its chat opens with the composer up.
  **Ask your Chief of Staff instead** writes the request into the Chief's
  draft ("Can you set up a new agent? What it's for: …") for you to read and
  send. On a Mac without `agents.create`, that is all the sheet offers.
- **Routines** (`app/schedule.tsx`). A picker instead of the "when: what"
  line: When is chips (Every day, Weekdays, Weekly with day chips, Every few
  hours, Once with Today / Tomorrow / the next five days) and the platform's
  own time picker; What is one line. Above Save it echoes the routine
  ("Every weekday at 9:00 AM — Draft my day", `routineEcho`) and the Mac's
  parser confirms the first run. The picker writes the grammar's own words
  (`routineWhenPhrase`: "every monday and thursday at 08:30",
  "2026-11-20 09:00"), so it uses the existing `agents.schedule.*` methods
  and makes exactly what the desk's composer would. Edit opens a check-in on
  the chips that made it. `packages/companion-protocol/src/routine-phrases.json`
  lists every kind of phrase the picker writes; the mobile tests check the
  picker writes them and a Rust test (`agents::schedule`) checks the Mac's
  grammar reads each back as the same schedule.
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
  never its last word), with the recognizer's own punctuation. The mic's
  place holds a waveform and the elapsed time, × takes the +'s place, and
  the field holds **Stop** and **Send**, as Grok's dictation does. **Stop
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
  contextual strings. Nothing is recorded to a file.
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
- **The composer** is the system's glass where the phone has it
  (`components/Glass.tsx`, expo-glass-effect: iOS 26 Liquid Glass, the tab
  bar's material): a 48pt capsule with 17pt text, a 48pt glass + beside it,
  and 40pt circles inside (mic, Stop, and Send as accent-tinted glass). On iOS
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
  on Agents. A screen that fails to draw shows the root `ErrorBoundary`
  with Try again.
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

### Connection status

The Connection screen lists each layer in order, ok / problem / unknown with
when it was last known: this phone online (NetInfo); Mac reachable (route,
latency, last seen, likely causes from the last status); Mac awake
(keep-awake, lid mode, battery); the app running (only ever yes when the
server answered, since silence looks the same either way); Claude Code
installed and signed in (a `signed_out` turn makes it a problem whatever the
check says); each agent's capabilities; this device. Screens say nothing
while all is well and show the pill when something isn't; in a chat it is the
first bar above the composer ("Saved messages shown"), after a 2 s grace.

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
While disconnected, status marks go grey, headers say "as of …" and actions
are disabled. A message sent offline waits ("Waiting for …") and goes by
itself, idempotent by `clientId`, for **10 minutes** (`OUTBOX_WAIT_MS`);
after that it is **Not sent · Send · Discard** and never sent on its own,
because a message landing hours later with no one watching is worse than one
that waits. A refusal is final. Forgetting a Mac wipes its files.

### Feel and access

Body 16, secondary 14; `textMuted` meets 4.5:1 on panels and Increase
Contrast brightens each grey a step. Chrome is clamped at 1.3× Dynamic Type,
message bodies aren't, and at accessibility sizes the approval card folds its
explanation so the answers stay on screen. VoiceOver and TalkBack hear
replies, approvals, failures and toasts (`lib/a11y.ts`, not during replay).
Haptics only for send, stop, approvals (after the Mac confirms), failures and
toggles, and can be turned off. Android gets Material symbols, ripples and
predictive back.

## Notifications

`lib/notify.ts` keeps them honest: one per alert, grouped per agent
(`threadIdentifier`, the same thread id the relay sets), taken back once
handled anywhere (an approval answered or a chat read, here or at the desk),
the icon badge equal to the desk's `badge_count`, and all cleared on Forget
this Mac. Android has "Needs you" (high) and "Replies" channels. A tap waits
for fonts and credentials, opens at the message, and replaces a chat already
on top instead of stacking.

**Push** goes through `ApnsPush` (`companion/push.rs`) and the content-free
Worker in `services/push-relay`, which holds the APNs/FCM key. The Mac sends
only an opaque device handle, a kind (`needs_you`, `finished`, `message`), the
agent's random id and the badge; the words are fixed in the Worker. An alert
the desk would post (`agents::notify`, which already applies mute, on-screen
and coalescing) is pushed to each phone not in front. It's for official builds
only (a self-built app has no push entitlement), switched on in the Phone
panel, and **built but not deployed**: design, threat model and deploy steps
are in [push-relay.md](push-relay.md).

The socket can also carry an `alert` event, which the phone posts as a local
notification, but no live-socket notifier sends one yet, so `LIVE_WINDOW_MS`
is 0. Settings says plainly what arrives when.

## Installing the app

There is no App Store listing. `TESTFLIGHT_URL` and `ANDROID_APK_URL` in
`src/lib/companionInstall.ts` are unset, so those cards say "Not available
yet"; when set, maintainers ship through EAS (`eas.json` profiles map to
`expo-updates` channels), with a build at least every 60 days because
TestFlight builds expire at 90.

**Get the phone app** (sidebar, Phone panel or Cmd+K) is the route today, and follows
the agent-led onboarding pattern: **the agent drives, the app verifies.** It
spawns the user's agent beside a checklist with a prescriptive prompt
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
| Phone plugged in and trusted, Developer Mode | User | `xcrun devicectl list devices` (physical only; Xcode 27 lists simulators there too, as `simulated`) |
| Signing | User, guided | An "Apple Development" identity; the team id comes from it |
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
  Android 12); `waveform.node.test.ts` the level→bar mapping and easing.
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
paused routines, long chats, an import an hour in), live and offline. Out: `mobile/qa-shots/` (PNGs and
`report.md`, which lists each shot's route, what to check, console errors and
any text cut off with an ellipsis). It exits non-zero when a screen failed or threw.

```bash
cd mobile && pnpm qa:web
pnpm qa:web --only chat-fixtures --themes dark --out /tmp/shots
pnpm qa:web --phases heavy          # fresh,live,cached,impostor,bars,heavy,importing
pnpm qa:web --web-port 8098 --mock-port 47498 --cdp-port 9681   # the defaults
```

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

It says nothing about native-only surfaces (action sheets, Alerts, sheet detents,
the share extension, the camera, real keyboard behaviour).

## Not built

- The LAN route and its pinned-transport module; Bonjour discovery; more than
  one Mac at a time.
- The live-socket notifier, and background refresh.
- Paste import, deleting agents from the phone, and setting a new agent's
  engine, model or project there.
- Pushing to git from the phone: Remote Access gates it behind a PIN, and the
  phone gets nothing until the owner decides how.
- Native targets that need a dev build and an Apple team: a needs-you widget
  and a Live Activity per working turn. The "Send to agent…" extension is
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
