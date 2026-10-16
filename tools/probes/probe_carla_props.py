"""Measure every catalogued CARLA static prop the way ScenarioRunner spawns it.

Where the numbers in frontend/js/props/propData.js (footprint, `z` lift, `off`)
and ../llm-scenario-gen/config/prop_catalog.yaml (bbox) came from. Re-run it
after a CARLA build upgrade. Not a test: it prints, it asserts nothing.

Per prop, alone, on a flat ground-level road:
  * bounding_box.extent / .location — footprint, height, and how far the mesh
    centre sits from the pivot (the container's is 1.1 m to one side);
  * a settle run reproducing ScenarioRunner's own sequence — spawn 0.2 m up with
    physics ON (CarlaDataProvider.request_new_actors does this for every
    'misc' actor), teleport to the exact pose (Init TeleportAction), physics ON
    again, tick 4 s — once at the catalogue lift and once at z 0. A prop whose
    pivot is above its base falls through the world at z 0; that is the reason
    the lift exists.

It calls load_world, so run it against a PRIVATE CARLA (port 2050 by
default, like capture_carla_aerial.py), never run.sh's 2010. Every actor it
spawns is destroyed before the next one.

    cd ~/yungloon/fail2drive/f2d_carla && ./CarlaUE4.sh -carla-port=2050 -RenderOffScreen -nosound &
    /home/dellpro2/Antonio/carla-venv/bin/python tests/probe_carla_props.py            # catalogue
    /home/dellpro2/Antonio/carla-venv/bin/python tests/probe_carla_props.py --all      # every static.prop.* in the build
"""

import math
import os
import re
import sys
import time

import carla

PORT = int(os.environ.get("CARLA_PORT", "2050"))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATALOG_JS = os.path.join(REPO, "frontend", "js", "props", "propData.js")
SETTLE_TICKS = 80  # 4 s at 0.05 s


def catalogue_lifts():
    js = open(CATALOG_JS).read()
    return {
        m.group(1): float(m.group(2))
        # [^{}] keeps the match inside one entry: `z` comes before the nested side/plan objects.
        for m in re.finditer(r"'(static\.prop\.[^']+)': \{[^{}]*?\bz: (-?[0-9.]+)", js)
    }


def flat_site(m):
    """A ground-level road point whose surface is level within 5 cm over ±10 m."""
    for sp in m.get_spawn_points():
        if abs(sp.location.z) > 1.0:
            continue
        wp = m.get_waypoint(sp.location)
        zs = [x.transform.location.z for x in wp.next(10.0) + wp.previous(10.0)]
        zs.append(wp.transform.location.z)
        if max(zs) - min(zs) < 0.05:
            return wp.transform.location
    raise SystemExit("no flat ground-level site found on this map")


def settle(client, world, bp, base, z):
    """ScenarioRunner's spawn + teleport sequence; returns the settled actor's state."""
    tf = carla.Transform(carla.Location(base.x, base.y, base.z + z), carla.Rotation(yaw=0))
    lifted = carla.Transform(carla.Location(base.x, base.y, base.z + z + 0.2), tf.rotation)
    r = client.apply_batch_sync(
        [carla.command.SpawnActor(bp, lifted).then(carla.command.SetSimulatePhysics(carla.command.FutureActor, True))],
        True,
    )[0]
    if r.error:
        return {"error": r.error}
    a = world.get_actor(r.actor_id)
    try:
        world.tick()
        a.set_target_velocity(carla.Vector3D())
        a.set_target_angular_velocity(carla.Vector3D())
        a.set_transform(tf)
        world.tick()
        a.set_simulate_physics(True)
        for _ in range(SETTLE_TICKS):
            world.tick()
        t, bb = a.get_transform(), a.bounding_box
        return {
            "ext": (2 * bb.extent.x, 2 * bb.extent.y, 2 * bb.extent.z),
            "ctr": (bb.location.x, bb.location.y, bb.location.z),
            "dz": t.location.z - tf.location.z,
            "dxy": math.hypot(t.location.x - tf.location.x, t.location.y - tf.location.y),
            "tilt": max(abs(t.rotation.pitch), abs(t.rotation.roll)),
            # where the visual base ended up relative to the road
            "base": t.location.z + bb.location.z - bb.extent.z - base.z,
        }
    finally:
        a.destroy()
        world.tick()


def main():
    client = carla.Client("localhost", PORT)
    client.set_timeout(120)
    world = client.get_world()
    if "Town05" not in world.get_map().name:
        world = client.load_world("Town05")
        time.sleep(3)
    lib = world.get_blueprint_library()
    lifts = catalogue_lifts()
    if "--all" in sys.argv:
        ids = sorted(b.id for b in lib.filter("static.prop.*"))
    else:
        ids = list(lifts)
    base = flat_site(world.get_map())

    st = world.get_settings()
    st.synchronous_mode, st.fixed_delta_seconds = True, 0.05
    world.apply_settings(st)
    print(
        f"site {base.x:.1f},{base.y:.1f},{base.z:.2f}   lift = catalogue z; "
        f"base = visual base above road after {SETTLE_TICKS * 0.05:.0f} s\n"
    )
    print(
        f"{'blueprint':34s} {'L x W x H (mesh frame)':>22s} {'centre off pivot':>18s} "
        f"{'lift':>5s} {'base@lift':>9s} {'base@0':>8s}  note"
    )
    try:
        for pid in ids:
            try:
                bp = lib.find(pid)
            except IndexError:
                print(f"{pid:34s} BLUEPRINT NOT IN THIS BUILD")
                continue
            lift = lifts.get(pid, 0.0)
            at = settle(client, world, bp, base, lift)
            if "error" in at:
                print(f"{pid:34s} SPAWN FAILED: {at['error']}")
                continue
            at0 = settle(client, world, bp, base, 0.0) if lift else at
            ex, ey, ez = at["ext"]
            cx, cy, cz = at["ctr"]
            notes = []
            if at["tilt"] > 3:
                notes.append(f"topples ({at['tilt']:.0f} deg)")
            if at["dxy"] > 0.1:
                notes.append(f"slides {at['dxy']:.2f} m")
            if abs(at["base"]) > 0.1:
                notes.append("settles off the road (collision mesh)")
            if "error" not in at0 and at0["dz"] < -5:
                notes.append("FALLS THROUGH THE WORLD at z 0")
            b0 = f"{at0['base']:+8.2f}" if "error" not in at0 else "   error"
            print(
                f"{pid:34s} {ex:6.2f} x {ey:5.2f} x {ez:5.2f}   ({cx:+5.2f}, {cy:+5.2f}, {cz:+5.2f}) "
                f"{lift:5.2f} {at['base']:+9.2f} {b0}  {'; '.join(notes)}"
            )
    finally:
        st.synchronous_mode, st.fixed_delta_seconds = False, None
        world.apply_settings(st)


if __name__ == "__main__":
    main()
