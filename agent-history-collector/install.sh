#!/bin/bash
# Install agent-history-collector as a systemd service
# Usage: sudo VM_ID=my-vm API_URL=http://10.1.0.7:5002 ./install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/agent-history-collector.service"

if [ ! -f "$SERVICE_FILE" ]; then
  echo "Error: $SERVICE_FILE not found"
  exit 1
fi

# Create a copy with substituted values
cp "$SERVICE_FILE" /etc/systemd/system/agent-history-collector.service

if [ -n "$VM_ID" ]; then
  sed -i "s/Environment=VM_ID=dev-vm/Environment=VM_ID=$VM_ID/" /etc/systemd/system/agent-history-collector.service
fi

if [ -n "$API_URL" ]; then
  sed -i "s|Environment=API_URL=http://10.1.0.7:5002|Environment=API_URL=$API_URL|" /etc/systemd/system/agent-history-collector.service
fi

systemctl daemon-reload
systemctl enable --now agent-history-collector

echo "Agent history collector installed and started"
echo "Check status: systemctl status agent-history-collector"
echo "View logs: journalctl -u agent-history-collector -f"
