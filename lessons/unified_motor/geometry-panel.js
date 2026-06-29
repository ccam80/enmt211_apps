(function () {
  "use strict";

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  const MU0 = 4e-7 * Math.PI;   // Bᵣ = μ₀·Mr (display remanence in tesla)
  const MM = 1000;              // metres → millimetres for display
  const DEFAULT_THICKNESS = 0.005; // 5 mm — a freshly added layer

  // ---------------------------------------------------------------------------
  //  Geometry helpers — the panel edits the component form exclusively.
  // ---------------------------------------------------------------------------

  function ringSegments(ring) {
    const segs = [];
    for (const c of (ring.components || [])) {
      if (Array.isArray(c.rRange)) segs.push(c.rRange);
      if (Array.isArray(c.slotRRange)) segs.push(c.slotRRange);
    }
    return segs;
  }

  function ringExtents(ring) {
    const segs = ringSegments(ring);
    let lo = Infinity, hi = -Infinity;
    for (const seg of segs) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      if (seg[0] < lo) lo = seg[0];
      if (seg[1] > hi) hi = seg[1];
    }
    return { lo: lo, hi: hi };
  }

  function ringMid(ring) {
    const e = ringExtents(ring);
    return (e.lo + e.hi) / 2;
  }

  // Expand the mesh-domain grid so it bounds all ring geometry. dr held ~constant
  // by rescaling Nr. Expand-only.
  function fitGridToRings(config) {
    const g = config.grid;
    if (!g || !Array.isArray(config.rings) || config.rings.length === 0) return;
    const dr = (g.Nr > 0) ? (g.rOuter - g.rInner) / g.Nr : 0;
    let lo = Infinity, hi = -Infinity;
    for (const ring of config.rings) {
      const e = ringExtents(ring);
      if (e.lo < lo) lo = e.lo;
      if (e.hi > hi) hi = e.hi;
    }
    if (!isFinite(lo) || !isFinite(hi)) return;
    g.rInner = Math.min(g.rInner, lo);
    g.rOuter = Math.max(g.rOuter, hi);
    if (dr > 0) g.Nr = Math.max(2, Math.round((g.rOuter - g.rInner) / dr));
  }

  // Inner/outer member groups, ordered by which is radially inner.
  function innerOuterGroups(config) {
    const a = config.rings.filter(function (r) { return r.member === "inner"; });
    const b = config.rings.filter(function (r) { return r.member === "outer"; });
    function meanMid(rs) {
      if (!rs.length) return Infinity;
      let s = 0; for (const r of rs) s += ringMid(r); return s / rs.length;
    }
    return (meanMid(a) <= meanMid(b)) ? { inner: a, outer: b } : { inner: b, outer: a };
  }

  // ---------------------------------------------------------------------------
  //  applyGapLength(config, g) — moves both gap-facing surfaces symmetrically.
  //  Retained as a utility; the live UI sets each body's gap radius directly.
  // ---------------------------------------------------------------------------
  function applyGapLength(config, g) {
    const grid = config.grid;
    const dr = (grid.rOuter - grid.rInner) / grid.Nr;
    const groups = innerOuterGroups(config);
    const innerGroup = groups.inner, outerGroup = groups.outer;
    if (!innerGroup.length || !outerGroup.length) return g;

    let rIn = -Infinity, rOut = Infinity;
    for (const r of innerGroup) { const hi = ringExtents(r).hi; if (hi > rIn) rIn = hi; }
    for (const r of outerGroup) { const lo = ringExtents(r).lo; if (lo < rOut) rOut = lo; }

    const mid = (rIn + rOut) / 2;
    const g0 = rOut - rIn;

    let innerOwner = null, innerOwnerIdx = Infinity;
    for (let i = 0; i < config.rings.length; i++) {
      const r = config.rings[i];
      if (!innerGroup.includes(r)) continue;
      if (Math.abs(ringExtents(r).hi - rIn) < 1e-15 && i < innerOwnerIdx) { innerOwner = r; innerOwnerIdx = i; }
    }
    let outerOwner = null, outerOwnerIdx = Infinity;
    for (let i = 0; i < config.rings.length; i++) {
      const r = config.rings[i];
      if (!outerGroup.includes(r)) continue;
      if (Math.abs(ringExtents(r).lo - rOut) < 1e-15 && i < outerOwnerIdx) { outerOwner = r; outerOwnerIdx = i; }
    }

    const gMin = 2.5 * dr;
    const innerRoom = 0.8 * (rIn - ringExtents(innerOwner).lo);
    const outerRoom = 0.8 * (ringExtents(outerOwner).hi - rOut);
    const gMax = g0 + 2 * Math.min(innerRoom, outerRoom);
    g = Math.max(gMin, Math.min(gMax, g));

    const newRIn = mid - g / 2;
    const newROut = mid + g / 2;

    function updateRangeSlot(arr, oldVal, newVal) {
      if (!Array.isArray(arr) || arr.length < 2) return;
      for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i] - oldVal) < 1e-15) arr[i] = newVal;
    }
    for (const seg of ringSegments(innerOwner)) updateRangeSlot(seg, rIn, newRIn);
    for (const seg of ringSegments(outerOwner)) updateRangeSlot(seg, rOut, newROut);
    return g;
  }

  // ---------------------------------------------------------------------------
  //  Body / layer model
  //
  //  Each body (inner/outer) is ONE ring whose components are the layers. A layer
  //  is characterised by a material (kind) + a thickness; the panel derives every
  //  rRange from the body's gap-facing radius and the cumulative thicknesses, so
  //  layers stack away from the gap and can never overlap or enter the air gap.
  // ---------------------------------------------------------------------------

  // Merge any body that has several rings into a single ring (preserving circuit
  // ↔ winding bindings). Behaviour-preserving; idempotent for one-ring bodies.
  function consolidateBodies(config) {
    if (!Array.isArray(config.rings)) return;
    const blocks = captureCircuitBlocks(config);
    for (const side of ["inner", "outer"]) {
      const rs = config.rings.filter(function (r) { return r.member === side; });
      if (rs.length <= 1) continue;
      const first = rs[0];
      for (let i = 1; i < rs.length; i++) for (const c of rs[i].components) first.components.push(c);
      config.rings = config.rings.filter(function (r) { return r.member !== side || r === first; });
    }
    rebuildCircuits(config, blocks);
  }

  function bodyRing(config, side) {
    return config.rings.find(function (r) { return r.member === side; });
  }

  // The body's components in radial order, gap-facing layer first.
  function bodyComponents(config, side) {
    const ring = bodyRing(config, side);
    if (!ring) return [];
    const comps = ring.components.slice();
    comps.sort(function (a, b) {
      return side === "inner" ? (b.rRange[1] - a.rRange[1]) : (a.rRange[0] - b.rRange[0]);
    });
    return comps;
  }

  // The body's gap-facing radius: inner body's outer surface / outer body's bore.
  function gapRadiusOf(config, side) {
    const comps = bodyComponents(config, side);
    if (!comps.length) return null;
    if (side === "inner") {
      let m = -Infinity; for (const c of comps) if (c.rRange[1] > m) m = c.rRange[1]; return m;
    }
    let m = Infinity; for (const c of comps) if (c.rRange[0] < m) m = c.rRange[0]; return m;
  }

  // Lay the stack out from gapR, assigning each item its thickness band, writing
  // rRange (and slotRRange) back to each component.
  function recomputeStack(side, gapR, items) {
    let edge = gapR;
    for (const it of items) {
      let r0, r1;
      if (side === "inner") { r1 = edge; r0 = edge - it.thickness; edge = r0; }
      else { r0 = edge; r1 = edge + it.thickness; edge = r1; }
      it.comp.rRange = [r0, r1];
      if (it.comp.slotRRange) it.comp.slotRRange = [r0, r1];
    }
  }

  function bodyItems(config, side) {
    return bodyComponents(config, side).map(function (c) {
      return { comp: c, thickness: c.rRange[1] - c.rRange[0] };
    });
  }

  // Keep at least ~2 air cells between the two bodies' gap-facing surfaces.
  function clampGapRadius(config, side, val) {
    const g = config.grid;
    const dr = (g.rOuter - g.rInner) / g.Nr;
    const gMin = 2.5 * dr;
    const innerR = gapRadiusOf(config, "inner");
    const outerR = gapRadiusOf(config, "outer");
    if (side === "inner") return Math.max(gMin, Math.min(val, outerR - gMin));
    return Math.max(innerR + gMin, val);
  }

  // ---------------------------------------------------------------------------
  //  Circuit bookkeeping — winding/cage layers own a contiguous block of
  //  config.circuits; add/remove/material-change keep them in lockstep.
  // ---------------------------------------------------------------------------
  function windingCircuitCount(comp) {
    if (comp.kind === "cage") return (comp.cage && comp.cage.bars) || 0;
    if ((comp.kind === "distributed-winding" || comp.kind === "concentrated-winding") &&
        comp.winding && comp.winding.standard) {
      return comp.winding.standard.m || 0;
    }
    return 0;
  }

  function ringWindingCount(ring) {
    let n = 0;
    for (const c of (ring.components || [])) n += windingCircuitCount(c);
    return n;
  }

  function circuitBaseForComponent(config, ri, ci) {
    let base = 0;
    for (let r = 0; r < config.rings.length; r++) {
      const comps = config.rings[r].components || [];
      for (let c = 0; c < comps.length; c++) {
        if (r === ri && c === ci) return base;
        base += windingCircuitCount(comps[c]);
      }
    }
    return base;
  }

  function ringCircuitBase(config, ri) {
    let base = 0;
    for (let r = 0; r < ri; r++) base += ringWindingCount(config.rings[r]);
    return base;
  }

  function defaultCircuit() {
    return { terminal: { type: "OPEN" }, commutation: { mode: "none" }, R: 1.0 };
  }

  // Map every winding/cage component to the circuit block it currently owns.
  function captureCircuitBlocks(config) {
    const map = new Map();
    if (!Array.isArray(config.circuits) || !Array.isArray(config.rings)) return map;
    let base = 0;
    for (const ring of config.rings) {
      for (const comp of (ring.components || [])) {
        const n = windingCircuitCount(comp);
        if (n > 0) { map.set(comp, config.circuits.slice(base, base + n)); base += n; }
      }
    }
    return map;
  }

  // Rebuild config.circuits by walking components in their current order and
  // concatenating each one's captured block (preserving terminal/commutation/R).
  function rebuildCircuits(config, blocks) {
    if (!Array.isArray(config.rings)) return;
    const out = [];
    for (const ring of config.rings) {
      for (const comp of (ring.components || [])) {
        const blk = blocks.get(comp);
        if (blk) for (const c of blk) out.push(c);
      }
    }
    config.circuits = out;
  }

  // ---------------------------------------------------------------------------
  //  defaultAxial / setSlices / commitEdit
  // ---------------------------------------------------------------------------
  function defaultAxial() {
    return {
      branches: { pm: { Br: 1.2, length: 0.00628 } },
      loops: [
        { slices: [ { s: 0, sign: 1 }, { s: 1, sign: -1 } ], branches: ["pm"], Raxial: 0, Fpm: 0 },
      ],
    };
  }

  function setSlices(config, n) {
    if (!config.stack) config.stack = {};
    config.stack.slices = n;
    if (!Array.isArray(config.stack.sliceOffsets)) config.stack.sliceOffsets = [];
    const current = config.stack.sliceOffsets;
    if (n < current.length) config.stack.sliceOffsets = current.slice(0, n);
    else while (config.stack.sliceOffsets.length < n) config.stack.sliceOffsets.push(0);
    if (n > 1) { if (config.stack.axial == null) config.stack.axial = defaultAxial(); }
    else delete config.stack.axial;
  }

  function commitEdit(config, mutateFn) {
    const snapshot = JSON.parse(JSON.stringify(config));
    mutateFn(config);
    const v = UM.ConfigSchema.validate(config);
    if (v.ok) return { ok: true };
    for (const k of Object.keys(config)) delete config[k];
    for (const k of Object.keys(snapshot)) config[k] = snapshot[k];
    return { ok: false, errors: v.errors };
  }

  // ---------------------------------------------------------------------------
  //  Semantic display metadata — physical params only (radii are derived from
  //  thickness; opacity lives in its own section).
  // ---------------------------------------------------------------------------
  const COMPONENT_FIELDS = {
    iron: [
      { key: "teeth", label: "Teeth", int: true },
      { key: "muR", label: "Rel. permeability μᵣ" },
      { key: "Bknee", label: "Saturation knee Bₖₙₑₑ", unit: "T" },
    ],
    magnet: [
      { key: "poles", label: "Poles", int: true },
      { key: "Mr", label: "Remanence Bᵣ", unit: "T",
        toDisplay: function (m) { return m * MU0; }, fromDisplay: function (b) { return b / MU0; } },
      { key: "muR", label: "Rel. permeability μᵣ" },
    ],
    "distributed-winding": [
      { key: "winding.standard.Q", label: "Slots Q", int: true },
      { key: "winding.standard.turns", label: "Turns / coil", int: true },
      { key: "slotFraction", label: "Slot fill fraction" },
    ],
    "concentrated-winding": [
      { key: "winding.standard.Q", label: "Slots / teeth Q", int: true },
      { key: "winding.standard.turns", label: "Turns / coil", int: true },
      { key: "spanFraction", label: "Tooth span fraction" },
    ],
    cage: [
      { key: "cage.bars", label: "Bars", int: true },
      { key: "slotFraction", label: "Bar fill fraction" },
    ],
  };

  const KINDS = ["iron", "magnet", "distributed-winding", "concentrated-winding", "cage"];
  const KIND_LABEL = {
    iron: "iron", magnet: "magnet",
    "distributed-winding": "distributed winding",
    "concentrated-winding": "concentrated winding", cage: "cage",
  };

  function getPath(obj, path) {
    const parts = path.split(".");
    let o = obj;
    for (const p of parts) { if (o == null) return undefined; o = o[p]; }
    return o;
  }
  function setPath(obj, path, val) {
    const parts = path.split(".");
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = val;
  }

  // A material of the given kind (rRange/slotRRange are assigned by the stack
  // layout, not here). Winding/cage routing is full-pitch and pole-matched so it
  // validates immediately.
  function makeMaterial(kind, poles) {
    if (kind === "magnet") return { kind: "magnet", poles: poles || 2, Mr: 1 / MU0, alpha: 1 };
    if (kind === "cage") return { kind: "cage", slotRRange: [0, 0], cage: { bars: 12 }, slotFraction: 0.5, muR: 1000, alpha: 1 };
    if (kind === "distributed-winding" || kind === "concentrated-winding") {
      const p = (poles && poles % 2 === 0) ? poles : 2;
      const m = 3, Q = 2 * m * p, coilPitch = 2 * m;
      return { kind: kind, slotRRange: [0, 0],
        winding: { standard: { m: m, p: p, Q: Q, coilPitch: coilPitch, turns: 20 } },
        slotFraction: 0.5, muR: 1000, alpha: 1 };
    }
    return { kind: "iron", muR: 1000, alpha: 1 };
  }

  // ---------------------------------------------------------------------------
  //  Public API
  // ---------------------------------------------------------------------------
  UM.GeometryPanel = {
    applyGapLength: applyGapLength,
    setSlices: setSlices,
    defaultAxial: defaultAxial,
    commitEdit: commitEdit,
    consolidateBodies: consolidateBodies,
  };

  // ---------------------------------------------------------------------------
  //  Panel registration — shelf panel; DOM lives inside build()
  // ---------------------------------------------------------------------------
  UM.registerPanel({
    id: "geometry-editor",
    zone: "shelf",
    build: function (host, ctx) {
      const listeners = [];
      function addListener(el, evt, fn) { el.addEventListener(evt, fn); listeners.push({ el: el, evt: evt, fn: fn }); }

      // Collapse any multi-ring body to a single layer stack on load.
      consolidateBodies(ctx.config);

      let expandedKey = null;   // "<side>:<radialIndex>" of the open accordion layer
      let dragState = null;     // { side, index } during a layer drag

      const statusEl = document.createElement("div");
      statusEl.className = "gp-status";
      statusEl.style.cssText = "color:#ff8a65;font-size:0.8em;min-height:1em;margin:0 0 4px;";
      const contentEl = document.createElement("div");
      host.appendChild(statusEl);
      host.appendChild(contentEl);

      function setError(msg) { statusEl.textContent = msg || ""; }

      function applyEdit(mutateFn, refresh) {
        const res = commitEdit(ctx.config, function (c) { mutateFn(c); fitGridToRings(c); });
        if (res.ok) {
          setError("");
          ctx.requestRebuild();
          if (refresh) rebuild();
        } else {
          setError("Rejected: " + ((res.errors && res.errors[0]) || "invalid geometry"));
          rebuild();
        }
      }

      // -- small DOM builders ---------------------------------------------------
      function numberInput(parent, label, value, onChange, opts) {
        opts = opts || {};
        const wrap = document.createElement("label");
        wrap.className = "gp-field";
        wrap.style.cssText = "display:flex;justify-content:space-between;gap:6px;font-size:0.82em;margin:2px 0;";
        wrap.textContent = label + (opts.unit ? " (" + opts.unit + ")" : "") + ": ";
        const inp = document.createElement("input");
        inp.type = "number";
        inp.style.cssText = "width:5.5em;";
        inp.step = opts.step != null ? String(opts.step) : (opts.int ? "1" : "any");
        inp.value = value;
        addListener(inp, "change", function () {
          const v = opts.int ? parseInt(inp.value, 10) : parseFloat(inp.value);
          if (opts.int ? Number.isInteger(v) : isFinite(v)) onChange(v);
        });
        wrap.appendChild(inp);
        parent.appendChild(wrap);
        return inp;
      }

      function selectInput(parent, label, value, options, onChange) {
        const wrap = document.createElement("label");
        wrap.className = "gp-field";
        wrap.style.cssText = "display:flex;justify-content:space-between;gap:6px;font-size:0.82em;margin:2px 0;";
        wrap.textContent = label + ": ";
        const sel = document.createElement("select");
        for (const o of options) {
          const opt = document.createElement("option");
          opt.value = o.value != null ? o.value : o;
          opt.textContent = o.label != null ? o.label : o;
          if (opt.value === value) opt.selected = true;
          sel.appendChild(opt);
        }
        addListener(sel, "change", function () { onChange(sel.value); });
        wrap.appendChild(sel);
        parent.appendChild(wrap);
        return sel;
      }

      // -- layer editing operations --------------------------------------------
      function setThickness(side, idx, mm) {
        const items = bodyItems(ctx.config, side);
        if (!items[idx]) return;
        items[idx].thickness = mm / MM;
        applyEdit(function () { recomputeStack(side, gapRadiusOf(ctx.config, side), items); }, false);
      }

      function setGapRadius(side, mm) {
        applyEdit(function (c) {
          const r = clampGapRadius(c, side, mm / MM);
          recomputeStack(side, r, bodyItems(c, side));
        }, true);
      }

      function reorderLayer(side, from, to) {
        if (from === to) return;
        applyEdit(function (c) {
          const items = bodyItems(c, side);
          const moved = items.splice(from, 1)[0];
          items.splice(to, 0, moved);
          recomputeStack(side, gapRadiusOf(c, side), items);
        }, true);
      }

      function addLayer(side, kind) {
        applyEdit(function (c) {
          const ring = bodyRing(c, side);
          const ri = c.rings.indexOf(ring);
          const comp = makeMaterial(kind, c.poles);
          // Place the new layer at the far end (away from the gap).
          const comps = bodyComponents(c, side);
          let far;
          if (!comps.length) far = side === "inner" ? c.grid.rInner + DEFAULT_THICKNESS : c.grid.rOuter - DEFAULT_THICKNESS;
          else far = side === "inner" ? Math.min.apply(null, comps.map(function (x) { return x.rRange[0]; }))
                                      : Math.max.apply(null, comps.map(function (x) { return x.rRange[1]; }));
          comp.rRange = side === "inner" ? [far - DEFAULT_THICKNESS, far] : [far, far + DEFAULT_THICKNESS];
          if (comp.slotRRange) comp.slotRRange = comp.rRange.slice();
          const n = windingCircuitCount(comp);
          if (n > 0) {
            const at = ringCircuitBase(c, ri) + ringWindingCount(ring);
            const add = []; for (let k = 0; k < n; k++) add.push(defaultCircuit());
            c.circuits.splice.apply(c.circuits, [at, 0].concat(add));
          }
          ring.components.push(comp);
        }, true);
      }

      function removeLayer(side, comp) {
        applyEdit(function (c) {
          const ring = bodyRing(c, side);
          const ri = c.rings.indexOf(ring);
          const ci = ring.components.indexOf(comp);
          if (ci < 0) return;
          const n = windingCircuitCount(comp);
          if (n > 0) c.circuits.splice(circuitBaseForComponent(c, ri, ci), n);
          ring.components.splice(ci, 1);
        }, true);
      }

      function changeMaterial(side, comp, newKind) {
        applyEdit(function (c) {
          const ring = bodyRing(c, side);
          const ri = c.rings.indexOf(ring);
          const ci = ring.components.indexOf(comp);
          if (ci < 0) return;
          const oldN = windingCircuitCount(comp);
          if (oldN > 0) c.circuits.splice(circuitBaseForComponent(c, ri, ci), oldN);
          const neu = makeMaterial(newKind, c.poles);
          neu.rRange = comp.rRange.slice();
          if (neu.slotRRange) neu.slotRRange = comp.rRange.slice();
          neu.alpha = comp.alpha != null ? comp.alpha : 1;
          ring.components[ci] = neu;
          const newN = windingCircuitCount(neu);
          if (newN > 0) {
            const at = circuitBaseForComponent(c, ri, ci);
            const add = []; for (let k = 0; k < newN; k++) add.push(defaultCircuit());
            c.circuits.splice.apply(c.circuits, [at, 0].concat(add));
          }
        }, true);
      }

      // -- one layer (accordion row) -------------------------------------------
      function buildLayer(parent, side, items, idx) {
        const comp = items[idx].comp;
        const key = side + ":" + idx;
        const open = expandedKey === key;

        const row = document.createElement("div");
        row.className = "gp-layer";
        row.style.cssText = "border:1px solid var(--grid,#2a313c);border-radius:4px;margin:3px 0;background:var(--panel2,#232932);";
        row.draggable = true;
        addListener(row, "dragstart", function (e) { dragState = { side: side, index: idx }; if (e && e.dataTransfer) e.dataTransfer.effectAllowed = "move"; });
        addListener(row, "dragover", function (e) { if (e && e.preventDefault) e.preventDefault(); });
        addListener(row, "drop", function (e) {
          if (e && e.preventDefault) e.preventDefault();
          if (dragState && dragState.side === side) reorderLayer(side, dragState.index, idx);
          dragState = null;
        });

        const head = document.createElement("div");
        head.className = "gp-layer-head";
        head.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;";
        const tw = document.createElement("span"); tw.textContent = open ? "▾" : "▸"; tw.style.cssText = "opacity:0.7;";
        const grip = document.createElement("span"); grip.textContent = "⠿"; grip.title = "drag to reorder"; grip.style.cssText = "cursor:grab;opacity:0.5;";
        const name = document.createElement("span");
        name.className = "gp-layer-kind";
        name.style.cssText = "font-weight:bold;color:var(--accent,#4ea1ff);flex:1;";
        name.textContent = KIND_LABEL[comp.kind] || comp.kind;
        const thick = document.createElement("span");
        thick.style.cssText = "opacity:0.8;font-size:0.85em;";
        thick.textContent = ((comp.rRange[1] - comp.rRange[0]) * MM).toFixed(2) + " mm";
        const rm = document.createElement("button");
        rm.style.cssText = "background:none;border:none;color:#ff8a65;cursor:pointer;";
        rm.textContent = "✕"; rm.title = "remove layer";
        addListener(rm, "click", function (e) { if (e && e.stopPropagation) e.stopPropagation(); removeLayer(side, comp); });

        head.appendChild(tw); head.appendChild(grip); head.appendChild(name); head.appendChild(thick); head.appendChild(rm);
        addListener(head, "click", function () { expandedKey = open ? null : key; rebuild(); });
        row.appendChild(head);

        if (open) {
          const body = document.createElement("div");
          body.style.cssText = "padding:2px 8px 6px;";
          numberInput(body, "Thickness", (items[idx].thickness * MM).toFixed(2), function (v) {
            setThickness(side, idx, v);
          }, { unit: "mm", step: 0.1 });
          selectInput(body, "Material", comp.kind,
            KINDS.map(function (k) { return { value: k, label: KIND_LABEL[k] }; }),
            function (v) { changeMaterial(side, comp, v); });
          for (const f of (COMPONENT_FIELDS[comp.kind] || [])) {
            const raw = getPath(comp, f.key);
            if (raw == null) continue;
            const shown = f.toDisplay ? f.toDisplay(raw) : raw;
            numberInput(body, f.label, f.int ? shown : Number(shown),
              (function (field) {
                return function (v) {
                  const store = field.fromDisplay ? field.fromDisplay(v) : v;
                  applyEdit(function (c) {
                    const ring = bodyRing(c, side);
                    const target = ring.components[ring.components.indexOf(comp)];
                    setPath(target, field.key, store);
                  }, false);
                };
              })(f), { unit: f.unit, int: f.int });
          }
          row.appendChild(body);
        }

        parent.appendChild(row);
      }

      // -- a body group (inner / outer) ----------------------------------------
      function buildBody(parent, side) {
        const group = document.createElement("div");
        group.className = "gp-body";
        group.style.cssText = "margin:6px 0;padding-top:4px;border-top:1px solid var(--grid,#2a313c);";

        const head = document.createElement("div");
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
        const label = document.createElement("span");
        label.style.cssText = "font-weight:bold;text-transform:capitalize;";
        label.textContent = side + " body";
        head.appendChild(label);

        const motion = ctx.config.motion || {};
        selectInput(head, "Motion", motion[side] === "rotating" ? "rotating" : "static",
          ["rotating", "static"], function (v) {
            const other = side === "inner" ? "outer" : "inner";
            applyEdit(function (c) {
              if (!c.motion) c.motion = {};
              c.motion[side] = v;
              c.motion[other] = (v === "rotating") ? "static" : "rotating";
            }, true);
          });
        group.appendChild(head);

        const gapR = gapRadiusOf(ctx.config, side);
        if (gapR != null) {
          numberInput(group, "Gap radius", (gapR * MM).toFixed(2), function (v) { setGapRadius(side, v); },
            { unit: "mm", step: 0.1 });
        }

        const items = bodyItems(ctx.config, side);
        items.forEach(function (_, idx) { buildLayer(group, side, items, idx); });

        const addWrap = document.createElement("div");
        addWrap.style.cssText = "display:flex;gap:4px;margin:4px 0;";
        const sel = document.createElement("select");
        for (const k of KINDS) {
          const opt = document.createElement("option");
          opt.value = k; opt.textContent = KIND_LABEL[k]; sel.appendChild(opt);
        }
        const addBtn = document.createElement("button");
        addBtn.textContent = "+ layer";
        addListener(addBtn, "click", function () { addLayer(side, sel.value); });
        addWrap.appendChild(sel); addWrap.appendChild(addBtn);
        group.appendChild(addWrap);

        parent.appendChild(group);
      }

      // -- transparency section (opacity per layer, separate from physics) ------
      function buildTransparency(parent) {
        const sec = document.createElement("div");
        sec.className = "gp-transparency";
        sec.style.cssText = "margin-top:8px;padding-top:4px;border-top:1px solid var(--grid,#2a313c);";
        const title = document.createElement("div");
        title.style.cssText = "font-weight:bold;margin-bottom:2px;";
        title.textContent = "Transparency";
        sec.appendChild(title);

        // End-cap (end-winding + cage-ring) opacity — one render-only alpha,
        // separate from the physical layer opacities below.
        (function () {
          const wrap = document.createElement("label");
          wrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:0.82em;margin:2px 0;";
          const lab = document.createElement("span");
          lab.style.cssText = "flex:1;";
          lab.textContent = "end caps";
          const cur = ctx.config.endCapAlpha != null ? ctx.config.endCapAlpha : 1;
          const inp = document.createElement("input");
          inp.type = "range"; inp.min = "0"; inp.max = "1"; inp.step = "0.01"; inp.value = cur;
          const read = document.createElement("span");
          read.style.cssText = "width:2.5em;text-align:right;";
          read.textContent = cur.toFixed(2);
          addListener(inp, "input", function () { read.textContent = parseFloat(inp.value).toFixed(2); });
          addListener(inp, "change", function () {
            const v = Math.max(0, Math.min(1, parseFloat(inp.value)));
            ctx.config.endCapAlpha = v;          // render-only: no recompile, no sim reset
            ctx.requestRenderUpdate();
          });
          wrap.appendChild(lab); wrap.appendChild(inp); wrap.appendChild(read);
          sec.appendChild(wrap);
        })();

        for (const side of ["inner", "outer"]) {
          bodyComponents(ctx.config, side).forEach(function (comp) {
            const wrap = document.createElement("label");
            wrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:0.82em;margin:2px 0;";
            const lab = document.createElement("span");
            lab.style.cssText = "flex:1;";
            lab.textContent = side + " · " + (KIND_LABEL[comp.kind] || comp.kind);
            const inp = document.createElement("input");
            inp.type = "range"; inp.min = "0"; inp.max = "1"; inp.step = "0.01";
            inp.value = comp.alpha != null ? comp.alpha : 1;
            const read = document.createElement("span");
            read.style.cssText = "width:2.5em;text-align:right;";
            read.textContent = (comp.alpha != null ? comp.alpha : 1).toFixed(2);
            addListener(inp, "input", function () { read.textContent = parseFloat(inp.value).toFixed(2); });
            addListener(inp, "change", function () {
              const v = Math.max(0, Math.min(1, parseFloat(inp.value)));
              // render-only: set the layer alpha and re-skin without recompiling
              // the geometry or resetting the running simulation.
              const ring = bodyRing(ctx.config, side);
              const t = ring && ring.components[ring.components.indexOf(comp)];
              if (t) { t.alpha = v; ctx.requestRenderUpdate(); }
            });
            wrap.appendChild(lab); wrap.appendChild(inp); wrap.appendChild(read);
            sec.appendChild(wrap);
          });
        }
        parent.appendChild(sec);
      }

      function buildGapAndSlices(parent) {
        const config = ctx.config;
        const innerR = gapRadiusOf(config, "inner");
        const outerR = gapRadiusOf(config, "outer");
        if (innerR != null && outerR != null) {
          const gapRead = document.createElement("div");
          gapRead.style.cssText = "margin:6px 0 2px;font-size:0.85em;opacity:0.85;";
          gapRead.textContent = "Air gap: " + ((outerR - innerR) * MM).toFixed(3) + " mm";
          parent.appendChild(gapRead);
        }

        const sliceSection = document.createElement("div");
        const stack = config.stack || {};
        const nSlices = stack.slices != null ? stack.slices : 1;
        const sliceReadout = document.createElement("span");
        sliceReadout.textContent = "Slices: " + nSlices + " ";
        sliceSection.appendChild(sliceReadout);
        const addBtn = document.createElement("button");
        addBtn.textContent = "+ add slice"; addBtn.disabled = nSlices >= 4;
        addListener(addBtn, "click", function () { if (nSlices < 4) { setSlices(config, nSlices + 1); ctx.requestRebuild(); rebuild(); } });
        sliceSection.appendChild(addBtn);
        const rmBtn = document.createElement("button");
        rmBtn.textContent = "- remove slice"; rmBtn.disabled = nSlices <= 1;
        addListener(rmBtn, "click", function () { if (nSlices > 1) { setSlices(config, nSlices - 1); ctx.requestRebuild(); rebuild(); } });
        sliceSection.appendChild(rmBtn);
        parent.appendChild(sliceSection);

        if (nSlices > 1 && stack.axial) {
          const axSection = document.createElement("div");
          const axTitle = document.createElement("div");
          axTitle.textContent = "Axial-flux netlist"; axSection.appendChild(axTitle);
          const ax = stack.axial, defs = ax.branches || {};
          for (const bname of Object.keys(defs)) {
            const b = defs[bname];
            const bDiv = document.createElement("div");
            const bLabel = document.createElement("span"); bLabel.textContent = "Branch \"" + bname + "\": "; bDiv.appendChild(bLabel);
            for (const field of ["Br", "length", "area", "muR", "reluctance", "mmf"]) {
              if (b[field] != null) numberInput(bDiv, field, b[field], (function (fn) {
                return function (v) { applyEdit(function (c) { c.stack.axial.branches[bname][fn] = v; }, false); };
              })(field));
            }
            axSection.appendChild(bDiv);
          }
          ax.loops.forEach(function (loop, li) {
            const lDiv = document.createElement("div");
            const lLabel = document.createElement("span"); lLabel.textContent = "Loop " + li + ": "; lDiv.appendChild(lLabel);
            if (loop.Raxial != null) numberInput(lDiv, "Raxial", loop.Raxial, function (v) { applyEdit(function (c) { c.stack.axial.loops[li].Raxial = v; }, false); });
            if (loop.Fpm != null) numberInput(lDiv, "Fpm", loop.Fpm, function (v) { applyEdit(function (c) { c.stack.axial.loops[li].Fpm = v; }, false); });
            axSection.appendChild(lDiv);
          });
          parent.appendChild(axSection);
        }
      }

      function rebuild() {
        contentEl.innerHTML = "";
        if (!Array.isArray(ctx.config.rings)) return;
        buildBody(contentEl, "inner");
        buildBody(contentEl, "outer");
        buildGapAndSlices(contentEl);
        buildTransparency(contentEl);
      }

      rebuild();

      // A structural rebuild (e.g. the machine picker loading a new fixture)
      // replaces config.rings wholesale. Collapse its multi-ring bodies to the
      // single-stack editor model BEFORE expand (normalize), then rebind every
      // layer/transparency control to the new components AFTER expand (refresh).
      const unregisterNormalize = ctx.registerNormalize
        ? ctx.registerNormalize(function () { consolidateBodies(ctx.config); }) : null;
      const unregisterRefresh = ctx.registerRefresh
        ? ctx.registerRefresh(function () { rebuild(); }) : null;

      return function unmount() {
        if (unregisterNormalize) unregisterNormalize();
        if (unregisterRefresh) unregisterRefresh();
        for (const { el, evt, fn } of listeners) el.removeEventListener(evt, fn);
        listeners.length = 0;
        host.innerHTML = "";
      };
    },
  });
})();
