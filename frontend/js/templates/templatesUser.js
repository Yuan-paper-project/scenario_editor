/**
 * templatesUser.js — user templates („Eigene Vorlagen"): storage, import/export, their panel section, and the actor-relative transform.
 *
 * Part of ScenarioTemplates; see templates.js (one class per file, each extending the last).
 */
(() => {
  'use strict';

  const { WAYPOINT_CLEARANCE, TemplatesGeometry } = TemplatesCore.shared;

  class TemplatesUser extends TemplatesGeometry {
    // ── User templates („Eigene Vorlagen") ───────────────────────────────────
    // A saved chain with positions relative to the actor and references as '$self'/'$ego',
    // stored as `user:N` entries with a build(), so everything else treats them as built-ins.
    // Per viewer, in localStorage (USER_KEY).

    _loadUserTemplates() {
      let list = [];
      try {
        list = JSON.parse(localStorage.getItem(USER_KEY) || '[]');
      } catch (_) {
        list = [];
      }
      if (!Array.isArray(list)) list = [];
      for (const id of Object.keys(this.templates)) if (id.startsWith('user:')) delete this.templates[id];
      for (const t of list) this._registerUser(t);
    }

    _registerUser(t) {
      if (!t || !t.actorType || !Array.isArray(t.events) || !t.id) return;
      this.templates[t.id] = {
        user: true,
        label: t.label || 'Eigene Vorlage',
        hint: `Eigene Vorlage: ${t.events.length} Event${t.events.length === 1 ? '' : 's'}, Positionen relativ zum Akteur`,
        actorType: t.actorType,
        initialSpeed: t.initialSpeed ?? null,
        stored: t,
        events: [],
        build: (actor) => _fromRelative(t.events, actor),
      };
    }

    userTemplates() {
      return Object.entries(this.templates)
        .filter(([, t]) => t.user)
        .map(([id, t]) => ({ id, ...t.stored }));
    }

    _saveUserTemplates() {
      const list = this.userTemplates();
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(list));
      } catch (_) {
        Toast.warn('Vorlagen konnten im Browser nicht gespeichert werden — als Datei exportieren');
      }
    }

    _nextUserId() {
      let n = 1;
      while (this.templates[`user:${n}`]) n++;
      return `user:${n}`;
    }

    /** Save `actor`'s chain as a template; refused if it names another NPC. New id or null. */
    saveFromActor(actor, label = null) {
      if (!actor || actor.type === 'ego' || actor.type === 'prop') return null;
      if (!(actor.events || []).length) {
        Toast.warn('Keine Events zum Speichern');
        return null;
      }
      const egoId = AppState.ego?.id;
      const rel = _toRelative(actor, egoId);
      if (rel.foreign.length) {
        Toast.error(`Nicht als Vorlage speicherbar: ${rel.foreign.join(', ')} verweist auf einen anderen Akteur`);
        return null;
      }
      const id = this._nextUserId();
      const kindLabel = AppState.typeLabel(actor.type);
      const n = this.userTemplates().length + 1;
      this._registerUser({
        id,
        label: label || `Eigene Vorlage ${n} (${kindLabel})`,
        actorType: actor.type,
        initialSpeed: actor.initial_speed ?? 0,
        events: rel.events,
        created: new Date().toISOString(),
      });
      this._saveUserTemplates();
      Toast.success(`„${this.templates[id].label}" gespeichert — im Tab Templates unter „Eigene Vorlagen"`);
      return id;
    }

    renameUser(id, label) {
      const t = this.templates[id];
      if (!t?.user || !String(label).trim()) return;
      t.label = String(label).trim();
      t.stored.label = t.label;
      this._saveUserTemplates();
    }

    deleteUser(id) {
      if (!this.templates[id]?.user) return;
      delete this.templates[id];
      this._saveUserTemplates();
    }

    exportUserTemplates() {
      const list = this.userTemplates().map(({ id, ...t }) => t);
      if (!list.length) {
        Toast.info('Keine eigenen Vorlagen zum Exportieren');
        return;
      }
      const blob = new Blob(
        [JSON.stringify({ kind: 'scenario-editor-templates', version: 1, templates: list }, null, 2)],
        { type: 'application/json' },
      );
      ScenarioIO.downloadBlob(blob, 'eigene_vorlagen.json');
    }

    /** Add every template in an exported file (new ids; nothing replaced). */
    importUserTemplates(data) {
      const list = Array.isArray(data) ? data : data?.templates;
      if (!Array.isArray(list)) {
        Toast.error('Keine Vorlagen in dieser Datei');
        return 0;
      }
      let n = 0;
      for (const t of list) {
        if (!t || !t.actorType || !Array.isArray(t.events)) continue;
        this._registerUser({ ...t, id: this._nextUserId() });
        n++;
      }
      this._saveUserTemplates();
      Toast.success(`${n} Vorlage${n === 1 ? '' : 'n'} importiert`);
      return n;
    }

    _userSectionHtml() {
      const rows = this.userTemplates()
        .map(
          (t) => `
        <div class="user-template-row" data-user-template="${t.id}">
          <input type="text" class="user-template-name" value="${UIUtils.escapeHtml(t.label)}" aria-label="Name der Vorlage"
                 title="Umbenennen">
          <button class="template-action-button event-action-button user-template-place" type="button"
                  data-template-action="${t.id}" title="${UIUtils.escapeHtml(this.templates[t.id].hint)} — Akteur auf der Karte platzieren">Platzieren</button>
          <button class="user-template-del" type="button" data-user-template-del="${t.id}" title="Vorlage löschen">✕</button>
        </div>`,
        )
        .join('');
      const empty = rows
        ? ''
        : '<p class="templates-hint">Noch keine. Einen Akteur mit Events auswählen und im Events-Bereich „Als Vorlage speichern".</p>';
      return `
        <div class="collapsible-section">
          <button class="collapsible-header" type="button" data-collapse-target="template-user-body">
            <span>Eigene Vorlagen</span><span class="collapse-indicator">-</span>
          </button>
          <div id="template-user-body" class="collapsible-body">
            ${empty}${rows}
            <div class="user-template-io">
              <button type="button" class="btn btn-small btn-secondary" data-user-template-export>Exportieren</button>
              <label class="btn btn-small btn-secondary">Importieren
                <input type="file" accept=".json,application/json" data-user-template-import hidden></label>
            </div>
          </div>
        </div>`;
    }
  }

  const USER_KEY = 'scenarioEditor.userTemplates';
  const _r1 = (v) => Math.round(v * 10) / 10;
  const _r2 = (v) => Math.round(v * 100) / 100;

  /** (x, y) in the actor's frame: +u along its heading, +v to its right (y-down). */
  function _toFrame(a, x, y) {
    const r = ((a.yaw || 0) * Math.PI) / 180,
      dx = x - a.x,
      dy = y - a.y;
    return { u: _r2(dx * Math.cos(r) + dy * Math.sin(r)), v: _r2(-dx * Math.sin(r) + dy * Math.cos(r)) };
  }
  function _fromFrame(a, u, v) {
    const r = ((a.yaw || 0) * Math.PI) / 180;
    return { x: _r1(a.x + u * Math.cos(r) - v * Math.sin(r)), y: _r1(a.y + u * Math.sin(r) + v * Math.cos(r)) };
  }

  /** Events in the actor's frame with '$self'/'$ego' references; `foreign` lists those naming another NPC. */
  function _toRelative(actor, egoId) {
    const foreign = [];
    const ref = (id, ev) => {
      if (!id || id === actor.id) return id ? '$self' : id;
      if (id === egoId) return '$ego';
      foreign.push(ev.name || ev.id);
      return id;
    };
    const events = (actor.events || []).map((ev0) => {
      const { collapsed, ...ev } = JSON.parse(JSON.stringify(ev0));
      const t = ev.trigger || {};
      if (t.point) {
        const f = _toFrame(actor, t.point.x, t.point.y);
        t.point = { ...t.point, u: f.u, v: f.v };
        delete t.point.x;
        delete t.point.y;
        delete t.point.z;
      }
      if (t.entity_ref) t.entity_ref = ref(t.entity_ref, ev);
      if (t.actor_ref) {
        if (t.actor_ref === actor.id) delete t.actor_ref;
        else ref(t.actor_ref, ev);
      }
      const a = ev.action || {};
      for (const k of ['trajectory', 'waypoints']) {
        if (Array.isArray(a[k]))
          a[k] = a[k].map((p) => {
            const f = _toFrame(actor, p.x, p.y);
            const { x, y, z, ...rest } = p;
            return { ...rest, u: f.u, v: f.v };
          });
      }
      if (a.target?.entity_ref) a.target.entity_ref = ref(a.target.entity_ref, ev);
      if (a.entity_ref && a.type === 'set_distance') a.entity_ref = ref(a.entity_ref, ev);
      return ev;
    });
    return { events, foreign: [...new Set(foreign)] };
  }

  /** A stored chain on `actor`'s pose: 'fastest' waypoints re-snapped, waypoint 0 on the actor, z re-derived. */
  function _fromRelative(events, actor) {
    const egoId = AppState.ego?.id || null;
    const deref = (id) => (id === '$self' ? actor.id : id === '$ego' ? egoId : id);
    const wpZ = (x, y) => _r2(ObjectsManager.groundZAt(x, y) + WAYPOINT_CLEARANCE);
    return JSON.parse(JSON.stringify(events)).map((ev) => {
      const t = ev.trigger || {};
      if (t.point && t.point.u !== undefined) {
        const w = _fromFrame(actor, t.point.u, t.point.v);
        const { u, v, ...rest } = t.point;
        t.point = { ...rest, x: w.x, y: w.y, z: wpZ(w.x, w.y) };
      }
      if (t.entity_ref) t.entity_ref = deref(t.entity_ref);
      const a = ev.action || {};
      if (Array.isArray(a.trajectory)) {
        a.trajectory = a.trajectory.map(({ u, v, ...rest }) => {
          const w = _fromFrame(actor, u, v);
          return { ...rest, x: w.x, y: w.y, z: wpZ(w.x, w.y) };
        });
      }
      if (Array.isArray(a.waypoints)) {
        a.waypoints = a.waypoints.map(({ u, v, ...rest }, i) => {
          const w = i === 0 ? { x: actor.x, y: actor.y } : _fromFrame(actor, u, v);
          if (i === 0 || (rest.strategy || 'fastest') === 'fastest') {
            const snap = ObjectsManager.routeWaypointAt(w.x, w.y);
            return { ...rest, x: snap.x, y: snap.y, z: snap.z };
          }
          return { ...rest, x: w.x, y: w.y, z: wpZ(w.x, w.y) };
        });
      }
      if (a.target?.entity_ref) a.target.entity_ref = deref(a.target.entity_ref);
      if (a.entity_ref && a.type === 'set_distance') a.entity_ref = deref(a.entity_ref);
      return ev;
    });
  }

  TemplatesCore.define({
    TemplatesUser,
  });
})();
