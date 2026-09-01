#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.local/bin:${PATH}"

export CLICKSMITH_VERIFY_DIR="${CLICKSMITH_VERIFY_DIR:-/tmp/clicksmith-verify/cloud}"
export CLICKSMITH_BACKEND_PORT="${CLICKSMITH_BACKEND_PORT:-3000}"
export CLICKSMITH_IMAGE_PORT="${CLICKSMITH_IMAGE_PORT:-5001}"
export CLICKSMITH_RENDERER_PORT="${CLICKSMITH_RENDERER_PORT:-5173}"

if [ -f "$CLICKSMITH_VERIFY_DIR/state.json" ]; then
  node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs cleanup || true
fi

mkdir -p "$CLICKSMITH_VERIFY_DIR"
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs launch --lane all
node .cursor/skills/verify-clicksmith/scripts/control-clicksmith.mjs doctor
