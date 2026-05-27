# Phase 4: Harmonic-gap sliding interface

## Overview

Build the analytic air-gap harmonic coupling (`fea-engine-rebuild.md` §3.3, §9,
milestones G0–G4) as `lib/airgap-harmonic.js`. This is the sliding interface for
rotor motion: there is **no sliding mesh** — rotation is a single phase parameter
`φ` and the sparsity pattern is φ-invariant, so the FEA `analyze()` (Phase 1)
stays one-time (binding constraint §11.1#3).

The module is a self-contained, DOM-free, machine-agnostic **air-gap element**.
It consumes only the two uniform-Δθ `gapLoop` circles the Phase-2 mesher emits
(`{gapTheta, gapR}` per body — §8 / §9-G0 handoff), a harmonic truncation `K`,
and the axial length `ell`. It reads **only numbers** — no `config-schema`
features, no winding routing, no machine name or type (binding constraint
§11.1#1, satisfied trivially because the module never sees a feature list). It
produces:

- an **FFT projection** per circle (nodal `A` ↔ real cos/sin harmonics) — G1;
- a **per-harmonic 2×2 annulus admittance** `M_k(r_mr, r_ms, k)` from the
  source-free `r^{±k}` Laplace solution — G2;
- the **bordered coupling** stamped into Phase 5's global system as triplets over
  a local DOF space `[rotor gap nodes | stator gap nodes | 2(2K+1) harmonic
  DOFs]`, with the rotor↔stator cross-terms phase-rotated by `e^{±ikφ}` — G2
  (static φ=0) / G3 (general φ);
- a **Maxwell-stress torque** from the gap harmonics — G4.

G5 (interior Schur-condensation) is **not built** in this phase: it is the
measurement-gated rotation-cost lever of §9-G5 / §11.4, undertaken only if a
Phase-5/6 measurement shows embed per-θ-step > 16 ms. Phase 4 builds the **embed**
path (G0–G4) only.

The module never assembles a global matrix and never solves a global system —
that is Phase 5. The *full* combined-system SPD factorization (binding constraint
§11.1#4: the field block stays SPD/Cholesky) can only be exercised once body
interiors exist, so it is **inherited by Phase 5**. Phase 4 verifies, in
isolation, everything that does not need an interior: the per-harmonic 2×2 `M_k`
is symmetric positive-definite, the assembled gap submatrix is symmetric, the
sparsity pattern is φ-invariant, the admittance reproduces both an analytic and
an independently-meshed annulus reference, and the harmonic torque matches an
Arkkio volume integral.

### Locked decisions for this phase (settled with the author 2026-05-26)

- **D1 — `lib/airgap-harmonic.js` is the self-contained air-gap element.**
  `LIB.AirgapHarmonic.build(rotorGap, statorGap, opts) → HarmonicGap`. Each
  `*Gap` is `{ gapTheta: Float64Array, gapR: number }` (a uniform-Δθ circle).
  The returned `HarmonicGap` exposes `project` / `reconstruct` (G1),
  `surfaceFlux` (the applied DtN admittance map — the directly-testable physics
  kernel for G2/G3), `stamp(phi)` (triplet contributions in a **local** index
  space + a `dofMap`), and `torque` (G4). Phase 5 calls `stamp(φ)`, remaps the
  local indices to its global numbering via the gapLoop→global node maps it
  already holds, and concatenates the triplets with its body-interior triplets.
  The module knows nothing of body interiors, global numbering, or the solver.

- **D2 — verification oracles are self-contained; no Phase-1 dependency.** Phase
  4 depends on **Phase 2 only**. Two oracles, both built in
  `tests/harmonic/_fixtures.js` with no `LIB.FeaSolver`:
  1. **Manufactured analytic field** (primary, no solver): a known
     `A(r,θ) = a₀ + b₀·ln r + Σ_{k≥1}[(αcₖ rᵏ + βcₖ r⁻ᵏ)cos kθ + (αsₖ rᵏ +
     βsₖ r⁻ᵏ)sin kθ]` sampled on the two circles. Validates the FFT indexing,
     the `r^{±k}` admittance algebra, the phase rotation, and the torque formula
     against closed form; exact and fast, so it carries the large-`K`
     convergence work.
  2. **Independent meshed-annulus FEM** (cross-check, self-contained **dense**
     LDLT in the fixtures, kept small — `nTheta=32`, `nRad=6`, ≈200 DOF): a
     structured-quad Laplace solve on the air annulus `[r_mr, r_ms]` with
     Dirichlet `A` on both circles, returning interior field, consistent surface
     reaction flux, and the Arkkio mid-annulus torque integral. This is the §9
     G2/G4 oracle ("mesh the gap annulus, solve, diff") as an *independent
     discretization*.

- **D3 — harmonic DOFs are real cos/sin coefficients.** The solver is real SPD,
  so each circle contributes `1+2K` real harmonic DOFs: `â₀` (the mean / `k=0`
  mode) plus `(aₖ, bₖ)` cos/sin pairs for `k=1..K`. Two circles → `2(2K+1)` real
  harmonic DOFs (matching §3.3). The rotor's `e^{±ikφ}` phase is a 2×2 rotation
  `[[cos kφ, −sin kφ],[sin kφ, cos kφ]]` acting on each rotor `(aₖ, bₖ)` pair.

- **D4 — structural (not numeric) sparsity defines φ-invariance.** `stamp(phi)`
  emits a **fixed `(I, J)` coordinate set for every `φ`** — the full 2×2
  rotor↔stator block per `k` is structurally reserved even though two of its four
  entries are numerically zero at `φ=0`. Only `V` varies with `φ`. Structural
  zeros are **never pruned** from the triplet list. This is exactly what keeps
  `analyze()` one-time (binding constraint §11.1#3).

- **D5 — `K` policy: compute, then require `N_gap ≥ 4K` (throw, do not cap).**
  `LIB.AirgapHarmonic.defaultK(slots, poles) = 3·max(slots, poles)` (§11.4).
  `build` uses `opts.K ?? <caller-supplied>` and **throws** a clear error if
  either body's `N_gap = gapTheta.length` is `< 4K` (Nyquist + margin, §11.4) —
  rather than silently capping `K`, which would hide gap under-resolution
  (silent narrowing is barred by the project execution standards). Rotor and
  stator may have **different** `N_gap` (they mesh independently); the constraint
  applies to each body, and `K` is shared. The module reads only `slots`/`poles`
  as **numbers** — deriving them from the section is the caller's job.

  **Cross-phase note (Phase 5 integration).** For the 15 real fixtures the
  Phase-2 mesh must emit enough gap nodes to satisfy
  `N_gap ≥ 4·(3·max(slots,poles))`. Phase 2's mesher exposes
  `opts.gapMinNodes` for exactly this (a hard gap-node floor, snapped to a
  multiple of the body period, overriding `dofBudget` — see the Phase-2 spec
  Collar/gap-circle geometry + Task 2.3.1). Phase 5, which knows the machine's
  slot/pole counts, computes `gapMinNodes = 4·(3·max(slots,poles))` and passes it
  to `LIB.MotorMesh.build` so the emitted `gapLoop` satisfies this module's
  `N_gap ≥ 4K` guard. If a build ever reaches `AirgapHarmonic.build` with a
  too-short `gapLoop`, it throws — the correct signal that the caller omitted
  `gapMinNodes`, **not** a cue to drop harmonics. Phase 4's own K-tuning
  convergence test runs on synthetic circles with ample `N_gap`, so this
  constraint does not bite within Phase 4.

## Public API (`LIB.AirgapHarmonic`)

```
LIB.AirgapHarmonic.defaultK(slots, poles) → number      // = 3·max(slots,poles)

LIB.AirgapHarmonic.build(rotorGap, statorGap, opts) → HarmonicGap
  rotorGap  = { gapTheta: Float64Array(Ngr), gapR: r_mr }   // uniform-Δθ circle
  statorGap = { gapTheta: Float64Array(Ngs), gapR: r_ms }   //   r_mr < r_ms
  opts      = { K: int≥1 (required),
                ell: number>0 (required, for torque),
                mu0?: number (default 4π·1e-7) }
  // Throws if Ngr < 4K or Ngs < 4K (D5), or if r_mr ≥ r_ms.
```

`HarmonicGap` (returned object):

- `K`, `nGapRotor` (=Ngr), `nGapStator` (=Ngs), `nHarmonicDofs` (=`2·(2K+1)`).
- `dofMap` — `{ gapRotor:{base:0, count:Ngr}, gapStator:{base:Ngr, count:Ngs},
  harmonics:{ base:Ngr+Ngs, count:2·(2K+1), perBody:2K+1,
  layout:["a0","a1","b1",…,"aK","bK"], bodies:["rotor","stator"] } }`.
- `project(gapTheta, Anodal) → { a: Float64Array(K+1), b: Float64Array(K+1) }` —
  real DFT to the truncated cos/sin basis with the convention
  `A(θ) = a[0] + Σ_{k=1..K} a[k]·cos(kθ) + b[k]·sin(kθ)` (`b[0] === 0`). `Anodal`
  is sampled at the uniform `gapTheta` of the relevant circle.
- `reconstruct({a, b}, gapTheta) → Float64Array` — evaluate the truncated series
  at the supplied `gapTheta` (inverse of `project`).
- `surfaceFlux(ArotorGapNodal, AstatorGapNodal, phi) → { rotor: Float64Array(Ngr),
  stator: Float64Array(Ngs) }` — projects both circles, applies the per-`k`
  admittance with the rotor phase `φ`, and returns the nodal radial surface flux
  (the Dirichlet-to-Neumann map) on each circle. This is the applied-admittance
  physics kernel; `stamp`, after eliminating the harmonic DOFs, encodes the same
  operator over the gap nodes.
- `stamp(phi) → { n, I, J, V }` — full-symmetric triplets (the Phase-1 solver
  convention) over the local DOF space described by `dofMap`. `n = Ngr + Ngs +
  2·(2K+1)`. `I`,`J` are `Int32Array`, `V` is `Float64Array`. The `(I, J)`
  coordinate set is **identical for every `φ`** (D4); only `V` changes.
- `torque(ArotorGapNodal, AstatorGapNodal, phi) → number` — Maxwell-stress
  torque about the rotor axis in body-frame (positive sign = torque
  accelerating the rotor in the +θ direction).

  Compute (in this order):
    1. Project each circle: `R = project(rotorGapTheta, ArotorGapNodal)`,
       `S = project(statorGapTheta, AstatorGapNodal)` →
       `R.a`/`R.b`/`S.a`/`S.b` are real cos/sin coefficients per the D3
       convention.
    2. Apply the rotor phase: for each `k = 1..K`,
       `Rrot.a[k] = R.a[k]·cos(k·phi) - R.b[k]·sin(k·phi)`,
       `Rrot.b[k] = R.a[k]·sin(k·phi) + R.b[k]·cos(k·phi)`.
       (`R.a[0]` and `R.b[0]` are not phased — the k=0 mode carries no
       net rotor↔stator torque.)
    3. Per-harmonic Maxwell-stress contribution:
       ```
       dT_k = (2π · k² · ell / μ0) · (Rrot.a[k] · S.b[k] − Rrot.b[k] · S.a[k])
                                    / [(r_ms / r_mr)^k − (r_mr / r_ms)^k]
       ```
       where `r_mr = rotorGap.gapR` and `r_ms = statorGap.gapR`. The
       denominator `[(r_ms/r_mr)^k − (r_mr/r_ms)^k]` is the algebraic
       residual of evaluating the source-free `r^{±k}` Laplace admittance
       at the two circles — it normalises the `R, S` potential Fourier
       coefficients so the formula equals the true Maxwell-stress
       (Arkkio) volume integral exactly, independent of the choice of
       evaluation circle in the gap. Positive `dT_k` accelerates the
       rotor in +θ.
    4. `T = Σ_{k=1..K} dT_k`. Return as a single `number`.

  This formula is the algebraic identity that makes the harmonic torque
  agree with the Maxwell-stress line integral on any closed gap circle
  for an arbitrary source-free Laplace field on the annulus. The
  `annulusOracle`'s Arkkio integral evaluated at inner, outer, or any
  intermediate radius agrees with this formula's result to within
  discretisation error (the `2%` cross-method bar of §11.3, set by the
  oracle's `O((2π/nTheta)²)` element error).
- `_internals` — a test-only hatch (documented as test scaffolding, **not**
  part of the production contract; production callers must not depend on
  it): exposes `Mk(k) → [[m00, m01], [m10, m11]]`, returning the 2×2
  per-harmonic admittance matrix the build assembled for harmonic order
  `k ∈ [1, K]`. Used by `admittance.test.js` to assert symmetry and
  positive-definiteness on the **assembled** matrix (catching assembly /
  indexing regressions distinct from formula derivation errors).

## Files Owned

- `lib/airgap-harmonic.js` — created (T4.1.1: `build`/`defaultK`/`project`/
  `reconstruct`/`surfaceFlux`/`stamp(0)`/`M_k`; T4.2.1: `e^{±ikφ}` phase in
  `stamp(φ)` + `torque`)
- `tests/harmonic/_fixtures.js` — created (T4.1.1; loader + manufactured-field
  oracle + dense meshed-annulus oracle + helpers — front-loaded for both waves)
- `tests/harmonic/projection.test.js` — created (T4.1.1; G1 + build/K validation)
- `tests/harmonic/admittance.test.js` — created (T4.1.1; G2)
- `tests/harmonic/handoff.test.js` — created (T4.1.1; G0 mesher-gapLoop handoff)
- `tests/harmonic/rotation.test.js` — created (T4.2.1; G3)
- `tests/harmonic/torque.test.js` — created (T4.2.1; G4 + K-tuning convergence)

> `lib/airgap-harmonic.js` is created by T4.1.1 (Wave 4.1) and extended by T4.2.1
> (Wave 4.2). The two waves run sequentially, so there is no file-lock contention;
> the manifest places them in separate task groups (`4.1.a`, `4.2.a`).
>
> The file-locality review rule's sequential-wave carve-out (documented in
> `spec/.context/rules.md`) covers this pattern explicitly. The two waves
> cannot hold a lock on the same file at the same wall-clock instant
> because Wave 4.2 only starts after Wave 4.1 completes; the manifest
> places the per-wave groups in distinct task_groups (`4.1.a`, `4.2.a`)
> on purpose so each wave is its own coherent agent-sized chunk.

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 4.1: FFT projection + per-harmonic admittance + static coupling (G0+G1+G2)

### Task 4.1.1: Projection, per-harmonic admittance, static-φ bordered coupling

- **Description**: Create `lib/airgap-harmonic.js` (IIFE attaching
  `window.LIB.AirgapHarmonic`) implementing **G0** (consume the uniform circle;
  `defaultK`; `build` with the `N_gap ≥ 4K` guard of D5), **G1** (the real
  cos/sin FFT `project`/`reconstruct` per circle, D3), and **G2** (the
  per-harmonic 2×2 annulus admittance `M_k(r_mr, r_ms, k)` from the source-free
  `r^{±k}` Laplace solution; the applied-admittance `surfaceFlux` map; and the
  **static-rotor (φ=0)** bordered `stamp` over the local DOF space of `dofMap`).
  The `k=0` mode is the constant/`ln r` mode (carries no net rotor↔stator torque)
  and is handled without producing `NaN`. Create the test fixtures and the
  Wave-4.1 test files. **Reads only numbers — no feature list, no machine
  identity.**

- **Files to create**:
  - `lib/airgap-harmonic.js` — IIFE; the full public API above with `stamp`
    implemented for the static `φ=0` case (the `e^{±ikφ}` phase is added in
    T4.2.1, but the `(I,J)` structure — including the full 2×2 rotor↔stator
    blocks per `k` — is laid out now per D4, with the off-diagonal-of-the-2×2
    entries present and zero-valued at `φ=0`). DOM-free; no top-level
    `require`/`import`. `mu0` module constant `4·Math.PI·1e-7`.
  - `tests/harmonic/_fixtures.js` — `"use strict";` `if (!globalThis.window)
    globalThis.window = globalThis;` then `require("../../lib/airgap-harmonic.js")`;
    `const AH = window.LIB.AirgapHarmonic;`. Also requires (for `handoff.test.js`)
    `../../lib/util.js`, `../../lib/winding-model.js`,
    `../../lessons/unified_motor/config-schema.js`, `../../lib/motor-mesh.js`.
    Exports:
    - `uniformCircle(N, R) → { gapTheta: Float64Array(N), gapR: R }` with
      `gapTheta[i] = 2π·i/N`.
    - `manufactured(coeffs) → { sample(r, gapTheta) → Float64Array,
      dAdr(r, gapTheta) → Float64Array, surfaceFluxAt(r) → … }` — the analytic
      annulus field of D2.1: `coeffs = { a0, b0, ac:[…], bc:[…], as:[…], bs:[…] }`
      (interior `r^{+k}` amplitudes `ac`/`as`, exterior `r^{-k}` amplitudes
      `bc`/`bs`, per harmonic `k=1..Kc`). `sample` evaluates `A`, `dAdr` evaluates
      `∂A/∂r` (the radial flux density up to the `1/μ0` factor) at the nodes.
    - `annulusOracle({ rIn, rOut, nTheta, nRad, ell, mu0 }) → { solve }` — the
      self-contained dense meshed-annulus FEM of D2.2. `solve(aInnerNodal,
      aOuterNodal) → { fluxInner: Float64Array(nTheta), fluxOuter:
      Float64Array(nTheta), torque: number }`: builds a structured `nTheta×nRad`
      quad mesh on `[rIn,rOut]`, assembles the `ν=1/μ0` Laplace stiffness, imposes
      the uniform-θ Dirichlet boundary nodal values, dense-solves the interior,
      and returns the consistent nodal reaction flux on each circle plus the
      Arkkio mid-annulus Maxwell-stress torque. Inner/outer node ordering is the
      same uniform-θ ordering as `uniformCircle(nTheta, …)`.
    - `denseSolveSPD(nLocal, I, J, V, b) → Float64Array` — a small dense
      symmetric solver (LDLT or Gaussian elimination) used to drive a `stamp`
      result for the stamp↔surfaceFlux consistency test (operates on the local
      augmented system only).
    - `assertClose(actual, expected, tol, msg)` and `relErrInf(x, ref) → number`.
    - `patternKeys(stampResult) → Set<string>` — `"i,j"` strings for every
      triplet (for the φ-invariance assertion in T4.2.1; exported here so both
      waves share it).
    - `loadFixture(id) → { config }` — requires `lessons/unified_motor/machines/
      <id>.js` and returns its `UnifiedMotor.MACHINES` entry; and
      `gapLoopsFromConfig(config) → { rotorGap, statorGap, slots, poles }` —
      runs `CS.expand(config)` (`CS = UnifiedMotor.ConfigSchema`), takes
      `expanded.slices[0].section`, builds the mesh via
      `LIB.MotorMesh.build(section)`, and returns each body's
      `{ gapTheta, gapR }`, plus `poles = expanded.poles`, plus
      `slots = Math.max(1, ...expanded.slices[0].section.features
        .map(function (f) { return f.angularCount || 1; }))`. The derivation
      reads from the **compiled feature list** (not raw `config.rings`) so
      it matches the source Phase 5 also uses for its own `slots` derivation
      (Phase 5 D8) — keeping the Phase-4 and Phase-5 `K = defaultK(slots,
      poles)` calculations in lockstep on every fixture.
  - `tests/harmonic/projection.test.js` — `node:test` + `node:assert/strict`.
  - `tests/harmonic/admittance.test.js` — `node:test` + `node:assert/strict`.
  - `tests/harmonic/handoff.test.js` — `node:test` + `node:assert/strict`.

- **Files to modify**: none.

- **Tests**:
  - `tests/harmonic/projection.test.js`:
    - `"defaultK is 3·max(slots,poles)"` — `AH.defaultK(12, 4) === 36`,
      `AH.defaultK(4, 12) === 36`, `AH.defaultK(8, 8) === 24`.
    - `"build requires N_gap ≥ 4K on each body"` — with `K=10`, building from
      `uniformCircle(40, r_mr)` + `uniformCircle(40, r_ms)` succeeds; building
      with a rotor `uniformCircle(32, r_mr)` (Ngr=32 < 40) **throws** an `Error`
      whose message contains `"N_gap"` and `"4K"` (or `"40"`); likewise a short
      stator circle throws.
    - `"build reports DOF layout"` — for `K=10`, `nHarmonicDofs === 2*(2*10+1)
      === 42`; `dofMap.harmonics.perBody === 21`; `dofMap.gapRotor.base === 0`;
      `dofMap.gapStator.base === Ngr`; `dofMap.harmonics.base === Ngr+Ngs`.
    - `"build accepts different rotor/stator N_gap"` — rotor `uniformCircle(48,…)`,
      stator `uniformCircle(64,…)`, `K=10` (both ≥40) → builds; `nGapRotor===48`,
      `nGapStator===64`.
    - `"build rejects r_mr ≥ r_ms"` — rotor `gapR=0.045`, stator `gapR=0.044`
      throws.
    - `"project/reconstruct round-trips a band-limited field to < 1e-8"` —
      manufactured field with content only at `k ≤ K`; sample on
      `uniformCircle(N, r)` (`N ≥ 4K`); `relErrInf(reconstruct(project(Anodal),
      gapTheta), Anodal) < 1e-8` (the §11.4 FFT round-trip bar).
    - `"project recovers known cos/sin amplitudes"` — for
      `A(θ)=3 + 2cos(2θ) − 5sin(3θ)`, assert `a[0]≈3`, `a[2]≈2`, `b[3]≈−5`,
      every other `a`/`b` within `1e-9` of `0`.
  - `tests/harmonic/admittance.test.js`:
    - `"M_k is symmetric for each k"` — for `k=1..K`, `M = harmonicGap._internals.Mk(k)`
      is the 2×2 assembled admittance the build produced for harmonic order
      `k`. Assert `Math.abs(M[0][1] - M[1][0]) < 1e-12` (symmetry holds on the
      matrix the module actually uses — catches assembly/indexing errors that
      a formula recomputation would silently confirm).
    - `"M_k is positive-definite for k ≥ 1"` — `det(M) > 0` and
      `trace(M) > 0` for `k=1..K`, where `M = harmonicGap._internals.Mk(k)`.
    - `"surfaceFlux matches the analytic ∂A/∂r"` — manufactured field with mixed
      harmonics; `surfaceFlux(Arotor, Astator, 0)` on each circle equals the
      analytic radial flux `(1/μ0)·∂A/∂r` sampled at that circle within
      `relErrInf < 1e-6`.
    - `"surfaceFlux matches the independently-meshed annulus"` — same
      manufactured boundary data fed to `annulusOracle.solve`; the harmonic
      `surfaceFlux` agrees with the FEM `fluxInner`/`fluxOuter` within
      `relErrInf < 2e-2` (independent-discretization tolerance at `nTheta=32`,
      `nRad=6`).
    - `"stamp(0) is symmetric"` — for every triplet `(i,j,v)` in `stamp(0)` there
      is a `(j,i)` triplet with equal `v` within `1e-12` (accumulating duplicate
      coordinates first).
    - `"stamp reproduces surfaceFlux"` — assemble `stamp(0)` over the local
      augmented DOFs, pin the gap-node DOFs to the manufactured boundary nodal `A`
      (Dirichlet), `denseSolveSPD` for the harmonic DOFs, and assert the recovered
      per-circle nodal flux matches `surfaceFlux(…,0)` within `relErrInf < 1e-9`
      (the stamp and the applied-admittance map encode the same operator).
  - `tests/harmonic/handoff.test.js`:
    - `"consumes a real mesher gapLoop (pmsm)"` — `gapLoopsFromConfig` on the
      `pmsm` fixture; assert each body's `gapTheta` is uniform (successive diffs
      equal within `1e-9`, spanning `[0,2π)`) and `rotorGap.gapR <
      statorGap.gapR`. Choose `K = Math.max(1, Math.floor(Math.min(Ngr,Ngs)/4))`
      (test-local, so the real gap-node count is honored regardless of mesher
      resolution); `build(rotorGap, statorGap, {K, ell:0.10})` succeeds;
      `project(rotorGap.gapTheta, <nodal samples>)` then `reconstruct`
      round-trips a band-limited field within `1e-8`.
    - `"stamp and torque run on the real gapLoop"` — with the same build,
      `stamp(0.3)` returns finite `I`/`J`/`V` of equal length, and
      `torque(<rotor nodal>, <stator nodal>, 0.3)` returns a finite number.

- **Acceptance criteria**:
  - `LIB.AirgapHarmonic.build` validates `N_gap ≥ 4K` per body and throws (does
    not cap `K`) otherwise; `defaultK(slots,poles) === 3·max(slots,poles)`.
  - `project`/`reconstruct` round-trip a band-limited field to `< 1e-8` and
    recover known cos/sin amplitudes (D3 packing: `a[0]` mean, `(a[k],b[k])`
    cos/sin).
  - Each `M_k` (`k≥1`) is symmetric positive-definite; `surfaceFlux` matches both
    the analytic `∂A/∂r` (`< 1e-6`) and the independently-meshed annulus
    (`< 2e-2`); `stamp(0)` is symmetric and, when solved with pinned gap nodes,
    reproduces `surfaceFlux` (`< 1e-9`).
  - The module consumes a real Phase-2 `gapLoop` and round-trips on its uniform
    `gapTheta`.
  - `lib/airgap-harmonic.js` is a classic DOM-free script attaching
    `LIB.AirgapHarmonic`, containing no machine name, machine-type enum, or
    machine-identity branch (it reads only numeric inputs).
  - All listed tests pass.

---

## Wave 4.2: Rotation phase, torque, truncation tuning (G3+G4)

### Task 4.2.1: `e^{±ikφ}` phase, φ-invariant sparsity, harmonic torque, `K` tuning

- **Description**: Extend `lib/airgap-harmonic.js` with **G3** (the `e^{±ikφ}`
  phase on the rotor↔stator cross-terms — the 2×2 rotation of D3 — so `stamp(φ)`
  and `surfaceFlux(…, φ)` reflect rotor rotation; the `(I,J)` pattern stays
  φ-invariant per D4) and **G4** (the Maxwell-stress `torque` from the gap
  harmonics). Add the Wave-4.2 test files: φ-invariance + field rotation (G3),
  and torque cross-check + radius behavior + `K`-tuning convergence (G4, §11.4).

- **Files to create**:
  - `tests/harmonic/rotation.test.js` — `node:test` + `node:assert/strict`.
  - `tests/harmonic/torque.test.js` — `node:test` + `node:assert/strict`.

- **Files to modify**:
  - `lib/airgap-harmonic.js` — implement the `φ`-dependent values in `stamp(phi)`
    (the rotor↔stator 2×2 cross-blocks rotated by `[[cos kφ, −sin kφ],[sin kφ,
    cos kφ]]`; the `(I,J)` coordinate set unchanged from `stamp(0)` per D4), make
    `surfaceFlux` honor `φ` consistently, and implement `torque` (the harmonic
    Maxwell-stress sum). No change to the public API signatures.

- **Tests**:
  - `tests/harmonic/rotation.test.js`:
    - `"sparsity pattern is φ-invariant"` — for `φ ∈ {0, 0.31, 1.07, 2.5}`,
      `patternKeys(stamp(φ))` are all equal as sets (assert pairwise `Set`
      equality of the `"i,j"` keys).
    - `"values change with φ"` — the `V` array of `stamp(1.07)` differs from
      `stamp(0)` in at least one entry by `> 1e-9` (the cross-terms rotated),
      while `stamp(0)` and `stamp(2π)` agree within `1e-9` (period).
    - `"phase φ equals physically rotating the rotor boundary"` — pick a
      manufactured rotor field; build `Arotor_rot` by sampling that field at
      `θ − φ` on the rotor circle (a physical rotation). Assert
      `surfaceFlux(Arotor, Astator, φ).stator` equals
      `surfaceFlux(Arotor_rot, Astator, 0).stator` within `relErrInf < 1e-6`
      (applying the phase to the coupling ≡ rotating the rotor source).
    - `"field rotates correctly vs a remeshed-at-φ annulus"` — the dense
      `annulusOracle` solved with the rotor Dirichlet data rotated by `φ` (and
      stator data fixed) yields a stator surface flux matching
      `surfaceFlux(Arotor, Astator, φ).stator` within `relErrInf < 2e-2`.
  - `tests/harmonic/torque.test.js`:
    - `"harmonic torque matches the meshed Arkkio integral"` — a loaded
      manufactured field (non-zero rotor↔stator cross-spectrum at several `k`);
      `torque(Arotor, Astator, φ)` agrees with `annulusOracle.solve(...).torque`
      within `2%` relative (§11.3 cross-method bar), at `φ ∈ {0, 0.4}`.
    - `"torque is radius-independent in the oracle"` — the `annulusOracle`
      Maxwell-stress evaluated at the inner vs outer integration radius agrees
      within `2%` (validates the oracle the harmonic torque is checked against).
    - `"zero cross-spectrum gives zero torque"` — a field whose rotor and stator
      harmonics share no common order `k` (orthogonal spectra) gives
      `|torque| < 1e-9·(scale)` (no interacting harmonics → no torque).
    - `"torque is K-converged once K exceeds the spectral content"` — a
      manufactured loaded field with content only at `k ≤ K₀` (e.g. `K₀=8`);
      build at `K=K₀` and `K=Math.ceil(1.5·K₀)` (both with `N_gap ≥ 4·K`); assert
      `|T(1.5K₀) − T(K₀)| / |T(1.5K₀)| < 0.5%` and that an out-of-band
      (`k>K₀`) cogging-like measure stays `< 1%` (§11.4 truncation criterion: no
      spurious high-`K` contribution).
    - `"requires N_gap ≥ 4K (Nyquist margin)"` — building the `K=Math.ceil(1.5·K₀)`
      case with `N_gap = 4K₀` (< 4·1.5K₀) **throws** (the D5 guard interacts with
      the tuning sweep).

- **Acceptance criteria**:
  - `stamp(φ)` has a φ-invariant `(I,J)` coordinate set across `φ ∈ {0, 0.31,
    1.07, 2.5}`; its values change with `φ`; it is `2π`-periodic (D4 + binding
    constraint §11.1#3).
  - Applying the phase `φ` to the coupling reproduces a physical rotor rotation
    (`surfaceFlux` test `< 1e-6`) and matches a remeshed-at-`φ` annulus
    (`< 2e-2`).
  - `torque` matches the meshed Arkkio integral within `2%` at loaded operating
    points, is zero for orthogonal spectra, and is `K`-converged (`< 0.5%` torque
    change / `< 1%` cogging-like change) once `K` exceeds the field's spectral
    content per §11.4.
  - All listed tests pass.

## Out of Scope (Phase 4)

- FEM assembly of the body interiors, the global SPD operator, and the global
  solve (Phase 5) — Phase 4 stamps the gap element only and verifies it in
  isolation; the **combined-system SPD/Cholesky factorization is inherited by
  Phase 5** (binding constraint §11.1#4).
- The §9-G5 interior Schur-condensation rotation-cost lever — measurement-gated
  (§11.4), built in Phase 5/6 only if `embed` per-θ-step > 16 ms.
- Coupling the harmonic gap to `MotorCircuit` / `extractCoeffs` (Phase 5,
  staggered — binding constraint §11.1#4).
- The analytic in-gap field render `A(r,θ)` for the unmeshed annulus (Phase 6
  R5).
- Ensuring the Phase-2 mesher emits `N_gap ≥ 4K` for the 15 real fixtures — a
  Phase-5 integration responsibility: Phase 5 passes
  `opts.gapMinNodes = 4·(3·max(slots,poles))` to `LIB.MotorMesh.build` (the knob
  added in Phase 2 Task 2.3.1). Phase 4 throws if the guard is violated rather
  than absorbing it (see the D5 cross-phase note).

## Amendments (2026-05-28) — torque formula correction

The original torque formula in the Public API (`dT_k = (π·r_eval²·ell/μ0)·k·(R.a·S.b − R.b·S.a)` evaluated at `r_eval = (r_mr + r_ms)/2`) was off by a geometric factor `r_eval²·[(r_ms/r_mr)^k − (r_mr/r_ms)^k] / (2k)` relative to the true Maxwell-stress (Arkkio) volume integral on a closed circle in the gap. For the standard Phase-4 test geometry (r_mr=0.040, r_ms=0.045, k=1) that factor evaluates to ~2.13×10⁻⁴, i.e. the original formula was ~4690× too small. The discrepancy was discovered by the T4.2.1 implementer when the `"harmonic torque matches the meshed Arkkio integral"` acceptance test failed by exactly that ratio, and independently reproduced from first principles by the coordinator.

The corrected formula
```
dT_k = (2π · k² · ell / μ0) · (R.a[k] · S.b[k] − R.b[k] · S.a[k])
                             / [(r_ms / r_mr)^k − (r_mr / r_ms)^k]
```
is the algebraic identity: substitute the source-free Laplace solution
`A(r,θ) = (α·r^k + β·r^(-k))·cos(kθ) + (γ·r^k + δ·r^(-k))·sin(kθ)` into the Arkkio integral, expand `R.a[k] = α·r_mr^k + β·r_mr^(-k)`, etc., and the geometric denominator falls out exactly. Both expressions reduce to `(2π·k²·ell/μ0)·(βγ − αδ)`, which is the radius-independent Maxwell-stress torque the spec note correctly anticipated. The original guarantee — that the formula is independent of the choice of integration radius — is preserved by the corrected form.

## Amendments (2026-05-27)

- **`2%` cross-method bar — discretization-error basis.** The harmonic-gap
  vs. dense-FEM-annulus oracle test at `nTheta=32` cross-checks two
  numerically-distinct methods. The 2% tolerance accounts for: (a) the
  harmonic gap's truncation at `K = 3·max(slots, poles)` which carries a
  trailing error of `O(1/(N_gap·K^q))` for q-smooth fields (typically
  q≈2 for slot-induced fields), and (b) the dense annulus's
  `O(h^2) = O((2π/32)^2) ≈ 4%` worst-case discretization error in a
  linear element. The 2% bar is therefore the order-of-magnitude minimum
  of the two methods' independent errors; tighter would be optimistic
  about either method's accuracy at the test mesh size, looser would
  let real bugs through. If the test starts failing, the response is to
  either tighten the test mesh (raise nTheta to 64+) or to accept the
  failure as evidence of a real method-vs-method disagreement, never to
  widen the bar.
