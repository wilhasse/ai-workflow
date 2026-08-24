#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
host=10.1.0.7
commit=d861fbe55073dbd9e295eaf2c1fd16c8af54f7da

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) host=${2:?missing host}; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$host" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid host" >&2
  exit 2
fi

short_commit=${commit:0:12}
install_root=/home/cslog/.local/share/hermes-agent
release_dir="$install_root/releases/$short_commit"
incoming_dir="$install_root/incoming"
remote_patch="$incoming_dir/hermes-slack-trigger-message-id.patch"

ssh "$host" 'command -v git >/dev/null && command -v python3 >/dev/null && test "$(id -un)" = cslog'
ssh "$host" "install -d -m 0700 '$incoming_dir' '$install_root/releases'"
scp -q -- "$script_dir/../patches/hermes-slack-trigger-message-id.patch" "$host:$remote_patch"

ssh "$host" bash -s -- "$commit" "$release_dir" "$remote_patch" <<'REMOTE'
set -euo pipefail
commit=$1
release_dir=$2
patch_file=$3

if [[ ! -d "$release_dir/.git" ]]; then
  if [[ -e "$release_dir" ]]; then
    echo "Hermes release path exists but is not a git checkout" >&2
    exit 1
  fi
  git clone --filter=blob:none --no-checkout https://github.com/NousResearch/hermes-agent.git "$release_dir"
  git -C "$release_dir" fetch --depth=1 origin "$commit"
  git -C "$release_dir" checkout --detach "$commit"
fi

actual=$(git -C "$release_dir" rev-parse HEAD)
if [[ "$actual" != "$commit" ]]; then
  echo "Hermes release commit mismatch" >&2
  exit 1
fi
if git -C "$release_dir" apply --check "$patch_file" 2>/dev/null; then
  git -C "$release_dir" apply "$patch_file"
elif ! git -C "$release_dir" apply --reverse --check "$patch_file" 2>/dev/null; then
  echo "Hermes timestamp patch is neither applicable nor already applied" >&2
  exit 1
fi

if [[ ! -x "$release_dir/.venv/bin/python" ]]; then
  python3 -m venv "$release_dir/.venv"
fi
"$release_dir/.venv/bin/pip" install -e "$release_dir[slack,mcp]"
"$release_dir/.venv/bin/python" -m py_compile "$release_dir/gateway/run.py"

link_tmp=/home/cslog/.hermes-agent-link
ln -sfn -- "$release_dir" "$link_tmp"
mv -Tf -- "$link_tmp" /home/cslog/hermes-agent
mkdir -p -- /home/cslog/.local/bin
cli_link_tmp=/home/cslog/.local/bin/.hermes-link
ln -sfn -- "$release_dir/.venv/bin/hermes" "$cli_link_tmp"
mv -Tf -- "$cli_link_tmp" /home/cslog/.local/bin/hermes
printf 'installed Hermes %s\n' "$commit"
REMOTE
