"use strict";

const { describe, it } = require("node:test");
const assert            = require("node:assert/strict");
const path              = require("node:path");
const { execFileSync }  = require("node:child_process");

const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/agnosticism-audit.js");

// ---------------------------------------------------------------------------
//  Load the module once. Each test that needs it reads from this reference.
//  The import must be side-effect-free (no DOM access, no file reads).
// ---------------------------------------------------------------------------
let audit;

describe("agnosticism-audit", function () {

  it("module import is side-effect-free and DOM-free", function () {
    globalThis.document = undefined;
    let threw = false;
    try {
      audit = require(SCRIPT_PATH);
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, false, "require must not throw");
    assert.strictEqual(typeof audit.run,          "function");
    assert.strictEqual(typeof audit.scanForNames, "function");
  });

  it("scanForNames flags a type token", function () {
    const result = audit.scanForNames("const k = makeStepper();", "x.js");
    assert.ok(result.length > 0, "expected at least one violation");
    assert.strictEqual(result[0].check, "name");
    assert.ok(result[0].detail.includes("stepper"), "detail must mention stepper, got: " + result[0].detail);
  });

  it("scanForNames flags a quoted machine id", function () {
    const withQuoted = audit.scanForNames('if (id === "switched-reluctance") {}', "x.js");
    assert.ok(withQuoted.length >= 1, "expected ≥1 violation for quoted id");
    assert.strictEqual(withQuoted[0].check, "name-id");

    const withBare = audit.scanForNames("// switched-reluctance", "x.js");
    assert.strictEqual(withBare.length, 0, "bare unquoted id in a comment must not be a violation");
  });

  it("scanForNames passes a registry iteration", function () {
    const result = audit.scanForNames("for (const m of UM.MACHINES) host.add(m.label);", "x.js");
    assert.strictEqual(result.length, 0, "registry iteration must produce no violations");
  });

  it("scanForSingleSlice flags a fast-path branch", function () {
    const r1 = audit.scanForSingleSlice("if (nSlices === 1) return cheap();", "x.js");
    assert.ok(r1.length >= 1, "nSlices === 1 must be flagged");
    assert.strictEqual(r1[0].check, "single-slice");

    const r2 = audit.scanForSingleSlice("if (slices < 2) skip();", "x.js");
    assert.ok(r2.length >= 1, "slices < 2 must be flagged");
    assert.strictEqual(r2[0].check, "single-slice");
  });

  it("scanForSingleSlice ignores the comment prose", function () {
    const src = "// Unconditional loop — no if (nSlices === 1) fast path.\nfor (let k=0;k<nSlices;k++){}";
    const result = audit.scanForSingleSlice(src, "x.js");
    assert.strictEqual(result.length, 0, "comment prose must not produce a violation after stripping");
  });

  it("scanForLegacyTerms flags a deleted term", function () {
    const result = audit.scanForLegacyTerms("const t = coenergyTorque(dL, I);", "lib/motor-stack.js");
    assert.ok(result.length >= 1, "expected ≥1 violation");
    assert.strictEqual(result[0].check, "legacy");
  });

  it("scanForLegacyTerms honours the em-physics carve-out", function () {
    const r1 = audit.scanForLegacyTerms("function coenergyTorque(){}", "lib/em-physics.js");
    assert.strictEqual(r1.length, 0, "em-physics.js must be carved out");

    const r2 = audit.scanForLegacyTerms("function coenergyTorque(){}", "lessons/ac_motor/squirrel-cage.js");
    assert.strictEqual(r2.length, 0, "lessons/ac_motor/ must be carved out");
  });

  it("NAME_SCAN_FILES covers the new render/UI files and carve-outs exclude the shared shell", function () {
    const files = audit.NAME_SCAN_FILES;
    assert.ok(files.includes("lessons/unified_motor/render3d.js"),           "must include render3d.js");
    assert.ok(files.includes("lessons/unified_motor/machine-picker.js"),     "must include machine-picker.js");
    assert.ok(files.includes("lessons/unified_motor/geometry-panel.js"),     "must include geometry-panel.js");
    assert.ok(files.includes("lessons/unified_motor/cross-section-render.js"),"must include cross-section-render.js");
    assert.ok(files.includes("lessons/unified_motor/mount.js"),              "must include mount.js");

    const carveOuts = audit.NAME_CARVE_OUTS;
    assert.ok(carveOuts.includes("app.js"),            "carve-outs must include app.js");
    assert.ok(carveOuts.includes("registry.js"),       "carve-outs must include registry.js");
    assert.ok(carveOuts.includes("header-buttons.js"), "carve-outs must include header-buttons.js");
    assert.ok(carveOuts.includes("stepper-drive.js"),  "carve-outs must include stepper-drive.js");
    assert.ok(carveOuts.includes("three-phase.js"),    "carve-outs must include three-phase.js");
  });

  it("a missing scan target is reported as a violation", function () {
    const nonexistent = "lib/__nonexistent_file_for_test__.js";
    const violations = audit.scanFileListForMissing([nonexistent]);
    assert.ok(violations.length >= 1, "expected at least one missing violation");
    const v = violations.find(function (x) { return x.relPath === nonexistent; });
    assert.ok(v != null, "expected a violation with relPath === nonexistent");
    assert.strictEqual(v.check, "missing");
  });

  it("scanForPlanVocab flags Phase/Wave/task tokens", function () {
    const r1 = audit.scanForPlanVocab("// Phase 2 / Phase 3 import", "lib/x.js");
    assert.ok(r1.length >= 1, "Phase 2 must be flagged; got " + r1.length);
    assert.strictEqual(r1[0].check, "plan-vocab");

    const r2 = audit.scanForPlanVocab("// Wave 5.4 C: Schur", "lib/x.js");
    assert.ok(r2.length >= 1, "Wave 5.4 must be flagged; got " + r2.length);
    assert.strictEqual(r2[0].check, "plan-vocab");

    const r3 = audit.scanForPlanVocab("// production R1 surface (Phase 6, T6.1.1)", "lib/x.js");
    assert.ok(r3.length >= 1, "T6.1.1 / Phase 6 must be flagged; got " + r3.length);
    assert.strictEqual(r3[0].check, "plan-vocab");
  });

  it("scanForPlanVocab spares physics phase usage", function () {
    const result = audit.scanForPlanVocab("// per-phase three-phase winding, phase current", "lib/x.js");
    assert.strictEqual(result.length, 0, "physics phase usage must not be flagged");
  });

  it("scanForPlanVocab honours carve-outs", function () {
    const result = audit.scanForPlanVocab("// Phase 2 stuff", "lib/em-physics.js");
    assert.strictEqual(result.length, 0, "em-physics.js carve-out must suppress plan-vocab violations");
  });

  it("run() returns 0 on the clean repo", function () {
    const code = audit.run();
    assert.strictEqual(code, 0, "audit.run() must return 0 on a clean repo");
  });

  it("CLI exits 0 on the clean repo", function () {
    let output;
    try {
      output = execFileSync(process.execPath, [SCRIPT_PATH], { stdio: "pipe" });
    } catch (e) {
      assert.fail("CLI exited non-zero: " + (e.stderr ? e.stderr.toString() : e.message));
    }
    assert.ok(
      output.toString().includes("agnosticism audit: clean"),
      "stdout must contain 'agnosticism audit: clean', got: " + output.toString()
    );
  });

});
