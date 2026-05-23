# Spec Review: Phase 9 — saturation-and-render-polish

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 4 | 4 |
| minor    | 0 | 3 | 3 |
| info     | 1 | 0 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 9.1.1 — `airgap-nonlinear.js` per-cell ν(B) SolveBackend | yes | Fully detailed with signatures, algorithm steps, acceptance criteria |
| 9.1.2 — saturation tests + worker-tier wiring check | yes | Three test files specified with exact assertion text |
| 9.2.1 — `render3d.js` polished 3D rig | yes | API fully specified; paint browser-verified |
| 9.2.2 — render test suite + index.html wiring + browser verification | yes | Tests, HTML modification, and user-required checklist all present |
| Phase 9 plan verification: "Live global ceiling flattens torque past the iron knee on every config" | yes | Addressed by `live-ceiling.test.js` in T9.1.2 |
| Phase 9 plan verification: "Detailed nonlinear solve resolves the SRM aligned-vs-unaligned differential and tooth-tip saturation" | yes | Addressed by `srm-differential.test.js` in T9.1.2 |

---

## Findings

### Mechanical Fixes

None found.

---

### Decision-Required Items

#### D1 — `extrudeAnnulus` returns identical `front` and `outerWall` rings (major)

- **Location**: Phase 9 §Task 9.2.1 "Files to create" — `Render3D.extrudeAnnulus` definition
- **Problem**: The spec defines:
  > `front = ringCircle(rOuter, z0, nAz)`, `back = ringCircle(rOuter, z1, nAz)`,
  > `innerWall = ringCircle(rInner, z0, nAz)`, `outerWall = ringCircle(rOuter, z0, nAz)`

  Both `front` and `outerWall` are `ringCircle(rOuter, z0, nAz)` — identical rings. The description calls the result "four ring polylines: front/back faces at z0/z1, the inner/outer cylinders at rInner/rOuter" but the definition gives only single rings at z0 for both walls, so neither wall spans z0→z1. The `paint` method in T9.2.1 passes these to `LIB.CoilRender.drawConductor3D` to draw iron-body annuli — it is unspecified how a renderer is supposed to draw a cylinder from two rings at the same z.

  The acceptance criterion in T9.2.1 says `extrudeAnnulus(…)` returns `innerWall`/`outerWall` at `rInner`/`rOuter` each of length `nAz` — which matches any of the options below. The test in T9.2.2 does not verify the z-coordinates of `innerWall`/`outerWall`. An implementer cannot determine the intended geometry.
- **Why decision-required**: At least three meaningfully different geometries are plausible, and the fix changes the rendering output. The spec text is internally inconsistent (description vs. definition), and the tests do not constrain the z-values of the walls.
- **Options**:
  - **Option A — outerWall at z1 (back face ring)**: Change `outerWall = ringCircle(rOuter, z1, nAz)` so `front` is the outer ring at `z0`, `back` is the outer ring at `z1`, `innerWall` is the inner ring at `z0`, and `outerWall` is the outer ring at `z1`. The four rings give front/back faces and two "end rings" of the inner/outer cylinders. `paint` would have to interpolate or use line segments between pairs.
    - Pros: Avoids the duplicate; four distinct rings; symmetric naming (innerWall ~ front face inner edge, outerWall ~ back face outer edge).
    - Cons: Still does not produce full cylindrical walls — just end rings. `paint` still lacks instructions for drawing the barrel of the cylinder.
  - **Option B — each wall is a 2-element polyline `[z0-ring, z1-ring]`**: Change the return type so `innerWall = [ringCircle(rInner, z0, nAz), ringCircle(rInner, z1, nAz)]` and `outerWall = [ringCircle(rOuter, z0, nAz), ringCircle(rOuter, z1, nAz)]`. These are cylindrical strips that `drawConductor3D` can render.
    - Pros: Matches the word "wall" — a wall spans z; gives `paint` enough data to render iron-body barrels.
    - Cons: Changes the return type (each wall is now an array of two rings, not a flat ring); acceptance criteria and tests must be updated to match; more significant spec revision.
  - **Option C — remove `outerWall` (three-ring return)**: Remove `outerWall` entirely; the outer face is already `front` and `back`. Return `{ front, back, innerWall }`. `paint` renders the outer cylinder by connecting `front` to `back` as a strip.
    - Pros: Eliminates the duplicate without adding complexity; naming is unambiguous.
    - Cons: Breaks the named return shape (callers expecting `outerWall` fail); `paint` description must be updated; `extrudeAnnulus` name becomes slightly misleading.

---

#### D2 — `Float64Array([…])` constructor call is invalid JavaScript (major)

- **Location**: Phase 9 §Task 9.1.2 "Files to create" — `tests/saturation/airgap-nonlinear.test.js`, test `"below the knee the nonlinear solve equals the refined linear solve"` and `"past the knee per-cell saturation lowers iron Bpeak"`
- **Problem**: The spec writes:
  > `Jz = compiled.assembleJz(Float64Array([2,0,0]))` (small)
  > `Jz = compiled.assembleJz(Float64Array([400,0,0]))` (large)

  `Float64Array([2,0,0])` is not valid JavaScript. `Float64Array` called as a function without `new` throws a `TypeError`. The correct forms are `new Float64Array([2,0,0])` or `Float64Array.from([2,0,0])`. Later in the same task, the spec correctly writes `Float64Array.from(cur)`. If an implementer copies the spec literally, the tests will throw at runtime, not fail gracefully.
- **Why decision-required**: Two syntactically correct alternatives exist; neither is obviously preferable from context, and the choice must be consistent with however Phase 2's `assembleJz` is documented elsewhere.
- **Options**:
  - **Option A — `new Float64Array([…])`**: Replace both occurrences with `new Float64Array([2,0,0])` and `new Float64Array([400,0,0])`.
    - Pros: Standard constructor form; universally understood.
    - Cons: Slightly more verbose.
  - **Option B — `Float64Array.from([…])`**: Replace both with `Float64Array.from([2,0,0])` and `Float64Array.from([400,0,0])`.
    - Pros: Consistent with the `Float64Array.from(cur)` already in the same test.
    - Cons: `Float64Array.from` is slightly less idiomatic for a literal.

---

#### D3 — `perSliceField[0].satScale` interface undefined (major)

- **Location**: Phase 9 §Task 9.1.2 "Files to create" — `tests/saturation/live-ceiling.test.js`
- **Problem**: The spec writes:
  > `ceil.solve(0.2, curK(i2)).perSliceField[0].satScale > 1` (the `field.satScale` exposed by `motor-slice.solve` — the ceiling flattens torque past the knee on every config)

  Neither Phase 1 (Task 1.3.1 — the Live global ceiling), nor Phase 5 (Task 5.1.2 — `motor-slice.js`) specifies that `motor-slice.solve` (or `motor-stack.solve`) returns a `perSliceField` property, or that this property carries a `satScale` field. The plan says the ceiling is "one scalar ν scaling from the B–H knee" but does not define what `solve` returns beyond `torque`, `fluxLinkages`, and `field`. An implementer of Task 9.1.2 (and the Phase 5 implementer) cannot know what shape the return value must have.
- **Why decision-required**: This is a cross-phase interface that touches both Phase 1/5 and Phase 9. The fix requires deciding: (a) what `motor-stack.solve` returns, (b) whether `perSliceField` is an array of per-slice solve results, and (c) how `satScale` (a field from the nonlinear backend's `solveNonlinear` return) propagates to the Live global ceiling result. Multiple interface designs are viable.
- **Options**:
  - **Option A — define `perSliceField` in Phase 5's spec**: Add to Phase 5 Task 5.1.2 that `motor-stack.solve` returns `{ torque, fluxLinkages, field, perSliceField: [{ satScale, field }] }` where `satScale = 1` when the global ceiling is inactive and `satScale > 1` when it clamps. Update Phase 9's spec to reference this Phase-5 interface.
    - Pros: Interface is defined at the source (Phase 5); Phase 9 is just a consumer.
    - Cons: Requires editing Phase 5's spec; Phase 5 must be amended before Phase 9 can be implemented.
  - **Option B — define a lighter test-access path**: Replace the `perSliceField[0].satScale` assertion with a different observable — e.g., assert `ceil.solve(0.2, curK(i2)).satClamped === true` (a top-level boolean on the stack result) or expose `satScale` directly on the stack-level result. Define this interface in the Phase 9 spec itself (as a Phase-1/5 amendment note, mirroring how Phase 9 already amends earlier phases for `getReluctivity` and `registerRender3D`).
    - Pros: Does not require opening Phase 5's spec file separately; the amendment pattern is already established in Phase 9.
    - Cons: A flat `satClamped` boolean loses the per-slice resolution the spec may have intended.
  - **Option C — remove the `satScale` observable assertion**: Replace with an indirect assertion — e.g., `assert Math.abs(Tc2) < Math.abs(Tn2)` already in the spec is sufficient to prove the ceiling flattens torque. Drop the `perSliceField[0].satScale` assertion entirely.
    - Pros: No new interface needed; the ceiling effect is still asserted via the torque comparison.
    - Cons: Weaker test — does not confirm the ceiling *mechanism* triggered, only the effect.

---

#### D4 — `thPk` sweep resolution unspecified in tooth-tip rolloff test (minor)

- **Location**: Phase 9 §Task 9.1.2 "Files to create" — `tests/saturation/srm-differential.test.js`, test `"tooth-tip saturation rolls torque off below the unsaturated square law"`
- **Problem**: The spec writes:
  > "at the angle `thPk` maximising `|nlS.solve(θ, Float64Array([i2,0,0])).torque|` over `[thUnalign, thAlign]`"

  The spec does not state how many angle points to sweep, what step size to use, or what tolerance the "maximising" search must meet. An implementer must choose (e.g., 16 points, 64 points, a golden-section search) and different choices produce different `thPk` values and thus different `T1`/`T2` values. The assertion `Math.abs(T2) < 0.9·(i2/i1)²·Math.abs(T1)` has a fixed 10% margin, so a coarse sweep finding only an approximate `thPk` might accidentally pass or fail.
- **Why decision-required**: The resolution needed depends on the SRM fixture's torque-angle profile sharpness (unknown until Phase 6 is implemented); the spec author must decide between a deterministic closed-form approach (e.g., `n = 32` uniform samples) or a coarser bound.
- **Options**:
  - **Option A — specify a fixed uniform sample count**: Add e.g. `thPk = argmax over n=32 uniform samples in [thUnalign, thAlign]`.
    - Pros: Deterministic; reproducible across implementers.
    - Cons: 32 samples may miss a sharp peak; the 10% margin in the assertion may need widening.
  - **Option B — specify tolerance on the search**: Add "find `thPk` to within `(thAlign−thUnalign)/64` using any search strategy".
    - Pros: Allows implementer to choose strategy while bounding the error.
    - Cons: "Any search strategy" re-introduces implementer discretion.
  - **Option C — replace the search with `alignedUnaligned`**: Use `thPk = thAlign` (the aligned position already computed by `alignedUnaligned`) as a proxy for the peak torque angle, since the SRM produces peak torque near the aligned position for unidirectional excitation.
    - Pros: Uses an already-computed value; no new sweep needed; deterministic.
    - Cons: `thAlign` is the inductance maximum, not necessarily the torque maximum; for a 3-phase SRM they may differ.

---

#### D5 — Hardcoded `r.field.Br.length === 16*128` conflicts with stated grid defaults (minor)

- **Location**: Phase 9 §Task 9.1.2 "Files to create" — `tests/saturation/airgap-nonlinear.test.js`, test `"backend honours the SolveBackend contract through MotorSlice"`
- **Problem**: The spec asserts:
  > `r.field.Br.length === 16*128`

  using `be = LIB.AirgapNonlinear.backend({ factor:2 })` and `coggingConfig()`. The plan (Phase 1, Task 1.2.1) states default grid dimensions `Nθ=256, Nr=12`. With `factor:2`, the refined grid would have `Nr=24, Ntheta=512`, giving `Br.length = 24*512 = 12288`, not `16*128 = 2048`. The value `16*128` is only consistent with a base grid of `Nr=8, Ntheta=64`, which would require `coggingConfig()` to specify those non-default dimensions. The spec does not define `coggingConfig`'s grid parameters (it is re-exported from Phase 8 without defining its contents here).
- **Why decision-required**: Either `coggingConfig` has non-default grid dimensions that the Phase 9 spec should state, or the constant `16*128` is wrong and the correct value must be derived from the actual grid. The fix requires knowing `coggingConfig`'s grid spec (from Phase 8) and the computed refined dimensions.
- **Options**:
  - **Option A — state `coggingConfig`'s base-grid dimensions explicitly**: Add to Task 9.1.2 that `coggingConfig()` uses `Nθ=64, Nr=8` (or whatever Phase 8 defines), making `16*128 = 2048` derivable. Add a comment in the test: `// coggingConfig base grid: Nr=8, Ntheta=64; factor:2 → Nr=16, Ntheta=128`.
    - Pros: Makes the assertion self-documenting; implementer can verify correctness.
    - Cons: Requires checking Phase 8's spec for the exact value and propagating it.
  - **Option B — replace the magic constant with a derived expression**: Write `r.field.Br.length === refinedNr * refinedNtheta` where `refinedNr` and `refinedNtheta` are computed from `expand(coggingConfig()).slices[0].section.grid` and the `factor`. This makes the assertion robust to any base-grid choice.
    - Pros: Self-adapts to whatever `coggingConfig` defines; no magic number.
    - Cons: More verbose; the test now implicitly tests the grid-sizing logic, not just that a finite field is returned.

---

#### D6 — `coggingConfig` not defined in Phase 9 scope (minor)

- **Location**: Phase 9 §Task 9.1.2 "Files to create" — `tests/saturation/_fixtures.js` exports section
- **Problem**: The spec exports `coggingConfig` via:
  > `coggingConfig` (re-exported [from `D.coggingConfig`, the Phase 8 `detailed/_fixtures.js`])

  The spec re-exports `coggingConfig` but never defines what it is — what machine type, grid dimensions, number of circuits, or cogging profile. Phase 8's spec is not in scope for this review. Multiple tests in Task 9.1.2 rely on `coggingConfig` — notably the `"backend honours the SolveBackend contract through MotorSlice"` test which calls `expand(coggingConfig()).slices[0].section` and asserts a specific `Br.length`. An implementer of Phase 9 who has not read Phase 8's spec cannot verify correctness of tests that depend on `coggingConfig`'s properties.
- **Why decision-required**: The Phase 9 spec should either (a) state the required properties of `coggingConfig` (number of circuits, grid, a PM or cogging-capable configuration) or (b) replace `coggingConfig` with a self-contained fixture defined inline. The choice affects what Phase 8 must guarantee.
- **Options**:
  - **Option A — state the required properties inline**: Add to `_fixtures.js` a comment enumerating what Phase 9 needs from `coggingConfig`: "a PM or reluctance config with iron, at least 1 circuit, base grid `Nr×Nθ` as defined in Phase 8 (e.g. `Nr=8, Ntheta=64`)".
    - Pros: Phase 9 remains coupled to Phase 8's fixture (as intended); Phase 9 implementer knows what to expect.
    - Cons: Creates a soft dependency on Phase 8's internal fixture definition; Phase 8 changes break Phase 9 silently.
  - **Option B — define a minimal `coggingConfig` inline in Phase 9's `_fixtures.js`**: Instead of re-exporting from Phase 8, define a minimal PM config with iron and a coarse grid directly in `tests/saturation/_fixtures.js`. Reference Phase 8's `coggingConfig` only for Phase-8 tests.
    - Pros: Phase 9 tests are self-contained; the grid dimensions and machine properties are fully specified here.
    - Cons: Duplicates config with Phase 8; the Phase 9 fixture may diverge from Phase 8's definition if both phases are implemented independently.

---

#### D7 — `info`: `wiring.test.js` marker-comment strings are not specified exactly (info)

- **Location**: Phase 9 §Task 9.2.2 "Files to create" — `tests/render/wiring.test.js`
- **Problem**: The test `"index.html loads render3d.js inside the marked region"` locates content:
  > "between `<!-- unified-motor modules:` and `<!-- /unified-motor modules -->`"

  Phase 5 creates `index.html` with "a comment-marked module extension region". The exact marker strings are not specified in Phase 5's plan entry (only described as "comment-marked"). Phase 9 specifies them as `<!-- unified-motor modules:` (open) and `<!-- /unified-motor modules -->` (close). If Phase 5's actual markers differ (e.g. `<!-- BEGIN unified-motor modules -->` / `<!-- END unified-motor modules -->`), the `wiring.test.js` assertions will fail with no code-level error — just a failing test.
- **Why classified as info**: The exact marker strings are also used in Task 9.2.2's "Files to modify" instruction (`"between the <!-- unified-motor modules: later phases append … --> and <!-- /unified-motor modules --> markers, created by Phase 5"`), so Phase 9 is internally consistent — both the test and the modification instruction use the same strings. The risk is only if Phase 5's spec uses different marker strings. This is a cross-phase consistency concern, not a Phase 9 internal defect.
- **Proposed observation**: Verify that Phase 5's spec file (`spec/phase-5-agnostic-pipeline.md`) specifies these exact marker strings. If it does, this is a non-issue. If not, Phase 5's spec should be amended to pin the marker strings to match Phase 9's expectation.
