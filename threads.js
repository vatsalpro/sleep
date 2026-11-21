/**
 * Sleepwalker - threads.js (Phase P2)
 * Fluid luminous golden edge curves, max-40 drifting sparkles/petals,
 * smooth dissolve-out particle burst, and reduced-motion static fallback.
 * Strictly stops requestAnimationFrame and clears canvas when idle.
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerThreads) return;

  const MAX_PARTICLES = 40;
  const AMBIENT_TARGET = 16;
  const DISSOLVE_MS = 480;

  class SleepwalkerThreads {
    constructor(shadowRoot, rootEl) {
      this.shadow = shadowRoot;
      this.rootEl = rootEl;
      this.mode = 'idle'; // 'idle'|'silent'|'listening'|'thinking'|'speaking'|'confirm'|'error'
      this.taskProcessing = false;
      this.level = 0.25;
      this.perimMix = 0; // 0 = bottom-edge ribbons, 1 = full screen perimeter
      this.dissolving = false;
      this.dissolveProgress = 0;
      this._dissolveStart = 0;
      this._dissolveDoneCb = null;
      this._rafId = 0;
      this._lastTs = 0;
      this._phase = 0;
      this.particles = [];
      this.reducedMotion = false;
      this.enabled = true;

      this._canvas = null;
      this._ctx = null;
      this._onResize = () => this._resizeCanvas();
      this._onMotionChange = (e) => {
        this.reducedMotion = Boolean(e && e.matches);
        this._syncMotionMode();
      };

      this._mount();
    }

    _mount() {
      const doc = rootScope.document;
      if (!doc || !this.shadow || !this.rootEl) return;

      this._canvas = doc.createElement('canvas');
      this._canvas.id = 'sw-ui-threads';
      this._canvas.className = 'sw-threads-canvas';
      this._canvas.setAttribute('aria-hidden', 'true');
      this.rootEl.prepend(this._canvas);

      const veil = doc.createElement('div');
      veil.id = 'sw-ui-veil';
      veil.className = 'sw-ui-veil';
      veil.setAttribute('aria-hidden', 'true');
      this.rootEl.prepend(veil);

      this._ctx = this._canvas.getContext('2d');
      this._resizeCanvas();

      if (typeof rootScope.addEventListener === 'function') {
        rootScope.addEventListener('resize', this._onResize);
      }
      if (typeof rootScope.matchMedia === 'function') {
        this._mq = rootScope.matchMedia('(prefers-reduced-motion: reduce)');
        this.reducedMotion = Boolean(this._mq.matches);
        if (typeof this._mq.addEventListener === 'function') {
          this._mq.addEventListener('change', this._onMotionChange);
        }
      }
    }

    _resizeCanvas() {
      if (!this._canvas) return;
      const dpr = Math.min(rootScope.devicePixelRatio || 1, 2);
      const w = Math.max(320, rootScope.innerWidth || 1280);
      const h = Math.max(240, rootScope.innerHeight || 720);
      this._w = w;
      this._h = h;
      this._dpr = dpr;
      this._canvas.width = Math.round(w * dpr);
      this._canvas.height = Math.round(h * dpr);
      if (this._ctx) this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.reducedMotion && this.mode !== 'idle') this._drawStaticGlow();
    }

    setMode(nextMode = 'idle') {
      this.mode = nextMode;
      if (nextMode !== 'idle') { this.dissolving = false; this.dissolveProgress = 0; this._dissolveDoneCb = null; }
      if (nextMode === 'idle' && !this.dissolving && !this.taskProcessing) { this.stop(); return; }
      this._syncMotionMode();
    }
    setTaskProcessing(active = false) {
      this.taskProcessing = Boolean(active);
      if (this.taskProcessing && this.enabled) {
        this._syncMotionMode();
      } else if (this.mode === 'idle' && !this.dissolving) {
        this.stop();
      }
    }
    setLevel(lvl = 0.25) { this.level = Math.max(0, Math.min(1, Number(lvl) || 0)); }
    setEnabled(flag = true) {
      this.enabled = flag !== false;
      const veil = this.shadow && this.shadow.getElementById('sw-ui-veil');
      if (veil) veil.hidden = !this.enabled;
      if (this._canvas) this._canvas.hidden = !this.enabled;
      if (!this.enabled) this.stop();
      else if (this.mode !== 'idle') this._syncMotionMode();
    }
    isRunning() { return Boolean(this._rafId); }
    getParticleCount() { return this.particles.length; }

    triggerDissolve(originRect, onDone) {
      this._dissolveDoneCb = typeof onDone === 'function' ? onDone : null;
      if (this.reducedMotion || !this.enabled) {
        this.stop();
        const cb = this._dissolveDoneCb;
        this._dissolveDoneCb = null;
        if (cb) cb();
        return;
      }
      this.dissolving = true;
      this.dissolveProgress = 0;
      this._dissolveStart = (rootScope.performance && rootScope.performance.now) ? rootScope.performance.now() : Date.now();
      const cx = originRect ? (originRect.left + originRect.width / 2) : (this._w / 2);
      const cy = originRect ? (originRect.top + originRect.height / 2) : (this._h - 68);
      const addCount = Math.max(0, Math.min(24, MAX_PARTICLES - this.particles.length));
      for (let i = 0; i < addCount; i++) {
        const angle = (-Math.PI * 0.9) + Math.random() * (Math.PI * 0.8);
        const speed = 38 + Math.random() * 95;
        this.particles.push({
          x: cx + (Math.random() - 0.5) * 44, y: cy + (Math.random() - 0.5) * 28,
          vx: Math.cos(angle) * speed * 0.65, vy: -Math.abs(Math.sin(angle) * speed) - 18,
          size: 2.2 + Math.random() * 3.4, rot: Math.random() * Math.PI,
          life: 0, maxLife: 0.45 + Math.random() * 0.25, petal: i % 2 === 0
        });
      }
      this._startLoop();
    }

    stop() {
      if (this._rafId && typeof rootScope.cancelAnimationFrame === 'function') rootScope.cancelAnimationFrame(this._rafId);
      this._rafId = 0; this.dissolving = false; this.particles = []; this.perimMix = 0;
      if (this._ctx && this._canvas) this._ctx.clearRect(0, 0, this._w || 1440, this._h || 900);
    }

    _syncMotionMode() {
      if (!this.enabled || (this.mode === 'idle' && !this.dissolving && !this.taskProcessing)) { this.stop(); return; }
      if (this.reducedMotion) {
        if (this._rafId && typeof rootScope.cancelAnimationFrame === 'function') rootScope.cancelAnimationFrame(this._rafId);
        this._rafId = 0; this.particles = [];
        this._drawStaticGlow();
      } else this._startLoop();
    }

    _startLoop() {
      if (this._rafId || this.reducedMotion || typeof rootScope.requestAnimationFrame !== 'function') return;
      this._lastTs = (rootScope.performance && rootScope.performance.now) ? rootScope.performance.now() : Date.now();
      const frame = (ts) => {
        const dt = Math.min(0.05, Math.max(0.004, (ts - this._lastTs) / 1000));
        this._lastTs = ts;
        this._tick(dt, ts);
        if (this._rafId) {
          this._rafId = rootScope.requestAnimationFrame(frame);
        }
      };
      this._rafId = rootScope.requestAnimationFrame(frame);
    }

    _tick(dt, ts) {
      if (!this._ctx) return;
      const w = this._w || 1280;
      const h = this._h || 720;
      const ctx = this._ctx;

      let fade = 1;
      if (this.dissolving) {
        this.dissolveProgress = Math.min(1, (ts - this._dissolveStart) / DISSOLVE_MS);
        fade = 1 - this.dissolveProgress;
        if (this.dissolveProgress >= 1) {
          const cb = this._dissolveDoneCb;
          this.stop();
          if (cb) cb();
          return;
        }
      }

      const targetPerim = (this.taskProcessing || this.mode === 'thinking') ? 1 : 0;
      this.perimMix += (targetPerim - this.perimMix) * Math.min(1, dt * 5.2);
      this._phase += dt * ((this.taskProcessing || this.mode === 'thinking') ? 2.25 : (this.mode === 'speaking' ? 1.65 : 1.05));

      ctx.clearRect(0, 0, w, h);
      this._drawBottomCurves(ctx, w, h, fade);
      if (this.perimMix > 0.02) {
        this._drawPerimeterCurves(ctx, w, h, this.perimMix * fade);
      }
      this._stepParticles(dt, w, h);
      this._drawParticles(ctx, fade);
    }

    _drawBottomCurves(ctx, w, h, alphaScale) {
      // 4 subtle thin flowing golden-thread & aurora-mist curves hugging the bottom edge
      const ampBase = 8 + this.level * 15;
      const configs = [
        { yOff: 34, amp: ampBase * 1.12, freq: 1.0, phase: 0, width: 1.65, alpha: 0.72, color: '#ffe59c' },
        { yOff: 44, amp: ampBase * 0.88, freq: 1.35, phase: 1.7, width: 1.2, alpha: 0.50, color: '#f3be52' },
        { yOff: 26, amp: ampBase * 0.68, freq: 0.85, phase: 3.1, width: 1.05, alpha: 0.44, color: '#d7c3ff' },
        { yOff: 52, amp: ampBase * 1.02, freq: 1.55, phase: 4.4, width: 0.85, alpha: 0.36, color: '#fff3cb' }
      ];
      ctx.save();
      for (const c of configs) {
        ctx.beginPath();
        const steps = 28;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = t * w;
          // Curves lift softly toward the edges and weave gracefully behind bottom-center orb
          const edgeLift = Math.pow(Math.abs(t - 0.5) * 2, 1.8) * 44;
          const wave = Math.sin(t * Math.PI * 2 * c.freq + this._phase + c.phase) * c.amp;
          const y = h - c.yOff - edgeLift + wave * 0.55;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = c.color;
        ctx.globalAlpha = c.alpha * alphaScale;
        ctx.lineWidth = c.width;
        ctx.shadowColor = 'rgba(246, 200, 96, 0.72)';
        ctx.shadowBlur = 10;
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawPerimeterCurves(ctx, w, h, alphaScale) {
      const m = 6;
      ctx.save();
      // Full-viewport soft outer-edge golden aurora ribbons along top, right, bottom, and left boundaries
      for (let k = 0; k < 3; k++) {
        const inset = m + k * 6;
        const wiggle = Math.sin(this._phase + k * 1.6) * 5;
        ctx.beginPath();
        ctx.moveTo(inset, h - inset);
        ctx.bezierCurveTo(inset + wiggle, h * 0.65, inset - wiggle, h * 0.35, inset, inset);
        ctx.bezierCurveTo(w * 0.35, inset + wiggle, w * 0.65, inset - wiggle, w - inset, inset);
        ctx.bezierCurveTo(w - inset - wiggle, h * 0.35, w - inset + wiggle, h * 0.65, w - inset, h - inset);
        ctx.bezierCurveTo(w * 0.65, h - inset - wiggle, w * 0.35, h - inset + wiggle, inset, h - inset);
        ctx.closePath();
        ctx.strokeStyle = k === 1 ? '#d7c3ff' : (k === 0 ? '#ffe59c' : '#f3be52');
        ctx.globalAlpha = (0.58 - k * 0.14) * alphaScale;
        ctx.lineWidth = 2.2 - k * 0.45;
        ctx.shadowColor = 'rgba(246, 200, 96, 0.72)';
        ctx.shadowBlur = 16;
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawStaticGlow() {
      if (!this._ctx) return;
      const w = this._w || 1280;
      const h = this._h || 720;
      const ctx = this._ctx;
      ctx.clearRect(0, 0, w, h);
      const grad = ctx.createRadialGradient(w / 2, h - 40, 20, w / 2, h - 40, Math.max(w * 0.45, 320));
      grad.addColorStop(0, 'rgba(255, 226, 150, 0.32)');
      grad.addColorStop(0.55, 'rgba(158, 135, 245, 0.14)');
      grad.addColorStop(1, 'rgba(255, 226, 150, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, h - 220, w, 220);
      if (this.taskProcessing || this.mode === 'thinking') {
        ctx.save();
        ctx.strokeStyle = 'rgba(243, 190, 82, 0.65)';
        ctx.lineWidth = 3;
        ctx.strokeRect(4, 4, w - 8, h - 8);
        ctx.restore();
      }
    }

    _stepParticles(dt, w, h) {
      if (!this.dissolving && this.particles.length < AMBIENT_TARGET && Math.random() < dt * 7) {
        this.particles.push({
          x: Math.random() * w, y: h - 14 - Math.random() * 55,
          vx: (Math.random() - 0.5) * 16, vy: -(12 + Math.random() * 22),
          size: 1.8 + Math.random() * 2.6, rot: Math.random() * Math.PI,
          life: 0, maxLife: 1.6 + Math.random() * 1.4, petal: this.particles.length % 3 === 0
        });
      }
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += dt * 1.1;
        if (p.life >= p.maxLife) this.particles.splice(i, 1);
      }
      if (this.particles.length > MAX_PARTICLES) this.particles.length = MAX_PARTICLES;
    }

    _drawParticles(ctx, fade) {
      ctx.save();
      for (const p of this.particles) {
        const env = Math.sin((p.life / p.maxLife) * Math.PI);
        ctx.globalAlpha = Math.max(0, env * 0.88 * fade);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.petal ? '#fff4cf' : '#ffd275';
        ctx.shadowColor = 'rgba(255, 220, 130, 0.85)';
        ctx.shadowBlur = 7;
        ctx.beginPath();
        if (p.petal) ctx.ellipse(0, 0, p.size * 1.7, p.size * 0.65, 0, 0, Math.PI * 2);
        else ctx.arc(0, 0, p.size * 0.75, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
  }

  rootScope.SleepwalkerThreads = SleepwalkerThreads;
})(typeof window !== 'undefined' ? window : globalThis);
