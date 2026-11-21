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
    'hi-IN',
    'ta-IN',
    'te-IN',
    'bn-IN',
    'mr-IN',
    'gu-IN',
    'kn-IN',
    'ml-IN',
    'pa-IN'
  ]);

  const LANG_ALIASES = {};
  SUPPORTED_LANGS.forEach((code) => {
    LANG_ALIASES[code.toLowerCase()] = code;
  });

  const AUTO_DEFAULT_LANG = 'hi-IN';
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
      this.useOffscreen = false;

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
     * Listen for speech events relayed from the background offscreen document.
     */
    initOffscreenListener() {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((message) => {
          if (!message) return;

          if (message.type === 'OFFSCREEN_TRANSCRIPT') {
            if (message.interim && this.onTranscript) {
              this.onTranscript({
                text: message.interim,
                isFinal: false,
                confidence: null,
                activeLang: this.activeLang,
                mode: this.mode
              });
            }
            if (message.final) {
              const confidence = typeof message.confidence === 'number' ? message.confidence : null;
              this.lastConfidence = confidence;
              const meta = {
                confidence,
                activeLang: this.activeLang,
                mode: this.mode
              };
              if (this.onTranscript) {
                this.onTranscript({ text: message.final, isFinal: true, ...meta });
              }
              const parsed = this.parseCommand(message.final);
              parsed.confidence = confidence;
              parsed.activeLang = this.activeLang;
              parsed.mode = this.mode;
              if (this.onCommand) {
                this.onCommand(parsed, meta);
              }
            }
          } else if (message.type === 'OFFSCREEN_ERROR') {
            console.warn('[Sleepwalker Voice] Offscreen recognition failed:', message.error);
            // Fallback automatically to content script recognition
            this.useOffscreen = false;
          } else if (message.type === 'OFFSCREEN_STATE_CHANGE') {
            if (this.onStateChange) {
              this.onStateChange(message.isListening);
            }
          }
        });
      }
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
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
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
      this.recognition.maxAlternatives = 1;
      this.recognition.lang = this.activeLang;

      this.recognition.onstart = () => {
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

        for (let i = baseIdx; i < event.results.length; ++i) {
          const result = event.results[i];
          const alt = result && result[0];
          if (!alt) continue;
          const transcript = alt.transcript || '';
          if (result.isFinal) {
            if (event.results.length > 1 && this._finalizedResults.get(i) === transcript) {
              continue;
            }
            this._finalizedResults.set(i, transcript);
            finalTranscript += transcript;
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
          }
        }

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
          this.onTranscript({
            text: interimTranscript.trim(),
            isFinal: false,
            confidence: null,
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
                const meta = {
                  confidence: null,
                  activeLang: this.activeLang,
                  mode: this.mode,
                  isInterimCommit: true
                };
                this.lastInterim = '';
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
            isPermissionDenied = true;
            this.isListening = false;
            this._setLifecycleState('error', 'Microphone permission denied');
            userMessage = (typeof window !== 'undefined' && window.isSecureContext === false)
              ? 'Chrome requires an HTTPS webpage (or localhost) for microphone access. Open an https:// page or use the typed input box below.'
              : 'Microphone permission was blocked for this site. Click Allow Microphone below, or click the site icon in Chrome’s address bar -> Allow Microphone.';
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
          this.lastInterim = '';
          this._lastInterimCommit = { text: pendingText.toLowerCase(), time: Date.now() };
          const meta = {
            confidence: null,
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
      this.lastConfidence = null;

      if (this.useOffscreen && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'SLEEPWALKER_START_OFFSCREEN_VOICE', lang: this.activeLang },
          (res) => {
            if (chrome.runtime.lastError || !res || res.status !== 'started') {
              console.warn('[Sleepwalker Voice] Offscreen start unavailable; using content script recognition.');
              this.useOffscreen = false;
              this._startContentRecognition();
            }
          }
        );
        return true;
      }

      return this._startContentRecognition();
    }

    _startContentRecognition() {
      if (!this.isSupported) {
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

      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        this._lastErrorCode = 'insecure-context';
        this.isListening = false;
        this._setLifecycleState('error', 'HTTPS required for microphone');
        if (this.onError) {
          this.onError({
            error: 'not-allowed',
            message: 'Chrome only allows microphone access on HTTPS websites (or localhost). Open an https:// page or use the typed input box below.',
            isPermissionDenied: true
          });
        }
        return false;
      }

      if (this._restartTimer) {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
      this.isListening = true;
      this.isPaused = false;
      this._intentionalStop = false;
      this._benignRestart = false;
      this._lastStartAt = Date.now();

      // Prevent duplicate simultaneous recognition.start() calls
      if (this._recognitionRunning || this.lifecycleState === 'starting') {
        if (this._recognitionRunning && this.lifecycleState !== 'listening') {
          this._setLifecycleState('listening', 'Listening...');
        }
        return true;
      }

      this._setLifecycleState('starting', 'Starting microphone...');
      const armStartWatchdog = () => {
        if (this._startingWatchdogTimer) clearTimeout(this._startingWatchdogTimer);
        this._startingWatchdogTimer = setTimeout(() => {
          this._startingWatchdogTimer = null;
          if (this.lifecycleState === 'starting' && !this._recognitionRunning && this.isListening && !this.isPaused && !this._intentionalStop) {
            this._pendingStartAfterStop = false;
            this._recreateRecognition();
            this._setLifecycleState('recovering', 'Recovering microphone...');
            this._startContentRecognition();
          }
        }, 1200);
      };

      try {
        if (!this.recognition) this._recreateRecognition();
        this.recognition.lang = this.activeLang;
        this.recognition.start();
        if (!this._recognitionRunning && this.lifecycleState === 'starting') armStartWatchdog();
        return true;
      } catch (err) {
        const errName = (err && (err.name || err.message)) || '';
        if (/NotAllowedError|SecurityError/i.test(errName)) {
          this.isListening = false;
          this._lastErrorCode = 'not-allowed';
          this._setLifecycleState('error', 'Microphone permission denied');
          if (this.onError) {
            this.onError({
              error: 'not-allowed',
              message: 'Microphone permission is needed for this site. Click Allow Microphone below, or allow Microphone in Chrome’s address bar.',
              isPermissionDenied: true
            });
          }
          return false;
        }
        if (/InvalidStateError/i.test(errName) && !this._recognitionRunning) {
          this._recreateRecognition();
          try {
            this.recognition.lang = this.activeLang;
            this.recognition.start();
            if (!this._recognitionRunning && this.lifecycleState === 'starting') armStartWatchdog();
            return true;
          } catch (_retryErr) {}
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
      if (this.recognition) {
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
      if (this.recognition) {
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
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(() => fn(Date.now()), 50);
      const step = (ts) => {
        if (!this._micMonitorActive || !this.isListening || this.isPaused) return;
        const t = (ts || Date.now()) / 1000;
        let level = 0.24 + 0.22 * Math.abs(Math.sin(t * 3.8) * Math.cos(t * 2.1));
        if (this._micBoost > 0.05) {
          level = Math.max(level, this._micBoost);
          this._micBoost *= 0.88;
        }
        if (typeof this.onLevel === 'function') this.onLevel(level, this.levelMode);
        this._levelRaf = raf(step);
      };
      this._levelRaf = raf(step);
    }

    _stopLevelMonitor() {
      this._micMonitorActive = false;
      this.levelMode = 'idle';
      this._micBoost = 0;
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

      if (this.recognition) {
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

    /**
     * Parse raw spoken or typed text into an actionable command object.
     * Supports both English (en-IN) and Hindi (hi-IN).
     * @param {string} raw - Input string.
     * @returns {Object} { type: string, raw: string, sectionQuery?: string }
     */
    parseCommand(raw) {
      if (!raw) return { type: 'UNKNOWN', raw: '' };

      const clean = raw.toLowerCase().trim();

      // 1. HELP
      // EN: help, commands, what can you do
      // HI: मदद, सहायता, हेल्प, क्या कर सकते हो
      if (
        /^(help|commands|what can you do|how to use|मदद|सहायता|हेल्प)/i.test(clean) ||
        clean === 'help' || clean === 'मदद'
      ) {
        return { type: 'HELP', raw };
      }

      // 2. STOP
      // EN: stop, stop reading, cancel, shut up, quiet
      // HI: बंद करो, रुको, स्टॉप, खत्म करो, शांत
      if (
        /^(stop|cancel|shut up|be quiet|बंद करो|स्टॉप|खत्म करो|शांत)/i.test(clean) ||
        clean === 'stop' || clean === 'बंद'
      ) {
        return { type: 'STOP', raw };
      }

      // 3. PAUSE
      // EN: pause, pause reading, hold on, wait
      // HI: रोको, पॉज़, ठहरिए, रुकिए
      if (
        /^(pause|hold on|wait|रोको|पॉज़|ठहरो|रुकिए)/i.test(clean) ||
        clean === 'pause' || clean === 'रुकिए'
      ) {
        return { type: 'PAUSE', raw };
      }

      // 4. RESUME
      // EN: resume, continue, keep reading, play
      // HI: जारी रखो, आगे पढ़ो, शुरू करो, फिर से शुरू
      if (
        /^(resume|continue|keep reading|play|जारी रखो|आगे पढ़ो|फिर से शुरू)/i.test(clean) ||
        clean === 'resume' || clean === 'continue'
      ) {
        return { type: 'RESUME', raw };
      }

      // 5. READ IT AGAIN
      // EN: read it again, read again, repeat, from the beginning, start over
      // HI: फिर से पढ़ो, दोहराओ, शुरू से पढ़ो, दोबारा पढ़ो
      if (
        /^(read it again|read again|repeat|from the beginning|start over|फिर से पढ़ो|दोहराओ|शुरू से पढ़ो|दोबारा पढ़ो)/i.test(clean)
      ) {
        return { type: 'READ_AGAIN', raw };
      }

      // 6. READ THIS PAGE
      // EN: read this page, read page, start reading, read all, read
      // HI: यह पेज पढ़ो, पेज पढ़ो, पूरा पढ़ो, पढ़ो, सुनाओ
      if (
        /^(read this page|read page|read all|start reading|read content|यह पेज पढ़ो|पेज पढ़ो|पूरा पढ़ो|सुनाओ)/i.test(clean) ||
        clean === 'read' || clean === 'पढ़ो'
      ) {
        return { type: 'READ_PAGE', raw };
      }

      // 7. OUTLINE
      // EN: outline, show outline, headings, table of contents, sections
      // HI: आउटलाइन, रूपरेखा, हेडिंग, शीर्षक, विषय सूची
      if (
        /^(outline|show outline|headings|show headings|table of contents|sections|आउटलाइन|रूपरेखा|हेडिंग|शीर्षक|विषय सूची)/i.test(clean) ||
        clean === 'outline' || clean === 'headings'
      ) {
        return { type: 'OUTLINE', raw };
      }

      // 8. EXPLAIN SOME PART OF PAGE (Generic request to explore a section)
      // EN: "explain some part of page", "explain some part of the page", "explain a section", "explain part of page"
      // HI: "पेज का कुछ भाग समझाओ", "कोई भाग समझाओ", "कोई सेक्शन समझाओ"
      if (
        /^(?:explain|summarise|summarize)\s+(?:some\s+part|a\s+part|part|some\s+section|a\s+section)(?:\s+of\s+(?:the\s+|this\s+)?page)?$/i.test(clean) ||
        /^(?:tell\s+me\s+about|what\s+is\s+in)\s+(?:some\s+part|a\s+part|some\s+section)(?:\s+of\s+(?:the\s+|this\s+)?page)?$/i.test(clean) ||
        /^(?:पेज का कुछ भाग समझाओ|कोई भाग समझाओ|कोई सेक्शन समझाओ)$/i.test(clean)
      ) {
        return { type: 'EXPLAIN_SOME_PART', raw };
      }

      // 9. EXPLAIN THIS PAGE (Whole page summary)
      // EN: explain this page, explain the page, summarise this page, summarize this page, what is this page about, or lone "explain"
      // HI: इस पेज को समझाओ, पेज समझाओ, यह पेज किस बारे में है, पेज का सारांश, समझाओ
      if (
        /^(?:explain\s+(?:this\s+|the\s+)?page|summarise\s+(?:this\s+|the\s+)?page|summarize\s+(?:this\s+|the\s+)?page|what\s+is\s+this\s+page\s+about|इस पेज को समझाओ|पेज समझाओ|यह पेज किस बारे में है|पेज का सारांश)$/i.test(clean) ||
        clean === 'explain' || clean === 'summarise' || clean === 'summarize' || clean === 'समझाओ'
      ) {
        return { type: 'EXPLAIN', raw };
      }

      // 10. EXPLAIN A SPECIFIC SECTION
      // EN: "explain the <name> section", "explain section <name>", "explain about <name>", "explain <name>", "tell me about <name>"
      // HI: "<name> समझाओ", "<name> सेक्शन समझाओ", "<name> के बारे में बताओ", "<name> क्या है"
      let explainSecMatch =
        clean.match(/^(?:explain|summarise|summarize)\s+(?:about\s+)?(?:the\s+)?(?:section\s+)?(.+?)(?:\s+section)?$/i) ||
        clean.match(/^(?:tell\s+me\s+about|what\s+is)\s+(?:the\s+)?(.+?)(?:\s+section)?$/i);

      if (explainSecMatch && explainSecMatch[1]) {
        const query = explainSecMatch[1].trim();
        if (!['this page', 'the page', 'page', 'in simple words', 'in hindi', 'in english', 'all', 'everything', 'it'].includes(query)) {
          return { type: 'EXPLAIN_SECTION', raw, sectionQuery: query };
        }
      }

      // Hindi explain section
      const hiExplainMatch = clean.match(/^(.+?)\s+(?:सेक्शन\s+)?(?:समझाओ|के बारे में बताओ)$/i);
      if (hiExplainMatch && !['यह पेज', 'पेज', 'पूरा', 'सब'].includes(hiExplainMatch[1].trim())) {
        return { type: 'EXPLAIN_SECTION', raw, sectionQuery: hiExplainMatch[1].trim() };
      }

      // 11. NAVIGATE SOME PART OF PAGE (Generic request to take user to a part of page)
      // EN: "take me some part of page", "take me to some part of the page", "take me to a section", "jump to some part"
      // HI: "किसी भाग पर ले चलो", "पेज के किसी भाग पर ले चलो", "कोई सेक्शन दिखाओ"
      if (
        /^(?:take\s+me\s+(?:to\s+)?|navigate\s+(?:to\s+)?|scroll\s+(?:to\s+)?|jump\s+(?:to\s+)?|go\s+(?:to\s+)?)(?:some\s+part|a\s+part|part|some\s+section|a\s+section)(?:\s+of\s+(?:the\s+|this\s+)?page)?$/i.test(clean) ||
        /^(?:किसी भाग पर ले चलो|पेज के किसी भाग पर ले चलो|कोई सेक्शन दिखाओ)$/i.test(clean)
      ) {
        return { type: 'NAVIGATE_SOME_PART', raw };
      }

      // 12. NAVIGATE TO SPECIFIC SECTION ("take me to...", "scroll to...", "jump to...", "show me...", "go to...")
      let navMatch = clean.match(/^(?:take\s+me\s+(?:to\s+)?|navigate\s+(?:to\s+)?|scroll\s+(?:to\s+)?|jump\s+(?:to\s+)?|go\s+to\s+|open\s+|show\s+(?:me\s+)?)(?:the\s+)?(.+?)(?:\s+section)?$/i);
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

      // Hindi navigate to section ("...पर ले चलो", "...पर जाओ", "...दिखाओ", "...खोलो")
      const hiNavMatch = clean.match(/^(.+?)\s+(?:सेक्शन\s+)?(?:पर\s+ले\s+चलो|पर\s+जाओ|दिखाओ|खोलो)$/i);
      if (hiNavMatch && !['यह पेज', 'पेज', 'पूरा'].includes(hiNavMatch[1].trim())) {
        return {
          type: 'NAVIGATE_SECTION',
          raw,
          sectionQuery: hiNavMatch[1].trim()
        };
      }

      // 13. READ THE <SECTION> SECTION
      // Patterns:
      // "read the <x> section"
      // "read section <x>"
      // "read <x>"
      // "<x> सेक्शन पढ़ो"
      // "<x> पढ़ो"

      let sectionMatch = clean.match(/^read\s+(?:the\s+)?(.+?)\s+section$/i);
      if (!sectionMatch) {
        sectionMatch = clean.match(/^read\s+section\s+(.+)$/i);
      }
      // If user says "read <topic>" (and it's not "read this page" or "read again")
      if (!sectionMatch && clean.startsWith('read ')) {
        const afterRead = clean.replace(/^read\s+/, '').trim();
        if (afterRead && !['this page', 'the page', 'page', 'again', 'it again', 'all', 'everything'].includes(afterRead)) {
          sectionMatch = [null, afterRead];
        }
      }

      // Hindi section patterns:
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

      // Fallback: If typed or spoken something unknown, treat as potential section search query
      if (clean.length > 2) {
        return {
          type: 'QUERY_OR_SEARCH',
          raw,
          sectionQuery: clean
        };
      }

      return { type: 'UNKNOWN', raw };
    }
  }

  window.SleepwalkerVoice = SleepwalkerVoice;
})();
