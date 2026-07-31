"""Probe v6 — decisive: two axis-aligned eye-level views per prop.

Every prop is spawned at yaw=0 and photographed from two cameras:
  LEFT  column: camera due -Y of the prop, looking toward +Y (cam yaw = +90)
  RIGHT column: camera due -X of the prop, looking toward +X (cam yaw = 0)

Whichever view shows the prop's FRONT tells us, with no interpretation, which
world direction the mesh faces when h=0:
  front visible in LEFT  -> mesh faces -Y at h=0  -> export offset = +90
  front visible in RIGHT -> mesh faces -X at h=0  -> export offset = 180
  back visible in LEFT   -> mesh faces +Y at h=0  -> export offset = -90
  back visible in RIGHT  -> mesh faces +X at h=0  -> export offset =   0
"""
import time
import carla

OUT = "/tmp/claude-1000/-home-dellpro2-Antonio-scenario-editor/e9ba6330-9053-45a3-9efd-f90893249b93/scratchpad"
TARGETS = [
    "static.prop.streetbarrier",
    "static.prop.warningconstruction",
    "static.prop.trafficwarning",
    "static.prop.advertisement",
    "static.prop.busstop",
    "static.prop.container",
]

client = carla.Client("localhost", 3000); client.set_timeout(30.0)
world = client.get_world()
SYNC = world.get_settings().synchronous_mode
bl = world.get_blueprint_library()
def step(n=1):
    for _ in range(n):
        world.tick() if SYNC else world.wait_for_tick()

sps = world.get_map().get_spawn_points()
sps.sort(key=lambda t: (t.location.x, t.location.y))
base = sps[len(sps) // 2]
bx, by, bz = base.location.x, base.location.y, base.location.z + 0.2
print(f"base = ({bx:.1f}, {by:.1f}, {bz:.1f})")

W, H = 620, 470
def shoot(loc, rot):
    bp = bl.find("sensor.camera.rgb")
    bp.set_attribute("image_size_x", str(W)); bp.set_attribute("image_size_y", str(H))
    bp.set_attribute("fov", "45")
    cam = world.spawn_actor(bp, carla.Transform(loc, rot))
    frames = []
    cam.listen(frames.append)
    for _ in range(50):
        step(1)
        if len(frames) >= 4: break
    cam.stop(); cam.destroy()
    return frames[-1] if frames else None

pairs = []
for pid in TARGETS:
    a = world.try_spawn_actor(bl.find(pid),
        carla.Transform(carla.Location(bx, by, bz), carla.Rotation(yaw=0.0)))
    if a is None:
        print(f"  !! spawn failed {pid}"); continue
    try:
        step(8)
        # from -Y looking +Y
        f1 = shoot(carla.Location(bx, by - 9.0, bz + 2.0), carla.Rotation(yaw=90.0, pitch=-8.0))
        # from -X looking +X
        f2 = shoot(carla.Location(bx - 9.0, by, bz + 2.0), carla.Rotation(yaw=0.0, pitch=-8.0))
        n = pid.split(".")[-1]
        if f1: f1.save_to_disk(f"{OUT}/v_{n}_negY.png")
        if f2: f2.save_to_disk(f"{OUT}/v_{n}_negX.png")
        pairs.append((n, f"{OUT}/v_{n}_negY.png", f"{OUT}/v_{n}_negX.png"))
        print(f"  captured {pid}")
    finally:
        try: a.destroy()
        except Exception: pass
    step(2)

time.sleep(1.0)
try:
    from PIL import Image, ImageDraw
    sheet = Image.new("RGB", (2 * W, len(pairs) * (H + 22)), "white")
    d = ImageDraw.Draw(sheet)
    for i, (n, p1, p2) in enumerate(pairs):
        y0 = i * (H + 22)
        d.text((6, y0 + 5), f"{n}  (spawned yaw=0)   LEFT: camera at -Y looking +Y    "
                            f"RIGHT: camera at -X looking +X", fill="black")
        for j, p in enumerate((p1, p2)):
            try:
                sheet.paste(Image.open(p).convert("RGB"), (j * W, y0 + 22))
            except Exception:
                pass
    sheet.save(f"{OUT}/carla-facing.png")
    print(f"\nmontage -> {OUT}/carla-facing.png")
except ImportError as e:
    print("PIL missing:", e)
