"use strict";

const fs   = require("fs");
const path = require("path");

// ---- buildProxy(n) -------------------------------------------------------
// Builds the n×n grid 5-point operator (air↔iron ×1000 harmonic-mean
// conductivity) lifted from _solver_bench/bench_wasm.mjs.
// Returns { N, nnz, I:Int32Array, J:Int32Array, V:Float64Array, b:Float64Array }
// with full-symmetric triplets (both (i,j) and (j,i) present).
function buildProxy(n) {
  const N   = n * n;
  const idx = (i, j) => i * n + j;

  // Air-iron conductivity: 1e-3 in the "air/iron" regions, 1.0 in the core.
  const condOf = (i) => (i <= n * 0.3 || i >= n * 0.85) ? 1e-3 : 1.0;

  const harm = (a, b) => (2 * a * b) / (a + b);

  const Ir = [];
  const Jc = [];
  const Va = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const me  = idx(i, j);
      const ci  = condOf(i);
      let   d   = 0;

      for (const [di, dj] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || ii >= n || jj < 0 || jj >= n) continue;
        const g = harm(ci, condOf(ii));
        Ir.push(idx(ii, jj)); Jc.push(me); Va.push(-g);
        d += g;
      }

      // Diagonal: sum of conductances + regularisation.
      Ir.push(me); Jc.push(me); Va.push(d + 1e-4);
    }
  }

  const nnz = Ir.length;
  const b   = new Float64Array(N);
  for (let i = 0; i < N; i++) b[i] = Math.sin(i * 0.1) + 1;

  return {
    N,
    nnz,
    I: new Int32Array(Ir),
    J: new Int32Array(Jc),
    V: new Float64Array(Va),
    b,
  };
}

// ---- residualInf(I, J, V, x, b) -----------------------------------------
// Returns ‖Ax − b‖∞ / ‖b‖∞ computed directly from the triplet representation.
function residualInf(I, J, V, x, b) {
  const N  = b.length;
  const ax = new Float64Array(N);
  for (let k = 0; k < I.length; k++) {
    ax[I[k]] += V[k] * x[J[k]];
  }
  let resMax = 0;
  let bMax   = 0;
  for (let i = 0; i < N; i++) {
    resMax = Math.max(resMax, Math.abs(ax[i] - b[i]));
    bMax   = Math.max(bMax,   Math.abs(b[i]));
  }
  return resMax / bMax;
}

// ---- assertClose(actual, expected, tol, msg) -----------------------------
function assertClose(actual, expected, tol, msg) {
  const diff = Math.abs(actual - expected);
  if (diff > tol) {
    throw new Error(
      (msg ? msg + ": " : "") +
      `expected |${actual} - ${expected}| <= ${tol}, got diff = ${diff}`
    );
  }
}

// ---- buildSmallSPD() -----------------------------------------------------
// A fixed 3×3 SPD system with full-symmetric triplets and hand-computed
// exact solution.
//
// A = [[4, 1, 0],
//      [1, 3, 1],
//      [0, 1, 2]],   diagonal-dominant SPD.
//
// Verify A·xExact = b element-wise (xExact = [1, 1, 2]):
//   row 0: 4·1 + 1·1 + 0·2 = 5
//   row 1: 1·1 + 3·1 + 1·2 = 6
//   row 2: 0·1 + 1·1 + 2·2 = 5
// → b = [5, 6, 5].
function buildSmallSPD() {
  return {
    I:      new Int32Array  ([0, 0, 1, 1, 1, 2, 2]),
    J:      new Int32Array  ([0, 1, 0, 1, 2, 1, 2]),
    V:      new Float64Array([4, 1, 1, 3, 1, 1, 2]),
    b:      new Float64Array([5, 6, 5]),
    xExact: new Float64Array([1, 1, 2]),
  };
}

// ---- buildSmallSPDWithDuplicates() ---------------------------------------
// The same 3×3 matrix expressed with some (i,j) entries split across two
// triplets that sum to the correct value. xExact is identical ([1, 1, 2]).
// Used to verify that the scatter-map sums duplicates into one CSC slot.
//
// Split: diagonal (0,0)=4 → (4-1.5) + 1.5; off-diag (1,2)=1 → 0.6 + 0.4.
// All other entries unchanged.
function buildSmallSPDWithDuplicates() {
  return {
    //         (0,0)a (0,0)b (0,1) (1,0) (1,1) (1,2)a (1,2)b (2,1) (2,2)
    I:      new Int32Array  ([0,    0,    0,    1,    1,    1,     1,    2,    2]),
    J:      new Int32Array  ([0,    0,    1,    0,    1,    2,     2,    1,    2]),
    V:      new Float64Array([2.5,  1.5,  1,    1,    3,    0.6,   0.4,  1,    2]),
    b:      new Float64Array([5, 6, 5]),
    xExact: new Float64Array([1, 1, 2]),
  };
}

// ---- readWasmBinary() ----------------------------------------------------
// Reads lib/solver.wasm from disk and returns it as an ArrayBuffer.
function readWasmBinary() {
  const wasmPath = path.resolve(__dirname, "../../lib/solver.wasm");
  const buf      = fs.readFileSync(wasmPath);
  // fs.readFileSync returns a Buffer; .buffer is the underlying ArrayBuffer
  // but may be a shared pool — slice() to get an owned copy.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

module.exports = {
  buildProxy,
  residualInf,
  assertClose,
  buildSmallSPD,
  buildSmallSPDWithDuplicates,
  readWasmBinary,
};
