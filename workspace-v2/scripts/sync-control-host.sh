#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET=""
HOST_ID=""
REMOTE_REPO_ROOT="${WSV2_REMOTE_REPO_ROOT:-$HOME/ai-workflow}"
VERIFY=true

usage() {
  cat <<EOF2
Usage: sync-control-host.sh --target <user@host> --host-id <id> [--remote-repo-root <path>] [--no-verify]

Syncs workspace-v2 to a remote host and installs the control-host wrapper there.
EOF2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --host-id)
      HOST_ID="$2"
      shift 2
      ;;
    --remote-repo-root)
      REMOTE_REPO_ROOT="$2"
      shift 2
      ;;
    --no-verify)
      VERIFY=false
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

if [[ -z "$TARGET" || -z "$HOST_ID" ]]; then
  echo "--target and --host-id are required" >&2
  exit 1
fi

rsync -a --exclude '__pycache__/' "$ROOT_DIR/" "$TARGET:$REMOTE_REPO_ROOT/workspace-v2/"
ssh "$TARGET" "$REMOTE_REPO_ROOT/workspace-v2/scripts/install-control-host.sh --host-id $HOST_ID --repo-root $REMOTE_REPO_ROOT --config-path $REMOTE_REPO_ROOT/workspace-v2/catalog/workspaces.v2.json"

if $VERIFY; then
  ssh "$TARGET" "bash -lc 'wsv2 list | sed -n \"1,10p\"'"
fi
