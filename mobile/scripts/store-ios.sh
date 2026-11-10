#!/usr/bin/env bash
# The App Store build of the phone app: prebuild, pods, archive, export to an
# .ipa on disk, and checks. It never uploads (docs/app-store.md, "Building the
# store binary").
#
#   mobile/scripts/store-ios.sh [--sign] [--build-number N]
#        [--api-key PATH --api-key-id ID --api-issuer ISSUER]
#        [--out DIR] [--derived-data DIR] [--keep-native]
#
#   (no --sign)     an unsigned archive: proves the store config still builds.
#                   Nothing reaches Apple; there is no export.
#   --sign          sign with team N2VB8A88LB (automatic signing,
#                   -allowProvisioningUpdates), then export with
#                   store/ExportOptions.plist (destination export). This talks
#                   to Apple as the owner: on the first run it registers the
#                   bundle id and makes the distribution certificate and profile.
#   --api-key PATH, --api-key-id ID, --api-issuer ISSUER
#                   an App Store Connect API key (.p8) instead of an Xcode
#                   sign-in, passed to xcodebuild as -authenticationKey*.
#   --build-number N  CFBundleVersion (default COMPANION_BUILD_NUMBER, else 1);
#                   it must go up with every upload of a version.
#   --out DIR       archive and .ipa (default mobile/store-build/ios).
#   --derived-data DIR  xcodebuild's derived data (default mobile/store-build/DerivedData).
#   --keep-native   keep mobile/ios afterwards (default: removed).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
team="N2VB8A88LB"
sign=0
build_number="${COMPANION_BUILD_NUMBER:-1}"
api_key="" api_key_id="" api_issuer=""
out="$here/store-build/ios"
derived=""
keep_native=0

while [ $# -gt 0 ]; do
  case "$1" in
    --sign) sign=1; shift ;;
    --build-number) build_number="$2"; shift 2 ;;
    --api-key) api_key="$2"; shift 2 ;;
    --api-key-id) api_key_id="$2"; shift 2 ;;
    --api-issuer) api_issuer="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --derived-data) derived="$2"; shift 2 ;;
    --keep-native) keep_native=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "store-ios: unknown option $1" >&2; exit 2 ;;
  esac
done
derived="${derived:-$here/store-build/DerivedData}"

fail() { echo "store-ios: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

case "$build_number" in ''|*[!0-9]*|0) fail "--build-number must be a whole number from 1 (got '$build_number')." ;; esac
auth=()
if [ -n "$api_key$api_key_id$api_issuer" ]; then
  [ -n "$api_key" ] && [ -n "$api_key_id" ] && [ -n "$api_issuer" ] ||
    fail "--api-key, --api-key-id and --api-issuer go together."
  [ -f "$api_key" ] || fail "No API key file at $api_key."
  [ "$sign" = 1 ] || fail "An API key is only used with --sign."
  auth=(-authenticationKeyPath "$api_key" -authenticationKeyID "$api_key_id" -authenticationKeyIssuerID "$api_issuer")
fi

step "Checking the tools"
command -v node >/dev/null || fail "Node isn't installed."
command -v pod >/dev/null || fail "CocoaPods isn't installed."
xcode="$(xcodebuild -version 2>/dev/null)" || fail "Xcode isn't set up (xcode-select -p)."
echo "${xcode%%$'\n'*}"
expected_id="$(node -p "require('$here/../brand.json').companion.bundleId")"
echo "bundle id $expected_id, build $build_number, $([ "$sign" = 1 ] && echo "signed for team $team" || echo unsigned)"

export COMPANION_STORE_BUILD=1 COMPANION_BUILD_NUMBER="$build_number"
unset COMPANION_BUNDLE_ID APPLE_TEAM_ID

step "Generating the iOS project (expo prebuild)"
cd "$here"
CI=1 npx expo prebuild --platform ios --clean --no-install

step "Installing pods"
cd "$here/ios"
pod install

workspace="$(ls -d "$here"/ios/*.xcworkspace | sed -n 1p)"
scheme="$(basename "$workspace" .xcworkspace)"
[ -d "$workspace" ] || fail "No workspace in mobile/ios."
mkdir -p "$out"
archive="$out/$scheme.xcarchive"
rm -rf "$archive"

step "Archiving ($scheme, Release)"
if [ "$sign" = 1 ]; then
  xcodebuild archive -workspace "$workspace" -scheme "$scheme" -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$archive" -derivedDataPath "$derived" \
    -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} \
    DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic
else
  xcodebuild archive -workspace "$workspace" -scheme "$scheme" -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$archive" -derivedDataPath "$derived" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" DEVELOPMENT_TEAM="$team"
fi

app="$(ls -d "$archive"/Products/Applications/*.app | sed -n 1p)"
[ -d "$app" ] || fail "The archive has no app."

if [ "$sign" = 1 ]; then
  step "Exporting (destination export: nothing is uploaded)"
  export_dir="$out/export"
  rm -rf "$export_dir"
  /usr/libexec/PlistBuddy -c 'Print :destination' "$here/store/ExportOptions.plist" | grep -qx export ||
    fail "store/ExportOptions.plist must keep destination export."
  xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$here/store/ExportOptions.plist" \
    -exportPath "$export_dir" -allowProvisioningUpdates ${auth[@]+"${auth[@]}"}
  ipa="$(ls "$export_dir"/*.ipa | sed -n 1p)"
  [ -f "$ipa" ] || fail "No .ipa was exported."
  unpacked="$out/ipa"
  rm -rf "$unpacked" && mkdir -p "$unpacked"
  unzip -q "$ipa" -d "$unpacked"
  app="$(ls -d "$unpacked"/Payload/*.app | sed -n 1p)"
fi

step "Checking the app"
plist="$app/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist" 2>/dev/null || true; }
id="$(pb CFBundleIdentifier)"; version="$(pb CFBundleShortVersionString)"; build="$(pb CFBundleVersion)"
echo "bundle id    $id"
echo "version      $version ($build)"
echo "copyright    $(pb NSHumanReadableCopyright)"
echo "ATS          arbitrary loads $(pb NSAppTransportSecurity:NSAllowsArbitraryLoads)"
echo "encryption   non-exempt $(pb ITSAppUsesNonExemptEncryption)"
[ "$id" = "$expected_id" ] || fail "bundle id is $id, not brand.json's $expected_id."
[ "$build" = "$build_number" ] || fail "build number is $build, not $build_number."
[ -n "$version" ] || fail "no version."
[ "$(pb NSAppTransportSecurity:NSAllowsArbitraryLoads)" = false ] || fail "ATS allows arbitrary loads."
[ -z "$(pb NSFaceIDUsageDescription)" ] || fail "a Face ID string is in the store build."
[ -f "$app/PrivacyInfo.xcprivacy" ] || fail "no privacy manifest in the app."

if [ "$sign" = 1 ]; then
  aps="$(codesign -d --entitlements :- "$app" 2>/dev/null | plutil -extract aps-environment raw - 2>/dev/null || true)"
  team_signed="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  echo "aps          $aps"
  echo "signed by    team $team_signed"
  [ "$aps" = production ] || fail "aps-environment is '$aps', not production."
  [ "$team_signed" = "$team" ] || fail "signed by team $team_signed, not $team."
else
  ent="$(ls "$here"/ios/"$scheme"/*.entitlements 2>/dev/null | sed -n 1p)"
  aps="$([ -n "$ent" ] && plutil -extract aps-environment raw "$ent" 2>/dev/null || true)"
  echo "aps          $aps in the project's entitlements (an App Store export makes it production)"
  [ -n "$aps" ] || fail "no aps-environment in the store build's entitlements."
fi

if [ "$keep_native" = 0 ]; then
  rm -rf "$here/ios"
fi

step "Next"
if [ "$sign" = 1 ]; then
  cat <<EOF
Exported: $ipa
Nothing was uploaded. To send it to App Store Connect (as the owner):
  xcrun altool --validate-app -f "$ipa" -t ios --apiKey <key id> --apiIssuer <issuer id>
  xcrun altool --upload-app   -f "$ipa" -t ios --apiKey <key id> --apiIssuer <issuer id>
or drag it into Transporter, or open the archive in Xcode's Organizer.
EOF
else
  cat <<EOF
Unsigned archive: $archive
The store config builds. To make the App Store build, sign in to Xcode with
the team's Apple ID (or create an App Store Connect API key) and run:
  mobile/scripts/store-ios.sh --sign --build-number $build_number
Delete $out and $derived when done.
EOF
fi
