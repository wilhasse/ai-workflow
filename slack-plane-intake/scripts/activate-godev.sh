#!/usr/bin/env bash
set -euo pipefail

host=10.1.0.7
reference_host=10.1.0.9
channel_id=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) host=${2:?missing host}; shift 2 ;;
    --reference-host) reference_host=${2:?missing reference host}; shift 2 ;;
    --channel-id) channel_id=${2:?missing channel id}; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$host" =~ ^[A-Za-z0-9._-]+$ || ! "$reference_host" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid host" >&2
  exit 2
fi
if [[ ! "$channel_id" =~ ^C[A-Z0-9]+$ ]]; then
  echo "--channel-id must be a public Slack channel ID" >&2
  exit 2
fi

if ssh "$reference_host" 'ps -eo args= | grep -Eq "[h]ermes_cli\.main.*gateway run|[h]ermes gateway run"'; then
  echo "reference Hermes gateway is still running on $reference_host" >&2
  exit 1
fi

remote_root=/home/cslog/.local/share/slack-plane-intake/current
ssh "$host" "'$remote_root/venv/bin/python' '$remote_root/scripts/activate-target.py' '$channel_id'"
ssh "$host" 'set -a; . "$HOME/.hermes/.env"; set +a; "$HOME/.local/share/slack-plane-intake/current/venv/bin/python" -m slack_plane_intake.mcp_server --validate-config >/dev/null; "$HOME/hermes-agent/.venv/bin/python" -m hermes_cli.main mcp test slack-plane-intake'
ssh "$host" 'systemctl --user enable hermes-gateway.service >/dev/null; systemctl --user restart hermes-gateway.service; for attempt in 1 2 3 4 5; do systemctl --user is-active --quiet hermes-gateway.service && break; sleep 1; done; systemctl --user is-active hermes-gateway.service'
