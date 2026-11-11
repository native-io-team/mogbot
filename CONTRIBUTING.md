# Contributing

Thanks for your interest in contributing. Mogbot (its name set only in `brand.json`) is the evolution of Ship Studio; read [docs/MISSION.md](docs/MISSION.md) first, then [docs/ROADMAP.md](docs/ROADMAP.md). This guide gets you from a clone to a passing PR.

> **Before you start**
>
> - Read the [Code of Conduct](CODE_OF_CONDUCT.md) — it sets the bar for how we collaborate.
> - For deeper context on the *patterns* the codebase has standardised on, read [docs/CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md) and the **"How to Do Things in Ship Studio"** section of [CLAUDE.md](CLAUDE.md). New code that bypasses those primitives will get flagged in review.
> - If you found a security issue, **do not file a public issue** — see [SECURITY.md](SECURITY.md) for private reporting.
> - Before you report something verified, read [docs/verifying-your-own-work.md](docs/verifying-your-own-work.md) — a short list of checks that pass while proving nothing.
> - Want to *see* a UI change instead of describing it? `pnpm harness` boots the real frontend in a browser against a fixture backend and `pnpm harness:capture` screenshots ~70 app states — see [docs/ui-harness.md](docs/ui-harness.md).
> - Want to fork and ship your own build? See [docs/FORKING.md](docs/FORKING.md).

## Development Setup

### Prerequisites

- **Node.js** — version pinned in [`.nvmrc`](.nvmrc) (currently 22). With `nvm`: `nvm use`.
- **pnpm 9** — `npm install -g pnpm@9.15.9` (or `corepack enable pnpm`). A newer global pnpm switches itself to the version in `packageManager` inside this repo.
- **Rust** (stable, per [`rust-toolchain.toml`](rust-toolchain.toml)) — install via [rustup.rs](https://rustup.rs/).
- **Xcode Command Line Tools**: `xcode-select --install`. Full Xcode only if you build the phone app onto a device.
- **macOS.** The app and its install guide target the Mac; [docs/INSTALL.md](docs/INSTALL.md) is the step-by-step setup with a check for every step.

### Getting Started

```bash
# Clone the repo
git clone https://github.com/native-io-team/mogbot.git   # `repository` in brand.json
cd mogbot

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

This starts both the Vite dev server (frontend, port 1420) and the Tauri app (backend). If 1420 is taken: `SHIPSTUDIO_DEV_PORT=1445 pnpm tauri dev --config '{"build":{"devUrl":"http://127.0.0.1:1445"}}'`. A dev build and an installed `.app` share the same app data (agents, pairing), so don't run both at once.

The phone app is a separate pnpm project in `mobile/` — see [mobile/README.md](mobile/README.md):

```bash
cd mobile && pnpm install
pnpm mock     # a scripted Mac, so you don't need the desktop running
pnpm ios      # build the dev client and open the simulator
```

### Working in worktrees

Several worktrees (or several coding agents) at once is normal here. Three things keep them out of each other's way:

- **One Rust build.** Set `CARGO_TARGET_DIR` to the main checkout's `.claude/cargo-shared` (an absolute path) for every `cargo` and `pnpm tauri` command, so each worktree doesn't compile the crate from scratch.
- **One harness port each.** Give every UI harness its own `SHIPSTUDIO_HARNESS_PORT` and `TMPDIR` (the capture script's Chrome profile lives there), the same in both shells. The capture script refuses to screenshot a harness served from another checkout.
- **One phone QA port set each.** `pnpm qa:web --web-port <n> --mock-port <n> --cdp-port <n>`.

## Looking at the UI

You can see the app without building it. `pnpm harness` boots the **real** frontend in a browser against a fixture backend, and the capture script screenshots any state:

```bash
pnpm harness &                                   # http://127.0.0.1:1425
pnpm harness:capture                             # every scenario + every Cmd+K command, into harness/shots/
node scripts/harness-capture.mjs agents-         # only scenarios whose id starts with agents-
node scripts/harness-capture.mjs --all --theme light
```

In another worktree, or beside another agent:

```bash
export SHIPSTUDIO_HARNESS_PORT=1437 TMPDIR=$(mktemp -d)
pnpm harness &
node scripts/harness-capture.mjs <scenario-id>
```

Open `http://127.0.0.1:1425/harness.html?scenario=<id>` to browse by hand. Scenarios live in `src/harness/scenarios/`; each says what the screen should look like. A Tauri command with no fixture is never given a plausible default: it fails the run, and that screenshot isn't evidence. Add the fixture first. Full guide: [docs/ui-harness.md](docs/ui-harness.md).

**Phone screens without a simulator:** `cd mobile && pnpm qa:web` renders the companion app with react-native-web against the mock Mac and captures a fixed list of screens, light and dark, into `mobile/qa-shots/` with a `report.md`. Narrow it with `--only <prefix>`, `--phases <list>` and `--themes light`. What's a web artifact (tab-bar position, safe areas, icons) is listed in [docs/mobile.md](docs/mobile.md), "Phone screens without a simulator".

## Before You Push — the CI Gates

Every PR runs these checks in CI. Run them locally first and your PR will
pass on the first try:

```bash
pnpm check:all     # brand + typecheck + lint + prettier + rustfmt + clippy + script/extension tests + docs + pattern, LOC and UI-baseline checks
pnpm test:run      # frontend tests (Vitest)
pnpm rust:test     # backend tests (cargo test)
cd mobile && pnpm typecheck && pnpm test   # the phone app, if you touched mobile/ or packages/
```

Notes:

- CI runs `pnpm lint:strict` (zero warnings allowed) — `check:all` runs plain
  `lint`, so fix warnings too.
- Formatting failures are auto-fixable: `pnpm format` (TS/CSS) and
  `pnpm rust:fmt` (Rust).
- `check:patterns` rejects banned patterns (hand-rolled modals, raw
  `setInterval`, `Result<T, String>`, raw hex colors, …) — see
  [docs/CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md) for what to
  use instead.
- `check:brand` keeps the identity copies in sync with `brand.json`, and
  `check:patterns` also runs `scripts/check-brand-copy.mjs`: the product name
  is never hardcoded in UI copy (use `BRAND.name`, or say "the app").
- `check:loc` enforces per-file line ceilings; if you hit one, split the file
  rather than raising the limit.
- Frontend coverage thresholds are enforced in CI — add tests for non-trivial
  logic.

## Project Architecture

```
src/                        # React frontend (TypeScript)
├── components/             # UI components
│   ├── agents/             # Agents: chat, cards, keys, sidebar, What's in flight
│   ├── setup/              # Onboarding
│   ├── edit/               # Visual editor panels
│   └── primitives/         # Shared ModalFrame, Button, …
├── lib/                    # Tauri command wrappers & utilities (~60 modules)
├── hooks/                  # Custom React hooks
├── commands/               # Cmd+K palette registry
├── contexts/               # Modal, toast, and other app contexts
├── styles/                 # CSS (global tokens, features, modes, components)
├── harness/                # UI harness: fixture backend + scenarios
└── App.tsx                 # Main app component & state

src-tauri/                  # Rust backend
├── src/
│   ├── lib.rs              # App setup & command registration
│   ├── state.rs            # Shared application state
│   ├── types.rs            # Type definitions
│   ├── utils.rs            # Path validation, helpers
│   ├── cache.rs            # TTL-based git caching
│   ├── agents/             # The agents engine: turns, approvals, routines, usage, results
│   ├── companion/          # The phone app's server (pairing, auth, sync)
│   ├── remote_access/      # MCP server for driving agents from another assistant
│   └── commands/           # Modular command handlers
│       ├── git/            # Git operations (branches, status, stash, sync)
│       ├── projects/       # Project CRUD (detection, metadata, sessions, templates)
│       ├── setup/          # Onboarding (auth, install, status checks)
│       ├── ide/            # IDE launch & screenshot capture
│       ├── pty/            # Pseudo-terminal spawn/stream
│       ├── skills/         # Agent skill search & install
│       ├── health/         # Project health checks
│       ├── github.rs       # GitHub CLI integration
│       ├── publishing.rs   # Push the current branch to origin
│       ├── mobile.rs       # Mobile app preview (Expo/RN/Flutter)
│       ├── edit.rs         # Visual editor backend
│       ├── conflicts.rs    # Merge conflict resolution
│       ├── ai.rs           # AI-powered PR generation
│       └── ...             # ~30 modules total — see CLAUDE.md for the full list
├── Cargo.toml              # Rust dependencies
└── tauri.conf.json         # Tauri configuration

mobile/                     # The phone app (Expo / React Native), its own pnpm project
packages/companion-protocol # Types and shared data both apps and the Mac agree on
chrome-extension/           # The extension behind "Use my Chrome" (off by default)
docs/                       # MISSION, ROADMAP, INSTALL, agents, mobile, design system, ...
brand.json                  # The app's name, ids and every external link
```

### Key Technologies

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite |
| Backend | Rust, Tauri 2 |
| Terminal | xterm.js + tauri-pty |
| Styling | CSS variables (design tokens), light and dark |
| Phone | Expo / React Native |

## Code Style

### TypeScript

- Use functional components with hooks
- Add JSDoc comments to exported functions and interfaces
- Use TypeScript strict mode (already configured)
- Prefer `const` over `let`

```typescript
/**
 * Brief description of what this does.
 * @param projectPath - Absolute path to the project
 * @returns Description of return value
 */
export async function myFunction(projectPath: string): Promise<Result> {
  // Implementation
}
```

### Rust

- Use `///` doc comments on public functions
- Follow Rust naming conventions (snake_case for functions, PascalCase for types)
- Validate all paths using `validate_project_path()` for security

```rust
use crate::errors::CommandError;

/// Brief description of what this command does.
///
/// # Arguments
/// * `project_path` - Absolute path to the project directory
#[tauri::command]
#[tracing::instrument]
async fn my_command(project_path: String) -> Result<String, CommandError> {
    let path = validate_project_path(&project_path)?;
    // Implementation
    Ok("done".into())
}
```

Always return `Result<T, CommandError>` (not `Result<T, String>`) — the frontend
needs a tagged error so it can branch on auth / timeout / validation / generic.
See [src-tauri/src/errors.rs](src-tauri/src/errors.rs) for the enum and
[src/lib/errors.ts](src/lib/errors.ts) for the TypeScript mirror.

### CSS

- Use CSS variables from the ordered token files in `src/styles/global/token-manifest.json`
- Follow BEM-like naming: `.component-name`, `.component-name-element`
- Keep styles scoped to components

## Making Changes

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `refactor/description` - Code improvements
- `docs/description` - Documentation updates

### Commit Messages

Use clear, descriptive commit messages:

```
Add screenshot capture for project thumbnails

- Implement headless Chrome screenshot capture
- Add fallback for missing browsers
- Store thumbnails in .shipstudio/thumbnail.png
```

### Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with clear commits
3. Run the CI gates locally: `pnpm check:all && pnpm test:run && pnpm rust:test`
4. Look at what you changed: a harness scenario for a UI change (add one if the state is new), and `pnpm tauri dev` for anything that touches Rust or a real engine
5. Say what you verified and how, and what you didn't; read [docs/verifying-your-own-work.md](docs/verifying-your-own-work.md) first
6. Submit the PR — the template walks you through the patterns checklist

## Common Development Tasks

### Adding a New Tauri Command

1. Add the command function in the appropriate module under `src-tauri/src/commands/`. For example, to add a git-related command, edit `src-tauri/src/commands/git/mod.rs` (or create a new submodule). For a new domain, create a new file in `src-tauri/src/commands/`:
```rust
use crate::errors::CommandError;

#[tauri::command]
#[tracing::instrument]
pub async fn my_new_command(arg: String) -> Result<String, CommandError> {
    // Implementation
    Ok("done".into())
}
```

2. Export the command from `src-tauri/src/commands/mod.rs` and register it in the handler in `src-tauri/src/lib.rs`:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    commands::my_module::my_new_command,
])
```

3. Create a TypeScript wrapper in `src/lib/`:
```typescript
export async function myNewCommand(arg: string): Promise<string> {
  return invoke<string>("my_new_command", { arg });
}
```

### Adding a New Component

1. Create the component file in `src/components/`
2. Add JSDoc module comment at the top
3. Export from the file
4. Add styles to `src/styles/` (component-specific or in existing files)

## Testing

### Automated Tests

**Frontend Tests (Vitest + React Testing Library):**
```bash
pnpm test:run         # Run all tests once
pnpm test             # Watch mode
pnpm test:ui          # Run with interactive UI
pnpm test:coverage    # Run with coverage report
pnpm test:scripts     # Node tests for scripts/ (harness, brand checks, ...)
pnpm test:extension   # Chrome extension tests
```

Tests are in `src/**/*.test.{ts,tsx}`. We use the official `@tauri-apps/api/mocks` module for mocking Tauri IPC calls.

**Backend Tests (Rust):**
```bash
pnpm rust:test        # or: cd src-tauri && cargo test
```

Unit tests are colocated in source files, or in `*_tests.rs` files beside them, using `#[cfg(test)]` modules.

**Whole agent turns, no model (macOS, needs python3):**
```bash
scripts/agents-fake-e2e.sh            # every scenario, about two minutes
scripts/agents-fake-e2e.sh stop codex # some of them
```

Runs real agent turns (runner, agent bridge, approval cards, accounts,
conversations, the morning brief) against a scripted stand-in for Claude
Code and Codex (`scripts/fake-engine/fake_claude.py`), in a throwaway HOME
with the Keychain kept in memory: free, offline and deterministic. Each
test message carries the turn's script (`#fake [{"say": "hi"}, …]`; the
steps are listed at the top of the script). Run it after changing anything
in `src-tauri/src/agents/` that a turn goes through; add a scenario to
`src-tauri/examples/agents_fake/` for a bug a turn can reproduce. The
opt-in `scripts/agents-e2e.sh` runs real turns on Haiku (costs money); see
docs/agents.md, "Testing".

**Phone app (Jest):**
```bash
cd mobile && pnpm test        # unit and node tests
cd mobile && pnpm typecheck
```

### Manual Testing Checklist

Before submitting a PR, verify:

- [ ] CI gates pass (`pnpm check:all && pnpm test:run && pnpm rust:test`)
- [ ] App launches without errors and lands on Agents
- [ ] A message to the Chief of Staff gets a reply; an approval card can be answered
- [ ] Looks right in both light and dark (Settings → Appearance)
- [ ] Can create a new project
- [ ] Terminal works and responds to input
- [ ] Preview loads and shows the dev server
- [ ] GitHub integration works (if you have `gh` installed)
- [ ] No console errors in DevTools

### Testing Onboarding

Onboarding is the first thing every new user sees: it asks for one engine (Claude Code or Codex) and ends in a conversation with the Chief of Staff. See `CLAUDE.md` → "Onboarding / Setup Testing". Quick reference:

```bash
# Force onboarding open with REAL checks
SHIPSTUDIO_FORCE_ONBOARDING=1 pnpm tauri dev

# MOCK backend, nothing touches the machine
SHIPSTUDIO_FORCE_SETUP=fresh pnpm tauri dev        # Nothing installed
SHIPSTUDIO_FORCE_SETUP=auth-only pnpm tauri dev     # Engines installed, none signed in
```

For the real end-to-end test, use a clean macOS install or VM. See `CLAUDE.md` for the full fresh-machine checklist.

### Building for Production

```bash
pnpm tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

## Security Considerations

- **Path Validation**: Always use `validate_project_path()` for any file operations
- **No Arbitrary Code Execution**: Don't pass user input directly to shell commands
- **Secrets**: Never commit `.env` files or API keys

## Error Handling

### Frontend: Structured Logger

Use the structured logger (`src/lib/logger.ts`) instead of `console.error`. Logs are flushed to the Rust backend and persisted to disk at `~/Library/Logs/Mogbot/` (the folder is `appDirName` in `brand.json`).

```typescript
import { logger } from '../lib/logger';

// For caught errors
logger.error('Failed to fetch branches', { error: err instanceof Error ? err.message : String(err) });

// For Error objects with stack traces
logger.logError(error, { context: 'additional info' });

// For warnings and debug info
logger.warn('Unexpected state', { details });
logger.debug('Polling tick', { interval });
```

### Rust Backend: Result Types

All Tauri commands return `Result<T, CommandError>` so the frontend can
discriminate between auth / timeout / validation / generic failures rather
than parsing strings. Use the `?` operator to propagate errors.

```rust
use crate::errors::CommandError;

#[tauri::command]
#[tracing::instrument]
async fn my_command(path: String) -> Result<String, CommandError> {
    let validated = validate_project_path(&path)?;
    do_work(&validated).map_err(CommandError::from)
}
```

`CommandError` lives in [src-tauri/src/errors.rs](src-tauri/src/errors.rs);
its TypeScript mirror is [src/lib/errors.ts](src/lib/errors.ts).

### ErrorBoundary

`src/components/ErrorBoundary.tsx` catches React render errors, logs them via the structured logger, and shows a restart UI. Any unhandled render error in a component tree wrapped by `ErrorBoundary` will be captured automatically.

### When to Swallow Errors

Only swallow errors for non-critical fire-and-forget operations. Always add a comment explaining why:

```typescript
// Analytics failure shouldn't block the user
void trackEvent('project_opened').catch(() => {});

// Screenshot interval failure is non-critical
void captureScreenshot().catch((err) => {
  logger.debug('Screenshot capture failed', { error: String(err) });
});
```

For anything that affects user-visible state or data integrity, propagate the error to the UI.

## Debugging

### Log files

The app writes structured logs (via the `tracing` crate) to a folder named by `appDirName` in `brand.json` (`Mogbot` today):

```
~/Library/Logs/Mogbot/
```

Rotated daily. Tail the latest with:

```bash
tail -f ~/Library/Logs/Mogbot/mogbot.log.*
```

### Rust backtraces

When the backend panics or returns a cryptic error, re-run the dev app with:

```bash
RUST_BACKTRACE=1 pnpm tauri dev
# or RUST_BACKTRACE=full for more detail
```

Pair with `RUST_LOG=debug` (or `RUST_LOG=app_lib=debug`) to raise log verbosity without recompiling.

### Frontend DevTools

In the running app, open Chromium DevTools with **Cmd+Option+I**. The Console shows frontend logs emitted via [`src/lib/logger.ts`](src/lib/logger.ts) — that file is the single entry point for structured frontend logging (level, context, redaction). Prefer it over `console.log`.

### Onboarding / setup wizard

See `CLAUDE.md` → **Onboarding / Setup Testing** for `SHIPSTUDIO_FORCE_ONBOARDING` and `SHIPSTUDIO_FORCE_SETUP` env vars. Copy [`.env.example`](.env.example) to `.env` for a local reference.

## Getting Help

- Read the code comments and the docs in [docs/](docs/) — start with [CLAUDE.md](CLAUDE.md).
- Issues, discussions and a community channel aren't set up yet (their links in `brand.json` are null).

## FAQ

### Why does `package.json` say `"private": true`?

That field blocks accidental `npm publish` — it's unrelated to the
repository's visibility. The app is distributed as installers, not as an
npm package. The code is MIT-licensed (see [LICENSE](LICENSE)).

### Why are `CLAUDE.md` and `AGENTS.md` checked in?

`CLAUDE.md` is a long-form contributor reference used by both humans and AI
coding assistants. The "How to Do Things in Ship Studio" section documents
the canonical primitives the codebase has standardised on; anything you
write should follow those patterns. `AGENTS.md` is the short version of the
same contract for agent tools that read that filename by convention.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
