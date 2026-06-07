"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LIB, assertClose } = require("./_fixtures.js");

const { commutationPhase, sectorGate, evalTerminal, evalDrive } = LIB.Excitation;

const TWO_PI = 2 * Math.PI;

test("commutationPhase closed forms", () => {
  // (poles/2)·theta + loadAngle = (4/2)·1.0 + 0.2 = 2.2
  const phaseElecSine = commutationPhase(
    { mode: "electronic-sine", poles: 4, loadAngle: 0.2 },
    { theta: 1.0 }
  );
  assertClose(phaseElecSine, 2 * 1.0 + 0.2, 1e-15, "electronic-sine poles=4 theta=1");

  // none → 0 regardless of theta
  const phaseNone = commutationPhase(
    { mode: "none" },
    { theta: 3.14 }
  );
  assertClose(phaseNone, 0, 1e-15, "none → 0");
});

test("none is rotor-independent, time-dependent", () => {
  const terminal = { type: "AC", amp: 5, freq: 10, phaseOffset: 0.3 };
  const commutation = { mode: "none" };
  const t = 0.025;

  const v0 = evalTerminal({ terminal, commutation }, { t, theta: 0, stepIndex: 0 }).V;
  const v1 = evalTerminal({ terminal, commutation }, { t, theta: 1, stepIndex: 0 }).V;
  const v2 = evalTerminal({ terminal, commutation }, { t, theta: 2, stepIndex: 0 }).V;
  assertClose(v0, v1, 1e-15, "none: theta-independent v0==v1");
  assertClose(v0, v2, 1e-15, "none: theta-independent v0==v2");

  // freq=10: same theta, t=0 vs t=0.005 gives a measurable phase advance
  const vT0 = evalTerminal({ terminal, commutation }, { t: 0, theta: 0, stepIndex: 0 }).V;
  const vT5 = evalTerminal({ terminal, commutation }, { t: 0.005, theta: 0, stepIndex: 0 }).V;
  assert.notStrictEqual(vT0, vT5);
});

test("electronic-sine slaves phase to rotor, not time", () => {
  const amp = 7, poles = 2, loadAngle = 0.4, phaseOffset = 0.2;
  const terminal = { type: "AC", amp, freq: 50, phaseOffset };
  const commutation = { mode: "electronic-sine", poles, loadAngle };
  const theta = 1.1;

  // Closed form: V = amp·cos((poles/2)·theta + loadAngle + phaseOffset)
  const expected = amp * Math.cos((poles / 2) * theta + loadAngle + phaseOffset);

  const vT0 = evalTerminal({ terminal, commutation }, { t: 0, theta, stepIndex: 0 }).V;
  const vT1 = evalTerminal({ terminal, commutation }, { t: 1, theta, stepIndex: 0 }).V;
  assertClose(vT0, expected, 1e-9, "electronic-sine closed form");
  assertClose(vT0, vT1, 1e-15, "electronic-sine t-independent");
});

test("electronic-trap conducting set matches 6-step table", () => {
  const amp = 10;
  const conductionAngle = TWO_PI / 3;
  const poles = 2;
  const circuits = [0, 1, 2].map(k => ({
    terminal: { type: "PULSE", amp, conductionAngle, phaseOffset: -TWO_PI * k / 3 },
    commutation: { mode: "electronic-trap", poles },
  }));

  // At theta=π/2: base=(poles/2)·θ=π/2.
  // Circuit 0: gate(π/2+0, 2π/3) → +1 → V:+amp
  // Circuit 1: gate(π/2−2π/3, 2π/3) → a=11π/6 → 0 → open
  // Circuit 2: gate(π/2−4π/3, 2π/3) → a=7π/6 ∈ [π,5π/3) → −1 → V:−amp
  const theta = Math.PI / 2;
  const conds = evalDrive(circuits, { t: 0, theta, stepIndex: 0 });

  assert.deepStrictEqual(conds[0], { kind: "voltage", V: amp });
  assert.deepStrictEqual(conds[1], { kind: "open" });
  assert.deepStrictEqual(conds[2], { kind: "voltage", V: -amp });
});

test("mechanical mode supplies DC ungated at every rotor angle", () => {
  // Mechanical commutation is modeled spatially in the slice (brush/commutator
  // current-sheet); the excitation layer supplies the raw terminal ungated, so
  // the rotor angle must NOT change V. A scalar gate reappearing here would
  // double-count against the spatial map.
  const terminal = { type: "DC", amp: 12 };
  const commutation = { mode: "mechanical", poles: 2, conductionAngle: Math.PI };
  for (const theta of [0.1, Math.PI, Math.PI + 0.1, 2 * Math.PI - 0.3]) {
    const cond = evalTerminal({ terminal, commutation }, { t: 0, theta, stepIndex: 0 });
    assert.strictEqual(cond.kind, "voltage");
    assertClose(cond.V, 12, 1e-12, "DC mechanical ungated +12 at theta=" + theta);
  }
});

test("mechanical mode supplies AC ungated (rotor-angle-independent)", () => {
  // Ungated raw AC: V = amp·cos(2π·freq·t + phaseOffset), independent of theta.
  const terminal = { type: "AC", amp: 10, freq: 1, phaseOffset: 0 };
  const commutation = { mode: "mechanical", poles: 2, conductionAngle: Math.PI };
  for (const theta of [0.3, Math.PI / 2, 3 * Math.PI / 2]) {
    const cond = evalTerminal({ terminal, commutation }, { t: 0, theta, stepIndex: 0 });
    assert.strictEqual(cond.kind, "voltage");
    assertClose(cond.V, 10, 1e-9, "mechanical AC ungated V=10 at theta=" + theta);
  }
});

test("sequencer commutation table selects per-step energization", () => {
  const amp = 5;
  // Two-phase full-step table — the 4-state cycle the PM/hybrid steppers run.
  const circuitA = { terminal: { type: "STEP", amp }, commutation: { mode: "sequencer", pattern: [1, 1, -1, -1] } };
  const circuitB = { terminal: { type: "STEP", amp }, commutation: { mode: "sequencer", pattern: [-1, 1, 1, -1] } };

  const results = [0, 1, 2, 3].map(stepIndex => {
    const ctx = { stepIndex };
    return { a: evalTerminal(circuitA, ctx), b: evalTerminal(circuitB, ctx) };
  });

  for (const { a, b } of results) {
    assert.strictEqual(a.kind, "voltage");
    assert.strictEqual(b.kind, "voltage");
  }

  const v = results.map(({ a, b }) => [a.V, b.V]);
  assert.deepStrictEqual(v[0], [amp, -amp], "step 0 (+,−)");
  assert.deepStrictEqual(v[1], [amp, amp],  "step 1 (+,+)");
  assert.deepStrictEqual(v[2], [-amp, amp], "step 2 (−,+)");
  assert.deepStrictEqual(v[3], [-amp, -amp],"step 3 (−,−)");

  // stepIndex wraps modulo the table length, including negative indices.
  assert.deepStrictEqual(evalTerminal(circuitA, { stepIndex: 4 }), { kind: "voltage", V: amp },  "step 4 wraps to 0");
  assert.deepStrictEqual(evalTerminal(circuitA, { stepIndex: -1 }), { kind: "voltage", V: -amp }, "step −1 wraps to 3");
});

test("sequencer table: a zero entry opens the winding; CURRENT scales by entry", () => {
  const amp = 4;
  const seq = { mode: "sequencer", pattern: [1, 0, -1] };   // one-phase-on style (off-step in the middle)

  const cV = { terminal: { type: "STEP", amp }, commutation: seq };
  assert.deepStrictEqual(evalTerminal(cV, { stepIndex: 0 }), { kind: "voltage", V: amp });
  assert.deepStrictEqual(evalTerminal(cV, { stepIndex: 1 }), { kind: "open" });
  assert.deepStrictEqual(evalTerminal(cV, { stepIndex: 2 }), { kind: "voltage", V: -amp });

  const cI = { terminal: { type: "CURRENT", amp }, commutation: seq };
  assert.deepStrictEqual(evalTerminal(cI, { stepIndex: 0 }), { kind: "current", I: amp });
  assert.deepStrictEqual(evalTerminal(cI, { stepIndex: 1 }), { kind: "open" });
  assert.deepStrictEqual(evalTerminal(cI, { stepIndex: 2 }), { kind: "current", I: -amp });
});
