"""Path waypoints: lane snapping, the lane-following route line, and editing.

Three features that only exist together, because they all turn on the same
question — what is a waypoint, and what is the map actually telling you about
it?

  1. An `assign_route` waypoint is SNAPPED to the nearest driving-lane centre.
     It is never driven to as authored: AssignRouteAction hands it to
     GlobalRoutePlanner, which projects it with map.get_waypoint() and routes
     to whichever lane came out. A point between two lanes silently becomes one
     of them, and when that is the oncoming carriageway the vehicle drives away
     from the route and loops back (weirdLooping.xosc). A `follow_trajectory`
     vertex is deliberately NOT snapped — a trajectory is driven literally, and
     its whole purpose is going where lanes do not.

  2. The drawn route line is the LANE-FOLLOWING route (Simulate.routeGeometry →
     LaneGraph.route → the ChangeActorWaypoints filter), not the chords between
     the clicks. A chord crosses buildings and oncoming lanes the vehicle never
     touches.

  3. Waypoints are draggable and deletable, and the map and the event card
     always agree on which one is which (AppState.selectedWaypoint). A selected
     actor always shows its path, above the vehicles, whatever the card's
     Anzeigen/Ausblenden toggle says — that toggle can only govern the
     deselected appearance, since the card only exists while the actor is
     selected.

Needs a running editor (EDITOR_URL, default http://localhost:9090) and a town
with a committed lane_graph.json — Town03, as the other lane-graph suite uses.
"""
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import Checks, open_editor, assert_on_screen  # noqa: E402

# Town03 road 7, the same pose test_route_fidelity_e2e.py uses.
EGO = {"id": "obj-1", "type": "ego", "x": 110.51, "y": -3.33, "z": 0.62, "yaw": 180.9,
       "initial_speed": 10.0, "events": []}

SEED = ("(e) => { AppState.ego = e; AppState.npcs = []; AppState.staticObjects = []; "
        "AppState.set({}); AppState.select('obj-1'); }")

check = Checks()

with sync_playwright() as p:
    browser, page, errors = open_editor(p, town="Town03")
    check("no JS errors on load", not errors, str(errors[:3]))
    check("Town03 has a cached lane graph", page.evaluate("() => !!AppState.laneGraph"))

    page.evaluate(SEED, EGO)

    # ── A route waypoint snaps to the lane centre ────────────────────────────
    page.click('#event-action-grid .event-action-button:has-text("Route zuweisen")')
    seeded = page.evaluate("AppState.ego.events[0].action.waypoints")
    check("a fresh route event is seeded with one waypoint", len(seeded) == 1, str(seeded))

    # A click deliberately 2.5 m to the side of a lane centre.
    target = page.evaluate("""() => {
        const near = ObjectsManager.nearestLaneProjection(60, -4.5, new Set(['driving']), 30);
        return {laneY: near.y, offX: near.x, offY: near.y + 2.5};
    }""")
    sx, sy = assert_on_screen(page, target["offX"], target["offY"])
    page.mouse.click(sx, sy)
    wps = page.evaluate("AppState.ego.events[0].action.waypoints")
    check("the click added a second route waypoint", len(wps) == 2, str(len(wps)))
    check("...snapped onto the lane centre rather than the 2.5 m offset click",
          len(wps) == 2 and abs(wps[1]["y"] - target["laneY"]) < 0.6,
          f"{wps[-1]} lane_y={target['laneY']:.2f}")
    check("...and carries a derived z, not a flat default",
          len(wps) == 2 and isinstance(wps[1].get("z"), (int, float)), str(wps[-1]))
    page.click("#traj-done-btn")

    # ── The drawn line follows the lanes ─────────────────────────────────────
    geom = page.evaluate("""() => {
        const ev = AppState.ego.events.find(e => e.action.type === 'assign_route');
        const g = Simulate.routeGeometry(AppState.ego, ev);
        return g ? g.length : null;
    }""")
    check("Simulate.routeGeometry returns a lane-following point list",
          isinstance(geom, int) and geom > 5, str(geom))
    drawn = page.evaluate("""() => {
        const el = document.querySelector('.route-line');
        if (!el) return null;
        return {n: el.getAttribute('points').trim().split(/\\s+/).length,
                approx: el.classList.contains('route-line-approx')};
    }""")
    check("the drawn polyline has far more points than the 2 authored waypoints",
          drawn and drawn["n"] > 5, str(drawn))
    check("...and is not badged as the straight-chord fallback",
          drawn and not drawn["approx"], str(drawn))

    # ── Ausblenden hides outright; working on the path un-hides it ───────────
    ev_id = page.evaluate("AppState.ego.events[0].id")
    check("the selected actor's path is drawn in the layer above the vehicles",
          page.evaluate("() => !!document.querySelector('#layer-paths-top .route-line')"))
    page.evaluate("(id) => MapView.toggleRouteVisibility('obj-1', id)", ev_id)
    check("Ausblenden hides the path even while its actor IS selected",
          page.evaluate("() => !document.querySelector('.route-line')"))
    page.evaluate("AppState.select(null)")
    check("...and stays hidden once deselected",
          page.evaluate("() => !document.querySelector('.route-line')"))

    # Marking a waypoint from the card un-hides the path for good — a mark on
    # something invisible is a mark on nothing, and Entf would then delete a
    # point with no visible consequence.
    page.evaluate("AppState.select('obj-1')")
    page.evaluate("""(id) => AppState.selectWaypoint(
        {actorId: 'obj-1', eventId: id, pathType: 'route', index: 1})""", ev_id)
    check("marking a waypoint un-hides its path",
          page.evaluate("() => !!document.querySelector('.route-line')"))
    check("...by flipping the stored toggle, not overriding it",
          page.evaluate("(id) => MapView.isRouteVisible('obj-1', id)", ev_id) is True)

    # Drawing does the same, which is the other way back from a hidden path.
    page.evaluate("(id) => MapView.toggleRouteVisibility('obj-1', id)", ev_id)
    check("hidden again", page.evaluate("() => !document.querySelector('.route-line')"))
    page.evaluate("(id) => ObjectsManager.startPathMode('obj-1', 'route', id)", ev_id)
    check("starting a draw un-hides the path being drawn into",
          page.evaluate("(id) => MapView.isRouteVisible('obj-1', id)", ev_id) is True)
    page.click("#traj-done-btn")

    # ── No direction arrows anywhere ─────────────────────────────────────────
    check("paths carry no direction-arrow markers",
          page.evaluate("""() => ![...document.querySelectorAll(
              '.route-line, .traj-line, .route-arrows')]
                  .some(el => el.getAttribute('marker-mid'))"""))
    check("...and the per-path <marker> defs are gone with them",
          page.evaluate("() => !document.querySelector('marker[id^=\"arrow-traj\"]')"))

    # ── The route line is static while the preview runs ──────────────────────
    # Leg 0 is seeded from the actor's own position, and the preview rewrites
    # that every tick — so computing the drawn route off the live pose made the
    # line crawl along under the moving vehicle, redrawn every frame. A
    # follow_trajectory line is the authored vertices and never moved; a route
    # has no business moving either.
    page.evaluate("AppState.select('obj-1')")
    line_of = """() => document.querySelector('.route-line')?.getAttribute('points')"""
    before_run = page.evaluate(line_of)
    check("the route line is on screen before Play", bool(before_run))
    page.click("#sim-play")
    page.wait_for_timeout(700)
    moved = page.evaluate("({x: AppState.ego.x, y: AppState.ego.y})")
    during = page.evaluate(line_of)
    check("the previewed ego really moved", abs(moved["x"] - EGO["x"]) > 1.0, str(moved))
    check("...while the drawn route stayed exactly where it was",
          during == before_run,
          f"{str(during)[:70]!r} vs {str(before_run)[:70]!r}")
    page.wait_for_timeout(600)
    check("...and still, a second later", page.evaluate(line_of) == before_run)
    page.click("#sim-stop")
    page.wait_for_timeout(200)
    check("...and is unchanged after Stop restores the pose",
          page.evaluate(line_of) == before_run)
    # Play deselects (_startSimulation calls AppState.select(null)), and only a
    # selected actor's waypoints are hit-testable.
    page.evaluate("AppState.select('obj-1')")

    # ── Dragging a route waypoint ────────────────────────────────────────────
    before = page.evaluate("AppState.ego.events[0].action.waypoints[1]")
    sx, sy = assert_on_screen(page, before["x"], before["y"])
    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.move(sx + 40, sy + 6, steps=8)
    page.mouse.up()
    after = page.evaluate("AppState.ego.events[0].action.waypoints[1]")
    check("dragging a waypoint marker moves it", abs(after["x"] - before["x"]) > 1.0,
          f"{before} -> {after}")
    mark = page.evaluate("AppState.selectedWaypoint")
    check("...and the drag marks the point it moved",
          bool(mark) and mark["index"] == 1 and mark["actorId"] == "obj-1", str(mark))
    check("...without deselecting the actor the waypoint belongs to",
          page.evaluate("AppState.selectedId") == "obj-1")
    check("...and the matching event-card row is highlighted",
          page.evaluate("""() => document.querySelector(
              '.waypoint-item.waypoint-selected')?.dataset.wpIdx""") == "1")
    check("...and the marked waypoint wears the app-wide four-corner marks",
          page.evaluate("""() => {
              const m = document.querySelector(
                  '.path-waypoint.waypoint-marked .actor-select-marks');
              return !!m && m.querySelectorAll('.sel-mark-line').length === 4
                         && m.querySelectorAll('.sel-mark-casing').length === 4;
          }"""))
    lane_dist = page.evaluate("""() => {
        const w = AppState.ego.events[0].action.waypoints[1];
        const n = ObjectsManager.nearestLaneProjection(
            w.x, w.y, new Set(['driving', 'bidirectional']), 30);
        return n ? Math.hypot(n.x - w.x, n.y - w.y) : null;
    }""")
    check("a DRAGGED route waypoint re-snaps to a lane centre too",
          lane_dist is not None and lane_dist < 0.4, str(lane_dist))

    # ── The selected vehicle stays on top of its own path ────────────────────
    # Waypoint 1 is seeded on the actor's own pose, so without the actor layer
    # above the path layer the marker sits squarely on the vehicle: it hides it,
    # and a grab there drags a waypoint instead of the car.
    check("the selected actor is drawn above its own path", page.evaluate("""() => {
        const ids = [...document.getElementById('world').children].map(g => g.id);
        return ids.indexOf('layer-actors-top') > ids.indexOf('layer-paths-top');
    }"""))
    check("...and the selected actor really is in that layer",
          page.evaluate("() => !!document.querySelector('#layer-actors-top .actor-group')"))

    ego_before = page.evaluate("({x: AppState.ego.x, y: AppState.ego.y, yaw: AppState.ego.yaw})")
    sx, sy = assert_on_screen(page, ego_before["x"], ego_before["y"])
    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.move(sx, sy + 25, steps=8)
    page.mouse.up()
    ego_after = page.evaluate("({x: AppState.ego.x, y: AppState.ego.y})")
    check("grabbing the selected vehicle where waypoint 1 sits still MOVES the car",
          abs(ego_after["y"] - ego_before["y"]) > 1.0, f"{ego_before} -> {ego_after}")
    check("...rather than dragging waypoint 1 out from under it",
          abs(page.evaluate("AppState.ego.events[0].action.waypoints[0].y") - ego_before["y"]) < 0.2,
          str(page.evaluate("AppState.ego.events[0].action.waypoints[0]")))

    handle = page.evaluate("""() => {
        const h = document.querySelector('#layer-actors-top .yaw-handle');
        if (!h) return null;
        const r = h.getBoundingClientRect();
        return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    }""")
    check("the selected vehicle's rotate handle is reachable in the top layer",
          handle is not None, str(handle))
    if handle:
        page.mouse.move(handle["x"], handle["y"])
        page.mouse.down()
        page.mouse.move(handle["x"], handle["y"] + 45, steps=8)
        page.mouse.up()
        check("...and dragging it still ROTATES the car",
              abs(page.evaluate("AppState.ego.yaw") - ego_before["yaw"]) > 5,
              f"{ego_before['yaw']} -> {page.evaluate('AppState.ego.yaw')}")

    # ── The card's row locates the point, Backspace deletes it ───────────────
    page.evaluate("AppState.selectWaypoint(null)")
    page.click('.waypoint-item[data-wp-idx="0"]')
    mark = page.evaluate("AppState.selectedWaypoint")
    check("clicking a waypoint row marks that waypoint",
          bool(mark) and mark["index"] == 0, str(mark))

    n_before = page.evaluate("AppState.ego.events[0].action.waypoints.length")
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Backspace")
    check("Backspace on a marked waypoint deletes it with no confirm",
          page.evaluate("AppState.ego.events[0].action.waypoints.length") == n_before - 1,
          str(n_before))
    check("...and takes the waypoint, never the actor", page.evaluate("!!AppState.ego"))
    check("...opening no confirm dialog", page.evaluate("() => !window.Confirm.isOpen"))

    page.evaluate("""(id) => {
        AppState.selectWaypoint({actorId: 'obj-1', eventId: id, pathType: 'route', index: 0});
        AppState.select(null);
    }""", ev_id)
    check("deselecting the actor clears its waypoint mark",
          page.evaluate("AppState.selectedWaypoint") is None)

    # ── A trajectory vertex is free, and keeps its own semantics ─────────────
    page.evaluate(SEED, EGO)
    page.click('#event-action-grid .event-action-button:has-text("Trajektorie folgen")')
    off = page.evaluate("""() => {
        const n = ObjectsManager.nearestLaneProjection(60, -4.5, new Set(['driving']), 30);
        return {offX: n.x, offY: n.y + 3.0, laneY: n.y};
    }""")
    sx, sy = assert_on_screen(page, off["offX"], off["offY"])
    page.mouse.click(sx, sy)
    page.click("#traj-done-btn")
    traj = page.evaluate("AppState.ego.events[0].action.trajectory")
    # The click itself quantises to ~0.4 m/px at town zoom, so what matters is
    # that the vertex was NOT pulled onto the lane centre 3 m away.
    check("a trajectory vertex is not snapped to the lane centre",
          abs(traj[1]["y"] - off["laneY"]) > 2.0, f"{traj[1]} lane_y={off['laneY']:.2f}")

    before = dict(traj[1])
    sx, sy = assert_on_screen(page, before["x"], before["y"])
    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.move(sx + 30, sy + 30, steps=10)
    page.mouse.up()
    after = page.evaluate("AppState.ego.events[0].action.trajectory[1]")
    check("dragging a trajectory vertex moves it freely",
          abs(after["x"] - before["x"]) > 1.0 and abs(after["y"] - before["y"]) > 1.0,
          f"{before} -> {after}")
    expect_z = page.evaluate(
        "(p) => Math.round((ObjectsManager.groundZAt(p.x, p.y) + 0.5) * 100) / 100", after)
    check("...with its z re-derived from the elevation profile on drop",
          abs(after["z"] - expect_z) < 0.011, f"z={after['z']} expected={expect_z}")
    check("...and its per-vertex velocity untouched",
          after.get("velocity") == before.get("velocity"),
          f"{before.get('velocity')} -> {after.get('velocity')}")

    # ── Undo covers both, at the right granularity ───────────────────────────
    page.keyboard.press("Control+z")
    undone = page.evaluate("AppState.ego.events[0].action.trajectory[1]")
    check("one Strg+Z reverts the whole drag — position and height together",
          abs(undone["x"] - before["x"]) < 0.2 and abs(undone["y"] - before["y"]) < 0.2
          and abs(undone["z"] - before["z"]) < 0.02, f"{undone} vs {before}")

    page.evaluate("""() => AppState.selectWaypoint({
        actorId: 'obj-1', eventId: AppState.ego.events[0].id,
        pathType: 'trajectory', index: 1})""")
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Backspace")
    check("Backspace deletes a trajectory vertex too",
          page.evaluate("AppState.ego.events[0].action.trajectory.length") == 1)
    page.keyboard.press("Control+z")
    check("...and Strg+Z brings it back",
          page.evaluate("AppState.ego.events[0].action.trajectory.length") == 2)

    # ── Only the selected actor's waypoints are reachable ────────────────────
    page.evaluate("AppState.select(null)")
    inert = page.evaluate("""() => {
        const els = [...document.querySelectorAll('.path-waypoint')];
        return els.length ? els.every(e => getComputedStyle(e).pointerEvents === 'none') : null;
    }""")
    check("an unselected actor's waypoints are not hit-testable", inert is True, str(inert))

    check("no unexpected JS errors during the run", not errors, str(errors[:5]))
    browser.close()

sys.exit(check.report())
