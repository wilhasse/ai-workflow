#!/bin/bash
# Wrapper script to run generate-portuguese-sample.py with proper environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
PYTHON_SCRIPT="$SCRIPT_DIR/generate-portuguese-sample.py"

# Check if venv exists
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Check if required packages are installed
if ! "$VENV_DIR/bin/python" -c "import gtts, pydub" 2>/dev/null; then
    echo "Installing required packages (gtts, pydub)..."
    "$VENV_DIR/bin/pip" install -q gtts pydub
fi

# Run the script
exec "$VENV_DIR/bin/python" "$PYTHON_SCRIPT" "$@"
