"""Per-prop-type yaw rules, tested on a real two-way road in Town01.

Road 8 runs north-south with driving lanes on both sides:
    lane -1  centre (396.30, 164.24)  laneYaw  -90.0   (travels -Y)
    lane +1  centre (392.30, 165.24)  laneYaw  +90.0   (travels +Y)
Exactly 180 apart, which is the property the whole feature depends on.
"""
import os
from playwright.sync_api import sync_playwright
import math, sys

BASE = os.environ.get("EDITOR_URL", "http://localhost:9090")

LANE_R = (396.30, 164.24, -90.0)   # laneId -1
LANE_L = (392.30, 165.24, +90.0)   # laneId +1
FAR    = (157.0, 262.0)            # 60.7 m from any lane

checks, fails = [], []
def check(name, cond, extra=""):
    checks.append((name, bool(cond), extra))
    if not cond:
        fails.append(name)

def wrap(d):
    return ((d + 180) % 360 + 360) % 360 - 180

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1600, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE, wait_until="networkidle")
    page.evaluate("document.getElementById('welcome-overlay')?.classList.add('hidden')")
    page.select_option("#map-select", "Town01")
    page.wait_for_function("AppState.mapData !== null", timeout=60000)

    W2S = """([wx,wy])=>{
        const svg=document.getElementById('map-svg');
        const g=document.getElementById('world');
        const pt=svg.createSVGPoint(); pt.x=wx; pt.y=wy;
        const s=pt.matrixTransform(g.getScreenCTM());
        return [s.x, s.y];
    }"""

    # Zoom in on the test road so a 4 m lane separation is many pixels wide.
    sx, sy = page.evaluate(W2S, [LANE_R[0], LANE_R[1]])
    page.mouse.move(sx, sy)
    for _ in range(16):
        page.mouse.wheel(0, -240)
    page.wait_for_timeout(400)

    def place(prop_id, wx, wy, shift=False):
        """Arm a prop, click at a WORLD point, return the placed object.

        Guards that the target is actually on screen — Playwright silently
        clamps out-of-viewport clicks, which otherwise places the prop
        somewhere else entirely and produces a bogus pass/fail.
        """
        page.click(f'.tool-btn[data-prop="{prop_id}"]')
        s = page.evaluate(W2S, [wx, wy])
        vw, vh = 1600, 900
        if not (0 <= s[0] <= vw and 0 <= s[1] <= vh):
            raise AssertionError(
                f"world ({wx},{wy}) maps to off-screen {s}; zoom/pan first")
        if shift:
            page.keyboard.down("Shift")
        page.mouse.click(s[0], s[1])
        if shift:
            page.keyboard.up("Shift")
        page.keyboard.press("Escape")
        o = page.evaluate("AppState.staticObjects[AppState.staticObjects.length-1]")
        # confirm it landed near where we aimed (free placement only)
        if not shift and (abs(o["x"] - wx) > 1.5 or abs(o["y"] - wy) > 1.5):
            raise AssertionError(
                f"click landed at ({o['x']},{o['y']}), aimed at ({wx},{wy})")
        return o

    page.click('[data-toolbar-tab="props"]')

    # ── 1. streetbarrier ('oncoming') on each carriageway ────────────────────
    bR = place("static.prop.streetbarrier", LANE_R[0], LANE_R[1])
    bL = place("static.prop.streetbarrier", LANE_L[0], LANE_L[1])
    check("barrier on lane -1 faces oncoming (expect ~90)",
          abs(wrap(bR["yaw"] - 90)) <= 2, f"got {bR['yaw']}")
    check("barrier on lane +1 faces oncoming (expect ~-90)",
          abs(wrap(bL["yaw"] - (-90))) <= 2, f"got {bL['yaw']}")
    sep = abs(wrap(bR["yaw"] - bL["yaw"]))
    check("BARRIERS ON OPPOSITE LANES ARE 180 APART",
          abs(sep - 180) <= 2, f"separation {sep:.1f}")

    # each must oppose ITS OWN lane, not the road's canonical direction
    check("barrier -1 opposes its own lane direction",
          abs(wrap(bR["yaw"] - (LANE_R[2] + 180))) <= 2, f"{bR['yaw']} vs {wrap(LANE_R[2]+180)}")
    check("barrier +1 opposes its own lane direction",
          abs(wrap(bL["yaw"] - (LANE_L[2] + 180))) <= 2, f"{bL['yaw']} vs {wrap(LANE_L[2]+180)}")

    # ── 2. warning sign ('oncoming') — same relation ─────────────────────────
    sR = place("static.prop.warningconstruction", LANE_R[0], LANE_R[1])
    sL = place("static.prop.warningconstruction", LANE_L[0], LANE_L[1])
    sep2 = abs(wrap(sR["yaw"] - sL["yaw"]))
    check("warning signs on opposite lanes are 180 apart",
          abs(sep2 - 180) <= 2, f"separation {sep2:.1f}")
    check("warning sign matches barrier on the same lane",
          abs(wrap(sR["yaw"] - bR["yaw"])) <= 2, f"{sR['yaw']} vs {bR['yaw']}")

    # ── 3. container ('alongside') — parallel to the kerb, either flip ───────
    # Placed OFF the centreline: on it, "which side of the lane" is degenerate.
    cR = place("static.prop.container", LANE_R[0] + 6.0, LANE_R[1])
    off = abs(wrap(cR["yaw"] - LANE_R[2]))
    check("container lies parallel to the lane (0 or 180 from laneYaw)",
          off <= 2 or abs(off - 180) <= 2, f"got {cR['yaw']}, laneYaw {LANE_R[2]}")
    check("container is 90 off the barrier (alongside vs oncoming)",
          abs(abs(wrap(cR["yaw"] - bR["yaw"])) - 90) > 2,
          f"{cR['yaw']} vs {bR['yaw']}")

    # ── 4. cone ('none') — always 0 regardless of lane ───────────────────────
    kR = place("static.prop.trafficcone01", LANE_R[0], LANE_R[1])
    kL = place("static.prop.trafficcone01", LANE_L[0], LANE_L[1])
    check("cone on lane -1 has yaw 0 (no rule)", kR["yaw"] == 0, f"got {kR['yaw']}")
    check("cone on lane +1 has yaw 0 (no rule)", kL["yaw"] == 0, f"got {kL['yaw']}")

    # ── 5. busstop ('alongside') — opening faces road on BOTH sides ──────────
    # Road 8 spans x ~390..398, so +X of it is east, -X is west.
    uE = place("static.prop.busstop", LANE_R[0] + 7.0, LANE_R[1])   # east of road
    uW = place("static.prop.busstop", LANE_L[0] - 7.0, LANE_L[1])   # west of road
    for tag, o, road_dir in (("east", uE, 180.0), ("west", uW, 0.0)):
        opening = wrap(o["yaw"] + 90)          # local +Y = open side
        off = abs(wrap(opening - road_dir))
        check(f"busstop {tag} of road: opening faces carriageway",
              off <= 90, f"opening {opening:.0f} vs road {road_dir:.0f} (off {off:.0f})")
    check("busstop stays parallel to the kerb on both sides",
          abs(abs(wrap(uE["yaw"] - uW["yaw"])) - 180) <= 2 or
          abs(wrap(uE["yaw"] - uW["yaw"])) <= 2,
          f"{uE['yaw']} vs {uW['yaw']}")

    # ── 6. free placement orients but does NOT move ──────────────────────────
    fx, fy = LANE_R[0] + 6.0, LANE_R[1] + 3.0
    fp = place("static.prop.streetbarrier", fx, fy, shift=False)
    check("free placement applies the yaw rule", fp["yaw"] != 0, f"got {fp['yaw']}")
    check("free placement does not snap position",
          abs(fp["x"] - fx) < 0.6 and abs(fp["y"] - fy) < 0.6,
          f"placed ({fp['x']},{fp['y']}) vs clicked ({fx},{fy})")

    # ── 7. Shift snaps position, keeps the same rule ─────────────────────────
    sp = place("static.prop.streetbarrier", fx, fy, shift=True)
    check("shift snaps position onto the lane",
          abs(sp["x"] - fx) > 0.6 or abs(sp["y"] - fy) > 0.6,
          f"placed ({sp['x']},{sp['y']}) vs clicked ({fx},{fy})")
    check("shift-snapped yaw still follows the rule",
          abs(wrap(sp["yaw"] - bR["yaw"])) <= 3, f"{sp['yaw']} vs {bR['yaw']}")

    # ── 8. far from any lane -> fallback 0 ───────────────────────────────────
    # Zoom back out until the control point is genuinely on screen; place()
    # refuses to click otherwise.
    page.mouse.move(800, 450)
    for _ in range(22):
        page.mouse.wheel(0, 240)
    page.wait_for_timeout(400)
    fs = page.evaluate(W2S, [FAR[0], FAR[1]])
    check("far control point is on screen before clicking",
          0 <= fs[0] <= 1600 and 0 <= fs[1] <= 900, f"screen {fs}")
    far = place("static.prop.streetbarrier", FAR[0], FAR[1])
    check("prop >25 m from any lane falls back to yaw 0",
          far["yaw"] == 0, f"got {far['yaw']} at ({far['x']},{far['y']})")

    # ── 9. manual rotation is not clobbered ──────────────────────────────────
    pid = bR["id"]
    page.evaluate(f"AppState.select('{pid}')")
    page.fill("#prop-yaw", "42")
    page.dispatch_event("#prop-yaw", "change")
    got = page.evaluate(f"AppState.findById('{pid}').yaw")
    check("manual yaw override sticks", abs(got - 42) < 0.001, f"got {got}")
    page.evaluate("MapView.renderAllActors()")
    got2 = page.evaluate(f"AppState.findById('{pid}').yaw")
    check("manual yaw survives a re-render", abs(got2 - 42) < 0.001, f"got {got2}")

    check("no JS errors", not errors, str(errors[:2]))
    b.close()

print()
for name, ok, extra in checks:
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   [{extra}]" if extra and not ok else ""))
print(f"\n{sum(1 for _,o,_ in checks if o)}/{len(checks)} passed")
sys.exit(1 if fails else 0)
