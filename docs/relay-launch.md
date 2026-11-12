# Launching the relay

Everything from "nothing deployed" to "phones reach Macs without Tailscale". The owner signs in
to Cloudflare and Clerk; everything else is a command. Design: [relay.md](relay.md). Commands run
from `services/relay` unless they say otherwise.

## 0. Decide the domain first

A Clerk **production** instance only works on a domain you own (it needs DNS records there), and
its sign-in only works on that domain and its subdomains. So with production accounts the relay
can't stay on `*.workers.dev`: it needs a custom domain under the Clerk domain, e.g.
`relay.mogbot.app` with Clerk on `mogbot.app`. A Worker custom domain needs that zone's DNS on
Cloudflare.

- **Production:** relay on `relay.<your domain>` (`--domain`), Clerk production on `<your domain>`.
- **Testing only:** a Clerk development instance (`pk_test_…`) works from any origin, including
  `workers.dev`, with Clerk's development limits and banner. Fine for a trial, not for release.

## 1. Cloudflare

```bash
cd services/relay
pnpm install                       # wrangler is in node_modules/.bin
pnpm exec wrangler login           # opens the browser: the owner signs in
pnpm exec wrangler whoami          # names the account
```

The free plan runs Durable Objects on SQLite storage. The first deploy may ask for a
`workers.dev` subdomain.

## 2. Deploy once (accounts off)

```bash
node scripts/deploy.mjs --domain relay.mogbot.app     # or no --domain for workers.dev
```

It checks `wrangler whoami`, deploys, prints the relay's address, and smoke-tests it: `GET /health`,
a phone to an offline Mac (expects close 4404), a Mac login signed with a throwaway Ed25519 key, then a
phone to that Mac (a channel opens with accounts off; 4402 with them on). `--dry-run` builds and
lists the bindings without deploying; `node scripts/smoke.mjs <url>` runs only the smoke test.

## 3. Clerk

In <https://dashboard.clerk.com> (the owner, or an agent in his browser):

1. **Create application** → name **Mogbot**. Sign-in options: **Email** and **Google**. Then in
   **Configure → User & authentication**, set Email to sign in with an **email verification code**
   and turn passwords off (menu names move; the setting is "email code, no password").
2. **Sessions → Customize session token → Claims**, add, then **Save**:
   ```json
   { "email": "{{user.primary_email_address}}" }
   ```
   (Clerk's shortcode syntax; custom claims must stay under about 1.2 KB.) Without it the Mac
   shows the account with no email.
3. For release, **create the production instance** on your domain and add the DNS records the
   **Domains** page lists (Frontend API CNAME `clerk.<domain>`, email records; DNS can take a while).
   Google in production needs **your own Google OAuth client** (Clerk's shared one is development
   only): **Configure → SSO connections → Google → Use custom credentials**, with the redirect URI
   Clerk shows there added in Google Cloud Console.
4. **Configure → API keys:** copy the **publishable key** (`pk_live_…`, or `pk_test_…` in
   development). The same page shows the **Frontend API URL**. From it:
   - Issuer: the Frontend API URL, e.g. `https://clerk.mogbot.app`
   - JWKS: `<Frontend API URL>/.well-known/jwks.json`
   - Authorized parties: the relay's own origin, e.g. `https://relay.mogbot.app`

   You don't type these: the deploy script reads the Frontend API out of the publishable key and
   uses the relay's own origin, so only the key is needed. No Clerk secret key is ever used.

Clerk's docs for these: "Customize your session token" and "Deploy your Clerk app to production".

## 4. Turn accounts on

```bash
node scripts/deploy.mjs --domain relay.mogbot.app --publishable-key pk_live_…
```

It prints the four vars, deploys with them (a second deploy only if it had to learn the relay's
origin first), remembers them in `services/relay/.deploy.env` (not committed) for next time, and
the smoke test now expects 4402 and checks `/link` loads Clerk. Any var can be given instead with
`--jwks-url`, `--issuer`, `--authorized-parties` or the `CLERK_*` environment variables;
`--accounts-off` clears them.

**Always deploy through the script.** A bare `wrangler deploy` uses the empty vars in
`wrangler.jsonc` and turns accounts off.

## 5. Test end to end before any release

The Mac reads the relay from `links.relay` in `brand.json`, overridden by **`MOGBOT_RELAY_URL`**
(`<SLUG>_RELAY_URL`, `relay::RELAY_URL_VAR` in `src-tauri/src/companion/relay/mod.rs`; an empty
value turns the relay off; it must be `wss://host`, or `ws://127.0.0.1:port` / `ws://localhost:port`).
The phone only accepts relay routes on the host in its own build (`RELAY_URL` in
`packages/companion-protocol/src/brand.gen.ts`), so the phone needs `links.relay` set even to test:

```bash
node scripts/deploy.mjs --domain relay.mogbot.app --brand   # writes links.relay, runs check-brand --write
cd ../.. && MOGBOT_RELAY_URL=wss://relay.mogbot.app pnpm tauri dev   # the env var is only needed without --brand
cd mobile && pnpm start                                    # a dev phone build that knows the relay
```

Then: the desk's relay Sign in (opens `/link`: sign in, then "Link my Mac"); the desk shows the account;
pair or reopen the phone with Tailscale **off** on the phone; it should connect over the relay;
open an image attachment (HTTP over the channel); quit the Mac app and the phone should say the Mac is
offline. Leave the `--brand` change uncommitted if you're only testing.

## 6. Release

1. `node scripts/deploy.mjs --domain relay.mogbot.app --brand`, commit `brand.json` and
   `packages/companion-protocol/src/brand.gen.ts`, and check `pnpm check:brand` passes.
2. Mac release as usual (`RELEASING.md`): the relay is compiled in from `brand.json`.
3. Phone build (TestFlight / Play) from the same commit, so it carries `RELAY_URL`.
4. Phones paired over Tailscale learn the relay route on their next welcome, once their Mac is
   signed in.

## Checklist

- [ ] Domain decided (relay under the Clerk production domain)
- [ ] `wrangler login` (owner) and `wrangler whoami`
- [ ] `node scripts/deploy.mjs [--domain …]`: smoke test passes, accounts off
- [ ] Clerk app "Mogbot": Google + email code, `email` claim, production instance + DNS, own Google credentials
- [ ] `node scripts/deploy.mjs [--domain …] --publishable-key pk_live_…`: smoke test passes, accounts on
- [ ] `--brand`: `links.relay` in `brand.json`, `brand.gen.ts` regenerated, `pnpm check:brand`
- [ ] End to end from source (step 5)
- [ ] Mac release, then phone build from the same commit
