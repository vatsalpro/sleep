/**
 * Sleepwalker - threads.js
 * Zero-Idle-Cost Luminous Micro-Stardust Dissolve & Lifecycle Companion.
 * Consumes 0% CPU and 0 DOM nodes when idle or active; spawns a tiny localized
 * 180x180 GPU-friendly canvas ONLY during the ~240ms orb dismiss/dissolve transition,
 * then immediately tears it down. Respects prefers-reduced-motion.
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerThreads) return;

  const MOTES = 14;
  const COLORS = [
    '56, 189, 248',
    '139, 92, 246',
    '236, 72, 153',
    '255, 255, 255'
  ];

  class SleepwalkerThreads {
    constructor(shadowRoot, rootEl) {
      this.shadow = shadowRoot;
      this.rootEl = rootEl;
      this.mode = 'idle';
      this.taskProcessing = false;
      this.level = 0;
      this.enabled = false;
      this.reducedMotion = Boolean(
        typeof rootScope.matchMedia === 'function' &&
        rootScope.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
      this._dissolveTimer = null;
      this._dissolveRaf = null;
      this._burstCanvas = null;

      this._cleanupOldElements();
    }

    _cleanupOldElements() {
      if (this._burstCanvas) {
        try { this._burstCanvas.remove(); } catch (_e) {}
        this._burstCanvas = null;
      }
      if (this.rootEl) {
        const oldCanvas = this.rootEl.querySelector('#sw-ui-threads');
        if (oldCanvas) oldCanvas.remove();
        const oldVeil = this.rootEl.querySelector('#sw-ui-veil');
        if (oldVeil) oldVeil.remove();
      }
      if (this.shadow) {
        const oldCanvas = this.shadow.getElementById('sw-ui-threads');
        if (oldCanvas) oldCanvas.remove();
        const oldVeil = this.shadow.getElementById('sw-ui-veil');
        if (oldVeil) oldVeil.remove();
      }
    }

    setMode(nextMode = 'idle') {
      this.mode = nextMode;
    }

    setTaskProcessing(active = false) {
      this.taskProcessing = Boolean(active);
    }

    setLevel(lvl = 0) {
      this.level = Math.max(0, Math.min(1, Number(lvl) || 0));
    }

    setEnabled(flag = false) {
      this.enabled = Boolean(flag);
    }

    triggerDissolve(originRect, onDone) {
      this._cancelDissolve();

      const finish = () => {
        this._cancelDissolve();
        if (typeof onDone === 'function') onDone();
      };

      const doc = rootScope.document;
      if (
        this.reducedMotion ||
        !doc ||
        !this.rootEl ||
        !originRect ||
        !(originRect.width > 0) ||
        typeof rootScope.requestAnimationFrame !== 'function'
      ) {
        this._dissolveTimer = setTimeout(finish, 110);
        return;
      }

      try {
        const box = 176;
        const dpr = Math.min(2, Number(rootScope.devicePixelRatio) || 1);
        const cx = originRect.left + originRect.width * 0.5;
        const cy = originRect.top + originRect.height * 0.5;
        const canvas = doc.createElement('canvas');
        canvas.className = 'sw-dissolve-burst';
        canvas.setAttribute('aria-hidden', 'true');
        canvas.width = Math.round(box * dpr);
        canvas.height = Math.round(box * dpr);
        canvas.style.cssText = `position:fixed;left:${Math.round(cx - box * 0.5)}px;top:${Math.round(cy - box * 0.5)}px;width:${box}px;height:${box}px;pointer-events:none;z-index:8;`;
        this.rootEl.appendChild(canvas);
        this._burstCanvas = canvas;

        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) {
          this._dissolveTimer = setTimeout(finish, 120);
          return;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const particles = [];
        for (let i = 0; i < MOTES; i++) {
          const angle = (i / MOTES) * Math.PI * 2 + (i % 3) * 0.18;
          const speed = 34 + (i % 4) * 14;
          particles.push({
            ang: angle,
            r0: 14 + (i % 3) * 6,
            spd: speed,
            size: 1.6 + (i % 3) * 0.9,
            col: COLORS[i % COLORS.length]
          });
        }

        const durMs = 230;
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const mid = box * 0.5;

        const step = (now) => {
          const elapsed = Math.max(0, (now || Date.now()) - t0);
          const p = Math.min(1, elapsed / durMs);
          const ease = 1 - Math.pow(1 - p, 3);
          ctx.clearRect(0, 0, box, box);

          // Soft imploding/fading halo ring
          const ringR = 26 * (1 - ease * 0.45);
          ctx.strokeStyle = `rgba(56, 189, 248, ${(0.55 * (1 - p)).toFixed(3)})`;
          ctx.lineWidth = 1.6 * (1 - p * 0.5);
          ctx.beginPath();
          ctx.arc(mid, mid, ringR, 0, Math.PI * 2);
          ctx.stroke();

          // Luminous stardust motes drifting outward with swirl & smooth alpha decay
          for (let i = 0; i < particles.length; i++) {
            const m = particles[i];
            const dist = m.r0 + m.spd * ease;
            const swirl = m.ang + ease * 0.55;
            const x = mid + Math.cos(swirl) * dist;
            const y = mid + Math.sin(swirl) * dist - ease * 8;
            const alpha = (1 - p) * 0.88;
            ctx.fillStyle = `rgba(${m.col}, ${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, m.size * (1 - p * 0.45), 0, Math.PI * 2);
            ctx.fill();
          }

          if (p < 1) {
            this._dissolveRaf = rootScope.requestAnimationFrame(step);
          } else {
            finish();
          }
        };

        this._dissolveRaf = rootScope.requestAnimationFrame(step);
        this._dissolveTimer = setTimeout(finish, durMs + 40);
      } catch (_e) {
        this._dissolveTimer = setTimeout(finish, 120);
      }
    }

    _cancelDissolve() {
      if (this._dissolveTimer) {
        clearTimeout(this._dissolveTimer);
        this._dissolveTimer = null;
      }
      if (this._dissolveRaf !== null && typeof rootScope.cancelAnimationFrame === 'function') {
        rootScope.cancelAnimationFrame(this._dissolveRaf);
        this._dissolveRaf = null;
      }
      if (this._burstCanvas) {
        try { this._burstCanvas.remove(); } catch (_e) {}
        this._burstCanvas = null;
      }
    }

    stop() {
      this._cancelDissolve();
      this.mode = 'idle';
      this.taskProcessing = false;
      this.level = 0;
    }

    destroy() {
      this.stop();
      this._cleanupOldElements();
    }
  }

  rootScope.SleepwalkerThreads = SleepwalkerThreads;
})(typeof window !== 'undefined' ? window : globalThis);
