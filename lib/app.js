"use strict";

// =============================================================================
//  LIB.App — spec-driven lesson shell.
//
//  Three entry points:
//
//    LIB.App.run(spec)
//        Single-spec full-page mount. Clears document.body and builds the
//        standard chrome (header + stage + sliders + plots) for one spec.
//
//    LIB.App.runTabs({ title, tabs, initial?, persistKey? })
//        Multi-tab page. Builds an outer header (app title + .ex-tabs strip)
//        and mounts ONE active tab below it at a time. Tabs are either:
//          { label, spec }                      — standard stage shape
//          { label, mount: (host) => unmount }  — fully custom DOM (for
//                                                  controlapp tutorials etc.)
//
//    LIB.App._mountSpec(host, spec)
//        Internal: builds the standard chrome inside any host element and
//        returns a handle with `.unmount()`. Both run() and runTabs() use
//        this. Exposed under `_` so plugins/tests can call it directly,
//        but lessons should not.
//
//  ────────────────────────────────────────────────────────────────────────────
//   THE SPEC CONTRACT  (what each tab provides)
//  ────────────────────────────────────────────────────────────────────────────
//
//   { id, title, subtitle, description,
//     state: () => stateObj,
//     onReset: (state) => void,
//
//     // sliders/plots/readouts can be a value OR a function of state.
//     // Functions are re-evaluated whenever the shell rebuilds the panel
//     // (slider rebuilds happen on mode change and on dynamic-shape change;
//     // plot panes rebuild when their title/series signature changes; readout
//     // count is checked every frame).
//     sliders:  panels | (state) => panels,
//     plots:    list   | (state) => list,
//     readouts: list   | (state) => list,
//
//     physics: { dof, dxdt, jacobian?, integrator?, preStep?, postStep?, step? },
//
//     // -------- declarative controllers (optional) --------
//     // Array of LIB.ControlBlock specs. The shell advances each one BETWEEN
//     // preStep and the integrator, writing its breakdown to state[output].
//     // dxdt reads state[output].u as a constant over the integrator's
//     // sub-evaluations (the canonical ZOH pattern). See lib/control-block.js
//     // for the per-block schema.
//     controllers: [
//       { slot: "ctrlLoop", output: "ctrlOut",
//         enable?: (s, p) => bool, modeKey?: "mode",
//         pid?:      { err, dmeas, gains },
//         bangbang?: { flavor, err, dir?, gains } },
//       …
//     ],
//
//     // -------- declarative layout (recommended) --------
//     // The shell builds L once per frame from spec.layout and hands it to
//     // render + onPointer + draggers. Lessons should NOT rebuild it inside
//     // their callbacks. Three built-in kinds map to LIB.Layout.* factories;
//     // a function form lets a lesson supply a custom L.
//     layout: { kind: "linearTrack", xMin, xMax, padX?, padY?, trackFrac? }
//          | { kind: "world2D",     worldW?, worldH?, originX?, originY?, padPx?, maxScale? }
//          | { kind: "rotational",  worldR?, originX?, originY?, padPx?, maxScale? }
//          | (W, H, state, params) => L                              // custom
//
//     // -------- declarative motor (optional) --------
//     // When set, the shell paints a motor each frame (using LIB.Draw.motor)
//     // before delegating to spec.render. `place` returns the motor centre +
//     // radius given the prebuilt L. `thermalAware` pulls halo/fill/stroke
//     // from LIB.Thermal.motorOpts(state, r). Set the spec to a function form
//     // when placement / visibility depends on state or mode (return null to
//     // skip painting that frame, e.g. when a composite renderer like
//     // LIB.BeltRender draws the motor itself).
//     motor: { place, r?: 28, thetaField?: "theta", label?: "motor",
//              thermalAware?: false, z?: "below"|"above" }
//          | (state, params) => motorCfg | null
//
//     // -------- declarative position rail (optional) --------
//     // Linear-track-only overlay painted AFTER spec.render. Reads `field`
//     // from state for the current position, optional `target` from params.
//     // posFmt customises the label; default `${field} = ${val.toFixed(3)} m`.
//     positionRail: { field?: "x", target?: "xTarget", targetLabel?: "target",
//                     posFmt?: (val, state, params) => string, yOffset?: 30 }
//
//     render:    (ctx, L, state, params) => void,
//     onPointer: (type, mx, my, L, state, params) => void,
//
//     // -------- header buttons --------
//     // Pure spec-supplied. The shell appends them after Reset/Pause and
//     // refreshes their label/style each frame. label/style may be strings
//     // or (state, params) => string|object. Lessons that want a standard
//     // Drive ON/OFF toggle use LIB.HeaderButtons.driveToggle() — see
//     // lib/header-buttons.js. Nothing app-specific lives in this shell.
//     headerButtons: [{ id?, label, style?, onClick(state, params) }, …],
//
//     thermal: false,        // reserved — lessons just expose readouts directly
//
//     // -------- modes axis (sub-tabs that swap sliders/plots/render/physics
//     //          inside ONE spec, preserving state across the swap) --------
//     modes: {
//       default: "lead",                          // initial mode id
//       persistKey: "wholesys-mode",              // optional localStorage key
//       list: [
//         { id: "lead", label: "lead-screw" },
//         { id: "ball", label: "ball-screw" },
//         { id: "conv", label: "conveyor"   },
//       ],
//       onChange: (state, newId, prevId) => {/* prep state for new mode */},
//     }
//     The shell sets `state.mode` on init and exposes `params.mode` each tick.
//     `spec.sliders` etc. typically branch on `state.mode` to render the
//     mode-specific UI. Mode changes do NOT re-run `spec.state()`.
//
//     // -------- timing --------
//     physHz: 240, histRateHz: 60, histWindowS: 8,
//
//     // -------- bootstrap --------
//     init: (handle) => void,
//   }
//
//  ────────────────────────────────────────────────────────────────────────────
//   DEPENDENCIES
//     lib/util.js, lib/registry.js, lib/plot.js, lib/integrate.js   (required)
//     lib/layout.js, lib/drag.js, lib/draw.js, …                    (lessons)
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Util)      throw new Error("LIB.App requires lib/util.js");
  if (!LIB.Registry)  throw new Error("LIB.App requires lib/registry.js");
  if (!LIB.Plot)      throw new Error("LIB.App requires lib/plot.js");
  if (!LIB.Integrate) throw new Error("LIB.App requires lib/integrate.js");

  // ---------------------------------------------------------------------------
  //  helpers
  // ---------------------------------------------------------------------------

  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "class") e.className = props[k];
      else if (k === "style") Object.assign(e.style, props[k]);
      else if (k.startsWith("on") && typeof props[k] === "function") e[k] = props[k];
      else if (k === "html") e.innerHTML = props[k];
      else e.setAttribute(k, props[k]);
    }
    if (children) for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  function normalisePanels(sliders) {
    if (!sliders) return [];
    if (Array.isArray(sliders)) return [{ kind: "static", items: sliders.slice() }];
    const out = [];
    for (const k in sliders) {
      const v = sliders[k];
      if (Array.isArray(v)) {
        out.push({ title: k, kind: "static", items: v.slice() });
      } else if (v && v.kind === "dynamic") {
        out.push({ title: v.title || k, kind: "dynamic",
                   items: v.items, actions: v.actions || [],
                   span: v.span });
      } else if (Array.isArray(v && v.items)) {
        out.push({ title: v.title || k, kind: "static", items: v.items.slice(),
                   actions: v.actions || [],
                   span: v.span });
      } else if (v && Array.isArray(v.actions)) {
        // Buttons-only panel: { Targets: { actions: [{label, run}, …] } }.
        out.push({ title: v.title || k, kind: "static", items: [],
                   actions: v.actions.slice(),
                   span: v.span });
      }
    }
    return out;
  }

  function dynamicSignature(items, state) {
    const groups = items(state) || [];
    const keys = [];
    for (const g of groups) for (const e of g) keys.push(e.key || "");
    return keys.join("|");
  }

  function callOrValue(v, state) {
    return typeof v === "function" ? v(state) : v;
  }

  function readPersisted(key) {
    if (!key) return null;
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function writePersisted(key, val) {
    if (!key) return;
    try { localStorage.setItem(key, val); } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  //  _mountSpec — builds full chrome inside `host`, runs the main loop,
  //  returns a handle with .unmount().
  // ---------------------------------------------------------------------------

  function _mountSpec(host, spec) {
    if (!spec || typeof spec !== "object") {
      throw new Error("LIB.App._mountSpec: spec required");
    }
    const physHz      = +spec.physHz      || 240;
    const PHYS_DT     = 1 / physHz;
    const histRateHz  = +spec.histRateHz  || 60;
    const histWindowS = +spec.histWindowS || 8;
    const histMaxLen  = histWindowS * histRateHz + 4;

    // ---- chrome inside host ----
    host.innerHTML = "";

    const headerH1  = el("h1", null, [spec.title || ""]);
    const headerSub = spec.subtitle ? el("span", { class: "subtitle" }, [spec.subtitle]) : null;
    const sp        = el("span", { class: "sp" });
    const btnReset  = el("button", null, ["Reset"]);
    const btnPause  = el("button", null, ["Pause"]);
    const headerChildren = [headerH1];
    if (headerSub) headerChildren.push(headerSub);
    headerChildren.push(sp, btnReset, btnPause);

    // Spec-supplied header buttons. The shell knows nothing app-specific —
    // every entry is { label, style?, onClick } where label and style may be
    // strings/objects or functions of (state, params) re-evaluated each
    // frame. Lessons that want a Drive ON/OFF toggle build one via
    // LIB.HeaderButtons.driveToggle() (or roll their own).
    const headerBtnEntries = Array.isArray(spec.headerButtons)
      ? spec.headerButtons.slice() : [];
    const headerBtnNodes = [];
    for (const entry of headerBtnEntries) {
      // Function-form labels need state/params, which aren't declared yet —
      // start blank and let refreshHeaderButtons() (called after state init)
      // fill the real text in.
      const initLabel = (typeof entry.label === "function") ? "" : entry.label;
      const b = el("button", { type: "button" }, [String(initLabel || "")]);
      if (entry.id) b.dataset.btnId = entry.id;
      b.addEventListener("click", () => {
        if (typeof entry.onClick === "function") entry.onClick(state, params);
        refreshHeaderButtons();
      });
      headerChildren.push(b);
      headerBtnNodes.push({ entry, node: b });
    }

    function refreshHeaderButtons() {
      for (const { entry, node } of headerBtnNodes) {
        if (typeof entry.label === "function") {
          const txt = String(entry.label(state, params) || "");
          if (node.textContent !== txt) node.textContent = txt;
        }
        const sty = (typeof entry.style === "function")
          ? entry.style(state, params)
          : entry.style;
        if (sty) for (const k in sty) node.style[k] = sty[k];
      }
    }

    const header = el("header", null, headerChildren);
    host.appendChild(header);

    const lesson = el("section", { class: "lesson" });
    host.appendChild(lesson);

    // Modes sub-tabs (above the stage)
    const modesCfg = spec.modes && Array.isArray(spec.modes.list) && spec.modes.list.length
      ? spec.modes : null;
    const modesStrip = modesCfg ? el("div", { class: "sub-tabs" }) : null;
    if (modesStrip) lesson.appendChild(modesStrip);

    const stage    = el("div", { class: "stage" });
    lesson.appendChild(stage);

    const cvBox    = el("div", { class: "cv-box" });
    const cv       = el("canvas");
    cvBox.appendChild(cv);
    const ctx      = cv.getContext("2d");

    const rightPane = el("div", { class: "right-pane" });
    const plotStack = el("div", { class: "plot-stack" });
    const readoutEl = el("div", { class: "readout" });
    rightPane.append(plotStack, readoutEl);

    const subPanels = el("div", { class: "sub-panels" });

    stage.append(cvBox, rightPane, subPanels);

    // ---- state ----
    const state  = spec.state ? spec.state() : {};
    if (state.t == null) state.t = 0;
    const params = {};

    // Initialise modes axis
    let activeMode = null;
    if (modesCfg) {
      const persisted = readPersisted(modesCfg.persistKey);
      const validIds  = modesCfg.list.map(m => m.id);
      let initial = persisted && validIds.includes(persisted) ? persisted
                   : (modesCfg.default && validIds.includes(modesCfg.default) ? modesCfg.default
                     : modesCfg.list[0].id);
      activeMode = initial;
      state.mode = initial;
    }

    // Per-panel slider registries.
    let registries = [];
    let panels = [];
    const dynamicSigs = new Map();
    let plotPanes = [];
    let plotsSig  = "";

    // ---- slider build ----

    function getSliderSpec() {
      return callOrValue(spec.sliders, state);
    }

    function buildPanelDom(idx, panel) {
      const cls = panel.span === "full" ? "box span-full" : "box";
      const box = el("div", { class: cls });
      if (panel.title) box.appendChild(el("h2", null, [panel.title]));
      const reg = registries[idx] = {};

      let entries = panel.items;
      if (panel.kind === "dynamic") {
        const groups = panel.items(state) || [];
        entries = [];
        for (const g of groups) for (const e of g) entries.push(e);
        dynamicSigs.set(idx, dynamicSignature(panel.items, state));
      }
      for (const entry of entries) {
        if (entry.disabled) {
          reg[entry.key] = Object.assign({}, entry);
          LIB.Registry.mkRow(box, reg, entry.key);
          const row = box.lastChild;
          if (row) row.classList.add("disabled");
        } else {
          reg[entry.key] = Object.assign({}, entry);
          LIB.Registry.mkRow(box, reg, entry.key,
            entry.onChange ? (v) => entry.onChange(v, state) : null);
        }
      }
      // Action button row — supported on BOTH static and dynamic panels.
      // Dynamic items can react to a button's state mutation by changing
      // shape; static panels just want a row of preset buttons (e.g. rover
      // target presets, heli reference quick-jumps).
      if (panel.actions && panel.actions.length) {
        const pair = el("div", { class: "pair" });
        for (const a of panel.actions) {
          const b = el("button", { type: "button" }, [a.label]);
          b.addEventListener("click", () => {
            a.run(state);
            rebuildIfShapeChanged();
            gatherParams();
          });
          pair.appendChild(b);
        }
        box.appendChild(pair);
      }
      return box;
    }

    function buildSliderPanels() {
      subPanels.innerHTML = "";
      registries = [];
      dynamicSigs.clear();
      panels = normalisePanels(getSliderSpec());
      panels.forEach((p, i) => subPanels.appendChild(buildPanelDom(i, p)));
      if (spec.description) {
        const box = el("div", { class: "box" });
        box.appendChild(el("h2", null, ["Notes"]));
        box.appendChild(el("div", { class: "notes", html: spec.description }));
        subPanels.appendChild(box);
      }
      if (subPanels.children.length === 1) subPanels.classList.add("single");
      else subPanels.classList.remove("single");
    }

    function rebuildIfShapeChanged() {
      let changed = false;
      panels.forEach((p, i) => {
        if (p.kind !== "dynamic") return;
        const sig = dynamicSignature(p.items, state);
        if (sig !== dynamicSigs.get(i)) {
          const newBox = buildPanelDom(i, p);
          const oldBox = subPanels.children[i];
          if (oldBox) subPanels.replaceChild(newBox, oldBox);
          else        subPanels.appendChild(newBox);
          changed = true;
        }
      });
      if (changed) {
        if (subPanels.children.length === 1) subPanels.classList.add("single");
        else subPanels.classList.remove("single");
      }
    }

    buildSliderPanels();

    // ---- plot build ----

    function plotsList() {
      const ps = callOrValue(spec.plots, state);
      return Array.isArray(ps) ? ps : [];
    }
    function plotsListSignature(list) {
      return list.map(p => p.title + "::" + (p.series || []).map(s => s.label).join(",")).join("|");
    }
    function buildPlotPanes() {
      plotStack.innerHTML = "";
      const list = plotsList();
      plotPanes = list.map(cfg => {
        const box = el("div", { class: "plot-box" });
        const c   = el("canvas");
        box.appendChild(c);
        plotStack.appendChild(box);
        return { canvas: c, ctx: c.getContext("2d"), config: cfg, hist: [], lastT: -Infinity };
      });
      plotsSig = plotsListSignature(list);
    }
    buildPlotPanes();

    // ---- modes sub-tab build (after panels exist) ----

    let modeButtons = [];
    function setActiveMode(id, opts) {
      if (!modesCfg) return;
      const prev = activeMode;
      if (id === prev && !(opts && opts.force)) return;
      activeMode = id;
      state.mode = id;
      if (typeof modesCfg.onChange === "function") {
        modesCfg.onChange(state, id, prev);
      }
      writePersisted(modesCfg.persistKey, id);
      modeButtons.forEach(b => b.classList.toggle("active", b.dataset.modeId === id));
      // Rebuild slider panels and plot panes since either may depend on
      // state.mode. Plot signature is also re-checked each frame, but doing
      // it eagerly here keeps the user-visible swap snappy.
      buildSliderPanels();
      buildPlotPanes();
      resetHistory();
    }
    if (modesCfg) {
      modeButtons = modesCfg.list.map(m => {
        const b = el("button", { type: "button" }, [m.label]);
        b.dataset.modeId = m.id;
        b.addEventListener("click", () => setActiveMode(m.id));
        modesStrip.appendChild(b);
        return b;
      });
      modeButtons.forEach(b => b.classList.toggle("active", b.dataset.modeId === activeMode));
    }

    // ---- gather params ----

    function gatherParams() {
      for (const k in params) delete params[k];
      for (let i = 0; i < registries.length; i++) {
        const reg = registries[i];
        for (const k in reg) params[k] = reg[k].value;
      }
      params.t = state.t || 0;
      if (modesCfg) params.mode = state.mode;
    }

    // ---- physics ----

    const phys = spec.physics || {};
    const integrator = phys.integrator || "rk4";
    // dof can be a static list OR a function of state — the rotational chains
    // grow / shrink at runtime, so each step refreshes its own dof view.
    const getDof = (typeof phys.dof === "function")
      ? () => phys.dof(state)
      : (() => phys.dof || []);

    // Controllers — advanced between preStep and the integrator. Each entry is
    // a LIB.ControlBlock spec; the shell calls advance(state, params, dt, spec)
    // for each, in declared order. The block writes its breakdown to
    // state[spec.output] and dxdt reads it as a constant during the rk4 stages.
    const controllerSpecs = Array.isArray(spec.controllers)
      ? spec.controllers.slice() : [];
    if (controllerSpecs.length && !LIB.ControlBlock) {
      throw new Error("LIB.App: spec.controllers requires lib/control-block.js");
    }

    function stepOnce(dt) {
      if (typeof phys.preStep === "function") phys.preStep(state, params, dt);
      for (const cs of controllerSpecs) {
        LIB.ControlBlock.advance(state, params, dt, cs);
      }
      if (typeof phys.step === "function") {
        phys.step(state, params, dt);
      } else if (typeof phys.dxdt === "function") {
        const dof = getDof();
        if (dof.length > 0) {
          const t = state.t || 0;
          switch (integrator) {
            case "rk4":
              LIB.Integrate.rk4(state, dof, phys.dxdt, params, t, dt); break;
            case "rk45":
              LIB.Integrate.rk45(state, dof, phys.dxdt, params, t, dt); break;
            case "siEuler":
              LIB.Integrate.siEuler(state, dof, phys.dxdt, params, t, dt); break;
            case "implicitEuler":
              if (typeof phys.jacobian !== "function") {
                throw new Error("LIB.App: integrator='implicitEuler' requires physics.jacobian");
              }
              LIB.Integrate.implicitEuler(state, dof, phys.dxdt, phys.jacobian, params, t, dt);
              break;
            default:
              throw new Error("LIB.App: unknown integrator '" + integrator + "'");
          }
        }
      }
      if (typeof phys.postStep === "function") phys.postStep(state, params, dt);
      state.t = (state.t || 0) + dt;
    }

    // ---- history ----

    function pushHistory() {
      const t = state.t || 0;
      for (const pane of plotPanes) {
        if (t - pane.lastT < 1 / histRateHz) continue;
        pane.lastT = t;
        const sample = { t };
        for (const s of (pane.config.series || [])) {
          sample[s.label] = +s.source(state, params);
        }
        pane.hist.push(sample);
        while (pane.hist.length > histMaxLen) pane.hist.shift();
      }
    }
    function resetHistory() {
      for (const pane of plotPanes) { pane.hist.length = 0; pane.lastT = -Infinity; }
    }

    // ---- render ----

    function fitCanvas(canvas, ctx2d) { return LIB.Util.fitCanvas(canvas, ctx2d); }

    // spec.layout: three declarative kinds map onto LIB.Layout factories;
    // a function form lets a lesson ship a custom L. Required whenever the
    // lesson interacts with the canvas (render / onPointer / motor / rail).
    const needsLayout = spec.render || spec.onPointer || spec.motor || spec.positionRail;
    let buildLayout = null;
    if (typeof spec.layout === "function") {
      buildLayout = (W, H) => spec.layout(W, H, state, params);
    } else if (spec.layout && spec.layout.kind) {
      const fac = LIB.Layout && LIB.Layout[spec.layout.kind];
      if (typeof fac !== "function") {
        throw new Error("LIB.App: unknown spec.layout.kind '" + spec.layout.kind + "'");
      }
      buildLayout = (W, H) => fac(W, H, spec.layout);
    } else if (needsLayout) {
      throw new Error("LIB.App: spec.layout required when render/onPointer/motor/positionRail is set");
    }

    function paintMotor(L, cfg) {
      const place = cfg.place(L, state, params);
      if (!place) return;
      const r = (place.r != null) ? +place.r : (cfg.r != null ? +cfg.r : 28);
      const opts = {
        theta: state[cfg.thetaField || "theta"] || 0,
        label: (cfg.label != null) ? cfg.label : "motor",
      };
      if (cfg.thermalAware) Object.assign(opts, LIB.Thermal.motorOpts(state, r));
      LIB.Draw.motor(ctx, +place.cx, +place.cy, r, opts);
    }

    function paintPositionRail(L) {
      const rail = spec.positionRail;
      const field = rail.field || "x";
      const val = +state[field];
      const target = rail.target ? +params[rail.target] : undefined;
      LIB.Draw.track(ctx, {
        xToPx: L.xToPx, xMin: L.xMin, xMax: L.xMax,
        y: L.trackY + (rail.yOffset != null ? +rail.yOffset : 30),
        padX: L.padX,
        x: val,
        target,
        targetLabel: rail.targetLabel || "target",
        posLabel: (typeof rail.posFmt === "function")
          ? rail.posFmt(val, state, params)
          : (field + " = " + val.toFixed(3) + " m"),
      });
    }

    function renderScene() {
      const layout = fitCanvas(cv, ctx);
      ctx.fillStyle = "#0d1013";
      ctx.fillRect(0, 0, layout.w, layout.h);
      if (!needsLayout) return;
      const L = buildLayout(layout.w, layout.h);
      const motorCfg = (typeof spec.motor === "function")
        ? spec.motor(state, params) : spec.motor;
      if (motorCfg && motorCfg.z !== "above") paintMotor(L, motorCfg);
      if (typeof spec.render === "function") spec.render(ctx, L, state, params);
      if (motorCfg && motorCfg.z === "above") paintMotor(L, motorCfg);
      if (spec.positionRail) paintPositionRail(L);
    }

    function renderPlots() {
      const t = state.t || 0;
      const tMax = Math.max(t, histWindowS);
      const tMin = tMax - histWindowS;
      for (const pane of plotPanes) {
        const layout = fitCanvas(pane.canvas, pane.ctx);
        const W = layout.w, H = layout.h;
        pane.ctx.fillStyle = LIB.Util.getVar("--panel");
        pane.ctx.fillRect(0, 0, W, H);
        const fsize = Math.max(11, Math.min(W, H) * 0.038);
        let yLo = +pane.config.yMin, yHi = +pane.config.yMax;
        const winHist = pane.hist.filter(h => h.t >= tMin);
        if (!Number.isFinite(yLo) || !Number.isFinite(yHi)) {
          let lo = +Infinity, hi = -Infinity;
          for (const h of winHist) {
            for (const s of pane.config.series) {
              const v = h[s.label];
              if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
            }
          }
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = -1; hi = 1; }
          if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
          const pad = (hi - lo) * 0.08;
          yLo = Number.isFinite(yLo) ? yLo : lo - pad;
          yHi = Number.isFinite(yHi) ? yHi : hi + pad;
        }
        LIB.Plot.drawGrid(pane.ctx, 0, 0, W, H, yLo, yHi, tMin, tMax,
                          pane.config.title || "", fsize,
                          { yFmt: pane.config.yFmt });
        for (const s of pane.config.series) {
          const pts = winHist.map(h => ({ t: h.t, y: h[s.label] }));
          LIB.Plot.drawLine(pane.ctx, 0, 0, W, H, yLo, yHi, tMin, tMax,
                            pts, s.color, s.lw || 1.6, s.dash);
        }
      }
    }

    function renderReadouts() {
      const list = callOrValue(spec.readouts, state) || [];
      if (readoutEl.children.length !== list.length) {
        readoutEl.innerHTML = "";
        for (const r of list) {
          const ln = el("div", { class: "ln" });
          ln.appendChild(el("span", null, [r.label + (r.units ? " (" + r.units + ")" : "")]));
          const valSpan = el("b", null, [""]);
          const sufSpan = el("span", { class: "suffix" }, [""]);
          const right = el("span"); right.append(valSpan, sufSpan);
          ln.appendChild(right);
          readoutEl.appendChild(ln);
        }
      }
      list.forEach((r, i) => {
        const node = readoutEl.children[i];
        if (!node) return;
        // Update label too — readouts are a function of state in mode-aware
        // lessons, so the label may have changed.
        node.children[0].textContent = r.label + (r.units ? " (" + r.units + ")" : "");
        const valSpan = node.children[1].children[0];
        const sufSpan = node.children[1].children[1];
        const out = r.value(state, params);
        if (out && typeof out === "object") {
          valSpan.textContent = out.text || "";
          valSpan.style.color = out.color || "";
          sufSpan.textContent = out.suffix ? " " + out.suffix : "";
        } else {
          valSpan.textContent = String(out);
          valSpan.style.color = "";
          sufSpan.textContent = "";
        }
      });
    }

    // ---- pointer ----

    function pointerCoords(ev) {
      const r = cv.getBoundingClientRect();
      return { mx: ev.clientX - r.left, my: ev.clientY - r.top };
    }
    function dispatchPointer(type, ev) {
      if (typeof spec.onPointer !== "function") return;
      const { mx, my } = pointerCoords(ev);
      const r = cv.getBoundingClientRect();
      spec.onPointer(type, mx, my, buildLayout(r.width, r.height), state, params);
    }
    const onDown   = (ev) => { cv.setPointerCapture(ev.pointerId); cv.classList.add("grabbing"); dispatchPointer("down", ev); };
    const onMove   = (ev) => dispatchPointer("move",  ev);
    const onUp     = (ev) => { cv.classList.remove("grabbing"); dispatchPointer("up",    ev); };
    const onLeave  = (ev) => { cv.classList.remove("grabbing"); dispatchPointer("leave", ev); };
    const onCancel = (ev) => { cv.classList.remove("grabbing"); dispatchPointer("cancel",ev); };
    cv.addEventListener("pointerdown",   onDown);
    cv.addEventListener("pointermove",   onMove);
    cv.addEventListener("pointerup",     onUp);
    cv.addEventListener("pointerleave",  onLeave);
    cv.addEventListener("pointercancel", onCancel);

    // ---- buttons ----

    let paused = false;

    btnReset.addEventListener("click", () => {
      const fresh = spec.state ? spec.state() : {};
      for (const k in state) delete state[k];
      Object.assign(state, fresh);
      if (state.t == null) state.t = 0;
      if (modesCfg) state.mode = activeMode;
      resetHistory();
      if (typeof spec.onReset === "function") spec.onReset(state);
    });

    btnPause.addEventListener("click", () => {
      paused = !paused;
      btnPause.textContent = paused ? "Resume" : "Pause";
    });

    refreshHeaderButtons();

    // ---- main loop ----

    let mounted = true;
    let rafId   = null;
    let lastNow = performance.now();
    let acc     = 0;

    function tick(nowMs) {
      if (!mounted) return;
      const dtFrame = Math.min(0.05, (nowMs - lastNow) / 1000);
      lastNow = nowMs;
      if (!paused) {
        acc += dtFrame;
        while (acc >= PHYS_DT) {
          gatherParams();
          stepOnce(PHYS_DT);
          acc -= PHYS_DT;
        }
        gatherParams();
        // Detect spec.plots signature change (e.g. dynamic plot count)
        const list = plotsList();
        const sig = plotsListSignature(list);
        if (sig !== plotsSig) buildPlotPanes();
        // Detect dynamic-panel shape changes
        rebuildIfShapeChanged();
        pushHistory();
      }
      renderScene();
      renderPlots();
      renderReadouts();
      refreshHeaderButtons();
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    // ---- handle ----

    const handle = {
      canvas: cv, ctx, state, params,
      setMode(id) { setActiveMode(id); },
      // Programmatically set a slider's value (e.g. preset buttons that jump
      // the reference). Walks every panel registry; first match wins. Returns
      // true if a slider was found and updated. The new value is gathered
      // into `params` on the next physics tick automatically.
      setSlider(key, value) {
        for (const reg of registries) {
          if (key in reg) {
            const cfg = reg[key];
            cfg.value = +value;
            LIB.Registry.syncSlider(reg, key);
            return true;
          }
        }
        return false;
      },
      resetHistory,
      rebuildPanels: rebuildIfShapeChanged,
      unmount() {
        if (!mounted) return;
        mounted = false;
        if (rafId) cancelAnimationFrame(rafId);
        try { cv.removeEventListener("pointerdown",   onDown);   } catch (_) {}
        try { cv.removeEventListener("pointermove",   onMove);   } catch (_) {}
        try { cv.removeEventListener("pointerup",     onUp);     } catch (_) {}
        try { cv.removeEventListener("pointerleave",  onLeave);  } catch (_) {}
        try { cv.removeEventListener("pointercancel", onCancel); } catch (_) {}
        host.innerHTML = "";
      },
    };
    if (typeof spec.init === "function") spec.init(handle);
    return handle;
  }

  // ---------------------------------------------------------------------------
  //  outer chrome (scroll-host + .app) — shared by run() and runTabs()
  // ---------------------------------------------------------------------------

  function buildOuter() {
    document.body.innerHTML = "";
    const scrollHost = el("div", { class: "scroll-host" });
    const app        = el("div", { class: "app" });
    scrollHost.appendChild(app);
    document.body.appendChild(scrollHost);
    return app;
  }

  // ---------------------------------------------------------------------------
  //  LIB.App.run / LIB.App.runTabs
  // ---------------------------------------------------------------------------

  LIB.App = {

    _mountSpec,

    run(spec) {
      const app = buildOuter();
      return _mountSpec(app, spec);
    },

    runTabs(opts) {
      if (!opts || !Array.isArray(opts.tabs) || !opts.tabs.length) {
        throw new Error("LIB.App.runTabs: opts.tabs[] required");
      }
      const app = buildOuter();
      const tabs = opts.tabs.slice();

      // Outer header: app title + .ex-tabs strip
      const titleEl = opts.title ? el("h1", null, [opts.title]) : null;
      const tabStrip = el("div", { class: "ex-tabs" });
      const sp = el("span", { class: "sp" });
      const headerChildren = [];
      if (titleEl) headerChildren.push(titleEl);
      headerChildren.push(sp, tabStrip);
      const outerHeader = el("header", null, headerChildren);
      app.appendChild(outerHeader);

      // Per-tab content host
      const tabHost = el("div", {
        class: "tab-host",
        style: { display: "flex", flexDirection: "column", flex: "1", gap: "10px" },
      });
      app.appendChild(tabHost);

      // Pick initial active tab
      const validLabels = tabs.map(t => t.label);
      let activeIdx = 0;
      const persisted = readPersisted(opts.persistKey);
      if (persisted && validLabels.includes(persisted)) {
        activeIdx = validLabels.indexOf(persisted);
      } else if (typeof opts.initial === "number") {
        if (opts.initial >= 0 && opts.initial < tabs.length) activeIdx = opts.initial;
      } else if (typeof opts.initial === "string") {
        const idx = validLabels.indexOf(opts.initial);
        if (idx >= 0) activeIdx = idx;
      }

      let activeHandle = null;

      function activate(idx) {
        if (idx < 0 || idx >= tabs.length) return;
        if (activeHandle && typeof activeHandle.unmount === "function") {
          activeHandle.unmount();
        }
        tabHost.innerHTML = "";
        const tab = tabs[idx];
        Array.from(tabStrip.children).forEach((b, i) =>
          b.classList.toggle("active", i === idx));
        if (tab.spec) {
          activeHandle = _mountSpec(tabHost, tab.spec);
        } else if (typeof tab.mount === "function") {
          const ret = tab.mount(tabHost) || {};
          activeHandle = (typeof ret.unmount === "function")
            ? ret
            : { unmount() { tabHost.innerHTML = ""; } };
        } else {
          throw new Error("LIB.App.runTabs: tab '" + tab.label + "' must have either .spec or .mount");
        }
        writePersisted(opts.persistKey, tab.label);
      }

      tabs.forEach((tab, i) => {
        const btn = el("button", { type: "button" }, [tab.label]);
        btn.addEventListener("click", () => activate(i));
        tabStrip.appendChild(btn);
      });

      activate(activeIdx);

      return {
        activate(labelOrIdx) {
          if (typeof labelOrIdx === "number") activate(labelOrIdx);
          else {
            const idx = validLabels.indexOf(labelOrIdx);
            if (idx >= 0) activate(idx);
          }
        },
        get activeHandle() { return activeHandle; },
      };
    },
  };
})();
