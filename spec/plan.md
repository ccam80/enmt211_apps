# Unified electric-motor app — engine→app integration finishing plan

## Why this plan exists

The FEA engine rebuild (old `spec/plan.md`, Phases 0–8) is **delivered and
correct**: the full test suite is **330 pass / 0 fail / 0 skip**. During that
build the engine diverged substantially from the old plan's architecture — and
the old plan, its per-phase specs, and the progress log are now removed because
they describe contracts that no longer exist. The relevant divergences:

| Old plan assumed | Engine as it actually is now |
|---|---|
| Analytic **harmonic** air-gap (`airgap-harmonic.js`, `gap.harmonics`, φ-phase) | **Deleted.** `lib/airgap-mortar.js` is the sole gap engine (zipper mortar coupling); no harmonics. |
| **Staggered** circuit coupling + `extractCoeffs` (L, dL/dθ, λpm) + co-energy torque | **Deleted.** Monolithic `stack.solveCoupled` (field-circuit-motion Newton, Schur-condensed); Arkkio is the sole torque; `linearFluxLinkages` replaced `extractCoeffs`. |
| `field` return `{rotor,stator,gap:{harmonics,phi}}` | `stack.fieldBundle(A,θ)` → `{torque, fluxLinkages, perSliceField[], iters}`; `perSliceField[k]` carries per-body `Anode`/`Belem` + `gap.phi`. |
| (absent) | **Axial-flux coupling** — `stack.axial` flux-loop netlist for hybrid/claw-pole (2.5-D), see `spec/feature-axial-flux-coupling.md`. |
| `motor-run.step(dt)` staggered | `runtime.step(dt, wallBudgetMs?)`, `lastSolve`, `commandStep`, `breakpoint`, `clearFieldCache`. |

**The engine is not wired into the live app.** `lessons/unified_motor/index.html`
loads `motor-stack.js`/`motor-run.js` but not the FEA libraries they depend on
(`fea-solver.js`, `motor-mesh.js`, `motor-mesh-view.js`, `airgap-mortar.js`,
`motor-slice.js`, `bdf-integrator.js`), nor the render/UI files, and nothing ever
awaits `LIB.FeaSolver.init()`. As wired, the app would crash on mount. `mount.js`
is substantially built (wall-budgeted `runtime.step` loop, render seams,
`fieldViz` toggles, playback slider, slow-mo badge) but still references a dead
`solved` variable in its readout block.

This plan finishes the **engine→app integration**: boot + wire the engine, build
a **geometry-faithful 2-D cross-section render** (the current material-colored
radial-block render is not the desired output — real teeth/slots, concentrated
vs distributed windings, conductors, magnets), an in-gap field reconstruction, a
3-D rig, and the live editing UI (machine picker, geometry/material editing, and
axial-flux netlist editing gated on slice count). It ends with the user-required
browser verification + a legacy/agnosticism audit.

## Current engine contracts (binding — do not re-derive)

- **Boot:** `LIB.FeaSolver.init()` returns a Promise that MUST resolve before any
  `MotorStack`/`MotorSlice` construction (the slice throws otherwise). Loaded via a
  classic `<script>` that dynamically `import()`s `solver.mjs` with a non-streaming
  `WebAssembly.instantiate(buffer)` (Moodle/static-host safe; no Web-Worker).
- **`UM.ConfigSchema.expand(config)` → `expanded`.**
- **`LIB.MotorStack.create(expanded, opts)`** → `{ nCircuits, nSlices, expanded,
  slices[], solve(θ,currents), solveCoupled(...), fieldBundle(A,θ) →
  {torque, fluxLinkages, perSliceField[], iters}, linearFluxLinkages(θ,currents),
  sliceMesh(k) → {rotor:BodyMesh, stator:BodyMesh}, clearWarmStart() }`.
- **`perSliceField[k]`** carries, per body (`rotor`/`stator`), `Anode` (nodal vector
  potential) and `Belem` (`{mag,Bx,By}` per element), plus `gap.phi` (the rotor
  body-frame angle to draw the rotor rotated by). Exact field names verified in
  plan-spec against `lib/motor-stack.js` `fieldBundle`.
- **`LIB.MotorRun.create(expanded)`** → `{ stack, state{theta,omega,t,i,stepIndex},
  circuits, mechanical, get lastSolve, step(dt, wallBudgetMs?), commandStep,
  breakpoint(), reset(), clearFieldCache() }`. `lastSolve` is the latest
  `fieldBundle`.
- **Axial flux:** `config.stack.axial = { branches:{…}, loops:[…] }` (signed
  flux-loop netlist); absent ⇒ `Ψ_s ≡ 0` ⇒ today's behavior bit-identical. Reached
  only when `stack.slices > 1`. See `spec/feature-axial-flux-coupling.md`.
- **Mount seams (`lessons/unified_motor/mount.js`):** `registerPanel`,
  `registerTool`, `registerHeaderControl`, `registerRender3D`,
  `registerCrossSection2D`; shared overlay state `UM.fieldViz` (`fluxLines`,
  `modulusB`, `saturation`, `magnetization`, `currentDensity`, `gapLoop`); panels
  receive `ctx = { runtime, config, view, requestRebuild() }`.

## Goals

- The unified-motor app **runs on the FEA engine in the browser**: `index.html`
  loads the engine + render/UI libraries in dependency order and boots through
  `LIB.FeaSolver.init()`; the default machine steps and the rotor visibly turns.
- A **geometry-faithful 2-D cross-section render**: real tooth/slot profiles (not
  radial blocks), **concentrated vs distributed windings** drawn as real coil
  glyphs with per-phase color + go/return polarity (read from the winding
  routing), in-slot conductor cross-sections, magnet segments with N/S +
  magnetization arrows, all driven by the `BodyMesh` + config winding routing.
- A **smooth in-gap field reconstruction** (decision 1b): reuse the polar-Laplace
  gap reconstruction `airgap-mortar.torque()` already performs, exposed as a
  render-callable helper, so flux lines bridge rotor↔stator across the unmeshed gap.
- Field overlays layered on the sprite geometry — flux lines (incl. cross-gap),
  |B|, saturation, magnetization, current density — each an independent `fieldViz`
  toggle; rotor drawn rotated by `perSliceField[k].gap.phi`.
- A **3-D rig** (`render3d.js`): axial extrusion of the 2-D cross-section,
  end-windings, per-slice in-gap field, rotor rigidly rotated; multi-slice stacks
  (axial machines) show each cup.
- The **live editing UI**: a **machine picker** (load any of the 15 fixtures into a
  fully editable config), **geometry sliders** (radii, gap length, integer
  teeth/magnets/Q), a per-ring **material card** (`muR`, `Mr`, `Bknee`), and a
  **slice + axial-flux editor** — an "add slice" control that, once slices > 1,
  exposes the `stack.axial` flux-loop netlist (branch reluctances/PM MMF + signed
  loop incidence). Every edit drives `requestRebuild()`.
- **User-verified in the browser** (CLAUDE.md checklist) and a clean
  legacy/agnosticism audit.

## Non-Goals

- **No engine physics changes.** The engine is correct (330/330). This plan does
  not re-open the solver, mesher, mortar gap, coupled Newton, or axial-flux math.
  If integration surfaces a genuine engine defect, it is escalated, not patched
  around (per the project's first-principles rule).
- **No resurrection of deleted subsystems** — harmonic gap, `extractCoeffs`,
  co-energy / dL-dθ torque, the polar grid engine, `drawGapField`, `MotorCompile`.
  References to them are stale and are removed.
- **No new physics tier / no GPU / no Web-Worker** unless a measured budget demands
  it (carried from the original brief; the wall-budgeted `runtime.step` is the
  interactivity mechanism).
- **No changes to `lib/em-physics.js` or other lessons.** `em-physics.js` stays
  loaded for the unrelated lessons that use it; the unified app's physics is the FEA
  engine.
- **No machine-specific code paths** in `lib/` or the runtime UI. The picker is a
  preset loader; machine identity never reaches a render or physics code path.

## Machine-Agnosticism Invariants (carried, binding on the new UI/render files)

1. **Legitimate dispatch axes only.** Code may switch on the universal vocabulary —
   element kind `{W,C,M,I,K}`, terminal state, commutation, source scope, and the
   **presence** of `stack.axial` / `stack.slices > 1`. Never on a machine name or
   machine-type enum.
2. **Zero-not-skip.** Absent physics contributes zero (no magnet ⇒ no magnet glyph;
   no axial block ⇒ `Ψ_s = 0`); never branched around.
3. **The render/UI see only config + mesh + field.** The picker deep-copies a
   fixture's config and is otherwise a generic editor over `rings/circuits/stack/
   mechanical/poles`; no behavioral code reads a human label.
4. **W vs C is routing.** Concentrated vs distributed coil glyphs are drawn from the
   per-slot ampere-conductor routing, not a "concentrated machine" branch.

## Verification

- **Phase 0 (stale-reference + dead-path removal):** repo-wide search finds **zero**
  references to deleted subsystems (`airgap-harmonic`, `harmonic-set`,
  `extractCoeffs`, `coenergyTorque`, `evaluateAt`, `drawGapField`, `MotorCompile`,
  `detailed-toggle`, polar-grid `airgap-grid/solve/torque/refine/worker`); the dead
  `solved` path is gone; the test suite still runs (engine green, no new red).
- **Phase 1 (wiring + boot):** the app boots in the browser with no console errors;
  `LIB.FeaSolver.init()` is awaited before `runTabs`; the default machine steps
  (`runtime.lastSolve` finite, rotor turns); readouts/flux read the `fieldBundle`
  shape; `requestRebuild()` re-expands (incl. `stack.axial`).
- **Phase 2 (in-gap field):** the gap-eval helper reproduces the body gap-loop
  boundary `A` values on each surface to tight tolerance and yields a smooth,
  monotone-where-expected cross-gap field; headless test against the two body
  gap-loops at several φ.
- **Phase 3 (2-D asset render):** headless tests confirm the render emits faithful
  tooth/slot/magnet/conductor geometry (element/feature coverage, no radial-block
  fallback) and routing-correct winding glyphs (per-phase color + go/return
  polarity from the routing); field overlays gate independently on `fieldViz`;
  rotor rotates by `gap.phi`. Browser visual pass folded into Phase 6.
- **Phase 4 (live UI):** the picker loads each of the 15 fixtures into an editable
  config; geometry/material/gap edits mutate `ctx.config` and rebuild; the "add
  slice" control raises `stack.slices` and, at slices > 1, the axial-flux netlist
  editor produces a valid `stack.axial` that `expand`/`validate` accepts; absent
  axial ⇒ bit-identical reduction. Registers only through mount seams (no
  `mount.js` edit in this phase).
- **Phase 5 (3-D rig):** the rig extrudes the cross-section, draws end-windings and
  per-slice in-gap field, rotates the rotor by `gap.phi`, and shows each cup of a
  multi-slice axial machine; registered via `registerRender3D`.
- **Phase 6 (verification + audit):** the new `scripts/agnosticism-audit.js`
  exits 0 — its three static checks (machine-name/id, single-slice fast path,
  legacy-term sweep) over the engine + new render/UI files are clean; the
  **user-required browser pass** over the CLAUDE.md checklist passes; full test
  suite green.

## Dependency Graph

```
Phase 0 (stale-reference + dead-path removal)            ── runs first, alone
   │
   ├──→ Phase 1 (engine wiring + boot:                   ── parallel after 0 ──┐
   │            index.html)                                                    │
   └──→ Phase 2 (in-gap field helper:                    ── parallel after 0   │
                airgap-mortar.js / gap-eval.js)                                │
                         │                                                     │
        ┌────────────────┴───────────────────┐                               │
        ▼                                      ▼                               │
   Phase 3 (2-D asset render:            Phase 4 (live UI: machine-picker  ── parallel
   cross-section-render.js,              + geometry/material/axial panel)     after 1
   motor-mesh-view.js) — needs 1 + 2     — needs 1                            │
        │                                                                      │
        ▼ (3-D reuses sprite primitives + gap-eval)                           │
   Phase 5 (3-D rig: render3d.js) — after 3 + 2                               │
        │                                                                      │
        ▼                                                                      │
   Phase 6 (browser verification + legacy/agnosticism audit) ── runs last ────┘
```

Phases are numbered in execution order. Phases 1 and 2 depend only on Phase 0 and
run in parallel; Phases 3 and 4 both unlock after Phase 1 (Phase 3 also needs
Phase 2) and run in parallel; Phase 5 follows Phase 3. Each `lib/`, render, and UI
file is owned by exactly one feature phase (Phase 0 and Phase 6 are the
themed-by-purpose exceptions).

---

## Phase 0: Stale-reference + dead-path removal
**Depends on**: (none — runs first)

Remove every lingering reference to the deleted engine subsystems and the one dead
runtime path, so spec/implementation agents in later phases never see legacy
contracts. The engine is green; this is a reference-hygiene pass, not a physics
change. It may delete dead comments/branches and is the only phase exempt from
file-locality (it spans wherever stale references live).

### Wave 0.1: Remove stale references and dead paths

Discovery (run during plan-spec) found the live-code stale-reference surface is
narrow and fully enumerable, while the bulk of deleted-subsystem references live
in obsolete `spec/` artifacts from the delivered FEA-rebuild. The work splits
into two independent, parallel task_groups (see
`spec/phase-0-stale-reference-dead-path-removal.md` for the enumerated edits).

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Fix the five live-code stale-reference sites: source `mount.js`'s readout `solved` variable from `runtime.lastSolve` (this re-sources the live readouts **in Phase 0**, replacing the dead undeclared-variable read — Phase 1 need not re-do it); delete the orphan `winding-editor.js` (unwired; calls the deleted polar-grid cross-section API); reword three stale comments naming deleted subsystems (`motor-compile` in `winding-model.js`; `coenergyTorque` + a banned historical-provenance line in `motor-circuit.js`; `MotorCompile.compile` in `motor-stack.test.js`); refresh `spec/test-baseline.md` to the current 330/330/0 baseline. The two guard tests that assert deleted symbols are absent are kept. | M | `lessons/unified_motor/mount.js`, `lib/winding-model.js`, `lib/motor-circuit.js`, `tests/pipeline/motor-stack.test.js`, `spec/test-baseline.md`, `lessons/unified_motor/winding-editor.js` (delete) |
| 0.1.2 | Scripted, enumerated deletion of 21 obsolete delivered-rebuild `spec/` artifacts (old plan `fea-engine-rebuild.md`; the nine `reviews/spec-phase-*.md` + `reviews/spec-review-combined.md`; dated investigation/sprint/audit logs; the superseded `pi-measure-derivation.md`/`feature-brush-commutator.md`/`adaptive-stepper-design.md`/`profile-coupled.js`; and old job-control `.hybrid-state.json` + `.context/review-spec.md`/`T4.1.1-recovery-notes.md`). Keeps live infra (`.context/rules.md`, `.context/lock-protocol.md`), the binding `feature-axial-flux-coupling.md`, `plan.md`, `manifest.json`, and the refreshed `test-baseline.md`. Dry-run before deleting; confirm the suite stays green. | S | (spec-only) the 21 enumerated `spec/*` files |

---

## Phase 1: Engine wiring + boot
**Depends on**: Phase 0
**Parallel with**: Phase 2

Make the live app run on the FEA engine. Owns the sole wiring file, `index.html`
(`mount.js`'s readout re-sourcing is Phase 0's; everything else in `mount.js` is
already wired against the current engine contract). Single wave.

### Wave 1.1: index.html script load + solver boot
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.1.1 | Add the FEA + render/UI `<script>` tags to `index.html` in dependency order (`fea-solver.js`, `motor-mesh.js`, `motor-mesh-view.js`, `airgap-mortar.js`, `gap-eval.js`, `bdf-integrator.js`, `motor-slice.js` **before** the already-present `motor-stack.js`/`motor-run.js`; then `cross-section-render.js`, `render3d.js`, `machine-picker.js`, and the geometry/material panel after `mount.js`, before the machine fixtures). Replace the bare `runTabs(...)` call with a boot that awaits `LIB.FeaSolver.init()` then mounts. Ship a headless boot+step test (`tests/unified_motor/app-boot.test.js`) proving the default machine steps and the rotor advances, plus an `index.html` structure test. (The render/UI + gap-eval files land in Phases 2–5; their tags are added here as the sole owner of `index.html` so later phases never edit it — see **Phase 1 stub-seeding exception** below. Plan-spec confirms tag set + order.) | M | `lessons/unified_motor/index.html`, stub `lib/gap-eval.js`/`render3d.js`/`machine-picker.js`/`geometry-panel.js`, `tests/unified_motor/{index-wiring,app-boot}.test.js` |

> **Phase 1 stub-seeding exception.** A `<script src>` to a file that does not exist
> is a 404/file-not-found console error in the browser, not a no-op — which would
> violate Phase 1's "boots with no console errors" check. Of the tags Phase 1 adds,
> `cross-section-render.js` already exists; `lib/gap-eval.js` (Phase 2), `render3d.js`
> (Phase 5), and `machine-picker.js` + `geometry-panel.js` (Phase 4) do not. Phase 1
> therefore **creates those four as empty no-op stub files** (comment-only, no
> statements) so every tag loads cleanly, and Phases 2/4/5 replace the stub *contents*.
> Phase 1 owns the empty file + the tag; the later phase owns the behavior. These four
> files thus appear in both Phase 1's and Phase 2/4/5's "Files Owned" by design — the
> same sanctioned ownership split the Phase-0 file-locality exemption already uses for
> `mount.js`.

---

## Phase 2: In-gap field reconstruction helper
**Depends on**: Phase 0
**Parallel with**: Phase 1

Expose the polar-Laplace gap-field reconstruction that `airgap-mortar.torque()`
already computes (decision 1b) as a render-callable helper, so the 2-D and 3-D
renders can draw smooth flux lines / field across the unmeshed gap from the two
body gap-loops + `perSliceField`. Pure helper; no engine physics change.

### Wave 2.1: gap-field evaluation helper + test
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.1.1 | Create a standalone `LIB.GapEval` in a new `lib/gap-eval.js` — `evalAOnGrid(gapInput, {Nr,Ntheta})` solving the polar-Laplace field in the annulus from the rotor/stator gap-ring boundary values (the same BVP `torque()` uses, re-derived at the render grid via `LIB.FeaSolver`), returning `{rs,thetas,Az,Br,Bth,Bmag}`. Input is an explicit descriptor `{rotor:{gapR,gapTheta,A}, stator:{gapR,gapTheta,A}, phi}` decoupled from the engine field shape (Phase 3/5 build it from `perSliceField[k]` via `mesh.gapLoop`). `airgap-mortar.js` is NOT touched. Headless test: analytic-harmonic round-trip across the gap at several k/φ; boundary rows reproduce the prescribed ring `A`; smooth/finite/monotone; gap `B` from the harmonic; DOM-free; agnostic. | M | `lib/gap-eval.js` (new), `tests/airgap/gap-eval.test.js` |

---

## Phase 3: Geometry-faithful 2-D asset render
**Depends on**: Phase 1, Phase 2

A **ground-up engineering sprite cross-section** — real outlined tooth / tooth-tip
/ slot-opening profiles, magnet segments with N/S + magnetization arrows, and
**individual wound conductor cross-sections drawn as discrete wires in every slot**
(never a filled rectangle). Geometry is driven by `section.features` + `config.rings`
(dispatch on `feature.kind` / `ring.element` only); the FE mesh feeds only the
physics overlays. The prior `motor-mesh-view.js` material-fill surface and its
element-count tests are discarded — they encoded a design the author did not set.
Flux lines are smooth/interpolated (resampled off the mesh), |B| is a blended
heatmap, saturation stays per-element. Sprite primitives live in a new
`lib/cross-section-sprite.js` (reused by Phase 5's 3-D rig); `motor-mesh-view.js`
is gutted to overlays-only; `cross-section-render.js` orchestrates and fixes the
stale `LIB.GapEval` call to the Phase-2 `{rotor,stator,phi}` descriptor. Owns a
sanctioned two-tag `index.html` addition (`cross-section-sprite.js` + the
Phase-2-omitted `gap-eval.js`).

### Wave 3.1: Sprite primitives + field overlays (two file-disjoint groups, parallel)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | New `lib/cross-section-sprite.js` (`LIB.CrossSectionSprite`): passive-geometry primitives — `drawIron` (outlined annular-sector teeth with a gap-side tooth-tip shoulder; full-annulus iron → plain ring), `drawMagnet` (N/S-shaded segments by `Mr` sign), `drawMagnetArrows`, `drawShaftAndGap`. Pure, DOM-free, dispatch on `feature.kind` only. | M | `lib/cross-section-sprite.js` (new) |
| 3.1.2 | In `cross-section-sprite.js`, `drawWinding(ctx, conductorFeatures, mode, opts)`: **individual wires** per slot — distributed = up to `N_dist=8` discrete wire cross-sections; concentrated = an end-on wrapped bundle of up to `N_conc=10` wires widening where turns accumulate. Per-phase color by `circuit`; ⊙/⊗ polarity from `sign(turns)` (× live current when `currentDensity` on). Mode tag supplied by the orchestrator from the owning ring's `element` (C vs W/K). | L | `lib/cross-section-sprite.js` |
| 3.1.3 | Gut `lib/motor-mesh-view.js` to overlays-only: delete the material/geometry code; add `resampleField` (polar resample off the mesh) + grid-based **smooth** `drawFluxLines` (Catmull-Rom contours) + **blended** `drawModulusB`; keep per-element `drawSaturation`, `viridis`, `drawGapLoop`. | L | `lib/motor-mesh-view.js` |

### Wave 3.2: cross-section-render orchestration + cross-gap flux + index.html
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.2.1 | Rewrite `cross-section-render.js` to drive the sprite primitives per slice (rotor rotated by `perSliceField[k].gap.phi`, fallback `state.theta`) + the five field overlays gated on `UM.fieldViz`, recomputing resampled grids only when `runtime.lastSolve` changes; build the Phase-2 `{rotor,stator,phi}` gap descriptor from `gapLoop`+`Anode` and call `LIB.GapEval.evalAOnGrid(descriptor,{Nr,Ntheta})` for smooth cross-gap flux (removing the stale `field.gap` call); keep the `registerCrossSection2D`/header seams. Add the `cross-section-sprite.js` + `gap-eval.js` `<script>` tags to `index.html` (sanctioned overlap with Phase 1). | L | `lessons/unified_motor/cross-section-render.js`, `lessons/unified_motor/index.html` |

---

## Phase 4: Live editing UI — picker + geometry/material/axial
**Depends on**: Phase 1
**Parallel with**: Phase 3

Wire the live controls. All register through the existing mount seams
(`registerHeaderControl`/`registerPanel`) and mutate `ctx.config` in place then
call `ctx.requestRebuild()`; **no `mount.js` edit** (Phase 1 owns it).

### Wave 4.1: Machine picker
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.1.1 | `machine-picker.js`: a header control listing the 15 `UnifiedMotor.MACHINES` fixtures; selecting one deep-copies the fixture's **entire** config (all keys incl. `grid`/`gapBand` — `grid` is required by `expand`/`validate`) and replaces the contents of `ctx.config` **in place** (object identity preserved so `mount.js`'s closure-captured `config` is the one re-expanded), with `config.label` falling back to the `MACHINES` entry label, then calls `ctx.requestRebuild()` — preset-loader semantics, no machine identity stored. | M | `lessons/unified_motor/machine-picker.js`, `tests/unified_motor/machine-picker.test.js` |

### Wave 4.2: Geometry + material + slice/axial editor
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.2.1 | A per-ring editor panel: **Geometry** (`rRange[0]/rRange[1]`, integer `teeth`/`magnets`/`Q`) and **Material** (`muR`, `Mr` on `M` rings, `Bknee` on iron-bearing rings); a global **gap-length `g`** slider (pure `applyGapLength(config,g)` shifting rotor surface + stator bore symmetrically about the mid-gap); a **slice control** with **"+ add slice"** that raises `stack.slices` and sets `sliceOffsets`. When `stack.slices > 1`, reveal the **axial-flux netlist editor**: branch entries (PM `Br`/`length`/`area`/`muR`, core/yoke `reluctance`) + signed flux-loop incidence, emitted as `stack.axial` (validated by `config-schema`; absent ⇒ no axial coupling). All edits mutate `ctx.config` + `requestRebuild()`. | L | `lessons/unified_motor/geometry-panel.js` (new) |

---

## Phase 5: 3-D rig
**Depends on**: Phase 3 (sprite primitives), Phase 2 (gap-eval)

The 3-D viewport is **orbit-pannable** (no privileged front/back): both axial end
caps of the stack are drawable faces, so both caps get full sprite detail and all
faces/walls composite back-to-front (painter's algorithm via `LIB.Layout3D.depthSort`).

### Wave 5.1: render3d.js
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | `render3d.js`: axial extrusion of the 2-D sprite cross-section via an **affine-per-face** transform that reuses the Phase-3 `LIB.CrossSectionSprite` primitives on **both** end caps of **every** slice (+ rig-drawn side-wall quads); end-winding arcs (go→return, grouped by `circuit`) bulging axially beyond **both** outer stack ends; per-slice in-gap field paint on the caps (smooth per-body flux + cross-gap flux via `LIB.GapEval`, blended `\|B\|`), each gated on `UM.fieldViz`; rotor sprite rotated rigidly by `perSliceField[k].gap.phi` (which already includes `offset[k]` — fallback `state.theta + offset[k]` pre-solve), stator fixed; **multi-slice stacks render each slice/cup** so an axial machine's cups are visible. Registered through `UM.registerRender3D`; reuses the Phase-3 sprite primitives; agnostic. Also applies a **sanctioned single-line `mount.js` overlap edit** adding `canvas: viewport3D` to the 3-D-seam `rctx` (the seam otherwise passes no drawing surface — see below). | L | `lessons/unified_motor/render3d.js`, `lessons/unified_motor/mount.js` (sanctioned overlap), `tests/render/render3d.test.js` |

> **Phase 5 mount-seam exception.** The `mount.js` 3-D render loop calls
> `UM.RENDER3D.paint(mountCtx, L3, rctx)` but passes the renderer no canvas/context
> (unlike the 2-D seam, which passes the canvases array). Phase 5 fixes this with a
> single-line edit to the `rctx` literal (`canvas: viewport3D`) and reads
> `rctx.canvas` in `render3d.js`. `mount.js` therefore appears in both Phase 0's
> (readout re-sourcing) and Phase 5's "Files Owned" by design — the same sanctioned
> cross-phase overlap mechanism used for `index.html` (Phase 1↔3) and the stub files
> (Phase 1↔2/4/5). The two `mount.js` edits touch disjoint lines.

---

## Phase 6: Browser verification + legacy/agnosticism audit
**Depends on**: all previous phases

The repo-wide machine-agnosticism backstop is, today, a *test*
(`tests/pipeline/agnostic-pipeline.test.js`) that scans `lib/` + `mount.js` only;
there is **no** `scripts/agnosticism-audit.js` (the references to it in Phases 3/4/5
and the manifest were authored against an assumed artifact). Phase 6 **creates** that
script — a standalone, DOM-free Node hygiene gate (`node scripts/agnosticism-audit.js`,
exit 0 clean / 1 on violation) running three static checks over the engine + the
new render/UI files — and performs the user-required browser pass. The behavioral
`agnostic-pipeline.test.js` (identical-`MotorRun`-path / rotor-turns) is unchanged
and remains the behavioral half of the single-slice guarantee.

The wave splits into two file-disjoint task_groups: the agent-runnable audit
(`T6.1.1`) and the user-required browser verification (`T6.1.2`).

### Wave 6.1: Repo audit (agent) + user browser pass
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | **Repo hygiene gate (agent — not user-required).** Create `scripts/agnosticism-audit.js` exporting `{ scanForNames, scanForSingleSlice, scanForLegacyTerms, run }` and self-executing `run()`+`process.exit` only when `require.main === module`. Three checks: **(1) machine-name/id** — engine (`lib/*.js` minus the carve-out set `{app.js, registry.js, header-buttons.js, stepper-drive.js, three-phase.js}`) + runtime-UI (`mount.js`, `cross-section-render.js`, `render3d.js`, `machine-picker.js`, `geometry-panel.js`) contain none of the 8 `MACHINE_NAMES` type tokens (substring, case-insensitive) and no quoted machine-**id** literal (15 ids); **(2) single-slice fast path** — same scan set, comments stripped, zero matches of `slices/nSlices === 1` or `slices < 2`; **(3) legacy-term sweep** — `lib/**`, `lessons/**`, `tests/**`, `scripts/**`, `index.html` contain zero deleted-subsystem terms (`airgap-harmonic`, `harmonic-set`/`harmonicSet`, `extractCoeffs`, `coenergyTorque`, `evaluateAt`, `drawGapField`, `MotorCompile`/`compileForOverlay`/`drawCompiledOverlay`, `detailed-toggle`, `airgap-grid`) outside the enumerated carve-out paths (`lib/em-physics.js`, `lessons/ac_motor/**`, `tests/render/mount-2d-seam.test.js`, the audit script + its test, `spec/**`). Add `tests/pipeline/agnosticism-audit.test.js` (unit-tests the three scan fns on synthetic inputs + spawns the script and asserts exit 0) and an `"audit"` npm script. Full `node --test` green. | M | `scripts/agnosticism-audit.js` (new), `tests/pipeline/agnosticism-audit.test.js` (new), `package.json` |
| 6.1.2 | **User-required browser pass** (CLAUDE.md checklist), recorded in `spec/phase-6-browser-verification.md`: app boots with no console errors; picker loads each of the 15 fixtures into an editable config; geometry/material/gap edits rebuild; "+ add slice" reveals the axial-flux netlist editor and a hybrid/claw-pole config builds and runs; rotor turns; each `fieldViz` toggle paints; smooth cross-gap flux lines bridge rotor↔stator; 3-D rig extrudes + rotates + shows cups; Playback slider + slow-mo badge behave; Reset works. The user runs the checklist in a browser and signs off each item; the agent records pass/fail + notes. | M | `spec/phase-6-browser-verification.md` (new) |

---

## Open items deferred to plan-spec

- **gap-eval home (Phase 2): RESOLVED — new `lib/gap-eval.js`.** The render holds
  no mortar-engine handle and the render grid (`Nr≈8`,`Ntheta≈96`) differs from the
  mortar's torque grid (`Nu`,`L_SUB=8`), so the factored `recSolver` is not reusable;
  `gap-eval.js` re-derives the generic polar-Laplace BVP at the render grid and
  duplicates no mortar coupling internals. Signature: `evalAOnGrid({rotor,stator,phi},
  {Nr,Ntheta}) → {rs,thetas,Az,Br,Bth,Bmag}`. Phase 1 must add `lib/gap-eval.js` to
  the `index.html` load order after `fea-solver.js`; Phase 3/5 build the descriptor
  from `perSliceField[k]` and call `evalAOnGrid(descriptor, …)` (the draft render's
  stale `evalAOnGrid(field.gap, …)` call is rewritten in Phase 3 — landing
  `gap-eval.js` before then turns the `tests/render` flux-line path red transiently,
  which is accepted). Phase 6 audit allow-list adds `gap-eval.js`.
- **geometry/material panel home (Phase 4): RESOLVED — new `geometry-panel.js`.**
  `matrix-panel.js` is a from-scratch config *synthesizer* (toggle-vocabulary →
  config via `synthesize`); `schematic-panel.js` is a circuit/switch/capacitor
  editor. Continuous geometry/material editing over an already-loaded config is a
  distinct concern, so it lands in the new `geometry-panel.js`, not by overloading
  either existing panel.
- **Exact `perSliceField` field names (Phases 3/5):** confirm `Anode`/`Belem`/
  `gap.phi` spellings against `lib/motor-stack.js` `fieldBundle` before the render
  consumes them.
- **Axial-netlist UI affordance (Phase 4): RESOLVED.** The editor is revealed only
  at `stack.slices > 1` and is pre-filled with the hybrid L=1 two-cup default
  (`{branches:{pm:{Br:1.2,length:0.00628}}, loops:[{slices:[{s:0,sign:+1},
  {s:1,sign:-1}], branches:["pm"], Raxial:0, Fpm:0}]}`), generalizable to a signed
  N-slice / L-loop netlist. Controls map 1:1 to the `config-schema.js` `stack.axial`
  shape (per-branch `Br`/`length`/`area`/`muR` or raw `reluctance`/`mmf`; per-loop
  signed incidence + branch selection + `Raxial`/`Fpm`). "+ add slice" is capped at
  4; dropping to 1 slice deletes `stack.axial` (bit-identical reduction).
