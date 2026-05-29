# Feature spec — brush/commutator current-sheet model (mechanically-commutated machines)

**Status:** DRAFT for user review (2026-05-29). Surfaced by Phase-7 machine validation:
`brushed-dc-pm` "torque scales linearly with armature current" fails (t2/t1 ≈ 1.0,
expected 2) because the engine has no spatial commutation.

## Problem (diagnosed, verified)

A mechanically-commutated DC machine produces steady torque ∝ armature current
because stationary **brushes** continuously remap which physical rotor conductors
carry +I vs −I, holding the armature current-sheet (MMF) **stationary in the
stator frame** as the rotor turns. The engine currently models commutation only as
a **scalar circuit-current gate** (`lib/excitation.js`); the winding's ±turn sign
pattern is **frozen in the rotor frame** (`body.turns[e]`, baked at mesh build).

Consequence for the rotor-armature + stator-PM topology (`brushed-dc-pm`): the
armature MMF rotates *with* the rotor against the stationary PM field, so the
stator-PM flux links equal-and-opposite through the +/− conductors →
`λ_pm ≡ 0`, `dλ_pm/dθ ≡ 0` → **no linear torque** (only a tiny i² self-term +
cogging, which is ~10⁶× larger). Measured: current-dependent torque ∝ i² (even in
i, t(+10)=t(−10)); linear coefficient ≈ 0.

This is missing physics, not a test artifact, not saturation (the linear term is
structurally absent with saturation off), and not maskable by loosening the test.

## Physical model

Replace the rotor-frozen armature conductor **sign** with a rotor-angle-dependent
**brush sign** so the effective current-sheet is brush-locked (stationary in the
stator frame), while preserving each conductor's turn **magnitude**:

```
turns_eff(e, θ) = |turns(e)| · brushProfile( α_s(e, θ) − α_brush )
α_s(e, θ) = α_rotor(e) + θ            // conductor angular position in the STATOR frame
```
`brushProfile(ψ)` is a **trapezoidal** ±1 wave of p-pole periodicity (period
`2π/(p/2)` electrical): it equals +1 / −1 in the pole bodies and **ramps linearly
through 0 across a finite commutation zone of angular width `δc`** centred on each
brush (the inter-pole crossings). I.e. it is the `sign(cos((p/2)ψ))` square wave
with the zero-crossings replaced by a linear ramp of width `δc`.

- `α_rotor(e)`: conductor element mechanical angle in the rotor body (from mesh geometry).
- `α_brush`: brush-axis angle, **fixed in the stator frame** at ideal quadrature
  (90° elec to the stator field axis) → `α_brush = α_field + (π/2)/(p/2)` mech, plus
  the configurable `brushOffset` (default 0) for advance/retard.
- `δc`: **commutation-zone angular width** — the linear-commutation transition over
  which a coil shorted under the brush reverses from +i to −i. Default ≈ one
  commutator-segment / slot pitch (`2π/Qslots` mech, the physical zone a coil
  spends being shorted); configurable. `δc→0` recovers the ideal square wave.
- `p`: pole count.

This makes the +i conductors always those under one stator pole and −i under the
adjacent pole, with a smooth linear reversal through the brush zone — regardless
of θ → nonzero `dλ_pm/dθ` and steady torque ∝ i, with physical (non-discontinuous)
commutation evaluated **per time step** as conductors transit `δc`.

## Integration points (engine, lib/motor-slice.js)

1. **Conductor RHS / Jz** (`assembleInteriorMagnetLoadAndJzInto`, ~537-547):
   the armature current density per conductor uses `turns_eff(e, θ)` instead of
   the static `turns[e]`, for circuits flagged as mechanically commutated.
2. **Flux-linkage sum** (`fluxLinkagesFromFullAInto`, ~2874-2931): the armature
   λ uses the same `turns_eff(e, θ)`, so back-EMF / circuit coupling reflect the
   commutated current-sheet (and `dλ_pm/dθ` becomes nonzero).
3. **Reconcile with the existing scalar commutation** (`lib/excitation.js`): the
   spatial brush model SUBSUMES the scalar gate for commutated armatures (the
   remap *is* the commutation). The scalar gate should no longer be applied to a
   circuit that has a spatial brush map, to avoid double-counting.

## Config surface (agnostic — NO machine-name branching)

Driven by the existing commutation config. The spatial brush remap applies ONLY
to circuits with `commutation.mode === "mechanical"` (a physical commutator +
brushes on a rotor-frame armature). **Electronic-commutation modes
(`electronic-*`, `sequencer`) are BRUSHLESS — their commutation is the stator-side
drive (inverter switching the stator phase currents), already correctly modeled by
the existing phase/sector gate; they must NOT receive the spatial rotor remap.**
A mechanical-commutation circuit is marked a commutated armature; the brush axis
derives from the stator field axis + the commutation config; expose an optional
`brushOffset` (default 0 = ideal quadrature). General to any mechanically-
commutated machine (brushed-dc-pm, brushed-dc-wound, universal) — no machine-name
branching, dispatch on `commutation.mode` only.

## Layering — electrical vs magnetostatic vs this feature

Three distinct layers; this feature is purely the **spatial/rotational** one.

- **Electrical (terminal + circuit):** `lib/excitation.js` maps the terminal
  config → a drive (V or I); for `mode:"mechanical"` it currently applies a
  SCALAR ±1 gate `g=sectorGate(rotorPhase)` to the whole circuit current
  (`I=g·raw`, `excitation.js:164-175`) — a crude 1-D stand-in for commutation.
  `lib/motor-circuit.js advance()` integrates the circuit ODE `V = R·i + dλ/dt`
  with back-EMF `e_k = ω·(Σ_l dLdth[k,l]·i_l + dLambdaPmdth[k])` to produce the
  terminal currents `i(t)`. This layer owns the scalar current `i(t)` and its
  time dynamics.
- **Magnetostatic spatial (THIS FEATURE, in the slice):** given `i`, *how the
  scalar terminal current distributes across the rotor conductors* — which
  conductors carry +i vs −i at rotor angle θ: the brush/commutator map
  `turns_eff(e,θ)`. Geometric, evaluated per solve at a fixed θ.
- **Finite commutation transition (MODELED HERE, per-time-step):** a coil shorted
  under the brush reverses from +i to −i over a finite commutation zone, not
  instantaneously. We model this with the **trapezoidal `brushProfile`** (linear
  commutation over `δc`): as the rotor advances by dθ each time step, conductors
  transit `δc` and ramp smoothly through 0 — a genuine per-time-step event,
  evaluated in the same `turns_eff(e,θ)` lookup at zero extra solve cost. NOT
  deferred. (Rationale: no phase spec owns a "circuit-layer commutation model" —
  Phase 3 specs only the scalar gate — so deferring would drop it into a void;
  and the linear-commutation ramp is the standard faithful baseline.)
- **Full commutation reactance (OPTIONAL future refinement, clearly out of scope
  NOW, not a required deferral):** solving the shorted coil's actual L/R current
  transient (vs the linear-ramp approximation) → exact sparking/commutation-ripple.
  The linear ramp already captures the smooth reversal; the L/R transient is a
  fidelity upgrade that, if ever wanted, gets its own spec — the feature is
  complete and faithful without it.

**On "instantaneous flip":** correct that a hard step would be non-physical — so
we do NOT use one. The trapezoidal `brushProfile` ramps each conductor through the
commutation zone `δc` over successive time steps, modeling the linear-commutation
reversal. `δc→0` would recover the square wave (the idealization), but the default
`δc` is a real commutation arc, so the reversal is smooth and physical.

## Resolved decisions (user, 2026-05-29)

- **D-A — build the spatial brush map WITH the finite commutation transition now**
  (trapezoidal `brushProfile`, linear commutation over `δc`, evaluated per time
  step). NOT deferred — Phase 3 specs only the scalar gate, so there is no
  circuit-layer commutation spec to defer into. Only the full shorted-coil L/R
  commutation-reactance transient is an optional future refinement (own spec if
  ever wanted); the linear ramp is the faithful baseline.
- **D-B — slice-level brush map** (the slice owns conductor angular geometry).
- **D-C — brush axis is FIXED in the stator frame** (brushes are physically
  stationary). Default = ideal quadrature (90° elec to the stator field axis);
  nothing rotates — individual conductor signs flip as they pass under the fixed
  brushes, which is exactly what holds the aggregate armature MMF fixed at
  quadrature. **Expose `brushOffset`** (default 0 = quadrature) for advance/retard
  (armature-reaction compensation / commutation timing).
- **D-D — apply to all mechanically-commutated armatures** (brushed-dc-pm,
  brushed-dc-wound, universal): correct for *steady* torque over rotation even
  where a static bilinear test currently passes via the mutual term.

## Reconcile with the existing scalar gate

For a circuit that now has a spatial brush map, the scalar `g` gate in
`excitation.js` must NOT also be applied (it would double-count the commutation /
re-invert the already-correct spatial sheet). The spatial map *is* the
commutation; the electrical layer for these circuits supplies only the un-gated
terminal current. Pin the exact hand-off during implementation.

## Acceptance criteria

1. `brushed-dc-pm` "torque scales linearly with armature current" passes
   (t2/t1 = 2 ± 3%); torque is steady & unidirectional at fixed excitation;
   self-starts. NO loosening of the existing test.
2. Cross-method torque (Arkkio vs co-energy) stays consistent for commutated
   machines at a loaded angle.
3. No regression: pmsm / induction / synrel / etc. (non-mechanically-commutated)
   unaffected; full slice/harmonic/pipeline/mesh suites stay green; the wound-DC
   bilinear and universal i² tests stay green.
4. Agnosticism preserved: zero machine-name refs; driven by commutation config.
5. Perf: negligible (a per-conductor sign lookup in the RHS/λ loops; no change to
   the solve/Schur structure).

## Motional vs switching decomposition — the torque/back-EMF derivative (2026-05-29)

### The problem the brush map created

The spatial brush map above makes `turns_eff(e, θ)` depend on θ so the armature
current-sheet stays brush-locked (stationary in the stator frame). But that same
θ-dependence broke the derivative extractor. The slice computes `dλ/dθ` by a
central difference of three solves at `θ−h, θ, θ+h`. Originally each probe
evaluated the brush map at its OWN angle (`evaluateAt(angle)` used `angle` for
both the gap stamp AND the brush wiring). So the probe measured the **TOTAL**
derivative

```
dλ/dθ|_total = ∂λ/∂θ|_field  +  ∂λ/∂θ|_wiring
             = MOTIONAL term  +  SWITCHING term
```

For a mechanically-commutated machine these two terms **cancel by design**: the
brush exists precisely to keep λ(θ) ≈ θ-invariant (the current-sheet does not
rotate), so `dλ/dθ|_total ≈ 0`. Feeding ≈0 into the co-energy torque
(`½ iᵀ dL/dθ i + iᵀ dλpm/dθ`) and into the back-EMF
(`e = ω·(Σ dLdθ·i + dλpm/dθ)`) gave ≈0 torque (off by ~50× and wrong sign vs
Arkkio — see `spec/_coe_*.out`) and ≈0 back-EMF (→ the brushed-dc-wound
"self-start" had no speed-EMF, the runtime over-drove current and the saturating
FEA solve hit a non-SPD factorization). Both symptoms are the same bug.

### The physics: torque and back-EMF are the MOTIONAL term ALONE

The electromechanical energy conversion comes ENTIRELY from conductors **cutting
flux** — the motional term — at a **fixed wiring topology**. The switching term
(the commutator re-connecting coils) transfers current between physical conductors
but does no net mechanical work; it is the bookkeeping that keeps the aggregate
sheet stationary. The torque- and EMF-producing derivative is therefore

```
∂λ/∂θ|_motional = Σ_e turns_eff(e, θ_center) · (∂A_e/∂θ)     ← wiring FROZEN at θ_center,
                                                                only the field/geometry rotates
```

### The implementation: decouple the brush-map angle from the solve angle

The rotor mesh is rotor-frame and does not move; rotation enters ONLY through the
gap stamp (`_ensureLinearSchurFactorAt(φ)`); the brush map enters ONLY through the
`th` passed to the RHS Jz and the flux-linkage pickup. So the motional derivative
is obtained by stamping the gap at `θ±h` while holding the brush map at `θ`:

- `evaluateAt(solveAngle, mapAngle)` — `solveAngle` drives the gap stamp,
  `mapAngle` drives the brush wiring. `mapAngle == null ⇒ mapAngle = solveAngle`
  (legacy/operating-point behaviour).
- `extractCoeffs` probes `evaluateAt(θ−h, θ)`, `evaluateAt(θ, θ)`,
  `evaluateAt(θ+h, θ)` — center, center, center for the MAP; ∓h for the FIELD.
- `mapAngle` is threaded into `fluxLinkagesFromFullAInto`/`...Combined(Into)` (5th /
  3rd param) and `assembleUnitCurrentRhs` (4th param), each defaulting to the
  existing `thetaR` so EVERY non-derivative caller (and every non-mechanical
  circuit, which carries no brush map) is byte-identical. The operating-point
  values `center.L` / `center.lambdaPm` are unchanged. Same solve count as before —
  no extra factorization.

The single-angle `solve()` is untouched (it evaluates one physical configuration,
so gap and wiring legitimately share `thetaR`); `coenergyTorque`,
`backEmf`/`advance` are untouched — they consume the now-motional derivatives
unchanged.

### The `iᵀGi` / energy-balance reconciliation (the π gap-measure question)

Bug #1 established that the co-energy torque carries a gap-energy Parseval measure
`∫₀^{2π} cos²(kθ)dθ = π`: `coenergyTorque` multiplies reluctance/mutual/pm by
`GAP_MEASURE = π`, and with the motional derivative this now matches Arkkio to
ratio **1.0000** at every angle for all three commutated machines (gate A). The
question the spec flagged: does the SAME π belong on the MOTIONAL mutual/pm term,
and hence on the back-EMF? Resolved by the lossless-coupling-field energy theorem
(NOT by tuning):

```
e·i = d/dt (energy into field) = ωT + dW_field/dt          (instantaneous power balance)
```

With `e = ω·(dL/dθ·i + dλpm/dθ)` (raw, no π) and `T = π·(½ iᵀ dL/dθ i + iᵀ dλpm/dθ)`:

- **PM term** (brushed-dc-pm, `dL/dθ ≈ 0`): `e·i = ω·iᵀ dλpm/dθ`, `T_pm = π·iᵀ dλpm/dθ`,
  no field-energy storage in the pm term ⇒ balance requires `π·(e·i) = ωT_pm`.
  Measured `π·e·i / T_pm = 1.00000` (`spec/_mot_pi.out`). ✓
- **Mutual/reluctance term** (wound, universal): `e·i = ω·iᵀ dL/dθ i`,
  `T = π·½ iᵀ dL/dθ i`; at constant current half the electrical input becomes
  stored field energy `dW_field/dt = ½ ω iᵀ(πdL/dθ)i = ωT`, so `π·(e·i) = 2ωT`.
  Measured `π·e·i / T = 2.00000`. ✓ (the factor 2 is the textbook co-energy ½, not
  a discrepancy.)

So the π is a genuine, consistent gap-energy measure that applies to the motional
mutual/pm term and **must propagate to the back-EMF** for `e·i = ωT + dW_field/dt`
to hold exactly. **This is NOT silently inserted** — see the OPEN ITEM below; the
engine currently keeps π only in `coenergyTorque` (Bug #1's deliberate placement,
so λ/L stay physical for the readout), so the runtime back-EMF is presently π×
small. The motional fix is correct and complete; the π-placement across
torque/back-EMF is a separate architectural decision escalated to the coordinator
(it would require touching `coenergyTorque`/`backEmf`/the extractor, which this
change was scoped NOT to do).

### Spatial back-EMF density accessor (read-only, pedagogical)

`slice.backEmfDensity(thetaR, currents, omega, opts2?)` (also on
`__internals.backEmfDensity`) returns the per-conductor motional-EMF density
`e_elem = ω·turns_eff(e,θ)·(∂A_e/∂θ)·ℓ` (element-wise, BEFORE summation) for both
bodies: `{ rotor:[{circuit,e,alpha,turnsEff,dAdth,x,y}…], stator:[…], omega }`.
It is OUT of the physics path — it runs its OWN pair of dedicated linear solves at
`θ±h` with the wiring frozen at `θ`, mutating nothing in solve/extractCoeffs.
Verified: `Σ e_elem` over a circuit equals the circuit-level
`LIB.MotorCircuit.backEmf` exactly (ratio 1.0000) for brushed-dc-pm,
brushed-dc-wound, universal, and pmsm (`spec/_mot_density.out`) — confirming the
motional `dL/dθ`/`dλpm/dθ` ARE the element-wise `Σ turns_eff·∂A/∂θ` motional sum.

### OPEN ITEM for the coordinator — runtime back-EMF π-scaling and a pre-existing SPD crash

1. **π on the runtime back-EMF.** Per the derivation above, the physically-correct
   back-EMF carries the same π as the torque. The runtime (`motor-run.js`) uses
   `stack.solve(...).torque` (Arkkio, π-correct) for mechanics but
   `MotorCircuit.advance(coeffs,…)` with raw (no-π) coeffs for back-EMF, so the
   simulated terminal speed is π× too high. Fixing this requires either folding π
   into the extractor (and removing the local π in `coenergyTorque`) or scaling the
   coeffs handed to `advance` — both touch files this change was scoped to leave
   alone. Escalated, not silently changed.
2. **brushed-dc-wound self-start SPD crash is a SEPARATE, pre-existing engine
   defect.** With the motional fix the wound machine now develops torque and spins
   (it previously could not — `e86ac1b`). Spinning drives the armature current to
   ~96 A, and the **saturating Newton solve, warm-started from the previous step**,
   then produces a non-SPD tangent and `factorize()` fails (`spec/_mot_spd*.out`).
   Evidence it is NOT this fix: a static `solve()` over the full revolution at the
   nominal currents never fails (0/2000 angles), and at the exact crash state a
   fresh static solve succeeds even at 32× current — the failure is specific to the
   warm-started nonlinear solve at high current (a robustness bug in
   `solveStaticRotor`/`newtonSolve`, unrelated to the linear derivative extractor).
   π-scaling the back-EMF lowers but does not eliminate the runaway, and does NOT
   remove the crash. This is the gate-B "crash gone" item and is escalated for a
   separate nonlinear-solver-robustness fix.
