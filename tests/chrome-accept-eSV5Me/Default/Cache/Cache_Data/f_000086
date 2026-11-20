/**
 * Sleepwalker - confirm.js
 * Shared risk-based confirmation and multi-step plan controller.
 *
 * Risk policy:
 * - low:      read, explain, scroll -> runs immediately (0 confirms)
 * - medium:   click, fill -> confirms ONLY if confidence < 0.8 or ambiguous
 * - high:     navigate away, upload, download, destructive actions -> 1 explicit confirm
 * - critical: submit, payment -> summary + double confirm (2 confirms)
 */

(function (rootScope) {
  'use strict';

  const RISK_LEVELS = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high',
    CRITICAL: 'critical'
  };

  const PERMISSION_TIERS = {
    LOW: 'low',
    MODERATE: 'moderate',
    HIGH_RISK: 'high_risk'
  };

  const HIGH_RISK_ACTION_RE = /\b(?:pay|payment|purchase|buy|checkout|book|booking|reserve|apply|application|submit|send[-_\s]?message|send[-_\s]?email|publish|post|delete|remove|account[-_\s]?change|deactivate|password)\b/i;
  const MODERATE_ACTION_RE = /\b(?:fill|dictate|filter|setting|change[-_\s]?setting|external[-_\s]?url|open[-_\s]?external|open[-_\s]?website|navigate[-_\s]?away|download|upload)\b/i;

  const MAX_PLAN_STEPS = 5;
  const DEFAULT_TIMEOUT_MS = 20000;

  const DEVANAGARI_DIGITS = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
  };

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Space/punctuation-safe boundary helpers so Devanagari words never rely on ASCII \b
  function hasTokenPhrase(haystack, phrase) {
    if (!haystack || !phrase) return false;
    const re = new RegExp(`(?:^|[\\s,.;!?।|])${escapeRegExp(phrase)}(?=$|[\\s,.;!?।|])`, 'i');
    return re.test(haystack);
  }

  function startsWithTokenPhrase(haystack, phrase) {
    if (!haystack || !phrase) return false;
    const re = new RegExp(`^${escapeRegExp(phrase)}(?=$|[\\s,.;!?।|])`, 'i');
    return re.test(haystack);
  }

  const YES_PATTERNS = [
    'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'confirm', 'approved',
    'go ahead', 'proceed', 'do it', 'sure',
    'haan', 'haa', 'han', 'hanji', 'haanji', 'theek hai', 'thik hai',
    'kar do', 'haan kar do', 'ji haan', 'bilkul', 'sahi hai',
    'हां', 'हाँ', 'ठीक है', 'कर दो', 'जी हां', 'जी हाँ', 'हाँ कर दो', 'हां कर दो', 'हाँ ठीक है', 'सही है', 'बिल्कुल', 'आगे बढ़ो'
  ];

  const NO_PATTERNS = [
    'no', 'nope', 'nah', 'cancel', 'abort', 'decline', 'reject', 'deny',
    'stop', 'stop it', 'never mind', "don't", 'do not',
    'nahi', 'nhi', 'nahin', 'mat karo', 'rehne do', 'ruko', 'band karo',
    'नहीं', 'मत करो', 'रहने दो', 'नहीं रहने दो', 'नहीं मत करो', 'रुको', 'रोको', 'बंद करो', 'कैंसल', 'रद्द करो'
  ];

  const NO_PREFIX_WORDS = [
    'no', 'nope', 'nah', 'nahi', 'nhi', 'nahin', 'mat karo', 'rehne do',
    'cancel', 'abort', 'ruko', 'stop', "don't", 'do not',
    'नहीं', 'मत करो', 'रहने दो', 'रुको', 'रोको', 'कैंसल', 'रद्द करो', 'रद्द', 'बंद करो'
  ];

  const NO_CONTAINED_PHRASES = [
    'nahi', 'mat karo', 'rehne do', 'cancel',
    'नहीं', 'मत करो', 'रहने दो', 'रद्द करो'
  ];

  const YES_PREFIX_WORDS = [
    'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'haan', 'haa', 'han', 'theek',
    'kar do', 'confirm', 'proceed', 'sure', 'bilkul',
    'हां', 'हाँ', 'ठीक', 'कर दो', 'जी हां', 'जी हाँ', 'बिल्कुल'
  ];

  const YES_CONTAINED_PHRASES = [
    'haan', 'theek hai', 'kar do',
    'हां', 'हाँ', 'ठीक है', 'कर दो'
  ];

  class SleepwalkerConfirm {
    constructor(options = {}) {
      this.defaultTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
      this.pending = null;
      this.plan = null;
      this._timerId = null;
      this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    }

    /**
     * Decide how many confirmation prompts are needed for a risk level.
     * @returns {number} 0 = auto, 1 = explicit confirm, 2 = summary + double confirm
     */
    getRequiredConfirmSteps({ risk = 'low', confidence = 1.0, ambiguous = false } = {}) {
      switch (risk) {
        case RISK_LEVELS.CRITICAL:
          return 2;
        case RISK_LEVELS.HIGH:
          return 1;
        case RISK_LEVELS.MEDIUM:
          return (ambiguous || confidence < 0.8) ? 1 : 0;
        case RISK_LEVELS.LOW:
        default:
          return 0;
      }
    }

    requiresConfirmation(params) {
      return this.getRequiredConfirmSteps(params) > 0;
    }

    /**
     * Three-tier Action Permission Policy (Low / Moderate / High-Risk).
     * High-risk actions ALWAYS require explicit confirmation; moderate actions ask unless clearly covered by user's request.
     */
    classifyPermissionTier({ action = '', label = '', risk = '', userAuthorized = false, ambiguous = false, confidence = 1.0 } = {}) {
      const fingerprint = `${action} ${label}`.trim();
      if (risk === RISK_LEVELS.CRITICAL || HIGH_RISK_ACTION_RE.test(fingerprint)) {
        return { tier: PERMISSION_TIERS.HIGH_RISK, risk: RISK_LEVELS.CRITICAL, requiredSteps: 2, requiresConfirm: true };
      }
      if (risk === RISK_LEVELS.HIGH || risk === RISK_LEVELS.MEDIUM || MODERATE_ACTION_RE.test(fingerprint)) {
        const effectiveRisk = (risk === RISK_LEVELS.HIGH || (MODERATE_ACTION_RE.test(fingerprint) && !userAuthorized))
          ? RISK_LEVELS.HIGH
          : RISK_LEVELS.MEDIUM;
        const steps = this.getRequiredConfirmSteps({ risk: effectiveRisk, confidence, ambiguous });
        return { tier: PERMISSION_TIERS.MODERATE, risk: effectiveRisk, requiredSteps: steps, requiresConfirm: steps > 0 };
      }
      return { tier: PERMISSION_TIERS.LOW, risk: RISK_LEVELS.LOW, requiredSteps: 0, requiresConfirm: false };
    }

    isAwaiting() {
      return Boolean(this.pending);
    }

    isPlanActive() {
      return Boolean(this.plan && this.plan.status !== 'done' && this.plan.status !== 'cancelled');
    }

    /**
     * Standalone EN / HI / Hinglish yes/no matcher (works even without intent engine).
     * @returns {'yes'|'no'|null}
     */
    parseYesNo(rawText) {
      if (!rawText || typeof rawText !== 'string') return null;
      const clean = rawText
        .normalize('NFC')
        .replace(/(?<=[a-zA-Z])’(?=[a-zA-Z])/g, "'")
        .toLowerCase()
        .trim()
        .replace(/^[|"“”‘’']+/, '')
        .replace(/[।.,!?|"“”‘’]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) return null;

      if (NO_PATTERNS.includes(clean)) return 'no';
      if (YES_PATTERNS.includes(clean)) return 'yes';

      // Check negation first so mixed phrases like "theek nahi hai" or "नहीं यार मत करो" deny safely
      if (NO_PREFIX_WORDS.some((p) => startsWithTokenPhrase(clean, p)) || NO_CONTAINED_PHRASES.some((p) => hasTokenPhrase(clean, p))) {
        return 'no';
      }
      if (YES_PREFIX_WORDS.some((p) => startsWithTokenPhrase(clean, p)) || YES_CONTAINED_PHRASES.some((p) => hasTokenPhrase(clean, p))) {
        return 'yes';
      }

      return null;
    }

    /**
     * Request confirmation (or run immediately if risk policy requires 0 steps).
     * @param {Object} opts
     * @returns {{ awaiting: boolean, executed: boolean, requiredSteps: number }}
     */
    request(opts) {
      const {
        id = `confirm_${Date.now()}`,
        risk = RISK_LEVELS.LOW,
        confidence = 1.0,
        ambiguous = false,
        title = 'Confirm action',
        message = '',
        summary = [],
        options = null,
        timeoutMs = this.defaultTimeoutMs,
        onConfirm = null,
        onCancel = null
      } = opts || {};

      const requiredSteps = this.getRequiredConfirmSteps({ risk, confidence, ambiguous });
      if (requiredSteps === 0) {
        if (typeof onConfirm === 'function') {
          onConfirm({ autoApproved: true });
        }
        return { awaiting: false, executed: true, requiredSteps: 0 };
      }

      // Cancel any stale pending confirmation before creating a new one
      if (this.pending) {
        this.cancel('replaced');
      }

      this.pending = {
        id,
        risk,
        confidence,
        ambiguous,
        title,
        message,
        summary: Array.isArray(summary) ? summary.filter(Boolean) : [],
        options: Array.isArray(options) ? options.slice(0, 5) : null,
        step: 1,
        requiredSteps,
        timeoutMs,
        createdAt: Date.now(),
        onConfirm,
        onCancel
      };

      this._startTimer(timeoutMs);
      this._emitChange();
      return { awaiting: true, executed: false, requiredSteps };
    }

    /**
     * Advance or execute the pending confirmation.
     * For critical actions, step 1 moves to step 2 (double confirm) before executing.
     */
    confirm(choiceIndex = null) {
      if (!this.pending) return { status: 'none' };

      const current = this.pending;
      if (
        choiceIndex !== null &&
        choiceIndex !== undefined &&
        current.options &&
        choiceIndex >= 0 &&
        choiceIndex < current.options.length
      ) {
        current.selectedOption = current.options[choiceIndex];
      }

      if (current.step < current.requiredSteps) {
        current.step += 1;
        this._startTimer(current.timeoutMs);
        this._emitChange();
        return { status: 'awaiting_second_confirm', step: current.step, requiredSteps: current.requiredSteps };
      }

      this._clearTimer();
      this.pending = null;
      this._emitChange();

      if (typeof current.onConfirm === 'function') {
        current.onConfirm({
          autoApproved: false,
          selectedOption: current.selectedOption || null,
          stepCount: current.requiredSteps
        });
      }
      return { status: 'confirmed', stepCount: current.requiredSteps };
    }

    /**
     * Cancel the pending confirmation cleanly.
     */
    cancel(reason = 'user_cancelled') {
      if (!this.pending) return { status: 'none' };

      const cancelled = this.pending;
      this._clearTimer();
      this.pending = null;
      this._emitChange();

      if (typeof cancelled.onCancel === 'function') {
        cancelled.onCancel(reason, cancelled);
      }
      return { status: 'cancelled', reason };
    }

    _parseOptionIndex(rawText) {
      if (!rawText || typeof rawText !== 'string') return -1;
      const normalized = rawText
        .normalize('NFC')
        .replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] || d)
        .toLowerCase()
        .trim()
        .replace(/[।.,!?]+$/g, '')
        .trim();

      const numMatch = normalized.match(/^(?:(?:option|choice|number|no\.?|विकल्प|ऑप्शन)\s*)?([1-9]|10)$/i);
      if (numMatch) return parseInt(numMatch[1], 10) - 1;

      const wordMap = {
        one: 0, first: 0, ek: 0, pehla: 0, 'एक': 0, 'पहला': 0,
        two: 1, second: 1, do: 1, doosra: 1, dusra: 1, 'दो': 1, 'दूसरा': 1,
        three: 2, third: 2, teen: 2, teesra: 2, 'तीन': 2, 'तीसरा': 2,
        four: 3, fourth: 3, char: 3, chaar: 3, chautha: 3, 'चार': 3, 'चौथा': 3,
        five: 4, fifth: 4, paanch: 4, panch: 4, paanchva: 4, 'पांच': 4, 'पाँच': 4
      };
      const stripped = normalized.replace(/^(?:option|choice|number|no\.?|विकल्प|ऑप्शन)\s+/, '');
      if (Object.prototype.hasOwnProperty.call(wordMap, stripped)) return wordMap[stripped];
      let matchApi = (typeof globalThis !== 'undefined' && globalThis.SleepwalkerMatch) || null;
      if (!matchApi && typeof require === 'function') {
        try {
          matchApi = require('./match.js');
        } catch (_e) {}
      }
      const n = matchApi ? matchApi.parseOrdinalChoice(rawText, 10) : null;
      if (n) return n - 1;

      // Also match candidate by name during numbered disambiguation ("number 2", "dusra", or the name)
      if (this.pending && Array.isArray(this.pending.options) && this.pending.options.length > 0) {
        let bestIdx = -1;
        let bestScore = 0;
        let runnerScore = 0;
        for (let i = 0; i < this.pending.options.length; i++) {
          const optLabel = typeof this.pending.options[i] === 'string'
            ? this.pending.options[i]
            : (this.pending.options[i] && this.pending.options[i].label) || '';
          if (!optLabel) continue;
          let s = 0;
          if (matchApi && typeof matchApi.scoreTarget === 'function') {
            s = matchApi.scoreTarget({ label: optLabel }, { target: rawText, action: 'CLICK' }).score;
          } else {
            const normOpt = optLabel.toLowerCase().trim();
            if (normOpt === normalized) s = 1.0;
            else if (normalized.length >= 3 && normOpt.includes(normalized)) s = 0.8;
          }
          if (s > bestScore) {
            runnerScore = bestScore;
            bestScore = s;
            bestIdx = i;
          } else if (s > runnerScore) {
            runnerScore = s;
          }
        }
        if (bestIdx >= 0 && (bestScore >= 0.75 || (bestScore >= 0.55 && bestScore - runnerScore >= 0.15))) {
          return bestIdx;
        }
      }
      return -1;
    }

    /**
     * Route a classified intent or spoken phrase to the active confirmation.
     * @returns {{ handled: boolean, result?: Object }}
     */
    handleResponse(intentOrText) {
      if (!this.pending) return { handled: false };

      let rawText = '';
      if (intentOrText && typeof intentOrText === 'object') {
        if (
          intentOrText.intent === 'NAVIGATE' &&
          intentOrText.args &&
          (intentOrText.args.action === 'choose_ordinal' || intentOrText.args.action === 'choose_link')
        ) {
          if (intentOrText.args.chooseMode === 'other') {
            if (this.pending.options && this.pending.options.length > 1) {
              return { handled: true, result: this.confirm(1) };
            }
            this.cancel('replaced');
            return { handled: true, result: { status: 'switch_other' } };
          }
          if (this.pending.options) {
            const idx = Number(intentOrText.args.choice) - 1;
            if (idx >= 0 && idx < this.pending.options.length) {
              return { handled: true, result: this.confirm(idx) };
            }
          }
        }
        if (intentOrText.intent === 'CONFIRM_YES') {
          return { handled: true, result: this.confirm() };
        }
        if (
          intentOrText.intent === 'CONFIRM_NO' ||
          (intentOrText.intent === 'CONTROL' && intentOrText.args && intentOrText.args.action === 'stop')
        ) {
          return { handled: true, result: this.cancel('user_denied') };
        }
        rawText = typeof intentOrText.raw === 'string'
          ? intentOrText.raw
          : (typeof intentOrText.normalized === 'string' ? intentOrText.normalized : '');
      } else {
        rawText = String(intentOrText || '');
      }

      // Check "no, the other one" / "other one" BEFORE parseYesNo ("no") cancels everything
      if (/\b(?:other\s+one|doosra\s+wala|dusra\s+wala)\b/i.test(rawText) || /(?:दूसरा\s+वाला|कोई\s+और)/.test(rawText)) {
        if (this.pending.options && this.pending.options.length > 1) {
          return { handled: true, result: this.confirm(1) };
        }
        this.cancel('replaced');
        return { handled: true, result: { status: 'switch_other' } };
      }

      const yn = this.parseYesNo(rawText);
      if (yn === 'yes') return { handled: true, result: this.confirm() };
      if (yn === 'no') return { handled: true, result: this.cancel('user_denied') };

      // Pick numbered or named option if pending has disambiguation choices
      if (this.pending.options) {
        const idx = this._parseOptionIndex(rawText);
        if (idx >= 0 && idx < this.pending.options.length) {
          return { handled: true, result: this.confirm(idx) };
        }
      }

      return { handled: false };
    }

    /**
     * Multi-step plan stepper (capped at 5 steps).
     */
    startPlan({ title = 'Guided Plan', steps = [], initialStepIndex = 0, onExecuteStep, onComplete, onCancel }) {
      const cappedSteps = Array.isArray(steps) ? steps.slice(0, MAX_PLAN_STEPS) : [];
      if (cappedSteps.length === 0) return null;

      // Clear any previous active plan or pending confirm before creating the new plan
      if (this.isPlanActive()) {
        this.cancelPlan('replaced');
      } else if (this.pending) {
        this.cancel('replaced');
      }

      const startIdx = Math.max(0, Math.min(Number(initialStepIndex) || 0, cappedSteps.length - 1));

      this.plan = {
        title,
        steps: cappedSteps.map((s, idx) => ({
          index: idx,
          label: typeof s === 'string' ? s : (s.label || `Step ${idx + 1}`),
          risk: typeof s === 'object' && s.risk ? s.risk : RISK_LEVELS.MEDIUM,
          confidence: typeof s === 'object' && typeof s.confidence === 'number' ? s.confidence : 0.75,
          payload: typeof s === 'object' ? s : { label: s },
          status: idx < startIdx ? 'done' : (idx === startIdx ? 'active' : 'pending')
        })),
        currentIndex: startIdx,
        status: 'running',
        question: null,
        onExecuteStep: typeof onExecuteStep === 'function' ? onExecuteStep : null,
        onComplete: typeof onComplete === 'function' ? onComplete : null,
        onCancel: typeof onCancel === 'function' ? onCancel : null
      };

      this._emitChange();
      this._promptCurrentPlanStep();
      return this.plan;
    }

    pausePlanWithQuestion(questionText) {
      if (!this.plan) return;
      this.plan.status = 'awaiting_answer';
      this.plan.question = questionText;
      this._emitChange();
    }

    advancePlanStep() {
      if (!this.plan || this.plan.status === 'cancelled' || this.plan.status === 'done') return null;

      const idx = this.plan.currentIndex;
      if (this.plan.steps[idx]) {
        this.plan.steps[idx].status = 'done';
      }

      const next = idx + 1;
      if (next >= this.plan.steps.length) {
        this.plan.status = 'done';
        this.plan.question = null;
        this._emitChange();
        if (this.plan.onComplete) {
          this.plan.onComplete(this.plan);
        }
        return this.plan;
      }

      this.plan.currentIndex = next;
      this.plan.steps[next].status = 'active';
      this.plan.status = 'running';
      this.plan.question = null;
      this._emitChange();
      this._promptCurrentPlanStep();
      return this.plan;
    }

    cancelPlan(reason = 'user_cancelled') {
      if (!this.plan || this.plan.status === 'cancelled' || this.plan.status === 'done') return;

      const cancelledPlan = this.plan;
      cancelledPlan.status = 'cancelled';
      const handler = cancelledPlan.onCancel;

      if (this.pending && this.pending.id && this.pending.id.startsWith('plan_step_')) {
        this._clearTimer();
        this.pending = null;
      }

      this._emitChange();
      if (handler) handler(reason, cancelledPlan);
    }

    clearPlan() {
      this.plan = null;
      this._emitChange();
    }

    _promptCurrentPlanStep() {
      if (!this.plan || this.plan.status !== 'running') return;
      const step = this.plan.steps[this.plan.currentIndex];
      if (!step) return;

      this.request({
        id: `plan_step_${step.index}`,
        risk: step.risk,
        confidence: step.confidence,
        title: `Step ${step.index + 1} of ${this.plan.steps.length}`,
        message: step.label,
        summary: step.risk === RISK_LEVELS.CRITICAL ? [`Action: ${step.label}`] : [],
        onConfirm: () => {
          if (this.plan && this.plan.onExecuteStep) {
            Promise.resolve(this.plan.onExecuteStep(step, this.plan)).then((shouldAutoAdvance) => {
              if (shouldAutoAdvance !== false && this.plan && this.plan.status === 'running') {
                this.advancePlanStep();
              }
            });
          } else {
            this.advancePlanStep();
          }
        },
        onCancel: (reason) => {
          this.cancelPlan(reason);
        }
      });
    }

    _startTimer(ms) {
      this._clearTimer();
      const timeout = Number.isFinite(ms) && ms > 0 ? ms : this.defaultTimeoutMs;
      this._timerId = setTimeout(() => {
        if (this.pending) {
          this.cancel('timeout');
        }
      }, timeout);
    }

    _clearTimer() {
      if (this._timerId) {
        clearTimeout(this._timerId);
        this._timerId = null;
      }
    }

    _emitChange() {
      if (this.onChange) {
        this.onChange({
          pending: this.pending,
          plan: this.plan
        });
      }
    }
  }

  SleepwalkerConfirm.RISK_LEVELS = RISK_LEVELS;
  SleepwalkerConfirm.PERMISSION_TIERS = PERMISSION_TIERS;
  SleepwalkerConfirm.MAX_PLAN_STEPS = MAX_PLAN_STEPS;

  rootScope.SleepwalkerConfirm = SleepwalkerConfirm;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SleepwalkerConfirm;
  }
})(typeof window !== 'undefined' ? window : globalThis);
