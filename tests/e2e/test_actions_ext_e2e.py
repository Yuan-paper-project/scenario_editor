"""Speed, offset and trigger extensions, and the controller's rate limits.

Covers, end to end (panel → state → export payload → .xosc → preview):
  - set_distance is hidden from the action grid but still loads and exports;
  - relative set_speed by factor, continuously, and relative to the actor's own
    speed (rate only), plus the after_event ban on a continuous follow;
  - „Rückwärts": a negative absolute target, vehicles only;
  - lane_offset presets from the lane width, and the „Hin & zurück" mode
    (continuous="false"), which completes and can be chained onto;
  - „Abstand zu Akteur" (distance_to_ego naming another actor) and the
    relative_speed trigger;
  - per-actor max_acceleration / max_deceleration, exported and applied by the
    preview;
  - the vehicle goal latch: an event after the actor's own trajectory end gets
    a non-blocking warning chip and moves nothing in the preview.

    bash run.sh 9090            # terminal 1
    .venv/bin/python3 tests/e2e/test_actions_ext_e2e.py
"""

import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _harness as H  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

check = H.Checks()

# Town01 road 1, an east–west two-way street (see test_ego_events_e2e.py).
EGO = {"id": "obj-1", "type": "ego", "x": 300.631, "y": -2.025, "z": 0.2, "yaw": 180, "events": []}
CAR = {"id": "obj-2", "type": "car", "x": 265.364, "y": 1.967, "z": 0.2, "yaw": 0, "events": []}
CAR2 = {"id": "obj-3", "type": "car", "x": 240.0, "y": 1.967, "z": 0.2, "yaw": 0, "events": []}
WALKER = {"id": "obj-4", "type": "pedestrian", "x": 280.0, "y": 6.5, "z": 0.8, "yaw": -90, "events": []}


def seed(page, ego_events=None, npcs=None, ego_extra=None):
    page.evaluate(
        """(p) => {
        if (window.Simulate && Simulate.running) Simulate.stop();
        AppState.loadJSON({map: 'Town01', weather: {}, time: 'daytime',
                           ego: p.ego, npcs: p.npcs, staticObjects: [], trafficSignals: []});
    }""",
        {
            "ego": {**EGO, **(ego_extra or {}), "events": ego_events or []},
            "npcs": npcs if npcs is not None else [dict(CAR)],
        },
    )


def tick():
    return {"type": "simulation_time", "value": 0}


def speed(eid, target, trigger=None, dimension="time", value=5.0):
    return {
        "id": eid,
        "trigger": trigger or tick(),
        "action": {
            "type": "set_speed",
            "dynamics": {"shape": "linear" if dimension == "rate" else "step", "dimension": dimension, "value": value},
            "target": target,
        },
    }


def params(page):
    return page.evaluate("ScenarioIO.buildParamsForTesting()")


def xosc(page):
    return H.xosc_from_params(page, params(page))


def condition_pairs(root, tag):
    """[(triggering entity, condition element)] for every <tag> condition."""
    out = []
    for bec in root.iter("ByEntityCondition"):
        cond = bec.find(f"EntityCondition/{tag}")
        if cond is not None:
            out.append((bec.find("TriggeringEntities/EntityRef").get("entityRef"), cond))
    return out


def speed_targets(xml_text, entity):
    root = ET.fromstring(xml_text)
    out = []
    for mg in root.iter("ManeuverGroup"):
        refs = [e.get("entityRef") for e in mg.iter("EntityRef")]
        if entity not in refs[:1]:
            continue
        for sa in mg.iter("SpeedAction"):
            out.append(sa)
    return out


def labels(page, selector):
    return page.evaluate(f"[...document.querySelectorAll('{selector}')].map(b => b.textContent)")


def card(page, idx=0):
    return page.locator("#event-list .event-card").nth(idx)


def run(page, **kw):
    return page.evaluate("(kw) => Simulate.runHeadless(kw)", kw)


def speed_at(res, actor_id, t):
    times = res["times"]
    i = min(range(len(times)), key=lambda k: abs(times[k] - t))
    return res["tracks"][actor_id][i]["speed"]


def pos_at(res, actor_id, t):
    times = res["times"]
    i = min(range(len(times)), key=lambda k: abs(times[k] - t))
    tr = res["tracks"][actor_id][i]
    return tr["x"], tr["y"]


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town01")
    check("no JS errors on load", not errors, str(errors[:3]))

    # ── set_distance: hidden, not removed ────────────────────────────────────
    seed(page)
    page.evaluate("AppState.select('obj-2')")
    grid = labels(page, "#event-action-grid .event-action-button")
    check("Abstand halten is not offered in the grid", "Abstand halten" not in grid, str(grid))
    seed(
        page,
        npcs=[
            {
                **CAR,
                "events": [
                    {
                        "id": "e1",
                        "trigger": tick(),
                        "action": {"type": "set_distance", "axis": "longitudinal", "entity_ref": "obj-1", "value": 10},
                    }
                ],
            }
        ],
    )
    page.evaluate("AppState.select('obj-2')")
    check(
        "a loaded set_distance event still renders its card",
        page.locator("#event-list .event-card").count() == 1
        and "Abstand halten" in page.locator(".event-title-text").first.text_content(),
    )
    check("a loaded set_distance still exports", "LongitudinalDistanceAction" in xosc(page))

    # ── relative set_speed: factor + continuous through the real panel ────────
    seed(page)
    page.evaluate("AppState.select('obj-2')")
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    card(page).locator('.event-toggle button:has-text("Relativ")').click()
    card(page).locator('.event-toggle button[data-value="factor"]').click()
    factor_input = card(page).locator(".event-speed-row input").first
    factor_input.fill("0.5")
    factor_input.dispatch_event("change")
    card(page).locator('.event-toggle button[data-value="continuous"]').click()
    target = page.evaluate("AppState.npcs[0].events[0].action.target")
    check(
        "factor + continuous land in state",
        target.get("value_type") == "factor"
        and target.get("factor") == 0.5
        and target.get("continuous") is True
        and target.get("entity_ref") == "obj-1",
        str(target),
    )
    check(
        "a continuous follow hides the dynamics select and states its duration",
        card(page).locator(".event-speed-dim").count() == 0
        and "dauerhaft" in card(page).locator(".event-speed-row").text_content(),
    )
    text = xosc(page)
    rts = ET.fromstring(text).findall(".//RelativeTargetSpeed")
    check(
        "xosc: RelativeTargetSpeed factor 0.5, continuous, relative to hero",
        len(rts) == 1
        and rts[0].get("speedTargetValueType") == "factor"
        and float(rts[0].get("value")) == 0.5
        and rts[0].get("continuous") == "true"
        and rts[0].get("entityRef") == "hero",
        str([r.attrib for r in rts]),
    )

    # A second event: the continuous follow must not be offered as after_event.
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    trig2 = page.evaluate("AppState.npcs[0].events[1].trigger")
    check("a new event does not chain onto a continuous follow", trig2.get("type") != "after_event", str(trig2))
    card(page, 1).locator(".event-trigger-block select").first.select_option("after_event")
    opts = page.evaluate(
        "[...document.querySelectorAll('#event-list .event-card')[1]"
        ".querySelectorAll('.event-trigger-block select')[1]?.options || []].map(o => o.value)"
    )
    check("after_event dropdown omits the continuous follow", "obj-2::evt-1" not in opts, str(opts))
    bad = params(page)
    bad["npcs"][0]["events"][1]["trigger"] = {"type": "after_event", "event_id": "evt-1", "actor_ref": "adversary"}
    check("backend rejects after_event onto a continuous follow (400)", H.export_status(page, bad) == 400)
    page.evaluate("""() => {
        const a = AppState.npcs[0];
        AppState.updateById(a.id, {events: a.events.map((e, i) => i === 1
          ? {...e, trigger: {type: 'after_event', event_id: 'evt-1'}} : e)});
    }""")
    chips = labels(page, "#event-list .event-problem")
    check(
        "a loaded after_event onto a continuous follow is chipped",
        any("Folgen endet nicht" in c for c in chips),
        str(chips),
    )

    # Preview: the follower tracks 0.5 × the ego's speed for good.
    seed(
        page,
        ego_events=[speed("e1", {"mode": "absolute", "value": 8})],
        npcs=[
            {
                **CAR,
                "events": [
                    speed(
                        "evt-1",
                        {
                            "mode": "relative",
                            "entity_ref": "obj-1",
                            "value_type": "factor",
                            "factor": 0.5,
                            "continuous": True,
                        },
                    )
                ],
            }
        ],
    )
    res = run(page, maxTime=12)
    check(
        "preview: continuous factor follow tracks 0.5 × ego past the 5 s value",
        abs(speed_at(res, "obj-2", 10) - 0.5 * speed_at(res, "obj-1", 10)) < 0.3,
        f"{speed_at(res, 'obj-2', 10)} vs ego {speed_at(res, 'obj-1', 10)}",
    )
    check(
        "preview: the continuous follow never completes",
        "evt-1" not in res["completed"]["obj-2"],
        str(res["completed"]),
    )

    # ── relative to its own speed: rate only ─────────────────────────────────
    seed(page, npcs=[{**CAR, "initial_speed": 10, "events": []}])
    page.evaluate("AppState.select('obj-2')")
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    card(page).locator('.event-toggle button:has-text("Relativ")').click()
    card(page).locator(":scope > .event-row select").first.select_option("obj-2")
    ev = page.evaluate("AppState.npcs[0].events[0].action")
    check(
        "choosing 'Eigene Geschw.' switches the dynamics to Rate",
        ev["dynamics"]["dimension"] == "rate" and ev["target"]["entity_ref"] == "obj-2",
        str(ev),
    )
    check(
        "…and disables Zeit, and offers no Folgen row",
        page.evaluate("document.querySelector('#event-list .event-speed-dim option[value=time]').disabled")
        and card(page).locator('.event-toggle button[data-value="continuous"]').count() == 0,
    )
    card(page).locator('.event-toggle button[data-value="factor"]').click()
    rts = ET.fromstring(xosc(page)).findall(".//RelativeTargetSpeed")
    check(
        "xosc: self-relative target names the actor's own entity",
        rts and rts[0].get("entityRef") == "adversary" and rts[0].get("speedTargetValueType") == "factor",
        str([r.attrib for r in rts]),
    )
    bad = params(page)
    bad["npcs"][0]["events"][0]["action"]["dynamics"] = {"dimension": "time", "value": 5}
    check("backend rejects a self-relative speed with 'time' (400)", H.export_status(page, bad) == 400)
    page.evaluate("""() => { const a = AppState.npcs[0];
        AppState.updateById(a.id, {events: a.events.map(e => ({...e, action: {...e.action,
          dynamics: {shape: 'step', dimension: 'time', value: 5}}}))}); }""")
    chips = labels(page, "#event-list .event-problem")
    check("a loaded self-relative 'time' speed is chipped", any("Eigene Geschw." in c for c in chips), str(chips))

    # ── compact rows: one row per meaning ─────────────────────────────────────
    seed(
        page,
        npcs=[
            {
                **CAR,
                "events": [
                    speed(
                        "evt-1",
                        {"mode": "relative", "entity_ref": "obj-1", "value_type": "factor", "factor": 0.8},
                        trigger={"type": "relative_speed", "entity_ref": "obj-1", "rule": "greaterThan", "value": 2},
                    ),
                    {
                        "id": "evt-2",
                        "trigger": {"type": "ego_speed", "rule": "greaterThan", "value": 8},
                        "action": {"type": "lane_offset", "direction": "left", "offset": 2},
                    },
                ],
            }
        ],
    )
    page.evaluate("AppState.select('obj-2')")
    rows = page.evaluate("""() => [...document.querySelectorAll('#event-list .event-card')].map(c => ({
        trigger: c.querySelectorAll('.event-trigger-block > div').length,
        action: [...c.children].filter(el => /event-(row|speed-row|param-row)/.test(el.className)).length}))""")
    check(
        "relative set_speed: trigger 3 rows (Auslöser, Akteur, Differenz), action 3 rows",
        rows[0] == {"trigger": 3, "action": 3},
        str(rows),
    )
    check(
        "lane_offset under ego_speed: trigger 2 rows, action 2 rows (Seite, Dauer)",
        rows[1] == {"trigger": 2, "action": 2},
        str(rows),
    )

    # ── reverse ──────────────────────────────────────────────────────────────
    seed(page, npcs=[dict(CAR), dict(WALKER)])
    page.evaluate("AppState.select('obj-2')")
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    card(page).locator('.event-toggle button[data-value="reverse"]').click()
    inp = card(page).locator(".event-speed-row input").first
    inp.fill("3")
    inp.dispatch_event("change")
    tgt = page.evaluate("AppState.npcs[0].events[0].action.target")
    check(
        "Rückwärts stores reverse: true with a positive value",
        tgt.get("reverse") is True and tgt.get("value") == 3,
        str(tgt),
    )
    abs_vals = [a.get("value") for a in ET.fromstring(xosc(page)).iter("AbsoluteTargetSpeed")]
    check("xosc: reverse is a negative AbsoluteTargetSpeed", any(float(v) == -3 for v in abs_vals), str(abs_vals))
    page.evaluate("AppState.select('obj-4')")
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    check(
        "a pedestrian's card offers no Rückwärts",
        card(page).locator('.event-toggle button[data-value="reverse"]').count() == 0,
    )
    bad = params(page)
    bad["npcs"][1]["events"][0]["action"]["target"]["reverse"] = True
    check("backend rejects reverse for a walker (400)", H.export_status(page, bad) == 400)

    seed(
        page,
        ego_events=[speed("e1", {"mode": "absolute", "value": 0})],
        npcs=[{**CAR, "events": [speed("evt-1", {"mode": "absolute", "value": 3, "reverse": True})]}],
    )
    res = run(page, maxTime=4)
    x0, _ = pos_at(res, "obj-2", 0.05)
    x3, _ = pos_at(res, "obj-2", 3)
    check("preview: a reversing car (yaw 0) moves towards −x", x3 < x0 - 5, f"{x0} -> {x3}")
    check("preview: it reaches −3 m/s", abs(speed_at(res, "obj-2", 3) + 3) < 0.05, str(speed_at(res, "obj-2", 3)))

    # ── lane_offset: presets and „Hin & zurück" ──────────────────────────────
    seed(page)
    page.evaluate("AppState.select('obj-2')")
    page.click('#event-action-grid .event-action-button:has-text("Spurversatz")')
    width = page.evaluate("""() => { const a = AppState.npcs[0];
        const n = ObjectsManager.nearestLaneProjection(a.x, a.y, new Set(['driving']), 10);
        return n.lane.widths[n.segIndex]; }""")
    card(page).locator('.event-offset-presets button[data-preset="half"]').click()
    off = page.evaluate("AppState.npcs[0].events[0].action.offset")
    check("'½ Spur' sets half the lane width", abs(off - width / 2) < 0.01, f"{off} vs {width}")
    card(page).locator('.event-offset-presets button[data-preset="full"]').click()
    off = page.evaluate("AppState.npcs[0].events[0].action.offset")
    check("'1 Spur' sets the whole lane width", abs(off - width) < 0.01, f"{off} vs {width}")
    card(page).locator('.event-toggle button[data-value="return"]').click()
    check(
        "'Hin & zurück' stores continuous: false",
        page.evaluate("AppState.npcs[0].events[0].action.continuous") is False,
    )
    los = ET.fromstring(xosc(page)).findall(".//LaneOffsetAction")
    check(
        "xosc: LaneOffsetAction continuous=\"false\"",
        los and los[0].get("continuous") == "false",
        str([l.attrib for l in los]),
    )
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    trig2 = page.evaluate("AppState.npcs[0].events[1].trigger")
    check(
        "a new event chains onto a returning offset", trig2 == {"type": "after_event", "event_id": "evt-1"}, str(trig2)
    )
    check("…and that exports", "completeState" in xosc(page))

    seed(
        page,
        npcs=[
            {
                **CAR,
                "initial_speed": 8,
                "events": [
                    {
                        "id": "evt-1",
                        "trigger": {"type": "simulation_time", "value": 2},
                        "action": {"type": "lane_offset", "direction": "left", "offset": 1.5, "continuous": False},
                    },
                    speed(
                        "evt-2", {"mode": "absolute", "value": 8}, trigger={"type": "after_event", "event_id": "evt-1"}
                    ),
                ],
            }
        ],
    )
    res = run(page, maxTime=10)
    done = res["completed"]["obj-2"].get("evt-1")
    check("preview: the returning offset completes", done is not None and done > 2, str(done))
    # Same-actor after_event reads completion live, so it fires on the next tick,
    # as OSCStartEndCondition does on the blackboard write.
    fired2 = res["fired"]["obj-2"].get("evt-2")
    check(
        "preview: the chained event fires on its completion",
        fired2 is not None and done is not None and 0 <= fired2 - done <= 0.051,
        f"done {done} fired {fired2}",
    )
    ys = [tr["y"] for tr in res["tracks"]["obj-2"]]
    check(
        "preview: the car swings out ~1.5 m to its left (−y at yaw 0) and comes back",
        min(ys) < CAR["y"] - 1.3 and abs(ys[-1] - CAR["y"]) < 0.3,
        f"min {min(ys)} end {ys[-1]}",
    )

    # ── „Abstand zu Akteur" ──────────────────────────────────────────────────
    seed(
        page,
        npcs=[
            {
                **CAR,
                "events": [
                    speed(
                        "evt-1",
                        {"mode": "absolute", "value": 5},
                        trigger={"type": "distance_to_ego", "value": 30, "entity_ref": "obj-3"},
                    )
                ],
            },
            dict(CAR2),
        ],
    )
    root = ET.fromstring(xosc(page))
    pairs = condition_pairs(root, "RelativeDistanceCondition")
    check(
        "xosc: distance trigger measures from the named actor",
        ("adversary1", "adversary") in [(t, c.get("entityRef")) for t, c in pairs],
        str([(t, c.attrib) for t, c in pairs]),
    )
    seed(
        page,
        npcs=[
            {
                **CAR,
                "events": [
                    speed("evt-1", {"mode": "absolute", "value": 5}, trigger={"type": "distance_to_ego", "value": 30})
                ],
            }
        ],
    )
    payload = params(page)
    check(
        "an ego distance stays without entity_ref in the payload",
        "entity_ref" not in payload["npcs"][0]["events"][0]["trigger"],
        str(payload["npcs"][0]["events"][0]["trigger"]),
    )
    seed(page)
    page.evaluate("AppState.select('obj-1')")
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    sel = card(page).locator(".event-trigger-block select").first
    check(
        "the ego is offered 'Abstand zu Akteur' when an NPC exists",
        "distance_to_ego"
        in page.evaluate(
            "[...document.querySelector('#event-list .event-trigger-block select').options].map(o => o.value)"
        ),
    )
    sel.select_option("distance_to_ego")
    trig = page.evaluate("AppState.ego.events[0].trigger")
    check("…and it defaults to the NPC", trig.get("entity_ref") == "obj-2", str(trig))
    root = ET.fromstring(xosc(page))
    check(
        "xosc: the ego's distance trigger survives (not coerced to time 0)",
        any(r.get("entityRef") == "adversary" for r in root.findall(".//StartTrigger//TriggeringEntities/EntityRef")),
        "",
    )
    seed(page, npcs=[])
    page.evaluate("AppState.select('obj-1')")
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    check(
        "an ego with no NPC is not offered the actor-relative triggers",
        not {"distance_to_ego", "relative_speed"}
        & set(
            page.evaluate(
                "[...document.querySelector('#event-list .event-trigger-block select').options].map(o => o.value)"
            )
        ),
    )

    # Preview: car waits until the OTHER car is within 15 m.
    seed(
        page,
        npcs=[
            {
                **CAR,
                "events": [
                    speed(
                        "evt-1",
                        {"mode": "absolute", "value": 5},
                        trigger={"type": "distance_to_ego", "value": 15, "entity_ref": "obj-3"},
                    )
                ],
            },
            {**CAR2, "initial_speed": 5, "events": []},
        ],
    )
    res = run(page, maxTime=8)
    fired = res["fired"]["obj-2"].get("evt-1")
    cx, _ = pos_at(res, "obj-3", fired or 0)
    check(
        "preview: 'Abstand zu Akteur' fires when the other actor is ~15 m away",
        fired is not None and abs((CAR["x"] - cx) - 15) < 1.0,
        f"t={fired} gap={CAR['x'] - cx}",
    )

    # ── relative_speed ───────────────────────────────────────────────────────
    seed(
        page,
        ego_events=[speed("e1", {"mode": "absolute", "value": 10})],
        npcs=[
            {
                **CAR,
                "events": [
                    speed(
                        "evt-1",
                        {"mode": "absolute", "value": 4},
                        trigger={"type": "relative_speed", "entity_ref": "obj-1", "rule": "greaterThan", "value": 5},
                    )
                ],
            }
        ],
    )
    page.evaluate("AppState.select('obj-2')")
    summary = card(page).text_content()
    check(
        "the card offers the Geschw.-Differenz trigger controls",
        "Differenz" in summary and card(page).locator('.event-rule-row input[aria-label="Schwelle"]').count() == 1,
        summary[:200],
    )
    root = ET.fromstring(xosc(page))
    pairs = condition_pairs(root, "RelativeSpeedCondition")
    check(
        "xosc: RelativeSpeedCondition, ego triggering, NPC as reference",
        len(pairs) == 1
        and pairs[0][0] == "hero"
        and pairs[0][1].get("entityRef") == "adversary"
        and pairs[0][1].get("rule") == "greaterThan"
        and float(pairs[0][1].get("value")) == 5,
        str([(t, c.attrib) for t, c in pairs]),
    )
    res = run(page, maxTime=8)
    t_fire = res["fired"]["obj-2"].get("evt-1")
    check(
        "preview: fires as the ego passes 5 m/s faster (≈ 5/3 s at 3 m/s²)",
        t_fire is not None and 1.4 < t_fire < 2.1,
        str(t_fire),
    )
    bad = params(page)
    bad["npcs"][0]["events"][0]["trigger"]["entity_ref"] = "adversary"
    check("backend rejects a relative_speed against itself (400)", H.export_status(page, bad) == 400)

    # ── max_acceleration / max_deceleration ──────────────────────────────────
    seed(
        page,
        npcs=[{**CAR, "initial_speed": 10, "events": []}, dict(WALKER)],
        ego_events=[speed("e1", {"mode": "absolute", "value": 0})],
    )
    page.evaluate("AppState.select('obj-2')")
    check(
        "a car shows the acceleration fields",
        page.locator("#dynamics-row").is_visible()
        and page.input_value("#prop-max-accel") == "3.0"
        and page.input_value("#prop-max-decel") == "10.0",
    )
    res = run(page, maxTime=5)
    # SimpleVehicleControl: +a·dt per tick from rest, after its 0.5 m/s
    # pull-away bump on the first tick — 0.5 + 19 × 0.15 at t = 1 s.
    check(
        "preview: a car pulls up to its start speed at 3 m/s² (+0.5 m/s bump)",
        abs(speed_at(res, "obj-2", 1.0) - (0.5 + 19 * 0.15)) < 0.01,
        str(speed_at(res, "obj-2", 1.0)),
    )
    page.fill("#prop-max-accel", "6")
    page.dispatch_event("#prop-max-accel", "change")
    check("the field writes max_acceleration", page.evaluate("AppState.npcs[0].max_acceleration") == 6)
    res = run(page, maxTime=5)
    check(
        "preview: at 6 m/s² it is twice as quick",
        abs(speed_at(res, "obj-2", 1.0) - (0.5 + 19 * 0.3)) < 0.01,
        str(speed_at(res, "obj-2", 1.0)),
    )
    page.evaluate("AppState.select('obj-4')")
    check("a pedestrian hides the acceleration fields", not page.locator("#dynamics-row").is_visible())
    page.evaluate("AppState.select('obj-1')")
    page.fill("#prop-max-decel", "4")
    page.dispatch_event("#prop-max-decel", "change")
    root = ET.fromstring(xosc(page))

    def ctrl_props(entity):
        for priv in root.iter("Private"):
            if priv.get("entityRef") == entity:
                return {pr.get("name"): pr.get("value") for pr in priv.iter("Property")}
        return {}

    check(
        "xosc: the NPC's controller carries max_acceleration 6",
        ctrl_props("adversary").get("max_acceleration") == "6.0",
        str(ctrl_props("adversary")),
    )
    check(
        "xosc: the hero's controller carries max_deceleration 4",
        ctrl_props("hero").get("max_deceleration") == "4.0",
        str(ctrl_props("hero")),
    )
    check(
        "xosc: untouched values keep the old defaults",
        ctrl_props("hero").get("max_acceleration") == "3.0"
        and ctrl_props("adversary").get("max_deceleration") == "10.0",
    )

    # Braking is limited too: 10 → 0 at max_deceleration 2 takes 5 s.
    seed(
        page,
        ego_events=[speed("e1", {"mode": "absolute", "value": 0})],
        npcs=[
            {
                **CAR,
                "initial_speed": 10,
                "max_deceleration": 2,
                "max_acceleration": 50,
                "events": [
                    speed("evt-1", {"mode": "absolute", "value": 0}, trigger={"type": "simulation_time", "value": 2})
                ],
            }
        ],
    )
    res = run(page, maxTime=9)
    check(
        "preview: braking from 10 m/s at 2 m/s² leaves ≈6 m/s after 2 s",
        abs(speed_at(res, "obj-2", 4.0) - 6.0) < 0.3,
        str(speed_at(res, "obj-2", 4.0)),
    )
    # A rate ramp above the controller limit is capped by it.
    seed(
        page,
        ego_events=[speed("e1", {"mode": "absolute", "value": 0})],
        npcs=[{**CAR, "events": [speed("evt-1", {"mode": "absolute", "value": 10}, dimension="rate", value=8)]}],
    )
    res = run(page, maxTime=6)
    check(
        "preview: an 8 m/s² rate ramp is held to the 3 m/s² limit",
        abs(speed_at(res, "obj-2", 2.0) - 6.0) < 0.3,
        str(speed_at(res, "obj-2", 2.0)),
    )

    # ── the goal latch ───────────────────────────────────────────────────────
    traj = [
        {"x": CAR["x"], "y": CAR["y"], "z": 0.5, "velocity": 6},
        {"x": CAR["x"] + 20, "y": CAR["y"], "z": 0.5, "velocity": 6},
    ]
    seed(
        page,
        ego_events=[speed("e1", {"mode": "absolute", "value": 0})],
        npcs=[
            {
                **CAR,
                "events": [
                    {"id": "evt-1", "trigger": tick(), "action": {"type": "follow_trajectory", "trajectory": traj}},
                    speed(
                        "evt-2", {"mode": "absolute", "value": 8}, trigger={"type": "after_event", "event_id": "evt-1"}
                    ),
                ],
            }
        ],
    )
    page.evaluate("AppState.select('obj-2')")
    warn = labels(page, "#event-list .event-warning")
    check(
        "an event after the car's own trajectory end gets a soft warning", any("Pfadende" in w for w in warn), str(warn)
    )
    check(
        "…which does not block the export",
        page.evaluate("ScenarioRules.problemsOf(AppState.npcs[0]).length") == 0
        and "FollowTrajectoryAction" in xosc(page),
    )
    res = run(page, maxTime=12)
    t2 = res["fired"]["obj-2"].get("evt-2")
    xa, _ = pos_at(res, "obj-2", t2 + 0.1)
    xb, _ = pos_at(res, "obj-2", t2 + 3)
    check("preview: the latched car does not move again", t2 is not None and abs(xb - xa) < 0.05, f"t={t2} {xa}->{xb}")

    # The rejection checks POST payloads the backend must refuse; their 400s
    # are logged by the browser and are the point, not an error.
    real = [e for e in errors if "status of 400" not in e]
    check("no JS errors during the run", not real, str(real[:3]))
    browser.close()

sys.exit(check.report())
