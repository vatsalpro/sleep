/**
 * Sleepwalker - dialogue.js
 * Phase C1: Continuous Conversation Session Engine
 *
 * Responsibilities:
 * 1. Continuous loop (listen -> understand -> act -> speak -> listen again) started via Alt+S or orb.
 * 2. END phrases in EN / HI / Hinglish with half-done form confirmation ("Stop now? Your form stays as it is.").
 * 3. Dialogue state + Answer-First interpretation (pending question value/yes-no/choice, then meta-commands, then commands).
 * 4. Meta-commands: correction ("no, change it to..."), skip, back, repeat, help, undo.
 * 5. Half-duplex by default (pause recognition during TTS, resume ~300 ms after) + optional Barge-In mode + interruption (orb tap, Escape, Alt+S).
 * 6. Silence timers: 25 s -> "Are you still there?", +15 s -> quiet session end.
 * 7. Compact 3-turn rolling memory (non-sensitive only).
 */

(function () {
  'use strict';

  if (window.SleepwalkerDialogue) return;

  const END_PHRASES = new Set([
    'thanks',
    'thank you',
    'thanks for the help',
    'thank you for the help',
    'thanks a lot',
    'thank you very much',
    'thats all',
    'that is all',
    'finish',
    'finished',
    'im done',
    'i am done',
    'done for now',
    'bye',
    'bye bye',
    'goodbye',
    'good bye',
    'stop listening',
    'end session',
    'close mic',
    'bas',
    'bas itna hi',
    'shukriya',
    'dhanyavaad',
    'dhanyavad',
    'theek hai bas',
    'thik hai bas',
    'band karo',
    'bas band karo',
    'mic band karo',
    'ho gaya',
    'you can rest',
    'you can rest now',
    'thank you you can rest',
    'thank you you can rest now',
    'thanks you can rest',
    'sleepwalker rest',
    'sleepwalker rest now',
    'take a rest',
    'rest now',
    'go to sleep',
    'thats all for now',
    'done',
    'धन्यवाद',
    'शुक्रिया',
    'बस',
    'बस इतना ही',
    'बस बंद करो',
    'ठीक है बस',
    'बंद करो',
    'सुनना बंद करो',
    'अलविदा',
    'बाय',
    'हो गया'
  ]);

  const REST_PHRASE_RE = /\b(?:you\s+can\s+rest(?:\s+now)?|sleepwalker\s*,?\s*rest(?:\s+now)?|take\s+a\s+rest|go\s+to\s+rest|go\s+to\s+sleep|rest\s+now|that'?s\s+all|stop\s+listening|bas\s*,?\s*band\s+karo|shukriya|आराम\s+करो)\b/i;

  const YES_RE = /^(?:yes|yeah|yep|yup|ya|ok|okay|sure|haan|ha|han|ji|theek\s+hai|thik\s+hai|kar\s+do|bilkul|confirm|stop\s+now|end|हाँ|हां|जी|जी\s+हाँ|ठीक\s+है)$/i;
  const NO_RE = /^(?:no|nope|nah|nahi|na|mat|dont|do\s+not|keep\s+going|continue|stay|cancel|ruko|नहीं|ना|मत|रहो|आगे\s+बढ़ो)$/i;

  const SKIP_RE = /^(?:skip|skip\s+(?:this|it|field|one)|next\s+field|chhodo|chhod\s+do|chhoro|aage\s+badho|agla|छोड़ो|अगला)$/i;
  const BACK_STRICT_RE = /^(?:previous|previous\s+(?:field|question|step)|last\s+(?:field|question)|pichhla|pichla|peeche\s+jao|पिछला|पीछे)$/i;
  const BACK_SOFT_RE = /^(?:back|go\s+back|waapas|wapas|वापस)$/i;
  const REPEAT_RE = /^(?:repeat|repeat\s+(?:that|please)|say\s+(?:that|it)\s+again|say\s+again|pardon|come\s+again|what\s+did\s+you\s+say|read\s+(?:the\s+)?options\s+again|phir\s+se\s+bolo|dobara\s+bolo|फिर\s+से\s+बोलो|दोबारा\s+बोलो)$/i;
  const HELP_RE = /^(?:help|help\s+me|what\s+can\s+i\s+say|what\s+do\s+i\s+say|madad|सहायता|मदद)$/i;
  const UNDO_RE = /^(?:undo|undo\s+(?:that|it|last)|revert|wapas\s+lo|उल्टा\s+करो)$/i;
  const STILL_THERE_YES_RE = /^(?:yes|yeah|yep|haan|ha|im\s+here|i\s+am\s+here|here|still\s+here|listening|go\s+ahead|continue|हाँ|यहीं\s+हूँ|जी)$/i;

  const ORDINAL_WORDS = {
    first: 0, '1st': 0, one: 0, ek: 0, pehla: 0, pahla: 0, पहला: 0, एक: 0,
    second: 1, '2nd': 1, two: 1, do: 1, dusra: 1, doosra: 1, दूसरा: 1, दो: 1,
    third: 2, '3rd': 2, three: 2, teen: 2, teesra: 2, तीसरा: 2, तीन: 2,
    fourth: 3, '4th': 3, four: 3, char: 3, chautha: 3, चौथा: 3, चार: 3,
    fifth: 4, '5th': 4, five: 4, paanch: 4, panch: 4, पांचवा: 4, पाँच: 4
  };

  class SleepwalkerDialogue {
    constructor(widget, options = {}) {
      this.widget = widget;
      this.active = false;
      this.resting = false;
      this.pausedForSpeech = false;
      this.bargeIn = Boolean(options.bargeIn);
      this.memory = []; // Compact 3-turn memory: [{ user, action, assistant, ts }]
      this.pendingPrompt = null;
      this._savedPromptBeforeEndConfirm = null;
      this.lastSpokenText = '';
      this.lastAnswerAction = null;

      this._isProcessingTurn = false;
      this._wasSpeaking = false;
      this._promptedSilence = false;
      this._resumeTimer = null;
      this._silencePromptTimer = null;
      this._silenceEndTimer = null;

      // Timing defaults (customizable in tests)
      this.timers = {
        resumeDelayMs: typeof options.resumeDelayMs === 'number' ? options.resumeDelayMs : 300,
        silencePromptMs: typeof options.silencePromptMs === 'number' ? options.silencePromptMs : 25000,
        silenceEndMs: typeof options.silenceEndMs === 'number' ? options.silenceEndMs : 15000
      };
    }

    isActive() {
      return Boolean(this.active);
    }

    isPausedForSpeech() {
      return Boolean(this.active && this.pausedForSpeech && !this.bargeIn);
    }

    setBargeIn(enabled) {
      const next = Boolean(enabled);
      this.bargeIn = next;
      if (next && this.active && this.pausedForSpeech) {
        this.pausedForSpeech = false;
        if (this.widget && this.widget.voice) {
          this.widget.voice.resumeAfterPause();
        }
      } else if (!next && this.active && this._isSystemSpeaking()) {
        this.onSpeechStart();
      }
      this._syncSessionIndicators();
    }

    setTimers(overrides = {}) {
      if (typeof overrides.resumeDelayMs === 'number') this.timers.resumeDelayMs = Math.max(0, overrides.resumeDelayMs);
      if (typeof overrides.silencePromptMs === 'number') this.timers.silencePromptMs = Math.max(10, overrides.silencePromptMs);
      if (typeof overrides.silenceEndMs === 'number') this.timers.silenceEndMs = Math.max(10, overrides.silenceEndMs);
    }

    /**
     * Start continuous conversation session via Alt+S or Orb click.
     */
    startSession({ source = 'orb', greeting = '' } = {}) {
      this._clearAllTimers();
      this._promptedSilence = false;

      if (this.active) {
        if (this._isSystemSpeaking()) {
          return this.interruptSpeech({ source, resumeSession: true });
        }
        if (this.widget && this.widget.voice && !this.widget.voice.isListening) {
          this.widget.voice.continuousSession = true;
          this.widget.voice.startListening();
        }
        this._syncSessionIndicators();
        this._scheduleSilenceTimers();
        return true;
      }

      const wasResting = Boolean(
        this.resting ||
        (this.widget && this.widget.memory && typeof this.widget.memory.isResting === 'function' && this.widget.memory.isResting())
      );

      this.active = true;
      this.resting = false;
      this.pausedForSpeech = false;

      if (this.widget && this.widget.memory && typeof this.widget.memory.setSessionMode === 'function') {
        this.widget.memory.setSessionMode('active_listening');
      }

      if (this._isSystemSpeaking()) {
        this.interruptSpeech({ source, resumeSession: true });
      }

      if (this.widget && this.widget.voice) {
        this.widget.voice.continuousSession = true;
        this.widget.voice.startListening();
      }

      if (this.widget) {
        const dueReminders = Array.isArray(this.widget._pendingDueReminders) ? this.widget._pendingDueReminders : [];
        const resumeCtx = (this.widget.memory && typeof this.widget.memory.buildWakeResumeContext === 'function')
          ? this.widget.memory.buildWakeResumeContext(dueReminders)
          : { hasPriorContext: false };

        let msg = greeting;
        if (!msg) {
          if ((wasResting || source === 'wake_resume' || source === 'restart_resume') && resumeCtx.hasPriorContext) {
            msg = this.widget.lang === 'hi-IN' ? resumeCtx.greetingHi : resumeCtx.greetingEn;
          } else {
            msg = this.widget.lang === 'hi-IN'
              ? 'सत्र चालू है। बोलिए — समाप्त करने के लिए "बस" या "धन्यवाद" कहें।'
              : 'Conversation started. Speak anytime — say "Thanks" or "You can rest" when done.';
          }
        }
        this.lastSpokenText = msg;
        this.widget.setAssistantReply(msg);
        if ((wasResting || source === 'wake_resume' || source === 'restart_resume') && resumeCtx.hasPriorContext) {
          this.pendingPrompt = {
            kind: 'yesno',
            label: 'resume_resting_task',
            askedText: msg,
            onAnswer: async (yes) => {
              if (yes && typeof this.widget.resumeSavedTask === 'function') {
                return await this.widget.resumeSavedTask();
              }
              const nextMsg = 'Okay, I am ready whenever you want to ask something new.';
              this._sayAndDisplay(nextMsg);
              if (typeof window !== 'undefined' && window.SW_UI) {
                window.SW_UI.showCard({ type: 'answer', title: 'Ready', text: nextMsg });
              }
              return { status: 'declined_resume' };
            }
          };
          if (typeof window !== 'undefined' && window.SW_UI) {
            window.SW_UI.setState('speaking');
            window.SW_UI.showCard({
              type: 'answer',
              title: 'Welcome Back',
              text: msg,
              actions: [
                { id: 'yes', label: 'Continue', primary: true },
                { id: 'no', label: 'Start Fresh' }
              ],
              onAction: (id) => {
                this.pendingPrompt = null;
                if (id === 'yes' && typeof this.widget.resumeSavedTask === 'function') {
                  this.widget.resumeSavedTask();
                } else if (window.SW_UI) {
                  window.SW_UI.setState('listening');
                  window.SW_UI.hideCard();
                }
              }
            });
          }
          if (this.widget.reader) {
            this.widget.reader.readText(msg);
          }
        } else {
          if (this.widget.pill) {
            this.widget.pill.setListening('Listening... Continuous mode active');
          }
          if (this.widget.glow) {
            this.widget.glow.setListening();
          }
        }
      }

      this._syncSessionIndicators();
      this._scheduleSilenceTimers();
      return true;
    }

    /**
     * Put Sleepwalker into calm resting state while keeping conversational memory and active task intact.
     */
    restSession({ reason = 'user_rest', quiet = false, message = '' } = {}) {
      this._clearAllTimers();
      this.active = false;
      this.resting = true;
      this.pausedForSpeech = false;
      this._promptedSilence = false;
      this.pendingPrompt = null;
      this._savedPromptBeforeEndConfirm = null;

      if (this.widget && this.widget.voice) {
        this.widget.voice.continuousSession = false;
        this.widget.voice.stopListening();
      }

      if (this.widget && this.widget.memory && typeof this.widget.memory.setSessionMode === 'function') {
        this.widget.memory.setSessionMode('resting');
      }

      const restMsg = message || (this.widget && this.widget.lang === 'hi-IN'
        ? 'ठीक है, मैं अभी आराम कर रहा हूँ। जारी रखने के लिए कभी भी Alt+S दबाएं।'
        : 'Resting now. Press Alt+S or tap the orb whenever you want to continue.');

      if (this.widget) {
        this.widget.setAssistantReply(restMsg);
        if (this.widget.pill) {
          this.widget.pill.setIdle(restMsg);
        }
        if (this.widget.glow) {
          this.widget.glow.setOff();
        }
      }

      if (!quiet && typeof window !== 'undefined' && window.SW_UI) {
        window.SW_UI.setState('silent');
        window.SW_UI.setTranscript('Resting — press Alt+S to wake');
        window.SW_UI.showCard({ type: 'answer', title: 'Resting', text: restMsg });
        if (this.widget && this.widget.reader) {
          this.widget.reader.readText(restMsg);
        }
        setTimeout(() => {
          if (this.resting && !this.active && window.SW_UI) {
            window.SW_UI.hide({ dissolve: true });
          }
        }, 1600);
      } else if (typeof window !== 'undefined' && window.SW_UI) {
        window.SW_UI.hide({ dissolve: true });
      }

      this._syncSessionIndicators();
      return true;
    }

    toggleSession({ source = 'orb' } = {}) {
      if (this.active) {
        if (this._isSystemSpeaking()) {
          this.interruptSpeech({ source, resumeSession: true });
          return true;
        }
        return this.requestEnd({ source });
      }
      return this.startSession({ source });
    }

    /**
     * Attempt to end the session (checks half-done form before ending unless forced).
     */
    requestEnd({ source = 'user', quietIfNoForm = false, force = false } = {}) {
      if (!force && this.isFormHalfDone()) {
        const promptText = this.widget && this.widget.lang === 'hi-IN'
          ? 'अभी रुकें? आपका भरा हुआ फॉर्म वैसा ही रहेगा।'
          : 'Stop now? Your form stays as it is.';
        this._savedPromptBeforeEndConfirm = this.pendingPrompt && this.pendingPrompt.kind !== 'end_form_confirm'
          ? this.pendingPrompt
          : null;
        this.pendingPrompt = {
          kind: 'end_form_confirm',
          askedText: promptText,
          source
        };
        this._sayAndDisplay(promptText);
        return false;
      }

      return this.endSession({ reason: source, quiet: quietIfNoForm, force: true });
    }

    /**
     * Terminate continuous session and close the mic.
     */
    endSession({ reason = 'user', quiet = false, message = '', force = false } = {}) {
      if (!force && reason !== 'silence' && reason !== 'toggle' && reason !== 'escape' && this.isFormHalfDone()) {
        return this.requestEnd({ source: reason });
      }

      this._clearAllTimers();
      this.active = false;
      this.resting = false;
      this.pausedForSpeech = false;
      this._promptedSilence = false;
      this.pendingPrompt = null;
      this._savedPromptBeforeEndConfirm = null;

      if (this.widget && this.widget.memory && typeof this.widget.memory.setSessionMode === 'function') {
        const mode = reason === 'escape' ? 'hidden' : 'ended';
        this.widget.memory.setSessionMode(mode);
      }

      if (this.widget && this.widget.voice) {
        this.widget.voice.continuousSession = false;
        this.widget.voice.stopListening();
      }

      const defaultBye = this.widget && this.widget.lang === 'hi-IN'
        ? 'अलविदा! फिर बात करने के लिए ऑर्ब दबाएं या Alt+S दबाएं।'
        : 'Goodbye! Tap the orb or press Alt+S anytime.';
      const byeMsg = message || defaultBye;

      if (!quiet) {
        this._sayAndDisplay(byeMsg, { openBubble: true, speak: true, allowDuringEndedSession: true });
      } else if (this.widget) {
        const quietMsg = reason === 'silence'
          ? 'Session ended quietly due to inactivity.'
          : 'Voice session closed.';
        this.widget.setAssistantReply(quietMsg);
        if (this.widget.pill) {
          this.widget.pill.setIdle(quietMsg);
        }
        if (this.widget.glow) {
          this.widget.glow.setOff();
        }
      }

      this._syncSessionIndicators();
      if (typeof window !== 'undefined' && window.SW_UI && (quiet || reason === 'escape' || reason === 'toggle' || reason === 'silence')) {
        window.SW_UI.hide({ dissolve: true });
      }
      return true;
    }

    /**
     * Stop TTS immediately (used by orb tap, Escape, Alt+S, or barge-in speech).
     */
    interruptSpeech({ source = 'user', resumeSession = true } = {}) {
      this._clearResumeTimer();
      const wasPlaying = this._isSystemSpeaking();

      if (this.widget) {
        this.widget._isExplaining = false;
        if (this.widget.explainer && typeof this.widget.explainer.abort === 'function') {
          this.widget.explainer.abort();
        }
        if (this.widget.reader) {
          if (typeof this.widget.reader.cancelStream === 'function') {
            this.widget.reader.cancelStream();
          } else {
            this.widget.reader.stop();
          }
        } else if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
        if (typeof window !== 'undefined' && window.SW_UI && window.SW_UI.getState() !== 'idle') {
          window.SW_UI.setState(resumeSession ? 'listening' : 'silent');
          window.SW_UI.setTranscript(resumeSession ? 'Listening...' : 'Stopped');
        }
        if (typeof this.widget.syncStopButton === 'function') {
          this.widget.syncStopButton();
        }
      }

      this.pausedForSpeech = false;
      this._wasSpeaking = false;

      if (this.active && resumeSession && this.widget && this.widget.voice) {
        this.widget.voice.resumeAfterPause();
        if (this.widget.pill) {
          this.widget.pill.setListening('Interrupted speech — listening...');
        }
        if (this.widget.glow) {
          this.widget.glow.setListening();
        }
        this._scheduleSilenceTimers();
      } else if (wasPlaying && this.widget && this.widget.pill && this.widget.pill.state === 'speaking') {
        this.widget.pill.setIdle('Speech stopped.');
      }

      this._syncSessionIndicators();
      return wasPlaying;
    }

    /**
     * Register a dialogue question so the next utterance is interpreted as its answer first.
     */
    setPendingPrompt(promptConfig) {
      if (this.pendingPrompt && typeof this.pendingPrompt.onClear === 'function') {
        try { this.pendingPrompt.onClear(); } catch (_e) {}
      }
      if (!promptConfig) {
        this.pendingPrompt = null;
        return;
      }
      this.pendingPrompt = {
        kind: promptConfig.kind || 'question', // 'question' | 'yesno' | 'choice' | 'value' | 'field'
        label: promptConfig.label || '',
        askedText: promptConfig.askedText || promptConfig.question || '',
        options: Array.isArray(promptConfig.options) ? promptConfig.options : null,
        onAnswer: typeof promptConfig.onAnswer === 'function' ? promptConfig.onAnswer : null,
        onClear: typeof promptConfig.onClear === 'function' ? promptConfig.onClear : null,
        onCorrection: typeof promptConfig.onCorrection === 'function' ? promptConfig.onCorrection : null,
        onSkip: typeof promptConfig.onSkip === 'function' ? promptConfig.onSkip : null,
        onBack: typeof promptConfig.onBack === 'function' ? promptConfig.onBack : null,
        onUndo: typeof promptConfig.onUndo === 'function' ? promptConfig.onUndo : null,
        helpText: promptConfig.helpText || '',
        sensitive: Boolean(promptConfig.sensitive)
      };
      if (this.pendingPrompt.askedText) {
        this.lastSpokenText = this.pendingPrompt.askedText;
      }
    }

    /**
     * Check whether a form is partially completed and not yet submitted.
     */
    isFormHalfDone() {
      const forms = this.widget && this.widget.forms;
      if (forms) {
        if (typeof forms.isHalfDone === 'function') {
          return Boolean(forms.isHalfDone());
        }
        if (forms.isGuidedActive && forms.isGuidedActive() && forms.guidedState && forms.guidedState.index > 0) {
          return true;
        }
        if (Array.isArray(forms.undoStack) && forms.undoStack.length > 0 && !forms._submitted) {
          return true;
        }
      }
      if (typeof document !== 'undefined') {
        const dirtyFlag = document.querySelector('form[data-sw-half-done="true"], [data-sw-filled="true"]');
        if (dirtyFlag) return true;
      }
      return false;
    }

    /**
     * Hook called by reader status updates & voice activity.
     */
    onSpeechStatusChange({ isPlaying, isPaused } = {}) {
      const speakingNow = Boolean(isPlaying && !isPaused);
      if (speakingNow && !this._wasSpeaking) {
        this._wasSpeaking = true;
        this.onSpeechStart();
      } else if (!speakingNow && this._wasSpeaking) {
        this._wasSpeaking = false;
        this.onSpeechEnd();
      }
    }

    onSpeechStart() {
      this._clearResumeTimer();
      if (this._promptedSilence) {
        if (this._silencePromptTimer) {
          clearTimeout(this._silencePromptTimer);
          this._silencePromptTimer = null;
        }
      } else {
        this._clearSilenceTimers();
      }
      if (!this.active) return;

      if (!this.bargeIn && this.widget && this.widget.voice && this.widget.voice.isListening) {
        this.pausedForSpeech = true;
        this.widget.voice.pauseTemporary();
      }
      this._syncSessionIndicators();
    }

    onSpeechEnd() {
      this._clearResumeTimer();
      if (!this.active) {
        this.pausedForSpeech = false;
        this._syncSessionIndicators();
        return;
      }

      const scheduleListening = () => {
        if (!this.active || this._isSystemSpeaking()) return;
        this.pausedForSpeech = false;
        if (this.widget && this.widget.voice) {
          this.widget.voice.continuousSession = true;
          this.widget.voice.resumeAfterPause();
        }
        if (this.widget && this.widget.pill && this.widget.pill.state !== 'error') {
          if (this.widget.confirm && this.widget.confirm.isAwaiting()) {
            this.widget.pill.setListening('Listening for confirmation...');
          } else if (!this.widget.reader || !this.widget.reader.isPlaying) {
            this.widget.pill.setListening('Listening...');
          }
        }
        this._syncSessionIndicators();
        if (this._promptedSilence) {
          if (!this._silenceEndTimer) {
            this._scheduleSilenceEndTimer();
          }
        } else {
          this._scheduleSilenceTimers();
        }
      };

      if (this.pausedForSpeech && !this.bargeIn) {
        this._resumeTimer = setTimeout(scheduleListening, this.timers.resumeDelayMs);
      } else {
        scheduleListening();
      }
    }

    noteSpeechActivity({ fromVoice = true } = {}) {
      this._promptedSilence = false;
      this._clearSilenceTimers();

      // In barge-in mode, incoming speech interrupts active TTS immediately
      if (fromVoice && this.bargeIn && this._isSystemSpeaking()) {
        this.interruptSpeech({ source: 'barge_in', resumeSession: true });
      }
    }

    /**
     * Primary utterance router:
     * 1. END confirm / END phrases (with half-done form protection)
     * 2. Meta-commands: correction, skip, back, repeat, help, undo
     * 3. Answer-first for pending question
     * 4. Fallback to general command/confirm/form classification
     */
    async handleUtterance(rawText, inputSource = 'voice', meta = {}) {
      const clean = typeof rawText === 'string' ? rawText.trim() : '';
      if (!clean) return { handled: false };

      this.noteSpeechActivity({ fromVoice: inputSource === 'voice' });
      this._isProcessingTurn = true;
      this._clearSilenceTimers();

      try {
        const norm = this._normalizeForDialogue(clean);

        // 0. Responding to half-done form end confirmation
        if (this.pendingPrompt && this.pendingPrompt.kind === 'end_form_confirm') {
          if (YES_RE.test(norm)) {
            this.recordTurn({ user: clean, action: 'end_session_confirmed', assistant: 'Goodbye' });
            this.endSession({ reason: 'user_confirmed_half_form', force: true });
            return { handled: true, result: { status: 'session_ended' } };
          }
          if (NO_RE.test(norm)) {
            const restored = this._savedPromptBeforeEndConfirm;
            this.pendingPrompt = restored || null;
            this._savedPromptBeforeEndConfirm = null;
            const forms = this.widget && this.widget.forms;
            if (!restored && forms && forms.isGuidedActive && forms.isGuidedActive()) {
              this.recordTurn({ user: clean, action: 'end_session_cancelled', assistant: 'Continuing guided form' });
              forms._promptCurrentGuidedField();
              return { handled: true, result: { status: 'session_continued' } };
            }
            const stayMsg = restored && restored.askedText
              ? `Okay, continuing. ${restored.askedText}`
              : 'Okay, continuing. Your form stays open.';
            this._sayAndDisplay(stayMsg);
            this.recordTurn({ user: clean, action: 'end_session_cancelled', assistant: stayMsg });
            return { handled: true, result: { status: 'session_continued' } };
          }
        }

        // 0b. Responding to 25s "Are you still there?" prompt
        if (this.pendingPrompt && this.pendingPrompt.kind === 'still_there') {
          this.pendingPrompt = null;
          if (STILL_THERE_YES_RE.test(norm)) {
            const readyMsg = 'Okay, go ahead. What would you like to do?';
            this._sayAndDisplay(readyMsg);
            this.recordTurn({ user: clean, action: 'still_there_ack', assistant: readyMsg });
            return { handled: true, result: { status: 'still_there_confirmed' } };
          }
          // Otherwise treat utterance as a real command or END phrase below!
        }

        // 0c. Manual takeover or sensitive-field "done" check (must precede END_PHRASES so "I'm done" verifies field instead of ending session)
        if (this.widget && this.widget.forms && typeof this.widget.forms.isAwaitingManualDone === 'function' && this.widget.forms.isAwaitingManualDone()) {
          if (this.widget.forms.handleManualOrSensitiveInput(clean)) {
            this.recordTurn({ user: '[manual/sensitive ack]', action: 'form_manual_done', assistant: '' });
            return { handled: true, result: { status: 'manual_or_sensitive_handled' } };
          }
        }

        // 1. Check REST vs END phrases (unless captured by an open multi-line dictation listener in future C2)
        const allowEndPhrase = !(
          this.widget &&
          this.widget.forms &&
          typeof this.widget.forms.isDictatingLongText === 'function' &&
          this.widget.forms.isDictatingLongText()
        );
        if (allowEndPhrase && this.isRestPhrase(clean, norm)) {
          if (this.isFormHalfDone()) {
            this.requestEnd({ source: 'voice_end' });
            return { handled: true, result: { status: 'confirm_end_half_form' } };
          }
          this.recordTurn({ user: clean, action: 'rest_session', assistant: 'Resting now' });
          this.restSession({ reason: 'voice_rest' });
          return { handled: true, result: { status: 'session_resting' } };
        }
        if (allowEndPhrase && this.isEndPhrase(clean, norm)) {
          if (this.isFormHalfDone()) {
            this.requestEnd({ source: 'voice_end' });
            return { handled: true, result: { status: 'confirm_end_half_form' } };
          }
          this.recordTurn({ user: clean, action: 'end_session', assistant: 'Goodbye' });
          this.endSession({ reason: 'voice_end', force: true });
          return { handled: true, result: { status: 'session_ended' } };
        }

        // 2. Dialogue Meta-Commands (Correction, Skip, Back, Repeat, Help, Undo)
        const correctionVal = this._extractCorrectionValue(clean);
        if (correctionVal !== null) {
          const corrRes = await this._handleCorrection(correctionVal, clean);
          if (corrRes) return { handled: true, result: corrRes };
        }

        if (SKIP_RE.test(norm)) {
          const skipRes = this._handleSkip(clean);
          if (skipRes) return { handled: true, result: skipRes };
        }

        if (BACK_STRICT_RE.test(norm) || (BACK_SOFT_RE.test(norm) && this._hasActiveQuestionOrForm())) {
          const backRes = this._handleBack(clean);
          if (backRes) return { handled: true, result: backRes };
        }

        if (REPEAT_RE.test(norm)) {
          const repRes = this._handleRepeat(clean);
          return { handled: true, result: repRes };
        }

        if (UNDO_RE.test(norm)) {
          const undoRes = await this._handleUndo(clean);
          return { handled: true, result: undoRes };
        }

        if (HELP_RE.test(norm) && this._hasActiveQuestionOrForm()) {
          const helpRes = this._handleContextualHelp(clean);
          return { handled: true, result: helpRes };
        }

        // 3. Answer-First Interpretation for pending dialogue question
        if (this.pendingPrompt) {
          const isWakeResumePrompt = this.pendingPrompt.label === 'resume_resting_task';
          if (isWakeResumePrompt && /\b(?:continue\s+where\s+we\s+left\s+off|resume\s+where\s+we\s+left\s+off|pick\s+up\s+where\s+we\s+left\s+off|continue\s+task)\b/i.test(norm)) {
            const p = this.pendingPrompt;
            this.pendingPrompt = null;
            const res = p.onAnswer ? await p.onAnswer(true, { rawText: clean, meta }) : true;
            this.recordTurn({ user: clean, action: 'resume_resting_task', assistant: this.lastSpokenText });
            return { handled: true, result: { status: 'resumed_task', res } };
          }
          const answerRes = await this._tryAnswerPendingPrompt(clean, norm, meta);
          if (answerRes && answerRes.handled) {
            return { handled: true, result: answerRes.result };
          }
          // If the user ignored a soft wake/recommendation/clarification prompt and moved to a fresh command, clear the stale prompt
          if (
            isWakeResumePrompt ||
            (this.pendingPrompt && (
              this.pendingPrompt.label === 'open_recommended_website' ||
              this.pendingPrompt.label === 'ambiguous_entity_clarification' ||
              this.pendingPrompt.label === 'collecting_booking_constraints'
            ))
          ) {
            this.pendingPrompt = null;
          }
        }

        return { handled: false };
      } finally {
        this._isProcessingTurn = false;
        if (this.active && !this._isSystemSpeaking() && !this.pausedForSpeech) {
          this._scheduleSilenceTimers();
        }
      }
    }

    /**
     * Called by widget after general handleUserInput finishes a turn.
     */
    recordTurn({ user = '', action = '', assistant = '', meta = {} } = {}) {
      if (meta && meta.sensitive) {
        assistant = '[protected field]';
      }
      const cleanUser = this._redactSensitive(user);
      const cleanAssistant = this._redactSensitive(assistant);
      this.memory.push({
        user: cleanUser,
        action: String(action || ''),
        assistant: cleanAssistant,
        ts: Date.now()
      });
      if (this.memory.length > 3) {
        this.memory.shift();
      }
    }

    getMemory() {
      return this.memory.map((item) => ({ ...item }));
    }

    isRestPhrase(rawText, normalized = null) {
      const norm = normalized || this._normalizeForDialogue(rawText);
      if (!norm) return false;
      const wordCount = norm.split(/\s+/).filter(Boolean).length;
      if (wordCount <= 8 && REST_PHRASE_RE.test(norm)) return true;
      return [
        'thank you you can rest',
        'thank you you can rest now',
        'you can rest',
        'you can rest now',
        'sleepwalker rest',
        'sleepwalker rest now',
        'take a rest',
        'rest now',
        'bas band karo',
        'stop listening',
        'thats all',
        'that is all',
        'finish',
        'shukriya',
        'बस बंद करो'
      ].includes(norm);
    }

    isEndPhrase(rawText, normalized = null) {
      const norm = normalized || this._normalizeForDialogue(rawText);
      if (!norm) return false;
      if (END_PHRASES.has(norm)) return true;
      const trimmed = norm
        .replace(/^(?:ok|okay|alright|haan|ji|accha|achha|please|sleepwalker)\s+/i, '')
        .replace(/\s+(?:please|now|sleepwalker|bhai|ji)$/i, '')
        .trim();
      return END_PHRASES.has(trimmed);
    }

    /* ------------------------------------------------------------------ *
     * Meta-Command Handlers
     * ------------------------------------------------------------------ */

    _extractCorrectionValue(rawText) {
      const clean = String(rawText || '').trim();
      const patterns = [
        /^(?:no|nahi|actually|sorry|oops|wait|galat)[\s,]+(?:(?:make|set|change)\s+(?:it|that|this)\s+(?:to\s+)?|use\s+|put\s+|write\s+|it\s+is\s+|ise\s+|isko\s+|badal\s*kar\s+|badlo\s+)(.+)$/i,
        /^(?:change|correct|update|edit)\s+(?:it|that|this|last|the\s+last\s+one)\s+(?:to|as)\s+(.+)$/i,
        /^(?:nahi|नहीं)[\s,]+(?:ise|isko|यह)\s*(.+?)\s*(?:kar\s*do|कर\s*दो|kardo|बदलो)?$/i
      ];
      for (const re of patterns) {
        const m = re.exec(clean);
        if (m && m[1]) {
          const val = m[1].trim().replace(/^["']|["']$/g, '');
          if (val) return val;
        }
      }
      return null;
    }

    async _handleCorrection(newValue, rawText) {
      if (this.pendingPrompt && typeof this.pendingPrompt.onCorrection === 'function') {
        const res = await this.pendingPrompt.onCorrection(newValue, rawText);
        this.recordTurn({ user: rawText, action: 'correction', assistant: this.lastSpokenText });
        return { status: 'correction_applied', value: newValue, detail: res };
      }

      if (this.lastAnswerAction && typeof this.lastAnswerAction.retry === 'function') {
        const res = await this.lastAnswerAction.retry(newValue);
        this.recordTurn({ user: rawText, action: 'correction', assistant: this.lastSpokenText });
        return { status: 'correction_applied', value: newValue, detail: res };
      }

      const forms = this.widget && this.widget.forms;
      if (forms && forms.isGuidedActive && forms.isGuidedActive()) {
        const confirm = this.widget && this.widget.confirm;
        if (confirm && confirm.isAwaiting()) {
          confirm.cancel('replaced');
          forms.guidedState.awaitingValue = true;
        } else if (Array.isArray(forms.undoStack) && forms.undoStack.length > 0) {
          forms.undoLast();
          if (forms.guidedState && forms.guidedState.index > 0) {
            forms.guidedState.index -= 1;
          }
          forms.guidedState.awaitingValue = true;
        }
        forms.handleGuidedInput(newValue);
        this.recordTurn({ user: rawText, action: 'form_correction', assistant: `Changed to ${newValue}` });
        return { status: 'form_correction_applied', value: newValue };
      }

      if (this.widget && this.widget.elementSelector && this.widget.elementSelector._lastSelectionMeta &&
          (Date.now() - this.widget.elementSelector._lastSelectionMeta.ts < 90000)) {
        const selRes = await this.widget.elementSelector.handleCommand(`select ${newValue}`, {
          doc: typeof document !== 'undefined' ? document : null,
          isCorrection: true
        });
        if (selRes && selRes.ok) {
          this.recordTurn({ user: rawText, action: 'element_correction', assistant: selRes.message || `Updated to ${newValue}` });
          return { status: 'element_correction_applied', value: newValue, res: selRes };
        }
      }

      if (forms && Array.isArray(forms.undoStack) && forms.undoStack.length > 0) {
        const lastBatch = forms.undoStack[forms.undoStack.length - 1];
        const snap = Array.isArray(lastBatch) ? lastBatch[0] : null;
        if (snap && snap.element) {
          forms.undoLast();
          const res = forms.setControlValueSafe(
            { element: snap.element, type: (snap.element.type || 'text').toLowerCase(), label: snap.label },
            newValue
          );
          const msg = res && res.ok
            ? `Updated "${snap.label}" to "${newValue}".`
            : ((res && res.error) || `Could not update "${snap.label}".`);
          this._sayAndDisplay(msg);
          this.recordTurn({ user: rawText, action: 'field_correction', assistant: msg });
          return { status: 'field_correction_applied', value: newValue, res };
        }
      }

      // If user is correcting a candidate/video/link/section/search choice rather than a form field, delegate to NLU/correction handler.
      if (/\b(?:channel|video|link|option|section|under|second|first|third|other\s+one|official|docs|search)\b/i.test(String(rawText || '')) ||
          (this.widget && this.widget.memory && this.widget.memory.state && this.widget.memory.state.activeCandidateListId)) {
        return null;
      }

      const msg = `Tell me which field you want to change to "${newValue}".`;
      this._sayAndDisplay(msg);
      return { status: 'correction_needs_target', value: newValue };
    }

    _handleSkip(rawText) {
      if (this.pendingPrompt && typeof this.pendingPrompt.onSkip === 'function') {
        const res = this.pendingPrompt.onSkip();
        this.recordTurn({ user: rawText, action: 'skip', assistant: this.lastSpokenText });
        return { status: 'skipped', detail: res };
      }
      const forms = this.widget && this.widget.forms;
      if (forms && forms.isGuidedActive && forms.isGuidedActive()) {
        const confirm = this.widget && this.widget.confirm;
        if (confirm && confirm.isAwaiting()) {
          confirm.cancel('replaced');
        }
        forms.guidedState.index += 1;
        forms.guidedState.awaitingValue = true;
        forms._promptCurrentGuidedField();
        this.recordTurn({ user: rawText, action: 'guided_skip', assistant: this.lastSpokenText });
        return { status: 'guided_skipped' };
      }
      if (this.pendingPrompt) {
        this.pendingPrompt = null;
        this._sayAndDisplay('Skipped.');
        return { status: 'prompt_skipped' };
      }
      if (this.widget && this.widget.confirm && this.widget.confirm.isAwaiting()) {
        this.widget.confirm.cancel('user_skip');
        this._sayAndDisplay('Skipped confirmation.');
        return { status: 'confirm_skipped' };
      }
      return null;
    }

    _handleBack(rawText) {
      if (this.pendingPrompt && typeof this.pendingPrompt.onBack === 'function') {
        const res = this.pendingPrompt.onBack();
        this.recordTurn({ user: rawText, action: 'back', assistant: this.lastSpokenText });
        return { status: 'went_back', detail: res };
      }
      const forms = this.widget && this.widget.forms;
      if (forms && forms.isGuidedActive && forms.isGuidedActive()) {
        const confirm = this.widget && this.widget.confirm;
        if (confirm && confirm.isAwaiting()) {
          confirm.cancel('replaced');
          forms.guidedState.awaitingValue = true;
          forms._promptCurrentGuidedField();
          return { status: 'guided_reprompted' };
        }
        if (forms.guidedState.index > 0) {
          forms.guidedState.index -= 1;
          forms.guidedState.awaitingValue = true;
          forms._promptCurrentGuidedField();
          this.recordTurn({ user: rawText, action: 'guided_back', assistant: this.lastSpokenText });
          return { status: 'guided_went_back' };
        }
        const firstMsg = 'Already at the first field.';
        this._sayAndDisplay(firstMsg);
        return { status: 'at_first_field' };
      }
      return null;
    }

    _handleRepeat(rawText) {
      const promptMsg = (this.pendingPrompt && this.pendingPrompt.askedText) ||
        this.lastSpokenText ||
        (this.widget && this.widget.shadowRoot && this.widget.shadowRoot.getElementById('sw-assistant-text')
          ? this.widget.shadowRoot.getElementById('sw-assistant-text').textContent
          : '') ||
        'Nothing to repeat yet.';
      this._sayAndDisplay(promptMsg);
      this.recordTurn({ user: rawText, action: 'repeat', assistant: promptMsg });
      return { status: 'repeated', text: promptMsg };
    }

    async _handleUndo(rawText) {
      if (this.pendingPrompt && typeof this.pendingPrompt.onUndo === 'function') {
        const res = await this.pendingPrompt.onUndo();
        this.recordTurn({ user: rawText, action: 'undo', assistant: this.lastSpokenText });
        return { status: 'undone', detail: res };
      }
      if (this.lastAnswerAction && typeof this.lastAnswerAction.undo === 'function') {
        const msg = await this.lastAnswerAction.undo();
        this.lastAnswerAction = null;
        this._sayAndDisplay(msg || 'Undid last answer.');
        this.recordTurn({ user: rawText, action: 'undo', assistant: msg || 'Undid last answer.' });
        return { status: 'undone_last_answer' };
      }
      if (this.widget && typeof this.widget.dispatchIntent === 'function') {
        const forms = this.widget.forms;
        const topBatch = forms && Array.isArray(forms.undoStack) && forms.undoStack.length > 0
          ? forms.undoStack[forms.undoStack.length - 1]
          : null;
        const undoneEl = Array.isArray(topBatch) && topBatch[0] ? topBatch[0].element : null;

        await this.widget.dispatchIntent({ intent: 'UNDO', args: {}, confidence: 1.0 }, rawText);

        // If inside guided fill and the undone element was the previous guided field, step back so the user can refill it cleanly
        if (forms && forms.isGuidedActive && forms.isGuidedActive() && undoneEl && forms.guidedState) {
          const prevIdx = forms.guidedState.index - 1;
          const prevField = prevIdx >= 0 && forms.guidedState.fields ? forms.guidedState.fields[prevIdx] : null;
          if (prevField && prevField.element === undoneEl) {
            if (this.widget.confirm && this.widget.confirm.isAwaiting()) {
              this.widget.confirm.cancel('replaced');
            }
            forms.guidedState.index = prevIdx;
            forms.guidedState.awaitingValue = true;
            if (typeof forms._promptCurrentGuidedField === 'function') {
              forms._promptCurrentGuidedField();
            }
          }
        }
        return { status: 'dispatched_undo' };
      }
      return { status: 'nothing_to_undo' };
    }

    _handleContextualHelp(rawText) {
      const custom = this.pendingPrompt && this.pendingPrompt.helpText;
      const helpMsg = custom ||
        'Reply with your answer, or say "Skip", "Back", "Repeat", "Undo", "No, change it to ...", or "Thanks" to finish.';
      this._sayAndDisplay(helpMsg);
      this.recordTurn({ user: rawText, action: 'contextual_help', assistant: helpMsg });
      return { status: 'contextual_help' };
    }

    /* ------------------------------------------------------------------ *
     * Answer-First Prompt Interpreter
     * ------------------------------------------------------------------ */

    async _tryAnswerPendingPrompt(rawText, norm, meta = {}) {
      const prompt = this.pendingPrompt;
      if (!prompt) return { handled: false };

      if (prompt.kind === 'yesno') {
        if (YES_RE.test(norm)) {
          this.pendingPrompt = null;
          const res = prompt.onAnswer ? await prompt.onAnswer(true, { rawText, meta }) : true;
          this.recordTurn({ user: rawText, action: `answer_yes:${prompt.label || 'prompt'}`, assistant: this.lastSpokenText });
          return { handled: true, result: { status: 'answered_yes', res } };
        }
        if (NO_RE.test(norm)) {
          this.pendingPrompt = null;
          const res = prompt.onAnswer ? await prompt.onAnswer(false, { rawText, meta }) : false;
          this.recordTurn({ user: rawText, action: `answer_no:${prompt.label || 'prompt'}`, assistant: this.lastSpokenText });
          return { handled: true, result: { status: 'answered_no', res } };
        }
        return { handled: false };
      }

      if (prompt.kind === 'choice' && Array.isArray(prompt.options) && prompt.options.length > 0) {
        const picked = this._matchChoiceOption(norm, rawText, prompt.options);
        if (picked) {
          this.pendingPrompt = null;
          if (typeof prompt.onClear === 'function') {
            try { prompt.onClear(); } catch (_e) {}
          }
          const res = prompt.onAnswer ? await prompt.onAnswer(picked.option, { index: picked.index, rawText, meta }) : picked;
          this.recordTurn({ user: rawText, action: `answer_choice:${picked.option}`, assistant: this.lastSpokenText });
          return { handled: true, result: { status: 'answered_choice', picked, res } };
        }
        return { handled: false };
      }

      // Open question / field value
      if (prompt.onAnswer) {
        const res = await prompt.onAnswer(rawText, { norm, meta });
        if (res && res.handled === false) {
          return { handled: false };
        }
        if (res && typeof res.undo === 'function') {
          this.lastAnswerAction = {
            undo: res.undo,
            retry: typeof res.retry === 'function' ? res.retry : null
          };
        }
        if (!res || res.keepPrompt !== true) {
          this.pendingPrompt = null;
        }
        this.recordTurn({
          user: rawText,
          action: `answer:${prompt.label || 'question'}`,
          assistant: this.lastSpokenText,
          meta: { sensitive: prompt.sensitive }
        });
        return { handled: true, result: { status: 'answered_value', res } };
      }

      return { handled: false };
    }

    _matchChoiceOption(norm, rawText, options) {
      const mNum = /^(?:the\s+)?(?:number|option|choice)?\s*(\d+)(?:st|nd|rd|th)?(?:\s*(?:one|wala))?$/.exec(norm);
      if (mNum) {
        const idx = parseInt(mNum[1], 10) - 1;
        if (idx >= 0 && idx < options.length) {
          return { index: idx, option: options[idx] };
        }
      }

      const cleanRaw = String(rawText || '').trim().toLowerCase();
      const fillerStop = new Set(['the', 'a', 'an', 'one', 'option', 'choice', 'under', 'in', 'inside', 'from', 'underneath', 'section', 'group', 'use', 'pick', 'select', 'choose', 'want', 'i', 'mean', 'meant', 'please', 'for', 'of', 'on', 'that', 'this']);
      const meaningfulTokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter((t) => t.length >= 2 && !fillerStop.has(t));
      const userMeanToks = meaningfulTokens(cleanRaw || norm);

      // Priority 1: Match parent/context/label words cleanly before ordinal words ("one under appearance", "the product size")
      let bestLabelIdx = -1;
      let bestLabelScore = 0;
      for (let i = 0; i < options.length; i += 1) {
        const label = typeof options[i] === 'string'
          ? options[i]
          : (options[i].label || options[i].text || options[i].value || '');
        if (!label) continue;
        const lowerLabel = label.toLowerCase();
        const strippedUser = userMeanToks.join(' ');
        if (lowerLabel === cleanRaw || lowerLabel === norm) {
          return { index: i, option: options[i] };
        }
        let sc = 0;
        if (strippedUser && lowerLabel.includes(strippedUser)) sc += 80;
        if (lowerLabel.includes(cleanRaw) || cleanRaw.includes(lowerLabel)) sc += 65;
        if (userMeanToks.length > 0) {
          const optToks = meaningfulTokens(lowerLabel);
          const hits = userMeanToks.filter((t) => optToks.includes(t) || lowerLabel.includes(t)).length;
          if (hits > 0) {
            sc += Math.round((hits / userMeanToks.length) * 60);
          }
        }
        if (sc > bestLabelScore) {
          bestLabelScore = sc;
          bestLabelIdx = i;
        }
      }
      if (bestLabelIdx >= 0 && bestLabelScore >= 40) {
        return { index: bestLabelIdx, option: options[bestLabelIdx] };
      }

      // Priority 2: Ordinal word matching ("first", "the second one", standalone "one" — NOT "one under X")
      const words = norm.split(/\s+/).filter(Boolean);
      const looksLikeQuestionSentence = words.length > 4 || /\b(?:what|how|why|when|where|who|visa|trip|need)\b/i.test(norm);
      if (!looksLikeQuestionSentence) {
        const oneIsBareOrNumber = /^(?:(?:the\s+)?(?:number|option|choice)\s+)?one$/i.test(norm.trim());
        for (const w of words) {
          if (w === 'do' && /\bdo\s+(?:i|you|we|they|it|that|not)\b/i.test(norm)) continue;
          if (w === 'one' && !oneIsBareOrNumber) continue;
          if (Object.prototype.hasOwnProperty.call(ORDINAL_WORDS, w)) {
            const idx = ORDINAL_WORDS[w];
            if (idx >= 0 && idx < options.length) {
              return { index: idx, option: options[idx] };
            }
          }
        }
      }
      return null;
    }

    /* ------------------------------------------------------------------ *
     * Timers & Internal Sync
     * ------------------------------------------------------------------ */

    _isUserTypingInOrb() {
      if (typeof window === 'undefined' || !window.SW_UI || !window.SW_UI._orb) return false;
      const orb = window.SW_UI._orb;
      if (!orb.typeForm || orb.typeForm.hidden) return false;
      const hasDraft = Boolean(orb.typeInput && String(orb.typeInput.value || '').trim().length > 0);
      const isFocused = Boolean(orb.shadow && orb.shadow.activeElement === orb.typeInput);
      return hasDraft || isFocused;
    }

    _scheduleSilenceEndTimer() {
      if (this._silenceEndTimer) {
        clearTimeout(this._silenceEndTimer);
        this._silenceEndTimer = null;
      }
      this._silenceEndTimer = setTimeout(() => {
        this._silenceEndTimer = null;
        if (this._isUserTypingInOrb()) {
          this._promptedSilence = false;
          return;
        }
        if (this.active && this._promptedSilence) {
          this.endSession({ reason: 'silence', quiet: true, force: true });
        }
      }, this.timers.silenceEndMs);
    }

    _scheduleSilenceTimers() {
      this._clearSilenceTimers();
      if (!this.active || this._isSystemSpeaking() || this._isProcessingTurn || this._externalTurnInProgress || this._promptedSilence || this._isUserTypingInOrb()) return;

      this._silencePromptTimer = setTimeout(() => {
        this._silencePromptTimer = null;
        if (!this.active || this._isSystemSpeaking() || this._isProcessingTurn || this._externalTurnInProgress || this._isUserTypingInOrb()) return;
        this._promptedSilence = true;
        const msg = this.widget && this.widget.lang === 'hi-IN'
          ? 'क्या आप अभी भी सुन रहे हैं?'
          : 'Are you still there?';
        this.pendingPrompt = {
          kind: 'still_there',
          askedText: msg
        };
        this._sayAndDisplay(msg, { openBubble: true, speak: true });
        this._scheduleSilenceEndTimer();
      }, this.timers.silencePromptMs);
    }

    _clearSilenceTimers() {
      if (this._silencePromptTimer) {
        clearTimeout(this._silencePromptTimer);
        this._silencePromptTimer = null;
      }
      if (this._silenceEndTimer) {
        clearTimeout(this._silenceEndTimer);
        this._silenceEndTimer = null;
      }
    }

    _clearResumeTimer() {
      if (this._resumeTimer) {
        clearTimeout(this._resumeTimer);
        this._resumeTimer = null;
      }
    }

    _clearAllTimers() {
      this._clearResumeTimer();
      this._clearSilenceTimers();
    }

    _hasActiveQuestionOrForm() {
      return Boolean(
        this.pendingPrompt ||
        (this.widget && this.widget.confirm && this.widget.confirm.isAwaiting()) ||
        (this.widget && this.widget.forms && this.widget.forms.isGuidedActive())
      );
    }

    _isSystemSpeaking() {
      return Boolean(this.widget && this.widget.reader && this.widget.reader.isPlaying && !this.widget.reader.isPaused);
    }

    _sayAndDisplay(text, { openBubble = true, speak = true, allowDuringEndedSession = false } = {}) {
      this.lastSpokenText = text;
      if (!this.widget) return;
      this.widget.setAssistantReply(text);
      if (this.widget.pill) {
        this.widget.pill.setStatus(text);
        if (openBubble) this.widget.pill.openBubble();
      }
      if (speak && this.widget.reader && (this.active || allowDuringEndedSession)) {
        if (!allowDuringEndedSession && this.active && !this.bargeIn && this.widget.voice && this.widget.voice.isListening) {
          this.pausedForSpeech = true;
          this.widget.voice.pauseTemporary();
          this._syncSessionIndicators();
        }
        this.widget.reader.readText(text);
      }
    }

    _syncSessionIndicators() {
      if (!this.widget) return;
      const micSessionState = !this.active
        ? 'idle'
        : (this.pausedForSpeech && !this.bargeIn ? 'paused' : 'active');

      if (this.widget.pill && typeof this.widget.pill.setMicSessionState === 'function') {
        this.widget.pill.setMicSessionState(micSessionState);
      }
      if (this.widget.shadowRoot) {
        const micBtn = this.widget.shadowRoot.getElementById('sw-btn-mic');
        if (micBtn) {
          micBtn.dataset.micSession = micSessionState;
          micBtn.classList.toggle('sw-session-active', this.active);
        }
      }
    }

    _normalizeForDialogue(text) {
      return String(text || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[.,!?;:()\[\]{}"“”]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    _redactSensitive(text) {
      const s = String(text || '');
      if (!s) return '';
      if (/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/.test(s) || /\b(?:\d[\s-]?){13,19}\b/.test(s) || /\b[A-Z]{5}\d{4}[A-Z]\b/i.test(s)) {
        return '[redacted id]';
      }
      if (/\b(?:password|passwd|pwd|otp|one[-_\s]?time|passcode|upi[-_\s]?pin|pin\b|cvv|cvc|secret|captcha)\b/i.test(s)) {
        return '[redacted secret]';
      }
      const redactedFiles = s.replace(/\b[^\s/\\]+\.(?:jpe?g|png|gif|webp|pdf|docx?|xlsx?|txt)\b/gi, '[file]');
      return redactedFiles.slice(0, 140);
    }
  }

  window.SleepwalkerDialogue = SleepwalkerDialogue;
})();
