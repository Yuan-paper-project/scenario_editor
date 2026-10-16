/**
 * eventPanelPaths.js — path events: the waypoint list, waypoint marking, trajectory speed and the draw controls.
 *
 * Part of the event panel (EventPanel); see eventPanel.js.
 */
(() => {
  'use strict';

  const { eventList, panel, _eventAction, _trajectorySpeed } = EventPanelCore.shared;

  // ── Path Action Controls ────────────────────────────────────────────────────

  function _eventPathPoints(ev) {
    const action = _eventAction(ev);
    return action.type === 'assign_route' ? action.waypoints || [] : action.trajectory || [];
  }

  /** Render one path event's waypoint list into `target`. */
  function _renderPathList(actor, type, target, ev) {
    target.innerHTML = '';
    const points = _eventPathPoints(ev);
    const eventId = ev.id;
    const isRoute = type === 'route';

    if (points.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim);font-size:11px;padding:4px 0';
      empty.textContent = isRoute ? 'Noch keine Route gezeichnet.' : 'Noch kein Pfad gezeichnet.';
      target.appendChild(empty);
      return;
    }

    points.forEach((wp, i) => {
      const item = document.createElement('div');
      item.className = `waypoint-item${isRoute ? ' route-waypoint-item' : ''}`;
      // The same four attributes the map's waypoint groups carry — they are the
      // whole contract between the two halves, so a row and a marker can always
      // be matched up without either side knowing how the other is built.
      item.dataset.actorId = actor.id;
      item.dataset.eventId = eventId;
      item.dataset.pathType = type;
      item.dataset.wpIdx = i;
      // Focusable so Entf/Backspace reaches mapKeys.js's handler straight after a
      // click on the row: the guard there is "not inside a field", and a row is
      // not a field. Enter re-locates, matching the click.
      item.tabIndex = 0;
      item.title =
        i === 0
          ? 'Startpunkt — liegt auf dem Fahrzeug und folgt ihm'
          : 'Klicken, um auf der Karte zu zeigen · Entf löscht';

      const locate = () => {
        const sel = { actorId: actor.id, eventId, pathType: type, index: i };
        // The seed is shown but not marked. It is not interactive on the map
        // either, so a mark on it could only have come from here — and Entf
        // would then refuse to delete it, leaving the key dead on exactly one
        // row of the list. Flying the map to it still works.
        if (i > 0) AppState.selectWaypoint(sel);
        MapView.focusWaypoint(sel);
      };
      item.addEventListener('click', (e) => {
        // The row's own controls keep their clicks: the delete and strategy
        // buttons sit inside it.
        if (e.target.closest('button, input')) return;
        locate();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.target.closest('input')) return;
        e.preventDefault();
        locate();
      });

      const num = document.createElement('span');
      num.className = 'wp-num';
      num.textContent = i + 1;

      const coords = document.createElement('span');
      coords.className = 'wp-coords';
      coords.textContent = `(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`;

      // Waypoint 1 is the vehicle — it is seeded on the actor's pose and
      // tracks it, so it cannot be removed (ObjectsManager.deletePathPoint
      // refuses it too). Rendered as a hidden spacer rather than dropped, or
      // the row would be the only one in the list with a different right edge.
      const delBtn = document.createElement(i === 0 ? 'span' : 'button');
      delBtn.className = i === 0 ? 'wp-delete wp-delete-spacer' : 'wp-delete';
      if (i === 0) delBtn.setAttribute('aria-hidden', 'true');
      else delBtn.type = 'button';
      delBtn.textContent = '×';
      delBtn.title = i === 0 ? '' : 'Wegpunkt entfernen';
      if (i > 0) delBtn.setAttribute('aria-label', `Wegpunkt ${i + 1} entfernen`);
      if (i > 0)
        delBtn.addEventListener('click', () => {
          ObjectsManager.deletePathPoint(actor.id, type, i, eventId);
          // Indices past the deleted one all shift down, so a mark left as it is
          // would silently start naming the next point along — and Entf would
          // then delete something the user never marked.
          const sel = AppState.selectedWaypoint;
          if (sel && sel.actorId === actor.id && sel.eventId === eventId && sel.pathType === type && sel.index >= i) {
            const left = (AppState.waypointPathOf(sel) || []).length;
            AppState.selectWaypoint(left && sel.index > i ? { ...sel, index: sel.index - 1 } : null);
          }
        });

      item.appendChild(num);
      item.appendChild(coords);
      // A route waypoint's strategy governs the leg that ENDS at it, so the
      // toggle belongs to waypoints 2..N. Waypoint 1's leg runs from the
      // actor's own pose to itself and is empty, so a control there would
      // claim an effect it does not have — and 'Gerade' on waypoint 1 is the
      // one arrangement that kills a run on an unpatched ScenarioRunner.
      if (isRoute && i > 0) {
        const shortest = wp.strategy === 'shortest';
        const stratBtn = document.createElement('button');
        stratBtn.type = 'button';
        stratBtn.className = `wp-strategy${shortest ? ' is-shortest' : ''}`;
        stratBtn.textContent = shortest ? 'Gerade' : 'Spur';
        stratBtn.title = shortest
          ? 'Gerade Linie vom vorherigen Wegpunkt — klicken, um der Fahrspur zu folgen'
          : 'Folgt der Fahrspur ab dem vorherigen Wegpunkt — klicken für eine gerade Linie';
        stratBtn.setAttribute('aria-label', `Wegpunkt ${i + 1}: ${shortest ? 'gerade Linie' : 'Fahrspur'}`);
        stratBtn.addEventListener('click', () => {
          ObjectsManager.setPathPointStrategy(actor.id, i, shortest ? 'fastest' : 'shortest', eventId);
        });
        item.appendChild(stratBtn);
      }
      item.appendChild(delBtn);
      target.appendChild(item);
    });
  }

  /**
   * Put the `.waypoint-selected` class on the row the map's mark names, and
   * bring it into view — but only when the mark actually MOVED.
   *
   * The panel re-renders on every actorUpdated, which during a waypoint drag is
   * every mousemove; scrolling on each of those would fight the user for the
   * list's scroll position while they drag.
   */
  let _lastMarkKey = null;

  function syncWaypointSelection() {
    const sel = AppState.selectedWaypoint;
    const key = sel ? `${sel.actorId}:${sel.eventId}:${sel.pathType}:${sel.index}` : null;
    let marked = null;
    eventList.querySelectorAll('.waypoint-item').forEach((row) => {
      const d = row.dataset;
      const hit =
        !!sel &&
        d.actorId === sel.actorId &&
        d.eventId === sel.eventId &&
        d.pathType === sel.pathType &&
        Number(d.wpIdx) === sel.index;
      row.classList.toggle('waypoint-selected', hit);
      if (hit) marked = row;
    });
    if (marked && key !== _lastMarkKey) marked.scrollIntoView({ block: 'nearest' });
    _lastMarkKey = key;
  }

  function _appendTrajectorySpeedRow(card, actor, ev) {
    const points = _eventAction(ev).trajectory || [];
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'trajectory-speed-input';
    input.min = '0';
    input.max = '50';
    input.step = '0.5';
    input.value = UIUtils.fmt(_trajectorySpeed(points));
    input.disabled = points.length === 0;
    input.title = points.length
      ? 'Geschwindigkeit entlang des ganzen Pfads (CARLA fährt eine Trajektorie mit einer einzigen Geschwindigkeit)'
      : 'Erst einen Pfad zeichnen';
    input.addEventListener('change', (e) => {
      ObjectsManager.setPathVelocity(actor.id, e.target.value, ev.id);
    });
    card.appendChild(UIUtils.paramRow('Geschw.', input, 'm/s'));
  }

  function _appendEventPathControls(card, actor, ev) {
    const actionType = _eventAction(ev).type || 'follow_trajectory';
    const isRouteAction = actionType === 'assign_route';
    const pathMode = isRouteAction ? 'route' : 'trajectory';
    const pathPoints = _eventPathPoints(ev);
    const hasPath = pathPoints.length > 0;
    const visible = isRouteAction
      ? MapView.isRouteVisible(actor.id, ev.id)
      : MapView.isTrajectoryVisible(actor.id, ev.id);

    const controls = document.createElement('div');
    controls.className = `event-toggle event-path-controls${hasPath ? ' has-path' : ''}`;

    const drawBtn = document.createElement('button');
    drawBtn.type = 'button';
    drawBtn.textContent = 'Zeichnen';
    drawBtn.addEventListener('click', () => {
      ObjectsManager.startPathMode(actor.id, pathMode, ev.id);
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    // Quiet, not filled red: this used to be the strongest-looking button in
    // the card, louder than 'Zeichnen', which is the one people actually want.
    clearBtn.className = 'quiet-danger';
    clearBtn.textContent = 'Löschen';
    clearBtn.addEventListener('click', () => {
      ObjectsManager.clearPath(actor.id, pathMode, ev.id);
      panel.refresh();
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = visible ? 'Ausblenden' : 'Anzeigen';
    // Ausblenden hides the path outright, selected or not. The way back is
    // either this button or working on the path — drawing it, or clicking one
    // of its waypoints below, both un-hide it (MapView.showPath).
    toggleBtn.title = visible
      ? 'Pfad auf der Karte ausblenden'
      : 'Pfad wieder einblenden — Zeichnen oder das Anklicken eines ' + 'Wegpunkts blendet ihn ebenfalls wieder ein.';
    toggleBtn.addEventListener('click', () => {
      if (isRouteAction) MapView.toggleRouteVisibility(actor.id, ev.id);
      else MapView.toggleTrajectoryVisibility(actor.id, ev.id);
      panel.refresh();
    });

    controls.appendChild(drawBtn);
    if (hasPath) {
      controls.appendChild(toggleBtn);
      controls.appendChild(clearBtn);
    }
    card.appendChild(controls);
  }

  // A mark set on the map has to light up the matching row without rebuilding
  // the panel: the rebuild would happen anyway on the next actorUpdated, but a
  // click on a marker is not an edit and must not cost a full re-render.
  AppState.on('change', (patch) => {
    if ('selectedWaypoint' in patch) syncWaypointSelection();
  });

  EventPanelCore.define({
    _renderPathList,
    syncWaypointSelection,
    _appendTrajectorySpeedRow,
    _appendEventPathControls,
  });
})();
