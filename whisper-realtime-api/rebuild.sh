#!/bin/bash
# Rebuild and restart script for whisper-realtime-api

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Service name in docker-compose
SERVICE_NAME="whisper-realtime-api"

# Parse options
SKIP_BUILD=false
TAIL_LOGS=false
DETACH=true

usage() {
  cat << EOF
Usage: $0 [OPTIONS]

Rebuild and restart the whisper-realtime-api service.

OPTIONS:
  -n, --no-build      Skip rebuild, just restart
  -l, --logs          Follow logs after starting
  -f, --foreground    Run in foreground (don't detach)
  -h, --help          Show this help message

EXAMPLES:
  $0                  # Stop, rebuild, and start in background
  $0 -l               # Rebuild and show logs
  $0 -n               # Just restart without rebuilding
  $0 -n -l            # Restart and show logs

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
    -f|--foreground)
      DETACH=false
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      usage
      ;;
  esac
done

echo -e "${GREEN}=== Whisper API Rebuild Script ===${NC}"
echo

# Change to project root
cd "$PROJECT_ROOT"

# Check if docker-compose.yml exists
if [ ! -f "docker-compose.yml" ]; then
  echo -e "${RED}Error: docker-compose.yml not found in $PROJECT_ROOT${NC}"
  echo "This script must be run from the whisper-realtime-api directory"
  echo "or the project root must contain docker-compose.yml"
  exit 1
fi

# Check if service is defined in docker-compose.yml
if ! grep -q "^  ${SERVICE_NAME}:" docker-compose.yml && ! grep -q "^  # ${SERVICE_NAME}:" docker-compose.yml; then
  echo -e "${RED}Error: Service '${SERVICE_NAME}' not found in docker-compose.yml${NC}"
  echo "Please ensure the service is defined in docker-compose.yml"
  exit 1
fi

# Check if service is commented out
if grep -q "^  # ${SERVICE_NAME}:" docker-compose.yml; then
  echo -e "${YELLOW}Warning: Service '${SERVICE_NAME}' is commented out in docker-compose.yml${NC}"
  echo "Uncomment it to use with docker-compose"
  echo
  echo "Running standalone build instead..."
  cd "$SCRIPT_DIR"

  # Standalone mode
  echo -e "${YELLOW}Step 1/3: Stopping existing container...${NC}"
  docker stop ai-workflow-whisper 2>/dev/null || echo "Container not running"
  docker rm ai-workflow-whisper 2>/dev/null || echo "Container not found"

  if [ "$SKIP_BUILD" = false ]; then
    echo -e "${YELLOW}Step 2/3: Building image...${NC}"
    docker build -t whisper-realtime-api .
  else
    echo -e "${YELLOW}Step 2/3: Skipping build (--no-build)${NC}"
  fi

  echo -e "${YELLOW}Step 3/3: Starting container...${NC}"

  # Build docker run command
  RUN_CMD="docker run --name ai-workflow-whisper"

  # Add GPU support if available
  if command -v nvidia-smi &> /dev/null; then
    echo "GPU detected, enabling CUDA support"
    RUN_CMD="$RUN_CMD --gpus all"
    RUN_CMD="$RUN_CMD -e WHISPER_DEVICE=cuda"
    RUN_CMD="$RUN_CMD -e WHISPER_COMPUTE_TYPE=float16"
    RUN_CMD="$RUN_CMD -e WHISPER_MODEL_SIZE=medium"
  else
    echo "No GPU detected, using CPU"
    RUN_CMD="$RUN_CMD -e WHISPER_DEVICE=cpu"
    RUN_CMD="$RUN_CMD -e WHISPER_MODEL_SIZE=base"
  fi

  # Add port and detach
  RUN_CMD="$RUN_CMD -p 8000:8000"

  if [ "$DETACH" = true ]; then
    RUN_CMD="$RUN_CMD -d"
  fi

  RUN_CMD="$RUN_CMD --restart unless-stopped whisper-realtime-api"

  # Execute
  eval $RUN_CMD

  if [ "$TAIL_LOGS" = true ] || [ "$DETACH" = false ]; then
    echo
    echo -e "${GREEN}Following logs (Ctrl+C to exit)...${NC}"
    docker logs -f ai-workflow-whisper
  fi

else
  # Docker Compose mode
  echo -e "${YELLOW}Step 1/3: Stopping service...${NC}"
  docker-compose stop "$SERVICE_NAME" 2>/dev/null || true

  if [ "$SKIP_BUILD" = false ]; then
    echo -e "${YELLOW}Step 2/3: Building service...${NC}"
    docker-compose build "$SERVICE_NAME"
  else
    echo -e "${YELLOW}Step 2/3: Skipping build (--no-build)${NC}"
  fi

  echo -e "${YELLOW}Step 3/3: Starting service...${NC}"
  if [ "$DETACH" = true ]; then
    docker-compose up -d "$SERVICE_NAME"
  else
    docker-compose up "$SERVICE_NAME"
  fi

  if [ "$TAIL_LOGS" = true ] && [ "$DETACH" = true ]; then
    echo
    echo -e "${GREEN}Following logs (Ctrl+C to exit)...${NC}"
    docker-compose logs -f "$SERVICE_NAME"
  fi
fi

echo
echo -e "${GREEN}=== Done! ===${NC}"
echo
echo "Service status:"
docker ps --filter "name=whisper" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo
echo "Test with:"
echo "  curl http://localhost:8000/health"
echo "  cd tests && ./test-whisper-api.sh sample-pt-short.mp3"
