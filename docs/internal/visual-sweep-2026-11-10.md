# Visual regression sweep, 2026-11-10

A full pass over desk and phone after the day's ~25 merges (onboarding redesign, the agents
sidebar foot, usage wording, shadows, connection bar states, remote access screens, chat
spacing), on `mogbot/foundation` at ee0961d94.

**How it was looked at.**

- Desk: `pnpm harness` on port 1475 with its own `TMPDIR`; every scenario in both themes
  (`--theme light` and `--theme dark`), run as one `harness-capture.mjs <prefix>` per scenario
  prefix (52 chunks) plus `--commands`, because two full `--all` runs were each killed partway
  (exit 144) by something outside the run. Every `report.json` was aggregated for failures,
  unmocked commands, console errors and cut-off text; contact sheets of every chunk, full-size
  crops where anything looked off.
- Two probes the harness doesn't have, run in the harness against every agents scenario
  (and the rest for the second): (1) every reply's hover actions forced visible, then measured
  against what follows them; (2) any element with `overflow-x: auto|scroll` whose content is
  wider than it, and the document itself. The capture Chrome runs with `--hide-scrollbars`, so a
  stray scrollbar can't be seen in a screenshot at all; the second probe stands in for that.
- A third probe for the owner's report: every "What it did" fold, its gap to the box above it
  and whether its label wraps.
- Phone: `cd mobile && pnpm qa:web --web-port 8175 --mock-port 47575 --cdp-port 9775`, the full
  list, light and dark (645 shots), its report read for console failures and cut-off text.

**Tests:** `pnpm test:run` (4825), `pnpm typecheck`, `pnpm check:patterns` (after
`pnpm tokens:inventory`), mobile `jest` (1164) and `tsc`, all passing.

**Not checked:** WKWebView and a native phone build (Chrome and react-native-web stand in);
hover and focus states other than the reply actions; the Dock and tray menus.

---

## Fixed here

### 1. "What it did" under a card sat on the card's bottom edge and wrapped (owner's report)

**Where.** Under a result card, a failure card or a reply drawn as blocks: "› Worked 14 min ·
24 steps · edited 2 files" 4px under the card's rounded bottom, and wrapped to two lines
("edited / 2 files") beside what it ran on ("Claude Code · …").

**Why.** The fold's head keeps the 2px a line of prose needs (its leading supplies the rest),
inside a card row that is a column with a 2px gap: 4px under a box edge and its shadow. Beside
it, `.agent-work__ran-on` and the summary toggle both shrank at the same rate, so the summary
wrapped while there was room.

**Fix.** Under a card row (and a blocks reply) the head keeps `--spacing-md`; an earlier
version folded to one line is prose and keeps the small gap. The summary is one nowrap label
(`.agent-work__head-label`) that ellipsises only when the column can't hold it alone; what it
ran on gives way first. Measured over every scenario with a fold: 14px under a card, 6px under
prose, one line everywhere. `aa9acc990`.


### 2. A reply's Copy, pin and time sat on whatever followed it (hover)

**Where.** Any reply followed by another paragraph of the same answer, a card, or the Chief's
starters ("Brief me every morning" …): hovered, the actions overlapped the next line's first
words, the card's top edge, or the chips. Twenty-three agents scenarios hit it.

**Why.** A reply hangs its actions in a control-height (20px) room under it and gives the
room back with a negative margin, but the next paragraph starts 16px below, a card 16px (its
ring 4px inside that) and the starters 12px. The 13:47 fix covered the working line only.

**Fix.** Whatever follows a reply with actions starts `button-height-compact + spacing-xs`
below it: 4px clear in every case. Consecutive paragraphs of one answer now sit 24px apart
instead of 16; the starters 24px under the greeting instead of 12. `40612fae9`.

### 3. A failure card's Copy and time never showed

**Where.** Under any failure card ("Claude Code is signed out.", "Didn't finish").

**Why.** They were placed at `top: 100%`, past the row's own box, which the history's paint
containment (`content-visibility: auto`) clips. Forced visible, nothing drew. Where the row
wasn't contained, they would have landed 8px into the next line.

**Fix.** They hang just under the card inside the row's shadow room, and what follows clears
them the same way as under a reply. `40612fae9`.

### 4. A routine's "Run it in" heading drew as body text, off the items' edge

**Where.** Routines popover → a routine's … menu, with more than one conversation.

**Why.** The heading used the model menu's heading class, which is scoped to
`.agent-model-menu`; the routine menu didn't carry it. **Fix.** The menu does now. `86d2bd830`.

### 5. Harness: stale selectors, a race, a missing fixture

- `agents-engine-unavailable`, `agents-engine-one`, `agents-describe-drafted` and two describe
  probes clicked the Projects sidebar's `.workspace-sidebar-add-project` to open New agent;
  New agent is its own split key in the agents foot now (`.agents-list__new`). `b3924c9b4`.
- `settings-agents-quiet-off` (and the clip of `settings-agents-quiet` and
  `settings-agents-brief`) looked for quiet hours in "What notifies you"; quiet hours and the
  brief have their own group now. `7f2358b9a`.
- A scenario that opens a project and then runs a palette command (`branches-many`,
  `conflicts`, `prs-open`, `gitlab-branches-tab`, `gitlab-branches-menu`) failed with "no such
  palette command": the registry's first quiet spell came before the workspace mounted and
  registered its commands. The harness now waits for the command (up to 15s). The light
  `--commands` sweep went from 39 ids "not found in the registry" to none. `d3b2ceba6`.
- `window.new` had no `open_new_window` fixture. `bd9aeeef3`.

---

## Looked at and left (false positives and deliberate choices)

- **The whole sweep's other "cut off" text.** Sidebar previews, board and team lines, search
  snippets, attachment names, remote link (masked on purpose), the routine row's
  `.agent-schedule__when` (a 2-line clamp whose box is 1px short of its scroll height: nothing
  visible is cut), the sidebar foot at its narrowest 150px (`agents-foot-narrow`: ellipsis is the
  scenario's stated intent). Phone: list rows and composer placeholders ellipsise by design.
- **No horizontal scrollers** anywhere on the desk (probe over all 662 scenarios), and no
  overlaps outside the reply actions fixed above.
- **Workspace terminals say "Error starting Claude: Cannot read properties of null (reading
  'buffer')"** in every project scenario: the harness has no PTY.
- **Console errors** in `onboarding-status-failed` (the scenario is a failed check),
  `agents-column-preview` (no preview proxy), workspace scenarios (no package.json, no Nerd
  Fonts in the harness), `agents-dictating` (a Tauri callback the harness drops).
- **"Unstable" captures** (`agents-work-live*`, `agents-takeover-working`, `agents-live-output`,
  `phone-code*`, `onboarding-phone-scan`): a spinner, a live clock or a QR that changes per
  render. Not a layout jump.
- **Failures that passed on a rerun:** `mode-toggle-workspace`, `mode-toggle-compact-workspace`,
  `usage-reset-soon`, `dashboard-cards-collapsed`, `dev-server-consent-new`, `layout-three-docked`,
  `layout-agent-elements-stacked`, `migration-interrupted`, `preview-error-to-agent`,
  `workspace-project-agents`, `agents.groups.project`, and one screenshot timeout in dark
  onboarding: load (four headless Chromes and a phone run at once), not the app.
- **Phone, web artifacts:** the tab pill over the top of each list (it covers
  `firstrun-projects`' one-line "No projects" note, and the offline bar on Agents), the
  browser's blue focus outline on the composer, Catch up's header scrolled up on its last card.
- **Deliberate:** "Allow" on a production push is the danger style with its warning icon;
  App Store is the outline button and Google Play the quiet one under the phone's Tailscale step
  (the phone app ships to iPhone first); the Projects home's collapsed rail keeps a filled
  Settings key (the flat one is the agents foot's, by today's change); an agent's own colour on
  "on" switches (the accent means "this is on").

## Open

- **`show-checkpoint` on the phone** (`qa:web`) never found "Moss & Co. refresh · v1 · earlier
  version" to scroll to, in both themes, though the line is drawn in `chat-design-*-p1`. Either
  the step's exact-text match or its scroller; not traced.
- **"Work is out"** as the all-accounts headline in `settings-agents-accounts`, when the only
  account read is at 100%: reads like a sentence about work, not the account named Work. Copy,
  not layout; left for whoever owns usage wording.
- **Dark `--commands` sweep** still listed four branch commands as not found (it ran with the
  harness wait only partly in place); the light sweep after it was clean. Not rerun in dark.
- Hover states other than the reply actions were not forced; the probe covers only those.
