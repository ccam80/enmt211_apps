"use strict";

const path = require("path");
const assert = require("node:assert/strict");

if (!globalThis.window) globalThis.window = globalThis;
require(path.join(__dirname, "..", "..", "lib", "excitation.js"));

function assertClose(actual, expected, tol, msg) {
  if (tol == null) tol = 1e-9;
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff <= tol,
    `${msg || "assertClose"}: |${actual} - ${expected}| = ${diff} > tol ${tol}`
  );
}

module.exports = { LIB: window.LIB, assertClose };
