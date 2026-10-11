/* Forest Explorer - procedural world: terrain, trees, plants, props, collisions, particles. */
(function () {
  "use strict";
  const FE = (window.FE = window.FE || {});
  if (!window.THREE) return;
  const T = window.THREE;
  const { mulberry32, hash2, valueNoise, smoothstep, lerp, clamp, paint, jitter, merge, rawGeometry, buildChunks } = FE;

  /* ------------------------------------------------------------------ *
   *  Layout constants
   * ------------------------------------------------------------------ */
  const GROUND = 360;            // size of the ground plane (m)
  const PLAY_RADIUS = 78;        // walkable radius around the origin
  const SPAWN = { x: 0, z: 14, yaw: 0 };
  const POND = { x: -34, z: 14, R: 11 };
  const CAMP = { x: 24, z: -30, R: 9 };
  const STONES = { x: -44, z: -46, R: 6.2 };

  const MAIN_PATH = [[0, 22], [0, 12], [-1, 2], [3, -8], [10, -17], [18, -24], [CAMP.x - 2, CAMP.z + 3], [CAMP.x + 4, CAMP.z - 6], [32, -44], [33, -58], [26, -72]];
  const POND_PATH = [[-1, 4], [-9, 6], [-17, 9], [-23, 12], [-25.5, 13.5]];

  function catmull(pts, step) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const n = Math.max(2, Math.ceil(len / step));
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
      }
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  }
  const PATH_A = catmull(MAIN_PATH, 1.5);
  const PATH_B = catmull(POND_PATH, 1.5);
  const PATH_SEGS = [];
  [PATH_A, PATH_B].forEach((pl) => { for (let i = 0; i < pl.length - 1; i++) PATH_SEGS.push([pl[i][0], pl[i][1], pl[i + 1][0], pl[i + 1][1]]); });

  function pathDist(x, z) {
    let best = 1e9;
    for (let i = 0; i < PATH_SEGS.length; i++) {
      const s = PATH_SEGS[i];
      const dx = s[2] - s[0], dz = s[3] - s[1];
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - s[0]) * dx + (z - s[1]) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = s[0] + dx * t - x, pz = s[1] + dz * t - z;
      const d = px * px + pz * pz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /* ------------------------------------------------------------------ *
   *  Terrain height
   * ------------------------------------------------------------------ */
  function hills(x, z) {
    const n1 = (valueNoise(x * 0.011 + 7.3, z * 0.011 + 3.1) - 0.5) * 8.0;
    const n2 = (valueNoise(x * 0.032 + 1.7, z * 0.032 + 9.2) - 0.5) * 2.8;
    const n3 = (valueNoise(x * 0.1 + 4.4, z * 0.1 + 2.2) - 0.5) * 0.55;
    const n4 = (valueNoise(x * 0.33, z * 0.33) - 0.5) * 0.1;
    return n1 + n2 + n3 + n4;
  }
  function hillsFlat(x, z) {
    const f = smoothstep(4, 28, Math.hypot(x - SPAWN.x, z - SPAWN.z));
    return hills(x, z) * (0.25 + 0.75 * f);
  }
  const CAMP_H = hillsFlat(CAMP.x, CAMP.z);
  const POND_H = hillsFlat(POND.x, POND.z);
  const WATER_Y = POND_H - 0.55;
  const STONES_H = hillsFlat(STONES.x, STONES.z);

  function terrainHeight(x, z) {
    let h = hillsFlat(x, z);
    const dc = Math.hypot(x - CAMP.x, z - CAMP.z);
    if (dc < CAMP.R * 2) h = lerp(h, CAMP_H, 1 - smoothstep(CAMP.R * 0.7, CAMP.R * 1.9, dc));
    const dp = Math.hypot(x - POND.x, z - POND.z);
    if (dp < POND.R * 2.1) {
      const bowl = POND_H - 1.6 * (1 - smoothstep(0, POND.R, dp));
      h = lerp(h, bowl, 1 - smoothstep(POND.R * 0.95, POND.R * 2.0, dp));
    }
    const ds = Math.hypot(x - STONES.x, z - STONES.z);
    if (ds < STONES.R * 2) h = lerp(h, STONES_H, 1 - smoothstep(STONES.R * 0.8, STONES.R * 1.8, ds));
    return h;
  }
  // radius at which the pond bowl meets the water surface
  const POND_EDGE = (() => {
    let lo = 0, hi = POND.R;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const bowl = POND_H - 1.6 * (1 - smoothstep(0, POND.R, mid));
      if (bowl < WATER_Y) lo = mid; else hi = mid;
    }
    return lo;
  })();

  /* ------------------------------------------------------------------ *
   *  Geometry builders (all low-poly, flat-shaded, vertex-coloured)
   * ------------------------------------------------------------------ */
  function barkPaint(base, seed) {
    const col = new T.Color(base);
    return (c, x, y, z) => {
      const k = 0.68 + 0.55 * hash2(Math.round(y * 5) + seed, Math.round(Math.atan2(z, x) * 4));
      c.copy(col).multiplyScalar(k);
    };
  }

  function buildPine(seed, o) {
    const rng = mulberry32(seed);
    const parts = [];
    const H = o.H;
    const trunk = new T.CylinderGeometry(o.trunkTop, o.trunkBase, H * 0.66, 7, 4);
    trunk.translate(0, H * 0.33, 0);
    jitter(trunk, 0.05, seed);
    paint(trunk, barkPaint(0x5a392b, seed));
    parts.push(trunk);
    const leaf = new T.Color(o.leaf);
    const yb = Math.max(H * 0.27, 2.4);
    for (let i = 0; i < o.tiers; i++) {
      const f = i / (o.tiers - 1);
      const h = (H - yb) * (0.34 - 0.10 * f) + 0.5;
      const y0 = yb + f * (H - yb - h * 0.8);
      const r = o.R * (1 - f * 0.82) * (0.92 + rng() * 0.16);
      const cone = new T.ConeGeometry(r, h, 9, 2);
      cone.rotateY(rng() * 6.28);
      cone.translate(0, y0 + h * 0.5, 0);
      jitter(cone, r * 0.24, seed + i * 13, r * 0.12);
      paint(cone, (c, x, y, z) => {
        const t = (y - y0) / h;
        const k = 0.5 + 0.62 * t + 0.14 * (hash2(Math.round(x * 40), Math.round(z * 40)) - 0.5);
        c.copy(leaf).multiplyScalar(k);
      });
      parts.push(cone);
    }
    return merge(parts);
  }

  function blob(r, x, y, z, seed, colorFn, flat) {
    const g = new T.IcosahedronGeometry(r, 1);
    g.scale(1, flat || 0.82, 1);
    jitter(g, r * 0.34, seed, r * 0.26);
    g.translate(x, y, z);
    paint(g, colorFn);
    return g;
  }

  function buildBroadleaf(seed, o) {
    const rng = mulberry32(seed);
    const parts = [];
    const H = o.H;
    const lean = o.lean || 0;
    const trunk = new T.CylinderGeometry(o.trunkTop, o.trunkBase, H, 7, 5);
    trunk.translate(0, H / 2, 0);
    // gentle lean / bend
    const p = trunk.attributes.position;
    for (let i = 0; i < p.count; i++) { const k = p.getY(i) / H; p.setX(i, p.getX(i) + lean * k * k * H); }
    jitter(trunk, 0.05, seed);
    if (o.birch) {
      paint(trunk, (c, x, y, z) => {
        const band = hash2(Math.round(y * 3.2) + seed, Math.round(Math.atan2(z, x) * 2.2));
        if (band > 0.74) c.setHex(0x2b2a26); else c.setHex(0xe9e5d8).multiplyScalar(0.85 + 0.2 * hash2(Math.round(y * 9), seed));
      });
    } else paint(trunk, barkPaint(0x4a3224, seed));
    parts.push(trunk);

    const n = o.blobs;
    const pal = o.palette.map((h) => new T.Color(h));
    const cy0 = H + o.canopyLow;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng();
      const s = i === 0 ? 0 : o.spread * (0.6 + rng() * 0.5);
      const x = Math.cos(a) * s + lean * H, z = Math.sin(a) * s;
      const y = cy0 + (i === 0 ? o.canopyH : rng() * o.canopyH);
      const r = o.blobR * (0.78 + rng() * 0.5);
      const base = pal[i % pal.length];
      parts.push(blob(r, x, y, z, seed + i * 7, (c, vx, vy, vz) => {
        const t = clamp((vy - (cy0 - r)) / (o.canopyH + 2 * r), 0, 1);
        c.copy(base).multiplyScalar(0.62 + 0.62 * t + 0.1 * (hash2(Math.round(vx * 30), Math.round(vz * 30)) - 0.5));
      }, o.flat));
    }
    // a few branch stubs under the canopy
    for (let b = 0; b < 3; b++) {
      const br = new T.CylinderGeometry(0.05, 0.1, 1.5, 5);
      br.translate(0, 0.75, 0);
      br.rotateZ(0.7 + rng() * 0.3);
      br.rotateY(rng() * 6.28);
      br.translate(lean * H * 0.9, H * (0.78 + b * 0.05), 0);
      paint(br, barkPaint(o.birch ? 0x8a8372 : 0x3f2a1d, seed + b));
      parts.push(br);
    }
    return merge(parts);
  }

  function buildBush(seed, palette) {
    const rng = mulberry32(seed);
    const parts = [];
    const pal = palette.map((h) => new T.Color(h));
    for (let i = 0; i < 4; i++) {
      const r = 0.4 + rng() * 0.3;
      const base = pal[i % pal.length];
      parts.push(blob(r, (rng() - 0.5) * 1.0, r * 0.7, (rng() - 0.5) * 1.0, seed + i, (c, x, y, z) => {
        c.copy(base).multiplyScalar(0.6 + 0.6 * clamp(y / 1.0, 0, 1));
      }, 0.75));
    }
    return merge(parts);
  }

  function buildRock(seed, tint) {
    const g = new T.IcosahedronGeometry(1, 1);
    jitter(g, 0.34, seed, 0.28);
    const col = new T.Color(tint);
    paint(g, (c, x, y, z) => {
      const k = 0.7 + 0.5 * hash2(Math.round(x * 8) + seed, Math.round(z * 8 + y * 5));
      c.copy(col).multiplyScalar(k);
      if (y > 0.35) c.lerp(new T.Color(0x4f6f34), clamp((y - 0.35) * 0.9, 0, 0.55)); // moss on top
    });
    return merge([g]);
  }

  function buildLog(len, rad, seed) {
    const g = new T.CylinderGeometry(rad * 0.92, rad, len, 8, 3);
    g.rotateZ(Math.PI / 2);
    jitter(g, 0.03, seed);
    const bark = barkPaint(0x4b3123, seed);
    paint(g, (c, x, y, z) => {
      if (Math.abs(x) > len / 2 - 0.02) c.setHex(0xb89a70); // cut ends
      else { bark(c, x, y, z); if (y > rad * 0.3 && hash2(Math.round(x * 6), seed) > 0.4) c.lerp(new T.Color(0x4d6a35), 0.45); }
    });
    return merge([g]);
  }

  function buildStump(seed) {
    const g = new T.CylinderGeometry(0.34, 0.46, 0.55, 8, 2);
    g.translate(0, 0.27, 0);
    jitter(g, 0.05, seed);
    const bark = barkPaint(0x4a3224, seed);
    paint(g, (c, x, y, z) => { if (y > 0.5) c.setHex(0xb89a70); else bark(c, x, y, z); });
    return merge([g]);
  }

  function buildMushrooms(capHex, seed) {
    const rng = mulberry32(seed);
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const s = 0.6 + rng() * 0.7;
      const x = (rng() - 0.5) * 0.35, z = (rng() - 0.5) * 0.35;
      const stem = new T.CylinderGeometry(0.025 * s, 0.035 * s, 0.14 * s, 6);
      stem.translate(x, 0.07 * s, z);
      paint(stem, (c) => c.setHex(0xe8e0cc));
      const cap = new T.SphereGeometry(0.075 * s, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.translate(x, 0.13 * s, z);
      paint(cap, (c, vx, vy, vz) => { c.setHex(capHex); if (hash2(Math.round(vx * 160), Math.round(vz * 160)) > 0.86 && capHex === 0xc8392b) c.setHex(0xf3ecd8); });
      parts.push(stem, cap);
    }
    return merge(parts);
  }

  /* Curved blades arranged in a tuft; both windings so it is lit from either side (normals point up). */
  function buildTuft(opts) {
    const rng = mulberry32(opts.seed);
    const pos = [], col = [], nor = [];
    const c0 = new T.Color(opts.base), c1 = new T.Color(opts.tip);
    const tmp = new T.Color();
    for (let b = 0; b < opts.blades; b++) {
      const a = rng() * Math.PI * 2;
      const ox = (rng() - 0.5) * opts.spread, oz = (rng() - 0.5) * opts.spread;
      const h = opts.h * (0.65 + rng() * 0.6);
      const w = opts.w * (0.8 + rng() * 0.5);
      const bend = (rng() * 0.5 + 0.1) * h * opts.bend;
      const dx = Math.cos(a), dz = Math.sin(a);
      const px = -dz, pz = dx;
      const rows = [];
      const segs = opts.segs;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const cx = ox + dx * bend * t * t, cz = oz + dz * bend * t * t;
        const cy = h * t - bend * 0.15 * t * t;
        const hw = s === segs ? 0 : w * 0.5 * Math.pow(1 - t, 0.7);
        rows.push([cx - px * hw, cy, cz - pz * hw, cx + px * hw, cy, cz + pz * hw, t]);
      }
      const push = (x, y, z, t) => {
        pos.push(x, y, z); nor.push(0, 1, 0);
        tmp.copy(c0).lerp(c1, t); col.push(tmp.r, tmp.g, tmp.b);
      };
      for (let s = 0; s < segs; s++) {
        const A = rows[s], B = rows[s + 1];
        // front
        push(A[0], A[1], A[2], A[6]); push(A[3], A[4], A[5], A[6]); push(B[0], B[1], B[2], B[6]);
        push(A[3], A[4], A[5], A[6]); push(B[3], B[4], B[5], B[6]); push(B[0], B[1], B[2], B[6]);
        // back
        push(A[0], A[1], A[2], A[6]); push(B[0], B[1], B[2], B[6]); push(A[3], A[4], A[5], A[6]);
        push(A[3], A[4], A[5], A[6]); push(B[0], B[1], B[2], B[6]); push(B[3], B[4], B[5], B[6]);
      }
    }
    return rawGeometry(pos, col, nor);
  }

  function buildFern(seed) {
    const rng = mulberry32(seed);
    const pos = [], col = [], nor = [];
    const c0 = new T.Color(0x24501f), c1 = new T.Color(0x6aa042), tmp = new T.Color();
    const leaves = 9;
    for (let l = 0; l < leaves; l++) {
      const a = (l / leaves) * Math.PI * 2 + rng() * 0.5;
      const len = 0.8 + rng() * 0.5, wid = 0.13 + rng() * 0.05, lift = 0.5 + rng() * 0.3;
      const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
      const segs = 5;
      const rows = [];
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const r = len * t;
        const y = lift * Math.sin(t * 2.2) * (1 - t * 0.35) * 0.6 + 0.06;
        const hw = wid * Math.pow(Math.sin(Math.min(1, t * 0.95 + 0.05) * Math.PI), 0.6) * 0.5;
        rows.push([dx * r - px * hw, y, dz * r - pz * hw, dx * r + px * hw, y, dz * r + pz * hw, t]);
      }
      const push = (x, y, z, t) => { pos.push(x, y, z); nor.push(0, 1, 0); tmp.copy(c0).lerp(c1, t); col.push(tmp.r, tmp.g, tmp.b); };
      for (let s = 0; s < segs; s++) {
        const A = rows[s], B = rows[s + 1];
        push(A[0], A[1], A[2], A[6]); push(A[3], A[4], A[5], A[6]); push(B[0], B[1], B[2], B[6]);
        push(A[3], A[4], A[5], A[6]); push(B[3], B[4], B[5], B[6]); push(B[0], B[1], B[2], B[6]);
        push(A[0], A[1], A[2], A[6]); push(B[0], B[1], B[2], B[6]); push(A[3], A[4], A[5], A[6]);
        push(A[3], A[4], A[5], A[6]); push(B[0], B[1], B[2], B[6]); push(B[3], B[4], B[5], B[6]);
      }
    }
    return rawGeometry(pos, col, nor);
  }

  function flowerHead() {
    const g = new T.CircleGeometry(0.075, 7);
    g.rotateX(-Math.PI / 2 + 0.35);
    g.translate(0, 0.42, 0);
    const pos = g.attributes.position;
    const nor = new Float32Array(pos.count * 3), col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { nor[i * 3 + 1] = 1; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1; }
    g.setAttribute("normal", new T.BufferAttribute(nor, 3));
    g.setAttribute("color", new T.BufferAttribute(col, 3));
    g.deleteAttribute("uv");
    // double-sided: duplicate with flipped winding
    const idx = g.index.array, flip = [];
    for (let i = 0; i < idx.length; i += 3) flip.push(idx[i], idx[i + 2], idx[i + 1]);
    g.setIndex(Array.from(idx).concat(flip));
    return g;
  }

  /* ------------------------------------------------------------------ *
   *  Textures
   * ------------------------------------------------------------------ */
  function makeDetailTexture() {
    const N = 256;
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d");
    const img = g.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = x / N, v = y / N;
        const n1 = FE.periodicNoise(u * 8, v * 8, 8, 1);
        const n2 = FE.periodicNoise(u * 24, v * 24, 24, 2);
        const n3 = FE.periodicNoise(u * 64, v * 64, 64, 3);
        const sp = hash2(x * 3 + 11, y * 5 + 7);
        let val = 0.5 + (n1 - 0.5) * 0.30 + (n2 - 0.5) * 0.26 + (n3 - 0.5) * 0.22 + (sp - 0.5) * 0.12;
        if (sp > 0.985) val += 0.18;
        const i = (y * N + x) * 4;
        const k = clamp(val, 0, 1) * 255;
        img.data[i] = k * 1.02; img.data[i + 1] = k; img.data[i + 2] = k * 0.95; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.colorSpace = T.NoColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function makeWaterNormal() {
    const N = 128;
    const h = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      h[y * N + x] = FE.periodicNoise(u * 6, v * 6, 6, 5) * 0.6 + FE.periodicNoise(u * 14, v * 14, 14, 6) * 0.3 + FE.periodicNoise(u * 30, v * 30, 30, 7) * 0.1;
    }
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d");
    const img = g.createImageData(N, N);
    const at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * 5, dy = (at(x, y - 1) - at(x, y + 1)) * 5;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * N + x) * 4;
      img.data[i] = (dx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.colorSpace = T.NoColorSpace;
    tex.repeat.set(7, 7);
    return tex;
  }

  /* Whole-world colour map: grass tones, dirt paths, pond mud, campfire ash, litter under trees. */
  function makeMacroTexture(res, trees) {
    const c = document.createElement("canvas");
    c.width = c.height = res;
    const g = c.getContext("2d");
    const img = g.createImageData(res, res);
    const A = [50, 82, 38], B = [88, 114, 50], M = [36, 68, 44], D = [118, 110, 58];
    for (let py = 0; py < res; py++) {
      const z = (py / res - 0.5) * GROUND;
      for (let px = 0; px < res; px++) {
        const x = (px / res - 0.5) * GROUND;
        const n1 = valueNoise(x * 0.02 + 3, z * 0.02 + 8);
        const n2 = valueNoise(x * 0.07, z * 0.07);
        const n3 = valueNoise(x * 0.25, z * 0.25);
        const dry = smoothstep(0.62, 0.9, valueNoise(x * 0.045 + 50, z * 0.045)) * 0.55;
        const moss = smoothstep(0.5, 0.8, n2) * 0.6;
        const k = 0.88 + 0.24 * n3;
        const i = (py * res + px) * 4;
        for (let ch = 0; ch < 3; ch++) {
          let v = A[ch] + (B[ch] - A[ch]) * n1;
          v += (M[ch] - v) * moss;
          v += (D[ch] - v) * dry;
          img.data[i + ch] = v * k;
        }
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const S = res / GROUND;
    const P = (x, z) => [(x / GROUND + 0.5) * res, (z / GROUND + 0.5) * res];

    // litter / needles under trees
    for (const t of trees) {
      const [px, py] = P(t.x, t.z);
      const rad = (2.0 + 1.3 * t.s) * S;
      const grad = g.createRadialGradient(px, py, 0, px, py, rad);
      const rgb = t.type === "pine" ? "72,50,28" : t.type === "birch" ? "108,92,50" : "92,68,32";
      grad.addColorStop(0, "rgba(" + rgb + ",0.6)");
      grad.addColorStop(0.6, "rgba(" + rgb + ",0.28)");
      grad.addColorStop(1, "rgba(" + rgb + ",0)");
      g.fillStyle = grad;
      g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    }

    // pond mud
    {
      const [px, py] = P(POND.x, POND.z);
      const rad = POND.R * 1.4 * S;
      const grad = g.createRadialGradient(px, py, 0, px, py, rad);
      grad.addColorStop(0, "rgba(30,34,28,1)");
      grad.addColorStop(0.5, "rgba(34,38,28,1)");
      grad.addColorStop(0.74, "rgba(62,64,38,0.7)");
      grad.addColorStop(1, "rgba(62,64,38,0)");
      g.fillStyle = grad;
      g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    }
    // campfire clearing
    {
      const [px, py] = P(CAMP.x, CAMP.z);
      const rad = CAMP.R * 0.95 * S;
      const grad = g.createRadialGradient(px, py, 0, px, py, rad);
      grad.addColorStop(0, "rgba(40,34,28,1)");
      grad.addColorStop(0.3, "rgba(86,68,46,0.85)");
      grad.addColorStop(1, "rgba(96,78,50,0)");
      g.fillStyle = grad;
      g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    }
    // standing-stones clearing
    {
      const [px, py] = P(STONES.x, STONES.z);
      const rad = STONES.R * 1.3 * S;
      const grad = g.createRadialGradient(px, py, 0, px, py, rad);
      grad.addColorStop(0, "rgba(72,70,52,0.8)");
      grad.addColorStop(1, "rgba(72,70,52,0)");
      g.fillStyle = grad;
      g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    }
    // dirt paths
    g.lineCap = "round"; g.lineJoin = "round";
    const strokes = [[5.4, "rgba(98,80,54,0.20)"], [3.8, "rgba(96,76,50,0.45)"], [2.5, "rgba(110,88,60,0.85)"], [1.4, "rgba(122,100,70,0.55)"]];
    for (const pl of [PATH_A, PATH_B]) {
      for (const [w, col] of strokes) {
        g.strokeStyle = col; g.lineWidth = w * S;
        g.beginPath();
        pl.forEach((p, i) => { const [px, py] = P(p[0], p[1]); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
        g.stroke();
      }
    }
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  /* ------------------------------------------------------------------ *
   *  Build
   * ------------------------------------------------------------------ */
  FE.buildWorld = async function (scene, renderer, Q, progress) {
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const step = async (label, pct) => { if (progress) progress(label, pct); await nextFrame(); };
    const rng = mulberry32(20261011);
    const world = { stats: {} };
    const root = new T.Group();
    scene.add(root);

    /* ---------- colliders ---------- */
    const CELL = 4;
    const cgrid = new Map();
    const colliders = [];
    const ckey = (cx, cz) => (cx + 512) * 1024 + (cz + 512);
    function addCollider(x, z, r) {
      const c = { x, z, r };
      colliders.push(c);
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
        for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
          const k = ckey(cx, cz);
          let l = cgrid.get(k);
          if (!l) cgrid.set(k, (l = []));
          l.push(c);
        }
    }
    const out = { x: 0, z: 0, hit: false };
    function resolve(x, z, pr) {
      out.hit = false;
      for (let iter = 0; iter < 3; iter++) {
        let moved = false;
        for (let cx = Math.floor((x - pr) / CELL); cx <= Math.floor((x + pr) / CELL); cx++)
          for (let cz = Math.floor((z - pr) / CELL); cz <= Math.floor((z + pr) / CELL); cz++) {
            const l = cgrid.get(ckey(cx, cz));
            if (!l) continue;
            for (let i = 0; i < l.length; i++) {
              const c = l[i];
              const dx = x - c.x, dz = z - c.z;
              const min = c.r + pr;
              const d2 = dx * dx + dz * dz;
              if (d2 < min * min) {
                const d = Math.sqrt(d2) || 1e-4;
                const k = (min - d) / d;
                x += dx * k; z += dz * k; moved = true; out.hit = true;
              }
            }
          }
        if (!moved) break;
      }
      const rr = Math.hypot(x, z), lim = PLAY_RADIUS - pr;
      if (rr > lim) { x *= lim / rr; z *= lim / rr; out.hit = true; }
      out.x = x; out.z = z;
      return out;
    }

    /* ---------- placement: trees ---------- */
    await step("Planting trees…", 6);
    const trees = [];
    {
      const tgrid = new Map();
      const TC = 8;
      const maxTrees = Q.trees;
      const spawnClear = (x, z) => Math.hypot(x - SPAWN.x, z - SPAWN.z) < 8;
      for (let attempt = 0; attempt < 90000 && trees.length < maxTrees; attempt++) {
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * 138;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (spawnClear(x, z)) continue;
        if (pathDist(x, z) < 3.3) continue;
        if (Math.hypot(x - CAMP.x, z - CAMP.z) < CAMP.R + 1) continue;
        if (Math.hypot(x - POND.x, z - POND.z) < POND.R + 3.5) continue;
        if (Math.hypot(x - STONES.x, z - STONES.z) < STONES.R + 3.5) continue;
        const dens = valueNoise(x * 0.02 + 21, z * 0.02 + 5) * 0.6 + valueNoise(x * 0.07 + 2, z * 0.07 + 9) * 0.4;
        let accept = lerp(0.3, 1, smoothstep(0.3, 0.62, dens));
        if (r > 56 && r < 92) accept = Math.max(accept, 0.9); // dense wall around the playable area
        if (r >= 92) accept *= 0.5;
        if (rng() > accept) continue;

        const f1 = valueNoise(x * 0.025 + 40, z * 0.025 + 13), f2 = valueNoise(x * 0.04 + 9, z * 0.04 + 77), q = rng();
        let type;
        if (f1 > 0.6 && f2 > 0.45) type = q < 0.7 ? "birch" : "oak";
        else if (f1 < 0.36) type = q < 0.45 ? "oak" : q < 0.6 ? "autumn" : "pine";
        else type = q < 0.52 ? "pineA" : q < 0.78 ? "pineB" : q < 0.88 ? "oak" : q < 0.96 ? "birch" : "autumn";
        if (type === "pine") type = rng() < 0.5 ? "pineA" : "pineB";
        const s = 0.82 + rng() * 0.62;
        const crown = type === "birch" ? 1.0 : type === "oak" || type === "autumn" ? 2.1 : type === "pineB" ? 1.8 : 1.5;
        const minD = (r > 70 ? 4.4 : 3.1) + crown * s * 0.55;
        const cx = Math.floor(x / TC), cz = Math.floor(z / TC);
        let ok = true;
        for (let ix = cx - 1; ix <= cx + 1 && ok; ix++)
          for (let iz = cz - 1; iz <= cz + 1 && ok; iz++) {
            const l = tgrid.get(ix * 4096 + iz);
            if (!l) continue;
            for (const o of l) {
              const need = Math.max(minD, o.minD) * 0.82 + 0.25 * Math.min(minD, o.minD);
              if (Math.hypot(o.x - x, o.z - z) < need) { ok = false; break; }
            }
          }
        if (!ok) continue;
        const tr = { x, z, s, type, minD, ry: rng() * 6.28 };
        trees.push(tr);
        const k = cx * 4096 + cz;
        (tgrid.get(k) || tgrid.set(k, []).get(k)).push(tr);
      }
    }
    const treeBaseR = { pineA: 0.34, pineB: 0.38, oak: 0.42, autumn: 0.42, birch: 0.2 };
    trees.forEach((t) => {
      t.y = terrainHeight(t.x, t.z);
      t.group = t.type.startsWith("pine") ? "pine" : t.type === "birch" ? "birch" : "oak";
      if (Math.hypot(t.x, t.z) < PLAY_RADIUS + 3) addCollider(t.x, t.z, treeBaseR[t.type] * t.s * 0.9 + 0.1);
    });
    world.stats.trees = trees.length;

    /* ---------- terrain ---------- */
    await step("Shaping the land…", 18);
    const seg = Q.terrainSegs;
    const gGeo = new T.PlaneGeometry(GROUND, GROUND, seg, seg);
    gGeo.rotateX(-Math.PI / 2);
    {
      const p = gGeo.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, terrainHeight(p.getX(i), p.getZ(i)));
      gGeo.computeVertexNormals();
    }
    await step("Painting the forest floor…", 26);
    const macro = makeMacroTexture(Q.groundTex, trees.map((t) => ({ x: t.x, z: t.z, s: t.s, type: t.group })));
    const detail = makeDetailTexture();
    const groundMat = new T.MeshStandardMaterial({ map: macro, roughness: 1, metalness: 0 });
    groundMat.onBeforeCompile = (sh) => {
      sh.uniforms.uDetail = { value: detail };
      sh.fragmentShader = "uniform sampler2D uDetail;\n" + sh.fragmentShader.replace(
        "#include <map_fragment>",
        `vec4 sampledDiffuseColor = texture2D( map, vMapUv );
         vec3 d1 = texture2D( uDetail, vMapUv * 95.0 ).rgb;
         vec3 d2 = texture2D( uDetail, vMapUv * 26.0 + vec2( 0.37, 0.11 ) ).rgb;
         sampledDiffuseColor.rgb *= d1 * d2 * 4.0;
         diffuseColor *= sampledDiffuseColor;`
      );
    };
    const ground = new T.Mesh(gGeo, groundMat);
    ground.receiveShadow = true;
    root.add(ground);
    world.ground = ground;

    /* ---------- trees (instanced, chunked) ---------- */
    await step("Growing trees…", 38);
    const treeMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    FE.applyWind(treeMat, 0.0011);
    const broadMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    FE.applyWind(broadMat, 0.0024);
    const geos = {
      pineA: buildPine(11, { H: 9.5, tiers: 7, R: 1.95, leaf: 0x24592f, trunkTop: 0.12, trunkBase: 0.34 }),
      pineB: buildPine(23, { H: 7.6, tiers: 5, R: 2.5, leaf: 0x2f6a45, trunkTop: 0.14, trunkBase: 0.38 }),
      oak: buildBroadleaf(31, { H: 3.4, trunkTop: 0.2, trunkBase: 0.42, blobs: 7, blobR: 1.55, spread: 1.7, canopyLow: 1.0, canopyH: 1.5, palette: [0x3f7d34, 0x4f8c3a, 0x356f31, 0x5a9440], lean: 0.02 }),
      autumn: buildBroadleaf(47, { H: 3.2, trunkTop: 0.2, trunkBase: 0.42, blobs: 7, blobR: 1.5, spread: 1.6, canopyLow: 1.0, canopyH: 1.4, palette: [0xc9742a, 0xb8501f, 0xd9a032, 0xa8431d], lean: -0.015 }),
      birch: buildBroadleaf(59, { H: 5.2, trunkTop: 0.1, trunkBase: 0.2, blobs: 5, blobR: 1.05, spread: 0.95, canopyLow: 0.5, canopyH: 1.9, palette: [0x8bb34a, 0x9cc455, 0x79a33f], birch: true, lean: 0.03, flat: 0.9 }),
    };
    const tints = [0xffffff, 0xf0ffe8, 0xe8f2ff, 0xfff2e2, 0xdfeedd];
    const groups = {};
    trees.forEach((t) => {
      (groups[t.type] || (groups[t.type] = [])).push({
        x: t.x, y: t.y - 0.1, z: t.z, s: t.s, sy: t.s * (0.92 + hash2(Math.round(t.x * 10), Math.round(t.z * 10)) * 0.2),
        ry: t.ry, rx: (rng() - 0.5) * 0.04, rz: (rng() - 0.5) * 0.04, color: tints[Math.floor(rng() * tints.length)],
      });
    });
    world.treeChunks = [];
    for (const k in groups) {
      const mat = k.startsWith("pine") ? treeMat : broadMat;
      world.treeChunks.push(...buildChunks(root, geos[k], mat, groups[k], 40, { cast: true }));
    }

    /* ---------- grass, ferns, bushes, flowers ---------- */
    await step("Sowing grass…", 52);
    const grassMat = new T.MeshLambertMaterial({ vertexColors: true });
    FE.applyWind(grassMat, 0.13, [Q.grassFadeA, Q.grassFadeB]);
    const grassGeo = buildTuft({ seed: 5, blades: Q.bladesPerTuft, spread: 0.3, h: 0.6, w: 0.05, bend: 0.8, segs: 3, base: 0x1f3d17, tip: 0x9ac85a });
    const grassPal = [0x7ba644, 0x6a9a3c, 0x8cb04a, 0x5d8f38, 0x84a548, 0xa7a452];
    const grassItems = [];
    {
      const GR = 92;
      for (let i = 0, guard = 0; i < Q.grass && guard < Q.grass * 6; guard++) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * GR;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const pd = pathDist(x, z);
        if (pd < 0.9 + rng() * 0.8) continue;
        const dp = Math.hypot(x - POND.x, z - POND.z);
        if (dp < POND_EDGE + 0.3) continue;
        if (Math.hypot(x - CAMP.x, z - CAMP.z) < 3.2 + rng() * 2) continue;
        const lush = 0.35 + 0.65 * smoothstep(0.3, 0.7, valueNoise(x * 0.05 + 5, z * 0.05 + 5));
        if (rng() > lush) continue;
        const sc = 0.8 + rng() * 0.8;
        grassItems.push({ x, y: terrainHeight(x, z) - 0.02, z, sx: sc, sy: sc * (0.8 + rng() * 0.7), sz: sc, ry: rng() * 6.28, color: grassPal[Math.floor(rng() * (rng() < 0.1 ? 6 : 5))] });
        i++;
      }
    }
    world.grassChunks = buildChunks(root, grassGeo, grassMat, grassItems, 24, { cast: false, receive: !!Q.grassShadows });
    world.stats.grass = grassItems.length;

    await step("Adding undergrowth…", 62);
    const fernMat = new T.MeshLambertMaterial({ vertexColors: true });
    FE.applyWind(fernMat, 0.07);
    const fernItems = [];
    for (let i = 0, guard = 0; i < Q.ferns && trees.length && guard < Q.ferns * 6; guard++) {
      const t = trees[Math.floor(rng() * trees.length)];
      if (Math.hypot(t.x, t.z) > 95) continue;
      const a = rng() * 6.28, d = 1.0 + rng() * 3.2;
      const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
      if (pathDist(x, z) < 1.4 || Math.hypot(x - POND.x, z - POND.z) < POND_EDGE + 0.6) continue;
      const sc = 0.8 + rng() * 0.7;
      fernItems.push({ x, y: terrainHeight(x, z) - 0.03, z, s: sc, ry: rng() * 6.28, color: [0xffffff, 0xe9ffd8, 0xd8f0c0][Math.floor(rng() * 3)] });
      i++;
    }
    world.fernChunks = buildChunks(root, buildFern(9), fernMat, fernItems, 30, { cast: false, receive: false });

    const bushMats = [0x2f6b34, 0x3f7f3e, 0x58803a].map((h) => h);
    const bushMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    FE.applyWind(bushMat, 0.012);
    const bushGeo = buildBush(71, bushMats);
    const bushItems = [];
    for (let i = 0, guard = 0; i < Q.bushes && guard < Q.bushes * 8; guard++) {
      const a = rng() * 6.28, r = 6 + Math.sqrt(rng()) * 88;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (pathDist(x, z) < 1.8 || Math.hypot(x - POND.x, z - POND.z) < POND_EDGE + 1.2 || Math.hypot(x - CAMP.x, z - CAMP.z) < 4.5) continue;
      const sc = 0.7 + rng() * 0.9;
      bushItems.push({ x, y: terrainHeight(x, z) - 0.05, z, s: sc, sy: sc * (0.8 + rng() * 0.4), ry: rng() * 6.28, color: [0xffffff, 0xeaf6e0, 0xf6f0d8][Math.floor(rng() * 3)] });
      if (sc > 1.0 && Math.hypot(x, z) < PLAY_RADIUS) addCollider(x, z, 0.5 * sc);
      i++;
    }
    world.bushChunks = buildChunks(root, bushGeo, bushMat, bushItems, 40, { cast: true });

    await step("Scattering flowers…", 70);
    const stemMat = new T.MeshLambertMaterial({ vertexColors: true });
    FE.applyWind(stemMat, 0.16);
    const headMat = new T.MeshLambertMaterial({ vertexColors: true, side: T.FrontSide });
    FE.applyWind(headMat, 0.16);
    const stemGeo = buildTuft({ seed: 77, blades: 1, spread: 0.0, h: 0.42, w: 0.018, bend: 0.0, segs: 2, base: 0x2f5a22, tip: 0x5f8c3a });
    const headGeo = flowerHead();
    const flowerPal = [0xf4f1e8, 0xf2d45c, 0xa98ad8, 0xe58aa6, 0x7fa5e6, 0xf0a04a];
    const stemItems = [], headItems = [];
    for (let c = 0, guard = 0; c < Q.flowerClusters && guard < 2000; guard++) {
      const a = rng() * 6.28, r = 5 + Math.sqrt(rng()) * 80;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const dens = valueNoise(cx * 0.02 + 21, cz * 0.02 + 5) * 0.6 + valueNoise(cx * 0.07 + 2, cz * 0.07 + 9) * 0.4;
      if (dens > 0.55 || Math.hypot(cx - POND.x, cz - POND.z) < POND_EDGE + 1) continue;
      const col = flowerPal[Math.floor(rng() * flowerPal.length)];
      const n = 7 + Math.floor(rng() * 8);
      for (let k = 0; k < n; k++) {
        const aa = rng() * 6.28, dd = Math.sqrt(rng()) * 2.4;
        const x = cx + Math.cos(aa) * dd, z = cz + Math.sin(aa) * dd;
        if (pathDist(x, z) < 1.0) continue;
        const y = terrainHeight(x, z) - 0.02, sc = 0.8 + rng() * 0.6, ry = rng() * 6.28;
        stemItems.push({ x, y, z, s: sc, ry });
        headItems.push({ x, y, z, s: sc, ry, color: col });
      }
      c++;
    }
    world.flowerChunks = buildChunks(root, stemGeo, stemMat, stemItems, 30, { cast: false, receive: false })
      .concat(buildChunks(root, headGeo, headMat, headItems, 30, { cast: false, receive: false }));
    world.stats.flowers = stemItems.length;

    /* ---------- rocks, logs, stumps, litter, mushrooms ---------- */
    await step("Placing rocks & logs…", 78);
    const rockMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const rockGeos = [buildRock(3, 0x6d726b), buildRock(8, 0x7a766c), buildRock(13, 0x5e645f)];
    const rockItems = [[], [], []];
    function addRock(x, z, sc, collide) {
      const k = Math.floor(rng() * 3);
      const sx = sc * (0.9 + rng() * 0.5), sz = sc * (0.9 + rng() * 0.5), sy = sc * (0.55 + rng() * 0.4);
      rockItems[k].push({ x, y: terrainHeight(x, z) - sy * 0.3, z, sx, sy, sz, ry: rng() * 6.28, rx: (rng() - 0.5) * 0.3, rz: (rng() - 0.5) * 0.3 });
      if (collide && Math.hypot(x, z) < PLAY_RADIUS + 2) addCollider(x, z, Math.max(sx, sz) * 0.82);
    }
    for (let i = 0, guard = 0; i < Q.rocks && guard < Q.rocks * 10; guard++) {
      let x, z;
      if (rng() < 0.28) { const a = rng() * 6.28, d = POND_EDGE + rng() * 3.5; x = POND.x + Math.cos(a) * d; z = POND.z + Math.sin(a) * d; }
      else { const a = rng() * 6.28, r = 5 + Math.sqrt(rng()) * 92; x = Math.cos(a) * r; z = Math.sin(a) * r; }
      if (pathDist(x, z) < 1.8 || Math.hypot(x - CAMP.x, z - CAMP.z) < CAMP.R * 0.7) continue;
      if (Math.hypot(x - POND.x, z - POND.z) < POND_EDGE + 0.2) continue;
      const sc = rng() < 0.15 ? 0.9 + rng() * 0.9 : 0.25 + rng() * 0.55;
      addRock(x, z, sc, sc > 0.55);
      i++;
    }
    // standing stones
    const stoneMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const stoneGeo = buildRock(21, 0x686a66);
    const stoneItems = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      const x = STONES.x + Math.cos(a) * STONES.R, z = STONES.z + Math.sin(a) * STONES.R;
      const h = 2.0 + rng() * 1.2;
      stoneItems.push({ x, y: terrainHeight(x, z) - 0.2, z, sx: 0.75, sy: h, sz: 0.55, ry: -a + (rng() - 0.5) * 0.4, rz: (rng() - 0.5) * 0.12 });
      addCollider(x, z, 0.72);
    }
    stoneItems.push({ x: STONES.x, y: STONES_H - 0.35, z: STONES.z, sx: 1.9, sy: 0.7, sz: 1.5, ry: 0.4 });
    addCollider(STONES.x, STONES.z, 1.5);
    world.rockChunks = [];
    rockGeos.forEach((g, k) => world.rockChunks.push(...buildChunks(root, g, rockMat, rockItems[k], 40, { cast: true })));
    world.rockChunks.push(...buildChunks(root, stoneGeo, stoneMat, stoneItems, 40, { cast: true }));

    const logMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const logGeo = buildLog(3.4, 0.24, 5);
    const logItems = [];
    for (let i = 0, guard = 0; i < Q.logs && guard < 400; guard++) {
      const a = rng() * 6.28, r = 8 + Math.sqrt(rng()) * 80;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (pathDist(x, z) < 2.4 || Math.hypot(x - POND.x, z - POND.z) < POND.R + 1 || Math.hypot(x - CAMP.x, z - CAMP.z) < CAMP.R) continue;
      const ry = rng() * Math.PI, sc = 0.8 + rng() * 0.5;
      const y = terrainHeight(x, z) + 0.17 * sc;
      logItems.push({ x, y, z, sx: sc, sy: sc, sz: sc, ry });
      const dx = Math.cos(ry) * 1.2 * sc, dz = -Math.sin(ry) * 1.2 * sc;
      addCollider(x + dx, z + dz, 0.34 * sc); addCollider(x - dx, z - dz, 0.34 * sc); addCollider(x, z, 0.34 * sc);
      i++;
    }
    world.logChunks = buildChunks(root, logGeo, logMat, logItems, 40, { cast: true });

    const stumpMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const stumpItems = [];
    for (let i = 0, guard = 0; i < 16 && guard < 300; guard++) {
      const a = rng() * 6.28, r = 8 + Math.sqrt(rng()) * 75;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (pathDist(x, z) < 2.0 || Math.hypot(x - POND.x, z - POND.z) < POND.R || Math.hypot(x - CAMP.x, z - CAMP.z) < CAMP.R) continue;
      const sc = 0.8 + rng() * 0.7;
      stumpItems.push({ x, y: terrainHeight(x, z) - 0.05, z, s: sc, ry: rng() * 6.28 });
      addCollider(x, z, 0.44 * sc);
      i++;
    }
    buildChunks(root, buildStump(2), stumpMat, stumpItems, 60, { cast: true });

    // fallen leaves on the forest floor (tilted to the slope)
    const litterMat = new T.MeshLambertMaterial({ side: T.FrontSide });
    litterMat.polygonOffset = true; litterMat.polygonOffsetFactor = -2; litterMat.polygonOffsetUnits = -2;
    const litterGeo = new T.CircleGeometry(1, 7);
    litterGeo.rotateX(-Math.PI / 2);
    const litterPal = [0x7a5a2a, 0x8a6a30, 0x9a7a38, 0x6a5428, 0x9a5a28, 0xb08a38];
    const litterItems = [];
    const up = new T.Vector3(0, 1, 0), nv = new T.Vector3();
    for (let i = 0; i < Q.litter; i++) {
      const t = trees[Math.floor(rng() * trees.length)];
      if (!t || Math.hypot(t.x, t.z) > 100) continue;
      const a = rng() * 6.28, d = rng() * 4.5;
      const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
      if (Math.hypot(x - POND.x, z - POND.z) < POND_EDGE + 0.4) continue;
      const e = 0.6;
      nv.set(terrainHeight(x - e, z) - terrainHeight(x + e, z), 2 * e, terrainHeight(x, z - e) - terrainHeight(x, z + e)).normalize();
      const q = new T.Quaternion().setFromUnitVectors(up, nv);
      q.multiply(new T.Quaternion().setFromAxisAngle(up, rng() * 6.28));
      const sc = 0.45 + rng() * 0.9;
      litterItems.push({ x, y: terrainHeight(x, z) + 0.035, z, sx: sc * 1.2, sy: 1, sz: sc, q, color: litterPal[Math.floor(rng() * litterPal.length)] });
    }
    buildChunks(root, litterGeo, litterMat, litterItems, 50, { cast: false, receive: true });

    // mushrooms near tree bases
    const mushMat = new T.MeshLambertMaterial({ vertexColors: true });
    [[0xc8392b, 0], [0x8a5a35, 1], [0xe0b040, 2]].forEach(([hex, id]) => {
      const items = [];
      for (let i = 0; i < Q.mushrooms; i++) {
        const t = trees[Math.floor(rng() * trees.length)];
        if (!t || Math.hypot(t.x, t.z) > 85) continue;
        const a = rng() * 6.28, d = 0.7 + rng() * 2.2;
        const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
        if (pathDist(x, z) < 1.2) continue;
        items.push({ x, y: terrainHeight(x, z) - 0.01, z, s: 0.9 + rng() * 0.9, ry: rng() * 6.28 });
      }
      buildChunks(root, buildMushrooms(hex, 90 + id), mushMat, items, 60, { cast: false, receive: false });
    });

    /* ---------- pond ---------- */
    await step("Filling the pond…", 86);
    const waterNormal = makeWaterNormal();
    const waterMat = new T.MeshStandardMaterial({
      color: 0x2e6670, roughness: 0.1, metalness: 0.15, transparent: true, opacity: 0.86,
      normalMap: waterNormal, normalScale: new T.Vector2(0.35, 0.35),
    });
    const water = new T.Mesh(new T.CircleGeometry(POND.R * 1.05, 56), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(POND.x, WATER_Y, POND.z);
    water.receiveShadow = true;
    root.add(water);
    addCollider(POND.x, POND.z, POND_EDGE - 0.35);

    // reeds around the rim
    const reedMat = new T.MeshLambertMaterial({ vertexColors: true });
    FE.applyWind(reedMat, 0.06);
    const reedGeo = buildTuft({ seed: 31, blades: 5, spread: 0.35, h: 1.5, w: 0.07, bend: 0.5, segs: 4, base: 0x3c4f22, tip: 0xa9b05a });
    const reedItems = [];
    for (let i = 0; i < 150; i++) {
      const a = rng() * 6.28, d = POND_EDGE - 0.6 + rng() * 3.2;
      const x = POND.x + Math.cos(a) * d, z = POND.z + Math.sin(a) * d;
      if (pathDist(x, z) < 1.4) continue;
      const y = terrainHeight(x, z);
      if (y < WATER_Y - 0.5) continue;
      reedItems.push({ x, y: y - 0.05, z, sx: 0.9 + rng() * 0.6, sy: 0.7 + rng() * 0.9, sz: 0.9 + rng() * 0.6, ry: rng() * 6.28 });
    }
    buildChunks(root, reedGeo, reedMat, reedItems, 40, { cast: false, receive: false });

    // lily pads
    const padGeo = new T.CircleGeometry(0.34, 10, 0.3, Math.PI * 2 - 0.5);
    padGeo.rotateX(-Math.PI / 2);
    const padMat = new T.MeshLambertMaterial({ color: 0x3d7a3e });
    const padItems = [];
    for (let i = 0; i < 18; i++) {
      const a = rng() * 6.28, d = rng() * (POND_EDGE - 1.2);
      padItems.push({ x: POND.x + Math.cos(a) * d, y: WATER_Y + 0.03, z: POND.z + Math.sin(a) * d, s: 0.7 + rng() * 0.9, ry: rng() * 6.28 });
    }
    buildChunks(root, padGeo, padMat, padItems, 40, { cast: false, receive: false });

    /* ---------- campfire ---------- */
    await step("Lighting the campfire…", 91);
    const camp = new T.Group();
    camp.position.set(CAMP.x, CAMP_H, CAMP.z);
    root.add(camp);
    const fireStoneGeo = buildRock(40, 0x6b6b66);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const m = new T.Mesh(fireStoneGeo, rockMat);
      m.position.set(Math.cos(a) * 0.95, 0.05, Math.sin(a) * 0.95);
      m.scale.set(0.24, 0.17, 0.2);
      m.rotation.y = -a;
      m.castShadow = true; m.receiveShadow = true;
      camp.add(m);
    }
    const fireLogGeo = buildLog(1.5, 0.1, 17);
    for (let i = 0; i < 3; i++) {
      const m = new T.Mesh(fireLogGeo, logMat);
      m.position.y = 0.2 + (i % 2) * 0.08;
      m.rotation.set(0, (i / 3) * Math.PI + 0.3, (i - 1) * 0.25);
      m.castShadow = true;
      camp.add(m);
    }
    const seatGeo = buildLog(1.9, 0.22, 23);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.6;
      const x = CAMP.x + Math.cos(a) * 3.1, z = CAMP.z + Math.sin(a) * 3.1;
      const m = new T.Mesh(seatGeo, logMat);
      m.position.set(x, terrainHeight(x, z) + 0.2, z);
      m.rotation.y = -a + Math.PI / 2;
      m.castShadow = true; m.receiveShadow = true;
      root.add(m);
      const dx = Math.cos(m.rotation.y) * 0.6, dz = -Math.sin(m.rotation.y) * 0.6;
      addCollider(x + dx, z + dz, 0.38); addCollider(x - dx, z - dz, 0.38);
    }
    addCollider(CAMP.x, CAMP.z, 1.2);
    // flames
    const flameMats = [], flames = [];
    [[0xff5a1a, 0.55, 1.1, 0.30], [0xff8a2a, 0.45, 0.85, 0.22], [0xffc24a, 0.32, 0.6, 0.15]].forEach(([hex, rad, h, op], i) => {
      const mat = new T.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false });
      const cone = new T.Mesh(new T.ConeGeometry(rad * 0.6, h, 7, 1, true), mat);
      cone.position.y = h / 2 + 0.2;
      cone.userData = { h, phase: i * 1.7 };
      camp.add(cone);
      flames.push(cone); flameMats.push(mat);
    });
    const fireLight = new T.PointLight(0xff8a3a, 0, 24, 1.7);
    fireLight.position.set(CAMP.x, CAMP_H + 1.2, CAMP.z);
    root.add(fireLight);
    // glow sprite
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 64;
    { const g = glowCanvas.getContext("2d"); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, "rgba(255,170,80,0.9)"); gr.addColorStop(0.4, "rgba(255,110,30,0.35)"); gr.addColorStop(1, "rgba(255,80,10,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
    const glow = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(glowCanvas), blending: T.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    glow.scale.set(3.2, 3.2, 1);
    glow.position.set(0, 0.9, 0);
    camp.add(glow);

    /* ---------- particles (fireflies, pollen motes, embers) ---------- */
    await step("Releasing fireflies…", 95);
    const PVERT = /* glsl */ `
      attribute vec4 aSeed;
      uniform vec3 uCenter; uniform float uTime, uScale, uSize, uBox, uHeight, uDrift;
      varying float vA; varying float vSeed;
      void main(){
        vec3 b = position;
        vec3 p;
        p.xz = uCenter.xz + mod(b.xz + vec2(sin(uTime * 0.13 + aSeed.x * 40.0), cos(uTime * 0.11 + aSeed.y * 40.0)) * uDrift + uTime * vec2(0.12, 0.05) * uDrift - uCenter.xz + uBox * 0.5, uBox) - uBox * 0.5;
        p.y = uCenter.y + 0.3 + b.y * uHeight + sin(uTime * 0.5 + aSeed.z * 30.0) * 0.35;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = length(p.xz - uCenter.xz);
        vA = smoothstep(uBox * 0.5, uBox * 0.5 - 7.0, dist);
        vSeed = aSeed.w;
        gl_PointSize = uSize * uScale / max(0.5, -mv.z);
      }`;
    const PFRAG = /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha, uTime, uBlink;
      varying float vA; varying float vSeed;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        a *= a;
        float bl = mix(1.0, pow(sin(uTime * (0.8 + vSeed * 1.4) + vSeed * 40.0) * 0.5 + 0.5, 3.0), uBlink);
        gl_FragColor = vec4(uColor, a * vA * bl * uAlpha);
      }`;
    function makePoints(n, opts) {
      const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = rng() * opts.box; pos[i * 3 + 1] = rng(); pos[i * 3 + 2] = rng() * opts.box;
        for (let k = 0; k < 4; k++) seed[i * 4 + k] = rng();
      }
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(pos, 3));
      g.setAttribute("aSeed", new T.BufferAttribute(seed, 4));
      const mat = new T.ShaderMaterial({
        transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false,
        uniforms: {
          uCenter: { value: new T.Vector3() }, uTime: { value: 0 }, uScale: { value: 500 }, uSize: { value: opts.size },
          uBox: { value: opts.box }, uHeight: { value: opts.height }, uDrift: { value: opts.drift },
          uColor: { value: new T.Color(opts.color) }, uAlpha: { value: 0 }, uBlink: { value: opts.blink },
        },
        vertexShader: PVERT, fragmentShader: PFRAG,
      });
      const pts = new T.Points(g, mat);
      pts.frustumCulled = false;
      root.add(pts);
      return pts;
    }
    const fireflies = makePoints(Q.particles, { box: 56, height: 3.2, drift: 3.0, size: 0.16, color: 0xc9ff5a, blink: 1 });
    const motes = makePoints(Q.particles * 2, { box: 44, height: 4.5, drift: 2.0, size: 0.07, color: 0xfff1c8, blink: 0 });

    // embers rising from the campfire
    const embN = 40;
    const embPos = new Float32Array(embN * 3), embSeed = new Float32Array(embN * 4);
    for (let i = 0; i < embN; i++) { embSeed[i * 4] = rng(); embSeed[i * 4 + 1] = rng(); embSeed[i * 4 + 2] = rng(); embSeed[i * 4 + 3] = rng(); }
    const embGeo = new T.BufferGeometry();
    embGeo.setAttribute("position", new T.BufferAttribute(embPos, 3));
    embGeo.setAttribute("aSeed", new T.BufferAttribute(embSeed, 4));
    const embMat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 }, uScale: { value: 500 }, uOrigin: { value: new T.Vector3(CAMP.x, CAMP_H + 0.5, CAMP.z) } },
      vertexShader: `
        attribute vec4 aSeed; uniform float uTime, uScale; uniform vec3 uOrigin; varying float vA;
        void main(){
          float t = fract(uTime * (0.12 + aSeed.x * 0.12) + aSeed.y);
          vec3 p = uOrigin + vec3((aSeed.z - 0.5) * 0.6 + sin(uTime + aSeed.w * 20.0) * 0.5 * t, t * (2.5 + aSeed.x * 2.0), (aSeed.w - 0.5) * 0.6 + cos(uTime * 0.8 + aSeed.z * 20.0) * 0.5 * t);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vA = (1.0 - t) * smoothstep(0.0, 0.1, t);
          gl_PointSize = 0.07 * uScale / max(0.5, -mv.z);
        }`,
      fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(1.0, 0.55, 0.15, a * vA); }`,
    });
    const embers = new T.Points(embGeo, embMat);
    embers.frustumCulled = false;
    root.add(embers);

    /* ---------- runtime ---------- */
    function update(dt, time, camPos, groundY, env, viewH) {
      // distance-cull grass chunks (they also shrink in the shader before disappearing)
      const far = Q.grassFadeB + 20;
      for (const ch of world.grassChunks) {
        const dx = ch.userData.cx - camPos.x, dz = ch.userData.cz - camPos.z;
        ch.visible = dx * dx + dz * dz < far * far;
      }
      const ffar = 70;
      for (const list of [world.flowerChunks, world.fernChunks]) {
        for (const ch of list) { const dx = ch.userData.cx - camPos.x, dz = ch.userData.cz - camPos.z; ch.visible = dx * dx + dz * dz < ffar * ffar; }
      }
      // campfire
      const fl = 0.85 + 0.15 * Math.sin(time * 13.1) * Math.sin(time * 7.3 + 1.0) + 0.1 * Math.sin(time * 23.0);
      fireLight.intensity = 38 * fl * (0.55 + 0.45 * (1 - env.day * 0.7));
      flames.forEach((f) => {
        const k = 0.85 + 0.3 * Math.sin(time * 9 + f.userData.phase) * Math.sin(time * 5.3 + f.userData.phase * 2);
        f.scale.set(1 + 0.12 * Math.sin(time * 11 + f.userData.phase), k, 1 + 0.12 * Math.cos(time * 9 + f.userData.phase));
        f.rotation.y += dt * 1.5;
      });
      glow.material.opacity = 0.8 + 0.2 * fl;
      // water shimmer
      waterNormal.offset.x = (time * 0.006) % 1;
      waterNormal.offset.y = (time * 0.0035) % 1;
      // particles
      const pts = [fireflies, motes];
      pts.forEach((p) => { p.material.uniforms.uCenter.value.set(camPos.x, groundY, camPos.z); p.material.uniforms.uTime.value = time; p.material.uniforms.uScale.value = viewH * 0.5; });
      fireflies.material.uniforms.uAlpha.value = env.night * 0.95 + env.twi * 0.3;
      motes.material.uniforms.uAlpha.value = env.day * 0.5;
      embMat.uniforms.uTime.value = time;
      embMat.uniforms.uScale.value = viewH * 0.5;
      world.fireDist = Math.hypot(camPos.x - CAMP.x, camPos.z - CAMP.z);
      world.waterDist = Math.hypot(camPos.x - POND.x, camPos.z - POND.z) - POND_EDGE;
    }

    world.update = update;
    world.resolve = resolve;
    world.height = terrainHeight;
    world.pathDist = pathDist;
    world.colliders = colliders;
    world.SPAWN = SPAWN; world.POND = POND; world.CAMP = CAMP; world.STONES = STONES;
    world.PLAY_RADIUS = PLAY_RADIUS; world.WATER_Y = WATER_Y; world.POND_EDGE = POND_EDGE;
    world.stats.colliders = colliders.length;
    await step("Ready", 100);
    return world;
  };
})();
