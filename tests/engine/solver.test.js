"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const LIB = require("../_shim.js");
const { assertClose, SALIENT_DEFAULTS, buildSalient } = require("./_fixtures.js");

test("matvec annihilates constants", () => {
  const { op } = buildSalient(SALIENT_DEFAULTS);
  const N = op.Nr * op.Ntheta;
  // All-ones vector
  const ones = new Float64Array(N).fill(1);
  const out = op.matvec(ones);
  // Away from the pinned node (index 0), the discrete −∇·(ν∇·) annihilates constants
  let maxAbs = 0;
  for (let idx = 1; idx < N; idx++) {
    const a = Math.abs(out[idx]);
    if (a > maxAbs) maxAbs = a;
  }
  assert.ok(maxAbs < 1e-9, `matvec(ones) max away from pin = ${maxAbs}, expected < 1e-9`);
});

test("diagonal equals aP", () => {
  const { op } = buildSalient(SALIENT_DEFAULTS);
  const N = op.Nr * op.Ntheta;
  const diag = op.diagonal();
  // Verify via matvec on unit vectors: for each entry, matvec(e_k)[k] should equal diag[k]
  // For efficiency, check that matvec(ones) agrees entrywise with sum of rows,
  // and that diagonal is what matvec returns on the identity basis for a sample of indices.
  // We check a representative sample (every 32nd cell + pinned node).
  const step = 32;
  for (let idx = 0; idx < N; idx += step) {
    const ek = new Float64Array(N);
    ek[idx] = 1;
    const Aek = op.matvec(ek);
    // The diagonal entry is Aek[idx] (A·e_k)_k = A_kk
    assertClose(diag[idx], Aek[idx], 1e-12, `diagonal[${idx}] vs matvec(e_${idx})[${idx}]`);
  }
  // Pinned node: diag[0] = 1 (identity row)
  assert.equal(diag[0], 1);
});

test("getReluctivity / setIronReluctivity round-trip", () => {
  const { op, ironMask } = buildSalient(SALIENT_DEFAULTS);
  const N = op.Nr * op.Ntheta;

  // Snapshot original reluctivity
  const nu0 = op.getReluctivity();

  // Modify: double the iron cells' nu
  const modified = nu0.slice();
  for (let idx = 0; idx < N; idx++) {
    if (ironMask[idx]) modified[idx] = nu0[idx] * 2;
  }

  // Apply
  op.setIronReluctivity(modified, ironMask);
  const nuAfter = op.getReluctivity();

  // Iron cells should match modified
  for (let idx = 0; idx < N; idx++) {
    if (ironMask[idx]) {
      assertClose(nuAfter[idx], modified[idx], 1e-12, `iron cell ${idx} after setIronReluctivity`);
    }
  }

  // Non-iron cells should be unchanged
  for (let idx = 0; idx < N; idx++) {
    if (!ironMask[idx]) {
      assertClose(nuAfter[idx], nu0[idx], 1e-12, `non-iron cell ${idx} unchanged`);
    }
  }

  // matvec should differ from the pre-change result on at least one entry
  const x = new Float64Array(N);
  for (let idx = 0; idx < N; idx++) x[idx] = Math.sin(idx * 0.1);
  // Solve at modified state
  op.setIronReluctivity(modified, ironMask);
  const mvModified = op.matvec(x);
  // Restore and solve at original
  op.setIronReluctivity(nu0, ironMask);
  const mvRestored = op.matvec(x);

  let anyDiff = false;
  for (let idx = 1; idx < N; idx++) {
    if (Math.abs(mvModified[idx] - mvRestored[idx]) > 1e-20) { anyDiff = true; break; }
  }
  assert.ok(anyDiff, "matvec should differ after setIronReluctivity with doubled iron nu");

  // Restore and verify round-trip
  op.setIronReluctivity(nu0, ironMask);
  const nuRestored = op.getReluctivity();
  for (let idx = 0; idx < N; idx++) {
    assertClose(nuRestored[idx], nu0[idx], 1e-12, `round-trip cell ${idx}`);
  }
});

test("pcg converges to tol", () => {
  const { op, Jz } = buildSalient(SALIENT_DEFAULTS);
  const b = op.assembleRHS({ Jz });
  const { residual } = LIB.AirgapSolve.pcg(op, b, { tol: 1e-6, maxIter: 3000 });
  assert.ok(residual <= 1e-6, `relative residual ${residual} should be <= 1e-6`);
});

test("warm-start cuts iterations", () => {
  // Use a near-uniform fixture (a2=0.001) where a one-cell rotor step is a
  // tiny perturbation: the pre-step solution is already very close, so the
  // warm-started PCG converges in far fewer iterations than the cold solve
  // and satisfies warm.iters < Ntheta.
  const warmParams = Object.assign({}, SALIENT_DEFAULTS, { a2: 0.001 });
  const { op, Jz } = buildSalient(warmParams);
  const Ntheta = op.Ntheta;
  const maxIter = 5000;

  // Solve at thetaR=0 (cold)
  const b0 = op.assembleRHS({ Jz });
  const cold = LIB.AirgapSolve.pcg(op, b0, { x0: null, tol: 1e-6, maxIter });

  // Advance one angular cell and warm-start from the pre-step solution
  op.setRotorAngle(op.dtheta);
  const b1 = op.assembleRHS({ Jz });
  const warm = LIB.AirgapSolve.pcg(op, b1, { x0: cold.x, tol: 1e-6, maxIter });

  assert.ok(
    warm.iters < cold.iters,
    `warm.iters ${warm.iters} should be < cold.iters ${cold.iters}`
  );
  assert.ok(
    warm.iters <= 0.5 * cold.iters,
    `warm.iters ${warm.iters} should be <= 0.5 * cold.iters ${0.5 * cold.iters}`
  );
  assert.ok(
    warm.iters < Ntheta,
    `warm.iters ${warm.iters} should be < Ntheta ${Ntheta}`
  );
});

test("ceiling is identity below the knee", () => {
  const { op, Jz, ironMask } = buildSalient(SALIENT_DEFAULTS);
  // Use a small current source so Bpeak stays well below the knee (1.6 T)
  // The fixture Jz is air-gap only so fields are small; use a very small scale
  const smallJz = new Float64Array(Jz.length);
  for (let i = 0; i < Jz.length; i++) smallJz[i] = Jz[i] * 1e-6;
  const b = op.assembleRHS({ Jz: smallJz });
  const { satScale, iters } = LIB.AirgapSolve.solveSaturated(op, b, {
    ceiling: { enabled: true, Bknee: 1.6, p: 2, ironMask },
  });
  assert.equal(satScale, 1, `satScale should be 1 when Bpeak < Bknee, got ${satScale}`);
});

test("ceiling reduces Bpeak above the knee", () => {
  const { op, Jz, ironMask } = buildSalient(SALIENT_DEFAULTS);
  // Scale the source so Bpeak exceeds 1.6 T.
  // With nu0 = 1/MU0 ≈ 796000 and small gap, even unit Jz gives small B.
  // We scale Jz heavily to force B >> Bknee in the iron-masked cells.
  const Bknee = 1.6;
  // First find what scale pushes Bpeak above Bknee by solving with base
  // and checking; we use a fixed large scale factor.
  const scaleJz = new Float64Array(Jz.length);
  for (let i = 0; i < Jz.length; i++) scaleJz[i] = Jz[i] * 1e6;
  const b = op.assembleRHS({ Jz: scaleJz });

  // Solve unceilinged first to get Bpeak
  const baseResult = LIB.AirgapSolve.pcg(op, b, { tol: 1e-6 });
  const { Br: Br0, Bt: Bt0 } = op.field(baseResult.x);
  let Bpeak_base = 0;
  for (let idx = 0; idx < ironMask.length; idx++) {
    if (ironMask[idx]) {
      const Bmag = Math.hypot(Br0[idx], Bt0[idx]);
      if (Bmag > Bpeak_base) Bpeak_base = Bmag;
    }
  }

  // Only run this assertion if base Bpeak is actually above the knee
  if (Bpeak_base <= Bknee) {
    // Increase scale further and try again — use scaleJz * 1e4 more
    for (let i = 0; i < scaleJz.length; i++) scaleJz[i] *= 1e4;
    const b2 = op.assembleRHS({ Jz: scaleJz });
    const base2 = LIB.AirgapSolve.pcg(op, b2, { tol: 1e-6 });
    const { Br: Br2, Bt: Bt2 } = op.field(base2.x);
    let Bp2 = 0;
    for (let idx = 0; idx < ironMask.length; idx++) {
      if (ironMask[idx]) {
        const Bmag = Math.hypot(Br2[idx], Bt2[idx]);
        if (Bmag > Bp2) Bp2 = Bmag;
      }
    }
    assert.ok(Bp2 > Bknee, `Could not drive Bpeak above Bknee for ceiling test: Bpeak=${Bp2}`);

    const ceiledResult = LIB.AirgapSolve.solveSaturated(op, b2, {
      ceiling: { enabled: true, Bknee, p: 2, ironMask },
    });
    assert.ok(ceiledResult.satScale > 1, `satScale ${ceiledResult.satScale} should be > 1`);
    const { Br: BrC, Bt: BtC } = op.field(ceiledResult.x);
    let BpeakCeiled = 0;
    for (let idx = 0; idx < ironMask.length; idx++) {
      if (ironMask[idx]) {
        const Bmag = Math.hypot(BrC[idx], BtC[idx]);
        if (Bmag > BpeakCeiled) BpeakCeiled = Bmag;
      }
    }
    assert.ok(BpeakCeiled < Bp2, `ceilinged Bpeak ${BpeakCeiled} should be < unceilinged ${Bp2}`);
    return;
  }

  const ceiledResult = LIB.AirgapSolve.solveSaturated(op, b, {
    ceiling: { enabled: true, Bknee, p: 2, ironMask },
  });
  assert.ok(ceiledResult.satScale > 1, `satScale ${ceiledResult.satScale} should be > 1`);

  const { Br: BrC, Bt: BtC } = op.field(ceiledResult.x);
  let BpeakCeiled = 0;
  for (let idx = 0; idx < ironMask.length; idx++) {
    if (ironMask[idx]) {
      const Bmag = Math.hypot(BrC[idx], BtC[idx]);
      if (Bmag > BpeakCeiled) BpeakCeiled = Bmag;
    }
  }
  assert.ok(BpeakCeiled < Bpeak_base, `ceilinged Bpeak ${BpeakCeiled} should be < unceilinged ${Bpeak_base}`);
});
