"""Measure each CARLA static.prop mesh's local axis convention.

Offset is a property of the MESH, not the map, so this uses whatever world is
already loaded and never reloads it. Every spawned actor is destroyed in a
finally block so the running session is left as found.

bounding_box.extent is in the mesh's LOCAL frame:
  long-box props  -> extent.x > extent.y  means the long axis is local +X
  panel props     -> the THIN horizontal axis is the facing normal
"""
import math, sys, time

PROPS = [
    # id                              kind      expectation
    ("static.prop.trafficcone01",     "sym",    None),
    ("static.prop.trafficcone02",     "sym",    None),
    ("static.prop.constructioncone",  "sym",    None),
    ("static.prop.streetbarrier",     "long",   +90),
    ("static.prop.trafficwarning",    "long",   +90),
    ("static.prop.warningconstruction","panel", -90),
    ("static.prop.warningaccident",   "panel",  -90),
    ("static.prop.barrel",            "sym",    None),
    ("static.prop.ironplank",         "long",   None),
    ("static.prop.dirtdebris01",      "sym",    None),
    ("static.prop.container",         "long",   None),
    ("static.prop.busstop",           "long",   None),
    ("static.prop.advertisement",     "panel",  +90),
    ("static.prop.vendingmachine",    "long",   None),
    ("static.prop.bin",               "sym",    None),
    ("static.prop.shoppingcart",      "long",   None),
]

import carla  # noqa: E402

OUT = "/tmp/claude-1000/-home-dellpro2-Antonio-scenario-editor/e9ba6330-9053-45a3-9efd-f90893249b93/scratchpad"

client = carla.Client("localhost", 3000)
client.set_timeout(30.0)
world = client.get_world()
bl = world.get_blueprint_library()
print(f"connected; map = {world.get_map().name}\n")

spawned = []
rows = []
try:
    # A clear patch of ground: use the spectator's current location, lifted well
    # clear of geometry, and lay the props out in a straight row at yaw 0.
    base = world.get_spectator().get_transform().location
    ox, oy, oz = base.x, base.y, base.z

    for i, (pid, kind, expected) in enumerate(PROPS):
        try:
            bp = bl.find(pid)
        except Exception:
            rows.append((pid, kind, None, None, None, expected, "BLUEPRINT NOT FOUND"))
            continue
        tf = carla.Transform(
            carla.Location(x=ox + 12.0 * i, y=oy + 40.0, z=oz + 0.5),
            carla.Rotation(yaw=0.0),
        )
        a = world.try_spawn_actor(bp, tf)
        if a is None:
            rows.append((pid, kind, None, None, None, expected, "SPAWN FAILED"))
            continue
        spawned.append(a)

    world.tick() if world.get_settings().synchronous_mode else time.sleep(0.6)

    for a in spawned:
        e = a.bounding_box.extent
        pid = a.type_id
        kind = dict((p, k) for p, k, _ in PROPS)[pid]
        expected = dict((p, x) for p, _, x in PROPS)[pid]

        ex, ey, ez = e.x, e.y, e.z
        ratio = (max(ex, ey) / min(ex, ey)) if min(ex, ey) > 1e-6 else float("inf")

        if kind == "sym" or ratio < 1.25:
            offset = 0
            note = "rotationally symmetric / near-square — offset irrelevant"
        elif kind == "long":
            # long axis should end up along local +X
            offset = 0 if ex > ey else 90
            note = f"long axis is local {'X' if ex > ey else 'Y'}"
        else:  # panel: thin axis is the facing normal, want it on local X
            offset = 0 if ex < ey else 90
            note = f"faces local {'X' if ex < ey else 'Y'}"
        rows.append((pid, kind, ex, ey, ez, expected, f"|offset|={offset}  {note}"))

    # Top-down capture over the row for visual sign resolution
    if spawned:
        cx = ox + 12.0 * (len(spawned) - 1) / 2
        cam_bp = bl.find("sensor.camera.rgb")
        cam_bp.set_attribute("image_size_x", "1800")
        cam_bp.set_attribute("image_size_y", "500")
        cam_bp.set_attribute("fov", "90")
        cam_tf = carla.Transform(
            carla.Location(x=cx, y=oy + 40.0, z=oz + 60.0),
            carla.Rotation(pitch=-90.0, yaw=0.0),
        )
        cam = world.spawn_actor(cam_bp, cam_tf)
        spawned.append(cam)
        got = []
        cam.listen(lambda img: got.append(img))
        for _ in range(40):
            if got:
                break
            time.sleep(0.25)
        if got:
            got[-1].save_to_disk(f"{OUT}/carla-props-topdown.png")
            print(f"saved top-down capture -> {OUT}/carla-props-topdown.png")
        else:
            print("!! no camera frame received")
        cam.stop()
finally:
    for a in spawned:
        try:
            a.destroy()
        except Exception:
            pass
    print(f"\ncleaned up {len(spawned)} actors\n")

print(f"{'prop':<34}{'kind':<7}{'ext.x':>7}{'ext.y':>7}{'ext.z':>7}  {'user':>5}  finding")
print("-" * 110)
for pid, kind, ex, ey, ez, expected, note in rows:
    if ex is None:
        print(f"{pid:<34}{kind:<7}{'':>21}  {str(expected):>5}  {note}")
    else:
        print(f"{pid:<34}{kind:<7}{ex:7.2f}{ey:7.2f}{ez:7.2f}  {str(expected):>5}  {note}")
