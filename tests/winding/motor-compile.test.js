"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { assertClose, compileSection } = require("./_fixtures.js");

const MC = globalThis.window.LIB.MotorCompile;
const MU0 = 4 * Math.PI * 1e-7;
const TWO_PI = 2 * Math.PI;

describe("MotorCompile", () => {
  it("output array shapes", () => {
    const compiled = MC.compile(compileSection({}));
    const { grid, nu, magnetization, rotorMask, ironMask, coilMasks, nCircuits } = compiled;
    const total = 4 * 12;

    assert.strictEqual(nu.length, total);
    assert.strictEqual(magnetization.Mr.length, total);
    assert.strictEqual(magnetization.Mtheta.length, total);
    assert.strictEqual(rotorMask.length, total);
    assert.strictEqual(ironMask.length, total);
    assert.strictEqual(grid.dA.length, total);
    assert.strictEqual(grid.r.length, 4);
    assert.strictEqual(nCircuits, 1);
    assert.strictEqual(coilMasks.length, nCircuits);
    assert.strictEqual(coilMasks[0].length, total);
  });

  it("no magnet ⇒ zero magnetization", () => {
    const compiled = MC.compile(compileSection({ withMagnet: false }));
    const { Mr, Mtheta } = compiled.magnetization;
    for (let i = 0; i < Mr.length; i++) {
      assert.strictEqual(Mr[i], 0, `Mr[${i}] should be 0`);
      assert.strictEqual(Mtheta[i], 0, `Mtheta[${i}] should be 0`);
    }
  });

  it("no iron ⇒ all-air ν", () => {
    const compiled = MC.compile(compileSection({ withIron: false }));
    const { nu } = compiled;
    const nuAir = 1 / MU0;
    for (let i = 0; i < nu.length; i++) {
      assertClose(nu[i], nuAir, 1e-3, `nu[${i}] should be 1/μ₀`);
    }
  });

  it("iron lowers ν", () => {
    const compiled = MC.compile(compileSection({ withMagnet: false, withIron: true }));
    const { nu, ironMask } = compiled;
    const nuAir = 1 / MU0;
    const nuIron = 1 / (1000 * MU0);

    for (let i = 0; i < nu.length; i++) {
      if (ironMask[i] === 1) {
        assertClose(nu[i], nuIron, 1e-9, `iron cell nu[${i}]`);
      } else {
        assertClose(nu[i], nuAir, 1e-9, `air cell nu[${i}]`);
      }
    }
  });

  it("coil mask integrates to signed turns", () => {
    const compiled = MC.compile(compileSection({}));
    const { coilMasks, grid } = compiled;
    const { dA } = grid;

    let sum = 0;
    for (let i = 0; i < coilMasks[0].length; i++) {
      sum += coilMasks[0][i] * dA[i];
    }
    assertClose(sum, 5, 1e-9, "Σ coilMasks[0]·dA should equal turns=5");
  });

  it("assembleJz is the current-weighted mask sum", () => {
    const compiled = MC.compile(compileSection({}));
    const { assembleJz, coilMasks } = compiled;
    const total = 4 * 12;

    // assembleJz([0]) is all-zero
    const Jz0 = assembleJz([0]);
    assert.strictEqual(Jz0.length, total);
    for (let i = 0; i < total; i++) {
      assert.strictEqual(Jz0[i], 0, `assembleJz([0])[${i}] should be 0`);
    }

    // assembleJz([3]) equals coilMasks[0] * 3 entrywise
    const Jz3 = assembleJz([3]);
    for (let i = 0; i < total; i++) {
      assertClose(Jz3[i], 3 * coilMasks[0][i], 1e-12, `assembleJz([3])[${i}]`);
    }
  });

  it("rotorMask marks rotor features only", () => {
    const compiled = MC.compile(compileSection({}));
    const { rotorMask, grid } = compiled;
    const { Nr, Ntheta, rInner, rOuter } = grid;
    const dr = (rOuter - rInner) / Nr;
    const dtheta = TWO_PI / Ntheta;

    for (let i = 0; i < Nr; i++) {
      const rCentre = rInner + (i + 0.5) * dr;
      for (let j = 0; j < Ntheta; j++) {
        const idx = i * Ntheta + j;
        const theta = (j + 0.5) * dtheta;

        // Rotor magnet covers rRange:[0.04,0.043], thetaRange:[0,π]
        // Rotor iron covers rRange:[0.04,0.043], thetaRange:[π,2π]
        // Together: all cells with rCentre in [0.04, 0.043)
        // Stator conductor covers rRange:[0.045,0.05] — member:stator → rotorMask=0
        const inRotorR = rCentre >= 0.04 && rCentre < 0.043;

        if (inRotorR) {
          assert.strictEqual(rotorMask[idx], 1,
            `rotor cell (i=${i},j=${j}, r=${rCentre.toFixed(4)}, θ=${theta.toFixed(3)}) should have rotorMask=1`);
        } else {
          assert.strictEqual(rotorMask[idx], 0,
            `stator cell (i=${i},j=${j}, r=${rCentre.toFixed(4)}) should have rotorMask=0`);
        }
      }
    }
  });

  it("coveredCells handles negative-lower-bound wrap (slot 0)", () => {
    // Build a section with thetaRange: [-π/12, π/12] (slot 0 wrapped through 0)
    const section = {
      grid: { Nr: 4, Ntheta: 12, rInner: 0.04, rOuter: 0.05, ell: 0.1 },
      gapBand: { iInner: 1, iOuter: 2 },
      features: [
        {
          kind: "conductor",
          member: "stator",
          rRange: [0.045, 0.05],
          thetaRange: [-Math.PI / 12, Math.PI / 12],
          circuit: 0,
          turns: 5,
        },
      ],
    };

    const compiled = MC.compile(section);
    const { coilMasks, grid } = compiled;
    const { Nr, Ntheta, rInner, rOuter } = grid;
    const dr = (rOuter - rInner) / Nr;
    const dtheta = TWO_PI / Ntheta;

    // Find cells in rRange [0.045, 0.05): i=2,3 (r centres 0.04625, 0.04875)
    // theta near 0: j=0 at (0+0.5)*dtheta = π/12 is the boundary; cells at j=0 have theta=π/12
    // theta near 2π: last cell j=11 has theta=(11+0.5)*2π/12 = 23π/12 ≈ 2π - π/12

    let hasNearZero = false;
    let hasNearTwoPi = false;

    for (let i = 0; i < Nr; i++) {
      const rCentre = rInner + (i + 0.5) * dr;
      if (rCentre < 0.045 || rCentre >= 0.05) continue;
      for (let j = 0; j < Ntheta; j++) {
        const idx = i * Ntheta + j;
        const theta = (j + 0.5) * dtheta;
        if (coilMasks[0][idx] !== 0) {
          // cell near theta = 0 (positive arc)
          if (theta <= Math.PI / 12 + 1e-10) hasNearZero = true;
          // cell near theta = 2π - π/12 (wrapped tail)
          if (theta >= TWO_PI - Math.PI / 12 - 1e-10) hasNearTwoPi = true;
        }
      }
    }

    assert.ok(hasNearZero, "coilMask should be non-zero near theta≈0 (positive arc of slot 0)");
    assert.ok(hasNearTwoPi, "coilMask should be non-zero near theta≈2π−π/12 (wrapped tail of slot 0)");
  });
});
