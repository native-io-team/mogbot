# Agent keys (identity system)

Every agent is a physical keycap. This replaces the blob/character avatars everywhere (desktop, phone, site). Reference render: `docs/internal/agent-keys-reference.html` (open in a browser; it is the approved look).

## Why
Avatars exist for wayfinding: colour plus icon tells you which agent you're in without reading. Keys do the same job, belong to our brand (the site's tactile keys) rather than copying Grok Bot, and can show state. The roster should feel like a board you build, not a set of pets.

## Anatomy
- Square keycap seen slightly from above: darker base (skirt), lighter inset top face, a solid hard-edged depth shadow underneath. Light only where a state lights it (see States).
- At 112px: outer radius 16; face inset 10 left/right, 5 top, 17 bottom, radius 11; depth a solid 8px offset in the darkest shade, plus one soft ambient shadow.
- Three shades of one hue (face, skirt, depth) and one legend colour with >= 4.5:1 contrast on the face.
- Legend: one icon, centred. Small bottom-right sublegend: the keyboard key the agent is bound to.
- Small (~30px, lists): face, skirt, 3px depth; no sublegend, no pips; icon ~15px, slightly heavier stroke. Must still read as a key.

## Palette (face / skirt / depth / legend)
- Blue     #3F6FD8 / #3159B4 / #223F85 / #FFFFFF
- Orange   #EC6A2E / #C9521C / #8F3810 / #1F1005
- Putty    #E6DECC / #CBC1AB / #A0967F / #2A2722
- Teal     #6FC2B6 / #52A398 / #33756C / #0C2421
- Graphite #4A4E55 / #34373C / #131417 / #F2EEE4
- Mustard  #E8B93F / #C99A26 / #8E6B12 / #2A1E05
- Pink     #EFA9A2 / #D48A83 / #9C5C56 / #2B0E0C
- Sage     #A9BA78 / #8C9D5C / #5F6E38 / #1A2108
- Brick    #B5452C / #963722 / #632314 / #FFF1E8
- Plum     #7A3E6E / #62305A / #3F1C3A / #FBEAF5
- Navy     #27395E / #1D2C4A / #0E172C / #EEE7D8
- Forest   #2F6148 / #244D39 / #123021 / #EAF2E2
- Sky      #9DC8EA / #7EABD0 / #4C7BA3 / #0E2538
- Lilac    #C3B4E2 / #A696C8 / #6C5D95 / #1F1734

The last six were added so a big team doesn't repeat colours, and they differ in lightness as well as hue: Navy, Forest and Plum are deep, Brick mid, Sky and Lilac pale (marked `light`, so a lit legend gets the deeper wash). Every legend clears 4.5:1 on its face (agentKeys.test.ts and the phone's theme test check). A new agent gets the colourway fewest wear, in palette order, so the original eight still come first; the old avatar colours red and purple now map to Brick and Plum.

Keys sit best on a light warm neutral (~#E9E3D6). Dark theme: keys keep their colours; plate/socket neutrals get dark equivalents.

## Icons
Keyboard legends, not app icons: single uniform stroke, no fills, square caps, miter joins, only horizontal/vertical/45-degree lines plus plain circles, 24px grid. Symbols over pictures (inbox = down-arrow into a tray). Final icons come from a designer: placeholders follow these rules and live in one registry so they're easy to swap.

These 23 are the **featured** legends: drawn by us, first in the picker, the defaults, and the only ones a new agent is given from its name or role (`iconRules`).

**The app's mark** (`mogbot`, named "Logo" so no copy carries the product name) is first in the featured row on desk and phone, and any agent can wear it. Search finds it by "mogbot", "logo", "mark" or "brand" (its `aka` in `agent-keys.json`: extra name words, not name rules, so an agent called "Brand" isn't given it). It is the **one exception to the legend rules**: the "M" (a dome with two slot eyes, `scripts/build-icons.mjs`) only reads as a solid shape, so it is drawn **filled** in the legend's colour (even-odd, the eyes cut out), with no stroke, and keeps its curves (`KeyIconDrawing.fill`; the desk's `.agent-key__legend[data-fill]`, the phone's `Legend`, where lit glow rings outline it). agentKeys.test.ts holds it to the only filled legend.

**The Chief's key** is the mark on **Graphite** (the app icon's colourway): `chiefIcon` / `chiefColorway` in `agent-keys.json`, used by `ensure_main` and the onboarding and pairing screens. A Chief made earlier wore the star on Putty; `keys::fill` moves it once (marked `chiefKeyDefault` in the Chief's entry): the legend only if it's still the star, the colourway only if it's still Putty. Nothing records whether the user chose those, so a value that differs is theirs and is kept, and after the move a star picked again stays. The Chief's old `color` stays "white" either way: it is the app's accent (`src/lib/accent.ts`), and a new default key is not a new accent.

## The icon pack
Beyond the featured legends, a key can wear any of **Lucide**'s 2,029 icons (version in `agent-keys.json` → `pack`). Chosen over Tabler (MIT, ~5,000) and Phosphor (MIT): Lucide is drawn on the same 24 grid with one 2px stroke and no fills, its geometry is more even than Tabler's (which matters at 15px on a small key), and every icon carries tags and categories for search. Licence: ISC (permissive and MIT-compatible); the notice, with Feather's MIT notice for the icons derived from it, ships beside the data in `agent-key-pack/LICENSE`.

- **Ids:** `lucide:` + the icon's name (`lucide:wallet`). The Mac accepts exactly the ids in the pack's index; the clients draw any id of that shape and fall back to the default legend for one they can't find.
- **Drawn as legends:** the same uniform stroke, legend colour and per-size stroke width as ours, no fills (the generator turns rects, ellipses and lines into paths and drops the few filled dots' fill). The one difference: pack icons keep the **round caps and joins** Lucide drew them with (`KeyIconDrawing.round`); squared off, their curves and short ticks break up.
- **Vendored as data, not a UI package:** `scripts/agent-key-pack.mjs <lucide repo> <lucide-static>` writes `packages/companion-protocol/src/agent-key-pack/` (`index.json`: names, tags, categories; `drawings-<letter>.json`: the drawings by first letter; `LICENSE`) and `agentKeyPackShards.ts` (one `import()` per file). Run it by hand to move to a newer Lucide, update `pack` in agent-keys.json, commit.
- **Loaded lazily:** nothing at startup. A key wearing a pack icon loads the one drawings file its icon is in (`agentKeyPack.ts`, `legendDrawing`), blank for that moment; the picker loads the index and every drawing when it opens. Desk: Vite code-splits each file. Phone: Metro doesn't split `import()`, so `mobile/metro.config.js` resolves the loaders to `agentKeyPackShards.require.ts` (also generated): each file a bundled module, evaluated on first use. About 535 KB raw (143 KB gzipped) for the whole pack, of which a key needs one file (0.1 to 55 KB).
- **Search** (`agentKeySearch.ts`, mirrored by `keys::find_icon`): every word must match a name word, a tag or a synonym (`iconSynonyms`), with prefixes and one typo allowed; featured legends and simpler names first. "money", "invoice", "mail", "car", "house", "code" and "calendar" all lead with a good key; `find` in `agent-key-cases.json` holds the desk, phone and Mac to the same best match.
- **The picker:** desk (`AgentKeyIconPicker.tsx`): the search (focused when the look is opened by hand), the categories as quick filters, Recently used (this Mac's browser storage), the grid of keys drawn as they would look, rendered a page at a time; arrows move the pick with the 112px key, ↓ from the search enters the grid, Enter takes the first match. Phone (`KeyIconSheet.tsx`): the featured row, then "Search 2,029 more icons" opens a sheet with the 112px key, the search (focused), category chips, Recently used (for the session) and a virtualised grid.
- **From chat:** `create_agent` / `update_agent` take `icon` as a featured id, a `lucide:` id, a pack icon's bare name, or a word for what it's for ("invoice"), resolved to the best match and named in the line ("with the Receipt legend").

## States (physical, always paired with a text label where space allows)
The look and motion follow the marketing site's keys (`mogbot-site` `src/styles/agent-key.css`, `src/scripts/motion.ts`), value for value where they can be. "Lit" means a backlit shine-through cap: the face deepens in its own hue (a per-colourway mix toward its depth: Blue 42%, Orange 30%, Putty 62%, Teal 48%, Graphite 30%, Mustard 48%, Pink 58%, Sage 48%, Brick, Plum, Navy and Forest 30%, Sky 55%, Lilac 58%), the legend shines warm with a tight glow on the icon only.
- Idle (free): cap at rest, legend unlit. Calm.
- Working: pressed (down to a 1.5-unit depth), lit warm white (#FFE9B4), breathing slowly (2.4s: the legend's glow and a soft light in the face), and its light spills onto the surface under the key in the key's own colour. This is also the typing/working indicator.
- Live (you drive its session): lit with the spill, still.
- Needs your OK, the loudest: sits proud (up 5 units, deeper depth), the face deepened further (+14%), the legend backlit amber-gold (#FFC94A, the app's "needs you" hue) with a wide glow, an amber spill under it, pulsing (1.6s, never below 60%).
- Paused: the cap stays so you can tell whose it is, drained of colour (saturate 12%), faded, its legend fainter, sunk halfway.
- New agent: an empty recessed socket with a neutral cross stem; it fades in. An agent that joins while the board is up drops into its socket (`seat`).
- Touch: a key in something clickable lifts a hair on hover and goes down on press; pressing its bound key presses every key for that agent on screen for a beat (`pressAgentKeys`, `data-hit`).

### At a glance (the acceptance test)
Working, free and needs-you must be countable without reading, at every size (112 board and the agent sheet, 44 phone agent row, 30 list row and phone chat header, 24 desk chat header, 20 menu and catch-up, 16 a line of text), in both themes, with motion stopped: working is pressed and warm-lit, free is at rest and unlit, needs-you is raised, amber and spilling light; paused is grey, faded and sunk, never mistaken for free or new. Check it with `harness-keys.html?only=squint` (twelve keys in mixed states with no words, every size) blurred or at half size.

### Motion budget
Only opacity, translate/transform and the legend's filter animate. Only Working (breathing) and Needs your OK (pulse) loop; the socket fade-in and the seat drop run once. No timers per key (the bound-key press is one timer per press). Everything holds still in a hidden or background window and with Reduce Motion, where the states still differ statically.

### One state, every surface
A key shows its agent's state wherever it is drawn for that agent now: the sidebar, header, board, requests panel, Projects (the workspace's agents and "at work" lines, the project cards' team keys) and the phone's rows and Projects. An agent waiting on your OK is raised and amber in all of them, never drawn unlit or as working (`agentKeyState`, or `needsOk` from a line's `waiting`). A name, @mention or quote bar in the agent's colour takes the key's colourway (`--agents-ink-*` in agents.css, `keyColorways` face on the phone), not the older avatar colour, which remains only the accent.

## Independence
Four pips on the front edge (the skirt band under the face), filled from the left: Careful 1, Steady 2, Bold 3, Unleashed 4. 112px (and other large sizes) only.

## Shortcuts
Each agent is bound to a real keyboard key, shown as the sublegend. Pressing it (when no text field is focused) jumps to that agent. Rebindable per agent; the sublegend updates. Unique per team.

## Where it lives
- **Data (both clients and the Mac):** `packages/companion-protocol/src/agent-keys.json` (colourways, featured icon ids, the pack and its synonyms, old colour → colourway, the name/role heuristics, the key alphabet, pips), read by `agentKeys.ts` and `src-tauri/src/agents/keys.rs`; `agent-key-cases.json` holds both to the same answers.
- **Legends:** `packages/companion-protocol/src/agentKeyIcons.ts`, the featured ones, the one registry to swap for the designer's set; the pack is `agentKeyPack.ts` + `agent-key-pack/` ("The icon pack").
- **Registry:** each agent stores `colorway`, `icon`, `boundKey`. An agent saved before keys gets them on read (`keys::fill`: its colour's nearest colourway, an icon from its name then role, the first free letter of its name, the Chief first); a duplicate key gets a free one. A key given automatically (on read, or a new agent with no colour asked for) never repeats another agent's colourway with the same icon (`keys::distinct_colorway`, `distinctColorway` in TS); a key someone chose is never changed. The old `color` follows the colourway for clients that only read colours.
- **Changing it:** the editor (colour, icon, press-to-bind), the Chief's `update_agent` / `create_agent` (`colorway`, `icon`, `key`; a key someone has is refused naming whose), the phone over `agents.create|update` on a Mac listing `agents.keys`.
- **Phone:** `mobile/src/components/AgentKey.tsx` (Views and react-native-svg; geometry `mobile/src/lib/agentKey.ts`, colours `keyColorways` / `keyNeutrals` in `mobile/src/lib/theme.ts`), everywhere an avatar was; colour, icon and a free key from the agent sheet and New agent (docs/mobile.md, "Agent keys").
- **Desk:** `src/components/agents/AgentKey.tsx` + `src/styles/features/agent-key.css`; the board in What's in flight (`AgentsBoard.tsx`); the picker (`AgentKeyPicker.tsx`); the shortcut (`hooks/useAgentKeyShortcuts.ts`, Agents only, never in a field, terminal, dialog or menu; ⌘K shows each agent's key).
- **States from an agent:** `agentKeyState` (lib/agents.ts): Needs your OK when a card waits; Paused while a usage limit stops it; Working while a turn runs; Live while you drive its session (Take over).
- **Harness:** `harness-keys.html?theme=light|dark` (the reference's layout) and the `agents-keys-*` scenarios.
