# Security policy

## Supported versions

Security fixes go into the latest release only. Older versions are not
patched; the app's update feed moves you to the fixed one.

## Reporting a vulnerability

**Please don't open a public GitHub issue for a security report.**

Email **[juliangalluzzois@gmail.com](mailto:juliangalluzzois@gmail.com)** with
"Security" in the subject. Once this repository is public you can also use
GitHub's private vulnerability reporting (the repo's **Security** tab →
**Report a vulnerability**), which only the maintainers can see.

Please include:

- What the vulnerability is and what an attacker could do with it.
- Steps to reproduce, or a proof of concept, on a clean install of the latest
  release.
- The app version (app menu → About) and your macOS version, and the phone
  app's version if the phone is involved.
- Any lines from `~/Library/Logs/Mogbot/` that help. Check them for your own
  paths and project names first.

### What to expect

- An acknowledgement within **3 business days**.
- Triage and confirmation within **7 business days**.
- A fix for a high-severity issue within **14 days**; others in the next
  regular release.
- Credit in the release notes, unless you'd rather not.

## Scope

In scope:

- The desktop app in this repository, and its release builds.
- The phone companion app (`mobile/`) and its pairing with the Mac.
- The agent approval broker, independence levels, the Keychain handling of
  logins and secrets, Remote Access, and the Chrome extension
  (`chrome-extension/`).
- The update feed named in `brand.json` (`links.updates`).

The threat model and what each wall is meant to stop are written down in
[docs/agents.md](docs/agents.md) ("Approvals", "Threat model additions"),
[docs/mobile.md](docs/mobile.md) and
[docs/remote-access.md](docs/remote-access.md). A way around any of them is in
scope, including prompt injection that gets an agent past an approval it
should have asked for.

Out of scope:

- Bugs in the engines and tools the app runs (Claude Code, Codex, OpenCode,
  `gh`, Tailscale): report those to their maintainers. How the app *uses*
  them is in scope.
- Forks that rebrand or repackage the app: contact that fork's maintainer.
- Attacks that need an already compromised Mac (someone with your login or
  filesystem access).
