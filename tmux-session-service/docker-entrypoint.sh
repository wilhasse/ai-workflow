#!/bin/bash
set -e

# Fix tmux socket directory permissions if it exists
# tmux requires the socket directory to be owned by the running user with mode 700
TMUX_SOCKET_DIR="/tmp/tmux-1000"
if [ -d "$TMUX_SOCKET_DIR" ]; then
  # Use sudo to fix permissions (cslog has passwordless sudo)
  sudo chown cslog:cslog "$TMUX_SOCKET_DIR"
  sudo chmod 700 "$TMUX_SOCKET_DIR"
fi

PULUMI_WORK_DIR="${PULUMI_WORK_DIR:-/home/cslog/ai-workflow/infra/proxmox-test-vm}"
if [ -f "$PULUMI_WORK_DIR/package.json" ] && [ ! -d "$PULUMI_WORK_DIR/node_modules" ]; then
  (cd "$PULUMI_WORK_DIR" && npm install)
fi

# Execute the main command
exec "$@"
