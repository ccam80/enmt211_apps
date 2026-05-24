(function () {
  "use strict";

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  const TWO_PI = 2 * Math.PI;

  // ---------------------------------------------------------------------------
  //  windingFunction(routing, opts = {}) → { theta, n }
  //
  //  Pure. Computes the winding function F(θ) for each circuit as a
  //  mean-subtracted cumulative sum of per-slot ampere-conductors swept
  //  around [0, 2π). Returns theta (sample angles) and n (one Float64Array
  //  per circuit, all mean-zero).
  // ---------------------------------------------------------------------------
  function windingFunction(routing, opts) {
    opts = opts || {};
    const nSamples = (opts.nSamples != null) ? opts.nSamples : 720;
    const ac = LIB.WindingModel.ampereConductors(routing);
    const nSlots = ac.nSlots;
    const nCircuits = ac.nCircuits;

    // Sample angles: midpoints of uniform bins around [0, 2π)
    const theta = new Float64Array(nSamples);
    for (let k = 0; k < nSamples; k++) {
      theta[k] = (k + 0.5) * TWO_PI / nSamples;
    }

    const n = [];
    for (let c = 0; c < nCircuits; c++) {
      const nk = new Float64Array(nSamples);

      // For each sample angle, accumulate all slots whose angle <= sample angle
      // (wrapping: winding function is cumulative sum going CCW).
      // We build it as a step function: at each sample k, sum all conductors
      // at slots with slotTheta[s] <= theta[k] (mod 2π, CCW ordering).
      //
      // Classical approach: sort slots by angle, then for each sample bin
      // accumulate conductors whose slot angle falls in [0, theta[k]].
      // The winding function is the running cumulative MMF as we sweep θ from 0.

      // Build sorted list of (slotAngle, turns) pairs for circuit c
      const slotPairs = [];
      for (let s = 0; s < nSlots; s++) {
        const T = ac.turns[c * nSlots + s];
        // Normalize angle to [0, 2π)
        let ang = routing.slotTheta[s] % TWO_PI;
        if (ang < 0) ang += TWO_PI;
        slotPairs.push({ ang, T });
      }
      // Sort by angle ascending
      slotPairs.sort(function (a, b) { return a.ang - b.ang; });

      // For each sample k, n[k] = sum of T for all slots where ang <= theta[k]
      // This is the one-sided cumulative sum (standard winding function definition).
      let cumSum = 0;
      let si = 0;
      for (let k = 0; k < nSamples; k++) {
        const th = theta[k];
        while (si < slotPairs.length && slotPairs[si].ang <= th) {
          cumSum += slotPairs[si].T;
          si++;
        }
        nk[k] = cumSum;
      }

      // Mean-subtract so Σ F(θ) = 0 over the period
      let sum = 0;
      for (let k = 0; k < nSamples; k++) sum += nk[k];
      const mean = sum / nSamples;
      for (let k = 0; k < nSamples; k++) nk[k] -= mean;

      n.push(nk);
    }

    return { theta, n };
  }

  // ---------------------------------------------------------------------------
  //  spatialSpectrum(nk, maxHarmonic = 24) → { harmonics, amps }
  //
  //  Pure. Discrete-Fourier magnitude of the single winding function array nk
  //  at integer spatial-harmonic orders 1..maxHarmonic.
  //  amps[h-1] = (2/N) · |Σ_k nk[k] · exp(-j·h·θ_k)|
  // ---------------------------------------------------------------------------
  function spatialSpectrum(nk, maxHarmonic) {
    if (maxHarmonic == null) maxHarmonic = 24;
    const N = nk.length;
    const harmonics = [];
    const amps = [];

    for (let h = 1; h <= maxHarmonic; h++) {
      let re = 0, im = 0;
      for (let k = 0; k < N; k++) {
        // Use midpoint sample angles consistent with windingFunction
        const th = (k + 0.5) * TWO_PI / N;
        re += nk[k] * Math.cos(h * th);
        im += nk[k] * Math.sin(h * th);
      }
      harmonics.push(h);
      amps.push((2 / N) * Math.hypot(re, im));
    }

    return { harmonics, amps };
  }

  // ---------------------------------------------------------------------------
  //  poleCount(routing) → int
  //
  //  Pure. Sums spatialSpectrum amps across all circuits; returns 2·h* where
  //  h* is the harmonic order with the largest total amplitude.
  // ---------------------------------------------------------------------------
  function poleCount(routing) {
    const { theta, n } = windingFunction(routing);
    // Sum amps across all circuits
    let summedAmps = null;
    for (let c = 0; c < n.length; c++) {
      const { amps } = spatialSpectrum(n[c]);
      if (summedAmps === null) {
        summedAmps = amps.slice();
      } else {
        for (let i = 0; i < amps.length; i++) summedAmps[i] += amps[i];
      }
    }
    if (!summedAmps) return 2;

    // Find dominant harmonic order (1-indexed)
    let maxAmp = -Infinity;
    let hStar = 1;
    for (let i = 0; i < summedAmps.length; i++) {
      if (summedAmps[i] > maxAmp) {
        maxAmp = summedAmps[i];
        hStar = i + 1;
      }
    }
    return 2 * hStar;
  }

  // ---------------------------------------------------------------------------
  //  windingFactor(routing, poleHarmonic) → number
  //
  //  Pure. The winding factor kw for poleHarmonic of circuit 0.
  //  kw = A_h / (4·T_total / (π·h))
  //  where A_h is the DFT amplitude at harmonic h of the winding function F(θ),
  //  and T_total is the rectangular-MMF peak = (1/4) · Σ_s |ac.turns[0·nSlots + s]|.
  //
  //  Derivation: F(θ) after mean-subtraction has peak = Σ|ac|/4 (since each coil
  //  adds +T to the go-slot column and -T to the return-slot column, so Σ|ac|=4·peak
  //  for the step-function MMF of a full-pitch coil). The rectangular-MMF
  //  fundamental at harmonic h is (4/π)·peak/h = (4/π)·T_total/h. A full-pitch
  //  single-coil winding thereby returns kw = 1 exactly.
  // ---------------------------------------------------------------------------
  function windingFactor(routing, poleHarmonic) {
    const ac = LIB.WindingModel.ampereConductors(routing);
    const nSlots = ac.nSlots;

    // T_total: peak of the rectangular MMF = Σ|ac.turns[c=0]| / 4
    let absSum = 0;
    for (let s = 0; s < nSlots; s++) {
      absSum += Math.abs(ac.turns[0 * nSlots + s]);
    }
    const T_total = absSum / 4;

    // DFT amplitude at poleHarmonic for circuit 0's winding function
    const { n } = windingFunction(routing);
    const { amps } = spatialSpectrum(n[0]);
    const A_h = amps[poleHarmonic - 1];

    // Analytic normalizer: rectangular-MMF fundamental = 4·T_total / (π·h)
    const normalizer = (4 * T_total) / (Math.PI * poleHarmonic);
    if (normalizer === 0) return 0;
    return A_h / normalizer;
  }

  // ---------------------------------------------------------------------------
  //  resolveWinding(ring) → routing | null
  //
  //  Resolves ring.winding to a plain routing, supporting both the explicit
  //  routing form and the { standard: { m,p,Q,coilPitch,turns } } shorthand.
  // ---------------------------------------------------------------------------
  function resolveWinding(ring) {
    const w = ring.winding;
    if (!w) return null;
    if (w.standard) {
      return LIB.WindingModel.standardWinding(w.standard);
    }
    return w;
  }

  // ---------------------------------------------------------------------------
  //  buildRoutingFromEdits(ring, edits, nSlots, slotTheta) → routing
  //
  //  Builds a new routing object from a list of editor coil edits for the ring.
  //  edits: Array<{ slotGo, slotReturn, turns, circuit? }>
  //  For distributed (W) rings: circuit is determined by the phase the coil
  //  belongs to (editor assigns new coils to the active circuit / phase).
  // ---------------------------------------------------------------------------
  function buildRoutingFromEdits(edits, nSlots, slotTheta) {
    // Gather distinct circuit indices used
    const circuitSet = new Set();
    for (const e of edits) {
      circuitSet.add(e.circuit != null ? e.circuit : 0);
    }
    const circuits = Array.from(circuitSet).sort(function (a, b) { return a - b; });

    const phases = circuits.map(function (cIdx) {
      const coils = edits
        .filter(function (e) { return (e.circuit != null ? e.circuit : 0) === cIdx; })
        .map(function (e) { return { slotGo: e.slotGo, slotReturn: e.slotReturn, turns: e.turns }; });
      return {
        id: String.fromCharCode(65 + cIdx),
        branches: [{ coils }],
      };
    });

    return { nSlots, slotTheta, phases };
  }

  // ---------------------------------------------------------------------------
  //  register(UM) — registers the winding-editor panel.
  //  Guarded: only runs when UM.registerPanel exists.
  // ---------------------------------------------------------------------------
  function register(UM_arg) {
    const target = UM_arg || UM;
    if (!target.registerPanel) return;
    target.registerPanel({
      id: "winding-editor",
      title: "Winding",
      zone: "side",
      build: function (host, ctx) {
        return buildPanel(host, ctx, target);
      },
    });
  }

  // ---------------------------------------------------------------------------
  //  buildPanel(host, ctx, UM_ref) → unmountFn
  //
  //  Browser-only panel builder. Creates:
  //  - A ring-selector list (one entry per wound ring in config.rings)
  //  - A cross-section canvas drawn via CrossSectionRender.drawSemantic
  //    (+ drawCompiledOverlay when UM._xsecOverlay is set)
  //  - An F(θ) mini-plot canvas
  //  - Pole-count and back-EMF-shape readouts
  //
  //  Pointer handling:
  //  - W ring: pointerdown → go-slot; pointerup on different slot → route coil
  //  - C ring: pointerdown on tooth → add/toggle coil (wrap direction)
  //
  //  On pointer-release: writes new routing to config.rings[activeRing].winding
  //  and calls ctx.requestRebuild().
  // ---------------------------------------------------------------------------
  function buildPanel(host, ctx, UM_ref) {
    const config = ctx.config;

    // Find all wound rings (W, C, K)
    function getWoundRings() {
      const result = [];
      for (let i = 0; i < config.rings.length; i++) {
        const el = config.rings[i].element;
        if (el === "W" || el === "C" || el === "K") result.push(i);
      }
      return result;
    }

    let woundRings = getWoundRings();
    let activeRing = woundRings.length > 0 ? woundRings[0] : 0;
    let gesturGoSlot = null; // For W-ring distributed gesture
    let gestureActive = false;
    let editorEdits = []; // Current coil list for the active ring
    let activeCircuit = 0;
    let rafId = null;

    // Load existing edits from the current winding
    function loadEditsFromRing(ringIdx) {
      const ring = config.rings[ringIdx];
      const routing = resolveWinding(ring);
      editorEdits = [];
      if (routing) {
        const ac = LIB.WindingModel.ampereConductors(routing);
        for (let c = 0; c < ac.nCircuits; c++) {
          for (let s = 0; s < ac.nSlots; s++) {
            const T = ac.turns[c * ac.nSlots + s];
            if (T > 0) {
              // Find return slot with matching negative value
              for (let sr = 0; sr < ac.nSlots; sr++) {
                if (Math.abs(ac.turns[c * ac.nSlots + sr] + T) < 1e-9) {
                  editorEdits.push({ circuit: c, slotGo: s, slotReturn: sr, turns: T });
                }
              }
            }
          }
        }
      }
    }
    loadEditsFromRing(activeRing);

    // ---- DOM structure ----
    host.style.display = "flex";
    host.style.flexDirection = "column";
    host.style.gap = "6px";
    host.style.padding = "6px";
    host.style.boxSizing = "border-box";
    host.style.height = "100%";

    // Ring selector
    const selectorDiv = document.createElement("div");
    selectorDiv.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
    host.appendChild(selectorDiv);

    function buildRingSelector() {
      selectorDiv.innerHTML = "";
      woundRings = getWoundRings();
      for (const ri of woundRings) {
        const ring = config.rings[ri];
        const btn = document.createElement("button");
        btn.textContent = (ring.member.charAt(0).toUpperCase() + ring.member.slice(1)) + " " + ring.element;
        btn.style.cssText = "padding:2px 6px;cursor:pointer;font-size:0.8em;" +
          (ri === activeRing ? "font-weight:bold;outline:2px solid var(--accent,#4ea1ff);" : "");
        btn.addEventListener("click", function () {
          activeRing = ri;
          loadEditsFromRing(activeRing);
          buildRingSelector();
          scheduleRender();
        });
        selectorDiv.appendChild(btn);
      }

      // Circuit selector
      const ring = config.rings[activeRing];
      const routing = resolveWinding(ring);
      let nCircuits = 1;
      if (routing) nCircuits = LIB.WindingModel.ampereConductors(routing).nCircuits;
      for (let c = 0; c < nCircuits; c++) {
        const cBtn = document.createElement("button");
        cBtn.textContent = "C" + c;
        cBtn.style.cssText = "padding:2px 4px;cursor:pointer;font-size:0.75em;margin-left:4px;" +
          (c === activeCircuit ? "font-weight:bold;text-decoration:underline;" : "");
        const cc = c;
        cBtn.addEventListener("click", function () { activeCircuit = cc; buildRingSelector(); });
        selectorDiv.appendChild(cBtn);
      }
    }
    buildRingSelector();

    // Cross-section canvas
    const xsecCanvas = document.createElement("canvas");
    xsecCanvas.style.cssText = "width:100%;flex:1 1 auto;cursor:crosshair;touch-action:none;";
    host.appendChild(xsecCanvas);

    // F(θ) plot canvas
    const plotCanvas = document.createElement("canvas");
    plotCanvas.style.cssText = "width:100%;height:80px;";
    host.appendChild(plotCanvas);

    // Readouts
    const readoutDiv = document.createElement("div");
    readoutDiv.style.cssText = "font-size:0.8em;display:flex;gap:8px;flex-wrap:wrap;";
    host.appendChild(readoutDiv);
    const poleReadout = document.createElement("span");
    const kwReadout = document.createElement("span");
    readoutDiv.appendChild(poleReadout);
    readoutDiv.appendChild(kwReadout);

    // ---- DPR-aware canvas resize ----
    function resizeCanvas(canvas) {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        return true;
      }
      return false;
    }

    // ---- Routing from current edits ----
    function currentRouting() {
      const ring = config.rings[activeRing];
      const baseRouting = resolveWinding(ring);
      if (!baseRouting && editorEdits.length === 0) return null;

      // Determine nSlots and slotTheta from ring or base routing
      let nSlots, slotTheta;
      if (baseRouting) {
        nSlots = baseRouting.nSlots;
        slotTheta = baseRouting.slotTheta;
      } else {
        nSlots = 6;
        slotTheta = [];
        for (let s = 0; s < nSlots; s++) slotTheta.push(s * TWO_PI / nSlots);
      }

      if (editorEdits.length === 0) return baseRouting;
      return buildRoutingFromEdits(editorEdits, nSlots, slotTheta);
    }

    // ---- Slot hit test ----
    function slotAtPoint(mx, my, layout, routing) {
      if (!routing) return -1;
      const nSlots = routing.nSlots;
      let bestSlot = -1;
      let bestDist = Infinity;
      const r0 = config.rings[activeRing].rRange[0];
      const r1 = config.rings[activeRing].rRange[1];
      const rMid = (r0 + r1) / 2;
      for (let s = 0; s < nSlots; s++) {
        const pt = layout.polar(rMid, routing.slotTheta[s]);
        const dx = mx - pt.px;
        const dy = my - pt.py;
        const d = Math.hypot(dx, dy);
        if (d < bestDist) { bestDist = d; bestSlot = s; }
      }
      return bestSlot;
    }

    // ---- Tooth hit test (C rings) ----
    function toothAtPoint(mx, my, layout, geom) {
      const ring = geom.rings[activeRing];
      if (!ring || ring.teeth.length === 0) return -1;
      const r0 = config.rings[activeRing].rRange[0];
      const r1 = config.rings[activeRing].rRange[1];
      const rMid = (r0 + r1) / 2;
      let bestTooth = -1;
      let bestDist = Infinity;
      for (let t = 0; t < ring.teeth.length; t++) {
        const tooth = ring.teeth[t];
        const pt = layout.polar(rMid, tooth.thetaCenter);
        const dx = mx - pt.px;
        const dy = my - pt.py;
        const d = Math.hypot(dx, dy);
        if (d < bestDist) { bestDist = d; bestTooth = t; }
      }
      return bestTooth;
    }

    // ---- Render ----
    let pendingRender = false;
    function scheduleRender() {
      if (!pendingRender) {
        pendingRender = true;
        rafId = requestAnimationFrame(doRender);
      }
    }

    function doRender() {
      pendingRender = false;
      renderXsec();
      renderPlot();
      updateReadouts();
    }

    function renderXsec() {
      resizeCanvas(xsecCanvas);
      const ctx2d = xsecCanvas.getContext("2d");
      const W = xsecCanvas.width;
      const H = xsecCanvas.height;
      ctx2d.clearRect(0, 0, W, H);

      const CSR = UM_ref.CrossSectionRender;
      if (!CSR) return;

      const geom = CSR.buildGeometry(config);
      const layout = LIB.Layout.rotational(W, H, { worldR: geom.rOuter, padPx: 12 });

      // Highlight go-slot during gesture
      const highlightSlots = gesturGoSlot !== null ? [gesturGoSlot] : [];

      CSR.drawSemantic(ctx2d, layout, geom, {
        highlightRing: activeRing,
        highlightSlots,
        palette: null,
      });

      if (UM_ref._xsecOverlay) {
        try {
          const { compiled, grid } = CSR.compileForOverlay(config);
          CSR.drawCompiledOverlay(ctx2d, layout, compiled, grid, {});
        } catch (e) {
          // Overlay unavailable during gesture — skip silently
        }
      }
    }

    function renderPlot() {
      resizeCanvas(plotCanvas);
      const ctx2d = plotCanvas.getContext("2d");
      const W = plotCanvas.width;
      const H = plotCanvas.height;
      ctx2d.clearRect(0, 0, W, H);

      const routing = currentRouting();
      if (!routing) return;

      let wf;
      try {
        wf = windingFunction(routing, { nSamples: 360 });
      } catch (e) {
        return;
      }

      if (!wf.n.length) return;

      // Draw each circuit's winding function
      const colors = ["#4ea1ff", "#ef5350", "#66bb6a", "#ffd54a", "#ab47bc", "#26c6da", "#ff8a65", "#d4e157"];
      const padL = 8, padR = 8, padT = 4, padB = 4;
      const pW = W - padL - padR;
      const pH = H - padT - padB;

      // Compute global y range across all circuits
      let yMin = Infinity, yMax = -Infinity;
      for (const nk of wf.n) {
        for (let k = 0; k < nk.length; k++) {
          if (nk[k] < yMin) yMin = nk[k];
          if (nk[k] > yMax) yMax = nk[k];
        }
      }
      if (yMax === yMin) { yMin -= 1; yMax += 1; }

      // Zero line
      const yZero = padT + pH * (1 - (-yMin) / (yMax - yMin));
      ctx2d.beginPath();
      ctx2d.moveTo(padL, yZero);
      ctx2d.lineTo(padL + pW, yZero);
      ctx2d.strokeStyle = "rgba(150,150,150,0.4)";
      ctx2d.lineWidth = 0.5;
      ctx2d.stroke();

      for (let c = 0; c < wf.n.length; c++) {
        const nk = wf.n[c];
        const color = colors[c % colors.length];
        ctx2d.beginPath();
        for (let k = 0; k < nk.length; k++) {
          const x = padL + (k / nk.length) * pW;
          const y = padT + pH * (1 - (nk[k] - yMin) / (yMax - yMin));
          if (k === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
        }
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 1.5;
        ctx2d.stroke();
      }

      // Label
      ctx2d.fillStyle = "rgba(200,200,200,0.7)";
      ctx2d.font = "10px sans-serif";
      ctx2d.fillText("F(θ)", padL + 2, padT + 10);
    }

    function updateReadouts() {
      const routing = currentRouting();
      if (!routing) {
        poleReadout.textContent = "Poles: —";
        kwReadout.textContent = "kw: —";
        return;
      }
      try {
        const pc = poleCount(routing);
        poleReadout.textContent = "Poles: " + pc;
        const h = pc / 2;
        const kw = windingFactor(routing, h);
        kwReadout.textContent = "kw(h=" + h + "): " + kw.toFixed(3);
      } catch (e) {
        poleReadout.textContent = "Poles: —";
        kwReadout.textContent = "kw: —";
      }
    }

    // ---- Pointer events ----
    function canvasMxMy(evt) {
      const rect = xsecCanvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return {
        mx: (evt.clientX - rect.left) * dpr,
        my: (evt.clientY - rect.top) * dpr,
      };
    }

    function getLayoutAndRouting() {
      const W = xsecCanvas.width;
      const H = xsecCanvas.height;
      const CSR = UM_ref.CrossSectionRender;
      const geom = CSR ? CSR.buildGeometry(config) : null;
      if (!geom) return null;
      const layout = LIB.Layout.rotational(W, H, { worldR: geom.rOuter, padPx: 12 });
      const routing = resolveWinding(config.rings[activeRing]);
      return { layout, routing, geom };
    }

    function onPointerDown(evt) {
      evt.preventDefault();
      xsecCanvas.setPointerCapture(evt.pointerId);
      const { mx, my } = canvasMxMy(evt);
      const lr = getLayoutAndRouting();
      if (!lr) return;
      const { layout, routing, geom } = lr;
      const ring = config.rings[activeRing];

      if (ring.element === "W" || ring.element === "K") {
        // Distributed: pick go-slot
        const slot = slotAtPoint(mx, my, layout, routing);
        if (slot >= 0) {
          gesturGoSlot = slot;
          gestureActive = true;
          scheduleRender();
        }
      } else if (ring.element === "C") {
        // Concentrated: tap a tooth → add/toggle coil
        const tooth = toothAtPoint(mx, my, layout, geom);
        if (tooth >= 0) {
          // Check if already have a coil on this tooth
          const existing = editorEdits.findIndex(function (e) {
            return e.circuit === activeCircuit && e.slotGo === tooth;
          });
          if (existing >= 0) {
            // Toggle wrap direction (negate turns)
            editorEdits[existing].turns = -editorEdits[existing].turns;
          } else {
            if (routing) {
              editorEdits.push({
                circuit: activeCircuit,
                slotGo: tooth,
                slotReturn: (tooth + 1) % routing.nSlots,
                turns: 10,
              });
            }
          }
          // Commit immediately on tap
          commitEdits(routing);
          scheduleRender();
        }
      }
    }

    function onPointerMove(evt) {
      if (!gestureActive) return;
      scheduleRender();
    }

    function onPointerUp(evt) {
      evt.preventDefault();
      if (!gestureActive) { gestureActive = false; gesturGoSlot = null; return; }
      gestureActive = false;

      const { mx, my } = canvasMxMy(evt);
      const lr = getLayoutAndRouting();
      if (!lr) { gesturGoSlot = null; scheduleRender(); return; }
      const { layout, routing } = lr;
      const ring = config.rings[activeRing];

      if ((ring.element === "W" || ring.element === "K") && gesturGoSlot !== null) {
        const returnSlot = slotAtPoint(mx, my, layout, routing);
        if (returnSlot >= 0 && returnSlot !== gesturGoSlot && routing) {
          // Determine coil turns: positive if traversal is CCW (go < return in angle order)
          const goAngle = routing.slotTheta[gesturGoSlot];
          const retAngle = routing.slotTheta[returnSlot];
          const diff = ((retAngle - goAngle) % TWO_PI + TWO_PI) % TWO_PI;
          const turns = diff <= Math.PI ? 10 : -10;
          editorEdits.push({
            circuit: activeCircuit,
            slotGo: gesturGoSlot,
            slotReturn: returnSlot,
            turns,
          });
          commitEdits(routing);
        }
      }

      gesturGoSlot = null;
      scheduleRender();
    }

    function commitEdits(routing) {
      if (!routing || editorEdits.length === 0) return;
      const newRouting = buildRoutingFromEdits(editorEdits, routing.nSlots, routing.slotTheta);
      config.rings[activeRing].winding = newRouting;
      ctx.requestRebuild();
      buildRingSelector();
    }

    xsecCanvas.addEventListener("pointerdown", onPointerDown);
    xsecCanvas.addEventListener("pointermove", onPointerMove);
    xsecCanvas.addEventListener("pointerup", onPointerUp);
    xsecCanvas.addEventListener("pointercancel", function () {
      gestureActive = false; gesturGoSlot = null; scheduleRender();
    });

    // Initial render after layout
    requestAnimationFrame(function () {
      resizeCanvas(xsecCanvas);
      resizeCanvas(plotCanvas);
      scheduleRender();
    });

    // ---- unmount ----
    return function unmount() {
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      xsecCanvas.removeEventListener("pointerdown", onPointerDown);
      xsecCanvas.removeEventListener("pointermove", onPointerMove);
      xsecCanvas.removeEventListener("pointerup", onPointerUp);
      host.innerHTML = "";
    };
  }

  // Auto-register when seams exist at load time (guarded)
  register(UM);

  UM.WindingEditor = {
    windingFunction,
    spatialSpectrum,
    poleCount,
    windingFactor,
    register,
  };
})();
