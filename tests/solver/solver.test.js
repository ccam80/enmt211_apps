"use strict";

// First install globalThis.window and load lib/fea-solver.js via the shim.
const LIB = require("./_shim.js");

const { test }   = require("node:test");
const assert     = require("node:assert/strict");
const { buildProxy, residualInf, assertClose,
        buildSmallSPD, buildSmallSPDWithDuplicates } = require("./_fixtures.js");

// ---- helpers ---------------------------------------------------------------

async function makeAndInit() {
  await LIB.FeaSolver.init();
  return LIB.FeaSolver;
}

function solveSystem(FS, { N, nnz, I, J, V, b }) {
  const s = FS.create();
  s.setPattern(N, I, J);
  s.setValues(V);
  s.analyze();
  s.factorize();
  const x = s.solve(b);
  s.destroy();
  return x;
}

// ---- tests -----------------------------------------------------------------

test("SPD residual below 1e-9 on the proxy operator", async () => {
  const FS  = await makeAndInit();
  const fix = buildProxy(110);        // N = 12100
  const x   = solveSystem(FS, fix);
  const res = residualInf(fix.I, fix.J, fix.V, x, fix.b);
  assert.ok(res < 1e-9, `residualInf = ${res} (expected < 1e-9)`);
});

test("larger proxy stays SPD-exact", async () => {
  const FS  = await makeAndInit();
  const fix = buildProxy(224);        // N = 50176  (~§2.3 stress size)
  const x   = solveSystem(FS, fix);
  const res = residualInf(fix.I, fix.J, fix.V, x, fix.b);
  assert.ok(res < 1e-9, `residualInf = ${res} (expected < 1e-9)`);
});

test("numeric refactor reuses the symbolic ordering", async () => {
  const FS   = await makeAndInit();
  const base = buildProxy(110);       // N = 12100
  const s    = FS.create();

  s.setPattern(base.N, base.I, base.J);

  // analyze exactly once
  s.setValues(base.V);
  s.analyze();

  const scales = [1.0, 2.0, 0.5];
  for (const scale of scales) {
    // Scale V and b by the same factor → same solution direction.
    const scaledV = new Float64Array(base.V.length);
    const scaledB = new Float64Array(base.b.length);
    for (let k = 0; k < base.V.length; k++) scaledV[k] = base.V[k] * scale;
    for (let k = 0; k < base.b.length; k++) scaledB[k] = base.b[k];

    s.setValues(scaledV);
    s.factorize();            // no re-analyze
    const x   = s.solve(scaledB);
    const res = residualInf(base.I, base.J, scaledV, x, scaledB);
    assert.ok(res < 1e-9,
      `scale=${scale}: residualInf = ${res} (expected < 1e-9)`);
  }

  s.destroy();
});

test("two instances hold independent live factorizations", async () => {
  const FS  = await makeAndInit();
  const fA  = buildProxy(80);         // N = 6400
  const fB  = buildProxy(110);        // N = 12100

  const sA = FS.create();
  const sB = FS.create();

  sA.setPattern(fA.N, fA.I, fA.J);
  sA.setValues(fA.V);
  sA.analyze();
  sA.factorize();

  sB.setPattern(fB.N, fB.I, fB.J);
  sB.setValues(fB.V);
  sB.analyze();
  sB.factorize();

  // Interleave solves.
  const xA1 = sA.solve(fA.b);
  const xB  = sB.solve(fB.b);

  // Each handle produces correct residuals.
  const resA = residualInf(fA.I, fA.J, fA.V, xA1, fA.b);
  const resB = residualInf(fB.I, fB.J, fB.V, xB,  fB.b);
  assert.ok(resA < 1e-9, `A residualInf = ${resA}`);
  assert.ok(resB < 1e-9, `B residualInf = ${resB}`);

  // Solving B does not change A's result: re-solve A and compare element-wise.
  const xA2 = sA.solve(fA.b);
  for (let i = 0; i < fA.N; i++) {
    const diff = Math.abs(xA2[i] - xA1[i]);
    assert.ok(diff < 1e-12,
      `A element ${i} changed after solving B: diff = ${diff}`);
  }

  sA.destroy();
  sB.destroy();
});

test("setValues updates the system without re-analyze", async () => {
  const FS  = await makeAndInit();
  const fix = buildSmallSPD();
  const n   = fix.b.length;
  const s   = FS.create();

  s.setPattern(n, fix.I, fix.J);
  s.setValues(fix.V);
  s.analyze();
  s.factorize();
  const x1 = s.solve(fix.b);

  for (let i = 0; i < n; i++) {
    assertClose(x1[i], fix.xExact[i], 1e-10,
      `first solve x[${i}]`);
  }

  // Scale V by 2 → same pattern, double the system → solution halves.
  const V2 = new Float64Array(fix.V.length);
  for (let k = 0; k < fix.V.length; k++) V2[k] = fix.V[k] * 2;
  s.setValues(V2);
  s.factorize();              // no re-analyze
  const x2 = s.solve(fix.b);

  for (let i = 0; i < n; i++) {
    assertClose(x2[i], fix.xExact[i] / 2, 1e-10,
      `scaled solve x[${i}]`);
  }

  s.destroy();
});

test("scatter map sums duplicate triplets", async () => {
  const FS   = await makeAndInit();
  const base = buildSmallSPD();
  const dup  = buildSmallSPDWithDuplicates();
  const n    = base.b.length;

  // Solve with canonical (no duplicates).
  const s1 = FS.create();
  s1.setPattern(n, base.I, base.J);
  s1.setValues(base.V);
  s1.analyze();
  s1.factorize();
  const x1 = s1.solve(base.b);
  s1.destroy();

  // Solve with duplicate triplets.
  const s2 = FS.create();
  s2.setPattern(n, dup.I, dup.J);
  s2.setValues(dup.V);
  s2.analyze();
  s2.factorize();
  const x2 = s2.solve(dup.b);
  s2.destroy();

  for (let i = 0; i < n; i++) {
    assertClose(x1[i], base.xExact[i], 1e-10, `canonical x[${i}]`);
    assertClose(x2[i], dup.xExact[i],  1e-10, `duplicate x[${i}]`);
  }
});

test("factorNnz reports fill above N", async () => {
  const FS  = await makeAndInit();
  const fix = buildProxy(110);        // N = 12100
  const s   = FS.create();
  s.setPattern(fix.N, fix.I, fix.J);
  s.setValues(fix.V);
  s.analyze();
  s.factorize();
  const fnnz = s.factorNnz();
  s.destroy();
  assert.ok(fnnz > fix.N,
    `factorNnz ${fnnz} should exceed N=${fix.N}`);
  assert.ok(fnnz < 50 * fix.N,
    `factorNnz ${fnnz} > 50·N=${50 * fix.N} — catastrophic fill?`);
});

test("analyze/factorize/solve timings logged; relative order asserted", async () => {
  const FS  = await makeAndInit();
  const fix = buildProxy(110);        // N = 12100

  const s = FS.create();
  s.setPattern(fix.N, fix.I, fix.J);
  s.setValues(fix.V);

  const now = () => Number(process.hrtime.bigint()) / 1e6;

  let t  = now(); s.analyze();                const tA = now() - t;
  t = now(); s.factorize();                   const tF = now() - t;
  t = now(); s.solve(fix.b);                  const tS = now() - t;

  console.log(
    `[timing] N=${fix.N}  analyze=${tA.toFixed(1)}ms` +
    `  factorize=${tF.toFixed(1)}ms  solve=${tS.toFixed(2)}ms`
  );

  s.destroy();

  // Machine-independent relative order: solve must be faster than factorize.
  assert.ok(tS < tF,
    `Expected solve (${tS.toFixed(2)}ms) < factorize (${tF.toFixed(2)}ms)`);
});

test("non-SPD matrix surfaces an error", async () => {
  const FS = await makeAndInit();

  // Singular (rank-deficient) matrix: all rows identical → zero pivot.
  // A = [[1, 1, 1], [1, 1, 1], [1, 1, 1]] — rank 1, not positive definite.
  // Eigen SimplicialLDLT returns NumericalIssue (info=1) on a zero pivot,
  // which fea-solver.js maps to a thrown Error.
  const s = FS.create();
  s.setPattern(3,
    new Int32Array  ([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    new Int32Array  ([0, 1, 2, 0, 1, 2, 0, 1, 2])
  );
  s.setValues(
    new Float64Array([1, 1, 1, 1, 1, 1, 1, 1, 1])
  );
  s.analyze();

  assert.throws(
    () => s.factorize(),
    { message: /factorize\(\) failed/ },
    "factorize() should throw for a singular (non-SPD) matrix"
  );

  s.destroy();
});
