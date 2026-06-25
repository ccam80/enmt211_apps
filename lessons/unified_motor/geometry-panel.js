(function () {
  "use strict";

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  const MU0 = 4e-7 * Math.PI;   // Bᵣ = μ₀·Mr (display remanence in tesla)
  const MM = 1000;              // metres → millimetres for radius display

  // ---------------------------------------------------------------------------
  //  Internal helpers — the panel edits the component form exclusively, so all
  //  geometry helpers read ring.components (never ring.element).
  // ---------------------------------------------------------------------------

  // Radial occupancy segments of a component ring (every component sub-range).
  function ringSegments(ring) {
    const segs = [];
    for (const c of (ring.components || [])) {
      if (Array.isArray(c.rRange)) segs.push(c.rRange);
      if (Array.isArray(c.slotRRange)) segs.push(c.slotRRange);
    }
    return segs;
  }

  // Lower and upper radial extents of a ring across all its segments.
  function ringExtents(ring) {
    const segs = ringSegments(ring);
    let lo = Infinity;
    let hi = -Infinity;
    for (const seg of segs) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      if (seg[0] < lo) lo = seg[0];
      if (seg[1] > hi) hi = seg[1];
    }
    return { lo: lo, hi: hi };
  }

  // Midpoint radius of a ring.
  function ringMid(ring) {
    const { lo, hi } = ringExtents(ring);
    return (lo + hi) / 2;
  }

  // Expand the mesh-domain grid so it bounds all ring geometry. The grid's
  // [rInner, rOuter] is the radial extent the mesh can represent, so a radius
  // edit that grows past it must grow the grid rather than be rejected. Radial
  // cell size (dr) is held roughly constant by rescaling Nr. Expand-only.
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

  // Which member-group is radially inner. Members are geometric (inner/outer),
  // but mean-radius detection keeps this robust if a config is mislabelled.
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
  //  Returns the achieved gap.
  // ---------------------------------------------------------------------------
  function applyGapLength(config, g) {
    const grid = config.grid;
    const dr = (grid.rOuter - grid.rInner) / grid.Nr;

    const groups = innerOuterGroups(config);
    const innerGroup = groups.inner;
    const outerGroup = groups.outer;
    if (!innerGroup.length || !outerGroup.length) return g;

    // rIn = max rHi over inner group; rOut = min rLo over outer group
    let rIn = -Infinity;
    let rOut = Infinity;
    for (const r of innerGroup) {
      const hi = ringExtents(r).hi;
      if (hi > rIn) rIn = hi;
    }
    for (const r of outerGroup) {
      const lo = ringExtents(r).lo;
      if (lo < rOut) rOut = lo;
    }

    const mid = (rIn + rOut) / 2;
    const g0 = rOut - rIn;

    // Find owner rings (tie-break by lower index in config.rings)
    let innerOwner = null;
    let innerOwnerIdx = Infinity;
    for (let i = 0; i < config.rings.length; i++) {
      const r = config.rings[i];
      if (!innerGroup.includes(r)) continue;
      if (Math.abs(ringExtents(r).hi - rIn) < 1e-15 && i < innerOwnerIdx) {
        innerOwner = r;
        innerOwnerIdx = i;
      }
    }

    let outerOwner = null;
    let outerOwnerIdx = Infinity;
    for (let i = 0; i < config.rings.length; i++) {
      const r = config.rings[i];
      if (!outerGroup.includes(r)) continue;
      if (Math.abs(ringExtents(r).lo - rOut) < 1e-15 && i < outerOwnerIdx) {
        outerOwner = r;
        outerOwnerIdx = i;
      }
    }

    // Clamp the requested gap
    const gMin = 2.5 * dr;
    const innerThickness = rIn - ringExtents(innerOwner).lo;
    const outerThickness = ringExtents(outerOwner).hi - rOut;
    const innerRoom = 0.8 * innerThickness;
    const outerRoom = 0.8 * outerThickness;
    const gMax = g0 + 2 * Math.min(innerRoom, outerRoom);
    g = Math.max(gMin, Math.min(gMax, g));

    // New gap-facing surface positions
    const newRIn = mid - g / 2;
    const newROut = mid + g / 2;

    // Update every concrete component sub-range slot equal to the old surface.
    function updateRangeSlot(arr, oldVal, newVal) {
      if (!Array.isArray(arr) || arr.length < 2) return;
      for (let i = 0; i < arr.length; i++) {
        if (Math.abs(arr[i] - oldVal) < 1e-15) arr[i] = newVal;
      }
    }

    for (const seg of ringSegments(innerOwner)) updateRangeSlot(seg, rIn, newRIn);
    for (const seg of ringSegments(outerOwner)) updateRangeSlot(seg, rOut, newROut);

    return g;
  }

  // ---------------------------------------------------------------------------
  //  defaultAxial() — hybrid L=1 two-cup prefill
  // ---------------------------------------------------------------------------
  function defaultAxial() {
    return {
      branches: { pm: { Br: 1.2, length: 0.00628 } },
      loops: [
        {
          slices: [ { s: 0, sign: 1 }, { s: 1, sign: -1 } ],
          branches: ["pm"],
          Raxial: 0,
          Fpm: 0,
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  //  setSlices(config, n) — resize stack.slices + sliceOffsets, manage axial
  // ---------------------------------------------------------------------------
  function setSlices(config, n) {
    if (!config.stack) config.stack = {};
    config.stack.slices = n;

    if (!Array.isArray(config.stack.sliceOffsets)) {
      config.stack.sliceOffsets = [];
    }

    const current = config.stack.sliceOffsets;
    if (n < current.length) {
      config.stack.sliceOffsets = current.slice(0, n);
    } else {
      while (config.stack.sliceOffsets.length < n) {
        config.stack.sliceOffsets.push(0);
      }
    }

    if (n > 1) {
      if (config.stack.axial == null) {
        config.stack.axial = defaultAxial();
      }
    } else {
      delete config.stack.axial;
    }
  }

  // ---------------------------------------------------------------------------
  //  commitEdit(config, mutateFn) — apply + validate; revert on failure
  // ---------------------------------------------------------------------------
  function commitEdit(config, mutateFn) {
    const snapshot = JSON.parse(JSON.stringify(config));
    mutateFn(config);
    const v = UM.ConfigSchema.validate(config);
    if (v.ok) {
      return { ok: true };
    }
    // Restore in place
    for (const k of Object.keys(config)) {
      delete config[k];
    }
    for (const k of Object.keys(snapshot)) {
      config[k] = snapshot[k];
    }
    return { ok: false, errors: v.errors };
  }

  // ---------------------------------------------------------------------------
  //  ensureComponentForm(config) — convert a legacy/element config to the
  //  canonical component + inner/outer + motion form in place. Idempotent.
  // ---------------------------------------------------------------------------
  function ensureComponentForm(config) {
    if (!Array.isArray(config.rings)) return;
    const needsConvert = config.rings.some(function (r) {
      return r && (!Array.isArray(r.components) || r.member === "rotor" || r.member === "stator");
    });
    if (!needsConvert) return;
    const conv = UM.ConfigSchema.toComponentConfig(config);
    for (const k of Object.keys(config)) delete config[k];
    for (const k of Object.keys(conv)) config[k] = conv[k];
  }

  // ---------------------------------------------------------------------------
  //  Semantic display metadata — one table mapping component fields to
  //  human-readable labels + units. Values are stored in SI; toDisplay/
  //  fromDisplay convert for the input. The user never sees raw Mr/Mtheta.
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
        toDisplay: function (m) { return m * MU0; },
        fromDisplay: function (b) { return b / MU0; } },
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

  const KIND_LABEL = {
    iron: "iron",
    magnet: "magnet",
    "distributed-winding": "distributed winding",
    "concentrated-winding": "concentrated winding",
    cage: "cage",
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
    for (let i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null) o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = val;
  }

  // A default component sized inside the ring's current radial band. Only the
  // circuit-free kinds (iron, magnet) are offered for add — winding/cage need
  // matching circuits, which the validator enforces and which the circuit
  // editor owns.
  function defaultComponent(kind, ring) {
    const ext = ringExtents(ring);
    const r0 = isFinite(ext.lo) ? ext.lo : 0.03;
    const r1 = isFinite(ext.hi) ? ext.hi : 0.04;
    if (kind === "magnet") {
      return { kind: "magnet", rRange: [r0, r1], poles: 2, Mr: 1 / MU0, alpha: 1 };
    }
    return { kind: "iron", rRange: [r0, r1], muR: 1000, alpha: 1 };
  }

  // ---------------------------------------------------------------------------
  //  Public API
  // ---------------------------------------------------------------------------
  UM.GeometryPanel = {
    applyGapLength: applyGapLength,
    setSlices: setSlices,
    defaultAxial: defaultAxial,
    commitEdit: commitEdit,
    ensureComponentForm: ensureComponentForm,
  };

  // ---------------------------------------------------------------------------
  //  Panel registration — shelf panel; DOM lives inside build()
  // ---------------------------------------------------------------------------
  UM.registerPanel({
    id: "geometry-editor",
    zone: "shelf",
    build: function (host, ctx) {
      const listeners = [];
      function addListener(el, evt, fn) {
        el.addEventListener(evt, fn);
        listeners.push({ el: el, evt: evt, fn: fn });
      }

      // The live config is edited in component form. Convert on build so a
      // freshly-loaded (legacy) machine becomes editable here without a runtime
      // shim elsewhere.
      ensureComponentForm(ctx.config);

      const statusEl = document.createElement("div");
      statusEl.className = "gp-status";
      statusEl.style.cssText = "color:#ff8a65;font-size:0.8em;min-height:1em;margin:0 0 4px;";
      const contentEl = document.createElement("div");
      host.appendChild(statusEl);
      host.appendChild(contentEl);

      function setError(msg) { statusEl.textContent = msg || ""; }

      function applyEdit(mutateFn) {
        const res = commitEdit(ctx.config, function (c) {
          mutateFn(c);
          fitGridToRings(c);
        });
        if (res.ok) {
          setError("");
          ctx.requestRebuild();
        } else {
          setError("Rejected: " + ((res.errors && res.errors[0]) || "invalid geometry"));
          rebuild();
        }
      }

      // -- small DOM builders ---------------------------------------------------
      function buildNumberInput(parent, label, value, onChange, opts) {
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

      function buildSelect(parent, label, value, options, onChange) {
        const wrap = document.createElement("label");
        wrap.className = "gp-field";
        wrap.textContent = label + ": ";
        const sel = document.createElement("select");
        for (const o of options) {
          const opt = document.createElement("option");
          opt.value = o;
          opt.textContent = o;
          if (o === value) opt.selected = true;
          sel.appendChild(opt);
        }
        addListener(sel, "change", function () { onChange(sel.value); });
        wrap.appendChild(sel);
        parent.appendChild(wrap);
        return sel;
      }

      function buildOpacity(parent, value, onChange) {
        const wrap = document.createElement("label");
        wrap.className = "gp-field gp-opacity";
        wrap.textContent = "Opacity: ";
        const inp = document.createElement("input");
        inp.type = "range";
        inp.min = "0"; inp.max = "1"; inp.step = "0.01";
        inp.value = value != null ? value : 1;
        const read = document.createElement("span");
        read.textContent = " " + (value != null ? value : 1).toFixed(2);
        addListener(inp, "input", function () {
          read.textContent = " " + parseFloat(inp.value).toFixed(2);
        });
        addListener(inp, "change", function () {
          const v = parseFloat(inp.value);
          if (isFinite(v)) onChange(Math.max(0, Math.min(1, v)));
        });
        wrap.appendChild(inp);
        wrap.appendChild(read);
        parent.appendChild(wrap);
      }

      // -- one component card ---------------------------------------------------
      function buildComponentCard(parent, ri, ci) {
        const comp = ctx.config.rings[ri].components[ci];
        const card = document.createElement("div");
        card.className = "gp-comp";
        card.style.cssText = "border:1px solid var(--grid,#2a313c);border-radius:4px;padding:4px 6px;margin:4px 0;background:var(--panel2,#232932);";

        const head = document.createElement("div");
        head.className = "gp-comp-head";
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
        const name = document.createElement("span");
        name.className = "gp-comp-kind";
        name.style.cssText = "font-weight:bold;color:var(--accent,#4ea1ff);";
        name.textContent = KIND_LABEL[comp.kind] || comp.kind;
        head.appendChild(name);

        const rm = document.createElement("button");
        rm.className = "gp-comp-rm";
        rm.style.cssText = "background:none;border:none;color:#ff8a65;cursor:pointer;font-size:0.9em;";
        rm.textContent = "✕";
        rm.title = "remove component";
        addListener(rm, "click", function () {
          applyEdit(function (c) { c.rings[ri].components.splice(ci, 1); });
        });
        head.appendChild(rm);
        card.appendChild(head);

        // Radii (mm)
        buildNumberInput(card, "R inner", (comp.rRange[0] * MM).toFixed(2), function (v) {
          applyEdit(function (c) { c.rings[ri].components[ci].rRange[0] = v / MM; });
        }, { unit: "mm", step: 0.1 });
        buildNumberInput(card, "R outer", (comp.rRange[1] * MM).toFixed(2), function (v) {
          applyEdit(function (c) { c.rings[ri].components[ci].rRange[1] = v / MM; });
        }, { unit: "mm", step: 0.1 });

        // Kind-specific semantic fields (only those the component actually has)
        for (const f of (COMPONENT_FIELDS[comp.kind] || [])) {
          const raw = getPath(comp, f.key);
          if (raw == null) continue;
          const shown = f.toDisplay ? f.toDisplay(raw) : raw;
          buildNumberInput(card, f.label, f.int ? shown : Number(shown),
            (function (field) {
              return function (v) {
                const store = field.fromDisplay ? field.fromDisplay(v) : v;
                applyEdit(function (c) { setPath(c.rings[ri].components[ci], field.key, store); });
              };
            })(f), { unit: f.unit, int: f.int });
        }

        buildOpacity(card, comp.alpha, function (v) {
          applyEdit(function (c) { c.rings[ri].components[ci].alpha = v; });
        });

        parent.appendChild(card);
      }

      // -- one ring (a list of component cards + add control) -------------------
      function buildRing(parent, ri) {
        const ring = ctx.config.rings[ri];
        const section = document.createElement("div");
        section.className = "gp-ring";

        const title = document.createElement("div");
        title.className = "gp-ring-title";
        title.textContent = "Ring " + ri;
        section.appendChild(title);

        (ring.components || []).forEach(function (comp, ci) {
          buildComponentCard(section, ri, ci);
        });

        // Add component (circuit-free kinds only)
        const addWrap = document.createElement("div");
        addWrap.className = "gp-add";
        const sel = document.createElement("select");
        for (const k of ["iron", "magnet"]) {
          const opt = document.createElement("option");
          opt.value = k;
          opt.textContent = KIND_LABEL[k];
          sel.appendChild(opt);
        }
        const addBtn = document.createElement("button");
        addBtn.textContent = "+ add";
        addListener(addBtn, "click", function () {
          const kind = sel.value;
          applyEdit(function (c) {
            c.rings[ri].components.push(defaultComponent(kind, c.rings[ri]));
          });
        });
        addWrap.appendChild(sel);
        addWrap.appendChild(addBtn);
        section.appendChild(addWrap);

        parent.appendChild(section);
      }

      // -- a body group (inner / outer) with its motion dropdown ----------------
      function buildBody(parent, side) {
        const ringIdx = [];
        ctx.config.rings.forEach(function (r, i) { if (r.member === side) ringIdx.push(i); });
        if (!ringIdx.length) return;

        const group = document.createElement("div");
        group.className = "gp-body";
        group.style.cssText = "margin:6px 0;padding-top:4px;border-top:1px solid var(--grid,#2a313c);";

        const head = document.createElement("div");
        head.className = "gp-body-head";
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
        const label = document.createElement("span");
        label.className = "gp-body-name";
        label.style.cssText = "font-weight:bold;text-transform:capitalize;";
        label.textContent = side + " body";
        head.appendChild(label);

        const motion = ctx.config.motion || {};
        buildSelect(head, "Motion", motion[side] === "rotating" ? "rotating" : "static",
          ["rotating", "static"], function (v) {
            const other = side === "inner" ? "outer" : "inner";
            applyEdit(function (c) {
              if (!c.motion) c.motion = {};
              // Exactly one side rotates — set this side and flip the other.
              c.motion[side] = v;
              c.motion[other] = (v === "rotating") ? "static" : "rotating";
            });
          });
        group.appendChild(head);

        for (const i of ringIdx) buildRing(group, i);
        parent.appendChild(group);
      }

      function buildGapAndSlices() {
        const config = ctx.config;

        // Gap length
        const gapSection = document.createElement("div");
        gapSection.className = "gp-gap";
        const gapLabel = document.createElement("label");
        gapLabel.textContent = "Gap length (mm): ";
        const gapInput = document.createElement("input");
        gapInput.type = "number";
        gapInput.step = "0.01";
        gapInput.min = "0";
        const groups = innerOuterGroups(config);
        if (groups.inner.length && groups.outer.length) {
          let rIn = -Infinity, rOut = Infinity;
          for (const r of groups.inner) { const h = ringExtents(r).hi; if (h > rIn) rIn = h; }
          for (const r of groups.outer) { const l = ringExtents(r).lo; if (l < rOut) rOut = l; }
          gapInput.value = ((rOut - rIn) * MM).toFixed(3);
        }
        addListener(gapInput, "change", function () {
          const g = parseFloat(gapInput.value) / MM;
          if (isFinite(g) && g > 0) {
            applyGapLength(config, g);
            ctx.requestRebuild();
          }
        });
        gapLabel.appendChild(gapInput);
        gapSection.appendChild(gapLabel);
        contentEl.appendChild(gapSection);

        // Slices
        const sliceSection = document.createElement("div");
        sliceSection.className = "gp-slices";
        const stack = config.stack || {};
        const nSlices = stack.slices != null ? stack.slices : 1;
        const sliceReadout = document.createElement("span");
        sliceReadout.textContent = "Slices: " + nSlices + " ";
        sliceSection.appendChild(sliceReadout);

        const addBtn = document.createElement("button");
        addBtn.textContent = "+ add slice";
        addBtn.disabled = nSlices >= 4;
        addListener(addBtn, "click", function () {
          if (nSlices < 4) { setSlices(config, nSlices + 1); ctx.requestRebuild(); rebuild(); }
        });
        sliceSection.appendChild(addBtn);

        const rmBtn = document.createElement("button");
        rmBtn.textContent = "- remove slice";
        rmBtn.disabled = nSlices <= 1;
        addListener(rmBtn, "click", function () {
          if (nSlices > 1) { setSlices(config, nSlices - 1); ctx.requestRebuild(); rebuild(); }
        });
        sliceSection.appendChild(rmBtn);
        contentEl.appendChild(sliceSection);

        // Axial-flux netlist (visible when slices > 1)
        if (nSlices > 1 && stack.axial) {
          const axSection = document.createElement("div");
          axSection.className = "gp-axial";
          const axTitle = document.createElement("div");
          axTitle.textContent = "Axial-flux netlist";
          axSection.appendChild(axTitle);

          const ax = stack.axial;
          const defs = ax.branches || {};
          for (const bname of Object.keys(defs)) {
            const b = defs[bname];
            const bDiv = document.createElement("div");
            bDiv.className = "gp-branch";
            const bLabel = document.createElement("span");
            bLabel.textContent = "Branch \"" + bname + "\": ";
            bDiv.appendChild(bLabel);
            for (const field of ["Br", "length", "area", "muR", "reluctance", "mmf"]) {
              if (b[field] != null) {
                buildNumberInput(bDiv, field, b[field], (function (fieldName) {
                  return function (v) {
                    applyEdit(function (c) { c.stack.axial.branches[bname][fieldName] = v; });
                  };
                })(field));
              }
            }
            axSection.appendChild(bDiv);
          }
          ax.loops.forEach(function (loop, li) {
            const lDiv = document.createElement("div");
            lDiv.className = "gp-loop";
            const lLabel = document.createElement("span");
            lLabel.textContent = "Loop " + li + ": ";
            lDiv.appendChild(lLabel);
            if (loop.Raxial != null) {
              buildNumberInput(lDiv, "Raxial", loop.Raxial, function (v) {
                applyEdit(function (c) { c.stack.axial.loops[li].Raxial = v; });
              });
            }
            if (loop.Fpm != null) {
              buildNumberInput(lDiv, "Fpm", loop.Fpm, function (v) {
                applyEdit(function (c) { c.stack.axial.loops[li].Fpm = v; });
              });
            }
            axSection.appendChild(lDiv);
          });
          contentEl.appendChild(axSection);
        }
      }

      function rebuild() {
        contentEl.innerHTML = "";
        if (!Array.isArray(ctx.config.rings)) return;
        buildBody(contentEl, "inner");
        buildBody(contentEl, "outer");
        buildGapAndSlices();
      }

      rebuild();

      return function unmount() {
        for (const { el, evt, fn } of listeners) {
          el.removeEventListener(evt, fn);
        }
        listeners.length = 0;
        host.innerHTML = "";
      };
    },
  });
})();
