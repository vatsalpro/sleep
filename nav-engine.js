/**
 * Sleepwalker Phase 4.4 — Navigation & Verification Engine
 * Shared vanilla-JS runtime primitives combining research insights from:
 * - Kiki (fast-path tiering, DOM settle, FSM guard)
 * - DOMino (safe atomic queue, connected handle guard, screenshot hide/restore)
 * - Lucy (spatial & accessibility grounding, transition matrix, AbortController cancellation)
 * - OpenSidekick (exact pre-exec identity expectations, read-after-navigate invalidation)
 * - FSB (animation-noise-filtered mutation harvest, change_report, strict verification, repeat loop guard)
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SleepwalkerNavEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const AGENT_STATES = Object.freeze({
    IDLE: 'IDLE',
    LISTENING: 'LISTENING',
    TRANSCRIBING: 'TRANSCRIBING',
    CLASSIFYING: 'CLASSIFYING',
    OBSERVING: 'OBSERVING',
    RETRIEVING: 'RETRIEVING',
    PLANNING: 'PLANNING',
    VALIDATING: 'VALIDATING',
    EXECUTING: 'EXECUTING',
    WAITING_FOR_PAGE: 'WAITING_FOR_PAGE',
    VERIFYING: 'VERIFYING',
    REPLANNING: 'REPLANNING',
    WAITING_FOR_USER: 'WAITING_FOR_USER',
    RECOVERING: 'RECOVERING',
    RESPONDING: 'RESPONDING',
    RESTING: 'RESTING',
    ERROR: 'ERROR'
  });

  const VALID_TRANSITIONS = Object.freeze({
    IDLE: new Set(['LISTENING', 'CLASSIFYING', 'OBSERVING', 'EXECUTING', 'RESPONDING', 'RESTING', 'ERROR']),
    LISTENING: new Set(['TRANSCRIBING', 'CLASSIFYING', 'IDLE', 'RESTING', 'ERROR']),
    TRANSCRIBING: new Set(['CLASSIFYING', 'LISTENING', 'IDLE', 'RESTING', 'ERROR']),
    CLASSIFYING: new Set(['OBSERVING', 'EXECUTING', 'WAITING_FOR_USER', 'RESPONDING', 'IDLE', 'RESTING', 'ERROR']),
    OBSERVING: new Set(['RETRIEVING', 'PLANNING', 'VALIDATING', 'EXECUTING', 'WAITING_FOR_USER', 'RESPONDING', 'IDLE', 'RESTING', 'ERROR']),
    RETRIEVING: new Set(['PLANNING', 'VALIDATING', 'EXECUTING', 'WAITING_FOR_USER', 'RESPONDING', 'IDLE', 'RESTING', 'ERROR']),
    PLANNING: new Set(['VALIDATING', 'EXECUTING', 'WAITING_FOR_USER', 'RESPONDING', 'RECOVERING', 'IDLE', 'RESTING', 'ERROR']),
    VALIDATING: new Set(['EXECUTING', 'WAITING_FOR_USER', 'REPLANNING', 'RECOVERING', 'RESPONDING', 'IDLE', 'RESTING', 'ERROR']),
    EXECUTING: new Set(['WAITING_FOR_PAGE', 'VERIFYING', 'WAITING_FOR_USER', 'RESPONDING', 'RECOVERING', 'IDLE', 'RESTING', 'ERROR']),
    WAITING_FOR_PAGE: new Set(['VERIFYING', 'OBSERVING', 'RECOVERING', 'RESPONDING', 'IDLE', 'RESTING', 'ERROR']),
    VERIFYING: new Set(['RESPONDING', 'REPLANNING', 'RECOVERING', 'WAITING_FOR_USER', 'EXECUTING', 'IDLE', 'RESTING', 'ERROR']),
    REPLANNING: new Set(['OBSERVING', 'PLANNING', 'VALIDATING', 'EXECUTING', 'WAITING_FOR_USER', 'RECOVERING', 'RESPONDING', 'IDLE', 'RESTING', 'ERROR']),
    WAITING_FOR_USER: new Set(['LISTENING', 'CLASSIFYING', 'VALIDATING', 'EXECUTING', 'RESPONDING', 'IDLE', 'RESTING', 'ERROR']),
    RECOVERING: new Set(['OBSERVING', 'PLANNING', 'VALIDATING', 'EXECUTING', 'WAITING_FOR_USER', 'RESPONDING', 'IDLE', 'RESTING', 'ERROR']),
    RESPONDING: new Set(['IDLE', 'LISTENING', 'WAITING_FOR_USER', 'RESTING', 'ERROR']),
    RESTING: new Set(['IDLE', 'LISTENING', 'RESPONDING']),
    ERROR: new Set(['IDLE', 'LISTENING', 'RESTING'])
  });

  const ANIMATION_NOISE_RE = /(?:animat|transition|fade|pulse|ripple|hover|focus|active|skeleton|shimmer|spinner|loading-dot|blink|sw-highlight)/i;
  const CONTEXTUAL_SCROLL_OR_SECTION_RE = /\b(?:section|heading|part|chapter|paragraph|article|discussing|explaining|about|where|called|named|titled|until|to\s+find|under\s+the)\b/i;
  const MULTI_STEP_TASK_RE = /\b(?:compare\s+.+\b(?:across|with|and)\b|open\s+.+\s+and\s+(?:then|check|find|summarize)|research\s+.+\s+and\s+|what\s+was\s+the\s+.+\s+(?:second|first|previous)\s+(?:tab|university|page)|across\s+tabs)\b/i;

  function cleanText(str) {
    return String(str || '').replace(/\s+/g, ' ').trim();
  }

  function isSleepwalkerUiNode(node) {
    if (!node || typeof node.closest !== 'function') {
      if (node && node.id && /^sleepwalker-/i.test(node.id)) return true;
      return Boolean(node && node.dataset && node.dataset.sleepwalkerUi);
    }
    return Boolean(
      node.closest('#sleepwalker-floating-ui, #sleepwalker-candidate-overlay-root, [data-sleepwalker-ui="1"], [data-sleepwalker-ui="true"]')
    );
  }

  function normalizeExplicitUrl(candidate) {
    const raw = cleanText(candidate).replace(/[.,!?;:]+$/, '');
    if (!raw || /\s/.test(raw)) return null;
    if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(raw)) return raw;
    if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|io|ai|dev|co|in|uk|de|app|wiki|me|info)(?:\/[^\s]*)?$/i.test(raw)) {
      return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    }
    if (/^localhost(?::\d+)?(?:\/[^\s]*)?$/i.test(raw)) {
      return `http://${raw}`;
    }
    return null;
  }

  /**
   * Explicit finite-state machine enforcing per-tab turn isolation, abort semantics,
   * transition validation, and per-stage latency observability.
   */
  class SleepwalkerAgentStateMachine {
    constructor(options = {}) {
      this.state = AGENT_STATES.IDLE;
      this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
      this.activeTurnByTab = new Map();
      this.currentTurn = null;
      this._seq = 0;
      this.history = [];
    }

    getState() {
      return this.state;
    }

    getActiveTurn(tabId = null) {
      if (tabId !== null && tabId !== undefined) {
        return this.activeTurnByTab.get(String(tabId)) || null;
      }
      return this.currentTurn;
    }

    beginTurn({ tabId = 'default', command = '', path = 'unknown', inventoryVersion = 0, url = '' } = {}) {
      const key = String(tabId || 'default');
      const prev = this.activeTurnByTab.get(key);
      if (prev && !prev.finished) {
        prev.superseded = true;
        prev.finished = true;
        prev.finishedAt = Date.now();
        if (prev.abortController && !prev.abortController.signal.aborted) {
          try { prev.abortController.abort('superseded_by_newer_command'); } catch (_e) {}
        }
      }

      this._seq += 1;
      const requestId = `req_${Date.now().toString(36)}_${this._seq}`;
      const abortController = typeof AbortController !== 'undefined'
        ? new AbortController()
        : { signal: { aborted: false, reason: null }, abort(r) { this.signal.aborted = true; this.signal.reason = r; } };

      const turn = {
        requestId,
        tabId: key,
        command: cleanText(command),
        path,
        initialInventoryVersion: Number(inventoryVersion) || 0,
        inventoryVersion: Number(inventoryVersion) || 0,
        initialUrl: String(url || ''),
        startedAt: Date.now(),
        finishedAt: null,
        finished: false,
        superseded: false,
        abortController,
        signal: abortController.signal,
        metrics: {
          sttMs: null,
          routingMs: null,
          observationMs: null,
          retrievalMs: null,
          reasoningMs: null,
          executionMs: null,
          verificationMs: null,
          totalMs: null
        },
        attempts: []
      };

      this.activeTurnByTab.set(key, turn);
      this.currentTurn = turn;
      if (this.state !== AGENT_STATES.IDLE && this.state !== AGENT_STATES.RESTING) {
        this.forceReset(AGENT_STATES.IDLE, 'new_turn_started');
      }
      return turn;
    }

    recordStageTiming(requestId, stageName, durationMs) {
      const turn = this._findTurn(requestId);
      if (!turn || !stageName) return;
      const key = stageName.endsWith('Ms') ? stageName : `${stageName}Ms`;
      if (Object.prototype.hasOwnProperty.call(turn.metrics, key)) {
        turn.metrics[key] = Math.max(0, Math.round(Number(durationMs) || 0));
      } else {
        turn.metrics[key] = Math.max(0, Math.round(Number(durationMs) || 0));
      }
    }

    updateInventoryVersion(requestId, version) {
      const turn = this._findTurn(requestId);
      if (turn && Number(version) > 0) turn.inventoryVersion = Number(version);
    }

    _findTurn(requestId) {
      if (!requestId) return this.currentTurn;
      if (this.currentTurn && this.currentTurn.requestId === requestId) return this.currentTurn;
      for (const t of this.activeTurnByTab.values()) {
        if (t && t.requestId === requestId) return t;
      }
      return null;
    }

    assertTurnCurrent(requestId, opts = {}) {
      const turn = this._findTurn(requestId);
      if (!turn) return { ok: false, reason: 'missing_turn' };
      if (turn.finished || turn.superseded) return { ok: false, reason: 'superseded_turn' };
      if (turn.signal && turn.signal.aborted) return { ok: false, reason: 'aborted' };
      if (opts.tabId !== undefined && String(opts.tabId) !== turn.tabId) {
        return { ok: false, reason: 'tab_changed' };
      }
      if (opts.requireInventoryVersion && Number(opts.requireInventoryVersion) !== turn.inventoryVersion) {
        return { ok: false, reason: 'stale_inventory_version' };
      }
      return { ok: true, turn };
    }

    canTransition(nextState) {
      if (nextState === this.state) return true;
      const allowed = VALID_TRANSITIONS[this.state];
      return Boolean(allowed && allowed.has(nextState));
    }

    transition(nextState, meta = {}) {
      if (!AGENT_STATES[nextState]) {
        return { ok: false, reason: `unknown_state:${nextState}`, state: this.state };
      }
      if (meta.requestId) {
        const chk = this.assertTurnCurrent(meta.requestId);
        if (!chk.ok && nextState !== AGENT_STATES.IDLE && nextState !== AGENT_STATES.RESTING) {
          return { ok: false, reason: chk.reason, state: this.state };
        }
      }
      const prev = this.state;
      if (!this.canTransition(nextState)) {
        // Explicit deterministic escalation/cancel recovery rather than silent corruption
        if (nextState === AGENT_STATES.IDLE || nextState === AGENT_STATES.ERROR || nextState === AGENT_STATES.RESTING) {
          this.state = nextState;
        } else {
          return { ok: false, reason: `invalid_transition:${prev}->${nextState}`, state: this.state };
        }
      } else {
        this.state = nextState;
      }

      const entry = { from: prev, to: this.state, at: Date.now(), requestId: meta.requestId || (this.currentTurn && this.currentTurn.requestId) || null, reason: meta.reason || '' };
      this.history.push(entry);
      if (this.history.length > 60) this.history.shift();
      if (this.onStateChange) {
        try { this.onStateChange(this.state, entry); } catch (_e) {}
      }
      return { ok: true, from: prev, to: this.state };
    }

    finishTurn(requestId, finalState = AGENT_STATES.IDLE, meta = {}) {
      const turn = this._findTurn(requestId);
      if (turn && !turn.finished) {
        turn.finished = true;
        turn.finishedAt = Date.now();
        turn.metrics.totalMs = Math.max(0, turn.finishedAt - turn.startedAt);
        turn.outcome = meta.status || 'completed';
      }
      if (AGENT_STATES[finalState] && this.state !== finalState) {
        this.forceReset(finalState, meta.reason || 'turn_finished');
      }
      return turn ? { ...turn.metrics, status: turn.outcome, requestId: turn.requestId } : null;
    }

    cancelCurrentTurn(reason = 'cancelled_by_user') {
      if (this.currentTurn && !this.currentTurn.finished) {
        this.currentTurn.finished = true;
        this.currentTurn.finishedAt = Date.now();
        this.currentTurn.metrics.totalMs = Math.max(0, this.currentTurn.finishedAt - this.currentTurn.startedAt);
        if (this.currentTurn.abortController && !this.currentTurn.abortController.signal.aborted) {
          try { this.currentTurn.abortController.abort(reason); } catch (_e) {}
        }
      }
      return this.forceReset(AGENT_STATES.IDLE, reason);
    }

    forceReset(nextState = AGENT_STATES.IDLE, reason = 'reset') {
      const prev = this.state;
      this.state = AGENT_STATES[nextState] ? nextState : AGENT_STATES.IDLE;
      const entry = { from: prev, to: this.state, at: Date.now(), reason };
      this.history.push(entry);
      if (this.history.length > 60) this.history.shift();
      if (this.onStateChange) {
        try { this.onStateChange(this.state, entry); } catch (_e) {}
      }
      return { ok: true, from: prev, to: this.state };
    }
  }

  /**
   * Part 2 Three-Path Hybrid Command Router:
   * - Path A: Fast deterministic browser actions (0 LLM calls, < 50ms)
   * - Path B: Structured page interaction path (Observation + target resolution + constrained NLU)
   * - Path C: Complex multi-step / multi-tab / external workflow path
   */
  class SleepwalkerFastPathRouter {
    classify(rawText, options = {}) {
      const raw = cleanText(rawText);
      const stripped = raw
        .replace(/^(?:hey\s+)?(?:sleepwalker|computer|assistant)[,\s]+/i, '')
        .replace(/^(?:please|kindly|can\s+you|could\s+you|would\s+you)\s+/i, '')
        .replace(/[.!?]+$/, '')
        .trim();
      const lower = stripped.toLowerCase();

      if (!lower) {
        return { path: 'A', fastAction: { type: 'noop' }, confidence: 1, reason: 'empty' };
      }

      // 0. Prompt reply / confirmation / control shortcuts remain zero-LLM
      if (options.hasPendingPrompt) {
        if (/^(?:yes|yeah|yep|ok|okay|confirm|proceed|haan|ji)$/i.test(lower)) {
          return { path: 'A', fastAction: { type: 'confirm_answer', answer: 'yes' }, confidence: 0.99, reason: 'pending_confirm_yes' };
        }
        if (/^(?:no|nope|cancel|nahi|mat|don'?t)$/i.test(lower)) {
          return { path: 'A', fastAction: { type: 'confirm_answer', answer: 'no' }, confidence: 0.99, reason: 'pending_confirm_no' };
        }
      }

      if (options.navChoiceCount > 0 && /^(?:[1-5]|first|second|third|fourth|fifth|one|two|three|four|five)$/i.test(lower)) {
        return { path: 'A', fastAction: { type: 'choice_ordinal', raw: lower }, confidence: 0.99, reason: 'pending_choice_ordinal' };
      }

      // 1. Escape / Stop Scrolling / Stop Current Action
      if (/^(?:press\s+escape|hit\s+escape|escape(?:\s+key)?|esc)$/i.test(lower)) {
        return { path: 'A', fastAction: { type: 'press_escape' }, confidence: 0.99, reason: 'fast_escape' };
      }
      if (/^(?:stop\s+scrolling|halt\s+scroll|cancel\s+scroll)$/i.test(lower)) {
        return { path: 'A', fastAction: { type: 'stop_scroll' }, confidence: 0.99, reason: 'fast_stop_scroll' };
      }
      if (/^(?:stop\s+current\s+action|cancel\s+current\s+action|abort\s+action|stop\s+now|abort)$/i.test(lower)) {
        return { path: 'A', fastAction: { type: 'stop_action' }, confidence: 0.99, reason: 'fast_stop_action' };
      }
      if (/^(?:stop|stop\s+reading|resume|repeat|read\s+again|slower|faster|rest|sleep|wake\s+up|help|outline|read\s+this\s+page)$/i.test(lower)) {
        return { path: 'A', fastAction: { type: 'legacy_control', raw: lower }, confidence: 0.98, reason: 'fast_control' };
      }

      // 2. Tab management (strictly deterministic browser Chrome API)
      if (/^(?:open\s+(?:a\s+)?new\s+tab|new\s+tab|create\s+(?:a\s+)?new\s+tab)$/i.test(lower)) {
        return { path: 'A', fastAction: { type: 'tab_new', url: '' }, confidence: 0.99, reason: 'fast_tab_new' };
      }
      const openUrlNewTabM = stripped.match(/^(?:open|load)\s+([^\s]+)\s+in\s+(?:a\s+)?new\s+tab$/i);
      if (openUrlNewTabM) {
        const u = normalizeExplicitUrl(openUrlNewTabM[1]);
        if (u) {
          return { path: 'A', fastAction: { type: 'tab_new', url: u }, confidence: 0.98, reason: 'fast_tab_new_url' };
        }
      }
      if (/^(?:close\s+(?:this|the|current)?\s*tab)$/i.test(lower)) {
        return { path: 'A', fastAction: { type: 'tab_close' }, confidence: 0.99, reason: 'fast_tab_close' };
      }
      if (/^(?:next\s+tab)$/i.test(lower)) {
        return { path: 'A', fastAction: { type: 'tab_step', delta: 1 }, confidence: 0.98, reason: 'fast_tab_next' };
      }
      if (/^(?:previous\s+tab|prev\s+tab)$/i.test(lower)) {
        return { path: 'A', fastAction: { type: 'tab_step', delta: -1 }, confidence: 0.98, reason: 'fast_tab_prev' };
      }
      const switchTabNumM = stripped.match(/^(?:switch|go|change)\s+(?:to\s+)?tab\s+(?:number\s+)?(\d+)$/i);
      if (switchTabNumM) {
        return { path: 'A', fastAction: { type: 'tab_switch', index: Math.max(0, Number(switchTabNumM[1]) - 1), query: '' }, confidence: 0.98, reason: 'fast_tab_switch_index' };
      }
      const switchTabNameM = stripped.match(/^(?:switch(?:\s+tab)?\s+to|go\s+to)\s+(?:the\s+|my\s+)?(.+?)\s+tab$/i)
        || stripped.match(/^switch\s+tab\s+(?:to\s+)?(?:the\s+)?(.+)$/i);
      if (switchTabNameM && switchTabNameM[1] && !options.hasPageTabMatch) {
        const targetTabQuery = cleanText(switchTabNameM[1].replace(/\btab$/i, ''));
        if (targetTabQuery) {
          return { path: 'A', fastAction: { type: 'tab_switch', query: targetTabQuery }, confidence: 0.97, reason: 'fast_tab_switch_name' };
        }
      }

      // 3. Explicit URL navigation (must look like real URL/domain — never hijack "go to History")
      const openUrlM = stripped.match(/^(?:open|go\s+to|navigate\s+to|visit|load)\s+([^\s]+)$/i);
      if (openUrlM && openUrlM[1]) {
        const url = normalizeExplicitUrl(openUrlM[1]);
        if (url) {
          return { path: 'A', fastAction: { type: 'open_url', url }, confidence: 0.98, reason: 'fast_open_url' };
        }
      }

      // 4. Deterministic History / Reload (reject contextual phrasing like "go back to previous section")
      if (!CONTEXTUAL_SCROLL_OR_SECTION_RE.test(lower)) {
        if (/^(?:go\s+back|back|previous\s+page|page\s+back)$/i.test(lower)) {
          return { path: 'A', fastAction: { type: 'history', dir: 'back' }, confidence: 0.98, reason: 'fast_history_back' };
        }
        if (/^(?:go\s+forward|forward|next\s+page\s+history|forward\s+page)$/i.test(lower)) {
          return { path: 'A', fastAction: { type: 'history', dir: 'forward' }, confidence: 0.98, reason: 'fast_history_forward' };
        }
        if (/^(?:reload|refresh|reload\s+(?:this\s+|the\s+)?page|refresh\s+(?:this\s+|the\s+)?page|पेज\s*रीलोड\s*करो)$/i.test(lower)) {
          return { path: 'A', fastAction: { type: 'history', dir: 'refresh' }, confidence: 0.98, reason: 'fast_history_refresh' };
        }
      }

      // 5. Deterministic Scroll (CRITICAL GUARD: reject "Scroll to the section discussing banking regulations")
      if (!CONTEXTUAL_SCROLL_OR_SECTION_RE.test(lower)) {
        if (/^(?:scroll\s+to\s+(?:the\s+)?top|go\s+to\s+(?:the\s+)?top|top\s+of\s+(?:the\s+)?page|back\s+to\s+top|sabse\s+upar|सबसे\s+ऊपर)$/i.test(lower)) {
          return { path: 'A', fastAction: { type: 'scroll', dir: 'top', amount: 'full' }, confidence: 0.99, reason: 'fast_scroll_top' };
        }
        if (/^(?:scroll\s+to\s+(?:the\s+)?bottom|go\s+to\s+(?:the\s+)?bottom|bottom\s+of\s+(?:the\s+)?page|sabse\s+neeche|सबसे\s+नीचे)$/i.test(lower)) {
          return { path: 'A', fastAction: { type: 'scroll', dir: 'bottom', amount: 'full' }, confidence: 0.99, reason: 'fast_scroll_bottom' };
        }
        const dirScrollM = lower.match(/^(?:scroll|page|go)\s+(up|down|left|right)(?:\s+(a\s+little|a\s+bit|slightly|a\s+lot|more))?$/i)
          || lower.match(/^(neeche\s+scroll\s+karo|neeche\s+jao|नीचे\s+स्क्रॉल\s+करो|upar\s+scroll\s+karo|upar\s+jao|ऊपर\s+स्क्रॉल\s+करो)$/i);
        if (dirScrollM) {
          let dir = 'down';
          const token = String(dirScrollM[1] || '').toLowerCase();
          if (token.startsWith('up') || /upar|ऊपर/.test(token)) dir = 'up';
          else if (token === 'left') dir = 'left';
          else if (token === 'right') dir = 'right';
          else dir = 'down';
          const mod = String(dirScrollM[2] || '').toLowerCase();
          const amount = /little|bit|slightly/.test(mod) ? 'small' : (/lot|more/.test(mod) ? 'large' : 'page');
          return { path: 'A', fastAction: { type: 'scroll', dir, amount }, confidence: 0.99, reason: `fast_scroll_${dir}` };
        }
      }

      // 6. Distinguish Path C (Complex Multi-Step / Cross-Tab / Research) vs Path B (Page Interaction)
      if (MULTI_STEP_TASK_RE.test(lower)) {
        return { path: 'C', fastAction: null, confidence: 0.88, reason: 'complex_multi_step_objective' };
      }

      return { path: 'B', fastAction: null, confidence: 0.9, reason: 'page_interaction_or_qa' };
    }
  }

  /**
   * Part 6 Centralized Navigation, Mutation Settling & Wait Manager.
   * Replaces fixed 2-second blind waits with signal-driven quiet-DOM settling,
   * CSS animation/Sleepwalker-UI noise filtering, and SPA pushState awareness.
   */
  class SleepwalkerWaitManager {
    constructor(options = {}) {
      this._doc = options.doc || (typeof document !== 'undefined' ? document : null);
      this._win = options.win || (typeof window !== 'undefined' ? window : null);
      this._activeScrollCancelled = false;
    }

    stopCurrentScroll(winOverride = null) {
      this._activeScrollCancelled = true;
      const win = winOverride || this._win;
      if (win && typeof win.scrollTo === 'function') {
        try {
          win.scrollTo({ top: win.scrollY || 0, left: win.scrollX || 0, behavior: 'auto' });
        } catch (_e) {}
      }
      return { stopped: true };
    }

    _isNoisyMutation(rec) {
      if (!rec) return true;
      const target = rec.target;
      if (isSleepwalkerUiNode(target)) return true;

      if (rec.type === 'childList') {
        const nodes = [...(rec.addedNodes || []), ...(rec.removedNodes || [])];
        if (nodes.length === 0) return true;
        return nodes.every((n) => isSleepwalkerUiNode(n));
      }

      if (rec.type === 'attributes') {
        const attr = String(rec.attributeName || '').toLowerCase();
        if (attr === 'style') return false; // Could reveal modal/panel; verify via class/hidden separately if animated
        if (attr === 'class' && target && typeof target.getAttribute === 'function') {
          const prevCls = String(rec.oldValue || '');
          const nextCls = String(target.getAttribute('class') || '');
          const diffTokens = `${prevCls} ${nextCls}`.split(/\s+/).filter(Boolean);
          const allAnim = diffTokens.length > 0 && diffTokens.every((t) => ANIMATION_NOISE_RE.test(t));
          if (allAnim) return true;
        }
      }
      return false;
    }

    startMutationHarvest(rootNode = null, opts = {}) {
      const doc = opts.doc || this._doc;
      const rootEl = rootNode || (doc && (doc.body || doc.documentElement));
      const records = [];
      let totalRaw = 0;
      let filteredNoise = 0;
      let settledAt = null;
      let lastMeaningfulAt = Date.now();
      let observer = null;

      const ObsCtor = (this._win && this._win.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      if (ObsCtor && rootEl) {
        try {
          observer = new ObsCtor((muts) => {
            for (let i = 0; i < muts.length; i++) {
              totalRaw += 1;
              if (records.length >= (opts.maxRecords || 250)) break;
              const rec = muts[i];
              if (this._isNoisyMutation(rec)) {
                filteredNoise += 1;
                continue;
              }
              lastMeaningfulAt = Date.now();
              records.push(rec);
            }
          });
          observer.observe(rootEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeOldValue: true,
            attributeFilter: ['aria-checked', 'aria-selected', 'aria-expanded', 'aria-hidden', 'aria-disabled', 'hidden', 'disabled', 'open', 'class', 'value', 'href', 'src']
          });
        } catch (_e) {
          observer = null;
        }
      }

      return {
        records,
        getStats: () => ({
          meaningfulMutations: records.length,
          totalRawMutations: totalRaw,
          filteredNoise,
          lastMeaningfulAt,
          settledAt
        }),
        stop: () => {
          settledAt = Date.now();
          if (observer && typeof observer.disconnect === 'function') {
            try { observer.disconnect(); } catch (_e) {}
          }
          return {
            records: records.slice(),
            meaningfulMutations: records.length,
            totalRawMutations: totalRaw,
            filteredNoise,
            lastMeaningfulAt,
            settledAt
          };
        }
      };
    }

    async waitForDOMSettled(options = {}) {
      const doc = options.doc || this._doc;
      const rootNode = options.root || (doc && (doc.body || doc.documentElement));
      const timeoutMs = Math.max(80, Number(options.timeoutMs) || 1200);
      const quietMs = Math.max(30, Number(options.quietMs) || 120);
      const signal = options.signal || null;
      const start = Date.now();

      if (signal && signal.aborted) {
        return { settled: false, aborted: true, elapsedMs: 0, meaningfulMutations: 0 };
      }

      const ObsCtor = (this._win && this._win.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      if (!ObsCtor || !rootNode) {
        await new Promise((r) => setTimeout(r, Math.min(80, quietMs)));
        return { settled: true, elapsedMs: Date.now() - start, meaningfulMutations: 0, fallback: true };
      }

      return await new Promise((resolve) => {
        let settled = false;
        let meaningfulMutations = 0;
        let lastEventAt = Date.now();
        let quietTimer = null;
        let maxTimer = null;
        let observer = null;

        const finish = (timedOut = false, aborted = false) => {
          if (settled) return;
          settled = true;
          if (quietTimer) clearTimeout(quietTimer);
          if (maxTimer) clearTimeout(maxTimer);
          if (observer) {
            try { observer.disconnect(); } catch (_e) {}
          }
          if (signal && typeof signal.removeEventListener === 'function') {
            try { signal.removeEventListener('abort', onAbort); } catch (_e) {}
          }
          resolve({
            settled: !aborted,
            timedOut,
            aborted,
            elapsedMs: Date.now() - start,
            quietWaitMs: Date.now() - lastEventAt,
            meaningfulMutations
          });
        };

        const bumpQuiet = () => {
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish(false, false), quietMs);
        };

        const onAbort = () => finish(false, true);
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          observer = new ObsCtor((muts) => {
            let hadReal = false;
            for (let i = 0; i < muts.length; i++) {
              if (!this._isNoisyMutation(muts[i])) {
                meaningfulMutations += 1;
                hadReal = true;
              }
            }
            if (hadReal) {
              lastEventAt = Date.now();
              if (meaningfulMutations >= (options.maxMutations || 500)) {
                finish(false, false);
              } else {
                bumpQuiet();
              }
            }
          });
          observer.observe(rootNode, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeOldValue: true,
            attributeFilter: ['aria-checked', 'aria-selected', 'aria-expanded', 'aria-hidden', 'hidden', 'disabled', 'open', 'class', 'value']
          });
        } catch (_e) {
          finish(false, false);
          return;
        }

        bumpQuiet();
        maxTimer = setTimeout(() => finish(true, false), timeoutMs);
      });
    }

    async waitForNavigation(options = {}) {
      const doc = options.doc || this._doc;
      const win = options.win || this._win;
      const urlBefore = String(options.urlBefore || (win && win.location && win.location.href) || '');
      const timeoutMs = Math.max(150, Number(options.timeoutMs) || 2200);
      const signal = options.signal || null;
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        if (signal && signal.aborted) {
          return { navigated: false, aborted: true, url: (win && win.location && win.location.href) || urlBefore, elapsedMs: Date.now() - start };
        }
        const curUrl = (win && win.location && win.location.href) || '';
        const ready = !doc || !doc.readyState || doc.readyState === 'complete' || doc.readyState === 'interactive';
        if (curUrl && curUrl !== urlBefore && ready) {
          const settle = await this.waitForDOMSettled({ doc, timeoutMs: Math.min(900, options.settleTimeoutMs || 700), quietMs: 110, signal });
          return { navigated: true, urlChanged: true, urlBefore, urlAfter: curUrl, readyState: (doc && doc.readyState) || 'complete', settle, elapsedMs: Date.now() - start };
        }
        await new Promise((r) => setTimeout(r, 45));
      }

      const finalUrl = (win && win.location && win.location.href) || urlBefore;
      const settle = await this.waitForDOMSettled({ doc, timeoutMs: Math.min(700, options.settleTimeoutMs || 500), quietMs: 100, signal });
      return {
        navigated: finalUrl !== urlBefore,
        urlChanged: finalUrl !== urlBefore,
        urlBefore,
        urlAfter: finalUrl,
        readyState: (doc && doc.readyState) || 'complete',
        settle,
        elapsedMs: Date.now() - start
      };
    }

    async waitForElement(predicate, options = {}) {
      const doc = options.doc || this._doc;
      const timeoutMs = Math.max(100, Number(options.timeoutMs) || 2000);
      const signal = options.signal || null;
      const find = () => {
        try { return predicate(doc) || null; } catch (_e) { return null; }
      };
      const existing = find();
      if (existing) return existing;
      if (signal && signal.aborted) return null;

      const Observer = (this._win && this._win.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      const rootNode = options.root || (doc && (doc.body || doc.documentElement));
      if (!Observer || !rootNode) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (signal && signal.aborted) return null;
          await new Promise((r) => setTimeout(r, Number(options.pollMs) || 50));
          const found = find();
          if (found) return found;
        }
        return null;
      }

      return await new Promise((resolve) => {
        let settled = false;
        let observer = null;
        const timer = setTimeout(() => finish(null), timeoutMs);
        const onAbort = () => finish(null);
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (observer) observer.disconnect();
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
        if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
        try {
          observer = new Observer(() => {
            const found = find();
            if (found) finish(found);
          });
          observer.observe(rootNode, { childList: true, subtree: true, attributes: true });
          // Close the gap between the initial query and observer installation.
          const found = find();
          if (found) finish(found);
        } catch (_e) {
          finish(null);
        }
      });
    }

  }

  /**
   * Part 5 Pre/Post State Verifier: ensures Sleepwalker NEVER announces success
   * solely because `.click()` did not throw.
   */
  class SleepwalkerActionVerifier {
    captureState(doc, targetEl = null, opts = {}) {
      const win = opts.win || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
      const attr = (el, k) => (el && typeof el.getAttribute === 'function' ? el.getAttribute(k) : null);
      let rect = null;
      if (targetEl && typeof targetEl.getBoundingClientRect === 'function') {
        try {
          const r = targetEl.getBoundingClientRect();
          rect = { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
        } catch (_e) {}
      }
      const dialogs = doc && typeof doc.querySelectorAll === 'function'
        ? doc.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]').length
        : 0;
      const listboxes = doc && typeof doc.querySelectorAll === 'function'
        ? doc.querySelectorAll('[role="listbox"]:not([hidden]), [role="menu"]:not([hidden])').length
        : 0;
      const activeEl = doc ? doc.activeElement : null;
      const bodyTextLen = (doc && doc.body && (doc.body.innerText || doc.body.textContent || '').length) || 0;

      return {
        ts: Date.now(),
        url: (win && win.location && win.location.href) || (doc && doc.location && doc.location.href) || '',
        title: (doc && doc.title) || '',
        scrollY: (win && typeof win.scrollY === 'number') ? win.scrollY : ((win && win.pageYOffset) || 0),
        scrollX: (win && typeof win.scrollX === 'number') ? win.scrollX : ((win && win.pageXOffset) || 0),
        scrollHeight: (doc && doc.documentElement && doc.documentElement.scrollHeight) || (doc && doc.body && doc.body.scrollHeight) || 0,
        viewportHeight: (win && win.innerHeight) || 768,
        viewportWidth: (win && win.innerWidth) || 1280,
        dialogsCount: dialogs,
        openListboxesCount: listboxes,
        bodyTextLen,
        activeTag: activeEl ? String(activeEl.tagName || '').toLowerCase() : '',
        activeId: activeEl ? (activeEl.id || '') : '',
        targetConnected: targetEl ? (targetEl.isConnected !== false) : false,
        targetValue: targetEl && 'value' in targetEl ? String(targetEl.value ?? '') : '',
        targetChecked: Boolean(targetEl && (targetEl.checked || attr(targetEl, 'aria-checked') === 'true')),
        targetSelected: Boolean(targetEl && (targetEl.selected || attr(targetEl, 'aria-selected') === 'true')),
        targetExpanded: targetEl ? attr(targetEl, 'aria-expanded') : null,
        targetPressed: targetEl ? attr(targetEl, 'aria-pressed') : null,
        targetText: targetEl ? cleanText(targetEl.innerText || targetEl.textContent || '').slice(0, 120) : '',
        targetRect: rect
      };
    }

    computeChangeReport(before, after, harvestStats = null) {
      const b = before || {};
      const a = after || {};
      const vh = a.viewportHeight || b.viewportHeight || 768;
      const rect = a.targetRect || null;
      const inViewport = Boolean(
        rect && rect.height >= 0 && rect.bottom > 0 && rect.top < vh
      );
      const dialogsOpened = Math.max(0, (a.dialogsCount || 0) - (b.dialogsCount || 0));
      const listboxesOpened = Math.max(0, (a.openListboxesCount || 0) - (b.openListboxesCount || 0));

      return {
        urlChanged: Boolean(b.url && a.url && b.url !== a.url),
        urlBefore: b.url || '',
        urlAfter: a.url || '',
        titleChanged: (b.title || '') !== (a.title || ''),
        scrollDeltaY: (a.scrollY || 0) - (b.scrollY || 0),
        scrollDeltaX: (a.scrollX || 0) - (b.scrollX || 0),
        scrollChanged: Math.abs((a.scrollY || 0) - (b.scrollY || 0)) >= 2 || Math.abs((a.scrollX || 0) - (b.scrollX || 0)) >= 2,
        dialogsOpened,
        listboxesOpened,
        nodesMutated: harvestStats ? (harvestStats.meaningfulMutations || 0) : 0,
        bodyTextDelta: Math.abs((a.bodyTextLen || 0) - (b.bodyTextLen || 0)),
        inputValueChanged: (b.targetValue || '') !== (a.targetValue || ''),
        checkedChanged: Boolean(b.targetChecked) !== Boolean(a.targetChecked),
        selectedChanged: Boolean(b.targetSelected) !== Boolean(a.targetSelected),
        expandedChanged: (b.targetExpanded || null) !== (a.targetExpanded || null),
        pressedChanged: (b.targetPressed || null) !== (a.targetPressed || null),
        textChanged: (b.targetText || '') !== (a.targetText || ''),
        targetDisconnected: Boolean(b.targetConnected && !a.targetConnected),
        targetInViewport: inViewport,
        focusChanged: (b.activeTag !== a.activeTag) || (b.activeId !== a.activeId),
        settleMs: harvestStats && harvestStats.settledAt && b.ts ? Math.max(0, harvestStats.settledAt - b.ts) : Math.max(0, (a.ts || 0) - (b.ts || 0))
      };
    }

    verify(actionType, before, after, harvestStats = null, expected = {}) {
      const report = this.computeChangeReport(before, after, harvestStats);
      const kind = String(actionType || '').toLowerCase();

      if (kind === 'scroll') {
        const atTop = expected.dir === 'up' && (after.scrollY || 0) <= 0;
        const atBottom = expected.dir === 'down' && after.scrollHeight > 0 && (after.scrollY + after.viewportHeight >= after.scrollHeight - 4);
        const verified = report.scrollChanged || atTop || atBottom || Boolean(expected.hadScrollableContainerMoved);
        return { verified, reason: verified ? 'scroll_verified' : 'scroll_position_unchanged', changeReport: report };
      }

      if (kind === 'scroll_to_section' || kind === 'scroll_to_element') {
        const verified = report.targetInViewport || report.scrollChanged || report.urlChanged;
        return { verified, reason: verified ? 'target_brought_into_view' : 'target_not_visible_after_scroll', changeReport: report };
      }

      if (kind === 'click_link' || kind === 'open_link' || kind === 'open_video') {
        const verified = Boolean(
          report.urlChanged ||
          expected.newTabOpened ||
          report.dialogsOpened > 0 ||
          report.nodesMutated > 0 ||
          report.bodyTextDelta >= 12 ||
          report.targetDisconnected ||
          report.selectedChanged ||
          report.expandedChanged ||
          report.scrollChanged
        );
        return { verified, reason: verified ? 'navigation_or_dom_effect_verified' : 'no_observable_change_after_click', changeReport: report };
      }

      if (kind === 'select_option' || kind === 'select_radio' || kind === 'check') {
        const targetValLower = cleanText(expected.expectedValue || '').toLowerCase();
        const actualValLower = cleanText(after.targetValue || after.targetText || '').toLowerCase();
        const valueMatches = targetValLower ? (actualValLower === targetValLower || actualValLower.includes(targetValLower)) : false;
        const desired = expected.desired !== undefined ? Boolean(expected.desired) : true;
        const verified = Boolean(
          (kind === 'check' ? after.targetChecked === desired : (after.targetChecked || after.targetSelected || valueMatches)) ||
          report.checkedChanged ||
          report.selectedChanged ||
          report.inputValueChanged ||
          (targetValLower && report.textChanged && valueMatches)
        );
        return { verified, reason: verified ? 'selection_state_verified' : 'selection_state_unchanged', changeReport: report };
      }

      if (kind === 'select_tab' || kind === 'click_button' || kind === 'toggle') {
        const verified = Boolean(
          after.targetSelected ||
          report.selectedChanged ||
          report.expandedChanged ||
          report.pressedChanged ||
          report.checkedChanged ||
          report.dialogsOpened > 0 ||
          report.listboxesOpened > 0 ||
          report.urlChanged ||
          report.nodesMutated > 0
        );
        return { verified, reason: verified ? 'control_activation_verified' : 'no_control_state_change', changeReport: report };
      }

      if (kind === 'type' || kind === 'search') {
        const expVal = cleanText(expected.expectedValue || '').toLowerCase();
        const typedMatches = expVal
          ? cleanText(after.targetValue || '').toLowerCase().includes(expVal)
          : Boolean(after.targetValue);
        const verified = Boolean(report.urlChanged || report.nodesMutated > 0 || report.inputValueChanged || typedMatches || expected.submitted);
        return { verified, reason: verified ? 'input_or_submit_verified' : 'input_did_not_update', changeReport: report };
      }

      // Generic fallback verification requires ANY real effect
      const anyEffect = Boolean(
        report.urlChanged ||
        report.scrollChanged ||
        report.dialogsOpened > 0 ||
        report.nodesMutated > 0 ||
        report.checkedChanged ||
        report.selectedChanged ||
        report.expandedChanged ||
        report.inputValueChanged
      );
      return { verified: anyEffect, reason: anyEffect ? 'effect_verified' : 'no_effect_detected', changeReport: report };
    }
  }

  /**
   * Part 4 Non-occluding numbered temporary candidate overlays for ambiguous matches.
   * Badges sit offset beside the element rect, use pointer-events:none, and always
   * tear down cleanly on selection, cancellation, navigation, or expiry.
   */
  class SleepwalkerCandidateOverlay {
    constructor(options = {}) {
      this._doc = options.doc || (typeof document !== 'undefined' ? document : null);
      this._win = options.win || (typeof window !== 'undefined' ? window : null);
      this._rootId = 'sleepwalker-candidate-overlay-root';
      this._expiryTimer = null;
      this._keyListener = null;
      this._activeBadges = [];
    }

    showCandidates(candidates = [], options = {}) {
      const doc = options.doc || this._doc;
      const win = options.win || this._win;
      this.clear({ doc, win });
      if (!doc || !Array.isArray(candidates) || candidates.length === 0) return [];

      const hostParent = doc.body || doc.documentElement;
      if (!hostParent || typeof doc.createElement !== 'function') return [];

      const rootEl = doc.createElement('div');
      rootEl.id = this._rootId;
      rootEl.setAttribute('data-sleepwalker-ui', '1');
      rootEl.setAttribute('aria-hidden', 'true');
      if (rootEl.style) {
        rootEl.style.position = 'fixed';
        rootEl.style.inset = '0';
        rootEl.style.pointerEvents = 'none';
        rootEl.style.zIndex = '2147483645';
      }

      const badges = [];
      for (let i = 0; i < candidates.length && i < 9; i++) {
        const cand = candidates[i];
        const el = cand && (cand.element || cand.clickTarget);
        const num = i + 1;

        if (el && el.style) {
          cand._prevOutline = el.style.outline || '';
          cand._prevOutlineOffset = el.style.outlineOffset || '';
          cand._prevBoxShadow = el.style.boxShadow || '';
          cand._prevBorderRadius = el.style.borderRadius || '';
          el.style.outline = '3px solid #f59e0b';
          el.style.outlineOffset = '3px';
          el.style.boxShadow = '0 0 0 3px rgba(37, 99, 235, 0.38), 0 0 18px rgba(245, 158, 11, 0.62)';
          if (typeof el.setAttribute === 'function') el.setAttribute('data-sw-candidate-highlighted', '1');
        }

        const badge = doc.createElement('div');
        badge.className = 'sw-candidate-badge';
        badge.setAttribute('data-sleepwalker-ui', '1');
        badge.setAttribute('data-candidate-number', String(num));
        badge.textContent = String(num);

        let top = 16 + i * 28;
        let left = 16;
        if (el && typeof el.getBoundingClientRect === 'function') {
          try {
            const rect = el.getBoundingClientRect();
            const vw = (win && win.innerWidth) || 1280;
            const vh = (win && win.innerHeight) || 720;
            // Offset just outside top-left corner so badge never occludes text inside candidate
            top = Math.max(4, Math.min(vh - 28, (rect.top || 0) - 10));
            left = Math.max(4, Math.min(vw - 28, (rect.left || 0) - 24 >= 4 ? (rect.left - 24) : ((rect.right || 0) + 6)));
          } catch (_e) {}
        }

        if (badge.style) {
          badge.style.position = 'fixed';
          badge.style.top = `${Math.round(top)}px`;
          badge.style.left = `${Math.round(left)}px`;
          badge.style.minWidth = '22px';
          badge.style.height = '22px';
          badge.style.padding = '0 6px';
          badge.style.borderRadius = '999px';
          badge.style.background = '#1d4ed8';
          badge.style.color = '#ffffff';
          badge.style.fontSize = '12px';
          badge.style.fontWeight = '700';
          badge.style.lineHeight = '22px';
          badge.style.textAlign = 'center';
          badge.style.boxShadow = '0 2px 6px rgba(0,0,0,0.35)';
          badge.style.pointerEvents = 'none';
        }

        rootEl.appendChild(badge);
        badges.push({ number: num, badge, element: el, candidate: cand });
      }

      hostParent.appendChild(rootEl);
      this._activeBadges = badges;

      const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 20000;
      this._expiryTimer = setTimeout(() => {
        this.clear({ doc, win });
      }, ttlMs);

      if (doc && typeof doc.addEventListener === 'function') {
        this._keyListener = (ev) => {
          if (ev && ev.key === 'Escape') {
            this.clear({ doc, win });
          }
        };
        doc.addEventListener('keydown', this._keyListener, true);
      }

      return badges;
    }

    clear(options = {}) {
      const doc = options.doc || this._doc;
      if (this._expiryTimer) {
        clearTimeout(this._expiryTimer);
        this._expiryTimer = null;
      }
      if (this._keyListener && doc && typeof doc.removeEventListener === 'function') {
        try { doc.removeEventListener('keydown', this._keyListener, true); } catch (_e) {}
        this._keyListener = null;
      }
      for (const b of this._activeBadges) {
        const el = b && b.element;
        const cand = b && b.candidate;
        if (el && el.style && cand) {
          try {
            el.style.outline = cand._prevOutline || '';
            el.style.outlineOffset = cand._prevOutlineOffset || '';
            el.style.boxShadow = cand._prevBoxShadow || '';
            if (typeof el.removeAttribute === 'function') el.removeAttribute('data-sw-candidate-highlighted');
          } catch (_e) {}
        }
      }
      this._activeBadges = [];

      if (doc && typeof doc.getElementById === 'function') {
        const existing = doc.getElementById(this._rootId);
        if (existing && typeof existing.remove === 'function') {
          try { existing.remove(); } catch (_e) {}
        } else if (existing && existing.parentNode) {
          try { existing.parentNode.removeChild(existing); } catch (_e) {}
        }
      }
      return true;
    }

    getActiveCount() {
      return this._activeBadges.length;
    }
  }

  /**
   * Part 5 Pre-execution target binding & stale/covered guard (OpenSidekick + DOMino).
   */
  function validateTargetBinding(entity, options = {}) {
    if (!entity) return { ok: false, reason: 'missing_entity' };
    if (options.expectedTabId !== undefined && entity.tabId !== undefined && String(options.expectedTabId) !== String(entity.tabId)) {
      return { ok: false, reason: 'tab_id_mismatch' };
    }
    if (options.expectedInventoryVersion && entity.inventoryVersion && Number(options.expectedInventoryVersion) !== Number(entity.inventoryVersion)) {
      return { ok: false, reason: 'stale_inventory_version' };
    }
    const el = entity.element || entity.clickTarget || null;
    if (el && el.isConnected === false) {
      return { ok: false, reason: 'detached_element' };
    }
    if (entity.enabled === false || (el && (el.disabled || (typeof el.getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true')))) {
      return { ok: false, reason: 'disabled_element' };
    }
    if (options.expectLabel) {
      const want = cleanText(options.expectLabel).toLowerCase();
      const got = cleanText(entity.label || entity.accessibleName || (el && (el.innerText || el.textContent)) || '').toLowerCase();
      if (want && got && !got.includes(want) && !want.includes(got)) {
        return { ok: false, reason: 'label_identity_mismatch', expected: want, actual: got };
      }
    }
    return { ok: true, reason: 'validated', element: el };
  }

  return {
    AGENT_STATES,
    VALID_TRANSITIONS,
    SleepwalkerAgentStateMachine,
    SleepwalkerFastPathRouter,
    SleepwalkerWaitManager,
    SleepwalkerActionVerifier,
    SleepwalkerCandidateOverlay,
    validateTargetBinding,
    isSleepwalkerUiNode,
    normalizeExplicitUrl
  };
});
