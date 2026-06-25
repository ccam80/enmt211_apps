(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});

  // ---------------------------------------------------------------------------
  //  eachElement(bodyMesh, cb) — iterate elements, invoke cb(e, count, n0..n3)
  // ---------------------------------------------------------------------------
  function eachElement(bodyMesh, cb) {
    const { elems } = bodyMesh;
    const Ne = elems.length / 4;
    for (let e = 0; e < Ne; e++) {
      const n0 = elems[4 * e], n1 = elems[4 * e + 1];
      const n2 = elems[4 * e + 2], n3 = elems[4 * e + 3];
      const count = n3 === -1 ? 3 : 4;
      cb(e, count, n0, n1, n2, n3);
    }
  }

  // Trace the element polygon as a closed path on ctx (no fill/stroke).
  function elementPath(ctx, nodes, count, n0, n1, n2, n3) {
    ctx.beginPath();
    ctx.moveTo(nodes[2 * n0], nodes[2 * n0 + 1]);
    ctx.lineTo(nodes[2 * n1], nodes[2 * n1 + 1]);
    ctx.lineTo(nodes[2 * n2], nodes[2 * n2 + 1]);
    if (count === 4) ctx.lineTo(nodes[2 * n3], nodes[2 * n3 + 1]);
    ctx.closePath();
  }

  // Element centroid in world coordinates.
  function elementCentroid(nodes, count, n0, n1, n2, n3) {
    let cx = nodes[2 * n0] + nodes[2 * n1] + nodes[2 * n2];
    let cy = nodes[2 * n0 + 1] + nodes[2 * n1 + 1] + nodes[2 * n2 + 1];
    if (count === 4) { cx += nodes[2 * n3]; cy += nodes[2 * n3 + 1]; }
    return [cx / count, cy / count];
  }

  // -------------------------------------------------------------------------
  //  viridis(t) — t ∈ [0,1] → "rgb(r,g,b)". Five-stop piecewise linear
  //  interpolation through canonical viridis control points.
  // -------------------------------------------------------------------------
  const VIRIDIS_STOPS = [
    [68, 1, 84],     // 0.0  dark purple
    [59, 82, 139],   // 0.25 blue
    [33, 145, 140],  // 0.5  teal
    [94, 201, 98],   // 0.75 green
    [253, 231, 37],  // 1.0  yellow
  ];

  function viridis(t) {
    if (t <= 0) { const c = VIRIDIS_STOPS[0]; return `rgb(${c[0]},${c[1]},${c[2]})`; }
    if (t >= 1) { const c = VIRIDIS_STOPS[4]; return `rgb(${c[0]},${c[1]},${c[2]})`; }
    const seg = t * 4;
    const i = Math.floor(seg);
    const f = seg - i;
    const a = VIRIDIS_STOPS[i], b = VIRIDIS_STOPS[i + 1];
    const r  = Math.round(a[0] + (b[0] - a[0]) * f);
    const g  = Math.round(a[1] + (b[1] - a[1]) * f);
    const bl = Math.round(a[2] + (b[2] - a[2]) * f);
    return `rgb(${r},${g},${bl})`;
  }

  // ---------------------------------------------------------------------------
  //  elemToNodal(bodyMesh, elemVals) → Float64Array(Nn)
  //
  //  Area-agnostic nodal averaging: each node = mean of its incident elements.
  // ---------------------------------------------------------------------------
  function elemToNodal(bodyMesh, elemVals) {
    const { nodes, elems } = bodyMesh;
    const Nn = nodes.length / 2;
    const Ne = elems.length / 4;
    const sum   = new Float64Array(Nn);
    const count = new Float64Array(Nn);
    for (let e = 0; e < Ne; e++) {
      const val = elemVals[e];
      const n0 = elems[4 * e], n1 = elems[4 * e + 1];
      const n2 = elems[4 * e + 2], n3 = elems[4 * e + 3];
      const cnt = n3 === -1 ? 3 : 4;
      sum[n0] += val; count[n0]++;
      sum[n1] += val; count[n1]++;
      sum[n2] += val; count[n2]++;
      if (cnt === 4) { sum[n3] += val; count[n3]++; }
    }
    const nodal = new Float64Array(Nn);
    for (let n = 0; n < Nn; n++) {
      nodal[n] = count[n] > 0 ? sum[n] / count[n] : 0;
    }
    return nodal;
  }

  // ---------------------------------------------------------------------------
  //  Resample stencil — the geometry-only half of resampleField.
  //
  //  A polar grid's mapping into a body mesh (which triangle each grid point
  //  lands in, and the barycentric weights of its three nodes) depends ONLY on
  //  the mesh geometry and the grid resolution — never on the field values. The
  //  field a body carries changes every solve step (the rotor turns, currents
  //  vary), but its mesh nodes/elements are fixed for the body's lifetime
  //  (rotation is a render-time ctx transform, not a node mutation). So we build
  //  this stencil once per (mesh, Nr, Ntheta) and reuse it every frame, paying
  //  only the cheap weighted-gather in applyResampleStencil per redraw.
  //
  //  Per grid point g: node triple (n0,n1,n2) and weight triple (w0,w1,w2),
  //  summing to 1 for an interior point. Nearest-node fallback stores the same
  //  node in all three slots with weights (1,0,0). A degenerate grid (no finite
  //  radius, or Nr/Ntheta = 0) stores n0 = -1, read as zero by the apply step.
  // ---------------------------------------------------------------------------
  function buildResampleStencil(bodyMesh, Nr, Ntheta) {
    const { nodes, elems } = bodyMesh;
    const Nn = nodes.length / 2;
    const Ne = elems.length / 4;
    const Ng = Nr * Ntheta;

    const n0 = new Int32Array(Ng);
    const n1 = new Int32Array(Ng);
    const n2 = new Int32Array(Ng);
    const w0 = new Float64Array(Ng);
    const w1 = new Float64Array(Ng);
    const w2 = new Float64Array(Ng);

    // Radial extent of the body.
    let rMin = Infinity, rMax = -Infinity;
    for (let n = 0; n < Nn; n++) {
      const x = nodes[2 * n], y = nodes[2 * n + 1];
      const r = Math.hypot(x, y);
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
    }
    if (!isFinite(rMin) || Nr === 0 || Ntheta === 0) {
      n0.fill(-1);
      return { rs: new Float64Array(Nr), thetas: new Float64Array(Ntheta),
               Nr, Ntheta, n0, n1, n2, w0, w1, w2 };
    }

    // Build uniform polar grid.
    const rs     = new Float64Array(Nr);
    const thetas = new Float64Array(Ntheta);
    for (let i = 0; i < Nr; i++)     rs[i]     = rMin + (rMax - rMin) * (i + 0.5) / Nr;
    for (let j = 0; j < Ntheta; j++) thetas[j] = 2 * Math.PI * j / Ntheta;

    // Decompose each element (quad → two tris) and bin into a theta×r bucket grid.
    // Bucket dimensions: use a reasonably fine grid for the index.
    const NBKT_R = Math.max(4, Math.ceil(Math.sqrt(Ne)));
    const NBKT_T = Math.max(8, Math.ceil(Math.sqrt(Ne)));
    const drBkt  = (rMax - rMin + 1e-30) / NBKT_R;
    const dtBkt  = (2 * Math.PI)          / NBKT_T;

    // Each bucket holds an array of triangle descriptors: [ia, ib, ic, ...].
    const buckets = new Array(NBKT_R * NBKT_T);
    for (let b = 0; b < buckets.length; b++) buckets[b] = [];

    function addTri(ia, ib, ic) {
      const ax = nodes[2 * ia], ay = nodes[2 * ia + 1];
      const bx = nodes[2 * ib], by = nodes[2 * ib + 1];
      const cx = nodes[2 * ic], cy = nodes[2 * ic + 1];

      // Bounding box in polar (r and theta wrapped).
      const rA = Math.hypot(ax, ay), rB = Math.hypot(bx, by), rC = Math.hypot(cx, cy);
      const triRMin = Math.max(rMin, Math.min(rA, rB, rC));
      const triRMax = Math.min(rMax, Math.max(rA, rB, rC));
      if (triRMin > triRMax) return;

      const tA = Math.atan2(ay, ax), tB = Math.atan2(by, bx), tC = Math.atan2(cy, cx);
      // Normalise to [0, 2π).
      function wrap(t) { return t < 0 ? t + 2 * Math.PI : t; }
      const wA = wrap(tA), wB = wrap(tB), wC = wrap(tC);

      // Detect cross-boundary triangles by checking max spread.
      const sorted = [wA, wB, wC].slice().sort((a, b) => a - b);
      let tLo = sorted[0], tHi = sorted[2];
      if (tHi - tLo > Math.PI) {
        // Triangle wraps across the 0/2π boundary; treat as full-circle coverage.
        tLo = 0; tHi = 2 * Math.PI;
      }

      const irMin = Math.max(0, Math.floor((triRMin - rMin) / drBkt));
      const irMax = Math.min(NBKT_R - 1, Math.floor((triRMax - rMin) / drBkt));
      const itMin = Math.max(0, Math.floor(tLo / dtBkt));
      const itMax = Math.min(NBKT_T - 1, Math.floor(tHi / dtBkt));

      const tri = [ia, ib, ic, ax, ay, bx, by, cx, cy];
      for (let ir = irMin; ir <= irMax; ir++) {
        for (let it = itMin; it <= itMax; it++) {
          buckets[ir * NBKT_T + it].push(tri);
        }
      }
    }

    for (let e = 0; e < Ne; e++) {
      const a0 = elems[4 * e], a1 = elems[4 * e + 1];
      const a2 = elems[4 * e + 2], a3 = elems[4 * e + 3];
      addTri(a0, a1, a2);
      if (a3 !== -1) addTri(a0, a2, a3);
    }

    // Nearest-node index for grid points outside every element.
    function nearestNode(px, py) {
      let best = 0, bestD2 = Infinity;
      for (let n = 0; n < Nn; n++) {
        const dx = nodes[2 * n] - px, dy = nodes[2 * n + 1] - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = n; }
      }
      return best;
    }

    // Barycentric weights of (px,py) inside a triangle, or null if outside.
    function baryWeights(px, py, tri) {
      const ax = tri[3], ay = tri[4];
      const bx = tri[5], by = tri[6];
      const cx = tri[7], cy = tri[8];
      const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(denom) < 1e-30) return null;
      const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denom;
      const wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denom;
      const wc = 1 - wa - wb;
      if (wa < -1e-8 || wb < -1e-8 || wc < -1e-8) return null;
      return { ia: tri[0], ib: tri[1], ic: tri[2], wa, wb, wc };
    }

    for (let i = 0; i < Nr; i++) {
      const r = rs[i];
      const ir = Math.max(0, Math.min(NBKT_R - 1, Math.floor((r - rMin) / drBkt)));
      for (let j = 0; j < Ntheta; j++) {
        const theta = thetas[j];
        const px = r * Math.cos(theta);
        const py = r * Math.sin(theta);
        const it = Math.floor(theta / dtBkt) % NBKT_T;
        const bucket = buckets[ir * NBKT_T + it];
        let bw = null;
        for (let k = 0; k < bucket.length; k++) {
          bw = baryWeights(px, py, bucket[k]);
          if (bw !== null) break;
        }
        if (bw === null) {
          // Fallback: also check adjacent theta buckets (wrap handling).
          const itPrev = (it - 1 + NBKT_T) % NBKT_T;
          const itNext = (it + 1) % NBKT_T;
          for (const itAlt of [itPrev, itNext]) {
            const bAlt = buckets[ir * NBKT_T + itAlt];
            for (let k = 0; k < bAlt.length; k++) {
              bw = baryWeights(px, py, bAlt[k]);
              if (bw !== null) break;
            }
            if (bw !== null) break;
          }
        }
        const g = i * Ntheta + j;
        if (bw !== null) {
          n0[g] = bw.ia; n1[g] = bw.ib; n2[g] = bw.ic;
          w0[g] = bw.wa; w1[g] = bw.wb; w2[g] = bw.wc;
        } else {
          const near = nearestNode(px, py);
          n0[g] = near; n1[g] = near; n2[g] = near;
          w0[g] = 1; w1[g] = 0; w2[g] = 0;
        }
      }
    }

    return { rs, thetas, Nr, Ntheta, n0, n1, n2, w0, w1, w2 };
  }

  // Gather a per-node scalar onto the grid via a prebuilt stencil — the cheap,
  // field-dependent half of resampleField, run once per redraw.
  function applyResampleStencil(stencil, nodal) {
    const { rs, thetas, Nr, Ntheta, n0, n1, n2, w0, w1, w2 } = stencil;
    const Az = new Float64Array(Nr * Ntheta);
    for (let g = 0; g < Az.length; g++) {
      const a = n0[g];
      if (a < 0) { Az[g] = 0; continue; }   // degenerate-grid sentinel
      Az[g] = w0[g] * nodal[a] + w1[g] * nodal[n1[g]] + w2[g] * nodal[n2[g]];
    }
    return { rs, thetas, Az, Nr, Ntheta };
  }

  // Memoize the geometry stencil per (mesh, Nr, Ntheta). The mesh object is the
  // key: a geometry/config edit rebuilds the stack and hence the body meshes, so
  // a fresh object naturally misses and the stale stencil is GC'd with its mesh.
  const _stencilCache = new WeakMap();

  function getResampleStencil(bodyMesh, Nr, Ntheta) {
    let byRes = _stencilCache.get(bodyMesh);
    if (!byRes) { byRes = new Map(); _stencilCache.set(bodyMesh, byRes); }
    const key = Nr + "x" + Ntheta;
    let st = byRes.get(key);
    if (!st) { st = buildResampleStencil(bodyMesh, Nr, Ntheta); byRes.set(key, st); }
    return st;
  }

  // ---------------------------------------------------------------------------
  //  resampleField(bodyMesh, nodal, opts) → { rs, thetas, Az, Nr, Ntheta }
  //
  //  Resample a per-node scalar onto a uniform polar grid over the body's
  //  [rMin, rMax] × [0, 2π) annulus. The polar-grid → mesh stencil (containing
  //  triangle + barycentric weights per grid point) is geometry-only and cached
  //  on the mesh, so a redraw with new field values pays only the gather.
  //
  //  opts = { Nr, Ntheta }
  // ---------------------------------------------------------------------------
  function resampleField(bodyMesh, nodal, opts) {
    opts = opts || {};
    const Nr     = opts.Nr     != null ? opts.Nr     : 24;
    const Ntheta = opts.Ntheta != null ? opts.Ntheta : 96;
    const stencil = getResampleStencil(bodyMesh, Nr, Ntheta);
    return applyResampleStencil(stencil, nodal);
  }

  // ---------------------------------------------------------------------------
  //  drawFluxLines(ctx, grid, opts) → void
  //
  //  Marching-squares iso-contours over the polar grid, smoothed with
  //  Catmull-Rom splines (emitted as bezierCurveTo). grid = { rs, thetas, Az,
  //  Nr, Ntheta } as returned by resampleField. Periodic in theta.
  //
  //  opts = { levels=12, color, lineWidth }
  // ---------------------------------------------------------------------------
  function drawFluxLines(ctx, grid, opts) {
    opts = opts || {};
    const color     = opts.color     != null ? opts.color     : "rgba(255,255,255,0.7)";
    // Contours are stroked in the caller's world units, which are scaled to
    // pixels by thousands; a default lineWidth of 1 would render thousands of
    // pixels wide. Default to ~1.2 device px by dividing out the transform scale.
    const lineWidth = opts.lineWidth != null ? opts.lineWidth
      : (typeof ctx.getTransform === "function"
          ? 1.2 / (Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1)
          : 1.2);

    const { Az, Nr, Ntheta, rs, thetas } = grid;
    if (!Az || Az.length === 0) return;

    // Determine contour levels.
    let aMin = Infinity, aMax = -Infinity;
    for (let k = 0; k < Az.length; k++) {
      const v = Az[k];
      if (v < aMin) aMin = v;
      if (v > aMax) aMax = v;
    }
    if (!(aMax > aMin)) return;

    let levels;
    if (Array.isArray(opts.levels)) {
      levels = opts.levels;
    } else {
      const nLevels = opts.levels != null ? opts.levels : 12;
      levels = [];
      for (let l = 1; l <= nLevels; l++) {
        levels.push(aMin + (aMax - aMin) * l / (nLevels + 1));
      }
    }

    // Grid value accessor — row i (radial), col j (theta, periodic).
    function az(i, j) { return Az[i * Ntheta + ((j % Ntheta + Ntheta) % Ntheta)]; }

    // Convert polar grid indices to Cartesian world coordinates.
    function toXY(i, j) {
      const r = rs[i];
      const th = thetas[((j % Ntheta + Ntheta) % Ntheta)];
      return [r * Math.cos(th), r * Math.sin(th)];
    }

    // Linear interpolation of the crossing point along an edge.
    function edgePt(i0, j0, i1, j1, level) {
      const v0 = az(i0, j0), v1 = az(i1, j1);
      const t = (level - v0) / (v1 - v0);
      const [x0, y0] = toXY(i0, j0);
      const [x1, y1] = toXY(i1, j1);
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }

    // Catmull-Rom through an ordered point list → bezierCurveTo calls.
    function strokeCatmullRom(pts) {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      if (pts.length === 2) {
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.stroke();
        return;
      }
      for (let k = 0; k < pts.length - 1; k++) {
        const p0 = pts[Math.max(0, k - 1)];
        const p1 = pts[k];
        const p2 = pts[k + 1];
        const p3 = pts[Math.min(pts.length - 1, k + 2)];
        const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
        const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
        const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
        const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
      }
      ctx.stroke();
    }

    // A triangle edge is crossed by `level` iff exactly one endpoint is below it.
    // (The endpoint already classified `< level` versus `>= level`.)
    function crosses(va, vb, level) { return (va < level) !== (vb < level); }

    // Link disjoint contour segments (each a [p,q] pair) sharing an endpoint into
    // ordered polylines, so each contour is smoothed on its own rather than
    // every segment in the grid being run through one Catmull-Rom.
    function keyOf(p) { return Math.round(p[0] * 1e9) + "," + Math.round(p[1] * 1e9); }
    function linkSegments(segs) {
      const adj = new Map();
      for (let s = 0; s < segs.length; s++) {
        for (const e of [0, 1]) {
          const k = keyOf(segs[s][e]);
          if (!adj.has(k)) adj.set(k, []);
          adj.get(k).push({ s, e });
        }
      }
      const used = new Array(segs.length).fill(false);
      const next = function (pt) {
        const cand = adj.get(keyOf(pt)) || [];
        for (const c of cand) if (!used[c.s]) return c;
        return null;
      };
      const chains = [];
      for (let s = 0; s < segs.length; s++) {
        if (used[s]) continue;
        used[s] = true;
        const chain = [segs[s][0], segs[s][1]];
        for (let c = next(chain[chain.length - 1]); c; c = next(chain[chain.length - 1])) {
          used[c.s] = true;
          chain.push(segs[c.s][1 - c.e]);
        }
        for (let c = next(chain[0]); c; c = next(chain[0])) {
          used[c.s] = true;
          chain.unshift(segs[c.s][1 - c.e]);
        }
        chains.push(chain);
      }
      return chains;
    }

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;

    for (let li = 0; li < levels.length; li++) {
      const level = levels[li];
      // Two triangles per polar cell: (i,j)→(i+1,j)→(i,j+1) and
      // (i+1,j)→(i+1,j+1)→(i,j+1). Theta is periodic: j wraps.
      const segs = [];

      for (let i = 0; i < Nr - 1; i++) {
        for (let j = 0; j < Ntheta; j++) {
          const jp = (j + 1) % Ntheta;
          const v00 = az(i, j), v10 = az(i + 1, j), v01 = az(i, jp), v11 = az(i + 1, jp);

          // Triangle 1: (i,j), (i+1,j), (i,jp)
          const c1 = [];
          if (crosses(v00, v10, level)) c1.push(edgePt(i, j, i + 1, j, level));
          if (crosses(v10, v01, level)) c1.push(edgePt(i + 1, j, i, jp, level));
          if (crosses(v01, v00, level)) c1.push(edgePt(i, jp, i, j, level));
          if (c1.length === 2) segs.push([c1[0], c1[1]]);

          // Triangle 2: (i+1,j), (i+1,jp), (i,jp)
          const c2 = [];
          if (crosses(v10, v11, level)) c2.push(edgePt(i + 1, j, i + 1, jp, level));
          if (crosses(v11, v01, level)) c2.push(edgePt(i + 1, jp, i, jp, level));
          if (crosses(v01, v10, level)) c2.push(edgePt(i, jp, i + 1, j, level));
          if (c2.length === 2) segs.push([c2[0], c2[1]]);
        }
      }

      for (const chain of linkSegments(segs)) strokeCatmullRom(chain);
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  drawModulusB(ctx, grid, opts) → void
  //
  //  Blended heatmap from a resampled |B| grid. Each polar cell is drawn as a
  //  quad whose fillStyle is viridis of the bilinearly-interpolated corner
  //  magnitude (corner average). grid = { rs, thetas, Az, Nr, Ntheta }.
  //
  //  opts = { range="auto", alpha }
  // ---------------------------------------------------------------------------
  function drawModulusB(ctx, grid, opts) {
    opts = opts || {};
    const alpha = opts.alpha != null ? opts.alpha : 0.85;

    const { Az, Nr, Ntheta, rs, thetas } = grid;
    if (!Az || Az.length === 0) return;

    let lo, hi;
    if (Array.isArray(opts.range)) {
      lo = opts.range[0]; hi = opts.range[1];
    } else {
      lo = Infinity; hi = -Infinity;
      for (let k = 0; k < Az.length; k++) {
        if (Az[k] < lo) lo = Az[k];
        if (Az[k] > hi) hi = Az[k];
      }
    }
    const span = hi - lo;

    function az(i, j) { return Az[i * Ntheta + ((j % Ntheta + Ntheta) % Ntheta)]; }

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;

    for (let i = 0; i < Nr - 1; i++) {
      for (let j = 0; j < Ntheta; j++) {
        const jp = (j + 1) % Ntheta;

        // Corner average of the cell for bilinear interpolation.
        const avgVal = (az(i, j) + az(i + 1, j) + az(i, jp) + az(i + 1, jp)) / 4;
        const t = span > 1e-30 ? (avgVal - lo) / span : 0;

        // Draw the cell as a quad in world coordinates.
        const r0 = rs[i], r1 = rs[i + 1];
        const th0 = thetas[j], th1 = thetas[jp];
        const x00 = r0 * Math.cos(th0), y00 = r0 * Math.sin(th0);
        const x10 = r1 * Math.cos(th0), y10 = r1 * Math.sin(th0);
        const x11 = r1 * Math.cos(th1), y11 = r1 * Math.sin(th1);
        const x01 = r0 * Math.cos(th1), y01 = r0 * Math.sin(th1);

        ctx.beginPath();
        ctx.moveTo(x00, y00);
        ctx.lineTo(x10, y10);
        ctx.lineTo(x11, y11);
        ctx.lineTo(x01, y01);
        ctx.closePath();
        ctx.fillStyle = viridis(Math.max(0, Math.min(1, t)));
        ctx.fill();
      }
    }

    ctx.globalAlpha = prevAlpha;
  }

  // ---------------------------------------------------------------------------
  //  drawSaturation(ctx, bodyMesh, Belem, opts) → void
  //
  //  Per-iron-element flat viridis fill: |B(elem)| / Bknee_eff mapped 0..2 onto
  //  0..1 colormap (1.0 → mid-band 0.5). Non-iron elements are skipped.
  //  Bknee_eff = materials[matId].Bknee when finite-and-positive, else
  //  opts.BkneeDefault (default 1.6).
  //
  //  opts = { BkneeDefault=1.6, alpha=0.85 }
  // ---------------------------------------------------------------------------
  function drawSaturation(ctx, bodyMesh, Belem, opts) {
    opts = opts || {};
    const BkneeDefault = opts.BkneeDefault != null ? opts.BkneeDefault : 1.6;
    const alpha = opts.alpha != null ? opts.alpha : 0.85;
    const { nodes, matId, materials } = bodyMesh;
    if (nodes.length === 0 || !Belem || !Belem.mag) return;
    const mag = Belem.mag;

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;

    eachElement(bodyMesh, function (e, count, n0, n1, n2, n3) {
      const mat = materials[matId[e]];
      if (!mat || mat.kind !== "iron") return;
      const Bknee = (mat.Bknee != null && isFinite(mat.Bknee) && mat.Bknee > 0)
        ? mat.Bknee : BkneeDefault;
      const ratio = mag[e] / Bknee;
      const t = Math.max(0, Math.min(1, ratio / 2));
      elementPath(ctx, nodes, count, n0, n1, n2, n3);
      ctx.fillStyle = viridis(t);
      ctx.fill();
    });

    ctx.globalAlpha = prevAlpha;
  }

  // ---------------------------------------------------------------------------
  //  drawGapLoop(ctx, bodyMesh, opts) → void
  //
  //  Strokes the body's uniform-Δθ gap-loop polyline plus the gapR reference
  //  circle. opts = { color="#00ff88", lineWidth }.
  // ---------------------------------------------------------------------------
  function drawGapLoop(ctx, bodyMesh, opts) {
    opts = opts || {};
    const color = opts.color != null ? opts.color : "#00ff88";
    const { nodes, gapLoop, gapR } = bodyMesh;
    if (!gapLoop || gapLoop.length === 0) return;

    ctx.save();
    if (opts.lineWidth != null) ctx.lineWidth = opts.lineWidth;

    ctx.beginPath();
    for (let k = 0; k < gapLoop.length; k++) {
      const ni = gapLoop[k];
      const x = nodes[2 * ni], y = nodes[2 * ni + 1];
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, gapR, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(0,255,136,0.3)";
    ctx.stroke();

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  Exports
  // ---------------------------------------------------------------------------

  LIB.MotorMeshView = {
    viridis,
    elemToNodal,
    resampleField,
    buildResampleStencil,
    applyResampleStencil,
    drawFluxLines,
    drawModulusB,
    drawSaturation,
    drawGapLoop,
  };
})();
