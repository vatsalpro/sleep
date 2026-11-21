/**
 * Sleepwalker Rebuilt Browser Engine — Playwright-Inspired Executor
 *
 * Implements:
 * - 5-Point Actionability Validation Gates (Attached, Visible, Stable, Enabled, Hit-Test Receives Events).
 * - Collision-free non-covering viewport scroll (accounting for fixed/sticky headers/footers).
 * - Full synthetic gesture sequence matching real user agent event trains.
 * - Robust input typing and text editing (with sensitive field privacy protection).
 * - Dropdown selection (native <select> & ARIA combobox).
 * - Two-phase nested menu expansion and selection.
 */
(function (global) {
  'use strict';

  class PlaywrightExecutor {
    constructor(options = {}) {
      this.options = Object.assign({
        actionTimeoutMs: 5000,
        settleDelayMs: 60,
        scrollOffsetTop: 70, // Header clearance
        scrollOffsetBottom: 40
      }, options);
    }

    /**
     * Validate the 5 Actionability Gates for an element.
     * @param {Element} el
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    async validateActionability(el) {
      if (!el) return { ok: false, reason: 'element_null' };

      // 1. Attached
      if (!el.isConnected) {
        return { ok: false, reason: 'element_not_attached' };
      }

      // 2. Visible
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return { ok: false, reason: 'element_zero_dimensions' };
      }
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return { ok: false, reason: 'element_css_hidden' };
        }
      } catch (_e) {
        return { ok: false, reason: 'style_computation_error' };
      }

      // 3. Stable (Coordinates check across frame)
      const r1 = el.getBoundingClientRect();
      await new Promise(r => requestAnimationFrame(r));
      const r2 = el.getBoundingClientRect();
      if (Math.abs(r1.x - r2.x) > 2 || Math.abs(r1.y - r2.y) > 2) {
        // Element is actively animating/moving; give a short settlement grace
        await new Promise(r => setTimeout(r, 120));
      }

      // 4. Enabled
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return { ok: false, reason: 'element_disabled' };
      }

      // 5. Receives Events (Hit-test)
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (centerX >= 0 && centerY >= 0 && centerX <= window.innerWidth && centerY <= window.innerHeight) {
        const hit = document.elementFromPoint(centerX, centerY);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          // If hit element is internal overlay or child, allow
          const hitStyle = window.getComputedStyle(hit);
          if (hitStyle.pointerEvents !== 'none' && !hit.id?.includes('sleepwalker')) {
            return { ok: false, reason: 'hit_test_obstructed_by_' + hit.tagName.toLowerCase() };
          }
        }
      }

      return { ok: true };
    }

    /**
     * Scroll element into view with clearance for fixed/sticky headers.
     * @param {Element} el
     */
    async scrollIntoViewIfNeeded(el) {
      if (!el || !el.isConnected) return;
      const rect = el.getBoundingClientRect();
      const inView = rect.top >= this.options.scrollOffsetTop &&
                     rect.bottom <= (window.innerHeight - this.options.scrollOffsetBottom) &&
                     rect.left >= 0 && rect.right <= window.innerWidth;
      if (inView) return;

      // Calculate sticky headers
      let topClearance = this.options.scrollOffsetTop;
      const fixedHeaders = document.querySelectorAll('header, nav, [style*="position: fixed"], [style*="position: sticky"]');
      fixedHeaders.forEach(h => {
        const hr = h.getBoundingClientRect();
        if (hr.top <= 10 && hr.bottom > topClearance && hr.bottom < 200) {
          topClearance = hr.bottom + 10;
        }
      });

      const targetY = window.scrollY + rect.top - topClearance - 20;
      window.scrollTo({
        top: Math.max(0, targetY),
        behavior: 'instant'
      });
      await new Promise(r => setTimeout(r, this.options.settleDelayMs));
    }

    /**
     * Dispatch full synthetic user gesture sequence.
     * @param {Element} el
     */
    dispatchGestureTrain(el) {
      const rect = el.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);
      const eventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX,
        clientY,
        button: 0,
        buttons: 1
      };

      el.dispatchEvent(new PointerEvent('pointerover', eventInit));
      el.dispatchEvent(new MouseEvent('mouseover', eventInit));
      el.dispatchEvent(new PointerEvent('pointerdown', eventInit));
      el.dispatchEvent(new MouseEvent('mousedown', eventInit));

      if (typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }); } catch (_e) {}
      }

      el.dispatchEvent(new PointerEvent('pointerup', eventInit));
      el.dispatchEvent(new MouseEvent('mouseup', eventInit));
      el.dispatchEvent(new MouseEvent('click', eventInit));
    }

    /**
     * Click an element safely with actionability verification.
     * @param {Element} el
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    async click(el) {
      await this.scrollIntoViewIfNeeded(el);
      const gate = await this.validateActionability(el);
      if (!gate.ok) {
        return { ok: false, reason: gate.reason };
      }

      this.dispatchGestureTrain(el);
      await new Promise(r => setTimeout(r, this.options.settleDelayMs));
      return { ok: true };
    }

    /**
     * Type text into an input or textarea element.
     * @param {HTMLInputElement|HTMLTextAreaElement|Element} el
     * @param {string} text
     * @param {Object} opts
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    async type(el, text, opts = {}) {
      if (!el || !el.isConnected) return { ok: false, reason: 'element_null' };

      // Privacy gate: never fill password fields without explicit override
      if (el instanceof HTMLInputElement && el.type === 'password' && !opts.allowPassword) {
        return { ok: false, reason: 'password_privacy_gate' };
      }

      await this.scrollIntoViewIfNeeded(el);
      const gate = await this.validateActionability(el);
      if (!gate.ok) return { ok: false, reason: gate.reason };

      // Focus
      if (typeof el.focus === 'function') el.focus();
      el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

      // Clear if requested
      if (opts.clear !== false) {
        el.value = '';
      }

      // Input event train
      const beforeEvent = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: 'insertText'
      });
      el.dispatchEvent(beforeEvent);

      el.value = (opts.clear !== false) ? text : (el.value + text);

      const inputEvent = new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        data: text,
        inputType: 'insertText'
      });
      el.dispatchEvent(inputEvent);

      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Submit on enter if requested
      if (opts.submit) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        const form = el.closest('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        }
      }

      await new Promise(r => setTimeout(r, this.options.settleDelayMs));
      return { ok: true, value: el.value };
    }

    /**
     * Select an option from native select or ARIA combobox.
     * @param {Element} el
     * @param {string} valueOrLabel
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    async selectOption(el, valueOrLabel) {
      if (!el || !el.isConnected) return { ok: false, reason: 'element_null' };
      await this.scrollIntoViewIfNeeded(el);

      const normTarget = String(valueOrLabel || '').toLowerCase().trim();

      // Native select
      if (el instanceof HTMLSelectElement) {
        let matchedIndex = -1;
        for (let i = 0; i < el.options.length; i++) {
          const opt = el.options[i];
          if (opt.value.toLowerCase() === normTarget || (opt.text || '').toLowerCase().includes(normTarget)) {
            matchedIndex = i;
            break;
          }
        }
        if (matchedIndex === -1) return { ok: false, reason: 'option_not_found' };

        el.selectedIndex = matchedIndex;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selectedValue: el.value, selectedText: el.options[matchedIndex].text };
      }

      // ARIA combobox / Custom dropdown
      const isCombobox = el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-haspopup');
      if (isCombobox) {
        // Expand dropdown
        await this.click(el);
        await new Promise(r => setTimeout(r, 120));

        // Find matching option in document / popup
        const root = el.getRootNode ? el.getRootNode() : document;
        const candidates = Array.from(root.querySelectorAll('[role="option"], [role="menuitem"], .dropdown-item, li, button'));
        const matched = candidates.find(c => (c.textContent || '').toLowerCase().includes(normTarget));
        if (matched) {
          await this.click(matched);
          return { ok: true, selectedText: (matched.textContent || '').trim() };
        }
        return { ok: false, reason: 'custom_option_not_found' };
      }

      return { ok: false, reason: 'unsupported_select_element' };
    }

    /**
     * Open a parent navigation menu and select a nested submenu item.
     * @param {Element} parentTrigger
     * @param {Function|string} findChildItem
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    async openMenuAndSelect(parentTrigger, findChildItem) {
      if (!parentTrigger || !parentTrigger.isConnected) return { ok: false, reason: 'parent_null' };

      // Step 1: Open parent trigger
      await this.click(parentTrigger);
      await new Promise(r => setTimeout(r, 150));

      // Step 2: Locate child item
      let childEl = null;
      if (typeof findChildItem === 'function') {
        childEl = findChildItem();
      } else if (typeof findChildItem === 'string') {
        const root = parentTrigger.getRootNode ? parentTrigger.getRootNode() : document;
        const allItems = Array.from(root.querySelectorAll('a, button, [role="menuitem"], [role="treeitem"], li'));
        const normChild = findChildItem.toLowerCase().trim();
        childEl = allItems.find(it => {
          const style = window.getComputedStyle(it);
          const isVis = style.display !== 'none' && style.visibility !== 'hidden' && it.offsetWidth > 0;
          return isVis && (it.textContent || '').toLowerCase().includes(normChild);
        });
      }

      if (!childEl) {
        return { ok: false, reason: 'nested_child_not_found' };
      }

      // Step 3: Click child item
      const childClick = await this.click(childEl);
      return childClick;
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PlaywrightExecutor };
  } else {
    global.PlaywrightExecutor = PlaywrightExecutor;
  }
})(typeof window !== 'undefined' ? window : globalThis);
