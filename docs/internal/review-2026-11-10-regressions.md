# Regression sweep after the night's merges, 2026-11-10

About 25 agent branches landed on `mogbot/foundation` overnight (chat, settings, palette and toasts,
timeline, usage, routines, rooms, sidebar, blocks, result cards, onboarding, notifications, step-in,
the OpenCode engine, performance). Each looked right alone. This pass looked for what broke where
two of them meet: the same thing styled twice, a word renamed in one place and not the next, a
scenario that now shows something other than what it says.

**How it was looked at.** From `1ce92c25d`. `pnpm harness` on port 1473 with its own `TMPDIR`;
every scenario captured dark and light at 1440×900 (`--theme dark|light`), plus the ⌘K
`--commands` sweep in dark. Screens were read as contact sheets of nine and, wherever something
looked off, at full size. `pnpm test:run`, `pnpm lint`, `pnpm format:check`, `pnpm test:scripts`,
`cargo test --lib`, `pnpm check:ui-baseline`, `pnpm check:a11y` and the usual gates were run before
and after. The first full runs were thrown away (see #1 and #2) and re-taken; the final set is
580 scenarios in each theme and 144 palette commands, every one ✓: nothing crashed, nothing
failed to settle, no unmocked command. Console output in it is the harness's own (no PTY, no Nerd
Fonts, no `package.json` in workspace scenarios; Tauri callback ids after a reload) and nothing
new.

**Not checked:** the Tauri build in WKWebView; the phone (`mobile/` has no `node_modules` in this
worktree, so its jest suite did not run against the two copy changes there); VoiceOver.

Ranked worst first. "Fixed" items were fixed on this branch, one small commit each.

---

## 1. Two capture runs drove one browser (fixed)

`scripts/headless-chrome.mjs`. Two runs started together both found port 9333 free; one Chrome
bound `127.0.0.1`, the other `[::1]`, and both runs drove the first. Pages in one browser share
`localStorage`, so the `--theme dark` run came back half light, and every screenshot in either set
was suspect. Any two parallel captures (two worktrees, dark and light) could do this. After launch,
the port's listener must now be in the launched Chrome's process group, else it retries on the next
port; a race test (two launches at once) got 9480 and 9481.

## 2. A capture run could freeze forever (fixed)

`scripts/harness-capture.mjs`, `Page.send`. No call had a timeout. Both full runs sat on the same
capture for twenty minutes while files were edited and Vite reloaded the page under an evaluate.
Each DevTools call now gives up after 60 s, so that capture fails and the run carries on.

## 3. The sign-in card's spinner was a 300px flat arc (fixed)

`agents-login-device-code`, `-from-phone`, `-opened-quiet`, `-phone-sheet`.
`agents-control.css` `.agent-login__flow > span { flex: 1 1 auto }`. The Spinner became a `<span>`
(valid inside a `<p>`) in one merge; the sign-in line stretches every child span in another. Every
waiting login card showed a wide grey ellipse where the spinner was. Only the words stretch now.

## 4. Settings' stacked rows had 280px of empty card before their buttons (fixed)

`settings-agents-user-chrome-setup`, `-error`, `-no-chrome`. `settings.css`: "actions drop under the
words" gives the words a 280px `flex-basis`; in a stacked (column) row that basis is a height. Your
Chrome's "Add the extension" step had its three buttons at the bottom of a tall empty card. The rule
skips stacked rows.

## 5. "Refills" beside "reset" on the same page (fixed)

`settings-agents-page`, `usage-*`, `agents-chat-usage`. The total-first Usage view said "Next refill
in 2d 23h" and "Refills" chips on the page whose mode is "Use it all before reset", whose nudge says
"…5-hour limit resets in 40 min", and whose crossover says "Wait for the reset"; chat lines and the
Mac's own failure lines say resets. One word now, "resets", on desk and phone
(`usageGlance.ts`, `UsageStack.tsx`, `AgentsUsageView.tsx`, `AgentUsageRing.tsx`,
`mobile/src/components/usageStack.tsx`, docs). Identifiers (`refill`, `RefillChip`) unchanged.
*A decision as much as a fix:* the Usage branch chose "refill" as the plainer word; "reset" won
because the mode, the spec in CLAUDE.md and every other surface already use it. Flipping the other
way is the same handful of strings plus the Rust lines.

## 6. Settings paths in copy pointed at pages that no longer exist (fixed)

Settings became a window with pages; lines the user and agents read still said
"Settings → Agents → Your Chrome" (the Chrome-down chat line, its fix rule in every agent's
standing rules, `capabilities.rs`, `browser_gate.rs`), "… → Usage" (crossover's "Always" line,
`usage_tools.rs`, the phone's crossover hint), "… → Slack" (Slack's sign-in failure), "… → Recently
deleted" and "… → Admins" (now on Independence), "… → Notifications". Each names its page now
(Chrome; Accounts & usage; Apps → Slack; Independence → …; Notifications). The note's fix button
already opened the right page (`SECTION_PAGE`); only the words were stale.

## 7. Edit agent showed "What it can reach" twice in a row (fixed)

`agents-policy-editor`, `agents-reach-editor`, `agents-secrets-editor`. The independence merge
renamed the policy list (`AgentPolicy`) to "What it can reach", the title the sign-ins/browser/keys
list (`AgentReach`) right under it already had. `AgentReach` now continues the first heading
instead of repeating it. Three scenarios clipped "the" group by that label and two of them were
shooting the wrong one; each targets its own class now.
*Left:* "Your browser" and "Apps" still appear in both lists, and "Apps this agent can use" above
them: three places for apps in one dialog. Merging them is a design call.

## 8. OpenCode said "Projects only" next to "Set up OpenCode" for agents (fixed)

`mode-toggle-home` (Tools & services), `agents-no-engine-at-all`. The OpenCode engine lets agents run
on it; `AgentsPanel` still said "Opencode · Projects only · Not installed". Display names were also
"Opencode" in six places (desk, setup, issue reports, the Rust agent config) against "OpenCode"
everywhere agents name it. And Settings → Agents' lead said "(Claude Code or Codex)".

## 9. Gates the merges left red (fixed)

- `pnpm icons:check` (so `check:ui-baseline`): the blocks merge drew charts and sparklines as
  inline SVG, and a Tooltip test had an `<svg>`. Chart roots are now marked dynamic exceptions
  (`data-dynamic-svg="agent-block-chart"` / `"agent-block-spark"`), the gate counts marked roots
  per file and skips tests; docs/design-system.md and CLAUDE.md name them.
- `pnpm lint`: 19 errors. `useChatReadTo` read a ref during render; `StepInBar`'s `handBack` lost
  its compiler memo; test files had async arrows with nothing to await and an unawaited `act`.
- `pnpm format:check`: three files unformatted. `cargo fmt`: `engine.rs`.
- `pnpm test:scripts`: `docs/ui-harness.md` names `harness/a11y/report.md`, which the doc-path
  check didn't know is generated.

## 10. Scenarios showing something other than what they say (fixed)

- `settings-agents-page`: "one tall shot" at 1280×3000, but Settings is capped at 760px now, so it
  came back scrolled to the middle with no title. It shoots the window as it opens.
- `agents-import-choice`: the long team chat opens at its newest line and scrolled the card it is
  about off the top. A short chat.
- `agents-steps-popover` / `-editor`: "Every Friday at 4:00 PM · Next: Fri … 2:56 AM" (now + 3 days)
  looked like a scheduling bug. The fixture's next run is a Friday at 4:00 PM.
- `agents-login-linkedin`: "Publicist needs your LinkedIn" in Social Posts' chat (default team, not
  the renamed one).

## 11. "Same account" cut to "Same accou…" (fixed)

`usage-same-account`, `usage-signin-changed`. The account row's state column (8.5em) was a few
pixels short for the amber pill. 9.5em.

## 12. New axe findings from the merges (fixed)

- Every toast was a keyboard-unreachable scroll region (`toast-success`, `toast-error-repeated`):
  `.toast-message` inherited line-height 1, so descenders spilled 2px past its `overflow-y: auto`
  box. It has its own line height (`--line-height-compact`) now.
- The blocks' form choices (`agents-blocks-decide`, `-form-invalid`) are `ToggleButton`s with
  `role="radio"`, which still carried `aria-pressed`. `ToggleButton` drops it for radios and shows
  the chosen one through `data-selected`.
- `palette-no-match`: the "Nothing here matches" line was `role="status"` inside the listbox,
  which may hold only options and groups. It's a live group.
- In dark, a header action open on its popover (Routines, Model, Usage) took the pressed fill but
  kept its secondary word: 4.3:1, in sixteen scenarios (`agents-schedule-*`, `agents-when-*`,
  `agents-steps-*`, `agents-model-menu`, `agents-runs-on`, `agents-chat-usage`…). It takes the
  button's pressed ink. The conversation switcher's "4m ago" on its hovered/current row was muted
  on the raised fill (3.6:1); it takes the row's ink.

---

## Left as found

- **The phone card is in most Chief scenarios.** `ChiefPhoneOffer` shows whenever the Chief has
  answered and storage has no answer; the harness clears storage per page, so it sits under
  `agents-slack-reply`, `agents-stress`, `agents-torture*`, `agents-admin-batch`… Real for a fresh
  install, noise in review. Seeding `shipstudio.chief.phoneOffer` in `resetStorage.ts` unless a
  scenario opts in would quiet it; not done, since it changes every scenario's baseline.
- **`agents-quota-warning`** says the amber line ends What's in flight "and the sidebar foot"; the
  sidebar foot is the usage row now, and the amber line is below the fold at 900px.
- **Sidebar overflow fade** (`agents-rooms-many`, `agents-sidebar-overflow`): the last row fades
  straight into "New agent" with no gap or rule.
- **Context menu vs ⋯ menu**: the sidebar's has no "Schedule a routine…" or "Files"; deliberate
  (`AgentActions`), but "Files" opens a list and has no "…".
- **`settings-agents-defaults-menu`** doesn't show the open menu at 900px.
- **⌘K commands that land short:** `agents.newAgentDefaults` and `agents.disk` open Settings →
  Agents, but in the palette sweep's base fixture there are no engine defaults and no low-disk
  reading, so the section they scroll to isn't drawn; the shot is the top of the page. A fixture
  gap, not a product bug as far as the harness shows.
- **`agents-header-narrowest`** (400px): the name truncates to "C…" while a separator dot and
  ~40px of empty space sit between it and the conversation switcher.
- **"Live" in green** on a selected sidebar row in light is 4.36:1 (`agents-takeover-chat`,
  `agents.css` `.agents-list__state-word`); there's no darker green token to reach for without a
  new semantic role.
- **Flaky under load:** `agents-import-copied` failed once in the first (shared-browser) run and
  passes alone; `AgentPreviewPane.test.tsx` "a site that stopped by itself…" failed once in a
  pre-commit run while three Chromes were capturing and passes alone.
- **Axe, what's left.** The full `check:a11y` (1160 pages) found 35 page/rule pairs over the
  baseline before the fixes above; those fixes were re-checked per scenario, not by a second full
  run. Left over the baseline: the green "Live" word above (`agents-stack-acme`,
  `agents-takeover-*`, light); the main-branch banner's warning button, 4.33:1 in light
  (`.main-branch-banner-action`, `#8a5800` on `#e5d9c7`; the darker warning ink is the same
  token) and dim terminal text (`.xterm-dim`) in workspace scenarios (`dev-server-consent-new`,
  `hosting-canceled`, `hosting-offline`, `layout-agent-elements-stacked`, `team-*`); and in
  `team-comments-selected` the thread's page tag (3.64:1 dark) and option rows with buttons inside
  (`nested-interactive`). Apart from "Live", none of those is in tonight's agents work; the
  baseline was not touched.
