/**
 * Sleepwalker - orb.js (Phase P1)
 * Siri-style bottom-centre translucent orb UI and global window.SW_UI contract.
 * Keeps everything in an isolated Shadow DOM container with pointer-events: none
 * everywhere except interactive controls, and stops all animations when idle.
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerOrbUI) return;

  const VALID_STATES = new Set(['idle', 'silent', 'listening', 'thinking', 'speaking', 'confirm', 'error']);
  // Symmetrical rest weights across the 7 vertical waveform bars inside the orb
  const BAR_BASE_WEIGHTS = [0.28, 0.52, 0.78, 1.0, 0.78, 0.52, 0.28];

  class SleepwalkerOrbUI {
    constructor(options = {}) {
      this.state = 'idle';
      this.level = 0;
      this.transcript = '';
      this.host = null;
      this.shadow = null;
      this.rootEl = null;
      this.orbBtn = null;
      this.bars = [];
      this.transcriptEl = null;
      this.typeBtn = null;
      this.typeForm = null;
      this.typeInput = null;
      this._hideTimer = null;
      this.currentRequestId = '';
      this.handlers = {
        onOrbClick: typeof options.onOrbClick === 'function' ? options.onOrbClick : null,
        onSubmitText: typeof options.onSubmitText === 'function' ? options.onSubmitText : null,
        onDismiss: typeof options.onDismiss === 'function' ? options.onDismiss : null,
        onCancelTask: typeof options.onCancelTask === 'function' ? options.onCancelTask : null
      };
      this._mount();
    }

    _mount() {
      const doc = rootScope.document;
      if (!doc || !doc.documentElement) return;
      const existing = doc.getElementById('sleepwalker-ui-host');
      if (existing) existing.remove();
      const legacyHost = !rootScope.SleepwalkerWidget && doc.getElementById('sleepwalker-host');
      if (legacyHost) legacyHost.remove();

      this.host = doc.createElement('div');
      this.host.id = 'sleepwalker-ui-host';
      this.host.className = 'sleepwalker-ignore sleepwalker-exclude';
      this.host.style.cssText = 'position:fixed !important;inset:0 !important;width:0 !important;height:0 !important;overflow:visible !important;pointer-events:none !important;z-index:2147483644 !important;border:0 !important;margin:0 !important;padding:0 !important;background:transparent !important;';
      this.shadow = this.host.attachShadow({ mode: 'open' });
      this.injectCssText('.sw-ui-root{position:fixed;inset:0;pointer-events:none;opacity:0;visibility:hidden;}.sw-ui-root[data-active="true"],.sw-ui-root.sw-dissolving{opacity:1;visibility:visible;}.sw-threads-canvas,.sw-ui-veil,.sw-edge-aurora{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;}.sw-card[hidden],.sw-type-form[hidden],.sw-aurora-bar[hidden],.sw-edge-aurora[hidden],.sw-scan-chip[hidden],.sw-aurora-cancel[hidden],.sw-card-menu[hidden],.sw-card-controls[hidden],.sw-card-actions[hidden]{display:none;}.sw-svg{width:20px;height:20px;min-width:20px;min-height:20px;max-width:20px;max-height:20px;display:inline-block;flex-shrink:0;overflow:hidden;}.sw-sparkle .sw-svg,.sw-sparkle svg{width:16px;height:16px;min-width:16px;min-height:16px;max-width:16px;max-height:16px;}svg{flex-shrink:0;}');
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('ui.css');
        this.shadow.appendChild(link);
      }
      const wrapper = doc.createElement('div');
      wrapper.className = 'sw-ui-root';
      wrapper.dataset.state = 'idle';
      wrapper.dataset.active = 'false';
      wrapper.innerHTML = `
        <div id="sw-ui-edge-aurora" class="sw-edge-aurora" data-task-state="idle" hidden aria-hidden="true">
          <div class="sw-edge-aurora-flow"></div>
        </div>
        <div class="sw-orb-dock">
          <div id="sw-ui-scan" class="sw-scan-chip" hidden aria-live="polite">
            <span class="sw-scan-dot" aria-hidden="true"></span>
            <span id="sw-ui-scan-label">Mapping page...</span>
          </div>
          <div id="sw-ui-aurora" class="sw-aurora-bar" data-task-state="idle" hidden aria-live="polite">
            <div class="sw-aurora-mist" aria-hidden="true"></div>
            <div class="sw-aurora-row">
              <span class="sw-aurora-dot" aria-hidden="true"></span>
              <div class="sw-aurora-text">
                <div id="sw-ui-aurora-stage" class="sw-aurora-stage"></div>
                <div id="sw-ui-aurora-task" class="sw-aurora-task"></div>
              </div>
              <button type="button" id="sw-ui-cancel-btn" class="sw-aurora-cancel" aria-label="Cancel active task" hidden>Cancel</button>
            </div>
            <div class="sw-aurora-thread-track" aria-hidden="true"><span class="sw-aurora-thread"></span></div>
          </div>
          <div id="sw-ui-transcript" class="sw-transcript-chip" aria-live="polite" data-visible="false"></div>
          <form id="sw-ui-type-form" class="sw-type-form" hidden>
            <input id="sw-ui-type-input" class="sw-type-input" type="text" placeholder="Type a command or question..." aria-label="Type command">
            <button type="submit" class="sw-type-submit">Go</button>
          </form>
          <div class="sw-orb-row">
            <div class="sw-orb-wrap">
              <div class="sw-orb-halo" aria-hidden="true"></div>
              <button type="button" id="sw-ui-orb" class="sw-orb-btn" aria-label="Sleepwalker voice assistant orb">
                <span class="sw-orb-bars" aria-hidden="true">${'<span class="sw-bar"></span>'.repeat(7)}</span>
              </button>
            </div>
            <button type="button" id="sw-ui-type-btn" class="sw-type-btn" aria-expanded="false" aria-label="Type command instead of speaking">Type</button>
          </div>
        </div>
      `;
      this.shadow.appendChild(wrapper);
      doc.documentElement.appendChild(this.host);
      this.rootEl = wrapper;
      this.dockEl = this.shadow.querySelector('.sw-orb-dock');
      this.edgeAuroraEl = this.shadow.getElementById('sw-ui-edge-aurora');
      this.scanEl = this.shadow.getElementById('sw-ui-scan');
      this.scanLabelEl = this.shadow.getElementById('sw-ui-scan-label');
      this.auroraEl = this.shadow.getElementById('sw-ui-aurora');
      this.auroraStageEl = this.shadow.getElementById('sw-ui-aurora-stage');
      this.auroraTaskEl = this.shadow.getElementById('sw-ui-aurora-task');
      this.cancelTaskBtn = this.shadow.getElementById('sw-ui-cancel-btn');
      this.orbBtn = this.shadow.getElementById('sw-ui-orb');
      this.bars = Array.from(this.shadow.querySelectorAll('.sw-bar'));
      this.transcriptEl = this.shadow.getElementById('sw-ui-transcript');
      this.typeBtn = this.shadow.getElementById('sw-ui-type-btn');
      this.typeForm = this.shadow.getElementById('sw-ui-type-form');
      this.typeInput = this.shadow.getElementById('sw-ui-type-input');
      this._bindEvents();
      this.threads = rootScope.SleepwalkerThreads ? new rootScope.SleepwalkerThreads(this.shadow, this.rootEl) : null;
      this.card = rootScope.SleepwalkerCard ? new rootScope.SleepwalkerCard(this.shadow, this.rootEl, this) : null;
      this._syncGlowPreference();
      this._observeDockLayout();
      this.syncLayout();
      this.setLevel(0);
    }

    _observeDockLayout() {
      if (this._layoutObserved) return;
      this._layoutObserved = true;
      if (typeof rootScope.addEventListener === 'function') {
        rootScope.addEventListener('resize', () => this.syncLayout(), { passive: true });
      }
      if (typeof ResizeObserver === 'function' && this.dockEl) {
        this._dockObserver = new ResizeObserver(() => this.syncLayout());
        this._dockObserver.observe(this.dockEl);
      }
    }

    syncLayout() {
      if (!this.rootEl) return;
      const vh = Number(rootScope.innerHeight) || 800;
      const typeOpen = Boolean(this.typeForm && !this.typeForm.hidden);
      const hasTranscript = Boolean(this.transcriptEl && this.transcriptEl.dataset.visible === 'true');
      let clearance = (typeOpen ? 186 : 132) + (hasTranscript ? 42 : 0);
      if (this.dockEl && typeof this.dockEl.getBoundingClientRect === 'function') {
        const rect = this.dockEl.getBoundingClientRect();
        if (rect && rect.height > 0 && rect.top > 0 && rect.top <= vh) {
          clearance = Math.max(clearance, (vh - rect.top) + 14);
        }
      }
      const maxClearance = Math.max(124, Math.floor(vh * 0.48));
      this.rootEl.style.setProperty('--sw-dock-clearance', `${Math.min(maxClearance, Math.ceil(clearance))}px`);
    }

    _syncGlowPreference() {
      if (!this.threads || typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      try {
        chrome.storage.local.get(['sleepwalker_glow_enabled'], (d) => {
          if (this.threads && d) this.threads.setEnabled(d.sleepwalker_glow_enabled !== false);
        });
        if (chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.sleepwalker_glow_enabled && this.threads) {
              this.threads.setEnabled(changes.sleepwalker_glow_enabled.newValue !== false);
            }
          });
        }
      } catch (_e) {}
    }

    _bindEvents() {
      if (this.orbBtn) {
        this.orbBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (typeof this.handlers.onOrbClick === 'function') {
            this.handlers.onOrbClick({ state: this.state });
          }
        });
      }

      if (this.cancelTaskBtn) {
        this.cancelTaskBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (typeof this.handlers.onCancelTask === 'function') {
            this.handlers.onCancelTask({ state: this.state });
          }
        });
      }

      if (this.typeBtn && this.typeForm && this.typeInput) {
        this.typeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const willShow = this.typeForm.hidden;
          this.typeForm.hidden = !willShow;
          this.typeBtn.setAttribute('aria-expanded', willShow ? 'true' : 'false');
          this.syncLayout();
          if (willShow) {
            this.typeInput.focus();
          }
        });

        this.typeForm.addEventListener('submit', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const text = String(this.typeInput.value || '').trim();
          if (!text) return;
          this.typeInput.value = '';
          this._processingTurn = true;
          const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
          this.beginRequest(reqId, text);
          // Keep the command bar accessible below cards so follow-up typed commands are never obstructed.
          this.typeForm.hidden = false;
          this.typeBtn.setAttribute('aria-expanded', 'true');
          this.syncLayout();
          if (typeof this.handlers.onSubmitText === 'function') {
            this.handlers.onSubmitText(text, reqId);
          }
        });
      }

      if (this.rootEl) {
        this.rootEl.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            if (typeof this.handlers.onDismiss === 'function') {
              this.handlers.onDismiss('escape');
            } else {
              this.hide({ dissolve: false });
            }
          }
        });
      }
    }

    setHandlers(overrides = {}) {
      if (typeof overrides.onOrbClick === 'function') this.handlers.onOrbClick = overrides.onOrbClick;
      if (typeof overrides.onSubmitText === 'function') this.handlers.onSubmitText = overrides.onSubmitText;
      if (typeof overrides.onDismiss === 'function') this.handlers.onDismiss = overrides.onDismiss;
      if (typeof overrides.onQuickControl === 'function') this.handlers.onQuickControl = overrides.onQuickControl;
      if (typeof overrides.onCancelTask === 'function') this.handlers.onCancelTask = overrides.onCancelTask;
    }

    setScanning(active = false, label = 'Mapping page...') {
      if (!this.scanEl) return;
      const on = Boolean(active);
      this.scanEl.hidden = !on;
      if (this.scanLabelEl) {
        this.scanLabelEl.textContent = on ? String(label || 'Mapping page...').slice(0, 48) : '';
      }
      if (this.rootEl) {
        this.rootEl.dataset.scanning = on ? 'true' : 'false';
      }
    }

    setTaskStatus(status = {}) {
      if (!this.auroraEl) return;
      const safe = status && typeof status === 'object' ? status : {};
      const validTaskStates = new Set(['idle', 'processing', 'waiting_for_clarification', 'completed', 'cancelled', 'error']);
      const st = validTaskStates.has(safe.state) ? safe.state : 'idle';
      this.auroraEl.dataset.taskState = st;
      const showEdgeAurora = st === 'processing' || st === 'waiting_for_clarification';
      if (this.edgeAuroraEl) {
        this.edgeAuroraEl.dataset.taskState = st;
        this.edgeAuroraEl.hidden = !showEdgeAurora;
        this.edgeAuroraEl.classList.toggle('sw-active', showEdgeAurora);
      }
      if (this.threads && typeof this.threads.setTaskProcessing === 'function') {
        this.threads.setTaskProcessing(showEdgeAurora);
      }
      if (st === 'idle') {
        this.auroraEl.hidden = true;
        if (this.auroraStageEl) this.auroraStageEl.textContent = '';
        if (this.auroraTaskEl) this.auroraTaskEl.textContent = '';
        if (this.cancelTaskBtn) this.cancelTaskBtn.hidden = true;
        this.syncLayout();
        return;
      }
      this.auroraEl.hidden = false;
      if (this.auroraStageEl) {
        this.auroraStageEl.textContent = String(safe.stage || (
          st === 'processing' ? 'Understanding request'
          : (st === 'waiting_for_clarification' ? 'Waiting for clarification'
            : (st === 'completed' ? 'Completed' : (st === 'cancelled' ? 'Cancelled' : 'Action failed')))
        )).slice(0, 64);
      }
      if (this.auroraTaskEl) {
        this.auroraTaskEl.textContent = String(safe.taskLabel || '').slice(0, 68);
      }
      if (this.cancelTaskBtn) {
        const allowCancel = safe.showCancel !== undefined
          ? Boolean(safe.showCancel)
          : (st === 'processing' || st === 'waiting_for_clarification');
        this.cancelTaskBtn.hidden = !allowCancel;
      }
      if (this.rootEl && this.rootEl.dataset.active !== 'true') {
        this.rootEl.dataset.active = 'true';
      }
      this.syncLayout();
    }

    setState(nextState = 'idle') {
      const normalized = VALID_STATES.has(nextState) ? nextState : 'silent';
      if (normalized === 'silent' && this._dissolving) {
        return this.state;
      }
      this._dissolving = false;
      if (this._hideTimer) {
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
      }

      this.state = normalized;
      const isActive = normalized !== 'idle';
      if (this.rootEl) {
        this.rootEl.classList.remove('sw-dissolving');
        this.rootEl.dataset.state = normalized;
        this.rootEl.dataset.active = isActive ? 'true' : 'false';
      }

      if (normalized === 'idle') {
        if (this.card) this.card.hide({ restoreFocus: true });
        this.setTaskStatus({ state: 'idle' });
        this.setLevel(0);
        this.setTranscript('');
        if (this.typeForm) this.typeForm.hidden = true;
        if (this.typeBtn) this.typeBtn.setAttribute('aria-expanded', 'false');
      } else if (normalized === 'silent') {
        this.setLevel(0.12);
      } else if (normalized === 'listening' && this.level < 0.2) {
        this.setLevel(0.28);
      } else if (normalized === 'thinking' || normalized === 'confirm') {
        this.setLevel(0.36);
      }
      if (this.threads) this.threads.setMode(normalized);
      this.syncLayout();
      return normalized;
    }

    setLevel(rawLevel = 0) {
      const clamped = Math.max(0, Math.min(1, Number(rawLevel) || 0));
      this.level = clamped;
      for (let i = 0; i < this.bars.length; i++) {
        const w = BAR_BASE_WEIGHTS[i] || 0.5;
        const scale = Math.min(1, 0.16 + clamped * w * 0.88);
        this.bars[i].style.setProperty('--bar-scale', scale.toFixed(3));
      }
      if (this.threads) this.threads.setLevel(clamped);
    }

    setTranscript(text = '') {
      const clean = String(text || '').trim();
      this.transcript = clean;
      if (!this.transcriptEl) return;
      this.transcriptEl.textContent = clean;
      this.transcriptEl.dataset.visible = (clean && this.state !== 'idle') ? 'true' : 'false';
      this.syncLayout();
    }

    beginRequest(reqId, text = '') {
      const id = reqId || (`req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      this.currentRequestId = id;
      if (this.card && typeof this.card.reset === 'function') {
        this.card.reset();
      }
      this.setState('thinking');
      if (text) {
        this.setTranscript(text);
      }
      return id;
    }

    showCard(spec = {}) {
      if (spec && spec.reqId && this.currentRequestId && spec.reqId !== this.currentRequestId) {
        return;
      }
      if (this.card) { this.card.show(spec); return; }
      if (spec && typeof spec === 'object') {
        if (this.state === 'idle') this.setState('speaking');
        const label = spec.title ? `${spec.title}: ${spec.text || ''}` : (spec.text || '');
        if (label) this.setTranscript(label.slice(0, 140));
      }
    }
    updateCard(spec = {}) {
      if (spec && spec.reqId && this.currentRequestId && spec.reqId !== this.currentRequestId) {
        return;
      }
      if (this.card && typeof this.card.updateStreaming === 'function') {
        this.card.updateStreaming(spec);
        return;
      }
      this.showCard(spec);
    }
    highlightTopic(index) { if (this.card) this.card.highlightTopic(index); }
    highlightSentence(index) { if (this.card) this.card.highlightSentence(index); }
    notifySpeechEnd() { if (this.card) this.card.setSpeechFinished(); }
    hideCard() { if (this.card) this.card.hide({ restoreFocus: true }); }
    positionForTarget(t) { if (this.card) this.card.positionForTarget(t); }

    hide({ dissolve = true } = {}) {
      if (this.state === 'idle') return;
      if (!dissolve) {
        this._dissolving = false;
        if (this.threads) this.threads.stop();
        this.setState('idle');
        return;
      }
      this._dissolving = true;
      if (this.rootEl) {
        this.rootEl.classList.add('sw-dissolving');
        this.rootEl.dataset.active = 'false';
      }
      const finish = () => {
        this._dissolving = false;
        if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
        this.setState('idle');
      };
      if (this.threads && this.orbBtn) {
        const rect = this.orbBtn.getBoundingClientRect();
        this.threads.triggerDissolve(rect, finish);
      }
      this._hideTimer = setTimeout(finish, 540);
    }

    injectCssText(cssText) {
      if (!this.shadow || !rootScope.document) return;
      let styleEl = this.shadow.getElementById('sw-ui-inline-css');
      if (!styleEl) {
        styleEl = rootScope.document.createElement('style');
        styleEl.id = 'sw-ui-inline-css';
        this.shadow.prepend(styleEl);
      }
      styleEl.textContent = String(cssText || '');
    }
  }

  function createOrGetInterface() {
    if (rootScope.SW_UI && rootScope.__SW_ORB_INSTANCE__) return rootScope.SW_UI;
    const orb = new SleepwalkerOrbUI();
    rootScope.__SW_ORB_INSTANCE__ = orb;
    const api = {
      beginRequest: (reqId, text) => orb.beginRequest(reqId, text),
      getCurrentRequestId: () => orb.currentRequestId,
      setState: (s) => orb.setState(s), setLevel: (l) => orb.setLevel(l), setTranscript: (t) => orb.setTranscript(t),
      setTaskStatus: (st) => orb.setTaskStatus(st), setScanning: (on, lbl) => orb.setScanning(on, lbl),
      showCard: (c) => orb.showCard(c), updateCard: (c) => orb.updateCard(c), highlightTopic: (i) => orb.highlightTopic(i), highlightSentence: (i) => orb.highlightSentence(i),
      notifySpeechEnd: () => orb.notifySpeechEnd(), hideCard: () => orb.hideCard(), positionForTarget: (t) => orb.positionForTarget(t),
      getCardType: () => (orb.card && orb.card.visible && orb.card.spec ? orb.card.spec.type : null),
      hide: (o) => orb.hide(o), getState: () => orb.state, setHandlers: (h) => orb.setHandlers(h), _orb: orb
    };
    rootScope.SW_UI = api;
    rootScope.__SW_UI_DEMO__ = (arg) => {
      if (!arg || arg === 'dismiss' || arg === 'idle') { api.hide({ dissolve: false }); return 'idle'; }
      if (typeof arg === 'string') {
        const cardDemos = {
          summary: { type: 'summary', title: 'Page Summary', text: 'This is the National Scholarship Portal. Check eligibility, required documents, application fees, and apply online.' },
          topics: { type: 'summary', title: 'Scholarship Guide', reading: true, topics: [{ title: '1. Purpose', text: 'Post-matric financial assistance.' }, { title: '2. Deadline', text: 'Apply before 30 November.' }] },
          choices: { type: 'choices', title: 'Choose a Link', text: 'Pick one matching option:', choices: ['Eligibility Criteria', 'Required Documents', 'Application Fees'] },
          confirm: { type: 'confirm', title: 'Confirm Action', text: 'Proceed with uploading photo.jpg?' },
          critical: { type: 'confirm', title: 'Submit Application?', stepLabel: 'Step 2 of 2', text: 'Review summary and confirm final submission.', summaryLines: ['Name: Aasha Rao', 'State: Karnataka'] },
          file: { type: 'file', title: 'Upload Document', fieldLabel: 'Applicant Photo (max 2 MB)', fileInfo: 'No file chosen yet. Tap Choose File.' },
          form: { type: 'form', title: 'Guided Form', progress: '5 of 12 done', fieldLabel: 'State *', valueReadback: 'Karnataka' },
          plan: { type: 'plan', title: 'Apply Plan', steps: [{ label: 'Fill details', status: 'done' }, { label: 'Upload certificate', status: 'active' }, { label: 'Submit', status: 'pending' }] }
        };
        if (cardDemos[arg]) { api.setState(arg === 'confirm' || arg === 'critical' ? 'confirm' : 'speaking'); api.showCard(cardDemos[arg]); return arg; }
        api.setState(arg);
        const p = { silent: [0.1, ''], listening: [0.62, 'Listening...'], thinking: [0.35, 'Thinking...'], speaking: [0.78, 'Speaking...'], confirm: [0.4, 'Say Yes or No'], error: [0.25, 'Action failed'] }[arg] || [0.3, ''];
        api.setLevel(p[0]); if (p[1]) api.setTranscript(p[1]); return api.getState();
      }
      if (typeof arg === 'object') {
        if (arg.state) api.setState(arg.state);
        if (typeof arg.level === 'number') api.setLevel(arg.level);
        if (arg.transcript !== undefined) api.setTranscript(arg.transcript);
        if (arg.title || arg.text || arg.topics || arg.choices) api.showCard(arg);
      }
      return api.getState();
    };
    return api;
  }

  rootScope.SleepwalkerOrbUI = SleepwalkerOrbUI;
  createOrGetInterface();
})(typeof window !== 'undefined' ? window : globalThis);
