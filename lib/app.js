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
//        Multi-tab page. Builds a slim outer .app-nav (app title + a
//        <select> lesson picker) above the per-spec stage. The picker
//        replaces the old button-row strip so the outer chrome reads as
//        navigation, distinct from the per-spec control header.
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
//     sliders:  panels | (state) => panels,
//     plots:    list   | (state) => list,
//     readouts: list   | (state) => list,
//
//     // Plot panes accept three axis-control fields:
//     //   yMin, yMax  — fixed bounds (legacy; locks the axis).
//     //   yFloor: { lo, hi } — minimum visible range. The axis tracks the
//     //                        in-window data extrema each frame and is
//     //                        never tightened narrower than this window.
//     //   yChunk      — snaps the tracked extrema outward to integer
//     //                 multiples of this value, so the axis breathes in
//     //                 clean increments instead of jittering on every
//     //                 sample. Without yChunk the axis follows data
//     //                 exactly; without yFloor it can shrink arbitrarily
//     //                 tight. Use both for a stable axis that breathes
//     //                 only in clean increments.
//
//     physics: { dof, dxdt, jacobian?, integrator?, preStep?, postStep?, step? },
//
//     // -------- declarative controllers (optional) --------
//     controllers: [
//       { slot: "ctrlLoop", output: "ctrlOut",
//         enable?: (s, p) => bool, modeKey?: "mode",
//         pid?:      { err, dmeas, gains },
//         bangbang?: { flavor, err, dir?, gains } },
//       …
//     ],
//
//     // -------- declarative layout (recommended) --------
//     layout: { kind: "linearTrack", xMin, xMax, padX?, padY?, trackFrac?,
//                                    marginLeftPx?, marginRightPx? }
//          | { kind: "world2D",     ... }
//          | { kind: "rotational",  ... }
//          | (W, H, state, params) => L                              // custom
//
//     // -------- declarative motor (optional) --------
//     // The shell paints a motor each frame using LIB.Draw.motor. When the
//     // layout is a linearTrack, marginLeftPx is auto-extended by
//     // 2·r + 16 px so the motor disc + spacer fit beside L.xMin without
//     // ever clipping the canvas edge. The auto-margin only fires for an
//     // actively painted motor — a function-form spec.motor that returns
//     // null in some modes won't reserve room in those modes.
//     motor: { place, r?: 28, thetaField?: "theta", label?: "motor",
//              thermalAware?: false, z?: "below"|"above" }
//          | (state, params) => motorCfg | null
//
//     // place(L, state, params) returns { cx, cy, r? } in pixels. When the
//     // shell auto-margins for a linearTrack motor, `place` may also be
//     // omitted — the shell defaults to (L.padLeft - r - 8, L.trackY).
//
//     // -------- declarative position rail (optional) --------
//     positionRail: { field?: "x", target?: "xTarget", targetLabel?: "target",
//                     posFmt?: (val, state, params) => string, yOffset?: 30 }
//
//     render:    (ctx, L, state, params) => void,
//     onPointer: (type, mx, my, L, state, params) => void,
//
//     // -------- header buttons --------
//     headerButtons: [{ id?, label, style?, onClick(state, params) }, …],
//
//     // -------- drag-controls overlay --------
//     // Optional declarative list of pointer affordances the lesson exposes.
//     // The shell paints them as a top-left HTML overlay inside the canvas
//     // box so students can see at a glance what they can grab. Each entry
//     // is { label, desc } — both plain strings.
//     dragControls: [
//       { label: "Load",  desc: "drag horizontally" },
//       { label: "Shaft", desc: "drag up/down to spin" },
//     ],
//
//     thermal: false,        // reserved
//
//     // -------- modes axis (folded inline into the spec header) --------
//     modes: {
//       default: "lead",
//       persistKey: "wholesys-mode",
//       list: [
//         { id: "lead", label: "lead-screw" },
//         { id: "ball", label: "ball-screw" },
//         { id: "conv", label: "conveyor"   },
//       ],
//       onChange: (state, newId, prevId) => {/* prep state for new mode */},
//     }
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
//     lib/util.js, lib/registry.js, lib/plot.js, lib/integrate.js  (required)
//     lib/canvas-type.js                                           (required)
//     lib/layout.js, lib/drag.js, lib/draw.js, …                   (lessons)
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Util)      throw new Error("LIB.App requires lib/util.js");
  if (!LIB.Registry)  throw new Error("LIB.App requires lib/registry.js");
  if (!LIB.Plot)      throw new Error("LIB.App requires lib/plot.js");
  if (!LIB.Integrate) throw new Error("LIB.App requires lib/integrate.js");
  if (!LIB.Type)      throw new Error("LIB.App requires lib/canvas-type.js");

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
    const raw = Array.isArray(sliders) ? [{ kind: "static", items: sliders.slice() }] : [];
    if (!Array.isArray(sliders)) {
      for (const k in sliders) {
        const v = sliders[k];
        if (Array.isArray(v)) {
          raw.push({ title: k, kind: "static", items: v.slice() });
        } else if (v && v.kind === "dynamic") {
          raw.push({ title: v.title || k, kind: "dynamic",
                     items: v.items, actions: v.actions || [],
                     span: v.span });
        } else if (Array.isArray(v && v.items)) {
          raw.push({ title: v.title || k, kind: "static", items: v.items.slice(),
                     actions: v.actions || [],
                     span: v.span });
        } else if (v && Array.isArray(v.actions)) {
          raw.push({ title: v.title || k, kind: "static", items: [],
                     actions: v.actions.slice(),
                     span: v.span });
        }
      }
    }
    // Hoist every span:"full" panel to the front, preserving relative order
    // among full and among non-full. Rule (6) in the request: target /
    // reference panels always sit at the top of the slider grid.
    const full = [], rest = [];
    for (const p of raw) (p.span === "full" ? full : rest).push(p);
    return full.concat(rest);
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

    // Modes axis is now folded inline into the spec header as a button
    // group, instead of a separate sub-tabs strip below. This collapses the
    // whole-system app from three identically-styled bars (outer ex-tabs,
    // spec header, modes strip) down to two visually distinct rows
    // (slim app-nav, primary spec header).
    const modesCfg = spec.modes && Array.isArray(spec.modes.list) && spec.modes.list.length
      ? spec.modes : null;
    const modesGroup = modesCfg ? el("div", { class: "modes" }) : null;

    const headerChildren = [headerH1];
    if (headerSub) headerChildren.push(headerSub);
    if (modesGroup) headerChildren.push(modesGroup);
    headerChildren.push(sp, btnReset, btnPause);

    const headerBtnEntries = Array.isArray(spec.headerButtons)
      ? spec.headerButtons.slice() : [];
    const headerBtnNodes = [];
    for (const entry of headerBtnEntries) {
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

    const stage    = el("div", { class: "stage" });
    lesson.appendChild(stage);

    const cvBox    = el("div", { class: "cv-box" });
    const cv       = el("canvas");
    cvBox.appendChild(cv);
    const ctx      = cv.getContext("2d");

    // Drag-controls overlay (rule (8) in the request). Built once from
    // spec.dragControls; static text so we don't rebuild per frame. Sits
    // top-left of the canvas box, pointer-events: none so it never steals
    // a drag gesture.
    if (Array.isArray(spec.dragControls) && spec.dragControls.length) {
      const dc = el("div", { class: "drag-controls" });
      dc.appendChild(el("h3", null, ["Drag controls"]));
      const ul = el("ul");
      for (const item of spec.dragControls) {
        const li = el("li");
        li.appendChild(el("b", null, [String(item.label || "")]));
        li.appendChild(el("span", null, [String(item.desc || "")]));
        ul.appendChild(li);
      }
      dc.appendChild(ul);
      cvBox.appendChild(dc);
    }

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
        if (entry.kind === "expr") {
          // Expression-input row: a text field + Advance button. Used by
          // stepper-driven lessons that need pi-aware angle entry. The
          // submit handler receives the evaluated number; the lesson is
          // free to apply it to whatever state field it wants.
          reg[entry.key] = Object.assign({}, entry);
          if (typeof LIB.Registry.mkExprRow === "function") {
            LIB.Registry.mkExprRow(box, reg, entry.key,
              entry.onSubmit ? (v) => entry.onSubmit(v, state) : null);
          }
        } else if (entry.disabled) {
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
      // Notes panel: insert immediately after the last span:full panel so
      // it reads as commentary on the target/reference, not as a
      // disconnected paragraph at the bottom of the column. If no
      // span:full panels are present, append at the end (legacy behaviour).
      if (spec.description) {
        let lastFull = -1;
        panels.forEach((p, i) => { if (p.span === "full") lastFull = i; });
        const box = el("div", { class: "box span-full" });
        box.appendChild(el("h2", null, ["Notes"]));
        box.appendChild(el("div", { class: "notes", html: spec.description }));
        if (lastFull >= 0 && lastFull + 1 < subPanels.children.length) {
          subPanels.insertBefore(box, subPanels.children[lastFull + 1]);
        } else {
          subPanels.appendChild(box);
        }
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
        return {
          canvas: c, ctx: c.getContext("2d"),
          config: cfg, hist: [], lastT: -Infinity,
          // Persistent axis bounds for chunked auto-scale. -Infinity sentinel
          // means "no expansion has happened yet — initialise from yFloor on
          // the first frame".
          yLo: -Infinity, yHi: -Infinity,
        };
      });
      plotsSig = plotsListSignature(list);
    }
    buildPlotPanes();

    // ---- modes group build (after panels exist) ----

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
      buildSliderPanels();
      buildPlotPanes();
      resetHistory();
    }
    if (modesCfg) {
      modeButtons = modesCfg.list.map(m => {
        const b = el("button", { type: "button" }, [m.label]);
        b.dataset.modeId = m.id;
        b.addEventListener("click", () => setActiveMode(m.id));
        modesGroup.appendChild(b);
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
    const getDof = (typeof phys.dof === "function")
      ? () => phys.dof(state)
      : (() => phys.dof || []);

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
      for (const pane of plotPanes) {
        pane.hist.length = 0;
        pane.lastT = -Infinity;
        pane.yLo = -Infinity;
        pane.yHi = -Infinity;
      }
    }

    // ---- render ----

    function fitCanvas(canvas, ctx2d) { return LIB.Util.fitCanvas(canvas, ctx2d); }

    // ---- motor margin auto-derivation for linearTrack layouts ----
    //
    // Whenever the spec declares a paint-able motor and the layout is a
    // linearTrack, the shell extends marginLeftPx by 2·r + 16 px so the
    // motor disc (cx = padLeft − r − 8) sits clear of the canvas edge. The
    // motor.place callback can read L.motorCx / L.motorCy if it doesn't
    // want to compute placement itself.
    //
    // For function-form spec.motor, we resolve per-frame because the motor
    // may be visible in some modes only (whole-system conv mode hides it).
    function resolveMotorCfg() {
      return (typeof spec.motor === "function")
        ? spec.motor(state, params) : spec.motor;
    }
    function motorRadius(cfg) {
      return (cfg && cfg.r != null) ? +cfg.r : 28;
    }

    let buildLayout = null;
    if (typeof spec.layout === "function") {
      buildLayout = (W, H) => spec.layout(W, H, state, params);
    } else if (spec.layout && spec.layout.kind) {
      const fac = LIB.Layout && LIB.Layout[spec.layout.kind];
      if (typeof fac !== "function") {
        throw new Error("LIB.App: unknown spec.layout.kind '" + spec.layout.kind + "'");
      }
      buildLayout = (W, H) => {
        const opts = Object.assign({}, spec.layout);
        if (spec.layout.kind === "linearTrack") {
          const cfg = resolveMotorCfg();
          if (cfg) {
            const r = motorRadius(cfg);
            const motorMargin = 2 * r + 16;
            opts.marginLeftPx = (+opts.marginLeftPx || 0) + motorMargin;
          }
        }
        const L = fac(W, H, opts);
        // Convenience: expose motor anchor on linearTrack so motor.place
        // doesn't need to compute it. Frozen layout objects can still take
        // numeric properties via plain assignment? No — they're frozen.
        // Wrap with a non-frozen view that carries the anchor.
        if (spec.layout.kind === "linearTrack") {
          const cfg = resolveMotorCfg();
          if (cfg) {
            const r = motorRadius(cfg);
            const wrap = Object.assign({}, L);
            wrap.motorCx = L.padLeft - r - 8;
            wrap.motorCy = L.trackY;
            wrap.motorR  = r;
            return wrap;
          }
        }
        return L;
      };
    } else if (spec.render || spec.onPointer || spec.motor || spec.positionRail) {
      throw new Error("LIB.App: spec.layout required when render/onPointer/motor/positionRail is set");
    }

    function paintMotor(L, cfg) {
      let place;
      if (typeof cfg.place === "function") {
        place = cfg.place(L, state, params);
      } else if (L.motorCx != null) {
        place = { cx: L.motorCx, cy: L.motorCy };
      }
      if (!place) return;
      const r = (place.r != null) ? +place.r : motorRadius(cfg);
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

    function updateTypeTokens(W, H) {
      // Single source of truth for canvas-text sizing. Compute once per
      // frame off the canvas dims (capped by viewport) and publish to:
      //   - LIB.Type.current — read by lib/draw.js and lib/plot.js as the
      //     default font size when callers don't pass an explicit override.
      //   - CSS custom properties on :root — read by .readout, slider rows,
      //     and the drag-controls overlay so HTML and canvas chrome scale
      //     together.
      const viewportMin = Math.min(window.innerWidth || Infinity,
                                   window.innerHeight || Infinity);
      const T = LIB.Type.scale({ W, H, viewportMin });
      LIB.Type.current = T;
      const root = document.documentElement;
      root.style.setProperty("--canvas-font-sm", T.sm + "px");
      root.style.setProperty("--canvas-font-md", T.md + "px");
      root.style.setProperty("--canvas-font-lg", T.lg + "px");
      return T;
    }

    function renderScene() {
      const layout = fitCanvas(cv, ctx);
      const T = updateTypeTokens(layout.w, layout.h);
      ctx.fillStyle = "#0d1013";
      ctx.fillRect(0, 0, layout.w, layout.h);
      if (!buildLayout) return;
      const L = buildLayout(layout.w, layout.h);
      // Expose the type tokens on the layout so lesson renderers can pull
      // sizes without going through LIB.Type directly.
      if (Object.isFrozen(L)) {
        // Layouts from LIB.Layout.* are frozen; expose a non-frozen wrapper.
        const wrap = Object.assign({}, L);
        wrap.type = T;
        renderWithLayout(wrap);
      } else {
        L.type = T;
        renderWithLayout(L);
      }
    }
    function renderWithLayout(L) {
      const motorCfg = resolveMotorCfg();
      if (motorCfg && motorCfg.z !== "above") paintMotor(L, motorCfg);
      if (typeof spec.render === "function") spec.render(ctx, L, state, params);
      if (motorCfg && motorCfg.z === "above") paintMotor(L, motorCfg);
      if (spec.positionRail) paintPositionRail(L);
    }

    function renderPlots() {
      const t = state.t || 0;
      const tMax = Math.max(t, histWindowS);
      const tMin = tMax - histWindowS;
      const T = LIB.Type.current;
      for (const pane of plotPanes) {
        const layout = fitCanvas(pane.canvas, pane.ctx);
        const W = layout.w, H = layout.h;
        pane.ctx.fillStyle = LIB.Util.getVar("--panel");
        pane.ctx.fillRect(0, 0, W, H);

        const winHist = pane.hist.filter(h => h.t >= tMin);
        const cfg = pane.config;
        let yLo, yHi;

        if (Number.isFinite(+cfg.yMin) && Number.isFinite(+cfg.yMax)) {
          // Locked axis — exact fixed bounds.
          yLo = +cfg.yMin; yHi = +cfg.yMax;
        } else {
          // Auto-scale: every frame, compute the data extrema across the
          // visible window and snap outward to yChunk boundaries (so the
          // axis breathes in clean increments instead of jittering on each
          // sample). yFloor caps how tight the axis can ever get, so the
          // pane is readable even when data is briefly small or zero.
          // Unlike the older "expand only" ratchet, the axis shrinks back
          // once a brief spike ages out of the window.
          const floor = cfg.yFloor;
          const chunk = +cfg.yChunk || 0;

          let oLo = +Infinity, oHi = -Infinity;
          for (const h of winHist) {
            for (const s of cfg.series) {
              const v = h[s.label];
              if (Number.isFinite(v)) {
                if (v < oLo) oLo = v;
                if (v > oHi) oHi = v;
              }
            }
          }
          if (!Number.isFinite(oLo) || !Number.isFinite(oHi)) {
            // No usable data yet — fall back to yFloor or a unit window.
            if (floor && Number.isFinite(+floor.lo) && Number.isFinite(+floor.hi)) {
              oLo = +floor.lo; oHi = +floor.hi;
            } else { oLo = -1; oHi = 1; }
          } else if (oHi - oLo < 1e-12) {
            // Degenerate window — pad symmetrically so /0 doesn't bite.
            const pad = chunk > 0 ? chunk : Math.max(Math.abs(oHi) * 0.1, 1e-9);
            oLo -= pad; oHi += pad;
          }

          if (chunk > 0) {
            pane.yLo = Math.floor(oLo / chunk) * chunk;
            pane.yHi = Math.ceil (oHi / chunk) * chunk;
            if (pane.yLo === pane.yHi) pane.yHi = pane.yLo + chunk;
          } else {
            pane.yLo = oLo;
            pane.yHi = oHi;
          }

          // yFloor enforcement: never tighter than the requested floor.
          if (floor) {
            if (Number.isFinite(+floor.lo) && pane.yLo > +floor.lo) pane.yLo = +floor.lo;
            if (Number.isFinite(+floor.hi) && pane.yHi < +floor.hi) pane.yHi = +floor.hi;
          }
          yLo = pane.yLo; yHi = pane.yHi;
        }

        LIB.Plot.drawGrid(pane.ctx, 0, 0, W, H, yLo, yHi, tMin, tMax,
                          cfg.title || "", T.plotTick,
                          { yFmt: cfg.yFmt,
                            titleFs: T.plotTitle,
                            tickFs:  T.plotTick });
        for (const s of cfg.series) {
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
      const L = buildLayout(r.width, r.height);
      // Layouts from LIB.Layout are frozen — wrap so pointer callbacks see
      // the same .type / .motorCx surface as render does.
      if (Object.isFrozen(L)) {
        const wrap = Object.assign({}, L);
        wrap.type = LIB.Type.current;
        spec.onPointer(type, mx, my, wrap, state, params);
      } else {
        L.type = LIB.Type.current;
        spec.onPointer(type, mx, my, L, state, params);
      }
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
        const list = plotsList();
        const sig = plotsListSignature(list);
        if (sig !== plotsSig) buildPlotPanes();
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

      // Outer .app-nav: topic title + Back/Next. Deliberate lesson selection
      // happens on the splash screen (the cards grid below); Back returns to
      // splash, Next advances to the following tab. Both buttons are hidden
      // while the splash is visible.
      const nav = el("nav", { class: "app-nav" });
      // Permanent "All apps" button — returns to the repo-root index. Visible
      // on every lesson hub regardless of whether splash or a lesson is
      // showing, so students always have a one-click path back to the top.
      const homeBtn = el("a",
        { class: "nav-btn home", href: (opts.homeHref || "../../index.html") },
        ["← All apps"]);
      const backBtn = el("button",
        { class: "nav-btn back", type: "button" },
        ["← All lessons"]);
      const nextBtn = el("button",
        { class: "nav-btn next", type: "button" },
        ["Next →"]);
      nav.appendChild(homeBtn);
      nav.appendChild(backBtn);
      nav.appendChild(nextBtn);
      nav.appendChild(el("span", { class: "sp" }));
      if (opts.title) {
        nav.appendChild(el("span", { class: "app-title" }, [opts.title]));
      }
      app.appendChild(nav);

      // Splash host (cards grid) and tab host (mounted lesson). Exactly one
      // is visible at a time.
      const splashHost = el("div", { class: "splash-host" });
      const tabHost = el("div", {
        class: "tab-host",
        style: { display: "none", flexDirection: "column", flex: "1", gap: "10px" },
      });
      app.appendChild(splashHost);
      app.appendChild(tabHost);

      let activeIdx = -1;
      let activeHandle = null;
      let splashCanvases = [];

      function paintCardIcon(canvas, spec) {
        const ctx = canvas.getContext("2d");
        const px = LIB.Util.fitCanvas(canvas, ctx);
        const W = px.w, H = px.h;
        ctx.fillStyle = "#0d1013";
        ctx.fillRect(0, 0, W, H);
        if (spec && typeof spec.icon === "function") {
          try { spec.icon(ctx, W, H); }
          catch (e) { console.warn("[runTabs] icon render failed", e); }
        }
      }

      function buildSplash() {
        splashHost.innerHTML = "";
        splashCanvases = [];
        const grid = el("div", { class: "card-grid" });
        tabs.forEach((tab, i) => {
          const card = el("button", { class: "card", type: "button" });
          const thumb = el("div", { class: "card-thumb" });
          const cv = document.createElement("canvas");
          thumb.appendChild(cv);
          const body = el("div", { class: "card-body" });
          body.appendChild(el("div", { class: "card-title" }, [tab.label]));
          if (tab.spec && tab.spec.subtitle) {
            body.appendChild(el("div", { class: "card-sub" }, [tab.spec.subtitle]));
          }
          card.appendChild(thumb);
          card.appendChild(body);
          grid.appendChild(card);
          card.addEventListener("click", () => activate(i));
          splashCanvases.push({ canvas: cv, spec: tab.spec });
        });
        splashHost.appendChild(grid);
        requestAnimationFrame(() => {
          splashCanvases.forEach(({ canvas, spec }) => paintCardIcon(canvas, spec));
        });
      }

      function showSplash() {
        if (activeHandle && typeof activeHandle.unmount === "function") {
          activeHandle.unmount();
        }
        activeHandle = null;
        activeIdx = -1;
        tabHost.style.display = "none";
        splashHost.style.display = "block";
        backBtn.style.display = "none";
        nextBtn.style.display = "none";
        buildSplash();
      }

      function activate(idx) {
        if (idx < 0 || idx >= tabs.length) return;
        if (activeHandle && typeof activeHandle.unmount === "function") {
          activeHandle.unmount();
        }
        splashHost.style.display = "none";
        splashHost.innerHTML = "";
        splashCanvases = [];
        tabHost.style.display = "flex";
        backBtn.style.display = "";
        nextBtn.style.display = "";
        nextBtn.disabled = (idx >= tabs.length - 1);
        activeIdx = idx;
        tabHost.innerHTML = "";
        const tab = tabs[idx];
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
      }

      backBtn.addEventListener("click", () => showSplash());
      nextBtn.addEventListener("click", () => {
        if (activeIdx >= 0 && activeIdx < tabs.length - 1) activate(activeIdx + 1);
      });

      // Repaint splash icons on viewport resize so they stay crisp at any
      // DPR. No-op while a lesson is mounted.
      let resizeRaf = 0;
      window.addEventListener("resize", () => {
        if (splashHost.style.display === "none") return;
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          splashCanvases.forEach(({ canvas, spec }) => paintCardIcon(canvas, spec));
        });
      });

      // Always open at the splash. Deliberate selection comes from there.
      showSplash();

      return {
        activate(labelOrIdx) {
          let idx = -1;
          if (typeof labelOrIdx === "number") idx = labelOrIdx;
          else idx = tabs.findIndex((t) => t.label === labelOrIdx);
          if (idx >= 0) activate(idx);
        },
        showSplash,
        get activeHandle() { return activeHandle; },
      };
    },
  };
})();
