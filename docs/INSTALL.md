# Install: from a fresh Mac to your agents on your phone

There is no download yet (no signed build, no App Store). You build the app on
your own Mac from this repo. The easiest way is to let an AI coding agent do it
for you.

## For the human (read this first)

1. Open this folder in **Claude Code** or **Codex** and say: *"Set this up on my
   Mac and phone. Follow docs/INSTALL.md."*
2. The agent installs the tools and builds the app (the first build takes
   10–25 minutes). It will stop and ask you to do a few things only you can
   do: type your Mac password, sign in in your browser, install two apps on
   your phone, scan a code, click Allow.
3. You need: a Mac (Apple Silicon or Intel) on a recent macOS, about 15 GB
   free, an internet connection, and **a paid Claude plan (Pro or Max) or a
   paid ChatGPT plan (Plus, Pro, Business…)** for the agents to run on. For
   the phone: an iPhone or Android phone and a free Tailscale account.
4. Your Mac does the work. Agents stop when the Mac sleeps or the app is closed.

No agent? Follow the same steps by hand: run each **Run** block in Terminal and
check it against **Check**.

---

## For the agent doing the setup (runbook)

Rules:

- Work through the steps in order. Every step is safe to re-run: do the
  **Check** first, and skip the **Run** when the check already passes.
- **HUMAN** steps are things you cannot do. Say the quoted words to the human,
  then wait for them to answer before going on. Don't skip them or do them some
  other way.
- Don't change the human's shell config, global git settings or anything
  outside this repo beyond what a step says.
- If a step fails and its **If it fails** doesn't fix it, stop. Tell the human
  which step failed and show the error. Don't guess.
- Use the **simple path** (build the desktop app, phone through Expo Go) unless
  the human asks for something else. Developer options are in
  [Other routes](#other-routes).
- Run every command from the repo root unless the step says otherwise.
  `REPO` below means the repo root.

### Step 1. Check the Mac

**Check**

```bash
sw_vers -productVersion; uname -m; df -h ~ | tail -1
```

Expected: a macOS version (tested on macOS 26; macOS 14 or later is what we
expect to work), `arm64` or `x86_64`, and at least 15 GB available.

**If it fails:** if there's less than 15 GB free, tell the human: *"Your Mac
needs about 15 GB free for the build. Can you free some space and tell me when
it's done?"*

### Step 2. Xcode Command Line Tools

**Check**

```bash
xcode-select -p && clang --version | head -1
```

Expected: a path (`/Library/Developer/CommandLineTools` or one inside
`Xcode.app`) and an `Apple clang version …` line.

**Run** (only if the check failed)

```bash
xcode-select --install
```

**HUMAN:** *"A macOS window just asked to install the Command Line Tools.
Please click Install, accept the licence, and tell me when it says it's done
(it can take 5–15 minutes)."*

Then run the check again.

**If it fails:** `xcode-select: error: command line tools are already installed`
together with a failing `clang` means the install is broken. Run
`sudo xcode-select --reset` (**HUMAN:** *"I need your Mac password for
one command that resets the developer tools. Please type it in the terminal
when it asks."*), then run the check again.

Full Xcode is **not** needed for the simple path. It's only needed for
building the phone app yourself ([Route B](#route-b-build-the-phone-app-onto-your-iphone)).

### Step 3. Node.js (22 or later)

**Check**

```bash
node -v
```

Expected: `v22.x` or later (`.nvmrc` says 22; 24 also works).

**Run** (only if Node is missing or older than 22). Use whatever the Mac already
has: `nvm install 22` if `nvm` exists, `brew install node@22` if Homebrew
exists (check with `brew --version`). On a bare Mac without either, install
the official package:

```bash
curl -fsSLo /tmp/node.pkg "https://nodejs.org/dist/latest-v22.x/$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -o 'node-v22[^"]*\.pkg' | head -1)"
sudo installer -pkg /tmp/node.pkg -target /
```

**HUMAN** (for the `sudo` line): *"I'm installing Node.js. Please type your Mac
password in the terminal when it asks."*

Open a new shell (or run `hash -r`) and run the check again.

Homebrew is optional. Nothing below needs it.

### Step 4. pnpm 9

**Check**

```bash
pnpm -v
```

Expected (from the repo root): `9.15.9`. pnpm reads the version from
`packageManager` in `package.json`, so a newer global pnpm (10.x) switches
itself to 9.15.9 inside this repo. That's fine.

**Run** (only if `pnpm` isn't found)

```bash
npm install -g pnpm@9.15.9
```

**If it fails** with `EACCES` (no permission to write to the global npm
folder), use `corepack enable pnpm` instead (Node 22 and 24 ship corepack),
or `sudo npm install -g pnpm@9.15.9` (**HUMAN:** password, as above).

### Step 5. Rust

**Check**

```bash
rustc --version && cargo --version
```

Expected: `rustc 1.8x` or later. `rust-toolchain.toml` asks for the current
`stable` channel, and rustup fetches it the first time you build.

**Run** (only if missing)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
```

Run the check again. `rustup` adds itself to the shell profile, so later
terminals find `cargo` too.

**If it fails** with `cargo: command not found` in a new shell, run
`. "$HOME/.cargo/env"` first.

### Step 6. Get the code

If you're already in the repo, skip this step.

**Check**

```bash
git -C REPO rev-parse --show-toplevel && ls REPO/brand.json
```

**Run**

```bash
git clone <the repo URL you were given> dashbot && cd dashbot
```

If it's a private repo and the clone asks for a password, **HUMAN:** *"The
repo is private. Please sign in to GitHub with `gh auth login` (I can run it
for you; it opens your browser), or give me the repo as a zip."*

### Step 7. Install dependencies

**Run**

```bash
pnpm install
```

**Check**

```bash
pnpm typecheck && echo TYPECHECK_OK
```

Expected: ends with `TYPECHECK_OK`.

**If it fails:** `ERR_PNPM_UNSUPPORTED_ENGINE` or a wrong pnpm version: go back to
Step 4. Network errors: run `pnpm install` again; it resumes.

### Step 8. Build the desktop app

**Run** (about 8 minutes on a recent Apple Silicon Mac the first time, up to
25 on older ones; a few minutes after that)

```bash
CI=true pnpm tauri build --bundles app
```

`CI=true` stops the build trying to arrange a Finder window. `--bundles app`
builds just the `.app`; leave it off to also get a `.dmg` (only needed to
give the app to someone else; see [Sharing the build](#sharing-the-build)).
Rust warnings during the build are expected.

**Check**

```bash
ls -d src-tauri/target/release/bundle/macos/Dashbot.app && plutil -extract CFBundleIdentifier raw src-tauri/target/release/bundle/macos/Dashbot.app/Contents/Info.plist
```

Expected: the path, then `io.native.dashbot`. The name comes from
`brand.json`. If it has changed, look in `src-tauri/target/release/bundle/macos/`
for the one `.app` there. If `CARGO_TARGET_DIR` is set, the bundle is under
`$CARGO_TARGET_DIR/release/bundle/` instead.

**If it fails:**

- `linker 'cc' not found` or `xcrun: error`: go back to Step 2.
- `Port 1420 is already in use`: that only affects `pnpm tauri dev`, not this
  build. See [Troubleshooting](#troubleshooting).
- Out of disk space: the build needs about 3 GB in `src-tauri/target/`, plus
  Rust's and pnpm's caches.

### Step 9. Install and open the app

**Run**

```bash
osascript -e 'quit app "Dashbot"' 2>/dev/null; rm -rf /Applications/Dashbot.app && cp -R src-tauri/target/release/bundle/macos/Dashbot.app /Applications/ && codesign --force --deep --sign - /Applications/Dashbot.app && codesign --verify --deep --strict /Applications/Dashbot.app && echo SIGNATURE_OK && open /Applications/Dashbot.app
```

The build signs only the program inside the bundle, so `codesign --verify`
reports *"code has no resources but signature indicates they must be
present"* on it as built. Re-signing ad hoc (`--sign -`) gives the whole
bundle a consistent signature, so macOS (and the Keychain, which the app uses
for its phone key and secrets) sees one app. Expected: `SIGNATURE_OK`.

**Check**

```bash
sleep 5; pgrep -fl "Dashbot.app/Contents/MacOS" && echo RUNNING
```

Expected: a process line and `RUNNING`.

A build made on this Mac opens without a Gatekeeper warning (only downloaded
files get checked). If macOS still says it "can't be opened", see
[Gatekeeper](#the-app-cant-be-opened--apple-could-not-verify).

**HUMAN:** *"The app is open. It will ask you to pick Claude Code or Codex.
Pick the one you pay for (Claude Pro/Max: Claude Code. ChatGPT Plus/Pro:
Codex). It installs it and opens a sign-in page in your browser. Sign in
there, then come back and tell me what the app shows."*

### Step 10. The engine is installed and signed in

The app's onboarding installs the engine and starts sign-in. Afterwards (or
if the human prefers you do it from the terminal):

**Check: Claude Code**

```bash
claude --version && claude auth status
```

Expected: a version, then JSON with `"loggedIn": true`.

**Run** (if missing): `curl -fsSL https://claude.ai/install.sh | bash`, then
`claude` once to sign in. **HUMAN:** *"Claude Code opened a sign-in page in your
browser. Please sign in with your Claude account (Pro or Max) and approve it,
then tell me."*

**Check: Codex**

```bash
codex --version && codex login status
```

Expected: a version, then `Logged in using ChatGPT` (or an API key).

**Run** (if missing): `npm install -g @openai/codex`, then `codex login`.
**HUMAN:** *"Codex opened a sign-in page in your browser. Please sign in with
your ChatGPT account and approve it, then tell me."*

What each costs: both run on the human's own account. Claude Code needs a
Claude **Pro or Max** subscription (or an Anthropic API key with billing).
Codex needs a paid **ChatGPT** plan (Plus, Pro, Business, Edu, Enterprise) or
an OpenAI API key. The app adds no charge of its own. On a subscription, usage
counts against the plan's limits; with an API key, it's billed per token.

**Check: the app agrees.** **HUMAN:** *"Do you see a 'You're all set' screen,
and then a chat with your Chief of Staff greeting you?"* If yes, the desktop
is done. If it still asks you to sign in, quit the app (⌘Q), open it again
and tell me what it shows.

### Step 11. Tailscale on the Mac

The phone reaches the Mac over the human's own Tailscale network. Nothing goes
through our servers.

Every Tailscale command below starts with this line, because the CLI may be on
`PATH` (Homebrew) or only inside the app, and each new shell forgets `TS`:

```bash
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
```

**Check**

```bash
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
TAILSCALE_BE_CLI=1 "$TS" status --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["BackendState"], d["Self"]["DNSName"])'
```

Expected: `Running <name>.<tailnet>.ts.net.`

**HUMAN** (if it's not installed or not `Running`): *"Please install Tailscale
on your Mac from https://tailscale.com/download/mac (or the Mac App Store),
open it, and sign in. Use the same account you'll use on your phone. A free
personal account is fine. Tell me when the menu bar icon says Connected."*

**HUMAN** (the tailnet needs HTTPS certificates, once per account): *"In your
browser, open https://login.tailscale.com/admin/dns. Make sure **MagicDNS** is
on, then click **Enable HTTPS** under HTTPS Certificates. Tell me when it's
done."* If you skip this, the app's Phone panel shows a "turn on HTTPS
certificates" message with a link to the same page.

### Step 12. Tailscale and Expo Go on the phone

**HUMAN:** *"On your phone, install two free apps: **Tailscale** and **Expo
Go** (App Store or Google Play). Open Tailscale and sign in with the **same
account** as on the Mac, and turn it on. Tell me when both are installed and
Tailscale says Connected."*

**Check** (from the Mac): the phone shows up on the tailnet.

```bash
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
TAILSCALE_BE_CLI=1 "$TS" status | grep -iE 'iphone|ipad|android|phone'
```

Expected: a line for the phone. If nothing shows, ask the human to check that
Tailscale on the phone is on and signed in to the same account.

### Step 13. Run the phone app (Expo Go)

**Run** (from `REPO/mobile`, in a terminal that stays open)

```bash
cd mobile && pnpm install && npx expo start --go --lan
```

**Check:** in another terminal,

```bash
curl -s http://localhost:8081/status
```

Expected: `packager-status:running`. Expo prints a QR code.

**HUMAN:** *"On your phone, open the iPhone **Camera** app (Android: open **Expo
Go** and tap Scan QR code) and point it at the QR code in the terminal. Tap the
banner to open it in Expo Go. The first load takes a minute. Tell me when you
see 'Scan the code on your Mac'."*

**If it fails:**

- *"Could not connect to the server"* or it never loads: the phone can't reach
  the Mac's Wi-Fi address (a different Wi-Fi, guest Wi-Fi, or the Mac firewall).
  Stop Expo (Ctrl+C) and serve it over Tailscale instead, which works from
  any network:
  ```bash
  TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
  REACT_NATIVE_PACKAGER_HOSTNAME=$(TAILSCALE_BE_CLI=1 "$TS" ip -4) npx expo start --go --lan
  ```
  and scan the new QR code.
- *"Project is incompatible with this version of Expo Go"*: Expo Go only
  runs one Expo SDK version, and this app is on SDK 58 (`mobile/package.json`).
  If the store's Expo Go is on a different SDK, Expo Go can't run it. Use
  [Route B](#route-b-build-the-phone-app-onto-your-iphone) instead.
- Port 8081 in use: add `--port 8082` (any free port).

**This terminal must stay open.** In Expo Go the phone app loads its code from
the Mac every time it starts. Tell the human: *"Leave this terminal window
open. If you close it, the phone app stops loading. To start it again later,
open Terminal in the dashbot folder and run `cd mobile && npx expo start --go
--lan`, then open Expo Go and tap Dashbot under Recently opened."*

### Step 14. Pair the phone

**HUMAN:** *"On the Mac, in the app, click **Phone** at the bottom of the left
sidebar, then **Pair a phone**. A QR code appears. On your phone, in the app
inside Expo Go, tap **Scan the code on your Mac** and scan it. (In Expo Go, use
that button, not the Camera app.) The phone asks 'Pair with …?': tap Pair.
Then the Mac asks 'Allow … to use your agents?': click **Allow**. Tell me what
the phone shows."*

**Check:** the phone shows the agents list with the Chief of Staff, and the
Mac's Phone panel lists the phone as paired. **HUMAN:** *"Send the Chief of
Staff a message from your phone. Does a reply appear on both the phone and the
Mac?"*

**If it fails:** see [Pairing can't reach the Mac](#pairing-cant-reach-the-mac).

Done. Tell the human: *"You're set up. Talk to your Chief of Staff on the Mac
or the phone. Keep the Mac on and the app open for your agents to keep
working, and keep the Expo terminal open for the phone app."*

---

## What doesn't work in Expo Go

Expo Go is a general-purpose app with a fixed set of native modules. This app
works in it, but these parts don't (read from `mobile/package.json` against
Expo's bundled module list, and how each one is guarded in `mobile/src/lib/`):

| Feature | In Expo Go | Why |
| --- | --- | --- |
| Push notifications (alerts while the app is closed) | No | Needs the official build's push entitlement and relay, which isn't deployed yet (`src/lib/push.ts`; docs/push-relay.md). No self-build gets it either. Alerts arrive only while the app is open |
| "Send to agent…" in the share sheet | No | A native share extension (`expo-share-intent`), and only in builds made with `SHIPSTUDIO_SHARE_EXTENSION=1` by a paid Apple team. Not built or tried on a device yet |
| Dictation's on-phone recognizer | No | `expo-speech-recognition` isn't in Expo Go. The mic button points to the keyboard's own dictation instead (`src/lib/dictation.ts`) |
| Home Screen quick actions (long-press the icon) | No | `expo-quick-actions` isn't in Expo Go. Silently off (`src/lib/quickActions.ts`) |
| Opening pairing links from the Camera app or a message | No | Expo Go can't receive the app's own `dashbot-companion://` scheme. Scan from inside the app instead |
| App name and icon on the Home Screen | No | It lives inside Expo Go |
| Over-the-air updates, "Restart to update" | No | `expo-updates` is off in Expo Go. Pulling the repo updates it |
| Working without the Mac's dev server | No | Expo Go loads the code from `expo start` on the Mac each time |
| Background refresh | No (in no build) | Not built yet |

What does work: pairing (QR scanner), chats, approvals, secrets (stored with
`expo-secure-store`, which in Expo Go lives in Expo Go's own keychain space;
"Forget this Mac" clears it), result cards, the timeline, starting agents and
routines, photos and files, local notifications while the app is open, light
and dark.

We haven't checked this on a real phone in Expo Go for this release. We
checked that the iOS bundle builds (`expo start --go`, then fetching the
bundle) and that each module above is guarded so the app doesn't crash
without it.

## Other routes

### Route B: build the phone app onto your iPhone

No Metro, a real Home Screen app, dictation and quick actions work. Needs
**full Xcode** from the App Store (Expo SDK 58 needs Xcode 26.4 or later), a
free Apple ID, and the iPhone plugged in by cable.

**From the desktop app** (Phone → **Get the phone app**): a checklist, with
your agent running the build beside it while the app checks each step
(docs/mobile.md, "Installing the app"). **This is only offered when the app
runs from source (`pnpm tauri dev`).** A `.app` from `pnpm tauri build` hides
it, because `links.companionSource` in `brand.json` is null, so it has no
repository to fetch the phone app's source from. From a built `.app`, do it
by hand:

HUMAN steps first: *"Please install Xcode from the App Store (it's large, so
it takes a while), open it once, and sign in under Xcode → Settings →
Accounts with your Apple ID. Then plug your iPhone into the Mac, tap Trust on
the phone, and turn on Settings → Privacy & Security → Developer Mode (the
phone restarts). Tell me when that's done."*

**Accept the license (after installing *or updating* Xcode).** Until both of
these pass, git and every build fail, so run them again after each Xcode
update. Each `sudo` asks for the Mac password and shows nothing while you type.

```bash
xcodebuild -license check || sudo xcodebuild -license accept
xcodebuild -checkFirstLaunchStatus || sudo xcodebuild -runFirstLaunch
```

**Check**

```bash
xcodebuild -version | head -1
security find-identity -v -p codesigning | grep "Apple Development"
xcrun xctrace list devices
```

Expected: `Xcode 26.4` or later, at least one `Apple Development` identity,
and the iPhone under `== Devices ==` as `<name> (<iOS version>) (<UDID>)`.
That last bracket is the phone's **hardware UDID** (`00008140-…`), the id the
build needs. Not the identifier `xcrun devicectl list devices` prints (a plain
UUID like `D9365757-35EA-…`): xcodebuild refuses that one. No identity yet?
The Run step's `-allowProvisioningUpdates` creates it with automatic signing.

**Older Xcode:** if the build fails in `expo-modules-jsi` with a Swift error
like *"sending 'slot' risks causing data races"*, this Xcode is older than
Expo SDK 58 needs. Update it in the App Store (then accept the license again).

**Run.** Use your team id: the `OU=` field of your Apple Development
certificate, not the id in brackets. A free Apple ID's team is a *personal
team*, which can't sign the Push Notifications capability; the prebuild
leaves the push entitlement out on its own (no `EAS_PROJECT_ID` and no
`COMPANION_PUSH_ENTITLEMENT=1`), so leave those unset.

```bash
TEAM=$(security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject | sed -n 's/.*OU *= *\([A-Z0-9]*\).*/\1/p')
echo "$TEAM"
UDID=00008140-…   # the hardware UDID from xctrace above
export COMPANION_BUNDLE_ID=io.native.dashbot.companion.$(printf %s "$TEAM" | shasum -a 256 | cut -c1-6) APPLE_TEAM_ID=$TEAM
cd mobile && pnpm install
npx expo prebuild -p ios --clean
cd ios
xcodebuild -workspace Dashbot.xcworkspace -scheme Dashbot -configuration Release \
  -destination id=$UDID -allowProvisioningUpdates -derivedDataPath build \
  DEVELOPMENT_TEAM=$TEAM CODE_SIGN_STYLE=Automatic build
xcrun devicectl device install app --device $UDID build/Build/Products/Release-iphoneos/Dashbot.app
```

(The bundle id is the one the desktop app looks for: `companion.bundleId` from
`brand.json`, plus six hex characters of the team id's SHA-256. The workspace,
scheme and `.app` are named after `name` in `brand.json`, letters and digits
only.) Not `npx expo run:ios`: it doesn't pass `-allowProvisioningUpdates`, so
a free Apple ID's build can't create its provisioning profile, and its
`--device` also needs the hardware UDID. If signing still names the Push
Notifications capability, the `ios/` folder is from an older prebuild: run
the prebuild again (it has `--clean`).

**HUMAN** after it installs: *"On the iPhone, open Settings → General → VPN &
Device Management, tap your Apple ID under Developer App, and tap Trust. Then
open Dashbot and pair it as before (Step 14). In this build, the Camera app can
open the pairing code too."* Until then, opening it says "Untrusted
Developer". Developer Mode must stay on.

**A free Apple ID's build stops opening after 7 days.** Run the prebuild,
build and install again to renew it (or Phone panel → Reinstall when running
from source). A paid Apple Developer account makes it last a year.
Push still doesn't work (no push entitlement on a self-build).

Android: `COMPANION_BUNDLE_ID=io.native.dashbot.companion.self npx expo prebuild -p android --clean`, then the same with `npx expo run:android --variant release`, with a phone on adb. It
doesn't expire. Not verified on Android hardware.

### Developer: run from source with hot reload

```bash
pnpm tauri dev
```

It uses Vite on port 1420. If something else has that port (another checkout,
the owner's own copy), move both together:

```bash
SHIPSTUDIO_DEV_PORT=1445 pnpm tauri dev --config '{"build":{"devUrl":"http://127.0.0.1:1445"}}'
```

The dev build and the installed `.app` share the same app data (agents,
pairing), so don't run both at once.

### Sharing the build

`pnpm tauri build` (without `--bundles app`) also makes
`src-tauri/target/release/bundle/dmg/Dashbot_<version>_<arch>.dmg`. It's
**unsigned** (ad-hoc signed only), so on another Mac Gatekeeper blocks it.
On macOS 15 and later, right-click → Open no longer gets around it; the other
person has to use System Settings (below). Better: have them build it
themselves with this guide. A signed and notarized download needs the owner's
Apple Developer account (docs/internal/release-checklist.md).

---

## Troubleshooting

### Pairing can't reach the Mac

The phone talks to `https://<mac>.<tailnet>.ts.net:47463` (the port is
`companion.tailnetPort` in `brand.json`).

1. Tailscale is on, on **both** devices, with the **same account**: run the
   Step 11 and Step 12 checks.
2. HTTPS certificates are on for the tailnet (Step 11). The Phone panel says
   so when they're off.
3. The app is open on the Mac and the Phone panel shows it's on. Check the
   route:
   ```bash
   TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
   TAILSCALE_BE_CLI=1 "$TS" serve status
   ```
   Expected: a line for `:47463` proxying to `http://127.0.0.1:<port>`.
   If it's missing, in the Phone panel turn the phone off and on again (or
   use Retry).
4. The pairing code lasts 5 minutes and works once. Make a new one.
5. *"This isn't your Mac"*: the phone was paired with a different Mac or the
   Mac lost its key. On the phone use Forget this Mac, then pair again.

### "The app entry module failed to load" (or a blank or black window)

The desktop window couldn't load its interface. In a `pnpm tauri dev` window
that means Vite isn't serving on the port Tauri expects: the dev terminal was
closed, Vite crashed, or it's on a different port. Check the dev terminal for
errors, and `curl -s http://127.0.0.1:1420 | head -3`. Restart
`pnpm tauri dev`. In a built `.app` it shouldn't happen. Rebuild (Step 8), and
if it persists, it's a bug; send `~/Library/Logs/Dashbot/`.

### Port already in use

- `Port 1420 is already in use` (`pnpm tauri dev`): another dev copy is
  running. Use `SHIPSTUDIO_DEV_PORT` (above), or find it with
  `lsof -i tcp:1420`.
- Port 8081 (Expo): `npx expo start --go --lan --port 8082`.
- The phone port 47463 belongs to the app; Ship Studio uses 47443, so both can run.

### The app "can't be opened" / "Apple could not verify…"

A copy built on this Mac shouldn't show this. A `.app` or `.dmg` copied from
someone else will. Open **System Settings → Privacy & Security**, scroll to
the message about Dashbot, click **Open Anyway**, and confirm with your
password. Or, if you trust where it came from:

```bash
xattr -dr com.apple.quarantine /Applications/Dashbot.app
```

### Agents don't answer / "no engine"

The engine isn't installed or signed in. Run the Step 10 checks. Sign in again
with `claude` or `codex login`, then quit and reopen the app. If the human's only
agent CLI is something else (Opencode, Cursor), Agents shows a "no engine"
panel: install Claude Code or Codex.

### "Dashbot wants to use your confidential information stored in … keychain"

The app keeps its phone-pairing key and agent secrets in the Keychain. A
locally built app has no developer signature, so after each rebuild macOS asks
again. **HUMAN:** *"macOS is asking whether Dashbot can use the Keychain.
Please type your Mac password and click Always Allow."* If you click Deny, the
Phone panel won't offer a pairing code ("unlock your Mac").

### Agents stop when I close the lid

The Mac has to be awake. Settings → Agents → keep this Mac on. Closing the
app stops agents too.

### Where the logs are

`~/Library/Logs/Dashbot/`. App data: `~/Library/Application Support/Dashbot/`.
Projects: `~/ShipStudio/` (shared with Ship Studio).
