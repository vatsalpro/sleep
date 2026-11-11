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

  class SleepwalkerReader {
    constructor() {
      this.sentences = [];       // Array of { text, element }
      this.currentIndex = 0;     // Current sentence being read
      this.isPlaying = false;    // Reading active
      this.isPaused = false;     // Reading temporarily paused
      this.rate = 1.0;           // Speech speed (0.8x to 1.5x)
      this.lang = 'en-IN';       // 'en-IN' or 'hi-IN'
      this.activeHighlight = null; // Currently highlighted element
      this._retriedWithDefaultVoice = false; // Flag for fallback attempt

      // Callbacks for UI updates
      this.onSentenceChange = null; // ({ index, total, text }) => {}
      this.onStatusChange = null;   // ({ isPlaying, isPaused }) => {}
      this.onFinished = null;       // () => {}
      this.onError = null;          // (errorMessage) => {}

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

    /**
     * Pick best voice matching selected language (en-IN or hi-IN).
     */
    getBestVoice(lang) {
      if (!this.voices || this.voices.length === 0) {
        this.loadVoices();
      }

      const normalizedLang = (lang || 'en-IN').toLowerCase();
      const langPrefix = normalizedLang.split('-')[0]; // 'en' or 'hi'

      // 1. Exact match (e.g. en-IN or hi-IN)
      let match = this.voices.find(v => v.lang && v.lang.toLowerCase() === normalizedLang);
      if (match) return match;

      // 2. Prefix match (e.g. any Hindi voice, or any English voice)
      match = this.voices.find(v => v.lang && v.lang.toLowerCase().startsWith(langPrefix));
      if (match) return match;

      // 3. Fallback to default or first available voice
      return this.voices.find(v => v.default) || this.voices[0] || null;
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
        '.main-content',
        '.entry-content',
        '.post-content'
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
     */
    readText(text) {
      if (!text || !text.trim()) return false;
      this.stop();
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

    /**
     * Read a specific subset of DOM elements (used by Outline: "read the <name> section").
     * @param {HTMLElement[]} elements - Array of section elements to read.
     * @param {string} sectionTitle - Name of the section.
     */
    readElements(elements, sectionTitle = '') {
      this.stop();
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

      const utterance = new SpeechSynthesisUtterance(sentenceText);
      utterance.rate = this.rate;
      utterance.lang = this.lang;

      const voice = this.getBestVoice(this.lang);
      if (voice) {
        utterance.voice = voice;
      }

      utterance.onend = () => {
        this._retriedWithDefaultVoice = false;
        if (!this.isPlaying || this.isPaused) return;
        this.currentIndex++;
        this.playCurrentSentence();
      };

      utterance.onerror = (e) => {
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

          fallbackUtterance.onend = () => {
            this._retriedWithDefaultVoice = false;
            if (!this.isPlaying || this.isPaused) return;
            this.currentIndex++;
            this.playCurrentSentence();
          };

          fallbackUtterance.onerror = (retryErr) => {
            this._retriedWithDefaultVoice = false;
            this.stop();
            const msg = `Speech synthesis failed (${retryErr.error || 'error'}). Please check your system audio/voices.`;
            if (this.onError) this.onError(msg);
          };

          window.speechSynthesis.speak(fallbackUtterance);
          return;
        }

        // Already retried with default voice; stop and notify clearly
        this._retriedWithDefaultVoice = false;
        this.stop();
        const msg = `Speech synthesis failed (${e.error || 'error'}). Please check your system audio output.`;
        if (this.onError) this.onError(msg);
      };

      window.speechSynthesis.speak(utterance);
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
      this.isPlaying = false;
      this.isPaused = false;
      this._retriedWithDefaultVoice = false;

      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }

      this.clearHighlight();
      this.notifyStatus();
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
      this.stop();
      if (this.onFinished) {
        this.onFinished();
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
          total: this.sentences.length
        });
      }
    }
  }

  window.SleepwalkerReader = SleepwalkerReader;
})();
