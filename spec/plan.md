# Unified electric-motor app — Implementation Plan

Spec source: `lessons/unified_motor/DESIGN.md`. This plan covers the **full
scope** of the DESIGN's six-step build sequence as one execution graph.

The defining constraint of this project: **one unified physics, no per-machine
code.** Every machine on the syllabus is the same air-gap field solve with a
different *configuration* of elements, excitation, and commutation. The plan is
structured so that machine identity never reaches a code path — see the
**Machine-Agnosticism Invariants** section, which is load-bearing and is
verified in every phase.

## Goals

- A headless, UI-agnostic **air-gap field engine** in `lib/` that consumes
  compiled grid arrays (ν mask, `J_z` map, magnetization sources, coil-region
  masks) and returns `B_r/B_t`, per-circuit flux linkage `λ_k`, and torque
  (Maxwell-stress primary, co-energy decomposition cross-check), validated
  against the analytic salient/VR closed form to gap-resolution tolerance.
- A **circuit / excitation / commutation layer** expressing the full universal
  vocabulary: 5 elements `{W,C,M,I,K}`, 6 per-circuit terminal states
  `{AC,DC,PULSE,STEP,OPEN,SHORT}` (`AC` carries `(amp,freq,phaseOffset)` —
  polyphase is emergent: m circuits at `phaseOffset = −2π·k/m`; the old
  multi-winding `AC1`/`AC3` tokens are dissolved), 5 commutation modes
  `{none,mechanical,electronic-trap,electronic-sine,sequencer}`. Terminal state
  (supply waveform shape) and commutation (phase derivation) are **orthogonal,
  composable axes**; commutation is **per-circuit** (a brushed-DC machine has a
  `mechanical` armature and a `none` field).
- A **universal axial slice-stack container**: all machines (`N≥1` slices) run
  through one unconditional aggregation path (`N=1` is a one-term sum).
- A single browser app mounted as a `{label, mount}` tab under
  `LIB.App.runTabs`, with a 3-zone layout, its own rAF + accumulator loop, a
  gap-field visualization, and graphical **winding + circuit editors**.
- **All 13 matrix machines plus a skew demo, reproduced purely as config
  fixtures**, each with an independent config-driven validation test.
- A **Detailed (Web Worker) tier**: refined slot-mouth + tooth-tip-fillet grid
  for quantitative cogging/detent, and nonlinear teeth-in-domain `ν(B)`
  saturation. The Live tier carries the cheap global flux-dependent ceiling.
- A **Node test harness** running headless over the `window.LIB` globals.

## Non-Goals

- **No machine-specific code paths, branches, or modules** in `lib/` or in the
  runtime UI. The 13 machines exist only as declarative config fixtures in
  `lessons/unified_motor/machines/*.js` and as test fixtures. This is the
  project's reason for existing; it is enforced, not aspirational.
- **No GPU/WebGL compute tier.** Explicitly rejected in the DESIGN
  (hardware-gated for an uncontrolled student fleet; a dumping ground for work
  that must fit on the CPU). Do not reintroduce.
- **No CPU unstructured-mesh FEA**; **no precomputed per-geometry flux-linkage
  maps** (both break live reconfiguration).
- **No automatic or per-frame Live↔Detailed switching.** The toggle is an
  explicit user control and is the Web-Worker boundary.
- **No use of `LIB.App._mountSpec` or the declarative `dxdt` integrator path.**
  The app builds a bespoke interior in its `host` div and drives the
  field+circuit+mechanics solve imperatively.
- **No changes to `lib/em-physics.js`, `lessons/ac_motor/`, or any other
  existing lesson.** The new engine is independent until separately tested and
  rolled out (out of scope here).

## Machine-Agnosticism Invariants

These are the contract that keeps the system unified. Every phase's
verification checks the invariants relevant to its files; Phase 10 audits them
repo-wide.

1. **Legitimate dispatch axes only.** Code may switch/branch on the universal
   physical vocabulary — element type `{W,C,M,I,K}`, excitation/terminal-state
   `{AC,DC,PULSE,STEP,OPEN,SHORT}`, commutation mode, and source scope
   `{slice, stack}`. Code may **never** switch on machine identity, a machine
   name, or a "machine type" enum. There is no machine-type field that any
   behavioral code reads.
2. **Zero-not-skip.** Absent physics contributes zero; it is never branched
   around. PM torque with no magnet → `λ_pm = 0` → the term computes to zero,
   it is not skipped. Reluctance torque on a round rotor → `dL/dθ ≈ 0`. This
   keeps a single live code path for all machines.
3. **Solver sees only compiled arrays.** The `motor-compile.js` step is the
   one-way boundary: semantic objects (geometry, winding routing, circuit
   topology) in; grid arrays out. The field solver has zero knowledge of
   windings, machines, or the UI.
4. **W vs C is routing, not a branch.** Concentrated vs distributed windings
   are different conductor routings; the winding function is computed
   identically from the per-slot ampere-conductor map. Element *type* dispatch
   (current-carrier vs magnet vs iron vs shorted) is legitimate; "is this a
   concentrated machine" is not.
5. **`N=1` is not special.** The slice-stack aggregator always loops over
   slices and sums; there is no single-slice fast path that bypasses
   aggregation (that bypass would be the seed of machine-awareness).
6. **Config-declared presentation.** Readouts, plots, panels, and controls are
   declared by the config and rendered generically. The mount has no machine
   awareness. A config may carry a human-readable label for the splash/header;
   no behavioral code reads it.

## Verification

- **Phase 0:** confirm no app code exists to remove (`lessons/unified_motor/`
  holds only `DESIGN.md`); the untracked EM-ecosystem baseline is committed and
  tagged `motor-baseline` so the Phase 10 freeze guard is a `git diff` — `npm
  test` not yet meaningful, git-state confirmation only.
- **Phase 1:** `npm test` green; the grid Arkkio-averaged Maxwell-stress torque matches the analytic
  salient `T = −i²L₂ sin(2θ_r)` to gap-resolution tolerance over a θ sweep;
  flux balance `∮ B dθ = 0` holds; torque/energy converge with grid resolution;
  warm-started PCG returns within budget on the coarse grid.
- **Phases 2–4:** unit tests pass — the winding router reduces routing to the
  expected per-slot ampere-conductor map (series coils sum into one circuit,
  parallel branches split into separate circuits; short-pitch moves the return
  slots by the chord); compiled grid arrays match the solver's expected shapes
  (zero-not-skip: absent magnet/iron features yield zero arrays, not skipped
  paths); each excitation source and commutation mapping matches
  its closed form; the semi-implicit current step is stable for `dt > L/R`
  where explicit diverges; a shorted-winding config shows induced current.
- **Phase 5:** the agnostic pipeline runs **≥3 structurally-different configs**
  (a current-fed wound machine, a PM machine, a salient-iron reluctance
  machine) and **one N=2 config** through the *identical* code path; the rotor
  visibly turns; live Maxwell-vs-co-energy agreement is asserted as a test;
  grep of `lib/` + `mount.js` for machine names returns zero.
- **Phase 6:** every one of the 13 matrix rows plus a skew demo exists purely
  as a config fixture and passes its own validation test (e.g. VR/SRM
  reluctance torque vs the closed form; 4-pole-stator vs 6-pole-rotor produces
  ripple and zero net torque; hybrid detent; skew reduces cogging ripple).
- **Phase 7:** routing a conductor updates `F(θ)` / pole-count / back-EMF-shape
  readouts live (a winding-function proxy; the real solve reloads on release);
  star/delta, series-resistance and switches (manual/centrifugal) **lower to**
  the existing per-circuit `{terminal, commutation, R}` vocabulary (`R` and the
  `OPEN` terminal state are exact; the capacitor is represented by its
  phase-split effect); a toggleable compiled-feature overlay exposes mesh errors
  at fine tooth geometries; no editor path is keyed to a machine.
- **Phase 8:** Detailed mode runs the refined **time-domain** sim in the Web
  Worker (the Phase-5 engine with its `SolveBackend` swapped to the refined tier)
  without blocking the UI; refined cogging/detent is grid-converged to the
  DESIGN's ~1–5% target (Richardson, refine factor 2 vs 4) and provably finer
  than the Live coarse estimate; the worker round-trips a torque-vs-angle table.
- **Phase 9:** Live global ceiling flattens torque past the iron knee on every
  config; Detailed nonlinear solve resolves the SRM aligned-vs-unaligned
  differential and tooth-tip saturation.
- **Phase 10 (final):** a one-shot audit script (`scripts/agnosticism-audit.js`,
  run via `node`, not wired into `npm test`) exits `0` over four checks —
  **zero** machine-name references in the **22 unified-motor-owned `lib/` engine +
  runtime-UI files** (the scan is an enumerated allow-list, *not* all of `lib/`:
  pre-existing unrelated token sites — `lib/stepper-drive.js`, the
  "stepper-driven lessons" comments in `app.js`/`registry.js`/`header-buttons.js`,
  and the frozen `lib/three-phase.js` — are out of scope; machine names remain
  allowed in `machines/*.js`, tests, and docs); no machine-type *field* read by
  behavioral code in those 22 files; no single-slice fast-path branch in
  `lib/motor-stack.js`/`lib/motor-run.js`; and `git diff motor-baseline --
  <frozen set>` empty — the frozen set being `index.html` (root),
  `lib/em-physics.js`, `lib/coil-render.js`, `lib/three-phase.js`,
  `lib/layout3d.js`, and `lessons/ac_motor/` (`lib/field-render.js` is excluded —
  Phase 5 extends it). The plan's "no stale references to anything noted in
  Phase 0" clause is **vacuous** — Phase 0 deleted no code — so it reduces to the
  frozen-set diff.

## Dependency Graph

```
Phase 0 (Dead Code Removal — greenfield, near-empty audit)   ── runs first, alone
   │
Phase 1 (engine core: airgap-grid|solve|torque + test harness + Live ceiling)
   ├──→ Phase 2 (winding-model + motor-compile)        ─── parallel after 1 ──┐
   ├──→ Phase 3 (excitation + commutation)             ─── parallel after 1    │
   └──→ Phase 4 (motor-circuit: ODE + L(θ) cache)      ─── parallel after 1    │
                         │  (needs 2 + 3 + 4)                                   │
                         ▼                                                      │
Phase 5 (config-schema + motor-slice + motor-stack + motor-run + mount + viz)  │
        ── AGNOSTIC PIPELINE milestone: ≥3 differing configs + 1 N=2, one path │
   ├──→ Phase 6 (13 config fixtures + skew demo + per-config tests) ─ ∥ after 5┐
   ├──→ Phase 7 (cross-section + winding editor + schematic + matrix) ─ ∥      │
   └──→ Phase 8 (airgap-refine + airgap-worker + Detailed toggle) ──── ∥       │
                         │  (nonlinear runs in the worker from 8)              │
                         ▼                                                      │
Phase 9 (airgap-nonlinear saturation + 3D render polish)                       │
   │                                                                           │
Phase 10 (Legacy Reference Review + machine-agnosticism guard) ── runs last ───┘
```

Phases are numbered in execution order; consecutive numbers after a shared
dependency are parallelisable. Phase 3 has no *runtime* dependency on Phase 1
(pure time/angle → voltage/phase functions) and may begin immediately; it is
grouped in the post-Phase-1 tier because Phase 5 is the first consumer and
Phase 1 dominates the critical path.

Each `lib/` and UI file is owned by exactly one phase. The foundation mount
(`mount.js`, Phase 5) exposes **registration seams** (pointer-tool registry,
panel registry, header-control slot, and a **render-layer slot**
`registerRender3D`/`RENDER3D`) so Phases 6/7/8/9 add their own panel/render files
without editing it (Phase 9's polished 3D rig takes the render slot). `index.html`
(Phase 5) carries a comment-marked module extension region; Phases 6/7/8/9 append
their `<script>` tags there only — a sanctioned shared inclusion manifest, the one
cross-phase append-point. The solver files are split by tier (`airgap-solve.js`
coarse / `airgap-refine.js` refined / `airgap-nonlinear.js` nonlinear) so each
tier lives in one phase; each tier is a `SolveBackend` (Phase 5) that
`motor-slice` consumes via `opts.backend`, so swapping tiers never touches the
slice/stack/run orchestration. The Phase-8 worker exposes a **backend tier
selector** (`backendOpts.tier ∈ {"refined","nonlinear"}`) plus a guarded
`importScripts("airgap-nonlinear.js")`, so Phase 9 plugs its nonlinear tier into
the worker without editing `airgap-worker.js`; the Phase-1 `GridOperator` gains
additive per-cell reluctivity primitives (`getReluctivity`/`setIronReluctivity`)
that the nonlinear tier's per-cell `ν(B)` loop needs. The Phase-5 physics is
likewise split: `motor-slice.js` (single section), `motor-stack.js` (spatial
aggregation), `motor-run.js` (temporal driver).

**Test-harness ownership.** Phase 1 owns `tests/_shim.js` and its `LIB_FILES`
loader, which eagerly `require`s the Phase-1 solver modules. That loader is an
intra-Phase-1 extension point only — the post-Phase-1 parallel phases (2, 3, 4)
must **not** edit it (it is another phase's file, and it loads modules that need
not exist when a parallel phase runs standalone). Each parallel phase ships its
own minimal `tests/<area>/_fixtures.js` loader that shims `window` and
`require`s only its own DOM-free module(s). Phase 3 establishes this pattern
(`tests/excitation/_fixtures.js`); Phases 2 and 4 follow it.

---

## Phase 0: Dead Code Removal
**Depends on**: (none — runs first)

Greenfield: `lessons/unified_motor/` contains only `DESIGN.md`, so there is no
app code, test, import, or config to remove. The EM-ecosystem files are **not**
dead — they are live dependencies of `lessons/ac_motor/` and the root
`index.html`, and the DESIGN explicitly retains them until the new engine is
independently tested. The actual `LIB.EM` consumer set is wider than `ac_motor/`
+ root `index.html`: `lib/coil-render.js` and `lib/field-render.js` both
hard-depend on it (they throw if it is absent).

This phase confirms the clean slate and **commits the untracked EM-ecosystem
baseline** so Phase 10's freeze guard is a simple `git diff` against the
`motor-baseline` tag. The **frozen set** (must stay byte-identical; Phase 10
asserts an empty diff) is `index.html` (root), `lib/em-physics.js`,
`lib/coil-render.js`, `lib/three-phase.js`, `lib/layout3d.js`, and all of
`lessons/ac_motor/`. `lib/field-render.js` is committed in the same baseline
but is the **one** EM file a later phase modifies — Phase 5 extends it with
`drawGapField` — so it is excluded from the unchanged assertion.

### Wave 0.1: Confirm clean slate + commit baseline
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Confirm `lessons/unified_motor/` holds only `DESIGN.md` (nothing to delete); commit the untracked EM-ecosystem baseline (`index.html`, `lib/em-physics.js`, `lib/coil-render.js`, `lib/three-phase.js`, `lib/layout3d.js`, `lib/field-render.js`, `lessons/ac_motor/`) as one targeted commit and tag it `motor-baseline`; the tag is the reference Phase 10 diffs the frozen set against | S | `index.html`, `lib/em-physics.js`, `lib/coil-render.js`, `lib/three-phase.js`, `lib/layout3d.js`, `lib/field-render.js`, `lessons/ac_motor/` |

---

## Phase 1: Engine core + test harness
**Depends on**: Phase 0

The headless, UI-agnostic numerical field core plus the Node test harness it is
validated with. Everything below depends on this. Files are engine-internal and
sequential (grid → solve → torque), grouped in one phase for locality.

### Wave 1.1: Test-harness scaffold
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.1.1 | Introduce the repo's first `package.json` + `node:test` runner + a `window`-global shim that loads the DOM-free `window.LIB` math modules headless; `npm test` green on a trivial assertion | M | `package.json`, `tests/_shim.js`, `tests/smoke.test.js` |

### Wave 1.2: Grid + field/flux extraction
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.2.1 | `airgap-grid.js`: structured polar thin-annulus grid; `∇·(ν∇A_z) = −J_z` operator assembly; ν / `J_z` / magnetization mask ingestion; periodic-θ; sliding-band rotor-mask shift (Δθ interpolation, no remesh); `B_r=(1/r)∂A_z/∂θ`, `B_t=−∂A_z/∂r`; `λ_k = ∮ A_z` over coil-region masks; additive rotor-safe per-cell reluctivity read/write (`getReluctivity`/`setIronReluctivity`) consumed by the Phase-9 nonlinear tier | L | `lib/airgap-grid.js` |

### Wave 1.3: Coarse solver + Live saturation ceiling
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.3.1 | `airgap-solve.js`: coarse linear solve (PCG + warm-start reusing previous-frame `A_z`); **global flux-dependent ceiling** (one scalar ν scaling from the B–H knee) as the always-live default | L | `lib/airgap-solve.js` |

### Wave 1.4: Torque + core physics tests
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.4.1 | `airgap-torque.js`: Maxwell stress `T=(r²ℓ/μ₀)∮ B_r·B_t dθ` (primary, evaluated as the Arkkio gap-band average); co-energy decomposition `½iᵀ(dL/dθ)i + iᵀ(dλ_pm/dθ)` exposing reluctance/PM/mutual terms (all computed always — zero-not-skip; **tests-only cross-check in this phase**, live readout decided at Phase 5) | L | `lib/airgap-torque.js` |
| 1.4.2 | Core physics tests: analytic salient/VR closed form (`L(θ_r)=L₀+L₂cos2θ_r`, `T=−i²L₂sin2θ_r`); Maxwell-vs-co-energy over a θ sweep; flux balance `∮ B dθ=0`; torque/energy convergence vs grid resolution | M | `tests/engine/*.test.js` |

---

## Phase 2: Winding model + compile
**Depends on**: Phase 1
**Parallel with**: Phase 3, Phase 4

### Wave 2.1: Winding model
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.1.1 | `winding-model.js`: pure routing algebra — conductor routing → independent-current-path resolution (series coils sum into one circuit; parallel branches split into separate circuits) → per-slot signed ampere-conductor map → conductor-feature list for the compile step. Real turns per coil; unbalanced windings allowed; `standardWinding` constructor for fixtures. **Emits no field-shaped quantity** (no MMF curve, no `B`, no permeance) — discrete turn data only, sole consumer is `motor-compile`. No element-type or machine branch | L | `lib/winding-model.js` |

### Wave 2.2: Compile step (semantic → grid arrays)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.2.1 | `motor-compile.js`: rasterize a uniform **feature list** (each feature one of three physical contribution kinds) into the solver's grid arrays — `conductor` → per-circuit coil mask (serves simultaneously as the `J_z` basis and the `λ` weight; per-tick `J_z = Σ i_k·mask_k` via `assembleJz`); `magnet` → magnetization source `{Mr,Mθ}`; `iron` → low-`ν` mask. Doubly-slotted geometry falls out (both members are just iron features). Dispatch keyed **only** on `feature.kind` — never on element/machine labels or combinations; zero-not-skip (absent kinds → zero arrays) | L | `lib/motor-compile.js` |

### Wave 2.3: Tests
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.3.1 | Routing → per-slot ampere-conductor map (series/parallel resolution; full- vs short-pitch slot assignment); `standardWinding` phase-belt layout (+ test-only winding-factor cross-check); continuity validation; `winding-model` exposes no field-shaped function; compiled-array shapes + zero-not-skip (`assembleJz(0)=0`, `J_z=Σ i_k·mask_k`, no-magnet→zero magnetization, no-iron→all-air ν) | M | `tests/winding/*.test.js` |

---

## Phase 3: Excitation + commutation
**Depends on**: Phase 1 (nominal — no runtime dependency; may start immediately)
**Parallel with**: Phase 2, Phase 4

`excitation.js` is two orthogonal, composable axes: **terminal state** (supply
waveform shape, per circuit) and **commutation** (how the phase argument is
derived from time/rotor/step). `AC1`/`AC3` are dissolved — `AC` carries
`(amp,freq,phaseOffset)` and polyphase is emergent (m circuits at
`−2π·k/m`); single-phasing fault = one circuit `OPEN`. Commutation is
**per-circuit**, so `mechanical` can chop a `DC` armature into a square keyed to
rotor angle while a sibling field circuit stays `none` (Framing A). Output is a
per-circuit `TerminalCondition` (`{kind:"voltage",V}` / `{kind:"open"}` /
`{kind:"short"}`) — the boundary Phase 4's `V = R·i + dλ/dt` consumes. Single
wave (impl + tests co-authored, as in Phase 1's wave 1.4).

### Wave 3.1: Sources + commutation + tests
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | `excitation.js`: pure helpers `commutationPhase`/`supplyValue`/`sectorGate` + composition `evalTerminal`/`evalDrive`. Terminal states `{AC,DC,PULSE,STEP,OPEN,SHORT}`; commutation `{none,mechanical,electronic-trap,electronic-sine,sequencer}`. Dispatch keyed on terminal-type × commutation-mode only — zero machine identity. Zero deps, DOM-free | L | `lib/excitation.js` |
| 3.1.2 | Closed-form suite: supply waveforms; emergent balanced/N-phase summing to zero; single-phasing `OPEN`; 6-step `electronic-trap` conduction table; `mechanical` DC-chop + AC-commutation; `sequencer` step pattern; each `commutationPhase` mode vs formula. Ships its **own** headless loader `tests/excitation/_fixtures.js` (does not edit Phase 1's `tests/_shim.js`) | M | `tests/excitation/*.test.js` |

---

## Phase 4: Circuit ODE
**Depends on**: Phase 1 (λ / L extraction interface)
**Parallel with**: Phase 2, Phase 3

### Wave 4.1: Circuit solver
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.1.1 | `motor-circuit.js`: `V = R·i + dλ/dt` per circuit; semi-implicit **implicit** current step (`m×m` solve, stable at interactive `dt`); `L(θ)` extraction (field response to unit current per circuit), θ-binned cache refreshed when the rotor crosses a bin. Terminal states (`SHORT`→V=0, `OPEN`→branch removed, etc.) handled via vocabulary, not machine | L | `lib/motor-circuit.js` |

### Wave 4.2: Tests
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.2.1 | Semi-implicit stability at `dt > L/R` (explicit diverges, implicit holds); shorted-winding config shows induced current; back-EMF appears under motion | M | `tests/circuit/*.test.js` |

---

## Phase 5: Agnostic pipeline + universal stack container + mount
**Depends on**: Phase 2, Phase 3, Phase 4

The integration milestone. Builds the agnostic config schema, the single-section
solver, the universal slice-stack container (`N≥1`, `N=1` is the common case
through the same path), the **headless temporal driver**, the gap-field
visualization, and the mount with its registration seams. Verified by running
**multiple structurally-different configs through one code path** — not by
making any single machine work.

The temporal driver is a dedicated `lib/motor-run.js` (not folded into the
stack): the stack stays a pure *spatial* aggregator, and `motor-run` owns the
per-tick chain (excitation → circuit step → torque → mechanics). The mount and
the milestone test both drive `motor-run`, so the runtime and the test exercise
the **same** code path. The config vocabulary (rings / element letters /
excitation / commutation / stack) lives **only** in `config-schema.js`; `lib/`
sees only compiled sections + circuit specs. The co-energy decomposition is
**not** a live readout (above the target students' level) — Arkkio is the only
live torque; Maxwell-vs-co-energy agreement is asserted in the test only.

`config-schema.js` must be **vocabulary-complete** here: Phase 6 adds only data
(`machines/*.js`), so every element type, terminal state, commutation mode,
series/parallel circuit form, and the full axial slice-stack descriptor must
already be expandable. `index.html` is created with a comment-marked **module
extension region** that Phases 6/7/8 append their `<script>` tags into (a
sanctioned shared inclusion manifest); no later phase edits `mount.js` (they use
the registration seams).

### Wave 5.1: Config schema, single slice, gap-field viz (parallel)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | `config-schema.js`: the agnostic machine descriptor + `expand()` — per-ring element `{W,C,M,I,K}`, per-circuit excitation + commutation, geometry params, winding routing, circuit topology, and the axial slice stack (count + per-slice rotor-angle offset + per-slice section ref + stack-scope flux sources with per-slice sign). Vocabulary-complete (Phase 6 is data-only). Emits the Phase-2 `section` shape + Phase-3 drive specs; element-type dispatch only, no machine identity | L | `lessons/unified_motor/config-schema.js` |
| 5.1.2 | `motor-slice.js`: single-section `solve(θ, currents) → { torque, fluxLinkages, field }` + `extractCoeffs(θ)` tying grid + compile + circuit-coefficient extraction through a pluggable `SolveBackend` (`opts.backend`; coarse PCG default, refined/nonlinear tiers swap in); per-slice warm-start cache | L | `lib/motor-slice.js` |
| 5.1.3 | Extend `field-render.js` with `drawGapField` (heatmap + B-vectors painted on the cross-section plane), driven by the solver's field array; reuse `layout3d` projection, no new `LIB.EM` dependency. Greenfield addition; loop-centric renderers byte-unchanged | M | `lib/field-render.js` |

### Wave 5.2: Universal stack container
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.2.1 | `motor-stack.js`: the universal **spatial** container — always loops over `N≥1` slices, applies each slice's rotor-angle offset, sums each shared circuit's `λ` across the slices its conductors thread, sums torque, aggregates `L(θ)` coefficients, and exposes the co-energy torque total (test-only). `N=1` runs the identical path (no bypass) | L | `lib/motor-stack.js` |

### Wave 5.3: Headless temporal driver
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.3.1 | `motor-run.js`: the headless per-tick driver — excitation (Phase 3) → implicit circuit step (Phase 4) → Arkkio torque → semi-implicit rotor mechanics (`ω' = (T−bω−T_load)/J`, `θ' = ω`); θ-binned coefficient cache; state tiers (true state Reset-zeroed; config persists; warm-start cache cleared on Reset/geometry edit). The single code path the mount and test both drive | L | `lib/motor-run.js` |

### Wave 5.4: Mount + page
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.4.1 | `mount.js` + `index.html`: `{label, mount}` tab nesting in the unified outer chrome (`.app-nav`, splash); 3-zone layout (3D viewport + two cross-section views; right shelf via `LIB.Registry.mkRow`; bottom `LIB.Plot` + readouts); own rAF + accumulator loop driving `LIB.MotorRun` (Live, main-thread); gap-field 3D viz; **registration seams** (pointer-tool registry, panel registry, header-control slot, render-layer slot `registerRender3D`/`RENDER3D`); `index.html` module extension region for later phases. **User-required**: browser verification per the CLAUDE.md checklist | L | `lessons/unified_motor/mount.js`, `lessons/unified_motor/index.html` |

### Wave 5.5: Agnosticism milestone test
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.5.1 | Unit tests for `config-schema`/`motor-slice`/`motor-stack` plus the milestone: push 4 configs (current-fed wound, PM, salient-iron, `N=2` skew) through the identical `LIB.MotorRun` path; assert the rotor turns, live Maxwell-vs-co-energy agreement (≤10% rel.), and that `lib/` + `mount.js` are free of machine names | M | `tests/pipeline/*.test.js`, fixtures |

---

## Phase 6: Machine config fixtures + independent validation
**Depends on**: Phase 5
**Parallel with**: Phase 7, Phase 8

Every machine is **data** here — no `lib/` or runtime code changes (the only
runtime touch is appending `<script>` tags to the Phase-5 `index.html` extension
region). Each of the 13 matrix rows is authored as its **own** fixture file, plus
a **skew demo** and a **pole-mismatch demo** (4-pole stator / 6-pole rotor),
giving 15 fixtures. Hybrid stepper (row 11) and skew are ordinary fixtures of the
universal slice-stack container (`stack.slices ≥ 2`), not special constructs.
Fixtures register on a lazy app-layer `window.UnifiedMotor.MACHINES` registry and
set `UnifiedMotor.defaultConfig`; they touch no `lib/` and no `mount.js`.

Validation is the three-class scheme settled at spec time: **(A) analytic-tight**
where a parameter-free closed form exists (reluctance `L(θ)=L0+L2cos2θ_e` fit
`r²≥0.99` and `T=−i²L2sin2θ_e`; torque/current proportionality within 3%;
zero-net-torque and zero-at-synchronous bounds); **(B)** a universal
Maxwell-vs-co-energy cross-check (`≤5%` at a loaded point, absolute floor); and
**(C)** a Phase-8/9 carve-out for cogging/detent **amplitude** and the SRM
saturated aligned-vs-unaligned differential, where Phase 6 asserts only
presence/sign/periodicity and the magnitude check is owned by Phases 8/9.

One file per machine (15 fixtures) + 15 per-fixture test files + a shared loader
exceed the 10-file task-group cap and introduce a loader→tests dependency, so the
phase is **three waves**.

### Wave 6.1: Config fixtures + registration
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | Author matrix rows 1–7 as one fixture file each (brushed-DC PM, brushed-DC wound, universal, BLDC, PMSM, 3-φ induction, 1-φ induction); data-only, register on `UnifiedMotor.MACHINES` | M | `lessons/unified_motor/machines/{brushed-dc-pm,brushed-dc-wound,universal,bldc,pmsm,induction-3ph,induction-1ph}.js` |
| 6.1.2 | Author rows 8–13 + skew demo + pole-mismatch demo as one fixture file each (VR stepper, SRM, PM stepper, hybrid stepper = 2 slices/half-tooth/shared-PM-opposite-sign, synchronous reluctance, wound-field synchronous, skew = N slices with skew-increment offsets, pole-mismatch = 4-pole stator/6-pole rotor) | M | `lessons/unified_motor/machines/{vr-stepper,switched-reluctance,pm-stepper,hybrid-stepper,synchronous-reluctance,wound-field-synchronous,skew-demo,pole-mismatch-demo}.js` |
| 6.1.3 | Append the 15 fixture `<script>` tags to the Phase-5 `index.html` module-extension region (append-only, marked region; PMSM first so it becomes the app default) | S | `lessons/unified_motor/index.html` (append-only) |

### Wave 6.2: Test loader + measurement helpers
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.2.1 | `tests/machines/_fixtures.js`: headless loader built on the Phase-5 pipeline loader (read-only); registers all 15 fixtures; exposes the agnostic-pipeline drivers (`build`/`validate`) and measurement helpers (`sweepTorque`/`sweepInductance`/`sweepLambdaPm`/`crossCheck`/`runFromRest`/`avgTorqueAtSpeed`/`dftAmp`/`signChanges`/`ripple`/`mean`) + `XC_TOL`/`XC_FLOOR` | M | `tests/machines/_fixtures.js` |

### Wave 6.3: Per-machine independent validation
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.3.1 | One independent config-driven test per fixture for rows 1–7 (plus loader/registry coverage in `pmsm.test.js`): PM/wound/universal torque-current laws, BLDC/PMSM back-EMF & self-start, induction zero-at-sync + induced cage current + slip sign, 1-φ cap-start torque. Drives the agnostic pipeline only | L | `tests/machines/{brushed-dc-pm,brushed-dc-wound,universal,bldc,pmsm,induction-3ph,induction-1ph}.test.js` |
| 6.3.2 | One independent test per fixture for rows 8–13 + the two demos: VR/SRM/sync-rel reluctance closed form + λ_pm≡0, SRM ∝i² below knee, PM/hybrid detent presence/periodicity (class C), wound-field non-self-start + load-angle torque sign, skew ripple reduction, pole-mismatch zero net torque + ripple. Drives the agnostic pipeline only | L | `tests/machines/{vr-stepper,switched-reluctance,pm-stepper,hybrid-stepper,synchronous-reluctance,wound-field-synchronous,skew-demo,pole-mismatch-demo}.test.js` |

---

## Phase 7: Editors (cross-section, winding, schematic, matrix)
**Depends on**: Phase 5 (mount seams); consumes Phase 2 (winding model)
**Parallel with**: Phase 6, Phase 8

All panels register through the Phase-5 seams; none edits `mount.js`,
`config-schema.js`, `excitation.js`, or `motor-circuit.js`. Each panel builds its
own canvas in the host it is handed. Every edit lowers to the existing
`config.rings` / `config.circuits` vocabulary — no new physics path — so the
frozen engine is unchanged. No editor path is keyed to a machine.

### Wave 7.1: Cross-section renderer
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.1.1 | `cross-section-render.js`: 2D cross-section renderer with two modes — a **semantic** drawing built from `config.rings` (slots, teeth, magnets, conductor dot/cross glyphs coloured by circuit) and a toggleable **compiled-feature overlay** (per-cell `ν`/magnetization/coil-mask raster from `motor-compile`) that exposes rasterization/mesh errors at fine tooth geometries | L | `lessons/unified_motor/cross-section-render.js` |

### Wave 7.2: Winding editor
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.2.1 | `winding-editor.js`: concentrated (tap-tooth, wrap direction → N/S) and distributed (route conductor go-slot → return-slot, direction inferred) editing; live `F(θ)` / pole-count / back-EMF-shape feedback computed in the editor from the Phase-2 ampere-conductor map (winding-function proxy, no solve); commit on pointer-release via `requestRebuild()`. Phase and polarity emerge from routing | L | `lessons/unified_motor/winding-editor.js` |

### Wave 7.3: Circuit schematic
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.3.1 | `schematic-panel.js`: grid-snapped drag-drop circuit editor (sources, resistors, capacitors, switches, star/delta nodes, terminals); right-click a component → its parameter sliders. The topology **lowers** to the per-circuit `{terminal, commutation, R}` array: star/delta = the standard balanced transform, series resistance sets the real per-circuit `R`, manual/centrifugal switches flip a circuit `OPEN`↔driven (a panel rAF tracks `runtime.state.omega` for centrifugal cut-out), and a capacitor injects a quadrature `phaseOffset` for its phase-split effect. Parameter tweaks mutate `runtime.circuits` in place; structural changes call `requestRebuild()` | L | `lessons/unified_motor/schematic-panel.js` |

### Wave 7.4: Matrix/config panel
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.4.1 | `matrix-panel.js`: the 3–4-toggles-per-ring config UI (element + excitation + commutation per ring); **synthesizes** a complete `config` (rings + circuits + stack) generically from the toggle state (element-type dispatch only, zero machine identity) and calls `requestRebuild()` | M | `lessons/unified_motor/matrix-panel.js` |

### Wave 7.5: Test suite + page wiring
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.5.1 | Headless test suite over the four modules' pure functions (`buildGeometry`, `windingFunction`/`poleCount`/`windingFactor`, `lower`/`switchState`, `synthesize`), plus appending the four `<script>` tags into `index.html`'s module-extension region (sole Phase-7 touch of that file). **User-required**: browser verification of the live editing behaviour | M | `tests/editors/*.js`, `lessons/unified_motor/index.html` |

---

## Phase 8: Detailed mode (refined grid + Web Worker)
**Depends on**: Phase 5 (toggle/worker boundary)
**Parallel with**: Phase 6, Phase 7

### Wave 8.1: Refined solver tier
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.1.1 | `airgap-refine.js`: a uniformly-finer polar grid (k× the Live resolution, re-rasterized through the frozen `motor-compile`) + tooth-tip corner reluctivity regularization (graduating `ν` at iron convex corners to regularize the `r^(−1/3)` corner singularity); geometric multigrid (semi-coarsening in θ) for the high-`N` solve. Packaged as the refined `SolveBackend` consumed via the Phase-5 `opts.backend` seam | L | `lib/airgap-refine.js` |

### Wave 8.2: Worker harness + toggle
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.2.1 | `airgap-worker.js`: Web Worker harness hosting the standard `MotorRun`/`MotorStack` with a backend chosen by a **tier selector** (`selectBackend(backendOpts)`, `backendOpts.tier ∈ {"refined","nonlinear"}`, default refined) + a guarded `importScripts("airgap-nonlinear.js")` so Phase 9's tier plugs in without editing this file — the *same* time-domain sim, off the main thread (slow, not a different computation). Pure core (`compute` for a static torque-vs-angle sweep / field map + `createSession` for the streamed run) + a worker-context-guarded message pump; imports only `lib/` (the main thread expands the config and posts `expanded` + a state seed) | L | `lib/airgap-worker.js` |
| 8.2.2 | `detailed-toggle.js`: Live/Detailed header control (the explicit worker boundary, no per-frame switching) that spawns/terminates the worker, plus a companion result panel rendering the streamed refined frames + an on-demand zero-current cogging sweep + a **Saturation (nonlinear) checkbox** that sets `backendOpts.tier` (Phase-9 tier; browser-verified in Phase 9); registers via the Phase-5 header-control + panel seams. Feature-detects `Worker` (Detailed needs http://), Live unaffected | M | `lessons/unified_motor/detailed-toggle.js` |

### Wave 8.3: Tests
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.3.1 | Refined cogging/detent grid-converged to the ~1–5% target (Richardson: refine factor 2 vs 4) and provably finer than the Live coarse estimate; worker `compute` round-trips a torque-vs-angle table headless; the live off-thread behaviour is browser-verified (**user-required**). Appends `detailed-toggle.js` to `index.html` | M | `tests/detailed/*.test.js`, `lessons/unified_motor/index.html` |

---

## Phase 9: Saturation (nonlinear) + 3D render polish
**Depends on**: Phase 8 (refined tier + worker tier selector), Phase 5 (mount
render seam, `drawGapField`), Phase 1 (per-cell reluctivity primitives), Phase 6
(SRM fixture — class-C carve-out paid off here)
**Spec**: `spec/phase-9-saturation-and-render-polish.md`

Additive in its own Files Owned: the three runtime seams it needs are added to
the earlier (unbuilt) phases' specs — Phase 1's per-cell `ν` primitives, Phase 5's
`registerRender3D` slot, Phase 8's worker `backendOpts.tier` selector + guarded
`importScripts`. `lib/airgap-nonlinear.js` loads in the worker (not a page script);
`render3d.js` is the one page script Phase 9 appends to `index.html`.

### Wave 9.1: Nonlinear saturation
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 9.1.1 | `airgap-nonlinear.js`: a Phase-5 `SolveBackend` (sibling to `airgap-refine.js`) that reuses the refined grid + corner fillet + multigrid and iterates a **per-cell** `ν(B)` (Picard + under-relaxation, tabulated B–H) over the teeth-in-domain iron cells via the Phase-1 `getReluctivity`/`setIronReluctivity` primitives; selected in the Detailed worker by `backendOpts.tier:"nonlinear"`. Resolves the SRM aligned-vs-unaligned differential + tooth-tip saturation | L | `lib/airgap-nonlinear.js` |
| 9.1.2 | Saturation tests (headless, through `MotorStack`/`MotorSlice`): nonlinear tier ≈ linear below the knee + per-cell saturation above it; SRM aligned flux saturates while unaligned stays linear and the differential compresses vs the linear refined tier; tooth-tip torque sub-square rolloff; Live global ceiling flattens torque past the knee on a reluctance/PM/wound config; Phase-8 worker tier selector routes to the nonlinear backend | M | `tests/saturation/_fixtures.js`, `tests/saturation/*.test.js` |

### Wave 9.2: 3D render polish
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 9.2.1 | `render3d.js`: the polished 3D rig registered through the Phase-5 `registerRender3D` seam — axial extrusion of the cross-section, end-winding arcs (go→return over the stack ends), per-slice gap-field paint (consuming `drawGapField` unchanged, shared `magScale`), and a field-viz-mode header control. Pure geometry builders are headless-tested; `paint` is browser-verified | M | `lessons/unified_motor/render3d.js` |
| 9.2.2 | Render geometry test suite + `index.html` wiring (append `./render3d.js` in the marked region) + browser verification of the polished live viewport. **User-required**: browser checklist (extrusion/end-windings/per-slice field/viz-mode + the nonlinear Detailed checkbox) | M | `tests/render/_fixtures.js`, `tests/render/*.test.js`, `lessons/unified_motor/index.html` (append-only) |

---

## Phase 10: Legacy Reference Review + machine-agnosticism guard

> **Note:** Phase 10 has not been specced yet. Like every phase, it gets its detailed `spec/phase-10-*.md` and its `spec/manifest.json` `phases[]` entry authored (via `plan-spec`) when it is its turn to implement — so the absence of a Phase-10 spec file / manifest entry today is expected, not a gap. In the interim the audit's intent is mirrored by the manifest's top-level `verification[]` checks; the dependency graph lists Phase 10 for ordering.

**Depends on**: all previous phases

### Wave 10.1: Full audit
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 10.1.1 | One-shot audit script `scripts/agnosticism-audit.js` (`node`-run, not in `npm test`, no `package.json` change) exiting `0` over four checks: (1) **zero** machine-name references — 15 fixture ids as quoted literals + 7 word-tokens — across the enumerated **22 unified-motor-owned `lib/` + runtime-UI files** (allow-list, not all of `lib/`; `machines/*.js`, tests, docs, and pre-existing non-unified-motor token sites are out of scope); (2) no machine-type *field* (`machineType`/`motorType`/…) read by those 22 files; (3) no single-slice fast-path pattern in `lib/motor-stack.js`/`lib/motor-run.js`; (4) `git diff motor-baseline -- index.html lib/em-physics.js lib/coil-render.js lib/three-phase.js lib/layout3d.js lessons/ac_motor/` empty (`lib/field-render.js` excluded — Phase 5 owns it). The Phase-0 "stale references" clause is vacuous (Phase 0 deleted nothing). | M | `scripts/agnosticism-audit.js` |

---

## Open items deferred to plan-spec

These are spec-level decisions, surfaced now so the per-phase `plan-spec` work
resolves them with the author rather than silently:

- **[resolved, Phase 5]** Phase 5 smoke set: four configs through one
  `LIB.MotorRun` path — a current-fed wound machine (`W` stator + salient `I`
  rotor, `DC`, `none` commutation — exercises the circuit layer with no
  commutation dependency), a PM machine (`M` rotor + current-fed `W` stator), a
  salient-iron reluctance machine (`I` rotor + `C` stator), and one `N=2` skew
  config (the wound machine sliced into two with a small skew offset). Maxwell
  vs co-energy agreement asserted at ≤10% relative on the coarse smoke grids
  (the tight analytic check stays in Phase 1). The per-tick driver is a
  dedicated `lib/motor-run.js`; `config-schema.js` is vocabulary-complete in
  Phase 5 (Phase 6 is data-only); the co-energy decomposition is test-only, not
  a live readout.
- **[resolved, Phase 1]** Polar grid resolution defaults: `Nθ=256, Nr=12`
  (both overridable per grid). PCG/multigrid crossover: Phase 1 ships **PCG
  only** (Jacobi-preconditioned); geometric multigrid is deferred to the Phase 8
  fine tier. Primary torque is the **Arkkio gap-band average** (radial-averaged
  Maxwell stress), not a single mid-gap contour.
- **[resolved, Phase 1]** Test runner: `node:test` (zero dependency), `npm test`
  → `node --test`, Node ≥18. DOM-free `window.LIB` modules are exercised headless
  through a `window`-global `require` shim.
- **[resolved, Phase 8]** Worker message schema: the main thread expands the
  config and posts `{ kind, expanded, stateSeed, currents, thetas, backendOpts,
  dt, stepsPerMessage }`; the worker streams `{ kind:"frame", state, torque,
  field? }` during a run and `{ kind:"sweepResult", thetas, torques }` for a
  one-shot table — all structured-clone-safe plain data, so `lib/airgap-worker.js`
  never imports the app-layer `config-schema.js`. Warm-start cache invalidation
  follows the Phase-5 rule unchanged (cleared on Reset and on geometry edits);
  the Detailed toggle re-seeds a fresh worker session from the current state on
  enable and on geometry change (the explicit worker boundary, never per-frame).
