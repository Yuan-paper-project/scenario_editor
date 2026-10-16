/**
 * generatorBatchDialog.js — the „Mehrere generieren" dialog.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const { TYPES, CARLA_TOWNS, generateBatch } = GeneratorCore.shared;

  // ── Batch dialog ─────────────────────────────────────────────────────────────

  let _batchRunning = false;
  let _batchCancel = false;

  // Typ and Karten are checkbox dropdowns like Ebenen; the checkboxes are the state, kept between
  // openings (the panel is rebuilt only when its options change).
  const _multiSelects = {};

  function _multiSelect(id, opts) {
    const wrap = document.getElementById(id);
    let ms = _multiSelects[id];
    if (!ms) {
      const button = wrap.querySelector('.multi-select-btn');
      const panel = wrap.querySelector('.multi-select-panel');
      ms = _multiSelects[id] = {
        wrap,
        button,
        panel,
        list: wrap.querySelector('.multi-select-options'),
        dd: Dropdown.bind({ button, panel, wrap }),
        boxes: () => [...wrap.querySelectorAll('.multi-select-options input')],
        values: () =>
          ms
            .boxes()
            .filter((b) => b.checked)
            .map((b) => b.value),
        set: (pred) => {
          ms.boxes().forEach((b) => {
            b.checked = !!pred(b.value);
          });
          ms.refresh();
        },
        refresh() {
          const boxes = ms.boxes(),
            on = boxes.filter((b) => b.checked);
          wrap.querySelector('.multi-select-count').textContent = `${on.length}/${boxes.length}`;
          wrap.querySelector('.multi-select-summary').textContent = !on.length
            ? 'Keine Auswahl'
            : on.length === boxes.length
              ? `Alle ${ms.noun}`
              : on.length === 1
                ? on[0].dataset.label
                : `${on.length} ${ms.noun}`;
        },
      };
      panel.addEventListener('change', () => ms.refresh());
      panel.addEventListener('click', (e) => {
        if (e.target.closest('[data-ms-all]')) ms.set(() => true);
        else if (e.target.closest('[data-ms-none]')) ms.set(() => false);
        else if (e.target.closest('[data-ms-carla]')) ms.set((v) => CARLA_TOWNS.includes(v));
      });
    }
    ms.noun = opts.noun;
    const sig = opts.items.map((it) => it.value).join('|');
    if (ms.sig !== sig) {
      const prev = ms.sig ? new Set(ms.values()) : null;
      ms.list.innerHTML = '';
      for (const it of opts.items) {
        const row = document.createElement('label');
        row.className = 'layer-toggle';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = it.value;
        box.dataset.label = it.label;
        box.checked = prev ? prev.has(it.value) : opts.checked(it.value);
        row.append(box, document.createTextNode(' ' + it.label));
        if (it.note) {
          const note = document.createElement('span');
          note.className = 'multi-select-note';
          note.textContent = it.note;
          row.append(note);
        }
        ms.list.append(row);
      }
      ms.sig = sig;
      if (!ms.values().length) ms.set(opts.checked);
    }
    ms.refresh();
    return ms;
  }

  function _openBatch() {
    if (!AppState.mapData) {
      Toast.error('Zuerst eine Karte laden');
      return;
    }
    _multiSelect('gen-batch-type', {
      noun: 'Typen',
      items: Object.entries(TYPES).map(([key, t]) => ({ value: key, label: t.label })),
      checked: () => true,
    });
    const towns = [...document.getElementById('map-select').options].map((o) => o.value).filter(Boolean);
    const maps = _multiSelect('gen-batch-maps', {
      noun: 'Karten',
      items: towns.map((t) => ({ value: t, label: t, note: CARLA_TOWNS.includes(t) ? '' : 'nicht in CARLA' })),
      checked: (t) => t === AppState.map,
    });
    if (!maps.values().length) maps.set((t) => t === AppState.map);
    document.getElementById('gen-batch-progress').classList.add('hidden');
    document.getElementById('gen-batch-overlay').classList.remove('hidden');
    document.getElementById('gen-batch-count').focus();
  }

  function _closeBatch() {
    if (_batchRunning) {
      _batchCancel = true;
      return;
    }
    document.getElementById('gen-batch-overlay').classList.add('hidden');
  }

  async function _runBatch(e) {
    e.preventDefault();
    if (_batchRunning) return;
    const val = (id) => document.getElementById(id).value;
    const count = Math.max(1, Math.min(1000, Math.floor(Number(val('gen-batch-count')) || 0)));
    const typeKeys = _multiSelects['gen-batch-type'].values();
    const towns = _multiSelects['gen-batch-maps'].values();
    if (!typeKeys.length) {
      Toast.error('Mindestens einen Typ auswählen');
      return;
    }
    if (!towns.length) {
      Toast.error('Mindestens eine Karte auswählen');
      return;
    }
    const startBtn = document.getElementById('gen-batch-start');
    const status = document.getElementById('gen-batch-status');
    const fill = document.getElementById('gen-batch-bar-fill');
    document.getElementById('gen-batch-progress').classList.remove('hidden');
    _batchRunning = true;
    _batchCancel = false;
    startBtn.disabled = true;
    try {
      const res = await generateBatch({
        count,
        typeKeys,
        seed: val('gen-batch-seed') || null,
        maps: towns,
        balance: document.getElementById('gen-batch-balance').checked,
        varyWeather: document.getElementById('gen-batch-weather').checked,
        onProgress: (done, total, made) => {
          fill.style.width = `${Math.round((done / total) * 100)}%`;
          status.textContent = `${done} / ${total} geplant · ${made} erzeugt`;
        },
        isCancelled: () => _batchCancel,
      });
      // Abbrechen aborts: no download, not even a partial batch.
      if (res.cancelled) {
        Toast.info('Stapel-Generierung abgebrochen — nichts heruntergeladen');
        document.getElementById('gen-batch-overlay').classList.add('hidden');
        return;
      }
      if (!res.entries.length) {
        Toast.error('Kein Szenario erzeugt — keine passenden Orte für diese Auswahl');
        return;
      }
      status.textContent = `${res.entries.length} Szenarien werden exportiert …`;
      const town =
        towns.length === 1
          ? towns[0]
          : towns.length === CARLA_TOWNS.length && towns.every((t) => CARLA_TOWNS.includes(t))
            ? 'alle_karten'
            : `${towns.length}_karten`;
      const filename = `szenarien_${town}_${res.entries.length}_s${res.seed}.zip`;
      const out = await Api.exportBatch({ scenarios: res.entries, filename });
      ScenarioIO.downloadBlob(out.blob, filename);
      const notes = [];
      if (res.skipped.length) notes.push(`${res.skipped.length} ohne passenden Ort übersprungen`);
      if (out.failed) notes.push(`${out.failed} Export fehlgeschlagen (siehe manifest)`);
      Toast.success(`${out.ok} Szenarien exportiert${notes.length ? ' · ' + notes.join(' · ') : ''}`, 8000);
      document.getElementById('gen-batch-overlay').classList.add('hidden');
    } catch (err) {
      Toast.error(`Stapel-Generierung fehlgeschlagen: ${err.message}`);
    } finally {
      _batchRunning = false;
      startBtn.disabled = false;
    }
  }

  (function _bindBatchDialog() {
    const form = document.getElementById('gen-batch-form');
    if (!form) return;
    form.addEventListener('submit', _runBatch);
    document.getElementById('gen-batch-cancel').addEventListener('click', _closeBatch);
    // Capture + stopPropagation: Esc closes this, not also a tool behind it.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || document.getElementById('gen-batch-overlay').classList.contains('hidden')) return;
        if (Object.values(_multiSelects).some((ms) => ms.dd.isOpen())) return;
        e.stopPropagation();
        _closeBatch();
      },
      true,
    );
  })();

  GeneratorCore.define({ _openBatch });
})();
