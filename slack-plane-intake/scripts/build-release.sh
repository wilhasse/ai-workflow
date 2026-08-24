#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
package_dir=$(cd -- "$script_dir/.." && pwd)
venv_dir="$package_dir/.venv"
dist_dir="$package_dir/dist"
archive="$dist_dir/slack-plane-intake.tar.gz"

if [[ ! -x "$venv_dir/bin/python" ]]; then
  python3 -m venv "$venv_dir"
  "$venv_dir/bin/pip" install -e "${package_dir}[dev]"
fi

"$venv_dir/bin/ruff" format --check "$package_dir" >&2
"$venv_dir/bin/ruff" check "$package_dir" >&2
"$venv_dir/bin/pytest" -q "$package_dir/tests" >&2

mkdir -p -- "$dist_dir"
rm -f -- "$archive"
tar -C "$package_dir" -czf "$archive" \
  --exclude='./.env' \
  --exclude='./.venv' \
  --exclude='./dist' \
  --exclude='./.pytest_cache' \
  --exclude='./.ruff_cache' \
  --exclude='*/__pycache__' \
  --exclude='*.egg-info' \
  --exclude='*.sqlite3' \
  --exclude='*.db' \
  .

if tar -tzf "$archive" | grep -E '(^|/)(\.env|[^/]*\.sqlite3|[^/]*\.db)$' >/dev/null; then
  echo "release validation failed: runtime state or secret file found" >&2
  exit 1
fi

printf '%s\n' "$archive"
