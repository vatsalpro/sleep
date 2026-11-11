/**
 * Sleepwalker - glow.js
 * CodeQuest National Tech Hackathon 2026
 *
 * Feature C: Full-Screen Translucent Prism Glow Animation
 *
 * Responsibilities:
 * 1. Inject a full-viewport, pointer-events: none overlay inside the Shadow DOM.
 * 2. Never block clicks, scrolling, or selection on the underlying page.
 * 3. 6 Accessible visual states:
 *    - 'listening': Faint subtle edge glow.
 *    - 'preparing': 4 soft blurred color blobs (cyan, violet, pink, amber) drifting
 *                   along the perimeter with GPU-accelerated transforms.
 *    - 'ready': Short ~600ms bright bloom sweep around edges.
 *    - 'speaking': Calm, low-intensity breathing glow while text is read.
 *    - 'error': Soft red edge pulse before fading out.
 *    - 'off': 500ms smooth fade out, animations paused to save GPU/CPU cycles.
 * 4. Center cutout mask so the middle of the webpage is NEVER tinted.
 * 5. Respects prefers-reduced-motion and user preference setting (sleepwalker_glow_enabled).
 * 6. Global debug hook: window.__SLEEPWALKER_GLOW__(stateName).
 */

(function () {
  'use strict';

  if (window.SleepwalkerGlow) return;

  class SleepwalkerGlow {
    /**
     * @param {Object} options
     * @param {ShadowRoot} options.shadowRoot - Shared Shadow Root.
     * @param {SleepwalkerWidget} options.widget - Main widget controller.
     */
    constructor(options = {}) {
      this.shadowRoot = options.shadowRoot;
      this.widget = options.widget;

      this.container = null;
      this.ring = null;
      this.state = 'off'; // 'off' | 'listening' | 'preparing' | 'ready' | 'speaking' | 'error'
      this.isEnabled = true;
      this._readyTimer = null;
      this._errorTimer = null;

      this.init();
    }

    /**
     * Initialize DOM, load preferences, and register debug console helper.
     */
    async init() {
      await this.loadPreferences();
      this.render();
      this.registerDebugHelper();
    }

    /**
     * Load user setting for glow enabled/disabled.
     */
    async loadPreferences() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
          chrome.storage.local.get(['sleepwalker_glow_enabled'], (data) => {
            if (typeof data.sleepwalker_glow_enabled === 'boolean') {
              this.isEnabled = data.sleepwalker_glow_enabled;
            }
            resolve();
          });
        });
      }
    }

    /**
     * Enable or disable glow via settings.
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
      this.isEnabled = Boolean(enabled);
      if (!this.isEnabled) {
        this.setOff();
      }
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ sleepwalker_glow_enabled: this.isEnabled });
      }
    }

    /**
     * Render the glow container, edge mask ring, and radial color blobs.
     */
    render() {
      if (!this.shadowRoot) return;

      const container = document.createElement('div');
      container.id = 'sw-glow-container';
      container.className = 'sw-glow-container sw-glow-off';
      container.setAttribute('aria-hidden', 'true');
      container.style.pointerEvents = 'none';

      container.innerHTML = `
        <!-- Edge Ring with Center Cutout Mask (Center stays 100% transparent) -->
        <div class="sw-glow-ring" id="sw-glow-ring">
          <!-- 4 Blurred Prism Color Blobs -->
          <div class="sw-glow-blob sw-blob-cyan" aria-hidden="true"></div>
          <div class="sw-glow-blob sw-blob-violet" aria-hidden="true"></div>
          <div class="sw-glow-blob sw-blob-pink" aria-hidden="true"></div>
          <div class="sw-glow-blob sw-blob-amber" aria-hidden="true"></div>
          <!-- Single Red Pulse Overlay for Error State -->
          <div class="sw-glow-error-layer" aria-hidden="true"></div>
        </div>
      `;

      // Insert at the beginning of shadowRoot so it stays behind panels and bubbles
      this.shadowRoot.insertBefore(container, this.shadowRoot.firstChild);

      this.container = container;
      this.ring = container.querySelector('#sw-glow-ring');
    }

    /**
     * Transition the prism glow into a specified state.
     * @param {'listening'|'preparing'|'ready'|'speaking'|'error'|'off'} stateName
     */
    setState(stateName) {
      if (!this.container || !this.isEnabled) return;

      // Clear pending state timers
      if (this._readyTimer) {
        clearTimeout(this._readyTimer);
        this._readyTimer = null;
      }
      if (this._errorTimer) {
        clearTimeout(this._errorTimer);
        this._errorTimer = null;
      }

      this.state = stateName;
      this.container.className = `sw-glow-container sw-glow-${stateName}`;

      console.log(`[Sleepwalker Glow] State changed to: "${stateName}"`);

      // Special transitions:
      if (stateName === 'ready') {
        // Ready blooms for ~600ms, then transitions smoothly into speaking
        this._readyTimer = setTimeout(() => {
          if (this.state === 'ready') {
            this.setState('speaking');
          }
        }, 600);
      } else if (stateName === 'error') {
        // Error pulses red, then automatically fades out after 1.8s
        this._errorTimer = setTimeout(() => {
          if (this.state === 'error') {
            this.setState('off');
          }
        }, 1800);
      }
    }

    setListening() {
      this.setState('listening');
    }

    setPreparing() {
      this.setState('preparing');
    }

    setReady() {
      this.setState('ready');
    }

    setSpeaking() {
      this.setState('speaking');
    }

    setError() {
      this.setState('error');
    }

    setOff() {
      this.setState('off');
    }

    /**
     * Register global console debug helper window.__SLEEPWALKER_GLOW__(state)
     */
    registerDebugHelper() {
      window.__SLEEPWALKER_GLOW__ = (state) => {
        const validStates = ['listening', 'preparing', 'ready', 'speaking', 'error', 'off'];
        const targetState = (state || '').toLowerCase().trim();

        if (!validStates.includes(targetState)) {
          console.warn(`[Sleepwalker Glow] Unknown state "${state}". Valid options:`, validStates);
          return `Invalid state. Options: ${validStates.join(', ')}`;
        }

        this.setState(targetState);
        return `Sleepwalker Glow set to: "${targetState}"`;
      };
    }
  }

  window.SleepwalkerGlow = SleepwalkerGlow;
})();
