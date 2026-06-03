"use strict";

// =============================================================================
//  Monolithic field-circuit-motion Newton gate (stack.solveCoupled).
//
//  ONE coupled Newton over (A_s…, i, ω, θ) per BDF step, A Schur-condensed per
//  slice. Differential variables are flux [λ,ω,θ] (full field-coupling). This
//  gate runs one synthetic backward-Euler step from rest and asserts:
//    - the Newton converges,
//    - the field + circuit + mechanical + angle residuals are all ≈ 0,
//    - the converged field A is consistent with an independent stack.solve at
//      the converged (θ, i)  (same torque),
//    - a current-imposed circuit holds its imposed current.
// =============================================================================

const { test, before } = require("node:test");
const assert = require("node:assert");
const F = require("./_fixtures.js");
const LIB = F.LIB, CS = F.UnifiedMotor.ConfigSchema;

before(async () => { await F.initSolver(); });

function setup() {
  const exp = CS.expand(F.byId["pmsm"].config);
  const stack = LIB.MotorStack.create(exp);
  const m = stack.nCircuits;
  const R = new Float64Array(m);
  for (let k = 0; k < m; k++) R[k] = exp.circuits[k].R;
  return { exp, stack, m, R, mech: exp.mechanical };
}

test("solveCoupled converges to a consistent (A,i,ω,θ) — voltage drive", () => {
  const { stack, m, R, mech } = setup();
  const dt = 1e-4, ag0 = 1 / dt;
  const hist = new Float64Array(m + 2);
  const Vsnap = [5, -2.5, -2.5];
  const cond = [];
  for (let k = 0; k < m; k++) cond.push({ kind: "voltage", V: Vsnap[k % 3] || 0, I: 0 });

  const res = stack.solveCoupled({
    ag0, hist, cond, R,
    J: mech.J, damping: mech.damping || 0, loadTorque: mech.loadTorque || 0,
    warm: { A: [null], i: new Float64Array(m), omega: 0, theta: 0.2 },
    tol: 1e-7, tolField: 1e-7, maxIter: 30,
  });

  assert.ok(res.converged, `did not converge (iters=${res.iters})`);
  assert.ok(res.fieldResid < 1e-6, `field residual ${res.fieldResid.toExponential(2)}`);
  assert.ok(res.redResid < 1e-6, `reduced residual ${res.redResid.toExponential(2)}`);

  // Independent field solve at the converged state must give the same torque.
  const chk = stack.solve(res.theta, res.i);
  assert.ok(Math.abs(chk.torque - res.torque) < 1e-5,
    `torque inconsistency: coupled ${res.torque} vs solve ${chk.torque}`);

  // Hand-check the discretized circuit / mechanical / angle equations.
  for (let k = 0; k < m; k++) {
    const rk = ag0 * res.lambda[k] + R[k] * res.i[k] - cond[k].V;
    assert.ok(Math.abs(rk) < 1e-6, `R_ckt[${k}] = ${rk.toExponential(2)}`);
  }
  const rmech = (mech.J * ag0 + (mech.damping || 0)) * res.omega - res.torque + (mech.loadTorque || 0);
  assert.ok(Math.abs(rmech) < 1e-6, `R_mech = ${rmech.toExponential(2)}`);
  assert.ok(Math.abs(ag0 * res.theta - res.omega) < 1e-6, "R_ang");
});

test("solveCoupled holds an imposed current (pinned-circuit path)", () => {
  const { stack, m, R, mech } = setup();
  const dt = 1e-4, ag0 = 1 / dt;
  const hist = new Float64Array(m + 2);
  const cond = [{ kind: "current", V: 0, I: 12 }];
  for (let k = 1; k < m; k++) cond.push({ kind: "voltage", V: k === 1 ? -3 : 3, I: 0 });

  const res = stack.solveCoupled({
    ag0, hist, cond, R,
    J: mech.J, damping: mech.damping || 0, loadTorque: mech.loadTorque || 0,
    warm: { A: [null], i: new Float64Array(m), omega: 0, theta: 0.1 },
    tol: 1e-7, tolField: 1e-7, maxIter: 30,
  });

  assert.ok(res.converged, `did not converge (iters=${res.iters})`);
  assert.ok(res.fieldResid < 1e-6 && res.redResid < 1e-6, "residuals");
  assert.ok(Math.abs(res.i[0] - 12) < 1e-9, `imposed current not held: i[0]=${res.i[0]}`);
});
