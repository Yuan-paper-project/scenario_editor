"""Record where CARLA actually has traffic-light actors, per bundled town.

    PYTHONPATH=<carla egg>:<PythonAPI/carla> /home/dellpro2/Antonio/carla-venv/bin/python \
        tools/probes/probe_carla_traffic_lights.py [--port 2010] [Town01 Town05 ...]

Writes maps/<Town>/carla_traffic_lights.json: [{id, x, y, z}] in the editor's
frame (CARLA world coordinates, no flip). backend/xodr/map_renderer.py reads it to
mark each .xodr light `inCarla`.

Why it is needed: a signal event is emitted as TrafficSignalStateAction
name="pos=x,y", and ScenarioRunner looks the actor up within 2 m of that point
(get_traffic_light_from_osc_name). A light the .xodr has but the CARLA build
does not raises "Unknown traffic light" and aborts the whole run. Town01–07 match within 0.85 m; Town10HD's
traffic_light_10/11 have no actor within 10 m.

`load_world`s each town, so run it against an idle CARLA.
"""

import argparse
import json
import os

import carla

HERE = os.path.dirname(os.path.abspath(__file__))
MAPS = os.path.join(HERE, "..", "..", "maps")
TOWNS = ["Town01", "Town02", "Town03", "Town04", "Town05", "Town06", "Town07", "Town10HD"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2010)
    ap.add_argument("towns", nargs="*", default=TOWNS)
    args = ap.parse_args()
    client = carla.Client("localhost", args.port)
    client.set_timeout(120)
    for town in args.towns:
        world = client.get_world()
        if not world.get_map().name.endswith(town):
            world = client.load_world(town)
        lights = []
        for tl in world.get_actors().filter("traffic.traffic_light"):
            loc = tl.get_location()
            lights.append({"id": tl.id, "x": round(loc.x, 2), "y": round(loc.y, 2), "z": round(loc.z, 2)})
        lights.sort(key=lambda l: (l["x"], l["y"]))
        out = os.path.join(MAPS, town, "carla_traffic_lights.json")
        with open(out, "w") as fh:
            json.dump(lights, fh, indent=1)
        print(f"{town}: {len(lights)} lights -> {out}", flush=True)


if __name__ == "__main__":
    main()
