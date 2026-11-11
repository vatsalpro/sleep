/**
 * Sleepwalker - outline.js
 *
 * Responsibilities:
 * 1. Extract headings and sections (H1-H4) from the webpage.
 * 2. Collect section boundary elements for targeted section reading.
 * 3. Provide smooth-scrolling to any heading on the page.
 * 4. Fuzzy match voice/text queries (e.g. "fees" -> "Application Fee Structure").
 */

(function () {
  'use strict';

  if (window.SleepwalkerOutline) return;

  class SleepwalkerOutline {
    constructor() {
      this.items = []; // Array of outline items
      this.injectFlashStyles();
    }

    /**
     * Inject style for flash-highlighting a heading when navigated to.
     */
    injectFlashStyles() {
      if (document.getElementById('sleepwalker-outline-styles')) return;

      const style = document.createElement('style');
      style.id = 'sleepwalker-outline-styles';
      style.textContent = `
        @keyframes sleepwalker-flash {
          0% { outline: 4px solid #00E5FF; background-color: rgba(0, 229, 255, 0.35); }
          50% { outline: 4px solid #FFD600; background-color: rgba(255, 214, 0, 0.4); }
          100% { outline: 3px solid transparent; background-color: transparent; }
        }
        .sleepwalker-target-flash {
          animation: sleepwalker-flash 1.8s ease-out forwards !important;
          border-radius: 4px !important;
        }
      `;
      document.head.appendChild(style);
    }

    /**
     * Determine heading level number (1 for H1, 2 for H2, etc.).
     */
    getHeadingLevel(el) {
      const match = el.tagName.match(/^H([1-6])$/i);
      if (match) return parseInt(match[1], 10);
      const ariaLevel = el.getAttribute('aria-level');
      if (ariaLevel) return parseInt(ariaLevel, 10);
      return 2;
    }

    /**
     * Collect all DOM elements belonging to this section until the next heading of equal or higher level.
     */
    collectSectionElements(headingEl, level) {
      const elements = [headingEl];
      let sibling = headingEl.nextElementSibling;
      const parent = headingEl.parentElement;

      while (sibling) {
        // If we hit another heading of equal or higher level (smaller number), stop
        if (/^H[1-6]$/i.test(sibling.tagName) || sibling.getAttribute('role') === 'heading') {
          const siblingLevel = this.getHeadingLevel(sibling);
          if (siblingLevel <= level) {
            break;
          }
        }
        elements.push(sibling);
        sibling = sibling.nextElementSibling;
      }

      // If heading is wrapped directly inside a section or article tag
      if (elements.length === 1 && parent && (parent.tagName === 'SECTION' || parent.tagName === 'ARTICLE')) {
        return Array.from(parent.children);
      }

      return elements;
    }

    /**
     * Extract all visible headings and their sections from the page.
     */
    extractOutline() {
      this.items = [];

      // Primary container
      const container = document.querySelector('main, article, [role="main"]') || document.body;

      const ignoreSelector = `
        nav, footer, aside, #sleepwalker-host, .sleepwalker-ignore,
        [role="navigation"], [role="banner"], [role="contentinfo"]
      `;

      const headingElements = container.querySelectorAll('h1, h2, h3, h4, [role="heading"]');

      headingElements.forEach((el, index) => {
        // Skip ignored / hidden containers
        if (el.closest(ignoreSelector)) return;
        if (el.offsetParent === null) return;

        const text = el.textContent.replace(/\s+/g, ' ').trim();
        if (!text || text.length < 2) return;

        const level = this.getHeadingLevel(el);
        const sectionElements = this.collectSectionElements(el, level);

        this.items.push({
          id: el.id || `sleepwalker-heading-${index}`,
          text: text,
          level: level,
          element: el,
          sectionElements: sectionElements
        });
      });

      return this.items;
    }

    /**
     * Scroll smoothly to heading element and trigger visual flash.
     */
    scrollToHeading(item) {
      if (!item || !item.element) return;

      item.element.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });

      item.element.classList.remove('sleepwalker-target-flash');
      // Trigger reflow to restart animation
      void item.element.offsetWidth;
      item.element.classList.add('sleepwalker-target-flash');
    }

    /**
     * Normalize a text string for fuzzy comparison.
     */
    normalize(str) {
      return (str || '')
        .toLowerCase()
        .replace(/['’"“”]/g, '')
        .replace(/[^\w\s\u0900-\u097F]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /**
     * Remove conversational stop words to isolate the core section keyword.
     */
    stripStopWords(str) {
      const stopWords = new Set([
        'the', 'section', 'heading', 'about', 'read', 'please', 'to', 'go', 'open',
        'tell', 'me', 'what', 'is', 'are', 'in', 'and', 'for', 'of', 'on',
        // Common Hindi stop words
        'ka', 'ki', 'ke', 'wala', 'wali', 'wale', 'padho', 'batao', 'dikhaye'
      ]);

      const words = this.normalize(str).split(' ');
      return words.filter(w => !stopWords.has(w) && w.length > 1).join(' ');
    }

    /**
     * Fuzzy search headings for a target query.
     * Example: "fees" matches "Application Fee Structure".
     * @param {string} query - Spoken or typed phrase.
     * @returns {Object|null} Best matching outline item or null.
     */
    fuzzyFindHeading(query) {
      if (!query || this.items.length === 0) return null;

      const cleanQuery = this.stripStopWords(query) || this.normalize(query);
      if (!cleanQuery) return null;

      const queryTokens = cleanQuery.split(' ').filter(Boolean);
      let bestMatch = null;
      let highestScore = -1;

      for (const item of this.items) {
        const itemClean = this.normalize(item.text);
        const itemTokens = itemClean.split(' ').filter(Boolean);

        let score = 0;

        // 1. Exact match
        if (itemClean === cleanQuery) {
          score = 100;
        }
        // 2. Query is full substring of heading (e.g. "fee structure" in "Application Fee Structure")
        else if (itemClean.includes(cleanQuery)) {
          score = 85 + (cleanQuery.length / itemClean.length) * 10;
        }
        // 3. Heading is substring of query
        else if (cleanQuery.includes(itemClean)) {
          score = 80;
        }
        else {
          // 4. Token-level overlap and stemming (e.g. "fees" vs "fee")
          let matchedTokens = 0;

          for (const qToken of queryTokens) {
            for (const iToken of itemTokens) {
              if (qToken === iToken) {
                matchedTokens += 1;
              } else if (
                // Singular / plural or prefix matches (e.g. "fee" and "fees")
                (qToken.startsWith(iToken) || iToken.startsWith(qToken)) &&
                Math.min(qToken.length, iToken.length) >= 3
              ) {
                matchedTokens += 0.85;
              }
            }
          }

          if (matchedTokens > 0) {
            score = 50 + (matchedTokens / Math.max(queryTokens.length, 1)) * 30;
          }
        }

        if (score > highestScore && score >= 40) {
          highestScore = score;
          bestMatch = item;
        }
      }

      return bestMatch;
    }
  }

  // Export to global namespace
  window.SleepwalkerOutline = SleepwalkerOutline;
})();
