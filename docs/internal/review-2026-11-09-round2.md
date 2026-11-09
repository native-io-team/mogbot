# Adversarial review, round 2, 2026-11-09

The second harsh read of `mogbot/foundation` (bf87d296), after the batch that landed two-screen
onboarding, the Usage view and its segmented meter, the Settings window with a section list, one
Independence slider, describe-first New agent, the Needs-you bell, the header Model menu, result
cards that lead with the work, new-agent starters, import from exports, and the phone's Needs you
tab and request view. Round 1 is `review-2026-11-09.md`; this one hunts the seams between those
pieces.

**How it was looked at.** Seen, not inferred:

- Desk: `pnpm harness` on its own port and `TMPDIR`; every scenario captured light (499) and dark
  (498), plus the ⌘K `--commands` sweep. Ids below are harness scenario ids
  (`harness.html?scenario=<id>`).
- Phone: `cd mobile && pnpm qa:web` (light and dark, ~210 shots).

**Not reported, on purpose:** avatars (being replaced by agent keys).

**Not checked:** the real Tauri build in WKWebView; VoiceOver; a keyboard walk beyond the
harness's keyboard scenarios (`settings-page-keyboard`, `settings-agents-independence-keyboard`
pass; not looked at closely); phone screens on a device (the web build's tab bar sits at the top and
covers the first row, a known web artifact).

Ranked worst first. Each: where, what's wrong, the fix.

---

## 1. Usage and accounts have two homes that disagree about the same reading

**Where.** Agents → Usage view (`usage-three`, `usage-one`) vs Settings → Accounts & usage
(`settings-agents-usage`, `settings-agents-accounts`). Code: `AgentsUsageView.tsx` /
`UsageStack.tsx` vs `AgentsSettings.tsx:173` (`AccountsPage`, which mounts the older
`AgentUsageSettings` from `AgentsUsage.tsx` and `AgentAccounts.tsx`).

**What's wrong.** The same 5-hour reading reads **"62% left"** in the Usage view and **"38%"** (used)
in Settings, two clicks apart. The view names the account "sam@example.com" and orders accounts by
drag; Settings names it "Claude · This Mac" and orders them with ↑/↓ buttons. The view's headline
is "Room to work"; Settings' is "Room now on 2 of 3 accounts". The mode control, crossover choice
and spare-capacity list exist in both. ⌘K "Usage and accounts…" opens the view; the Settings
section list opens the other.

**Fix.** One rendering. Settings → Accounts & usage mounts the Usage view's parts (the stack, the
keys, the mode control) or is a single row "Usage and accounts · Open" that opens the view. Delete
the "What you have" sheet and the ↑/↓ list from `AgentsUsage.tsx` / `AgentAccounts.tsx` once
nothing mounts them. Then always say "left", never "used".

## 2. "This Mac" is still an account's name in three places

**Where.** `settings-agents-accounts` (rows "This Mac" under Claude Code and Codex),
`settings-agents-usage` ("Claude · This Mac"), phone `settings-light-p0` (fourth key
"Signed in on t…"); fixed here in the nudge ("62% of This Mac's 5-hour limit" under a key titled
sam@example.com). Code: `AgentAccounts.tsx`, `AgentsCompute.tsx`, the inventory's `accountName`.

**Why it matters.** Round 1 #2. Account stacking is the lead promise and the user's first account
still has two names on one screen.

**Fix.** Name every account by its key's name (`usageGlance` keys: email, else the label the user
gave it). The inventory's `accountName` should never reach the UI directly; route it through the
key as the nudge now does.

## 3. The phone didn't get describe-first New agent

**Where.** Phone `new-agent-light` vs desk `agents-new`. `mobile/src/app/new-agent.tsx:272`.

**What's wrong.** Desk opens on one box and **Draft it**, with "fill it in yourself, start from
Research…, or ask your Chief of Staff" as quiet links. The phone opens on Start from chips, the box,
**Draft the rest**, the name field, 11 colour swatches and 10 shape keys, and "Ask Chief of Staff
instead". Two names for the draft button, two for asking the Chief, two orders.

**Fix.** Port the desk's order: the box and **Draft it** alone; the form, colours and shapes behind
"Fill it in yourself"; "Ask your Chief of Staff" as a link.

## 4. Phone: one waiting request is still said three times, and the count disagrees with the list

**Where.** Phone `agents-light`, `needs-you-light`. `mobile/src/lib/home.ts:77`,
`mobile/src/app/(tabs)/agents/index.tsx:538`, `mobile/src/app/(tabs)/_layout.tsx:14-56`.

**What's wrong.** The Needs you tab carries a badge, the Agents tab still leads with a "5 agents
need your OK" bar, and every row carries a Needs your OK pill (the desk dropped its duplicate in
"Needs you is said once per surface"). The badge counts **agents** (5) while the Needs you list
shows **cards** (six and more: the Chief alone has three).

**Fix.** Drop the Agents tab's bar now that the tab exists (the badge points there). Count what the
list shows (cards), or group the list by agent so 5 means 5 rows.

### 4b. Phone Needs you: a delete-for-good is a one-tap black Allow in a list

**Where.** Phone `probe-needs-you-light-p0`: "Temp Helper · Delete files · rm -r ~/Exports/2024"
answered in place with the same Deny / **Allow** pair as a harmless edit, no danger icon, between a
"Review" and an "Answer" card (two button treatments in one list). The rule is length only:
`fitsWhole` in `mobile/src/lib/needsYou.ts:148`, which the Lock Screen's Allow/Deny
(`mobile/src/lib/actionable.ts`) uses too (Allow there does require unlocking).

**Why it matters.** Deleting for good is on the floor list. The desk tells danger apart by an icon
as well as hue ("One look"); here nothing does, and the list invites fast thumbs.

**Fix.** Floor actions (deletes, money, credentials, pushes to production) never answer in place:
they get Review and the full request view. Where Allow stays in place, mark danger with the icon.

## 5. Phone Agents list still shows the old usage line

**Where.** Phone `agents-light` ("Claude usage 41% · resets Thu") vs desk sidebar glance
("Room to work · 3 accounts · resets 8:13 PM"). `mobile/src/app/(tabs)/agents/index.tsx:353`
(`QuotaLines`).

**Fix.** Use the protocol's `usageGlance` there, as the phone's Usage screen and the desk already
do, and retire `QuotaLines` from the list.

## 6. The login card is unchanged since round 1

**Where.** `agents-login-card`, `agents-login-failed`. `AgentLoginCard.tsx`.

**What's wrong.** Five blocks of 12–13px text (asked for, purpose, abilities, how the browser
route works, a second route with its own paragraph) and **Not now / Not needed / Use my browser**
side by side. "Connect in Claude instead" says "Claude"; elsewhere it is "claude.ai".

**Fix.** Round 1 #4: lead line, abilities, one line for the chosen route, the rest behind "Other
ways in". **Not needed** → **Don't ask again** (it is used in `TeamLogins.tsx`, `TeamSetupCard.tsx`,
`SignInHelp.tsx` and on the phone, so change all at once).

## 7. Schedule and When… popover: still one overloaded sheet

**Where.** `agents-when-routines`, `agents-schedule-edit`. `AgentSchedulePopover.tsx`,
`AgentWhenRoutine.tsx`.

**What's wrong.** Round 1 #12 minus the person mismatch (fixed here: the choices now say "you",
like the readback). Every row has a red **Delete** at the weight of Edit; the list, the composer and
the cost notes share one popover; Add is the agent's colour (teal for Lead Gen).

**Fix.** Delete into a row menu; the composer in its own sheet; the primary button neutral inside an
agent's own popovers.

## 8. Settings is a window in name only, with a page that is two "Open" buttons

**Where.** `settings-page-phone`, `settings-agents`, `settings-page-*`.
`SettingsModal.tsx`, `AgentsSettings.tsx:200` (`PhonePage`).

**What's wrong.** Settings is a modal over the app (the chat shows above it) whose content column
stops two thirds across. The Phone page says "Phone" three times (page title, the group "Away from
your desk", the row "Phone") and holds only two **Open** buttons, each opening another modal on top
("Get the phone app", Remote access).

**Fix.** Render the phone panel and Remote access inside the page. Let the column fill to a
readable max and drop the group title when a page has one group.

## 9. Header controls: routines still wear the history icon; a small ring still reads as a spinner

**Where.** Every chat header; `agents-sidebar-overflow` (header ring at 22%).
`AgentUsageRing.tsx`, the routines button in `AgentChat.tsx`.

**What's wrong.** Round 1 #16 got the word "Usage" when nothing is read, but a thin ring a fifth
full looks like a loading spinner, and "Routines" / "3 scheduled" still use the clock-with-arrow
history icon (also on the in-chat "Scheduled" lines).

**Fix.** Show "Usage 22%" as text beside the dial, or the dial with a track at full contrast; a
calendar-clock icon for routines.

## 10. Amber for estimates, not just for "needs you"

**Where.** `usage-three` ("At this pace it runs out Wed morning" and the weekly bar in amber),
phone `settings-light-p0` (the whole headline "Runs out in about an hour…" in large amber).
`usage-view.css:505` (`.usage-key__pace`), the phone's usage stack headline.

**Why it matters.** The brand rule: amber means needs you. A forecast is information, and an
estimate printed in the alarm colour reads as an alarm.

**Fix.** The pace line in `--text-secondary` with a small warning icon only below ~10% left; the
phone headline in ink with the tone on the meter only.

## 11. The Chief's greeting is still a centred paragraph with "…" chips

**Where.** `onboarding-end-to-agents`. Round 1 #18, unchanged: the first thing
after onboarding is laid out unlike every other message, and the starters ("Brief me every
morning…") read as truncated.

**Fix.** Left-align it as the Chief's first message; starters without the ellipsis.

## 12. Onboarding leftovers

**Where.** `onboarding-engine-pick`, `onboarding-engine-install` (dark).

- Fixed here: the progress grid kept five columns from the five-step flow, so the three-part bar
  sat left of centre and its label sat under the *last* segment ("Welcome" under step 3).
- Still two progress systems: the bar and "Claude Code · 1 of 2" (round 1 #15).
- Engine cards: the card is the selection but the action is a small compact "Install & sign in →"
  inside it (round 1 #15).

## 13. Sidebar row cuts the informative half of a request

**Where.** `agents-team` (Lead Gen: "Needs your OK · Send …", 44px of "Send an email · Gmail"
shown). `AgentsSidebar.tsx`, `.agents-list__rest`.

**Fix.** Drop the generic verb and keep the object ("Gmail"), or let the pill shrink to its dot when
the row is narrow so the words get the room.

## 14. Two names for the one inbox of things waiting on you

**Where.** Desk bell: "What's in flight · 1 needs you" (`AgentsSidebar.tsx:233`); phone tab:
"Needs you". Same list, two names.

**Fix.** Pick one. "Needs you" is the shorter and is what the bell counts; What's in flight can be
the view's working half.

## 15. Projects still speaks the older dialect

**Where.** `mode-toggle-workspace`, `mode-toggle-compact-workspace`, `dashboard`. Round 1 #14: the
uppercase tracked labels (PINNED, ACTIVE, SESSIONS, TERMINALS, DEV SERVER, ENGINES on "Tools &
services"), grey "No preview" blocks.

## 16. Dark: the Agents | Projects thumb barely separates from its tray

**Where.** `agents-team` (dark). The selected key is a dark grey on a slightly darker tray; the
light theme's white key has no dark counterpart with the same contrast.

**Fix.** Lift `--tabs-key-*` in dark (a lit top edge and a step lighter face), and check 3:1 for the
thumb against the tray.

## 17. Harness scenarios that broke silently in the merge (fixed here)

Eighteen scenarios were capturing the wrong screen or nothing:

- `agents-quota-calm`, `agents-sidebar-overflow`, `agents-quota-limited` required the sidebar's
  old quota line, which the usage glance replaced.
- `settings-agents-usage*` (5), `settings-agents-usage-crossover`, `agents-heavy-settings` ran ⌘K
  "Usage and accounts…", which now opens the Usage view, not Settings.
- `phone-install-*` (6), `phone-remove-confirm` clicked the Phone row on Settings' first page; it is
  on the Phone page now. `team-attribution-setting` needed Settings → Projects.

All now pass. `mode-toggle-compact-workspace` and `dashboard-long-names` failed once each under
load and pass on a re-run.

## 18. Small things

- Model menu: the routines section was headed "Routines run on Fastest" above a ticked
  **Automatic** (fixed: "Routines · the model they wake on", with what Automatic and Same come to
  beside each, as the engine names sit beside the models).
- New agent: three link styles in one dialog (underlined ink, muted label-looking "Or describe it
  instead", and "Ask your Chief of Staff to set it up" in the new agent's pastel colour). Fixed:
  one link style.
- Result card: "It says it checked" sat unboxed beside a boxed "Not verified", so the two halves
  didn't line up. Fixed: one box style for both.
- Usage view: "Used by these agents" and wrapped pace lines had no leading of their own; lines
  touched. Fixed.
- The usage row in the sidebar showed a green "fine" dot beside "No usage reading yet". Fixed: no
  dot until something is read (Never assume data).
- The sidebar row said "Out of usage" then "resets Thu 4:00 AM"; the chat said "out of usage until
  Thu at 4:00 AM". Fixed on desk and phone: the row reads as the one phrase, "Out of usage · until …".
- Phone usage headline "Runs out ~in about an hour" (fixed: the "~" is dropped when the phrase
  already says "about").
- Dead CSS from removed pieces, deleted: the team policy presets (`agents-policy.css`), the
  sidebar quota line (`agents-quota.css`), `.agents-list__asking`. Still unreferenced and worth a
  look: `.agent-dot`, `.agent-when__spent`, `.agent-changes__branch`, `.agent-apps__notes`,
  `.agent-bubble__remedy`, `.agent-secrets__vars`, `.agent-composer__notice`.
- Phone approval card still ends in "It paused here for you. Allow it and it picks up where it
  left off." (round 1 #19).
- ⌘K sweep (142 commands, none crashed or unmocked): `layout.dock.editor`, `layout.dock.team`,
  `layout.dock.variables`, `layout.move.team`, `layout.move.variables` change nothing visible
  from the sweep's starting view. Either they need a panel open first (then they should be
  hidden until it is) or they silently do nothing.
- Settings opens at two sizes: near full-window from Agents (`settings-page-*`), a smaller
  centred modal from Projects (⌘K `agents.desktopSettings`).
- Mobile jest in a fresh worktree fails to resolve `@babel/runtime` for files under
  `packages/companion-protocol` unless `NODE_PATH=mobile/node_modules` is set; with it, all 102
  suites pass. Tooling, not product.

---

## Fixed in this pass

| | What | Where |
| --- | --- | --- |
| 1 | Usage row: no green dot before any reading | `AccountSwitcher.tsx` (`glanceStatus`), test |
| 2 | "Out of usage · until …" on the row, desk and phone | `src/lib/agents.ts`, `mobile/src/lib/agents.ts`, test |
| 3 | Spare-capacity nudge names the account as its key does | `companion-protocol/usageGlance.ts`, test |
| 4 | No "~in about" | `companion-protocol/usageGlance.ts`, test |
| 5 | Model menu routines heading and resolved model beside Automatic / Same | `AgentModelMenu.tsx`, test |
| 6 | When… choices in the readback's person ("you") | `AgentWhenRoutine.tsx`, test |
| 7 | One link style in New agent | `agents-dialogs.css`, `AgentEditorModal.tsx` |
| 8 | Result card Checks halves in one box style | `agents-results.css` |
| 9 | Onboarding progress bar centred, label under the current segment | `FlowParts.tsx`, `onboarding-flow.css` |
| 10 | Usage key lines get their own leading | `usage-view.css` |
| 11 | 18 harness scenarios repointed | `src/harness/scenarios/{agents,agentsUsage,agentsCrossover,agentsHeavy,phone,phoneInstall,team}.ts` |
| 12 | Dead CSS removed | `agents-policy.css`, `agents-quota.css`, `agents.css` |

## Left for other agents

1–5 are product decisions with a cross-surface owner (1 and 2 together; 3–5 are phone parity).
6, 7, 8 and 11 are contained UI work already described in round 1. 9, 10, 13, 14 and 16 are small
and independent.
