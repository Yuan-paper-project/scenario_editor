#!/bin/bash
# Run every formatter and linter in check mode. Non-zero exit if any complains.
#
#   bash tools/lint.sh          # check only
#   bash tools/lint.sh --fix    # apply formatting and safe fixes, then check
#
# First run: .venv/bin/pip install -r requirements-dev.txt && bash tools/install_biome.sh
set -uo pipefail
cd "$(dirname "$0")/.."

VENV=.venv/bin
status=0

if [ "${1:-}" = "--fix" ]; then
    "$VENV/ruff" format .
    "$VENV/ruff" check --fix .
    .tools/biome check --write
fi

echo "════ ruff format";  "$VENV/ruff" format --check . || status=1
echo "════ ruff check";   "$VENV/ruff" check . || status=1
echo "════ pylint (module size, function size, duplicate code)"
"$VENV/pylint" backend tools tests generate_pptx.py || status=1
echo "════ biome (frontend JS/CSS)"
.tools/biome ci --reporter=summary || status=1

exit "$status"
