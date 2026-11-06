# Agent avatars

Each agent is a soft shape with a small face, in its own colour. The brief: "smooth, clean, basic, a
little personality — not cheesy", like Grok Bot's pick-a-shape-and-a-face avatars.

- **Spec (one for both clients):** `packages/companion-protocol/src/avatar.ts`. It holds the shapes,
  faces, stroke weights per size, optical centring, default looks and motion timings.
- **Desk:** `src/components/agents/AgentAvatar.tsx` + `src/styles/features/agents-avatar.css`. This is
  the design system's second marked dynamic-SVG exception (`data-dynamic-svg="agent-avatar"`,
  `scripts/icons.mjs`).
- **Phone:** `AgentAvatar` in `mobile/src/components/agent.tsx`, drawn with
  react-native-svg 15.16 (a new native dependency, so the phone app needs a new build; the
  fingerprint runtime keeps an OTA update off older binaries).
- **Stored:** `avatar: { shape, face }` on the agent (additive, optional). Without one, both clients
  and the Mac (`AgentLook::default_for`) derive the same look from the id with FNV-1a. A test table in
  `avatar.test.ts` and `avatar_tests.rs` keeps the TS and Rust results identical. The Chief defaults
  to a calm squircle, and no other agent gets the squircle by default. Defaults never include the wink
  or the sleepy face: they are a personality someone picks.

## Why the last attempt looked horrible

That attempt was `b36d59f6` (removed in `c197d264`): fourteen faces on a single rounded tile.

1. **Costumes, not faces.** Visor, cyclops, glasses, shades, a "trio" of eyes, a plus sign. Each one
   was a mascot gag, and together they made the sidebar look like a sticker sheet. That is the
   cheesiness.
2. **Full-strength fill.** The tile was the raw agent colour (`currentColor`), so a list of agents
   became a row of saturated sweets that out-shouted every other part of the monochrome UI.
3. **One silhouette.** All personality had to come from the face, so the faces got louder to compensate.
4. **One stroke weight at every size.** The weight was 2 on a 32 grid. At 24px that is a smudge, and at
   46px it is clumsy.

This version avoids all four. It has only eyes and at most a mouth (no props), a tonal fill, eight
silhouettes that carry most of the variety, and weights that step up as the avatar shrinks.

## The system

**Shapes (8):** circle, rounded square, squircle, soft hexagon, pill, drop (one tight corner), cookie
(eight gentle scallops) and arch. Each is optically balanced, so a circle reads the same size as a
square. Each shape also moves the face to its optical centre (an arch's weight sits low, and a drop's
leans away from its point) and scales it for the room it has (a pill is narrow).

**Faces (10):** calm, cheerful, curious, focused, sleepy, wink, determined, quiet, content and bright.

- Every face is two **open** eyes and at most one short mouth. No lids, no closed-eye arcs, no blink:
  the owner found closed eyes horrible, so "cheerful" smiles with open eyes, "sleepy" is a low,
  downward gaze and "wink" is a sideways glance with a lopsided smile (the keys are stored, so they
  stay; only the drawings changed).
- **One line.** Every feature, eye or mouth, is a round-capped, round-joined stroke at the same
  weight. A dot eye is a 1-unit vertical stroke (a soft oval a touch taller than wide), a tall eye a
  2.4-unit one, a mouth a line or a shallow curve. Eye size, mouth weight and spacing are therefore
  the same proportions on every face.
- **One grid.** Eyes 8.5 units apart on y = 15, the mouth on y = 19.75: features sit a little low,
  which reads friendlier, and the face's own centre lands on the shape's optical centre. Glances
  (curious, wink) move both eyes 0.9 units; nothing else is per-face.
- **Optical centring per shape**, not the bounding box: an arch's weight is low (face 1 unit down),
  a drop leans away from its tight corner, a hexagon and cookie have less flat room, a pill is
  narrow. The face group is moved and scaled per shape, and the stroke width is divided by that scale
  (`faceStrokeWidth`), so a pill's face has exactly the circle's line. A test keeps every feature
  inside the shape with room to spare.

**Weight:** one weight, `faceWeight(px)`: 2.1 grid units (6.6% of the avatar) at every size,
so 24px and 96px are the same drawing, with a floor of 1.6 device pixels that takes over below about
24px, where a proportional line would go faint. The shape's edge is a 1px hairline at every size on
both clients (`vector-effect: non-scaling-stroke` on desk, `32 / size` on the phone): it's a
silhouette aid, not part of the drawing.

**Colour (tonal):**

- The fill is 24% of the agent's tint over the control surface.
- The ink is 70% of the tint mixed with the primary text colour. These are the mixes the initials
  badge used, which kept every hue above 4.5:1 in both themes.
- A 1px edge in 22% of the tint gives pale tones a silhouette on pale panels.
- **Selected** (the agent you're on) fills solid with the canvas colour as ink, the way a project
  badge turns solid.

**Motion:**

- **Working:** nothing moves. No blink (removed: a closed eye, even for a frame, was the thing the
  owner disliked), and no ring, border or breathing around it (ruled out earlier). The row's live
  step text and clock say it's working.
- **Turn ends:** one bob of 8% of the avatar's size, lasting 500ms.
- **At rest / Reduce Motion:** nothing moves.

**Sizes on desk:**

| Size | px | Where it's used |
| --- | --- | --- |
| `xs` | 16 | |
| `mini` | 18 | Menus, mentions |
| `row` | 24 | Sidebar |
| `field` | 30, or 24 beside a text field | |
| `md` | 40 | Settings card, gallery |
| `hero` | 46 | |
| `xl` | 96 | Picker preview |

**Sizes on phone:** 24, 28, 48 and 56.

## Changing it

- **Desk:** click the avatar beside the name in the agent editor. The look picker opens with a 96px
  live preview, then rows for Shape, Face and Color (colour moved here from Advanced). Each choice
  shows what you'd get.
- **Phone:** tap the avatar on the agent sheet. The same rows appear and save as you tap. This needs
  a Mac that lists `agents.looks` in `welcome.features`. `AgentToggles` gained `avatar` and `color`;
  older Macs refuse unknown fields, so the phone hides the picker for them. New agents made on the
  phone get a free shape too.
- **From chat:** "Give Hiring a hexagon with a curious face". The Chief's `update_agent` takes
  `shape`, `face` and `color` and applies them at once, with no card: a look isn't consequential,
  so it isn't a setting (owner's call). Only what differs from what the agent wears now changes;
  the reply says "Updated Hiring: now a hexagon with a curious face." Real settings still go
  through `propose_settings_change` and its card. In a turn answering outside text (a "When…"
  routine) `update_agent` still asks first, as it does for any change to the team.

## Three directions, and the choice

Every direction uses the same geometry, faces and motion; only the colour treatment differs. To look
at one, add `?avatarDirection=solid|outline` to `harness.html` or `harness-avatars.html`. The unchosen
ones live in `src/harness/avatarDirections.css` and never ship.

### A · Tonal (chosen)

These were captured before the working ring was removed and before the face redraw (open eyes, one
stroke weight); the redraw's before/after contact sheet is made from `harness-avatars.html?section=sheet`
and `pnpm qa:web --only agent`.

| | Dark | Light |
| --- | --- | --- |
| Sidebar of 12 + chat header | ![](avatars/tonal-sidebar-dark.png) | ![](avatars/tonal-sidebar-light.png) |
| 16 / 24 / 40 / 96px | ![](avatars/tonal-sizes-dark.png) | ![](avatars/tonal-sizes-light.png) |
| Every face × shape | ![](avatars/tonal-faces-dark.png) | ![](avatars/tonal-faces-light.png) |
| Colours: rest / selected / working | ![](avatars/tonal-colors-dark.png) | ![](avatars/tonal-colors-light.png) |
| Editor picker | ![](avatars/tonal-picker-dark.png) | ![](avatars/tonal-picker-light.png) |
| Phone list | ![](avatars/phone-list-dark.png) | ![](avatars/phone-list-light.png) |
| Phone agent sheet, picker open | ![](avatars/phone-sheet-look-dark.png) | ![](avatars/phone-sheet-look-light.png) |

### B · Solid

The agent's colour at full strength, with the canvas colour as ink.

| | Dark | Light |
| --- | --- | --- |
| Sidebar | ![](avatars/solid-sidebar-dark.png) | ![](avatars/solid-sidebar-light.png) |
| Sizes | ![](avatars/solid-sizes-dark.png) | ![](avatars/solid-sizes-light.png) |
| Faces | ![](avatars/solid-faces-dark.png) | ![](avatars/solid-faces-light.png) |

### C · Outline

Line art: the silhouette and face in the agent's colour, over an 8% wash.

| | Dark | Light |
| --- | --- | --- |
| Sidebar | ![](avatars/outline-sidebar-dark.png) | ![](avatars/outline-sidebar-light.png) |
| Sizes | ![](avatars/outline-sizes-dark.png) | ![](avatars/outline-sizes-light.png) |
| Faces | ![](avatars/outline-faces-dark.png) | ![](avatars/outline-faces-light.png) |

### Why tonal

- **It keeps the UI monochrome.** The product is monochrome, with each agent's colour as an accent
  that means "this one". Tonal puts colour in the avatar without letting twelve agents out-shout the
  text beside them. It is the same treatment a project badge has.
- **Solid repeats the old mistake.** A sidebar of twelve solid shapes is the saturated sweet row
  again, and light theme makes it worse. Solid also takes away the one visual step "selected" had:
  the selected agent is solid in Tonal, which tells you which agent you're on without a second
  marker.
- **Outline is the cleanest at 96px and the weakest at 24px.** A 1.5px silhouette plus a face is a
  lot of line in a small box, and the shapes shimmer.
- **Tonal stays legible at 16px in both themes.** The face ink holds the contrast the initials had,
  and the edge hairline keeps pale tones from dissolving into light panels.

## Checked, and not checked

**Checked:** these screenshots (harness: desk scenarios `agents-avatars`, `agents-avatars-picker` and
`agents-avatars-chat`, and `harness-avatars.html`; phone: `pnpm qa:web` `agents` and
`agent-sheet-look`), plus the test suites listed in the commit.

**Not checked:** a real WKWebView build, an iOS or Android device (react-native-svg is new and needs a
native build), and bob timing by eye. The harness freezes motion, and qa:web is
react-native-web.
