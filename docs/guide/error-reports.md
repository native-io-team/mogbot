---
title: Error reports
order: 8
---

When something breaks in the app, it can send a short error report so the people who make it can
find and fix it. Reports are **on by default**, and you can turn them off.

## What's sent

Each report contains only:

- the error message and where in the app it happened (a technical trace),
- the app's version, the operating system and the type of processor.

Before a report leaves your Mac, your user name is removed from any file paths in it.

Never sent: your project files or code, environment variables, tokens, your user name, or anything
that identifies your Mac.

Reports can become public issues on GitHub, which is why the bar is "safe to publish".

The same report is sent at most once a day, and your Mac sends no more than 30 reports a day in
total. Copies of the app you build from source don't send reports.

## Your phone

The phone app keeps a note of its own crashes and hands them to your Mac the next time it connects.
Your Mac sends them only if reports are on. The phone itself never sends a report anywhere.

## Turning it off

Open **Settings → Advanced** and turn off **Usage analytics & error reports**. With it off, nothing
is sent, from the Mac or the phone.

## Telling us about a problem yourself

Tell the Chief what's wrong ("this is broken", "report this"). It writes it up and shows you the
exact text on a card. Nothing is sent until you press Allow. Because you chose to send it, this
works even when automatic reports are off.
