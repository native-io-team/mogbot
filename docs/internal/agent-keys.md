# Agent keys (identity system)

Every agent is a physical keycap. This replaces the blob/character avatars everywhere (desktop, phone, site). Reference render: `docs/internal/agent-keys-reference.html` (open in a browser; it is the approved look).

## Why
Avatars exist for wayfinding: colour plus icon tells you which agent you're in without reading. Keys do the same job, belong to our brand (the site's tactile keys) rather than copying Grok Bot, and can show state. The roster should feel like a board you build, not a set of pets.

## Anatomy
- Square keycap seen slightly from above: darker base (skirt), lighter inset top face, a solid hard-edged depth shadow underneath. No blurry glows.
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

These 22 are the **featured** legends: drawn by us, first in the picker, the defaults, and the only ones a new agent is given from its name or role (`iconRules`).

## The icon pack
Beyond the featured legends, a key can wear any of **Lucide**'s 2,029 icons (version in `agent-keys.json` → `pack`). Chosen over Tabler (MIT, ~5,000) and Phosphor (MIT): Lucide is drawn on the same 24 grid with one 2px stroke and no fills, its geometry is more even than Tabler's (which matters at 15px on a small key), and every icon carries tags and categories for search. Licence: ISC (permissive and MIT-compatible); the notice, with Feather's MIT notice for the icons derived from it, ships beside the data in `agent-key-pack/LICENSE`.

- **Ids:** `lucide:` + the icon's name (`lucide:wallet`). The Mac accepts exactly the ids in the pack's index; the clients draw any id of that shape and fall back to the default legend for one they can't find.
- **Drawn as legends:** the same uniform stroke, legend colour and per-size stroke width as ours, no fills (the generator turns rects, ellipses and lines into paths and drops the few filled dots' fill). The one difference: pack icons keep the **round caps and joins** Lucide drew them with (`KeyIconDrawing.round`); squared off, their curves and short ticks break up.
- **Vendored as data, not a UI package:** `scripts/agent-key-pack.mjs <lucide repo> <lucide-static>` writes `packages/companion-protocol/src/agent-key-pack/` (`index.json`: names, tags, categories; `drawings-<letter>.json`: the drawings by first letter; `LICENSE`) and `agentKeyPackShards.ts` (one `import()` per file). Run it by hand to move to a newer Lucide, update `pack` in agent-keys.json, commit.
- **Loaded lazily:** nothing at startup. A key wearing a pack icon loads the one drawings file its icon is in (`agentKeyPack.ts`, `legendDrawing`), blank for that moment; the picker loads the index and every drawing when it opens. Desk: Vite code-splits each file. Phone: Metro doesn't split `import()`, so `mobile/metro.config.js` resolves the loaders to `agentKeyPackShards.require.ts` (also generated): each file a bundled module, evaluated on first use. About 535 KB raw (143 KB gzipped) for the whole pack, of which a key needs one file (0.1 to 55 KB).
- **Search** (`agentKeySearch.ts`, mirrored by `keys::find_icon`): every word must match a name word, a tag or a synonym (`iconSynonyms`), with prefixes and one typo allowed; featured legends and simpler names first. "money", "invoice", "mail", "car", "house", "code" and "calendar" all lead with a good key; `find` in `agent-key-cases.json` holds the desk, phone and Mac to the same best match.
- **The picker:** desk (`AgentKeyIconPicker.tsx`): the search (focused when the look is opened by hand), the categories as quick filters, Recently used (this Mac's browser storage), the grid of keys drawn as they would look, rendered a page at a time; arrows move the pick with the 112px key, ↓ from the search enters the grid, Enter takes the first match. Phone (`KeyIconSheet.tsx`): the featured row, then "Search 2,029 more icons" opens a sheet with the 112px key, the search (focused), category chips, Recently used (for the session) and a virtualised grid.
- **From chat:** `create_agent` / `update_agent` take `icon` as a featured id, a `lucide:` id, a pack icon's bare name, or a word for what it's for ("invoice"), resolved to the best match and named in the line ("with the Receipt legend").

## States (physical, never outer glows or badge dots; always paired with a text label where space allows)
- Idle: cap at rest.
- Working: pressed (down ~6px, depth 2px, face ~8% darker). This is also the typing/working indicator.
- Live: legend lit like a backlit shine-through cap: icon #FFF6DC with a tight soft glow on the icon only; face darkens (~20%; ~35% on light colourways Putty/Mustard/Pink/Sage so the lit legend reads).
- Needs your OK: lit + slow pulse (~1.6s; none under reduced motion), cap sits proud (up ~5px, deeper depth).
- Paused: cap removed: recessed socket with a cross-shaped switch stem in the agent's colour.
- New agent: empty socket with a neutral stem.

## Independence
Four pips on the front edge (the skirt band under the face), filled from the left: Careful 1, Steady 2, Bold 3, Unleashed 4. 112px (and other large sizes) only.

## Shortcuts
Each agent is bound to a real keyboard key, shown as the sublegend. Pressing it (when no text field is focused) jumps to that agent. Rebindable per agent; the sublegend updates. Unique per team.

## Where it lives
- **Data (both clients and the Mac):** `packages/companion-protocol/src/agent-keys.json` (colourways, featured icon ids, the pack and its synonyms, old colour → colourway, the name/role heuristics, the key alphabet, pips), read by `agentKeys.ts` and `src-tauri/src/agents/keys.rs`; `agent-key-cases.json` holds both to the same answers.
- **Legends:** `packages/companion-protocol/src/agentKeyIcons.ts`, the featured ones, the one registry to swap for the designer's set; the pack is `agentKeyPack.ts` + `agent-key-pack/` ("The icon pack").
- **Registry:** each agent stores `colorway`, `icon`, `boundKey`. An agent saved before keys gets them on read (`keys::fill`: its colour's nearest colourway, an icon from its name then role, the first free letter of its name, the Chief first); a duplicate key gets a free one. The old `color` follows the colourway for clients that only read colours.
- **Changing it:** the editor (colour, icon, press-to-bind), the Chief's `update_agent` / `create_agent` (`colorway`, `icon`, `key`; a key someone has is refused naming whose), the phone over `agents.create|update` on a Mac listing `agents.keys`.
- **Phone:** `mobile/src/components/AgentKey.tsx` (Views and react-native-svg; geometry `mobile/src/lib/agentKey.ts`, colours `keyColorways` / `keyNeutrals` in `mobile/src/lib/theme.ts`), everywhere an avatar was; colour, icon and a free key from the agent sheet and New agent (docs/mobile.md, "Agent keys").
- **Desk:** `src/components/agents/AgentKey.tsx` + `src/styles/features/agent-key.css`; the board in What's in flight (`AgentsBoard.tsx`); the picker (`AgentKeyPicker.tsx`); the shortcut (`hooks/useAgentKeyShortcuts.ts`, Agents only, never in a field, terminal, dialog or menu; ⌘K shows each agent's key).
- **States from an agent:** `agentKeyState` (lib/agents.ts): Needs your OK when a card waits; Paused while a usage limit stops it; Working while a turn runs; Live while you drive its session (Take over).
- **Harness:** `harness-keys.html?theme=light|dark` (the reference's layout) and the `agents-keys-*` scenarios.
