# Visual identity review, 2026-11-10

An adversarial pass over the brand and visual identity of the whole product, desk and phone, after a
night of fast changes by many agents, on `mogbot/foundation` (58ee9f734). The question: what looks
like it came from a different product? The app icon and mark, the Chief's default key, agent keys
everywhere they appear, the accent rules, status colours, icons, type, radii, shadows and empty
states. Nothing about the keys themselves was redesigned.

**How it was looked at.** `pnpm harness` on port 2711 with its own `TMPDIR`, light and dark at
1440: `agents-keys*`, `agents-team-overview`, `agents-heavy*`, `agents-first-run*`, `dashboard*`,
`settings-agents*`, `launch-returning`, `onboarding-fresh`, `onboarding-engine*`,
`agents-room-thread`, `agents-result*`, `agents-blocks-brief*`, `palette-open`, `context-menu*`,
`dropdown-agent*`, `toast*`, `agents-requests-two*`, `usage-tokens`, `agents-new*`,
`agents-import-review*`, `agents-probe-fifty*`, `agents-takeover-chat`, `agents-desk-routines*`,
`agents-crossover-card`, `agents-copy-ready`, plus the first ~45 of the full suite in dark. Phone:
`pnpm qa:web --web-port 8351 --mock-port 47751 --cdp-port 9951` (the full list, light and dark).
App icons from `src-tauri/icons/`, `mobile/assets/` and `public/` side by side. Then the CSS and
components read for the same element drawn two ways. Shots:
`/private/tmp/claude-501/-Users-juliangalluzzo-Desktop-Projects-dashbot/125bf15b-3c9c-40f4-ae0e-f7068fb1acc8/scratchpad/visual/`.

**Not checked:** WKWebView and a native phone build (react-native-web stands in: its switches are
Material teal and its icons Material, both web artifacts); the Dock menu, macOS notifications and the
tray menu (native, no harness); the full `--commands` sweep; `settings-agents-quiet-off`, which
failed to settle in the harness before any change here.

**What held up.** The app icon, favicon, Dock and phone icons are one mark on one Graphite key
(the 32 px is hand-tuned and heavier on purpose). Answers are neutral everywhere checked (Allow,
Save, Keep changes, Import, Always). The desk's own icons are one set; the keys' Lucide pack is only
on keys. Status pills, the needs-you amber and danger icons are consistent. Accent use in the agents
CSS is limited to selection, "on" and starting things.

Ranked worst first. "Fixed here" items are committed on this branch, with tests where a rule can be
held.

---

## 1. The Chief wore the mark on Putty on the phone (fixed here)

**Where.** Phone: agents list, Catch up, Rooms, the agent sheet, the chat header, and all of the
demo; anything drawn from an agent object with no `colorway` yet.

**What was wrong.** `keyLookFor` gave a Chief with no colourway its colour's nearest (its "white",
so Putty) and the app's mark: a cream key with the mark, while the desk, the Mac, the app icon and
pairing show the mark on Graphite. The Mac's `keys::fill` moves exactly that Putty to Graphite
(`chief_key_default`); the shared TS didn't.

**Fixed.** `keyLookFor` does the same: a Chief whose nearest colourway would be Putty gets
`CHIEF_COLORWAY`; a colour the user chose (red → Brick) and an explicit colourway are kept.
Test in `agentKeys.test.ts`.

## 2. Names and @mentions in the old avatar palette, beside a key in another colour (fixed here)

**Where.** Rooms (each speaker's name, desk and phone), @mentions in chats and rooms, quote bars,
the requests panel. `agents.css` `--agents-tint-*`, phone `agentTint`.

**What was wrong.** Text "in the agent's colour" came from the pre-key avatar palette: a Sage key's
name and mentions were bright success green (#3fbf6a), Plum read violet, Pink hot pink, Graphite
near white. Next to the key it named, the colour disagreed, and green read as "done".

**Fixed.** Text tints follow the key's colourway: `data-colorway` on those elements and
`--agents-ink-<colourway>` (the key faces, lifted on dark only as far as AA needs; light uses the
faces), and on the phone the key face through `speakerInk`. The old palette remains only the accent
(by design, docs/internal/agent-keys.md). `theme.test.ts` holds every colourway's ink to AA on the
app and a panel in both themes. Dead `.agent-dot` (a coloured-dot avatar from before keys) removed.

## 3. An agent waiting on your OK drawn unlit, or as working, outside the Agents sidebar (fixed here)

**Where.** Projects: the workspace sidebar's Agents section and "at work" lines
(`WorkspaceSidebar`, `ProjectAtWork`), the project cards' team keys (`ProjectTeam`); the requests
panel above the composer (`AgentRequests`); the phone's Projects "at work" rows.

**What was wrong.** The same agent was raised and amber in the sidebar, but unlit in Projects
(`!waiting ? 'working' : 'idle'`), lit as working on the project card, and flat in the requests
panel that exists because it waits on you. The key's whole point is that state reads the same
everywhere.

**Fixed.** Those surfaces draw `needsOk` when the line waits (or `agentKeyState`), so needs-you is
one look. Test in `ProjectTeam.test.tsx`; the rule is written into agent-keys.md ("One state,
every surface").

## 4. Two different switches (fixed here)

**Where.** Settings (`.settings-toggle`, 36×20, macOS-style light knob on a grey track) and the
terminal's sound settings (`.notification-toggle`, 40×22, grey knob on the control fill, 11px raw
radius, 0.2s raw transitions).

**Fixed.** One `--switch-*` geometry contract in `tokens-components.css` (width, height, knob,
inset, travel); both draw from it with the shared off-track, ring and knob roles. No raw px left in
either.

## 5. Room badges: initials on the desk, member keys on the phone (open: a decision)

**Where.** Desk sidebar `RoomMark` ("PL" initials in an outlined square); phone `StackedKeys` (two
members' keys corner to corner).

**Why it matters.** The initials tile is the one monogram left in the Agents sidebar, and it is
the Ship Studio project-card idiom; the phone already found a key-native answer. The desk chose
initials deliberately ("a room never passes for an agent"), so this is a call for you: match the
phone, or a neutral key with the people legend (as "Everyone" already is).

## 6. "Live" drawn in two greens (fixed here)

**Where.** The board's state word (`--accent-success`, a fill role) and the sidebar's
(`--text-success`). In light they are different greens.

**Fixed.** The board uses `--text-success`, as the list does. (Whether "Live" should be green at
all, rather than the key's warm light, is a smaller question left as is: it matches the phone.)

## 7. Raw weights in shared primitives (fixed here)

**Where.** ModalFrame and EmptyState titles, Tabs, the ⌘K palette, Settings rows, the agents'
usage list and panel, the notification modal: `font-weight: 400/500/600` written in.

**Fixed.** They read `--font-weight-body/label/heading` (same values today), so the type roles
reach every dialog title and tab. The inherited Ship Studio screens (branches, migration, create
project, conflicts…) still carry ~120 raw weights; they are outside the Agents surfaces and left
for their own pass.

## 8. The key-size table in agent-keys.md was out of date (fixed here)

The acceptance test said "44 header/phone row". The desk chat header is 24 (its own token,
deliberately smaller than a list key), the phone chat header 30, the phone agent row 44. The doc
now lists every size where it is used.

## 9. Projects still looks like Ship Studio (open)

**Where.** `dashboard*`: grey letter-monogram thumbnails ("A", "D", "P"), `create-modal` at 16px
radius and `tg-card`/`publish-dropdown-menu`/`setup-item` at raw 10px (`--radius-card` elsewhere),
~120 raw font weights across branches, migration and create-project CSS.

**Why it matters.** It is the one surface reached from the Agents sidebar that carries none of the
key language. Not fixed: radii and weights there are a mechanical sweep, but the thumbnails are a
design question (a project could wear its bound agent's key, or none).

## 10. A lit Finance legend blooms into a blank tile at list size (open, not a redesign)

**Where.** `agents-requests-two-open`, the sidebar at 30px: Finance (the banknote legend) in
Needs your OK. The amber glow fills the rectangle so the legend reads as a lit blank. Pack icons
with a filled-looking outline (banknote, receipt) are the worst; the mark is fine. A per-size glow
radius on md/sm would fix it; left alone since the brief was not to touch the keys' look.

## Smaller notes

- The project toolbar's Import icon (a tray with a downward chevron) is the oddest glyph in the
  desk set; the rest of the set is consistent.
- Card radius is `--radius-lg` (12) for `.agent-card` and `--radius-card` (10) for the bar and the
  requests panel joined to it; that pairing is consistent and left alone.
- Phone switches render teal and icons Material in `qa:web`; both are react-native-web defaults,
  not the app (`switchColors` is applied on iOS).
