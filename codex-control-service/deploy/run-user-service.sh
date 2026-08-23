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

exec /usr/bin/node "${HOME}/ai-workflow/codex-control-service/src/server.js"
