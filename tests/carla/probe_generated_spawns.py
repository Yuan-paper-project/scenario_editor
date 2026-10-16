"""Spawn every actor of many generated scenarios in CARLA, all at once per scenario.

    .venv/bin/python3 tests/probe_generated_spawns.py --count 120 --seed 9
    .venv/bin/python3 tests/probe_generated_spawns.py --zip szenarien.zip --out szenarien_ok.zip

A scenario whose actors cannot all spawn fails before its first tick
("Error: Unable to add actors") — the whole run is lost, and nothing about the
.xosc looks wrong. This catches that across hundreds of generated scenarios in
minutes rather than one full run each: it builds an all-maps batch through the
editor (ScenarioGenerator.generateBatch + /api/export/batch), reads each .xosc's
exact blueprints and Init teleport poses, and try_spawn_actor()s them together,
so an actor-on-actor overlap fails too. Props are spawned as well.

Everything spawned is destroyed again straight away, so the simulator is left
as it was (apart from the loaded town).

With --zip it probes a batch the Generieren dialog already downloaded instead
of building one, and --out writes a copy holding only the scenarios that spawn
completely (manifest rows of the rest marked status=spawn_failed). Some
failures cannot be predicted from the .xodr at all — a hedge on a Town04
sidewalk, a railing beside an elevated Town03 sidewalk are meshes, not road
data — so this CARLA-side filter is the step that makes a batch safe to run
unattended. Expect ~1% of scenarios, nearly all crossing pedestrians/cyclists.

Runs the editor side with this repo's .venv and the CARLA side in a
subprocess with carla-venv, the same split run_carla_cases.py uses.
"""

import argparse
import base64
import io
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "e2e"))

CARLA_SIDE = r'''
import json, math, sys
import carla
cases = json.load(sys.stdin)
port = int(sys.argv[1])
client = carla.Client("localhost", port); client.set_timeout(120)
results = []
for town in sorted({c["town"] for c in cases}):
    world = client.get_world()
    if not world.get_map().name.endswith(town):
        world = client.load_world(town)
    bl = world.get_blueprint_library()
    for case in [c for c in cases if c["town"] == town]:
        spawned, failed = [], []
        for a in case["actors"]:
            try:
                bp = bl.find(a["bp"])
            except Exception:
                failed.append({**a, "why": "unknown blueprint"}); continue
            if bp.has_attribute("role_name"):
                bp.set_attribute("role_name", a["name"])
            tf = carla.Transform(carla.Location(a["x"], a["y"], a["z"]),
                                 carla.Rotation(yaw=math.degrees(a["h"])))
            act = world.try_spawn_actor(bp, tf)
            if act is None:
                failed.append({**a, "why": "spawn refused (collision or no room)"})
            else:
                spawned.append(act)
        for act in spawned:
            act.destroy()
        results.append({"name": case["name"], "town": town, "n": len(case["actors"]), "failed": failed})
print(json.dumps(results))
'''

CARLA_PY = "/home/dellpro2/Antonio/carla-venv/bin/python"
CARLA_ROOT = "/home/dellpro2/CC/carla_0.9.15"
CARLA_PYTHONPATH = ":".join(
    [
        f"{CARLA_ROOT}/PythonAPI/carla/dist/carla-0.9.15-cp310-cp310-linux_x86_64.egg",
        f"{CARLA_ROOT}/PythonAPI/carla",
    ]
)


def actors_of(xosc):
    """[{name, bp, x, y, z, h}] from a .xosc's Entities + Init teleports."""
    root = ET.fromstring(xosc)
    bps = {}
    for so in root.iter("ScenarioObject"):
        name = so.get("name")
        for tag, attr in (("Vehicle", "name"), ("Pedestrian", "model"), ("MiscObject", "name")):
            el = so.find(tag)
            if el is not None:
                bps[name] = el.get(attr)
    out = []
    for priv in root.iter("Private"):
        ref = priv.get("entityRef")
        wp = priv.find(".//TeleportAction//WorldPosition")
        if ref in bps and wp is not None:
            out.append(
                {
                    "name": ref,
                    "bp": bps[ref],
                    "x": float(wp.get("x")),
                    "y": float(wp.get("y")),
                    "z": float(wp.get("z", 0)),
                    "h": float(wp.get("h", 0)),
                }
            )
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--count", type=int, default=120)
    ap.add_argument("--seed", type=int, default=9)
    ap.add_argument("--maps", default="carla", choices=["carla", "current"])
    ap.add_argument("--type", default=None, help="only this generator type (default: all, balanced)")
    ap.add_argument("--port", type=int, default=2010)
    ap.add_argument("--zip", help="probe this batch zip instead of generating one")
    ap.add_argument("--out", help="write a copy of the batch with only fully spawning scenarios")
    args = ap.parse_args()

    if args.zip:
        with open(args.zip, "rb") as fh:
            res = {"b64": base64.b64encode(fh.read()).decode(), "skipped": 0}
    else:
        res = _generate(args)
    _probe(args, res)


def _generate(args):
    import _harness as H
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser, page, errors = H.open_editor(p, "Town03")
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
        res = page.evaluate(
            """async ([n, s, m, t]) => {
          const res = await ScenarioGenerator.generateBatch({ count: n, seed: s, maps: m, typeKey: t });
          const out = await Api.exportBatch({ scenarios: res.entries, filename: 'p.zip' });
          const buf = new Uint8Array(await out.blob.arrayBuffer());
          let bin = ''; for (const c of buf) bin += String.fromCharCode(c);
          return { b64: btoa(bin), skipped: res.skipped.length };
        }""",
            [args.count, args.seed, args.maps, args.type],
        )
        browser.close()
    return res


def _probe(args, res):
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(res["b64"])))
    manifest = json.loads(z.read("manifest.json"))
    cases = [
        {
            "name": row["name"],
            "town": row["town"],
            "type": row["type"],
            "actors": actors_of(z.read(row["name"] + ".xosc").decode()),
        }
        for row in manifest
        if row["status"] == "ok"
    ]
    print(
        f"{len(cases)} scenarios ({res['skipped']} skipped by the generator), "
        f"{sum(len(c['actors']) for c in cases)} actors"
    )

    proc = subprocess.run(
        [CARLA_PY, "-c", CARLA_SIDE, str(args.port)],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        env=dict(os.environ, PYTHONPATH=CARLA_PYTHONPATH),
        timeout=1800,
    )
    if proc.returncode != 0:
        print(proc.stderr[-2000:])
        sys.exit(2)
    results = json.loads(proc.stdout.strip().splitlines()[-1])
    bad = [r for r in results if r["failed"]]
    types = {c["name"]: c["type"] for c in cases}
    for r in bad:
        for f in r["failed"]:
            print(
                f"  FAIL  {r['name']} ({types[r['name']]}): {f['name']} {f['bp']} "
                f"@ ({f['x']:.1f}, {f['y']:.1f}, {f['z']:.2f}) — {f['why']}"
            )
    print(f"\n{len(results) - len(bad)}/{len(results)} scenarios spawn completely")
    if args.out:
        failed = {r["name"] for r in bad}
        with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as zo:
            for name in z.namelist():
                stem = name.rsplit(".", 1)[0].removesuffix("_route")
                if name.startswith("manifest") or stem in failed:
                    continue
                zo.writestr(name, z.read(name))
            for row in manifest:
                if row["name"] in failed:
                    row["status"], row["error"] = "spawn_failed", "CARLA refused an actor's spawn pose"
            zo.writestr("manifest.json", json.dumps(manifest, indent=2))
            cols = list(dict.fromkeys(k for row in manifest for k in row))
            buf = io.StringIO()
            import csv

            w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            for row in manifest:
                w.writerow({k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in row.items()})
            zo.writestr("manifest.csv", buf.getvalue())
        print(f"wrote {args.out} with {len(results) - len(bad)} scenarios")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
