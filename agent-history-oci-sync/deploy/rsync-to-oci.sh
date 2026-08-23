#!/usr/bin/env bash
# Unidirectional raw archive mirror: godev4 (source of truth) -> oci-ubuntu-pub.
# Keeps plain JSONL files (browsable with rg/zgrep) under ~/agent-history-raw.
set -euo pipefail

DEST_HOST="oci-ubuntu-pub"
DEST_BASE="agent-history-raw"

ssh "$DEST_HOST" "mkdir -p ~/$DEST_BASE/.codex ~/$DEST_BASE/.claude"

rsync -az --timeout=300 \
  "$HOME/.codex/sessions" "$HOME/.codex/memories" \
  "$DEST_HOST:$DEST_BASE/.codex/"

rsync -az --timeout=300 \
  "$HOME/.codex/history.jsonl" \
  "$DEST_HOST:$DEST_BASE/.codex/history.jsonl"

rsync -az --timeout=300 \
  "$HOME/.claude/projects" "$HOME/.claude/history.jsonl" \
  "$DEST_HOST:$DEST_BASE/.claude/"

echo "[rsync-to-oci] done $(date -Is)"
