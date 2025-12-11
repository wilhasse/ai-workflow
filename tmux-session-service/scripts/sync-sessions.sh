#!/usr/bin/env bash
# sync-sessions.sh - Sync tmux sessions to web service metadata
#
# Usage: sync-sessions.sh [--dry-run] [--project-pattern=<regex>]
#
# Discovers all active tmux sessions and registers them with
# the web service so they appear in the dashboard.

set -euo pipefail

SERVICE_URL="${SESSION_SERVICE_URL:-http://localhost:5001}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

usage() {
    cat <<EOF
Usage: sync-sessions.sh [options]

Syncs active tmux sessions to the web service metadata store.
This allows SSH-created sessions to appear in the web dashboard.

Options:
  --dry-run              Show what would be synced without making changes
  --project-pattern=RE   Regex to extract project name from session name
                         (uses sed -E, capture group 1 becomes project name)
  --service-url=URL      Override SESSION_SERVICE_URL (default: http://localhost:5001)
  --force                Re-register all sessions, even if already known
  --cleanup              Remove metadata for sessions that no longer exist in tmux
  --help                 Show this help message

Environment:
  SESSION_SERVICE_URL    URL of tmux-session-service API

Examples:
  sync-sessions.sh
  sync-sessions.sh --dry-run
  sync-sessions.sh --project-pattern='^([^-]+)-.*'  # Extract prefix as project
  sync-sessions.sh --cleanup --force
EOF
    exit 0
}

log_info() {
    echo -e "${GREEN}[sync]${NC} $1"
}

log_skip() {
    echo -e "${CYAN}[skip]${NC} $1"
}

log_sync() {
    echo -e "${GREEN}[sync]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[warn]${NC} $1"
}

log_error() {
    echo -e "${RED}[error]${NC} $1" >&2
}

log_cleanup() {
    echo -e "${YELLOW}[cleanup]${NC} $1"
}

# Parse arguments
DRY_RUN=false
PROJECT_PATTERN=""
FORCE=false
CLEANUP=false

for arg in "$@"; do
    case $arg in
        --help|-h)
            usage
            ;;
        --dry-run)
            DRY_RUN=true
            ;;
        --project-pattern=*)
            PROJECT_PATTERN="${arg#*=}"
            ;;
        --service-url=*)
            SERVICE_URL="${arg#*=}"
            ;;
        --force)
            FORCE=true
            ;;
        --cleanup)
            CLEANUP=true
            ;;
        *)
            log_error "Unknown option: $arg"
            exit 1
            ;;
    esac
done

# Check for curl
if ! command -v curl >/dev/null 2>&1; then
    log_error "curl is required but not found"
    exit 1
fi

# Check service availability
log_info "Checking web service at $SERVICE_URL..."
if ! curl -sS "$SERVICE_URL/health" >/dev/null 2>&1; then
    log_error "Cannot connect to web service at $SERVICE_URL"
    log_error "Make sure the service is running and SESSION_SERVICE_URL is correct"
    exit 1
fi

$DRY_RUN && echo -e "${YELLOW}=== DRY RUN MODE ===${NC}"
echo ""

# Get all active tmux sessions
log_info "Discovering tmux sessions..."
ACTIVE_SESSIONS=$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)

if [[ -z "$ACTIVE_SESSIONS" ]]; then
    log_warn "No active tmux sessions found"
    exit 0
fi

# Get existing metadata from service
log_info "Fetching existing metadata from web service..."
EXISTING_JSON=$(curl -sS "$SERVICE_URL/sessions" 2>/dev/null || echo '{"sessions":[]}')

declare -A EXISTING_IDS
if command -v jq >/dev/null 2>&1; then
    while IFS= read -r sid; do
        [[ -n "$sid" ]] && EXISTING_IDS["$sid"]=1
    done < <(echo "$EXISTING_JSON" | jq -r '.sessions[].sessionId' 2>/dev/null || true)
fi

# Count sessions
total_active=$(echo "$ACTIVE_SESSIONS" | wc -l)
total_existing=${#EXISTING_IDS[@]}

echo "Found $total_active active tmux sessions"
echo "Found $total_existing sessions in web service metadata"
echo ""

# Sync each session
synced=0
skipped=0
errors=0

while IFS= read -r session; do
    [[ -z "$session" ]] && continue

    # Check if already registered (unless force)
    if [[ -n "${EXISTING_IDS[$session]:-}" ]] && ! $FORCE; then
        log_skip "$session (already registered)"
        ((skipped++))
        continue
    fi

    # Infer project ID from session name
    project_id="$session"
    if [[ -n "$PROJECT_PATTERN" ]]; then
        extracted=$(echo "$session" | sed -E "s/$PROJECT_PATTERN/\\1/" 2>/dev/null || echo "")
        if [[ -n "$extracted" && "$extracted" != "$session" ]]; then
            project_id="$extracted"
        fi
    fi

    # Determine source
    source="ssh-sync"
    if [[ -n "${EXISTING_IDS[$session]:-}" ]]; then
        source="ssh-sync-update"
    fi

    log_sync "$session -> project: $project_id"

    if ! $DRY_RUN; then
        PAYLOAD="{\"sessionId\":\"$session\",\"projectId\":\"$project_id\",\"source\":\"$source\"}"
        if curl -sS -X PUT "$SERVICE_URL/sessions/$session" \
            -H 'Content-Type: application/json' \
            -d "$PAYLOAD" >/dev/null 2>&1; then
            ((synced++))
        else
            log_warn "  Failed to register: $session"
            ((errors++))
        fi
    else
        ((synced++))
    fi
done <<< "$ACTIVE_SESSIONS"

# Cleanup orphaned metadata entries
if $CLEANUP; then
    echo ""
    log_info "Checking for orphaned metadata entries..."

    # Build list of active session names
    declare -A ACTIVE_SET
    while IFS= read -r session; do
        [[ -n "$session" ]] && ACTIVE_SET["$session"]=1
    done <<< "$ACTIVE_SESSIONS"

    cleaned=0
    if command -v jq >/dev/null 2>&1; then
        while IFS= read -r sid; do
            [[ -z "$sid" ]] && continue
            if [[ -z "${ACTIVE_SET[$sid]:-}" ]]; then
                log_cleanup "$sid (no longer active in tmux)"
                if ! $DRY_RUN; then
                    if curl -sS -X DELETE "$SERVICE_URL/sessions/$sid" >/dev/null 2>&1; then
                        ((cleaned++))
                    else
                        log_warn "  Failed to cleanup: $sid"
                    fi
                else
                    ((cleaned++))
                fi
            fi
        done < <(echo "$EXISTING_JSON" | jq -r '.sessions[].sessionId' 2>/dev/null || true)
    fi

    if [[ $cleaned -gt 0 ]]; then
        echo "Cleaned up $cleaned orphaned entries"
    else
        echo "No orphaned entries found"
    fi
fi

# Summary
echo ""
echo "================================"
echo "Summary:"
echo "  Synced:  $synced"
echo "  Skipped: $skipped"
if [[ $errors -gt 0 ]]; then
    echo -e "  ${RED}Errors:  $errors${NC}"
fi
echo "================================"

if $DRY_RUN; then
    echo ""
    echo -e "${YELLOW}This was a dry run. Run without --dry-run to apply changes.${NC}"
fi
