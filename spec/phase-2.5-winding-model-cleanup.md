# Phase 2.5 — Winding-model cleanup (foundation repair)

> Treated as expanded scope on **batch-6** (Phase 2 wave 2.3) because the visual ack
> for T2.3.2 cannot meaningfully pass until the cage representation is physically
> correct in the induction fixtures. Authorized by the user 2026-05-27 after surfacing
> the defects via the industrial-scale fixture rewrite.

## Motivation

Two architectural defects in `lib/winding-model.js` and `lessons/unified_motor/config-schema.js`
that I introduced in a prior session were hidden behind trivial fixtures (4-pole, 12-slot
across the board, 12 rotor bars). Surfaced now by the industrial-scale fixture rewrite in
batch-6.

1. **Squirrel cage encoded as a polyphase AC winding.**
   `config-schema.js` buckets `K` (cage) with `W` (wound) on lines 71/176/427/450/530/592/672.
   The cage's `winding: { standard: { m, p, Q } }` block goes through
   `LIB.WindingModel.standardWinding`, producing m fake "phases" each holding Q/(2pm) coils.
   A real cage is N bars short-circuited by end rings — no intrinsic m, no intrinsic p.
   Fixtures had to pick m=3, p=4, Q=12 or m=4, p=7, Q=28 to satisfy validator divisibility,
   not from physics. `ampereConductors(routing).nCircuits` then returns 3 or 4 "circuits"
   to the circuit layer for what should be N independent bar-loop circuits.

2. **Validator's `Q % (m·p) === 0` enforcement.**
   `lib/winding-model.js:199` rejects any (m, p, Q) where slots-per-pole-per-phase is
   non-integer. This is a real physical constraint for integer-slot distributed windings,
   but it prevents the user from constructing fractional-slot concentrated windings,
   prevents specifying broken combinations to learn from them, and forced the cage hack
   above (since the cage has no physical (m, p) the implementer had to pick numbers that
   happen to divide Q).

3. **`p` semantic ambiguity.**
   The winding-model's `standardWinding` reads `p` and computes `alpha = (p/2)·s·(2π/Q)`,
   so it expects `p = pole_count`. But the fixture authoring is inconsistent:
   PMSM has `poles=8, p=8` (pole count); BLDC has `poles=12, p=6` (pole pairs);
   wound-field-sync has `poles=8, p=4` (pole pairs). The formula gives integer q only
   when the authoring matches the model's expectation for that fixture — so the test bed
   has been silently mixing conventions, and any downstream consumer reading `p` gets
   either the pole count or half of it depending on the fixture.

## Scope of fix

### Lib (frozen EM set — unfreezing for these files)

- `lib/winding-model.js`
  - Remove the `Q % (m·p) === 0` hard rejection from `validate()`. Replace with a
    non-blocking informational return field (`{ ok, info: { qIsInteger, q } }`) so
    callers can warn at the UI layer but the engine still produces a winding for
    fractional q. If q is non-integer, `standardWinding` must still produce a
    well-defined (asymmetric, broken-symmetry) winding rather than throw.
  - Add `cageRouting({ bars, member, rRange, slotTheta })` returning a routing where
    each bar is a single-conductor circuit with `nCircuits = bars`. No phases, no
    pole pairs, no coilPitch.
  - Document `p` as pole-count, with assertion `p % 2 === 0` enforced in
    `standardWinding`. (The current code's `alpha = (p/2)·s·(2π/Q)` already assumes
    pole-count; the assertion makes the contract explicit.)

- `lib/em-physics.js`, `lib/excitation.js`, `lib/motor-circuit.js`, `lib/motor-run.js`,
  `lib/field-render.js` — unchanged. Cleanup is contained to `winding-model.js`.

### Lessons / fixtures (also unfreezing the 15 machines)

- `lessons/unified_motor/config-schema.js`
  - Add cage routing recognition: `if (ring.element === "K")` branches now build a
    cage routing via `LIB.WindingModel.cageRouting` instead of `standardWinding`.
  - Both validation and feature-building paths updated (lines 71, 176, 427, 450, 530,
    592, 672 — all 7 K/W bucket sites).

- `lessons/unified_motor/machines/induction-1ph.js`, `induction-3ph.js`
  - Rotor cage block changes from `winding: { standard: { m, p, Q, coilPitch, turns } }`
    to `cage: { bars: 28 }`.

- All 15 machine fixtures
  - Audit and normalize `p` field to **pole-count** wherever it's currently pole-pairs.
    Specifically: BLDC, hybrid-stepper (stator side), pm-stepper, wound-field-synchronous
    (stator side). Update fixture content so `winding.standard.p` always equals
    `rings[*].element-specific pole count`.

### Tests

- `tests/winding/winding-model.standardWinding.test.js`: add a fractional-q case
  proving `validate()` returns `ok: true, info: { qIsInteger: false }` and
  `standardWinding` produces a determinate routing (whose asymmetry is testable —
  e.g., phase A has more turns than phase B).

- `tests/winding/winding-model.cageRouting.test.js`: NEW. Asserts `cageRouting({ bars: 28 })`
  produces 28 single-bar circuits, no phase grouping, no coilPitch.

- `tests/pipeline/config-schema.test.js`: add an induction-3ph routing assertion that
  `expand()` produces `nCircuits === 28` (one per bar) at the cage feature, not 4 or 3.

- Existing tests: any that asserted `nCircuits === 3` or `=== 4` for a cage MUST be
  rewritten to assert `nCircuits === bars`. **NO threshold tweaking** to make the old
  assertions still pass — if a test breaks, it was testing the bug. Rewrite or delete.

### Spec invariant updates

- `spec/plan.md`: amend the "Preserved unchanged" list to remove `winding-model.js`,
  `config-schema.js`, and `machines/*.js`. Phase 8's `git diff motor-baseline` check
  must allow these files to differ.

## Acceptance

1. `lib/winding-model.js` no longer throws on non-integer q. A fractional-slot
   concentrated winding (e.g., 14p/12s/m=3) round-trips through validate + standardWinding
   and produces a routing.

2. `LIB.WindingModel.cageRouting({ bars: N })` exists and produces N independent
   bar-loop circuits.

3. `LIB.ConfigSchema.expand(induction-3ph.config)` produces
   `nCircuits === 28 + stator_circuits` (cage circuits + stator phases), not
   `4 + stator_circuits`.

4. The single `p` semantic — pole-count — is enforced in `standardWinding` via
   `assert(p % 2 === 0)`. All 15 fixtures audited so `winding.standard.p` is pole-count
   throughout.

5. All `tests/winding/`, `tests/pipeline/`, `tests/circuit/`, and `tests/mesh/` tests
   pass without softening. New cage and fractional-q tests added (above).

6. The mesh-dev.html visual ack walkthrough succeeds with the corrected fixtures.

## Out of scope

- Cage AC dynamics (slip frequency, rotor MMF Fourier decomposition) — that lives
  downstream in the circuit / motor-run layer and is a separate Phase 5 concern.
- Concentrated winding pattern generation for fractional q — `standardWinding` will
  produce an asymmetric distributed winding; a proper concentrated pattern is a
  separate task if anyone wants to add a `winding: { concentrated: {...} }` mode.
- Any change to `excitation.js`, `motor-circuit.js`, `motor-run.js`, `em-physics.js`.

## Strict rules for the implementer

- **NO threshold or tolerance softening** in any test to make assertions pass under
  the new model. Any failure that requires a tolerance change must `stop-for-clarification.sh`
  with the failure dump and the implementer's hypothesis about whether (a) it's a real
  bug in the new code, or (b) a test that was tuned to the broken behavior. Coordinator
  decides.
- **NO `// TODO`, `// for now`, or deferred-cleanup comments** in any file.
- **NO** silent `is-cage` shortcut by detecting "looks like a cage" in `standardWinding`.
  The cage path is an explicit different routing function (`cageRouting`).
