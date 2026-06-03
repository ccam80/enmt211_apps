"use strict";
(function () {

  const TWO_PI = 2 * Math.PI;

  /**
   * commutationPhase(spec, ctx) → number
   *
   * spec = { mode, poles = 2, loadAngle = 0, stepAngleElec = 0 }
   * ctx  = { t = 0, theta = 0, stepIndex = 0 }
   *
   * Returns the commutation phase reference θ_comm (electrical radians).
   *   "mechanical" | "electronic-sine" | "electronic-trap" → (poles/2)·theta + loadAngle
   *   "sequencer" → stepIndex · stepAngleElec
   *   "none"      → 0
   */
  function commutationPhase(spec, ctx) {
    const mode         = spec.mode;
    const poles        = spec.poles        != null ? spec.poles        : 2;
    const loadAngle    = spec.loadAngle    != null ? spec.loadAngle    : 0;
    const stepAngleElec = spec.stepAngleElec != null ? spec.stepAngleElec : 0;

    const t         = ctx.t         != null ? ctx.t         : 0;
    const theta     = ctx.theta     != null ? ctx.theta     : 0;
    const stepIndex = ctx.stepIndex != null ? ctx.stepIndex : 0;

    if (mode === "mechanical" || mode === "electronic-sine" || mode === "electronic-trap") {
      return (poles / 2) * theta + loadAngle;
    }
    if (mode === "sequencer") {
      return stepIndex * stepAngleElec;
    }
    // "none"
    return 0;
  }

  /**
   * sectorGate(phi, conductionAngle = 2π/3) → -1 | 0 | 1
   *
   * Normalise a = ((phi mod 2π) + 2π) mod 2π ∈ [0, 2π).
   *   +1  if a ∈ [0, conductionAngle)
   *   −1  if a ∈ [π, π + conductionAngle)
   *    0  otherwise
   */
  function sectorGate(phi, conductionAngle) {
    if (conductionAngle == null) conductionAngle = TWO_PI / 3;

    var a = ((phi % TWO_PI) + TWO_PI) % TWO_PI;

    if (a >= 0 && a < conductionAngle) return 1;
    if (a >= Math.PI && a < Math.PI + conductionAngle) return -1;
    return 0;
  }

  /**
   * supplyValue(terminal, t, phaseArg = null) → number | null
   *
   * terminal = { type, amp = 1, freq = 0, phaseOffset = 0, conductionAngle = 2π/3 }
   *
   * Effective phase ψ = (phaseArg != null ? phaseArg : 2π·freq·t) + phaseOffset
   *   "AC"             → amp · cos(ψ)
   *   "DC","PULSE","STEP" → amp  (raw bus level; gating applied by sectorGate in evalTerminal)
   *   "OPEN","SHORT"   → null
   */
  function supplyValue(terminal, t, phaseArg) {
    const type       = terminal.type;
    const amp        = terminal.amp        != null ? terminal.amp        : 1;
    const freq       = terminal.freq       != null ? terminal.freq       : 0;
    const phaseOffset = terminal.phaseOffset != null ? terminal.phaseOffset : 0;

    if (type === "OPEN" || type === "SHORT") return null;

    const base = (phaseArg != null ? phaseArg : TWO_PI * freq * t) + phaseOffset;

    if (type === "AC") return amp * Math.cos(base);

    // DC, PULSE, STEP, CURRENT — return raw amplitude; sectorGate applied by evalTerminal for PULSE/STEP and mechanical CURRENT
    return amp;
  }

  /**
   * evalTerminal({ terminal, commutation }, ctx) → TerminalCondition
   *
   * TerminalCondition is one of:
   *   { kind: "voltage", V: <number> }
   *   { kind: "open" }
   *   { kind: "short" }
   *
   * Dispatch order (per spec):
   *   1. OPEN / SHORT → immediate constraint
   *   2. mode === "none" → time-phase supply
   *   3. mode ∈ { electronic-sine, electronic-trap, sequencer } → rotor/step-keyed supply
   *   4. mode === "mechanical" → rotor-keyed gate × time-supply (chopper / universal motor)
   */
  // Pooled path (out provided): fill all three fields for object reuse. Fresh
  // path (out omitted): return the MINIMAL shape the public contract has always
  // exposed — { kind, V } for voltage, { kind, I } for current, { kind } for
  // open/short — with no zero-filled irrelevant field (deepStrictEqual consumers
  // depend on this).
  function setCond(out, kind, V, I) {
    if (out) { out.kind = kind; out.V = V; out.I = I; return out; }
    if (kind === "voltage") return { kind: kind, V: V };
    if (kind === "current") return { kind: kind, I: I };
    return { kind: kind };
  }

  // Writes the terminal condition into `out` (pooled) instead of allocating;
  // `out` omitted ⇒ a fresh minimal object (back-compat).
  function evalTerminal(circuit, ctx, out) {
    const terminal    = circuit.terminal;
    const commutation = circuit.commutation;

    const t = ctx.t != null ? ctx.t : 0;

    const type = terminal.type;
    const amp  = terminal.amp != null ? terminal.amp : 1;
    const conductionAngle = terminal.conductionAngle != null ? terminal.conductionAngle : TWO_PI / 3;
    const phaseOffset = terminal.phaseOffset != null ? terminal.phaseOffset : 0;
    const freq        = terminal.freq        != null ? terminal.freq        : 0;
    const mode        = commutation.mode;

    if (type === "OPEN") return setCond(out, "open", 0, 0);
    if (type === "SHORT") return setCond(out, "short", 0, 0);

    if (mode === "none") {
      if (type === "CURRENT") return setCond(out, "current", 0, supplyValue(terminal, t));
      if (type === "AC" || type === "DC") return setCond(out, "voltage", supplyValue(terminal, t), 0);
      if (type === "PULSE") {
        const g = sectorGate(TWO_PI * freq * t + phaseOffset, conductionAngle);
        return g === 0 ? setCond(out, "open", 0, 0) : setCond(out, "voltage", g * amp, 0);
      }
      if (type === "STEP") {
        const g = sectorGate(TWO_PI * freq * t + phaseOffset, conductionAngle);
        return (g === 1 || g === -1) ? setCond(out, "voltage", g * amp, 0) : setCond(out, "voltage", amp, 0);
      }
    }

    if (mode === "electronic-sine" || mode === "electronic-trap" || mode === "sequencer") {
      const base = commutationPhase(commutation, ctx);
      if (type === "CURRENT") return setCond(out, "current", 0, supplyValue(terminal, t));
      if (type === "AC") return setCond(out, "voltage", supplyValue(terminal, t, base), 0);
      if (type === "DC") return setCond(out, "voltage", supplyValue(terminal, t), 0);
      if (type === "PULSE") {
        const g = sectorGate(base + phaseOffset, conductionAngle);
        return g === 0 ? setCond(out, "open", 0, 0) : setCond(out, "voltage", g * amp, 0);
      }
      if (type === "STEP") {
        const g = sectorGate(base + phaseOffset, conductionAngle);
        return (g === 1 || g === -1) ? setCond(out, "voltage", g * amp, 0) : setCond(out, "voltage", amp, 0);
      }
    }

    // mechanical: commutation is modeled spatially in the slice (brush/commutator
    // sheet); the scalar gate must NOT be re-applied here, so supply ungated.
    if (mode === "mechanical") {
      const raw = supplyValue(terminal, t);
      return type === "CURRENT" ? setCond(out, "current", 0, raw) : setCond(out, "voltage", raw, 0);
    }
    return setCond(out, "open", 0, 0);
  }

  function evalDrive(circuits, ctx) {
    var result = new Array(circuits.length);
    for (var i = 0; i < circuits.length; i++) result[i] = evalTerminal(circuits[i], ctx);
    return result;
  }

  // Allocation-free: writes into caller-pooled condition objects out[i].
  function evalDriveInto(circuits, ctx, out) {
    for (var i = 0; i < circuits.length; i++) evalTerminal(circuits[i], ctx, out[i]);
    return out;
  }

  // Attach to LIB.Excitation
  var g = (typeof window !== "undefined" ? window : globalThis);
  g.LIB = g.LIB || {};
  g.LIB.Excitation = {
    commutationPhase: commutationPhase,
    supplyValue:      supplyValue,
    sectorGate:       sectorGate,
    evalTerminal:     evalTerminal,
    evalDrive:        evalDrive,
    evalDriveInto:    evalDriveInto,
  };

})();
