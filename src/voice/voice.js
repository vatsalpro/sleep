/**
 * Sleepwalker - voice.js
 *
 * Responsibilities:
 * 1. Interface with the Web Speech API (SpeechRecognition).
 * 2. Support en-IN (English - India) and hi-IN (Hindi - India).
 * 3. Gracefully handle microphone permission denial and errors.
 * 4. Parse spoken and typed text into standard executable commands:
 *    - read this page
 *    - outline
 *    - read the <name> section
 *    - pause
 *    - resume
 *    - stop
 *    - read it again
 *    - help
 */

(function () {
  'use strict';

  if (window.SleepwalkerVoice) return;

  const SUPPORTED_LANGS = new Set([
    'auto',
    'en-IN',
    'en-US',
    'hi-IN',
    'ta-IN',
    'te-IN',
    'bn-IN',
    'mr-IN',
    'gu-IN',
    'kn-IN',
    'ml-IN',
    'pa-IN',
    'fr-FR',
    'de-DE',
    'ja-JP',
    'es-ES'
  ]);

  const LANG_ALIASES = {
    'english': 'en-IN',
    'english (india)': 'en-IN',
    'english (us)': 'en-US',
    'american english': 'en-US',
    'hindi': 'hi-IN',
    'kannada': 'kn-IN',
    'tamil': 'ta-IN',
    'telugu': 'te-IN',
    'malayalam': 'ml-IN',
    'bengali': 'bn-IN',
    'marathi': 'mr-IN',
    'gujarati': 'gu-IN',
    'punjabi': 'pa-IN',
    'french': 'fr-FR',
    'german': 'de-DE',
    'japanese': 'ja-JP',
    'spanish': 'es-ES'
  };
  SUPPORTED_LANGS.forEach((code) => {
    LANG_ALIASES[code.toLowerCase()] = code;
  });

  const AUTO_DEFAULT_LANG = 'en-IN';
  const AUTO_RETRY_LANG = 'en-IN';
  const AUTO_CONFIDENCE_THRESHOLD = 0.6;

  class SleepwalkerVoice {
    constructor() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.isSupported = Boolean(SpeechRecognition);

      this.recognition = null;
      this.lifecycleState = 'idle'; // 'idle' | 'starting' | 'listening' | 'committing' | 'paused' | 'restarting' | 'recovering' | 'error'
      this._recognitionRunning = false;
      this._pendingStartAfterStop = false;
      this._maxRestartAttempts = 6;
      this._lastRecoverableError = '';
      this._pausedForTab = false;
      this._lastCommandFingerprint = null;
      this.isListening = false;
      this.isPaused = false;
      this.continuousSession = false;
      this.mode = 'en-IN';       // 'auto' or any supported Indian BCP-47 code
      this.lang = 'en-IN';       // mirrors mode for backward-compatible callers
      this.activeLang = 'en-IN'; // concrete SpeechRecognition BCP-47 tag ('hi-IN' in auto initially)
      this.lastConfidence = null;
      this._autoRetriedEn = false;
      this.silenceTimer = null;
      this._restartTimer = null;
      this._stableResetTimer = null;
      this._restartAttempts = 0;
      this._lastStartAt = 0;
      this._intentionalStop = false;
      this._benignRestart = false;
      this._startingWatchdogTimer = null;
      this._lastErrorCode = '';
      this.lastInterim = '';
      this.lastInterimAlternatives = [];
      this.useOffscreen = false;
      this._fallbackMode = 'none'; // 'none' | 'iframe' | 'relay'
      this._startEpoch = 0;
      this._awaitingPermissionPrompt = false;
      this._lastPageMicPerm = 'unknown';
      this._extMicGranted = false;
      this._iframeEl = null;
      this._iframeReady = false;
      this._iframePendingStart = false;
      this._iframeMsgBound = false;

      // Callbacks
      this.onTranscript = null; // ({ text, isFinal, confidence, activeLang, mode }) => {}
      this.onCommand = null;    // (parsed, meta) => {}
      this.onError = null;      // ({ error, message, isPermissionDenied }) => {}
      this.onStateChange = null;// (isListening) => {}
      this.onLifecycleChange = null; // (state, detail) => {}
      this.onActivity = null;   // ({ type }) => {}
      this.onPauseChange = null;// (isPaused) => {}
      this.shouldAcceptCommand = null; // (cleanText, meta) => boolean | { accept, reason }

      if (this.isSupported) {
        this.initRecognition(SpeechRecognition);
      }

      this.initOffscreenListener();
    }

    normalizeLangCode(rawLang) {
      if (!rawLang || typeof rawLang !== 'string') return 'en-IN';
      const trimmed = rawLang.trim();
      const direct = LANG_ALIASES[trimmed.toLowerCase()];
      if (direct) return direct;
      if (trimmed.toLowerCase() === 'hi') return 'hi-IN';
      if (trimmed.toLowerCase() === 'en') return 'en-IN';
      return 'en-IN';
    }

    resolveSpeechLang(modeOrLang) {
      const normalized = this.normalizeLangCode(modeOrLang);
      return normalized === 'auto' ? AUTO_DEFAULT_LANG : normalized;
    }

    getMode() {
      return this.mode;
    }

    getActiveLang() {
      return this.activeLang;
    }

    resetAutoRetry() {
      this._autoRetriedEn = false;
      this.activeLang = this.resolveSpeechLang(this.mode);
      if (this.recognition) {
        this.recognition.lang = this.activeLang;
      }
    }

    /**
     * Check whether Auto mode should retry once in en-IN due to low ASR confidence.
     */
    shouldRetryWithEnIn(confidence = this.lastConfidence) {
      return Boolean(
        this.mode === 'auto' &&
        this.activeLang === AUTO_DEFAULT_LANG &&
        !this._autoRetriedEn &&
        typeof confidence === 'number' &&
        !Number.isNaN(confidence) &&
        confidence > 0 &&
        confidence < AUTO_CONFIDENCE_THRESHOLD
      );
    }

    /**
     * Switch Auto mode once from hi-IN to en-IN. Guarded so it never loops infinitely.
     * @returns {boolean} True if retry was activated, false if already retried or ineligible.
     */
    retryWithEnIn(options = {}) {
      const { restartListening = true } = options;
      if (this.mode !== 'auto' || this.activeLang !== AUTO_DEFAULT_LANG || this._autoRetriedEn) {
        return false;
      }

      this._autoRetriedEn = true;
      this.activeLang = AUTO_RETRY_LANG;

      if (this.recognition) {
        this.recognition.lang = this.activeLang;
      }

      if (restartListening) {
        if (this.useOffscreen && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_STOP_OFFSCREEN_VOICE' }, () => {
            this.startListening({ preserveRetry: true });
          });
        } else if (this.isSupported && this.recognition) {
          if (this.isListening) {
            try {
              this.recognition.stop();
            } catch (e) {}
          } else {
            this.startListening({ preserveRetry: true });
          }
        }
      }

      return true;
    }

    /**
     * Convenience single-retry helper for confidence > 0 && < 0.6 in Auto mode.
     */
    tryAutoEnInRetry(confidence = this.lastConfidence, options = {}) {
      if (!this.shouldRetryWithEnIn(confidence)) {
        return false;
      }
      return this.retryWithEnIn(options);
    }

    /**
     * Listen for speech events relayed from the extension voice-relay popup or offscreen document.
     */
    initOffscreenListener() {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((message) => {
          if (!message) return;

          if (message.type === 'OFFSCREEN_TRANSCRIPT') {
            if (!this.isListening || this.isPaused) return;
            if (message.interim) {
              this._micBoost = 0.72;
              this.lastInterim = message.interim;
              this.lastInterimAlternatives = Array.isArray(message.alternatives) ? message.alternatives : [];
              if (this.onActivity) this.onActivity({ type: 'interim' });
              if (this.onTranscript) {
                this.onTranscript({
                  text: message.interim,
                  isFinal: false,
                  confidence: null,
                  alternatives: this.lastInterimAlternatives,
                  activeLang: this.activeLang,
                  mode: this.mode
                });
              }
            }
            if (message.final) {
              const confidence = typeof message.confidence === 'number' ? message.confidence : null;
              const alternatives = Array.isArray(message.alternatives) ? message.alternatives : [];
              this.lastInterim = '';
              this.lastInterimAlternatives = [];
              this.lastConfidence = confidence;
              if (this.onActivity) this.onActivity({ type: 'final' });
              const meta = {
                confidence,
                alternatives,
                activeLang: this.activeLang,
                mode: this.mode
              };
              if (this.onTranscript) {
                this.onTranscript({ text: message.final, isFinal: true, ...meta });
              }
              this._emitCommandDeduped(message.final, meta);
            }
          } else if (message.type === 'OFFSCREEN_ERROR') {
            console.warn('[Sleepwalker Voice] Extension voice relay error:', message.error);
            this.useOffscreen = false;
          } else if (message.type === 'OFFSCREEN_STATE_CHANGE') {
            if (message.isListening) {
              this.isListening = true;
              this.isPaused = false;
              this._setLifecycleState('listening', 'Listening...');
              this._startLevelMonitor();
            }
            if (this.onStateChange) {
              this.onStateChange(Boolean(message.isListening));
            }
          }
        });
      }
    }

    _ensureIframeBridgeListener() {
      if (this._iframeMsgBound || typeof window === 'undefined') return;
      this._iframeMsgBound = true;
      window.addEventListener('message', (event) => {
        if (!this._iframeEl || event.source !== this._iframeEl.contentWindow) return;
        const data = event.data;
        if (!data || data.source !== 'sleepwalker-voice-frame') return;

        if (data.kind === 'ready') {
          this._iframeReady = true;
          if (this._iframePendingStart && this._fallbackMode === 'iframe' && this.isListening && !this.isPaused) {
            this._iframePendingStart = false;
            this._postToIframe({ action: 'START', lang: this.activeLang });
          }
        } else if (data.kind === 'start') {
          if (!this.isListening || this.isPaused) {
            this._postToIframe({ action: 'STOP' });
            return;
          }
          this._lastErrorCode = '';
          this._setLifecycleState('listening', 'Listening...');
          this._startLevelMonitor();
          if (this.onStateChange) this.onStateChange(true);
        } else if (data.kind === 'result') {
          if (!this.isListening || this.isPaused) return;
          if (data.interim) {
            this._micBoost = 0.72;
            this.lastInterim = data.interim;
            this.lastInterimAlternatives = Array.isArray(data.alternatives) ? data.alternatives : [];
            if (this.onActivity) this.onActivity({ type: 'interim' });
            if (this.onTranscript) {
              this.onTranscript({ text: data.interim, isFinal: false, confidence: null, alternatives: this.lastInterimAlternatives, activeLang: this.activeLang, mode: this.mode });
            }
          }
          if (data.final) {
            const alternatives = Array.isArray(data.alternatives) ? data.alternatives : [];
            this.lastInterim = '';
            this.lastInterimAlternatives = [];
            this.lastConfidence = typeof data.confidence === 'number' ? data.confidence : null;
            if (this.onActivity) this.onActivity({ type: 'final' });
            const meta = { confidence: this.lastConfidence, alternatives, activeLang: this.activeLang, mode: this.mode };
            if (this.onTranscript) {
              this.onTranscript({ text: data.final, isFinal: true, ...meta });
            }
            this._emitCommandDeduped(data.final, meta);
          }
        } else if (data.kind === 'error') {
          if (data.error === 'not-allowed' || data.error === 'service-not-allowed') {
            this._fallbackMode = 'none';
            if (this._extMicGranted) {
              this._diag('iframe_blocked_escalate_relay', { error: data.error });
              this._startExtensionRelayFallback();
            } else {
              this.isListening = false;
              this._setLifecycleState('error', 'Microphone blocked on this site');
              if (this.onError) {
                this.onError({
                  error: 'not-allowed',
                  message: 'This site blocks in-page microphone access. Click Use Sleepwalker Mic below to speak here.',
                  isPermissionDenied: true,
                  isSiteBlocked: true
                });
              }
            }
          } else if (data.error === 'audio-capture') {
            this.isListening = false;
            this._setLifecycleState('error', 'No microphone detected');
            if (this.onError) {
              this.onError({ error: 'audio-capture', message: 'No microphone was detected. Connect a microphone and click Retry.', isPermissionDenied: false });
            }
          }
        }
      });
    }

    _isPageMicHardBlockedByBrowser() {
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        return true;
      }
      if (typeof document !== 'undefined') {
        try {
          const policy = document.permissionsPolicy || document.featurePolicy;
          if (policy && typeof policy.allowsFeature === 'function' && policy.allowsFeature('microphone') === false) {
            return true;
          }
        } catch (_e) {}
      }
      return false;
    }

    async _probeMicEnvironment() {
      const hardBlocked = this._isPageMicHardBlockedByBrowser();
      let pagePerm = 'unknown';
      let extMicGranted = Boolean(this._extMicGranted);

      const permTask = (async () => {
        try {
          if (typeof navigator !== 'undefined' && navigator.permissions && typeof navigator.permissions.query === 'function') {
            const st = await navigator.permissions.query({ name: 'microphone' });
            if (st && typeof st.state === 'string') return st.state;
          }
        } catch (_e) {}
        return 'unknown';
      })();

      const storageTask = (async () => {
        try {
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function') {
            return await new Promise((resolve) => {
              chrome.storage.local.get(['sleepwalker_mic_permission'], (items) => {
                void chrome.runtime?.lastError;
                resolve(Boolean(items && items.sleepwalker_mic_permission === 'granted'));
              });
            });
          }
        } catch (_e) {}
        return extMicGranted;
      })();

      try {
        const timeout = new Promise((resolve) => setTimeout(() => resolve(['unknown', extMicGranted]), 120));
        const res = await Promise.race([Promise.all([permTask, storageTask]), timeout]);
        pagePerm = res[0] || 'unknown';
        extMicGranted = Boolean(res[1]);
      } catch (_e) {}

      this._lastPageMicPerm = pagePerm;
      this._extMicGranted = extMicGranted;
      return { hardBlocked, pagePerm, extMicGranted };
    }

    _postToIframe(msg) {
      if (this._iframeEl && this._iframeEl.contentWindow) {
        try {
          this._iframeEl.contentWindow.postMessage({ source: 'sleepwalker-host-voice', ...msg }, '*');
        } catch (_e) {}
      }
    }

    _startIframeFallback() {
      if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
        return false;
      }
      this._fallbackMode = 'iframe';
      this.isListening = true;
      this.isPaused = false;
      this._intentionalStop = false;
      this._ensureIframeBridgeListener();

      if (!this._iframeEl || !this._iframeEl.isConnected) {
        this._iframeReady = false;
        this._iframePendingStart = true;
        const iframe = document.createElement('iframe');
        iframe.className = 'sleepwalker-ignore sleepwalker-exclude';
        iframe.setAttribute('allow', 'microphone');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
        iframe.style.cssText = 'position:fixed !important;width:1px !important;height:1px !important;opacity:0 !important;pointer-events:none !important;border:0 !important;bottom:0 !important;right:0 !important;z-index:-1 !important;';
        iframe.src = chrome.runtime.getURL('pages/voice-frame.html');
        (document.documentElement || document.body).appendChild(iframe);
        this._iframeEl = iframe;
      } else if (this._iframeReady) {
        this._postToIframe({ action: 'START', lang: this.activeLang });
      } else {
        this._iframePendingStart = true;
      }
      this._setLifecycleState('starting', 'Starting microphone...');
      return true;
    }

    _startExtensionRelayFallback() {
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        return false;
      }
      this._postToIframe({ action: 'STOP' });
      this._fallbackMode = 'relay';
      this.isListening = true;
      this.isPaused = false;
      this._intentionalStop = false;
      this._setLifecycleState('starting', 'Starting microphone...');
      chrome.runtime.sendMessage(
        { type: 'SLEEPWALKER_START_EXT_VOICE_RELAY', lang: this.activeLang },
        (res) => {
          if (chrome.runtime.lastError || !res || res.status === 'error') {
            this._fallbackMode = 'none';
            this.isListening = false;
            this._setLifecycleState('error', 'Microphone permission denied');
            if (this.onError) {
              this.onError({
                error: 'not-allowed',
                message: 'This site blocks in-page microphone access. Click Allow Microphone below to enable Sleepwalker Mic.',
                isPermissionDenied: true,
                isSiteBlocked: true
              });
            }
          }
        }
      );
      return true;
    }

    /**
     * Explicitly switch to Sleepwalker's extension-origin microphone relay on user request.
     */
    useExtensionMicRelay() {
      this._startEpoch += 1;
      this._awaitingPermissionPrompt = false;
      if (this._startingWatchdogTimer) {
        clearTimeout(this._startingWatchdogTimer);
        this._startingWatchdogTimer = null;
      }
      if (this.recognition) {
        try { this.recognition.abort(); } catch (_e) {}
      }
      this._recognitionRunning = false;
      this._startInFlight = false;
      return this._startExtensionRelayFallback();
    }

    /**
     * Open the extension microphone setup and diagnostics onboarding tab.
     */
    openMicSetup() {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_OPEN_MIC_SETUP' });
      }
    }

    /**
     * Request microphone permission inside a direct user click gesture, immediately stop the
     * temporary MediaStream tracks so there is zero audio device contention, then start SpeechRecognition.
     */
    async requestMicPermissionWithGesture() {
      this._diag('gesture_mic_request', {});
      this._restartAttempts = 0;
      this._lastRecoverableError = '';
      this._lastErrorCode = '';
      if (this._isPageMicHardBlockedByBrowser()) {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
          return this.useExtensionMicRelay();
        }
        this._setLifecycleState('error', 'HTTPS required for microphone');
        if (typeof this.onError === 'function') {
          this.onError({
            error: 'insecure-context',
            message: 'Chrome only allows microphone access on HTTPS websites (or localhost). Open an https:// page or use the Type input box below.',
            isPermissionDenied: true
          });
        }
        return false;
      }
      if (navigator && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          if (stream && typeof stream.getTracks === 'function') {
            stream.getTracks().forEach((t) => { try { t.stop(); } catch (_e) {} });
          }
        } catch (err) {
          const errName = (err && (err.name || err.message)) || 'NotAllowedError';
          const isNoMic = /NotFound|DeviceNotFound|DevicesNotFound/i.test(errName);
          const isDenied = /NotAllowed|Permission|Security/i.test(errName);
          if (isDenied || isNoMic) {
            this._lastErrorCode = isNoMic ? 'audio-capture' : 'not-allowed';
            this._setLifecycleState('error', isNoMic ? 'No microphone detected' : 'Microphone permission denied');
            if (typeof this.onError === 'function') {
              this.onError({
                error: this._lastErrorCode,
                message: isNoMic
                  ? 'No microphone was detected. Connect a microphone in Windows Sound settings, then click Retry.'
                  : 'Microphone permission is blocked for this site. Click the site icon next to the URL in Chrome’s address bar, set Microphone to Allow, then click Retry.',
                isPermissionDenied: isDenied
              });
            }
            return false;
          }
        }
      }
      this._recreateRecognition();
      return this.startListening();
    }

    _diag(code, meta = {}) {
      const diag = typeof window !== 'undefined' && window.SleepwalkerDiagnostics;
      if (diag && typeof diag.log === 'function') {
        diag.log('voice', code, { lifecycleState: this.lifecycleState, ...meta });
      }
    }

    stripWakePrefix(rawText) {
      const clean = String(rawText || '').trim();
      if (!clean) return '';
      if (/^(?:sleepwalker\s*,?\s*rest(?:\s+now)?|hey\s+sleepwalker\s*,?\s*rest(?:\s+now)?)$/i.test(clean)) {
        return clean;
      }
      const stripped = clean
        .replace(/^(?:hey\s+|ok\s+|okay\s+|hi\s+|hello\s+)?sleepwalker\s*[,:-]*\s+/i, '')
        .trim();
      return stripped || clean;
    }

    _recreateRecognition() {
      const SpeechRec = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
      if (!SpeechRec) return false;
      if (this.recognition) {
        try {
          this.recognition.onstart = null;
          this.recognition.onresult = null;
          this.recognition.onerror = null;
          this.recognition.onend = null;
          this.recognition.abort();
        } catch (_e) {}
        this.recognition = null;
      }
      this._recognitionRunning = false;
      this.initRecognition(SpeechRec);
      return Boolean(this.recognition);
    }

    _setLifecycleState(nextState, detail = '') {
      this.lifecycleState = nextState;
      this._diag(`state_${nextState}`, { detail });
      if (typeof this.onLifecycleChange === 'function') {
        this.onLifecycleChange(nextState, detail);
      }
    }

    _emitCommandDeduped(rawText, meta = {}) {
      const clean = this.stripWakePrefix(rawText);
      if (!clean) return false;
      if (window.__SW_ECHO_TRACKER__ && typeof window.__SW_ECHO_TRACKER__.isEcho === 'function' && window.__SW_ECHO_TRACKER__.isEcho(clean)) {
        this._diag('echo_suppressed', { reason: 'matched_recent_tts' });
        return false;
      }
      const norm = clean.toLowerCase().replace(/[.,!?;:]+$/g, '').replace(/\s+/g, ' ').trim();
      if (typeof this.shouldAcceptCommand === 'function') {
        try {
          const gate = this.shouldAcceptCommand(clean, { ...meta, norm });
          if (gate === false || (gate && typeof gate === 'object' && gate.accept === false)) {
            this._diag('command_locked_or_dup', { reason: (gate && gate.reason) || 'active_task_lock' });
            return false;
          }
        } catch (_e) {}
      }
      const now = Date.now();
      if (
        this._lastCommandFingerprint &&
        this._lastCommandFingerprint.norm === norm &&
        (now - this._lastCommandFingerprint.time) < 1200
      ) {
        this._diag('duplicate_blocked', { reason: 'within_1200ms' });
        return false;
      }
      this._lastCommandFingerprint = { norm, time: now };
      this._setLifecycleState('committing', clean);
      const parsed = this.parseCommand(clean);
      parsed.confidence = meta.confidence ?? null;
      parsed.activeLang = meta.activeLang || this.activeLang;
      parsed.mode = meta.mode || this.mode;
      if (this.onCommand) {
        this.onCommand(parsed, meta);
      }
      return true;
    }

    /**
     * Initialize SpeechRecognition instance and configure event listeners.
     */
    initRecognition(SpeechRecognition) {
      if (this.recognition) return;
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.maxAlternatives = 4;
      this.recognition.lang = this.activeLang;

      this.recognition.onstart = () => {
        this._startInFlight = false;
        this._awaitingPermissionPrompt = false;
        this._lastPageMicPerm = 'granted';
        if (this._startingWatchdogTimer) {
          clearTimeout(this._startingWatchdogTimer);
          this._startingWatchdogTimer = null;
        }
        // Guard against an async onstart arriving after pauseTemporary/pauseForTabSwitch/stopListening was already requested
        if (!this.isListening || this._intentionalStop || this.isPaused || this._pausedForTab) {
          this._recognitionRunning = true;
          try { this.recognition.stop(); } catch (_e) {}
          return;
        }
        this._recognitionRunning = true;
        this.isListening = true;
        this.isPaused = false;
        this._intentionalStop = false;
        this._lastErrorCode = '';
        this._finalizedResults = new Map();
        this._lastStartAt = Date.now();
        this._setLifecycleState('listening', 'Listening...');
        if (this._stableResetTimer) clearTimeout(this._stableResetTimer);
        this._stableResetTimer = setTimeout(() => {
          if (this.isListening && !this.isPaused) {
            this._restartAttempts = 0;
          }
        }, 1500);
        this._startLevelMonitor();
        if (this.onStateChange) this.onStateChange(true);
      };

      this.recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';
        let finalConfidence = null;
        let confidenceSum = 0;
        let confidenceCount = 0;
        let sawZeroConfidence = false;

        if (!this._finalizedResults) this._finalizedResults = new Map();
        const baseIdx = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
        if (event.results.length === 1 && event.results[0] && !event.results[0].isFinal) {
          this._finalizedResults.clear();
        }

        const finalSegments = [];
        const interimSegments = [];
        for (let i = baseIdx; i < event.results.length; ++i) {
          const result = event.results[i];
          const alt = result && result[0];
          if (!alt) continue;
          const transcript = alt.transcript || '';
          const segAlts = [];
          const altLen = Math.min(4, Number(result.length) || 1);
          for (let k = 0; k < altLen; k++) {
            const a = result[k];
            if (a && a.transcript) {
              segAlts.push({
                transcript: String(a.transcript),
                confidence: typeof a.confidence === 'number' && !Number.isNaN(a.confidence) ? a.confidence : null
              });
            }
          }
          if (result.isFinal) {
            if (event.results.length > 1 && this._finalizedResults.get(i) === transcript) {
              continue;
            }
            this._finalizedResults.set(i, transcript);
            finalTranscript += transcript;
            if (segAlts.length > 0) finalSegments.push(segAlts);
            if (typeof alt.confidence === 'number' && !Number.isNaN(alt.confidence)) {
              if (alt.confidence > 0) {
                confidenceSum += alt.confidence;
                confidenceCount += 1;
              } else {
                sawZeroConfidence = true;
              }
            }
          } else {
            interimTranscript += transcript;
            if (segAlts.length > 0) interimSegments.push(segAlts);
          }
        }

        const buildRankedAlternatives = (segments) => {
          if (!segments || segments.length === 0) return [];
          const maxK = Math.min(4, Math.max(...segments.map((s) => s.length)));
          const out = [];
          const seen = new Set();
          for (let k = 0; k < maxK; k++) {
            let textAcc = '';
            let confSum = 0;
            let confCnt = 0;
            for (const seg of segments) {
              const chosen = seg[Math.min(k, seg.length - 1)];
              if (!chosen) continue;
              textAcc += chosen.transcript;
              if (typeof chosen.confidence === 'number' && chosen.confidence > 0) {
                confSum += chosen.confidence;
                confCnt += 1;
              }
            }
            const cleanAlt = textAcc.trim();
            const key = cleanAlt.toLowerCase().replace(/\s+/g, ' ');
            if (cleanAlt && !seen.has(key)) {
              seen.add(key);
              out.push({
                transcript: cleanAlt,
                confidence: confCnt > 0 ? confSum / confCnt : null,
                rank: k
              });
            }
          }
          return out;
        };
        const finalAlternatives = buildRankedAlternatives(finalSegments);
        const interimAlternatives = buildRankedAlternatives(interimSegments);

        if (confidenceCount > 0) {
          finalConfidence = confidenceSum / confidenceCount;
        } else if (sawZeroConfidence) {
          finalConfidence = 0;
        }

        // Live interim feedback
        if (interimTranscript && this.onTranscript) {
          this._restartAttempts = 0;
          this._micBoost = 0.72;
          if (this.onActivity) this.onActivity({ type: 'interim' });
          const prevInterimTrim = String(this.lastInterim || '').trim().toLowerCase();
          const nextInterimTrim = interimTranscript.trim().toLowerCase();
          const interimTextChanged = nextInterimTrim !== prevInterimTrim;
          this.lastInterim = interimTranscript;
          this.lastInterimAlternatives = interimAlternatives;
          this.onTranscript({
            text: interimTranscript.trim(),
            isFinal: false,
            confidence: null,
            alternatives: interimAlternatives,
            activeLang: this.activeLang,
            mode: this.mode
          });

          // Only reset silence timer when interim words actually change (prevents repeated identical onresult events from starving commit)
          if (this.silenceTimer && interimTextChanged) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
          }
          // > 0 so single-digit choices ("1".."5") still commit for numbered link lists
          if (interimTranscript.trim().length > 0 && !this.silenceTimer) {
            this.silenceTimer = setTimeout(() => {
              this.silenceTimer = null;
              if (this.isListening && !this.isPaused && this.lastInterim.trim().length > 0) {
                console.log('[Sleepwalker Voice] Silence timeout (1.5s), executing command:', this.lastInterim);
                const text = this.lastInterim.trim();
                const alts = Array.isArray(this.lastInterimAlternatives) ? this.lastInterimAlternatives.slice() : [];
                const meta = {
                  confidence: null,
                  alternatives: alts,
                  activeLang: this.activeLang,
                  mode: this.mode,
                  isInterimCommit: true
                };
                this.lastInterim = '';
                this.lastInterimAlternatives = [];
                this._lastInterimCommit = { text: text.toLowerCase(), time: Date.now() };
                if (this.continuousSession) {
                  // Flush current Chrome recognition buffer without penalizing restart attempts
                  this._benignRestart = true;
                  if (this.recognition) {
                    try {
                      this.recognition.stop();
                    } catch (e) {}
                  }
                } else {
                  this.stopListening();
                }
                this._emitCommandDeduped(text, meta);
              }
            }, 1500);
          }
        } else if (interimTranscript) {
          this._restartAttempts = 0;
          if (this.onActivity) this.onActivity({ type: 'interim' });
          this.lastInterim = interimTranscript;
          this.lastInterimAlternatives = interimAlternatives;
        }

        // Process final speech recognition result
        if (finalTranscript) {
          this._restartAttempts = 0;
          if (this.onActivity) this.onActivity({ type: 'final' });
          if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
          }
          this.lastInterim = '';
          this.lastInterimAlternatives = [];
          this.lastConfidence = finalConfidence;

          const cleanFinal = finalTranscript.trim();
          if (
            this._lastInterimCommit &&
            this._lastInterimCommit.text === cleanFinal.toLowerCase() &&
            (Date.now() - this._lastInterimCommit.time) < 2500
          ) {
            this._lastInterimCommit = null;
            return;
          }

          const meta = {
            confidence: finalConfidence,
            alternatives: finalAlternatives,
            activeLang: this.activeLang,
            mode: this.mode
          };
          if (this.onTranscript) {
            this.onTranscript({ text: cleanFinal, isFinal: true, ...meta });
          }

          this._emitCommandDeduped(cleanFinal, meta);
        }
      };

      this.recognition.onerror = (event) => {
        console.warn('[Sleepwalker Voice] Recognition error:', event.error);
        this._startInFlight = false;
        this._awaitingPermissionPrompt = false;
        if (this._startingWatchdogTimer) {
          clearTimeout(this._startingWatchdogTimer);
          this._startingWatchdogTimer = null;
        }
        this._lastErrorCode = event.error || 'unknown';
        this._diag('error', { errorCategory: this._lastErrorCode });

        let userMessage = 'Voice recognition error.';
        let isPermissionDenied = false;

        switch (event.error) {
          case 'not-allowed':
          case 'service-not-allowed':
            this._recognitionRunning = false;
            isPermissionDenied = true;
            this.isListening = false;
            this._setLifecycleState('error', 'Microphone permission needed');
            userMessage = (typeof window !== 'undefined' && window.isSecureContext === false)
              ? 'Chrome requires an HTTPS webpage (or localhost) for microphone access. Click Use Sleepwalker Mic below, or use the Type input box.'
              : 'Microphone permission was not granted for this site. Click Allow Microphone below, or click Use Sleepwalker Mic if this site blocks microphone access.';
            break;
          case 'no-speech':
            // Harmless; user was quiet — keep session alive without error card
            return;
          case 'aborted':
            if (this.isPaused || this._pausedForTab || this._intentionalStop || !this.isListening) {
              return;
            }
            this._lastRecoverableError = 'aborted';
            this._restartAttempts += 1;
            this._setLifecycleState('recovering', 'Recovering microphone...');
            return;
          case 'audio-capture':
            this._setLifecycleState('error', 'No microphone detected');
            userMessage = 'No microphone was detected or it is busy in another app. Check your Windows microphone device and click Retry.';
            break;
          case 'network':
            if (this.isListening && this._restartAttempts < 3) {
              this._lastRecoverableError = 'network';
              this._restartAttempts += 1;
              this._setLifecycleState('recovering', 'Reconnecting speech service...');
              this._diag('recovered', { errorCategory: 'network', attempt: this._restartAttempts });
              return;
            }
            this._setLifecycleState('error', 'Temporarily unavailable');
            userMessage = 'Speech recognition network error. Chrome Web Speech requires internet access; check your connection or use typed commands.';
            break;
          default:
            this._setLifecycleState('error', `Temporarily unavailable (${event.error})`);
            userMessage = `Voice recognition error: ${event.error}`;
        }

        if (this.onError) {
          this.onError({
            error: event.error,
            message: userMessage,
            isPermissionDenied
          });
        }

        if (isPermissionDenied || event.error === 'audio-capture') {
          this._recognitionRunning = false;
          this.stopListening({ preserveErrorState: true });
        }
      };

      this.recognition.onend = () => {
        this._startInFlight = false;
        this._recognitionRunning = false;
        this._diag('stopped', { intentional: this._intentionalStop, paused: this.isPaused, pausedForTab: this._pausedForTab, err: this._lastRecoverableError });
        if (this._finalizedResults) this._finalizedResults.clear();
        if (this._stableResetTimer) {
          clearTimeout(this._stableResetTimer);
          this._stableResetTimer = null;
        }
        if (this._restartTimer) {
          clearTimeout(this._restartTimer);
          this._restartTimer = null;
        }

        // If recognition ended while an uncommitted interim utterance was pending, commit it immediately
        if (this.lastInterim && this.lastInterim.trim().length > 0 && !this.isPaused && !this._intentionalStop) {
          if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
          }
          const pendingText = this.lastInterim.trim();
          const pendingAlts = Array.isArray(this.lastInterimAlternatives) ? this.lastInterimAlternatives.slice() : [];
          this.lastInterim = '';
          this.lastInterimAlternatives = [];
          this._lastInterimCommit = { text: pendingText.toLowerCase(), time: Date.now() };
          const meta = {
            confidence: null,
            alternatives: pendingAlts,
            activeLang: this.activeLang,
            mode: this.mode,
            isInterimCommit: true
          };
          if (this.onTranscript) {
            this.onTranscript({ text: pendingText, isFinal: true, ...meta });
          }
          this._emitCommandDeduped(pendingText, meta);
        }

        if (this._pendingStartAfterStop) {
          this._pendingStartAfterStop = false;
          if (!this.isPaused && !this._pausedForTab) {
            this._startContentRecognition();
            return;
          }
        }

        // Paused temporarily by half-duplex TTS or background tab switch: keep session open, do not mark idle
        if (this.isPaused || this._pausedForTab) {
          this._setLifecycleState('paused', this._pausedForTab ? 'Paused in background tab' : 'Paused while speaking');
          return;
        }

        // Auto-restart recognition when Chrome ends it (~60s limit or silence) with controlled backoff
        if (this.isListening && !this._intentionalStop) {
          const ranMs = this._lastStartAt ? (Date.now() - this._lastStartAt) : 0;
          const wasBenign = Boolean(this._benignRestart);
          this._benignRestart = false;
          if (!wasBenign && !this._lastRecoverableError && ranMs > 0 && ranMs < 1500) {
            this._restartAttempts += 1;
          }
          this._lastRecoverableError = '';
          if (this._restartAttempts > this._maxRestartAttempts) {
            this.isListening = false;
            this._setLifecycleState('error', 'Temporarily unavailable');
            if (this.onStateChange) this.onStateChange(false);
            return;
          }
          if (this._restartAttempts >= 2) {
            this._recreateRecognition();
          }
          const delay = wasBenign
            ? 120
            : (this._restartAttempts <= 0
              ? 80
              : Math.min(3000, 160 * Math.pow(2, this._restartAttempts - 1)));

          this._setLifecycleState('restarting', 'Waiting for next command...');
          this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            if (!this.isListening || this.isPaused || this._pausedForTab || this._intentionalStop) return;
            this._startContentRecognition();
          }, delay);
        } else if (!this.isListening) {
          if (this.lifecycleState !== 'error') {
            this._setLifecycleState('idle', '');
          }
          if (this.onStateChange) this.onStateChange(false);
        }
      };
    }

    /**
     * Start listening to voice input.
     * Evaluates offscreen document if enabled, falling back cleanly to content-script recognition.
     */
    startListening(options = {}) {
      if (!options.preserveRetry) {
        this.resetAutoRetry();
        this._restartAttempts = 0;
      }
      if (options.singleUtterance !== true && this.continuousSession === false) {
        this.continuousSession = true;
      }
      this.lastConfidence = null;

      if (this._fallbackMode === 'iframe') {
        return this._startIframeFallback();
      }
      if (this._fallbackMode === 'relay') {
        return this._startExtensionRelayFallback();
      }

      if (this.useOffscreen && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'SLEEPWALKER_START_OFFSCREEN_VOICE', lang: this.activeLang },
          (res) => {
            if (chrome.runtime.lastError || !res || res.status !== 'started') {
              console.warn('[Sleepwalker Voice] Offscreen start unavailable; using content script recognition.');
              this.useOffscreen = false;
              this._selectAndStartSingleMicSource(options);
            }
          }
        );
        return true;
      }

      return this._selectAndStartSingleMicSource(options);
    }

    _selectAndStartSingleMicSource(options = {}) {
      const epoch = ++this._startEpoch;
      this.isListening = true;
      this.isPaused = false;
      this._pausedForTab = false;
      this._intentionalStop = false;

      // Fast synchronous check for http:// or Permissions-Policy: microphone=()
      const syncHardBlocked = this._isPageMicHardBlockedByBrowser();
      if (!syncHardBlocked && this._lastPageMicPerm === 'granted') {
        return this._startContentRecognition({ pagePerm: 'granted' });
      }

      this._setLifecycleState('starting', 'Starting microphone...');
      this._probeMicEnvironment().then(({ hardBlocked, pagePerm, extMicGranted }) => {
        if (epoch !== this._startEpoch || !this.isListening || this.isPaused || this._pausedForTab || this._intentionalStop) {
          return;
        }
        const hasExtRuntime = Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);

        // Case 1: Webpage hard-blocks microphone via http:// or Permissions-Policy: microphone=()
        if (hardBlocked) {
          if (hasExtRuntime && (extMicGranted || options.forceRelay)) {
            this._diag('hard_blocked_use_relay', { pagePerm });
            this._startExtensionRelayFallback();
            return;
          }
          this.isListening = false;
          this._lastErrorCode = 'not-allowed';
          this._setLifecycleState('error', 'Microphone blocked on this site');
          if (this.onError) {
            this.onError({
              error: 'not-allowed',
              message: hasExtRuntime
                ? 'This site blocks direct microphone access. Click Use Sleepwalker Mic below to enable voice on this site.'
                : 'Chrome only allows microphone access on HTTPS websites (or localhost). Use the Type input box below.',
              isPermissionDenied: true,
              isSiteBlocked: true
            });
          }
          return;
        }

        // Case 2: User/site explicitly has microphone permission set to 'denied' on this origin
        if (pagePerm === 'denied') {
          if (hasExtRuntime && extMicGranted) {
            this._diag('site_denied_use_iframe', {});
            this._startIframeFallback();
            return;
          }
          if (hasExtRuntime && options.forceRelay) {
            this._startExtensionRelayFallback();
            return;
          }
          this.isListening = false;
          this._lastErrorCode = 'not-allowed';
          this._setLifecycleState('error', 'Microphone blocked on this site');
          if (this.onError) {
            this.onError({
              error: 'not-allowed',
              message: 'Microphone access is blocked for this site. Click Use Sleepwalker Mic below, or allow Microphone in Chrome’s address bar.',
              isPermissionDenied: true,
              isSiteBlocked: true
            });
          }
          return;
        }

        // Case 3: Normal site ('granted', 'prompt', or 'unknown') -> strictly use in-page SpeechRecognition only!
        this._startContentRecognition({ pagePerm });
      });
      return true;
    }

    _startContentRecognition(meta = {}) {
      if (!this.isSupported) {
        this.isListening = false;
        this._setLifecycleState('error', 'Speech recognition not supported');
        if (this.onError) {
          this.onError({
            error: 'not-supported',
            message: 'Speech recognition is not supported in this browser. Please use the typed input box.',
            isPermissionDenied: false
          });
        }
        return false;
      }

      const pagePerm = meta.pagePerm || this._lastPageMicPerm || 'unknown';
      const awaitingPrompt = pagePerm === 'prompt';
      this._awaitingPermissionPrompt = awaitingPrompt;

      if (this._restartTimer) {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
      const wasStopping = Boolean(this._intentionalStop || this.lifecycleState === 'paused' || this.lifecycleState === 'idle');
      this.isListening = true;
      this.isPaused = false;
      this._pausedForTab = false;
      this._intentionalStop = false;
      this._benignRestart = false;
      this._lastStartAt = Date.now();

      // If previous recognition.stop() is still asynchronously winding down in Chrome,
      // queue an immediate start on onend (+ watchdog) instead of falsely returning while recognition dies!
      if (this._recognitionRunning) {
        if (wasStopping || this.lifecycleState !== 'listening') {
          this._pendingStartAfterStop = true;
          this._setLifecycleState('starting', 'Starting microphone...');
          if (this._startingWatchdogTimer) clearTimeout(this._startingWatchdogTimer);
          this._startingWatchdogTimer = setTimeout(() => {
            this._startingWatchdogTimer = null;
            if (!this._recognitionRunning || this.lifecycleState !== 'listening') {
              this._pendingStartAfterStop = false;
              this._startInFlight = false;
              this._recreateRecognition();
              this._startContentRecognition({ pagePerm: this._lastPageMicPerm });
            }
          }, 900);
          return true;
        }
        return true;
      }
      if (this._startInFlight) {
        return true;
      }
      this._startInFlight = true;

      this._setLifecycleState(
        'starting',
        awaitingPrompt ? 'Allow microphone in browser prompt...' : 'Starting microphone...'
      );
      const armStartWatchdog = () => {
        if (this._startingWatchdogTimer) clearTimeout(this._startingWatchdogTimer);
        // Never abort SpeechRecognition while Chrome is waiting on the user's permission prompt!
        if (this._awaitingPermissionPrompt || pagePerm !== 'granted') {
          return;
        }
        this._startingWatchdogTimer = setTimeout(() => {
          this._startingWatchdogTimer = null;
          if (this.lifecycleState === 'starting' && !this._recognitionRunning && !this._awaitingPermissionPrompt && this.isListening && !this.isPaused && !this._intentionalStop) {
            this._pendingStartAfterStop = false;
            this._startInFlight = false;
            this._recreateRecognition();
            this._setLifecycleState('recovering', 'Recovering microphone...');
            this._startContentRecognition({ pagePerm: 'granted' });
          }
        }, 1800);
      };

      try {
        if (!this.recognition) this._recreateRecognition();
        this.recognition.lang = this.activeLang;
        this.recognition.start();
        if (!this._recognitionRunning && this.lifecycleState === 'starting') armStartWatchdog();
        return true;
      } catch (err) {
        this._startInFlight = false;
        this._awaitingPermissionPrompt = false;
        const errName = (err && (err.name || err.message)) || '';
        if (/NotAllowedError|SecurityError/i.test(errName)) {
          this.isListening = false;
          this._lastErrorCode = 'not-allowed';
          this._setLifecycleState('error', 'Microphone permission needed');
          if (this.onError) {
            this.onError({
              error: 'not-allowed',
              message: 'Microphone permission is needed for this site. Click Allow Microphone below, or click Use Sleepwalker Mic.',
              isPermissionDenied: true
            });
          }
          return false;
        }
        if (/InvalidStateError/i.test(errName) && !this._recognitionRunning) {
          this._recreateRecognition();
          try {
            this._startInFlight = true;
            this.recognition.lang = this.activeLang;
            this.recognition.start();
            if (!this._recognitionRunning && this.lifecycleState === 'starting') armStartWatchdog();
            return true;
          } catch (_retryErr) {
            this._startInFlight = false;
          }
        }
        // Still finalizing a previous stop(): queue a start on onend, guarded by watchdog so 'starting' cannot deadlock
        this._pendingStartAfterStop = true;
        armStartWatchdog();
        return true;
      }
    }

    /**
     * Temporarily pause recognition (half-duplex while TTS speaks) without closing the session.
     */
    pauseTemporary() {
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      if (this._restartTimer) {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
      if (!this.isListening || this.isPaused) return false;
      this.isPaused = true;
      this._intentionalStop = true;
      this._pendingStartAfterStop = false;
      this._setLifecycleState('paused', 'Paused while speaking');
      if (this._fallbackMode === 'iframe') {
        this._postToIframe({ action: 'STOP' });
      } else if (this._fallbackMode === 'relay' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_PAUSE_EXT_VOICE_RELAY', lang: this.activeLang }, () => { void chrome.runtime?.lastError; });
      } else if (this.recognition) {
        try {
          this.recognition.stop();
        } catch (e) {}
      }
      this._stopLevelMonitor();
      if (this.onPauseChange) this.onPauseChange(true);
      return true;
    }

    /**
     * Resume recognition after a temporary half-duplex pause.
     */
    resumeAfterPause() {
      if (this._restartTimer) {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
      const wasPaused = this.isPaused;
      this.isPaused = false;
      this._intentionalStop = false;
      if (!this.isListening) return false;
      if (wasPaused && this.onPauseChange) this.onPauseChange(false);
      if (this._recognitionRunning) {
        this._pendingStartAfterStop = true;
        return true;
      }
      return this.startListening({ preserveRetry: true });
    }

    /**
     * Release microphone cleanly when this tab loses foreground focus (prevents multi-tab mic contention).
     */
    pauseForTabSwitch() {
      if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
      if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
      if (!this.isListening || this._pausedForTab) return false;
      this._pausedForTab = true;
      this._intentionalStop = true;
      this._pendingStartAfterStop = false;
      this._setLifecycleState('paused', 'Paused in background tab');
      if (this._fallbackMode === 'iframe') {
        this._postToIframe({ action: 'STOP' });
      } else if (this._fallbackMode === 'relay' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_PAUSE_EXT_VOICE_RELAY', lang: this.activeLang }, () => { void chrome.runtime?.lastError; });
      } else if (this.recognition) {
        try { this.recognition.stop(); } catch (_e) {}
      }
      this._stopLevelMonitor();
      return true;
    }

    /**
     * Re-acquire microphone when this tab becomes foreground active again.
     */
    resumeForTabSwitch() {
      if (!this._pausedForTab) return false;
      this._pausedForTab = false;
      this._intentionalStop = false;
      if (!this.isListening || this.isPaused) return false;
      if (this._recognitionRunning) {
        this._pendingStartAfterStop = true;
        return true;
      }
      return this.startListening({ preserveRetry: true });
    }

    /**
     * Stop listening to voice input.
     */
    stopListening(options = {}) {
      const preserveErrorState = Boolean(options && options.preserveErrorState);
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      if (this._restartTimer) {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
      if (this._stableResetTimer) {
        clearTimeout(this._stableResetTimer);
        this._stableResetTimer = null;
      }
      if (this._startingWatchdogTimer) {
        clearTimeout(this._startingWatchdogTimer);
        this._startingWatchdogTimer = null;
      }
      this._startEpoch += 1;
      this._awaitingPermissionPrompt = false;
      this.isListening = false;
      this.isPaused = false;
      this._pausedForTab = false;
      if (!preserveErrorState) {
        this.continuousSession = false;
      }
      this._restartAttempts = 0;
      this._intentionalStop = true;
      this._benignRestart = false;
      this._pendingStartAfterStop = false;
      if (!preserveErrorState) {
        this._setLifecycleState('idle', '');
      }

      if (this._fallbackMode === 'iframe') {
        this._postToIframe({ action: 'STOP' });
      }
      if (this._fallbackMode === 'relay' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'SLEEPWALKER_STOP_EXT_VOICE_RELAY',
          closeWindow: Boolean(options && options.closeRelayWindow)
        }, () => { void chrome.runtime?.lastError; });
      }
      if (this.useOffscreen && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_STOP_OFFSCREEN_VOICE' });
      }

      if (this.recognition) {
        try {
          this.recognition.stop();
        } catch (e) {}
      }
      this._stopLevelMonitor();
      if (this.onStateChange) this.onStateChange(false);
    }

    /**
     * Drive orb waveform without opening a competing getUserMedia stream alongside SpeechRecognition,
     * avoiding Windows/Bluetooth/USB microphone hardware contention while boosting on speech activity.
     */
    async _startLevelMonitor() {
      this._stopLevelMonitor();
      this._micMonitorActive = true;
      this._micBoost = 0;
      this.levelMode = 'synthetic_listening';

      if (!this._micMonitorActive || !this.isListening || this.isPaused) return;
      const step = () => {
        if (!this._micMonitorActive || !this.isListening || this.isPaused) return;
        if (typeof document === 'undefined' || !document.hidden) {
          const t = Date.now() / 1000;
          let level = 0.22 + 0.20 * Math.abs(Math.sin(t * 3.6) * Math.cos(t * 2.0));
          if (this._micBoost > 0.05) {
            level = Math.max(level, this._micBoost);
            this._micBoost *= 0.78;
          }
          if (typeof this.onLevel === 'function') this.onLevel(level, this.levelMode);
        }
        this._levelTimer = setTimeout(step, 75);
      };
      step();
    }

    _stopLevelMonitor() {
      this._micMonitorActive = false;
      this.levelMode = 'idle';
      this._micBoost = 0;
      if (this._levelTimer) {
        clearTimeout(this._levelTimer);
        this._levelTimer = 0;
      }
      if (this._levelRaf) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._levelRaf);
        else clearTimeout(this._levelRaf);
        this._levelRaf = 0;
      }
      if (this._micStream) {
        this._micStream.getTracks().forEach((t) => { try { t.stop(); } catch (_e) {} });
        this._micStream = null;
      }
      if (this._audioCtx && typeof this._audioCtx.close === 'function') {
        try { this._audioCtx.close(); } catch (_e) {}
      }
      this._audioCtx = null;
      this._analyser = null;
      this._analyserBuf = null;
      if (typeof this.onLevel === 'function') this.onLevel(0, 'idle');
    }

    /**
     * Stop listening and immediately execute pending transcript (used by Hold-to-Talk on release).
     * @returns {Object|null} The parsed command or null.
     */
    stopListeningAndCommit() {
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      const pending = (this.lastInterim || '').trim();
      const meta = {
        confidence: null,
        activeLang: this.activeLang,
        mode: this.mode,
        isInterimCommit: true
      };
      this.lastInterim = '';
      this.stopListening();

      if (pending.length > 0) {
        const parsed = this.parseCommand(pending);
        parsed.confidence = null;
        parsed.activeLang = meta.activeLang;
        parsed.mode = meta.mode;
        this._emitCommandDeduped(pending, meta);
        return parsed;
      }
      return null;
    }

    /**
     * Toggle listening state.
     */
    toggleListening() {
      if (this.isListening) {
        this.stopListening();
        return false;
      } else {
        return this.startListening();
      }
    }

    /**
     * Change recognition language/mode ('auto', 'en-IN', 'hi-IN', 'ta-IN', etc.).
     */
    setLang(newLang) {
      const normalized = this.normalizeLangCode(newLang);
      this.mode = normalized;
      this.lang = normalized;
      this._autoRetriedEn = false;
      this.activeLang = this.resolveSpeechLang(normalized);
      this.lastConfidence = null;

      if (this._fallbackMode === 'iframe') {
        this._postToIframe({ action: 'SET_LANG', lang: this.activeLang });
      } else if (this._fallbackMode === 'relay' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_START_EXT_VOICE_RELAY', lang: this.activeLang }, () => { void chrome.runtime?.lastError; });
      } else if (this.recognition) {
        this.recognition.lang = this.activeLang;
        // If listening, restart with new language without penalizing crash backoff
        if (this.isListening) {
          this._benignRestart = true;
          try {
            this.recognition.stop();
          } catch (e) {}
        }
      }
    }

    setLanguage(newLang) {
      return this.setLang(newLang);
    }

    _editDistSmall(a, b) {
      if (a === b) return 0;
      const m = a.length;
      const n = b.length;
      if (Math.abs(m - n) > 2) return 9;
      // Optimal String Alignment (Damerau-Levenshtein) so adjacent transpositions ("strat", "puase", "cancle", "resuem") = 1
      const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          let v = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
            v = Math.min(v, dp[i - 2][j - 2] + 1);
          }
          dp[i][j] = v;
        }
      }
      return dp[m][n];
    }

    _normalizeCommandTypos(clean) {
      let s = String(clean || '')
        .replace(/\breadthis\b/g, 'read this')
        .replace(/\bout\s+line\b/g, 'outline')
        .replace(/\bhold\s+o\b/g, 'hold on')
        .replace(/\bshut\s+u\b/g, 'shut up')
        .replace(/\bread\s+al\b/g, 'read all');

      const EXACT_SLIPS = {
        red: 'read', raed: 'read', reed: 'read', tis: 'this', ths: 'this', pge: 'page',
        wat: 'what', shw: 'show', tak: 'take', kep: 'keep', ply: 'play', opn: 'open',
        opin: 'open', clik: 'click', scrol: 'scroll', selct: 'select', expln: 'explain',
        sumrize: 'summarize', paus: 'pause', stpo: 'stop', stpp: 'stop', qiet: 'quiet'
      };
      const FUZZY_KEYWORDS = [
        'read', 'page', 'this', 'outline', 'headings', 'section', 'sections', 'contents', 'content',
        'explain', 'summarize', 'summarise', 'pause', 'stop', 'cancel', 'resume', 'continue',
        'repeat', 'again', 'start', 'reading', 'open', 'click', 'scroll', 'select', 'navigate',
        'quiet', 'help', 'commands'
      ];
      // Never mutate valid Kannada/Hindi/English words that happen to be edit-distance 1 from a keyword
      const PROTECTED_WORDS = new Set([
        'heli', 'karo', 'padho', 'batao', 'sunao', 'some', 'part', 'more', 'here', 'open',
        'read', 'page', 'this', 'section', 'sections', 'help', 'stop', 'pause', 'play', 'wait',
        'down', 'over', 'back', 'next', 'home', 'menu', 'link', 'text', 'list', 'card', 'form'
      ]);

      const words = s.split(/\s+/).filter(Boolean);
      const fixed = words.map((w) => {
        if (/[^\x00-\x7F]/.test(w)) return w; // Keep Devanagari/Kannada/Unicode untouched
        if (w === 'wat' && words.length === 1) return 'wait';
        if (EXACT_SLIPS[w]) return EXACT_SLIPS[w];
        if (w.length < 4 || PROTECTED_WORDS.has(w) || FUZZY_KEYWORDS.includes(w)) return w;
        const maxD = w.length >= 7 ? 2 : 1;
        let best = w;
        let bestD = 9;
        for (const kw of FUZZY_KEYWORDS) {
          if (Math.abs(kw.length - w.length) > maxD) continue;
          if (kw[0] !== w[0] && !(kw[0] === w[1] && kw[1] === w[0])) continue;
          const d = this._editDistSmall(w, kw);
          if (d <= maxD && d < bestD) {
            bestD = d;
            best = kw;
          }
        }
        return best;
      });
      return fixed.join(' ');
    }

    /**
     * Parse raw spoken or typed text into an actionable command object.
     * Supports English (with ASR typo tolerance), Devanagari Hindi, Romanized Hindi, Hinglish, and Kannada.
     * @param {string} raw - Input string.
     * @returns {Object} { type: string, raw: string, sectionQuery?: string }
     */
    parseCommand(raw) {
      if (!raw) return { type: 'UNKNOWN', raw: '' };

      const rawLower = raw.toLowerCase().replace(/[?!.,।]+$/g, '').replace(/\s+/g, ' ').trim();
      const clean = this._normalizeCommandTypos(rawLower);

      // 1. HELP (EN / Devanagari / Romanized HI / Hinglish / Kannada)
      if (
        /^(?:help(?:\s+(?:me|karo|chahiye))?|commands|what\s+can\s+(?:you|i)\s+do(?:\s+here)?(?:\s+batao)?|how\s+to\s+use|say\s+more(?:\s+please)?|aur\s+options\s+batao|मदद|सहायता|हेल्प|क्या\s+कर\s+सकते\s+हो)$/i.test(clean) ||
        /^(?:madad(?:\s+karo)?|sahayata|kya\s+kar\s+sakte\s+ho|kya\s+commands\s+hain)$/i.test(clean) ||
        /^(?:ಸಹಾಯ(?:\s+ಮಾಡಿ)?|ಏನು\s+ಮಾಡಬಹುದು|sahaya(?:\s+maadi)?|enu\s+madbahudu)$/i.test(clean) ||
        clean === 'help' || clean === 'मदद'
      ) {
        return { type: 'HELP', raw };
      }

      // 2. STOP (EN / Devanagari / Romanized HI / Hinglish / Kannada)
      if (
        /^(?:stop(?:\s+(?:reading|kar\s+do|maadi))?|cancel(?:\s+kar\s+do)?|shut\s+up|be\s+quiet|sleepwalker\s+rest(?:\s+karo)?|बंद\s+करो|स्टॉप|खत्म\s+करो|शांत|बंद)$/i.test(clean) ||
        /^(?:band\s+karo|band\s+kar\s+do|chup\s+raho|shant|khatam\s+karo|ನಿಲ್ಲಿಸಿ|ಬೇಡ|ರದ್ದು\s+ಮಾಡಿ|nillisi)$/i.test(clean)
      ) {
        return { type: 'STOP', raw };
      }

      // 3. PAUSE (EN / Devanagari / Romanized HI / Hinglish / Kannada)
      if (
        /^(?:pause(?:\s+reading)?|reading\s+pause\s+karo|hold\s+on|wait|रोको|पॉज़|ठहरो|रुकिए)$/i.test(clean) ||
        /^(?:ruko|roko|thoda\s+ruko|thehro|ತಡೆಯಿರಿ|tadeyiri)$/i.test(clean)
      ) {
        return { type: 'PAUSE', raw };
      }

      // 4. RESUME (EN / Devanagari / Romanized HI / Hinglish / Kannada)
      if (
        /^(?:resume(?:\s+kar\s+do)?|continue(?:\s+karo)?|keep\s+reading|play|जारी\s+रखो|आगे\s+पढ़ो|फिर\s+से\s+शुरू)$/i.test(clean) ||
        /^(?:aage\s+padho|jari\s+rakho|ಮುಂದುವರಿಸಿ|munduvarisi)$/i.test(clean)
      ) {
        return { type: 'RESUME', raw };
      }

      // 5. READ IT AGAIN (EN / Devanagari / Romanized HI / Hinglish / Kannada)
      if (
        /^(?:read\s+it\s+again|read\s+again(?:\s+please)?|repeat(?:\s+(?:kar\s+do|maadi))?|from\s+the\s+beginning|start\s+over|फिर\s+से\s+पढ़ो|दोहराओ|शुरू\s+से\s+पढ़ो|दोबारा\s+पढ़ो)$/i.test(clean) ||
        /^(?:phir\s+se\s+(?:padho|batao)|dobara\s+padho|shuru\s+se\s+(?:padho|sunao)|ಮತ್ತೆ\s+ಓದಿ|matte\s+odi)$/i.test(clean)
      ) {
        return { type: 'READ_AGAIN', raw };
      }

      // 6. READ THIS PAGE (EN / Devanagari / Romanized HI / Hinglish / Kannada)
      if (
        /^(?:(?:please\s+)?(?:read\s+(?:this\s+page|the\s+page|page|all|content)|start\s+reading)|यह\s+पेज\s+पढ़ो|इस\s+पेज\s+को\s+पढ़ो|पेज\s+पढ़ो|पेज\s+सुनाओ|पूरा\s+पढ़ो|पढ़ना\s+शुरू\s+करो|सुनाओ)$/i.test(clean) ||
        /^(?:(?:please\s+)?(?:yeh|ye|is|full|pura)?\s*(?:page|article)?\s*(?:ko\s+)?(?:read\s+kar(?:\s+do|o)|padho|padh\s+ke\s+sunao|sunao)|padhna\s+shuru\s+karo)$/i.test(clean) ||
        /^(?:ಈ\s+ಪುಟ\s+ಓದಿ|ಪುಟ\s+ಓದಿ|ಪೂರ್ತಿ\s+ಓದಿ|ಓದಲು\s+ಶುರು\s+ಮಾಡಿ|ಓದಿ|ee\s+(?:page|puta)\s+odi|page\s+odi|poora\s+odi|odri)$/i.test(clean) ||
        clean === 'read' || clean === 'पढ़ो'
      ) {
        return { type: 'READ_PAGE', raw };
      }

      // 7. OUTLINE (EN / Devanagari / Romanized HI / Hinglish / Kannada)
      if (
        /^(?:outline(?:\s+(?:show\s+karo|dikhao|batao|torisi))?|show\s+outline|headings(?:\s+(?:dikhao|batao|torisi))?|show\s+headings|table\s+of\s+contents|sections(?:\s+(?:dikhao|heli))?|show\s+sections|sab\s+headings\s+batao|vishay\s+suchi|ruprekha|shirshak(?:\s+dikhao)?|आउटलाइन|रूपरेखा|हेडिंग|शीर्षक|विषय\s+सूची|ಶೀರ್ಷಿಕೆಗಳು|ವಿಷಯ\s+ಸೂಚಿ|ವಿಭಾಗಗಳು\s+ತೋರಿಸಿ)$/i.test(clean)
      ) {
        return { type: 'OUTLINE', raw };
      }

      // 8. EXPLAIN SOME PART OF PAGE (Generic request to explore a section)
      if (
        /^(?:explain|summarise|summarize)\s+(?:some\s+part|a\s+part|part|some\s+section|a\s+section)(?:\s+of\s+(?:the\s+|this\s+)?page)?$/i.test(clean) ||
        /^(?:tell\s+me\s+about|what\s+is\s+in)\s+(?:some\s+part|a\s+part|some\s+section)(?:\s+of\s+(?:the\s+|this\s+)?page)?$/i.test(clean) ||
        /^(?:पेज\s+का\s+कुछ\s+भाग\s+समझाओ|कोई\s+भाग\s+समझाओ|कोई\s+सेक्शन\s+समझाओ)$/i.test(clean)
      ) {
        return { type: 'EXPLAIN_SOME_PART', raw };
      }

      // 9. EXPLAIN THIS PAGE (Whole page summary — EN / HI / Hinglish / Kannada)
      if (
        /^(?:explain\s+(?:this\s+|the\s+)?page|summarise\s+(?:this\s+|the\s+)?page|summarize\s+(?:this\s+|the\s+)?page|what\s+is\s+this\s+page\s+about|इस\s+पेज\s+को\s+समझाओ|पेज\s+समझाओ|यह\s+पेज\s+किस\s+बारे\s+में\s+है|पेज\s+का\s+सारांश)$/i.test(clean) ||
        /^(?:(?:yeh|ye|is)\s+(?:page|website)\s+(?:ko\s+)?(?:samjhao|summarize\s+karo|explain\s+karo)|page\s+(?:samjhao|ka\s+(?:saransh|summary\s+batao))|yeh\s+page\s+kis\s+baare\s+mein\s+hai|samjhao)$/i.test(clean) ||
        /^(?:ಈ\s+ಪುಟ\s+ವಿವರಿಸಿ|ಸಾರಾಂಶ\s+ಹೇಳಿ|ವಿವರಿಸಿ|ಈ\s+ಪುಟ\s+ಯಾವುದರ\s+ಬಗ್ಗೆ|ee\s+page\s+(?:vivarisi|bagge\s+heli)|saramsha\s+heli|explain\s+maadi)$/i.test(clean) ||
        clean === 'explain' || clean === 'summarise' || clean === 'summarize' || clean === 'समझाओ'
      ) {
        return { type: 'EXPLAIN', raw };
      }

      // 10. EXPLAIN A SPECIFIC SECTION (EN / Devanagari / Romanized HI / Hinglish)
      let explainSecMatch =
        clean.match(/^(?:explain|summarise|summarize)\s+(?:about\s+)?(?:the\s+)?(?:section\s+)?(.+?)(?:\s+section)?$/i) ||
        clean.match(/^(?:tell\s+me\s+about|what\s+is)\s+(?:the\s+)?(.+?)(?:\s+section)?$/i) ||
        clean.match(/^(.+?)\s+(?:section\s+)?(?:samjhao|explain\s+kar(?:\s+do|o)|ke\s+baare\s+mein\s+batao)$/i);

      if (explainSecMatch && explainSecMatch[1]) {
        const query = explainSecMatch[1].trim();
        if (!['this page', 'the page', 'page', 'yeh page', 'ye page', 'is page', 'in simple words', 'in hindi', 'in english', 'all', 'everything', 'it'].includes(query)) {
          return { type: 'EXPLAIN_SECTION', raw, sectionQuery: query };
        }
      }

      // Devanagari explain section
      const hiExplainMatch = clean.match(/^(.+?)\s+(?:सेक्शन\s+)?(?:समझाओ|के बारे में बताओ)$/i);
      if (hiExplainMatch && !['यह पेज', 'पेज', 'पूरा', 'सब'].includes(hiExplainMatch[1].trim())) {
        return { type: 'EXPLAIN_SECTION', raw, sectionQuery: hiExplainMatch[1].trim() };
      }

      // 11. NAVIGATE SOME PART OF PAGE
      if (
        /^(?:take\s+me\s+(?:to\s+)?|navigate\s+(?:to\s+)?|scroll\s+(?:to\s+)?|jump\s+(?:to\s+)?|go\s+(?:to\s+)?)(?:some\s+part|a\s+part|part|some\s+section|a\s+section)(?:\s+of\s+(?:the\s+|this\s+)?page)?$/i.test(clean) ||
        /^(?:किसी\s+भाग\s+पर\s+ले\s+चलो|पेज\s+के\s+किसी\s+भाग\s+पर\s+ले\s+चलो|कोई\s+सेक्शन\s+दिखाओ)$/i.test(clean)
      ) {
        return { type: 'NAVIGATE_SOME_PART', raw };
      }

      // 12. NAVIGATE TO SPECIFIC SECTION / ELEMENT (EN / Devanagari / Romanized HI / Hinglish / Kannada)
      let navMatch =
        clean.match(/^(?:take\s+me\s+(?:to\s+)?|navigate\s+(?:to\s+)?|scroll\s+to\s+|jump\s+(?:to\s+)?|go\s+to\s+|open\s+|show\s+(?:me\s+)?)(?:the\s+)?(.+?)(?:\s+section)?$/i) ||
        clean.match(/^(.+?)\s+(?:section\s+)?(?:kholo|dikhao|par\s+le\s+chalo|pe\s+le\s+chalo|par\s+jao|pe\s+jao|pe\s+scroll\s+karo|open\s+kar(?:\s+do|o)|click\s+kar(?:\s+do|o)|select\s+kar(?:\s+do|o)|on\s+karo|chuno)$/i) ||
        clean.match(/^(.+?)\s+(?:ತೆರೆಯಿರಿ|tereyiri)$/i);
      if (navMatch && navMatch[1]) {
        const navTarget = navMatch[1].trim();
        if (!['this page', 'the page', 'page', 'home', 'top'].includes(navTarget)) {
          return {
            type: 'NAVIGATE_SECTION',
            raw,
            sectionQuery: navTarget
          };
        }
      }
      if (/^(?:niche\s+le\s+chalo|upar\s+le\s+chalo|scroll\s+(?:down|up)\s+kar(?:\s+do|o)|back\s+jao|page\s+reload\s+karo|top\s+pe\s+le\s+chalo|footer\s+pe\s+jao|ಮುಂದಿನ\s+ಪುಟ|ಹಿಂದಿನ\s+ಪುಟ|ಕೆಳಗೆ\s+ಸ್ಕ್ರಾಲ್\s+ಮಾಡಿ|ಮೇಲೆ\s+ಹೋಗಿ|mundina\s+puta|hindina\s+puta|kelage\s+scroll\s+maadi|mele\s+hogi)$/i.test(clean)) {
        return { type: 'NAVIGATE_SECTION', raw, sectionQuery: clean };
      }

      // Devanagari navigate to section
      const hiNavMatch = clean.match(/^(.+?)\s+(?:सेक्शन\s+)?(?:पर\s+ले\s+चलो|पर\s+जाओ|दिखाओ|खोलो)$/i);
      if (hiNavMatch && !['यह पेज', 'पेज', 'पूरा'].includes(hiNavMatch[1].trim())) {
        return {
          type: 'NAVIGATE_SECTION',
          raw,
          sectionQuery: hiNavMatch[1].trim()
        };
      }

      // 13. READ THE <SECTION> SECTION (EN / Devanagari / Hinglish)
      let sectionMatch =
        clean.match(/^read\s+(?:the\s+)?(.+?)\s+section$/i) ||
        clean.match(/^read\s+section\s+(.+)$/i) ||
        clean.match(/^(.+?)\s+section\s+(?:read\s+kar(?:\s+do|o)|padho|sunao)$/i) ||
        clean.match(/^(.+?)\s+read\s+kar(?:\s+do|o)$/i);
      if (!sectionMatch && clean.startsWith('read ')) {
        const afterRead = clean.replace(/^read\s+/, '').trim();
        if (afterRead && !['this page', 'the page', 'page', 'again', 'it again', 'all', 'everything'].includes(afterRead)) {
          sectionMatch = [null, afterRead];
        }
      }

      // Devanagari section patterns
      if (!sectionMatch) {
        const hiSectionMatch = clean.match(/^(.+?)\s+(?:सेक्शन\s+)?पढ़ो$/i);
        if (hiSectionMatch && !['यह पेज', 'पेज', 'पूरा', 'फिर से'].includes(hiSectionMatch[1].trim())) {
          sectionMatch = [null, hiSectionMatch[1].trim()];
        }
      }

      if (sectionMatch && sectionMatch[1]) {
        return {
          type: 'READ_SECTION',
          raw,
          sectionQuery: sectionMatch[1].trim()
        };
      }

      // Fallback: potential section/page search query
      if (clean.length > 2) {
        return {
          type: 'QUERY_OR_SEARCH',
          raw,
          sectionQuery: clean
        };
      }

      return { type: 'UNKNOWN', raw };
    }

    /**
     * Split natural compound multi-step commands ("open Services then click Passport Offices",
     * "settings kholo aur dark theme on karo") while preserving single-entity names ("Terms and Conditions").
     */
    parseCompoundSteps(raw) {
      const text = String(raw || '').replace(/^\s*(?:first|pehle|पहले)\s+/i, '').trim();
      if (!text || text.length < 8) return [];
      // Do not split declarative teaching commands
      if (/^(?:teach|remember|learn|sikho|सीखो)/i.test(text)) return [];
      const parts = text
        .split(/\s*(?:,\s*then\s+|\s+and\s+then\s+|\s+then\s+|\s*;\s*|\s+फिर\s+|\s+phir\s+|\s+aur\s+phir\s+|\s+के\s+बाद\s+)\s*/i)
        .map((p) => p.replace(/^(?:next|after\s+that|uske\s+baad)\s+/i, '').trim())
        .filter((p) => p.length >= 2);
      if (parts.length >= 2) return parts.slice(0, 6);

      // Also support "<action A> and <action B>" ONLY when RHS starts with a clear action verb
      const andMatch = text.match(/^(.+?)\s+(?:and|aur|और)\s+((?:open|click|select|go\s+to|scroll|read|explain|show|type|fill|search|press|tap|kholo|dabao|padho|batao)\b.+)$/i);
      if (andMatch && andMatch[1].trim().length >= 3 && andMatch[2].trim().length >= 3) {
        return [andMatch[1].trim(), andMatch[2].trim()];
      }
      return [];
    }
  }

  window.SleepwalkerVoice = SleepwalkerVoice;
})();
