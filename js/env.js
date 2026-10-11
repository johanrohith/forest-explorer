/* Forest Explorer - sky dome, sun/moon, lights, fog and the day/night cycle. */
(function () {
  "use strict";
  const FE = (window.FE = window.FE || {});
  if (!window.THREE) return;
  const T = window.THREE;
  const { smoothstep, lerp } = FE;

  const PAL = {
    day:   { top: 0x3d80bb, mid: 0x86b7d3, hor: 0xb3cdc5 },
    twi:   { top: 0x36527f, mid: 0xc98b7c, hor: 0xe6b48d },
    night: { top: 0x040a1a, mid: 0x0a1630, hor: 0x16263c },
  };
  const C = {};
  for (const k in PAL) { C[k] = {}; for (const n in PAL[k]) C[k][n] = new T.Color(PAL[k][n]); }

  const SKY_VERT = /* glsl */ `
    varying vec3 vDir;
    void main(){
      vDir = normalize(position);
      vec4 p = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * p;
      gl_Position.z = gl_Position.w * 0.99995;
    }`;

  const SKY_FRAG = /* glsl */ `
    uniform vec3 uTop, uMid, uHor, uSunDir, uMoonDir, uSunCol, uCloudCol;
    uniform float uTime, uNight, uCloud;
    varying vec3 vDir;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p){
      float a = 0.5, s = 0.0;
      for (int i = 0; i < CLOUD_OCT; i++){ s += a * noise(p); p = p * 2.03 + vec2(11.7, 3.1); a *= 0.5; }
      return s;
    }
    void main(){
      vec3 d = normalize(vDir);
      float h = max(d.y, 0.0);
      vec3 col = mix(uHor, uMid, smoothstep(0.0, 0.28, h));
      col = mix(col, uTop, smoothstep(0.22, 0.95, h));

      float sd = max(dot(d, uSunDir), 0.0);
      col += uSunCol * (pow(sd, 6.0) * 0.22 + pow(sd, 48.0) * 0.45);
      col += uSunCol * 1.75 * smoothstep(0.99925, 0.99975, sd);

      float md = max(dot(d, uMoonDir), 0.0);
      col += vec3(0.75, 0.82, 1.0) * (smoothstep(0.9991, 0.9995, md) * 1.6 + pow(md, 40.0) * 0.10) * uNight;

      if (uNight > 0.02 && d.y > 0.02) {
        vec3 q = d * 150.0;
        vec3 id = floor(q);
        float r = fract(sin(dot(id, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        vec3 f = fract(q) - 0.5;
        float m = smoothstep(0.32, 0.0, length(f));
        float tw = 0.55 + 0.45 * sin(uTime * 2.0 + r * 60.0);
        col += vec3(step(0.9968, r) * m * tw) * uNight * smoothstep(0.02, 0.3, d.y);
      }

      if (d.y > 0.02) {
        vec2 uv = d.xz / (d.y + 0.2) * 1.15 + vec2(uTime * 0.006, uTime * 0.002);
        float c = smoothstep(0.50, 0.86, fbm(uv * 1.7)) * uCloud;
        float edge = smoothstep(0.02, 0.22, d.y);
        vec3 cc = uCloudCol * (0.8 + 0.4 * pow(sd, 3.0));
        col = mix(col, cc, c * edge * 0.92);
      }
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`;

  FE.createEnvironment = function (scene, renderer, Q, handScene) {
    const state = {
      t: 0.4, sunH: 0.8, day: 1, night: 0, twi: 0, sunDir: new T.Vector3(), windStrength: 0.6, label: "☀️ DAYLIGHT",
    };

    /* sky dome */
    const skyMat = new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, depthTest: false, fog: false,
      defines: { CLOUD_OCT: Q.cloudOct },
      uniforms: {
        uTop: { value: new T.Color() }, uMid: { value: new T.Color() }, uHor: { value: new T.Color() },
        uSunDir: { value: new T.Vector3(0, 1, 0) }, uMoonDir: { value: new T.Vector3(0, -1, 0) },
        uSunCol: { value: new T.Color(1, 0.9, 0.7) }, uCloudCol: { value: new T.Color(1, 1, 1) },
        uTime: { value: 0 }, uNight: { value: 0 }, uCloud: { value: 0.75 },
      },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    });
    const sky = new T.Mesh(new T.SphereGeometry(200, 32, 20), skyMat);
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    scene.add(sky);

    /* lights */
    const hemi = new T.HemisphereLight(0xbdd7e2, 0x26371f, 1.4);
    scene.add(hemi);

    const sun = new T.DirectionalLight(0xffe5b8, 3.4);
    sun.castShadow = !!Q.shadows;
    sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
    const S = Q.shadowRadius;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 220 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.05;
    sun.shadow.radius = 2.5;
    scene.add(sun, sun.target);

    const moon = new T.DirectionalLight(0x9db4ff, 0.0);
    scene.add(moon, moon.target);

    scene.fog = new T.FogExp2(0xb3cdc5, 0.01);

    /* lights for the first-person hand (separate scene) */
    const handHemi = new T.HemisphereLight(0xdfeaf2, 0x2b3a22, 1.2);
    const handSun = new T.DirectionalLight(0xfff0d0, 2.0);
    handSun.position.set(-1, 1.6, 1.2);
    handScene.add(handHemi, handSun);

    const tmpA = new T.Color(), tmpB = new T.Color();
    const right = new T.Vector3(), up = new T.Vector3(), fwd = new T.Vector3(), snap = new T.Vector3();

    function mix3(key) {
      const wd = smoothstep(0.0, 0.34, state.sunH);
      const wn = 1 - smoothstep(-0.30, 0.0, state.sunH);
      const wt = Math.max(0, 1 - wd - wn);
      const out = new T.Color(0, 0, 0);
      out.r = C.day[key].r * wd + C.twi[key].r * wt + C.night[key].r * wn;
      out.g = C.day[key].g * wd + C.twi[key].g * wt + C.night[key].g * wn;
      out.b = C.day[key].b * wd + C.twi[key].b * wt + C.night[key].b * wn;
      return { c: out, wd, wt, wn };
    }

    function setTime(t) {
      state.t = ((t % 1) + 1) % 1;
      const a = (state.t - 0.25) * Math.PI * 2;
      const s = Math.sin(a);
      state.sunH = s;
      state.sunDir.set(Math.cos(a) * 0.85, s, 0.25).normalize();

      const top = mix3("top"), mid = mix3("mid"), hor = mix3("hor");
      state.day = top.wd; state.night = top.wn; state.twi = top.wt;

      const u = skyMat.uniforms;
      u.uTop.value.copy(top.c); u.uMid.value.copy(mid.c); u.uHor.value.copy(hor.c);
      u.uSunDir.value.copy(state.sunDir);
      u.uMoonDir.value.copy(state.sunDir).multiplyScalar(-1);
      u.uNight.value = state.night;

      const lowSun = 1 - smoothstep(0.0, 0.45, s);
      tmpA.setHex(0xff8a4a); tmpB.setHex(0xfff0d8);
      const sunCol = tmpB.clone().lerp(tmpA, lowSun);
      u.uSunCol.value.copy(sunCol).multiplyScalar(smoothstep(-0.1, 0.12, s));

      // clouds: white by day, warm at dusk, dim blue at night
      const cc = u.uCloudCol.value;
      cc.setRGB(1, 1, 1).lerp(tmpA.setHex(0xffb98a), state.twi * 0.8).lerp(tmpB.setHex(0x1a2640), state.night);

      // lights
      const sunI = 2.7 * smoothstep(-0.03, 0.3, s);
      sun.intensity = sunI;
      sun.color.copy(sunCol);
      moon.intensity = 0.75 * (1 - smoothstep(-0.28, 0.02, s));
      hemi.color.setHex(0xbfdcf0).lerp(tmpA.setHex(0xd7a58b), state.twi).lerp(tmpB.setHex(0x2a4278), state.night);
      hemi.groundColor.setHex(0x3a4a2a).lerp(tmpA.setHex(0x3a2a22), state.twi).lerp(tmpB.setHex(0x0e1620), state.night);
      hemi.intensity = lerp(0.78, 1.55, state.day) * (1 - state.night) + 0.58 * state.night + 0.24 * state.twi;

      // fog matches the horizon so the world fades seamlessly into the sky
      scene.fog.color.copy(hor.c);
      scene.fog.density = 0.012 * state.day + 0.015 * state.twi + 0.0145 * state.night;

      // hand lights follow the world's lighting
      handHemi.intensity = 0.72 + 0.92 * state.day + 0.22 * state.twi + 0.18 * state.night;
      handHemi.color.copy(hemi.color).lerp(tmpB.setHex(0xffffff), 0.52);
      handSun.intensity = 0.32 + 1.35 * smoothstep(-0.03, 0.3, s);
      handSun.color.copy(sunCol);

      // clock label
      const hrs = state.t * 24;
      const hh = Math.floor(hrs), mm = Math.floor((hrs - hh) * 60);
      state.clock = (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
      state.label = s > 0.28 ? "☀️ DAYLIGHT" : s > -0.06 ? (state.t < 0.5 ? "🌅 MORNING" : "🌇 EVENING") : "🌙 NIGHT";
    }

    /* Keep the sky centred on the camera and the shadow frustum centred on the player. */
    function follow(camPos, groundY) {
      sky.position.copy(camPos);
      // light direction used for shadows never gets lower than ~17 degrees (avoids huge stretched shadows)
      const d = state.sunDir.clone();
      if (d.y < 0.3) { d.y = 0.3; d.normalize(); }
      const half = Q.shadowRadius;
      const texel = (2 * half) / Q.shadowSize;
      // snap the shadow focus to the shadow-map texel grid to stop shimmering
      fwd.copy(d).multiplyScalar(-1);
      right.set(0, 1, 0).cross(fwd).normalize();
      up.copy(fwd).cross(right).normalize();
      const px = camPos.x, py = groundY, pz = camPos.z;
      const rx = right.x * px + right.y * py + right.z * pz;
      const ry = up.x * px + up.y * py + up.z * pz;
      const rz = fwd.x * px + fwd.y * py + fwd.z * pz;
      const sx = Math.round(rx / texel) * texel, sy = Math.round(ry / texel) * texel;
      snap.set(0, 0, 0).addScaledVector(right, sx).addScaledVector(up, sy).addScaledVector(fwd, rz);
      sun.target.position.copy(snap);
      sun.position.copy(snap).addScaledVector(d, 110);
      sun.target.updateMatrixWorld();
      moon.target.position.set(camPos.x, groundY, camPos.z);
      moon.position.set(camPos.x - state.sunDir.x * 80, camPos.y - state.sunDir.y * 80, camPos.z - state.sunDir.z * 80);
      moon.target.updateMatrixWorld();
    }

    function tick(dt, time) { skyMat.uniforms.uTime.value = time; }

    setTime(state.t);
    return { state, sky, sun, moon, hemi, setTime, follow, tick, handHemi, handSun };
  };
})();
