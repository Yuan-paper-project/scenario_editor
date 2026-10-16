/**
 * scenarioGenerator.js — one-click random scenarios on the loaded map.
 *
 * Random events on their own almost never make a test: the other actor drives
 * off somewhere and never meets the ego. So nothing here is random at the
 * level of "pick an action". A generator is a SCENARIO TYPE (lead vehicle
 * brakes, cut-in, crossing pedestrian, junction cross traffic, obstacle) with
 * three parts:
 *
 *   1. a site query against the map — the lane graph's same-direction
 *      neighbours for a cut-in, crossing connector lanes for a junction
 *      conflict, the carriageway edge for a crossing pedestrian;
 *   2. parameter ranges (speeds, gaps, decelerations, timing offsets) drawn
 *      from one seeded RNG, so a seed reproduces the scenario exactly;
 *   3. timing that is relative to the EGO, never to the clock.
 *
 * Point 3 is what keeps a generated scenario meaningful when an AV under test
 * drives the ego instead of simple_vehicle_control: every NPC event starts on
 * `distance_to_ego`, with the radius solved from a target time-to-conflict, so
 * the conflict happens wherever and whenever the ego actually arrives. The ego
 * still gets an `assign_route` and a start speed, so the same file also runs
 * with the scripted controller.
 *
 * Everything starts from an ego CORRIDOR: a lane-centre polyline walked
 * forward through the lane graph from a random start, picking a random
 * successor at each fork. The ego's route waypoints are placed on the lane
 * just past each junction, which pins the turn the corridor took; the
 * computed route (Simulate.routeGeometry, i.e. what the preview and CARLA's
 * router would drive) is then checked against the corridor and the attempt is
 * thrown away if they disagree.
 *
 * Needs AppState.laneGraph, which every town has (a probed one or the
 * from-.xodr build in backend/lane_graph_builder.py).
 */
(() => {
  'use strict';

  const {
    Rng,
    _ctx,
    EGO_SPEED,
    PARAMS,
    TYPES,
    assess,
    build,
    generate,
    sceneSignature,
    recipeEdited,
    rebuild,
    SWEEP_MAX,
    _sweepValues,
    sweepFromRecipe,
    _runSweep,
    WEATHER_PRESETS,
    _weatherOf,
    coveragePlan,
    generateBatch,
    _openBatch,
  } = GeneratorCore.shared;

  // ── Recipe panel (Übersicht tab) ─────────────────────────────────────────────
  //
  // The generated scenario's parameters as editable fields. Changing one pins
  // it and rebuilds the scenario on the same site and seed; „Variante würfeln"
  // keeps the pins and draws everything else afresh. Rendered by propertiesOverview.js
  // (recipeHtml / bindRecipe), like the template panel.

  const _escHtml = (v) =>
    String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** The value the build actually used — not the pin, which the site may
   * not have allowed (an occluder needs a parking lane; a lead faster than
   * the ego is capped). _recipeMismatch says when the two differ. */
  function _recipeValue(r, spec) {
    const v = r.params?.[spec.key];
    if (spec.kind === 'bool') return !!v;
    if (spec.kind === 'num') {
      if (v === null || v === undefined || v === false) return spec.key === 'stops_in_lane_s' ? 0 : '';
      return v;
    }
    return v ?? '';
  }

  function _recipeControl(r, spec) {
    const v = _recipeValue(r, spec);
    const attr = `data-recipe-key="${spec.key}" aria-label="${_escHtml(spec.label)}"`;
    if (spec.kind === 'bool') return `<input type="checkbox" ${attr}${v ? ' checked' : ''}>`;
    if (spec.kind === 'choice') {
      const opts = spec.options
        .map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${_escHtml(l)}</option>`)
        .join('');
      return `<select ${attr}>${opts}</select>`;
    }
    return `<input type="number" ${attr} min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${v === '' ? '' : _escHtml(v)}">`;
  }

  function _recipeMismatch(r, spec) {
    if (!Object.hasOwn(r.overrides || {}, spec.key)) return false;
    const want = r.overrides[spec.key],
      got = _recipeValue(r, spec);
    if (spec.kind === 'num') return got === '' || Math.abs(Number(got) - want) > spec.step / 2 + 1e-6;
    return got !== want;
  }

  /** The recipe block for the overview panel, or '' when nothing generated. */
  function recipeHtml() {
    const r = AppState.generated;
    if (!r || !PARAMS[r.type]) return '';
    const pins = r.overrides || {};
    // A parameter this build never used (the person type of a breakdown, the
    // vehicle of a standing pedestrian) is left out unless it is pinned: a
    // select with no matching option would show its first one as if it had
    // been chosen.
    const used = (spec) => spec === EGO_SPEED || r.params?.[spec.key] !== undefined || Object.hasOwn(pins, spec.key);
    const rows = [EGO_SPEED, ...PARAMS[r.type]]
      .filter(used)
      .map((spec) => {
        const pinned = Object.hasOwn(pins, spec.key);
        const unpin = pinned
          ? `<button type="button" class="gen-recipe-unpin" data-recipe-unpin="${spec.key}" title="Festgelegten Wert lösen — wieder zufällig aus dem Seed">×</button>`
          : '<span></span>';
        const miss = _recipeMismatch(r, spec);
        const missTitle = miss
          ? ` title="Festgelegt auf ${_escHtml(spec.kind === 'choice' ? (spec.options.find(([k]) => k === pins[spec.key]) || [, pins[spec.key]])[1] : pins[spec.key])}, an dieser Stelle nicht möglich"`
          : '';
        return `<div class="gen-recipe-row${pinned ? ' pinned' : ''}${miss ? ' unmet' : ''}" data-recipe-row="${spec.key}">
        <span class="gen-recipe-label"${missTitle}>${_escHtml(spec.label)}${miss ? ' ⚠' : ''}</span>
        ${_recipeControl(r, spec)}
        <span class="gen-recipe-unit">${_escHtml(spec.unit || '')}</span>
        ${unpin}
      </div>`;
      })
      .join('');
    const wrongTown = r.town && r.town !== AppState.map;
    const warn = wrongTown
      ? `<div class="gen-recipe-warn">Gebaut auf ${_escHtml(r.town)} — Karte wechseln, um neu zu bauen.</div>`
      : recipeEdited()
        ? '<div class="gen-recipe-warn">Seit dem Generieren von Hand bearbeitet — eine Änderung hier baut neu und verwirft das.</div>'
        : '';
    return `<div class="gen-recipe" data-recipe>
      <div class="summary-section">Generiert</div>
      <div class="gen-recipe-head"><b>${_escHtml(r.label)}</b><span>Seed ${_escHtml(r.seed)}</span></div>
      ${warn}
      <div class="gen-recipe-grid">${rows}</div>
      <div class="gen-recipe-actions">
        <button type="button" class="btn btn-small btn-secondary" data-recipe-variant
                title="Neuer Seed an derselben Stelle; fest eingestellte Werte bleiben">Variante würfeln</button>
      </div>
      ${wrongTown ? '' : _sweepHtml(r)}
      <div class="summary-hint">Ein geänderter Wert wird festgelegt (●) und das Szenario an derselben Stelle neu gebaut.</div>
    </div>`;
  }

  // Remembered across re-renders: the overview rebuilds its innerHTML wholesale.
  const _sweepUi = { open: false, key: null, from: null, to: null, steps: 5, weathers: false };

  function _sweepHtml(r) {
    const specs = [EGO_SPEED, ...PARAMS[r.type]];
    if (!specs.some((sp) => sp.key === _sweepUi.key)) {
      const firstNum = specs.find((sp) => sp.kind === 'num' && sp.key !== 'ego_speed') || specs[0];
      Object.assign(_sweepUi, { key: firstNum.key, from: firstNum.min, to: firstNum.max });
    }
    const spec = specs.find((sp) => sp.key === _sweepUi.key);
    const values = _sweepValues(spec, _sweepUi.from, _sweepUi.to, _sweepUi.steps);
    const total = Math.min(SWEEP_MAX, values.length * (_sweepUi.weathers ? Object.keys(WEATHER_PRESETS).length : 1));
    const opts = specs
      .map((sp) => `<option value="${sp.key}"${sp.key === spec.key ? ' selected' : ''}>${_escHtml(sp.label)}</option>`)
      .join('');
    const range =
      spec.kind === 'num'
        ? `<label>Von</label><input type="number" data-sweep-from min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${_sweepUi.from}">
         <label>Bis</label><input type="number" data-sweep-to min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${_sweepUi.to}">
         <label>Werte</label><input type="number" data-sweep-steps min="2" max="25" step="1" value="${_sweepUi.steps}">`
        : `<span class="gen-sweep-all">alle Werte: ${values.map((v) => _escHtml(spec.kind === 'bool' ? (v ? 'ja' : 'nein') : spec.options.find(([k]) => k === v)[1])).join(', ')}</span>`;
    return `<details class="gen-sweep" data-sweep${_sweepUi.open ? ' open' : ''}>
      <summary>Serie exportieren</summary>
      <div class="gen-sweep-grid">
        <label>Parameter</label><select data-sweep-key>${opts}</select>
        ${range}
      </div>
      <label class="gen-sweep-weather"><input type="checkbox" data-sweep-weather${_sweepUi.weathers ? ' checked' : ''}> × alle Wetter (${Object.keys(WEATHER_PRESETS).length})</label>
      <div class="gen-recipe-actions">
        <button type="button" class="btn btn-small btn-primary" data-sweep-run
                title="Ein Szenario pro Wert an derselben Stelle, als ZIP mit manifest">${total} Szenarien exportieren</button>
      </div>
    </details>`;
  }

  async function _confirmDiscardEdits() {
    if (!recipeEdited()) return true;
    return Confirm.show('Von Hand gemachte Änderungen am Szenario verwerfen und neu bauen?', 'Neu bauen');
  }

  /** Wire the block recipeHtml() rendered. `rerender` redraws the panel, so
   * a rebuild that failed shows the old values again. */
  function bindRecipe(root, rerender) {
    const box = root.querySelector('[data-recipe]');
    if (!box) return;
    const r = AppState.generated;
    const specs = Object.fromEntries([EGO_SPEED, ...(PARAMS[r?.type] || [])].map((sp) => [sp.key, sp]));
    const run = async (changes, opts) => {
      if (!(await _confirmDiscardEdits())) {
        rerender();
        return;
      }
      if (!rebuild(changes, opts)) rerender();
    };
    box.querySelectorAll('[data-recipe-key]').forEach((el) => {
      el.addEventListener('change', () => {
        const spec = specs[el.dataset.recipeKey];
        if (!spec) return;
        let v;
        if (spec.kind === 'bool') v = el.checked;
        else if (spec.kind === 'num') {
          if (el.value === '') {
            rerender();
            return;
          }
          v = Math.min(spec.max, Math.max(spec.min, Number(el.value)));
        } else v = el.value;
        run({ [spec.key]: v });
      });
    });
    box.querySelectorAll('[data-recipe-unpin]').forEach((btn) => {
      btn.addEventListener('click', () => run({ [btn.dataset.recipeUnpin]: null }));
    });
    box.querySelector('[data-recipe-variant]')?.addEventListener('click', () => run({}, { newSeed: true }));

    const sweep = box.querySelector('[data-sweep]');
    if (!sweep) return;
    // Recorded on the summary click, not on 'toggle': toggle is dispatched as a
    // later task, and a panel re-render in between draws the box closed again.
    sweep.querySelector('summary').addEventListener('click', () => {
      _sweepUi.open = !sweep.open;
    });
    sweep.querySelector('[data-sweep-key]').addEventListener('change', (e) => {
      const sp = specs[e.target.value];
      Object.assign(_sweepUi, { key: sp.key, from: sp.min, to: sp.max });
      rerender();
    });
    for (const [attr, field] of [
      ['data-sweep-from', 'from'],
      ['data-sweep-to', 'to'],
      ['data-sweep-steps', 'steps'],
    ]) {
      sweep.querySelector(`[${attr}]`)?.addEventListener('change', (e) => {
        _sweepUi[field] = Number(e.target.value);
        rerender();
      });
    }
    sweep.querySelector('[data-sweep-weather]').addEventListener('change', (e) => {
      _sweepUi.weathers = e.target.checked;
      rerender();
    });
    sweep.querySelector('[data-sweep-run]').addEventListener('click', () => _runSweep({ ..._sweepUi }));
  }

  // ── Header menu ──────────────────────────────────────────────────────────────

  function _hasScenario() {
    return !!(AppState.ego || AppState.npcs.length || AppState.staticObjects.length);
  }

  /** Generating replaces the whole scenario. It is one undo step, but a
   * scenario that took an hour to author deserves a question first —
   * Strg/Cmd skips it, the app-wide "skip the confirm" modifier. */
  async function _confirmReplace(e) {
    if (!_hasScenario() || e.ctrlKey || e.metaKey) return true;
    return Confirm.show('Aktuelles Szenario durch ein generiertes ersetzen?', 'Ersetzen');
  }

  function _seedFromField() {
    const seedField = document.getElementById('gen-seed');
    return seedField?.value ? Number(seedField.value) : null;
  }

  /** A used seed is cleared so the next click makes a new scenario; the seed
   * that was used is in the toast and on the menu button's tooltip. */
  function _noteUsedSeed(info) {
    const seedField = document.getElementById('gen-seed');
    if (!info || !seedField) return;
    seedField.value = '';
    document.getElementById('gen-menu-btn').title =
      `Zufälliges Szenario erzeugen — zuletzt: ${info.label}, Seed ${info.seed}`;
  }

  /** Arm "Generate here": the next map click builds `typeKey` (null = any
   * type) at that spot. Esc disarms, like every other placement mode. */
  function armAt(typeKey = null) {
    if (!AppState.mapData) {
      Toast.error('Zuerst eine Karte laden');
      return;
    }
    if (typeKey && !TYPES[typeKey]) return;
    AppState.cancelPlacement({ pendingGenerate: typeKey || 'any' });
    Toast.info(
      `„${typeKey ? TYPES[typeKey].label : 'Beliebiger Typ'}": Stelle des Konflikts auf der Karte anklicken (Esc bricht ab)`,
    );
  }

  async function generateAtClick(x, y, e) {
    const pending = AppState.pendingGenerate;
    if (!pending) return null;
    const typeKey = pending === 'any' ? null : pending;
    AppState.cancelPlacement();
    if (!(await _confirmReplace(e))) return null;
    const info = generate(typeKey, _seedFromField(), { near: { x, y } });
    // No site here: stay armed, so the next click tries another spot.
    if (!info) AppState.set({ pendingGenerate: pending });
    _noteUsedSeed(info);
    return info;
  }

  async function _onMenuPick(e, typeKey) {
    if (document.getElementById('gen-pick-spot')?.checked) {
      armAt(typeKey);
      return;
    }
    if (!(await _confirmReplace(e))) return;
    _noteUsedSeed(generate(typeKey, _seedFromField()));
  }

  (function _bindMenu() {
    const holder = document.getElementById('gen-menu-types');
    if (!holder) return;
    const row = (label, key, extraClass = '') => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `menu-item ${extraClass}`.trim();
      btn.setAttribute('role', 'menuitem');
      btn.dataset.menuItem = '';
      btn.textContent = label;
      btn.title = 'Strg+Klick ersetzt ohne Rückfrage';
      btn.addEventListener('click', (e) => _onMenuPick(e, key));
      holder.appendChild(btn);
    };
    row('Beliebiger Typ', null, 'gen-any');
    for (const [key, t] of Object.entries(TYPES)) row(t.label, key);
    const batch = document.createElement('button');
    batch.type = 'button';
    batch.className = 'menu-item gen-batch-item';
    batch.setAttribute('role', 'menuitem');
    batch.dataset.menuItem = '';
    batch.textContent = 'Mehrere generieren …';
    batch.title = 'Viele Szenarien auf einmal erzeugen und als ZIP herunterladen';
    batch.addEventListener('click', _openBatch);
    holder.appendChild(batch);
  })();

  window.ScenarioGenerator = {
    TYPES: Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, t.label])),
    build,
    generate,
    assess,
    generateBatch,
    armAt,
    generateAtClick,
    rebuild,
    recipeHtml,
    bindRecipe,
    sweepFromRecipe,
    sceneSignature,
    recipeEdited,
    PARAMS: Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, [EGO_SPEED, ...v].map((sp) => sp.key)])),
    weatherPreset: _weatherOf,
    WEATHER_PRESETS: Object.keys(WEATHER_PRESETS),
    coveragePlan(n, dims, seed = 1) {
      return coveragePlan(n, dims, new Rng(seed));
    },
    get lastInfo() {
      return _ctx.lastInfo;
    },
  };
})();
