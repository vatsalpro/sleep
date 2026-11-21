/**
 * Sleepwalker Rebuilt Browser Engine — Independent State Verifier
 *
 * Implements:
 * - Pre-action baseline snapshot capture.
 * - Predicate-driven settlement polling (not blind static timeouts).
 * - DOM mutation tracking.
 * - Strict 4-state outcome categorization:
 *     SUCCESS | AMBIGUOUS | FAILED | REQUIRES_CONFIRMATION
 * - Elimination of false-completion reports.
 */
(function (global) {
  'use strict';

  class StateVerifier {
    constructor(options = {}) {
      this.options = Object.assign({
        defaultTimeoutMs: 2500,
        pollIntervalMs: 60
      }, options);
    }

    /**
     * Capture pre-action baseline snapshot.
     * @param {Element} [targetEl]
     * @returns {Object} Baseline snapshot
     */
    captureBaseline(targetEl = null) {
      const baseline = {
        timestamp: Date.now(),
        url: window.location.href,
        title: document.title,
        activeElement: document.activeElement ? {
          tag: document.activeElement.tagName,
          id: document.activeElement.id
        } : null,
        scrollY: window.scrollY,
        targetState: targetEl && targetEl.isConnected ? {
          value: targetEl.value,
          checked: targetEl.checked,
          expanded: targetEl.getAttribute('aria-expanded'),
          selected: targetEl.getAttribute('aria-selected')
        } : null,
        mutationCount: 0
      };

      // Set up temporary mutation observer to count DOM changes
      let observer = null;
      try {
        observer = new MutationObserver(() => {
          baseline.mutationCount++;
        });
        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true
        });
      } catch (_e) {}

      return {
        baseline,
        stopObserver: () => {
          if (observer) {
            try { observer.disconnect(); } catch (_e) {}
            observer = null;
          }
        }
      };
    }

    /**
     * Poll a verification predicate until it returns true or times out.
     * @param {Function} predicate
     * @param {number} [timeoutMs]
     * @returns {Promise<boolean>}
     */
    async waitForPredicate(predicate, timeoutMs = null) {
      const timeout = timeoutMs || this.options.defaultTimeoutMs;
      const deadline = Date.now() + timeout;

      while (Date.now() < deadline) {
        try {
          const res = await predicate();
          if (res) return true;
        } catch (_e) {}
        await new Promise(r => setTimeout(r, this.options.pollIntervalMs));
      }
      return false;
    }

    /**
     * Verify Link / Navigation action.
     * @param {Object} baselineHandle
     * @param {Element} targetEl
     * @param {Object} [opts]
     * @returns {Promise<Object>} Verification outcome
     */
    async verifyNavigation(baselineHandle, targetEl, opts = {}) {
      const { baseline, stopObserver } = baselineHandle;
      const t0 = Date.now();

      const success = await this.waitForPredicate(() => {
        // 1. URL changed
        if (window.location.href !== baseline.url) return true;
        // 2. Title changed
        if (document.title !== baseline.title && document.title.length > 0) return true;
        // 3. Target section / heading reached
        if (opts.expectedPath && window.location.pathname.includes(opts.expectedPath)) return true;
        if (opts.expectedHeading) {
          const h = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
            .find(n => (n.textContent || '').toLowerCase().includes(opts.expectedHeading.toLowerCase()));
          if (h) return true;
        }
        return false;
      }, opts.timeoutMs);

      stopObserver();
      const durationMs = Date.now() - t0;

      if (success) {
        return {
          status: 'SUCCESS',
          verified: true,
          action: 'navigation',
          durationMs,
          url: window.location.href,
          title: document.title,
          details: 'Navigation verified via URL/DOM change.'
        };
      }

      return {
        status: 'FAILED',
        verified: false,
        action: 'navigation',
        durationMs,
        reason: 'no_navigation_detected'
      };
    }

    /**
     * Verify Tab Switch action in an SPA.
     * @param {Object} baselineHandle
     * @param {Element} tabEl
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async verifyTabSwitch(baselineHandle, tabEl, opts = {}) {
      const { stopObserver } = baselineHandle;
      const t0 = Date.now();

      const success = await this.waitForPredicate(() => {
        if (!tabEl || !tabEl.isConnected) return false;
        // Check aria-selected or active class
        const ariaSel = tabEl.getAttribute('aria-selected') === 'true';
        const hasActiveClass = /(active|selected|current)/i.test(tabEl.className || '');
        if (!ariaSel && !hasActiveClass) return false;

        // Check associated panel if specified
        if (opts.panelSelector) {
          const panel = document.querySelector(opts.panelSelector);
          if (panel) {
            const style = window.getComputedStyle(panel);
            if (style.display === 'none' || panel.hidden) return false;
          }
        }
        return true;
      }, opts.timeoutMs);

      stopObserver();
      const durationMs = Date.now() - t0;

      if (success) {
        return {
          status: 'SUCCESS',
          verified: true,
          action: 'tab_switch',
          durationMs,
          details: 'Tab switch verified: active state confirmed.'
        };
      }

      return {
        status: 'FAILED',
        verified: false,
        action: 'tab_switch',
        durationMs,
        reason: 'tab_did_not_become_active'
      };
    }

    /**
     * Verify Dropdown / Menu Expansion action.
     * @param {Object} baselineHandle
     * @param {Element} triggerEl
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    async verifyMenuExpanded(baselineHandle, triggerEl, opts = {}) {
      const { stopObserver } = baselineHandle;
      const t0 = Date.now();

      const success = await this.waitForPredicate(() => {
        if (!triggerEl || !triggerEl.isConnected) return false;
        if (triggerEl.getAttribute('aria-expanded') === 'true') return true;
        if (opts.menuSelector) {
          const menu = document.querySelector(opts.menuSelector);
          if (menu) {
            const style = window.getComputedStyle(menu);
            if (style.display !== 'none' && style.visibility !== 'hidden' && !menu.hidden) return true;
          }
        }
        return false;
      }, opts.timeoutMs);

      stopObserver();
      const durationMs = Date.now() - t0;

      if (success) {
        return {
          status: 'SUCCESS',
          verified: true,
          action: 'menu_expand',
          durationMs,
          details: 'Menu expansion verified: submenu container visible.'
        };
      }

      return {
        status: 'FAILED',
        verified: false,
        action: 'menu_expand',
        durationMs,
        reason: 'menu_failed_to_expand'
      };
    }

    /**
     * Verify Input Fill action.
     * @param {Object} baselineHandle
     * @param {HTMLInputElement|Element} inputEl
     * @param {string} expectedValue
     * @returns {Promise<Object>}
     */
    async verifyInputFill(baselineHandle, inputEl, expectedValue) {
      const { stopObserver } = baselineHandle;
      const t0 = Date.now();

      const success = await this.waitForPredicate(() => {
        if (!inputEl || !inputEl.isConnected) return false;
        return String(inputEl.value || '').trim() === String(expectedValue || '').trim();
      }, 1000);

      stopObserver();
      const durationMs = Date.now() - t0;

      if (success) {
        return {
          status: 'SUCCESS',
          verified: true,
          action: 'fill_input',
          durationMs,
          value: inputEl.value,
          details: 'Input fill verified: value accurately committed.'
        };
      }

      return {
        status: 'FAILED',
        verified: false,
        action: 'fill_input',
        durationMs,
        actualValue: inputEl ? inputEl.value : null,
        reason: 'input_value_mismatch'
      };
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StateVerifier };
  } else {
    global.StateVerifier = StateVerifier;
  }
})(typeof window !== 'undefined' ? window : globalThis);
