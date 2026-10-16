#!/bin/bash
cd "$(dirname "$0")"
VENV=".venv"
if [ ! -d "$VENV" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV"
    echo "Installing dependencies..."
    "$VENV/bin/pip" install -q -r requirements.txt
    echo "Done."
fi
# Turn on the lint pre-commit hook in a clone that does not have it yet.
if git rev-parse --git-dir >/dev/null 2>&1 && [ -z "$(git config core.hooksPath)" ]; then
    git config core.hooksPath tools/hooks
fi
PORT=${1:-9090}
echo "Starting OpenSCENARIO GUI Editor at http://localhost:$PORT"
"$VENV/bin/uvicorn" backend.main:app --host 0.0.0.0 --port "$PORT" --reload
