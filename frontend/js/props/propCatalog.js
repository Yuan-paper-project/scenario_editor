/**
 * propCatalog.js — the prop catalogue's API and the Requisiten panel (PropCatalog).
 *
 * The presentation side only; ../llm-scenario-gen/config/prop_catalog.yaml owns what
 * the exporter emits, joined on the blueprint id (a mismatch is a 400 at export).
 * Two views: `side` silhouettes for the palette tiles, `plan` footprints for the map,
 * which is plan view throughout. Data in propData.js, drawings in prop*Shapes.js.
 */
(() => {
  'use strict';

  const { GROUPS, PROPS } = PropData;
  const { side: sideShapes, plan: planShapes, MIN_SIDE_RATIO } = PropShapes;

  /* Footprints under this are scaled up (aspect kept) so they stay visible; the cost is
   * that all three cones draw at the same size. */
  const MIN_PLAN_EXTENT = 1.2;

  function planSize(id) {
    const p = PROPS[id]?.plan || { len: 0.5, wid: 0.5 };
    const k = Math.max(1, MIN_PLAN_EXTENT / Math.max(p.len, p.wid));
    return { len: p.len * k, wid: p.wid * k };
  }

  const PropCatalog = {
    GROUPS,

    /** Catalogue entry for a blueprint id, or null. */
    get(id) {
      const p = PROPS[id];
      return p ? { id, ...p } : null;
    },

    ids() {
      return Object.keys(PROPS);
    },

    /** Fill colour for a prop, from its group. */
    color(id) {
      const g = GROUPS.find((gr) => gr.id === PROPS[id]?.group);
      return g ? g.color : '#e8801a';
    },

    label(id) {
      return PROPS[id]?.label || id || '';
    },

    oriented(id) {
      return !!PROPS[id]?.oriented;
    },

    /** Placement facing rule (see propData.js); independent of `oriented`. */
    facing(id) {
      return PROPS[id]?.facing || 'none';
    },

    /** Map glyph only: extra rotation of the drawn body (a barrier lies across its facing);
     *  the exported h and the yaw arrow are untouched. */
    planRotate(id) {
      return PROPS[id]?.planRotate || 0;
    },

    defaultZ(id) {
      return PROPS[id]?.z ?? 0.0;
    },

    /** Top-down footprint in metres, clamped for visibility. */
    planSize,

    /** The mesh centre relative to the pivot, in the prop's frame (+X = yaw), metres; never clamped. */
    planOffset(id) {
      const o = PROPS[id]?.plan?.off;
      return o ? { x: o[0], y: o[1] } : { x: 0, y: 0 };
    },

    /** Real (unclamped) size for display: length × width × height, metres. */
    dims(id) {
      const p = PROPS[id];
      if (!p) return null;
      return { len: p.plan.len, wid: p.plan.wid, h: p.side.h };
    },

    /** Top-down SVG shapes for the map marker (local +X = yaw direction). */
    planShapes(id) {
      const { len, wid } = planSize(id);
      return planShapes(PROPS[id]?.plan?.kind, len, wid, this.color(id));
    },

    /** An <svg> element for a palette tile: side-view silhouette. */
    tileIcon(id, size = 30) {
      const s = PROPS[id]?.side || { kind: 'box', w: 1, h: 1 };
      // Centre the silhouette, or a flat prop hugs the tile floor.
      const long = Math.max(s.w, s.h);
      const k = (size * 0.86) / long; // fit the tile, keep aspect
      const drawnH = Math.max(s.h, long * MIN_SIDE_RATIO) * k;
      const svg = UIUtils.svgEl('svg', { viewBox: `${-size / 2} ${-size} ${size} ${size}` });
      const g = UIUtils.svgEl('g', {
        transform: `translate(0, ${(drawnH - size) / 2}) scale(${k})`,
      });
      sideShapes(s.kind, s.w, s.h, this.color(id)).forEach((el) => g.appendChild(el));
      svg.appendChild(g);
      return svg;
    },

    /** The Requisiten tab: a search field over foldable group sections (fold state per viewer,
     *  in localStorage). A search shows every section with a hit open, leaving the fold state. */
    renderPanel(container) {
      container.textContent = '';
      const collapsed = _loadCollapsed();

      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'prop-search';
      search.placeholder = 'Suchen …';
      search.setAttribute('aria-label', 'Requisiten durchsuchen');
      search.title = 'Name oder CARLA-ID — Esc leert das Feld';
      container.appendChild(search);

      const sections = [];
      for (const group of GROUPS) {
        const ids = Object.keys(PROPS).filter((id) => PROPS[id].group === group.id);
        if (!ids.length) continue;

        const section = document.createElement('div');
        section.className = 'prop-section';
        section.dataset.group = group.id;
        section.classList.toggle('collapsed', collapsed.has(group.id));

        const heading = document.createElement('button');
        heading.type = 'button';
        heading.className = 'toolbar-section-label prop-section-head';
        heading.style.setProperty('--group-color', group.color);
        heading.innerHTML =
          '<span class="prop-section-caret">▾</span>' +
          `<span class="prop-section-name"></span><span class="prop-section-count"></span>`;
        heading.querySelector('.prop-section-name').textContent = group.label.toUpperCase();
        heading.title = `${group.label} ein-/ausklappen`;
        heading.addEventListener('click', () => {
          const now = !section.classList.contains('collapsed');
          section.classList.toggle('collapsed', now);
          heading.setAttribute('aria-expanded', String(!now));
          if (now) collapsed.add(group.id);
          else collapsed.delete(group.id);
          _saveCollapsed(collapsed);
        });
        heading.setAttribute('aria-expanded', String(!collapsed.has(group.id)));
        section.appendChild(heading);

        const grid = document.createElement('div');
        grid.className = 'tool-grid';
        const tiles = [];
        for (const id of ids) {
          const btn = document.createElement('button');
          btn.className = 'tool-btn';
          btn.dataset.tool = 'prop';
          btn.dataset.prop = id;
          const d = this.dims(id);
          btn.title =
            `${PROPS[id].label} platzieren\n${id}\n` +
            `${d.len.toFixed(2)} × ${d.wid.toFixed(2)} × ${d.h.toFixed(2)} m`;
          btn.appendChild(this.tileIcon(id));
          const span = document.createElement('span');
          span.textContent = PROPS[id].label;
          btn.appendChild(span);
          grid.appendChild(btn);
          tiles.push({ btn, hay: `${PROPS[id].label} ${id}`.toLowerCase() });
        }
        section.appendChild(grid);
        container.appendChild(section);
        sections.push({ section, heading, tiles, total: ids.length });
      }

      const empty = document.createElement('div');
      empty.className = 'toolbar-note prop-search-empty hidden';
      empty.textContent = 'Keine Requisite gefunden';
      container.appendChild(empty);

      const applyFilter = () => {
        const q = search.value.trim().toLowerCase();
        let hits = 0;
        for (const sec of sections) {
          let n = 0;
          for (const t of sec.tiles) {
            const show = !q || t.hay.includes(q);
            t.btn.classList.toggle('hidden', !show);
            if (show) n++;
          }
          hits += n;
          sec.section.classList.toggle('hidden', !n);
          sec.section.classList.toggle('searching', !!q);
          sec.heading.querySelector('.prop-section-count').textContent = q ? `${n}/${sec.total}` : String(sec.total);
        }
        empty.classList.toggle('hidden', hits > 0);
      };
      search.addEventListener('input', applyFilter);
      // Esc clears the field and stops: it must not also disarm the prop tool just picked.
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && search.value) {
          search.value = '';
          applyFilter();
          e.stopPropagation();
        }
      });
      applyFilter();

      const note = document.createElement('div');
      note.className = 'toolbar-note';
      note.textContent = 'Shift-Klick: an Fahrspur ausrichten';
      container.appendChild(note);
    },
  };

  /* Folded sections, per viewer (storage may throw). Default: all but the first two groups folded. */
  const COLLAPSE_KEY = 'scenarioEditor.propSections';
  function _loadCollapsed() {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) {
      /* fall through to the default */
    }
    return new Set(GROUPS.slice(2).map((g) => g.id));
  }
  function _saveCollapsed(set) {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
    } catch (_) {
      /* nicety only */
    }
  }

  window.PropCatalog = PropCatalog;
})();
