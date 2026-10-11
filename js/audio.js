/* Forest Explorer - procedural ambient audio (no audio files needed).
 * Wind, leaf rustle, birdsong by day, crickets at night, campfire crackle, pond water, footsteps. */
(function () {
  "use strict";
  const FE = (window.FE = window.FE || {});

  FE.createAudio = function () {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = null, master = null, muted = false, ready = false;
    let windG, windF, leafG, cricketG, fireG, waterG;
    let noiseBuf = null, brownBuf = null;
    let birdTimer = null, crackleTimer = null;
    const state = { day: 1, night: 0, fire: 0, water: 0, wind: 0.6 };

    function makeBuffers() {
      const len = ctx.sampleRate * 3;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      brownBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const n = noiseBuf.getChannelData(0), b = brownBuf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        n[i] = w;
        last = (last + 0.02 * w) / 1.02;
        b[i] = last * 3.5;
      }
    }
    function loop(buf, rate) {
      const s = ctx.createBufferSource();
      s.buffer = buf; s.loop = true;
      if (rate) s.playbackRate.value = rate;
      s.start();
      return s;
    }
    function chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }

    function start() {
      if (!AC) return false;
      if (ctx) { if (ctx.state === "suspended") ctx.resume(); return true; }
      try {
        ctx = new AC();
        makeBuffers();
        master = ctx.createGain();
        master.gain.value = 0;
        const comp = ctx.createDynamicsCompressor();
        chain(master, comp, ctx.destination);

        // wind: brown noise through a moving low-pass
        windF = ctx.createBiquadFilter(); windF.type = "lowpass"; windF.frequency.value = 500; windF.Q.value = 0.4;
        windG = ctx.createGain(); windG.gain.value = 0;
        chain(loop(brownBuf, 0.9), windF, windG, master);

        // leaf rustle: high band noise following the gusts
        const lh = ctx.createBiquadFilter(); lh.type = "highpass"; lh.frequency.value = 2500;
        const lb = ctx.createBiquadFilter(); lb.type = "bandpass"; lb.frequency.value = 5200; lb.Q.value = 0.5;
        leafG = ctx.createGain(); leafG.gain.value = 0;
        chain(loop(noiseBuf, 1.0), lh, lb, leafG, master);

        // crickets: two detuned AM'd tones
        cricketG = ctx.createGain(); cricketG.gain.value = 0;
        cricketG.connect(master);
        [4200, 4480].forEach((f, i) => {
          const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
          const am = ctx.createGain(); am.gain.value = 0;
          const lfo = ctx.createOscillator(); lfo.type = "square"; lfo.frequency.value = 17 + i * 4.5;
          const lg = ctx.createGain(); lg.gain.value = 0.5;
          const slow = ctx.createOscillator(); slow.frequency.value = 0.9 + i * 0.37;
          const sg = ctx.createGain(); sg.gain.value = 0.25;
          lfo.connect(lg); lg.connect(am.gain);
          slow.connect(sg); sg.connect(am.gain);
          chain(o, am, cricketG);
          o.start(); lfo.start(); slow.start();
        });

        // campfire rumble + water
        const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = 260;
        fireG = ctx.createGain(); fireG.gain.value = 0;
        chain(loop(brownBuf, 1.4), fl, fireG, master);
        const wf = ctx.createBiquadFilter(); wf.type = "bandpass"; wf.frequency.value = 900; wf.Q.value = 0.8;
        waterG = ctx.createGain(); waterG.gain.value = 0;
        chain(loop(noiseBuf, 0.5), wf, waterG, master);

        master.gain.setTargetAtTime(muted ? 0 : 0.85, ctx.currentTime, 1.2);
        scheduleBird();
        scheduleCrackle();
        ready = true;
        return true;
      } catch (e) {
        console.warn("Audio unavailable:", e);
        ctx = null;
        return false;
      }
    }

    function chirp(t0, base, pan) {
      const notes = 2 + Math.floor(Math.random() * 4);
      const out = ctx.createGain();
      out.gain.value = 0.05 + Math.random() * 0.05;
      let node = out;
      if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; out.connect(p); node = p; }
      node.connect(master);
      let t = t0;
      for (let i = 0; i < notes; i++) {
        const o = ctx.createOscillator(); o.type = "sine";
        const g = ctx.createGain();
        const f0 = base * (0.85 + Math.random() * 0.5), f1 = f0 * (0.75 + Math.random() * 0.7);
        const dur = 0.06 + Math.random() * 0.09;
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f1, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(1, t + dur * 0.25);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        chain(o, g, out);
        o.start(t); o.stop(t + dur + 0.02);
        t += dur + 0.04 + Math.random() * 0.08;
      }
    }
    function scheduleBird() {
      clearTimeout(birdTimer);
      const wait = 1800 + Math.random() * 5200;
      birdTimer = setTimeout(() => {
        if (ctx && ctx.state === "running" && !muted && state.day > 0.15) {
          if (Math.random() < state.day) chirp(ctx.currentTime + 0.02, 2200 + Math.random() * 2600, Math.random() * 2 - 1);
        } else if (ctx && ctx.state === "running" && !muted && state.night > 0.5 && Math.random() < 0.12) {
          // distant owl-like hoot
          const t = ctx.currentTime + 0.02;
          [0, 0.45].forEach((d, i) => {
            const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = 330 - i * 40;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.05, t + d + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.38);
            chain(o, g, master); o.start(t + d); o.stop(t + d + 0.45);
          });
        }
        scheduleBird();
      }, wait);
    }
    function crackle() {
      const t = ctx.currentTime;
      const s = ctx.createBufferSource(); s.buffer = noiseBuf;
      const g = ctx.createGain(); const f = ctx.createBiquadFilter();
      f.type = "bandpass"; f.frequency.value = 1500 + Math.random() * 3500; f.Q.value = 1.5;
      const dur = 0.015 + Math.random() * 0.05;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.min(0.5, 0.05 + state.fire * 0.4) * (0.4 + Math.random() * 0.6), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      chain(s, f, g, master);
      s.start(t, Math.random() * 2, dur + 0.02);
    }
    function scheduleCrackle() {
      clearTimeout(crackleTimer);
      crackleTimer = setTimeout(() => {
        if (ctx && ctx.state === "running" && !muted && state.fire > 0.03) crackle();
        scheduleCrackle();
      }, 70 + Math.random() * 260);
    }

    function footstep(run, onPath) {
      if (!ctx || ctx.state !== "running" || muted) return;
      const t = ctx.currentTime;
      const s = ctx.createBufferSource(); s.buffer = noiseBuf;
      const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = (onPath ? 1700 : 650) * (0.85 + Math.random() * 0.3); f.Q.value = 0.9;
      const g = ctx.createGain();
      const v = (run ? 0.34 : 0.22) * (0.8 + Math.random() * 0.4);
      const dur = onPath ? 0.09 : 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      chain(s, f, g, master);
      s.start(t, Math.random() * 2, dur + 0.05);
      // soft thud
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.1);
      const og = ctx.createGain(); og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(v * 0.45, t + 0.01); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      chain(o, og, master); o.start(t); o.stop(t + 0.14);
    }

    function update(s) {
      if (!ready) return;
      Object.assign(state, s);
      const t = ctx.currentTime, k = 0.35;
      const w = clamp01(state.wind);
      windG.gain.setTargetAtTime(0.10 + 0.5 * w * w, t, k);
      windF.frequency.setTargetAtTime(260 + 900 * w, t, k);
      leafG.gain.setTargetAtTime(0.012 + 0.07 * w * w * state.day + 0.03 * w * w * state.night, t, k);
      cricketG.gain.setTargetAtTime(0.018 * state.night, t, 0.8);
      fireG.gain.setTargetAtTime(0.45 * state.fire, t, 0.3);
      waterG.gain.setTargetAtTime(0.05 * state.water, t, 0.3);
    }
    const clamp01 = (x) => Math.max(0, Math.min(1, x));

    function setMuted(m) {
      muted = m;
      if (ctx && master) master.gain.setTargetAtTime(m ? 0 : 0.85, ctx.currentTime, 0.1);
    }
    function suspend() { if (ctx && ctx.state === "running") ctx.suspend(); }
    function resume() { if (ctx && ctx.state === "suspended") ctx.resume(); }

    return { start, update, footstep, setMuted, suspend, resume, get muted() { return muted; }, get ready() { return ready; }, get state() { return ctx ? ctx.state : "none"; } };
  };
})();
