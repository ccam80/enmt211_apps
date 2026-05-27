"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
//  SPD-preserved test: verify CᵀKC is SPD when K is SPD and C is a
//  valid constraint interpolation matrix.
//
//  Spec: Build a tiny representative K (2D Laplacian on a small grid)
//  plus a manually-constructed C (constraint matrix), verify CᵀKC is SPD
//  and its condition number is bounded within 10× of K's condition number.
//
//  This test does NOT use MotorMesh — it tests the algebraic property
//  that the CᵀKC transformation preserves positive definiteness.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Helper: dense matrix operations (row-major, Float64Array)
// ---------------------------------------------------------------------------

function matmul(A, B, nA, nB, nC) {
  // A: nA × nB, B: nB × nC, result: nA × nC
  const C = new Float64Array(nA * nC);
  for (let i = 0; i < nA; i++) {
    for (let k = 0; k < nB; k++) {
      if (A[i * nB + k] === 0) continue;
      for (let j = 0; j < nC; j++) {
        C[i * nC + j] += A[i * nB + k] * B[k * nC + j];
      }
    }
  }
  return C;
}

function mattranspose(A, m, n) {
  // A: m × n → At: n × m
  const At = new Float64Array(n * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      At[j * m + i] = A[i * n + j];
    }
  }
  return At;
}

// Attempt LDL factorization of a symmetric matrix A (n×n), in-place on a copy.
// Returns { success, minPivot } where success = all pivots > 0.
function ldlCheck(A, n) {
  const L = Float64Array.from(A);
  let minPivot = Infinity;
  for (let j = 0; j < n; j++) {
    const pivot = L[j * n + j];
    if (pivot <= 1e-15) return { success: false, minPivot: pivot };
    if (pivot < minPivot) minPivot = pivot;
    for (let i = j + 1; i < n; i++) {
      const factor = L[i * n + j] / pivot;
      for (let k = j; k < n; k++) {
        L[i * n + k] -= factor * L[j * n + k];
      }
    }
  }
  return { success: true, minPivot };
}

// Estimate condition number: ratio of max/min pivot in LDL factorization.
function condEst(A, n) {
  const L = Float64Array.from(A);
  let maxP = -Infinity, minP = Infinity;
  for (let j = 0; j < n; j++) {
    const pivot = L[j * n + j];
    if (pivot > maxP) maxP = pivot;
    if (pivot < minP) minP = pivot;
    if (pivot <= 0) return Infinity;
    for (let i = j + 1; i < n; i++) {
      const fac = L[i * n + j] / pivot;
      for (let k = j; k < n; k++) L[i * n + k] -= fac * L[j * n + k];
    }
  }
  return minP > 0 ? maxP / minP : Infinity;
}

// ---------------------------------------------------------------------------
//  Build a symmetric positive definite K matrix of size N × N.
//
//  Use a shifted Laplacian: K = tridiag(-1, 4, -1) with wrap-around
//  PLUS a small diagonal shift δI to ensure strict positive definiteness.
//  The eigenvalues of the tridiagonal are λ_k = 4 - 2cos(πk/(N+1)) > 0,
//  but we also add δ=1 to be safe.
// ---------------------------------------------------------------------------
function buildSPDMatrix(N, delta) {
  delta = delta != null ? delta : 1.0;
  const K = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    K[i * N + i] = 4 + delta;
    if (i > 0)     { K[i * N + (i-1)] = -1; K[(i-1) * N + i] = -1; }
  }
  return K;
}

// ---------------------------------------------------------------------------
//  Build a constraint prolongation matrix C of size N_total × N_master.
//
//  C maps reduced (master) DOF vector x̂ to full DOF vector x = C·x̂.
//  Rows 0..N_master-1: identity (master DOFs are free).
//  Rows N_master..N_total-1: interpolation rows (slave DOFs constrained).
//
//  weights[k] = { leftIdx, rightIdx, w } for slave k.
//  Slave row = N_master + k; C[slave, leftIdx] = 1-w, C[slave, rightIdx] = w.
// ---------------------------------------------------------------------------
function buildC(nMasters, nSlaves, weights) {
  const N_total  = nMasters + nSlaves;
  const N_master = nMasters;
  const C = new Float64Array(N_total * N_master);
  // Master identity rows
  for (let j = 0; j < nMasters; j++) C[j * N_master + j] = 1.0;
  // Slave interpolation rows
  for (let k = 0; k < nSlaves; k++) {
    const row = nMasters + k;
    const { leftIdx, rightIdx, w } = weights[k];
    C[row * N_master + leftIdx]  = 1 - w;
    C[row * N_master + rightIdx] = w;
  }
  return { C, N_total, N_master };
}

// ---------------------------------------------------------------------------
//  Test 1: CᵀKC is SPD for a 3-master, 1-slave case
// ---------------------------------------------------------------------------

describe("CᵀKC is SPD: 3 masters, 1 slave, w=0.5", () => {
  it("CᵀKC LDL factorization succeeds and minPivot > 0", () => {
    const nMasters = 3;
    const nSlaves  = 1;
    const weights  = [{ leftIdx: 0, rightIdx: 1, w: 0.5 }];
    const { C, N_total, N_master } = buildC(nMasters, nSlaves, weights);

    // K: 4×4 SPD
    const K = buildSPDMatrix(N_total, 1.0);

    const Ct    = mattranspose(C, N_total, N_master);
    const CtK   = matmul(Ct, K, N_master, N_total, N_total);
    const CtKC  = matmul(CtK, C, N_master, N_total, N_master);

    const result = ldlCheck(CtKC, N_master);
    assert.ok(result.success,
      `CᵀKC LDL failed: minPivot=${result.minPivot} (not SPD)`);
    assert.ok(result.minPivot > 0,
      `CᵀKC has non-positive pivot ${result.minPivot}`);
  });
});

// ---------------------------------------------------------------------------
//  Test 2: CᵀKC is SPD for a larger case: 10 masters, 4 slaves, varying weights
// ---------------------------------------------------------------------------

describe("CᵀKC is SPD: 10 masters, 4 slaves, varying weights", () => {
  it("w=[0.1, 0.3, 0.6, 0.9]: CᵀKC SPD and condition bounded", () => {
    const nMasters = 10;
    const nSlaves  = 4;
    const weights  = [
      { leftIdx: 0,  rightIdx: 1, w: 0.1 },
      { leftIdx: 2,  rightIdx: 3, w: 0.3 },
      { leftIdx: 5,  rightIdx: 6, w: 0.6 },
      { leftIdx: 8,  rightIdx: 9, w: 0.9 },
    ];
    const { C, N_total, N_master } = buildC(nMasters, nSlaves, weights);

    const K    = buildSPDMatrix(N_total, 1.0);
    const Ct   = mattranspose(C, N_total, N_master);
    const CtK  = matmul(Ct, K, N_master, N_total, N_total);
    const CtKC = matmul(CtK, C, N_master, N_total, N_master);

    const result = ldlCheck(CtKC, N_master);
    assert.ok(result.success,
      `CᵀKC LDL failed: minPivot=${result.minPivot}`);

    const condK    = condEst(K,    N_total);
    const condCtKC = condEst(CtKC, N_master);
    assert.ok(
      condCtKC <= condK * 10 + 1,
      `CᵀKC condition ${condCtKC.toFixed(2)} > 10× K condition ${condK.toFixed(2)}`
    );
  });
});

// ---------------------------------------------------------------------------
//  Test 3: weights near 0 and near 1 — still SPD
// ---------------------------------------------------------------------------

describe("CᵀKC remains SPD for near-boundary weights", () => {
  it("w=[0.01, 0.99]: CᵀKC LDL succeeds (no breakdown for extreme weights)", () => {
    const nMasters = 4;
    const nSlaves  = 2;
    const weights  = [
      { leftIdx: 0, rightIdx: 1, w: 0.01 },
      { leftIdx: 2, rightIdx: 3, w: 0.99 },
    ];
    const { C, N_total, N_master } = buildC(nMasters, nSlaves, weights);

    const K    = buildSPDMatrix(N_total, 2.0);
    const Ct   = mattranspose(C, N_total, N_master);
    const CtK  = matmul(Ct, K, N_master, N_total, N_total);
    const CtKC = matmul(CtK, C, N_master, N_total, N_master);

    const result = ldlCheck(CtKC, N_master);
    assert.ok(result.success,
      `CᵀKC LDL failed for w=[0.01,0.99]: minPivot=${result.minPivot}`);
    assert.ok(result.minPivot > 0,
      `CᵀKC has non-positive pivot ${result.minPivot}`);
  });
});

// ---------------------------------------------------------------------------
//  Test 4: Multiple slaves per master pair — still SPD
// ---------------------------------------------------------------------------

describe("CᵀKC is SPD with multiple slaves per master pair", () => {
  it("4 slaves all between master 0 and master 1: CᵀKC SPD", () => {
    const nMasters = 6;
    const nSlaves  = 4;
    const weights = [
      { leftIdx: 0, rightIdx: 1, w: 0.2 },
      { leftIdx: 0, rightIdx: 1, w: 0.4 },
      { leftIdx: 0, rightIdx: 1, w: 0.6 },
      { leftIdx: 0, rightIdx: 1, w: 0.8 },
    ];
    const { C, N_total, N_master } = buildC(nMasters, nSlaves, weights);

    const K    = buildSPDMatrix(N_total, 1.0);
    const Ct   = mattranspose(C, N_total, N_master);
    const CtK  = matmul(Ct, K, N_master, N_total, N_total);
    const CtKC = matmul(CtK, C, N_master, N_total, N_master);

    const result = ldlCheck(CtKC, N_master);
    assert.ok(result.success,
      `CᵀKC LDL failed for multiple slaves per master pair: minPivot=${result.minPivot}`);
    assert.ok(result.minPivot > 0,
      `CᵀKC has non-positive pivot ${result.minPivot}`);
  });
});

// ---------------------------------------------------------------------------
//  Test 5: Identity C preserves K exactly
// ---------------------------------------------------------------------------

describe("Identity C: CᵀKC = K exactly", () => {
  it("C = I (no slaves) → CᵀKC = K within 1e-14", () => {
    const N = 5;
    const K = buildSPDMatrix(N, 1.0);

    // C = I (N × N, zero slaves)
    const C = new Float64Array(N * N);
    for (let j = 0; j < N; j++) C[j * N + j] = 1.0;

    const Ct   = mattranspose(C, N, N);
    const CtK  = matmul(Ct, K, N, N, N);
    const CtKC = matmul(CtK, C, N, N, N);

    for (let i = 0; i < N * N; i++) {
      assert.ok(
        Math.abs(CtKC[i] - K[i]) < 1e-14,
        `CᵀIC[${i}]=${CtKC[i]} differs from K[${i}]=${K[i]} by ${Math.abs(CtKC[i] - K[i])}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
//  Test 6: CᵀKC condition bounded for typical mesher weights [0.1, 0.9]
// ---------------------------------------------------------------------------

describe("CᵀKC condition number bounded within 10x of K", () => {
  it("8-master 3-slave case: condEst(CᵀKC) <= 10 * condEst(K)", () => {
    const nMasters = 8;
    const nSlaves  = 3;
    const weights = [
      { leftIdx: 1, rightIdx: 2, w: 0.25 },
      { leftIdx: 3, rightIdx: 4, w: 0.50 },
      { leftIdx: 5, rightIdx: 6, w: 0.75 },
    ];
    const { C, N_total, N_master } = buildC(nMasters, nSlaves, weights);

    const K    = buildSPDMatrix(N_total, 1.0);
    const Ct   = mattranspose(C, N_total, N_master);
    const CtK  = matmul(Ct, K, N_master, N_total, N_total);
    const CtKC = matmul(CtK, C, N_master, N_total, N_master);

    const result = ldlCheck(CtKC, N_master);
    assert.ok(result.success,
      `CᵀKC LDL factorization failed: minPivot=${result.minPivot}`);

    const condK    = condEst(K,    N_total);
    const condCtKC = condEst(CtKC, N_master);
    assert.ok(
      condCtKC <= condK * 10 + 1,
      `CᵀKC cond=${condCtKC.toFixed(2)} > 10 × K cond=${condK.toFixed(2)}`
    );
  });
});
