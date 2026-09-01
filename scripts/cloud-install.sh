#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.local/bin:${PATH}"

if [ -f backend/package-lock.json ]; then
  npm --prefix backend ci
else
  npm --prefix backend install
fi

if [ -f client/package-lock.json ]; then
  npm --prefix client ci --ignore-scripts
else
  npm --prefix client install --ignore-scripts
fi

python3 -m pip install --user -r image-service/requirements.txt

npm --prefix .cursor/skills/verify-clicksmith install
npx --prefix .cursor/skills/verify-clicksmith playwright install chromium
