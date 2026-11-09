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
Keys sit best on a light warm neutral (~#E9E3D6). Dark theme: keys keep their colours; plate/socket neutrals get dark equivalents.

## Icons
Keyboard legends, not app icons: single uniform stroke, no fills, square caps, miter joins, only horizontal/vertical/45-degree lines plus plain circles, 24px grid. Symbols over pictures (inbox = down-arrow into a tray). Final icons come from a designer: placeholders follow these rules and live in one registry so they're easy to swap.

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
- **Data (both clients and the Mac):** `packages/companion-protocol/src/agent-keys.json` (colourways, icon ids, old colour → colourway, the name/role heuristics, the key alphabet, pips), read by `agentKeys.ts` and `src-tauri/src/agents/keys.rs`; `agent-key-cases.json` holds both to the same answers.
- **Legends:** `packages/companion-protocol/src/agentKeyIcons.ts`, the one registry to swap for the designer's set.
- **Registry:** each agent stores `colorway`, `icon`, `boundKey`. An agent saved before keys gets them on read (`keys::fill`: its colour's nearest colourway, an icon from its name then role, the first free letter of its name, the Chief first); a duplicate key gets a free one. The old `color` follows the colourway for clients that only read colours.
- **Changing it:** the editor (colour, icon, press-to-bind), the Chief's `update_agent` / `create_agent` (`colorway`, `icon`, `key`; a key someone has is refused naming whose), the phone over `agents.create|update` on a Mac listing `agents.keys`.
- **Desk:** `src/components/agents/AgentKey.tsx` + `src/styles/features/agent-key.css`; the board in What's in flight (`AgentsBoard.tsx`); the picker (`AgentKeyPicker.tsx`); the shortcut (`hooks/useAgentKeyShortcuts.ts`, Agents only, never in a field, terminal, dialog or menu; ⌘K shows each agent's key).
- **States from an agent:** `agentKeyState` (lib/agents.ts): Needs your OK when a card waits; Paused while a usage limit stops it; Working while a turn runs; Live while you drive its session (Take over).
- **Harness:** `harness-keys.html?theme=light|dark` (the reference's layout) and the `agents-keys-*` scenarios.
