/**
 * Sleepwalker - gemini-live.js
 * Persistent WebSocket client & ephemeral token auth helper for Gemini Live API (BidiGenerateContent).
 *
 * Security model:
 * - Intended for private MV3 Service Worker execution (`background.js`) or short-lived ephemeral
 *   `auth_tokens/...` sessions minted by a serverless proxy (`proxy/worker.js`, `proxy/api/explain.js`).
 * - API keys are never passed into webpage content scripts or web-accessible logs.
 *
 * Empirical modality note:
 * - Current `bidiGenerateContent` Live models require `responseModalities: ['AUDIO']` (sending `['TEXT']`
 *   causes server close code 1007). We enable `outputAudioTranscription: {}` and `inputAudioTranscription: {}`
 *   to obtain clean incremental text deltas alongside optional raw PCM audio chunks, and filter any internal
 *   thought/markdown reasoning headers before forwarding text to UI or TTS.
 */
(function (root) {
  'use strict';

  const DEFAULT_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';
  const FALLBACK_LIVE_MODELS = [
    'models/gemini-3.1-flash-live-preview',
    'models/gemini-2.5-flash-native-audio-latest'
  ];

  /** Redact sensitive query credentials from WebSocket/HTTP URLs before diagnostics logging. */
  function sanitizeSecretUrl(rawUrl) {
    return String(rawUrl || '')
      .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/([?&]access_token=)[^&\s]+/gi, '$1[REDACTED]');
  }

  /** Normalize model name into `models/<id>` format expected by Gemini Live setup. */
  function normalizeLiveModel(model) {
    const clean = String(model || '').trim().replace(/^models\//i, '');
    if (!clean) return DEFAULT_LIVE_MODEL;
    return `models/${clean}`;
  }

  /** Validate WebSocket destination is strictly TLS wss:// on official Gemini Live API domain. */
  function isAllowedLiveWsUrl(rawUrl) {
    try {
      const u = new URL(String(rawUrl || '').trim());
      return u.protocol === 'wss:' && u.hostname === 'generativelanguage.googleapis.com';
    } catch (_e) {
      return false;
    }
  }

  /** Build authenticated Gemini Live WebSocket endpoint using ephemeral token or SW-private API key. */
  function buildLiveWsUrl({ apiKey = '', ephemeralToken = '', apiVersion = 'v1beta' } = {}) {
    const tok = String(ephemeralToken || '').trim();
    if (tok) {
      return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(tok)}`;
    }
    const key = String(apiKey || '').trim();
    if (!key) return '';
    const ver = apiVersion === 'v1alpha' ? 'v1alpha' : 'v1beta';
    return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${ver}.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
  }

  /**
   * Decode incoming WebSocket message payload (string, Blob, ArrayBuffer, or TypedArray) into JSON.
   */
  async function decodeWsJson(data) {
    let raw = '';
    if (typeof data === 'string') {
      raw = data;
    } else if (data && typeof data.text === 'function') {
      raw = await data.text();
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      raw = new TextDecoder().decode(data);
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      raw = data.toString('utf8');
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  }

  /** Strip leading markdown bold headings if a native-audio model leaks internal thought captions. */
  function stripThoughtCaption(text) {
    return String(text || '')
      .replace(/^\*\*[^*\n]{2,60}\*\*\s*/g, '')
      .replace(/\n{2,}/g, ' ')
      .trim();
  }

  /**
   * Mint a short-lived single/limited-use ephemeral auth token for constrained Live API WebSockets.
   * Safe to invoke from serverless proxy endpoints (`proxy/worker.js`, `proxy/api/explain.js`) or SW.
   */
  async function mintEphemeralLiveToken(apiKey, options = {}) {
    const key = String(apiKey || '').trim();
    if (!key) return { ok: false, status: 400, error: 'Missing GEMINI_API_KEY' };
    const fetchFn = typeof options.fetchFn === 'function' ? options.fetchFn : fetch;
    const uses = Math.max(1, Math.min(10, Number(options.uses) || 1));
    const expireMinutes = Math.max(1, Math.min(30, Number(options.expireMinutes) || 10));
    const newSessionMinutes = Math.max(1, Math.min(10, Number(options.newSessionMinutes) || 2));
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const t0 = Date.now();
    try {
      const res = await fetchFn(`https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uses,
          expireTime: new Date(Date.now() + expireMinutes * 60 * 1000).toISOString(),
          newSessionExpireTime: new Date(Date.now() + newSessionMinutes * 60 * 1000).toISOString()
        }),
        signal: controller ? controller.signal : undefined
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json || !json.name) {
        return {
          ok: false,
          status: res.status || 500,
          error: (json && json.error && json.error.message) || `Ephemeral token error (${res.status})`,
          latencyMs: Date.now() - t0
        };
      }
      return {
        ok: true,
        status: 200,
        name: json.name,
        expireTime: new Date(Date.now() + expireMinutes * 60 * 1000).toISOString(),
        latencyMs: Date.now() - t0
      };
    } catch (err) {
      return {
        ok: false,
        status: 504,
        error: err && err.message ? err.message : 'Token mint timeout',
        latencyMs: Date.now() - t0
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  class SleepwalkerGeminiLiveSession {
    constructor(options = {}) {
      this.apiKey = String(options.apiKey || '').trim();
      this.ephemeralToken = String(options.ephemeralToken || '').trim();
      this.tokenProvider = typeof options.tokenProvider === 'function' ? options.tokenProvider : null;
      this.model = normalizeLiveModel(options.model || DEFAULT_LIVE_MODEL);
      this.fallbackModels = Array.isArray(options.fallbackModels) && options.fallbackModels.length > 0
        ? options.fallbackModels.map(normalizeLiveModel)
        : [this.model, ...FALLBACK_LIVE_MODELS.filter((m) => m !== this.model)];
      this.systemInstruction = String(options.systemInstruction || '').trim();
      this.webSocketFactory = typeof options.webSocketFactory === 'function'
        ? options.webSocketFactory
        : ((url) => new WebSocket(url));

      this.connectTimeoutMs = Math.max(1000, Number(options.connectTimeoutMs) || 6000);
      this.setupTimeoutMs = Math.max(1000, Number(options.setupTimeoutMs) || 6000);
      this.idleTtlMs = Math.max(5000, Number(options.idleTtlMs) || 120000);
      this.maxReconnectAttempts = Math.max(0, Number(options.maxReconnectAttempts ?? 2));

      this.onResumptionHandle = typeof options.onResumptionHandle === 'function' ? options.onResumptionHandle : null;
      this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;

      this.ws = null;
      this.state = 'disconnected'; // disconnected | connecting | ready | reconnecting | closed
      this.resumptionHandle = String(options.resumptionHandle || '').trim();
      this.goAwayTimeLeft = null;
      this.turnHistory = []; // Compact 4-turn context continuity fallback when resumption handle expires

      this._connectPromise = null;
      this._idleTimer = null;
      this._activeTurn = null;
      this._modelIdx = 0;
      this._reconnectCount = 0;
      this._lastReconnectMs = 0;
    }

    _setState(next) {
      this.state = next;
      if (this.onStateChange) {
        try { this.onStateChange(next, { model: this.model, hasResumption: Boolean(this.resumptionHandle) }); } catch (_e) {}
      }
    }

    isReady() {
      const wsOpenState = typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1;
      return Boolean(this.ws && this.ws.readyState === wsOpenState && this.state === 'ready');
    }

    /** Report real WebSocket connection state cleanly (`connected` | `connecting` | `reconnecting` | `disconnected` | `unavailable`). */
    getConnectionStatus() {
      if (this.state === 'ready' && this.isReady()) return 'connected';
      if (this.state === 'connecting') return 'connecting';
      if (this.state === 'reconnecting') return 'reconnecting';
      if (!this.apiKey && !this.ephemeralToken && !this.tokenProvider) return 'unavailable';
      return 'disconnected';
    }

    _resetIdleTimer() {
      if (this._idleTimer) clearTimeout(this._idleTimer);
      if (this.idleTtlMs <= 0) return;
      this._idleTimer = setTimeout(() => {
        if (!this._activeTurn) this.close('idle_ttl');
      }, this.idleTtlMs);
    }

    _recordContextTurn(role, text) {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      this.turnHistory.push({ role, text: clean.slice(0, 240) });
      if (this.turnHistory.length > 4) {
        this.turnHistory = this.turnHistory.slice(-4);
      }
    }

    _buildContextContinuationSeed() {
      if (!this.turnHistory.length) return '';
      const lines = this.turnHistory.map((t) => `${t.role === 'model' ? 'Assistant' : 'User'}: ${t.text}`);
      return `Conversation continuity context:\n${lines.join('\n')}`;
    }

    /** Open WebSocket connection & negotiate Live API setup frame. */
    async connect({ forceReconnect = false, useResumption = true } = {}) {
      if (!forceReconnect && this.isReady()) {
        this._resetIdleTimer();
        return { connMs: 0, setupMs: 0, reusedSession: true, model: this.model };
      }
      if (!forceReconnect && this._connectPromise) {
        return this._connectPromise;
      }

      if (typeof WebSocket !== 'function' && this.webSocketFactory.toString().includes('new WebSocket')) {
        throw new Error('WebSocket API unavailable in current runtime');
      }

      if (forceReconnect && this.ws) {
        this._teardownSocket(1000, 'reconnect');
      }

      this._connectPromise = (async () => {
        const dialStartedAt = Date.now();
        let connMs = -1;
        let setupMs = -1;

        let tok = this.ephemeralToken;
        if (this.tokenProvider) {
          const minted = await this.tokenProvider();
          if (minted && minted.name) tok = minted.name;
        }
        const wsUrl = buildLiveWsUrl({ apiKey: tok ? '' : this.apiKey, ephemeralToken: tok });
        if (!wsUrl) throw new Error('Gemini Live credentials unavailable');
        if (!isAllowedLiveWsUrl(wsUrl)) throw new Error('Rejected non-Gemini or insecure Live WebSocket URL');

        this._setState('connecting');

        return new Promise((resolve, reject) => {
          let settled = false;
          const ws = this.webSocketFactory(wsUrl);
          this.ws = ws;

          const finishErr = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(connTimer);
            clearTimeout(setupTimer);
            if (this.ws === ws) this.ws = null;
            this._setState('disconnected');
            try { ws.close(1000, 'setup_abort'); } catch (_e) {}
            reject(err instanceof Error ? err : new Error(String(err || 'WebSocket connection failed')));
          };

          const connTimer = setTimeout(() => finishErr(new Error('Gemini Live WebSocket connect timeout')), this.connectTimeoutMs);
          let setupTimer = null;

          ws.addEventListener('open', () => {
            clearTimeout(connTimer);
            connMs = Date.now() - dialStartedAt;
            setupTimer = setTimeout(() => finishErr(new Error('Gemini Live setupComplete timeout')), this.setupTimeoutMs);

            const activeModel = this.fallbackModels[this._modelIdx] || this.model;
            this.model = activeModel;
            const setupBody = {
              setup: {
                model: activeModel,
                generationConfig: { responseModalities: ['AUDIO'] },
                outputAudioTranscription: {},
                inputAudioTranscription: {},
                contextWindowCompression: { slidingWindow: {} },
                sessionResumption: (useResumption && this.resumptionHandle)
                  ? { handle: this.resumptionHandle }
                  : {}
              }
            };
            if (this.systemInstruction) {
              setupBody.setup.systemInstruction = { parts: [{ text: this.systemInstruction }] };
            }
            ws.send(JSON.stringify(setupBody));
          });

          const onSetupOrRuntimeMsg = async (ev) => {
            const msg = await decodeWsJson(ev.data);
            if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

            if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.newHandle) {
              this.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
              if (this.onResumptionHandle) {
                try { this.onResumptionHandle(this.resumptionHandle); } catch (_e) {}
              }
            }

            if (msg.goAway) {
              this.goAwayTimeLeft = msg.goAway.timeLeft || null;
            }

            if (!settled && msg.setupComplete !== undefined) {
              settled = true;
              clearTimeout(setupTimer);
              setupMs = Date.now() - dialStartedAt;
              this._setState('ready');
              this._resetIdleTimer();

              // If session resumption handle was dropped/absent on fresh socket and prior turns exist, seed continuity cleanly.
              if ((!useResumption || !this.resumptionHandle) && this.turnHistory.length > 0 && ws.readyState === 1) {
                const seedText = this._buildContextContinuationSeed();
                if (seedText) {
                  try {
                    ws.send(JSON.stringify({
                      clientContent: {
                        turns: [{ role: 'user', parts: [{ text: seedText }] }],
                        turnComplete: false
                      }
                    }));
                  } catch (_e) {}
                }
              }

              resolve({ connMs, setupMs, reusedSession: false, model: this.model });
              return;
            }

            this._handleIncomingServerMessage(msg);
          };

          ws.addEventListener('message', onSetupOrRuntimeMsg);

          ws.addEventListener('close', (ev) => {
            clearTimeout(connTimer);
            clearTimeout(setupTimer);
            const reason = ev && ev.reason ? ` (${ev.reason})` : '';
            const code = ev ? ev.code : 1006;
            if (!settled) {
              const err = new Error(`Gemini Live closed during setup: code=${code}${reason}`);
              err.code = code;
              finishErr(err);
              return;
            }
            if (this.ws === ws) this.ws = null;
            this._setState('disconnected');
            if (this._activeTurn && !this._activeTurn.settled) {
              this._activeTurn.reject(new Error(`Gemini Live WebSocket closed mid-turn: code=${code}${reason}`));
            }
          });

          ws.addEventListener('error', (err) => {
            if (!settled) {
              finishErr(new Error((err && err.message) || 'Gemini Live WebSocket error'));
            } else if (this._activeTurn && !this._activeTurn.settled) {
              this._activeTurn.reject(new Error('Gemini Live WebSocket transport error'));
            }
          });
        });
      })();

      try {
        return await this._connectPromise;
      } finally {
        this._connectPromise = null;
      }
    }

    /** Connect or automatically reconnect with exponential backoff, falling back cleanly if resumption handle expires. */
    async ensureConnected() {
      if (this.isReady()) {
        return { connMs: 0, setupMs: 0, reusedSession: true, reconnectMs: 0, reconnectAttempts: 0, model: this.model };
      }

      const tRec0 = Date.now();
      let lastErr = null;
      let useResumption = Boolean(this.resumptionHandle);

      for (let attempt = 0; attempt <= this.maxReconnectAttempts; attempt++) {
        if (attempt > 0) {
          this._setState('reconnecting');
          const backoffMs = Math.min(3000, 160 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 50));
          await new Promise((r) => setTimeout(r, backoffMs));
        }
        try {
          const info = await this.connect({ forceReconnect: attempt > 0, useResumption });
          const reconnectMs = attempt > 0 ? (Date.now() - tRec0) : 0;
          if (attempt > 0) {
            this._reconnectCount += 1;
            this._lastReconnectMs = reconnectMs;
          }
          return { ...info, reconnectMs, reconnectAttempts: attempt };
        } catch (err) {
          lastErr = err;
          if (useResumption) {
            // Resumption handle may be expired/invalid; retry fresh session using turnHistory context continuity.
            useResumption = false;
            this.resumptionHandle = '';
          } else if (this._modelIdx + 1 < this.fallbackModels.length) {
            this._modelIdx += 1;
          }
        }
      }

      throw lastErr || new Error('Failed to establish Gemini Live WebSocket session');
    }

    _handleIncomingServerMessage(msg) {
      if (!this._activeTurn || this._activeTurn.settled) return;
      const turn = this._activeTurn;
      const sc = msg.serverContent;
      if (!sc) return;

      if (sc.inputTranscription && sc.inputTranscription.text && turn.onInputTranscription) {
        try { turn.onInputTranscription(sc.inputTranscription.text); } catch (_e) {}
      }

      if (sc.interrupted === true) {
        turn.interrupted = true;
        if (turn.onInterrupted) {
          try { turn.onInterrupted('server_interrupted'); } catch (_e) {}
        }
        turn.finish();
        return;
      }

      if (sc.outputTranscription && sc.outputTranscription.text) {
        turn.hasOutputTranscription = true;
        const delta = sc.outputTranscription.text;
        turn.emitTextDelta(delta);
      }

      const parts = (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) ? sc.modelTurn.parts : [];
      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) {
          turn.audioChunksCount += 1;
          if (turn.firstAudioMs === -1) turn.firstAudioMs = Date.now() - turn.sentAt;
          if (turn.onAudioChunk) {
            try { turn.onAudioChunk({ data: p.inlineData.data, mimeType: p.inlineData.mimeType || 'audio/pcm' }); } catch (_e) {}
          }
        } else if (p.text && !p.thought && !turn.hasOutputTranscription) {
          // Only fall back to modelTurn text if no outputTranscription arrives; filter bold thinking captions.
          const cleaned = stripThoughtCaption(p.text);
          if (cleaned) turn.emitTextDelta(cleaned);
        }
      }

      if (sc.turnComplete) {
        turn.finish();
      }
    }

    /**
     * Send a conversational turn over the persistent WebSocket and stream incremental output.
     * Preempts any older turn in progress cleanly so stale chunks cannot overwrite newer turns.
     */
    async sendTurn(userText, options = {}) {
      const prompt = String(userText || '').trim();
      if (!prompt) throw new Error('Empty Live turn prompt');

      if (this._activeTurn && !this._activeTurn.settled) {
        this.interrupt('superseded_by_new_turn');
      }

      const connInfo = await this.ensureConnected();
      if (!this.ws || this.ws.readyState !== 1) {
        throw new Error('Gemini Live WebSocket not open after connect');
      }

      if (options.signal && options.signal.aborted) {
        throw new Error('Aborted before sending Live turn');
      }

      this._resetIdleTimer();
      this._recordContextTurn('user', prompt);
      const sentAt = Date.now();
      const timeoutMs = Math.max(2000, Number(options.turnTimeoutMs) || 16000);

      return new Promise((resolve, reject) => {
        let timer = null;
        const turn = {
          sentAt,
          settled: false,
          interrupted: false,
          hasOutputTranscription: false,
          text: '',
          audioChunksCount: 0,
          ttftMs: -1,
          firstAudioMs: -1,
          onDelta: typeof options.onDelta === 'function' ? options.onDelta : null,
          onAudioChunk: typeof options.onAudioChunk === 'function' ? options.onAudioChunk : null,
          onInputTranscription: typeof options.onInputTranscription === 'function' ? options.onInputTranscription : null,
          onInterrupted: typeof options.onInterrupted === 'function' ? options.onInterrupted : null,
          emitTextDelta: (delta) => {
            if (turn.settled || !delta) return;
            if (turn.ttftMs === -1) turn.ttftMs = Date.now() - sentAt;
            turn.text += delta;
            if (turn.onDelta) {
              try { turn.onDelta(delta, turn.text); } catch (_e) {}
            }
          },
          finish: () => {
            if (turn.settled) return;
            turn.settled = true;
            cleanup();
            const cleanText = turn.text.trim();
            if (cleanText) this._recordContextTurn('model', cleanText);
            if (this._activeTurn === turn) this._activeTurn = null;
            resolve({
              text: cleanText,
              interrupted: turn.interrupted,
              audioChunksCount: turn.audioChunksCount,
              resumptionHandle: this.resumptionHandle,
              model: this.model,
              metrics: {
                connMs: connInfo.connMs,
                setupMs: connInfo.setupMs,
                reconnectMs: connInfo.reconnectMs || 0,
                reusedSession: Boolean(connInfo.reusedSession),
                ttftMs: turn.ttftMs,
                firstAudioMs: turn.firstAudioMs,
                totalMs: Date.now() - sentAt
              }
            });
          },
          reject: (err) => {
            if (turn.settled) return;
            turn.settled = true;
            cleanup();
            if (this._activeTurn === turn) this._activeTurn = null;
            reject(err instanceof Error ? err : new Error(String(err || 'Live turn failed')));
          }
        };

        const onAbort = () => {
          this.interrupt('abort_signal');
        };

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (options.signal && typeof options.signal.removeEventListener === 'function') {
            options.signal.removeEventListener('abort', onAbort);
          }
        };

        timer = setTimeout(() => {
          turn.reject(new Error(`Gemini Live turn timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        if (options.signal && typeof options.signal.addEventListener === 'function') {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }

        this._activeTurn = turn;
        this.ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: prompt }] }],
            turnComplete: true
          }
        }));
      });
    }

    /** Stream bidirectional PCM audio frames into the open Live API session. */
    sendRealtimeAudio(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
      if (!this.isReady() || !base64Pcm) return false;
      this._resetIdleTimer();
      this.ws.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType, data: String(base64Pcm) }]
        }
      }));
      return true;
    }

    /** Stream incremental user text over bidirectional Live API session. */
    sendRealtimeText(text) {
      if (!this.isReady() || !text) return false;
      this._resetIdleTimer();
      this.ws.send(JSON.stringify({
        realtimeInput: { text: String(text) }
      }));
      return true;
    }

    /** Immediately interrupt/cancel any in-flight model turn without dropping session context. */
    interrupt(reason = 'user_interrupt') {
      const t0 = Date.now();
      const turn = this._activeTurn;
      if (!turn || turn.settled) return { interrupted: false, cancelLatencyMs: 0 };
      turn.interrupted = true;
      if (turn.onInterrupted) {
        try { turn.onInterrupted(reason); } catch (_e) {}
      }
      // Best-effort client barge-in frame if socket open; settles local stream immediately regardless.
      if (this.ws && this.ws.readyState === 1) {
        try {
          this.ws.send(JSON.stringify({ clientContent: { turnComplete: true } }));
        } catch (_e) {}
      }
      turn.finish();
      return { interrupted: true, cancelLatencyMs: Date.now() - t0 };
    }

    _teardownSocket(code = 1000, reason = 'close') {
      if (!this.ws) return;
      const sock = this.ws;
      this.ws = null;
      try { sock.close(code, reason); } catch (_e) {}
    }

    close(reason = 'normal') {
      if (this._idleTimer) {
        clearTimeout(this._idleTimer);
        this._idleTimer = null;
      }
      if (this._activeTurn && !this._activeTurn.settled) {
        this.interrupt(reason);
      }
      this._teardownSocket(1000, reason);
      this._setState('closed');
    }
  }

  const exported = {
    DEFAULT_LIVE_MODEL,
    FALLBACK_LIVE_MODELS,
    SleepwalkerGeminiLiveSession,
    sanitizeSecretUrl,
    isAllowedLiveWsUrl,
    normalizeLiveModel,
    buildLiveWsUrl,
    mintEphemeralLiveToken,
    stripThoughtCaption
  };

  root.SleepwalkerLive = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
