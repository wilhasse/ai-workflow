#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
unit_source="$project_dir/deploy/plane-codex-worker.service"
unit_target="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/plane-codex-worker.service"

python3 -m venv "$project_dir/.venv"
"$project_dir/.venv/bin/pip" install -e "$project_dir"
install -d -m 0700 "$(dirname -- "$unit_target")" \
  "$HOME/.local/state/plane-codex-worker"
if [[ -f "$HOME/.local/state/plane-codex-worker/jobs.sqlite3" ]]; then
  chmod 0600 "$HOME/.local/state/plane-codex-worker/jobs.sqlite3"
fi
PCW_PLANE_PROJECT_ID=688b0196-af21-49f0-83eb-7b849a9145a8 \
  "$project_dir/.venv/bin/plane-codex-worker" validate-config >/dev/null
install -m 0644 "$unit_source" "$unit_target"
systemctl --user daemon-reload
systemctl --user enable plane-codex-worker.service
systemctl --user restart plane-codex-worker.service
systemctl --user --no-pager --full status plane-codex-worker.service
