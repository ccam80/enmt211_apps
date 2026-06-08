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
- **Phase 6 (verification + audit):** the **user-required browser pass** over the
  CLAUDE.md checklist passes; repo-wide legacy sweep is clean; the agnosticism
  audit (allow-list extended to the new files) exits 0; full test suite green.

## Dependency Graph

```
Phase 0 (stale-reference + dead-path removal)            ── runs first, alone
   │
   ├──→ Phase 1 (engine wiring + boot:                   ── parallel after 0 ──┐
   │            index.html, mount.js)                                          │
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
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Repo-wide sweep + removal of all references to deleted subsystems — `airgap-harmonic`/`harmonic-set`, `extractCoeffs`, `coenergyTorque`/`evaluateAt`/co-energy/dL-dθ, the polar grid (`airgap-grid/solve/torque/refine/worker`, `motor-compile`, `drawGapField`), and `detailed-toggle` — in code, comments, string literals, test fixtures, and any leftover stub files (e.g. a harmonic-era `gap-eval`). Remove the dead `solved`-variable readout path in `mount.js` (the live readouts will be re-sourced from `runtime.lastSolve` in Phase 1). Confirm the test suite still runs with no new failures. | M | (repo-wide) `lessons/unified_motor/mount.js`, `lib/*.js`, `tests/**`, `spec/*` references |

---

## Phase 1: Engine wiring + boot
**Depends on**: Phase 0
**Parallel with**: Phase 2

Make the live app run on the FEA engine. Owns the two wiring files.

### Wave 1.1: index.html script load + solver boot
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.1.1 | Add the FEA + render/UI `<script>` tags to `index.html` in dependency order (`fea-solver.js`, `motor-mesh.js`, `motor-mesh-view.js`, `airgap-mortar.js`, `bdf-integrator.js`, `motor-slice.js` **before** the already-present `motor-stack.js`/`motor-run.js`; then `cross-section-render.js`, `render3d.js`, `machine-picker.js`, and the geometry/material panel after `mount.js`, before the machine fixtures). Replace the bare `runTabs(...)` call with a boot that awaits `LIB.FeaSolver.init()` then mounts. (The render/UI files land in Phases 3–5; their tags are added here as the sole owner of `index.html` so later phases never edit it — a file that does not yet exist is a load no-op until its phase ships it. Plan-spec confirms tag set + order.) | S | `lessons/unified_motor/index.html` |

### Wave 1.2: mount.js — live loop against the current contract
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.2.1 | Wire `mount.js` to the current engine contract: per-frame readouts + per-circuit flux read from `runtime.lastSolve` (`fieldBundle.torque` / `.fluxLinkages`), not the removed `solved` var; confirm the wall-budgeted `runtime.step(orderedStepDt, FRAME_BUDGET_MS)` loop, playback slider, and slow-mo badge drive correctly off `state.t`; ensure `requestRebuild()` re-expands the config (including `stack.axial`) and re-creates the runtime after solver init; verify the default machine steps and the rotor turns. No machine identity; no DOM access beyond the mount's own canvases. | M | `lessons/unified_motor/mount.js` |

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
| 2.1.1 | Factor the in-gap reconstruction into a reusable `LIB.GapEval` (`evalA`/`evalAOnGrid` or equivalent) — solve the per-radius polar-Laplace field in the annulus from the rotor/stator gap-loop boundary values (the same machinery `torque()` uses), evaluating `A(r,θ)`/`B` across the gap at a render-supplied resolution. Headless test: boundary values reproduce each body's gap-loop nodal `A` to tight tolerance; field is smooth/continuous across the gap at several φ; round-trip on a prescribed analytic gap field. DOM-free; agnostic. | M | `lib/airgap-mortar.js` (or new `lib/gap-eval.js`), `tests/airgap/gap-eval.test.js` |

---

## Phase 3: Geometry-faithful 2-D asset render
**Depends on**: Phase 1, Phase 2

Replace the material-colored radial-block render with real cross-section sprites
driven by the `BodyMesh` + config winding routing. Owns the 2-D render pair.
Field overlays layer on top, gated on `UM.fieldViz`; the rotor is drawn rotated by
`perSliceField[k].gap.phi`, with smooth cross-gap flux lines via the Phase-2 helper.

### Wave 3.1: Sprite geometry primitives (teeth / slots / magnets / conductors)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | Promote `motor-mesh-view.js` to a production sprite renderer: faithful tooth/slot profiles (tooth body, tooth tip, slot opening), magnet segments with N/S shading + magnetization-direction arrows (from `magDir`), and in-slot conductor cross-sections — all derived from the `BodyMesh` features (kind/`rRange`/`thetaRange`/`magDir`), element-kind dispatch only. No radial-block fallback. | L | `lib/motor-mesh-view.js` |

### Wave 3.2: Winding glyphs (routing-aware concentrated vs distributed)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.2.1 | Draw windings as real coil glyphs from the per-slot ampere-conductor routing (`winding-model`/`config-schema` output the render reads via the slice/config): **concentrated** = per-tooth coils; **distributed** = span-slot belts; each with per-phase color and go/return polarity markers. W vs C is routing, never a machine branch. | L | `lib/motor-mesh-view.js` |

### Wave 3.3: cross-section-render orchestration + field overlays + gap + rotation
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.3.1 | Rewrite `cross-section-render.js` to drive the sprite primitives per slice: base geometry layer (always) + the five field overlays (`fluxLines` incl. smooth cross-gap via `LIB.GapEval`, `modulusB`, `saturation`, `magnetization`, `currentDensity`) each gated on `UM.fieldViz`; rotor drawn rotated by `perSliceField[k].gap.phi` (fallback `state.theta` pre-solve); consumes `runtime.stack.sliceMesh(k)` + `runtime.lastSolve.perSliceField[k]`; paints through the `registerCrossSection2D` seam into the two mount canvases. | L | `lessons/unified_motor/cross-section-render.js` |

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
| 4.1.1 | `machine-picker.js`: a header control listing the 15 `UnifiedMotor.MACHINES` fixtures; selecting one deep-copies `{rings,circuits,stack,mechanical,poles,label}` into the live editable `ctx.config` and calls `ctx.requestRebuild()` — preset-loader semantics, no machine identity stored. | M | `lessons/unified_motor/machine-picker.js` |

### Wave 4.2: Geometry + material + slice/axial editor
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.2.1 | A per-ring editor panel: **Geometry** (`rRange[0]/rRange[1]`, integer `teeth`/`magnets`/`Q`) and **Material** (`muR`, `Mr` on `M` rings, `Bknee` on iron-bearing rings); a global **gap-length `g`** slider (pure `applyGapLength(config,g)` shifting rotor surface + stator bore symmetrically about the mid-gap); a **slice control** with **"+ add slice"** that raises `stack.slices` and sets `sliceOffsets`. When `stack.slices > 1`, reveal the **axial-flux netlist editor**: branch entries (PM `Br`/`length`/`area`/`muR`, core/yoke `reluctance`) + signed flux-loop incidence, emitted as `stack.axial` (validated by `config-schema`; absent ⇒ no axial coupling). All edits mutate `ctx.config` + `requestRebuild()`. | L | `lessons/unified_motor/geometry-panel.js` (new) |

---

## Phase 5: 3-D rig
**Depends on**: Phase 3 (sprite primitives), Phase 2 (gap-eval)

### Wave 5.1: render3d.js
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | `render3d.js`: axial extrusion of the 2-D sprite cross-section, end-winding arcs (go→return over the stack ends), per-slice in-gap field paint (via `LIB.GapEval`), rotor mesh drawn rigidly rotated by `perSliceField[k].gap.phi` (stator fixed); **multi-slice stacks render each slice/cup** so an axial machine's cups are visible. Registered through `UM.registerRender3D`; reuses the Phase-3 sprite primitives; agnostic. | L | `lessons/unified_motor/render3d.js` |

---

## Phase 6: Browser verification + legacy/agnosticism audit
**Depends on**: all previous phases

> Gets its detailed `spec/phase-6-*.md` via `plan-spec` when it is its turn.

### Wave 6.1: User browser pass + repo audit
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | **User-required browser pass** (CLAUDE.md checklist): picker loads each of the 15 fixtures; geometry/material/gap edits rebuild; "+ add slice" → axial-flux editor appears and a hybrid/claw-pole config builds and runs; rotor turns; each `fieldViz` toggle paints; smooth cross-gap flux lines bridge rotor↔stator; 3-D rig extrudes + rotates + shows cups; Playback slider + slow-mo badge behave; Reset works; no console errors. Then the repo audit: zero stale references to any deleted subsystem; extend `scripts/agnosticism-audit.js` allow-list to the new files (`machine-picker.js`, `geometry-panel.js`, `render3d.js`, gap-eval) and re-run its checks (no machine-name/type reads in engine + runtime-UI; no single-slice fast path); full `node --test` green. Exit 0. | M | (repo-wide) `scripts/agnosticism-audit.js`, `lessons/unified_motor/*` |

---

## Open items deferred to plan-spec

- **gap-eval home (Phase 2):** extract into a new `lib/gap-eval.js` vs export from
  `lib/airgap-mortar.js` — decide by whether the reconstruction can be cleanly
  shared without duplicating mortar internals.
- **geometry/material panel home (Phase 4):** new `geometry-panel.js` vs extending
  `matrix-panel.js` — confirm `matrix-panel.js`'s current role (schematic editor)
  to avoid overloading one file across two concerns.
- **Exact `perSliceField` field names (Phases 3/5):** confirm `Anode`/`Belem`/
  `gap.phi` spellings against `lib/motor-stack.js` `fieldBundle` before the render
  consumes them.
- **Axial-netlist UI affordance (Phase 4):** the minimal control set for branches +
  loops that stays agnostic and maps 1:1 to `stack.axial` — refine with the user in
  plan-spec (default: hybrid L=1 two-cup loop pre-filled, generalizable to N/L).
