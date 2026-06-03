"use strict";

// =============================================================================
//  Monolithic-Newton slice-border correctness gate.
//
//  The coupled field-circuit-motion Newton condenses the field block using
//  three borders exposed by the slice. Each is verified here node-by-node
//  against a central difference of the corresponding forward quantity:
//    (a) ∂T/∂A      (coupledDTdAInto)        vs d/dA of coupledAssemble's torque
//    (b) ∂R_field/∂i = −uRHS (coupledUnitRhsInto) vs d/di of coupledFieldResidual
//    (c) ∂λ_k/∂A = ell·uRHS  (the flux-pickup factor is exactly ell)
//  All three must agree to the FD truncation floor.
// =============================================================================

const { test, before } = require("node:test");
const assert = require("node:assert");
const F = require("./_fixtures.js");
const LIB = F.LIB, CS = F.UnifiedMotor.ConfigSchema;

before(async () => { await F.initSolver(); });

test("coupled-Newton slice borders match central differences (pmsm)", () => {
  const stack = LIB.MotorStack.create(CS.expand(F.byId["pmsm"].config));
  const slice = stack.slices[0];
  const n = slice.__internals.globalLayout.n, m = slice.nCircuits;
  const ell = slice.__internals.ell;

  const A = new Float64Array(n);
  for (let i = 0; i < n; i++) A[i] = 0.02 * Math.sin(1.7 * i + 0.5);
  const cur = new Float64Array(m);
  for (let k = 0; k < m; k++) cur[k] = 8 * Math.cos(k * 2.1);
  const th = 0.41, eps = 1e-7;

  // (a) ∂T/∂A
  const gT = new Float64Array(n);
  slice.coupledAssemble(A, cur, th);
  slice.coupledDTdAInto(th, gT);
  const idxByG = Array.from({ length: n }, (_, i) => i).sort((a, b) => Math.abs(gT[b]) - Math.abs(gT[a]));
  let maxRelT = 0;
  for (const j of idxByG.slice(0, 8)) {
    A[j] += eps; const Tp = slice.coupledAssemble(A, cur, th);
    A[j] -= 2 * eps; const Tm = slice.coupledAssemble(A, cur, th);
    A[j] += eps;
    const fd = (Tp - Tm) / (2 * eps);
    maxRelT = Math.max(maxRelT, Math.abs(gT[j] - fd) / (Math.abs(fd) + 1e-9));
  }
  assert.ok(maxRelT < 1e-4, `∂T/∂A vs FD max rel ${maxRelT.toExponential(2)}`);

  // (b) ∂R_field/∂i_0 = −uRHS_0
  slice.coupledAssemble(A, cur, th);
  const u0 = new Float64Array(n);
  slice.coupledUnitRhsInto(0, th, u0);
  const rP = new Float64Array(n), rM = new Float64Array(n);
  cur[0] += eps; slice.coupledFieldResidualInto(A, cur, th, rP);
  cur[0] -= 2 * eps; slice.coupledFieldResidualInto(A, cur, th, rM);
  cur[0] += eps;
  const idxByU = Array.from({ length: n }, (_, i) => i).sort((a, b) => Math.abs(u0[b]) - Math.abs(u0[a]));
  let maxRelR = 0;
  for (const j of idxByU.slice(0, 8)) {
    const fd = (rP[j] - rM[j]) / (2 * eps);
    maxRelR = Math.max(maxRelR, Math.abs((-u0[j]) - fd) / (Math.abs(fd) + 1e-9));
  }
  assert.ok(maxRelR < 1e-4, `∂R_field/∂i_0 vs FD max rel ${maxRelR.toExponential(2)}`);

  // (c) ∂λ_0/∂A = ell·uRHS_0 (flux-pickup factor exactly ell)
  const lamP = new Float64Array(m), lamM = new Float64Array(m);
  let maxRelL = 0;
  for (const j of idxByU.slice(0, 6)) {
    A[j] += eps; slice.coupledFluxInto(A, th, lamP);
    A[j] -= 2 * eps; slice.coupledFluxInto(A, th, lamM);
    A[j] += eps;
    const dlam = (lamP[0] - lamM[0]) / (2 * eps);
    maxRelL = Math.max(maxRelL, Math.abs(ell * u0[j] - dlam) / (Math.abs(dlam) + 1e-12));
  }
  assert.ok(maxRelL < 1e-4, `∂λ_0/∂A = ell·uRHS_0 vs FD max rel ${maxRelL.toExponential(2)}`);
});
