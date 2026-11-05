# Dashbot

> Working name. It lives in one file, [`brand.json`](brand.json); the app itself
> avoids saying it.

Your own team of AI agents, on your own computer, on the accounts you already
pay for.

You open the app and you're talking to your **Chief of Staff**. It sets up
named agents for the work you hand it, briefs them, delegates, and comes back
with results. Each agent remembers you, keeps its own instructions and
routines, and runs on **Claude Code or Codex** on your machine. Anything that
spends money, sends something, or changes what other people see waits for your
Allow. You can follow along and answer from your phone.

Why it exists, and what it is not: [docs/MISSION.md](docs/MISSION.md).

## What it does today

- **A team, not a chatbot.** A Chief of Staff plus the agents it (or you)
  creates, each with a colour, memory you can read and edit, check-ins and
  routines, apps it may use, and a choice of engine per agent.
- **Approvals as a tap.** Allow / Deny cards in the chat. Secrets go into a
  masked card and the macOS Keychain, never into the conversation.
- **Shows its work.** Under each reply, a folded "what it did" timeline of
  the steps the agent actually took, with screenshots, live while it works.
- **Start fresh, keep memory.** A clean conversation whenever you want one,
  and a context meter that only shows what the engine reported.
- **Your phone.** A companion app (`mobile/`), paired by QR code, that talks to
  your own Mac over your own Tailscale: chat, approve, start new agents and
  routines, dictate, share things to an agent. Nothing passes through our
  servers.
- **Projects underneath.** When work becomes a site or an app, it lives in a
  full workspace: agent terminals, live preview, visual editing, branches,
  PRs, hosting status, snapshots. Agents create and work in projects too.
- **Bring your agents.** Import from Grok Bot or any other assistant, with
  their memory and routines.
- Light and dark, on desktop and phone.

Your Mac does the work, so it has to be on for agents to keep going. Being
honest about that is a feature: the app tells you what will and won't keep
running.

## Works with Ship Studio

This is the evolution of [Ship Studio](https://github.com/ship-studio/ship-studio)
and stays compatible with it in both directions: the projects folder
(`~/ShipStudio`) and the in-project `.shipstudio/` format are shared, so either
app opens projects made by the other. Settings, agents, pairing, logs and
Keychain entries are this app's own, so the two run side by side.

## Run it (development)

Requirements: macOS, Node 22 (`.nvmrc`), pnpm, Rust (`rust-toolchain.toml`),
Xcode command line tools. For the phone build, full Xcode.

```bash
pnpm install
pnpm tauri dev          # the desktop app
pnpm harness            # the real UI against fixtures, in a browser (127.0.0.1:1425)
pnpm test:run           # frontend tests
pnpm rust:test          # backend tests
pnpm check:all          # every CI gate
```

The phone app is its own pnpm project:

```bash
cd mobile && pnpm install
pnpm mock               # a scripted Mac, so you don't need the desktop running
pnpm ios                # build the dev client and open the simulator
```

To pair with the real desktop app, turn Tailscale on (Mac and phone) and use
the Phone row at the foot of the sidebar. Details, including building onto a
real iPhone: [mobile/README.md](mobile/README.md).

## Status

Early, and moving fast. It will be open source (MIT); the git history is Ship
Studio's, so upstream fixes can still be merged. There is no App Store or
TestFlight build yet, no update feed, and no telemetry: those stay off until
`brand.json` names an endpoint for them. What's next: [docs/ROADMAP.md](docs/ROADMAP.md).

Before the repo goes public, review its history (it carries Ship Studio's)
and make sure no credentials ever landed in it.

## Docs

- [docs/MISSION.md](docs/MISSION.md): why, for whom, and the rules that follow
- [docs/ROADMAP.md](docs/ROADMAP.md): what's done and what's next, ranked
- [docs/agents.md](docs/agents.md): agents, approvals, routines, memory and engines
- [docs/mobile.md](docs/mobile.md): the phone companion and pairing
- [docs/remote-access.md](docs/remote-access.md): driving your agents from another assistant
- [docs/design-system.md](docs/design-system.md): tokens, accent, themes, primitives
- [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md): architecture and conventions for contributors and agents
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, CI gates, debugging
- [docs/ship-studio-readme.md](docs/ship-studio-readme.md): the original Ship Studio README

## License

MIT. See [LICENSE](LICENSE).
