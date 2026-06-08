# Feature spec — 2.5-D axial-flux coupling (uniform axial PM: hybrid stepper, claw-pole, Lundell)

**Status:** DRAFT for user review (2026-06-08). Surfaced by the hybrid-stepper
faithful-redesign work: the genuine hybrid PM is an **axially-magnetized** magnet
that biases each rotor cup to a single polarity, and that is **unrepresentable** in
the engine's per-slice 2-D Az formulation. This spec adds the missing axial flux
path so a uniform per-cup magnetization becomes a first-class move — closing the
"all machines are the same physics, just magnets/wires rearranged" thesis for the
axial-flux family.

## Problem (diagnosed, verified)

A 2-D r-θ magnetostatic slice in the Az formulation has **B in-plane** and the net
radial flux through *any* concentric circle is identically zero:

```
Φ_radial(r) = ∮ Bᵣ·(r dθ·ℓ) = ℓ ∮ ∂Az/∂θ dθ = ℓ·[Az(2π) − Az(0)] = 0   (Az single-valued)
```

A uniform axial PM needs cup-A's teeth to be **all-N** (net flux out) and cup-B's
**all-S** (net flux in), with the imbalance returning **along the machine axis**
(out cup-A teeth → gap → stator yoke → gap → in cup-B teeth → rotor core → back
through the magnet). That return path lives in the axial dimension a single slice
integrates out — so the slice cannot host it, and any uniform-polarity radial
source has nowhere to close.

**Measured (parity sweep, 2026-06-08):** for the grouped-pole-teeth hybrid
(Q=8/p=4 stator, 50 rotor teeth), torque parity `T(+,-) / T(-,+)` vs PM pole count:

| PM | `magnets:1` (uniform radial) | `magnets:2` | `magnets:4` | `magnets:8` |
|----|------|------|------|------|
| ratio | **1.000** | **1.000** | 0.938 | 0.836 |

`magnets:1` — the uniform "S-in/N-out all around" magnet, the in-plane proxy for
the axial PM — produces **exactly zero** PM·i coupling (ratio 1.000): no bound
currents (∇×M = 0 in the bulk, M×n̂ = 0 at the radial faces), so the Az formulation
sees no source. The only representable PMs that couple are angularly-**alternating**
multi-pole rings (4, 8), i.e. PM-vernier proxies — not the axial device. This is
missing physics, not a test artifact, and not maskable.

**Why the existing two-slice machinery does not cover it.** `LIB.MotorStack`
already builds one slice per cup and offsets/sums them, but:
- `stack.solve` (`lib/motor-stack.js:66-84`) loops slices **independently** and
  sums torque + flux — no inter-slice field coupling by construction.
- The current "two cups, opposite polarity" is faked by flipping the **in-plane**
  PM sign per slice (`config-schema buildSliceFeatures` + `stack.fluxSources`
  `sliceSigns:[+1,-1]`). That is still an in-plane (alternating) magnet in each
  slice — it inherits the zero-net-flux constraint and cannot represent the axial
  bias.

The axial path is genuinely a between-slices degree of freedom that the engine has
no representation for.

## Physical model

Add, per slice, the **net cross-gap flux** as an explicit unknown, and couple the
slices through a lumped **axial magnetic circuit** in which the axial PM is an MMF
source. The 2-D field in each slice still solves the in-plane problem; the new DOF
carries the DC radial flux the slice exchanges axially with the rest of the stack.

### 1. The per-slice flux DOF (relax the zero-net-flux constraint)

Introduce a **cut** Γ_s — a radial line from inner to outer radius in slice s's
rotor annulus — across which `Az` may jump by a constant `Ψ_s`. By the identity
above, the net radial flux carried by slice s is then

```
Φ_s = ℓ_s · Ψ_s            (Ψ_s = the Az jump across the cut; ℓ_s = slice axial length)
```

`Ψ_s = 0` recovers single-valued Az and today's behavior exactly. The cut's angular
location is arbitrary (net flux is independent of where the cut sits), so it is a
fixed mesh angle; the rotor's θ-rotation is unaffected (the mortar gap already
handles rotor↔stator relative motion).

The stator carries the same flux radially (continuity across the thin gap), so each
slice gets a matching stator cut with jump `Ψ_s` too; the mortar gap's flux
continuity ties rotor-side and stator-side jumps equal (one scalar `Ψ_s` per slice,
realized as a cut on each body). Inner-shaft and outer-yoke radial reluctances of
the slice are part of the FE field, not lumped.

### 2. The axial magnetic circuit (a flux-loop netlist)

The DC fluxes close through a small lumped circuit. General form: a set of
independent **flux loops** `Φ₁…Φ_L`; each loop threads a signed subset of slices and
a chain of lumped axial branches (axial reluctances + PM MMF sources). The slice
jump is the superposition of the loops threading it:

```
ℓ_s · Ψ_s = Σ_l  σ(s,l) · Φ_l           σ(s,l) ∈ {−1,0,+1}  (loop-incidence)
```

Each loop equation is Kirchhoff's voltage law for magnetic circuits (ΣMMF = ΣR·Φ),
where the slices it threads contribute their **field reluctance** (the radial
flux/MMF relation the FE computes) and the lumped branches contribute axial
reluctance + PM MMF:

```
Σ_branches F_pm,b   =   Σ_branches R_axial,b · Φ_l   +   Σ_{s∈loop}  (field MMF drop of slice s)
```

**Hybrid instantiation (the simplest, L=1):** two slices (cups A, B), one loop Φ.
Flux out of cup A (slice 0, σ=+1), through the stator yoke (axial reluctance
`R_yoke`), into cup B (slice 1, σ=−1), back through the rotor core (axial
reluctance `R_core`) and the magnet (MMF `F_pm`, internal reluctance `R_pm`). So
`Ψ_0 = +Φ/ℓ`, `Ψ_1 = −Φ/ℓ`, and the loop equation closes Φ given `F_pm` and the two
slices' field reluctances in series. `sliceOffsets:[0, π/50]` (the half-tooth cup
offset) is unchanged; the in-plane `sliceSigns` PM hack is **removed** for axial
machines and replaced by `F_pm`.

### 3. The PM as an axial MMF source

The axial PM enters where it physically belongs — a branch MMF in the axial loop:

```
F_pm = Hc · ℓ_pm = (Br / μ0) · ℓ_pm      R_pm = ℓ_pm / (μ0·μ_pm·A_pm)
```

uniform per cup, finally representable. (The recoil μ_pm gives `R_pm`; saturation of
the iron axial paths can enter `R_core/R_yoke` as field-dependent reluctances in a
later refinement — the linear lumped form is the faithful baseline, like the brush
spec's linear-commutation ramp.)

## Integration points (engine)

The decisive enabler: **`solveCoupled` is already a monolithic multi-slice Newton**
(`lib/motor-stack.js:105-296`). It Schur-condenses each slice's field block `A_s`
into a small reduced system of size `nu = nf + 2` over `[i_free, ω, θ]`, with the
**θ-column condensed per slice exactly like a new DOF would be** (`dRdth` assembled
at `:224`, batched into the multi-RHS solve at `:253`, condensed into `S`/`rCond` at
`:267-273`). The axial DOFs slot into this structure as additional reduced unknowns.

1. **Reduced system grows by the loop fluxes** (`solveCoupled`): `nu = nf + 2 + L`.
   Layout `[i_free, ω, θ, Φ₁…Φ_L]`. The new rows/cols are dense and tiny (L is 1
   for a hybrid).

2. **Per-slice Φ-coupling column** (mirror the θ-column path): each slice
   contributes a cut-coupling RHS column `c_s` (the field response to a unit jump
   `Ψ_s`), produced by a new `slice.coupledFluxCutRhsInto(...)` analogous to
   `coupledUnitRhsInto`/`coupledThetaPostDiff`, batched into
   `coupledSolveMultiAgainst` (`:254`) and condensed into `S`/`rCond` with the same
   `sparseDot`/`dot` pattern (`:259-273`). The slice's **field reluctance** seen by
   Φ falls out of the same Schur term (`cᵀ A⁻¹ c`).

3. **Axial-circuit reduced block + RHS:** the lumped `R_axial` fills the Φ–Φ block
   of `S`; the loop-incidence `σ(s,l)` places each slice's Φ-column under the right
   loop; `F_pm` enters `rCond` for the Φ rows. This is pure dense assembly next to
   the existing mech/angle rows (`:236-240`).

4. **Field assembly — the cut** (`lib/motor-slice.js`): the cut adds a rank-1
   coupling between `Ψ_s` and the nodes along Γ_s in the slice stiffness (the
   saddle-point `[[K, c],[cᵀ, ·]]`). Must compose with the **mortar gap coupling**
   and with the **Schur null-mode gauge** (commit `26be498`) — the existing null
   mode (Az defined up to a per-region constant) interacts with the new DOF; the
   gauge fix must be extended to pin only the true null space, not the flux DOF.

5. **Static path** (`stack.solve`, `:66-84`): the independent-slice loop cannot
   couple, so axial machines need a **field-only coupled static solve** — a small
   Newton over `(A_s, Φ_l)` at fixed `i, θ` (the same Schur condensation, minus the
   circuit/motion rows). Either generalize `solve` or add `solveFieldCoupled`;
   `solve`'s independent path stays the default for non-axial machines.

6. **Torque** (`slice` Arkkio/Maxwell): each slice's gap torque now includes the DC
   `Ψ_s` flux component; the stack still sums per-slice torque (`:174`). The PM does
   work through the axial loop — verify the summed torque matches co-energy
   `dW/dθ` with the Φ DOFs held at their solved values (cross-method gate).

## Config surface (agnostic — NO machine-name branching)

A new optional `stack.axial` block declaring the flux-loop netlist; absent ⇒ no
axial coupling ⇒ `Ψ_s ≡ 0` ⇒ exact current behavior. No element-letter or
machine-identity dispatch.

```js
stack: {
  slices: 2,
  sliceOffsets: [0, Math.PI / 50],
  axial: {
    // lumped axial branches (reluctances + PM MMF sources), SI units
    branches: {
      pm:    { mmf: "Br*l/mu0", Br: 1.2, length: 0.004, area: 1.6e-4, muR: 1.05 },
      core:  { reluctance: ... },   // rotor core axial
      yoke:  { reluctance: ... },   // stator yoke axial
    },
    // independent flux loops: signed slice incidence + branch chain
    loops: [
      { slices: [ {s: 0, sign: +1}, {s: 1, sign: -1} ],
        branches: ["pm", "core", "yoke"] },
    ],
  },
  // fluxSources/sliceSigns (the in-plane PM hack) is dropped for axial machines.
}
```

`reluctance`/`mmf` accept either a number or a small geometry spec
(`length/area/muR`) so a lesson can declare physical magnet + iron dimensions. The
schema validates: loops reference existing slices/branches; the incidence is
consistent (a slice appears with one sign per loop); `L ≥ 1`.

## No-regression reduction (load-bearing)

With no `stack.axial`: the cut DOFs are **pinned to 0**, `nu` stays `nf + 2`, and
`solveCoupled`/`solve` are **bit-identical** to today. Every existing machine
(pmsm, induction, synrel, VR/PM steppers, brushed-DC, …) is untouched. This is the
same discipline as the brush spec — the new path is reached only by the new config.

## Acceptance criteria

1. **Faithful hybrid steps.** With an axial PM (uniform per cup) + grouped stator
   pole teeth (`poleTeeth`, already built) + 50 rotor teeth + half-tooth cup offset:
   the four full-step states are **distinct** (parity `T(+,-)/T(-,+) ≈ −1`, not
   +1), the static wells march by **¼ tooth**, and the dynamic test
   `tests/machines/hybrid-stepper.test.js` ("self-steps under the commutation
   table") **passes** — `net ≈ 5×2π/200 ± 30%`, settles. NO loosening of that test
   (it is the honest failing signal this feature must satisfy).
2. **Exact reduction.** Non-axial machines are bit-identical; full machines /
   pipeline / slice / mesh suites stay green (89-test baseline: 88 pass + the
   hybrid honest-fail → 89 pass once this lands).
3. **Cross-method torque.** Arkkio vs co-energy torque consistent for an axial-PM
   machine at a loaded angle, with the Φ DOFs at their solved values.
4. **Energy sanity.** A prescribed-flux unit test: imposing `Ψ_s` produces the
   correct net radial flux `ℓ·Ψ_s` and the expected radial field, independent of
   cut location; PM MMF with open iron (R_axial→∞) drives Φ→0; short iron
   (R_axial→0) drives Φ to the field-reluctance-limited value.
5. **Second consumer.** A claw-pole / can-stack PM stepper (the same axial-bias
   mechanism the original `pm-stepper` needed before it was reframed as a matched
   synchronous machine) is expressible via the same `stack.axial` block — proving
   generality, not a hybrid one-off.
6. **Agnosticism + perf.** Zero machine-name refs; dispatch only on presence of
   `stack.axial`. Reduced system grows by L (≈1); the per-slice Φ-column rides the
   existing multi-RHS Schur solve — negligible cost over today's coupled step.

## P2 implementation notes — the reduced-system condensation (worked out)

Convention (matches the validated P1): work the field in 2-D (per-length). The loop
flux Φ_l is the 2-D jump variable; slices sharing a loop share `ell` (true for the
hybrid). 3-D flux = `ell·Φ_l`. `R_axial`/`F_pm` are given in the same 2-D-consistent
units P1 verified (Ψ = F_pm/(R_field+R_axial)).

Per-slice quantities (from `slice.coupledFluxRhsInto(θ,out)`): the coupling column
`c_s` (nGlobal) and self term `d_s`. Slice net-flux jump `Ψ_s = Σ_l σ(s,l)·Φ_l`,
incidence `σ(s,l) ∈ {−1,0,+1}`.

Coupled residuals (added to the existing `[i_free, ω, θ]` system → `nu = nf+2+L`):
- **Field row, slice s:** `R_field,s += c_s·Ψ_s`  (add before condensation + the conv check).
- **Field tangent:** `∂R_field,s/∂Φ_l = c_s·σ(s,l)`  ⇒ batch ONE extra column `c_s` per
  slice into `coupledSolveMultiAgainst`; `xc_s = K_s⁻¹c_s`.
- **Loop row l (KVL):** `R_Φl = Σ_s σ(s,l)(c_sᵀA_s + d_s Ψ_s) + R_axial,l·Φ_l − F_pm,l`.
  - `∂R_Φl/∂A_s = σ(s,l)·c_sᵀ` (condensed via `xc_s`).
  - `∂R_Φl/∂Φ_m = Σ_s σ(s,l)σ(s,m)·d_s + R_axial,l·δ_lm`.

Schur condensation (mirror the mech-row `dTdA·xcol` pattern, lines 259–273):
- `Φ_l–Φ_m` reduced block: `Σ_s σ(s,l)σ(s,m)(d_s − c_sᵀK_s⁻¹c_s) + R_axial,l δ_lm`
  `= Σ_s σσ·R_field,s + R_axial`  (loop reluctance = series slice field reluctances + lumped).
- `Φ_l–(i/ω/θ)` cross: `−Σ_s σ(s,l)·c_sᵀ·xcol_other,s` (and symmetric).
- `Φ_l` condensed residual: `R_Φl − Σ_s σ(s,l)·c_sᵀ·xr_s`.
- Back-sub: `δA_s −= Σ_l δΦ_l·σ(s,l)·xc_s`.

`c_s,d_s` are frozen per Newton iter (their ν-dependence is 2nd-order) — Newton still
converges; the field tangent's `dν` is unchanged. Netlist (`σ`, `R_axial`, `F_pm`)
comes from `expanded.axial` (P4); P2 drives it via a test stand-in. Validate against a
2-slice analytic lumped circuit (two series field reluctances + R_axial, one F_pm).

## Phasing

- **P1 — cut DOF in one slice.** Add the saddle-point cut to `motor-slice` field
  assembly; static field-only solve over `(A, Ψ)` at fixed i/θ; verify criterion 4
  (prescribed-flux, cut-location invariance) on a single annulus. Reconcile with
  the Schur null-mode gauge.
- **P2 — axial circuit in `solveCoupled`.** Add the Φ unknowns, the per-slice
  Φ-column condensation (mirror the θ-column), the lumped `R_axial` block + `F_pm`
  RHS. Verify two coupled slices reproduce a known lumped-circuit flux split.
- **P3 — static coupled path.** `solveFieldCoupled` (or generalize `solve`) so the
  static/equilibria probes and any non-transient consumer get the coupling.
- **P4 — config surface + schema.** `stack.axial` parse/validate/expand; drop the
  in-plane `sliceSigns` PM for axial machines; default-absent reduction guard.
- **P5 — build + verify the faithful hybrid** (and a claw-pole as the second
  consumer); make `hybrid-stepper.test.js` pass; full-suite green; cross-method +
  energy gates.

## Resolved decisions (user, 2026-06-08)

- **D-1 — flux-loop netlist.** Use the general signed flux-loop netlist (N slices /
  L loops), so claw-pole / Lundell come for free, not just the 2-cup hybrid.
- **D-2 — linear axial-iron baseline.** Constant lumped `R_core/R_yoke/R_pm`.
  Rationale (physics, not preference): the detent/cogging *waveform* is shaped by
  *in-plane tooth-tip* saturation, which the slice FE **already models** (per-element
  B–H). The axial path carries the PM's roughly **DC** bias, so its saturation is
  ~angle-independent — a global *magnitude*/operating-point effect (caps delivered
  bias and peak/holding torque; droops incremental winding inductance under heavy
  drive), **not** a per-step shaper. Linear axial therefore captures the full
  stepping mechanism. Field-dependent axial reluctance is a later refinement (peak-
  torque-under-overdrive / inductance-droop accuracy only) with its own gate.
- **D-3 — explicit axial geometry in config.** `stack.axial.branches` carries
  magnet/iron `length/area/muR` (or raw reluctance); no auto-derivation in v1.
