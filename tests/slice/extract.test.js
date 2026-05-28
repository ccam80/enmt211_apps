"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const F = require("./_fixtures.js");
const LIB = F.LIB;
const initSolver = F.initSolver;
const sectionFromConfig = F.sectionFromConfig;
const polesFromConfig = F.polesFromConfig;
const feaOpts = F.feaOpts;
const woundConfig = F.woundConfig;
const pmConfig = F.pmConfig;
const salientConfig = F.salientConfig;

// 3-phase wound config used by symmetry + self-inductance tests.
function woundConfig3ph() {
  return {
    grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
    poles: 2,
    rings: [
      {
        member: "stator",
        element: "W",
        rRange: [0.052, 0.06],
        winding: { standard: { m: 3, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
        muR: 1000,
      },
      {
        member: "rotor",
        element: "I",
        rRange: [0.04, 0.048],
        teeth: 2,
        muR: 1000,
      },
    ],
    circuits: [
      { terminal: { type: "DC", amp: 0.0 }, commutation: { mode: "none" }, R: 1.0 },
      { terminal: { type: "DC", amp: 0.0 }, commutation: { mode: "none" }, R: 1.0 },
      { terminal: { type: "DC", amp: 0.0 }, commutation: { mode: "none" }, R: 1.0 },
    ],
    stack: { slices: 1 },
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
  };
}

describe("MotorSlice extractCoeffs (Wave 5.3)", function () {
  before(async function () { await initSolver(); });

  // -----------------------------------------------------------------------
  it("extractCoeffs shape: L, dLdth length m*m; lambdaPm, dLambdaPmdth length m; all finite", function () {
    const cfg = woundConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const coeffs = slice.extractCoeffs(0.2);
    assert.strictEqual(coeffs.L.length, m * m,
      `L.length must be m*m=${m * m}; got ${coeffs.L.length}`);
    assert.strictEqual(coeffs.dLdth.length, m * m,
      `dLdth.length must be m*m=${m * m}`);
    assert.strictEqual(coeffs.lambdaPm.length, m,
      `lambdaPm.length must be m=${m}`);
    assert.strictEqual(coeffs.dLambdaPmdth.length, m,
      `dLambdaPmdth.length must be m=${m}`);
    for (let i = 0; i < m * m; i++) {
      assert.ok(Number.isFinite(coeffs.L[i]),
        `L[${i}]=${coeffs.L[i]} must be finite`);
      assert.ok(Number.isFinite(coeffs.dLdth[i]),
        `dLdth[${i}]=${coeffs.dLdth[i]} must be finite`);
    }
    for (let i = 0; i < m; i++) {
      assert.ok(Number.isFinite(coeffs.lambdaPm[i]),
        `lambdaPm[${i}]=${coeffs.lambdaPm[i]} must be finite`);
      assert.ok(Number.isFinite(coeffs.dLambdaPmdth[i]),
        `dLambdaPmdth[${i}]=${coeffs.dLambdaPmdth[i]} must be finite`);
    }
  });

  // -----------------------------------------------------------------------
  it("L is symmetric (reciprocity, linear material)", function () {
    const cfg = woundConfig3ph();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const coeffs = slice.extractCoeffs(0.2);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        const Lij = coeffs.L[i * m + j];
        const Lji = coeffs.L[j * m + i];
        const denom = Math.max(Math.abs(Lij), Math.abs(Lji), 1e-30);
        const rel = Math.abs(Lij - Lji) / denom;
        assert.ok(rel < 1e-6,
          `L[${i}][${j}]=${Lij} vs L[${j}][${i}]=${Lji}; rel diff=${rel} must be < 1e-6`);
      }
    }
  });

  // -----------------------------------------------------------------------
  it("L_self > 0 for every circuit (3-phase config)", function () {
    const cfg = woundConfig3ph();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const coeffs = slice.extractCoeffs(0.2);
    for (let k = 0; k < m; k++) {
      const Lkk = coeffs.L[k * m + k];
      assert.ok(Lkk > 0,
        `L_self for circuit ${k}: ${Lkk} must be > 0`);
    }
  });

  // -----------------------------------------------------------------------
  it("magnet-free section → lambdaPm and dLambdaPmdth are strictly 0 (zero-not-skip)", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const coeffs = slice.extractCoeffs(0.2);
    for (let k = 0; k < m; k++) {
      assert.strictEqual(coeffs.lambdaPm[k], 0,
        `magnet-free section: lambdaPm[${k}] must be exactly 0; got ${coeffs.lambdaPm[k]}`);
      assert.strictEqual(coeffs.dLambdaPmdth[k], 0,
        `magnet-free section: dLambdaPmdth[${k}] must be exactly 0; got ${coeffs.dLambdaPmdth[k]}`);
    }
  });

  // -----------------------------------------------------------------------
  it("PM section → lambdaPm changes with θ", function () {
    const cfg = pmConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const lam0 = slice.extractCoeffs(0.0).lambdaPm;
    const lam5 = slice.extractCoeffs(0.5).lambdaPm;
    let maxDiff = 0;
    for (let k = 0; k < lam0.length; k++) {
      const d = Math.abs(lam0[k] - lam5[k]);
      if (d > maxDiff) maxDiff = d;
    }
    assert.ok(maxDiff > 1e-9,
      `lambdaPm must change with θ on PM section; maxDiff=${maxDiff}`);
  });

  // -----------------------------------------------------------------------
  it("dLdth from extract matches central-difference of L from independent recomputation", function () {
    const cfg = salientConfig();
    const poles = polesFromConfig(cfg);
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: poles })
    );
    const m = slice.nCircuits;
    // The extract call internally central-differences over its derivStep, so
    // the independent reconstruction must use the SAME step to be the same
    // difference quotient (the machine-aware default per the 2026-05-27
    // derivStep amendment).
    const h = Math.PI / (poles * 1e5);
    const theta = 0.3;

    // The extract call at θ=0.3 with the default derivStep internally
    // computes plus@0.3+h, center@0.3, minus@0.3-h. We verify by calling
    // extract three independent times at offset angles and reconstructing
    // the central difference from their CENTER values.
    const coeffsCenter = slice.extractCoeffs(theta);
    const cPlus  = slice.extractCoeffs(theta + h);
    const cMinus = slice.extractCoeffs(theta - h);

    for (let k = 0; k < m * m; k++) {
      const dLdth_recompute = (cPlus.L[k] - cMinus.L[k]) / (2 * h);
      const dLdth_extract   = coeffsCenter.dLdth[k];
      const denom = Math.max(Math.abs(dLdth_extract), Math.abs(dLdth_recompute), 1e-30);
      const rel = Math.abs(dLdth_extract - dLdth_recompute) / denom;
      assert.ok(rel < 1e-6,
        `central-difference of L vs dLdth from extract at index ${k}: ` +
        `recompute=${dLdth_recompute} extract=${dLdth_extract} rel=${rel} must be < 1e-6`);
    }
  });

  // -----------------------------------------------------------------------
  it("Schur path handles all three probe angles (3 dense Schur factors per extract, (m+1) RHS each)", function () {
    // §9-G5 (authorized 2026-05-29 #2): extractCoeffs goes through the
    // Lagrange-augmented Schur path. K_b' is factored ONCE at create-time
    // (not per phi, and no new FeaSolver instance is created during extract);
    // per phi we prepare only the small dense -S(phi). Per phi we solve (m+1)
    // RHS — one magnetization-only + m unit-current — all reusing the same
    // create-time K_b' factor and the same -S(phi) factor.
    const cfg = woundConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const internals = slice.__internals;

    // Preserve the original §873 intent: no second LIB.FeaSolver.create and
    // no per-angle re-factorization of the create-time K_b' Schur factor.
    const realCreate = LIB.FeaSolver.create;
    let createCalls = 0;
    LIB.FeaSolver.create = function () {
      createCalls++;
      return realCreate.apply(this, arguments);
    };

    let prepDelta, solveDelta;
    try {
      const prepBefore  = internals.schurPrepCount;
      const solveBefore = internals.schurSolveCount;
      slice.extractCoeffs(0.2);
      prepDelta  = internals.schurPrepCount  - prepBefore;
      solveDelta = internals.schurSolveCount - solveBefore;
    } finally {
      LIB.FeaSolver.create = realCreate;
    }

    assert.strictEqual(createCalls, 0,
      `extractCoeffs must NOT create a second FeaSolver instance; got ${createCalls} create calls`);
    assert.strictEqual(prepDelta, 3,
      `extractCoeffs must prepare the dense Schur factor 3 times (one per angle); got ${prepDelta}`);
    assert.strictEqual(solveDelta, 3 * (m + 1),
      `extractCoeffs must call linearSchurSolve 3*(m+1)=${3 * (m + 1)} times; got ${solveDelta}`);
  });

  // -----------------------------------------------------------------------
  it("derivStep override is honored at the unit level (gapStampLog records actual angles)", function () {
    const cfg = woundConfig();
    const poles = polesFromConfig(cfg);
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: poles })
    );
    const internals = slice.__internals;
    const gapStampLog = internals.gapStampLog;

    // Override derivStep = Math.PI/360 at θ=0.3
    const prepBefore1 = internals.schurPrepCount;
    slice.extractCoeffs(0.3, { derivStep: Math.PI / 360 });
    const prepDelta1 = internals.schurPrepCount - prepBefore1;
    assert.strictEqual(gapStampLog.length, 3,
      `gapStampLog must record exactly 3 angles; got ${gapStampLog.length}: ${gapStampLog}`);
    const expectedOverride = [0.3 - Math.PI / 360, 0.3, 0.3 + Math.PI / 360];
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(gapStampLog[i] - expectedOverride[i]) < 1e-12,
        `gapStampLog[${i}]=${gapStampLog[i]} must equal ${expectedOverride[i]}`);
    }
    assert.strictEqual(prepDelta1, 3,
      `Schur factor must be prepared exactly 3 times for the override extract; got ${prepDelta1}`);

    // Default derivStep — extract clears gapStampLog at the start of each call.
    const prepBefore2 = internals.schurPrepCount;
    slice.extractCoeffs(0.3);
    const prepDelta2 = internals.schurPrepCount - prepBefore2;
    assert.strictEqual(gapStampLog.length, 3,
      `gapStampLog must record exactly 3 angles in the default extract; got ${gapStampLog.length}: ${gapStampLog}`);
    const hDefault = Math.PI / (poles * 1e5);
    const expectedDefault = [0.3 - hDefault, 0.3, 0.3 + hDefault];
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(gapStampLog[i] - expectedDefault[i]) < 1e-12,
        `gapStampLog[${i}]=${gapStampLog[i]} must equal default ${expectedDefault[i]}`);
    }
    assert.strictEqual(prepDelta2, 3,
      `Schur factor must be prepared exactly 3 times for the default extract; got ${prepDelta2}`);
  });

  // -----------------------------------------------------------------------
  it("derivStep override is validated to [1e-7, π/(10·poles)] (throws out of range)", function () {
    const cfg = woundConfig();
    const poles = polesFromConfig(cfg);
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: poles })
    );
    const hMax = Math.PI / (10 * poles);

    // Below the lower bound 1e-7 → throw.
    assert.throws(
      function () { slice.extractCoeffs(0.3, { derivStep: 1e-8 }); },
      /derivStep .* out of range/,
      "derivStep below 1e-7 must throw");

    // Above the upper bound π/(10·poles) → throw.
    assert.throws(
      function () { slice.extractCoeffs(0.3, { derivStep: hMax * 1.5 }); },
      /derivStep .* out of range/,
      "derivStep above π/(10·poles) must throw");

    // In-range values do not throw (exactly at both bounds + an interior point).
    assert.doesNotThrow(
      function () { slice.extractCoeffs(0.3, { derivStep: 1e-7 }); },
      "derivStep at lower bound 1e-7 must not throw");
    assert.doesNotThrow(
      function () { slice.extractCoeffs(0.3, { derivStep: hMax }); },
      "derivStep at upper bound π/(10·poles) must not throw");
  });

  // -----------------------------------------------------------------------
  it("round rotor → dL/dθ ≈ 0 (correctness) AND derived derivStep is round-off-clean", function () {
    // CORRECTNESS REQUIREMENT (spec 2026-05-29 #4, reinstating the original
    // 2026-05-27 intent): a geometrically round iron rotor has a
    // rotationally-invariant air gap, so its self/mutual inductances are
    // rotor-angle-independent and analytic dL/dθ = 0 exactly. The §9
    // harmonic sliding-gap engine currently VIOLATES this — it fabricates a
    // ~3.4e-3·|L| per-radian round-rotor ripple (a spurious reluctance
    // torque) that is step-independent and does NOT shrink with mesh or
    // harmonic refinement (K-sweep erratic; |L| destabilises 10× at K=36/72).
    // That is a real harmonic-gap coupling/conditioning defect (leading
    // hypothesis: broken cos-k/sin-k isotropy in the discrete DtN block),
    // NOT design intent. Step 2 below is the HONEST FAILING SIGNAL that
    // tracks this defect; it is expected RED until the coupling is fixed,
    // at which point the bound is recalibrated to the achievable floor.
    // Step 1 (step-independence) is a separate, legitimately-passing check
    // that the derived default derivStep does not amplify round-off.
    const roundRotorCfg = {
      grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
      poles: 2,
      rings: [
        {
          member: "rotor",
          element: "I",
          rRange: [0.04, 0.048],
          muR: 1000,
        },
        {
          member: "stator",
          element: "W",
          rRange: [0.052, 0.06],
          winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
          muR: 1000,
        },
      ],
      circuits: [
        { terminal: { type: "DC", amp: 5.0 }, commutation: { mode: "none" }, R: 1.0 },
      ],
      stack: { slices: 1 },
      mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
    };
    const poles = polesFromConfig(roundRotorCfg);
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(roundRotorCfg),
      feaOpts({ poles: poles })
    );
    const m = slice.nCircuits;

    // --- Step 1: step-independence (round-off immunity of the derived step).
    // Default step = π/(poles·1e5). Coarse step is ~1000×-class and drawn
    // from the 2026-05-29 #3 amendment's own ratified probe set
    // {π/(2·1e5), π/180, π/360}: we use π/360 (≈556× the default here). The
    // amendment's illustrative "π/(poles·1e2)" lands at 1.0027e-3 — a pure
    // h²-truncation miss of the 1e-3 bound by 0.27%, NOT round-off (finer
    // steps converge monotonically); π/360 from the same probe set agrees at
    // ~3e-4. Round-off would instead diverge as ε·|L|/h at finer steps, so a
    // coarse step agreeing this tightly proves the derived step is clean.
    const hDefault = Math.PI / (poles * 1e5);
    const hCoarse  = Math.PI / 360;
    const hMin = 1e-7;
    const hMax = Math.PI / (10 * poles);
    assert.ok(hDefault >= hMin && hDefault <= hMax,
      `default derivStep ${hDefault} must be inside [${hMin}, ${hMax}]`);
    assert.ok(hCoarse >= hMin && hCoarse <= hMax,
      `coarse derivStep ${hCoarse} must be inside [${hMin}, ${hMax}]`);

    const coeffsDefault = slice.extractCoeffs(0.3); // default derivStep
    const coeffsCoarse  = slice.extractCoeffs(0.3, { derivStep: hCoarse });

    for (let k = 0; k < m * m; k++) {
      const a = coeffsDefault.dLdth[k];
      const b = coeffsCoarse.dLdth[k];
      // Small absolute floor in the denominator guards divide-by-zero,
      // consistent with the relative comparisons elsewhere in this file.
      const denom = Math.max(Math.abs(a), Math.abs(b), 1e-30);
      const rel = Math.abs(a - b) / denom;
      assert.ok(rel < 1e-3,
        `derived step must be round-off-clean: dLdth[${k}] default=${a} ` +
        `coarse=${b} rel=${rel} must be < 1e-3 (round-off would diverge ` +
        `by orders of magnitude)`);
    }

    // --- Step 2: round-rotor dL/dθ = 0 CORRECTNESS gate (honest failing
    // signal for the harmonic-gap defect — see header). A round rotor must
    // produce zero reluctance variation; we require it to within 1e-12·|L|
    // (the original 2026-05-27 spec bound). The engine currently measures
    // ~3.4e-3, so this assertion FAILS by design until the coupling defect
    // is fixed. Do NOT loosen this to make the suite green — that masks the
    // bug. Recalibrate the bound to the achievable floor once the
    // harmonic-gap coupling is corrected.
    let Lscale = 0;
    for (let k = 0; k < m * m; k++) {
      const a = Math.abs(coeffsDefault.L[k]);
      if (a > Lscale) Lscale = a;
    }
    assert.ok(Lscale > 0, `round-rotor L must be non-trivial; |L|max=${Lscale}`);

    for (let k = 0; k < m * m; k++) {
      const rel = Math.abs(coeffsDefault.dLdth[k]) / Lscale;
      assert.ok(rel < 1e-12,
        `round rotor dL/dθ must be 0 to within 1e-12·|L| (correctness — a round ` +
        `rotor has no reluctance variation); dLdth[${k}]=${coeffsDefault.dLdth[k]} ` +
        `rel=${rel}. A nonzero value is a harmonic-gap coupling defect (spurious ` +
        `reluctance torque), NOT something to loosen away.`);
    }
  });
});

