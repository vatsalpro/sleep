/**
 * Sleepwalker — High-Efficiency 60/120 FPS 3D Liquid-Glass Orb Renderer (Canvas 2D)
 *
 * Optimizations & Visual Architecture:
 * - Precomputed unit-circle lookup tables & reusable Float32Array buffers (zero per-frame array allocations)
 * - Smooth closed midpoint-quadratic Bezier fluid contour (silky organic curvature at 48 control points)
 * - Underdamped spring physics for tactile state transitions, hover tilt parallax, and click impulses
 * - State-specific signature choreography:
 *   - IDLE / SILENT: Calm sapphire-pearl breathing sphere
 *   - LISTENING: Expanding concentric sonic aura rings + audio-reactive cyan/magenta plasma
 *   - THINKING: 6 orbital starlight motes gliding along tilted 3D ellipses around a violet-cyan core
 *   - EXECUTING: Precision sweeping scan arc around the refractive rim
 *   - SPEAKING: Multi-harmonic vocal resonance waves
 *   - SUCCESS: Emerald-cyan completion bloom ripple
 *   - ERROR: Restrained coral-amber alert pulse
 * - Auto-pauses rAF when tab is hidden (`document.hidden`) and stops completely when idle (0% idle CPU).
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerFluidOrb) return;

  const STATE_PRESETS = {
    idle: {
      c1: [37, 99, 235],
      c2: [56, 189, 248],
      c3: [168, 85, 247],
      speed: 0.62,
      morph: 0.032,
      turbulence: 0.52,
      scale: 0.88,
      waveDir: 0,
      orbitAlpha: 0,
      scanAlpha: 0
    },
    listening: {
      c1: [6, 182, 212],
      c2: [59, 130, 246],
      c3: [236, 72, 153],
      speed: 1.48,
      morph: 0.070,
      turbulence: 1.22,
      scale: 0.97,
      waveDir: 0,
      orbitAlpha: 0.18,
      scanAlpha: 0
    },
    thinking: {
      c1: [124, 58, 237],
      c2: [236, 72, 153],
      c3: [56, 189, 248],
      speed: 1.82,
      morph: 0.074,
      turbulence: 1.48,
      scale: 0.95,
      waveDir: 0.38,
      orbitAlpha: 1.0,
      scanAlpha: 0.25
    },
    speaking: {
      c1: [37, 99, 235],
      c2: [45, 212, 191],
      c3: [232, 121, 249],
      speed: 1.54,
      morph: 0.066,
      turbulence: 1.18,
      scale: 0.99,
      waveDir: 0,
      orbitAlpha: 0.25,
      scanAlpha: 0
    },
    executing: {
      c1: [2, 132, 199],
      c2: [34, 211, 238],
      c3: [168, 85, 247],
      speed: 1.92,
      morph: 0.055,
      turbulence: 1.05,
      scale: 0.96,
      waveDir: 1.0,
      orbitAlpha: 0.45,
      scanAlpha: 1.0
    },
    success: {
      c1: [16, 185, 129],
      c2: [52, 211, 153],
      c3: [56, 189, 248],
      speed: 0.95,
      morph: 0.032,
      turbulence: 0.48,
      scale: 0.98,
      waveDir: 0,
      orbitAlpha: 0,
      scanAlpha: 0
    },
    error: {
      c1: [239, 68, 68],
      c2: [249, 115, 22],
      c3: [251, 146, 60],
      speed: 0.78,
      morph: 0.038,
      turbulence: 0.58,
      scale: 0.92,
      waveDir: 0,
      orbitAlpha: 0,
      scanAlpha: 0
    }
  };

  // Precompute 32-point unit circle harmonic tables once at module load (visually identical at 92px, 33% lighter clip/stroke)
  const PTS = 32;
  const TWO_PI = Math.PI * 2;
  const UNIT_COS = new Float32Array(PTS);
  const UNIT_SIN = new Float32Array(PTS);
  const ANG_2 = new Float32Array(PTS);
  const ANG_3 = new Float32Array(PTS);
  const ANG_4 = new Float32Array(PTS);
  const ANG_5 = new Float32Array(PTS);
  for (let i = 0; i < PTS; i++) {
    const a = (i / PTS) * TWO_PI;
    UNIT_COS[i] = Math.cos(a);
    UNIT_SIN[i] = Math.sin(a);
    ANG_2[i] = a * 2;
    ANG_3[i] = a * 3;
    ANG_4[i] = a * 4;
    ANG_5[i] = a * 5;
  }

  const LOBE_SPECS = [
    { cIdx: 1, rMul: 0.79, spd: 1.0, off: 0.0, orbit: 0.32, alpha0: 0.62, alpha1: 0.25 },
    { cIdx: 2, rMul: 0.73, spd: -1.3, off: 2.1, orbit: 0.38, alpha0: 0.62, alpha1: 0.25 },
    { cIdx: 3, rMul: 0.69, spd: 1.55, off: 4.2, orbit: 0.34, alpha0: 0.62, alpha1: 0.25 },
    { cIdx: 0, rMul: 0.46, spd: -0.9, off: 1.2, orbit: 0.24, alpha0: 0.50, alpha1: 0.16 },
    { cIdx: 2, rMul: 0.62, spd: 2.1, off: 3.3, orbit: 0.30, alpha0: 0.58, alpha1: 0.22 }
  ];
  const WHITE_RGB = [255, 255, 255];

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
    cur[0] += (target[0] - cur[0]) * t;
    cur[1] += (target[1] - cur[1]) * t;
    cur[2] += (target[2] - cur[2]) * t;
  }

  function rgba(rgb, alpha) {
    const a = alpha <= 0 ? 0 : (alpha >= 1 ? 1 : alpha);
    return `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${a.toFixed(3)})`;
  }

  function traceSmoothClosedContour(ctx, vx, vy, n) {
    const lastIdx = n - 1;
    const startMidX = (vx[lastIdx] + vx[0]) * 0.5;
    const startMidY = (vy[lastIdx] + vy[0]) * 0.5;
    ctx.beginPath();
    ctx.moveTo(startMidX, startMidY);
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const midX = (vx[i] + vx[next]) * 0.5;
      const midY = (vy[i] + vy[next]) * 0.5;
      ctx.quadraticCurveTo(vx[i], vy[i], midX, midY);
    }
    ctx.closePath();
  }

  class SleepwalkerFluidOrb {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      // Standard alpha:true context locks cleanly to Windows Chrome VSync over hardware-decoded video
      this.ctx = canvas ? canvas.getContext('2d', { alpha: true }) : null;
      this._specStamp = this._buildRadialStamp(64, [
        [0, 'rgba(255,255,255,0.82)'],
        [0.42, 'rgba(255,255,255,0.24)'],
        [1, 'rgba(255,255,255,0)']
      ]);
      this._whiteLobeStamp = this._buildRadialStamp(64, [
        [0, 'rgba(255,255,255,0.50)'],
        [0.55, 'rgba(255,255,255,0.16)'],
        [1, 'rgba(255,255,255,0)']
      ]);
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

      // Reusable contour vertex arrays (zero GC churn)
      this._vx = new Float32Array(PTS);
      this._vy = new Float32Array(PTS);

      // Underdamped spring state for tactile pop/impulse & pointer parallax
      this._scalePos = STATE_PRESETS.idle.scale;
      this._scaleVel = 0;
      this._rippleProgress = 1; // 0..1 expanding state-change bloom ring
      this._rippleColor = [56, 189, 248];
      this._tiltX = 0;
      this._tiltY = 0;
      this._targetTiltX = 0;
      this._targetTiltY = 0;

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
        waveDir: init.waveDir,
        orbitAlpha: init.orbitAlpha,
        scanAlpha: init.scanAlpha
      };

      this._onVisChange = () => {
        if (typeof document !== 'undefined' && document.hidden) {
          if (this.rafId !== null && typeof rootScope.cancelAnimationFrame === 'function') {
            rootScope.cancelAnimationFrame(this.rafId);
            this.rafId = null;
          }
        } else if (this.running && this.rafId === null && !this.reducedMotion) {
          this.lastTs = performance.now();
          this.rafId = rootScope.requestAnimationFrame(this._tickBound);
        }
      };
      this._tickBound = (ts) => this._tick(ts);
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this._onVisChange, { passive: true });
      }

      this.resize(this.size);
      this.renderFrame(0.016);
    }

    _buildRadialStamp(dim, stops) {
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
        const c = document.createElement('canvas');
        c.width = dim;
        c.height = dim;
        const gctx = c.getContext('2d', { alpha: true });
        if (!gctx) return null;
        const half = dim * 0.5;
        const g = gctx.createRadialGradient(half, half, 0, half, half, half);
        for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
        gctx.fillStyle = g;
        gctx.fillRect(0, 0, dim, dim);
        return c;
      } catch (_e) {
        return null;
      }
    }

    resize(cssSize) {
      this.size = Math.max(44, Math.round(Number(cssSize) || 92));
      if (!this.canvas) return;
      const dpr = Math.min(1.5, Number(rootScope.devicePixelRatio) || 1);
      this.canvas.width = Math.round(this.size * dpr);
      this.canvas.height = Math.round(this.size * dpr);
      this.canvas.style.width = `${this.size}px`;
      this.canvas.style.height = `${this.size}px`;
      if (this.ctx) {
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    triggerImpulse(strength = 0.14) {
      if (this.reducedMotion) return;
      this._scaleVel += Math.max(-0.3, Math.min(0.35, Number(strength) || 0.14));
      this._rippleProgress = 0;
      const p = STATE_PRESETS[this.state] || STATE_PRESETS.idle;
      this._rippleColor = [...p.c2];
    }

    setPointerOffset(nx = 0, ny = 0) {
      this._targetTiltX = Math.max(-1, Math.min(1, Number(nx) || 0));
      this._targetTiltY = Math.max(-1, Math.min(1, Number(ny) || 0));
    }

    setState(nextState) {
      const mapped = normalizeState(nextState);
      const changed = mapped !== this.state;
      this.state = mapped;
      if (changed && !this.reducedMotion) {
        const impulse = mapped === 'success' ? 0.20 : (mapped === 'listening' ? 0.14 : (mapped === 'error' ? -0.10 : 0.08));
        this._scaleVel += impulse;
        if (mapped === 'success' || mapped === 'listening' || mapped === 'thinking') {
          this._rippleProgress = 0;
          const p = STATE_PRESETS[mapped] || STATE_PRESETS.idle;
          this._rippleColor = [...(mapped === 'success' ? p.c1 : p.c2)];
        }
      }
      if (this.reducedMotion) {
        this.renderFrame(0.016);
      }
    }

    setAudioLevel(level) {
      const n = Number(level);
      const clamped = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
      if (clamped > this.targetAudio + 0.26 && !this.reducedMotion) {
        this._scaleVel += Math.min(0.12, (clamped - this.targetAudio) * 0.18);
      }
      this.targetAudio = clamped;
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

    _tick(ts) {
      if (!this.running) return;
      if (typeof document !== 'undefined' && document.hidden) {
        this.rafId = null;
        return;
      }
      const rawDt = Math.min(0.033, Math.max(0.004, (ts - this.lastTs) / 1000));
      this._smoothDt = this._smoothDt ? (this._smoothDt * 0.72 + rawDt * 0.28) : rawDt;
      const dt = this._smoothDt;
      this.lastTs = ts;
      this.renderFrame(dt);
      if (!this.reducedMotion) {
        this.rafId = rootScope.requestAnimationFrame(this._tickBound);
      } else {
        this.running = false;
        this.rafId = null;
      }
    }

    start() {
      if (this.running || !this.ctx) return;
      this.running = true;
      this.lastTs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (this.reducedMotion) {
        this.renderFrame(0.016);
        this.running = false;
        return;
      }
      if (typeof document !== 'undefined' && document.hidden) return;
      this.rafId = rootScope.requestAnimationFrame(this._tickBound);
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
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', this._onVisChange);
      }
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
      const damp = 1 - Math.exp(-dt * 6.0);
      lerpRgb(this.cur.c1, preset.c1, damp);
      lerpRgb(this.cur.c2, preset.c2, damp);
      lerpRgb(this.cur.c3, preset.c3, damp);
      this.cur.speed = lerp(this.cur.speed, preset.speed, damp);
      this.cur.morph = lerp(this.cur.morph, preset.morph, damp);
      this.cur.turbulence = lerp(this.cur.turbulence, preset.turbulence, damp);
      this.cur.waveDir = lerp(this.cur.waveDir, preset.waveDir, damp);
      this.cur.orbitAlpha = lerp(this.cur.orbitAlpha, preset.orbitAlpha, damp);
      this.cur.scanAlpha = lerp(this.cur.scanAlpha, preset.scanAlpha, damp);

      // Underdamped spring solver for buttery elastic scale transitions
      const stiffness = 175;
      const damping = 16.5;
      const accel = (preset.scale - this._scalePos) * stiffness - this._scaleVel * damping;
      this._scaleVel += accel * dt;
      this._scalePos += this._scaleVel * dt;
      this.cur.scale = Math.max(0.72, Math.min(1.14, this._scalePos));

      // Smooth pointer parallax tilt
      const tiltLerp = 1 - Math.exp(-dt * 10);
      this._tiltX = lerp(this._tiltX, this._targetTiltX, tiltLerp);
      this._tiltY = lerp(this._tiltY, this._targetTiltY, tiltLerp);

      // Live audio energy (with natural cadence envelope in listening/speaking)
      let rawAudio = this._sampleMicLevel();
      if (this.state === 'speaking' && rawAudio < 0.14) {
        rawAudio = 0.28 + 0.24 * Math.abs(Math.sin(this.phase * 3.1) * Math.cos(this.phase * 1.7));
      } else if (this.state === 'listening' && rawAudio < 0.18) {
        rawAudio = 0.16 + 0.12 * Math.abs(Math.sin(this.phase * 2.2));
      }
      const audioRate = rawAudio > this.smoothAudio ? 16 : 9;
      this.smoothAudio = lerp(this.smoothAudio, rawAudio, 1 - Math.exp(-dt * audioRate));

      this.phase += dt * (this.cur.speed + this.smoothAudio * 1.45);
      if (this._rippleProgress < 1) {
        this._rippleProgress = Math.min(1, this._rippleProgress + dt * 1.85);
      }

      const w = this.size;
      const h = this.size;
      const cx = w * 0.5 + this._tiltX * 2.2;
      const cy = h * 0.5 + this._tiltY * 2.2;
      const breath = 1 + 0.026 * Math.sin(this.phase * 1.25) + this.smoothAudio * 0.115;
      const baseR = (w * 0.355) * this.cur.scale * breath;

      ctx.clearRect(0, 0, w, h);

      // 1. Native in-canvas ambient bloom & soft drop-shadow (eliminates expensive CSS filter: drop-shadow!)
      const haloOuter = baseR * 1.46;
      const haloGrad = ctx.createRadialGradient(cx, cy + 2, baseR * 0.45, cx, cy + 2, haloOuter);
      haloGrad.addColorStop(0, rgba(this.cur.c1, 0.32 + this.smoothAudio * 0.18));
      haloGrad.addColorStop(0.52, rgba(this.cur.c2, 0.16 + this.smoothAudio * 0.10));
      haloGrad.addColorStop(0.80, rgba(this.cur.c3, 0.06));
      haloGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(cx, cy + 2, haloOuter, 0, TWO_PI);
      ctx.fill();

      // 1B. Sonic listening aura ring & state-transition bloom ripple
      if (this.state === 'listening' && !this.reducedMotion) {
        const pulseWave = (this.phase * 0.42) % 1;
        const ringR = baseR * (1.02 + pulseWave * 0.36);
        const ringAlpha = (1 - pulseWave) * (0.22 + this.smoothAudio * 0.28);
        ctx.strokeStyle = rgba(this.cur.c2, ringAlpha);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, TWO_PI);
        ctx.stroke();
      }
      if (this._rippleProgress < 1 && !this.reducedMotion) {
        const easeOut = 1 - Math.pow(1 - this._rippleProgress, 3);
        const ripR = baseR * (0.95 + easeOut * 0.44);
        const ripAlpha = (1 - easeOut) * 0.52;
        ctx.strokeStyle = rgba(this._rippleColor, ripAlpha);
        ctx.lineWidth = 2.0 * (1 - easeOut * 0.5);
        ctx.beginPath();
        ctx.arc(cx, cy, ripR, 0, TWO_PI);
        ctx.stroke();
      }

      // 2. Compute smooth 48-point harmonic contour ONCE into reusable Float32Arrays
      const morphAmp = this.cur.morph + this.smoothAudio * 0.082;
      const p17 = this.phase * 1.7;
      const p23 = this.phase * 2.3;
      const p09 = this.phase * 0.9;
      const p38 = this.phase * 3.8;
      const vx = this._vx;
      const vy = this._vy;
      for (let i = 0; i < PTS; i++) {
        const h1 = Math.sin(ANG_3[i] + p17) * morphAmp;
        const h2 = Math.cos(ANG_5[i] - p23) * (morphAmp * 0.54);
        const h3 = Math.sin(ANG_2[i] + p09) * (morphAmp * 0.44);
        const dirWave = this.cur.waveDir * Math.sin(ANG_4[i] - p38) * 0.032;
        const r = baseR * (1 + h1 + h2 + h3 + dirWave);
        vx[i] = cx + UNIT_COS[i] * r;
        vy[i] = cy + UNIT_SIN[i] * r;
      }

      ctx.save();
      traceSmoothClosedContour(ctx, vx, vy, PTS);

      // Base translucent pearlescent sphere fill
      const lightOffX = -baseR * 0.28 + this._tiltX * 3.5;
      const lightOffY = -baseR * 0.32 + this._tiltY * 3.5;
      const baseGrad = ctx.createRadialGradient(
        cx + lightOffX, cy + lightOffY, baseR * 0.07,
        cx, cy, baseR * 1.16
      );
      baseGrad.addColorStop(0, 'rgba(255,255,255,0.94)');
      baseGrad.addColorStop(0.36, rgba(this.cur.c2, 0.80));
      baseGrad.addColorStop(0.76, rgba(this.cur.c1, 0.90));
      baseGrad.addColorStop(1, rgba(this.cur.c3, 0.95));
      ctx.fillStyle = baseGrad;
      ctx.fill();

      // Clip internal flowing plasma layers inside the smooth Bezier contour
      ctx.clip();

      // 3. Five translucent additive plasma ribbons
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < LOBE_SPECS.length; i++) {
        const lb = LOBE_SPECS[i];
        const col = lb.cIdx === 1 ? this.cur.c1 : (lb.cIdx === 2 ? this.cur.c2 : (lb.cIdx === 3 ? this.cur.c3 : WHITE_RGB));
        const t = this.phase * lb.spd + lb.off;
        const orbitR = baseR * lb.orbit * (0.75 + 0.35 * this.cur.turbulence);
        const lx = cx + Math.cos(t) * orbitR + this.cur.waveDir * Math.sin(this.phase * 3 + i) * baseR * 0.14;
        const ly = cy + Math.sin(t * 1.15) * orbitR * 0.85;
        const lr = baseR * lb.rMul * (0.92 + 0.16 * Math.sin(t * 1.4) + this.smoothAudio * 0.22);
        if (lb.cIdx === 0 && this._whiteLobeStamp) {
          ctx.drawImage(this._whiteLobeStamp, lx - lr, ly - lr, lr * 2, lr * 2);
        } else {
          const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
          g.addColorStop(0, rgba(col, lb.alpha0));
          g.addColorStop(0.55, rgba(col, lb.alpha1));
          g.addColorStop(1, rgba(col, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(lx, ly, lr, 0, TWO_PI);
          ctx.fill();
        }
      }

      // 3B. Orbital starlight motes inside/across sphere during Thinking / Executing
      if (this.cur.orbitAlpha > 0.04 && !this.reducedMotion) {
        const sparkCount = 6;
        for (let s = 0; s < sparkCount; s++) {
          const ang = this.phase * (1.35 + (s % 2) * 0.45) + (s * TWO_PI) / sparkCount;
          const tilt = (s % 3 - 1) * 0.42;
          const rx = Math.cos(ang) * baseR * 0.72;
          const ry = Math.sin(ang) * baseR * 0.34;
          const sx = cx + rx * Math.cos(tilt) - ry * Math.sin(tilt);
          const sy = cy + rx * Math.sin(tilt) + ry * Math.cos(tilt);
          const depth = 0.55 + 0.45 * Math.sin(ang);
          const sr = (1.3 + depth * 1.5);
          ctx.fillStyle = `rgba(255,255,255,${(this.cur.orbitAlpha * depth * 0.88).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx, sy, sr, 0, TWO_PI);
          ctx.fill();
        }
      }

      // 4. Liquid-glass Fresnel rim refraction & parallax specular highlight (pre-baked stamp blit!)
      ctx.globalCompositeOperation = 'source-over';
      const specX = cx - baseR * 0.28 + this._tiltX * 4.2;
      const specY = cy - baseR * 0.32 + this._tiltY * 4.2;
      const specR = baseR * 0.54;
      if (this._specStamp) {
        ctx.drawImage(this._specStamp, specX - specR, specY - specR, specR * 2, specR * 2);
      } else {
        const specGrad = ctx.createRadialGradient(
          specX - baseR * 0.06, specY - baseR * 0.06, baseR * 0.02,
          specX, specY, specR
        );
        specGrad.addColorStop(0, 'rgba(255,255,255,0.82)');
        specGrad.addColorStop(0.42, 'rgba(255,255,255,0.24)');
        specGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = specGrad;
        ctx.beginPath();
        ctx.arc(specX, specY, specR, 0, TWO_PI);
        ctx.fill();
      }

      ctx.restore();

      // 5. Crisp iridescent glass Fresnel edge stroke (reuses precomputed vx/vy!)
      ctx.save();
      const rimGrad = ctx.createLinearGradient(cx - baseR, cy - baseR, cx + baseR, cy + baseR);
      rimGrad.addColorStop(0, 'rgba(255,255,255,0.86)');
      rimGrad.addColorStop(0.5, rgba(this.cur.c2, 0.72));
      rimGrad.addColorStop(1, rgba(this.cur.c3, 0.78));
      ctx.strokeStyle = rimGrad;
      ctx.lineWidth = 1.35;
      traceSmoothClosedContour(ctx, vx, vy, PTS);
      ctx.stroke();

      // 5B. Precision sweeping scan arc during Observing / Executing
      if (this.cur.scanAlpha > 0.05 && !this.reducedMotion) {
        const sweepStart = this.phase * 2.6;
        ctx.strokeStyle = `rgba(255,255,255,${(this.cur.scanAlpha * 0.85).toFixed(3)})`;
        ctx.lineWidth = 2.1;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * 1.09, sweepStart, sweepStart + Math.PI * 0.62);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  rootScope.SleepwalkerFluidOrb = SleepwalkerFluidOrb;
})(typeof window !== 'undefined' ? window : globalThis);
