"use strict";

// =============================================================================
// DEAD-CODE STUB — installs window.LIB.MotorStack namespace only.
//
// Reason this file exists at all:
//   tests/pipeline/_fixtures.js requires this path unconditionally to populate
//   the LIB.MotorStack namespace. Without the require succeeding, ALL machine
//   tests fail at module-load time (Cannot find module) and we lose the
//   ~15 validate()-step tests that don't need a real implementation.
//
// What's missing:
//   The real MotorStack.create() needs LIB.MotorSlice.create(), which is a
//   Phase 5 wave 5.1 deliverable that hasn't shipped yet. The stub below
//   throws if called, with a clear message, so any caller that actually needs
//   functionality (the build()-step tests in tests/machines/*) fails loudly
//   instead of silently producing wrong output.
//
// What to do when Phase 5 wave 5.1 lands MotorSlice:
//   This file should be rewritten with a real LIB.MotorStack.create() per
//   spec/phase-5-fea-slice.md (Files Owned list names motor-stack.js as a
//   Phase 5 Wave 5.3 deliverable). At that point: rewrite or delete and
//   re-point tests/pipeline/_fixtures.js accordingly. If this comment still
//   stands after Phase 5 is complete, that's a bug.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function create() {
    throw new Error(
      "LIB.MotorStack.create: stub only. Pending Phase 5 wave 5.1 (MotorSlice). " +
      "See lib/motor-stack.js header comment."
    );
  }

  LIB.MotorStack = { create };
})();
