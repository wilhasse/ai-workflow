#!/usr/bin/env bash
set -euo pipefail

provider_env="${CODEX_CONTROL_PROVIDER_ENV_FILE:-${HOME}/.codex/provider-env}"
if [[ -r "${provider_env}" ]]; then
  # The provider file is private user configuration and is intentionally
  # sourced outside the repository so its exported credentials reach Codex.
  # shellcheck source=/dev/null
  source "${provider_env}"
elif [[ -e "${provider_env}" ]]; then
  printf 'Codex provider environment is not readable: %s\n' "${provider_env}" >&2
  exit 1
fi

ready_url="${CODEX_CONTROL_APP_SERVER_READY_URL:-}"
if [[ -n "${ready_url}" ]]; then
  startup_timeout="${CODEX_CONTROL_APP_SERVER_STARTUP_TIMEOUT_SECONDS:-180}"
  deadline=$((SECONDS + startup_timeout))
  until /usr/bin/curl --fail --silent --show-error "${ready_url}" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      printf 'Timed out waiting for Codex app-server readiness: %s\n' "${ready_url}" >&2
      exit 1
    fi
    sleep 1
  done
fi

exec /usr/bin/node "${HOME}/ai-workflow/codex-control-service/src/server.js"
