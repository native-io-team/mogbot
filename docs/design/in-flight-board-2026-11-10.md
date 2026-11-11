# What's in flight, ordered by attention (2026-11-10)

The owner, looking at the board (a 4-column grid of 112px keys for ~20 agents,
each with a name and a cut-short preview): "super cool, showing everything
that's going on, but this screen needs some work. You need to immediately be
able to see the things that need your attention."

The old page opened on the full board of keys, then Needs you, Paused,
Working, Scheduled next and Done recently. With twenty agents the board was
about 1,400px tall, so what needed you started below the fold, behind a wall
of "…" previews, and Site QA's ask read "Needs your OK: Site QA needs …".

## What it is now

`AgentsTeamView.tsx`, `AgentsBoard.tsx` (new `variant="quiet"`),
`agents-team.css`. Agent keys are used as components only (`agent-key.css`
and `AgentKey.tsx` untouched).

1. **Needs you · N** first, heading in full ink. Each agent asking is its key,
   its name and what it wants in plain words (the card's summary, or its
   question; the agent's own name dropped from the front, `withoutName`), the
   time, a chevron and Open chat. The first two agents open with their cards,
   answered in place with the existing `ApprovalCard` / `ErrorLine` and their
   answer path (`answerApproval`, the Mac's answer gate). Nothing is answered
   for the user, and Allow stays the neutral strong button. The rest wait as
   one line each, in the order they asked, and the next opens as one is
   answered. An agent with many cards shows two, then "Show N more". Empty:
   "Nothing needs you".
2. **Working now · N**: the live step and elapsed time (`AgentWorkingLine`),
   and Stop, which goes through the same confirm as ⌘K's Stop (`onStop` →
   `setStopping` in `AgentsView`).
3. **Finished recently · N**: agents with unread replies, each by its result
   card's title ("October invoice summary") or its reply's first line. Unread
   is shown the way the sidebar shows it, in the row's ink (and told to a
   screen reader), not with a new dot.
4. **Paused · N**, only while a usage limit has someone, with Retry at the
   reset.
5. **Everyone else · N**: the quiet board. 44px keys in a recessed well, the
   name, the bound letter off the cap's corner, and a second line only when
   the state is news ("Paused until 5:02 PM", "Live · You're driving it").
   What it last said shows on hover or focus (Tooltip, 300ms) and is part of
   the button's accessible name. Then the New agent socket.
6. **Coming up** (the next three routines), the stay-on note, usage.

Keyboard: arrows move between rows and keys (Up/Down between rows; in the
grid Left/Right along a row and Up/Down to the nearest key across; Home/End),
`boardNavTarget`. Not j/k: a letter is an agent's own key
(`useAgentKeyShortcuts`), and every agent's key still works here. Tab still
reaches each card's buttons, and ⌘J still opens the next agent that needs you.
⌘K "What's in flight" (`agents.team`) is unchanged.

## Three critics, in turn

Each critique was written against the screenshots before fixing anything.

### 1. A time-poor founder with 20 agents

Round 1, after the first rebuild (five asks, every card open):

- **Five open cards are a screen and a half.** Working now and Finished
  recently were below the fold at 1440×1000, and I couldn't see how many
  things were queued without scrolling. → The first two open, the rest are one
  line each in the order asked (`OPEN_FIRST = 2`), so the whole queue and
  Working now fit on one screen. The next one opens as I answer.
- **"Finance · Finance needs you in its browser…"** says the name twice, and
  the row repeats the card's title. → `withoutName`: "Finance · Needs you in
  its browser: approve the Microsoft sign-in on your phone".
- **Inbox's failure says its sentence twice** (row and error card). → With
  the error card open, the row shows only the "Didn't finish" pill.
- **A grey key in the grid and no word why.** → A paused or live key says so
  under its name, and Paused got its section back, with Retry at the reset
  (the first rebuild had dropped it into the grid and lost that action).
- **The "Needs your OK" pill on every row under "Needs you"** is the heading
  again. → Dropped for requests. The pill stays only for a turn that didn't
  finish, which isn't a request.

Round 2: one screen shows two answerable cards, three more asks, and all three
working agents with Stop. Signed off. Not done: an "Allow all" here. The
review panel has it, and it would mean picking which cards it covers.

### 2. A designer obsessed with hierarchy, spacing and balance

Round 1:

- **Boxes in boxes.** Each ask was a panel with the card's own border and fill
  inside it, and the key hung at the panel's corner. → No panel. Row, then the
  card under the name, grouped by space.
- **The 44px key in rows** broke the left edge every other list holds, and
  its needs-you spill bled past the panel. → The list key (`md`) everywhere,
  so every section's keys and names share one column.
- **A bare "5" after the heading** read as a stray number. → "Needs you · 5",
  the bell's own wording.
- **Grid names at 10px** were too small to read at the size the keys are. →
  The body-sm size. Columns widened so long names ("Security & DevOps") don't
  cut.

Round 2:

- **In light, the quiet section had the page's heaviest fill**: the warm
  plate became a beige slab louder than Needs you. → A recessed well, no inset
  shadow, in both themes.
- **The bound letters floated at the far corner of a wide cell**, far from
  their key. → Off the cap's own top-right corner, like a keyboard's second
  legend.

Round 3: the order of loudness is Needs you (full ink, open cards, lit keys),
then Working and Finished (secondary), then Paused and Everyone else (faint
headings, quiet keys). Signed off.

### 3. An accessibility and keyboard user

- **No way through the board but Tab.** With 20 keys and five cards that's 40+
  stops. → Arrow navigation over rows and keys (`data-board-nav`, `data-grid`),
  with a screen-reader hint on the column ("Arrow keys move between agents;
  Tab reaches each card's answers").
- **j/k as asked would steal the J and K agents' own keys.** → Arrows only.
- **The quiet grid's preview lived only in a tooltip.** Its `aria-describedby`
  points at a surface that exists only while it's shown. → The line is part
  of the button's name ("Research. Two competitors changed pricing.").
- **A bound key drawn as a letter means nothing to a screen reader.** →
  `aria-keyshortcuts` on each key, with the visual letter `aria-hidden`.
- **Unread shown by weight alone** isn't said. → "Unread." in screen-reader
  text on Finished rows.
- Section names carry their counts ("Needs you, 5"). Open chat and Stop name
  their agent ("Stop Research"). Focus rings are the neutral `--focus-ring`.

axe runs on the quiet board (`a11y.test.tsx`) with no violations. Signed off.
Not checked: VoiceOver in WKWebView. The harness runs in Chrome.

## Coverage

- Scenarios (`src/harness/scenarios/agentsInFlight.ts`): `agents-inflight-none`,
  `-one`, `-five`, `-full` (the whole column, tall window), `-keys` and `-narrow`
  (720px, five needing you). Twenty agents, three working, three unread
  results, one paused. Capture with `--theme light` too. `agents-keys-board`
  and `agents-team-many` describe the new page.
- Tests: `AgentsTeamView.nav.test.ts` (`withoutName`, arrow targets),
  `AgentsBoard.test.tsx` (the quiet board's names, news line and shortcut),
  `a11y.test.tsx`.
- jsdom has no layout, so the grid's Up/Down geometry is checked in the
  harness instead: `agents-inflight-keys` focuses the first row, presses End,
  Up and Right, and requires a focused key in the grid (it lands on the key
  above New agent, then the next one along, with its tooltip showing).
