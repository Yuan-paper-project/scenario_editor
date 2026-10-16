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
# Not tests/: a suite is long check sequences and spelled-out fixtures by design (ruff still covers it).
# --recursive: tools/ has no __init__.py, so pylint could not load it as a package.
"$VENV/pylint" --recursive=y backend tools || status=1
echo "════ biome (frontend JS/CSS)"
.tools/biome ci --reporter=summary || status=1
echo "════ shared-scope names (frontend split modules)"
"$VENV/python" tools/check_shared_scopes.py || status=1
echo "════ hygiene (frontend file size, change-log comments, dated CLAUDE.md)"
"$VENV/python" tools/check_hygiene.py || status=1

exit "$status"
