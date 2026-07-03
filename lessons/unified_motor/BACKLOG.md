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

## Needs live verification

### Worker live-verify (solver → Web Worker)
- The solver now runs in a Web Worker (`sim-worker.js`) via `SimSource.createWorker`;
  enabled by default (`index.html`: `USE_SIM_WORKER=true`). Glue is unit-tested
  with a fake worker; the in-process fallback is fully tested. But the real
  in-worker path — `importScripts` of the numeric libs under `self.window=self`,
  FeaSolver WASM init via the `process.env.FEA_SOLVER_MJS_PATH` URL trick, first
  geometry/snapshot over a live HTTP server — CANNOT be checked headless (no
  Worker+WASM in node).
- To verify: serve the repo (`python -m http.server 8765`), open the unified
  motor, confirm the 3-D view renders and spins smoothly and DevTools shows a
  worker thread with no console error. If blank/erroring: the source self-heals
  to in-process (a `console.warn` names the reason); to force in-process set
  `UnifiedMotor.USE_SIM_WORKER=false`. Report the warn reason back.

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
