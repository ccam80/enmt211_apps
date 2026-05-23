"use strict";

// =============================================================================
//  LIB.Layout3D — orbital perspective camera + 3D→2D projection.
//
//  Companion to LIB.Layout.{linearTrack, world2D, rotational}. Where those
//  return a flat world↔px transform, this one parameterises a camera that
//  orbits a fixed origin and projects world points into screen pixels with
//  perspective foreshortening. AC-motor and field-line lessons live in 3D —
//  the student rotates the rig to see what's going on inside.
//
//    LIB.Layout3D.orbital(W, H, opts)
//      Camera placed on a sphere around (0,0,0); always looks at origin
//      with world-up = +y. Returns:
//        {
//          kind: "orbital3d",
//          W, H, originPx,                    // screen origin (defaults to center)
//          yaw, pitch, dist, fov, focal,
//          eye:     {x,y,z},                  // camera position in world frame
//          basis:   {right, up, forward},     // camera orthonormal basis (world)
//          project(p) → { px, py, depth, behind },
//          projectMany(pts) → array,
//          worldToCam(p) → {x,y,z},           // camera-frame coords (z = forward)
//          depthOf(p) → depth in camera frame (positive = in front of cam)
//        }
//
//      Conventions:
//        • yaw  ∈ ℝ      — rotation about world +y axis. yaw=0 places the
//                          camera on the +z side of origin looking toward −z.
//                          Increasing yaw rotates the camera CCW seen from
//                          above (right-hand rule about +y).
//        • pitch ∈ (−π/2, +π/2)
//                       — elevation angle. pitch=0 is the equator;
//                          pitch>0 looks down at the rig from above.
//        • dist  > 0     — radial distance from origin (world units).
//        • fov   = vertical full angle in radians (default π/4 = 45°).
//        • Pixel y increases DOWNWARD (canvas convention).
//        • World y increases UPWARD (math convention).
//
//      Options: {
//        yaw     = 0,
//        pitch   = 0.35,           // ≈ 20° down at the rig by default
//        dist    = 4,              // world units
//        fov     = Math.PI / 4,    // radians, vertical full angle
//        originX = "center",       // numeric or "center"
//        originY = "center",
//        nearDepth = 0.05,         // points closer than this clamp to behind=true
//      }
//
//    LIB.Layout3D.depthSort(items, depthOf)
//      Stable sort by depth descending (farthest first → painter's algorithm).
//      `depthOf(item)` should return camera-frame depth (positive = in front).
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function freeze(o) { return Object.freeze(o); }
  function resolveOrigin(spec, span) {
    if (spec === "center" || spec == null) return span / 2;
    return +spec;
  }

  function orbital(W, H, opts) {
    opts = opts || {};
    const yaw       = +opts.yaw   || 0;
    const pitch     = (opts.pitch != null) ? +opts.pitch : 0.35;
    const dist      = (opts.dist  != null && +opts.dist > 0) ? +opts.dist : 4;
    const fov       = (opts.fov   != null) ? +opts.fov   : (Math.PI / 4);
    const nearDepth = (opts.nearDepth != null) ? +opts.nearDepth : 0.05;

    const originPx = freeze({
      x: resolveOrigin(opts.originX, W),
      y: resolveOrigin(opts.originY, H),
    });

    // Eye position. yaw=0 → camera on +z; +yaw rotates CCW about +y as seen
    // from above (right-hand rule). +pitch tilts up so camera looks down.
    const cy = Math.cos(yaw),  sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const eye = freeze({
      x: dist * cp * sy,
      y: dist * sp,
      z: dist * cp * cy,
    });

    // Camera basis. forward points FROM eye TOWARD origin (i.e. −eye_normalised).
    const fLen = Math.hypot(eye.x, eye.y, eye.z) || 1;
    const forward = freeze({
      x: -eye.x / fLen, y: -eye.y / fLen, z: -eye.z / fLen,
    });
    // World-up reference. Degenerate when looking straight up/down (|forward.y|≈1);
    // fall back to world +z so the basis stays well-defined at the poles.
    const upRef = (Math.abs(forward.y) > 0.999)
      ? { x: 0, y: 0, z: 1 }
      : { x: 0, y: 1, z: 0 };
    // right = forward × upRef (right-handed)
    let rx = forward.y * upRef.z - forward.z * upRef.y;
    let ry = forward.z * upRef.x - forward.x * upRef.z;
    let rz = forward.x * upRef.y - forward.y * upRef.x;
    const rL = Math.hypot(rx, ry, rz) || 1;
    rx /= rL; ry /= rL; rz /= rL;
    const right = freeze({ x: rx, y: ry, z: rz });
    // up = right × forward
    const ux = right.y * forward.z - right.z * forward.y;
    const uy = right.z * forward.x - right.x * forward.z;
    const uz = right.x * forward.y - right.y * forward.x;
    const up = freeze({ x: ux, y: uy, z: uz });

    // Focal length in pixels. With FOV measured vertically across H pixels:
    //   tan(fov/2) = (H/2) / focal  →  focal = (H/2) / tan(fov/2)
    const focal = (H / 2) / Math.tan(fov / 2);

    // World → camera frame. Translate so eye is origin, project onto basis.
    function worldToCam(p) {
      const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
      return {
        x:  dx * right.x   + dy * right.y   + dz * right.z,
        y:  dx * up.x      + dy * up.y      + dz * up.z,
        z:  dx * forward.x + dy * forward.y + dz * forward.z,  // + = in front
      };
    }
    function depthOf(p) {
      const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
      return dx * forward.x + dy * forward.y + dz * forward.z;
    }
    function project(p) {
      const c = worldToCam(p);
      const behind = c.z < nearDepth;
      const z = behind ? nearDepth : c.z;
      // Pixel y increases downward, so flip cam-y.
      return {
        px:    originPx.x + (c.x / z) * focal,
        py:    originPx.y - (c.y / z) * focal,
        depth: c.z,
        behind,
      };
    }
    function projectMany(pts) {
      const out = new Array(pts.length);
      for (let i = 0; i < pts.length; i++) out[i] = project(pts[i]);
      return out;
    }

    return freeze({
      kind: "orbital3d",
      W, H, originPx,
      yaw, pitch, dist, fov, focal, nearDepth,
      eye,
      basis: freeze({ right, up, forward }),
      worldToCam, depthOf, project, projectMany,
    });
  }

  // Painter's algorithm helper. Stable sort, farthest-first. Items whose
  // depth is non-finite go to the front (treated as "infinitely far"), so
  // garbage points never paint over real geometry.
  function depthSort(items, depthOf) {
    const tagged = items.map((it, i) => {
      const d = +depthOf(it);
      return { it, i, d: Number.isFinite(d) ? d : -Infinity };
    });
    tagged.sort((a, b) => (b.d - a.d) || (a.i - b.i));
    return tagged.map(t => t.it);
  }

  LIB.Layout3D = { orbital, depthSort };
})();
