"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  singleAnnulusSection,
  ringStackSection,
  assertClose,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  Helper: compute P_body for a section's member from the features.
//  Full-circle features are ignored; the GCD of non-full-circle tile counts.
// ---------------------------------------------------------------------------
function computeBodyPeriod(section, member) {
  function gcd(a, b) {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b > 0) { const t = b; b = a % b; a = t; }
    return a;
  }
  let period = 0;
  for (const f of section.features) {
    if (f.member !== member) continue;
    const span = f.thetaRange[1] - f.thetaRange[0];
    if (span >= TWO_PI - 1e-9) continue;
    const count = Math.round(TWO_PI / span);
    if (count >= 2) {
      period = period === 0 ? count : gcd(period, count);
    }
  }
  return period > 0 ? period : 1;
}

// ---------------------------------------------------------------------------
//  Helper: compute gap geometry from features (mirrors mesher logic)
// ---------------------------------------------------------------------------
function gapGeom(section) {
  let rRotorSurface = -Infinity;
  let rStatorBore   =  Infinity;
  for (const f of section.features) {
    if (f.member === "rotor"  && f.rRange[1] > rRotorSurface) rRotorSurface = f.rRange[1];
    if (f.member === "stator" && f.rRange[0] < rStatorBore)   rStatorBore   = f.rRange[0];
  }
  const g = rStatorBore - rRotorSurface;
  return {
    g,
    rRotorSurface,
    rStatorBore,
    rotorGapR:  rRotorSurface + 0.25 * g,
    statorGapR: rStatorBore   - 0.25 * g,
  };
}

// ---------------------------------------------------------------------------
//  Test section with explicit gap geometry for deterministic calculations.
//  Rotor surface at 0.045, stator bore at 0.050 → g = 0.005.
//  rotorGapR = 0.045 + 0.00125 = 0.04625
//  statorGapR = 0.050 - 0.00125 = 0.04875
// ---------------------------------------------------------------------------
function gapSection() {
  return singleAnnulusSection(); // rotor [0.030,0.045], stator [0.050,0.060]
}

// ---------------------------------------------------------------------------
//  gapLoop nodes lie on a circle
// ---------------------------------------------------------------------------

describe("gapLoop nodes lie on a circle", () => {
  it("every gapLoop node radius equals gapR within 1e-9 for both bodies", () => {
    const section = gapSection();
    const { rotor, stator } = MotorMesh.build(section, {});

    for (const [label, body] of [["rotor", rotor], ["stator", stator]]) {
      const { nodes, gapLoop, gapR } = body;
      assert.ok(gapLoop.length > 0, `${label} gapLoop should be non-empty`);
      for (let k = 0; k < gapLoop.length; k++) {
        const ni = gapLoop[k];
        const x = nodes[2 * ni];
        const y = nodes[2 * ni + 1];
        const r = Math.hypot(x, y);
        assert.ok(
          Math.abs(r - gapR) < 1e-9,
          `${label} gapLoop[${k}] radius ${r} !== gapR ${gapR} (diff ${Math.abs(r - gapR)})`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  gapTheta is uniform and ordered
// ---------------------------------------------------------------------------

describe("gapTheta is uniform and ordered", () => {
  it("gapTheta is monotonically increasing, spans [0,2π), uniform diffs within 1e-9", () => {
    const section = gapSection();
    const { rotor, stator } = MotorMesh.build(section, {});

    for (const [label, body] of [["rotor", rotor], ["stator", stator]]) {
      const { gapTheta } = body;
      const N = gapTheta.length;
      assert.ok(N >= 2, `${label} gapTheta must have at least 2 entries`);

      // Starts near 0
      assert.ok(
        Math.abs(gapTheta[0]) < 1e-9,
        `${label} gapTheta[0] = ${gapTheta[0]}, expected 0`
      );

      // Last value < 2π (spans [0, 2π))
      assert.ok(
        gapTheta[N - 1] < TWO_PI - 1e-9,
        `${label} gapTheta[${N-1}] = ${gapTheta[N-1]}, should be < 2π`
      );

      // Uniform step
      const expectedStep = TWO_PI / N;
      for (let k = 1; k < N; k++) {
        const diff = gapTheta[k] - gapTheta[k - 1];
        assert.ok(
          Math.abs(diff - expectedStep) < 1e-9,
          `${label} gapTheta step at k=${k}: diff=${diff}, expected=${expectedStep}`
        );
      }

      // Monotonically increasing
      for (let k = 1; k < N; k++) {
        assert.ok(
          gapTheta[k] > gapTheta[k - 1],
          `${label} gapTheta not monotonically increasing at k=${k}`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  collar radii match the 0.25·g rule
// ---------------------------------------------------------------------------

describe("collar radii match the 0.25·g rule", () => {
  it("rotor gapR === r_rotor_surface + 0.25·g and stator gapR === r_stator_bore − 0.25·g within 1e-9", () => {
    const section = gapSection();
    const geo = gapGeom(section);
    const { rotor, stator } = MotorMesh.build(section, {});

    assert.ok(
      Math.abs(rotor.gapR - geo.rotorGapR) < 1e-9,
      `rotor.gapR=${rotor.gapR}, expected=${geo.rotorGapR}`
    );
    assert.ok(
      Math.abs(stator.gapR - geo.statorGapR) < 1e-9,
      `stator.gapR=${stator.gapR}, expected=${geo.statorGapR}`
    );
    assert.ok(
      rotor.gapR < stator.gapR,
      `rotor.gapR=${rotor.gapR} must be < stator.gapR=${stator.gapR}`
    );
  });
});

// ---------------------------------------------------------------------------
//  collar is pure air
// ---------------------------------------------------------------------------

describe("collar is pure air", () => {
  it("every element radially between body surface and gapR has air material", () => {
    const section = gapSection();
    const geo = gapGeom(section);
    const { rotor, stator } = MotorMesh.build(section, {});

    // Rotor: collar is from r_rotor_surface to rotorGapR
    // Elements with centroid r > r_rotor_surface and r <= rotorGapR must be air
    {
      const { nodes, elems, matId, materials } = rotor;
      const Ne = elems.length / 4;
      for (let e = 0; e < Ne; e++) {
        // Centroid of element
        let cx = 0, cy = 0;
        const count = elems[4*e+3] === -1 ? 3 : 4;
        for (let v = 0; v < count; v++) {
          const ni = elems[4*e + v];
          cx += nodes[2*ni];
          cy += nodes[2*ni+1];
        }
        cx /= count;
        cy /= count;
        const cr = Math.hypot(cx, cy);

        // In collar band: between feature surface and gapR
        if (cr > geo.rRotorSurface - 1e-9 && cr <= geo.rotorGapR + 1e-9) {
          const kind = materials[matId[e]].kind;
          assert.strictEqual(
            kind, "air",
            `rotor collar element e=${e} at r=${cr.toFixed(6)} has kind="${kind}", expected "air"`
          );
        }
      }
    }

    // Stator: collar is from statorGapR to r_stator_bore
    {
      const { nodes, elems, matId, materials } = stator;
      const Ne = elems.length / 4;
      for (let e = 0; e < Ne; e++) {
        let cx = 0, cy = 0;
        const count = elems[4*e+3] === -1 ? 3 : 4;
        for (let v = 0; v < count; v++) {
          const ni = elems[4*e + v];
          cx += nodes[2*ni];
          cy += nodes[2*ni+1];
        }
        cx /= count;
        cy /= count;
        const cr = Math.hypot(cx, cy);

        if (cr >= geo.statorGapR - 1e-9 && cr < geo.rStatorBore + 1e-9) {
          const kind = materials[matId[e]].kind;
          assert.strictEqual(
            kind, "air",
            `stator collar element e=${e} at r=${cr.toFixed(6)} has kind="${kind}", expected "air"`
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  gapLayers knob adds radial layers
// ---------------------------------------------------------------------------

describe("gapLayers knob adds radial layers", () => {
  it("gapLayers:4 yields more collar elements than gapLayers:2; minAngle > 20 at both", () => {
    const section = gapSection();
    const build2 = MotorMesh.build(section, { gapLayers: 2 });
    const build4 = MotorMesh.build(section, { gapLayers: 4 });

    // Count collar elements (radially between feature surface and gapR) for rotor
    const geo = gapGeom(section);

    function collarElemCount(body, surfaceR, collarR, inner) {
      const { nodes, elems } = body;
      const Ne = elems.length / 4;
      let count = 0;
      for (let e = 0; e < Ne; e++) {
        let cx = 0, cy = 0;
        const nv = elems[4*e+3] === -1 ? 3 : 4;
        for (let v = 0; v < nv; v++) {
          const ni = elems[4*e + v];
          cx += nodes[2*ni];
          cy += nodes[2*ni+1];
        }
        cx /= nv;
        cy /= nv;
        const cr = Math.hypot(cx, cy);
        if (!inner) {
          if (cr >= surfaceR - 1e-9 && cr <= collarR + 1e-9) count++;
        } else {
          if (cr >= collarR - 1e-9 && cr <= surfaceR + 1e-9) count++;
        }
      }
      return count;
    }

    const collar2 = collarElemCount(build2.rotor, geo.rRotorSurface, geo.rotorGapR, false);
    const collar4 = collarElemCount(build4.rotor, geo.rRotorSurface, geo.rotorGapR, false);

    assert.ok(
      collar4 > collar2,
      `gapLayers:4 collar elem count=${collar4} should be > gapLayers:2 count=${collar2}`
    );

    // minAngle > 20 at both settings
    const q2 = MotorMesh.quality(build2.rotor);
    const q4 = MotorMesh.quality(build4.rotor);
    assert.ok(q2.minAngle > 20, `gapLayers:2 minAngle=${q2.minAngle} not > 20`);
    assert.ok(q4.minAngle > 20, `gapLayers:4 minAngle=${q4.minAngle} not > 20`);
  });
});

// ---------------------------------------------------------------------------
//  dofBudget caps node count
// ---------------------------------------------------------------------------

// Build a section with P_body = 8 (8 alternating magnets) whose unbudgeted
// mesh exceeds 200 nodes, so dofBudget:200 triggers a real reduction.
function eightMagnetSection() {
  const features = [];
  for (let i = 0; i < 8; i++) {
    features.push({
      kind: "magnet", member: "rotor",
      rRange: [0.040, 0.043],
      thetaRange: [i * TWO_PI / 8, (i + 1) * TWO_PI / 8],
      Mr: i % 2 === 0 ? 9e5 : -9e5, Mtheta: 0,
    });
  }
  // Three radial iron bands to ensure unbudgeted Nn > 200
  features.push({ kind: "iron", member: "rotor", rRange: [0.030, 0.034], thetaRange: [0, TWO_PI], muR: 1000 });
  features.push({ kind: "iron", member: "rotor", rRange: [0.034, 0.037], thetaRange: [0, TWO_PI], muR: 500  });
  features.push({ kind: "iron", member: "rotor", rRange: [0.037, 0.040], thetaRange: [0, TWO_PI], muR: 1000 });
  features.push({ kind: "iron", member: "stator", rRange: [0.050, 0.060], thetaRange: [0, TWO_PI], muR: 1000 });
  return { features };
}

describe("dofBudget caps node count", () => {
  it("dofBudget:200 on P_body=8 body produces Nn <= 200+P_body, less than unbudgeted, no inverted", () => {
    const section  = eightMagnetSection();
    const P_body   = computeBodyPeriod(section, "rotor"); // expect 8

    const unbudgeted = MotorMesh.build(section, {});
    const budgeted   = MotorMesh.build(section, { dofBudget: 200 });

    const Nn_unbudgeted = unbudgeted.rotor.nodes.length / 2;
    const Nn_budgeted   = budgeted.rotor.nodes.length / 2;

    // Unbudgeted must actually exceed the budget so the test is meaningful
    assert.ok(
      Nn_unbudgeted > 200 + P_body,
      `test precondition: unbudgeted Nn=${Nn_unbudgeted} should exceed budget+P_body=${200 + P_body}`
    );
    assert.ok(
      Nn_budgeted <= 200 + P_body,
      `Nn_budgeted=${Nn_budgeted} > dofBudget+P_body=${200 + P_body}`
    );
    assert.ok(
      Nn_budgeted < Nn_unbudgeted,
      `budgeted Nn=${Nn_budgeted} should be < unbudgeted Nn=${Nn_unbudgeted}`
    );
    const q = MotorMesh.quality(budgeted.rotor);
    assert.strictEqual(q.nInverted, 0, `nInverted=${q.nInverted} after dofBudget`);
  });
});

// ---------------------------------------------------------------------------
//  gapMinNodes floors the gap-circle node count
// ---------------------------------------------------------------------------

describe("gapMinNodes floors the gap-circle node count", () => {
  it("gapLoop.length >= 200, snapped to multiple of P_body, uniform gapTheta, no inverted", () => {
    // ringStackSection has P_body=4 for rotor
    const section = ringStackSection();
    const P_body = computeBodyPeriod(section, "rotor");

    const withFloor    = MotorMesh.build(section, { gapMinNodes: 200 });
    const withoutFloor = MotorMesh.build(section, {});

    const N_with    = withFloor.rotor.gapLoop.length;
    const N_without = withoutFloor.rotor.gapLoop.length;

    // Floor satisfied
    assert.ok(N_with >= 200, `gapLoop.length=${N_with} < 200 (floor not satisfied)`);

    // Snapped to multiple of P_body
    assert.strictEqual(
      N_with % P_body, 0,
      `gapLoop.length=${N_with} is not a multiple of P_body=${P_body}`
    );

    // gapTheta is still uniform
    const { gapTheta } = withFloor.rotor;
    const expectedStep = TWO_PI / N_with;
    for (let k = 1; k < N_with; k++) {
      const diff = gapTheta[k] - gapTheta[k - 1];
      assert.ok(
        Math.abs(diff - expectedStep) < 1e-9,
        `gapTheta not uniform at k=${k}: diff=${diff}, expected=${expectedStep}`
      );
    }

    // No inverted elements
    const q = MotorMesh.quality(withFloor.rotor);
    assert.strictEqual(q.nInverted, 0, `nInverted=${q.nInverted} with gapMinNodes`);

    // Without floor, gapLoop is smaller
    assert.ok(
      N_without < N_with,
      `without gapMinNodes, N=${N_without} should be < with gapMinNodes N=${N_with}`
    );
  });
});

// ---------------------------------------------------------------------------
//  gapMinNodes overrides dofBudget on the gap circle
// ---------------------------------------------------------------------------

describe("gapMinNodes overrides dofBudget on the gap circle", () => {
  it("gapLoop.length >= 200 with small dofBudget; total Nn reduced vs unbudgeted", () => {
    const section = ringStackSection();

    const unbudgeted = MotorMesh.build(section, { gapMinNodes: 200 });
    const both       = MotorMesh.build(section, { gapMinNodes: 200, dofBudget: 100 });

    const N_gap_both   = both.rotor.gapLoop.length;
    const Nn_unbudgeted = unbudgeted.rotor.nodes.length / 2;
    const Nn_both       = both.rotor.nodes.length / 2;

    // Floor wins on gap circle
    assert.ok(
      N_gap_both >= 200,
      `gapLoop.length=${N_gap_both} < 200 when gapMinNodes overrides dofBudget`
    );

    // Total node count is reduced vs unbudgeted (budget recovered from non-gap divisions)
    assert.ok(
      Nn_both < Nn_unbudgeted,
      `Nn_both=${Nn_both} should be < Nn_unbudgeted=${Nn_unbudgeted} (budget should reduce non-gap nodes)`
    );
  });
});
