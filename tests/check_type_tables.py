"""
check_type_tables.py — the actor-type tables kept by hand in both repos must agree.

Which types are walkers, which may take a route, and what an alias resolves to are
written down separately in the frontend, the backend and ../llm-scenario-gen (CLAUDE.md
"Actor types"). Every lookup falls back silently, so a type added to one table and not
another exports a clean, wrong file. Pure Python: no server, no browser; it imports the
sibling repo and reads the JS tables as text.

    .venv/bin/python3 tests/check_type_tables.py
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tests" / "e2e"))

from _harness import Checks  # noqa: E402

from backend.scenario import event_rules  # noqa: E402
from backend.scenario.scenario_io import _ensure_llmgen_on_path  # noqa: E402

_ensure_llmgen_on_path()
from generator import event_builders, xml_builder  # noqa: E402

JS = REPO / "frontend" / "js"


def js_set(file, name):
    """The string members of `const NAME = new Set([...])` in a frontend file."""
    text = (JS / file).read_text()
    m = re.search(rf"const {name} = new Set\(\[(.*?)\]\)", text, re.S)
    if not m:
        raise SystemExit(f"{file}: no `const {name} = new Set([...])` — update this check")
    return set(re.findall(r"'([^']+)'", m.group(1)))


def type_groups():
    """ACTOR_TYPE_GROUPS (appState.js) as {group id: set of types}."""
    text = (JS / "core" / "appState.js").read_text()
    block = text[text.index("const ACTOR_TYPE_GROUPS") :]
    block = block[: block.index("\n  ];")]
    groups = {}
    for part in re.split(r"\bid: '", block)[1:]:
        gid = part[: part.index("'")]
        groups[gid] = set(re.findall(r"\btype: '([^']+)'", part))
    return groups


def main():
    C = Checks()
    walker_js = js_set("map/mapMarkers.js", "WALKER_TYPES")
    walker_rules = js_set("core/scenarioRules.js", "WALKER_ACTION_TYPES")
    route_js = js_set("core/scenarioRules.js", "ROUTE_ACTION_TYPES")
    road_facing = js_set("objects/objectsCore.js", "ROAD_FACING_TYPES")
    groups = type_groups()
    aliases = xml_builder._TYPE_ALIASES

    # The walker split, kept five times.
    walker_sets = {
        "mapMarkers.js WALKER_TYPES": walker_js,
        "scenarioRules.js WALKER_ACTION_TYPES": walker_rules,
        "xml_builder _PEDESTRIAN_TYPES": set(xml_builder._PEDESTRIAN_TYPES),
        "event_builders _WALKER_ACTION_TYPES": set(event_builders._WALKER_ACTION_TYPES),
        "event_rules _WALKER_ACTOR_TYPES": set(event_rules._WALKER_ACTOR_TYPES),
    }
    for label, s in walker_sets.items():
        C(f"walker types: {label} matches xml_builder", s == set(xml_builder._PEDESTRIAN_TYPES), sorted(s))

    # The routable set. The editor-side copies also accept the literal 'ego' (the editor's ego
    # keeps type 'ego'; the export sends its vehicle type, so the emitter never sees it). The
    # backend's also holds every alias that resolves into the set, because the emitter applies
    # the aliases before checking.
    route_emit = set(event_builders._ROUTE_ACTION_TYPES)
    route_backend = set(event_rules._ROUTE_ACTOR_TYPES)
    C("route types: scenarioRules.js and event_rules accept the ego", "ego" in route_js and "ego" in route_backend)
    C(
        "route types: scenarioRules.js matches event_builders (+ 'ego')",
        route_js - {"ego"} == route_emit,
        sorted((route_js - {"ego"}) ^ route_emit),
    )
    want_backend = route_emit | {a for a, t in aliases.items() if t in route_emit}
    C(
        "route types: event_rules = event_builders + the aliases that resolve into it (+ 'ego')",
        route_backend - {"ego"} == want_backend,
        sorted((route_backend - {"ego"}) ^ want_backend),
    )

    C("aliases: xml_builder and event_builders agree", aliases == event_builders._TYPE_ALIASES)

    # The type picker's groups against everything above.
    known = set(xml_builder.actor_types())
    for gid, types in groups.items():
        C(f"type picker '{gid}': every type exports (xml_builder.actor_types)", types <= known, sorted(types - known))
    C("type picker 'vehicle' is exactly the routable set", groups.get("vehicle") == route_emit)
    vru = groups.get("vru", set())
    C("type picker 'vru': walkers plus the cyclist", vru == walker_js | {"cyclist"}, sorted(vru))
    C("every 'vru' type is placed facing the road (ROAD_FACING_TYPES)", vru <= road_facing, sorted(vru - road_facing))
    C("no walker type is routable", not (walker_js & route_emit))

    sys.exit(C.report())


if __name__ == "__main__":
    main()
