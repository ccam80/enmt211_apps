"use strict";

// =============================================================================
//  Gap-engine torque correctness gate — analytical formula-field test.
//
//  This is a REGIME-WIDE correctness gate, independent of any machine fixture.
//  The air-gap is current-free, so its vector potential is Laplacian; a single
//  harmonic k has the closed form
//      A(r,θ) = [a ρ^k + b ρ^-k] cos kθ + [c ρ^k + d ρ^-k] sin kθ ,   ρ = r/r0
//  whose Maxwell-stress torque is EXACT and radius-independent:
//      T = (2π k² ℓ / μ0) (bc − ad).
//  Feeding that field (sampled on the two gap rings) to gap.torque() must
//  return T. The error of the real-space single-contour stencil grows with the
//  harmonic order k (the chord B_θ = −ΔA/Δr mis-resolves the r^±k radial
//  curvature), so this gate pins the accuracy the engine must hold across the
//  full generated regime — NOT just whatever k the stock machines happen to use.
// =============================================================================

const { test, before } = require("node:test");
const assert = require("node:assert");
const path = require("path");

if (!globalThis.window) globalThis.window = globalThis;
try { require("../../lib/util.js"); } catch (e) { globalThis.window.LIB = globalThis.window.LIB || {}; }
// The local field reconstruction in torque() factors an SPD cyclic-tridiagonal
// system via the WASM FEA solver, so the solver must be initialised before any
// engine is built. init() is async (dynamic import + WASM instantiate) — register
// it as the runner's root before-hook so it resolves before the first test.
process.env.FEA_SOLVER_MJS_PATH = path.resolve(__dirname, "../../lib/solver.mjs");
require("../../lib/fea-solver.js");
require("../../lib/airgap-mortar.js");

const LIB = globalThis.window.LIB || globalThis.LIB;
const M = LIB.AirgapMortar;

before(async () => { await LIB.FeaSolver.init(); });
const MU0 = 4e-7 * Math.PI, PI = Math.PI;

// field coefficients — any (a,b,c,d) with bc-ad ≠ 0 gives a non-zero torque
const A = 1, B = 0.5, C = 0.3, D = 0.8, ELL = 0.1; // bc-ad = -0.65

function ring(N, R, off) {
  const th = new Float64Array(N);
  for (let i = 0; i < N; i++) th[i] = ((i + off) * 2 * PI / N) % (2 * PI);
  return { gapTheta: th, gapR: R };
}
function sample(th, R, r0, k) {
  const v = new Float64Array(th.length), rho = R / r0, pk = Math.pow(rho, k), pmk = Math.pow(rho, -k);
  const fr = A * pk + B * pmk, gr = C * pk + D * pmk;
  for (let i = 0; i < th.length; i++) v[i] = fr * Math.cos(k * th[i]) + gr * Math.sin(k * th[i]);
  return v;
}
function truth(k) { return (2 * PI * k * k * ELL / MU0) * (B * C - A * D); }

// ratio of engine torque to the exact analytical torque, for harmonic k on a
// gap [Rr,Rs] with Nr/Ns ring nodes (rotor offset by `off` node-fractions).
function ratio(k, Rr, Rs, Nr, Ns, off) {
  const r0 = 0.5 * (Rr + Rs);
  const rg = ring(Nr, Rr, off || 0), sg = ring(Ns, Rs, 0);
  const eng = M.build(rg, sg, { ell: ELL });
  const tm = eng.torque(sample(rg.gapTheta, Rr, r0, k), sample(sg.gapTheta, Rs, r0, k), 0);
  return tm / truth(k);
}

const Rr = 0.050, Rs = 0.053, N = 512; // 3 mm gap on a 50 mm bore, well-resolved rings

test("low-k gap torque is exact (k ≤ 4, within 1%)", () => {
  for (const k of [1, 2, 3, 4]) {
    const r = ratio(k, Rr, Rs, N, N, 0);
    assert.ok(Math.abs(r - 1) < 0.01, `k=${k}: torque/analytic = ${r.toFixed(4)} (want within 1%)`);
  }
});

test("gap torque converges to exact as the gap thins (k=8)", () => {
  // The chord stencil is exact in the thin-gap limit — guards the formula and
  // the limiting behaviour regardless of the high-k fix.
  const r = ratio(8, 0.050, 0.0501, N, N, 0); // 0.1 mm gap
  assert.ok(Math.abs(r - 1) < 0.005, `thin-gap k=8: ${r.toFixed(4)} (want within 0.5%)`);
});

test("rotor-ring offset does not change the torque (interpolation is faithful)", () => {
  // A half-node rotor offset (the FEA always has the rotor ring rotated) must
  // not move the torque — guards the angular interpolation path.
  for (const k of [1, 4, 8]) {
    const r0 = ratio(k, Rr, Rs, N, N, 0), rOff = ratio(k, Rr, Rs, N, N, 0.5);
    assert.ok(Math.abs(rOff - r0) < 0.01, `k=${k}: aligned ${r0.toFixed(4)} vs offset ${rOff.toFixed(4)}`);
  }
});

test("mid/high-k gap torque within 3% (k ≤ 12) — radial-stencil accuracy gate", () => {
  // THE LOAD-BEARING GATE. The generator emits machines with high pole/slot/bar
  // counts whose torque-relevant harmonics reach well past the pole-pair order;
  // the gap torque must stay accurate there. The single-contour chord stencil
  // over-reads as k grows (≈+3.5% at k=8, +11% at k=14 on this gap) — a real
  // engine defect, not a fixture quirk. The radial-stencil fix must satisfy this.
  const bad = [];
  for (const k of [6, 8, 10, 12]) {
    const r = ratio(k, Rr, Rs, N, N, 0);
    if (Math.abs(r - 1) >= 0.03) bad.push(`k=${k}: ${r.toFixed(4)}`);
  }
  assert.equal(bad.length, 0, `gap torque off by >3% at: ${bad.join(", ")}`);
});

test("high-k gap torque within 3% (k ∈ {16,20}) — angular-stencil accuracy gate", () => {
  // Pins the ANGULAR fix (cubic ring resample + 4th-order ∂_θ). With the old
  // single-chord/central-diff/linear-interp stencil these were ~+12% (k=16) and
  // ~+19% (k=20) over the analytical torque on this 3mm/50mm gap. The local
  // reconstruction holds them <1% — offset-rotor invariance (test above) plus a
  // flat N-sweep prove the residual is radial, not angular. The error is governed
  // by k·(Δr/r); on this gap (Δr/r≈0.058) k=20 is k·Δr/r≈1.2, inside the envelope.
  const bad = [];
  for (const k of [16, 20]) {
    const r = ratio(k, Rr, Rs, N, N, 0);
    if (Math.abs(r - 1) >= 0.03) bad.push(`k=${k}: ${r.toFixed(4)}`);
  }
  assert.equal(bad.length, 0, `gap torque off by >3% at: ${bad.join(", ")}`);
});

test("worst-gap (large Δr/r, stepper-class) torque within 3% — regime-binding case", () => {
  // The chord over-read is governed by k·(Δr/r), and the gap itself low-passes
  // torque-carrying harmonics to k·(Δr/r) ≲ 3 (a harmonic decays ~e^(−k·Δr/r)
  // across the gap and torque needs it on BOTH rings). The binding machine is the
  // hybrid stepper: a 2mm gap at ~21mm (Δr/r≈0.095) — far larger than the canonical
  // bore — whose detent/cogging band sits at k≈12–30 (k·Δr/r≈1.1–2.9). This is
  // where a low-L stencil bites (L=4 is +5% here at k=20); L=8 must hold the
  // well-penetrated band (k·Δr/r ≤ ~2) under 3%.
  const RrS = 0.020, RsS = 0.022; // Δr/r ≈ 0.095, the stepper's actual gap
  const bad = [];
  for (const k of [12, 16, 20]) { // k·Δr/r ≈ 1.1, 1.5, 1.9
    const r = ratio(k, RrS, RsS, N, N, 0);
    if (Math.abs(r - 1) >= 0.03) bad.push(`k=${k} (kΔr/r=${(k * 0.095).toFixed(1)}): ${r.toFixed(4)}`);
  }
  assert.equal(bad.length, 0, `worst-gap torque off by >3% at: ${bad.join(", ")}`);
});
