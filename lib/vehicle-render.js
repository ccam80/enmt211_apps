"use strict";

// =============================================================================
//  LIB.VehicleRender — body renderers for the controltutorial vehicle family.
//
//  Each function paints one vehicle at a given canvas centre. The pixel scale
//  arguments (carW/carL for the car, etc.) are explicit so the lesson keeps
//  the world↔px conversion local. Stylistic options live as `opts` with safe
//  defaults that match the existing palette.
//
//   car (ctx, cx, cy, opts)
//     Top-down car: rounded body + windscreen + rear window + four wheels.
//     opts: { width, length, fill, stroke, glassFill, glassStroke,
//             wheelFill, accentFill }
//
//   heli (ctx, cx, cy, t, thrustRatio, opts)
//     Side-on helicopter: fuselage ellipse + tail boom + animated tail rotor +
//     skids + main rotor disk (rotation speed scales with thrustRatio).
//     opts: { fill, stroke, glassFill, glassStroke }
//
//   rover (ctx, cx, cy, theta, opts, motorState?)
//     Top-down 2-motor rover: body + heading wedge + paired motor housings.
//     theta is the heading angle (radians, CCW from +x). When motorState =
//     { uL, uR, scale } is supplied, the function also paints the per-motor
//     thrust arrows above/below the housings.
//     opts: { bodyW, bodyH, fill, stroke, accentFill, motorFill, motorStroke,
//             leftColor, rightColor }
//
//  Depends on LIB.Draw (for roundRect + arrow). Pure ctx painting; no closure
//  state. Lessons may freely call these inside spec.render.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Draw) throw new Error("LIB.VehicleRender requires lib/draw.js");

  function withDefault(v, d) { return v == null ? d : v; }

  // ---------------------------------------------------------------------------
  //  car (top-down)
  // ---------------------------------------------------------------------------

  function car(ctx, cx, cy, opts) {
    opts = opts || {};
    const carW = +opts.width  || 60;
    const carL = +opts.length || 100;
    const fill        = opts.fill        || "#2b3340";
    const stroke      = opts.stroke      || "#6a7384";
    const glassFill   = opts.glassFill   || "#4ea1ff44";
    const glassStroke = opts.glassStroke || "#4ea1ff88";
    const wheelFill   = opts.wheelFill   || "#12161c";
    const accent      = opts.accentFill  || "#e6e9ef";

    ctx.save();
    ctx.translate(cx, cy);

    // Body
    ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5;
    LIB.Draw.roundRect(ctx, -carW / 2, -carL / 2, carW, carL, 6);
    ctx.fill(); ctx.stroke();

    // Windscreen + rear window
    ctx.fillStyle = glassFill; ctx.strokeStyle = glassStroke;
    LIB.Draw.roundRect(ctx, -carW / 2 + 4, -carL / 2 + 4, carW - 8, carL * 0.32, 4);
    ctx.fill(); ctx.stroke();
    LIB.Draw.roundRect(ctx, -carW / 2 + 4,  carL * 0.10, carW - 8, carL * 0.28, 4);
    ctx.fill(); ctx.stroke();

    // Wheels
    ctx.fillStyle = wheelFill;
    const wW = carW * 0.18, wH = carL * 0.18;
    ctx.fillRect(-carW / 2 - 3, -carL * 0.30 - wH / 2, wW + 3, wH);
    ctx.fillRect( carW / 2 - wW, -carL * 0.30 - wH / 2, wW + 3, wH);
    ctx.fillRect(-carW / 2 - 3,   carL * 0.30 - wH / 2, wW + 3, wH);
    ctx.fillRect( carW / 2 - wW,  carL * 0.30 - wH / 2, wW + 3, wH);

    // Bonnet flash
    ctx.fillStyle = accent;
    ctx.fillRect(-1, -carL / 2 + 3, 2, 5);

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  heli (side-on)
  // ---------------------------------------------------------------------------

  function heli(ctx, cx, cy, t, thrustRatio, opts) {
    opts = opts || {};
    const fill        = opts.fill        || "#2b3340";
    const stroke      = opts.stroke      || "#6a7384";
    const glassFill   = opts.glassFill   || "#4ea1ff44";
    const glassStroke = opts.glassStroke || "#4ea1ff88";
    const tr          = +thrustRatio || 0;

    // Fuselage
    ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 28, 14, 0, 0, 2 * Math.PI);
    ctx.fill(); ctx.stroke();

    // Cockpit window
    ctx.fillStyle = glassFill; ctx.strokeStyle = glassStroke;
    ctx.beginPath();
    ctx.ellipse(cx + 12, cy - 2, 10, 7, 0, 0, 2 * Math.PI);
    ctx.fill(); ctx.stroke();

    // Tail boom
    ctx.fillStyle = fill; ctx.strokeStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy - 3);
    ctx.lineTo(cx - 70, cy - 1);
    ctx.lineTo(cx - 70, cy + 1);
    ctx.lineTo(cx - 18, cy + 4);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Tail fin
    ctx.beginPath();
    ctx.moveTo(cx - 65, cy);
    ctx.lineTo(cx - 75, cy - 10);
    ctx.lineTo(cx - 70, cy);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Animated tail rotor
    const ttail = (+t || 0) * 18;
    ctx.strokeStyle = "#aab2c0"; ctx.lineWidth = 1.5;
    ctx.save();
    ctx.translate(cx - 73, cy - 4);
    ctx.rotate(ttail);
    ctx.beginPath(); ctx.moveTo(-7, 0); ctx.lineTo(7, 0); ctx.stroke();
    ctx.restore();

    // Skids
    ctx.strokeStyle = stroke; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 24, cy + 14); ctx.lineTo(cx + 22, cy + 14);
    ctx.moveTo(cx - 18, cy + 12); ctx.lineTo(cx - 22, cy + 14);
    ctx.moveTo(cx + 16, cy + 12); ctx.lineTo(cx + 20, cy + 14);
    ctx.stroke();

    // Main rotor disk (rotation speed scales with thrust ratio)
    ctx.save();
    ctx.translate(cx, cy - 10);
    const rotSpd = 30 + tr * 10;
    ctx.rotate(((+t || 0) * rotSpd) % (2 * Math.PI));
    ctx.strokeStyle = "rgba(230,233,239,0.35)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-44, 0); ctx.lineTo(44, 0); ctx.stroke();
    ctx.strokeStyle = "rgba(230,233,239,0.85)"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, 44, 0, 2 * Math.PI); ctx.stroke();
    ctx.restore();

    // Mast
    ctx.strokeStyle = stroke; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy - 14);
    ctx.stroke();
  }

  // ---------------------------------------------------------------------------
  //  rover (top-down, 2 motors)
  // ---------------------------------------------------------------------------

  function rover(ctx, cx, cy, theta, opts, motorState) {
    opts = opts || {};
    const bodyW = +opts.bodyW || 70;
    const bodyH = +opts.bodyH || 55;
    const fill         = opts.fill        || "#2b3340";
    const stroke       = opts.stroke      || "#6a7384";
    const accent       = opts.accentFill  || "#4ea1ff";
    const motorFill    = opts.motorFill   || "#3a4453";
    const motorStroke  = opts.motorStroke || "#6a7384";
    const leftColor    = opts.leftColor   || LIB.Util.getVar("--cP");
    const rightColor   = opts.rightColor  || LIB.Util.getVar("--cI");

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-(+theta || 0));

    // Body
    ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5;
    LIB.Draw.roundRect(ctx, -bodyW / 2, -bodyH / 2, bodyW, bodyH, 6);
    ctx.fill(); ctx.stroke();

    // Heading wedge
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo( bodyW / 2 - 2, 0);
    ctx.lineTo( bodyW / 2 - 12, -bodyH * 0.32);
    ctx.lineTo( bodyW / 2 - 12,  bodyH * 0.32);
    ctx.closePath();
    ctx.fill();

    // Motor housings (top + bottom = left + right wheels in body frame)
    const motW = bodyW * 0.30, motH = bodyH * 0.22;
    ctx.fillStyle = motorFill; ctx.strokeStyle = motorStroke;
    ctx.fillRect(  -motW / 2, -bodyH / 2 - motH, motW, motH);
    ctx.strokeRect(-motW / 2, -bodyH / 2 - motH, motW, motH);
    ctx.fillRect(  -motW / 2,  bodyH / 2,        motW, motH);
    ctx.strokeRect(-motW / 2,  bodyH / 2,        motW, motH);

    // Per-motor thrust arrows (optional)
    if (motorState) {
      const uL = +motorState.uL || 0;
      const uR = +motorState.uR || 0;
      const motorScaleMax = Math.max(1, Math.abs(uL) + Math.abs(uR));
      const baseScale = +motorState.scale || (bodyW * 1.0);
      const uS = baseScale * 0.6 / motorScaleMax;
      LIB.Draw.arrow(ctx, 0, -bodyH / 2 - motH / 2,
                          uL * uS, -bodyH / 2 - motH / 2, {
        color: leftColor, width: 2, head: 6,
        label: "L " + uL.toFixed(0), fontSize: 10,
      });
      LIB.Draw.arrow(ctx, 0,  bodyH / 2 + motH / 2,
                          uR * uS,  bodyH / 2 + motH / 2, {
        color: rightColor, width: 2, head: 6,
        label: "R " + uR.toFixed(0), fontSize: 10,
      });
    }

    ctx.restore();
  }

  LIB.VehicleRender = { car, heli, rover };
})();
