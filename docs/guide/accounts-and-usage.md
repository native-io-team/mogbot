---
title: Accounts and usage
order: 2
---

Your agents run on your own engine accounts: your Claude plan for Claude Code, your ChatGPT plan
for Codex, or whatever providers you set up in OpenCode. The app doesn't sell or meter usage.

## Seeing your usage

The row at the bottom of the Agents sidebar shows what you have **left** across your accounts,
one bar, and when it next refills (for example "72% left · 2 accounts · Refills in 2d 4h").
Click it for the full view, also in **Settings → Accounts & usage**.

- Figures are only what the engine reports. The app never estimates a reading. If an account
  hasn't been read yet, it says so and leaves it out of the total.
- A reading that's more than a few hours old says when it was taken.
- Each account has its own page with its limits (for example 5-hour and weekly), when each
  refills, which agents used it this week, and **Where it went**.
- On a Claude plan, costs are shown in tokens. A dollar figure only appears for an API-key login,
  and it's labelled as API prices.
- OpenCode doesn't report plan limits, so no limits are shown for it, only tokens.

Limits come back by themselves. The app calls that the **refill**. When an account runs out, the
chat shows a quiet line with when it refills and a **Retry** button.

## Adding more accounts

You can add more than one Claude Code or Codex account. Agents use them in the order you set, and
a turn moves on to the next account when one runs out.

- Add one from **Settings → Accounts & usage → Add an account**, or from the usage-limit line when
  an account runs out.
- Signing in opens your browser, and it signs in as whoever is already logged in to claude.ai or
  chatgpt.com there. Sign out first, or use a private window, to add a different account. If you
  add one that's already there, the app tells you and offers to try again.
- The account you signed in with on this Mac is always first in the list. You can rename it and
  move it down, but not remove it.
- With two or more accounts, you can pick which one new work starts on, and pin an agent to one
  account.

OpenCode's providers are managed in OpenCode itself, so there are no accounts to add for it here.

## When every account is out

If Claude Code and Codex are both set up, you choose what happens when every account on one engine
is out: **Ask first** (the default: a card asks whether to carry on with the other engine),
**Carry on** with the other engine, or **Wait for the refill**.

## How agents use your limits

Pick a mode in **Settings → Accounts & usage**, or ask the Chief (it confirms on a card):

- **Normal** (the default). Before something big, an agent says in one line roughly what it will
  use and which account, then goes ahead.
- **Save my limits.** Agents ask before heavy work and send light work to lighter models. Routines
  that come due while every account they could use is over 90% wait for the refill, then run once.
- **Use it all before the refill.** Room that's about to expire gets used. When an account is near
  its refill with a good share left, the Chief hands out work from your **Ideas for leftover
  usage** list. Approvals still apply: nothing sends, spends or pushes without the usual card.

You also get one warning per limit window when the account in use passes 90%.

## Your free Mogbot account (optional)

You don't need an account to use the app. Everything on your Mac and your phone works without one.

A free Mogbot account does one thing today: it lets your paired phone reach your Mac through our
hosted phone relay, from anywhere, without Tailscale. Nothing in the app checks the account or
unlocks anything else with it.

- **Sign in:** during setup, or later in **Settings → Account**. Your browser opens; sign in with
  Google or an email code, then click **Link my Mac**.
- **What we keep:** your email and an account id, linked to your Mac's key. For the relay itself:
  which Mac, when, the IP address and how many bytes. Never what's in them: your phone's traffic
  is end to end encrypted and the relay can't read it.
- **Sign out:** **Settings → Account → Sign out**. Your Mac is unlinked from the relay. If you set
  up Tailscale, your phone keeps working over it.
- **Delete your account:** **Settings → Account → Delete my account**. Your email and account id
  are removed from the sign-in service and the relay, this Mac is signed out at once, and any other
  Mac signed in to the same account within a day. Nothing on your Mac is deleted.

Your phone doesn't sign in. It uses the relay because the Mac it's paired with is signed in.
