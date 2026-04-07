#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PYTHONPATH="$ROOT_DIR/src${PYTHONPATH:+:$PYTHONPATH}"
CONFIG_PATH="${WSV2_CONFIG_PATH:-$ROOT_DIR/catalog/workspaces.v2.json}"
CONTROL_HOST=""
DOWN_HOSTS=()
TARGETS=()
KEEP_TEMP=false

usage() {
  cat <<EOF2
Usage: run-outage-drill.sh --control-host <id> --down-host <id> [--down-host <id> ...] [--target <host:id>] [--keep-temp]

Simulates one or more down hosts by rewriting their SSH targets in a temp config,
then probes healthy hosts with short-lived tmux sessions.
EOF2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --control-host)
      CONTROL_HOST="$2"
      shift 2
      ;;
    --down-host)
      DOWN_HOSTS+=("$2")
      shift 2
      ;;
    --target)
      TARGETS+=("$2")
      shift 2
      ;;
    --keep-temp)
      KEEP_TEMP=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$CONTROL_HOST" || ${#DOWN_HOSTS[@]} -eq 0 ]]; then
  echo "--control-host and at least one --down-host are required" >&2
  exit 1
fi

python3 - "$CONFIG_PATH" "$CONTROL_HOST" "$KEEP_TEMP" "${DOWN_HOSTS[@]}" -- "${TARGETS[@]}" <<'PY'
from pathlib import Path
import sys
from wsv2.drill import run_outage_drill

config_path = sys.argv[1]
control_host = sys.argv[2]
keep_temp = sys.argv[3].lower() == 'true'
args = sys.argv[4:]
separator = args.index('--') if '--' in args else len(args)
down_hosts = args[:separator]
targets = args[separator + 1:] if separator < len(args) else []

config, results, simulated_path = run_outage_drill(
    config_path=config_path,
    control_host_id=control_host,
    down_host_ids=down_hosts,
    explicit_targets=targets or None,
)

print(f'Control host: {control_host}')
print(f'Simulated down hosts: {", ".join(down_hosts)}')
print(f'Catalog used: {config.path}')
print(f'Temporary simulated config: {simulated_path}')
print('')
print('Status snapshot:')
for workspace in config.workspaces:
    marker = 'DOWN' if workspace.host_id in down_hosts else 'OK'
    print(f'  {marker:<4} {workspace.target}')
print('')
print('Probe results:')
failed = False
for result in results:
    state = 'PASS' if result.success else 'FAIL'
    print(f'  {state:<4} {result.target:<20} host={result.host_id:<5} detail={result.detail}')
    failed = failed or not result.success
if not keep_temp:
    Path(simulated_path).unlink(missing_ok=True)
if failed:
    raise SystemExit(1)
PY
