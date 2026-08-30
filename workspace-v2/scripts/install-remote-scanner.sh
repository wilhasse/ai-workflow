#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_ROOT=".local/lib/ai-workflow/workspace-v2"

if [[ $# -ne 1 || "$1" == -* ]]; then
  printf 'Usage: %s user@host\n' "$0" >&2
  exit 2
fi

TARGET="$1"
ssh -o BatchMode=yes -- "$TARGET" "mkdir -p '$REMOTE_ROOT'"
rsync -az --delete --exclude __pycache__ --exclude '*.pyc' "$ROOT_DIR/" "$TARGET:$REMOTE_ROOT/"
