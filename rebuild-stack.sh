#!/bin/bash
# Rebuild and restart script for entire docker-compose stack

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Default options
SKIP_BUILD=false
TAIL_LOGS=false
SERVICES=""

usage() {
  cat << EOF
Usage: $0 [OPTIONS] [SERVICES...]

Stop, rebuild, and restart docker-compose services.

OPTIONS:
  -n, --no-build      Skip rebuild, just restart
  -l, --logs          Follow logs after starting
  -h, --help          Show this help message

SERVICES:
  If no services specified, all services are rebuilt.
  Available services:
    - nginx
    - terminal-dashboard
    - tmux-session-service
    - whisper-realtime-api (if uncommented)

EXAMPLES:
  $0                                    # Rebuild all services
  $0 -n                                 # Restart all without rebuilding
  $0 terminal-dashboard                 # Rebuild only terminal-dashboard
  $0 -n tmux-session-service           # Restart only tmux-session-service
  $0 -l                                 # Rebuild all and show logs
  $0 terminal-dashboard nginx -l       # Rebuild dashboard & nginx, show logs

EOF
  exit 0
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -n|--no-build)
      SKIP_BUILD=true
      shift
      ;;
    -l|--logs)
      TAIL_LOGS=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    -*)
      echo -e "${RED}Unknown option: $1${NC}"
      usage
      ;;
    *)
      SERVICES="$SERVICES $1"
      shift
      ;;
  esac
done

echo -e "${GREEN}=== Docker Compose Stack Rebuild ===${NC}"
echo

cd "$SCRIPT_DIR"

# Check if docker-compose.yml exists
if [ ! -f "docker-compose.yml" ]; then
  echo -e "${RED}Error: docker-compose.yml not found${NC}"
  exit 1
fi

# Step 1: Stop services
echo -e "${YELLOW}Step 1/3: Stopping services...${NC}"
if [ -z "$SERVICES" ]; then
  docker-compose stop
else
  docker-compose stop $SERVICES
fi
echo

# Step 2: Build services
if [ "$SKIP_BUILD" = false ]; then
  echo -e "${YELLOW}Step 2/3: Building services...${NC}"
  if [ -z "$SERVICES" ]; then
    docker-compose build
  else
    docker-compose build $SERVICES
  fi
else
  echo -e "${YELLOW}Step 2/3: Skipping build (--no-build)${NC}"
fi
echo

# Step 3: Start services
echo -e "${YELLOW}Step 3/3: Starting services...${NC}"
if [ -z "$SERVICES" ]; then
  docker-compose up -d
else
  docker-compose up -d $SERVICES
fi
echo

echo -e "${GREEN}=== Done! ===${NC}"
echo

# Show status
echo "Service status:"
docker-compose ps
echo

# Show logs if requested
if [ "$TAIL_LOGS" = true ]; then
  echo -e "${GREEN}Following logs (Ctrl+C to exit)...${NC}"
  if [ -z "$SERVICES" ]; then
    docker-compose logs -f
  else
    docker-compose logs -f $SERVICES
  fi
else
  echo "View logs with:"
  if [ -z "$SERVICES" ]; then
    echo "  docker-compose logs -f"
  else
    echo "  docker-compose logs -f$SERVICES"
  fi
  echo
  echo "Test services:"
  echo "  curl https://localhost/health          # nginx"
  echo "  curl http://localhost:5001/health      # tmux-session-service"
fi
