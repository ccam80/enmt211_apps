(function () {
  "use strict";

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  // ---------------------------------------------------------------------------
  //  Internal helpers
  // ---------------------------------------------------------------------------

  // Collect radial occupancy segments for a ring using the same per-element
  // rule as deriveGapBand in config-schema.js (lines 73–92).
  function ringSegments(ring) {
    const el = ring.element;
    const segments = [];
    if (el === "I") {
      segments.push(ring.rRange);
    } else if (el === "M") {
      segments.push(ring.rRange);
      if (ring.backIron && ring.backIronRRange) {
        segments.push(ring.backIronRRange);
      }
    } else if (el === "W" || el === "K") {
      segments.push(ring.slotRRange != null ? ring.slotRRange : ring.rRange);
      segments.push(ring.ironRRange != null ? ring.ironRRange : ring.rRange);
    } else if (el === "C") {
      segments.push(ring.slotRRange != null ? ring.slotRRange : ring.rRange);
      segments.push(ring.ironRRange != null ? ring.ironRRange : ring.rRange);
      segments.push(ring.rRange);
    }
    return segments;
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

  // ---------------------------------------------------------------------------
  //  applyGapLength(config, g) — moves both gap-facing surfaces symmetrically.
  //  Returns the achieved gap.
  // ---------------------------------------------------------------------------
  function applyGapLength(config, g) {
    const grid = config.grid;
    const dr = (grid.rOuter - grid.rInner) / grid.Nr;

    const rotorRings = config.rings.filter(function (r) { return r.member === "rotor"; });
    const statorRings = config.rings.filter(function (r) { return r.member === "stator"; });

    // Mean midpoint radius of each group
    function meanMid(rings) {
      let sum = 0;
      for (const r of rings) sum += ringMid(r);
      return sum / rings.length;
    }

    const innerGroup = (meanMid(rotorRings) <= meanMid(statorRings)) ? rotorRings : statorRings;
    const outerGroup = (meanMid(rotorRings) <= meanMid(statorRings)) ? statorRings : rotorRings;

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
    const delta_in = newRIn - rIn;   // negative when gap grows
    const delta_out = newROut - rOut; // positive when gap grows

    // Update every concrete slot in the inner owner that equals rIn
    function updateRangeSlot(arr, oldVal, newVal) {
      if (!Array.isArray(arr) || arr.length < 2) return;
      for (let i = 0; i < arr.length; i++) {
        if (Math.abs(arr[i] - oldVal) < 1e-15) arr[i] = newVal;
      }
    }

    const innerSegs = ringSegments(innerOwner);
    for (const seg of innerSegs) {
      updateRangeSlot(seg, rIn, newRIn);
    }
    // Also update the ring's own rRange slot if it equals rIn
    updateRangeSlot(innerOwner.rRange, rIn, newRIn);

    const outerSegs = ringSegments(outerOwner);
    for (const seg of outerSegs) {
      updateRangeSlot(seg, rOut, newROut);
    }
    updateRangeSlot(outerOwner.rRange, rOut, newROut);

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
  //  Public API
  // ---------------------------------------------------------------------------
  UM.GeometryPanel = {
    applyGapLength: applyGapLength,
    setSlices: setSlices,
    defaultAxial: defaultAxial,
    commitEdit: commitEdit,
  };

  // ---------------------------------------------------------------------------
  //  Panel registration — shelf panel; DOM lives inside build()
  // ---------------------------------------------------------------------------
  UM.registerPanel({
    id: "geometry-editor",
    zone: "shelf",
    build: function (host, ctx) {
      // Render per-ring geometry/material controls and global gap/slice controls.
      // Rebuilds the host DOM on each call; returns unmount to clean up listeners.

      const listeners = [];

      function addListener(el, evt, fn) {
        el.addEventListener(evt, fn);
        listeners.push({ el: el, evt: evt, fn: fn });
      }

      function rebuild() {
        host.innerHTML = "";
        const config = ctx.config;
        const rings = config.rings || [];

        // Per-ring controls
        rings.forEach(function (ring, ri) {
          const section = document.createElement("div");
          section.className = "gp-ring";

          const title = document.createElement("div");
          title.className = "gp-ring-title";
          title.textContent = "Ring " + ri + " [" + ring.member + " / " + ring.element + "]";
          section.appendChild(title);

          // rRange[0]
          buildNumberInput(section, "rRange[0]", ring.rRange[0], function (v) {
            commitEdit(config, function (c) { c.rings[ri].rRange[0] = v; });
            ctx.requestRebuild();
          });
          // rRange[1]
          buildNumberInput(section, "rRange[1]", ring.rRange[1], function (v) {
            commitEdit(config, function (c) { c.rings[ri].rRange[1] = v; });
            ctx.requestRebuild();
          });

          if (ring.element === "I" && ring.teeth != null) {
            buildIntInput(section, "teeth", ring.teeth, function (v) {
              commitEdit(config, function (c) { c.rings[ri].teeth = v; });
              ctx.requestRebuild();
            });
          }
          if (ring.element === "M" && ring.magnets != null) {
            buildIntInput(section, "magnets", ring.magnets, function (v) {
              commitEdit(config, function (c) { c.rings[ri].magnets = v; });
              ctx.requestRebuild();
            });
          }
          if ((ring.element === "W" || ring.element === "C") &&
              ring.winding && ring.winding.standard) {
            buildIntInput(section, "Q (slots)", ring.winding.standard.Q, function (v) {
              commitEdit(config, function (c) {
                c.rings[ri].winding.standard.Q = v;
              });
              ctx.requestRebuild();
            });
          }
          if (ring.muR != null) {
            buildNumberInput(section, "muR", ring.muR, function (v) {
              commitEdit(config, function (c) { c.rings[ri].muR = v; });
              ctx.requestRebuild();
            });
          }
          if (ring.element === "M" && ring.Mr != null) {
            buildNumberInput(section, "Mr", ring.Mr, function (v) {
              commitEdit(config, function (c) { c.rings[ri].Mr = v; });
              ctx.requestRebuild();
            });
          }
          if (ring.Bknee != null) {
            buildNumberInput(section, "Bknee", ring.Bknee, function (v) {
              commitEdit(config, function (c) { c.rings[ri].Bknee = v; });
              ctx.requestRebuild();
            });
          }

          host.appendChild(section);
        });

        // Global gap length
        const gapSection = document.createElement("div");
        gapSection.className = "gp-gap";
        const gapLabel = document.createElement("label");
        gapLabel.textContent = "Gap length (m): ";
        const gapInput = document.createElement("input");
        gapInput.type = "number";
        gapInput.step = "0.0001";
        gapInput.min = "0";
        // Compute current gap
        const rotorRings = config.rings.filter(function (r) { return r.member === "rotor"; });
        const statorRings = config.rings.filter(function (r) { return r.member === "stator"; });
        if (rotorRings.length > 0 && statorRings.length > 0) {
          let rIn = -Infinity, rOut = Infinity;
          const meanMid = function (rs) {
            let s = 0; for (const r of rs) s += ringMid(r); return s / rs.length;
          };
          const innerG = (meanMid(rotorRings) <= meanMid(statorRings)) ? rotorRings : statorRings;
          const outerG = (meanMid(rotorRings) <= meanMid(statorRings)) ? statorRings : rotorRings;
          for (const r of innerG) { const h = ringExtents(r).hi; if (h > rIn) rIn = h; }
          for (const r of outerG) { const l = ringExtents(r).lo; if (l < rOut) rOut = l; }
          gapInput.value = (rOut - rIn).toFixed(6);
        }
        addListener(gapInput, "change", function () {
          const g = parseFloat(gapInput.value);
          if (isFinite(g) && g > 0) {
            applyGapLength(config, g);
            ctx.requestRebuild();
          }
        });
        gapLabel.appendChild(gapInput);
        gapSection.appendChild(gapLabel);
        host.appendChild(gapSection);

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
          if (nSlices < 4) {
            setSlices(config, nSlices + 1);
            ctx.requestRebuild();
            rebuild();
          }
        });
        sliceSection.appendChild(addBtn);

        const rmBtn = document.createElement("button");
        rmBtn.textContent = "- remove slice";
        rmBtn.disabled = nSlices <= 1;
        addListener(rmBtn, "click", function () {
          if (nSlices > 1) {
            setSlices(config, nSlices - 1);
            ctx.requestRebuild();
            rebuild();
          }
        });
        sliceSection.appendChild(rmBtn);
        host.appendChild(sliceSection);

        // Axial-flux netlist (visible when slices > 1)
        if (nSlices > 1 && stack.axial) {
          const axSection = document.createElement("div");
          axSection.className = "gp-axial";
          const axTitle = document.createElement("div");
          axTitle.textContent = "Axial-flux netlist";
          axSection.appendChild(axTitle);

          const ax = stack.axial;
          const defs = ax.branches || {};

          // Per-branch controls
          for (const bname of Object.keys(defs)) {
            const b = defs[bname];
            const bDiv = document.createElement("div");
            bDiv.className = "gp-branch";
            const bLabel = document.createElement("span");
            bLabel.textContent = "Branch \"" + bname + "\": ";
            bDiv.appendChild(bLabel);

            const fields = ["Br", "length", "area", "muR", "reluctance", "mmf"];
            for (const field of fields) {
              if (b[field] != null) {
                buildNumberInput(bDiv, field, b[field], function (fieldName) {
                  return function (v) {
                    commitEdit(config, function (c) {
                      c.stack.axial.branches[bname][fieldName] = v;
                    });
                    ctx.requestRebuild();
                  };
                }(field));
              }
            }
            axSection.appendChild(bDiv);
          }

          // Per-loop controls
          ax.loops.forEach(function (loop, li) {
            const lDiv = document.createElement("div");
            lDiv.className = "gp-loop";
            const lLabel = document.createElement("span");
            lLabel.textContent = "Loop " + li + ": ";
            lDiv.appendChild(lLabel);

            if (loop.Raxial != null) {
              buildNumberInput(lDiv, "Raxial", loop.Raxial, function (v) {
                commitEdit(config, function (c) {
                  c.stack.axial.loops[li].Raxial = v;
                });
                ctx.requestRebuild();
              });
            }
            if (loop.Fpm != null) {
              buildNumberInput(lDiv, "Fpm", loop.Fpm, function (v) {
                commitEdit(config, function (c) {
                  c.stack.axial.loops[li].Fpm = v;
                });
                ctx.requestRebuild();
              });
            }

            axSection.appendChild(lDiv);
          });

          host.appendChild(axSection);
        }
      }

      function buildNumberInput(parent, label, value, onChange) {
        const wrap = document.createElement("label");
        wrap.textContent = label + ": ";
        const inp = document.createElement("input");
        inp.type = "number";
        inp.step = "any";
        inp.value = value;
        addListener(inp, "change", function () {
          const v = parseFloat(inp.value);
          if (isFinite(v)) onChange(v);
        });
        wrap.appendChild(inp);
        parent.appendChild(wrap);
      }

      function buildIntInput(parent, label, value, onChange) {
        const wrap = document.createElement("label");
        wrap.textContent = label + ": ";
        const inp = document.createElement("input");
        inp.type = "number";
        inp.step = "1";
        inp.value = value;
        addListener(inp, "change", function () {
          const v = parseInt(inp.value, 10);
          if (Number.isInteger(v)) onChange(v);
        });
        wrap.appendChild(inp);
        parent.appendChild(wrap);
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
