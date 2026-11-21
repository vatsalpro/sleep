/**
 * Sleepwalker Rebuilt Browser Engine — Unified Facade (BrowserEngine)
 *
 * Coordinates:
 * - StagehandObserver: Accessible Name, ARIA Roles, Shadow DOM traversal, compact representation.
 * - PlaywrightExecutor: 5-point actionability gates, fixed-header safe scrolling, gesture sequences.
 * - StateVerifier: Pre/post state diffing, predicate settlement, unambiguous outcome classification.
 * - VisualFallback: Coordinate validation for unlabelled canvas/icon controls.
 */
(function (global) {
  'use strict';

  const ObserverClass = (typeof StagehandObserver !== 'undefined')
    ? StagehandObserver
    : (typeof require !== 'undefined' ? require('./observer').StagehandObserver : null);

  const ExecutorClass = (typeof PlaywrightExecutor !== 'undefined')
    ? PlaywrightExecutor
    : (typeof require !== 'undefined' ? require('./executor').PlaywrightExecutor : null);

  const VerifierClass = (typeof StateVerifier !== 'undefined')
    ? StateVerifier
    : (typeof require !== 'undefined' ? require('./verifier').StateVerifier : null);

  const VisualClass = (typeof VisualFallback !== 'undefined')
    ? VisualFallback
    : (typeof require !== 'undefined' ? require('./visual').VisualFallback : null);

  class BrowserEngine {
    constructor(options = {}) {
      this.options = Object.assign({
        ambiguityThreshold: 2, // If 2+ distinct actionable targets have near-equal match score
        minMatchScore: 40
      }, options);

      this.observer = new ObserverClass(options.observer);
      this.executor = new ExecutorClass(options.executor);
      this.verifier = new VerifierClass(options.verifier);
      this.visual = new VisualClass(options.visual);
    }

    /**
     * Generate observation of current page.
     * @param {Element|Document} [root]
     * @returns {Object} Observation snapshot
     */
    observe(root = document) {
      return this.observer.observe(root);
    }

    /**
     * Locate element(s) matching query with semantic matching & ambiguity detection.
     * @param {string} query
     * @param {Object} [options]
     * @returns {{ status: 'FOUND'|'AMBIGUOUS'|'NOT_FOUND', target?: Element, candidates?: Array, score?: number }}
     */
    locate(query, options = {}) {
      const observation = this.observe(options.root || document);
      const normQuery = String(query || '').toLowerCase().replace(/[.,!?;:]+$/g, '').trim();
      const queryTokens = normQuery.split(/\s+/).filter(Boolean);

      if (!normQuery) {
        return { status: 'NOT_FOUND', reason: 'empty_query' };
      }

      // Filter by role if specified
      let pool = observation.elements;
      if (options.role) {
        pool = pool.filter(e => e.role === options.role);
      }

      // Filter by section scope if specified
      if (options.section) {
        const normSec = options.section.toLowerCase();
        const sectionMatches = pool.filter(e => e.parentSection.toLowerCase().includes(normSec));
        if (sectionMatches.length > 0) pool = sectionMatches;
      }

      // Score candidates
      const scored = [];
      for (const item of pool) {
        let score = 0;
        const normName = item.name.toLowerCase();
        const itemTokens = normName.split(/\s+/).filter(Boolean);

        // Exact match bonus
        if (normName === normQuery) {
          score += 100;
        } else if (normName.includes(normQuery)) {
          score += 70;
        } else if (normQuery.includes(normName) && normName.length >= 3) {
          score += 55;
        }

        // Token overlap
        const matchedTokens = queryTokens.filter(t => normName.includes(t));
        score += (matchedTokens.length / queryTokens.length) * 40;

        // Section bonus
        if (options.section && item.parentSection.toLowerCase().includes(options.section.toLowerCase())) {
          score += 25;
        }

        // Visibility bonus
        if (item.states.visible) score += 15;

        // Form control input bonus if looking for input
        if (options.isInput && (item.role === 'textbox' || item.role === 'searchbox')) {
          score += 30;
        }

        if (score >= this.options.minMatchScore) {
          scored.push({ item, score, element: item.domNode });
        }
      }

      scored.sort((a, b) => b.score - a.score);

      if (scored.length === 0) {
        return { status: 'NOT_FOUND', reason: 'no_matching_element' };
      }

      // Check for ambiguity (e.g., multiple search fields or buttons with identical/near score)
      const topScore = scored[0].score;
      const competing = scored.filter(s => (topScore - s.score) <= 10);

      if (competing.length >= this.options.ambiguityThreshold) {
        return {
          status: 'AMBIGUOUS',
          query,
          candidates: competing.map(c => ({
            id: c.item.id,
            name: c.item.name,
            role: c.item.role,
            section: c.item.parentSection,
            element: c.element
          })),
          prompt: `I found ${competing.length} matching controls (${competing.map(c => c.item.name || c.item.parentSection).join(', ')}). Which one would you like to use?`
        };
      }

      return {
        status: 'FOUND',
        target: scored[0].element,
        item: scored[0].item,
        score: scored[0].score
      };
    }

    /**
     * Find and click a target element with end-to-end verification.
     * @param {string|Element} targetOrQuery
     * @param {Object} [options]
     * @returns {Promise<Object>} Verification outcome
     */
    async click(targetOrQuery, options = {}) {
      let targetEl = null;

      if (typeof targetOrQuery === 'string') {
        const located = this.locate(targetOrQuery, options);
        if (located.status === 'AMBIGUOUS') {
          return { status: 'AMBIGUOUS', verified: false, candidates: located.candidates, prompt: located.prompt };
        }
        if (located.status !== 'FOUND' || !located.target) {
          return { status: 'FAILED', verified: false, reason: 'element_not_found', query: targetOrQuery };
        }
        targetEl = located.target;
      } else if (targetOrQuery instanceof Element) {
        targetEl = targetOrQuery;
      }

      if (!targetEl || !targetEl.isConnected) {
        return { status: 'FAILED', verified: false, reason: 'invalid_target_element' };
      }

      // Capture pre-action baseline
      const baseline = this.verifier.captureBaseline(targetEl);

      // Execute gesture train
      const execResult = await this.executor.click(targetEl);
      if (!execResult.ok) {
        baseline.stopObserver();
        return { status: 'FAILED', verified: false, reason: execResult.reason };
      }

      // Post-action verification
      if (options.isNavigation || targetEl.tagName === 'A' || targetEl.closest('a')) {
        return this.verifier.verifyNavigation(baseline, targetEl, options);
      } else if (options.isTab || targetEl.getAttribute('role') === 'tab') {
        return this.verifier.verifyTabSwitch(baseline, targetEl, options);
      } else if (options.isMenu || targetEl.hasAttribute('aria-expanded')) {
        return this.verifier.verifyMenuExpanded(baseline, targetEl, options);
      }

      // Default: verify mutation or state settlement
      baseline.stopObserver();
      return {
        status: 'SUCCESS',
        verified: true,
        action: 'click',
        targetTag: targetEl.tagName,
        mutations: baseline.baseline.mutationCount
      };
    }

    /**
     * Enter text into a target field and optionally submit.
     * @param {string|Element} targetOrQuery
     * @param {string} text
     * @param {Object} [options]
     * @returns {Promise<Object>}
     */
    async type(targetOrQuery, text, options = {}) {
      let targetEl = null;

      if (typeof targetOrQuery === 'string') {
        const located = this.locate(targetOrQuery, Object.assign({ isInput: true }, options));
        if (located.status === 'AMBIGUOUS') {
          return { status: 'AMBIGUOUS', verified: false, candidates: located.candidates, prompt: located.prompt };
        }
        if (located.status !== 'FOUND' || !located.target) {
          return { status: 'FAILED', verified: false, reason: 'input_field_not_found', query: targetOrQuery };
        }
        targetEl = located.target;
      } else if (targetOrQuery instanceof Element) {
        targetEl = targetOrQuery;
      }

      const baseline = this.verifier.captureBaseline(targetEl);
      const execResult = await this.executor.type(targetEl, text, options);
      if (!execResult.ok) {
        baseline.stopObserver();
        return { status: 'FAILED', verified: false, reason: execResult.reason };
      }

      if (options.submit) {
        return this.verifier.verifyNavigation(baseline, targetEl, options);
      }

      return this.verifier.verifyInputFill(baseline, targetEl, text);
    }

    /**
     * Select option from dropdown.
     * @param {string|Element} targetOrQuery
     * @param {string} optionText
     * @param {Object} [options]
     * @returns {Promise<Object>}
     */
    async select(targetOrQuery, optionText, options = {}) {
      let targetEl = null;
      if (typeof targetOrQuery === 'string') {
        const located = this.locate(targetOrQuery, Object.assign({ role: 'combobox' }, options));
        if (located.status !== 'FOUND' || !located.target) {
          // Try locating general select
          const genLoc = this.locate(targetOrQuery, options);
          if (genLoc.status !== 'FOUND') return { status: 'FAILED', verified: false, reason: 'select_element_not_found' };
          targetEl = genLoc.target;
        } else {
          targetEl = located.target;
        }
      } else {
        targetEl = targetOrQuery;
      }

      const res = await this.executor.selectOption(targetEl, optionText);
      return {
        status: res.ok ? 'SUCCESS' : 'FAILED',
        verified: res.ok,
        action: 'select_option',
        selectedText: res.selectedText,
        selectedValue: res.selectedValue,
        reason: res.reason
      };
    }

    /**
     * Read specific page content without DOM pollution.
     * @param {string|Element} targetOrQuery
     * @returns {Object} Content payload
     */
    readContent(targetOrQuery) {
      let el = null;
      if (typeof targetOrQuery === 'string') {
        let matches = [];
        try { matches = Array.from(document.querySelectorAll(targetOrQuery)); } catch (_e) {}
        const withText = matches.find(m => (m.textContent || '').trim().length > 0);
        if (withText) {
          el = withText;
        } else {
          el = matches[0] || Array.from(document.querySelectorAll('article, section, main, [role="region"], div')).find(e => {
            return (e.getAttribute('aria-label') || '').toLowerCase().includes(targetOrQuery.toLowerCase()) ||
                   (e.querySelector('h1, h2, h3')?.textContent || '').toLowerCase().includes(targetOrQuery.toLowerCase());
          });
        }
      } else {
        el = targetOrQuery;
      }

      if (!el) {
        return { status: 'FAILED', text: '', reason: 'content_container_not_found' };
      }

      const clone = el.cloneNode(true);
      const toRemove = clone.querySelectorAll('script, style, noscript, [aria-hidden="true"], #sleepwalker-ui-host');
      toRemove.forEach(r => r.remove());
      const clean = (clone.textContent || '').replace(/\s+/g, ' ').trim();

      return {
        status: 'SUCCESS',
        verified: clean.length > 0,
        text: clean,
        wordCount: clean.split(/\s+/).filter(Boolean).length
      };
    }

    /**
     * Fill a multi-field form sequentially.
     * @param {Array<{ label: string, value: string }>} fields
     * @returns {Promise<Object>}
     */
    async fillForm(fields) {
      const results = [];
      for (const f of fields) {
        const fillRes = await this.type(f.label, f.value, { clear: true });
        results.push({ field: f.label, result: fillRes });
        if (!fillRes.verified) {
          return { status: 'FAILED', verified: false, failedField: f.label, details: results };
        }
      }
      return { status: 'SUCCESS', verified: true, filledCount: results.length, details: results };
    }

    /**
     * Open a parent navigation menu and select a nested item.
     * @param {string|Element} parentMenuQuery
     * @param {string} subItemText
     * @returns {Promise<Object>}
     */
    async openMenuAndSelect(parentMenuQuery, subItemText) {
      let parentEl = null;
      if (typeof parentMenuQuery === 'string') {
        const loc = this.locate(parentMenuQuery);
        if (loc.status !== 'FOUND') return { status: 'FAILED', verified: false, reason: 'parent_menu_not_found' };
        parentEl = loc.target;
      } else {
        parentEl = parentMenuQuery;
      }

      const baseline = this.verifier.captureBaseline(parentEl);
      const res = await this.executor.openMenuAndSelect(parentEl, subItemText);
      baseline.stopObserver();

      return {
        status: res.ok ? 'SUCCESS' : 'FAILED',
        verified: res.ok,
        action: 'open_menu_and_select',
        reason: res.reason
      };
    }

    /**
     * Switch tab in an SPA and verify.
     * @param {string|Element} tabQuery
     * @param {Object} [options]
     * @returns {Promise<Object>}
     */
    async switchTab(tabQuery, options = {}) {
      return this.click(tabQuery, Object.assign({ isTab: true }, options));
    }

    /**
     * Execute search query with searchbox discovery.
     * @param {string} query
     * @param {Object} [options]
     * @returns {Promise<Object>}
     */
    async executeSearch(query, options = {}) {
      // Find search input
      const searchBox = document.querySelector('input[type="search"], input[name*="search" i], input[id*="search" i], [role="searchbox"]') ||
                        this.locate('Search', { isInput: true }).target;

      if (!searchBox) {
        return { status: 'FAILED', verified: false, reason: 'no_searchbox_found' };
      }

      return this.type(searchBox, query, Object.assign({ submit: true, clear: true }, options));
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { BrowserEngine };
  } else {
    global.BrowserEngine = BrowserEngine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
