"use strict";

// =============================================================================
//  LIB.Snapshot — solver-snapshot ring buffer + render-time interpolation.
//
//  The unified-motor sim advances on its own LTE-controlled cadence (a solve is
//  an atomic 20-50 ms Newton step) and emits a SNAPSHOT after each solve. The
//  render loop carries a smooth `simClock` and samples the snapshot stream by
//  interpolating between the two snapshots that bracket the clock — so the
//  displayed rotor/dots/plots glide at the ordered rate instead of stepping at
//  the irregular solve cadence.
//
//  A snapshot is pure data (numbers + typed arrays it owns — see WORKER-SPEC
//  §5): { epoch, t, theta, omega, i:Float64Array, torque,
//         fluxLinkages:Float64Array,
//         slices:[ { AnodeR, BmagR, BxR, ByR, AnodeS, BmagS, BxS, ByS,
//                    gapPhi }, ... ] }.
//
//  This module is pure (no DOM, no runtime) so it unit-tests headless and runs
//  identically under the in-process and Worker sim sources.
// =============================================================================

(function () {
  const LIB = (typeof window !== "undefined" ? window : globalThis).LIB ||
    ((typeof window !== "undefined" ? window : globalThis).LIB = {});

  const TWO_PI = 2 * Math.PI;

  function lerp(a, b, f) { return a + (b - a) * f; }

  // Interpolate an angle by the SHORTEST arc for the fractional step. For the
  // tiny angle deltas between two adjacent solves this equals plain linear
  // interpolation; it only bites when a bracket straddles a ±π wrap (e.g. a
  // reseeded gap phase), where linear would spin the rotor a whole turn backward
  // for one frame. Used for theta and gap.phi.
  function lerpAngle(a, b, f) {
    let d = b - a;
    d -= TWO_PI * Math.round(d / TWO_PI);
    return a + d * f;
  }

  // ---------------------------------------------------------------------------
  //  Buffer — append-only monotone-in-t ring, pruned from the left to whatever
  //  still brackets the render clock.
  // ---------------------------------------------------------------------------
  function Buffer() { this._buf = []; }

  Buffer.prototype.clear = function () { this._buf.length = 0; };

  Buffer.prototype.push = function (snap) { this._buf.push(snap); };

  Object.defineProperty(Buffer.prototype, "count", {
    get: function () { return this._buf.length; },
  });

  Buffer.prototype.latest = function () {
    return this._buf.length ? this._buf[this._buf.length - 1] : null;
  };

  Buffer.prototype.earliest = function () {
    return this._buf.length ? this._buf[0] : null;
  };

  // bracket(t) → { A, B, f } | null. A.t ≤ t ≤ B.t and f = (t−A.t)/(B.t−A.t).
  // Clamps to an endpoint (A===B, f=0) when t is outside the buffered range or
  // the buffer holds a single snapshot. null only when the buffer is empty.
  Buffer.prototype.bracket = function (t) {
    const buf = this._buf;
    const n = buf.length;
    if (n === 0) return null;
    if (n === 1 || t <= buf[0].t) return { A: buf[0], B: buf[0], f: 0 };
    const last = buf[n - 1];
    if (t >= last.t) return { A: last, B: last, f: 0 };
    // Binary search for the largest i with buf[i].t <= t.
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (buf[mid].t <= t) lo = mid; else hi = mid;
    }
    const A = buf[lo], B = buf[lo + 1];
    const span = B.t - A.t;
    const f = span > 0 ? (t - A.t) / span : 0;
    return { A: A, B: B, f: f };
  };

  // Drop snapshots that can no longer bracket render times ≥ tKeep: keep the
  // last snapshot with t ≤ tKeep (the left bracket for tKeep) and everything
  // after it. Bounds memory to the lead window.
  Buffer.prototype.prune = function (tKeep) {
    const buf = this._buf;
    let drop = 0;
    while (drop + 1 < buf.length && buf[drop + 1].t <= tKeep) drop++;
    if (drop > 0) buf.splice(0, drop);
  };

  // ---------------------------------------------------------------------------
  //  resolveShowTime — reconcile the smooth render clock with the newest solve.
  //
  //  simClock leads the solver by design (we interpolate within the lead). When
  //  the lead exceeds maxLead the solver cannot sustain the ordered rate, so we
  //  DROP the backlog: render at the latest snapshot and pull simClock back to
  //  it (no catch-up burst), flagging `behind` for the UI. Otherwise render at
  //  min(simClock, latest) — never ahead of the last real solve.
  // ---------------------------------------------------------------------------
  function resolveShowTime(simClock, latestT, maxLead) {
    if (latestT == null) return { tShow: simClock, simClock: simClock, behind: false };
    const lead = simClock - latestT;
    if (lead > maxLead) {
      return { tShow: latestT, simClock: latestT, behind: true };
    }
    return { tShow: Math.min(simClock, latestT), simClock: simClock, behind: false };
  }

  // ---------------------------------------------------------------------------
  //  writeInterp — write the interpolated display state into a persistent proxy.
  //
  //  `disp` is the display runtime (stable object identity across frames, per
  //  epoch — the current-dot animator keys on it). Its shape mirrors what the
  //  renderers read off a real runtime:
  //    disp.state       = { theta, omega, t, i:Float64Array(nCircuits) }
  //    disp.lastSolve   = { torque, fluxLinkages:Float64Array(nCircuits),
  //                         perSliceField:[ { gap:{phi},
  //                                          rotor:{ mesh, Anode, Belem:{mag,Bx,By} },
  //                                          stator:{ mesh, Anode, Belem:{mag,Bx,By} } }, ... ] }
  //  Scalars and the small per-circuit arrays are lerped in place. Kinematics
  //  (theta, gap.phi) glide; the heavy field arrays (Anode/Belem) ride the
  //  NEAREST snapshot by reference — no per-frame copy, and the snapshots the
  //  buffer retains own that memory. tShow is written verbatim so the plot and
  //  axis share exactly one clock.
  // ---------------------------------------------------------------------------
  function writeInterp(disp, A, B, f, tShow) {
    const st = disp.state, ls = disp.lastSolve;
    st.theta = lerpAngle(A.theta, B.theta, f);
    st.omega = lerp(A.omega, B.omega, f);
    st.t = tShow;
    const nC = st.i.length;
    for (let k = 0; k < nC; k++) st.i[k] = lerp(A.i[k], B.i[k], f);
    ls.torque = lerp(A.torque, B.torque, f);
    for (let k = 0; k < nC; k++) ls.fluxLinkages[k] = lerp(A.fluxLinkages[k], B.fluxLinkages[k], f);

    const near = f < 0.5 ? A : B;
    const psf = ls.perSliceField;
    for (let s = 0; s < psf.length; s++) {
      const face = psf[s];
      const as = A.slices[s], bs = B.slices[s], nsl = near.slices[s];
      face.gap.phi = lerpAngle(as.gapPhi, bs.gapPhi, f);
      const r = face.rotor, st2 = face.stator;
      r.Anode = nsl.AnodeR; r.Belem.mag = nsl.BmagR; r.Belem.Bx = nsl.BxR; r.Belem.By = nsl.ByR;
      st2.Anode = nsl.AnodeS; st2.Belem.mag = nsl.BmagS; st2.Belem.Bx = nsl.BxS; st2.Belem.By = nsl.ByS;
    }
  }

  LIB.Snapshot = {
    Buffer: Buffer,
    lerp: lerp,
    lerpAngle: lerpAngle,
    resolveShowTime: resolveShowTime,
    writeInterp: writeInterp,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = LIB.Snapshot;
})();
