/**
 * Sleepwalker - ai-comm.js
 * Unified Real-Time AI Communication Manager, Progressive Stream Parser & Content-Script Port Client.
 *
 * Responsibilities:
 * 1. IncrementalExplainStreamParser: safely extracts progressive `answer` text from streamed JSON
 *    or plain-text responses without ever emitting broken JSON syntax or unclosed escapes to UI/TTS,
 *    and detects sentence boundaries for low-latency incremental speech output.
 * 2. SleepwalkerAiCommManager (MV3 Service Worker / Node): centralized connection lifecycle,
 *    Gemini Live WS <-> Gemini SSE <-> Cloud Proxy <-> Ollama NDJSON <-> REST/offline routing,
 *    per-session epoch & stale-response protection, request deduplication, interruption/cancellation,
 *    retry/circuit-breaker backoff, and latency telemetry.
 * 3. SleepwalkerStreamClient (Content Scripts): long-lived `chrome.runtime.connect('sw-ai-stream')`
 *    client with port auto-reopen, immediate cancellation frames, and `sendMessage` fallback.
 */
(function (root) {
  'use strict';

  /** Clean markdown symbols for natural speech and crisp card rendering. */
  function stripMarkdownLight(text) {
    return String(text || '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/^\s*[-*•+]\s+/gm, '')
      .replace(/[ \t]{2,}/g, ' ');
  }

  /**
   * Detect newly completed sentences in accumulated answer text starting from `fromIdx`.
   * Avoids splitting decimals (`3.5`), common abbreviations (`Dr.`, `St.`, `Mr.`, `e.g.`), or short acronyms.
   */
  function extractCompletedSentences(fullText, fromIdx = 0) {
    const src = String(fullText || '');
    const out = [];
    let cursor = Math.max(0, fromIdx);
    const re = /([.!?।])(?:\s+|$)/g;
    re.lastIndex = cursor;

    let match;
    while ((match = re.exec(src)) !== null) {
      const endPos = match.index + 1;
      const chunk = src.slice(cursor, endPos).trim();
      const chBefore = match.index > 0 ? src[match.index - 1] : '';
      const nextCh = src[endPos] || '';

      // Skip decimal numbers (e.g., "3.5") or no trailing space unless end-of-chunk looks complete
      if (match[1] === '.' && /\d/.test(chBefore) && /\d/.test(nextCh)) continue;

      const tailWord = chunk.match(/([A-Za-z]+)\.$/);
      if (tailWord && /^(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|eg|ie|No|Fig|Rs)$/i.test(tailWord[1])) continue;

      if (chunk.length >= 12) {
        out.push(chunk);
        cursor = re.lastIndex;
      }
    }
    return { sentences: out, nextCursor: cursor };
  }

  /**
   * Streaming-safe progressive extractor for Sleepwalker EXPLAIN responses.
   * Models prompt-instructed to return `{ "answer": "...", "highlightSections": [...] }` emit JSON tokens
   * incrementally; this parser decodes ONLY complete characters inside `"answer"` while buffering incomplete
   * JSON prefixes/escapes, or cleanly streams plain text when the model responds without JSON.
   */
  class IncrementalExplainStreamParser {
    constructor() {
      this.rawBuffer = '';
      this.mode = 'detecting'; // detecting | json_seek | json_in_answer | json_after_answer | plain
      this._scanIdx = 0;
      this._braceDepth = 0;
      this._bracketDepth = 0;
      this._jsonEscape = false;
      this._unicodeBuf = null;
      this._inStringKey = false;
      this._inValueString = false;
      this._keyStart = -1;
      this._foundAnswerKey = false;
      this._expectingColon = false;
      this._expectingAnswerQuote = false;
      this.answerText = '';
      this._emittedLen = 0;
      this._spokenCursor = 0;
    }

    push(chunk) {
      if (chunk === undefined || chunk === null) {
        return { answerDelta: '', fullAnswer: this.answerText, completedSentences: [] };
      }
      const str = String(chunk);
      if (!str) return { answerDelta: '', fullAnswer: this.answerText, completedSentences: [] };

      this.rawBuffer += str;
      this._advance();

      const answerDelta = this.answerText.slice(this._emittedLen);
      this._emittedLen = this.answerText.length;

      const { sentences, nextCursor } = extractCompletedSentences(this.answerText, this._spokenCursor);
      this._spokenCursor = nextCursor;

      return {
        answerDelta,
        fullAnswer: this.answerText,
        completedSentences: sentences
      };
    }

    _advance() {
      if (this.mode === 'plain') {
        const cleaned = stripMarkdownLight(this.rawBuffer);
        this.answerText = cleaned.trimStart();
        return;
      }

      if (this.mode === 'detecting') {
        const trimmedStart = this.rawBuffer.trimStart();
        if (!trimmedStart) return;

        // Strip optional opening markdown fence (```json or ```)
        const withoutFence = trimmedStart.replace(/^```(?:json)?\s*/i, '');
        if (trimmedStart.startsWith('```') && trimmedStart.length < 10 && !trimmedStart.includes('{')) {
          return; // wait for more chars to know if ```json\n{ follows
        }

        if (withoutFence.startsWith('{')) {
          this.mode = 'json_seek';
          const braceIdx = this.rawBuffer.indexOf('{');
          this._braceDepth = 1;
          this._scanIdx = braceIdx + 1;
        } else if (trimmedStart.length >= 1) {
          this.mode = 'plain';
          this.answerText = stripMarkdownLight(this.rawBuffer).trimStart();
          return;
        }
      }

      while (this._scanIdx < this.rawBuffer.length) {
        const ch = this.rawBuffer[this._scanIdx];

        if (this.mode === 'json_seek') {
          if (this._expectingAnswerQuote) {
            if (/\s/.test(ch)) {
              this._scanIdx += 1;
              continue;
            }
            if (ch === '"') {
              this._expectingAnswerQuote = false;
              this.mode = 'json_in_answer';
              this._scanIdx += 1;
              continue;
            }
            // Non-string value (e.g., null): fallback to seek next
            this._expectingAnswerQuote = false;
            this._foundAnswerKey = false;
          }

          if (this._expectingColon) {
            if (/\s/.test(ch)) {
              this._scanIdx += 1;
              continue;
            }
            if (ch === ':') {
              this._expectingColon = false;
              this._expectingAnswerQuote = true;
              this._scanIdx += 1;
              continue;
            }
            this._expectingColon = false;
            this._foundAnswerKey = false;
          }

          if (this._inStringKey) {
            if (this._jsonEscape) {
              this._jsonEscape = false;
              this._scanIdx += 1;
              continue;
            }
            if (ch === '\\') {
              this._jsonEscape = true;
              this._scanIdx += 1;
              continue;
            }
            if (ch === '"') {
              const keyName = this.rawBuffer.slice(this._keyStart, this._scanIdx);
              this._inStringKey = false;
              if (keyName === 'answer' && this._braceDepth === 1 && this._bracketDepth === 0) {
                this._foundAnswerKey = true;
                this._expectingColon = true;
              }
              this._scanIdx += 1;
              continue;
            }
            this._scanIdx += 1;
            continue;
          }

          if (ch === '{') this._braceDepth += 1;
          else if (ch === '}') this._braceDepth = Math.max(0, this._braceDepth - 1);
          else if (ch === '[') this._bracketDepth += 1;
          else if (ch === ']') this._bracketDepth = Math.max(0, this._bracketDepth - 1);
          else if (ch === '"') {
            this._inStringKey = true;
            this._keyStart = this._scanIdx + 1;
          }
          this._scanIdx += 1;
          continue;
        }

        if (this.mode === 'json_in_answer') {
          if (this._unicodeBuf !== null) {
            this._unicodeBuf += ch;
            this._scanIdx += 1;
            if (this._unicodeBuf.length === 4) {
              const cp = parseInt(this._unicodeBuf, 16);
              if (!Number.isNaN(cp)) this.answerText += String.fromCharCode(cp);
              this._unicodeBuf = null;
            }
            continue;
          }

          if (this._jsonEscape) {
            this._jsonEscape = false;
            this._scanIdx += 1;
            if (ch === 'u') {
              this._unicodeBuf = '';
            } else if (ch === 'n' || ch === 'r') {
              this.answerText += ' ';
            } else if (ch === 't') {
              this.answerText += ' ';
            } else if (ch === '"' || ch === '\\' || ch === '/') {
              this.answerText += ch;
            } else {
              this.answerText += ch;
            }
            continue;
          }

          if (ch === '\\') {
            this._jsonEscape = true;
            this._scanIdx += 1;
            continue;
          }

          if (ch === '"') {
            this.mode = 'json_after_answer';
            this._scanIdx += 1;
            break;
          }

          this.answerText += ch;
          this._scanIdx += 1;
          continue;
        }

        if (this.mode === 'json_after_answer') {
          break;
        }
      }
    }

    finish(parseExplainFn = null) {
      let parsedJson = null;
      const cleaned = this.rawBuffer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const s = cleaned.indexOf('{');
      const e = cleaned.lastIndexOf('}');
      if (s !== -1 && e > s) {
        try {
          const obj = JSON.parse(cleaned.slice(s, e + 1));
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsedJson = obj;
        } catch (_e) {}
      }
      if ((!parsedJson || typeof parsedJson.answer !== 'string') && typeof parseExplainFn === 'function') {
        const alt = parseExplainFn(this.rawBuffer);
        if (alt && typeof alt === 'object') {
          parsedJson = parsedJson ? { ...alt, ...parsedJson } : alt;
        }
      }

      if (parsedJson && typeof parsedJson.answer === 'string' && parsedJson.answer.trim()) {
        this.answerText = stripMarkdownLight(parsedJson.answer).trim();
      } else {
        this.answerText = stripMarkdownLight(this.answerText).trim();
      }

      const trailing = this.answerText.slice(this._spokenCursor).trim();
      const answerDelta = this.answerText.slice(this._emittedLen);
      this._emittedLen = this.answerText.length;
      this._spokenCursor = this.answerText.length;

      return {
        answerDelta,
        trailingSentence: trailing,
        fullAnswer: this.answerText,
        parsedJson
      };
    }
  }

  /**
   * Central AI Communication Manager (runs in MV3 Service Worker or Node tests).
   * Handles Live WS sessions, streaming SSE/NDJSON routing, request deduplication,
   * epoch-based stale-response cancellation, exponential-backoff reconnect, and telemetry.
   */
  class SleepwalkerAiCommManager {
    constructor(options = {}) {
      this.llm = options.llm || (typeof self !== 'undefined' && self.handleExplainRequest ? self : null);
      this.liveMod = options.liveMod || root.SleepwalkerLive || null;
      this.webSocketFactory = typeof options.webSocketFactory === 'function' ? options.webSocketFactory : null;
      this.sessions = new Map(); // sessionId -> { epoch, controllers, liveSession, lastResumptionHandle }
      this.dedupInFlight = new Map();
      this._reqSeq = 0;
      this.metricsHistory = [];
    }

    _resolveLlm() {
      if (this.llm) return this.llm;
      if (typeof require === 'function') {
        try { return require('./llm.js'); } catch (_e) {}
      }
      return typeof self !== 'undefined' ? self : root;
    }

    _getOrCreateSession(sessionId = 'default') {
      const id = String(sessionId || 'default');
      let s = this.sessions.get(id);
      if (!s) {
        s = {
          id,
          epoch: 0,
          controllers: new Map(),
          liveSession: null,
          lastResumptionHandle: ''
        };
        this.sessions.set(id, s);
      }
      return s;
    }

    /** Record bounded performance trace for latency diagnostics & comparisons. */
    _recordTrace(entry) {
      this.metricsHistory.push({ ...entry, ts: Date.now() });
      if (this.metricsHistory.length > 60) {
        this.metricsHistory = this.metricsHistory.slice(-60);
      }
    }

    getTelemetry() {
      const liveSessions = [];
      for (const [sid, s] of this.sessions.entries()) {
        if (s && s.liveSession) {
          liveSessions.push({
            sessionId: sid,
            state: typeof s.liveSession.getConnectionStatus === 'function' ? s.liveSession.getConnectionStatus() : (s.liveSession.isReady() ? 'connected' : 'disconnected'),
            model: s.liveSession.model || '',
            hasResumption: Boolean(s.lastResumptionHandle)
          });
        }
      }
      const primaryWsState = liveSessions.length > 0
        ? (liveSessions.find((x) => x.state === 'connected')?.state || liveSessions[0].state)
        : (typeof WebSocket !== 'function' ? 'unavailable' : 'disconnected');
      return {
        activeSessions: this.sessions.size,
        liveWsState: primaryWsState,
        liveSessions,
        recentTraces: this.metricsHistory.slice(-20)
      };
    }

    /**
     * Cancel all in-flight requests (or one specific reqId) for a session cleanly.
     * Bumps session epoch when cancelling the whole session so late upstream chunks are dropped.
     */
    cancelSession(sessionId = 'default', reason = 'user_cancel', targetReqId = null) {
      const t0 = Date.now();
      const s = this.sessions.get(String(sessionId || 'default'));
      if (!s) return { cancelledCount: 0, cancelLatencyMs: 0 };

      let cancelledCount = 0;
      if (!targetReqId) {
        s.epoch += 1;
      }

      for (const [reqId, rec] of Array.from(s.controllers.entries())) {
        if (targetReqId && reqId !== targetReqId) continue;
        s.controllers.delete(reqId);
        if (!rec.controller.signal.aborted) {
          rec.cancelRequestedAt = t0;
          rec.controller.abort(reason);
          cancelledCount += 1;
        }
      }

      if (s.liveSession && typeof s.liveSession.interrupt === 'function' && (!targetReqId || cancelledCount > 0)) {
        const res = s.liveSession.interrupt(reason);
        if (res && res.interrupted) cancelledCount += 1;
      }

      return { cancelledCount, cancelLatencyMs: Date.now() - t0 };
    }

    closeSession(sessionId = 'default', reason = 'session_closed') {
      this.cancelSession(sessionId, reason);
      const s = this.sessions.get(String(sessionId || 'default'));
      if (!s) return false;
      if (s.liveSession && typeof s.liveSession.close === 'function') {
        s.liveSession.close(reason);
      }
      this.sessions.delete(String(sessionId || 'default'));
      return true;
    }

    /**
     * Execute an explain/chat request with streaming progressive emission and clean fallback chain:
     * Cache -> (Optional Live WS for interactive Q&A) -> Gemini SSE -> Proxy Stream/REST -> Ollama NDJSON -> Offline Fallback.
     */
    async streamExplain(request = {}, emit = () => {}) {
      const tStart = Date.now();
      const llm = this._resolveLlm();
      const payload = (request && request.payload && typeof request.payload === 'object') ? request.payload : (request || {});
      const sessionId = String(request.sessionId || payload.sessionId || 'default');
      const interruptPrevious = request.interruptPrevious !== false;
      const reqId = String(request.reqId || `req_${++this._reqSeq}_${Date.now().toString(36)}`);
      const session = this._getOrCreateSession(sessionId);

      // Cancel older in-flight work for this session if preempted by a new command
      let cancelLatencyMs = 0;
      if (interruptPrevious && session.controllers.size > 0) {
        const c = this.cancelSession(sessionId, 'superseded_by_new_request');
        cancelLatencyMs = c.cancelLatencyMs;
      }

      const epoch = session.epoch;
      const controller = new AbortController();
      session.controllers.set(reqId, { controller, startedAt: tStart });

      const safeEmit = (ev) => {
        if (controller.signal.aborted) return;
        if (session.epoch !== epoch) return;
        try { emit({ reqId, sessionId, epoch, ...ev }); } catch (_e) {}
      };

      // Immediate acknowledgement so UI leaves dead silence instantly
      safeEmit({ type: 'ack', elapsedMs: Date.now() - tStart, cancelLatencyMs, message: 'Thinking...' });

      const dedupKey = `${sessionId}::${epoch}::${payload.urlClean || ''}::${payload.mode || 'summary'}::${payload.target || ''}::${payload.query || ''}::${payload.lang || ''}`;
      if (!interruptPrevious && this.dedupInFlight.has(dedupKey)) {
        try {
          const shared = await this.dedupInFlight.get(dedupKey);
          safeEmit({ type: 'done', ...shared, deduplicated: true });
          return { ...shared, deduplicated: true };
        } finally {
          session.controllers.delete(reqId);
        }
      }

      const run = async () => {
        const config = llm.getLlmConfig ? await llm.getLlmConfig() : {};
        const metrics = {
          connMs: 0,
          setupMs: 0,
          ttftMs: -1,
          firstSentenceMs: -1,
          totalMs: 0,
          cancelLatencyMs: 0,
          reconnectMs: 0,
          reusedSession: false
        };

        const markSentenceTiming = () => {
          if (metrics.firstSentenceMs === -1) metrics.firstSentenceMs = Date.now() - tStart;
        };

        try {
          // 1. Exact/LRU cache check first (<2ms)
          if (typeof llm.lookupExplainCache === 'function') {
            const cached = llm.lookupExplainCache(payload);
            if (cached) {
              metrics.ttftMs = Date.now() - tStart;
              const { sentences } = extractCompletedSentences(cached.answer, 0);
              const chunks = sentences.length > 0 ? sentences : [cached.answer];
              safeEmit({ type: 'meta', transport: 'cache', source: cached.source, cached: true });
              safeEmit({ type: 'delta', delta: cached.answer, text: cached.answer });
              chunks.forEach((s, i) => {
                markSentenceTiming();
                safeEmit({ type: 'speak_chunk', sentence: s, index: i });
              });
              metrics.totalMs = Date.now() - tStart;
              const out = { status: 'ok', ...cached, transport: 'cache', metrics };
              safeEmit({ type: 'done', ...out });
              this._recordTrace({ reqId, sessionId, transport: 'cache', ...metrics });
              return out;
            }
          }

          let streamResult = null;
          let sentenceIdx = 0;

          const makeParserCallbacks = (transportName, modelLabel) => {
            const parser = new IncrementalExplainStreamParser();
            let announcedMeta = false;
            return {
              parser,
              onToken: (rawChunk) => {
                if (controller.signal.aborted || session.epoch !== epoch) return;
                if (metrics.ttftMs === -1) metrics.ttftMs = Date.now() - tStart;
                if (!announcedMeta) {
                  announcedMeta = true;
                  safeEmit({ type: 'meta', transport: transportName, model: modelLabel, source: modelLabel });
                }
                const step = parser.push(rawChunk);
                if (step.answerDelta) {
                  safeEmit({ type: 'delta', delta: step.answerDelta, text: step.fullAnswer });
                }
                for (const sent of step.completedSentences) {
                  markSentenceTiming();
                  safeEmit({ type: 'speak_chunk', sentence: sent, index: sentenceIdx++ });
                }
              },
              finalize: (sourceLabel, extra = {}) => {
                const fin = parser.finish(llm.parseExplainJson);
                if (fin.answerDelta) {
                  safeEmit({ type: 'delta', delta: fin.answerDelta, text: fin.fullAnswer });
                }
                if (fin.trailingSentence) {
                  markSentenceTiming();
                  safeEmit({ type: 'speak_chunk', sentence: fin.trailingSentence, index: sentenceIdx++ });
                }
                const highlightSections = (fin.parsedJson && Array.isArray(fin.parsedJson.highlightSections))
                  ? fin.parsedJson.highlightSections
                  : (Array.isArray(extra.highlightSections) ? extra.highlightSections : []);
                if (!fin.fullAnswer) return null;
                return {
                  status: 'ok',
                  answer: fin.fullAnswer,
                  highlightSections,
                  source: sourceLabel,
                  transport: transportName
                };
              }
            };
          };

          const canCloud = !config.localOnly && (typeof llm.canCallGeminiCloud !== 'function' || llm.canCallGeminiCloud().allowed);
          const wantLiveWs = Boolean(
            canCloud &&
            this.liveMod &&
            (payload.preferLive === true || (config.liveEnabled && (payload.mode === 'qa' || payload.mode === 'chat'))) &&
            (config.geminiApiKey || config.proxyUrl)
          );

          // 2A. Optional Gemini Live WebSocket for persistent interactive sessions
          if (wantLiveWs && !controller.signal.aborted) {
            try {
              const promptData = typeof llm.buildExplainPromptsForClient === 'function'
                ? llm.buildExplainPromptsForClient(payload, 'gemini')
                : null;
              if (!session.liveSession) {
                session.liveSession = new this.liveMod.SleepwalkerGeminiLiveSession({
                  apiKey: config.proxyUrl ? '' : config.geminiApiKey,
                  tokenProvider: config.proxyUrl
                    ? async () => {
                        const tokUrl = String(config.proxyUrl).replace(/\/explain\/?$/i, '/live-token');
                        const r = await fetch(tokUrl, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'ephemeral_token', uses: 1 })
                        });
                        return r.ok ? r.json() : null;
                      }
                    : null,
                  resumptionHandle: session.lastResumptionHandle,
                  webSocketFactory: this.webSocketFactory || undefined,
                  systemInstruction: 'You are Sleepwalker, a helpful concise browser voice assistant. Reply directly in short natural spoken sentences based strictly on the provided webpage digest.',
                  onResumptionHandle: (h) => { session.lastResumptionHandle = h; }
                });
              }

              const liveCallbacks = makeParserCallbacks('gemini-live-ws', session.liveSession.model);
              const turnPrompt = promptData
                ? `${promptData.userPrompt}\nRespond cleanly in plain short spoken sentences (do not wrap in JSON).`
                : (payload.query || 'Summarize this page briefly.');
              const liveRes = await session.liveSession.sendTurn(turnPrompt, {
                signal: controller.signal,
                onDelta: (delta) => liveCallbacks.onToken(delta)
              });
              if (liveRes && liveRes.metrics) {
                Object.assign(metrics, {
                  connMs: liveRes.metrics.connMs,
                  setupMs: liveRes.metrics.setupMs,
                  reconnectMs: liveRes.metrics.reconnectMs,
                  reusedSession: liveRes.metrics.reusedSession
                });
              }
              if (liveRes && !liveRes.interrupted && liveRes.text) {
                streamResult = liveCallbacks.finalize(`Gemini Live (${liveRes.model.replace(/^models\//, '')})`);
                if (streamResult) {
                  streamResult.resumptionHandle = liveRes.resumptionHandle || session.lastResumptionHandle;
                }
              }
            } catch (liveErr) {
              if (!controller.signal.aborted) {
                console.warn('[Sleepwalker AiComm] Gemini Live WS failed, falling back to SSE:', liveErr.message);
              }
            }
          }

          // 2B. Direct Gemini SSE (:streamGenerateContent?alt=sse)
          if (!streamResult && canCloud && config.geminiApiKey && !controller.signal.aborted && typeof llm.callDirectGeminiExplainStream === 'function') {
            const sseHolder = { cb: null };
            const sseRes = await llm.callDirectGeminiExplainStream(config.geminiApiKey, payload, {
              preferredModel: config.geminiModel,
              signal: controller.signal,
              onStart: (model) => {
                sseHolder.cb = makeParserCallbacks('gemini-sse', `Gemini (${model})`);
              },
              onToken: (delta, model) => {
                if (!sseHolder.cb) sseHolder.cb = makeParserCallbacks('gemini-sse', `Gemini (${model})`);
                sseHolder.cb.onToken(delta);
              }
            });
            if (sseRes && sseRes._rateLimited) {
              payload._degradeMessage = sseRes.degradeMessage;
            } else if (sseRes && sseRes.ok && sseHolder.cb) {
              streamResult = sseHolder.cb.finalize(sseRes.source || `Gemini (${sseRes.model})`);
            }
          }

          // 2C. Cloud Proxy (SSE stream if supported, otherwise REST fallback)
          if (!streamResult && canCloud && config.proxyUrl && !controller.signal.aborted && typeof llm.callGeminiProxyExplainStream === 'function') {
            const pCb = makeParserCallbacks('gemini-proxy', 'cloud proxy');
            const pRes = await llm.callGeminiProxyExplainStream(config.proxyUrl, payload, {
              signal: controller.signal,
              onToken: (delta) => pCb.onToken(delta)
            });
            if (pRes && pRes._rateLimited) {
              payload._degradeMessage = pRes.degradeMessage;
            } else if (pRes && pRes.ok) {
              if (pRes.answer && !pCb.parser.answerText) {
                pCb.onToken(JSON.stringify({ answer: pRes.answer, highlightSections: pRes.highlightSections || [] }));
              }
              streamResult = pCb.finalize(pRes.source || 'cloud proxy', pRes);
            }
          }

          // 3. Local Ollama NDJSON stream (stream: true)
          if (!streamResult && !controller.signal.aborted && typeof llm.callLocalOllamaExplainStream === 'function') {
            const oCb = makeParserCallbacks('ollama-stream', `ollama:${config.ollamaModel || 'llama3.2:3b'}`);
            const oRes = await llm.callLocalOllamaExplainStream(config.ollamaUrl, config.ollamaModel, payload, {
              signal: controller.signal,
              onToken: (delta) => oCb.onToken(delta)
            });
            if (oRes && oRes.ok) {
              streamResult = oCb.finalize(oRes.source || `ollama:${config.ollamaModel || 'llama3.2:3b'}`);
            }
          }

          if (controller.signal.aborted || session.epoch !== epoch) {
            const rec = session.controllers.get(reqId);
            metrics.cancelLatencyMs = rec && rec.cancelRequestedAt ? Math.max(0, Date.now() - rec.cancelRequestedAt) : 0;
            metrics.totalMs = Date.now() - tStart;
            try {
              emit({ reqId, sessionId, epoch, type: 'cancelled', reason: controller.signal.reason || 'aborted', cancelLatencyMs: metrics.cancelLatencyMs, metrics });
            } catch (_e) {}
            this._recordTrace({ reqId, sessionId, transport: 'cancelled', ...metrics });
            return { status: 'cancelled', answer: '', metrics };
          }

          metrics.totalMs = Date.now() - tStart;

          if (streamResult && streamResult.status === 'ok' && streamResult.answer) {
            if (typeof llm.saveExplainCache === 'function') {
              llm.saveExplainCache(payload, streamResult);
            }
            if (payload._degradeMessage) streamResult.degradeMessage = payload._degradeMessage;
            const out = { ...streamResult, metrics };
            safeEmit({ type: 'done', ...out });
            this._recordTrace({ reqId, sessionId, transport: streamResult.transport, ...metrics });
            return out;
          }

          // Fallback notice so UI/explainer runs deterministic extractive summary cleanly
          const fallbackOut = {
            status: 'fallback',
            source: 'basic summary',
            transport: 'fallback',
            degradeMessage: payload._degradeMessage || '',
            metrics
          };
          safeEmit({ type: 'done', ...fallbackOut });
          this._recordTrace({ reqId, sessionId, transport: 'fallback', ...metrics });
          return fallbackOut;
        } finally {
          session.controllers.delete(reqId);
        }
      };

      const p = run();
      if (!interruptPrevious) {
        this.dedupInFlight.set(dedupKey, p);
        p.finally(() => {
          if (this.dedupInFlight.get(dedupKey) === p) this.dedupInFlight.delete(dedupKey);
        }).catch(() => {});
      }
      return p;
    }

    /** Attach Chrome MV3 runtime long-lived Port (`sw-ai-stream`) listener in Service Worker. */
    attachBackgroundPortListener(envReadyPromise = Promise.resolve()) {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onConnect) return false;
      if (this._portListenerAttached) return true;
      this._portListenerAttached = true;

      chrome.runtime.onConnect.addListener((port) => {
        if (!port || port.name !== 'sw-ai-stream') return;
        // Reject ports originating from unexpected external extensions
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && port.sender && port.sender.id && port.sender.id !== chrome.runtime.id) {
          try { port.disconnect(); } catch (_e) {}
          return;
        }
        const tabId = port.sender && port.sender.tab && port.sender.tab.id;
        const defaultSessionId = tabId ? `tab:${tabId}` : `port:${Date.now().toString(36)}`;
        let disconnected = false;

        port.onDisconnect.addListener(() => {
          disconnected = true;
          this.cancelSession(defaultSessionId, 'port_disconnected');
        });

        port.onMessage.addListener((msg) => {
          if (!msg || typeof msg !== 'object') return;
          const sid = msg.sessionId || defaultSessionId;

          if (msg.action === 'CANCEL') {
            const c = this.cancelSession(sid, msg.reason || 'client_cancel', msg.reqId || null);
            if (!disconnected) {
              try {
                port.postMessage({
                  type: 'cancelled',
                  reqId: msg.reqId || null,
                  sessionId: sid,
                  cancelLatencyMs: c.cancelLatencyMs
                });
              } catch (_e) {}
            }
            return;
          }

          if (msg.action === 'CLOSE_SESSION') {
            this.closeSession(sid, msg.reason || 'client_close');
            return;
          }

          if (msg.action === 'LIVE_AUDIO' || msg.action === 'LIVE_TEXT') {
            const s = this.sessions.get(String(sid));
            if (s && s.liveSession) {
              if (msg.action === 'LIVE_AUDIO') s.liveSession.sendRealtimeAudio(msg.audioBase64, msg.mimeType);
              else s.liveSession.sendRealtimeText(msg.text);
            }
            return;
          }

          if (msg.action === 'EXPLAIN_STREAM') {
            Promise.resolve(envReadyPromise)
              .then(() => this.streamExplain({
                reqId: msg.reqId,
                sessionId: sid,
                interruptPrevious: msg.interruptPrevious !== false,
                payload: msg.payload
              }, (event) => {
                if (disconnected) return;
                try { port.postMessage(event); } catch (_e) {}
              }))
              .catch((err) => {
                if (disconnected) return;
                try {
                  port.postMessage({
                    type: 'done',
                    reqId: msg.reqId,
                    sessionId: sid,
                    status: 'fallback',
                    source: 'basic summary',
                    error: (err && err.message) || 'Stream failed'
                  });
                } catch (_e) {}
              });
          }
        });
      });

      return true;
    }
  }

  /**
   * Content-script streaming client managing long-lived `sw-ai-stream` port communication,
   * auto-reconnection on SW sleep, epoch-scoped stale rejection, and `sendMessage` fallback.
   */
  class SleepwalkerStreamClient {
    constructor(options = {}) {
      this.sessionId = String(options.sessionId || `tab_${Math.random().toString(36).slice(2, 8)}`);
      this.port = null;
      this.epoch = 0;
      this.pending = new Map(); // reqId -> { epoch, onAck, onMeta, onDelta, onSpeakChunk, resolve }
      this._seq = 0;
    }

    _hasPortApi() {
      return typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.connect === 'function';
    }

    _ensurePort() {
      if (this.port) return this.port;
      if (!this._hasPortApi()) return null;

      try {
        const port = chrome.runtime.connect({ name: 'sw-ai-stream' });
        port.onMessage.addListener((msg) => this._handlePortMessage(msg));
        port.onDisconnect.addListener(() => {
          if (this.port === port) this.port = null;
          // Resolve any stranded requests cleanly as fallback so callers never hang if SW restarted
          for (const [reqId, rec] of Array.from(this.pending.entries())) {
            this.pending.delete(reqId);
            rec.resolve({ status: 'fallback', source: 'basic summary', interrupted: true });
          }
        });
        this.port = port;
        return port;
      } catch (_e) {
        return null;
      }
    }

    _handlePortMessage(msg) {
      if (!msg || !msg.reqId) return;
      const rec = this.pending.get(msg.reqId);
      if (!rec) return;

      // Reject stale messages belonging to superseded client epochs
      if (rec.epoch !== this.epoch && msg.type !== 'cancelled') return;

      if (msg.type === 'ack' && rec.onAck) rec.onAck(msg);
      else if (msg.type === 'meta' && rec.onMeta) rec.onMeta(msg);
      else if (msg.type === 'delta' && rec.onDelta) rec.onDelta(msg);
      else if (msg.type === 'speak_chunk' && rec.onSpeakChunk) rec.onSpeakChunk(msg);
      else if (msg.type === 'cancelled') {
        this.pending.delete(msg.reqId);
        rec.resolve({ status: 'cancelled', cancelled: true, cancelLatencyMs: msg.cancelLatencyMs || 0 });
      } else if (msg.type === 'done') {
        this.pending.delete(msg.reqId);
        rec.resolve(msg);
      }
    }

    cancel(reason = 'user_interrupt') {
      const t0 = Date.now();
      this.epoch += 1;
      for (const [reqId, rec] of Array.from(this.pending.entries())) {
        this.pending.delete(reqId);
        rec.resolve({ status: 'cancelled', cancelled: true, reason, cancelLatencyMs: Date.now() - t0 });
      }
      if (this.port) {
        try {
          this.port.postMessage({ action: 'CANCEL', sessionId: this.sessionId, reason });
        } catch (_e) {}
      }
      return Date.now() - t0;
    }

    runExplainStream(payload, callbacks = {}) {
      const port = this._ensurePort();
      if (!port) {
        // Fallback cleanly to unary sendMessage when running in simplified mock test environments
        return new Promise((resolve) => {
          if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
            resolve({ status: 'fallback', source: 'basic summary' });
            return;
          }
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_EXPLAIN_REQUEST', payload }, (res) => {
            if (chrome.runtime && chrome.runtime.lastError) {
              resolve({ status: 'fallback', source: 'basic summary' });
              return;
            }
            resolve(res || { status: 'fallback', source: 'basic summary' });
          });
        });
      }

      if (callbacks.interruptPrevious !== false && this.pending.size > 0) {
        this.cancel('superseded_by_new_command');
      } else {
        this.epoch += 1;
      }

      const myEpoch = this.epoch;
      const reqId = `creq_${++this._seq}_${Date.now().toString(36)}`;

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.pending.has(reqId)) {
            this.pending.delete(reqId);
            resolve({ status: 'fallback', source: 'basic summary' });
          }
        }, Math.max(5000, Number(callbacks.timeoutMs) || 26000));

        this.pending.set(reqId, {
          epoch: myEpoch,
          onAck: callbacks.onAck || null,
          onMeta: callbacks.onMeta || null,
          onDelta: callbacks.onDelta || null,
          onSpeakChunk: callbacks.onSpeakChunk || null,
          resolve: (res) => {
            clearTimeout(timer);
            resolve(res);
          }
        });

        try {
          port.postMessage({
            action: 'EXPLAIN_STREAM',
            reqId,
            sessionId: this.sessionId,
            interruptPrevious: callbacks.interruptPrevious !== false,
            payload
          });
        } catch (_e) {
          this.pending.delete(reqId);
          clearTimeout(timer);
          resolve({ status: 'fallback', source: 'basic summary' });
        }
      });
    }

    sendRealtimeAudioChunk(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
      const port = this._ensurePort();
      if (!port || !base64Pcm) return false;
      try {
        port.postMessage({ action: 'LIVE_AUDIO', sessionId: this.sessionId, audioBase64: base64Pcm, mimeType });
        return true;
      } catch (_e) {
        return false;
      }
    }
  }

  const exported = {
    stripMarkdownLight,
    extractCompletedSentences,
    IncrementalExplainStreamParser,
    SleepwalkerAiCommManager,
    SleepwalkerStreamClient
  };

  root.SleepwalkerAiComm = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
