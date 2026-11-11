/**
 * Sleepwalker - explain.js
 * CodeQuest National Tech Hackathon 2026
 *
 * Feature B: "Explain This Page" Engine
 *
 * Responsibilities:
 * 1. Safe text extraction: Extracts main visible text from <main>, <article>, [role=main] or body.
 *    STRICT PRIVACY: Excludes nav, footer, headers, scripts, styles, iframes.
 *    CRITICAL PRIVACY: Excludes ALL inputs, selects, textareas, and passwords. Form values are NEVER read.
 * 2. URL cleaning: Strips query strings from URLs for cache keys.
 * 3. Offline Extractive Fallback: Generates a high-quality "basic summary" with zero AI dependencies.
 * 4. Hallucination Validator: Validates model responses. Numbers, amounts, and dates MUST appear in
 *    the source page text (normalizing Devanagari numerals). Hallucinated sentences are dropped.
 * 5. Timing honesty: Shows "Still working, tap Stop to cancel" after 15 seconds.
 * 6. Coordinates with widget.pill, widget.glow, and widget.reader.
 */

(function () {
  'use strict';

  if (window.SleepwalkerExplainer) return;

  class SleepwalkerExplainer {
    constructor(widget) {
      this.widget = widget;
      this.activeAbortController = null;
      this.waitingTimer = null;
    }

    /**
     * Get clean URL without query string or hash for caching.
     */
    getCleanUrl() {
      try {
        const u = new URL(window.location.href);
        return `${u.origin}${u.pathname}`;
      } catch (e) {
        return window.location.origin + window.location.pathname;
      }
    }

    /**
     * Extract main page readable text.
     * Strictly ignores nav, footer, forms, inputs, and passwords.
     * @param {string} [sectionQuery] - Optional section to focus on.
     * @returns {string} Clean visible text up to ~6,000 characters.
     */
    extractPageText(sectionQuery = null) {
      // 1. If section query specified, look for section heading first
      if (sectionQuery && this.widget && this.widget.outline) {
        const heading = this.widget.outline.fuzzyFindHeading(sectionQuery);
        if (heading && heading.sectionElements && heading.sectionElements.length > 0) {
          const sectionText = heading.sectionElements
            .map(el => this._extractCleanTextFromNode(el))
            .filter(Boolean)
            .join(' ');
          if (sectionText.trim().length > 60) {
            return this._sanitizeAndTruncate(sectionText, 6000);
          }
        }
      }

      // 2. Main content root selection
      const candidates = ['main', 'article', '[role="main"]', '#main-content', '#content', '.post-content'];
      let root = null;
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && this._isVisible(el) && el.textContent.trim().length > 80) {
          root = el;
          break;
        }
      }
      if (!root) {
        root = document.body;
      }

      const text = this._extractCleanTextFromNode(root);
      return this._sanitizeAndTruncate(text, 6000);
    }

    /**
     * Recursive text extraction excluding form inputs, passwords, nav, footer, scripts.
     */
    _extractCleanTextFromNode(node) {
      if (!node) return '';

      // Ignore sleepwalker's own host element
      if (node.id === 'sleepwalker-host' || (node.classList && node.classList.contains('sleepwalker-exclude'))) {
        return '';
      }

      // Exclude non-content and layout tags
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (['nav', 'footer', 'header', 'script', 'style', 'noscript', 'svg', 'iframe'].includes(tag)) {
        return '';
      }

      // STRICT PRIVACY RULE: Exclude all form inputs, textareas, selects, and passwords!
      if (['input', 'textarea', 'select', 'button'].includes(tag)) {
        return '';
      }

      // Skip hidden DOM elements
      if (node.nodeType === Node.ELEMENT_NODE && !this._isVisible(node)) {
        return '';
      }

      // Handle table elements
      if (tag === 'table') {
        const rows = Array.from(node.querySelectorAll('tr'));
        return rows.map(r => {
          const cells = Array.from(r.querySelectorAll('th, td')).map(c => c.textContent.trim());
          return cells.join(': ');
        }).join('. ') + '. ';
      }

      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/\s+/g, ' ');
      }

      let result = '';
      for (let child = node.firstChild; child; child = child.nextSibling) {
        result += ' ' + this._extractCleanTextFromNode(child);
      }
      return result;
    }

    _isVisible(elem) {
      if (!(elem instanceof Element)) return true;
      const s = window.getComputedStyle(elem);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }

    _sanitizeAndTruncate(text, maxChars = 6000) {
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned.length <= maxChars) return cleaned;
      return cleaned.substring(0, maxChars) + '...';
    }

    /**
     * Normalize Devanagari numerals to standard ASCII digits.
     */
    normalizeNumerals(str) {
      if (!str) return '';
      const devanagariDigits = {
        '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
        '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
      };
      return str.replace(/[०-९]/g, d => devanagariDigits[d] || d);
    }

    /**
     * Extract all numbers, monetary figures, and year/day numbers from text.
     */
    extractNumbersAndDates(text) {
      const norm = this.normalizeNumerals(text.toLowerCase());
      const matches = norm.match(/\b\d+(?:[,\.]\d+)?\b/g) || [];
      return matches.map(n => n.replace(/,/g, ''));
    }

    /**
     * Hallucination Validator: Ensures numbers/dates in the answer appear in source text.
     * Drops any sentence containing hallucinated numbers.
     * @param {string} answer - LLM output.
     * @param {string} sourceText - Original page text.
     * @returns {string|null} Validated answer text, or null if nothing survived.
     */
    validateAnswer(answer, sourceText) {
      if (!answer || !answer.trim()) return null;

      const sourceNumbers = new Set(this.extractNumbersAndDates(sourceText));
      const sentences = answer.match(/[^.!?।\n]+[.!?।\n]+|[^.!?।\n]+$/g) || [answer];
      const validSentences = [];

      for (const rawSentence of sentences) {
        const sentence = rawSentence.trim();
        if (sentence.length < 3) continue;

        const sentenceNumbers = this.extractNumbersAndDates(sentence);
        let hasHallucination = false;

        for (const num of sentenceNumbers) {
          // If a number in the answer is not in the source text, flag as hallucination
          if (!sourceNumbers.has(num)) {
            console.warn(`[Sleepwalker Validator] Dropped hallucinated sentence (number "${num}" not in page): "${sentence}"`);
            hasHallucination = true;
            break;
          }
        }

        if (!hasHallucination) {
          validSentences.push(sentence);
        }
      }

      if (validSentences.length === 0) {
        console.warn('[Sleepwalker Validator] All sentences failed number validation; falling back to basic summary.');
        return null;
      }

      return validSentences.join(' ');
    }

    /**
     * Step 6: Offline Fallback (No AI)
     * Builds an extractive summary using title, headings, and regex patterns for fees, dates, and docs.
     */
    generateBasicSummary(pageText, sectionQuery = null, lang = 'en-IN') {
      const isHindi = lang === 'hi-IN';
      const title = document.title ? document.title.split(/[-|•]/)[0].trim() : 'This page';

      // 1. Gather headings
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .filter(h => this._isVisible(h) && h.textContent.trim().length > 2)
        .map(h => h.textContent.trim().replace(/\s+/g, ' '));

      // 2. Detect fees
      const feeMatch = pageText.match(/(?:fee|fees|amount|शुल्क|फीस)[:\s]+[₹$€£\d,]+(?:\s*(?:INR|USD|rupees|रुपये))?/i) ||
                       pageText.match(/(?:₹|Rs\.?|\$)\s*\d+[\d,]*/i);
      const feeStr = feeMatch ? feeMatch[0].trim() : null;

      // 3. Detect key dates
      const dateMatch = pageText.match(/(?:deadline|last date|opening date|milestone|अंतिम तिथि|तारीख)[:\s]+[A-Za-z0-9,\s\/-]{5,30}/i) ||
                        pageText.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?\b/i);
      const dateStr = dateMatch ? dateMatch[0].trim() : null;

      // 4. Detect documents
      const hasDocs = /domicile|certificate|marks|passport|identity|दस्तावेज|प्रमाण पत्र/i.test(pageText);

      // Construct concise summary (< 120 words)
      if (isHindi) {
        let summary = `यह पेज "${title}" है।`;
        if (headings.length > 0) {
          summary += ` इसमें मुख्य भाग शामिल हैं: ${headings.slice(0, 3).join(', ')}।`;
        }
        if (feeStr) {
          summary += ` शुल्क विवरण: ${feeStr}।`;
        }
        if (dateStr) {
          summary += ` मुख्य तारीख: ${dateStr}।`;
        }
        if (hasDocs) {
          summary += ` आवश्यक दस्तावेजों में निवास एवं अंक पत्र शामिल हैं।`;
        }
        summary += ` आप आगे की जानकारी के लिए "पेज पढ़ो" या आउटलाइन का उपयोग कर सकते हैं।`;
        return summary;
      } else {
        let summary = `This page is "${title}".`;
        if (headings.length > 0) {
          summary += ` Key sections include: ${headings.slice(0, 3).join(', ')}.`;
        }
        if (feeStr) {
          summary += ` Fee information: ${feeStr}.`;
        }
        if (dateStr) {
          summary += ` Key deadline: ${dateStr}.`;
        }
        if (hasDocs) {
          summary += ` Required documents include certificates and ID proofs.`;
        }
        summary += ` You can navigate sections using Outline or say "Read this page" to hear everything.`;
        return summary;
      }
    }

    /**
     * Primary Explain Pipeline:
     * 1. Extract clean page text (no form values).
     * 2. Show preparing glow and pill state.
     * 3. Ask background LLM cascade (cache -> proxy -> Ollama -> offline).
     * 4. Validate answer for hallucinations.
     * 5. Read aloud sentence-by-sentence and display in UI with source badge.
     */
    async runExplainPipeline(sectionQuery = null) {
      const lang = (this.widget && this.widget.lang) || 'en-IN';
      const isHindi = lang === 'hi-IN';

      // Abort any ongoing request
      this.abort();
      this.activeAbortController = new AbortController();

      // 1. Visual states: PREPARING
      const statusPrompt = sectionQuery
        ? (isHindi ? `"${sectionQuery}" सेक्शन समझाया जा रहा है...` : `Analyzing "${sectionQuery}" section...`)
        : (isHindi ? 'पेज को सरल भाषा में समझा रहे हैं...' : 'Analyzing page to explain...');

      if (this.widget.pill) {
        this.widget.pill.setPreparing(statusPrompt);
      }
      if (this.widget.glow) {
        this.widget.glow.setPreparing();
      }
      this.widget.setAssistantReply(`${statusPrompt}\n(Checking AI models & cache...)`);

      // 2. Extract page text
      const pageText = this.extractPageText(sectionQuery);
      const cleanUrl = this.getCleanUrl();

      // 3. 15-Second Honesty Timer
      this.waitingTimer = setTimeout(() => {
        if (this.widget.pill && this.widget.pill.state === 'preparing') {
          const waitMsg = isHindi ? 'प्रोसेसिंग जारी है, रोकने के लिए Stop दबाएं...' : 'Still working, tap Stop to cancel...';
          this.widget.pill.setStatus(waitMsg);
          this.widget.setAssistantReply(waitMsg);
        }
      }, 15000);

      let finalAnswer = null;
      let sourceLabel = 'basic summary';

      try {
        // Send request to background service worker LLM cascade
        const response = await this._sendToBackgroundCascade({
          urlClean: cleanUrl,
          section: sectionQuery || 'all',
          lang,
          pageText
        });

        if (response && response.status === 'ok' && response.answer) {
          // 4. Validate answer against source text
          const validated = this.validateAnswer(response.answer, pageText);
          if (validated) {
            finalAnswer = validated;
            sourceLabel = response.source || 'cloud';
          }
        }
      } catch (err) {
        console.warn('[Sleepwalker Explainer] Cascade request error:', err.message);
      }

      // If no valid LLM answer survived, use Offline Extractive Fallback!
      if (!finalAnswer) {
        finalAnswer = this.generateBasicSummary(pageText, sectionQuery, lang);
        sourceLabel = 'basic summary';
      }

      // Clear 15-second waiting timer
      if (this.waitingTimer) {
        clearTimeout(this.waitingTimer);
        this.waitingTimer = null;
      }

      // If user aborted during generation, stop here
      if (!this.activeAbortController) return;

      // 5. Trigger READY bloom (~600ms) on prism glow
      if (this.widget.glow) {
        this.widget.glow.setReady();
      }

      // Format source label warning for Hindi local models if applicable
      let displayBadge = `[Source: ${sourceLabel}]`;
      if (isHindi && sourceLabel === 'local') {
        displayBadge += ' ⚠️ Local Hindi accuracy may be lower.';
      }

      // 6. Transition to SPEAKING state
      setTimeout(() => {
        const fullAnnouncement = `${displayBadge}\n${finalAnswer}`;
        this.widget.setAssistantReply(fullAnnouncement);

        if (this.widget.pill) {
          const shortPreview = finalAnswer.length > 50 ? finalAnswer.substring(0, 48) + '...' : finalAnswer;
          this.widget.pill.setStatus(`[${sourceLabel}] "${shortPreview}"`);
          this.widget.pill.setSpeaking(`[${sourceLabel}] "${shortPreview}"`);
        }

        if (this.widget.glow) {
          this.widget.glow.setSpeaking();
        }

        // 7. Speak sentence-by-sentence with reader
        if (this.widget.reader) {
          this.widget.reader.readText(finalAnswer);
        }
      }, 600);
    }

    /**
     * Send message to background service worker cascade.
     */
    _sendToBackgroundCascade(payload) {
      return new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve({ status: 'fallback', source: 'basic summary' });
          return;
        }

        chrome.runtime.sendMessage(
          {
            type: 'SLEEPWALKER_EXPLAIN_REQUEST',
            payload
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn('[Sleepwalker] Background communication error:', chrome.runtime.lastError.message);
              resolve({ status: 'fallback', source: 'basic summary' });
            } else {
              resolve(response || { status: 'fallback', source: 'basic summary' });
            }
          }
        );
      });
    }

    /**
     * Abort active explanation request and clear timers.
     */
    abort() {
      if (this.waitingTimer) {
        clearTimeout(this.waitingTimer);
        this.waitingTimer = null;
      }
      if (this.activeAbortController) {
        this.activeAbortController.abort();
        this.activeAbortController = null;
      }
    }
  }

  window.SleepwalkerExplainer = SleepwalkerExplainer;
})();
