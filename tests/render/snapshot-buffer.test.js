"use strict";

// =============================================================================
//  LIB.Snapshot unit tests — buffer bracketing, pruning, clock resolution, and
//  in-place display interpolation.
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");

if (!globalThis.window) globalThis.window = globalThis;
require("../../lib/snapshot-buffer.js");
const Snap = (globalThis.window.LIB || globalThis.LIB).Snapshot;

// A minimal snapshot with one circuit and one slice; field arrays are tagged
// with the time so nearest-selection is checkable by value.
function mkSnap(t, opts) {
  opts = opts || {};
  return {
    epoch: opts.epoch || 0,
    t: t,
    theta: opts.theta != null ? opts.theta : t,
    omega: opts.omega != null ? opts.omega : 10,
    i: Float64Array.from([opts.i0 != null ? opts.i0 : t]),
    torque: opts.torque != null ? opts.torque : t,
    fluxLinkages: Float64Array.from([opts.flux != null ? opts.flux : t]),
    slices: [{
      AnodeR: Float64Array.from([t]), BmagR: Float64Array.from([t]),
      BxR: Float64Array.from([t]), ByR: Float64Array.from([t]),
      AnodeS: Float64Array.from([t]), BmagS: Float64Array.from([t]),
      BxS: Float64Array.from([t]), ByS: Float64Array.from([t]),
      gapPhi: opts.gapPhi != null ? opts.gapPhi : t,
    }],
  };
}

test("lerp / lerpAngle", () => {
  assert.equal(Snap.lerp(0, 10, 0.25), 2.5);
  assert.equal(Snap.lerp(4, 4, 0.9), 4);
  // Small deltas: lerpAngle == linear.
  assert.ok(Math.abs(Snap.lerpAngle(1.0, 1.1, 0.5) - 1.05) < 1e-12);
  // Straddling +π→−π takes the short arc, not the long way round.
  const a = 3.10, b = -3.10;                  // ~0.083 rad apart across the wrap
  const r = Snap.lerpAngle(a, b, 0.5);
  // Short-arc midpoint sits near ±π, NOT near 0 (which linear would give).
  assert.ok(Math.abs(Math.abs(r) - Math.PI) < 0.05, `got ${r}`);
});

test("bracket: empty / single / interior / clamp", () => {
  const buf = new Snap.Buffer();
  assert.equal(buf.bracket(0), null);
  assert.equal(buf.count, 0);

  buf.push(mkSnap(1));
  let br = buf.bracket(5);
  assert.equal(br.A.t, 1); assert.equal(br.B.t, 1); assert.equal(br.f, 0);

  buf.push(mkSnap(2));
  buf.push(mkSnap(4));
  // interior between 2 and 4
  br = buf.bracket(3);
  assert.equal(br.A.t, 2); assert.equal(br.B.t, 4);
  assert.equal(br.f, 0.5);
  // clamp low
  br = buf.bracket(0.5);
  assert.equal(br.A.t, 1); assert.equal(br.f, 0);
  // clamp high
  br = buf.bracket(9);
  assert.equal(br.A.t, 4); assert.equal(br.B.t, 4); assert.equal(br.f, 0);
});

test("prune keeps the left bracket for tKeep", () => {
  const buf = new Snap.Buffer();
  for (const t of [1, 2, 3, 4, 5]) buf.push(mkSnap(t));
  buf.prune(3.5);
  // Snapshots < the left bracket of 3.5 (=t3) are dropped; t3..t5 remain.
  assert.equal(buf.count, 3);
  assert.equal(buf.earliest().t, 3);
  // A bracket for 3.5 is still resolvable.
  const br = buf.bracket(3.5);
  assert.equal(br.A.t, 3); assert.equal(br.B.t, 4);
});

test("resolveShowTime: lead within cap, drop backlog when behind", () => {
  // no snapshot yet
  let r = Snap.resolveShowTime(2.0, null, 1.0);
  assert.equal(r.tShow, 2.0); assert.equal(r.behind, false);
  // simClock ahead of latest but within maxLead → render at latest, keep clock
  r = Snap.resolveShowTime(5.5, 5.0, 1.0);
  assert.equal(r.tShow, 5.0); assert.equal(r.simClock, 5.5); assert.equal(r.behind, false);
  // simClock within → render at simClock
  r = Snap.resolveShowTime(4.8, 5.0, 1.0);
  assert.equal(r.tShow, 4.8); assert.equal(r.behind, false);
  // lead exceeds cap → behind, clock pulled back to latest
  r = Snap.resolveShowTime(9.0, 5.0, 1.0);
  assert.equal(r.tShow, 5.0); assert.equal(r.simClock, 5.0); assert.equal(r.behind, true);
});

// A display proxy skeleton (what mount builds once per epoch) — one circuit,
// one slice, with a stand-in mesh reference to prove it is never overwritten.
function mkDisp() {
  const mesh = { tag: "static-mesh" };
  return {
    state: { theta: 0, omega: 0, t: 0, i: new Float64Array(1) },
    lastSolve: {
      torque: 0, fluxLinkages: new Float64Array(1),
      perSliceField: [{
        gap: { phi: 0 },
        rotor:  { mesh: mesh, Anode: null, Belem: { mag: null, Bx: null, By: null } },
        stator: { mesh: mesh, Anode: null, Belem: { mag: null, Bx: null, By: null } },
      }],
    },
  };
}

test("writeInterp: lerps kinematics, overrides gap.phi, rides nearest field", () => {
  const disp = mkDisp();
  const A = mkSnap(2), B = mkSnap(4);
  const meshRef = disp.lastSolve.perSliceField[0].rotor.mesh;

  // f = 0.25 → nearest is A (t=2)
  Snap.writeInterp(disp, A, B, 0.25, 2.5);
  assert.equal(disp.state.t, 2.5);
  assert.equal(disp.state.theta, 2.5);                 // lerp(2,4,0.25)
  assert.equal(disp.state.i[0], 2.5);
  assert.equal(disp.lastSolve.torque, 2.5);
  assert.equal(disp.lastSolve.fluxLinkages[0], 2.5);
  assert.equal(disp.lastSolve.perSliceField[0].gap.phi, 2.5);
  // field arrays ride the nearest snapshot (A, tagged 2)
  assert.equal(disp.lastSolve.perSliceField[0].rotor.Anode[0], 2);
  assert.equal(disp.lastSolve.perSliceField[0].stator.Belem.mag[0], 2);
  // mesh reference untouched
  assert.equal(disp.lastSolve.perSliceField[0].rotor.mesh, meshRef);

  // f = 0.75 → nearest is B (t=4)
  Snap.writeInterp(disp, A, B, 0.75, 3.5);
  assert.equal(disp.lastSolve.perSliceField[0].rotor.Anode[0], 4);
  assert.equal(disp.state.theta, 3.5);
});

test("writeInterp: stable identity of state.i and fluxLinkages arrays", () => {
  const disp = mkDisp();
  const iRef = disp.state.i, fRef = disp.lastSolve.fluxLinkages;
  Snap.writeInterp(disp, mkSnap(1), mkSnap(2), 0.5, 1.5);
  assert.equal(disp.state.i, iRef);                    // written in place, not replaced
  assert.equal(disp.lastSolve.fluxLinkages, fRef);
});
