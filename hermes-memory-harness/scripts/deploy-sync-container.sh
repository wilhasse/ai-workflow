#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

CONTAINER_NAME="${HMH_CONTAINER_NAME:-hermes-memory-harness-sync}"
IMAGE_NAME="${HMH_IMAGE_NAME:-hermes-memory-harness-hermes-memory-harness}"
HERMES_HOME_DIR="${HMH_HERMES_HOME_HOST:-$HOME/.hermes}"
DORIS_HOST="${HMH_DORIS_HOST:-10.1.0.7}"
DORIS_PORT="${HMH_DORIS_PORT:-9030}"
DORIS_USER="${HMH_DORIS_USER:-root}"
DORIS_PASSWORD="${HMH_DORIS_PASSWORD:-}"
DORIS_DATABASE="${HMH_DORIS_DATABASE:-agent_history}"
DEFAULT_SOURCES="${HMH_DEFAULT_SOURCES:-codex,claude}"
POLL_INTERVAL_SECONDS="${HMH_POLL_INTERVAL_SECONDS:-60}"

usage() {
  cat <<USAGE
Usage: $(basename "$0") <command>

Commands:
  deploy    Build image and (re)create the sync container
  start     Start an existing container
  stop      Stop the running container
  restart   Restart the running container
  status    Show container status
  logs      Show container logs (tail -f)
  remove    Remove the container

Environment overrides:
  HMH_CONTAINER_NAME
  HMH_IMAGE_NAME
  HMH_HERMES_HOME_HOST
  HMH_DORIS_HOST
  HMH_DORIS_PORT
  HMH_DORIS_USER
  HMH_DORIS_PASSWORD
  HMH_DORIS_DATABASE
  HMH_DEFAULT_SOURCES
  HMH_POLL_INTERVAL_SECONDS
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"
}

build_image() {
  echo "[hmh-deploy] Building image $IMAGE_NAME from $PROJECT_ROOT"
  docker build -t "$IMAGE_NAME" "$PROJECT_ROOT"
}

run_container() {
  mkdir -p "$HERMES_HOME_DIR"

  if container_exists; then
    echo "[hmh-deploy] Removing existing container $CONTAINER_NAME"
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi

  echo "[hmh-deploy] Starting container $CONTAINER_NAME"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --network host \
    -e HMH_DORIS_HOST="$DORIS_HOST" \
    -e HMH_DORIS_PORT="$DORIS_PORT" \
    -e HMH_DORIS_USER="$DORIS_USER" \
    -e HMH_DORIS_PASSWORD="$DORIS_PASSWORD" \
    -e HMH_DORIS_DATABASE="$DORIS_DATABASE" \
    -e HMH_HERMES_HOME=/hermes-home \
    -e HMH_DEFAULT_SOURCES="$DEFAULT_SOURCES" \
    -e HMH_POLL_INTERVAL_SECONDS="$POLL_INTERVAL_SECONDS" \
    -v "$HERMES_HOME_DIR:/hermes-home" \
    "$IMAGE_NAME" >/dev/null

  docker ps --filter "name=$CONTAINER_NAME" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
}

show_status() {
  docker ps -a --filter "name=$CONTAINER_NAME" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
}

show_logs() {
  docker logs -f --tail=100 "$CONTAINER_NAME"
}

main() {
  require_cmd docker

  command_name="${1:-status}"

  case "$command_name" in
    deploy)
      build_image
      run_container
      ;;
    start)
      docker start "$CONTAINER_NAME"
      show_status
      ;;
    stop)
      docker stop "$CONTAINER_NAME"
      ;;
    restart)
      docker restart "$CONTAINER_NAME"
      show_status
      ;;
    status)
      show_status
      ;;
    logs)
      show_logs
      ;;
    remove)
      docker rm -f "$CONTAINER_NAME"
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "Unknown command: $command_name" >&2
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
