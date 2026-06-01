# The angular Parseval measure π in the harmonic-gap engine

**Question.** The §9 harmonic sliding-gap DtN operator is claimed to be
"pointwise / per-radian; its energy form omits the angular Parseval measure
∫₀^{2π}cos²(kθ) dθ = π." Which of {flux-linkage λ / back-EMF e, co-energy
torque, Arkkio torque, electromechanical power e·i} inherit that π and which do
not? Is there a single self-consistent assignment that satisfies all three
numerical pins?

This is a **read-only physics derivation**. No code change is recommended; the
final section states the physics verdict and the resolution options.

---

## 0. Notation and the basis the code uses

Every gap-surface potential is represented by the **real DFT** in
`airgap-harmonic.js` `project` (lines 38–58):

```
A(θ) = a₀ + Σ_{k≥1} [ a_k cos(kθ) + b_k sin(kθ) ]          (D3 basis)
```

with `a_k = (2/N) Σ_i A_i cos(kθ_i)`, `b_k = (2/N) Σ_i A_i sin(kθ_i)`
(lines 55–56). This is the **standard amplitude convention** (the physical peak
of mode k is `√(a_k²+b_k²)`), *not* an L²-orthonormal one. Consequently the
inner product of two single-mode fields carries the measure

```
∫₀^{2π} cos²(kθ) dθ = π            (k ≥ 1)        [numerically verified: =π for k=1,2,3,5]
∫₀^{2π} sin²(kθ) dθ = π
∫₀^{2π} 1·1   dθ = 2π              (k = 0)
∫₀^{2π} cos(kθ)cos(lθ) dθ = 0      (k ≠ l)
```

So a quantity is "per-radian / coefficient-wise" if it is built from the
amplitude products `a_k, b_k` **without** an `∫dθ`; it is an "energy/stress
integral" if it integrates a field *product* around the circle and therefore
picks up the `π` (k≥1) or `2π` (k=0) per mode.

The three quantities below are classified by **what kind of integral each one
is**, then the π is read off from the code.

---

## 1. Flux linkage λ_k and back-EMF e_k = dλ_k/dt — a LINE integral (NO π)

### What the code computes

`motor-slice.js` `fluxLinkagesFromFullAInto` (lines 3140–3217):

```
λ_k = ℓ · Σ_{e : srcId(e)=k} turns_eff(e) · Ā_e               (line 3171, 3215)
      Ā_e = element-area-averaged nodal A   (≈ (1/area)∫_e A dA)
```

This is the discrete realisation of the **Stokes / Ampère loop integral** of the
vector potential through each conductor's winding function:

```
λ_k = ℓ ∮_{coil k} A · dl = ℓ ∬ turns_density_k(x) · A(x) dA          (1.1)
```

A flux linkage is the value of the field **at the conductor location**, weighted
by the winding function, summed over conductors. It is **linear in A**. There is
**no integral over the gap circle of a product of two gap-harmonic amplitudes** —
the only integral is the conductor-area average, which is a sampling of A, not a
Parseval sum. **Therefore λ carries no Parseval π.** The code says exactly this
in the comment at lines 3208–3214:

> "Flux linkage is the physical loop integral of A (λ = ℓ·∮A·dl … correct as-is
> with no π … The harmonic-gap energy-measure π lives ONLY in the co-energy
> TORQUE … NOT here on the λ readout."

### Numerical pin (given)

> "λ measured physical: π·(λ_ratio) gives ratio 1.0 → λ has NO π (it is the raw
> Stokes value)."

i.e. the unscaled `λ` equals the independent field-side reference
`λ = N·ℓ·(Ā_go − Ā_ret)` to ratio 1.0. Multiplying λ by π would *break* that
agreement. **Confirmed: λ has measure 1 (no π).**

### Back-EMF inherits λ's measure exactly

By Faraday, the open-circuit EMF of circuit k is the **time derivative of the
same loop integral**:

```
e_k = dλ_k/dt = Σ_l (∂λ_k/∂i_l) di_l/dt + (∂λ_k/∂θ)·θ̇
    = Σ_l L_kl di_l/dt + ω·( Σ_l (dL_kl/dθ) i_l + dλ_pm,k/dθ )          (1.2)
```

where `L_kl = ∂λ_k/∂i_l` and `λ_pm,k = λ_k|_{i=0}`. The **motional** (speed)
back-EMF — the part that does electromechanical work — is

```
e_k^mot = ω·( Σ_l (dL_kl/dθ) i_l + dλ_pm,k/dθ )                          (1.3)
```

`d/dt` and `∂/∂θ` are linear operators acting on λ; **they cannot manufacture a
Parseval measure that λ itself does not have**. Since λ is the raw Stokes value
(measure 1), `dλ/dθ`, `L_kl`, `dL_kl/dθ`, `dλ_pm/dθ` are all raw (measure 1),
and **e_k = dλ_k/dt is therefore measure 1 (no π).**

This is exactly the structure `motor-circuit.js` `backEmf` (lines 211–233)
computes:

```
e[k] = GAP_MEASURE · ω · ( Σ_l dLdth[k,l]·i[l] + dLambdaPmdth[k] )       (line 230)
```

— a linear functional of the raw `dL/dθ`, `dλ_pm/dθ` coefficients
(`extractCoeffs`/`motor-stack.js`, which are central differences of raw λ,
measure 1). **The honest measure of `e` is 1.** `GAP_MEASURE` here is an
externally-applied scaling, *not* something the integral produced.

### Independent physical pin from cage synchronous speed (given)

> "With back-EMF carrying π: a squirrel-cage induction machine's synchronous
> speed comes out at ≈ ω_e/(2π); with back-EMF NOT carrying π, sync comes out at
> the physically-correct ω_e/2 = 157 rad/s (ω_e = 2π·50)."

Synchronous speed is fixed by the rotor-bar EMF balance
`e_bar = ω_slip · dλ_bar/dθ = 0 at sync`, i.e. by the **ratio of the back-EMF to
the flux-linkage derivative** that drives the bar currents. Inserting a spurious
π into `e` (but not into the λ that sets the flux geometry) rescales the slip
frequency at which the cage locks by 1/π, giving `ω_sync ≈ ω_e/(2π)` instead of
the textbook `ω_e/(p/2)` (= ω_e/2 for a 4-pole, =157 rad/s). The **physically
correct sync speed requires e to carry NO π**, in exact agreement with §1.
This is why `motor-circuit.js` line 224 currently reads
`const GAP_MEASURE = 1; // EXPERIMENT: π→1 to test cage-sync hypothesis` — the
experiment confirms e must be measure-1.

> ⚠ **Internal inconsistency flagged (not fixed):** `motor-slice.js`
> `backEmfDensity` line 3716 still uses `const GAP_MEASURE = Math.PI;` for the
> per-conductor visual back-EMF density `e_elem = π·ω·turns_eff·(∂A/∂θ)·ℓ`
> (line 3772), and its comment (lines 3713–3715, 3670–3671) asserts the density
> "carries the gap Parseval measure π." Per the derivation above and the
> cage-sync pin, the motional back-EMF carries **no** π; the slice-level density
> is therefore π× larger than the circuit `e` it claims to sum to. The two
> back-EMF sites (`motor-circuit.js` =1, `motor-slice.js` =π) disagree. This is
> reported as a physics finding only.

**Verdict (1): λ and e are LINE/LOOP integrals, linear in A → measure 1, no π.**

---

## 2. Torque — both methods, and the π between them

### 2(a). Arkkio / Maxwell-stress oracle — a STRESS integral (carries π)

`_fixtures.js` `arkkioAtRadius` (lines 333–378) computes, on a circle of radius
r in the gap:

```
T = (ℓ/μ₀) · r² · ∫₀^{2π} B_r(r,θ) · B_θ(r,θ) dθ ,   B_r=(1/r)∂A/∂θ, B_θ=−∂A/∂r   (2.1)
```

(code: `T_arkkio += r·B_r·B_θ·dθ` in the loop, then `× r·ℓ/μ₀` at line 377).
This is **an integral over the gap circle of a product of two field components** —
the textbook Maxwell-stress torque. It is therefore an **energy/stress integral
and carries the Parseval measure.**

Make the π explicit in harmonic amplitudes. For a Laplace field on the annulus,
expand at the integration radius `A(r,θ)=Σ_k[α_k cos kθ + β_k sin kθ]` (the
`a_k(r), b_k(r)` of §0). Then

```
∂A/∂θ = Σ_k k(−α_k sin kθ + β_k cos kθ),   ∂A/∂r = Σ_k(α_k' cos kθ + β_k' sin kθ)
```

Inserting into (2.1) and using the orthogonality table of §0 (every surviving
term is an `∫cos²` or `∫sin²` = **π**, cross-k terms vanish):

```
T = (ℓ/μ₀) · r · Σ_{k≥1} k · π · ( α_k' β_k − β_k' α_k )                 (2.2)
                                  └──── ∫cos²=∫sin²=π per mode ────┘
```

The single explicit **π per harmonic** is the angular Parseval measure of the
stress integral. The production harmonic-torque formula
`airgap-harmonic.js` `torque` (lines 1044–1068) is the algebraically-reduced
form of (2.2) written in terms of the *boundary* amplitudes R (rotor, r=r₁) and
S (stator, r=r₂):

```
dT_k = (2π · k² · ℓ/μ₀) · (Rrot_a·S.b − Rrot_b·S.a) / [ (r₂/r₁)^k − (r₁/r₂)^k ]   (line 1062)
```

The `2π` prefactor **is** the Parseval measure (the `π` of `∫cos²`, with the
factor 2 absorbing the way the radial-derivative/`r^{±k}` algebra recombines the
two boundary amplitudes — it is *not* an independent factor of 2 in the physics,
it is the standard reduction of (2.2)).

**Numerical proof that this formula is the exact continuum Arkkio integral
(π included):** a single-harmonic manufactured field (k=2) integrated by brute
force through (2.1) gives `T = −15999.99998…`; the production formula (line 1062)
gives `−15999.99998…`; **ratio = 0.99999999977**. The harmonic torque *is* the
Arkkio stress integral, π and all. **Arkkio torque carries π.**

### 2(b). Co-energy torque — built from λ/L (measure 1) → π× too small

`em-physics.js` `coenergyTorque` (lines 307–317) and `motor-stack.js`
`coenergyTorque` (lines 134–198) compute

```
T_co = ½ iᵀ (dL/dθ) i + Σ_k i_k dλ_pm,k/dθ + T_cog                     (2.3)
```

Here `dL/dθ` and `dλ_pm/dθ` come from `extractCoeffs` — central differences of
the **raw λ** (measure 1, §1). So the current-dependent co-energy terms are
assembled **entirely from measure-1 quantities, with no `∫dθ` over the gap
circle**. They are *coefficient-wise* products of inductance derivatives and
currents — the "per-radian DtN energy form" the spec names.

**Why exactly π× too small.** Co-energy is a field energy:
`W' = ½∫ H·B dV`, which on the gap ring is an `∫dθ` of a field product and so
carries the same Parseval π as the stress integral (§0). But the engine never
forms `W'` by integrating around the ring; it forms it from λ = ∮A·dl
(measure 1). The virtual-work torque is

```
T = ∂W'/∂θ |_i .
```

If `W'` is evaluated from the L²-correct ring integral it contains the π; if it
is evaluated coefficient-wise from λ-derived L it is missing precisely the
`∫cos²kθ dθ = π` factor that converts an amplitude-square into a ring energy.
Hence

```
T_co (coefficient-wise, from λ)  =  (1/π) · T_arkkio (stress integral)     (2.4)
```

This is exactly the empirical pin:

> "Arkkio torque ≈ π × co-energy torque (co-energy was π× too small until
> GAP_MEASURE=π was applied to it)."

and exactly what the code does to repair it — `motor-stack.js` lines 186–189:

```
var GAP_MEASURE = Math.PI;
reluctance *= GAP_MEASURE;  mutual *= GAP_MEASURE;  pm *= GAP_MEASURE;     (2.5)
```

so that `T_co · π = T_arkkio`. (The `cogging` term is *not* scaled — line 170,
182–185 — because it already comes from `gap.torque`, the full Maxwell stress
integral of §2(a), which already carries its π.)

**Note on the factor ½.** The ½ in (2.3)/(2.5) is the *energy-vs-co-energy* ½
of `½iᵀLi` (`em-physics.js` line 316). It is **independent of the Parseval π** —
it multiplies both self and mutual terms and is present whether or not the π is
applied. The Arkkio↔co-energy discrepancy is a **clean factor of π**, with no
residual factor of 2: the numerics give exactly π (not 2π, not π/2), confirming
the ½ is already correctly placed and the *only* missing measure is the single
`∫cos² = π` per mode.

**Verdict (2): Arkkio torque is a stress integral → carries π (verified ratio
1.0 to the continuum). Co-energy torque is assembled coefficient-wise from
measure-1 λ → is 1/π of Arkkio, and the code multiplies it by π to match.**

---

## 3. Electromechanical power balance e·i vs ω·T

### The exact identity (Faraday + virtual work, no hand-waving)

Magnetic co-energy `W'(i, θ)` with `λ_k = ∂W'/∂i_k`. Electrical power into the
coupling field, minus stored-energy rate, equals mechanical output:

```
Σ_k e_k i_k − dW_stored/dt = ω·T_mech                                     (3.1)
```

For a linear (or co-energy-consistent) system the **motional** part of the
back-EMF (1.3) and the virtual-work torque obey, *with one and the same measure
on λ*:

```
Σ_k e_k^mot i_k = Σ_k ω( Σ_l dL_kl/dθ i_l + dλ_pm,k/dθ ) i_k
                = ω·[ iᵀ(dL/dθ)i + iᵀ dλ_pm/dθ ]                          (3.2)
```

Compare the co-energy torque (2.3) (drop cogging, which is the i=0 detent and
cancels against the i=0 part of the energy rate):

```
ω·T_co = ω·[ ½ iᵀ(dL/dθ)i + iᵀ dλ_pm/dθ ]                                (3.3)
```

In a **cyclic steady state** `⟨dW_stored/dt⟩ = 0`, and the time-average of the
reluctance term `½iᵀ(dL/dθ)i` over a cycle relates the ½ correctly (the
self-saliency power and its energy-storage counterpart combine so that
`⟨Σ e·i⟩ = ω⟨T⟩` holds with the **same** L). The essential point for the π
question is **not the ½** (that is internal to the energy↔co-energy split and is
consistent on both sides) but the **Parseval measure carried by λ**: both `e·i`
and `ω·T_co` are built from the **same** `dL/dθ`, so **whatever measure λ
carries, it cancels in the ratio `⟨e·i⟩ / (ω⟨T_co⟩)`.** With raw λ:

```
⟨Σ e_k i_k⟩ = ω⟨T_co⟩         — holds identically, measure-1 on both sides    (3.4)
```

This is the **internally consistent** balance: e (measure 1) against the
co-energy torque (measure 1, i.e. *before* the ×π of (2.5)).

### Now substitute the measures actually in use

The engine validates torque against **Arkkio** (the stress integral, measure π,
§2a), and repairs co-energy by `T_co → π·T_co` so that

```
T_arkkio = π · T_co .                                                     (3.5)
```

Suppose we *also* tried to make `e` carry π (the "back-EMF carries π" option).
Then `e·i = π·(ω iᵀ(dL/dθ)i …)` and we would be checking `⟨π·(e·i)_raw⟩` against
`ω·T_arkkio = π·ω·T_co`. The ratio becomes:

```
⟨Σ e_k i_k⟩_{with π}      π · ⟨(e·i)_raw⟩       ⟨(e·i)_raw⟩
─────────────────────  =  ─────────────────  =  ─────────────  = 1·(π/π) = 1   (3.6)
     ω·T_arkkio              π · ω·T_co            ω·T_co
```

— so against **Arkkio**, putting π on e *appears* balanced. But that same π on e
**destroys the cage synchronous speed** (§1 pin): the bar-current loop sees
`e_bar` rescaled by π relative to the flux geometry that λ (measure 1) sets,
giving `ω_sync ≈ ω_e/(2π)` instead of ω_e/2. Conversely, with **e measure 1**
(physically correct sync speed):

```
⟨Σ e_k i_k⟩_{raw}        ⟨(e·i)_raw⟩       ω·T_co        1
──────────────────────  =  ───────────  =  ──────────  = ───            (3.7)
      ω·T_arkkio           π·ω·T_co        π·ω·T_co        π
```

**So with physically-correct (measure-1) back-EMF, the e·i power balance against
the Arkkio torque is off by exactly 1/π.**

---

## 4. Reconciliation — is there ONE self-consistent π assignment?

Collect the three hard constraints:

| # | Constraint | Forces |
|---|---|---|
| C1 | λ matches Stokes field-side reference, ratio 1.0 | **λ, e → measure 1 (no π)** |
| C2 | Arkkio = π × co-energy (verified; harmonic torque IS the stress integral, ratio 1.0) | **Arkkio → π, co-energy(from λ) → 1** |
| C3 | Cage sync speed = ω_e/2 (=157 rad/s), not ω_e/(2π) | **e → measure 1 (no π)** |

C1 and C3 **agree**: λ and e are line integrals, measure 1. C2 fixes the
torque pair: the stress integral carries π, the λ-derived co-energy does not.

The conflict is **structural and unavoidable** in the power-balance check:

```
e·i  is measure 1   (C1, C3)        →   ⟨Σ e·i⟩ = ω·T_co        (measure-1 torque)
T_arkkio is measure π (C2)          →   ⟨Σ e·i⟩ = ω·T_arkkio/π
```

These two cannot **both** equal `ω·T_arkkio`. **There is NO single scalar
measure on `e` that makes `⟨Σ e·i⟩ = ω·T_arkkio` while also keeping λ physical
and the cage sync speed correct.** Symbolically:

```
⟨Σ e_k i_k⟩  =  ω · T_co  =  ω · T_arkkio / π          (NOT ω·T_arkkio)     (4.1)
```

### The resolution (physics, not code)

The three numerical facts are **mutually consistent** once one recognises that
**`e·i` and `T_co` live on the same (measure-1) footing, while `T_arkkio` lives
on the (measure-π) stress footing**. The clean statement is:

> **The electromechanical power identity must be checked with the co-energy
> torque, not the Arkkio torque:**
> ```
>   ⟨Σ_k e_k i_k⟩ = ω·⟨T_co⟩                     ✔ measure-1 on both sides
> ```
> The Arkkio torque is the **same physical torque scaled by the basis measure**:
> `T_arkkio = π·T_co`. It is the correct *mechanical* torque to report (it is the
> true Maxwell stress, verified radius-independent and ratio-1.0 to the
> continuum), but the factor π is an artifact of the **non-orthonormal D3
> amplitude basis** (`∫cos²kθ = π`), not of the physics. The co-energy torque
> *expressed in that same amplitude basis* is `T_arkkio/π`; multiplying it by π
> (motor-stack.js:186) reconciles the two **torque** numbers — and is correct
> **for the torque**.

Therefore the **only** self-consistent assignment is:

```
λ            : measure 1   (Stokes loop integral)            — C1 ✔
e = dλ/dt    : measure 1   (∂_t of a measure-1 quantity)     — C1, C3 ✔
T_co (raw)   : measure 1   (coefficient-wise from λ)
T_arkkio     : measure π   (stress ring integral) = π·T_co   — C2 ✔
e·i power    : measure 1, and  ⟨e·i⟩ = ω·T_co = ω·T_arkkio/π
```

### What is genuinely in conflict, stated precisely

The conflicting **pair** is: **"Arkkio carries π"** (C2, true) **vs.** **"the e·i
energy-balance check is written against Arkkio torque"**. They are incompatible
with physical-λ/e (C1, C3). The two resolution options — as physics, not edits —
are:

- **(R1, correct) Keep e measure-1; check power against the co-energy torque.**
  `⟨Σe·i⟩ = ω·T_co = ω·T_arkkio/π`. This preserves the Stokes-physical λ
  (C1) and the correct cage sync speed ω_e/2 (C3). The factor π between the two
  torque *numbers* is the known basis-measure artifact and is applied **only to
  the reported torque** (motor-stack.js:186), never to e. The current
  `motor-circuit.js:224` value `GAP_MEASURE = 1` is consistent with this option;
  the residual `motor-slice.js backEmfDensity` value `Math.PI` (line 3716) is
  **not** consistent with it and is the lone outlier.

- **(R2, rejected) Put π on e so that `⟨Σe·i⟩ = ω·T_arkkio` numerically.** This
  makes the power-vs-Arkkio check pass, but it **violates C3**: the cage
  synchronous speed collapses to ω_e/(2π). It also makes `e` no longer equal
  `dλ/dt` of the physical λ. Rejected by the independent sync-speed pin.

**Bottom line.** A single self-consistent assignment exists and is R1: π belongs
to the **stress-integral torque (Arkkio) and to the reported co-energy torque
that must match it**, and to **nothing else**. λ, e, and the e·i power are line-
/loop-integral quantities and stay at measure 1. The "π on back-EMF" route is
ruled out by the cage synchronous-speed datum; the only thing that must change
conceptually is **which torque the e·i balance is compared against** — co-energy
(`T_arkkio/π`), not Arkkio.

---

## Appendix — code citations

| Quantity | File:line | Formula | Measure |
|---|---|---|---|
| D3 amplitude basis | `airgap-harmonic.js:55–56` | `a_k=(2/N)Σ A_i cos kθ_i` | non-orthonormal (∫cos²=π) |
| DtN M_k (per-harmonic, coefficient-wise) | `airgap-harmonic.js:275–303` | `M_k=(k/μ₀)·[[1+ρ²,−2ρ],[−2ρ,1+ρ²]]/(1−ρ²)`, ρ=(r₁/r₂)^k | per-radian, NO ∫dθ |
| surfaceFlux (applies M_k mode-by-mode) | `airgap-harmonic.js:411–475` | `q_k = M_k·[a_r;a_s]_k` per cos/sin channel | coefficient-wise |
| Arkkio stress integral (oracle) | `_fixtures.js:333–378` | `T=(ℓ/μ₀)r²∫₀^{2π}B_rB_θ dθ` | **π** (∮ of field product) |
| Harmonic torque (= Arkkio, verified) | `airgap-harmonic.js:1062` | `dT_k=(2π k²ℓ/μ₀)(R_aS_b−R_bS_a)/[(r₂/r₁)^k−(r₁/r₂)^k]` | **π** (the 2π prefactor) |
| λ flux linkage | `motor-slice.js:3171,3215` | `λ_k=ℓ Σ turns·Ā_e` | **1** (Stokes loop, ratio 1.0) |
| co-energy torque (½iᵀdL/dθ i …) | `em-physics.js:307–317`, `motor-stack.js:134–168` | from raw dL/dθ | **1** before scaling |
| co-energy ×π repair | `motor-stack.js:186–189` | `reluctance,mutual,pm *= π` | makes T_co match Arkkio |
| back-EMF (circuit) | `motor-circuit.js:230` | `e_k=GAP_MEASURE·ω·(Σ dL/dθ·i + dλ_pm/dθ)` | `GAP_MEASURE=1` (line 224, EXPERIMENT) |
| back-EMF density (slice, visual) | `motor-slice.js:3772` | `e_elem=π·ω·turns_eff·∂A/∂θ·ℓ` | `GAP_MEASURE=π` (line 3716) — **outlier vs circuit** |

**Numerical verifications performed (this derivation, not re-run from the suite):**
- `∫₀^{2π}cos²(kθ)dθ = π` for k=1,2,3,5 (exact).
- Single-harmonic (k=2) field: production harmonic-torque formula
  (`airgap-harmonic.js:1062`) equals the brute-force continuum Arkkio stress
  integral (2.1) to **ratio 0.99999999977** → the harmonic torque IS the
  Arkkio stress integral, π included.
