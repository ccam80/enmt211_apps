# Phase 1: Engine core + test harness

## Overview

The headless, UI-agnostic numerical air-gap field core, plus the Node test
harness it is validated with. This phase ships the `2D vector-potential
∇·(ν∇A_z) = −J_z` solve on a structured polar thin-annulus grid, the
Jacobi-preconditioned warm-started PCG solver with a global flux-dependent
saturation ceiling, and the Arkkio gap-band torque (primary) plus a co-energy
decomposition consumed only by the test suite this phase.

Everything downstream depends on these modules. All three engine files are
DOM-free `window.LIB` IIFEs (no `document`/`canvas`/`getComputedStyle` at
module-load time) so they load under Node through the `require` shim. The
solver only ever sees compiled grid arrays (machine-agnosticism invariant #3);
no module in this phase has any knowledge of windings, machines, or the UI.

### Conventions fixed for this phase

- **Grid arrays** are row-major `Float64Array`s of length `Nr·Ntheta`, indexed
  `idx = i*Ntheta + j` (`i` = radial 0..Nr−1 inner→outer, `j` = angular
  0..Ntheta−1, periodic).
- **Discretization**: finite-volume, 5-point polar stencil, reluctivity `ν`
  harmonic-averaged onto cell faces. Periodic in θ. Iron is a low-`ν` region
  *inside* the domain (`ν = 1/μ`, so high-permeability iron has small `ν` and
  the air gap is high-`ν`; no per-rim boundary branch). The gauge is fixed by
  pinning one reference node to `A_z = 0`; the operator is SPD, so CG applies.
- **`μ₀ = 4π × 1e-7`** declared once per module that needs it.
- **Cell area** in polar coordinates: `dA = r·dr·dθ` (r = cell-centre radius).
- **Test runner**: `node:test` + `node:assert/strict`. `npm test` → `node --test`.
  A float-tolerance helper `assertClose(actual, expected, tol, msg)` lives in
  `tests/engine/_fixtures.js` and is reused by every engine test.

## Files Owned

- `package.json` — created
- `tests/_shim.js` — created
- `tests/smoke.test.js` — created
- `lib/airgap-grid.js` — created
- `lib/airgap-solve.js` — created
- `lib/airgap-torque.js` — created
- `tests/engine/_fixtures.js` — created
- `tests/engine/analytic-salient.test.js` — created
- `tests/engine/flux-balance.test.js` — created
- `tests/engine/convergence.test.js` — created
- `tests/engine/solver.test.js` — created

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 1.1: Test-harness scaffold

### Task 1.1.1: package.json + node:test runner + headless window shim
- **Description**: Introduce the repo's first `package.json` and a headless
  test harness. The harness lets `node:test` exercise the DOM-free `window.LIB`
  math modules (which attach to `window.LIB` via IIFE — e.g. `lib/integrate.js`
  references `window` directly) by defining a `window` global and `require`-ing
  the lib files in dependency order. `npm test` is green on a smoke assertion
  that proves the shim wires up a known-good existing module (`LIB.Integrate`).
- **Files to create**:
  - `package.json` — fields: `"name"` (`"enmt211-apps"`), `"private": true`,
    `"version": "0.0.0"`, `"scripts": { "test": "node --test" }`,
    `"engines": { "node": ">=18" }`. No `dependencies`, no `devDependencies`.
  - `tests/_shim.js` — the headless loader. On `require`:
    1. `if (!globalThis.window) globalThis.window = globalThis;` (so the IIFEs'
       `window.LIB || (window.LIB = {})` resolves to a persistent global).
    2. Declares a `LIB_FILES` array listing all Phase-1 module names up front:
       `["util.js", "integrate.js", "airgap-grid.js", "airgap-solve.js",
       "airgap-torque.js"]`. Iterates the array and `require`s each file by
       absolute path (`path.join(__dirname, "..", "lib", "<name>.js")`), wrapping
       each `require` in a `try/catch` that ignores `MODULE_NOT_FOUND` so that
       modules not yet created are silently skipped. Each IIFE that does exist
       executes on require and attaches to `window.LIB`.
    3. `module.exports = window.LIB;`
  - `tests/smoke.test.js` — uses `node:test` `test()` + `node:assert/strict`.
    `const LIB = require("./_shim.js");`
- **Tests**:
  - `tests/smoke.test.js` › `"shim exposes LIB.Integrate"` — assert
    `typeof LIB.Integrate.rk4 === "function"`.
  - `tests/smoke.test.js` › `"rk4 advances a trivial ODE"` — integrate
    `dx/dt = 1` from `x=0` one step `dt=0.5` via `LIB.Integrate.rk4` on
    `{x:0}` / `dof:["x"]`; assert `x` is within `1e-12` of `0.5`.
- **Acceptance criteria**:
  - `npm test` exits 0 with both smoke tests passing.
  - `tests/_shim.js` defines a `LIB_FILES` array listing all five Phase-1
    module names — `["util.js", "integrate.js", "airgap-grid.js",
    "airgap-solve.js", "airgap-torque.js"]` — with guarded `require` calls
    (try/catch ignoring `MODULE_NOT_FOUND`) so that not-yet-created modules
    are skipped without error. At task 1.1.1 time only `util.js` and
    `integrate.js` exist; the smoke test passes using only those two.
    The file re-exports `window.LIB`.
  - No `node_modules/`, no `dependencies` or `devDependencies` in
    `package.json`.
  - Both smoke tests (`shim exposes LIB.Integrate` and `rk4 advances a trivial ODE`) pass and `npm test` exits 0.
- **Note**: `npm test` is only fully green after all Phase-1 waves complete.
  Intermediate runs (before `airgap-*.js` modules exist) will skip the
  guarded `require` calls for those modules without error — this is expected
  behaviour by design of the guarded-require shim.

---

## Wave 1.2: Grid + field/flux extraction

### Task 1.2.1: airgap-grid.js — polar FV operator, sliding band, field & flux
- **Description**: The structured polar thin-annulus grid and the discrete
  `−∇·(ν∇·)` operator. Finite-volume assembly with harmonic-averaged face `ν`,
  periodic θ, one pinned gauge node. Matrix-free: the operator object exposes a
  `matvec` and `diagonal` for the PCG in 1.3, an RHS assembler from `J_z` +
  magnetization, a sliding-band rotor shift, and field/flux extraction. The
  module reads only compiled arrays — no winding/machine/UI knowledge.
- **Files to create**:
  - `lib/airgap-grid.js` — IIFE attaching `LIB.AirgapGrid`. API:
    - `LIB.AirgapGrid.create({ Nr=12, Ntheta=256, rInner, rOuter, ell=1 })
      → GridOperator`. Computes `dr`, `dtheta=2π/Ntheta`, cell-centre radii
      `r[i]`. `Nr`/`Ntheta` are stored and overridable per call. The returned
      `op` exposes the following as **public read-only properties**: `op.ell`,
      `op.r` (Float64Array of cell-centre radii, length `Nr`), `op.dr`,
      `op.dtheta`, `op.Nr`, `op.Ntheta` (in addition to `op.gapBand` and
      `op.dA` described below).
    - `op.setMaterials({ nu })` — ingest the reluctivity mask (length
      `Nr·Ntheta`); compute harmonic face averages and the per-cell stencil
      coefficient arrays `aP,aE,aW,aN,aS` (`Float64Array`s). Stores `nu` as the
      base for `setIronScale`.
    - `op.setRotorRegion({ rotorMask })` — `Uint8Array` (1 = cell belongs to the
      rotor body). Snapshots the rotor cells' base `nu` (and magnetization, if
      set) as the θr=0 template.
    - `op.setRotorAngle(thetaR)` — shift the rotor-region template by `Δθ=thetaR`
      using **1st-order linear interpolation** on the periodic angular index
      (`shift = thetaR/dtheta`, blend the two bracketing angular samples), write
      the interpolated `nu`/magnetization back into the rotor cells, and
      recompute the affected stencil coefficients only. No remesh.
    - `op.setIronScale(s, ironMask)` — multiply the `nu` of cells where
      `ironMask[idx]` is set by `s` relative to the base `nu`, recompute affected
      coefficients. `s=1` restores base. Used by the saturation ceiling in 1.3.
    - `op.getReluctivity() → Float64Array` — return a **copy** of the current
      per-cell active reluctivity (length `Nr·Ntheta`), reflecting any rotor
      positioning (`setRotorAngle`) and iron scaling currently applied. Read-only
      snapshot; mutating the returned array does not affect the operator. (The
      Phase-9 nonlinear tier snapshots the rotor-positioned material with this
      before applying per-cell `ν(B)`.)
    - `op.setIronReluctivity(nuValues, ironMask)` — write **absolute** reluctivity
      onto the cells where `ironMask[idx]` is set, in place, recomputing only the
      affected stencil coefficients. Leaves non-iron cells **and the rotor-shift
      template untouched** (rotor-safe, exactly like `setIronScale` — it does NOT
      re-snapshot the rotor region). `nuValues` is a full-length `Float64Array`;
      only the masked entries are read. (The Phase-9 nonlinear tier calls this each
      Picard iteration to apply per-cell `ν(B)`, and once more at the end to
      restore the `getReluctivity` snapshot.)
    - `op.matvec(x, out=null) → Float64Array` — apply the discrete `−∇·(ν∇·)` to
      `x`, periodic θ wrap on E/W neighbours, radial ends use one-sided (no
      coupling beyond the annulus). The pinned node row is the identity
      (`out[pin] = x[pin]`).
    - `op.diagonal() → Float64Array` — the `aP` diagonal (identity at the pinned
      node), for the Jacobi preconditioner.
    - `op.assembleRHS({ Jz=null, magnetization=null }) → Float64Array` — `b` from
      the `J_z` source (`b[idx] += Jz[idx]·dA[idx]`) plus the magnetization
      contribution expressed as equivalent surface currents via the Stokes-theorem
      finite-volume form. `magnetization` is `{ Mr, Mθ }` (two `Float64Array`s,
      cell-centred radial and angular components). The magnetization contributes
      `b[idx] += ∮_{∂cell} M · ds_perp` discretized over the four polar cell
      faces using face-averaged `Mr`/`Mθ` values:
        - **Radial faces** (at `j±½`, constant `r`): carry the `Mθ`-derived flux.
          For the east face (j+½): contribution `+½(Mθ[idx] + Mθ[i,j+1])·dr`
          (length element `dr` in the r-direction); west face is the negative
          counterpart. The `r`-coordinate weights these as `r[i]·dtheta` on the
          angular faces and `dr` on the radial faces, consistent with the polar
          face-area factors.
        - **Angular faces** (at `i±½`, constant `θ`): carry the `Mr`-derived flux.
          For the north face (i+½): contribution `−½(Mr[idx] + Mr[i+1,j])·r[i+½]·dtheta`
          (face radius `r[i+½] = ½(r[i]+r[i+1])`); south face is the positive
          counterpart. Radial end faces (i=0 and i=Nr−1) contribute zero (no
          coupling beyond the annulus, consistent with `matvec`).
      This is the curl of M expressed as equivalent surface currents and is
      consistent with the FV operator's face treatment. `null` inputs contribute
      zero (zero-not-skip). Force `b[pin]=0`.
    - `op.field(Az) → { Br, Bt }` — `Br[idx]=(1/r)·∂A_z/∂θ` (central diff in θ,
      periodic), `Bt[idx]=−∂A_z/∂r` (central diff in r, one-sided at rims).
    - `op.fluxLinkage(Az, coilMasks) → Float64Array` — for each per-circuit
      signed mask `coilMasks[k]` (length `Nr·Ntheta`): `λ_k = Σ_idx Az[idx]·
      coilMasks[k][idx]·dA[idx]`.
    - `op.setGapBand({ iInner, iOuter })` — sets the gap-band index range stored
      as `op.gapBand`, consumed by the Arkkio torque (Task 1.4.1).
    - `op.gapBand` — `{ iInner, iOuter }` radial index range of the air gap, set
      via `op.setGapBand({ iInner, iOuter })` (supplied by config/fixture; not
      auto-detected). Consumed by the Arkkio torque in 1.4.1.
    - `op.dA` — `Float64Array` of per-cell areas `r[i]·dr·dtheta`.
- **Tests** (authored in Task 1.4.2; listed here for traceability):
  - `tests/engine/flux-balance.test.js` covers `field`/operator (`∮ B_r dθ = 0`).
  - `tests/engine/analytic-salient.test.js` covers `setRotorAngle` sliding band
    + `fluxLinkage` (the `L(θr)` sweep).
- **Acceptance criteria**:
  - `LIB.AirgapGrid.create(...)` returns an object exposing every method above.
  - `op.matvec` of a constant vector (away from the pinned node) is ~0 to
    `1e-9` (the discrete `−∇·(ν∇·)` annihilates constants — confirms correct
    face cancellation), asserted in `solver.test.js`.
  - `op.diagonal()` equals the `aP` array (identity entry at the pinned node),
    asserted in `solver.test.js`.
  - `op.setIronReluctivity(nuValues, ironMask)` writes the given absolute values to
    the iron cells (read back via `op.getReluctivity`) and leaves non-iron cells
    unchanged; a subsequent `op.matvec` reflects the new coefficients; restoring
    the prior `getReluctivity` snapshot returns the operator's reluctivity to its
    earlier values entrywise (asserted in `solver.test.js`).
  - Module loads under `require` with no DOM access (the shim load in
    `smoke.test.js`'s process succeeds).
  - All tests pass.

---

## Wave 1.3: Coarse solver + Live saturation ceiling

### Task 1.3.1: airgap-solve.js — Jacobi-PCG, warm-start, global ceiling
- **Description**: The coarse linear solver: Jacobi-preconditioned conjugate
  gradient against the `GridOperator`'s `matvec`/`diagonal`, warm-startable from
  a previous `A_z`. Plus the always-live default **global flux-dependent
  saturation ceiling**: one scalar `ν` scaling derived from the B–H knee,
  applied as a single corrective re-solve so Live stays ~1–2 solves.
- **Files to create**:
  - `lib/airgap-solve.js` — IIFE attaching `LIB.AirgapSolve`. API:
    - `LIB.AirgapSolve.pcg(op, b, { x0=null, tol=1e-6, maxIter=400 })
      → { x, iters, residual }` — Jacobi-PCG. Initial guess `x0` (warm start) or
      zeros. Stop when `‖r‖₂ / ‖b‖₂ ≤ tol` or `iters === maxIter`. Uses only
      `op.matvec` and `op.diagonal`. Holds the pinned node fixed.
    - `LIB.AirgapSolve.solveSaturated(op, b, { x0=null, tol=1e-6, maxIter=400,
      ceiling }) → { x, iters, residual, satScale }` where
      `ceiling = { enabled=true, Bknee=1.6, p=2, ironMask }`:
      1. Linear solve via `pcg`.
      2. If `ceiling.enabled`: compute `Bpeak = max |B|` over `ironMask` cells
         (`|B| = hypot(Br, Bt)` from `op.field`). `s = max(1, (Bpeak/Bknee)^p)`.
      3. If `s > 1`: `op.setIronScale(s, ironMask)`; one corrective `pcg`
         re-solve (warm-started from step 1's `x`); then `op.setIronScale(1,
         ironMask)` to restore base. If `s === 1`: return step-1 result
         unchanged (identity below the knee — single solve).
      4. Return the final `x`, total `iters`, `residual`, and `satScale = s`.
- **Tests** (authored in Task 1.4.2; listed here for traceability):
  - `tests/engine/solver.test.js` covers PCG correctness, the warm-start budget,
    and the ceiling behaviour.
- **Acceptance criteria**:
  - `pcg` solves `op.matvec(x) ≈ b` to the requested `tol` on the salient
    fixture (relative residual `≤ 1e-6`), asserted in `solver.test.js`.
  - Warm-start: after a one-cell `setRotorAngle` step, a warm-started `pcg`
    (`x0` = the pre-step solution) reports `iters` strictly less than the
    cold-start (`x0=null`) `iters`, and `iters ≤ ½ · cold_iters`, and
    `iters < Ntheta`.
  - Ceiling: with `Bpeak < Bknee` the solve is the identity (`satScale === 1`,
    single PCG call); with a source scaled so `Bpeak > Bknee`, `satScale > 1`
    and the resulting `Bpeak` is strictly lower than the un-ceilinged solve's
    `Bpeak`.
  - All tests pass.

---

## Wave 1.4: Torque + core physics tests

### Task 1.4.1: airgap-torque.js — Arkkio gap-band torque + co-energy decomposition
- **Description**: Torque from the solved field. Primary = **Arkkio gap-band
  average** (radial-averaged Maxwell stress over the air gap — grid-robust,
  contour-independent in the continuum). Secondary = co-energy decomposition
  (`reluctance` / `pm` / `mutual` / `total`) via central-difference `dL/dθ` and
  `dλ_pm/dθ`, each from extra solves; **all terms always computed** (no PM →
  `dλ_pm/dθ=0` falls out — zero-not-skip). The co-energy function is consumed
  only by the test suite this phase; its live use is decided at Phase 5.
- **Files to create**:
  - `lib/airgap-torque.js` — IIFE attaching `LIB.AirgapTorque`. API:
    - `LIB.AirgapTorque.arkkio(op, Az, { gapBand=op.gapBand }) → number` —
      `T = (ell / (μ₀·(rOuter_gap − rInner_gap))) · Σ_{i∈gapBand} Σ_j
      r[i]²·Br[idx]·Bt[idx]·dr·dtheta` — the integrand uses the polar area
      element `dS = r·dr·dθ`, so the radial factor is `r[i]²` (one `r` is the
      Maxwell-stress moment arm, one comes from `dS`), where `rOuter_gap` and `rInner_gap`
      are the face-to-face radial extent of the gap-band cells (gapBand covers
      cells `iInner..iOuter-1`): `rOuter_gap = op.r[gapBand.iOuter-1] + op.dr/2`
      and `rInner_gap = op.r[gapBand.iInner] − op.dr/2`. `Br`/`Bt` from
      `op.field(Az)`. The grid scalars `ell`, `r`, `dr`, `dtheta`, `Nr`, and
      `Ntheta` are read from the public properties of `op` (see Task 1.2.1).
    - `LIB.AirgapTorque.coenergy(op, solveFn, { thetaR, currents, coilMasks,
      magnetization, ironMask=null, dTheta=op.dtheta }) → { reluctance, pm,
      mutual, total }` — build the inductance matrix `L(θ)` from the field
      response to unit current per circuit, evaluated at `thetaR±dTheta` (via
      `op.setRotorAngle` + `solveFn` = the caller's `pcg`), and `λ_pm(θ)` from a
      magnetization-only solve. The `dTheta=op.dtheta` default references the
      now-public field on `op` (see Task 1.2.1). Unit-current solves assemble
      `Jz_l = coilMasks[l]` internally; the PM solve uses `Jz = 0`. No
      background current-density parameter is accepted. **Inductance-matrix
      assembly procedure**: for each circuit `l`, assemble a unit-current source
      `Jz_l = coilMasks[l]` (current 1 A in circuit `l`, 0 elsewhere); solve
      the field at `thetaR+dTheta` and `thetaR−dTheta` using `solveFn`
      (cold-started (`x0 = null`); warm-starting is not required for this
      test-only co-energy function); for each circuit `k`
      compute `L_kl(θ±) = fluxLinkage(Az±, coilMasks[k])` via `op.fluxLinkage`;
      then `dL_kl/dθ ≈ (L_kl(θ+) − L_kl(θ−)) / (2·dTheta)`. The PM flux
      linkage gradient `dλ_pm,k/dθ` is obtained from a zero-current
      magnetization-only solve (Jz = 0, magnetization supplied) at the same two
      angles: `λ_pm,k(θ±) = fluxLinkage(Az_pm±, coilMasks[k])`; then
      `dλ_pm,k/dθ ≈ (λ_pm,k(θ+) − λ_pm,k(θ−)) / (2·dTheta)`. Compose:
      - `reluctance = ½ Σ_k currents[k]² · dL_kk/dθ`
      - `mutual = ½ Σ_{k≠l} currents[k]·currents[l] · dL_kl/dθ`
      - `pm = Σ_k currents[k] · dλ_pm,k/dθ`
      - `total = reluctance + mutual + pm`
      Restores `op.setRotorAngle(thetaR)` before returning.
- **Tests** (authored in Task 1.4.2):
  - `tests/engine/analytic-salient.test.js` covers `arkkio` vs the closed form
    and `arkkio` vs `coenergy.total`.
- **Acceptance criteria**:
  - `arkkio` returns a finite scalar with the sign convention that a positive
    `dL/dθ` at positive current gives positive torque (validated against the
    salient closed form in `analytic-salient.test.js`).
  - `coenergy` returns all four keys as finite numbers for a current-fed config
    with no magnet, with `pm === 0` (zero-not-skip).
  - All tests pass.

### Task 1.4.2: Core physics tests + salient fixture
- **Depends on**: Task 1.4.1 (its tests call `LIB.AirgapTorque.*`, which must
  be created first).
- **Description**: The engine validation suite and the shared analytic-salient
  fixture it is built on. Validates the grid (1.2.1), solver (1.3.1), and torque
  (1.4.1) against closed-form and convergence criteria.

  **Clarified 2026-05-24 (spec-contradiction resolution, "Real-iron, strict"):**
  the original "modulate air-gap cell reluctivity" permeance-emulation fixture is
  REPLACED by a real magnetic machine, because a θ-modulated all-air annulus
  carries no net Maxwell shear and makes the Arkkio integral identically ~0 —
  it cannot validate Arkkio. The two Arkkio acceptance tests and their
  tolerances (`< 0.03`, `< 0.02`) are kept; the Arkkio prefactor is corrected to
  `r²` (Task 1.4.1); the grid is raised so the gap is radially resolved.

  The salient fixture is a **real magnetic machine**: an iron rotor
  (`ν = ν_iron`), a genuine air gap (`ν = ν₀`, never modulated), and an iron
  stator (`ν = ν_iron`), carrying a sinusoidal stator winding mask `n(θ)=N·cosθ`.
  Saliency is geometric: the rotor iron's outer surface is θ-modulated (a
  salient/staircase rotor on the polar grid — the radial depth of rotor-iron
  cells varies per θ-column, with air filling the remainder up to the gap band)
  so that the effective air-gap permeance realizes
  `1/g(θ,θr) ∝ a₀ + a₂cos2(θ−θr)`. The dedicated air-gap band
  `[rGapInner, rGapOuter]` (see `SALIENT_DEFAULTS`) is pure air at EVERY θ-column
  and sits above the highest rotor-surface excursion; it is the band Arkkio
  integrates over. The rotor-iron cells (whose θ-dependent depth encodes the
  saliency) are declared the rotor region, so `setRotorAngle(θr)` rotates the
  saliency — this exercises the sliding band and produces the analytic
  `L(θr)`/`T(θr)` sweep, AND a non-zero, physically meaningful Arkkio torque.
- **Files to create**:
  - `tests/engine/_fixtures.js` — not a test file (no `.test.js`). Exports:
    - `assertClose(actual, expected, tol, msg)` — absolute/relative float helper.
    - `SALIENT_DEFAULTS` — a named export object holding the concrete fixture
      constants used by the analytic-salient tests and any downstream phase
      (e.g. Phase 4's extract tests) as a single source of truth:
      `{ Nr: 40, Ntheta: 256, rInner: 0.04, rOuter: 0.06, ell: 1,
         rGapInner: 0.048, rGapOuter: 0.052, a0: 1.0, a2: 0.3, N: 100,
         current: 1.0 }`.
      Geometry contract (real iron↔air-gap↔iron machine):
      - `Nr ≥ 32` and the always-air gap band `[rGapInner, rGapOuter]` MUST span
        ≥8 radial cells. With these defaults `dr = (rOuter−rInner)/Nr = 0.0005 m`
        and the gap span `0.004 m` = 8 cells.
      - Rotor iron occupies `[rInner, rGapInner]`; the salient rotor surface is
        realized WITHIN that band by per-θ-column modulation of the rotor-iron
        outer depth (air fills the rest of the band up to `rGapInner`), so the
        rotor surface never enters the gap band.
      - Stator iron occupies `[rGapOuter, rOuter]`.
      - `[rGapInner, rGapOuter]` is pure air at every column and is passed to
        `op.setGapBand` as the Arkkio integration band.
      Consumers call `buildSalient(SALIENT_DEFAULTS)` rather than hard-coding
      these values.
    - `buildSalient({ Nr, Ntheta, rInner, rOuter, ell, rGapInner, rGapOuter,
      a0, a2, N, current })
      → { op, Jz, coilMasks, ironMask, sweepThetaR(thetaR) }` — constructs the
      `GridOperator`, the salient iron rotor (rotor region) with its θ-modulated
      surface depth, the always-air gap band `[rGapInner, rGapOuter]` registered
      via `op.setGapBand` as the Arkkio band, the iron stator, the sinusoidal stator
      `Jz`/`coilMasks`, the `ironMask`, and a helper that sets `thetaR`, solves,
      and returns `{ Az, Br, Bt, L11, torqueArkkio }`.
    - `fitCos2(thetaRs, Ls) → { L0, L2, r2 }` — least-squares fit of
      `L(θr)=L0+L2cos2θr`, returning the coefficient-of-determination `r2`.
  - `tests/engine/analytic-salient.test.js`:
    - › `"L(θr) fits L0 + L2 cos2θr"` — sweep `θr ∈ [0, π)` (≥16 samples), build
      `L11(θr)` from the fixture, fit; assert `r2 > 0.999`.
    - › `"Arkkio torque matches −i²L2 sin2θr"` — using `L2` from the fit, assert
      relative-L∞ error of `arkkio(θr)` vs `−current²·L2·sin2θr` over the sweep
      `< 0.03`.
    - › `"Arkkio matches co-energy total"` — assert relative error of `arkkio`
      vs `coenergy.total` over the sweep `< 0.02`.
  - `tests/engine/flux-balance.test.js`:
    - › `"∮ B_r dθ = 0 on the mid-gap row"` — for a solved salient field, assert
      `|Σ_j Br[midGapRow, j]·dtheta| < 1e-9`.
  - `tests/engine/convergence.test.js`:
    - › `"torque error decreases with Nθ"` — build the salient fixture at
      `Ntheta ∈ {64, 128, 256}` (fixed `Nr = SALIENT_DEFAULTS.Nr`, i.e. ≥32 with
      a ≥8-cell air gap), compute relative-L∞ Arkkio error vs the closed form at
      each; assert the error is strictly monotone decreasing in `Ntheta` and
      `< 0.03` at `Ntheta=256`.
  - `tests/engine/solver.test.js`:
    - › `"matvec annihilates constants"` — assert `‖op.matvec(ones)‖∞ < 1e-9`
      away from the pinned node.
    - › `"diagonal equals aP"` — assert `op.diagonal()` matches the operator's
      `aP` entrywise (identity at the pinned node).
    - › `"getReluctivity / setIronReluctivity round-trip"` — snapshot
      `nu0 = op.getReluctivity()`; pick the salient fixture's `ironMask` cells;
      `op.setIronReluctivity(modified, ironMask)` (modified = `nu0` with iron cells
      doubled); assert `op.getReluctivity()` equals `modified` on iron cells and
      `nu0` elsewhere, and that `op.matvec(x)` differs from the pre-change result
      on at least one entry; then `op.setIronReluctivity(nu0, ironMask)` and assert
      `op.getReluctivity()` equals `nu0` entrywise within `1e-12` (rotor-safe
      restore).
    - › `"pcg converges to tol"` — assert relative residual `≤ 1e-6` on the
      salient `b`.
    - › `"warm-start cuts iterations"` — assert `warm.iters < cold.iters` and
      `warm.iters ≤ 0.5·cold.iters` and `warm.iters < Ntheta` after a one-cell
      `setRotorAngle` step.
    - › `"ceiling is identity below the knee"` — assert `satScale === 1` and a
      single PCG call when `Bpeak < Bknee`.
    - › `"ceiling reduces Bpeak above the knee"` — with a source scaled past the
      knee, assert `satScale > 1` and ceilinged `Bpeak < un-ceilinged Bpeak`.
- **Acceptance criteria**:
  - `npm test` runs all `tests/engine/*.test.js` plus the smoke test, exits 0.
  - The salient closed-form, flux-balance, convergence, and solver assertions
    above all hold at the stated tolerances. The `< 0.03` (3%) relative-L∞
    bound used in `analytic-salient.test.js` and `convergence.test.js` is an
    intentional smoke-gate upper bound chosen to avoid flaky tests on coarse
    grids; the convergence test's monotone-decrease assertion is the actual
    precision validator. The numeric thresholds are not changed.
  - `tests/engine/_fixtures.js` is not picked up as a test file (no `.test.js`
    suffix) and is `require`-able by the test files.
  - All tests pass.
