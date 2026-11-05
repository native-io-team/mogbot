#!/usr/bin/env bash
#
# One-command installer for macOS.
#
#   curl -fsSL <this script's URL> | bash
#
# Downloads the latest build from this app's own releases, installs it to
# /Applications, and launches it. It still clears the quarantine flag as
# belt-and-braces for older, un-notarized builds.
#
# A build with no releases of its own (`links.releases` null in brand.json)
# has nothing to download, and this script says so and stops. It never falls
# back to another app's releases.
#
# Uses only tools that ship with macOS (curl, tar, ditto, xattr) -- no Python,
# no Homebrew, nothing to install first.
#
# Options (env vars):
#   SHIPSTUDIO_DEST=/path        install dir (default: /Applications)
#   SHIPSTUDIO_NO_LAUNCH=1       install but don't open the app afterwards
set -euo pipefail

# --- brand (generated from brand.json by `node scripts/check-brand.mjs --write`) ---
BRAND_NAME="Dashbot"
BRAND_RELEASES=""
# --- end brand ---

APP_NAME="${BRAND_NAME}.app"
DEST="${SHIPSTUDIO_DEST:-/Applications}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

[ -n "$BRAND_RELEASES" ] || err "${BRAND_NAME} has no published releases to install yet. Build it from source instead: see docs/INSTALLATION.md in its repository."
MANIFEST="${BRAND_RELEASES%/}/latest/download/latest.json"

[ "$(uname -s)" = "Darwin" ] || err "This installer is for macOS. On Windows, use scripts/install.ps1."

# Map the CPU to the updater's platform key.
case "$(uname -m)" in
  arm64)  PLATFORM="darwin-aarch64" ;;
  x86_64) PLATFORM="darwin-x86_64" ;;
  *)      err "Unsupported architecture: $(uname -m)" ;;
esac

# Resolve the current version + download URL from the same manifest the
# auto-updater uses. Its URL points at the correct release tag's .app.tar.gz,
# so this is robust even though the newest GitHub release is a Windows one.
say "Finding the latest version..."
JSON="$(curl -fsSL "$MANIFEST")" || err "Could not reach the release manifest."
VERSION="$(printf '%s' "$JSON" | tr -d '\n' | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
URL="$(printf '%s' "$JSON" | tr -d '\n' | grep -oE "\"${PLATFORM}\"[^}]*\"url\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" | grep -oE 'https://[^"]+')"
[ -n "$URL" ] || err "No download found for ${PLATFORM} in the manifest."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading ${BRAND_NAME} ${VERSION:-latest} (${PLATFORM})..."
curl -fSL --progress-bar "$URL" -o "$TMP/app.tar.gz" || err "Download failed: $URL"

say "Extracting..."
tar -xzf "$TMP/app.tar.gz" -C "$TMP"
APP_PATH="$(find "$TMP" -maxdepth 2 -name '*.app' -type d | head -1)"
[ -n "$APP_PATH" ] || err "No .app found inside the downloaded archive."

# Use sudo only if the install dir isn't writable by the current user.
run() { "$@"; }
mkdir -p "$DEST" 2>/dev/null || true
if [ ! -w "$DEST" ]; then
  say "${DEST} needs admin access -- you may be prompted for your password."
  run() { sudo "$@"; }
fi

if [ -d "${DEST}/${APP_NAME}" ]; then
  say "Removing the previous install..."
  run rm -rf "${DEST}/${APP_NAME}"
fi

say "Installing to ${DEST} ..."
run ditto "$APP_PATH" "${DEST}/${APP_NAME}"

# Clear the quarantine flag so Gatekeeper doesn't block first launch.
say "Clearing the quarantine flag..."
run xattr -dr com.apple.quarantine "${DEST}/${APP_NAME}" 2>/dev/null || true

say "${BRAND_NAME} ${VERSION:-} installed to ${DEST}."
if [ -z "${SHIPSTUDIO_NO_LAUNCH:-}" ]; then
  open "${DEST}/${APP_NAME}"
fi
