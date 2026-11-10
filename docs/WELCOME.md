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

Mogbot is a working name.

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

## Setting it up

**Never used Claude Code or Codex?** That's fine; you won't need to type
any commands. Install the Claude desktop app from
[claude.ai/download](https://claude.ai/download) and open its **Code** tab
(or open the Codex app if you're on ChatGPT), sign in with the plan you
already pay for, and paste this:

> Download https://github.com/native-io-team/mogbot into a folder in my
> home folder, then set it up on my Mac and phone. Follow docs/INSTALL.md.

Already use one of them? Open this repo in it and say:

> Set this up on my Mac and phone. Follow docs/INSTALL.md.

Your agent builds the app ([INSTALL.md](INSTALL.md)), which takes 10 to 25
minutes the first time, and stops whenever it needs you (your Mac
password, a sign-in, a tap on your phone). When it asks you to approve a
command, it's asking for permission to run it on your Mac: say yes to the
setup steps it describes.

Then the app itself takes over, in two short steps, one big button each.
Every check says **Done** or **Not done yet — here's what to do**, and if
you quit part-way it reopens where you stopped.

1. **Welcome.** One line on what this is.
2. **Your AI.** Pick **Claude Code** (Claude Pro or Max) or **Codex** (a paid
   ChatGPT plan); it installs, then you sign in in your browser. A screen
   each. "Claude Code" and "Codex" are just the names of the parts of Claude
   and ChatGPT that can do work on a computer; you don't need to code.

That's it: you land in a chat with your **Chief of Staff**. Tell it what's on
your plate in plain words. Everything else is offered when it matters, and
each can be skipped:

- **Bring agents from another assistant** (Grok, ChatGPT…): one card under
  the Chief's first message. No agents yet? Press **No thanks, start fresh**.
- **Your phone**: offered once your first piece of work comes back, and any
  time from **Get the phone app** at the bottom left. Ten minutes to an hour
  (there's no App Store app yet):
  Tailscale (a free app that lets your phone reach your Mac privately) on
  both, signed in to the **same account**, the phone app, then scan a code.
  The phone app is Expo Go or built with Xcode for now; your setup agent
  installs it (INSTALL.md, Step 13).
- **Another account**: offered the moment one runs out of usage.
- **How much agents do on their own**: by default they do work on this Mac
  and ask before anything leaves it (sending, spending, posting). Tell your
  Chief "ask me less" or "ask me more", or see Settings → Independence.

Optionally, later: let agents use your Chrome (the Claude in Chrome
extension, same Claude account).

Your team can be changed any time by asking the Chief: new agents, different
instructions, routines (work that repeats on a schedule), which AI one runs
on.

## Giving feedback

The most useful feedback is what you were trying to do, what you expected,
and what happened instead. Screenshots help.

- Send it to the person who invited you, however you usually talk.
- Stuck during setup? Ask your agent to *"write up what failed, with the
  error, for the person who invited me"*. Check what it wrote before you send
  it: logs can include names of your files and projects.
- Logs live in `~/Library/Logs/Mogbot/`.

Common problems and fixes: [INSTALL.md, Troubleshooting](INSTALL.md#troubleshooting).
