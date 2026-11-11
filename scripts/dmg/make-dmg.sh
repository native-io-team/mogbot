#!/usr/bin/env bash
# Makes the installer DMG people download: a window that shows what to do,
# the app on the left, an arrow, Applications on the right.
#
#   scripts/dmg/make-dmg.sh <path/to/App.app> <out.dmg> <volume name>
#
# Finder lays the window out (the way create-dmg does it), so this needs a
# logged-in Mac and, the first time, an OK for the terminal to control Finder.
# If Finder can't be driven, the DMG is still made, just without the layout:
# a release never fails over looks.
set -euo pipefail

APP="$1"
OUT="$2"
VOL="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_FILE="$(basename "$APP")"

# Geometry: keep in step with background.html.
WIN_W=660
WIN_H=420
ICON=128
APP_X=170
APP_Y=210
APPS_X=490
APPS_Y=210

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dmg-make.XXXXXX")"
MNT=""
cleanup() {
  if [ -n "$MNT" ] && [ -d "$MNT" ]; then hdiutil detach "$MNT" -force >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# 1. The background, @1x and @2x in one TIFF so Retina screens get it sharp.
node "$HERE/render-background.mjs" "$WORK/bg" >/dev/null
tiffutil -cathidpicheck "$WORK/bg/background.png" "$WORK/bg/background@2x.png" -out "$WORK/background.tiff" >/dev/null 2>&1

# 2. A writable image with the app, the Applications link and the background.
STAGE="$WORK/stage"
mkdir -p "$STAGE/.background"
ditto "$APP" "$STAGE/$APP_FILE"
ln -s /Applications "$STAGE/Applications"
cp "$WORK/background.tiff" "$STAGE/.background/background.tiff"
if [ -f "$APP/Contents/Resources/icon.icns" ]; then
  cp "$APP/Contents/Resources/icon.icns" "$STAGE/.VolumeIcon.icns"
fi

SIZE_MB=$(( $(du -sm "$STAGE" | cut -f1) + 40 ))
RW="$WORK/rw.dmg"
hdiutil create -volname "$VOL" -srcfolder "$STAGE" -fs HFS+ -format UDRW -size "${SIZE_MB}m" -ov "$RW" >/dev/null

# Finder only shows volumes under /Volumes. If one of the same name is already
# there (an older DMG left open), ours lands at "<name> 1"; we address ours by
# its own mount point, so the right window is laid out either way.
MNT="$(hdiutil attach "$RW" -readwrite -noverify -noautoopen | awk -F'\t' '/\/Volumes\//{print $NF; exit}')"
[ -n "$MNT" ] && [ -d "$MNT" ] || { echo "make-dmg: could not mount the image" >&2; exit 1; }

# Custom volume icon on.
if [ -f "$MNT/.VolumeIcon.icns" ] && command -v SetFile >/dev/null 2>&1; then
  SetFile -c icnC "$MNT/.VolumeIcon.icns" 2>/dev/null || true
  SetFile -a C "$MNT" 2>/dev/null || true
fi

# 3. Finder writes the window's look into the volume's .DS_Store.
laid_out=1
if ! osascript <<OSA >/dev/null 2>"$WORK/osa.err"
tell application "Finder"
  set d to (POSIX file "$MNT" as alias)
  open d
  delay 2
  set w to container window of d
  set current view of w to icon view
  -- Newer Finders refuse these on some windows; the layout matters more.
  try
    set toolbar visible of w to false
  end try
  try
    set statusbar visible of w to false
  end try
  set bounds of w to {200, 120, 200 + $WIN_W, 120 + $WIN_H}
  set o to icon view options of w
  set arrangement of o to not arranged
  set icon size of o to $ICON
  set text size of o to 13
  set label position of o to bottom
  set shows item info of o to false
  set shows icon preview of o to true
  set background picture of o to (POSIX file "$MNT/.background/background.tiff" as alias)
  set position of item "$APP_FILE" of d to {$APP_X, $APP_Y}
  set position of item "Applications" of d to {$APPS_X, $APPS_Y}
  update d without registering applications
  delay 2
  try
    close w
  end try
end tell
OSA
then
  laid_out=0
  echo "make-dmg: Finder could not lay out the window (allow your terminal to control Finder in System Settings → Privacy & Security → Automation); making a plain DMG: $(cat "$WORK/osa.err")" >&2
fi

# Give Finder a moment to flush .DS_Store, then seal the image.
for _ in 1 2 3 4 5; do [ -f "$MNT/.DS_Store" ] && break; sleep 1; done
sync
rm -rf "$MNT/.fseventsd" 2>/dev/null || true
hdiutil detach "$MNT" >/dev/null || hdiutil detach "$MNT" -force >/dev/null
MNT=""

rm -f "$OUT"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null
[ "$laid_out" = 1 ] && echo "make-dmg: laid out" || true
