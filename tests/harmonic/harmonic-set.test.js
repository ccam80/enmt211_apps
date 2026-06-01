"use strict";

// =============================================================================
//  HarmonicSet.derive — geometry-driven sparse harmonic basis.
//
//  Gate at THIS layer: field-reconstruction coverage. The derived kList must
//  span the gap field, on BOTH gap circles, for every excitation the solver can
//  be handed — proven via the per-circuit unit-excitation superposition basis +
//  magnet baseline + saturated point. We assert (a) the worst-case captured
//  energy fraction across all probes is ≥ 1−ε² (the basis reconstructs every
//  probe to the ε field tolerance), (b) the basis includes the low-energy-but-
//  required triplen k=6 that an energy threshold drops, (c) it compresses.
//
//  The end-to-end torque/back-EMF gate lives in the machine suite once motor-
//  slice builds with the derived kList (Step B).
// =============================================================================

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const F = require("../machines/_fixtures.js");
require(path.join(__dirname, "..", "..", "lib", "harmonic-set.js"));
const HS = global.window.LIB.HarmonicSet;

function slotCounts(cfg) {
  const o = [];
  for (const r of cfg.rings) {
    if (r.winding && r.winding.standard) o.push(r.winding.standard.Q);
    if (r.cage) o.push(r.cage.bars);
    if (r.teeth && r.teeth > 1) o.push(r.teeth);
  }
  return o;
}

const EPS = 0.01;                 // 1% gap-field reconstruction tolerance
const ANGLES = [0, 0.041];        // a couple of θ so slot bands surface

describe("HarmonicSet.derive — geometry-driven basis", function () {
  before(async function () {
    await F.initSolver();
  });

  it("induction basis includes the triplen k=6 (energy-thresholding drops it)", function () {
    const b = F.build("induction-3ph");
    const probe = HS.probeFromStack(b.stack, slotCounts(F.byId["induction-3ph"].config));
    const res = HS.derive(probe, { epsilon: EPS, angles: ANGLES });
    // k=6 = 3·(p/2) is excited single-phase / unbalanced but cancels balanced.
    assert.ok(res.kList.includes(6),
      `induction kList must include k=6; got ${JSON.stringify(res.kList)}`);
    // basis spans every probe's gap field to the ε tolerance
    assert.ok(res.coverage >= 1 - EPS * EPS,
      `worst-case coverage ${res.coverage} < ${1 - EPS * EPS}`);
    // and it actually compresses the dense truncation
    assert.ok(res.perBody < res.perBodyFull,
      `perBody ${res.perBody} not < full ${res.perBodyFull}`);
  });

  for (const id of ["pmsm", "bldc", "vr-stepper", "synchronous-reluctance"]) {
    it(`${id}: basis reconstructs every probe to ε and compresses`, function () {
      const b = F.build(id);
      const probe = HS.probeFromStack(b.stack, slotCounts(F.byId[id].config));
      const res = HS.derive(probe, { epsilon: EPS, angles: ANGLES });
      assert.ok(res.coverage >= 1 - EPS * EPS,
        `${id} worst-case coverage ${res.coverage} < ${1 - EPS * EPS}`);
      assert.ok(res.kList.length >= 1, `${id} empty kList`);
      assert.ok(res.perBody <= res.perBodyFull,
        `${id} perBody ${res.perBody} > full ${res.perBodyFull}`);
      // the derived basis must be a valid input to the gap operator
      assert.ok(res.kList.every((k) => Number.isInteger(k) && k >= 1),
        `${id} kList has non-positive-integer order`);
    });
  }

  it("tighter ε never shrinks the basis (monotonic in accuracy)", function () {
    const b = F.build("pmsm");
    const probe = HS.probeFromStack(b.stack, slotCounts(F.byId["pmsm"].config));
    const loose = HS.derive(probe, { epsilon: 0.05, angles: ANGLES });
    const tight = HS.derive(probe, { epsilon: 0.001, angles: ANGLES });
    assert.ok(tight.kList.length >= loose.kList.length,
      `tight ${tight.kList.length} < loose ${loose.kList.length}`);
    // looser set ⊆ tighter set
    const tset = new Set(tight.kList);
    assert.ok(loose.kList.every((k) => tset.has(k)),
      "looser basis must be a subset of the tighter basis");
  });
});
