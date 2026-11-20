/**
 * Sleepwalker - diagnostics.js
 * Lightweight, privacy-safe internal diagnostics & latency telemetry engine.
 *
 * Captures:
 * - Voice recognition lifecycle transitions & why recognition stopped/failed
 * - Intent classification routing & fallbacks
 * - Memory retrieval scores, vector model used, and reasons
 * - Navigation success/failure & orb restoration outcomes
 * - LLM provider latencies, HTTP 404 model skips, rate limits & timeouts
 * - Stage-by-stage timing breakdown (ms)
 *
 * Privacy guarantee: strictly scrubs passwords, OTPs, cards, Aadhaar, PAN, tokens, and URL query strings.
 */
(function (rootScope) {
  'use strict';

  const MAX_EVENTS = 80;
  const MAX_TRACES = 40;

  const SENSITIVE_RE = /\b(?:password|passwd|passcode|pin|cvv|cvc|otp|one[- ]time[- ]password|secret|api[-_ ]?key|token|bearer|authorization|aadhaar|aadhar|pan)\b/i;

  function scrubText(input, maxLen = 160) {
    let s = String(input || '').trim();
    if (!s) return '';
    if (SENSITIVE_RE.test(s)) {
      s = s
        .replace(/\bbearer\s+\S+/gi, '[REDACTED]')
        .replace(/\b(?:password|passwd|passcode|pin|cvv|cvc|otp|token|secret|api[-_ ]?key)\b(?:\s*(?:is|=|:)\s*|\s+)\S+/gi, '[REDACTED]');
    }
    s = s
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?\b/g, '[REDACTED_JWT]')
      .replace(/\b(?:sk|pk|ghp|gho|ghu|ghs)[_-][0-9A-Za-z_-]{16,}\b/g, '[REDACTED_KEY]')
      .replace(/\bauth_tokens\/[0-9A-Za-z_-]+\b/g, 'auth_tokens/[REDACTED]')
      .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_CARD]')
      .replace(/\b\d{4}\s+\d{4}\s+\d{4}\b/g, '[REDACTED_ID]')
      .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[REDACTED_PAN]')
      .replace(/([?&](?:key|access_token|token|auth|secret|password|otp|code|session)=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/https?:\/\/[^\s?#]+\?[^\s]*/gi, (m) => m.split('?')[0] + '?[qs]');
    return s.slice(0, maxLen);
  }

  function scrubObject(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') return scrubText(val, 160);
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    if (Array.isArray(val)) return val.slice(0, 8).map(scrubObject);
    if (typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        if (SENSITIVE_RE.test(k)) {
          out[k] = '[REDACTED]';
        } else {
          out[k] = scrubObject(v);
        }
      }
      return out;
    }
    return undefined;
  }

  class SleepwalkerDiagnostics {
    constructor() {
      this.events = [];
      this.traces = [];
      this.worldModelTraces = [];
      this.connectionStates = {
        geminiRest: { state: 'disconnected', detail: 'Not tested yet', ts: 0 },
        geminiLiveWs: { state: 'disconnected', detail: 'Idle', ts: 0 },
        ollama: { state: 'disconnected', detail: 'Not checked yet', ts: 0 },
        embeddings: { state: 'disconnected', detail: 'Not checked yet', ts: 0 },
        voice: { state: 'disconnected', detail: 'Idle', ts: 0 },
        navigation: { state: 'disconnected', detail: 'Ready', ts: 0 }
      };
      this.counters = {
        voiceStops: 0,
        voiceErrors: 0,
        voiceRecoveries: 0,
        duplicatesBlocked: 0,
        intentRuleHits: 0,
        intentLlmCalls: 0,
        memoryRetrievals: 0,
        navigationFailures: 0,
        orbRestorations: 0,
        llmTimeouts: 0,
        llmFallbacks: 0
      };
    }

    log(category, code, meta = {}) {
      const entry = {
        ts: Date.now(),
        iso: new Date().toISOString(),
        category: String(category || 'general'),
        code: String(code || 'event'),
        lifecycleState: meta.lifecycleState ? String(meta.lifecycleState) : undefined,
        durationMs: typeof meta.durationMs === 'number' ? Math.round(meta.durationMs * 100) / 100 : undefined,
        errorCategory: meta.errorCategory ? scrubText(meta.errorCategory, 60) : undefined,
        meta: scrubObject(meta)
      };

      this.events.push(entry);
      if (this.events.length > MAX_EVENTS) {
        this.events.shift();
      }

      if (category === 'voice') {
        if (code === 'stopped') this.counters.voiceStops += 1;
        else if (code === 'error' || code === 'not_recognized') this.counters.voiceErrors += 1;
        else if (code === 'recovered') this.counters.voiceRecoveries += 1;
        else if (code === 'duplicate_blocked') this.counters.duplicatesBlocked += 1;
      } else if (category === 'intent') {
        if (meta.source === 'rules' || meta.source === 'deterministic') this.counters.intentRuleHits += 1;
        else if (meta.source === 'llm') this.counters.intentLlmCalls += 1;
      } else if (category === 'memory' && code === 'retrieved') {
        this.counters.memoryRetrievals += 1;
      } else if (category === 'navigation' && (code === 'failed' || code === 'not_found')) {
        this.counters.navigationFailures += 1;
      } else if (category === 'orb' && code === 'restored') {
        this.counters.orbRestorations += 1;
      } else if (category === 'llm') {
        if (code === 'timeout') this.counters.llmTimeouts += 1;
        else if (code === 'fallback') this.counters.llmFallbacks += 1;
      }

      return entry;
    }

    recordTurnTrace(trace = {}) {
      const clean = {
        ts: Date.now(),
        cmdId: scrubText(trace.cmdId || '', 40),
        intent: scrubText(trace.intent || '', 40),
        centralCategory: scrubText(trace.centralCategory || '', 40),
        voiceRecognitionMs: Number(trace.voiceRecognitionMs || 0),
        transcriptMs: Number(trace.transcriptMs || 0),
        corefMs: Number(trace.corefMs || 0),
        intentMs: Number(trace.intentMs || 0),
        memoryMs: Number(trace.memoryMs || 0),
        llmMs: Number(trace.llmMs || 0),
        navigationMs: Number(trace.navigationMs || 0),
        restorationMs: Number(trace.restorationMs || 0),
        totalMs: Number(trace.totalMs || 0),
        usedLlm: Boolean(trace.usedLlm),
        status: scrubText(trace.status || 'ok', 40)
      };
      this.traces.push(clean);
      if (this.traces.length > MAX_TRACES) {
        this.traces.shift();
      }
      return clean;
    }

    /**
     * Phase 4.3 Development World Model Pipeline Trace Inspector (Section 18).
     * Captures stage-by-stage World Model -> Retrieval -> Ollama -> Plan -> Validation -> Execution -> Verification trace.
     */
    recordWorldModelTrace(trace = {}) {
      const clean = {
        ts: Date.now(),
        iso: new Date().toISOString(),
        requestId: scrubText(trace.requestId || '', 48),
        sessionId: scrubText(trace.sessionId || '', 48),
        speech: scrubText(trace.speech || '', 160),
        tabId: scrubText(String(trace.tabId || 'default'), 32),
        url: scrubText(trace.url || '', 140),
        pageType: scrubText(trace.pageType || 'general', 32),
        discoveryMode: scrubText(trace.discoveryMode || 'static_content', 32),
        inventoryVersion: Number(trace.inventoryVersion || 0),
        candidateCount: Number(trace.candidateCount || 0),
        contextSentTokens: Number(trace.contextSentTokens || 0),
        contextTruncated: Boolean(trace.contextTruncated),
        memoriesRetrieved: Array.isArray(trace.memoriesRetrieved) ? trace.memoriesRetrieved.slice(0, 4).map((m) => scrubText(m, 80)) : [],
        semanticMatches: Array.isArray(trace.semanticMatches) ? trace.semanticMatches.slice(0, 5).map((m) => scrubText(m, 80)) : [],
        ollamaStatus: scrubText(trace.ollamaStatus || 'skipped', 40),
        ollamaHttpStatus: Number(trace.ollamaHttpStatus || 0),
        ollamaUsed: Boolean(trace.ollamaUsed),
        embedStatus: scrubText(trace.embedStatus || 'untested', 40),
        embedModel: scrubText(trace.embedModel || '', 40),
        usedFallbackPlanner: Boolean(trace.usedFallbackPlanner),
        ollamaErrorDetail: scrubText(trace.ollamaErrorDetail || '', 140),
        ollamaLatencyMs: Number(trace.ollamaLatencyMs || 0),
        ollamaResponse: scrubText(trace.ollamaResponse || '', 180),
        structuredAction: scrubObject(trace.structuredAction || null),
        candidateValidation: scrubText(trace.candidateValidation || 'ok', 80),
        browserExecution: scrubText(trace.browserExecution || '', 100),
        verificationResult: scrubText(trace.verificationResult || '', 100),
        failureStage: trace.failureStage ? scrubText(trace.failureStage, 60) : 'none',
        recovered: Boolean(trace.recovered),
        timingMs: scrubObject(trace.timingMs || null)
      };
      this.worldModelTraces.push(clean);
      if (this.worldModelTraces.length > 25) {
        this.worldModelTraces.shift();
      }
      return clean;
    }

    getPerformanceSummary() {
      if (this.traces.length === 0) {
        return { count: 0, avgTotalMs: 0, avgIntentMs: 0, avgMemoryMs: 0, avgCorefMs: 0, deterministicPct: 100 };
      }
      const n = this.traces.length;
      const sum = (k) => this.traces.reduce((acc, t) => acc + (Number(t[k]) || 0), 0);
      const detCount = this.traces.filter((t) => !t.usedLlm).length;
      return {
        count: n,
        avgTotalMs: Math.round((sum('totalMs') / n) * 100) / 100,
        avgTranscriptMs: Math.round((sum('transcriptMs') / n) * 100) / 100,
        avgCorefMs: Math.round((sum('corefMs') / n) * 100) / 100,
        avgIntentMs: Math.round((sum('intentMs') / n) * 100) / 100,
        avgMemoryMs: Math.round((sum('memoryMs') / n) * 100) / 100,
        avgLlmMs: Math.round((sum('llmMs') / n) * 100) / 100,
        avgNavigationMs: Math.round((sum('navigationMs') / n) * 100) / 100,
        deterministicPct: Math.round((detCount / n) * 100)
      };
    }

    setConnectionStatus(component, state = 'disconnected', detail = '') {
      const key = String(component || '').trim();
      if (!key) return null;
      const normalized = new Set(['connected', 'connecting', 'disconnected', 'reconnecting', 'unavailable']).has(state)
        ? state
        : 'disconnected';
      this.connectionStates[key] = {
        state: normalized,
        detail: scrubText(detail || '', 120),
        ts: Date.now(),
        iso: new Date().toISOString()
      };
      return this.connectionStates[key];
    }

    getReport() {
      return {
        counters: { ...this.counters },
        perf: this.getPerformanceSummary(),
        connectionStates: { ...this.connectionStates },
        recentEvents: this.events.slice(-25),
        recentTraces: this.traces.slice(-15),
        worldModelTraces: this.worldModelTraces.slice(-15)
      };
    }

    clear() {
      this.events = [];
      this.traces = [];
      this.worldModelTraces = [];
    }
  }

  const shared = new SleepwalkerDiagnostics();

  if (rootScope && typeof rootScope === 'object') {
    rootScope.SleepwalkerDiagnostics = shared;
    rootScope.SleepwalkerDiagnosticsClass = SleepwalkerDiagnostics;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SleepwalkerDiagnostics, diagnostics: shared, scrubText, scrubObject };
  }
})(typeof window !== 'undefined' ? window : globalThis);
