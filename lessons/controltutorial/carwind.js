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

  // Override the car-shared icon with a wind-arrow variant so the splash
  // card differentiates from the plain Car-on-Road tile.
  ControlLessons.carWind.icon = (ctx, W, H) => {
    const S = Math.min(W, H);
    const accent = LIB.Util.getVar("--accent");
    const ink    = LIB.Util.getVar("--ink");
    const cI     = LIB.Util.getVar("--cI");
    const cW     = LIB.Util.getVar("--cW");

    // Same road backdrop as the plain car icon.
    const roadW = W * 0.55;
    const roadX0 = (W - roadW) / 2;
    ctx.fillStyle = "#16191e"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#1a1f27"; ctx.fillRect(roadX0, 0, roadW, H);

    ctx.strokeStyle = "#aab2c0"; ctx.lineWidth = Math.max(1.5, S * 0.008);
    ctx.beginPath();
    ctx.moveTo(roadX0, 0);          ctx.lineTo(roadX0, H);
    ctx.moveTo(roadX0 + roadW, 0);  ctx.lineTo(roadX0 + roadW, H);
    ctx.stroke();

    ctx.strokeStyle = cI; ctx.lineWidth = Math.max(1.5, S * 0.012);
    const dash = S * 0.10;
    ctx.setLineDash([dash, dash]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);

    // Car — pushed off-centre to the right by the wind.
    const carW = roadW * 0.42;
    const carH = S * 0.42;
    const carCx = W / 2 + roadW * 0.18;
    const carCy = H / 2;
    const r = Math.min(carW, carH) * 0.18;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(carCx - carW / 2 + r, carCy - carH / 2);
    ctx.arcTo(carCx + carW / 2, carCy - carH / 2, carCx + carW / 2, carCy + carH / 2, r);
    ctx.arcTo(carCx + carW / 2, carCy + carH / 2, carCx - carW / 2, carCy + carH / 2, r);
    ctx.arcTo(carCx - carW / 2, carCy + carH / 2, carCx - carW / 2, carCy - carH / 2, r);
    ctx.arcTo(carCx - carW / 2, carCy - carH / 2, carCx + carW / 2, carCy - carH / 2, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, S * 0.005);
    ctx.stroke();
    ctx.fillStyle = "#0d1013";
    ctx.fillRect(carCx - carW * 0.36, carCy - carH * 0.36,
                 carW * 0.72, carH * 0.18);

    // Wind arrows from the left verge sweeping across the road.
    ctx.strokeStyle = cW;
    ctx.lineWidth = Math.max(1.5, S * 0.007);
    const arrows = [H * 0.25, H * 0.50, H * 0.75];
    arrows.forEach((y) => {
      const x0 = W * 0.05, x1 = roadX0 + roadW * 0.45;
      ctx.beginPath();
      ctx.moveTo(x0, y); ctx.lineTo(x1, y);
      ctx.lineTo(x1 - S * 0.025, y - S * 0.020);
      ctx.moveTo(x1, y);
      ctx.lineTo(x1 - S * 0.025, y + S * 0.020);
      ctx.stroke();
    });
  };
})();
