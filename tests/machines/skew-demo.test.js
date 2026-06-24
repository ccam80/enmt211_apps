"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, sweepTorque, assertClose, dftAmp,
  LIB, UnifiedMotor,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("skew-demo");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("skew-demo");
  assert.equal(expanded.nCircuits, config.circuits.length);
  for (const slice of expanded.slices) {
    for (const feature of slice.section.features) {
      assert.ok(
        feature.kind === "conductor" ||
        feature.kind === "magnet" ||
        feature.kind === "iron",
        `unexpected feature kind: ${feature.kind}`
      );
    }
  }
});

test("skew nulls the slot-harmonic ripple while preserving the fundamental torque", { timeout: 90000 }, function () {
  // A 1-slot-pitch continuous skew (4 slices) should strongly null the stator
  // slot-passing torque ripple (order 48 = 48 slots, per mechanical revolution)
  // while leaving the working torque — the order-(poles/2) fundamental —
  // essentially unchanged. The raw peak-to-peak ripple is dominated by that
  // fundamental, which skew does NOT touch, so a DFT must separate the two
  // orders. Sweep a full revolution so order 48 is resolved (N/2 = 64 > 48).
  const { stack: skewStack, config } = build("skew-demo");
  const SLOT_ORDER = 48;                 // 48 stator slots
  const FUND_ORDER = config.poles / 2;   // = 4, the working-torque fundamental
  const N = 128;
  const thetas = [];
  for (let k = 0; k < N; k++) thetas.push((k / N) * 2 * Math.PI);
  const cur = new Float64Array([24, -12, -12]);

  const cloned = JSON.parse(JSON.stringify(config));
  cloned.stack.sliceOffsets = [0, 0, 0, 0];
  const unskewStack = LIB.MotorStack.create(UnifiedMotor.ConfigSchema.expand(cloned));

  const Tskew = sweepTorque(skewStack, cur, thetas);
  const Tflat = sweepTorque(unskewStack, cur, thetas);

  const slotSkew = dftAmp(Tskew, SLOT_ORDER), slotFlat = dftAmp(Tflat, SLOT_ORDER);
  const fundSkew = dftAmp(Tskew, FUND_ORDER), fundFlat = dftAmp(Tflat, FUND_ORDER);

  // Slot harmonic is present unskewed and strongly nulled by the skew (>70%).
  assert.ok(slotFlat > 1e-1, `unskewed slot harmonic amp=${slotFlat} not present`);
  assert.ok(slotSkew < 0.3 * slotFlat,
    `skew did not null the order-${SLOT_ORDER} slot harmonic: skewed=${slotSkew.toExponential(2)} vs flat=${slotFlat.toExponential(2)}`);

  // The working torque (order poles/2) is preserved within 5%.
  assert.ok(fundFlat > 1, `unskewed fundamental amp=${fundFlat} implausibly small`);
  assertClose(fundSkew, fundFlat, 0.05 * fundFlat);
});
