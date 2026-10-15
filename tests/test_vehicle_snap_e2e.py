"""Vehicle lane snap: placing or dragging a vehicle puts it on a lane centre,
facing the lane's travel direction; Shift places / drags it freely.

Before this, placement snapped to the nearest *spawn point* within 12 m (a
discrete sample, so a car could land metres from the click), and a drag did not
snap at all — the car kept its old yaw wherever it was dropped, across lanes and
onto the verge.

Town01 road 1 runs east-west and is two-way: lane -1 at y = -2.03 drives west
(yaw 180), lane 1 at y = +1.97 drives east (yaw 0). Everything below happens
around x = 250 on it, zoomed in so a click resolves to a few cm.

Walkers are deliberately NOT snapped (they belong on kerbs and crossings) and
are checked to stay free.
"""

import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from _harness import Checks, open_editor, assert_on_screen, zoom_at  # noqa: E402

check = Checks()

LANE_W_Y, LANE_E_Y = -2.03, 1.97  # Town01 road 1, lanes -1 and 1
CX = 250.0


def yaw_diff(a, b):
    return abs(((a - b + 180) % 360) - 180)


def pose(page, aid):
    return page.evaluate(
        "(id) => { const a = AppState.findById(id); return {x: a.x, y: a.y, z: a.z, yaw: a.yaw}; }", aid
    )


def place(page, tool, wx, wy, shift=False):
    page.click('[data-toolbar-tab="actors"]')
    page.click(f'.tool-btn[data-tool="{tool}"]')
    sx, sy = assert_on_screen(page, wx, wy)
    if shift:
        page.keyboard.down("Shift")
    page.mouse.click(sx, sy)
    if shift:
        page.keyboard.up("Shift")
    page.wait_for_timeout(200)
    return page.evaluate("AppState.selectedId")


def drag(page, aid, to_wx, to_wy, shift=False, steps=10):
    """Grab the actor at its own centre and drop its centre at (to_wx, to_wy)."""
    a = pose(page, aid)
    sx, sy = assert_on_screen(page, a["x"], a["y"])
    tx, ty = assert_on_screen(page, to_wx, to_wy)
    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.mouse.move(sx, sy)
    page.mouse.down()
    if shift:
        page.keyboard.down("Shift")
    for i in range(1, steps + 1):
        page.mouse.move(sx + (tx - sx) * i / steps, sy + (ty - sy) * i / steps)
        page.wait_for_timeout(15)
    if shift:
        page.keyboard.up("Shift")
    page.mouse.up()
    page.wait_for_timeout(300)
    return pose(page, aid)


def grab_is_body(page, aid):
    """The yaw handle sits outside the body, so grabbing the centre is a move."""
    a = pose(page, aid)
    sx, sy = assert_on_screen(page, a["x"], a["y"])
    return page.evaluate(
        "([x, y]) => { const e = document.elementFromPoint(x, y);"
        "  return !!e && !!e.closest('.actor-group') && !e.closest('.yaw-handle'); }",
        [sx, sy],
    )


with sync_playwright() as p:
    browser, page, errors = open_editor(p, "Town01")
    zoom_at(page, CX, 0.0, 14)

    # ── Placement ────────────────────────────────────────────────────────────
    ego = place(page, "ego", CX + 8, LANE_W_Y - 1.2)
    a = pose(page, ego)
    check("placement: a vehicle lands on the lane centre, not the click", abs(a["y"] - LANE_W_Y) < 0.15, str(a))
    check(
        "placement: ...at the click's position along the lane (no spawn-point jump)",
        abs(a["x"] - (CX + 8)) < 0.6,
        str(a),
    )
    check("placement: ...facing the lane's travel direction", yaw_diff(a["yaw"], 180) < 2, str(a))
    check("placement: ...at the lane's height plus clearance", abs(a["z"] - 0.5) < 0.02, str(a))

    car = place(page, "car", CX - 12, LANE_E_Y + 1.0)
    a = pose(page, car)
    check(
        "placement: the other carriageway faces the other way",
        abs(a["y"] - LANE_E_Y) < 0.15 and yaw_diff(a["yaw"], 0) < 2,
        str(a),
    )

    free = place(page, "van", CX - 30, LANE_E_Y + 0.9, shift=True)
    a = pose(page, free)
    check(
        "Shift-placement: the vehicle stays at the click",
        abs(a["y"] - (LANE_E_Y + 0.9)) < 0.3 and abs(a["x"] - (CX - 30)) < 0.3,
        str(a),
    )
    check(
        "Shift-placement: ...but still faces along the road, not due east by default",
        min(yaw_diff(a["yaw"], 0), yaw_diff(a["yaw"], 180)) < 2,
        str(a),
    )

    # ── Drag ─────────────────────────────────────────────────────────────────
    page.evaluate(f"AppState.select('{car}')")
    check("grabbing the centre of a car hits its body, not the yaw handle", grab_is_body(page, car))

    a = drag(page, car, CX - 4, LANE_E_Y + 1.3)
    check(
        "drag along: stays on the lane centre despite an off-centre drop",
        abs(a["y"] - LANE_E_Y) < 0.15 and abs(a["x"] - (CX - 4)) < 0.6,
        str(a),
    )
    check("drag along: keeps the lane's direction", yaw_diff(a["yaw"], 0) < 2, str(a))

    d0 = page.evaluate("UndoStack.length")
    before = pose(page, car)
    a = drag(page, car, CX - 4, LANE_W_Y - 0.8)
    check("drag across: snaps onto the opposite lane's centre", abs(a["y"] - LANE_W_Y) < 0.15, str(a))
    check("drag across: turns to that lane's travel direction", yaw_diff(a["yaw"], 180) < 2, str(a))
    check("drag across: z re-derived from the snapped lane", abs(a["z"] - 0.5) < 0.02, str(a))
    check(
        "a snapped drag is ONE undo entry",
        page.evaluate("UndoStack.length") - d0 == 1,
        f"{d0} -> {page.evaluate('UndoStack.length')}",
    )
    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(250)
    u = pose(page, car)
    check(
        "one Strg+Z restores position AND yaw",
        abs(u["x"] - before["x"]) < 0.05
        and abs(u["y"] - before["y"]) < 0.05
        and yaw_diff(u["yaw"], before["yaw"]) < 0.1,
        f"{before} vs {u}",
    )

    before = pose(page, car)
    a = drag(page, car, CX - 6, LANE_E_Y + 1.1, shift=True)
    check(
        "Shift-drag: the vehicle follows the cursor off the centreline",
        abs(a["y"] - (LANE_E_Y + 1.1)) < 0.3 and abs(a["x"] - (CX - 6)) < 0.3,
        str(a),
    )
    check("Shift-drag: the yaw is left alone", yaw_diff(a["yaw"], before["yaw"]) < 0.1, f"{before} vs {a}")

    # ── Walkers are not snapped ──────────────────────────────────────────────
    ped = place(page, "pedestrian", CX + 20, LANE_E_Y + 4.5)
    pb = pose(page, ped)
    a = drag(page, ped, CX + 24, LANE_E_Y + 0.8)
    check(
        "a walker drags freely (no lane snap)",
        abs(a["y"] - (LANE_E_Y + 0.8)) < 0.3 and abs(a["x"] - (CX + 24)) < 0.3,
        str(a),
    )
    check("...and keeps its yaw", yaw_diff(a["yaw"], pb["yaw"]) < 0.1, f"{pb} vs {a}")

    # ── Junctions: overlapping connectors resolve by the current heading ────
    # Find every spot where two driving connectors of one junction pass within
    # 0.5 m of each other at headings > 30° apart. At such a spot "nearest"
    # is a coin toss; given either connector's heading as the previous yaw, the
    # snap must stay on that connector — i.e. dragging a car through a junction
    # does not spin it onto the crossing one.
    res = page.evaluate("""() => {
        const d = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
        const byJ = new Map();
        for (const road of AppState.mapData.roads) {
          if (road.junction === -1 || road.junction == null) continue;
          for (const lane of road.lanes) {
            const L = lane.directionLine || [];
            if (lane.type !== 'driving' || L.length < 2) continue;
            const pts = [];
            for (let i = 1; i < L.length; i++) {
              pts.push({x: (L[i-1][0] + L[i][0]) / 2, y: (L[i-1][1] + L[i][1]) / 2,
                        h: Math.atan2(L[i][1] - L[i-1][1], L[i][0] - L[i-1][0]) * 180 / Math.PI});
            }
            if (!byJ.has(road.junction)) byJ.set(road.junction, []);
            byJ.get(road.junction).push(pts);
          }
        }
        let total = 0, kept = 0, keptNoHint = 0;
        for (const lanes of byJ.values()) {
          for (let a = 0; a < lanes.length; a++) for (let b = 0; b < lanes.length; b++) {
            if (a === b) continue;
            for (const p of lanes[a]) {
              const q = lanes[b].find(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.5 && d(q.h, p.h) > 30);
              if (!q) continue;
              // Halfway between the two: both are equally "nearest".
              const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
              total++;
              const s = ObjectsManager.vehicleLaneSnap(mx, my, p.h);
              const n = ObjectsManager.vehicleLaneSnap(mx, my);
              if (s && d(s.yaw, p.h) < 15) kept++;
              if (n && d(n.yaw, p.h) < 15) keptNoHint++;
            }
          }
        }
        return {total, kept, keptNoHint};
    }""")
    check("Town01 has overlapping junction connectors to test on", res["total"] > 20, str(res))
    check(
        "dragging through a junction keeps the connector being followed (>= 95%)",
        res["kept"] >= 0.95 * res["total"],
        str(res),
    )
    print(
        f"  info    junction tie-break: {res['kept']}/{res['total']} with the heading hint, "
        f"{res['keptNoHint']}/{res['total']} nearest-only"
    )

    check("no unexpected JS errors during the run", not errors, str(errors[:5]))
    browser.close()

sys.exit(check.report())
