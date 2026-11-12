---
title: Install
order: 1
---

## What you need

- A Mac with Apple silicon (M1 or later). Intel Macs, Windows and Linux aren't supported by the
  download.
- One AI engine for your agents to run on. Pick at least one:
  - **Claude Code**, with a paid Claude plan (Pro or Max).
  - **Codex**, with a paid ChatGPT plan.
  - **OpenCode**, with any provider you set up in it: an API key, or a model running on your computer.
- For the phone app (optional): an iPhone.

You don't need to install the engine first. The app does it for you.

## Download and move to Applications

1. Go to [mogbot.app/start](https://mogbot.app/start) and download the Mac app.
2. Open the downloaded file and drag the app into **Applications**.
3. Open it from Applications.

If you open the app straight from the downloaded file instead, it still runs, but it can't update
itself from there. When an update is ready, the app offers **Move to Applications**: one click
copies it there and reopens it.

Updates download in the background. When one is ready you'll see **Restart to update**.

## First launch

Setup is a few short screens, one question each. You can go back at any point, and if you quit
halfway, the app reopens where you stopped.

1. **Welcome.** One line on what the app is.
2. **Sign in?** Optional. A free account lets your phone reach your computer from anywhere without
   setting up Tailscale. Choose **Use without signing in** to skip it; everything on your computer
   works the same. See [Accounts and usage](accounts-and-usage.md).
3. **Your AI.** Pick Claude Code, Codex or OpenCode. The app installs it and walks you through
   signing in, each as its own screen. Every step ticks **Done** when the app has checked it.
   If something goes wrong, the screen says what and the one thing to do about it.
   - The install may ask for your computer's password.
   - Codex on a fresh computer first installs what it needs (a package manager and Node.js).
   - Signing in opens your browser.

That's the only required part. When your engine is installed and signed in, you land in a chat
with your **Chief of Staff**.

## After setup: in the Chief's chat

The Chief speaks first with a short greeting (nothing runs on your plan until you reply). Under it:

- **Bring your agents over.** If you already use agents in another assistant (Grok, ChatGPT,
  Claude or another), pick it and the Chief walks you through bringing them in. Or choose
  **I'm starting fresh**. Nothing becomes an agent until you review it on one card and press
  Import. Imported routines arrive paused.
- **A few starters**, like "Brief me every morning" or "Make me an agent", to get a first result
  in the first few minutes.
- **Your phone.** Once your first request comes back, the Chief offers to set up your phone. You
  can also do it any time from **Pair your phone** at the bottom of the sidebar. See
  [Your phone](phone.md).

## Projects need two more tools

Agents don't need anything else. If you start a website or app project, the app checks for Node
and Git and, if they're missing, lists them and has your engine install them while you watch.
GitHub sign-in is offered at the same time and is optional.
