---
title: What's connected
order: 10
---

Settings → **Connected** is the one place that shows what your agents can reach, and where to set
up what they can't. Each row is read from your Mac as you look at it:

- **Mogbot for Chrome** — the only way agents use the sites you're signed in to.
- **Your AI** — the engines that are installed and signed in.
- **Apps** — the logins agents have been given.
- **Your phone** — paired phones.
- **Other assistants** — assistants connected over Remote Access.

A row says **Connected** or **Not set up**, and its button goes to the page that fixes it. If a
check can't run, the row says so instead of guessing.

## Mogbot for Chrome

Agents reach your Chrome only through Mogbot for Chrome, the app's own extension. There is no
other browser to fall back on: not a built-in one, not Claude in Chrome, not a Claude connector.
It works the same on any Claude account, so switching accounts never needs a browser sign-in.

When it isn't installed or isn't connected and an agent reaches for Chrome, a card in the chat says so, with one button:
**Install Mogbot for Chrome** (or **Finish setting it up** once it's on). It opens Settings →
Chrome, where each step ticks Done by itself. **Not now** puts the card away until you next open
the app. It shows only after an agent's turn tried to use your Chrome, never after a plain reply or draft.

It stays connected when you close Chrome's last window, as long as Chrome itself is still
running; quitting Chrome (⌘Q) ends the link until you open it again.

An agent that needs Chrome while it isn't connected tells you so in one line and carries on with
whatever else it can do.
