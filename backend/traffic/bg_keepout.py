"""The keep-out around the scripted scenario, and what it removes from SUMO's network before any simulation."""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from pathlib import Path

from backend.traffic.bg_sumo import _sumolib_net

# ── Keep-out ───────────────────────────────────────────────────────────────


class _KeepOut:
    """Path segments with half-widths on a grid, for `hits`: is a car of half-width `half_w` at
    (x, y) within `clearance` of a path's edge — for a timed path, at a moment within the window
    of when its actor is there? Points are [x, y] (occupied all run) or [x, y, t]; `t=None`
    ignores time. The cell is at least the largest hit distance, so the car's own cell suffices.
    """

    def __init__(self, paths: list[dict], clearance: float, window_s: float = 0.0):
        self.clearance = clearance
        self.window = window_s
        self.segs: list[tuple] = []  # (ax, ay, bx, by, w, t_lo, t_hi) — t None: untimed
        self.grid: dict[tuple[int, int], list[int]] = {}
        for path in paths or []:
            w = float(path.get("w", 1.0))
            pts = [tuple(float(v) for v in p[:3]) for p in path.get("pts", []) if len(p) >= 2]
            if len(pts) == 1:
                pts = pts * 2
            for a, b in zip(pts, pts[1:]):
                if len(a) == 3 and len(b) == 3:
                    lo, hi = min(a[2], b[2]), max(a[2], b[2])
                else:
                    lo = hi = None
                self.segs.append((a[0], a[1], b[0], b[1], w, lo, hi))
        max_w = max((sg[4] for sg in self.segs), default=0.0)
        self.reach = clearance + max_w + 1.5  # + the widest puppet's half-width
        self.cell = max(10.0, self.reach)
        c = self.cell
        for i, (ax, ay, bx, by, *_rest) in enumerate(self.segs):
            for gx in range(int(math.floor(min(ax, bx) / c)) - 1, int(math.floor(max(ax, bx) / c)) + 2):
                for gy in range(int(math.floor(min(ay, by) / c)) - 1, int(math.floor(max(ay, by) / c)) + 2):
                    self.grid.setdefault((gx, gy), []).append(i)

    def untimed(self) -> _KeepOut:
        """The same keep-out without its timed segments (in the way all run)."""
        k = _KeepOut([], self.clearance, self.window)
        for sg in self.segs:
            if sg[5] is None:
                k.segs.append(sg)
        k.reach, k.cell = self.reach, self.cell
        c = k.cell
        for i, (ax, ay, bx, by, *_rest) in enumerate(k.segs):
            for gx in range(int(math.floor(min(ax, bx) / c)) - 1, int(math.floor(max(ax, bx) / c)) + 2):
                for gy in range(int(math.floor(min(ay, by) / c)) - 1, int(math.floor(max(ay, by) / c)) + 2):
                    k.grid.setdefault((gx, gy), []).append(i)
        return k

    def hits(self, x: float, y: float, half_w: float, t: float | None = None) -> bool:
        cell = self.grid.get((int(math.floor(x / self.cell)), int(math.floor(y / self.cell))))
        if not cell:
            return False
        for i in cell:
            ax, ay, bx, by, w, lo, hi = self.segs[i]
            if t is not None and lo is not None and not (lo - self.window <= t <= hi + self.window):
                continue  # the actor is not there then
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            u = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
            px, py = ax + u * dx - x, ay + u * dy - y
            lim = self.clearance + w + half_w
            if px * px + py * py < lim * lim:
                return True
        return False


# ── Focus: traffic around the ego's route ───────────────────────────────────


def _write_trip_weights(
    net: Path, off, zone: _KeepOut | None, keepout: _KeepOut, prefix: Path
) -> tuple[list[str], _Blocked]:
    """Write randomTrips weight files and the blocked edges and turns.

    Weights: 1 for a drivable edge inside `zone`, else none; they REPLACE randomTrips' own edge
    filter, so its passenger and via-not-fringe rules are applied here. Blocked: edges the
    scenario's actors drive on and turns whose junction lane crosses one — never a start, end or
    stop, and 1000× the cost for duarouter. Turns are judged one by one.
    Returns (start/end edges, blocked edges and turns).
    """
    snet = _sumolib_net(net)
    to_carla = lambda x, y: (x - off[0], -(y - off[1]))  # noqa: E731
    usable, usable_via, blocked_edges, blocked_turns = [], [], [], set()

    def hits(shape):
        return any(keepout.hits(*to_carla(x, y), 1.0) for x, y in _densify(shape))

    for edge in snet.getEdges(withInternal=False):
        if not edge.allows("passenger"):
            continue
        for to_edge, conns in edge.getOutgoing().items():
            if any(c.getViaLaneID() and hits(snet.getLane(c.getViaLaneID()).getShape()) for c in conns):
                blocked_turns.add((edge.getID(), to_edge.getID()))
        if any(hits(lane.getShape()) for lane in edge.getLanes()):
            blocked_edges.append(edge)
            continue
        if zone is not None and not any(zone.hits(*to_carla(x, y), 0.0) for x, y in _densify(edge.getShape())):
            continue
        usable.append(edge.getID())
        if not edge.is_fringe():
            usable_via.append(edge.getID())
    for suffix, ids in ((".src.xml", usable), (".dst.xml", usable), (".via.xml", usable_via)):
        with open(str(prefix) + suffix, "w") as fh:
            fh.write('<edgedata>\n    <interval id="w" begin="0" end="1000000">\n')
            for eid in ids:
                fh.write(f'        <edge id="{eid}" value="1"/>\n')
            fh.write("    </interval>\n</edgedata>\n")
    with open(str(prefix) + ".route.xml", "w") as fh:
        fh.write('<meandata>\n    <interval id="w" begin="0" end="1000000">\n')
        for edge in blocked_edges:
            tt = 1000.0 * edge.getLength() / max(edge.getSpeed(), 1.0)
            fh.write(f'        <edge id="{edge.getID()}" traveltime="{tt:.1f}"/>\n')
        fh.write("    </interval>\n</meandata>\n")
    return usable, _Blocked({e.getID() for e in blocked_edges}, blocked_turns)


class _Blocked:
    def __init__(self, edges: set[str], turns: set[tuple[str, str]]):
        self.edges, self.turns = edges, turns

    def __len__(self):
        return len(self.edges) + len(self.turns)

    def route_ok(self, edges: list[str]) -> bool:
        return not (self.edges.intersection(edges) or any((a, b) in self.turns for a, b in zip(edges, edges[1:])))


def _drop_routes_using(routes: Path, blocked: _Blocked) -> int:
    """Remove vehicles whose route uses a blocked edge or turn (each would cost a re-simulation); returns how many."""
    tree = ET.parse(routes)
    root = tree.getroot()
    removed = 0
    for el in list(root):
        route = el.find("route") if el.tag == "vehicle" else None
        if route is not None and not blocked.route_ok(route.get("edges", "").split()):
            root.remove(el)
            removed += 1
    tree.write(routes)
    return removed


def _densify(shape, step=5.0):
    pts = []
    for (ax, ay), (bx, by) in zip(shape, shape[1:]):
        n = max(1, int(math.hypot(bx - ax, by - ay) // step))
        pts.extend((ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n))
    pts.append(shape[-1])
    return pts
