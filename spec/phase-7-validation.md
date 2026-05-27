# Phase 7: Validation (physics, not the grid)

## Overview

Re-establish every analytic / physics acceptance criterion on the FEA engine
and add the headline the grid could never meet — **saturated cogging
grid-convergent to < 5 %**. The grid is **not** an oracle. References are
closed-form analytic, three-way cross-method consistency on the mesh, and
mesh-refinement convergence in the Richardson sense.

This phase ships **tests only** — no `lib/*` or `lessons/unified_motor/*`
source files are modified. Every physics change has already landed in
Phases 1–5; Phase 6 owns the live-UI work in parallel.

Phase 7 has two waves:

- **Wave 7.1** builds the new engine-tier validation suite under
  `tests/fea-engine/*.test.js` (T7.1.1) AND re-points the 15 machine-fixture
  tests onto the FEA-native slice (T7.1.2). The re-point is a mechanical-edit
  task: each of the four broken references (`fitCos2`/`fitCos2Cos4` import,
  `ceiling`→`saturation` opt key, the WFS `skip:` un-skip, and stale `Phase-N`
  mentions) is enumerated below; the implementer applies a scripted dry-run
  edit, not hand-editing one location at a time.
- **Wave 7.2** is the rebuild's proof: saturated cogging Richardson-convergent
  to < 5 % on a hand-built `saturatedPmConfig`, with Newton numeric guards
  pinned at the most-saturated angle.

### Locked decisions for this phase (settled with the author 2026-05-27)

- **D1 — Engine-tier tests split by validation category.** Five new
  files under `tests/fea-engine/` (one shared loader + four assertion files):
  `_fixtures.js`, `convergence.test.js`, `analytic.test.js`,
  `cross-method.test.js`, `known-machine.test.js`. Wave 7.2 adds a sixth,
  `saturated-cogging.test.js`. Splitting by category gives parallel
  `node --test` execution and locality for failures.

- **D2 — Analytic references use hand-built minimal configs.** Two
  configs live in `tests/fea-engine/_fixtures.js`: `slotlessPmConfig()` (PM
  rotor + smooth-iron `I`-only stator, no slots, no excitation circuits —
  for the slotless gap peak `|B|` reference) and `roundRotorWoundConfig()`
  (smooth-iron `I` rotor + distributed-wound `W` stator — for the
  round-rotor analytic linear inductance). Cross-method, known-machine, and
  convergence tests use the real `machines/*.js` fixtures (registered via
  the existing `tests/machines/_fixtures.js`).

- **D3 — Three-way cross-method (harmonic vs mesh-Arkkio vs co-energy).**
  Phase 5's `slice.solve` already returns the harmonic torque
  (`gap.torque(...)`). Co-energy is `stack.coenergyTorque(θ,
  currents).total`. The third arm — mesh-Arkkio — comes from a new
  `meshArkkioTorque(solveResult, opts) → number` helper in the fixtures
  file: integrates `B_r·B_t·r·area` over the stator-body air elements
  within the unmeshed-gap annulus (those with `matId == air-material-id`
  and centroid radius in `[r_mr, r_ms]`), scaled by
  `ell / (μ0·(r_ms − r_mr))`.
  All three must agree within 2 % at a loaded operating point. (The
  harmonic and mesh-Arkkio values are *operator-equivalent* but
  discretization-distinct, so an exact match is not expected — the 2 % bar
  is the §11.3 cross-method consistency bar.)

- **D4 — Saturated cogging fixture is `saturatedPmConfig()`.** Hand-built
  in `tests/fea-engine/_fixtures.js`, dedicated to driving explicit local
  iron saturation (the regime the old global-ceiling engine failed on).
  Geometry: 4-pole PMSM cross-section, magnet remanence raised to
  `Mr = 1.4e6` (Br ≈ 1.76 T — well above the linear saturation limit), iron
  `Bknee = 1.2` T (lower than the `BkneeDefault=1.6` so the back-iron
  saturates locally before the linear gap breaks down). 12 stator slots, 4
  rotor magnets → cogging period `2π / LCM(12,4) = 2π/12 = π/6`. Other
  fields (`grid`, `mechanical`, `R`, etc.) copied verbatim from the
  `pmsm.js` fixture so the test reads like a saturated PMSM.

- **D5 — Richardson schedule is three levels `refine ∈ {1, √2, 2}`.**
  Three mesh resolutions allow two between-level deltas; both must satisfy
  the < 5 % bar. (Two levels would give one delta — no overlapping
  confirmation; the plan's "grid-convergent" framing requires
  multi-step.)

- **D6 — Existing machine-test timeouts stay at `25000` ms.** The
  re-point does not pre-emptively bump timeouts; if any test actually
  exceeds 25 s under the rebuilt FEA slice, the implementer takes a
  **Clarification Exit** quoting the test name, the measured wall-clock,
  and the §11.3 budget rather than silently widening tolerances.

- **D7 — Stale "Phase-N" / "Wave-N" references stripped in COMMENTS only
  within re-pointed files.** The user's scrub scope was "in the comments
  that you encounter" — strict reading respects test-name strings as
  *code-level identifiers*, not comments. The shared
  `"expands to Phase-2 sections with matching circuit count"` test-name
  string therefore **stays as-is** across all 15 machine test files; only
  comment-level `Phase-N` / `Wave-N` mentions in the re-pointed footprint
  (4 lines in `_fixtures.js`, 1 line in `switched-reluctance.test.js`, the
  multi-line deferred-explanation block above the WFS un-skip) are
  removed. Stale `FIX N` work-tracking comments are **NOT** touched (out
  of scope; the user limited the scrub to "phase" references). Keeping
  the rename out of scope also keeps T7.1.2's file footprint within the
  10-file-per-group cap (6 files vs. 16 if the 11 rename-only files were
  also touched).

- **D8 — Mesh-Arkkio integration reads `slice.__internals.bodies`.**
  Phase 5 exposes `slice.__internals.bodies = { rotor, stator }`; each
  `BodyMesh` carries `gapR` (Phase 2). The helper extracts
  `r_mr = bodies.rotor.gapR` and `r_ms = bodies.stator.gapR` and
  integrates over the **full air-collar annulus** `[r_mr, r_ms]` on the
  stator-body mesh — the textbook Arkkio form on the unmeshed-gap
  thickness. `mu0` and `ell` are passed by the caller (test reads
  `section.grid.ell` from its config). No new `slice.__internals` field
  is required of Phase 5.

- **D9 — WFS self-start un-skip preserves the existing assertion body
  byte-for-byte.** Phase 7 removes the `skip:` key on the
  `"does not self-start from rest on AC-none"` test and the long deferred
  comment block (lines 33–42 of the existing file). The test body (lines
  45–50: the function body — `runFromRest(runtime, 150)`,
  `assert.ok(Math.abs(state.theta) < 1e-3, …)`, and the closing `});`) is
  byte-identical to before. Phase 3 already flipped the
  fixture's field circuit from `DC amp:12` to `CURRENT amp:12`, so the
  field current is pinned regardless of slip → no induction-damper line
  start.

## Files Owned

### Created
- `tests/fea-engine/_fixtures.js` — shared loader + hand-built configs
  (`slotlessPmConfig`, `roundRotorWoundConfig`, `saturatedPmConfig`) +
  `meshArkkioTorque` helper + analytic-reference helpers (closed-form
  PMSM-bore peak `|B|`, round-rotor `L_phase`).
- `tests/fea-engine/convergence.test.js` — loaded-operating-point
  Richardson convergence on `pmsm`.
- `tests/fea-engine/analytic.test.js` — no-load back-EMF, slotless gap
  peak `|B|`, round-rotor linear inductance.
- `tests/fea-engine/cross-method.test.js` — harmonic vs mesh-Arkkio vs
  co-energy at a loaded point on `pmsm` and `salientConfig`.
- `tests/fea-engine/known-machine.test.js` — reluctance `L(θ)` fit on
  `synchronous-reluctance`, reluctance-torque ∝ i² ratio on `vr-stepper`
  (linear mode), cogging-period LCM on `pmsm` and `pm-stepper`, `λ_pm = 0`
  on non-PM machines.
- `tests/fea-engine/saturated-cogging.test.js` — the Wave 7.2 headline.
- `scripts/phase7-repoint.mjs` — scripted-edit driver for T7.1.2
  (literal-string `str.replace` substitutions; dry-run by default; emits
  `file:line | before | after` diff lines).

### Modified (Wave 7.1 — T7.1.2 mechanical edits)
- `tests/machines/_fixtures.js` — `fitCos2` import re-pointed to
  `../_assert.js`; `crossCheck`'s `ceiling:{enabled:false}` flipped to
  `saturation:{enabled:false}`; the four stale `Phase-N` / `Wave-N`
  mentions in comments (lines 4, 5, 7, 16) stripped.
- `tests/machines/synchronous-reluctance.test.js` — `fitCos2Cos4` import
  re-pointed to `../_assert.js`.
- `tests/machines/switched-reluctance.test.js` — `fitCos2Cos4` import
  re-pointed; `ceiling:{enabled:false}` flipped to
  `saturation:{enabled:false}`; the line-89 `Phase-9` carve-out comment
  edited.
- `tests/machines/vr-stepper.test.js` — `fitCos2Cos4` import re-pointed;
  `ceiling:{enabled:false}` flipped.
- `tests/machines/wound-field-synchronous.test.js` — un-skip the
  self-start test (`skip:` key removed; deferred-explanation comment
  block above the test removed).

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 7.1: Engine-tier FEA validation + machine-test re-point

### Task T7.1.1: New engine-tier FEA tests under `tests/fea-engine/`

- **Description**: Build the FEA-engine validation suite that re-establishes
  every analytic/physics acceptance criterion against the rebuilt slice and
  adds the three-way cross-method consistency check. Single shared loader
  (`_fixtures.js`) carrying hand-built configs and helpers; four assertion
  files, one per validation category. **All tests use the rebuilt
  `LIB.MotorSlice` via `CS.expand(cfg) → LIB.MotorStack.create(expanded, opts)`
  — they never reach into grid code (which no longer exists).**

- **Files to create**:

  - `tests/fea-engine/_fixtures.js`:
    - `"use strict";` `if (!globalThis.window) globalThis.window = globalThis;`
    - Require the pipeline loader: `const P = require("../pipeline/_fixtures.js");`
      → re-exports `LIB`, `UnifiedMotor`, `CS = UnifiedMotor.ConfigSchema`,
      `initSolver`, `feaOpts`, `assertClose`, `woundConfig`, `pmConfig`,
      `salientConfig`, `skewN2Config`.
    - Require the machine-test loader: `const M = require("../machines/_fixtures.js");`
      → re-exports `byId`, `MACHINE_IDS`, `build`, `validate`, `sweepTorque`,
      `sweepInductance`, `sweepLambdaPm`, `crossCheck`, `runFromRest`,
      `avgTorqueAtSpeed`, `dftAmp`, `signChanges`, `ripple`, `mean`. (This
      shares the 15 fixtures' registration; no duplicate-require warning is
      possible because all fixture files guard via `(UM.MACHINES || ...)`.)
    - Require `fitCos2`/`fitCos2Cos4` from `../_assert.js`.
    - **Hand-built configs** (each a pure function returning a fresh object):
      - `slotlessPmConfig() → config`: 4-pole, single rotor M ring (4 magnets,
        `Mr = 9e5`, `backIron: true`, `backIronRRange: [0.030, 0.038]`,
        `rRange: [0.038, 0.043]`, `muR: 1000`), single stator I ring (smooth
        iron, no slots, `rRange: [0.047, 0.055]`, `teeth: 1`, `muR: 1000`).
        `circuits: []` (no excitation; pure-PM gap field). `grid`, `mechanical`,
        `stack`, `poles=4` as in `pmsm.js`. Adds an analytic-reference
        constant `slotlessExpectedBPeak()` returning
        `Br · g_m / (g_m + g)` where `Br = μ0·Mr ≈ 1.131 T`,
        `g_m = 0.043 − 0.038 = 0.005`, `g = 0.047 − 0.043 = 0.004` →
        `BPeak ≈ Br · 0.005 / 0.009 ≈ 0.628 T`.
      - `roundRotorWoundConfig() → config`: 4-pole, single rotor I ring
        (smooth, `teeth: 1`, `rRange: [0.030, 0.043]`, `muR: 1000`), single
        stator W ring (`m=3, p=4, Q=12, coilPitch=3, turns=40`,
        `rRange: [0.047, 0.055]`, `slotFraction: 0.5`, `muR: 1000`). Three
        `circuits` (AC mode), unchanged from `pmsm.js` style. Adds
        `roundRotorExpectedLPhase()` returning the analytic per-phase
        magnetizing inductance
        `L_phase = (4/π) · μ0 · N² · (kw)² · R · ℓ / ((poles/2)² · g)` where
        `N = turns·Q/m = 40·12/3 = 160` ampere-conductors per phase,
        `kw ≈ 0.933` (full-pitch distributed winding factor — fixed numeric
        constant, see comment),
        `R = (0.043+0.047)/2 = 0.045`, `ℓ = 0.10`, `poles = 4`, `g = 0.004` →
        `L_phase ≈ μ0 · 160² · 0.933² · 0.045 · 0.10 / (4 · 0.004) ≈ 7.85e-3 H`.
        The expected-value computation is in the helper, NOT in each test
        body, so the test reads `expected = roundRotorExpectedLPhase()`.
      - `saturatedPmConfig() → config`: 4-pole, single rotor M ring (4
        magnets, `Mr = 1.4e6`, `Bknee: 1.2`, `backIron: true`,
        `backIronRRange: [0.030, 0.038]`, `rRange: [0.038, 0.043]`,
        `muR: 1000`), single stator W ring (`m=3, p=4, Q=12, coilPitch=2,
        turns=40`, `rRange: [0.047, 0.055]`, `slotRRange: [0.047, 0.055]`,
        `slotFraction: 0.5`, `ironRRange: [0.051, 0.055]`, `Bknee: 1.2`,
        `muR: 1000`). Three AC circuits (`R: 0.5`, `electronic-sine`).
        `grid: { Nr: 12, Ntheta: 256, rInner: 0.030, rOuter: 0.055, ell: 0.10 }`,
        `mechanical`, `stack`, `poles=4` from `pmsm.js`. Lowering both
        Bknees to 1.2 T forces local back-iron saturation under the
        heavier 1.4e6 magnets — the regime the old global-ceiling engine
        failed on.

    - **`meshArkkioTorque(solveResult, opts) → number`**:
      ```
      opts = { r_mr, r_ms, ell, mu0 = 4*Math.PI*1e-7,
               airMaterialKind = "air" }
      ```
      Reads `solveResult.field.stator` = `{ mesh: BodyMesh, Anode,
      Belem: { mag, Bx, By } }`. Iterates stator elements `e`. For each
      element:
      1. Read its material: `mat = mesh.materials[mesh.matId[e]]`. If
         `mat.kind !== airMaterialKind`, skip.
      2. Compute element centroid `(x_c, y_c)` (mean of `mesh.elems[4·e
         + 0..3]` x/y for Q4, or 0..2 for tri — detect via
         `mesh.elems[4·e + 3] === -1` per the Phase-2 contract).
      3. `r_c = hypot(x_c, y_c)`. If `r_c < r_mr` or `r_c > r_ms`, skip
         (only air-collar / gap-band elements participate).
      4. `θ_c = atan2(y_c, x_c)`.
      5. `B_r = Bx[e]·cos θ_c + By[e]·sin θ_c`,
         `B_t = −Bx[e]·sin θ_c + By[e]·cos θ_c`.
      6. Element area via shoelace over the 3 or 4 nodes.
      7. Accumulate `Σ += B_r · B_t · r_c · area`.

      Return `T = ell / (mu0 · (r_ms − r_mr)) · Σ`. (Volume Arkkio with
      the unmeshed-gap thickness as the radial-band normaliser.) Sign
      convention matches `slice.solve(...).torque` (positive = CCW about
      the axis).

    - **Module exports**: re-exports everything imported from `P` / `M` /
      `_assert.js`, plus `slotlessPmConfig`, `slotlessExpectedBPeak`,
      `roundRotorWoundConfig`, `roundRotorExpectedLPhase`,
      `saturatedPmConfig`, `meshArkkioTorque`, `gapPeakB(solveResult,
      r_band) → number` (a small utility reading the maximum
      `Belem.mag[e]` over elements with centroid radius in a thin band
      `r_band ± 1e-4`), and `coggingAmpAt(slice, polesNum, slotsNum, N) →
      number` (sweeps `N` angles spanning one cogging period
      `2π/LCM(slots,poles)` and returns `max−min` of `slice.coggingTorque(θ)`).

  - `tests/fea-engine/convergence.test.js`:
    - `node:test` + `node:assert/strict`.
    - `before(async () => { await initSolver(); })`.
    - **`"loaded torque is Richardson-convergent under mesh refinement"`** —
      `cfg = byId["pmsm"].config`, `currents = new Float64Array([20, -10,
      -10])`, `θ = 0.2`. Build three slices via
      `LIB.MotorStack.create(CS.expand(cfg), feaOpts({ mesh: { refine: r } }))`
      for `r ∈ {1.0, Math.SQRT2, 2.0}`. Capture
      `T_r = stack.solve(0.2, currents).torque`. Assert
      `|T_sqrt2 − T_1| / max(|T_sqrt2|, |T_1|) < 0.01` and
      `|T_2 − T_sqrt2| / max(|T_2|, |T_sqrt2|) < 0.01`.
    - **`"cogging amplitude is Richardson-convergent under refinement"`** —
      same three refinement levels. `coggingAmp_r =
      coggingAmpAt(slice_r, poles=4, slots=12, N=8)`. Assert
      `|coggingAmp_sqrt2 − coggingAmp_1| / coggingAmp_sqrt2 < 0.02` and
      `|coggingAmp_2 − coggingAmp_sqrt2| / coggingAmp_sqrt2 < 0.02`.
    - **`"mesh DOF count grows monotonically with refine"`** — assert
      `slice_1.__internals.globalLayout.n <
       slice_sqrt2.__internals.globalLayout.n <
       slice_2.__internals.globalLayout.n` (sanity that refinement
       actually refines).

  - `tests/fea-engine/analytic.test.js`:
    - `node:test` + `node:assert/strict`. `before(async () => { await initSolver(); })`.
    - **`"slotless PM peak flux linkage matches analytic closed form within 3%"`** —
      Build a slotless 4-pole PM machine with one stator wound coil so a
      flux linkage exists: extend `slotlessPmConfig()` to add a single `W`
      stator ring (`m=1, p=4, Q=1, coilPitch=1, turns=N_turns=20`) so the
      slotless gap field generates a flux linkage on a known circuit.
      Sweep `N = 32` mechanical angles over one electrical period `π` (4-pole).
      For each θ_n call `coeffs = stack.extractCoeffs(θ_n)`; record
      `λ_n = coeffs.lambdaPm[0]`. Closed form (slotless PM, square-wave
      rotor magnetization fundamental):
      `λ_peak_analytic = (4/π) · N_turns · ell · R_mid · slotlessExpectedBPeak()`
      where `R_mid = (r_mr + r_ms) / 2` (read from
      `slice.__internals.bodies.{rotor,stator}.gapR`). Assert
      `Math.abs(Math.max(...λ_n) - λ_peak_analytic) / λ_peak_analytic < 0.03`
      (3% — same bar as the slotless gap-peak `|B|` test; the wound
      flux-linkage measurement is one analytic step downstream of `|B|`,
      so 3% is the consistent bar). This validates the FEA-computed
      flux-linkage against physics (not against itself).

      The `extractCoeffs` self-consistency (numeric central difference of
      `lambdaPm` ↔ `dLambdaPmdth`) is already covered by the
      `tests/slice/extract.test.js::"dLdth from extract matches
      central-difference of L"` test (Phase 5 T5.3.1); it does not need a
      duplicate here.
    - **`"slotless gap peak |B| matches Br·g_m/(g_m+g) within 3%"`** —
      `cfg = slotlessPmConfig()`. `slice =
      LIB.MotorSlice.create(CS.expand(cfg).slices[0].section,
      feaOpts({ poles: cfg.poles, saturation: { enabled: false } }))`.
      Solve at `θ = 0` with zero currents (`new Float64Array([])` — no
      circuits). Read `B_peak_meshed = gapPeakB(solveResult, r_band =
      (r_mr + r_ms) / 2)` where `r_mr = slice.__internals.bodies.rotor.gapR`
      and `r_ms = slice.__internals.bodies.stator.gapR`. Compute
      `B_peak_analytic = slotlessExpectedBPeak()`. Assert
      `Math.abs(B_peak_meshed − B_peak_analytic) / B_peak_analytic < 0.03`.
    - **`"round-rotor linear inductance matches closed-form within 3%"`** —
      `cfg = roundRotorWoundConfig()`. `stack = LIB.MotorStack.create(
      CS.expand(cfg), feaOpts({ saturation: { enabled: false } }))`.
      At `θ = 0` and `θ = 0.3`, call `extractCoeffs` and read
      `L_self_θ = coeffs.L[0]` (m=3 → `L[i·3+j]`, take `L[0]` = phase-A
      self). Assert `|L_self_0.3 − L_self_0| / L_self_0 < 0.01` (round
      rotor: L is θ-independent within FEA noise). Compare
      `L_phase_meshed = L_self_0` to `L_phase_analytic =
      roundRotorExpectedLPhase()`. Assert
      `Math.abs(L_phase_meshed − L_phase_analytic) / L_phase_analytic < 0.03`.

  - `tests/fea-engine/cross-method.test.js`:
    - `node:test` + `node:assert/strict`. `before(async () => { await initSolver(); })`.
    - **`"pmsm: harmonic vs mesh-Arkkio vs co-energy agree within 2%"`** —
      `cfg = byId["pmsm"].config`, `stack = LIB.MotorStack.create(
      CS.expand(cfg), feaOpts({ saturation: { enabled: false } }))`.
      `θ = 0.2`, `currents = new Float64Array([20, -10, -10])`.
      `r = stack.solve(θ, currents)` — `T_harmonic = r.torque`. Then
      `slice = LIB.MotorStack.create(...).sliceMesh(0)`... actually no,
      grab the slice via `stackInternal = stack.slices[0]` if exposed, or
      via a single-slice helper: build `slice =
      LIB.MotorSlice.create(CS.expand(cfg).slices[0].section,
      feaOpts({ poles: cfg.poles, saturation: { enabled: false } }))`,
      `solveRes = slice.solve(θ, currents)`. `T_harmonic = solveRes.torque`.
      `T_arkkio = meshArkkioTorque(solveRes, { r_mr: slice.__internals.bodies.rotor.gapR,
      r_ms: slice.__internals.bodies.stator.gapR, ell: cfg.grid.ell })`.
      `T_coe = stack.coenergyTorque(θ, currents).total`. Define
      `T_max = Math.max(|T_harmonic|, |T_arkkio|, |T_coe|)`. Assert
      `Math.abs(T_harmonic − T_arkkio) / T_max < 0.02`,
      `Math.abs(T_harmonic − T_coe) / T_max < 0.02`,
      `Math.abs(T_arkkio − T_coe) / T_max < 0.02`.
    - **`"salient: three-way torque consistency at loaded point"`** — same
      pattern with `cfg = salientConfig()` (the 1-circuit
      pipeline-helper config), `θ = 0.3`, `currents = new Float64Array([10])`.
      Same three pairwise asserts.

  - `tests/fea-engine/known-machine.test.js`:
    - `node:test` + `node:assert/strict`. `before(async () => { await initSolver(); })`.
    - **`"synchronous-reluctance L(θ) fits L0+L2·cos2θe with r² ≥ 0.99"`** —
      `cfg = byId["synchronous-reluctance"].config`, `poles = cfg.poles =
      4`. `stack = LIB.MotorStack.create(CS.expand(cfg), feaOpts({
      saturation: { enabled: false } }))`. Sweep `N = 48` angles spanning
      one electrical period `2π / (poles/2) = π`. `Ls =
      sweepInductance(stack, thetas, 0)` (phase-A self). `thetasE =
      thetas.map(t => (poles/2)·t)`. `fit = fitCos2(thetasE, Ls)`. Assert
      `fit.r2 >= 0.99` and `Math.abs(fit.L2) > 1e-9`.
    - **`"synchronous-reluctance reluctance torque follows
      T = −i²·L2·sin(2θe) within 5%"`** — Same `cfg` linear stack. At
      `θ = π/(2·(poles/2))/4 = π/16` (mid-aligned-to-unaligned),
      `currents = new Float64Array([12])`. `T_meshed = stack.solve(θ,
      currents).torque`. `L2 = fitCos2(...).L2` from the prior test
      (re-run inline if needed). `i = 12`, `θe = (poles/2)·θ = 2·π/16 =
      π/8`. `T_expected = −i² · L2 · Math.sin(2·θe)`. Assert
      `|T_meshed − T_expected| / Math.max(|T_meshed|, |T_expected|) < 0.05`.
    - **`"vr-stepper reluctance torque ∝ i² ratio 4.0 ± 0.2 below knee"`** —
      `cfg = byId["vr-stepper"].config`, `stackLin = LIB.MotorStack.create(
      CS.expand(cfg), feaOpts({ saturation: { enabled: false } }))`.
      `T1 = stackLin.solve(0.3, new Float64Array([8, 0, 0])).torque`,
      `T2 = stackLin.solve(0.3, new Float64Array([16, 0, 0])).torque`.
      `ratio = T2 / T1`. Assert `|ratio − 4| <= 0.2`.
    - **`"pmsm cogging period equals LCM(slots, poles) cycles per rev"`** —
      `cfg = byId["pmsm"].config`. `stack = LIB.MotorStack.create(
      CS.expand(cfg), feaOpts())`. Sweep `N = 128` angles spanning a full
      mechanical revolution. `dts = sweepTorque(stack, new
      Float64Array([0, 0, 0]), thetas)`. `slots = 12, poles = 4`,
      `lcm = 12` cycles per rev → expected `signChanges(dts) ≈ 2·LCM = 24`.
      Assert `signChanges(dts) >= 2·lcm − 2 && signChanges(dts) <= 2·lcm + 2`
      (sampling tolerance — two crossings per period of detent).
    - **`"pm-stepper cogging period equals LCM(slots, poles) cycles per rev"`** —
      `cfg = byId["pm-stepper"].config`, `slots = 8`, `poles = 4`, `lcm = 8`.
      Same bound assertion `signChanges(dts) ∈ [2·lcm − 2, 2·lcm + 2]`.
    - **`"|λpm| < 1e-9 for every non-PM machine"`** — for each `id` in
      `["synchronous-reluctance", "vr-stepper", "switched-reluctance",
      "brushed-dc-wound"]`, build the stack, call `extractCoeffs(0.3)`.
      For every `k`, assert `Math.abs(coeffs.lambdaPm[k]) < 1e-9` AND
      `Math.abs(coeffs.dLambdaPmdth[k]) < 1e-9` (strict zero-not-skip,
      §11.1#2).

- **Files to modify**: none.

- **Tests**: (covered above as the test bodies themselves; no additional
  test files.)

- **Acceptance criteria**:
  - All five new files load and pass under `node --test
    tests/fea-engine/convergence.test.js tests/fea-engine/analytic.test.js
    tests/fea-engine/cross-method.test.js tests/fea-engine/known-machine.test.js`.
  - Every test uses `LIB.MotorStack` / `LIB.MotorSlice` via `CS.expand` —
    zero grid references (no `LIB.AirgapGrid`, `LIB.AirgapSolve`,
    `LIB.MotorCompile`, `drawGapField`); validated by the Phase-8 sweep.
  - The hand-built configs (`slotlessPmConfig`, `roundRotorWoundConfig`,
    `saturatedPmConfig`) validate under `CS.validate(cfg).ok === true`.
  - `meshArkkioTorque` returns a finite number for the `pmsm` operating
    point and agrees with `solveResult.torque` within 2 % at the
    cross-method test bar.
  - No file in `tests/fea-engine/` contains a machine name, machine-type
    enum, or machine-identity branch in code (binding §11.1#1) — fixture
    *ids* like `"pmsm"` are referenced as registry keys and as analytic-test
    inputs (`byId["pmsm"]`), which the agnosticism audit's
    fixture-loading allow-list already permits.

---

### Task T7.1.2: Re-point the 15 machine-fixture tests onto the FEA slice

- **Description**: Mechanical-edit task. The 15 `tests/machines/*.test.js`
  bodies' physics assertions are kept verbatim; only their imports and a few
  `LIB.MotorStack.create` opts arguments change to match Phase 0's relocation
  of helpers + Phase 5's `ceiling → saturation` opts vocabulary. Plus the
  WFS self-start un-skip (the one Phase-3-CURRENT-dependent assertion) and
  stripping stale `Phase-N` / `Wave-N` references from comments and the
  shared `"expands to Phase-2 sections..."` test name. Implemented as a
  scripted edit (Node script using `pathlib`-equivalent + `string.replace`),
  NOT hand-edits.

- **Affected references (authoritative — enumerated by author 2026-05-27)**:

  *Import re-point (4 occurrences — flip `require("../engine/_fixtures.js")` →
  `require("../_assert.js")` for `fitCos2`/`fitCos2Cos4` consumers):*
  - `tests/machines/_fixtures.js:22` —
    `const fitCos2    = require("../engine/_fixtures.js").fitCos2;`
  - `tests/machines/synchronous-reluctance.test.js:9` —
    `const { fitCos2Cos4 } = require("../engine/_fixtures.js");`
  - `tests/machines/switched-reluctance.test.js:9` —
    `const { fitCos2Cos4 } = require("../engine/_fixtures.js");`
  - `tests/machines/vr-stepper.test.js:9` —
    `const { fitCos2Cos4 } = require("../engine/_fixtures.js");`

  *Opts-key flip (3 occurrences — `ceiling:{enabled:false}` →
  `saturation:{enabled:false}`):*
  - `tests/machines/_fixtures.js:170` (inside `crossCheck`) —
    `var stackLin = LIB.MotorStack.create(stack.expanded, { ceiling: { enabled: false } });`
  - `tests/machines/switched-reluctance.test.js:64` —
    `const stackLin = LIB.MotorStack.create(expanded, { ceiling: { enabled: false } });`
  - `tests/machines/vr-stepper.test.js:59` —
    `const stackLin = LIB.MotorStack.create(expanded, { ceiling: { enabled: false } });`

  *Stale `Phase-N` / `Wave-N` comment scrubs (5 lines in 2 files):*
  - `tests/machines/_fixtures.js:4` —
    `//  Shared loader and measurement helpers for Phase-6 machine validation tests.`
    → `//  Shared loader and measurement helpers for machine validation tests.`
  - `tests/machines/_fixtures.js:5` —
    `//  Not a test file — no .test.js suffix. Required by Wave-6.3 test files.`
    → `//  Not a test file — no .test.js suffix. Required by the machine test files.`
  - `tests/machines/_fixtures.js:7` —
    `//  Loads the Phase-5 pipeline loader (read-only), which installs window + all`
    → `//  Loads the pipeline loader (read-only), which installs window + all`
  - `tests/machines/_fixtures.js:16` —
    `// Phase-5 pipeline loader — installs window + engine/pipeline libs.`
    → `// Pipeline loader — installs window + engine/pipeline libs.`
  - `tests/machines/switched-reluctance.test.js:89` —
    `// differential is a Phase-9 acceptance; this file checks only the linear`
    → `// differential is a saturated-cogging acceptance; this file checks only the linear`

  *WFS self-start un-skip (1 file, multi-line block):*
  - `tests/machines/wound-field-synchronous.test.js:33-50` — delete lines
    33–42 (the deferred-explanation block-comment), and on the remaining
    `test(...)` invocation at lines 43–50 delete the
    `, skip: "excitation model has no current-source (field-regulator)
    terminal; the voltage-fed field line-starts — deferred per user, see
    progress.md"` substring inside the second-arg object. Result:
    ```
    test("does not self-start from rest on AC-none",
      { timeout: TIMEOUT },
      function () {
        const { runtime } = build("wound-field-synchronous");
        const state = runFromRest(runtime, 150);
        assert.ok(Math.abs(state.theta) < 1e-3,
          `theta=${state.theta} >= 1e-3 (unexpectedly self-started)`);
      });
    ```
    (The test body — `runFromRest(runtime, 150)` + the `assert.ok` line — is
    byte-identical to before.)

- **Dry-run requirement (compulsory)**:
  The implementer's first step is `node scripts/phase7-repoint.mjs
  --dry-run` (the script it writes — see "Implementation method" below)
  which prints every intended change as `file:line | before | after`.
  The dry-run output is compared against the "Affected references"
  enumeration above. If the dry-run reports more, fewer, or different
  locations than the author enumerated (12 single-line edits + 1
  multi-line WFS block — 4 import flips + 3 opt-key flips + 5
  comment-line scrubs + the WFS un-skip block), the task FAILS and the
  implementer takes a Clarification Exit. No edits are applied until the
  dry-run matches exactly.

- **Encoding controls (mandatory)**:
  - All reads/writes UTF-8, no BOM.
  - No encoding conversion mid-edit; if any file reads as not-UTF-8, raise
    a Clarification Exit (do not silently re-encode).
  - Post-edit smoke check: grep for `�` and the common mojibake
    sequences (`â€™`, `â€œ`, `â€`, `Ã©`, `Ã¨`, `Ã `) across every modified
    file; any hit → task FAILS.
  - Line endings preserved per-file (no CRLF↔LF conversion as a side
    effect).

- **Implementation method (mandatory)**:
  A short Node script under `scripts/phase7-repoint.mjs` (committed
  alongside the edits, NOT deleted after — Phase 8's audit re-runs it as a
  consistency check). The script:
  1. Reads each enumerated file as `fs.readFileSync(path, "utf8")`.
  2. Applies the listed `str.replace(literalBefore, literalAfter)`
     substitutions. Literal-string replacement only; no regex.
  3. For the WFS multi-line block: read the file, locate the
     `// DEFERRED (user decision 2026-05-25): a true synchronous machine`
     anchor and the closing `…progress.md"\n` marker, slice them out, then
     `replace(", skip: \"excitation model has no current-source…\"", "")`.
  4. With `--dry-run`, print `file:line | before | after` for every
     intended change and exit without writing.
  5. Without `--dry-run`, write the modified content via
     `fs.writeFileSync(path, content, "utf8")`.

  Script header documents the change list as a literal data structure so
  the diff matches "Affected references" exactly.

- **Files to create**:
  - `scripts/phase7-repoint.mjs` — the scripted edit driver.

- **Files to modify**: (5 files; see "Affected references" above)
  - `tests/machines/_fixtures.js`
  - `tests/machines/synchronous-reluctance.test.js`
  - `tests/machines/switched-reluctance.test.js`
  - `tests/machines/vr-stepper.test.js`
  - `tests/machines/wound-field-synchronous.test.js`

- **Tests**:
  - The 15 existing `tests/machines/*.test.js` files. After re-point, every
    test green under `node --test tests/machines/` — including the
    now-unskipped `"does not self-start from rest on AC-none"` on
    `wound-field-synchronous` (asserts `Math.abs(state.theta) < 1e-3`
    after 150 steps; Phase 3's `CURRENT amp:12` field current pins the
    field, no induction damper, no line start). All 15 test files keep
    every assertion body byte-identical except for the WFS un-skip; the
    test-name strings (incl. `"expands to Phase-2 sections..."`) and
    every other comment stay as-is. The machine-tests' acceptance is
    "the same physics passes under the new engine".
  - **If any single test exceeds its existing `{ timeout: 25000 }` /
    `TIMEOUT = 25000` under FEA wall-clock**, the implementer takes a
    Clarification Exit — does NOT widen the timeout silently. Document
    the test name, the measured wall-clock, and the slice DOF.

- **Acceptance criteria**:
  - Dry-run output matched "Affected references" exactly: 12 enumerated
    single-line edits + the WFS multi-line block (no extras, no misses).
  - Mojibake smoke check passed (no `�`, no Latin-1-as-UTF-8
    sequences in any modified file).
  - `node --test tests/machines/` green across all 15 files.
  - The `"does not self-start from rest on AC-none"` test on
    `wound-field-synchronous` runs (no `skip:`) and asserts
    `Math.abs(state.theta) < 1e-3` successfully — first end-to-end
    exercise of Phase 3's `CURRENT` terminal through the rebuilt
    `MotorRun` → `MotorStack` → `MotorSlice` chain.
  - `tests/machines/_fixtures.js`'s `crossCheck` uses
    `saturation: { enabled: false }` (not `ceiling`).
  - No surviving `tests/machines/*.{js,test.js}` file contains the
    substring `engine/_fixtures` (Phase 0 deleted that directory).
  - No surviving `tests/machines/*.{js,test.js}` file contains a
    `Phase-N` reference in a code COMMENT (the five enumerated comment
    scrubs remove every comment-level occurrence). The shared
    `"expands to Phase-2 sections..."` test-name string and all `FIX N`
    work-tracking comments are deliberately left untouched.
  - All listed tests pass.

---

## Wave 7.2: Headline — saturated cogging Richardson convergence

### Task T7.2.1: Saturated cogging amplitude grid-convergent to < 5 %

- **Description**: The proof of the rebuild. Build `saturatedPmConfig`
  (D4 — designed to drive explicit local back-iron saturation under the
  rebuilt local-Brauer Newton). At three Richardson refinement levels
  `refine ∈ {1, √2, 2}`, sweep `coggingTorque(θ)` over one cogging
  period (`2π / LCM(slots, poles) = 2π/12 = π/6`) at `N = 8` angles per
  level, compute amplitude `peak − valley`. Assert successive deltas
  satisfy < 5 % (the §11.3 headline). Then identify the
  most-saturated angle (argmax `|coggingTorque(θ)|`) at the finest
  level, re-solve there with a small balanced 3-phase load to maximise
  iron flux, and assert the §11.3 Newton numeric guards: iters ≤ 8,
  `‖ΔA‖∞/(‖A‖∞ + ε) < 1e-6`, `‖K·A − f‖∞/(‖f‖∞ + ε) < 1e-9`.

- **Files to create**:
  - `tests/fea-engine/saturated-cogging.test.js` — `node:test` +
    `node:assert/strict`. `before(async () => { await initSolver(); })`.

- **Files to modify**: none.

- **Tests**:
  - **`"saturated cogging amplitude is Richardson-convergent to < 5%"`** —
    `cfg = saturatedPmConfig()`. Build three stacks via
    `LIB.MotorStack.create(CS.expand(cfg), feaOpts({ saturation:
    { enabled: true }, mesh: { refine: r } }))` for `r ∈ {1.0,
    Math.SQRT2, 2.0}`. For each, `amp_r = coggingAmpAt(stack.slices[0],
    poles=4, slots=12, N=8)`. Assert:
    - `amp_1 > 1e-4` (the test is meaningful — cogging is present).
    - `Math.abs(amp_sqrt2 − amp_1) / amp_sqrt2 < 0.05`.
    - `Math.abs(amp_2 − amp_sqrt2) / amp_sqrt2 < 0.05`.
  - **`"Newton guards hold at the most-saturated cogging angle"`** — At
    `refine = 2.0`, sweep `N = 32` angles over one cogging period to find
    `θ* = argmax_n |coggingTorque(θ_n)|`. Build a fresh slice at the same
    refinement (`slice = LIB.MotorSlice.create(CS.expand(cfg).slices[0].section,
    feaOpts({ poles: cfg.poles, saturation: { enabled: true },
    mesh: { refine: 2.0 } }))`); `currents = new Float64Array([5, -2.5,
    -2.5])` (modest balanced 3-phase load — pushes iron flux higher).
    `slice.clearWarmStart()`. Solve `slice.solve(θ*, currents)`. Then
    inspect `slice.__internals.lastNewton` (Phase 5 exposes the last
    Newton result on its internals hatch): assert
    `lastNewton.iters <= 8`,
    `lastNewton.deltaNorm < 1e-6`,
    `lastNewton.residual < 1e-9`.

- **Acceptance criteria**:
  - `tests/fea-engine/saturated-cogging.test.js` passes under
    `node --test`.
  - Saturated cogging amplitude convergence holds: both successive
    Richardson deltas < 5 %.
  - Newton numeric guards (§11.3) hold at the cogging-peak angle under
    the loaded 3-phase current vector: iters ≤ 8, ΔA-norm < 1e-6,
    residual < 1e-9.
  - `saturatedPmConfig()` validates under `CS.validate(cfg).ok === true`.

---

## Phase-exit verification (whole-phase)

- `node --test tests/fea-engine/ tests/machines/` runs **green** —
  zero failing or erroring test files.
- The full `node --test` suite, run from the repo root, runs green
  (incorporating Phase 0/1/2/3/4/5/6's surviving tests plus the new
  Phase 7 set).
- Repo-wide grep for `LIB.AirgapGrid|LIB.AirgapSolve|LIB.AirgapTorque|LIB.AirgapRefine|LIB.AirgapWorker|LIB.MotorCompile|drawGapField`
  finds **zero hits** under `tests/fea-engine/` or `tests/machines/`.
- Repo-wide grep for `engine/_fixtures` finds **zero hits** under
  `tests/fea-engine/` or `tests/machines/` (the directory was deleted in
  Phase 0).
- Repo-wide grep for `Phase-\d` (case-sensitive) under `tests/machines/`
  finds hits **only** in the shared `test("expands to Phase-2 sections
  with matching circuit count", ...)` test-name string (15 occurrences,
  one per machine test file — kept by design per D7). No comment-level
  `Phase-N` references survive.
- The WFS `"does not self-start from rest on AC-none"` test runs (no
  `skip:`) and passes.
- The headline saturated-cogging Richardson-convergence assertion
  (< 5 %) passes under `node --test
  tests/fea-engine/saturated-cogging.test.js`.

## Out of Scope (Phase 7)

- Any change to `lib/*` source files. Every engine-tier change has
  landed in Phases 1–5; Phase 7 is purely test-suite work.
- Any change to `lessons/unified_motor/*.js`. Phase 6 owns the live-UI
  rebuild (mesh-native render + machine picker + geometry sliders) and
  runs in parallel with Phase 7.
- The repo-wide grid-reference sweep + the agnosticism-audit allow-list
  update — Phase 8 owns those (this phase ships its own clean files but
  does not audit other phases' output).
- The Phase 5 D1 `embed-vs-Schur` escalation gate / `§9-G5` Schur
  build — Phase 5 owns that diagnostic; Phase 7 does not re-measure or
  re-trip it.
- Stale `FIX N` comments in `tests/machines/*.test.js`. The user
  limited the stale-reference scrub to "phase"; `FIX N` references are
  left in place.
- New analytic references beyond the four enumerated (no-load back-EMF,
  slotless gap, round-rotor inductance, cross-method). Adding more
  references is a future scope decision, not Phase 7.

## Amendments (2026-05-27)

- **Back-EMF analytic test (missing from spec body, present in overview).**
  Add `tests/fea-engine/back-emf.test.js`: at a slotless surface-magnet
  PMSM, the no-load phase back-EMF amplitude is
  `Ê = N·kw·B_g·R·ℓ·ω_e` where `B_g` is the analytic peak gap flux
  density and `ω_e` is electrical angular frequency. Compare the
  FEA-derived `dλ_pm/dθ · ω` at ω = 314 rad/s (50 Hz electrical for a
  4-pole at 1500 rpm) against the analytic `Ê` to within 1%. This closes
  the deferred-from-Phase-5 back-EMF criterion that the project's
  overall verification list calls for but the existing spec body omits.

- **`kw ≈ 0.933` derivation.** The full-pitch distributed-winding factor
  for a 3-phase integer-slot machine with `q = 2` slots per pole per
  phase is `kw = kp · kd` where: pitch factor `kp = sin(π·coilPitch/(Q/p))
  = sin(π/2) = 1.0` for full pitch; distribution factor
  `kd = sin(q·α/2) / (q·sin(α/2))` with `α = π/(q·m) = π/6` for q=2, m=3
  giving `kd = sin(π/6)/(2·sin(π/12)) = 0.5/(2·0.2588) ≈ 0.9659`. For the
  PMSM fixture (8p/48s/m=3, q = 48/(8·3) = 2), `kw = 1.0 · 0.9659 ≈ 0.966`,
  not 0.933 as the test currently asserts. **Action:** correct the test's
  hardcoded `kw` to `0.9659` (or compute it from the fixture's winding
  spec via `LIB.WindingModel.windingFactor(routing)`, exposed in Phase 7
  as a small helper). The 0.933 in the current spec body is a magic
  number traceable to a different (q=1) winding choice and must be
  derived from the actual fixture rather than copied.

- **`3%` analytic-tolerance bar — discretization-error basis.** Linear
  triangular/quad elements have `O(h^2)` field-error convergence. For the
  PMSM fixture at default `refine=1`, the mesh has roughly N=5000-10000
  nodes per body; `h ≈ √(annulus_area / N) ≈ 1 mm` on the 60 mm radius.
  Theoretical `O(h^2)` error at 1 mm ≈ `(1mm/60mm)² ≈ 3e-4`, well below
  3%. The 3% bar therefore allows for: (a) practical constant-multiplier
  loss vs. theoretical (typical 10–100× over `O(h^2)` ideal at default
  mesh), and (b) cross-method comparison error since the "analytic"
  reference itself uses a magnetic-circuit approximation that ignores
  fringing and back-iron leakage (≈1–2% intrinsic error). 3% is the
  order-of-magnitude floor for cross-method agreement at production mesh
  density and is justified — not asserted.
