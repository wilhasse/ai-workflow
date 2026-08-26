#!/usr/bin/env bash
set -euo pipefail

provider_env="${CODEX_APP_SERVER_PROVIDER_ENV_FILE:-${HOME}/.codex/provider-env}"
if [[ -r "${provider_env}" ]]; then
  # shellcheck source=/dev/null
  source "${provider_env}"
elif [[ -e "${provider_env}" ]]; then
  printf 'Codex provider environment is not readable: %s\n' "${provider_env}" >&2
  exit 1
fi

codex_bin="${CODEX_APP_SERVER_BIN:-${HOME}/.local/bin/codex}"
listen_url="${CODEX_APP_SERVER_LISTEN:-ws://192.168.160.1:4500}"
token_file="${CODEX_APP_SERVER_TOKEN_FILE:-${HOME}/ai-workflow/runtime/codex-remote/app-server-token}"

if [[ ! -x "${codex_bin}" ]]; then
  printf 'Codex executable is not available: %s\n' "${codex_bin}" >&2
  exit 1
fi
if [[ ! -r "${token_file}" ]]; then
  printf 'Codex app-server token file is not readable: %s\n' "${token_file}" >&2
  exit 1
fi

exec "${codex_bin}" app-server \
  --listen "${listen_url}" \
  --ws-auth capability-token \
  --ws-token-file "${token_file}"
