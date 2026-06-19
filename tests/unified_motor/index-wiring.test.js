"use strict";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const html = fs.readFileSync(
  path.resolve(__dirname, "../../lessons/unified_motor/index.html"),
  "utf8"
);

test("FEA engine tags load before motor-stack.js", () => {
  const motorStackIdx = html.indexOf("../../lib/motor-stack.js");
  assert.ok(motorStackIdx !== -1, "motor-stack.js tag not found");

  const feaTags = [
    "../../lib/fea-solver.js",
    "../../lib/motor-mesh.js",
    "../../lib/motor-mesh-view.js",
    "../../lib/airgap-mortar.js",
    "../../lib/gap-eval.js",
    "../../lib/bdf-integrator.js",
    "../../lib/motor-slice.js",
  ];

  for (const tag of feaTags) {
    const idx = html.indexOf(tag);
    assert.ok(idx !== -1, `tag not found: ${tag}`);
    assert.ok(
      idx < motorStackIdx,
      `${tag} must appear before motor-stack.js (found at ${idx}, motor-stack at ${motorStackIdx})`
    );
  }
});

test("render/UI tags load after mount.js and before the first machine fixture", () => {
  const mountIdx = html.indexOf("./mount.js");
  assert.ok(mountIdx !== -1, "mount.js tag not found");

  const pmsmIdx = html.indexOf("./machines/pmsm.js");
  assert.ok(pmsmIdx !== -1, "machines/pmsm.js tag not found");

  const renderTags = [
    "./cross-section-render.js",
    "./render3d.js",
    "./machine-picker.js",
    "./geometry-panel.js",
  ];

  for (const tag of renderTags) {
    const idx = html.indexOf(tag);
    assert.ok(idx !== -1, `tag not found: ${tag}`);
    assert.ok(
      mountIdx < idx,
      `mount.js must appear before ${tag} (mount at ${mountIdx}, tag at ${idx})`
    );
    assert.ok(
      idx < pmsmIdx,
      `${tag} must appear before machines/pmsm.js (tag at ${idx}, pmsm at ${pmsmIdx})`
    );
  }
});

test("boot awaits FeaSolver.init before runTabs", () => {
  const initIdx = html.indexOf("LIB.FeaSolver.init(");
  assert.ok(initIdx !== -1, "LIB.FeaSolver.init( not found in index.html");

  // Count occurrences of runTabs(
  let count = 0;
  let pos = 0;
  while (true) {
    const found = html.indexOf("runTabs(", pos);
    if (found === -1) break;
    count++;
    pos = found + 1;
  }
  assert.strictEqual(count, 1, `Expected exactly one runTabs( occurrence, found ${count}`);

  const runTabsIdx = html.indexOf("runTabs(");
  assert.ok(
    initIdx < runTabsIdx,
    `LIB.FeaSolver.init( must appear before runTabs( (init at ${initIdx}, runTabs at ${runTabsIdx})`
  );
});
