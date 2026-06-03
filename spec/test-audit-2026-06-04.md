# Failing-test audit — mortar-engine line (2026-06-04)

Audit of the full `node --test` suite after the monolithic field-circuit-motion
Newton landed. Goal: separate **real engine signals** from **test debt** so the
suite's signal-to-noise stops drowning the genuine failures. Method: 6 parallel
read-only agents extracted, per failing test, the error, the asserted
expectation, and the modelled DUT geometry; verdicts below are reconciled by the
orchestrator against the engine source.

Baseline note: this work sits on the **mortar** gap-engine line (`030756c…`),
NOT the stale harmonic line (`26be498`). The harmonic air-gap engine was
**deleted** (`41365fa`); many failing tests still encode its contract.

Engine core is **verified sound**: gap-torque accuracy gates pass (`low-k exact`,
`converges as gap thins`, `k≤12 within 3%`); `brushed-dc-pm` torque-linearity +
self-start + its own Maxwell-vs-co-energy crosscheck pass. The red is
overwhelmingly stale/contrived oracles, not field-solve defects.

---

## Headline

| Class | Count | Disposition |
|---|---|---|
| Real engine signals — `dL/dθ` extraction cluster (R1 + 6 co-energy) | 7 | KEEP failing; ONE likely root (mortar motional-derivative) |
| Real engine signals — other (R2 induction transient, R3 self-start) | 2 | KEEP failing; fix engine |
| Real engine signal — minor bookkeeping (R5 deltaNorm) | 1 | fix engine (converged flag) |
| Stale: deleted harmonic-engine contract | 4 | 2 DELETE, 2 UPDATE to mortar contract |
| Stale: deliberately-redesigned source | 5 | UPDATE to current source contract |
| Contrivance: wrong constant / wrong metric | 6 | UPDATE (3 simple, 3 metric-redesign) |
| Co-energy near-zero noise | 1 | guard-fix |
| Borderline | 1 | flag, leave |
| Lint + user-killed budget | 2 | reword source comment; delete 8000 assertion |

---

## A. REAL ENGINE SIGNALS — do not mask

### R1 — `tests/slice/extract.test.js:390` — round rotor `dL/dθ ≈ 0` (Step 1)
- **Error**: `dLdth[0] default=4.36e-8 coarse=-8.52e-9 |Δ|/|L|=5.56e-4` ≫ `1e-6`.
- **Expectation**: two derivStep sizes must give the same `dL/dθ` to round-off
  (step-independence), and (Step 2) `|dL/dθ|/|L| < 1e-5`.
- **DUT**: inline `roundRotorCfg` — 2-pole, rotor iron ring `teeth:1,
  spanFraction:1.0` (genuinely round solid iron), 1-phase wound stator, 5 A DC,
  saturation off.
- **Physics certainty**: a geometrically round iron rotor has a rotation-invariant
  air gap ⇒ analytic `dL/dθ ≡ 0`. Unarguable.
- **Verdict**: REAL. Mortar round-rotor `dL/dθ` is step-dependent FD noise (even
  sign-disagrees) — the gap stamp is not φ-isotropic to FE precision. Step-2
  physics floor (1e-5) is met; Step-1 step-independence is not. This is the
  documented "honest-failing signal." **Fix the mortar coupling.**

### R2 — `tests/machines/induction-3ph.test.js:93` — torque ≈0 at synchronous speed
- **Error**: `T_sync=0.0150` vs allowed `0.05·|T_slip|=7.28e-4` (~20× over);
  `T_slip≈0.0146`.
- **Expectation**: `|T_sync| ≤ 0.05·|T_slip|`. Test comment claims refining to
  48 steps/cycle drives `T_sync → 3.5e-5`.
- **DUT**: 3-φ squirrel cage, 4-pole, 36 stator slots, 28 cage bars
  (R≈6.3e-5 Ω), 230 V/50 Hz, ω pinned at ω_s and ω_s/2.
- **Physics certainty**: at slip=0 the cage flux is DC ⇒ no induced bar current ⇒
  T=0. Textbook.
- **Verdict**: REAL. Live run **plateaus** at 1.5e-2, contradicting the comment's
  convergence claim — the AC motional-EMF cancellation isn't closing in the
  monolithic field-circuit-motion solve. Correct expectation; engine residual.
  **Needs a timestep-vs-coupling diagnosis before any code change.**

### R3 — `tests/machines/wound-field-synchronous.test.js:38` — does not self-start
- **Error**: `theta=49.30 >= 1e-3` (rotor spun up freely).
- **Expectation**: `|θ| < 1e-3` after 150 steps from rest on line-fed AC.
- **DUT**: wound-field synchronous, 8-pole, salient field `CURRENT amp:12`
  commutation none, 3-φ stator 230 V/50 Hz commutation none (line-fed).
- **Physics certainty**: a synchronous machine across fixed-frequency AC from rest
  can't lock — inertia can't follow the rotating field. Correct.
- **Verdict**: REAL, known. Previously skipped: "excitation has no current-source
  (field-regulator) terminal; the voltage-fed field line-starts." Excitation-model
  gap. **Fix the excitation model (current-source field).**

### R5 — `tests/slice/newton.test.js:41` — salient Newton `deltaNorm`
- **Error**: `deltaNorm=6.6e25` while `residual<1e-9` and `iters≤8` BOTH pass.
- **Expectation**: `deltaNorm ≤ 1e-6 || converged`.
- **DUT**: `salientConfig` — 2-pole salient iron `teeth:2`, 1-phase stator, 10 A,
  saturation on (Bknee 1.6).
- **Verdict**: MINOR engine bookkeeping. `deltaNorm = dMax/(aMax+ε)` blows up when
  `aMax≈0` (tiny body-only ‖A‖ under mortar / near-singular salient tangent). The
  loop already treats `residual≪tol` as converged but doesn't propagate that to
  the returned `converged` flag. Field IS correct. **Set `converged` from the
  residual criterion.**

### R4 — mesh element budget — **KILLED BY USER 2026-06-04**
- `tests/mesh/refine-and-dofbudget.test.js:187` `elements ≤ 8000` (pm-stepper
  stator 8952). 8000 is an arbitrary budget, not a physical number. **DELETE the
  element-budget assertion.**

---

## B. STALE — deleted harmonic-engine contract (mortar carries K=0, 0 harmonic DOFs, φ-dependent pattern, no interior Schur factor)

| Test | Error | Was asserting | Disposition |
|---|---|---|---|
| `assembly.test.js:42` "prepare returns documented global layout" | `0 !== 2` | `nHarmonicDofs == 2·(2K+1)` | UPDATE → `nHarmonicDofs === 0` (keep the rest of the layout test) |
| `assembly.test.js:125` "combined pattern is φ-invariant" | `key 272,408 missing in φ=1.07 pattern` | fixed `(I,J)` set across φ | DELETE — mortar band re-zips with φ *by design* (boundary-triggered re-analyze, tested via solve path) |
| `extract.test.js:226` "Schur path handles all three probe angles" | `prepDelta 0 !== 3` | `schurPrepCount==3`, `schurSolveCount==3(m+1)` | DELETE — counters belong to deleted harmonic Schur condensation; `createCalls===0` is the only live part |
| `extract.test.js:254` "derivStep override honored (gapStampLog)" | `prepDelta1 0 !== 3` | gapStampLog angles **(live)** + `schurPrepCount==3` (stale) | UPDATE — drop the 2 `schurPrepCount` asserts; keep the gapStampLog-angle checks (correct) |

## C. STALE — deliberately-redesigned source (update test to current contract; not masking — source is the better physics)

| Test | Error | Source change | Disposition |
|---|---|---|---|
| `cageRouting:44` | `null !== 1` | cage: adjacent-bar-2-slot-loop → **one-bar-per-slot end-ring** (`winding-model.js:343-359`; old model double-stamped slots, killed seam bars) | UPDATE → `slotReturn === null` |
| `cageRouting:72` | `1 !== 2` | same | UPDATE → `nonZeroSlots === 1` |
| `commutation.test.js:87` "mechanical chops DC" | `V=+12` not `-12` | scalar `sectorGate` **replaced** by spatial brush/commutator current-sheet in `motor-slice.js` (verified by passing `brushed-dc-pm` torque-linearity + self-start) | UPDATE → assert ungated `V=+12` ∀θ |
| `commutation.test.js:106` "mechanical commutates AC" | `V=+10` not `-10` | same | UPDATE → assert ungated `V=amp·cos(ψ)` ∀θ |
| `sources.test.js:149` "CURRENT under mechanical gates" | `{current,I:12}` not `{open}` | same | UPDATE → assert ungated `{kind:"current",I:12}` ∀θ |

## D. CONTRIVANCE — idealized linear-model / wrong constant / wrong metric

| Test | Error | Why contrived | Disposition |
|---|---|---|---|
| `brushed-dc-wound` "torque bilinear" | ratio 2.32 (tol 3%) | runs on the **saturating** stack; bilinearity is a linear-iron property | UPDATE → use ceiling-disabled (linear) stack like `crossCheck` |
| `hybrid-stepper` "half-tooth offset" | `0.0628 != 0.6283` | test asserts `π/5`; fixture correctly gives `π/50` (half of 2π/50 tooth pitch) | UPDATE → fix constant to `π/50` |
| `pm-stepper` "detent periodic [8,16]" | `signChanges=96` | comment assumes Q=8/4-pole; fixture is **Q=12/24-pole** → 96 is correct (cogging order 24) | UPDATE → fix bound for the actual machine (or DFT) |
| `hybrid-stepper` "finer detent periodicity" | `8 not > 8` | `signChanges` aliased (50 teeth, N=128) | UPDATE → DFT on doubled harmonic, or DELETE if not cleanly testable |
| `skew-demo` "skew reduces ripple" | `rSkew 555.7 vs 0.8·563.9` | `ripple()` = p2p of whole torque curve (fundamental ~560), not slot harmonic; + `POLES=4` vs fixture `poles=8` | UPDATE → fix pole count, DFT on slot order |
| `skew-demo` "skew preserves mean" | `3.6e-4 vs 1.45e-3` | mean ≈0 at freq=0, no held load angle; relative 5% meaningless; same pole mismatch | UPDATE → fix operating point/metric |
| `vr-stepper` "L0+L2+L4" | `r²=0.317` | `POLES=4` vs fixture `poles=8`; 6-tooth VR saliency isn't electrical 2/4 | DELETE — analytic form physically inapt for doubly-salient |
| `switched-reluctance` "L0+L2+L4" | `r²=0.0085` | same; 8/6 SR saliency at 6-tooth rate | DELETE — analytic form inapt |

## E. CO-ENERGY ↔ MAXWELL crosschecks — **CORRECTED: mostly REAL signals, not contrivances**

**Key theory (correction to first-pass verdict):** both torques are evaluated on a
**saturation-disabled (linear-iron)** stack. For linear magnetostatics the
co-energy torque `½iᵀ(dL/dθ)i (+PM)` **equals** the Maxwell-stress torque exactly
(virtual-work theorem) — they are two post-processings of the *same* linear FE
field. So a large disagreement is NOT "the lumped approximation is inaccurate"
(there is no approximation when iron is linear) — it is a **real numerical
inconsistency** in the torque post-processing. **These must NOT be deleted.**

**E-real — genuine Maxwell-vs-co-energy inconsistency** (linear iron ⇒ should be
equal). Likely the SAME root as R1 (mortar `dL/dθ` motional-derivative extraction
not accurate/isotropic on salient/commutated/multi-slice geometry); cross-check
against the memory note "mortar Arkkio torque π-off" — could be the Maxwell side
on some, which would be **product-critical**.
| Test | arkkio / coe | rel/mag | mesh | note |
|---|---|---|---|---|
| `hybrid-stepper:100` | 0.01521 / 0.00979 | 36% | Nr=34, **2 slices** | too large for discretization — real |
| `vr-stepper:78` | 0.00519 / 0.00422 | 19% | Nr=34 | real (single-phase reluctance) |
| `brushed-dc-wound:71` | −21.6 / −26.4 | 18% | Nr=56 | real (commutated armature dL/dθ) |
| `universal:58` | −2.92 / −2.65 | 9% | Nr=14 | partly coarse-mesh; investigate |
| `pole-mismatch-demo:62` | 1.61 / 1.74 | 7% | Nr=12 | partly coarse-mesh; investigate |
| `pm-stepper:79` | 1.18e-6 / 2.33e-4 | ~99% | Nr=14 | arkkio≈0 but coe≠0 — real disagreement, not just a zero-crossing |

Disposition: **KEEP, do not delete.** Treat as one cluster with R1 — the mortar
`dL/dθ` extraction. Decision for the user: (a) fix the extraction, or (b) formally
retire co-energy from the product (delete tests AND remove the torque-decomposition
feature) — but only as a *deliberate scope decision*, never as silent masking.

**E-noise — genuine near-zero (relative compare meaningless):**
| Test | arkkio / coe | note |
|---|---|---|
| `induction-1ph:129` | 1.30e-5 / 1.49e-5 | both ≈0 (cage currents zeroed → ~no torque); misses guard by 0.13 µN·m | guard-fix only |

## F. BORDERLINE
| Test | Error | Note | Disposition |
|---|---|---|---|
| `synchronous-reluctance` "L0+L2+L4" | `r²=0.955 < 0.99` | poles MATCH, machine genuinely 2nd-harm dominant; gap is multi-barrier tooth discretization | FLAG, leave (closest to genuine; do not loosen without thought) |

## G. LINT
| Test | Error | Disposition |
|---|---|---|
| `agnostic-pipeline` naming | "stepper" in `airgap-mortar.js:188,191` (comments, worst-case-gap illustration) | reword the two source comments |
