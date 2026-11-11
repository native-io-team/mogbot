#!/usr/bin/env bash
# Makes the installer DMG people download: a window that shows what to do,
# the app on the left, an arrow, Applications on the right.
#
#   scripts/dmg/make-dmg.sh <path/to/App.app> <out.dmg> <volume name>
#
# The layout (.DS_Store) is written by dmgbuild (settings.py), not by asking
# Finder: Finder's AppleScript reported success on 1.0.2's first DMG and never
# saved the layout, so people saw the old plain window. dmgbuild is found as
# $DMGBUILD, else `dmgbuild` on PATH, else the release tools venv
# (~/.mogbot-release-tools/dmgvenv, made with:
#   python3 -m venv ~/.mogbot-release-tools/dmgvenv &&
#   ~/.mogbot-release-tools/dmgvenv/bin/pip install dmgbuild==1.6.5).
# Without it the script fails, and release-mac.sh falls back to a plain DMG.
set -euo pipefail

APP="$1"
OUT="$2"
VOL="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"

DMGBUILD="${DMGBUILD:-}"
if [ -z "$DMGBUILD" ]; then
  if command -v dmgbuild >/dev/null 2>&1; then
    DMGBUILD="$(command -v dmgbuild)"
  elif [ -x "$HOME/.mogbot-release-tools/dmgvenv/bin/dmgbuild" ]; then
    DMGBUILD="$HOME/.mogbot-release-tools/dmgvenv/bin/dmgbuild"
  else
    echo "make-dmg: dmgbuild not found (see the header of $0)" >&2
    exit 1
  fi
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dmg-make.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# The background, @1x and @2x in one TIFF so Retina screens get it sharp.
node "$HERE/render-background.mjs" "$WORK/bg" >/dev/null
tiffutil -cathidpicheck "$WORK/bg/background.png" "$WORK/bg/background@2x.png" -out "$WORK/background.tiff" >/dev/null 2>&1

ICON="$APP/Contents/Resources/icon.icns"
rm -f "$OUT"
"$DMGBUILD" -s "$HERE/settings.py" \
  -D app="$APP" \
  -D background="$WORK/background.tiff" \
  -D icon="$ICON" \
  "$VOL" "$OUT" >/dev/null

# Prove the layout is in the image: the icon positions and the background.
MNT="$(hdiutil attach "$OUT" -nobrowse -readonly -noautoopen | awk -F'\t' '/\/Volumes\//{print $NF; exit}')"
ok=0
python3 - "$MNT/.DS_Store" <<'PY' && ok=1
import sys
b = open(sys.argv[1], 'rb').read()
sys.exit(0 if b'Iloc' in b and b'icvp' in b else 1)
PY
hdiutil detach "$MNT" >/dev/null 2>&1 || hdiutil detach "$MNT" -force >/dev/null 2>&1 || true
if [ "$ok" != 1 ]; then
  echo "make-dmg: the DMG has no window layout" >&2
  exit 1
fi
echo "make-dmg: laid out"
