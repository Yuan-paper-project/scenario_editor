"""Road-surface elevation suite: z is derived from OpenDRIVE, not hardcoded.

Every z the editor writes is the <elevationProfile> surface at (x, y) plus a
per-category clearance. Before this existed, actors were placed at a flat 0.2 and
props at 0.0, which buries them on any map with a gradient — Town03 road 67
climbs to 2.7 m and back to 0 within its own length, which is what made
tpl-lane-change clip.

Town01 is genuinely flat (every elevation coefficient is 0), so it isolates the
clearance constants; Town03 exercises the actual interpolation.
"""
import math
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("EDITOR_URL", "http://localhost:9090")
fails, checks = [], []

# Kept in step with SPAWN_CLEARANCE in frontend/js/objects.js.
VEHICLE_CLEARANCE = 0.5
VRU_CLEARANCE = 0.6

# Town03 road 67, the tpl-lane-change straight. Reference-line surface heights
# measured from the .xodr elevation profile.
T3_HIGH = (159.0, 193.0)      # surface ~2.63 m
T3_LOW = (25.0, 193.4)        # surface ~0.00 m


def check(name, cond, extra=""):
    checks.append((name, bool(cond), extra))
    if not cond:
        fails.append(f"{name} {extra}")


def load_map(page, town):
    page.select_option("#map-select", town)
    page.wait_for_function("AppState.mapData !== null", timeout=60000)
    page.wait_for_function(f"AppState.mapData.town === '{town}'", timeout=60000)


def place(page, tool, x, y):
    """Place an actor by driving the same code path a map click would."""
    page.evaluate(f"AppState.set({{activeTool: '{tool}'}})")
    page.evaluate(f"""() => {{
        const svg = document.getElementById('map-svg');
        const pt = svg.createSVGPoint(); pt.x = {x}; pt.y = {y};
        const m = document.getElementById('world').getScreenCTM();
        const s = pt.matrixTransform(m);
        svg.dispatchEvent(new MouseEvent('click',
            {{clientX: s.x, clientY: s.y, bubbles: true}}));
    }}""")


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1600, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console.error: " + m.text)
            if m.type == "error" else None)

    page.goto(BASE, wait_until="networkidle")
    page.evaluate("document.getElementById('welcome-overlay')?.classList.add('hidden')")
    check("no JS errors on load", not errors, str(errors[:3]))

    # ── Render payload carries elevation ─────────────────────────────────────
    load_map(page, "Town03")

    check("map payload reports an elevation range",
          page.evaluate("!!AppState.mapData.elevation"))
    ev = page.evaluate("AppState.mapData.elevation")
    check("Town03 range covers the elevated deck",
          ev["max"] > 8.0 and ev["min"] < 0.0, str(ev))

    dims = page.evaluate("""() => {
        const lens = new Set();
        for (const r of AppState.mapData.roads)
            for (const l of r.lanes)
                for (const pt of (l.directionLine || [])) lens.add(pt.length);
        return [...lens];
    }""")
    check("every directionLine point is [x,y,z,s]", dims == [4], str(dims))

    cl = page.evaluate("""() => {
        const lens = new Set();
        for (const r of AppState.mapData.roads)
            for (const pt of r.centerline) lens.add(pt.length);
        return [...lens];
    }""")
    check("every centerline point is [x,y,z,s]", cl == [4], str(cl))

    check("spawn points carry z",
          page.evaluate("AppState.mapData.spawnPoints.every(s => typeof s.z === 'number')"))
    check("some Town03 spawn points sit on the elevated deck",
          page.evaluate("AppState.mapData.spawnPoints.some(s => s.z > 7.0)"))

    # ── groundZAt reads the surface, not a constant ──────────────────────────
    hi = page.evaluate(f"ObjectsManager.groundZAt({T3_HIGH[0]}, {T3_HIGH[1]})")
    lo = page.evaluate(f"ObjectsManager.groundZAt({T3_LOW[0]}, {T3_LOW[1]})")
    check("groundZAt on the rise reads ~2.6 m", abs(hi - 2.63) < 0.35, f"got {hi}")
    check("groundZAt at the far end reads ~0 m", abs(lo) < 0.35, f"got {lo}")
    check("the two ends of one road differ by metres", hi - lo > 2.0,
          f"{hi} vs {lo}")

    far = page.evaluate("ObjectsManager.groundZAt(100000, 100000)")
    check("groundZAt falls back to 0 with no road in reach", far == 0, f"got {far}")

    # ── Placement on a gradient ──────────────────────────────────────────────
    place(page, "ego", *T3_HIGH)
    ego = page.evaluate("AppState.ego")
    check("ego was placed", ego is not None)
    check("EGO IS ON THE ROAD, NOT UNDER IT",
          ego and ego["z"] > 2.0, f"z={ego and ego['z']}")
    surf = page.evaluate(f"ObjectsManager.groundZAt({ego['x']}, {ego['y']})")
    check("ego z is surface + vehicle clearance",
          abs(ego["z"] - (surf + VEHICLE_CLEARANCE)) < 0.02,
          f"z={ego['z']} surface={surf}")

    place(page, "pedestrian", T3_HIGH[0], T3_HIGH[1] + 6)
    ped = page.evaluate("AppState.npcs[AppState.npcs.length-1]")
    surf = page.evaluate(f"ObjectsManager.groundZAt({ped['x']}, {ped['y']})")
    check("pedestrian gets the larger VRU clearance",
          abs(ped["z"] - (surf + VRU_CLEARANCE)) < 0.02,
          f"z={ped['z']} surface={surf}")
    check("VRU clearance exceeds vehicle clearance", VRU_CLEARANCE > VEHICLE_CLEARANCE)

    # ── Drag re-derives z ────────────────────────────────────────────────────
    # Down the same road, from the 2.6 m rise to the flat far end.
    z_before = page.evaluate("AppState.ego.z")
    page.evaluate(f"""() => {{
        const svg = document.getElementById('map-svg');
        const g = document.querySelector('#layer-actors .actor-group[data-id="{ego['id']}"]');
        const m = document.getElementById('world').getScreenCTM();
        const at = (wx, wy) => {{
            const pt = svg.createSVGPoint(); pt.x = wx; pt.y = wy;
            return pt.matrixTransform(m);
        }};
        const a = at({ego['x']}, {ego['y']}), b = at({T3_LOW[0]}, {T3_LOW[1]});
        g.dispatchEvent(new MouseEvent('mousedown',
            {{clientX: a.x, clientY: a.y, bubbles: true, button: 0}}));
        window.dispatchEvent(new MouseEvent('mousemove',
            {{clientX: b.x, clientY: b.y, bubbles: true}}));
        window.dispatchEvent(new MouseEvent('mouseup', {{bubbles: true}}));
    }}""")
    moved = page.evaluate("AppState.ego")
    check("the drag moved the ego", abs(moved["x"] - T3_LOW[0]) < 3.0,
          f"x={moved['x']}")
    check("DRAG RE-DERIVED Z", abs(moved["z"] - z_before) > 1.5,
          f"{z_before} -> {moved['z']}")
    surf = page.evaluate(f"ObjectsManager.groundZAt({moved['x']}, {moved['y']})")
    check("dropped z is the new surface + clearance",
          abs(moved["z"] - (surf + VEHICLE_CLEARANCE)) < 0.02,
          f"z={moved['z']} surface={surf}")

    # ── Manual X/Y edit re-derives; manual Z does not get clobbered ──────────
    page.evaluate(f"AppState.select('{ego['id']}')")
    page.fill("#prop-x", str(T3_HIGH[0]))
    page.dispatch_event("#prop-x", "change")
    z_after_x = page.evaluate("AppState.ego.z")
    check("typing a new X re-derives z", z_after_x > 2.0, f"got {z_after_x}")

    page.fill("#prop-z", "9.75")
    page.dispatch_event("#prop-z", "change")
    check("a hand-typed z is kept as-is",
          abs(page.evaluate("AppState.ego.z") - 9.75) < 1e-9,
          str(page.evaluate("AppState.ego.z")))

    # ── Props: catalogue z is an offset, no clearance ────────────────────────
    page.click('[data-toolbar-tab="props"]')
    page.evaluate("AppState.set({activeTool: 'prop', pendingProp: 'static.prop.constructioncone'})")
    page.evaluate(f"""() => {{
        const svg = document.getElementById('map-svg');
        const pt = svg.createSVGPoint(); pt.x = {T3_HIGH[0]}; pt.y = {T3_HIGH[1] + 4};
        const s = pt.matrixTransform(document.getElementById('world').getScreenCTM());
        svg.dispatchEvent(new MouseEvent('click',
            {{clientX: s.x, clientY: s.y, bubbles: true}}));
    }}""")
    cone = page.evaluate("AppState.staticObjects[AppState.staticObjects.length-1]")
    surf = page.evaluate(f"ObjectsManager.groundZAt({cone['x']}, {cone['y']})")
    check("cone placed on the rise, not at 0",
          cone["z"] > 2.0, f"z={cone['z']}")
    check("prop z is the bare surface + its catalogue offset (no clearance)",
          abs(cone["z"] - surf) < 0.02, f"z={cone['z']} surface={surf}")

    # ── Waypoints and trigger points ─────────────────────────────────────────
    # The ego's path now lives inside a follow_trajectory event, exactly like
    # an NPC's — drive the same "Follow trajectory" button an NPC's would use.
    # Ego is still selected from the manual-Z edit above.
    page.click('#event-action-grid .event-action-button:has-text("Follow trajectory")')
    page.evaluate(f"""() => {{
        const svg = document.getElementById('map-svg');
        const m = document.getElementById('world').getScreenCTM();
        for (const [wx, wy] of [[120, 193.2], [60, 193.3]]) {{
            const pt = svg.createSVGPoint(); pt.x = wx; pt.y = wy;
            const s = pt.matrixTransform(m);
            svg.dispatchEvent(new MouseEvent('click',
                {{clientX: s.x, clientY: s.y, bubbles: true}}));
        }}
    }}""")
    traj = page.evaluate("AppState.ego.events[0].action.trajectory")
    check("trajectory points were added", len(traj) >= 3, str(len(traj)))
    check("every trajectory point carries a z",
          all(isinstance(w.get("z"), (int, float)) for w in traj), str(traj))
    drawn = traj[1:]
    check("waypoints follow the road down the gradient",
          all(w["z"] > 0.4 for w in drawn) and drawn[0]["z"] > drawn[-1]["z"],
          str([w["z"] for w in drawn]))

    # ── Flat map: only the clearance shows ───────────────────────────────────
    page.evaluate("AppState.loadJSON({map:'Town01', ego:null, npcs:[], staticObjects:[]})")
    load_map(page, "Town01")
    check("Town01 reports as flat",
          page.evaluate("AppState.mapData.elevation.max") == 0.0)
    check("Town01 spawn points are all at z=0",
          page.evaluate("AppState.mapData.spawnPoints.every(s => s.z === 0)"))

    place(page, "ego", 92.0, 23.0)
    z = page.evaluate("AppState.ego.z")
    check("flat-map vehicle sits at exactly the clearance",
          abs(z - VEHICLE_CLEARANCE) < 0.02, f"got {z}")

    place(page, "pedestrian", 92.0, 30.0)
    z = page.evaluate("AppState.npcs[AppState.npcs.length-1].z")
    check("flat-map VRU sits at exactly the VRU clearance",
          abs(z - VRU_CLEARANCE) < 0.02, f"got {z}")

    # ── The derived z survives into the save file ────────────────────────────
    page.evaluate("AppState.loadJSON({map:'Town03', ego:null, npcs:[], staticObjects:[]})")
    load_map(page, "Town03")
    place(page, "ego", *T3_HIGH)
    place(page, "car", T3_HIGH[0] - 20, T3_HIGH[1])
    saved = page.evaluate("AppState.toJSON()")
    check("save file keeps the derived ego z", saved["ego"]["z"] > 2.0,
          str(saved["ego"]["z"]))
    check("save file keeps the derived npc z",
          all(n["z"] > 1.0 for n in saved["npcs"]), str([n["z"] for n in saved["npcs"]]))

    check("no unexpected JS errors during the run",
          not [e for e in errors if "favicon" not in e], str(errors[:3]))
    b.close()

for name, ok, extra in checks:
    print(f"  {'PASS' if ok else 'FAIL'}    {name}" + (f"   [{extra}]" if not ok else ""))
print(f"\n{len(checks) - len(fails)}/{len(checks)} passed")
sys.exit(1 if fails else 0)
