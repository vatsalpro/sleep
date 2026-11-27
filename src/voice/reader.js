/**
 * Sleepwalker - reader.js
 *
 * Responsibilities:
 * 1. Extract main readable content from the web page (preferring main, article, [role=main]).
 * 2. Parse text into individual sentences, including structured support for tables.
 * 3. Read aloud sentence-by-sentence using Web SpeechSynthesis.
 * 4. Visually highlight and smooth-scroll to the sentence/element being read.
 * 5. Support pause, resume, stop, and read-again.
 * 6. Resilient SpeechSynthesis error recovery: retries with default voice before reporting error.
 */

(function () {
  'use strict';

  // Prevent multiple instantiations if injected repeatedly
  if (window.SleepwalkerReader) return;

  const VOICE_PERSONAS = Object.freeze({
    nova: {
      id: 'nova',
      name: 'Nova',
      subtitle: 'Friendly & Conversational',
      pitch: 1.03,
      rateMul: 0.99,
      genderPref: 'female',
      keywords: ['ava', 'emma', 'jenny', 'aria', 'neerja', 'swara', 'natural', 'google uk english female', 'google us english', 'samantha', 'online']
    },
    aria: {
      id: 'aria',
      name: 'Aria',
      subtitle: 'Bright & Expressive',
      pitch: 1.08,
      rateMul: 1.02,
      genderPref: 'female',
      keywords: ['sonia', 'emma', 'ava', 'natasha', 'clara', 'aria', 'google us english', 'natural', 'zira']
    },
    orion: {
      id: 'orion',
      name: 'Orion',
      subtitle: 'Warm & Deep',
      pitch: 0.90,
      rateMul: 0.97,
      genderPref: 'male',
      keywords: ['andrew', 'brian', 'guy', 'ryan', 'christopher', 'prabhat', 'madhur', 'google uk english male', 'daniel', 'natural']
    },
    sage: {
      id: 'sage',
      name: 'Sage',
      subtitle: 'Friendly Storyteller',
      pitch: 0.99,
      rateMul: 0.96,
      genderPref: 'any',
      keywords: ['libby', 'ava', 'google uk english female', 'google uk english male', 'rishi', 'emily', 'thomas', 'natural']
    },
    breeze: {
      id: 'breeze',
      name: 'Breeze',
      subtitle: 'Upbeat Buddy',
      pitch: 1.06,
      rateMul: 1.05,
      genderPref: 'any',
      keywords: ['ava', 'jenny', 'google', 'online', 'neural', 'natural', 'michelle', 'steffan', 'ana']
    }
  });

  const PERSONA_ORDER = ['nova', 'aria', 'orion', 'sage', 'breeze'];

  class SleepwalkerReader {
    constructor() {
      this.sentences = [];       // Array of { text, element }
      this.currentIndex = 0;     // Current sentence being read
      this.isPlaying = false;    // Reading active
      this.isPaused = false;     // Reading temporarily paused
      this.rate = 1.0;           // Speech speed (0.8x to 1.5x)
      this.lang = 'en-IN';       // 'en-IN' or 'hi-IN'
      this.voicePersona = 'nova'; // 'nova' | 'aria' | 'orion' | 'sage' | 'breeze'
      this.preferredVoiceURI = ''; // Optional exact system/browser voice URI override
      this.activeHighlight = null; // Currently highlighted element
      this._retriedWithDefaultVoice = false; // Flag for fallback attempt
      this.lastMode = 'page'; // 'page' | 'elements' | 'text'

      // Callbacks for UI updates
      this.onSentenceChange = null; // ({ index, total, text }) => {}
      this.onStatusChange = null;   // ({ isPlaying, isPaused }) => {}
      this.onFinished = null;       // () => {}
      this.onError = null;          // (errorMessage) => {}

      this._currentUtterance = null;
      this._utteranceWatchdogTimer = null;

      // Pre-bind voices
      this.voices = [];
      this.loadVoices();
      if ('speechSynthesis' in window) {
        window.speechSynthesis.onvoiceschanged = () => this.loadVoices();
      }

      this.injectHighlightStyles();
    }

    /**
     * Cache system speech synthesis voices.
     */
    loadVoices() {
      if ('speechSynthesis' in window) {
        this.voices = window.speechSynthesis.getVoices() || [];
      }
    }

    /**
     * Inject minimal global CSS into the webpage document for sentence highlighting.
     */
    injectHighlightStyles() {
      if (document.getElementById('sleepwalker-reader-styles')) return;

      const style = document.createElement('style');
      style.id = 'sleepwalker-reader-styles';
      style.textContent = `
        .sleepwalker-active-sentence {
          background-color: #FFF176 !important;
          color: #000000 !important;
          outline: 3px solid #FBC02D !important;
          outline-offset: 2px !important;
          border-radius: 4px !important;
          box-shadow: 0 0 12px rgba(251, 192, 45, 0.7) !important;
          transition: background-color 0.25s ease, outline 0.25s ease !important;
        }
      `;
      document.head.appendChild(style);
    }

    getVoicePersonas() {
      return PERSONA_ORDER.map((id) => ({ ...VOICE_PERSONAS[id] }));
    }

    getCurrentPersonaInfo() {
      return VOICE_PERSONAS[this.voicePersona] || VOICE_PERSONAS.nova;
    }

    setVoicePersona(personaId) {
      const clean = String(personaId || '').trim().toLowerCase();
      if (VOICE_PERSONAS[clean]) {
        this.voicePersona = clean;
      } else {
        this.voicePersona = 'nova';
      }
      return this.getCurrentPersonaInfo();
    }

    cycleVoicePersona() {
      const idx = PERSONA_ORDER.indexOf(this.voicePersona);
      const next = PERSONA_ORDER[(idx + 1) % PERSONA_ORDER.length];
      return this.setVoicePersona(next);
    }

    setPreferredVoiceURI(uri = '') {
      this.preferredVoiceURI = String(uri || '').trim();
    }

    /**
     * Make short assistant replies sound warm, friendly, and conversational — like a helpful person talking
     * rather than a stiff status log — while leaving long article/page narration faithful to the page text.
     */
    humanizeForSpeech(text) {
      let s = String(text || '').trim();
      if (!s) return s;
      // Leave long page-reading passages untouched except natural phrasing rhythm
      if (this.lastMode === 'page' && s.length > 140) return s;

      // Soften robotic prefixes into warm, natural conversational phrasing
      s = s
        .replace(/^Opening\s+video\s+/i, 'Sure thing! Opening ')
        .replace(/^Opening\s+"/i, 'Got it — opening "')
        .replace(/^Navigated\s+to\s+/i, 'Here we go, taking you to ')
        .replace(/^Completed\s+(\d+)\s+steps?:/i, 'All set! I ran $1 steps:')
        .replace(/^Completed\s+learned\s+workflow\s+/i, 'All done with ')
        .replace(/^No\s+YouTube\s+video\s+items\s+were\s+found/i, "Hmm, I don't see any videos on this page right now")
        .replace(/^Action\s+completed\.?$/i, 'All done!')
        .replace(/^Cancelled\.?$/i, 'No problem, cancelled that.');

      // Add gentle natural breathing cadence on dashes/colons
      s = s.replace(/\s+—\s+/g, ', ').replace(/\s+→\s+/g, ', then ');
      return s;
    }

    /**
     * Score & pick the most natural, expressive neural/cloud voice matching the selected
     * language and active voice persona — avoiding robotic legacy SAPI5 Desktop voices whenever possible.
     */
    getBestVoice(lang) {
      if (!this.voices || this.voices.length === 0) {
        this.loadVoices();
      }
      if (!this.voices || this.voices.length === 0) return null;

      const normalizedLang = (lang || this.lang || 'en-IN').toLowerCase();
      const langPrefix = normalizedLang.split('-')[0]; // 'en', 'hi', etc.
      const persona = this.getCurrentPersonaInfo();

      // 1. Honor explicit user-chosen voiceURI when compatible with the target language
      if (this.preferredVoiceURI) {
        const explicit = this.voices.find((v) => v && (v.voiceURI === this.preferredVoiceURI || v.name === this.preferredVoiceURI));
        if (explicit && (!explicit.lang || explicit.lang.toLowerCase().startsWith(langPrefix))) {
          return explicit;
        }
      }

      // 2. Filter voices matching target language family (fallback to all voices if none match)
      let pool = this.voices.filter((v) => v && v.lang && v.lang.toLowerCase().startsWith(langPrefix));
      if (pool.length === 0) {
        pool = this.voices.slice();
      }

      const MALE_HINTS = /\b(?:male|guy|ryan|christopher|prabhat|madhur|david|mark|daniel|george|rishi|james|eric|roger|steffan|thomas)\b/i;
      const FEMALE_HINTS = /\b(?:female|aria|jenny|sonia|natasha|neerja|swara|heera|zira|samantha|victoria|karen|libby|clara|emma|ava|michelle)\b/i;

      let bestVoice = null;
      let bestScore = -9999;

      for (const v of pool) {
        const nameLower = String(v.name || '').toLowerCase();
        const uriLower = String(v.voiceURI || '').toLowerCase();
        const vLang = String(v.lang || '').toLowerCase();
        let score = 0;

        // Strongly prefer Neural / Natural / Online / Google cloud voices over old robotic SAPI5 "Desktop" voices!
        if (/\b(?:natural|neural|online)\b/.test(nameLower) || /\b(?:natural|neural)\b/.test(uriLower)) {
          score += 65;
        } else if (nameLower.includes('google')) {
          score += 54;
        } else if (v.localService === false) {
          score += 38;
        }
        if (/\bdesktop\b/.test(nameLower) || /\b(?:espeak|microsoft david|microsoft mark|microsoft ravi|microsoft heera)\b/.test(nameLower)) {
          score -= 42;
        }

        // Persona keyword & vocal character affinity
        for (let i = 0; i < persona.keywords.length; i++) {
          if (nameLower.includes(persona.keywords[i])) {
            score += (38 - i * 2);
            break;
          }
        }
        if (persona.genderPref === 'male') {
          if (MALE_HINTS.test(nameLower)) score += 28;
          else if (FEMALE_HINTS.test(nameLower)) score -= 18;
        } else if (persona.genderPref === 'female') {
          if (FEMALE_HINTS.test(nameLower)) score += 24;
          else if (MALE_HINTS.test(nameLower)) score -= 16;
        }

        // Locale closeness (note: a Natural en-US/en-GB voice sounds MUCH better than a robotic SAPI5 en-IN Desktop voice!)
        if (vLang === normalizedLang) {
          score += 18;
        } else if (vLang.startsWith(langPrefix)) {
          score += 10;
        }

        if (score > bestScore) {
          bestScore = score;
          bestVoice = v;
        }
      }

      return bestVoice || this.voices.find((v) => v.default) || this.voices[0] || null;
    }

    /**
     * Find main content container.
     */
    getMainContainer() {
      // Priority 1: semantic HTML5 main / article / ARIA role=main
      const candidates = [
        'main',
        'article',
        '[role="main"]',
        '#main-content',
        '#content',
        '#bodyContent',
        '#mw-content-text',
        '.mw-parser-output',
        '.main-content',
        '.entry-content',
        '.article-body',
        '.post-content',
        '.content'
      ];

      for (const selector of candidates) {
        const el = document.querySelector(selector);
        if (el && el.offsetParent !== null && el.textContent.trim().length > 60) {
          return el;
        }
      }

      // Fallback: document body
      return document.body;
    }

    /**
     * Split a block of text into distinct sentences for reading.
     * Supports both English (.!?) and Hindi (। Devanagari Danda).
     */
    splitIntoSentences(text) {
      if (!text) return [];

      const cleaned = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!cleaned) return [];

      // Regex matches sentence-ending punctuation [.!?।] followed by space or end
      const sentenceRegex = /[^.!?।]+(?:[.!?।]|$)/gu;
      const matches = cleaned.match(sentenceRegex) || [cleaned];

      return matches
        .map(s => s.trim())
        .filter(s => s.length > 2 && /[a-zA-Z0-9\u0900-\u097F]/u.test(s));
    }

    /**
     * Convert an HTML <table> into clean, readable spoken sentences.
     */
    parseTableToSentences(tableEl) {
      const results = [];
      const caption = tableEl.querySelector('caption');
      if (caption && caption.textContent.trim()) {
        results.push({
          text: `Table: ${caption.textContent.trim()}`,
          element: caption
        });
      }

      // Extract column headers
      const headers = [];
      const thElements = tableEl.querySelectorAll('thead th, tr:first-child th');
      thElements.forEach(th => {
        headers.push(th.textContent.trim());
      });

      // Extract rows
      const rows = tableEl.querySelectorAll('tbody tr, tr');
      rows.forEach((tr, rowIndex) => {
        // Skip header row if it's the first tr
        if (rowIndex === 0 && thElements.length > 0 && tr.querySelector('th')) return;

        const cells = tr.querySelectorAll('td');
        if (cells.length === 0) return;

        const cellDescriptions = [];
        cells.forEach((td, cellIndex) => {
          const cellText = td.textContent.trim();
          if (!cellText) return;

          const headerName = headers[cellIndex];
          if (headerName) {
            cellDescriptions.push(`${headerName}: ${cellText}`);
          } else {
            cellDescriptions.push(cellText);
          }
        });

        if (cellDescriptions.length > 0) {
          results.push({
            text: `Row ${rowIndex + 1}: ${cellDescriptions.join(', ')}.`,
            element: tr
          });
        }
      });

      return results;
    }

    /**
     * Extract all readable sentences from a given root element or the whole page.
     */
    extractSentences(rootElement = null) {
      const container = rootElement || this.getMainContainer();
      const sentenceList = [];

      const ignoreSelector = `
        script, style, noscript, nav, footer, header, aside, form, svg,
        iframe, select, option, button, [role="navigation"], [role="banner"],
        [role="contentinfo"], [aria-hidden="true"], #sleepwalker-host, .sleepwalker-ignore
      `;

      const isVisible = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        if (el.closest(ignoreSelector)) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (!isVisible(node)) return NodeFilter.FILTER_REJECT;

            // Handle tables as special structured blocks
            if (node.tagName === 'TABLE') {
              return NodeFilter.FILTER_ACCEPT;
            }

            const blockTags = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE'];
            if (blockTags.includes(node.tagName)) {
              return NodeFilter.FILTER_ACCEPT;
            }

            return NodeFilter.FILTER_SKIP;
          }
        }
      );

      let currentNode = walker.nextNode();
      while (currentNode) {
        if (currentNode.tagName === 'TABLE') {
          const tableSentences = this.parseTableToSentences(currentNode);
          sentenceList.push(...tableSentences);
        } else {
          const rawText = currentNode.innerText || currentNode.textContent || '';
          const parts = this.splitIntoSentences(rawText);
          for (const sentenceText of parts) {
            sentenceList.push({
              text: sentenceText,
              element: currentNode
            });
          }
        }
        currentNode = walker.nextNode();
      }

      // If no block elements found, fallback to container text
      if (sentenceList.length === 0) {
        const bodyText = container.innerText || '';
        const fallbackSentences = this.splitIntoSentences(bodyText);
        for (const s of fallbackSentences) {
          sentenceList.push({
            text: s,
            element: container
          });
        }
      }

      return sentenceList;
    }

    /**
     * Start reading the whole page aloud.
     */
    readPage() {
      this.stop();
      this.lastMode = 'page';
      this.sentences = this.extractSentences();
      this.currentIndex = 0;
      this._retriedWithDefaultVoice = false;

      if (this.sentences.length === 0) {
        const msg = 'No readable text content found on this page.';
        if (this.onSentenceChange) {
          this.onSentenceChange({ index: 0, total: 0, text: msg });
        }
        if (this.onError) {
          this.onError(msg);
        }
        return false;
      }

      if (!('speechSynthesis' in window)) {
        const msg = 'SpeechSynthesis is not supported in this browser.';
        if (this.onError) this.onError(msg);
        return false;
      }

      this.isPlaying = true;
      this.isPaused = false;
      this.notifyStatus();
      this.playCurrentSentence();
      return true;
    }

    /**
     * Read arbitrary custom text sentence-by-sentence (e.g. for explanations or summaries).
     * @param {string} text - Raw text to speak.
     * @param {Object} [options] - Optional playback flags ({ keepStream }).
     */
    readText(text, options = {}) {
      if (!text || !text.trim()) return false;
      if (!options.keepStream && this._isStreamingMode) {
        this._teardownStreamState();
      }
      this.stop();
      this.lastMode = 'text';
      this.sentences = [];
      this._retriedWithDefaultVoice = false;

      const rawSentences = this.splitIntoSentences(text.trim());
      for (const s of rawSentences) {
        if (s.trim().length > 0) {
          this.sentences.push({
            text: s.trim(),
            element: null
          });
        }
      }

      this.currentIndex = 0;
      if (this.sentences.length === 0) return false;

      if (!('speechSynthesis' in window)) {
        if (this.onError) this.onError('SpeechSynthesis is not supported in this browser.');
        return false;
      }

      this.isPlaying = true;
      this.isPaused = false;
      this.notifyStatus();
      this.playCurrentSentence();
      return true;
    }

    /** True while a streamed TTS session is open or waiting on final sentence drain. */
    isStreamingActive() {
      return Boolean(this._isStreamingMode && (!this._streamEnded || this.isPlaying));
    }

    _teardownStreamState() {
      if (this._wrappedOnFinished) {
        this.onFinished = this._wrappedOnFinished.orig;
        this._wrappedOnFinished = null;
      }
      this._isStreamingMode = false;
      this._streamEnded = true;
      this._streamPumpIdle = true;
    }

    /**
     * Begin an incremental streaming speech session so sentences play as soon as they arrive
     * instead of waiting for the full LLM response to complete.
     */
    startStream({ lang } = {}) {
      this._teardownStreamState();
      this.stop();
      if (lang && typeof this.setLang === 'function') this.setLang(lang);
      this.lastMode = 'text';
      this.sentences = [];
      this.currentIndex = 0;
      this._retriedWithDefaultVoice = false;
      this._isStreamingMode = true;
      this._streamEnded = false;
      this._streamPumpIdle = true;

      const origOnFinished = this.onFinished;
      this._wrappedOnFinished = {
        orig: origOnFinished,
        proxy: (mode) => {
          if (this._isStreamingMode && !this._streamEnded) {
            this._streamPumpIdle = true;
            return;
          }
          const cb = this._wrappedOnFinished ? this._wrappedOnFinished.orig : origOnFinished;
          this._teardownStreamState();
          if (typeof cb === 'function') cb(mode);
        }
      };
      this.onFinished = this._wrappedOnFinished.proxy;
      return true;
    }

    /**
     * Enqueue a newly completed sentence chunk during streaming TTS.
     */
    enqueueStreamChunk(chunkText) {
      const clean = String(chunkText || '').trim();
      if (!clean) return false;
      if (!this._isStreamingMode) {
        return this.readText(clean);
      }

      if (this.isPlaying && !this._streamPumpIdle) {
        const parts = this.splitIntoSentences(clean);
        for (const s of parts) {
          if (s && s.trim()) {
            this.sentences.push({ text: s.trim(), element: null });
          }
        }
        return true;
      }

      this._streamPumpIdle = false;
      return this.readText(clean, { keepStream: true });
    }

    /**
     * Mark streaming source complete; fires `onFinished` immediately if queued audio already drained,
     * otherwise lets queued sentences finish naturally.
     */
    finishStream() {
      if (!this._isStreamingMode) return false;
      this._streamEnded = true;
      if (this._streamPumpIdle && !this.isPlaying) {
        const cb = this._wrappedOnFinished ? this._wrappedOnFinished.orig : null;
        this._teardownStreamState();
        this.notifyStatus();
        if (typeof cb === 'function') cb('text');
      }
      return true;
    }

    /** Cancel any active streaming TTS session immediately (used on barge-in / Escape / supersede). */
    cancelStream() {
      this._teardownStreamState();
      this.stop();
    }

    /**
     * Convenience helper: read an outline heading object's section elements.
     */
    readHeadingSection(heading) {
      if (!heading) return false;
      const els = Array.isArray(heading.sectionElements) && heading.sectionElements.length > 0
        ? heading.sectionElements
        : (heading.element ? [heading.element] : []);
      if (els.length === 0) return false;
      return this.readElements(els, heading.text || '');
    }

    /**
     * Read a specific subset of DOM elements (used by Outline: "read the <name> section").
     * @param {HTMLElement[]} elements - Array of section elements to read.
     * @param {string} sectionTitle - Name of the section.
     */
    readElements(elements, sectionTitle = '') {
      this.stop();
      this.lastMode = 'elements';
      this.sentences = [];
      this._retriedWithDefaultVoice = false;

      for (const el of elements) {
        const extracted = this.extractSentences(el);
        this.sentences.push(...extracted);
      }

      this.currentIndex = 0;

      if (this.sentences.length === 0) {
        const msg = `Section "${sectionTitle}" contains no readable text.`;
        if (this.onSentenceChange) {
          this.onSentenceChange({ index: 0, total: 0, text: msg });
        }
        if (this.onError) {
          this.onError(msg);
        }
        return false;
      }

      if (!('speechSynthesis' in window)) {
        const msg = 'SpeechSynthesis is not supported in this browser.';
        if (this.onError) this.onError(msg);
        return false;
      }

      this.isPlaying = true;
      this.isPaused = false;
      this.notifyStatus();
      this.playCurrentSentence();
      return true;
    }

    /**
     * Play sentence at this.currentIndex using SpeechSynthesis.
     * Includes single-retry error recovery with default system voice.
     */
    playCurrentSentence() {
      if (!this.isPlaying || this.currentIndex >= this.sentences.length) {
        this.finishReading();
        return;
      }

      const item = this.sentences[this.currentIndex];
      const sentenceText = item.text;
      const targetElement = item.element;

      // 1. Highlight and scroll
      this.highlightElement(targetElement);

      // 2. Notify UI
      if (this.onSentenceChange) {
        this.onSentenceChange({
          index: this.currentIndex + 1,
          total: this.sentences.length,
          text: sentenceText
        });
      }

      // 3. Synthesize Speech
      if (!('speechSynthesis' in window)) {
        console.warn('[Sleepwalker] SpeechSynthesis not supported.');
        if (this.onError) this.onError('SpeechSynthesis is not supported in this browser.');
        return;
      }

      // Ensure voices are loaded
      if (this.voices.length === 0) {
        this.loadVoices();
      }

      const rawSpeak = (window.SleepwalkerVoicePipeline && typeof window.SleepwalkerVoicePipeline.toSpeakable === 'function')
        ? (window.SleepwalkerVoicePipeline.toSpeakable(sentenceText) || sentenceText)
        : sentenceText;
      const speakText = this.humanizeForSpeech(rawSpeak);
      if (window.SleepwalkerVoicePipeline && typeof window.SleepwalkerVoicePipeline.EchoTracker === 'function') {
        if (!window.__SW_ECHO_TRACKER__) {
          window.__SW_ECHO_TRACKER__ = new window.SleepwalkerVoicePipeline.EchoTracker();
        }
        window.__SW_ECHO_TRACKER__.note(speakText);
      }

      const persona = this.getCurrentPersonaInfo();
      const utterance = new SpeechSynthesisUtterance(speakText);
      const effectiveRate = Math.max(0.65, Math.min(2.0, (this.rate || 1.0) * (persona.rateMul || 1.0)));
      const cadenceJitter = (this.sentences.length > 1) ? (((this.currentIndex % 3) - 1) * 0.018) : 0;
      utterance.rate = effectiveRate;
      utterance.pitch = Math.max(0.75, Math.min(1.35, (persona.pitch || 1.0) + cadenceJitter));
      utterance.lang = this.lang;
      this._currentUtterance = utterance;

      const voice = this.getBestVoice(this.lang);
      if (voice) {
        try {
          utterance.voice = voice;
          if (voice.lang) utterance.lang = voice.lang;
        } catch (_e) {}
      }

      let sawStart = false;
      let quietSinceMs = 0;
      const startedWaitingAt = Date.now();
      this._clearUtteranceWatchdog();

      const finishUtteranceCleanly = () => {
        this._clearUtteranceWatchdog();
        this._currentUtterance = null;
        this._retriedWithDefaultVoice = false;
        if (!this.isPlaying || this.isPaused) {
          this._stopSpeechEnvelope();
          return;
        }
        this.currentIndex++;
        this.playCurrentSentence();
      };

      this._utteranceWatchdogTimer = setInterval(() => {
        if (!this.isPlaying || this.isPaused) return;
        const synth = window.speechSynthesis;
        if (!synth) return;
        if (synth.speaking || synth.pending) {
          quietSinceMs = 0;
          return;
        }
        if (sawStart) {
          quietSinceMs += 350;
          if (quietSinceMs >= 900) finishUtteranceCleanly();
        } else if ((Date.now() - startedWaitingAt) >= 4000) {
          finishUtteranceCleanly();
        }
      }, 350);

      utterance.onstart = () => {
        sawStart = true;
        this._startSpeechEnvelope();
      };
      utterance.onboundary = (e) => {
        sawStart = true;
        this._sawBoundary = true;
        this.speechLevelMode = 'boundary';
        this._speechPulse = (e && e.name === 'sentence') ? 0.92 : 0.78;
      };
      utterance.onend = () => {
        finishUtteranceCleanly();
      };

      utterance.onerror = (e) => {
        this._clearUtteranceWatchdog();
        // If interrupted intentionally by stop() or pause(), ignore
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        console.warn('[Sleepwalker] Speech synthesis error:', e.error || e);

        // Retry once with the default system voice if specific voice failed
        if (!this._retriedWithDefaultVoice) {
          this._retriedWithDefaultVoice = true;
          console.log('[Sleepwalker] Retrying sentence with default voice...');

          const fallbackUtterance = new SpeechSynthesisUtterance(sentenceText);
          fallbackUtterance.rate = this.rate;
          fallbackUtterance.voice = this.voices.find(v => v.default) || null;
          this._currentUtterance = fallbackUtterance;

          fallbackUtterance.onend = () => {
            this._currentUtterance = null;
            this._retriedWithDefaultVoice = false;
            if (!this.isPlaying || this.isPaused) return;
            this.currentIndex++;
            this.playCurrentSentence();
          };

          fallbackUtterance.onerror = (retryErr) => {
            this._currentUtterance = null;
            this._retriedWithDefaultVoice = false;
            this.stop();
            const msg = `Speech synthesis failed (${retryErr.error || 'error'}). Please check your system audio/voices.`;
            if (this.onError) this.onError(msg);
          };

          window.speechSynthesis.speak(fallbackUtterance);
          return;
        }

        // Already retried with default voice; stop and notify clearly
        this._currentUtterance = null;
        this._retriedWithDefaultVoice = false;
        this.stop();
        const msg = `Speech synthesis failed (${e.error || 'error'}). Please check your system audio output.`;
        if (this.onError) this.onError(msg);
      };

      window.speechSynthesis.speak(utterance);
    }

    _clearUtteranceWatchdog() {
      if (this._utteranceWatchdogTimer) {
        clearInterval(this._utteranceWatchdogTimer);
        this._utteranceWatchdogTimer = null;
      }
    }

    /**
     * Visually highlight and smooth-scroll to element.
     */
    highlightElement(el) {
      this.clearHighlight();

      if (!el || typeof el.scrollIntoView !== 'function') return;

      el.classList.add('sleepwalker-active-sentence');
      this.activeHighlight = el;

      el.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest'
      });
    }

    /**
     * Remove current visual highlight.
     */
    clearHighlight() {
      if (this.activeHighlight) {
        this.activeHighlight.classList.remove('sleepwalker-active-sentence');
        this.activeHighlight = null;
      }
    }

    /**
     * Pause reading.
     */
    pause() {
      if (!this.isPlaying || this.isPaused) return;

      this.isPaused = true;
      this._stopSpeechEnvelope();
      if ('speechSynthesis' in window) {
        window.speechSynthesis.pause();
      }
      this.notifyStatus();
    }

    /**
     * Resume reading.
     */
    resume() {
      if (!this.isPlaying || !this.isPaused) return;

      this.isPaused = false;
      this._startSpeechEnvelope();
      this.notifyStatus();

      if ('speechSynthesis' in window) {
        window.speechSynthesis.resume();
        if (!window.speechSynthesis.speaking) {
          this.playCurrentSentence();
        }
      }
    }

    /**
     * Stop reading and reset highlights.
     */
    stop() {
      this._clearUtteranceWatchdog();
      this._currentUtterance = null;
      this.isPlaying = false;
      this.isPaused = false;
      this._retriedWithDefaultVoice = false;
      this._stopSpeechEnvelope();

      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }

      this.clearHighlight();
      this.notifyStatus();
    }

    _startSpeechEnvelope() {
      if (this._speechRaf) return;
      this._sawBoundary = false;
      this._speechPulse = 0.45;
      this.speechLevelMode = 'synthetic_speech';
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(() => fn(Date.now()), 50);
      const step = (ts) => {
        if (!this.isPlaying || this.isPaused) {
          this._stopSpeechEnvelope();
          return;
        }
        let level;
        if (this._sawBoundary) {
          this._speechPulse = Math.max(0.22, (this._speechPulse || 0.22) * 0.86);
          level = this._speechPulse;
        } else {
          const t = ((ts || Date.now()) / 1000) * Math.max(0.8, this.rate || 1);
          level = 0.32 + 0.48 * Math.abs(Math.sin(t * 7.4) * Math.cos(t * 3.1));
        }
        if (typeof this.onLevel === 'function') this.onLevel(level, this.speechLevelMode);
        this._speechRaf = raf(step);
      };
      this._speechRaf = raf(step);
    }

    _stopSpeechEnvelope() {
      this.speechLevelMode = 'idle';
      this._speechPulse = 0;
      if (this._speechRaf) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._speechRaf);
        else clearTimeout(this._speechRaf);
        this._speechRaf = 0;
      }
      if (typeof this.onLevel === 'function') this.onLevel(0, 'idle');
    }

    /**
     * Read the current queue again from the very beginning.
     */
    readAgain() {
      if (this.sentences.length === 0) {
        this.readPage();
        return;
      }
      this.stop();
      this.currentIndex = 0;
      this._retriedWithDefaultVoice = false;
      this.isPlaying = true;
      this.isPaused = false;
      this.notifyStatus();
      this.playCurrentSentence();
    }

    /**
     * Called when all sentences have finished reading.
     */
    finishReading() {
      const finishedMode = this.lastMode;
      this.stop();
      if (this.onFinished) {
        this.onFinished(finishedMode);
      }
    }

    /**
     * Update reading speed rate (0.8x - 1.5x).
     */
    setRate(newRate) {
      this.rate = Math.max(0.7, Math.min(2.0, parseFloat(newRate) || 1.0));
    }

    /**
     * Set language ('en-IN' or 'hi-IN').
     */
    setLang(newLang) {
      this.lang = newLang;
    }

    /**
     * Notify listeners of current playback state.
     */
    notifyStatus() {
      if (this.onStatusChange) {
        this.onStatusChange({
          isPlaying: this.isPlaying,
          isPaused: this.isPaused,
          currentIndex: this.currentIndex,
          total: this.sentences.length,
          lastMode: this.lastMode
        });
      }
    }
  }

  window.SleepwalkerReader = SleepwalkerReader;
})();
