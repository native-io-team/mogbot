# Agent instructions

> **Start with [docs/MISSION.md](docs/MISSION.md), then [docs/ROADMAP.md](docs/ROADMAP.md).**
> This app (working name Dashbot, set in `brand.json`) is the evolution of Ship Studio: an
> open-source app for running your own team of AI agents on desktop and phone. You open it and
> talk to your Chief of Staff, which creates and delegates to named agents running on Claude Code
> or Codex on your own machine; consequential actions arrive as Allow / Deny cards; the phone
> companion is a complete way in. Ship Studio's project workspace sits underneath. Not a coding tool.

The full guide is **[CLAUDE.md](CLAUDE.md)** — read it before writing code. It covers the
architecture, the canonical patterns ("How to Do Things in Ship Studio"), the banned patterns,
testing, and known gotchas. This file is the contract in brief.

## Non-negotiables

1. **Run the CI gates before declaring work done:**
   ```bash
   pnpm check:all     # brand + typecheck + lint + prettier + rustfmt + clippy + docs + pattern/LOC checks
   pnpm test:run      # frontend tests (Vitest)
   pnpm rust:test     # backend tests (cargo test)
   cd mobile && pnpm test   # when you touched the phone app
   ```
2. **Look at what you built** — `pnpm harness` (desktop UI against fixtures), the real app, or
   the simulator. With several harnesses running, give each its own `SHIPSTUDIO_HARNESS_PORT`
   and its own `TMPDIR`.
3. **Use the shared primitives** — `<ModalFrame>`, `<Button variant=…>`, `Tabs` /
   `SegmentedControl`, `useInvoke`/`useAsyncState`, `usePolling`, `useCopyToClipboard`,
   `useModal('id')`. Hand-rolled equivalents are rejected by `pnpm check:patterns` and reviewers.
   See [docs/CONTRIBUTING_PATTERNS.md](docs/CONTRIBUTING_PATTERNS.md).
4. **Tokens only** — CSS uses the layers ordered by `src/styles/global/token-manifest.json`; the
   phone uses `mobile/src/lib/theme.ts` (scan tests fail literal colours and sizes). Everything
   works in light and dark.
5. **Monochrome, coloured by agents.** The accent is the Chief's (or the open agent's) colour and
   is never status. Approval answers are neutral (`variant="strong"`), never accent. Focus is neutral.
6. **Never hardcode the product name** — it comes only from `brand.json` (`BRAND.name`,
   `brand::NAME`); copy says "the app" or "this Mac". `check-brand-copy.mjs` enforces it.
7. **New Rust commands**: return `Result<T, CommandError>`, validate paths with
   `validate_project_path()`, shell out via `run_with_timeout`, add `#[tracing::instrument]`.
   In a worktree, set `CARGO_TARGET_DIR` to the main checkout's `.claude/cargo-shared`.
8. **Every user-facing feature registers its actions in the Cmd+K palette** via `useCommands`.
9. **Never assume data** — only display values that were explicitly returned or saved; never
   construct URLs, estimate numbers, or infer state from file existence.
10. **Stay compatible with Ship Studio** — `~/ShipStudio` and in-project `.shipstudio/` are
    shared; app state is ours (see CLAUDE.md, "Brand and identity").

## Layout in one breath

React/TS frontend in `src/` (components, `lib/` invoke-wrappers, hooks, `commands/` palette) ·
Rust/Tauri backend in `src-tauri/src/` (`agents/` the agent engine, `companion/` the phone server,
`commands/` by domain) · phone app in `mobile/` (Expo), wire types in
`packages/companion-protocol/` · CSS in `src/styles/{global,features,modes,components}/` · tests
colocated (`*.test.tsx`, `#[cfg(test)]`, `mobile/__tests__/`).
