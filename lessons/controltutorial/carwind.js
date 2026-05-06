"use strict";

// =============================================================================
//  Car-on-road (average crosswind) — same physics as car.js, with a steady
//  +50 N bias added to the OU-coloured side-wind. Pure proportional control
//  cannot beat a constant disturbance, so the integrator becomes essential.
//
//  Requires car.js to load first (it exposes window.ControlLessons._makeCarSpec).
// =============================================================================

(function () {
  const ControlLessons = window.ControlLessons || (window.ControlLessons = {});
  if (typeof ControlLessons._makeCarSpec !== "function") {
    throw new Error("carwind.js requires car.js to load first");
  }
  ControlLessons.carWind = ControlLessons._makeCarSpec({
    id: "carwind",
    title: "Car on Road (average crosswind)",
    subtitle: "the wind has a steady offset; the integrator must lean against it",
    windBias: 50,
  });
})();
