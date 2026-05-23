# Phase 4: Circuit ODE

## Overview

The circuit layer that couples the air-gap field to terminal electrics:
`V = R·i + dλ/dt` per circuit, stepped semi-implicitly so the electrical
dynamics are unconditionally stable at interactive `dt`. This phase ships one
DOM-free `window.LIB` module, `lib/motor-circuit.js` (`LIB.MotorCircuit`), plus
its Node test suite.

`motor-circuit.js` provides four composable primitives — `extract` (build the
inductance matrix + PM flux linkage and their θ-derivatives from field solves),
`makeCache` (θ-binned memo of those coefficients, refreshed when the rotor
crosses a bin), `backEmf` (the motional/saliency EMF), and `stepCurrents` (the
implicit `mₐ×mₐ` current solve with terminal-state handling) — and one pure
convenience, `advance`, that composes `backEmf` + `stepCurrents` from
already-fetched coefficients. **Orchestration is left to Phase 5**
(`motor-slice.js` ties grid + compile + circuit + excitation together); this
phase exposes primitives, not a runtime loop.

### Phase boundaries (load-bearing)

- **Depends only on Phase 1.** `extract` consumes a Phase-1 `GridOperator`
  (`op`) and a solve function (`LIB.AirgapSolve.pcg`). Everything else
  (`makeCache`, `backEmf`, `stepCurrents`, `advance`) touches no grid and no
  `op` — it is pure linear algebra over plain arrays.
- **No Phase 2 / Phase 3 import.** `motor-circuit.js` never requires
  `winding-model.js`, `motor-compile.js`, or `excitation.js`. The compiled
  arrays it needs (per-circuit unit-current `J_z` basis maps, per-circuit coil
  masks, the magnetization source) arrive as **plain-data inputs** to `extract`.
  Terminal voltages `V` and terminal-state tokens arrive as plain-data inputs to
  `stepCurrents`. This is what keeps Phase 4 parallelisable with Phases 2 and 3.
- **Machine-agnosticism.** `stepCurrents` dispatches only on the terminal-state
  vocabulary token (`OPEN` → branch removed; `SHORT` → effective `V = 0`;
  all driven states → use the supplied `V`). It never reads a machine name or a
  machine-type field. Absent physics contributes zero, not a skip: a config with
  no magnet yields `λ_pm = 0` and `dλ_pm/dθ = 0` from `extract`, computed (not
  branched around).

### Conventions fixed for this phase

- **Inductance matrix `L`** is a flat row-major `Float64Array` of length `m·m`,
  indexed `L[k*m + l]` = flux linkage in circuit `k` per unit current in circuit
  `l`. In the linear tier `L` is symmetric (`L[k*m+l] === L[l*m+k]` to solver
  tolerance). `m` = circuit count.
- **`dLdth`** is the same `m·m` flat layout: `dLdth[k*m+l] = ∂L[k*m+l]/∂θ`.
  **`lambdaPm`** and **`dLambdaPmdth`** are length-`m` `Float64Array`s
  (`λ_pm,k` and `∂λ_pm,k/∂θ`).
- **A "coeffs" object** is `{ L, dLdth, lambdaPm, dLambdaPmdth }` — the output of
  `extract` and the unit `makeCache` stores per bin and `advance`/`backEmf`
  consume.
- **Resistance `R`** is a length-`m` `Float64Array` (per-circuit, diagonal).
  **Terminal voltage `V`** is a length-`m` `Float64Array`. **`terminalStates`**
  is a length-`m` array of vocabulary tokens
  (`"AC" | "DC" | "PULSE" | "STEP" | "OPEN" | "SHORT"`).
- **Semi-implicit step.** Implicit in current, explicit in rotor angle and
  back-EMF coefficient:
  `(L + R·dt)·iⁿ⁺¹ = L·iⁿ + (V − e)·dt`, with `e = ω·(dL/dθ·iⁿ + dλ_pm/dθ)`.
  `(L + R·dt)` is `L/dt`-dominated and SPD ⇒ unconditionally stable.
- **Small dense solve.** `m` is small (≤ ~8). The reduced active system is solved
  by an internal partial-pivot Gaussian-elimination helper `solveDense(A, b, n)`
  (not exported). No external linear-algebra dependency.
- **`μ₀`** is not needed in this module (no torque computation here).
- **Test harness.** Tests reuse `tests/engine/_fixtures.js` (`assertClose`,
  `buildSalient`, `fitCos2`, `SALIENT_DEFAULTS`) **read-only** — Phase 4 does not
  modify any Phase-1 file. `tests/circuit/_fixtures.js` follows the own-loader
  pattern (matching Phases 2 and 3): it sets `if (!globalThis.window)
  globalThis.window = globalThis;`, then `require`s the Phase-1 lib modules it
  needs individually (`util.js`, `integrate.js`, `airgap-grid.js`,
  `airgap-solve.js`), then `require`s `lib/motor-circuit.js` so its IIFE attaches
  `LIB.MotorCircuit` to the same global. It does NOT `require("../_shim.js")`.
  Float comparisons use `assertClose`.

## Files Owned

- `lib/motor-circuit.js` — created
- `tests/circuit/_fixtures.js` — created
- `tests/circuit/stepper.test.js` — created
- `tests/circuit/induction.test.js` — created
- `tests/circuit/backemf.test.js` — created
- `tests/circuit/extract.test.js` — created
- `tests/circuit/cache.test.js` — created

> `tests/_shim.js` is **not** owned or modified by this phase and is not used
> by Phase 4's test fixtures. `lib/motor-circuit.js` is loaded by a direct
> `require` in `tests/circuit/_fixtures.js` (own-loader pattern), so no central
> `LIB_FILES` edit is needed and this phase stays free of write-conflicts with
> the other post-Phase-1 phases.

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 4.1: Circuit solver

### Task 4.1.1: motor-circuit.js — implicit current step, L(θ) cache, terminal states
- **Description**: The circuit-ODE module. An IIFE attaching `LIB.MotorCircuit`
  with the API below. Implements the semi-implicit current step
  `(L + R·dt)·iⁿ⁺¹ = L·iⁿ + (V − e)·dt`, the field-driven inductance/PM
  extraction with central-difference θ-derivatives, the θ-binned coefficient
  cache, the motional back-EMF, and terminal-state dispatch (`OPEN` removes the
  branch and exposes its open-circuit voltage; `SHORT` forces effective
  `V = 0`). No DOM/canvas access at module load; no Phase 2 / Phase 3 import.
- **Files to create**:
  - `lib/motor-circuit.js` — IIFE attaching `LIB.MotorCircuit`. API:
    - `LIB.MotorCircuit.extract(op, solveFn, sources, thetaR, opts={}) →
      { L, dLdth, lambdaPm, dLambdaPmdth }`
      - `op` — a Phase-1 `GridOperator` with materials, rotor region, and gap
        band already set.
      - `solveFn` — `(op, b, { x0 }) → { x, iters, residual }`, normally
        `LIB.AirgapSolve.pcg`. Injected so tests/Phase-5 control warm-start and
        tolerance.
      - `sources` — `{ jzBasis, coilMasks, magnetization }`:
        - `jzBasis` — array of `m` `Float64Array`s (length `Nr·Ntheta`): the
          `J_z` map produced by circuit `k` at **unit current**.
        - `coilMasks` — the `m`-entry signed-mask array `op.fluxLinkage`
          consumes.
        - `magnetization` — `{ Mr, Mθ }` or `null` (null ⇒ `λ_pm = 0`,
          zero-not-skip).
      - `opts` — `{ derivStep = op.dtheta, x0 = null }`.
      - Algorithm: define `evalAt(theta)` that (1) `op.setRotorAngle(theta)`;
        (2) magnet-only solve `Az_pm = solveFn(op, op.assembleRHS({
        magnetization }), { x0 }).x` then `lambdaPm[l] = op.fluxLinkage(Az_pm,
        coilMasks)[l]` (zeros if `magnetization` is null, no solve); (3) for each
        circuit `j`, current-only solve `Az_j = solveFn(op, op.assembleRHS({ Jz:
        jzBasis[j] }), { x0 }).x` and `col = op.fluxLinkage(Az_j, coilMasks)`,
        writing `L[i*m + j] = col[i]` for all `i`; returns `{ L, lambdaPm }`.
        Call `evalAt(thetaR)`, `evalAt(thetaR + derivStep)`,
        `evalAt(thetaR − derivStep)`; form `dLdth = (Lplus − Lminus)/(2·derivStep)`
        and `dLambdaPmdth = (pmPlus − pmMinus)/(2·derivStep)`. Restore
        `op.setRotorAngle(thetaR)` before returning. Returns the **center**
        evaluation's `L`/`lambdaPm` and the two derivative arrays.
    - `LIB.MotorCircuit.makeCache({ period = 2*Math.PI, binCount = 360 }) →
      cache` with:
      - `cache.binWidth` — `period / binCount`.
      - `cache.binIndex(theta) → int` — `floor((((theta % period) + period) %
        period) / binWidth)`.
      - `cache.coeffs(theta, extractAt) → coeffsObj` — compute the bin index;
        if that bin slot is empty, call `extractAt(binCenter)` (where
        `binCenter = (idx + 0.5)·binWidth`) and store the result; return the
        slot. `extractAt` is a caller-supplied closure (Phase 5 binds
        `op`+`sources`+`solveFn` into `(thC) => LIB.MotorCircuit.extract(op,
        solveFn, sources, thC, opts)`). The cache itself never touches `op`.
      - `cache.clear()` — empty every slot (geometry-edit / Reset invalidation).
    - `LIB.MotorCircuit.backEmf(coeffs, i, omega) → Float64Array` (length `m`) —
      `e[k] = omega·( Σ_l coeffs.dLdth[k*m + l]·i[l] + coeffs.dLambdaPmdth[k] )`.
      Pure; reads no `op`.
    - `LIB.MotorCircuit.stepCurrents({ L, R, V, i, dt, terminalStates, e }) →
      { i, vOpen }` (both length-`m` `Float64Array`s):
      - Active set `A` = indices where `terminalStates[k] !== "OPEN"`, in
        ascending order; `mₐ = A.length`. If the active set is empty (mₐ === 0,
        every circuit OPEN): return immediately with `i = all-zero Float64Array(m)`
        and `vOpen[k] = e[k]` for all `k` (each open circuit shows its motional
        EMF; no dense solve is attempted). Effective voltage `Veff[k] =
        (terminalStates[k] === "SHORT") ? 0 : V[k]`.
      - Assemble the reduced system over `A`: `Ar[a*mₐ + b] = L[A[a]*m + A[b]] +
        (a === b ? dt·R[A[a]] : 0)`; `rhs[a] = Σ_b L[A[a]*m + A[b]]·i[A[b]] +
        dt·(Veff[A[a]] − e[A[a]])`. Solve `Ar · x = rhs` via `solveDense`.
      - Output `iNext[A[a]] = x[a]`; `iNext[k] = 0` for every `OPEN` `k`.
      - `vOpen[k]` for `OPEN` `k` = `e[k] + Σ_l L[k*m + l]·(iNext[l] − i[l])/dt`
        (induced open-circuit terminal voltage); `vOpen[k] = 0` for non-open `k`.
      - Returns `{ i: iNext, vOpen }`.
    - `LIB.MotorCircuit.advance(coeffs, { R, V, i, omega, dt, terminalStates }) →
      { i, e, vOpen }` — pure composition: `e = backEmf(coeffs, i, omega)`; then
      `{ i, vOpen } = stepCurrents({ L: coeffs.L, R, V, i, dt, terminalStates,
      e })`; returns `{ i, e, vOpen }`. Reads no `op` (consumes pre-fetched
      `coeffs`), so Phase 5 calls `cache.coeffs(...)` then `advance(...)`.
    - Internal helper `solveDense(A, b, n)` — partial-pivot Gaussian elimination
      returning the length-`n` solution. Not exported.
- **Tests**: authored in Task 4.2.1 (`tests/circuit/*.test.js`). Listed there.
- **Acceptance criteria**:
  - `require("../../lib/motor-circuit.js")` after the shim attaches
    `LIB.MotorCircuit` with all five public functions
    (`extract`, `makeCache`, `backEmf`, `stepCurrents`, `advance`) as
    `typeof === "function"`, asserted in `tests/circuit/stepper.test.js`.
  - Module load triggers no DOM/canvas access (the `require` in the test process
    succeeds).
  - `stepCurrents` returns currents whose `OPEN` entries are exactly `0` and
    whose active entries solve `(L + R·dt)·iⁿ⁺¹ = L·iⁿ + (Veff − e)·dt` over the
    active set, asserted in `tests/circuit/stepper.test.js`.
  - All tests pass.

---

## Wave 4.2: Tests

### Task 4.2.1: Circuit-layer test suite + fixtures
- **Description**: The validation suite for `motor-circuit.js`: implicit
  stability vs a diverging explicit reference, terminal-state structure
  (`OPEN`/`SHORT`), induced current in a shorted secondary, motional back-EMF
  and open-circuit voltage, field-driven `L(θ)` extraction against Phase 1's
  analytic-salient fixture, and the θ-binned cache's refresh semantics. Reuses
  `assertClose`, `buildSalient`, `fitCos2`, and `SALIENT_DEFAULTS` from
  `tests/engine/_fixtures.js` read-only.
- **Files to create**:
  - `tests/circuit/_fixtures.js` — not a test file (no `.test.js`). On require:
    sets `if (!globalThis.window) globalThis.window = globalThis;`, then
    `require("../../lib/util.js"); require("../../lib/integrate.js");
    require("../../lib/airgap-grid.js"); require("../../lib/airgap-solve.js");`
    then `require("../../lib/motor-circuit.js");` so `LIB.MotorCircuit` is
    attached. Does NOT `require("../_shim.js")`. Exports:
    - `LIB` — the shared `window.LIB` (engine modules + `MotorCircuit`).
    - `assertClose`, `buildSalient`, `fitCos2`, `SALIENT_DEFAULTS` — re-exported from
      `require("../engine/_fixtures.js")`.
    - `rl1({ L, R }) → coeffs` — single-circuit (`m=1`) coeffs object:
      `L = Float64Array([L])`, `dLdth = Float64Array([0])`,
      `lambdaPm = Float64Array([0])`, `dLambdaPmdth = Float64Array([0])`.
    - `mutual2({ L0, L1, M }) → coeffs` — two-circuit (`m=2`) constant-mutual
      coeffs: `L = Float64Array([L0, M, M, L1])`, `dLdth = Float64Array(4)` (all
      zero), `lambdaPm = Float64Array(2)`, `dLambdaPmdth = Float64Array(2)`.
  - `tests/circuit/stepper.test.js` — `require("./_fixtures.js")`:
    - › `"LIB.MotorCircuit exposes the five primitives"` — assert
      `extract`, `makeCache`, `backEmf`, `stepCurrents`, `advance` are all
      `typeof === "function"`.
    - › `"implicit step is stable where explicit diverges (dt > 2L/R)"` — `rl1({
      L: 1e-3, R: 1 })`, `V = [1]`, `terminalStates = ["DC"]`, `dt = 5e-3`
      (`> 2L/R = 2e-3`), `omega = 0`, start `i = [0]`. Run `advance` 200 steps;
      assert `Math.abs(i[0])` stays `< 10` throughout and `assertClose(i[0], 1,
      1e-6)` at the end (steady state `V/R`). In the same test run an inline
      explicit reference `ie += dt·(V − R·ie)/L` from `ie = 0`; assert
      `Math.abs(ie) > 1e3` within the 200 steps (explicit diverges).
    - › `"SHORT decays current to zero"` — `rl1({ L: 1e-3, R: 1 })`,
      `terminalStates = ["SHORT"]`, `V = [5]`, start `i = [1]`, `dt = 1e-3`,
      `omega = 0`. After 200 `advance` steps assert `Math.abs(i[0]) < 1e-6`
      (effective `V = 0`, current dissipates).
    - › `"OPEN pins current to zero and exposes induced voltage"` — `mutual2({
      L0: 1e-3, L1: 1e-3, M: 0.8e-3 })`, `R = [1, 1]`, `V = [1, 0]`,
      `terminalStates = ["DC", "OPEN"]`, start `i = [0, 0]`, `dt = 1e-3`,
      `omega = 0`. On the first `advance` step assert `i[1] === 0` and
      `Math.abs(vOpen[1]) > 1e-4` (`i[0]` is ramping ⇒ induced `vOpen[1] =
      M·di0/dt ≠ 0`). After 400 steps assert `i[1] === 0`,
      `assertClose(i[0], 1, 1e-6)`, and `assertClose(vOpen[1], 0, 1e-6)`
      (steady state ⇒ no induced voltage).
  - `tests/circuit/induction.test.js` — `require("./_fixtures.js")`. Note:
    OPEN-circuit terminal-voltage coverage lives in `stepper.test.js`.
    - › `"shorted secondary carries induced (Lenz-opposing) current"` —
      `mutual2({ L0: 1e-3, L1: 1e-3, M: 0.8e-3 })`, `R = [1, 1]`, `V = [1, 0]`,
      `terminalStates = ["DC", "SHORT"]`, start `i = [0, 0]`, `dt = 1e-3`,
      `omega = 0`. Record the first-step result: assert `Math.abs(i[1]) > 1e-4`
      (current is induced) and `Math.sign(i[1]) !== Math.sign(i[0])`
      (Lenz-opposing, `M > 0`). After 400 steps (primary settled, `di0/dt → 0`)
      assert `assertClose(i[1], 0, 1e-4)` (induced current decays).
  - `tests/circuit/backemf.test.js` — `require("./_fixtures.js")`:
    - › `"backEmf computes ω·(dL/dθ·i + dλpm/dθ)"` — `m = 2`, hand coeffs with
      `dLdth = Float64Array([a, b, b, c])` (`a=2,b=0.5,c=3`), `dLambdaPmdth =
      Float64Array([p, q])` (`p=0.1,q=-0.2`), `i = Float64Array([1.5, -0.4])`,
      `omega = 30`. Assert `assertClose(e[0], 30·(2·1.5 + 0.5·-0.4 + 0.1),
      1e-12)` and `assertClose(e[1], 30·(0.5·1.5 + 3·-0.4 + -0.2), 1e-12)`.
    - › `"PM back-EMF appears at zero current under motion"` — coeffs with
      `dLambdaPmdth = Float64Array([0.05])`, `dLdth = Float64Array([0])`,
      `i = Float64Array([0])`, `omega = 100`. Assert `assertClose(e[0],
      100·0.05, 1e-12)`.
    - › `"open-circuit terminal voltage equals motional EMF at zero current"` —
      single circuit, `coeffs` with `L = Float64Array([1e-3])`,
      `dLdth = Float64Array([0])`, `lambdaPm = Float64Array([0])`,
      `dLambdaPmdth = Float64Array([0.05])`; `advance(coeffs, { R:
      Float64Array([1]), V: Float64Array([0]), i: Float64Array([0]), omega: 100,
      dt: 1e-3, terminalStates: ["OPEN"] })`. Assert `i[0] === 0` and
      `assertClose(vOpen[0], 100·0.05, 1e-9)`.
  - `tests/circuit/extract.test.js` — `require("./_fixtures.js")`:
    - › `"extract recovers L11(θ) matching the analytic salient inductance"` —
      `const f = buildSalient({ ...SALIENT_DEFAULTS, current: 1 })` (constants
      sourced from `SALIENT_DEFAULTS` exported by `tests/engine/_fixtures.js`).
      `buildSalient(...)` returns `{ op, Jz, coilMasks, ironMask, sweepThetaR(θ) }` and `sweepThetaR(θ)` returns `{ Az, Br, Bt, L11, torqueArkkio }` — defined in Phase 1 §Task 1.4.2 (re-exported read-only).
      Sweep
      `θ ∈ [0, π)` at 16 samples; for each, `const c = LIB.MotorCircuit.extract(
      f.op, LIB.AirgapSolve.pcg, { jzBasis: [f.Jz], coilMasks: f.coilMasks,
      magnetization: null }, θ)` and collect `c.L[0]`. Fit with
      `fitCos2(thetas, Ls)`; assert `r2 > 0.999`. Also assert each `c.L[0]`
      matches `f.sweepThetaR(θ).L11` within `assertClose(_, _, 1e-6, _)` (same
      `op`, same solve).
    - › `"extract dL/dθ matches the analytic −2·L2·sin2θ"` — using `L2` from the
      fit above, at `θ ∈ {0.3, 0.8, 1.3}` assert the relative error of
      `c.dLdth[0]` vs `−2·L2·sin(2θ)` is `< 0.05`.
    - › `"λ_pm is zero for a magnet-free config (zero-not-skip)"` — for the same
      magnet-free salient fixture assert `c.lambdaPm[0] === 0` and
      `c.dLambdaPmdth[0] === 0` at `θ = 0`.
  - `tests/circuit/cache.test.js` — `require("./_fixtures.js")`:
    - › `"cache extracts once per bin"` — `const cache =
      LIB.MotorCircuit.makeCache({ period: Math.PI, binCount: 8 })` (binWidth
      `≈ 0.3927`). A counter `extractAt` returning a dummy coeffs and
      incrementing `calls`. `cache.coeffs(0.05, extractAt)` then
      `cache.coeffs(0.10, extractAt)` (same bin 0) ⇒ assert `calls === 1`.
      `cache.coeffs(0.50, extractAt)` (bin 1) ⇒ assert `calls === 2`.
    - › `"cache.clear forces re-extraction"` — after the above, `cache.clear()`,
      then `cache.coeffs(0.05, extractAt)` ⇒ assert `calls === 3`.
    - › `"binIndex wraps by period"` — assert `cache.binIndex(0.05) ===
      cache.binIndex(0.05 + Math.PI)`, and `cache.coeffs(0.05 + Math.PI,
      extractAt)` after the bin-0 slot is populated does **not** increment
      `calls`.
- **Acceptance criteria**:
  - `npm test` runs all `tests/circuit/*.test.js` (plus the existing engine +
    smoke suites) and exits 0.
  - The stability test shows the explicit reference exceeding `1e3` while the
    implicit `advance` stays bounded and converges to `V/R`.
  - The induction test shows a nonzero, Lenz-opposing current in the shorted
    secondary that decays as the primary settles.
  - `extract` reproduces the analytic salient `L(θ)` (`r2 > 0.999`) and its
    `dL/dθ` (rel. error `< 0.05`), and yields exactly-zero `λ_pm`/`dλ_pm/dθ` for
    the magnet-free fixture.
  - The cache calls its `extractAt` exactly once per first-visited bin and
    re-extracts after `clear()`.
  - `tests/circuit/_fixtures.js` is not collected as a test file (no `.test.js`
    suffix) and is `require`-able by the test files.
  - All tests pass.
