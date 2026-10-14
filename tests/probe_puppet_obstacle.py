"""Does SimpleVehicleControl's obstacle sensor see a "puppet" car?

A puppet is a background vehicle replayed from precomputed trajectories:
physics off, moved by set_transform every tick. The ego and every NPC brake
for obstacles through `sensor.other.obstacle` with `only_dynamics=True`
(simple_vehicle_control.py), so a puppet the sensor cannot see would be driven
through. This spawns an observer carrying exactly that sensor and, 25 m ahead
in its lane, a target vehicle in three variants:

    physics      physics on, standing           (control: must be seen)
    static       physics off, standing
    moving       physics off, moved 0.5 m per tick by set_transform

    PYTHONPATH=$CARLA_ROOT/PythonAPI/carla /home/dellpro2/Antonio/carla-venv/bin/python \
        tests/probe_puppet_obstacle.py [--port 2010]

Uses whatever town is loaded; switches the world to synchronous mode for the
probe and restores the previous settings afterwards. Run it against an idle CARLA.
"""
import argparse

import carla

AHEAD_M = 25.0
TICKS = 20


def _straight_waypoint(cmap):
    """A driving-lane waypoint with ~40 m of straight, junction-free lane ahead."""
    for wp in cmap.generate_waypoints(10.0):
        if wp.is_junction or wp.lane_type != carla.LaneType.Driving:
            continue
        cur, ok = wp, True
        for _ in range(8):
            nxt = cur.next(5.0)
            if not nxt or nxt[0].is_junction:
                ok = False
                break
            cur = nxt[0]
        if ok and abs((cur.transform.rotation.yaw - wp.transform.rotation.yaw + 180) % 360 - 180) < 3:
            return wp
    raise RuntimeError("no straight lane found")


def _run_variant(world, bp_lib, wp, variant):
    car_bp = bp_lib.find("vehicle.lincoln.mkz_2017")
    car_bp.set_attribute("role_name", "probe")
    lift = carla.Location(z=0.5)
    obs_tf = carla.Transform(wp.transform.location + lift, wp.transform.rotation)
    tgt_wp = wp.next(AHEAD_M)[0]
    tgt_tf = carla.Transform(tgt_wp.transform.location + lift, tgt_wp.transform.rotation)

    observer = world.spawn_actor(car_bp, obs_tf)
    target = world.spawn_actor(car_bp, tgt_tf)
    world.tick()
    if variant != "physics":
        target.set_simulate_physics(False)
    world.tick()

    sbp = bp_lib.find("sensor.other.obstacle")
    sbp.set_attribute("distance", "250")
    sbp.set_attribute("hit_radius", "1")
    sbp.set_attribute("only_dynamics", "True")
    sensor = world.spawn_actor(
        sbp, carla.Transform(carla.Location(x=observer.bounding_box.extent.x, z=1.0)), attach_to=observer)
    hits = []
    sensor.listen(lambda ev: hits.append((ev.frame, ev.other_actor.id if ev.other_actor else None, ev.distance)))

    fwd = tgt_tf.get_forward_vector()
    for i in range(TICKS):
        if variant == "moving":
            loc = tgt_tf.location + carla.Location(x=fwd.x * 0.5 * (i + 1), y=fwd.y * 0.5 * (i + 1))
            target.set_transform(carla.Transform(loc, tgt_tf.rotation))
        world.tick()

    sensor.stop()
    on_target = [h for h in hits if h[1] == target.id]
    other = [h for h in hits if h[1] != target.id]
    dists = [round(h[2], 2) for h in on_target]
    print(f"{variant:8s} hits on target: {len(on_target):2d}/{TICKS}  "
          f"distances {dists[:3]}{' …' if len(dists) > 3 else ''}  other hits: {len(other)}", flush=True)
    for a in (sensor, target, observer):
        a.destroy()
    world.tick()
    return len(on_target) > 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2010)
    args = ap.parse_args()
    client = carla.Client("localhost", args.port)
    client.set_timeout(60)
    world = client.get_world()
    old = world.get_settings()
    new = world.get_settings()
    new.synchronous_mode = True
    new.fixed_delta_seconds = 0.05
    world.apply_settings(new)
    try:
        cmap = world.get_map()
        print(f"map {cmap.name}", flush=True)
        wp = _straight_waypoint(cmap)
        print(f"lane road {wp.road_id} lane {wp.lane_id} at {wp.transform.location}", flush=True)
        seen = {v: _run_variant(world, world.get_blueprint_library(), wp, v)
                for v in ("physics", "static", "moving")}
        print("RESULT", seen, flush=True)
    finally:
        world.apply_settings(old)


if __name__ == "__main__":
    main()
