/**
 * Sleepwalker - card.js (Phase P3)
 * Frosted warm-white glass floating response card above the orb.
 * Supports progressive topic/sentence reveal, choices, confirm dialog, file picker,
 * form progress, plan stepper, error cards, overflow quick controls, pin & 6s auto-dismiss.
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerCard) return;

  const STICKY_TYPES = new Set(['confirm', 'file', 'form', 'plan']);
  const DIALOG_TYPES = new Set(['confirm', 'file']);
  const DEFAULT_AUTO_DISMISS_MS = 6000;

  const mk = (tag, cls, text) => {
    const n = rootScope.document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  class SleepwalkerCard {
    constructor(shadowRoot, rootEl, orbUi) {
      this.shadow = shadowRoot; this.rootEl = rootEl; this.orbUi = orbUi;
      this.spec = null; this.visible = false; this.pinned = false; this.expanded = false;
      this.hovered = false; this.focusedWithin = false; this.readingPaused = false;
      this.speechDone = true; this.autoDismissMs = DEFAULT_AUTO_DISMISS_MS;
      this._dismissTimer = null; this._prevFocusEl = null;
      this._prefs = { lang: 'auto', rate: 1.0, fontSize: 18 };
      this._mount();
    }

    _mount() {
      const doc = rootScope.document;
      if (!doc || !this.rootEl) return;
      const sec = doc.createElement('section');
      sec.id = 'sw-ui-card';
      sec.className = 'sw-card';
      sec.hidden = true;
      sec.setAttribute('aria-live', 'polite');
      sec.innerHTML = `
        <header class="sw-card-head">
          <div class="sw-card-title-row">
            <span class="sw-sparkle" aria-hidden="true">
              <svg class="sw-svg" width="16" height="16" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="currentColor" focusable="false" aria-hidden="true"><path d="M12 2L14.6 9.4L22 12L14.6 14.6L12 22L9.4 14.6L2 12L9.4 9.4L12 2Z"/></svg>
            </span>
            <h2 id="sw-card-title" class="sw-card-title"></h2>
            <span id="sw-card-badge" class="sw-card-badge" hidden></span>
          </div>
          <div class="sw-card-tools">
            <button type="button" id="sw-card-pin" class="sw-tool-btn" aria-pressed="false" title="Pin card" aria-label="Pin card">Pin</button>
            <button type="button" id="sw-card-more" class="sw-tool-btn" aria-expanded="false" title="Quick settings" aria-label="Quick settings">⋯</button>
            <button type="button" id="sw-card-close" class="sw-tool-btn" title="Close" aria-label="Close card">✕</button>
          </div>
        </header>
        <div id="sw-card-menu" class="sw-card-menu" hidden></div>
        <div id="sw-card-body" class="sw-card-body"></div>
        <div id="sw-card-read-bar" class="sw-card-controls" hidden></div>
        <div id="sw-card-actions" class="sw-card-actions" hidden></div>
        <input type="file" id="sw-card-file-input" hidden>
        <div id="sw-card-tail" class="sw-card-tail" aria-hidden="true"></div>
      `;
      this.rootEl.appendChild(sec);
      this.el = sec;
      this.titleEl = this.shadow.getElementById('sw-card-title');
      this.badgeEl = this.shadow.getElementById('sw-card-badge');
      this.pinBtn = this.shadow.getElementById('sw-card-pin');
      this.moreBtn = this.shadow.getElementById('sw-card-more');
      this.closeBtn = this.shadow.getElementById('sw-card-close');
      this.menuEl = this.shadow.getElementById('sw-card-menu');
      this.bodyEl = this.shadow.getElementById('sw-card-body');
      this.readBarEl = this.shadow.getElementById('sw-card-read-bar');
      this.actionsEl = this.shadow.getElementById('sw-card-actions');
      this.fileInput = this.shadow.getElementById('sw-card-file-input');
      this.tailEl = this.shadow.getElementById('sw-card-tail');
      this._bindEvents();
      this._renderMenu();
    }

    _bindEvents() {
      for (const evtName of ['pointerdown', 'mousedown']) {
        this.el.addEventListener(evtName, (e) => {
          e.stopPropagation();
        });
      }
      this.pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pinned = !this.pinned;
        this.pinBtn.setAttribute('aria-pressed', this.pinned ? 'true' : 'false');
        this.pinBtn.classList.toggle('sw-tool-active', this.pinned);
        this._syncAutoDismiss();
      });
      this.moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = this.menuEl.hidden;
        this.menuEl.hidden = !open;
        this.moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      this.closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hide({ restoreFocus: false });
      });
      this.el.addEventListener('mouseenter', () => { this.hovered = true; this._clearDismissTimer(); });
      this.el.addEventListener('mouseleave', () => { this.hovered = false; this._syncAutoDismiss(); });
      this.el.addEventListener('focusin', () => { this.focusedWithin = true; this._clearDismissTimer(); });
      this.el.addEventListener('focusout', (e) => {
        if (!this.el.contains(e.relatedTarget)) { this.focusedWithin = false; this._syncAutoDismiss(); }
      });
      this.fileInput.addEventListener('change', () => {
        const f = this.fileInput.files && this.fileInput.files[0];
        if (f && this.spec && typeof this.spec.onFilePick === 'function') this.spec.onFilePick(f);
        this.fileInput.value = '';
      });
    }

    _renderMenu() {
      const m = this.menuEl;
      if (!m) return;
      m.innerHTML = `
        <div class="sw-menu-row"><span>Lang</span>
          <button type="button" data-pref="lang" data-val="auto">Auto</button>
          <button type="button" data-pref="lang" data-val="en-IN">EN</button>
          <button type="button" data-pref="lang" data-val="hi-IN">HI</button>
        </div>
        <div class="sw-menu-row"><span>Speed</span>
          <button type="button" data-pref="rate" data-val="0.8">0.8x</button>
          <button type="button" data-pref="rate" data-val="1">1.0x</button>
          <button type="button" data-pref="rate" data-val="1.2">1.2x</button>
        </div>
        <div class="sw-menu-row"><span>Size</span>
          <button type="button" data-pref="fontSize" data-val="18">18px</button>
          <button type="button" data-pref="fontSize" data-val="20">20px</button>
          <button type="button" data-pref="fontSize" data-val="22">22px</button>
          <button type="button" data-pref="options" data-val="open">Options</button>
        </div>`;
      m.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const pref = btn.dataset.pref;
          const val = btn.dataset.val;
          if (pref === 'fontSize') this.el.style.setProperty('--sw-card-font', `${val}px`);
          if (pref !== 'options') this._prefs[pref] = pref === 'lang' ? val : Number(val);
          this._syncMenuActive();
          if (this.spec && typeof this.spec.onQuickControl === 'function') this.spec.onQuickControl(pref, val);
          else if (this.orbUi.handlers.onQuickControl) this.orbUi.handlers.onQuickControl(pref, val);
        });
      });
      this._syncMenuActive();
    }

    _syncMenuActive() {
      if (!this.menuEl) return;
      this.menuEl.querySelectorAll('button[data-pref]').forEach((b) => {
        const k = b.dataset.pref;
        b.classList.toggle('sw-tool-active', k !== 'options' && String(this._prefs[k]) === String(b.dataset.val));
      });
    }

    show(spec = {}) {
      if (!this.el || !spec || typeof spec !== 'object') return;
      const doc = rootScope.document;
      const hostEl = this.shadow && this.shadow.host;
      if (doc && doc.activeElement && doc.activeElement !== hostEl && !this.rootEl.contains(doc.activeElement)) {
        this._prevFocusEl = doc.activeElement;
      }
      this._clearDismissTimer();
      this.spec = spec; this.visible = true; this.expanded = false; this.readingPaused = false;
      this.speechDone = spec.reading === true ? false : true;
      this.autoDismissMs = typeof spec.autoDismissMs === 'number' ? spec.autoDismissMs : DEFAULT_AUTO_DISMISS_MS;
      const type = spec.type || 'summary';
      this.el.dataset.cardType = type;
      const badgeLabel = spec.progress || spec.stepLabel || '';
      const computedStreamStatus = spec.streamStatus || (badgeLabel === 'Thinking...' ? 'thinking' : (/^(?:Streaming|Live(?:\s|·|$))/i.test(badgeLabel) ? 'streaming' : 'complete'));
      this.el.dataset.streamStatus = computedStreamStatus;
      this.el.classList.remove('sw-expanded');
      this.menuEl.hidden = true;
      this.moreBtn.setAttribute('aria-expanded', 'false');
      if (DIALOG_TYPES.has(type)) {
        this.el.setAttribute('role', 'dialog');
        this.el.setAttribute('aria-labelledby', 'sw-card-title');
      } else {
        this.el.removeAttribute('role');
        this.el.removeAttribute('aria-labelledby');
      }
      if (this.orbUi.state === 'idle') this.orbUi.setState(type === 'confirm' ? 'confirm' : (type === 'error' ? 'error' : 'speaking'));
      this.titleEl.textContent = spec.title || 'Sleepwalker';
      this.badgeEl.hidden = !(spec.progress || spec.stepLabel);
      this.badgeEl.textContent = spec.progress || spec.stepLabel || '';

      this._renderBody(spec, type);
      this._renderReadControls(spec);
      this._renderActions(spec, type);
      this.el.hidden = false;
      this.el.classList.add('sw-card-open');
      if (this.orbUi && typeof this.orbUi.syncLayout === 'function') this.orbUi.syncLayout();
      this._syncExpandVisibility();
      this.positionForTarget(spec.targetRect || spec.targetEl || null);
      if (DIALOG_TYPES.has(type)) {
        const firstBtn = this.actionsEl.querySelector('button') || this.closeBtn;
        if (firstBtn && typeof firstBtn.focus === 'function') firstBtn.focus();
      }
      this._syncAutoDismiss();
    }

    /**
     * Progressively update the card title, badge, and text/topics in place during streaming
     * without tearing down card state, stealing focus, or prematurely arming auto-dismiss.
     */
    updateStreaming(spec = {}) {
      if (!this.el || !spec || typeof spec !== 'object') return;
      const curType = this.el.dataset.cardType || '';
      const targetType = spec.type || curType || 'answer';
      if (!this.visible || (curType !== 'answer' && curType !== 'summary') || targetType !== curType) {
        this.show({ type: targetType, reading: true, ...spec });
        return;
      }
      this._clearDismissTimer();
      this.spec = { ...(this.spec || {}), ...spec };
      this.speechDone = spec.reading === false ? true : false;
      if (spec.title !== undefined) this.titleEl.textContent = spec.title || 'Sleepwalker';
      const badgeText = spec.progress || spec.stepLabel || '';
      this.el.dataset.streamStatus = spec.streamStatus || (badgeText === 'Thinking...' ? 'thinking' : (/^(?:Streaming|Live(?:\s|·|$))/i.test(badgeText) ? 'streaming' : 'complete'));
      this.badgeEl.hidden = !badgeText;
      this.badgeEl.textContent = badgeText;
      this._renderBody(this.spec, targetType);
      this._syncExpandVisibility();
    }

    _renderBody(spec, type) {
      const b = this.bodyEl;
      b.textContent = '';
      if (spec.fieldLabel) b.appendChild(mk('div', 'sw-card-meta', spec.fieldLabel));
      if (spec.valueReadback) b.appendChild(mk('div', 'sw-card-readback', `Value: "${spec.valueReadback}"`));
      if (spec.fileInfo) b.appendChild(mk('div', 'sw-card-file-info', spec.fileInfo));
      if (spec.mediaStream) {
        const v = mk('video', 'sw-card-media');
        v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = spec.mediaStream;
        b.appendChild(v);
      } else if (spec.previewUrl) {
        const img = mk('img', 'sw-card-media');
        img.src = spec.previewUrl; img.alt = spec.title || 'Captured preview';
        b.appendChild(img);
      }
      if (Array.isArray(spec.summaryLines) && spec.summaryLines.length > 0) {
        const ul = mk('ul', 'sw-confirm-summary');
        spec.summaryLines.forEach((line) => ul.appendChild(mk('li', '', line)));
        b.appendChild(ul);
      }
      if (spec.warning) {
        b.appendChild(mk('div', 'sw-card-warning', spec.warning));
      }
      if (Array.isArray(spec.topics) && spec.topics.length > 0) {
        const progressive = spec.reading !== false && spec.progressiveTopics !== false;
        spec.topics.forEach((t, idx) => {
          const sec = mk('div', 'sw-topic');
          sec.dataset.tIdx = String(idx);
          if (progressive && idx > 0) sec.hidden = true;
          else if (idx === 0) sec.classList.add('sw-topic-active');
          if (t.title) sec.appendChild(mk('div', 'sw-topic-title', t.title));
          const p = mk('p', 'sw-topic-text');
          this._appendSentenceSpans(p, t.text || '');
          sec.appendChild(p);
          b.appendChild(sec);
        });
      } else if (spec.text) {
        const p = mk('p', 'sw-card-p');
        this._appendSentenceSpans(p, spec.text);
        b.appendChild(p);
      }
      if (spec.table && Array.isArray(spec.table.headers) && Array.isArray(spec.table.rows)) {
        const wrap = mk('div', 'sw-table-wrap');
        const tbl = mk('table', 'sw-table');
        const thead = mk('thead');
        const htr = mk('tr');
        spec.table.headers.forEach((h) => htr.appendChild(mk('th', '', String(h || ''))));
        thead.appendChild(htr);
        tbl.appendChild(thead);
        const tbody = mk('tbody');
        spec.table.rows.forEach((row) => {
          const tr = mk('tr');
          (Array.isArray(row) ? row : [row]).forEach((cell) => tr.appendChild(mk('td', '', String(cell ?? '—'))));
          tbody.appendChild(tr);
        });
        tbl.appendChild(tbody);
        wrap.appendChild(tbl);
        b.appendChild(wrap);
      }
      if (Array.isArray(spec.numberedItems) && spec.numberedItems.length > 0) {
        const ol = mk('ol', 'sw-numbered-list');
        spec.numberedItems.slice(0, 8).forEach((item) => ol.appendChild(mk('li', '', String(item || ''))));
        b.appendChild(ol);
      }
      if (type === 'choices' && Array.isArray(spec.choices)) {
        const list = mk('div', 'sw-choice-list');
        spec.choices.slice(0, 5).forEach((ch, idx) => {
          const label = typeof ch === 'string' ? ch : (ch.label || ch.title || `Option ${idx + 1}`);
          const btn = mk('button', 'sw-choice-btn', `${idx + 1}. ${label}`);
          btn.type = 'button';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof spec.onAction === 'function') spec.onAction('choose', { index: idx, choice: ch });
          });
          list.appendChild(btn);
        });
        b.appendChild(list);
      }
      if ((type === 'plan' || type === 'answer') && Array.isArray(spec.steps) && spec.steps.length > 0) {
        const ol = mk('ol', type === 'plan' ? 'sw-plan-list' : 'sw-plan-list sw-plan-compact');
        spec.steps.slice(0, 7).forEach((st) => {
          const sStatus = typeof st === 'object' ? st.status : '';
          const mark = sStatus === 'done'
            ? '✓'
            : (sStatus === 'active'
              ? '●'
              : (sStatus === 'failed'
                ? '✗'
                : (sStatus === 'skipped' ? '–' : '○')));
          const li = mk('li', sStatus ? `sw-plan-step-${sStatus}` : '', `${mark} ${st.label || st}`);
          ol.appendChild(li);
        });
        b.appendChild(ol);
      }
      if (Array.isArray(spec.sources) && spec.sources.length > 0) {
        const sDiv = mk('div', 'sw-card-sources');
        sDiv.appendChild(mk('span', '', 'Sources:'));
        spec.sources.slice(0, 4).forEach((src) => {
          const lbl = `${src.title || src.url}${src.official ? ' [Official]' : ''}`;
          if (src.url && /^https?:/i.test(src.url) && typeof spec.onSourceClick === 'function') {
            const btn = mk('button', 'sw-source-link', lbl);
            btn.type = 'button';
            btn.addEventListener('click', (e) => { e.stopPropagation(); spec.onSourceClick(src); });
            sDiv.appendChild(btn);
          } else {
            sDiv.appendChild(mk('span', '', lbl));
          }
        });
        b.appendChild(sDiv);
      }
      if (spec.proactiveSuggestion && spec.proactiveSuggestion.text) {
        const sug = spec.proactiveSuggestion;
        const bar = mk('div', 'sw-proactive-bar');
        bar.setAttribute('data-proactive-id', sug.id || '');
        bar.appendChild(mk('div', 'sw-proactive-text', sug.text));
        const btns = mk('div', 'sw-proactive-btns');
        const goBtn = mk('button', 'sw-proactive-btn sw-proactive-go', sug.acceptLabel || 'Yes');
        goBtn.type = 'button';
        goBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          bar.remove();
          if (typeof spec.onProactiveAccept === 'function') spec.onProactiveAccept(sug);
        });
        const disBtn = mk('button', 'sw-proactive-btn', sug.dismissLabel || 'Dismiss');
        disBtn.type = 'button';
        disBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          bar.remove();
          if (typeof spec.onProactiveDismiss === 'function') spec.onProactiveDismiss(sug);
        });
        btns.appendChild(goBtn);
        btns.appendChild(disBtn);
        bar.appendChild(btns);
        b.appendChild(bar);
      }
    }

    _appendSentenceSpans(parent, text) {
      const parts = String(text || '').match(/[^.!?।]+[.!?।]*/g) || [String(text || '')];
      parts.forEach((part, idx) => {
        const sp = mk('span', 'sw-sentence', (idx > 0 ? ' ' : '') + part.trim());
        sp.dataset.sIdx = String(idx);
        parent.appendChild(sp);
      });
    }

    _renderReadControls(spec) {
      const r = this.readBarEl; r.textContent = '';
      const showReadBtns = Boolean(spec.reading) || (Array.isArray(spec.topics) && spec.topics.length > 1 && spec.progressiveTopics !== false);
      if (showReadBtns) {
        const pr = mk('button', 'sw-ctrl-btn', this.readingPaused ? 'Resume' : 'Pause');
        pr.type = 'button'; pr.id = 'sw-card-pause-btn';
        pr.addEventListener('click', (e) => {
          e.stopPropagation();
          this.readingPaused = !this.readingPaused;
          pr.textContent = this.readingPaused ? 'Resume' : 'Pause';
          if (typeof spec.onAction === 'function') spec.onAction(this.readingPaused ? 'pause' : 'resume');
        });
        r.appendChild(pr);
        if (Array.isArray(spec.topics) && spec.topics.length > 1) {
          const nt = mk('button', 'sw-ctrl-btn', 'Next topic');
          nt.type = 'button'; nt.id = 'sw-card-next-topic';
          nt.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof spec.onAction === 'function') spec.onAction('next_topic');
            else {
              const cur = this.bodyEl.querySelectorAll('.sw-topic:not([hidden])').length;
              if (cur < spec.topics.length) this.highlightTopic(cur);
            }
          });
          r.appendChild(nt);
        }
      }
      r.hidden = r.children.length === 0;
    }

    _syncExpandVisibility() {
      const oldExp = this.shadow.getElementById('sw-card-expand');
      if (oldExp) oldExp.remove();
      if (!(this.bodyEl.scrollHeight > this.bodyEl.clientHeight + 2) && !this.expanded) return;
      const btn = mk('button', 'sw-ctrl-btn', this.expanded ? 'Compact' : 'Expand');
      btn.type = 'button'; btn.id = 'sw-card-expand';
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); this.expanded = !this.expanded;
        this.el.classList.toggle('sw-expanded', this.expanded);
        btn.textContent = this.expanded ? 'Compact' : 'Expand';
        if (this.orbUi && typeof this.orbUi.syncLayout === 'function') this.orbUi.syncLayout();
        this._syncAutoDismiss();
      });
      this.readBarEl.appendChild(btn); this.readBarEl.hidden = false;
    }

    _renderActions(spec, type) {
      const a = this.actionsEl; a.textContent = '';
      let actions = Array.isArray(spec.actions) ? spec.actions : [];
      if (actions.length === 0 && type === 'confirm') actions = [{ id: 'yes', label: 'Yes', primary: true }, { id: 'no', label: 'No' }];
      if (actions.length === 0 && type === 'file') actions = [{ id: 'choose_file', label: 'Choose File', primary: true }, { id: 'cancel', label: 'Cancel' }];
      if (actions.length === 0 && type === 'form') actions = [{ id: 'yes', label: 'Yes', primary: true }, { id: 'change', label: 'Change' }, { id: 'skip', label: 'Skip' }];
      actions.forEach((act) => {
        const b = mk('button', act.primary ? 'sw-act-btn sw-act-primary' : 'sw-act-btn', act.label);
        b.type = 'button'; b.dataset.actionId = act.id;
        b.addEventListener('click', (e) => {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && e && e.isTrusted === false) return;
          e.stopPropagation();
          if (act.id === 'choose_file' && spec.useCardPicker && this.fileInput) { this.fileInput.click(); return; }
          if (typeof spec.onAction === 'function') spec.onAction(act.id, act);
        });
        a.appendChild(b);
      });
      a.hidden = actions.length === 0;
    }

    highlightTopic(index = 0) {
      if (!this.visible) return;
      const topics = Array.from(this.bodyEl.querySelectorAll('.sw-topic'));
      topics.forEach((el, idx) => {
        if (idx <= index) el.hidden = false;
        el.classList.toggle('sw-topic-active', idx === index);
        el.classList.toggle('sw-topic-past', idx < index);
      });
      const active = topics[index];
      if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      this._syncExpandVisibility();
    }

    highlightSentence(index = 0) {
      if (!this.visible) return;
      const spans = Array.from(this.bodyEl.querySelectorAll('.sw-sentence'));
      spans.forEach((sp, idx) => sp.classList.toggle('sw-sentence-active', idx === index));
    }

    positionForTarget(targetOrRect) {
      if (!this.el) return;
      this.el.classList.remove('sw-pos-top', 'sw-pos-left', 'sw-pos-right');
      if (this.tailEl) this.tailEl.hidden = false;
      if (this.orbUi && typeof this.orbUi.syncLayout === 'function') this.orbUi.syncLayout();
      if (!targetOrRect) return;
      const tr = typeof targetOrRect.getBoundingClientRect === 'function' ? targetOrRect.getBoundingClientRect() : targetOrRect;
      if (!tr || !tr.width || !tr.height) return;
      const cr = this.el.getBoundingClientRect();
      const pad = 12;
      const overlaps = (a, b) => !(a.right + pad < b.left || a.left - pad > b.right || a.bottom + pad < b.top || a.top - pad > b.bottom);
      if (!overlaps(cr, tr)) return;
      if (this.tailEl) this.tailEl.hidden = true;
      const vw = rootScope.innerWidth || 1280;
      const dockRect = (this.orbUi && this.orbUi.dockEl && typeof this.orbUi.dockEl.getBoundingClientRect === 'function')
        ? this.orbUi.dockEl.getBoundingClientRect()
        : null;
      const safeBottomLimit = dockRect && dockRect.top > 0 ? dockRect.top - 12 : ((rootScope.innerHeight || 800) - 160);
      const topFits = tr.top > cr.height + 24 && (16 + cr.height) <= safeBottomLimit;
      if (topFits) { this.el.classList.add('sw-pos-top'); return; }
      if (tr.left > Math.min(420, vw * 0.42)) { this.el.classList.add('sw-pos-left'); return; }
      this.el.classList.add('sw-pos-right');
    }

    setSpeechFinished() { this.speechDone = true; this._syncAutoDismiss(); }
    setAutoDismissMs(ms) { if (Number.isFinite(ms) && ms > 0) this.autoDismissMs = ms; }
    _clearDismissTimer() { if (this._dismissTimer) { clearTimeout(this._dismissTimer); this._dismissTimer = null; } }

    _syncAutoDismiss() {
      this._clearDismissTimer();
      if (!(this.autoDismissMs > 0)) return;
      if (!this.visible || !this.speechDone || this.pinned || this.expanded || this.hovered || this.focusedWithin) return;
      if (this.el && (this.el.dataset.streamStatus === 'thinking' || this.el.dataset.streamStatus === 'streaming')) return;
      if (this.orbUi && (this.orbUi._processingTurn || this.orbUi.state === 'thinking')) return;
      if (this.spec && STICKY_TYPES.has(this.spec.type || 'summary')) return;
      this._dismissTimer = setTimeout(() => {
        this._dismissTimer = null;
        if (this.orbUi && (this.orbUi._processingTurn || this.orbUi.state === 'thinking')) return;
        // Keep the typed command bar open if the user explicitly opened/is using it.
        if (this.orbUi && this.orbUi.typeForm && !this.orbUi.typeForm.hidden) {
          this.hide({ restoreFocus: false });
          return;
        }
        this.orbUi.hide({ dissolve: true });
      }, this.autoDismissMs);
    }

    reset() {
      this._clearDismissTimer();
      this.spec = null;
      this.visible = false;
      this.expanded = false;
      this.speechDone = true;
      if (this.el) {
        this.el.hidden = true;
        this.el.classList.remove('sw-card-open', 'sw-expanded', 'sw-pos-top', 'sw-pos-left', 'sw-pos-right');
        delete this.el.dataset.cardType;
        delete this.el.dataset.streamStatus;
      }
      if (this.titleEl) this.titleEl.textContent = '';
      if (this.badgeEl) {
        this.badgeEl.textContent = '';
        this.badgeEl.hidden = true;
      }
      if (this.bodyEl) this.bodyEl.textContent = '';
      if (this.readBarEl) {
        this.readBarEl.textContent = '';
        this.readBarEl.hidden = true;
      }
      if (this.actionsEl) {
        this.actionsEl.textContent = '';
        this.actionsEl.hidden = true;
      }
    }

    hide({ restoreFocus = true } = {}) {
      this._clearDismissTimer();
      this.visible = false;
      this.expanded = false;
      if (this.el) {
        this.el.hidden = true;
        this.el.classList.remove('sw-card-open', 'sw-expanded', 'sw-pos-top', 'sw-pos-left', 'sw-pos-right');
      }
      if (restoreFocus && this._prevFocusEl && this._prevFocusEl.isConnected && typeof this._prevFocusEl.focus === 'function') {
        try { this._prevFocusEl.focus(); } catch (_e) {}
      }
      this._prevFocusEl = null;
    }
  }

  rootScope.SleepwalkerCard = SleepwalkerCard;
})(typeof window !== 'undefined' ? window : globalThis);
