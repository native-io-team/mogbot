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

The first screen offers **Continue with Google**, **Continue with email**, or **Use without signing
in**. Signing in unlocks what we host (the relay now; push notifications and anything later).
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
  browser. That page signs in with Clerk (Google or email code), then POSTs the session token and
  the code to `/v1/link`. The relay verifies the Clerk token (JWKS), binds the code's fingerprint
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
- Limits: 8 phone sockets per Mac at once (4429 past it), payloads ≤ 256 KiB (1009 past it), and
  per-IP connection rate limiting at the Worker.

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
