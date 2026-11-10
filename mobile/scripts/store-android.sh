#!/usr/bin/env bash
# The Google Play build of the phone app: an Android App Bundle (.aab),
# checked, ready to upload by hand. It never uploads and never signs in
# anywhere (docs/play-store.md, "Building the store bundle").
#
#   mobile/scripts/store-android.sh [--build-number N] [--require-upload-key]
#                                   [--out DIR] [--keep-native]
#
#   --build-number N      the versionCode (default: COMPANION_BUILD_NUMBER, else 1).
#                         It must go up with every upload to Play.
#   --require-upload-key  fail unless the upload key is configured, so the
#                         bundle can go to Play (without it the release is
#                         signed with the debug key, fine for a local check only).
#   --out DIR             where the .aab goes (default mobile/store-build/android).
#   --keep-native         keep mobile/android afterwards (default: removed).
#
# The upload key comes from Gradle properties (~/.gradle/gradle.properties)
# or the environment, never from the repo:
#   COMPANION_UPLOAD_STORE_FILE     absolute path to the upload keystore (.jks)
#   COMPANION_UPLOAD_STORE_PASSWORD
#   COMPANION_UPLOAD_KEY_ALIAS
#   COMPANION_UPLOAD_KEY_PASSWORD
# Optional: GOOGLE_SERVICES_JSON=<path> compiles Firebase in for push (FCM).
#
# Needs: Node, JDK 17 (JAVA_HOME), the Android SDK (ANDROID_HOME, default
# ~/Library/Android/sdk). Gradle and the SDK platform it needs are fetched by
# the Gradle wrapper on the first run.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
build_number="${COMPANION_BUILD_NUMBER:-1}"
require_key=0
keep_native=0
out="$here/store-build/android"

while [ $# -gt 0 ]; do
  case "$1" in
    --build-number) build_number="$2"; shift 2 ;;
    --require-upload-key) require_key=1; shift ;;
    --out) out="$2"; shift 2 ;;
    --keep-native) keep_native=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "store-android: unknown option $1" >&2; exit 2 ;;
  esac
done

fail() { echo "store-android: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

case "$build_number" in ''|*[!0-9]*|0) fail "--build-number must be a whole number from 1 (got '$build_number')." ;; esac

step "Checking the tools"
command -v node >/dev/null || fail "Node isn't installed."
if [ -z "${JAVA_HOME:-}" ] && [ -d "$HOME/.local/jdk" ]; then
  JAVA_HOME="$(find "$HOME/.local/jdk" -maxdepth 3 -type d -name Home -path '*jdk-17*' | head -1)"
fi
[ -n "${JAVA_HOME:-}" ] && export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
java -version >/dev/null 2>&1 || fail "No Java. Install JDK 17 (Temurin or Zulu) and set JAVA_HOME."
java_major="$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
[ "${java_major:-0}" -ge 17 ] || fail "JDK 17 or newer is needed (found $java_major)."
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$ANDROID_HOME" ] || fail "No Android SDK at $ANDROID_HOME. Install Android Studio or the command-line tools."
echo "Java $java_major ($JAVA_HOME), Android SDK $ANDROID_HOME, versionCode $build_number"

prop() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$HOME/.gradle/gradle.properties" ]; then
    v="$(sed -n "s/^$1=//p" "$HOME/.gradle/gradle.properties" | tail -1)"
  fi
  printf '%s' "$v"
}
if [ -n "$(prop COMPANION_UPLOAD_STORE_FILE)" ]; then
  for k in COMPANION_UPLOAD_STORE_PASSWORD COMPANION_UPLOAD_KEY_ALIAS COMPANION_UPLOAD_KEY_PASSWORD; do
    [ -n "$(prop "$k")" ] || fail "$k isn't set (COMPANION_UPLOAD_STORE_FILE is)."
  done
  [ -f "$(prop COMPANION_UPLOAD_STORE_FILE)" ] || fail "No keystore at $(prop COMPANION_UPLOAD_STORE_FILE)."
  signing="upload key"
elif [ "$require_key" = 1 ]; then
  fail "No upload key (COMPANION_UPLOAD_STORE_FILE). See docs/play-store.md, \"Signing\"."
else
  signing="debug key (local check only: Play refuses it)"
fi
echo "Signing: $signing"

step "Generating the Android project (expo prebuild)"
cd "$here"
COMPANION_STORE_BUILD=1 COMPANION_BUILD_NUMBER="$build_number" CI=1 \
  npx expo prebuild --platform android --clean --no-install

step "Building the App Bundle (gradle bundleRelease)"
cd "$here/android"
COMPANION_STORE_BUILD=1 COMPANION_BUILD_NUMBER="$build_number" \
  ./gradlew --no-daemon bundleRelease

aab="$here/android/app/build/outputs/bundle/release/app-release.aab"
manifest="$(find "$here/android/app/build/intermediates" -path '*release*' -name AndroidManifest.xml \
  -path '*merged_manifest*' | head -1)"
[ -f "$aab" ] || fail "No bundle at $aab."
[ -f "$manifest" ] || fail "No merged release manifest to check."

step "Checking the bundle"
expected_id="$(node -p "require('$here/../brand.json').companion.bundleId")"
attr() { sed -n "s/.*android:$1=\"\([^\"]*\)\".*/\1/p" "$manifest" | head -1; }
pkg="$(sed -n 's/.*package="\([^"]*\)".*/\1/p' "$manifest" | head -1)"
[ -n "$pkg" ] || pkg="$(sed -n "s/.*applicationId '\([^']*\)'.*/\1/p" "$here/android/app/build.gradle" | head -1)"
vcode="$(attr versionCode)"; vname="$(attr versionName)"; target="$(attr targetSdkVersion)"; min="$(attr minSdkVersion)"
echo "package      $pkg"
echo "version      $vname ($vcode)"
echo "SDK          min $min, target $target"
[ "$pkg" = "$expected_id" ] || fail "package is $pkg, not brand.json's $expected_id."
[ "$vcode" = "$build_number" ] || fail "versionCode is $vcode, not $build_number."
[ "${target:-0}" -ge 35 ] || fail "targetSdk $target is below what Google Play accepts."
perms="$(grep -o 'uses-permission[^>]*android:name="[^"]*"' "$manifest" | sed 's/.*name="//;s/"//' | sort -u)"
echo "permissions:"; printf '  %s\n' $perms
allowed="android.permission.INTERNET android.permission.ACCESS_NETWORK_STATE android.permission.ACCESS_WIFI_STATE android.permission.CAMERA android.permission.RECORD_AUDIO android.permission.POST_NOTIFICATIONS android.permission.VIBRATE android.permission.WAKE_LOCK com.google.android.c2dm.permission.RECEIVE $pkg.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
for p in $perms; do
  case " $allowed " in *" $p "*) ;; *) fail "unexpected permission $p (add it to ANDROID_PERMISSIONS on purpose, or block it)." ;; esac
done
if grep -q 'android:debuggable="true"' "$manifest"; then fail "the release manifest is debuggable."; fi
cert="$(keytool -printcert -jarfile "$aab" 2>/dev/null | sed -n 's/^Owner: //p' | head -1)"
echo "signed by    ${cert:-unsigned}"
case "$cert" in *"Android Debug"*) echo "  (the debug key: fine to check, not to upload)";; esac

mkdir -p "$out"
dest="$out/app-release-$vname-$vcode.aab"
cp "$aab" "$dest"
echo "bundle       $dest ($(du -h "$dest" | cut -f1))"

if [ "$keep_native" = 0 ]; then
  cd "$here" && rm -rf "$here/android"
fi

step "Next"
if [ "$require_key" = 1 ] || [[ "$signing" == "upload key" ]]; then
  cat <<EOF
Upload $dest in Play Console → the app → Test and release → Testing →
Internal testing (or Closed testing) → Create new release. Play App Signing
re-signs it with the app signing key Google holds. Nothing was uploaded.
EOF
else
  cat <<EOF
This bundle is signed with the debug key, so Play won't take it. Set the
upload key (docs/play-store.md, "Signing") and run again with
--require-upload-key. Nothing was uploaded.
EOF
fi
