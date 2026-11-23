/**
 * Sleepwalker - threads.js
 * Modernized: Completely removes golden thread animations, golden petals,
 * particle effects, and continuous canvas rendering loops.
 * Provides clean lifecycle methods and zero background resource consumption.
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerThreads) return;

  class SleepwalkerThreads {
    constructor(shadowRoot, rootEl) {
      this.shadow = shadowRoot;
      this.rootEl = rootEl;
      this.mode = 'idle';
      this.taskProcessing = false;
      this.level = 0;
      this.enabled = false;
      this.reducedMotion = false;
      this._dissolveTimer = null;

      this._cleanupOldElements();
    }

    _cleanupOldElements() {
      // Remove any legacy canvas or decorative veils if present in DOM
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
      // Clean dissolve without particle bursts or golden ribbons
      if (this._dissolveTimer) {
        clearTimeout(this._dissolveTimer);
        this._dissolveTimer = null;
      }
      if (typeof onDone === 'function') {
        this._dissolveTimer = setTimeout(() => {
          this._dissolveTimer = null;
          onDone();
        }, 120);
      }
    }

    stop() {
      if (this._dissolveTimer) {
        clearTimeout(this._dissolveTimer);
        this._dissolveTimer = null;
      }
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
