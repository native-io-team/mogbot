# Welcome, tester

Thanks for trying this. You're one of a small group invited to use it before
anyone else.

## What it is

Your own team of AI agents, on your own Mac, on the Claude or ChatGPT plan you
already pay for. You talk to a **Chief of Staff**; it sets up named agents for
the work you hand it, briefs them, delegates and comes back with results. Each
agent remembers you, keeps its own instructions and routines, and runs on
Claude Code or Codex on your Mac. Anything that spends money, sends something
as you, or changes what other people see waits for your **Allow**. A phone app
lets you chat, approve and review from anywhere, talking only to your own Mac
over your own Tailscale. Nothing goes through our servers.

Dashbot is a working name.

## What to expect

It's early. Expect rough edges, things that change from one week to the next,
and the occasional bug. In particular:

- **You build it yourself.** There's no download or App Store app yet; your
  AI agent does the building for you (below).
- **Your Mac does the work.** Agents stop when the Mac sleeps or the app is
  closed.
- **No push notifications on the phone yet.** Those need the official build
  (a paid Apple Developer account and TestFlight), which doesn't exist yet.
  You're alerted while the phone app is open.
- **A phone app built with a free Apple ID stops opening after 7 days**, and
  needs re-installing (your agent can do it). Expo Go doesn't expire but needs
  a terminal open on the Mac.

## Setting it up, in five steps

Open this repo in **Claude Code** or **Codex** and say:

> Set this up on my Mac and phone. Follow docs/INSTALL.md.

Your agent builds the app ([INSTALL.md](INSTALL.md)) and stops whenever it
needs you. Then the app itself takes over: one screen at a time, one big
button each, and every check says **Done** or **Not done yet — here's what
to do**. Quit part-way and it reopens where you stopped.

1. **Welcome.** One line on what this is.
2. **Your AI.** Pick **Claude Code** (Claude Pro or Max) or **Codex** (a paid
   ChatGPT plan); it installs, then you sign in in your browser. A screen
   each.
3. **How independent** your agents should be. Skip keeps the default.
4. **Your phone** (optional, about ten minutes): Tailscale on this Mac,
   Tailscale on your phone signed in to the **same account** (the screen
   shows a code to scan for the App Store and ticks when it sees your
   phone), the phone app, then scan the code and click Allow. The phone app
   is Expo Go or built with Xcode for now; your setup agent installs it
   (INSTALL.md, Step 13).
5. **You're ready.** Bring your agents from Grok, ChatGPT or another
   assistant (three short screens: Remote access on, the link in your
   assistant, one message), or start fresh with your Chief of Staff.

Optionally, later: let agents use your Chrome (the Claude in Chrome
extension, same Claude account).

Your team can be changed any time by asking the Chief: new agents, different
instructions, routines, which engine one runs on. How independent your agents
are is in Settings → Agents.

## Giving feedback

The most useful feedback is what you were trying to do, what you expected,
and what happened instead. Screenshots help.

- Send it to the person who invited you, however you usually talk.
- Stuck during setup? Ask your agent to *"write up what failed, with the
  error, for the person who invited me"*. Check what it wrote before you send
  it: logs can include names of your files and projects.
- Logs live in `~/Library/Logs/Dashbot/`.

Common problems and fixes: [INSTALL.md, Troubleshooting](INSTALL.md#troubleshooting).
