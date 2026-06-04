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
| R3 — wound-field self-start (line-fed) | **Open** | untouched |
| R5 — salient deltaNorm convergence bookkeeping | **Done** (uncommitted) | `motor-slice.js` |
| Test-suite profiling & sim decomposition (long sims → short seeded per-behaviour sims) | **Open (after R2/R3/R5)** | Next §4 |

## Real-signal R-codes — current state

- **R1** round-rotor dL/dθ≈0 — **closed by deletion.** Proven to be the mortar's
  spurious discrete-inductance ripple in a NON-product validator. Arkkio (product
  torque) is clean at the zero floor. Deleted with the co-energy apparatus.
- **R6** co-energy↔Maxwell ×6 — **closed by deletion.** Proved Arkkio correct to
  0.1% vs a closed-form analytic field (the existing `torque-formula-field.test.js`
  gate). Co-energy is a rejected non-product shortcut (mount.js: "cheap torque
  shortcut … 10–40% accuracy"). Deleted all 15 crosschecks + the validator.
- **R2** induction sync-speed torque — open. Motional-EMF cancellation not closing
  (Ts≈0.015 vs target 7e-4).
- **R3** wound-field self-start — open. Excitation lacks a current-source field, so
  a line-fed synchronous machine self-starts when it shouldn't.
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
