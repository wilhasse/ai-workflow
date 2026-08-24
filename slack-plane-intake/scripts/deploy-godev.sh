#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
host=10.1.0.7
validate_only=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) host=${2:?missing host}; shift 2 ;;
    --validate-only) validate_only=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$host" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid host" >&2
  exit 2
fi

archive=$("$script_dir/build-release.sh")
ssh "$host" 'command -v python3 >/dev/null && command -v tar >/dev/null && test "$(id -un)" = cslog'

if [[ "$validate_only" == true ]]; then
  ssh "$host" 'test ! -e "$HOME/.local/share/slack-plane-intake/current" || test -x "$HOME/.local/share/slack-plane-intake/current/venv/bin/python"'
  echo "deployment prerequisites validated"
  exit 0
fi

release_id=$(date -u +%Y-%m-%dT%H-%M-%SZ)
incoming_dir="/home/cslog/.local/share/slack-plane-intake/incoming"
remote_archive="$incoming_dir/slack-plane-intake-$release_id.tar.gz"
ssh "$host" "install -d -m 0700 '$incoming_dir'"
scp -q -- "$archive" "$host:$remote_archive"
scp -q -- "$script_dir/install-release-target.sh" "$host:$incoming_dir/install-release-target.sh"
ssh "$host" "bash '$incoming_dir/install-release-target.sh' '$remote_archive' '$release_id'"
