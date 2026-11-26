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

An agent that needs Chrome while it isn't connected tells you so in one line and carries on with
whatever else it can do. If Mogbot for Chrome stays disconnected for five minutes while it's on,
the Chief of Staff says so once (and you get one notification), with a button to Settings →
Chrome. Not once per agent.

An agent can also read what one of its own tabs wrote to its console (errors, warnings, logs) and
which requests it made, with their status. That is reading, so it never asks. It covers only the
time since the agent first read or used that tab, and needs Mogbot for Chrome 0.1.3 or later; with
an older one the agent says which version to update to.

### In project tabs and your own Terminal

Project tabs you open here (Claude Code or Codex) get the same Chrome tools while Mogbot for Chrome
is on. Each tab's pages open in a tab group named after the project.

A `claude` you run in your own Terminal can have them too, on any Claude account. Register it once:

```
claude mcp add --scope user user_chrome -- /Applications/Mogbot.app/Contents/MacOS/mogbot mcp user-chrome
```

If you keep a separate Claude setup per account (a different `CLAUDE_CONFIG_DIR`), run it once in
each. Its pages open in a tab group called Terminal. It works while Mogbot is open; when it's
closed, the tools say so.

From a project tab or your Terminal, anything that sends, posts, pays, deletes or shares asks you
first on a card in the Chief of Staff's chat (and on your phone), the same as for agents.
