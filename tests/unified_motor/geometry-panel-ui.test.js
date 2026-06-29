"use strict";

// =============================================================================
//  Geometry panel — DOM-driving tests for the layer/thickness editor.
//
//  The body→ring→component nesting is collapsed to one flat layer stack per
//  body. Layers are sized by thickness off a gap-facing radius, so overlap (the
//  winding-inside-a-magnet failure) is structurally impossible. These tests
//  drive the real controls and guard:
//    - adding any layer (incl. windings, which insert their circuits) never
//      produces overlapping radial bands;
//    - reorder / material-change / gap-radius / remove keep the config valid and
//      circuit-consistent;
//    - the "ring" concept is gone from the UI.
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
function layerRows(host) {
  return walk(host, []).filter(function (e) { return e._className === "gp-layer"; });
}
function bodyComps(config, side) {
  const ring = config.rings.find(function (r) { return r.member === side; });
  const comps = ring.components.slice();
  comps.sort(function (a, b) { return side === "inner" ? b.rRange[1] - a.rRange[1] : a.rRange[0] - b.rRange[0]; });
  return comps;
}
function assertNoOverlap(config, side) {
  const comps = bodyComps(config, side);
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const a = comps[i].rRange, b = comps[j].rRange;
      const overlap = Math.max(a[0], b[0]) < Math.min(a[1], b[1]) - 1e-12;
      assert.ok(!overlap, `${side} layers ${i}/${j} overlap: [${a}] vs [${b}]`);
    }
  }
}

function mountPanel(machineId) {
  const shim = installShims();
  const { UnifiedMotor } = loadApp();
  const CS = UnifiedMotor.ConfigSchema;
  const entry = UnifiedMotor.MACHINES.find(function (m) { return m.id === machineId; });
  const ctx = {
    config: JSON.parse(JSON.stringify(entry.config)),
    requestRebuild: function () {},
    requestRenderUpdate: function () {},   // render-only path (transparency)
  };
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

test("the ring concept is gone — only layer controls exist", function () {
  const { shim, host } = mountPanel("pmsm");
  try {
    assert.strictEqual(buttons(host, "+ ring").length, 0, "no + ring control");
    assert.strictEqual(buttons(host, "✕ ring").length, 0, "no ✕ ring control");
    assert.strictEqual(buttons(host, "+ component").length, 0, "no + component control");
    assert.ok(buttons(host, "+ layer").length >= 2, "each body offers + layer");
  } finally { shim.uninstall(); }
});

test("adding a winding layer inserts its circuits and produces no overlap", function () {
  const { shim, CS, ctx, host } = mountPanel("pmsm");
  try {
    const circuits0 = ctx.config.circuits.length;
    const addBtns = buttons(host, "+ layer");
    const sel = addBtns[0].parentNode.children[0];   // inner body's add menu
    const kinds = (sel.children || []).map(function (o) { return o.value; });
    assert.ok(kinds.includes("distributed-winding") && kinds.includes("cage"),
      "add menu must offer winding + cage");

    sel.value = "distributed-winding";
    addBtns[0].dispatch("click");

    const v = CS.validate(ctx.config);
    assert.ok(v.ok, "valid after adding a winding: " + (v.errors || []).join("; "));
    assert.strictEqual(ctx.config.circuits.length, circuits0 + 3, "3-phase winding adds 3 circuits");
    assert.strictEqual(CS.expand(ctx.config).nCircuits, ctx.config.circuits.length, "nCircuits matches");
    assertNoOverlap(ctx.config, "inner");
    assertNoOverlap(ctx.config, "outer");
  } finally { shim.uninstall(); }
});

test("setting a gap radius moves the whole stack and keeps the gap clear", function () {
  const { shim, CS, ctx, host } = mountPanel("pmsm");
  try {
    // inner body's gap-radius input is the first number input whose label mentions Gap radius.
    const inputs = walk(host, []).filter(function (e) { return e.tagName === "INPUT" && e.type === "number"; });
    // Find via the wrapping label text.
    const gapInput = walk(host, []).find(function (e) {
      return e.tagName === "LABEL" && /Gap radius/.test(e.textContent);
    });
    const inp = (gapInput.children || []).find(function (e) { return e.tagName === "INPUT"; });
    inp.value = "40";          // mm — pull the inner gap surface inward
    inp.dispatch("change");

    const v = CS.validate(ctx.config);
    assert.ok(v.ok, "valid after gap-radius edit: " + (v.errors || []).join("; "));
    const innerGap = Math.max.apply(null, bodyComps(ctx.config, "inner").map(function (c) { return c.rRange[1]; }));
    assert.ok(Math.abs(innerGap - 0.040) < 1e-9, "inner gap surface must be 40 mm, got " + innerGap * 1000);
    assertNoOverlap(ctx.config, "inner");
    assert.doesNotThrow(function () { CS.expand(ctx.config); });
  } finally { shim.uninstall(); }
});

test("dragging a layer reorders it without changing circuits", function () {
  const { shim, CS, ctx, host } = mountPanel("pmsm");
  try {
    const circuits0 = ctx.config.circuits.length;
    const before = bodyComps(ctx.config, "inner").map(function (c) { return c.kind; });
    const rows = layerRows(host);            // inner body's layers come first
    rows[0].dispatch("dragstart");
    rows[1].dispatch("drop");

    const after = bodyComps(ctx.config, "inner").map(function (c) { return c.kind; });
    assert.notDeepStrictEqual(after, before, "inner layer order must change");
    assert.deepStrictEqual(after.slice().sort(), before.slice().sort(), "same layers, reordered");
    assert.strictEqual(ctx.config.circuits.length, circuits0, "reorder must not change circuits");
    assert.ok(CS.validate(ctx.config).ok, "valid after reorder");
    assertNoOverlap(ctx.config, "inner");
  } finally { shim.uninstall(); }
});

test("changing a layer's material adjusts circuits and stays valid", function () {
  const { shim, CS, ctx, host } = mountPanel("pmsm");
  try {
    // Expand the outer winding layer, then switch its material to cage.
    const heads = walk(host, []).filter(function (e) { return e._className === "gp-layer-head"; });
    // Find the head whose kind label is the distributed winding.
    const windingHead = heads.find(function (h) {
      return walk(h, []).some(function (e) { return e._className === "gp-layer-kind" && e.textContent === "distributed winding"; });
    });
    windingHead.dispatch("click");           // expand it

    const matSelect = walk(host, []).find(function (e) {
      return e.tagName === "LABEL" && /Material/.test(e.textContent);
    });
    const sel = (matSelect.children || []).find(function (e) { return e.tagName === "SELECT"; });
    sel.value = "cage";
    sel.dispatch("change");

    const v = CS.validate(ctx.config);
    assert.ok(v.ok, "valid after material change to cage: " + (v.errors || []).join("; "));
    // cage default has 12 bars → 12 circuits replacing the 3 winding phases.
    assert.strictEqual(ctx.config.circuits.length, 12, "cage must own 12 bar circuits");
    assert.strictEqual(CS.expand(ctx.config).nCircuits, 12, "expand resolves 12 circuits");
    assert.ok(bodyComps(ctx.config, "outer").some(function (c) { return c.kind === "cage"; }), "outer now has a cage layer");
  } finally { shim.uninstall(); }
});

test("removing a layer splices its circuits and stays valid", function () {
  const { shim, CS, ctx, host } = mountPanel("pmsm");
  try {
    const card = walk(host, []).find(function (e) {
      return e._className === "gp-layer" &&
        walk(e, []).some(function (x) { return x._className === "gp-layer-kind" && x.textContent === "distributed winding"; });
    });
    const rm = walk(card, []).find(function (e) { return e.tagName === "BUTTON" && e.textContent === "✕"; });
    rm.dispatch("click");

    assert.strictEqual(ctx.config.circuits.length, 0, "removing the only winding splices its 3 circuits");
    assert.ok(CS.validate(ctx.config).ok, "valid after removing the winding");
    assert.strictEqual(CS.expand(ctx.config).nCircuits, 0, "expand resolves 0 circuits");
  } finally { shim.uninstall(); }
});

test("the end-cap transparency slider writes config.endCapAlpha", function () {
  const { shim, CS, ctx, host } = mountPanel("pmsm");
  try {
    const labelSpan = walk(host, []).find(function (e) {
      return e.tagName === "SPAN" && e.textContent === "end caps";
    });
    assert.ok(labelSpan, "Transparency section exposes an 'end caps' control");
    const row = labelSpan.parentNode;
    const range = walk(row, []).find(function (e) { return e.tagName === "INPUT" && e.type === "range"; });
    range.value = "0.4";
    range.dispatch("change");

    assert.ok(Math.abs(ctx.config.endCapAlpha - 0.4) < 1e-9, "endCapAlpha set to 0.4");
    assert.ok(CS.validate(ctx.config).ok, "still valid");
    assert.strictEqual(CS.expand(ctx.config).endCapAlpha, 0.4, "value reaches the renderer via expand");
  } finally { shim.uninstall(); }
});
