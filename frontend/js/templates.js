/**
 * templates.js — Scenario template definitions and placement flow.
 */
(function () {
  'use strict';

  // Acceleration/deceleration magnitude (m/s²) shared by every template that
  // ramps. Comfortable-but-brisk; well clear of the 0.1 floor _normalize_actor
  // applies to keep a rate event from never terminating.
  const RAMP_RATE = 5.0;

  class ScenarioTemplateManager {
    constructor() {
      this.templates = {
        // The four speed-profile templates below ramp rather than step: a
        // 'rate' set_speed ends when the commanded speed REACHES the target
        // (|dv|/rate seconds), so a hold after a ramp has to be a separate
        // 'time' event — see the set_speed dynamics table in CLAUDE.md.
        'vehicle-accelerating': {
          label: 'Beschleunigen',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._speedRampEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 15.0, RAMP_RATE),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 15.0, 5.0),
          ],
        },
        'vehicle-braking': {
          label: 'Bremsen',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._speedRampEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 5.0, RAMP_RATE),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 5.0, 5.0),
          ],
        },
        'vehicle-stopping': {
          label: 'Stoppen',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._speedRampEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, RAMP_RATE),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 0.0, 5.0),
          ],
        },
        'vehicle-stop-and-go': {
          label: 'Stop-and-Go',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._speedRampEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, RAMP_RATE),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 0.0, 1.0),
            this._speedRampEvent('evt-4', { type: 'after_event', event_id: 'evt-3' }, 5.0, RAMP_RATE),
            this._setSpeedEvent('evt-5', { type: 'after_event', event_id: 'evt-4' }, 5.0, 2.0),
          ],
        },
        'vehicle-lane-change-left': {
          label: 'Spurwechsel links',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._laneChangeEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 'left', 15.0),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 10.0, 5.0),
          ],
        },
        'vehicle-lane-change-right': {
          label: 'Spurwechsel rechts',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._laneChangeEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 'right', 15.0),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 10.0, 5.0),
          ],
        },
        'vehicle-pull-out': {
          label: 'Ausparken',
          actorType: 'car',
          placement: {
            snap: 'lane-center',
            laneTypes: ['driving', 'bidirectional', 'parking', 'shoulder'],
            maxDistance: 12,
          },
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 20 }, 5.0, 10.0),
            this._laneChangeEvent('evt-2', { type: 'distance_to_ego', value: 20 }, 'left', 10.0),
          ],
        },
        'pedestrian-crossing': {
          label: 'Fußgänger überqueren',
          actorType: 'pedestrian',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 50 }, 2.0, 10.0),
            this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, 5.0),
          ],
        },
        'pedestrian-along-lane': {
          label: 'Fußgänger seitwärts gehen',
          actorType: 'pedestrian',
          placement: { orientation: 'along-lane' },
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 2.0, 10.0),
          ],
        },
        'cyclist-crossing': {
          label: 'Radfahrer überqueren',
          actorType: 'cyclist',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 30 }, 4.0, 5.0),
            this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, 5.0),
          ],
        },
        'cyclist-along-lane': {
          label: 'Radfahrer seitwärts gehen',
          actorType: 'cyclist',
          placement: { orientation: 'along-lane' },
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 4.0, 10.0),
          ],
        },
      };
    }

    renderPanel() {
      return `
        <div class="templates-panel">
          ${this._sectionHtml('template-auto-body', 'Auto', [
            this._buttonHtml('Spurwechsel links', 'vehicle-lane-change-left'),
            this._buttonHtml('Spurwechsel rechts', 'vehicle-lane-change-right'),
            this._buttonHtml('Beschleunigen', 'vehicle-accelerating'),
            this._buttonHtml('Bremsen', 'vehicle-braking'),
            this._buttonHtml('Stoppen', 'vehicle-stopping'),
            this._buttonHtml('Stop-and-Go', 'vehicle-stop-and-go'),
            this._buttonHtml('Ausparken', 'vehicle-pull-out'),
          ])}
          ${this._sectionHtml('template-pedestrian-body', 'Fußgänger', [
            this._buttonHtml('Überqueren', 'pedestrian-crossing'),
            this._buttonHtml('Seitwärts gehen', 'pedestrian-along-lane'),
          ])}
          ${this._sectionHtml('template-cyclist-body', 'Radfahrer', [
            this._buttonHtml('Überqueren', 'cyclist-crossing'),
            this._buttonHtml('Seitwärts gehen', 'cyclist-along-lane'),
          ])}
        </div>
      `;
    }

    bindPanel(root) {
      root.querySelectorAll('[data-template-action]').forEach(btn => {
        btn.addEventListener('click', () => this.startPlacement(btn.dataset.templateAction));
      });
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
        triggerPointMode: null,
      });
      Toast.info(`${template.label}-Template: Akteur auf der Karte platzieren`);
    }

    eventsForActor(actor, templateId) {
      const template = this.templates[templateId];
      if (!template || actor?.type !== template.actorType) return [];
      return template.events.map(ev => JSON.parse(JSON.stringify(ev)));
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

    _buttonHtml(label, templateId) {
      return `<button class="template-action-button event-action-button" type="button" data-template-action="${templateId}">${label}</button>`;
    }

    _setSpeedEvent(id, trigger, speed, duration) {
      return {
        id,
        trigger,
        action: {
          type: 'set_speed',
          dynamics: { shape: 'step', dimension: 'time', value: duration },
          target: { mode: 'absolute', value: speed },
        },
      };
    }

    /** A ramp: `rate` m/s² until the target is reached, then the event ends. */
    _speedRampEvent(id, trigger, speed, rate) {
      return {
        id,
        trigger,
        action: {
          type: 'set_speed',
          // 'step' + 'rate' is self-contradictory; the backend forces 'linear'
          // for a rate event anyway, so state it here too.
          dynamics: { shape: 'linear', dimension: 'rate', value: rate },
          target: { mode: 'absolute', value: speed },
        },
      };
    }

    _laneChangeEvent(id, trigger, direction, distance) {
      return {
        id,
        trigger,
        action: {
          type: 'lane_change',
          direction,
          dynamics: { shape: 'linear', value: distance },
        },
      };
    }
  }

  window.ScenarioTemplates = new ScenarioTemplateManager();
})();
