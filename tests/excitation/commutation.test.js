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
    { t: 0, theta: 1.0, stepIndex: 0 }
  );
  assertClose(phaseElecSine, 2 * 1.0 + 0.2, 1e-15, "electronic-sine poles=4 theta=1");

  // stepIndex·stepAngleElec = 3·(π/2) = 3π/2
  const phaseSeq = commutationPhase(
    { mode: "sequencer", stepAngleElec: Math.PI / 2 },
    { t: 0, theta: 0, stepIndex: 3 }
  );
  assertClose(phaseSeq, 3 * Math.PI / 2, 1e-15, "sequencer stepIndex=3");

  // none → 0 regardless of theta/t
  const phaseNone = commutationPhase(
    { mode: "none" },
    { t: 5, theta: 3.14, stepIndex: 7 }
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

test("sequencer advances energized phase by step index", () => {
  const amp = 5;
  // Two-phase bipolar STEP+sequencer: offsets 0 and −π/2, stepAngleElec=π/2, conductionAngle=π.
  // Derived sign pattern per sectorGate(base + phaseOffset, π):
  //   step 0: base=0;    A: gate(0,π)=+1 → +amp;  B: gate(−π/2,π)→3π/2∈[π,2π)→−1 → −amp
  //   step 1: base=π/2;  A: gate(π/2,π)=+1 → +amp; B: gate(0,π)=+1 → +amp
  //   step 2: base=π;    A: gate(π,π)→−1 → −amp;   B: gate(π/2,π)=+1 → +amp
  //   step 3: base=3π/2; A: gate(3π/2,π)→−1→−amp;  B: gate(π,π)→−1 → −amp
  const circuitA = {
    terminal: { type: "STEP", amp, conductionAngle: Math.PI, phaseOffset: 0 },
    commutation: { mode: "sequencer", stepAngleElec: Math.PI / 2 },
  };
  const circuitB = {
    terminal: { type: "STEP", amp, conductionAngle: Math.PI, phaseOffset: -Math.PI / 2 },
    commutation: { mode: "sequencer", stepAngleElec: Math.PI / 2 },
  };

  const results = [0, 1, 2, 3].map(stepIndex => {
    const ctx = { t: 0, theta: 0, stepIndex };
    return {
      a: evalTerminal(circuitA, ctx),
      b: evalTerminal(circuitB, ctx),
    };
  });

  for (const { a, b } of results) {
    assert.strictEqual(a.kind, "voltage");
    assert.strictEqual(b.kind, "voltage");
  }

  const signs = results.map(({ a, b }) => [Math.sign(a.V), Math.sign(b.V)]);
  assert.deepStrictEqual(signs[0], [1, -1],  "step 0 signs (+,−)");
  assert.deepStrictEqual(signs[1], [1,  1],  "step 1 signs (+,+)");
  assert.deepStrictEqual(signs[2], [-1, 1],  "step 2 signs (−,+)");
  assert.deepStrictEqual(signs[3], [-1, -1], "step 3 signs (−,−)");

  // All 4 sign-pair patterns are distinct — completes a full bipolar 4-step cycle
  const unique = new Set(signs.map(p => p.join(",")));
  assert.strictEqual(unique.size, 4, "all 4 sign patterns are distinct");
});
