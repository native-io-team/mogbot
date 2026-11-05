#!/usr/bin/env bash
# PLACEHOLDER app icons. Real branding comes later (docs/MISSION.md: the name and
# mark are never made prominent). Until then every icon is a neutral monochrome
# mark: a black rounded square with a white ring, no text, no colour.
#
#   bash scripts/generate-placeholder-icons.sh
#
# Writes:
#   src-tauri/icons/*            every desktop size + .icns/.ico, via `tauri icon`
#   src-tauri/icons/ios/*        the Tauri mobile sets `tauri icon` writes beside them
#   src-tauri/icons/android/*
#   src-tauri/icons/tray/*       the menu-bar template (black, tinted by macOS)
#   public/app-icon-dark.png     Dock icon option (also the default)
#   public/app-icon-light.png    Dock icon option, inverted
#   public/favicon.png
#
# Needs ImageMagick (`magick`) and rsvg-convert. Replace this whole script when
# there is a real mark.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1024 canvas, macOS icon grid: an 824px body inset 100px, ~185px corner radius.
icon_svg() {
  local bg="$1" fg="$2"
  cat <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="$bg"/>
  <circle cx="512" cy="512" r="200" fill="none" stroke="$fg" stroke-width="72"/>
</svg>
SVG
}

icon_svg '#000000' '#ffffff' >"$WORK/dark.svg"
icon_svg '#ffffff' '#000000' >"$WORK/light.svg"
rsvg-convert -w 1024 -h 1024 "$WORK/dark.svg" -o "$WORK/dark.png"
rsvg-convert -w 1024 -h 1024 "$WORK/light.svg" -o "$WORK/light.png"

# Desktop bundle icons (all sizes, .icns, .ico), and the Tauri mobile sets
# (ios/, android/) from the same run, so no old artwork is left in either.
# The companion app's own icons live in mobile/ and are not touched here.
(cd "$ROOT" && pnpm exec tauri icon "$WORK/dark.png" -o "$WORK/tauri-icons" >/dev/null)
for f in "$WORK"/tauri-icons/*.png "$WORK"/tauri-icons/icon.icns "$WORK"/tauri-icons/icon.ico; do
  cp "$f" "$ROOT/src-tauri/icons/"
done
cp -R "$WORK/tauri-icons/ios/." "$ROOT/src-tauri/icons/ios/"
cp -R "$WORK/tauri-icons/android/." "$ROOT/src-tauri/icons/android/"

magick "$WORK/dark.png" -resize 512x512 "$ROOT/public/app-icon-dark.png"
magick "$WORK/light.png" -resize 512x512 "$ROOT/public/app-icon-light.png"
magick "$WORK/dark.png" -resize 64x64 "$ROOT/public/favicon.png"

# Menu-bar template: black ring only (macOS tints a template image). The
# attention variant adds a dot at the top right (something needs you), with the
# ring cut away around it so the two never merge at menu-bar size.
cat >"$ROOT/src-tauri/icons/tray/tray.svg" <<'SVG'
<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
  <!-- PLACEHOLDER mark (scripts/generate-placeholder-icons.sh), as a macOS template. -->
  <circle cx="18" cy="18" r="11" fill="none" stroke="#000" stroke-width="4"/>
</svg>
SVG
cat >"$ROOT/src-tauri/icons/tray/tray-attention.svg" <<'SVG'
<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
  <!-- tray.svg with a dot at the top right: something needs you. -->
  <defs>
    <mask id="cut">
      <rect width="36" height="36" fill="#fff"/>
      <circle cx="29" cy="7" r="7.5" fill="#000"/>
    </mask>
  </defs>
  <circle cx="18" cy="18" r="11" fill="none" stroke="#000" stroke-width="4" mask="url(#cut)"/>
  <circle cx="29" cy="7" r="5.5" fill="#000"/>
</svg>
SVG
rsvg-convert -w 36 -h 36 "$ROOT/src-tauri/icons/tray/tray.svg" -o "$ROOT/src-tauri/icons/tray/tray.png"
rsvg-convert -w 36 -h 36 "$ROOT/src-tauri/icons/tray/tray-attention.svg" \
  -o "$ROOT/src-tauri/icons/tray/tray-attention.png"

echo "Placeholder icons written."
