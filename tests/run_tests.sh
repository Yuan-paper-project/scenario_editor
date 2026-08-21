#!/bin/bash
# Run the static-props end-to-end suites against a running editor.
#
#   bash tests/run_tests.sh              # assumes the editor is already on :9090
#   EDITOR_URL=http://localhost:8000 bash tests/run_tests.sh
#
# These drive a real browser (Playwright + headless Chromium) against a real
# server and a real export, so the editor must be running first:
#   bash run.sh 9090
#
# First run only:
#   .venv/bin/pip install playwright && .venv/bin/python3 -m playwright install chromium
set -uo pipefail
cd "$(dirname "$0")/.."

PY=.venv/bin/python3
URL="${EDITOR_URL:-http://localhost:9090}"

if ! "$PY" -c "import playwright" 2>/dev/null; then
    echo "playwright not installed. Run:"
    echo "  $PY -m pip install playwright && $PY -m playwright install chromium"
    exit 2
fi

if ! curl -s -o /dev/null --max-time 5 "$URL/"; then
    echo "No editor at $URL — start it first:  bash run.sh 9090"
    exit 2
fi

# The exporter reads ../llm-scenario-gen once at import, and --reload does not
# watch that repo. A stale server is the single most common cause of confusing
# failures here, so say so up front rather than letting it look like a bug.
echo "Testing $URL"
echo "(if the catalogue or xml_builder changed, restart the editor first —"
echo " --reload does not watch ../llm-scenario-gen)"
echo

status=0

# Pure-python first: it needs no browser and no server, so a failure here
# points at the backend rather than at the test setup.
echo "════ tests/test_normalization.py"
"$PY" tests/test_normalization.py || status=1
echo

echo "════ tests/compare_xodr_lane_graph.py"
"$PY" tests/compare_xodr_lane_graph.py || status=1
echo

for t in tests/test_props_e2e.py tests/test_prop_yaw_e2e.py \
         tests/test_templates_e2e.py tests/test_events_e2e.py \
         tests/test_ego_events_e2e.py \
         tests/test_actor_types_e2e.py tests/test_elevation_e2e.py \
         tests/test_route_fidelity_e2e.py tests/test_undo_e2e.py; do
    echo "════ $t"
    EDITOR_URL="$URL" "$PY" "$t" || status=1
    echo
done

# tests/run_carla_cases.py is deliberately NOT run here: it needs CARLA on
# port 3000, takes over the simulator, and takes minutes rather than seconds.

exit "$status"
