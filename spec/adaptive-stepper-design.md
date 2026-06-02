# Adaptive multi-rate stepper + saturation handling — design basis

The runtime (`lib/motor-run.js` `step(dt)`) uses a **fixed dt**. For the
generator's user-built architectures at speed, that diverges. This document
records the investigation that established why, and the architecture it implies.

> Context rule: the app is a **generator** — all of parameter space is exercised,
> including deep saturation. Fixtures/stock machines are arbitrary feature-tests,
> never "normal operation". Findings below sweep the regime, not fixture defaults.

## Findings

### F1 — Coarse-dt divergence is Δθ-per-step coeff staleness, NOT circuit stiffness
The explicit motional EMF `e = ω·(dL/dθ)·i` is a *first-order-in-Δθ* extrapolation
of the θ-varying coeffs across a step. It breaks when the rotor moves too far per
step.
- Divergence onset measured at **Δθ = ω·dt ≈ 5–9° per step** (stable at 4.8°,
  diverged at 9.5°, at fixed dt=1/240). Scales with ω, independent of stiffness.
- Sub-stepping the circuit with **frozen** coeffs does **not** help (diverges at
  every K); re-fetching coeffs at the true θ per sub-step **does** (stable, matches
  the fine-dt reference).
- Exponential integrator is **ruled out** — it also freezes coeffs over the step.
- Implicit treatment of `ω·dL/dθ` is **worse** (indefinite motional term → system
  matrix goes indefinite once `dt·ωG > L_diff`; diverges even at fine dt).

### F2 — The coeff path is entirely linear
`extractCoeffs → evaluateAt → linearSchurSolve` (linear material ν). So `L`,
`dL/dθ`, `λpm`, `dλpm/dθ` are all linear. `coggingTorque → linearMagnetOnlySolve`
is linear too. **Saturation lives only in `stack.solve` (Arkkio, saturated
Newton).** Consequence: circuit currents, co-energy torque, AND detent are linear
regardless of operating point.

### F3 — Torque ripple that moves the rotor rolls off by ~150 Hz
The rotor inertia is a 1/f filter. Measured (induction, ω=120, J=3e-3): dominant
ripple 25–100 Hz (1–2% speed ripple), <0.1% above ~150 Hz; broadband slot floor
(~0.1 N·m out past 1.2 kHz) is inertia-crushed to negligible motion.
- **Field-solve (torque) cadence ≈ 300–500 Hz** captures all motion-relevant
  ripple — ~10× coarser than the circuit Δθ rate.
- Both cadences are **kinematic (∝ ω)**.

### F4 — Saturation gaps are large and generator-reachable (Phase 0 sweep)
- **Detent (hybrid stepper):** saturated detent is **150×** the linear one
  (1.74e-2 vs 1.16e-4 N·m). The detent *is* local tooth saturation of the PM flux;
  the linear path produces essentially none. (Coarser-tooth PMSM cogging is
  saturation-independent — machine-specific, but the generator makes fine-tooth
  machines.)
- **Flux / inductance (PMSM current sweep):** apparent λ error → **36%**, and the
  **incremental L** (the `L` in `L·di/dt`) collapses by **69%** at deep saturation.
  The linear model carries ~3× too much inductance → wrong current rise/peak/phase.
- **Cache:** incremental L drops 69% with *current* at fixed θ → coeffs are
  strongly `(θ, i)`-dependent → the per-θ-bin cache is **invalid** under saturation.
- **Saturated reference is cheap to obtain** from the existing saturated solve:
  apparent λ = `solve(θ,i).fluxLinkages`; saturated detent = `solve(θ,0).torque`;
  incremental L = one FD (or from the Newton tangent `solve` already factorizes).
  But each costs a saturated solve.

## Architecture

### Two regimes, routed by a boot-generated saturation gate
The gate is **generated per built machine** (re-run on geometry edit, alongside
the coeff cache; not hardcoded per fixture):
- **Linear (`B_lin < Bknee`):** cheap — cached linear coeffs (correct), co-energy
  torque (0% error in the linear regime), no Arkkio.
- **Saturated (`B_lin ≥ threshold`):** expensive — saturated coeffs (incremental L
  re-extracted per `(θ,i)`) **and** Arkkio torque. No caching/co-energy shortcut.

`B_lin` (peak iron B from the linear `A_j` superposition) overestimates B (no
saturation relief), so the trigger is conservative. Detector tiers by cost:
precomputed current threshold → per-θ B-sensitivity → full `peak|∇×A_total|`.

### Kinematic multi-rate stepping
`dt = min(Δθ_circuit/|ω|, T_elec/N, dt_cap)` — regular through ω→0
(startup/stall/reversal), where the kinematic term → ∞ but the others bound it.
- **Circuit + coeffs:** Δθ ≤ ~2° (stability). Cheap (cached) in the linear regime;
  a saturated solve per sub-step in the saturated regime.
- **Torque / field:** Δθ ≤ ~15–20° (~300–500 Hz), captures motion-relevant ripple.

## Plan
- **Phase 1 — kinematic adaptive step** (stability; standalone product fix).
- **Phase 2 — torque-cadence decoupling** (perf; multi-rate field solve).
- **Phase 3 — saturation gate** (the linear/saturated router for the whole step).
- **Phase 4 — saturated coeffs (gap B)** — **GO** per F4: detent and current
  fidelity both fail badly under saturation, reachable by the generator.

Perf summary: the cheap path (caching, co-energy, multi-rate field) is a
**linear-regime optimization**. Saturated machines force the field solve into the
inner loop for both circuit and torque — that's physics, not removable overhead;
the gate is what keeps the linear regime fast.
