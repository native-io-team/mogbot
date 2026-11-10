# Open-source readiness (2026-11-10)

Is `native-io-team/mogbot` ready to be made public? It is close. Nothing found
in its history is a live private credential. Before flipping visibility, the
owner has to make a few decisions (section 7) and move `docs/internal/` out of
the repo. All the changes in this pass are local commits: nothing was pushed,
renamed or made public.

## 1. What "the public history" means here

GitHub (`gh api`, read-only) has five branches and **no tags**: `main`,
`mogbot/foundation` and three `archive/*` branches. The scan covered every
commit reachable from those five branches plus the local `mogbot/foundation`:
**3,236 commits**.

The local clone also has 195 tags and 104 `shipstudio/*` remote branches.
Those come from Ship Studio and are not on this GitHub repo. **Never run `git
push --tags` or `--mirror` from this clone**, or they become public with it.
One example: a `shipstudio/julianmemberstack/chat-ui` branch contains a
committed `~/.npm/_cacache` and `.pnpm-store/v11/index.db`.

**Much of this history is already public.** Commits up to roughly 2026-11-04
(`5fd47ede9`, "Mobile companion P1") resolve on the public repo
`ship-studio/ship-studio`. The Sentry, PostHog and tailnet hits below are
examples. Commits from 2026-11-05 on (`9ebc0e7d5` and later) do not. So a
history rewrite of *this* repo cannot un-publish anything from before about
Nov 5. That is the main reason I recommend **no history rewrite** (section 2).

## 2. Secret and PII scan of the whole history

**Tools used.** Neither gitleaks nor trufflehog is installed, and nothing was
downloaded. Instead, a script ran 25 patterns over the added lines of `git log
-p` on the five branches: cloud and API keys, GitHub, Slack, Stripe,
Anthropic, OpenAI, Google, npm and Tailscale tokens, private-key headers,
JWTs, URLs carrying a key, Sentry DSNs, PostHog keys, Vercel ids, Apple team
ids, `*.ts.net` names, emails, phone numbers and `/Users/<name>` paths.

**Files checked.** Every path ever committed was checked for `.p8`, `.p12`,
`.pem`, `.key`, `.jks`, `.keystore`, `.mobileprovision`, `.env`,
`google-services` and `credentials`. The only one present was `.env.example`,
which holds no values. `mobile/.npmrc` is only `node-linker=hoisted`. The
largest blobs in history are fonts, harness screenshots and `scrcpy-server.jar`;
there are no build products (`.dmg`, `.ipa`, `.app`).

**Limits.** Merge-commit resolutions and binary files were not
content-scanned. Regex is not entropy scanning, so run gitleaks once before
going public: `brew install gitleaks && gitleaks git --log-opts="mogbot/foundation origin/archive/avatar-directions origin/archive/plugins-allowlist origin/archive/security-hardening"`.

### Hits that are real values

| What | Where (commit · path) | In HEAD? | Already public via ship-studio? | Action |
| --- | --- | --- | --- | --- |
| Ship Studio's **Sentry DSN** (`…@o4511226863353856.ingest.us.sentry.io/…`) | `a402cd942` · `src-tauri/src/logging.rs`, `src/instrument.ts` | no | yes | No rewrite. A DSN is a client-side ingest key that ships in every binary. In Sentry, rotate it or add allowed domains / rate limits if spam matters |
| Ship Studio's **PostHog project key** (`phc_i1C5…`) | `1e053d689` · `src-tauri/src/commands/analytics.rs`; `13a59ab61` · `.planning/codebase/INTEGRATIONS.md` | no | yes | No rewrite. It is a public write-only key by design. Rotate in PostHog if fake events would matter |
| The owner's **real tailnet name** (`julians-macbook-pro.tailc1f170.ts.net`, confirmed against `tailscale status` on this Mac) | `5fd47ede9` · `src-tauri/src/commands/companion.rs` (test fixture, since replaced) | no | yes | Low risk: it is a hostname, not a credential, and Funnel/Remote Access are token-gated. A rewrite here would not remove it from ship-studio |
| Apple **team ids** `N2VB8A88LB` (Galluzzo Conseil Inc.), `H8NN6DM6G6` (personal), `J335CB82MX` (Memberstack Inc., named in `RELEASING.md`) | `mobile/app.config.ts`, `mobile/eas.json`, `mobile/store/ExportOptions.plist`, `scripts/release-mac.sh`, `docs/app-store.md`, `RELEASING.md` | yes | partly | Team ids are printed in every signed binary, so they are not secret. Keeping them is fine. Forks have to override `APPLE_TEAM_ID` anyway (already supported) |
| TestFlight public link `fsm64m5E` | `brand.json` | yes | no | Meant to be public |
| Commit **author emails**: `julian@memberstack.com` (2,730 commits), plus 15 Ship Studio contributors' personal addresses | commit metadata | n/a | yes | Already public on ship-studio. If the owner wants the Memberstack address gone from *this* repo, it needs a rewrite (`git filter-repo --mailmap`) that changes every SHA; the ship-studio copies keep it regardless. A `.mailmap` (no rewrite) only changes how GitHub and `git log` display it |
| Owner's address and town (`L=Morin-Heights, ST=QC`) and D-U-N-S mention | `docs/play-store.md` | yes | no | Deletion going forward, by moving it to the private docs repo (section 3). No rewrite needed: the town of a registered company is public record |
| `julian@native.agency` (work email) | `docs/internal/persona-usage-2026-11-09.md` | **anonymised in this pass** | no | Still in history from 2026-11-09. Not worth a rewrite |
| A real client-looking email `circa@circabranding.com` | `src/components/dashboard/AgentsPanel.test.tsx` (since `21ecf9db6`) | **anonymised in this pass** | yes | Already public on ship-studio, so no rewrite |
| Private reporting endpoint `https://shipstudio-admin-agent.vercel.app/report` (the secret itself was never committed) | `docs/error-reporting.md` | yes | yes | Fine, since it is bearer-gated. Make sure `BUG_REPORT_SECRET` is rotated if it was ever shared outside the team |

### Hits that are fake (no action)

These are all fixtures:

- `AKIAIOSFODNN7EXAMPLE` and `ghp_abc…`/`ghp_0123…`
- `xoxb-`/`xoxp-1234567890…`
- `sk-ant-api03-abcdef…` and `sk-ant-oat01-e2e-fake-token-that-works-nowhere-…`
- `sk_live_51Hx…`/`sk_live_abcdef…`, used to check that redaction works
- `-----BEGIN FAKE/RSA/OPENSSH PRIVATE KEY-----` headers with no key body
- the `jwt.io` sample JWT
- `hooks.slack.com/services/T0/B0/x`
- `prj_harness000…`
- `correct-horse-battery-staple`
- `0123456789abcdef…` tokens
- `*.example.com`/`*.test` URLs carrying `?token=`
- `555` phone numbers
- `/Users/{me,you,sam,test,harness,fictional,…}`
- fictional tailnets such as `mac.tail1234.ts.net`

`/Users/tyler` sits in an old `.claude/settings.local.json` (`8298ccc2d`,
removed in `f0cfee9d1`), and `/Users/juliangalluzzo` in removed
`HANDOFF*.md` files. Both are only local paths.

### Verdict on rewriting history

**No `filter-repo` rewrite is required.** Nothing in the history is a live
private credential. The real values are either client-side keys that ship in
binaries, or already public in `ship-studio/ship-studio`. A rewrite would only
be cosmetic, for example dropping the Memberstack author email. It would cost
every existing clone and worktree, and break the commit links in the docs.
If the owner wants it anyway, it is one `git filter-repo --mailmap` plus
`--replace-text` run on a fresh mirror clone, then a force-push before
visibility flips. I have not done it.

## 3. Client, customer and internal data in tracked files

**Anonymised in this pass** (fixtures, tests, harness):

| Was | Now | Files |
| --- | --- | --- |
| `circa@circabranding.com`, account `Circa` / `circa-team` / `circa-brand-agency` | `sam@example.com`, `Northwind` / `northwind-team` / `northwind-studio` | `src/components/dashboard/AgentsPanel.test.tsx`, `src/components/terminal/StaleEnvBanner.test.tsx`, `src-tauri/src/commands/github.rs` (test) |
| The owner's employer `Memberstack`, `memberstack-marketing`, `memberstack-docs` | `Northwind`, `northwind-marketing`, `northwind-docs` | `src-tauri/src/agents/{admin,expiry,go_hard_hardening,policy,preview_fix}_tests.rs`, `src/harness/scenarios/projectsAtWork.ts` |
| The agency's internal CRM `Native OS` | `Acme CRM` | `src-tauri/src/agents/on_its_own_tests.rs`, `src-tauri/src/agents/remember.rs` (doc comment), `src/components/agents/AgentChatItems.test.tsx`, `src/harness/fixtures/onItsOwn.ts` |
| `julian@native.agency` | `you@work.example` | `docs/internal/persona-usage-2026-11-09.md` |

**Left as is:**

- **The owner's first name in fixtures**: "Julian's MacBook Pro", `/Users/julian`
  and `julians-macbook-pro.tail1234.ts.net`, in `mobile/dev/mock-server.ts`,
  `packages/companion-protocol/src/fixtures.gen.ts` and
  `src-tauri/src/companion/fixtures.rs`. The hostnames are fictional. Changing
  `fixtures.gen.ts` means regenerating it from Rust, and
  `docs/internal/tester-readiness.md` already calls this harmless. Optional.
- **"Lead Gen", "Finance", "Books", "Inbox", "Dana", "Acme", "Northwind"** are
  generic names.
- **The App Store screenshots** (`docs/app-store/screenshots/`) were spot
  checked and use the demo team (a bakery, "Dana"), not real data.

**Move out of the public repo.** I recommend a private
`native-io-team/mogbot-internal` repo, deleting going forward. These files
are not secrets, but they are private planning, people and company details:

- **`docs/internal/`, all of it** (≈60 files, plus `avatars/` and
  `spacing-audit-2026-11-09/` images). It holds:
  - competitor research
  - persona reviews
  - release, store and tester checklists
  - security reviews that list weaknesses before they are fixed
  - handoff-style reviews with the owner's local scratchpad paths
  - this file and the org-rename plan

  Keep `own-browser-layer.md` and `hosting-provider-matrix.md` public:
  `CLAUDE.md` links them, so move them to `docs/` and fix the links.
- **`docs/app-store.md` and `docs/play-store.md`**: company legal name, town,
  D-U-N-S, store-console steps. Keep a short public "Store builds" note if
  forks need one.
- **`RELEASING.md`**: still Ship Studio's process, and it names the Memberstack
  Inc. team id. Rewrite it for Mogbot or move it.
- **`docs/ship-studio-readme.md`**, `docs/agents-roadmap.md` ("Questions for
  Julian") and `plans/`: review them, these are internal working notes.
- **`docs/error-reporting.md`**: it says "get `BUG_REPORT_SECRET` from Julian".
  Fine to keep, but it is internal process.

Moving them breaks links from `CLAUDE.md`, `docs/README`-style indexes and
tests that read doc paths. Run `pnpm check:all` after the move.

## 4. Licence

- **`LICENSE`** is MIT, "Copyright (c) 2026 Julian Galluzzo and Ship Studio
  contributors". It matches `package.json`, `src-tauri/Cargo.toml`,
  `packages/companion-protocol` and the README. This pass added
  `"license": "MIT"` to `mobile/package.json` and
  `services/push-relay/package.json`, which had none.
- **The inherited Ship Studio code.** `ship-studio/ship-studio` is **public and
  MIT** on GitHub, with the same copyright line. Its `LICENSE` arrived in
  `f0cfee9d1` "Prepare repo for open-sourcing" (2026-05-28). The inherited
  code is therefore already published under MIT, and Mogbot re-publishing it
  adds no new exposure. **Flag for the owner (legal, not code):**
  - About 2,730 commits were authored as `julian@memberstack.com`, and
    `RELEASING.md` says early builds were signed by Memberstack Inc. If any of
    that was work-for-hire, Memberstack may own those copyrights. Confirm that
    Memberstack agreed to the MIT release (it presumably did when Ship Studio
    went public).
  - The other Ship Studio contributors (Tyler Bell, Martin Crandon, Josh Lopez,
    Sebastian Bimbi, Alex Hoyau, Sam Cotterill and others) contributed before
    the MIT `LICENSE` existed, with no CLA. They are covered only if they
    agreed when it was added.
  - There is no DCO or CLA now. A DCO sign-off line in `CONTRIBUTING.md` is
    enough for MIT.
- **Third-party notices.** `THIRD_PARTY_NOTICES.md` is updated in this pass:
  it no longer says "Ship Studio", and it adds the bundled fonts (JetBrains
  Mono / Nerd Font, Geist and Geist Mono; OFL-1.1) and the Lucide icons
  (ISC). **Still open:**
  - **`public/sounds/bruh.mp3`**: an internet meme clip whose provenance is
    unknown. It's the "Bruh" notification preset (`src/lib/sounds.ts`).
    Replace it or drop the preset unless it has a clear licence.
  - **`src/assets/icons/*.svg`** (≈196): provenance isn't recorded. If they
    were drawn in-house for Ship Studio, say so in the notices. If they came
    from a set (Untitled UI, Phosphor or similar), that set's licence must be
    listed.
  - **The `harness/migration-demo/` screenshots** show the third-party Webflow
    template "Tempo" (`tempo-template.webflow.io`). That is likely fine as
    test material, but swap in a site you own if in doubt.
  - **Dependency licences have not been audited.** Run `pnpm licenses list`
    and `cargo deny check licenses` before shipping binaries.

## 5. Public-facing files (this pass)

| File | State after this pass |
| --- | --- |
| `README.md` | Already written for the public: what it is, screenshots (`docs/images/readme/`), build from source, contributing, licence. **Changed**: a Download section leading with <https://mogbot.app/start> (HTTP 200 checked) and the releases repo, and Status no longer claims "no signed download, no TestFlight, no update feed" (`brand.json` now sets all three) |
| `CONTRIBUTING.md` | Exists, 500 lines, Mogbot-aware. Optional: add the DCO line |
| `SECURITY.md` | **Rewritten** for Mogbot. Contact juliangalluzzois@gmail.com, GitHub private reporting once public, Mogbot logs path, scope covering the approval broker, phone pairing, Remote Access and the Chrome extension. It previously pointed at Ship Studio's advisories and Windows paths |
| `CODE_OF_CONDUCT.md` | **Rewritten**: no Ship Studio name, no Ship Studio community Slack, email contact |
| `.github/ISSUE_TEMPLATE/` | **Updated**: the security link points at `native-io-team/mogbot`. Removed the Ship Studio discussions link and the Ship Studio Slack invite, which was a live invite URL. The bug report asks for the app, macOS, engine and phone versions, with the Mogbot logs path |
| `.github/pull_request_template.md` | Label de-branded; the anchor still targets CLAUDE.md's heading as it is named |

**CI on forks.**
- **`ci.yml`** passed `secrets.CSTAR_IDENTITY_SECRET` to seven steps. Nothing
  in the code reads it any more (the cStar support widget is gone), so it is
  **removed**, and `docs/FORKING.md` §6–§7 is updated to match.
- **`dependency-security-scan.yml`** uses only `GITHUB_TOKEN`, with
  `pull-requests: write`, and its comment step is `continue-on-error` for
  forks.
- No workflow uses `pull_request_target`, a self-hosted runner or a signing
  step. Release signing and notarisation are local scripts
  (`scripts/release-mac.sh`, `mobile/scripts/store-ios.sh`), never CI.
- **Recommended once public:** in the repo settings, set "Require approval for
  all outside collaborators" on fork PR workflows, and turn on private
  vulnerability reporting, secret scanning and push protection.

**Package names.** `mobile/` and `services/push-relay` are still
`@shipstudio/*`. They're private names that nobody publishes, so I left them,
since renaming touches workspace references.

## 6. `brand.json` links that should change when the repo goes public (not flipped)

| Key | Now | When public |
| --- | --- | --- |
| `links.issueRepo` | null (issue reporting hidden) | `https://github.com/native-io-team/mogbot` (or wherever the repo lands after any org move) |
| `links.securityAdvisories` | null | `https://github.com/native-io-team/mogbot/security/advisories/new` |
| `links.discussions` | null | The repo's Discussions URL, once Discussions is enabled |
| `links.companionSource` | null (a downloaded `.app` can't build the phone app) | This repo's git URL |
| `links.website` | null | `https://mogbot.app` (or the final domain) |
| `links.community` | null | Only if there is a community space |
| `links.macDownload` | `https://github.com/native-io-team/mogbot-releases` | Consider `https://mogbot.app/start` |
| `links.starterRepoBase` | `https://github.com/ship-studio` | **Tied to the org rename** (see `org-rename-plan-2026-11-10.md`): starters clone from the Ship Studio org |
| `repository` | `https://github.com/native-io-team/mogbot` | Unchanged, unless Mogbot moves org |

Every one of these is baked into the build, so each change needs a release.

## 7. Blockers, in order

1. **Move `docs/internal/` (and the store, release and plans docs) to a
   private repo.** This is the only large content blocker.
2. **Owner, legal:** confirm Memberstack's and the Ship Studio contributors'
   consent to MIT for the inherited history (section 4).
3. **Replace or clear `bruh.mp3`, and record where the icon set came from.**
4. **Run gitleaks once** (section 2) as a second opinion on the regex scan.
5. Decide on the org question first (`org-rename-plan-2026-11-10.md`). If
   Mogbot is going to move org, move it *before* going public, so the public
   URLs never change.
6. When flipping visibility, **push branches only, never tags or `--mirror`**
   from this clone. Turn on private vulnerability reporting, secret scanning
   and push protection, set fork PR workflow approval, then set the
   `brand.json` links in section 6 and cut a release.
