# Phase 3: Excitation + commutation

## Overview

The DOM-free, UI-agnostic **excitation / commutation layer**: pure functions
that map `(time t, rotor angle θ, step index)` to the **per-circuit terminal
condition** each winding circuit presents to the (Phase 4) circuit ODE. This is
the entire drive vocabulary — every external source and every commutation
scheme — expressed without one line of machine-identity code.

This phase has **no runtime dependency on Phase 1** (it touches no grid, no
solver, no field array) and may run immediately. Its first consumer is the
Phase 5 integration; the contract it freezes here is the boundary that Phase 4
(`motor-circuit.js`, `V = R·i + dλ/dt`) reads. Implementation ships in wave
3.1; tests ship in wave 3.2. Wave ordering guarantees `lib/excitation.js`
exists before the wave-3.2 test loader requires it.

### Vocabulary fixed for this phase (resolves a DESIGN-level conflation)

The DESIGN's "terminal state (per winding)" list mixed two axes. This phase
splits them into two orthogonal axes that compose freely:

- **Terminal state = supply waveform shape**, per circuit, one of
  `{AC, DC, PULSE, STEP, OPEN, SHORT}`. `AC1`/`AC3` are **removed**: `AC`
  carries `(amp, freq, phaseOffset)`, and **polyphase is emergent** — an
  m-phase machine is m circuits each `AC` at `phaseOffset = −2π·k/m`
  (k = 0…m−1). Unbalanced windings = unequal offsets/amps. Single-phasing
  fault = set one circuit `OPEN`.
- **Commutation = how the phase argument is derived**, one of
  `{none, mechanical, electronic-trap, electronic-sine, sequencer}`. It
  produces the phase that the supply waveform is evaluated at (and, for
  `mechanical`, a switching gate applied on top of the time-supply).

**Commutation is per-circuit, not per-machine.** Wound-field brushed DC has a
`mechanical` armature circuit and a `none` field circuit. `evalDrive` therefore
takes an array of per-circuit `{terminal, commutation}` pairs sharing one
`ctx`.

### Conventions fixed for this phase

- `lib/excitation.js` is a single `"use strict"` IIFE attaching
  `window.LIB.Excitation`. **Zero dependencies** — it does not read
  `LIB.Util`, `LIB.ThreePhase`, `LIB.StepperDrive`, or any DOM/canvas global at
  module-load or call time. (The N-phase formula is re-derived inline; it
  matches `LIB.ThreePhase`'s `cos(φ − 2πk/m)` convention by construction.)
- **Angles are electrical radians.** Electrical angle `θ_e = (poles/2)·θ_mech`.
  All `phaseOffset`, `loadAngle`, `stepAngleElec`, and `conductionAngle` values
  are electrical radians.
- **`TerminalCondition`** is a tagged union, one per circuit:
  - `{ kind: "voltage", V: <finite number> }` — a driven source.
  - `{ kind: "open" }` — branch disconnected (no current path).
  - `{ kind: "short" }` — terminals shorted (`V = 0` clamp; induction cage /
    single-phasing).
- **`sectorGate` convention.** `sectorGate(φ, conductionAngle)` returns `+1`,
  `0`, or `−1`. With `a = ((φ mod 2π) + 2π) mod 2π`:
  `+1` for `a ∈ [0, conductionAngle)`; `−1` for
  `a ∈ [π, π + conductionAngle)`; `0` otherwise. So `conductionAngle = 2π/3`
  gives the 6-step pattern (120° drive, 60° dead, 120° reverse, 60° dead) and
  `conductionAngle = π` gives a pure square (no dead zone).
- **Test runner**: `node:test` + `node:assert/strict`. Phase 3 ships its **own**
  three-line headless loader at `tests/excitation/_fixtures.js` and does **not**
  edit `tests/_shim.js` (Phase 1's file, which eagerly loads the Phase-1 solver
  modules that need not exist when Phase 3 runs). A float helper
  `assertClose(actual, expected, tol = 1e-9, msg)` lives in
  `tests/excitation/_fixtures.js`.

## Files Owned

- `lib/excitation.js` — created
- `tests/excitation/_fixtures.js` — created
- `tests/excitation/sources.test.js` — created
- `tests/excitation/commutation.test.js` — created

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 3.1: Implementation

### Task 3.1.1: excitation.js — terminal-state sources + commutation maps

- **Description**: The full drive vocabulary as pure functions. Three low-level
  closed-form helpers (`commutationPhase`, `supplyValue`, `sectorGate`) plus the
  two composition functions (`evalTerminal`, `evalDrive`) that map them to
  per-circuit `TerminalCondition`s. Dispatch keys only on terminal `type` and
  commutation `mode` (both allowed vocabulary axes — invariant #1). Absent
  physics contributes zero, never a skip (`OPEN`/`SHORT` are emitted as
  conditions, not branched around upstream).
- **Files to create**:
  - `lib/excitation.js` — IIFE attaching `LIB.Excitation`. API:
    - `LIB.Excitation.commutationPhase(spec, ctx) → number` — the commutation
      phase reference `θ_comm` (electrical radians).
      `spec = { mode, poles = 2, loadAngle = 0, stepAngleElec = 0 }`,
      `ctx = { t = 0, theta = 0, stepIndex = 0 }`. Returns:
      - `"mechanical" | "electronic-sine" | "electronic-trap"`:
        `(poles/2)·theta + loadAngle`
      - `"sequencer"`: `stepIndex·stepAngleElec`
      - `"none"`: `0` (the supply uses its own time phase; the value is unused).
    - `LIB.Excitation.supplyValue(terminal, t, phaseArg = null) → number | null`
      — the external supply value before commutation gating.
      `terminal = { type, amp = 1, freq = 0, phaseOffset = 0,
      conductionAngle = 2π/3 }`. With effective phase
      `ψ = (phaseArg != null ? phaseArg : 2π·freq·t) + phaseOffset`:
      - `"AC"`: `amp·cos(ψ)`
      - `"DC"`, `"PULSE"`, `"STEP"`: `amp` (the bus/hold level; waveform shape
        is applied by `sectorGate` in `evalTerminal`)
      - `"OPEN"`, `"SHORT"`: `null`
    - `LIB.Excitation.sectorGate(phi, conductionAngle = 2π/3) → -1 | 0 | 1` —
      the switching function defined in Conventions above.
    - `LIB.Excitation.evalTerminal({ terminal, commutation }, ctx)
      → TerminalCondition` — the per-circuit dispatch, in this exact order:
      1. `terminal.type === "OPEN"` → `{ kind: "open" }`;
         `=== "SHORT"` → `{ kind: "short" }`.
      2. `commutation.mode === "none"`:
         - `AC`/`DC` → `{ kind: "voltage", V: supplyValue(terminal, ctx.t) }`.
         - `PULSE`: `ψ = 2π·terminal.freq·ctx.t + terminal.phaseOffset`;
           `g = sectorGate(ψ, terminal.conductionAngle)`; `g === 0`
           → `{ kind: "open" }`, else `{ kind: "voltage", V: g·terminal.amp }`.
         - `STEP`: `ψ = 2π·terminal.freq·ctx.t + terminal.phaseOffset`;
           `g = sectorGate(ψ, terminal.conductionAngle)`; `g ∈ {+1, −1}`
           → `{ kind: "voltage", V: g·terminal.amp }`; `g === 0`
           → `{ kind: "voltage", V: terminal.amp }` (hold positive).
      3. `mode ∈ { "electronic-sine", "electronic-trap", "sequencer" }`:
         `base = commutationPhase(commutation, ctx)`:
         - `AC` → `{ kind: "voltage", V: supplyValue(terminal, ctx.t, base) }`
           (FOC sinusoid `amp·cos(base + phaseOffset)`).
         - `DC` → `{ kind: "voltage", V: supplyValue(terminal, ctx.t) }`.
           (DC is a constant bus voltage; the commutation phase `base` is
           irrelevant for DC — only `PULSE`, `STEP`, and `mechanical` shape DC
           into a switched waveform.)
         - `PULSE`: `g = sectorGate(base + terminal.phaseOffset,
           terminal.conductionAngle)`; `g === 0`
           → `{ kind: "open" }`, else `{ kind: "voltage", V: g·terminal.amp }`.
         - `STEP`: `g = sectorGate(base + terminal.phaseOffset,
           terminal.conductionAngle)`; `g ∈ {+1, −1}`
           → `{ kind: "voltage", V: g·terminal.amp }`; `g === 0`
           → `{ kind: "voltage", V: terminal.amp }` (hold positive).
      4. `mode === "mechanical"`: `base = commutationPhase(commutation, ctx)`;
         `g = sectorGate(base + terminal.phaseOffset,
         commutation.conductionAngle ?? π)`; `g === 0` → `{ kind: "open" }`;
         else `raw = supplyValue(terminal, ctx.t)` and
         `{ kind: "voltage", V: g·raw }` (chops `DC` → square; commutates `AC`).
    - `LIB.Excitation.evalDrive(circuits, ctx) → TerminalCondition[]` — maps
      `evalTerminal` over `circuits` (array of `{ terminal, commutation }`),
      preserving order. `circuits.length` is the phase count `m`.
- **Tests**: authored in Task 3.1.2 (`tests/excitation/sources.test.js`,
  `tests/excitation/commutation.test.js`).
- **Acceptance criteria**:
  - `LIB.Excitation` exposes `commutationPhase`, `supplyValue`, `sectorGate`,
    `evalTerminal`, `evalDrive`, all functions.
  - `lib/excitation.js` `require`s under Node with only `globalThis.window`
    defined and no other `LIB.*` module loaded (the `_fixtures.js` load
    succeeds).
  - `lib/excitation.js` dispatches only on `terminal.type` and
    `commutation.mode`; it contains no string literal encoding a machine
    identity, motor-model name, or topology label (e.g. BLDC, SRM, PMSM,
    induction, stepper, brushed).
  - All tests pass.

## Wave 3.2: Tests (Task 3.1.2 — plan numbering retained)

### Task 3.1.2: excitation tests + headless loader

- **Description**: The validation suite for the excitation layer and its
  dedicated headless loader. Every assertion is a closed-form check — no field
  solve, no Phase-1 module. Split into a sources file (supply waveforms +
  terminal conditions + polyphase emergence) and a commutation file (phase-map
  modes + the brushed/FOC/6-step/sequencer manifestations). STEP behavior
  across all five commutation modes follows the P3-D2 resolution (STEP never
  opens; holds positive at `g === 0`); STEP tests assert this hold-not-open
  semantics rather than requiring separate dead-sector tests per mode.
- **Files to create**:
  - `tests/excitation/_fixtures.js` — not a test file (no `.test.js`). On
    `require`: `if (!globalThis.window) globalThis.window = globalThis;` then
    `require(path.join(__dirname, "..", "..", "lib", "excitation.js"))`; exports
    `{ LIB: window.LIB, assertClose }` where
    `assertClose(actual, expected, tol = 1e-9, msg)` asserts
    `|actual − expected| ≤ tol`.
  - `tests/excitation/sources.test.js` — `const { LIB, assertClose } =
    require("./_fixtures.js");`:
    - › `"DC supply is constant in time"` — `supplyValue({type:"DC",amp:5}, t)`
      equals `5` for `t ∈ {0, 0.137, 10}`.
    - › `"AC supply equals amp·cos(2πf t + offset)"` — for
      `{type:"AC", amp:230, freq:50, phaseOffset:0.3}` at `t = 0.004`,
      `assertClose(supplyValue(...), 230·cos(2π·50·0.004 + 0.3))`.
    - › `"balanced 3-phase voltages sum to ~0"` — `evalDrive` of three `AC`
      circuits (`amp:1, freq:50`, offsets `0, −2π/3, −4π/3`) all `commutation:
      {mode:"none"}`, at `t ∈ {0, 0.003, 0.007}`: `assertClose(ΣV, 0, 1e-12)`.
    - › `"N-phase generalization (m=5) sums to ~0"` — same with five circuits at
      offsets `−2π·k/5`: `assertClose(ΣV, 0, 1e-12)`.
    - › `"single-phasing: one OPEN drops a phase"` — three-phase `none` set with
      circuit 1's terminal `type:"OPEN"`; `evalDrive[1]` is `{kind:"open"}` and
      the other two are `{kind:"voltage"}`.
    - › `"PULSE 6-step gate pattern"` — with `conductionAngle = 2π/3`:
      `sectorGate(π/6) === 1`, `sectorGate(2π/3 + 0.01) === 0`,
      `sectorGate(π + π/6) === -1`, `sectorGate(2π − 0.01) === 0`.
    - › `"PULSE dead sector is open, active sector is ±amp"` — `evalTerminal`
      with `terminal:{type:"PULSE",amp:48,conductionAngle:2π/3}`,
      `commutation:{mode:"electronic-trap",poles:2}`: at `theta = π/6` →
      `{kind:"voltage", V:48}`; at `theta = 3π/4` (θ_comm = 3π/4 ∈ [2π/3, π)) →
      `{kind:"open"}`.
    - › `"STEP holds ±amp with no dead zone"` — `evalTerminal`
      `terminal:{type:"STEP",amp:3,conductionAngle:π}`,
      `commutation:{mode:"sequencer",stepAngleElec:π/2}`: `stepIndex` 0 → `V:3`,
      `stepIndex` 2 → `V:−3`; never `{kind:"open"}`.
    - › `"STEP in mode:none at a dead-sector angle holds voltage, not open"` —
      `evalTerminal` `terminal:{type:"STEP",amp:10,freq:1,phaseOffset:0,
      conductionAngle:2π/3}`, `commutation:{mode:"none"}`, at `t = 5/12`
      (ψ = 5π/6 ∈ [2π/3, π), so `sectorGate(5π/6, 2π/3) === 0`): result is
      `{kind:"voltage", V:10}`, not `{kind:"open"}`.
    - › `"OPEN→open, SHORT→short regardless of mode"` — `evalTerminal` for
      `type:"OPEN"` and `type:"SHORT"` under each of the five modes returns the
      matching constraint kind.
  - `tests/excitation/commutation.test.js` — same import:
    - › `"commutationPhase closed forms"` — `assertClose` of each mode vs its
      formula: `electronic-sine` `{poles:4,loadAngle:0.2}` at `theta:1.0` →
      `2·1.0 + 0.2`; `sequencer` `{stepAngleElec:π/2}` at `stepIndex:3` →
      `3π/2`; `none` → `0`.
    - › `"none is rotor-independent, time-dependent"` — `AC`+`none` `evalTerminal`
      is identical for `theta ∈ {0, 1, 2}` at fixed `t`, and differs between
      `t = 0` and `t = 0.005`.
    - › `"electronic-sine slaves phase to rotor, not time"` — `AC`+
      `electronic-sine` `{poles:2}`: `V` equals `amp·cos((poles/2)·theta +
      loadAngle + phaseOffset)` (closed form via `assertClose`), and is
      identical for `t ∈ {0, 1}` at fixed `theta`.
    - › `"electronic-trap conducting set matches 6-step table"` — three-phase
      `PULSE`+`electronic-trap` `{poles:2}`, offsets `0,−2π/3,−4π/3`,
      `conductionAngle:2π/3`, at `theta = π/2`: gates are `[+1, 0, −1]` →
      conditions `[{V:+amp},{open},{V:−amp}]` (exactly two conduct, one open).
    - › `"mechanical chops DC into a square keyed to rotor"` — `DC`+`mechanical`
      `{poles:2}`, `conductionAngle:π`, `amp:12`: `V === +12` at `theta = 0.1`,
      `V === −12` at `theta = π + 0.1`, sign flips at `theta = π`.
    - › `"mechanical commutates AC (universal motor) — both phases present"` —
      `terminal:{type:"AC",amp:10,freq:1,phaseOffset:0}`,
      `commutation:{mode:"mechanical",poles:2,conductionAngle:π}`,
      `ctx:{t:0, theta:3π/2}`: `sectorGate(3π/2, π) = −1`, `cos(0) = 1`,
      so `assertClose(result.V, −10, 1e-9)` (the product confirms both arguments
      enter).
    - › `"sequencer advances energized phase by step index"` — two-phase
      bipolar `STEP`+`sequencer` (`offsets 0, −π/2`, `stepAngleElec:π/2`,
      `conductionAngle:π`): the `(sign V_a, sign V_b)` pattern for
      `stepIndex = 0,1,2,3` is `(+,+),(−,+),(−,−),(+,−)`.
- **Acceptance criteria**:
  - `npm test` runs both `tests/excitation/*.test.js` files and exits 0.
  - `tests/excitation/_fixtures.js` is not collected as a test (no `.test.js`
    suffix) and is `require`-able by both test files.
  - Every assertion above holds at the stated tolerances.
  - All tests pass.
