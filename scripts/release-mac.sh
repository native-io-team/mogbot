#!/usr/bin/env bash
# Build a signed (and, when the credentials exist, notarized and stapled) macOS
# DMG of the desktop app, from the identity in the login keychain.
#
#   ./scripts/release-mac.sh              # Apple Silicon (aarch64)
#   ./scripts/release-mac.sh --universal  # Apple Silicon + Intel in one binary (about twice the compile)
#   ./scripts/release-mac.sh --skip-build # re-sign/notarize/verify the last build
#
# Environment (all optional):
#   MOGBOT_SIGNING_IDENTITY   default "Developer ID Application: Galluzzo Conseil Inc. (N2VB8A88LB)"
#   MOGBOT_NOTARY_PROFILE     default "mogbot-notary" (a notarytool keychain profile)
#   CARGO_TARGET_DIR          where cargo builds; the DMG lands in $CARGO_TARGET_DIR/release-mac/
#
# Notarization uses a keychain profile, made once by the owner:
#   xcrun notarytool store-credentials mogbot-notary --apple-id <id> --team-id N2VB8A88LB
# Without that profile the script still builds and signs, says so, and skips
# notarization. Such a DMG opens only through System Settings on other Macs.
#
# Never uploads or publishes anything. It builds, signs, notarizes (Apple's
# service, nothing public) and verifies.
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
for arg in "$@"; do
  case "$arg" in
    --universal) UNIVERSAL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

[ "$(uname)" = "Darwin" ] || die "macOS only"

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
VERSION="$(node -p "require('./package.json').version")"
CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)"
[ "$VERSION" = "$CARGO_VERSION" ] || die "package.json says $VERSION but src-tauri/Cargo.toml says $CARGO_VERSION; run scripts/release.sh to line them up"

if [ "$UNIVERSAL" = 1 ]; then TRIPLE="universal-apple-darwin"; ARCH="universal"; else TRIPLE="aarch64-apple-darwin"; ARCH="aarch64"; fi
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/src-tauri/target}"
APP_PATH="$TARGET_DIR/$TRIPLE/release/bundle/macos/$APP_NAME.app"
OUT_DIR="$TARGET_DIR/release-mac"
DMG_PATH="$OUT_DIR/${APP_NAME}_${VERSION}_${ARCH}.dmg"

say "$APP_NAME $VERSION for $ARCH"
echo "    identity: $IDENTITY"
echo "    target:   $TARGET_DIR"

# ---------------------------------------------------------------- preflight
grep -qF "\"$IDENTITY\"" <<<"$(security find-identity -v -p codesigning)" \
  || die "identity not in the keychain: $IDENTITY (security find-identity -v -p codesigning)"
ok "signing identity found"

# Off-by-default outside services must stay off in a public build unless the
# owner turned them on in brand.json on purpose (CLAUDE.md, "Brand and identity").
node - <<'NODE' || die "brand.json turns on an outside service; check it is meant for this build"
const b = require('./brand.json');
const conf = require('./src-tauri/tauri.conf.json');
const on = [];
for (const [k, v] of Object.entries(b.telemetry || {})) if (v) on.push(`telemetry.${k}`);
for (const k of ['updates', 'errorReports', 'templateApi', 'pushRelay']) if (b.links[k]) on.push(`links.${k}`);
if (conf.plugins && conf.plugins.updater) on.push('tauri.conf.json plugins.updater');
if (conf.bundle && conf.bundle.createUpdaterArtifacts) on.push('tauri.conf.json bundle.createUpdaterArtifacts');
if (on.length) { console.error('  on: ' + on.join(', ')); process.exit(1); }
NODE
ok "telemetry, error reports, updater and template API are off (brand.json)"

if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  NOTARIZE=1
  ok "notary profile '$NOTARY_PROFILE' works"
else
  NOTARIZE=0
  warn "no working notary profile '$NOTARY_PROFILE': this run builds and signs only."
  warn "  To notarize, run once:  xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <apple id> --team-id ${TEAM_ID:-<team>}"
  warn "  (the password it asks for is an app-specific password from account.apple.com)"
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
  # The DMG is made below too, from the stapled app (Tauri's would hold the
  # app as it was before notarization).
  env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD \
      -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
      -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
      APPLE_SIGNING_IDENTITY="$IDENTITY" \
      pnpm tauri build --bundles app --target "$TRIPLE"
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
if [ "$NOTARIZE" = 1 ]; then
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

# ---------------------------------------------------------------- DMG
say "Making the DMG"
mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/${APP_NAME}-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP_PATH" "$STAGE/$APP_NAME.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG_PATH"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG_PATH" >/dev/null
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
shasum -a 256 "$DMG_PATH" | tee "$DMG_PATH.sha256"

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
