#!/usr/bin/env bash
set -euo pipefail

STEERLOOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_ROOT="${HARNESS_ROOT:-/home/beihang/projects/Harness/deepseek-harness}"
DSH_ENV="${DSH_ENV:-/home/beihang/projects/Harness/dsh-env.sh}"
PORT="${STEERLOOP_RELAY_PORT:-18888}"
PAIRING_CODE="${STEERLOOP_PAIRING_CODE:-DSH-TGZ-2026}"
HOST_ID="${STEERLOOP_HOST_ID:-harness-tarball-smoke-dsh}"
PROFILE="${STEERLOOP_DSH_SMOKE_PROFILE:-headless}"

if [[ ! -f "$DSH_ENV" ]]; then
  echo "Missing Harness environment file: $DSH_ENV" >&2
  exit 1
fi

if [[ ! -d "$HARNESS_ROOT" ]]; then
  echo "Missing Harness checkout: $HARNESS_ROOT" >&2
  exit 1
fi

work_dir="$(mktemp -d /tmp/steerloop-dsh-tarball-smoke.XXXXXX)"
relay_log="$work_dir/relay.log"
events_path="$work_dir/events.jsonl"
devices_path="$work_dir/devices.json"
relay_pid=""

cleanup() {
  if [[ -n "$relay_pid" ]] && kill -0 "$relay_pid" 2>/dev/null; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

pack_output="$(
  cd "$STEERLOOP_ROOT"
  npm pack -w @steerloop/dsh-plugin --pack-destination "$work_dir" 2>/dev/null
)"
tarball_name="$(printf '%s\n' "$pack_output" | tail -n 1)"
tarball="$work_dir/$tarball_name"
if [[ ! -f "$tarball" ]]; then
  echo "Expected packed tarball was not created: $tarball" >&2
  printf '%s\n' "$pack_output" >&2
  exit 1
fi

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
  export DSH_HOME="$work_dir/dsh-home"
  node --import tsx/esm apps/cli/src/bin.ts plugin --profile "$PROFILE" add "$tarball"

  profile_manifest="$DSH_HOME/profiles/$PROFILE/package.json"
  node -e "const fs=require('fs'); const p=process.argv[1]; const manifest=JSON.parse(fs.readFileSync(p,'utf8')); if (!manifest.dependencies?.['@steerloop/dsh-plugin']) throw new Error('missing @steerloop/dsh-plugin dependency'); if (!manifest.dsh?.profile?.bundles?.includes('@steerloop/dsh-plugin')) throw new Error('missing @steerloop/dsh-plugin bundle activation');" "$profile_manifest"

  node --import tsx/esm apps/cli/src/bin.ts --profile "$PROFILE" --dump-config | grep -q "@steerloop/dsh-plugin"

  STEERLOOP_RELAY_URL="ws://127.0.0.1:${PORT}/ws" \
    STEERLOOP_HOST_ID="$HOST_ID" \
    STEERLOOP_HOST_NAME="Harness Tarball Smoke DSH" \
    STEERLOOP_PAIRING_CODE="$PAIRING_CODE" \
    timeout 15 node --import tsx/esm apps/cli/src/bin.ts \
      --profile "$PROFILE" \
      "Steerloop tarball install smoke: say hello and stop."
)

if ! grep -q "registered pairing code for host ${HOST_ID}" "$relay_log"; then
  echo "Relay did not receive the Harness pairing offer. Log:" >&2
  cat "$relay_log" >&2
  exit 1
fi

echo "DeepSeek Harness Steerloop tarball smoke passed: $tarball installed into isolated DSH_HOME and pairing code ${PAIRING_CODE} registered for ${HOST_ID}."
