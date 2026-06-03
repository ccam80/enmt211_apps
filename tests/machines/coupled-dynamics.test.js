"use strict";

// =============================================================================
//  Monolithic-Newton time-stepper gate (motor-run on stack.solveCoupled).
//
//  The full field-circuit-motion path: BDF over the flux state [λ,ω,θ], each
//  accepted sub-step ONE coupled Newton (no field⇄circuit splitting). This gate
//  spins a pmsm from rest and asserts the behaviour the old IMEX/fixed-point
//  path could not guarantee:
//    - finite, bounded trajectory (no runaway / NaN),
//    - every step's Newton converges (iters well under the cap),
//    - the field bundle built from the converged A (no re-solve) is consistent
//      with an independent field solve at the recovered (θ, i).
//
//  Slow by design — a real transient integration with per-sub-step field solves.
// =============================================================================

const { test, before } = require("node:test");
const assert = require("node:assert");
const F = require("./_fixtures.js");
const LIB = F.LIB, CS = F.UnifiedMotor.ConfigSchema;

before(async () => { await F.initSolver(); });

test("pmsm spins up cleanly under the monolithic coupled Newton", () => {
  const exp = CS.expand(F.byId["pmsm"].config);
  const rt = LIB.MotorRun.create(exp);

  const dt = 0.001, N = 5;
  let finite = true, maxIters = 0, maxAbsOmega = 0;
  for (let n = 0; n < N; n++) {
    rt.step(dt);
    const s = rt.state;
    if (![s.omega, s.theta, ...s.i].every(Number.isFinite)) { finite = false; break; }
    maxAbsOmega = Math.max(maxAbsOmega, Math.abs(s.omega));
    maxIters = Math.max(maxIters, rt.lastSolve.iters);
  }

  assert.ok(finite, "trajectory went non-finite (runaway/NaN)");
  assert.ok(maxAbsOmega < 1e4, `ω unbounded: max|ω|=${maxAbsOmega}`);
  assert.ok(maxIters > 0 && maxIters < 25, `Newton did not converge cleanly: maxIters=${maxIters}`);

  // The viz bundle (post-processed from the converged A, no re-solve) must agree
  // with an independent field solve at the recovered state.
  const s = rt.state;
  const chk = rt.stack.solve(s.theta, s.i);
  assert.ok(Math.abs(rt.lastSolve.torque - chk.torque) < 1e-6,
    `bundle vs solve torque mismatch: ${rt.lastSolve.torque} vs ${chk.torque}`);
});
