"use strict";

// Node-side classic-script loader for lib/fea-solver.js.
//
// Sets FEA_SOLVER_MJS_PATH so the dynamic import("./solver.mjs") inside
// fea-solver.js resolves to the absolute lib/solver.mjs path rather than
// a path relative to this shim's caller. Then requires fea-solver.js so
// its IIFE runs and attaches LIB.FeaSolver to window.LIB.

const path = require("path");

if (!globalThis.window) globalThis.window = { LIB: {} };

// Point the dynamic import at the absolute lib/solver.mjs.
process.env.FEA_SOLVER_MJS_PATH = path.resolve(__dirname, "../../lib/solver.mjs");

require(path.join(__dirname, "../../lib/fea-solver.js"));

module.exports = window.LIB;
