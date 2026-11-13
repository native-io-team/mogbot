#!/bin/bash
# The App Store screenshots (docs/app-store.md, "Screenshots"), from a
# simulator Release build of the store config made with COMPANION_SCREENSHOTS=1,
# against the mock Mac's store cast (`pnpm mock --store …`, dev/mock-store.ts).
#
#   scripts/store-shots.sh <path/to/Mogbot.app> <out dir>
#
# iPhone 6.9" (1320×2868) and iPad 13" (2064×2752), light and dark, status
# bar at 9:41 with full bars and battery. Pairs once from a launch argument
# (lib/screenshots.ts), so no tap is needed.
set -euo pipefail
app="${1:?the simulator .app}"
out="${2:?an output folder}"
here="$(cd "$(dirname "$0")/.." && pwd)"
bundle=io.native.mogbot.companion
port=47561
state="$(mktemp -d)"
mkdir -p "$out"

IPHONE="${STORE_IPHONE:-iPhone 18 Pro Max}"
IPAD="${STORE_IPAD:-iPad Pro 13-inch (M5)}"

# name|route|stage
SHOTS=(
  "1-agents|/agents|pending"
  "2-approval|/chat/ostler|pending"
  "3-allowed|/chat/ostler|allowed"
  "4-result|/chat/ostler|published"
  "5-diff|/diff?agentId=ostler&messageId=ostler_changes|pending"
  "6-usage|/usage|pending"
)

mock_pid=""
start_mock() {
  [ -n "$mock_pid" ] && kill "$mock_pid" 2>/dev/null && wait "$mock_pid" 2>/dev/null || true
  (cd "$here" && exec npx tsx dev/mock.ts --port "$port" --state "$state" --store "$1") \
    >"$out/mock.log" 2>&1 &
  mock_pid=$!
  for _ in $(seq 1 60); do
    curl -sk "https://localhost:$port/dev/link" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "the mock Mac didn't start (see $out/mock.log)" >&2
  exit 1
}
trap '[ -n "$mock_pid" ] && kill "$mock_pid" 2>/dev/null; true' EXIT

shoot_device() {
  local device="$1" tag="$2"
  local udid
  udid="$(xcrun simctl list devices available | grep -F "$device (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
  [ -n "$udid" ] || { echo "no simulator called $device" >&2; exit 1; }
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl keychain "$udid" add-root-cert "$here/dev/.certs/cert.pem" 2>/dev/null || true
  xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiMode active \
    --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
  xcrun simctl uninstall "$udid" "$bundle" 2>/dev/null || true
  xcrun simctl install "$udid" "$app"
  for theme in light dark; do
    xcrun simctl ui "$udid" appearance "$theme"
    for s in "${SHOTS[@]}"; do
      IFS='|' read -r name route stage <<<"$s"
      start_mock "$stage"
      link="$(curl -sk "https://localhost:$port/dev/link")"
      xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
      xcrun simctl launch "$udid" "$bundle" -screenshotPair "$link" -screenshotRoute "$route" >/dev/null
      sleep "${STORE_SETTLE:-9}"
      xcrun simctl io "$udid" screenshot "$out/$name-$tag-$theme.png" >/dev/null
      echo "shot $name-$tag-$theme"
    done
  done
  xcrun simctl status_bar "$udid" clear
  xcrun simctl ui "$udid" appearance light
}

# Once first, so its certificate exists before the simulators trust it.
start_mock pending
shoot_device "$IPHONE" iphone
shoot_device "$IPAD" ipad
echo "done: $out"
