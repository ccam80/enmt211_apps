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
  // ---------------------------------------------------------------------------

  function makeDefaultConfig() {
    return {
      label: "Default wound machine",
      grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
      gapBand: { iInner: 4, iOuter: 8 },
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
      mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
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

    // Root wrapper
    const root = el("div", "um-mount", {
      display: "flex",
      flexDirection: "column",
      height: "100%",
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
      { key: "damping",   label: "damping",    min: 0,    max: 0.1, step: 1e-5, value: 1e-5, log: true, tip: "Viscous damping coefficient" },
    ];

    const sliderReg = buildSliders(shelf, sliderDefs, function (key, v) {
      if (key === "amp" && runtime.circuits.length > 0) {
        runtime.circuits[0].terminal.amp = v;
      } else if (key === "freq" && runtime.circuits.length > 0) {
        runtime.circuits[0].terminal.freq = v;
      } else if (key === "loadTorque") {
        runtime.mechanical.loadTorque = v;
      } else if (key === "damping") {
        runtime.mechanical.damping = v;
      }
    });

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
    //  5. Orbit-camera tool state
    // -----------------------------------------------------------------------
    let orbitYaw   = 0.4;
    let orbitPitch = 0.35;
    const ORBIT_DIST = 0.25;

    let orbitDrag = null;

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
    //  8. requestRebuild — re-expands config and rebuilds runtime
    // -----------------------------------------------------------------------
    function requestRebuild() {
      expanded = expand(config);
      runtime  = LIB.MotorRun.create(expanded);
    }

    function buildCtx() {
      return {
        runtime: runtime,
        config:  config,
        view:    { yaw: orbitYaw, pitch: orbitPitch, dist: ORBIT_DIST },
        requestRebuild: requestRebuild,
      };
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

    function drawCrossSection(canvas, field, grid, label) {
      const { W, H } = fitCanvas(canvas);
      if (W <= 0 || H <= 0) return;
      const ctx2 = canvas.getContext("2d");
      ctx2.clearRect(0, 0, W, H);

      if (!field || !grid) {
        ctx2.fillStyle = "var(--muted,#8a93a3)";
        ctx2.font = "11px ui-sans-serif";
        ctx2.textAlign = "center";
        ctx2.textBaseline = "middle";
        ctx2.fillText(label || "cross-section", W / 2, H / 2);
        return;
      }

      // Build a flat 2D layout centred in the canvas for the gap-field paint.
      const R  = grid.rOuter;
      const pad = 8;
      const scale = Math.min((W - 2 * pad) / (2 * R), (H - 2 * pad) / (2 * R));
      // Use an identity-like L3 that maps world XY to canvas pixels:
      // x_px = originX + x_world * scale,  y_px = originY - y_world * scale
      // We wrap this in an LIB.Layout3D.orbital call centred flat (pitch=0).
      // For a top-down 2D view: yaw=0, pitch=π/2 (looking down the Z axis).
      const L3 = LIB.Layout3D.orbital(W, H, {
        yaw: 0, pitch: Math.PI / 2,
        dist: R * 2.4,
        fov:  Math.PI / 4,
        originX: W / 2,
        originY: H / 2,
      });

      const geom = {
        Nr:     grid.Nr,
        Ntheta: grid.Ntheta,
        r:      grid.r,
        rInner: grid.rInner,
        rOuter: grid.rOuter,
        planeZ: 0,
      };

      LIB.FieldRender.drawGapField(ctx2, L3, field, geom, {
        alpha: 0.9,
        vectors: false,
        magScale: null,
      });

      // Label
      ctx2.fillStyle = "var(--muted,#8a93a3)";
      ctx2.font = "10px ui-sans-serif";
      ctx2.textAlign = "left";
      ctx2.textBaseline = "top";
      ctx2.fillText(label || "gap field", 4, 4);
    }

    function frame(now) {
      rafId = requestAnimationFrame(frame);

      if (lastTime === null) lastTime = now;
      const dtFrame = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      // Physics accumulator
      if (!paused) {
        acc += dtFrame;
        while (acc >= PHYS_DT) {
          runtime.step(PHYS_DT);
          acc -= PHYS_DT;
        }

        // Plot history at HIST_HZ
        histAcc += dtFrame;
        const histDt = 1 / HIST_HZ;
        if (histAcc >= histDt) {
          histAcc -= histDt;
          const st  = runtime.state;
          const tau = runtime.lastSolve ? runtime.lastSolve.torque : 0;
          const i0  = st.i.length > 0 ? st.i[0] : 0;
          history.push(st.t, tau, st.omega, i0);
        }
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
          // Built-in: draw gap-field heatmap for each slice on the 3D projection.
          const solved = runtime.lastSolve;
          if (solved) {
            for (let k = 0; k < expanded.slices.length; k++) {
              const sliceField = solved.perSliceField[k];
              if (!sliceField) continue;
              const grid = runtime.stack.sliceGrid(k);
              const geom = {
                Nr:     grid.Nr,
                Ntheta: grid.Ntheta,
                r:      grid.r,
                rInner: grid.rInner,
                rOuter: grid.rOuter,
                planeZ: k * 0.05,
              };
              LIB.FieldRender.drawGapField(ctx3, L3, sliceField, geom, {
                alpha:   0.85,
                vectors: true,
                magScale: null,
              });
            }
          } else {
            // No solve yet — draw a placeholder ring
            ctx3.strokeStyle = "var(--muted,#8a93a3)";
            ctx3.lineWidth = 1;
            ctx3.beginPath();
            ctx3.arc(W3 / 2, H3 / 2, Math.min(W3, H3) * 0.3, 0, Math.PI * 2);
            ctx3.stroke();
          }

          // Rotor angle indicator
          const st = runtime.state;
          const R  = expanded.grid.rOuter;
          const originWorld = { x: 0, y: 0, z: 0 };
          const tipWorld    = {
            x: R * Math.cos(st.theta),
            y: R * Math.sin(st.theta),
            z: 0,
          };
          const o = L3.project(originWorld);
          const t = L3.project(tipWorld);
          if (!o.behind && !t.behind) {
            ctx3.strokeStyle = "#ffd54a";
            ctx3.lineWidth = 2;
            ctx3.beginPath();
            ctx3.moveTo(o.px, o.py);
            ctx3.lineTo(t.px, t.py);
            ctx3.stroke();
          }
        }
      }

      // Cross-section views
      const solved = runtime.lastSolve;
      const sliceGrid0 = expanded.slices.length > 0 ? runtime.stack.sliceGrid(0) : null;
      const field0     = solved && solved.perSliceField.length > 0 ? solved.perSliceField[0] : null;
      drawCrossSection(canvas2DA, field0, sliceGrid0, "slice 0 — gap field");

      const sliceGrid1 = expanded.slices.length > 1 ? runtime.stack.sliceGrid(1) : null;
      const field1     = solved && solved.perSliceField.length > 1 ? solved.perSliceField[1] : null;
      drawCrossSection(canvas2DB, field1, sliceGrid1, expanded.slices.length > 1 ? "slice 1 — gap field" : "rotor angle");

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
