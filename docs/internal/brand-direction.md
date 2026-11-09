# Brand direction: the desk app and the site

The site (`~/ShipStudio/dashbot-site`, Astro) is the brand reference. This note says what its
visual language is, where the desktop app drifts from it, and the concrete changes that close the
gap. The benchmark is two competitors: Reason Machines (a calm three-pane agents app) and OpenBot
(a dark, sticker-avatar team app). We want to read as calmer than the first and more crafted than
the second.

Nothing here changes behaviour, the accent rules or "One look" (CLAUDE.md): answers stay neutral,
the accent stays the Chief's colour and never status, every value is a token.

## What the site is

**One idea: a lit desk with keys on it.** Everything is a key (raised, white, with a darker side
under it), a tray (recessed, warm grey) or the desk the two sit on. Depth is physical and quiet,
never glassy or glowing.

| | The site | Source |
| --- | --- | --- |
| Page | Warm chalk `#f4f2ee`, paper `#fbfaf8`, a 3.5% fractal-noise grain, a 24px dot grid that fades to the edges, and one warm "lamp" pool of light from above | `global.css` `body`, `body::before/::after` |
| Ink | Warm near-black `#1d1c1a`, secondary `#55524b`, tertiary `#6b675f`, hairline `#1d1c1a17` | `--ink`, `--ink-2`, `--ink-3`, `--hair` |
| Surfaces | Tray `#dcd8d0 → #cfcac1`, desk `#d7d2c9 → #e1ddd5`; inside app windows one fill `#f1efeb`, one hairline `#0000000f`, one field ring `#00000024` | `--tray*`, `--desk-*`, `--fill`, `--line`, `--ring` |
| Type | Geist 400/500/600 + Geist Mono 500. Display 600 at −0.062em, h2 600 at −0.052em, names 600 at −0.02em, body 14–16 at −0.01em. Tight negative tracking is the signature | `.display`, `.h2`, `.name`, `.appwin` |
| Radii | Key 14, card 18, window 14, tray 24; inside windows fields 9, buttons 8, bubbles 14 with a 4px tail corner | `--r-*`, `.appwin .field/.btn/.me` |
| Depth | Keys: lit top edge, 1px ring, a 5px solid "side", then a long soft drop. Cards: ring + long soft drop (−22px spread). Trays: inset shadow with a light lower lip | `--sh-key`, `--sh-card`, `--sh-inset` |
| Status | Live = green dot with a 3px halo; out/needs = warm orange text; idle = 3% ink wash. Tags are 6px-radius pills of the hue at 12% | `.dot`, `.tag.live/.out/.idle` |
| Agents | Key-cap faces (a pastel key with two dot eyes, `.face`), on white key tiles in a tray. Name 14/600, one muted line under it, a status mark top-right | `demos/Agents.astro` |
| Motion | One arrive curve `cubic-bezier(.16,1,.3,1)`, one spring, one press (70ms). Things rise 16px out of a slight blur; keys press down 4px | `--ease`, `--spring`, `--press`, `[data-reveal]` |
| Voice | Short, confident, plain: "Agents, without the ceiling." "Ask for a fix. Get it back checked." "Needs your OK." Two-line headlines, a full stop each | `Hero.astro`, chapters |

**The competitors.** Reason Machines: white, cool greys, near-black pills, rows of name + one
truncated line, very little chrome, a confident one-line headline. Calm, but generic: nothing in it
is theirs. OpenBot: dark, purple, sticker avatars with role tags beside the name, lots of chrome
(icon rail, tabs, model menu). Characterful, but busy. Our edge is the one neither has: *material*.
The key and the tray, warm paper, a face that blinks. The app should carry that, quietly.

## Where the desk app diverges today

Captured with the harness (`agents-team`, `agents-live-in-flight`, `agents-approval`,
`onboarding-fresh`, `settings-agents-page`, light and dark).

1. **Cold neutrals.** Light is pure grey (`#f5f5f5` app, `#ffffff` panels, `#555`/`#606060` text);
   dark is pure grey (`#141414` → `#393939`). The site is warm throughout. Side by side, the app
   looks like a different product from its own marketing.
2. **Dim, small type.** Dark primary text is `#bcbcbc` (a grey, not a white) and the sidebar reads
   at 11–12px with no tracking. Names are `--text-secondary` until selected, so the list looks
   disabled. The site sets names at 600 with negative tracking.
3. **Flat segmented controls.** The Agents | Projects toggle (and every segmented `Tabs`) is a
   bordered grey box with a grey thumb. On the site this exact control is a recessed tray with a
   raised white keycap: the most recognisable thing on the page.
4. **Cramped rows.** One row carries name, role, pin, engine badge, level badge and a two-part
   preview, all 11–12px. Reason's rows are name + one line; ours should be name (strong) + role
   (quiet) + one crisp status line.
5. **No sense of the team at a glance.** Reason shows "N working" in the sidebar; we show it only
   per row.
6. **Cards without depth on dark, and tight radii.** Cards are 8px, a flat control fill on dark and
   a 6% hairline on light. The site's cards are 18px with a ring and a long soft drop.
7. **Onboarding welcome is a grey void.** A 24px title, no face, no material. It is the first
   screen anyone sees and it says nothing about the brand.
8. **Headers lack weight.** The chat header name is 14px with no tracking beside an 11px role.

## The changes

Each is a token or a scoped rule; status is noted where it shipped in this pass.

| # | Where | Before → after | Status |
| --- | --- | --- | --- |
| 1 | `tokens-core.css` light neutrals (`--color-paper-*`, `--color-ink-*`) | Grey `#f5f5f5/#fff/#555` → warm chalk/paper/ink from the site (`#f4f2ee`, `#fdfcfa`, `#55524b`, `#6b675f`). `--color-ink-900` stays `#1c1c1c` (the Allow fill and the white accent's light shade, held by tests) | Shipped |
| 2 | `tokens-core.css` dark neutrals (`--color-gray-*`) | Neutral grey → warm charcoal from the site's dark key (`#151413`, `#1c1b19`, `#3a3835`); `--color-gray-100` → chalk, so the dark Allow fill is paper, not grey | Shipped |
| 3 | Dark `--text-primary` | `#bcbcbc` → a warm `#d6d2ca` (AA held; secondary and muted warm with it) | Shipped |
| 4 | Tracking | New core `--tracking-tight-*` and semantic `--tracking-name` (−0.01em), `--tracking-title` (−0.02em), `--tracking-display` role for big titles (−0.035em). Applied to agent names, chat header, card titles, onboarding title, settings section titles | Shipped |
| 5 | Segmented `Tabs` (`components/tabs.css`) | Bordered grey box + grey thumb → the site's tray and keycap: `--tabs-tray-*` (recessed: inset shadow, lower lip, no border) and `--tabs-key-*` (raised: lit top edge, ring, 1px side). Both themes | Shipped |
| 6 | Agent rows (`agents.css`) | Name 12px `--text-secondary` → 13px `--text-primary` at 500 with `--tracking-name`; role and status 12px; the status line in `--text-secondary` when it is news, muted otherwise | Shipped |
| 7 | Sidebar team line (`AgentsSidebar`) | Nothing → a calm "N working" line at the head of the list with a `--status-running` dot (never the accent); "All quiet" when nobody is | Shipped |
| 8 | Cards (`--radius-card`, `--shadow-card`, `.agent-card`) | `--radius-card` 8 → 10px app-wide; agent cards 12px (`--radius-lg`) with more air; `--shadow-card` is a ring and a long soft drop on light, a lit top edge, ring and short drop on dark | Shipped |
| 9 | Chat header | 14px name → 15px (`--font-size-subhead-lg`) at 600 with `--tracking-title`; the role line 11 → 12px | Shipped |
| 10 | Onboarding welcome (`FlowShell`, `onboarding-flow.css`) | Grey void → the Chief's key cap above the title, a 32px title at `--tracking-display`, and the site's desk: a dot grid fading to the edges and a lamp pool from above (`--flow-mat-*`, both themes) | Shipped |
| 11 | Composer and user bubble | The user bubble gets the site's small tail corner (`--radius-sm` bottom-right); the composer lifts off the canvas with `--shadow-sm` | Shipped |
| 12 | Empty states (`EmptyState`) | Title tracked in (`--tracking-title`) to match the site's names | Shipped |
| 13 | Settings → Agents section titles | Muted 11px labels → 13px `--text-primary` at 600 with `--tracking-name`, so the page reads as sections, not a log | Shipped |
| 14 | Status pills (`primitives/StatusPill`, `components/status-pill.css`; phone `StatusPill` in `ui.tsx`) | Coloured status words and whole amber/red lines → one calm pill: a 6px wash of the state's hue at 14%, a dot of it, the words in `--text-primary` (`--status-pill-*`). Running `--status-running`, waiting on you `--accent-warning`, failed `--accent-error`, done/in use `--accent-success`, out of usage and idle neutral (amber means needs you, only). Used on the sidebar rows, What's in flight (Needs you, Paused), Settings → Accounts, the usage list's quiet rows; phone agent and room rows and Settings → Accounts. The engine/level badge is the same tag with no hue (no border). `theme.test.ts` and the phone's `brandFinish.node.test.ts` hold the words at AA on every wash | Shipped |
| 15 | Primary buttons (`base.css`, `--button-key-*`, `--button-primary-shadow*`, `--button-strong-shadow*`) | Flat fill → a keycap for `primary` and the neutral `strong` answer: lit top edge, a 2px side in the key's own shade (`--accent-user-side`, computed in `accent.ts` and always darker than the face, tested; the answer's is a fixed neutral), a soft drop, and a 1px press that gives up exactly 1px of side, so nothing moves (`--transition-press`, 70ms). Disabled sits flat. Phone: `Button`'s `primary`/`answer` draw the same through `keycapShadow` | Shipped |
| 16 | Arrival motion | Instant / 300ms → the site's arrive curve (`--ease-arrive`, `--transition-arrive`, 200ms) with an 8px rise for new messages and cards (`--agents-motion-enter`), and for rows that join the sidebar or What's in flight while it's open (`useNewKeys`). Phone: replies, cards and lines that come in while a chat is open, and new agents in the list, rise on the same curve (`components/Arrive.tsx`, `lib/arrivals.ts`); history, the first load and a big catch-up batch hold still; Reduce Motion holds everything still on both | Shipped |

Leftovers fixed in the same pass: the desk said "Claude Code is signed out" for a Codex agent
(`failureLine` now takes the engine, as the phone's did), and the phone's agent rows built a
steadied working line and then drew the unsteadied one.

## Rules this keeps

- **Warm, not beige.** The chroma is low (the site's chalk is ~3% chroma). If a screen reads
  yellow, a role is reaching for a tray colour; use the surface roles.
- **Keys and trays are for controls,** not for content. A card is a sheet (ring + soft drop), not
  a key.
- **The accent is still the Chief's colour.** The keycap thumb is neutral; the running dot is
  `--status-running`; "needs your OK" stays `--accent-warning`.
- **Both themes.** Every new role has a light value in `tokens-semantic.css` or the feature file's
  light block, and `theme.test.ts` holds AA.
