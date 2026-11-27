/**
 * Sleepwalker - content.js (Persistent & Context-Aware Runtime Controller)
 * Lightweight top-frame coordinator connecting Sleepwalker modules directly to window.SW_UI,
 * SleepwalkerMemory (persistent sessions, 10+ structured activities, hybrid embeddings),
 * and the Central 12-Category Intent Router.
 */
(function () {
  'use strict';
  if (window !== window.top) return;

  const SPEECH_LANGS = {
    auto: 'en-IN',
    'en-IN': 'en-IN',
    'en-US': 'en-US',
    'hi-IN': 'hi-IN',
    'kn-IN': 'kn-IN',
    'ta-IN': 'ta-IN',
    'te-IN': 'te-IN',
    'ml-IN': 'ml-IN',
    'bn-IN': 'bn-IN',
    'mr-IN': 'mr-IN',
    'gu-IN': 'gu-IN',
    'pa-IN': 'pa-IN',
    'fr-FR': 'fr-FR',
    'de-DE': 'de-DE',
    'ja-JP': 'ja-JP',
    'es-ES': 'es-ES'
  };

  /**
   * Command-Correlated Lifecycle Tracker (Sleepwalker 2.0)
   * Tracks and truthfully records each stage of command lifecycle:
   * handleUserInput() -> context gathering -> page observation -> intent classification
   * -> task planning -> action execution -> verification -> terminal state.
   */
  class SleepwalkerCommandLifecycleTracker {
    constructor() {
      this.commands = new Map();
      this.logHistory = [];
    }

    startStage(commandId, stage, opts = {}) {
      if (!commandId) return null;
      const cmdId = String(commandId);
      let cmd = this.commands.get(cmdId);
      if (!cmd) {
        cmd = {
          commandId: cmdId,
          commandText: opts.text || '',
          stages: {},
          history: [],
          selectedBackend: opts.backend || 'unknown',
          terminalState: null
        };
        this.commands.set(cmdId, cmd);
      }
      if (opts.backend) cmd.selectedBackend = opts.backend;
      const now = Date.now();
      const stageEntry = {
        commandId: cmdId,
        stage,
        startTimestamp: new Date(now).toISOString(),
        _t0: performance.now(),
        completionTimestamp: null,
        duration: null,
        success: null,
        errorDetails: null,
        backend: opts.backend || cmd.selectedBackend || 'none'
      };
      cmd.stages[stage] = stageEntry;
      console.log(`[SW-LIFECYCLE] [${cmdId}] [${stage}] START startTimestamp=${stageEntry.startTimestamp} backend=${stageEntry.backend}`);
      return stageEntry;
    }

    finishStage(commandId, stage, opts = {}) {
      if (!commandId) return null;
      const cmdId = String(commandId);
      const cmd = this.commands.get(cmdId);
      if (!cmd) return null;
      let entry = cmd.stages[stage];
      const now = Date.now();
      const perfNow = performance.now();
      if (!entry) {
        entry = {
          commandId: cmdId,
          stage,
          startTimestamp: new Date(now).toISOString(),
          _t0: perfNow,
          completionTimestamp: null,
          duration: 0,
          success: null,
          errorDetails: null,
          backend: opts.backend || cmd.selectedBackend || 'none'
        };
        cmd.stages[stage] = entry;
      }
      entry.completionTimestamp = new Date(now).toISOString();
      entry.duration = Math.max(0, Math.round((perfNow - (entry._t0 || perfNow)) * 100) / 100);
      entry.success = opts.success !== undefined ? Boolean(opts.success) : (opts.errorDetails ? false : true);
      entry.errorDetails = opts.errorDetails || (entry.success ? null : (opts.reason || opts.message || 'stage_failed'));
      if (opts.backend) {
        entry.backend = opts.backend;
        cmd.selectedBackend = opts.backend;
      }
      cmd.history.push({ ...entry });
      this.logHistory.push({ ...entry });
      if (this.logHistory.length > 200) this.logHistory.shift();

      console.log(`[SW-LIFECYCLE] [${cmdId}] [${stage}] FINISH completionTimestamp=${entry.completionTimestamp} duration=${entry.duration}ms success=${entry.success} error=${entry.errorDetails || 'none'} backend=${entry.backend}`);
      return entry;
    }

    recordTerminalState(commandId, terminalState, opts = {}) {
      if (!commandId) return null;
      const cmdId = String(commandId);
      const cmd = this.commands.get(cmdId);
      if (cmd) {
        cmd.terminalState = terminalState;
      }
      return this.finishStage(commandId, 'terminal_state', {
        success: terminalState === 'completed',
        errorDetails: terminalState === 'completed' ? null : (opts.reason || opts.message || terminalState),
        backend: opts.backend
      });
    }

    getCommandLogs(commandId) {
      if (!commandId) return Array.from(this.commands.values());
      return this.commands.get(String(commandId)) || null;
    }

    getAllLogs() {
      return this.logHistory.slice();
    }
  }

  const globalLifecycleTracker = new SleepwalkerCommandLifecycleTracker();
  if (typeof window !== 'undefined') {
    window.__SW_LIFECYCLE_TRACKER__ = globalLifecycleTracker;
    window.__SW_COMMAND_LIFECYCLE_LOGS__ = globalLifecycleTracker.logHistory;
    window.__SW_GET_COMMAND_LOGS__ = (id) => globalLifecycleTracker.getCommandLogs(id);
  }

  class SleepwalkerController {
    constructor() {
      this.lang = 'en-IN';
      this.rate = 1.0;
      this.fontSize = 18;
      this.bargeIn = false;
      this.lastUndoableType = 'forms';
      this.errors = [];
      this._lastToggleTime = 0;
      this.isOpen = false;
      this.shadowRoot = null;
      this.pill = null;
      this.glow = null;
      this._bootPromise = null;
      this._commandQueue = Promise.resolve();
      this._pendingDueReminders = [];
      this._lastElementSelectMeta = null;
      this._inFlightExecCount = 0;
      this.taskLifecycle = {
        state: 'IDLE',
        activeTaskId: 0,
        activeLabel: '',
        stage: '',
        abortController: null,
        clarificationHandler: null,
        clarificationQuestion: '',
        lastSubmittedNorm: '',
        lastSubmittedAt: 0,
        resetTimer: null
      };

      this.initModules();
      this.bindEvents();
      this.loadPreferencesPromise = this.loadPreferences();
      this._installSpaNavigationWatcher();
      this._installVisibilityAndTabListeners();
      this._bootDone = false;
      this._bootPromise = Promise.all([
        this.restorePersistentSessionOnBoot().catch(() => null),
        this.loadPreferencesPromise
      ]).finally(() => { this._bootDone = true; });
      if (this.worldModel && typeof this.worldModel.scheduleProactiveScan === 'function' &&
          typeof document !== 'undefined' && !document.hidden) {
        this.worldModel.scheduleProactiveScan(document, { delayMs: 120, reason: 'initial_page_load' });
      }

      window.__SW_SAY__ = (text, opts = {}) => this.simulateVoiceInput(text, opts);
      window.__SW_DIAGNOSTICS__ = () => (this.diagnostics && typeof this.diagnostics.getReport === 'function' ? this.diagnostics.getReport() : null);
    }

    initModules() {
      this.diagnostics = window.SleepwalkerDiagnostics || null;
      this.navEngine = window.SleepwalkerNavEngine || null;
      this.agentFsm = this.navEngine && this.navEngine.SleepwalkerAgentStateMachine
        ? new this.navEngine.SleepwalkerAgentStateMachine({ onStateChange: (st, entry) => this._onAgentStateChange(st, entry) })
        : null;
      this.fastRouter = this.navEngine && this.navEngine.SleepwalkerFastPathRouter
        ? new this.navEngine.SleepwalkerFastPathRouter()
        : null;
      this.waitManager = this.navEngine && this.navEngine.SleepwalkerWaitManager
        ? new this.navEngine.SleepwalkerWaitManager({ doc: document, win: window })
        : null;
      this.actionVerifier = this.navEngine && this.navEngine.SleepwalkerActionVerifier
        ? new this.navEngine.SleepwalkerActionVerifier()
        : null;
      this.lastAgentState = 'IDLE';
      this.reader = new window.SleepwalkerReader();
      this.outline = new window.SleepwalkerOutline();
      this.voice = new window.SleepwalkerVoice();
      this.memory = window.SleepwalkerMemory ? new window.SleepwalkerMemory(this) : null;
      this.taskPlanner = window.SleepwalkerTaskPlanner ? new window.SleepwalkerTaskPlanner(this) : null;
      this.confirm = window.SleepwalkerConfirm ? new window.SleepwalkerConfirm({ onChange: (st) => this.handleConfirmStateChange(st) }) : null;
      this.intentEngine = window.SleepwalkerIntentEngine ? new window.SleepwalkerIntentEngine() : null;
      this.linkIntent = window.SleepwalkerLinkIntent ? new window.SleepwalkerLinkIntent() : null;
      this.navigator = window.SleepwalkerNavigator ? new window.SleepwalkerNavigator(this) : null;
      this.browserEngine = window.BrowserEngine ? new window.BrowserEngine() : null;
      this.stagehandAdapter = (typeof window !== 'undefined' && window.StagehandBrowserAdapter) ? new window.StagehandBrowserAdapter() : null;
      this.useStagehandAdapter = Boolean(typeof window !== 'undefined' && window.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__ === true);
      this.useRebuiltBrowserEngine = Boolean(typeof window !== 'undefined' && window.__SLEEPWALKER_ENABLE_REBUILT_ENGINE__ === true);
      // Genuine CDP mouse & keyboard input is a permanent core capability (never gated by a developer toggle)
      this.genuineInputEnabled = true;
      this.unifiedOrchestrator = (typeof window !== 'undefined' && window.SleepwalkerUnifiedOrchestrator)
        ? new window.SleepwalkerUnifiedOrchestrator({
            controller: this,
            stagehandAdapter: this.stagehandAdapter,
            browserEngine: this.browserEngine,
            memory: this.memory
          })
        : null;
      this._initCdpBridge();
      this.lastNavVerification = null;
      this.lastCrossPageContinuationResult = null;
      this.lastSpokenUnifiedReply = null;
      this.emergencyStopActive = false;
      this.rolloutTelemetry = {
        successfulActions: 0,
        failedActions: 0,
        falseCompletions: 0,
        fallbackCount: 0,
        clarificationCount: 0,
        latenciesMs: [],
        events: []
      };
      this.forms = window.SleepwalkerForms ? new window.SleepwalkerForms(this) : null;
      this.elementSelector = window.SleepwalkerElementSelector ? new window.SleepwalkerElementSelector(this) : null;
      this.worldModel = window.SleepwalkerWorldModel
        ? new window.SleepwalkerWorldModel(this, {
            onScanStateChange: (active, label) => {
              if (window.SW_UI && typeof window.SW_UI.setScanning === 'function' && (this.isOpen || (this.dialogue && this.dialogue.isActive()))) {
                window.SW_UI.setScanning(active, label);
              }
            }
          })
        : null;
      this.teach = window.SleepwalkerTeach ? new window.SleepwalkerTeach(this) : null;
      this.upload = window.SleepwalkerUpload ? new window.SleepwalkerUpload(this) : null;
      this.camera = window.SleepwalkerCamera ? new window.SleepwalkerCamera(this, { onCardChange: (s) => this.handleCameraCardChange(s) }) : null;
      this.dialogue = window.SleepwalkerDialogue ? new window.SleepwalkerDialogue(this) : null;
      this.explainer = window.SleepwalkerExplainer ? new window.SleepwalkerExplainer(this) : null;
    }

    bindEvents() {
      const ui = window.SW_UI;
      if (ui && typeof ui.setHandlers === 'function') {
        ui.setHandlers({
          onOrbClick: () => this.toggle({ startDialogue: true, source: 'orb' }),
          onSubmitText: (text, reqId) => this.handleUserInput(text, 'typed', { reqId }),
          onDismiss: (reason) => this.dismissUi(reason || 'escape'),
          onCancelTask: () => this.cancelActiveTask('Cancelled.', { source: 'ui_cancel' }),
          onEmergencyStop: (info) => this.triggerEmergencyStop((info && info.source) || 'ui_estop'),
          onResumeEmergencyStop: () => this.resetEmergencyStop('ui_orb_resume'),
          onTypeToggle: (isOpen) => {
            if (isOpen) {
              // Pause hot mic while user types so keyboard/room noise cannot preempt or overwrite typed commands!
              if (this.dialogue) this.dialogue._clearSilenceTimers();
              if (this.voice && this.voice.isListening && !this.voice.isPaused) {
                this._pausedMicForTyping = true;
                this.voice.pauseTemporary();
              }
            } else if (this._pausedMicForTyping) {
              this._pausedMicForTyping = false;
              if (this.dialogue && this.dialogue.isActive() && !this.dialogue.isPausedForSpeech() && this.voice) {
                this.voice.resumeAfterPause();
              }
            }
          },
          onTypeFocus: () => {
            if (this.dialogue) this.dialogue._clearSilenceTimers();
            if (this.voice && this.voice.isListening && !this.voice.isPaused) {
              this._pausedMicForTyping = true;
              this.voice.pauseTemporary();
            }
          },
          onTypeActivity: () => {
            if (this.dialogue) this.dialogue.noteSpeechActivity({ fromVoice: false });
          },
          onQuickControl: (pref, val) => {
            if (pref === 'lang') this.setLanguage(val);
            else if (pref === 'rate') this.setRate(Number(val));
            else if (pref === 'voicePersona') this.setVoicePersona(val, { preview: true });
            else if (pref === 'fontSize') { this.fontSize = Number(val) || 18; this.savePreferences(); }
            else if (pref === 'options' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
              chrome.runtime.sendMessage({ type: 'SLEEPWALKER_OPEN_OPTIONS' });
            }
          }
        });
      }

      this.voice.shouldAcceptCommand = (cleanText, meta = {}) => {
        const norm = (meta && meta.norm) || String(cleanText || '').toLowerCase().replace(/[.,!?;:]+$/g, '').replace(/\s+/g, ' ').trim();
        if (!norm) return { accept: false, reason: 'empty' };
        if (this._isTaskCancelPhrase(cleanText)) return { accept: true };
        if (this.taskLifecycle && this.taskLifecycle.state === 'PROCESSING' && this._inFlightExecCount > 0) {
          // Block exact duplicate echo/repeat during active execution, but allow a genuinely new spoken command
          // to pass into handleUserInput() so a slow/hung LLM never leaves the user's voice ignored!
          if (norm === this.taskLifecycle.lastSubmittedNorm && (Date.now() - (this.taskLifecycle.lastSubmittedAt || 0)) < 8000) {
            return { accept: false, reason: 'duplicate_during_active_task' };
          }
        }
        return { accept: true };
      };

      this.voice.onTranscript = ({ text }) => {
        if (window.SW_UI && (!this.dialogue || this.dialogue.isActive() || window.SW_UI.getState() === 'listening')) {
          window.SW_UI.setTranscript(text || '');
        }
      };

      this.voice.onCommand = (cmd, meta = {}) => {
        if (cmd && cmd.raw) {
          this._setStatusChip(`Command received: "${cmd.raw}"`);
          return this.handleUserInput(cmd.raw, 'voice', {
            asrConfidence: meta.confidence ?? cmd.confidence ?? null,
            asrAlternatives: Array.isArray(meta.alternatives) ? meta.alternatives : [],
            activeLang: meta.activeLang || this.voice.activeLang,
            mode: meta.mode || this.voice.mode
          });
        }
      };

      this.voice.onLifecycleChange = (lifecycleState, detail) => {
        if (!window.SW_UI) return;
        const turnBusy = Boolean(
          (this.taskLifecycle && (this.taskLifecycle.state === 'PROCESSING' || this.taskLifecycle.state === 'WAITING_FOR_CLARIFICATION')) ||
          (window.SW_UI._orb && window.SW_UI._orb._processingTurn) ||
          window.SW_UI.getState() === 'thinking' ||
          (this.reader && (this.reader.isPlaying || (typeof this.reader.isStreamingActive === 'function' && this.reader.isStreamingActive()))) ||
          (this.confirm && this.confirm.isAwaiting()) ||
          (this.dialogue && this.dialogue.isPausedForSpeech())
        );
        if (lifecycleState === 'starting') {
          if (!turnBusy) {
            window.SW_UI.setState('silent');
            this._setStatusChip(detail || 'Starting microphone...');
          }
        } else if (lifecycleState === 'listening') {
          if (!turnBusy) {
            window.SW_UI.setState('listening');
            const curTr = String(window.SW_UI.transcript || '');
            if (!curTr || /^(Starting microphone|Allow microphone|Connecting|Opening|Requesting microphone|Waiting for next command|Recovering)/i.test(curTr)) {
              this._setStatusChip(detail || 'Listening...');
            }
          }
        } else if (lifecycleState === 'committing') {
          window.SW_UI.setState('thinking');
          this._setStatusChip(detail || 'Processing...');
        } else if (lifecycleState === 'recovering') {
          if (!turnBusy) this._setStatusChip(detail || 'Temporarily unavailable — reconnecting...');
        } else if (lifecycleState === 'error') {
          window.SW_UI.setState('error');
          this._setStatusChip(detail || 'Temporarily unavailable');
        }
      };

      this.voice.onActivity = () => { if (this.dialogue) this.dialogue.noteSpeechActivity({ fromVoice: true }); };
      this.voice.onLevel = (lvl) => { if (window.SW_UI && (!this.reader || !this.reader.isPlaying || this.reader.isPaused)) window.SW_UI.setLevel(lvl); };

      this.voice.onStateChange = (on) => {
        if (window.SW_UI) {
          if (on && (!this.dialogue || !this.dialogue.isPausedForSpeech())) {
            window.SW_UI.setState('listening');
          } else if (!on && this.dialogue && this.dialogue.isActive() && !this.dialogue.isPausedForSpeech() && window.SW_UI.getState() === 'listening') {
            window.SW_UI.setState('silent');
          }
        }
        if (on && this.dialogue && this.dialogue.isActive() && typeof this.dialogue._scheduleSilenceTimers === 'function') {
          this.dialogue._scheduleSilenceTimers();
        }
        if (this.memory) {
          if (on && this.dialogue && this.dialogue.isActive()) {
            this.memory.setSessionMode('active_listening');
          } else if (!on && this.dialogue && this.dialogue.isActive() && !this.dialogue.isPausedForSpeech() && this.voice && this.voice.lifecycleState !== 'error') {
            this.memory.setSessionMode('active_not_listening');
          }
        }
      };

      this.voice.onError = ({ error, message, isPermissionDenied, isSiteBlocked }) => {
        this.recordError(message);
        if (window.SW_UI) {
          const hasInteractiveCard = Boolean(
            (this.dialogue && this.dialogue.pendingPrompt) ||
            (this.confirm && this.confirm.isAwaiting()) ||
            (this.taskLifecycle && ['PROCESSING', 'WAITING_FOR_CLARIFICATION'].includes(this.taskLifecycle.state)) ||
            (this._inFlightExecCount > 0)
          );
          if (hasInteractiveCard) {
            this._setStatusChip('Mic unavailable — tap button or Type below');
          } else {
            window.SW_UI.setState('error');
            const isInsecure = error === 'insecure-context';
            const hasExtRuntime = Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
            const actions = [];
            if (isSiteBlocked && hasExtRuntime) {
              actions.push({ id: 'use_ext_mic', label: 'Use Sleepwalker Mic', primary: true });
              if (typeof window !== 'undefined' && window.isSecureContext !== false) {
                actions.push({ id: 'allow_mic', label: 'Allow Site Mic' });
              }
            } else if (!isInsecure) {
              actions.push({
                id: isPermissionDenied ? 'allow_mic' : 'retry_mic',
                label: isPermissionDenied ? 'Allow Microphone' : 'Retry Microphone',
                primary: true
              });
              if (isPermissionDenied && hasExtRuntime) {
                actions.push({ id: 'use_ext_mic', label: 'Use Sleepwalker Mic' });
              }
            } else if (hasExtRuntime) {
              actions.push({ id: 'use_ext_mic', label: 'Use Sleepwalker Mic', primary: true });
            }
            actions.push({ id: 'mic_setup', label: 'Mic Diagnostics' });
            window.SW_UI.showCard({
              type: 'error',
              title: 'Microphone',
              text: message,
              autoDismissMs: 0,
              actions,
              onAction: async (actId) => {
                if (actId === 'mic_setup') {
                  if (this.voice) this.voice.openMicSetup();
                  return;
                }
                if (actId === 'use_ext_mic' || actId === 'allow_mic' || actId === 'retry_mic') {
                  window.SW_UI.hideCard();
                  window.SW_UI.setState('silent');
                  this._setStatusChip('Starting microphone...');
                  if (this.dialogue) {
                    this.dialogue.active = true;
                    this.dialogue.resting = false;
                    this.dialogue.pausedForSpeech = false;
                  }
                  const ok = actId === 'use_ext_mic'
                    ? (this.voice && typeof this.voice.useExtensionMicRelay === 'function' ? this.voice.useExtensionMicRelay() : false)
                    : ((actId === 'allow_mic' && this.voice)
                      ? await this.voice.requestMicPermissionWithGesture()
                      : (this.voice ? (this.voice._recreateRecognition(), this.voice.startListening()) : false));
                  if (ok && this.memory) {
                    this.memory.setSessionMode('active_listening');
                  }
                }
              }
            });
          }
        }
      };

      this.reader.onLevel = (lvl) => { if (window.SW_UI && this.reader.isPlaying && !this.reader.isPaused) window.SW_UI.setLevel(lvl); };
      this.reader.onSentenceChange = ({ index }) => {
        if (!window.SW_UI) return;
        const i = Math.max(0, (index || 1) - 1);
        window.SW_UI.highlightSentence(i);
        if (this.explainer && this.explainer._topicSentenceOffsets) window.SW_UI.highlightTopic(i);
      };

      this.reader.onStatusChange = ({ isPlaying, isPaused }) => {
        const streamingHold = Boolean(!isPlaying && this.reader && typeof this.reader.isStreamingActive === 'function' && this.reader.isStreamingActive());
        if (window.SW_UI) {
          if ((isPlaying && !isPaused) || streamingHold) {
            window.SW_UI.setState('speaking');
            this._setStatusChip('Speaking...');
          } else if (this.confirm && this.confirm.isAwaiting()) {
            window.SW_UI.setState('confirm');
          } else if (this.voice && this.voice.isListening && !this.voice.isPaused) {
            window.SW_UI.setState('listening');
          } else if (window.SW_UI.getState() !== 'idle') {
            window.SW_UI.setState('silent');
          }
        }
        if (this.memory) {
          this.memory.state.isSpeaking = Boolean((isPlaying && !isPaused) || streamingHold);
        }
        if (this.dialogue && !streamingHold) this.dialogue.onSpeechStatusChange({ isPlaying, isPaused });
      };

      this.reader.onError = (err) => {
        this.recordError(err);
        const cardType = window.SW_UI && typeof window.SW_UI.getCardType === 'function' ? window.SW_UI.getCardType() : null;
        if (cardType || (this.dialogue && this.dialogue.isActive())) {
          // Preserve the visible assistant response card if TTS is blocked or audio device unavailable
          if (window.SW_UI) {
            window.SW_UI.notifySpeechEnd();
            window.SW_UI.setState(this.voice && this.voice.isListening ? 'listening' : 'silent');
            this._setStatusChip('Reply shown (audio unavailable) — waiting for command...');
          }
          if (this.dialogue) this.dialogue.onSpeechStatusChange({ isPlaying: false, isPaused: false });
          return;
        }
        if (window.SW_UI) {
          window.SW_UI.setState('error');
          window.SW_UI.showCard({ type: 'error', title: 'Speech Error', text: err });
        }
        if (this.dialogue) this.dialogue.onSpeechStatusChange({ isPlaying: false, isPaused: false });
      };

      this.reader.onFinished = () => {
        if (window.SW_UI) {
          window.SW_UI.notifySpeechEnd();
          if (this.confirm && this.confirm.isAwaiting()) {
            window.SW_UI.setState('confirm');
          } else if (this.dialogue && this.dialogue.isActive()) {
            window.SW_UI.setState(this.voice.isListening ? 'listening' : 'silent');
            this._setStatusChip('Waiting for the next command...');
          } else if (window.SW_UI.getState() !== 'idle') {
            window.SW_UI.setState('silent');
          }
        }
        if (this.dialogue) this.dialogue.onSpeechStatusChange({ isPlaying: false, isPaused: false });
      };
    }

    _setStatusChip(text) {
      if (window.SW_UI && window.SW_UI.getState() !== 'idle') {
        window.SW_UI.setTranscript(String(text || ''));
      }
    }

    getDiagnostics() {
      return this.diagnostics ? this.diagnostics.getReport() : { counters: {}, perf: {}, recentEvents: [], recentTraces: [] };
    }

    /**
     * Put this webpage's Sleepwalker calmly to sleep when the user navigates/clicks to another tab,
     * WITHOUT closing the page or erasing conversation/task/form context so "go back" resumes seamlessly.
     */
    sleepForOtherTab(reason = 'other_tab_active') {
      const wasAwake = Boolean(
        this.isOpen ||
        (this.dialogue && this.dialogue.isActive()) ||
        (window.SW_UI && window.SW_UI.getState() !== 'idle')
      );
      this._sleepingForOtherTab = true;
      if (wasAwake) {
        this._wasActiveBeforeTabSleep = true;
      }
      // Stop any active speech on this backgrounded webpage so two tabs never speak simultaneously
      if (this.reader && (this.reader.isPlaying || (typeof this.reader.isStreamingActive === 'function' && this.reader.isStreamingActive()))) {
        if (typeof this.reader.cancelStream === 'function') this.reader.cancelStream();
        else this.reader.stop();
      }
      // Pause background dialogue silence timers so a sleeping tab never fires "Are you still there?" or ends the foreground session
      if (this.dialogue && typeof this.dialogue._clearAllTimers === 'function') {
        this.dialogue._clearAllTimers();
      }
      // Release microphone cleanly for the new active webpage
      if (this.voice && (this.voice.isListening || this.voice.lifecycleState === 'starting')) {
        this.voice.pauseForTabSwitch();
      }
      // Hide floating orb/card on the sleeping tab while preserving memory, dialogue history, and form state
      if (window.SW_UI && window.SW_UI.getState() !== 'idle') {
        window.SW_UI.hide({ dissolve: false });
      }
      if (this.diagnostics && wasAwake) {
        this.diagnostics.log('orb', 'slept_for_other_tab', { reason });
      }
    }

    _installVisibilityAndTabListeners() {
      if (this._visInstalled || typeof document === 'undefined') return;
      this._visInstalled = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.sleepForOtherTab('visibility_hidden');
        } else {
          this.syncSessionFromTabActivation({ isForegroundTab: true });
        }
      });
    }

    async syncSessionFromTabActivation({ isForegroundTab = true } = {}) {
      if (!isForegroundTab || (typeof document !== 'undefined' && document.hidden)) {
        this.sleepForOtherTab('background_sync');
        return;
      }
      this._sleepingForOtherTab = false;
      if (this.browserEngine) {
        try {
          this.browserEngine.invalidateCache();
          this.browserEngine.observe(document, { force: true });
        } catch (_e) {}
      }
      if (this.worldModel) {
        this.worldModel.observeTab(document, { force: true }).catch(() => {});
      }
      if (!this.memory) return;
      const t0 = Date.now();
      const state = await this.memory.loadState();
      const mode = state && state.sessionMode;
      if (mode === 'active_listening' || mode === 'active_not_listening' || mode === 'paused') {
        this.isOpen = true;
        this._wasActiveBeforeTabSleep = false;
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          try {
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_SET_ACTIVE_TAB',
              title: document.title || '',
              url: window.location.href || ''
            }, () => { void chrome.runtime?.lastError; });
          } catch (_e) {}
        }
        const listenNow = mode === 'active_listening';
        if (this.dialogue) {
          this.dialogue.active = true;
          this.dialogue.resting = false;
          this.dialogue.pausedForSpeech = false;
          this.dialogue._syncSessionIndicators();
          if (typeof this.dialogue._scheduleSilenceTimers === 'function') {
            this.dialogue._scheduleSilenceTimers();
          }
        }
        if (window.SW_UI && window.SW_UI.getState() === 'idle') {
          window.SW_UI.setState('silent');
          this._setStatusChip(listenNow ? 'Starting microphone...' : 'Ready');
        }
        if (this.voice) {
          this.voice.continuousSession = listenNow;
          if (listenNow && this.voice.isSupported) {
            if (this.voice._pausedForTab) this.voice.resumeForTabSwitch();
            else if (!this.voice.isListening) this.voice.startListening();
          }
        }
        if (this.diagnostics) {
          this.diagnostics.log('orb', 'restored', { durationMs: Date.now() - t0, mode, trigger: 'tab_sync' });
        }
      }
    }

    /**
     * Restore active assistant session & page context automatically after full page reload,
     * redirect, cross-website navigation, or SPA route transition.
     */
    async _reconcilePendingNavVerificationOnBoot() {
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return null;
      if (this.loadPreferencesPromise) {
        await this.loadPreferencesPromise.catch(() => {});
      }
      try {
        const res = await new Promise((resolve) => {
          const tm = setTimeout(() => resolve(null), 3200);
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CONSUME_NAV_VERIFICATION' }, (r) => {
            clearTimeout(tm);
            void chrome.runtime?.lastError;
            resolve(r || null);
          });
        });
        const rec = res && res.record;
        if (!rec || (Date.now() - Number(rec.updatedAt || rec.ts || 0)) > 35000) return null;

        // Ensure destination document is ready before verifying DOM or continuing multi-step plans
        if (typeof document !== 'undefined' && document.readyState === 'loading') {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 2500);
            document.addEventListener('DOMContentLoaded', () => { clearTimeout(t); resolve(); }, { once: true });
          });
        }

        const visibleText = (typeof document !== 'undefined' && document.body)
          ? (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800)
          : '';
        const isClickNav = (rec.actionType === 'click' || rec.action === 'click');
        const liveState = {
          url: typeof window !== 'undefined' ? window.location.href : '',
          title: typeof document !== 'undefined' ? (document.title || '') : '',
          readyState: typeof document !== 'undefined' ? (document.readyState || 'complete') : 'complete',
          navigationComplete: true,
          visibleText: visibleText || rec.visibleTextPreview || '',
          accessibility: rec.matchedLabel
            ? { name: rec.matchedLabel }
            : (isClickNav ? { name: `${typeof document !== 'undefined' ? (document.title || '') : ''} ${typeof window !== 'undefined' ? window.location.href : ''}`.trim() } : undefined)
        };

        const effectiveExpected = rec.expectedState
          ? { ...rec.expectedState, navigationComplete: true }
          : { navigationComplete: true };

        let ver = { verified: Boolean(liveState.url), checks: [] };
        if (this.unifiedOrchestrator && this.unifiedOrchestrator.verifier && typeof this.unifiedOrchestrator.verifier.verifyBrowser === 'function') {
          ver = await this.unifiedOrchestrator.verifier.verifyBrowser(
            { expectedState: effectiveExpected },
            {
              ok: true,
              status: 'COMPLETED',
              engine: rec.engine || rec.intendedEngine || 'existing_browser_engine',
              actualState: liveState,
              result: { url: liveState.url, title: liveState.title, navigated: true }
            }
          );
        }

        const effectiveEngine = rec.engine || rec.intendedEngine || 'existing_browser_engine';
        this.lastNavVerification = {
          commandId: rec.commandId || null,
          taskId: rec.taskId || null,
          rawText: rec.rawText || '',
          intent: rec.intent || null,
          action: rec.actionType || rec.action || 'navigate',
          engine: effectiveEngine,
          fallbackUsed: Boolean(rec.fallbackUsed),
          stagehandVersion: rec.stagehandVersion || null,
          urlBefore: rec.urlBefore || null,
          urlAfter: liveState.url,
          titleAfter: liveState.title,
          verified: Boolean(ver && ver.verified),
          checks: (ver && ver.checks) || [],
          failureReason: (ver && ver.failureReason) || null,
          stagehandVerification: rec.stagehandVerification || null,
          verifiedAt: new Date().toISOString()
        };

        if (globalLifecycleTracker && rec.commandId) {
          globalLifecycleTracker.recordTerminalState(
            rec.commandId,
            this.lastNavVerification.verified ? 'completed' : 'verification_failed',
            {
              backend: effectiveEngine,
              urlAfter: liveState.url,
              verifiedOnDestination: true
            }
          );
        }

        // Phase 1: Durable multi-hop cross-page plan continuation (resumes remaining steps OR finalizes last-step navigation ONLY after verified destination readiness!)
        if (rec.continuation && (
          (Array.isArray(rec.continuation.remainingSteps) && rec.continuation.remainingSteps.length > 0) ||
          rec.continuation.finalizeOnDestination === true
        )) {
          if (this.emergencyStopActive) {
            this.lastCrossPageContinuationResult = {
              ok: false,
              status: 'EMERGENCY_STOP',
              commandId: rec.continuation.commandId,
              error: 'Aborted pending cross-page continuation because Emergency Stop is active.'
            };
          } else if (!this.lastNavVerification.verified) {
            const failMsg = `Navigation verification failed before continuing "${rec.continuation.rawText}": ${this.lastNavVerification.failureReason || 'Destination mismatch'}`;
            this.lastCrossPageContinuationResult = {
              ok: false,
              status: 'VERIFICATION_FAILED',
              commandId: rec.continuation.commandId,
              error: failMsg
            };
            this.setAssistantReply(failMsg);
            if (window.SW_UI && typeof window.SW_UI.showCard === 'function') {
              window.SW_UI.showCard({ type: 'error', title: 'Navigation Verification Failed', text: failMsg });
            }
            if (rec.continuation.inputSource === 'voice') {
              this._speakUnifiedReply(failMsg, 'voice');
            }
          } else {
            await this._resumeCrossPageContinuation(rec.continuation, effectiveEngine, liveState);
          }
        }
        return this.lastNavVerification;
      } catch (_e) {
        return null;
      }
    }

    _buildNavigationContinuationCallbacks(defaultInputSource = 'typed') {
      const recordBeforeNav = async (stepInfo) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return;
        const step = stepInfo.currentStep || {};
        const completedSoFar = [
          ...(Array.isArray(stepInfo.completedStepsBefore) ? stepInfo.completedStepsBefore : []),
          {
            stepId: step.stepId || 'step-browser-nav',
            label: step.label || 'Navigate in browser',
            backend: 'browser',
            engine: this.useStagehandAdapter ? 'stagehand_adapter' : 'existing_browser_engine',
            attempt: 1
          }
        ];
        const remaining = Array.isArray(stepInfo.remainingStepsAfter) ? stepInfo.remainingStepsAfter : [];
        const continuation = (remaining.length > 0 || completedSoFar.length > 1)
          ? {
              commandId: stepInfo.commandId,
              taskId: stepInfo.taskId,
              rawText: stepInfo.rawText,
              inputSource: stepInfo.inputSource || defaultInputSource,
              route: stepInfo.route,
              intent: stepInfo.intent,
              understoodSummary: stepInfo.understoodSummary,
              completedStepsSoFar: completedSoFar,
              remainingSteps: remaining,
              finalizeOnDestination: remaining.length === 0 && completedSoFar.length > 1,
              sharedArtifacts: stepInfo.sharedArtifacts || {}
            }
          : null;

        await new Promise((resolve) => {
          const tm = setTimeout(resolve, 600);
          try {
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_RECORD_PENDING_NAV',
              commandId: stepInfo.commandId,
              taskId: stepInfo.taskId,
              rawText: stepInfo.rawText,
              intent: stepInfo.intent,
              action: step.action || 'navigate',
              expectedState: step.expectedState || { navigationComplete: true },
              intendedEngine: this.useStagehandAdapter ? 'stagehand_adapter' : 'existing_browser_engine',
              urlBefore: typeof window !== 'undefined' ? window.location.href : '',
              continuation
            }, () => {
              clearTimeout(tm);
              void chrome.runtime?.lastError;
              resolve();
            });
          } catch (_e) {
            clearTimeout(tm);
            resolve();
          }
        });
      };

      const clearAfterInPage = async (info) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') return;
        try {
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CLEAR_PENDING_NAV', commandId: info && info.commandId }, () => { void chrome.runtime?.lastError; });
        } catch (_e) {}
      };

      return { recordBeforeNav, clearAfterInPage };
    }

    async _resumeCrossPageContinuation(cont, lastNavEngine = 'existing_browser_engine', liveDestState = null) {
      if (!this.unifiedOrchestrator || !cont) return null;
      const priorCompleted = Array.isArray(cont.completedStepsSoFar) && cont.completedStepsSoFar.length > 0
        ? cont.completedStepsSoFar.map((s, idx, arr) => idx === arr.length - 1 ? { ...s, engine: lastNavEngine } : s)
        : [
            {
              ...(cont.completedFirstStep || { stepId: 'step-1-browser-navigate', label: 'Navigate to destination', backend: 'browser' }),
              engine: lastNavEngine,
              attempt: 1
            }
          ];

      // Case A: The final step of a multi-step plan caused a full-page navigation; destination is now verified — present completion!
      if ((!Array.isArray(cont.remainingSteps) || cont.remainingSteps.length === 0) && cont.finalizeOnDestination) {
        const artifacts = {
          ...(cont.sharedArtifacts || {}),
          openedResultPage: {
            url: (liveDestState && liveDestState.url) || (typeof window !== 'undefined' ? window.location.href : ''),
            title: (liveDestState && liveDestState.title) || (typeof document !== 'undefined' ? document.title : '')
          }
        };
        const summaryText = artifacts.extractedInfo || `${cont.understoodSummary || cont.rawText} (${priorCompleted.length}/${priorCompleted.length} verified).`;
        this.setAssistantReply(summaryText);
        if (window.SW_UI && typeof window.SW_UI.showCard === 'function') {
          window.SW_UI.showCard({
            type: 'answer',
            title: cont.route === 'cross_backend' ? 'Browser + Desktop Task' : 'Browser Task',
            text: summaryText
          });
        }
        if (cont.inputSource === 'voice') {
          this._speakUnifiedReply(summaryText, 'voice');
        }
        this.lastCrossPageContinuationResult = {
          ok: true,
          status: 'COMPLETED',
          commandId: cont.commandId,
          intent: cont.intent || null,
          rawText: cont.rawText,
          firstStepEngine: lastNavEngine,
          completedSteps: priorCompleted,
          sharedArtifacts: artifacts,
          message: summaryText,
          completedAt: new Date().toISOString()
        };
        return this.lastCrossPageContinuationResult;
      }

      if (!Array.isArray(cont.remainingSteps) || cont.remainingSteps.length === 0) {
        return null;
      }

      const tl = this.taskLifecycle;
      const resumeTaskId = tl ? (tl.activeTaskId + 1) : 1;
      const abortController = typeof AbortController === 'function' ? new AbortController() : null;
      if (tl) {
        tl.activeTaskId = resumeTaskId;
        tl.state = 'PROCESSING';
        tl.activeLabel = String(cont.rawText || '').slice(0, 68);
        tl.abortController = abortController;
      }
      this._inFlightExecCount = 1;
      const navCallbacks = this._buildNavigationContinuationCallbacks(cont.inputSource || 'typed');
      try {
        const orchRes = await this.unifiedOrchestrator.executeCommand(cont.rawText, {
          taskId: cont.taskId || `task-${resumeTaskId}`,
          commandId: cont.commandId,
          inputSource: cont.inputSource || 'typed',
          explicitPlan: cont.remainingSteps,
          resumeRouting: {
            route: cont.route || 'cross_backend',
            intent: cont.intent || 'CROSS_BROWSER_TO_DESKTOP',
            understoodSummary: cont.understoodSummary || cont.rawText
          },
          initialCompletedSteps: priorCompleted,
          initialSharedArtifacts: cont.sharedArtifacts || {},
          onBeforeNavigationStep: navCallbacks.recordBeforeNav,
          onAfterInPageStep: navCallbacks.clearAfterInPage,
          inBrowserTab: true,
          timeoutMs: 75000
        });

        const rawExtractedInfo = (orchRes && orchRes.sharedArtifacts && orchRes.sharedArtifacts.extractedInfo) || '';
        const extractedSummary = rawExtractedInfo ? String(rawExtractedInfo).slice(0, 320) : '';
        const totalStepsCount = (orchRes && orchRes.completedSteps ? orchRes.completedSteps.length : 0) +
          (orchRes && orchRes.incompleteSteps ? orchRes.incompleteSteps.length : 0);
        const replyMsg = orchRes && orchRes.ok
          ? (extractedSummary
              ? `${orchRes.understoodSummary}: ${extractedSummary}`
              : `${orchRes.understoodSummary} (${orchRes.completedSteps.length}/${totalStepsCount || orchRes.completedSteps.length} verified).`)
          : `Could not complete "${cont.rawText}": ${(orchRes && orchRes.error && orchRes.error.message) || 'Continuation failed'}`;

        this.setAssistantReply(replyMsg);
        if (window.SW_UI && typeof window.SW_UI.showCard === 'function') {
          const cardTitle = orchRes && orchRes.route === 'cross_backend' ? 'Browser + Desktop Task' : 'Browser Task';
          window.SW_UI.showCard({
            type: orchRes && orchRes.ok ? 'answer' : 'error',
            title: cardTitle,
            text: replyMsg
          });
        }
        if (cont.inputSource === 'voice') {
          this._speakUnifiedReply(replyMsg, 'voice');
        }
        this._finishActiveTask(resumeTaskId, orchRes && orchRes.ok ? 'COMPLETED' : 'ERROR', orchRes && orchRes.ok ? 'Completed' : 'Action failed');
        this.lastCrossPageContinuationResult = {
          ok: Boolean(orchRes && orchRes.ok),
          status: orchRes ? orchRes.status : 'FAILED',
          commandId: cont.commandId,
          rawText: cont.rawText,
          firstStepEngine: lastNavEngine,
          completedSteps: orchRes ? orchRes.completedSteps : [],
          sharedArtifacts: orchRes ? orchRes.sharedArtifacts : {},
          message: replyMsg,
          orchestration: orchRes,
          completedAt: new Date().toISOString()
        };
        return this.lastCrossPageContinuationResult;
      } finally {
        this._inFlightExecCount = Math.max(0, this._inFlightExecCount - 1);
      }
    }

    _speakUnifiedReply(replyMsg, inputSource = 'typed') {
      const clean = String(replyMsg || '').trim();
      if (!clean || inputSource !== 'voice') return false;
      this.lastSpokenUnifiedReply = {
        text: clean,
        inputSource,
        timestamp: new Date().toISOString()
      };
      if (this.dialogue && this.dialogue.isActive()) {
        this.dialogue.onSpeechStatusChange({ isPlaying: true, isPaused: false });
      }
      if (window.SW_UI) {
        window.SW_UI.setState('speaking');
      }
      if (this.reader && typeof this.reader.readText === 'function') {
        this.reader.readText(clean);
        // Watchdog: if Chrome speechSynthesis hangs or lacks an audio sink, ensure pausedForSpeech clears so mic resumes!
        const estSpeakMs = Math.min(18000, Math.max(2500, clean.length * 75));
        if (this._unifiedSpeechWatchdog) clearTimeout(this._unifiedSpeechWatchdog);
        this._unifiedSpeechWatchdog = setTimeout(() => {
          this._unifiedSpeechWatchdog = null;
          const stillSpeaking = Boolean(this.reader && this.reader.isPlaying && !this.reader.isPaused);
          if (!stillSpeaking && this.dialogue && this.dialogue.isActive() && this.dialogue.pausedForSpeech) {
            this.dialogue.onSpeechStatusChange({ isPlaying: false, isPaused: false });
          }
        }, estSpeakMs);
        return true;
      }
      return false;
    }

    async restorePersistentSessionOnBoot() {
      await this._reconcilePendingNavVerificationOnBoot();
      if (!this.memory) return null;
      const t0 = Date.now();
      const state = await this.memory.loadState();
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        try {
          await new Promise((resolve) => {
            const tm = setTimeout(resolve, 400);
            chrome.runtime.sendMessage({ type: 'SLEEPWALKER_REMINDER_LIST' }, (res) => {
              clearTimeout(tm);
              void chrome.runtime?.lastError;
              if (res && Array.isArray(res.reminders)) {
                this._pendingDueReminders = res.reminders.filter((r) => r && (r.status === 'due' || (r.status === 'scheduled' && r.targetTimeMs <= Date.now())));
              }
              resolve();
            });
          });
        } catch (_e) {}
      }

      // Gather visible headings to enrich page visit context
      const headings = this.outline && typeof this.outline.extractOutline === 'function'
        ? (this.outline.extractOutline() || []).map((h) => h.text)
        : [];
      await this.memory.recordPageVisit({
        url: window.location.href,
        title: document.title,
        headings
      });

      const mode = state && state.sessionMode;
      if (mode === 'active_listening' || mode === 'active_not_listening' || mode === 'paused') {
        this.isOpen = true;
        const isForeground = typeof document === 'undefined' || !document.hidden;
        if (!isForeground) {
          // Background tab: stay calmly asleep until the user focuses or goes back to this tab!
          this.sleepForOtherTab('boot_background_tab');
        } else {
          const listenNow = mode === 'active_listening';
          if (this.dialogue) {
            this.dialogue.active = true;
            this.dialogue.resting = false;
            this.dialogue.pausedForSpeech = false;
            this.dialogue._syncSessionIndicators();
          }
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            try {
              chrome.runtime.sendMessage({
                type: 'SLEEPWALKER_SET_ACTIVE_TAB',
                title: document.title || '',
                url: window.location.href || ''
              }, () => { void chrome.runtime.lastError; });
            } catch (_e) {}
          }
          if (window.SW_UI) {
            window.SW_UI.setState('silent');
            this._setStatusChip(listenNow ? 'Starting microphone...' : 'Ready');
          }
          if (this.voice) {
            this.voice.continuousSession = mode === 'active_listening';
            if (listenNow && this.voice.isSupported && !this.voice.isListening) {
              this.voice.startListening();
            }
          }
          if (this.worldModel) {
            this.worldModel.observeTab(document, { force: false }).catch(() => {});
          }
          if (this.diagnostics) {
            this.diagnostics.log('orb', 'restored', { durationMs: Date.now() - t0, mode, isForeground });
          }
        }

        // Extract compact structured results on destination page if available (helps cross-site lists)
        if (this.navigator && typeof this.navigator.extractPageResults === 'function') {
          const domResults = this.navigator.extractPageResults(document);
          if (domResults.length >= 2 && (!state.currentEntities || !Array.isArray(state.currentEntities.listItems) || state.currentEntities.listItems.length === 0)) {
            this.memory.state.currentEntities.listItems = domResults.map(({ element, ...clean }) => clean);
          }
        }

        // Verify post-navigation completion & continue multi-website workflow if pending
        const pendingNav = Array.isArray(state.pendingActions)
          ? state.pendingActions.find((p) => p && (p.type === 'post_navigation_announce' || p.type === 'verify_navigation_and_continue'))
          : null;
        if (pendingNav) {
          this.memory.state.pendingActions = state.pendingActions.filter((p) => p !== pendingNav);
          const pageErrorRe = /\b(?:404|not\s+found|502\s+bad|503\s+service|err_name_not_resolved|this\s+site\s+can'?t\s+be\s+reached|page\s+unavailable)\b/i;
          const loadFailed = pageErrorRe.test(`${document.title || ''} ${(document.body && document.body.innerText || '').slice(0, 300)}`);

          if (loadFailed && this.taskPlanner) {
            await this.taskPlanner.recordFailure(pendingNav.title || 'Destination Page', `Loaded page appears unavailable ("${document.title || 'error'}")`, window.location.href);
            await this.memory.saveState();
            const errMsg = `I navigated to "${document.title || window.location.href}", but the page appears unavailable. Your task is preserved — say "Try again" or "Go back".`;
            this.setAssistantReply(errMsg);
            if (window.SW_UI) {
              window.SW_UI.setState('error');
              window.SW_UI.showCard({
                type: 'answer',
                title: 'Navigation Issue — Recovering',
                text: errMsg,
                steps: this.taskPlanner.buildProgressCardSteps(this.memory.state.activeTask)
              });
            }
            return state;
          }

          await this.memory.upsertTask({
            visitedUrl: window.location.href,
            completedStep: `Verified load: ${document.title || pendingNav.title || window.location.href}`,
            status: 'RUNNING'
          });
          if (this.taskPlanner && pendingNav.taskStepId) {
            await this.taskPlanner.markStepCompleted(pendingNav.taskStepId, window.location.href);
          }

          // Never bypass CAPTCHA or login security gates on newly opened sites
          const gate = this.navigator && typeof this.navigator.detectSecurityGate === 'function'
            ? this.navigator.detectSecurityGate(document)
            : { blocked: false };
          if (gate && gate.blocked) {
            await this.memory.upsertTask({ status: 'WAITING_FOR_USER', nextRecommendedAction: `User action required: ${gate.reason}` });
            const gateMsg = `${gate.reason} on ${document.title || 'this page'}. Please complete verification or sign in manually, then say "Continue".`;
            this.setAssistantReply(gateMsg);
            if (window.SW_UI) {
              window.SW_UI.showCard({
                type: 'answer',
                title: 'Verification / Sign-In Required',
                text: gateMsg,
                steps: this.taskPlanner ? this.taskPlanner.buildProgressCardSteps(this.memory.state.activeTask) : []
              });
            }
            return state;
          }

          // Chained post-navigation subgoal ("Open the second university's application page")
          let subGoalMsg = '';
          if (pendingNav.followUpSubGoal === 'find_application_page' && this.navigator) {
            const appLink = this.navigator.findSemanticDestinationLink('application', document);
            if (appLink && appLink.element) {
              if (appLink.element.scrollIntoView) appLink.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
              subGoalMsg = ` Found application link "${appLink.label}" on ${document.title || 'this site'}.`;
              await this.memory.upsertTask({
                relevantUrls: [{ title: appLink.label, url: appLink.href || window.location.href, kind: 'application', official: true }],
                nextRecommendedAction: `Open "${appLink.label}" or inspect application form`
              });
            } else if (this.outline && this.outline.fuzzyFindHeading) {
              const appSec = this.outline.fuzzyFindHeading('application');
              if (appSec) {
                this.outline.scrollToHeading(appSec);
                subGoalMsg = ` Scrolled to section "${appSec.text}".`;
              }
            }
          }

          await this.memory.saveState();
          const topic = state.currentTopic || (state.activeTask && state.activeTask.topic) || '';
          const msg = `Opened ${document.title || 'the website'}${topic ? ` for ${topic}` : ''}.${subGoalMsg} I am still listening — ask any follow-up question.`;
          this.setAssistantReply(msg);
          if (window.SW_UI) {
            window.SW_UI.showCard({
              type: 'answer',
              title: document.title ? `On ${document.title.split(/[-|]/)[0].trim()}` : 'Page Loaded',
              text: msg,
              steps: this.taskPlanner && this.memory.state.activeTask ? this.taskPlanner.buildProgressCardSteps(this.memory.state.activeTask) : undefined
            });
          }
        }
      } else if (mode === 'resting') {
        if (this.dialogue) {
          this.dialogue.active = false;
          this.dialogue.resting = true;
        }
      }

      if (this.worldModel && (typeof document === 'undefined' || !document.hidden) && typeof this.worldModel.scheduleProactiveScan === 'function') {
        this.worldModel.scheduleProactiveScan(document, { delayMs: 80, reason: 'boot_proactive' });
      }
      if (this.teach && typeof this.teach.restoreFromBoot === 'function') {
        await this.teach.restoreFromBoot().catch(() => null);
      }

      return state;
    }

    /**
     * Watch SPA history mutations (pushState, replaceState, popstate, hashchange) so Sleepwalker stays synced.
     */
    _installSpaNavigationWatcher() {
      if (this._spaWatcherInstalled || typeof window === 'undefined') return;
      this._spaWatcherInstalled = true;
      let lastHref = window.location.href;

      const onRouteChange = async () => {
        const nextHref = window.location.href;
        if (!nextHref || nextHref === lastHref) return;
        lastHref = nextHref;
        if (this.explainer && typeof this.explainer.invalidateDigestCache === 'function') {
          this.explainer.invalidateDigestCache();
        }
        if (this.navigator && typeof this.navigator.invalidateSearchCache === 'function') {
          this.navigator.invalidateSearchCache();
        }
        if (this.browserEngine) {
          try {
            this.browserEngine.invalidateCache();
            this.browserEngine.observe(document, { force: true });
          } catch (_e) {}
        }
        if (this.worldModel) {
          this.worldModel.observeTab(document, { force: true }).catch(() => {});
        }
        if (!this.memory) return;
        const headings = this.outline && typeof this.outline.extractOutline === 'function'
          ? (this.outline.extractOutline() || []).map((h) => h.text)
          : [];
        await this.memory.recordPageVisit({
          url: nextHref,
          title: document.title,
          headings
        });
        if (this.dialogue && this.dialogue.isActive() && window.SW_UI && window.SW_UI.getState() === 'idle') {
          window.SW_UI.setState(this.voice && this.voice.isListening ? 'listening' : 'silent');
        }
      };

      window.addEventListener('popstate', onRouteChange);
      window.addEventListener('hashchange', onRouteChange);
      window.addEventListener('pageshow', () => {
        if (this.worldModel && typeof this.worldModel.scheduleProactiveScan === 'function') {
          this.worldModel.scheduleProactiveScan(document, { force: true, delayMs: 40 });
        }
      });

      try {
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function (...args) {
          const ret = origPush.apply(this, args);
          setTimeout(onRouteChange, 50);
          return ret;
        };
        history.replaceState = function (...args) {
          const ret = origReplace.apply(this, args);
          setTimeout(onRouteChange, 50);
          return ret;
        };
      } catch (_e) {}
    }

    /**
     * Resume the most recent saved multi-step task or browsing topic cleanly (used on wake or "Continue where we left off").
     */
    async resumeSavedTask() {
      if (!this.memory) {
        return { status: 'no_memory' };
      }
      await this._bootPromise;
      const task = this.memory.state.activeTask;
      const topic = this.memory.state.currentTopic || (task && task.topic) || '';
      const lastAct = this.memory.state.activities.length > 0
        ? this.memory.state.activities[this.memory.state.activities.length - 1]
        : null;

      let msg = '';
      if (task && task.objective) {
        const nextHint = task.nextRecommendedAction || (task.pendingSteps && task.pendingSteps[0]) || 'ask your next question';
        msg = `Continuing ${task.objective}. Last step: ${task.currentStep.replace(/_/g, ' ')}. Next you can say: ${nextHint}.`;
        task.status = 'in_progress';
        await this.memory.saveState();
      } else if (topic) {
        msg = `Resuming our conversation about ${topic}${lastAct ? ` (last command: "${lastAct.user_command}")` : ''}. What would you like to do next?`;
      } else {
        msg = 'I am ready. Tell me what you would like to explore or search on this page.';
      }

      this.setAssistantReply(msg);
      if (window.SW_UI) {
        window.SW_UI.setState('speaking');
        window.SW_UI.showCard({
          type: 'answer',
          title: topic ? `Continuing: ${topic}` : 'Resuming Session',
          text: msg
        });
      }
      if (this.reader) this.reader.readText(msg);

      await this.memory.recordActivity({
        user_command: 'Continue where we left off',
        intent: 'CONVERSATION_CONTROL',
        topic: topic || 'session_resume',
        action: 'resumed_task',
        result: msg
      });
      return { status: 'resumed', topic, message: msg };
    }

    getEffectiveSpeechLang(lang) { return SPEECH_LANGS[lang] || lang || 'en-IN'; }
    resolveReplyLang(c) { return (this.lang && this.lang !== 'auto') ? this.lang : ((c && c.lang && c.lang !== 'auto') ? c.lang : 'en-IN'); }
    setLanguage(code) {
      this.lang = code || 'en-IN';
      if (this.voice) {
        if (typeof this.voice.setLanguage === 'function') this.voice.setLanguage(this.lang);
        else if (typeof this.voice.setLang === 'function') this.voice.setLang(this.lang);
      }
      if (this.reader) this.reader.setLang(this.getEffectiveSpeechLang(this.lang));
      this.savePreferences();
    }

    applyLanguageSwitch(locale, langName = '', requestId = '', taskId = 0) {
      this.setLanguage(locale);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          sleepwalker_lang: locale,
          preferredLanguage: locale
        });
      }

      const localizedConfirmations = {
        'en-IN': 'Language changed to English (India).',
        'en-US': 'Language changed to English (US).',
        'hi-IN': 'भाषा बदलकर हिंदी कर दी गई है।',
        'kn-IN': 'ಭಾಷೆಯನ್ನು ಕನ್ನಡಕ್ಕೆ ಬದಲಾಯಿಸಲಾಗಿದೆ.',
        'ta-IN': 'மொழி தமிழுக்கு மாற்றப்பட்டது.',
        'te-IN': 'భాష తెలుగుకు మార్చబడింది.',
        'ml-IN': 'ഭാഷ മലയാളത്തിലേക്ക് മാറ്റി.',
        'bn-IN': 'ভাষা পরিবর্তন করে বাংলা করা হয়েছে।',
        'mr-IN': 'भाषा बदलून मराठी केली आहे.',
        'fr-FR': 'La langue a été changée en français.',
        'de-DE': 'Die Sprache wurde auf Deutsch umgestellt.',
        'ja-JP': '言語を日本語に変更しました。',
        'es-ES': 'El idioma se ha cambiado a español.'
      };

      const msg = localizedConfirmations[locale] || `Language changed to ${langName || locale}.`;
      this.setAssistantReply(msg);
      if (window.SW_UI) {
        window.SW_UI.setState('speaking');
        window.SW_UI.showCard({
          type: 'answer',
          title: 'Language / भाषा',
          text: msg,
          reqId: requestId
        });
      }
      if (this.reader) {
        this.reader.readText(msg);
      }
      if (this.agentFsm && requestId) {
        this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'language_changed', locale });
      }
      if (taskId) {
        this._finishActiveTask(taskId, 'COMPLETED', msg);
      }
      return { status: 'language_changed', locale, language: langName || locale, answer: msg, verified: true };
    }
    setRate(r) {
      this.rate = Math.max(0.6, Math.min(1.8, Number(r) || 1.0));
      this.reader.setRate(this.rate);
      if (window.SW_UI && window.SW_UI._orb && window.SW_UI._orb.card && typeof window.SW_UI._orb.card.setPrefs === 'function') {
        window.SW_UI._orb.card.setPrefs({ rate: this.rate });
      }
      this.savePreferences();
    }

    _buildPageActionCatalog() {
      const linkIdx = typeof window !== 'undefined' ? window.SleepwalkerLinkIndexInstance : null;
      const formIdx = typeof window !== 'undefined' ? window.SleepwalkerFormIndex : null;
      const rawLinks = linkIdx && typeof linkIdx.getTargets === 'function' ? linkIdx.getTargets(true) : [];
      const rawForms = formIdx && typeof formIdx.buildFormIndex === 'function' ? formIdx.buildFormIndex(document) : [];

      const seen = new Set();
      const skipRe = /^(?:skip\s+to|main\s+content|slide\s+\d+|page\s+\d+|close(?:\s+dialog)?|accept\s+all\s+cookies|manage\s+cookies)$/i;
      const items = [];

      const addItem = (label, kind, priority, commandText) => {
        const clean = String(label || '').replace(/\s+/g, ' ').trim();
        if (!clean || clean.length < 3 || clean.length > 52) return;
        if (skipRe.test(clean) || /^[\W_\d]+$/.test(clean)) return;
        const key = clean.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ label: clean, kind, priority, commandText });
      };

      for (const f of rawForms) {
        if (!f || !f.label) continue;
        addItem(f.sensitive ? `${f.label} (manual field)` : `Fill ${f.label}`, 'input', f.sensitive ? 3 : 8, `fill ${f.label}`);
      }
      for (const t of rawLinks) {
        if (!t || !t.label) continue;
        const p = (t.area === 'main' || t.area === 'card') ? 10 : (t.area === 'nav' || t.area === 'header' ? 9 : 5);
        addItem(t.label, t.role || 'link', p, `open ${t.label}`);
      }

      items.sort((a, b) => b.priority - a.priority);
      return items.slice(0, 42);
    }

    _handleWhatCanIDoHere(isMore = false) {
      const curUrl = typeof window !== 'undefined' && window.location ? window.location.href : '';
      const pageSize = 6;
      if (!isMore || !this._pageActionsCatalog || this._pageActionsCatalog.url !== curUrl || !Array.isArray(this._pageActionsCatalog.items) || this._pageActionsCatalog.items.length === 0) {
        this._pageActionsCatalog = {
          url: curUrl,
          items: this._buildPageActionCatalog(),
          pageIndex: 0,
          pageSize
        };
      } else {
        const totalPages = Math.max(1, Math.ceil(this._pageActionsCatalog.items.length / pageSize));
        this._pageActionsCatalog.pageIndex = (this._pageActionsCatalog.pageIndex + 1) % totalPages;
      }

      const cat = this._pageActionsCatalog;
      const total = cat.items.length;
      if (total === 0) {
        const emptyMsg = 'I did not find clickable options on this page yet. Try scrolling or saying "Explain this page".';
        this.lastSpokenUnifiedReply = emptyMsg;
        if (window.SW_UI) window.SW_UI.showCard({ type: 'answer', title: 'Page Options', text: emptyMsg });
        return { ok: true, verified: true, status: 'what_can_i_do_empty', count: 0 };
      }

      const start = cat.pageIndex * pageSize;
      const slice = cat.items.slice(start, start + pageSize);
      const end = start + slice.length;
      const hasMore = total > pageSize;
      const numberedSummary = slice.map((it, i) => `${i + 1}. ${it.label}`).join('\n');
      const spoken = `${isMore ? 'More options' : 'Here are the top options'} (${start + 1} to ${end} of ${total}): ${slice.map((it, i) => `${i + 1}. ${it.label}`).join(', ')}.${hasMore ? ' Say a number or say "Say more" for more.' : ''}`;

      this.lastSpokenUnifiedReply = `${numberedSummary}\n${hasMore ? 'Say a number or "Say more" for more options.' : ''}`;
      this.setAssistantReply(spoken);
      if (window.SW_UI) {
        window.SW_UI.showCard({
          type: 'choices',
          title: `${isMore ? 'More Page Options' : 'What You Can Do Here'} (${start + 1}–${end} of ${total})`,
          text: hasMore ? 'Pick a number, click an option, or say "Say more" for the next batch:' : 'Pick a number or click an option:',
          choices: slice.map((it) => ({ label: it.label, commandText: it.commandText, kind: it.kind })),
          onAction: (act, payload) => {
            if (act === 'choose' && payload && payload.choice && payload.choice.commandText) {
              this.handleUserInput(payload.choice.commandText, 'typed', {});
            }
          }
        });
      }
      if (this.dialogue && this.dialogue.isActive()) {
        this.dialogue._sayAndDisplay(spoken, { openBubble: false, speak: true });
      }
      return { ok: true, verified: true, status: isMore ? 'say_more_page' : 'what_can_i_do', start: start + 1, end, total, count: slice.length };
    }

    setVoicePersona(personaId, options = {}) {
      if (!this.reader || typeof this.reader.setVoicePersona !== 'function') return null;
      const info = personaId === '__next__'
        ? this.reader.cycleVoicePersona()
        : this.reader.setVoicePersona(personaId);
      this.voicePersona = info.id;
      if (options.clearSpecificVoice) {
        this.voiceURI = '';
        this.reader.setPreferredVoiceURI('');
      }
      if (window.SW_UI && window.SW_UI._orb && window.SW_UI._orb.card && typeof window.SW_UI._orb.card.setPrefs === 'function') {
        window.SW_UI._orb.card.setPrefs({ voicePersona: info.id });
      }
      this.savePreferences();

      const sampleMsg = this.lang === 'hi-IN'
        ? `नमस्ते! अब मेरी आवाज़ ${info.name} (${info.subtitle}) पर सेट है।`
        : `Hi! Switched narrator voice to ${info.name} — ${info.subtitle}.`;

      if (options.showCard && window.SW_UI) {
        const allPersonas = typeof this.reader.getVoicePersonas === 'function' ? this.reader.getVoicePersonas() : [];
        window.SW_UI.showCard({
          type: 'choices',
          title: `Narrator Voice: ${info.name}`,
          text: `${sampleMsg} Tap any voice style below to preview it:`,
          choices: allPersonas.map((p) => ({
            id: p.id,
            label: `${p.name} — ${p.subtitle}${p.id === info.id ? ' ✓' : ''}`
          })),
          onAction: (act, payload) => {
            if (act === 'choose' && payload && payload.choice && payload.choice.id) {
              this.setVoicePersona(payload.choice.id, { preview: true, showCard: true, clearSpecificVoice: true });
            }
          }
        });
      }
      if (options.preview) {
        this.setAssistantReply(sampleMsg);
        if (this.dialogue && this.dialogue.isActive()) {
          this.dialogue._sayAndDisplay(sampleMsg, { openBubble: false, speak: true });
        } else {
          this.reader.readText(sampleMsg);
        }
      }
      return info;
    }
    setAssistantReply(text) { if (this.dialogue && text && !/^(?:Listening\.\.\.|Idle|Ready\b|Reading sentence \d+)/i.test(String(text))) this.dialogue.lastSpokenText = String(text); }
    syncStopButton() {}
    recordError(msg) { if (msg) { this.errors.unshift({ time: new Date().toLocaleTimeString(), message: String(msg) }); this.errors.length = Math.min(10, this.errors.length); } }
    open() { this.isOpen = true; }
    _normalizeTaskPhrase(text) {
      return String(text || '')
        .toLowerCase()
        .replace(/[\u200B-\u200F\uFEFF]/g, '')
        .replace(/[।.,!?;:'"()\[\]]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    _isTaskCancelPhrase(text) {
      const norm = this._normalizeTaskPhrase(text);
      if (!norm) return false;
      return /^(?:no need|cancel(?:\s+(?:it|that|this|the task|task))?|leave it|forget it|never ?mind|stop(?:\s+(?:it|that|this|the task|task|now))?|abort|rehne do|mat karo|ruko|band karo|nahi|नहीं|मत करो|रहने दो|रुको|रोको|बंद करो|कैंसल|रद्द करो)$/i.test(norm);
    }

    _setAuroraTaskUi(state, stage = '', taskLabel = null) {
      const normState = String(state || 'idle').toLowerCase();
      if (normState === 'processing' && this.taskLifecycle && this.taskLifecycle.state === 'CANCELLED') {
        return;
      }
      if (this.taskLifecycle) this.taskLifecycle.stage = stage;
      if (window.SW_UI && typeof window.SW_UI.setTaskStatus === 'function') {
        window.SW_UI.setTaskStatus({
          state: normState,
          stage: String(stage || ''),
          taskLabel: taskLabel !== null ? String(taskLabel) : ((this.taskLifecycle && this.taskLifecycle.activeLabel) || '')
        });
      }
    }

    _isTaskCurrent(taskId, signal = null) {
      if (!this.taskLifecycle || !taskId) return true;
      if (signal && signal.aborted) return false;
      if (this.taskLifecycle.activeTaskId !== taskId) return false;
      return this.taskLifecycle.state === 'PROCESSING' || this.taskLifecycle.state === 'WAITING_FOR_CLARIFICATION';
    }

    _notifyBackgroundCancelLlm(taskId = '') {
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        try {
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CANCEL_ACTIVE_LLM', taskId: String(taskId || '') }, () => { void chrome.runtime.lastError; });
        } catch (_e) {}
      }
    }

    _enterWaitingForClarification(taskId, question, handler) {
      if (!this.taskLifecycle) return;
      if (this.taskLifecycle.resetTimer) {
        clearTimeout(this.taskLifecycle.resetTimer);
        this.taskLifecycle.resetTimer = null;
      }
      this.taskLifecycle.activeTaskId = taskId;
      this.taskLifecycle.state = 'WAITING_FOR_CLARIFICATION';
      this.taskLifecycle.clarificationQuestion = String(question || '');
      this.taskLifecycle.clarificationHandler = typeof handler === 'function' ? handler : null;
      this._setAuroraTaskUi('waiting_for_clarification', 'Waiting for clarification', this.taskLifecycle.activeLabel);
    }

    _getSelectedBackend() {
      if (this.useStagehandAdapter && this.stagehandAdapter) return 'stagehand_adapter';
      if (this.useRebuiltBrowserEngine && this.browserEngine) return 'rebuilt_browser_engine';
      return 'legacy';
    }

    _isCommandTruthfullySuccessful(res) {
      if (!res) return false;
      if (res.awaiting === true) return true;
      const st = String(res.status || '').toLowerCase();
      if (['error', 'failed', 'stagehand_disconnected', 'stagehand_error', 'navigation_failed', 'no_search_field', 'not_found', 'option_not_found', 'verification_failed', 'validation_rejected', 'unrecognized_repeat', 'timeout', 'cancelled', 'task_cancelled', 'aborted_stale_turn', 'duplicate_blocked', 'duplicate_command', 'active_task_busy'].includes(st)) {
        return false;
      }
      if (res.ok === false || res.verified === false) {
        return false;
      }
      return Boolean(res.verified === true || res.ok === true || ['searched', 'filled', 'toggled', 'clicked', 'selected', 'selected_video', 'selected_list_item', 'opened', 'navigated', 'extracted', 'scrolled', 'fast_scrolled', 'reading_page', 'reading_section', 'media_controlled', 'filter_applied', 'greeting_handled', 'language_changed', 'ui_hidden', 'clarified'].includes(st));
    }

    _finishActiveTask(taskId, outcome = 'COMPLETED', stageLabel = '') {
      if (!this.taskLifecycle || this.taskLifecycle.activeTaskId !== taskId) return;
      if (['CANCELLED', 'WAITING_FOR_CLARIFICATION', 'COMPLETED', 'ERROR', 'IDLE'].includes(this.taskLifecycle.state)) return;
      if (this.taskLifecycle.resetTimer) {
        clearTimeout(this.taskLifecycle.resetTimer);
        this.taskLifecycle.resetTimer = null;
      }
      this.taskLifecycle.abortController = null;
      this.taskLifecycle.clarificationHandler = null;
      this.taskLifecycle.clarificationQuestion = '';
      if (outcome === 'ERROR') {
        this.taskLifecycle.state = 'ERROR';
        this._setAuroraTaskUi('error', stageLabel || 'Action failed', this.taskLifecycle.activeLabel);
      } else if (outcome === 'CANCELLED') {
        this.taskLifecycle.state = 'CANCELLED';
        this._setAuroraTaskUi('cancelled', stageLabel || 'Cancelled', this.taskLifecycle.activeLabel);
      } else if (outcome === 'WAITING_FOR_CLARIFICATION') {
        this.taskLifecycle.state = 'WAITING_FOR_CLARIFICATION';
        this._setAuroraTaskUi('waiting_for_clarification', stageLabel || 'Waiting for clarification', this.taskLifecycle.activeLabel);
      } else {
        this.taskLifecycle.state = 'COMPLETED';
        this._setAuroraTaskUi('completed', stageLabel || 'Completed', this.taskLifecycle.activeLabel);
        if (window.SW_UI && typeof window.SW_UI.getState === 'function' && window.SW_UI.getState() === 'thinking' &&
            !(this.reader && this.reader.isPlaying) && !(this.confirm && this.confirm.isAwaiting())) {
          window.SW_UI.setState('silent');
        }
      }
      this.taskLifecycle.resetTimer = setTimeout(() => {
        if (this.taskLifecycle && this.taskLifecycle.activeTaskId === taskId &&
            (this.taskLifecycle.state === 'COMPLETED' || this.taskLifecycle.state === 'ERROR' || this.taskLifecycle.state === 'CANCELLED')) {
          this.taskLifecycle.state = 'IDLE';
          this.taskLifecycle.activeLabel = '';
          this._setAuroraTaskUi('idle', '', '');
        }
      }, 1500);
    }

    cancelActiveTask(reasonText = 'Cancelled.', _opts = {}) {
      const tl = this.taskLifecycle;
      const hadActive = Boolean(
        (tl && (tl.state === 'PROCESSING' || tl.state === 'WAITING_FOR_CLARIFICATION')) ||
        (this.unifiedOrchestrator && this.unifiedOrchestrator.activeCommandId) ||
        (this.confirm && this.confirm.isAwaiting()) ||
        (this.explainer && typeof this.explainer.isInFlight === 'function' && this.explainer.isInFlight())
      );
      if (!hadActive) return { status: 'none' };

      const prevId = tl ? tl.activeTaskId : 0;
      const prevLabel = (tl && tl.activeLabel) || '';
      if (tl) {
        if (tl.resetTimer) { clearTimeout(tl.resetTimer); tl.resetTimer = null; }
        tl.state = 'CANCELLED';
        if (tl.abortController) {
          try { tl.abortController.abort('user_cancelled'); } catch (_e) {}
          tl.abortController = null;
        }
        tl.clarificationHandler = null;
        tl.clarificationQuestion = '';
      }
      this._notifyBackgroundCancelLlm(prevId);
      if (this.agentFsm && typeof this.agentFsm.abortTurn === 'function') {
        try { this.agentFsm.abortTurn('user_cancelled'); } catch (_e) {}
      } else if (this.agentFsm && this.agentFsm.currentTurn) {
        try { this.agentFsm.finishTurn(this.agentFsm.currentTurn.requestId, 'IDLE', { status: 'cancelled' }); } catch (_e) {}
      }
      if (this.explainer && typeof this.explainer.abort === 'function') this.explainer.abort();
      if (this.reader && typeof this.reader.cancelStream === 'function') this.reader.cancelStream();
      else if (this.reader && typeof this.reader.stop === 'function') this.reader.stop();
      if (this.confirm && this.confirm.isAwaiting()) this.confirm.cancel('user_cancelled');
      if (this.dialogue && this.dialogue.pendingPrompt) this.dialogue.pendingPrompt = null;
      if (this.elementSelector && typeof this.elementSelector.clearCandidateOverlay === 'function') {
        this.elementSelector.clearCandidateOverlay();
      }
      if (this.navigator) {
        if (typeof this.navigator.clearCandidateOverlay === 'function') this.navigator.clearCandidateOverlay();
        if (typeof this.navigator.cancelPendingHighlight === 'function') this.navigator.cancelPendingHighlight();
      }
      if (this.teach && typeof this.teach.cancelTeaching === 'function' && this.teach.isTeachingActive && this.teach.isTeachingActive()) {
        this.teach.cancelTeaching('user_cancelled');
      }
      if (this.browserEngine && this.browserEngine.inputController && typeof this.browserEngine.inputController.interrupt === 'function') {
        this.browserEngine.inputController.interrupt();
      }
      if (this.useStagehandAdapter && this.stagehandAdapter && typeof this.stagehandAdapter.cancel === 'function') {
        this.stagehandAdapter.cancel(String(prevId || '')).catch(() => {});
      }
      if (this.unifiedOrchestrator && typeof this.unifiedOrchestrator.cancelActiveCommand === 'function') {
        this.unifiedOrchestrator.cancelActiveCommand(reasonText || 'user_cancelled').catch(() => {});
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        try {
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CLEAR_PENDING_NAV' }, () => { void chrome.runtime?.lastError; });
        } catch (_e) {}
      }

      this.setAssistantReply('Cancelled.');
      this._setStatusChip('Task cancelled.');
      this._setAuroraTaskUi('cancelled', 'Cancelled', prevLabel);
      if (window.SW_UI) {
        window.SW_UI.setState('silent');
        if (typeof window.SW_UI.setScanning === 'function') window.SW_UI.setScanning(false);
        window.SW_UI.setTranscript('Cancelled.');
      }

      if (tl) {
        tl.resetTimer = setTimeout(() => {
          if (this.taskLifecycle && this.taskLifecycle.state === 'CANCELLED' && this.taskLifecycle.activeTaskId === prevId) {
            this.taskLifecycle.state = 'IDLE';
            this.taskLifecycle.activeLabel = '';
            this._setAuroraTaskUi('idle', '', '');
          }
        }, 1200);
      }
      return { status: 'task_cancelled', cancelledTaskId: prevId, answer: 'Cancelled.', reason: reasonText };
    }

    /**
     * Global Emergency Stop (Alt+Shift+X or UI "Stop All" button).
     * Immediately halts all browser, Stagehand, unified orchestrator, AND native Windows desktop actions,
     * releasing any held Win32 mouse/keyboard inputs.
     */
    async triggerEmergencyStop(reason = 'user_emergency_stop') {
      this.emergencyStopActive = true;
      const tl = this.taskLifecycle;
      const prevId = tl ? tl.activeTaskId : 0;
      if (tl) {
        if (tl.resetTimer) { clearTimeout(tl.resetTimer); tl.resetTimer = null; }
        tl.state = 'CANCELLED';
        if (tl.abortController) {
          try { tl.abortController.abort('emergency_stop'); } catch (_e) {}
          tl.abortController = null;
        }
        tl.clarificationHandler = null;
        tl.clarificationQuestion = '';
      }
      this._notifyBackgroundCancelLlm(prevId);
      if (this.agentFsm && typeof this.agentFsm.abortTurn === 'function') {
        try { this.agentFsm.abortTurn('emergency_stop'); } catch (_e) {}
      }
      if (this.explainer && typeof this.explainer.abort === 'function') this.explainer.abort();
      if (this.reader && typeof this.reader.cancelStream === 'function') this.reader.cancelStream();
      else if (this.reader && typeof this.reader.stop === 'function') this.reader.stop();
      if (this.confirm && this.confirm.isAwaiting()) this.confirm.cancel('emergency_stop');
      if (this.browserEngine && this.browserEngine.inputController && typeof this.browserEngine.inputController.interrupt === 'function') {
        this.browserEngine.inputController.interrupt();
      }
      if (this.stagehandAdapter && typeof this.stagehandAdapter.cancel === 'function') {
        this.stagehandAdapter.cancel(String(prevId || '')).catch(() => {});
      }
      if (this.unifiedOrchestrator && typeof this.unifiedOrchestrator.cancelActiveCommand === 'function') {
        await this.unifiedOrchestrator.cancelActiveCommand(`emergency_stop:${reason}`).catch(() => {});
      }

      let desktopStop = null;
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        desktopStop = await new Promise((resolve) => {
          const tm = setTimeout(() => resolve({ success: false, status: 'TIMEOUT', error: 'Desktop emergency stop timed out' }), 3500);
          try {
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_DESKTOP_EMERGENCY_STOP',
              reason: String(reason || 'emergency_stop')
            }, (resp) => {
              clearTimeout(tm);
              void chrome.runtime?.lastError;
              resolve(resp || { success: false, status: 'NO_RESPONSE' });
            });
          } catch (err) {
            clearTimeout(tm);
            resolve({ success: false, status: 'ERROR', error: (err && err.message) || String(err) });
          }
        });
      }

      const stopMsg = 'Emergency Stop triggered — all browser and desktop actions halted. Click "Resume Assistant" or say "Reset emergency stop" when ready.';
      this.setAssistantReply(stopMsg);
      this._setStatusChip('EMERGENCY STOP — all actions halted');
      this._setAuroraTaskUi('cancelled', 'Emergency Stop', 'All actions halted');
      if (window.SW_UI) {
        window.SW_UI.setState('silent');
        if (typeof window.SW_UI.setScanning === 'function') window.SW_UI.setScanning(false);
        window.SW_UI.setTranscript('Emergency Stop');
        if (typeof window.SW_UI.showCard === 'function') {
          window.SW_UI.showCard({
            type: 'error',
            title: 'Emergency Stop Active',
            text: stopMsg,
            autoDismissMs: 0,
            actions: [
              { id: 'resume_assistant', label: 'Resume Assistant', primary: true }
            ],
            onAction: async (actId) => {
              if (actId === 'resume_assistant') {
                await this.resetEmergencyStop('ui_card_resume');
              }
            }
          });
        }
      }
      return {
        ok: true,
        status: 'emergency_stopped',
        emergencyStopped: true,
        reason,
        desktopStop,
        timestamp: new Date().toISOString()
      };
    }

    /**
     * Phase 2: Production Emergency Stop Reset.
     * Refuses reset if an unsafe browser/desktop input operation remains in progress;
     * otherwise clears native SafetyController and extension emergencyStopActive state.
     */
    async resetEmergencyStop(source = 'ui_resume') {
      if ((this.unifiedOrchestrator && this.unifiedOrchestrator.activeCommandId) ||
          (this.stagehandAdapter && this.stagehandAdapter.activeCommandId)) {
        const busyMsg = 'Cannot reset Emergency Stop while an active operation is still shutting down.';
        this.setAssistantReply(busyMsg);
        if (window.SW_UI && typeof window.SW_UI.showCard === 'function') {
          window.SW_UI.showCard({ type: 'error', title: 'Reset Blocked', text: busyMsg });
        }
        return { ok: false, status: 'UNSAFE_INPUT_IN_PROGRESS', error: busyMsg };
      }

      let nativeReset = { ok: true, status: 'LOCAL_ONLY' };
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        nativeReset = await new Promise((resolve) => {
          const tm = setTimeout(() => resolve({ ok: false, status: 'TIMEOUT', error: 'Native reset timed out' }), 3500);
          try {
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_DESKTOP_RESET_EMERGENCY_STOP',
              source: String(source || 'ui_resume')
            }, (resp) => {
              clearTimeout(tm);
              void chrome.runtime?.lastError;
              resolve(resp || { ok: false, status: 'NO_RESPONSE' });
            });
          } catch (err) {
            clearTimeout(tm);
            resolve({ ok: false, status: 'ERROR', error: (err && err.message) || String(err) });
          }
        });
      }

      if (nativeReset && nativeReset.status === 'UNSAFE_INPUT_IN_PROGRESS') {
        const errMsg = nativeReset.error || 'Cannot reset Emergency Stop while a desktop input operation remains in progress.';
        this.setAssistantReply(errMsg);
        if (window.SW_UI && typeof window.SW_UI.showCard === 'function') {
          window.SW_UI.showCard({ type: 'error', title: 'Reset Blocked', text: errMsg });
        }
        return { ok: false, status: 'UNSAFE_INPUT_IN_PROGRESS', error: errMsg, nativeReset };
      }

      this.emergencyStopActive = false;
      if (this.taskLifecycle) {
        this.taskLifecycle.state = 'IDLE';
        this.taskLifecycle.activeLabel = '';
      }
      this._setAuroraTaskUi('idle', '', '');
      const resumeMsg = 'Emergency Stop cleared. Assistant resumed and ready for commands.';
      this.setAssistantReply(resumeMsg);
      this._setStatusChip('Assistant resumed — ready');
      if (window.SW_UI) {
        window.SW_UI.setState(this.voice && this.voice.isListening ? 'listening' : 'silent');
        if (typeof window.SW_UI.showCard === 'function') {
          window.SW_UI.showCard({
            type: 'answer',
            title: 'Assistant Resumed',
            text: resumeMsg
          });
        }
      }
      if (source === 'voice') {
        this._speakUnifiedReply(resumeMsg, 'voice');
      }
      return {
        ok: true,
        verified: true,
        status: 'emergency_stop_reset',
        emergencyStopActive: false,
        source,
        message: resumeMsg,
        nativeReset
      };
    }

    close() { this.dismissUi('close'); }

    dismissUi(reason = 'escape') {
      this.isOpen = false;
      if (this.taskLifecycle) {
        if (this.taskLifecycle.resetTimer) {
          clearTimeout(this.taskLifecycle.resetTimer);
          this.taskLifecycle.resetTimer = null;
        }
        if (this.taskLifecycle.abortController) {
          try { this.taskLifecycle.abortController.abort('ui_dismissed'); } catch (_e) {}
          this.taskLifecycle.abortController = null;
        }
        this._notifyBackgroundCancelLlm(this.taskLifecycle.activeTaskId);
        this.taskLifecycle.clarificationHandler = null;
        this.taskLifecycle.clarificationQuestion = '';
        this.taskLifecycle.state = 'IDLE';
        this.taskLifecycle.activeLabel = '';
        this._setAuroraTaskUi('idle', '', '');
      }
      if (this.camera && this.camera.isActive()) this.camera.cancelCapture();
      if (this.confirm && this.confirm.isAwaiting()) this.confirm.cancel('user_escape');
      if (this.confirm && this.confirm.isPlanActive()) this.confirm.cancelPlan('user_escape');
      if (this.forms && this.forms.isGuidedActive()) this.forms.stopGuidedFill('cancelled');
      if (this.reader && this.reader.isPlaying) this.stopReading();
      if (this.explainer) this.explainer.abort();
      if (this.elementSelector && typeof this.elementSelector.clearCandidateOverlay === 'function') {
        this.elementSelector.clearCandidateOverlay();
      }
      if (this.navigator) {
        if (typeof this.navigator.clearCandidateOverlay === 'function') this.navigator.clearCandidateOverlay();
        if (typeof this.navigator.cancelPendingHighlight === 'function') this.navigator.cancelPendingHighlight();
      }
      if (this.teach && typeof this.teach.cancelTeaching === 'function' && this.teach.isTeachingActive && this.teach.isTeachingActive()) {
        this.teach.cancelTeaching('user_escape');
      }
      if (this.stagehandAdapter && typeof this.stagehandAdapter.cancel === 'function' && this.useStagehandAdapter) {
        this.stagehandAdapter.cancel('').catch(() => {});
      }
      if (this.unifiedOrchestrator && this.unifiedOrchestrator.activeCommandId && typeof this.unifiedOrchestrator.cancelActiveCommand === 'function') {
        this.unifiedOrchestrator.cancelActiveCommand(`ui_dismissed:${reason}`).catch(() => {});
      }
      if (window.SW_UI && typeof window.SW_UI.setScanning === 'function') {
        window.SW_UI.setScanning(false);
      }

      if (reason === 'escape' || reason === 'close' || reason === 'hide_ui') {
        if (this.dialogue && this.dialogue.isActive()) {
          this.dialogue.endSession({ reason: 'escape', quiet: true, force: true });
        } else if (this.voice) {
          this.voice.stopListening();
        }
        if (this.memory) this.memory.setSessionMode('hidden');
      } else {
        if (this.dialogue && this.dialogue.isActive()) this.dialogue.endSession({ reason, quiet: true, force: true });
        else if (this.voice) this.voice.stopListening();
        if (this.memory) this.memory.setSessionMode(reason === 'toggle' ? 'ended' : 'hidden');
      }
      if (this.voice && this.voice._fallbackMode === 'relay') {
        this.voice.stopListening({ closeRelayWindow: true });
      }
      if (window.SW_UI) window.SW_UI.hide({ dissolve: reason !== 'instant' });
    }

    toggle(options = {}) {
      if (!this._bootDone && this._bootPromise) {
        return this._bootPromise.then(() => this._toggleBody(options));
      }
      return this._toggleBody(options);
    }

    _toggleBody(options = {}) {
      const isCurrentlyResting = Boolean((this.dialogue && this.dialogue.resting) || (this.memory && this.memory.isResting()));

      if (this.reader && this.reader.isPlaying && !this.reader.isPaused && this.dialogue) {
        if (!isCurrentlyResting && window.SW_UI && window.SW_UI.getState() !== 'idle') {
          this.dialogue.interruptSpeech({ source: options.source || 'alt_s', resumeSession: true });
          window.SW_UI.setState('listening');
          return;
        }
        this.reader.stop();
      }

      const now = Date.now();
      if (this._lastToggleTime && now - this._lastToggleTime < 350) return;
      this._lastToggleTime = now;

      const curUiState = window.SW_UI ? window.SW_UI.getState() : 'idle';
      const isMicErrorRecovery = Boolean(
        curUiState === 'error' ||
        ((curUiState === 'silent' || curUiState === 'completed') && this.voice && (!this.voice.isListening || this.voice.isPaused))
      );
      if (isMicErrorRecovery && this.voice) {
        this._pausedMicForTyping = false;
        if (window.SW_UI) {
          window.SW_UI.hideCard();
          window.SW_UI.setState('silent');
          window.SW_UI.setTranscript('Starting microphone...');
        }
        if (this.dialogue) {
          this.dialogue.active = true;
          this.dialogue.resting = false;
          this.dialogue.pausedForSpeech = false;
        }
        if (options.source === 'orb' && (this.voice._lastErrorCode === 'not-allowed' || this.voice._lastErrorCode === 'service-not-allowed')) {
          this.voice.requestMicPermissionWithGesture();
        } else {
          this.voice.continuousSession = true;
          this.voice._recreateRecognition();
          this.voice.startListening();
        }
        return;
      }

      // Never accidentally dismiss/cancel an actively running command just because the user tapped the orb!
      if (this.taskLifecycle && this.taskLifecycle.state === 'PROCESSING' && this._inFlightExecCount > 0) {
        this._setStatusChip(`Working on "${this.taskLifecycle.activeLabel || 'command'}" — click Cancel to stop`);
        return;
      }

      if (!isCurrentlyResting && window.SW_UI && curUiState !== 'idle') {
        this.dismissUi('toggle');
        return;
      }

      const wasRestingOrHidden = this.memory && (
        this.memory.isResting() ||
        this.memory.getSessionMode() === 'hidden' ||
        this.memory.didBrowserRestart ||
        this._pendingDueReminders.length > 0
      );
      if (this.memory) this.memory.didBrowserRestart = false;
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({
            type: 'SLEEPWALKER_SET_ACTIVE_TAB',
            title: document.title || '',
            url: window.location.href || ''
          }, () => { void chrome.runtime.lastError; });
        } catch (_e) {}
      }
      if (window.SW_UI) {
        window.SW_UI.setState('silent');
        window.SW_UI.setTranscript('Starting microphone...');
      }
      this.isOpen = true;
      if (this.worldModel) {
        this.worldModel.observeTab(document, { force: false }).catch(() => {});
      }
      if (this.dialogue) {
        this.dialogue.startSession({
          source: wasRestingOrHidden ? 'wake_resume' : (options.source || 'alt_s')
        });
      } else if (this.voice) {
        this.voice.startListening();
      }
    }

    startHoldToTalk() {
      if (this.reader && this.reader.isPlaying) this.reader.stop();
      this.voice.startListening();
      if (window.SW_UI) { window.SW_UI.setState('listening'); window.SW_UI.setTranscript('Listening (Hold Alt+Z)...'); }
    }

    stopHoldToTalk() {
      const committed = this.voice.stopListeningAndCommit();
      if (window.SW_UI) window.SW_UI[committed ? 'setState' : 'hide'](committed ? 'thinking' : { dissolve: true });
    }

    simulateVoiceInput(text, opts = {}) {
      const clean = String(text || '').trim();
      if (!clean) return Promise.resolve(null);
      if (this.dialogue) this.dialogue.noteSpeechActivity({ fromVoice: true });
      if (window.SW_UI) window.SW_UI.setTranscript(clean);
      return this.handleUserInput(clean, opts.source || 'voice', { simulated: true, asrConfidence: opts.confidence ?? 0.98 });
    }

    _collectLiveCommandCandidates() {
      if (typeof document === 'undefined') return [];
      const out = [];
      const seen = new Set();
      const pushLabel = (raw, kind) => {
        const lbl = String(raw || '').replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
        if (!lbl || lbl.length < 2 || lbl.length > 80) return;
        const key = `${kind}:${lbl.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ label: lbl, kind });
      };

      try {
        // 1. Open popup / dropdown / menu items first (highest contextual relevance)
        if (this.unifiedOrchestrator && this.unifiedOrchestrator.browserAdapter && typeof this.unifiedOrchestrator.browserAdapter._listOpenMenuOptions === 'function') {
          for (const opt of this.unifiedOrchestrator.browserAdapter._listOpenMenuOptions()) {
            if (opt && opt.label) pushLabel(opt.label, 'open_menu');
          }
        }

        // 2. Visible interactive controls (buttons, links, tabs, menuitems)
        const ctrlNodes = document.querySelectorAll(
          'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="option"], ytd-guide-entry-renderer a#endpoint, ytd-compact-link-renderer'
        );
        for (let i = 0; i < ctrlNodes.length && out.length < 110; i++) {
          const el = ctrlNodes[i];
          if (el.closest && el.closest('#sleepwalker-root, .sleepwalker-exclude, [aria-hidden="true"]')) continue;
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (!r || r.width <= 0 || r.height <= 0) continue;
          const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          if (label) pushLabel(label, 'control');
        }

        // 3. Visible form inputs / question labels
        const inputNodes = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select, [role="textbox"], [role="combobox"]');
        for (let i = 0; i < inputNodes.length && out.length < 145; i++) {
          const el = inputNodes[i];
          if (el.disabled || el.readOnly) continue;
          let lbl = '';
          const lbIds = (el.getAttribute && el.getAttribute('aria-labelledby')) || '';
          if (lbIds) {
            lbl = lbIds.split(/\s+/).map((id) => {
              const n = id && document.getElementById(id);
              return n ? (n.innerText || n.textContent || '').trim() : '';
            }).filter(Boolean).join(' ');
          }
          if (!lbl) {
            const cardH = el.closest && el.closest('[role="listitem"], .question-container')?.querySelector('[role="heading"], h2, h3, h4');
            if (cardH) lbl = (cardH.innerText || cardH.textContent || '').trim();
          }
          if (!lbl && el.id) {
            const forLbl = document.querySelector(`label[for="${CSS.escape ? CSS.escape(el.id) : el.id}"]`);
            if (forLbl) lbl = (forLbl.innerText || forLbl.textContent || '').trim();
          }
          if (!lbl) {
            const aria = (el.getAttribute('aria-label') || '').trim();
            if (aria && !/^(?:your\s+answer|short\s+answer|long\s+answer)$/i.test(aria)) lbl = aria;
          }
          if (!lbl) lbl = (el.getAttribute('placeholder') || el.name || '').trim();
          if (lbl) pushLabel(lbl, 'input');
        }
      } catch (_e) {}

      return out;
    }

    handleUserInput(text, inputSource = 'voice', meta = {}) {
      const rawTrim = String(text || '').trim();
      let cleanInput = (this.voice && typeof this.voice.stripWakePrefix === 'function')
        ? this.voice.stripWakePrefix(rawTrim)
        : rawTrim;

      // Page-grounded Fuzzy Matcher + Chrome N-Best Backup Guess Re-Ranker (< 2ms, 0-LLM)
      if (
        cleanInput &&
        !(meta && (meta.skipFuzzyNormalize || meta.internalResumeTaskId)) &&
        !(this.taskLifecycle && this.taskLifecycle.state === 'WAITING_FOR_CLARIFICATION') &&
        typeof window !== 'undefined' &&
        window.SleepwalkerMatch &&
        typeof window.SleepwalkerMatch.resolveFuzzyCommandAndAlternatives === 'function'
      ) {
        try {
          const candidates = this._collectLiveCommandCandidates();
          const resolved = window.SleepwalkerMatch.resolveFuzzyCommandAndAlternatives({
            primaryText: cleanInput,
            alternatives: (meta && meta.asrAlternatives) || [],
            candidates,
            inputSource
          });
          if (resolved && resolved.changed && resolved.text) {
            console.log(`[Sleepwalker Fuzzy/N-Best] "${cleanInput}" -> "${resolved.text}" (${resolved.reason})`);
            cleanInput = resolved.text;
            text = resolved.text;
            meta = {
              ...(meta || {}),
              originalRawText: rawTrim,
              fuzzyResolution: resolved
            };
            if (inputSource === 'voice') {
              this._setStatusChip(`Command matched: "${resolved.text}"`);
            }
          }
        } catch (_e) {}
      }

      const normInput = this._normalizeTaskPhrase(cleanInput);
      const tl = this.taskLifecycle;

      // Fast-Path 0A: Instant Narrator Voice Persona Switch ("change voice", "switch narrator voice", "use deep/male/orion voice", "use aria voice")
      if (cleanInput && !(tl && tl.state === 'WAITING_FOR_CLARIFICATION')) {
        const voiceCmdMatch = cleanInput.match(
          /^(?:(?:change|switch|cycle|try\s+(?:a\s+)?(?:different|another|new)|pick|choose|set|use)\s+(?:the\s+)?(?:narrator\s+|assistant\s+|speaking\s+|tts\s+)?voice(?:\s+(?:to|as)\s+(.+))?|(?:use|switch\s+to|set)\s+(nova|aria|orion|sage|breeze|male|female|deep|warm|bright|calm|lively|storyteller)\s+voice)$/i
        );
        if (voiceCmdMatch) {
          const hint = String(voiceCmdMatch[1] || voiceCmdMatch[2] || '').trim().toLowerCase();
          let targetPersona = '__next__';
          if (/\b(?:orion|male|man|deep|calm|low|studio)\b/.test(hint)) targetPersona = 'orion';
          else if (/\b(?:aria|bright|expressive|energetic|female)\b/.test(hint)) targetPersona = 'aria';
          else if (/\b(?:nova|warm|natural|default)\b/.test(hint)) targetPersona = 'nova';
          else if (/\b(?:sage|storyteller|crisp|british)\b/.test(hint)) targetPersona = 'sage';
          else if (/\b(?:breeze|lively|fast|snappy)\b/.test(hint)) targetPersona = 'breeze';
          const info = this.setVoicePersona(targetPersona, { preview: true, showCard: true, clearSpecificVoice: true });
          return Promise.resolve({ ok: true, verified: true, status: 'voice_changed', voicePersona: info && info.id });
        }

        // Fast-Path 0C: "What can I do here" & "Say more" paginated page action guide (universal across all websites)
        if (/^(?:what\s+can\s+(?:i|we)\s+do(?:\s+here|\s+on\s+this\s+page)?|what\s+options\s+are\s+(?:here|available)|show\s+(?:me\s+)?(?:the\s+)?(?:page\s+)?actions|yahan\s+kya\s+kar\s+sakte\s+(?:hain|ho)|ಇಲ್ಲಿ\s+ಏನು\s+ಮಾಡಬಹುದು)$/i.test(cleanInput)) {
          return Promise.resolve(this._handleWhatCanIDoHere(false));
        }
        if (/^(?:say\s+more|more\s+options|show\s+more\s+options|next\s+options|aur\s+(?:options|dikhao|batao)|और\s+(?:बताओ|दिखाओ)|ಇನ್ನಷ್ಟು(?:\s+ತೋರಿಸಿ)?)$/i.test(cleanInput) && this._pageActionsCatalog && this._pageActionsCatalog.items && this._pageActionsCatalog.items.length > 0) {
          return Promise.resolve(this._handleWhatCanIDoHere(true));
        }

        // Fast-Path 0B: Cross-Tab & In-Tab "Go Back / Previous Page" (wakes sleeping previous webpage tab when current page opened in a new tab!)
        if (/^(?:go\s+back(?:\s+to\s+(?:the\s+)?(?:previous|last)\s+(?:page|webpage|tab|site))?|(?:go\s+to|open|switch\s+(?:back\s+)?to|return\s+to|back\s+to)\s+(?:the\s+)?(?:previous|last)\s+(?:page|webpage|tab|site))$/i.test(cleanInput) && this.navigator) {
          const preferTab = /\b(?:tab|webpage|site)\b/i.test(cleanInput);
          this._setStatusChip('Returning to previous page...');
          return Promise.resolve(this.navigator.historyAction('back', 0.98, { fastPath: true, skipConfirm: true, preferPreviousTab: preferTab }));
        }
      }

      // Priority 4A: Immediate cancellation bypasses _commandQueue so active LLM/TTS work aborts right away
      if (cleanInput && this._isTaskCancelPhrase(cleanInput)) {
        const hasCancelableWork = Boolean(
          (tl && ((tl.state === 'PROCESSING' && this._inFlightExecCount > 0) || tl.state === 'WAITING_FOR_CLARIFICATION')) ||
          (this.confirm && this.confirm.isAwaiting()) ||
          (this.explainer && typeof this.explainer.isInFlight === 'function' && this.explainer.isInFlight())
        );
        if (hasCancelableWork) {
          return Promise.resolve(this.cancelActiveTask(cleanInput, { source: inputSource }));
        }
      }

      // Priority 4B: Answer to active clarification question keeps the SAME active task context
      if (cleanInput && tl && tl.state === 'WAITING_FOR_CLARIFICATION' && !(meta && meta.internalResumeTaskId)) {
        const clarifyTaskId = tl.activeTaskId;
        const clarifyHandler = tl.clarificationHandler;
        if (typeof clarifyHandler === 'function') {
          tl.clarificationHandler = null;
          tl.state = 'PROCESSING';
          this._setAuroraTaskUi('processing', 'Performing action', tl.activeLabel);
          return Promise.resolve(clarifyHandler(cleanInput, { inputSource, meta, taskId: clarifyTaskId }))
            .then((res) => {
              if (!res || (res.status !== 'needs_clarification' && res.status !== 'task_cancelled')) {
                this._finishActiveTask(clarifyTaskId, (res && res.ok === false) ? 'ERROR' : 'COMPLETED', 'Completed');
              }
              return res;
            })
            .catch((err) => {
              this._finishActiveTask(clarifyTaskId, 'ERROR', 'Action failed');
              throw err;
            });
        }
      }

      // Priority 4C: Active task lock — reject duplicate commands mid-execution, but allow newer consecutive commands to preempt / execute cleanly
      if (cleanInput && tl && !(meta && meta.internalResumeTaskId) && !(meta && meta.allowQueue)) {
        if ((tl.state === 'PROCESSING' || this._inFlightExecCount > 0) && tl.abortController) {
          const isDup = Boolean(normInput && normInput === tl.lastSubmittedNorm);
          if (isDup) {
            return Promise.resolve({
              status: 'task_locked',
              activeTaskId: tl.activeTaskId,
              reason: 'duplicate_command'
            });
          }
          // Newer consecutive command arrived while previous command is still running:
          // Preempt / cancel the in-flight work so the new command is never blocked or rejected!
          console.warn(`[Sleepwalker Lifecycle] Aborting previous in-flight task #${tl.activeTaskId} for newer command: "${cleanInput}"`);
          if (tl.abortController) {
            try { tl.abortController.abort('superseded_by_newer_command'); } catch (_e) {}
          }
          if (this.useStagehandAdapter && this.stagehandAdapter && typeof this.stagehandAdapter.cancel === 'function') {
            this.stagehandAdapter.cancel(String(tl.activeTaskId || '')).catch(() => {});
          }
          if (this.unifiedOrchestrator && typeof this.unifiedOrchestrator.cancelActiveCommand === 'function') {
            this.unifiedOrchestrator.cancelActiveCommand('superseded_by_newer_command').catch(() => {});
          }
          if (this.agentFsm && this.agentFsm.currentTurn) {
            try { this.agentFsm.finishTurn(this.agentFsm.currentTurn.requestId, 'IDLE', { status: 'superseded_by_newer_command' }); } catch (_e) {}
          }
          this._finishActiveTask(tl.activeTaskId, 'CANCELLED', 'Cancelled');
          this._inFlightExecCount = 0;
        }
      }

      if (cleanInput && tl && !(meta && meta.internalResumeTaskId)) {
        if (tl.resetTimer) { clearTimeout(tl.resetTimer); tl.resetTimer = null; }
        const nextTaskId = tl.activeTaskId + 1;
        const newAbortController = typeof AbortController === 'function' ? new AbortController() : null;
        tl.activeTaskId = nextTaskId;
        tl.state = 'PROCESSING';
        tl.activeLabel = cleanInput.slice(0, 68);
        tl.abortController = newAbortController;
        tl.clarificationHandler = null;
        tl.clarificationQuestion = '';
        tl.lastSubmittedNorm = normInput;
        tl.lastSubmittedAt = Date.now();
        this._inFlightExecCount = 1;
        meta = { ...(meta || {}), _taskId: nextTaskId, _taskAbortController: newAbortController };
      }

      if (text && String(text).trim() && !(meta && meta.noPreempt)) {
        if (this.explainer && typeof this.explainer.isInFlight === 'function' && this.explainer.isInFlight()) {
          this.explainer.abort();
        }
        if (this.reader && typeof this.reader.isStreamingActive === 'function' && this.reader.isStreamingActive()) {
          this.reader.cancelStream();
        }
      }
      const queued = this._commandQueue.then(
        () => this._processUserInputInner(text, inputSource, meta),
        () => this._processUserInputInner(text, inputSource, meta)
      );
      this._commandQueue = queued.catch(() => null);
      return queued;
    }

    async _processUserInputInner(text, inputSource = 'voice', meta = {}) {
      const rawClean = (this.voice && typeof this.voice.stripWakePrefix === 'function')
        ? this.voice.stripWakePrefix(String(text || '').trim())
        : String(text || '').trim();
      const tl = this.taskLifecycle;
      let taskId = (meta && meta._taskId) || ((meta && meta.internalResumeTaskId) || (tl ? tl.activeTaskId : 0));
      let abortController = (meta && meta._taskAbortController) || (tl ? tl.abortController : null);
      if (tl && rawClean && (meta && meta.internalResumeTaskId)) {
        if (tl.resetTimer) { clearTimeout(tl.resetTimer); tl.resetTimer = null; }
        tl.activeTaskId = taskId;
        tl.state = 'PROCESSING';
        tl.abortController = abortController;
      }
      if (tl && rawClean) {
        this._setAuroraTaskUi('processing', 'Understanding request', tl.activeLabel);
      }

      if (this.dialogue) {
        this.dialogue._externalTurnInProgress = true;
        if (typeof this.dialogue._clearSilenceTimers === 'function') this.dialogue._clearSilenceTimers();
      }
      if (window.SW_UI && window.SW_UI._orb) {
        window.SW_UI._orb._processingTurn = true;
        if (window.SW_UI._orb.card && typeof window.SW_UI._orb.card._clearDismissTimer === 'function') {
          window.SW_UI._orb.card._clearDismissTimer();
        }
      }
      let out = null;
      try {
        const isUnifiedTurn = Boolean(this.unifiedOrchestrator && this.unifiedOrchestrator.shouldHandleCommand(rawClean));
        const turnBudgetMs = isUnifiedTurn ? 90000 : 20000;
        const turnPromise = this._processUserInputBody(text, inputSource, {
          ...(meta && typeof meta === 'object' ? meta : {}),
          _taskId: taskId,
          _taskSignal: abortController ? abortController.signal : null
        });
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Turn timed out after ${(turnBudgetMs / 1000).toFixed(1)}s.`)), turnBudgetMs);
        });
        out = await Promise.race([turnPromise, timeoutPromise]);
        return out;
      } catch (err) {
        console.error('[Sleepwalker Lifecycle] Error during userInput:', err);
        const errMsg = (err && err.message) || 'Action failed';
        out = { ok: false, verified: false, status: 'error', message: errMsg, error: errMsg };
        if (taskId) this._finishActiveTask(taskId, 'ERROR', errMsg);
        return out;
      } finally {
        this._inFlightExecCount = Math.max(0, this._inFlightExecCount - 1);
        if (taskId) {
          const st = out && out.status;
          if (st === 'needs_clarification' || st === 'waiting_for_user' || st === 'awaiting_skill_confirmation') {
            this._finishActiveTask(taskId, 'WAITING_FOR_CLARIFICATION', 'Waiting for clarification');
          } else if (st === 'task_cancelled' || st === 'aborted_stale_turn') {
            this._finishActiveTask(taskId, 'CANCELLED', 'Cancelled');
          } else {
            const truthfullyOk = this._isCommandTruthfullySuccessful(out);
            const stageLabel = truthfullyOk ? 'Completed' : ((out && (out.message || out.reason || out.status)) || 'Action failed');
            this._finishActiveTask(taskId, truthfullyOk ? 'COMPLETED' : 'ERROR', stageLabel);
          }
        }
        if (window.SW_UI && window.SW_UI._orb) {
          window.SW_UI._orb._processingTurn = false;
          if (window.SW_UI._orb.card && typeof window.SW_UI._orb.card._syncAutoDismiss === 'function') {
            window.SW_UI._orb.card._syncAutoDismiss();
          }
        }
        if (this.dialogue) {
          this.dialogue._externalTurnInProgress = false;
          if (this.dialogue.active && typeof this.dialogue._isSystemSpeaking === 'function' &&
              !this.dialogue._isSystemSpeaking() && !this.dialogue.pausedForSpeech &&
              typeof this.dialogue._scheduleSilenceTimers === 'function') {
            this.dialogue._scheduleSilenceTimers();
          }
        }
      }
    }

    async _executeUnifiedOrchestratedTurn(raw, inputSource = 'typed', turnCtx = {}) {
      const {
        cmdId = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        taskId = 0,
        requestId = cmdId,
        tracker = window.__SW_LIFECYCLE_TRACKER__,
        unifiedContextHint = {
          browser: {
            url: typeof window !== 'undefined' ? window.location.href : '',
            title: typeof document !== 'undefined' ? (document.title || '') : ''
          }
        },
        preservedOriginalCommand = null,
        clarificationAnswer = null
      } = turnCtx;

      if (this.loadPreferencesPromise) {
        await this.loadPreferencesPromise.catch(() => {});
      }
      if (tracker) tracker.startStage(cmdId, 'unified_orchestration', { backend: 'unified_orchestrator' });
      const effectiveTaskIdStr = `task-${taskId || Date.now().toString(36)}`;
      const navCallbacks = this._buildNavigationContinuationCallbacks(inputSource);

      const orchRes = await this.unifiedOrchestrator.executeCommand(raw, {
        taskId: effectiveTaskIdStr,
        commandId: cmdId,
        inputSource,
        asrAlternatives: Array.isArray(turnCtx.asrAlternatives) ? turnCtx.asrAlternatives : [],
        onBeforeNavigationStep: navCallbacks.recordBeforeNav,
        onAfterInPageStep: navCallbacks.clearAfterInPage,
        inBrowserTab: true,
        timeoutMs: 80000
      });

      const executedEngines = Array.isArray(orchRes && orchRes.completedSteps)
        ? orchRes.completedSteps.map((s) => s.engine).filter(Boolean)
        : [];
      const fallbackUsed = Boolean(
        executedEngines.includes('existing_browser_engine_fallback') ||
        (Array.isArray(orchRes && orchRes.stepResults) &&
          orchRes.stepResults.some((sr) => sr && sr.execution && sr.execution.evidence && sr.execution.evidence.fallbackUsed === true)) ||
        (Array.isArray(orchRes && orchRes.completedSteps) &&
          orchRes.completedSteps.some((s) => s.evidence && s.evidence.fallbackUsed === true))
      );
      const primaryExecutedEngine = executedEngines[executedEngines.length - 1] || (orchRes ? orchRes.route : 'unified_orchestrator');

      if (tracker) {
        tracker.finishStage(cmdId, 'unified_orchestration', {
          success: Boolean(orchRes && orchRes.ok),
          backend: primaryExecutedEngine,
          errorDetails: orchRes && orchRes.error ? (orchRes.error.message || orchRes.error.code || String(orchRes.error)) : null
        });
        tracker.recordTerminalState(cmdId, orchRes && orchRes.ok ? 'completed' : String((orchRes && orchRes.status) || 'failed').toLowerCase(), {
          backend: primaryExecutedEngine,
          route: orchRes ? orchRes.route : 'unknown',
          fallbackUsed,
          reason: orchRes && orchRes.error ? orchRes.error.message : undefined
        });
      }

      const rawExtractedInfo = (orchRes && orchRes.sharedArtifacts && orchRes.sharedArtifacts.extractedInfo) ||
        (orchRes && orchRes.artifacts && orchRes.artifacts.extractedInfo) ||
        (orchRes && orchRes.sharedData && orchRes.sharedData.extractedInfo) ||
        '';
      const extractedSummary = rawExtractedInfo ? String(rawExtractedInfo).slice(0, 460) : '';
      const replyMsg = orchRes && orchRes.ok
        ? (extractedSummary
            ? `${orchRes.understoodSummary}: ${extractedSummary}`
            : `${orchRes.understoodSummary} (${orchRes.completedSteps.length}/${orchRes.plan ? orchRes.plan.steps.length : orchRes.completedSteps.length} verified).`)
        : (orchRes && orchRes.userPrompt)
          ? orchRes.userPrompt
          : `Could not complete "${raw}": ${(orchRes && orchRes.error && orchRes.error.message) || 'Execution failed'}`;

      this.setAssistantReply(replyMsg);

      // Phase 3: Wire WAITING_FOR_USER into _enterWaitingForClarification() preserving original command & commandId!
      if (orchRes && orchRes.status === 'WAITING_FOR_USER') {
        const originalCmdText = preservedOriginalCommand || raw;
        const originalCmdId = cmdId;
        const clarifyChoices = ['In Notepad', 'In browser'];

        const buildResolvedClarifiedText = (ansRaw) => {
          const ans = String(ansRaw || '').trim();
          const lowAns = ans.toLowerCase();
          if (/\b(?:notepad|calculator|calc|desktop|local)\b/i.test(lowAns)) {
            const appName = /\bcalc(?:ulator)?\b/i.test(lowAns) ? 'Calculator' : 'Notepad';
            if (/^(?:please\s+)?(?:type|write|enter|jot(?:\s+down)?|put)\s+(.+)/i.test(originalCmdText)) {
              const body = originalCmdText.replace(/^(?:please\s+)?(?:type|write|enter|jot(?:\s+down)?|put)\s+/i, '').trim();
              return `Open ${appName} and type ${body}`;
            }
            if (/^\s*save\b/i.test(originalCmdText)) {
              return `Save file to Documents in ${appName}`;
            }
            return `Open ${appName} and ${originalCmdText}`;
          }
          if (/\b(?:browser|chrome|web|webpage|page|online|search)\b/i.test(lowAns)) {
            if (/^(?:please\s+)?(?:type|write|enter|fill)\s+(.+)/i.test(originalCmdText)) {
              const val = originalCmdText.replace(/^(?:please\s+)?(?:type|write|enter|fill)\s+/i, '').replace(/^["']|["']$/g, '').trim();
              return `Fill search with "${val}"`;
            }
            return `Search the web for ${originalCmdText}`;
          }
          return `${originalCmdText} ${ans}`;
        };

        const handleClarificationFollowUp = async (answerText, info = {}) => {
          if (this.dialogue) this.dialogue.pendingPrompt = null;
          const nextInputSource = (info && info.inputSource) || inputSource;
          const combinedText = buildResolvedClarifiedText(answerText);
          return this._executeUnifiedOrchestratedTurn(combinedText, nextInputSource, {
            cmdId: originalCmdId,
            taskId: (info && info.taskId) || taskId,
            requestId,
            tracker,
            unifiedContextHint: {
              browser: {
                url: typeof window !== 'undefined' ? window.location.href : '',
                title: typeof document !== 'undefined' ? (document.title || '') : ''
              }
            },
            preservedOriginalCommand: originalCmdText,
            clarificationAnswer: answerText
          });
        };

        this._enterWaitingForClarification(taskId, replyMsg, handleClarificationFollowUp);
        if (this.dialogue && this.dialogue.isActive()) {
          this.dialogue.setPendingPrompt({
            kind: 'choice',
            label: 'unified_target_clarification',
            askedText: replyMsg,
            options: clarifyChoices,
            onAnswer: async (pickedOpt) => handleClarificationFollowUp(pickedOpt, { inputSource: 'voice', taskId })
          });
        }
        if (window.SW_UI) {
          window.SW_UI.setState('confirm');
          if (typeof window.SW_UI.showCard === 'function') {
            window.SW_UI.showCard({
              type: 'choices',
              title: 'Clarify Target',
              text: replyMsg,
              choices: clarifyChoices,
              reqId: requestId,
              onAction: async (_id, detail) => {
                const chosen = (detail && typeof detail.choice === 'string' && detail.choice) ||
                  (detail && typeof detail.index === 'number' && clarifyChoices[detail.index]) ||
                  'In Notepad';
                await handleClarificationFollowUp(chosen, { inputSource: 'typed', taskId });
              }
            });
          }
        }
        if (inputSource === 'voice') {
          this._speakUnifiedReply(replyMsg, 'voice');
        }
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'WAITING_FOR_USER' });
        return {
          ok: false,
          verified: false,
          awaiting: true,
          status: 'waiting_for_user',
          commandId: originalCmdId,
          originalCommand: originalCmdText,
          backend: 'clarification',
          engine: 'unified_orchestrator',
          message: replyMsg,
          orchestration: orchRes
        };
      }

      if (window.SW_UI && typeof window.SW_UI.showCard === 'function') {
        const cardTitle = orchRes && orchRes.route === 'cross_backend'
          ? 'Browser + Desktop Task'
          : (orchRes && orchRes.route === 'browser' ? 'Browser Task' : 'Desktop Task');
        window.SW_UI.showCard({
          type: orchRes && orchRes.ok ? 'answer' : 'error',
          title: cardTitle,
          text: replyMsg,
          reqId: requestId
        });
      }
      if (inputSource === 'voice') {
        this._speakUnifiedReply(replyMsg, 'voice');
      }
      if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: orchRes ? orchRes.status : 'FAILED' });
      if (taskId) {
        const finalOutcome = orchRes && orchRes.ok
          ? 'COMPLETED'
          : (orchRes && orchRes.status === 'CANCELLED' ? 'CANCELLED' : 'ERROR');
        this._finishActiveTask(taskId, finalOutcome, orchRes && orchRes.ok ? (orchRes.understoodSummary || 'Completed') : (orchRes && orchRes.error && orchRes.error.message) || 'Failed');
      }
      return {
        ok: Boolean(orchRes && orchRes.ok),
        verified: Boolean(orchRes && orchRes.ok),
        status: orchRes && orchRes.ok ? 'completed' : (orchRes && orchRes.status === 'CANCELLED' ? 'task_cancelled' : 'failed'),
        commandId: cmdId,
        originalCommand: preservedOriginalCommand || raw,
        clarificationAnswer: clarificationAnswer || null,
        backend: orchRes ? orchRes.route : 'browser',
        engine: 'unified_orchestrator',
        executedEngine: primaryExecutedEngine,
        executedEngines,
        fallbackUsed,
        summaryModel: (orchRes && orchRes.sharedArtifacts && orchRes.sharedArtifacts.summaryModel) || null,
        usedLocalAiSummary: Boolean(orchRes && orchRes.sharedArtifacts && orchRes.sharedArtifacts.usedLocalAiSummary),
        message: replyMsg,
        orchestration: orchRes
      };
    }

    async _processUserInputBody(text, inputSource = 'voice', meta = {}) {
      const turnStart = performance.now();
      const taskId = (meta && meta._taskId) || 0;
      const taskSignal = (meta && meta._taskSignal) || null;
      const rawInput = String(text || '').trim();
      if (!rawInput) return null;
      const raw = (this.voice && typeof this.voice.stripWakePrefix === 'function')
        ? this.voice.stripWakePrefix(rawInput)
        : rawInput;
      if (!raw) return null;
      if (this._bootPromise) await this._bootPromise;
      if (!this._isTaskCurrent(taskId, taskSignal)) return { status: 'task_cancelled' };

      const cmdId = (meta && meta.cmdId) || `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const tracker = window.__SW_LIFECYCLE_TRACKER__;
      const initialBackend = this._getSelectedBackend();
      if (tracker) {
        tracker.startStage(cmdId, 'user_input', { text: raw, backend: initialBackend });
        tracker.finishStage(cmdId, 'user_input', { success: true, backend: initialBackend });
      }
      const currentTabId = (this.worldModel && typeof this.worldModel._getTabId === 'function' ? this.worldModel._getTabId() : null) || (this.memory && this.memory.tabId) || 'default';
      const currentInv = this.worldModel && typeof this.worldModel.getTabInventory === 'function' ? this.worldModel.getTabInventory(currentTabId) : null;
      const turn = this.agentFsm
        ? this.agentFsm.beginTurn({
            tabId: currentTabId,
            command: raw,
            inventoryVersion: currentInv ? currentInv.inventoryVersion : 0,
            url: window.location.href,
            requestId: (meta && meta.reqId) || ''
          })
        : null;
      const requestId = turn ? turn.requestId : ((meta && meta.reqId) || cmdId);
      const checkTurnValid = (opts = {}) => {
        if (!this._isTaskCurrent(taskId, taskSignal)) return { ok: false, reason: 'user_cancelled' };
        return !this.agentFsm || !requestId ? { ok: true } : this.agentFsm.assertTurnCurrent(requestId, opts);
      };
      if (this.agentFsm) this.agentFsm.transition('CLASSIFYING', { requestId, reason: 'command_received' });
      this._setStatusChip(`Understanding: "${raw}"`);
      this._setAuroraTaskUi('processing', 'Understanding request');

      // Unified request tracking across Orb UI, cards, and speech
      if (window.SW_UI && typeof window.SW_UI.beginRequest === 'function') {
        window.SW_UI.beginRequest(requestId, raw);
      }

      // 0. Phase 2: Emergency Stop Reset Command & Active Emergency Stop Gate
      if (/^(?:(?:please\s+)?(?:reset|clear)\s+emergency\s+stop|resume\s+assistant)$/i.test(raw) ||
          (this.emergencyStopActive && /^(?:resume|continue)$/i.test(raw))) {
        const rstRes = await this.resetEmergencyStop(inputSource);
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: rstRes.status });
        if (taskId) this._finishActiveTask(taskId, rstRes.ok ? 'COMPLETED' : 'ERROR', rstRes.ok ? 'Assistant resumed' : 'Reset blocked');
        return rstRes;
      }
      if (this.emergencyStopActive) {
        const lockedMsg = 'Emergency Stop is active. Click "Resume Assistant" or say "Reset emergency stop" before running new commands.';
        this.setAssistantReply(lockedMsg);
        if (window.SW_UI && typeof window.SW_UI.showCard === 'function') {
          window.SW_UI.showCard({
            type: 'error',
            title: 'Emergency Stop Active',
            text: lockedMsg,
            autoDismissMs: 0,
            actions: [{ id: 'resume_assistant', label: 'Resume Assistant', primary: true }],
            onAction: async (actId) => {
              if (actId === 'resume_assistant') await this.resetEmergencyStop('ui_card_resume');
            }
          });
        }
        if (inputSource === 'voice') this._speakUnifiedReply(lockedMsg, 'voice');
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'emergency_stop_active' });
        if (taskId) this._finishActiveTask(taskId, 'ERROR', 'Emergency Stop active');
        return { ok: false, verified: false, status: 'emergency_stop_active', message: lockedMsg };
      }

      // 1. Hide UI / UI visibility command without ending conversation
      if (/^(?:hide\s+(?:the\s+)?(?:ui|orb|assistant)|minimize)$/i.test(raw)) {
        this.dismissUi('hide_ui');
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'ui_hidden' });
        return { status: 'ui_hidden' };
      }

      // 1c. Conversational Greeting (Issue A: handle greetings directly without analyzing whole page DOM or showing stale content)
      if (/^(?:hello|hi|hey|good\s+(?:morning|afternoon|evening)|namaste|greetings)\b[!.?]*$/i.test(raw.trim())) {
        const greetingMsg = "Hello! I'm Sleepwalker. How can I help you on this page? You can ask me to read the page, click links, search, or fill forms.";
        this.setAssistantReply(greetingMsg);
        if (window.SW_UI) {
          window.SW_UI.setState('speaking');
          window.SW_UI.showCard({
            type: 'answer',
            title: 'Sleepwalker',
            text: greetingMsg,
            reqId: requestId,
            choices: ['Read this page', 'Explain this page', 'Search on this page']
          });
        }
        if (this.reader) this.reader.readText(greetingMsg);
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'greeting_handled' });
        this._finishActiveTask(taskId, 'COMPLETED', 'Greeting');
        return { status: 'greeting_handled', answer: greetingMsg, verified: true, engine: this.useRebuiltBrowserEngine ? 'rebuilt_browser_engine' : 'legacy' };
      }

      // 1c2. Voice-controlled Multilingual Language Switching
      const langSwitchMatch = raw.match(/^(?:(?:please\s+)?(?:change|switch|set)\s+(?:the\s+)?language\s+(?:to|in)\s+([a-zA-Z\u0900-\u0D7F\s]+))$/i) ||
                              raw.match(/^(?:(?:भाषा|लैंग्वेज|language)\s+(?:बदलकर|बदलो|change|switch)\s*(?:to\s*)?([a-zA-Z\u0900-\u0D7F\s]+))$/i);
      if (langSwitchMatch) {
        const langKey = langSwitchMatch[1].trim().toLowerCase().replace(/[.,!?;:]+$/, '');
        const map = (this.intentEngine && this.intentEngine.constructor && this.intentEngine.constructor.SUPPORTED_LANGUAGE_MAP) || {
          'english': 'en-IN', 'indian english': 'en-IN', 'american english': 'en-US', 'us english': 'en-US',
          'hindi': 'hi-IN', 'हिंदी': 'hi-IN', 'हिन्दी': 'hi-IN',
          'kannada': 'kn-IN', 'कन्नड़': 'kn-IN', 'ಕನ್ನಡ': 'kn-IN',
          'tamil': 'ta-IN', 'तमिल': 'ta-IN', 'தமிழ்': 'ta-IN',
          'telugu': 'te-IN', 'तेलुगु': 'te-IN', 'తెలుగు': 'te-IN',
          'malayalam': 'ml-IN', 'मलयालम': 'ml-IN', 'മലയാളം': 'ml-IN',
          'bengali': 'bn-IN', 'bangla': 'bn-IN', 'बंगाली': 'bn-IN', 'বাংলা': 'bn-IN',
          'marathi': 'mr-IN', 'मराठी': 'mr-IN',
          'french': 'fr-FR', 'français': 'fr-FR', 'फ्रेंच': 'fr-FR',
          'german': 'de-DE', 'deutsch': 'de-DE', 'जर्मन': 'de-DE',
          'japanese': 'ja-JP', 'nihongo': 'ja-JP', '日本語': 'ja-JP', 'जापानी': 'ja-JP',
          'spanish': 'es-ES', 'español': 'es-ES', 'स्पैनिश': 'es-ES'
        };
        const matchedLocale = map[langKey];
        if (matchedLocale) {
          return this.applyLanguageSwitch(matchedLocale, langKey, requestId, taskId);
        }
      }

      // 1c2b. Direct Screenshot Fast-Path (strictly screenshot phrases only — never intercept camera "take a picture" used by forms/camera.js)
      if (/^(?:please\s+)?(?:take\s+(?:a\s+)?screen\s*shot|capture\s+(?:a\s+)?(?:screen\s*shot|this\s+screen|the\s+screen|screen)|screen\s*shot(?:\s+(?:lo|le\s+lo|karo))?|स्क्रीनशॉट(?:\s+लो)?)\.?$/i.test(raw)) {
        const shotRes = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CAPTURE_SCREENSHOT' }, (resp) => {
              if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
              resolve(resp || { ok: false, error: 'No response from capture service.' });
            });
          } catch (err) {
            resolve({ ok: false, error: (err && err.message) || 'Screenshot unavailable.' });
          }
        });
        if (shotRes && shotRes.ok && shotRes.dataUrl) {
          const okMsg = 'Snapped a screenshot for you! Click Save PNG or Copy Image right below.';
          this.setAssistantReply(okMsg);
          if (window.SW_UI) {
            window.SW_UI.setState('completed');
            window.SW_UI.showCard({
              type: 'answer',
              title: 'Screenshot Captured',
              previewUrl: shotRes.dataUrl,
              text: okMsg,
              actions: [
                { id: 'save_png', label: 'Save PNG', primary: true },
                { id: 'copy_png', label: 'Copy Image' }
              ],
              onAction: async (actId) => {
                if (actId === 'save_png') {
                  const a = document.createElement('a');
                  a.href = shotRes.dataUrl;
                  a.download = shotRes.filename || 'sleepwalker-screenshot.png';
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  this.setAssistantReply('Saved your screenshot to Downloads!');
                  if (this.reader) this.reader.readText('Saved your screenshot to Downloads!');
                } else if (actId === 'copy_png') {
                  try {
                    const blob = await (await fetch(shotRes.dataUrl)).blob();
                    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                    this.setAssistantReply('Copied the screenshot to your clipboard!');
                    if (this.reader) this.reader.readText('Copied the screenshot to your clipboard!');
                  } catch (_e) {
                    this.setAssistantReply('Clipboard copy is blocked on this page — use Save PNG instead!');
                  }
                }
              }
            });
          }
          if (this.reader) this.reader.readText(okMsg);
          if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'screenshot_captured' });
          this._finishActiveTask(taskId, 'COMPLETED', okMsg);
          return { status: 'screenshot_captured', ok: true, verified: true, filename: shotRes.filename, answer: okMsg };
        }
        const failMsg = `I couldn't snap that screenshot right now (${(shotRes && shotRes.error) || 'permission needed'}). Try clicking the Sleepwalker toolbar icon once first!`;
        this.setAssistantReply(failMsg);
        if (this.reader) this.reader.readText(failMsg);
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'error' });
        this._finishActiveTask(taskId, 'ERROR', failMsg);
        return { status: 'error', ok: false, verified: false, answer: failMsg };
      }

      // 1c2c. Direct Smart Video Selection Fast-Path (Top-down ordinal 1st/2nd/3rd/next, title, or channel name)
      const videoCmdRe = /\b(?:video|videos|वीडियो|विडियो)\b/i;
      if (this.navigator && typeof this.navigator.selectYouTubeVideo === 'function' && videoCmdRe.test(raw) && !/\b(?:pause|resume|mute|unmute|fullscreen|captions?|subtitles?|speed|rewind|forward|skip|summarize|explain)\b/i.test(raw)) {
        const lowerV = raw.toLowerCase().trim();
        const ORD_WORDS = {
          first: 1, '1st': 1, one: 1, '1': 1, pehla: 1, pahla: 1, top: 1, 'पहला': 1,
          second: 2, '2nd': 2, two: 2, '2': 2, dusra: 2, doosra: 2, 'दूसरा': 2,
          third: 3, '3rd': 3, three: 3, '3': 3, teesra: 3, tisra: 3, 'तीसरा': 3,
          fourth: 4, '4th': 4, four: 4, '4': 4, chautha: 4, 'चौथा': 4,
          fifth: 5, '5th': 5, five: 5, '5': 5, paanchva: 5, 'पांचवा': 5,
          sixth: 6, '6th': 6, six: 6, '6': 6, seventh: 7, '7th': 7, seven: 7, '7': 7,
          eighth: 8, '8th': 8, eight: 8, '8': 8, ninth: 9, '9th': 9, nine: 9, '9': 9,
          tenth: 10, '10th': 10, ten: 10, '10': 10
        };
        let ordinal = null;
        let relativeStep = 0;
        let channel = '';
        let query = '';

        if (/\b(?:next|subsequent|following|agla|अगला)\s+(?:video|वीडियो)\b/i.test(lowerV)) {
          relativeStep = 1;
        } else if (/\b(?:previous|prev|last|pichla|पिछला)\s+(?:video|वीडियो)\b/i.test(lowerV)) {
          relativeStep = -1;
        } else {
          const ordM = lowerV.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|\d{1,2}(?:st|nd|rd|th)?|pehla|pahla|dusra|doosra|teesra|tisra|chautha|paanchva|top|पहला|दूसरा|तीसरा|चौथा|पांचवा)\b/i)
            || lowerV.match(/\bvideo\s*(?:number|no\.?|#)?\s*(\d{1,2})\b/i);
          if (ordM && ordM[1]) {
            const key = ordM[1].toLowerCase().replace(/(?:st|nd|rd|th)$/i, '');
            ordinal = ORD_WORDS[ordM[1].toLowerCase()] || (Number.isInteger(Number(key)) && Number(key) >= 1 ? Number(key) : null);
          }
        }

        const chanM = raw.match(/\b(?:by|from|of|channel)\s+(.+?)(?:\s+video|\s+videos|$)/i)
          || raw.match(/^(?:open|play|select|watch|pick|show)?\s*(.+?)(?:'s|\s+ka|\s+ki)\s+(?:video|वीडियो)/i);
        if (chanM && chanM[1] && !ordinal && !relativeStep) {
          channel = chanM[1].trim();
        }
        if (!ordinal && !relativeStep) {
          query = raw
            .replace(/^(?:please\s+)?(?:open|play|watch|select|choose|pick|find|click|show)\s+(?:the\s+|a\s+)?/i, '')
            .replace(/\b(?:video|videos|वीडियो|विडियो|kholo|chalao|dikhao|खोलो|चलाओ)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }

        const vidRes = await this.navigator.selectYouTubeVideo({ ordinal, relativeStep, channel, query });
        if (vidRes && vidRes.status === 'selected_video') {
          this.setAssistantReply(vidRes.message);
          if (this.reader) this.reader.readText(vidRes.message);
          if (window.SW_UI) {
            window.SW_UI.setState('completed');
            window.SW_UI.showCard({ type: 'answer', title: 'Opening Video', text: vidRes.message });
          }
          if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'selected_video' });
          this._finishActiveTask(taskId, 'COMPLETED', vidRes.message);
          return { ...vidRes, ok: true, verified: true };
        }
        if (vidRes && vidRes.status === 'ambiguous' && Array.isArray(vidRes.videos) && vidRes.videos.length > 0) {
          const choices = vidRes.videos.map((v) => `${v.title}${v.channel ? ` — ${v.channel}` : ''}`);
          this.setAssistantReply(vidRes.reason);
          if (this.reader) this.reader.readText(vidRes.reason);
          if (window.SW_UI) {
            window.SW_UI.setState('speaking');
            window.SW_UI.showCard({
              type: 'choices',
              title: 'Pick a Video',
              text: vidRes.reason,
              choices,
              onAction: async (actId, d) => {
                if (actId === 'choose' && d && typeof d.index === 'number') {
                  await this.navigator.selectYouTubeVideo({ ordinal: d.index + 1 });
                }
              }
            });
          }
          if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'ambiguous_video' });
          this._finishActiveTask(taskId, 'COMPLETED', vidRes.reason);
          return { ...vidRes, ok: true };
        }
      }

      // 1c3. Stage 4 / P0 Unified Orchestrator Routing for Browser, Desktop & Cross-Backend Workflows
      const isTeachOrSkillCmd = Boolean(
        this.teach && (
          this.teach.active ||
          /^(?:teach|remember|learn|sikho|सीखो|नया\s+काम\s+सीखो|what\s+have\s+you\s+learned|show\s+(?:my\s+)?learned\s+(?:skills|workflows)|my\s+(?:learned\s+)?(?:skills|workflows)|list\s+(?:learned\s+)?(?:skills|workflows)|सीखे\s+हुए\s+काम)/i.test(raw)
        )
      );
      const isCompoundMultiStepCmd = Boolean(
        !meta?.isCompoundSubstep &&
        this.voice && typeof this.voice.parseCompoundSteps === 'function' &&
        this.voice.parseCompoundSteps(raw).length >= 2
      );
      const unifiedContextHint = {
        browser: {
          url: typeof window !== 'undefined' ? window.location.href : '',
          title: typeof document !== 'undefined' ? (document.title || '') : ''
        }
      };
      const shouldUseUnified = Boolean(
        !isTeachOrSkillCmd &&
        !isCompoundMultiStepCmd &&
        this.unifiedOrchestrator && (
          (typeof this.unifiedOrchestrator.shouldHandleCommand === 'function' &&
            this.unifiedOrchestrator.shouldHandleCommand(raw, unifiedContextHint)) ||
          (typeof this.unifiedOrchestrator.shouldHandleCommand !== 'function' &&
            typeof this.unifiedOrchestrator.isDesktopOrCrossBackendIntent === 'function' &&
            this.unifiedOrchestrator.isDesktopOrCrossBackendIntent(raw))
        )
      );
      if (shouldUseUnified) {
        return this._executeUnifiedOrchestratedTurn(raw, inputSource, {
          cmdId,
          taskId,
          requestId,
          tracker,
          unifiedContextHint
        });
      }

      // 1d. Direct URL Navigation, Common External Sites & Web Search
      const COMMON_EXTERNAL_SITES = {
        'github': 'https://github.com',
        'wikipedia': 'https://www.wikipedia.org',
        'youtube': 'https://www.youtube.com',
        'google': 'https://www.google.com',
        'reddit': 'https://www.reddit.com',
        'twitter': 'https://twitter.com',
        'x': 'https://x.com',
        'linkedin': 'https://www.linkedin.com',
        'amazon': 'https://www.amazon.com',
        'facebook': 'https://facebook.com',
        'instagram': 'https://instagram.com',
        'stackoverflow': 'https://stackoverflow.com',
        'stack overflow': 'https://stackoverflow.com',
        'netflix': 'https://netflix.com',
        'gmail': 'https://mail.google.com'
      };

      const siteNavMatch = raw.match(/^(?:(?:please\s+)?(?:go\s+to|visit|open|navigate\s+to)\s+)([a-zA-Z0-9\s]+)$/i);
      if (siteNavMatch) {
        const siteKey = siteNavMatch[1].trim().toLowerCase();
        if (COMMON_EXTERNAL_SITES[siteKey]) {
          const destUrl = COMMON_EXTERNAL_SITES[siteKey];
          if (tracker) {
            tracker.startStage(cmdId, 'intent_classification', { backend: initialBackend });
            tracker.finishStage(cmdId, 'intent_classification', { success: true, backend: initialBackend });
            tracker.startStage(cmdId, 'action_execution', { backend: initialBackend });
          }
          const navRes = await this._navigateToExternalUrl(destUrl, siteKey, raw, { cmdId, taskId, taskSignal });
          const navOk = this._isCommandTruthfullySuccessful(navRes);
          if (tracker) {
            tracker.finishStage(cmdId, 'action_execution', { success: navOk, backend: (navRes && navRes.engine) || initialBackend, errorDetails: navOk ? null : (navRes && navRes.error) || 'navigation_failed' });
            tracker.startStage(cmdId, 'verification', { backend: (navRes && navRes.engine) || initialBackend });
            tracker.finishStage(cmdId, 'verification', { success: Boolean(navRes && (navRes.verified || navOk)), backend: (navRes && navRes.engine) || initialBackend });
            tracker.recordTerminalState(cmdId, navOk ? 'completed' : 'failed', { backend: (navRes && navRes.engine) || initialBackend });
          }
          if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: (navRes && navRes.status) || 'navigating_external' });
          if (taskId) this._finishActiveTask(taskId, navOk ? 'COMPLETED' : 'ERROR', navOk ? `Navigated to ${siteKey}` : 'Navigation failed');
          return { ...(navRes || {}), cmdId, intent: 'NAVIGATE', engine: (navRes && navRes.engine) || initialBackend };
        }
      }

      const siteSearchMatch = raw.match(/^(?:(?:please\s+)?search\s+(wikipedia|youtube|github|google)\s+(?:for\s+)?(.+))$/i);
      if (siteSearchMatch) {
        const site = siteSearchMatch[1].trim().toLowerCase();
        const query = siteSearchMatch[2].trim();
        const currentHost = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
        const siteUrls = {
          wikipedia: !currentHost.includes('wikipedia.org') ? { url: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`, label: `Wikipedia: ${query}` } : null,
          youtube: !currentHost.includes('youtube.com') ? { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, label: `YouTube: ${query}` } : null,
          github: !currentHost.includes('github.com') ? { url: `https://github.com/search?q=${encodeURIComponent(query)}`, label: `GitHub: ${query}` } : null
        };
        const chosenSite = siteUrls[site] || null;
        if (chosenSite) {
          if (tracker) {
            tracker.startStage(cmdId, 'intent_classification', { backend: initialBackend });
            tracker.finishStage(cmdId, 'intent_classification', { success: true, backend: initialBackend });
            tracker.startStage(cmdId, 'action_execution', { backend: initialBackend });
          }
          const navRes = await this._navigateToExternalUrl(chosenSite.url, chosenSite.label, raw, { cmdId, taskId, taskSignal });
          const navOk = this._isCommandTruthfullySuccessful(navRes);
          if (tracker) {
            tracker.finishStage(cmdId, 'action_execution', { success: navOk, backend: (navRes && navRes.engine) || initialBackend, errorDetails: navOk ? null : (navRes && navRes.error) || 'navigation_failed' });
            tracker.startStage(cmdId, 'verification', { backend: (navRes && navRes.engine) || initialBackend });
            tracker.finishStage(cmdId, 'verification', { success: Boolean(navRes && (navRes.verified || navOk)), backend: (navRes && navRes.engine) || initialBackend });
            tracker.recordTerminalState(cmdId, navOk ? 'completed' : 'failed', { backend: (navRes && navRes.engine) || initialBackend });
          }
          if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: (navRes && navRes.status) || 'navigating_external_search' });
          if (taskId) this._finishActiveTask(taskId, navOk ? 'COMPLETED' : 'ERROR', navOk ? `Searching ${chosenSite.label}` : 'Search navigation failed');
          return { ...(navRes || {}), cmdId, intent: 'SEARCH', query, engine: (navRes && navRes.engine) || initialBackend };
        }
      }

      const directUrlMatch = raw.match(/^(?:(?:please\s+)?(?:go\s+to|visit|open|navigate\s+to)\s+)?(https?:\/\/[^\s]+)$/i) ||
                             raw.match(/^(?:(?:please\s+)?(?:go\s+to|visit|open|navigate\s+to)\s+)([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)$/i);
      if (directUrlMatch) {
        let destUrl = directUrlMatch[1].trim();
        if (!/^https?:\/\//i.test(destUrl)) {
          destUrl = 'https://' + destUrl;
        }
        if (tracker) {
          tracker.startStage(cmdId, 'intent_classification', { backend: initialBackend });
          tracker.finishStage(cmdId, 'intent_classification', { success: true, backend: initialBackend });
          tracker.startStage(cmdId, 'action_execution', { backend: initialBackend });
        }
        const navRes = await this._navigateToExternalUrl(destUrl, destUrl, destUrl, { cmdId, taskId, taskSignal });
        const navOk = this._isCommandTruthfullySuccessful(navRes);
        if (tracker) {
          tracker.finishStage(cmdId, 'action_execution', { success: navOk, backend: (navRes && navRes.engine) || initialBackend, errorDetails: navOk ? null : (navRes && navRes.error) || 'navigation_failed' });
          tracker.startStage(cmdId, 'verification', { backend: (navRes && navRes.engine) || initialBackend });
          tracker.finishStage(cmdId, 'verification', { success: Boolean(navRes && (navRes.verified || navOk)), backend: (navRes && navRes.engine) || initialBackend });
          tracker.recordTerminalState(cmdId, navOk ? 'completed' : 'failed', { backend: (navRes && navRes.engine) || initialBackend });
        }
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: (navRes && navRes.status) || 'navigating_url' });
        if (taskId) this._finishActiveTask(taskId, navOk ? 'COMPLETED' : 'ERROR', navOk ? `Navigated to ${destUrl}` : 'Navigation failed');
        return { ...(navRes || {}), cmdId, intent: 'NAVIGATE', engine: (navRes && navRes.engine) || initialBackend };
      }

      // 1d2. Explicit visible page extraction routed cleanly through Stagehand adapter when enabled
      if (this.useStagehandAdapter && this.stagehandAdapter && /^(?:please\s+)?extract\s+(?:visible\s+)?(?:page\s+)?(?:info|information|content|text|headings|links)\b/i.test(raw)) {
        if (tracker) {
          tracker.startStage(cmdId, 'intent_classification', { backend: initialBackend });
          tracker.finishStage(cmdId, 'intent_classification', { success: true, backend: initialBackend });
          tracker.startStage(cmdId, 'action_execution', { backend: initialBackend });
        }
        const extRes = await this._extractVisiblePageInfoWithStagehand(raw, { cmdId, taskId, taskSignal, useLlm: false });
        const extOk = this._isCommandTruthfullySuccessful(extRes);
        if (tracker) {
          tracker.finishStage(cmdId, 'action_execution', { success: extOk, backend: 'stagehand_adapter', errorDetails: extOk ? null : (extRes && extRes.error) || 'extract_failed' });
          tracker.startStage(cmdId, 'verification', { backend: 'stagehand_adapter' });
          tracker.finishStage(cmdId, 'verification', { success: Boolean(extRes && extRes.verified), backend: 'stagehand_adapter' });
          tracker.recordTerminalState(cmdId, extOk ? 'completed' : 'failed', { backend: 'stagehand_adapter' });
        }
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: (extRes && extRes.status) || 'extracted' });
        if (taskId) this._finishActiveTask(taskId, extOk ? 'COMPLETED' : 'ERROR', extOk ? 'Extracted page info' : 'Extraction failed');
        return { ...(extRes || {}), cmdId, intent: 'EXTRACT' };
      }

      const googleSearchMatch = raw.match(/^(?:(?:please\s+)?(?:search\s+(?:on\s+|using\s+)?google(?:\s+for)?|google)\s+(.+))$/i) ||
                                raw.match(/^(?:(?:please\s+)?search\s+(?:the\s+web|online|internet)\s+(?:for\s+)?(.+))$/i);
      if (googleSearchMatch) {
        const query = googleSearchMatch[1].trim();
        const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'navigating_google' });
        return this._navigateToExternalUrl(googleUrl, `Google Search: ${query}`, query);
      }

      // 1e. Rebuilt BrowserEngine Unified Hierarchical Menu Navigation (Phases 9.1 & 10.1)
      if (this.useRebuiltBrowserEngine && this.browserEngine && typeof this.browserEngine.normalizeMenuPath === 'function') {
        const normMenu = this.browserEngine.normalizeMenuPath(raw);
        if (Array.isArray(normMenu) && normMenu.length >= 2) {
          this._setAuroraTaskUi('processing', `Opening menu: ${normMenu.join(' > ')}`);
          const beT0 = performance.now();
          const menuRes = await this.browserEngine.openMenuPath(normMenu);
          const beMs = performance.now() - beT0;
          if (menuRes && menuRes.status === 'CONFIRMATION_REQUIRED') {
            this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: menuRes.reason, latencyMs: beMs });
            return { status: 'confirming', awaiting: true, verified: false, engine: 'rebuilt_browser_engine', target: normMenu[normMenu.length - 1], reason: menuRes.reason };
          }
          if (menuRes && (menuRes.status === 'SUCCESS' || menuRes.verified)) {
            this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: beMs });
            const succMsg = `Opened ${normMenu[normMenu.length - 1]} under ${normMenu.slice(0, -1).join(' > ')}.`;
            this.setAssistantReply(succMsg);
            if (window.SW_UI) {
              window.SW_UI.showCard({ type: 'answer', title: 'Menu Navigation', text: succMsg, reqId: requestId });
            }
            if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'opened' });
            this._finishActiveTask(taskId, 'COMPLETED', succMsg);
            return { status: 'opened', verified: true, engine: 'rebuilt_browser_engine', target: normMenu[normMenu.length - 1], menuPath: normMenu };
          }
          if (menuRes && menuRes.status === 'AMBIGUOUS') {
            this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: 'ambiguous_candidates', latencyMs: beMs });
            const choices = (menuRes.candidates || []).map(c => c.label || c.text || String(c));
            const clarifyMsg = menuRes.message || `Found multiple options matching "${normMenu[normMenu.length - 1]}". Which one did you mean?`;
            this.setAssistantReply(clarifyMsg);
            if (window.SW_UI) {
              window.SW_UI.setState('confirm');
              window.SW_UI.showCard({ type: 'choices', title: 'Clarify Menu Choice', text: clarifyMsg, choices, reqId: requestId });
            }
            this._enterWaitingForClarification(taskId, clarifyMsg, async (ansText) => {
              return this.browserEngine.openMenuPath(normMenu.slice(0, -1).concat([ansText]));
            });
            return { status: 'needs_clarification', choices, engine: 'rebuilt_browser_engine' };
          }
          // Honest failure: do NOT fall back to typing the menu query into website search or Google
          this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (menuRes && menuRes.reason) || 'menu_not_found', latencyMs: beMs });
          const failMsg = `Could not find "${normMenu[normMenu.length - 1]}" under "${normMenu.slice(0, -1).join(' > ')}".`;
          this.setAssistantReply(failMsg);
          if (window.SW_UI) {
            window.SW_UI.showCard({ type: 'error', title: 'Navigation Failed', text: failMsg, reqId: requestId });
          }
          if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'not_found' });
          this._finishActiveTask(taskId, 'ERROR', failMsg);
          return { status: 'not_found', ok: false, verified: false, engine: 'rebuilt_browser_engine', reason: (menuRes && menuRes.reason) || 'menu_path_failed' };
        }
      }

      // 1b. Teaching mode lifecycle commands (start, pause, resume, finish, cancel)
      if (this.teach) {
        const lowerTeach = raw.toLowerCase().trim();
        if (this.teach.active) {
          if (/^(?:finish|done|complete|end|stop|save)\s+(?:the\s+)?(?:teaching|recording|demonstration|workflow|skill)\.?$/i.test(lowerTeach) || /^(?:save\s+(?:this\s+)?(?:workflow|skill)|finish\s+teaching)\.?$/i.test(lowerTeach)) {
            const tRes = await this.teach.finishTeaching();
            if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: tRes.status });
            if (tRes && tRes.status !== 'awaiting_skill_confirmation') {
              this._finishActiveTask(taskId, 'COMPLETED', tRes.answer || 'Teaching finished');
            }
            return tRes;
          }
          if (/^pause\s+(?:the\s+)?(?:teaching|recording|demonstration)\.?$/i.test(lowerTeach)) {
            const tRes = await this.teach.pauseTeaching();
            this.setAssistantReply(`Teaching paused (${tRes.steps || 0} step(s) captured). Say "Resume teaching" to continue.`);
            if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: tRes.status });
            this._finishActiveTask(taskId, 'COMPLETED', 'Teaching paused');
            return tRes;
          }
          if (/^(?:resume|continue)\s+(?:the\s+)?(?:teaching|recording|demonstration)\.?$/i.test(lowerTeach)) {
            const tRes = await this.teach.resumeTeaching();
            this.setAssistantReply(`Teaching resumed (${tRes.steps || 0} step(s) so far).`);
            if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: tRes.status });
            this._finishActiveTask(taskId, 'COMPLETED', 'Teaching resumed');
            return tRes;
          }
          if (/^(?:cancel|discard|abort)\s+(?:the\s+)?(?:teaching|recording|demonstration)\.?$/i.test(lowerTeach)) {
            const tRes = await this.teach.cancelTeaching();
            this.setAssistantReply('Teaching cancelled.');
            if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: tRes.status });
            this._finishActiveTask(taskId, 'CANCELLED', 'Teaching cancelled');
            return tRes;
          }
        } else {
          // Declarative multi-step voice recipe: "teach: when I say <name>, <step 1> then <step 2>"
          const recipeM = raw.match(/^(?:teach|remember|learn)\s*[:,-]?\s*(?:when\s+i\s+say\s+|that\s+)?["'“]?(.+?)["'”]?\s*(?:,|means|does|should|=|:)\s*(.+)$/i);
          if (recipeM && recipeM[1] && recipeM[2] && typeof this.teach.teachVoiceRecipe === 'function') {
            const tRes = await this.teach.teachVoiceRecipe(recipeM[1].trim(), recipeM[2].trim());
            if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: tRes.status });
            this._finishActiveTask(taskId, tRes.verified ? 'COMPLETED' : 'ERROR', tRes.answer || 'Recipe processed');
            return tRes;
          }
          // List learned skills: "what have you learned" / "show learned skills" / "my skills"
          if (/^(?:what\s+have\s+you\s+learned|show\s+(?:my\s+)?learned\s+(?:skills|workflows)|my\s+(?:learned\s+)?(?:skills|workflows)|list\s+(?:learned\s+)?(?:skills|workflows)|सीखे\s+हुए\s+काम(?:\s+दिखाओ)?)$/i.test(lowerTeach)) {
            const lRes = typeof this.teach.listLearnedSkills === 'function' ? this.teach.listLearnedSkills() : { status: 'no_skills' };
            if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: lRes.status });
            this._finishActiveTask(taskId, 'COMPLETED', lRes.answer || 'Skills listed');
            return lRes;
          }
          const explicitTeachM = raw.match(/^(?:teach\s+(?:sleepwalker|you|me)(?:\s+how\s+to)?|let\s+me\s+teach\s+(?:sleepwalker|you)(?:\s+how\s+to)?|record\s+(?:a\s+)?(?:workflow|skill)(?:\s+for)?|sikho|सीखो|नया\s+काम\s+सीखो)\s+(.+)$/i);
          if (explicitTeachM && explicitTeachM[1]) {
            const goalText = explicitTeachM[1].trim();
            const tRes = await this.teach.startTeaching(goalText, { mode: 'teach' });
            this.setAssistantReply(tRes.message || `Teaching mode started for "${goalText}".`);
            if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: tRes.status });
            this._finishActiveTask(taskId, 'COMPLETED', 'Teaching started');
            return tRes;
          }
        }
      }

      // 1c. Compound multi-step command execution ("open Services then click Passport Offices")
      if (!meta?.isCompoundSubstep && this.voice && typeof this.voice.parseCompoundSteps === 'function') {
        const compoundSteps = this.voice.parseCompoundSteps(raw);
        if (compoundSteps.length >= 2) {
          const stepOutcomes = [];
          for (let si = 0; si < compoundSteps.length; si++) {
            const subCmd = compoundSteps[si];
            if (window.SW_UI && typeof window.SW_UI.setTaskStatus === 'function') {
              window.SW_UI.setTaskStatus({
                state: 'executing',
                stage: `Step ${si + 1}/${compoundSteps.length}`,
                taskLabel: subCmd
              });
            }
            const subRes = await this._processUserInputInner(subCmd, inputSource, { ...meta, isCompoundSubstep: true });
            stepOutcomes.push({ step: subCmd, status: (subRes && subRes.status) || 'done' });
            if (si < compoundSteps.length - 1) {
              await new Promise((r) => setTimeout(r, 380));
            }
          }
          const summaryMsg = `Completed ${compoundSteps.length} steps: ${compoundSteps.join(' → ')}.`;
          this.setAssistantReply(summaryMsg);
          if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'completed' });
          this._finishActiveTask(taskId, 'COMPLETED', summaryMsg);
          return { status: 'completed', ok: true, verified: true, steps: stepOutcomes, answer: summaryMsg };
        }
      }

      // 2. Priority interruption / Stop Action / Escape before blocking modals
      const hasPendingChoice = Boolean((this.dialogue && this.dialogue.pendingPrompt) || (this.navigator && Array.isArray(this.navigator.pendingChoices) && this.navigator.pendingChoices.length));
      const hasPageTabMatch = Boolean(
        document && typeof document.querySelectorAll === 'function' &&
        document.querySelectorAll('[role="tab"], .tab, .nav-tab, [data-tab]').length > 0
      );
      const quickRoute = this.fastRouter ? this.fastRouter.classify(raw, {
        hasPendingPrompt: Boolean(this.confirm && this.confirm.isAwaiting()),
        navChoiceCount: (this.navigator && Array.isArray(this.navigator.pendingChoices) && this.navigator.pendingChoices.length) || 0,
        hasPageTabMatch
      }) : null;
      if (quickRoute && quickRoute.path === 'A' && quickRoute.fastAction && ['press_escape', 'stop_scroll', 'stop_action'].includes(quickRoute.fastAction.type)) {
        const fastEarlyRes = await this._executeFastPathAction(quickRoute.fastAction, raw, requestId, turnStart);
        return fastEarlyRes;
      }

      // 3. Dialogue-level commands (rest, end, meta-commands, yes/no/choice pending prompts)
      if (this.dialogue) {
        const d = await this.dialogue.handleUtterance(raw, inputSource, meta);
        if (d && d.handled) {
          if (this.memory && !(meta && meta.sensitive)) {
            await this.memory.recordActivity({
              user_command: raw,
              intent: 'CONVERSATION_CONTROL',
              action: (d.result && d.result.status) || 'dialogue_handled',
              result: this.dialogue.lastSpokenText || ''
            });
          }
          if (this.diagnostics) {
            this.diagnostics.recordTurnTrace({
              cmdId,
              intent: 'CONVERSATION_CONTROL',
              centralCategory: 'CONVERSATION_CONTROL',
              totalMs: Math.round(performance.now() - turnStart),
              usedLlm: false,
              status: (d.result && d.result.status) || 'handled'
            });
          }
          if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: (d.result && d.result.status) || 'handled' });
          return d.result;
        }
      }

      if (this.camera && this.camera.isActive() && this.camera.handleVoiceCommand(raw)) {
        if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'camera_handled' });
        return { status: 'camera_handled' };
      }
      if (this.confirm && this.confirm.isAwaiting()) {
        const res = this.confirm.handleResponse({ raw });
        if (res.handled) {
          if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'confirm_handled' });
          return { ...(res.result || {}), verified: Boolean(res.result && res.result.status === 'confirmed') };
        }
      }
      if (this.forms && this.forms.isDictatingLongText && this.forms.isDictatingLongText()) { this.forms.handleLongDictationInput(raw); if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'long_dictation' }); return { status: 'long_dictation' }; }
      if (this.forms && this.forms.isGuidedActive() && this.forms.guidedState.awaitingValue) { this.forms.handleGuidedInput(raw); if (this.agentFsm) this.agentFsm.finishTurn(requestId, 'IDLE', { status: 'guided_field' }); return { status: 'guided_field' }; }

      // 3b. Path A — Fast Deterministic Command Path (< 50ms, ZERO LLM calls!)
      if (!hasPendingChoice && quickRoute && quickRoute.path === 'A' && quickRoute.fastAction && quickRoute.fastAction.type !== 'legacy_control' && quickRoute.fastAction.type !== 'noop') {
        const fastRes = await this._executeFastPathAction(quickRoute.fastAction, raw, requestId, turnStart);
        if (fastRes) return fastRes;
      }

      // 3. Resolve contextual references ("there", "that trip", "the second one", "its official website", "Continue where we left off")
      const tCoref0 = performance.now();
      const resolvedContext = this.memory
        ? this.memory.resolveContextualReferences(raw, { title: document.title, url: window.location.href })
        : { originalText: raw, resolvedText: raw, resolvedTopic: '', resolvedEntity: '', isFollowUp: false, isResumeCommand: false };
      const corefMs = Math.round((performance.now() - tCoref0) * 100) / 100;

      // Ambiguity gate: ask ONE short clarifying question instead of guessing when context is genuinely ambiguous
      if (resolvedContext && resolvedContext.isAmbiguous && Array.isArray(resolvedContext.clarificationOptions) && resolvedContext.clarificationOptions.length >= 2) {
        const q = resolvedContext.clarificationQuestion || 'Which option did you mean?';
        const numbered = resolvedContext.clarificationOptions.map((opt, idx) => `${idx + 1}. ${opt}`).join(' ');
        const msg = `${q} ${numbered}`;
        const items = (this.memory && this.memory.state.currentEntities && this.memory.state.currentEntities.listItems) || [];
        if (this.dialogue) {
          this.dialogue.setPendingPrompt({
            kind: 'choice',
            label: 'ambiguous_entity_clarification',
            askedText: msg,
            options: resolvedContext.clarificationOptions,
            onAnswer: async (_pickedOpt, info) => {
              const pickedIdx = info && typeof info.index === 'number' ? info.index : 0;
              const pickedItem = items[pickedIdx];
              if (pickedItem && this.memory) {
                this.memory.state.currentEntities.lastPickedIndex = pickedIdx;
                this.memory.state.currentEntities.focusedEntity = pickedItem.title;
                await this.memory.saveState();
                if (pickedItem.officialUrl || pickedItem.url) {
                  return this._navigateToExternalUrl(pickedItem.officialUrl || pickedItem.url, pickedItem.title, pickedItem.title);
                }
              }
              return { status: 'clarified', option: _pickedOpt };
            }
          });
        }
        this._enterWaitingForClarification(taskId, msg, async (answerText, info) => {
          return this._processUserInputInner(answerText, (info && info.inputSource) || inputSource, {
            ...((info && info.meta) || meta),
            internalResumeTaskId: taskId
          });
        });
        this.setAssistantReply(msg);
        if (window.SW_UI) {
          window.SW_UI.setState('confirm');
          window.SW_UI.showCard({
            type: 'choices',
            title: 'Clarify Reference',
            text: q,
            choices: resolvedContext.clarificationOptions,
            onAction: async (_id, d) => {
              const idx = d && typeof d.index === 'number' ? d.index : 0;
              if (this.dialogue) this.dialogue.pendingPrompt = null;
              const pickedItem = items[idx];
              if (pickedItem && this.memory) {
                this.memory.state.currentEntities.lastPickedIndex = idx;
                this.memory.state.currentEntities.focusedEntity = pickedItem.title;
                await this.memory.saveState();
                if (pickedItem.officialUrl || pickedItem.url) {
                  this._navigateToExternalUrl(pickedItem.officialUrl || pickedItem.url, pickedItem.title, pickedItem.title);
                }
              }
            }
          });
        }
        if (this.reader) this.reader.readText(msg);
        return { status: 'needs_clarification', resolvedContext, clarificationOptions: resolvedContext.clarificationOptions };
      }

      const queryForClassification = resolvedContext.resolvedText || raw;
      const activeEl = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      const sensitiveFocused = Boolean(this.forms && ((activeEl && this.forms.isSensitiveField(activeEl)) || (this.forms.lastFocusedField && this.forms.isSensitiveField(this.forms.lastFocusedField))));
      const navChoiceCount = (this.navigator && Array.isArray(this.navigator.pendingChoices) && this.navigator.pendingChoices.length) || 0;

      const pageDigest = this.explainer && typeof this.explainer.getPageDigest === 'function'
        ? this.explainer.getPageDigest()
        : null;
      const intentOpts = {
        cmdId,
        logSearchTrace: true,
        lang: this.lang,
        sensitiveActive: sensitiveFocused,
        hasPendingNavChoice: navChoiceCount > 0,
        hasNumberedChoices: navChoiceCount > 0,
        maxChoices: navChoiceCount || 5,
        candidates: (navChoiceCount === 0 && this.navigator && this.navigator.getClickableCatalog()) || []
      };

      if (this.agentFsm) {
        this.agentFsm.recordStageTiming(requestId, 'routing', Math.round((performance.now() - turnStart) * 100) / 100);
        this.agentFsm.transition('OBSERVING', { requestId, reason: 'observe_page' });
      }
      if (tracker) tracker.startStage(cmdId, 'page_observation', { backend: initialBackend });
      this._setAuroraTaskUi('processing', 'Gathering context');
      const tIntent0 = performance.now();
      const tWm0 = performance.now();
      let wmInv = null;
      try {
        wmInv = this.worldModel ? await Promise.race([
          this.worldModel.observeTab(document),
          new Promise((r) => setTimeout(() => r(null), 1500))
        ]).catch(() => null) : null;
      } catch (_obsErr) {
        wmInv = null;
      }
      const wmBuildMs = Math.round((performance.now() - tWm0) * 100) / 100;
      if (this.agentFsm) {
        this.agentFsm.recordStageTiming(requestId, 'observation', wmBuildMs);
        if (wmInv && wmInv.inventoryVersion) this.agentFsm.updateInventoryVersion(requestId, wmInv.inventoryVersion);
      }
      if (tracker) tracker.finishStage(cmdId, 'page_observation', { success: Boolean(wmInv), errorDetails: wmInv ? null : 'observation_fallback', backend: initialBackend });

      // Immediate transition away from 'Gathering context' - never display Gathering context once observation completes!
      this._setAuroraTaskUi('processing', 'Understanding request');

      const postObserveValid = checkTurnValid({ tabId: currentTabId });
      if (!postObserveValid.ok) {
        if (tracker) tracker.recordTerminalState(cmdId, 'cancelled', { reason: postObserveValid.reason, backend: initialBackend });
        return { status: postObserveValid.reason === 'user_cancelled' ? 'task_cancelled' : 'aborted_stale_turn', reason: postObserveValid.reason };
      }

      if (tracker) tracker.startStage(cmdId, 'context_gathering', { backend: initialBackend });
      let structuredCtx = null;
      try {
        structuredCtx = this._syncStructuredPageContext(document);
      } catch (_e) {
        structuredCtx = null;
      }
      if (tracker) tracker.finishStage(cmdId, 'context_gathering', { success: Boolean(structuredCtx), backend: initialBackend });

      if (tracker) tracker.startStage(cmdId, 'intent_classification', { backend: initialBackend });
      const syncRule = (this.intentEngine && typeof this.intentEngine.matchRules === 'function')
        ? this.intentEngine.matchRules(queryForClassification, intentOpts)
        : null;
      const preCentral = (this.memory && typeof this.memory.classifyCentralIntent === 'function')
        ? this.memory.classifyCentralIntent(raw, resolvedContext, syncRule, pageDigest)
        : null;

      // Phase 4.3 + 4.4 + Master 2.0: Learned Skills + Hybrid World Model + Qwen -> Ollama Escalation
      let nluPlan = null;
      let nluCandidateNavigationIdentity = wmInv && wmInv.navigationIdentity;
      let nluSource = '';
      let semanticMatches = [];
      let semRetrieveMs = 0;
      let nluReasoningMs = 0;
      let nluDiag = null;
      let nluOllamaStatus = 'skipped';
      let nluHttpStatus = 0;
      let nluErrorDetail = '';
      let ollamaReply = null;
      let learnedSkillHits = [];
      let failedLearnedSkill = null;
      let earlySkillDispatch = null;
      const isControlOrReadOnlyCmd = Boolean(
        (preCentral && this.memory && [
          this.memory.CENTRAL_INTENTS.CONVERSATION_CONTROL,
          this.memory.CENTRAL_INTENTS.PAGE_READING
        ].includes(preCentral.category)) ||
        /^(?:summarize|summary|explain|read\s+(?:this|the)\s+page|what\s+is|who\s+is|hello|hi|hey)\b/i.test(raw.trim())
      );

      if (
        this.memory &&
        typeof this.memory.retrieveLearnedSkillsAsync === 'function' &&
        !isControlOrReadOnlyCmd &&
        (!meta || meta.skipLearnedSkills !== true)
      ) {
        learnedSkillHits = await Promise.race([
          this.memory.retrieveLearnedSkillsAsync(raw, window.location.href, {
            topK: 3,
            minScore: 0.44
          }),
          new Promise((r) => setTimeout(() => r([]), 800))
        ]).catch(() => []);
        if (this.teach && learnedSkillHits.length > 0 && learnedSkillHits[0].score >= 0.70) {
          const topSkill = learnedSkillHits[0].skill;
          if (this.agentFsm) this.agentFsm.transition('EXECUTING', { requestId, reason: 'learned_skill_replay' });
          this._setAuroraTaskUi('processing', `Running learned skill: ${topSkill.name}`);
          const skRes = await this.teach.executeLearnedSkill(topSkill, { utterance: raw }).catch((err) => ({
            status: 'skill_step_failed',
            verified: false,
            skill: topSkill,
            message: (err && err.message) || 'Learned skill execution failed.'
          }));
          if (skRes && (skRes.verified === true || skRes.status === 'skill_executed' || skRes.status === 'skill_step_navigating')) {
            earlySkillDispatch = { ...skRes, nluSource: 'learned_skill', matchedSkillId: topSkill.id };
            nluSource = 'learned_skill';
          } else if (skRes && skRes.status === 'skill_step_failed') {
            failedLearnedSkill = skRes;
            const relearnOffer = this.teach.promptRelearnOffer(skRes, raw);
            earlySkillDispatch = { ...relearnOffer, failedStep: skRes.failedStep, failedStepIndex: skRes.failedStepIndex, nluSource: 'learned_skill', matchedSkillId: topSkill.id };
            nluSource = 'learned_skill';
          }
        }
      }

      // Phase 8 Latency Optimization: Deterministic unambiguous scoped-link fast path (<50ms, 0 LLM calls)
      if (!earlySkillDispatch && !failedLearnedSkill && !(meta && meta.forcePrimary) && wmInv && Array.isArray(wmInv.links)) {
        const cleanFast = String(raw || '').trim().replace(/[.,!?;:]+$/, '');
        const scopedFastM = cleanFast.match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:open|click(?:\s+on)?|select|choose)\s+(?:the\s+)?(.+?)\s+(?:under|in|inside|from)\s+(?:the\s+)?(.+?)$/i);
        if (scopedFastM && !/\b(?:option|radio|checkbox|toggle|switch|dropdown|setting|video|tab)\b/i.test(cleanFast)) {
          const wantLbl = scopedFastM[1].trim().toLowerCase();
          const wantSec = scopedFastM[2].trim().toLowerCase();
          const optHit = this.worldModel && typeof this.worldModel.findOptionByHierarchy === 'function'
            ? this.worldModel.findOptionByHierarchy(wantLbl, wantSec)
            : null;
          const optTag = String((optHit && optHit.element && optHit.element.tagName) || '').toUpperCase();
          const hasFormOpt = Boolean(optHit && ['INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(optTag));
          if (!hasFormOpt && wantLbl && wantSec) {
            const exactScoped = wmInv.links.filter((l) => {
              const lbl = String((l && l.label) || '').trim().toLowerCase();
              if (!lbl || lbl !== wantLbl) return false;
              const anc = Array.isArray(l.ancestorHeadings) ? l.ancestorHeadings.join(' ') : '';
              const domSec = (l.element && this.browserEngine && this.browserEngine.observer && typeof this.browserEngine.observer.computeParentSection === 'function')
                ? this.browserEngine.observer.computeParentSection(l.element)
                : '';
              const secHay = `${l.parentSection || ''} ${l.parentMenuLabel || ''} ${l.section || ''} ${anc} ${domSec}`.toLowerCase();
              return secHay.includes(wantSec);
            });
            if (exactScoped.length === 1) {
              const hit = exactScoped[0];
              nluPlan = {
                intent: 'open_link',
                target: hit.label || wantLbl,
                target_id: hit.id || null,
                confidence: 0.96,
                context: { section: hit.parentSection || hit.section || scopedFastM[2].trim(), candidate_id: hit.id || null },
                actions: [{ type: 'open_link', target: hit.label || wantLbl, section: hit.parentSection || hit.section || scopedFastM[2].trim(), candidate_id: hit.id || null }]
              };
              nluSource = 'deterministic_scoped_fastpath';
            }
          }
        }
      }

      const useRichNlu = !earlySkillDispatch && !nluPlan && (Boolean(failedLearnedSkill) || this._needsRichNluUnderstanding(raw, resolvedContext, preCentral, syncRule, structuredCtx, navChoiceCount, wmInv));
      if (useRichNlu) {
        if (this.worldModel && wmInv) {
          if (this.agentFsm) this.agentFsm.transition('RETRIEVING', { requestId, reason: 'semantic_retrieval' });
          const tSem0 = performance.now();
          const useNeuralEmbed = this._shouldUseNeuralEmbeddings(resolvedContext.resolvedText || raw, wmInv, resolvedContext, structuredCtx);
          semanticMatches = await Promise.race([
            this.worldModel.retrieveRelevantCandidatesAsync(
              resolvedContext.resolvedText || raw,
              { topK: 6, inventory: wmInv, timeoutMs: 800, offlineOnly: !useNeuralEmbed }
            ),
            new Promise((r) => setTimeout(() => r([]), 1500))
          ]).catch(() => []);
          semRetrieveMs = Math.round((performance.now() - tSem0) * 100) / 100;
          if (this.agentFsm) this.agentFsm.recordStageTiming(requestId, 'retrieval', semRetrieveMs);
        }
        const postSemValid = checkTurnValid({ tabId: currentTabId });
        if (!postSemValid.ok) {
          return { status: postSemValid.reason === 'user_cancelled' ? 'task_cancelled' : 'aborted_stale_turn', reason: postSemValid.reason };
        }

        if (this.agentFsm) this.agentFsm.transition('PLANNING', { requestId, reason: 'nlu_reasoner' });
        this._setAuroraTaskUi('processing', 'Processing with AI');
        const tReason0 = performance.now();
        ollamaReply = await this._requestOllamaNluPlan(raw, resolvedContext, structuredCtx, wmInv, semanticMatches, {
          learnedSkills: learnedSkillHits,
          forcePrimary: Boolean(meta && meta.forcePrimary)
        });
        nluCandidateNavigationIdentity = (ollamaReply && ollamaReply.candidateNavigationIdentity) || nluCandidateNavigationIdentity;
        nluReasoningMs = Math.round((performance.now() - tReason0) * 100) / 100;
        if (this.agentFsm) this.agentFsm.recordStageTiming(requestId, 'reasoning', nluReasoningMs);
        const postReasonValid = checkTurnValid({ tabId: currentTabId });
        if (!postReasonValid.ok) {
          return { status: postReasonValid.reason === 'user_cancelled' ? 'task_cancelled' : 'aborted_stale_turn', reason: postReasonValid.reason };
        }

        if (ollamaReply && ollamaReply.diag) nluDiag = ollamaReply.diag;
        if (ollamaReply && ollamaReply.status) {
          nluOllamaStatus = ollamaReply.status;
          nluHttpStatus = Number(ollamaReply.httpStatus || (ollamaReply.diag && ollamaReply.diag.httpStatus) || 0);
          nluErrorDetail = ollamaReply.message || (ollamaReply.diag && ollamaReply.diag.errorDetail) || '';
        }
        if (ollamaReply && ollamaReply.status === 'ok' && ollamaReply.plan && this._isPlanPlausibleForUtterance(ollamaReply.plan, raw, wmInv, structuredCtx)) {
          nluPlan = ollamaReply.plan;
          nluSource = ollamaReply.source || 'local ollama';
        }
        if (!nluPlan) {
          nluPlan = this._buildFallbackNluPlan(raw, resolvedContext, structuredCtx, wmInv, semanticMatches);
          if (nluPlan) nluSource = 'deterministic_nlu_fallback';
        }
      }

      const skipLlmFallback = Boolean(
        earlySkillDispatch ||
        nluPlan ||
        (preCentral && this.memory && preCentral.category !== this.memory.CENTRAL_INTENTS.GENERAL_QUESTION) ||
        (resolvedContext && resolvedContext.resolvedListItem && resolvedContext.resolvedListItem.entityType)
      );

      if (!useRichNlu && !skipLlmFallback) {
        this._setAuroraTaskUi('processing', 'Processing with AI');
      }
      const classified = earlySkillDispatch
        ? { intent: 'LEARNED_SKILL', args: {}, confidence: 0.99, cmdId, source: 'learned_skill' }
        : (this.intentEngine
          ? await this.intentEngine.classify(queryForClassification, { ...intentOpts, skipLlmFallback })
          : { intent: 'HELP', args: {}, confidence: 0.5, cmdId });
      if (!this._isTaskCurrent(taskId, taskSignal)) return { status: 'task_cancelled' };
      const intentMs = Math.round((performance.now() - tIntent0) * 100) / 100;

      // 4. Central 12-Category Intent Router
      const centralIntent = earlySkillDispatch
        ? null
        : (this.memory
          ? (skipLlmFallback && preCentral ? preCentral : this.memory.classifyCentralIntent(raw, resolvedContext, classified, pageDigest))
          : null);

      if (this.diagnostics) {
        this.diagnostics.log('intent', 'classified', {
          intent: (nluPlan && nluPlan.intent) || (classified && classified.intent),
          centralCategory: centralIntent && centralIntent.category,
          subAction: centralIntent && centralIntent.subAction,
          source: nluSource || (classified && classified.source) || 'rules',
          durationMs: intentMs
        });
      }

      if (tracker) {
        tracker.finishStage(cmdId, 'intent_classification', {
          success: Boolean(classified || centralIntent),
          backend: initialBackend
        });
        tracker.startStage(cmdId, 'task_planning', { backend: initialBackend });
        tracker.finishStage(cmdId, 'task_planning', {
          success: Boolean(nluPlan || earlySkillDispatch || centralIntent || classified),
          backend: initialBackend
        });
      }

      this._setStatusChip('Processing...');
      const selectedBackend = this._getSelectedBackend();
      if (tracker) tracker.startStage(cmdId, 'action_execution', { backend: selectedBackend });
      if (!earlySkillDispatch) this._setAuroraTaskUi('processing', 'Performing action');

      const tExec0 = performance.now();
      const execValid = checkTurnValid({ tabId: currentTabId });
      if (!execValid.ok) {
        return { status: execValid.reason === 'user_cancelled' ? 'task_cancelled' : 'aborted_stale_turn', reason: execValid.reason };
      }
      if (this.agentFsm) this.agentFsm.transition('EXECUTING', { requestId, reason: 'dispatch_action' });
      let dispatchRes = earlySkillDispatch || null;
      const previousAttempts = [];
      if (!dispatchRes && nluPlan) {
        dispatchRes = await this._executeNluActionPlan(nluPlan, raw, resolvedContext, structuredCtx, { classified, centralIntent, pageDigest, nluSource, wmInv, semanticMatches, requestId, taskId, candidateNavigationIdentity: nluCandidateNavigationIdentity });
        previousAttempts.push({
          source: nluSource || 'qwen_primary',
          plan: nluPlan,
          status: dispatchRes && dispatchRes.status,
          verified: Boolean(dispatchRes && dispatchRes.verified)
        });
        // Qwen produced a plan the execution engine cannot act on (unhandled intent) -> deterministic page-map fallback before generic routing
        if (!dispatchRes && nluSource !== 'deterministic_nlu_fallback') {
          const detPlan = this._buildFallbackNluPlan(raw, resolvedContext, structuredCtx, wmInv, semanticMatches);
          if (detPlan) {
            dispatchRes = await this._executeNluActionPlan(detPlan, raw, resolvedContext, structuredCtx, { classified, centralIntent, pageDigest, nluSource: 'deterministic_nlu_fallback', wmInv, semanticMatches, requestId, taskId, candidateNavigationIdentity: nluCandidateNavigationIdentity });
            if (dispatchRes) {
              nluPlan = detPlan;
              nluSource = 'deterministic_nlu_fallback';
            }
            previousAttempts.push({ source: 'deterministic_nlu_fallback', plan: detPlan, status: dispatchRes && dispatchRes.status, verified: Boolean(dispatchRes && dispatchRes.verified) });
          }
        }
      }
      if (!this._isTaskCurrent(taskId, taskSignal) && (!dispatchRes || dispatchRes.status !== 'needs_clarification')) {
        return { status: 'task_cancelled' };
      }
      const isGenericQuestionFallback = Boolean(
        failedLearnedSkill &&
        (!centralIntent || (this.memory && centralIntent.category === this.memory.CENTRAL_INTENTS.GENERAL_QUESTION)) &&
        (!classified || classified.intent === 'ANSWER' || classified.intent === 'HELP')
      );
      if (!dispatchRes && centralIntent && !isGenericQuestionFallback) {
        dispatchRes = await this._handleCentralRoute(centralIntent, classified, raw, resolvedContext, pageDigest, { taskId, taskSignal });
        previousAttempts.push({
          source: 'central_router',
          status: dispatchRes && dispatchRes.status,
          verified: Boolean(dispatchRes && (dispatchRes.verified === true || dispatchRes.ok === true))
        });
      }
      if (!dispatchRes && !isGenericQuestionFallback) {
        dispatchRes = await this.dispatchIntent(classified, raw, resolvedContext);
        previousAttempts.push({
          source: 'intent_dispatcher',
          status: dispatchRes && dispatchRes.status,
          verified: Boolean(dispatchRes && (dispatchRes.verified === true || dispatchRes.ok === true))
        });
      }
      if (!this._isTaskCurrent(taskId, taskSignal) && (!dispatchRes || dispatchRes.status !== 'needs_clarification')) {
        return { status: 'task_cancelled' };
      }

      // 5. Intelligent Qwen -> Stronger Ollama Primary Fallback Escalation (Section 1.2)
      const qwenTierUsed = (ollamaReply && (ollamaReply.modelTier || ollamaReply.tier)) || 'compact';
      let escalatedToOllama = Boolean((meta && meta.forcePrimary) || qwenTierUsed === 'primary' || qwenTierUsed === 'escalated_primary');
      const isActionableTask = Boolean(
        failedLearnedSkill ||
        (!isControlOrReadOnlyCmd &&
          (useRichNlu || (centralIntent && ['PAGE_NAVIGATION', 'FORM_ASSISTANCE', 'PAGE_SEARCH', 'MULTI_STEP_TASK'].includes(centralIntent.category))))
      );
      const isFailureNeedingRecovery = (res) => {
        if (!res) return true;
        if (res.awaiting === true) return false;
        const st = String(res.status || '');
        if (['disabled', 'option_disabled', 'sensitive_skipped', 'needs_clarification', 'ambiguous', 'ambiguous_video', 'confirming', 'moved', 'scrolled', 'acted', 'navigated', 'clicked', 'selected', 'selected_video', 'found_in_table', 'found', 'section_found', 'filter_applied', 'media_controlled', 'cancelled', 'user_denied', 'task_cancelled', 'aborted_stale_turn', 'captions_unavailable', 'waiting_for_user', 'explained_video', 'explained_paragraph', 'explained', 'skill_executed', 'skill_step_navigating', 'opened', 'searched', 'filled', 'toggled', 'read_section', 'reading_page', 'no_search_field'].includes(st)) {
          return false;
        }
        if (res.verified === true || res.ok === true) return false;
        return res.verified === false || res.ok === false || ['not_found', 'option_not_found', 'verification_failed', 'validation_rejected', 'error', 'unrecognized_repeat'].includes(st);
      };

      if (
        !earlySkillDispatch &&
        !escalatedToOllama &&
        isActionableTask &&
        isFailureNeedingRecovery(dispatchRes) &&
        nluOllamaStatus !== 'ollama_unavailable' &&
        (!meta || meta.skipEscalation !== true) &&
        typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function'
      ) {
        this._setAuroraTaskUi('processing', 'Reassessing with stronger AI');
        escalatedToOllama = true;
        const escReply = await this._escalateToOllamaPrimary(raw, ollamaReply, {
          status: (dispatchRes && dispatchRes.status) || 'failed',
          reason: (dispatchRes && (dispatchRes.message || dispatchRes.error)) || nluErrorDetail || 'Primary attempt could not complete or verify action.'
        }, {
          resolvedContext,
          structuredCtx,
          wmInv,
          semanticMatches,
          learnedSkills: learnedSkillHits,
          worldModelDigestText: (ollamaReply && ollamaReply._sentDigestText) || '',
          candidateIds: (ollamaReply && ollamaReply._sentCandidateIds) || [],
          previousAttempts,
          navigationIdentity: nluCandidateNavigationIdentity
        });

        const postEscValid = checkTurnValid({ tabId: currentTabId });
        if (!postEscValid.ok) {
          return { status: postEscValid.reason === 'user_cancelled' ? 'task_cancelled' : 'aborted_stale_turn', reason: postEscValid.reason };
        }

        if (escReply && escReply.requiresGeminiSpecialist && this.explainer) {
          dispatchRes = await this.explainPage({
            mode: /\bsummar/i.test(raw) ? 'summary' : 'qa',
            query: raw,
            specialist: true,
            explicitGemini: true,
            lang: this.resolveReplyLang(classified)
          });
          nluSource = 'gemini_specialist_authorized_by_ollama';
        } else if (escReply && escReply.status === 'ok' && escReply.plan && this._isPlanPlausibleForUtterance(escReply.plan, raw, wmInv, structuredCtx)) {
          const escExecRes = await this._executeNluActionPlan(escReply.plan, raw, resolvedContext, structuredCtx, {
            classified,
            centralIntent,
            pageDigest,
            nluSource: escReply.source || 'ollama_escalated_primary',
            wmInv,
            semanticMatches,
            requestId,
            taskId,
            candidateNavigationIdentity: nluCandidateNavigationIdentity,
            fromEscalation: true,
            allowGeminiSpecialist: Boolean(escReply.requiresGeminiSpecialist)
          });
          if (escExecRes) {
            dispatchRes = { ...escExecRes, recovered: escExecRes.verified !== false, escalatedFromQwen: true };
            nluPlan = escReply.plan;
            nluSource = escReply.source || 'ollama_escalated_primary';
          }
        }
      }

      // 6. Failure-triggered Teaching / Relearning Offer (Section 6 & Section 7)
      if (
        !earlySkillDispatch &&
        this.teach &&
        !this.teach.active &&
        isActionableTask &&
        isFailureNeedingRecovery(dispatchRes) &&
        (!meta || meta.offerTeachOnFailure !== false)
      ) {
        if (failedLearnedSkill) {
          dispatchRes = this.teach.promptRelearnOffer(failedLearnedSkill, raw);
        } else {
          dispatchRes = this.teach.promptTeachOffer({
            command: raw,
            reason: (dispatchRes && (dispatchRes.message || dispatchRes.error)) || 'Could not locate or verify the target control.',
            taskId
          });
        }
      }
      const execMs = Math.round((performance.now() - tExec0) * 100) / 100;
      const execBackend = (dispatchRes && dispatchRes.engine) || selectedBackend;
      if (tracker) {
        tracker.finishStage(cmdId, 'action_execution', {
          success: this._isCommandTruthfullySuccessful(dispatchRes),
          errorDetails: (dispatchRes && !this._isCommandTruthfullySuccessful(dispatchRes)) ? ((dispatchRes && (dispatchRes.message || dispatchRes.reason || dispatchRes.status)) || 'action_failed') : null,
          backend: execBackend
        });
      }

      if (tracker) tracker.startStage(cmdId, 'verification', { backend: execBackend });
      if (this.agentFsm) {
        this.agentFsm.recordStageTiming(requestId, 'execution', execMs);
        this.agentFsm.transition('VERIFYING', { requestId, reason: 'post_action_verify' });
        if (!dispatchRes || (dispatchRes.status !== 'needs_clarification' && dispatchRes.status !== 'waiting_for_user')) {
          this._setAuroraTaskUi('processing', 'Verifying result');
        }
        const finishedMetrics = this.agentFsm.finishTurn(requestId, 'IDLE', { status: (dispatchRes && dispatchRes.status) || 'executed' });
        if (finishedMetrics) window.__SW_LAST_TURN_METRICS__ = finishedMetrics;
      }
      const isVerified = Boolean(dispatchRes && (dispatchRes.verified === true || dispatchRes.ok === true));
      if (tracker) {
        tracker.finishStage(cmdId, 'verification', {
          success: isVerified,
          errorDetails: isVerified ? null : ((dispatchRes && (dispatchRes.message || dispatchRes.reason)) || 'verification_unconfirmed'),
          backend: execBackend
        });
      }

      // Release the active task lock as soon as action execution & verification complete
      const postExecStatus = dispatchRes && dispatchRes.status;
      const truthfullyOk = this._isCommandTruthfullySuccessful(dispatchRes);
      let termStatus = 'failed';
      if (postExecStatus === 'needs_clarification' || postExecStatus === 'waiting_for_user') {
        termStatus = 'needs_clarification';
      } else if (postExecStatus === 'task_cancelled' || postExecStatus === 'aborted_stale_turn') {
        termStatus = 'cancelled';
      } else if (truthfullyOk) {
        termStatus = 'completed';
      }

      if (tracker) {
        tracker.recordTerminalState(cmdId, termStatus, {
          backend: execBackend,
          reason: (dispatchRes && (dispatchRes.message || dispatchRes.reason || dispatchRes.status)) || termStatus
        });
      }

      if (taskId && postExecStatus === 'needs_clarification') {
        if (this.taskLifecycle && this.taskLifecycle.state !== 'WAITING_FOR_CLARIFICATION') {
          this.taskLifecycle.state = 'WAITING_FOR_CLARIFICATION';
        }
        this._setAuroraTaskUi('waiting_for_clarification', 'Waiting for clarification');
      } else if (taskId && (postExecStatus === 'task_cancelled' || postExecStatus === 'aborted_stale_turn')) {
        this._finishActiveTask(taskId, 'CANCELLED', 'Cancelled');
      } else if (taskId && postExecStatus !== 'waiting_for_user') {
        this._finishActiveTask(taskId, truthfullyOk ? 'COMPLETED' : 'ERROR', truthfullyOk ? 'Completed' : ((dispatchRes && (dispatchRes.message || dispatchRes.reason || dispatchRes.status)) || 'Action failed'));
      }

      const resultText = (dispatchRes && (dispatchRes.answer || dispatchRes.message || dispatchRes.section)) ||
        (this.dialogue && this.dialogue.lastSpokenText) ||
        '';

      if (this.dialogue) {
        this.dialogue.recordTurn({
          user: raw,
          action: (centralIntent && centralIntent.category) || classified.intent || 'command',
          assistant: resultText
        });
      }

      const tMem0 = performance.now();
      if (this.memory && !sensitiveFocused && !this.memory.isSensitiveText(raw)) {
        await this.memory.recordActivity({
          user_command: raw,
          intent: (centralIntent && centralIntent.category) || classified.intent || 'GENERAL_QUESTION',
          topic: resolvedContext.resolvedTopic || (centralIntent && centralIntent.targetTopic) || this.memory.state.currentTopic,
          entities: resolvedContext.resolvedEntity ? [resolvedContext.resolvedEntity] : undefined,
          action: (dispatchRes && dispatchRes.status) || ((centralIntent && centralIntent.subAction) || 'executed'),
          result: resultText
        });
        // Adaptive interaction learning signals (requires repeated occurrences >= 2 & learningEnabled)
        if (this.memory.privacy && this.memory.privacy.learningEnabled !== false && typeof this.memory.recordPreferenceSignal === 'function') {
          const lowerCmd = raw.toLowerCase();
          if (centralIntent && centralIntent.category === 'EXTERNAL_NAVIGATION' && /\bofficial\b/i.test(lowerCmd)) {
            await this.memory.recordPreferenceSignal('preferOfficialSources', true, { label: 'Official sources prioritized' });
          } else if (/\b(?:brief|concise|shorter|short\s+summary)\b/i.test(lowerCmd)) {
            await this.memory.recordPreferenceSignal('responseStyle', 'concise', { label: 'Concise summaries' });
          } else if (/\b(?:numbered|number\s+list|numbered\s+options)\b/i.test(lowerCmd)) {
            await this.memory.recordPreferenceSignal('presentationFormat', 'numbered', { label: 'Numbered options' });
          }
        }
      }
      const memoryMs = Math.round((performance.now() - tMem0) * 100) / 100;
      const totalMs = Math.round((performance.now() - turnStart) * 100) / 100;

      const effectiveStatus = (dispatchRes && dispatchRes.status)
        || ((dispatchRes && dispatchRes.awaiting && !dispatchRes.executed) ? 'awaiting_confirmation' : 'dispatched');

      if (this.diagnostics) {
        const isNav = centralIntent && ['PAGE_NAVIGATION', 'EXTERNAL_NAVIGATION', 'PAGE_SEARCH'].includes(centralIntent.category);
        const usedLlm = Boolean((classified && classified.source === 'llm') || (dispatchRes && dispatchRes.source && !/basic|extractive|rules/i.test(String(dispatchRes.source))));
        this.diagnostics.recordTurnTrace({
          cmdId,
          intent: (nluPlan && nluPlan.intent) || (classified && classified.intent),
          centralCategory: centralIntent && centralIntent.category,
          corefMs,
          intentMs,
          memoryMs,
          llmMs: usedLlm ? execMs : 0,
          navigationMs: isNav ? execMs : 0,
          totalMs,
          usedLlm,
          status: effectiveStatus
        });

        if (typeof this.diagnostics.recordWorldModelTrace === 'function') {
          const traceEntry = this.diagnostics.recordWorldModelTrace({
            requestId: cmdId,
            sessionId: (this.memory && this.memory.tabId) || 'default',
            speech: raw,
            tabId: (wmInv && wmInv.tabId) || (this.memory && this.memory.tabId) || 'default',
            url: (wmInv && wmInv.urlClean) || (window.location && window.location.pathname) || '',
            pageType: (wmInv && wmInv.pageType) || (structuredCtx && structuredCtx.pageType) || 'general',
            discoveryMode: (wmInv && wmInv.discoveryMode) || 'static_content',
            inventoryVersion: (wmInv && wmInv.inventoryVersion) || 0,
            candidateCount: (wmInv && wmInv.entities && wmInv.entities.size) || 0,
            contextSentTokens: (nluDiag && nluDiag.contextTokens) || 0,
            contextTruncated: Boolean(nluDiag && nluDiag.truncated),
            memoriesRetrieved: (resolvedContext && resolvedContext.relevantMemories || []).slice(0, 3).map((m) => m.activity && m.activity.user_command).filter(Boolean),
            semanticMatches: (semanticMatches || []).slice(0, 4).map((m) => `${m.entity.id}:${m.entity.label}(${m.score})`),
            ollamaStatus: nluOllamaStatus,
            ollamaHttpStatus: nluHttpStatus,
            ollamaUsed: nluSource === 'local ollama',
            embedStatus: (semanticMatches[0] && semanticMatches[0].vectorStatus) || (wmInv && wmInv.lastEmbedStatus) || 'untested',
            embedModel: (semanticMatches[0] && semanticMatches[0].vectorModel) || (wmInv && wmInv.lastEmbedModel) || '',
            usedFallbackPlanner: nluSource === 'deterministic_nlu_fallback',
            ollamaErrorDetail: nluErrorDetail,
            ollamaLatencyMs: (nluDiag && nluDiag.latencyMs) || 0,
            ollamaResponse: (nluDiag && nluDiag.rawResponsePreview) || '',
            structuredAction: nluPlan ? { intent: nluPlan.intent, target_id: nluPlan.target_id, action: nluPlan.action, goal: nluPlan.goal } : null,
            candidateValidation: (dispatchRes && dispatchRes.validationStatus) || 'ok',
            browserExecution: effectiveStatus,
            verificationResult: (dispatchRes && dispatchRes.verified === true)
              ? 'verified'
              : ((dispatchRes && dispatchRes.verified === false)
                  ? 'unverified'
                  : (effectiveStatus === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'n/a')),
            failureStage: (dispatchRes && dispatchRes.failureStage) || 'none',
            recovered: Boolean(dispatchRes && dispatchRes.recovered),
            timingMs: { corefMs, wmBuildMs, semRetrieveMs, intentMs, execMs, memoryMs, totalMs }
          });
          if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
            try { chrome.runtime.sendMessage({ type: 'SLEEPWALKER_RECORD_DEV_TRACE', trace: traceEntry }, () => { void chrome.runtime?.lastError; }); } catch (_e) {}
          }
        }
      }

      // Unify execution routing & transparency record
      const resolvedSelectedEngine = (dispatchRes && dispatchRes.engine)
        ? dispatchRes.engine
        : (this.useRebuiltBrowserEngine ? 'legacy_fallback' : 'legacy');
      const resolvedExecutionBackend = (dispatchRes && dispatchRes.backend)
        ? dispatchRes.backend
        : (resolvedSelectedEngine === 'stagehand_adapter'
            ? 'stagehand_cdp_sidecar'
            : (typeof window !== 'undefined' && window.__sleepwalker_cdp_input ? 'cdp_attached_tab' : 'dom_content_script'));
      const resolvedInputMechanism = (dispatchRes && dispatchRes.mechanism)
        ? dispatchRes.mechanism
        : (resolvedSelectedEngine === 'stagehand_adapter'
            ? 'stagehand_cdp_actions'
            : (typeof window !== 'undefined' && window.__sleepwalker_cdp_input ? 'cdp_browser_level_input' : 'synthetic_events_and_dom_methods'));
      const resolvedObservationSource = (dispatchRes && (dispatchRes.observationSource || (dispatchRes.observation && dispatchRes.observation.source)))
        || (nluSource === 'vision_model' ? 'vision_model' : (this.worldModel ? 'dom_and_accessibility' : 'dom'));
      const resolvedActualTarget = (dispatchRes && (dispatchRes.target || dispatchRes.field || dispatchRes.targetLabel || dispatchRes.actualTarget)) || (nluPlan && (nluPlan.target || nluPlan.target_id)) || null;
      const resolvedVerificationResult = (dispatchRes && dispatchRes.verified === true)
        ? 'verified'
        : ((dispatchRes && dispatchRes.verified === false)
            ? 'unverified'
            : ((dispatchRes && dispatchRes.ok === true) ? 'verified' : ((dispatchRes && dispatchRes.ok === false) ? 'failed' : 'n/a')));

      return {
        commandId: cmdId,
        selectedEngine: resolvedSelectedEngine,
        executionBackend: resolvedExecutionBackend,
        inputMechanism: resolvedInputMechanism,
        observationSource: resolvedObservationSource,
        actualTarget: resolvedActualTarget,
        verificationResult: resolvedVerificationResult,
        status: effectiveStatus,
        centralIntent: centralIntent ? centralIntent.category : null,
        classified,
        resolvedContext,
        timingMs: { corefMs, intentMs, execMs, memoryMs, totalMs },
        ...(dispatchRes && typeof dispatchRes === 'object' ? dispatchRes : {})
      };
    }

    /**
     * Execute high-level central router intents (Off-Page Research, External Navigation, Multi-Step Task, Within-Page Search, Contextual Jumps).
     */
    async _handleCentralRoute(central, classified, raw, resolvedContext, pageDigest, meta = {}) {
      if (!central) return null;
      if (meta && ((meta.taskSignal && meta.taskSignal.aborted) || (meta.taskId && !this._isTaskCurrent(meta.taskId)))) {
        return { status: 'task_cancelled', ok: false, reason: 'superseded_by_newer_command' };
      }
      const cat = central && central.category;
      const C = this.memory ? this.memory.CENTRAL_INTENTS : {};

      if (cat === C.CONVERSATION_CONTROL) {
        if (
          ['schedule_reminder', 'list_reminders', 'cancel_reminder', 'update_reminder'].includes(central.subAction)
        ) {
          return this._handleReminderRoute(central, raw);
        }
        if (
          ['toggle_learning_privacy', 'toggle_proactive_privacy', 'clear_personal_context', 'inspect_personal_context', 'correct_memory', 'set_preference'].includes(central.subAction)
        ) {
          return this._handlePersonalControlRoute(central, raw);
        }
        if (
          ['pause_task', 'resume_task', 'skip_step', 'cancel_task', 'show_results', 'explain_progress'].includes(central.subAction) &&
          this.taskPlanner
        ) {
          return this.taskPlanner.handleTaskControlCommand(central.subAction, raw);
        }
        if (central.subAction === 'resume_session_task' || central.subAction === 'return_earlier_task') {
          return this.resumeSavedTask();
        }
        if (central.subAction === 'rest_session' && this.dialogue) {
          this.dialogue.restSession({ reason: 'voice_rest' });
          return { status: 'session_resting', message: 'Resting now.' };
        }
      }

      if (cat === C.PAGE_SEARCH && central.subAction === 'search_within_page') {
        return this._executeSearchWithinPage((classified && classified.args && classified.args.query) || central.resolvedQuery || raw, pageDigest);
      }

      if (cat === C.PAGE_SEARCH && (central.subAction === 'in_website_search' || central.subAction === 'site_search' || central.subAction === 'global_site_search')) {
        const sq = (classified && classified.args && (classified.args.query || classified.args.target)) || central.resolvedQuery || raw;
        return this._executeSearchWithEngine(sq, {
          rawCommand: raw,
          cmdId: (classified && classified.cmdId) || '',
          taskId: meta && meta.taskId,
          taskSignal: meta && meta.taskSignal
        });
      }

      if (cat === C.PAGE_SEARCH && central.subAction === 'apply_filter' && this.navigator) {
        const filterRes = await this.navigator.executeFilter(central.filterQuery || raw);
        if (this.memory && filterRes && filterRes.status === 'filter_applied') {
          await this.memory.upsertTask({
            constraints: /\bfree\b/i.test(raw) ? { freeOnly: true } : undefined,
            completedStep: `Applied filter: ${filterRes.filterLabel}`
          });
          if (this.taskPlanner) await this.taskPlanner.markStepCompleted('filter_criteria', filterRes.filterLabel);
        } else if (filterRes && filterRes.status === 'filter_not_found' && this.taskPlanner) {
          await this.taskPlanner.recordFailure('Apply webpage filter', filterRes.message || 'Filter not found', window.location.href);
        }
        return filterRes;
      }

      if (cat === C.PAGE_NAVIGATION && central.subAction === 'history_back' && this.navigator) {
        if (/\bsection\b/i.test(raw)) {
          const prevSec = (resolvedContext && resolvedContext.resolvedSection) ||
            (this.memory && this.memory.state && this.memory.state.selectionState && this.memory.state.selectionState.previousSection) || '';
          if (prevSec) {
            this._setStatusChip(`Returning to "${prevSec}" section...`);
            const navRes = await this._executeGoToSectionWithEngine(prevSec, { readAfter: false });
            if (this.memory && navRes && navRes.section && typeof this.memory.setActiveUiFocus === 'function') {
              this.memory.setActiveUiFocus({ section: navRes.section });
            }
            return { ...navRes, verified: Boolean(navRes && (navRes.verified || navRes.status !== 'not_found')) };
          }
        }
        this._setStatusChip('Going back to the previous page...');
        return this.navigator.historyAction('back', 0.95, { fastPath: true, skipConfirm: true, preferPreviousTab: /\b(?:tab|webpage|site)\b/i.test(raw) });
      }

      if (cat === C.PAGE_NAVIGATION && central.subAction === 'semantic_destination' && this.navigator) {
        const linkHit = this.navigator.findSemanticDestinationLink(central.targetKind, document);
        if (linkHit && linkHit.href && !linkHit.href.startsWith('#')) {
          return this._navigateToExternalUrl(linkHit.href, linkHit.label || central.targetKind, central.targetKind);
        }
        if (linkHit && linkHit.element && typeof this.navigator.previewAndAct === 'function') {
          return this.navigator.previewAndAct(linkHit, { confidence: 0.92, matches: [linkHit] });
        }
        const secRes = await this._executeGoToSectionWithEngine(central.targetKind, { readAfter: true });
        if (secRes && secRes.status === 'not_found' && this.taskPlanner) {
          await this.taskPlanner.recordFailure(`Find ${central.targetKind}`, `No ${central.targetKind} link or section found on ${document.title}`, window.location.href);
        }
        return secRes;
      }

      if (cat === C.PAGE_NAVIGATION && central.subAction === 'navigate_section' && central.sectionTarget && (this.navigator || this.browserEngine)) {
        let secTarget = central.sectionTarget;
        if (/^(?:the\s+)?(?:previous|last|earlier)(?:\s+section)?$/i.test(String(secTarget).trim())) {
          secTarget = (resolvedContext && resolvedContext.resolvedSection) ||
            (this.memory && this.memory.state && this.memory.state.selectionState && this.memory.state.selectionState.previousSection) || secTarget;
        }
        this._setStatusChip(`Executing: finding "${secTarget}" section...`);
        const navRes = await this._executeGoToSectionWithEngine(secTarget, { readAfter: false });
        if (this.memory && navRes && navRes.section && typeof this.memory.setActiveUiFocus === 'function') {
          this.memory.setActiveUiFocus({ section: navRes.section });
        }
        if (navRes && navRes.status === 'not_found' && this.taskPlanner) {
          await this.taskPlanner.recordFailure(`Navigate section: ${secTarget}`, `Section "${secTarget}" not found`, window.location.href);
        }
        return { ...navRes, verified: Boolean(navRes && (navRes.verified || navRes.status !== 'not_found')) };
      }

      if (cat === C.FORM_ASSISTANCE && central.subAction === 'element_select' && (this.elementSelector || this.browserEngine)) {
        if (this.browserEngine && this.useRebuiltBrowserEngine && !/^(?:no|not\s+that|instead)\b/i.test(raw) && !/\b(?:first|second|third|fourth|fifth|1st|2nd|3rd|\d+th)\b/i.test(raw)) {
          const beDrop = await this._tryRebuiltDropdownSelect(raw);
          if (beDrop) return beDrop;
        }
        const selRes = await this.elementSelector.handleCommand(raw, {
          intentArgs: (classified && classified.args) || {},
          doc: document,
          isCorrection: /^(?:no|not\s+that|instead)\b/i.test(raw)
        });
        if (selRes && selRes.status === 'delegate_list_item') {
          let items = (this.memory && this.memory.state.currentEntities && this.memory.state.currentEntities.listItems) || [];
          if (items.length === 0 && this.navigator && typeof this.navigator.extractPageResults === 'function') {
            items = this.navigator.extractPageResults(document);
          }
          const pickedItem = items[selRes.ordinalIndex];
          if (pickedItem) {
            if (this.memory && this.memory.state && this.memory.state.currentEntities) {
              this.memory.state.currentEntities.lastPickedIndex = selRes.ordinalIndex;
              this.memory.state.currentEntities.focusedEntity = pickedItem.title;
            }
            if (pickedItem.element && typeof pickedItem.element.click === 'function') {
              pickedItem.element.click();
            }
            const msg = `Selected "${pickedItem.title}" (option ${selRes.ordinalIndex + 1}). Say "Open its official website" to visit it.`;
            this.setAssistantReply(msg);
            if (window.SW_UI) {
              window.SW_UI.setState('speaking');
              window.SW_UI.showCard({ type: 'answer', title: pickedItem.title, text: msg });
            }
            if (this.reader) this.reader.readText(msg);
            return { ok: true, verified: true, status: 'selected_list_item', selectedValue: pickedItem.title, answer: msg };
          }
          const nfMsg = `Could not find item #${selRes.ordinalIndex + 1} (${selRes.noun}) on this page.`;
          this.setAssistantReply(nfMsg);
          if (window.SW_UI) window.SW_UI.showCard({ type: 'error', title: 'Not Found', text: nfMsg });
          return { ok: false, verified: false, status: 'not_found', message: nfMsg };
        }
        return selRes;
      }

      if (cat === C.FORM_ASSISTANCE && (central.subAction === 'inspect_form' || central.subAction === 'validate_form') && this.forms) {
        const gate = this.navigator && typeof this.navigator.detectSecurityGate === 'function'
          ? this.navigator.detectSecurityGate(document)
          : { blocked: false };
        if (gate && gate.blocked) {
          if (this.memory) await this.memory.upsertTask({ status: 'WAITING_FOR_USER', nextRecommendedAction: `Complete ${gate.gateType} manually` });
          const gateMsg = `${gate.reason}. Please complete that directly, then say "Continue".`;
          this.setAssistantReply(gateMsg);
          if (window.SW_UI) window.SW_UI.showCard({ type: 'answer', title: 'Security Gate Detected', text: gateMsg });
          return { status: 'waiting_for_user', gateType: gate.gateType, message: gateMsg };
        }
        return central.subAction === 'validate_form'
          ? this.forms.validateFormFields(document)
          : this.forms.inspectAndSummarizeForm(document);
      }

      if (cat === C.OFF_PAGE_RESEARCH) {
        return this._executeOffPageResearch(raw, resolvedContext, central, pageDigest);
      }

      if (cat === C.EXTERNAL_NAVIGATION) {
        return this._executeExternalNavigation(central, raw, resolvedContext);
      }

      if (cat === C.MULTI_STEP_TASK) {
        return this._executeMultiStepTask(central, raw, resolvedContext);
      }

      // Context Separation (Phase 5): Entity-specific research query ("What are LMU Munich's deadlines/fees?")
      const isoCtx = resolvedContext && resolvedContext.isolatedEntityContext;
      if (isoCtx && isoCtx.entity &&
          !/\b(?:find|open|play|watch|select|choose)\b.*\bvideos?\b/i.test(String(raw || '')) &&
          (isoCtx.entity.facts.length > 0 || isoCtx.entity.fees || isoCtx.entity.deadlines || isoCtx.entity.requirements)) {
        const ent = isoCtx.entity;
        const factBits = [
          ent.fees ? `Fees: ${ent.fees}.` : '',
          ent.deadlines ? `Deadlines: ${ent.deadlines}.` : '',
          ent.requirements ? `Requirements: ${ent.requirements}.` : '',
          ent.facts && ent.facts.length > 0 ? ent.facts.slice(-2).join(' ') : ''
        ].filter(Boolean).join(' ');
        const isoMsg = `${ent.entityName}: ${factBits}${ent.officialUrl ? ` (Source: ${ent.officialUrl})` : ''}`;
        this.setAssistantReply(isoMsg);
        if (window.SW_UI) {
          window.SW_UI.setState('speaking');
          window.SW_UI.showCard({
            type: 'answer',
            title: ent.entityName,
            text: isoMsg,
            sources: ent.officialUrl ? [{ title: ent.entityName, url: ent.officialUrl, official: ent.official }] : undefined,
            ...this._maybeBuildProactiveBar(raw)
          });
        }
        if (this.reader) this.reader.readText(isoMsg);
        return {
          status: 'answered_isolated_entity',
          entityName: ent.entityName,
          answer: isoMsg,
          facts: ent.facts,
          officialUrl: ent.officialUrl
        };
      }

      // Cross-tab lookup ("Which tab has MIT?" / "Switch to the Germany tab")
      const tabMatch = resolvedContext && resolvedContext.resolvedTabMatch;
      if (tabMatch && tabMatch.bestTab) {
        const t = tabMatch.bestTab;
        const shouldSwitch = /\b(?:switch\s+to|go\s+to|open|focus)\b/i.test(raw);
        let switchStatus = 'found_tab';
        if (shouldSwitch && /^\d+$/.test(String(t.tabId || '')) && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_FOCUS_TAB', tabId: Number(t.tabId) }, () => { void chrome.runtime?.lastError; });
          switchStatus = 'switched_tab';
        }
        const factsText = Array.isArray(t.keyFacts) && t.keyFacts.length > 0 ? ` Key detail: ${t.keyFacts[0]}` : '';
        const msg = shouldSwitch
          ? `Switching to tab with "${t.title || t.urlClean}" (${t.urlClean}).${factsText}`
          : `"${t.title || t.topic}" is in tab ${t.tabId} (${t.urlClean}).${factsText}`;
        this.setAssistantReply(msg);
        if (window.SW_UI) {
          window.SW_UI.setState('speaking');
          window.SW_UI.showCard({ type: 'answer', title: `Tab Match: ${t.title || t.topic}`, text: msg });
        }
        if (this.reader) this.reader.readText(msg);
        return { status: switchStatus, matchedTab: t, answer: msg };
      }

      // Cross-tab website comparison ("Compare these two websites")
      const crossCompare = resolvedContext && resolvedContext.crossTabCompare;
      if (crossCompare) {
        if (crossCompare.status === 'ambiguous' && Array.isArray(crossCompare.options) && crossCompare.options.length >= 2) {
          const msg = `${crossCompare.question} ${crossCompare.options.map((o, i) => `${i + 1}. ${o}`).join(' ')}`;
          if (this.dialogue) {
            this.dialogue.setPendingPrompt({
              kind: 'choice',
              label: 'cross_tab_compare_clarification',
              askedText: msg,
              options: crossCompare.options,
              onAnswer: (_picked, info) => {
                const idx = info && typeof info.index === 'number' ? info.index : 0;
                const a = crossCompare.sites[idx] || crossCompare.sites[0];
                const b = crossCompare.sites[idx === 0 ? 1 : 0] || crossCompare.sites[1];
                const compMsg = this._formatCrossTabComparison(a, b);
                this.setAssistantReply(compMsg);
                if (window.SW_UI) window.SW_UI.showCard({ type: 'answer', title: 'Website Comparison', text: compMsg });
                if (this.reader) this.reader.readText(compMsg);
                return { status: 'compared_tabs', answer: compMsg };
              }
            });
          }
          this.setAssistantReply(msg);
          if (window.SW_UI) {
            window.SW_UI.setState('confirm');
            window.SW_UI.showCard({
              type: 'choices',
              title: 'Clarify Websites to Compare',
              text: crossCompare.question,
              choices: crossCompare.options
            });
          }
          if (this.reader) this.reader.readText(msg);
          return { status: 'needs_clarification', clarificationOptions: crossCompare.options, message: msg };
        }
        if (crossCompare.status === 'ready' && Array.isArray(crossCompare.sites) && crossCompare.sites.length >= 2) {
          const msg = this._formatCrossTabComparison(crossCompare.sites[0], crossCompare.sites[1]);
          this.setAssistantReply(msg);
          if (window.SW_UI) {
            window.SW_UI.setState('speaking');
            window.SW_UI.showCard({ type: 'answer', title: 'Cross-Tab Website Comparison', text: msg });
          }
          if (this.reader) this.reader.readText(msg);
          return { status: 'compared_tabs', sites: crossCompare.sites, answer: msg };
        }
      }

      // Focused external discovery / multi-tab entity follow-up ("What was the application fee of the second university?")
      const focusedExt = resolvedContext && resolvedContext.resolvedListItem;
      if (focusedExt && ((focusedExt.entityType && focusedExt.summary) || (Array.isArray(focusedExt.tabFacts) && focusedExt.tabFacts.length > 0))) {
        const factSnippet = Array.isArray(focusedExt.tabFacts) && focusedExt.tabFacts.length > 0
          ? ` From visited tab (${focusedExt.matchedTabUrl || 'opened site'}): ${focusedExt.tabFacts.join(' ')}`
          : '';
        const baseSummary = focusedExt.summary || '';
        const ansText = `${focusedExt.title}:${factSnippet || (baseSummary ? ` ${baseSummary}` : '')} Say "Open its official website" if you would like me to open its official site.`;
        this.setAssistantReply(ansText);
        if (window.SW_UI) {
          window.SW_UI.setState('speaking');
          const actions = focusedExt.officialUrl
            ? [{ id: 'open_focused_ext', label: `Open ${focusedExt.title.split('(')[0].trim().slice(0, 26)}`, primary: true }]
            : [];
          window.SW_UI.showCard({
            type: 'answer',
            title: focusedExt.title,
            text: ansText,
            actions,
            onAction: (id) => {
              if (id === 'open_focused_ext' && focusedExt.officialUrl) {
                this._navigateToExternalUrl(focusedExt.officialUrl, focusedExt.title, focusedExt.title);
              }
            }
          });
        }
        if (this.reader) this.reader.readText(ansText);
        return {
          status: 'answered_entity_focus',
          topic: focusedExt.title,
          answer: ansText,
          tabFacts: focusedExt.tabFacts || [],
          officialUrl: focusedExt.officialUrl || ''
        };
      }

      // For FOLLOW_UP_QUESTION / CONTEXTUAL_QUESTION / GENERAL_QUESTION, enrich query with resolved coreference
      if (resolvedContext && resolvedContext.isFollowUp && resolvedContext.resolvedText && resolvedContext.resolvedText !== raw) {
        return this.explainPage({
          mode: 'qa',
          query: resolvedContext.resolvedText,
          level: 'standard',
          lang: this.resolveReplyLang(classified),
          isFollowUp: true
        });
      }

      return null;
    }

    /**
     * Fast deterministic within-page search (<10ms) that locates matching chunks/headings in DOM without website navigation.
     */
    async _executeSearchWithinPage(query, pageDigest = null) {
      const cleanQ = String(query || '').trim();
      const digestApi = window.SleepwalkerDigest || null;
      const digest = pageDigest || (this.explainer && this.explainer.getPageDigest && this.explainer.getPageDigest()) || null;

      let matchedHeading = this.outline && this.outline.fuzzyFindHeading ? this.outline.fuzzyFindHeading(cleanQ) : null;
      if (matchedHeading && this.outline && this.outline.scrollToHeading) {
        this.outline.scrollToHeading(matchedHeading);
      }

      let snippet = '';
      if (digest && digestApi && typeof digestApi.selectTopChunks === 'function') {
        const chunks = digestApi.selectTopChunks(digest, cleanQ, { maxChunks: 2, maxTokens: 400 });
        const top = chunks.find((c) => c.score > 0);
        if (top) {
          snippet = `Found in "${top.section}": ${top.text.slice(0, 260)}`;
        }
      }

      const msg = snippet || (matchedHeading
        ? `Moved to section matching "${cleanQ}": ${matchedHeading.text}.`
        : `No clear match for "${cleanQ}" was found within this page.`);
      this.setAssistantReply(msg);
      if (window.SW_UI) {
        window.SW_UI.setState('speaking');
        window.SW_UI.showCard({ type: 'answer', title: `On This Page: "${cleanQ}"`, text: msg });
      }
      if (this.reader) this.reader.readText(msg);
      return { status: snippet || matchedHeading ? 'found_in_page' : 'not_found_in_page', scope: 'page', answer: msg };
    }

    /**
     * Handle OFF_PAGE_RESEARCH: Research related topic off-page (e.g., travel/visa to China),
     * synthesize practical guidance + official portal links, update activeTask, and offer to open links.
     */
    async _executeOffPageResearch(raw, resolvedContext, central, pageDigest) {
      this._setStatusChip('Researching related travel & guide info...');
      const plan = this.memory.buildOffPageResearchPlan(raw, resolvedContext, pageDigest);
      let finalSummary = plan.summaryEn;

      // Optionally enhance via LLM cascade ONLY when no structured listItems were already assembled, with a short 2500ms budget
      if ((!plan.listItems || plan.listItems.length === 0) &&
          typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        try {
          const llmRes = await new Promise((resolve) => {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 2500);
            chrome.runtime.sendMessage(
              {
                type: 'SLEEPWALKER_OFF_PAGE_RESEARCH_REQUEST',
                payload: { query: plan.resolvedQuery, topic: plan.targetTopic, lang: this.resolveReplyLang() }
              },
              (reply) => {
                if (done) return;
                done = true;
                clearTimeout(t);
                resolve(reply || null);
              }
            );
          });
          if (llmRes && llmRes.status === 'ok' && llmRes.answer) {
            const recTitle = plan.recommendedUrls && plan.recommendedUrls[0] ? plan.recommendedUrls[0].title : '';
            finalSummary = recTitle
              ? `${llmRes.answer}\nRecommended: ${recTitle}. Would you like me to open it?`
              : llmRes.answer;
          }
        } catch (_e) {}
      }

      if (this.taskPlanner && this.taskPlanner.isMultiStepObjective(raw, resolvedContext, central)) {
        const planned = await this.taskPlanner.startOrUpdateTaskFromPlan(raw, resolvedContext, {
          pageDigest,
          relevantUrls: plan.recommendedUrls,
          resultsSnapshot: plan.listItems,
          entities: (plan.taskPatch && plan.taskPatch.entities) || undefined
        });
        await this.memory.upsertTask({
          completedStep: plan.taskPatch && plan.taskPatch.completedStep,
          relevantUrls: plan.recommendedUrls,
          resultsSnapshot: plan.listItems
        });
        if (planned && planned.template && planned.template.missingConstraintsPrompt) {
          finalSummary = `${planned.template.missingConstraintsPrompt}\n\n${finalSummary}`;
        }
      } else {
        await this.memory.upsertTask(plan.taskPatch);
      }

      const activeTask = this.memory && this.memory.state.activeTask;
      const progressSteps = (this.taskPlanner && activeTask && Array.isArray(activeTask.plannedSteps) && activeTask.plannedSteps.length > 0)
        ? this.taskPlanner.buildProgressCardSteps(activeTask)
        : undefined;

      const primaryUrl = plan.recommendedUrls[0];
      if (this.dialogue && primaryUrl) {
        const isBookingNeedsConstraints = Boolean(activeTask && activeTask.status === 'WAITING_FOR_USER');
        this.dialogue.setPendingPrompt(
          isBookingNeedsConstraints
            ? {
                kind: 'question',
                label: 'collecting_booking_constraints',
                askedText: finalSummary,
                onAnswer: async (replyText) => {
                  if (!this.taskPlanner) return { handled: false };
                  const parsed = this.taskPlanner.extractConstraints(replyText, activeTask.constraints);
                  const added = parsed.dates !== (activeTask.constraints && activeTask.constraints.dates) ||
                    parsed.guests !== (activeTask.constraints && activeTask.constraints.guests) ||
                    parsed.budget !== (activeTask.constraints && activeTask.constraints.budget);
                  if (!added) return { handled: false };
                  await this.memory.upsertTask({ constraints: parsed });
                  await this.taskPlanner.markStepCompleted('collect_reqs', replyText, { status: 'RUNNING' });
                  const ack = `Got it (${[parsed.dates, parsed.guests ? `${parsed.guests} guests` : '', parsed.budget].filter(Boolean).join(', ')}). Say "Open the first one" to review options, and I will still ask for confirmation before any booking.`;
                  this.setAssistantReply(ack);
                  if (window.SW_UI) {
                    window.SW_UI.showCard({
                      type: 'answer',
                      title: `${activeTask.topic || 'Booking'} Details Saved`,
                      text: ack,
                      steps: this.taskPlanner.buildProgressCardSteps(this.memory.state.activeTask)
                    });
                  }
                  if (this.reader) this.reader.readText(ack);
                  return { status: 'constraints_collected', constraints: parsed, answer: ack };
                }
              }
            : {
                kind: 'yesno',
                label: 'open_recommended_website',
                askedText: finalSummary,
                onAnswer: async (yes) => {
                  if (yes) {
                    return this._navigateToExternalUrl(primaryUrl.url, primaryUrl.title, plan.targetTopic);
                  }
                  const stayMsg = `Okay, keeping you on this page. Ask any other question about ${plan.targetTopic} anytime.`;
                  this.setAssistantReply(stayMsg);
                  if (window.SW_UI) window.SW_UI.showCard({ type: 'answer', title: 'Staying Here', text: stayMsg });
                  if (this.reader) this.reader.readText(stayMsg);
                  return { status: 'declined_navigation' };
                }
              }
        );
      }

      const pi = window.SleepwalkerPersonalIntel || null;
      const prefFmt = this.memory && typeof this.memory.getEffectivePreference === 'function'
        ? this.memory.getEffectivePreference('presentationFormat', 'standard')
        : 'standard';
      const numItems = (prefFmt === 'numbered' && Array.isArray(plan.listItems) && plan.listItems.length >= 2)
        ? plan.listItems.map((it) => `${it.title}${it.officialUrl ? ` (${it.officialUrl})` : ''}`)
        : undefined;
      const proBar = (activeTask && activeTask.status === 'WAITING_FOR_USER') ? {} : this._maybeBuildProactiveBar(raw);

      this.setAssistantReply(finalSummary);
      if (window.SW_UI) {
        window.SW_UI.setState('speaking');
        window.SW_UI.showCard({
          type: 'answer',
          title: `${plan.targetTopic}: Research & Resources`,
          text: finalSummary,
          numberedItems: numItems,
          sources: plan.recommendedUrls ? plan.recommendedUrls.slice(0, 3) : undefined,
          steps: progressSteps,
          actions: plan.recommendedUrls.slice(0, 2).map((u, idx) => ({
            id: `open_url_${idx}`,
            label: idx === 0 ? `Open ${u.title.split('(')[0].trim().slice(0, 28)}` : 'Alternate Site',
            primary: idx === 0
          })),
          onAction: (id) => {
            const m = String(id).match(/^open_url_(\d+)$/);
            const urlObj = m ? plan.recommendedUrls[Number(m[1])] : null;
            if (urlObj) {
              if (this.dialogue) this.dialogue.pendingPrompt = null;
              this._navigateToExternalUrl(urlObj.url, urlObj.title, plan.targetTopic);
            }
          },
          onSourceClick: (src) => {
            if (src && src.url) this._navigateToExternalUrl(src.url, src.title, plan.targetTopic);
          },
          ...proBar
        });
      }
      if (this.reader) this.reader.readText(finalSummary);

      return {
        status: 'off_page_research',
        topic: plan.targetTopic,
        resolvedQuery: plan.resolvedQuery,
        recommendedUrls: plan.recommendedUrls,
        answer: finalSummary
      };
    }

    /**
     * Handle EXTERNAL_NAVIGATION ("Open the relevant website", "Open its official website", "Open the travel website").
     */
    async _executeExternalNavigation(central, raw, resolvedContext) {
      if (central && central.subAction === 'return_earlier_website' && this.memory) {
        const visited = Array.isArray(this.memory.state.visitedPages) ? this.memory.state.visitedPages : [];
        const curHref = window.location.href;
        const prev = visited.slice().reverse().find((v) => v && v.url && v.url !== curHref);
        if (prev && prev.url) {
          return this._navigateToExternalUrl(prev.url, prev.title || 'Earlier Website', this.memory.state.currentTopic || '');
        }
        if (this.navigator) {
          return this.navigator.historyAction('back', 0.92);
        }
      }

      const navOpts = { followUpSubGoal: (central && central.followUpSubGoal) || '' };
      if (resolvedContext && resolvedContext.resolvedUrlTarget && resolvedContext.resolvedUrlTarget.url) {
        return this._navigateToExternalUrl(
          resolvedContext.resolvedUrlTarget.url,
          resolvedContext.resolvedUrlTarget.title,
          resolvedContext.resolvedEntity || resolvedContext.resolvedTopic || '',
          navOpts
        );
      }

      const task = this.memory && this.memory.state.activeTask;
      let urls = (task && Array.isArray(task.relevantUrls)) ? task.relevantUrls : [];

      if (urls.length === 0) {
        const plan = this.memory.buildOffPageResearchPlan(raw, resolvedContext, {});
        urls = plan.recommendedUrls;
        await this.memory.upsertTask(plan.taskPatch);
      }

      let picked = urls[0] || null;
      if (central.ordinalWord && urls.length > 0) {
        const idxMap = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4 };
        const idx = idxMap[central.ordinalWord];
        if (typeof idx === 'number' && urls[idx]) picked = urls[idx];
      } else if (central.siteKind && urls.length > 1) {
        const matchKind = urls.find((u) =>
          (u.kind && u.kind.includes(central.siteKind)) ||
          (u.title && u.title.toLowerCase().includes(central.siteKind))
        );
        if (matchKind) picked = matchKind;
      }

      if (!picked || !picked.url) {
        if (this.taskPlanner) {
          await this.taskPlanner.recordFailure('Open website', 'No destination URL found in current task context');
        }
        const msg = 'I do not have a recommended website link yet. Ask me a research question first, like "How can I travel to China?".';
        this.setAssistantReply(msg);
        if (window.SW_UI) window.SW_UI.showCard({ type: 'answer', title: 'No Website Selected', text: msg });
        if (this.reader) this.reader.readText(msg);
        return { status: 'no_external_url', message: msg };
      }

      return this._navigateToExternalUrl(
        picked.url,
        picked.title,
        (resolvedContext && resolvedContext.resolvedTopic) || (task && task.topic) || '',
        navOpts
      );
    }

    async _navigateToExternalUrl(targetUrl, title = '', topic = '', navOpts = {}) {
      const validation = this.navigator && typeof this.navigator.validateNavigationUrl === 'function'
        ? this.navigator.validateNavigationUrl(targetUrl, document)
        : { valid: Boolean(targetUrl), url: targetUrl };

      if (!validation.valid) {
        if (this.taskPlanner) {
          await this.taskPlanner.recordFailure(`Open ${title || targetUrl}`, validation.reason || 'Invalid or unreachable destination URL', targetUrl);
        }
        const errMsg = `Could not navigate to ${title || 'that URL'}: ${validation.reason || 'unavailable'}. Your task is saved — try another option or say "Go back".`;
        this.setAssistantReply(errMsg);
        if (window.SW_UI) {
          window.SW_UI.setState('error');
          window.SW_UI.showCard({
            type: 'answer',
            title: 'Navigation Blocked — Recovering',
            text: errMsg,
            steps: this.taskPlanner && this.memory && this.memory.state.activeTask ? this.taskPlanner.buildProgressCardSteps(this.memory.state.activeTask) : undefined
          });
        }
        if (this.reader) this.reader.readText(errMsg);
        return { status: 'navigation_failed', reason: validation.reason, url: targetUrl, message: errMsg };
      }

      const finalUrl = validation.url || targetUrl;

      // Action permission check: moderate-risk external navigation requires confirmation unless explicitly authorized by user command
      const sameOrigin = typeof window !== 'undefined' && window.location && validation.origin && validation.origin === window.location.origin;
      const explicitlyAuthorized = navOpts.userAuthorized !== false && (!navOpts.requireConfirm);
      if (!sameOrigin && !explicitlyAuthorized && this.confirm) {
        return new Promise((resolve) => {
          this.confirm.request({
            id: `ext_nav_${Date.now()}`,
            risk: 'high',
            confidence: 0.9,
            title: 'Authorize External Navigation',
            message: `This action leaves the current site to open ${title || finalUrl}. Allow Sleepwalker to open it?`,
            summary: [`Destination: ${finalUrl}`, `Current site: ${(window.location && window.location.origin) || ''}`],
            onConfirm: async () => {
              resolve(await this._navigateToExternalUrl(finalUrl, title, topic, { ...navOpts, userAuthorized: true, requireConfirm: false }));
            },
            onCancel: () => {
              resolve({ status: 'navigation_cancelled', url: finalUrl });
            }
          });
        });
      }

      this._setStatusChip(`Executing: Opening ${title || finalUrl}...`);
      if (this.memory) {
        await this.memory.setSessionMode('active_listening', { skipSave: true });
        this.memory.state.pendingActions = [
          ...(this.memory.state.pendingActions || []).filter((p) => p && p.type !== 'post_navigation_announce' && p.type !== 'verify_navigation_and_continue'),
          {
            type: 'verify_navigation_and_continue',
            url: finalUrl,
            title,
            topic,
            followUpSubGoal: navOpts.followUpSubGoal || '',
            createdAt: Date.now()
          }
        ];
        await this.memory.upsertTask({
          currentStep: 'navigating_to_external_website',
          completedStep: `Dispatched navigation to ${title || finalUrl}`,
          nextRecommendedAction: `Verify ${title || 'destination'} loads and continue workflow`
        });
      }

      const msg = `Opening ${title || finalUrl}...`;
      this.setAssistantReply(msg);
      if (window.SW_UI) {
        window.SW_UI.showCard({
          type: 'answer',
          title: 'Opening Website',
          text: msg,
          steps: this.taskPlanner && this.memory && this.memory.state.activeTask ? this.taskPlanner.buildProgressCardSteps(this.memory.state.activeTask) : undefined
        });
      }

      if (this.useStagehandAdapter && this.stagehandAdapter && navOpts.bypassStagehand !== true) {
        let expectedHost = '';
        try { expectedHost = new URL(finalUrl).hostname; } catch (_e) {}
        const shRes = await this.stagehandAdapter.act('navigate', null, finalUrl, {
          commandId: navOpts.cmdId || `sw-nav-${Date.now().toString(36)}`,
          signal: navOpts.taskSignal || null,
          verifyAfter: expectedHost ? { urlContains: expectedHost } : null
        });
        if (shRes && shRes.ok && shRes.result) {
          const actualUrl = shRes.result.urlAfter || finalUrl;
          const verOk = shRes.verification ? Boolean(shRes.verification.verified) : Boolean(expectedHost ? actualUrl.toLowerCase().includes(expectedHost.toLowerCase()) : true);
          return {
            status: verOk ? 'navigated' : 'verification_failed',
            ok: verOk,
            verified: verOk,
            engine: 'stagehand_adapter',
            stagehandVersion: shRes.stagehandVersion || null,
            url: actualUrl,
            title: shRes.result.titleAfter || title,
            verification: shRes.verification || null,
            ownership: shRes.ownershipDuringOp || null,
            message: verOk ? `Navigated to ${actualUrl}` : `Navigation URL mismatch: ${actualUrl}`
          };
        }
        return {
          status: (shRes && shRes.code === 'CANCELLED') ? 'task_cancelled' : 'stagehand_disconnected',
          ok: false,
          verified: false,
          recoverable: true,
          engine: 'stagehand_adapter',
          code: (shRes && shRes.code) || 'STAGEHAND_UNAVAILABLE',
          error: (shRes && shRes.error) || 'Stagehand sidecar unavailable',
          url: window.location.href,
          message: `Stagehand navigation unavailable: ${(shRes && shRes.error) || 'disconnected'}`
        };
      }

      setTimeout(() => {
        try {
          window.location.assign(finalUrl);
        } catch (_e) {
          window.location.href = finalUrl;
        }
      }, 150);

      return { status: 'navigating_external', url: finalUrl, title, message: msg, engine: this._getSelectedBackend() };
    }

    /**
     * Handle MULTI_STEP_TASK ("Compare the second one with this", "Help me plan a trip to Japan", "Help me book flights...").
     */
    async _executeMultiStepTask(central, raw, resolvedContext) {
      const lower = String(raw || '').toLowerCase();
      const requiresSafetyConfirm = /\b(?:book|pay|payment|checkout|purchase|buy\s+now|submit\s+application|confirm\s+booking)\b/i.test(lower);

      // Travel planning / multi-step planning requests without immediate payment/submission -> route cleanly to structured planner + research
      if (!requiresSafetyConfirm && !/\bcompare\b/i.test(lower) && /\b(?:help\s+me\s+plan|plan\s+(?:a\s+)?(?:trip|vacation|journey)\s+to|help\s+me\s+apply|apply\s+(?:for|to)\s+(?:a\s+)?master'?s|master'?s\s+degree\s+abroad)\b/i.test(lower)) {
        return this._executeOffPageResearch(raw, resolvedContext, central, this.explainer && this.explainer.getPageDigest ? this.explainer.getPageDigest() : {});
      }

      if (requiresSafetyConfirm && this.confirm) {
        return new Promise((resolve) => {
          this.confirm.request({
            id: `task_safety_${Date.now()}`,
            risk: 'critical',
            confidence: 0.9,
            title: 'Confirm Consequential Action',
            message: `This involves a booking, payment, or submission ("${raw}"). Should I help prepare the steps first without completing any payment or submission?`,
            summary: [`Request: ${raw}`],
            onConfirm: async () => {
              if (this.taskPlanner) {
                await this.taskPlanner.startOrUpdateTaskFromPlan(raw, resolvedContext, { status: 'WAITING_FOR_USER' });
              }
              await this.memory.upsertTask({
                currentStep: 'preparing_safe_steps',
                userDecision: 'Approved preparation only (no auto-payment/submission)'
              });
              const msg = 'Confirmed. I will prepare the details safely and ask for your explicit approval before any booking or submission.';
              this.setAssistantReply(msg);
              if (window.SW_UI) {
                window.SW_UI.showCard({
                  type: 'answer',
                  title: 'Safe Step Plan',
                  text: msg,
                  steps: this.taskPlanner ? this.taskPlanner.buildProgressCardSteps(this.memory.state.activeTask) : undefined
                });
              }
              if (this.reader) this.reader.readText(msg);
              resolve({ status: 'task_prepared', message: msg });
            },
            onCancel: async () => {
              if (this.memory && this.memory.state.activeTask) {
                await this.memory.upsertTask({ userDecision: 'Declined booking/payment action' });
              }
              resolve({ status: 'task_cancelled', message: 'Cancelled booking/payment action.' });
            }
          });
        });
      }

      // Item & specification comparison ("Compare the second one with the first one", "Compare specifications", "Compare their admission requirements")
      let items = (this.memory && this.memory.state.currentEntities && this.memory.state.currentEntities.listItems) || [];
      if (items.length < 2 && this.navigator && typeof this.navigator.extractPageResults === 'function') {
        const domRes = this.navigator.extractPageResults(document);
        if (domRes.length >= 2) {
          items = domRes.map(({ element, ...clean }) => clean);
          if (this.memory) this.memory.state.currentEntities.listItems = items;
        }
      }
      const resolvedPair = (resolvedContext && Array.isArray(resolvedContext.resolvedListItems))
        ? resolvedContext.resolvedListItems
        : [];
      const pickedItem = resolvedContext && resolvedContext.resolvedListItem;
      const currentTitle = document.title.split(/[-|]/)[0].trim();

      let msg = '';
      if (resolvedPair.length >= 2) {
        const a = resolvedPair[0].item;
        const b = resolvedPair[1].item;
        const aDetail = a.specs || a.summary || `${a.title} (item ${a.index})`;
        const bDetail = b.specs || b.summary || `${b.title} (item ${b.index})`;
        msg = `Comparing "${a.title}" and "${b.title}": ${a.title}: ${aDetail} versus ${b.title}: ${bDetail}`;
      } else if (/\badmission\s+requirements\b/i.test(lower) && items.length >= 2) {
        msg = `Comparing admission requirements across ${items.slice(0, 3).map((i) => i.title).join(', ')}: ` +
          items.slice(0, 3).map((i) => `${i.title}: ${i.summary || i.specs || 'check official admission requirements directly.'}`).join(' | ');
      } else if (/\b(?:specs|specifications|certifications)\b/i.test(lower) && items.length >= 2) {
        msg = `Comparing specifications across ${items.slice(0, 3).map((i) => i.title).join(', ')}: ` +
          items.slice(0, 3).map((i) => `${i.title}: ${i.specs || i.summary || 'verify official specifications.'}`).join(' | ');
      } else if (pickedItem) {
        msg = `Comparing "${pickedItem.title}" with current item "${currentTitle}": "${pickedItem.title}" was selected from your list${(pickedItem.specs || pickedItem.summary) ? ` (${pickedItem.specs || pickedItem.summary})` : ''}, while "${currentTitle}" is open right now.`;
      } else if (items.length >= 2) {
        msg = `Comparing "${items[1].title}" with "${items[0].title}": ` +
          `${items[1].specs || items[1].summary || items[1].title} versus ${items[0].specs || items[0].summary || items[0].title}.`;
      } else {
        msg = `I resolved your comparison request ("${resolvedContext.resolvedText || raw}"). Tell me which two items or criteria you want compared.`;
      }

      const pi = window.SleepwalkerPersonalIntel || null;
      const prefFmt = this.memory && typeof this.memory.getEffectivePreference === 'function'
        ? this.memory.getEffectivePreference('presentationFormat', 'standard')
        : 'standard';
      const wantsTable = central.format === 'table' || prefFmt === 'table';
      const isDecisionReq = central.subAction === 'decision_support';

      if (this.taskPlanner && this.memory && this.memory.state.activeTask && Array.isArray(this.memory.state.activeTask.plannedSteps) && this.memory.state.activeTask.plannedSteps.length > 0) {
        await this.taskPlanner.markStepCompleted(/compare/i, msg);
      } else {
        await this.memory.upsertTask({
          objective: `Compare ${resolvedPair.length >= 2 ? `${resolvedPair[0].item.title} vs ${resolvedPair[1].item.title}` : (pickedItem ? pickedItem.title : (resolvedContext.resolvedTopic || 'items'))}`,
          currentStep: 'comparison_completed',
          completedStep: 'Compared options'
        });
      }

      const decisionSpec = (pi && items.length >= 2 && (isDecisionReq || wantsTable || prefFmt === 'numbered'))
        ? pi.buildDecisionComparison(
            resolvedPair.length >= 2 ? resolvedPair.map((p) => p.item) : items,
            this.memory ? this.memory.state : {},
            { format: wantsTable ? 'table' : prefFmt, preferTable: wantsTable }
          )
        : null;
      const finalMsg = decisionSpec ? decisionSpec.text : msg;
      const proBar = this._maybeBuildProactiveBar(raw);

      this.setAssistantReply(finalMsg);
      if (window.SW_UI) {
        window.SW_UI.setState('speaking');
        window.SW_UI.showCard({
          type: 'answer',
          title: isDecisionReq ? 'Decision Support' : 'Comparison',
          text: finalMsg,
          table: decisionSpec ? decisionSpec.table : undefined,
          numberedItems: decisionSpec ? decisionSpec.numberedItems : undefined,
          warning: decisionSpec ? decisionSpec.warning : undefined,
          sources: decisionSpec ? decisionSpec.sources : undefined,
          steps: this.taskPlanner && this.memory && this.memory.state.activeTask ? this.taskPlanner.buildProgressCardSteps(this.memory.state.activeTask) : undefined,
          onSourceClick: (src) => {
            if (src && src.url) this._navigateToExternalUrl(src.url, src.title, (resolvedContext && resolvedContext.resolvedTopic) || '');
          },
          ...proBar
        });
      }
      if (this.reader) this.reader.readText(finalMsg);
      return {
        status: isDecisionReq ? 'decision_support' : 'compared',
        answer: finalMsg,
        table: decisionSpec ? decisionSpec.table : null,
        proactiveSuggestion: proBar.proactiveSuggestion || null
      };
    }

    _syncStructuredPageContext(doc = document) {
      const priv = this.memory && this.memory.privacy;
      if (priv && priv.disablePageAnalysis) return null;
      const digestApi = window.SleepwalkerDigest || null;
      if (!digestApi || typeof digestApi.buildStructuredPageContext !== 'function') return null;
      const ctx = digestApi.buildStructuredPageContext(doc);
      if (this.memory && ctx && Array.isArray(ctx.videos) && ctx.videos.length > 0 && typeof this.memory.registerCandidateList === 'function') {
        const curList = this.memory.getActiveCandidateList ? this.memory.getActiveCandidateList({ urlClean: ctx.urlClean }) : null;
        if (!curList || curList.kind !== 'youtube_videos' || curList.candidates.length !== ctx.videos.length) {
          this.memory.registerCandidateList('youtube_videos', ctx.videos, { urlClean: ctx.urlClean });
        }
      }
      return ctx;
    }

    _isTrivialFastPath(raw, navChoiceCount = 0) {
      if (this.fastRouter) {
        const routed = this.fastRouter.classify(raw, {
          navChoiceCount,
          hasPendingPrompt: Boolean(this.confirm && this.confirm.isAwaiting())
        });
        if (routed && routed.path === 'A') return true;
        if (routed && routed.reason === 'contextual_scroll_target') return false;
      }
      const s = String(raw || '').trim().replace(/[।.,!?]+$/g, '').trim().toLowerCase();
      if (!s) return true;
      if (/^(?:yes|yeah|yep|no|nope|ok|okay|haan|nahi)$/i.test(s)) return true;
      if (navChoiceCount > 0 && /^(?:[1-5]|first|second|third|fourth|fifth|one|two|three|four|five)$/i.test(s)) return true;
      if (/^(?:stop|stop\s+reading|resume|repeat|read\s+again|slower|faster|rest|sleep|wake\s+up|help|outline|read\s+this\s+page)$/i.test(s)) {
        return true;
      }
      if (/^(?:pause|play)(?:\s+(?:reading|tts|speech))?$/i.test(s) && !(document && document.querySelector && document.querySelector('video'))) {
        return true;
      }
      if (/^(?:scroll\s+(?:up|down|top|bottom|left|right)|go\s+(?:back|forward)|refresh(?:\s+page)?|reload(?:\s+page)?|next\s+page|previous\s+page)$/i.test(s)) {
        return true;
      }
      return false;
    }

    _onAgentStateChange(state, entry) {
      this.lastAgentState = state;
      if (this.diagnostics) {
        this.diagnostics.log('agent_fsm', 'transition', { from: entry.from, to: state, reason: entry.reason });
      }
    }

    getNavigationMetrics() {
      return window.__SW_LAST_TURN_METRICS__ || (this.agentFsm && this.agentFsm.currentTurn ? this.agentFsm.currentTurn.metrics : null);
    }

    async _executeFastPathAction(fastAction, raw, requestId, turnStart) {
      if (!fastAction || !fastAction.type) return null;
      const tExec0 = performance.now();
      if (this.agentFsm) this.agentFsm.transition('EXECUTING', { requestId, reason: `fast_${fastAction.type}` });
      let res = null;
      const doc = document;

      if (fastAction.type === 'scroll' && (this.navigator || this.browserEngine)) {
        if (this.browserEngine && this.useRebuiltBrowserEngine && typeof this.browserEngine.scroll === 'function') {
          const sT0 = performance.now();
          const beScroll = this.browserEngine.scroll(fastAction.dir || 'down', { amount: fastAction.amount || 'page', behavior: 'instant' });
          this._recordRolloutEvent({ action: 'scroll', engine: 'rebuilt_browser_engine', outcome: beScroll.verified ? 'success' : 'fallback', latencyMs: performance.now() - sT0 });
          if (beScroll && beScroll.verified) {
            res = { status: 'fast_scrolled', dir: fastAction.dir, verified: true, engine: 'rebuilt_browser_engine', path: 'A', usedLlm: false, beforeY: beScroll.beforeY, afterY: beScroll.afterY };
          }
        }
        if (!res && this.navigator) {
          const before = this.actionVerifier ? this.actionVerifier.captureState(doc) : null;
          this.navigator.scroll(fastAction.dir || 'down', 0.99, { amount: fastAction.amount || 'page', skipConfirm: true, behavior: 'auto' });
          const after = this.actionVerifier ? this.actionVerifier.captureState(doc) : null;
          const ver = this.actionVerifier ? this.actionVerifier.verify('scroll', before, after, null, { dir: fastAction.dir }) : { verified: true };
          res = { status: 'fast_scrolled', dir: fastAction.dir, verified: ver.verified, path: 'A', usedLlm: false, changeReport: ver.changeReport || null };
        }
      } else if (fastAction.type === 'history' && this.navigator) {
        await this.navigator.historyAction(fastAction.dir || 'back', 0.99, { fastPath: true, skipConfirm: true });
        res = { status: `fast_history_${fastAction.dir}`, dir: fastAction.dir, verified: true, path: 'A', usedLlm: false };
      } else if (['tab_new', 'tab_close', 'tab_step', 'tab_switch', 'open_url'].includes(fastAction.type)) {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
          const swRes = await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage({ type: 'SLEEPWALKER_TAB_ACTION', action: fastAction }, (r) => {
                void chrome.runtime?.lastError;
                resolve(r || { ok: false, error: 'Tab action failed.' });
              });
            } catch (err) {
              resolve({ ok: false, error: err && err.message });
            }
          });
          const msg = swRes.ok
            ? (fastAction.type === 'tab_new' ? 'Opened a new tab.'
              : (fastAction.type === 'tab_close' ? 'Closed current tab.'
                : (fastAction.type === 'open_url' ? `Opening ${fastAction.url}`
                  : `Switched to "${swRes.title || swRes.url || 'tab'}".`)))
            : (swRes.error || 'Could not complete tab action.');
          this.setAssistantReply(msg);
          if (window.SW_UI) window.SW_UI.showCard({ type: swRes.ok ? 'answer' : 'error', title: 'Tab Navigation', text: msg });
          res = { status: swRes.ok ? `fast_${fastAction.type}` : 'tab_action_failed', ...swRes, path: 'A', usedLlm: false, message: msg };
        }
      } else if (fastAction.type === 'press_escape') {
        if (this.elementSelector && typeof this.elementSelector.clearCandidateOverlay === 'function') this.elementSelector.clearCandidateOverlay(doc);
        if (this.navigator && typeof this.navigator.clearCandidateOverlay === 'function') this.navigator.clearCandidateOverlay(doc);
        if (this.confirm && this.confirm.isAwaiting()) this.confirm.cancel('escape_key');
        const tgt = doc.activeElement || doc.body || doc;
        try {
          if (typeof KeyboardEvent === 'function' && typeof tgt.dispatchEvent === 'function') {
            tgt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
          }
        } catch (_e) {}
        this._notifySafe && this._notifySafe('Pressed Escape.');
        res = { status: 'fast_escape', verified: true, path: 'A', usedLlm: false };
      } else if (fastAction.type === 'stop_scroll') {
        if (this.waitManager) this.waitManager.stopCurrentScroll(window);
        if (this.navigator && typeof this.navigator.cancelPendingHighlight === 'function') this.navigator.cancelPendingHighlight();
        res = { status: 'fast_stop_scroll', verified: true, path: 'A', usedLlm: false };
      } else if (fastAction.type === 'stop_action') {
        if (this.agentFsm) this.agentFsm.cancelCurrentTurn('user_stop_action');
        if (this.waitManager) this.waitManager.stopCurrentScroll(window);
        if (this.elementSelector && typeof this.elementSelector.clearCandidateOverlay === 'function') this.elementSelector.clearCandidateOverlay(doc);
        if (this.navigator) {
          this.navigator.clearCandidateOverlay(doc);
          this.navigator.cancelPendingHighlight();
        }
        this.stopReading && this.stopReading();
        res = { status: 'fast_stop_action', verified: true, path: 'A', usedLlm: false };
      }

      if (!res) return null;
      if (res && res.verified && window.SW_UI) {
        if (fastAction.type === 'scroll') {
          window.SW_UI.showCard({
            type: 'answer',
            title: 'Scroll',
            text: `Scrolled ${fastAction.dir || 'down'}.`,
            reqId: requestId
          });
        }
      }
      const execMs = Math.round((performance.now() - tExec0) * 100) / 100;
      const totalMs = Math.round((performance.now() - turnStart) * 100) / 100;
      if (this.agentFsm) {
        this.agentFsm.recordStageTiming(requestId, 'execution', execMs);
        this.agentFsm.recordStageTiming(requestId, 'verification', 0);
        const metrics = this.agentFsm.finishTurn(requestId, 'IDLE', { status: res.status });
        if (metrics) window.__SW_LAST_TURN_METRICS__ = metrics;
      }
      if (this.diagnostics) {
        this.diagnostics.recordTurnTrace({
          cmdId: requestId,
          intent: `FAST_${fastAction.type.toUpperCase()}`,
          centralCategory: 'PAGE_NAVIGATION',
          totalMs,
          usedLlm: false,
          status: res.status
        });
      }
      return res;
    }

    async _requestVisualGroundFallback(rawQuery, reason = 'dom_missing_or_covered', wmInv = null) {
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        return { status: 'vision_unavailable', usedVision: false, grounding: null };
      }
      const candidatesSummary = (this.worldModel && wmInv && typeof this.worldModel.buildReasonerContext === 'function')
        ? this.worldModel.buildReasonerContext(rawQuery, { inventory: wmInv, maxTokens: 280 }).text
        : '';
      const reply = await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve({ status: 'vision_timeout', usedVision: false }); } }, 9000);
        chrome.runtime.sendMessage({
          type: 'SLEEPWALKER_VISUAL_GROUND_REQUEST',
          payload: { query: rawQuery, reason, candidatesSummary }
        }, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          void chrome.runtime?.lastError;
          resolve(res || { status: 'vision_unavailable', usedVision: false });
        });
      });

      // Strictly validate visually grounded coordinates/target against live DOM before acting
      if (reply && reply.status === 'ok' && reply.grounding) {
        const currentInventory = (this.worldModel && wmInv && typeof this.worldModel.observeTab === 'function')
          ? await this.worldModel.observeTab(document, { force: true, tabId: wmInv.tabId })
          : null;
        if (!wmInv || !wmInv.navigationIdentity || !currentInventory || currentInventory.navigationIdentity !== wmInv.navigationIdentity) {
          return { ...reply, status: 'stale_navigation', validatedElement: null };
        }
        const g = reply.grounding;
        let domTarget = null;
        if (g.candidate_id && this.worldModel) {
          const chk = this.worldModel.resolveAndValidateCandidate(g.candidate_id, wmInv && wmInv.tabId, { expectedNavigationIdentity: wmInv && wmInv.navigationIdentity });
          if (chk && chk.ok && chk.element) domTarget = chk.element;
        }
        if (!domTarget && typeof g.normalized_x === 'number' && typeof g.normalized_y === 'number' && typeof document.elementsFromPoint === 'function') {
          const px = Math.round((g.normalized_x / 1000) * (window.innerWidth || 1280));
          const py = Math.round((g.normalized_y / 1000) * (window.innerHeight || 768));
          const hitStack = document.elementsFromPoint(px, py) || [];
          domTarget = hitStack.find((n) => n && !(this.navEngine && this.navEngine.isSleepwalkerUiNode(n))) || null;
        }
        return { ...reply, validatedElement: domTarget };
      }
      return reply;
    }

    _shouldUseNeuralEmbeddings(queryText, wmInv, resolvedContext, structuredCtx) {
      const q = String(queryText || '').toLowerCase();
      if (!q || !wmInv) return false;
      if (resolvedContext && resolvedContext.resolvedSimilarTo) return true;
      const isFeed = Boolean((structuredCtx && /^youtube_(?:search|feed)$/i.test(structuredCtx.pageType || '')) || (wmInv.discoveryMode === 'progressive_feed'));
      if (isFeed) {
        // Pure positional feed commands ("open 2nd video") don't need neural embedding calls
        if (/^(?:open|play|select|pick|click)\s+(?:the\s+)?(?:\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|\w+teenth)\s+(?:video|item|result|one)\b/i.test(q)) {
          return false;
        }
        return true;
      }
      if (/\b(?:where\s+(?:they|do\s+they)|explain(?:ing|s)?|discuss(?:ing|es)?|advantages|benefits|tutorial|beginner|how\s+.+?\s+learn|like\s+this|similar|find\s+another)\b/i.test(q)) {
        return true;
      }
      const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'under', 'inside', 'below', 'section', 'option', 'open', 'select', 'choose', 'click', 'link', 'article', 'go', 'take']);
      const toks = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !stop.has(t));
      if (toks.length === 0) return false;
      const pool = [...(wmInv.sections || []), ...(wmInv.options || []), ...(wmInv.links || []), ...(wmInv.buttons || [])];
      const hasLexHit = toks.some((t) => pool.some((e) => e && String(e.label || '').toLowerCase().includes(t)));
      return !hasLexHit;
    }

    _needsRichNluUnderstanding(raw, resolvedContext, preCentral, syncRule, structuredCtx, navChoiceCount = 0, wmInv = null) {
      if (this.memory && this.memory.privacy && this.memory.privacy.disablePageAnalysis) return false;
      if (this._isTrivialFastPath(raw, navChoiceCount)) return false;

      const lower = String(raw || '').toLowerCase();
      const C = this.memory ? this.memory.CENTRAL_INTENTS : {};
      // Preserve explicit Phase 2-5 multi-step, off-page research, reminder, privacy, and form workflows unless explicitly media/table/section/world-model scoped
      if (preCentral && [C.OFF_PAGE_RESEARCH, C.CONVERSATION_CONTROL, C.MULTI_STEP_TASK].includes(preCentral.category)) {
        return false;
      }
      if (preCentral && preCentral.category === C.PAGE_SUMMARIZATION && !/\b(?:first\s+\d+\s*min(?:ute)?s?|video|transcript|under\s+|inside\s+)\b/i.test(lower)) {
        return false;
      }
      if (/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:go\s+(?:back\s+)?to|return\s+to|back\s+to|scroll\s+to|jump\s+to)\s+(?:the\s+)?(?:previous|last|earlier)\s+section\b/i.test(lower) &&
          Boolean((resolvedContext && resolvedContext.resolvedSection) || (this.memory && this.memory.state && this.memory.state.selectionState && this.memory.state.selectionState.previousSection))) {
        return false;
      }
      if (preCentral && preCentral.category === C.PAGE_NAVIGATION && preCentral.subAction === 'navigate_section' && preCentral.sectionTarget &&
          wmInv && Array.isArray(wmInv.sections) &&
          !/\b(?:where|previous|earlier|last|explain|discussing|article|link|under|inside|first|second|third|fourth|fifth|subsection)\b/i.test(lower)) {
        const secTok = String(preCentral.sectionTarget || '').trim().toLowerCase();
        if (secTok && wmInv.sections.some((s) => s && s.label && s.label.toLowerCase().includes(secTok))) {
          return false;
        }
      }
      if (preCentral && preCentral.category === C.PAGE_SEARCH && (
        ['apply_filter', 'search_within_page', 'in_website_search', 'site_search', 'global_site_search'].includes(preCentral.subAction) ||
        (syncRule && syncRule.intent === 'SEARCH' && (syncRule.confidence || 0) >= 0.85)
      )) {
        if (!/\b(?:under\s+|inside\s+|in\s+the\s+table|table|subsection)\b/i.test(lower)) {
          return false;
        }
      }
      if (preCentral && preCentral.category === C.EXTERNAL_NAVIGATION && !/\b(?:docs|documentation)\b/i.test(lower)) {
        return false;
      }
      if (preCentral && preCentral.category === C.FORM_ASSISTANCE) {
        if (preCentral.subAction === 'element_select' && this.worldModel && wmInv) {
          const sTrim = String(raw || '').trim();
          const scopedM = sTrim.match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:select|choose|pick|click(?:\s+on)?|open)\s+(?:the\s+)?(.+?)\s+(?:under|inside|below|in\s+the)\s+(?:the\s+)?(.+?)(?:\s+(?:section|heading|list|card))?$/i);
          const qLbl = (scopedM ? scopedM[1] : sTrim.replace(/^(?:please\s+)?(?:select|choose|pick)\s+(?:the\s+)?/i, '')).replace(/\s+(?:option|link)$/i, '').trim().toLowerCase();
          const qSec = scopedM ? scopedM[2].trim() : '';
          const hasOpt = qLbl && this.worldModel.findOptionByHierarchy ? Boolean(this.worldModel.findOptionByHierarchy(qLbl, qSec)) : false;
          const hasLink = Boolean(qLbl && Array.isArray(wmInv.links) && wmInv.links.some((l) => l && l.label && l.label.toLowerCase().includes(qLbl)));
          if (!hasOpt && hasLink) return true;
        }
        return false;
      }
      const focusedExt = resolvedContext && resolvedContext.resolvedListItem;
      const isoCtx = resolvedContext && resolvedContext.isolatedEntityContext;
      const isFeedOrVideoPick = Boolean(
        (wmInv && wmInv.discoveryMode === 'progressive_feed') ||
        (structuredCtx && /^youtube_(?:search|feed)$/i.test(structuredCtx.pageType || '')) ||
        /\b(?:find|open|play|watch|select|choose)\b.*\bvideos?\b/i.test(lower)
      );
      if (
        (resolvedContext && (resolvedContext.crossTabCompare || resolvedContext.resolvedTabMatch)) ||
        (!isFeedOrVideoPick && isoCtx && isoCtx.entity && (isoCtx.entity.facts.length > 0 || isoCtx.entity.fees || isoCtx.entity.deadlines || isoCtx.entity.requirements)) ||
        (!isFeedOrVideoPick && focusedExt && focusedExt.entityType !== 'video' &&
          !/\b(?:not\s+that|i\s+meant|instead|another\s+one|like\s+this|find\s+another)\b/i.test(lower) &&
          ((focusedExt.entityType && focusedExt.summary) || (Array.isArray(focusedExt.tabFacts) && focusedExt.tabFacts.length > 0)))
      ) {
        return false;
      }

      const isFeedOrd = Boolean(wmInv && wmInv.discoveryMode === 'progressive_feed' && /\b\d+(?:st|nd|rd|th)?\s*(?:video|item|one|result)\b/i.test(lower));
      const hasRichCues = Boolean(
        isFeedOrd
        || /\b(?:video|videos|channel|speaker|captions?|transcript|first\s+\d+\s*min(?:ute)?s?|first\s+five\s+minutes|play|pause|unmute|mute|seek|under\s+|inside\s+|in\s+the\s+table|table|subsection|paragraph\s+(?:below|under)|previous\s+section|where\s+they\s+explain|learn\s+how|beginner|official|docs|documentation|tutorial|shorter|longer|previous\s+video|other\s+one|other\s+channel|same\s+channel|like\s+this|another\s+one|not\s+that|i\s+meant|instead|find\s+another)\b/i.test(lower)
        || (structuredCtx && /^(?:youtube_watch|youtube_search|youtube_feed|wikipedia)$/i.test(structuredCtx.pageType || '') && !/^(?:read\s+this\s+page|outline)$/i.test(lower))
        || (resolvedContext && (resolvedContext.resolvedCandidate || resolvedContext.resolvedChannel || resolvedContext.resolvedSection || resolvedContext.resolvedSimilarTo))
        || (!syncRule || (syncRule.confidence || 0) < 0.78)
      );
      return hasRichCues;
    }

    async _requestOllamaNluPlan(raw, resolvedContext, structuredCtx, wmInv = null, semanticMatches = [], extraOpts = {}) {
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        return null;
      }
      const digestApi = window.SleepwalkerDigest || null;
      const sel = (this.memory && this.memory.state && this.memory.state.selectionState) || {};
      const preferredSections = [
        sel.activeSection,
        sel.previousSection,
        resolvedContext && resolvedContext.resolvedSection
      ].filter(Boolean);
      const learnedSkillsList = Array.isArray(extraOpts.learnedSkills) ? extraOpts.learnedSkills : [];
      const tokenBudget = extraOpts.forcePrimary ? 760 : 480;
      const reasonerCtx = (this.worldModel && wmInv && typeof this.worldModel.buildReasonerContext === 'function')
        ? this.worldModel.buildReasonerContext(resolvedContext?.resolvedText || raw, {
          inventory: wmInv,
          semanticMatches,
          preferredSections,
          learnedSkills: learnedSkillsList,
          maxTokens: tokenBudget
        })
        : null;
      const digestText = (reasonerCtx && reasonerCtx.text)
        || ((structuredCtx && digestApi && typeof digestApi.formatStructuredContextForNlu === 'function')
          ? digestApi.formatStructuredContextForNlu(structuredCtx, { maxTokens: tokenBudget })
          : '');
      const selSummary = [
        sel.currentSelection ? `current=${sel.currentSelection.id}:${sel.currentSelection.title}` : '',
        sel.activeVideo ? `video=${sel.activeVideo.title}` : '',
        sel.activeSection ? `section=${sel.activeSection}` : '',
        sel.previousSection ? `prevSection=${sel.previousSection}` : ''
      ].filter(Boolean).join('; ');

      const payload = {
        utterance: raw,
        resolvedText: (resolvedContext && resolvedContext.resolvedText) || raw,
        url: (typeof window !== 'undefined' && window.location && window.location.href) || '',
        website: (typeof window !== 'undefined' && window.location && window.location.hostname) || '',
        pageContext: structuredCtx || { title: document.title, pageType: 'general' },
        structuredDigestText: digestText,
        worldModelDigestText: reasonerCtx ? reasonerCtx.text : '',
        candidateIds: reasonerCtx ? Array.from(reasonerCtx.validIds) : [],
        learnedSkills: learnedSkillsList.slice(0, 3).map((h) => {
          const sk = (h && h.skill) || h || {};
          return {
            id: sk.id || '',
            name: sk.name || '',
            steps: Array.isArray(sk.steps) ? sk.steps.slice(0, 6).map((s) => `${s.action}:${s.label || s.role || ''}`) : [],
            score: h && h.score ? h.score : 0
          };
        }),
        forcePrimary: Boolean(extraOpts.forcePrimary),
        tabId: (wmInv && wmInv.tabId) || (this.memory && this.memory.tabId) || 'default',
        inventoryVersion: (wmInv && wmInv.inventoryVersion) || 0,
        navigationIdentity: (wmInv && wmInv.navigationIdentity) || '',
        taskId: (this.taskLifecycle && this.taskLifecycle.activeTaskId) ? String(this.taskLifecycle.activeTaskId) : '',
        maxContextTokens: tokenBudget,
        timeoutMs: 4500,
        selectionSummary: selSummary,
        relevantMemories: (resolvedContext && Array.isArray(resolvedContext.relevantMemories))
          ? resolvedContext.relevantMemories.slice(0, 3).map((m) => `${m.activity?.topic || ''}: ${m.activity?.user_command || ''}`)
          : [],
        recentTurns: (this.dialogue && Array.isArray(this.dialogue.turns) ? this.dialogue.turns.slice(-3) : [])
      };

      try {
        return await new Promise((resolve) => {
          let finished = false;
          const timer = setTimeout(() => {
            if (!finished) { finished = true; resolve({ status: 'timeout', message: 'NLU plan request timed out after 5.0s.', _sentDigestText: digestText, _sentCandidateIds: payload.candidateIds }); }
          }, 5000);
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_NLU_PLAN_REQUEST', payload }, (res) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            const result = chrome.runtime.lastError ? { status: 'ollama_unavailable', message: chrome.runtime.lastError.message } : res;
            resolve(result && typeof result === 'object'
              ? { ...result, candidateNavigationIdentity: payload.navigationIdentity || '', _sentDigestText: digestText, _sentCandidateIds: payload.candidateIds }
              : result);
          });
        });
      } catch (_e) {
        return { status: 'generation_failed', message: (_e && _e.message) || 'NLU runtime call failed.', _sentDigestText: digestText, _sentCandidateIds: payload.candidateIds };
      }
    }

    async _escalateToOllamaPrimary(raw, qwenReply, failureInfo = {}, ctxBundle = {}) {
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        return null;
      }
      const wmInv = ctxBundle.wmInv || (this.worldModel ? this.worldModel.getTabInventory() : null);
      const hierarchicalMap = (this.worldModel && wmInv && typeof this.worldModel.getHierarchicalMapSummary === 'function')
        ? this.worldModel.getHierarchicalMapSummary(wmInv)
        : '';
      let worldDigest = ctxBundle.worldModelDigestText || '';
      if (!worldDigest && this.worldModel && wmInv && typeof this.worldModel.buildReasonerContext === 'function') {
        const rc = this.worldModel.buildReasonerContext((ctxBundle.resolvedContext && ctxBundle.resolvedContext.resolvedText) || raw, {
          inventory: wmInv,
          semanticMatches: ctxBundle.semanticMatches || [],
          learnedSkills: ctxBundle.learnedSkills || [],
          maxTokens: 900
        });
        worldDigest = (rc && rc.text) || '';
        if (!Array.isArray(ctxBundle.candidateIds) || ctxBundle.candidateIds.length === 0) {
          ctxBundle.candidateIds = rc ? Array.from(rc.validIds) : [];
        }
      }
      const combinedMap = [hierarchicalMap ? `HIERARCHICAL_MAP:\n${hierarchicalMap}` : '', worldDigest].filter(Boolean).join('\n\n');
      const candScores = (Array.isArray(ctxBundle.semanticMatches) ? ctxBundle.semanticMatches : [])
        .slice(0, 12)
        .map((m) => ({
          id: m.entity && m.entity.id,
          label: m.entity && m.entity.label,
          type: m.entity && m.entity.type,
          section: m.entity && m.entity.parentSection,
          score: m.score
        }));
      const domA11yInfo = wmInv ? {
        pageTitle: (typeof document !== 'undefined' && document.title) || '',
        navCount: Array.isArray(wmInv.links) ? wmInv.links.filter((l) => l.navCategory && l.navCategory !== 'body').length : 0,
        optionCount: Array.isArray(wmInv.options) ? wmInv.options.length : 0,
        sectionCount: Array.isArray(wmInv.sections) ? wmInv.sections.length : 0,
        formControls: Array.isArray(wmInv.options) ? wmInv.options.slice(0, 12).map((o) => `${o.id}:${o.parentGroupLabel || o.label}(${o.expectedInputType || o.elementType || o.role || 'ctrl'}${o.required ? ',req' : ''})`) : []
      } : null;

      const payload = {
        utterance: raw,
        resolvedText: (ctxBundle.resolvedContext && ctxBundle.resolvedContext.resolvedText) || raw,
        url: (typeof window !== 'undefined' && window.location && window.location.href) || '',
        website: (typeof window !== 'undefined' && window.location && window.location.hostname) || '',
        pageContext: ctxBundle.structuredCtx || { title: document.title, pageType: 'general' },
        worldModelDigestText: combinedMap,
        structuredDigestText: worldDigest,
        candidateIds: Array.isArray(ctxBundle.candidateIds) ? ctxBundle.candidateIds : [],
        qwenInterpretation: (qwenReply && qwenReply.plan) || null,
        qwenSelectedTarget: (qwenReply && qwenReply.plan && (qwenReply.plan.target_id || qwenReply.plan.target)) || '',
        candidatesAndScores: candScores,
        domA11yInfo,
        previousAttempts: Array.isArray(ctxBundle.previousAttempts) ? ctxBundle.previousAttempts : [],
        failureInfo: typeof failureInfo === 'string' ? failureInfo : JSON.stringify(failureInfo),
        relevantMemories: (ctxBundle.resolvedContext && Array.isArray(ctxBundle.resolvedContext.relevantMemories))
          ? ctxBundle.resolvedContext.relevantMemories.slice(0, 3).map((m) => `${m.activity?.topic || ''}: ${m.activity?.user_command || ''}`)
          : [],
        learnedSkills: (Array.isArray(ctxBundle.learnedSkills) ? ctxBundle.learnedSkills : []).slice(0, 3).map((h) => {
          const sk = (h && h.skill) || h || {};
          return {
            name: sk.name || '',
            steps: Array.isArray(sk.steps) ? sk.steps.slice(0, 6).map((s) => `${s.action}:${s.label || ''}`) : []
          };
        }),
        maxContextTokens: 1200,
        timeoutMs: 3500
      };

      try {
        return await new Promise((resolve) => {
          let finished = false;
          const timer = setTimeout(() => {
            if (!finished) { finished = true; resolve({ status: 'timeout', message: 'Escalated Ollama request timed out.' }); }
          }, 4000);
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_NLU_ESCALATE_REQUEST', payload }, (res) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            const result = chrome.runtime.lastError ? { status: 'ollama_unavailable', message: chrome.runtime.lastError.message } : res;
            resolve(result && typeof result === 'object'
              ? { ...result, candidateNavigationIdentity: ctxBundle.navigationIdentity || '' }
              : result);
          });
        });
      } catch (err) {
        return { status: 'generation_failed', message: (err && err.message) || 'Escalation runtime call failed.' };
      }
    }

    _buildFallbackNluPlan(raw, resolvedContext, structuredCtx, wmInv = null, semanticMatches = []) {
      const s = String(raw || '').trim();
      const lower = s.toLowerCase();
      const pageType = (structuredCtx && structuredCtx.pageType) || (wmInv && wmInv.pageType) || 'general';
      const cand = resolvedContext && resolvedContext.resolvedCandidate;
      const selState = (this.memory && this.memory.state && this.memory.state.selectionState) || {};

      // 0a. Conceptual Learning Goal ("I want to learn how neural networks work")
      if (/^(?:i\s+want\s+to\s+learn|teach\s+me\s+about|help\s+me\s+understand)\b/i.test(lower)) {
        const bestSem = (semanticMatches || [])[0] || null;
        if (wmInv && wmInv.discoveryMode === 'progressive_feed') {
          return {
            intent: 'open_video',
            goal: `Find educational video for "${s}"`,
            target: s,
            target_id: (bestSem && bestSem.entity && bestSem.entity.type === 'video' && bestSem.score >= 0.48) ? bestSem.entity.id : null,
            context: { section: '', table: '', channel: '', duration_hint: '', link_preference: 'any', reference: null, candidate_id: (bestSem && bestSem.entity && bestSem.entity.id) || null },
            actions: [{ type: 'select_video', candidate_id: (bestSem && bestSem.entity && bestSem.entity.id) || null, target: s, section: '', query: s, value: '', minutes: null }],
            requires_clarification: false,
            clarification_question: '',
            confidence: 0.86
          };
        }
        return {
          intent: 'learn_topic',
          goal: `Explain/explore "${s}" from page`,
          target: (bestSem && bestSem.entity && bestSem.entity.label) || s,
          target_id: (bestSem && bestSem.entity && bestSem.entity.id) || null,
          context: { section: (bestSem && bestSem.entity && bestSem.entity.parentSection) || '', table: '', channel: '', duration_hint: '', link_preference: 'any', reference: null, candidate_id: (bestSem && bestSem.entity && bestSem.entity.id) || null },
          actions: [{ type: 'explain', candidate_id: (bestSem && bestSem.entity && bestSem.entity.id) || null, target: s, section: '', query: s, value: '', minutes: null }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.85
        };
      }

      // 0b. "Find another one like this" / similar alternate
      if (resolvedContext && resolvedContext.resolvedSimilarTo) {
        const refObj = resolvedContext.resolvedSimilarTo;
        return {
          intent: (refObj.entityType === 'video' || pageType.startsWith('youtube')) ? 'open_video' : 'open_link',
          goal: `Find another candidate similar to "${refObj.title || refObj.label}"`,
          target: refObj.title || refObj.label || s,
          context: { section: refObj.section || '', table: '', channel: refObj.channel || '', duration_hint: '', link_preference: 'any', reference: 'similar', candidate_id: null },
          actions: [{ type: (refObj.entityType === 'video' || pageType.startsWith('youtube')) ? 'select_video' : 'open_link', candidate_id: null, target: refObj.title || refObj.label || s, section: '', query: s, value: '', minutes: null }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.85
        };
      }

      // 0c. "Find the second article in the previous section" / section-ordinal article lookup
      const secOrdMatch = lower.match(/\b(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|\d+)(?:st|nd|rd|th)?\s+(?:article|link|item|entry)\s+(?:in|under|from)\s+(?:the\s+)?(.+?)(?:\s+section)?$/i);
      if (secOrdMatch && this.worldModel) {
        const ordMap = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 };
        const ordNum = ordMap[secOrdMatch[1]] || Number(secOrdMatch[1]) || 1;
        const rawSecRef = secOrdMatch[2].replace(/\s+section$/i, '').trim();
        const isContextualSecRef = /^(?:previous|earlier|last|this|current|that)$/i.test(rawSecRef) || /\b(?:previous|earlier|last)\s+section\b/i.test(secOrdMatch[2]);
        const secPhrase = isContextualSecRef && resolvedContext?.resolvedSection
          ? resolvedContext.resolvedSection
          : rawSecRef;
        const hit = this.worldModel.findEntityInSectionByOrdinal(secPhrase, ordNum);
        if (hit) {
          return {
            intent: 'open_link',
            goal: `Open item #${ordNum} in section "${secPhrase}"`,
            target: hit.label,
            target_id: hit.id,
            parent_section: hit.parentSection || secPhrase,
            context: { section: hit.parentSection || secPhrase, table: '', channel: '', duration_hint: '', link_preference: 'any', reference: 'section_ordinal', candidate_id: hit.id },
            actions: [{ type: 'open_link', candidate_id: hit.id, target: hit.label, section: hit.parentSection || secPhrase, query: '', value: '', minutes: null }],
            requires_clarification: false,
            clarification_question: '',
            confidence: 0.91
          };
        }
      }

      // 0d. "Take me to where they explain the advantages" -> semantic section/article navigation
      if (/\b(?:take\s+me\s+to\s+(?:where|the\s+part)|where\s+do\s+they\s+explain|find\s+where\s+they\s+discuss)\b/i.test(lower)) {
        const topicPart = s.replace(/^(?:please\s+|can\s+you\s+)?(?:take\s+me\s+to\s+where\s+they\s+explain|find\s+where\s+they\s+discuss|where\s+do\s+they\s+explain)\s+(?:the\s+)?/i, '').trim();
        const bestSec = (semanticMatches || []).find((m) => m && m.entity && ['section', 'content', 'link'].includes(m.entity.type));
        const targetSec = (bestSec && (bestSec.entity.parentSection || bestSec.entity.label)) || topicPart;
        return {
          intent: 'navigate_section',
          goal: `Navigate to section covering "${topicPart}"`,
          target: targetSec,
          target_id: (bestSec && bestSec.entity && bestSec.entity.id) || null,
          context: { section: targetSec, table: '', channel: '', duration_hint: '', link_preference: 'any', reference: null, candidate_id: (bestSec && bestSec.entity && bestSec.entity.id) || null },
          actions: [{ type: 'find_section', candidate_id: (bestSec && bestSec.entity && bestSec.entity.id) || null, target: targetSec, section: targetSec, query: topicPart, value: 'semantic_jump', minutes: null }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.88
        };
      }

      // 0e. Check Interactive Option/Control Hierarchy BEFORE Link lookup ("Select the Dark option under Color" -> O008, NOT Hide button/link!)
      const ctrlMatch = s.match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:select|choose|pick|tick|check|enable|switch\s+to)\s+(?:the\s+)?(.+?)(?:\s+option)?\s+(?:under|in|inside|from)\s+(?:the\s+)?(.+?)(?:\s+(?:group|section|menu|options?))?$/i);
      if (ctrlMatch && this.worldModel) {
        const optTarget = ctrlMatch[1].trim();
        const grpTarget = ctrlMatch[2].trim();
        const optHit = this.worldModel.findOptionByHierarchy(optTarget, grpTarget);
        if (optHit) {
          return {
            intent: 'select_option',
            goal: `Select "${optHit.label}" under "${optHit.parentGroupLabel}"`,
            target: optHit.label,
            target_id: optHit.id,
            target_type: optHit.elementType,
            parent_section: optHit.parentGroupLabel || grpTarget,
            action: optHit.elementType === 'radio' ? 'select_radio' : 'select_option',
            context: { section: optHit.parentGroupLabel || grpTarget, table: '', channel: '', duration_hint: '', link_preference: 'any', reference: null, candidate_id: optHit.id },
            actions: [{ type: optHit.elementType === 'radio' ? 'select_radio' : 'select_option', candidate_id: optHit.id, target: `${optHit.label} in ${optHit.parentGroupLabel || grpTarget}`, section: optHit.parentGroupLabel || grpTarget, query: '', value: optHit.label, minutes: null }],
            requires_clarification: false,
            clarification_question: '',
            confidence: 0.94
          };
        }
        // Explicit option/control phrasing must still route to select_option so forced re-observe / ElementSelector runs instead of open_link
        if (/\b(?:option|radio|checkbox|toggle|switch|dropdown|setting)\b/i.test(s) || /^(?:(?:please|can\s+you|could\s+you)\s+)?(?:tick|check|enable|switch\s+to)\b/i.test(lower)) {
          return {
            intent: 'select_option',
            goal: `Select "${optTarget}" under "${grpTarget}"`,
            target: optTarget,
            target_id: null,
            parent_section: grpTarget,
            action: 'select_option',
            context: { section: grpTarget, table: '', channel: '', duration_hint: '', link_preference: 'any', reference: null, candidate_id: null },
            actions: [{ type: 'select_option', candidate_id: null, target: `${optTarget} in ${grpTarget}`, section: grpTarget, query: '', value: optTarget, minutes: null }],
            requires_clarification: false,
            clarification_question: '',
            confidence: 0.78
          };
        }
      }

      // 1. User correction ("No, I meant the one from the other channel", "No, the one under Banking", "find another one")
      if (/^(?:no|not\s+that|actually|i\s+meant)\b/i.test(lower) || /\b(?:other\s+channel|other\s+one|find\s+another\s+one|different\s+one)\b/i.test(lower)) {
        const secM = lower.match(/\bunder\s+(?:the\s+)?(.+?)(?:\s+section)?$/i);
        return {
          intent: 'correct_previous',
          goal: 'Correct previous selection using user refinement',
          target: (cand && (cand.title || cand.label)) || s,
          context: {
            section: secM ? secM[1].trim() : '',
            table: '',
            channel: (resolvedContext && resolvedContext.resolvedChannel) || (cand && cand.channel) || '',
            duration_hint: '',
            link_preference: /\bofficial|docs\b/i.test(lower) ? 'official' : 'any',
            reference: /\bother\s+channel\b/i.test(lower) ? 'other_channel' : 'other',
            candidate_id: cand ? cand.id : null
          },
          actions: [{ type: selState.activeVideo || pageType.startsWith('youtube') ? 'select_video' : 'open_link', candidate_id: cand ? cand.id : null, target: (cand && (cand.title || cand.label)) || s, section: secM ? secM[1].trim() : '', query: '', value: '', minutes: null }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.86
        };
      }

      // 2. Media playback control on video/watch page
      if (/^(?:pause|play|resume|mute|unmute|seek)\b/i.test(lower) && (/\bvideo\b/i.test(lower) || pageType === 'youtube_watch' || Boolean(document.querySelector && document.querySelector('video')))) {
        const minM = lower.match(/\b(\d+)\s*(?:min|minute|minutes)\b/i);
        const isSeek = /\b(?:seek|skip|jump|forward|back)\b/i.test(lower);
        const mediaAct = /\bmute\b/i.test(lower) ? 'mute' : (/\bunmute\b/i.test(lower) ? 'unmute' : (isSeek ? 'seek' : (/\bpause\b/i.test(lower) ? 'pause' : 'play')));
        return {
          intent: 'media_control',
          goal: `Control video playback (${mediaAct})`,
          target: mediaAct,
          context: { section: '', table: '', channel: '', duration_hint: '', link_preference: 'any', reference: null, candidate_id: null },
          actions: [{ type: isSeek ? 'seek' : 'play_pause', candidate_id: null, target: mediaAct, section: '', query: '', value: mediaAct, minutes: minM ? Number(minM[1]) : null }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.92
        };
      }

      // 3. YouTube watch explanation / first N minutes / what speaker is teaching
      const minsMatch = lower.match(/\bfirst\s+(\d+|one|two|three|four|five|ten)\s+minutes?\b/i);
      const wordNumMap = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10 };
      const maxMinutes = minsMatch ? (wordNumMap[minsMatch[1].toLowerCase()] || Number(minsMatch[1]) || 5) : null;
      if (pageType === 'youtube_watch' && (maxMinutes !== null || /\b(?:speaker|teaching|talking\s+about|explain|summarize|summary|captions?|transcript|video)\b/i.test(lower))) {
        return {
          intent: /\bsummar/i.test(lower) ? 'summarize' : 'explain',
          goal: maxMinutes ? `Explain first ${maxMinutes} minutes of video` : 'Explain what the video covers',
          target: s,
          context: { section: '', table: '', channel: '', duration_hint: maxMinutes ? `first_minutes:${maxMinutes}` : '', link_preference: 'any', reference: null, candidate_id: null },
          actions: [{ type: /\bsummar/i.test(lower) ? 'summarize' : 'explain', candidate_id: null, target: s, section: '', query: s, value: '', minutes: maxMinutes }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.9
        };
      }

      // 4. Table query ("Find TCP entry in the table")
      if (/\b(?:in\s+the\s+table|in\s+table|from\s+table|table\s+entry|entry\s+in\s+table)\b/i.test(lower) || (/\bentry\b/i.test(lower) && structuredCtx && structuredCtx.tables && structuredCtx.tables.length > 0)) {
        const cleanT = s.replace(/\b(?:find|show|get|what\s+is|the|entry|row|in\s+the\s+table|in\s+table|table)\b/gi, ' ').replace(/\s+/g, ' ').trim();
        return {
          intent: 'find_in_table',
          goal: `Find table entry for ${cleanT || s}`,
          target: cleanT || s,
          context: { section: '', table: cleanT || s, channel: '', duration_hint: '', link_preference: 'any', reference: null, candidate_id: null },
          actions: [{ type: 'find_table', candidate_id: null, target: cleanT || s, section: '', query: cleanT || s, value: '', minutes: null }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.9
        };
      }

      // 5. Explain paragraph below heading OR navigate to Nth subsection
      if (/\bparagraph\s+(?:below|under)\b/i.test(lower)) {
        const hm = s.match(/\bparagraph\s+(?:below|under)\s+(?:the\s+)?(?:heading\s+|section\s+)?(.+)$/i);
        const headingTarget = hm ? hm[1].trim() : s;
        return {
          intent: 'explain',
          goal: `Explain paragraph below ${headingTarget}`,
          target: headingTarget,
          context: { section: headingTarget, table: '', channel: '', duration_hint: '', link_preference: 'any', reference: null, candidate_id: null },
          actions: [{ type: 'explain', candidate_id: null, target: headingTarget, section: headingTarget, query: s, value: 'paragraph_below', minutes: null }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.9
        };
      }
      const secJumpM = !/\b(?:article|link|item|entry|video|product)\b/i.test(lower)
        ? s.match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:scroll\s+to|go\s+(?:back\s+)?to|return\s+to|back\s+to|jump\s+to|take\s+me\s+to|move\s+to|find|show)\s+(?:the\s+)?(.+?)\s+section$/i)
        : null;
      const topicSecM = s.match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:scroll\s+to|go\s+to|jump\s+to|take\s+me\s+to|find)\s+(?:the\s+)?(?:section|part)\s+(?:discussing|explaining|talking\s+about|about|on)\s+(.+)$/i)
        || s.match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:take\s+me\s+to|go\s+to|find)\s+(?:the\s+part\s+)?where\s+(?:they|it|the\s+article|the\s+page)\s+(?:explain|explains|discuss|discusses|describe|describes)\s+(?:the\s+)?(.+)$/i);
      if (secJumpM || topicSecM || /\bsubsection\b/i.test(lower)) {
        const rawSecTarget = secJumpM
          ? secJumpM[1].trim()
          : (topicSecM ? topicSecM[1].trim() : s.replace(/^(?:scroll\s+to|go\s+(?:back\s+)?to|return\s+to|jump\s+to|open)\s+/i, '').trim());
        const isPrevSecRef = /^(?:previous|last|earlier)(?:\s+section)?$/i.test(rawSecTarget);
        const secTarget = isPrevSecRef
          ? ((resolvedContext && resolvedContext.resolvedSection) || selState.previousSection || rawSecTarget)
          : rawSecTarget;
        return {
          intent: 'navigate_section',
          goal: `Navigate to section "${secTarget}"`,
          target: secTarget,
          context: { section: secTarget, table: '', channel: '', duration_hint: '', link_preference: 'any', reference: isPrevSecRef ? 'previous_section' : null, candidate_id: null },
          actions: [{ type: 'find_section', candidate_id: null, target: secTarget, section: secTarget, query: '', value: '', minutes: null }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.91
        };
      }

      // 6. YouTube video / Progressive Feed discovery & selection ("open 15th video", "beginner video explaining neural networks")
      if (pageType.startsWith('youtube_') || (wmInv && wmInv.discoveryMode === 'progressive_feed') || /\b(?:video|previous\s+video|shorter\s+video|coding\s+channel)\b/i.test(lower)) {
        if (/\b(?:open|play|watch|select|click|start|choose|find)\b/i.test(lower) || cand) {
          const ordVal = this._parseVideoOrdinal(lower);
          const semBestVid = (semanticMatches || []).find((m) => m && m.entity && m.entity.type === 'video' && m.score >= 0.45);
          const pickedVidId = ordVal ? null : ((cand && cand.id) || (semBestVid && semBestVid.entity && semBestVid.entity.id) || null);
          return {
            intent: (ordVal && wmInv && ordVal > wmInv.videos.length) ? 'request_more_candidates' : 'open_video',
            goal: `Select video matching "${s}"`,
            target: (cand && cand.title) || (semBestVid && semBestVid.entity && semBestVid.entity.title) || s,
            target_id: pickedVidId,
            context: {
              section: '',
              table: '',
              channel: (resolvedContext && resolvedContext.resolvedChannel) || (/\bcoding\s+channel\b/i.test(lower) ? 'coding' : ''),
              duration_hint: /\bshorter\b/i.test(lower) ? 'shorter' : (/\blonger\b/i.test(lower) ? 'longer' : ''),
              link_preference: 'any',
              reference: null,
              candidate_id: pickedVidId
            },
            actions: [{ type: 'select_video', candidate_id: pickedVidId, target: (cand && cand.title) || s, section: '', query: s, value: ordVal ? String(ordVal) : '', minutes: null }],
            requires_clarification: false,
            clarification_question: '',
            confidence: 0.87
          };
        }
      }

      // 7. Scoped / Official link selection ("Select Bank card under Cards", "Click official PyTorch docs link")
      const scopedMatch = s.match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:open|click(?:\s+on)?|select|choose|find|locate|go\s+to|visit)\s+(.+)$/i);
      if (scopedMatch) {
        let tgt = scopedMatch[1].trim();
        let section = '';
        const underM = tgt.match(/^(.+?)\s+(?:under|inside|below|in\s+the)\s+(?:the\s+)?(.+?)(?:\s+(?:section|heading|list|card))?$/i);
        if (underM) {
          tgt = underM[1].trim();
          section = underM[2].trim();
        }
        const pref = /\bofficial\b/i.test(tgt) ? 'official' : (/\b(?:docs|documentation)\b/i.test(tgt) ? 'documentation' : 'any');
        const safeLinkCand = (cand && cand.type === 'link' && pref === 'any') ? cand : null;
        return {
          intent: 'open_link',
          goal: `Open "${tgt}"${section ? ` under "${section}"` : ''}`,
          target: (safeLinkCand && (safeLinkCand.label || safeLinkCand.title)) || tgt,
          context: { section, table: '', channel: '', duration_hint: '', link_preference: pref, reference: null, candidate_id: safeLinkCand ? safeLinkCand.id : null },
          actions: [{ type: 'open_link', candidate_id: safeLinkCand ? safeLinkCand.id : null, target: (safeLinkCand && (safeLinkCand.label || safeLinkCand.title)) || tgt, section, query: '', value: pref, minutes: null }],
          requires_clarification: false,
          clarification_question: '',
          confidence: 0.85
        };
      }

      return null;
    }

    _isPlanPlausibleForUtterance(plan, raw = '', wmInv = null, structuredCtx = null) {
      if (!plan || typeof plan !== 'object') return false;
      if (plan.requires_clarification && plan.clarification_question) return true;
      const lower = String(raw || '').toLowerCase();
      if (plan.intent === 'find_in_table' || plan.action === 'find_table') {
        const hasTables = Boolean((wmInv && Array.isArray(wmInv.tables) && wmInv.tables.length > 0) || (structuredCtx && Array.isArray(structuredCtx.tables) && structuredCtx.tables.length > 0));
        if (!hasTables || (/\b(?:video|videos|watch|tutorial)\b/i.test(lower) && !/\btable\b/i.test(lower))) {
          return false;
        }
      }
      // Ungrounded search target verification: search plan targets must be semantically relevant to user's search query
      if ((plan.intent === 'search' || (plan.actions && plan.actions.some((a) => a && a.type === 'search'))) && !plan.requires_clarification) {
        const pTarget = String(plan.target || (plan.actions && plan.actions[0] && (plan.actions[0].query || plan.actions[0].target)) || '').trim().toLowerCase();
        const rawQ = lower.replace(/^(?:(?:please\s+)?(?:search(?:\s+for)?|look\s+up|find)\s+)/i, '').replace(/[.;,!]+$/, '').trim();
        if (pTarget && !lower.includes(pTarget) && (!rawQ || !pTarget.includes(rawQ))) {
          return false;
        }
      }
      // Conceptual/section jump utterances must not be misrouted into clicking an unrelated UI option
      if (/\b(?:take\s+me\s+to\s+(?:where|the\s+part)|where\s+do\s+they\s+explain|find\s+where\s+they\s+discuss)\b/i.test(lower) &&
          plan.intent !== 'navigate_section') {
        return false;
      }
      // Explicit link / documentation / article commands or empty section targets must not stay navigate_section
      if (plan.intent === 'navigate_section') {
        const firstAct = (Array.isArray(plan.actions) && plan.actions[0]) || {};
        const hasAnySecTarget = Boolean(
          String(plan.target || '').trim() ||
          plan.target_id ||
          (plan.context && String(plan.context.section || '').trim()) ||
          String(firstAct.target || '').trim() ||
          String(firstAct.section || '').trim() ||
          firstAct.candidate_id
        );
        if (!hasAnySecTarget) return false;
        const isWatchPage = Boolean((structuredCtx && structuredCtx.pageType === 'youtube_watch') || (wmInv && wmInv.pageType === 'youtube_watch'));
        if (isWatchPage && !/\bsection\b/i.test(lower) && /\b(?:speaker|teaching|talking\s+about|captions?|transcript|first\s+(?:\d+|one|two|three|four|five|ten)\s+minutes?|explain|summarize|summary|what\s+(?:is|does|are))\b/i.test(lower)) {
          return false;
        }
        if (/\b(?:article|articles|link|links|item|items|entry|entries|docs|documentation|website|url|portal)\b/i.test(lower) &&
            !/^(?:(?:please|can\s+you)\s+)?(?:scroll|go|jump|move)\s+(?:back\s+)?to\s+(?:the\s+)?(?:latest\s+articles|articles?|links?)\s+section\b/i.test(lower)) {
          return false;
        }
      }
      // Explicit "<verb> to the X section" commands must stay section navigation;
      // never let a stale/confident open_link plan target a previous section's link.
      if (/\b(?:go|move|jump|scroll|navigate|return|back|take\s+me)\s+(?:back\s+)?to\s+(?:the\s+)?(.+?)\s+section\b/i.test(lower) ||
          /\b(?:find|show)\s+(?:the\s+)?(.+?)\s+section\b/i.test(lower)) {
        const isSectionPlan = plan.intent === 'navigate_section'
          || (Array.isArray(plan.actions) && plan.actions.some((a) => a && a.type === 'find_section'));
        if (!isSectionPlan) return false;
      }
      if (plan.intent === 'select_option' || plan.action === 'select_radio') {
        const hasCtrlVerb = /\b(?:select|choose|pick|tick|check|enable|disable|toggle|switch|change|set|option|radio|checkbox|dropdown)\b/i.test(lower);
        if (!hasCtrlVerb) return false;
      }
      if (plan.intent === 'open_link') {
        const hasNavCue = /\b(?:open|click|select|choose|pick|visit|go\s+to|find|locate|show|check|link|page|website|site|url|portal)\b/i.test(lower);
        if (!hasNavCue) return false;
      }
      if (plan.intent === 'media_control' || ['play_pause', 'pause', 'play', 'mute', 'unmute', 'seek'].includes(plan.action)) {
        const hasMediaCtrlVerb = /\b(?:play|pause|stop|resume|mute|unmute|seek|skip|forward|rewind|faster|slower|speed|volume)\b/i.test(lower);
        if (!hasMediaCtrlVerb || /\b(?:explain|summarize|summary|what\s+(?:is|does)|teach(?:ing)?)\b/i.test(lower)) {
          return false;
        }
      }
      const isFeedCtx = Boolean(
        (wmInv && (wmInv.discoveryMode === 'progressive_feed' || wmInv.pageType === 'youtube_search' || wmInv.pageType === 'youtube_feed')) ||
        (structuredCtx && (structuredCtx.pageType === 'youtube_search' || structuredCtx.pageType === 'youtube_feed'))
      );
      if (isFeedCtx && /^(?:(?:please|can\s+you|could\s+you)\s+)?(?:find|open|play|watch|select|choose|pick)\b.*\bvideos?\b/i.test(lower) &&
          !['open_video', 'open_link', 'find_in_page', 'request_more_candidates'].includes(plan.intent)) {
        return false;
      }
      return true;
    }

    _parseVideoOrdinal(text = '') {
      const lower = String(text || '').toLowerCase();
      const ordWordMap = {
        first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5,
        sixth: 6, '6th': 6, seventh: 7, '7th': 7, eighth: 8, '8th': 8, ninth: 9, '9th': 9, tenth: 10, '10th': 10,
        eleventh: 11, '11th': 11, twelfth: 12, '12th': 12, thirteenth: 13, '13th': 13, fourteenth: 14, '14th': 14,
        fifteenth: 15, '15th': 15, sixteenth: 16, '16th': 16, seventeenth: 17, '17th': 17, eighteenth: 18, '18th': 18,
        nineteenth: 19, '19th': 19, twentieth: 20, '20th': 20
      };
      const ordWordM = lower.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|eleventh|11th|twelfth|12th|thirteenth|13th|fourteenth|14th|fifteenth|15th|sixteenth|16th|seventeenth|17th|eighteenth|18th|nineteenth|19th|twentieth|20th)\b/);
      if (ordWordM && ordWordMap[ordWordM[1]]) return ordWordMap[ordWordM[1]];
      const ordNumM = lower.match(/\b(?:number\s+|#)?(\d+)(?:st|nd|rd|th)\s*(?:video|one|item|result)?\b/)
        || lower.match(/\b(?:video|number|#)\s*(\d+)\b/);
      if (ordNumM && Number(ordNumM[1]) >= 1 && Number(ordNumM[1]) <= 60) return Number(ordNumM[1]);
      return null;
    }

    async _explainYouTubeWatch(plan, raw, structuredCtx) {
      const digestApi = window.SleepwalkerDigest || null;
      const watch = (structuredCtx && structuredCtx.watchVideo) ? { ...structuredCtx.watchVideo } : null;
      const act = (plan && Array.isArray(plan.actions) && plan.actions[0]) || {};
      const rawMinsM = String(raw || '').match(/\bfirst\s+(\d+|one|two|three|four|five|ten)\s+minutes?\b/i);
      const rawWordNums = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10 };
      const rawMinsVal = rawMinsM ? (rawWordNums[rawMinsM[1].toLowerCase()] || Number(rawMinsM[1]) || null) : null;
      const maxMinutes = act.minutes || ((plan && plan.context && /^first_minutes:(\d+)$/.test(plan.context.duration_hint || '')) ? Number(RegExp.$1) : null) || rawMinsVal;

      if (!watch) return null;

      // On real YouTube watch pages, transcript panels only render after expanding description / clicking "Show transcript"
      if ((!watch.captionsAvailable || !Array.isArray(watch.transcriptSegments) || watch.transcriptSegments.length === 0) &&
          typeof document !== 'undefined' && typeof document.querySelector === 'function' &&
          digestApi && typeof digestApi.extractYouTubeTranscriptSegments === 'function') {
        const expBtn = document.querySelector('ytd-text-inline-expander #expand, #description-inline-expander #expand');
        if (expBtn && typeof expBtn.click === 'function' && expBtn.offsetParent !== null) {
          try { expBtn.click(); } catch (_e) {}
        }
        const trBtn = document.querySelector('ytd-video-description-transcript-section-renderer button, button[aria-label*="Show transcript" i], button[aria-label*="transcript" i]');
        if (trBtn && typeof trBtn.click === 'function') {
          try { trBtn.click(); } catch (_e) {}
          const pollDeadline = Date.now() + 2400;
          while (Date.now() < pollDeadline) {
            await new Promise((r) => setTimeout(r, 250));
            const liveTr = digestApi.extractYouTubeTranscriptSegments(document);
            if (liveTr && liveTr.captionsAvailable && Array.isArray(liveTr.segments) && liveTr.segments.length > 0) {
              watch.captionsAvailable = true;
              watch.transcriptSource = liveTr.source;
              watch.transcriptSegments = liveTr.segments;
              break;
            }
          }
        }
      }

      if (!watch.captionsAvailable || !Array.isArray(watch.transcriptSegments) || watch.transcriptSegments.length === 0) {
        const descNote = watch.description
          ? ` From the visible video title and description: ${watch.description.slice(0, 220)}`
          : '';
        const msg = `Captions or a transcript aren't available for "${watch.title || 'this video'}", so I cannot verify what the speaker says.${descNote}`;
        this.setAssistantReply(msg);
        if (window.SW_UI) {
          window.SW_UI.setState('speaking');
          window.SW_UI.showCard({
            type: 'answer',
            title: 'Transcript Unavailable',
            text: msg,
            warning: 'No captions or transcript segments are exposed on this video page.'
          });
        }
        if (this.reader) this.reader.readText(msg);
        return { status: 'captions_unavailable', captionsAvailable: false, answer: msg, videoTitle: watch.title };
      }

      const sliced = digestApi && typeof digestApi.sliceAndGroupTranscript === 'function'
        ? digestApi.sliceAndGroupTranscript(watch.transcriptSegments, { maxMinutes })
        : { segments: watch.transcriptSegments, topics: [], combinedText: watch.transcriptSegments.map((s) => `[${s.timestamp}] ${s.text}`).join('\n') };

      if (!sliced.segments || sliced.segments.length === 0) {
        const emptyRangeMsg = `Captions are available, but no spoken segments fall within the first ${maxMinutes} minute(s).`;
        this.setAssistantReply(emptyRangeMsg);
        if (window.SW_UI) window.SW_UI.showCard({ type: 'answer', title: watch.title || 'Video Transcript', text: emptyRangeMsg });
        return { status: 'empty_range', captionsAvailable: true, answer: emptyRangeMsg };
      }

      const cardTitle = maxMinutes
        ? `${watch.title || 'Video'} (First ${maxMinutes} min)`
        : (watch.title || 'Video Summary');

      // Grounded video explanation (Priority 3 explicit specialist video task)
      const expRes = await this.explainPage({
        mode: 'qa',
        query: maxMinutes ? `Summarize key topics taught in the first ${maxMinutes} minutes strictly from these timestamped captions: ${raw}` : raw,
        isVideoExplain: true,
        specialist: true,
        customChunksText: sliced.combinedText,
        customTitle: cardTitle,
        lang: this.resolveReplyLang()
      });

      const fallbackTopicSummary = sliced.topics.map((t) => `[${t.title}] ${t.text.slice(0, 140)}`).join(' ');
      const finalAnswer = (expRes && expRes.answer) || fallbackTopicSummary;

      if (window.SW_UI && sliced.topics.length > 0) {
        window.SW_UI.showCard({
          type: 'summary',
          title: cardTitle,
          text: finalAnswer,
          topics: sliced.topics.map((t, i) => ({ title: `${i + 1}. ${t.title}`, text: t.text.slice(0, 220) }))
        });
      }

      return {
        status: 'explained_video',
        captionsAvailable: true,
        source: (expRes && expRes.source) || 'transcript',
        topics: sliced.topics,
        answer: finalAnswer
      };
    }

    async _executeNluActionPlan(plan, raw, resolvedContext, structuredCtx, meta = {}) {
      if (!plan || typeof plan !== 'object') return null;

      // Clarify gate: ask concise question when NLU identifies genuine ambiguity, highlight DOM candidates & speak options
      if (plan.requires_clarification && plan.clarification_question) {
        let q = plan.clarification_question;
        const clarifyTaskId = (meta && meta.taskId) || (this.taskLifecycle && this.taskLifecycle.activeTaskId) || 0;
        const wmInvClarify = meta.wmInv || (this.worldModel ? this.worldModel.getTabInventory() : null);
        const overlayItems = [];
        const candIdList = Array.isArray(plan.candidate_ids) ? plan.candidate_ids : [];
        const seenClarifyEls = new Set();
        const pushOverlayEntity = (ent) => {
          if (!ent || !ent.element || ent.element.isConnected === false || seenClarifyEls.has(ent.element)) return;
          seenClarifyEls.add(ent.element);
          overlayItems.push({
            element: ent.element,
            label: ent.label || ent.title || '',
            section: ent.parentSection || ent.parentGroupLabel || '',
            id: ent.id || ''
          });
        };
        if (wmInvClarify && wmInvClarify.entities) {
          candIdList.forEach((cid) => pushOverlayEntity(wmInvClarify.entities.get(cid)));
          if (overlayItems.length < 2 && Array.isArray(meta.semanticMatches)) {
            meta.semanticMatches.slice(0, 4).forEach((m) => pushOverlayEntity(m && m.entity));
          }
        }
        if (overlayItems.length >= 2 && this.elementSelector && typeof this.elementSelector._getCandidateOverlay === 'function') {
          try {
            const ov = this.elementSelector._getCandidateOverlay(document);
            if (ov && typeof ov.showCandidates === 'function') {
              ov.showCandidates(overlayItems.slice(0, 5), { labelKey: 'label' });
            }
          } catch (_e) {}
          if (!/\b1\./.test(q)) {
            const optsText = overlayItems.slice(0, 5).map((item, idx) => `${idx + 1}. ${item.label}${item.section ? ` (${item.section})` : ''}`).join(', ');
            q = `${q} ${optsText}`;
          }
        }

        if (clarifyTaskId) {
          this._enterWaitingForClarification(clarifyTaskId, q, async (answerText, info) => {
            if (this.elementSelector && typeof this.elementSelector.clearCandidateOverlay === 'function') {
              this.elementSelector.clearCandidateOverlay();
            }
            const ans = String(answerText || '').trim();
            const ordMap = { first: 0, '1st': 0, '1': 0, one: 0, second: 1, '2nd': 1, '2': 1, two: 1, third: 2, '3rd': 2, '3': 2, three: 2, fourth: 3, '4th': 3, '4': 3, four: 3, fifth: 4, '5th': 4, '5': 4, five: 4 };
            const ordClean = ans.toLowerCase().replace(/\b(?:one|option|item|number)\b/g, ' ').replace(/\s+/g, ' ').trim();
            const pickedOverlay = (overlayItems.length > 0 && ordMap[ordClean] !== undefined && overlayItems[ordMap[ordClean]])
              ? overlayItems[ordMap[ordClean]]
              : null;

            const combined = (() => {
              if (!ans) return raw;
              if (pickedOverlay && pickedOverlay.label) {
                return `Select ${pickedOverlay.label}${pickedOverlay.section ? ` under ${pickedOverlay.section}` : ''}`;
              }
              if (/\b(?:open|select|go\s+to|choose|click|show|read|summarize)\b/i.test(ans)) return ans;
              if (plan.intent === 'navigate_section' || /\bsection\b/i.test(q)) return `Go to the ${ans} section`;
              if (plan.intent === 'select_option' || /\b(?:option|which\s+one)\b/i.test(q)) return `Select ${ans}`;
              return `${raw} ${ans}`;
            })();
            return this._processUserInputInner(combined, (info && info.inputSource) || 'voice', {
              ...((info && info.meta) || {}),
              internalResumeTaskId: clarifyTaskId
            });
          });
        }
        this.setAssistantReply(q);
        if (window.SW_UI) {
          window.SW_UI.setState('confirm');
          window.SW_UI.showCard({
            type: overlayItems.length >= 2 ? 'choices' : 'answer',
            title: 'Need Clarification',
            text: q,
            choices: overlayItems.length >= 2 ? overlayItems.slice(0, 5).map((it) => it.label) : undefined
          });
        }
        if (this.reader) this.reader.readText(q);
        return {
          status: 'needs_clarification',
          answer: q,
          plan,
          taskId: clarifyTaskId,
          highlightedCount: overlayItems.length
        };
      }

      const mem = this.memory;
      const selState = (mem && mem.state && mem.state.selectionState) || {};
      let act = (Array.isArray(plan.actions) && plan.actions[0]) || { type: '' };
      let wmInv = meta.wmInv || (this.worldModel ? this.worldModel.getTabInventory() : null);

      // Plan normalization: compact model may label a scoped link pick ("Select Bank card under Cards",
      // "Open Results under Examinations.") as select_option or navigate_section.
      // When no form control or exact section heading matches <X> but a real page link does, route through open_link.
      const cleanScopedRaw = String(raw || '').trim().replace(/[.,!?;:]+$/, '');
      const scopedLinkCmdM = cleanScopedRaw.match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:open|click|select|choose)\s+(?:the\s+)?(.+?)\s+(?:under|in|inside|from)\s+(?:the\s+)?(.+?)$/i);
      const isNavSecMislabel = (plan.intent === 'navigate_section' || act.type === 'find_section') &&
        Boolean(scopedLinkCmdM) &&
        !/\b(?:section|subsection|heading|scroll|jump)\b/i.test(String(raw || ''));
      if ((plan.intent === 'select_option' || act.type === 'select_option' || isNavSecMislabel) && this.worldModel && wmInv &&
          !/\b(?:option|radio|checkbox|toggle|switch|dropdown|setting)\b/i.test(String(raw || ''))) {
        const wantLabel = String((scopedLinkCmdM && scopedLinkCmdM[1]) || act.target || plan.target || '').replace(/[.,!?;:]+$/, '').trim().toLowerCase();
        const wantSec = String((scopedLinkCmdM && scopedLinkCmdM[2]) || plan.parent_section || (plan.context && plan.context.section) || act.section || '').replace(/[.,!?;:]+$/, '').trim().toLowerCase();
        const isActualHeading = Boolean(
          isNavSecMislabel &&
          Array.isArray(wmInv.sections) &&
          wmInv.sections.some((s) => String((s && s.label) || '').trim().toLowerCase() === wantLabel)
        );
        const optHit = (!isActualHeading && wantLabel && typeof this.worldModel.findOptionByHierarchy === 'function')
          ? this.worldModel.findOptionByHierarchy(wantLabel, wantSec)
          : null;
        if (wantLabel && !isActualHeading && !optHit && Array.isArray(wmInv.links)) {
          const linkHit = wmInv.links.find((l) => {
            const lbl = String((l && l.label) || '').trim().toLowerCase();
            if (!lbl || (lbl !== wantLabel && !lbl.includes(wantLabel))) return false;
            if (!wantSec) return true;
            const secHay = `${l.parentSection || ''} ${l.parentMenuLabel || ''} ${l.section || ''}`.toLowerCase();
            return secHay.includes(wantSec);
          });
          if (linkHit) {
            plan = {
              ...plan,
              intent: 'open_link',
              target: linkHit.label || wantLabel,
              target_id: linkHit.id || plan.target_id || null,
              context: { ...(plan.context || {}), section: wantSec || (plan.context && plan.context.section) || plan.parent_section || '', candidate_id: linkHit.id || null },
              actions: [{ ...act, type: 'open_link', target: linkHit.label || wantLabel, section: wantSec || act.section || '', candidate_id: linkHit.id || null }]
            };
            act = plan.actions[0];
          }
        }
      }
      const targetCid = plan.target_id || act.candidate_id || (plan.context && plan.context.candidate_id) || null;
      let wmCheck = null;
      if (targetCid && this.worldModel && wmInv) {
        wmCheck = this.worldModel.resolveAndValidateCandidate(targetCid, wmInv.tabId, { expectedNavigationIdentity: meta.candidateNavigationIdentity || wmInv.navigationIdentity });
        if (!wmCheck.ok) {
          return { status: 'validation_rejected', verified: false, validationStatus: wmCheck.reason, failureStage: 'candidate_validation', message: wmCheck.reason };
        }
      }

      // 0. Mode 2 Progressive Feed Expansion ("Open 15th video" or missing semantic match in Batch 1)
      if ((plan.intent === 'request_more_candidates' || act.type === 'request_more_candidates') && this.worldModel) {
        const ordHint = (act.value && /^\d+$/.test(act.value)) ? Number(act.value) : null;
        const exp = await this.worldModel.discoverMoreCandidates({ targetOrdinal: ordHint || undefined });
        wmInv = exp.inventory || wmInv;
        if (wmInv && mem && typeof mem.registerCandidateList === 'function') {
          mem.registerCandidateList('youtube_videos', wmInv.videos, { urlClean: wmInv.urlClean });
        }
        // After expanding feed batch, continue cleanly to video selection!
        if (ordHint && wmInv && wmInv.videos[ordHint - 1]) {
          plan = { ...plan, intent: 'open_video', actions: [{ ...act, type: 'select_video', candidate_id: wmInv.videos[ordHint - 1].id, value: String(ordHint) }] };
        } else if (wmInv && !ordHint) {
          const reSem = await this.worldModel.retrieveRelevantCandidatesAsync(raw, { topK: 4, inventory: wmInv, timeoutMs: 1200 }).catch(() => []);
          const topSem = reSem.find((m) => m.entity && m.entity.type === 'video');
          if (topSem) {
            plan = { ...plan, intent: 'open_video', target_id: topSem.entity.id, actions: [{ ...act, type: 'select_video', candidate_id: topSem.entity.id, target: topSem.entity.title }] };
          }
        }
      }

      // 1. User correction ("No, I meant the one from the other channel", "No, the one under Banking")
      if (plan.intent === 'correct_previous') {
        if (mem && typeof mem.recordRejection === 'function') {
          mem.recordRejection(selState.currentSelection || null, raw);
        }
        const isVideoPage = Boolean((structuredCtx && structuredCtx.pageType && structuredCtx.pageType.startsWith('youtube')) || selState.activeVideo || /\bchannel|video\b/i.test(raw));
        if (isVideoPage && this.navigator && typeof this.navigator.selectYouTubeVideo === 'function') {
          const curSel = selState.currentSelection || selState.activeVideo;
          const altRes = await this.navigator.selectYouTubeVideo({
            excludeIds: selState.rejectedCandidateIds || [],
            excludeChannels: (/\bother\s+channel\b/i.test(raw) && curSel && curSel.channel) ? [curSel.channel] : [],
            query: plan.target || raw
          });
          if (altRes && altRes.status === 'selected_video') {
            if (mem && typeof mem.recordSelection === 'function') mem.recordSelection(altRes.video, { entityType: 'video' });
            this.setAssistantReply(altRes.message);
            if (window.SW_UI) {
              window.SW_UI.setState('speaking');
              window.SW_UI.showCard({ type: 'answer', title: altRes.video.title, text: altRes.message });
            }
            return { ...altRes, corrected: true, nluSource: meta.nluSource };
          }
        }
        if (this.navigator && typeof this.navigator.executeLinkWithRecovery === 'function') {
          const secMatch = raw.match(/\bunder\s+(?:the\s+)?(.+?)(?:\s+section)?$/i);
          const corrRes = await this.navigator.executeLinkWithRecovery({
            action: 'CLICK',
            target: plan.target || (selState.currentSelection && selState.currentSelection.label) || raw,
            section: (plan.context && plan.context.section) || (secMatch ? secMatch[1].trim() : ''),
            excludeHrefs: selState.currentSelection && selState.currentSelection.url ? [selState.currentSelection.url] : [],
            excludeLabels: selState.rejectedLabels || []
          }, { rawText: raw });
          return { ...corrRes, corrected: true, nluSource: meta.nluSource };
        }
      }

      // 2. Media / playback control
      if (plan.intent === 'media_control' || act.type === 'play_pause' || act.type === 'seek') {
        if (this.navigator && typeof this.navigator.controlMediaPlayback === 'function') {
          const mediaAct = act.type === 'seek' ? 'seek' : (act.value || plan.target || 'toggle');
          const seekSecs = Number.isFinite(Number(act.minutes)) ? Number(act.minutes) * 60 : undefined;
          const mRes = await this.navigator.controlMediaPlayback(mediaAct, { seconds: seekSecs });
          this.setAssistantReply(mRes.message);
          if (window.SW_UI) {
            window.SW_UI.setState(mRes.ok ? 'speaking' : 'error');
            window.SW_UI.showCard({ type: mRes.ok ? 'answer' : 'error', title: 'Playback Control', text: mRes.message });
          }
          if (this.reader) this.reader.readText(mRes.message);
          return { ...mRes, nluSource: meta.nluSource };
        }
      }

      // 3. YouTube watch explanation / first N minutes / caption honesty
      if ((structuredCtx && structuredCtx.pageType === 'youtube_watch') &&
          (plan.intent === 'explain' || plan.intent === 'summarize' || plan.intent === 'ask_question' || act.minutes)) {
        const ytExplain = await this._explainYouTubeWatch(plan, raw, structuredCtx);
        if (ytExplain) return { ...ytExplain, nluSource: meta.nluSource };
      }

      // 4. YouTube video discovery & selection (with progressive batch discovery & semantic evidence check)
      const isFeedPage = Boolean((structuredCtx && (structuredCtx.pageType === 'youtube_search' || structuredCtx.pageType === 'youtube_feed')) || (wmInv && wmInv.discoveryMode === 'progressive_feed'));
      const isVideoEntity = Boolean(wmCheck && wmCheck.ok && wmCheck.entity && wmCheck.entity.type === 'video');
      const isExplicitCtrl = /\b(?:option|radio|checkbox|toggle|switch|dropdown|setting)\b/i.test(String(raw || ''));
      const wantsVideoAction = plan.intent === 'open_video' || act.type === 'select_video' || isVideoEntity
        || (isFeedPage && ['open_link', 'find_in_page', 'request_more_candidates'].includes(plan.intent) && !isExplicitCtrl && /\b(?:video|videos|watch|play|channel|first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|\d+(?:st|nd|rd|th))\b/i.test(String(raw || '')));
      if (wantsVideoAction) {
        if (this.navigator && typeof this.navigator.selectYouTubeVideo === 'function') {
          const ctx = plan.context || {};
          const curSel = selState.currentSelection || selState.activeVideo;
          const isOtherChan = ctx.reference === 'other_channel' || /\bother\s+channel\b/i.test(raw);
          if (isOtherChan && curSel && mem && typeof mem.recordRejection === 'function') {
            mem.recordRejection(curSel, raw);
          }
          const curAct = (Array.isArray(plan.actions) && plan.actions[0]) || act;
          const explicitOrd = this._parseVideoOrdinal(raw);
          const reqOrd = explicitOrd || (curAct.value && /^\d+$/.test(curAct.value) ? Number(curAct.value) : null);
          let resolvedVidEntity = (!explicitOrd && isVideoEntity) ? wmCheck.entity : null;
          let droppedBatch1Guess = false;

          // Progressive feed expansion when ordinal exceeds Batch 1 OR current batch lacks a strong semantic/topic match
          if (this.worldModel && wmInv && wmInv.discoveryMode === 'progressive_feed') {
            const topicTokens = String(raw || '').toLowerCase()
              .replace(/[^a-z0-9\s]/g, ' ')
              .split(/\s+/)
              .filter((t) => t.length >= 3 && !/^(?:find|open|play|watch|show|select|choose|pick|the|for|from|with|about|that|this|video|videos|channel|beginner|beginners|friendly|explaining|explain|how|learn|tutorial|guide|intro|introduction|short|shorter|long|longer|another|other|same)$/.test(t));
            const entityMatchesTopic = (ent) => {
              if (!ent || topicTokens.length === 0) return true;
              const hay = `${ent.title || ''} ${ent.label || ''} ${ent.description || ''} ${ent.channel || ''}`.toLowerCase();
              return topicTokens.some((tok) => hay.includes(tok));
            };
            if (resolvedVidEntity && !reqOrd && !isOtherChan && (wmInv.hasMoreFeedInDom || wmInv.batchCount < 2) && !entityMatchesTopic(resolvedVidEntity)) {
              resolvedVidEntity = null;
              droppedBatch1Guess = true;
            }
            if (reqOrd && reqOrd > wmInv.videos.length) {
              const exp = await this.worldModel.discoverMoreCandidates({ targetOrdinal: reqOrd });
              wmInv = exp.inventory || wmInv;
            } else if (!resolvedVidEntity && !reqOrd) {
              const topSem = (meta.semanticMatches || []).find((m) => m.entity && m.entity.type === 'video' && m.score >= 0.56 && entityMatchesTopic(m.entity));
              if (!topSem && (wmInv.hasMoreFeedInDom || wmInv.batchCount < 2)) {
                const exp = await this.worldModel.discoverMoreCandidates({});
                wmInv = exp.inventory || wmInv;
                const reSem = await this.worldModel.retrieveRelevantCandidatesAsync(raw, { topK: 4, inventory: wmInv, timeoutMs: 1200 }).catch(() => []);
                const hit = reSem.find((m) => m.entity && m.entity.type === 'video' && m.score >= 0.45 && entityMatchesTopic(m.entity))
                  || reSem.find((m) => m.entity && m.entity.type === 'video' && m.score >= 0.45);
                if (hit) resolvedVidEntity = hit.entity;
              } else if (topSem) {
                resolvedVidEntity = topSem.entity;
              }
            }
            if (wmInv && mem && typeof mem.registerCandidateList === 'function') {
              mem.registerCandidateList('youtube_videos', wmInv.videos, { urlClean: wmInv.urlClean });
            }
          }

          if (!resolvedVidEntity && reqOrd && wmInv && wmInv.videos[reqOrd - 1]) {
            resolvedVidEntity = wmInv.videos[reqOrd - 1];
          }

          const vRes = await this.navigator.selectYouTubeVideo({
            candidateId: (explicitOrd || droppedBatch1Guess)
              ? ((resolvedVidEntity && (resolvedVidEntity.videoId || resolvedVidEntity.id)) || null)
              : ((resolvedVidEntity && (resolvedVidEntity.videoId || resolvedVidEntity.id)) || curAct.candidate_id || ctx.candidate_id || null),
            ordinal: reqOrd,
            channel: ctx.channel || (resolvedContext && resolvedContext.resolvedChannel) || '',
            durationHint: ctx.duration_hint || '',
            query: explicitOrd
              ? (resolvedVidEntity && resolvedVidEntity.title) || ''
              : ((resolvedVidEntity && resolvedVidEntity.title) || plan.target || curAct.target || raw),
            excludeIds: selState.rejectedCandidateIds || [],
            excludeChannels: (isOtherChan && curSel && curSel.channel) ? [curSel.channel] : []
          });
          if (vRes && vRes.status === 'selected_video') {
            if (mem && typeof mem.recordSelection === 'function') mem.recordSelection(vRes.video, { entityType: 'video' });
            this.setAssistantReply(vRes.message);
            if (window.SW_UI) {
              window.SW_UI.setState('speaking');
              window.SW_UI.showCard({ type: 'answer', title: vRes.video.title, text: vRes.message });
            }
            if (this.reader) this.reader.readText(vRes.message);
            return { ...vRes, nluSource: meta.nluSource };
          }
          if (vRes && vRes.status === 'ambiguous' && Array.isArray(vRes.videos)) {
            const labels = vRes.videos.map((v) => `${v.title}${v.channel ? ` (${v.channel})` : ''}`);
            if (mem && typeof mem.registerCandidateList === 'function') {
              mem.registerCandidateList('youtube_videos', vRes.videos, { urlClean: structuredCtx && structuredCtx.urlClean });
            }
            const msg = `Multiple videos match: ${labels.map((l, i) => `${i + 1}. ${l}`).join(' ')}. Which one should I open?`;
            this.setAssistantReply(msg);
            if (window.SW_UI) {
              window.SW_UI.setState('confirm');
              window.SW_UI.showCard({ type: 'choices', title: 'Choose Video', text: 'Select a video:', choices: labels });
            }
            return { status: 'ambiguous_video', choices: labels, nluSource: meta.nluSource };
          }
        }
      }

      // 5. Table lookup ("Find TCP entry in the table")
      if (plan.intent === 'find_in_table' || act.type === 'find_table') {
        if (this.navigator && typeof this.navigator.queryTables === 'function') {
          const rawTableQ = String(raw || '').replace(/\b(?:find|show|get|look\s*up|what\s+is|the|entry|row|in\s+the\s+table|in\s+table|table|from\s+table)\b/gi, ' ').replace(/\s+/g, ' ').trim();
          const planTableQ = String(act.query || plan.target || (plan.context && plan.context.table) || '').trim();
          const useTableQ = (!planTableQ || /^T\d+$/i.test(planTableQ)) ? (rawTableQ || raw) : planTableQ;
          let tRes = this.navigator.queryTables(useTableQ);
          const normRawQ = rawTableQ.toLowerCase();
          if (normRawQ && (!tRes || !tRes.found || !tRes.best || !String(tRes.best.row?.rowSummary || '').toLowerCase().includes(normRawQ))) {
            const rawRes = this.navigator.queryTables(rawTableQ);
            if (rawRes && rawRes.found && rawRes.best && String(rawRes.best.row?.rowSummary || '').toLowerCase().includes(normRawQ)) {
              tRes = rawRes;
            }
          }
          if (tRes && tRes.found && tRes.best) {
            const r = tRes.best.row;
            const tbl = tRes.best.table;
            const msg = `In ${tbl.section || 'table'}: ${r.rowSummary}.`;
            this.setAssistantReply(msg);
            if (window.SW_UI) {
              window.SW_UI.setState('speaking');
              window.SW_UI.showCard({
                type: 'answer',
                title: tbl.section || 'Table Entry',
                text: msg,
                table: { headers: r.headers || tbl.headers, rows: [r.rawCells] }
              });
            }
            if (this.reader) this.reader.readText(msg);
            return { status: 'found_in_table', verified: true, table: tbl.section, row: r, answer: msg, nluSource: meta.nluSource };
          }
          const nfMsg = `Could not find a matching row for "${plan.target || raw}" in page tables.`;
          this.setAssistantReply(nfMsg);
          if (window.SW_UI) window.SW_UI.showCard({ type: 'error', title: 'Table Entry Not Found', text: nfMsg });
          return { status: 'not_found', verified: false, answer: nfMsg, nluSource: meta.nluSource };
        }
      }

      // 6. Paragraph below heading explanation
      if (act.value === 'paragraph_below' || /\bparagraph\s+(?:below|under)\b/i.test(raw)) {
        const headingTarget = plan.target || (plan.context && plan.context.section) || raw;
        let pInfo = null;
        if (this.browserEngine && this.useRebuiltBrowserEngine && typeof this.browserEngine.readContent === 'function') {
          const rT0 = performance.now();
          const rc = this.browserEngine.readContent(headingTarget);
          this._recordRolloutEvent({ action: 'read_content', engine: 'rebuilt_browser_engine', outcome: rc.verified ? 'success' : 'fallback', latencyMs: performance.now() - rT0 });
          if (rc && rc.verified && rc.text) {
            pInfo = { heading: rc.heading || headingTarget, text: rc.text, element: rc.element };
          }
        }
        if (!pInfo && this.navigator && typeof this.navigator.extractParagraphBelowHeading === 'function') {
          pInfo = this.navigator.extractParagraphBelowHeading(headingTarget);
        }
        if (pInfo && pInfo.text) {
          const res = await this.explainPage({
            mode: 'qa',
            query: raw,
            target: pInfo.heading,
            customChunksText: `[${pInfo.heading}] ${pInfo.text}`,
            customTitle: `Section: ${pInfo.heading}`,
            lang: this.resolveReplyLang()
          });
          return { status: 'explained_paragraph', heading: pInfo.heading, ...(res || {}), nluSource: meta.nluSource };
        }
      }

      // 7. Navigate to subsection / heading
      if (plan.intent === 'navigate_section' || act.type === 'find_section' || /\bsubsection\b/i.test(raw)) {
        if (this.navigator) {
          let navTarget = /\bsubsection\b/i.test(raw)
            ? raw.replace(/^(?:please\s+|can\s+you\s+)?(?:scroll\s+to|go\s+(?:back\s+)?to|return\s+to|jump\s+to|open|find)\s+/i, '').trim()
            : (plan.target || act.target || (plan.context && plan.context.section) || raw);
          // Consistency guard: if user explicitly named a destination section ("Go to the Usage section"), reject stale/hallucinated section guess ("History")
          const explicitSecM = String(raw || '').match(/\b(?:scroll\s+to|go\s+(?:back\s+)?to|return\s+to|jump\s+to|take\s+me\s+to|move\s+to|find|show)\s+(?:the\s+)?(.+?)\s+section\b/i);
          if (explicitSecM && explicitSecM[1]) {
            const expSec = explicitSecM[1].trim();
            if (/^(?:previous|last|earlier)$/i.test(expSec)) {
              navTarget = expSec;
            } else if (!/^(?:this|current)$/i.test(expSec)) {
              const normExp = expSec.toLowerCase();
              const normNav = String(navTarget || '').toLowerCase();
              if (!normNav || (!normNav.includes(normExp) && !normExp.includes(normNav))) {
                navTarget = expSec;
              }
            }
          }
          if (/^(?:the\s+)?(?:previous|last|earlier)(?:\s+section)?$/i.test(String(navTarget).trim())) {
            const prevResolved = (resolvedContext && resolvedContext.resolvedSection) || (selState && selState.previousSection) || '';
            if (!prevResolved) {
              const noPrevMsg = 'No previous section is recorded yet on this page.';
              this.setAssistantReply(noPrevMsg);
              if (window.SW_UI) window.SW_UI.showCard({ type: 'answer', title: 'Navigation', text: noPrevMsg });
              return { status: 'not_found', message: noPrevMsg, nluSource: meta.nluSource };
            }
            navTarget = prevResolved;
          }
          const navRes = await this._executeGoToSectionWithEngine(navTarget, { readAfter: !(/\b(?:scroll\s+to|take\s+me\s+to|jump\s+to)\b/i.test(raw) && /\b(?:discussing|explaining|where\s+they)\b/i.test(raw)) });
          if (mem && navRes && navRes.section && typeof mem.setActiveUiFocus === 'function') {
            mem.setActiveUiFocus({ section: navRes.section });
          }
          return { ...navRes, verified: Boolean(navRes && (navRes.verified || navRes.status !== 'not_found')), nluSource: meta.nluSource };
        }
      }

      // 8. Scoped or preference-aware link opening / finding with verification & recovery
      if (plan.intent === 'open_link' || plan.intent === 'find_in_page' || act.type === 'open_link') {
        const ctx = plan.context || {};
        // First check if target is actually an interactive radio/option inside a group ("Select Dark under Color")
        if (wmCheck && wmCheck.ok && wmCheck.entity && wmCheck.entity.type === 'option' && this.elementSelector) {
          const optEnt = wmCheck.entity;
          if (optEnt.controlCandidate && typeof this.elementSelector.executeAndVerifyCandidate === 'function') {
            const verifyRes = await this.elementSelector.executeAndVerifyCandidate(
              { action: 'select', candidate: optEnt.controlCandidate, targetOption: optEnt.label, matchedOptionObj: optEnt.optionDescriptor || undefined },
              { action: optEnt.elementType === 'checkbox' ? 'check' : 'select_option', targetOption: optEnt.label, fieldHint: optEnt.parentGroupLabel },
              { doc: document }
            );
            if (mem && typeof mem.setActiveUiFocus === 'function') mem.setActiveUiFocus({ section: optEnt.parentSection });
            return { ...verifyRes, nluSource: meta.nluSource };
          }
        }

        let candFromWm = (wmCheck && wmCheck.ok && wmCheck.entity && wmCheck.entity.type === 'link') ? wmCheck.entity : null;
        const rawUnderM = String(raw || '').match(/\b(?:under|inside|below|in\s+the)\s+(?:the\s+)?(.+?)(?:\s+(?:section|heading|list|card|menu))?[.?!]*$/i);
        const explicitSec = rawUnderM ? rawUnderM[1].replace(/[.?!]+$/, '').trim() : '';
        if (candFromWm && explicitSec && !/^(?:previous|last|earlier|this|current)$/i.test(explicitSec)) {
          const candSec = `${candFromWm.parentSection || ''} ${candFromWm.parentMenuLabel || ''} ${candFromWm.section || ''}`.toLowerCase();
          if (!candSec.includes(explicitSec.toLowerCase())) {
            candFromWm = null; // Reject LLM ID guess that crossed an explicitly named section
          }
        }
        if (!candFromWm && explicitSec && this.worldModel && wmInv && Array.isArray(wmInv.links)) {
          const rawOpenUnderM = String(raw || '').trim().match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:open|click|select|choose|visit|go\s+to)\s+(?:the\s+)?(.+?)\s+(?:under|inside|below|in\s+the)\s+/i);
          const wantLbl = String((rawOpenUnderM && rawOpenUnderM[1]) || plan.target || act.target || '').replace(/[.?!]+$/, '').trim().toLowerCase();
          const wantSecLow = explicitSec.toLowerCase();
          if (wantLbl) {
            candFromWm = wmInv.links.find((l) => {
              const lbl = String((l && l.label) || '').trim().toLowerCase();
              if (!lbl || (lbl !== wantLbl && !lbl.includes(wantLbl))) return false;
              const secHay = `${l.parentSection || ''} ${l.parentMenuLabel || ''} ${l.section || ''}`.toLowerCase();
              return secHay.includes(wantSecLow);
            }) || null;
          }
        }
        if (this.worldModel) {
          const ordMatch = String(raw || '').match(/\b(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|\d+)(?:st|nd|rd|th)?\s+(?:article|link|item|entry)\b/i);
          if (ordMatch) {
            const ordMap = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 };
            const ordNum = ordMap[ordMatch[1].toLowerCase()] || Number(ordMatch[1]) || 1;
            const secCandidate = (resolvedContext && resolvedContext.resolvedSection) || ctx.section || act.section || '';
            if (secCandidate && !/^(?:previous|last|earlier|this|current)$/i.test(secCandidate)) {
              const ordHit = this.worldModel.findEntityInSectionByOrdinal(secCandidate, ordNum);
              if (ordHit) candFromWm = ordHit;
            }
          }
        }
        const candById = candFromWm || ((act.candidate_id || ctx.candidate_id) && structuredCtx && Array.isArray(structuredCtx.links)
          ? structuredCtx.links.find((l) => l.id === (act.candidate_id || ctx.candidate_id))
          : null);
        const targetLabel = (candById && candById.label) || plan.target || act.target || raw;
        const hasSectionCue = Boolean(explicitSec || (resolvedContext && resolvedContext.resolvedSection));
        const sectionScope = hasSectionCue
          ? ((candById && (candById.parentSection || candById.section)) || (resolvedContext && resolvedContext.resolvedSection) || explicitSec || ctx.section || act.section || '')
          : '';
        const linkPref = ctx.link_preference || act.value || 'any';

        // Stage 2.1: Feature-flagged Stagehand atomic click backend (default disabled)
        if (this.useStagehandAdapter && this.stagehandAdapter) {
          const shClickRes = await this._executeClickWithStagehand(targetLabel, {
            cmdId: meta && meta.requestId,
            taskId: meta && meta.taskId,
            taskSignal: this.taskLifecycle && this.taskLifecycle.abortController ? this.taskLifecycle.abortController.signal : null,
            nluSource: meta && meta.nluSource
          });
          if (shClickRes) return shClickRes;
        }

        // Narrow interface for rebuilt browser engine with telemetry, consequential-action gate, and fallback to existing navigator
        if (this.browserEngine && this.useRebuiltBrowserEngine) {
          const beT0 = performance.now();
          try {
            const normMenu = typeof this.browserEngine.normalizeMenuPath === 'function'
              ? this.browserEngine.normalizeMenuPath(sectionScope ? [sectionScope, targetLabel] : raw)
              : null;
            const isHierarchical = Boolean(Array.isArray(normMenu) && normMenu.length >= 2);
            if (isHierarchical && typeof this.browserEngine.openMenuPath === 'function') {
              const menuRes = await this.browserEngine.openMenuPath(normMenu);
              const beMs = performance.now() - beT0;
              if (menuRes && menuRes.status === 'CONFIRMATION_REQUIRED') {
                this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: menuRes.reason, latencyMs: beMs });
                return { status: 'confirming', awaiting: true, verified: false, engine: 'rebuilt_browser_engine', target: targetLabel, reason: menuRes.reason };
              }
              if (menuRes && (menuRes.status === 'SUCCESS' || menuRes.verified)) {
                this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: beMs });
                return { status: 'opened', verified: true, engine: 'rebuilt_browser_engine', target: targetLabel, parentMenu: sectionScope, nluSource: meta.nluSource };
              }
              this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (menuRes && menuRes.reason) || 'menu_not_verified', latencyMs: beMs });
            }

            const beLoc = this.browserEngine.locate(targetLabel, { section: sectionScope });
            if (beLoc.status === 'FOUND' && beLoc.target) {
              const isTabItem = Boolean((beLoc.item && beLoc.item.role === 'tab') || /\btab\b/i.test(raw));
              const beRes = isTabItem
                ? await this.browserEngine.switchTab(beLoc.target)
                : await this.browserEngine.click(beLoc.target, { isNavigation: true });
              const beMs = performance.now() - beT0;
              if (beRes.status === 'CONFIRMATION_REQUIRED') {
                // Never silently retry or fall back on consequential actions
                this._recordRolloutEvent({ action: isTabItem ? 'switch_tab' : 'open_link', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: beRes.reason, latencyMs: beMs });
                return { status: 'confirming', awaiting: true, verified: false, engine: 'rebuilt_browser_engine', target: targetLabel, reason: beRes.reason };
              }
              if (beRes.status === 'SUCCESS' || beRes.verified) {
                this._recordRolloutEvent({ action: isTabItem ? 'switch_tab' : 'open_link', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: beMs });
                return { status: isTabItem ? 'selected' : 'opened', verified: true, engine: 'rebuilt_browser_engine', target: targetLabel, details: beRes.details, nluSource: meta.nluSource };
              }
              this._recordRolloutEvent({ action: isTabItem ? 'switch_tab' : 'open_link', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: beRes.reason || beRes.status, latencyMs: beMs });
            } else if (beLoc.status === 'NOT_FOUND' && sectionScope && typeof this.browserEngine.openMenuAndSelect === 'function') {
              // Expandable / initially hidden nested submenu under sectionScope
              const menuRes = await this.browserEngine.openMenuAndSelect(sectionScope, targetLabel);
              const beMs = performance.now() - beT0;
              if (menuRes && menuRes.status === 'CONFIRMATION_REQUIRED') {
                this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: menuRes.reason, latencyMs: beMs });
                return { status: 'confirming', awaiting: true, verified: false, engine: 'rebuilt_browser_engine', target: targetLabel, reason: menuRes.reason };
              }
              if (menuRes && (menuRes.status === 'SUCCESS' || menuRes.verified)) {
                this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: beMs });
                return { status: 'opened', verified: true, engine: 'rebuilt_browser_engine', target: targetLabel, parentMenu: sectionScope, nluSource: meta.nluSource };
              }
              this._recordRolloutEvent({ action: 'nested_menu', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (menuRes && menuRes.reason) || 'menu_not_verified', latencyMs: beMs });
            } else if (beLoc.status === 'AMBIGUOUS') {
              this._recordRolloutEvent({ action: 'open_link', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: 'ambiguous_candidates', latencyMs: performance.now() - beT0 });
            } else {
              this._recordRolloutEvent({ action: 'open_link', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: beLoc.reason || beLoc.status, latencyMs: performance.now() - beT0 });
            }
          } catch (beErr) {
            this._recordRolloutEvent({ action: 'open_link', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (beErr && beErr.message) || 'exception', latencyMs: performance.now() - beT0 });
            console.warn('[Sleepwalker] Rebuilt browser engine error, falling back to navigator:', beErr);
          }
        }

        if (this.navigator && typeof this.navigator.executeLinkWithRecovery === 'function') {
          const urlBefore = window.location.href;
          const scrollBefore = window.scrollY;
          const lRes = await this.navigator.executeLinkWithRecovery({
            action: plan.intent === 'find_in_page' ? 'FIND' : 'CLICK',
            target: targetLabel,
            href: (candById && (candById.destinationUrl || candById.href)) || '',
            section: sectionScope,
            linkPreference: linkPref,
            excludeLabels: selState.rejectedLabels || []
          }, { rawText: raw, requireStrictEffect: false });
          if (lRes && !lRes.verified && lRes.needsVisualFallback && meta && !meta.skipVisualFallback) {
            const vis = await this._requestVisualGroundFallback(raw, 'dom_missing_or_covered', meta.wmInv);
            if (vis && vis.status === 'ok' && vis.validatedElement && typeof vis.validatedElement.click === 'function') {
              vis.validatedElement.click();
              return { status: 'visual_grounded_click', verified: true, usedVision: true, grounding: vis.grounding, nluSource: meta.nluSource };
            }
          }
          if (mem && sectionScope && typeof mem.setActiveUiFocus === 'function') mem.setActiveUiFocus({ section: sectionScope });
          const isConfirming = Boolean(lRes && (lRes.awaiting === true || lRes.status === 'confirming'));
          const verifiedOutcome = Boolean(lRes && (lRes.verified || isConfirming || window.location.href !== urlBefore || window.scrollY !== scrollBefore));
          return { ...lRes, ...(isConfirming && !lRes.status ? { status: 'confirming' } : {}), verified: verifiedOutcome, nluSource: meta.nluSource };
        }
      }

      // 9. Form / option selection via ElementSelector + World Model hierarchy verification & single recovery
      if (plan.intent === 'select_option' || act.type === 'select_option' || act.type === 'select_radio') {
        if (this.elementSelector) {
          let selRes = null;
          const rawOptMatch = String(raw || '').match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:select|choose|pick|tick|check|enable|switch\s+to)\s+(?:the\s+)?(.+?)(?:\s+option)?\s+(?:under|in|inside|from)\s+(?:the\s+)?(.+?)(?:\s+(?:group|section|menu|options?))?$/i);
          const rawSimpleSelM = !rawOptMatch ? String(raw || '').match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:select|choose|pick|tick|check|enable|switch\s+to|click(?:\s+on)?|open)\s+(?:the\s+)?(.+?)(?:\s+option)?$/i) : null;
          const explicitCtrlCue = Boolean(/\b(?:option|radio|checkbox|toggle|switch|dropdown|setting)\b/i.test(String(raw || '')) || /^(?:(?:please|can\s+you|could\s+you)\s+)?(?:tick|check|enable|switch\s+to)\b/i.test(String(raw || '').trim()));
          const desiredOptLabel = rawOptMatch ? rawOptMatch[1].trim() : ((rawSimpleSelM && rawSimpleSelM[1].trim()) || act.value || plan.target || act.target || '');
          const explicitGroupHint = rawOptMatch ? rawOptMatch[2].trim() : '';
          const desiredGroupHint = explicitGroupHint || plan.parent_section || (plan.context && plan.context.section) || '';

          let optEnt = (wmCheck && wmCheck.ok && wmCheck.entity && wmCheck.entity.type === 'option')
            ? wmCheck.entity
            : null;
          if (optEnt && desiredOptLabel) {
            const oLow = String(optEnt.label || '').toLowerCase();
            const dLow = String(desiredOptLabel || '').toLowerCase();
            if (oLow !== dLow && !oLow.includes(dLow) && !dLow.includes(oLow)) {
              const alignedOpt = this.worldModel ? this.worldModel.findOptionByHierarchy(desiredOptLabel, desiredGroupHint) : null;
              optEnt = alignedOpt || null;
            }
          }
          if (!optEnt && this.worldModel) {
            optEnt = this.worldModel.findOptionByHierarchy(desiredOptLabel || plan.target || act.target, desiredGroupHint);
          }

          // If user gave a plain link-like command ("Select Smart card") and NO matching control exists, try link navigation instead of guessing an unrelated control
          if (!optEnt && !explicitCtrlCue && desiredOptLabel && this.navigator && typeof this.navigator.executeLinkWithRecovery === 'function') {
            const urlBefore = window.location.href;
            const lRes = await this.navigator.executeLinkWithRecovery({
              action: 'CLICK',
              target: desiredOptLabel,
              section: explicitGroupHint,
              excludeLabels: selState.rejectedLabels || []
            }, { rawText: raw });
            if (lRes && (lRes.verified || lRes.status === 'navigated' || lRes.status === 'clicked' || window.location.href !== urlBefore)) {
              return { ...lRes, verified: true, nluSource: meta.nluSource };
            }
          }

          if (this.browserEngine && this.useRebuiltBrowserEngine && desiredOptLabel) {
            const beDrop = await this._tryRebuiltDropdownSelect(raw, {
              optionText: desiredOptLabel,
              groupHint: desiredGroupHint
            });
            if (beDrop) {
              return { ...beDrop, nluSource: meta.nluSource };
            }
          }

          if (optEnt && optEnt.controlCandidate && typeof this.elementSelector.executeAndVerifyCandidate === 'function') {
            selRes = await this.elementSelector.executeAndVerifyCandidate(
              { action: 'select', candidate: optEnt.controlCandidate, targetOption: optEnt.label, matchedOptionObj: optEnt.optionDescriptor || undefined },
              { action: optEnt.elementType === 'checkbox' ? 'check' : 'select_option', targetOption: optEnt.label, fieldHint: optEnt.parentGroupLabel },
              { doc: document }
            );
          } else {
            selRes = await this.elementSelector.handleCommand(act.target || plan.target || raw, { doc: document, isCorrection: false });
          }
          // Controlled single retry after refreshing dynamic inventory if DOM mutated mid-selection
          if ((!selRes || !selRes.verified) && this.worldModel) {
            await this.worldModel.observeTab(document, { force: true });
            const retryOpt = this.worldModel.findOptionByHierarchy(desiredOptLabel || plan.target || act.target, desiredGroupHint);
            if (retryOpt && retryOpt.controlCandidate && retryOpt.element && retryOpt.element.isConnected !== false) {
              selRes = await this.elementSelector.executeAndVerifyCandidate(
                { action: 'select', candidate: retryOpt.controlCandidate, targetOption: retryOpt.label, matchedOptionObj: retryOpt.optionDescriptor || undefined },
                { action: 'select_option', targetOption: retryOpt.label, fieldHint: retryOpt.parentGroupLabel },
                { doc: document }
              );
              if (selRes) selRes.recovered = true;
            }
          }
          if (selRes && selRes.verified) {
            if (mem && typeof mem.setActiveUiFocus === 'function') mem.setActiveUiFocus({ section: (optEnt && optEnt.parentSection) || plan.parent_section || '' });
            if (this.worldModel && typeof this.worldModel.scheduleProactiveScan === 'function') {
              this.worldModel.scheduleProactiveScan(document, { force: true, delayMs: 80 });
            }
            this.setAssistantReply(selRes.message);
            if (window.SW_UI) {
              window.SW_UI.setState('speaking');
              window.SW_UI.showCard({ type: 'answer', title: 'Updated Control', text: selRes.message });
            }
          }
          return { ...(selRes || { status: 'not_found', verified: false }), failureStage: selRes && selRes.verified ? 'none' : 'verification', nluSource: meta.nluSource };
        }
      }

      // 9b. Form text/email/number input filling (never fills/logs sensitive fields)
      if ((plan.intent === 'fill_input' || act.type === 'fill') && (this.forms || this.browserEngine)) {
        const fillRes = await this._executeFillInputWithEngine({
          action: 'fill',
          target: act.target || plan.target || '',
          value: act.value || ''
        }, raw);
        if (fillRes && (fillRes.ok || fillRes.verified || fillRes.status === 'sensitive_skipped')) {
          if (this.worldModel && typeof this.worldModel.scheduleProactiveScan === 'function') {
            this.worldModel.scheduleProactiveScan(document, { force: true, delayMs: 80 });
          }
          return { ...fillRes, verified: fillRes.verified !== false && fillRes.ok !== false, nluSource: meta.nluSource };
        }
      }

      // 9c. Form submission with required validation & mandatory user confirmation gate
      if (plan.intent === 'submit_form' || act.type === 'submit' || /\b(?:submit|complete\s+(?:the\s+)?(?:application|form)|send\s+application)\b/i.test(raw)) {
        if (this.browserEngine && this.useRebuiltBrowserEngine && typeof this.browserEngine.submitForm === 'function') {
          const beSub = await this.browserEngine.submitForm(act.target || plan.target || null, { userConfirmed: false });
          if (beSub && beSub.status === 'CONFIRMATION_REQUIRED') {
            const sumLines = (beSub.summary && beSub.summary.summaryLines) || ['Form submission requires your confirmation.'];
            if (window.SW_UI) {
              window.SW_UI.setState('confirm');
              window.SW_UI.showCard({
                type: 'confirm',
                title: 'Confirm Form Submission',
                stepLabel: 'Review & Confirm',
                text: 'Are you sure you want to submit this form?',
                summaryLines: sumLines,
                reqId: (meta && meta.requestId) || null,
                onConfirm: async () => {
                  return this.browserEngine.submitForm(act.target || plan.target || null, { userConfirmed: true });
                }
              });
            }
            return { status: 'confirming', awaiting: true, verified: false, engine: 'rebuilt_browser_engine', reason: 'confirmation_required' };
          }
          if (beSub && (beSub.status === 'SUCCESS' || beSub.verified)) {
            return { status: 'submitted', verified: true, engine: 'rebuilt_browser_engine', details: beSub.details };
          }
        }
        if (this.forms && typeof this.forms.reviewAndActOnStepOrSubmit === 'function') {
          const subRes = this.forms.reviewAndActOnStepOrSubmit('submit');
          return { ...(subRes || { status: 'confirming' }), verified: true, nluSource: meta.nluSource };
        }
      }

      // 10. Search
      if (plan.intent === 'search' || act.type === 'search') {
        const effectiveSearchQ = (plan.context && plan.context.query) || act.query || plan.target || (meta.classified && meta.classified.args && meta.classified.args.query) || raw;
        const sRes = await this._executeSearchWithEngine(effectiveSearchQ, {
          scopeHint: (plan.context && plan.context.section) || act.section || '',
          rawCommand: raw
        });
        if (sRes) return { ...sRes, nluSource: meta.nluSource };
      }

      // 11. Page / Question / Conceptual Learning explanation via existing grounded explainer (Gemini only if specialist)
      if (plan.intent === 'explain' || plan.intent === 'summarize' || plan.intent === 'ask_question' || plan.intent === 'learn_topic') {
        const semSec = (wmCheck && wmCheck.ok && wmCheck.entity && wmCheck.entity.parentSection) || (plan.context && plan.context.section) || '';
        const allowSpecialist = Boolean(plan.requires_gemini_specialist || meta.allowGeminiSpecialist || plan.intent === 'summarize');
        const res = await this.explainPage({
          mode: (plan.intent === 'ask_question' || plan.intent === 'learn_topic') ? 'qa' : (semSec ? 'section' : 'summary'),
          query: (resolvedContext && resolvedContext.resolvedText) || act.query || raw,
          target: semSec,
          specialist: allowSpecialist,
          explicitGemini: allowSpecialist,
          lang: this.resolveReplyLang(meta.classified)
        });
        return { ...(res || {}), nluSource: meta.nluSource };
      }

      return null;
    }

    async _executeGoToSectionWithEngine(secTarget, opts = {}) {
      if (this.browserEngine && this.useRebuiltBrowserEngine && typeof this.browserEngine.goToSection === 'function') {
        const t0 = performance.now();
        try {
          const beRes = await this.browserEngine.goToSection(secTarget, opts);
          const ms = performance.now() - t0;
          if (beRes && (beRes.status === 'SUCCESS' || beRes.verified)) {
            this._recordRolloutEvent({ action: 'go_to_section', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: ms });
            if (beRes.element && this.navigator && typeof this.navigator.previewElement === 'function') {
              this.navigator.previewElement(beRes.element);
            }
            if (opts.readAfter && beRes.element && this.reader && typeof this.reader.readHeadingSection === 'function') {
              this.reader.setLang(this.getEffectiveSpeechLang(this.lang));
              this.reader.readHeadingSection(beRes.element);
            }
            const msg = `Moved to "${beRes.section}" section.`;
            this.setAssistantReply(msg);
            if (window.SW_UI) {
              window.SW_UI.showCard({ type: 'answer', title: 'Section Navigation', text: msg });
            }
            return {
              status: 'moved',
              ok: true,
              verified: true,
              engine: 'rebuilt_browser_engine',
              section: beRes.section,
              message: msg
            };
          }
          this._recordRolloutEvent({ action: 'go_to_section', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (beRes && beRes.reason) || 'not_found', latencyMs: ms });
        } catch (err) {
          this._recordRolloutEvent({ action: 'go_to_section', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (err && err.message) || 'exception', latencyMs: performance.now() - t0 });
        }
      }
      if (this.navigator && typeof this.navigator.goToSection === 'function') {
        const legacyRes = await this.navigator.goToSection(secTarget, opts);
        return {
          ...(legacyRes || {}),
          engine: 'legacy',
          fallback_from_rebuilt: Boolean(this.useRebuiltBrowserEngine)
        };
      }
      return { status: 'not_found', ok: false, verified: false, engine: 'legacy' };
    }

    async _executeClickWithStagehand(targetLabel, opts = {}) {
      if (!this.useStagehandAdapter || !this.stagehandAdapter) return null;
      const t0 = performance.now();
      const cmdId = opts.cmdId || `sw-click-${Date.now().toString(36)}`;
      const shRes = await this.stagehandAdapter.act('click', targetLabel, null, {
        commandId: cmdId,
        signal: opts.taskSignal || null
      });
      const ms = performance.now() - t0;
      if (shRes && shRes.ok && shRes.result) {
        const res = shRes.result;
        const verified = Boolean(res.navigated || (res.details && res.details.groundedMatch));
        this._recordRolloutEvent({ action: 'open_link', engine: 'stagehand_adapter', outcome: verified ? 'success' : 'fallback', latencyMs: ms });
        if (verified) {
          const msg = `Clicked "${(res.details && res.details.matchedLabel) || targetLabel}".`;
          this.setAssistantReply(msg);
          return {
            status: res.navigated ? 'navigated' : 'clicked',
            ok: true,
            verified: true,
            engine: 'stagehand_adapter',
            stagehandVersion: shRes.stagehandVersion || null,
            target: (res.details && res.details.matchedLabel) || targetLabel,
            url: res.urlAfter || window.location.href,
            title: res.titleAfter || document.title,
            navigated: Boolean(res.navigated),
            domEvidence: res.details || null,
            ownership: shRes.ownershipDuringOp || null,
            nluSource: opts.nluSource
          };
        }
        return {
          status: 'verification_failed',
          ok: false,
          verified: false,
          engine: 'stagehand_adapter',
          target: targetLabel,
          url: res.urlAfter || window.location.href,
          message: `Clicked "${targetLabel}" but could not verify resulting DOM or URL change.`
        };
      }
      if (shRes && shRes.code === 'CANCELLED') {
        return { status: 'task_cancelled', ok: false, verified: false, engine: 'stagehand_adapter', reason: 'cancelled' };
      }
      const errMsg = (shRes && shRes.error) || 'Stagehand click unavailable';
      const isNotFound = /GROUNDED_TARGET_NOT_FOUND/i.test(errMsg);
      return {
        status: isNotFound ? 'not_found' : 'stagehand_disconnected',
        ok: false,
        verified: false,
        recoverable: true,
        engine: 'stagehand_adapter',
        code: (shRes && shRes.code) || 'STAGEHAND_UNAVAILABLE',
        error: errMsg,
        message: errMsg
      };
    }

    async _extractVisiblePageInfoWithStagehand(query = '', opts = {}) {
      if (!this.useStagehandAdapter || !this.stagehandAdapter) return null;
      const t0 = performance.now();
      const cmdId = opts.cmdId || `sw-extract-${Date.now().toString(36)}`;
      const shRes = await this.stagehandAdapter.extract(opts.schema || null, query, {
        useLlm: Boolean(opts.useLlm),
        commandId: cmdId,
        signal: opts.taskSignal || null
      });
      const ms = performance.now() - t0;
      if (shRes && shRes.ok && shRes.result && shRes.result.data) {
        const data = shRes.result.data;
        const hasVisibleContent = Boolean(
          (data.stagehandPageTextLength && data.stagehandPageTextLength > 0) ||
          (data.visibleTextPreview && data.visibleTextPreview.length > 0) ||
          (Array.isArray(data.headings) && data.headings.length > 0)
        );
        this._recordRolloutEvent({ action: 'extract_page', engine: 'stagehand_adapter', outcome: hasVisibleContent ? 'success' : 'fallback', latencyMs: ms });
        const preview = (data.visibleTextPreview || data.stagehandPageTextPreview || '').slice(0, 280);
        if (hasVisibleContent) {
          this.setAssistantReply(preview);
          if (window.SW_UI) {
            window.SW_UI.showCard({ type: 'summary', title: data.title || 'Page Information', text: preview });
          }
        }
        return {
          status: hasVisibleContent ? 'extracted' : 'verification_failed',
          ok: hasVisibleContent,
          verified: hasVisibleContent,
          engine: 'stagehand_adapter',
          stagehandVersion: shRes.stagehandVersion || null,
          llmUsed: Boolean(shRes.result.llmUsed),
          url: shRes.result.url || window.location.href,
          title: shRes.result.title || document.title,
          data,
          ownership: shRes.ownershipDuringOp || null
        };
      }
      return {
        status: (shRes && shRes.code === 'CANCELLED') ? 'task_cancelled' : 'stagehand_disconnected',
        ok: false,
        verified: false,
        recoverable: true,
        engine: 'stagehand_adapter',
        code: (shRes && shRes.code) || 'STAGEHAND_UNAVAILABLE',
        error: (shRes && shRes.error) || 'Stagehand extraction unavailable',
        message: (shRes && shRes.error) || 'Stagehand extraction unavailable'
      };
    }

    async _executeSearchWithEngine(query, opts = {}) {
      if ((opts.taskSignal && opts.taskSignal.aborted) || (opts.taskId && !this._isTaskCurrent(opts.taskId))) {
        return { status: 'task_cancelled', ok: false, reason: 'superseded_by_newer_command' };
      }
      if (this.useStagehandAdapter && this.stagehandAdapter) {
        const t0 = performance.now();
        const shRes = await this.stagehandAdapter.act('search', null, query, {
          commandId: opts.cmdId || `sw-search-${Date.now().toString(36)}`,
          signal: opts.taskSignal || null
        });
        const ms = performance.now() - t0;
        if ((opts.taskSignal && opts.taskSignal.aborted) || (opts.taskId && !this._isTaskCurrent(opts.taskId))) {
          return { status: 'task_cancelled', ok: false, verified: false, engine: 'stagehand_adapter', reason: 'superseded_by_newer_command' };
        }
        if (shRes && shRes.ok && shRes.result) {
          const r = shRes.result;
          const typedMatches = Boolean(r.details && typeof r.details.typedValue === 'string' && r.details.typedValue.toLowerCase().includes(String(query || '').trim().toLowerCase()));
          const verified = Boolean(r.navigated || typedMatches);
          this._recordRolloutEvent({ action: 'search', engine: 'stagehand_adapter', outcome: verified ? 'success' : 'fallback', latencyMs: ms });
          if (verified) {
            const sMsg = `Searched for "${query}".`;
            this.setAssistantReply(sMsg);
            if (window.SW_UI) {
              window.SW_UI.showCard({ type: 'answer', title: 'Search', text: sMsg, reqId: opts.requestId || (opts.meta && opts.meta.reqId) });
            }
            return {
              status: 'searched',
              ok: true,
              verified: true,
              engine: 'stagehand_adapter',
              stagehandVersion: shRes.stagehandVersion || null,
              llmUsed: Boolean(r.llmUsed),
              query,
              url: r.urlAfter || window.location.href,
              title: r.titleAfter || document.title,
              navigated: Boolean(r.navigated),
              domEvidence: r.details || null,
              ownership: shRes.ownershipDuringOp || null
            };
          }
          return {
            status: 'verification_failed',
            ok: false,
            verified: false,
            engine: 'stagehand_adapter',
            query,
            url: r.urlAfter || window.location.href,
            domEvidence: r.details || null,
            message: `Search dispatched for "${query}" but neither URL nor input value verified.`
          };
        }
        if (shRes && shRes.code === 'CANCELLED') {
          return { status: 'task_cancelled', ok: false, verified: false, engine: 'stagehand_adapter', reason: 'cancelled' };
        }
        const errMsg = (shRes && shRes.error) || 'Stagehand search unavailable';
        const isNoField = /INPUT_TARGET_NOT_FOUND/i.test(errMsg);
        return {
          status: isNoField ? 'no_search_field' : 'stagehand_disconnected',
          ok: false,
          verified: false,
          recoverable: true,
          engine: 'stagehand_adapter',
          code: (shRes && shRes.code) || 'STAGEHAND_UNAVAILABLE',
          error: errMsg,
          message: errMsg
        };
      }
      if (this.browserEngine && this.useRebuiltBrowserEngine && typeof this.browserEngine.executeSearch === 'function') {
        const t0 = performance.now();
        try {
          const beRes = await this.browserEngine.executeSearch(query, opts);
          const ms = performance.now() - t0;
          if ((opts.taskSignal && opts.taskSignal.aborted) || (opts.taskId && !this._isTaskCurrent(opts.taskId))) {
            return { status: 'task_cancelled', ok: false, reason: 'superseded_by_newer_command' };
          }
          if (beRes && (beRes.status === 'SUCCESS' || beRes.verified)) {
            this._recordRolloutEvent({ action: 'search', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: ms });
            const sMsg = `Searched for "${query}".`;
            this.setAssistantReply(sMsg);
            if (window.SW_UI) {
              window.SW_UI.showCard({
                type: 'answer',
                title: 'Search',
                text: sMsg,
                reqId: opts.requestId || (opts.meta && opts.meta.reqId)
              });
            }
            return {
              status: 'searched',
              ok: true,
              verified: true,
              engine: 'rebuilt_browser_engine',
              query,
              target: beRes.targetLabel || 'Search',
              url: beRes.url || window.location.href,
              details: beRes.details
            };
          }
          if (beRes && beRes.status === 'AMBIGUOUS') {
            this._recordRolloutEvent({ action: 'search', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: 'ambiguous_search_fields', latencyMs: ms });
          } else {
            this._recordRolloutEvent({ action: 'search', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (beRes && (beRes.reason || beRes.status)) || 'not_verified', latencyMs: ms });
          }
        } catch (err) {
          this._recordRolloutEvent({ action: 'search', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (err && err.message) || 'exception', latencyMs: performance.now() - t0 });
        }
      }
      if (this.navigator && typeof this.navigator.executeSearch === 'function') {
        const legacyRes = await this.navigator.executeSearch(query, opts);
        const legacyStatus = String((legacyRes && legacyRes.status) || '');
        const isFailed = !legacyRes || ['no_search_field', 'empty_query', 'cancelled', 'duplicate_blocked', 'value_verification_failed'].includes(legacyStatus) || legacyRes.verified === false;
        return {
          ...(legacyRes || {}),
          ok: !isFailed,
          verified: Boolean(legacyRes && legacyRes.verified),
          status: legacyStatus || (isFailed ? 'failed' : 'searched'),
          reason: (legacyRes && (legacyRes.reason || legacyRes.message)) || (isFailed ? legacyStatus : undefined),
          message: (legacyRes && legacyRes.message) || (legacyStatus === 'no_search_field' ? 'Could not find a search field on this page.' : undefined),
          engine: 'legacy',
          fallback_from_rebuilt: Boolean(this.useRebuiltBrowserEngine)
        };
      }
      return { status: 'no_search_field', ok: false, verified: false, reason: 'no_search_field', message: 'Could not find a search field on this page.', engine: 'legacy' };
    }

    async _executeFillInputWithEngine(args = {}, rawText = '') {
      const target = String(args.target || args.field || '').trim();
      const value = args.value !== undefined ? String(args.value) : String(args.text || '').trim();
      if (this.useStagehandAdapter && this.stagehandAdapter && value) {
        const t0 = performance.now();
        const shRes = await this.stagehandAdapter.act('fill', target || 'search', value, {
          commandId: args.cmdId || `sw-fill-${Date.now().toString(36)}`,
          signal: (this.taskLifecycle && this.taskLifecycle.abortController) ? this.taskLifecycle.abortController.signal : null
        });
        const ms = performance.now() - t0;
        if (shRes && shRes.ok && shRes.result) {
          const typedVal = shRes.result.details && shRes.result.details.typedValue;
          const verified = typeof typedVal === 'string' && typedVal.toLowerCase().includes(value.toLowerCase());
          this._recordRolloutEvent({ action: 'fill_input', engine: 'stagehand_adapter', outcome: verified ? 'success' : 'fallback', latencyMs: ms });
          if (verified) {
            const msg = `Entered "${value}" into ${target || 'input field'}.`;
            this.setAssistantReply(msg);
            return {
              status: 'filled',
              ok: true,
              verified: true,
              engine: 'stagehand_adapter',
              stagehandVersion: shRes.stagehandVersion || null,
              llmUsed: Boolean(shRes.result.llmUsed),
              field: target || (shRes.result.details && shRes.result.details.field && (shRes.result.details.field.ariaLabel || shRes.result.details.field.placeholder || shRes.result.details.field.name)) || 'input',
              value: typedVal,
              url: shRes.result.urlAfter || window.location.href,
              domEvidence: shRes.result.details || null,
              ownership: shRes.ownershipDuringOp || null
            };
          }
          return {
            status: 'verification_failed',
            ok: false,
            verified: false,
            engine: 'stagehand_adapter',
            message: `Input field fill could not be verified (observed value: ${typedVal}).`
          };
        }
        return {
          status: (shRes && shRes.code === 'CANCELLED') ? 'task_cancelled' : 'stagehand_disconnected',
          ok: false,
          verified: false,
          recoverable: true,
          engine: 'stagehand_adapter',
          code: (shRes && shRes.code) || 'STAGEHAND_UNAVAILABLE',
          error: (shRes && shRes.error) || 'Stagehand fill unavailable',
          message: (shRes && shRes.error) || 'Stagehand fill unavailable'
        };
      }
      if (this.browserEngine && this.useRebuiltBrowserEngine && typeof this.browserEngine.type === 'function' && value) {
        const t0 = performance.now();
        try {
          const beRes = await this.browserEngine.type(target, value, { clear: args.action !== 'append' });
          const ms = performance.now() - t0;
          if (beRes && beRes.status === 'SENSITIVE_SKIPPED') {
            this._recordRolloutEvent({ action: 'fill_input', engine: 'rebuilt_browser_engine', outcome: 'success', reason: 'sensitive_skipped', latencyMs: ms });
            const warnMsg = 'Protected sensitive field (password or financial credential) cannot be filled automatically.';
            this.setAssistantReply(warnMsg);
            if (window.SW_UI) {
              window.SW_UI.setState('speaking');
              window.SW_UI.showCard({ type: 'answer', title: 'Protected Field', text: warnMsg });
            }
            return { status: 'sensitive_skipped', ok: false, verified: false, engine: 'rebuilt_browser_engine', reason: beRes.reason, protected: true };
          }
          if (beRes && (beRes.status === 'SUCCESS' || beRes.verified)) {
            this._recordRolloutEvent({ action: 'fill_input', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: ms });
            this.lastUndoableType = 'forms';
            const msg = `Entered "${value}" into ${beRes.targetLabel || target || 'field'}.`;
            this.setAssistantReply(msg);
            if (window.SW_UI) {
              window.SW_UI.setState('speaking');
              window.SW_UI.showCard({ type: 'answer', title: 'Field Updated', text: msg });
            }
            return {
              status: 'filled',
              ok: true,
              verified: true,
              engine: 'rebuilt_browser_engine',
              field: beRes.targetLabel || target,
              value,
              message: msg
            };
          }
          if (beRes && beRes.status === 'AMBIGUOUS') {
            this._recordRolloutEvent({ action: 'fill_input', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: 'ambiguous_inputs', latencyMs: ms });
          } else {
            this._recordRolloutEvent({ action: 'fill_input', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (beRes && (beRes.reason || beRes.status)) || 'not_verified', latencyMs: ms });
          }
        } catch (err) {
          this._recordRolloutEvent({ action: 'fill_input', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (err && err.message) || 'exception', latencyMs: performance.now() - t0 });
        }
      }
      if (this.forms && typeof this.forms.handleDictateIntent === 'function') {
        this.lastUndoableType = 'forms';
        const legacyRes = await this.forms.handleDictateIntent(args, rawText);
        return {
          ...(legacyRes || {}),
          engine: 'legacy',
          fallback_from_rebuilt: Boolean(this.useRebuiltBrowserEngine)
        };
      }
      return { status: 'not_found', ok: false, verified: false, engine: 'legacy' };
    }

    async _tryRebuiltDropdownSelect(rawText = '', opts = {}) {
      if (!this.browserEngine || !this.useRebuiltBrowserEngine || typeof this.browserEngine.select !== 'function') {
        return null;
      }
      const clean = String(rawText || '').trim().replace(/[.,!?;:]+$/, '');
      const isExplicitToggle = /^(?:(?:please|can\s+you|could\s+you|now)\s+)?(?:check|uncheck|tick|untick|toggle|enable|disable)\b/i.test(clean) || /\b(?:checkbox|radio)\b/i.test(clean);
      const wantsUncheck = /\b(?:uncheck|untick|disable)\b/i.test(clean);

      // Milestone 4: Tab switch command ("Switch to Analytics tab", "Select the Overview tab", "Click Analytics tab")
      const tabCmdM = clean.match(/^(?:(?:please|can\s+you|could\s+you|now)\s+)?(?:switch\s+to|select|choose|click(?:\s+on)?|open|go\s+to)\s+(?:the\s+)?(.+?)(?:\s+tab)?$/i);
      if (!isExplicitToggle && tabCmdM && (/\btab\b/i.test(clean) || document.querySelector('[role="tab"]')) && typeof this.browserEngine.switchTab === 'function') {
        const tabName = tabCmdM[1].replace(/\s+tab$/i, '').trim();
        const obs = this.browserEngine.observe(document);
        const hasMatchingTab = obs.elements.some(e => e.role === 'tab' && e.name.toLowerCase().includes(tabName.toLowerCase()));
        if (hasMatchingTab) {
          const t0 = performance.now();
          try {
            const tabRes = await this.browserEngine.switchTab(tabName);
            const ms = performance.now() - t0;
            if (tabRes && (tabRes.status === 'SUCCESS' || tabRes.verified)) {
              this._recordRolloutEvent({ action: 'switch_tab', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: ms });
              const msg = `Switched to "${tabName}" tab.`;
              this.setAssistantReply(msg);
              if (window.SW_UI) {
                window.SW_UI.setState('speaking');
                window.SW_UI.showCard({ type: 'answer', title: 'Tab Switched', text: msg });
              }
              return { status: 'selected', ok: true, verified: true, engine: 'rebuilt_browser_engine', selectedOption: tabName, field: 'Tab', message: msg };
            }
          } catch (err) {
            this._recordRolloutEvent({ action: 'switch_tab', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (err && err.message) || 'exception', latencyMs: performance.now() - t0 });
          }
        }
      }

      let optionText = opts.optionText || '';
      let groupHint = opts.groupHint || '';
      if (!optionText) {
        const scopedM = clean.match(/^(?:(?:please|can\s+you|could\s+you|now)\s+)?(?:select|choose|pick|check|uncheck|tick|untick|toggle|enable|disable)\s+(?:the\s+)?(.+?)(?:\s+(?:option|checkbox|radio(?:\s+button)?))?\s+(?:from|in|under|inside|for)\s+(?:the\s+)?(.+?)(?:\s+(?:dropdown|menu|select|list|field|group|section))?$/i);
        const simpleM = !scopedM ? clean.match(/^(?:(?:please|can\s+you|could\s+you|now)\s+)?(?:select|choose|pick|check|uncheck|tick|untick|toggle|enable|disable)\s+(?:the\s+)?(.+?)(?:\s+(?:option|checkbox|radio(?:\s+button)?))?$/i) : null;
        if (scopedM) {
          optionText = scopedM[1].trim();
          groupHint = scopedM[2].trim();
        } else if (simpleM) {
          optionText = simpleM[1].trim();
        }
      }
      if (!optionText) return null;

      // Try Dropdown selection first unless explicitly a checkbox/radio toggle
      if (!isExplicitToggle) {
        const t0 = performance.now();
        try {
          const beRes = await this.browserEngine.select(groupHint || '', optionText, { section: groupHint || '' });
          const ms = performance.now() - t0;
          if (beRes && (beRes.status === 'SUCCESS' || beRes.verified)) {
            this._recordRolloutEvent({ action: 'select_dropdown', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: ms });
            if (this.worldModel && typeof this.worldModel.scheduleProactiveScan === 'function') {
              this.worldModel.scheduleProactiveScan(document, { force: true, delayMs: 60 });
            }
            const msg = `Selected "${beRes.selectedText || optionText}"${beRes.targetLabel ? ` in ${beRes.targetLabel}` : ''}.`;
            this.setAssistantReply(msg);
            if (window.SW_UI) {
              window.SW_UI.setState('speaking');
              window.SW_UI.showCard({ type: 'answer', title: 'Updated Control', text: msg });
            }
            return {
              status: 'selected',
              ok: true,
              verified: true,
              engine: 'rebuilt_browser_engine',
              selectedOption: beRes.selectedText || optionText,
              selectedValue: beRes.selectedValue,
              field: beRes.targetLabel || groupHint || 'Dropdown',
              message: msg
            };
          }
          if (beRes && beRes.status === 'AMBIGUOUS') {
            this._recordRolloutEvent({ action: 'select_dropdown', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: 'ambiguous_dropdowns', latencyMs: ms });
            return null;
          }
        } catch (err) {
          this._recordRolloutEvent({ action: 'select_dropdown', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (err && err.message) || 'exception', latencyMs: performance.now() - t0 });
        }
      }

      // Milestone 5: Checkbox / Radio button selection
      if (typeof this.browserEngine.toggleControl === 'function') {
        const t0 = performance.now();
        try {
          const togRes = await this.browserEngine.toggleControl(optionText, {
            section: groupHint || '',
            desiredChecked: /\btoggle\b/i.test(clean) ? null : !wantsUncheck
          });
          const ms = performance.now() - t0;
          if (togRes && (togRes.status === 'SUCCESS' || togRes.verified)) {
            this._recordRolloutEvent({ action: 'toggle_checkbox_radio', engine: 'rebuilt_browser_engine', outcome: 'success', latencyMs: ms });
            if (this.worldModel && typeof this.worldModel.scheduleProactiveScan === 'function') {
              this.worldModel.scheduleProactiveScan(document, { force: true, delayMs: 60 });
            }
            const msg = `${togRes.checked ? 'Selected' : 'Unchecked'} "${togRes.targetLabel || optionText}".`;
            this.setAssistantReply(msg);
            if (window.SW_UI) {
              window.SW_UI.setState('speaking');
              window.SW_UI.showCard({ type: 'answer', title: 'Updated Control', text: msg });
            }
            return {
              status: 'selected',
              ok: true,
              verified: true,
              engine: 'rebuilt_browser_engine',
              selectedOption: togRes.targetLabel || optionText,
              checked: togRes.checked,
              field: togRes.role || 'Control',
              message: msg
            };
          }
          if (togRes && togRes.status === 'AMBIGUOUS') {
            this._recordRolloutEvent({ action: 'toggle_checkbox_radio', engine: 'rebuilt_browser_engine', outcome: 'clarification', reason: 'ambiguous_controls', latencyMs: ms });
          }
        } catch (err) {
          this._recordRolloutEvent({ action: 'toggle_checkbox_radio', engine: 'rebuilt_browser_engine', outcome: 'fallback', reason: (err && err.message) || 'exception', latencyMs: performance.now() - t0 });
        }
      }
      return null;
    }

    async dispatchIntent(c, rawText = '', resolvedContext = null) {
      const intent = (c && c.intent) || 'HELP';
      const args = (c && c.args) || {};
      const conf = typeof c.confidence === 'number' ? c.confidence : 0.8;
      const cmdId = (c && c.cmdId) || `sw-${Date.now().toString(36)}`;
      this._setStatusChip(`Executing: ${intent.toLowerCase().replace(/_/g, ' ')}...`);

      if ((intent === 'SEARCH' || (intent === 'NAVIGATE' && args.action === 'search')) && (this.navigator || this.browserEngine)) {
        const query = args.query || args.target || rawText;
        return this._executeSearchWithEngine(query, {
          siteHint: args.siteHint || '',
          scopeHint: args.scopeHint || '',
          rawQuery: args.rawQuery || query,
          rawCommand: args.rawCommand || rawText,
          confidence: conf,
          cmdId,
          rawTranscript: rawText,
          normalizedTranscript: (c && c.normalized) || ''
        });
      }
      if (intent === 'READ') {
        if (this.useStagehandAdapter && this.stagehandAdapter && args.scope !== 'section') {
          return this._extractVisiblePageInfoWithStagehand(rawText, {
            cmdId,
            taskSignal: (this.taskLifecycle && this.taskLifecycle.abortController) ? this.taskLifecycle.abortController.signal : null
          });
        }
        return args.scope === 'section' && args.target ? this.readSection(args.target) : this.readPage();
      }
      if (intent === 'EXPLAIN') return this.explainPage({ mode: args.mode || (args.target ? 'section' : 'summary'), level: args.level || 'standard', target: args.target || '', lang: this.resolveReplyLang(c) });
      if (intent === 'ANSWER') {
        const effectiveQuery = (resolvedContext && resolvedContext.resolvedText) || args.query || rawText;
        const isExplicitQuestion = /[?？]/.test(rawText) || /^(?:what|when|where|who|whom|whose|which|how|why|can|could|do|does|is|are|should|will|would|tell\s+me|kya|kab|kahan|kaise|kyun|kitna|kitni|kitne|kaun|क्या|कब|कहाँ|कैसे|क्यों|कितना|कितनी|कौन)\b/i.test((c && c.normalized) || rawText);
        if (c && c.ruleId === 'low_confidence_unmatched' && c.source === 'fallback' && !isExplicitQuestion) {
          const repMsg = 'I did not catch that command clearly. Please repeat, or say "Search for...", "Explain this page", or "Read this page".';
          this.setAssistantReply(repMsg);
          if (window.SW_UI) { window.SW_UI.setState('speaking'); window.SW_UI.showCard({ type: 'answer', title: 'Please Repeat', text: repMsg }); }
          if (this.reader) this.reader.readText(repMsg);
          return { status: 'unrecognized_repeat', message: repMsg };
        }
        return this.explainPage({ mode: 'qa', query: effectiveQuery, level: 'standard', lang: this.resolveReplyLang(c), isFollowUp: Boolean(resolvedContext && resolvedContext.isFollowUp) });
      }
      if (intent === 'NAVIGATE' && this.useStagehandAdapter && this.stagehandAdapter && args && (args.target || args.action === 'click' || args.action === 'open')) {
        const clickTarget = String(args.target || rawText).replace(/^(?:click|open|select|press|tap)\s+(?:on\s+)?(?:the\s+)?/i, '').trim();
        if (clickTarget && args.action !== 'scroll' && args.action !== 'history') {
          return this._executeClickWithStagehand(clickTarget, {
            cmdId,
            taskSignal: (this.taskLifecycle && this.taskLifecycle.abortController) ? this.taskLifecycle.abortController.signal : null
          });
        }
      }
      if (intent === 'NAVIGATE' && this.navigator) return this.navigator.handleNavigationIntent(args, conf, rawText);
      if (intent === 'FILL_GUIDED' && this.forms) return this.forms.startGuidedFill();
      if (intent === 'DICTATE' && (this.forms || this.browserEngine)) { this.lastUndoableType = 'forms'; return this._executeFillInputWithEngine(args, rawText); }
      if (intent === 'FILL_PROFILE' && this.forms) { this.lastUndoableType = 'forms'; return this.forms.fillFromProfile(); }
      if (intent === 'UPLOAD') return (args.mode === 'camera' && this.camera) ? this.camera.requestCapture(args.target || rawText) : (this.upload && this.upload.requestUpload(args.target || rawText));
      if (intent === 'UNDO') return (this.lastUndoableType === 'upload' && this.upload && this.upload.uploadUndoStack.length) ? this.upload.undoLastUpload() : (this.forms && this.forms.undoLast());
      if (intent === 'CHANGE_LANGUAGE') {
        const locale = args.locale || 'en-IN';
        const langName = args.language || '';
        return this.applyLanguageSwitch(locale, langName, cmdId);
      }
      if (intent === 'CONTROL') {
        if (args.action === 'pause') this.reader.pause();
        else if (args.action === 'resume') this.reader.resume();
        else if (args.action === 'stop') this.stopReading();
        else if (args.action === 'repeat') this.reader.readAgain();
        else if (args.action === 'language') this.setLanguage(args.lang || 'en-IN');
        return { status: 'control_applied', action: args.action };
      }
      const msg = 'Commands: "Explain this page", "Read this page", "Fill this form", "Upload photo", or "Take a photo".';
      this.setAssistantReply(msg);
      if (window.SW_UI) { window.SW_UI.setState('speaking'); window.SW_UI.showCard({ type: 'answer', title: 'Help', text: msg }); }
      return { status: 'help', message: msg };
    }

    readPage() {
      this.reader.setLang(this.getEffectiveSpeechLang(this.lang));
      if (this.browserEngine && this.useRebuiltBrowserEngine && typeof this.browserEngine.readContent === 'function') {
        const rT0 = performance.now();
        const rc = this.browserEngine.readContent('page');
        this._recordRolloutEvent({ action: 'read_page', engine: 'rebuilt_browser_engine', outcome: rc.verified ? 'success' : 'fallback', latencyMs: performance.now() - rT0 });
        if (rc && rc.verified && rc.text) {
          this.reader.readText(rc.text.slice(0, 1200));
          if (window.SW_UI) {
            window.SW_UI.setState('speaking');
            window.SW_UI.showCard({
              type: 'summary',
              title: 'Reading Page',
              text: rc.text.slice(0, 260)
            });
          }
          return { status: 'reading_page', verified: true, engine: 'rebuilt_browser_engine', wordCount: rc.wordCount, text: rc.text.slice(0, 400) };
        }
      }
      this.reader.readPage();
      return { status: 'reading_page' };
    }
    readSection(q) {
      if (this.browserEngine && this.useRebuiltBrowserEngine && typeof this.browserEngine.readContent === 'function') {
        const rT0 = performance.now();
        const rc = this.browserEngine.readContent(q);
        this._recordRolloutEvent({ action: 'read_section', engine: 'rebuilt_browser_engine', outcome: rc.verified ? 'success' : 'fallback', latencyMs: performance.now() - rT0 });
        if (rc && rc.verified && rc.text) {
          if (rc.element && typeof rc.element.scrollIntoView === 'function') {
            try { rc.element.scrollIntoView({ behavior: 'instant', block: 'start' }); } catch (_e) {}
          }
          const preview = rc.text.slice(0, 260);
          this.reader.setLang(this.getEffectiveSpeechLang(this.lang));
          this.reader.readText(rc.text.slice(0, 900));
          if (window.SW_UI) {
            window.SW_UI.setState('speaking');
            window.SW_UI.showCard({
              type: 'summary',
              title: `Section: ${rc.heading || q}`,
              text: preview
            });
          }
          return { status: 'reading_section', verified: true, engine: 'rebuilt_browser_engine', section: rc.heading || q, text: preview };
        }
      }
      if (this.outline && (!this.outline.items || this.outline.items.length === 0) && typeof this.outline.extractOutline === 'function') {
        this.outline.extractOutline();
      }
      const h = this.outline ? this.outline.fuzzyFindHeading(q) : null;
      if (h) {
        if (typeof this.outline.scrollToHeading === 'function') this.outline.scrollToHeading(h);
        const els = Array.isArray(h.sectionElements) && h.sectionElements.length > 0 ? h.sectionElements : (h.element ? [h.element] : []);
        this.reader.readHeadingSection(h);
        if (window.SW_UI) {
          const preview = els.map((e) => (e && (e.innerText || e.textContent)) || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 260);
          window.SW_UI.setState('speaking');
          window.SW_UI.showCard({
            type: 'summary',
            title: `Section: ${h.text || q}`,
            text: preview || `Moved to ${h.text || q}.`
          });
        }
        return { status: 'reading_section', section: h.text };
      }
      if (window.SW_UI) window.SW_UI.showCard({ type: 'error', title: 'Section Not Found', text: `No section matching "${q}".` });
      return { status: 'not_found' };
    }
    stopReading() {
      if (this.explainer) this.explainer.abort();
      if (this.reader && typeof this.reader.cancelStream === 'function') this.reader.cancelStream();
      else if (this.reader) this.reader.stop();
    }
    explainPage(opts) { if (this.explainer) return Promise.resolve(this.explainer.runExplainPipeline(opts)).catch(() => null); return Promise.resolve(null); }

    handleConfirmStateChange({ pending, plan } = {}) {
      if (!window.SW_UI) return;
      if (pending) {
        const isCh = Array.isArray(pending.options) && pending.options.length > 0;
        window.SW_UI.setState('confirm');
        window.SW_UI.showCard({
          type: isCh ? 'choices' : 'confirm', title: pending.title || 'Confirm', text: pending.message || '',
          stepLabel: !isCh && pending.requiredSteps > 1 ? `Step ${pending.step || 1} of ${pending.requiredSteps}` : '',
          summaryLines: pending.summary || [], choices: isCh ? pending.options.slice(0, 5) : undefined,
          actions: isCh ? [{ id: 'cancel', label: 'Cancel' }] : [{ id: 'yes', label: 'Yes', primary: true }, { id: 'no', label: 'No' }],
          onAction: (id, d) => ((id === 'yes' || (id === 'choose' && d)) ? this.confirm.confirm(d ? d.index : undefined) : this.confirm.cancel('user_denied'))
        });
      } else if (plan && plan.status !== 'done' && plan.status !== 'cancelled') {
        window.SW_UI.setState('confirm');
        window.SW_UI.showCard({ type: 'plan', title: plan.title, steps: plan.steps, actions: [{ id: 'cancel', label: 'Cancel Plan' }], onAction: () => this.confirm.cancelPlan('user_cancelled') });
      } else if (['confirm', 'choices', 'plan'].includes(window.SW_UI.getCardType())) {
        window.SW_UI.hideCard();
      }
    }

    handleUploadCardChange(cs) {
      if (!window.SW_UI || !this.upload) return;
      if (!cs || !cs.target) { if (window.SW_UI.getCardType() === 'file') window.SW_UI.hideCard(); return; }
      const { target, stage, selectedFile, error, canCompress, shelfMatch, shelfNote, shelfNeedsReauth } = cs;
      const acts = [];
      if (stage === 'choose' || stage === 'validation_error') {
        acts.push({ id: 'choose_file', label: 'Choose File', primary: true });
        if (canCompress && selectedFile) acts.push({ id: 'compress', label: 'Compress Photo' });
        if (shelfMatch) acts.push({ id: 'use_shelf', label: `Shelf: ${shelfMatch.name}` });
        if (!target.accept || /image|\.(?:jpe?g|png|webp)/i.test(target.accept)) acts.push({ id: 'use_camera', label: 'Use Camera' });
        if (shelfNeedsReauth) acts.push({ id: 'shelf_setup', label: 'Re-allow Shelf' });
      } else if (stage === 'attached') { this.lastUndoableType = 'upload'; acts.push({ id: 'undo', label: 'Undo' }); }
      acts.push({ id: 'cancel', label: stage === 'attached' ? 'Done' : 'Cancel' });
      window.SW_UI.setState(stage === 'validation_error' ? 'error' : 'confirm');
      window.SW_UI.showCard({
        type: 'file', title: stage === 'attached' ? 'File Attached' : 'Upload Document', fieldLabel: target.label || 'File upload',
        fileInfo: error || (selectedFile ? selectedFile.name : (shelfNote || 'Tap Choose File to select a file.')),
        targetEl: target.element || target.dropZone || null, useCardPicker: stage === 'choose' || stage === 'validation_error',
        onFilePick: (f) => this.upload.handleSelectedFile(f, target), actions: acts,
        onAction: async (id) => {
          if (id === 'compress' && selectedFile) { const c = await this.upload.compressImageToTargetLimit(selectedFile, target.maxBytes); if (c) this.upload.handleSelectedFile(c, target); }
          else if (id === 'use_shelf' && shelfMatch) this.upload[shelfMatch.fileHandle ? 'pickFromShelfEntry' : 'pickFromExtensionShelf'](shelfMatch, target);
          else if (id === 'use_camera' && this.camera) { this.upload.clearFileCard(); this.camera.requestCapture(target.label || 'photo', target); }
          else if (id === 'shelf_setup') this.upload.openShelfSetup();
          else if (id === 'undo') this.upload.undoLastUpload();
          else this.upload.clearFileCard();
        }
      });
    }

    handleCameraCardChange(cs) {
      if (!window.SW_UI || !this.camera) return;
      if (!cs || !cs.target) { if (window.SW_UI.getCardType() === 'file') window.SW_UI.hideCard(); return; }
      const acts = [];
      if (cs.stage === 'live' || cs.stage === 'countdown') acts.push({ id: 'shoot', label: 'Take Photo (3-2-1)', primary: true });
      else if (cs.stage === 'preview') acts.push({ id: 'attach', label: 'Use This Photo', primary: true }, { id: 'retake', label: 'Retake' });
      else if (cs.stage === 'permission_help') acts.push({ id: 'retry', label: 'Retry Camera', primary: true }, { id: 'fallback', label: 'Choose File' });
      acts.push({ id: 'cancel', label: 'Cancel' });
      window.SW_UI.setState(cs.stage === 'permission_help' ? 'error' : 'confirm');
      window.SW_UI.showCard({
        type: 'file', title: (cs.stage === 'live' || cs.stage === 'countdown') ? `● Camera on${cs.countdown ? ` (${cs.countdown}...)` : ''}` : 'Camera Capture',
        fieldLabel: cs.target.label || 'Photo', text: cs.error || (Array.isArray(cs.helpSteps) ? cs.helpSteps.join(' ') : ''),
        mediaStream: (cs.stage === 'live' || cs.stage === 'countdown') ? cs.stream : null, previewUrl: cs.stage === 'preview' ? cs.previewUrl : '',
        targetEl: cs.target.element || null, actions: acts,
        onAction: (id) => {
          if (id === 'shoot') this.camera.captureWithCountdown(3);
          else if (id === 'attach') this.camera.confirmAttach();
          else if (id === 'retake') this.camera.retake();
          else if (id === 'retry') this.camera.startCamera(cs.target);
          else if (id === 'fallback' && this.upload) { const t = cs.target; this.camera.cancelCapture(); this.upload._openChooseFileCard(t); }
          else this.camera.cancelCapture();
        }
      });
    }

    _formatCrossTabComparison(siteA, siteB) {
      const fmt = (s) => {
        if (!s) return 'Unknown site';
        const facts = Array.isArray(s.keyFacts) && s.keyFacts.length > 0 ? s.keyFacts[0] : (s.topic || s.urlClean);
        return `${s.title} (${s.urlClean}): ${facts}`;
      };
      return `Comparing across tabs — ${fmt(siteA)} versus ${fmt(siteB)}`;
    }

    _maybeBuildProactiveBar(lastCommand = '') {
      const pi = window.SleepwalkerPersonalIntel || null;
      if (!pi || !this.memory || !this.memory.state) return {};
      if (this.memory.privacy && this.memory.privacy.proactiveEnabled === false) return {};
      if (this.confirm && this.confirm.isAwaiting()) return {};

      const sug = pi.evaluateProactiveSuggestion(this.memory.state, {
        lastCommand,
        hasPendingPrompt: false,
        isAwaitingConfirm: Boolean(this.confirm && this.confirm.isAwaiting())
      });
      if (!sug) return {};
      pi.markSuggestionShown(this.memory.state, sug.id);
      return {
        proactiveSuggestion: sug,
        onProactiveAccept: (s) => {
          if (s && s.commandText) this.handleUserInput(s.commandText, 'proactive_accepted', { noPreempt: true });
        },
        onProactiveDismiss: (s) => {
          if (s && s.id) {
            pi.dismissSuggestion(this.memory.state, s.id);
            void this.memory.saveState({ skipTabSync: true });
          }
        }
      };
    }

    async _handlePersonalControlRoute(central, raw) {
      if (!this.memory) return null;
      const sub = central.subAction;
      let msg = '';
      let title = 'Personal Preferences & Memory';
      let extraSpec = {};

      if (sub === 'toggle_learning_privacy') {
        const enabled = Boolean(central.enabled);
        await this.memory.setPrivacySettings({ learningEnabled: enabled });
        title = 'Adaptive Learning Updated';
        msg = enabled
          ? 'Adaptive interaction learning is now enabled.'
          : 'Adaptive interaction learning is now disabled. Sleepwalker will not infer new patterns from your actions.';
      } else if (sub === 'toggle_proactive_privacy') {
        const enabled = Boolean(central.enabled);
        await this.memory.setPrivacySettings({ proactiveEnabled: enabled });
        title = 'Proactive Suggestions Updated';
        msg = enabled
          ? 'Proactive next-step suggestions are now enabled.'
          : 'Proactive next-step suggestions are now disabled. Sleepwalker will only respond when asked.';
      } else if (sub === 'clear_personal_context') {
        await this.memory.clearPersonalContext('all');
        title = 'Personal Context Cleared';
        msg = 'Cleared your stored personal projects, preferences, and inferred learning signals.';
      } else if (sub === 'correct_memory') {
        const cRes = await this.memory.correctRememberedDetail(raw);
        title = cRes.ok ? 'Memory Updated' : 'Clarify Correction';
        msg = cRes.message;
      } else if (sub === 'set_preference') {
        if (this.memory.privacy.memoryPaused) {
          msg = 'Memory collection is paused in Privacy Settings, so preferences are kept for this session only or until unpaused.';
        } else {
          await this.memory.setExplicitPreference(central.prefKey, central.prefValue, central.prefLabel);
          msg = `Saved explicit preference: ${central.prefLabel || central.prefKey}.`;
        }
        title = 'Preference Saved';
      } else if (sub === 'inspect_personal_context') {
        const ov = this.memory.getPersonalContextOverview();
        const prefLines = ov.preferences.length > 0
          ? ov.preferences.map((p) => `${p.key}: ${p.value} (${p.source})`)
          : ['No stored preferences yet.'];
        const projLines = ov.projects.slice(0, 3).map((p) => `Project "${p.title}" (${p.entities.length} topics/entities)`);
        const lines = [
          `Privacy: learning=${ov.privacyControls.learningEnabled ? 'on' : 'off'}, proactive=${ov.privacyControls.proactiveEnabled ? 'on' : 'off'}, memoryPaused=${ov.privacyControls.memoryPaused ? 'yes' : 'no'}.`,
          ...prefLines,
          ...projLines
        ];
        if (ov.activeTask) {
          lines.push(`Active task: ${ov.activeTask.objective} (${ov.activeTask.status}).`);
        }
        msg = lines.join(' ');
        extraSpec = { numberedItems: lines.slice(0, 6) };
        title = 'What Sleepwalker Remembers';
      }

      this.setAssistantReply(msg);
      if (window.SW_UI) {
        window.SW_UI.setState('speaking');
        window.SW_UI.showCard({ type: 'answer', title, text: msg, ...extraSpec });
      }
      if (this.reader) this.reader.readText(msg);
      return { status: sub, answer: msg, message: msg };
    }

    async _handleReminderRoute(central, raw) {
      const sendSw = (msgObj) => new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve({ ok: false, error: 'Background alarms service unavailable.' });
          return;
        }
        chrome.runtime.sendMessage(msgObj, (res) => {
          void chrome.runtime?.lastError;
          resolve(res || { ok: false });
        });
      });

      if (central.subAction === 'schedule_reminder') {
        const r = central.reminder;
        if (!r || r.requiresDateClarification) {
          const ask = 'I do not have an exact deadline date saved yet for that reminder. Please tell me the date or say e.g. "Remind me tomorrow".';
          this.setAssistantReply(ask);
          if (window.SW_UI) { window.SW_UI.setState('speaking'); window.SW_UI.showCard({ type: 'answer', title: 'Date Needed', text: ask }); }
          if (this.reader) this.reader.readText(ask);
          return { status: 'needs_date', message: ask };
        }
        r.url = window.location.href;
        r.projectTopic = (this.memory && this.memory.state.currentTopic) || r.projectTopic || '';
        const scheduleNow = async () => {
          const res = await sendSw({ type: 'SLEEPWALKER_REMINDER_SCHEDULE', reminder: { ...r, authorized: true } });
          const doneMsg = res && res.ok
            ? `Scheduled reminder "${r.title}" for ${new Date(res.reminder.targetTimeMs).toLocaleString()}.`
            : `Could not schedule reminder: ${(res && res.error) || 'error'}.`;
          this.setAssistantReply(doneMsg);
          if (window.SW_UI) { window.SW_UI.setState('speaking'); window.SW_UI.showCard({ type: 'answer', title: 'Reminder Scheduled', text: doneMsg }); }
          if (this.reader) this.reader.readText(doneMsg);
          return { status: res && res.ok ? 'reminder_scheduled' : 'error', reminder: res && res.reminder, message: doneMsg };
        };
        if (this.confirm) {
          this.confirm.request({
            id: `rem_auth_${Date.now()}`,
            risk: 'high',
            confidence: 0.92,
            title: 'Authorize Scheduled Reminder',
            message: r.explanation,
            summary: [`Title: ${r.title}`, `When: ${r.timeDesc} (${new Date(r.targetTimeMs).toLocaleString()})`, `Type: ${r.checkType}`],
            onConfirm: async () => await scheduleNow(),
            onCancel: () => {
              const cancelMsg = 'Reminder cancelled.';
              this.setAssistantReply(cancelMsg);
              if (window.SW_UI) { window.SW_UI.setState('speaking'); window.SW_UI.showCard({ type: 'answer', title: 'Cancelled', text: cancelMsg }); }
            }
          });
          return { status: 'awaiting_authorization', message: r.explanation };
        }
        return scheduleNow();
      }

      if (central.subAction === 'list_reminders') {
        const res = await sendSw({ type: 'SLEEPWALKER_REMINDER_LIST' });
        const activeList = ((res && res.reminders) || []).filter((x) => x && (x.status === 'scheduled' || x.status === 'due'));
        const msg = activeList.length === 0
          ? 'You have no active scheduled reminders right now.'
          : activeList.map((x, i) => `${i + 1}. [${x.status.toUpperCase()}] ${x.title} — ${new Date(x.targetTimeMs).toLocaleString()}`).join('\n');
        this.setAssistantReply(msg);
        if (window.SW_UI) {
          window.SW_UI.setState('speaking');
          window.SW_UI.showCard({
            type: 'answer',
            title: `Reminders (${activeList.length})`,
            text: activeList.length === 0 ? msg : `You have ${activeList.length} active reminder(s):`,
            numberedItems: activeList.length > 0 ? activeList.map((x) => `[${x.status.toUpperCase()}] ${x.title} — ${new Date(x.targetTimeMs).toLocaleString()}`) : undefined
          });
        }
        if (this.reader) this.reader.readText(msg);
        return { status: 'reminders_listed', reminders: activeList, answer: msg };
      }

      if (central.subAction === 'cancel_reminder') {
        const res = await sendSw({ type: 'SLEEPWALKER_REMINDER_CANCEL', query: raw });
        const msg = res && res.ok ? `Cancelled reminder "${res.reminder.title}".` : 'No matching active reminder found to cancel.';
        this.setAssistantReply(msg);
        if (window.SW_UI) { window.SW_UI.setState('speaking'); window.SW_UI.showCard({ type: 'answer', title: 'Reminder Cancelled', text: msg }); }
        if (this.reader) this.reader.readText(msg);
        return { status: res && res.ok ? 'reminder_cancelled' : 'not_found', message: msg };
      }

      if (central.subAction === 'update_reminder') {
        const listRes = await sendSw({ type: 'SLEEPWALKER_REMINDER_LIST' });
        const latest = ((listRes && listRes.reminders) || []).filter((x) => x && x.status === 'scheduled').slice(-1)[0];
        if (!latest) {
          const msg = 'No scheduled reminder found to reschedule.';
          if (window.SW_UI) window.SW_UI.showCard({ type: 'answer', title: 'Reminders', text: msg });
          return { status: 'not_found', message: msg };
        }
        const pi = window.SleepwalkerPersonalIntel || null;
        const parsedTime = pi ? pi.parseReminderRequest(`Remind me ${raw}`, Date.now(), {}) : null;
        const nextMs = (parsedTime && parsedTime.targetTimeMs) || (Date.now() + 86400000);
        const upRes = await sendSw({ type: 'SLEEPWALKER_REMINDER_UPDATE', id: latest.id, patch: { targetTimeMs: nextMs } });
        const msg = upRes && upRes.ok ? `Moved reminder "${latest.title}" to ${new Date(nextMs).toLocaleString()}.` : 'Could not update reminder.';
        this.setAssistantReply(msg);
        if (window.SW_UI) window.SW_UI.showCard({ type: 'answer', title: 'Reminder Updated', text: msg });
        if (this.reader) this.reader.readText(msg);
        return { status: upRes && upRes.ok ? 'reminder_updated' : 'error', reminder: upRes && upRes.reminder, message: msg };
      }

      return null;
    }

    _handleDueReminderPopup(reminder) {
      if (!reminder || !reminder.title) return;
      if (!this._pendingDueReminders.some((r) => r.id === reminder.id)) {
        this._pendingDueReminders.push(reminder);
      }
      if ((this.confirm && this.confirm.isAwaiting()) || (this.dialogue && this.dialogue.pendingPrompt)) return;
      const msg = `Reminder Due: ${reminder.title}${reminder.url ? ` (${reminder.url})` : ''}`;
      if (window.SW_UI) {
        if (window.SW_UI.getState() === 'idle') window.SW_UI.setState('speaking');
        window.SW_UI.showCard({
          type: 'answer',
          title: 'Scheduled Reminder Due',
          text: msg,
          actions: [
            ...(reminder.url ? [{ id: 'open_rem_url', label: 'Open Page', primary: true }] : []),
            { id: 'done_rem', label: 'Mark Done', primary: !reminder.url },
            { id: 'snooze_rem', label: 'Snooze 1h' }
          ],
          onAction: (id) => {
            this._pendingDueReminders = this._pendingDueReminders.filter((r) => r.id !== reminder.id);
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
              if (id === 'snooze_rem') {
                chrome.runtime.sendMessage({ type: 'SLEEPWALKER_REMINDER_UPDATE', id: reminder.id, patch: { targetTimeMs: Date.now() + 3600000 } });
              } else {
                chrome.runtime.sendMessage({ type: 'SLEEPWALKER_REMINDER_COMPLETE', id: reminder.id });
              }
            }
            if (id === 'open_rem_url' && reminder.url) {
              this._navigateToExternalUrl(reminder.url, reminder.title, reminder.projectTopic || '');
            } else if (window.SW_UI) {
              window.SW_UI.hideCard();
            }
          }
        });
      }
    }

    loadPreferences() {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return Promise.resolve();
      return new Promise((resolve) => {
        chrome.storage.local.get([
          'sleepwalker_lang', 'sleepwalker_font_size', 'sleepwalker_rate', 'sleepwalker_barge_in',
          'sleepwalker_voice_persona', 'sleepwalker_voice_uri',
          'sleepwalker_ai_search_enabled', 'sleepwalker_ollama_url', 'sleepwalker_ollama_model',
          'sleepwalker_memory_paused', 'sleepwalker_disable_page_analysis',
          'sleepwalker_adaptive_learning_enabled', 'sleepwalker_proactive_enabled',
          'sleepwalker_use_rebuilt_browser_engine', 'sleepwalker_enable_stagehand_adapter'
        ], (d) => {
          if (d) {
            if (d.sleepwalker_lang) this.setLanguage(d.sleepwalker_lang);
            if (d.sleepwalker_rate) this.setRate(d.sleepwalker_rate);
            if (d.sleepwalker_font_size) this.fontSize = Number(d.sleepwalker_font_size) || 18;
            this.voicePersona = d.sleepwalker_voice_persona || 'nova';
            this.voiceURI = d.sleepwalker_voice_uri || '';
            if (this.reader) {
              if (typeof this.reader.setVoicePersona === 'function') this.reader.setVoicePersona(this.voicePersona);
              if (typeof this.reader.setPreferredVoiceURI === 'function') this.reader.setPreferredVoiceURI(this.voiceURI);
            }
            if (window.SW_UI && window.SW_UI._orb && window.SW_UI._orb.card && typeof window.SW_UI._orb.card.setPrefs === 'function') {
              window.SW_UI._orb.card.setPrefs({
                lang: this.lang || 'auto',
                rate: this.rate || 1.0,
                fontSize: this.fontSize || 18,
                voicePersona: this.voicePersona
              });
            }
            this.bargeIn = Boolean(d.sleepwalker_barge_in);
            this.aiSearchEnabled = d.sleepwalker_ai_search_enabled !== false;
            this.ollamaUrl = d.sleepwalker_ollama_url || 'http://localhost:11434';
            this.ollamaModel = d.sleepwalker_ollama_model || 'llama3.2:3b';
            this.useRebuiltBrowserEngine = Boolean(
              d.sleepwalker_use_rebuilt_browser_engine === true ||
              (typeof window !== 'undefined' && window.__SLEEPWALKER_ENABLE_REBUILT_ENGINE__ === true)
            );
            this.useStagehandAdapter = Boolean(
              d.sleepwalker_enable_stagehand_adapter === true ||
              (typeof window !== 'undefined' && window.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__ === true)
            );
            // Core genuine CDP mouse & keyboard input is permanently enabled
            this.genuineInputEnabled = true;
            this._initCdpBridge();
            if (this.memory) {
              this.memory.privacy.memoryPaused = Boolean(d.sleepwalker_memory_paused);
              this.memory.privacy.disablePageAnalysis = Boolean(d.sleepwalker_disable_page_analysis);
              this.memory.privacy.learningEnabled = d.sleepwalker_adaptive_learning_enabled !== false;
              this.memory.privacy.proactiveEnabled = d.sleepwalker_proactive_enabled !== false;
            }
            if (this.navigator) {
              this.navigator.aiSearchEnabled = this.aiSearchEnabled;
              this.navigator.ollamaUrl = this.ollamaUrl;
              this.navigator.ollamaModel = this.ollamaModel;
            }
            if (this.elementSelector) {
              this.elementSelector.aiSearchEnabled = this.aiSearchEnabled;
            }
            if (this.dialogue) this.dialogue.setBargeIn(this.bargeIn);
          }
          resolve();
        });
        if (!this._storagePrivacyWatched && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
          this._storagePrivacyWatched = true;
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            if (changes.sleepwalker_use_rebuilt_browser_engine) {
              this.useRebuiltBrowserEngine = Boolean(changes.sleepwalker_use_rebuilt_browser_engine.newValue === true);
            }
            if (changes.sleepwalker_enable_stagehand_adapter) {
              this.useStagehandAdapter = Boolean(changes.sleepwalker_enable_stagehand_adapter.newValue === true);
            }
            if (changes.sleepwalker_genuine_input_enabled) {
              this.setGenuineInputEnabled(changes.sleepwalker_genuine_input_enabled.newValue === true, false);
            }
            if (changes.sleepwalker_voice_persona && this.reader && typeof this.reader.setVoicePersona === 'function') {
              this.voicePersona = changes.sleepwalker_voice_persona.newValue || 'nova';
              this.reader.setVoicePersona(this.voicePersona);
              if (window.SW_UI && window.SW_UI._orb && window.SW_UI._orb.card && typeof window.SW_UI._orb.card.setPrefs === 'function') {
                window.SW_UI._orb.card.setPrefs({ voicePersona: this.voicePersona });
              }
            }
            if (changes.sleepwalker_voice_uri && this.reader && typeof this.reader.setPreferredVoiceURI === 'function') {
              this.voiceURI = changes.sleepwalker_voice_uri.newValue || '';
              this.reader.setPreferredVoiceURI(this.voiceURI);
            }
            if (!this.memory) return;
            if (changes.sleepwalker_memory_paused) this.memory.privacy.memoryPaused = Boolean(changes.sleepwalker_memory_paused.newValue);
            if (changes.sleepwalker_disable_page_analysis) this.memory.privacy.disablePageAnalysis = Boolean(changes.sleepwalker_disable_page_analysis.newValue);
            if (changes.sleepwalker_adaptive_learning_enabled) {
              this.memory.privacy.learningEnabled = changes.sleepwalker_adaptive_learning_enabled.newValue !== false;
              if (this.memory.state && this.memory.state.personalContext && this.memory.state.personalContext.privacyControls) {
                this.memory.state.personalContext.privacyControls.learningEnabled = this.memory.privacy.learningEnabled;
              }
            }
            if (changes.sleepwalker_proactive_enabled) {
              this.memory.privacy.proactiveEnabled = changes.sleepwalker_proactive_enabled.newValue !== false;
              if (this.memory.state && this.memory.state.personalContext && this.memory.state.personalContext.privacyControls) {
                this.memory.state.personalContext.privacyControls.proactiveEnabled = this.memory.privacy.proactiveEnabled;
              }
            }
            if (changes.sleepwalker_persistent_memory_v1 && changes.sleepwalker_persistent_memory_v1.newValue && this.memory.state) {
              const incoming = changes.sleepwalker_persistent_memory_v1.newValue;
              const myKey = typeof this.memory._getTabKey === 'function' ? this.memory._getTabKey() : '';
              if (incoming.tabContexts && typeof incoming.tabContexts === 'object') {
                const curTabs = this.memory.state.tabContexts || {};
                const mergedTabs = { ...incoming.tabContexts };
                if (myKey && curTabs[myKey]) mergedTabs[myKey] = curTabs[myKey];
                this.memory.state.tabContexts = mergedTabs;
              }
              if (Array.isArray(incoming.recentTasks)) {
                this.memory.state.recentTasks = incoming.recentTasks;
              }
            }
          });
        }
      });
    }

    setRebuiltBrowserEngineEnabled(enabled, persist = false) {
      this.useRebuiltBrowserEngine = Boolean(enabled);
      if (persist && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ sleepwalker_use_rebuilt_browser_engine: this.useRebuiltBrowserEngine });
      }
      return this.useRebuiltBrowserEngine;
    }

    setStagehandAdapterEnabled(enabled, persist = false) {
      this.useStagehandAdapter = Boolean(enabled);
      if (typeof window !== 'undefined') {
        window.__SLEEPWALKER_ENABLE_STAGEHAND_ADAPTER__ = this.useStagehandAdapter;
      }
      if (persist && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ sleepwalker_enable_stagehand_adapter: this.useStagehandAdapter });
      }
      return this.useStagehandAdapter;
    }

    _initCdpBridge() {
      if (typeof window === 'undefined') return;
      if (this.genuineInputEnabled) {
        window.__sleepwalker_cdp_input = async (payload) => {
          if (!this.genuineInputEnabled) {
            throw new Error('Genuine browser-level input is disabled');
          }
          return new Promise((resolve, reject) => {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
              return reject(new Error('chrome.runtime messaging unavailable'));
            }
            chrome.runtime.sendMessage({
              type: 'SLEEPWALKER_CDP_INPUT',
              action: payload
            }, (res) => {
              if (chrome.runtime && chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
              }
              if (!res || !res.ok) {
                return reject(new Error((res && res.error) || 'CDP input failed'));
              }
              resolve(res.result || {});
            });
          });
        };
      } else {
        if (window.__sleepwalker_cdp_input && !window.__sw_cdp_bridge) {
          try { delete window.__sleepwalker_cdp_input; } catch (_e) { window.__sleepwalker_cdp_input = null; }
        }
      }
    }

    setGenuineInputEnabled(enabled, persist = false) {
      this.genuineInputEnabled = Boolean(enabled);
      this._initCdpBridge();
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        if (this.genuineInputEnabled) {
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_ATTACH_DEBUGGER' }, () => {
            void (chrome.runtime && chrome.runtime.lastError);
          });
        } else {
          chrome.runtime.sendMessage({ type: 'SLEEPWALKER_DETACH_DEBUGGER' }, () => {
            void (chrome.runtime && chrome.runtime.lastError);
          });
        }
      }
      if (persist && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ sleepwalker_genuine_input_enabled: this.genuineInputEnabled });
      }
      return this.genuineInputEnabled;
    }

    _recordRolloutEvent(evt = {}) {
      if (!this.rolloutTelemetry) return;
      const t = this.rolloutTelemetry;
      if (evt.outcome === 'success') t.successfulActions += 1;
      else if (evt.outcome === 'failed') t.failedActions += 1;
      else if (evt.outcome === 'fallback') t.fallbackCount += 1;
      else if (evt.outcome === 'clarification') t.clarificationCount += 1;
      if (evt.falseCompletion) t.falseCompletions += 1;
      if (typeof evt.latencyMs === 'number' && Number.isFinite(evt.latencyMs)) {
        t.latenciesMs.push(Math.round(evt.latencyMs));
        if (t.latenciesMs.length > 200) t.latenciesMs.shift();
      }
      t.events.push({
        ts: Date.now(),
        action: String(evt.action || ''),
        engine: String(evt.engine || ''),
        outcome: String(evt.outcome || ''),
        reason: String(evt.reason || '').slice(0, 120),
        latencyMs: typeof evt.latencyMs === 'number' ? Math.round(evt.latencyMs) : null
      });
      if (t.events.length > 100) t.events.shift();
    }

    savePreferences() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          sleepwalker_lang: this.lang,
          sleepwalker_font_size: this.fontSize,
          sleepwalker_rate: this.rate,
          sleepwalker_voice_persona: this.voicePersona || 'nova'
        });
      }
    }
  }

  window.SleepwalkerController = SleepwalkerController;
  if (!window.__SLEEPWALKER_INITIALIZED__) {
    window.__SLEEPWALKER_INITIALIZED__ = true;
    const ctrl = new SleepwalkerController();
    window.__SLEEPWALKER_INSTANCE__ = ctrl;
    window.__SW_WIDGET__ = ctrl;
    let holdZ = false;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((req, sender, send) => {
        // Strict origin boundary: only accept messages from THIS extension's own trusted background/extension pages (never webpages or other tabs)
        const isTrustedExtensionSender = Boolean(
          sender &&
          sender.id === chrome.runtime.id &&
          !sender.tab
        );
        if (!isTrustedExtensionSender) {
          return false;
        }
        if (req && req.action === 'SLEEPWALKER_TOGGLE') {
          ctrl.toggle({ startDialogue: true, source: 'alt_s' });
          send({ status: 'ok' });
        } else if (req && req.action === 'SLEEPWALKER_SYNC_SESSION') {
          ctrl.syncSessionFromTabActivation({ isForegroundTab: req.isForegroundTab !== false });
          send({ status: 'ok' });
        } else if (req && req.action === 'SLEEPWALKER_TAB_BACKGROUNDED') {
          ctrl.sleepForOtherTab(req.reason || 'tab_backgrounded');
          send({ status: 'ok' });
        } else if (req && req.action === 'SLEEPWALKER_REMINDER_DUE') {
          ctrl._handleDueReminderPopup(req.reminder);
          send({ status: 'ok' });
        } else if (req && req.action === 'SLEEPWALKER_PING_TAB_INFO') {
          send({ title: document.title || '', url: window.location.href || '' });
        } else if (req && req.action === 'SLEEPWALKER_PREPARE_SCREENSHOT') {
          for (const hid of ['sleepwalker-ui-host', 'sleepwalker-floating-ui', 'sleepwalker-candidate-overlay-root']) {
            const node = document.getElementById(hid);
            if (node) { node.dataset.swPrevVis = node.style.visibility || ''; node.style.visibility = 'hidden'; }
          }
          send({ ok: true });
        } else if (req && req.action === 'SLEEPWALKER_RESTORE_SCREENSHOT') {
          for (const hid of ['sleepwalker-ui-host', 'sleepwalker-floating-ui', 'sleepwalker-candidate-overlay-root']) {
            const node = document.getElementById(hid);
            if (node) { node.style.visibility = node.dataset.swPrevVis || ''; delete node.dataset.swPrevVis; }
          }
          send({ ok: true });
        } else if (req && req.action === 'SLEEPWALKER_SW_EXECUTE_COMMAND') {
          // Trusted extension-service-worker-only command channel (never exposed to webpage DOM)
          if (req.fireAndForget) {
            Promise.resolve()
              .then(() => ctrl.handleUserInput(String(req.text || ''), req.inputSource || 'typed', req.meta || {}))
              .catch(() => {});
            send({ ok: true, started: true });
            return false;
          }
          Promise.resolve()
            .then(() => ctrl.handleUserInput(String(req.text || ''), req.inputSource || 'typed', req.meta || {}))
            .then((res) => send({
              ok: true,
              res,
              unifiedLifecycle: ctrl.unifiedOrchestrator ? ctrl.unifiedOrchestrator.lifecycle.getSnapshot() : null,
              logs: globalLifecycleTracker.getAllLogs()
            }))
            .catch((err) => send({ ok: false, error: (err && err.message) || String(err) }));
          return true;
        } else if (req && req.action === 'SLEEPWALKER_SW_AUDIT_SNAPSHOT') {
          const cssPath = (el) => {
            if (!el || !el.tagName) return 'unknown';
            const tag = el.tagName.toLowerCase();
            if (el.id) return `${tag}#${el.id}`;
            const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
            return cls ? `${tag}.${cls}` : tag;
          };
          const isVis = (el) => {
            try {
              const st = getComputedStyle(el);
              if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
              const r = el.getBoundingClientRect();
              return r.width > 1 && r.height > 1;
            } catch (_e) { return false; }
          };
          if (req.mode === 'scan') {
            const idx = window.SleepwalkerLinkIndexInstance;
            const swLinks = idx ? idx.getTargets(document, { force: true }) : [];
            const swFields = (window.SleepwalkerFormIndex && typeof window.SleepwalkerFormIndex.indexFields === 'function')
              ? window.SleepwalkerFormIndex.indexFields(document)
              : [];
            const items = [];
            for (const t of swLinks) {
              items.push({
                kind: t.role || 'link',
                label: String(t.label || '').trim(),
                href: String(t.href || ''),
                tag: t.element && t.element.tagName ? t.element.tagName.toLowerCase() : '',
                selector: cssPath(t.element),
                visible: t.element ? isVis(t.element) : true,
                isAccordionOrTab: Boolean(t.element && (t.element.getAttribute('role') === 'tab' || t.element.hasAttribute('aria-expanded') || t.element.tagName === 'SUMMARY'))
              });
            }
            for (const f of swFields) {
              items.push({
                kind: 'input',
                label: String(f.label || f.name || '').trim(),
                href: '',
                tag: f.element && f.element.tagName ? f.element.tagName.toLowerCase() : 'input',
                selector: cssPath(f.element),
                visible: f.element ? isVis(f.element) : true,
                isAccordionOrTab: false
              });
            }
            send({ ok: true, swLinkCount: swLinks.length, swFieldCount: swFields.length, items });
          } else if (req.mode === 'reach') {
            const match = window.SleepwalkerMatch;
            const idx = window.SleepwalkerLinkIndexInstance;
            const targets = idx ? idx.getTargets(document, { force: false }) : [];
            const ordChecks = [['1', 1], ['2', 2], ['3', 3], ['पहला', 1], ['दूसरा', 2]];
            const ordOk = match ? ordChecks.every(([q, exp]) => match.parseOrdinalChoice(q, 5) === exp) : false;
            const out = (Array.isArray(req.samples) ? req.samples : []).map((s) => {
              const enDec = match ? match.decideMatch(targets, { target: s.label, action: 'CLICK' }) : null;
              const hiDec = match ? match.decideMatch(targets, { target: `${s.label} खोलो`, action: 'CLICK' }) : null;
              return {
                label: s.label,
                selector: s.selector,
                enHit: Boolean(enDec && enDec.best && enDec.outcome !== 'no_match'),
                hiHit: Boolean(hiDec && hiDec.best && hiDec.outcome !== 'no_match'),
                enOutcome: enDec ? enDec.outcome : 'none',
                hiOutcome: hiDec ? hiDec.outcome : 'none'
              };
            });
            send({ ok: true, ordOk, out });
          } else if (req.mode === 'echo') {
            const P = window.SleepwalkerVoicePipeline;
            if (!P || !P.EchoTracker) { send({ ok: false, detail: 'EchoTracker missing' }); return false; }
            const tr = new P.EchoTracker(3500);
            tr.note('Here are the top options on this page.');
            const blockedExact = tr.isEcho('Here are the top options on this page.');
            const blockedSub = tr.isEcho('top options on this page');
            const allowedShortCmd = !tr.isEcho('options');
            const allowedUserCmd = !tr.isEcho('open settings');
            send({ ok: blockedExact && blockedSub && allowedShortCmd && allowedUserCmd, detail: `exact=${blockedExact}, sub3=${blockedSub}, shortAllowed=${allowedShortCmd}, newCmdAllowed=${allowedUserCmd}` });
          } else if (req.mode === 'read_start') {
            if (ctrl.reader) ctrl.reader.readPage();
            send({ ok: true, started: Boolean(ctrl.reader && ctrl.reader.isPlaying) });
          } else {
            send({ ok: false, error: 'unknown_mode' });
          }
        } else if (req && req.action === 'SLEEPWALKER_SW_GET_STATE') {
          Promise.resolve().then(async () => {
            const ownership = (ctrl.stagehandAdapter && typeof ctrl.stagehandAdapter.getOwnershipState === 'function')
              ? await ctrl.stagehandAdapter.getOwnershipState().catch(() => null)
              : null;
            const health = (req.includeHealth && ctrl.stagehandAdapter && typeof ctrl.stagehandAdapter.health === 'function')
              ? await ctrl.stagehandAdapter.health().catch(() => null)
              : null;
            const cardHost = document.getElementById('sleepwalker-floating-ui') || document.getElementById('sleepwalker-ui-host');
            let visibleCardText = '';
            try {
              const cardEl = (window.SW_UI && window.SW_UI._orb && window.SW_UI._orb.card && window.SW_UI._orb.card.el) ||
                ((window.SW_UI && window.SW_UI._orb && window.SW_UI._orb.shadow) ? window.SW_UI._orb.shadow.querySelector('.sw-card') : null) ||
                ((cardHost && cardHost.shadowRoot) ? cardHost.shadowRoot.querySelector('.sw-card') : null);
              if (cardEl && !cardEl.hidden) {
                visibleCardText = (cardEl.innerText || cardEl.textContent || '').replace(/\s+/g, ' ').trim();
              }
            } catch (_e) {}
            const lastExecEnv = (ctrl.unifiedOrchestrator && Array.isArray(ctrl.unifiedOrchestrator.executionHistory) && ctrl.unifiedOrchestrator.executionHistory.length > 0)
              ? ctrl.unifiedOrchestrator.executionHistory[ctrl.unifiedOrchestrator.executionHistory.length - 1]
              : null;
            send({
              ok: true,
              hasSleepwalker: true,
              hasBrowserEngine: Boolean(ctrl.browserEngine),
              hasStagehandAdapter: Boolean(ctrl.stagehandAdapter),
              hasUnifiedOrchestrator: Boolean(ctrl.unifiedOrchestrator),
              unifiedLifecycle: ctrl.unifiedOrchestrator ? ctrl.unifiedOrchestrator.lifecycle.getSnapshot() : null,
              unifiedRoutingHistory: ctrl.unifiedOrchestrator ? ctrl.unifiedOrchestrator.routingHistory.slice(-15) : [],
              lastExecutionEnvelope: lastExecEnv,
              lastNavVerification: ctrl.lastNavVerification || null,
              lastCrossPageContinuationResult: ctrl.lastCrossPageContinuationResult || null,
              lastSpokenUnifiedReply: ctrl.lastSpokenUnifiedReply || null,
              visibleCardText,
              emergencyStopActive: Boolean(ctrl.emergencyStopActive),
              isSpeaking: Boolean(ctrl.reader && ctrl.reader.isPlaying),
              dialoguePausedForSpeech: Boolean(ctrl.dialogue && ctrl.dialogue.isPausedForSpeech()),
              useStagehandAdapter: Boolean(ctrl.useStagehandAdapter),
              useRebuiltBrowserEngine: Boolean(ctrl.useRebuiltBrowserEngine),
              selectedBackend: ctrl._getSelectedBackend(),
              taskLifecycleState: ctrl.taskLifecycle ? ctrl.taskLifecycle.state : null,
              activeTaskId: ctrl.taskLifecycle ? ctrl.taskLifecycle.activeTaskId : 0,
              url: window.location.href,
              title: document.title,
              ownership,
              health,
              adapterTelemetry: ctrl.stagehandAdapter ? ctrl.stagehandAdapter.getTelemetry() : []
            });
          }).catch((err) => send({ ok: false, error: (err && err.message) || String(err) }));
          return true;
        } else if (req && req.action === 'SLEEPWALKER_SW_SET_STAGEHAND') {
          if (typeof req.enabled === 'boolean') {
            ctrl.setStagehandAdapterEnabled(req.enabled, Boolean(req.persist));
          }
          if (typeof req.rebuiltEnabled === 'boolean') {
            ctrl.setRebuiltBrowserEngineEnabled(req.rebuiltEnabled, Boolean(req.persist));
          }
          if (req.bridgeUrl && ctrl.stagehandAdapter) {
            ctrl.stagehandAdapter.options.bridgeUrl = String(req.bridgeUrl);
          }
          if (req.cdpEndpoint && ctrl.stagehandAdapter) {
            ctrl.stagehandAdapter.options.cdpEndpoint = String(req.cdpEndpoint);
          }
          send({
            ok: true,
            useStagehandAdapter: ctrl.useStagehandAdapter,
            useRebuiltBrowserEngine: ctrl.useRebuiltBrowserEngine,
            selectedBackend: ctrl._getSelectedBackend(),
            bridgeUrl: ctrl.stagehandAdapter ? ctrl.stagehandAdapter.options.bridgeUrl : null
          });
        } else if (req && req.action === 'SLEEPWALKER_SW_CANCEL') {
          const res = ctrl.cancelActiveTask(req.reason || 'sw_cancelled', { source: 'sw_cancel' });
          send({
            ok: true,
            res,
            taskLifecycleState: ctrl.taskLifecycle ? ctrl.taskLifecycle.state : null,
            unifiedLifecycle: ctrl.unifiedOrchestrator ? ctrl.unifiedOrchestrator.lifecycle.getSnapshot() : null
          });
        } else if (req && req.action === 'SLEEPWALKER_SW_EMERGENCY_STOP') {
          Promise.resolve()
            .then(() => ctrl.triggerEmergencyStop(req.reason || 'sw_emergency_stop'))
            .then((res) => send({ ok: true, res }))
            .catch((err) => send({ ok: false, error: (err && err.message) || String(err) }));
          return true;
        } else if (req && req.action === 'SLEEPWALKER_SW_RESET_EMERGENCY_STOP') {
          Promise.resolve()
            .then(() => ctrl.resetEmergencyStop(req.source || 'sw_reset'))
            .then((res) => send({ ok: true, res }))
            .catch((err) => send({ ok: false, error: (err && err.message) || String(err) }));
          return true;
        } else if (req && req.action === 'SLEEPWALKER_EMERGENCY_STOP_CLEARED') {
          ctrl.emergencyStopActive = false;
          send({ ok: true });
        }
        return true;
      });
    }
    window.addEventListener('keydown', (e) => {
      // Ignore synthetic untrusted keyboard events dispatched by webpage scripts in Chrome extension runtime
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && e && e.isTrusted === false) return;
      if (e.altKey && e.shiftKey && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        ctrl.triggerEmergencyStop('hotkey_alt_shift_x');
      } else if (e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        ctrl.toggle({ startDialogue: true, source: 'alt_s' });
      } else if (e.altKey && (e.key === 'z' || e.key === 'Z') && !e.repeat) {
        e.preventDefault();
        holdZ = true;
        ctrl.startHoldToTalk();
      } else if (e.key === 'Escape' && !window.__SW_DISPATCHING_CDP_ESCAPE__ && window.SW_UI && window.SW_UI.getState() !== 'idle') {
        const tgt = e.target;
        const isPageEditableOrPopup = Boolean(
          tgt && tgt.id !== 'sleepwalker-ui-host' && (
            tgt.tagName === 'INPUT' ||
            tgt.tagName === 'TEXTAREA' ||
            tgt.tagName === 'SELECT' ||
            tgt.isContentEditable ||
            (tgt.closest && tgt.closest('[role="listbox"], [role="combobox"], [role="menu"], [role="dialog"]'))
          )
        );
        // If Escape happened inside SW_UI's Shadow DOM (e.g. closing the Type bar), let orb.js handle it cleanly!
        if (tgt && tgt.id === 'sleepwalker-ui-host') return;
        // Do not kill Sleepwalker's active task when the user presses Escape inside a webpage input/dropdown!
        if (isPageEditableOrPopup && ctrl.taskLifecycle && ctrl.taskLifecycle.state === 'PROCESSING') return;
        e.preventDefault();
        ctrl.dismissUi('escape');
      }
    }, true);
    window.addEventListener('keyup', (e) => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && e && e.isTrusted === false) return;
      if ((e.key === 'z' || e.key === 'Z') && holdZ) { e.preventDefault(); holdZ = false; ctrl.stopHoldToTalk(); }
    }, true);
  }
})();
