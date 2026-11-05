# Dashbot

> Working name. It lives in one file, [`brand.json`](brand.json), so a rename
> is a small change plus a rebuild. See [docs/renaming.md](docs/renaming.md).

A team of AI agents that work for you, on your own Mac, with your own
subscriptions, and that do real work on your projects.

## Where this came from

This is the evolution of [Ship Studio](https://github.com/ship-studio/ship-studio),
the desktop app for building and shipping websites with AI agents. Ship Studio
started as a better place to *run one agent on one project*: a terminal, a live
preview, visual editing, branches, pull requests and deploys in one window.

While building it, the more interesting part turned out to be what happens
around the projects: agents that remember you, run routines, ask before they do
anything consequential, delegate to each other, start and continue work on your
projects, report back, and follow you to your phone. That outgrew the name.

Dashbot is that next step. It keeps everything Ship Studio does and puts the
agents first:

- **Agents.** A Chief of Staff plus the specialists you set up, each with its
  own memory, rules, routines and engine (Claude Code, Codex or Opencode), on
  the subscriptions you already pay for.
- **Projects.** Everything Ship Studio did: agent terminals, live preview and
  breakpoint canvas, visual editing, branches, PRs, conflicts, hosting status,
  snapshots, site migration. Agents can create projects, run sessions in them,
  and push once you approve.
- **Approvals, not surprises.** Anything that spends money, sends something or
  changes what other people see comes to you as a card first. Credentials go
  into a masked card and the macOS Keychain, never into the chat.
- **Your phone.** A companion app (`mobile/`), paired by QR code, that talks to
  your own Mac over your own Tailscale. Nothing passes through our servers.
- **Import.** Bring agents over from Grok Bot, Muse or any assistant, with their
  memory and routines.

Your Mac does the work, so it has to stay on for agents to keep going.

## Status

Private while it takes shape; it will be open-sourced. The git history is Ship
Studio's, so upstream fixes can still be merged in (add Ship Studio as a remote).

Before this repo goes public, review the history (it carries Ship Studio's) and
make sure no credentials ever landed in it.

## Develop

```bash
pnpm install
pnpm tauri dev          # desktop app
pnpm harness            # the real frontend against a fixture backend, in a browser
pnpm test:run           # frontend tests
cd src-tauri && cargo test --lib
cd mobile && pnpm start # phone companion (Expo)
```

Requirements: macOS, Node 20+, pnpm, Rust (see `rust-toolchain.toml`), Xcode
command line tools.

## Docs

- [docs/agents.md](docs/agents.md): agents, approvals, routines, memory and engines
- [docs/mobile.md](docs/mobile.md): the phone companion and pairing
- [docs/renaming.md](docs/renaming.md): where the name lives
- [docs/ship-studio-readme.md](docs/ship-studio-readme.md): the original Ship Studio README
- [CLAUDE.md](CLAUDE.md): architecture and conventions for contributors and agents

## License

MIT. See [LICENSE](LICENSE).
