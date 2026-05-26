"use strict";

// =============================================================================
//  lessons/unified_motor/mount.js
//
//  Browser app entry point for the unified-motor lesson. Attaches the
//  registration seams and the mount function to window.UnifiedMotor.
//
//  Registration seams (populated by Phases 6/7/8/9 before runTabs is called,
//  consumed at mount-time):
//    UnifiedMotor.PANELS             (array of panel entries)
//    UnifiedMotor.TOOLS              (array of tool entries)
//    UnifiedMotor.HEADER_CONTROLS    (array of header-control entries)
//    UnifiedMotor.RENDER3D           (single renderer slot, initially null)
//
//  Public surface:
//    UnifiedMotor.registerPanel(entry)
//    UnifiedMotor.registerTool(entry)
//    UnifiedMotor.registerHeaderControl(entry)
//    UnifiedMotor.registerRender3D(entry)
//    UnifiedMotor.mount(host) → unmount
//
//  No machine awareness: mount reads config-declared presentation and drives
//  the agnostic runtime. No machine-name string literals appear in this file.
// =============================================================================

(function () {
  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  // ---------------------------------------------------------------------------
  //  Registration seams — lazily initialised arrays + single-slot RENDER3D.
  // ---------------------------------------------------------------------------

  if (!Array.isArray(UM.PANELS))          UM.PANELS          = [];
  if (!Array.isArray(UM.TOOLS))           UM.TOOLS           = [];
  if (!Array.isArray(UM.HEADER_CONTROLS)) UM.HEADER_CONTROLS = [];
  if (UM.RENDER3D === undefined)          UM.RENDER3D        = null;

  UM.registerPanel = function (entry) {
    UM.PANELS.push(entry);
  };

  UM.registerTool = function (entry) {
    UM.TOOLS.push(entry);
  };

  UM.registerHeaderControl = function (entry) {
    UM.HEADER_CONTROLS.push(entry);
  };

  UM.registerRender3D = function (entry) {
    UM.RENDER3D = entry;
  };

  // ---------------------------------------------------------------------------
  //  Built-in default config (used when UnifiedMotor.defaultConfig is not set).
  //  Same geometry as woundConfig() in tests/pipeline/_fixtures.js — a
  //  current-fed wound machine with a salient rotor, known to produce non-zero
  //  reluctance torque so the rotor visibly turns.
  //
  //  Mechanical parameters tuned for stable, clearly visible rotation:
  //    J=0.1 kg·m², damping=0.05 N·m·s/rad → steady-state ω ≈ 23 rad/s
  //  This keeps the rotor speed in the 5–40 rad/s target range and the
  //  simulation numerically stable across the full damping slider range.
  // ---------------------------------------------------------------------------

  function makeDefaultConfig() {
    return {
      label: "Default wound machine",
      grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
      poles: 2,
      rings: [
        {
          member: "stator",
          element: "W",
          rRange: [0.052, 0.06],
          winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
          muR: 1000,
        },
        {
          member: "rotor",
          element: "I",
          rRange: [0.04, 0.048],
          teeth: 2,
          muR: 1000,
        },
      ],
      circuits: [
        { terminal: { type: "DC", amp: 5.0 }, commutation: { mode: "none" }, R: 1.0 },
      ],
      stack: { slices: 1 },
      mechanical: { J: 0.1, damping: 0.05, loadTorque: 0 },
    };
  }

  // ---------------------------------------------------------------------------
  //  DOM helpers
  // ---------------------------------------------------------------------------

  function el(tag, cls, style) {
    const e = document.createElement(tag);
    if (cls)   e.className = cls;
    if (style) Object.assign(e.style, style);
    return e;
  }

  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.clientWidth;
    const H   = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { W, H };
  }

  // ---------------------------------------------------------------------------
  //  Slider registry builder
  //  Returns a plain object used as a registry (keys → cfg entries), and
  //  builds LIB.Registry.mkRow rows in the given parent element.
  // ---------------------------------------------------------------------------

  function buildSliders(parent, defs, onChange) {
    const registry = {};
    for (const d of defs) {
      registry[d.key] = {
        label: d.label, min: d.min, max: d.max, step: d.step,
        value: d.value,
        tip:   d.tip   || "",
        log:   d.log   || false,
      };
      LIB.Registry.mkRow(parent, registry, d.key, function (v) {
        if (onChange) onChange(d.key, v);
      });
    }
    return registry;
  }

  // ---------------------------------------------------------------------------
  //  Feature geometry helpers — colour + drawing of machine structural regions
  //  Dispatches only on feature.kind and feature.member — no machine identity.
  // ---------------------------------------------------------------------------

  // Colours by feature kind.
  const KIND_COLORS = {
    iron:      "#607080",   // steel grey
    conductor: "#b87333",   // copper (base; tinted by current sign at draw time)
    magnet:    "#c0392b",   // red (base; sign determines red vs blue)
  };

  // Return fill colour for a feature given the live current for its circuit.
  function featureColor(feature, currents) {
    if (feature.kind === "iron") {
      return feature.member === "rotor" ? "#4a6070" : "#607080";
    }
    if (feature.kind === "magnet") {
      return feature.Mr >= 0 ? "#c0392b" : "#2980b9";
    }
    if (feature.kind === "conductor") {
      const i = (currents && feature.circuit < currents.length)
        ? currents[feature.circuit] : 0;
      const sign = feature.sign != null ? feature.sign : 1;
      const net = i * sign;
      if (net > 1e-6)  return "#e67e22";  // orange-copper, current flowing in
      if (net < -1e-6) return "#2471a3";  // blue, current flowing out
      return "#7f8c8d";                   // grey, near zero
    }
    return "#8a93a3";
  }

  // Draw a filled annular sector on a 2D canvas (cx,cy = centre px, scale = m→px).
  // thetaLo..thetaHi is the angular span (radians, CCW from +x, y-up).
  // Canvas y is flipped: py = cy - y_world * scale.
  function fillSector2D(ctx2, cx, cy, r0px, r1px, thLo, thHi, color, alpha) {
    const dth = thHi - thLo;
    if (dth <= 0 || r1px <= r0px) return;

    // Clamp to at most 2π to avoid degenerate full-ring sectors painted twice.
    const thEnd = (dth >= 2 * Math.PI - 1e-9) ? thLo + 2 * Math.PI : thHi;
    const fullRing = dth >= 2 * Math.PI - 1e-9;

    ctx2.save();
    ctx2.globalAlpha = alpha != null ? alpha : 1;
    ctx2.fillStyle = color;
    ctx2.beginPath();
    if (fullRing) {
      // Two concentric circles (annulus).
      ctx2.arc(cx, cy, r1px, 0, 2 * Math.PI, false);
      ctx2.arc(cx, cy, r0px, 0, 2 * Math.PI, true);
    } else {
      // Arc path: outer arc CCW, inner arc CW.
      // Canvas y-flip: angle maps as θ_canvas = -θ_world (CW on screen = CCW in math).
      ctx2.arc(cx, cy, r0px, -thLo, -thEnd, true);   // inner arc (reversed)
      ctx2.arc(cx, cy, r1px, -thEnd, -thLo, false);  // outer arc
    }
    ctx2.closePath();
    ctx2.fill();
    ctx2.restore();
  }

  // Draw machine structural features as filled annular sectors on a 2D canvas.
  // features = expanded.slices[k].section.features
  // thetaR   = live rotor angle (radians) — added to rotor-member thetaRanges
  // currents = Float64Array of per-circuit current values (for conductor tint)
  function drawFeatureSectors2D(ctx2, features, cx, cy, scale, thetaR, currents) {
    const TWO_PI = 2 * Math.PI;
    for (const f of features) {
      const r0px = f.rRange[0] * scale;
      const r1px = f.rRange[1] * scale;
      const color = featureColor(f, currents);

      let thLo, thHi;
      if (!f.thetaRange || (f.thetaRange[1] - f.thetaRange[0]) >= TWO_PI - 1e-9) {
        // Full ring (e.g. back-iron).
        thLo = 0;
        thHi = TWO_PI;
      } else {
        thLo = f.thetaRange[0];
        thHi = f.thetaRange[1];
        if (f.member === "rotor") {
          thLo += thetaR;
          thHi += thetaR;
        }
      }
      fillSector2D(ctx2, cx, cy, r0px, r1px, thLo, thHi, color, 0.85);
    }
  }

  // ---------------------------------------------------------------------------
  //  3D viewport geometry helpers
  // ---------------------------------------------------------------------------

  // Sample K points around a ring at radius r in the z=planeZ plane.
  function ringPoints(r, planeZ, K) {
    K = K || 64;
    const pts = new Array(K);
    for (let i = 0; i < K; i++) {
      const a = (i / K) * 2 * Math.PI;
      pts[i] = { x: r * Math.cos(a), y: r * Math.sin(a), z: planeZ };
    }
    return pts;
  }

  // Draw a projected ring outline.
  function drawRing3D(ctx, L3, r, planeZ, color, lineWidth, K) {
    const pts = ringPoints(r, planeZ, K || 64);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth || 1.5;
    ctx.lineCap = "round";
    let started = false;
    let prevBehind = true;
    ctx.beginPath();
    for (let i = 0; i <= pts.length; i++) {
      const p = pts[i % pts.length];
      const sp = L3.project(p);
      if (sp.behind) { prevBehind = true; continue; }
      if (!started || prevBehind) { ctx.moveTo(sp.px, sp.py); started = true; }
      else                        { ctx.lineTo(sp.px, sp.py); }
      prevBehind = false;
    }
    ctx.stroke();
    ctx.restore();
  }

  // Draw a filled annular sector in 3D by sampling its boundary polygon and
  // projecting each vertex through L3.  Arc is sampled at arcSteps points.
  function fillSector3D(ctx, L3, r0, r1, thLo, thHi, planeZ, color, alpha, arcSteps) {
    arcSteps = arcSteps || 16;
    const dth = thHi - thLo;
    if (dth <= 0 || r1 <= r0) return;
    const fullRing = dth >= 2 * Math.PI - 1e-9;

    // Build polygon points: outer arc forward, inner arc backward.
    const pts = [];
    const steps = fullRing ? arcSteps : Math.max(4, Math.round(arcSteps * dth / (2 * Math.PI)));
    for (let s = 0; s <= steps; s++) {
      const a = fullRing ? (s / steps) * 2 * Math.PI : thLo + (s / steps) * dth;
      pts.push({ x: r1 * Math.cos(a), y: r1 * Math.sin(a), z: planeZ });
    }
    if (!fullRing) {
      for (let s = steps; s >= 0; s--) {
        const a = thLo + (s / steps) * dth;
        pts.push({ x: r0 * Math.cos(a), y: r0 * Math.sin(a), z: planeZ });
      }
    } else {
      // For full ring, project a filled disc minus hole — use two separate paths.
      ctx.save();
      ctx.globalAlpha = alpha != null ? alpha : 0.85;
      ctx.fillStyle = color;
      // Outer circle
      const outerPts = pts.map(p => L3.project(p));
      const visOuter = outerPts.filter(p => !p.behind);
      if (visOuter.length < 3) { ctx.restore(); return; }
      ctx.beginPath();
      let first = true;
      for (const sp of outerPts) {
        if (sp.behind) { first = true; continue; }
        if (first) { ctx.moveTo(sp.px, sp.py); first = false; }
        else        { ctx.lineTo(sp.px, sp.py); }
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }

    // Project all polygon points.
    const projected = pts.map(p => L3.project(p));
    const visible = projected.filter(p => !p.behind);
    if (visible.length < 3) return;

    ctx.save();
    ctx.globalAlpha = alpha != null ? alpha : 0.85;
    ctx.fillStyle = color;
    ctx.beginPath();
    let first = true;
    for (const sp of projected) {
      if (sp.behind) { first = true; continue; }
      if (first) { ctx.moveTo(sp.px, sp.py); first = false; }
      else        { ctx.lineTo(sp.px, sp.py); }
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Draw machine structural features as filled 3D projected sectors.
  function drawFeatureSectors3D(ctx, L3, features, planeZ, thetaR, currents) {
    const TWO_PI = 2 * Math.PI;
    for (const f of features) {
      const r0 = f.rRange[0];
      const r1 = f.rRange[1];
      const color = featureColor(f, currents);

      let thLo, thHi;
      if (!f.thetaRange || (f.thetaRange[1] - f.thetaRange[0]) >= TWO_PI - 1e-9) {
        thLo = 0;
        thHi = TWO_PI;
      } else {
        thLo = f.thetaRange[0];
        thHi = f.thetaRange[1];
        if (f.member === "rotor") {
          thLo += thetaR;
          thHi += thetaR;
        }
      }
      fillSector3D(ctx, L3, r0, r1, thLo, thHi, planeZ, color, 0.82, 24);
    }
  }

  // Draw radial conductor lines for a wound ring (slot conductors projected in 3D).
  function drawSlotConductors3D(ctx, L3, ring, thetaR, planeZ, current, color) {
    const rInner = ring.rRange[0];
    const rOuter = ring.rRange[1];
    const nSlots = ring.winding && ring.winding.standard ? ring.winding.standard.Q : 6;
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    for (let q = 0; q < nSlots; q++) {
      const a = (ring.member === "rotor" ? thetaR : 0) + (q / nSlots) * 2 * Math.PI;
      const goColor    = (q % 2 === 0) ? color : "rgba(80,80,80,0.7)";
      const innerPt = { x: rInner * Math.cos(a), y: rInner * Math.sin(a), z: planeZ };
      const outerPt = { x: rOuter * Math.cos(a), y: rOuter * Math.sin(a), z: planeZ };
      const pi = L3.project(innerPt);
      const po = L3.project(outerPt);
      if (pi.behind && po.behind) continue;
      ctx.strokeStyle = goColor;
      ctx.beginPath();
      if (!pi.behind) ctx.moveTo(pi.px, pi.py);
      if (!po.behind) {
        if (pi.behind) ctx.moveTo(po.px, po.py);
        else           ctx.lineTo(po.px, po.py);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  Plot history store
  // ---------------------------------------------------------------------------

  function makePlotHistory(windowS, rateHz) {
    const maxPts = Math.ceil(windowS * rateHz);
    return {
      torque:  [],
      omega:   [],
      current: [],   // first circuit current
      clear() { this.torque.length = 0; this.omega.length = 0; this.current.length = 0; },
      push(t, tau, omega, i0) {
        this.torque.push(  { t, y: tau    });
        this.omega.push(   { t, y: omega  });
        this.current.push( { t, y: i0     });
        if (this.torque.length  > maxPts) this.torque.shift();
        if (this.omega.length   > maxPts) this.omega.shift();
        if (this.current.length > maxPts) this.current.shift();
      },
    };
  }

  // ---------------------------------------------------------------------------
  //  UnifiedMotor.mount(host) → unmount
  // ---------------------------------------------------------------------------

  UM.mount = function mount(host) {
    // -----------------------------------------------------------------------
    //  1. Resolve config
    // -----------------------------------------------------------------------
    const config = UM.defaultConfig || makeDefaultConfig();

    // -----------------------------------------------------------------------
    //  2. Expand config + create runtime
    // -----------------------------------------------------------------------
    const expand = UM.ConfigSchema.expand.bind(UM.ConfigSchema);

    let expanded = expand(config);
    let runtime  = LIB.MotorRun.create(expanded);

    // -----------------------------------------------------------------------
    //  3. Build bespoke DOM interior
    // -----------------------------------------------------------------------

    // Root wrapper — fills the runTabs tab-host via the flex algorithm.
    const root = el("div", "um-mount", {
      display: "flex",
      flexDirection: "column",
      flex: "1 1 0",
      minHeight: "0",
      overflow: "hidden",
      background: "var(--bg)",
      color: "var(--ink)",
      fontFamily: "ui-sans-serif, system-ui, Segoe UI, Roboto, Helvetica, Arial",
      fontSize: "13px",
    });

    // --- Header strip -------------------------------------------------------
    const header = el("div", "um-header", {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "6px 12px",
      background: "var(--nav, #161a20)",
      flexShrink: "0",
    });

    const titleSpan = el("span", "", {
      fontWeight: "700",
      fontSize: "14px",
      marginRight: "8px",
    });
    titleSpan.textContent = config.label || "Unified Motor";

    const btnReset = el("button");
    btnReset.textContent = "Reset";
    btnReset.style.cssText = "padding:3px 10px;background:var(--panel2,#232932);color:var(--ink);border:1px solid var(--grid,#2a313c);border-radius:4px;cursor:pointer;";

    const btnPause = el("button");
    btnPause.textContent = "Pause";
    btnPause.style.cssText = "padding:3px 10px;background:var(--panel2,#232932);color:var(--ink);border:1px solid var(--grid,#2a313c);border-radius:4px;cursor:pointer;";

    // Header controls slot from HEADER_CONTROLS
    const headerCtrlSlot = el("div", "um-header-ctrl-slot", {
      display: "flex", alignItems: "center", gap: "6px",
    });

    header.append(titleSpan, btnReset, btnPause, headerCtrlSlot);

    // --- 3-zone upper region ------------------------------------------------
    const upperRegion = el("div", "um-upper", {
      display: "flex",
      flex: "1 1 0",
      overflow: "hidden",
      gap: "6px",
      padding: "6px",
      minHeight: "0",
    });

    // 3D viewport canvas (left, largest)
    const viewport3D = el("canvas", "um-viewport-3d", {
      flex: "2 2 0",
      minWidth: "0",
      background: "var(--panel,#1b1f25)",
      borderRadius: "4px",
    });

    // Cross-section views (two stacked vertically on the right of the viewport)
    const crossSectionCol = el("div", "um-cross-section-col", {
      display: "flex",
      flexDirection: "column",
      flex: "1 1 0",
      gap: "4px",
      minWidth: "0",
    });
    const canvas2DA = el("canvas", "um-cross-section-a", {
      flex: "1 1 0",
      width: "100%",
      background: "var(--panel,#1b1f25)",
      borderRadius: "4px",
    });
    const canvas2DB = el("canvas", "um-cross-section-b", {
      flex: "1 1 0",
      width: "100%",
      background: "var(--panel,#1b1f25)",
      borderRadius: "4px",
    });
    crossSectionCol.append(canvas2DA, canvas2DB);

    // Right shelf (sliders + registered shelf panels)
    const shelf = el("div", "um-shelf", {
      display: "flex",
      flexDirection: "column",
      flex: "0 0 220px",
      gap: "4px",
      overflowY: "auto",
      background: "var(--panel,#1b1f25)",
      borderRadius: "4px",
      padding: "8px",
    });

    upperRegion.append(viewport3D, crossSectionCol, shelf);

    // --- Bottom region (plots + readouts) -----------------------------------
    const bottomRegion = el("div", "um-bottom", {
      display: "flex",
      flexShrink: "0",
      height: "160px",
      gap: "6px",
      padding: "0 6px 6px",
      overflow: "hidden",
    });

    // Plot canvases
    const plotTorque  = el("canvas", "um-plot-torque",  { flex: "1 1 0", background: "var(--panel,#1b1f25)", borderRadius: "4px" });
    const plotOmega   = el("canvas", "um-plot-omega",   { flex: "1 1 0", background: "var(--panel,#1b1f25)", borderRadius: "4px" });
    const plotCurrent = el("canvas", "um-plot-current", { flex: "1 1 0", background: "var(--panel,#1b1f25)", borderRadius: "4px" });

    // Readout column
    const readoutCol = el("div", "um-readout-col", {
      flex: "0 0 140px",
      display: "flex",
      flexDirection: "column",
      gap: "2px",
      overflowY: "auto",
      background: "var(--panel,#1b1f25)",
      borderRadius: "4px",
      padding: "6px",
      fontSize: "12px",
    });

    bottomRegion.append(plotTorque, plotOmega, plotCurrent, readoutCol);

    root.append(header, upperRegion, bottomRegion);
    host.appendChild(root);

    // -----------------------------------------------------------------------
    //  4. Build shelf sliders
    // -----------------------------------------------------------------------

    const shelfLabel = el("div", "", { fontWeight: "600", marginBottom: "4px", fontSize: "12px", color: "var(--muted,#8a93a3)" });
    shelfLabel.textContent = "Drive / Load";
    shelf.appendChild(shelfLabel);

    const sliderDefs = [
      { key: "amp",       label: "I_amp (A)",  min: 0,    max: 50,  step: 0.1,  value: 5.0,  tip: "Terminal current amplitude" },
      { key: "freq",      label: "freq (Hz)",  min: 0,    max: 200, step: 0.5,  value: 0,    tip: "AC frequency (0 = DC)" },
      { key: "loadTorque",label: "τ_load (Nm)",min: 0,    max: 5,   step: 0.01, value: 0,    tip: "Load torque" },
      { key: "damping",   label: "damping",    min: 0.001, max: 0.2, step: 0.001, value: 0.05, log: true, tip: "Viscous damping coefficient" },
    ];

    // Drive/load application. `amp` and `freq` apply to ALL circuits (so a
    // polyphase machine stays balanced — the per-phase phaseOffsets in the config
    // are preserved), not just circuit 0. `drive` tracks the current values so
    // they can be re-applied after a geometry rebuild.
    const drive = {};
    function applyDrive(key, v) {
      drive[key] = v;
      if (key === "amp") {
        for (const c of runtime.circuits) c.terminal.amp = v;
      } else if (key === "freq") {
        for (const c of runtime.circuits) c.terminal.freq = v;
      } else if (key === "loadTorque") {
        runtime.mechanical.loadTorque = v;
      } else if (key === "damping") {
        runtime.mechanical.damping = v;
      }
    }
    function reapplyDrive() {
      for (const k in drive) applyDrive(k, drive[k]);
    }

    const sliderReg = buildSliders(shelf, sliderDefs, applyDrive);

    // Apply the slider defaults to the runtime at mount so the displayed controls
    // are the single source of truth for drive/load — otherwise the sim silently
    // ran the config's own amp/damping and the UI was a lie (and the config's
    // tiny damping left the rotor with no sane steady state).
    for (const d of sliderDefs) applyDrive(d.key, d.value);

    // -----------------------------------------------------------------------
    //  5. Orbit-camera tool state + smoothed magScale for gap-field viz
    // -----------------------------------------------------------------------
    let orbitYaw   = 0.4;
    let orbitPitch = 0.35;
    const ORBIT_DIST = 0.25;

    let orbitDrag = null;

    // Smoothed magScale for the 3D gap-field overlay.
    let smoothedMagScale = 1;

    // -----------------------------------------------------------------------
    //  8. requestRebuild — re-expands config and rebuilds runtime
    // -----------------------------------------------------------------------
    function requestRebuild() {
      expanded = expand(config);
      runtime  = LIB.MotorRun.create(expanded);
      reapplyDrive();
    }

    function buildCtx() {
      return {
        runtime: runtime,
        config:  config,
        view:    { yaw: orbitYaw, pitch: orbitPitch, dist: ORBIT_DIST },
        requestRebuild: requestRebuild,
      };
    }

    // Mount shelf panels from PANELS (zone: "shelf")
    const registeredShelfUnmounts = [];
    const ctx = buildCtx();

    for (const panel of UM.PANELS) {
      if (panel.zone === "shelf") {
        const panelHost = el("div", "um-panel-" + panel.id);
        shelf.appendChild(panelHost);
        const unmountFn = panel.build(panelHost, ctx);
        if (typeof unmountFn === "function") {
          registeredShelfUnmounts.push(unmountFn);
        }
      }
    }

    // Mount header controls from HEADER_CONTROLS
    const registeredHeaderUnmounts = [];
    for (const ctrl of UM.HEADER_CONTROLS) {
      const ctrlHost = el("div", "um-hctrl-" + ctrl.id);
      headerCtrlSlot.appendChild(ctrlHost);
      const result = ctrl.build(ctrlHost, ctx);
      if (typeof result === "function") {
        registeredHeaderUnmounts.push(result);
      } else if (result && typeof result.unmount === "function") {
        registeredHeaderUnmounts.push(result.unmount.bind(result));
      }
    }

    // -----------------------------------------------------------------------
    //  6. Plot history + timing
    // -----------------------------------------------------------------------
    const PHYS_DT   = 1 / 240;
    const HIST_HZ   = 60;
    const HIST_WIN  = 8;
    const history   = makePlotHistory(HIST_WIN, HIST_HZ);

    let acc = 0;
    let paused = false;
    let histAcc = 0;
    let rafId = null;
    let lastTime = null;

    // Physics steps per render frame. The full nonlinear air-gap solve runs on
    // EVERY step (full accuracy), so this is decoupled from wall-clock: the sim
    // plays in smooth slow-motion. 1 step/frame keeps the frame light (one solve)
    // for the highest frame rate; the rotor turns at ~frameRate × PHYS_DT realtime.
    const STEPS_PER_FRAME = 1;

    // -----------------------------------------------------------------------
    //  7. Readout builder
    // -----------------------------------------------------------------------
    function buildReadoutRow(label) {
      const row = el("div", "", { display: "flex", justifyContent: "space-between", gap: "4px" });
      const lbl = el("span", "", { color: "var(--muted,#8a93a3)" });
      lbl.textContent = label;
      const val = el("span", "", { fontVariantNumeric: "tabular-nums" });
      val.textContent = "—";
      row.append(lbl, val);
      readoutCol.appendChild(row);
      return val;
    }

    const rdTorque  = buildReadoutRow("τ (Nm)");
    const rdOmega   = buildReadoutRow("ω (rad/s)");
    const rdTheta   = buildReadoutRow("θ (rad)");

    // Per-circuit current readouts — built once, updated every frame
    const rdCurrents = [];
    for (let k = 0; k < expanded.nCircuits; k++) {
      rdCurrents.push(buildReadoutRow("i_" + k + " (A)"));
    }
    const rdFlux = [];
    for (let k = 0; k < expanded.nCircuits; k++) {
      rdFlux.push(buildReadoutRow("λ_" + k + " (Wb)"));
    }

    // -----------------------------------------------------------------------
    //  9. Reset handler
    // -----------------------------------------------------------------------
    btnReset.addEventListener("click", function () {
      runtime.reset();
      history.clear();
    });

    // -----------------------------------------------------------------------
    //  10. Pause handler
    // -----------------------------------------------------------------------
    btnPause.addEventListener("click", function () {
      paused = !paused;
      btnPause.textContent = paused ? "Resume" : "Pause";
    });

    // -----------------------------------------------------------------------
    //  11. Pointer handlers on viewport3D (orbit-camera + TOOLS mux)
    // -----------------------------------------------------------------------

    function onPointerDown(ev) {
      ev.preventDefault();
      viewport3D.setPointerCapture(ev.pointerId);
      // Built-in orbit-camera tool
      orbitDrag = { x: ev.clientX, y: ev.clientY, yaw0: orbitYaw, pitch0: orbitPitch };

      // Mux TOOLS in registration order
      const mx = ev.offsetX, my = ev.offsetY;
      for (const tool of UM.TOOLS) {
        if (tool.onPointer("down", mx, my, ctx.view, buildCtx())) return;
      }
    }

    function onPointerMove(ev) {
      const mx = ev.offsetX, my = ev.offsetY;

      // Mux TOOLS first
      if (orbitDrag === null) {
        for (const tool of UM.TOOLS) {
          if (tool.onPointer("move", mx, my, ctx.view, buildCtx())) return;
        }
      }

      if (orbitDrag) {
        const dx = (ev.clientX - orbitDrag.x) / viewport3D.clientWidth;
        const dy = (ev.clientY - orbitDrag.y) / viewport3D.clientHeight;
        orbitYaw   = orbitDrag.yaw0   + dx * Math.PI * 2;
        orbitPitch = Math.max(-1.4, Math.min(1.4,
          orbitDrag.pitch0 - dy * Math.PI));
      }
    }

    function onPointerUp(ev) {
      const mx = ev.offsetX, my = ev.offsetY;
      for (const tool of UM.TOOLS) {
        if (tool.onPointer("up", mx, my, ctx.view, buildCtx())) break;
      }
      orbitDrag = null;
    }

    function onPointerLeave(ev) {
      for (const tool of UM.TOOLS) {
        tool.onPointer("leave", ev.offsetX, ev.offsetY, ctx.view, buildCtx());
      }
      orbitDrag = null;
    }

    viewport3D.addEventListener("pointerdown",  onPointerDown);
    viewport3D.addEventListener("pointermove",  onPointerMove);
    viewport3D.addEventListener("pointerup",    onPointerUp);
    viewport3D.addEventListener("pointerleave", onPointerLeave);
    viewport3D.addEventListener("pointercancel",onPointerLeave);

    // -----------------------------------------------------------------------
    //  12. Main rAF + accumulator loop
    // -----------------------------------------------------------------------

    function drawPlot(canvas, history, title, color, yFmt) {
      const { W, H } = fitCanvas(canvas);
      if (W <= 0 || H <= 0) return;
      const ctx2 = canvas.getContext("2d");
      const pts = history;
      if (!pts || pts.length === 0) {
        LIB.Plot.drawGrid(ctx2, 0, 0, W, H, -1, 1, 0, HIST_WIN, title, 11);
        return;
      }
      const tNow  = pts[pts.length - 1].t;
      const tMin  = tNow - HIST_WIN;
      const ys    = pts.map(p => p.y).filter(Number.isFinite);
      let yMin = ys.length ? Math.min(...ys) : -1;
      let yMax = ys.length ? Math.max(...ys) :  1;
      if (yMax - yMin < 1e-9) { yMin -= 0.5; yMax += 0.5; }
      const pad  = (yMax - yMin) * 0.1 || 0.1;
      yMin -= pad; yMax += pad;
      LIB.Plot.drawGrid(ctx2, 0, 0, W, H, yMin, yMax, tMin, tNow, title, 11, { yFmt });
      LIB.Plot.drawLine(ctx2, 0, 0, W, H, yMin, yMax, tMin, tNow, pts, color, 2);
    }

    // Draw machine geometry + gap-field overlay on a 2D cross-section canvas.
    // features: the expanded slice feature list.
    // field:    { Br, Bt } from lastSolve.perSliceField[k] (may be null before first solve).
    // grid:     sliceGrid from runtime.stack.sliceGrid(k).
    // thetaR:   live rotor angle.
    // currents: state.i Float64Array.
    // label:    canvas label string.
    function drawCrossSection(canvas, features, field, grid, thetaR, currents, label) {
      const { W, H } = fitCanvas(canvas);
      if (W <= 0 || H <= 0) return;
      const ctx2 = canvas.getContext("2d");
      ctx2.clearRect(0, 0, W, H);
      ctx2.fillStyle = "#0d1013";
      ctx2.fillRect(0, 0, W, H);

      // Always need grid to establish scale.  Without it show a placeholder.
      if (!grid) {
        ctx2.fillStyle = "var(--muted,#8a93a3)";
        ctx2.font = "11px ui-sans-serif";
        ctx2.textAlign = "center";
        ctx2.textBaseline = "middle";
        ctx2.fillText(label || "cross-section", W / 2, H / 2);
        return;
      }

      // Direct 2D flat mapping: world x → canvas, world y → canvas (y flipped).
      const pad   = 10;
      const R     = grid.rOuter;
      const scale = Math.min((W - 2 * pad) / (2 * R), (H - 2 * pad) / (2 * R));
      const cx    = W / 2;
      const cy    = H / 2;

      // Draw structural geometry (iron / conductor / magnet) as filled sectors.
      if (features && features.length > 0) {
        drawFeatureSectors2D(ctx2, features, cx, cy, scale, thetaR, currents);
      }

      // Overlay gap-field heatmap as a translucent layer (drawn only when field available).
      if (field) {
        const Nr     = grid.Nr;
        const Ntheta = grid.Ntheta;
        const r      = grid.r;
        const rInner = grid.rInner;
        const rOuter = grid.rOuter;
        const Br     = field.Br;
        const Bt     = field.Bt;
        const dTheta = 2 * Math.PI / Ntheta;

        // Smoothed magScale per canvas.
        let maxB = 0;
        for (let k = 0; k < Nr * Ntheta; k++) {
          const bMag = Math.sqrt(Br[k] * Br[k] + Bt[k] * Bt[k]);
          if (bMag > maxB) maxB = bMag;
        }
        if (!canvas._magScale || canvas._magScale < maxB) {
          canvas._magScale = maxB > 0 ? maxB : 1;
        } else {
          canvas._magScale = canvas._magScale * 0.98 + maxB * 0.02;
        }
        const magScale = canvas._magScale > 0 ? canvas._magScale : 1;

        // Radial cell boundaries.
        const rLo = new Float64Array(Nr);
        const rHi = new Float64Array(Nr);
        for (let i = 0; i < Nr; i++) {
          rLo[i] = (i === 0)      ? rInner : 0.5 * (r[i - 1] + r[i]);
          rHi[i] = (i === Nr - 1) ? rOuter : 0.5 * (r[i] + r[i + 1]);
        }

        // Draw field heatmap cells with reduced alpha so geometry shows through.
        ctx2.save();
        ctx2.globalAlpha = 0.55;
        for (let i = 0; i < Nr; i++) {
          const r0 = rLo[i] * scale;
          const r1 = rHi[i] * scale;
          for (let j = 0; j < Ntheta; j++) {
            const idx  = i * Ntheta + j;
            const bMag = Math.sqrt(Br[idx] * Br[idx] + Bt[idx] * Bt[idx]);
            const t    = Math.max(0, Math.min(1, bMag / magScale));
            const thLo = j * dTheta;
            const thHi = (j + 1) * dTheta;
            ctx2.fillStyle = LIB.Util.lerpColor("#0d1013", "#ffd54a", t);
            ctx2.beginPath();
            ctx2.moveTo(cx + r0 * Math.cos(thLo), cy - r0 * Math.sin(thLo));
            ctx2.lineTo(cx + r1 * Math.cos(thLo), cy - r1 * Math.sin(thLo));
            ctx2.lineTo(cx + r1 * Math.cos(thHi), cy - r1 * Math.sin(thHi));
            ctx2.lineTo(cx + r0 * Math.cos(thHi), cy - r0 * Math.sin(thHi));
            ctx2.closePath();
            ctx2.fill();
          }
        }
        ctx2.restore();
      }

      // Ring outlines: stator bore (rOuter) and rotor outer (grid.rInner = gap inner).
      ctx2.save();
      ctx2.strokeStyle = "rgba(180,200,220,0.5)";
      ctx2.lineWidth = 1.2;
      ctx2.beginPath();
      ctx2.arc(cx, cy, grid.rOuter * scale, 0, Math.PI * 2);
      ctx2.stroke();
      ctx2.beginPath();
      ctx2.arc(cx, cy, grid.rInner * scale, 0, Math.PI * 2);
      ctx2.stroke();
      ctx2.restore();

      // Rotor angle marker.
      const markerR = grid.rInner * scale * 0.75;
      ctx2.save();
      ctx2.strokeStyle = "#ffd54a";
      ctx2.lineWidth = 1.5;
      ctx2.beginPath();
      ctx2.moveTo(cx, cy);
      ctx2.lineTo(cx + markerR * Math.cos(thetaR), cy - markerR * Math.sin(thetaR));
      ctx2.stroke();
      ctx2.restore();

      // Label
      ctx2.fillStyle = "rgba(138,147,163,0.8)";
      ctx2.font = "10px ui-sans-serif";
      ctx2.textAlign = "left";
      ctx2.textBaseline = "top";
      ctx2.fillText(label || "cross-section", 4, 4);
    }

    function frame(now) {
      rafId = requestAnimationFrame(frame);

      if (lastTime === null) lastTime = now;
      const dtFrame = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      // Physics — solve-every-step (full Ntheta=256 + saturation, bit-accurate),
      // a FIXED small number of steps per render frame, decoupled from wall-clock.
      // The full nonlinear air-gap solve (~tens of ms) cannot run realtime at this
      // resolution without sacrificing accuracy (every cheap torque shortcut —
      // coarsening, held-torque, co-energy — costs 10–40% accuracy), so the sim
      // plays in smooth slow-motion (~0.1× realtime) instead of choppily at
      // realtime. Field, torque and dynamics are exact on every step.
      if (!paused) {
        for (let s = 0; s < STEPS_PER_FRAME; s++) {
          runtime.step(PHYS_DT);
        }
        // Plot history — one sample per frame, on the sim-time axis.
        const st  = runtime.state;
        const tau = runtime.lastSolve ? runtime.lastSolve.torque : 0;
        const i0  = st.i.length > 0 ? st.i[0] : 0;
        history.push(st.t, tau, st.omega, i0);
      }

      // Render 3D viewport
      const { W: W3, H: H3 } = fitCanvas(viewport3D);
      if (W3 > 0 && H3 > 0) {
        const ctx3 = viewport3D.getContext("2d");
        ctx3.clearRect(0, 0, W3, H3);
        ctx3.fillStyle = "#0d1013";
        ctx3.fillRect(0, 0, W3, H3);

        const L3 = LIB.Layout3D.orbital(W3, H3, {
          yaw:   orbitYaw,
          pitch: orbitPitch,
          dist:  ORBIT_DIST,
          fov:   Math.PI / 4,
        });

        const rctx = { runtime: runtime, config: config, expanded: expanded, W: W3, H: H3 };
        const mountCtx = buildCtx();

        if (UM.RENDER3D) {
          // Phase 9 or registered renderer takes over the entire viewport draw.
          UM.RENDER3D.paint(mountCtx, L3, rctx);
        } else {
          // Built-in rig: machine structural geometry + gap-field heatmap overlay.
          const st     = runtime.state;
          const solved = runtime.lastSolve;
          const rOuter = expanded.grid.rOuter;
          const rInner = expanded.grid.rInner;

          // Update smoothed magScale from the latest field data.
          if (solved) {
            let maxB = 0;
            for (let k = 0; k < expanded.slices.length; k++) {
              const sf = solved.perSliceField[k];
              if (!sf) continue;
              const Br = sf.Br, Bt = sf.Bt;
              for (let n = 0; n < Br.length; n++) {
                const bm = Math.sqrt(Br[n] * Br[n] + Bt[n] * Bt[n]);
                if (bm > maxB) maxB = bm;
              }
            }
            if (maxB > smoothedMagScale) {
              smoothedMagScale = maxB;
            } else {
              smoothedMagScale = smoothedMagScale * 0.98 + maxB * 0.02;
            }
            if (smoothedMagScale < 1e-9) smoothedMagScale = 1e-9;
          }

          // Draw machine geometry (filled structural regions) for each slice —
          // done before the field heatmap overlay so geometry is clearly visible.
          for (let k = 0; k < expanded.slices.length; k++) {
            const planeZ   = expanded.slices[k].offset || 0;
            const features = expanded.slices[k].section.features;
            drawFeatureSectors3D(ctx3, L3, features, planeZ, st.theta, st.i);
          }

          // Stator bore outline (rOuter ring) in each slice plane.
          for (let k = 0; k < expanded.slices.length; k++) {
            const planeZ = expanded.slices[k].offset || 0;
            drawRing3D(ctx3, L3, rOuter, planeZ, "rgba(180,200,220,0.5)", 1.5, 64);
          }

          // Rotor outer surface (rInner ring) in each slice plane.
          for (let k = 0; k < expanded.slices.length; k++) {
            const planeZ = expanded.slices[k].offset || 0;
            drawRing3D(ctx3, L3, rInner, planeZ, "rgba(255,213,74,0.4)", 1.2, 48);
          }

          // Slot conductor lines for wound rings (W/C/K) as a wireframe overlay.
          const i0 = runtime.state.i.length > 0 ? runtime.state.i[0] : 0;
          for (const ring of config.rings) {
            if (ring.element !== "W" && ring.element !== "C" && ring.element !== "K") continue;
            for (let k = 0; k < expanded.slices.length; k++) {
              const planeZ = expanded.slices[k].offset || 0;
              drawSlotConductors3D(ctx3, L3, ring, st.theta, planeZ, i0, "#4ea1ff");
            }
          }

          // Rotor angle indicator: a line from centre along the rotor angle.
          const markerLen = rInner * 0.85;
          const originW = { x: 0, y: 0, z: 0 };
          const tipW    = {
            x: markerLen * Math.cos(st.theta),
            y: markerLen * Math.sin(st.theta),
            z: 0,
          };
          const op = L3.project(originW);
          const tp = L3.project(tipW);
          if (!op.behind && !tp.behind) {
            ctx3.strokeStyle = "#ffd54a";
            ctx3.lineWidth   = 2;
            ctx3.lineCap     = "round";
            ctx3.beginPath();
            ctx3.moveTo(op.px, op.py);
            ctx3.lineTo(tp.px, tp.py);
            ctx3.stroke();
          }

          // Placeholder ring if no solve yet.
          if (!solved) {
            drawRing3D(ctx3, L3, (rInner + rOuter) * 0.5, 0, "rgba(138,147,163,0.5)", 1.5, 48);
          }
        }
      }

      // Cross-section views — both always render slice 0 geometry + field.
      // For multi-slice configs, canvas B shows slice 1; for single-slice it
      // shows the same geometry from a different perspective (field + theta marker).
      const solved    = runtime.lastSolve;
      const thetaRCS  = runtime.state.theta;
      const currents  = runtime.state.i;

      // Slice 0 — both canvases always have a valid grid + features.
      const sliceGrid0  = expanded.slices.length > 0 ? runtime.stack.sliceGrid(0) : null;
      const features0   = expanded.slices.length > 0 ? expanded.slices[0].section.features : null;
      const field0      = solved && solved.perSliceField.length > 0 ? solved.perSliceField[0] : null;

      drawCrossSection(canvas2DA, features0, field0, sliceGrid0, thetaRCS, currents,
        "slice 0 — geometry + field");

      // Canvas B: slice 1 if multi-slice, else slice 0 again (distinct label).
      const hasSlice1  = expanded.slices.length > 1;
      const sliceGrid1 = hasSlice1 ? runtime.stack.sliceGrid(1) : sliceGrid0;
      const features1  = hasSlice1 ? expanded.slices[1].section.features : features0;
      const field1     = hasSlice1
        ? (solved && solved.perSliceField.length > 1 ? solved.perSliceField[1] : null)
        : field0;

      drawCrossSection(canvas2DB, features1, field1, sliceGrid1, thetaRCS, currents,
        hasSlice1 ? "slice 1 — geometry + field" : "slice 0 — rotor angle θ");

      // Plots
      drawPlot(plotTorque,  history.torque,  "τ (Nm)",    "#ffd54a", v => v.toFixed(4));
      drawPlot(plotOmega,   history.omega,   "ω (rad/s)", "#4ea1ff", v => v.toFixed(2));
      drawPlot(plotCurrent, history.current, "i_0 (A)",   "#66bb6a", v => v.toFixed(3));

      // Readouts
      const st = runtime.state;
      const tau = solved ? solved.torque : 0;
      rdTorque.textContent = Number.isFinite(tau)      ? tau.toExponential(3)       : "—";
      rdOmega.textContent  = Number.isFinite(st.omega) ? st.omega.toFixed(3)        : "—";
      rdTheta.textContent  = Number.isFinite(st.theta) ? st.theta.toFixed(3)        : "—";

      for (let k = 0; k < rdCurrents.length; k++) {
        const ik = st.i[k];
        rdCurrents[k].textContent = Number.isFinite(ik) ? ik.toFixed(4) : "—";
      }
      if (solved) {
        for (let k = 0; k < rdFlux.length; k++) {
          const lk = solved.fluxLinkages[k];
          rdFlux[k].textContent = Number.isFinite(lk) ? lk.toExponential(3) : "—";
        }
      }
    }

    // Start the loop
    rafId = requestAnimationFrame(frame);

    // -----------------------------------------------------------------------
    //  13. unmount
    // -----------------------------------------------------------------------
    function unmount() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      viewport3D.removeEventListener("pointerdown",   onPointerDown);
      viewport3D.removeEventListener("pointermove",   onPointerMove);
      viewport3D.removeEventListener("pointerup",     onPointerUp);
      viewport3D.removeEventListener("pointerleave",  onPointerLeave);
      viewport3D.removeEventListener("pointercancel", onPointerLeave);

      for (const fn of registeredShelfUnmounts)  fn();
      for (const fn of registeredHeaderUnmounts) fn();

      host.removeChild(root);
    }

    return unmount;
  };

})();
