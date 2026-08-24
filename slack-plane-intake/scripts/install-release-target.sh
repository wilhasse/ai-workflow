#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: install-release-target.sh ARCHIVE RELEASE_ID" >&2
  exit 2
fi

archive=$1
release_id=$2
install_root="$HOME/.local/share/slack-plane-intake"
releases_dir="$install_root/releases"
release_dir="$releases_dir/$release_id"
staging_dir="$releases_dir/.staging-$release_id"

case "$archive" in
  "$install_root"/incoming/*.tar.gz) ;;
  *) echo "archive must be under $install_root/incoming" >&2; exit 2 ;;
esac

if [[ ! -f "$archive" || ! "$release_id" =~ ^[0-9TZ-]+$ ]]; then
  echo "invalid archive or release id" >&2
  exit 2
fi
if [[ -e "$release_dir" || -e "$staging_dir" ]]; then
  echo "release already exists: $release_id" >&2
  exit 1
fi

mkdir -p -- "$releases_dir" "$HOME/.local/state/slack-plane-intake"
mkdir -- "$staging_dir"
tar -xzf "$archive" -C "$staging_dir"
mv -- "$staging_dir" "$release_dir"
python3 -m venv "$release_dir/venv"
"$release_dir/venv/bin/pip" install "${release_dir}[dev]"
"$release_dir/venv/bin/ruff" format --check "$release_dir"
"$release_dir/venv/bin/ruff" check "$release_dir"
"$release_dir/venv/bin/pytest" -q "$release_dir/tests"
ln -s -- "$release_dir" "$install_root/.current-$release_id"
mv -Tf -- "$install_root/.current-$release_id" "$install_root/current"
printf 'installed release %s\n' "$release_id"
