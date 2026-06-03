# dL/dθ extraction — R1 + R6 root-cause investigation (2026-06-04)

Investigates the two real-signal clusters left failing after the test-debt
purge: **R1** (round-rotor `dL/dθ ≈ 0` gate) and **R6** (six co-energy↔Maxwell
crosschecks). Both trace to the mortar gap-coupling fidelity in the
inductance/co-energy path. All numbers from probes against the live engine
(scratch, not committed).

## Mechanism under test

- Product torque = **Arkkio / Maxwell stress** (`gap.torque`, band-averaged over
  L_SUB=8 radial sub-contours, `airgap-mortar.js`). Direct local gap-field
  quantity, no derivative.
- Validator torque = **co-energy** `½ iᵀ(dL/dθ)i + PM` (`motor-stack.coenergyTorque`),
  where `dL/dθ` is a central finite difference of `L(θ)` from
  `motor-slice.extractCoeffs`, default step `h = π/(poles·1e5)`. `L(θ)` is the
  flux-linkage inductance, re-solved at `θ±h` with the mortar band **re-zipped**
  at each angle.
- For LINEAR iron the two are equal by virtual work, so a stable disagreement is
  a real signal.

## R1 — round rotor `dL/dθ` is not ≈0

DUT: solid iron rotor ring (`teeth:1, spanFraction:1.0`), `Ntheta=24`,
`poles=2`. True `dL/dθ = 0` (axisymmetric).

- `L(φ)` is **not noisy — it is a smooth, low-amplitude spurious oscillation**:
  peak-to-peak **3.3e-5·|L|** over a node-spacing window, clean sinusoid in θ.
- The FD **converges** cleanly as h→0: `dL/dθ(0.3) → +4.65e-4·|L|` (stable for
  h ≤ 3e-4); across θ∈[0.25,0.35] it traces a clean sinusoid of amplitude
  **±1.5e-3·|L|**. So it is NOT FD round-off — it is the true local slope of a
  real ripple in the engine's discrete inductance.
- Cause: the moving-band mortar re-zips (edge-flips) as rotor nodes rotate past
  stator nodes; the discrete gap sampling makes `L(φ)` of an axisymmetric rotor
  ripple by ~3.3e-5·|L|.
- The test's `< 1e-5·|L|` gate and quoted "FE floor ~6e-8·|L|" were calibrated
  for the **deleted harmonic engine** (smooth analytic gap coupling). The
  mortar's floor is ~4 orders higher.
- The **product torque is unaffected**: at the round rotor (true T=0) Arkkio is
  clean (|max| 1.3e-7) — the ripple lives only in the inductance/co-energy path.

## R6 — salient co-energy vs Arkkio: a stable ~18% method gap

vr-stepper (pure reluctance, no brush/PM — cleanest case), θ=0.3, i=[10,0,0]:

| quantity | value |
|---|---|
| Arkkio (product) | 5.189e-3 |
| co-energy total  | 4.218e-3 |
| rel. error | **18.71%** |

- **Mesh-insensitive**: identical to the byte across interior `mesh.refine`
  0.5→3, across `grid.Ntheta` 192→512, and across a gap-oversample factor 1→3.
  The gap ring is geometry-locked at 208 nodes/body (Δθ≈1.7°). At a gap this
  fine, 18% is **not discretization — it is a method-level inconsistency.**
- brushed-dc-wound (θ=0.2, i=[10,8]): Arkkio −21.59, co-energy −26.35, **18%** —
  but **opposite sign** (vr: Arkkio>co-energy; brushed: Arkkio<co-energy), so it
  is not one global scale. brushed has a mechanical commutator + dominant mutual
  term (−14.7) and the motional brush-map-frozen `dL/dθ` — a plausibly separate
  effect from vr-stepper.

## Which torque is ground truth?

Round-rotor floor (true T=0) is the cleanest discriminator available:
**Arkkio |max| 1.3e-7 vs co-energy |max| 1.7e-6 — Arkkio is 13× closer to the
exact zero.** Combined with: Arkkio is a direct local field quantity (no
derivative); co-energy requires differencing the mortar inductance, the exact
quantity shown to ripple. Weight of evidence: **Arkkio (the product torque) is
the accurate one; the co-energy/`dL/dθ` validator carries the mortar-inductance
artifact** (saliency under-read on vr-stepper; the round-rotor ripple is the
same family).

Not yet nailed: a fully external analytic reference, and the brushed sign-flip
mechanism. The gap could not be refined (geometry-locked), so true
gap-convergence was not demonstrable.

## Implication for the failing crosschecks

The product is sound; the failing crosschecks over-constrain a **coarse
validator**. Note `agnostic-pipeline`'s "Maxwell agrees with co-energy within
10% (linear operating point)" PASSES — co-energy accuracy is operating-point
dependent (good on smooth/well-penetrated points, ~18% on salient/high-current).

The `crossCheck` 5% gate is tighter than the co-energy method's real accuracy on
salient points. Since Arkkio (product) is correct, the gate is not protecting
against a product flaw. Decision (for the user) — see chat.
