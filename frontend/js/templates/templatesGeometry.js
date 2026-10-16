/**
 * templatesGeometry.js — the builders that read the road at the click: crossings, the cut-in, the pull-out.
 *
 * Part of ScenarioTemplates; see templates.js (one class per file, each extending the last).
 */
(() => {
  'use strict';

  const {
    TemplatesTable,
    CYCLE_SPEED,
    KERB_STEP_M,
    CROSSING_SEARCH_M,
    PULL_OUT_AHEAD_M,
    PULL_OUT_RUN_M,
    WAYPOINT_CLEARANCE,
    VEHICLE_GOAL_ACCEPT_M,
    NON_CARRIAGEWAY,
  } = TemplatesCore.shared;

  class TemplatesGeometry extends TemplatesTable {
    // ── Geometry: what is in front of / beside the placed actor ──────────────

    /**
     * Walk from (x, y) along `yawDeg`: where the carriageway (anything but sidewalk/verge)
     * starts and ends, and the middle of the first driving lane, in metres. Null if none in reach.
     */
    _crossingProfile(x, y, yawDeg) {
      const roads = AppState.mapData?.roads || [];
      const ux = Math.cos((yawDeg * Math.PI) / 180),
        uy = Math.sin((yawDeg * Math.PI) / 180);
      const ex = x + ux * CROSSING_SEARCH_M,
        ey = y + uy * CROSSING_SEARCH_M;
      const bx0 = Math.min(x, ex) - 1,
        bx1 = Math.max(x, ex) + 1;
      const by0 = Math.min(y, ey) - 1,
        by1 = Math.max(y, ey) + 1;
      const polys = [];
      for (const road of roads) {
        for (const lane of road.lanes || []) {
          if (NON_CARRIAGEWAY.has(lane.type) || !lane.polygon || lane.polygon.length < 3) continue;
          let x0 = Infinity,
            x1 = -Infinity,
            y0 = Infinity,
            y1 = -Infinity;
          for (const p of lane.polygon) {
            if (p[0] < x0) x0 = p[0];
            if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1];
            if (p[1] > y1) y1 = p[1];
          }
          if (x1 < bx0 || x0 > bx1 || y1 < by0 || y0 > by1) continue;
          polys.push({ poly: lane.polygon, type: lane.type, x0, x1, y0, y1 });
        }
      }
      const laneAt = (px, py) => {
        for (const p of polys) {
          if (px < p.x0 || px > p.x1 || py < p.y0 || py > p.y1) continue;
          if (_pointInPoly(px, py, p.poly)) return p;
        }
        return null;
      };
      const STEP = 0.25;
      let entry = null,
        lastInside = null,
        drivingFrom = null,
        drivingTo = null,
        firstDriving = null;
      for (let s = 0; s <= CROSSING_SEARCH_M; s += STEP) {
        const lane = laneAt(x + ux * s, y + uy * s);
        if (lane) {
          if (entry == null) entry = s;
          lastInside = s;
          // The first driving lane by identity: two adjacent ones are one span by type.
          if (drivingTo == null) {
            if (lane.type === 'driving' && drivingFrom == null) {
              drivingFrom = s;
              firstDriving = lane;
            } else if (drivingFrom != null && lane !== firstDriving) drivingTo = s;
          }
        } else {
          if (drivingFrom != null && drivingTo == null) drivingTo = s;
          if (entry != null && s - lastInside > KERB_STEP_M) break; // across and onto the kerb
        }
      }
      // No road, or still on it at the search end (heading along it): not a crossing.
      if (entry == null || lastInside >= CROSSING_SEARCH_M - STEP) return null;
      return {
        entry,
        exit: lastInside,
        end: lastInside + KERB_STEP_M,
        drivingMid: drivingFrom != null ? (drivingFrom + (drivingTo ?? lastInside)) / 2 : null,
        ux,
        uy,
      };
    }

    /** set_speed chain that walks a walker across: go, (pause,) go on, stop. */
    _buildWalkerCrossing(actor, speed, triggerM, { pauseS = 0 } = {}) {
      const prof = this._crossingProfile(actor.x, actor.y, actor.yaw || 0);
      if (!prof) return null;
      const hold = (d) => Math.max(0.5, Math.round((d / speed) * 10) / 10);
      const first = { type: 'distance_to_ego', value: triggerM };
      if (pauseS > 0 && prof.drivingMid != null) {
        return [
          this._setSpeedEvent('evt-1', first, speed, hold(prof.drivingMid)),
          this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, pauseS),
          this._setSpeedEvent(
            'evt-3',
            { type: 'after_event', event_id: 'evt-2' },
            speed,
            hold(prof.end - prof.drivingMid),
          ),
          this._setSpeedEvent('evt-4', { type: 'after_event', event_id: 'evt-3' }, 0.0, 5.0),
        ];
      }
      return [
        this._setSpeedEvent('evt-1', first, speed, hold(prof.end)),
        this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, 5.0),
      ];
    }

    /** One straight follow_trajectory across the road, kerb to kerb. */
    _buildCyclistCrossing(actor) {
      const prof = this._crossingProfile(actor.x, actor.y, actor.yaw || 0);
      if (!prof) return null;
      const at = (s) => {
        const x = Math.round((actor.x + prof.ux * s) * 10) / 10;
        const y = Math.round((actor.y + prof.uy * s) * 10) / 10;
        const z = Math.round((ObjectsManager.groundZAt(x, y) + WAYPOINT_CLEARANCE) * 100) / 100;
        return { x, y, z, velocity: CYCLE_SPEED };
      };
      // Waypoint 1 on the actor's own pose, like startPathMode's seed.
      const trajectory = [{ x: actor.x, y: actor.y, z: actor.z ?? 0, velocity: CYCLE_SPEED }];
      const mid = (prof.entry + prof.end) / 2;
      if (mid > 2) trajectory.push(at(mid));
      trajectory.push(at(prof.end + VEHICLE_GOAL_ACCEPT_M));
      return [
        {
          id: 'evt-1',
          trigger: { type: 'distance_to_ego', value: 30 },
          action: { type: 'follow_trajectory', trajectory },
        },
      ];
    }

    /** Cut-in chain, changing lanes toward the side the ego is on. */
    _buildCutIn(actor) {
      const events = this.templates['vehicle-cut-in'].events.map((ev) => JSON.parse(JSON.stringify(ev)));
      const ego = AppState.ego;
      if (!ego) {
        Toast.info('Einscheren: noch kein Ego platziert — Spurwechsel nach rechts angenommen');
        return events;
      }
      // y-down frame: facing +x, +y is to the right.
      const yaw = ((actor.yaw || 0) * Math.PI) / 180;
      const cross = Math.cos(yaw) * (ego.y - actor.y) - Math.sin(yaw) * (ego.x - actor.x);
      events[1].action.direction = cross >= 0 ? 'right' : 'left';
      return events;
    }

    /** Route out of the parking spot onto the driving lane beside it. */
    _buildPullOut(actor) {
      const driving = new Set(['driving']);
      // Direction from the lane the car stands on, not its yaw.
      const here = ObjectsManager.nearestLaneProjection(
        actor.x,
        actor.y,
        new Set(['driving', 'parking', 'shoulder']),
        12,
      );
      if (!here) return null;
      const yaw = (here.laneYaw * Math.PI) / 180;
      const ax = here.x + Math.cos(yaw) * PULL_OUT_AHEAD_M;
      const ay = here.y + Math.sin(yaw) * PULL_OUT_AHEAD_M;
      const merge = ObjectsManager.nearestLaneProjection(ax, ay, driving, 8);
      if (!merge) return null;
      const dYaw = Math.abs(((merge.laneYaw - here.laneYaw + 540) % 360) - 180);
      if (dYaw > 60) return null;
      const seed = ObjectsManager.routeWaypointAt(actor.x, actor.y);
      const wp = (x, y, z) => ({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        z: Math.round((z + WAYPOINT_CLEARANCE) * 100) / 100,
        strategy: 'fastest',
      });
      const waypoints = [{ x: seed.x, y: seed.y, z: seed.z, strategy: 'fastest' }, wp(merge.x, merge.y, merge.z)];
      // Run on so the route's end (a dead stop) is past the merge: probed straight ahead,
      // farthest first, onto a same-direction driving lane.
      const mYaw = (merge.laneYaw * Math.PI) / 180;
      for (const ahead of [PULL_OUT_RUN_M, 60, 40, 30, 20]) {
        const c = ObjectsManager.nearestLaneProjection(
          merge.x + Math.cos(mYaw) * ahead,
          merge.y + Math.sin(mYaw) * ahead,
          driving,
          4,
        );
        if (c && Math.abs(((c.laneYaw - merge.laneYaw + 540) % 360) - 180) < 30) {
          waypoints.push(wp(c.x, c.y, c.z));
          break;
        }
      }
      return [
        {
          id: 'evt-1',
          trigger: { type: 'simulation_time', value: 0 },
          action: { type: 'assign_route', route_strategy: 'fastest', waypoints },
        },
        this._setSpeedEvent('evt-2', { type: 'distance_to_ego', value: 30 }, 10.0, 5.0),
      ];
    }
  }

  function _pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0],
        yi = poly[i][1],
        xj = poly[j][0],
        yj = poly[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  TemplatesCore.define({
    TemplatesGeometry,
  });
})();
