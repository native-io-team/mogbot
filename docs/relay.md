# The relay: reaching your Mac without Tailscale

The phone reaches the Mac through a small relay we run (Cloudflare Worker + one Durable Object per
Mac). The relay passes encrypted bytes; it can't read or change them. Tailscale stays as a second
route, and a build with no relay (`brand.json` `links.relay: null`, e.g. a fork) uses Tailscale only,
exactly as before. Anyone can run their own relay from `services/relay` and point `links.relay` at it.

## Why it is safe without accounts

Security never rests on the relay or on an account. It rests on keys the two devices already have:

1. **The Mac is known by its key.** Its Ed25519 identity key (Keychain, `companion/identity.rs`)
   is pinned by the phone at pairing (`PairingLink.fingerprint`). Over the relay the phone opens an
   end-to-end encrypted channel whose handshake the Mac signs with that key. A relay, or anyone
   pretending to be one, can't produce that signature, so it can't pose as the Mac or read a byte.
2. **The phone is known by its device token**, issued at pairing and sent only inside that channel
   (`hello.token`), checked on every frame as today. Pairing is still confirmed on the desk.
3. **The relay knows only** which Mac key a socket is for (the fingerprint in the URL), when, from
   which IP, and how many bytes. Never content, tokens, names or messages.

The Mac proves its key to the relay too (a signed challenge), so nobody else can take its slot.

### Accounts: what unlocks our hosted services

The screen after Welcome asks **Sign in?** (one button; the page that opens offers Google or email) or **Use without signing
in**. Signing in lets this Mac use the phone relay we host. Push notifications need no account.
Nothing in the app checks the account: only our servers do (docs/OPEN-AND-HOSTED.md).
Without signing in, everything that runs on your own machines still works: the phone over your own
Tailscale, exactly as before. Forks and self-hosters never need our accounts.

Accounts add *who may use our servers*; they never replace the keys above, and no account token is
ever needed to read or send anything:

- **The account lives at the relay, bound to the Mac's key.** Signing in links the Mac's identity
  fingerprint to an account id (Clerk user id) in the relay's store. The Mac keeps no account token:
  every relay login proves the Mac's key, and the relay answers `{"t":"ready","account":{"id","email"}|null}`.
- **Linking** (desk "Sign in"): the Mac makes a one-time code `<fingerprint>.<b64url 32 random bytes>`
  (the fingerprint lets the relay find the Mac's slot; it isn't secret, it's in every pairing QR;
  the random half is), sends `{"t":"linkStart","code":"<code>"}`
  on its authenticated relay socket, and opens `https://<relay host>/link?code=<code>` in the
  browser. The page moves the code from its address into the tab's sessionStorage (so it never rides
  through Google's or Clerk's redirects), signs in with Clerk (Google or email code), asks for one
  click ("Link my Mac", even when already signed in), then POSTs the session token and the code to
  `/v1/link`. The relay verifies the Clerk token (JWKS), binds the code's fingerprint
  to the user, and tells the Mac `{"t":"account","account":{…}}`. Codes live 10 minutes, single use.
- **Signing out**: the Mac sends `{"t":"unlink"}` on its authenticated socket; the binding goes.
- **Gating**: a phone reaching a Mac with no account gets 4402 `sign_in_needed` (the phone says to
  sign in on the Mac, or use Tailscale). The Mac's own relay login is always allowed, so linking works.
- **Phones don't sign in**: a phone pairs to a Mac by QR as today and uses the relay because its Mac
  is signed in. (A phone account comes later, for several Macs; Apple's rules on sign-in options apply then.)
- The account provider is Clerk: Google and email codes, its free tier up to 10,000 monthly users.
  The relay only verifies Clerk's signed session tokens (public keys); no Clerk secret on the Mac or phone.

## Routes and fallback

`Route.kind` gains `'relay'`: `{ kind: 'relay', url: 'wss://<relay host>/v1/phone/<fingerprint>' }`.

- A new pairing link carries the relay route when the Mac's relay link is up; otherwise the
  Tailscale route, as today. The link still has exactly one route.
- After the welcome, the Mac sends all its routes (`setRoutes`): relay first, then Tailscale when
  it's serving. The phone tries them in order and falls back on failure (`DirectTransport`).
- Phones paired over Tailscale keep working and learn the relay route on their next welcome.
- With `links.relay` null the Mac never offers it and the phone never sees it.

## Wire protocol

### Mac ↔ relay: `GET /v1/mac/<fingerprint>` (WebSocket)

1. Relay → Mac, text: `{"t":"challenge","nonce":"<b64url 32 bytes>"}`
2. Mac → relay, text: `{"t":"auth","v":1,"publicKey":"<b64url Ed25519 pub>","signature":"<b64url>"}`,
   signing the UTF-8 of `"<scheme>:relay-mac:v1\n<nonce>\n<fingerprint>"` (`scheme` = `PAIRING_SCHEME`).
   The relay checks `fingerprint_of(publicKey) == <fingerprint>` and the signature. Else close 4401.
3. Relay → Mac, text: `{"t":"ready"}`. A newer authenticated Mac socket for the same fingerprint
   replaces the older one (closed 4409).
4. Multiplexing, after ready:
   - Relay → Mac text `{"t":"open","ch":<u32>}` when a phone connects; `{"t":"close","ch":<u32>}`
     when it goes.
   - Data both ways as **binary**: 4-byte big-endian channel id, then the payload bytes.
   - Mac → relay text `{"t":"close","ch":<u32>}` closes that phone's socket (code 1000).
5. Keep-alive: text `ping` → `pong`, answered by the relay without waking (auto-response). The Mac
   sends one every 30 s and treats 75 s without anything as dead.

### Phone ↔ relay: `GET /v1/phone/<fingerprint>` (WebSocket)

- Binary frames only, each one payload. Text `ping` → `pong` as above.
- If that Mac isn't connected: the relay accepts and closes at once with **4404** (reason
  `mac_offline`), so the phone can say "Your Mac is offline or asleep" instead of "can't reach".
- Limits: 8 phone sockets per Mac at once and 4 per client address (4429 past either), payloads
  ≤ 256 KiB (1009 past it), and per-IP connection rate limiting at the Worker. At most 4 Mac sockets
  may wait on their challenge; a fifth closes the oldest (4401 `superseded`).

### The encrypted channel (phone ↔ Mac, end to end)

All over the channel's binary payloads. Base64url is unpadded. `scheme` = `PAIRING_SCHEME`.

1. Phone → Mac (plaintext JSON, UTF-8): `{"v":1,"e":"<b64url X25519 public, 32 bytes>"}`
2. Mac → Phone (plaintext JSON): `{"v":1,"e":"<b64url Mac X25519 public>","publicKey":"<b64url Ed25519>","signature":"<b64url>"}`
   - `transcript` = UTF-8 of `"<scheme>:relay:v1\n<phone e>\n<mac e>\n<fingerprint>"` (the
     base64url strings as sent).
   - `signature` = Ed25519 over `transcript` with the Mac's identity key.
   - The phone requires `fingerprint_of(publicKey) == pinned` and a valid signature, else closes.
3. Keys: `shared = X25519(own secret, other's e)`;
   `okm = HKDF-SHA256(ikm = shared, salt = SHA-256(transcript), info = "<scheme> relay v1", L = 64)`;
   `phoneToMac = okm[0..32]`, `macToPhone = okm[32..64]`.
4. Every later payload is `ChaCha20-Poly1305(key, nonce, plaintext)` (ciphertext ‖ 16-byte tag),
   no associated data, `nonce` = 4 zero bytes ‖ 8-byte big-endian counter, starting at 0 per
   direction and +1 per message. A failed open, or a counter that would wrap, closes the channel.
5. The plaintexts are UTF-8 JSON, one of:
   - the companion protocol's own frames, unchanged (`challenge`, `hello`, `req`, `evt`, `ping`…).
     The Mac runs them through the same handler as a Tailscale socket (`serve_socket_as`), with
     the route kind `relay`. Its `identity` frame is checked against the pinned key exactly as
     today: while its relay link is up the Mac's signed `hosts` include the relay's host, so the
     phone's "host I reached is one the Mac signed" check holds unchanged.
   - HTTP over the channel, for what the Tailscale route does in plain HTTP (identity, pair, blobs,
     attachments): `{"t":"http","id":<n>,"method":"GET","path":"/v1/…","headers":{…},"body":"<b64url>"?,"more":true?}`
     → `{"t":"httpRes","id":<n>,"status":200,"headers":{…},"body":"<b64url>"?,"more":true?}`.
     A body over 128 KiB is split: follow-on `{"t":"httpBody","id":<n>,"body":"…","more":bool}`
     frames until `more` is false. The Mac answers by calling its own loopback server, adding a
     per-launch secret header so the device token is checked without a tailnet login.

Test vectors for the handshake and the first frames: `packages/companion-protocol/src/relayVectors.json`,
used by the phone's tests and the Mac's.

## Costs

Idle sockets hibernate and cost nothing; billing is per message (20 incoming = 1 request). Estimate
for 10,000 daily users: about $25–50 a month (docs: Cloudflare Durable Objects pricing).

## Threat model

Reviewed 2026-11-11 across the Worker and Durable Object (`services/relay/src`), the Mac's side
(`src-tauri/src/companion/relay`, its hooks in `server.rs` / `files.rs`) and the phone's
(`mobile/src/lib/relay*.ts`, `transport.ts`, `packages/companion-protocol/src/{relay,pairing}.ts`).

### What holds

- **Nobody without the Mac's key can be the Mac.** The phone accepts a channel only when the answer
  is signed by the pinned key over both fresh X25519 keys and the fingerprint; the relay login signs
  a fresh 32-byte nonce per socket. The four signed messages (`identity:v2`, `pair:v2`, `relay:v1`,
  `relay-mac:v1`) carry distinct prefixes, and every signed field is validated base64url of a fixed
  length, so one can't be passed off as another.
- **No nonce reuse, no replay.** Each channel derives fresh keys (ephemeral X25519 on both sides,
  so recorded traffic stays sealed even if the identity key leaks later); counters start at 0,
  move strictly in order, and a failed open or a spent counter closes the channel. A recorded
  channel replayed to the Mac meets a new ephemeral key and fails its first open.
- **The relay secret header only comes from the bridge.** `http.rs` now builds the loopback
  request from an **allow-list** (`authorization`, `content-type`, `accept`, `range`, `if-range`,
  `if-none-match`, `if-modified-since`, `x-name`), then sets `Host`, the secret and the source itself.
  A phone can't send `Host`, `Tailscale-User-*`, `X-Forwarded-*`, `Origin`, the secret or the source
  header (tested against a recording loopback server). Hyper refuses header names or values with
  CR/LF, and the JSON map can't carry a second copy of a header the bridge sets.
- **Paths.** Only `/v1/…` of printable ASCII reaches loopback, never `/v1/ws`, and now never a
  `.`/`..` segment (plain or `%2e`), an encoded slash or backslash, a raw backslash or a `#`. The server's
  own `resolve` refuses the same, so this is a second wall.
- **Over the relay a phone reaches only what it reaches over Tailscale**: `/v1/identity` and
  `/v1/pair` without a token (a pairing code is 128 bits and confirmed on the desk), everything else
  only with a live device token.
- **JWTs.** RS256 only (the key is imported as RSASSA-PKCS1-v1_5, so no alg confusion), `kid`
  required and looked up in Clerk's JWKS, `exp` required, `nbf` honoured, 60 s skew, `iss` and `azp`
  checked when set (the deploy script always sets both). An unknown `kid` refetches the keys at most
  every 30 s.
- **The /link page** echoes nothing from the request: the code is checked against a strict pattern
  server side and read by the script from the address; there is no redirect parameter (Clerk
  returns to `/link` on the same origin); `frame-ancestors 'none'`, `no-referrer`, `no-store`.

### Fixed in this review

| Severity | Issue | Fix |
| --- | --- | --- |
| Medium | A channel's loop could deadlock: a refused relayed HTTP request (bad path, 429, bad body) awaited a send on the queue that only that same loop drains. With responses streaming in, one bad request froze the channel for good, with its buffers. | `Http::start` returns the refusal and the loop seals it directly (`a_refused_request_is_answered_without_waiting_on_a_full_queue`). |
| Medium | Memory: each channel could queue 256 payloads of 256 KiB (64 MiB) while blocked, over 16 channels. | A byte budget per channel, 16 MiB (`MAX_QUEUED_BYTES`), past which it closes as stuck. |
| Medium | Slot squatting: anyone who knows a fingerprint (it's in every pairing QR) could finish the handshake, send nothing, and hold all 8 of that Mac's relay phone slots indefinitely. | The Mac closes a channel that never became an authenticated socket after 30 s with nothing in flight; the relay allows 4 phones per client address per Mac (a keyed hash of the address, never the address). |
| Medium | Link fixation: `/link` linked automatically when the visitor was already signed in to Clerk, so a link someone else sent bound *their* Mac to the visitor's account, and their Mac learned the visitor's account id and email. | The page always asks for a click ("Only continue if you just chose Sign in on your own Mac…"). |
| Low | Unanswered Mac sockets were unbounded per Mac. | At most 4 wait; a new one closes the oldest, so strangers can't keep the real Mac out. |
| Low | `/v1/link` read the whole body before checking its size. | Rejected by `content-length`, and the stream is cut at 16 KiB. |
| Low | The link code rode in the address through Google's and Clerk's redirects. | Moved to the tab's sessionStorage and removed from the address before sign-in. |
| Low | A link code's single use relied on no other request running between the read and the delete (the hash was computed in between). | Hashed first; nothing but storage is awaited from the read to the writes. A race test passes before and after, so it wasn't reproducible in workerd. |
| Low | Bodies whose server stopped reading stayed in the bridge's map. | Reaped with finished requests. |
| Launch blocker | `brand.gen.ts` never carried `links.relay`, so the phone would reject every relay route even with `links.relay` set. | `scripts/check-brand.mjs --write` now emits `RELAY_URL`. |

### Accepted risks

- **Who can open a channel.** The phone side of the channel is anonymous until its `hello` token;
  anyone with the fingerprint gets as far as `/v1/identity` and `/v1/pair`, as with Tailscale Funnel.
- **A device token works from anywhere over the relay.** Over Tailscale a token also needs the
  tailnet user who paired it; over the relay the token alone is enough. A stolen token is revoked
  from the desk as before.
- **Determined slot squatting.** Someone with the fingerprint and many addresses can still keep a
  Mac's 8 relay slots busy (each channel making a slow request). Tailscale is unaffected. A fix
  would need the phone to prove a device before the relay counts it, which the relay can't check.
- **Cost.** There's no per-message limit on a phone socket; a stranger can make the relay's bill
  bigger, not read or change anything.
- **What the relay learns:** fingerprints, client addresses (rate limiting only, never stored; the
  per-address tag is SHA-256 of fingerprint and address, held only on open sockets), timing and
  sizes.
- **Accounts gate, they don't protect.** Linking someone else's Mac to your account (with a stolen
  code: 256 bits, 10 minutes, single use) or getting someone to click "Link my Mac" on your link
  gives no access to anyone's data: it changes whose account a Mac uses the relay under, and tells
  that Mac the account's id and email. Anything later that trusts the binding (a phone account for
  several Macs, push) must not take it as proof of ownership.
- **Clerk's script** loads from the frontend API named in the publishable key, `@6` / `@1` floating,
  without SRI, and the page has no `script-src` CSP: Clerk can run code on `/link` (it can mint the
  tokens anyway). Untested under a CSP, so none was added.
- **The phone keeps a whole HTTP answer in memory** with no cap; only the authenticated Mac can send
  those frames.
- **`Content-Length` isn't relayed**, so an upload over the relay reserves the phone's full staging
  budget while it runs (a functional gap, not a hole).
