#!/usr/bin/env bash
# list-sessions.sh - List all tmux sessions with metadata
#
# Usage: list-sessions.sh [--json] [--active-only]
#
# Shows all tmux sessions with status, project info, and source.
# Queries both tmux directly and the web service for metadata.

set -eo pipefail

SERVICE_URL="${SESSION_SERVICE_URL:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

usage() {
    cat <<EOF
Usage: list-sessions.sh [options]

Lists all tmux sessions with metadata from both tmux and the web service.

Options:
  --json         Output in JSON format
  --active-only  Show only active (attached) sessions
  --service-url  Override SESSION_SERVICE_URL environment variable
  --help         Show this help message

Environment:
  SESSION_SERVICE_URL   URL of tmux-session-service API (e.g., http://localhost:5001)

Output Columns:
  SESSION    - tmux session name
  PROJECT    - Associated project (from web service metadata)
  SOURCE     - Where session was created (web, ssh, discovered, unknown)
  ATTACHED   - Whether someone is currently attached
  WINDOWS    - Number of windows in the session
  CREATED    - When the session was created

Examples:
  list-sessions.sh
  list-sessions.sh --json
  list-sessions.sh --active-only
  SESSION_SERVICE_URL=http://localhost:5001 list-sessions.sh
EOF
    exit 0
}

# Parse arguments
OUTPUT_JSON=false
ACTIVE_ONLY=false

for arg in "$@"; do
    case $arg in
        --help|-h)
            usage
            ;;
        --json)
            OUTPUT_JSON=true
            ;;
        --active-only)
            ACTIVE_ONLY=true
            ;;
        --service-url=*)
            SERVICE_URL="${arg#*=}"
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

# Get tmux sessions
declare -A TMUX_SESSIONS=()
declare -A TMUX_ATTACHED=()
declare -A TMUX_WINDOWS=()
declare -A TMUX_CREATED=()

TMPFILE="/tmp/tmux_sessions_$$.tmp"
if tmux list-sessions -F '#{session_name}|#{session_created}|#{session_attached}|#{session_windows}' 2>/dev/null > "$TMPFILE"; then
    while IFS='|' read -r name created attached windows; do
        [[ -z "$name" ]] && continue
        TMUX_SESSIONS["$name"]=1
        TMUX_CREATED["$name"]="$created"
        TMUX_ATTACHED["$name"]="$attached"
        TMUX_WINDOWS["$name"]="$windows"
    done < "$TMPFILE"
fi
rm -f "$TMPFILE"

# Get metadata from web service if available
declare -A WEB_PROJECT=()
declare -A WEB_SOURCE=()

if [[ -n "$SERVICE_URL" ]] && command -v curl >/dev/null 2>&1; then
    SESSIONS_JSON=$(curl -sS "$SERVICE_URL/sessions" 2>/dev/null || echo '{"sessions":[]}')

    # Parse JSON using bash (jq optional)
    if command -v jq >/dev/null 2>&1; then
        while IFS='|' read -r sid pid src; do
            WEB_PROJECT["$sid"]="$pid"
            WEB_SOURCE["$sid"]="$src"
        done < <(echo "$SESSIONS_JSON" | jq -r '.sessions[]? | "\(.sessionId)|\(.projectId // "")|\(.source // "web")"' 2>/dev/null || true)
    fi
fi

# Check if we have any sessions
if [[ ${#TMUX_SESSIONS[@]} -eq 0 ]]; then
    if $OUTPUT_JSON; then
        echo "[]"
    else
        echo "No active tmux sessions found."
    fi
    exit 0
fi

# Output in JSON format
if $OUTPUT_JSON; then
    echo "["
    first=true
    for session in "${!TMUX_SESSIONS[@]}"; do
        attached="${TMUX_ATTACHED[$session]:-0}"

        # Skip if active-only and not attached
        if $ACTIVE_ONLY && [[ "$attached" -eq 0 ]]; then
            continue
        fi

        created="${TMUX_CREATED[$session]:-0}"
        windows="${TMUX_WINDOWS[$session]:-0}"
        project="${WEB_PROJECT[$session]:-}"
        source="${WEB_SOURCE[$session]:-unknown}"

        # Convert timestamp to ISO format
        created_iso=$(date -d "@$created" -Iseconds 2>/dev/null || echo "$created")

        $first || echo ","
        first=false

        cat <<EOF
  {
    "session": "$session",
    "project": ${project:+\"$project\"}${project:-null},
    "source": "$source",
    "attached": $([[ $attached -gt 0 ]] && echo true || echo false),
    "windows": $windows,
    "created": "$created_iso"
  }
EOF
    done
    echo ""
    echo "]"
    exit 0
fi

# Table output
print_header() {
    printf "${BOLD}%-24s %-20s %-12s %-10s %-8s %s${NC}\n" \
        "SESSION" "PROJECT" "SOURCE" "ATTACHED" "WINDOWS" "CREATED"
    printf "%s\n" "$(printf '%.0s-' {1..90})"
}

print_row() {
    local session="$1"
    local project="$2"
    local source="$3"
    local attached="$4"
    local windows="$5"
    local created="$6"

    # Color coding
    local attached_color=""
    local attached_str="no"
    if [[ "$attached" -gt 0 ]]; then
        attached_color="${GREEN}"
        attached_str="yes"
    fi

    local source_color=""
    case "$source" in
        web) source_color="${CYAN}" ;;
        ssh) source_color="${GREEN}" ;;
        discovered) source_color="${YELLOW}" ;;
        *) source_color="${NC}" ;;
    esac

    # Format created time
    local created_str
    created_str=$(date -d "@$created" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "unknown")

    printf "%-24s %-20s ${source_color}%-12s${NC} ${attached_color}%-10s${NC} %-8s %s\n" \
        "${session:0:24}" "${project:0:20}" "${source:0:12}" "$attached_str" "$windows" "$created_str"
}

print_header

# Sort sessions by name
sorted_sessions=($(echo "${!TMUX_SESSIONS[@]}" | tr ' ' '\n' | sort))

for session in "${sorted_sessions[@]}"; do
    attached="${TMUX_ATTACHED[$session]:-0}"

    # Skip if active-only and not attached
    if $ACTIVE_ONLY && [[ "$attached" -eq 0 ]]; then
        continue
    fi

    created="${TMUX_CREATED[$session]:-0}"
    windows="${TMUX_WINDOWS[$session]:-0}"
    project="${WEB_PROJECT[$session]:-}"
    source="${WEB_SOURCE[$session]:-unknown}"

    # Use session name as project if no metadata
    if [[ -z "$project" ]]; then
        project="(none)"
    fi

    print_row "$session" "$project" "$source" "$attached" "$windows" "$created"
done

# Summary
echo ""
total=${#TMUX_SESSIONS[@]}
attached_count=0
for session in "${!TMUX_SESSIONS[@]}"; do
    [[ "${TMUX_ATTACHED[$session]:-0}" -gt 0 ]] && ((attached_count++)) || true
done

echo -e "${BOLD}Total:${NC} $total sessions ($attached_count attached)"

if [[ -z "$SERVICE_URL" ]]; then
    echo -e "${YELLOW}Tip:${NC} Set SESSION_SERVICE_URL to see project metadata from web service"
fi
