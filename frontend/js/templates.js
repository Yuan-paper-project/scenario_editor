/**
 * templates.js — Scenario template definitions and placement flow.
 *
 * A template is one actor plus a pre-filled event chain. Most chains are
 * fixed data (`events`); the ones whose shape depends on WHERE the actor was
 * dropped — how wide the road is that a pedestrian crosses, which driving lane
 * a parked car pulls out into — carry a `build(actor)` instead, which
 * objects.js runs at the click with the actor's final pose. A builder that
 * cannot make sense of the spot (no road to cross, no lane to pull out into)
 * falls back to its `events`, and says so with a toast.
 *
 * `initialSpeed` is the actor's Start (m/s). It defaults to the first
 * set_speed's target for a vehicle and to 0 for everything that must wait for
 * its trigger: an Init <SpeedAction> lands on tick 1, long before any
 * distance trigger, so a crossing pedestrian with a start speed is across the
 * road before the ego is anywhere near it.
 */
(() => {
  'use strict';

  const { TemplatesUser } = TemplatesCore.shared;

  class ScenarioTemplateManager extends TemplatesUser {
    renderPanel() {
      return `
        <div class="templates-panel">
          <p class="templates-hint">Template wählen, dann Akteur auf der Karte platzieren. Wege und Dauern werden am Klickpunkt aus der Straße berechnet. <a class="help-link" href="/static/help.html#templates" target="_blank" rel="noopener" title="Handbuch: Templates" aria-label="Handbuch: Templates">?</a></p>
          ${this._generatorSectionHtml()}
          ${this._userSectionHtml()}
          ${this._sectionHtml('template-auto-body', 'Auto · Spur & Position', [
            this._buttonHtml('Spurwechsel links', 'vehicle-lane-change-left'),
            this._buttonHtml('Spurwechsel rechts', 'vehicle-lane-change-right'),
            this._buttonHtml('Einscheren', 'vehicle-cut-in'),
            this._buttonHtml('Schlenker links', 'vehicle-lane-drift'),
            this._buttonHtml('Ausparken', 'vehicle-pull-out'),
            this._buttonHtml('Pannenfahrzeug', 'vehicle-parked'),
          ])}
          ${this._sectionHtml('template-auto-speed-body', 'Auto · Tempo', [
            this._buttonHtml('Beschleunigen', 'vehicle-accelerating'),
            this._buttonHtml('Bremsen', 'vehicle-braking'),
            this._buttonHtml('Stoppen', 'vehicle-stopping'),
            this._buttonHtml('Stop-and-Go', 'vehicle-stop-and-go'),
            this._buttonHtml('Notbremsung', 'vehicle-emergency-brake'),
          ])}
          ${this._sectionHtml('template-pedestrian-body', 'Fußgänger', [
            this._buttonHtml('Überqueren', 'pedestrian-crossing'),
            this._buttonHtml('Bleibt stehen', 'pedestrian-stop-in-lane'),
            this._buttonHtml('Am Rand entlang', 'pedestrian-along-lane'),
            this._buttonHtml('Kind läuft raus', 'child-runs-out'),
          ])}
          ${this._sectionHtml('template-cyclist-body', 'Radfahrer', [
            this._buttonHtml('Überqueren', 'cyclist-crossing'),
            this._buttonHtml('Am Rand entlang', 'cyclist-along-lane'),
          ])}
        </div>
      `;
    }

    bindPanel(root) {
      root.querySelectorAll('[data-template-action]').forEach((btn) => {
        btn.addEventListener('click', () => this.startPlacement(btn.dataset.templateAction));
      });
      root.querySelectorAll('[data-generate-here]').forEach((btn) => {
        btn.addEventListener('click', () => ScenarioGenerator.armAt(btn.dataset.generateHere || null));
      });
      const rerender = () => AppState.emit('change', { userTemplates: true });
      root.querySelectorAll('[data-user-template]').forEach((row) => {
        const id = row.dataset.userTemplate;
        row.querySelector('.user-template-name').addEventListener('change', (e) => this.renameUser(id, e.target.value));
        row.querySelector('[data-user-template-del]').addEventListener('click', async (e) => {
          const label = this.templates[id]?.label || '';
          if (!(e.ctrlKey || e.metaKey) && !(await Confirm.show(`Vorlage „${label}" löschen?`))) return;
          this.deleteUser(id);
          rerender();
        });
      });
      root.querySelector('[data-user-template-export]')?.addEventListener('click', () => this.exportUserTemplates());
      root.querySelector('[data-user-template-import]')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          this.importUserTemplates(JSON.parse(await file.text()));
        } catch (_) {
          Toast.error('Datei ist kein gültiges JSON');
        }
        rerender();
      });
    }

    /**
     * The generator's conflict types as place-able templates ("Generate
     * here"): unlike the one-actor templates below, each builds a whole
     * scenario — ego, route, conflict actors, green wave — around the clicked
     * spot, with its timing solved against the ego and scored. It REPLACES the
     * scenario, which the button titles say.
     */
    _generatorSectionHtml() {
      const types = (window.ScenarioGenerator && ScenarioGenerator.TYPES) || {};
      const btn = (label, key, title) =>
        `<button class="template-action-button event-action-button" type="button" data-generate-here="${key}" title="${title}">${label}</button>`;
      const buttons = [
        btn('Beliebig', '', 'Zufälliger Konflikttyp an der angeklickten Stelle — ersetzt das Szenario'),
        ...Object.entries(types).map(([key, label]) =>
          btn(
            label,
            key,
            `${label}: ganzes Szenario (Ego, Route, Gegenspieler) um die angeklickte Stelle erzeugen — ersetzt das Szenario`,
          ),
        ),
      ];
      return this._sectionHtml('template-generate-body', 'Konflikt hier erzeugen', buttons);
    }

    startPlacement(templateId) {
      const template = this.templates[templateId];
      if (!template) return;
      AppState.set({
        activeTool: template.actorType,
        pendingTemplate: templateId,
        trajectoryMode: false,
        activeTrajectoryId: null,
        routeMode: false,
        activeRouteId: null,
        activePathEventId: null,
      });
      Toast.info(`${template.label}-Template: Akteur auf der Karte platzieren`);
    }

    /** The event chain for `actor`, built for its pose when the template can. */
    eventsForActor(actor, templateId) {
      const template = this.templates[templateId];
      if (!template || actor?.type !== template.actorType) return [];
      if (template.build) {
        let built = null;
        try {
          built = template.build(actor);
        } catch (err) {
          console.warn('[templates]', err);
        }
        if (built) return built;
        Toast.warn(`${template.label}: keine passende Straße am Klickpunkt — Standardablauf eingesetzt`);
      }
      return template.events.map((ev) => JSON.parse(JSON.stringify(ev)));
    }

    /** The template's Start (m/s), or null when the editor default applies. */
    initialSpeedFor(templateId) {
      const template = this.templates[templateId];
      if (!template) return null;
      if (template.initialSpeed != null) return template.initialSpeed;
      // Vehicles start at the speed their first event sets anyway, so the
      // chain does not open with a jump; walkers and cyclists wait.
      if (MapView.isWalkerType(template.actorType) || template.actorType === 'cyclist') return 0;
      const first = template.events.find((ev) => ev.action.type === 'set_speed');
      return first ? first.action.target.value : 0;
    }

    /**
     * Templates whose chain makes sense on an already-placed actor of this
     * type, for the event panel's "Ablauf aus Template" picker. Vehicle chains
     * go on any vehicle; walker chains (set_speed along the spawn heading) on
     * walkers only — a cyclist is a <Vehicle> and rides along the lane under
     * set_speed — and cyclist chains on cyclists. Never the ego: every chain
     * here waits on distance_to_ego, which on the ego itself is coerced to t=0.
     */
    compatibleWith(actorType) {
      if (!actorType || actorType === 'ego' || actorType === 'prop') return [];
      const kind = _templateKind(actorType);
      return Object.entries(this.templates)
        .filter(([, t]) => _templateKind(t.actorType) === kind)
        .map(([id, t]) => ({ id, label: t.label, hint: t.hint || '' }));
    }

    /**
     * Replaces `actor`'s events with the template's chain, built for its
     * current pose, and sets the template's start speed — one updateById, so
     * one undo entry. Asks first when the actor already has events.
     */
    async applyTo(actor, templateId) {
      const template = this.templates[templateId];
      if (!actor || !template) return false;
      const n = (actor.events || []).length;
      if (
        n &&
        !(await Confirm.show(
          `${n} Event${n === 1 ? '' : 's'} von ${AppState.actorLabel(actor, { short: true })} durch „${template.label}" ersetzen?`,
        ))
      ) {
        return false;
      }
      const current = AppState.findById(actor.id) || actor;
      // eventsForActor matches the template's own type; a van takes a car chain.
      const events = this.eventsForActor({ ...current, type: template.actorType }, templateId);
      const patch = { events };
      const v0 = this.initialSpeedFor(templateId);
      if (v0 != null) patch.initial_speed = v0;
      AppState.updateById(current.id, patch);
      Toast.success(`„${template.label}" auf ${AppState.actorLabel(current, { short: true })} angewendet`);
      return true;
    }

    label(templateId) {
      return this.templates[templateId]?.label || '';
    }

    placementFor(templateId) {
      const placement = this.templates[templateId]?.placement;
      return placement ? JSON.parse(JSON.stringify(placement)) : null;
    }

    _sectionHtml(bodyId, title, buttons) {
      return `
        <div class="collapsible-section">
          <button class="collapsible-header" type="button" data-collapse-target="${bodyId}">
            <span>${title}</span><span class="collapse-indicator">-</span>
          </button>
          <div id="${bodyId}" class="collapsible-body">
            <div class="template-action-grid event-action-grid">
              ${buttons.join('')}
            </div>
          </div>
        </div>
      `;
    }

    /** Every button carries its template's `hint` as the hover text. */
    _buttonHtml(label, templateId) {
      const hint = this.templates[templateId]?.hint || '';
      const t = hint ? ` title="${hint.replace(/"/g, '&quot;')}"` : '';
      return `<button class="template-action-button event-action-button" type="button" data-template-action="${templateId}"${t}>${label}</button>`;
    }
  }

  function _templateKind(type) {
    if (type === 'cyclist') return 'cyclist';
    if (type === 'pedestrian' || type === 'child') return 'walker';
    return 'vehicle';
  }

  window.ScenarioTemplates = new ScenarioTemplateManager();
  ScenarioTemplates._loadUserTemplates();
})();
