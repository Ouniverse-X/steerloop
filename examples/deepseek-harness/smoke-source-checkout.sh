#!/usr/bin/env bash
set -euo pipefail

STEERLOOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_ROOT="${HARNESS_ROOT:-/path/to/Harness/deepseek-harness}"
DSH_ENV="${DSH_ENV:-/path/to/Harness/dsh-env.sh}"
PORT="${STEERLOOP_RELAY_PORT:-18887}"
PAIRING_CODE="${STEERLOOP_PAIRING_CODE:-PAIR-SMOKE}"
HOST_ID="${STEERLOOP_HOST_ID:-harness-smoke-dsh}"

if [[ ! -f "$DSH_ENV" ]]; then
  echo "Missing Harness environment file: $DSH_ENV" >&2
  exit 1
fi

if [[ ! -d "$HARNESS_ROOT" ]]; then
  echo "Missing Harness checkout: $HARNESS_ROOT" >&2
  exit 1
fi

relay_log="$(mktemp)"
events_path="/tmp/steerloop-dsh-smoke-events-${PORT}.jsonl"
devices_path="/tmp/steerloop-dsh-smoke-devices-${PORT}.json"
relay_pid=""

cleanup() {
  if [[ -n "$relay_pid" ]] && kill -0 "$relay_pid" 2>/dev/null; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

(
  cd "$STEERLOOP_ROOT"
  STEERLOOP_RELAY_PORT="$PORT" \
    STEERLOOP_JOURNAL_PATH="$events_path" \
    STEERLOOP_DEVICE_REGISTRY_PATH="$devices_path" \
    npm run dev:relay
) >"$relay_log" 2>&1 &
relay_pid="$!"

for _ in $(seq 1 80); do
  if grep -q "listening on ws://127.0.0.1:${PORT}/ws" "$relay_log"; then
    break
  fi
  sleep 0.1
done

if ! grep -q "listening on ws://127.0.0.1:${PORT}/ws" "$relay_log"; then
  echo "Relay did not start. Log:" >&2
  cat "$relay_log" >&2
  exit 1
fi

(
  cd "$HARNESS_ROOT"
  source "$DSH_ENV"
  STEERLOOP_RELAY_URL="ws://127.0.0.1:${PORT}/ws" \
    STEERLOOP_HOST_ID="$HOST_ID" \
    STEERLOOP_HOST_NAME="Harness Example Smoke DSH" \
    STEERLOOP_DSH_PLUGIN_ENTRY="$STEERLOOP_ROOT/packages/dsh-plugin/src/index.js" \
    STEERLOOP_PAIRING_CODE="$PAIRING_CODE" \
    timeout 15 node --import tsx/esm apps/cli/src/bin.ts \
      --profile headless \
      --patch "$STEERLOOP_ROOT/examples/deepseek-harness/source-checkout.cordis.yml" \
      "Steerloop source overlay smoke: say hello and stop."
)

if ! grep -q "registered pairing code for host ${HOST_ID}" "$relay_log"; then
  echo "Relay did not receive the Harness pairing offer. Log:" >&2
  cat "$relay_log" >&2
  exit 1
fi

echo "DeepSeek Harness Steerloop smoke passed: pairing code ${PAIRING_CODE} registered for ${HOST_ID}."
