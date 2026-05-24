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

    // DC, PULSE, STEP — return raw amplitude; shape is applied by sectorGate
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
  function evalTerminal(circuit, ctx) {
    const terminal    = circuit.terminal;
    const commutation = circuit.commutation;

    const t         = ctx.t         != null ? ctx.t         : 0;
    const theta     = ctx.theta     != null ? ctx.theta     : 0;
    const stepIndex = ctx.stepIndex != null ? ctx.stepIndex : 0;

    const type = terminal.type;
    const amp  = terminal.amp != null ? terminal.amp : 1;
    const conductionAngle = terminal.conductionAngle != null
      ? terminal.conductionAngle
      : TWO_PI / 3;
    const phaseOffset = terminal.phaseOffset != null ? terminal.phaseOffset : 0;
    const freq        = terminal.freq        != null ? terminal.freq        : 0;
    const mode        = commutation.mode;

    // Step 1: OPEN / SHORT bypass everything
    if (type === "OPEN") return { kind: "open" };
    if (type === "SHORT") return { kind: "short" };

    // Step 2: mode === "none"
    if (mode === "none") {
      if (type === "AC" || type === "DC") {
        return { kind: "voltage", V: supplyValue(terminal, t) };
      }
      if (type === "PULSE") {
        const psi = TWO_PI * freq * t + phaseOffset;
        const g   = sectorGate(psi, conductionAngle);
        if (g === 0) return { kind: "open" };
        return { kind: "voltage", V: g * amp };
      }
      if (type === "STEP") {
        const psi = TWO_PI * freq * t + phaseOffset;
        const g   = sectorGate(psi, conductionAngle);
        if (g === 1 || g === -1) return { kind: "voltage", V: g * amp };
        // g === 0: hold positive
        return { kind: "voltage", V: amp };
      }
    }

    // Step 3: electronic-sine, electronic-trap, sequencer
    if (mode === "electronic-sine" || mode === "electronic-trap" || mode === "sequencer") {
      const base = commutationPhase(commutation, ctx);

      if (type === "AC") {
        // FOC: amp·cos(base + phaseOffset); phaseArg = base so that
        // supplyValue computes amp·cos(base + phaseOffset)
        return { kind: "voltage", V: supplyValue(terminal, t, base) };
      }
      if (type === "DC") {
        // DC is a constant bus; commutation phase is irrelevant
        return { kind: "voltage", V: supplyValue(terminal, t) };
      }
      if (type === "PULSE") {
        const g = sectorGate(base + phaseOffset, conductionAngle);
        if (g === 0) return { kind: "open" };
        return { kind: "voltage", V: g * amp };
      }
      if (type === "STEP") {
        const g = sectorGate(base + phaseOffset, conductionAngle);
        if (g === 1 || g === -1) return { kind: "voltage", V: g * amp };
        // g === 0: hold positive
        return { kind: "voltage", V: amp };
      }
    }

    // Step 4: mechanical
    if (mode === "mechanical") {
      const base = commutationPhase(commutation, ctx);
      const commConductionAngle = commutation.conductionAngle != null
        ? commutation.conductionAngle
        : Math.PI;
      const g = sectorGate(base + phaseOffset, commConductionAngle);
      if (g === 0) return { kind: "open" };
      const raw = supplyValue(terminal, t);
      return { kind: "voltage", V: g * raw };
    }

    // Should never be reached if mode is valid, but return open as safe fallback
    return { kind: "open" };
  }

  /**
   * evalDrive(circuits, ctx) → TerminalCondition[]
   *
   * Maps evalTerminal over circuits (array of { terminal, commutation }),
   * preserving order.
   */
  function evalDrive(circuits, ctx) {
    var result = new Array(circuits.length);
    for (var i = 0; i < circuits.length; i++) {
      result[i] = evalTerminal(circuits[i], ctx);
    }
    return result;
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
  };

})();
