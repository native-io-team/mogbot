# Release checklist

What stands between "testers build it from the repo" (docs/INSTALL.md) and a
signed download plus an App Store / TestFlight phone app. As of 2026-11-05,
read from the repo. Nothing here has been tried against an Apple account.

Status: **ready** (in the repo and correct), **owner** (needs the owner's
account or a decision), **work** (needs code or config changes).

## (a) Signed and notarized desktop DMG

| Item | Status | Notes |
| --- | --- | --- |
| Apple Developer Program membership | owner | Pending. Everything below waits on it |
| Developer ID Application certificate (.p12) | owner | Steps in RELEASING.md, "Setting up the Apple secrets" |
| App Store Connect API key for `notarytool` | owner | Same section. `xcrun notarytool history` checks it |
| Bundle identifier | ready | `io.native.mogbot` (brand.json → tauri.conf.json, checked by `pnpm check:brand`). Changing it later moves every user's app data, so settle it before the first public build |
| Hardened runtime | ready | Tauri 2 turns it on by default (`bundle.macOS.hardenedRuntime`), and `tauri.conf.json` doesn't turn it off |
| Entitlements | ready | `src-tauri/Entitlements.plist`: `automation.apple-events` (Spotify widget) and `device.audio-input` (dictation). No sandbox. Matching usage strings are in `src-tauri/Info.plist`. Both only show up as broken in a notarized build, so test both there |
| Signing identity in config | ready | Not hardcoded. `APPLE_SIGNING_IDENTITY` / `APPLE_CERTIFICATE` env vars, and `scripts/build-notarized.sh` checks for them |
| Release workflow | work | RELEASING.md describes a tag-triggered GitHub Actions job (universal build, sign, notarize, staple, `spctl` gate, two repos). **It isn't in this repo**: `.github/workflows/` has only `ci.yml` and `dependency-security-scan.yml`. Port it from Ship Studio, or release by hand with `scripts/build-notarized.sh` |
| RELEASING.md | work | Still Ship Studio's: repo names, `ShipStudio_*.dmg` asset names, the Memberstack history. Rewrite once the pipeline exists |
| Version numbers | work | `package.json` and `Cargo.toml` say 1.7.0 (Ship Studio's line). `tauri.conf.json` says **0.1.0**, and that's what the `.app` reports. `scripts/release.sh` bumps all three to the same number, so pick one before the first tag. The phone install flow checks out the tag `v<Cargo version>` |
| Unsigned local build | work (small) | `pnpm tauri build` with no identity leaves only the executable linker-signed, so `codesign --verify --deep` fails on the bundle ("code has no resources but signature indicates they must be present"). docs/INSTALL.md re-signs ad hoc after copying. A repo fix would be `bundle.macOS.signingIdentity: "-"` in tauri.conf.json, but that also turns on the hardened runtime with ad-hoc signing, which hasn't been tried |
| Universal binary | work | Needs `rustup target add x86_64-apple-darwin aarch64-apple-darwin` and `--target universal-apple-darwin`. Not tried here |
| Gatekeeper check | owner | After notarizing: `spctl -a -vvv -t install <dmg>` must say `accepted`, `source=Notarized Developer ID` |
| CSP null | ready (known) | Deliberate, see CLAUDE.md "CSP Must Be Null". Check terminal fonts in the notarized build |

## (b) Phone app: TestFlight and the App Store

| Item | Status | Notes |
| --- | --- | --- |
| Bundle id | owner | `companion.bundleId` = `io.native.mogbot.companion` in brand.json. `app.config.ts` marks it a placeholder until the App Store Connect record exists. Register the id, then keep brand.json the source (`COMPANION_BUNDLE_ID` overrides it per build) |
| App Store Connect app record | owner | Gives the `ascAppId` |
| EAS project | owner | `eas init` gives `EAS_PROJECT_ID`. Without it `app.config.ts` turns OTA updates off and `extra.official` is false, so push says "Needs the official build". Set it in EAS env, not in the repo |
| `eas.json` submit block | work | `ascAppId`, `ascApiKeyIssuerId`, `ascApiKeyId` are `PLACEHOLDER_*`. `ascApiKeyPath` points at `./credentials/asc-api-key.p8`, which is now gitignored (`mobile/credentials/`). Better to use EAS-stored credentials and drop the path |
| Build profiles | ready | `development`, `development-simulator`, `preview`, `apk`, `production` (channels match). `appVersionSource: remote`, `autoIncrement` on production |
| Push entitlement (`aps-environment`) | work | The `expo-notifications` plugin adds it at prebuild. Needs the push capability on the App ID and an APNs key. The relay (`services/push-relay/`) is built but not deployed, and `wrangler.jsonc` still has `APNS_TOPIC: com.shipstudio.companion` and Ship Studio's worker and DB names. Fix it to the new bundle id, deploy, and set `links.pushRelay`. Steps: docs/push-relay.md |
| Share extension ("Send to agent…") | work | Behind `SHIPSTUDIO_SHARE_EXTENSION=1`. Needs an App Group and a second App ID for the extension, and it has never been built or tried on a device (docs/mobile.md, "Not built"). Ship v1 without it, or test it first |
| Privacy manifest (`PrivacyInfo.xcprivacy`) | work | `app.config.ts` has no `ios.privacyManifests`. React Native and some modules use required-reason APIs (UserDefaults, file timestamps, system boot time). Expo modules bring their own manifests, but the app-level one is generated from `ios.privacyManifests`, so declare the reasons and check the build's merged manifest |
| Usage strings | ready | Camera, microphone, photos and speech in `app.config.ts`. `ITSAppUsesNonExemptEncryption: false`: check that's still true (TLS through the OS, Ed25519 / X25519 from `@noble`, used for authentication and key agreement. Apple usually treats that as exempt, but the owner answers the export question) |
| App Store privacy answers | owner | Data we collect: none. No telemetry on the phone, no account of ours, and content goes phone → the user's own Mac over their tailnet. With push on, the relay sees a device token and an opaque handle, no content (docs/push-relay.md). Answer "Data not collected", unless push counts as "Device ID → App functionality, not linked" (it's arguably needed) |
| Review notes | owner | Reviewers can't reach a Mac on a tailnet. Notes should explain: the app is a remote for the user's own Mac app; it needs Tailscale on both devices; it does nothing alone. Give a demo route: a reviewer tailnet with a Mac running the app (or the mock Mac, `pnpm mock --http --public-url …`, served with `tailscale serve`), a share invite for that tailnet, and a pairing link. Expect guideline 2.1 / 4.2 questions ("needs other hardware") and answer them up front. A demo video helps |
| Icons and screenshots | work | `mobile/assets/*.png` are placeholder art ("until real branding lands") |
| Minimum OS, iPad | ready (check) | `supportsTablet: true`, so iPad screenshots are required too |
| TestFlight expiry | known | Builds expire after 90 days. docs/mobile.md says to ship one at least every 60 days |
| `TESTFLIGHT_URL` / `ANDROID_APK_URL` | work | Unset in `src/lib/companionInstall.ts`. Set them after the first build so the Phone panel offers them |
| `links.companionSource` | owner | Null. Until it names this repo, a built `.app` hides "Get the phone app" (testers must self-build by hand or run from source; docs/INSTALL.md, Route B) |

## (c) brand.json links that are null

Every null link turns its feature off and the UI hides it.

| Key | Null today means | Set it to turn on |
| --- | --- | --- |
| `links.updates` | No auto-update (updater plugin not registered; `pnpm check:brand` requires `plugins.updater` exactly when this is set) | The `latest.json` feed URL. Also needs `TAURI_SIGNING_PRIVATE_KEY` and `createUpdaterArtifacts: true` |
| `links.releases` | No "install a specific version" (rewind); `scripts/install.sh` refuses | The releases page |
| `links.issueRepo` | No in-app issue reports | `owner/repo` |
| `links.securityAdvisories`, `links.discussions`, `links.community`, `links.website` | Those links and CTAs hidden, no PR footer credit | URLs |
| `links.errorReports` | No automatic error reports (Rust) | Endpoint |
| `links.templateApi` | No template gallery | Ship Studio's services, or your own |
| `links.companionSource` | Built `.app` can't build the phone app (above) | This repo's git URL |
| `links.pushRelay` | No push | The deployed relay URL |
| `telemetry.posthogKey` / `posthogHost` / `sentryDsn` | Nothing sent (compile-time) | Keys. Only with a privacy note to match, and the App Store answers change |
| `links.starterRepoBase` | **Set** to `https://github.com/ship-studio`: project templates still clone from Ship Studio's org | Leave it (shared compat), or fork the starters |
| `repository` | Set to `https://github.com/native-io-team/mogbot` | Make sure that's the repo testers get |

## (d) Licence and attribution

| Item | Status | Notes |
| --- | --- | --- |
| `LICENSE` | ready | MIT, "Copyright (c) 2026 Julian Galluzzo and Ship Studio contributors". Matches `package.json`, `Cargo.toml`, `packages/*` and the README's "MIT" |
| Right to relicense the Ship Studio history | owner | The history is Ship Studio's. RELEASING.md says the Ship Studio main repo was **private**, and early builds were signed by Memberstack Inc. The MIT `LICENSE` arrived in "Prepare repo for open-sourcing" (2026-05-28). Confirm the owner has the right to publish all of it as MIT (no Memberstack or contributor IP left unlicensed) before the repo goes public |
| `mobile/package.json`, `services/push-relay` | work (small) | No `license` field. Add `"license": "MIT"` |
| `THIRD_PARTY_NOTICES.md` | work (small) | Lists scrcpy (vendored, Apache-2.0) and serve-sim. Still says "Ship Studio". Bundled fonts (`src-tauri/fonts/`, JetBrains Mono Nerd Font: OFL) aren't listed. Check the font licences and add them |
| npm/cargo dependency licences | not checked | Run `pnpm licenses list` and `cargo deny check licenses` (or `cargo about`) before publishing binaries |

## (e) Secrets that must never be in the repo

Must stay out: the Developer ID `.p12` and its password, the App Store Connect
`.p8` key and ids, `TAURI_SIGNING_PRIVATE_KEY`, the APNs/FCM key (relay
secrets go to `wrangler secret put`), `RELEASES_PAT`, Azure signing
credentials, the EAS token, PostHog/Sentry keys (compile-time, from brand.json
or CI env), and anything from a user's Keychain.

Ignore rules: the root `.gitignore` covers `.env*`, `*.p12`, `*.pfx`, `*.cer`,
`*.key`, `*.pem`, and now also `*.p8`, `*.mobileprovision`,
`*.provisionprofile`, `mobile/credentials/` and `mobile/credentials.json`
(added with this checklist, because `eas.json` points at
`./credentials/asc-api-key.p8`). `mobile/.gitignore` also covers `*.p8`,
`*.p12`, `*.jks`, `*.key`, `*.mobileprovision`.

**Scan (2026-11-05).** Patterns: AWS, private-key blocks, GitHub, Anthropic,
OpenAI, Slack, PostHog, Sentry DSN, Google, JWT, Vercel, npm, Tailscale keys.
Ran over every tracked file and over the added lines of every commit on every
local ref (2,430 commits, merges not diffed).

- **Tracked files: nothing real.** All hits are test fixtures or harness
  values made to look like secrets (`ghp_abc…`, `sk-ant-oat01-abcDEF…`,
  AWS's documented `AKIAIOSFODNN7EXAMPLE`, `vercel_…harnessTOKEN…`,
  `-----BEGIN … PRIVATE KEY-----` headers with no key) in
  `src-tauri/src/agents/{files,review,task,work/tests}.rs`,
  `src-tauri/src/commands/{accounts,team/writer}.rs`,
  `src/lib/agentSecrets.test.ts`, `src/harness/scenarios/hostingConnect.ts`.
  No key files are tracked. `.env.example` has no values.
- **History: two real-looking client keys, both Ship Studio's.**
  - A **Sentry DSN** added in `a402cd94` ("Add Sentry error monitoring",
    2026-04-15) in `src-tauri/src/logging.rs` and `src/instrument.ts`.
  - A **PostHog project key** (`phc_…`) added in `1e053d68` ("Add PostHog
    analytics", 2026-02-17) in `src-tauri/src/commands/analytics.rs`, and in
    `13a59ab6` in `.planning/codebase/INTEGRATIONS.md`.

  Both are ingestion keys that ship inside client apps, so they're public by
  design. They can't read data, but anyone holding them can send events into
  Ship Studio's projects. They're no longer in the tree. Before the history
  goes public, the owner decides: accept it (and tell whoever owns those
  projects), rotate them in Sentry/PostHog, or rewrite history
  (`git filter-repo`). Values not reproduced here.
- Not covered: binary files, high-entropy strings that match no known
  pattern, and refs that aren't in this clone (remote-only branches, PR refs).
  Run `gitleaks detect --log-opts="--all"` or `trufflehog git file://.` on
  the full mirror before publishing.

## Before sending the repo to testers

- [ ] The repo testers get matches `repository` in brand.json, and they have
      access (it's private: they need a GitHub invite, or a zip)
- [ ] docs/INSTALL.md followed on a clean Mac or a Tart VM
      (`scripts/onboarding-vm.sh fresh`), the phone part on a real phone
- [ ] Expo Go in the stores runs SDK 58 (otherwise testers need Route B)
