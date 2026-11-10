# Underloved on the phone, round 2 (2026-11-10)

A second pass over the companion app for what the night's polish didn't reach: screens qa:web
never shot (Send to agent, the skill editor, Remember), rarely-seen states (a skill offer on a
row, a read that fails, the Mac away), and work the phone does that nobody sees (what runs on
every store change, clocks on hidden screens).

**How it was looked at.** `cd mobile && pnpm qa:web --web-port 8145 --mock-port 47545
--cdp-port 9745`, light and dark, read as contact sheets; then the screens above read in code,
since no shot reached them. After: the affected shots again (`--phases live,cached`), plus two
new ones, `skill-editor` and `share-sheet`.

**Not checked:** a device or simulator, VoiceOver, Dynamic Type itself (the web reports
`fontScale` 1), and the desk beyond the one shared function (`whenLabel`).

## Fixed

1. **The tab bar's badge rescanned every chat on every store change.** `(tabs)/_layout.tsx`
   counts Catch up's rows with `feedItems` inside a zustand selector, which runs on *every*
   `setState`: a keystroke in a draft, a streaming reply, the link. Each run walked every loaded
   chat's messages twice. `lib/needsYou.ts` now keeps each chat's waiting cards per `messages`
   array (the store replaces it whenever that chat changes) and the last answer per input, so an
   unrelated change costs one identity check. The landing and the tab itself share the cache.

2. **A skill offer's row spoke the Mac's fallback.** Catch up's row, the agent row's
   "Needs your OK · …", the chat's pinned banner and the notification all read
   `approval.summary`, which the Mac writes for clients that don't know `skill`: "When to use it:
   When the user asks…". The card itself says "When you ask…" (`skillWhenLine`). `askingLine`
   now says what the card says, keeping what the Mac adds after it (it replaces one, details
   removed, outside content read), with a stop between.

3. **A newer skill offer stood in for the card an agent is stopped on.** `pendingApproval` took
   the newest pending card, so Finance, blocked on a deploy, read "Needs your OK · When to use
   it: …" offline (`offline-agents`). The newest blocking card comes first; an offer only when
   it's all there is. Same for the chat's pinned question and Talk.

4. **The skill editor (never shot).** Its fields were labelled only by placeholders, so a filled
   one said nothing about which was "When to use it"; Save was on with nothing changed; and *any*
   failed read (offline, a timeout) said "That skill isn't there any more", which is the
   "never assume data" rule broken. Labels now sit above the fields (as Schedule's What), Save
   waits for a change, and a failed read says why, or "Reading it needs your Mac." offline and
   reads again when the Mac is back. Shot: `skill-editor`.

5. **The last all-caps labels.** Section labels went to sentence case yesterday (e2723ead8), but
   the When… composer (`WHEN THIS HAPPENS`, `CHECK EVERY`, `THROUGH`, `WHAT`, via
   `.toUpperCase()` on the desk's own sentence-case words) and Send to agent ("PUT IT IN A CHAT
   FOR YOU TO SEND", with a literal letter-spacing) were missed. Both now match the desk and the
   rest of the phone. Send to agent also stopped saying "Connecting to your Mac…" forever when
   the Mac is away with nothing saved. Shot: `share-sheet`.

6. **Remember.** "Summarizing…" where the desk says "Summarising…"; and offline, Remember was
   simply off with no reason. It now says "Remembering it needs your Mac."

7. **A drafted agent's routines in the grammar's clock.** New agent's review (desk and phone)
   showed "Every weekday at 08:00" while the picker, the echo and every other time say
   "9:00 AM". `whenLabel` formats the grammar's "at HH:MM" with `clockAt`, so it follows the
   Mac's 12/24-hour setting like the rest.

8. **Minute clocks on hidden chats.** `useQuotas` (the header's usage ring) and the pinned
   page's "Updated … ago" each ran a bare 60 s interval, so every chat in the stack re-rendered
   the whole `ChatView` once a minute, under a sheet or in the background. Both use `useNow`,
   which holds while the screen isn't showing and catches up when it is. `useNow` moved to
   `lib/moving.ts` beside `useShowing` (lib code was importing it from a component).

## Seen and left

- The When… mail/text filters ("From (optional)…", "With these words…") also lose their label
  once filled. The echo box under them spells out the routine in full, and the words are the
  desk's; left.
- The agent row's offline preview is the Mac's `preview`, which for a skill offer is its
  summary; that's the Mac's to word.
- `catchup-done` sits 20 pt high in the web shot; the whole document scrolled, a web artifact.
