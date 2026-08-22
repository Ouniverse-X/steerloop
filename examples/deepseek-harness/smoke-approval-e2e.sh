#!/usr/bin/env bash
set -euo pipefail

STEERLOOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_ROOT="${HARNESS_ROOT:-/path/to/Harness/deepseek-harness}"
DSH_ENV="${DSH_ENV:-/path/to/Harness/dsh-env.sh}"
PORT="${STEERLOOP_RELAY_PORT:-18889}"
PROFILE="${STEERLOOP_DSH_SMOKE_PROFILE:-headless}"
HOST_PREFIX="${STEERLOOP_HOST_PREFIX:-harness-approval-e2e}"

echo "[approval-e2e] starting real Steerloop Relay + DeepSeek Harness approval validation"

if [[ ! -f "$DSH_ENV" ]]; then
  echo "Missing Harness environment file: $DSH_ENV" >&2
  exit 1
fi

if [[ ! -d "$HARNESS_ROOT" ]]; then
  echo "Missing Harness checkout: $HARNESS_ROOT" >&2
  exit 1
fi

work_dir="$(mktemp -d /tmp/steerloop-dsh-approval-e2e.XXXXXX)"
relay_log="$work_dir/relay.log"
events_path="$work_dir/events.jsonl"
devices_path="$work_dir/devices.json"
dsh_home="$work_dir/dsh-home"
relay_pid=""

cleanup() {
  local status="$?"
  if [[ -n "$relay_pid" ]] && kill -0 "$relay_pid" 2>/dev/null; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
  if [[ "$status" == "0" ]]; then
    rm -rf "$work_dir"
  else
    echo "[approval-e2e] failed; logs preserved at $work_dir" >&2
  fi
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
  export DSH_HOME="$dsh_home"
  node --import tsx/esm apps/cli/src/bin.ts plugin --profile "$PROFILE" add "$tarball"
)

run_case() {
  local case_name="$1"
  local decision="$2"
  local expected_file="$3"
  local marker="$4"
  local host_id="${HOST_PREFIX}-${case_name}"
  local pairing_code="SL-${case_name^^}-2026"
  local workspace="$work_dir/workspace-$case_name"
  local harness_log="$work_dir/harness-$case_name.log"
  local client_log="$work_dir/client-$case_name.log"
  mkdir -p "$workspace"

  echo "[approval-e2e] case=$case_name decision=$decision workspace=$workspace"
  local runner="$work_dir/run-dsh-${case_name}.mjs"
  cat >"$runner" <<EOF
process.chdir(${workspace@Q});
await import(${HARNESS_ROOT@Q} + '/apps/cli/src/bin.ts');
EOF
  (
    cd "$HARNESS_ROOT"
    source "$DSH_ENV"
    export DSH_HOME="$dsh_home"
    export DSH_PERMISSION_MODE="read-only"
    STEERLOOP_RELAY_URL="ws://127.0.0.1:${PORT}/ws" \
      STEERLOOP_HOST_ID="$host_id" \
      STEERLOOP_HOST_NAME="Harness Approval E2E ${case_name}" \
      STEERLOOP_PAIRING_CODE="$pairing_code" \
      timeout 240 node --import tsx/esm "$runner" \
        --profile "$PROFILE" \
        "Use bash exactly once to create ${expected_file} in the current workspace containing exactly ${marker}. If approval is rejected, stop after saying REJECTED. If approval is granted, verify the file exists, say ${marker}, and stop."
  ) >"$harness_log" 2>&1 &
  local harness_pid="$!"

  local client_status=0
  (
    cd "$STEERLOOP_ROOT"
    source "$DSH_ENV"
    STEERLOOP_RELAY_URL="ws://127.0.0.1:${PORT}/ws" \
      STEERLOOP_PAIRING_CODE="$pairing_code" \
      STEERLOOP_APPROVAL_DECISION="$decision" \
      timeout 210 node --import "$STEERLOOP_ROOT/node_modules/tsx/dist/esm/index.mjs" examples/deepseek-harness/approval-e2e-device-client.mjs
  ) >"$client_log" 2>&1 || client_status="$?"

  local harness_status=0
  wait "$harness_pid" || harness_status="$?"

  if [[ "$client_status" != "0" ]]; then
    echo "Approval client exited with $client_status. Log:" >&2
    cat "$client_log" >&2
    echo "Harness log:" >&2
    cat "$harness_log" >&2
    echo "Relay log:" >&2
    cat "$relay_log" >&2
    exit 1
  fi

  if ! grep -q "\[approval-e2e\] ${decision}" "$client_log"; then
    echo "Approval client did not send expected decision. Log:" >&2
    cat "$client_log" >&2
    echo "Harness log:" >&2
    cat "$harness_log" >&2
    exit 1
  fi

  if [[ "$decision" == "approve_once" ]]; then
    if [[ "$harness_status" != "0" ]]; then
      echo "Approve case Harness exited with $harness_status" >&2
      cat "$harness_log" >&2
      exit 1
    fi
    if [[ ! -f "$workspace/$expected_file" ]]; then
      echo "Approve case did not create expected file: $workspace/$expected_file" >&2
      cat "$harness_log" >&2
      exit 1
    fi
    if ! grep -q "$marker" "$workspace/$expected_file"; then
      echo "Approve case file did not contain marker" >&2
      cat "$workspace/$expected_file" >&2
      exit 1
    fi
  else
    if [[ -f "$workspace/$expected_file" ]]; then
      echo "Reject case unexpectedly created file: $workspace/$expected_file" >&2
      cat "$workspace/$expected_file" >&2
      exit 1
    fi
  fi

  if ! grep -q '"approval.resolved"' "$events_path"; then
    echo "Relay journal did not contain approval.resolved events" >&2
    cat "$events_path" >&2
    exit 1
  fi
  echo "[approval-e2e] case=$case_name passed harness_status=$harness_status"
}

run_case "approve" "approve_once" "approval-approved.txt" "APPROVED_BY_STEERLOOP"
run_case "reject" "decline" "approval-rejected.txt" "REJECTED_BY_STEERLOOP"

if ! grep -q '"decision":"approve_once"' "$events_path"; then
  echo "Relay journal missing approve_once resolution" >&2
  cat "$events_path" >&2
  exit 1
fi
if ! grep -q '"decision":"decline"' "$events_path"; then
  echo "Relay journal missing decline resolution" >&2
  cat "$events_path" >&2
  exit 1
fi

echo "DeepSeek Harness Steerloop approval e2e passed: approve created the file, decline left the workspace unchanged, and both decisions used paired-device signatures."
