"""Scenario templates: placement flow, pre-filled event chains, exported .xosc.

The templates are the least-covered part of the editor — none of the .xosc
fixtures in scenario_runner's scenario_tester/ carries a template's signature
chain, so until now they had never been checked beyond the UI.

Two layers here, and they catch different things:
  1. the event chain the template ATTACHES (templates.js data + objects.js
     _placeActor wiring). Pure UI, no export.
  2. the event chain that SURVIVES to the .xosc (buildScenarioParams ->
     validate_scenario_params -> event_builders). A template can be perfectly
     correct in the editor and still emit nothing usable.

The expectations below are written out literally rather than read back from
ScenarioTemplates — comparing the panel against itself would pass no matter
what the template data said.

    bash run.sh 9090            # terminal 1
    .venv/bin/python3 tests/test_templates_e2e.py
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _harness as H  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

check = H.Checks()

# (trigger_kind, trigger_arg, action_kind, action_arg, dynamics_value, dimension)
#   trigger_arg: metres for distance_to_ego, referenced event id for after_event
#   action_arg : target speed for set_speed, direction for lane_change
#   dimension  : 'time' -> dynamics_value is a hold in seconds
#                'rate' -> dynamics_value is m/s2 and the event ends on arrival
#                None   -> lane_change, which has no dimension
# ANY marks a value a template computes from the road at the click (a
# crossing's hold is the crossing length over the walking speed), so the
# suite pins its presence and plausibility rather than one town's number.
ANY = object()
EITHER_SIDE = object()

EXPECTED = {
    "vehicle-accelerating": (
        "car",
        [
            ("distance_to_ego", 400, "set_speed", 10.0, 5.0, "time"),
            ("after_event", "evt-1", "set_speed", 15.0, 5.0, "rate"),
            ("after_event", "evt-2", "set_speed", 15.0, 5.0, "time"),
        ],
    ),
    "vehicle-braking": (
        "car",
        [
            ("distance_to_ego", 400, "set_speed", 10.0, 5.0, "time"),
            ("after_event", "evt-1", "set_speed", 5.0, 5.0, "rate"),
            ("after_event", "evt-2", "set_speed", 5.0, 5.0, "time"),
        ],
    ),
    "vehicle-stopping": (
        "car",
        [
            ("distance_to_ego", 400, "set_speed", 10.0, 5.0, "time"),
            ("after_event", "evt-1", "set_speed", 0.0, 5.0, "rate"),
            ("after_event", "evt-2", "set_speed", 0.0, 5.0, "time"),
        ],
    ),
    "vehicle-stop-and-go": (
        "car",
        [
            ("distance_to_ego", 400, "set_speed", 10.0, 5.0, "time"),
            ("after_event", "evt-1", "set_speed", 0.0, 5.0, "rate"),
            ("after_event", "evt-2", "set_speed", 0.0, 1.0, "time"),
            ("after_event", "evt-3", "set_speed", 5.0, 5.0, "rate"),
            ("after_event", "evt-4", "set_speed", 5.0, 2.0, "time"),
        ],
    ),
    "vehicle-emergency-brake": (
        "car",
        [
            ("distance_to_ego", 400, "set_speed", 10.0, 5.0, "time"),
            ("distance_to_ego", 25, "set_speed", 0.0, 8.0, "rate"),
            ("after_event", "evt-2", "set_speed", 0.0, 3.0, "time"),
            ("after_event", "evt-3", "set_speed", 10.0, 3.0, "rate"),
        ],
    ),
    "vehicle-lane-change-left": (
        "car",
        [
            ("distance_to_ego", 400, "set_speed", 10.0, 5.0, "time"),
            ("after_event", "evt-1", "lane_change", "left", 15.0, None),
            ("after_event", "evt-2", "set_speed", 10.0, 5.0, "time"),
        ],
    ),
    "vehicle-lane-change-right": (
        "car",
        [
            ("distance_to_ego", 400, "set_speed", 10.0, 5.0, "time"),
            ("after_event", "evt-1", "lane_change", "right", 15.0, None),
            ("after_event", "evt-2", "set_speed", 10.0, 5.0, "time"),
        ],
    ),
    # Direction is toward the ego, decided at the click (templates.js
    # _buildCutIn) — EITHER_SIDE accepts left or right.
    "vehicle-cut-in": (
        "car",
        [
            ("distance_to_ego", 400, "set_speed", 8.0, 5.0, "time"),
            ("distance_to_ego", 15, "lane_change", EITHER_SIDE, 12.0, None),
        ],
    ),
    "vehicle-lane-drift": (
        "car",
        [
            ("distance_to_ego", 400, "set_speed", 8.0, 5.0, "time"),
            ("distance_to_ego", 40, "lane_offset", "left", 1.5, None),
            ("distance_to_ego", 20, "lane_offset", "left", 0.0, None),
        ],
    ),
    # NOTES 1.1 #3: a route onto the driving lane (seed + merge point + run-on)
    # released by a set_speed at 30 m — not a lane_change, which never fires
    # from a parking lane.
    "vehicle-pull-out": (
        "car",
        [
            ("simulation_time", 0, "assign_route", ANY, None, None),
            ("distance_to_ego", 30, "set_speed", 10.0, 5.0, "time"),
        ],
    ),
    "vehicle-parked": ("car", []),
    "pedestrian-crossing": (
        "pedestrian",
        [
            ("distance_to_ego", 30, "set_speed", 1.4, ANY, "time"),
            ("after_event", "evt-1", "set_speed", 0.0, 5.0, "time"),
        ],
    ),
    "pedestrian-stop-in-lane": (
        "pedestrian",
        [
            ("distance_to_ego", 40, "set_speed", 1.4, ANY, "time"),
            ("after_event", "evt-1", "set_speed", 0.0, 3.0, "time"),
            ("after_event", "evt-2", "set_speed", 1.4, ANY, "time"),
            ("after_event", "evt-3", "set_speed", 0.0, 5.0, "time"),
        ],
    ),
    "pedestrian-along-lane": (
        "pedestrian",
        [
            ("distance_to_ego", 400, "set_speed", 1.4, 10.0, "time"),
        ],
    ),
    "child-runs-out": (
        "child",
        [
            ("distance_to_ego", 25, "set_speed", 3.0, ANY, "time"),
            ("after_event", "evt-1", "set_speed", 0.0, 5.0, "time"),
        ],
    ),
    # A cyclist is a <Vehicle>: set_speed rides it ALONG the lane, so the
    # crossing is a follow_trajectory, kerb to kerb.
    "cyclist-crossing": (
        "cyclist",
        [
            ("distance_to_ego", 30, "follow_trajectory", ANY, None, None),
        ],
    ),
    "cyclist-along-lane": (
        "cyclist",
        [
            ("distance_to_ego", 400, "set_speed", 4.0, 10.0, "time"),
        ],
    ),
}

# Start (m/s) each template gives its actor. Walkers and anything released by
# a trigger start still — an Init SpeedAction lands on tick 1, long before any
# distance trigger, so a 10 m/s pedestrian used to be across the road first.
EXPECTED_INIT_SPEED = {
    "vehicle-accelerating": 10.0,
    "vehicle-braking": 10.0,
    "vehicle-stopping": 10.0,
    "vehicle-stop-and-go": 10.0,
    "vehicle-emergency-brake": 10.0,
    "vehicle-lane-change-left": 10.0,
    "vehicle-lane-change-right": 10.0,
    "vehicle-cut-in": 8.0,
    "vehicle-lane-drift": 8.0,
    "vehicle-pull-out": 0,
    "vehicle-parked": 0,
    "pedestrian-crossing": 0,
    "pedestrian-stop-in-lane": 0,
    "pedestrian-along-lane": 0,
    "child-runs-out": 0,
    "cyclist-crossing": 0,
    "cyclist-along-lane": 0,
}


def matches(got, want):
    """Tuple equality where ANY in `want` accepts any positive number or a list."""
    if len(got) != len(want):
        return False
    for g, w in zip(got, want):
        if len(g) != len(w):
            return False
        for gv, wv in zip(g, w):
            if wv is EITHER_SIDE:
                if gv not in ("left", "right"):
                    return False
            elif wv is ANY:
                if not (isinstance(gv, list) and len(gv) >= 2 or isinstance(gv, (int, float)) and gv > 0):
                    return False
            elif gv != wv:
                return False
    return True


EGO = (300.631, -2.025)
# One known-good spot on the ego's carriageway (borrowed from pedestrian.xosc),
# reused for every template with the actor removed in between. Placing all 11
# at once instead puts their SVG markers within a marker-width of each other at
# default zoom, and a click that lands on an existing marker selects it rather
# than placing anything. Using one spot also makes the along-lane vs crossing
# yaw comparison meaningful, since both are then on the same lane.
SPOT = (265.364, 1.967)


def summarise(events):
    """Editor-side event list -> the same tuple shape as EXPECTED."""
    out = []
    for ev in events:
        trig, act = ev.get("trigger") or {}, ev.get("action") or {}
        kind = trig.get("type")
        arg = trig.get("event_id") if kind == "after_event" else trig.get("value")
        if act.get("type") == "lane_change":
            out.append((kind, arg, "lane_change", act.get("direction"), (act.get("dynamics") or {}).get("value"), None))
        elif act.get("type") == "lane_offset":
            out.append((kind, arg, "lane_offset", act.get("direction"), act.get("offset"), None))
        elif act.get("type") == "assign_route":
            out.append((kind, arg, "assign_route", act.get("waypoints"), None, None))
        elif act.get("type") == "follow_trajectory":
            out.append((kind, arg, "follow_trajectory", act.get("trajectory"), None, None))
        else:
            out.append(
                (
                    kind,
                    arg,
                    act.get("type"),
                    (act.get("target") or {}).get("value"),
                    (act.get("dynamics") or {}).get("value"),
                    (act.get("dynamics") or {}).get("dimension"),
                )
            )
    return out


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town01")

    check("no JS errors on load", not errors, str(errors[:3]))
    check("ScenarioTemplates global exists", page.evaluate("!!window.ScenarioTemplates"))

    n = page.evaluate("Object.keys(ScenarioTemplates.templates).length")
    check(f"{len(EXPECTED)} templates registered", n == len(EXPECTED), f"got {n}")
    missing = page.evaluate("(ids)=>ids.filter(i=>!ScenarioTemplates.templates[i])", list(EXPECTED))
    check("every expected template id exists", missing == [], str(missing))

    # ── Panel renders every template as a button ─────────────────────────────
    page.evaluate("AppState.select(null)")
    page.click('[data-overview-tab="templates"]')
    n_btns = page.evaluate("document.querySelectorAll('[data-template-action]').length")
    check(f"{len(EXPECTED)} template buttons rendered", n_btns == len(EXPECTED), f"got {n_btns}")
    unbound = page.evaluate(
        "(ids)=>ids.filter(i=>!document.querySelector(`[data-template-action=\"${i}\"]`))", list(EXPECTED)
    )
    check("every template has a button", unbound == [], str(unbound))
    untitled = page.evaluate("""() => [...document.querySelectorAll('[data-template-action]')]
        .filter(b => !(b.title || '').trim()).map(b => b.dataset.templateAction)""")
    check("every template button has a hover description", untitled == [], str(untitled))

    # ── Placement + attached event chain, per template ───────────────────────
    H.place_actor(page, "ego", *EGO)
    check("ego placed", page.evaluate("!!AppState.ego"))

    placed = {}
    for tpl_id, (want_type, want_events) in EXPECTED.items():
        try:
            actor = H.place_template(page, tpl_id, *SPOT)
        except AssertionError as exc:
            check(f"{tpl_id}: placed", False, str(exc))
            continue
        placed[tpl_id] = actor
        check(f"{tpl_id}: actor type is {want_type}", actor["type"] == want_type, actor["type"])
        got = summarise(actor.get("events") or [])
        check(f"{tpl_id}: {len(want_events)} events attached", len(got) == len(want_events), f"got {len(got)}")
        check(f"{tpl_id}: event chain matches the template", matches(got, want_events), f"got {got}")
        check(
            f"{tpl_id}: start speed {EXPECTED_INIT_SPEED[tpl_id]}",
            actor.get("initial_speed") == EXPECTED_INIT_SPEED[tpl_id],
            str(actor.get("initial_speed")),
        )
        page.evaluate("(id) => AppState.removeById(id)", actor["id"])

    check("every template placed an actor", len(placed) == len(EXPECTED), f"{len(placed)}/{len(EXPECTED)}")
    check(
        "map is empty again after removals",
        page.evaluate("AppState.npcs.length") == 0,
        str(page.evaluate("AppState.npcs.length")),
    )

    check(
        "templates do not leave the tool armed",
        page.evaluate("AppState.activeTool") is None,
        str(page.evaluate("AppState.activeTool")),
    )
    check("templates clear pendingTemplate after placing", page.evaluate("AppState.pendingTemplate") is None)

    # ── Template-specific placement rules ────────────────────────────────────
    # Only four templates declare `placement`; the rest fall through to the
    # default spawn-point snap.
    decl = page.evaluate("""() => Object.fromEntries(
        Object.entries(ScenarioTemplates.templates)
              .map(([k,v]) => [k, v.placement || null]))""")
    with_placement = sorted(k for k, v in decl.items() if v)
    check(
        "exactly 4 templates declare a placement rule",
        with_placement == ["cyclist-along-lane", "pedestrian-along-lane", "vehicle-parked", "vehicle-pull-out"],
        str(with_placement),
    )
    check(
        "pull-out snaps to lane centre within 12 m",
        decl["vehicle-pull-out"]["snap"] == "lane-center" and decl["vehicle-pull-out"]["maxDistance"] == 12,
        str(decl["vehicle-pull-out"]),
    )
    check(
        "along-lane templates orient along the lane",
        decl["pedestrian-along-lane"]["orientation"] == "along-lane"
        and decl["cyclist-along-lane"]["orientation"] == "along-lane",
    )

    # A pedestrian placed by the along-lane template must run WITH the lane;
    # the crossing template leaves the default road-facing yaw, which is
    # perpendicular to it. If these two ever agree, the rule stopped applying.
    if "pedestrian-along-lane" in placed and "pedestrian-crossing" in placed:
        along = placed["pedestrian-along-lane"]["yaw"]
        cross = placed["pedestrian-crossing"]["yaw"]
        delta = abs(((along - cross) + 180) % 360 - 180)
        check(
            "along-lane yaw differs from crossing yaw", delta > 20, f"along={along} crossing={cross} delta={delta:.1f}"
        )

    # The cut-in changes lanes TOWARD the ego. CARLA's frame is left-handed
    # with y down, so facing +x the right-hand side is +y.
    if "vehicle-cut-in" in placed:
        a = placed["vehicle-cut-in"]
        yaw = math.radians(a["yaw"])
        cross = math.cos(yaw) * (EGO[1] - a["y"]) - math.sin(yaw) * (EGO[0] - a["x"])
        want = "right" if cross >= 0 else "left"
        got = a["events"][1]["action"]["direction"]
        check(
            f"cut-in changes lanes toward the ego ({want})",
            got == want,
            f"got {got}, actor at ({a['x']},{a['y']}) yaw {a['yaw']}",
        )

    # ── Export: does the chain survive to the .xosc? ─────────────────────────
    # Re-seed with a single template so entity refs stay predictable, then let
    # the real export path run.
    def export_template(tpl_id):
        page.evaluate(
            """(id) => {
            AppState.npcs = [];
            AppState.staticObjects = [];
            AppState.ego = {id:'obj-1', type:'ego', x:300.631, y:-2.025,
                            z:0.2, yaw:180, trajectory:[], events:[]};
            const actor = {id:'obj-2',
                           type: ScenarioTemplates.templates[id].actorType,
                           x:265.364, y:1.967, z:0.2,
                           // Across Town01 road 1 (it runs east-west), so a
                           // crossing template has a crossing to build.
                           yaw: 90,
                           events:[]};
            actor.events = ScenarioTemplates.eventsForActor(actor, id);
            AppState.npcs = [actor];
            AppState.set({});
        }""",
            tpl_id,
        )
        return H.export_xosc(page)

    for tpl_id in (
        "vehicle-stopping",
        "vehicle-lane-change-left",
        "vehicle-emergency-brake",
        "vehicle-cut-in",
        "vehicle-lane-drift",
        "vehicle-pull-out",
        "pedestrian-crossing",
        "pedestrian-stop-in-lane",
        "cyclist-crossing",
    ):
        want_type, want_events = EXPECTED[tpl_id]
        xml = export_template(tpl_id)
        evs = H.parse_events(xml, entity="adversary")

        check(f"{tpl_id}: exports {len(want_events)} events", len(evs) == len(want_events), f"got {len(evs)}")
        check(
            f"{tpl_id}: no dangling after_event refs", H.dangling_event_refs(xml) == [], str(H.dangling_event_refs(xml))
        )

        for i, (want, got) in enumerate(zip(want_events, evs)):
            t_kind, t_arg, a_kind, a_arg, dyn, dim = want
            check(f"{tpl_id}[{i}]: action is {a_kind}", got["action"]["kind"] == a_kind, got["action"]["kind"])
            if a_kind == "set_speed" and dyn is ANY:
                check(
                    f"{tpl_id}[{i}]: target speed {a_arg}",
                    got["action"].get("value") == a_arg,
                    str(got["action"].get("value")),
                )
                check(
                    f"{tpl_id}[{i}]: computed hold is plausible (0.5-60 s)",
                    0.5 <= (got["action"].get("dynamics_value") or 0) <= 60,
                    str(got["action"].get("dynamics_value")),
                )
            elif a_kind == "set_speed":
                check(
                    f"{tpl_id}[{i}]: target speed {a_arg}",
                    got["action"].get("value") == a_arg,
                    str(got["action"].get("value")),
                )
                check(
                    f"{tpl_id}[{i}]: dynamicsDimension is {dim}",
                    got["action"].get("dimension") == dim,
                    str(got["action"].get("dimension")),
                )
                # 'step' is what makes a 'time' duration a hold rather than a
                # ramp; if one of those ever becomes 'linear' the CARLA timing
                # assertions in carla_cases.py stop being valid. A 'rate' event
                # is the ramp, and the backend forces its shape to linear.
                want_shape = "linear" if dim == "rate" else "step"
                check(
                    f"{tpl_id}[{i}]: dynamicsShape is {want_shape}",
                    got["action"].get("shape") == want_shape,
                    str(got["action"].get("shape")),
                )
                unit = "m/s2" if dim == "rate" else "s"
                check(
                    f"{tpl_id}[{i}]: dynamics value {dyn} {unit} survives export",
                    got["action"].get("dynamics_value") == dyn,
                    str(got["action"].get("dynamics_value")),
                )
            elif a_kind == "assign_route":
                check(
                    f"{tpl_id}[{i}]: route has seed + merge + run-on waypoints",
                    (got["action"].get("waypoints") or 0) >= 3,
                    str(got["action"].get("waypoints")),
                )
            elif a_kind == "follow_trajectory":
                check(
                    f"{tpl_id}[{i}]: trajectory reaches the far kerb (>= 2 vertices)",
                    (got["action"].get("vertices") or 0) >= 2,
                    str(got["action"].get("vertices")),
                )
            elif a_kind == "lane_change" and a_arg is EITHER_SIDE:
                check(
                    f"{tpl_id}[{i}]: lane offset is one lane, either side",
                    got["action"].get("lane_offset") in (1, -1),
                    str(got["action"].get("lane_offset")),
                )
            elif a_kind == "lane_change":
                want_offset = 1 if a_arg == "left" else -1
                check(
                    f"{tpl_id}[{i}]: lane offset {want_offset} ({a_arg})",
                    got["action"].get("lane_offset") == want_offset,
                    str(got["action"].get("lane_offset")),
                )
                check(
                    f"{tpl_id}[{i}]: lane change is relative to itself",
                    got["action"].get("relative_to") == "adversary",
                    str(got["action"].get("relative_to")),
                )

            check(f"{tpl_id}[{i}]: trigger is {t_kind}", got["trigger"]["kind"] == t_kind, got["trigger"]["kind"])
            if t_kind == "distance_to_ego":
                check(
                    f"{tpl_id}[{i}]: trigger distance {t_arg} m",
                    got["trigger"].get("value") == float(t_arg),
                    str(got["trigger"].get("value")),
                )
                check(
                    f"{tpl_id}[{i}]: hero is the triggering entity",
                    got["trigger"].get("triggered_by") == ["hero"],
                    str(got["trigger"].get("triggered_by")),
                )
                check(
                    f"{tpl_id}[{i}]: 60 s time fallback present",
                    got["trigger"].get("fallback_time") == 60.0,
                    str(got["trigger"].get("fallback_time")),
                )
            elif t_kind == "after_event":
                # ids are remapped to generated event NAMES on export
                check(
                    f"{tpl_id}[{i}]: chains off event {i - 1}",
                    got["trigger"].get("ref") == evs[i - 1]["name"],
                    f"{got['trigger'].get('ref')} vs {evs[i - 1]['name']}",
                )
                check(
                    f"{tpl_id}[{i}]: waits for completeState",
                    got["trigger"].get("state") == "completeState",
                    str(got["trigger"].get("state")),
                )

    # pedestrians and cyclists must reach the .xosc as the right entity kind
    xml = export_template("pedestrian-crossing")
    check("pedestrian template exports a Pedestrian entity", "<Pedestrian" in xml, "no <Pedestrian> element")
    # The editor says 'cyclist'; the catalogue only knows 'bike'. This asserts
    # xml_builder._TYPE_ALIASES actually resolved it, rather than falling
    # through to the 'car' default the way an unknown type would.
    xml = export_template("cyclist-crossing")
    check(
        "cyclist resolves through the bike alias to its blueprint",
        "vehicle.diamondback.century" in xml,
        "expected vehicle.diamondback.century (bike npc_default)",
    )

    # ── Applying a template to an actor that is already placed ──────────────
    # The event panel's "Ablauf aus Template" picker (eventPanel.js) runs the
    # same builder on the actor's current pose and replaces its events.
    page.evaluate("""() => AppState.loadJSON({map: 'Town01', weather: {}, time: 'daytime',
        ego: null, npcs: [], staticObjects: [], trafficSignals: []})""")
    page.evaluate("UndoStack.clear ? UndoStack.clear() : null")
    H.place_actor(page, "ego", *EGO)
    van = H.place_actor(page, "van", *SPOT)
    page.evaluate("(id) => AppState.select(id)", van["id"])
    page.wait_for_timeout(150)
    opts = page.evaluate("""() => [...document.querySelectorAll('.event-template-select option')]
        .map(o => o.value).filter(Boolean)""")
    check(
        "a van is offered the vehicle templates",
        "vehicle-emergency-brake" in opts and "vehicle-cut-in" in opts,
        str(opts),
    )
    check(
        "a van is not offered walker or cyclist templates",
        not any(o.startswith(("pedestrian", "child", "cyclist")) for o in opts),
        str(opts),
    )
    undo_before = page.evaluate("UndoStack.length")
    page.select_option(".event-template-select", "vehicle-emergency-brake")
    page.wait_for_timeout(200)
    got = page.evaluate("(id) => AppState.findById(id)", van["id"])
    check(
        "applying a template gives the van its chain",
        matches(summarise(got["events"]), EXPECTED["vehicle-emergency-brake"][1]),
        str(summarise(got["events"])),
    )
    check(
        "...keeps the van a van, where it was", got["type"] == "van" and got["x"] == van["x"] and got["y"] == van["y"]
    )
    check("...and sets the template's start speed", got["initial_speed"] == 10.0, str(got["initial_speed"]))
    check(
        "applying is one undo entry",
        page.evaluate("UndoStack.length") == undo_before + 1,
        f"{undo_before} -> {page.evaluate('UndoStack.length')}",
    )
    # A second template over existing events asks first; cancelling keeps them.
    page.select_option(".event-template-select", "vehicle-lane-drift")
    page.wait_for_selector("#confirm-overlay:not(.hidden)", timeout=3000)
    check(
        "replacing existing events asks first",
        "ersetzen" in page.inner_text("#confirm-message"),
        page.inner_text("#confirm-message"),
    )
    page.click("#confirm-cancel")
    page.wait_for_timeout(150)
    kept = page.evaluate("(id) => AppState.findById(id).events.length", van["id"])
    check("cancelling keeps the old chain", kept == len(EXPECTED["vehicle-emergency-brake"][1]), str(kept))
    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(150)
    back = page.evaluate("(id) => AppState.findById(id)", van["id"])
    check(
        "Strg+Z takes the applied template off again",
        back["events"] == [] and back["initial_speed"] == 10.0,
        str(back["events"]),
    )
    walker = H.place_actor(page, "pedestrian", 245.0, -6.0)
    page.evaluate("(id) => AppState.select(id)", walker["id"])
    page.wait_for_timeout(150)
    wopts = page.evaluate("""() => [...document.querySelectorAll('.event-template-select option')]
        .map(o => o.value).filter(Boolean)""")
    check(
        "a pedestrian is offered exactly the walker templates",
        sorted(wopts) == ["child-runs-out", "pedestrian-along-lane", "pedestrian-crossing", "pedestrian-stop-in-lane"],
        str(wopts),
    )
    page.select_option(".event-template-select", "pedestrian-crossing")
    page.wait_for_timeout(200)
    wev = page.evaluate("(id) => AppState.findById(id).events", walker["id"])
    check(
        "a crossing applied to a kerbside walker is sized to the road",
        len(wev) == 2 and 0.5 <= wev[0]["action"]["dynamics"]["value"] <= 60,
        str(wev and wev[0]["action"]),
    )
    page.evaluate("() => AppState.select(AppState.ego.id)")
    page.wait_for_timeout(150)
    check(
        "the ego gets no template picker",
        page.evaluate("document.querySelectorAll('.event-template-select').length") == 0,
    )

    unexpected = [e for e in errors if "400 (Bad Request)" not in e]
    check("no unexpected JS errors during the run", not unexpected, str(unexpected[:3]))
    browser.close()

sys.exit(check.report())
