#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/workspace-v2"
ENV_FILE="$CONFIG_DIR/control-host.env"
BIN_DIR="$HOME/.local/bin"
WRAPPER_PATH="$BIN_DIR/wsv2"
HOST_ID=""
REPO_ROOT="${WSV2_REPO_ROOT:-$(cd "$ROOT_DIR/.." && pwd)}"
CONFIG_PATH_DEFAULT="$ROOT_DIR/catalog/workspaces.v2.json"

usage() {
  cat <<EOF
Usage: install-control-host.sh --host-id <id> [--repo-root <path>] [--config-path <path>]

Installs a lightweight control-host wrapper for workspace-v2 on the current machine.

Options:
  --host-id <id>       Explicit self host id, for example vm9 or vm10
  --repo-root <path>   Repo root containing workspace-v2 (default: parent of workspace-v2)
  --config-path <path> Explicit catalog path (default: workspace-v2/catalog/workspaces.v2.json)
EOF
}

CONFIG_PATH="$CONFIG_PATH_DEFAULT"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host-id)
      HOST_ID="$2"
      shift 2
      ;;
    --repo-root)
      REPO_ROOT="$2"
      shift 2
      ;;
    --config-path)
      CONFIG_PATH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$HOST_ID" ]]; then
  echo "--host-id is required" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$BIN_DIR"
cat > "$ENV_FILE" <<EOF
export WSV2_SELF_HOST=$HOST_ID
export WSV2_CONFIG_PATH=$CONFIG_PATH
export WSV2_REPO_ROOT=$REPO_ROOT
EOF

cat > "$WRAPPER_PATH" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/workspace-v2/control-host.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi
REPO_ROOT="${WSV2_REPO_ROOT:-$HOME/ai-workflow}"
exec "$REPO_ROOT/workspace-v2/scripts/wsv2" "$@"
EOF
chmod +x "$WRAPPER_PATH"

echo "Installed control-host wrapper: $WRAPPER_PATH"
echo "Environment file: $ENV_FILE"
echo "Configured self host: $HOST_ID"
echo "Next checks:"
echo "  wsv2 list"
echo "  wsv2 popup"
