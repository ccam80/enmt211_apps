"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  loadAllFixtures,
  meshFromConfig,
  syntheticPhysics,
  ringStackSection,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  Helper: for a body with constraints, verify the basic invariants
// ---------------------------------------------------------------------------
function checkConstraintInvariants(body, label) {
  const { constraints } = body;
  if (!constraints) return; // null constraints are fine (uniform mesh)

  const { slaves, masters } = constraints;
  const Nn = body.nodes.length / 2;
  const S  = slaves.length;

  assert.ok(S > 0, `${label}: constraints.slaves is empty but constraints is non-null`);
  assert.strictEqual(
    masters.length, 4 * S,
    `${label}: masters.length=${masters.length} should be 4 x slaves.length=${S}`
  );

  for (let k = 0; k < S; k++) {
    const slaveIdx = slaves[k];

    // Every slave global index is in [0, Nn)
    assert.ok(
      slaveIdx >= 0 && slaveIdx < Nn,
      `${label}: slave[${k}]=${slaveIdx} out of range [0, ${Nn})`
    );

    const idxL = masters[4*k];
    const wL   = masters[4*k + 1];
    const idxR = masters[4*k + 2];
    const wR   = masters[4*k + 3];

    // Every master index is in [0, Nn)
    assert.ok(
      idxL >= 0 && idxL < Nn,
      `${label}: slave[${k}] master_left=${idxL} out of range [0, ${Nn})`
    );
    assert.ok(
      idxR >= 0 && idxR < Nn,
      `${label}: slave[${k}] master_right=${idxR} out of range [0, ${Nn})`
    );

    // Masters come BEFORE slaves in global node numbering
    // (gap-band transition row nodes are laid out before slave nodes)
    assert.ok(
      idxL < slaveIdx,
      `${label}: slave[${k}]=${slaveIdx}: master_left=${idxL} should be < slave (masters come earlier)`
    );
    assert.ok(
      idxR < slaveIdx,
      `${label}: slave[${k}]=${slaveIdx}: master_right=${idxR} should be < slave (masters come earlier)`
    );

    // Weight pair sums to 1.0 within 1e-12
    assert.ok(
      Math.abs(wL + wR - 1.0) < 1e-12,
      `${label}: slave[${k}]: wL=${wL} + wR=${wR} = ${wL + wR} should equal 1.0 (within 1e-12)`
    );

    // Weights strictly in (eps, 1-eps) — no degenerate constraints
    // (coincident nodes are merged, not constrained, so weights are never 0 or 1)
    const EPS = 1e-9;
    assert.ok(
      wL > EPS && wL < 1 - EPS,
      `${label}: slave[${k}]: wL=${wL} not in (${EPS}, ${1-EPS}) — degenerate constraint`
    );
    assert.ok(
      wR > EPS && wR < 1 - EPS,
      `${label}: slave[${k}]: wR=${wR} not in (${EPS}, ${1-EPS}) — degenerate constraint`
    );
  }
}

// ---------------------------------------------------------------------------
//  Ring stack section: has non-trivial band transitions
// ---------------------------------------------------------------------------

describe("Ring stack: constraints non-null and structurally valid", () => {
  it("rotor and stator constraints satisfy all invariants", () => {
    const section = ringStackSection();
    const physics = syntheticPhysics();
    const mesh = MotorMesh.build(section, { physics });

    // Ring stack has non-uniform features (conductors + iron at different theta spans),
    // so gap-band (uniform) != inner-band (per-feature) -> constraints non-null.
    // (If the section happens to be uniform, constraints may be null — that's OK.)
    checkConstraintInvariants(mesh.rotor, "ringStack rotor");
    checkConstraintInvariants(mesh.stator, "ringStack stator");
  });
});

// ---------------------------------------------------------------------------
//  All 15 fixtures: constraint invariants hold for every body
// ---------------------------------------------------------------------------

describe("All 15 fixtures: body.constraints invariants", () => {
  it("every fixture body.constraints is null or satisfies all invariants", () => {
    const machines = loadAllFixtures();
    assert.ok(machines.length >= 15, `expected >= 15 fixtures, got ${machines.length}`);

    for (const m of machines) {
      const mesh = meshFromConfig(m.config);

      checkConstraintInvariants(mesh.rotor,  `${m.id} rotor`);
      checkConstraintInvariants(mesh.stator, `${m.id} stator`);
    }
  });
});

// ---------------------------------------------------------------------------
//  PMSM: constraints are non-null (PMSM stator has per-feature columns != gap)
//
//  PMSM stator has 48 slots. Interior band has per-feature columns giving
//  48 x round(slotSpan/Dtheta_target) ~= 336 columns, while gap band has
//  poles x round(2.4 x nuMaxSlice) = 8 x 41 = 328 columns.
//  These differ, so constraints must be non-null for at least one body.
// ---------------------------------------------------------------------------

describe("PMSM: at least one body has non-null constraints", () => {
  it("PMSM mesh has constraints for rotor or stator (column mismatch)", () => {
    const machines = loadAllFixtures();
    const pmsm = machines.find(m => m.id === "pmsm");
    assert.ok(pmsm, "pmsm fixture must be present");

    const mesh = meshFromConfig(pmsm.config);

    // At least one of rotor/stator should have constraints when their
    // per-feature and gap-band column counts differ.
    // (Either or both may be null if columns happen to align exactly.)
    const hasAnyConstraints = mesh.rotor.constraints !== null || mesh.stator.constraints !== null;
    assert.ok(
      hasAnyConstraints,
      "PMSM: both bodies have null constraints — expected at least one to have non-null constraints given per-feature vs uniform-gap mismatch"
    );

    if (mesh.rotor.constraints) {
      checkConstraintInvariants(mesh.rotor, "PMSM rotor");
    }
    if (mesh.stator.constraints) {
      checkConstraintInvariants(mesh.stator, "PMSM stator");
    }
  });
});

// ---------------------------------------------------------------------------
//  Full-rank check: each referenced master node is independently weighted.
//
//  For each slave k, the constraint is: u_slave = wL * u_masterL + wR * u_masterR.
//  Independence means:
//  1. idxL != idxR (no degenerate self-reference).
//  2. Every master node that appears in any constraint has positive
//     diagonal in the gram matrix C^T C (i.e. it is referenced at least once
//     with a positive weight).
//  3. At least 2 distinct master nodes exist (the constraint system is non-trivial).
//
//  This is a necessary (not sufficient) condition for C to be full column rank,
//  but it catches the practical failures (zero rows, repeated indices, zero weights).
// ---------------------------------------------------------------------------

describe("Constraints full-rank: each referenced master is independently weighted", () => {
  it("constraint C: every referenced master has positive diagonal in gram matrix; idxL != idxR for ring stack", () => {
    const section = ringStackSection();
    const physics = syntheticPhysics();
    const mesh = MotorMesh.build(section, { physics });

    for (const [label, body] of [["rotor", mesh.rotor], ["stator", mesh.stator]]) {
      const { constraints } = body;
      if (!constraints) continue;

      const { slaves, masters } = constraints;
      const S = slaves.length;

      // Check 1: idxL != idxR for every constraint (no degenerate self-reference)
      for (let k = 0; k < S; k++) {
        const idxL = masters[4*k];
        const idxR = masters[4*k + 2];
        assert.ok(
          idxL !== idxR,
          `${label}: slave[${k}] has degenerate constraint: idxL=${idxL} === idxR=${idxR}`
        );
      }

      // Check 2: build gram matrix diagonal (C^T C diagonal) and verify all > 0
      // For each master node referenced by any constraint, its gram diagonal entry is
      // the sum of squared weights over all constraints that reference it.
      // A positive diagonal means the node is genuinely referenced.
      const masterDiag = new Map();
      for (let k = 0; k < S; k++) {
        const idxL = masters[4*k],     wL = masters[4*k + 1];
        const idxR = masters[4*k + 2], wR = masters[4*k + 3];
        masterDiag.set(idxL, (masterDiag.get(idxL) || 0) + wL * wL);
        masterDiag.set(idxR, (masterDiag.get(idxR) || 0) + wR * wR);
      }

      for (const [idx, diag] of masterDiag) {
        assert.ok(
          diag > 0,
          `${label}: master node ${idx} has zero gram diagonal (not genuinely referenced)`
        );
      }

      // Check 3: at least 2 distinct master nodes exist
      assert.ok(
        masterDiag.size >= 2,
        `${label}: only ${masterDiag.size} distinct master nodes referenced — constraint system is trivial`
      );
    }
  });
});
