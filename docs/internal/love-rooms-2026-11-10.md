# Rooms and the agent list, 2026-11-10

A polish pass over two surfaces nobody had looked at lately: **rooms** (several
agents in one thread) and **the agent list** (the sidebar's keys and names,
groups, hidden agents, the board of keys in What's in flight). Desk and phone.
Looked at with the UI harness (light and dark) and `pnpm qa:web`; before/after
shots were taken locally, not committed.

## What each is for, and whether it earns its place

**Rooms.** For the moment you'd otherwise relay between agents yourself: "Acme,
what does the table say? Finance, does that match the invoices?" One thread,
each agent answering for itself from its own session and memory, @mentions
deciding who speaks, a lead when nobody is named. It earns its place: the
mechanics are careful (one place per turn, the 8-reply cap, sealed speaker
headers, files copied to each member) and it reads well. Its weakness is
discovery and identity, not mechanics (see below).

**The agent list.** The app's spine: who needs you, who's working, who said
something, in that order, held still while you use it. It earns its place
without question. **Groups** (by project, or your own) are real and work, but
were undocumented (docs/agents.md still said "Sections are not built") and
reachable only from ⌘K.

**The board of keys** (top of What's in flight). The team at a glance, in the
key metaphor the brand is built on. It's the one place every agent is shown at
full size with its state, so it earns its place as the header of What's in
flight; it isn't a second list to maintain.

## Fixed tonight (ranked by how much they were costing)

1. **One names column in the list.** The Hidden and group chevrons, an empty
   group's line and the room badge were sized to the projects' 24px badge, so
   their words sat 10px left of the agents' names (keys are 30px). Everything
   in the list now starts on the names' column; room badges are a key's size.
2. **A room waiting on you says who, as an agent row does.** Desk: the room row
   was a whole amber sentence ("Acme Site needs your OK"), against the list's
   own rule (one coloured thing per row). Now the pill, then the name. Phone:
   the row said "Needs your OK" and nothing else; it now names the asker too.
3. **Rooms fold like groups.** The plain "Rooms" caption is now the groups'
   header (chevron, count). Folded, the open room and any unread or waiting
   room still show, so folding never hides something new.
4. **Unread rooms take the rows' unread ink** (desk: name heavier, line full
   strength; phone: strong ink). The desk's room dot was hidden by the list's
   clean-right-edge rule, so an unread room looked exactly like a read one
   apart from its preview line.
5. **The open room is the list's Tab stop.** With a room open, Tab into the
   list landed on the first agent.
6. **A paused key says when it's back.** The board said "Paused"; the sidebar
   row beside it said "until 3:42 AM". Now "Paused until 3:42 AM".
7. **Room members: full and too-few say so.** The count reads "1 of 6 · pick
   one more" and "6 of 6 · full"; a full room's other agents dim and say why on
   hover, instead of a checkbox that silently won't tick. Roles drop their
   folder path, as the list does.
8. **Docs.** docs/agents.md now describes groups, the one-column rule and the
   list's keyboard; the rooms section says how a waiting room reads.

## Half-built or confusing (owner decides; nothing removed)

- **Rooms look different on desk and phone.** The desk gives a room its own
  initials tile ("so rooms with the same members still look different"); the
  phone shows two stacked member keys and "+N". Both are deliberate in their own
  docs, and they contradict each other. *Recommendation:* pick one. The
  initials tile is the better identity (two rooms with the same members stay
  distinct, nothing passes for an agent); the phone should adopt it.
- **"Mute" means different things.** An agent's Mute stops notifications but
  unread still counts; a room's Mute stops the unread count. Same word in the
  same list. *Recommendation:* make room mute match agents (notifications only),
  or call the room one "Mute unread".
- **The room's empty state differs by device.** Desk: "Talk to everyone here
  at once. Chief of Staff answers unless you @ someone…" with @ chips. Phone:
  "Month end · Everything said here is posted for everyone in the room…" (the
  room's name glued to a sentence). Neither shows the room's purpose on the
  phone, though the phone receives it. *Recommendation:* one intro line from the
  protocol package, purpose under it, both devices.
- **Rooms are hard to find.** "New room" appears only with two agents; the Chief
  makes rooms well, but nothing tells a user rooms exist until one appears.
  *Recommendation:* when the user asks one agent to check with another twice in
  a day, the Chief offers a room once (as it offers independence changes).
- **Rooms aren't on the board, and the board isn't anywhere else.** The board
  shows agents only; a room with an approval waiting is in Needs you below it,
  not on the plate. Fine for now; worth a row of room "keys" if rooms take off.
- **Groups have no visible entry point.** ⌘K only. *Recommendation:* "Group by…"
  in the list's empty-area right-click, or under Settings → Agents.
- **Room context menu vs header menu.** The header's ⋯ has "Stop replies here"
  while members reply; the row's right-click doesn't, though the doc comment on
  `RoomActionItems` says the two are the same. Minor; left as is.

## Not checked

Rooms and the list in a real Tauri build (WKWebView); the phone on a device
(react-native-web only); dragging into groups (no harness step for it).
