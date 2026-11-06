#!/bin/bash
# Opt-in adversarial suite for Agents: real Claude Code turns on Haiku that try
# to make agents timid, lazy or leaky (costs a little money, needs `claude`
# signed in). Throwaway HOMEs, a stand-in for the user's Chrome, no claude.ai
# connectors, every turn capped. See src-tauri/examples/agents_e2e/adversarial.rs.
#   scripts/agents-adversarial.sh
#   AGENTS_ADV_ONLY=slack-browser,go-hard-send scripts/agents-adversarial.sh
#   AGENTS_ADV_RUNS=3 AGENTS_ADV_OUT=adv.json scripts/agents-adversarial.sh
set -euo pipefail
exec "$(dirname "$0")/agents-e2e.sh" adversarial
