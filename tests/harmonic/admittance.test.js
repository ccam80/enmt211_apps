"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  AH,
  uniformCircle,
  manufactured,
  annulusOracle,
  denseSolveSPD,
  relErrInf,
} = require("./_fixtures.js");

const TWO_PI = 2 * Math.PI;
const MU0 = 4 * Math.PI * 1e-7;

// Build a standard test harness: K=6, N=32, r_mr=0.042, r_ms=0.044
const K_TEST  = 6;
const NGR     = 32;
const NGS     = 32;
const R_MR    = 0.040;
const R_MS    = 0.045;
const ELL     = 0.080;

function buildTestGap() {
  const rotor  = uniformCircle(NGR, R_MR);
  const stator = uniformCircle(NGS, R_MS);
  return AH.build(rotor, stator, { K: K_TEST, ell: ELL });
}

// Manufactured field with mixed harmonics (k=1,2,3) for both cos and sin
// Interior coefficients (r^k terms, rotor-side) and exterior (r^{-k}, stator-side)
const MFD_COEFFS = {
  a0: 0.5,
  b0: 0.0,
  ac: [0, 1.2,  0.4, -0.3],
  bc: [0, 0.3,  0.8,  0.2],
  as: [0, 0.7, -0.5,  0.15],
  bs: [0, 0.2,  0.3, -0.1],
};

describe("M_k is symmetric for each k", function () {
  it("|M[0][1] - M[1][0]| < 1e-12 for k=1..K", function () {
    const hg = buildTestGap();
    for (let k = 1; k <= K_TEST; k++) {
      const M = hg._internals.Mk(k);
      const diff = Math.abs(M[0][1] - M[1][0]);
      assert.ok(diff < 1e-12, `k=${k}: |M[0][1]-M[1][0]|=${diff} >= 1e-12`);
    }
  });
});

describe("M_k is positive-definite for k >= 1", function () {
  it("det(M_k) > 0 and trace(M_k) > 0 for k=1..K", function () {
    const hg = buildTestGap();
    for (let k = 1; k <= K_TEST; k++) {
      const M = hg._internals.Mk(k);
      const det  = M[0][0] * M[1][1] - M[0][1] * M[1][0];
      const trace = M[0][0] + M[1][1];
      assert.ok(det   > 0, `k=${k}: det(M)=${det} not > 0`);
      assert.ok(trace > 0, `k=${k}: trace(M)=${trace} not > 0`);
    }
  });
});

describe("surfaceFlux matches the analytic dA/dr", function () {
  it("relErrInf < 1e-6 on each circle vs analytic (1/mu0)·dA/dr", function () {
    const hg = buildTestGap();
    const field = manufactured(MFD_COEFFS);

    const rotorTheta  = uniformCircle(NGR, R_MR).gapTheta;
    const statorTheta = uniformCircle(NGS, R_MS).gapTheta;

    const Arotor  = field.sample(R_MR, rotorTheta);
    const Astator = field.sample(R_MS, statorTheta);

    const { rotor: fluxR, stator: fluxS } = hg.surfaceFlux(Arotor, Astator, 0);

    // Analytic flux: surfaceFlux uses the Galerkin (weak-form) DtN which returns
    // r·(1/mu0)·∂A/∂n at each boundary circle.
    // Inner (rotor): outward normal = -r, so r·(1/mu0)·∂A/∂n = -R_MR·(1/mu0)·∂A/∂r
    // Outer (stator): outward normal = +r, so r·(1/mu0)·∂A/∂n = +R_MS·(1/mu0)·∂A/∂r
    const dAdr_rotor  = field.dAdr(R_MR, rotorTheta);
    const dAdr_stator = field.dAdr(R_MS, statorTheta);

    const analyticRotor  = new Float64Array(NGR);
    const analyticStator = new Float64Array(NGS);
    for (let i = 0; i < NGR; i++) analyticRotor[i]  = -R_MR * dAdr_rotor[i]  / MU0;
    for (let i = 0; i < NGS; i++) analyticStator[i] =  R_MS * dAdr_stator[i] / MU0;

    const errR = relErrInf(fluxR, analyticRotor);
    const errS = relErrInf(fluxS, analyticStator);

    assert.ok(errR < 1e-6, `rotor flux relErrInf=${errR} >= 1e-6`);
    assert.ok(errS < 1e-6, `stator flux relErrInf=${errS} >= 1e-6`);
  });
});

describe("surfaceFlux matches the independently-meshed annulus", function () {
  it("relErrInf < 2e-2 on each circle vs annulus oracle (nTheta=64, nRad=12)", function () {
    // Use the same nTheta on the harmonic gap as on the oracle so the two
    // discretisations sample the manufactured field at identical θ nodes.
    // The oracle's O(h²) bilinear-element error at nTheta=32, nRad=6 is
    // ~5–6% for this MFD (mixed harmonics up to k=3); per the phase-spec
    // 2026-05-27 amendment the 2% bar is preserved by tightening the
    // oracle mesh rather than widening the tolerance.
    const NTH = 64;
    const NRD = 12;
    const rotor  = uniformCircle(NTH, R_MR);
    const stator = uniformCircle(NTH, R_MS);
    const hg = AH.build(rotor, stator, { K: K_TEST, ell: ELL });
    const field = manufactured(MFD_COEFFS);

    const rotorTheta  = rotor.gapTheta;
    const statorTheta = stator.gapTheta;

    const Arotor  = field.sample(R_MR, rotorTheta);
    const Astator = field.sample(R_MS, statorTheta);

    const { rotor: fluxR, stator: fluxS } = hg.surfaceFlux(Arotor, Astator, 0);

    const oracle = annulusOracle({
      rIn: R_MR, rOut: R_MS,
      nTheta: NTH, nRad: NRD,
      ell: ELL, mu0: MU0,
    });
    const { fluxInner, fluxOuter } = oracle.solve(Arotor, Astator);

    const errR = relErrInf(fluxR, fluxInner);
    const errS = relErrInf(fluxS, fluxOuter);

    assert.ok(errR < 2e-2, `rotor flux vs oracle relErrInf=${errR} >= 2e-2`);
    assert.ok(errS < 2e-2, `stator flux vs oracle relErrInf=${errS} >= 2e-2`);
  });
});

describe("stamp(0) is symmetric", function () {
  it("for every triplet (i,j,v) there is a (j,i) triplet with equal v within 1e-12", function () {
    const hg = buildTestGap();
    const { n, I, J, V } = hg.stamp(0);

    // Accumulate (i,j) → sum of values
    const map = new Map();
    for (let t = 0; t < I.length; t++) {
      const key = I[t] + "," + J[t];
      map.set(key, (map.get(key) || 0) + V[t]);
    }

    // Check symmetry: for each (i,j,v) there exists (j,i,v') with |v-v'| < 1e-12
    let asymmetric = 0;
    map.forEach(function (v, key) {
      const [si, sj] = key.split(",");
      const sym_key = sj + "," + si;
      const v_sym = map.get(sym_key);
      if (v_sym === undefined || Math.abs(v - v_sym) > 1e-12) {
        asymmetric++;
      }
    });
    assert.strictEqual(asymmetric, 0, `Found ${asymmetric} asymmetric entries in stamp(0)`);
  });
});

describe("stamp reproduces surfaceFlux", function () {
  it("denseSolveSPD with pinned gap nodes recovers surfaceFlux within relErrInf < 1e-9", function () {
    const hg = buildTestGap();
    const field = manufactured(MFD_COEFFS);

    const rotorTheta  = uniformCircle(NGR, R_MR).gapTheta;
    const statorTheta = uniformCircle(NGS, R_MS).gapTheta;

    const Arotor  = field.sample(R_MR, rotorTheta);
    const Astator = field.sample(R_MS, statorTheta);

    // Reference from surfaceFlux
    const { rotor: refFluxR, stator: refFluxS } = hg.surfaceFlux(Arotor, Astator, 0);

    // Build the augmented system from stamp(0).
    //
    // DOF layout: x = [gapRotor(NGR) | gapStator(NGS) | harmRotor(perBody) | harmStator(perBody)]
    //
    // The bordered system uses -M_k^{-1} in the harmonic block so that after solving
    // with Dirichlet gap values, the harmonic DOFs equal the surfaceFlux amplitudes:
    //   h_r[hIdx] = surfaceFlux rotor Fourier amplitude for that harmonic
    //   h_s[hIdx] = surfaceFlux stator Fourier amplitude for that harmonic
    //
    // Recovery: reconstruct the rotor and stator surfaceFlux from h_r and h_s.
    //   The layout within each perBody block is [a0, a1, b1, a2, b2, ..., aK, bK].
    //   So for rotor: a_flux[0]=h_r[0], a_flux[k]=h_r[2k-1], b_flux[k]=h_r[2k].

    const perBody = hg.dofMap.harmonics.perBody;
    const nHarm   = 2 * perBody;
    const nGap    = NGR + NGS;
    const nFree   = nHarm;
    const n       = hg.stamp(0).n;
    const { I, J, V } = hg.stamp(0);

    // Accumulate dense K from triplets
    const K_dense = new Float64Array(n * n);
    for (let t = 0; t < I.length; t++) {
      K_dense[I[t] * n + J[t]] += V[t];
    }

    // Extract K_ff (harmonic × harmonic) and K_fp (harmonic × gap)
    const K_ff = new Float64Array(nFree * nFree);
    const K_fp = new Float64Array(nFree * nGap);
    for (let i = 0; i < nFree; i++) {
      const gi = nGap + i;
      for (let j = 0; j < nFree; j++) {
        K_ff[i * nFree + j] = K_dense[gi * n + (nGap + j)];
      }
      for (let j = 0; j < nGap; j++) {
        K_fp[i * nGap + j] = K_dense[gi * n + j];
      }
    }

    // Prescribed gap-node values
    const x_p = new Float64Array(nGap);
    for (let j = 0; j < NGR; j++) x_p[j]       = Arotor[j];
    for (let j = 0; j < NGS; j++) x_p[NGR + j] = Astator[j];

    // RHS: f_f = -K_fp · x_p
    const f_f = new Float64Array(nFree);
    for (let i = 0; i < nFree; i++) {
      let s = 0;
      for (let j = 0; j < nGap; j++) s += K_fp[i * nGap + j] * x_p[j];
      f_f[i] = -s;
    }

    // Solve K_ff · x_f = f_f (K_ff is symmetric; use denseSolveSPD)
    const I_ff = new Int32Array(nFree * nFree);
    const J_ff = new Int32Array(nFree * nFree);
    const V_ff = new Float64Array(nFree * nFree);
    let cnt = 0;
    for (let i = 0; i < nFree; i++) {
      for (let j = 0; j < nFree; j++) {
        I_ff[cnt] = i; J_ff[cnt] = j; V_ff[cnt] = K_ff[i * nFree + j];
        cnt++;
      }
    }
    const x_f = denseSolveSPD(nFree, I_ff, J_ff, V_ff, f_f);

    // x_f[0..perBody-1] = rotor harmonic DOFs = surfaceFlux rotor Fourier amplitudes
    // x_f[perBody..2*perBody-1] = stator harmonic DOFs
    // Layout: [a0, a1_cos, a1_sin, a2_cos, a2_sin, ..., aK_cos, aK_sin]
    const K = hg.K;
    const a_fluxR = new Float64Array(K + 1);
    const b_fluxR = new Float64Array(K + 1);
    const a_fluxS = new Float64Array(K + 1);
    const b_fluxS = new Float64Array(K + 1);

    a_fluxR[0] = x_f[0];
    a_fluxS[0] = x_f[perBody];
    for (let k = 1; k <= K; k++) {
      a_fluxR[k] = x_f[2 * k - 1];
      b_fluxR[k] = x_f[2 * k];
      a_fluxS[k] = x_f[perBody + (2 * k - 1)];
      b_fluxS[k] = x_f[perBody + (2 * k)];
    }

    // Reconstruct nodal flux on each circle from the harmonic DOFs
    const fluxRotorStamp  = hg.reconstruct({ a: a_fluxR, b: b_fluxR }, rotorTheta);
    const fluxStatorStamp = hg.reconstruct({ a: a_fluxS, b: b_fluxS }, statorTheta);

    const errR = relErrInf(fluxRotorStamp,  refFluxR);
    const errS = relErrInf(fluxStatorStamp, refFluxS);

    assert.ok(errR < 1e-9, `stamp→rotor flux relErrInf=${errR} >= 1e-9`);
    assert.ok(errS < 1e-9, `stamp→stator flux relErrInf=${errS} >= 1e-9`);
  });
});
