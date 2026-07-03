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
  if (UM.CROSS_SECTION_2D === undefined)  UM.CROSS_SECTION_2D = null;

  // Field-viz overlay state, shared by the 2-D and 3-D renderers (D3). Six
  // independent toggles; flux-lines on by default, everything else opt-in.
  if (!UM.fieldViz) UM.fieldViz = {
    fluxLines: true,
    modulusB: false,
    saturation: false,
    magnetization: false,
    currentDensity: false,
    gapLoop: false,
    currentDots: false,
  };

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

  UM.registerCrossSection2D = function (entry) {
    UM.CROSS_SECTION_2D = entry;
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
      motion: { inner: "rotating", outer: "static" },
      rings: [
        { member: "outer", components: [
          { kind: "iron", rRange: [0.052, 0.06], muR: 1000, alpha: 1 },
          { kind: "distributed-winding", rRange: [0.052, 0.06],
            winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } }, muR: 1000, alpha: 1 },
        ] },
        { member: "inner", components: [
          { kind: "iron", rRange: [0.04, 0.048], teeth: 2, muR: 1000, alpha: 1 },
        ] },
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
  //  makeSimSource(deps) — construct the SimSource backing the runtime.
  //
  //  Prefers a Web Worker (solver off the render thread) when opted in
  //  (UM.USE_SIM_WORKER) and a Worker + a same-origin worker URL are available
  //  and the page is not on file:// (workers can't load there). Otherwise, and
  //  automatically on any worker failure, runs in-process. Every node test
  //  drives the in-process path (no Worker global, no location).
  // ---------------------------------------------------------------------------
  function makeSimSource(deps) {
    const canWorker =
      typeof Worker !== "undefined" &&
      typeof UM.SIM_WORKER_URL === "string" &&
      typeof location !== "undefined" && location.protocol !== "file:";
    if (UM.USE_SIM_WORKER && canWorker) {
      try {
        return LIB.SimSource.createWorker({ url: UM.SIM_WORKER_URL, fallbackDeps: deps });
      } catch (e) { /* construction failed → in-process below */ }
    }
    return LIB.SimSource.createInline(deps);
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
    //  2. Expand config + wire the sim source (off-thread-capable)
    // -----------------------------------------------------------------------
    // The numeric runtime lives behind a SimSource (in-process here; a Web
    // Worker in the browser) so an atomic 20-50 ms solve never hitches the
    // render thread. `expanded` stays main-side — renderers and readouts read it
    // — and is the pure expand(config) the source also computes, so both sides
    // agree by construction (WORKER-SPEC §4). The source streams SNAPSHOTS; the
    // render loop interpolates them at a smooth `simClock` (WORKER-SPEC §7).
    const expand = UM.ConfigSchema.expand.bind(UM.ConfigSchema);

    let expanded = expand(config);

    const Snap = LIB.Snapshot;
    const buffer = new Snap.Buffer();
    const source = makeSimSource({ MotorRun: LIB.MotorRun, expand: expand });

    let geom = null;          // latest static geometry (meshes + counts) per epoch
    let curEpoch = -1;        // epoch of `geom`/`dispRuntime`; snapshots gate on it
    let dispRuntime = null;   // display proxy the renderers read (stable per epoch)
    let dispReady = false;    // a snapshot has been interpolated into dispRuntime
    let simClock = 0;         // smooth render clock (sim-seconds)
    let behind = false;       // solver can't sustain the ordered rate (badge)

    // Build the display-runtime proxy for an epoch's geometry. Stable object
    // identity across frames (the current-dot animator keys on it); its nested
    // arrays are written in place each frame by Snap.writeInterp. sliceMesh and
    // each per-slice field's `.mesh` reference the cached static meshes — the
    // renderers read exactly the shape a real runtime exposes.
    function buildDispRuntime(g) {
      const perSlice = new Array(g.nSlices);
      for (let k = 0; k < g.nSlices; k++) {
        perSlice[k] = {
          gap: { phi: 0 },
          rotor:  { mesh: g.slices[k].rotor,  Anode: null, Belem: { mag: null, Bx: null, By: null } },
          stator: { mesh: g.slices[k].stator, Anode: null, Belem: { mag: null, Bx: null, By: null } },
        };
      }
      return {
        stack: { sliceMesh: function (k) { return g.slices[k]; } },
        state: { theta: 0, omega: 0, t: 0, i: new Float64Array(g.nCircuits) },
        lastSolve: { torque: 0, fluxLinkages: new Float64Array(g.nCircuits), perSliceField: perSlice },
      };
    }

    // Geometry (once per epoch): swap the cached meshes + display proxy, clear
    // the snapshot buffer, reseed the render clock, and rebuild per-circuit
    // readouts if the circuit count changed. `expanded` is refreshed to the same
    // epoch's config before any rebuild posts, so rebuildReadouts sees it.
    source.onGeometry(function (g) {
      curEpoch = g.epoch;
      geom = g;
      dispRuntime = buildDispRuntime(g);
      dispReady = false;      // don't render the proxy until a snapshot fills it
      buffer.clear();
      simClock = 0;
      behind = false;
      if (rdCurrents.length !== g.nCircuits) rebuildReadouts();
    });

    // Snapshots stream in; keep only those for the live epoch (in-flight
    // snapshots from before a rebuild are dropped — WORKER-SPEC §9).
    source.onSnapshot(function (s) {
      if (s.epoch === curEpoch) buffer.push(s);
    });

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

    // Slow-motion warning — shown when the wall-time budget caps the per-frame
    // solve below the ordered sim-step (the sim is playing slower than ordered).
    const warnBadge = el("span", "um-slow-badge", {
      fontSize: "11px", fontWeight: "600", color: "#ffb454",
      padding: "2px 6px", borderRadius: "4px",
      background: "rgba(255,180,84,0.12)", border: "1px solid rgba(255,180,84,0.4)",
      display: "none", whiteSpace: "nowrap",
    });

    // Per-frame timing split: solve (the pace command's in-process cost — ≈0
    // once the sim runs in a Worker) vs render (3-D + 2-D + plots). Pause stops
    // the solve but keeps rendering, so pausing isolates render cost.
    const perfBadge = el("span", "um-perf-badge", {
      fontSize: "11px", fontFamily: "ui-monospace, monospace", color: "#8a93a3",
      padding: "2px 6px", whiteSpace: "nowrap", marginLeft: "auto",
    });

    // Header controls slot from HEADER_CONTROLS
    const headerCtrlSlot = el("div", "um-header-ctrl-slot", {
      display: "flex", alignItems: "center", gap: "6px",
    });

    header.append(titleSpan, btnReset, btnPause, warnBadge, perfBadge, headerCtrlSlot);

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
    // display:block + minWidth/minHeight:0 so fitCanvas's bitmap size cannot
    // feed back into the flex item's min-content size (these stack in a column,
    // so height is the main axis — without minHeight:0 the canvas grows tall
    // without bound and the cross-section is scaled into a giant clipped canvas).
    const canvas2DStyle = function () {
      return { flex: "1 1 0", display: "block", width: "100%", minWidth: "0", minHeight: "0",
               background: "var(--panel,#1b1f25)", borderRadius: "4px" };
    };
    const canvas2DA = el("canvas", "um-cross-section-a", canvas2DStyle());
    const canvas2DB = el("canvas", "um-cross-section-b", canvas2DStyle());
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

    // Plot canvases. display:block + minWidth/minHeight:0 let each flex item
    // shrink below the canvas's intrinsic (bitmap-attribute) size — without it
    // fitCanvas's `canvas.width = clientWidth*dpr` feeds back into the item's
    // min-content width and the plots grow without bound every frame.
    const plotStyle = function () {
      return { flex: "1 1 0", display: "block", minWidth: "0", minHeight: "0",
               background: "var(--panel,#1b1f25)", borderRadius: "4px" };
    };
    const plotTorque  = el("canvas", "um-plot-torque",  plotStyle());
    const plotOmega   = el("canvas", "um-plot-omega",   plotStyle());
    const plotCurrent = el("canvas", "um-plot-current", plotStyle());

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
        source.post({ type: "drive", amp: v });
      } else if (key === "freq") {
        source.post({ type: "drive", freq: v });
      } else if (key === "loadTorque") {
        source.post({ type: "mechanical", loadTorque: v });
      } else if (key === "damping") {
        source.post({ type: "mechanical", damping: v });
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

    // Pacing (WORKER-SPEC §8). Each frame the source is told to free-run the
    // solver up to simClock + LEAD_FRAMES worth of per-frame advance, so a
    // bracket ahead of the render clock always exists (covers Worker latency).
    // If the clock outruns the newest solve by more than MAX_LAG_FRAMES the
    // solver can't keep up: drop the backlog (render at latest, pull the clock
    // back) and flag `behind`. Both are expressed as multiples of a nominal
    // frame's sim-advance (speed / 60) so they scale with the ordered speed.
    const LEAD_FRAMES = 3;
    const MAX_LAG_FRAMES = 30;

    // Playback control — the ordered rate as a fraction of real time (sim-seconds
    // per real-second). This is the CEILING; the frame loop drops below it
    // (smoothly) when a machine can't solve fast enough. Never faster than real
    // time. Free-text for an arbitrary fraction, plus /1 /10 /100 /1000 presets.
    let speed = 0.1;   // sim-s per real-s, in (0, 1]
    const playbackLabel = el("div", "", { fontWeight: "600", margin: "8px 0 4px", fontSize: "12px", color: "var(--muted,#8a93a3)" });
    playbackLabel.textContent = "Playback (× real time)";
    shelf.appendChild(playbackLabel);
    const speedRow = el("div", "", { display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", margin: "0 0 8px" });
    const speedInput = document.createElement("input");
    speedInput.type = "text";
    speedInput.style.cssText = "width:4.5em;font-variant-numeric:tabular-nums;";
    const speedSuffix = el("span", "", { color: "var(--muted,#8a93a3)", fontSize: "0.82em", marginRight: "4px" });
    speedSuffix.textContent = "×";
    function syncSpeedInput() { speedInput.value = String(+speed.toPrecision(4)); }
    function setSpeed(v) {
      if (!Number.isFinite(v) || v <= 0) { syncSpeedInput(); return; }
      speed = Math.min(1, v);   // never faster than real time
      syncSpeedInput();
    }
    speedInput.addEventListener("change", function () { setSpeed(parseFloat(speedInput.value)); });
    speedRow.appendChild(speedInput);
    speedRow.appendChild(speedSuffix);
    for (const denom of [1, 10, 100, 1000]) {
      const b = document.createElement("button");
      b.textContent = "/" + denom;
      b.style.cssText = "font-size:0.78em;padding:1px 5px;cursor:pointer;";
      b.title = "Set playback to 1/" + denom + " of real time";
      b.addEventListener("click", function () { setSpeed(1 / denom); });
      speedRow.appendChild(b);
    }
    shelf.appendChild(speedRow);
    syncSpeedInput();

    // -----------------------------------------------------------------------
    //  5. Orbit-camera tool state
    // -----------------------------------------------------------------------
    let orbitYaw   = 0.4;
    let orbitPitch = 0.35;
    const ORBIT_DIST = 0.25;

    let orbitDrag = null;

    // -----------------------------------------------------------------------
    //  8. Rebuild paths
    //
    //  Panels whose DOM depends on config STRUCTURE register a refresh here. A
    //  structural rebuild runs them only when asked (loading a different
    //  machine) — in-panel edits manage their own DOM via their own refresh
    //  flag, so a slider drag never tears down the panel it lives in.
    // -----------------------------------------------------------------------
    const normalizers = [];   // mutate config into canonical form BEFORE expand
    const refreshers  = [];    // rebuild config-dependent DOM AFTER expand
    function registerNormalize(fn) {
      normalizers.push(fn);
      return function () { const i = normalizers.indexOf(fn); if (i >= 0) normalizers.splice(i, 1); };
    }
    function registerRefresh(fn) {
      refreshers.push(fn);
      return function () { const i = refreshers.indexOf(fn); if (i >= 0) refreshers.splice(i, 1); };
    }

    // Structural rebuild — geometry/topology changed. Posts a rebuild to the
    // source (bumps epoch, builds a fresh runtime worker-side, ships new
    // geometry); the onGeometry handler swaps the display proxy, clears the
    // snapshot buffer, reseeds the clock, and rebuilds per-circuit readouts if
    // the count changed. Drive/mechanical are re-pushed to the new runtime, plot
    // history is cleared (no line from the old tail back to t=0), and — when
    // asked — the config is normalized (BEFORE expand, so the runtime and drive
    // build from the same canonical config the panels show) then the
    // config-dependent panels rebuilt. `expanded` is refreshed here so the
    // main-side renderers/readouts match the epoch the source is building.
    function requestRebuild(opts) {
      opts = opts || {};
      if (opts.rebuildPanels) for (const fn of normalizers.slice()) fn();
      expanded = expand(config);
      source.post({ type: "rebuild", config: config });
      reapplyDrive();
      history.clear();
      if (opts.rebuildPanels) for (const fn of refreshers.slice()) fn();
    }

    // Render-only update — a pure render attribute changed (layer/end-cap
    // transparency). Re-expand so the new alpha reaches the renderer, but leave
    // the running runtime, plot history and panels untouched: the simulation and
    // plots continue uninterrupted. Alpha never affects physics, so the live
    // runtime's geometry stays valid.
    function requestRenderUpdate() {
      expanded = expand(config);
    }

    function buildCtx() {
      return {
        // The interpolated display proxy — what renderers read. The real
        // numeric runtime lives behind `source` (off-thread-capable) and is
        // never handed to the main thread.
        runtime: dispRuntime,
        config:  config,
        view:    { yaw: orbitYaw, pitch: orbitPitch, dist: ORBIT_DIST },
        requestRebuild: requestRebuild,
        requestRenderUpdate: requestRenderUpdate,
        registerNormalize: registerNormalize,
        registerRefresh: registerRefresh,
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
    // Plots show a fixed REAL_WINDOW seconds of playback; the on-screen sim-time
    // span is REAL_WINDOW × speed (fixed while playing → uniform scroll, no
    // expanding axis). Buffer sized to cover the window even on a 144 Hz display.
    const REAL_WINDOW = 8;            // real seconds of playback shown
    const history     = makePlotHistory(REAL_WINDOW, 144);

    let paused = false;
    let rafId = null;
    let lastTime = null;

    // Timing. Each frame advances the smooth `simClock` by speed × dtFrame
    // (speed is sim-s/real-s) and renders the snapshot stream interpolated at
    // that clock; the solver runs on its own LTE cadence behind the source. When
    // solves can't keep up, the clock is pulled back to the newest solve and the
    // plot fills less of its fixed window.
    let effRate = speed;           // smoothed achieved rate, for the header badge

    // -----------------------------------------------------------------------
    //  7. Readout builder
    // -----------------------------------------------------------------------
    function buildReadoutRow(label, parent) {
      const row = el("div", "", { display: "flex", justifyContent: "space-between", gap: "4px" });
      const lbl = el("span", "", { color: "var(--muted,#8a93a3)" });
      lbl.textContent = label;
      const val = el("span", "", { fontVariantNumeric: "tabular-nums" });
      val.textContent = "—";
      row.append(lbl, val);
      (parent || readoutCol).appendChild(row);
      return val;
    }

    const rdTorque  = buildReadoutRow("τ (Nm)");
    const rdOmega   = buildReadoutRow("ω (rad/s)");
    const rdTheta   = buildReadoutRow("θ (rad)");

    // Per-circuit current + flux readouts — rebuilt when the circuit count
    // changes (e.g. loading a different machine) so they track the live motor.
    const circuitReadoutHost = el("div");
    readoutCol.appendChild(circuitReadoutHost);
    let rdCurrents = [];
    let rdFlux = [];
    function rebuildReadouts() {
      circuitReadoutHost.innerHTML = "";
      rdCurrents = [];
      rdFlux = [];
      for (let k = 0; k < expanded.nCircuits; k++) rdCurrents.push(buildReadoutRow("i_" + k + " (A)", circuitReadoutHost));
      for (let k = 0; k < expanded.nCircuits; k++) rdFlux.push(buildReadoutRow("λ_" + k + " (Wb)", circuitReadoutHost));
    }
    rebuildReadouts();

    // -----------------------------------------------------------------------
    //  9. Reset handler
    // -----------------------------------------------------------------------
    btnReset.addEventListener("click", function () {
      buffer.clear();
      simClock = 0;
      source.post({ type: "reset" });   // ships a fresh seed snapshot at t=0
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

    function niceStep(x) {
      if (!(x > 0)) return 1;
      const p = Math.pow(10, Math.floor(Math.log10(x)));
      const f = x / p;
      const n = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
      return n * p;
    }

    function drawPlot(canvas, history, title, color, yFmt) {
      const { W, H } = fitCanvas(canvas);
      if (W <= 0 || H <= 0) return;
      const ctx2 = canvas.getContext("2d");
      const pts = history;
      // Fixed window: REAL_WINDOW seconds of playback at the ordered speed. The
      // span is constant while playing (no expanding axis); data fills from the
      // right and the grid scrolls left with it.
      const W_sim = Math.max(REAL_WINDOW * speed, 1e-9);
      const tNow  = pts.length ? pts[pts.length - 1].t : 0;
      const tMin  = tNow - W_sim;
      const tStep = niceStep(W_sim / 5);
      if (!pts.length) {
        LIB.Plot.drawGrid(ctx2, 0, 0, W, H, -1, 1, tMin, tNow, title, 11, { tStep });
        return;
      }
      // y-range from the samples currently inside the window.
      let yMin = Infinity, yMax = -Infinity;
      for (const p of pts) {
        if (p.t < tMin || !Number.isFinite(p.y)) continue;
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
      if (!(yMin <= yMax)) { yMin = -1; yMax = 1; }
      if (yMax - yMin < 1e-9) { yMin -= 0.5; yMax += 0.5; }
      const pad = (yMax - yMin) * 0.1 || 0.1;
      yMin -= pad; yMax += pad;
      LIB.Plot.drawGrid(ctx2, 0, 0, W, H, yMin, yMax, tMin, tNow, title, 11, { yFmt, tStep });
      // Clip the trace to the data rect so samples scrolling off the left edge
      // don't spill into the y-gutter / axis labels.
      const yGutter = Math.max(28, Math.round(11 * 2.6));
      ctx2.save();
      ctx2.beginPath();
      ctx2.rect(yGutter, 0, Math.max(0, W - yGutter - 4), H);
      ctx2.clip();
      LIB.Plot.drawLine(ctx2, 0, 0, W, H, yMin, yMax, tMin, tNow, pts, color, 2);
      ctx2.restore();
    }

    // Fill a 2-D cross-section canvas with the panel background and a centred
    // label. Used when no 2-D renderer is registered on the seam.
    function paint2DPlaceholder(canvas, label) {
      const { W, H } = fitCanvas(canvas);
      if (W <= 0 || H <= 0) return;
      const ctx2 = canvas.getContext("2d");
      ctx2.clearRect(0, 0, W, H);
      ctx2.fillStyle = LIB.Util.getVar ? LIB.Util.getVar("--panel") || "#1b1f25" : "#1b1f25";
      ctx2.fillRect(0, 0, W, H);
      ctx2.fillStyle = "rgba(138,147,163,0.8)";
      ctx2.font = "11px ui-sans-serif";
      ctx2.textAlign = "center";
      ctx2.textBaseline = "middle";
      ctx2.fillText(label || "no 2-D renderer", W / 2, H / 2);
    }

    // Smoothed per-frame timing (exponential moving average), split into the
    // solve phase and the render phase so the header shows where the time goes.
    let perfSolveMs = 0, perfRenderMs = 0;
    const PERF_EMA = 0.15;
    const nowMs = function () { return (typeof performance !== "undefined") ? performance.now() : 0; };

    function frame(now) {
      rafId = requestAnimationFrame(frame);

      if (lastTime === null) lastTime = now;
      const dtFrame = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      // Nominal per-frame sim-advance at the ordered speed; lead/lag windows
      // scale off it (WORKER-SPEC §8).
      const frameAdvance = speed / 60;
      const maxLag = MAX_LAG_FRAMES * frameAdvance;

      // Pace — advance the smooth clock and tell the source to free-run the
      // solver a few frames ahead, then reconcile the clock with the newest
      // solve. `solveMs` is the in-process solve cost (≈0 once the sim runs in a
      // Worker), shown in the perf badge.
      let solveMs = 0;
      if (!paused && curEpoch >= 0) {
        simClock += speed * dtFrame;
        const tSolve = nowMs();
        source.post({ type: "pace", simClock: simClock, leadCap: LEAD_FRAMES * frameAdvance, paused: false });
        solveMs = nowMs() - tSolve;
        const latest = buffer.latest();
        const res = Snap.resolveShowTime(simClock, latest ? latest.t : null, maxLag);
        simClock = res.simClock;
        behind = res.behind;
      }

      // Interpolate the display state at tShow and (when running) push a plot
      // sample on the same clock so trace and axis scroll together.
      const prevShow = dispRuntime ? dispRuntime.state.t : 0;
      if (dispRuntime && buffer.count > 0) {
        const latest = buffer.latest();
        const r = Snap.resolveShowTime(simClock, latest.t, maxLag);
        const br = buffer.bracket(r.tShow);
        if (br) {
          Snap.writeInterp(dispRuntime, br.A, br.B, br.f, r.tShow);
          buffer.prune(r.tShow);
          dispReady = true;   // field arrays now populated — safe to render
          if (!paused) {
            const st0 = dispRuntime.state;
            history.push(st0.t, dispRuntime.lastSolve.torque, st0.omega, st0.i.length ? st0.i[0] : 0);
            const frameRate = dtFrame > 0 ? (st0.t - prevShow) / dtFrame : speed;
            effRate += (frameRate - effRate) * 0.2;   // smooth for the badge
          }
        }
      }

      // ---- render phase (timed) ----
      const tRender = nowMs();

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
          // Orthographic: the cross-section caps are drawn through a single
          // affine ctx transform, which only matches a linear projection. Under
          // perspective at this camera distance the caps diverge from the
          // per-vertex-projected walls (~20 px) and the rig looks non-coaxial.
          ortho: true,
        });

        // render3d.js always registers the 3-D rig before the first frame (its
        // <script> tag loads before runTabs), so RENDER3D is the only 3-D path.
        // Renderers read the interpolated display proxy (dispRuntime), never the
        // off-thread runtime. Gated on dispReady: the proxy's field arrays are
        // null until the first snapshot is interpolated (geometry and the first
        // snapshot are separate async messages on the Worker path).
        if (dispReady && UM.RENDER3D) {
          const rctx = { runtime: dispRuntime, config: config, expanded: expanded, canvas: viewport3D, W: W3, H: H3 };
          UM.RENDER3D.paint(buildCtx(), L3, rctx);
        }
      }

      // Cross-section views — dispatched through the 2-D-render seam. The
      // registrant (cross-section-render.js) decides which slice/view goes in
      // which canvas. When no renderer / no frame yet, paint a placeholder.
      if (dispReady && UM.CROSS_SECTION_2D) {
        const dummyRctx = { runtime: dispRuntime, config: config, expanded: expanded };
        UM.CROSS_SECTION_2D.paint(buildCtx(), [canvas2DA, canvas2DB], dummyRctx);
      } else {
        paint2DPlaceholder(canvas2DA, "no 2-D renderer");
        paint2DPlaceholder(canvas2DB, "no 2-D renderer");
      }

      // Plots
      drawPlot(plotTorque,  history.torque,  "τ (Nm)",    "#ffd54a", v => v.toFixed(4));
      drawPlot(plotOmega,   history.omega,   "ω (rad/s)", "#4ea1ff", v => v.toFixed(2));
      drawPlot(plotCurrent, history.current, "i_0 (A)",   "#66bb6a", v => v.toFixed(3));

      const renderMs = nowMs() - tRender;
      perfSolveMs  += (solveMs  - perfSolveMs)  * PERF_EMA;
      perfRenderMs += (renderMs - perfRenderMs) * PERF_EMA;
      perfBadge.textContent = "solve " + perfSolveMs.toFixed(1) + " · render " + perfRenderMs.toFixed(1) + " ms";
      UM._perf = { solveMs: perfSolveMs, renderMs: perfRenderMs };

      // Readouts — from the interpolated display proxy.
      if (dispReady) {
        const st = dispRuntime.state;
        const solved = dispRuntime.lastSolve;
        const tau = solved.torque;
        rdTorque.textContent = Number.isFinite(tau)      ? tau.toExponential(3)       : "—";
        rdOmega.textContent  = Number.isFinite(st.omega) ? st.omega.toFixed(3)        : "—";
        rdTheta.textContent  = Number.isFinite(st.theta) ? st.theta.toFixed(3)        : "—";

        for (let k = 0; k < rdCurrents.length; k++) {
          const ik = st.i[k];
          rdCurrents[k].textContent = Number.isFinite(ik) ? ik.toFixed(4) : "—";
        }
        for (let k = 0; k < rdFlux.length; k++) {
          const lk = solved.fluxLinkages[k];
          rdFlux[k].textContent = Number.isFinite(lk) ? lk.toExponential(3) : "—";
        }
      }

      // Below-ordered warning — the solver can't sustain the ordered rate, so
      // the clock was pulled back to the newest solve (the plot fills less of
      // the window). `behind` is set when the backlog was dropped this frame.
      if (!paused && (behind || effRate < speed * 0.9)) {
        warnBadge.style.display = "";
        warnBadge.textContent = "⚠ playing " + (+effRate.toPrecision(2)) + "× · ordered " + (+speed.toPrecision(3)) + "×";
      } else {
        warnBadge.style.display = "none";
      }
    }

    // Boot the sim: build the runtime + ship geometry and the t=0 seed
    // (onGeometry/onSnapshot handlers above populate the display proxy and
    // buffer synchronously for the in-process source), then push the current
    // drive/load settings to the fresh runtime.
    source.post({ type: "init", config: config });
    reapplyDrive();

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

      source.dispose();
      host.removeChild(root);
    }

    return unmount;
  };

})();
