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

  class SleepwalkerVoice {
    constructor() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.isSupported = Boolean(SpeechRecognition);

      this.recognition = null;
      this.isListening = false;
      this.lang = 'en-IN'; // 'en-IN' or 'hi-IN'
      this.silenceTimer = null;
      this.lastInterim = '';
      this.useOffscreen = false;

      // Callbacks
      this.onTranscript = null; // ({ text, isFinal }) => {}
      this.onCommand = null;    // ({ type, raw, sectionQuery }) => {}
      this.onError = null;      // ({ error, message, isPermissionDenied }) => {}
      this.onStateChange = null;// (isListening) => {}

      if (this.isSupported) {
        this.initRecognition(SpeechRecognition);
      }

      this.initOffscreenListener();
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
              this.onTranscript({ text: message.interim, isFinal: false });
            }
            if (message.final) {
              if (this.onTranscript) {
                this.onTranscript({ text: message.final, isFinal: true });
              }
              const parsed = this.parseCommand(message.final);
              if (this.onCommand) {
                this.onCommand(parsed);
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
     * Initialize SpeechRecognition instance and configure event listeners.
     */
    initRecognition(SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.maxAlternatives = 1;
      this.recognition.lang = this.lang;

      this.recognition.onstart = () => {
        this.isListening = true;
        if (this.onStateChange) this.onStateChange(true);
      };

      this.recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interimTranscript += transcript;
          }
        }

        // Live interim feedback
        if (interimTranscript && this.onTranscript) {
          this.lastInterim = interimTranscript;
          this.onTranscript({ text: interimTranscript.trim(), isFinal: false });

          // Reset 2-second silence timer: if user goes quiet for 2s after speaking, auto-commit command!
          if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
          }
          if (interimTranscript.trim().length > 1) {
            this.silenceTimer = setTimeout(() => {
              if (this.isListening && this.lastInterim.trim().length > 1) {
                console.log('[Sleepwalker Voice] Silence timeout (2s), executing command:', this.lastInterim);
                const text = this.lastInterim.trim();
                this.stopListening();
                const parsed = this.parseCommand(text);
                if (this.onCommand) {
                  this.onCommand(parsed);
                }
              }
            }, 2000);
          }
        }

        // Process final speech recognition result
        if (finalTranscript) {
          if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
          }
          this.lastInterim = '';

          const cleanFinal = finalTranscript.trim();
          if (this.onTranscript) {
            this.onTranscript({ text: cleanFinal, isFinal: true });
          }

          const parsed = this.parseCommand(cleanFinal);
          if (this.onCommand) {
            this.onCommand(parsed);
          }
        }
      };

      this.recognition.onerror = (event) => {
        console.warn('[Sleepwalker Voice] Recognition error:', event.error);

        let userMessage = 'Voice recognition error.';
        let isPermissionDenied = false;

        switch (event.error) {
          case 'not-allowed':
          case 'service-not-allowed':
            isPermissionDenied = true;
            this.isListening = false;
            userMessage = '⚠️ Microphone permission was blocked. Please click the lock/camera icon in Chrome’s address bar, allow Microphone, and reload the page. You can also use the typed input box below.';
            break;
          case 'no-speech':
            // Harmless; user was just quiet
            return;
          case 'audio-capture':
            userMessage = 'No microphone was detected. Please verify your microphone connection.';
            break;
          case 'network':
            userMessage = 'Speech recognition network error. Please check your internet connection or use typed commands.';
            break;
          default:
            userMessage = `Voice recognition error: ${event.error}`;
        }

        if (this.onError) {
          this.onError({
            error: event.error,
            message: userMessage,
            isPermissionDenied
          });
        }

        if (isPermissionDenied) {
          this.stopListening();
        }
      };

      this.recognition.onend = () => {
        // If user intentionally kept listening on, restart unless stopped or error
        if (this.isListening) {
          try {
            this.recognition.start();
          } catch (e) {
            this.isListening = false;
            if (this.onStateChange) this.onStateChange(false);
          }
        } else {
          if (this.onStateChange) this.onStateChange(false);
        }
      };
    }

    /**
     * Start listening to voice input.
     * Evaluates offscreen document if enabled, falling back cleanly to content-script recognition.
     */
    startListening() {
      if (this.useOffscreen && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'SLEEPWALKER_START_OFFSCREEN_VOICE', lang: this.lang },
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
        if (this.onError) {
          this.onError({
            error: 'not-supported',
            message: 'Speech recognition is not supported in this browser. Please use the typed input box.',
            isPermissionDenied: false
          });
        }
        return false;
      }

      this.isListening = true;
      try {
        this.recognition.lang = this.lang;
        this.recognition.start();
        return true;
      } catch (err) {
        // Recognition already started or error
        return true;
      }
    }

    /**
     * Stop listening to voice input.
     */
    stopListening() {
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      this.isListening = false;

      if (this.useOffscreen && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_STOP_OFFSCREEN_VOICE' });
      }

      if (this.recognition) {
        try {
          this.recognition.stop();
        } catch (e) {}
      }
      if (this.onStateChange) this.onStateChange(false);
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
      this.lastInterim = '';
      this.stopListening();

      if (pending.length > 1) {
        const parsed = this.parseCommand(pending);
        if (this.onCommand) {
          this.onCommand(parsed);
        }
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
     * Change recognition language ('en-IN' or 'hi-IN').
     */
    setLang(newLang) {
      this.lang = newLang;
      if (this.recognition) {
        this.recognition.lang = newLang;
        // If listening, restart with new language
        if (this.isListening) {
          this.recognition.stop();
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
