# Spacing audit, 2026-11-09

Balance, white space, alignment and gaps, desk and phone. Worst first. Every number is measured
in CSS px from the harness (`getBoundingClientRect` and computed styles in headless Chrome at
1280 and 1600, light and dark) or read off the phone captures (`mobile && pnpm qa:web`, 402pt @3x).
Crops are before/after pairs in [`spacing-audit-2026-11-09/`](spacing-audit-2026-11-09/).

Score: **5** broken (things touch or overlap), **4** cramped enough that a person notices, **3** off
the rhythm or misaligned by a step, **2** a polish item, **1** taste.

## Fixed

| # | Score | Surface | Before (measured) | After | Where |
| --- | --- | --- | --- | --- | --- |
| 1 | 5 | Chat header at 900px | The account email ran under the agent's name and the conversation switcher (overlapping text). Role sentence cut at every width | Identity at the leading edge: key, name, then quiet chips (project, account as the email's name part, conversation). The role is the name's tooltip. Usage, Routines, Model are one family: ghost, icon + word, 30px, 4px apart. Narrow: account chip goes (≤720px header), then words (≤600px), then project chip (≤440px). [hdr-1280-light](spacing-audit-2026-11-09/hdr-1280-light.png), [hdr-1600-dark](spacing-audit-2026-11-09/hdr-1600-dark.png), [hdr-900-light](spacing-audit-2026-11-09/hdr-900-light.png), [hdr-700-light](spacing-audit-2026-11-09/hdr-700-light.png) | `agents-chat.css:68`, `:80`, `:165`; `AgentChat.tsx` title; `AccountSwitcher.tsx` `shortAccountLabel`; `AgentUsageRing.tsx`, `AgentModelMenu.tsx`, `AgentSchedulePopover.tsx` |
| 2 | 5 | Sidebar usage row | Headline, meter and summary **1px** apart at a line height of **1** (11px text in 11px boxes): words sat on the meter | 4px steps, compact line height, 6px inset; the icon's centre within 1px of the headline's. Later superseded by the usage redesign's own row padding (merged), which keeps the 4px steps. [01-usage-row](spacing-audit-2026-11-09/01-usage-row.png) | `usage-view.css:25` |
| 3 | 4 | Working line under a reply | The toggle was underlined at **2.2px** under 11px text; the activity span's own clip cut the underline in half (only the "· 5 steps · 6:01" half showed on hover) | No underline at rest (the finished "Worked …" line has none either). Hover and focus: a ghost fill bled 4px round the words with `box-shadow`, so nothing moves. [00b](spacing-audit-2026-11-09/00b-working-line-hover.png), [00c dark rest vs hover](spacing-audit-2026-11-09/00c-working-line-dark-rest-vs-hover.png) | `agents-work.css:229` |
| 4 | 4 | Underlines everywhere | Text buttons at 0.2em, five feature files at a raw **2px** | One token, `--text-underline-offset: 0.3em` (3.3px at 11px, 3.9px at 13px) | `tokens-semantic.css:192`, `text-button.css:23` |
| 5 | 4 | Usage view | Lines at the app's line height of **1**: "78% left this week / Refills in 4d 23h" and every account/left pair touched; mode control a full-width tray with three options bunched left; Limits/Tokens floating between sections; "Used by" a run of lines with **1px** gaps; notice text tight and its 20px buttons **4px** from it; account head top-aligned; limit card **2px** between its lines | Panel line height 1.3; hero lines 8px apart; mode control hugs; Limits/Tokens at the right of the Accounts heading; "Used by" a table (name / tokens / turns, hairlines, right-aligned numbers); notice 24px to actions, 30px buttons 8px apart; head centred on one line, 12px gaps; 16px round the key, inside each limit and between its groups; 12px to the Add-account footnote. [dark](spacing-audit-2026-11-09/usage-same-account-1280-dark.png), [light](spacing-audit-2026-11-09/usage-same-account-1280-light.png), [notice](spacing-audit-2026-11-09/usage-signin-changed-1280-light.png) | `usage-view.css:271`, `:373`, `:420`, `:523`, `:542`, `:844`; `AgentsUsageView.tsx` `viewSwitch`; `UsageStack.tsx` spent rows |
| 6 | 4 | Header hit areas | Model and the conversation switcher **20px** tall among 30px controls | 30px, one height across the header | `agents-chat.css` (`.agent-chat__header … .button--size-compact`) |
| 7 | 4 | Bars over the composer | **4px** above and below two lines of text (39px bar) | 8px (47px); right inset kept at 8px so Review ends on the send button's edge (both at x=1102/1103) [02](spacing-audit-2026-11-09/02-card-bar-composer.png) | `agents-surfaces.css:199` |
| 8 | 3 | Chat cards | Actions **8px** under the body, same as the title above it; compact answers **20px** (below the 28px desk target) beside a 30px Allow | Actions 12px under the body (title keeps 8px); every card and bar answer 30px [02](spacing-audit-2026-11-09/02-card-bar-composer.png), [09](spacing-audit-2026-11-09/09-approval-card.png) | `agents-surfaces.css:85`, `:91` |
| 9 | 3 | What's in flight | Rows inset **8px** from their own heading and "Nothing is waiting on you" (key at x=435, heading at 427) | Rows bleed left: key on the heading's edge; the answered card under a row keeps its name-to-meta span [04](spacing-audit-2026-11-09/04-in-flight-rows.png) | `agents-team.css:111` |
| 10 | 3 | Model menu | Section headings **4px** left of the items' text (x=1006 vs 1010) | On the items' text edge [05](spacing-audit-2026-11-09/05-model-menu.png) | `agents-menus.css:238` |
| 11 | 3 | New routine popover | Frequency chips **4px** apart both ways | 8px [07](spacing-audit-2026-11-09/07-routine-chips.png) | `agents-dialogs.css:374` |
| 12 | 3 | Independence slider | "Asks a lot / Just does it" half a thumb outside the track (15px left of "Careful") | On the track's ends | `agents-independence.css:18` |
| 13 | 3 | New agent (Describe) | Draft it **4px** under the textarea, the same as the label above it | 8px: the label belongs to the field, the button is the next group [10](spacing-audit-2026-11-09/10-describe.png) | `agents-steps.css:152` |
| 14 | 2 | Composer | Mic and send **2px** apart | 4px | `agents-composer.css:103` |
| 15 | 2 | Starter chips, Add account buttons | Bordered chips/buttons **4px** apart; Add buttons 4px over their footnote | 8px apart; 12px to the footnote | `agents-chat.css:316`, `usage-view.css` `.usage-add` |

## Not fixed (noted)

| Score | Surface | What | Why not now |
| --- | --- | --- | --- |
| 3 | Segmented `Tabs` (sidebar Agents/Projects) | Each tab is a **24px** target, under the 28px desk minimum | The tray/keycap is a design-system component used app-wide; changing its height moves every segmented control. Worth a deliberate pass |
| 3 | Sidebar "Hidden · 1" | Chevron and label **1px** left of New agent's icon and label (x=40 vs 41): New agent sits on an off-scale 9px inset | A 1px shift; the right fix is moving New agent's 9px onto the scale, which touches Projects' rows too |
| 2 | Steps line in New routine | "+ Then…" indented 20px from the What field's edge (`agents-steps.css:48`) | Deliberate: it aligns with the numbered step column once a step exists |
| 2 | Reply → "Worked …" line | 4px under prose with a 24px line height (≈10px optical) | Reads as part of the reply, which is the intent; not cramped at the cap height |
| 2 | Phone chat header (web capture) | Moon / bubble / ⓘ gaps uneven (47 vs 60 at @3x) | Web stand-in for the native `Stack.Toolbar`; on iOS the system lays these out |
| 2 | Phone Usage sheet | "5-hour" label → bar → "Resets" 4pt apart | The usage sheet's content belongs to the usage redesign; pass this along |
| 1 | Phone Settings | Group separators run the full card width (iOS insets them to the text) | Taste; consistent across the app's grouped lists |

Phone overall: Catch up, the agent list, chat cards and Settings are on the scale (16pt card
padding, 12pt label-to-card, 44pt rows). The tab bar overlapping titles in the captures is a
react-native-web artifact (docs/mobile.md lists it).

## How this was measured

- `HARNESS_WIDTH=1280|1600 node scripts/harness-capture.mjs <id> --theme light|dark` (the width
  env is new in this pass) for the focused set: team, approval, live step, in flight, work
  folded/expanded, result, inline request, chat usage, quota, Settings usage and page,
  independence, onboarding, new agent, routines, model menu, search, memory, steps popover, room,
  first run, dashboard, describe, check-in, collapsed; plus `agents-header-crowded` (new: the
  header at its fullest, also at 900 and 700px) and the `usage-*` scenarios.
- Boxes and gaps read in the same Chrome: each flex/grid parent's child gaps, padding, line
  height, centre offsets of row children, and an off-scale scan of padding/gap/margin (the only
  off-scale values left on the agent screens are deliberate: the 90px traffic-light inset, the
  key's 3px side, the text-action target bleed).
