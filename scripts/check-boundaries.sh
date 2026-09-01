#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
failed=0

scan() {
  grep -rnE --include='*.ts' --include='*.tsx' "$1" "$2" || true
}

while IFS= read -r line; do
  [ -n "$line" ] || continue
  echo "renderer imported Electron main: $line"
  failed=1
done < <(scan "from ['\"]((\.\./)+|@/)main/" client/src/renderer)

while IFS= read -r line; do
  [ -n "$line" ] || continue
  echo "Electron main imported renderer: $line"
  failed=1
done < <(scan "from ['\"]((\.\./)+|@/)renderer/" client/src/main)

while IFS= read -r line; do
  [ -n "$line" ] || continue
  echo "nodeIntegration true is forbidden in Electron main: $line"
  failed=1
done < <(scan "nodeIntegration:[[:space:]]*true" client/src/main)

if [ "$failed" -ne 0 ]; then
  echo "boundary check failed"
  exit 1
fi

echo "boundary check passed"
