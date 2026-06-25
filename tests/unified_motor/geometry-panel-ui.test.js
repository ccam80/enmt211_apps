"use strict";

// =============================================================================
//  Geometry panel — DOM-driving tests for the component-tree editing controls.
//
//  The pure helpers live in geometry-panel.test.js. This file boots the panel
//  build() against the headless DOM harness and drives the actual buttons, to
//  guard two regressions:
//    1. structural edits (add/remove component or ring) must repaint the panel;
//    2. winding/cage components must be addable, inserting their circuits so the
//       config stays valid.
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { installShims, loadApp } = require("./_dom-harness.js");

function walk(node, out) {
  out.push(node);
  for (const c of (node.children || [])) walk(c, out);
  return out;
}
function buttons(host, text) {
  return walk(host, []).filter(function (e) { return e.tagName === "BUTTON" && e.textContent === text; });
}
function cardCount(host) {
  return walk(host, []).filter(function (e) { return e._className === "gp-comp-kind"; }).length;
}

function mountPanel(machineId) {
  const shim = installShims();
  const { UnifiedMotor } = loadApp();
  const CS = UnifiedMotor.ConfigSchema;
  const entry = UnifiedMotor.MACHINES.find(function (m) { return m.id === machineId; });
  const ctx = { config: JSON.parse(JSON.stringify(entry.config)), requestRebuild: function () {} };
  let captured = null;
  const orig = UnifiedMotor.registerPanel;
  UnifiedMotor.registerPanel = function (e) { if (e.id === "geometry-editor") captured = e; };
  delete require.cache[require.resolve("../../lessons/unified_motor/geometry-panel.js")];
  require("../../lessons/unified_motor/geometry-panel.js");
  UnifiedMotor.registerPanel = orig;
  const host = global.document.createElement("div");
  captured.build(host, ctx);
  return { shim, CS, ctx, host };
}

test("adding a winding component inserts its phase circuits and stays valid", function () {
  const { shim, CS, ctx, host } = mountPanel("pmsm");
  try {
    const circuits0 = ctx.config.circuits.length;
    const cards0 = cardCount(host);

    // Drive the first ring's "+ component" button with the winding kind selected.
    const addBtns = buttons(host, "+ component");
    assert.ok(addBtns.length > 0, "each ring must offer an add-component control");
    const sel = addBtns[0].parentNode.children[0];
    // The add menu must offer winding kinds, not just iron/magnet.
    const kinds = (sel.children || []).map(function (o) { return o.value; });
    assert.ok(kinds.includes("distributed-winding"), "add menu must include distributed-winding");
    assert.ok(kinds.includes("cage"), "add menu must include cage");

    sel.value = "distributed-winding";
    addBtns[0].dispatch("click");

    const v = CS.validate(ctx.config);
    assert.ok(v.ok, "config must stay valid after adding a winding: " + (v.errors || []).join("; "));
    assert.strictEqual(ctx.config.circuits.length, circuits0 + 3,
      "a 3-phase winding must append exactly 3 circuits");
    // expand's resolved circuit count must match the circuits array.
    const exp = CS.expand(ctx.config);
    assert.strictEqual(exp.nCircuits, ctx.config.circuits.length, "nCircuits must match circuits.length");
    // The panel must have repainted (more cards rendered than before).
    assert.ok(cardCount(host) > cards0, "panel must repaint after a structural edit");
  } finally {
    shim.uninstall();
  }
});

function cardByKindLabel(host, label) {
  const all = walk(host, []);
  return all.find(function (card) {
    if (card._className !== "gp-comp") return false;
    return walk(card, []).some(function (e) { return e._className === "gp-comp-kind" && e.textContent === label; });
  });
}

test("removing a winding component splices exactly its circuits", function () {
  const { shim, CS, ctx, host } = mountPanel("pmsm");
  try {
    // pmsm's stator winding is 3 phases → 3 circuits.
    assert.strictEqual(ctx.config.circuits.length, 3, "pmsm starts with 3 circuits");

    const card = cardByKindLabel(host, "distributed winding");
    assert.ok(card, "a distributed-winding card must be present");
    const rm = walk(card, []).find(function (e) { return e.tagName === "BUTTON" && e.textContent === "✕"; });
    assert.ok(rm, "the winding card must have a remove control");
    rm.dispatch("click");

    assert.strictEqual(ctx.config.circuits.length, 0,
      "removing the only winding must splice its 3 circuits, leaving 0");
    const v = CS.validate(ctx.config);
    assert.ok(v.ok, "config must stay valid after removing the winding: " + (v.errors || []).join("; "));
    const exp = CS.expand(ctx.config);
    assert.strictEqual(exp.nCircuits, 0, "expand must resolve 0 circuits");
  } finally {
    shim.uninstall();
  }
});

test("adding then removing a ring leaves the config valid and circuit-consistent", function () {
  const { shim, CS, ctx, host } = mountPanel("pmsm");
  try {
    const rings0 = ctx.config.rings.length;

    const addRing = buttons(host, "+ ring");
    assert.ok(addRing.length >= 2, "each body must offer a + ring control");
    addRing[addRing.length - 1].dispatch("click");      // outer body
    assert.strictEqual(ctx.config.rings.length, rings0 + 1, "a ring must be added");
    assert.ok(CS.validate(ctx.config).ok, "config must stay valid after adding a ring");

    const rmRing = buttons(host, "✕ ring");
    rmRing[rmRing.length - 1].dispatch("click");        // remove the just-added ring
    assert.strictEqual(ctx.config.rings.length, rings0, "the ring must be removed");
    const v = CS.validate(ctx.config);
    assert.ok(v.ok, "config must stay valid after removing the ring: " + (v.errors || []).join("; "));
    assert.doesNotThrow(function () { CS.expand(ctx.config); }, "expand must not throw");
  } finally {
    shim.uninstall();
  }
});
