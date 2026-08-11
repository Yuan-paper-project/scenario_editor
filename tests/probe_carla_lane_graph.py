"""probe_carla_lane_graph.py — cache CARLA's lane topology per bundled town.

Not a test: a one-off tool, like probe_carla_mesh_dims.py (see tests/README.md
for the general CARLA-probe pattern). Needs a running CARLA and the
`carla-venv` environment, since this repo's own .venv has no `carla` package:

  source /home/dellpro2/Antonio/carla-venv/bin/activate
  export PYTHONPATH="/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla/dist/carla-0.9.15-cp310-cp310-linux_x86_64.egg:/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla:/home/dellpro2/CC/carla_0.9.15/PythonAPI"
  python tests/probe_carla_lane_graph.py              # every bundled town with a CARLA counterpart
  python tests/probe_carla_lane_graph.py Town03 Town05 # just these

CARLA_HOST / CARLA_PORT override the target (default localhost:2010, matching
run.sh's port — NOT the port 3000 the older mesh/prop probes use, which was a
separate lightweight instance; this reuses whatever CARLA is already up
rather than spinning up a second UE4 process).

Why this is safe to cache rather than query live: the ONLY thing here that
truly comes from CARLA rather than the .xodr text is the topology
ENUMERATION ORDER — which successor `waypoint.next()` returns first at a
fork, which lane `get_left_lane()`/`get_right_lane()` resolves to. That is a
fixed property of a given map + CARLA build (see the "In-editor preview
fidelity" plan, phase 2), so probing it once and shipping the result is
equivalent to querying live, at zero runtime cost.

Two things are extracted, matching what the real runtime actually consults:

1. The ROUTING GRAPH — literally GlobalRoutePlanner's internal topology
   (agents.navigation.global_route_planner, the SAME class
   atomic_behaviors.py builds for AssignRouteAction and
   KeepLongitudinalGap's distance planner). Constructing the real class and
   dumping its private _graph/_id_map/_road_id_to_edge avoids reimplementing
   _build_topology/_build_graph/_find_loose_ends/_lane_change_link and
   guarantees the graph matches bit-for-bit.
2. A per-lane-section TABLE — left/right neighbour identity, lane_change
   permission, and the ORDERED next() successor list sampled at each lane's
   END (where a fork actually manifests) — used for lane_change feasibility
   and for resolving SimpleVehicleControl's "no waypoints" fork-following.

Output: maps/<Town>/lane_graph.json, one per successfully probed town.
Town10 has no CARLA counterpart (see CLAUDE.md — it's a custom georeferenced
map with no CARLA content asset behind it) and is skipped; the frontend falls
back to phase-1 badging for it, exactly as it does for an uploaded map.
"""
import json
import os
import sys
import time
from pathlib import Path

CARLA_HOST = os.environ.get("CARLA_HOST", "localhost")
CARLA_PORT = int(os.environ.get("CARLA_PORT", "2010"))
SAMPLING_RESOLUTION = 2.0     # matches atomic_behaviors.py's GlobalRoutePlanner(map, 2.0)
LANE_SAMPLE_STEP = 1.0        # generate_waypoints() step — fine enough not to miss short sections
FORK_QUERY_DISTANCE = 1.0     # next() distance queried from each lane's end point

REPO_ROOT = Path(__file__).resolve().parent.parent
MAPS_DIR = REPO_ROOT / "maps"

# Bundled folder name -> CARLA's loadable map name. Identity for everything
# except Town10, which CARLA does not have.
TOWN_CARLA_NAME = {
    "Town01": "Town01", "Town02": "Town02", "Town03": "Town03",
    "Town04": "Town04", "Town05": "Town05", "Town06": "Town06",
    "Town07": "Town07", "Town10HD": "Town10HD",
}

import carla  # noqa: E402
from agents.navigation.global_route_planner import GlobalRoutePlanner  # noqa: E402


def _lane_key(wp):
    return (wp.road_id, wp.section_id, wp.lane_id)


def _pose(wp):
    loc = wp.transform.location
    return {"x": round(loc.x, 3), "y": round(loc.y, 3), "z": round(loc.z, 3)}


def _lane_ref(wp):
    return {"roadId": wp.road_id, "sectionId": wp.section_id, "laneId": wp.lane_id}


def _extract_routing_graph(grp):
    """Pull GlobalRoutePlanner's internal graph out as plain JSON.

    Nodes are a flat list (id assigned by position) rather than an object
    keyed by id: networkx node ids here are plain ints — including NEGATIVE
    ones for loose ends (_find_loose_ends) — and JSON object keys must be
    strings, so a list sidesteps the int/string round-trip entirely; the
    frontend builds its own id -> vertex map at load time.
    """
    graph = grp._graph  # noqa: SLF001 — the whole point is to dump this
    road_id_to_edge = grp._road_id_to_edge  # noqa: SLF001

    nodes = [{"id": n, **{k: round(v, 2) for k, v in zip(("x", "y", "z"), data["vertex"])}}
             for n, data in graph.nodes(data=True)]

    edges = []
    for u, v, data in graph.edges(data=True):
        edge_type = data["type"]
        edges.append({
            "from": u, "to": v,
            "type": edge_type.name if hasattr(edge_type, "name") else str(edge_type),
            "length": data.get("length", 1),
            "intersection": bool(data.get("intersection")),
            "path": [_pose(wp) for wp in (data.get("path") or [])],
            "entry": {**_lane_ref(data["entry_waypoint"]), **_pose(data["entry_waypoint"])},
            "exit": {**_lane_ref(data["exit_waypoint"]), **_pose(data["exit_waypoint"])},
        })

    road_id_to_edge_out = {
        str(road_id): {
            str(section_id): {str(lane_id): list(edge) for lane_id, edge in lanes.items()}
            for section_id, lanes in sections.items()
        }
        for road_id, sections in road_id_to_edge.items()
    }

    return {"nodes": nodes, "edges": edges, "roadIdToEdge": road_id_to_edge_out}


def _walk_to_fork(wp, current_key, max_hops=60):
    """Repeatedly call next(FORK_QUERY_DISTANCE), following the [0] branch,
    until either the lane identity changes or next() itself returns more
    than one waypoint (a genuine fork) — exactly the loop
    SimpleVehicleControl runs when driving with no authored waypoints.

    Needed because generate_waypoints()'s last sample per lane can land a
    few decimetres short of the true section boundary, so a single next()
    call from it sometimes lands back inside the SAME lane instead of
    revealing what comes after it.

    A genuine dead-end (a driveway or spur with no successor at all) exhausts
    max_hops without the key ever changing, so its one "successor" is itself
    — the frontend should treat that the same as an empty list: no real
    progress is possible past this point.
    """
    for _ in range(max_hops):
        next_wps = wp.next(FORK_QUERY_DISTANCE)
        if not next_wps:
            return []
        if len(next_wps) > 1:
            return next_wps
        wp = next_wps[0]
        if _lane_key(wp) != current_key:
            return [wp]
    return [wp]  # gave up — record whatever was last reached


def _extract_lane_table(carla_map):
    """One record per (road_id, section_id, lane_id) actually on the map.

    Keeps the waypoint with the LARGEST `s` per group — the end of that lane
    section — because that is where next() reveals a fork; a query from an
    arbitrary mid-lane point almost always just returns the same lane's
    continuation and would silently record "no fork" everywhere.
    """
    end_wp = {}
    for wp in carla_map.generate_waypoints(LANE_SAMPLE_STEP):
        key = _lane_key(wp)
        prev = end_wp.get(key)
        if prev is None or wp.s > prev.s:
            end_wp[key] = wp

    lanes_out = []
    for (road_id, section_id, lane_id), wp in end_wp.items():
        left = wp.get_left_lane()
        right = wp.get_right_lane()
        successors = _walk_to_fork(wp, (road_id, section_id, lane_id))
        lanes_out.append({
            "roadId": road_id, "sectionId": section_id, "laneId": lane_id,
            "s": round(wp.s, 2),  # where along the lane this record was sampled — its END
            "laneType": str(wp.lane_type),
            "laneChange": str(wp.lane_change),
            "left": _lane_ref(left) if (left and left.lane_type == carla.LaneType.Driving) else None,
            "right": _lane_ref(right) if (right and right.lane_type == carla.LaneType.Driving) else None,
            # Index 0 is exactly what SimpleVehicleControl's map_wp.next(2.0)[0]
            # walk would pick with no authored waypoints — see simple_vehicle_control.py.
            "successors": [_lane_ref(s) for s in successors],
        })
    return lanes_out


def probe_town(client, folder_name, carla_name):
    print(f"[{folder_name}] loading {carla_name} ...", flush=True)
    t0 = time.time()
    world = client.load_world(carla_name, reset_settings=False)
    carla_map = world.get_map()
    print(f"[{folder_name}] loaded in {time.time() - t0:.1f}s, building routing graph ...", flush=True)

    t1 = time.time()
    grp = GlobalRoutePlanner(carla_map, SAMPLING_RESOLUTION)
    routing = _extract_routing_graph(grp)
    print(f"[{folder_name}] routing graph in {time.time() - t1:.1f}s "
          f"({len(routing['nodes'])} nodes, {len(routing['edges'])} edges)", flush=True)

    t2 = time.time()
    lanes = _extract_lane_table(carla_map)
    print(f"[{folder_name}] lane table in {time.time() - t2:.1f}s ({len(lanes)} lanes)", flush=True)

    return {
        "town": folder_name,
        "carlaMapName": carla_map.name,
        "samplingResolution": SAMPLING_RESOLUTION,
        "probeVersion": 1,
        **routing,
        "lanes": lanes,
    }


def main():
    requested = sys.argv[1:] or list(TOWN_CARLA_NAME.keys())
    unknown = [t for t in requested if t not in TOWN_CARLA_NAME]
    if unknown:
        print(f"No CARLA counterpart for: {unknown} (available: {sorted(TOWN_CARLA_NAME)})")
        sys.exit(1)

    client = carla.Client(CARLA_HOST, CARLA_PORT)
    client.set_timeout(60.0)
    original_map = client.get_world().get_map().name

    try:
        for folder_name in requested:
            data = probe_town(client, folder_name, TOWN_CARLA_NAME[folder_name])
            out_path = MAPS_DIR / folder_name / "lane_graph.json"
            out_path.write_text(json.dumps(data))
            print(f"[{folder_name}] wrote {out_path} ({out_path.stat().st_size} bytes)\n", flush=True)
    finally:
        # Leave the shared CARLA instance close to how it was found.
        short_name = original_map.split("/")[-1]
        print(f"restoring original map: {short_name}", flush=True)
        client.load_world(short_name, reset_settings=False)


if __name__ == "__main__":
    main()
