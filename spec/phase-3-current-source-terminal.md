# Phase 3: CURRENT-source terminal + per-iron `Bknee` passthrough

## Overview

Two **orthogonal vocabulary extensions** to the `config-schema` / circuit
surface, grouped here because they share `lessons/unified_motor/config-schema.js`
as their only common touchpoint and are independently small.

**Primary scope — `CURRENT` terminal.** Add a `CURRENT` (imposed-current)
terminal kind to the excitation/circuit vocabulary so a circuit can be driven by
a regulated current rather than a voltage. This is the one outstanding
non-field-engine item from `fea-engine-rebuild.md` §11.2: a true
wound-field-synchronous machine has a **current-regulated** field (exciter/AVR),
but today `excitation.js` offers only voltage / open / short, so the field can
only be a DC *voltage* source. At standstill that voltage-fed field is
continuously swept by the rotating stator field (slip = 1) and acts as an
induction damper, producing real line-start torque — which is why the WFS
self-start test is skipped. A `CURRENT` terminal pins the field current to its
regulated value, so no slip-induced current flows and the machine cannot
line-start.

**Secondary scope — per-iron `Bknee` passthrough.** Phase 5's local Brauer
B–H saturation model (`ν(B²) = k1 + k2·exp(k3·B²)`, §11.3) is anchored
**per-iron-material** to a `Bknee` knee field, which the Phase-2 mesh material
table now carries (`Phase 2 D1`). The carrier is `config-schema`: an optional
**`ring.Bknee` (Tesla)** that the schema's iron-feature builders emit onto every
iron feature (`buildIronFeatures` directly; `buildMagnetFeatures` for the
optional back-iron; `buildWoundFeatures` for the back-iron + the `C`-element
salient-tooth iron), and that `validate` accepts as an optional finite positive
number. Phase 2 then propagates `feature.Bknee` into the per-material entry of
its `materials[]` table; Phase 5 reads `material.Bknee` and falls back to
`opts.saturation.BkneeDefault` when null. The passthrough is pure vocabulary —
no engine dependency, no machine identity — and ships in Phase 3 because
`config-schema.js` already lives here and the change is byte-localized.

`CURRENT` is a pure **vocabulary extension** — the current-source dual of `DC`
(and, for the pin constraint, the dual of `OPEN`). It dispatches only on the
universal terminal/commutation vocabulary; it never reads machine identity. The
path spans four files plus the fixture flip:

1. **`excitation.js`** — `evalTerminal` returns `{kind:"current", I}` for a
   `CURRENT` terminal, composing with commutation exactly as `DC` does.
2. **`motor-circuit.js`** — `stepCurrents`/`advance` accept an `Iimp` vector;
   `CURRENT` circuits are pinned to their imposed current and removed from the
   solved (free) set, with their flux contribution moved to the RHS of the
   voltage-driven circuits.
3. **`motor-run.js`** — the per-tick condition→terminal-state mapping learns the
   `{kind:"current"}` condition and threads the imposed value through to
   `MotorCircuit.advance`.
4. **`config-schema.js`** — `"CURRENT"` is added to `validTerminalTypes` so a
   `CURRENT` circuit validates.
5. **`machines/wound-field-synchronous.js`** — the field circuit flips from a
   `DC` voltage source to a `CURRENT` regulated source.

### Dependency reality (why the self-start un-skip is Phase 7, not here)

Phase 0 deletes the grid `lib/motor-slice.js` and `lib/motor-compile.js`. From
the end of Phase 0 until Phase 5 recreates the slice FEA-native, the machine
pipeline (`MotorStack` → `MotorSlice.solve`) has **no field engine**, and the
shared loaders `tests/pipeline/_fixtures.js` and `tests/machines/_fixtures.js`
(which `require` the deleted modules) **throw at load**. Any test that drives a
field solve — including the wound-field-synchronous *dynamic self-start* test in
`tests/machines/` — cannot even be collected during Phases 1–4.

Phase 3 therefore proves the entire `CURRENT` mechanism with **engine-independent
tests** that load only the modules under test:

- excitation closed-form (loads only `excitation.js`);
- a self-contained `MotorCircuit` pinning + induction-damper-mechanism test
  (loads only `motor-circuit.js`, builds coefficient objects inline — it does
  **not** use the broken `tests/circuit/_fixtures.js`);
- a self-contained `config-schema` validation test (loads only
  `util.js` + `winding-model.js` + `config-schema.js`).

The single assertion that genuinely needs a field solve — "the WFS machine does
not self-start from rest" — un-skips and passes in **Phase 7** (the machine-test
re-point, the first phase after the FEA slice is rebuilt). Phase 3 owns the WFS
**fixture config**; Phase 7 owns the WFS **test file**.

## Files Owned

- `lib/excitation.js` — modified (add the `CURRENT` terminal to `evalTerminal`)
- `lib/motor-circuit.js` — modified (add `Iimp` imposed-current pinning to
  `stepCurrents` and `advance`)
- `lib/motor-run.js` — modified (route the `{kind:"current"}` condition to
  terminal-state `"CURRENT"` + imposed value, pass `Iimp` to `advance`)
- `lessons/unified_motor/config-schema.js` — modified (add `"CURRENT"` to
  `validTerminalTypes`; emit optional `ring.Bknee` onto iron features built by
  `buildIronFeatures` / `buildMagnetFeatures` (back-iron) /
  `buildWoundFeatures` (back-iron + `C` salient teeth); accept optional
  `ring.Bknee` in `validate`)
- `lessons/unified_motor/machines/wound-field-synchronous.js` — modified (field
  circuit `DC` voltage → `CURRENT` regulated current)
- `tests/excitation/sources.test.js` — modified (add `CURRENT` closed-form cases)
- `tests/pipeline/current-schema.test.js` — created (self-contained
  `config-schema` validation of a `CURRENT` circuit; grouped with
  `tests/pipeline/bknee-schema.test.js`, the other config-schema validator
  added by this phase)
- `tests/circuit/current-terminal.test.js` — created (self-contained
  `MotorCircuit` `CURRENT` pinning + induction-damper-mechanism proof)
- `tests/pipeline/bknee-schema.test.js` — created (self-contained
  `config-schema` validation + iron-feature emission of `ring.Bknee`)

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 3.1: CURRENT terminal + circuit/run/schema wiring

### Task 3.1.1: `CURRENT` terminal vocabulary, circuit enforcement, run routing, schema validation

- **Description**: Add the `CURRENT` imposed-current terminal across the four
  vocabulary layers and prove it with three engine-independent test files.

- **Files to modify**:
  - `lib/excitation.js` — `evalTerminal(circuit, ctx)`: handle `type === "CURRENT"`
    as the current-source **dual of `DC`** — wherever the `DC` path produces a
    constant value, `CURRENT` returns `{ kind: "current", I: <that value> }`
    instead of `{ kind: "voltage", V: <value> }`. Concretely:
    - **Step 2 (`mode === "none"`)**: add
      `if (type === "CURRENT") return { kind: "current", I: supplyValue(terminal, t) };`
      (`supplyValue` already returns `amp` for any non-`AC`/`OPEN`/`SHORT` type via
      its fallthrough, so a `CURRENT` terminal with `amp:12` yields `I = 12`).
    - **Step 3 (`electronic-sine` / `electronic-trap` / `sequencer`)**: add
      `if (type === "CURRENT") return { kind: "current", I: supplyValue(terminal, t) };`
      (constant imposed current; commutation phase is irrelevant, mirroring the
      `DC` branch).
    - **Step 4 (`mechanical`)**: after `g = sectorGate(base + phaseOffset, commConductionAngle)`
      and the existing `if (g === 0) return { kind: "open" };`, add, before the
      `{ kind: "voltage" }` return: `if (type === "CURRENT") return { kind: "current", I: g * supplyValue(terminal, t) };`
      (a gated current source: open in the dead sector, `±amp` in the conduction
      sectors).
    - Update the `supplyValue` fallthrough comment to read
      `// DC, PULSE, STEP, CURRENT — return raw amplitude; sectorGate applied by evalTerminal for PULSE/STEP and mechanical CURRENT`.
      No other change to `supplyValue`, `sectorGate`, `commutationPhase`, or
      `evalDrive`.
  - `lib/motor-circuit.js` — extend the imposed-current path:
    - `stepCurrents({ L, R, V, i, dt, terminalStates, e, Iimp })` — add the
      optional `Iimp` parameter (a `Float64Array(m)`; required only when any
      `terminalStates` entry is `"CURRENT"`). Partition circuits into:
      **CURRENT** (`terminalStates[k] === "CURRENT"`), **OPEN**
      (`=== "OPEN"`), and **free `F`** (everything else). Behaviour:
      - `iNext[k] = Iimp[k]` for every CURRENT circuit (set directly — exact).
      - `iNext[k] = 0` for every OPEN circuit (unchanged).
      - The reduced system is assembled **over `F` only**:
        `Ar[a*mf + b] = L[ka*m + kb] + (a === b ? dt*R[ka] : 0)` for `ka,kb ∈ F`;
        `rhs[a] = dt*(Veff[ka] - e[ka]) + Σ_{kb ∈ F} L[ka*m + kb]*i[kb]
                  + Σ_{kc ∈ CURRENT} L[ka*m + kc]*(i[kc] - Iimp[kc])`,
        where `Veff[ka] = (terminalStates[ka] === "SHORT") ? 0 : V[ka]`. (The
        CURRENT term is the known `L·iNext` contribution moved from the LHS to the
        RHS.) Solve `Ar` with the existing `solveDense`; write the solution into
        `iNext` for the `F` indices.
      - If `F` is empty (every circuit OPEN or CURRENT), skip the solve; `iNext`
        is already populated from the CURRENT/OPEN assignments above.
      - `vOpen` for OPEN circuits uses the **existing** formula
        `vOpen[k] = e[k] + Σ_l L[k*m + l]*(iNext[l] - i[l]) / dt` — now correct
        because `iNext` includes the pinned CURRENT values. CURRENT circuits leave
        `vOpen[k] = 0` (no source voltage exposed).
    - `advance(coeffs, { R, V, i, omega, dt, terminalStates, Iimp })` — thread
      `Iimp` through to `stepCurrents` (default `undefined` when absent, preserving
      existing callers). `backEmf` is unchanged.
    **Invariant (documented, not guarded):** `stepCurrents` does **not**
    defensively check for `Iimp === undefined` when a `terminalStates`
    entry is `"CURRENT"`. The only producer of `"CURRENT"` terminal
    states is `motor-run.js`, which always allocates
    `Iimp = new Float64Array(m)` before invoking `advance`. Callers that
    pass no CURRENT states may omit `Iimp`; callers that pass CURRENT
    states without an `Iimp` array trip a TypeError on first access —
    this is the correct fail-fast signal under CLAUDE.md's "no defensive
    fallbacks" rule.
  - `lib/motor-run.js` — in `step()`, alongside `V`/`R`, build
    `var Iimp = new Float64Array(m);`. In the condition loop, add a branch for
    `cond.kind === "current"`: `terminalStates[k] = "CURRENT"; Iimp[k] = cond.I;
    V[k] = 0;` (the existing `open` / `short` / voltage→`"DC"` branches are
    unchanged). Pass `Iimp: Iimp` into the `LIB.MotorCircuit.advance(coeffs, {...})`
    call.
  - `lessons/unified_motor/config-schema.js` — change `validTerminalTypes`
    (currently `["AC", "DC", "PULSE", "STEP", "OPEN", "SHORT"]`) to include
    `"CURRENT"`: `["AC", "DC", "PULSE", "STEP", "OPEN", "SHORT", "CURRENT"]`. No
    other change.

- **Files to create**:
  - `tests/pipeline/current-schema.test.js` — self-contained `node --test`
    file. Setup: `if (!globalThis.window) globalThis.window = globalThis;` then
    `require("../../lib/util.js")`, `require("../../lib/winding-model.js")`,
    `require("../../lessons/unified_motor/config-schema.js")` in that order
    (the same pattern used by the sibling `tests/pipeline/bknee-schema.test.js`);
    `const ConfigSchema = window.UnifiedMotor.ConfigSchema;`. Uses a
    minimal config that is otherwise valid (mirrors the pipeline `woundConfig`
    shape) with the single circuit's terminal type set to `"CURRENT"`:
    ```
    {
      grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
      poles: 2,
      rings: [
        { member: "stator", element: "W", rRange: [0.052, 0.06],
          winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
          muR: 1000 },
        { member: "rotor", element: "I", rRange: [0.04, 0.048], teeth: 2,
          muR: 1000 },
      ],
      circuits: [ { terminal: { type: "CURRENT", amp: 5 },
                    commutation: { mode: "none" }, R: 1.0 } ],
      stack: { slices: 1 },
      mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
    }
    ```

- **Tests**:
  - `tests/excitation/sources.test.js` (added cases, `node:test` flat `test(...)`
    style matching the file):
    - `"CURRENT in mode none imposes a constant current"` — for the terminal
      `{ type: "CURRENT", amp: 12 }`, `commutation { mode: "none" }`, assert
      `evalTerminal(...)` `deepStrictEqual` `{ kind: "current", I: 12 }` at
      `t ∈ {0, 0.137, 10}`.
    - `"CURRENT under electronic-sine is commutation-phase-independent"` —
      `commutation { mode: "electronic-sine", poles: 4 }`; for
      `theta ∈ {0, 0.5, 2.1}` assert the result `deepStrictEqual`
      `{ kind: "current", I: 12 }`.
    - `"CURRENT under sequencer imposes a constant current"` —
      `commutation { mode: "sequencer", stepAngleElec: Math.PI/2 }`; for
      `ctx ∈ [{ t: 0, theta: 0, stepIndex: 0 }, { t: 0, theta: 0, stepIndex: 2 }]`
      assert `evalTerminal(circuit, ctx) deepStrictEqual { kind: "current", I: 12 }`.
    - `"CURRENT under mechanical gates like DC"` —
      `commutation { mode: "mechanical", poles: 2, conductionAngle: 2*Math.PI/3 }`,
      `terminal { type: "CURRENT", amp: 12 }`: assert `theta = Math.PI/6` →
      `{ kind: "current", I: 12 }`; `theta = 5*Math.PI/6` → `{ kind: "open" }`;
      `theta = 7*Math.PI/6` → `{ kind: "current", I: -12 }`.
    - `"evalDrive maps a mixed CURRENT + AC circuit set"` — circuits
      `[ {CURRENT amp12, none}, {AC amp1 f50 off0, none}, {AC … off −2π/3, none},
      {AC … off −4π/3, none} ]`; assert the four condition `kind`s are
      `["current","voltage","voltage","voltage"]` and `conds[0].I === 12`.
    - `"OPEN/SHORT still override CURRENT-capable commutation modes"` — extend
      the existing OPEN/SHORT-regardless-of-mode coverage is unchanged; no new
      assertion required here beyond the existing test (documented for clarity).
  - `tests/pipeline/current-schema.test.js`:
    - `"a CURRENT circuit validates"` — `ConfigSchema.validate(cfg)` (the config
      above) returns `{ ok: true, errors: [] }` (`assert.equal(result.ok, true)`
      and `assert.deepEqual(result.errors, [])`).
    - `"an unknown terminal type is still rejected"` — the same config with the
      circuit terminal type set to `"BOGUS"` returns `result.ok === false` and at
      least one error string includes `"terminal.type"`.
  - `tests/circuit/current-terminal.test.js` — self-contained; setup
    `if (!globalThis.window) globalThis.window = globalThis;` then
    `require("../../lib/motor-circuit.js")`; `const MC = window.LIB.MotorCircuit;`.
    Define an inline `mutual2({L0,L1,M})` helper returning
    `{ L: new Float64Array([L0,M,M,L1]), dLdth: Float64Array(4), lambdaPm: Float64Array(2),
       dLambdaPmdth: Float64Array(2) }`. Cases (`node:test`):
    - `"CURRENT pins the circuit current exactly"` — `coeffs = mutual2({L0:1e-3,
      L1:1e-3, M:0.8e-3})`, `terminalStates = ["CURRENT","DC"]`, `Iimp = [7,0]`,
      `V = [0,5]`, `R = [1,1]`, `dt = 1e-3`, `omega = 0`, start `i = [0,0]`. Step
      50× via `MC.advance`. Assert `i[0] === 7` (strict) at every step, and
      `Math.abs(i[1] - 5) < 0.1` after the last step.
    - `"a CURRENT-pinned field develops no induced current where a voltage field
      would"` — identical coeffs/`R`/`dt`/`omega`.
      - Sub-case A (voltage field): `terminalStates = ["DC","DC"]`, `V = [0,5]`,
        `i = [0,0]`; over the first 30 steps track `maxAbsI0 = max(|i[0]|)`; assert
        `maxAbsI0 > 1e-3` (the mutual coupling drives transient current in the
        grounded field as `i[1]` ramps).
      - Sub-case B (current field): `terminalStates = ["CURRENT","DC"]`,
        `Iimp = [2,0]`, `V = [0,5]`, `i = [0,0]`; step 50×; assert `i[0] === 2`
        (strict) at **every** step and `Math.abs(i[1] - 5) < 0.1` at the end
        (pinning the field current does not corrupt the stator solve).
    - `"all-CURRENT circuits are pinned with no solve"` — `terminalStates =
      ["CURRENT","CURRENT"]`, `Iimp = [3,4]`, any `V`; assert one `MC.advance`
      returns `i[0] === 3`, `i[1] === 4` and does not throw.
    - `"OPEN coexists with CURRENT and still exposes induced voltage"` — m=3 with
      a 3×3 mutual `L` (diagonal `1e-3`, off-diagonals `0.5e-3`),
      `terminalStates = ["CURRENT","DC","OPEN"]`, `Iimp = [5,0,0]`, `V = [0,5,0]`,
      `R = [1,1,1]`; first step: assert `i[0] === 5`, `i[2] === 0`, and
      `Math.abs(vOpen[2]) > 1e-4` (the open branch sees the changing driven +
      pinned currents).

- **Acceptance criteria**:
  - `node --test tests/excitation/sources.test.js tests/pipeline/current-schema.test.js tests/circuit/current-terminal.test.js`
    passes with every case above green.
  - `evalTerminal` returns `{ kind: "current", I }` for a `CURRENT` terminal in
    `none` / `electronic-*` / `sequencer` modes, and gates it open/`±amp` in
    `mechanical` mode; it never returns `kind:"current"` for any other terminal
    type, and `OPEN`/`SHORT` still short-circuit to `open`/`short` first.
  - `MotorCircuit.stepCurrents`/`advance` pin every `"CURRENT"` circuit's next
    current to its `Iimp` value exactly (strict equality), solve the remaining
    voltage-driven circuits with the CURRENT contribution moved to the RHS, and
    leave existing callers (no `"CURRENT"` state, no `Iimp`) behaving identically.
  - `config-schema.validate` accepts a `CURRENT` circuit and still rejects an
    unknown terminal type.
  - `motor-run.js` maps `{kind:"current"}` → terminal-state `"CURRENT"` + imposed
    value and passes `Iimp` to `MotorCircuit.advance` (its end-to-end effect is
    verified by Phase 7's self-start test, which is the first run with a field
    engine present).
  - No file changed in this task contains a machine name, a machine-type enum, or
    a machine-identity branch; all new dispatch is on the terminal/commutation
    vocabulary. No DOM/canvas access is added at module load.
  - All tests pass.

---

### Task 3.1.2: Wound-field-synchronous fixture — regulated `CURRENT` field

- **Description**: Flip the wound-field-synchronous fixture's field circuit from
  a `DC` voltage source to a `CURRENT` regulated source so the machine models a
  true current-regulated synchronous field. The three stator phases stay `AC`
  voltage sources unchanged.

- **Files to modify**:
  - `lessons/unified_motor/machines/wound-field-synchronous.js` — in the
    `circuits` array, change circuit 0 from
    `{ terminal: { type: "DC", amp: 12 }, commutation: { mode: "none" }, R: 2.0 }`
    to `{ terminal: { type: "CURRENT", amp: 12 }, commutation: { mode: "none" }, R: 2.0 }`.
    Leave `amp: 12`, `commutation: { mode: "none" }`, and `R: 2.0` as-is; leave
    circuits 1–3 (the `AC` stator phases) and every other field of `config`
    unchanged.

- **Tests**:
  - No test file is created or modified in this task. The fixture's
    static-solve tests (`"develops synchronous torque…"`, `"Maxwell vs co-energy…"`)
    call `stack.solve(θ, currents)` with explicit current vectors and are
    independent of the terminal type; the `"config validates"` test depends on
    `config-schema` accepting `CURRENT` (Task 3.1.1). All
    `tests/machines/wound-field-synchronous.test.js` cases run only once the FEA
    slice exists (Phase 5+), and the **self-start un-skip+pass** is performed in
    Phase 7 (which owns that test file). This fixture-only edit has no
    Phase-3-runnable test of its own.

- **Acceptance criteria**:
  - `lessons/unified_motor/machines/wound-field-synchronous.js` circuit 0 has
    `terminal.type === "CURRENT"` with `amp: 12`; circuits 1–3 and all other
    config fields are byte-identical to before the edit.
  - The fixture's config object remains a single registration on
    `window.UnifiedMotor.MACHINES` with `id: "wound-field-synchronous"` (no
    structural change beyond the terminal type).
  - Loading the fixture is verified by running, from the repo root:
    `node -e "globalThis.window = globalThis; require('./lessons/unified_motor/machines/wound-field-synchronous.js'); const m = (window.UnifiedMotor.MACHINES || []).find(function (x) { return x.id === 'wound-field-synchronous'; }); if (!m) { process.exit(1); } if (m.config.circuits[0].terminal.type !== 'CURRENT' || m.config.circuits[0].terminal.amp !== 12) { process.exit(2); }"`
    → exits 0. This confirms (a) the IIFE loads without throwing under the
    Node `window` shim, (b) the machine is still registered on
    `window.UnifiedMotor.MACHINES`, (c) circuit 0's terminal is the
    CURRENT-12 form. Documented in the task for the implementer to copy-run
    as their verification.

---

### Task 3.1.3: Per-iron `Bknee` passthrough in `config-schema.js`

- **Description**: Extend `config-schema` to accept an optional **`ring.Bknee`**
  (Tesla) and emit it onto every iron feature the schema produces, so Phase 2's
  mesher can carry it through into `materials[].Bknee` and Phase 5's Brauer
  saturation fit can anchor per-iron-material. Pure vocabulary extension — no
  engine dependency, no machine identity. Verified by a self-contained
  `node --test` file that loads only `util.js` + `winding-model.js` +
  `config-schema.js` (mirroring the dependency-reality pattern of T3.1.1's
  `current-schema.test.js`, since the field engine does not exist until Phase 5).

- **Files to modify**:
  - `lessons/unified_motor/config-schema.js` — three byte-localized changes:
    1. **`validate`** — under the `rings[ri]` validation block, **add**: if
       `ring.Bknee !== undefined`, assert it is a finite number with `> 0`;
       otherwise push the error `rings[${ri}].Bknee must be a finite positive
       number when present; got ${ring.Bknee}`. Place this check immediately
       after the existing `ring.rRange` validation, before the wound-routing
       block. No other branch of `validate` is touched.
    2. **`buildIronFeatures(ring)`** — within the per-tooth loop, when
       constructing each feature object, add the field
       `Bknee: ring.Bknee != null ? ring.Bknee : null` alongside the existing
       `kind`/`member`/`rRange`/`thetaRange`/`muR` fields. Both iron features
       per `I` ring (each tooth) carry the same `Bknee`. No other change to
       `buildIronFeatures`.
    3. **`buildMagnetFeatures(ring)` and `buildWoundFeatures(ring,
       circuitBase, includeTeeth)`** — every place an `{ kind: "iron", ... }`
       feature object is pushed (the back-iron feature in `buildMagnetFeatures`
       under `ring.backIron`; the back-iron feature in `buildWoundFeatures`;
       the per-slot salient-tooth iron features in `buildWoundFeatures` when
       `includeTeeth === true`), add the same `Bknee: ring.Bknee != null ?
       ring.Bknee : null` field. Non-iron features (`kind:"magnet"`,
       `kind:"conductor"`) are unchanged; they never carry `Bknee`.
  No change to `expand`, `buildSliceFeatures`, `resolveWinding`, `deriveGapBand`,
  or `isPureAirRow`.

- **Files to create**:
  - `tests/pipeline/bknee-schema.test.js` — self-contained `node --test` file.
    Setup: `if (!globalThis.window) globalThis.window = globalThis;`, then
    `require` (relative to `lib/`) `util.js`, `winding-model.js`,
    `lessons/unified_motor/config-schema.js` in that order;
    `const CS = window.UnifiedMotor.ConfigSchema;`. Uses minimal `I`-rotor +
    `W`-stator configs that mirror the T3.1.1 `current-schema.test.js` shape.

- **Tests**:
  - `tests/pipeline/bknee-schema.test.js`:
    - `"absent Bknee → iron features carry Bknee: null"` — build a `pmConfig`-shape
      config with **no** `ring.Bknee` on any ring; `expanded = CS.expand(cfg)`;
      assert every feature in `expanded.slices[0].section.features` with
      `kind === "iron"` has `Bknee === null` (strict).
    - `"ring.Bknee on an I rotor reaches every iron feature"` — `I`-rotor ring
      with `Bknee: 1.4`, plus a `W`-stator ring; assert every
      `kind === "iron"` feature originating from the I ring carries
      `Bknee === 1.4` (strict); the back-iron feature from the W ring carries
      `Bknee === null` (the W ring has no `Bknee` set).
    - `"ring.Bknee on a W stator reaches both back-iron and (for C) salient
      teeth"` — `C`-stator ring with `Bknee: 1.7`; assert the back-iron
      feature **and** every salient-tooth iron feature carry
      `Bknee === 1.7`.
    - `"ring.Bknee on an M ring reaches its back-iron feature only"` — `M`-rotor
      with `backIron: true`, `backIronRRange: [...]`, and `Bknee: 1.5`; assert
      the back-iron `kind === "iron"` feature carries `Bknee === 1.5`; magnet
      `kind === "magnet"` features have no `Bknee` field defined on them
      (`feature.Bknee === undefined`, since magnets are linear by §11.3).
    - `"validate accepts a finite positive Bknee"` — config with one ring
      carrying `Bknee: 1.6`; assert `CS.validate(cfg).ok === true` and
      `errors.length === 0`.
    - `"validate rejects non-finite or non-positive Bknee"` — for
      `Bknee ∈ { 0, -1.5, NaN, Infinity, "1.6" }`, assert
      `CS.validate(cfg).ok === false` and at least one error string includes
      `"Bknee"`.
    - `"validate accepts a config with no Bknee anywhere"` — the exact
      `pmConfig` payload from T3.1.1's expand-still-works shape (no `Bknee` on
      any ring); assert `result.ok === true`.

- **Acceptance criteria**:
  - `config-schema.validate` accepts a config with optional `ring.Bknee` (finite
    positive number) on any ring, and rejects non-finite / non-positive values
    with a clear `"Bknee"` error string.
  - `config-schema.expand` emits `Bknee` onto every iron feature produced by
    `buildIronFeatures`, `buildMagnetFeatures` (back-iron), and
    `buildWoundFeatures` (back-iron + `C` salient teeth); the value is
    `ring.Bknee` when present and `null` otherwise.
  - Non-iron features (magnets, conductors) are unchanged; they do not gain a
    `Bknee` field.
  - No machine name, machine-type enum, or machine-identity branch is introduced.
  - All listed tests pass.
