# The agent browser

Research and a working prototype, November 2026 (Chrome 156.0.8078.80, macOS
26, this Mac), then **v1, shipped behind the `agent-browser` cargo feature,
on by default** and a Settings → Agents switch, on by default. What v1 is and
what was verified: "v1" at the end. The user-facing design is
docs/agents.md, "The agents' browser".

**The question.** Claude in Chrome is mediocre, and Grok Bot has its own
computer with its own browser. Could agents get a real browser of their own on
the user's Mac, one the app controls directly and the user can watch and drive
from the phone? How realistic is it, what are the caveats, and how do we keep
it from being blocked?

## Verdict

**Go, with one scope change.** The control and streaming path works and
measures well. The idea of a "silver bullet" that never gets blocked is the
part that doesn't survive.

- **What works.** The user's own installed Chrome, started by the app with a
  persistent "Agents" profile and driven over a CDP pipe, is fast and
  reliable. Clicks and typing are real input events. On public sites, 15 of 18
  scripted tasks succeeded; all 3 failures were Google Search. The live view
  reaches about 98 fps locally, a tap or keystroke from a phone-style viewer
  lands in about 10 ms, and cookies survive a relaunch.
- **What doesn't.** Any browser that CDP drives tells every page
  `navigator.webdriver = true`; Chrome sets it itself for the pipe. Google
  Search answered that with its "unusual traffic" page 3 of 3 times, and
  passed 2 of 2 times on the same Mac when the flag was false. That is the
  blocking risk in one measurement. Sites that refuse automated browsers
  will refuse this one.
- **Where we stop.** We don't hide that flag. The masking switch, or a
  debugging-port quirk that avoids it, both make the block go away. Both
  disguise an automated browser as a person, which is evasion. The human
  moments (sign-in, a challenge, a site that refuses automation) go to a
  plain Chrome with no automation attached, which the person drives.
  Agents use the engine's own web search for search.
- **Two browsers, one rule.** The agent browser is the default. Claude in
  Chrome stays for work that needs the user's personal Chrome session.

Effort is about **3 to 4 engineer-weeks** to a shippable v1 on desk and phone
(breakdown at the end). Phone sign-in without a CDP-driven browser is another
1 to 2 weeks and needs two macOS permissions.

## What the prototype proved

Code: `src-tauri/src/agent_browser/` (`chrome.rs` holds the launch line,
`cdp.rs` the pipe, pages, input and window states, `viewer.rs` a phone
stand-in) and `src-tauri/examples/agent_browser_demo.rs`. Run it with:

```bash
cd src-tauri
cargo run --features agent-browser --example agent_browser_demo -- <scratch dir> demo|tabs|viewer|persist|sites
```

`scripts/agent-browser-flags.mjs` compares launch modes. Everything ran on a
throwaway profile or on `<scratch>/Agents`, muted, and signed in to nothing.

| Measured | Result |
| --- | --- |
| Launch to first CDP reply | 350–400 ms |
| Close (`Browser.close`) | ~100–200 ms |
| What a page sees (pipe) | real Chrome UA, brands `Google Chrome 156`, **`navigator.webdriver = true`** |
| Screenshot (`Page.captureScreenshot`) | 35–45 ms warm (~130–185 KB PNG, ~25 KB JPEG) |
| Screencast, a page repainting every frame | 98–100 fps at 800 and 1280 px wide, 2–6 KB per JPEG frame (q60) |
| Screencast, a still page | one frame per change (1 frame in 2 s on example.com) |
| Screencast latency (capture to receipt, same Mac) | within clock noise, under 10 ms |
| Keystroke to the next screencast frame | median 5 ms, max 21 ms (15/15 frames) |
| Three agent windows streaming at once | ~99 fps each |
| A tab behind another tab in the same window | `hidden`, 0 frames |
| Window minimized | `hidden`, screencast stops (1 frame in 3 s) |
| Screenshots polled while minimized | 30 per second, every one fresh (20/20 distinct) |
| Phone stand-in: tap on the viewer to the agent page's field | focused, 11–17 ms |
| Phone stand-in: viewer keys to the agent page | 5/5 applied, 7–17 ms each |
| Cookies after a relaunch of the Agents profile | same six github.com cookies before any navigation |
| Public tasks, window parked | **15/18**: example.com link 3/3, Wikipedia search 3/3, HN top story 3/3, DuckDuckGo search 3/3, GitHub Explore 3/3, **Google search 0/3 (unusual-traffic page)** |
| Same tasks, window minimized | 10/18: clicks on a hidden page miss, and an accessibility query hung once |
| Sign-in pages, loaded only (Google, Microsoft, LinkedIn, X) | all loaded normally, no warning on the page; the checks run after an identifier is submitted, which we didn't do |
| bot.sannysoft.com | every row passes except "WebDriver (New)" |
| Chrome process tree RSS | 1.3–1.5 GB with one tab, ~2.2 GB with four (summed RSS over-counts shared pages) |

### Launch modes compared on the same Mac and Chrome

| Mode | `navigator.webdriver` | Google search | sannysoft |
| --- | --- | --- | --- |
| `--remote-debugging-pipe` (Playwright's default too) | true | blocked 2/2 | fails "WebDriver" |
| `--remote-debugging-port=0` | true | blocked 2/2 | fails "WebDriver" |
| `--remote-debugging-port=<fixed>` | false | ok 2/2 | passes |
| pipe + `--disable-blink-features=AutomationControlled` | false | ok 2/2 | passes |

Chromium enables `AutomationControlled` for `--enable-automation`,
`--headless`, `--remote-debugging-pipe` and port 0
([runtime_features.cc](https://chromium.googlesource.com/chromium/src/+/main/content/child/runtime_features.cc)).
A fixed port escapes it only because of how that check is written. The
masking switch exists to hide the flag. We use neither (see "Where the line
is"). A fixed port has a second problem: an unauthenticated loopback port
lets any process on the Mac drive the browser and read every cookie in it.

### Hiding the window: what macOS allows

- **Off screen isn't possible.** `--window-position=-32000,-32000` became
  `left -1240, top 33`. macOS keeps 40 px of every window on a display. The
  best park is the bottom-right corner, with a 40 px corner showing.
- **Minimized stops the screencast** and makes interaction unreliable.
- **Overlapped or behind other windows is fine.** With
  `--disable-backgrounding-occluded-windows`, windows stacked on each other
  kept 99 fps.
- **Polled screenshots work even minimized**, so the phone can watch a
  minimized window at 5–10 fps. But an agent shouldn't act in one, given the
  10/18 result.
- **Design:** a parked, normal window per agent. It's in the Dock, its
  corner shows, and it comes forward on request.

## The options compared

| | (a) Installed Chrome, own profile, CDP pipe | (b) Playwright / Chrome for Testing | (c) WKWebView browser in the app | (d) Computer use (Codex / Anthropic) | (e) Claude in Chrome |
| --- | --- | --- | --- | --- | --- |
| **Click / type reliability** | High: real input events into the renderer, element targeting from the accessibility tree; 15/18, with the only failures being a site refusing automation | Same engine and same CDP, so the same reliability; adds auto-waiting | Mediocre: no input events, so synthetic DOM events via JS; `isTrusted` is false and many sites ignore them | Lowest: pixels in, pixels out; slow (a screenshot per step) and brittle on small targets | Good when the extension is connected; we've seen it disconnect, and only one profile at a time |
| **Streaming to phone** | `Page.startScreencast`: ~99 fps, pushes on paint; screenshot polling when hidden | Same | Snapshot API only, no frame stream | Whole-screen capture (needs Screen Recording); shows the user's desktop | None of ours; the extension's GIFs only |
| **How agents call it** | Our MCP server on the agent bridge, for **both Claude Code and Codex** | Same if we host it (Playwright MCP exists, but it's Node and its own profile) | Our MCP server | OpenAI's tool for Codex; Anthropic's computer-use tool is API-only, not Claude Code; two different stacks | Claude Code only (`--chrome`); **Codex never** |
| **Accounts / profiles** | One Agents profile (more later), cookies persist, the user signs in once | Same profile model, but **Chrome for Testing is a different browser**: no iCloud passkeys, it doesn't auto-update, and Google says it's for testing only | WebKit data store per agent; Google blocks sign-in in embedded webviews | The user's real browser, logged in as them | The user's real Chrome profiles |
| **Not getting blocked** | webdriver true (honest); Google Search blocks; sign-in done in plain mode (below) | Worse: pipe plus Playwright's own flags, a test build, and `--use-mock-keychain` | Worst for Google: embedded-webview sign-in is blocked by policy | Best: it *is* the user's browser, though it can be flagged by behaviour | Good: it's the user's browser, and an extension debugger doesn't set webdriver |
| **Resources** | One Chrome, ~0.3–0.5 GB per extra window (estimated; RSS over-counts) | Same, plus a bundled browser (~400 MB on disk) | Lightest | Takes over the user's screen | Lives in the user's Chrome |
| **Maintenance** | CDP is stable; we own ~1–2k lines of Rust; Chrome updates itself | Pinned versions to bump; a Node runtime | We'd build a browser: tabs, downloads, auth popups | Two vendors' tools, moving fast | Undocumented flag (`--claude-in-chrome-mcp`), extension state outside our control |
| **Watch from phone / take over** | Yes, both | Yes | Partly | Only by screen-sharing the whole Mac | No |

**Why (a).** It's the only option that is a real, signed, auto-updating Chrome
with its own persistent profile, that we fully control, that both engines can
use, and that streams to the phone. (b) gives the same control in a worse
browser. (d) is the fallback for non-web apps, not for the web. (e) is kept
for one case (below).

Sources for (b), (d) and (e):
- Chrome for Testing is "purely for browser automation and testing"
  ([developer.chrome.com/blog/chrome-for-testing](https://developer.chrome.com/blog/chrome-for-testing)).
- Chrome 136+ ignores remote-debugging switches on the default profile
  ([developer.chrome.com/blog/remote-debugging-port](https://developer.chrome.com/blog/remote-debugging-port)).
- Codex computer use: macOS, needs Screen Recording and Accessibility, and
  can use its own browser
  ([learn.chatgpt.com/docs/computer-use](https://learn.chatgpt.com/docs/computer-use)).
- Anthropic's computer-use tool advises a VM with no logins
  ([platform.claude.com docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
- Claude in Chrome went GA on 26 Aug 2026
  ([claude.com](https://claude.com/resources/articles/claude-in-chrome-generally-available)).
- Grok Bot runs "a computer of their own in the cloud", not on the user's Mac
  ([x.ai/news/introducing-grok-bot](https://x.ai/news/introducing-grok-bot)).
- Google's chrome-devtools-mcp `--autoConnect` (Chrome 144+) attaches to the
  user's own Chrome, with an Allow dialog each session
  ([developer.chrome.com](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)).

## Not getting blocked

### Where the line is

Legitimate: running a normal browser the user owns, driven honestly, with a
person doing the human parts.

- **We do:**
  - the real Google Chrome binary
  - a real headed window, never `--headless`
  - none of `--enable-automation`, `--user-agent` or `--no-sandbox`
  - Chrome's own UA and client hints
  - a stable persistent profile with real cookies
  - normal pacing
  - the person signing in, passing passkeys and 2FA, and answering
    challenges themselves
- **We don't:**
  - set `--disable-blink-features=AutomationControlled`
  - pick a debugging mode because it leaves `webdriver` false
  - patch `navigator` or fingerprint surfaces
  - add stealth plugins
  - solve or click CAPTCHAs and Turnstile for the user
  - rotate identities
  - automate the sign-in form

An agent that hits a challenge or a refusal stops and asks: "This site wants
a person. Take over?" The masking modes above were measured so this doc can
say what they do. They are not an option.

### Google

Google has blocked sign-in since 2020 from embedded frameworks and from
browsers that "provide automation features" or automate the sign-in clicks.
Browsers must identify themselves honestly
([Google Developers blog](https://developers.googleblog.com/guidance-to-developers-affected-by-our-effort-to-block-less-secure-browsers-and-applications/)).

- **Search** blocks a webdriver browser, as measured here. Agents use the
  engine's web search tool instead. Search's terms forbid automated queries
  anyway.
- **Sign-in** isn't measured: nothing was submitted. Given Search's
  behaviour and the policy above, expect "This browser or app may not be
  secure" from the CDP-driven browser. Current reports converge on one thing
  that works: sign in by hand in a normally launched Chrome on that profile,
  then attach automation later. Cookies carry over; we measured
  persistence across relaunches.
- **So sign-in is a mode, not a step.** "Sign in once" relaunches the Agents
  profile **with no debugging switch at all**. That is a plain Chrome window:
  `webdriver` false because nothing is automating it. The person signs in.
  When they close the window, or press Done, the app relaunches it in agent
  mode. Mid-task Google re-auth prompts take the same path.

### Microsoft, LinkedIn, X, Amazon

- All four sign-in or home pages loaded normally in agent mode.
- No current evidence on Microsoft account sign-in with CDP.
- LinkedIn fingerprints extensions and automation signals (vendor and press
  reports, not verified here). Expect LinkedIn to restrict accounts that act
  like bots, whatever the browser.
- The rule for all of them: sign in in plain mode. Agents then work at a
  human pace on read-mostly tasks, and stop on any challenge.

### Cloudflare Turnstile

- nowsecure.nl showed an interactive Turnstile in every mode, masked or not.
  Its own banner ("For testing only") says it uses a test sitekey that always
  asks, so it isn't diagnostic.
- Reported in Oct 2025: Turnstile caught every CDP framework through
  `screenX`/`screenY` on CDP clicks into iframes (crbug 40280325). A fix
  landed afterwards, but which release shipped it is unconfirmed
  ([webscraper.io](https://webscraper.io/blog/google-patches-100-precise-cloudflare-turnstile-bot-check)).
- Either way, a person answers a challenge. From the phone that means
  take-over mode.

### Passkeys and 2FA

- iCloud Keychain passkeys work in Chrome 118+ on macOS 13.5+, once the user
  allows Chrome to use them
  ([developer.chrome.com](https://developer.chrome.com/blog/passkeys-on-icloud-keychain)).
  It's an OS-level prompt, so it should appear in the Agents profile too
  (unverified). It needs the Mac, or the phone via the hybrid QR flow.
- Google Password Manager passkeys need the profile signed in to Chrome.
- Passkeys saved to a local profile die with the profile.
- 2FA codes and push approvals are the person's, done in plain mode.
- Never use `--use-mock-keychain` or `--password-store=basic` (Playwright's
  defaults). The Agents profile's cookies are encrypted with the real
  Keychain's Chrome Safe Storage key; no prompt was seen.

## Two browsers, routed per task

| Use | When |
| --- | --- |
| **Agent browser** (default) | Any site the agent can use with the Agents profile's logins; every Codex agent; anything streamed or taken over from the phone |
| **Claude in Chrome** | The user's *personal* Chrome session is the point: a site signed in only there, with no sign-in in the Agents profile and the user saying "use my Chrome", or a site that refuses automated browsers where the user has chosen to let agents act in their own browser |

**How it's decided.** `browser_profiles`' site → account memory grows a
`browser` field ("agents" or "chrome:<profile>"). The access chain checks in
order:

1. Is the site signed in in the Agents profile? Use the agent browser.
2. Is it signed in only in a connected personal Chrome? Offer both: one card,
   "Sign in once in the agents' browser" (recommended) or "Use my Chrome for
   this site".

The answer is remembered per site. **We never switch browsers silently
because one got blocked.** A refusal goes to the person.

## Design for shipping

### Shape

- **`agents/agent_browser/`**, a promotion of the prototype module, owns
  one Chrome process. It starts on first use, idles out after N minutes with
  no agent window, and relaunches in plain mode for sign-ins. The window
  title or profile name says "Agents".
- **The profile lives at `<app support>/agent-browser/Agents/`**, the app's
  own folder from `brand.json`. `chrome::profile_is_ours` refuses anything
  else, and above all the user's `~/Library/Application Support/Google/Chrome`.
- **One window per agent.** A background tab paints nothing, so each agent
  gets a window. Windows are parked in the corner and stacked; occlusion
  doesn't stop them painting. An agent's tabs live in its window. Two agents
  never share a tab. Closing an agent's last tab closes its window.

### The MCP server ("browser")

The MCP server runs on the existing agent bridge (`/mcp/browser` beside
`/mcp/agent`), with the same per-turn bearer secret (`agents/reach.rs`). The
caller is the agent, so tabs are scoped per agent. Claude Code and Codex
reach it the same way, which ends "Codex agents never get the browser".

The tools mirror Claude in Chrome's, so `browser_gate`'s rules carry over
nearly verbatim:
- `tabs`, `open`, `navigate`
- `read_page` (the accessibility tree, with refs: the prototype's
  `center_of_role` path)
- `find`, `get_text`, `screenshot`
- `click(ref | x,y)`, `type(ref, text)`, `press(key)`, `scroll`, `wait_for`
- `ask_person(reason)`, which raises the take-over card

No `evaluate` tool in v1. Arbitrary JS is the widest exfiltration path. If it
ships at all, it ships behind an always-a-card rule, like `javascript_tool`.

### Approvals

`browser_gate.rs` applies unchanged in meaning:
- Looking is free.
- Acting goes through unless the control's accessible name (from our own
  accessibility tree, which is *more* reliable than the extension's refs)
  is a send / post / pay / delete / share word, or Enter is pressed outside
  a search box, or the page is a checkout or compose page.
- Uploads and anything unknown always ask.
- Outside-text turns never get the browser.

The card shows a live screenshot of the target, which Claude in Chrome
couldn't give.

### Phone live view and remote input

- **Frames.**
  - A new companion method subscribes to an agent's window. Desktop and
    phone already speak `work.live`, so this would be a feature flag like
    `browser.live`.
  - The Mac runs the screencast while someone watches, ~2–6 KB JPEG frames.
    On cellular it caps the rate at 5–10 fps, with "latest frame wins"
    (never queued), like the hub's draft coalescing.
  - When the window is minimized or hidden, it polls screenshots instead.
  - Frames are never journaled.
- **Input.** Taps arrive as fractions of the frame and keys as single
  characters, as in `viewer.rs`. They are refused unless the phone holds
  the take-over claim for that agent: the same lock `agents/takeover.rs`
  uses, so an agent's turn and the person never type at once.
- **Sign-in from the phone.** CDP input from the phone still runs in a
  browser that says `webdriver` true, which is the case Google refuses. Two
  paths:
  - **v1:** "Finish on your Mac" for Google and Microsoft. Plain-mode sign-in
    at the desk, as `login_relay.rs` already does for providers that won't
    take the phone's redirect.
  - **v2 (1–2 weeks):** phone take-over of a *plain-mode* window. Frames come
    from ScreenCaptureKit window capture, input from CGEvents posted to that
    window, which is what Screen Sharing does. Needs Screen Recording and
    Accessibility permissions, an awake display, and the window on screen
    while in use.
  - The sign-in-from-phone work on the companion (OAuth sheet,
    device code) still covers every connector that has an API. The browser
    is the fallback for sites without one.

### One-time sign-in UX

- A login card's "Use the agents' browser" way in opens a plain-mode window
  at the site's sign-in page, titled for the service, and a **Done** button
  in the card.
- On Done, the app relaunches in agent mode and checks "signed in?"
  read-only, the way `access_check` already does.
- The site goes into site → account memory with the account name the page
  shows.
- "What it can reach" lists the Agents profile's sites with **Sign out**
  (clear that site's cookies) and **Forget**.

### Mac locked, asleep, display off

- **System sleep stops everything.** The existing keep-awake (Settings →
  Agents, `caffeinate`) covers it.
- **Display sleep or a locked screen: unverified.** Rendering continued for
  a minimized (fully hidden) window, which suggests a locked screen keeps
  working for CDP. Measure before promising it.
- **Plain-mode phone take-over** (ScreenCaptureKit and CGEvent) needs an
  unlocked, awake display, so the card says "Unlock your Mac to sign in".

### Security model

- **What it holds.** The Agents profile holds sessions for every site the
  person signed in to there. A process that can drive it can act as them on
  those sites.
- **Isolation.**
  - It's a separate profile folder in the app's own support directory,
    never the personal one. Chrome 136+ refuses debugging there anyway.
  - The pipe has no port, so no other local process can attach; the
    connection dies with the child.
  - No `evaluate` tool, and no extensions in the profile (refuse
    `--load-extension`; check `Extensions/` at launch).
  - Downloads go to a per-agent folder inside the agent's home.
- **Scope.** The site → account memory is the allowlist. At "Check with me
  often" only those sites open freely; at other levels navigation is free
  but anything that sends asks.
- **Prompt injection** is the real exposure, as with Claude in Chrome:
  - Page text can tell the agent to act. Cards on sends, deletes and
    shares stand against it.
  - Navigation that carries data out asks at "Check with me often"; at
    other levels it is an accepted gap.
  - Outside-text turns never get the browser.
  - Passwords are never typed by an agent.
  - New here: the person can watch any agent's window live and take over.
- **Clearing.** "Sign out of everything" deletes the profile.

## Effort

| Piece | Estimate |
| --- | --- |
| Promote the module: process lifecycle, plain/agent mode switch, window per agent, idle shutdown, crash recovery | 4–5 days |
| MCP server on the bridge (tools above), accessibility-tree refs, waits, downloads | 4–5 days |
| `browser_gate` adapted to our own refs, card screenshots, routing between the two browsers, site memory | 3 days |
| Login card way in, "What it can reach" rows, access_check | 2–3 days |
| Companion `browser.live`: frames, adaptive rate, take-over input, phone screen | 4–5 days |
| Tests, harness scenarios, docs | 2–3 days |
| **v1** | **~3–4 weeks** |
| v2: phone take-over of a plain-mode window (ScreenCaptureKit + CGEvent, permissions UX) | 1–2 weeks |

## Not verified

- **Sign-in** on Google, Microsoft and LinkedIn in either mode: nothing was
  submitted.
- **Rendering with the screen locked or the display asleep.**
- **Passkeys in the Agents profile.**
- **Real memory per extra window.** The RSS sums over-count.
- **Whether the Turnstile `screenX` fix has shipped.**
- **Behaviour over cellular.** The viewer was loopback only.
- **Windows.** The pipe code is unix-only; `chrome.rs` knows only the macOS
  path.

## v1

Shipped: `src-tauri/src/agent_browser/` (service, `browser` MCP server,
sign-in windows, the Google fallback), the agents' browser way in on login
cards, phone sign-in through it, Settings → Agents → Agents' browser.
Design for users and agents: docs/agents.md, "The agents' browser".

**Decisions kept from the research.** `--remote-debugging-pipe` only (no
port, no `--disable-blink-features=AutomationControlled`, never headless);
real Chrome; a profile of the app's own; one parked window per tab; no
script tool; the human does sign-ins and challenges. Google's refusal goes
to a plain window with no debugging switch, never to a disguised one.

**Run on this Mac, 2026-11-05** (`cargo run --example agent_browser_live --
<scratch>`: the shipped code against the installed Chrome, scratch profile,
public sites, nothing typed into a sign-in page, nothing submitted):

| Step | Result |
| --- | --- |
| Launch to first CDP reply | 306–329 ms |
| `open` example.com, `read_page`, `click` its link by ref | landed on iana.org, 612 ms |
| `screenshot` | 1280×773 at CSS size (first call ~2.9 s in a debug build) |
| Wikipedia: `find` "search" → `type` by ref → `press` Enter | landed on the Rust article |
| `open file://…`, `press cmd+w` | refused |
| Sign-in window, github.com/login and accounts.google.com | first screencast frame 12–17 ms, 780×471, 9–11 KB; read as a sign-in page; not a refusal |
| A tap on GitHub's form (picture → CSS mapping) | new frame; focused field read as secret (password) |
| The agent the card is for, during / after | refused / free |
| `macos::window_of` on the parked window | 1280×860 at the bottom right (x 1472, y 941) |
| `macos::capture` of that one window | 780×524, 55 KB, ~1.5 s in a debug build |
| `Browser.close` | Chrome exited, 0.4–3.2 s |

**Not run:** a real sign-in anywhere; Google's refusal page (detected from
its published words and URL; the identifier page loaded normally in the
driven window); plain-mode input (CGEvents would have moved this Mac's
cursor); the phone over Tailscale (the mobile screen was tested against the
mock Mac and in unit tests); window capture's rate in a release build.
