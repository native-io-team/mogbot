# First hour, three new users, 2026-11-10

An adversarial walk of `mogbot/foundation` (0bb2fa725) as three people who just downloaded the
Mac 1.0.0 DMG from a GitHub release page, with the iPhone app still in App Store review:

- **(a) Founder**, non-technical, Claude Pro plan.
- **(b) ChatGPT Plus user** who has never opened a terminal (the Codex path).
- **(c) Developer** with Claude Code already installed and signed in.

Judged against the north star: extremely complex tasks, made extremely easy.

**How it was looked at.** `pnpm harness` on port 1447 with its own `TMPDIR`, dark, 1440×900:
every `onboarding-*` scenario, `agents-first-run*`, `agents-first-win-*`,
`agents-first-result-phone-offer`, `agents-approval`, `agents-live-step`, `agents-live-stalled`,
`agents-usage-limit`, `agents-failure-engine-missing`, `agents-no-engine-at-all`,
`agents-login-codex`, `launch-returning`, `project-tools*` and every `phone-*`. Every shot was
looked at. Plus a grep of the Rust and TS for things that only work in a dev build.

**Not checked.** A real notarized DMG on a clean Mac (the VM script exists; not run here);
WKWebView; real installer and sign-in runs (the harness replays recorded output); what the
model actually says in a first turn; the phone app itself (the mobile test for the stalled-step
copy was edited but not run: `mobile/` has no `node_modules` in this worktree).

## (a) The founder with Claude Pro

**Journey.** Welcome ("Your own team of AI agents", "About five minutes") → Get started →
"Which AI should your agents run on?" with Claude Code recommended and "Needs a Claude Pro or
Max plan" → Install (three plain steps, no terminal) → Sign in (browser opens, a code field in
case it shows one) → "Claude Code is connected" → Meet your Chief of Staff → greeting, three
starters, one import card → asks for something → a result card → the phone card.

**What went well.** Two clicks to the Chief when nothing needs installing. Every check says Done
or Not done yet with one fix. The approval card shows the exact email before Allow. The result
card separates "It says it checked" from "Not verified".

**What broke.**

1. **The phone card led to a dead end in a downloaded build (fixed).** After the first result
   the Chief offers "Use your agents from your phone? … setting it up takes ten minutes to an
   hour" → Set up my phone → the Phone panel's step 1 said "Installing isn't available in this
   version yet." A release build has `links.companionSource` null, so the build-on-this-Mac
   route is hidden (`COMPANION_INSTALL_ENABLED` is true only in dev or with a source repo), and
   there was no App Store route at all. The harness hides this because it runs in dev mode.
2. **Closing the sign-in page showed the CLI's own prompt as the error (fixed).**
   `onboarding-signin-failed`: "Not done yet. Paste code here if prompted > Login interrupted."
   `claude auth login` leaves its code prompt open with no line break, so its next line joined
   it and was shown as the cause. The scenario's own description expected a plain sentence: a
   regression nobody saw.
3. **Tailscale is a second account to make before the phone works (left).** Step 2 of the Phone
   panel asks for Tailscale on the Mac and the phone. For this persona it is the hardest step
   of the hour and the app can't do it for them.

## (b) The ChatGPT Plus user, Codex path

**Journey.** Same welcome → picks Codex ("ChatGPT's models, by OpenAI") → "Get your Mac ready
for Codex · 1 of 4" → Homebrew asks for the Mac password → Node.js → Codex → sign in with
ChatGPT → Chief.

**What broke.**

4. **A password box for a tool nobody mentioned (fixed).** The screen said "Codex needs a
   couple of things first", then "Homebrew's installer needs your Mac password". Someone who has
   never used a terminal has never heard of Homebrew, and a third-party app asking for the Mac
   password for it is the scariest moment in the hour. Project tools called the same thing "A
   package manager" (two names for one idea).
5. **Not an administrator: a wall (left).** `onboarding-install-not-admin` gives the right fix
   ("sign in to an administrator account…") but nothing else; Codex's Homebrew route can't work
   on a managed Mac. Claude Code installs without admin, but that needs a Claude plan this
   person doesn't have.
6. **Step counts shift (left, small).** "Codex · 1 of 4" on a bare Mac, "1 of 3" in the
   no-Homebrew failure. Both are true for their machines; it still reads like the goalposts moved.

## (c) The developer with Claude Code

**Journey.** `allReady` is true on launch, so onboarding is skipped and the app opens on the
Chief's greeting. Zero clicks.

**What broke.**

7. **"Using the CPU" (fixed).** The stalled-step line (`agents-live-stalled`) said "Last
   activity 4s ago · not using the CPU … Its command is still running but isn't using the CPU".
   Accurate for this persona, jargon for the other two, and it is the line everyone sees when a
   long first task goes quiet.
8. **"Opencode" and "OpenCode" (fixed).** The setup status, the Tools & services list and the
   session messages spelled it "Opencode"; onboarding and the engine picker "OpenCode".
9. **Their own `~/.claude` comes along (left, by design).** The Chief runs on their Claude Code,
   so their global CLAUDE.md, hooks and MCP servers apply to every agent turn. Not wrong, but
   nowhere said; a developer will wonder why the Chief follows their personal rules.

## Only in dev? (the downloaded build)

Grepped Rust and TS for `CARGO_MANIFEST_DIR`, `import.meta.env`, `pnpm`, absolute paths and env
vars read at run time:

- `CARGO_MANIFEST_DIR` at run time: `user_chrome::install::extension_source` falls back to the
  checkout, but tries the bundle's `chrome-extension/` first, and `tauri.conf.json` bundles it.
  `companion_install::source_dir` uses the checkout only under `debug_assertions`. The rest are
  `include_str!` (compile time) or tests. Fine.
- Env vars: every `SHIPSTUDIO_*` read has a default and is a test/mock/override. Fine.
- `pnpm` at run time: only in the phone self-build prompt (`npm install -g pnpm` first if
  missing), which a release build never offers. Fine.
- **The phone install route is dev-only** (finding 1): fixed by routing, see below.
- **No update feed** (`links.updates` null): a 1.0.0 download never hears about 1.0.1.
  **No issue repo** (`links.issueRepo` null): no in-app bug report. Both are already in
  `release-checklist.md` (c); they matter most for a *public* first download.

## What changed

Each its own commit.

- **Phone routes by what this build can do** (`src/lib/phoneApp.ts`, new nullable
  `links.appStore` in `brand.json`). `store` when the listing URL is set: the Phone panel leads
  with "Get it on the App Store" and the Chief's card says a minute, not an hour. `build` with a
  source repo or in dev: as before. `none` (a downloaded 1.0 today): no phone card in the Chief's
  chat, and the panel says "The phone app isn't out yet. Your agents work the same without it."
  Tests: `phoneApp.test.ts`, `PhoneGetApp.test.tsx`, `ChiefPhoneOffer.test.tsx`. Docs:
  `docs/mobile.md` ("Installing the app"), `release-checklist.md` (c).
- **A closed sign-in says so** (`describeFailure` in `src/lib/installProgress.ts`): a new
  `signin` kind for "Login interrupted / cancelled / not completed", with "The sign-in page was
  closed before it finished." and a fix that names the plan; open prompts are cut before any
  line is shown as a cause. Tests in `installProgress.test.ts`.
- **Codex's setup names its tools**: "Codex runs on two free tools, Homebrew and Node.js. The
  app installs them for you…", and the password box says what Homebrew is. Project tools calls
  it Homebrew too.
- **Busy / idle** instead of "using the CPU", on desk and phone (`companion-protocol`'s
  `lifeLine`, `work/liveness.rs`'s "Check on it" answer).
- **OpenCode** spelled one way in setup status and session messages.

Before / after: `onboarding-signin-failed`, `onboarding-codex-prereqs`, `agents-live-stalled`,
`project-tools` (session scratchpad `fh/before/` and `fh/after/`). The phone `none` route can't
be shown in the harness (it runs in dev, where the build route is always on); the unit tests
cover it.

## What's left, ranked

1. **Set `links.appStore` the day the iPhone app is approved.** Until then a downloaded build
   offers no phone at all (honest, but the phone is half the product).
2. **Update feed and issue repo before a public download** (`links.updates`,
   `links.issueRepo`). Without them there is no way to ship a fix to, or hear from, the first
   users.
3. **Tailscale for the phone.** The one step in the first hour the app can't do for a
   non-technical user. Say up front what it is and that it is free, or find a route without it.
4. **Non-admin Macs on Codex.** Offer a no-admin Node route (a user-level install) instead of a
   wall.
5. **Say that the developer's own Claude Code settings apply** (one line on the Chief's first
   reply or in Settings → Agents).
6. **Step counts** that don't change between screens of the same setup.
