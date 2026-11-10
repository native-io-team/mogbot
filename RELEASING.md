# Releasing the Mac app

Releases are made by hand on the owner's Mac: there is no release workflow in
this repo (`.github/workflows/` only builds and tests). Everything public lives
in the releases repo that `brand.json` names (`links.releases`, today
`native-io-team/mogbot-releases`): the DMG people download, and the signed
update bundle plus `latest.json` that installed copies update from. No source
is published there.

The two scripts:

- `scripts/release.sh` bumps the version, checks the release notes exist,
  commits and tags. Local only.
- `scripts/release-mac.sh` builds, signs, notarizes and staples, makes the
  updater bundle from the stapled app and signs it, writes `latest.json`, makes
  and notarizes the DMG, and verifies all of it. With `--publish` (opt-in) it
  then puts the release up with `gh`.

## Cutting 1.0.1 (and every release after it)

```bash
# 1. Notes: what the update banner, latest.json and the release page show.
#    Either write docs/release-notes-1.0.1.md yourself:
#      # Mogbot 1.0.1
#
#      ## What's new in 1.0.1
#
#      - **Faster replies** - What changed, in plain words.
#    or let release.sh write it from -n:
./scripts/release.sh patch -n "**Faster replies** - What changed, in plain words."

# 2. Build, notarize, staple, sign the update, write latest.json, make the DMG.
#    Waits on Apple twice (the app, then the DMG), usually a few minutes each.
./scripts/release-mac.sh

# 3. When it ends with "Ready to publish", publish (needs the owner's go-ahead:
#    it creates a public GitHub release and every installed copy updates to it).
./scripts/release-mac.sh --skip-build --publish

# 4. Push the release commit and tag (the owner's go-ahead again).
git push origin <branch> && git push origin v1.0.1
```

`--skip-build` in step 3 reuses step 2's app; an app that is already stapled
isn't sent to Apple again (the DMG is remade and notarized again, a few
minutes).

### What `--publish` does, in order

1. Creates release `v<version>` on the releases repo **as a draft**, with the
   DMG, its `.sha256`, `Mogbot_darwin-<arch>.app.tar.gz` and its `.sig`.
2. Uploads `latest.json` last, then marks the release published and latest. A
   draft is never "latest", so no installed copy reads a manifest whose bundle
   isn't up yet. (Re-running on a release that exists replaces the files, the
   bundle before the manifest.)
3. Points the releases repo README's download link (the bold link under
   `## Download`) at the new DMG.
4. Reads `latest.json` back from the public URL and checks the DMG and bundle
   URLs answer.

It refuses to run with `--skip-notarize`, or when notarization didn't happen.

### A dry run

```bash
./scripts/release-mac.sh --skip-notarize
```

Does everything except Apple's notarization (and publishing): the updater
bundle, its signature (checked against the public key), `latest.json` and the
DMG land in `$CARGO_TARGET_DIR/release-mac/`. Nothing it makes is fit to give
anyone. Use a `CARGO_TARGET_DIR` of its own if a real release is in flight in
another one: the build replaces the `.app` that release is about to staple.

## How updates work

- The app checks `links.updates`
  (`…/releases/latest/download/latest.json`) 15 seconds after launch and every
  four hours, from the main window only (`src/lib/updateStore.ts`). Never in
  `pnpm tauri dev`.
- A newer version downloads in the background. The updater plugin checks the
  bundle's signature against `plugins.updater.pubkey` in
  `src-tauri/tauri.conf.json` and rejects a mismatch; with
  `requireSignedVersion` it also rejects a bundle signed for a different
  version than the manifest names (a replayed older release).
- Only then does the sidebar say **Version x is ready — Restart to update**.
  Restart installs it (waiting for working agents first) and relaunches. An app
  in a folder the user can't write to asks for an administrator password at
  that moment, never in the background.
- **Later** (the ×) hides it for that version for good on this Mac; a newer
  version, or ⌘K → **Check for updates**, brings it back. A failed background
  download says nothing and is retried at the next check.
- `latest.json` has one platform for an Apple Silicon build
  (`darwin-aarch64`); an Intel Mac finds no entry and reports no update. A
  `--universal` build lists both.

## The update key

Every installed copy trusts exactly one public key, compiled in from
`tauri.conf.json`. **Losing the private key means no installed copy can ever
be updated again**; they'd all need a manual download of a build with a new
key. Back it up (the file and the password) somewhere offline.

- Private key: `~/.tauri/mogbot-updater.key` (mode 600). Never in the repo.
- Its password: the login Keychain, service `mogbot-updater-key-password`,
  account `release`. `release-mac.sh` reads it with `security` and hands it to
  `tauri signer sign` through the environment, never argv.
- Public key: `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.

Making a new one (only if it is lost or leaked; see the warning above):

```bash
# A random password, into the Keychain through `security -i` (stdin, not argv):
PW="$(openssl rand -hex 24)"
printf 'add-generic-password -U -a "release" -s "mogbot-updater-key-password" -w "%s"\n' "$PW" | security -i
# Then the key, typing that password at the prompts:
security find-generic-password -a release -s mogbot-updater-key-password -w | pbcopy
pnpm tauri signer generate -w ~/.tauri/mogbot-updater.key
chmod 600 ~/.tauri/mogbot-updater.key
# And the new public key into tauri.conf.json:
cat ~/.tauri/mogbot-updater.key.pub
```

## One-time setup (done on this Mac)

- **Developer ID Application** certificate for Galluzzo Conseil Inc.
  (N2VB8A88LB) in the login Keychain. Never the Memberstack Inc. one (J335CB82MX),
  which the script refuses.
- **Notary profile**:
  `xcrun notarytool store-credentials mogbot-notary --apple-id <id> --team-id N2VB8A88LB`
  (an app-specific password from account.apple.com).
- **gh** signed in with write access to the releases repo, for `--publish`.

## Checks that guard this

- `pnpm check:brand`: `plugins.updater` exists exactly when `links.updates` is
  set, its one endpoint is `links.updates`, its key is a minisign public key,
  `requireSignedVersion` is on and nothing `dangerous*` is set.
- `release-mac.sh` refuses a build whose app doesn't name the feed, a bundle
  whose signature doesn't verify (`scripts/verify-updater-sig.mjs`, the same
  check the app makes), a bundle that doesn't unpack to the signed (and
  stapled) app, and missing release notes.

## Why the bundle is made by the script, not by Tauri

`bundle.createUpdaterArtifacts` stays `false` in `tauri.conf.json`:

- Tauri would tar the app before it is notarized and stapled, so an update
  would install an app without its ticket.
- With it on, every `pnpm tauri build` without the private key fails, which
  is every build from source (docs/INSTALL.md).

So the build runs with it off, and `release-mac.sh` makes and signs the bundle
after stapling.

## Troubleshooting

- **Installed copies don't see the update.** `curl -sL <links.updates> | jq`:
  is it the new version, and does the `darwin-aarch64` URL download? The
  release must be published (not a draft) and marked latest.
- **"signature verification failed" in the log** (`~/Library/Logs/Mogbot/`).
  The bundle was signed with another key, or changed after signing. Re-run
  `release-mac.sh --skip-build` and re-publish.
- **"The update signature does not specify the version…"**: the bundle was
  signed without `--app-version`. `release-mac.sh` always passes it; re-sign
  with the script.
