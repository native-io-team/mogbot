# Tester readiness (dry run, 2026-11-05)

A fresh clone of `dashbot/foundation`, followed the way a tester's agent would:
README → WELCOME → INSTALL, every runnable step taken literally.

## Verdict: ready for a small group, with one step unverified

Nothing blocks handing it out. The one gap: **Step 8 (the release build) and
Step 9 (sign, verify) were not run** in this dry run, because the machine had
19 GB free. Run them once on a clean Mac (or the Tart VM,
`scripts/onboarding-vm.sh`) before the first invite goes out.

## What ran, and how it went

| Step | Result |
| --- | --- |
| 1–5 Mac, CLT, Node (24), pnpm 9.15.9, Rust 1.92 | Pass |
| 6 `git clone` | Pass (178 MB) |
| 7 `pnpm install` + `pnpm typecheck` | Pass, `TYPECHECK_OK` |
| 8 `CI=true pnpm tauri build --bundles app` | **Not run** (disk) |
| 9 ad-hoc sign, `codesign --verify`, bundle id | **Not run** (no bundle) |
| 15A `cd mobile && pnpm install`, `pnpm typecheck` | Pass |
| 15A `npx expo start --go --lan` | Pass: `packager-status:running` in 2 s; the iOS bundle builds (1278 modules) |
| Build inputs present in a clone (resources, icons, every `include_str!`) | Pass, none missing |
| `.gitignore` covers target, dist, `ios/`, harness and QA shots, `.env` | Pass |

Not checked: anything on a phone, Expo Go against the store's SDK, the Xcode
route (15B), pairing, and the app's first run (the built app would share the
owner's app data).

## Fixed in this pass

- **Versions disagreed.** `package.json` and `Cargo.toml` said 1.7.0 (Ship
  Studio's), `tauri.conf.json` said 0.1.0, so Info.plist said 0.1.0 while
  logs, MCP clients and error reports said 1.7.0. Now `package.json` is the
  one source (0.1.0): `tauri.conf.json` reads it (`"../package.json"`),
  `Cargo.toml` matches it, `pnpm check:brand` fails on drift, and
  `scripts/release.sh` bumps only the two.
- **Owner identifiers in the tree.** The Apple team id, the certificate ids
  beside it, the bundle-id hash derived from it, two GitHub logins, a tailnet
  id and a Vercel deployment URL in tests and harness fixtures are now
  obvious fakes (`TEAM000001`, …). They are still in **git history**.
- **INSTALL.md** caught up with the app: Accounts asks for a name ("Add and
  sign in"); the Chief is the team's admin (Settings → Agents → Admins); the
  import's consent Allow, and logins listed once per service under "Setting
  up your team"; the From Ship Studio tab.

## Before the repo goes public (not blocking testers)

- Rewrite or squash history: the team id is in past commits, and commits are
  authored with the owner's work email.
- `CODE_OF_CONDUCT.md` and `docs/ship-studio-readme.md` give the owner's
  personal email as the contact. Deliberate for Ship Studio; decide for this.
- Test fixtures use the owner's first name ("Julian's MacBook Pro",
  `/Users/julian/…`). Harmless, but `/Users/sam` would read as fiction.
- Expo Go only runs one SDK. If the store's Expo Go moves past SDK 58 before
  testers start, Step 15A stops working and 15B is the only route.
