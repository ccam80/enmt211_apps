"use strict";

const path = require("path");

if (!globalThis.window) globalThis.window = globalThis;

const LIB_FILES = [
  "util.js",
  "integrate.js",
];

for (const name of LIB_FILES) {
  try {
    require(path.join(__dirname, "..", "lib", name));
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
  }
}

module.exports = window.LIB;
