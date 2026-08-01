"""Check every actor-catalogue blueprint against the running CARLA, and list
which walkers are children.

Two questions the .xosc cannot answer, because a wrong blueprint id produces a
perfectly valid file:

  1. does the id exist in this CARLA build? An id that does not exist fails at
     spawn time, deep inside ScenarioRunner, as a missing actor.
  2. which walker.pedestrian.* are children? That is a property of the build's
     content, not of OpenSCENARIO, and it moves between CARLA versions. The
     `child` archetype in vehicle_catalog.yaml is chosen from this output.

A probe, not a test: it prints and returns non-zero only when an id is missing.
Nothing is spawned, so it is safe against a live session.

    source /home/dellpro2/Antonio/carla-venv/bin/activate
    export PYTHONPATH="/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla/dist/carla-0.9.15-cp310-cp310-linux_x86_64.egg:/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla:/home/dellpro2/CC/carla_0.9.15/PythonAPI"
    python tests/probe_carla_actor_blueprints.py
"""
import os
import sys

import yaml

import carla  # noqa: E402

_CATALOG = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "..", "llm-scenario-gen", "config", "vehicle_catalog.yaml")

with open(_CATALOG) as fh:
    catalog = yaml.safe_load(fh)

wanted = []
for archetype, spec in catalog.items():
    if archetype == "vehicle_category" or not isinstance(spec, dict):
        continue
    for key in ("ego_default", "npc_default"):
        if spec.get(key):
            wanted.append((archetype, key, spec[key]))
    for alt in spec.get("alternatives") or []:
        wanted.append((archetype, "alternative", alt))

client = carla.Client("localhost", 3000)
client.set_timeout(30.0)
library = client.get_world().get_blueprint_library()
have = {bp.id for bp in library}

missing = []
print(f"{'archetype':<12} {'role':<12} blueprint")
print("-" * 72)
for archetype, role, bp_id in wanted:
    ok = bp_id in have
    if not ok:
        missing.append((archetype, role, bp_id))
    print(f"{archetype:<12} {role:<12} {bp_id:<48} {'ok' if ok else 'MISSING'}")

# Walker ages. `child` in the catalogue must be one of the ids reported as
# age=child here; if it is not, swap the id in vehicle_catalog.yaml and change
# nothing else — the editor's `child` type does not name a blueprint anywhere.
print()
print("walker.pedestrian.* by age:")
for bp in sorted(library.filter("walker.pedestrian.*"), key=lambda b: b.id):
    attrs = {a.id: a.as_str() for a in bp}
    print(f"  {bp.id:<28} age={attrs.get('age', '?'):<10} "
          f"gender={attrs.get('gender', '?')}")

if missing:
    print(f"\n{len(missing)} blueprint(s) missing from this CARLA build:")
    for archetype, role, bp_id in missing:
        print(f"  {archetype}.{role} -> {bp_id}")
sys.exit(1 if missing else 0)
