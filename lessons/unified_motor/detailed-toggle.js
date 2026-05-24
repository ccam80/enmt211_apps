"use strict";

// =============================================================================
//  lessons/unified_motor/detailed-toggle.js
//
//  Phase-8 app-layer control: Live/Detailed header toggle + companion result panel.
//
//  Attaches window.UnifiedMotor.DetailedToggle. DOM-free at load — only defines
//  functions; touches no document/canvas/Worker at module-load.
//
//  The toggle spawns/terminates the Web Worker (the explicit Live↔Detailed
//  boundary — no per-frame switching). The panel renders the worker's streamed
//  frames (refined gap-field heatmap + torque/ω/θ readouts) and an on-demand
//  zero-current cogging sweep. The Live main-viewport keeps running, so Live and
//  Detailed are a deliberate side-by-side compare; no mount edit is needed.
//
//  Registration:
//    DetailedToggle.register(UM) is called at module load when the seams exist.
//    Under the headless Node shim the seams (registerHeaderControl / registerPanel)
//    are absent, so the call is a guarded no-op that still defines
//    UnifiedMotor.DetailedToggle on window.UnifiedMotor.
//
//  Machine-agnosticism: no machine name, element letter, or machine-type field
//  is read anywhere in this file. Pure helpers consume the agnostic expanded
//  config; browser callbacks receive ctx.config/ctx.runtime as-is.
// =============================================================================

(function () {
  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  // ---------------------------------------------------------------------------
  //  workerAvailable() → boolean
  //
  //  Cheap feature-detect. Returns false under the Node shim (no Worker global).
  //  The actual new Worker(...) in build is additionally wrapped in try/catch
  //  for the file:// block case.
  // ---------------------------------------------------------------------------
  function workerAvailable() {
    return typeof Worker === "function";
  }

  // ---------------------------------------------------------------------------
  //  thetaSweep(n, period = 2π) → Float64Array
  //
  //  Pure. Returns n cell-centre angles: θ_k = (k + 0.5) * period / n.
  // ---------------------------------------------------------------------------
  function thetaSweep(n, period) {
    if (period === undefined) period = 2 * Math.PI;
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      out[k] = (k + 0.5) * period / n;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  //  buildStartMessage(config, runtimeState, opts = {}) → message
  //
  //  Pure. Builds the { kind:"start", … } message for the worker.
  //  expanded = UnifiedMotor.ConfigSchema.expand(config).
  //  stateSeed.i is serialised to a plain number[] (structured-clone-safe).
  //  Defaults: backendOpts.factor:3, dt:1/240, stepsPerMessage:4.
  // ---------------------------------------------------------------------------
  function buildStartMessage(config, runtimeState, opts) {
    if (opts === undefined) opts = {};
    return {
      kind: "start",
      expanded: UM.ConfigSchema.expand(config),
      stateSeed: {
        theta:     runtimeState.theta,
        omega:     runtimeState.omega,
        t:         runtimeState.t,
        stepIndex: runtimeState.stepIndex,
        i:         Array.from(runtimeState.i),
      },
      backendOpts:     opts.backendOpts  !== undefined ? opts.backendOpts  : { factor: 3 },
      dt:              opts.dt           !== undefined ? opts.dt           : 1 / 240,
      stepsPerMessage: opts.stepsPerMessage !== undefined ? opts.stepsPerMessage : 4,
    };
  }

  // ---------------------------------------------------------------------------
  //  buildSweepMessage(config, currents, n = 180) → message
  //
  //  Pure. Builds the { kind:"sweep", … } message for a one-shot torque-vs-angle
  //  table over n uniformly-distributed cell-centre angles in [0, 2π).
  //  currents is converted to a plain number[] (structured-clone-safe).
  // ---------------------------------------------------------------------------
  function buildSweepMessage(config, currents, n) {
    if (n === undefined) n = 180;
    return {
      kind:     "sweep",
      expanded: UM.ConfigSchema.expand(config),
      currents: Array.from(currents),
      thetas:   Array.from(thetaSweep(n)),
    };
  }

  // ---------------------------------------------------------------------------
  //  applyFrame(target, frame) → void
  //
  //  Pure. Copies frame.state (theta/omega/t/stepIndex/i) and frame.torque
  //  (and frame.field if present) into the plain target object. Mutates in place.
  // ---------------------------------------------------------------------------
  function applyFrame(target, frame) {
    if (frame.state) {
      target.theta     = frame.state.theta;
      target.omega     = frame.state.omega;
      target.t         = frame.state.t;
      target.stepIndex = frame.state.stepIndex;
      target.i         = frame.state.i;
    }
    target.torque = frame.torque;
    if (frame.field !== undefined) {
      target.field = frame.field;
    }
  }

  // ---------------------------------------------------------------------------
  //  Browser-layer: build functions for the header control and result panel.
  //  These touch DOM / Worker / canvas and are exercised only in the browser
  //  (Task 8.3.1 browser verification).
  // ---------------------------------------------------------------------------

  // Shared render-state that the panel draws and the message pump writes.
  // Allocated here so both the header control and the panel close over the
  // same object; it is only read by the panel's rAF loop.
  UM._detailedView  = UM._detailedView  || {};
  UM._detailedTier  = UM._detailedTier  || "refined";

  // Internal reference to the running worker — the header control owns it.
  // Exposed on UM so the panel's "Saturation" checkbox can re-post a start
  // message via the same worker instance.
  UM._detailedWorker = UM._detailedWorker || null;
  UM._detailedActive = UM._detailedActive || false;

  // ---- Header control build -----------------------------------------------

  function buildHeaderControl(host, ctx) {
    const btn = document.createElement("button");
    btn.textContent = "Detailed: OFF";
    btn.title = "";
    btn.style.cssText = [
      "padding:3px 10px",
      "background:var(--panel2,#232932)",
      "color:var(--ink)",
      "border:1px solid var(--grid,#2a313c)",
      "border-radius:4px",
      "cursor:pointer",
    ].join(";");
    host.appendChild(btn);

    let worker = null;
    let active = false;

    function startWorker() {
      if (!workerAvailable()) {
        btn.disabled = true;
        btn.title = "Detailed mode needs http(s):// — serve the app";
        return;
      }
      try {
        worker = new Worker("../../lib/airgap-worker.js");
      } catch (e) {
        btn.disabled = true;
        btn.title = "Detailed mode needs http(s):// — serve the app";
        return;
      }

      UM._detailedWorker = worker;
      UM._detailedActive = true;

      worker.onmessage = function (e) {
        applyFrame(UM._detailedView, e.data);
      };

      const tier = UM._detailedTier || "refined";
      worker.postMessage(buildStartMessage(ctx.config, ctx.runtime.state, {
        backendOpts: { factor: 3, tier: tier },
      }));
    }

    function stopWorker() {
      if (worker) {
        worker.postMessage({ kind: "stop" });
        worker.terminate();
        worker = null;
      }
      UM._detailedWorker = null;
      UM._detailedActive = false;
    }

    btn.addEventListener("click", function () {
      if (!active) {
        active = true;
        btn.textContent = "Detailed: ON";
        startWorker();
      } else {
        active = false;
        btn.textContent = "Detailed: OFF";
        stopWorker();
      }
    });

    function unmount() {
      stopWorker();
      host.removeChild(btn);
    }

    return unmount;
  }

  // ---- Result panel build --------------------------------------------------

  function buildResultPanel(host, ctx) {
    const panel = document.createElement("div");
    panel.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "gap:6px",
      "padding:8px",
      "background:var(--panel,#1b1f25)",
      "border-radius:4px",
      "min-width:0",
      "overflow:hidden",
    ].join(";");

    // Title row
    const titleRow = document.createElement("div");
    titleRow.style.cssText = "font-weight:600;font-size:12px;color:var(--muted,#8a93a3);";
    titleRow.textContent = "Detailed (worker)";
    panel.appendChild(titleRow);

    // Gap-field heatmap canvas
    const fieldCanvas = document.createElement("canvas");
    fieldCanvas.style.cssText = [
      "width:100%",
      "height:120px",
      "background:var(--panel,#1b1f25)",
      "border-radius:4px",
      "display:block",
    ].join(";");
    panel.appendChild(fieldCanvas);

    // Readout column
    const readouts = document.createElement("div");
    readouts.style.cssText = "font-size:12px;display:flex;flex-direction:column;gap:2px;";

    function makeRow(label) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;gap:4px;";
      const lbl = document.createElement("span");
      lbl.style.color = "var(--muted,#8a93a3)";
      lbl.textContent = label;
      const val = document.createElement("span");
      val.style.fontVariantNumeric = "tabular-nums";
      val.textContent = "—";
      row.append(lbl, val);
      readouts.appendChild(row);
      return val;
    }

    const rdTorque = makeRow("τ (Nm)");
    const rdOmega  = makeRow("ω (rad/s)");
    const rdTheta  = makeRow("θ (rad)");
    panel.appendChild(readouts);

    // Cogging sweep button
    const btnSweep = document.createElement("button");
    btnSweep.textContent = "Cogging sweep";
    btnSweep.style.cssText = [
      "padding:3px 8px",
      "background:var(--panel2,#232932)",
      "color:var(--ink)",
      "border:1px solid var(--grid,#2a313c)",
      "border-radius:4px",
      "cursor:pointer",
      "font-size:12px",
    ].join(";");
    panel.appendChild(btnSweep);

    // Cogging sweep plot canvas
    const sweepCanvas = document.createElement("canvas");
    sweepCanvas.style.cssText = [
      "width:100%",
      "height:80px",
      "background:var(--panel,#1b1f25)",
      "border-radius:4px",
      "display:block",
    ].join(";");
    panel.appendChild(sweepCanvas);

    // Saturation (nonlinear) checkbox
    const satRow = document.createElement("div");
    satRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;";
    const satCheck = document.createElement("input");
    satCheck.type = "checkbox";
    satCheck.checked = false;
    const satLabel = document.createElement("label");
    satLabel.textContent = "Saturation (nonlinear)";
    satRow.append(satCheck, satLabel);
    panel.appendChild(satRow);

    satCheck.addEventListener("change", function () {
      UM._detailedTier = satCheck.checked ? "nonlinear" : "refined";
      // Re-post start if the worker is active so it switches tiers from current state
      if (UM._detailedActive && UM._detailedWorker) {
        UM._detailedWorker.postMessage(buildStartMessage(ctx.config, ctx.runtime.state, {
          backendOpts: { factor: 3, tier: UM._detailedTier },
        }));
      }
    });

    host.appendChild(panel);

    // Cogging sweep handler — uses a temporary disposable worker
    let sweepData = null;

    btnSweep.addEventListener("click", function () {
      if (!workerAvailable()) return;
      let sw;
      try {
        sw = new Worker("../../lib/airgap-worker.js");
      } catch (e) {
        return;
      }
      const zeros = new Float64Array(ctx.runtime.state.i.length);
      sw.postMessage(buildSweepMessage(ctx.config, zeros, 180));
      sw.onmessage = function (e) {
        if (e.data.kind === "sweepResult") {
          sweepData = e.data;
          sw.terminate();
          drawSweepPlot();
        }
      };
    });

    // rAF draw loop
    let rafId = null;

    function fitCanvas(canvas) {
      const dpr = window.devicePixelRatio || 1;
      const W   = canvas.clientWidth;
      const H   = canvas.clientHeight;
      if (canvas.width  !== Math.round(W * dpr) ||
          canvas.height !== Math.round(H * dpr)) {
        canvas.width  = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        const c = canvas.getContext("2d");
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      return { W, H };
    }

    function drawFieldCanvas() {
      const { W, H } = fitCanvas(fieldCanvas);
      if (W <= 0 || H <= 0) return;
      const c = fieldCanvas.getContext("2d");
      c.clearRect(0, 0, W, H);
      c.fillStyle = "#0d1013";
      c.fillRect(0, 0, W, H);

      const dv = UM._detailedView;
      if (!dv || !dv.field) {
        c.fillStyle = "var(--muted,#8a93a3)";
        c.font = "11px ui-sans-serif";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText("Detailed field (worker)", W / 2, H / 2);
        return;
      }

      const field = dv.field;
      const grid  = field.grid;

      // Draw via LIB.FieldRender if available (3D-aware variant)
      if (typeof LIB !== "undefined" && LIB.FieldRender && LIB.FieldRender.drawGapField) {
        const geom = {
          Nr:     grid.Nr,
          Ntheta: grid.Ntheta,
          r:      grid.r,
          rInner: grid.rInner,
          rOuter: grid.rOuter,
          planeZ: 0,
        };
        const L3 = typeof LIB.Layout3D !== "undefined"
          ? LIB.Layout3D.orbital(W, H, { yaw: 0, pitch: 0, dist: 0.25, fov: Math.PI / 4 })
          : null;
        if (L3) {
          LIB.FieldRender.drawGapField(c, L3, field, geom, { alpha: 0.85, vectors: false });
          return;
        }
      }

      // Fallback 2D flat heatmap
      const Nr     = grid.Nr;
      const Ntheta = grid.Ntheta;
      const rOuter = grid.rOuter;
      const rInner = grid.rInner;
      const pad    = 8;
      const scale  = Math.min((W - 2 * pad) / (2 * rOuter), (H - 2 * pad) / (2 * rOuter));
      const cx     = W / 2;
      const cy     = H / 2;
      const Br     = field.Br;
      const Bt     = field.Bt;
      const dTheta = 2 * Math.PI / Ntheta;
      const r      = grid.r || (() => {
        const ra = new Float64Array(Nr);
        const dr = (rOuter - rInner) / Nr;
        for (let i = 0; i < Nr; i++) ra[i] = rInner + (i + 0.5) * dr;
        return ra;
      })();
      const rLo = new Float64Array(Nr);
      const rHi = new Float64Array(Nr);
      for (let i = 0; i < Nr; i++) {
        rLo[i] = (i === 0)      ? rInner : 0.5 * (r[i - 1] + r[i]);
        rHi[i] = (i === Nr - 1) ? rOuter : 0.5 * (r[i] + r[i + 1]);
      }

      let maxB = 0;
      for (let k = 0; k < Nr * Ntheta; k++) {
        const bm = Math.sqrt(Br[k] * Br[k] + Bt[k] * Bt[k]);
        if (bm > maxB) maxB = bm;
      }
      if (!fieldCanvas._magScale || fieldCanvas._magScale < maxB) {
        fieldCanvas._magScale = maxB > 0 ? maxB : 1;
      } else {
        fieldCanvas._magScale = fieldCanvas._magScale * 0.98 + maxB * 0.02;
      }
      const magScale = fieldCanvas._magScale > 0 ? fieldCanvas._magScale : 1;

      c.save();
      c.globalAlpha = 0.85;
      for (let i = 0; i < Nr; i++) {
        const r0 = rLo[i] * scale;
        const r1 = rHi[i] * scale;
        for (let j = 0; j < Ntheta; j++) {
          const idx  = i * Ntheta + j;
          const bMag = Math.sqrt(Br[idx] * Br[idx] + Bt[idx] * Bt[idx]);
          const t    = Math.max(0, Math.min(1, bMag / magScale));
          const thLo = j * dTheta;
          const thHi = (j + 1) * dTheta;
          c.fillStyle = LIB.Util.lerpColor("#0d1013", "#ffd54a", t);
          c.beginPath();
          c.moveTo(cx + r0 * Math.cos(thLo), cy - r0 * Math.sin(thLo));
          c.lineTo(cx + r1 * Math.cos(thLo), cy - r1 * Math.sin(thLo));
          c.lineTo(cx + r1 * Math.cos(thHi), cy - r1 * Math.sin(thHi));
          c.lineTo(cx + r0 * Math.cos(thHi), cy - r0 * Math.sin(thHi));
          c.closePath();
          c.fill();
        }
      }
      c.restore();
    }

    function drawSweepPlot() {
      const { W, H } = fitCanvas(sweepCanvas);
      if (W <= 0 || H <= 0 || !sweepData) return;
      const c = sweepCanvas.getContext("2d");
      c.clearRect(0, 0, W, H);
      c.fillStyle = "#0d1013";
      c.fillRect(0, 0, W, H);

      const torques = sweepData.torques;
      const thetas  = sweepData.thetas;
      if (!torques || torques.length === 0) return;

      const tMin = thetas[0];
      const tMax = thetas[thetas.length - 1];
      const yArr = torques.filter(Number.isFinite);
      let yMin   = Math.min(...yArr);
      let yMax   = Math.max(...yArr);
      if (yMax - yMin < 1e-12) { yMin -= 1e-9; yMax += 1e-9; }
      const pad = (yMax - yMin) * 0.12;
      yMin -= pad; yMax += pad;

      if (LIB && LIB.Plot) {
        const pts = thetas.map((th, k) => ({ t: th, y: torques[k] }));
        LIB.Plot.drawGrid(c, 0, 0, W, H, yMin, yMax, tMin, tMax, "τ_cog (Nm)", 11);
        LIB.Plot.drawLine(c, 0, 0, W, H, yMin, yMax, tMin, tMax, pts, "#4ea1ff", 1.5);
      }
    }

    function drawFrame() {
      rafId = requestAnimationFrame(drawFrame);

      drawFieldCanvas();

      const dv = UM._detailedView;
      if (dv) {
        rdTorque.textContent = Number.isFinite(dv.torque) ? dv.torque.toExponential(3) : "—";
        rdOmega.textContent  = Number.isFinite(dv.omega)  ? dv.omega.toFixed(3)         : "—";
        rdTheta.textContent  = Number.isFinite(dv.theta)  ? dv.theta.toFixed(3)         : "—";
      }

      drawSweepPlot();
    }

    rafId = requestAnimationFrame(drawFrame);

    function unmount() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (host.contains(panel)) host.removeChild(panel);
    }

    return unmount;
  }

  // ---------------------------------------------------------------------------
  //  register(UM) → void
  //
  //  Guarded: when UM.registerHeaderControl exists, registers the Live/Detailed
  //  toggle; when UM.registerPanel exists, registers the result panel.
  //  Under the headless shim the seams are absent — this is a no-op that still
  //  defines UnifiedMotor.DetailedToggle.
  // ---------------------------------------------------------------------------
  function register(umRef) {
    if (umRef.registerHeaderControl) {
      umRef.registerHeaderControl({
        id: "detailed-toggle",
        build: buildHeaderControl,
      });
    }

    if (umRef.registerPanel) {
      umRef.registerPanel({
        id:    "detailed-view",
        title: "Detailed (worker)",
        zone:  "side",
        build: buildResultPanel,
      });
    }
  }

  // ---------------------------------------------------------------------------
  //  Attach to UnifiedMotor namespace
  // ---------------------------------------------------------------------------
  UM.DetailedToggle = {
    workerAvailable,
    thetaSweep,
    buildStartMessage,
    buildSweepMessage,
    applyFrame,
    register,
  };

  // Invoke registration at module load if the seams are present
  register(UM);

})();
