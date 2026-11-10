# Mogbot 1.0 for Mac

Mogbot gives you your own team of AI agents, running on your Mac, on the
Claude or ChatGPT plan you already pay for.

You talk to a Chief of Staff. Tell it what you need and it creates agents for
the work, briefs them, hands things off and comes back with results. Each agent
has its own instructions, memory and routines, and runs on Claude Code, Codex
or OpenCode on this Mac, signed in to your own account. Nothing runs on our
servers: there aren't any.

## What's in 1.0

- **A Chief of Staff from the first launch.** It sets up the rest of your
  team from a sentence, and you review each new agent once before it exists.
- **Agents that remember.** Each one keeps its own notes, routines and the
  apps it's allowed to use.
- **You decide how much they do alone.** One slider: Careful, Steady, Bold or
  Unleashed. Anything that spends money, sends something as you or changes
  what other people see waits for your Allow, and even at Unleashed agents
  stop for money, logins, deleting for good and going live.
- **Results you can check.** Finished work comes back as one card with the
  files, what the agent says it checked and what it didn't. Ask for changes
  and you get a new version.
- **Routines.** On a schedule, or "When..." something happens: a GitHub
  mention, a new file in a folder, a new email in Mail or a text in Messages.
  A morning brief from your Chief of Staff, if you want one.
- **Usage you can trust.** Your plan's limits as the engine reports them,
  what each agent used this week, and more than one account if you have them.
- **Your phone.** Answer approvals, follow along and start things from the
  iPhone app (below).
- **Projects.** When work turns into a site or an app, it lives in a project
  workspace with a live preview, git and hosting status.
- **Bring your agents.** Import from Ship Studio on this Mac, or from another
  assistant.

## What you need

- **A Mac with Apple Silicon** (M1 or later) running **macOS 14 Sonoma or
  later**. Tested on macOS 26. This download doesn't run on Intel Macs.
- **An account for at least one engine:**
  - Claude Code, with a Claude plan
  - Codex, with a ChatGPT plan
  - OpenCode, with any provider it supports

  The app installs the engine and walks you through signing in on first
  launch. Signing in happens in your browser.

## Install

1. Open the DMG and drag Mogbot to Applications.
2. Open Mogbot. Pick an engine, sign in, and you land on your Chief of Staff.

## The phone app

The iPhone app is a remote for the Mogbot on your Mac. It doesn't run agents
on its own.

1. Install **Tailscale** on your Mac and your iPhone, signed in to the same
   account. Your phone reaches your Mac over your own tailnet: nothing goes
   through a server of ours.
2. On the Mac: **Settings → Phone → Show code.** A QR code appears.
3. On the iPhone: open the app and scan the code (or use the Camera).
4. Back on the Mac, confirm the pairing. That's it.

Your Mac has to be on and awake for the phone to reach it.

## Good to know

- **Updates aren't automatic yet.** Download new versions from the same page.
- **No telemetry.** This build sends no analytics or crash reports.
- **Open source.** MIT licence.
- **Help:** juliangalluzzois@gmail.com
