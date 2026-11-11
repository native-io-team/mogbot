# Import and Remote Access reliability, 2026-11-10

Step 2 of the owner's onboarding order is "turn on Remote Access and import
your agents". This pass asked, for a non-technical user: does each piece work
first time, and when it doesn't, does it end in one plain line and the one
fix? Everything was tested with unit tests and the UI harness; **no Funnel
was enabled and no Tailscale setting was touched on any machine**, so every
Tailscale behaviour below is matched against Tailscale's own CLI messages and
config shapes, not observed live.

The structured states the onboarding screens render are documented in
[docs/remote-access.md](../remote-access.md), "Failure states".

## Remote Access enable

| Failure | Before | Now |
| --- | --- | --- |
| HTTPS certificates off in the tailnet | Raw CLI text: "Couldn't publish the link: Funnel not available; HTTPS must be enabled. See https://tailscale.com/s/https." | `httpsOff`: one line, "Open DNS settings" (admin console → DNS → Enable HTTPS), Try again. When the CLI offers its approval link (`/f/serve`), `httpsNeedsApproval` says it is HTTPS being allowed, not Funnel |
| Funnel not allowed by the tailnet's access controls (no `funnel` nodeAttr, no link offered) | Raw CLI text | `funnelNotAllowed`: "an admin adds the funnel attribute", Open Access controls |
| Funnel allowed but not on the port | Raw CLI text | `funnelPortNotAllowed` |
| Tailscale switched off (`BackendState: Stopped`) | "Open Tailscale and sign in" (wrong: they are signed in) | `tailscaleOff`: switch it on in the menu bar |
| Tailscale app not running (CLI can't reach the daemon) | "Sign in" (wrong) | `tailscaleNotRunning`: open Tailscale |
| Tailscale logged out | "Sign in" | unchanged, now `tailscaleSignedOut` |
| CLI exited zero but the config doesn't show our mount | "Waiting for Tailscale to confirm the link…" forever | an error line with Try again (`NOT_CONFIRMED`) |
| **The user already serves something tailnet-only on 443** (`tailscale serve 3000`) | **Turning remote access on made it public.** Funnel is per host:port, not per path, so `funnel --https=443 --set-path=/<slug>` set `AllowFunnel` for the whole of 443 | `choose_funnel_port` uses the first of 443 / 8443 / 10000 that is empty, already public or already ours; the link then carries `:8443` (`public_authority`, used by the copied link, the probe and screenshot links). None free: refused with `funnelPortsInUse` |
| Public DNS not published yet | already handled (watchdog, Ask Tailscale again) | now `publishing` / `publishStuck` |
| The reachability check can't reach the internet | "Not reachable from the internet yet: public DNS lookup failed: …" | `cantCheckFromHere`: this Mac seems offline |
| Something else answers at the address | raw | `notThisApp`: Ask Tailscale again |
| Link works, nobody connected | a spinner | `noAssistantYet`, Copy link |

`ever_connected` was checked: set by the first authenticated, non-probe
request, cleared on Replace link; our own reachability probe never sets it.
A client's `GET` (SSE) gets 405 and isn't counted; every client tested in the
code paths sends `initialize` by POST, which is.

The token copy (Rust only, excluded from clipboard history, cleared after
90 s) was unchanged and is fine.

## Connecting an assistant: what to paste where

The setup used to say "add a custom connector (it may say MCP)". It now has
exact steps per assistant (`assistantGuides`), checked against each
vendor's help pages on 2026-11-10:

- **Claude** (support.claude.com, "Getting started with custom connectors
  using remote MCP"): Customize → Connectors → + Add → Add custom connector;
  name; remote MCP server URL; Continue; Authentication **No sign in**; Add.
  Free has one custom connector. Team/Enterprise: an owner adds it. In a chat,
  + → Connectors. Claude must reach the server from Anthropic's IPs: Funnel
  is public, so fine.
- **ChatGPT** (OpenAI's developer-mode guide, help article 12584461, both
  quoted second-hand by search because the pages refused a fetch): Settings
  → Apps → Advanced settings → Developer mode; Create app; MCP server URL;
  **No authentication**; trust; Create; in a chat + → Developer mode. Some
  versions put the toggle under Settings → Security and login.
  **Unverified and important:** OpenAI's help says Plus/Pro may get only
  read/fetch tools, with full write access on Business/Enterprise/Edu. If so,
  a Plus user could connect but not call `message_agent` or
  `import_conversation`. Needs a live check with a Plus account.
- **Grok** (docs.x.ai/grok/connectors): grok.com/connectors → New Connector →
  Custom → server URL. Field names and auth choices aren't documented; Grok
  Bot itself is still unconfirmed.

Links to each vendor's settings page are shown only where the vendor
documents the URL (Grok); the Claude and ChatGPT URLs weren't confirmed, so
no button is offered for them.

## The import over the connector

Already strong (consent card, sealed interview, coverage that refuses
`finish` until every area is closed, review card with clashes, Replace
refused while that agent works, one Import at a time, survives restart).
What was broken:

| Failure | Before | Now |
| --- | --- | --- |
| The assistant stops calling back mid-interview (its chat turn ended, its tool call timed out) | The bar said "Importing from Grok" with nothing to do | After 3 quiet minutes (interview answered, nothing back): "Import from Grok · waiting on Grok", "Nothing from Grok for 4 min. In Grok, say “carry on with the import”." (`importQuietMinutes`, a once-a-minute clock in the bar) |
| 30 quiet minutes end it | Ended lazily, only when something next asked; **no line in the chat**, the bar kept showing a live import until an event, and the panel then said "**You** stopped the import" | A timer after each answer ends it on time, writes one line in the Chief's chat (`idle_line`) and tells every window; `endedBy: 'idle'`, and the panel says Grok went quiet. If the assistant comes back, it's told the import ended from silence and to start over after Start |
| Claude Code missing | the assistant was told; the user saw nothing | a line in the Chief's chat; `endedBy: 'unavailable'` |
| An interview answer fails | "The import interview didn't answer: <raw stderr>" | one line and the fix by cause: out of usage (refill or add an account), not signed in (Settings → Accounts & usage), took over 4 minutes (resent), couldn't start; the assistant is still asked to resend |
| Partial answers | already handled by coverage (`next_gap`, `finish` refused) | unchanged |
| Duplicate names | already handled ("Finance (from Grok)", confusables) | unchanged |
| Re-running import while one is live | already refused ("An import is already going. Stop it first") | unchanged |
| Importing while agents run | Replace of a working agent already refused | unchanged |

## Without Remote Access (export file or folder, pasted reply)

Tested in `agents/import_adversarial_tests.rs` (18 tests). Fixed:

- **A picked symlink bypassed the 4 MB cap** (its own size was checked, then
  the target, or `/dev/zero`, read whole). Picked files now go through a
  capped read and anything not a regular file is refused.
- Empty, binary, fake zip, fake or damaged `.tar.gz`, wrong extension, over
  4 MB, a broken `openbot-import.json` (raw serde text), deep nesting and a
  file that moved each now say what's wrong and the fix.
- Links inside a picked folder were never followed, but skipped silently;
  they're listed under "Not read".
- **The same export posted twice while its card is still up** made a second
  card, and importing both made "Finance" and "Finance (from Grok)". `post`
  now refuses: "This is already waiting for your review in <Chief>'s chat.
  Answer that card first …".
- Lookalike names in one export: the refusal says how to bring the second in.
- File and folder problems render like a pasted reply's: one line, the
  parser's lines behind "Show details".

Already fine and now covered: a 50 MB file refused in under 2 s; a 10k-file
folder within caps; a 2M+ character paste ("Paste it in parts"); truncated
JSON ("cut off … send that part again"); wrong types (where, review
blocked); prose around JSON; parts out of order or pasted twice merging
idempotently; case-only duplicate names merging; archive entries that climb
out skipped.

Each line the UI shows for these paths, word for word, is in commit
92e46db40's tests (`import_adversarial_tests.rs`).

## Not verified

- Any of it against a live Tailscale: Funnel on, HTTPS off, ACL without
  `funnel`, the 8443 fallback (Tailscale's acceptance of `--https=8443` for
  Funnel is documented, not observed here).
- The exact wording of current Tailscale CLI errors on the newest release
  (matched against the messages in `cmd/tailscale/cli` and `ipn` as known;
  an unrecognised message falls back to quoting it, `funnelFailed`).
- ChatGPT Plus/Pro calling write tools; Grok Bot custom connectors.
- The interview failure classifier against real Claude Code usage-limit and
  signed-out output (matched on the phrases the app already sees elsewhere).
