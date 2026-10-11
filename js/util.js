/* Forest Explorer - shared helpers: RNG, noise, geometry building, wind shader patch. */
(function () {
  "use strict";
  const FE = (window.FE = window.FE || {});
  if (!window.THREE) return;
  const T = window.THREE;

  /* ---------- random / noise ---------- */
  FE.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  function hash2(x, z) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  FE.hash2 = hash2;

  function valueNoise(x, z) {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const xf = x - x0, zf = z - z0;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    const a = hash2(x0, z0), b = hash2(x0 + 1, z0), c = hash2(x0, z0 + 1), d = hash2(x0 + 1, z0 + 1);
    const top = a + (b - a) * u, bot = c + (d - c) * u;
    return top + (bot - top) * v;
  }
  FE.valueNoise = valueNoise;

  /* Tileable noise (lattice wraps every `period` cells) for repeating textures. */
  FE.periodicNoise = function (x, z, period, seed) {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const xf = x - x0, zf = z - z0;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    const w = (n) => ((n % period) + period) % period;
    const xa = w(x0), xb = w(x0 + 1), za = w(z0), zb = w(z0 + 1);
    const s = seed * 7919;
    const a = hash2(xa + s, za), b = hash2(xb + s, za), c = hash2(xa + s, zb), d = hash2(xb + s, zb);
    const top = a + (b - a) * u, bot = c + (d - c) * u;
    return top + (bot - top) * v;
  };

  FE.smoothstep = function (a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  FE.clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  FE.lerp = (a, b, t) => a + (b - a) * t;

  /* ---------- geometry building ---------- */
  /* Colour every vertex with fn(color, x, y, z). Colours are stored linear. */
  FE.paint = function (geo, fn) {
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const c = new T.Color();
    for (let i = 0; i < pos.count; i++) {
      fn(c, pos.getX(i), pos.getY(i), pos.getZ(i));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new T.BufferAttribute(col, 3));
    return geo;
  };

  /* Deterministic per-position displacement; coincident vertices move together. */
  FE.jitter = function (geo, amt, seed, yAmt) {
    const p = geo.attributes.position;
    const ya = yAmt === undefined ? amt : yAmt;
    seed = seed || 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const kx = Math.round(x * 400), ky = Math.round(y * 400), kz = Math.round(z * 400);
      const h1 = hash2(kx + seed * 7, kz * 13 + ky);
      const h2 = hash2(ky + seed * 11, kx * 17 + kz + 5);
      const h3 = hash2(kz + seed * 3, ky * 19 + kx + 9);
      p.setXYZ(i, x + (h1 - 0.5) * amt, y + (h2 - 0.5) * ya, z + (h3 - 0.5) * amt);
    }
    p.needsUpdate = true;
    return geo;
  };

  /* Merge geometries (position/normal/color only) into one flat-shaded geometry. */
  FE.merge = function (list) {
    const gs = list.map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      n.deleteAttribute("uv");
      n.computeVertexNormals();
      return n;
    });
    let total = 0;
    gs.forEach((g) => (total += g.attributes.position.count));
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
    let o = 0;
    gs.forEach((g) => {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
      else col.fill(1, o * 3, (o + g.attributes.position.count) * 3);
      o += g.attributes.position.count;
    });
    const out = new T.BufferGeometry();
    out.setAttribute("position", new T.BufferAttribute(pos, 3));
    out.setAttribute("normal", new T.BufferAttribute(nor, 3));
    out.setAttribute("color", new T.BufferAttribute(col, 3));
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  };

  /* Build a geometry from raw triangle arrays (both windings so it is lit from either side). */
  FE.rawGeometry = function (pos, col, nor) {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new T.Float32BufferAttribute(col, 3));
    g.setAttribute("normal", new T.Float32BufferAttribute(nor, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  };

  /* ---------- wind ---------- */
  FE.windU = {
    uTime: { value: 0 },
    uWind: { value: 0.6 },
    uDir: { value: new T.Vector2(0.8, 0.6).normalize() },
  };

  const WIND_VERT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
float lh = max( transformed.y, 0.0 );
float baseY = 0.0;
#ifdef USE_INSTANCING
  lh *= length( instanceMatrix[1].xyz );
  baseY = instanceMatrix[3].y;
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 wp = modelMatrix * mvPosition;
float ph = wp.x * 0.23 + wp.z * 0.31;
float gust = sin( uTime * 0.9 + wp.x * 0.045 + wp.z * 0.035 ) * 0.5 + 0.5;
float sway = sin( uTime * ( 1.4 + uWind * 0.6 ) + ph ) * 0.6 + sin( uTime * 2.9 + ph * 1.9 ) * 0.25 + gust * 0.9;
float wamt = WIND_AMP * lh * lh * ( 0.35 + uWind ) * sway;
wp.xz += uDir * wamt;
wp.xz += vec2( -uDir.y, uDir.x ) * WIND_AMP * lh * lh * 0.35 * sin( uTime * 2.3 + ph * 2.4 );
#ifdef GRASS_FADE
  float fd = distance( wp.xz, cameraPosition.xz );
  float fk = 1.0 - smoothstep( FADE_A, FADE_B, fd );
  wp.y = baseY + ( wp.y - baseY ) * fk;
#endif
mvPosition = viewMatrix * wp;
gl_Position = projectionMatrix * mvPosition;
`;

  /* Adds wind sway (and optional distance shrink for grass) to a Lambert/Standard material. */
  FE.applyWind = function (material, amp, fade) {
    material.defines = Object.assign({}, material.defines, { WIND_AMP: amp.toFixed(5) });
    if (fade) {
      material.defines.GRASS_FADE = "";
      material.defines.FADE_A = fade[0].toFixed(1);
      material.defines.FADE_B = fade[1].toFixed(1);
    }
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = FE.windU.uTime;
      shader.uniforms.uWind = FE.windU.uWind;
      shader.uniforms.uDir = FE.windU.uDir;
      shader.vertexShader =
        "uniform float uTime;\nuniform float uWind;\nuniform vec2 uDir;\n" +
        shader.vertexShader.replace("#include <project_vertex>", WIND_VERT);
    };
    material.customProgramCacheKey = () => "wind";
    return material;
  };

  /* Place instances into spatial chunks so the renderer can frustum-cull them. */
  FE.buildChunks = function (parent, geometry, material, items, cell, opts) {
    opts = opts || {};
    const groups = new Map();
    for (const it of items) {
      const key = Math.floor(it.x / cell) + "," + Math.floor(it.z / cell);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(it);
    }
    const m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), s = new T.Vector3(), p = new T.Vector3();
    const col = new T.Color();
    const chunks = [];
    for (const list of groups.values()) {
      const mesh = new T.InstancedMesh(geometry, material, list.length);
      let cx = 0, cz = 0;
      list.forEach((it, i) => {
        e.set(it.rx || 0, it.ry || 0, it.rz || 0, "YXZ");
        q.setFromEuler(e);
        if (it.q) q.copy(it.q);
        s.set(it.sx !== undefined ? it.sx : it.s || 1, it.sy !== undefined ? it.sy : it.s || 1, it.sz !== undefined ? it.sz : it.s || 1);
        p.set(it.x, it.y, it.z);
        m4.compose(p, q, s);
        mesh.setMatrixAt(i, m4);
        if (it.color !== undefined) {
          col.set(it.color);
          mesh.setColorAt(i, col);
        }
        cx += it.x; cz += it.z;
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = !!opts.cast;
      mesh.receiveShadow = opts.receive !== false;
      mesh.computeBoundingSphere();
      // wind moves tips a little: pad the bounds so edge chunks never pop
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 2;
      mesh.userData.cx = cx / list.length;
      mesh.userData.cz = cz / list.length;
      parent.add(mesh);
      chunks.push(mesh);
    }
    return chunks;
  };

  FE.hex = (h) => new T.Color(h);
})();
