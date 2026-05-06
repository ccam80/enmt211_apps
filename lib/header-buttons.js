"use strict";

// =============================================================================
//  LIB.HeaderButtons — reusable factory functions for spec.headerButtons
//  entries. The shell (lib/app.js) is fully generic about header buttons; this
//  module just supplies common patterns so lessons that share an idiom don't
//  copy-paste it. Lessons that want something bespoke just write the
//  { label, style, onClick } literal directly.
//
//  Public surface:
//
//    LIB.HeaderButtons.driveToggle(opts?) → headerButton entry
//        Standard "Drive: ON / OFF" toggle. Owns its state on
//        `state[opts.field]` (default: "driveOn"). Reads/writes a boolean
//        there; physics callbacks should branch on `state.driveOn` instead
//        of the old `params.driveOn`.
//        opts: {
//          field?:    "driveOn",          // state field to toggle
//          labelOn?:  "Drive: ON",
//          labelOff?: "Drive: OFF",
//          onChange?: (state, on) => void,
//        }
//
//    LIB.HeaderButtons.toggle(opts) → headerButton entry
//        Generic two-state toggle. Like driveToggle but with arbitrary
//        labels/styles.
//        opts: {
//          field,                                      // required
//          labelOn,  labelOff,                         // strings
//          styleOn?: { color, borderColor, … },
//          styleOff?: { … },
//          onChange?: (state, on) => void,
//        }
//
//  Dependencies: lib/util.js (getVar, for the default green/grey styling).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Util) throw new Error("LIB.HeaderButtons requires lib/util.js");

  function toggle(opts) {
    if (!opts || !opts.field) {
      throw new Error("LIB.HeaderButtons.toggle: opts.field is required");
    }
    const field    = opts.field;
    const labelOn  = opts.labelOn  || "ON";
    const labelOff = opts.labelOff || "OFF";
    const styleOn  = opts.styleOn  || null;
    const styleOff = opts.styleOff || null;
    return {
      id: opts.id || ("toggle:" + field),
      label: (state) => state[field] ? labelOn : labelOff,
      style: (state) => state[field] ? styleOn  : styleOff,
      onClick: (state) => {
        state[field] = !state[field];
        if (typeof opts.onChange === "function") opts.onChange(state, !!state[field]);
      },
    };
  }

  function driveToggle(opts) {
    opts = opts || {};
    const field    = opts.field    || "driveOn";
    const labelOn  = opts.labelOn  || "Drive: ON";
    const labelOff = opts.labelOff || "Drive: OFF";
    return toggle({
      id: "drive",
      field, labelOn, labelOff,
      styleOn: {
        color:       LIB.Util.getVar("--good"),
        borderColor: LIB.Util.getVar("--good"),
      },
      styleOff: {
        color:       LIB.Util.getVar("--ink"),
        borderColor: "#2e3642",
      },
      onChange: opts.onChange,
    });
  }

  LIB.HeaderButtons = { toggle, driveToggle };
})();
