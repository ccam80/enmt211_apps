(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});

  // ===========================================================================
  //  LIB.CurrentDots — animated current-flow dots along conductor paths.
  //
  //  Ported from the digital_in_browser wire-current animation: each circuit
  //  carries one scalar phase (an accumulated charge-like offset) advanced by
  //  |I|·speedScale·dt. Every conductor of that circuit places dots at the same
  //  phase, so dots flowing through a coil's bars and end turns stay in lock
  //  step and read as one continuous stream. Direction is set per segment by a
  //  flowSign (go vs return, current polarity), folded into the offset sign.
  //
  //  Pure geometry/algebra — no canvas, no projection. The renderer owns the
  //  per-circuit phase array, calls step() once per frame, then places dots
  //  along each conductor polyline and projects them itself.
  // ===========================================================================

  const DEFAULTS = {
    spacing:    0.006,   // world-units between dots along a path
    speedScale: 0.02,    // path-units per amp per second of sim time
    mode:       "linear",
    logRef:     1.0,     // reference current for log scaling (A)
  };

  // ---------------------------------------------------------------------------
  //  step(phase, currents, dtSim, opts) → phase
  //
  //  Advances each circuit's phase in place by its (signed) current. Linear
  //  mode: dphase = I·speedScale·dt. Logarithmic mode keeps small currents
  //  visible: dphase = sign(I)·log1p(|I|/ref)·speedScale·dt.
  // ---------------------------------------------------------------------------
  function step(phase, currents, dtSim, opts) {
    opts = opts || {};
    const scale = opts.speedScale != null ? opts.speedScale : DEFAULTS.speedScale;
    const mode  = opts.mode || DEFAULTS.mode;
    const ref   = opts.logRef != null ? opts.logRef : DEFAULTS.logRef;
    const m = phase.length;
    for (let k = 0; k < m; k++) {
      const I = currents[k] || 0;
      let v;
      if (mode === "logarithmic") {
        v = (I >= 0 ? 1 : -1) * Math.log1p(Math.abs(I) / ref) * scale;
      } else {
        v = I * scale;
      }
      phase[k] += v * dtSim;
    }
    return phase;
  }

  // ---------------------------------------------------------------------------
  //  placeDots(points, offset, spacing) → [[x,y,z], ...]
  //
  //  Places dots at `spacing` intervals along a 3-D polyline (flat Float64Array
  //  [x0,y0,z0,x1,y1,z1,…]), the first dot at ((offset % spacing)+spacing)%
  //  spacing from the start. Pass a signed offset (phase × flowSign) to flow
  //  in either direction. Returns world-space dot positions; the caller
  //  projects them.
  // ---------------------------------------------------------------------------
  function placeDots(points, offset, spacing) {
    const np = points.length / 3;
    if (np < 2 || spacing <= 0) return [];

    // Cumulative arc length.
    const segLen = new Float64Array(np - 1);
    let total = 0;
    for (let i = 0; i < np - 1; i++) {
      const dx = points[(i + 1) * 3]     - points[i * 3];
      const dy = points[(i + 1) * 3 + 1] - points[i * 3 + 1];
      const dz = points[(i + 1) * 3 + 2] - points[i * 3 + 2];
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      segLen[i] = L;
      total += L;
    }
    if (total < 1e-12) return [];

    const first = ((offset % spacing) + spacing) % spacing;
    const out = [];
    let seg = 0, acc = 0;
    for (let d = first; d < total; d += spacing) {
      while (seg < segLen.length - 1 && acc + segLen[seg] < d) { acc += segLen[seg]; seg++; }
      const t = segLen[seg] > 1e-12 ? (d - acc) / segLen[seg] : 0;
      out.push([
        points[seg * 3]     + (points[(seg + 1) * 3]     - points[seg * 3])     * t,
        points[seg * 3 + 1] + (points[(seg + 1) * 3 + 1] - points[seg * 3 + 1]) * t,
        points[seg * 3 + 2] + (points[(seg + 1) * 3 + 2] - points[seg * 3 + 2]) * t,
      ]);
    }
    return out;
  }

  LIB.CurrentDots = { step, placeDots, DEFAULTS };
})();
