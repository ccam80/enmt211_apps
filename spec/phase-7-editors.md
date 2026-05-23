# Phase 7: Editors (cross-section, winding, schematic, matrix)

## Overview

The graphical configuration surface for the unified motor. Four app-layer
modules in `lessons/unified_motor/` that let a student build a machine by
direct manipulation — drawing windings on the cross-section, wiring the
external circuit, and flipping per-ring element/excitation/commutation toggles —
with **no editor path keyed to a machine identity**. Every edit lowers to the
frozen Phase-1–5 vocabulary; the running engine is unchanged.

The phase ships, in dependency order:

1. **`cross-section-render.js`** — the 2D cross-section renderer used by the
   winding editor and the standalone cross-section views. Two draw modes: a
   crisp **semantic** drawing (slots, teeth, magnets, conductor dot/cross glyphs
   coloured by circuit) built from `config.rings`, and a toggleable
   **compiled-feature overlay** (per-cell `ν` / magnetization / coil-mask raster
   from `LIB.MotorCompile.compile`) that exposes rasterization/mesh errors at
   fine tooth geometries.
2. **`winding-editor.js`** — concentrated (tap-tooth) and distributed
   (route go-slot → return-slot) winding editing, with **live** winding-function
   `F(θ)` / pole-count / back-EMF-shape feedback computed in the editor from the
   Phase-2 ampere-conductor map. Edits commit on pointer-release via
   `ctx.requestRebuild()`.
3. **`schematic-panel.js`** — a grid-snapped drag-drop external-circuit editor
   (sources, resistors, capacitors, switches, star/delta nodes, terminals). Its
   **lowering** produces the per-circuit `{terminal, commutation, R}` array the
   frozen engine consumes. Series resistance, manual/centrifugal switches, and
   star/delta are **exact** (real `R`, the `OPEN` terminal state, and the
   standard star/delta transform); the capacitor is represented by its
   **phase-split effect** (an injected quadrature `phaseOffset`), since Phase 4
   carries no capacitor state.
4. **`matrix-panel.js`** — the 3–4-toggles-per-ring panel. It **synthesizes** a
   complete `config` (rings + circuits + stack) generically from the toggle
   state — element-type dispatch only — and rebuilds the runtime.

A trailing task wires the four modules into `index.html`'s extension region and
authors the headless test suite; its interactive behaviour is browser-verified
(user-required).

### Machine-agnosticism boundary (load-bearing for this phase)

- Every module dispatches **only** on the universal vocabulary —
  `ring.element ∈ {W,C,M,I,K}`, terminal `type ∈ {AC,DC,PULSE,STEP,OPEN,SHORT}`,
  commutation `mode`, `member ∈ {rotor,stator}` (invariant #1). No module reads,
  writes, or stores a machine name or a "machine-type" field. The headless tests
  grep each module's source for the machine-name token list and require zero
  matches.
- The editors **never** add a new physics path. Every physics-affecting output
  is a write into the existing `config.rings` / `config.circuits` shape that the
  frozen Phase-5 `expand()` already consumes. `motor-circuit.js` (Phase 4),
  `excitation.js` (Phase 3), `config-schema.js` and `mount.js` (Phase 5) are
  **not** modified by this phase.
- Absent physics is zero, not skipped (invariant #2): a magnet-free ring emits
  no magnet glyph and no overlay magnetization; a winding with no conductors in
  a slot emits no glyph there — never a branch around the machine type.

### Conventions fixed for this phase

- **App namespace.** Every module attaches to the single global
  `window.UnifiedMotor` (created lazily with
  `const UM = window.UnifiedMotor || (window.UnifiedMotor = {});`), matching the
  Phase-5 convention. `cross-section-render.js` attaches
  `UnifiedMotor.CrossSectionRender`; `winding-editor.js` →
  `UnifiedMotor.WindingEditor`; `schematic-panel.js` → `UnifiedMotor.Schematic`;
  `matrix-panel.js` → `UnifiedMotor.MatrixPanel`.
- **DOM-free at load.** Each module's IIFE only *defines* functions; it touches
  no `document`/`canvas`/`getComputedStyle` at module-load. DOM and 2D-canvas
  contexts are touched only inside `build(host, ctx)` and the `draw*` functions
  *when called*. This is what lets the headless test suite `require` the module
  and exercise its pure functions under the Node `window` shim, exactly as
  `config-schema.js` is tested in Phase 5.
- **Guarded auto-registration.** On load, each panel module registers through
  the Phase-5 seams **only if they exist**:
  `if (UM.registerPanel) UM.registerPanel({...});`. Under the headless shim the
  seams are absent, so load is a no-op beyond defining the namespace functions.
  In the browser, the appended `<script>` tags (Task 7.5.1) run after `mount.js`
  (which creates the seams) and before the `runTabs` call, so registration
  lands before mount-time — the Phase-5 seam contract.
- **Registration-seam contract (consumed verbatim from Phase 5).**
  `UM.registerPanel({ id, title, zone:"shelf"|"side", build(host, ctx) → unmountFn })`;
  `UM.registerHeaderControl({ id, build(host, ctx) → (HTMLElement|unmountFn) })`;
  `ctx = { runtime, config, view, requestRebuild() }`. `ctx.view` is treated as
  **opaque** by this phase — no editor depends on its shape. Each panel builds
  its **own** canvas inside the `host` div it is handed and manages its own
  pointer events on that canvas; the mount's `TOOLS` pointer mux (3D-viewport
  orbit/rotor-drag) is not used by this phase.
- **The editable `config`** (the descriptor `config-schema.expand()` consumes;
  Phase-5-owned shape, read and written here, never redefined):
  ```
  config = {
    grid:    { Nr, Ntheta, rInner, rOuter, ell },
    gapBand: { iInner, iOuter },
    poles:   <positive even int>,
    mechanical: { J, damping, loadTorque },
    label:   <string>,                       // human-facing only; no code reads it behaviorally
    rings: [ {
      member:"rotor"|"stator", element:"W"|"C"|"M"|"I"|"K",
      rRange:[r0,r1], theta0?, muR?,
      teeth?, spanFraction?,                  // I, C
      magnets?, Mr?, backIron?, backIronRRange?,   // M
      winding?, slotRRange?, slotWidth?, slotFraction?, ironRRange?,  // W,C,K
    }, … ],
    circuits: [ { terminal:{ type, amp, freq, phaseOffset, conductionAngle },
                  commutation:{ mode, poles, loadAngle, stepAngleElec, conductionAngle },
                  R }, … ],
    stack: { slices, sliceOffsets, fluxSources:[ { ringRef, sliceSigns } ] },

    // Phase-7 additive UI state. config-schema.validate/expand do not read
    // these (the Phase-5 validator is a positive checklist, not a
    // reject-unknown whitelist), so they persist with the config harmlessly.
    schematic?: { connection, components, wires, switches },
    matrixState?: { rings:[ … per-ring toggle snapshot … ] },
  }
  ```
  A `ring.winding` is either an explicit Phase-2 `routing`
  (`{ nSlots, slotTheta, phases:[…] }`) or `{ standard:{ m,p,Q,coilPitch,turns } }`
  (resolved via `LIB.WindingModel.standardWinding`).
- **Phase colour palette.** A pure default palette
  `["#4ea1ff","#ef5350","#66bb6a","#ffd54a","#ab47bc","#26c6da","#ff8a65","#d4e157"]`
  is used by `circuitColor(k, n)` when no palette override is supplied; the
  browser panels pass the shell.css `--w0…--w7` tokens (via `LIB.Util.getVar`,
  at draw time only) so the editor matches the rest of the app. Headless tests
  exercise the pure default.
- **2D transform.** Cross-section drawing uses
  `LIB.Layout.rotational(W, H, { worldR: geom.rOuter, padPx })` — `polar(r, θ)`
  gives the world point, `toPx` projects it. Schematic drawing uses a
  grid-snapped screen transform (`worldToScreen`/`screenToWorld`/`snapToGrid`)
  modelled on `digital_in_browser/src/editor/coordinates.ts`.
- **Test runner**: `node:test` + `node:assert/strict`; `npm test` → `node
  --test`. Phase 7 ships its own headless loader `tests/editors/_fixtures.js`
  that `require`s Phase-1's `tests/_shim.js` **read-only** (for `window` + the
  engine libs), then `require`s `winding-model.js`, `motor-compile.js`,
  `config-schema.js`, and the four Phase-7 modules **directly**, and re-requires
  `tests/pipeline/_fixtures.js` **read-only** for `assertClose` and the sample
  configs. **`tests/_shim.js` and `tests/pipeline/_fixtures.js` are NOT modified
  by this phase.**

### Design reference (interaction patterns only — not importable)

`C:/local_working_projects/digital_in_browser` is a TypeScript/Vite circuit
simulator on a different stack; nothing is imported. Two files are the
interaction-model reference the schematic panel reimplements in plain JS:
`src/editor/coordinates.ts` (`worldToScreen` / `screenToWorld` / `snapToGrid`,
`GRID_SPACING = 20`) and `src/core/circuit.ts` (`Wire`, and
`splitWiresAtJunctions` — a node is a shared wire endpoint; a T-junction splits
the crossed wire). The schematic panel mirrors this grid-snapped,
wire-endpoint-junction model.

## Files Owned

- `lessons/unified_motor/cross-section-render.js` — created
- `lessons/unified_motor/winding-editor.js` — created
- `lessons/unified_motor/schematic-panel.js` — created
- `lessons/unified_motor/matrix-panel.js` — created
- `lessons/unified_motor/index.html` — modified (append four `<script>` tags
  **inside the marked module-extension region only**; no other line changes)
- `tests/editors/_fixtures.js` — created
- `tests/editors/cross-section.test.js` — created
- `tests/editors/winding-editor.test.js` — created
- `tests/editors/schematic.test.js` — created
- `tests/editors/matrix.test.js` — created
- `tests/editors/wiring.test.js` — created

> **`lessons/unified_motor/index.html`** is created by Phase 5 with an explicit
> comment-marked module-extension region and is the sanctioned shared
> append-point (Phase-5 spec). Phase 7 appends inside that region only and is
> the **sole Phase-7 task** that touches the file (Task 7.5.1). Phases 6 and 8
> also append into the same region; `implement-hybrid` runs phases as ordered
> sequential batches, so the appends do not race.

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 7.1: Cross-section renderer

### Task 7.1.1: cross-section-render.js — semantic + compiled-overlay 2D renderer

- **Description**: The 2D cross-section renderer shared by the winding editor
  and the cross-section views. Builds a semantic geometry view from
  `config.rings` (element-type dispatch only) and draws it crisply; also draws a
  toggleable compiled-feature overlay from the rasterized arrays so mesh errors
  at fine tooth geometries are visible. Pure-geometry functions are DOM-free and
  headless-testable; the `draw*` functions take a 2D context and are
  browser-verified.
- **Files to create**:
  - `lessons/unified_motor/cross-section-render.js` — IIFE attaching
    `window.UnifiedMotor.CrossSectionRender`. DOM-free at load. API:
    - `CrossSectionRender.buildGeometry(config) → geom` — pure. Resolves each
      ring (dispatch on `ring.element` only) into draw-ready primitives:
      ```
      geom = {
        rInner: config.grid.rInner, rOuter: config.grid.rOuter,
        nCircuits,                          // total resolved circuit count
        rings: [ {
          member, element, rRange,
          slots:   [ { index, theta,                       // W,C,K only
                       conductors:[ { circuit, turns, glyph:"dot"|"cross" } ] } ],
          teeth:   [ { index, thetaCenter, halfSpan } ],   // I,C only
          magnets: [ { index, theta0, theta1, polarity:+1|-1 } ],  // M only
        }, … ],
      }
      ```
      - **W/C/K**: resolve `ring.winding` to a routing (explicit object, or
        `standardWinding(ring.winding.standard)`); `ac =
        LIB.WindingModel.ampereConductors(routing)`; for each slot `s`
        (`theta = routing.slotTheta[s]`) emit one `conductors` entry per circuit
        `c` with non-zero `T = ac.turns[c*ac.nSlots + s]`:
        `{ circuit: globalBase + c, turns:T, glyph: T > 0 ? "dot" : "cross" }`,
        where `globalBase` is the sum of `ac.nCircuits` of all previously
        processed wound rings (offset matching the Phase-5 global-circuit
        indexing). Empty slots carry an empty `conductors` array. `nCircuits`
        (on `geom`) is the global total across all wound rings.
      - **C** additionally emits `teeth` (one per slot, `thetaCenter =
        routing.slotTheta[s]`, `halfSpan = (ring.spanFraction ?? 0.5)·(π/nSlots)`).
      - **I**: `teeth` with `count = ring.teeth`, `thetaCenter_t = (ring.theta0
        ?? 0) + t·2π/count`, `halfSpan = (ring.spanFraction ?? 0.5)·(π/count)`.
      - **M**: `magnets` with `count = ring.magnets`,
        `theta0 = g·2π/count`, `theta1 = (g+1)·2π/count`,
        `polarity = (g % 2 === 0) ? +1 : -1`.
    - `CrossSectionRender.circuitColor(circuitIndex, nCircuits, palette = null)
      → hex` — pure. Returns `palette[circuitIndex % palette.length]` when
      `palette` is a non-empty array, else the module's default palette
      (declared in Conventions). Never reads the DOM.
    - `CrossSectionRender.compileForOverlay(config, sliceIndex = 0) →
      { compiled, grid }` — pure. `exp = UnifiedMotor.ConfigSchema.expand(config)`;
      `section = exp.slices[sliceIndex].section`;
      `compiled = LIB.MotorCompile.compile(section)`; returns
      `{ compiled, grid: compiled.grid }`. Uses only DOM-free libs.
    - `CrossSectionRender.drawSemantic(ctx2d, layout, geom, opts = {})` — draws
      the annulus, per-ring slot wedges / tooth sectors / magnet N/S sectors,
      and conductor dot/cross glyphs coloured by `circuitColor`. `layout` is an
      `LIB.Layout.rotational` handle. `opts = { palette = null, highlightRing =
      null, highlightSlots = [], glyphRadiusPx = 7, lineWidth = 1.5 }`.
      Magnet sectors are filled red (`polarity +1`, N) / blue (`-1`, S). No
      machine-dependent branch; ring kind drives glyph kind only.
    - `CrossSectionRender.drawCompiledOverlay(ctx2d, layout, compiled, grid,
      opts = {})` — draws the rasterized-cell QA overlay over the same polar
      frame: iterate cells `idx = i*grid.Ntheta + j`; fill cells where
      `compiled.nu[idx] < (1/MU0)·0.999` (iron) with a translucent tint; draw a
      short magnetization arrow where
      `hypot(compiled.magnetization.Mr[idx], compiled.magnetization.Mtheta[idx])
      > 0`; outline cells where any `compiled.coilMasks[k][idx] !== 0`, coloured
      by `circuitColor(k, …)`. `opts = { alpha = 0.5, vectorStride = 2, palette =
      null }`. `MU0 = 4π×1e-7` declared at module top.
    - `CrossSectionRender.register(UM)` — calls
      `UM.registerHeaderControl({ id:"xsec-overlay", build(host, ctx){…} })` to
      add the "compiled overlay" toggle (a checkbox writing a shared
      `UM._xsecOverlay` boolean the winding editor reads). Invoked at load only
      when `UM.registerHeaderControl` exists (guarded).
- **Files to modify**: none.
- **Tests** (authored in Task 7.5.1): `tests/editors/cross-section.test.js`.
- **Acceptance criteria**:
  - `buildGeometry` of a config with a 6-slot single-phase `W` stator returns a
    ring with `slots.length === 6` and the conductor glyph of each non-zero slot
    is `"dot"` for `turns > 0` and `"cross"` for `turns < 0`.
  - `buildGeometry` of an `I` ring with `teeth:4` returns `teeth.length === 4`
    with `thetaCenter` at `(theta0) + t·π/2`; an `M` ring with `magnets:2`
    returns `magnets.length === 2` with `polarity` `[+1,-1]`.
  - `circuitColor(0, 3)` and `circuitColor(3, 3)` are equal (wrap by palette
    length); `circuitColor` with a 2-entry `palette` returns from that palette.
  - `compileForOverlay(cfg)` returns a `compiled` whose `nu`,
    `magnetization.Mr`, `coilMasks[0]` have length `grid.Nr*grid.Ntheta`.
  - For a config with a 3-circuit stator `W` ring followed by a 1-circuit rotor
    `W` ring, the rotor ring's `conductor.circuit` values are `3` (not `0`) and
    `geom.nCircuits === 4`.
  - The module loads under `require` with no DOM access; its source contains no
    machine-name token (asserted in `cross-section.test.js`).
  - All tests pass.

---

## Wave 7.2: Winding editor

### Task 7.2.1: winding-editor.js — tap-tooth / route-conductor editing with live F(θ)

- **Description**: The graphical winding editor. Concentrated editing taps a
  tooth (wrap direction → N/S sense → turn sign); distributed editing routes a
  conductor from a go-slot to a return-slot (direction inferred from traversal).
  During the gesture the editor recomputes the winding function `F(θ)`,
  pole-count, and back-EMF-shape (the winding-function harmonic spectrum) live
  from the Phase-2 ampere-conductor map — no field solve. On pointer-release the
  new routing is written into `config.rings[r].winding` and `ctx.requestRebuild()`
  reloads the live engine. The winding-function math is pure and headless-tested;
  the canvas/pointer layer is browser-verified.
- **Files to create**:
  - `lessons/unified_motor/winding-editor.js` — IIFE attaching
    `window.UnifiedMotor.WindingEditor`. DOM-free at load. API:
    - `WindingEditor.windingFunction(routing, opts = {}) → { theta, n }` — pure.
      `nSamples = opts.nSamples ?? 720`. `ac =
      LIB.WindingModel.ampereConductors(routing)`. For each circuit `c`, build
      `n[c]` (`Float64Array(nSamples)`): the running cumulative sum of the
      per-slot ampere-conductors `ac.turns[c*ac.nSlots + s]` placed at
      `routing.slotTheta[s]`, swept around `[0, 2π)` and **mean-subtracted**
      (the classical winding function `Σ = 0`). `theta` is the
      `Float64Array(nSamples)` of sample angles `(k+0.5)·2π/nSamples`.
    - `WindingEditor.spatialSpectrum(nk, maxHarmonic = 24) → { harmonics, amps }`
      — pure. Discrete-Fourier magnitude of the single winding function `nk` at
      integer spatial-harmonic orders `1..maxHarmonic`: `amps[h-1] =
      (2/N)·hypot(Σ_k nk[k]·cos(h·θ_k), Σ_k nk[k]·sin(h·θ_k))`. `harmonics` is
      `[1..maxHarmonic]`.
    - `WindingEditor.poleCount(routing) → int` — pure. Sum `spatialSpectrum`
      `amps` across all circuits; let `h*` be the harmonic order with the largest
      summed amplitude; return `2·h*` (the working pole count).
    - `WindingEditor.windingFactor(routing, poleHarmonic) → number` — pure. The
      winding factor `k_w` for `poleHarmonic` of circuit 0, using analytic
      normalization:
      `k_w = spatialSpectrum(windingFunction(routing).n[0]).amps[poleHarmonic-1] / (4·T_total/(π·poleHarmonic))`,
      where `T_total` is the total series turns of circuit 0 — the sum of
      `|per-slot ampere-conductors|`/2, i.e. the rectangular-MMF fundamental
      coefficient. A full-pitch single-coil winding thereby returns `k_w ≈ 1`.
    - `WindingEditor.register(UM)` — registers the panel:
      `UM.registerPanel({ id:"winding-editor", title:"Winding", zone:"side",
      build(host, ctx) → unmountFn })`. Invoked at load only when
      `UM.registerPanel` exists (guarded).
    - `build(host, ctx)` (browser): creates a cross-section canvas drawn via
      `CrossSectionRender.drawSemantic` (and `drawCompiledOverlay` when
      `UM._xsecOverlay` is set), an `F(θ)` mini-plot, pole-count /
      back-EMF-shape readouts, and a **ring-selector list**. The ring-selector
      renders one entry per ring, labelled by `member` + `element`
      (e.g. "Stator W", "Rotor C"); the user clicks an entry to select the
      active ring. `activeRing` is a closure-local index defaulting to the first
      wound (`W`/`C`/`K`) ring in `config.rings`. All canvas pointer events
      apply to the selected ring, so multi-wound configs are fully editable.
      Pointer handling on its own canvas:
      - **Concentrated (C ring active)**: a pointer-down on a tooth adds a coil
        wrapping that tooth into the active circuit; a second tap on the same
        tooth toggles wrap direction (negates the coil's `turns`).
      - **Distributed (W ring active)**: pointer-down on a slot sets the go-slot;
        pointer-up on another slot completes a coil `{ slotGo, slotReturn,
        turns }` (sign from traversal order) in the active circuit.
      During the gesture, `windingFunction`/`poleCount`/`spatialSpectrum` are
      recomputed and the `F(θ)` plot + readouts update every move (the live
      proxy — no solve). On pointer-release the resolved routing is written to
      `ctx.config.rings[activeRing].winding` and `ctx.requestRebuild()` is
      called (the live engine reloads against the real solve). `unmountFn`
      removes the canvas listeners and clears `host`.
- **Files to modify**: none.
- **Tests** (authored in Task 7.5.1): `tests/editors/winding-editor.test.js`.
- **Acceptance criteria**:
  - `windingFunction` of a single full-pitch coil routing (`nSlots:6`, one coil
    `{slotGo:0, slotReturn:3, turns:10}`) returns one `n[0]` whose mean is
    `0` (to `1e-9`) and which steps up by the coil's ampere-conductors between
    slot 0 and slot 3.
  - `poleCount(standardWinding({ m:3, p:4, Q:24, coilPitch:6, turns:1,
    member:"stator", rRange:[0.045,0.05] }))` returns `4` (dominant spatial
    harmonic `h* = 2 = p/2`).
  - `windingFactor(standardWinding({ m:3, p:4, Q:24, coilPitch:6, … }), 2)` is
    within `0.01` of the analytic distributed-winding factor `0.966`.
  - `spatialSpectrum` of a pure single-harmonic input returns its largest `amps`
    entry at that harmonic order.
  - The module loads under `require` with no DOM access; its source contains no
    machine-name token (asserted in `winding-editor.test.js`).
  - All tests pass.

---

## Wave 7.3: Circuit schematic

### Task 7.3.1: schematic-panel.js — drag-drop circuit editor + terminal lowering

- **Description**: The external-circuit editor. A grid-snapped drag-drop canvas
  of sources, resistors, capacitors, switches, star/delta nodes, and terminals;
  right-clicking a component opens its parameter sliders. The panel **lowers**
  the edited topology to the frozen per-circuit `{terminal, commutation, R}`
  array: star/delta are the standard balanced transform, series resistance sets
  the real per-circuit `R`, manual/centrifugal switches flip a circuit between
  `OPEN` and its driven source, and a capacitor injects a quadrature
  `phaseOffset` representing its phase-split effect. Parameter tweaks mutate
  `runtime.circuits` in place; structural edits that change the circuit count
  call `ctx.requestRebuild()`. A panel-owned rAF evaluates centrifugal switches
  against `runtime.state.omega` each frame. The lowering and switch logic are
  pure and headless-tested; the canvas/drag layer is browser-verified.
- **Files to create**:
  - `lessons/unified_motor/schematic-panel.js` — IIFE attaching
    `window.UnifiedMotor.Schematic`. DOM-free at load. API:
    - `Schematic.capPhaseSplit(C, freq, R) → radians` — pure. The documented,
      monotone capacitor→phase-split relation:
      `if (C === 0) return 0;` (no capacitor → no phase split);
      `if (freq <= 0) return 0;`;
      otherwise `Δφ = Math.atan2(1/(2π·freq·C), R)`, clamped to `[0, π/2]`.
      Boundary behaviour: returns `0` when `C === 0` (no capacitor); approaches
      `0` as `freq·C → ∞` (large capacitor → negligible split); returns `π/2`
      (pure quadrature) when `R === 0` (with `C, freq > 0`). This is the cap's
      *effect*, not an ODE state.
    - `Schematic.switchState(sw, ctx2) → "CLOSED" | "OPEN"` — pure. `sw =
      { kind:"manual"|"centrifugal", target:int, closed?:bool, cutoutOmega?:number,
      mode?:"start-winding"|"run-winding" }`; `ctx2 = { omega }`. For
      `"manual"`: returns `sw.closed ? "CLOSED" : "OPEN"`. For `"centrifugal"`
      with `mode = "start-winding"` (default): returns `"OPEN"` when
      `Math.abs(ctx2.omega) >= sw.cutoutOmega`, else `"CLOSED"` (a start winding
      cut out above cutout speed); `mode = "run-winding"` inverts the comparison.
    - `Schematic.lower(schematic, baseCircuits, params = {}) → circuits[]` —
      pure. Returns a new array of `{ terminal, commutation, R }`, length
      `baseCircuits.length`, derived from the topology:
      - Start from a deep copy of `baseCircuits`.
      - `schematic.connection`:
        - `"independent"`: leave each circuit's `terminal`/`commutation`
          unchanged.
        - `"star"`: for the `m` circuits in the connected phase group (in
          declaration order, index `k = 0..m-1`), set `terminal.type = "AC"`,
          `terminal.amp = params.Vphase ?? terminal.amp`,
          `terminal.phaseOffset = (params.basePhase ?? 0) − 2π·k/m`.
        - `"delta"`: as `"star"` but `terminal.amp = √3·(params.Vphase ??
          terminal.amp)` and `terminal.phaseOffset = (params.basePhase ?? 0) +
          π/6 − 2π·k/m`.
      - For each `component` of kind `"resistor"` on a branch targeting circuit
        `t`: `circuits[t].R += component.R` (series resistance — real phase
        split).
      - For each `component` of kind `"capacitor"` on a branch targeting circuit
        `t`: `circuits[t].terminal.phaseOffset += capPhaseSplit(component.C,
        circuits[t].terminal.freq, circuits[t].R)` (phase-split effect).
        If `circuits[t].terminal.type !== "AC"`, a capacitor on that branch has
        no effect (zero-not-skip — there is no AC frequency to create a phase
        split), so `terminal.freq` is never read for non-AC terminals.
      - Switches are **not** applied here (they are runtime/omega-dependent);
        `lower` produces the closed-switch baseline.
    - `Schematic.applyToRuntime(runtime, schematic, params = {}) → void` —
      `lowered = lower(schematic, runtime.circuits, params)`; for each circuit
      `k`, copy `lowered[k].terminal`/`commutation`/`R` into `runtime.circuits[k]`
      in place; then for each `sw` of `schematic.switches`, if
      `switchState(sw, { omega: runtime.state.omega }) === "OPEN"` set
      `runtime.circuits[sw.target].terminal = { ...runtime.circuits[sw.target].terminal,
      type:"OPEN" }`. Mutates in place; does not rebuild (the circuit count is
      unchanged).
    - `Schematic.register(UM)` — registers the panel:
      `UM.registerPanel({ id:"schematic", title:"Circuit", zone:"side",
      build(host, ctx) → unmountFn })`. Guarded.
    - `build(host, ctx)` (browser): a grid-snapped drag-drop canvas
      (`worldToScreen`/`screenToWorld`/`snapToGrid`, `GRID_SPACING = 20`,
      modelled on the design reference). Components carry pins; wires connect
      pins; a node is a shared wire endpoint (T-junctions split the crossed
      wire, per the reference `splitWiresAtJunctions` model). Right-clicking a
      source/resistor/capacitor/switch opens a popover of its parameter sliders
      via `LIB.Registry.mkRow`. Editing flow:
      - A **parameter** change (amp/freq/phaseOffset/R/C/cutoutOmega via a
        slider) calls `Schematic.applyToRuntime(ctx.runtime, schematic, params)`
        — no rebuild.
      - A **structural** change (add/remove a winding terminal that changes the
        circuit count, e.g. wiring an aux branch into a new circuit) writes the
        topology into `ctx.config` (rings/circuits as needed) and calls
        `ctx.requestRebuild()`.
      - A panel-owned `requestAnimationFrame` loop calls
        `Schematic.applyToRuntime(ctx.runtime, schematic, params)` each frame so
        centrifugal switches track `runtime.state.omega`; manual switches flip a
        component flag and re-apply on click.
      The edited topology is stored in `ctx.config.schematic`. `unmountFn`
      cancels the rAF, removes listeners, and clears `host`.
- **Files to modify**: none.
- **Tests** (authored in Task 7.5.1): `tests/editors/schematic.test.js`.
- **Acceptance criteria**:
  - `lower` with `connection:"star"`, `params:{ Vphase:230, basePhase:0 }`, on a
    3-circuit base returns `terminal.phaseOffset` `[0, −2π/3, −4π/3]` (to `1e-9`)
    and every `terminal.amp === 230`, `terminal.type === "AC"`.
  - `lower` with `connection:"delta"`, same params, returns
    `terminal.amp === √3·230` (to `1e-9`) and `phaseOffset[k] === π/6 − 2π·k/3`.
  - `lower` with a `"resistor"` component `{ target:1, R:4 }` on a base whose
    `circuits[1].R === 1` returns `circuits[1].R === 5`.
  - `lower` with a `"capacitor"` component `{ target:1, C:30e-6 }` on a circuit
    with `freq:50, R:5` shifts `circuits[1].terminal.phaseOffset` by exactly
    `capPhaseSplit(30e-6, 50, 5)` (to `1e-12`); `capPhaseSplit(0, 50, 5) === 0`
    and `capPhaseSplit(30e-6, 50, 0) === π/2`.
  - `switchState({ kind:"centrifugal", target:0, cutoutOmega:100 }, { omega:50 })
    === "CLOSED"` and `… { omega:150 }) === "OPEN"`;
    `switchState({ kind:"manual", target:0, closed:false }, { omega:0 }) ===
    "OPEN"`.
  - `applyToRuntime` on a stub `runtime` with a centrifugal start-winding switch
    sets `runtime.circuits[target].terminal.type === "OPEN"` when
    `runtime.state.omega` exceeds `cutoutOmega`, and restores the lowered
    (driven) terminal below cutout.
  - The module loads under `require` with no DOM access; its source contains no
    machine-name token (asserted in `schematic.test.js`).
  - All tests pass.

---

## Wave 7.4: Matrix / config panel

### Task 7.4.1: matrix-panel.js — per-ring toggles synthesize the config

- **Description**: The 3–4-toggles-per-ring panel (element + excitation +
  commutation per ring). It synthesizes a complete `config` (rings + circuits +
  stack) generically from the toggle state, with element-type dispatch only and
  zero machine identity, then rebuilds the runtime. The synthesis is pure and
  headless-tested; the toggle UI is browser-verified.
- **Files to create**:
  - `lessons/unified_motor/matrix-panel.js` — IIFE attaching
    `window.UnifiedMotor.MatrixPanel`. DOM-free at load. API:
    - `MatrixPanel.toggleSpace() → { elements, excitations, commutations }` —
      pure. `elements = ["W","C","M","I","K"]`,
      `excitations = ["AC","DC","PULSE","STEP","OPEN","SHORT"]`,
      `commutations = ["none","mechanical","electronic-trap","electronic-sine",
      "sequencer"]`. Drives the toggle UI generically.
    - `MatrixPanel.synthesize(toggles, base = {}) → config` — pure. `toggles =
      { poles, grid?, gapBand?, mechanical?, stack?, rings:[ {
      member, element, count, m?, p?, Q?, coilPitch?, turns?,
      excitation:{ type, amp?, freq?, conductionAngle? },
      commutation:{ mode } }, … ] }`. Builds a `config`:
      - `grid`/`gapBand`/`mechanical`/`poles` from `toggles` (falling back to
        `base` then to documented defaults: `grid {Nr:12,Ntheta:256,
        rInner:0.04,rOuter:0.05,ell:0.1}`, `gapBand {iInner:4,iOuter:8}`,
        `mechanical {J:1e-4,damping:1e-5,loadTorque:0}`, `poles:2`).
      - For each ring, dispatch on `ring.element`:
        - **W/C**: `winding = { standard:{ m:ring.m??3, p:ring.p??toggles.poles,
          Q:ring.Q??(ring.m??3)*(ring.p??toggles.poles)*2,
          coilPitch:ring.coilPitch??(Q/p), turns:ring.turns??20 } }`; emit `m`
          series circuits, each `{ terminal:{ type:ring.excitation.type,
          amp:ring.excitation.amp??1, freq:ring.excitation.freq??0,
          phaseOffset:−2π·k/m, conductionAngle:ring.excitation.conductionAngle??
          (2π/3) }, commutation:{ mode:ring.commutation.mode,
          poles:toggles.poles }, R:ring.R??1 }`.
        - **K**: same winding as `W`, but every emitted circuit's
          `terminal.type = "SHORT"` (shorted cage — the terminal state is the
          only difference, not a geometry branch).
        - **M**: set `magnets:ring.count`, `Mr:ring.Mr??1e5`; emit **zero**
          circuits.
        - **I**: set `teeth:ring.count`; emit **zero** circuits.
      - Assemble `config.circuits` across rings in ring-then-phase order; set
        `config.rings` with `member`/`element`/`rRange` and the element-specific
        fields above. The rotor/stator boundary radius is derived from the gap
        band: `gapR = grid.rInner + (grid.rOuter − grid.rInner)·(gapBand.iInner/grid.Nr)`.
        Rotor rings share `[grid.rInner, gapR]` divided evenly (equal radial
        width per rotor ring); stator rings share `[gapR, grid.rOuter]` divided
        evenly. `config.stack = toggles.stack ?? { slices:1,
        sliceOffsets:[0], fluxSources:[] }`. No machine name/type anywhere.
    - `MatrixPanel.register(UM)` — registers the panel:
      `UM.registerPanel({ id:"matrix", title:"Matrix", zone:"shelf",
      build(host, ctx) → unmountFn })`. Guarded.
    - `build(host, ctx)` (browser): renders, per ring, an element selector and
      excitation/commutation selectors from `toggleSpace()`. On any change:
      `cfg = synthesize(currentToggles, ctx.config)`; copy `cfg`'s
      `rings`/`circuits`/`stack`/`grid`/`gapBand`/`poles`/`mechanical` into
      `ctx.config`; store the snapshot in `ctx.config.matrixState`; call
      `ctx.requestRebuild()`. `unmountFn` clears `host`.
- **Files to modify**: none.
- **Tests** (authored in Task 7.5.1): `tests/editors/matrix.test.js`.
- **Acceptance criteria**:
  - `synthesize` of a 2-ring toggle set (`stator W`, 3-phase `AC`,
    `commutation none`; `rotor I`, `count:2`) yields `config.circuits.length ===
    3`, each `terminal.type === "AC"` with `phaseOffset` `[0,−2π/3,−4π/3]`, and
    the rotor ring carries `teeth:2` with **zero** rotor circuits.
  - `UnifiedMotor.ConfigSchema.validate(synthesize(toggles)).ok === true` and
    `UnifiedMotor.ConfigSchema.expand(synthesize(toggles))` runs without
    throwing, for the wound-stator/iron-rotor toggle set above.
  - A `K`-rotor toggle set yields rotor circuits all with
    `terminal.type === "SHORT"`; an `M`-rotor toggle set yields zero rotor
    circuits and a ring with `magnets === ring.count`.
  - `toggleSpace()` returns exactly the five elements, six excitations, and five
    commutation modes (set equality).
  - The module loads under `require` with no DOM access; its source contains no
    machine-name token (asserted in `matrix.test.js`).
  - All tests pass.

---

## Wave 7.5: Test suite + page wiring

### Task 7.5.1: editors test suite + index.html module wiring (browser-verified)

- **Description**: The Phase-7 validation suite over the four modules' pure
  functions, plus the `index.html` wiring that loads them into the page. This is
  the **sole** Phase-7 task that touches `index.html`. Because the editors are
  interactive UI, the task also carries the browser-verification of the live
  editing behaviour, which no headless agent can perform — it is flagged
  **user-required** in the manifest.
- **Files to create**:
  - `tests/editors/_fixtures.js` — not a test file (no `.test.js`). On require:
    `const LIB = require("../_shim.js");` (installs `window` + engine libs),
    then **direct** `require` of `../../lib/winding-model.js`,
    `../../lib/motor-compile.js`, `../../lessons/unified_motor/config-schema.js`,
    `../../lessons/unified_motor/cross-section-render.js`,
    `../../lessons/unified_motor/winding-editor.js`,
    `../../lessons/unified_motor/schematic-panel.js`, and
    `../../lessons/unified_motor/matrix-panel.js`. Re-requires
    `../pipeline/_fixtures.js` **read-only** for `assertClose`, `woundConfig`,
    `salientConfig`. Exports:
    - `LIB`, `UnifiedMotor` (`= window.UnifiedMotor`), `assertClose`.
    - `MACHINE_NAMES` — the same frozen token list Phase 5 greps for
      (case-insensitive): `["bldc","pmsm","srm","squirrel","stepper","brushed",
      "universal-motor","wound-field"]`.
    - `woundConfig`, `salientConfig` (re-exported from the pipeline fixtures).
    - `fullPitchRouting()` — `{ nSlots:6, slotTheta:[0,π/3,2π/3,π,4π/3,5π/3],
      phases:[{ id:"A", branches:[{ coils:[{ slotGo:0, slotReturn:3, turns:10 }] }] }] }`.
    - `starSchematic()` — `{ connection:"star", components:[], wires:[],
      switches:[] }`; `deltaSchematic()` — `{ connection:"delta", … }`.
    - `stubRuntime(circuits, omega)` — `{ circuits, state:{ omega } }` for
      `applyToRuntime` tests.
    - `woundIronToggles()` — the matrix toggle set: stator `W` 3-phase `AC`
      `none`; rotor `I` `count:2`.
  - `tests/editors/cross-section.test.js` — `require("./_fixtures.js")`:
    - › `"buildGeometry resolves W slots with dot/cross glyphs"` —
      `buildGeometry` of a config whose stator ring uses `fullPitchRouting()`:
      the `W` ring has `slots.length === 6`; the slot-0 conductor glyph is
      `"dot"` (turns `+10`) and the slot-3 glyph is `"cross"` (turns `−10`).
    - › `"buildGeometry resolves I teeth and M magnets"` — an `I` ring
      `teeth:4` → `teeth.length === 4` with `thetaCenter[t] ≈ theta0 + t·π/2`;
      an `M` ring `magnets:2` → `magnets.length === 2`, `polarity` `[+1,−1]`.
    - › `"circuitColor wraps by palette"` — `circuitColor(0,3) ===
      circuitColor(3,3)`; a 2-entry palette returns its entries.
    - › `"compileForOverlay returns full-length arrays"` —
      `compileForOverlay(woundConfig())`: `compiled.nu.length === grid.Nr*grid.Ntheta`
      and `compiled.coilMasks[0].length === grid.Nr*grid.Ntheta`.
    - › `"no machine-name string in source"` — read
      `lessons/unified_motor/cross-section-render.js`; assert no `MACHINE_NAMES`
      token appears (case-insensitive).
  - `tests/editors/winding-editor.test.js` — `require("./_fixtures.js")`:
    - › `"windingFunction is mean-zero and steps at the coil slots"` —
      `windingFunction(fullPitchRouting())`: `n[0]` mean is `0` (±`1e-9`); the
      value rises between the slot-0 and slot-3 sample angles.
    - › `"poleCount of standardWinding 3/4/24 is 4"` —
      `poleCount(LIB.WindingModel.standardWinding({ m:3, p:4, Q:24, coilPitch:6,
      turns:1, member:"stator", rRange:[0.045,0.05] })) === 4`.
    - › `"windingFactor matches analytic 0.966"` — `windingFactor(<the 3/4/24
      winding>, 2)` is within `0.01` of `0.966`.
    - › `"spatialSpectrum peaks at the input harmonic"` — for a hand-built
      single-harmonic `nk` (order 3), `spatialSpectrum(nk).amps` is maximal at
      `harmonics === 3`.
    - › `"no machine-name string in source"` — as above for
      `winding-editor.js`.
  - `tests/editors/schematic.test.js` — `require("./_fixtures.js")`:
    - › `"star lowers to balanced offsets"` — `lower(starSchematic(), <3-circuit
      base>, { Vphase:230, basePhase:0 })`: `phaseOffset` `[0,−2π/3,−4π/3]`
      (±`1e-9`), all `amp === 230`, all `type === "AC"`.
    - › `"delta scales amplitude by √3 and shifts by π/6"` —
      `lower(deltaSchematic(), <base>, { Vphase:230 })`: `amp === √3·230`
      (±`1e-9`), `phaseOffset[k] === π/6 − 2π·k/3`.
    - › `"series resistor adds to circuit R"` — `lower` with a `"resistor"`
      `{ target:1, R:4 }` on a base whose `circuits[1].R === 1` → `circuits[1].R
      === 5`.
    - › `"capacitor injects capPhaseSplit"` — `lower` with a `"capacitor"`
      `{ target:1, C:30e-6 }` on `circuits[1].terminal.freq === 50,
      circuits[1].R === 5` shifts `phaseOffset` by exactly
      `capPhaseSplit(30e-6,50,5)`; `capPhaseSplit(0,50,5) === 0`;
      `capPhaseSplit(30e-6,50,0)` is `π/2`.
    - › `"switchState centrifugal and manual"` — `switchState({ kind:
      "centrifugal", target:0, cutoutOmega:100 }, { omega:50 }) === "CLOSED"`;
      `{ omega:150 }) === "OPEN"`; `switchState({ kind:"manual", target:0,
      closed:false }, { omega:0 }) === "OPEN"`.
    - › `"applyToRuntime opens an aux circuit above cutout"` — `stubRuntime`
      with two driven circuits and a centrifugal start-winding switch on circuit
      `1`, `cutoutOmega:100`: at `omega:150`, `applyToRuntime` sets
      `runtime.circuits[1].terminal.type === "OPEN"`; at `omega:50`, circuit `1`
      is driven (not `"OPEN"`).
    - › `"no machine-name string in source"` — as above for
      `schematic-panel.js`.
  - `tests/editors/matrix.test.js` — `require("./_fixtures.js")`:
    - › `"synthesize builds m balanced circuits + iron teeth"` —
      `synthesize(woundIronToggles())`: `config.circuits.length === 3`, each
      `terminal.type === "AC"`, `phaseOffset` `[0,−2π/3,−4π/3]`; the rotor ring
      carries `teeth:2` and contributes no circuits.
    - › `"synthesized config validates and expands"` — `cfg =
      synthesize(woundIronToggles())`; `UnifiedMotor.ConfigSchema.validate(cfg).ok
      === true`; `UnifiedMotor.ConfigSchema.expand(cfg)` does not throw.
    - › `"K ring yields SHORT circuits, M ring yields zero circuits"` — a
      `K`-rotor toggle set → rotor circuits all `terminal.type === "SHORT"`; an
      `M`-rotor toggle set → zero rotor circuits, `magnets === count`.
    - › `"toggleSpace lists the full vocabulary"` — `Set` equality of
      `elements`/`excitations`/`commutations` against the fixed lists.
    - › `"no machine-name string in source"` — as above for `matrix-panel.js`.
  - `tests/editors/wiring.test.js` — `require("./_fixtures.js")` + `node:fs`:
    - › `"index.html loads the four Phase-7 modules inside the marked region"` —
      read `lessons/unified_motor/index.html`; locate the substring between
      `<!-- unified-motor modules:` and `<!-- /unified-motor modules -->`; assert
      that region contains a `<script src>` for each of `./cross-section-render.js`,
      `./winding-editor.js`, `./schematic-panel.js`, `./matrix-panel.js`, and
      that both marker comments are present exactly once.
- **Files to modify**:
  - `lessons/unified_motor/index.html` — inside the existing module-extension
    region (between the `<!-- unified-motor modules: later phases append … -->`
    and `<!-- /unified-motor modules -->` markers, created by Phase 5), append in
    order:
    ```html
    <script src="./cross-section-render.js"></script>
    <script src="./winding-editor.js"></script>
    <script src="./schematic-panel.js"></script>
    <script src="./matrix-panel.js"></script>
    ```
    No other line of `index.html` changes. (`cross-section-render.js` precedes
    `winding-editor.js`, which consumes it.)
- **Acceptance criteria**:
  - `npm test` runs all `tests/editors/*.test.js` (alongside the existing
    suites) and exits 0.
  - `tests/editors/_fixtures.js` is not collected as a test (no `.test.js`
    suffix) and is `require`-able by every editors test file.
  - `tests/_shim.js` and `tests/pipeline/_fixtures.js` are byte-unchanged.
  - The four `<script>` tags appear, in the specified order, inside the
    `index.html` marked region; no other line of `index.html` changed.
  - **(User-required)** Served from the repo root,
    `http://localhost:<port>/lessons/unified_motor/index.html` loads with no
    console errors; the user completes the browser checklist and records the
    result in `spec/progress.md`:
    1. The Winding, Circuit, and Matrix panels appear via the registration
       seams.
    2. Selecting a ring via the ring-picker, then routing a conductor on the
       cross-section updates the `F(θ)` plot, pole-count, and back-EMF-shape
       readouts **live** during the gesture, and the running sim reloads on
       pointer-release.
    3. The compiled-feature overlay toggle paints the rasterized cells over the
       semantic cross-section (a fine tooth shows its cell coverage).
    4. Switching the schematic star↔delta changes the drive; a centrifugal
       switch opens the aux winding once the rotor passes the cutout speed; a
       series resistor / capacitor on the aux branch produces a starting torque.
    5. Flipping a matrix ring toggle (element/excitation/commutation) re-derives
       the machine and the rotor responds — with no machine name anywhere in the
       UI.
- **User action required**: the browser checklist above; acked via
  `ack-user-gate.sh T7.5.1 "<evidence>"`.
