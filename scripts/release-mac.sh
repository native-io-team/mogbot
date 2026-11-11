#!/usr/bin/env bash
# Build a signed, notarized and stapled macOS release of the desktop app from
# the identity in the login keychain: the DMG people download, and the signed
# updater bundle + latest.json that installed copies update from.
#
#   ./scripts/release-mac.sh                  # Apple Silicon (aarch64)
#   ./scripts/release-mac.sh --universal      # Apple Silicon + Intel in one binary (about twice the compile)
#   ./scripts/release-mac.sh --skip-build     # re-sign/notarize/verify the last build
#   ./scripts/release-mac.sh --skip-notarize  # a dry run: everything but Apple's notarization
#   ./scripts/release-mac.sh --publish        # ...then publish it (below). Never with --skip-notarize
#
# Environment (all optional):
#   MOGBOT_SIGNING_IDENTITY   default "Developer ID Application: Galluzzo Conseil Inc. (N2VB8A88LB)"
#   MOGBOT_NOTARY_PROFILE     default "mogbot-notary" (a notarytool keychain profile)
#   MOGBOT_UPDATER_KEY        the updater's private key, default ~/.tauri/<slug>-updater.key
#   CARGO_TARGET_DIR          where cargo builds; everything lands in $CARGO_TARGET_DIR/release-mac/
#
# Notarization uses a keychain profile, made once by the owner:
#   xcrun notarytool store-credentials mogbot-notary --apple-id <id> --team-id N2VB8A88LB
# Without that profile the script still builds and signs, says so, and skips
# notarization. Such a DMG opens only through System Settings on other Macs.
#
# Updates (when brand.json names links.updates): the app is notarized and
# stapled FIRST, then the updater bundle (<App>_darwin-<arch>.app.tar.gz) is
# made from that stapled app and signed with the updater key. Its password is
# the login-Keychain item "<slug>-updater-key-password" (account "release"),
# or TAURI_SIGNING_PRIVATE_KEY_PASSWORD when already set. The signature is
# checked against the public key in tauri.conf.json, and latest.json is
# written with the notes from docs/release-notes-<version>.md (or
# docs/release-notes-<major>.<minor>.md for x.y.0).
#
# --publish (opt-in, and only after a notarized run) puts it all on the
# releases repo brand.json links.releases names, with `gh`: release
# v<version> is made as a draft with every asset, latest.json goes up last,
# then it is marked published and latest, so no installed copy ever reads a
# manifest whose bundle isn't there yet. Then the repo README's download link
# is pointed at the new DMG. Without --publish nothing leaves this Mac but
# Apple's notarization upload.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; NC='\033[0m'
say()  { echo -e "${BOLD}==>${NC} $*"; }
ok()   { echo -e "${GREEN}ok${NC}  $*"; }
warn() { echo -e "${YELLOW}!!${NC}  $*"; }
die()  { echo -e "${RED}error:${NC} $*" >&2; exit 1; }

UNIVERSAL=0
SKIP_BUILD=0
SKIP_NOTARIZE=0
PUBLISH=0
for arg in "$@"; do
  case "$arg" in
    --universal) UNIVERSAL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --publish) PUBLISH=1 ;;
    -h|--help) sed -n 2,38p "$0"; exit 0 ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

[ "$(uname)" = "Darwin" ] || die "macOS only"
if [ "$PUBLISH" = 1 ] && [ "$SKIP_NOTARIZE" = 1 ]; then
  die "--publish needs a notarized build; drop --skip-notarize"
fi

IDENTITY="${MOGBOT_SIGNING_IDENTITY:-Developer ID Application: Galluzzo Conseil Inc. (N2VB8A88LB)}"
NOTARY_PROFILE="${MOGBOT_NOTARY_PROFILE:-mogbot-notary}"
TEAM_ID="$(sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p' <<<"$IDENTITY")"

# The Memberstack Inc. Developer ID on this Mac belongs to another company
# (Ship Studio's old builds). Never sign this app with it.
case "$IDENTITY" in
  *Memberstack*|*J335CB82MX*) die "refusing to sign with the Memberstack Inc. identity" ;;
esac
[[ "$IDENTITY" == "Developer ID Application:"* ]] || die "a public download needs a 'Developer ID Application' identity, got: $IDENTITY"

APP_NAME="$(node -p "require('./brand.json').name")"
APP_DIR_NAME="$(node -p "require('./brand.json').appDirName")"
SLUG="$(node -p "require('./brand.json').slug")"
UPDATES_FEED="$(node -p "require('./brand.json').links.updates || ''")"
RELEASES="$(node -p "require('./brand.json').links.releases || ''")"
VERSION="$(node -p "require('./package.json').version")"
CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)"
[ "$VERSION" = "$CARGO_VERSION" ] || die "package.json says $VERSION but src-tauri/Cargo.toml says $CARGO_VERSION; run scripts/release.sh to line them up"

if [ "$UNIVERSAL" = 1 ]; then
  TRIPLE="universal-apple-darwin"; ARCH="universal"; ARCH_LABEL="Apple Silicon and Intel"
else
  TRIPLE="aarch64-apple-darwin"; ARCH="aarch64"; ARCH_LABEL="Apple Silicon"
fi
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/src-tauri/target}"
APP_PATH="$TARGET_DIR/$TRIPLE/release/bundle/macos/$APP_NAME.app"
APP_BASENAME="$(basename "$APP_PATH")"
OUT_DIR="$TARGET_DIR/release-mac"
DMG_NAME="${APP_NAME}_${VERSION}_${ARCH}.dmg"
DMG_PATH="$OUT_DIR/$DMG_NAME"
# The updater bundle's asset name. install_version (the Changelog's rewind,
# src-tauri/src/commands/setup/auth.rs) downloads this same name per tag.
UPDATER_NAME="${APP_DIR_NAME}_darwin-${ARCH}.app.tar.gz"
UPDATER_PATH="$OUT_DIR/$UPDATER_NAME"
LATEST_JSON="$OUT_DIR/latest.json"
TAG="v$VERSION"

say "$APP_NAME $VERSION for $ARCH"
echo "    identity: $IDENTITY"
echo "    target:   $TARGET_DIR"

# ---------------------------------------------------------------- preflight
grep -qF "\"$IDENTITY\"" <<<"$(security find-identity -v -p codesigning)" \
  || die "identity not in the keychain: $IDENTITY (security find-identity -v -p codesigning)"
ok "signing identity found"

# Off-by-default outside services must stay off in a public build unless the
# owner turned them on in brand.json on purpose (CLAUDE.md, "Brand and identity").
# The update feed is the one this script exists to publish; check:brand holds
# its config (one endpoint = links.updates, a minisign pubkey, signed versions).
node - <<'NODE' || die "brand.json turns on an outside service; check it is meant for this build"
const b = require('./brand.json');
const on = [];
for (const [k, v] of Object.entries(b.telemetry || {})) if (v) on.push(`telemetry.${k}`);
for (const k of ['errorReports', 'templateApi', 'pushRelay']) if (b.links[k]) on.push(`links.${k}`);
if (on.length) { console.error('  on: ' + on.join(', ')); process.exit(1); }
NODE
ok "telemetry, error reports and template API are off (brand.json)"
node scripts/check-brand.mjs >/dev/null || die "brand copies drift from brand.json (node scripts/check-brand.mjs)"
ok "brand copies match brand.json"

UPDATER=0
if [ -n "$UPDATES_FEED" ]; then
  UPDATER=1
  [ -n "$RELEASES" ] || die "brand.json names links.updates but no links.releases to host the bundle under"
  [ "$UPDATES_FEED" = "${RELEASES%/}/latest/download/latest.json" ] \
    || die "links.updates ($UPDATES_FEED) isn't latest.json on links.releases ($RELEASES): the bundle would go somewhere the app never looks"
  UPDATER_KEY="${MOGBOT_UPDATER_KEY:-$HOME/.tauri/${SLUG}-updater.key}"
  [ -f "$UPDATER_KEY" ] || die "no updater private key at $UPDATER_KEY (see RELEASING.md, 'The update key')"
  # Never on argv: the Keychain hands it to this shell, which passes it on
  # through the environment of the one command that signs.
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+set}" ]; then
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -a release -s "${SLUG}-updater-key-password" -w 2>/dev/null)" \
      || die "no Keychain item '${SLUG}-updater-key-password' (account 'release') holding the updater key's password (RELEASING.md)"
  fi
  ok "updater key: $UPDATER_KEY"
else
  warn "brand.json names no update feed: no updater bundle or latest.json (installed copies won't update)"
  [ "$PUBLISH" = 1 ] && die "--publish needs links.updates and links.releases in brand.json"
fi

# Release notes: what the update banner, latest.json and the release page show.
NOTES_FILE=""
if [ -f "docs/release-notes-$VERSION.md" ]; then
  NOTES_FILE="docs/release-notes-$VERSION.md"
elif [ "${VERSION##*.}" = 0 ] && [ -f "docs/release-notes-${VERSION%.*}.md" ]; then
  NOTES_FILE="docs/release-notes-${VERSION%.*}.md"
elif [ "$UPDATER" = 1 ]; then
  die "no release notes: write docs/release-notes-$VERSION.md (scripts/release.sh -n does)"
fi
[ -n "$NOTES_FILE" ] && ok "release notes: $NOTES_FILE"

RELEASES_REPO=""
if [ "$PUBLISH" = 1 ]; then
  RELEASES_REPO="$(sed -n 's#^https://github.com/\([^/]*/[^/]*\)/releases/*$#\1#p' <<<"$RELEASES")"
  [ -n "$RELEASES_REPO" ] || die "links.releases isn't a GitHub releases page: $RELEASES"
  gh auth status >/dev/null 2>&1 || die "gh isn't signed in (gh auth login)"
  gh repo view "$RELEASES_REPO" >/dev/null 2>&1 || die "this gh account can't see $RELEASES_REPO"
  ok "will publish to $RELEASES_REPO as $TAG"
fi

if [ "$SKIP_NOTARIZE" = 1 ]; then
  NOTARIZE=0
  warn "--skip-notarize: a dry run. Nothing it makes is fit to give anyone."
elif xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  NOTARIZE=1
  ok "notary profile '$NOTARY_PROFILE' works"
else
  NOTARIZE=0
  warn "no working notary profile '$NOTARY_PROFILE': this run builds and signs only."
  warn "  To notarize, run once:  xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <apple id> --team-id ${TEAM_ID:-<team>}"
  warn "  (the password it asks for is an app-specific password from account.apple.com)"
  [ "$PUBLISH" = 1 ] && die "--publish needs notarization"
fi

# ---------------------------------------------------------------- build
if [ "$SKIP_BUILD" = 0 ]; then
  if [ "$UNIVERSAL" = 1 ]; then
    for t in aarch64-apple-darwin x86_64-apple-darwin; do
      grep -qx "$t" <<<"$(rustup target list --installed)" || die "missing Rust target $t (rustup target add $t)"
    done
  fi
  say "Building (pnpm tauri build --bundles app --target $TRIPLE)"
  # Tauri signs with APPLE_SIGNING_IDENTITY from the keychain, with the
  # hardened runtime and src-tauri/Entitlements.plist. Notarization is done
  # below with the keychain profile, so Tauri's own notarize env is cleared.
  # The DMG and the updater bundle are made below too, from the stapled app
  # (Tauri's would hold the app as it was before notarization), so Tauri's
  # own updater artifacts are off and the update key isn't in its env.
  env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD \
      -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
      -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
      -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
      APPLE_SIGNING_IDENTITY="$IDENTITY" \
      pnpm tauri build --bundles app --target "$TRIPLE" \
        --config '{"bundle":{"createUpdaterArtifacts":false}}'
fi
[ -d "$APP_PATH" ] || die "no app at $APP_PATH"
ok "app: $APP_PATH"

# ---------------------------------------------------------------- check the app's signature
say "Checking the app's signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
SIGINFO="$(codesign -dvv "$APP_PATH" 2>&1)"
grep -qF "Authority=$IDENTITY" <<<"$SIGINFO" || die "app is not signed by $IDENTITY"
grep -q "flags=.*runtime" <<<"$SIGINFO" || die "app is signed without the hardened runtime"
grep -q "^Timestamp=" <<<"$SIGINFO" || die "app signature has no secure timestamp (notarization needs one)"
ENTS="$(codesign -d --entitlements - --xml "$APP_PATH" 2>/dev/null || true)"
for e in com.apple.security.automation.apple-events com.apple.security.device.audio-input \
         com.apple.security.personal-information.calendars com.apple.security.personal-information.addressbook; do
  grep -q "$e" <<<"$ENTS" || die "entitlement missing from the signed app: $e"
done
grep -q "get-task-allow" <<<"$ENTS" && die "app carries get-task-allow (debug); notarization refuses it"
# Entitlements that switch parts of the hardened runtime back off: any of
# these lets another process or a planted library run code as the app (which
# holds the agents' Keychain items and its Apple Events / Contacts / Calendar
# grants). Entitlements.plist asks for none; a dependency or a hand edit must
# not slip one in.
for e in com.apple.security.cs.disable-library-validation \
         com.apple.security.cs.allow-dyld-environment-variables \
         com.apple.security.cs.allow-unsigned-executable-memory \
         com.apple.security.cs.disable-executable-page-protection \
         com.apple.security.cs.debugger; do
  if grep -q "$e" <<<"$ENTS"; then die "app carries $e, which weakens the hardened runtime"; fi
done
ok "signed by the identity, hardened runtime, timestamped, entitlements present"

# Every Mach-O inside the bundle must be signed by us too, or notarization fails.
UNSIGNED=()
while IFS= read -r -d '' f; do
  # Captured, not piped into grep -q: with pipefail, grep -q closing the pipe
  # early fails the pipeline and reads as "unsigned".
  if [[ "$(file -b "$f")" == *Mach-O* ]]; then
    info="$(codesign -dvv "$f" 2>&1 || true)"
    [[ "$info" == *"Authority=$IDENTITY"* ]] || UNSIGNED+=("$f")
  fi
done < <(find "$APP_PATH/Contents" -type f -print0)
[ ${#UNSIGNED[@]} -eq 0 ] || die "binaries in the bundle not signed by the identity: ${UNSIGNED[*]}"
ok "every binary in the bundle is signed"

# The update channel compiled into this app: the feed and key it will trust.
if [ "$UPDATER" = 1 ]; then
  APP_STRINGS="$(strings -a "$APP_PATH/Contents/MacOS/"* 2>/dev/null)"
  grep -qF "$UPDATES_FEED" <<<"$APP_STRINGS" \
    || die "the built app doesn't name the update feed $UPDATES_FEED (stale build? run without --skip-build)"
  PUBKEY="$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey")"
  grep -qF "$PUBKEY" <<<"$APP_STRINGS" \
    || die "the built app doesn't carry tauri.conf.json's updater public key (stale build? run without --skip-build)"
  ok "the app checks $UPDATES_FEED for updates, trusting this key"
fi

# What a public build reaches out to: report anything still naming Ship Studio
# or a telemetry host, so it is looked at before release.
say "Scanning the bundle for outside endpoints"
SCAN="$( { strings -a "$APP_PATH/Contents/MacOS/"* ; find "$APP_PATH/Contents/Resources" -type f \( -name '*.js' -o -name '*.json' -o -name '*.html' \) -exec cat {} + ; } 2>/dev/null \
  | grep -oE 'https?://[A-Za-z0-9._/-]*(shipstudio|ship-studio|memberstack|posthog|sentry\.io|ingest\.)[A-Za-z0-9._/-]*' | sort -u || true)"
if [ -n "$SCAN" ]; then
  warn "URLs in the bundle worth a look (present is not the same as contacted):"
  sed 's/^/      /' <<<"$SCAN"
else
  ok "no Ship Studio or telemetry URLs found"
fi

# ---------------------------------------------------------------- notarize the app
if [ "$NOTARIZE" = 1 ] && xcrun stapler validate "$APP_PATH" >/dev/null 2>&1; then
  ok "app is already notarized and stapled (an earlier run); not resubmitting"
elif [ "$NOTARIZE" = 1 ]; then
  say "Notarizing the app (this waits on Apple, usually a few minutes)"
  ZIP="$OUT_DIR/.${APP_NAME}-notarize.zip"
  mkdir -p "$OUT_DIR"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP_PATH" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json | tee "$OUT_DIR/notary-app.json"
  rm -f "$ZIP"
  grep -q '"status" *: *"Accepted"' "$OUT_DIR/notary-app.json" \
    || die "Apple did not accept the app. Log: xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE"
  xcrun stapler staple "$APP_PATH"
  ok "app notarized and stapled"
fi

# ---------------------------------------------------------------- updater bundle
# From the app as it is now: notarized and stapled (unless this is a dry run),
# so an update is as trusted offline as the DMG. Tauri's updater unpacks the
# archive's one top-level folder in place of the running .app.
if [ "$UPDATER" = 1 ]; then
  say "Making the updater bundle"
  mkdir -p "$OUT_DIR"
  rm -f "$UPDATER_PATH" "$UPDATER_PATH.sig" "$LATEST_JSON"
  # No AppleDouble files or extended attributes (quarantine, Finder info).
  COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$UPDATER_PATH" -C "$(dirname "$APP_PATH")" "$APP_BASENAME"
  TAURI_SIGNING_PRIVATE_KEY_PATH="$UPDATER_KEY" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
    pnpm --silent tauri signer sign --app-version "$VERSION" "$UPDATER_PATH" >/dev/null \
    || die "signing the updater bundle failed (wrong key password?)"
  [ -s "$UPDATER_PATH.sig" ] || die "no signature next to $UPDATER_PATH"
  node scripts/verify-updater-sig.mjs "$UPDATER_PATH" "$UPDATER_PATH.sig" --version "$VERSION" \
    || die "the updater bundle's signature doesn't verify against tauri.conf.json's public key"
  ok "updater bundle: $UPDATER_PATH (+ .sig)"

  # What an installed copy will unpack: the same app, still signed (and stapled).
  UNPACK="$(mktemp -d "${TMPDIR:-/tmp}/${APP_DIR_NAME}-updater.XXXXXX")"
  tar -xzf "$UPDATER_PATH" -C "$UNPACK"
  [ -d "$UNPACK/$APP_BASENAME" ] || die "the updater bundle doesn't hold $APP_BASENAME at its top"
  [ "$(find "$UNPACK" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ] || die "the updater bundle holds more than the app at its top"
  codesign --verify --deep --strict "$UNPACK/$APP_BASENAME" || die "the app inside the updater bundle fails codesign --verify"
  if [ "$NOTARIZE" = 1 ]; then
    xcrun stapler validate "$UNPACK/$APP_BASENAME" >/dev/null || die "the app inside the updater bundle isn't stapled"
  fi
  rm -rf "$UNPACK"
  ok "it unpacks to the signed$( [ "$NOTARIZE" = 1 ] && echo ', stapled') app"

  say "Writing latest.json"
  [ "$NOTARIZE" = 1 ] || warn "latest.json points at an un-notarized bundle: a dry run, never publish it"
  BUNDLE_URL="${RELEASES%/}/download/$TAG/$UPDATER_NAME"
  VERSION="$VERSION" NOTES_FILE="$NOTES_FILE" PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" ARCH="$ARCH" \
  BUNDLE_URL="$BUNDLE_URL" SIG_FILE="$UPDATER_PATH.sig" OUT="$LATEST_JSON" node - <<'NODE' || die "couldn't write latest.json"
const fs = require('fs');
const e = process.env;
const entry = { signature: fs.readFileSync(e.SIG_FILE, 'utf8').trim(), url: e.BUNDLE_URL };
// A universal bundle runs on both; an aarch64 one only on Apple Silicon, so
// an Intel copy finds no entry for itself and reports "no update".
const platforms =
  e.ARCH === 'universal'
    ? { 'darwin-aarch64': entry, 'darwin-x86_64': entry }
    : { 'darwin-aarch64': entry };
const manifest = {
  version: e.VERSION,
  notes: fs.readFileSync(e.NOTES_FILE, 'utf8').trim(),
  pub_date: e.PUB_DATE,
  platforms,
};
fs.writeFileSync(e.OUT, JSON.stringify(manifest, null, 2) + '\n');
NODE
  ok "latest.json: $LATEST_JSON (bundle at $BUNDLE_URL)"
fi

# ---------------------------------------------------------------- DMG
say "Making the DMG"
mkdir -p "$OUT_DIR"
rm -f "$DMG_PATH"
# The window people see: the app, an arrow, Applications (scripts/dmg/).
# If Finder can't lay it out, fall back to the plain image.
if ! "$REPO_ROOT/scripts/dmg/make-dmg.sh" "$APP_PATH" "$DMG_PATH" "$APP_NAME"; then
  warn "Designed DMG failed; making a plain one"
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/${APP_NAME}-dmg.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  ditto "$APP_PATH" "$STAGE/$APP_NAME.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG_PATH" >/dev/null
fi
codesign --force --timestamp --sign "$IDENTITY" "$DMG_PATH"
ok "dmg: $DMG_PATH"

if [ "$NOTARIZE" = 1 ]; then
  say "Notarizing the DMG"
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json | tee "$OUT_DIR/notary-dmg.json"
  grep -q '"status" *: *"Accepted"' "$OUT_DIR/notary-dmg.json" \
    || die "Apple did not accept the DMG. Log: xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE"
  xcrun stapler staple "$DMG_PATH"
  ok "DMG notarized and stapled"
fi

# ---------------------------------------------------------------- verify
say "Verifying"
FAIL=0
echo "--- codesign --verify --deep --strict (app)"
codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1 || FAIL=1
echo "--- codesign --verify (dmg)"
codesign --verify --strict --verbose=2 "$DMG_PATH" 2>&1 || FAIL=1
echo "--- spctl -a -vvv -t exec (app)"
spctl -a -vvv -t exec "$APP_PATH" 2>&1 || if [ "$NOTARIZE" = 1 ]; then FAIL=1; fi
echo "--- spctl -a -vvv -t install (dmg)"
spctl -a -vvv -t install "$DMG_PATH" 2>&1 || if [ "$NOTARIZE" = 1 ]; then FAIL=1; fi
if [ "$NOTARIZE" = 1 ]; then
  echo "--- stapler validate"
  xcrun stapler validate "$APP_PATH" 2>&1 || FAIL=1
  xcrun stapler validate "$DMG_PATH" 2>&1 || FAIL=1
fi
if [ "$UPDATER" = 1 ]; then
  ( cd "$OUT_DIR" && shasum -a 256 "$DMG_NAME" "$UPDATER_NAME" ) | tee "$DMG_PATH.sha256"
else
  ( cd "$OUT_DIR" && shasum -a 256 "$DMG_NAME" ) | tee "$DMG_PATH.sha256"
fi

echo
if [ "$FAIL" = 1 ]; then
  die "verification failed (above)"
elif [ "$NOTARIZE" = 1 ]; then
  ok "${BOLD}Ready to publish:${NC} $DMG_PATH"
else
  warn "Signed but NOT notarized: $DMG_PATH"
  warn "Gatekeeper rejects it on other Macs until it is notarized. Store the '$NOTARY_PROFILE' profile and run:"
  warn "  ./scripts/release-mac.sh --skip-build$( [ "$UNIVERSAL" = 1 ] && echo ' --universal')"
fi

# ---------------------------------------------------------------- publish (opt-in)
if [ "$PUBLISH" = 0 ]; then
  if [ "$NOTARIZE" = 1 ] && [ "$UPDATER" = 1 ]; then
    echo "    publish with: ./scripts/release-mac.sh --skip-build --publish$( [ "$UNIVERSAL" = 1 ] && echo ' --universal')"
  fi
  exit 0
fi
[ "$NOTARIZE" = 1 ] || die "not publishing a build that wasn't notarized"

say "Publishing $TAG to $RELEASES_REPO"
# Mogbot.dmg: the same DMG under a name that never changes, so the website can
# link releases/latest/download/Mogbot.dmg and always hand out the newest one.
STABLE_DMG="$(dirname "$DMG_PATH")/$APP_NAME.dmg"
cp -f "$DMG_PATH" "$STABLE_DMG"
ASSETS=("$DMG_PATH" "$DMG_PATH.sha256" "$STABLE_DMG" "$UPDATER_PATH" "$UPDATER_PATH.sig")
if gh release view "$TAG" -R "$RELEASES_REPO" >/dev/null 2>&1; then
  # Replacing a release's files: the bundle and its signature go up before
  # the manifest that names them.
  gh release upload "$TAG" -R "$RELEASES_REPO" --clobber "${ASSETS[@]}"
  gh release upload "$TAG" -R "$RELEASES_REPO" --clobber "$LATEST_JSON"
  gh release edit "$TAG" -R "$RELEASES_REPO" --title "$APP_NAME $VERSION" --notes-file "$NOTES_FILE" --draft=false --latest
else
  # A draft isn't "latest", so nobody reads its manifest until every file is up.
  gh release create "$TAG" -R "$RELEASES_REPO" --draft --title "$APP_NAME $VERSION" \
    --notes-file "$NOTES_FILE" "${ASSETS[@]}"
  gh release upload "$TAG" -R "$RELEASES_REPO" "$LATEST_JSON"
  gh release edit "$TAG" -R "$RELEASES_REPO" --draft=false --latest
fi
ok "release $TAG published"

say "Pointing the README's download link at $DMG_NAME"
DMG_URL="${RELEASES%/}/download/$TAG/$DMG_NAME"
README_SHA="$(gh api "repos/$RELEASES_REPO/contents/README.md" --jq .sha)"
README_NEW="$(gh api "repos/$RELEASES_REPO/contents/README.md" --jq .content \
  | LABEL="$APP_NAME $VERSION for Mac ($ARCH_LABEL)" URL="$DMG_URL" node scripts/release-readme-link.mjs)" \
  || README_NEW=""
if [ -n "$README_NEW" ]; then
  gh api -X PUT "repos/$RELEASES_REPO/contents/README.md" \
    -f message="Download: $APP_NAME $VERSION" -f content="$README_NEW" -f sha="$README_SHA" >/dev/null
  ok "README links to $DMG_URL"
else
  warn "README not updated: no download link under '## Download'. Point it at $DMG_URL by hand"
fi

say "Checking what installed copies will see"
LIVE_VERSION="$(curl -fsSL "$UPDATES_FEED" 2>/dev/null | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(b).version))}catch{}})' || true)"
if [ "$LIVE_VERSION" = "$VERSION" ]; then
  ok "$UPDATES_FEED says $VERSION"
else
  warn "$UPDATES_FEED says '${LIVE_VERSION:-nothing}', not $VERSION yet (GitHub can take a minute); check again"
fi
for u in "$DMG_URL" "${RELEASES%/}/download/$TAG/$UPDATER_NAME"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -L -r 0-0 "$u" || true)"
  if [ "$code" = 206 ] || [ "$code" = 200 ]; then ok "$u"; else warn "$u -> HTTP $code"; fi
done
