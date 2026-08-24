#!/usr/bin/env bash
set -euo pipefail

host=10.1.0.7
reference_host=10.1.0.9

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) host=${2:?missing host}; shift 2 ;;
    --reference-host) reference_host=${2:?missing reference host}; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$host" =~ ^[A-Za-z0-9._-]+$ || ! "$reference_host" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid host" >&2
  exit 2
fi
set +e
ssh -o BatchMode=yes -o ConnectTimeout=5 -o HostKeyAlgorithms=ssh-ed25519 \
  "$reference_host" \
  'if ps -eo args= | grep -Eq "[h]ermes_cli\.main.*gateway run|[h]ermes gateway run"; then exit 42; fi'
reference_status=$?
set -e
case "$reference_status" in
  0) ;;
  42)
    echo "reference Hermes gateway is still running on $reference_host" >&2
    exit 1
    ;;
  *)
    echo "could not verify reference Hermes gateway on $reference_host" >&2
    exit 1
    ;;
esac

remote_root=/home/cslog/.local/share/slack-plane-intake/current
ssh "$host" "'$remote_root/venv/bin/python' '$remote_root/scripts/activate-target.py'"
ssh "$host" 'set -a; . "$HOME/.hermes/.env"; set +a; "$HOME/.local/share/slack-plane-intake/current/venv/bin/python" -m slack_plane_intake.mcp_server --validate-config >/dev/null; "$HOME/hermes-agent/.venv/bin/python" -m hermes_cli.main mcp test slack-plane-intake'
ssh "$host" 'set -euo pipefail; release="$HOME/.local/share/slack-plane-intake/current"; unit_dir="$HOME/.config/systemd/user"; dropin_dir="$unit_dir/hermes-gateway.service.d"; skill_dir="$HOME/.hermes/skills/problem-intake"; install -d -m 0700 "$dropin_dir" "$skill_dir"; if [[ ! -f "$unit_dir/hermes-gateway.service" ]]; then install -m 0644 "$release/deploy/hermes-gateway.service" "$unit_dir/hermes-gateway.service"; fi; install -m 0644 "$release/deploy/hermes-gateway-hardening.conf" "$dropin_dir/10-cslog-179-hardening.conf"; install -m 0644 "$release/deploy/problem-intake/SKILL.md" "$skill_dir/SKILL.md"; systemctl --user daemon-reload; systemctl --user enable hermes-gateway.service >/dev/null; systemctl --user restart hermes-gateway.service; for attempt in 1 2 3 4 5; do systemctl --user is-active --quiet hermes-gateway.service && break; sleep 1; done; systemctl --user is-active hermes-gateway.service'
