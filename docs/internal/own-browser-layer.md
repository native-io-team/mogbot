# Your Chrome: our own browser layer (and computer use next)

**Status:** first version, built and checked end to end in a real Google
Chrome 156 on a scratch profile (below). Off by default. Not yet on the Web
Store; added unpacked until it is.

## Why

Agents reach the user's real, signed-in Chrome today only through Claude in
Chrome (`claude --chrome`, `mcp__claude-in-chrome__*`). That ties the
browser to a claude.ai account signed in to both Claude Code and the
extension, and Codex agents never get it. The owner's direction: a middle
layer every engine and every account reaches through our own MCP, then our
own browser and computer-use layers on it.

"Your Chrome" is that layer for the browser: the app's own Chrome extension,
connected to the running app, exposed on the existing agent bridge to every
turn, Claude Code and Codex alike.

## Shape

```text
 agent turn (Claude Code / Codex, any account)
   │ MCP over HTTP, bearer = the turn's secret (agents/reach.rs)
   ▼
 agent bridge  /mcp/user-chrome          (loopback; 404 unless switched on)
   │ user_chrome::tools: the gate (browser_gate), refs, page logic (PageCdp)
   ▼
 link: Unix socket in the app's folder (user_chrome::link), 0600 in 0700
   ▲ handshake: HMAC proofs both ways over a per-launch token
   │
 native host = the app's own binary, started by Chrome (user_chrome::host)
   ▲ Chrome native messaging (stdio, 4-byte length + JSON)
   │
 extension (chrome-extension/extension, MV3)
   │ chrome.tabs / tabGroups: the agent's own tabs in its own group
   │ chrome.debugger: 13 allow-listed CDP commands, the app's own expressions
   ▼
 the user's Chrome, signed in as them
```

### Rust (`src-tauri/src/user_chrome/`)

| Module | Owns |
|---|---|
| `protocol` | Typed, versioned messages (`PROTOCOL = 1`). Handshake; `FromExtension` (hello, res, event); `ToExtension` (welcome, req, bye, unavailable); `Op` (ping, tabs_list, tabs_open, tab_get, tab_close, tab_focus, release, cdp); `ErrorCode` with `#[serde(other)]` for codes from a newer extension. |
| `frame` | Chrome's native-messaging framing on both legs; Chrome's limits (1 MiB to Chrome, 64 MiB from it). |
| `auth` | The extension ids allowed (dev id fixed by the manifest key; Web Store id from `brand.json`), the token file, nonces and proofs. |
| `link` | The socket (stale one replaced, live one never stolen, peer uid checked), the handshake, one `Conn` per Chrome profile (a reconnecting profile replaces its old link), blocking `call` with timeouts, events to the tools. |
| `host` | The native host: refuses any other origin, tells the extension `app_not_running` when the app is away, then relays frames unchanged. `main.rs` runs it before anything else when argv[1] is `chrome-extension://…`, so there is no extra binary to ship or sign. |
| `install` | The host manifest (`<Chrome user data>/NativeMessagingHosts/<identifier>.chrome_link.json`), staging the extension into the app's data folder for Load unpacked, the External Extensions file once listed. |
| `tools` | The `user_chrome` MCP server: the agents' browser's 13 tools with identical names and schemas (a test holds them equal), plus `hover`, `browsers`, `use_browser`. Per-agent tab ownership, refs, the gate, cards. |
| `settings` | `user-chrome.json`, **off** by default. |

`agent_browser/page.rs` (new) is the page logic both browsers share:
`PageCdp` has one required method, `cdp(method, params)`; navigate, settle,
text, focused field, ref centre, password check, click, hover, keys, wheel,
viewport and screenshot are written once. The agents' browser's `Service`
delegates to it; the extension answers the same calls. `METHODS` and
`EXPRESSIONS` list everything it sends, and the extension refuses anything
else (tests hold `cdp.js` to both lists).

### Extension (`chrome-extension/extension/`, MV3, no build step)

| File | Owns |
|---|---|
| `protocol.js` | The JS half of the protocol; Rust tests check its version, ops and codes. |
| `link.js` | One native port; hello; states (`connecting`, `connected`, `app_not_running`, `no_host`, `update_needed`, `refused`, `stopped`); backoff 1/2/5/10/30 s while awake, then a one-minute alarm. An open native port keeps an MV3 service worker alive; the alarm restarts one Chrome stopped. Stale ports (replaced) are ignored. |
| `tabs.js` | Which tab is whose (`storage.session`, so a restarted worker still knows), the agents' window (unfocused, normal), a tab group per agent with its name, waiting for the first load before anything attaches, events (`tab_closed`, `tab_updated`). |
| `cdp.js` | `chrome.debugger` with the allow-list; `Runtime.evaluate` narrowed to the app's expressions and `returnByValue`; `Page.navigate` to http(s) only; protected pages refused; the user's Cancel on Chrome's debugging bar pauses all driving for five minutes. |
| `ops.js`, `service_worker.js` | Op dispatch; top-level listeners; the badge. |
| `popup.*` | One line of state, the profile's name (shown to agents by `browsers`), Try again. |

Permissions: `nativeMessaging debugger tabs tabGroups storage alarms`. No host
permissions, no content scripts.

## Trust

- **Only our extension starts the host**: the host manifest's
  `allowed_origins` names only our ids, and the host checks Chrome's origin
  argument again.
- **The app proves itself first**: HMAC-SHA256 over both nonces with a
  per-direction label, token from a 0600 file in a 0700 folder, rewritten
  each time the link starts. A process squatting on the socket can't pass;
  a host without the token learns nothing. The extension never holds the
  token.
- **Never on the network**: a Unix socket, not a port. No web page can reach
  it (no DNS rebinding, no `fetch` to localhost). Debug builds may move it
  with `DASHBOT_CHROME_LINK_DIR`; release builds ignore that variable, so
  nothing in Chrome's environment can point a real host elsewhere.
- **Per turn**: the bridge's route takes the turn's bearer secret as every
  other agent route does (`agents/reach.rs`), and answers 404 while the
  switch is off.
- **Same-user code is out of scope**, as for the rest of the app (Keychain
  items, the bridge token): a process running as the user can read the token
  file. Said plainly rather than implied away.
- **Second wall in the extension**: an agent's request reaches only tabs that
  agent opened there, only allow-listed CDP methods, only the app's own
  expressions. A compromised app link still can't run arbitrary script or
  read the user's other tabs.

## Approvals: browser_gate, unchanged

`mcp__user_chrome__*` is judged exactly as a Claude in Chrome call is: each
tool maps to its Claude in Chrome equivalent (`agents_equivalent`, extended
with `hover`, `browsers`, `use_browser`) and `decide` rules it, so looking is
free at "Use good judgement" and "Go hard", a click whose accessible name is
a send word asks, Enter outside a search box asks, checkout/payment pages
ask, password fields are refused, "Check with me often" asks for every
interaction, and an unknown tool asks. The exact-text rule (`outward`), plan
grants (`plan_grant`), Full send's summary, the "Enter into a box nobody
named" redirect and the phone sign-in pause all apply (`is_own_browser`,
`own_page_key`). Turns answering outside text get no server and the gate
refuses anyway. A card is the agents'-browser card with Claude in Chrome's
words ("in your Chrome"). The extension adds what Chrome itself shows: the
"started debugging this browser" bar, whose Cancel stops agents.

**Who gets it** (`user_chrome::for_turn`): the switch on, a Chrome connected
right now, the agent's own browser grant (`reach.browser_off`) and its
settings' browser rule, and never outside text. Either engine. When a turn
gets it, the same turn runs `--no-chrome` (one way into one Chrome per turn),
and its prompt says to use `mcp__user_chrome__*` wherever it's told to use
Claude in Chrome, so every existing prompt and access-chain step carries over.
`browser::for_turn` is now "has the user's Chrome by any route";
`claude_in_chrome_for_turn` is the old meaning.

## Why not CDP on the user's Chrome

Chrome 136+ refuses `--remote-debugging-port`/`-pipe` on the default user
data directory (to stop cookie theft by infostealers): a debugging port only
works with a non-default `--user-data-dir`, which is a different, signed-out
profile. A debugging port is also reachable by any local process. And Chrome
137+ (branded) ignores `--load-extension`. An extension the user installs,
using `chrome.debugger` on tabs it opened, is the supported way to drive the
signed-in profile, which is what Claude in Chrome does too.

## Distribution

1. **Now (dev, and until the listing exists)**: Settings → Agents → Your
   Chrome → on. The app writes the host manifest into the user's Chrome,
   stages the extension in its data folder, and the row offers "Open
   Chrome's extensions" and "Show the folder": Developer mode → Load
   unpacked → that folder. The id is fixed by the manifest's `key`
   (`acpipahophpoekcmokoejnkooedofagk`), so the host manifest matches it.
2. **Web Store**: `pnpm package:extension` builds the zip without `key`;
   `chrome-extension/store/` has the listing text, the single purpose, the
   permission justifications and the data-use answers. Once listed, put its
   id in `brand.json` → `chromeExtension.webStoreId`: the host then allows
   both ids, and the row's button writes `External Extensions/<id>.json`
   (Chrome offers "Enable" on its next start; macOS Chrome honours this only
   for Web Store ids) and opens the listing.
3. **Managed Macs**: `ExtensionInstallForcelist` with the Web Store id, and
   the host manifest under `/Library/Google/Chrome/NativeMessagingHosts`.
   Not built; noted for teams.

## Matching Claude in Chrome

| Claude in Chrome | Here |
|---|---|
| tabs_context / tabs_create / navigate | `tabs`, `open`, `navigate` (back/forward) |
| read_page / find / get_page_text | `read_page`, `find`, `get_text` (same refs as the agents' browser) |
| computer: click, type, key, scroll, screenshot, hover, wait | `click`, `type`, `press`, `scroll`, `screenshot`, `hover`, `wait_for` |
| form_input | `type` by ref |
| list/select/switch_browser | `browsers`, `use_browser` (one connection per profile, named in the popup) |
| tab groups | yes, one per agent, in an agents' window |
| javascript_tool, file_upload, upload_image, gif_creator, shortcuts | deliberately not offered (arbitrary script and uploads are the widest ways out; the gate would ask for every one anyway) |
| read_console_messages / read_network_requests | not yet; would need `Runtime.enable`/`Network.enable` relayed and buffered in the extension |

## Computer use, next, on the same bridge

Same pattern, different reach: a `computer` MCP server on the bridge,
answered by the app itself (no extension), for any engine.

- **See**: ScreenCaptureKit (`SCScreenshotManager`) per display or per
  window, behind Screen Recording permission (the agents' browser already
  walks the user through it, `agent_browser/macos.rs`).
- **Act**: `CGEvent` mouse and keyboard, behind Accessibility permission;
  the accessibility tree (`AXUIElement`) for refs, so the gate can name the
  control as it does in the browser.
- **Approvals**: every action through a card, below Full send; app-level
  allow-lists (`computer_apps`), the same send-word rules on AX names, and a
  hard floor (Terminal, System Settings, password fields, Keychain Access).
  The app shows a persistent "an agent is using your Mac" bar with Stop.
- Not started.

## Verified vs assumed

**Verified on this Mac (Chrome 156.0.8078.80, macOS 26)** by
`src-tauri/examples/user_chrome_e2e.rs`, headful, on a scratch
`--user-data-dir`, scratch `HOME` and scratch link folder, the extension
loaded with `Extensions.loadUnpacked` over a debugging pipe (the only way
branded Chrome 137+ loads one from the command line):

- Chrome looks for native hosts in `<user-data-dir>/NativeMessagingHosts`
  (so the check never touches the real Chrome's folder).
- The extension loads with the fixed dev id; it starts the host, the host
  passes the handshake, the extension is connected 0.4 s after load.
- Through the same MCP dispatch the bridge uses, as a **Codex** agent:
  `tabs`, `open` a local page (tab group, agents' window), `get_text`,
  `read_page` refs, `find`, `type` by ref, `click` a plain button (trusted
  input changed the page), `click` "Send" asks (refused with no one to ask),
  typing into a password field refused, `screenshot`, `scroll`, a `file://`
  open asks, no script tool, another agent can't read the tab, `close_tab`.
- The app quitting (`bye quit`) and coming back with a new token: the
  extension reconnects on its own (27 s: the slow end of the backoff).
  The app closing a link also ends its socket, so the host exits and
  Chrome's port closes (a first version left the port open; the check
  caught it).
- Chrome closing: the link drops the connection.

**Unit tests**: framing, proofs, handshake refusals (wrong token, wrong
origin, old/new protocol, malformed nonce), replacement, timeouts, stale vs
live socket, relay both ways, tool shapes and gate decisions, the drift
checks between Rust and the extension (`cargo test --lib user_chrome`);
the extension's modules against a stand-in `chrome` (`pnpm test:extension`).

**Not verified**:

- Inside the built `.app` (host mode of the real binary started by Chrome
  from `/Applications`; the resource copy of the extension folder). The
  e2e used the `user_chrome_host` example, which runs the same function.
- On the owner's real Chrome profile (deliberately never touched), with
  real signed-in sites, multiple real profiles, or the Web Store build.
- A real Claude Code or Codex turn using the tools end to end (the dispatch
  is the bridge's; the turn wiring is unit-tested, not run).
- A card shown and allowed in the app (the e2e has no app to ask).
- The wheel `scroll` with a ref in a window Chrome considers hidden: it can
  wait for a paint that never comes; page scrolling avoids the wheel for
  that reason.
- MV3 worker eviction over long idle periods with the port open.

**Dev environment notes**: a native host binary under `~/Desktop` (or
Documents) waits silently on macOS's folder-access prompt with Chrome as the
responsible app; the e2e copies the host to scratch. A scratch `HOME` needs
`--use-mock-keychain` or Chrome stalls every request waiting for its Safe
Storage key.

## Effort to production

About 1-2 weeks: a bundle build and a run of the real `.app` as host;
the Web Store listing and review (permissions `debugger` + `nativeMessaging`
get scrutiny: days to weeks); first-run onboarding row and "What it can
reach" wording per agent; console/network reads if wanted; a live card test
in the app with both engines; docs/agents.md "Your browser" folded in once
it's the default over Claude in Chrome. Computer use is a separate 2-3 week
piece on the same bridge.
