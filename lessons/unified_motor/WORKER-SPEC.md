# Unified-motor solver → Web Worker: full design spec

One job: move the numeric runtime off the render thread, decouple render cadence
from solve cadence, and interpolate the display between solve snapshots. This
spec is complete — command side, dynamic snapshot, static geometry, lowering,
lifecycle, interpolation, fallback, tests. No part is deferred; the
"implementation order" at the end is execution sequence only, every step
behaviour-preserving and testable.

## STATUS (implemented)

Shipped: `lib/snapshot-buffer.js` (buffer + interp), `lib/sim-source.js`
(`createInline` + `createWorker` with self-healing in-process fallback),
`lessons/unified_motor/sim-worker.js` (worker host), and the `mount.js` rewire
onto the SimSource + snapshot buffer + display proxy. Tests: snapshot-buffer (6),
sim-source contract (8), worker-glue via a fake worker (6); full suite green;
mount-smoke exercises the real runtime through the in-process source.

The worker is enabled by default in index.html (`USE_SIM_WORKER=true`) and
self-heals to in-process on construct/init/timeout failure. ONE item cannot be
verified headlessly (no Worker + WASM in node): the actual in-worker FeaSolver
init + first geometry over a live server. Needs a browser smoke — see BACKLOG
"Worker live-verify". Until then the in-process path (fully tested, delivers the
interpolation smoothing) is the guaranteed-correct fallback.

---

## 1. Principle & boundary

Cut the system in one place: **worker = sim core (all numeric); main thread =
view/UI (all DOM) + a smooth render clock that interpolates snapshots.**

Both sides talk only through a `SimSource` interface, with two implementations:

- `WorkerSimSource` — real `Worker`; production.
- `InlineSimSource` — same numeric core in-process; used by node tests (no
  `Worker`) and as the automatic fallback when `new Worker()` fails (`file://`).

`mount.js` depends on `SimSource` only; it never holds a raw runtime.

```
SimSource:
  post(cmd)                       // command down (see §6)
  onSnapshot(cb)                  // dynamic frame up (see §5)
  onGeometry(cb)                  // static geometry up, once per epoch (§4)
  onStatus(cb)                    // {behind, achievedRate} for the badge
  dispose()
```

`InlineSimSource.post` runs synchronously and fires callbacks inline;
`WorkerSimSource.post` is `postMessage`. Same contract, so `mount.js` has one
code path.

---

## 2. Ownership map (derived from the runtime inventory)

Worker owns (moves off main thread):
- `LIB.MotorRun.create` + `runtime` (mount.js:192,475), `runtime.step`,
  `runtime.reset` (mount.js:588), `runtime.lastSolve`, `runtime.state`,
  `runtime.circuits`, `runtime.mechanical`, `runtime.stack`.
- Schematic **lowering** (`applyToRuntime`, schematic-panel.js:135-164) —
  because it reads live `runtime.state.omega` (:150) and mutates
  `runtime.circuits` in place (:145-147,156-158).

Main thread keeps:
- All DOM/panels/sliders/readouts/plots/canvases, camera, pointer handlers.
- `config` (source of truth for edits) and `expanded = expand(config)`.
- The **static geometry** shipped up per epoch (§4).
- The snapshot buffer + `simClock` + interpolation + the display-runtime proxy
  the renderers read (§7).
- Schematic **editing** (the DOM editor in schematic-panel.js); only the
  lowering call is delegated to the worker.

---

## 3. Serialization split (the decisive facts)

- **Static, ship once per epoch:** per-slice `{rotor, stator}` body meshes
  (motor-stack.js:439-441) + `expanded` + `nCircuits`. Plain data; renderers only
  pass meshes to pure fns (`maxNodeRadius`, `MMV.resampleField/drawSaturation`,
  `CSP.draw*`) and read `mesh.gapLoop/gapR/nodes` — no methods invoked. Clonable.
- **Dynamic, stream per solve:** flat numerics only —
  `t, theta, omega, i[Float64], torque, fluxLinkages[Float64]`, and per slice
  `{ Anode_r, Belem_r{mag,Bx,By}, Anode_s, Belem_s{mag,Bx,By}, gapPhi }`
  (motor-slice.js:1705-1709 are the source arrays). Cheap; `Transferable` if ever
  needed. **A snapshot is a deep copy of every dynamic array** — verified
  necessary: `state.i` is a persistent `Float64Array` overwritten in place each
  step (motor-run.js:64-67 alloc, :231 in-place write), and `Anode`/`Belem` point
  at reused scratch buffers (motor-slice.js:1705-1709 scratch, :1748 aliased into
  the field bundle) overwritten on the next solve. `fluxLinkages` is fresh per
  `fieldBundle` (motor-stack.js:392) so reference-safe, but copied for uniformity;
  scalars are values. `WorkerSimSource` gets the copy free via structured clone;
  `InlineSimSource` copies explicitly at snapshot construction.

Geometry crosses the boundary **once per rebuild**; only numbers stream per
solve. The main thread reassembles the render's `perSliceField[k]` each frame
from cached meshes + streamed arrays (this IS the display proxy, §7).

---

## 4. Static geometry message (worker → main, once per epoch)

```
{ type:"geometry", epoch,
  nCircuits,
  slices: [ { rotor: BodyMesh, stator: BodyMesh }, ... ]   // sliceMesh(k) per k
}
```
`epoch` increments on every init/rebuild. Main thread caches
`geometry[epoch]`, drops snapshots whose epoch ≠ current (staleness guard, §9).

`BodyMesh` is verified clone-safe: it is pure typed-array/number data
(`nodes:Float64Array, elems:Int32Array, srcId:Int32Array, gapLoop:Int32Array,
gapTheta:Float64Array, gapR:number, …`; motor-mesh.js:1375-1407) consumed only by
pure functions — no methods, so structured clone carries it intact.

`expanded` is **not shipped** — both sides call the pure `expand(config)` on the
same `config` (the only structural payload, itself plain persisted-JSON data), so
they are identical by construction. Shipping meshes (rather than rebuilding them
main-side) guarantees the streamed `Anode`/`Belem` indices align with the mesh
the worker solved on, without relying on deterministic mesh-ordering reproduction.

---

## 5. Dynamic snapshot message (worker → main, per solve)

```
{ type:"snapshot", epoch,
  t, theta, omega,
  i:            Float64Array,             // per circuit
  torque:       number,
  fluxLinkages: Float64Array,             // per circuit
  slices: [ { AnodeR, BmagR, BxR, ByR,    // per slice, flat Float64Array
              AnodeS, BmagS, BxS, ByS,
              gapPhi: number }, ... ]
}
```
Reassembled main-side into the shape renderers expect:
`perSliceField[k] = { rotor:{ mesh:geom.slices[k].rotor, Anode:AnodeR,
Belem:{mag:BmagR,Bx:BxR,By:ByR} }, stator:{…}, gap:{ phi:gapPhi } }`.

---

## 6. Command protocol (main → worker)

| Command | Payload | Effect | Replaces |
|---|---|---|---|
| `init` | `{config}` | build runtime; emit `geometry`(epoch); start paced loop | mount.js:192 |
| `rebuild` | `{config}` | bump epoch; rebuild runtime; emit `geometry`; clear | mount.js:470-480 |
| `reset` | — | `runtime.reset()`; reseed t=0 | mount.js:588 |
| `mechanical` | `{loadTorque?, damping?}` | mutate `runtime.mechanical` | mount.js:378,380 |
| `drive` | `{amp?, freq?}` | set every `circuit.terminal` field | mount.js:374,376 |
| `schematic` | `{schematic}` | worker runs `applyToRuntime` vs its live `omega` | schematic-panel.js:366,394,415,526 |
| `pace` | `{simClock, leadCap, speed, paused}` | set free-run target (§8); sent every frame | new |

**Decision — omega/lowering:** worker-side. The pure lowering
(`lower`/`switchState`/`deepCopyCircuits`) is extracted from schematic-panel.js
into `lib/schematic-lower.js` and `importScripts`-ed by the worker. On a
`schematic` command the worker runs the lowering against its own
`runtime.circuits` + live `runtime.state.omega`, so switch resolution uses the
real current speed — no stale mirror, and the only synchronous dynamic-state
read is removed from the UI. `schematic._loweredBase` caching moves worker-side
(keyed per epoch). The main thread keeps only the DOM editor.

`requestRenderUpdate` (alpha-only, mount.js:487) stays **main-thread** — it
re-expands for the renderer and never touches the runtime, so it needs no
command.

**Status caveat — the `schematic` command is designed, not yet load-bearing.**
The schematic panel is currently dead code (not script-loaded; registers a
`zone:"side"` the mount doesn't render — see BACKLOG). So it exercises none of
these runtime writes today. The `schematic` command + `schematic-lower.js`
extraction is the correct shape for when the panel is wired up, but it is NOT
part of the worker hoist's must-preserve scope. The live command surface today
is only: `mechanical` (loadTorque/damping), `drive` (amp/freq), `rebuild`
(machine picker + geometry panel), `reset`, `pace`.

---

## 7. Render side: buffer, interpolation, display proxy

`SnapshotBuffer` (pure, unit-tested, `lib/` or UM module):
- `push(snap)`, `clear()`, prune to snapshots still needed to bracket `simClock`.
- `bracket(t) → {A, B, f}` where `A.t ≤ t ≤ B.t`, `f=(t−A.t)/(B.t−A.t)`; clamps
  to ends when `t` is outside the buffer.

Per frame (§8 drives `simClock`), compute `tShow = min(simClock, latest.t)`, then
build the **display runtime** (a single persistent object — stable identity, see
below) by interpolating the bracket:
- `theta, omega, i[k]` — linear lerp.
- `perSliceField[k].gap.phi` — linear lerp (this is the displayed rotor angle:
  render3d.js:838, cross-section-render.js:137).
- `perSliceField[k]` field arrays (`Anode/Belem`) — **default nearest snapshot**
  (`f<0.5?A:B`); a lerp path exists behind a flag (§11).
- `torque, fluxLinkages[k]` — lerp (readouts/plots).

Display runtime shape: `{ stack:<epoch geometry>, state:{theta,omega,i,t},
lastSolve:{torque,fluxLinkages,perSliceField} }`, handed to renderers via
`buildCtx()` with `.runtime` overridden (mount.js:491-501; both renderers read
`mountCtx.runtime`, cross-section-render.js:322, render3d.js:562). Renderers are
**unchanged**.

**Stable identity:** the display runtime is created once per epoch and its nested
fields are updated in place each frame (not reallocated), because
`advanceDots` keys its reset on `_dotRt !== runtime` identity + `t < _dotT`
(render3d.js:541). Per-epoch stable identity + monotone `tShow` preserves dot
behaviour; on reset/rebuild the identity refresh + `t` reset re-zeroes dots.

`state.i` and the per-slice arrays are persistent typed arrays (allocated per
epoch, length from `nCircuits`/mesh sizes), written in place each frame.

Plot: push one sample per frame at `tShow` using the interpolated values, so the
trace and the fixed window `[tShow − W_sim, tShow]` scroll together.

---

## 8. Pacing / free-run-to-lead / backlog

Main thread, each frame: `simClock += speed·dtFrame`; `post({pace, simClock,
leadCap, speed, paused})`.

Worker: holds `target = simClock + leadCap`. A yielding loop (`setTimeout(0)` /
`queueMicrotask`) solves one step while `!paused && runtime.t < target`, posting
a snapshot after each; stops when caught up; each `pace` re-arms it. Yielding
between solves keeps `param/schematic/rebuild` responsive. `leadCap` ≈ a couple
frames of ordered sim-time (≥ `dtMax`) so a bracket ahead of `simClock` always
exists.

Backlog clamp (main thread): if `simClock − latest.t > CLAMP` the worker can't
sustain the ordered rate → `simClock = latest.t` (drop backlog, no catch-up
burst) and `onStatus({behind:true, achievedRate})` drives the existing
"playing N× · ordered M×" badge.

This removes both defects: overshoot/freeze (interp) and the atomic-solve
main-thread hitch (solve is off-thread).

---

## 9. Lifecycle & staleness

- **init:** `post(init,config)` → await `geometry(epoch0)` → seed buffer with the
  first snapshot → start rAF.
- **rebuild** (mount.js:470): normalize (main) → `post(rebuild,config)` → on
  `geometry(epoch+1)`: swap cached geometry, reallocate display arrays, clear
  buffer, reseed `simClock`, rebuild readouts if `nCircuits` changed.
- **reset:** `post(reset)` → clear buffer, `simClock=0`.
- **pause:** `post(pace,{paused:true})`; `simClock` holds; buffer holds.
- **staleness:** every snapshot carries `epoch`; the main thread drops any whose
  epoch ≠ current, so in-flight snapshots from before a rebuild can't paint onto
  new geometry.

---

## 10. Numeric core & worker bootstrap

`motor-run.js` and all numeric libs are **unchanged** — proven headless by the
423 node tests, which is also why worker portability is already established. The
worker `importScripts` the same set the node tests load (util, integrate/bdf,
motor-slice, motor-stack, gap-eval, em-physics deps, config-schema, motor-run) +
the extracted `schematic-lower.js`. `sim-worker.js` is a thin adapter:
`onmessage` → command dispatch → runtime calls → `postMessage` snapshots.

---

## 11. Overlay interpolation (the field arrays)

Streaming `Anode/Belem` per solve makes overlay interpolation a **dial, not an
architectural limit** — the arrays are present on both bracket snapshots, so a
per-cell lerp is available. Decision: ship with **gap.phi + kinematics
interpolated** (rotor and dots glide) and **field magnitudes nearest-snapshot**,
then MEASURE whether magnitude-stepping is perceptible against the smooth rotor.
If it is, enable the array lerp (bounded per-frame cost: a few `Float64Array`
lerps per visible slice). No claim that overlays "can't" interpolate — they can;
we choose the cheapest level that looks right, with evidence.

(Note: today the only gap field overlay barely renders — see BACKLOG "cross-gap
flux lines" — so the practical stepping surface is small.)

---

## 12. Testing

- Numeric core: unchanged → 423 stay green by construction.
- `SnapshotBuffer` + interpolation: pure unit tests (bracket correctness, clamp
  to ends, gap.phi override, below-ordered clamp).
- `InlineSimSource`: unit test the full command/snapshot/geometry contract with a
  canned config (init→geometry, pace→snapshots, rebuild→epoch bump+stale drop,
  schematic→circuit mutation via extracted lowering).
- `schematic-lower.js`: port the existing lowering assertions to the extracted
  module (behaviour identical).
- mount-smoke: runs on `InlineSimSource` (node has no `Worker`).
- Agnosticism audit: no machine tokens in the new files.

## 13. New / changed files

New: `lib/sim-source.js` (interface + Inline + Worker), `lessons/unified_motor/
sim-worker.js`, `lib/schematic-lower.js` (extracted), `lib/snapshot-buffer.js`
(+ interp). Changed: `mount.js` (SimSource + buffer + interp + display proxy +
commands), `schematic-panel.js` (delegate lowering to the command; keep editor),
the two lesson HTMLs (+ index) to load the new scripts.

## 14. Verified facts (no open build-time checks)

- **Meshes are clone-safe.** `BodyMesh` is pure typed-array/number data
  (motor-mesh.js:1375-1407, `emptyBodyMesh`/`buildBodyMesh` returns); renderers
  and MMV/CSP only index its arrays, never call methods. Structured clone carries
  it intact. → ship meshes once per epoch (§4).
- **Snapshot must deep-copy dynamic arrays.** `state.i` is overwritten in place
  each step (motor-run.js:64-67, :231); `Anode`/`Belem` alias reused scratch
  (motor-slice.js:1705-1709, :1748). `fluxLinkages` is fresh per solve
  (motor-stack.js:392) but copied for uniformity. → snapshot owns its data (§5).
- **`config` is plain persisted-JSON data** (localStorage-persistable), so the
  only structural payload down (`init`/`rebuild`) is clone-safe; `expanded` is
  recomputed each side, not shipped (§4).
- **`file://` fallback:** `WorkerSimSource` construction is wrapped in try/catch →
  `InlineSimSource` (degrades to the single-thread atomic-solve hitch, still
  correct). This app is already served over HTTP, so the worker path is the
  normal one.

## 15. Implementation order (execution only — all of §1-14 is in scope)

1. `snapshot-buffer.js` + interp + tests (pure).
2. `sim-source.js` with `InlineSimSource` + tests (contract locked).
3. Rewire `mount.js` onto `InlineSimSource` + buffer + interp + display proxy +
   commands; extract `schematic-lower.js`; delegate lowering. Green on 423 +
   smoke. (Behaviour: interpolated, single-thread.)
4. Add `WorkerSimSource` + `sim-worker.js`; flip `mount.js` to prefer Worker with
   Inline fallback. Green. (Behaviour: off-thread.)

Each step is independently verifiable; none postpones a design decision — the
decisions (worker-side lowering, ship-once geometry, stream-numbers snapshot,
interpolation dial) are fixed here.
