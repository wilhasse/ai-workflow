#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DESKTOP="$ROOT_DIR/integrations/plasma/workspace-v2-popup.desktop"
TARGET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
TARGET_DESKTOP="$TARGET_DIR/workspace-v2-popup.desktop"

mkdir -p "$TARGET_DIR"
install -m 0644 "$SOURCE_DESKTOP" "$TARGET_DESKTOP"

if command -v kbuildsycoca6 >/dev/null 2>&1; then
  kbuildsycoca6 >/dev/null 2>&1 || true
elif command -v kbuildsycoca5 >/dev/null 2>&1; then
  kbuildsycoca5 >/dev/null 2>&1 || true
fi

echo "Installed: $TARGET_DESKTOP"
echo "Search for 'Workspace Launcher' in KRunner or Kickoff."
echo "Suggested next step: assign a global shortcut to /home/cslog/ai-workflow/workspace-v2/scripts/wsv2 popup"
