---
title: Independence
order: 4
---

**Independence** is how much your agents do without asking you. It's one slider with four stops,
from "Asks a lot" to "Just does it".

| Stop | What it does on its own |
| --- | --- |
| **Careful** | Reads and looks around; asks before bigger changes. |
| **Steady** (the default) | Reads and edits; asks before running changes or anything leaving this Mac. |
| **Bold** | Does local work on this Mac; asks before anything leaves it. |
| **Unleashed** | Sends, posts and pushes too; only stops for money, logins, deleting for good or going live. |

## Setting it

- For the whole team: **Settings → Independence**, or on the phone in Settings.
- For one agent: the same slider in that agent's editor. "Same as team" puts it back. An agent set
  differently from the team shows a small label in the sidebar.
- From chat: "Make Finance careful" or "Put Social Posts on Unleashed". Raising a level asks you on
  a card first. Lowering it applies straight away, with a line in the chat.

If you sound tired of being asked, or unhappy that something went ahead, the Chief may offer a
change once, in one line. You can ignore it.

## What always asks

At every stop, agents ask before:

- spending money,
- using your passwords or other credentials,
- deleting something for good.

Even at Unleashed they also ask before pushing to production or a protected branch (like `main`),
publishing a release or package, changing settings that affect what others see (domains, DNS,
repository visibility), and anything that would keep running on your Mac by itself (like a launch
agent or a change to your shell profile).

## Text from outside

When an agent is working on something that came from outside (a web page, an email, a message from
someone else, a GitHub comment), it never runs above Steady for that work, whatever its own level.
After reading outside content, sending data to another site or installing a new package asks you
for the rest of that conversation.

## Approval cards

When an agent needs your OK, a card appears in its chat showing exactly what it wants to do: the
command, the file, the site or the message. The agent's row says "Needs your OK" while it waits.

- **Allow** or **Deny**. Some cards also offer **Always allow** for that kind of thing (for
  example, web searches).
- Answer from the Mac, the phone, or by typing "yes" or "approve it" in the chat when there's
  exactly one card open.
- A card can be answered once. If you answer on the phone and the Mac at the same moment, only the
  first answer counts and the other says "Already answered".
- To stop accidental clicks, Allow is inactive for a moment after a card appears, and typing in the
  message box never answers a card.

**One yes for a whole plan.** When an agent has several outward steps ahead (say, a redeploy, an
issue and two comments), it can list them on one card, "Do these under your name?". One Allow
covers exactly those steps for an hour. It never covers money, credentials, deleting or force
pushes.

Every action taken without a card leaves a line in **What it did**, under the agent's reply. At
Unleashed, the turn also ends with one line listing what was sent or pushed without asking.

## Passwords and keys

Agents never ask for a password in the chat. When one needs a key or token, it shows a masked card,
and what you type goes into your Mac's Keychain, not the chat. To connect a service, you get a
sign-in card: connect the app, use your own browser, or paste an API key.
