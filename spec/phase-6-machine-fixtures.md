# Phase 6: Machine config fixtures + independent validation

## Overview

Every machine on the syllabus is **data** in this phase — no `lib/` or runtime
code changes. Each of the 13 matrix rows, plus a skew demo and a pole-mismatch
demo, is authored as a `lessons/unified_motor/machines/<id>.js` config fixture
that conforms to the Phase-5 `UnifiedMotor.ConfigSchema` vocabulary, and is
exercised by one independent validation test that drives the *agnostic* pipeline
(`LIB.MotorRun` / `LIB.MotorStack` / `ConfigSchema.expand`) and nothing
machine-specific. Hybrid stepper and skew are ordinary fixtures of the universal
axial slice-stack container (`stack.slices ≥ 2`), not special constructs.

The phase proves the project's reason for existing from the *data* side: 15
structurally-different machines, each encoded purely as a ring/excitation/
commutation/stack configuration, all run and validate through one code path that
has never heard of any of them.

Three waves:

1. **Wave 6.1** — the 15 fixture files (data only) + their registration in the
   Phase-5 `index.html` module-extension region.
2. **Wave 6.2** — the shared test loader + measurement helpers
   (`tests/machines/_fixtures.js`), built on the Phase-5 pipeline loader.
3. **Wave 6.3** — one independent validation test per fixture.

### Why three waves (not the plan's original two)

The decision to author **one file per machine** (15 fixtures) plus a selectable
pole-mismatch demo exceeds the 10-file task-group cap if Wave 6.1 is a single
task, and the per-fixture tests share one loader that must exist before they
run. The wave split keeps every task_group inside the cap and respects the
loader→tests file dependency.

## Conventions fixed for this phase

These conventions are the contract. Per-fixture **structure** (rings, circuits,
stack, element/excitation/commutation choices, grid, pole counts) is fixed by
this spec and may not be reinterpreted. Per-fixture **scalar magnitudes** (turns,
`R`, drive `amp`, `Mr`, `J`, `damping`) carry the defaults below and may be tuned
*only* to satisfy a named numeric acceptance assertion — never to change which
behaviour is demonstrated.

### Fixture module shape (data only, dual-target)

Each fixture is a `"use strict"` IIFE that builds one plain `config` object and
registers it. It performs **no** pipeline call at load (no `expand`, no
`MotorStack.create`) — it is pure data, loadable identically under the Node
`require` shim and in the browser:

```js
(function () {
  const config = { /* ConfigSchema descriptor — see per-fixture spec */ };
  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "<id>", label: "<label>", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;   // first-loaded becomes app default
})();
```

This adds the lazy app-layer registry `window.UnifiedMotor.MACHINES` (array of
`{ id, label, config }`) and an app default. It touches **no** `lib/` module and
**no** `mount.js`; it is app-layer data, consistent with the Phase-5 namespace
convention (`UnifiedMotor.PANELS`/`TOOLS`/`HEADER_CONTROLS`). Phase 7's matrix
panel consumes `MACHINES`; Phase 5's mount already falls back to
`UnifiedMotor.defaultConfig` when set.

### Baseline geometry (shared by every fixture unless a per-fixture override is stated)

```
grid:    { Nr: 12, Ntheta: 256, rInner: 0.030, rOuter: 0.055, ell: 0.10 }
gapBand: { iInner: 6, iOuter: 8 }                 // gap cells 6,7 (centres ≈ 0.0435, 0.0456 m)
poles:   <per fixture; positive even int>
mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 }
```

Radial bands (all `rRange` values; `dr = (0.055−0.030)/12 ≈ 0.0020833`):

| Band | rRange (m) | Use |
|---|---|---|
| `ROTOR_YOKE` | `[0.030, 0.038]` | rotor back-iron |
| `ROTOR_SURFACE` | `[0.038, 0.043]` | rotor magnets / teeth / conductors |
| `GAP` | `[0.043, 0.047]` | air gap (Arkkio band cells 6,7) |
| `STATOR_SURFACE` | `[0.047, 0.051]` | stator slots / teeth / conductors |
| `STATOR_YOKE` | `[0.051, 0.055]` | stator back-iron |

Rotor features use `member:"rotor"`; stator features `member:"stator"`. Iron
features (`muR`) default `muR: 1000`. Salient-iron `spanFraction` default `0.5`.
Magnet `Mr` default `8e5` (A/m), `Mtheta: 0`, alternating N/S handled by the
schema's `(−1)^g`. Magnet rings set `backIron: true`, `backIronRRange:
ROTOR_YOKE`.

### Wound rings via `standardWinding` only

Every `W`/`C`/`K` ring resolves its routing through
`ring.winding = { standard: { m, p, Q, coilPitch, turns } }`
(`LIB.WindingModel.standardWinding`). Concentrated rings (`C`) use
`coilPitch: 1` (tooth-concentrated chord) and the schema additionally emits the
per-slot salient teeth; distributed rings (`W`) use `coilPitch = Q/p`
(full-pitch). `Q` is always divisible by `m·p` and `1 ≤ coilPitch ≤ Q/p` (the
`standardWinding` precondition). No explicit `routing` objects are authored in
this phase. Each wound ring sets `slotRRange` to its surface band, `slotFraction:
0.5`, `ironRRange` to its yoke band, `muR: 1000`. `turns` default `40` (DC field
windings `60`, cage `1`).

### Representative pole / tooth counts

The DESIGN's matrix pole counts are illustrative ranges (BLDC "14", PMSM "4–8",
hybrid "50-tooth"). Because the Live coarse grid must *resolve* the angular
features and the validation runs on the production grid, fixtures use clean,
grid-resolvable representative counts — predominantly `poles: 4` (`p = 4`,
`Q = 12`, ≥ 64 grid cells per pole-pair) and `poles: 2` for the brushed/universal
single-phase machines. The hybrid uses a reduced rotor tooth count (5 teeth per
slice). The physics is pole-count-agnostic by invariant #1, so the reduction
changes resolution and step granularity, not which phenomenon is demonstrated.
This is a stated convention, not silent narrowing.

### Circuit indexing (so the `circuits` array is unambiguous)

`ConfigSchema.expand` walks **rings in declared order**; each wound ring
contributes `m` circuits (one branch per phase, in phase order). Every fixture
declares rings **rotor ring(s) first, then stator ring(s)**, and its
`config.circuits` array is ordered to match: rotor-ring circuits (phase order)
then stator-ring circuits (phase order). `M` and `I` rings contribute **zero**
circuits. Each circuit is `{ terminal, commutation, R }` with:

- `terminal`: `{ type, amp?, freq?, phaseOffset?, conductionAngle? }`, `type ∈
  {AC,DC,PULSE,STEP,OPEN,SHORT}`.
- `commutation`: `{ mode, poles?, loadAngle?, stepAngleElec?, conductionAngle? }`,
  `mode ∈ {none,mechanical,electronic-trap,electronic-sine,sequencer}`.
  Commutation `poles` equals the machine's `poles`.
- `R`: finite `≥ 0` (default `1.0`; cage `0.05`).

Emergent polyphase: an m-phase circuit set carries `phaseOffset = −2π·k/m`
(`k = 0…m−1`) on its circuits.

### Tolerance scheme (the three reference classes, confirmed with the author)

Every numeric assertion is tagged with the class it belongs to. The classes:

- **(A) Analytic-tight** — compared to a parameter-free closed form. Tolerances:
  `cos2θ` inductance fit `r² ≥ 0.99`; torque/current proportionality ratios
  within **3%**; zero-net-torque `|mean| ≤ 0.05·(max−min)/2`; zero-at-synchronous
  `|T(s=0)| ≤ 0.02·|T(standstill)|`.
- **(B) Internal Maxwell-vs-co-energy** — the **universal** cross-check applied
  to *every* fixture at a loaded operating point:
  `|arkkio − coe| ≤ XC_TOL·max(|arkkio|, |coe|) + XC_FLOOR`,
  with `XC_TOL = 0.05`, `XC_FLOOR = 1e-6`, asserted only where
  `max(|arkkio|, |coe|) > 1e-5` (so a near-zero torque can't blow up the ratio).
- **(C) Phase-8/9 carve-out** — quantities the coarse linear gap-only grid
  cannot resolve to magnitude: **cogging / detent amplitude** (PM stepper,
  hybrid, BLDC/PMSM low-current cogging) and the **SRM saturated
  aligned-vs-unaligned differential**. Phase 6 asserts only **presence, sign,
  and periodicity** (sign-change count over a mechanical revolution); the
  magnitude check is owned by Phases 8/9. No magnitude tolerance is asserted
  here.

`XC_TOL = 0.05` is a single named constant in the test loader; `review-spec` or
the implementer may tighten it (e.g. to `0.03`) only with measured evidence,
never loosen it.

### Test runner / loader

`node:test` + `node:assert/strict`; `npm test` → `node --test`. Wave 6.2's
`tests/machines/_fixtures.js` is **not** a test file (no `.test.js` suffix). It
`require`s the Phase-5 pipeline loader `../pipeline/_fixtures.js` **read-only**
(which installs `window` + every engine/pipeline lib and exposes `LIB`,
`UnifiedMotor`, `assertClose`, `fitCos2`), then `require`s all 15 fixture files so
they register on `UnifiedMotor.MACHINES`. It modifies **no** Phase-1–5 file. The
Wave-6.3 test files `require("./_fixtures.js")` only.

## Files Owned

Fixtures (created):

- `lessons/unified_motor/machines/brushed-dc-pm.js`
- `lessons/unified_motor/machines/brushed-dc-wound.js`
- `lessons/unified_motor/machines/universal.js`
- `lessons/unified_motor/machines/bldc.js`
- `lessons/unified_motor/machines/pmsm.js`
- `lessons/unified_motor/machines/induction-3ph.js`
- `lessons/unified_motor/machines/induction-1ph.js`
- `lessons/unified_motor/machines/vr-stepper.js`
- `lessons/unified_motor/machines/switched-reluctance.js`
- `lessons/unified_motor/machines/pm-stepper.js`
- `lessons/unified_motor/machines/hybrid-stepper.js`
- `lessons/unified_motor/machines/synchronous-reluctance.js`
- `lessons/unified_motor/machines/wound-field-synchronous.js`
- `lessons/unified_motor/machines/skew-demo.js`
- `lessons/unified_motor/machines/pole-mismatch-demo.js`

Page registration (modified, append-only):

- `lessons/unified_motor/index.html` — **append within the marked module
  extension region only** (the sanctioned shared inclusion manifest declared in
  the Phase-5 spec). No other line is touched.

Test loader (created):

- `tests/machines/_fixtures.js`

Validation tests (created), one per fixture:

- `tests/machines/brushed-dc-pm.test.js`
- `tests/machines/brushed-dc-wound.test.js`
- `tests/machines/universal.test.js`
- `tests/machines/bldc.test.js`
- `tests/machines/pmsm.test.js`
- `tests/machines/induction-3ph.test.js`
- `tests/machines/induction-1ph.test.js`
- `tests/machines/vr-stepper.test.js`
- `tests/machines/switched-reluctance.test.js`
- `tests/machines/pm-stepper.test.js`
- `tests/machines/hybrid-stepper.test.js`
- `tests/machines/synchronous-reluctance.test.js`
- `tests/machines/wound-field-synchronous.test.js`
- `tests/machines/skew-demo.test.js`
- `tests/machines/pole-mismatch-demo.test.js`

> `index.html` is Phase-5-owned; its appearance here is the append-only shared
> inclusion manifest pre-approved in the Phase-5 spec, not a silent overlap. No
> other file in this list appears in any other phase's Files Owned. `tests/_shim.js`
> and every Phase-1–5 file are byte-unchanged.

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 6.1: Config fixtures + registration

### Task 6.1.1: Fixtures — matrix rows 1–7

- **Description**: Author the first seven matrix-row fixtures as data-only
  modules per the conventions above. Each builds one `config` and registers it on
  `UnifiedMotor.MACHINES`. No pipeline call at load.
- **Files to create** (each file = the registration IIFE + one `config`):

  - `lessons/unified_motor/machines/brushed-dc-pm.js` — **id** `"brushed-dc-pm"`,
    **label** `"Brushed DC (PM field)"`. `poles: 2`. Rings (declared order):
    1. `{ member:"rotor", element:"W", rRange: ROTOR_SURFACE,
       winding:{ standard:{ m:1, p:2, Q:8, coilPitch:4, turns:30 } },
       slotRRange: ROTOR_SURFACE, slotFraction:0.5, ironRRange: ROTOR_YOKE, muR:1000 }`
    2. `{ member:"stator", element:"M", rRange: STATOR_SURFACE, magnets:2,
       Mr:8e5, backIron:true, backIronRRange: STATOR_YOKE, muR:1000 }`
    `circuits`: `[ { terminal:{type:"DC",amp:12}, commutation:{mode:"mechanical",
    poles:2, conductionAngle:Math.PI}, R:1.0 } ]` (one — the armature; the PM
    stator has no circuit).
    `stack`: `{ slices:1, sliceOffsets:[0], fluxSources:[] }`.

  - `lessons/unified_motor/machines/brushed-dc-wound.js` — **id**
    `"brushed-dc-wound"`, **label** `"Brushed DC (wound field)"`. `poles: 2`.
    Rings:
    1. rotor `W` armature — as `brushed-dc-pm` rotor (`turns:30`).
    2. `{ member:"stator", element:"W", rRange: STATOR_SURFACE,
       winding:{ standard:{ m:1, p:2, Q:8, coilPitch:4, turns:60 } },
       slotRRange: STATOR_SURFACE, slotFraction:0.5, ironRRange: STATOR_YOKE, muR:1000 }`
    `circuits` (rotor then stator): `[ {DC armature, mechanical, poles:2,
    conductionAngle:π, R:1.0}, {DC field, none, R:2.0} ]`.
    `stack`: single slice.

  - `lessons/unified_motor/machines/universal.js` — **id** `"universal"`,
    **label** `"Universal (AC series)"`. `poles: 2`. Rings identical to
    `brushed-dc-wound` (armature `turns:30`, field `turns:60`). `circuits`:
    `[ { terminal:{type:"AC",amp:12,freq:50,phaseOffset:0}, commutation:
    {mode:"mechanical",poles:2,conductionAngle:Math.PI}, R:1.0 },
    { terminal:{type:"AC",amp:12,freq:50,phaseOffset:0}, commutation:{mode:"none"},
    R:1.0 } ]` (armature commutated, field in phase). `stack`: single slice.

  - `lessons/unified_motor/machines/bldc.js` — **id** `"bldc"`, **label**
    `"BLDC (trapezoidal)"`. `poles: 4`. Rings:
    1. `{ member:"rotor", element:"M", rRange: ROTOR_SURFACE, magnets:4, Mr:9e5,
       backIron:true, backIronRRange: ROTOR_YOKE, muR:1000 }`
    2. `{ member:"stator", element:"C", rRange: STATOR_SURFACE,
       winding:{ standard:{ m:3, p:4, Q:12, coilPitch:1, turns:40 } },
       slotRRange: STATOR_SURFACE, slotFraction:0.5, ironRRange: STATOR_YOKE, muR:1000 }`
    `circuits` (stator only, 3 phases): for `k = 0,1,2`,
    `{ terminal:{type:"PULSE",amp:48,phaseOffset:-2*Math.PI*k/3,
    conductionAngle:2*Math.PI/3}, commutation:{mode:"electronic-trap",poles:4},
    R:0.5 }`. `stack`: single slice.

  - `lessons/unified_motor/machines/pmsm.js` — **id** `"pmsm"`, **label**
    `"PMSM (sinusoidal)"`. `poles: 4`. Rings:
    1. rotor `M` — as `bldc` rotor.
    2. `{ member:"stator", element:"W", rRange: STATOR_SURFACE,
       winding:{ standard:{ m:3, p:4, Q:12, coilPitch:3, turns:40 } },
       slotRRange: STATOR_SURFACE, slotFraction:0.5, ironRRange: STATOR_YOKE, muR:1000 }`
    `circuits` (3 phases): `{ terminal:{type:"AC",amp:24,freq:0,
    phaseOffset:-2π·k/3}, commutation:{mode:"electronic-sine",poles:4}, R:0.5 }`
    (`electronic-sine` slaves phase to rotor; `freq` unused under sine
    commutation). `stack`: single slice.
    > This fixture is registered **first** (see Task 6.1.3) so the app boots into
    > a smooth, self-starting PMSM by default.

  - `lessons/unified_motor/machines/induction-3ph.js` — **id** `"induction-3ph"`,
    **label** `"3-φ induction"`. `poles: 4`. Rings (rotor cage first):
    1. `{ member:"rotor", element:"K", rRange: ROTOR_SURFACE,
       winding:{ standard:{ m:3, p:4, Q:12, coilPitch:1, turns:1 } },
       slotRRange: ROTOR_SURFACE, slotFraction:0.5, ironRRange: ROTOR_YOKE, muR:1000 }`
       (equivalent shorted-polyphase cage: 3 branches of series coils; the
       end-ring mesh is abstracted as series chaining + the `SHORT` terminal — a
       literal bar/end-ring mesh is not expressible in the routing schema and is
       out of scope).
    2. `{ member:"stator", element:"W", rRange: STATOR_SURFACE,
       winding:{ standard:{ m:3, p:4, Q:12, coilPitch:3, turns:40 } },
       slotRRange: STATOR_SURFACE, slotFraction:0.5, ironRRange: STATOR_YOKE, muR:1000 }`
    `circuits` (rotor cage 3 then stator 3): cage circuits
    `{ terminal:{type:"SHORT"}, commutation:{mode:"none"}, R:0.05 }`; stator
    circuits `{ terminal:{type:"AC",amp:24,freq:50,phaseOffset:-2π·k/3},
    commutation:{mode:"none"}, R:0.5 }`. `stack`: single slice.

  - `lessons/unified_motor/machines/induction-1ph.js` — **id** `"induction-1ph"`,
    **label** `"1-φ induction (cap-start)"`. `poles: 2`. Rings (rotor cage first):
    1. rotor `K` cage `{ standard:{ m:3, p:2, Q:12, coilPitch:1, turns:1 } }`,
       bands as `induction-3ph` rotor.
    2. `{ member:"stator", element:"W",
       winding:{ standard:{ m:2, p:2, Q:8, coilPitch:1, turns:40 } }, … }`
       (a two-phase stator: phase 0 = main, phase 1 = auxiliary, spatially 90°
       apart by construction of the `m=2` belt).
    `circuits` (cage 3, then stator main + aux):
    cage `{SHORT, none, R:0.05}`×3; main `{ terminal:{type:"AC",amp:24,freq:50,
    phaseOffset:0}, commutation:{mode:"none"}, R:0.5 }`; aux `{ terminal:
    {type:"AC",amp:24,freq:50,phaseOffset:Math.PI/2}, commutation:{mode:"none"},
    R:0.8 }` (the `π/2` phase shift models the start capacitor). `stack`: single
    slice.

- **Files to modify**: none.
- **Tests** (authored in Wave 6.3): `tests/machines/<id>.test.js` for each id
  above.
- **Acceptance criteria**:
  - Each file, when `require`d under the Node shim, pushes exactly one
    `{ id, label, config }` onto `window.UnifiedMotor.MACHINES` with the id above,
    and accesses no DOM/canvas and calls no pipeline function at load.
  - For each fixture, `UnifiedMotor.ConfigSchema.validate(config).ok === true`
    (asserted in Wave 6.3).
  - For each fixture, `UnifiedMotor.ConfigSchema.expand(config)` produces
    `circuits.length === config.circuits.length` and every
    `slices[*].section.features[*].kind ∈ {conductor,magnet,iron}` (asserted in
    Wave 6.3).
  - The seven files contain machine-name string literals only as the `id`/`label`
    data fields (allowed — `machines/` is the sanctioned location).

### Task 6.1.2: Fixtures — matrix rows 8–13 + skew demo + pole-mismatch demo

- **Description**: Author the remaining six matrix-row fixtures plus the two
  demo fixtures, per the conventions above.
- **Files to create**:

  - `lessons/unified_motor/machines/vr-stepper.js` — **id** `"vr-stepper"`,
    **label** `"VR stepper"`. `poles: 4`. Rings:
    1. `{ member:"rotor", element:"I", rRange: ROTOR_SURFACE, teeth:4, theta0:0,
       spanFraction:0.5, muR:1000 }` (salient iron, no magnet, no winding).
    2. stator `C` `{ standard:{ m:3, p:4, Q:12, coilPitch:1, turns:40 } }`, bands
       as in `bldc` stator.
    `circuits` (stator 3): `{ terminal:{type:"STEP",amp:24,conductionAngle:Math.PI,phaseOffset:-2*Math.PI*k/3}, commutation:{mode:"sequencer",poles:4,stepAngleElec:2*Math.PI/3}, R:0.5 }`. `stack`: single slice.

  - `lessons/unified_motor/machines/switched-reluctance.js` — **id**
    `"switched-reluctance"`, **label** `"Switched reluctance"`. `poles: 4`. Rings:
    rotor `I` `teeth:4` (as `vr-stepper`); stator `C`
    `{ standard:{ m:3, p:4, Q:12, coilPitch:1, turns:40 } }`. `circuits` (3):
    `{ terminal:{type:"PULSE",amp:48,phaseOffset:-2π·k/3,conductionAngle:2*Math.PI/3},
    commutation:{mode:"electronic-trap",poles:4}, R:0.5 }`. `stack`: single slice.

  - `lessons/unified_motor/machines/pm-stepper.js` — **id** `"pm-stepper"`,
    **label** `"PM stepper"`. `poles: 4`. Rings:
    1. rotor `M` `{ magnets:4, Mr:8e5, backIron:true, backIronRRange: ROTOR_YOKE,
       muR:1000 }`.
    2. stator `C` `{ standard:{ m:2, p:4, Q:8, coilPitch:1, turns:40 } }`
       (2-phase bipolar).
    `circuits` (2): `{ terminal:{type:"STEP",amp:24,phaseOffset:-Math.PI/2*k,
    conductionAngle:Math.PI}, commutation:{mode:"sequencer",poles:4,
    stepAngleElec:Math.PI/2}, R:0.6 }` for `k=0,1`. `stack`: single slice.

  - `lessons/unified_motor/machines/hybrid-stepper.js` — **id** `"hybrid-stepper"`,
    **label** `"Hybrid stepper"`. `poles: 4`. Rings (declared order — `M` ring is
    index 0, referenced by `fluxSources`):
    1. `{ member:"rotor", element:"M", rRange:[0.038,0.0405], magnets:2, Mr:8e5,
       backIron:false, muR:1000 }` (the shared axial-PM bias source).
    2. `{ member:"rotor", element:"I", rRange:[0.0405,0.043], teeth:5, theta0:0,
       spanFraction:0.5, muR:1000 }` (the toothed pole pieces).
    3. stator `C` `{ standard:{ m:2, p:4, Q:8, coilPitch:1, turns:40 } }`.
    `circuits` (stator 2): as `pm-stepper` (`STEP`, `sequencer`).
    `stack`: `{ slices:2, sliceOffsets:[0, Math.PI/5],
    fluxSources:[ { ringRef:0, sliceSigns:[+1,-1] } ] }` — two slices, a
    half-tooth offset (`π/5` for 5 teeth → `(2π/5)/2`), and the shared axial PM
    (ring 0) biased opposite-sign per slice.

  - `lessons/unified_motor/machines/synchronous-reluctance.js` — **id**
    `"synchronous-reluctance"`, **label** `"Synchronous reluctance"`. `poles: 4`.
    Rings: rotor `I` `teeth:4` (as `vr-stepper`); stator `W`
    `{ standard:{ m:3, p:4, Q:12, coilPitch:3, turns:40 } }`. `circuits` (3):
    `{ terminal:{type:"AC",amp:24,phaseOffset:-2π·k/3}, commutation:
    {mode:"electronic-sine",poles:4}, R:0.5 }`. `stack`: single slice.

  - `lessons/unified_motor/machines/wound-field-synchronous.js` — **id**
    `"wound-field-synchronous"`, **label** `"Wound-field synchronous"`. `poles: 4`.
    Rings (rotor field first):
    1. `{ member:"rotor", element:"W", rRange: ROTOR_SURFACE,
       winding:{ standard:{ m:1, p:4, Q:8, coilPitch:2, turns:60 } },
       slotRRange: ROTOR_SURFACE, slotFraction:0.5, ironRRange: ROTOR_YOKE, muR:1000 }`
    2. stator `W` `{ standard:{ m:3, p:4, Q:12, coilPitch:3, turns:40 } }`.
    `circuits` (rotor field 1, then stator 3): field `{ terminal:{type:"DC",amp:12},
    commutation:{mode:"none"}, R:2.0 }`; stator `{ terminal:{type:"AC",amp:24,
    freq:50,phaseOffset:-2π·k/3}, commutation:{mode:"none"}, R:0.5 }` (true
    synchronous: `none` commutation, so it does not self-start). `stack`: single
    slice.

  - `lessons/unified_motor/machines/skew-demo.js` — **id** `"skew-demo"`,
    **label** `"Skew demo (4 slices)"`. `poles: 4`. Rings: rotor `M`
    `{ magnets:4, Mr:8e5, backIron:true, backIronRRange: ROTOR_YOKE, muR:1000 }`;
    stator `W` `{ standard:{ m:3, p:4, Q:12, coilPitch:3, turns:40 } }`.
    `circuits` (3): `{ terminal:{type:"AC",amp:24,phaseOffset:-2π·k/3},
    commutation:{mode:"electronic-sine",poles:4}, R:0.5 }`.
    `stack`: `{ slices:4, sliceOffsets:[0, s, 2s, 3s], fluxSources:[] }` with
    skew increment `s = (2*Math.PI/4)/(2*4) = Math.PI/16` (one slot-pitch of skew
    distributed over 4 slices). `fluxSources` empty (magnets are per-slice,
    unbiased).

  - `lessons/unified_motor/machines/pole-mismatch-demo.js` — **id**
    `"pole-mismatch-demo"`, **label** `"Pole mismatch (4-pole stator / 6-pole rotor)"`.
    `poles: 4` (the stator working harmonic; commutation uses `poles:4`). Rings:
    1. `{ member:"rotor", element:"I", rRange: ROTOR_SURFACE, teeth:6, theta0:0,
       spanFraction:0.5, muR:1000 }` (6-pole reluctance periodicity — no shared
       working harmonic with the 4-pole stator).
    2. stator `W` `{ standard:{ m:3, p:4, Q:12, coilPitch:3, turns:40 } }`.
    `circuits` (3): `{ terminal:{type:"AC",amp:24,phaseOffset:-2π·k/3},
    commutation:{mode:"electronic-sine",poles:4}, R:0.5 }`. `stack`: single slice.

- **Files to modify**: none.
- **Tests** (authored in Wave 6.3): `tests/machines/<id>.test.js` for each id.
- **Acceptance criteria**:
  - Each file `require`s cleanly under the Node shim, pushing one
    `{ id, label, config }` with the id above onto `UnifiedMotor.MACHINES`, with no
    DOM access and no pipeline call at load.
  - `validate(config).ok === true` for every fixture (asserted in Wave 6.3).
  - `expand(hybridStepper).slices.length === 2` and the ring-0 magnet `Mr` of
    slice 1 is the exact negative of slice 0's (the `sliceSigns:[+1,-1]` flux
    source) — these `expand()`-dependent assertions cannot pass until Wave 6.3
    (the pipeline loader does not exist yet); they are verified in Wave 6.3's
    `hybrid-stepper.test.js`.
  - `expand(skewDemo).slices.length === 4` with `slices[k].offset === k·(π/16)`
    — likewise verified in Wave 6.3's `skew-demo.test.js`, not at Wave 6.1 time.
  - Eight files created; machine-name literals appear only as `id`/`label` data.

### Task 6.1.3: Register fixtures in `index.html`

- **Description**: Append the 15 fixture `<script>` tags to the Phase-5
  `index.html` module-extension region so the browser loads every machine
  fixture. **Edits only the marked region**; touches no other line.
- **Files to modify**:
  - `lessons/unified_motor/index.html` — inside the exact marker block
    ```html
    <!-- unified-motor modules: later phases append <script> tags below this line ONLY -->
    <!-- /unified-motor modules -->
    ```
    insert these 15 lines, in this order (`pmsm.js` **first** so it becomes the
    app default via the `if (!UM.defaultConfig)` idiom):
    ```html
    <script src="./machines/pmsm.js"></script>
    <script src="./machines/brushed-dc-pm.js"></script>
    <script src="./machines/brushed-dc-wound.js"></script>
    <script src="./machines/universal.js"></script>
    <script src="./machines/bldc.js"></script>
    <script src="./machines/induction-3ph.js"></script>
    <script src="./machines/induction-1ph.js"></script>
    <script src="./machines/vr-stepper.js"></script>
    <script src="./machines/switched-reluctance.js"></script>
    <script src="./machines/pm-stepper.js"></script>
    <script src="./machines/hybrid-stepper.js"></script>
    <script src="./machines/synchronous-reluctance.js"></script>
    <script src="./machines/wound-field-synchronous.js"></script>
    <script src="./machines/skew-demo.js"></script>
    <script src="./machines/pole-mismatch-demo.js"></script>
    ```
- **Files to create**: none.
- **Tests**: structural — covered by `tests/machines/registry.assertions` folded
  into each fixture test (the loader asserts all 15 ids are present in
  `MACHINES`). No browser assertion is headless; the script-tag presence is
  verified by reading `index.html` in Wave 6.3's loader test (below).
- **Acceptance criteria**:
  - The 15 lines appear inside the marker block, in the stated order, each a
    plain `<script src="./machines/<id>.js">`; no line outside the marker block is
    modified (verified by diffing against the Phase-5 `index.html`).
  - The script tags reference exactly the 15 fixture filenames created in Tasks
    6.1.1–6.1.2 (no missing, no extra).

---

## Wave 6.2: Test loader + measurement helpers

### Task 6.2.1: `tests/machines/_fixtures.js` — loader + shared validation toolkit

- **Description**: The shared headless loader and the measurement helpers every
  Wave-6.3 test uses, so the per-machine tests stay short and consistent. Built
  on the Phase-5 pipeline loader (read-only); registers all 15 fixtures; exposes
  the agnostic-pipeline drivers and the analytic/cross-check measurement helpers.
- **Files to create**:
  - `tests/machines/_fixtures.js` — not a test file (no `.test.js`). On require:
    - `const P = require("../pipeline/_fixtures.js");` — installs `window` + all
      engine/pipeline libs; provides `P.LIB`, `P.UnifiedMotor`, `P.assertClose`,
      `P.fitCos2`.
    - `require` all 15 fixture files
      (`../../lessons/unified_motor/machines/<id>.js`) so they register on
      `window.UnifiedMotor.MACHINES`.
    - Build `const byId = Object.fromEntries(P.UnifiedMotor.MACHINES.map(m => [m.id, m]));`.
    - Export:
      - `LIB` (`= P.LIB`), `UnifiedMotor` (`= P.UnifiedMotor`), `byId`,
        `assertClose` (`= P.assertClose`), `fitCos2` (`= P.fitCos2`).
      - Constants `XC_TOL = 0.05`, `XC_FLOOR = 1e-6`.
      - `MACHINE_IDS` — the frozen array of all 15 ids (used by tests to assert
        registry completeness).
      - `build(id) → { config, expanded, stack, runtime }` —
        `config = byId[id].config`;
        `expanded = UnifiedMotor.ConfigSchema.expand(config)`;
        `stack = LIB.MotorStack.create(expanded)`;
        `runtime = LIB.MotorRun.create(expanded)`.
      - `validate(id) → { ok, errors }` —
        `UnifiedMotor.ConfigSchema.validate(byId[id].config)`.
      - `sweepTorque(stack, currents, thetas) → number[]` — for each `θ` in
        `thetas`, `stack.solve(θ, currents).torque`. (`currents` may be a
        `Float64Array` or a function `θ → Float64Array`.)
      - `sweepInductance(stack, thetas, kk) → number[]` — for each `θ`,
        `stack.extractCoeffs(θ).L[kk*stack.nCircuits + kk]` (diagonal self-
        inductance of circuit `kk`).
      - `sweepLambdaPm(stack, thetas, k) → number[]` — for each `θ`,
        `stack.extractCoeffs(θ).lambdaPm[k]`.
      - `crossCheck(stack, theta, currents) → { arkkio, coe, rel, ok }` —
        `arkkio = stack.solve(theta, currents).torque`;
        `coe = stack.coenergyTorque(theta, currents).total`;
        `rel = Math.abs(arkkio − coe)`;
        `ok = Math.max(Math.abs(arkkio), Math.abs(coe)) <= 1e-5 || rel <= XC_TOL·Math.max(Math.abs(arkkio), Math.abs(coe)) + XC_FLOOR`
        (the first clause guards against near-zero torque blowing up the ratio; see class-(B) tolerance scheme).
      - `runFromRest(runtime, steps = 400, dt = 1/240) → state` — calls
        `runtime.reset()` then `runtime.step(dt)` `steps` times; returns
        `runtime.state`.
      - `avgTorqueAtSpeed(runtime, omega, cycles, freq, dt = 1/240) → number` —
        `runtime.reset()`; set `runtime.state.omega = omega` and re-pin it after
        every `runtime.step(dt)` (so the rotor advances at fixed `omega` while
        currents evolve); accumulate `runtime.lastSolve.torque` over `cycles`
        electrical periods (`period = 1/Math.max(freq,1e-9)`); return the mean.
      - `dftAmp(values, order) → number` — discrete Fourier amplitude of harmonic
        `order` over the uniformly-sampled `values` (one period):
        `2/N·hypot(Σ vₙ cos(2π·order·n/N), Σ vₙ sin(2π·order·n/N))`. Computed
        inline; no pipeline dependency.
      - `signChanges(values) → int` — count of adjacent sign flips in `values`
        (periodicity probe for detent).
      - `ripple(values) → number` — `Math.max(...values) − Math.min(...values)`.
      - `mean(values) → number`.
      - `readIndexHtml() → string` — `fs.readFileSync` of
        `lessons/unified_motor/index.html` (used by the loader test to confirm the
        15 script tags).
- **Files to modify**: none.
- **Tests**: a single self-test file is **not** added here; the loader is
  exercised by every Wave-6.3 file. Wave 6.3's `pmsm.test.js` additionally
  asserts loader-level invariants (registry completeness + index.html script
  tags) so the loader has explicit coverage.
- **Acceptance criteria**:
  - `require("./_fixtures.js")` succeeds under Node with no DOM access and
    returns an object exposing `LIB`, `UnifiedMotor`, `byId`, `MACHINE_IDS`
    (length 15), `assertClose`, `fitCos2`, `XC_TOL`, `XC_FLOOR`, and every helper
    above as a function.
  - After load, `UnifiedMotor.MACHINES.length === 15` and `byId` has all 15
    ids in `MACHINE_IDS`.
  - `tests/machines/_fixtures.js` is not collected as a test (no `.test.js`
    suffix).
  - It modifies no Phase-1–5 file; `tests/_shim.js` and
    `tests/pipeline/_fixtures.js` are byte-unchanged.

---

## Wave 6.3: Per-machine validation tests

Every test file begins with two shared assertions (the registry/validity gate)
and then the machine-specific checks. All `require("./_fixtures.js")`. The two
shared opening assertions in each file:

- › `"config validates"` — `validate("<id>").ok === true`, with `errors` empty.
- › `"expands to Phase-2 sections with matching circuit count"` —
  `const { expanded } = build("<id>")`; `expanded.nCircuits ===
  byId["<id>"].config.circuits.length`; every
  `expanded.slices[*].section.features[*].kind ∈ {conductor,magnet,iron}`.

### Task 6.3.1: Validation tests — rows 1–7

- **Description**: One independent test file per fixture for matrix rows 1–7,
  driving only the agnostic pipeline via the loader helpers.
- **Files to create**:

  - `tests/machines/pmsm.test.js` — beyond the shared gate:
    - › `"registry is complete and index.html lists every fixture"` (loader
      coverage) — `MACHINE_IDS.length === 15`; for each id,
      `UnifiedMotor.MACHINES.some(m => m.id === id)`; `readIndexHtml()` contains
      `./machines/<id>.js` for all 15.
    - › `"self-starts under electronic-sine commutation"` **(A/structural)** —
      `runFromRest(build("pmsm").runtime, 400)`; assert
      `Math.abs(state.theta) > 1e-3`.
    - › `"PM flux-linkage fundamental dominates harmonics"` **(A)** — `stack` from
      `build("pmsm")`; `thetas` = 64 uniform samples over one electrical mech
      period `[0, 2π/(poles/2)) = [0, π)`; `lam = sweepLambdaPm(stack, thetas, 0)`;
      assert `dftAmp(lam, 1) ≥ 10·dftAmp(lam, 3)` and `dftAmp(lam,1) > 1e-6`.
    - › `"Maxwell agrees with co-energy within 5% at load"` **(B)** —
      `crossCheck(stack, 0.2, Float64Array([20,-10,-10])).ok === true`.

  - `tests/machines/brushed-dc-pm.test.js`:
    - › `"torque scales linearly with armature current"` **(A)** — `stack` from
      `build`; `t1 = stack.solve(0.2, Float64Array([10])).torque`,
      `t2 = stack.solve(0.2, Float64Array([20])).torque`; assert
      `assertClose(t2/t1, 2, 0.03·2)` (within 3%) and `Math.abs(t1) > 1e-5`.
    - › `"self-starts under mechanical commutation"` **(A/structural)** —
      `runFromRest(runtime, 400)`; `Math.abs(state.theta) > 1e-3`.
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(stack, 0.2, Float64Array([15])).ok`.

  - `tests/machines/brushed-dc-wound.test.js`:
    - › `"torque is bilinear in armature and field current"` **(A)** —
      `T(ia,if) = stack.solve(0.2, Float64Array([ia, if])).torque` with
      `ia=10, if=8`; assert `assertClose(T(2·ia,if)/T(ia,if), 2, 0.03·2)` and
      `assertClose(T(ia,2·if)/T(ia,if), 2, 0.03·2)`, with `Math.abs(T(ia,if)) > 1e-5`.
    - › `"self-starts under mechanical commutation"` **(A/structural)** —
      `runFromRest(runtime, 400)`; `Math.abs(state.theta) > 1e-3`.
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(stack, 0.2, Float64Array([10, 8])).ok`.

  - `tests/machines/universal.test.js`:
    - › `"mean torque over an AC cycle is unidirectional (series, ∝ i²)"` **(A)** —
      `stack` from `build`; for `ψ` = 48 uniform samples over `[0, 2π)`,
      `t(ψ) = stack.solve(0.2, Float64Array([12·cos ψ, 12·cos ψ])).torque`
      (series → identical current in both circuits); assert `mean(t) > 1e-5` and
      `Math.min(...t) ≥ −0.05·mean(t)` (torque stays one sign — does not reverse
      with supply polarity, the defining universal-motor property).
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(stack, 0.2, Float64Array([12, 12])).ok`.

  - `tests/machines/bldc.test.js`:
    - › `"self-starts under electronic-trap commutation"` **(A/structural)** —
      `runFromRest(runtime, 600)`; `Math.abs(state.theta) > 1e-3`.
    - › `"PM term dominates the co-energy decomposition"` **(A/structural)** —
      `c = stack.coenergyTorque(0.2, Float64Array([48,-24,-24]))`; assert
      `Math.abs(c.pm) > Math.abs(c.reluctance)` and `Math.abs(c.pm) > 1e-6`.
    - › `"PM back-EMF is non-zero under motion"` **(A/structural)** —
      `co = stack.extractCoeffs(0.2)`; assert at least one
      `co.dLambdaPmdth[k]` has `Math.abs(...) > 1e-6`.
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(stack, 0.2, Float64Array([48,-24,-24])).ok`.

  - `tests/machines/induction-3ph.test.js`:
    - › `"rotor cage carries induced current under slip"` **(A/structural)** —
      `runtime` from `build`; `runtime.reset()`; step 120× at `dt=1/240` with the
      rotor pinned at standstill (`runtime.state.omega = 0` re-pinned each step);
      assert `Math.max(|i[0]|,|i[1]|,|i[2]|) > 1e-4` (cage circuits are indices
      0–2).
    - › `"torque is ~zero at synchronous speed (tight)"` **(A)** —
      `omega_s = 2π·50/(poles/2)`; `Ts = avgTorqueAtSpeed(runtime, omega_s, 3, 50)`;
      `T0 = avgTorqueAtSpeed(runtime, 0, 3, 50)`; assert
      `Math.abs(Ts) ≤ 0.02·Math.abs(T0)` and `Math.abs(T0) > 1e-5`.
    - › `"slip torque sign drives the rotor toward synchronism"` **(A/structural)**
      — at a sub-synchronous speed `0.5·omega_s`,
      `Tslip = avgTorqueAtSpeed(runtime, 0.5·omega_s, 3, 50)`; assert
      `Math.sign(Tslip) === Math.sign(omega_s)` (motoring torque is positive
      below sync).
    - › `"Maxwell vs co-energy within 5%"` **(B)** — at a loaded angle:
      `crossCheck(stack, 0.4, Float64Array([0,0,0, 24,-12,-12])).ok` (cage zeroed,
      stator energized at θ=0.4 rad where torque exceeds 1e-5 — instantaneous loaded point).

  - `tests/machines/induction-1ph.test.js`:
    - › `"capacitor-shifted auxiliary gives starting torque; main winding alone does not"` **(A)** —
      in a single `test()` block: first, with the unmodified config (aux `phaseOffset:π/2`),
      compute `Tboth = avgTorqueAtSpeed(build("induction-1ph").runtime, 0, 3, 50)` and assert
      `Math.abs(Tboth) > 1e-5`; then clone the config, set the auxiliary circuit's
      `terminal.type = "OPEN"`, build a fresh runtime, compute
      `Tmain = avgTorqueAtSpeed(runtime, 0, 3, 50)`, and assert
      `Math.abs(Tmain) ≤ 0.05·Math.abs(Tboth)` (preserving the physically-meaningful
      relative bound).
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(stack, 0.4, Float64Array([0,0,0, 24, 24])).ok` (3 cage circuits zeroed,
      then main amp:24 and aux amp:24 energized; θ=0.4 rad where torque exceeds 1e-5).

- **Files to modify**: none.
- **Acceptance criteria**:
  - Seven test files created; each `require`s `./_fixtures.js` only.
  - Every assertion above holds at its stated tolerance; `npm test` runs all
    seven and exits 0.
  - Each file drives only `build`/`crossCheck`/`sweep*`/`runFromRest`/
    `avgTorqueAtSpeed` (the agnostic pipeline) — no machine-specific code path,
    no direct grid manipulation.

### Task 6.3.2: Validation tests — rows 8–13 + skew demo + pole-mismatch demo

- **Description**: One independent test file per fixture for rows 8–13 and the
  two demos.
- **Files to create**:

  - `tests/machines/vr-stepper.test.js`:
    - › `"self-inductance follows L₀+L₂cos2θ_e"` **(A)** — `stack` from
      `build`; `thetas` = 48 uniform samples over `[0, 2π/(poles/2)) = [0, π)`;
      `Ls = sweepInductance(stack, thetas, 0)` (phase 0);
      `fit = fitCos2(thetas, Ls)` (the Phase-1 `fitCos2`, fitting
      `L = fit.L0 + fit.L2·cos(2θ)` and returning `fit.r2`); assert `fit.r2 ≥ 0.99`
      and `Math.abs(fit.L2) > 1e-9` (real saliency).
    - › `"reluctance torque matches −i²L₂sin2θ_e away from alignment"` **(A)** —
      with phase 0 energized at `i=10` (others zero),
      for `θ ∈ {0.3, 0.8}` (rad) assert the relative error of
      `stack.coenergyTorque(θ, Float64Array([10,0,0])).reluctance` vs
      `−(10²)·fit.L2·Math.sin(2·θ)` is `< 0.10`.
    - › `"λ_pm is identically zero (no magnet, zero-not-skip)"` **(A)** —
      `co = stack.extractCoeffs(0.3)`; assert every `co.lambdaPm[k] === 0` and
      every `co.dLambdaPmdth[k] === 0`.
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(stack, 0.3, Float64Array([10,0,0])).ok`.

  - `tests/machines/switched-reluctance.test.js`:
    - › `"self-inductance follows L₀+L₂cos2θ_e"` **(A)** — as `vr-stepper`
      (`fit = fitCos2(thetas, Ls)`); assert `fit.r2 ≥ 0.99`,
      `Math.abs(fit.L2) > 1e-9`.
    - › `"λ_pm is identically zero"` **(A)** — as `vr-stepper`.
    - › `"reluctance torque is ∝ i² below the iron knee"` **(A)** — at fixed
      `θ=0.3`, `t1 = stack.solve(0.3, Float64Array([8,0,0])).torque`,
      `t2 = stack.solve(0.3, Float64Array([16,0,0])).torque`; assert
      `assertClose(t2/t1, 4, 0.05·4)` (reluctance torque ∝ i²; Live linear model
      holds below saturation) and `Math.abs(t1) > 1e-5`.
    - › `"self-starts under electronic-trap commutation"` **(A/structural)** —
      `runFromRest(runtime, 600)`; `Math.abs(state.theta) > 1e-3`.
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(stack, 0.3, Float64Array([12,0,0])).ok`.
    - > **(C) carve-out, not asserted here:** the saturated aligned-vs-unaligned
      torque differential is a Phase-9 acceptance; this file checks only the
      linear reluctance shape + ∝i² law below the knee.

  - `tests/machines/pm-stepper.test.js`:
    - › `"zero-current detent is present and periodic"` **(C — sign/periodicity
      only)** — `dts = sweepTorque(stack, Float64Array([0,0]), <128 samples over
      [0,2π)>)`; assert `ripple(dts) > 1e-6` (detent present) and
      `signChanges(dts) === 2·4` (one full sign cycle per magnet pole, `magnets=4`
      → 8 sign changes per mechanical revolution). **No magnitude tolerance.**
    - › `"holding torque pulls the rotor toward alignment when energized"`
      **(A/structural)** — clone the config, set `circuits[1].terminal.type = "OPEN"`
      (so only phase 0 is energized; phase 1 is explicitly open-circuited, making the
      energized-phase-0-only premise proven rather than assumed); build a fresh runtime
      from the cloned config; call `runFromRest(runtime, 400)`; assert the rotor
      `state.omega` magnitude has decayed (`Math.abs(state.omega) <` its peak) and
      `state.theta` is finite (it settled, not ran away).
    - › `"Maxwell vs co-energy within 5% at the energized point"` **(B)** —
      `crossCheck(stack, 0.2, Float64Array([24, 0])).ok`.

  - `tests/machines/hybrid-stepper.test.js`:
    - › `"the stack has two slices with a half-tooth offset"` **(structural)** —
      `expanded` from `build`; assert `expanded.slices.length === 2`,
      `assertClose(expanded.slices[1].offset, Math.PI/5, 1e-12)`, and
      `stack.nSlices === 2`.
    - › `"the shared axial PM flips sign between slices"` **(structural)** — locate
      the `magnet` features of `expanded.slices[0].section` and
      `expanded.slices[1].section` originating from ring 0; assert their `Mr`
      values are exact negatives.
    - › `"zero-current detent is present with finer periodicity than one slice"`
      **(C — sign/periodicity only)** — `dts2 = sweepTorque(twoSliceStack,
      Float64Array([0,0]), samples)`; build a one-slice variant (config with
      `stack.slices:1, sliceOffsets:[0]`, no flux source) and
      `dts1 = sweepTorque(oneSliceStack, …)`; assert `ripple(dts2) > 1e-6` and
      `signChanges(dts2) > signChanges(dts1)` (the half-tooth-offset second slice
      multiplies the detent periodicity). **No magnitude tolerance.**
    - › `"self-steps under the sequencer"` **(A/structural)** —
      `runtime.reset()`; record `θ₀`; `runtime.commandStep(1)`; step 200×; assert
      `Math.abs(runtime.state.theta − θ₀) > 1e-4` (the commanded step moved the
      rotor).
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(twoSliceStack, 0.1, Float64Array([24, 0])).ok`.

  - `tests/machines/synchronous-reluctance.test.js`:
    - › `"self-inductance follows L₀+L₂cos2θ_e"` **(A)** — `fit.r2 ≥ 0.99`,
      `Math.abs(fit.L2) > 1e-9`.
    - › `"λ_pm is identically zero"` **(A)**.
    - › `"self-starts under electronic-sine commutation"` **(A/structural)** —
      `runFromRest(runtime, 600)`; `Math.abs(state.theta) > 1e-3`.
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(stack, 0.3, Float64Array([24,-12,-12])).ok`.

  - `tests/machines/wound-field-synchronous.test.js`:
    - › `"does not self-start from rest on AC-none"` **(A)** —
      `runFromRest(runtime, 600)`; assert `Math.abs(state.theta) < 1e-3` (true
      synchronous machine: no starting torque under `none` commutation).
    - › `"develops synchronous torque whose sign follows the load angle"` **(A,
      semi-tight)** — at synchronous speed `omega_s = 2π·50/(poles/2)`, for each
      `δ ∈ {+0.3, 0, −0.3}`: call `build("wound-field-synchronous")` fresh to obtain
      a new runtime; the field circuit is index 0 (DC, already set); the stator
      circuits are indices 1, 2, 3 — set ABSOLUTE offsets
      `runtime.circuits[k+1].terminal.phaseOffset = -2*Math.PI*k/3 + δ` for k=0,1,2;
      then `T(δ) = avgTorqueAtSpeed(runtime, omega_s, 3, 50)`;
      assert `T(+0.3) > 0`, `T(−0.3) < 0`, and
      `Math.abs(T(0)) < Math.min(Math.abs(T(+0.3)), Math.abs(T(−0.3)))` (torque ∝ sin δ).
      (A fresh build per δ avoids `phaseOffset` mutations accumulating across runs.)
    - › `"Maxwell vs co-energy within 5%"` **(B)** — at a loaded `δ`:
      `crossCheck(stack, 0.2, Float64Array([12, 24,-12,-12])).ok` (field circuit
      index 0, then 3 stator).

  - `tests/machines/skew-demo.test.js`:
    - › `"skew reduces torque ripple versus an unskewed stack"` **(A, inequality)**
      — `skewStack` from `build("skew-demo")`; build an `unskewStack` from a clone
      with `stack.sliceOffsets:[0,0,0,0]`; `cur = Float64Array([24,-12,-12])`;
      `thetas` = 64 samples over `[0, 2π/(poles/2))`;
      `rSkew = ripple(sweepTorque(skewStack, cur, thetas))`,
      `rFlat = ripple(sweepTorque(unskewStack, cur, thetas))`; assert
      `rSkew ≤ 0.8·rFlat` and `rFlat > 1e-6`.
    - › `"skew preserves mean torque within 5%"` **(A)** —
      `assertClose(mean(sweepTorque(skewStack, cur, thetas)),
      mean(sweepTorque(unskewStack, cur, thetas)), 0.05·Math.abs(mean(unskewed)) + 1e-6)`.
    - › `"Maxwell vs co-energy within 5%"` **(B)** —
      `crossCheck(skewStack, 0.2, cur).ok`.

  - `tests/machines/pole-mismatch-demo.test.js`:
    - › `"net torque over a mechanical revolution is ~zero"` **(A)** — `stack` from
      `build`; `cur = Float64Array([24,-12,-12])`; `ts = sweepTorque(stack, cur,
      <96 samples over [0,2π)>)`; assert
      `Math.abs(mean(ts)) ≤ 0.05·(ripple(ts)/2)` (no shared working harmonic → no
      average torque).
    - › `"instantaneous torque ripple is non-zero"` **(A)** —
      `ripple(ts) > 1e-6` (the fields still interact instantaneously).
    - › `"Maxwell vs co-energy within 5% at a loaded angle"` **(B)** — pick the
      `θ*` in the sweep maximizing `|torque|`; `crossCheck(stack, θ*, cur).ok`.

- **Files to modify**: none.
- **Acceptance criteria**:
  - Eight test files created; each `require`s `./_fixtures.js` only.
  - Every assertion above holds at its stated tolerance; `npm test` runs all
    eight and exits 0.
  - The SRM file asserts the linear reluctance shape + ∝i² law and explicitly
    leaves the saturated differential to Phase 9 (class C carve-out documented in
    the file); the PM-stepper and hybrid files assert detent **presence /
    periodicity only** (class C), never detent magnitude.
  - Each file drives only the agnostic pipeline helpers.

---

## Phase acceptance (rolls up to the manifest verification)

- `npm test` exits 0 with all 15 `tests/machines/*.test.js` files plus the
  existing engine / winding / excitation / circuit / pipeline suites.
- All 15 fixtures register on `UnifiedMotor.MACHINES`, every one passes
  `ConfigSchema.validate`, and `index.html` lists all 15 script tags inside the
  marked region.
- Each fixture passes its independent, agnostic-pipeline-only validation: the
  analytic-tight checks at their stated tolerances (reluctance `cos2θ` fit
  `r² ≥ 0.99`; torque/current ratios within 3%; zero-net-torque and
  zero-at-synchronous at their bounds), the universal Maxwell-vs-co-energy ≤ 5%
  cross-check, and — for detent amplitude and the SRM saturated differential —
  presence/sign/periodicity only, with magnitude deferred to Phases 8/9.
- No fixture or test introduces a machine-name reference into `lib/` or
  `mount.js`; machine names appear only as `id`/`label` data in `machines/*.js`
  and as ids/strings in `tests/machines/`.
