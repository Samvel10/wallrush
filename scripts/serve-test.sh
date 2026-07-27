#!/usr/bin/env bash
# Start (or restart) a production-shaped instance for manual and browser testing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8791}"
DATA="${WALLRUSH_DATA:-/tmp/claude-1000/-var-www-html-wallrush/wrdata}"
LOG="${LOG:-/tmp/claude-1000/-var-www-html-wallrush/server.log}"

# Free the port without matching this script's own command line.
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
else
  pid="$(ss -lptn "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
fi
sleep 0.4

cd "$ROOT"
WALLRUSH_DATA="$DATA" \
PORT="$PORT" \
WALLRUSH_STATIC="$ROOT/packages/client/dist" \
  nohup node packages/server/dist/index.js > "$LOG" 2>&1 &

sleep 1.2
printf 'health: '
curl -s "http://127.0.0.1:${PORT}/api/health" || echo FAILED
printf '\nindex:  '
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${PORT}/"
