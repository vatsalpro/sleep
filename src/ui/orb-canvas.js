/**
 * Sleepwalker — 60 FPS Fluid Liquid-Glass Orb Renderer (Canvas 2D)
 *
 * Siri-inspired organic liquid-glass visual identity:
 * - Multi-harmonic morphing fluid contour (no static circles, no CSS spinners)
 * - 5 translucent additive-blended luminous plasma lobes with depth parallax
 * - Fresnel glass rim refraction & soft specular highlight
 * - Smooth spring-damped 7-state animation machine:
 *   IDLE | LISTENING | THINKING | SPEAKING | EXECUTING | SUCCESS | ERROR
 * - Live microphone & TTS audio amplitude reactivity (setAudioLevel / attachMediaStream)
 * - Automatic rAF pause when hidden, DPR-capped (<=2) for laptop efficiency,
 *   and full prefers-reduced-motion support.
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerFluidOrb) return;

  // Authentic Apple Siri / liquid-glass luminous palettes (sapphire, cyan, violet, magenta)
  const STATE_PRESETS = {
    idle: {
      c1: [37, 99, 235],    // Siri sapphire blue
      c2: [56, 189, 248],   // Siri luminous cyan
      c3: [192, 108, 255],  // Siri iridescent orchid-magenta
      speed: 0.65,
      morph: 0.036,
      turbulence: 0.55,
      scale: 0.88,
      waveDir: 0
    },
    listening: {
      c1: [6, 182, 212],    // Siri bright aqua-cyan
      c2: [59, 130, 246],   // electric blue
      c3: [236, 72, 153],   // Siri vibrant pink-magenta
      speed: 1.45,
      morph: 0.072,
      turbulence: 1.2,
      scale: 0.96,
      waveDir: 0
    },
    thinking: {
      c1: [124, 58, 237],   // deep Siri violet
      c2: [236, 72, 153],   // luminous magenta
      c3: [56, 189, 248],   // crystal cyan
      speed: 1.75,
      morph: 0.078,
      turbulence: 1.5,
      scale: 0.94,
      waveDir: 0.35
    },
    speaking: {
      c1: [37, 99, 235],    // cobalt
      c2: [45, 212, 191],   // luminous teal
      c3: [232, 121, 249],  // Siri fuchsia-orchid
      speed: 1.5,
      morph: 0.068,
      turbulence: 1.15,
      scale: 0.98,
      waveDir: 0
    },
    executing: {
      c1: [2, 132, 199],    // ocean blue
      c2: [34, 211, 238],   // directional cyan wave
      c3: [168, 85, 247],   // violet current
      speed: 1.85,
      morph: 0.058,
      turbulence: 1.0,
      scale: 0.95,
      waveDir: 1.0
    },
    success: {
      c1: [16, 185, 129],   // emerald
      c2: [52, 211, 153],   // mint glow
      c3: [56, 189, 248],   // sky highlight
      speed: 0.9,
      morph: 0.035,
      turbulence: 0.5,
      scale: 0.97,
      waveDir: 0
    },
    error: {
      c1: [239, 68, 68],    // restrained coral-red
      c2: [249, 115, 22],   // warm amber-orange
      c3: [251, 146, 60],   // soft peach rim
      speed: 0.75,
      morph: 0.04,
      turbulence: 0.6,
      scale: 0.91,
      waveDir: 0
    }
  };

  function normalizeState(raw) {
    const s = String(raw || 'idle').toLowerCase();
    if (s === 'processing' || s === 'confirm' || s === 'thinking') return 'thinking';
    if (s === 'observing' || s === 'executing') return 'executing';
    if (s === 'completed' || s === 'success') return 'success';
    if (s === 'listening' || s === 'speaking' || s === 'error') return s;
    return 'idle';
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpRgb(cur, target, t) {
    cur[0] = lerp(cur[0], target[0], t);
    cur[1] = lerp(cur[1], target[1], t);
    cur[2] = lerp(cur[2], target[2], t);
  }

  function rgba(rgb, alpha) {
    return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${alpha.toFixed(3)})`;
  }

  class SleepwalkerFluidOrb {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas ? canvas.getContext('2d', { alpha: true }) : null;
      this.size = Number(options.size || 92);
      this.state = 'idle';
      this.running = false;
      this.rafId = null;
      this.phase = 0;
      this.lastTs = 0;

      this.targetAudio = 0;
      this.smoothAudio = 0;
      this.audioCtx = null;
      this.analyser = null;
      this.micSource = null;
      this.freqData = null;

      this.reducedMotion = Boolean(
        typeof rootScope.matchMedia === 'function' &&
        rootScope.matchMedia('(prefers-reduced-motion: reduce)').matches
      );

      const init = STATE_PRESETS.idle;
      this.cur = {
        c1: [...init.c1],
        c2: [...init.c2],
        c3: [...init.c3],
        speed: init.speed,
        morph: init.morph,
        turbulence: init.turbulence,
        scale: init.scale,
        waveDir: init.waveDir
      };

      this.resize(this.size);
      this.renderFrame(0.016);
    }

    resize(cssSize) {
      this.size = Math.max(44, Math.round(Number(cssSize) || 92));
      if (!this.canvas) return;
      const dpr = Math.min(2, Number(rootScope.devicePixelRatio) || 1);
      this.canvas.width = Math.round(this.size * dpr);
      this.canvas.height = Math.round(this.size * dpr);
      this.canvas.style.width = `${this.size}px`;
      this.canvas.style.height = `${this.size}px`;
      if (this.ctx) {
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    setState(nextState) {
      this.state = normalizeState(nextState);
      if (this.reducedMotion) {
        this.renderFrame(0.016);
      }
    }

    setAudioLevel(level) {
      const n = Number(level);
      this.targetAudio = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    }

    attachMediaStream(stream) {
      this.detachMediaStream();
      try {
        const AudioCtx = rootScope.AudioContext || rootScope.webkitAudioContext;
        if (!AudioCtx || !stream) return false;
        this.audioCtx = new AudioCtx();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.78;
        this.micSource = this.audioCtx.createMediaStreamSource(stream);
        this.micSource.connect(this.analyser);
        this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
        return true;
      } catch (_e) {
        this.detachMediaStream();
        return false;
      }
    }

    detachMediaStream() {
      try { if (this.micSource) this.micSource.disconnect(); } catch {}
      try { if (this.audioCtx) this.audioCtx.close(); } catch {}
      this.micSource = null;
      this.analyser = null;
      this.audioCtx = null;
      this.freqData = null;
    }

    start() {
      if (this.running || !this.ctx) return;
      this.running = true;
      this.lastTs = performance.now();
      const tick = (ts) => {
        if (!this.running) return;
        const dt = Math.min(0.05, Math.max(0.004, (ts - this.lastTs) / 1000));
        this.lastTs = ts;
        this.renderFrame(dt);
        if (!this.reducedMotion) {
          this.rafId = rootScope.requestAnimationFrame(tick);
        } else {
          this.running = false;
        }
      };
      this.rafId = rootScope.requestAnimationFrame(tick);
    }

    stop() {
      this.running = false;
      if (this.rafId !== null && typeof rootScope.cancelAnimationFrame === 'function') {
        rootScope.cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }

    destroy() {
      this.stop();
      this.detachMediaStream();
    }

    _sampleMicLevel() {
      if (!this.analyser || !this.freqData) return this.targetAudio;
      this.analyser.getByteFrequencyData(this.freqData);
      let sum = 0;
      for (let i = 0; i < this.freqData.length; i++) sum += this.freqData[i];
      const avg = sum / (this.freqData.length * 255);
      return Math.max(this.targetAudio, Math.min(1, avg * 2.6));
    }

    renderFrame(dt) {
      const ctx = this.ctx;
      if (!ctx) return;

      const preset = STATE_PRESETS[this.state] || STATE_PRESETS.idle;
      const damp = 1 - Math.exp(-dt * 5.2);
      lerpRgb(this.cur.c1, preset.c1, damp);
      lerpRgb(this.cur.c2, preset.c2, damp);
      lerpRgb(this.cur.c3, preset.c3, damp);
      this.cur.speed = lerp(this.cur.speed, preset.speed, damp);
      this.cur.morph = lerp(this.cur.morph, preset.morph, damp);
      this.cur.turbulence = lerp(this.cur.turbulence, preset.turbulence, damp);
      this.cur.scale = lerp(this.cur.scale, preset.scale, damp);
      this.cur.waveDir = lerp(this.cur.waveDir, preset.waveDir, damp);

      // Live audio energy (with natural speech cadence envelope during speaking if external level is quiet)
      let rawAudio = this._sampleMicLevel();
      if (this.state === 'speaking' && rawAudio < 0.12) {
        rawAudio = 0.28 + 0.24 * Math.abs(Math.sin(this.phase * 3.1) * Math.cos(this.phase * 1.7));
      }
      this.smoothAudio = lerp(this.smoothAudio, rawAudio, 1 - Math.exp(-dt * 12));

      this.phase += dt * (this.cur.speed + this.smoothAudio * 1.4);

      const w = this.size;
      const h = this.size;
      const cx = w / 2;
      const cy = h / 2;
      const breath = 1 + 0.025 * Math.sin(this.phase * 1.2) + this.smoothAudio * 0.11;
      const baseR = (w * 0.37) * this.cur.scale * breath;

      ctx.clearRect(0, 0, w, h);

      // 1. Soft ambient luminous halo behind the liquid-glass orb
      const haloGrad = ctx.createRadialGradient(cx, cy, baseR * 0.55, cx, cy, baseR * 1.42);
      haloGrad.addColorStop(0, rgba(this.cur.c2, 0.28 + this.smoothAudio * 0.18));
      haloGrad.addColorStop(0.6, rgba(this.cur.c3, 0.12 + this.smoothAudio * 0.08));
      haloGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR * 1.42, 0, Math.PI * 2);
      ctx.fill();

      // 2. Build organic morphing fluid contour (64 smooth harmonic vertices)
      const pts = 64;
      const morphAmp = this.cur.morph + this.smoothAudio * 0.085;
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * Math.PI * 2;
        const h1 = Math.sin(a * 3 + this.phase * 1.7) * morphAmp;
        const h2 = Math.cos(a * 5 - this.phase * 2.3) * (morphAmp * 0.55);
        const h3 = Math.sin(a * 2 + this.phase * 0.9) * (morphAmp * 0.45);
        const dirWave = this.cur.waveDir * Math.sin(a * 4 - this.phase * 3.8) * 0.032;
        const r = baseR * (1 + h1 + h2 + h3 + dirWave);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      // Base translucent pearlescent sphere fill
      const baseGrad = ctx.createRadialGradient(
        cx - baseR * 0.28, cy - baseR * 0.32, baseR * 0.08,
        cx, cy, baseR * 1.15
      );
      baseGrad.addColorStop(0, 'rgba(255,255,255,0.92)');
      baseGrad.addColorStop(0.38, rgba(this.cur.c2, 0.78));
      baseGrad.addColorStop(0.78, rgba(this.cur.c1, 0.88));
      baseGrad.addColorStop(1, rgba(this.cur.c3, 0.94));
      ctx.fillStyle = baseGrad;
      ctx.fill();

      // Clip internal flowing plasma layers inside the liquid contour
      ctx.clip();

      // 3. Five translucent flowing internal gradient ribbons (additive depth!)
      ctx.globalCompositeOperation = 'lighter';
      const lobes = [
        { col: this.cur.c1, rMul: 0.78, spd: 1.0, off: 0.0, orbit: 0.32 },
        { col: this.cur.c2, rMul: 0.72, spd: -1.3, off: 2.1, orbit: 0.38 },
        { col: this.cur.c3, rMul: 0.68, spd: 1.55, off: 4.2, orbit: 0.34 },
        { col: [255, 255, 255], rMul: 0.45, spd: -0.9, off: 1.2, orbit: 0.24 },
        { col: this.cur.c2, rMul: 0.62, spd: 2.1, off: 3.3, orbit: 0.30 }
      ];
      for (let i = 0; i < lobes.length; i++) {
        const lb = lobes[i];
        const t = this.phase * lb.spd + lb.off;
        const orbitR = baseR * lb.orbit * (0.75 + 0.35 * this.cur.turbulence);
        const lx = cx + Math.cos(t) * orbitR + this.cur.waveDir * Math.sin(this.phase * 3 + i) * baseR * 0.14;
        const ly = cy + Math.sin(t * 1.15) * orbitR * 0.85;
        const lr = baseR * lb.rMul * (0.92 + 0.16 * Math.sin(t * 1.4) + this.smoothAudio * 0.22);
        const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
        g.addColorStop(0, rgba(lb.col, i === 3 ? 0.48 : 0.62));
        g.addColorStop(0.55, rgba(lb.col, i === 3 ? 0.16 : 0.25));
        g.addColorStop(1, rgba(lb.col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(lx, ly, lr, 0, Math.PI * 2);
        ctx.fill();
      }

      // 4. Liquid-glass Fresnel rim refraction & top-left specular highlight
      ctx.globalCompositeOperation = 'source-over';
      const specGrad = ctx.createRadialGradient(
        cx - baseR * 0.34, cy - baseR * 0.38, baseR * 0.02,
        cx - baseR * 0.26, cy - baseR * 0.30, baseR * 0.52
      );
      specGrad.addColorStop(0, 'rgba(255,255,255,0.78)');
      specGrad.addColorStop(0.45, 'rgba(255,255,255,0.22)');
      specGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = specGrad;
      ctx.beginPath();
      ctx.arc(cx - baseR * 0.26, cy - baseR * 0.30, baseR * 0.52, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      // 5. Crisp subtle glass Fresnel edge stroke
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.62)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * Math.PI * 2;
        const h1 = Math.sin(a * 3 + this.phase * 1.7) * morphAmp;
        const h2 = Math.cos(a * 5 - this.phase * 2.3) * (morphAmp * 0.55);
        const h3 = Math.sin(a * 2 + this.phase * 0.9) * (morphAmp * 0.45);
        const dirWave = this.cur.waveDir * Math.sin(a * 4 - this.phase * 3.8) * 0.032;
        const r = baseR * (1 + h1 + h2 + h3 + dirWave);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  rootScope.SleepwalkerFluidOrb = SleepwalkerFluidOrb;
})(typeof window !== 'undefined' ? window : globalThis);
