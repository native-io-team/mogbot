# Adversarial review, round 5, 2026-11-10

A harsh read of tonight's features **together** on `mogbot/foundation` (48c527919): the living page
per conversation, saved skills ("Save what it learns", the skill card, "What it knows how to do"),
rewind / fork / edit and resend, Mail and Messages "When…" routines, step in (desk and phone), chat
blocks and the morning brief, OpenCode as an engine. Each was built by a different agent; the
question here is whether they know about each other. Rounds 1–4 are `review-2026-11-09*.md` and
`review-2026-11-10-round4.md`; nothing fixed there is re-reported.

**How it was looked at.** `pnpm harness` on port 2581 with its own `TMPDIR`: the `agents-page*`,
`agents-skill*`, `agents-editor-skills`, `agents-go-back*`, `agents-when*`, `agents-step-in*`,
`agents-blocks*` and `agents-morning-brief` scenarios, light and dark at 1280, and light at 820
(narrow, header actions icon-only). Scenarios fix their own 1280 viewport, so the narrow pass needed
`HARNESS_FORCE_WIDTH` (added to `scripts/harness-capture.mjs`); below 750px they can't open an
agent (they click the sidebar), so the compact window wasn't captured. Phone:
`pnpm qa:web --only page-,goback-,chat-skill,agent-sheet-,blocks-,schedule-when,chat-` (light, plus
the chat shots dark). All captured scenarios passed. Shots:
`/private/tmp/claude-501/-Users-juliangalluzzo-Desktop-Projects-dashbot/125bf15b-3c9c-40f4-ae0e-f7068fb1acc8/scratchpad/round5/`.

**Not checked:** WKWebView; the compact (<750px) desk window with a page pinned; the phone step-in
shots (they need the probe phase); the full ⌘K `--commands` sweep (commands were read from the
registry instead); OpenCode screens beyond the engine picker (no new scenario); VoiceOver.

Ranked worst first. "Fixed here" items carry tests; the rest are left with the fix.

---

## 1. A skill offer said "Needs your OK" everywhere while the card said "Nothing waits on it" (fixed here)

**Where.** `agents-skill-card` (sidebar), the Dock badge, the bell, the phone's Catch up.
`store::count_pending`, `skills_learn::call`.

**What was wrong.** The skill card is an approval, so it counted in `pending_approvals`: the agent's
row wore "Needs your OK" with the card's summary as its preview, the bell and Dock badge went up, and
the phone counted it, while the card itself says "Nothing waits on it". Two features (approvals and
skills) disagreeing about what a card means, and the louder one winning.

**Fixed.** `count_pending` skips skill cards, so the registry, badge, sidebar, bell and phone (all
fed by `pendingApprovals`) agree with the card. The card still shows in the chat with Save / Not now.
Test: `store::tests::a_skill_offer_never_counts_as_waiting_on_the_user`. The harness fixture no
longer gives Finance a pending count.

## 2. Step in showed Show window and Hand back twice, with opposite weights (fixed here)

**Where.** `agents-step-in-active`. `AgentStepIn.tsx`.

**What was wrong.** While you're in an agent's browser, the card in the chat had Show window
(outlined) and **Hand back** (strong), and the bar right under it had Show window (a link) and Hand
back (outlined). Same two actions, a few pixels apart, ranked differently: it reads as two different
hand-backs.

**Fixed.** In its own agent's chat (where the bar always shows) the card only says "You're in its
browser now. Hand back from the bar below when you're done."; the bar holds both actions. Drawn
anywhere else (the team view, another chat's requests panel) the card keeps them, since no bar is
there. Test in `AgentStepIn.test.tsx`; docs/agents.md and the scenario caption updated.

## 3. The pin meant three things, and an unpinned page had an unlabelled pin in the header (fixed here)

**Where.** `agents-page-unpinned` (1280 and 820). `ConversationPagePin`.

**What was wrong.** The pin icon means "pin this agent" in the sidebar, "Remember this" on the
phone's message sheet, and "Pin the page" in the chat header. In the header it was icon-only among
labelled actions (Routines, Model), so it read as pinning the agent.

**Fixed.** It's a labelled ghost action, pin + **Page**, the same pattern as Routines (the word hides
when the header is narrow, the accessible name keeps "Pin the page “…”"). **Left:** the phone's
"Remember this" still uses `pin`; a bookmark or memory glyph would end the overlap.

## 4. On the phone, an unpinned page could never come back (fixed here)

**Where.** `mobile/src/components/ConversationPage.tsx`.

**What was wrong.** The phone's page bar has Unpin, and an unpinned page rendered nothing. The desk
brings it back from the header; the phone header has no room for that, and there was no other
way. A control on one surface with its inverse only on the other.

**Fixed.** Unpinned, the phone shows one quiet line, pin + "Page: November budget" + Pin; tapping it
pins the page again. Test in `mobile/__tests__/conversationPage.test.tsx`.

## 5. ⌘K didn't know about skills, or the page's fold and versions (fixed here)

**Where.** The palette registry. `AgentsView.tsx`, `ConversationPage.tsx`.

**What was wrong.** Coverage per feature: rewind / fork / edit had ⌘K (your last message); Pin page
had it; a When… routine and the morning brief had it; step in had "Hand <Agent> its browser back".
Skills had nothing, and they live at the foot of a long agent editor, eighth section down, under
the fold: the least findable thing shipped tonight. The page's versions sit behind "Updated 3 min
ago · v4", which doesn't read as a control until pressed.

**Fixed.** ⌘K "What <agent> knows how to do…" opens the editor scrolled to the section
(`initialFocus`); "Fold / Show the page “…”" and "What changed on this page". Tests in
`AgentSkills.test.tsx` and `ConversationPage.test.tsx`. **Left:** "Step in" itself (answering a
pending step-in card) is only on the card, though ⌘K's Allow top request covers ordinary cards.

## 6. The phone's message sheet mixed Title Case and sentence case (fixed here)

**Where.** `goback-sheet` (phone). `mobile/src/lib/actions.ts`.

**What was wrong.** One sheet: Copy, Quote, **Select Text**, **Remember This**, then Edit and resend,
Fork from here, Rewind to here. The new items followed the app's sentence case; the old ones
followed iOS's. Read together it looked like two menus glued.

**Fixed.** "Select text", "Remember this" (the app's own case, as on the desk); tests, the qa:web
caption and docs/mobile.md updated.

## 7. An opened "Rewound" fold looks exactly like the live conversation (left)

**Where.** `agents-go-back-rewound-open`, phone `goback-rewound-open`.

Opened, the passed-over messages sit between the fold line and the next live message with the same
ink, bubbles and spacing as the messages that count. Only the note at the end says which is which.
Fix: give opened rows a muted treatment (reduced opacity on the bubbles, or a hairline rule down the
left of the run) and close the run with a quiet "End of what was rewound" line. On the desk the rows
must stay direct children of `.agent-chat__messages` (`foldRows`), so mark them with a data
attribute from `foldRows` rather than wrapping them. Also: the desk's fold line has a chevron only,
the phone's has the rewind icon plus a trailing chevron; pick one.

## 8. A pinned page takes 42% of the window before the chat gets anything (left)

**Where.** `agents-page`, `agents-page-history`, phone `page-chat`.

At 1100px tall the page band is ~380px; at 900 or on a 13" laptop it's most of the space above the
composer, and step in, editing, the import bar and the requests bar all stack on top of it. Opening
the versions list pushes the page's own content below its scroll. The page and the chat's blocks
also use the same raised tiles, so a metric on the page and a metric in a reply look identical; only
position tells them apart. Fix: cap the band by pixels as well (`min(42vh, 320px)`), fold the page by
default when the window is short or a bar is showing, give the band a recessed surface so it reads as
pinned furniture rather than a reply, and put the versions list in a popover off the "Updated" line.

## 9. Go back hides behind an unlabelled "…" that only shows on hover (left)

**Where.** `agents-go-back-menu`.

The only way in on the desk is a `…` beside your own message on hover, titled "Edit, fork or
rewind". The ⌘K commands act on your *last* message only. Nothing in the empty state, the fork note
or the conversation switcher says Fork exists. Fix: a right-click menu on your messages with the same
three items, and "Fork this conversation" in the conversation switcher's menu (forking at the last
message).

## 10. Words for one idea still differ (left)

- The skill card says "Save … as a skill?", the saved line says "Learned a skill", the editor says
  "Save what it learns" / "What it knows how to do", the doc says "skills". "Skill" is fine in the
  card; the editor heading could carry it ("What it knows how to do · skills") so the palette's
  "skills" keyword and the card meet.
- The page's history says "by a routine"; routines elsewhere are named. Name it when known.
- Step in's card source line and its bar detail both show the host; the card also adds "Verify your
  identity" from the page title. Fine, but the bar should carry the same page title so you can tell
  two step-ins apart.

## 11. The skill card and approval cards share one look (left, deliberate)

Both are the same Card with a neutral strong answer; the skill card adds a graduation cap and, read
outside, the warning tone. That matches "One look", but with #1 fixed the card no longer means "this
blocks", and nothing visual says so. Consider the quieter answered-card ink for its body (muted steps)
so a scan of the chat sees it as an offer, not a gate.
