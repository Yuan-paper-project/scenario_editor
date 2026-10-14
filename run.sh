#!/bin/bash
cd "$(dirname "$0")"
VENV=".venv"
if [ ! -d "$VENV" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV"
    echo "Installing dependencies..."
    "$VENV/bin/pip" install -q fastapi "uvicorn[standard]" pyyaml python-multipart "eclipse-sumo==1.24.0"
    echo "Done."
fi
PORT=${1:-9090}
echo "Starting OpenSCENARIO GUI Editor at http://localhost:$PORT"
"$VENV/bin/uvicorn" backend.main:app --host 0.0.0.0 --port "$PORT" --reload
