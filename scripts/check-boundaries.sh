#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
failed=0

while IFS= read -r line; do
  echo "renderer imported Electron main: $line"
  failed=1
done < <(rg -n "from ['\"](\\.\\./)+main/" client/src/renderer || true)

while IFS= read -r line; do
  echo "Electron main imported renderer: $line"
  failed=1
done < <(rg -n "from ['\"](\\.\\./)+renderer/" client/src/main || true)

if rg -n "nodeIntegration:\\s*true" client/src/main --glob '*.ts' >/dev/null; then
  echo "nodeIntegration true is forbidden in Electron main"
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  echo "boundary check failed"
  exit 1
fi

echo "boundary check passed"
