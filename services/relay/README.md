# Relay

Lets the phone reach its Mac without Tailscale. A Cloudflare Worker plus one Durable Object per
Mac (named by the fingerprint of the Mac's identity key) that passes bytes between the Mac's socket
and its phones' sockets. The full design is [docs/relay.md](../../docs/relay.md).

## What it can and can't see

The phone and the Mac talk end to end encrypted (X25519 + ChaCha20-Poly1305, the handshake signed
by the Mac's Ed25519 identity key that the phone pinned at pairing). The relay only forwards the
ciphertext, so it can't read or change a message, and it can't pose as the Mac: it never has a
key that could sign the handshake.

What it does know: which Mac fingerprint a socket is for, when, the connecting IP (used only for
rate limiting, never stored), and how many bytes passed. No content, tokens, names or messages. It
keeps no logs of its own (`observability` is off in `wrangler.jsonc`).

The Mac also proves its key to the relay (it signs a fresh challenge), so nobody else can take a
Mac's slot.

## Routes

| Route | What |
| --- | --- |
| `GET /`, `GET /health` | `200 ok` |
| `GET /v1/mac/<fingerprint>` | The Mac's WebSocket: challenge, signed login, then multiplexed channels |
| `GET /v1/phone/<fingerprint>` | A phone's WebSocket: binary payloads only |
| `GET /link?code=<code>` | The sign-in page the Mac opens to link itself to an account (accounts on only) |
| `POST /v1/link` | `{code, token}` from that page: verifies the Clerk session token, links the Mac |

`<fingerprint>` is 22 characters of base64url. Closes: `4401` bad or late Mac login, `4409` Mac
replaced by a newer login, `4404 mac_offline` no Mac, `4402 sign_in_needed` the Mac isn't signed in
(accounts on only; offline is said first), `4429` more than 8 phones, `1009` a payload over 256 KiB. Idle sockets hibernate (and `ping` gets `pong` without waking the object), so they
cost nothing.

## Run your own

You need a Cloudflare account (the free plan runs Durable Objects on SQLite storage).

```bash
cd services/relay
pnpm install
pnpm test           # the Worker in workerd, locally
pnpm exec wrangler login
pnpm exec wrangler deploy
```

`wrangler deploy` prints the Worker's address, e.g. `https://mogbot-relay.<you>.workers.dev`. Put
it in the repo-root `brand.json` as `links.relay`, with the `wss://` scheme:

```json
"links": { "relay": "wss://mogbot-relay.<you>.workers.dev" }
```

then build the app. With `links.relay` null the app uses Tailscale only.

The per-IP limit on new connections (60 a minute) is Cloudflare's rate limiting binding,
`RATE_LIMITER` in `wrangler.jsonc`. The Worker runs without it if you remove it.

## Accounts

Accounts decide who may use a relay, nothing more: the encryption and the Mac's key work the same
with them on or off. They are **off** unless `CLERK_JWKS_URL` is set. Off means no gating at all:
every Mac that proves its key may log in and every one of its phones may connect. That is the right
setting for a relay you run for yourself, and the one this repo ships (all four vars empty in
`wrangler.jsonc`).

On, a phone reaching a Mac that isn't linked to an account is closed `4402 sign_in_needed`. The Mac
links itself with a one-time code, `<fingerprint>.<base64url of 32 random bytes>`: it sends
`{"t":"linkStart","code":"…"}` on its logged-in socket (the relay keeps only the code's SHA-256, for
10 minutes, one at a time), then opens `https://<relay>/link?code=<code>`. That page signs in with
Clerk and posts the code and the session token to `/v1/link`; the relay checks the token against
Clerk's public keys, stores `{id, email, linkedAt}` in that Mac's Durable Object and tells the Mac
`{"t":"account","account":{"id","email"}}`. `{"t":"unlink"}` removes it and signs the phones out.
`ready` carries the account (or `null`) on every login.

To turn them on, make a Clerk application (Google and email code sign-in are set in Clerk's
dashboard), then set, in `wrangler.jsonc` `vars` (all are public values; no Clerk secret is needed):

| Var | Value |
| --- | --- |
| `CLERK_PUBLISHABLE_KEY` | The application's publishable key (`pk_live_…`), for the `/link` page |
| `CLERK_JWKS_URL` | `https://<your Clerk frontend API>/.well-known/jwks.json`. Setting this turns accounts on |
| `CLERK_ISSUER` | Your Clerk frontend API URL, e.g. `https://clerk.example.com`. Checked against `iss` when set |
| `CLERK_AUTHORIZED_PARTIES` | The relay's own origin, e.g. `https://mogbot-relay.<you>.workers.dev`. Comma list; checked against `azp` when set |

For the account's email to reach the Mac, add `"email": "{{user.primary_email_address}}"` to the
session token's claims in Clerk (Sessions → Customize session token); without it the email is
`null`. Set the issuer and authorized parties: without them any token from that Clerk instance's
keys is accepted.

## Developing

`pnpm dev` runs it locally with `wrangler dev`; `pnpm test` and `pnpm typecheck` are what CI would
run. The login's signature check is tested against the shared vector in
`packages/companion-protocol/src/relayVectors.json`, and `PAIRING_SCHEME` in `src/auth.ts` is
checked against `packages/companion-protocol/src/brand.gen.ts`, so a rename that changes the scheme
fails the tests here until it's updated.
