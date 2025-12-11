#!/usr/bin/env bash
# tmux-project.sh - Create or attach to project-based tmux sessions
#
# Usage: tmux-project.sh <project-name> [--windows=shell,editor,logs] [--dir=/path]
#
# Creates a tmux session with standard windows for a project.
# If session already exists, attaches to it.
# Optionally registers with web dashboard for visibility.

set -euo pipefail

SERVICE_URL="${SESSION_SERVICE_URL:-}"
DEFAULT_SHELL="${SESSION_SHELL:-${SHELL:-/bin/bash}}"
DEFAULT_WINDOWS="shell,editor,logs"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

usage() {
    cat <<EOF
Usage: tmux-project.sh <project-name> [options]

Creates or attaches to a project-based tmux session with standard windows.

Arguments:
  project-name    Name for the tmux session (alphanumeric, dash, underscore)

Options:
  --windows=LIST  Comma-separated list of windows to create (default: shell,editor,logs)
  --dir=PATH      Change to this directory in all windows
  --register      Register session with web service (requires SESSION_SERVICE_URL)
  --help          Show this help message

Environment:
  SESSION_SERVICE_URL   URL of tmux-session-service API (e.g., http://localhost:5001)
  SESSION_SHELL         Shell to use (default: \$SHELL or /bin/bash)

Examples:
  tmux-project.sh myproject
  tmux-project.sh myproject --windows=code,tests,server --dir=~/src/myproject
  SESSION_SERVICE_URL=http://localhost:5001 tmux-project.sh myproject --register
EOF
    exit 0
}

sanitize() {
    local value="$1"
    value="${value//[^A-Za-z0-9_-]/}"
    echo "${value:0:64}"
}

log_info() {
    echo -e "${GREEN}[tmux-project]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[tmux-project]${NC} $1"
}

log_error() {
    echo -e "${RED}[tmux-project]${NC} $1" >&2
}

# Parse arguments
PROJECT_NAME=""
WINDOWS="$DEFAULT_WINDOWS"
PROJECT_DIR=""
REGISTER=false

for arg in "$@"; do
    case $arg in
        --help|-h)
            usage
            ;;
        --windows=*)
            WINDOWS="${arg#*=}"
            ;;
        --dir=*)
            PROJECT_DIR="${arg#*=}"
            ;;
        --register)
            REGISTER=true
            ;;
        -*)
            log_error "Unknown option: $arg"
            exit 1
            ;;
        *)
            if [[ -z "$PROJECT_NAME" ]]; then
                PROJECT_NAME="$arg"
            else
                log_error "Unexpected argument: $arg"
                exit 1
            fi
            ;;
    esac
done

# Validate project name
if [[ -z "$PROJECT_NAME" ]]; then
    log_error "Project name is required"
    echo ""
    usage
fi

# Sanitize session name
SESSION_NAME="$(sanitize "$PROJECT_NAME")"
if [[ -z "$SESSION_NAME" ]]; then
    log_error "Invalid project name (must contain alphanumeric, dash, or underscore)"
    exit 1
fi

# Expand and validate directory if specified
if [[ -n "$PROJECT_DIR" ]]; then
    PROJECT_DIR="${PROJECT_DIR/#\~/$HOME}"
    if [[ ! -d "$PROJECT_DIR" ]]; then
        log_warn "Directory does not exist: $PROJECT_DIR (will create windows anyway)"
    fi
fi

# Check if session already exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    log_info "Attaching to existing session: $SESSION_NAME"
    exec tmux attach-session -t "$SESSION_NAME"
fi

# Create new session
log_info "Creating new session: $SESSION_NAME"

# Parse windows list
IFS=',' read -ra WINDOW_ARRAY <<< "$WINDOWS"

if [[ ${#WINDOW_ARRAY[@]} -eq 0 ]]; then
    log_error "At least one window is required"
    exit 1
fi

# Create session with first window
FIRST_WINDOW="${WINDOW_ARRAY[0]}"
if [[ -n "$PROJECT_DIR" ]] && [[ -d "$PROJECT_DIR" ]]; then
    tmux new-session -d -s "$SESSION_NAME" -n "$FIRST_WINDOW" -c "$PROJECT_DIR" "$DEFAULT_SHELL"
else
    tmux new-session -d -s "$SESSION_NAME" -n "$FIRST_WINDOW" "$DEFAULT_SHELL"
fi

# Create additional windows
for ((i=1; i<${#WINDOW_ARRAY[@]}; i++)); do
    WINDOW_NAME="${WINDOW_ARRAY[$i]}"
    if [[ -n "$PROJECT_DIR" ]] && [[ -d "$PROJECT_DIR" ]]; then
        tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" -c "$PROJECT_DIR" "$DEFAULT_SHELL"
    else
        tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" "$DEFAULT_SHELL"
    fi
done

# Select first window
tmux select-window -t "$SESSION_NAME:$FIRST_WINDOW"

# Register with web service if requested
if $REGISTER; then
    if [[ -z "$SERVICE_URL" ]]; then
        log_warn "SESSION_SERVICE_URL not set, skipping registration"
    elif command -v curl >/dev/null 2>&1; then
        log_info "Registering session with web service..."
        PAYLOAD="{\"sessionId\":\"$SESSION_NAME\",\"projectId\":\"$PROJECT_NAME\",\"source\":\"ssh\"}"
        if curl -sS -X PUT "$SERVICE_URL/sessions/$SESSION_NAME" \
            -H 'Content-Type: application/json' \
            -d "$PAYLOAD" >/dev/null 2>&1; then
            log_info "Session registered successfully"
        else
            log_warn "Failed to register session (web service may be unavailable)"
        fi
    else
        log_warn "curl not found, skipping registration"
    fi
fi

# Show session info
log_info "Session created with windows: ${WINDOWS}"
if [[ -n "$PROJECT_DIR" ]]; then
    log_info "Working directory: $PROJECT_DIR"
fi

# Attach to session
exec tmux attach-session -t "$SESSION_NAME"
