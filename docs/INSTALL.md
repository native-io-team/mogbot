# Install: from a fresh Mac to your agents on your phone

There is no download yet (no signed build, no App Store). You build the app on
your own Mac from this repo. The easiest way is to let an AI coding agent do it
for you.

## For the human (read this first)

Invited to try it? Start with [WELCOME.md](WELCOME.md): what this is and what
to expect.

1. Open this folder in **Claude Code** or **Codex** and say: *"Set this up on my
   Mac and phone. Follow docs/INSTALL.md."*
   Never used either? Install the Claude desktop app
   ([claude.ai/download](https://claude.ai/download)) and open its **Code**
   tab, or the Codex app, sign in, and say: *"Download
   https://github.com/native-io-team/mogbot into a folder in my home folder,
   then set it up on my Mac and phone. Follow docs/INSTALL.md."* You won't
   type any commands yourself.
2. The agent installs the tools and builds the app (the first build takes
   10–25 minutes). It stops and asks you to do the things only you can do:
   type your Mac password, sign in in your browser, install apps on your
   phone, scan a code, click Allow.
3. You need:
   - A Mac (Apple Silicon or Intel) on a recent macOS, an internet connection,
     and **15 GB free** (about **25 GB** if you build the phone app with Xcode).
   - **A paid Claude plan (Pro or Max) for Claude Code, or a paid ChatGPT plan
     (Plus, Pro, Business…) for Codex**, or both. You can add more than one
     account; when one runs out, the app switches to the next.
   - For the phone: an iPhone (or Android phone) and a free **Tailscale**
     account, signed in on the Mac **and** the phone with the same account
     **before** you scan the pairing code.
4. The phone app comes two ways, and the agent will ask which:
   **Expo Go** (minutes; runs inside Expo Go while a terminal on the Mac stays
   open; no dictation or share sheet) or **built with Xcode** (the real app;
   30–60 minutes the first time; with a free Apple ID, re-install every 7
   days). Neither gets push notifications yet.
5. Your Mac does the work. Agents stop when the Mac sleeps or the app is closed.

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
- For the phone, ask the human which route (Step 13) instead of choosing.
  Developer options are in [Other routes](#other-routes).
- Never run commands as the human (`sudo`) without telling them why first, and
  never delete anything outside this repo without asking (see
  [Disk full](#disk-full)).
- Run every command from the repo root unless the step says otherwise.
  `REPO` below means the repo root.

### Step 1. Check the Mac

**Check**

```bash
sw_vers -productVersion; uname -m; df -h ~ | tail -1
```

Expected: a macOS version (tested on macOS 26; macOS 14 or later is what we
expect to work), `arm64` or `x86_64`, and at least 15 GB available (25 GB if
the phone app will be built with Xcode, Step 15B).

**If it fails:** if there's less than that free, tell the human: *"Your Mac
needs about 15 GB free for the build (25 GB if we build the phone app with
Xcode). You have <N> free. I can show you what's taking space and what's safe
to remove. Want me to?"* Then follow [Disk full](#disk-full).

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

Full Xcode is **not** needed for the desktop app or Expo Go. It's only needed for
building the phone app with Xcode (Step 15B).

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
git clone <the repo URL you were given> mogbot && cd mogbot
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
ls -d src-tauri/target/release/bundle/macos/Mogbot.app && plutil -extract CFBundleIdentifier raw src-tauri/target/release/bundle/macos/Mogbot.app/Contents/Info.plist
```

Expected: the path, then `io.native.mogbot`. The name comes from
`brand.json`. If it has changed, look in `src-tauri/target/release/bundle/macos/`
for the one `.app` there. If `CARGO_TARGET_DIR` is set, the bundle is under
`$CARGO_TARGET_DIR/release/bundle/` instead.

**If it fails:**

- `linker 'cc' not found` or `xcrun: error`: go back to Step 2.
- `Port 1420 is already in use`: that only affects `pnpm tauri dev`, not this
  build. See [Troubleshooting](#troubleshooting).
- `No space left on device`: the build needs about 3 GB in
  `src-tauri/target/`, plus Rust's and pnpm's caches. See [Disk full](#disk-full).

### Step 9. Install and open the app

**Run**

```bash
osascript -e 'quit app "Mogbot"' 2>/dev/null; rm -rf /Applications/Mogbot.app && cp -R src-tauri/target/release/bundle/macos/Mogbot.app /Applications/ && codesign --force --deep --sign - /Applications/Mogbot.app && codesign --verify --deep --strict /Applications/Mogbot.app && echo SIGNATURE_OK && open /Applications/Mogbot.app
```

The build signs only the program inside the bundle, so `codesign --verify`
reports *"code has no resources but signature indicates they must be
present"* on it as built. Re-signing ad hoc (`--sign -`) gives the whole
bundle a consistent signature, so macOS (and the Keychain, which the app uses
for its phone key and secrets) sees one app. Expected: `SIGNATURE_OK`.

**Check**

```bash
sleep 5; pgrep -fl "Mogbot.app/Contents/MacOS" && echo RUNNING
```

Expected: a process line and `RUNNING`.

A build made on this Mac opens without a Gatekeeper warning (only downloaded
files get checked). If macOS still says it "can't be opened", see
[Gatekeeper](#the-app-cant-be-opened--apple-could-not-verify).

**HUMAN:** *"The app is open. It walks you through setup one screen at a
time, with a progress bar at the top and one big button on each screen.
Every check it runs says **Done** when it passes, or **Not done yet** with
the one thing to do when it doesn't. First: pick Claude Code or Codex (the
one you pay for: Claude Pro/Max is Claude Code, ChatGPT Plus/Pro is Codex).
It installs it, then opens a sign-in page in your browser: sign in there.
Then one question, how much your agents should do on their own (Use good
judgement is the default; Skip keeps it). Stop when it asks **'Use your
agents from your phone?'** and tell me."*

The app's screens, in order: Welcome → your AI (pick, install, sign in: a
screen each) → how independent → your phone (optional: Tailscale on the Mac,
Tailscale on the phone, the phone app, scan and Allow) → "You're ready:
bring your agents, or start fresh?". Quitting part-way is fine: the app
reopens on the screen it stopped at.

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

**Check: the app agrees.** **HUMAN:** *"Does the app show 'Use your agents
from your phone?'"* If yes, the engine is done. If it still says **Not done
yet** on the sign-in screen, press **Try again**; if it fails twice, quit the
app (⌘Q), open it again (it reopens on the same screen) and tell me what it
shows.

### Step 11. More than one account (optional)

Skip unless the human has a second Claude or ChatGPT plan (a work and a
personal one, say).

**HUMAN:** *"Do you have more than one Claude or ChatGPT plan you'd like the
agents to use? If one runs out of usage, the app switches to the next one on
its own. If yes: click the account row at the foot of the Agents sidebar
(or press ⌘K and type Add an account), click Add account, give it a name
(Work, say), click Add and sign in, and sign in to the other account in the
browser page that opens. Tell me when it's listed."*

**Check:** the human sees the account in the popover (and Settings → Agents →
Accounts), below this Mac's own sign-in from Step 10, shown by its email.
Accounts are tried in that order ("Use this one now" puts one first); when
one hits its usage limit the chat shows a quiet note like "Switched to Work:
sam@example.com is out of usage until 10:00 AM." There is no
terminal check for this; the list in Settings is the answer.

### Step 12. Tailscale on the Mac

In the app: **Use your agents from your phone? → Set up my phone**. The
next screen, **Get Tailscale on this Mac**, checks this for itself and moves
on when it's done; the checks below are the same ones from the terminal.

The phone reaches the Mac over the human's own Tailscale network. Nothing goes
through our servers. **Tailscale not being on, or being signed in to a
different account on the phone, is the most common reason pairing gets stuck**,
so do Steps 12 and 14 fully before anyone scans a code.

Every Tailscale command below starts with this line, because the CLI may be on
`PATH` (Homebrew) or only inside the app, and each new shell forgets `TS`:

```bash
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
```

**Check**

```bash
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
TAILSCALE_BE_CLI=1 "$TS" status --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); u=d.get("User",{}).get(str(d["Self"].get("UserID")),{}); print(d["BackendState"], d["Self"]["DNSName"], u.get("LoginName","(no login: tagged machine)"))'
```

Expected: `Running <name>.<tailnet>.ts.net. <login>`. Remember the login (the
last word): the phone must use the same one.

**HUMAN** (if it's not installed or not `Running`): *"Please install Tailscale
on your Mac from https://tailscale.com/download/mac (or the Mac App Store),
open it, and sign in. Use the same account you'll use on your phone. A free
personal account is fine. Tell me when the menu bar icon says Connected."*

**HUMAN** (the tailnet needs HTTPS certificates, once per account): *"In your
browser, open https://login.tailscale.com/admin/dns. Make sure **MagicDNS** is
on, then click **Enable HTTPS** under HTTPS Certificates. Tell me when it's
done."* If you skip this, the app's pairing screen says **"Not done yet.
HTTPS certificates are off in your Tailscale account."** with an **Open
Tailscale admin** button and **Check again**, which answers every time it's
pressed.

### Step 13. Choose how to get the phone app

There's no App Store or TestFlight build yet, so the phone app is either run
inside Expo Go or built onto the iPhone with Xcode. Ask; don't pick for them.

**HUMAN:** *"How do you want the phone app? **1. Expo Go**: a few minutes.
It runs inside a free app called Expo Go and only works while a terminal on
this Mac keeps running. No built-in dictation, no 'Send to agent' in the share
sheet. **2. Built with Xcode** onto your iPhone: the real app, with its own
icon, dictation and no terminal to keep open. It takes 30–60 minutes the first
time, needs the full Xcode app (about 25 GB free in total) and your iPhone
plugged in by cable once. With a free Apple ID it has to be re-installed every
7 days. Neither one gets push notifications yet: those need the official
build, which needs a paid Apple Developer account and TestFlight, and doesn't
exist yet. Until then you're alerted only while the app is open. Which one?"*

- **1** → Step 14, then Step 15A.
- **2** → Step 14, then Step 15B. (Android phone: Step 15A, or the Android
  note at the end of 15B.)
- Not sure → Expo Go. They can build with Xcode later; pairing again is all
  it takes.

### Step 14. Tailscale on the phone (before any scanning)

The app's **Get Tailscale on your phone** screen shows a QR code to
Tailscale on the App Store and ticks **Done** as soon as a phone signed in to
the Mac's account is on the tailnet with Tailscale switched on. It says which
one it sees ("signed in, but switched off") when it isn't.

**HUMAN:** *"On your phone, install **Tailscale** from the App Store (or
Google Play): scan the code on the Mac's screen with the camera. Open it and sign in with the **same account** as on the Mac:
`<login from Step 12>`. Then switch it on. Tell me when it says Connected."*
(If Step 15A is next, add: *"Also install **Expo Go**, a free app from the
same store."*)

**Check** (from the Mac): the phone shows up on the same tailnet.

```bash
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
TAILSCALE_BE_CLI=1 "$TS" status | grep -iE 'iphone|ipad|android|phone'
```

Expected: a line for the phone that doesn't end in `offline`. **Don't go on
until it does.** If nothing shows, the phone is signed in to a different
Tailscale account, or Tailscale on the phone is off: *"I can't see your phone
on your Tailscale network yet. On the phone, open Tailscale, check it's
switched on and signed in as `<login>`, and tell me again."*

### Step 15A. Run the phone app in Expo Go

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
  Step 15B instead.
- Port 8081 in use: add `--port 8082` (any free port).

**This terminal must stay open.** In Expo Go the phone app loads its code from
the Mac every time it starts. Tell the human: *"Leave this terminal window
open. If you close it, the phone app stops loading. To start it again later,
open Terminal in the mogbot folder and run `cd mobile && npx expo start --go
--lan`, then open Expo Go and tap Mogbot under Recently opened."*

What's missing in Expo Go: [What doesn't work in Expo Go](#what-doesnt-work-in-expo-go).

Then go to Step 16.

### Step 15B. Build the phone app onto the iPhone with Xcode

The real app: no Metro, a Home Screen icon, dictation and quick actions work.
Needs **full Xcode** from the App Store (Expo SDK 58 needs **Xcode 26.4 or
later**), a free Apple ID, and the iPhone plugged in by cable.

The desktop app's **Phone → Get the phone app** checklist does this same build
with an agent beside it (docs/mobile.md, "Installing the app"), but it is
**only offered when the app runs from source** (`pnpm tauri dev`). A `.app`
from Step 8 hides it, because `links.companionSource` in `brand.json` is null,
so it has no repository to fetch the phone app's source from. From the built
`.app`, do it by hand as below.

**Check disk space first.** Xcode plus its iOS components and the first build
take roughly 15–25 GB on top of the desktop build.

```bash
df -h ~ | tail -1
```

Under 25 GB available: see [Disk full](#disk-full) before installing Xcode.

**HUMAN:** *"Please install **Xcode** from the Mac App Store (it's large, so it
takes a while). Open it once, let it install the components it offers (iOS
included), and sign in under Xcode → Settings → Accounts with your Apple ID; a
free one is fine. Then plug your iPhone into the Mac with a cable, unlock it,
tap **Trust** on the phone, and turn on **Settings → Privacy & Security →
Developer Mode** (the phone restarts; confirm Turn On afterwards). Tell me when
that's done."*

**Accept the license and install first-launch components (after installing
*or updating* Xcode).** Until both pass, git and every build fail with a
license message, so run them again after **every** Xcode update.

```bash
xcodebuild -license check || sudo xcodebuild -license accept
xcodebuild -checkFirstLaunchStatus || sudo xcodebuild -runFirstLaunch
```

**HUMAN** (for the `sudo` lines): *"I need your Mac password to accept Xcode's
license. Please type it in the terminal when it asks; nothing shows while you
type."*

**Check**

```bash
xcode-select -p
xcodebuild -version | head -1
xcrun xctrace list devices
```

Expected: a path inside `Xcode.app` (if it's `/Library/Developer/CommandLineTools`,
run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`), then
`Xcode 26.4` or later, then the iPhone under `== Devices ==` as
`<name> (<iOS version>) (<UDID>)`. That last bracket is the phone's **hardware
UDID** (it looks like `00008XXX-XXXXXXXXXXXXXXXX`), the id the build needs.
**Not** the identifier `xcrun devicectl list devices` prints (a plain UUID like
`1A2B3C4D-5E6F-…`): xcodebuild refuses that one.

**If it fails:**

- Xcode older than 26.4, or the build later fails in `expo-modules-jsi` with a
  Swift error like *"sending 'slot' risks causing data races"*: this Xcode is
  too old for Expo SDK 58. **HUMAN:** *"Your Xcode is too old for the phone app.
  Please update it in the App Store (Updates), open it once, and tell me when
  it's done."* Then run the license lines above again.
- The phone isn't listed: unlock it, re-plug the cable, tap Trust; check
  Developer Mode is on.

**Run.** The team id is the `OU=` field of the Apple Development certificate
(not the id in brackets in the certificate's name). A free Apple ID's team is a
*personal team*, which can't sign the Push Notifications capability; the
prebuild leaves the push entitlement out by itself (no `EAS_PROJECT_ID` and no
`COMPANION_PUSH_ENTITLEMENT=1`), so leave those unset. If there's no Apple
Development certificate yet, the first `xcodebuild` with
`-allowProvisioningUpdates` creates one; run the `TEAM=` line again after it.

```bash
TEAM=$(security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject | sed -n 's/.*OU *= *\([A-Z0-9]*\).*/\1/p')
echo "$TEAM"
UDID=<the hardware UDID from xctrace above>
export COMPANION_BUNDLE_ID=io.native.mogbot.companion.$(printf %s "$TEAM" | shasum -a 256 | cut -c1-6) APPLE_TEAM_ID=$TEAM
cd mobile && pnpm install
npx expo prebuild -p ios --clean
cd ios
xcodebuild -workspace Mogbot.xcworkspace -scheme Mogbot -configuration Release \
  -destination id=$UDID -allowProvisioningUpdates -derivedDataPath build \
  DEVELOPMENT_TEAM=$TEAM CODE_SIGN_STYLE=Automatic build
xcrun devicectl device install app --device $UDID build/Build/Products/Release-iphoneos/Mogbot.app
```

(The bundle id is the one the desktop app looks for: `companion.bundleId` from
`brand.json`, plus six hex characters of the team id's SHA-256. The workspace,
scheme and `.app` are named after `name` in `brand.json`, letters and digits
only.) Not `npx expo run:ios`: it doesn't pass `-allowProvisioningUpdates`, so
a free Apple ID's build can't create its provisioning profile. If signing
still names the Push Notifications capability, the `ios/` folder is from an
older prebuild: run the prebuild again (it has `--clean`).

**Check:** `xcrun devicectl device info apps --device $UDID | grep -i mogbot`
lists the app.

**HUMAN** after it installs: *"On the iPhone, open **Settings → General → VPN &
Device Management**, tap your Apple ID under Developer App, and tap **Trust**.
Then open the Mogbot app. Tell me when you see 'Scan the code on your Mac'."*
Until then, opening it says "Untrusted Developer". Developer Mode must stay on.

**A free Apple ID's build stops opening after 7 days.** Tell the human: *"With
a free Apple ID this build stops opening after 7 days. When it does, ask me
(or any agent in this folder) to 'rebuild the phone app with Xcode, Step 15B
of docs/INSTALL.md'; you stay paired."* A paid Apple Developer account makes
it last a year. Push still doesn't arrive on a self-build.

Android: `COMPANION_BUNDLE_ID=io.native.mogbot.companion.self npx expo prebuild -p android --clean`,
then `npx expo run:android --variant release` with the phone on adb. It
doesn't expire. Not verified on Android hardware.

### Step 16. Pair the phone

**Check first** (both must pass; this is where most stuck pairings come from):
Step 12's check says `Running`, and Step 14's check shows the phone, not
`offline`.

**HUMAN:** *"On the Mac, the app's **Get the Mogbot app on your phone**
screen: press **I already have the app** (we just installed it). The next
screen, **Scan this code**, turns on phone access by itself and shows a QR
code. (Skipped the phone earlier? Settings → Agents → Phone → Pair a phone
shows the same code.) On your phone, in the app: **It's on — next**, then
**Scan the code** (in Expo Go, use that button, not the Camera app). The
phone asks 'Pair with …?': tap **Pair**. Then the Mac asks 'Allow … to use
your agents?': click **Allow**. The Mac says **Done. Paired with …** and
moves on to the last screen. Tell me what the phone shows."*

**Check:** the phone shows the agents list with the Chief of Staff, and the
Mac's Phone panel lists the phone as paired. **HUMAN:** *"Send the Chief of
Staff a message from your phone. Does a reply appear on both the phone and the
Mac?"*

**If it fails:** the phone sits on "Reaching …" or says it can't reach the
Mac: see [Pairing is stuck](#pairing-is-stuck-or-cant-reach-the-mac).

### Step 17. Let agents use Chrome (optional, Claude Code only)

With this, an agent uses the sites the human is already signed in to in their
own Chrome (Figma, LinkedIn, a dashboard) instead of asking them to log in.
Reading goes through; every click, typing, post, send or payment, and any site
the agent wasn't given, asks on a card first. It needs Claude Code signed in
with a Claude account (not an API key). Codex agents can't use it; they ask
instead.

**HUMAN:** *"If you want your agents to use websites in your own Chrome: in
**each Chrome profile** you want them to use, install the **Claude in Chrome**
extension (https://claude.ai/chrome) and sign in to it with the **same Claude
account** you signed in to Claude Code with. Then in the app press ⌘K, choose
**Let agents use your browser…**, and follow the card until it offers **Turn
on**; press it. Keep Chrome open while agents work. The first time an agent
opens a site, the extension asks whether it may use that site: approve it.
Tell me what the card says."*

**Check:** the card says *"On. Agents use the sites you're signed in to in
Chrome, as you…"*. *"On, but Chrome isn't answering right now"* means Chrome
is closed or the extension isn't connected: see
[Extension not connected](#chrome-extension-not-connected). From the terminal,
Claude Code's link to the extension:

```bash
ls "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json" && echo HELPER_OK
```

Expected: `HELPER_OK`. That file is Claude Code's link to the extension; the
app looks for it too ("It needs the Claude in Chrome extension, which isn't
set up on this Mac yet" on a login card means it's missing). If it's missing,
run `claude --chrome` once in a terminal, type `/chrome` to see the connection
status, then `/exit`. It says nothing about whether Chrome is open; with Chrome
closed, agents report the browser as not connected.

### Step 18. First run choices

**HUMAN:** *"Two things worth knowing. **How independent your agents are**:
by default they work on this Mac on their own and ask before anything
leaves it (sending, posting, spending). You can change it any time by
telling your Chief ("ask me less", "ask me more") or in Settings →
Independence. Even at the most independent setting, spending money,
logins and deleting for good still ask you first. **Your team**: the Chief of Staff
creates, changes and removes the other agents for you, and you can change an
agent's instructions or routines just by asking in the chat. The Chief is also
the team's **admin**: it can OK other agents' everyday local work for you, and
brings you the rest in one message ('3 things only you can decide'). Keys,
logins and anything outward still come to you. You can change who's an admin
in Settings → Agents → Admins."*

There's nothing to check here. Don't change these settings for the human.

### Step 19. Bring agents from Grok Bot or another assistant (optional)

Only if the human already has agents in Grok Bot (or another assistant that
can add an MCP connector). Otherwise: **No thanks, start fresh** on the
card under the Chief's first message. Either way it's asked once; later, import is in ⌘K → Import agents,
Settings → Agents → Import, or the phone's ⋯ menu.

**HUMAN:** *"The app's last screen asks **'You're ready. Bring your agents
from Grok, ChatGPT or another assistant, or start fresh?'** To bring them:
**Bring my agents**, then three screens. **Turn on Remote access** turns it on
by itself and ticks when the internet can reach this Mac (if Tailscale needs
Funnel approved, it says so, with the page and Check again). **Add the link
to your assistant**: press **Copy link**, and in your other assistant add a
custom connector named Mogbot with that link; it ticks when your assistant
connects. **Send your assistant this message**: copy it, send it in a new
chat, and press **Open your Chief of Staff**. The Chief asks you first:
click **Allow**.
Your assistant describes its agents; the Chief plays the plan back to you,
asks what's missing, and you pick what to keep on one review card.
Afterwards the app checks what your new agents can already reach on this Mac
(apps, sign-ins, your Chrome if it's on) and lists only the rest under
'Setting up your team', one row per service, so you sign in to each service
once for every agent that needs it."*

From Ship Studio on this Mac it's simpler: **Import agents → From Ship
Studio** (the tab shows only when Ship Studio is on this Mac) previews them,
then copies them. Ship Studio is only read; its keys aren't copied.

**Check:** the review card appears in the Chief's chat, and after Import the
agents are in the sidebar. Imported routines arrive paused.

Done. Tell the human: *"You're set up. Talk to your Chief of Staff on the Mac
or the phone. Keep the Mac on and the app open for your agents to keep
working (Settings → Agents → On this Mac can keep it awake)."* On Expo Go add:
*"and keep the Expo terminal open for the phone app."*

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
| Opening pairing links from the Camera app or a message | No | Expo Go can't receive the app's own `mogbot-companion://` scheme. Scan from inside the app instead |
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
`src-tauri/target/release/bundle/dmg/Mogbot_<version>_<arch>.dmg`. It's
**unsigned** (ad-hoc signed only), so on another Mac Gatekeeper blocks it.
On macOS 15 and later, right-click → Open no longer gets around it; the other
person has to use System Settings (below). Better: have them build it
themselves with this guide. A signed and notarized download needs the owner's
Apple Developer account (docs/internal/release-checklist.md).

---

## Troubleshooting

The failures people actually hit, most common first:

| What you see | Usually | Fix |
| --- | --- | --- |
| Pairing stuck on "Reaching …", "can't reach", or "this phone isn't on your Mac's tailnet" | Tailscale off on the phone, or signed in to a different account than the Mac | [Pairing is stuck](#pairing-is-stuck-or-cant-reach-the-mac) |
| "The app entry module failed to load", or a blank or black desktop window | The dev server (Vite) isn't running, or the app needs a restart | [Entry module](#the-app-entry-module-failed-to-load-or-a-blank-or-black-window) |
| Links from the app open nothing, or a blank window | A leftover headless Chrome is catching them | [Links open blank](#links-open-nothing-or-a-blank-window) |
| Phone build fails: Xcode license, "sending 'slot' risks causing data races", or a device id refused | Xcode too old, or its license not accepted after an update; the wrong device id | [Xcode](#xcode-version-license-or-device-id) |
| `No space left on device`, or a build that dies part-way | Disk full | [Disk full](#disk-full) |
| An agent says the browser isn't connected, or a card says the Claude in Chrome extension isn't set up | The extension is missing, signed in to another Claude account, or Chrome is closed | [Extension not connected](#chrome-extension-not-connected) |
| Agents don't answer, or "no engine" | Claude Code or Codex not signed in | [Agents don't answer](#agents-dont-answer--no-engine) |

### Pairing is stuck or can't reach the Mac

The phone talks to `https://<mac>.<tailnet>.ts.net:47463` (the port is
`companion.tailnetPort` in `brand.json`). Go down this list in order:

1. Tailscale is on, on **both** devices, signed in to the **same account**.
   Run the Step 12 and Step 14 checks. This is the cause most of the time: on
   the phone, open Tailscale and look at the account and the switch.
2. HTTPS certificates are on for the tailnet (Step 12). The Phone panel says
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
`pnpm tauri dev`. In a built `.app` it shouldn't happen: quit it (⌘Q) and open
it again; if it persists, rebuild (Step 8) and report it as a bug with
`~/Library/Logs/Mogbot/`.

In Expo Go, the phone's version of this is a red error screen or "Could not
connect to the server": the Expo terminal (Step 15A) was closed. Start it
again and reopen the app from Expo Go.

### Links open nothing, or a blank window

When a headless Chrome is running (left behind by a test or automation tool),
macOS can hand links to it instead of the Chrome you see, so clicking a link
seems to do nothing or opens a blank window. List them:

```bash
pgrep -fl -- '--headless' | grep -i chrom
```

Each line is a headless Chrome, not the human's own browser windows.
**HUMAN:** *"There's an invisible copy of Chrome running that's catching your
links. Can I close it? Your normal Chrome windows stay open."* On yes, `kill`
each process id (the first number on each line) the list showed, then click
the link again.

### Xcode: version, license or device id

- *"You have not agreed to the Xcode license"*, or git suddenly fails after an
  Xcode update: run the two license lines in Step 15B
  (`sudo xcodebuild -license accept`, `sudo xcodebuild -runFirstLaunch`).
  They're needed again after **every** Xcode update.
- *"sending 'slot' risks causing data races"* in `expo-modules-jsi`: Xcode is
  older than 26.4, which Expo SDK 58 needs. Update Xcode in the App Store,
  open it once, accept the license again.
- *"Unable to find a destination matching…"*: the build was given devicectl's
  identifier. Use the hardware UDID from `xcrun xctrace list devices`.
- *"Personal development teams … do not support the Push Notifications
  capability"*: the `ios/` folder is from an older prebuild. Run
  `npx expo prebuild -p ios --clean` again, with `EAS_PROJECT_ID` and
  `COMPANION_PUSH_ENTITLEMENT` unset.
- *"Untrusted Developer"* on the phone: Settings → General → VPN & Device
  Management → your Apple ID → Trust.
- The app stopped opening after a week: a free Apple ID's build lasts 7 days.
  Build and install again (Step 15B); the pairing is kept.

### Disk full

Check what's free and what's big:

```bash
df -h ~ | tail -1
du -sh ~/Library/Developer/Xcode/DerivedData "$HOME/Library/Developer/Xcode/iOS DeviceSupport" ~/Library/Developer/CoreSimulator ~/Library/Caches/CocoaPods ~/.cargo/registry src-tauri/target mobile/ios/build 2>/dev/null
```

Safe to remove, because each is rebuilt or downloaded again when needed. Ask
the human before deleting anything outside this repo:

| What | How | Note |
| --- | --- | --- |
| Xcode's build caches | Delete `~/Library/Developer/Xcode/DerivedData` | Often the biggest |
| Support files for old iOS versions | Delete old folders in `~/Library/Developer/Xcode/iOS DeviceSupport` | Keep the one for the phone's current iOS |
| Unused simulators | `xcrun simctl delete unavailable` | Only simulators whose runtime is gone |
| CocoaPods' cache | `pod cache clean --all` | |
| pnpm's store | `pnpm store prune` | Only packages no project uses |
| This repo's build output | Delete `src-tauri/target` and `mobile/ios/build` | The next build takes the full time again |

Never delete `~/Library/Application Support/Mogbot/` or `~/ShipStudio/`:
those are the human's agents and projects. Beyond that, **System Settings →
General → Storage** shows what else is large (often Photos, Messages
attachments, old downloads); that's the human's call.

### Chrome extension not connected

1. The **Claude in Chrome** extension (https://claude.ai/chrome) is installed
   in the Chrome profile the agent should use (each profile needs its own
   install) and signed in with the **same Claude account** as Claude Code
   (`claude auth status` shows which). Claude Code signed in with an API key
   can't use it.
2. Chrome is open. Agents can't use a closed Chrome. If the agent asks you to
   bring a Chrome window to the front, do that and press Check again.
3. ⌘K → **Let agents use your browser…** says "On". If it offers Check again,
   press it after opening Chrome.
4. Step 17's terminal check passes (`HELPER_OK`). If not, run
   `claude --chrome` once and type `/chrome` to see the status.
5. The extension asked whether it may use the site: approve it in Chrome.
6. Only Claude Code agents can use Chrome. A Codex agent says so; ask the
   Chief to switch that agent to Claude Code if it needs the browser.

### Port already in use

- `Port 1420 is already in use` (`pnpm tauri dev`): another dev copy is
  running. Use `SHIPSTUDIO_DEV_PORT` (above), or find it with
  `lsof -i tcp:1420`.
- Port 8081 (Expo): `npx expo start --go --lan --port 8082`.
- The phone port 47463 belongs to the app; Ship Studio uses 47443, so both can run.

### The app "can't be opened" / "Apple could not verify…"

A copy built on this Mac shouldn't show this. A `.app` or `.dmg` copied from
someone else will. Open **System Settings → Privacy & Security**, scroll to
the message about Mogbot, click **Open Anyway**, and confirm with your
password. Or, if you trust where it came from:

```bash
xattr -dr com.apple.quarantine /Applications/Mogbot.app
```

### Agents don't answer / "no engine"

The engine isn't installed or signed in. Run the Step 10 checks. Sign in again
with `claude` or `codex login`, then quit and reopen the app. If the human's only
agent CLI is something else (Opencode, Cursor), Agents shows a "no engine"
panel: install Claude Code or Codex.

### "Mogbot wants to use your confidential information stored in … keychain"

The app keeps its phone-pairing key and agent secrets in the Keychain. A
locally built app has no developer signature, so after each rebuild macOS asks
again. **HUMAN:** *"macOS is asking whether Mogbot can use the Keychain.
Please type your Mac password and click Always Allow."* If you click Deny, the
Phone panel won't offer a pairing code ("unlock your Mac").

### Agents stop when I close the lid

The Mac has to be awake. Settings → Agents → keep this Mac on. Closing the
app stops agents too.

### Where the logs are

`~/Library/Logs/Mogbot/`. App data: `~/Library/Application Support/Mogbot/`.
Projects: `~/ShipStudio/` (shared with Ship Studio).
