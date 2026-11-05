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

Your agent works through [INSTALL.md](INSTALL.md) and stops whenever it needs
you. Roughly:

1. **Check the Mac and install the tools.** 15 GB free (about 25 GB if you
   build the phone app with Xcode). You type your Mac password a few times.
2. **Build and open the app**, then sign in to **Claude Code** (Claude Pro or
   Max) or **Codex** (a paid ChatGPT plan) in your browser. You can add more
   accounts later; when one runs out, the app moves to the next.
3. **Tailscale on the Mac and the phone**, signed in to the **same account**,
   switched on, **before** you scan anything. This is the step people trip on.
4. **The phone app**: Expo Go (minutes) or built with Xcode (30–60 minutes the
   first time, the real experience). Your agent asks which. Then scan the code
   on the Mac to pair.
5. **Say hello to your Chief of Staff.** Optionally: let agents use your
   Chrome (the Claude extension, same Claude account), and bring your agents
   over from Grok Bot or another assistant.

How independent your agents are, and everything about your team, can be
changed later: ask the Chief, or look in Settings → Agents.

## Giving feedback

The most useful feedback is what you were trying to do, what you expected,
and what happened instead. Screenshots help.

- Send it to the person who invited you, however you usually talk.
- Stuck during setup? Ask your agent to *"write up what failed, with the
  error, for the person who invited me"*. Check what it wrote before you send
  it: logs can include names of your files and projects.
- Logs live in `~/Library/Logs/Dashbot/`.

Common problems and fixes: [INSTALL.md, Troubleshooting](INSTALL.md#troubleshooting).
