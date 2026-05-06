# ENMT211 lesson apps — spec-driven shell

This repo hosts a set of interactive teaching apps for ENMT211. The active
direction is to migrate every lesson to a single uniform shell so each
lesson is one declarative *spec* — physics, sliders, plots, readouts,
rendering — and the shell handles chrome, the main loop, and tab/mode
dispatch.

The linear-transmission family at `lessons/linear_transmission/` is the
canonical reference. Read it before writing a new lesson.

## Repo layout

```
ENMT211Apps/
  CLAUDE.md                      ← this file
  lib/                           ← shared shell + helpers (every lesson uses)
  lessons/
    linear_transmission/         ← lead-screw / ball-screw / conveyor /
                                   whole-system family
      index.html                 ← runTabs hub (all four lessons)
      lead-screw.html  (+ .js)   ← standalone shell + spec
      ball-screw.html  (+ .js)
      conveyor.html    (+ .js)
      whole-system.html (+ .js)  ← uses spec.modes to swap device sub-mode
    rotational_transmission/     ← gears / backlash / belt-and-pulley /
                                   whole-system family
      index.html                 ← runTabs hub (all four lessons)
      gears.html       (+ .js)   ← simple/compound chain (modes axis)
      backlash.html    (+ .js)   ← gear chain with finite tooth lash
      belt-and-pulley.html (+.js)← N-pulley belt drive (stepped pulleys)
      whole-system.html (+ .js)  ← PID + thermal + reflected inertia
    pid/                         ← (planned) PID lessons
    control/                     ← (planned) controller-tour lessons
  pidapp/                        ← legacy monolith
    index.html
    three_carts.html
  controlapp/                    ← legacy monolith
    index.html
```

The legacy `pidapp/` and `controlapp/` monoliths still serve as the live
versions of unmigrated lessons. They reference `../lib/...` and will be
progressively decommissioned as their lessons get spec-migrated into
`lessons/<topic>/`.

A static HTTP server should be rooted at the repo root, e.g.
`python -m http.server 8765` from `ENMT211Apps/`. Lessons load fine via
`file://` too — every script tag is a plain `<script src>` (no ES modules,
no fetch).

## What lives in `lib/`

| File             | Provides                                              | Depends on                         |
|------------------|-------------------------------------------------------|------------------------------------|
| `util.js`        | `LIB.Util.{getVar, hexToRgb, rgbToHex, lerpColor, fitCanvas}` | —                          |
| `registry.js`    | `LIB.Registry.{mkRow, syncSlider}` — slider+number row builder used by the shell | — |
| `plot.js`        | `LIB.Plot.{drawGrid, drawLine, drawLegend}` — time-series renderer | —                       |
| `integrate.js`   | `LIB.Integrate.{rk4, rk45, siEuler, implicitEuler, implicitLinear}` | —                  |
| `draw.js`        | `LIB.Draw.{lessonTitle, trapezoidWeight, jReflectedCallout, motor, track, groundHatch, arrow, dimensionLine}` — shared canvas primitives | — |
| `pid.js`         | `LIB.PID.{advance, effort}` + `LIB.BangBang.{latch, flip}` — generic single-loop primitives used by every controller in the repo | — |
| `position-torque.js` | `LIB.PositionTorque.{advance, demand}` — cascade position-PID → velocity-loop → motor torque | `pid.js`               |
| `end-stop.js`    | `LIB.EndStop.force` — bumper-spring travel-limit force | —                                 |
| `match-hint.js`  | `LIB.MatchHint.{color, hint}` — inertia-matching colour band + textual hint | —                  |
| `thermal.js`     | `LIB.Thermal.{step, tempFromE, tint, fillTint, motorOpts, drawExplosion, drawGauge}` — leaky-integrator motor heat model + thermal-aware motor render opts | `util.js` |
| `drag-smoother.js` | `LIB.DragSmoother` class — moving-window pointer-velocity differentiator | —                |
| `layout.js`      | `LIB.Layout.{linearTrack, world2D, rotational}` — canvas world↔px transform factories | — |
| `drag.js`        | `LIB.Drag.{hbar, vbar, point2d, angular, chainWheel, mux}` — pointer-drag helpers | `drag-smoother.js` |
| `lash.js`        | `LIB.Lash.{contactForce, latchEngagement}` — finite-flank contact + latched engagement state machine, used by lead-screw and rotational-backlash | — |
| `screw-render.js`| `LIB.ScrewRender.{startColor, threadGeom, drawShaft, drawLeadNut, drawBallNut, minRenderablePitch}` — screw-thread + nut renderers shared by lead-screw / ball-screw / whole-system | — |
| `belt-render.js` | `LIB.BeltRender.{layout, beltPath, drawScene, openBeltPath, drawOpenBelt}` — conveyor renderer + free-floating open-belt renderer (rotational belt-and-pulley) | `draw.js` |
| `wheel-chain.js` | `LIB.WheelChain.{isCompound, leftR, rightR, outerR, meshSign, pairRatio, cumRatios, reflectedJ, reflectedDrag, layoutCenters, computeDrawOrder, makeState, addWheel, removeLast, dof, meshPsi, meshPsiDot, recomputePsiOffsets, contactDxdt, contactJacobian}` — N-wheel chain math + layout + declarative-physics surface (state factory, dof, dxdt, jacobian) so rotational lessons can run on the shared implicit-Euler integrator | `lash.js` |
| `wheel-chain-view.js` | `LIB.WheelChainView.{color, buildView, hitTestWheel, pointerAngleFor}` — per-frame chain layout + pointer hit-test shared by every rotational lesson | `util.js`, `wheel-chain.js` |
| `gear-render.js` | `LIB.GearRender.{PITCH_ARC, teethCount, snapRadiusToTeeth, gearPhases, drawGearShape, drawWheel, drawDriveArrow}` — gear-tooth + wheel rendering shared by every rotational lesson | — |
| `header-buttons.js` | `LIB.HeaderButtons.{toggle, driveToggle}` — factory functions for `spec.headerButtons` entries (the shell knows nothing app-specific; lessons that want a Drive ON/OFF button call `driveToggle()`) | `util.js` |
| `app.js`         | `LIB.App.{run, runTabs, _mountSpec}` — the shell      | util, registry, plot, integrate    |
| `shell.css`      | chrome + layout styles                                | —                                  |

The shell builds and binds its own tab strips: `.ex-tabs` for top-level
(via `LIB.App.runTabs`), `.sub-tabs` for in-lesson modes (via `spec.modes`).

## Shell entry points

### `LIB.App.run(spec)`

Single-spec full-page mount. Clears `document.body`, builds standard chrome
(header + stage + sliders + plots), runs the main loop. Use this in
standalone lesson HTMLs (`lessons/<topic>/<name>.html`).

### `LIB.App.runTabs({ title, tabs, initial?, persistKey? })`

Multi-tab hub. Builds outer `<header>` (app title + `.ex-tabs` strip) and
mounts ONE active tab below it at a time. On tab switch the previous spec's
mount is torn down (rAF cancelled, DOM cleared, pointer listeners removed)
and the new spec's mount is built fresh.

```js
LIB.App.runTabs({
  title: "Linear Transmission",
  persistKey: "linear-transmission-active-lesson",  // optional localStorage
  initial: 0,                                // index OR label string, optional
  tabs: [
    { label: "lead-screw", spec: LEAD_SCREW },           // standard stage shape
    { label: "tutorial",   mount: (host) => unmountFn }, // custom layout (controlapp)
  ],
})
```

A tab is either:
- `{ label, spec }` — full spec, mounted via `_mountSpec` (default chrome).
- `{ label, mount: (host) => unmount }` — bare host div, full DOM control.
  Use this for tutorial pages with a non-stage layout (controlapp tutorials).
  `mount` should return either an `unmount()` function or an object with
  `.unmount`, called on tab switch.

State across tab switches: the spec's `state()` factory is called fresh on
each mount — no carry-over. Slider values reset to their `value` defaults.
This matches Reset semantics. Use `persistKey` for the active tab index
only; per-spec slider persistence is a separate (currently unimplemented)
feature.

### `LIB.App._mountSpec(host, spec)`

Internal: builds standard chrome inside any host element and returns a
handle with `.unmount()`, `.canvas`, `.ctx`, `.state`, `.params`,
`.setMode(id)`, `.resetHistory`, `.rebuildPanels`. Both `run()` and
`runTabs()` use it. Lessons should not call it directly.

## What `_mountSpec(host, spec)` does for you

1. Builds page chrome inside `host`: `<header>` (title, subtitle, Reset,
   Pause, optional Drive switch), optional `.sub-tabs` strip (when
   `spec.modes` is present), `.stage` grid (canvas + right pane with
   stacked plots + readout column), bottom `.sub-panels` with one `.box`
   per slider panel + one `.box` for description.
2. Builds slider rows via `LIB.Registry.mkRow`, one panel per group in
   `spec.sliders` (or its function form). Wires each slider's `onChange`.
3. Builds plot canvases — one `.plot-box` per entry in `spec.plots`.
4. Wires Reset (resets `state` in place via `spec.state()` + clears plot
   history + calls `spec.onReset`), Pause, and any `spec.headerButtons`
   (label / style refreshed each frame; `LIB.HeaderButtons.driveToggle()`
   is the standard "Drive: ON/OFF" factory and writes to `state.driveOn`).
5. Runs the main loop:
   - Frame: `dtFrame = (now - last) / 1000` (clamped to 50 ms).
   - Accumulator: `acc += dtFrame; while (acc >= PHYS_DT) { stepOnce(); acc -= PHYS_DT; }`
   - Each `stepOnce(dt)`:
     - Reads current slider values into a fresh `params` object (and
       `params.mode` if `spec.modes` is set).
     - Calls `physics.preStep(state, params, dt)` if defined.
     - Either calls `physics.step(state, params, dt)` (imperative escape
       hatch) **or** runs the chosen integrator on `physics.dxdt`
       (declarative path).
     - Calls `physics.postStep(state, params, dt)` if defined.
     - Increments `state.t` by `dt`.
   - Pushes a plot-history sample (one per pane) at `histRateHz` (default 60 Hz).
   - Calls `spec.render(ctx, layout, state, params)` against the main canvas.
   - Renders each plot pane with auto Y-range (or static `yMin`/`yMax`).
   - Updates each readout text in place.
6. Dispatches pointer events from the main canvas to `spec.onPointer(type,
   mx, my, layout, state, params)`. `type ∈ {"down", "move", "up", "leave",
   "cancel"}`. `mx`/`my` are CSS-pixel coordinates; the shell already
   manages pointer-capture and the `.grabbing` cursor class.
7. Returns a handle with `.unmount()` so `runTabs` can swap specs.

## What a new lesson must provide

Two files: a thin HTML loader and the spec.

### `lessons/<topic>/<name>.html`

Lift verbatim from `lead-screw.html` and change the title + the spec
script src. `link rel="stylesheet"` points at `../../lib/shell.css`. Every
`<script src>` is `../../lib/<name>.js` (or `./<lesson-name>.js` for the
spec itself). Order matters: load `util.js` first, then any of the helper
libs the lesson needs, then `app.js`, then the spec, then explicitly mount.

The lesson `.js` file should NOT auto-mount. Instead it registers its
spec on a per-topic namespace (e.g. `window.LinearLessons` for the
linear-transmission family) and the HTML's last script tag explicitly
calls `LIB.App.run(spec)`. This lets a `lessons/<topic>/index.html` hub
gather every lesson's spec and mount them via `LIB.App.runTabs` without
each spec auto-mounting on body load.

```html
<script src="../../lib/app.js"></script>
<script src="./my-lesson.js"></script>
<script>LIB.App.run(window.LinearLessons.myLesson);</script>
```

### `lessons/<topic>/<name>.js`

A single IIFE that constructs the spec and registers it on the topic's
namespace. Top-level shape:

```js
(function () {

  // ---- module-level constants, helpers, renderer subroutines ----

  const SPEC = {
    id:       "stable-id",                  // used for any localStorage keys
    title:    "Title shown in header",
    subtitle: "short tagline",              // optional
    description: "<b>...</b>",              // HTML, rendered into a notes panel

    // -------- state --------
    // Factory called once at startup AND on Reset. Returns a plain object
    // containing every DOF + book-keeping field. The object identity is
    // preserved across resets (the shell mutates it in place), so any
    // closure that captured `state` keeps its reference.
    //
    // If spec.modes is set, the shell writes state.mode after the factory
    // runs — your factory does not need to set it.
    state: () => ({ /* x, v, theta, omega, lastTau, drag: null, t, ... */ }),

    onReset: (state) => { /* reset drag smoothers etc. — optional */ },

    // -------- sliders --------
    // Static form (single panel):       [ {key, label, ...}, ... ]
    // Static form (multiple panels):    { Drive: [...], Mechanism: [...] }
    // Dynamic form (recomputed on
    //   state.mode change OR a panel
    //   shape change):                  (state) => panelObj
    //
    // Per-panel dynamic widget lists (gear chains etc.):
    //   sliders: { Wheels: { kind: "dynamic",
    //                        items:   (state) => Array<sliderEntry[]>,
    //                        actions: [{ label: "+ Add", run: (s) => … }] } }
    sliders: {
      Drive: [
        { key: "xTarget", label: "x_tgt", min: -0.6, max: 0.6,
          step: 0.005, value: 0.30, tip: "..." },
        { key: "Tmax", label: "τ_max", min: 0.05, max: 50, step: 0.01,
          value: 2.0, log: true, tip: "..." },
        // ...
      ],
      Mechanism: [
        { key: "starts", label: "starts", min: 1, max: 6, step: 1, value: 1,
          onChange: (v, state) => { /* sync any closure-captured cache */ } },
        { key: "pitch", label: "pitch", min: 0.002, max: 0.10, step: 0.0005,
          value: 0.05, log: true,
          dynMin: () => /* runtime-computed floor */ 0.002 },
      ],
    },

    // -------- plots --------
    // Static array OR (state) => array.
    plots: [
      { title: "x(t) — load position (m)", yFmt: (v) => v.toFixed(2),
        series: [
          { label: "target", color: "#f6c945", lw: 1.4,
            source: (s, p) => p.xTarget },
          { label: "x", color: "#4ea1ff", lw: 2.2,
            source: (s)   => s.x },
        ] },
      // ...
    ],

    // -------- readouts --------
    // Static array OR (state) => array.
    readouts: [
      { label: "x", units: "m", value: (s, p) => s.x.toFixed(3) },
      { label: "Match M",
        value: (s, p) => {
          const M = /* compute */;
          return { text: M.toFixed(2),
                   color: LIB.MatchHint.color(M),
                   suffix: LIB.MatchHint.hint(M) };
        } },
    ],

    // -------- physics (declarative path) --------
    physics: {
      dof: ["x", "v", "theta", "omega"],
      dxdt:     (s, p, t) => ({ x: ..., v: ..., theta: ..., omega: ... }),
      jacobian: (s, p, t) => Float64Array,    // required for implicitEuler
      integrator: "implicitEuler",            // "rk4" | "rk45" | "siEuler" | "implicitEuler"
      preStep:  (s, p, dt) => { /* discrete updates BEFORE integration */ },
      postStep: (s, p, dt) => { /* discrete updates AFTER integration */ },
    },

    // -------- physics (imperative escape hatch — only if dxdt cannot fit) --------
    // physics: { step: (s, p, dt) => {
    //   /* author drives integration manually via LIB.Integrate.* */
    // } },

    // -------- modes axis (optional sub-tab strip below the header) --------
    // The shell renders a `.sub-tabs` strip with one button per entry in
    // `list`. The active id is written to `state.mode` and exposed as
    // `params.mode` each tick. State PERSISTS across mode switches —
    // spec.state() is NOT re-run. spec.sliders/plots/readouts can be
    // functions of state and will be re-evaluated on mode change.
    modes: {
      default: "lead",
      persistKey: "myspec-mode",          // optional localStorage
      list: [
        { id: "lead", label: "lead-screw" },
        { id: "ball", label: "ball-screw" },
      ],
      onChange: (state, newId, prevId) => { /* prep state for new mode */ },
    },

    // -------- rendering --------
    render: (ctx, layout, state, params) => {
      // layout = { W, H } in CSS pixels. Canvas is already DPR-fitted and
      // background-cleared. Use one of LIB.Layout.{linearTrack, world2D,
      // rotational} to get a world↔px transform.
    },

    // -------- pointer --------
    // type ∈ {"down", "move", "up", "leave", "cancel"}. mx/my are
    // canvas-relative CSS pixels.
    onPointer: (type, mx, my, layout, state, params) => { /* hit-test, drag */ },

    // -------- header buttons --------
    // The shell appends these after Reset/Pause and refreshes their
    // label/style each frame. label/style may be strings/objects or
    // (state, params) => string|object. Lessons that want a Drive
    // ON/OFF toggle build one via LIB.HeaderButtons.driveToggle()
    // (writes to state.driveOn — physics callbacks branch on that).
    headerButtons: [LIB.HeaderButtons.driveToggle()],

    // -------- timing --------
    physHz: 240,                           // default 240
    histRateHz: 60,                        // default 60
    histWindowS: 8,                        // default 8

    // -------- bootstrap --------
    init: (handle) => {
      // handle = { canvas, ctx, state, params, setMode(id),
      //            resetHistory, rebuildPanels, unmount }
      // Stash the canvas if your sliders need its dimensions (dynMin etc).
    },
  };

  (window.LinearLessons = window.LinearLessons || {}).myLesson = SPEC;
})();
```

### Conventions

- **DOF order matters** for the Jacobian: rows and columns both index into
  `physics.dof` in declared order.
- **Pre-step does discrete state**: latch transitions, PID integrator
  advancement, smoother bookkeeping (via `dragger.preStep` or
  `mux.preStep`). It must NOT mutate continuous DOF — that's the
  integrator's job.
- **Post-step does book-keeping**: thermal model step, exposing readout
  conveniences, anti-windup that the integrator doesn't enforce.
- **Stiff terms go through implicit**: contact springs (K ≥ 1e4), penalty
  springs for pointer drag, end-stop bumpers — all need
  `integrator: "implicitEuler"` plus a Jacobian. RK4 is fine for everything
  with no stiff coupling (single body, soft drag, gentle PID).
- **Free-form physics that don't fit**: use the imperative `step` escape
  hatch. Reserve it for genuinely complex multi-mode systems where
  branching inside dxdt would be worse.
- **No DOM access from spec callbacks** beyond what the shell hands you
  (`canvas` via `init`, `layout` via `render`/`onPointer`). If you need a
  CSS variable, use `LIB.Util.getVar("--accent")`.
- **Colors**: prefer the CSS custom-property tokens defined in
  `lib/shell.css` (`--accent`, `--good`, `--cP/I/D/U`, `--cRef`, `--cX`,
  `--cY`, `--w0…w7`). Lessons should look identical across the app.

## `LIB.Layout` — canvas world ↔ px transforms

Three named factories. Lessons pick one explicitly inside their renderer.
A polymorphic Layout type would carry dead fields for the modes that don't
apply (a rotational lesson has no `trackY`; a linear lesson has no
`polar`), so each is its own builder.

```js
LIB.Layout.linearTrack(W, H, { xMin, xMax, padX, padY, trackFrac })
  → { W, H, padX, padY, trackY, usableW, mToPx,
      xToPx(xm), pxToX(px), xMin, xMax }

LIB.Layout.world2D(W, H, { worldW?, worldH?, originX="center",
                           originY="center", padPx, maxScale? })
  → { W, H, originPx: {x, y}, scale,
      toPx({x, y}), toWorld({px, py}) }

LIB.Layout.rotational(W, H, { worldR?, originX="center", originY="center",
                              padPx, maxScale? })
  → { W, H, originPx: {x, y}, scale,
      toPx, toWorld, polar(r, theta), centerPx }
```

Pixel y increases downward (canvas convention). World y in `world2D` and
`rotational` uses the math convention (CCW from +x), so renderers using
these can write θ in the natural direction without sign juggling.

## `LIB.Drag` — pointer-drag helpers

Four flavours, all sharing a common shape:

```js
LIB.Drag.hbar({ kind, hitTest, worldX, bounds?, onSeedV?, windowSec? })
LIB.Drag.vbar({ kind, hitTest, worldY, onStart?, bounds?, onSeedV?, windowSec? })
LIB.Drag.point2d({ kind, hitTest, worldXY, bounds?, onSeedV?, windowSec? })
LIB.Drag.angular({ kind, hitTest, centerPx, thetaOf, onSeedW?, windowSec? })
LIB.Drag.mux([d1, d2, …])
```

Each dragger exposes:
- `handle(type, mx, my, layout, state, params) → bool` — wired into
  `spec.onPointer`. Returns true when the dragger consumed the event.
- `preStep(state, dt)` — called from `spec.physics.preStep` to push a
  smoother sample and refresh the velocity-equivalent.
- A spring helper (`spring1D`, `spring2D`, `springTheta`) that returns 0
  when the dragger isn't active, otherwise `−K·(current − target) − C·(currentVel − targetVel)`.
- `isActive(state)` and `target(state)`.

State convention — only one gesture runs at a time. The active dragger
writes `state.drag = { kind, …payload, smoother }`; sets it back to null
on up/leave/cancel. Lessons treat `state.drag` as opaque and read via
the dragger's spring helpers.

`vbar`'s `onStart(state, mx, my, layout, params) → { value, anchor }`
optional hook lets the lesson stash a grab-point anchor (e.g. `{my0,
theta0}`); `worldY` then receives that anchor on every move and computes
a delta-from-grab mapping (used for "drag the screw shaft up/down to
spin it"). Without `onStart` the mapping is purely absolute.

`mux` arbitrates: on pointerdown each dragger is offered the gesture in
order; the first whose `hitTest` passes captures. Subsequent move/up
events route to whichever dragger currently owns `state.drag`.

For implicit-Euler integration the lesson must include the spring's
sensitivities in its jacobian. The dragger doesn't write the jacobian —
it doesn't know the lesson's DOF layout. Pattern:

```js
const Kdrag = dragger.isActive(state) ? K_DRAG : 0;
const Cdrag = dragger.isActive(state) ? C_DRAG : 0;
// then add −Kdrag, −Cdrag to the relevant rows of M
```

## Verifying a new lesson

1. Run a server at the repo root: `python -m http.server 8765`.
2. Open `http://localhost:8765/lessons/<topic>/<name>.html` (or the topic
   `index.html` to verify it appears in the runTabs hub).
3. Check console — no errors, no warnings.
4. Confirm slider rows match the spec, plots render, readouts populate.
5. Toggle Drive (if applicable), watch the load actually move.
6. Vary every slider end to end — sim should remain stable. Step sizes
   that destabilise an integrator will manifest as state going to NaN
   (visible as `—` readouts or vanishing plot lines).
7. Drag whatever the lesson lets you drag (load box, shaft, pulleys, …).
8. If `spec.modes`, switch each mode and confirm sliders/plots/readouts
   rebuild and state persists across the switch.
9. Press Reset and confirm clean reinit (history clears, state zeroes,
   active mode is preserved).

