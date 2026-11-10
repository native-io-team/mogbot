#!/bin/bash
# Whole agent turns against a scripted fake engine: deterministic, free and
# offline (no model, no account, no Keychain). Runs in a throwaway HOME.
# See src-tauri/examples/agents_fake/main.rs and scripts/fake-engine/.
#   scripts/agents-fake-e2e.sh                 # every scenario
#   scripts/agents-fake-e2e.sh normal stop     # some
#   AGENTS_FAKE_KEEP=1 scripts/agents-fake-e2e.sh   # keep the temp HOME
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
cargo build --quiet --example agents_fake
# Run a private copy: a shared target dir can be rebuilt by another checkout
# mid-run, and macOS kills a process whose binary is rewritten under it.
bin="$(mktemp -d)/agents_fake"
cp "$CARGO_TARGET_DIR/debug/examples/agents_fake" "$bin"
exec "$bin" "$@"
