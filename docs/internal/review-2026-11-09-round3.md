# Adversarial review, round 3, 2026-11-09

The third harsh read of `mogbot/foundation` (0c79a114), after agent keys (desk and phone), several
conversations per agent, the morning brief, recipes (share and import), this Mac's apps
(Calendar, Reminders, Notes, Messages), the phone's Needs you with risk-based answering, live phone
alerts, the one Usage view with account names, the Settings window with the Phone page inline, the
new login card, the routines list/editor split and the CPU work. Rounds 1 and 2 are
`review-2026-11-09.md` and `review-2026-11-09-round2.md`; nothing fixed there is re-reported, and
items still open there are named only where a new feature made them worse.

**How it was looked at.** Seen, not inferred:

- Desk: `pnpm harness` on its own port and `TMPDIR`; every scenario light and dark (~500 each) and
  the ⌘K `--commands` sweep (143 commands, none crashed or unmocked). Ids are harness scenario ids.
- Phone: `cd mobile && pnpm qa:web` (light and dark, 256 shots).

**Not checked:** the Tauri build in WKWebView; VoiceOver; the phone on a device (the web build's tab
bar sits over the first row, a known web artifact); live notifications; the real recipe drop on the
window; the CPU changes (no profile taken).

Ranked worst first. Each: where, what's wrong, the fix.

---

## 1. Harness scenarios were passing while showing the wrong screen (fixed here)

**Where.** `agents-keys-picker`, `agents-keys-bind-taken`, `agents-engine-one`,
`agents-schedule-empty`. `src/harness/main.tsx` (`waitFor`, `runSteps`),
`scripts/harness-capture.mjs` (`missingRequired`).

**What was wrong.** New agent now opens describe-first and hides its form with a stylesheet
(`[data-describing]`), not by unmounting it. Steps typed into the hidden name field and `requires`
matched the hidden key preview, so `agents-keys-picker` and `agents-keys-bind-taken` reported ✓
over a screenshot of the Describe box: the agent-keys picker had no visual coverage at all.
`agents-schedule-empty` required a "Nothing scheduled" line the routines split removed.

**Fixed.** A step's target and `requires` must be *drawn* (a layout box, or a drawn child of a
`display: contents` wrapper), and a hidden target fails the run as "in the page, but hidden". The
four scenarios now click "fill it in yourself" or require the editor view. Every scenario was
re-captured light and dark under the stricter rule; nothing else was hiding.

## 2. Recipes: the key you share is not the key you review, and the two readbacks disagree

**Where.** `agents-recipe-share` vs `agents-recipe-review`. `AgentRecipeModal.tsx:43-110`,
`ImportParts.tsx:178` (`ImportAgentRow`), `ImportReviewCard.tsx:255`.

**What was wrong.** The share sheet drew the recipe's own key (`look.colorway`, `look.icon`); the
review card ignored `look` and drew a grey key guessed from the name, although Import applies the
recipe's look (`recipe::apply_look`). The same agent arrived wearing a key nobody had shown.
(Fixed here: the review row wears `p.look`; test in `ImportReviewCard.test.tsx`. The share fixture
also gave Finance a teal inbox key while the sidebar's Finance is orange money; fixed.)

**Still wrong.** Share and review render one recipe twice, differently:

| | Share sheet | Review card |
| --- | --- | --- |
| Apps | "Apps it needs · by name, never your sign-in", comma list | "Apps it needs · here it asks before connecting", bullets |
| Watches | "What it watches for" | "What it watches for · kept in its memory, set up here when you ask" |
| Independence | "Whoever imports it keeps their own unless this is stricter." | "Used only if that's stricter than your team's." |
| Bullets | `•` | `·` |

**Fix.** One `RecipeSections` component for both, with the review's wording (it's the one the
reader acts on); the share sheet adds only "Not in it".

## 3. Routine times are 24-hour in the one place that reads like a sentence

**Where.** `agents-recipe-share`, `agents-recipe-review` ("every weekday at 09:00"); routines the
Chief drafts; the brief's "The morning brief is on, at 07:30 every day". `schedule.rs:915`
(`clock_text`, used by `describe`), `brief.rs:100` (`clock_label`).

**What's wrong.** Every other surface says "9:00 AM" (the schedule editor's echo, "First run
tomorrow at 9:00 AM", "Scheduled · late, was due today at 9:00 AM"). The brief itself mixed
"09:00 Finance" with "failed at 3:00 AM" in one message (fixed here: `brief::hm` writes
"9:00 AM", test updated).

**Fix.** `schedule::describe` is also the agent-facing grammar, so don't change it in place: add a
`describe_for_user` with `%-I:%M %p` and use it wherever the text reaches a person (recipe preview,
review card, `describe` lines the brief and tools quote).

## 4. Paused and "New agent" are the same key

**Where.** `agents-keys-board` (dark), `agents-keys-sidebar`; `AgentKey.tsx:117-131` (one
`socket` branch for `paused` and `new`), `agent-key.css:67-70` (`--agent-key-socket*`); phone
`mobile/src/components/AgentKey.tsx:170`.

**What's wrong.** Both are an empty socket with a cross: Paused has the cross in the agent's colour,
New agent a grey one. On the board they sit side by side ("Native App · Paused" next to "New agent ·
Add one"), and in the sidebar a paused agent's 30px key reads as an Add button. In dark both
sockets nearly vanish into the tray.

**Fix.** Give New agent a plain "+" legend on a *raised* neutral key (it's an action, so it should
look pressable), keep the socket only for Paused, and lift the dark socket's rim
(`--agent-key-socket*` in dark) to 3:1 against the tray.

## 5. Phone: an import is three cards in Needs you

**Where.** Phone `needs-you-light`: "Bring in 2 agents from Grok" (Review), "Here's what your 2
agents will do for you" (Review), "Grok wants to bring its agents over" (Review), all the Chief's,
all counted in the badge (12).

**What's wrong.** One decision, three entries and three counts. On the desk these are one card
replacing the last; the phone keeps every stage pending.

**Fix.** In `mobile/src/lib/needsYou.ts`, fold connector cards of one `talkId` into the newest; the
badge counts that one.

## 6. Two buttons open the same conversations sheet on the phone, none says "new" on the desk

**Where.** Phone `chat-conversation-light`: a speech-bubble icon in the header *and* the
conversation's title under it both open Conversations (`ChatView.tsx:560`, `:633`, `:647`); the
header also keeps the round usage ring that reads as a spinner (round 2 #9 fixed it on the desk
only). Desk `agents-conversations-header`: the switcher is placed between the role line and the
header controls, so the conversation title is cut ("Plan the November launch em…") while the
role line is shown in full.

**Fix.** Phone: keep the title row, drop the header icon, and use the desk's static meter for
usage. Desk: when an agent has more than one conversation, drop the role from the header (it's in
the sidebar row) and give the title the room.

## 7. Phone: a second badge on Projects counts the same requests

**Where.** Phone `agents-light`, `needs-you-light`: Needs you 12, Projects 1.
`mobile/src/app/(tabs)/_layout.tsx:66-69` (`asking`).

**What's wrong.** Round 2 #4 settled "one count, on Needs you". Projects still badges projects
whose agent is asking, which are already in Needs you's 12. Two red numbers for overlapping sets.
The phone's badges are system red; the desk's bell count is neutral.

**Fix.** Drop the Projects badge (its rows already carry the pill).

## 8. Mac apps: the card explains its own mechanics, and What it can reach repeats them per row

**Where.** `agents-mac-apps-card`, `agents-mac-apps-reach`. `mac_apps.rs:1129-1135`,
`connections.rs:140`.

**What's wrong.** The first-use card is four sentences under the exact words ("Allow does this now,
and lets it read your Messages… Anything else it adds, changes or sends follows how much you let it
do on its own. Take it back any time in What it can reach. macOS may ask you once too."). The phone
number is raw ("+15551234567"). In What it can reach every Mac app row says "This Mac's own app;
macOS asks once, in System Settings → Privacy & Security" after a title already ending "· This
Mac", and the two lines touch.

**Fix.** Card: the words, then one line "Allow sends it and lets Hiring read your Messages from now
on." with the rest behind Details. Format phone numbers for display. Reach: "This Mac" once, the
macOS note once under the section.

## 9. TextButton has no affordance, so actions read as prose

**Where.** `agents-schedule-edit`, `agents-when-routines` (footer "…once when it's back. Keep this
Mac awake" — a button that looks like the sentence's unpunctuated end), `agents-login-card`
("Other ways" alone on a line, no chevron), `settings-agents-brief` ("Remove").
`primitives/TextButton`, `AgentsStayOn.tsx:79`, `AgentLoginCard.tsx:227`.

**Fix.** Underline on rest at 40% (full on hover), or a chevron for disclosures ("Other ways ›").
Then the footer can end in a full stop and the link stand on its own.

## 10. The usage card is loudest when it knows nothing

**Where.** `settings-page-accounts`, `usage-unknown`. `UsageStack.tsx`.

**What's wrong.** "No usage reading yet" is set at display size (~34px) over an empty dashed bar,
the biggest type on the page, for the least information. The account row below says the same thing
again ("No usage reading yet. It shows after its next check or turn."). (Fixed here: the single
account's line no longer also explains why to add a second; `ADD_ACCOUNT_WHY` under the buttons
already does.)

**Fix.** Without a reading the headline is the account's name and the one muted line; the display
size is for a reading.

## 11. The key picker: two keys, and O looks like 0

**Where.** `agents-keys-picker` (now captured for real).

- The small key beside the name and the 112px preview are the same key twice, 40px apart.
- The sublegend and the shortcut field use `--font-code` (`agent-key.css:276`): "O" for Bookings
  reads as zero, and the line under it says "Press O". Use the UI face for the sublegend, or a
  mono with a slashed zero and say "the letter O".
- Create is the new agent's teal (round 2 #7 asked for neutral primaries inside an agent's own
  dialogs; this dialog is the clearest case, since the colour changes as you pick).

## 12. Settings → Phone: "this computer" and "this Mac" on one page

**Where.** `settings-page-phone`. `RemoteSetup.tsx:61`, `RemoteAccessModal.tsx:201`,
`remoteAccess.ts:354` ("This computer has to stay on") under "This Mac: set up". The rest of the
app says "this Mac". If the Windows build needs the general word, choose it from the platform
once, in one place.

## 13. What's in flight: "Idle" under seven of eight keys

**Where.** `agents-keys-board`, `agents-team-overview`. `AgentsBoard.tsx`.

**Fix.** Name only; a second line only for a state worth reading (Working, Needs your OK, Paused,
Live). The key already shows idle by being at rest.

## 14. Copy and small seams

- Fixed here: the chat's waiting bar said "<Agent> is waiting on you" while the sidebar pill, the
  requests bar and the phone say "Needs your OK" (`WaitingForYouBar.tsx`).
- Fixed here: the brief's first section was "Waiting on you"; the bell and the phone tab call that
  list "Needs you" (`brief.rs:655`, desk and phone tests, both harnesses).
- Fixed here: "Post on quiet days too" sat under Quiet hours, where "quiet" means something else.
  Now "Post even when there's nothing new" (`companion-protocol/brief.ts`).
- Fixed here: "Add more by asking your Chief of Staff." was repeated on every brief check; now once,
  under the last.
- Fixed here: the conversation switcher's field and the sidebar's both said "Search
  conversations" for two different searches; the switcher's is "Find a conversation" (desk and
  phone sheet).
- Fixed here: the login card said "Asked for “Gmail work”" under the title "…needs your Gmail
  (work)" (`askedForLine`, desk and phone, tested).
- Phone approval title is the engine's raw question ("Do you want to make this edit to
  Hero.tsx?") over "Wants to edit Hero.tsx" (`decisions.rs`): lead with the second.
- Phone conversations sheet: "New conversation" has a chevron (it creates, it doesn't navigate) and
  the accent plus and tick are the agent's blue.
- Phone section labels are still uppercase tracked (AGENTS, ROOMS, DEMO, NOTIFICATIONS) after the
  desk moved to sentence case.
- Phone Settings: "Alerts", "When the app is closed", "Push" — three words for notifications in one
  group.
- `agents-team`: the Chief's phone offer and the requests bar stack above the composer; with a
  brief posted, the brief's "Needs you" section, the requests bar and the bell all say the same
  thing in one view. Consider leaving the bar out of the Chief's chat when the newest message is a
  brief that lists it.
- Fixture seams (fixed here): `agents-conversations*` showed a conversation waiting on you while the
  agent's row, the bell and its key said nothing; the Mac would report the agent waiting. The
  recipe review ran in the Grok import's chat.

## 15. Harness note: a waiting bar under a card in plain view

`agents-mac-apps-card` shows "Hiring needs your OK · Review" directly under the card it points to.
`WaitingForYouBar`'s `useCardVisible` gives up after 10 animation frames; in the capture the row
mounts later and the frames don't advance, so the observer never attaches. Not seen in the real app
(not checked there). If it reproduces in Tauri, watch the chat list with a `MutationObserver`
instead of polling frames.

---

## Fixed in this pass

| | What | Where |
| --- | --- | --- |
| 1 | Harness steps and `requires` must be drawn; a hidden target fails the run | `src/harness/main.tsx`, `scripts/harness-capture.mjs` |
| 2 | Four scenarios repointed (keys picker, key taken, one engine, empty routines) | `agentsKeys.ts`, `agents.ts` |
| 3 | Recipe review row wears the recipe's key | `ImportParts.tsx`, `ImportReviewCard.tsx`, test |
| 4 | Brief times read "9:00 AM" like the rest of the brief | `brief.rs`, `brief_tests.rs`, harness sample |
| 5 | Brief section "Needs you" | `brief.rs`, `brief_tests.rs`, `AgentMorningBrief.test.tsx`, `mobile/__tests__/morningBrief.test.tsx`, both harnesses |
| 6 | "Post even when there's nothing new"; the add-a-check hint once | `companion-protocol/brief.ts`, `AgentMorningBriefSetting.tsx`, test |
| 7 | Waiting bar says "needs your OK" | `WaitingForYouBar.tsx`, test |
| 8 | Switcher search is "Find a conversation" (desk, phone) | `ConversationSwitcher.tsx`, `mobile/src/app/conversations.tsx`, vocabulary snapshot |
| 9 | Login card's "Asked for" only when the title doesn't say it (desk, phone) | `companion-protocol/secretName.ts` (`askedForLine`), `AgentLoginCard.tsx`, `mobile/src/components/LoginCard.tsx`, test |
| 10 | One account: no second "add another" line | `AgentsUsageView.tsx` |
| 11 | Fixtures: a waiting conversation makes the agent wait; recipe looks match the team; recipe review in its own chat | `agents.ts`, `fixtures/recipe.ts`, `agentsRecipe.ts` |

## Left for other agents

2, 3, 5 and 6 are cross-surface (desk, phone, Rust) and want one owner each. 4 and 11 belong with
the keys designer. 7, 8, 9, 10, 12 and 13 are small and independent.
