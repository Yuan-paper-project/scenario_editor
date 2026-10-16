"""SUMO for background traffic: the install, the net built from an .xodr, the run, and reading its FCD into CARLA poses."""

from __future__ import annotations

import math
import os
import random
import subprocess
import sys
import threading
import xml.etree.ElementTree as ET
from pathlib import Path

WARMUP_S = 60.0  # simulated before the window starts
DURATION_S = 65.0  # the window: every Act stops at MaxSimTime 60
STEP_S = 0.1  # SUMO step and FCD period; consumers interpolate

_TYPE_FILE = Path(__file__).parent / "sumo_data" / "opendrive_netconvert.typ.xml"

# CARLA blueprints used for background cars, with their bounding-box extents
# (half-length, half-width) measured on the fail2drive build run.sh uses
# (2026-10-13). The half-length is what turns SUMO's front-bumper position into
# CARLA's centre; every blueprint's box sits on its origin (location.z ≈ extent.z),
# so a puppet's z is the road surface itself.
BLUEPRINTS = [
    ("vehicle.lincoln.mkz_2017", 2.451, 1.064),
    ("vehicle.audi.a2", 1.853, 0.894),
    ("vehicle.toyota.prius", 2.257, 1.003),
    ("vehicle.tesla.model3", 2.396, 1.082),
    ("vehicle.nissan.micra", 1.817, 0.923),
    ("vehicle.mercedes.coupe_2020", 2.337, 0.906),
    ("vehicle.seat.leon", 2.096, 0.908),
    ("vehicle.citroen.c3", 1.994, 0.925),
    ("vehicle.mini.cooper_s", 1.903, 0.985),
    ("vehicle.chevrolet.impala", 2.679, 1.017),
    ("vehicle.audi.etron", 2.428, 1.016),
    ("vehicle.nissan.patrol_2021", 2.783, 1.075),
    ("vehicle.jeep.wrangler_rubicon", 1.933, 0.953),
    ("vehicle.volkswagen.t2_2021", 2.221, 0.887),
    ("vehicle.mercedes.sprinter", 2.958, 0.994),
    ("vehicle.ford.mustang", 2.359, 0.947),
    ("vehicle.dodge.charger_2020", 2.504, 0.941),
    ("vehicle.audi.tt", 2.091, 0.997),
]
_BP = {bp: (ex, ey) for bp, ex, ey in BLUEPRINTS}


class BgTrafficError(RuntimeError):
    """A request that cannot be served (missing SUMO, bad parameters, …)."""


# ── SUMO installation ───────────────────────────────────────────────────────


def sumo_home() -> Path:
    """SUMO_HOME of the `eclipse-sumo` wheel in this venv, or BG_SUMO_HOME.

    The shell's own SUMO_HOME is deliberately not trusted: on this box it
    points at a directory that does not exist.
    """
    env = os.environ.get("BG_SUMO_HOME")
    if env and Path(env, "bin").is_dir():
        return Path(env)
    try:
        import sumo  # the eclipse-sumo wheel

        return Path(sumo.SUMO_HOME)
    except Exception as exc:  # pragma: no cover - depends on the install
        raise BgTrafficError("SUMO ist nicht installiert (pip install eclipse-sumo==1.24.0 in .venv)") from exc


def _run(cmd: list[str], cwd: Path) -> None:
    env = dict(os.environ, SUMO_HOME=str(sumo_home()))
    proc = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
        raise BgTrafficError(f"{Path(cmd[0]).name} fehlgeschlagen: " + " | ".join(tail))


# ── Network ────────────────────────────────────────────────────────────────

_net_locks: dict[str, threading.Lock] = {}
_net_locks_guard = threading.Lock()


def sumo_net(xodr: Path) -> Path:
    """The SUMO net for an `.xodr`, built on first use and cached beside it."""
    xodr = Path(xodr).resolve()
    out = xodr.parent / "sumo" / f"{xodr.stem}.net.xml"
    with _net_locks_guard:
        lock = _net_locks.setdefault(str(out), threading.Lock())
    with lock:
        fresh = (
            out.exists()
            and out.stat().st_mtime >= xodr.stat().st_mtime
            and out.stat().st_mtime >= _TYPE_FILE.stat().st_mtime
        )
        if fresh:
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp.xml")
        _run(
            [
                str(sumo_home() / "bin" / "netconvert"),
                "--opendrive",
                str(xodr),
                "--output-file",
                str(tmp),
                "--geometry.min-radius.fix",
                "--geometry.remove",
                "--opendrive.curve-resolution",
                "1",
                "--opendrive.import-all-lanes",
                "--type-files",
                str(_TYPE_FILE),
                "--output.original-names",
                "--no-warnings",
            ],
            cwd=out.parent,
        )
        tmp.replace(out)
        return out


def _net_info(net: Path) -> tuple[tuple[float, float], float]:
    """(netOffset, diagonal of the converted boundary) from the net's <location>."""
    for _, el in ET.iterparse(net, events=("start",)):
        if el.tag == "location":
            ox, oy = (float(v) for v in el.get("netOffset").split(","))
            x0, y0, x1, y1 = (float(v) for v in el.get("convBoundary").split(","))
            return (ox, oy), math.hypot(x1 - x0, y1 - y0)
    raise BgTrafficError("SUMO-Netz ohne <location>")


_sumolib_nets: dict[str, tuple[float, object]] = {}
_sumolib_lock = threading.Lock()


def _sumolib_net(net: Path):
    """The net parsed by sumolib (from the wheel's tools/), cached per file."""
    tools = str(sumo_home() / "tools")
    if tools not in sys.path:
        sys.path.append(tools)
    import sumolib  # noqa: E402  (lives in SUMO's tools/, not on the default path)

    key = str(net)
    mtime = net.stat().st_mtime
    with _sumolib_lock:
        hit = _sumolib_nets.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
        parsed = sumolib.net.readNet(key, withInternal=True)  # junction lanes: see _write_trip_weights
        _sumolib_nets[key] = (mtime, parsed)
        return parsed


def _write_vtypes(path: Path) -> None:
    lines = ['<additional>']
    for bp, ex, ey in BLUEPRINTS:
        lines.append(
            f'  <vType id="{bp}" vClass="passenger" length="{2 * ex:.3f}" width="{2 * ey:.3f}" '
            f'minGap="2.5" accel="2.6" decel="4.5" sigma="0.5" speedFactor="normc(1,0.1,0.8,1.2)"/>'
        )
    lines.append(f'  <vTypeDistribution id="bg" vTypes="{" ".join(bp for bp, _, _ in BLUEPRINTS)}"/>')
    lines.append('</additional>')
    path.write_text("\n".join(lines) + "\n")


def _simulate(net: Path, routes: list[Path], vtypes: Path, seed: int, cwd: Path) -> Path:
    fcd = cwd / "fcd.xml"
    _run(
        [
            str(sumo_home() / "bin" / "sumo"),
            "-n",
            str(net),
            "-r",
            ",".join(str(r) for r in routes),
            "-a",
            str(vtypes),
            "--begin",
            "0",
            "--end",
            f"{WARMUP_S + DURATION_S:.1f}",
            "--step-length",
            f"{STEP_S}",
            "--seed",
            str(seed),
            "--fcd-output",
            str(fcd),
            "--device.fcd.begin",
            f"{WARMUP_S:.1f}",
            "--fcd-output.attributes",
            "x,y,z,angle,speed",
            "--lanechange.duration",
            "3",  # smooth lane changes; instant ones jump 3.5 m in a step
            "--time-to-teleport",
            "300",
            "--no-step-log",
            "--no-warnings",
            "--duration-log.disable",
        ],
        cwd=cwd,
    )
    return fcd


def _to_carla(fx, fy, fz, angle, ext_x, off):
    """CARLA's BridgeHelper.get_carla_transform: front bumper → centre, net
    offset removed, y flipped, compass angle → CARLA yaw."""
    yaw_s = math.radians(-angle + 90.0)
    sx = fx - math.cos(yaw_s) * ext_x - off[0]
    sy = fy - math.sin(yaw_s) * ext_x - off[1]
    yaw = (angle - 90.0 + 180.0) % 360.0 - 180.0
    return sx, -sy, fz, yaw


def _read_fcd(fcd: Path, types: dict[str, str], off) -> tuple[list[float], dict[str, list]]:
    times: list[float] = []
    tracks: dict[str, list] = {}
    for _, el in ET.iterparse(fcd, events=("end",)):
        if el.tag != "timestep":
            continue
        t = round(float(el.get("time")) - WARMUP_S, 3)
        times.append(t)
        k = len(times) - 1
        for v in el.findall("vehicle"):
            vid = v.get("id")
            bp = types.get(vid) or v.get("type")
            ext_x = _BP.get(bp, (2.4, 1.0))[0]
            x, y, z, yaw = _to_carla(
                float(v.get("x")), float(v.get("y")), float(v.get("z", 0.0)), float(v.get("angle")), ext_x, off
            )
            tracks.setdefault(vid, []).append((k, x, y, z, yaw, float(v.get("speed", 0.0))))
        el.clear()
    return times, tracks


def _vehicle_types(routes: Path) -> dict[str, str]:
    """vehicle id → vType id as duarouter resolved the distribution."""
    out = {}
    for _, el in ET.iterparse(routes, events=("end",)):
        if el.tag == "vehicle":
            out[el.get("id")] = el.get("type")
    return out


def _resolve_types(routes: Path, seed: int) -> dict[str, str]:
    """Pin every vehicle to one concrete blueprint, so the type is known before
    simulation (duarouter keeps the distribution id `bg`). duarouter also
    copies the vType definitions into its output; they are removed, because
    sumo loads them from the additional file and refuses a second definition."""
    rng = random.Random(seed * 7919 + 1)
    tree = ET.parse(routes)
    root = tree.getroot()
    for el in list(root):
        if el.tag in ("vType", "vTypeDistribution"):
            root.remove(el)
        elif el.tag == "vehicle" and el.get("type") in (None, "bg"):
            el.set("type", rng.choice(BLUEPRINTS)[0])
    tree.write(routes)
    return _vehicle_types(routes)
