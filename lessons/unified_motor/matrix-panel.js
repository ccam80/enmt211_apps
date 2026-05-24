(function () {
  "use strict";

  const TWO_PI = 2 * Math.PI;

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  // ---------------------------------------------------------------------------
  //  toggleSpace() → { elements, excitations, commutations }
  //
  //  Returns the complete vocabulary for the per-ring toggle selectors.
  //  Drives the toggle UI generically — no machine identity.
  // ---------------------------------------------------------------------------
  function toggleSpace() {
    return {
      elements: ["W", "C", "M", "I", "K"],
      excitations: ["AC", "DC", "PULSE", "STEP", "OPEN", "SHORT"],
      commutations: [
        "none",
        "mechanical",
        "electronic-trap",
        "electronic-sine",
        "sequencer",
      ],
    };
  }

  // ---------------------------------------------------------------------------
  //  synthesize(toggles, base = {}) → config
  //
  //  Builds a complete config from the toggle state.
  //  toggles = {
  //    poles, grid?, gapBand?, mechanical?, stack?,
  //    rings: [ {
  //      member, element, count,
  //      m?, p?, Q?, coilPitch?, turns?,
  //      excitation: { type, amp?, freq?, conductionAngle? },
  //      commutation: { mode },
  //      R?, Mr?
  //    }, ... ]
  //  }
  // ---------------------------------------------------------------------------
  function synthesize(toggles, base) {
    if (base === undefined) base = {};

    const DEFAULTS = {
      grid: { Nr: 12, Ntheta: 256, rInner: 0.04, rOuter: 0.05, ell: 0.1 },
      gapBand: { iInner: 4, iOuter: 8 },
      mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
      poles: 2,
    };

    const poles = toggles.poles != null ? toggles.poles
                : (base.poles != null ? base.poles : DEFAULTS.poles);

    const grid = toggles.grid != null ? toggles.grid
               : (base.grid != null ? base.grid : DEFAULTS.grid);

    const mechanical = toggles.mechanical != null ? toggles.mechanical
                     : (base.mechanical != null ? base.mechanical : DEFAULTS.mechanical);

    const stack = toggles.stack != null ? toggles.stack
                : { slices: 1, sliceOffsets: [0], fluxSources: [] };

    // Compute the boundary radii using the gap band row indices.
    // The gap band occupies rows [iInner, iOuter) which must be pure air.
    // Rotor rings fill [rInner, rotorHi] where rotorHi = rInner + iInner*dr.
    // Stator rings fill [statorLo, rOuter] where statorLo = rInner + iOuter*dr.
    // This leaves rows iInner..(iOuter-1) as pure air for auto gap-band derivation.
    const gapBandDefault = toggles.gapBand != null ? toggles.gapBand
                         : (base.gapBand != null ? base.gapBand : DEFAULTS.gapBand);
    const dr = (grid.rOuter - grid.rInner) / grid.Nr;
    const rotorHi = grid.rInner + gapBandDefault.iInner * dr;
    const statorLo = grid.rInner + gapBandDefault.iOuter * dr;

    // Split rings into rotor and stator groups (preserving declaration order)
    const rotorRings = [];
    const statorRings = [];
    for (const r of (toggles.rings || [])) {
      if (r.member === "rotor") rotorRings.push(r);
      else statorRings.push(r);
    }

    // Divide [rInner, rotorHi] evenly among rotor rings
    // Divide [statorLo, rOuter] evenly among stator rings
    function computeRRange(member, ringIndex, totalRings) {
      const lo = member === "rotor" ? grid.rInner : statorLo;
      const hi = member === "rotor" ? rotorHi : grid.rOuter;
      const w = (hi - lo) / (totalRings > 0 ? totalRings : 1);
      return [lo + ringIndex * w, lo + (ringIndex + 1) * w];
    }

    // Track index within member group for rRange computation
    const rotorIdx = new Map();
    const statorIdx = new Map();
    let ri_rotor = 0, ri_stator = 0;
    for (const r of (toggles.rings || [])) {
      if (r.member === "rotor") {
        rotorIdx.set(r, ri_rotor++);
      } else {
        statorIdx.set(r, ri_stator++);
      }
    }

    const configRings = [];
    const configCircuits = [];

    for (const ring of (toggles.rings || [])) {
      const member = ring.member;
      const element = ring.element;
      const memberCount = member === "rotor" ? rotorRings.length : statorRings.length;
      const memberIndex = member === "rotor" ? rotorIdx.get(ring) : statorIdx.get(ring);
      const rRange = computeRRange(member, memberIndex, memberCount);

      if (element === "W" || element === "C") {
        const m = ring.m != null ? ring.m : 3;
        const p = ring.p != null ? ring.p : poles;
        const Q = ring.Q != null ? ring.Q : m * p * 2;
        const coilPitch = ring.coilPitch != null ? ring.coilPitch : Math.round(Q / p);
        const turns = ring.turns != null ? ring.turns : 20;

        const winding = {
          standard: { m, p, Q, coilPitch, turns },
        };

        const configRing = {
          member,
          element,
          rRange,
          winding,
        };
        configRings.push(configRing);

        for (let k = 0; k < m; k++) {
          configCircuits.push({
            terminal: {
              type: ring.excitation.type,
              amp: ring.excitation.amp != null ? ring.excitation.amp : 1,
              freq: ring.excitation.freq != null ? ring.excitation.freq : 0,
              phaseOffset: -(TWO_PI * k / m),
              conductionAngle: ring.excitation.conductionAngle != null
                ? ring.excitation.conductionAngle
                : (TWO_PI / 3),
            },
            commutation: {
              mode: ring.commutation.mode,
              poles,
            },
            R: ring.R != null ? ring.R : 1,
          });
        }

      } else if (element === "K") {
        const m = ring.m != null ? ring.m : 3;
        const p = ring.p != null ? ring.p : poles;
        const Q = ring.Q != null ? ring.Q : m * p * 2;
        const coilPitch = ring.coilPitch != null ? ring.coilPitch : Math.round(Q / p);
        const turns = ring.turns != null ? ring.turns : 20;

        const winding = {
          standard: { m, p, Q, coilPitch, turns },
        };

        const configRing = {
          member,
          element,
          rRange,
          winding,
        };
        configRings.push(configRing);

        for (let k = 0; k < m; k++) {
          configCircuits.push({
            terminal: {
              type: "SHORT",
              amp: ring.excitation.amp != null ? ring.excitation.amp : 1,
              freq: ring.excitation.freq != null ? ring.excitation.freq : 0,
              phaseOffset: -(TWO_PI * k / m),
              conductionAngle: ring.excitation.conductionAngle != null
                ? ring.excitation.conductionAngle
                : (TWO_PI / 3),
            },
            commutation: {
              mode: ring.commutation.mode,
              poles,
            },
            R: ring.R != null ? ring.R : 1,
          });
        }

      } else if (element === "M") {
        const count = ring.count != null ? ring.count : 2;
        const configRing = {
          member,
          element,
          rRange,
          magnets: count,
          Mr: ring.Mr != null ? ring.Mr : 1e5,
        };
        configRings.push(configRing);
        // M rings emit zero circuits

      } else if (element === "I") {
        const count = ring.count != null ? ring.count : 2;
        const configRing = {
          member,
          element,
          rRange,
          teeth: count,
        };
        configRings.push(configRing);
        // I rings emit zero circuits
      }
    }

    return {
      grid,
      gapBand: gapBandDefault,
      poles,
      mechanical,
      rings: configRings,
      circuits: configCircuits,
      stack,
      label: base.label != null ? base.label : "",
    };
  }

  // ---------------------------------------------------------------------------
  //  register(UM) — guarded panel registration
  // ---------------------------------------------------------------------------
  function register(UM) {
    if (UM.registerPanel) {
      UM.registerPanel({
        id: "matrix",
        title: "Matrix",
        zone: "shelf",
        build: function (host, ctx) {
          return buildPanel(host, ctx);
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  //  buildPanel(host, ctx) — browser UI
  //
  //  Renders per-ring element/excitation/commutation selectors.
  //  On any change: synthesizes config and calls ctx.requestRebuild().
  //  Not exercised in headless tests.
  // ---------------------------------------------------------------------------
  function buildPanel(host, ctx) {
    const space = toggleSpace();

    // Read current matrixState from ctx.config, or derive from current rings
    let currentToggles = deriveTogglesFromConfig(ctx.config);

    function render() {
      host.innerHTML = "";

      const container = document.createElement("div");
      container.className = "matrix-panel";
      container.style.cssText = "padding:8px;overflow-y:auto;font-size:13px;";

      const title = document.createElement("div");
      title.style.cssText = "font-weight:bold;margin-bottom:8px;color:var(--accent,#4ea1ff);";
      title.textContent = "Machine Matrix";
      container.appendChild(title);

      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";

      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const h of ["Ring", "Member", "Element", "Excitation", "Commutation"]) {
        const th = document.createElement("th");
        th.style.cssText = "padding:2px 6px;text-align:left;border-bottom:1px solid #444;";
        th.textContent = h;
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");

      (currentToggles.rings || []).forEach(function (ring, idx) {
        const tr = document.createElement("tr");

        // Ring label
        const tdLabel = document.createElement("td");
        tdLabel.style.cssText = "padding:2px 6px;";
        tdLabel.textContent = String(idx + 1);
        tr.appendChild(tdLabel);

        // Member
        const tdMember = document.createElement("td");
        tdMember.style.cssText = "padding:2px 6px;";
        const selMember = document.createElement("select");
        selMember.style.cssText = "width:70px;background:#222;color:#eee;border:1px solid #555;";
        for (const m of ["rotor", "stator"]) {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          if (ring.member === m) opt.selected = true;
          selMember.appendChild(opt);
        }
        selMember.addEventListener("change", function () {
          currentToggles.rings[idx].member = this.value;
          applyChange();
        });
        tdMember.appendChild(selMember);
        tr.appendChild(tdMember);

        // Element
        const tdElement = document.createElement("td");
        tdElement.style.cssText = "padding:2px 6px;";
        const selElement = document.createElement("select");
        selElement.style.cssText = "width:50px;background:#222;color:#eee;border:1px solid #555;";
        for (const el of space.elements) {
          const opt = document.createElement("option");
          opt.value = el;
          opt.textContent = el;
          if (ring.element === el) opt.selected = true;
          selElement.appendChild(opt);
        }
        selElement.addEventListener("change", function () {
          currentToggles.rings[idx].element = this.value;
          applyChange();
        });
        tdElement.appendChild(selElement);
        tr.appendChild(tdElement);

        // Excitation
        const tdExcitation = document.createElement("td");
        tdExcitation.style.cssText = "padding:2px 6px;";
        const selExcitation = document.createElement("select");
        selExcitation.style.cssText = "width:70px;background:#222;color:#eee;border:1px solid #555;";
        for (const ex of space.excitations) {
          const opt = document.createElement("option");
          opt.value = ex;
          opt.textContent = ex;
          if (ring.excitation && ring.excitation.type === ex) opt.selected = true;
          selExcitation.appendChild(opt);
        }
        selExcitation.addEventListener("change", function () {
          if (!currentToggles.rings[idx].excitation) {
            currentToggles.rings[idx].excitation = {};
          }
          currentToggles.rings[idx].excitation.type = this.value;
          applyChange();
        });
        tdExcitation.appendChild(selExcitation);
        tr.appendChild(tdExcitation);

        // Commutation
        const tdCommutation = document.createElement("td");
        tdCommutation.style.cssText = "padding:2px 6px;";
        const selCommutation = document.createElement("select");
        selCommutation.style.cssText = "width:120px;background:#222;color:#eee;border:1px solid #555;";
        for (const cm of space.commutations) {
          const opt = document.createElement("option");
          opt.value = cm;
          opt.textContent = cm;
          if (ring.commutation && ring.commutation.mode === cm) opt.selected = true;
          selCommutation.appendChild(opt);
        }
        selCommutation.addEventListener("change", function () {
          if (!currentToggles.rings[idx].commutation) {
            currentToggles.rings[idx].commutation = {};
          }
          currentToggles.rings[idx].commutation.mode = this.value;
          applyChange();
        });
        tdCommutation.appendChild(selCommutation);
        tr.appendChild(tdCommutation);

        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      container.appendChild(table);

      // Poles selector
      const polesRow = document.createElement("div");
      polesRow.style.cssText = "margin-top:10px;display:flex;align-items:center;gap:8px;";
      const polesLabel = document.createElement("label");
      polesLabel.textContent = "Poles: ";
      polesLabel.style.cssText = "color:#ccc;";
      const polesInput = document.createElement("input");
      polesInput.type = "number";
      polesInput.min = "2";
      polesInput.step = "2";
      polesInput.value = String(currentToggles.poles || 2);
      polesInput.style.cssText = "width:60px;background:#222;color:#eee;border:1px solid #555;";
      polesInput.addEventListener("change", function () {
        const v = parseInt(this.value, 10);
        if (Number.isInteger(v) && v >= 2 && v % 2 === 0) {
          currentToggles.poles = v;
          applyChange();
        }
      });
      polesRow.appendChild(polesLabel);
      polesRow.appendChild(polesInput);
      container.appendChild(polesRow);

      host.appendChild(container);
    }

    function applyChange() {
      const cfg = synthesize(currentToggles, ctx.config);
      ctx.config.rings = cfg.rings;
      ctx.config.circuits = cfg.circuits;
      ctx.config.stack = cfg.stack;
      ctx.config.grid = cfg.grid;
      ctx.config.gapBand = cfg.gapBand;
      ctx.config.poles = cfg.poles;
      ctx.config.mechanical = cfg.mechanical;
      ctx.config.matrixState = { rings: JSON.parse(JSON.stringify(currentToggles.rings)) };
      ctx.requestRebuild();
    }

    render();

    return function unmount() {
      host.innerHTML = "";
    };
  }

  // ---------------------------------------------------------------------------
  //  deriveTogglesFromConfig(config) → toggles
  //
  //  Reads back the matrixState snapshot if present, otherwise derives a
  //  toggle snapshot from the live config.
  // ---------------------------------------------------------------------------
  function deriveTogglesFromConfig(config) {
    if (config.matrixState && Array.isArray(config.matrixState.rings)) {
      return {
        poles: config.poles,
        grid: config.grid,
        mechanical: config.mechanical,
        rings: JSON.parse(JSON.stringify(config.matrixState.rings)),
      };
    }

    // Derive from config.rings — best-effort snapshot
    const rings = [];
    let circuitIdx = 0;

    for (const ring of (config.rings || [])) {
      const el = ring.element;
      let m = 3;
      let excitationType = "AC";
      let commMode = "none";

      if (el === "W" || el === "C" || el === "K") {
        if (ring.winding && ring.winding.standard) {
          m = ring.winding.standard.m || 3;
        }
        if (config.circuits && config.circuits[circuitIdx]) {
          excitationType = el === "K" ? "SHORT" : config.circuits[circuitIdx].terminal.type;
          commMode = config.circuits[circuitIdx].commutation
            ? config.circuits[circuitIdx].commutation.mode
            : "none";
        }
        circuitIdx += m;
      }

      const toggleRing = {
        member: ring.member,
        element: el,
        count: el === "M" ? (ring.magnets || 2) : (ring.teeth || 2),
        m: el === "W" || el === "C" || el === "K" ? m : undefined,
        excitation: { type: excitationType },
        commutation: { mode: commMode },
      };
      rings.push(toggleRing);
    }

    return {
      poles: config.poles || 2,
      grid: config.grid,
      mechanical: config.mechanical,
      rings,
    };
  }

  UM.MatrixPanel = { toggleSpace, synthesize, register };

  if (UM.registerPanel) register(UM);
})();
