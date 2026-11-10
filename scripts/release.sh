#!/usr/bin/env bash
set -euo pipefail

# Bump the version, check the release notes exist, commit and tag. Local
# only: it pushes nothing. Building, notarizing and publishing is
# scripts/release-mac.sh (see RELEASING.md).
#
# Usage:
#   ./scripts/release.sh                                    # patch bump, notes already written
#   ./scripts/release.sh minor                              # minor bump
#   ./scripts/release.sh major                              # major bump
#   ./scripts/release.sh patch -n "**Fixed X** - What changed"        # write the notes from -n
#   ./scripts/release.sh minor -n "**A** - Detail" -n "**B** - Detail"
#
# The notes live in docs/release-notes-<version>.md (docs/release-notes-<major>.<minor>.md
# also counts for an x.y.0). They are what the update banner, latest.json and
# the release page show. -n writes that file when it doesn't exist yet.

BUMP_TYPE="patch"
NOTES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major) BUMP_TYPE="$1"; shift ;;
    -n|--note) NOTES+=("$2"); shift 2 ;;
    -h|--help) sed -n 4,17p "$0"; exit 0 ;;
    *) echo "Unknown argument: $1. Use -h for help."; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."

APP_NAME="$(node -p "require('./brand.json').name")"
CURRENT_VERSION="$(node -p "require('./package.json').version")"
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP_TYPE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW_VERSION}"
NOTES_FILE="docs/release-notes-${NEW_VERSION}.md"

echo "Current version: $CURRENT_VERSION"
echo "New version:     $NEW_VERSION ($BUMP_TYPE)"
echo ""

if ! git diff --quiet HEAD; then
  echo "Error: You have uncommitted changes. Commit them first."
  exit 1
fi

if [ ${#NOTES[@]} -gt 0 ]; then
  if [ -f "$NOTES_FILE" ]; then
    echo "Error: $NOTES_FILE already exists; edit it instead of passing -n."
    exit 1
  fi
  echo "Writing $NOTES_FILE..."
  {
    echo "# ${APP_NAME} ${NEW_VERSION}"
    echo ""
    echo "## What's new in ${NEW_VERSION}"
    echo ""
    for note in "${NOTES[@]}"; do echo "- ${note}"; done
  } > "$NOTES_FILE"
fi

if [ ! -f "$NOTES_FILE" ] && ! { [ "$PATCH" = 0 ] && [ -f "docs/release-notes-${MAJOR}.${MINOR}.md" ]; }; then
  echo "Error: no release notes for v${NEW_VERSION}."
  echo ""
  echo "Write $NOTES_FILE (a '## What's new in ${NEW_VERSION}' heading and '- **Title** - detail' bullets),"
  echo "or pass them with -n:"
  echo "  ./scripts/release.sh $BUMP_TYPE -n \"**Feature** - Description\""
  exit 1
fi
[ -f "$NOTES_FILE" ] || NOTES_FILE="docs/release-notes-${MAJOR}.${MINOR}.md"

# The dashboard's "What's new" (Changelog.tsx) is empty by design and hidden
# while it is; once it has entries, each release needs one.
if ! grep -q 'const CHANGELOG: ChangelogEntry\[\] = \[\];' src/components/dashboard/Changelog.tsx \
   && ! grep -q "v${NEW_VERSION}" src/components/dashboard/Changelog.tsx; then
  echo "Error: src/components/dashboard/Changelog.tsx has entries but none for v${NEW_VERSION}."
  exit 1
fi

# package.json is the version's one source: tauri.conf.json reads it
# ("version": "../package.json") and Cargo.toml carries a copy that
# `pnpm check:brand` holds to it.
echo "Bumping version in package.json..."
sed -i '' "1,10s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" package.json

echo "Bumping version in src-tauri/Cargo.toml..."
sed -i '' "s/^version = \"${CURRENT_VERSION}\"/version = \"${NEW_VERSION}\"/" src-tauri/Cargo.toml

echo "Updating Cargo.lock..."
(cd src-tauri && cargo update -p "$(node -p "require('../brand.json').slug")" 2>/dev/null || true)

node scripts/check-brand.mjs

git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock "$NOTES_FILE"
git commit -m "Release v${NEW_VERSION}"
git tag -a "$TAG" -m "$TAG"

echo ""
echo "Version bumped to $NEW_VERSION and tagged $TAG (local only; nothing pushed)."
echo ""
echo "Next:"
echo "  ./scripts/release-mac.sh             # build, notarize, staple, sign the update, write latest.json"
echo "  ./scripts/release-mac.sh --skip-build --publish   # once it says 'Ready to publish'"
echo "Push the branch and $TAG when the owner says to."
