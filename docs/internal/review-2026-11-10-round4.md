# Adversarial review, round 4, 2026-11-10

The fourth harsh read of `mogbot/foundation` (1471a598b), after: the Usage overview and per-account
pages, the chat header in the centred column, page titles (Usage, Routines), the Routines overview
with Pause/Resume all, sidebar groups, "What it was told" and "Show exact command", the account and
model per turn, the icon pack picker and 14 colourways with the Mogbot mark, glowing key states, the
accessibility fixes, Workflows and the Inbox removed, the model menu in plain words, the glossary
pass, failure wording and the conversation switcher. Rounds 1–3 are `review-2026-11-09*.md`;
nothing fixed there is re-reported.

**How it was looked at.** `pnpm harness` on port 2437 with its own `TMPDIR`; every scenario captured
light and dark at 1280×900 and 1600×900 (`HARNESS_WIDTH`), four runs (1600 light/dark and 1280
dark complete, ~555 each; 1280 light stalled at 301 and was not re-run whole), plus the ⌘K
`--commands` sweep at 1280 light (147, one flagged). Failures were re-run singly: the ten in #3 were
real; `agents-room-members`, `usage-near-empty` and `gitlab-branches-tab` failed once under the load
of five parallel Chromes and pass alone. Ids are harness scenario ids. Judged as a design lead (Linear / Things bar) and
as someone opening the app for the first time.

**Not checked:** the Tauri build in WKWebView; VoiceOver; the phone (no `qa:web` run this round);
the CPU cost of the glowing keys; keyboard order by hand beyond what the scenarios drive.

Ranked worst first. Each: scenario, file:line, what's wrong, the fix. "Fixed here" items carry
tests; the rest are left.

---

## 1. Usage said "Out of usage" when one account was out and three were never read (fixed here)

**Where.** `settings-agents-accounts`, `settings-agents-page`. `companion-protocol/usageGlance.ts`
(`rowWords`, the headline branch, `lowEngines`).

**What was wrong.** One account read at 0%, three not read yet: the hero said **"Out of usage"** at
display size and the notice under it **"Every account is out of usage."** with Add an account, while
the first row said "In use · Not read yet". The app was asserting something it didn't know — the
"Never assume data" rule, on the screen people open when they're worried about limits.

**Fixed.** Out everywhere only when every counted account was read; otherwise it names the one
that's out ("Work is out", "2 accounts are out"), and the "every account" notice only fires for an
engine whose accounts were all read. Test in `usageGlance.test.ts`. The phone shares the module, so
it gets the same words (its own test suite not run here).

## 2. Usage and Routines had no way out in a compact window (fixed here)

**Where.** New `agents-desk-routines-compact`. `AgentsView.tsx:1066-1072` (before),
`AgentsUsageView.tsx`, `AgentsRoutinesView.tsx`.

**What was wrong.** Below 750px there's no sidebar; What's in flight and every chat put the mode
toggle and the agent switcher in their header, but the two new pages rendered a bare title. Opened
from ⌘K in a narrow window, the only way back was ⌘K again.

**Fixed.** One `AgentsPageHeader` (putty key + name; in compact, the mode toggle and the switcher)
used by What's in flight, Usage and Routines, so the three page titles can no longer drift apart.

## 3. Eight harness scenarios were capturing the wrong screen (fixed here)

**Where.** `settings-agents-accounts`, `settings-agents-accounts-two-claude`, `settings-agents-page`,
`settings-agents-usage*` (4), `agents-heavy-settings` required `.usage-panel .usage-key`, a class the
Usage redesign removed; `settings-agents-defaults-menu` clicked a palette option "Engine and model"
the glossary pass renamed; `agents-header-crowded-700` clicked a sidebar row that doesn't exist below
750px. All failed in every run (light, dark, 1280, 1600), which is how #1 went unseen.

**Fixed.** `requires` is `.usage-row`; the palette step clicks "What new agents run on"; the 700px
header picks Acme from the header switcher. All pass. **Still stale:** the captions of the eight
Usage-in-Settings scenarios describe "key cards with grips" and "Get the most from your limits",
which are gone (`agentsUsage.ts:607-680`, `agentsDesktop.ts:515-640`, `agentsHeavy.ts:575`).
Rewrite them from a fresh capture.

## 4. "What it did" under the hood: every step carries a link, and two say the wrong thing

**Where.** `agents-desk-ran-on`, `agents-desk-briefing`. `AgentWork.tsx:118`,
`AgentWorkDetail.tsx`.

- **Fixed here:** a read or an edit said "Show exact command"; now "Show details" (only a command
  step says "command"). Test in `AgentWorkDetail.test.tsx`.
- **Left:** four steps → four underlined links, doubling the timeline's height. Show the disclosure
  on the step's hover / focus-within, or make the step's own label the toggle (a chevron at its
  trailing edge, as the folded "Worked …" line has). `agents-work.css:497`.
- **Left:** after the steps, "Edited pricing.css" (the files line) and "What it was told" sit at the
  steps' text edge with no icon and no time, so they read as two more steps. Give them a hairline
  above and the muted ink of a footer; "What it was told" wants a chevron or the TextButton
  underline at full strength.
- **Left:** the ran-on line prints the raw model id ("claude-opus-4-6") one click from a Model menu
  that only says Smartest / Balanced / Fastest. Say "Opus" (the menu's own detail word) and keep the
  id in the tooltip. `AgentWorkDetail.tsx:30`, `agentDesk.ts:23`.
- **Left:** Copy under a command is an icon *and* an underlined word. One of the two.

## 5. "What it was told" dialog: body flush on the dialog's border (fixed here), native disclosure

**Where.** `agents-desk-briefing`. `agents-work.css:550-590`, `AgentWorkDetail.tsx:186-207`.

**Fixed here:** the body had no padding (the date line and every section started on the dialog's
left border, 46px left of the title); it now sits on the header's edges. The sections were set in
the code face in a recessed box; a briefing is prose, so the reading face at body size. "(CLAUDE.md)"
dropped from "Its instructions and memory" (wrong for a Codex agent, and a file name).

**Left:** the sections use the browser's black ▶ triangles. Use the app's chevron (`ChevronIcon`,
rotated when open) and `list-style: none` on `summary`, as the rest of the app's disclosures do.

## 6. Routines overview (fixed here, mostly)

**Where.** `agents-desk-routines`. `AgentsRoutinesView.tsx`, `agentDesk.ts`, `agents-routines.css`,
`agents.css`.

**Fixed here:**
- "next Today 8:04 PM · last: Ran" mid-line capitals: now "next today at 8:04 PM · last: ran"
  (`routineLine`, tested).
- "across 1 agents": one agent says "for Finance" (`routineCountLine`, tested).
- Resume all… was enabled with nothing paused (Pause all was already disabled with nothing on).
- The confirm card's Cancel / Pause all sat at its leading edge 4px apart; every other card answers
  at the trailing edge, 8px apart.
- The scenario promised "the sidebar's Routines row is marked current" and it wasn't: it now wears
  the selected fill, like the agent rows and the Usage row.

**Left:**
- The sidebar puts a page (Routines) between two create actions (New agent, New room), while the
  other page (Usage) lives in the footer. Pages together, actions together: Routines beside Usage in
  the footer, or both under the list as one "Routines · Usage" pair. `AgentsSidebar.tsx:443`.
- "Routines" also labels the header button that opens *this agent's* routines popover, which reads
  "3 scheduled" when it has some (`agents-model-menu`). Same word, two scopes, two labels. Call the
  header one "Scheduled" always (the count beside it), and keep "Routines" for the page.
- Agent names are underlined links at rest in every row: five underlines in a column. The key is
  already the agent; make the key + name the link with no underline until hover.
- The fixture shows "Every Monday, Wednesday and Friday at 8:30 AM · next today at 8:14 PM": the
  next run doesn't match the rule. Harness only (`routinesCommands` builds `nextAt` from now).

## 7. Page titles wear an agent key

**Where.** `agents-team-overview`, `agents-desk-routines`, `usage-two`. `AgentsPageHeader.tsx`.

The key is the app's identity system for *agents* ("every agent is a physical keycap",
`agent-keys.md`). What's in flight, Usage and Routines now wear a putty key at the same 30px size and
position as an agent's, so a first-time user reads "Usage" as an agent called Usage (it even sits in
the agent switcher's place in compact). They're now one component, so the decision is one change:
either a plain icon in a quiet tray (not a cap), or keep the cap and write it into `agent-keys.md`
as "pages wear putty, agents never do" (and enforce it in `keys::fill`).

## 8. Usage: two titles, two orders, a question for a heading

**Where.** `usage-two`, `usage-two-account`, `settings-agents-accounts`. `AgentsUsageView.tsx`,
`UsageStack.tsx:604`, `:628`.

- An account page says "Usage" in the page header and "← Usage › sam@example.com" right under it.
  Put the breadcrumb in the header (the header *is* where you are) and drop the second line.
- The hero bar orders accounts by room ("Work, sam@…"); the list under it by work order ("1 sam@…,
  2 Work"). Same accounts, two orders, one screen apart. Use the work order in the bar.
- "Where did my usage go" is the only heading phrased as a question in the user's voice; the others
  are nouns (Limits, Accounts). "Where it went".
- The footnote says "the points aren't split between them": "points" (percentage points) is jargon.
  "Each task shows the tokens its engine reported; a rise isn't divided between tasks."
- The account card's "1" badge repeats "1st in the order" in the line beside it.
- "When every Codex account is out" is offered with no Codex account signed in (`usage-two`): show
  each crossover choice only for an engine with an account.
- Eyebrow "Usage" vs "All accounts" depends on how many accounts were *read*; with four accounts and
  one read it says "Usage". Key it to accounts signed in.
- Dark: an account at 0% draws its segment as a solid dark bar (the empty track) next to dashed
  unread ones; it reads as full. Give an empty read segment the hairline outline, not the fill.

## 9. Conversation switcher: the dot looks like it belongs to this conversation

**Where.** `agents-conversations`. `ConversationSwitcher.tsx:127`.

The trigger shows the current title then an amber dot. The dot means "*another* conversation needs
your OK" (its aria-label says so), but sighted, it reads as this one needing you — and this one is
"Working". Put the dot on the chat-bubble icon (a badge), not after the title. In the menu, the
current row says "Working" in grey text and the other "Needs your OK" in grey text plus a trailing
dot; everywhere else those are status pills. Use the pill.

## 10. Sidebar at 900px tall with groups: actions slide under the footer

**Where.** `agents-desk-groups`, `agents-keys-icon-search`. `agents.css` (list scroll), sidebar
footer.

With project groups on, New room is gone and Routines is half-faded under the Usage footer; with ten
agents the last agent row fades under it too. The fade says "scroll", but the actions are part of
the scrolling list, so New agent and Routines are only reachable by scrolling past every agent. Pin
New agent (and the pages, see #6) above the footer, outside the scroller.

## 11. New agent → icon picker

**Where.** `agents-keys-icon-search` (dark). `AgentKeyIconPicker.tsx`.

- The category chips run off the dialog's right edge ("… Animals, Arrows") with no fade or scroll
  cue, and are alphabetical from Lucide (Accessibility, Accounts & access, Animals first). Lead with
  the categories people pick by (People, Money, Communication, Files, Time) and end the row in a
  "More" menu.
- The chosen icon in the grid is the same key as the others with a faint ring; the chosen colourway
  (Putty) likewise. Draw the chosen key pressed (the key's own state language) and ring it at 3:1.

## 12. Smaller seams and copy

- **Fixed here:** What's in flight said "New agent · Empty socket" — the design doc's metaphor, not
  the user's word. Now just "New agent" (`AgentsBoard.tsx`).
- **Fixed here:** the base fixture's Chief had no key look, so `agents-first-run` (the first screen
  after onboarding) drew a putty cap instead of the Mogbot mark on Graphite that `ensure_main` gives
  it (`base.ts`).
- **Fixed here:** `docs/agents.md` still listed "Workflows, the Inbox" as places on the Projects side;
  a comment in `AgentsView.tsx` too. The class `workspace-sidebar-inbox` on the bell
  (`AgentsSidebar.tsx:277`, `sidebar-footer.css:111`) is now only a name; rename it with the bell.
- The board says Needs your OK as amber words under the key; the sidebar, the In flight rows and the
  waiting bar use the status pill (`agents-team.css:75`). One style.
- The model menu's effort is "Default / Low / Medium / High" under a menu that says the models in
  plain words; "Routines · Automatic (Fastest)" next to "Same as its chats (Default)" asks the reader
  to resolve two defaults. Say what Automatic picks in one line and drop the second default.
- Sidebar Usage row says "Not read yet"; the Usage page and account rows say "No usage reading yet"
  / "Not read yet"; the hero says "Your usage shows here after an agent's first reply". Pick one.
- Settings calls the page "Accounts & usage"; the sidebar and page call it "Usage". Fine as a
  superset, but the Settings page is the Usage page; consider "Usage" in both.
- `agents.openLogs` in the ⌘K sweep "produced no visible change": it opens Finder and says nothing
  in the app. A quiet "Opened the logs folder" toast would confirm it (and give the sweep something
  to see); otherwise list it in the capture's non-visual skips with a reason.

---

## Fixed in this pass

| # | What | Where |
| --- | --- | --- |
| 1 | Usage never says "out" for accounts it hasn't read | `usageGlance.ts`, test |
| 2 | One page header for What's in flight, Usage, Routines; compact gets the toggle and switcher | `AgentsPageHeader.tsx`, `AgentsTeamView.tsx`, `AgentsUsageView.tsx`, `AgentsRoutinesView.tsx`, `AgentsView.tsx`, new scenario |
| 3 | Ten failing scenarios repointed | `agentsUsage.ts`, `agentsDesktop.ts`, `agentsHeavy.ts`, `agents.ts` |
| 4 | "Show details" on steps that ran no command | `AgentWorkDetail.tsx`, `AgentWork.tsx`, test |
| 5 | Briefing dialog inset, reading face, no file name | `agents-work.css`, `AgentWorkDetail.tsx`, test |
| 6 | Routines: lower-case line, "for Finance", Resume all disabled with nothing paused, answers trailing and 8px apart, sidebar row selected | `agentDesk.ts`, `AgentsRoutinesView.tsx`, `agents-routines.css`, `agents.css`, tests |
| 12 | No "Empty socket"; first-run Chief wears its real key; Workflows/Inbox leftovers in docs | `AgentsBoard.tsx`, `base.ts`, `docs/agents.md`, `AgentsView.tsx` |

## Left, by owner

- **Usage owner:** 8 (all of it), the stale captions in 3.
- **Desk under-the-hood owner:** 4 (layout), 5 (chevrons).
- **Sidebar / navigation:** 6 (pages vs actions, the two "Routines"), 10.
- **Keys designer:** 7 (a decision, see there), 11.
- **Small, independent:** 9, the copy in 12.
