# Unified electric-motor app — design

A single configurable teaching surface for electric machines. Every motor on
the syllabus is the *same physics* — metal spun in a magnetic field — with a
different arrangement of field sources and excitation. The app lets the user
choose what sits on the rotor and stator, how each is wound and excited, and
watches one unified field solver respond. No per-motor-type formulas.

## Scope — the machines this must express explicitly

Steppers (variable-reluctance, permanent-magnet, hybrid), single- and
three-phase AC induction, brushed DC, brushless DC. The arrangement matrix
below also yields universal, switched-reluctance, synchronous-reluctance, and
wound-field synchronous machines for free, because the vocabulary is physical
rather than enumerated.

The complexity of each machine is **exposed, not hidden**.

## Relationship to existing work

- **Independent lesson family.** This app shares nothing structural with the
  `lessons/ac_motor/` teaching sequence (`APPS_PLAN.md`). They coexist.
- **New physics engine.** The existing `lib/em-physics.js` models coils as
  current loops in *vacuum* (Neumann mutual inductance, co-energy torque). It
  has no iron and no permeance, so `dL_self/dθ = 0` and it produces **zero
  reluctance torque** — structurally unable to model VR/switched/synchronous
  reluctance machines or hybrid-stepper detent. This app needs a new air-gap
  (MMF + permeance) engine. Once that engine is tested, it may be rolled out
  to the older apps; until then, nothing in `ac_motor/` changes.
- **Reused render layer.** `lib/layout3d.js` (orbital draggable/pannable
  camera), `lib/field-render.js`, `lib/coil-render.js`, `lib/canvas-type.js`
  carry over directly. `field-render.js` gains a gap-field visualization mode.

## The unifying physical model — air-gap field solver

The field is solved on a **2D thin-annulus grid** spanning the air gap (+ slot
openings, + teeth when saturating) — the *level-5* solver chosen below. The
sources (winding MMF, PM MMF) and the iron/slot geometry are the grid's inputs;
inductance, flux linkage, and co-energy are the framework for circuit coupling
and torque. Every electromagnetic element contributes to one shared gap field,
so inter-pole and inter-winding coupling is captured globally (not per-pole
independently).

Per physics tick:

1. **Stamp** each element's sources: MMF `F(θ)` from windings/magnets, and the
   iron/slot boundary geometry `g(θ, θ_rotor)` (both members) for the grid.
2. **Solve** the gap field on the thin-annulus grid (Laplace/Poisson for the
   potential, iron surfaces as boundaries), giving `B_r(θ)` and a *real*
   `B_t(θ)` — not the 1D `B_r = μ₀F/g` idealization. Rotor motion shifts the
   rotor-side boundary mask by Δθ (no remesh).
3. **Currents** per circuit via the circuit law `V = R·i + dλ/dt`, where flux
   linkage `λ_k = ∫ n_k(θ)·B(θ) dθ`. `V = 0` ⇒ induction (shorted cage);
   `V = const` ⇒ DC; sinusoid ⇒ AC; etc. One law produces back-EMF,
   induction, and commutation effects uniformly.
4. **Torque** via the **Maxwell stress integral** on a mid-gap contour,
   `T = (r²·ℓ/μ₀)∮ B_r·B_t dθ` — the natural readout of the grid solve, and now
   accurate because the level-5 grid resolves a *real* `B_t` including slot
   fringing (the component a 1D model gets wrong, which is why Maxwell was *not*
   primary there). Co-energy / virtual work,
   `T = ½·iᵀ·(dL/dθ_r)·i + iᵀ·(dλ_pm/dθ_r)`, is the **cross-check**: robust, but
   on a grid it costs an extra evaluation (finite-difference `dL/dθ_r` needs a
   solve at `θ_r±Δθ`, or a domain co-energy integral), so the two are reconciled
   in the *test suite* over a sweep — not every live frame. The co-energy form
   still *names the physics*: reluctance torque is `½i²·dL/dθ_r` (nonzero
   precisely because `g` depends on `θ_r`, the term `em-physics` lacks), PM
   alignment + cogging is `dλ_pm/dθ_r`. Disagreement beyond gap-resolution
   tolerance is a bug.
5. **Integrate** the rotor mechanical ODE.

**Winding functions for non-uniform gaps:** salient/VR machines must use the
*modified* winding-function reference (permeance-weighted mean, enforcing
`∮ B dθ = 0`), not the classical mean-subtracted form, for quantitative
accuracy. `dL/dθ_r` is taken by central difference (two extra gap evaluations
per step) unless an analytic permeance derivative is available.

This path is validated: a discrete Riemann-sum of the inductance integral for a
salient rotor (`1/g = a₀ + a₂cos2(θ−θ_r)`, sinusoidal stator) reproduces the
closed-form `L(θ_r) = L₀ + L₂cos(2θ_r)` to machine precision, and the
central-difference co-energy torque matches the analytic `T = −i²L₂sin(2θ_r)` —
nonzero, zero-and-restoring at alignment, peak at θ_r = π/4.

### Field engine — level-5 thin-annulus solve (default)

The default field core is a **structured 2D numerical solve on a thin annulus**
(gap + slot openings), iron surfaces as boundaries, doubly-slotted geometry
handled natively (both surfaces are masks). One engine, **two explicit
user-selected modes** (a Live / Detailed toggle — the user flips it; there is no
automatic or per-frame mode-switching):

- **Live (fast) — default.** Coarse uniform grid, real-time on the main thread
  (~few ms/solve, PCG + warm-start), full interaction. Average/reluctance torque,
  back-EMF, induction, and *qualitative* cogging are correct; cogging
  amplitude/harmonics are approximate, and saturation is the cheap **global
  flux-dependent ceiling** (kills false unbounded torque; no aligned-vs-unaligned
  differential).
- **Detailed (slow) — explicit.** The accurate field solve: graded refinement at
  slot mouths + physical tooth-tip fillets (regularizing the `r^(−1/3)` corner
  singularity), optional conformal slot-mouth correction → quantitative
  cogging/detent (~1–5%); plus nonlinear saturation (teeth in the domain, iterate
  μ(B)) → SRM's aligned-vs-unaligned differential and tooth-tip saturation. As
  fine as is realistic on the CPU. Too slow for the live loop, so it runs in a
  **Web Worker** — the UI stays responsive and the result (e.g. a torque-vs-angle
  sweep or field map) appears when ready.

Why level 5 over 3 (complex permeance) / 4 (subdomain): it matches subdomain
fidelity (~1–2% linear), takes arbitrary user-drawn tooth shapes, absorbs live
geometry edits cheaply (repaint the mask — no analytic rebuild), handles
doubly-slotted machines natively, and is the only option that extends to
saturation. The *same* code dials coarse-live → fine → nonlinear, all on the CPU.

**Saturation strategy (decided):** the always-live default carries a **global
flux-dependent ceiling** — one scalar scaling of the source MMF, nearly free,
flattening torque past the iron knee so the false "unbounded torque with
current" never appears, on every machine. It does *not* capture SRM's
aligned-vs-unaligned differential. That, plus tooth-tip saturation, lives in an
**coarse-nonlinear** treatment (teeth in the domain, iterate μ(B)) that runs in
**Detailed mode** (Web Worker — CPU). The Live/Detailed split is an explicit user
toggle, not a silent automatic mode-switch — Live frame-rate stays predictable
and saturation accuracy is opt-in.

### Why a thin-annulus domain is enough (linear tier)

In an electric machine ~95% of the reluctance is in the air gap (iron is
~1000× more permeable — a near-ideal flux guide). That is *why* the level-5
domain is just the gap band: meshing the iron bulk buys almost nothing in the
linear regime. Treating the iron surfaces as ideal boundaries is the physically
dominant term, not a convenience. The coarse tier runs real-time on CPU and
stays live-reconfigurable; the teeth are added to the domain only when modeling
saturation.

### What it captures vs lumps

| Phenomenon | Air-gap model |
|---|---|
| Mutual inductance between all windings | captured (shared `B(θ)`) |
| Back-EMF waveform shape | captured |
| Reluctance torque (saliency) | captured via `P(θ, θ_rotor)` |
| Induced cage current (induction) | captured (circuit ODE) |
| Cogging / detent torque | **core** — resolved by the thin-annulus grid (doubly-slotted, both members). Live mode approximate; Detailed mode ~1–5%. Zero-current PM detent = `dW'_pm/dθ_r` |
| Slot/tooth-tip fringing | **resolved** in Detailed mode (refined grid + tip fillets); Live mode smears it |
| Local saturation (where iron saturates) | Live mode = global ceiling (torque rolloff only); Detailed mode resolves SRM differential + tooth-tip (nonlinear, teeth in domain) |
| 2D flux paths inside iron | resolved when teeth are added to the domain (Detailed mode); gap-only otherwise |

Cogging/detent torque is **in the core engine** (a stepper datasheet parameter,
not a nicety) — resolved by the doubly-slotted thin-annulus grid. Quantitative
cogging and saturation are the *same* level-5 solve at higher CPU resolution or
with teeth in the domain — not a separate model and not a GPU path.

## Element vocabulary (what can sit on rotor or stator)

| Code | Element | MMF source? | Modulates permeance? | Carries current? |
|---|---|---|---|---|
| **W** | Distributed winding ("wrap loops"), ~sinusoidal, polyphase | yes (smooth) | weakly | yes |
| **C** | Concentrated coils ("pole loops"/wound teeth) | yes (lumped per tooth) | yes (salient teeth) | yes |
| **M** | Permanent-magnet array (alternating N/S) | yes (fixed to body) | no | no |
| **I** | Salient iron / passive pole — no winding, no magnet | no | yes (strong) | no |
| **K** | Conductive cage / shorted bars | induced only | yes | yes (shorted) |

`K` is not really a fifth element — it is a `W`/`C` with its terminals
**shorted**. Cage, back-EMF, and driven current are all the same circuit law.

## Excitation / terminal state (per winding element)

`AC1` single-phase · `AC3` three-phase (→ generalizes to N-phase) · `DC`
constant · `PULSE@φ` square pulses sequenced to rotor electrical angle ·
`STEP` single commanded step/hold · `OPEN` disconnected · `SHORT` shorted
(induction).

## Commutation (the "direction-shifting" mechanic)

Commutation is **excitation phase = f(rotor angle)**.

`none` field rotates on its own (true AC) · `mechanical` brush+commutator keyed
to rotor angle · `electronic-trap` inverter switched on Hall/position sectors ·
`electronic-sine` FOC/continuous · `sequencer` open-loop step sequencer.

## Per-object primitives (rotor and stator each parameterized independently)

| Object element | Physical count | Phases | Magnetic poles |
|---|---|---|---|
| **W / C** (wound) | `teeth`/`slots` N | M circuits | **derived** from wiring pattern, generally ≠ N |
| **M** (permanent magnet) | `magnets` N | — (not wired) | **= N** |
| **I** (salient iron) | `teeth` N | — | **= N** (sets reluctance periodicity) |

Three orthogonal axes: **poles** (magnetic N/S alternations, set
`θ_elec = (p/2)·θ_mech`), **phases** (independent circuits, time-shifted
excitation), **slots/teeth** (physical count; `q = Q/(p·m)` slots-per-pole-
per-phase). For a wound object the magnetic pole count is *not* the tooth count
— it is set by the winding pattern. For magnets and iron, count = poles.

**Emergent teaching point:** stator and rotor pole counts are set independently
but average torque only exists when they share a working harmonic. A 4-pole
stator against a 6-pole rotor produces only ripple, no net torque — this falls
out of the solver, it is not scripted.

## Windings are conductor routings, not labels

A winding is a continuous conductor entering at a phase terminal, threading
slots in a definite direction, leaving at the other terminal. Therefore:

- **Phase membership** is a consequence of which circuit (terminal-pair) the
  conductor belongs to — not a per-tooth tag.
- **Polarity** is a consequence of traversal direction through the slot
  (current into vs out of the page) — not a per-tooth tag.

You route the wire; phase and polarity fall out. A conductor must run
terminal→terminal, so a half-defined coil is impossible — the wire's
continuity *is* the validity constraint.

**The editor's output is the solver's input with no translation:** routing →
per-slot ampere-conductor map → winding function `n_k(θ)` (running sum of
phase-k ampere-conductors around the gap) → MMF stamp `F(θ)`.

### Data-model decisions

- **Real turns per coil**, not a normalized density. Density fixes only the
  field *shape*; real turns are required for correct `R`, `L`, and back-EMF
  *magnitudes*.
- **Phases may be series or parallel paths.** A phase's coils connect all in
  series (one current) or split into parallel branches (current divides;
  branches carry circulating current under asymmetry/eccentricity — itself a
  fault lesson). Both supported.
- **Unbalanced windings allowed** (a balanced generator is the default start
  point). Asymmetry is what enables the single-phasing/fault lessons.
- **Saliency is geometry.** `g(θ,θ_r)` is derived from the drawn/parameterized
  tooth geometry of both members — the user never sculpts an abstract permeance
  curve. The same cross-section feeds both the winding editor and the
  doubly-slotted permeance.

## The 13-machine matrix

| # | Machine | Rotor | Stator | Phases m | Poles p | Rotor exc. | Stator exc. | Commutation |
|---|---|---|---|---|---|---|---|---|
| 1 | Brushed DC (PM field) | W | M | 1 (commutated) | 2–4 | DC | — | mechanical |
| 2 | Brushed DC (wound field) | W | W | 1 | 2–4 | DC | DC | mechanical |
| 3 | Universal (AC series) | W | W | 1 | 2 | AC1 | AC1 | mechanical |
| 4 | BLDC (trapezoidal) | M | C | 3 | 14 | — | PULSE@φ | electronic-trap |
| 5 | PMSM (sinusoidal) | M | W | 3 | 4–8 | — | AC3 | electronic-sine |
| 6 | 3-φ induction | K | W | 3 | 2–8 | SHORT | AC3 | none |
| 7 | 1-φ induction | K | W (+aux) | 1 (+aux) | 2–4 | SHORT | AC1 | none |
| 8 | VR stepper | I | C | 3–5 | rotor-teeth | — | STEP | sequencer |
| 9 | Switched reluctance | I | C | 3–4 | 6/4, 8/6 | — | PULSE@φ | electronic-trap |
| 10 | PM stepper | M | C | 2 (bipolar) | low | — | STEP | sequencer |
| 11 | Hybrid stepper | M + I | C | 2 | 50-tooth | — | STEP | sequencer |
| 12 | Synchronous reluctance | I | W | 3 | 4–6 | — | AC3 | electronic-sine |
| 13 | Wound-field synchronous | W | W | 3 (+DC field) | 2–4 | DC (slip-ring) | AC3 | none |

Every row is a choice of element per ring + terminal state + commutation
function. There is no per-type physics.

## Architecture — 3D render driven by multi-slice 2D physics

```
┌─ 3D RENDER LAYER (reuses layout3d / field-render / coil-render) ───────┐
│  Draggable, pannable motor. Extrudes the 2D geometry axially; draws     │
│  magnets, teeth, windings (end-turns = the arcs joining go/return       │
│  slots), shaft. Paints gap field on each cross-section plane.           │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ geometry + per-slice field (for viz)
┌───────────────┴── PHYSICS: one or more 2D PLANAR ENGINES (slices) ──────┐
│  Slice interface:  { torque, fluxLinkages } = solve(θ_rotor, currents)  │
│  Slice engine = level-5 thin-annulus solve, two explicit modes:         │
│      • Live (fast)     — coarse grid, real-time, interactive            │
│      • Detailed (slow) — fine field + nonlinear saturation (Web Worker) │
│  Total torque = Σ slices.  Circuits coupled across slices.               │
└───────────────────────────────────────────────────────────────────────┘
```

- **Most machines = 1 slice.**
- **Hybrid stepper = 2 superposed slices**: same shaft (rigid, identical
  θ_rotor), offset by half a tooth pitch, opposite DC bias from a shared axial
  PM (flux source in series through the back iron). Net torque =
  `T_A(θ) + T_B(θ + half-pitch)`.
- **Skew (bonus):** N slices each rotated by a skew increment, summed — a free
  tool for "why are rotor bars skewed?".

The slice is the unit of physics; the 3D layer never knows which machine it is
drawing. The slice engine choice does not change the 3D layer or the axial
superposition logic.

## UI

- **Graphical winding editor on the cross-section.** You wire conductors
  directly into the slots of the same 2D slice the solver integrates. Lay a
  conductor → the MMF bump appears in `F(θ)` live; pole count and back-EMF
  readouts update.
  - **Concentrated (C):** tap a tooth, wrap direction sets N/S sense.
  - **Distributed (W):** free conductor routing in every slot — click
    go-slot → return-slot (or trace terminal→slot→…→terminal); direction
    inferred from traversal. Each slot shows the conventional dot/cross glyph,
    coloured by phase.
- **External circuit = separate schematic panel** beside the cross-section:
  phase terminals, star/delta node, cap-start capacitor, source/commutator
  assignment. (The in-slot conductors are the cross-section; how their *ends*
  tie together is the schematic.)
- **3D end-windings for free:** connecting go-slot i to return-slot j over the
  end of the stack *is* the end-winding; the 3D render draws those arcs.

### Pedagogy unlocked (emergent, not scripted)

Star vs delta (a routing/node choice) · short-pitch/chording (watch harmonics
drop out of `F(θ)`) · single vs double layer · cap-start aux winding ·
single-phasing fault (open one phase, watch the rotating field collapse to
pulsating) · pole/slot mismatch giving no net torque.

## Hardware / performance

- **Live mode (default, CPU, main thread):** the level-5 grid on a coarse
  polar mesh (~256 × 8–16), PCG + warm-start, ~few ms/solve. The "3D" render is
  a plain 2D canvas with manual projection (`layout3d`) — no WebGL, no GPU
  compute. Runs on any laptop/Chromebook/lab PC.
- **Detailed mode (CPU, Web Worker):** the *same* level-5 solve at higher
  resolution (graded slot mouths + fillets) or with teeth-in-domain μ(B) — **as
  fine as is realistic on the CPU**. Entered by the explicit toggle; being slow,
  it runs in a **Web Worker** (e.g. a per-angle table rebuilt on geometry
  change) so the UI stays responsive. Still CPU.
- **Rejected — a GPU/WebGL compute tier (out of scope, do not reintroduce).**
  Considered and ruled out: it is hardware-gated (float render targets, iGPU
  headroom) for an uncontrolled student fleet, and as an open-ended "fine tier"
  it becomes a dumping ground for work that must instead be made to fit on the
  CPU. Fine fidelity is a CPU/Web-Worker resolution problem, not a GPU problem.
  Also rejected: CPU unstructured-mesh FEA (not real-time + reconfigurable);
  precomputed flux-linkage maps (per-geometry precompute breaks live
  reconfiguration).

## Modules

**Reuse:** `util.js`, `plot.js`, `integrate.js`, `draw.js`, `app.js` (shell),
`layout3d.js`, `coil-render.js`, `canvas-type.js`; `field-render.js` (extend
with gap-field viz).

**New:**
- field solver — level-5 thin-annulus grid (gap + openings + optional teeth),
  source/MMF stamping, iron/slot boundary masks from geometry,
  PCG+warm-start (coarse) / multigrid (fine) solve — all CPU,
  circuit-ODE coupling, Maxwell-stress torque (primary) + co-energy cross-check,
  fidelity tiers (coarse / refined+fillet / nonlinear).
- winding model — conductor routing → ampere-conductor map → winding function;
  shared by editor and solver.
- slice abstraction — wraps a cross-section into `solve(θ, i)`; multi-slice
  aggregation + axial coupling (hybrid PM, skew).
- excitation/commutation — AC/DC/pulse/step/open/short sources + commutation
  `phase = f(θ)`.
- 2D cross-section renderer (for the editor) + winding-editor UI + circuit
  schematic panel.

## Integration contract (how it lives on the on-disk shell)

- **Mount.** The app is a `{ label, mount: (host) => unmount }` tab under
  `LIB.App.runTabs` (the escape hatch at `app.js:1105`). It nests inside the
  unified outer chrome — `buildOuter()`'s `.scroll-host > .app`, the `.app-nav`
  ("← All apps" → `../../index.html`, Back/Next, title), the splash card grid
  (provide `spec.icon(ctx,W,H)`), and `shell.css` theme tokens. It does **not**
  use `_mountSpec`; the bespoke interior is built in the `host` div and torn
  down by the returned `unmount`.
- **Reused building blocks inside the mount:** `LIB.Registry.mkRow` (right-shelf
  sliders), `LIB.Plot` (bottom plots), `LIB.Type` + the `updateTypeTokens`
  pattern, `LIB.Util.fitCanvas`, the rAF + accumulator loop pattern, shell.css
  classes/tokens.
- **One app.** The 13-machine matrix is 3–4 toggles per ring (rotor/stator
  element + excitation + commutation); winding participation is edited on the
  cross-section diagram, not via the matrix.
- **Layout.** 3D viewport + two selectable cross-section views (upper 2/3),
  design/matrix right shelf, plots + readouts side-by-side (bottom 1/3).
- **Loop + solver placement.** The app runs its own rAF + accumulator loop and
  drives the field+circuit+mechanics solve imperatively (the declarative
  `dxdt` path can't hold a grid). **Live mode**: coarse solve inline on the main
  thread. **Detailed mode**: the heavy accurate solve in a Web Worker — the
  Live/Detailed toggle (a header control) is the worker boundary, no per-frame
  cost-checking.
- **State tiers (sets Reset semantics).** *True state* (integrated; Reset
  zeroes): rotor `θ, ω`; per-circuit currents `i_k`; excitation/commutation
  accumulators (AC phase, step index); `t`. *Derived each step* (not stored):
  field, `λ_k`, torque. *Config* (persists across Reset; changed only by
  editing): geometry, winding routing, circuit topology. The field is kept as a
  **warm-start cache** (recomputable; cleared on Reset and on geometry edits).
- **Pointer arbitration.** A tool/mode selector multiplexes orbit-camera vs
  rotor-drag vs wire-edit vs schematic-edit through one handler.
- **Controls split.** `Registry.mkRow` sliders for drive/load scalars (current,
  frequency, load torque, speed) in the right shelf; graphical editors for
  geometry, winding (on the cross-section), and the circuit. The circuit
  schematic is a **drag-drop component editor** (sources, capacitors, switches,
  star/delta nodes, terminals); **right-click a source → its parameter sliders**.
- **Centralization constraint.** All math lives in UI-agnostic `lib/` modules:
  pure data in (geometry, sources, state), pure data out (field, `λ`, torque),
  zero DOM/canvas/slider knowledge — so other motor apps and the eventual
  `ac_motor` migration reuse them, and the engine is testable headless.

## Implementation notes (numerical core)

- **Formulation: 2D vector potential `A_z`.** `∇·(ν∇A_z) = −J_z`. Both field
  components fall out — `B_r = (1/r)∂A_z/∂θ`, `B_t = −∂A_z/∂r` — and `A_z` is
  the flux function, so flux linkage `λ_k = (N·ℓ/A_c)∮ A_z dA` over the coil
  cross-sections is a direct readout (the circuit coupling needs it). One
  formulation spans every tier: currents (`J_z`), magnets (magnetization
  source), and saturation (`ν = ν(B)`) are all native. (Scalar `Ω` was rejected:
  multivalued around enclosed current, awkward once teeth/conductors enter the
  domain.)
- **Domain + grid.** Structured polar grid `(r,θ)` over a thin annulus (gap +
  slot openings; teeth added only in the nonlinear tier). Periodic in `θ`.
  Coarse ~256 × 8–16; refined tier grades cells at slot mouths and resolves
  tooth-tip fillets.
- **Solver (per tier).** **PCG + warm-start** (reuse the previous frame's `A_z`)
  on the coarse CPU tier — at coarse `N`, warm-started PCG beats multigrid,
  whose hierarchy overhead doesn't pay below the MG/CG crossover. **Geometric
  multigrid** on the fine (high-`N`) CPU tier. (MG coarsening is complicated here
  by jumping coefficients at moving iron boundaries, thin-annulus anisotropy →
  semi-coarsening, and polar periodicity — worth carrying at the fine tier, not
  worth it coarse.)
- **Rotor motion.** Sliding-band: shift the rotor-side boundary mask by Δθ with
  interpolation at non-integer Δθ — no remesh, operator structure preserved.
- **Circuit↔field coupling: semi-implicit.** Extract the inductance matrix
  `L(θ)` (field response to unit current per circuit); in the linear tier it is
  current-independent, so **cache it θ-binned** and refresh only when the rotor
  crosses a bin (≈ one solve/step amortized). Step the currents **implicitly**
  (`m×m` solve) — unconditionally stable in the electrical dynamics at
  interactive `dt` (explicit would blow up when `dt > L/R`). Then step
  mechanics.
- **Torque.** **Maxwell stress (primary):** `T = (r²ℓ/μ₀)∮ B_r·B_t dθ` on a
  mid-gap contour, straight from `A_z`. **Co-energy** `½iᵀ(dL/dθ)i +
  iᵀ(dλ_pm/dθ)` is cheap under semi-implicit (we already have `dL/dθ`) and is
  exposed at runtime as a **pedagogical decomposition** (reluctance vs PM vs
  mutual — which Maxwell can't separate), *not* as a runtime correctness gate.
  The Maxwell-vs-co-energy agreement, and both vs the analytic VR closed form,
  live in the **test suite** over a sweep.
- **Saturation.** Live default = **global flux-dependent ceiling** (scalar `ν`
  scaling from the B–H knee). **Detailed mode** = teeth in the domain, iterate
  `ν(B)` (nonlinear), tabulated in a Web Worker — CPU.
- **Multi-slice.** Slices share circuits (series coils across slices sum their
  `λ` contributions); total torque = Σ slices. Hybrid stepper = 2 slices,
  half-tooth-pitch offset, shared axial-PM bias. Skew = N slices each rotated by
  a skew increment.
- **Data schema (two layer).** *Semantic* objects (geometry: radii/gap/teeth/
  magnets/fillets; winding: conductors/coils/phases with series-parallel +
  terminals; circuit topology) are edited and rendered. A **compile step**
  (run on geometry/current change) turns them into the solver's grid arrays:
  the `ν` material mask, the `J_z` source map, magnetization sources, and the
  per-coil region masks for `λ` extraction. The solver only ever sees the
  compiled arrays (keeps it UI-agnostic).
- **Test harness.** Co-energy vs Maxwell over a θ sweep; grid-Maxwell vs the
  analytic salient/VR closed form; flux balance `∮ B dθ = 0`; torque/energy
  convergence vs grid resolution.

## Build sequence (full scope, ordered — not scope reduction)

1. Level-5 coarse field solver (thin-annulus grid, linear) + winding model +
   single-slice abstraction; one machine (3-φ induction or BLDC) end-to-end on
   the shared shell, with the co-energy vs Maxwell-stress agreement check wired
   in as a test.
2. Element/excitation/commutation vocabulary complete; reproduce all 13 matrix
   rows as configurations. Validate VR/SRM reluctance torque against the
   closed-form salient case.
3. Graphical winding editor on the cross-section + external-circuit schematic.
4. Multi-slice: hybrid stepper (2 slices) + skew.
5. Detailed mode: slot-mouth grading + tooth-tip fillets (+ optional conformal
   corner patch) for quantitative cogging/detent, in a Web Worker.
6. Saturation: global ceiling (Live mode) + nonlinear teeth-in-domain (Detailed
   mode, Web Worker); 3D render polish + field-viz mode in `field-render.js`.
