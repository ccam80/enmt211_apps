"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const LIB = require("./_shim.js");

test("shim exposes LIB.Integrate", () => {
  assert.equal(typeof LIB.Integrate.rk4, "function");
});

test("rk4 advances a trivial ODE", () => {
  const state = { x: 0 };
  const dof = ["x"];
  const dxdt = () => ({ x: 1 });
  LIB.Integrate.rk4(state, dof, dxdt, {}, 0, 0.5);
  assert.ok(Math.abs(state.x - 0.5) < 1e-12, `expected 0.5, got ${state.x}`);
});
