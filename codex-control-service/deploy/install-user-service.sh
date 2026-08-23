#!/usr/bin/env bash
set -euo pipefail

service_source="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex-control-service.service"
service_target="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/codex-control-service.service"
runtime_dir="${HOME}/ai-workflow/runtime/codex-control"

mkdir -p "$(dirname "${service_target}")" "${runtime_dir}"
install -m 0644 "${service_source}" "${service_target}"
systemctl --user daemon-reload
systemctl --user enable --now codex-control-service.service
systemctl --user --no-pager --full status codex-control-service.service
