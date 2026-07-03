# Unified-motor — missing machinery & in-flight work

Running backlog for the unified-motor app. "Machinery" = features whose
handler and/or underlying model input does not yet exist.

## Missing machinery

### 1. Rotor-drag → torque handler
- **Handler:** none. The only pointer gesture on the 3-D viewport is camera
  orbit (`onPointerDown/Move/Up` → `orbitYaw`/`orbitPitch`, mount.js). No rotor
  hit-test, no pointer→rotor mapping.
- **Brain:** partial. `runtime.mechanical.loadTorque` is a live input
  (motor-run.js:54-58, fed into the residual at :193) but it is a *steady* load
  torque, not a grab. A proper "spin the rotor" wants a transient applied torque
  or a velocity/position grab (cf. `LIB.Drag` + Jacobian term in the
  linear/rotational lessons); the unified runtime has no such input.
- **Also:** must disambiguate rotor-grab from camera-orbit on the same canvas
  (region or modifier).
- Interim scope named here: drag writes `loadTorque` (crude, steady). Proper
  grab-input is a follow-up.

### 2. Scroll-to-zoom
- **Handler:** none. No `wheel` listener on the viewport.
- **Brain:** `ORBIT_DIST` is a const; make it mutable camera state, clamp, drive
  from the wheel delta.
- Self-contained, view-only (main thread). Unaffected by the worker split.

### 3. Circuit editor + addition
- **Handler/UI:** none. Circuits come only from config/fixtures; no add / remove
  / edit of phases, turns, connections, or slot assignment.
- **Brain:** config-schema circuit shape exists; needs an editor panel + rebuild
  on change. Larger — wants its own design pass.

## Broken / needs diagnosis

### Worker path fails in-browser (solver → Web Worker) — OFF by default
- `SimSource.createWorker` + `sim-worker.js` run the solver off-thread. Enabling
  it (`USE_SIM_WORKER=true`) gave a BLANK canvas with NO console message: the
  worker never produced geometry+snapshots and never errored/timed-out within the
  window observed. Reverted to OFF; the in-process path (444 tests, mount-smoke
  renders real frames) is the default and works.
- Established (not guessed): the `importScripts` list is exactly the set
  `tests/pipeline/_fixtures.js` loads with only a `window` shim and NO document,
  and those tests pass — so importScripts is not the failure. The remaining
  suspect is in-worker `FeaSolver.init()` (loading `solver.mjs`/`solver.wasm`
  inside a Worker — likely dynamic `import()` of the ES-module glue in a CLASSIC
  worker, or the wasm fetch path). NOT yet proven to a line.
- Instrumented: `sim-worker.js` now try/catches its load and posts a stage-tagged
  `{type:"error"}` (worker load / FeaSolver.init); the fallback timeout dropped to
  3 s. So flipping `USE_SIM_WORKER=true` now self-heals to in-process within 3 s
  AND emits a `console.warn` naming the stage + real error message.
- NEXT: flip it on, capture the warn text + DevTools Network status for the
  worker's `solver.mjs` / `solver.wasm` requests + Application→Workers. That data
  pins the exact failure; likely fix is loading solver.mjs in the worker without
  a classic-worker dynamic import (module worker, or main-thread-fetch + transfer).

## Bugs / latent

### Schematic (Circuit) editor is built but never rendered
- `schematic-panel.js` (`UM.Schematic`: drag-drop circuit editor + `lower`/
  `applyToRuntime` lowering) is complete but dead in two ways: (1) no `<script>`
  tag in `index.html` / `mesh-dev.html`, so `register(UM)` never runs; (2) it
  registers `zone: "side"` but the mount only mounts `zone: "shelf"`
  (mount.js:508) — there is no "side" zone. Wiring it up = add the script tag,
  add a "side" zone mount (or change its zone), and confirm `applyToRuntime`
  against the live runtime. Its runtime writes (`runtime.circuits`) + live-omega
  read are the command-side items the WORKER-SPEC lowering section covers — do
  that worker-side when the panel goes live; it does not gate the worker hoist.


### Cross-gap flux lines silently not drawn
- The only gap *field* overlay (cross-section-render.js:290-313, render3d.js:509-517)
  reconstructs the annulus via `GapEval.evalAOnGrid` at `field.gap.phi` every
  frame, but is gated on `rotorBody.gapLoop && statorBody.gapLoop &&
  statorGapR > rotorGapR` and wrapped in a silent `catch`. For the default
  machine it appears to draw nothing (only the `gap loop` green contour shows).
- Root-cause not yet run: is `mesh.gapLoop` populated? does the radii constraint
  hold? does `evalAOnGrid` throw? Investigate before touching.

## In flight

### Playback timestep + render interpolation
- Solver runs on its own LTE cadence (bounded by `dtMax`, motor-run.js:137).
- Render carries a smooth `simClock`, interpolates the display between real
  solve snapshots. Kinematics (`theta`, `omega`, `i`, gap `phi`) interpolate;
  field-overlay interpolation strategy under exploration (gap field needs
  reconstruct-at-interp-phi; body-mesh field rotates with geometry for free).
- Residual limit single-threaded: one atomic LTE solve (~20-50 ms) can't be
  subdivided, so a solve landing on a frame hitches it → motivates the worker.

### Solver → Web Worker (proposed)
- Move the numeric runtime off the render thread behind a `SimSource`
  abstraction (Worker impl + in-process impl for tests / file:// fallback).
- Boundary: worker owns the sim core; main thread owns DOM/render/UI + a cached
  copy of static geometry; snapshots stream up, commands go down.
- Requires HTTP serving (already true for this app; workers don't load from
  file://). In-process SimSource is the file:// fallback.
