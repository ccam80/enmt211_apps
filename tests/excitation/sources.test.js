"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LIB, assertClose } = require("./_fixtures.js");

const { supplyValue, sectorGate, evalTerminal, evalDrive } = LIB.Excitation;

const TWO_PI = 2 * Math.PI;

test("DC supply is constant in time", () => {
  const terminal = { type: "DC", amp: 5 };
  for (const t of [0, 0.137, 10]) {
    assert.strictEqual(supplyValue(terminal, t), 5);
  }
});

test("AC supply equals amp·cos(2πf t + offset)", () => {
  const terminal = { type: "AC", amp: 230, freq: 50, phaseOffset: 0.3 };
  const t = 0.004;
  const expected = 230 * Math.cos(TWO_PI * 50 * t + 0.3);
  assertClose(supplyValue(terminal, t), expected, 1e-9, "AC supply at t=0.004");
});

test("balanced 3-phase voltages sum to ~0", () => {
  const amp = 1, freq = 50;
  const circuits = [0, 1, 2].map(k => ({
    terminal: { type: "AC", amp, freq, phaseOffset: -TWO_PI * k / 3 },
    commutation: { mode: "none" },
  }));
  for (const t of [0, 0.003, 0.007]) {
    const conds = evalDrive(circuits, { t, theta: 0, stepIndex: 0 });
    const sum = conds.reduce((s, c) => s + c.V, 0);
    assertClose(sum, 0, 1e-12, `3-phase sum at t=${t}`);
  }
});

test("N-phase generalization (m=5) sums to ~0", () => {
  const m = 5, amp = 1, freq = 50;
  const circuits = Array.from({ length: m }, (_, k) => ({
    terminal: { type: "AC", amp, freq, phaseOffset: -TWO_PI * k / m },
    commutation: { mode: "none" },
  }));
  for (const t of [0, 0.003, 0.007]) {
    const conds = evalDrive(circuits, { t, theta: 0, stepIndex: 0 });
    const sum = conds.reduce((s, c) => s + c.V, 0);
    assertClose(sum, 0, 1e-12, `5-phase sum at t=${t}`);
  }
});

test("single-phasing: one OPEN drops a phase", () => {
  const circuits = [
    { terminal: { type: "AC", amp: 1, freq: 50, phaseOffset: 0 }, commutation: { mode: "none" } },
    { terminal: { type: "OPEN" }, commutation: { mode: "none" } },
    { terminal: { type: "AC", amp: 1, freq: 50, phaseOffset: -TWO_PI * 2 / 3 }, commutation: { mode: "none" } },
  ];
  const conds = evalDrive(circuits, { t: 0.001, theta: 0, stepIndex: 0 });
  assert.strictEqual(conds[1].kind, "open");
  assert.strictEqual(conds[0].kind, "voltage");
  assert.strictEqual(conds[2].kind, "voltage");
});

test("PULSE 6-step gate pattern", () => {
  const ca = TWO_PI / 3;
  assert.strictEqual(sectorGate(Math.PI / 6), 1);
  assert.strictEqual(sectorGate(TWO_PI / 3 + 0.01), 0);
  assert.strictEqual(sectorGate(Math.PI + Math.PI / 6), -1);
  assert.strictEqual(sectorGate(TWO_PI - 0.01), 0);
});

test("PULSE dead sector is open, active sector is ±amp", () => {
  const terminal = { type: "PULSE", amp: 48, conductionAngle: TWO_PI / 3 };
  const commutation = { mode: "electronic-trap", poles: 2 };

  // theta = π/6: θ_comm = (2/2)·π/6 + 0 = π/6; sectorGate(π/6 + 0, 2π/3) = +1
  const condActive = evalTerminal({ terminal, commutation }, { t: 0, theta: Math.PI / 6, stepIndex: 0 });
  assert.deepStrictEqual(condActive, { kind: "voltage", V: 48 });

  // theta = 3π/4: θ_comm = 3π/4; sectorGate(3π/4, 2π/3): a = 3π/4 ∈ [2π/3, π) → 0 → open
  const condDead = evalTerminal({ terminal, commutation }, { t: 0, theta: 3 * Math.PI / 4, stepIndex: 0 });
  assert.deepStrictEqual(condDead, { kind: "open" });
});

test("STEP holds ±amp with no dead zone", () => {
  const terminal = { type: "STEP", amp: 3, conductionAngle: Math.PI };
  const commutation = { mode: "sequencer", stepAngleElec: Math.PI / 2 };

  // stepIndex=0: base = 0·π/2 = 0; sectorGate(0, π): a=0 ∈ [0,π) → +1 → V:3
  const cond0 = evalTerminal({ terminal, commutation }, { t: 0, theta: 0, stepIndex: 0 });
  assert.deepStrictEqual(cond0, { kind: "voltage", V: 3 });

  // stepIndex=2: base = 2·π/2 = π; sectorGate(π, π): a=π ∈ [π, 2π) → -1 → V:-3
  const cond2 = evalTerminal({ terminal, commutation }, { t: 0, theta: 0, stepIndex: 2 });
  assert.deepStrictEqual(cond2, { kind: "voltage", V: -3 });

  // Verify neither is open
  assert.notStrictEqual(cond0.kind, "open");
  assert.notStrictEqual(cond2.kind, "open");
});

test("STEP in mode:none at a dead-sector angle holds voltage, not open", () => {
  // ψ = 2π·1·(5/12) + 0 = 5π/6; sectorGate(5π/6, 2π/3): a=5π/6 ∈ [2π/3, π) → 0
  // STEP holds positive: result is {kind:"voltage", V:10}
  const terminal = { type: "STEP", amp: 10, freq: 1, phaseOffset: 0, conductionAngle: TWO_PI / 3 };
  const commutation = { mode: "none" };
  const cond = evalTerminal({ terminal, commutation }, { t: 5 / 12, theta: 0, stepIndex: 0 });
  assert.deepStrictEqual(cond, { kind: "voltage", V: 10 });
});

test("CURRENT in mode none imposes a constant current", () => {
  const circuit = {
    terminal: { type: "CURRENT", amp: 12 },
    commutation: { mode: "none" },
  };
  for (const t of [0, 0.137, 10]) {
    assert.deepStrictEqual(
      evalTerminal(circuit, { t, theta: 0, stepIndex: 0 }),
      { kind: "current", I: 12 }
    );
  }
});

test("CURRENT under electronic-sine is commutation-phase-independent", () => {
  const circuit = {
    terminal: { type: "CURRENT", amp: 12 },
    commutation: { mode: "electronic-sine", poles: 4 },
  };
  for (const theta of [0, 0.5, 2.1]) {
    assert.deepStrictEqual(
      evalTerminal(circuit, { t: 0, theta, stepIndex: 0 }),
      { kind: "current", I: 12 }
    );
  }
});

test("CURRENT under sequencer imposes a constant current", () => {
  const circuit = {
    terminal: { type: "CURRENT", amp: 12 },
    commutation: { mode: "sequencer", stepAngleElec: Math.PI / 2 },
  };
  for (const ctx of [{ t: 0, theta: 0, stepIndex: 0 }, { t: 0, theta: 0, stepIndex: 2 }]) {
    assert.deepStrictEqual(
      evalTerminal(circuit, ctx),
      { kind: "current", I: 12 }
    );
  }
});

test("CURRENT under mechanical gates like DC", () => {
  const circuit = {
    terminal: { type: "CURRENT", amp: 12 },
    commutation: { mode: "mechanical", poles: 2, conductionAngle: 2 * Math.PI / 3 },
  };
  // theta = π/6: base = (2/2)·π/6 = π/6; sectorGate(π/6, 2π/3): a=π/6 ∈ [0,2π/3) → g=+1
  assert.deepStrictEqual(
    evalTerminal(circuit, { t: 0, theta: Math.PI / 6, stepIndex: 0 }),
    { kind: "current", I: 12 }
  );
  // theta = 5π/6: base = 5π/6; sectorGate(5π/6, 2π/3): a=5π/6 ∈ [2π/3,π) → g=0 → open
  assert.deepStrictEqual(
    evalTerminal(circuit, { t: 0, theta: 5 * Math.PI / 6, stepIndex: 0 }),
    { kind: "open" }
  );
  // theta = 7π/6: base = 7π/6; sectorGate(7π/6, 2π/3): a=7π/6 ∈ [π, π+2π/3) → g=-1
  assert.deepStrictEqual(
    evalTerminal(circuit, { t: 0, theta: 7 * Math.PI / 6, stepIndex: 0 }),
    { kind: "current", I: -12 }
  );
});

test("evalDrive maps a mixed CURRENT + AC circuit set", () => {
  const circuits = [
    { terminal: { type: "CURRENT", amp: 12 }, commutation: { mode: "none" } },
    { terminal: { type: "AC", amp: 1, freq: 50, phaseOffset: 0 }, commutation: { mode: "none" } },
    { terminal: { type: "AC", amp: 1, freq: 50, phaseOffset: -TWO_PI / 3 }, commutation: { mode: "none" } },
    { terminal: { type: "AC", amp: 1, freq: 50, phaseOffset: -4 * Math.PI / 3 }, commutation: { mode: "none" } },
  ];
  const conds = evalDrive(circuits, { t: 0, theta: 0, stepIndex: 0 });
  assert.strictEqual(conds[0].kind, "current");
  assert.strictEqual(conds[1].kind, "voltage");
  assert.strictEqual(conds[2].kind, "voltage");
  assert.strictEqual(conds[3].kind, "voltage");
  assert.strictEqual(conds[0].I, 12);
});

test("OPEN→open, SHORT→short regardless of mode", () => {
  const modes = ["none", "electronic-sine", "electronic-trap", "sequencer", "mechanical"];
  const ctx = { t: 0.1, theta: 0.5, stepIndex: 1 };

  for (const mode of modes) {
    const commutation = { mode, poles: 2, stepAngleElec: Math.PI / 2, conductionAngle: Math.PI };

    const openCond = evalTerminal(
      { terminal: { type: "OPEN" }, commutation },
      ctx
    );
    assert.strictEqual(openCond.kind, "open", `OPEN under mode=${mode}`);

    const shortCond = evalTerminal(
      { terminal: { type: "SHORT" }, commutation },
      ctx
    );
    assert.strictEqual(shortCond.kind, "short", `SHORT under mode=${mode}`);
  }
});
