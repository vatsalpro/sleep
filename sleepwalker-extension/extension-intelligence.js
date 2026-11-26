/**
 * Sleepwalker — Extension Execution Guards, Context Ledger & Click-Shield Passthrough
 *
 * Unified browser intelligence helpers integrated into Sleepwalker's single orchestrator:
 * 1. SleepwalkerExecutionGuards — Loop, stall, no-effect & consecutive-error detection
 *    (adapted from Apache-2.0 guard patterns; zero external branding).
 * 2. SleepwalkerContextLedger — Multi-turn & multi-tab structured ledger with automatic
 *    compaction and strict topic-switch isolation so prior tasks never hijack new requests.
 * 3. SleepwalkerClickShield — Pre-dispatch pointer-events passthrough & hit-test diagnostic
 *    so Sleepwalker's floating UI never intercepts its own CDP mouse/keyboard events
 *    (adapted from MIT click-shield patterns).
 */
(function (rootScope) {
  'use strict';

  if (rootScope.SleepwalkerIntelligence) return;

  // =========================================================================
  // 1. Execution Loop, No-Effect & Consecutive-Error Guards
  // =========================================================================
  const REPEAT_WINDOW = 6;
  const REPEAT_LIMIT = 3;
  const NO_EFFECT_NUDGE = 2;
  const NO_EFFECT_STOP = 3;
  const ERROR_STOP = 5;
  const MUTATING_ACTIONS = new Set(['click', 'type', 'select', 'interact_control', 'press_key', 'fill_form', 'drag']);

  class SleepwalkerExecutionGuards {
    constructor() {
      this.reset();
    }

    reset() {
      this.recent = [];
      this.errorsInRow = 0;
      this.noEffectCounts = {};
    }

    signature(action, target, outcome) {
      const t = typeof target === 'string' ? target : JSON.stringify(target || {});
      return `${action}|${t.slice(0, 120)}|${outcome || 'ok'}`;
    }

    record(action, target, { ok = true, effectObserved = true, errorCode = '' } = {}) {
      const outcome = ok ? (effectObserved ? 'ok' : 'no_effect') : (errorCode || 'error');
      const sig = this.signature(action, target, outcome);
      this.recent.push(sig);
      if (this.recent.length > REPEAT_WINDOW) this.recent.shift();

      this.errorsInRow = ok ? 0 : this.errorsInRow + 1;
      if (this.errorsInRow >= ERROR_STOP) {
        return {
          stop: `Stopped after ${ERROR_STOP} consecutive action failures to prevent an infinite loop.`,
          guard: 'errors'
        };
      }

      if (MUTATING_ACTIONS.has(String(action || '').toLowerCase()) && ok && !effectObserved) {
        const key = `${action}:${typeof target === 'string' ? target : JSON.stringify(target || {})}`;
        const count = (this.noEffectCounts[key] || 0) + 1;
        this.noEffectCounts[key] = count;
        if (count >= NO_EFFECT_STOP) {
          return {
            stop: `Action "${action}" on the same target had no observable page effect ${count} times.`,
            guard: 'no_effect'
          };
        }
        if (count >= NO_EFFECT_NUDGE) {
          return {
            nudge: `Action "${action}" had no effect ${count} times — try an alternate control, scroll, or ask the user.`,
            guard: 'no_effect'
          };
        }
      }

      const repeats = this.recent.filter((r) => r === sig).length;
      if (repeats >= REPEAT_LIMIT) {
        return {
          nudge: `Repeated the same "${action}" call with identical outcome ${repeats} times in the last ${REPEAT_WINDOW} steps. Try a different approach.`,
          guard: 'repeat'
        };
      }
      return {};
    }
  }

  // =========================================================================
  // 2. Context & Action Ledger with Compaction & Topic-Switch Isolation
  // =========================================================================
  const TOPIC_SWITCH_RE = /\b(forget\s+that|never\s*mind|new\s+topic|something\s+else|switch\s+topics?|unrelated)\b/i;

  class SleepwalkerContextLedger {
    constructor({ maxTurns = 16, maxLedgerLines = 24 } = {}) {
      this.maxTurns = maxTurns;
      this.maxLedgerLines = maxLedgerLines;
      this.turns = [];
      this.ledger = [];
      this.compactedSummary = '';
      this.knownTabs = [];
    }

    reset() {
      this.turns = [];
      this.ledger = [];
      this.compactedSummary = '';
    }

    setTabs(tabSummaries) {
      if (Array.isArray(tabSummaries)) {
        this.knownTabs = tabSummaries.slice(0, 12);
      }
    }

    recordTurn(role, text, meta = {}) {
      const clean = String(text || '').trim();
      if (!clean) return;
      if (role === 'user' && TOPIC_SWITCH_RE.test(clean)) {
        this.reset();
      }
      this.turns.push({ role, text: clean.slice(0, 800), ts: Date.now(), meta });
      if (this.turns.length > this.maxTurns) {
        const dropped = this.turns.splice(0, this.turns.length - Math.floor(this.maxTurns / 2));
        const compactLine = dropped
          .filter((t) => t.role === 'user')
          .map((t) => t.text.slice(0, 80))
          .join(' -> ');
        if (compactLine) {
          this.compactedSummary = [this.compactedSummary, compactLine].filter(Boolean).join(' | ').slice(-600);
        }
      }
    }

    recordAction(stepName, target, ok, url = '') {
      this.ledger.push({
        step: String(stepName || 'action'),
        target: String(target || '').slice(0, 80),
        ok: Boolean(ok),
        url: String(url || '').slice(0, 120),
        ts: Date.now()
      });
      if (this.ledger.length > this.maxLedgerLines) {
        this.ledger.shift();
      }
    }

    buildCompactContext({ includeHistory = true, includeTabs = false } = {}) {
      const parts = [];
      if (includeTabs && this.knownTabs.length > 0) {
        parts.push('Open tabs:\n' + this.knownTabs.map((t) => `- [${t.tabId}]${t.active ? '*' : ''} ${t.title || t.url}`).join('\n'));
      }
      if (includeHistory) {
        if (this.compactedSummary) {
          parts.push(`Earlier compacted topics: ${this.compactedSummary}`);
        }
        if (this.turns.length > 0) {
          parts.push('Recent conversation:\n' + this.turns.slice(-6).map((t) => `${t.role === 'user' ? 'User' : 'Sleepwalker'}: ${t.text}`).join('\n'));
        }
        if (this.ledger.length > 0) {
          parts.push('Recent verified actions:\n' + this.ledger.slice(-6).map((a) => `- ${a.step} "${a.target}" -> ${a.ok ? 'OK' : 'FAILED'}`).join('\n'));
        }
      }
      return parts.join('\n\n');
    }
  }

  // =========================================================================
  // 3. Click-Shield Passthrough & Pre-Dispatch Hit-Test Diagnostic
  // =========================================================================
  const SleepwalkerClickShield = {
    setPassthrough(on) {
      try {
        const doc = rootScope.document;
        if (!doc) return false;
        const host = doc.getElementById('sleepwalker-ui-host') || doc.querySelector('[data-sleepwalker-host="true"]');
        if (!host) return false;
        host.style.pointerEvents = on ? 'none' : '';
        if (host.shadowRoot) {
          const root = host.shadowRoot.querySelector('.sw-ui-root');
          if (root) root.style.pointerEvents = 'none';
        }
        return true;
      } catch (_e) {
        return false;
      }
    },

    diagnoseHitPoint(x, y) {
      try {
        const doc = rootScope.document;
        if (!doc || typeof doc.elementsFromPoint !== 'function') return { ok: false, tag: 'NO_DOM' };
        const vw = rootScope.innerWidth || 0;
        const vh = rootScope.innerHeight || 0;
        if (x < 0 || y < 0 || x > vw || y > vh) {
          return { ok: false, tag: 'OFF_VIEWPORT', x, y, vw, vh };
        }
        const stack = doc.elementsFromPoint(x, y) || [];
        const top = stack[0] || null;
        const topId = top ? (top.id || top.tagName || '') : '';
        const isOwnOverlay = Boolean(top && (top.id === 'sleepwalker-ui-host' || (top.hasAttribute && top.hasAttribute('data-sleepwalker-host'))));
        return {
          ok: !isOwnOverlay && Boolean(top),
          tag: isOwnOverlay ? 'OVERLAY_INTERCEPT' : 'OK',
          top: topId,
          chain: stack.slice(0, 4).map((el) => `${el.tagName}${el.id ? '#' + el.id : ''}`)
        };
      } catch (_e) {
        return { ok: false, tag: 'DIAG_ERROR' };
      }
    },

    async withPassthrough(fn) {
      this.setPassthrough(true);
      try {
        return await fn();
      } finally {
        this.setPassthrough(false);
      }
    }
  };

  // =========================================================================
  // 4. Numbered Interactive Element Indexer & Anti-Deception Risk Inspector
  //    (Adapted from MIT io-software-ai/browser-agent elements.ts)
  // =========================================================================
  const INDEX_SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary', 'label[for]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]',
    '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]', "[contenteditable='']", '[contenteditable=true]'
  ].join(',');

  const RISKY_ACTION_RE = /\b(pay|payment|buy|purchase|checkout|place\s+order|delete|remove\s+account|submit|publish|send|transfer|authori[sz]e|approve|grant|confirm|unsubscribe|commit|merge\s+pull\s+request)\b/i;

  const SleepwalkerElementIndexer = {
    listInteractiveElements(limit = 120) {
      const doc = rootScope.document;
      if (!doc || !doc.body) return { count: 0, lines: [], text: '(No interactive elements found)' };
      const clip = (s, n = 60) => {
        const clean = String(s || '').replace(/\s+/g, ' ').trim();
        return clean.length > n ? `${clean.slice(0, n)}...` : clean;
      };
      const labelText = (el) => {
        const lab = el.labels && el.labels[0];
        if (!lab) return '';
        const clone = lab.cloneNode(true);
        clone.querySelectorAll('select, input, textarea').forEach((n) => n.remove());
        return clone.textContent || '';
      };
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return null;
        const st = rootScope.getComputedStyle ? rootScope.getComputedStyle(el) : null;
        if (st && (st.visibility === 'hidden' || st.opacity === '0')) return null;
        return r;
      };

      doc.querySelectorAll('[data-sw-ref]').forEach((e) => e.removeAttribute('data-sw-ref'));
      const seen = new Set();
      const found = [];
      const add = (el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const r = isVisible(el);
        if (r) {
          found.push({
            el,
            inView: r.bottom > 0 && r.top < (rootScope.innerHeight || 900) && r.right > 0 && r.left < (rootScope.innerWidth || 1440)
          });
        }
      };

      doc.querySelectorAll(INDEX_SEL).forEach(add);
      // Detect SPA clickable elements (cursor: pointer whose parent is not pointer)
      if (typeof rootScope.getComputedStyle === 'function') {
        for (const el of doc.body.querySelectorAll('div, span, li, img, svg')) {
          if (seen.has(el)) continue;
          if (rootScope.getComputedStyle(el).cursor !== 'pointer') continue;
          if (el.parentElement && rootScope.getComputedStyle(el.parentElement).cursor === 'pointer') continue;
          if (el.closest && el.closest(INDEX_SEL)) continue;
          add(el);
        }
      }

      // Sort in-viewport elements first
      found.sort((a, b) => Number(b.inView) - Number(a.inView));
      const lines = [];
      found.slice(0, limit).forEach(({ el, inView }, idx) => {
        const ref = idx + 1;
        el.setAttribute('data-sw-ref', String(ref));
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        let kind = role || (tag === 'a' ? 'link' : tag);
        if (tag === 'input') kind = `input[${el.type || 'text'}]`;
        const name = clip(
          el.getAttribute('aria-label') || labelText(el) || (tag === 'select' ? '' : el.innerText) ||
          el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
          el.getAttribute('name') || ''
        );
        let extra = '';
        if (tag === 'select' && el.options) {
          const opts = Array.from(el.options).slice(0, 10).map((o) => clip(o.text, 28));
          extra = ` options=[${opts.join(' | ')}]`;
        } else if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
          extra = el.checked ? ' [checked]' : ' [unchecked]';
        } else if ((tag === 'input' || tag === 'textarea') && el.value) {
          extra = ` value="${clip(el.value, 36)}"`;
        }
        if (el.disabled) extra += ' [disabled]';
        if (!inView) extra += ' [offscreen]';
        lines.push(`[${ref}] ${kind}${name ? ` "${name}"` : ''}${extra}`);
      });
      return { count: found.length, indexed: Math.min(found.length, limit), lines, text: lines.join('\n') };
    },

    inspectTargetRisk(selectorOrRef, submitting = false) {
      const doc = rootScope.document;
      if (!doc) return null;
      const sel = typeof selectorOrRef === 'number' ? `[data-sw-ref="${Math.floor(selectorOrRef)}"]` : String(selectorOrRef || '');
      const el = doc.querySelector(sel);
      if (!el) return null;
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const visible = norm(el.innerText || (el.tagName === 'INPUT' ? (el.value || el.alt) : ''));
      const aria = norm(el.getAttribute && el.getAttribute('aria-label'));
      const title = norm(el.getAttribute && el.getAttribute('title'));
      const value = norm(el.value);
      const low = (s) => s.toLowerCase();
      const mismatch = Boolean(visible && aria && !low(visible).includes(low(aria)) && !low(aria).includes(low(visible)));
      const form = el.form || (el.closest && el.closest('form'));
      const isSearchForm = Boolean(form && (form.matches('[role=search]') || form.querySelector('input[type=search], input[name=q], input[name=query], input[name=search]')));
      const riskyText = [visible, aria, title, value].some((t) => t && RISKY_ACTION_RE.test(t));
      const risky = (riskyText || (submitting && !isSearchForm) || mismatch) && !isSearchForm;
      return { risky, mismatch, label: visible || aria || title || value, aria, visible };
    }
  };

  rootScope.SleepwalkerIntelligence = {
    SleepwalkerExecutionGuards,
    SleepwalkerContextLedger,
    SleepwalkerClickShield,
    SleepwalkerElementIndexer
  };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
