#!/usr/bin/env bash
set -euo pipefail

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
service_source="${deploy_dir}/codex-control-service.service"
service_target="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/codex-control-service.service"
app_server_source="${deploy_dir}/codex-app-server.service"
app_server_target="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/codex-app-server.service"
remote_proxy_source="${deploy_dir}/codex-remote-tui-proxy.service"
remote_proxy_target="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/codex-remote-tui-proxy.service"
runtime_dir="${HOME}/ai-workflow/runtime/codex-control"

mkdir -p "$(dirname "${service_target}")" "${runtime_dir}"
npm install --omit=dev --no-package-lock --prefix "${HOME}/ai-workflow/codex-control-service"
"${deploy_dir}/provision-remote-secrets.sh"
install -m 0644 "${app_server_source}" "${app_server_target}"
install -m 0644 "${remote_proxy_source}" "${remote_proxy_target}"
install -m 0644 "${service_source}" "${service_target}"
systemctl --user daemon-reload
systemctl --user enable --now codex-app-server.service
systemctl --user enable --now codex-remote-tui-proxy.service
systemctl --user enable codex-control-service.service
systemctl --user restart codex-control-service.service
systemctl --user --no-pager --full status codex-app-server.service
systemctl --user --no-pager --full status codex-remote-tui-proxy.service
systemctl --user --no-pager --full status codex-control-service.service
