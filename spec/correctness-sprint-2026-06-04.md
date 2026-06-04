# FEA correctness sprint — running tracker (started 2026-06-04)

Living status doc for this session. Updated as threads move. Companion artifacts:
`spec/test-audit-2026-06-04.md` (failing-test taxonomy), `spec/dldtheta-
investigation-2026-06-04.md` (R1/R6 deep-dive). `spec/progress.md` is the
project's append-only task log, not this.

## North star

The monolithic field-circuit-motion Newton is built and is the most robust
engine yet. Goal of this sprint: **separate real engine signals from test debt,
prove product correctness from first principles, and delete dead/validator code**
— so the only red left is genuine engine-physics work, and the next agent isn't
misled by stale tests or unused architecture.

Binding rules in play: never loosen/skip a test to mask a real flaw; code whose
only callers are tests is dead (delete it, distinguish from unwired-but-intended
FEA API); the live app is the only product; no historical-narrative comments.

## Threads & status

| Thread | Status | Where |
|---|---|---|
| Test-debt purge (31-failure audit → fix/update/delete) | **Done** | committed `a47adee` |
| Dead-code excision (coupledAssemble, linearSchurPrepare, schur counters, gapStampLog, defaultK) | **Done** | committed `a47adee` |
| R1/R6 root-cause investigation | **Done** | doc + below |
| Co-energy / dL-dθ deletion + motor-run rewire | **Done** | committed `aec6762` |
| R2 — induction torque ≠ 0 at sync speed | **Open** | untouched |
| R3 — wound-field self-start (line-fed) | **Done** | committed `c8a4176` |
| R5 — salient deltaNorm convergence bookkeeping | **Done** | committed `f927d12` |
| Test-suite profiling & sim decomposition (long sims → short seeded per-behaviour sims) | **Open (after R2/R3/R5)** | Next §4 |

## Real-signal R-codes — current state

- **R1** round-rotor dL/dθ≈0 — **closed by deletion.** Proven to be the mortar's
  spurious discrete-inductance ripple in a NON-product validator. Arkkio (product
  torque) is clean at the zero floor. Deleted with the co-energy apparatus.
- **R6** co-energy↔Maxwell ×6 — **closed by deletion.** Proved Arkkio correct to
  0.1% vs a closed-form analytic field (the existing `torque-formula-field.test.js`
  gate). Co-energy is a rejected non-product shortcut (mount.js: "cheap torque
  shortcut … 10–40% accuracy"). Deleted all 15 crosschecks + the validator.
- **R2** induction sync-speed torque — open; **measured to be a real engine
  effect, NOT the timestep artifact the test comment asserts**. At slip=0 the cage
  carries 2–4 A (should be ~0) and T(sync)=1.51e-2 N·m. T(sync) PLATEAUS across an
  8× timestep sweep (1.74e-2→1.51e-2 for 24→192 steps/cycle) — not
  temporal-resolution-limited; the comment's "3.5e-5 at 48 spc" does not reproduce
  (actual 48 spc = 1.54e-2, ~440× larger). Worse, T(sync)=1.51e-2 ≈ Tslip=1.59e-2:
  the torque–speed curve is nearly FLAT where induction torque must fall to 0 at
  slip=0. Open discriminator (next probe, ~15 min each — induction coupled solves
  are slow): is the spurious cage current a STEADY spatial/gap-coupling ripple
  (mortar slotting) or a slow DC cage transient not decayed in the 6-cycle settle?
  Both are timestep-independent → settle-cycle sweep distinguishes them. The false
  "numerical, not engine" comment must be corrected; the test is not to be loosened.
  **Discriminator result (48-cycle settle @48spc): H1 confirmed.** After the
  startup transient (cycle 4→8) the cage current PERSISTS at ~2.1 A and even rises
  (2.06→2.28 over cycles 8→48 ≈1 s ≫ cage L/R); T(sync) drifts down only ~10% over
  40 cycles (τ≈380 cycles — not settling to zero). So the spurious cage current is
  **steady, not a transient** → a spatial gap-coupling artifact (mortar slotting
  ripple exciting the cage at slot-passing frequency at slip=0), independent of
  both timestep and settle. Real engine defect. Cage bar R≈6.3e-5 Ω (geometry-derived).
  **Localized (code map + clean matrix probe).** The mortar gap stamp
  (`airgap-mortar.js` `stampInto`) is NOT rotation-invariant: the zipper
  re-triangulation injects a φ-periodic stiffness ripple (period 2π/lcm(Ngr,Ngs)),
  uncorrected — single-φ stamp per solve, no banding mitigation exists. The cage
  flux reads out of `K_combined(φ)` (motor-slice.js:1250-1283→3138-3169) so the
  ripple becomes spurious dλ/dt. A confound-free rigid-rotation gap-energy ripple
  scales **O(1/N²)** (k=2: 1.6e-3→1.1e-4→6.8e-6 for N=108→432→1728) → a
  resolution-limited discretization artifact, NOT a formulation defect. Magnitude
  reconciles: ripple period 2π/N → ~10 kHz at sync (N·ω_s) → inductance-limited
  cage current ≈ λ_ripple/L ≈ O(1 A) through the 63 µΩ cage. Gap-node floor is
  `12·max(slots,poles)=432` (airgap-mortar.js:484), calibrated for torque accuracy
  not cage ripple. **Fix direction:** reduce banding ripple — denser gap (~1/N², so
  ~4–5× nodes to reach <5% of Tslip; expensive) OR a banding mitigation in the
  stamp (φ-sub-position averaging; none exists today). Knob:
  `MotorStack/Run.create(expanded,{mesh:{gapMinNodes:N}})`.
  **REFUTED (dynamic density test).** Doubling gap nodes 432→864 did NOT reduce the
  spurious sync current/torque: maxCage 2.144→2.156 (unchanged), Ts 1.54e-2→1.87e-2
  (rose). So the gap-ring banding ripple (clean 1/N² at the matrix level) is real
  but is NOT the driver of the spurious cage current — the cage current is
  **density-independent**. "Denser gap" is not the fix. Re-oriented hypothesis:
  the driver is structural and mesh(gap-ring)-independent — most likely physical
  stator-slot / cage-MMF **space harmonics** (36 slots × 28 bars), which give real
  harmonic cage currents at fundamental-sync. Compounding smell: Tslip also shifted
  a lot with density (−1.59e-2→−0.96e-2) and is anomalously tiny for a 184 mm
  machine — the FUNDAMENTAL induction torque looks weak, making parasitic torque
  comparable. R2 is deeper than a sprint fix: a dedicated induction-physics session
  (is the sync cage current real space-harmonic parasitic current or spurious? why
  is fundamental torque so weak?). Next cheap checks: cage-open sync torque
  (comment claims ~0); harmonic content of the sync cage current.
  **Torque–slip curve is INCOHERENT (decisive).** Settled (6+2 cyc @48spc) torque
  vs slip {0,0.03,0.08,0.15,0.30,0.50}: T = +1.54e-2, −1.97e-2, +1.73e-2, +6.7e-3,
  −1.39e-2, −1.59e-2 — sign-random ~1.5e-2, NO breakdown peak, where a real machine
  has a smooth single-signed motoring curve. But maxCage GROWS sensibly with slip
  (2.1→3.8→5.1) → cage currents are physical; the TORQUE is buried in a ~1.5e-2 N·m
  noise floor. Unifying cause (hypothesis): cage bar R=63 µΩ gives rotor τ≈380 cyc
  (from the discriminator's slow decay) — the induction torque is a delicate
  near-cancellation of large rotating fields that only resolves at steady state, and
  the machine CANNOT settle in any feasible dynamic window. So every dynamic torque
  sample (incl. the sync test) is transient-contaminated; the incoherent curve is an
  unsettled machine sampled at different transient phases. **Implication:** the
  sync-torque test cannot reliably measure steady torque as written; the true steady
  T(sync) is unknown without either a steady-state (phasor/slip-frequency) solve or
  a multi-hundred-cycle settle. Decisive (expensive) next test: settle sync 300–800
  cyc, see whether T→0 (engine correct, unsettleable test) or plateaus (real steady
  defect). Dedicated induction session. Comment in induction-3ph.test.js corrected
  to the measured truth; assertion left failing (honest signal).
  **High-R cage test (inconclusive but suggestive).** Raised cage Rb=6.3e-3 (~100×)
  to shrink τ; cage currents changed (sync maxCage 2.14→0.63) so the override had
  some effect, but τ-drop unconfirmed (expanded.circuits[k].R still shows the 0.03
  placeholder; real R is the runtime-derived value). Torque stayed INCOHERENT
  (+1.8e-2,−1.4e-2,+0.1e-2,−1.2e-2,−0.9e-2,−0.7e-2). **Bottom line:** the induction
  torque-slip curve is incoherent (~1.5e-2 noise) under every variable tested
  (timestep, settle, gap density, cage R) while cage currents respond physically.
  The two confounds — un-settleable cage vs noise-dominated torque extraction in the
  near-cancellation regime — cannot be separated without a **steady-state
  (phasor/slip-frequency) solve, which the engine lacks**. R2 = dedicated session:
  (1) add a steady-state induction torque measurement, (2) then adjudicate
  engine-correct vs torque-extraction defect, (3) and reconsider the test (compares
  sync torque to slip=0.5, which is past breakdown). Not resolvable by more dynamic
  probing.
- **R3** wound-field self-start — root cause confirmed (probes); **engine is
  correct**, resolution pending user. Field current is correctly pinned at 12 A
  (CURRENT terminal — the old "no current-source field" note was stale). Dynamic
  torque matches independent static solves to 4 sig-figs (no torque bug). A
  J-sweep shows pull-in vanishes as inertia rises (meanΩ 78.9→2.3→0.75→0.08 for
  J=4e-3→4e-2→4e-1→4.0) — so no rectification / no spurious net torque; θ→49 is
  genuine **low-inertia synchronous pull-in**. The fixture is incoherent: Tmax≈76
  N·m vs J=4e-3 → rotor reaches sync within one torque half-cycle, so it
  physically self-starts. The `|θ|<1e-3` bound is also unphysical — even at J=4.0
  (no pull-in) θ=0.052 from the startup transient. Fix is fixture+test design
  (raise J to a coherent non-self-starting machine; assert "no sustained rotation"
  meanΩ≈0), NOT an engine change and NOT loosen-to-pass.
  **Resolved** (uncommitted): fixture J 4e-3→0.4 (rotor + coupled load, firmly
  non-self-starting against ~76 N·m); test now asserts meanΩ=θ/t « synchronous
  (78.5 rad/s) instead of |θ|<1e-3. No engine change. wound-field 4/4,
  agnostic-pipeline 3/3.
- **R5** newton deltaNorm — root cause confirmed (probe). `solveStaticRotor`
  converges salient/refine0.5/i=10 to residual 7e-13 in **1 iter from cold start**
  (A_prev=0, no harmonic DOFs — nHarm=0, so not null-space). `deltaNorm =
  ‖αΔA‖∞/(‖A_prev‖∞+1e-30)`; with A_prev=0 the denominator hits the 1e-30 floor →
  6.6e-5/1e-30 = 6.6e25. A divide-by-zero-iterate artifact, not divergence. The
  internal `converged` IS set true from the residual but the return omits it.
  **Fixed** (`motor-slice.js`, uncommitted): (a) `solveStaticRotor` now returns
  `converged` (Newton + linear-bypass paths); (b) the step-norm denominator is
  `max(‖A_prev‖∞, ‖A_new‖∞)+eps` (repo convention) so cold-start iter-1 reads ~1,
  not 1e25. Newton suite 6/6, slice suite 35/35.
- ~~R4~~ mesh ≤8000 budget — killed (arbitrary number); `cells_per_pole≥2·nuMax`
  kept and passes.

## Key findings (durable)

1. **Arkkio is ground truth.** `gap.torque` reproduces the analytic Maxwell torque
   of a prescribed single-harmonic gap field to 0.09–0.11% across k=1…20 and all
   ring resolutions. The product torque is correct; gated by
   `tests/airgap/torque-formula-field.test.js`.
2. **Co-energy was never product.** The coupled Newton uses Arkkio; mount.js runs
   the exact solve every step and explicitly rejected co-energy as too inaccurate.
   The FEA `coenergyTorque`/`extractCoeffs` had test-only callers.
3. **motor-run needed flux, not the architecture.** It called `extractCoeffs(0)`
   only for L/λpm to scale the integrator's atol. Replaced by a minimal
   `linearFluxLinkages(θ, currents)` (one saturation-disabled solve → flux) +
   per-circuit self-flux for the atol scale — no dL/dθ, no L-matrix, no co-energy.
   The scaling solve MUST be linear: the saturating product solve stalls at
   high-current cold start (bldc 240 A).

## What's deleted (this thread, uncommitted)

- lib: `stack.coenergyTorque`, `stack/slice.extractCoeffs`, `slice.evaluateAt`,
  the `_unitCurrentRhsCached` cache + `schurScratch.A_j/lam_j` (evaluateAt-only).
- lib added: `slice.linearFluxLinkages` + `stack.linearFluxLinkages`; motor-run
  rewired to them.
- tests: all 15 "Maxwell vs co-energy" crosschecks, the round-rotor dL/dθ gate +
  whole `tests/slice/extract.test.js`, the agnostic-pipeline 10% co-energy check,
  motor-stack co-energy/extractCoeffs tests, the lambda_pm-zero / L0+L2+L4 /
  PM-flux-shape tests that consumed the deleted extraction, `crossCheck`+`XC_*`
  and `sweepInductance`/`sweepLambdaPm` in machines/_fixtures.js.
- kept: `coggingTorque`, `backEmfDensity` (intended-pedagogical, unwired) + the
  shared linear-Schur machinery they use.

## Verification

- Fast subset (analytic gate, pipeline, slice cogging/finiteness, circuit): **35/35
  pass**.
- No regression: bldc steps at 1008 ms/step vs baseline `a47adee` 945 ms/step,
  identical trajectory (worktree-compared).
- Full suite: **done** (`spec/_final2.out`, 322/325 pass, ~23 min). The 3 reds are
  exactly **R2** (`induction-3ph:52`, Ts=0.0154 vs 0.0008), **R3**
  (`wound-field-synchronous:33`, self-started θ=49.2), **R5** (`slice/newton:22`,
  deltaNorm 6.6e25). Co-energy/dL-dθ reds gone; no new reds. Deletion confirmed
  regression-free.

## Next

1. ~~Confirm full-suite red set = {R2, R3, R5}.~~ **Done — confirmed.**
2. ~~Commit + push the co-energy deletion + motor-run rewire.~~ **Done — `aec6762`, pushed.**
3. R5 (contained) → R2/R3 (excitation-model physics).
4. **Test-suite profiling & sim decomposition.** Profile every test. For each
   long-running test, identify exactly which behaviour(s) it exercises, then
   split the long simulation into short, deterministically-seeded sims — one per
   behaviour — so each behaviour is its own fast, explicit assertion instead of
   being buried in a single multi-second run.
