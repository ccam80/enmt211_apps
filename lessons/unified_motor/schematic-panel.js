(function () {
  "use strict";

  const TWO_PI = 2 * Math.PI;
  const GRID_SPACING = 20;

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  // ---------------------------------------------------------------------------
  //  capPhaseSplit(C, freq, R) → radians
  //
  //  The phase-split effect of a run capacitor on an AC branch.
  //  Returns 0 when C === 0 (no capacitor) or freq <= 0 (no AC frequency).
  //  For R === 0 with C,freq > 0 returns π/2 (pure quadrature).
  //  Otherwise Δφ = atan2(1/(2π·freq·C), R), clamped to [0, π/2].
  // ---------------------------------------------------------------------------
  function capPhaseSplit(C, freq, R) {
    if (C === 0) return 0;
    if (freq <= 0) return 0;
    const Xc = 1 / (TWO_PI * freq * C);
    const phi = Math.atan2(Xc, R);
    return Math.min(Math.max(phi, 0), Math.PI / 2);
  }

  // ---------------------------------------------------------------------------
  //  switchState(sw, ctx2) → "CLOSED" | "OPEN"
  //
  //  sw = { kind:"manual"|"centrifugal", target:int, closed?:bool,
  //         cutoutOmega?:number, mode?:"start-winding"|"run-winding" }
  //  ctx2 = { omega }
  //
  //  manual: closed ? "CLOSED" : "OPEN"
  //  centrifugal start-winding (default): OPEN when |omega| >= cutoutOmega
  //  centrifugal run-winding: CLOSED when |omega| >= cutoutOmega (inverted)
  // ---------------------------------------------------------------------------
  function switchState(sw, ctx2) {
    if (sw.kind === "manual") {
      return sw.closed ? "CLOSED" : "OPEN";
    }
    // centrifugal
    const mode = sw.mode || "start-winding";
    const above = Math.abs(ctx2.omega) >= sw.cutoutOmega;
    if (mode === "run-winding") {
      return above ? "CLOSED" : "OPEN";
    }
    // start-winding: open (cut out) when above cutout speed
    return above ? "OPEN" : "CLOSED";
  }

  // ---------------------------------------------------------------------------
  //  deepCopyCircuits(circuits) → new array
  //
  //  Returns a deep copy of the circuits array so lower() does not mutate the
  //  caller's data.
  // ---------------------------------------------------------------------------
  function deepCopyCircuits(circuits) {
    return circuits.map(function (c) {
      return {
        terminal: Object.assign({}, c.terminal),
        commutation: Object.assign({}, c.commutation),
        R: c.R,
      };
    });
  }

  // ---------------------------------------------------------------------------
  //  lower(schematic, baseCircuits, params) → circuits[]
  //
  //  Produces a new circuits array (deep copy of baseCircuits) with:
  //  1. Connection topology applied (independent / star / delta).
  //  2. Series resistance from "resistor" components added.
  //  3. Phase-split from "capacitor" components injected (AC only).
  //  Switches are NOT applied here (omega-dependent, see applyToRuntime).
  // ---------------------------------------------------------------------------
  function lower(schematic, baseCircuits, params) {
    params = params || {};
    const circuits = deepCopyCircuits(baseCircuits);
    const m = circuits.length;
    const connection = schematic.connection || "independent";
    const basePhase = params.basePhase != null ? params.basePhase : 0;

    if (connection === "star") {
      for (let k = 0; k < m; k++) {
        circuits[k].terminal.type = "AC";
        if (params.Vphase != null) {
          circuits[k].terminal.amp = params.Vphase;
        }
        circuits[k].terminal.phaseOffset = basePhase - TWO_PI * k / m;
      }
    } else if (connection === "delta") {
      for (let k = 0; k < m; k++) {
        circuits[k].terminal.type = "AC";
        if (params.Vphase != null) {
          circuits[k].terminal.amp = Math.sqrt(3) * params.Vphase;
        }
        circuits[k].terminal.phaseOffset = basePhase + Math.PI / 6 - TWO_PI * k / m;
      }
    }
    // "independent": leave terminal/commutation unchanged

    var components = schematic.components || [];
    for (var i = 0; i < components.length; i++) {
      var comp = components[i];
      if (comp.kind === "resistor") {
        var t = comp.target;
        if (t >= 0 && t < m) {
          circuits[t].R += comp.R;
        }
      } else if (comp.kind === "capacitor") {
        var tc = comp.target;
        if (tc >= 0 && tc < m) {
          var ckt = circuits[tc];
          if (ckt.terminal.type === "AC") {
            var freq = ckt.terminal.freq != null ? ckt.terminal.freq : 0;
            var R = ckt.R;
            ckt.terminal.phaseOffset =
              (ckt.terminal.phaseOffset || 0) + capPhaseSplit(comp.C, freq, R);
          }
        }
      }
    }

    return circuits;
  }

  // ---------------------------------------------------------------------------
  //  applyToRuntime(runtime, schematic, params) → void
  //
  //  Lowers the schematic to a circuits array (the closed-switch baseline),
  //  caches that baseline in schematic._loweredBase so subsequent calls always
  //  start from the driven state rather than from switch-mutated runtime data,
  //  copies each field into runtime.circuits in place, then applies switches
  //  against runtime.state.omega.
  // ---------------------------------------------------------------------------
  function applyToRuntime(runtime, schematic, params) {
    params = params || {};
    // Compute the closed-switch baseline from the cached base if available,
    // otherwise derive it from the current runtime circuits.
    var base = schematic._loweredBase || runtime.circuits;
    var lowered = lower(schematic, base, params);
    // Cache the pre-switch result as the authoritative driven baseline.
    schematic._loweredBase = deepCopyCircuits(lowered);

    for (var k = 0; k < runtime.circuits.length; k++) {
      runtime.circuits[k].terminal = lowered[k].terminal;
      runtime.circuits[k].commutation = lowered[k].commutation;
      runtime.circuits[k].R = lowered[k].R;
    }
    var switches = schematic.switches || [];
    var omega = runtime.state.omega;
    for (var s = 0; s < switches.length; s++) {
      var sw = switches[s];
      if (switchState(sw, { omega: omega }) === "OPEN") {
        var t = sw.target;
        if (t >= 0 && t < runtime.circuits.length) {
          runtime.circuits[t].terminal = Object.assign(
            {},
            runtime.circuits[t].terminal,
            { type: "OPEN" }
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  //  Coordinate transform helpers — grid-snapped screen transform
  //  Modelled on digital_in_browser/src/editor/coordinates.ts
  // ---------------------------------------------------------------------------

  function worldToScreen(wx, wy, originX, originY, scale) {
    return {
      x: originX + wx * scale,
      y: originY - wy * scale,
    };
  }

  function screenToWorld(sx, sy, originX, originY, scale) {
    return {
      x: (sx - originX) / scale,
      y: -(sy - originY) / scale,
    };
  }

  function snapToGrid(wx, wy) {
    return {
      x: Math.round(wx / GRID_SPACING) * GRID_SPACING,
      y: Math.round(wy / GRID_SPACING) * GRID_SPACING,
    };
  }

  // ---------------------------------------------------------------------------
  //  splitWiresAtJunctions(wires) → wires[]
  //
  //  Modelled on digital_in_browser/src/core/circuit.ts splitWiresAtJunctions.
  //  A node is a shared wire endpoint. A T-junction (endpoint of one wire
  //  that lies strictly on the interior of another wire) splits the crossed wire.
  // ---------------------------------------------------------------------------
  function splitWiresAtJunctions(wires) {
    var result = wires.slice();
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < result.length; i++) {
        var w = result[i];
        var ax = w.x1, ay = w.y1, bx = w.x2, by = w.y2;
        for (var j = 0; j < result.length; j++) {
          if (i === j) continue;
          var other = result[j];
          // Check both endpoints of other against interior of w
          var pts = [
            { x: other.x1, y: other.y1 },
            { x: other.x2, y: other.y2 },
          ];
          for (var p = 0; p < pts.length; p++) {
            var px = pts[p].x, py = pts[p].y;
            if (pointOnSegmentInterior(ax, ay, bx, by, px, py)) {
              // Split w at (px, py)
              result.splice(i, 1,
                { x1: ax, y1: ay, x2: px, y2: py },
                { x1: px, y1: py, x2: bx, y2: by }
              );
              changed = true;
              break;
            }
          }
          if (changed) break;
        }
        if (changed) break;
      }
    }
    return result;
  }

  function pointOnSegmentInterior(ax, ay, bx, by, px, py) {
    // Is (px,py) strictly between (ax,ay) and (bx,by) (collinear)?
    var crossZ = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (Math.abs(crossZ) > 1e-9) return false;
    var dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
    var lenSq = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
    return dot > 1e-9 && dot < lenSq - 1e-9;
  }

  // ---------------------------------------------------------------------------
  //  build(host, ctx) → unmountFn
  //
  //  Browser canvas: grid-snapped drag-drop schematic editor.
  //  Stores edited topology in ctx.config.schematic.
  //  Returns an unmount function that cancels the rAF and clears host.
  // ---------------------------------------------------------------------------
  function build(host, ctx) {
    var canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    host.appendChild(canvas);

    var schematic = ctx.config.schematic || {
      connection: "independent",
      components: [],
      wires: [],
      switches: [],
    };
    ctx.config.schematic = schematic;

    var rafId = null;
    var scale = 1;
    var originX = 0;
    var originY = 0;

    var popover = null;

    function closePopover() {
      if (popover && popover.parentNode) {
        popover.parentNode.removeChild(popover);
      }
      popover = null;
    }

    function resize() {
      var rect = host.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      originX = canvas.width / 2;
      originY = canvas.height / 2;
    }

    function drawGrid(ctx2d) {
      var W = canvas.width;
      var H = canvas.height;
      var dpr = window.devicePixelRatio || 1;
      var step = GRID_SPACING * dpr;

      ctx2d.save();
      ctx2d.strokeStyle = "rgba(128,128,128,0.2)";
      ctx2d.lineWidth = 1;

      var startX = originX % step;
      for (var x = startX; x < W; x += step) {
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, H);
        ctx2d.stroke();
      }
      var startY = originY % step;
      for (var y = startY; y < H; y += step) {
        ctx2d.beginPath();
        ctx2d.moveTo(0, y);
        ctx2d.lineTo(W, y);
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    function drawComponent(ctx2d, comp, dpr) {
      var dprScale = dpr || 1;
      var sw = worldToScreen(comp.x, comp.y, originX, originY, dprScale);
      ctx2d.save();
      ctx2d.strokeStyle = "#aaa";
      ctx2d.fillStyle = "#fff";
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.rect(sw.x - 14 * dprScale, sw.y - 14 * dprScale, 28 * dprScale, 28 * dprScale);
      ctx2d.stroke();
      ctx2d.fill();

      ctx2d.fillStyle = "#ccc";
      ctx2d.font = (10 * dprScale) + "px sans-serif";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "middle";
      var label = comp.kind ? comp.kind[0].toUpperCase() : "?";
      ctx2d.fillText(label, sw.x, sw.y);
      ctx2d.restore();
    }

    function drawWire(ctx2d, wire, dpr) {
      var dprScale = dpr || 1;
      var a = worldToScreen(wire.x1, wire.y1, originX, originY, dprScale);
      var b = worldToScreen(wire.x2, wire.y2, originX, originY, dprScale);
      ctx2d.save();
      ctx2d.strokeStyle = "#4ea1ff";
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.moveTo(a.x, a.y);
      ctx2d.lineTo(b.x, b.y);
      ctx2d.stroke();
      ctx2d.restore();
    }

    function frame() {
      rafId = requestAnimationFrame(frame);
      var ctx2d = canvas.getContext("2d");
      var dpr = window.devicePixelRatio || 1;
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      drawGrid(ctx2d);

      var allWires = splitWiresAtJunctions(schematic.wires);
      for (var i = 0; i < allWires.length; i++) {
        drawWire(ctx2d, allWires[i], dpr);
      }
      for (var c = 0; c < schematic.components.length; c++) {
        drawComponent(ctx2d, schematic.components[c], dpr);
      }

      applyToRuntime(ctx.runtime, schematic, {});
    }

    function openParamPopover(comp, screenX, screenY) {
      closePopover();
      popover = document.createElement("div");
      popover.style.cssText =
        "position:absolute;background:#222;border:1px solid #555;padding:8px;z-index:100;min-width:200px;";
      popover.style.left = screenX + "px";
      popover.style.top = screenY + "px";
      host.style.position = "relative";
      host.appendChild(popover);

      var title = document.createElement("div");
      title.style.cssText = "font-weight:bold;margin-bottom:6px;color:#eee;";
      title.textContent = comp.kind;
      popover.appendChild(title);

      function makeSlider(labelText, key, min, max, step) {
        var row = LIB.Registry.mkRow({
          key: key,
          label: labelText,
          min: min,
          max: max,
          step: step,
          value: comp[key] != null ? comp[key] : 0,
          onChange: function (v) {
            comp[key] = v;
            applyToRuntime(ctx.runtime, schematic, {});
          },
        });
        popover.appendChild(row);
      }

      if (comp.kind === "resistor") {
        makeSlider("R (Ω)", "R", 0, 100, 0.1);
      } else if (comp.kind === "capacitor") {
        makeSlider("C (μF)", "C_uF", 1, 200, 1);
        if (comp.C_uF != null) comp.C = comp.C_uF * 1e-6;
      } else if (comp.kind === "source") {
        makeSlider("amp", "amp", 0, 500, 1);
        makeSlider("freq", "freq", 0, 400, 1);
      } else if (comp.kind === "switch") {
        var btn = document.createElement("button");
        btn.style.cssText = "margin-top:4px;width:100%;";
        btn.textContent = comp.closed ? "ON (click to open)" : "OFF (click to close)";
        btn.addEventListener("click", function () {
          comp.closed = !comp.closed;
          btn.textContent = comp.closed ? "ON (click to open)" : "OFF (click to close)";
          applyToRuntime(ctx.runtime, schematic, {});
        });
        popover.appendChild(btn);
      }

      var closeBtn = document.createElement("button");
      closeBtn.style.cssText = "margin-top:6px;width:100%;";
      closeBtn.textContent = "Close";
      closeBtn.addEventListener("click", closePopover);
      popover.appendChild(closeBtn);
    }

    var dragState = null;

    function canvasCoords(e) {
      var rect = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      var sx = (e.clientX - rect.left) * dpr;
      var sy = (e.clientY - rect.top) * dpr;
      return screenToWorld(sx, sy, originX, originY, dpr);
    }

    function hitTestComponent(wx, wy) {
      var dpr = window.devicePixelRatio || 1;
      var threshold = 18 * dpr;
      for (var i = schematic.components.length - 1; i >= 0; i--) {
        var c = schematic.components[i];
        var sw = worldToScreen(c.x, c.y, originX, originY, dpr);
        var px = worldToScreen(wx, wy, originX, originY, dpr);
        if (Math.abs(px.x - sw.x) <= threshold && Math.abs(px.y - sw.y) <= threshold) {
          return i;
        }
      }
      return -1;
    }

    function onPointerDown(e) {
      e.preventDefault();
      var wp = canvasCoords(e);
      var snapped = snapToGrid(wp.x, wp.y);

      if (e.button === 2) {
        var hit = hitTestComponent(wp.x, wp.y);
        if (hit >= 0) {
          openParamPopover(
            schematic.components[hit],
            e.clientX - host.getBoundingClientRect().left,
            e.clientY - host.getBoundingClientRect().top
          );
        }
        return;
      }

      closePopover();
      var idx = hitTestComponent(wp.x, wp.y);
      if (idx >= 0) {
        canvas.setPointerCapture(e.pointerId);
        dragState = { kind: "move", idx: idx, startX: snapped.x, startY: snapped.y };
        return;
      }

      canvas.setPointerCapture(e.pointerId);
      dragState = {
        kind: "wire",
        x1: snapped.x,
        y1: snapped.y,
        x2: snapped.x,
        y2: snapped.y,
      };
    }

    function onPointerMove(e) {
      if (!dragState) return;
      var wp = canvasCoords(e);
      var snapped = snapToGrid(wp.x, wp.y);

      if (dragState.kind === "move") {
        var comp = schematic.components[dragState.idx];
        comp.x = snapped.x;
        comp.y = snapped.y;
      } else if (dragState.kind === "wire") {
        dragState.x2 = snapped.x;
        dragState.y2 = snapped.y;
      }
    }

    function onPointerUp(e) {
      if (!dragState) return;
      if (dragState.kind === "wire") {
        if (dragState.x1 !== dragState.x2 || dragState.y1 !== dragState.y2) {
          schematic.wires.push({
            x1: dragState.x1,
            y1: dragState.y1,
            x2: dragState.x2,
            y2: dragState.y2,
          });
        }
      }
      dragState = null;
    }

    var connectionSelect = document.createElement("select");
    ["independent", "star", "delta"].forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (schematic.connection === opt) o.selected = true;
      connectionSelect.appendChild(o);
    });
    connectionSelect.addEventListener("change", function () {
      schematic.connection = connectionSelect.value;
      applyToRuntime(ctx.runtime, schematic, {});
    });

    var toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;gap:6px;align-items:center;padding:4px;flex-wrap:wrap;";

    var connLabel = document.createElement("span");
    connLabel.textContent = "Connection:";
    connLabel.style.color = "#ccc";
    toolbar.appendChild(connLabel);
    toolbar.appendChild(connectionSelect);

    function addComponentBtn(kind, label) {
      var btn = document.createElement("button");
      btn.textContent = label;
      btn.addEventListener("click", function () {
        schematic.components.push({
          kind: kind,
          x: 0,
          y: 0,
          target: 0,
          R: 1,
          C: 30e-6,
          C_uF: 30,
          amp: 230,
          freq: 50,
          closed: true,
          cutoutOmega: 100,
          mode: "start-winding",
        });
      });
      toolbar.appendChild(btn);
    }

    addComponentBtn("source", "+ Source");
    addComponentBtn("resistor", "+ Resistor");
    addComponentBtn("capacitor", "+ Capacitor");
    addComponentBtn("switch", "+ Switch");

    var clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear All";
    clearBtn.addEventListener("click", function () {
      schematic.components = [];
      schematic.wires = [];
      schematic.switches = [];
      closePopover();
    });
    toolbar.appendChild(clearBtn);

    var wrapper = document.createElement("div");
    wrapper.style.cssText = "display:flex;flex-direction:column;width:100%;height:100%;";
    wrapper.appendChild(toolbar);
    wrapper.appendChild(canvas);

    host.innerHTML = "";
    host.appendChild(wrapper);

    resize();
    rafId = requestAnimationFrame(frame);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    var resizeObserver = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
    }

    return function unmount() {
      cancelAnimationFrame(rafId);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("contextmenu", function (e) { e.preventDefault(); });
      if (resizeObserver) resizeObserver.disconnect();
      closePopover();
      host.innerHTML = "";
    };
  }

  // ---------------------------------------------------------------------------
  //  register(UM) — guarded panel registration
  // ---------------------------------------------------------------------------
  function register(UM) {
    if (UM.registerPanel) {
      UM.registerPanel({
        id: "schematic",
        title: "Circuit",
        zone: "side",
        build: build,
      });
    }
  }

  // ---------------------------------------------------------------------------
  //  Public API
  // ---------------------------------------------------------------------------
  UM.Schematic = {
    capPhaseSplit: capPhaseSplit,
    switchState: switchState,
    lower: lower,
    applyToRuntime: applyToRuntime,
    register: register,
  };

  // Guarded auto-registration
  register(UM);

})();
