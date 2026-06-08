"use strict";

// =============================================================================
//  Axial-flux DOF (Ψ) correctness gate — net radial flux via the annulus
//  harmonic 1-form ∇χ = θ̂/(2πr).
//
//  A single 2-D r-θ slice forces net radial flux to zero (∮∂Az/∂θ = 0 on a
//  θ-periodic annulus). The axial-flux feature adds one Schur-condensed DOF Ψ
//  carrying ∇χ, so the slice can exchange net radial flux Φ = ℓ·Ψ with an axial
//  magnetic circuit (the path a uniform axial PM — hybrid / claw-pole — needs).
//
//  This gate verifies the production assembly (rotor body + stator body + mortar
//  gap band) on an ALL-AIR annulus, where the field reluctance seen by Ψ,
//  R_field = d − cᵀK⁻¹c, must equal the analytic radial reluctance
//  (1/μ0/2π)·ln(rOut/rIn), and Ψ obeys magnetic Ohm's law Ψ = F_pm/(R_field+R_axial).
//  The harmonic 1-form is the exact energy minimizer for uniform ν, so cᵀK⁻¹c→0
//  and R_field = d. With no axialFlux opt the DOF is absent (nCut=0) — covered by
//  the bit-identical machine suites.
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const F = require("../machines/_fixtures.js");

const LIB = F.LIB, CS = F.UnifiedMotor.ConfigSchema;
const MU0 = 4e-7 * Math.PI;
const rIn = 0.020, rOut = 0.040;

function airConfig() {
  return {
    grid: { Nr: 24, Ntheta: 256, rInner: rIn, rOuter: rOut, ell: 0.05 },
    poles: 2,
    mechanical: { J: 1e-4, damping: 0, loadTorque: 0 },
    rings: [
      { member: "rotor",  element: "I", rRange: [0.020, 0.028], teeth: 1, theta0: 0, spanFraction: 1.0, muR: 1 },
      { member: "stator", element: "I", rRange: [0.032, 0.040], teeth: 1, theta0: 0, spanFraction: 1.0, muR: 1 },
    ],
    circuits: [],
    stack: { slices: 1 },
  };
}

function sliceWith(axialFlux) {
  const expanded = CS.expand(airConfig());
  const slice = LIB.MotorSlice.create(expanded.slices[0].section, {
    poles: expanded.poles, saturation: { enabled: false }, axialFlux,
  });
  slice.solve(0, new Float64Array(0));
  return slice.__internals.fluxState();
}

test("flux DOF: R_field matches the analytic radial reluctance (all-air)", () => {
  const Ranalytic = (1 / MU0 / (2 * Math.PI)) * Math.log(rOut / rIn);
  const fs = sliceWith({ Fpm: 0, Raxial: 0 });
  const rel = Math.abs(fs.Rfield / Ranalytic - 1);
  assert.ok(rel < 0.01, `R_field ${fs.Rfield.toExponential(4)} vs analytic ${Ranalytic.toExponential(4)} (rel ${rel.toExponential(2)})`);
  // uniform ν ⇒ harmonic 1-form is the exact minimizer ⇒ cᵀK⁻¹c ≈ 0 ⇒ R_field = d.
  assert.ok(Math.abs(fs.Rfield / fs.d - 1) < 1e-3, `R_field should equal d for uniform ν (got ${fs.Rfield.toExponential(4)} vs d ${fs.d.toExponential(4)})`);
});

test("flux DOF: obeys magnetic Ohm's law Ψ = F_pm/(R_field + R_axial)", () => {
  const Rf = sliceWith({ Fpm: 0, Raxial: 0 }).Rfield;
  const Fpm = 100;
  for (const Rax of [0, Rf, 3 * Rf]) {
    const fs = sliceWith({ Fpm, Raxial: Rax });
    const expect = Fpm / (Rf + Rax);
    const rel = Math.abs(fs.Psi / expect - 1);
    assert.ok(rel < 1e-6, `Raxial=${Rax.toExponential(2)}: Ψ=${fs.Psi.toExponential(4)} expect ${expect.toExponential(4)} (rel ${rel.toExponential(2)})`);
  }
});

test("flux DOF: open axial path (R_axial→∞) drives Ψ→0; short maxes it", () => {
  const Rf = sliceWith({ Fpm: 0, Raxial: 0 }).Rfield;
  const open = sliceWith({ Fpm: 100, Raxial: 1e9 * Rf }).Psi;
  const short = sliceWith({ Fpm: 100, Raxial: 0 }).Psi;
  assert.ok(Math.abs(open) < 1e-6 * Math.abs(short), `open Ψ ${open.toExponential(3)} should be ≪ short Ψ ${short.toExponential(3)}`);
  assert.ok(Math.abs(short - 100 / Rf) / (100 / Rf) < 1e-9, `short Ψ should be F_pm/R_field`);
});
