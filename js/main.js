/* Forest Explorer - renderer, player, input, UI and game loop. */
(function () {
  "use strict";
  const FE = (window.FE = window.FE || {});
  const $ = (id) => document.getElementById(id);
  const mount = $("game");

  function fatal(msg) {
    const s = $("startSub");
    if (s) { s.innerHTML = msg; s.classList.add("err"); }
    const b = $("btnEnter");
    if (b) { b.textContent = "Unavailable"; b.disabled = true; }
    const bar = document.querySelector(".bar");
    if (bar) bar.style.display = "none";
  }

  if (!window.THREE || !FE.buildWorld) {
    fatal("The 3D engine could not initialize. Try reloading in a browser with WebGL support.");
    return;
  }
  const T = window.THREE;
  const { clamp, lerp, smoothstep } = FE;

  /* ---------------- device + quality ---------------- */
  const params = new URLSearchParams(location.search);
  const coarse = window.matchMedia && matchMedia("(pointer: coarse)").matches;
  const smallScreen = Math.min(innerWidth, innerHeight) < 600;
  let qName = params.get("quality");
  if (qName !== "low" && qName !== "high") qName = coarse || smallScreen ? "low" : "high";
  const QUALITY = {
    high: {
      trees: 1150, terrainSegs: 256, groundTex: 1024, grass: 24000, bladesPerTuft: 6, grassFadeA: 30, grassFadeB: 46, grassShadows: true,
      ferns: 800, bushes: 240, flowerClusters: 55, rocks: 150, logs: 20, litter: 700, mushrooms: 34, particles: 120,
      cloudOct: 3, shadows: true, shadowSize: 2048, shadowRadius: 46, maxPixelRatio: 1.75,
    },
    low: {
      trees: 640, terrainSegs: 176, groundTex: 768, grass: 9000, bladesPerTuft: 4, grassFadeA: 24, grassFadeB: 38, grassShadows: false,
      ferns: 380, bushes: 130, flowerClusters: 30, rocks: 90, logs: 14, litter: 330, mushrooms: 18, particles: 60,
      cloudOct: 2, shadows: true, shadowSize: 1024, shadowRadius: 40, maxPixelRatio: 1.25,
    },
  };
  const Q = QUALITY[qName];
  $("qualityLabel").textContent = (qName === "low" ? "Mobile-optimised" : "High") + " quality";

  /* ---------------- renderer ---------------- */
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: qName === "high", powerPreference: "high-performance", alpha: false, stencil: false });
  } catch (e) {
    fatal("WebGL is not available in this browser, so the 3D forest cannot start.");
    return;
  }
  let pixelRatio = Math.min(window.devicePixelRatio || 1, Q.maxPixelRatio);
  const minPixelRatio = 0.6;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  mount.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); pause(); $("menu").classList.add("hidden"); $("start").classList.remove("hidden"); fatal("The graphics context was lost. Please reload the page."); });
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(72, 1, 0.08, 330);
  camera.rotation.order = "YXZ";
  scene.add(camera);

  /* hand lives in its own scene, rendered on top of the world (never clipped by trees) */
  const handScene = new T.Scene();
  const handCam = new T.PerspectiveCamera(50, 1, 0.01, 10);

  const env = FE.createEnvironment(scene, renderer, Q, handScene);
  const audio = FE.createAudio();

  /* ---------------- first-person hand ---------------- */
  const hand = (function () {
    const skin = new T.MeshStandardMaterial({ color: 0xc78e6e, roughness: 0.72, metalness: 0 });
    const skinDark = new T.MeshStandardMaterial({ color: 0xb87d5f, roughness: 0.8, metalness: 0 });
    const sleeve = new T.MeshStandardMaterial({ color: 0x2c4a39, roughness: 1, metalness: 0 });
    const cuff = new T.MeshStandardMaterial({ color: 0x1f3529, roughness: 1, metalness: 0 });

    const root = new T.Group();       // positioned in camera space
    const arm = new T.Group();        // pivot at the elbow-side (bottom)
    root.add(arm);

    const sleeveMesh = new T.Mesh(new T.CylinderGeometry(0.058, 0.07, 0.34, 14), sleeve);
    sleeveMesh.position.y = -0.02;
    const cuffMesh = new T.Mesh(new T.CylinderGeometry(0.056, 0.058, 0.04, 14), cuff);
    cuffMesh.position.y = 0.16;
    const wrist = new T.Mesh(new T.CylinderGeometry(0.042, 0.052, 0.12, 12), skin);
    wrist.position.y = 0.2;
    arm.add(sleeveMesh, cuffMesh, wrist);

    const palm = new T.Group();
    palm.position.set(0, 0.29, 0);
    arm.add(palm);
    const palmMesh = new T.Mesh(new T.SphereGeometry(0.5, 16, 12), skin);
    palmMesh.scale.set(0.105, 0.105, 0.042);
    palm.add(palmMesh);

    // fingers: three phalanges each, relaxed curl
    const fingers = [];
    const defs = [
      { x: -0.036, len: [0.045, 0.032, 0.026], r: 0.0105, curl: [0.30, 0.55, 0.45], tilt: 0.06 },   // index
      { x: -0.012, len: [0.050, 0.035, 0.028], r: 0.0108, curl: [0.34, 0.60, 0.50], tilt: 0.02 },   // middle
      { x: 0.012, len: [0.046, 0.032, 0.026], r: 0.0102, curl: [0.40, 0.64, 0.52], tilt: -0.02 },   // ring
      { x: 0.034, len: [0.038, 0.026, 0.022], r: 0.0094, curl: [0.46, 0.70, 0.55], tilt: -0.06 },   // pinky
    ];
    defs.forEach((d) => {
      const base = new T.Group();
      base.position.set(d.x, 0.043, 0.004);
      base.rotation.z = d.tilt;
      palm.add(base);
      let parent = base;
      const joints = [];
      d.len.forEach((L, i) => {
        const j = new T.Group();
        j.rotation.x = d.curl[i];
        if (i > 0) j.position.y = d.len[i - 1];
        const seg = new T.Mesh(new T.CapsuleGeometry(d.r * (1 - i * 0.08), L, 4, 8), i === 2 ? skinDark : skin);
        seg.position.y = L / 2;
        j.add(seg);
        parent.add(j);
        parent = j;
        joints.push(j);
      });
      fingers.push({ joints, curl: d.curl.slice() });
    });
    // thumb
    const thumbBase = new T.Group();
    thumbBase.position.set(0.05, 0.0, 0.008);
    thumbBase.rotation.set(0.25, 0.2, -0.85);
    palm.add(thumbBase);
    const t1 = new T.Mesh(new T.CapsuleGeometry(0.0125, 0.034, 4, 8), skin);
    t1.position.y = 0.022;
    const tj = new T.Group();
    tj.position.y = 0.045; tj.rotation.x = 0.35;
    const t2 = new T.Mesh(new T.CapsuleGeometry(0.0112, 0.028, 4, 8), skin);
    t2.position.y = 0.019;
    tj.add(t2);
    thumbBase.add(t1, tj);

    // pose the whole arm: coming from the lower right, angled in and away from the camera
    arm.rotation.set(-0.96, 0.0, 0.38);
    arm.position.set(0, 0, 0);
    palm.rotation.set(0.08, -0.48, 0.10);

    handScene.add(root);
    return { root, arm, palm, fingers };
  })();

  function layoutHand() {
    const aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
    handCam.aspect = aspect;
    handCam.updateProjectionMatrix();
    // Keep the viewmodel farther from the camera and notably smaller on portrait phones.
    const dist = aspect < 0.82 ? 0.72 : aspect < 1.15 ? 0.66 : 0.62;
    const halfH = Math.tan(handCam.fov * Math.PI / 360) * dist;
    const halfW = halfH * aspect;
    const s = aspect < 0.82 ? 0.56 : aspect < 1.15 ? 0.67 : 0.80;
    hand.root.scale.setScalar(s);
    hand.baseX = Math.min(halfW * 0.80, 0.30);
    hand.baseY = -halfH * (aspect < 0.82 ? 1.16 : 1.04);
    hand.baseZ = -dist;
  }

  /* ---------------- player ---------------- */
  const PLAYER_R = 0.42, EYE = 1.65;
  const player = { x: 0, z: 0, y: 0, vx: 0, vz: 0, yaw: 0, pitch: -0.03, steps: 0, eyeY: 0, moved: 0, speedNow: 0, onPath: false };
  const input = { forward: 0, back: 0, left: 0, right: 0, shift: false, run: false };
  const joy = { x: 0, y: 0 };
  const settings = { auto: true, shadows: true };
  const DAY_SECONDS = 720;
  let tod = 9.5 / 24;

  let world = null;
  let state = "loading";        // loading | start | playing | paused
  let elapsed = 0, windTime = 0, travelled = 0, lastStepFloor = 0;
  let locked = false;

  function resetPlayer() {
    const S = world.SPAWN;
    player.x = S.x; player.z = S.z; player.yaw = S.yaw; player.pitch = -0.03;
    player.vx = player.vz = 0; player.steps = 0; lastStepFloor = 0; travelled = 0;
    player.y = world.height(player.x, player.z);
    player.eyeY = player.y + EYE;
    tod = 9.5 / 24;
    env.setTime(tod);
    $("todSlider").value = (tod * 24).toFixed(2);
    $("tip").classList.remove("fade");
    $("tip").style.display = "";
  }

  /* ---------------- sizing ---------------- */
  function onResize() {
    const w = mount.clientWidth || innerWidth, h = mount.clientHeight || innerHeight;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h);
    const aspect = w / Math.max(1, h);
    camera.aspect = aspect;
    baseFov = aspect >= 1.4 ? 72 : lerp(88, 72, clamp((aspect - 0.45) / 0.95, 0, 1));
    camera.fov = baseFov;
    camera.updateProjectionMatrix();
    layoutHand();
  }
  let baseFov = 72;
  addEventListener("resize", onResize);
  addEventListener("orientationchange", () => setTimeout(onResize, 200));

  /* ---------------- input ---------------- */
  const joyEl = $("joy"), knob = $("knob");
  let joyId = null;
  function setJoy(cx, cy) {
    const r = joyEl.getBoundingClientRect();
    let dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    const max = r.width * 0.36, len = Math.hypot(dx, dy);
    if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
    knob.style.transform = "translate3d(" + dx + "px," + dy + "px,0)";
    joy.x = dx / max; joy.y = dy / max;
  }
  function endJoy(e) {
    if (e.pointerId !== joyId) return;
    joyId = null; joy.x = joy.y = 0;
    knob.style.transform = "translate3d(0,0,0)";
  }
  joyEl.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    joyId = e.pointerId;
    try { joyEl.setPointerCapture(joyId); } catch (_) {}
    setJoy(e.clientX, e.clientY);
  }, { passive: false });
  joyEl.addEventListener("pointermove", (e) => { if (e.pointerId === joyId) { e.preventDefault(); setJoy(e.clientX, e.clientY); } }, { passive: false });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => joyEl.addEventListener(t, endJoy));

  const runBtn = $("run");
  let runId = null;
  runBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); runId = e.pointerId; try { runBtn.setPointerCapture(runId); } catch (_) {} input.run = true; runBtn.classList.add("on"); });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => runBtn.addEventListener(t, (e) => { if (e.pointerId === runId) { runId = null; input.run = false; runBtn.classList.remove("on"); } }));

  // reveal touch controls on first touch (hybrid laptops / unusual user agents)
  if (coarse || params.get("touch") === "1") document.documentElement.classList.add("touch");
  addEventListener("touchstart", () => document.documentElement.classList.add("touch"), { passive: true, once: true });

  function setKey(code, down) {
    switch (code) {
      case "KeyW": case "ArrowUp": input.forward = down ? 1 : 0; break;
      case "KeyS": case "ArrowDown": input.back = down ? 1 : 0; break;
      case "KeyA": case "ArrowLeft": input.left = down ? 1 : 0; break;
      case "KeyD": case "ArrowRight": input.right = down ? 1 : 0; break;
      case "ShiftLeft": case "ShiftRight": input.shift = down; break;
    }
  }
  addEventListener("keydown", (e) => {
    if (e.repeat) { if (state === "playing" && /Arrow|Space/.test(e.code)) e.preventDefault(); return; }
    if (e.code === "Escape" || e.code === "KeyP") { if (state === "playing") pause(); else if (state === "paused") resume(); return; }
    if (e.code === "KeyM") { toggleSound(); return; }
    if (e.code === "KeyE" && state === "playing") { examineNearby(); return; }
    if (e.code === "KeyJ" && state === "playing") { openJournal(); return; }
    if (e.code === "Enter" && state === "start" && !$("btnEnter").disabled) { startGame(); return; }
    setKey(e.code, true);
    if (/^Arrow|^Space$/.test(e.code)) e.preventDefault();
  }, { passive: false });
  addEventListener("keyup", (e) => setKey(e.code, false));
  addEventListener("blur", () => { input.forward = input.back = input.left = input.right = 0; input.shift = false; if (state === "playing") pause(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && state === "playing") pause(); });

  // look: drag anywhere (touch / mouse), or pointer-lock mouse movement on desktop
  let lookId = null, lastX = 0, lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    if (state !== "playing") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (locked) return;
    lookId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    if (e.pointerType === "mouse") tryLock();
  }, { passive: false });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerId !== lookId || state !== "playing") return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    look(dx * 0.0045, dy * 0.0032);
    e.preventDefault();
  }, { passive: false });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => canvas.addEventListener(t, (e) => { if (e.pointerId === lookId) lookId = null; }));
  document.addEventListener("mousemove", (e) => { if (locked && state === "playing") look(e.movementX * 0.0024, e.movementY * 0.0024); });
  function look(dx, dy) {
    player.yaw -= dx;
    player.pitch = clamp(player.pitch - dy, -1.35, 1.35);
  }
  function tryLock() {
    if (coarse || !canvas.requestPointerLock) return;
    try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  }
  document.addEventListener("pointerlockchange", () => {
    locked = document.pointerLockElement === canvas;
    if (!locked && state === "playing") pause();
  });

  /* ---------------- UI state ---------------- */
  const startEl = $("start"), menuEl = $("menu");
  const journalEl = $("journalOverlay");
  const discoveries = [
    { id: "ember", icon: "🔥", title: "The First Ember", place: "Campfire", radius: 6.6,
      position: (w) => w.CAMP,
      text: "The fire turns the clearing into a shelter. Someone arranged the logs carefully and left room for others to sit. A reminder that a long walk is easier when there is somewhere warm to return to." },
    { id: "stillwater", icon: "💧", title: "Stillwater Pool", place: "Pond", radius: (w) => w.POND_EDGE + 2.2,
      position: (w) => w.POND,
      text: "The pond mirrors the shifting sky. Reeds shelter its rim and lily pads drift near the quieter water. The safest path follows the bank rather than crossing the dark centre." },
    { id: "whisperstones", icon: "🪨", title: "Whispering Stones", place: "Standing stones", radius: (w) => w.STONES.R + 2.3,
      position: (w) => w.STONES,
      text: "Seven weathered stones form a loose circle. Moss softens their edges, but the arrangement looks deliberate. There are no names, dates, or instructions—only the feeling that this place was meant to be remembered." },
    { id: "waystone", icon: "✨", title: "The Ranger's Waystone", place: "Old trail marker", radius: 4.7,
      position: () => ({ x: 31, z: -54 }),
      text: "A small green crystal sits in an old stone marker beside the trail. Its glow is faint in daylight and clearer at dusk. It marks the path deeper into the woods, though the ranger who placed it is long gone." }
  ];
  const foundNotes = new Set();
  let nearbyNote = null, journalReturnState = "playing", toastTimer = null;
  try {
    const saved = JSON.parse(localStorage.getItem("forestExplorer.fieldNotes.v1") || "[]");
    if (Array.isArray(saved)) saved.forEach((id) => { if (discoveries.some((d) => d.id === id)) foundNotes.add(id); });
  } catch (_) {}

  function renderJournal() {
    const count = foundNotes.size;
    $("journalCount").textContent = count + "/" + discoveries.length;
    $("journalProgress").textContent = count === discoveries.length
      ? "Expedition complete — every field note found."
      : count + " of " + discoveries.length + " field notes discovered";
    $("journalBarFill").style.width = (count / discoveries.length * 100) + "%";
    $("journalBody").innerHTML = discoveries.map((d) => {
      const found = foundNotes.has(d.id);
      return '<article class="note ' + (found ? 'found' : 'locked') + '">' +
        '<div class="noteIcon">' + (found ? d.icon : '◌') + '</div><div class="noteText">' +
        '<strong>' + (found ? d.title : 'Undiscovered location') + '</strong>' +
        '<span>' + (found ? d.text : 'Follow the trails and examine places that feel different from the rest of the forest.') + '</span></div>' +
        '<div class="noteState">' + (found ? 'FOUND' : '???') + '</div></article>';
    }).join("");
  }
  function showToast(message) {
    const el = $("toast");
    el.textContent = message; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
  }
  function updateInteraction() {
    const prompt = $("interactPrompt");
    if (state !== "playing" || !world) { prompt.classList.add("hidden"); nearbyNote = null; return; }
    let best = null, bestD = Infinity;
    discoveries.forEach((d) => {
      if (foundNotes.has(d.id)) return;
      const pos = d.position(world);
      const dx = player.x - pos.x, dz = player.z - pos.z;
      const distance = Math.hypot(dx, dz);
      const radius = typeof d.radius === "function" ? d.radius(world) : d.radius;
      if (distance <= radius && distance < bestD) { best = d; bestD = distance; }
    });
    nearbyNote = best;
    if (best) {
      $("interactName").textContent = best.icon + "  " + best.place;
      $("btnInteract").textContent = document.documentElement.classList.contains("touch") ? "EXAMINE" : "EXAMINE · E";
      prompt.classList.remove("hidden");
    } else prompt.classList.add("hidden");
  }
  function examineNearby() {
    if (state !== "playing" || !nearbyNote) return;
    const d = nearbyNote;
    foundNotes.add(d.id);
    try { localStorage.setItem("forestExplorer.fieldNotes.v1", JSON.stringify(Array.from(foundNotes))); } catch (_) {}
    renderJournal(); updateInteraction();
    showToast(d.icon + "  Field note added: " + d.title);
    if (foundNotes.size === discoveries.length) showToast("🌲 Expedition complete — all 4 field notes found!");
  }
  function openJournal() {
    if (!world || state === "start" || state === "loading") return;
    journalReturnState = state;
    if (state === "playing") { state = "journal"; audio.suspend(); if (document.pointerLockElement) document.exitPointerLock(); }
    else if (state === "paused") state = "journal";
    else if (state !== "journal") return;
    renderJournal(); journalEl.classList.remove("hidden");
  }
  function closeJournal() {
    journalEl.classList.add("hidden");
    if (journalReturnState === "playing") { state = "playing"; audio.resume(); $("btnPause").textContent = "⏸"; tryLock(); }
    else { state = "paused"; $("btnPause").textContent = "▶"; }
  }
  $("btnJournal").addEventListener("click", openJournal);
  $("btnInteract").addEventListener("click", examineNearby);
  $("btnJournalClose").addEventListener("click", closeJournal);
  ["btnJournal", "btnInteract", "btnJournalClose"].forEach((id) => $(id).addEventListener("pointerdown", (e) => e.stopPropagation()));
  function startGame() {
    if (!world) return;
    audio.start();
    startEl.classList.add("hidden");
    state = "playing";
    tryLock();
  }
  function pause() {
    if (state !== "playing") return;
    state = "paused";
    lookId = null; joyId = null; joy.x = joy.y = 0; knob.style.transform = "translate3d(0,0,0)";
    input.run = false; runBtn.classList.remove("on");
    input.forward = input.back = input.left = input.right = 0;
    if (document.pointerLockElement) document.exitPointerLock();
    menuEl.classList.remove("hidden");
    $("btnPause").textContent = "▶";
    audio.suspend();
  }
  function resume() {
    if (state !== "paused") return;
    menuEl.classList.add("hidden");
    state = "playing";
    $("btnPause").textContent = "⏸";
    audio.resume();
    tryLock();
  }
  function restart() {
    resetPlayer();
    resume();
  }
  function toggleSound() {
    audio.setMuted(!audio.muted);
    $("btnSound").textContent = audio.muted ? "🔇" : "🔊";
    $("soundToggle").checked = !audio.muted;
  }
  $("btnEnter").addEventListener("click", startGame);
  $("btnPause").addEventListener("click", () => (state === "playing" ? pause() : state === "paused" ? resume() : 0));
  $("btnResume").addEventListener("click", resume);
  $("btnRestart").addEventListener("click", restart);
  $("btnSound").addEventListener("click", toggleSound);
  $("soundToggle").addEventListener("change", (e) => { audio.setMuted(!e.target.checked); $("btnSound").textContent = audio.muted ? "🔇" : "🔊"; });
  $("shadowToggle").addEventListener("change", (e) => { settings.shadows = e.target.checked; env.sun.castShadow = settings.shadows; });
  $("todAuto").addEventListener("change", (e) => { settings.auto = e.target.checked; });
  $("todSlider").addEventListener("input", (e) => {
    tod = parseFloat(e.target.value) / 24;
    env.setTime(tod);
    $("todLabel").textContent = env.state.clock;
  });
  // keep clicks on UI from reaching the canvas
  ["btnPause", "btnSound", "btnJournal", "btnInteract"].forEach((id) => $(id).addEventListener("pointerdown", (e) => e.stopPropagation()));

  /* ---------------- simulation ---------------- */
  const fwd = new T.Vector3(), rgt = new T.Vector3();
  const camPos = new T.Vector3();
  let lastLabel = "", lastCompass = "";
  const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  function step(dt) {
    // time of day
    if (settings.auto) { tod = (tod + dt / DAY_SECONDS) % 1; env.setTime(tod); }

    // movement input -> desired velocity
    let f = input.forward - input.back, s = input.right - input.left;
    let mag = 1;
    if (Math.abs(joy.x) > 0.05 || Math.abs(joy.y) > 0.05) { f = -joy.y; s = joy.x; mag = Math.min(1, Math.hypot(joy.x, joy.y)); mag = Math.max(0.35, mag); }
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    rgt.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    const running = input.shift || input.run;
    const speed = running ? 5.8 : 3.55;
    const tx = (fwd.x * f + rgt.x * s) * speed * (len > 0 ? mag : 0);
    const tz = (fwd.z * f + rgt.z * s) * speed * (len > 0 ? mag : 0);
    const k = 1 - Math.exp(-dt * (len > 0 ? 11 : 14));
    player.vx += (tx - player.vx) * k;
    player.vz += (tz - player.vz) * k;

    const px = player.x, pz = player.z;
    const r = world.resolve(px + player.vx * dt, pz + player.vz * dt, PLAYER_R);
    player.x = r.x; player.z = r.z;
    const moved = Math.hypot(player.x - px, player.z - pz);
    player.moved = moved;
    player.speedNow = dt > 0 ? moved / dt : 0;
    if (r.hit) { // killing the velocity component pushing into obstacles avoids jitter
      const ex = (px + player.vx * dt - r.x), ez = (pz + player.vz * dt - r.z);
      if (Math.abs(ex) + Math.abs(ez) > 1e-5) { player.vx *= 0.6; player.vz *= 0.6; }
    }
    travelled += moved;

    // Stride-based cadence: fewer, softer impacts; animation is tied to actual distance moved.
    const strideLength = running ? 1.72 : 1.34;
    player.steps += moved / strideLength;
    const fl = Math.floor(player.steps);
    if (fl !== lastStepFloor && moved > 0.015) {
      lastStepFloor = fl;
      const onPath = world.pathDist(player.x, player.z) < 1.45;
      const pondDistance = Math.hypot(player.x - world.POND.x, player.z - world.POND.z) - world.POND_EDGE;
      const surface = onPath ? "path" : pondDistance < 2.4 ? "shore" : (world.pathDist(player.x, player.z) < 5.0 ? "forest" : "grass");
      player.onPath = onPath;
      audio.footstep(running, surface);
    } else if (moved < 0.002) {
      // Prevent residual stride phase from retriggering after a stop or collision.
      lastStepFloor = Math.floor(player.steps);
    }

    // eye height follows the terrain smoothly
    player.y = world.height(player.x, player.z);
    const targetEye = player.y + EYE;
    player.eyeY += (targetEye - player.eyeY) * (1 - Math.exp(-dt * 16));

    // wind
    windTime += dt;
    const gust = 0.55 + 0.3 * Math.sin(windTime * 0.31) + 0.18 * Math.sin(windTime * 0.77 + 1.3) + 0.08 * Math.sin(windTime * 1.9);
    env.state.windStrength = clamp(gust, 0.15, 1.2);
    FE.windU.uTime.value = windTime;
    FE.windU.uWind.value = env.state.windStrength;

    // tip fade after the player has explored a bit
    if (travelled > 14) $("tip").classList.add("fade");
  }

  const bobAmt = { v: 0 };
  function updateCamera(dt, t) {
    const speedRatio = clamp(player.speedNow / 6, 0, 1.2);
    bobAmt.v += (speedRatio - bobAmt.v) * (1 - Math.exp(-dt * 8));
    const gait = player.steps * Math.PI;
    const bob = -Math.cos(gait) * 0.014 * bobAmt.v;
    const sway = Math.sin(gait) * 0.008 * bobAmt.v;
    const breathe = Math.sin(t * 1.3) * 0.004;
    camera.position.set(player.x, player.eyeY + bob + breathe, player.z);
    camera.rotation.set(player.pitch, player.yaw, sway, "YXZ");
    const targetFov = baseFov + (input.shift || input.run ? 5 : 0) * clamp(bobAmt.v, 0, 1);
    if (Math.abs(camera.fov - targetFov) > 0.05) { camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-dt * 6)); camera.updateProjectionMatrix(); }
  }

  /* hand: bobs with each step, lags slightly behind camera turns */
  let lagYaw = 0, lagPitch = 0, prevYaw = 0, prevPitch = 0;
  function updateHand(dt, t) {
    const dyaw = player.yaw - prevYaw, dpitch = player.pitch - prevPitch;
    prevYaw = player.yaw; prevPitch = player.pitch;
    lagYaw = clamp(lagYaw + dyaw * 0.6, -0.25, 0.25);
    lagPitch = clamp(lagPitch + dpitch * 0.6, -0.25, 0.25);
    const decay = Math.exp(-dt * 7);
    lagYaw *= decay; lagPitch *= decay;
    const w = bobAmt.v;
    const sp = player.steps * Math.PI;
    const bx = Math.sin(sp) * 0.010 * w;
    const by = (Math.abs(Math.cos(sp)) - 0.5) * 0.016 * w + Math.sin(t * 1.05) * 0.003;
    hand.root.position.set(hand.baseX + bx + lagYaw * 0.12, hand.baseY + by - lagPitch * 0.08, hand.baseZ);
    hand.root.rotation.set(lagPitch * 0.28, lagYaw * 0.38, Math.sin(sp * 0.5) * 0.025 * w);
    // fingers breathe a little
    hand.fingers.forEach((fg, i) => fg.joints.forEach((j, k) => { j.rotation.x = fg.curl[k] + Math.sin(t * 1.2 + i * 0.7) * 0.03 + w * 0.05; }));
  }

  function updateHud() {
    const st = env.state;
    if (st.label !== lastLabel) { lastLabel = st.label; $("time").textContent = st.label; }
    const head = ((-player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const c = "🧭 " + DIRS[Math.round(head / 45) % 8];
    if (c !== lastCompass) { lastCompass = c; $("compass").textContent = c; }
    if (!menuEl.classList.contains("hidden")) $("todLabel").textContent = st.clock;
  }

  /* ---------------- frame loop + adaptive resolution ---------------- */
  let last = performance.now(), acc = 0, accN = 0, adaptCooldown = 3;
  const startOrbit = { yaw: 0 };
  function frame(now) {
    requestAnimationFrame(frame);
    if (!world) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    const rawDt = (now - last) / 1000;
    last = now;
    elapsed += dt;

    if (state === "playing") {
      step(dt);
    } else if (state === "start") {
      // idle intro: wind keeps blowing, camera slowly looks around
      windTime += dt;
      FE.windU.uTime.value = windTime;
      FE.windU.uWind.value = 0.6 + 0.2 * Math.sin(windTime * 0.3);
      startOrbit.yaw += dt * 0.05;
      player.yaw = Math.sin(startOrbit.yaw) * 0.6;
      if (settings.auto) { tod = (tod + dt / DAY_SECONDS) % 1; env.setTime(tod); }
    }

    if (state !== "paused" && state !== "journal") {
      updateCamera(dt, elapsed);
      updateHand(dt, elapsed);
    }
    camera.updateMatrixWorld();
    camPos.copy(camera.position);
    env.follow(camPos, player.y);
    env.tick(dt, windTime);
    world.update(dt, windTime, camPos, player.y, env.state, renderer.domElement.height);
    if (state === "playing" && audio.ready) {
      audio.update({
        day: env.state.day, night: env.state.night, wind: env.state.windStrength,
        fire: clamp(1 - (world.fireDist - 2) / 22, 0, 1) ** 1.6,
        water: clamp(1 - Math.max(0, world.waterDist) / 16, 0, 1) ** 1.5,
      });
    }
    updateHud();
    updateInteraction();
    if (waystoneCrystal) waystoneCrystal.rotation.y += dt * 0.28;
    if (waystoneLight) waystoneLight.intensity = 0.45 + 0.12 * Math.sin(elapsed * 1.3);

    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(handScene, handCam);

    // adaptive pixel ratio: aim for a smooth frame rate on weak GPUs
    if (state === "playing" && rawDt < 0.5) {
      acc += rawDt; accN++;
      if (accN >= 60) {
        const avg = acc / accN; acc = 0; accN = 0;
        adaptCooldown--;
        if (adaptCooldown <= 0) {
          if (avg > 0.030 && pixelRatio > minPixelRatio) { pixelRatio = Math.max(minPixelRatio, pixelRatio - 0.15); onResize(); adaptCooldown = 2; }
          else if (avg < 0.0185 && pixelRatio < Math.min(window.devicePixelRatio || 1, Q.maxPixelRatio) - 0.01) { pixelRatio = Math.min(Math.min(window.devicePixelRatio || 1, Q.maxPixelRatio), pixelRatio + 0.1); onResize(); adaptCooldown = 4; }
        }
      }
    }
  }

  /* ---------------- small landmark: ranger waystone ---------------- */
  let waystoneCrystal = null, waystoneLight = null;
  function createWaystone() {
    const x = 31, z = -54, y = world.height(x, z);
    const g = new T.Group(); g.position.set(x, y, z);
    const stoneMat = new T.MeshStandardMaterial({ color: 0x555f53, roughness: 1, flatShading: true });
    const mossMat = new T.MeshStandardMaterial({ color: 0x426443, roughness: 1, flatShading: true });
    const base = new T.Mesh(new T.CylinderGeometry(0.48, 0.62, 0.28, 7), stoneMat);
    base.position.y = 0.14; base.castShadow = true; base.receiveShadow = true; g.add(base);
    const rockA = new T.Mesh(new T.DodecahedronGeometry(0.42, 0), mossMat);
    rockA.position.set(-0.42, 0.20, 0.1); rockA.scale.set(1.0, 0.72, 0.82); rockA.rotation.set(0.2, 0.4, -0.12); rockA.castShadow = true; g.add(rockA);
    const rockB = new T.Mesh(new T.DodecahedronGeometry(0.34, 0), stoneMat);
    rockB.position.set(0.42, 0.16, -0.12); rockB.scale.set(0.9, 0.66, 0.95); rockB.rotation.y = 0.8; rockB.castShadow = true; g.add(rockB);
    const crystalMat = new T.MeshStandardMaterial({ color: 0x8ce6ac, emissive: 0x2b9256, emissiveIntensity: 0.8, roughness: 0.28, metalness: 0.08, flatShading: true });
    waystoneCrystal = new T.Mesh(new T.OctahedronGeometry(0.29, 0), crystalMat);
    waystoneCrystal.position.set(0, 0.93, 0); waystoneCrystal.rotation.set(0.18, 0.4, 0.08); waystoneCrystal.castShadow = true; g.add(waystoneCrystal);
    const collar = new T.Mesh(new T.TorusGeometry(0.31, 0.045, 5, 12), mossMat);
    collar.position.set(0, 0.66, 0); collar.rotation.x = Math.PI / 2; g.add(collar);
    waystoneLight = new T.PointLight(0x83e9a7, 0.45, 7, 2); waystoneLight.position.set(0, 1.0, 0); g.add(waystoneLight);
    scene.add(g);
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    try {
      onResize();
      world = await FE.buildWorld(scene, renderer, Q, (label, pct) => {
        $("barFill").style.width = pct + "%";
        $("startSub").textContent = label;
      });
      createWaystone();
      resetPlayer();
      player.yaw = 0;
      renderJournal();
      onResize();
      state = "start";
      $("startSub").textContent = "A quiet walk through a living forest.";
      $("btnEnter").disabled = false;
      $("btnEnter").textContent = "Enter the forest";
      document.querySelector(".bar").style.display = "none";
      $("todLabel").textContent = env.state.clock;
      // compile shaders up-front so the first frames after pressing Enter are smooth
      try { renderer.compile(scene, camera); } catch (_) {}
    } catch (err) {
      console.error(err);
      fatal("Something went wrong while building the forest:<br><code>" + String(err && err.message || err) + "</code>");
    }
  }

  /* debug / test hooks (also handy in the console) */
  FE.game = {
    get state() { return state; },
    player, input, joy, settings, world: () => world, env, audio, renderer, scene, camera,
    step: (dt) => step(dt),
    setTime: (h) => { tod = h / 24; env.setTime(tod); },
    teleport: (x, z, yaw, pitch) => { player.x = x; player.z = z; if (yaw !== undefined) player.yaw = yaw; if (pitch !== undefined) player.pitch = pitch; player.y = world.height(x, z); player.eyeY = player.y + EYE; },
    start: startGame, pause, resume, restart, quality: qName, get pixelRatio() { return pixelRatio; },
  };

  requestAnimationFrame(frame);
  boot();
})();
