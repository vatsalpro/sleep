/**
 * Sleepwalker 2.0 — Unified Rebuilt Browser Engine
 * 
 * Fuses Stagehand-inspired semantic observation with Playwright-inspired actionability and execution.
 * Fully compatible with Chrome Manifest V3 Content Scripts and isolated worlds.
 * 
 * Modules:
 * 1. StagehandObserver (W3C AccName, Roles, Landmark hierarchy, Shadow DOM)
 * 2. PlaywrightExecutor (5-point actionability gates, collision-free scroll, full gesture sequence)
 * 3. StateVerifier (Pre/post baseline diffs, predicate settlement, unambiguous outcome classification)
 * 4. VisualFallback (Geometry and coordinate hit-test validation)
 * 5. BrowserEngine (Unified facade)
 */
(function (global) {
  'use strict';

  const SENSITIVE_FIELD_RE = /\b(?:password|passwd|pwd|passcode|otp|one[- ]?time|pin\b(?!code)|cvv|cvc|card[-_ ]?num|credit[-_ ]?card|debit[-_ ]?card|ssn|social[-_ ]?security|aadhaar|aadhar|pan\b|api[-_ ]?key|secret|token|auth|bearer|bank[-_ ]?account|routing|ifsc)\b/i;
  const SENSITIVE_AUTOCOMPLETE_RE = /\b(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)\b/i;
  const PROMPT_INJECTION_RE = /\b(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?)|disregard\s+(?:all\s+)?(?:previous|system)\s+instructions?|you\s+are\s+now\s+|override\s+(?:safety|security|confirmation|rules?)|bypass\s+confirmation|auto[- ]?confirm|system\s*prompt|new\s+system\s+instruction)\b/gi;
  const CONSEQUENTIAL_ACTION_RE = /\b(?:submit\s+(?:order|payment|application|form)|pay\s+now|place\s+order|complete\s+(?:purchase|payment|order|checkout)|checkout|buy\s+now|delete\s+(?:account|all|permanently|profile|project|repo)|remove\s+account|erase\s+all|deactivate\s+account|close\s+account|wire\s+transfer|send\s+money|confirm\s+payment|authorize\s+payment)\b/i;

  function sanitizeUntrustedLabel(raw, maxLen = 120) {
    let s = String(raw || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    s = s.replace(PROMPT_INJECTION_RE, '[FILTERED_DIRECTIVE]');
    s = s.replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?|(?:sk|pk|ghp|gho|ghu|ghs)[_-][0-9A-Za-z_-]{16,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED_SECRET]');
    return s.slice(0, maxLen).trim();
  }

  function isSensitiveElement(node) {
    if (!node) return false;
    const type = String(node.type || (node.getAttribute && node.getAttribute('type')) || '').toLowerCase();
    if (type === 'password') return true;
    const ac = String((node.getAttribute && node.getAttribute('autocomplete')) || '').toLowerCase();
    if (ac && SENSITIVE_AUTOCOMPLETE_RE.test(ac)) return true;
    const meta = [
      node.name || '',
      node.id || '',
      (node.getAttribute && node.getAttribute('aria-label')) || '',
      (node.getAttribute && node.getAttribute('placeholder')) || ''
    ].join(' ');
    return SENSITIVE_FIELD_RE.test(meta);
  }

  function isConsequentialElement(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    const text = [
      el.textContent || '',
      (el.getAttribute && el.getAttribute('aria-label')) || '',
      (el.getAttribute && el.getAttribute('title')) || '',
      (el.getAttribute && el.getAttribute('value')) || '',
      (el.getAttribute && el.getAttribute('name')) || ''
    ].join(' ').replace(/\s+/g, ' ').trim();
    if (CONSEQUENTIAL_ACTION_RE.test(text)) return true;
    if ((tag === 'BUTTON' || tag === 'INPUT') && type === 'submit' && /\b(?:pay|checkout|delete|remove|transfer|purchase|buy|confirm|submit)\b/i.test(text)) {
      return true;
    }
    return false;
  }

  // ===========================================================================
  // 1. StagehandObserver
  // ===========================================================================
  class StagehandObserver {
    constructor(options = {}) {
      this.options = Object.assign({
        maxElements: 80,
        includeInvisible: false,
        skipHiddenInputs: true
      }, options);
    }

    computeAccessibleName(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = labelledBy.split(/\s+/).map(id => {
          const ref = document.getElementById(id);
          return ref ? (ref.textContent || '').trim() : '';
        }).filter(Boolean);
        if (parts.length > 0) return parts.join(' ');
      }

      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        if (el.id) {
          const rootNode = el.getRootNode ? el.getRootNode() : document;
          const lbl = rootNode.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) {
            const lblText = this._getCleanText(lbl);
            if (lblText) return lblText;
          }
        }
        const wrappingLabel = el.closest('label');
        if (wrappingLabel) {
          const clone = wrappingLabel.cloneNode(true);
          const childInputs = clone.querySelectorAll('input, select, textarea');
          childInputs.forEach(i => i.remove());
          const txt = (clone.textContent || '').trim();
          if (txt) return txt;
        }
        if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();
        if (el.title && el.title.trim()) return el.title.trim();
        if (el.name && el.name.trim()) return el.name.trim();
      }

      if (el instanceof HTMLImageElement) {
        if (el.alt && el.alt.trim()) return el.alt.trim();
        if (el.title && el.title.trim()) return el.title.trim();
      }

      if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab') {
        const cleanText = this._getCleanText(el);
        if (cleanText) return cleanText;
        if (el.title && el.title.trim()) return el.title.trim();
      }

      const directText = this._getCleanText(el);
      if (directText) return directText;

      return el.getAttribute('title') || el.getAttribute('name') || '';
    }

    computeRole(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

      const explicit = el.getAttribute('role');
      if (explicit && explicit.trim()) return explicit.trim().toLowerCase();

      const tag = el.tagName.toUpperCase();
      switch (tag) {
        case 'A': return el.hasAttribute('href') ? 'link' : 'generic';
        case 'BUTTON': return 'button';
        case 'INPUT': {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'search') return 'searchbox';
          return 'textbox';
        }
        case 'SELECT': return 'combobox';
        case 'TEXTAREA': return 'textbox';
        case 'NAV': return 'navigation';
        case 'MAIN': return 'main';
        case 'HEADER': return 'banner';
        case 'FOOTER': return 'contentinfo';
        case 'SECTION': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : 'section';
        case 'H1':
        case 'H2':
        case 'H3':
        case 'H4':
        case 'H5':
        case 'H6': return 'heading';
        case 'UL':
        case 'OL': return 'list';
        case 'LI': return 'listitem';
        case 'TABLE': return 'table';
        default: return 'generic';
      }
    }

    isActionable(el, role) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

      if (el.closest && (el.closest('#sleepwalker-ui-host') || el.closest('#sleepwalker-host') || el.closest('[data-sleepwalker-ui="1"]'))) {
        return false;
      }

      const actionableRoles = new Set([
        'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
        'combobox', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch',
        'slider', 'option'
      ]);

      if (actionableRoles.has(role)) return true;

      const tag = el.tagName.toUpperCase();
      if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
      if (tag === 'INPUT' && (el.type || '').toLowerCase() !== 'hidden') return true;

      if (el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.getAttribute('contenteditable') === 'true') {
        return true;
      }

      try {
        const style = window.getComputedStyle(el);
        if (style && style.cursor === 'pointer' && !['BODY', 'HTML'].includes(tag)) {
          return true;
        }
      } catch (_e) {}

      return false;
    }

    computeParentSection(el) {
      if (!el) return '';
      let cur = el.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        if (cur.getAttribute('aria-label')) return cur.getAttribute('aria-label').trim();
        const labelledBy = cur.getAttribute('aria-labelledby');
        if (labelledBy) {
          const ref = document.getElementById(labelledBy);
          if (ref) return (ref.textContent || '').trim();
        }

        const heading = cur.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
        if (heading && heading !== el && !heading.contains(el)) {
          const hText = this._getCleanText(heading);
          if (hText) return hText;
        }

        const role = cur.getAttribute('role');
        if (role && ['navigation', 'main', 'region', 'form', 'banner', 'complementary'].includes(role)) {
          return cur.getAttribute('aria-label') || cur.id || role;
        }
        if (['NAV', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'FORM', 'HEADER'].includes(cur.tagName)) {
          if (cur.id) return cur.id;
        }

        cur = cur.parentElement;
      }
      return '';
    }

    isVisible(el) {
      if (!el || !el.isConnected) return false;
      if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) return false;
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
      } catch (_e) {
        return false;
      }
      return true;
    }

    traverseTree(root, callback) {
      if (!root) return;
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.nodeType === Node.ELEMENT_NODE) {
          callback(node);
          if (node.shadowRoot) {
            stack.push(node.shadowRoot);
          }
        }
        if (node.children) {
          for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push(node.children[i]);
          }
        }
      }
    }

    observe(root = document) {
      const actionable = [];
      let seq = 0;

      this.traverseTree(root === document ? document.body : root, (node) => {
        const role = this.computeRole(node);
        if (!this.isActionable(node, role)) return;

        const visible = this.isVisible(node);
        if (!visible && !this.options.includeInvisible) return;

        const name = sanitizeUntrustedLabel(this.computeAccessibleName(node), 120);
        const rect = node.getBoundingClientRect();
        const parentSec = sanitizeUntrustedLabel(this.computeParentSection(node), 80);
        const sensitiveField = isSensitiveElement(node);

        const states = {
          visible,
          disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
          sensitive: sensitiveField,
          expanded: node.hasAttribute('aria-expanded') ? node.getAttribute('aria-expanded') === 'true' : undefined,
          selected: node.hasAttribute('aria-selected') ? node.getAttribute('aria-selected') === 'true' : undefined,
          checked: node.hasAttribute('aria-checked')
            ? node.getAttribute('aria-checked') === 'true'
            : (node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type) ? node.checked : undefined),
          value: (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement)
            ? (sensitiveField ? '[REDACTED]' : sanitizeUntrustedLabel(node.value, 120))
            : undefined
        };

        const item = {
          id: `e-${++seq}`,
          role,
          name,
          tag: node.tagName,
          parentSection: parentSec,
          states,
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          domNode: node
        };

        actionable.push(item);
      });

      const tokens = actionable.slice(0, this.options.maxElements).map((a, idx) => {
        const prefix = a.role === 'button' ? 'B'
          : a.role === 'link' ? 'L'
          : (a.role === 'textbox' || a.role === 'searchbox') ? 'I'
          : a.role === 'combobox' ? 'C'
          : a.role === 'tab' ? 'T' : 'E';
        const num = String(idx + 1).padStart(2, '0');
        const secPart = a.parentSection ? ` (section: ${a.parentSection})` : '';
        const statePart = a.states.selected ? ' [selected=true]'
          : a.states.expanded ? ' [expanded=true]'
          : a.states.checked ? ' [checked=true]' : '';
        return `[${prefix}${num}] ${a.role} "${a.name}"${statePart}${secPart}`;
      });

      return {
        timestamp: Date.now(),
        url: window.location.href,
        title: document.title,
        elements: actionable,
        elementCount: actionable.length,
        compactTokens: tokens,
        compactPrompt: tokens.join('\n')
      };
    }

    _getCleanText(el) {
      if (!el) return '';
      const clone = el.cloneNode(true);
      const toRemove = clone.querySelectorAll('script, style, noscript, [hidden], [aria-hidden="true"], #sleepwalker-ui-host');
      toRemove.forEach(r => r.remove());
      const styled = clone.querySelectorAll('[style]');
      styled.forEach(s => {
        const st = String(s.getAttribute('style') || '').toLowerCase();
        if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?:\s*;|$)|font-size\s*:\s*0(?:px|em|rem)?(?:\s*;|$)/.test(st)) {
          s.remove();
        }
      });
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }
  }

  // ===========================================================================
  // 2. PlaywrightExecutor
  // ===========================================================================
  class PlaywrightExecutor {
    constructor(options = {}) {
      this.options = Object.assign({
        actionTimeoutMs: 5000,
        settleDelayMs: 60,
        scrollOffsetTop: 70,
        scrollOffsetBottom: 40
      }, options);
    }

    async validateActionability(el) {
      if (!el) return { ok: false, reason: 'element_null' };

      if (!el.isConnected) {
        return { ok: false, reason: 'element_not_attached' };
      }

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

      const r1 = el.getBoundingClientRect();
      await new Promise(r => {
        const timer = setTimeout(r, 20);
        if (typeof requestAnimationFrame === 'function') {
          try { requestAnimationFrame(() => { clearTimeout(timer); r(); }); } catch (_e) { clearTimeout(timer); r(); }
        }
      });
      const r2 = el.getBoundingClientRect();
      if (Math.abs(r1.x - r2.x) > 2 || Math.abs(r1.y - r2.y) > 2) {
        await new Promise(r => setTimeout(r, 120));
      }

      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return { ok: false, reason: 'element_disabled' };
      }

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (centerX >= 0 && centerY >= 0 && centerX <= window.innerWidth && centerY <= window.innerHeight) {
        const hit = document.elementFromPoint(centerX, centerY);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          const hitStyle = window.getComputedStyle(hit);
          if (hitStyle.pointerEvents !== 'none' && !hit.id?.includes('sleepwalker')) {
            return { ok: false, reason: 'hit_test_obstructed_by_' + hit.tagName.toLowerCase() };
          }
        }
      }

      return { ok: true };
    }

    async scrollIntoViewIfNeeded(el) {
      if (!el || !el.isConnected) return;
      const rect = el.getBoundingClientRect();
      const inView = rect.top >= this.options.scrollOffsetTop &&
                     rect.bottom <= (window.innerHeight - this.options.scrollOffsetBottom) &&
                     rect.left >= 0 && rect.right <= window.innerWidth;
      if (inView) return;

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
      if (typeof el.click === 'function') {
        try { el.click(); } catch (_e) {}
      }
    }

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

    async type(el, text, opts = {}) {
      if (!el || !el.isConnected) return { ok: false, reason: 'element_null' };

      if (el instanceof HTMLInputElement && el.type === 'password' && !opts.allowPassword) {
        return { ok: false, reason: 'password_privacy_gate' };
      }

      await this.scrollIntoViewIfNeeded(el);
      const gate = await this.validateActionability(el);
      if (!gate.ok) return { ok: false, reason: gate.reason };

      if (typeof el.focus === 'function') el.focus();
      el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

      if (opts.clear !== false) {
        el.value = '';
      }

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

    async selectOption(el, valueOrLabel) {
      if (!el || !el.isConnected) return { ok: false, reason: 'element_null' };
      await this.scrollIntoViewIfNeeded(el);

      const normTarget = String(valueOrLabel || '').toLowerCase().trim();

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

      const isCombobox = el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-haspopup');
      if (isCombobox) {
        await this.click(el);
        await new Promise(r => setTimeout(r, 120));

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

    async openMenuAndSelect(parentTrigger, findChildItem) {
      if (!parentTrigger || !parentTrigger.isConnected) return { ok: false, reason: 'parent_null' };

      await this.click(parentTrigger);
      await new Promise(r => setTimeout(r, 150));

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

      const childClick = await this.click(childEl);
      return childClick;
    }
  }

  // ===========================================================================
  // 3. StateVerifier
  // ===========================================================================
  class StateVerifier {
    constructor(options = {}) {
      this.options = Object.assign({
        defaultTimeoutMs: 2500,
        pollIntervalMs: 60
      }, options);
    }

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

    async verifyNavigation(baselineHandle, targetEl, opts = {}) {
      const { baseline, stopObserver } = baselineHandle;
      const t0 = Date.now();

      const success = await this.waitForPredicate(() => {
        if (window.location.href !== baseline.url) return true;
        if (document.title !== baseline.title && document.title.length > 0) return true;
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

    async verifyTabSwitch(baselineHandle, tabEl, opts = {}) {
      const { stopObserver } = baselineHandle;
      const t0 = Date.now();

      const success = await this.waitForPredicate(() => {
        if (!tabEl || !tabEl.isConnected) return false;
        const ariaSel = tabEl.getAttribute('aria-selected') === 'true';
        const hasActiveClass = /(active|selected|current)/i.test(tabEl.className || '');
        if (!ariaSel && !hasActiveClass) return false;

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

  // ===========================================================================
  // 4. VisualFallback
  // ===========================================================================
  class VisualFallback {
    constructor(options = {}) {
      this.options = Object.assign({
        minConfidence: 0.70
      }, options);
    }

    findVisualCandidates(root = document) {
      const candidates = [];
      const interactiveTags = ['svg', 'canvas', 'img', 'i', 'span'];

      const elements = root.querySelectorAll(interactiveTags.join(', '));
      elements.forEach((el) => {
        const style = window.getComputedStyle(el);
        const isClickable = style.cursor === 'pointer' || el.closest('button, a, [onclick], [role="button"]');
        if (!isClickable) return;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 4 || rect.height <= 4) return;
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;

        candidates.push({
          element: el,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          tag: el.tagName,
          isCanvas: el.tagName === 'CANVAS',
          isSvg: el.tagName === 'SVG' || Boolean(el.closest('svg'))
        });
      });

      return candidates;
    }

    validateCoordinateTarget(x, y) {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        return { ok: false, reason: 'coordinates_out_of_viewport' };
      }

      const hit = document.elementFromPoint(x, y);
      if (!hit) {
        return { ok: false, reason: 'no_element_at_point' };
      }

      return { ok: true, target: hit };
    }
  }

  // ===========================================================================
  // 5. BrowserEngine (Unified Facade)
  // ===========================================================================
  class BrowserEngine {
    constructor(options = {}) {
      this.options = Object.assign({
        ambiguityThreshold: 2,
        minMatchScore: 40,
        cacheTtlMs: 1200
      }, options);

      this.observer = new StagehandObserver(options.observer);
      this.executor = new PlaywrightExecutor(options.executor);
      this.verifier = new StateVerifier(options.verifier);
      this.visual = new VisualFallback(options.visual);
      this._obsCache = null;
    }

    invalidateCache() {
      this._obsCache = null;
    }

    observe(root = document, opts = {}) {
      const now = Date.now();
      const curUrl = (typeof window !== 'undefined' && window.location) ? window.location.href : '';
      const childSig = (root && root.body ? root.body.childElementCount : (root ? root.childElementCount : 0)) || 0;
      if (
        !opts.force &&
        this._obsCache &&
        this._obsCache.root === root &&
        this._obsCache.url === curUrl &&
        this._obsCache.childSig === childSig &&
        (now - this._obsCache.ts) < this.options.cacheTtlMs
      ) {
        const sample = this._obsCache.result.elements;
        const sampleValid = sample.length === 0 || (
          sample[0].domNode && sample[0].domNode.isConnected &&
          sample[sample.length - 1].domNode && sample[sample.length - 1].domNode.isConnected
        );
        if (sampleValid) {
          return this._obsCache.result;
        }
      }
      const result = this.observer.observe(root);
      this._obsCache = { root, url: curUrl, childSig, ts: now, result };
      return result;
    }

    locate(query, options = {}) {
      const observation = this.observe(options.root || document);
      const normQuery = String(query || '').toLowerCase().replace(/[.,!?;:]+$/g, '').trim();
      const queryTokens = normQuery.split(/\s+/).filter(Boolean);

      if (!normQuery) {
        return { status: 'NOT_FOUND', reason: 'empty_query' };
      }

      let pool = observation.elements;
      if (options.role) {
        pool = pool.filter(e => e.role === options.role);
      }

      if (options.section) {
        const normSec = options.section.toLowerCase();
        const sectionMatches = pool.filter(e => e.parentSection.toLowerCase().includes(normSec));
        if (sectionMatches.length > 0) pool = sectionMatches;
      }

      const scored = [];
      for (const item of pool) {
        let score = 0;
        const normName = item.name.toLowerCase();

        if (normName === normQuery) {
          score += 100;
        } else if (normName.includes(normQuery)) {
          score += 70;
        } else if (normQuery.includes(normName) && normName.length >= 3) {
          score += 55;
        }

        const matchedTokens = queryTokens.filter(t => normName.includes(t));
        score += (matchedTokens.length / queryTokens.length) * 40;

        if (options.section && item.parentSection.toLowerCase().includes(options.section.toLowerCase())) {
          score += 25;
        }

        if (item.states.visible) score += 15;

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

      // Code-level consequential action permission gate (cannot be bypassed by model prompts or injected labels)
      if (isConsequentialElement(targetEl) && options.userConfirmed !== true) {
        return {
          status: 'CONFIRMATION_REQUIRED',
          verified: false,
          consequential: true,
          reason: 'consequential_action_requires_explicit_user_confirmation',
          targetLabel: sanitizeUntrustedLabel(this.observer.computeAccessibleName(targetEl), 80)
        };
      }

      const baseline = this.verifier.captureBaseline(targetEl);

      const execResult = await this.executor.click(targetEl);
      this.invalidateCache();
      if (!execResult.ok) {
        baseline.stopObserver();
        return { status: 'FAILED', verified: false, reason: execResult.reason };
      }

      if (options.isNavigation || targetEl.tagName === 'A' || targetEl.closest('a')) {
        return this.verifier.verifyNavigation(baseline, targetEl, options);
      } else if (options.isTab || targetEl.getAttribute('role') === 'tab') {
        return this.verifier.verifyTabSwitch(baseline, targetEl, options);
      } else if (options.isMenu || targetEl.hasAttribute('aria-expanded')) {
        return this.verifier.verifyMenuExpanded(baseline, targetEl, options);
      }

      baseline.stopObserver();
      return {
        status: 'SUCCESS',
        verified: true,
        action: 'click',
        targetTag: targetEl.tagName,
        mutations: baseline.baseline.mutationCount
      };
    }

    async type(targetOrQuery, text, options = {}) {
      let targetEl = null;

      if (typeof targetOrQuery === 'string' && SENSITIVE_FIELD_RE.test(targetOrQuery) && !options.allowPassword) {
        return { status: 'SENSITIVE_SKIPPED', verified: false, reason: 'sensitive_field_privacy_gate' };
      }

      if (typeof targetOrQuery === 'string' && targetOrQuery.trim()) {
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
      } else if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        targetEl = document.activeElement;
      }

      if (!targetEl || !targetEl.isConnected) {
        return { status: 'FAILED', verified: false, reason: 'input_field_not_found' };
      }

      if (isSensitiveElement(targetEl) && !options.allowPassword) {
        return { status: 'SENSITIVE_SKIPPED', verified: false, reason: 'sensitive_field_privacy_gate' };
      }

      const baseline = this.verifier.captureBaseline(targetEl);
      const execResult = await this.executor.type(targetEl, text, options);
      this.invalidateCache();
      if (!execResult.ok) {
        baseline.stopObserver();
        return { status: 'FAILED', verified: false, reason: execResult.reason };
      }

      if (options.submit) {
        const navRes = await this.verifier.verifyNavigation(baseline, targetEl, Object.assign({ timeoutMs: options.timeoutMs || 1800 }, options));
        if (navRes.verified || String(targetEl.value || '') === String(text || '')) {
          return {
            status: 'SUCCESS',
            verified: true,
            action: 'type_and_submit',
            value: String(targetEl.value || text || ''),
            navigated: Boolean(navRes.verified),
            url: window.location.href,
            details: navRes.verified ? navRes.details : 'Input value committed and submitted.'
          };
        }
        return navRes;
      }

      const verifyRes = await this.verifier.verifyInputFill(baseline, targetEl, text);
      this.observe(options.root || document, { force: true });
      return {
        ...verifyRes,
        targetLabel: sanitizeUntrustedLabel(this.observer.computeAccessibleName(targetEl), 80)
      };
    }

    async select(targetOrQuery, optionText, options = {}) {
      // 1. Observe
      const obs = this.observe(options.root || document);
      let targetEl = null;
      let wantOpt = String(optionText !== undefined && optionText !== null ? optionText : targetOrQuery || '').trim();
      const hasExplicitSelectTarget = Boolean(optionText !== undefined && optionText !== null && typeof targetOrQuery === 'string' && targetOrQuery.trim());

      // 2. Resolve
      if (targetOrQuery instanceof Element) {
        targetEl = targetOrQuery;
      } else if (hasExplicitSelectTarget) {
        const located = this.locate(targetOrQuery, Object.assign({ role: 'combobox' }, options));
        if (located.status === 'AMBIGUOUS') {
          return { status: 'AMBIGUOUS', verified: false, candidates: located.candidates, prompt: located.prompt };
        }
        if (located.status === 'FOUND' && located.target) {
          targetEl = located.target;
        }
      }

      if (!targetEl && wantOpt) {
        const wantLow = wantOpt.toLowerCase();
        const comboboxes = obs.elements.filter(e =>
          e.states.visible && !e.states.disabled &&
          (e.role === 'combobox' || (e.domNode && e.domNode.tagName === 'SELECT'))
        );
        const matchingSelects = [];
        for (const cb of comboboxes) {
          const node = cb.domNode;
          if (!node) continue;
          if (node.tagName === 'SELECT') {
            const opts = Array.from(node.options || []);
            const hit = opts.find(o => !o.disabled && (
              (o.textContent || '').trim().toLowerCase() === wantLow ||
              (o.value || '').trim().toLowerCase() === wantLow ||
              (o.textContent || '').trim().toLowerCase().includes(wantLow)
            ));
            if (hit) matchingSelects.push({ item: cb, element: node, matchedOption: hit });
          }
        }
        if (matchingSelects.length > 1 && options.section) {
          const secLow = String(options.section).toLowerCase();
          const secFiltered = matchingSelects.filter(m =>
            `${m.item.name} ${m.item.parentSection}`.toLowerCase().includes(secLow)
          );
          if (secFiltered.length === 1) {
            targetEl = secFiltered[0].element;
          }
        }
        if (!targetEl) {
          if (matchingSelects.length === 1) {
            targetEl = matchingSelects[0].element;
          } else if (matchingSelects.length > 1) {
            return {
              status: 'AMBIGUOUS',
              verified: false,
              candidates: matchingSelects.map(m => ({
                id: m.item.id,
                name: m.item.name || m.item.parentSection || 'Dropdown',
                label: m.item.name || m.item.parentSection || 'Dropdown',
                role: m.item.role,
                section: m.item.parentSection,
                element: m.element
              })),
              prompt: `Multiple dropdowns contain "${wantOpt}". Which one did you mean?`
            };
          }
        }
      }

      if (!targetEl && typeof targetOrQuery === 'string' && targetOrQuery.trim()) {
        const genLoc = this.locate(targetOrQuery, options);
        if (genLoc.status === 'FOUND' && genLoc.target && (genLoc.target.tagName === 'SELECT' || genLoc.target.getAttribute('role') === 'combobox' || genLoc.target.getAttribute('role') === 'listbox')) {
          targetEl = genLoc.target;
        }
      }

      if (!targetEl || !targetEl.isConnected) {
        return { status: 'FAILED', verified: false, reason: 'select_element_not_found' };
      }

      // 3. Validate -> 4. Execute
      const res = await this.executor.selectOption(targetEl, wantOpt);
      this.invalidateCache();

      // 5. Re-observe & Verify
      let verified = Boolean(res.ok);
      if (verified && targetEl.tagName === 'SELECT') {
        const selOpt = targetEl.options && targetEl.options[targetEl.selectedIndex];
        const actualVal = targetEl.value;
        const actualTxt = selOpt ? (selOpt.textContent || '').trim() : '';
        verified = (actualVal === res.selectedValue) || actualTxt.toLowerCase().includes(wantOpt.toLowerCase());
      }
      this.observe(options.root || document, { force: true });

      return {
        status: verified ? 'SUCCESS' : 'FAILED',
        verified,
        action: 'select_option',
        targetLabel: sanitizeUntrustedLabel(this.observer.computeAccessibleName(targetEl), 80),
        selectedText: res.selectedText,
        selectedValue: res.selectedValue,
        reason: res.reason
      };
    }

    readContent(targetOrQuery = '', options = {}) {
      const root = options.root || document;
      let el = null;
      let headingLabel = '';
      let extractedText = '';

      if (!targetOrQuery || targetOrQuery === 'page') {
        el = root.querySelector('main, article, [role="main"]') || root.body;
        headingLabel = root.title || 'Page';
      } else if (typeof targetOrQuery === 'string') {
        const qTrim = targetOrQuery.trim();
        let matches = [];
        try { matches = Array.from(root.querySelectorAll(qTrim)); } catch (_e) {}
        const withText = matches.find(m => this.observer._getCleanText(m).length > 0);
        if (withText) {
          el = withText;
        } else {
          const qLow = qTrim.toLowerCase().replace(/\b(?:section|heading|paragraph)\b/gi, '').trim();
          const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'));
          const hitH = headings.find(h => this.observer._getCleanText(h).toLowerCase().includes(qLow));
          if (hitH) {
            headingLabel = sanitizeUntrustedLabel(this.observer._getCleanText(hitH), 120);
            const secContainer = hitH.closest('section, article, [role="region"]');
            if (secContainer && secContainer !== root.body) {
              el = secContainer;
            } else {
              const parts = [];
              let sib = hitH.nextElementSibling;
              while (sib && !/^H[1-6]$/.test(sib.tagName) && sib.getAttribute('role') !== 'heading') {
                const t = this.observer._getCleanText(sib);
                if (t) parts.push(t);
                sib = sib.nextElementSibling;
              }
              extractedText = parts.join(' ').trim() || this.observer._getCleanText(hitH.parentElement);
              el = hitH;
            }
          } else {
            el = Array.from(root.querySelectorAll('article, section, main, [role="region"], div')).find(e => {
              return (e.getAttribute('aria-label') || '').toLowerCase().includes(qLow);
            }) || null;
          }
        }
      } else if (targetOrQuery instanceof Element) {
        el = targetOrQuery;
      }

      if (!el && !extractedText) {
        return { status: 'FAILED', verified: false, text: '', reason: 'content_container_not_found' };
      }

      const rawClean = extractedText || this.observer._getCleanText(el);
      const clean = rawClean.replace(PROMPT_INJECTION_RE, '[FILTERED_DIRECTIVE]').trim();

      return {
        status: clean.length > 0 ? 'SUCCESS' : 'FAILED',
        verified: clean.length > 0,
        action: 'read_content',
        heading: headingLabel,
        element: el,
        text: clean,
        wordCount: clean.split(/\s+/).filter(Boolean).length
      };
    }

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

    async submitForm(options = {}) {
      // 1. Observe & 2. Resolve submit button
      const obs = this.observe(options.root || document);
      let targetBtn = options.targetButton || null;
      let targetLabel = '';

      if (!targetBtn) {
        const submitCand = obs.elements.find(e =>
          e.states.visible && !e.states.disabled &&
          e.role === 'button' && e.domNode &&
          ((e.domNode.getAttribute && (e.domNode.getAttribute('type') || '').toLowerCase() === 'submit') ||
           /\b(?:submit|send|apply|register|complete|finish|place\s+order|pay)\b/i.test(e.name))
        );
        if (submitCand) {
          targetBtn = submitCand.domNode;
          targetLabel = submitCand.name;
        }
      }

      if (!targetBtn || !targetBtn.isConnected) {
        return { status: 'FAILED', verified: false, reason: 'submit_button_not_found' };
      }
      if (!targetLabel) {
        targetLabel = sanitizeUntrustedLabel(this.observer.computeAccessibleName(targetBtn), 80) || 'Submit';
      }

      // Mandatory code-level 2-step confirmation gate (never bypassable by prompts or webpage content)
      if (options.userConfirmed !== true || Number(options.confirmedStepCount || 0) < 2) {
        return {
          status: 'CONFIRMATION_REQUIRED',
          verified: false,
          consequential: true,
          requiredSteps: 2,
          targetButton: targetBtn,
          targetLabel,
          reason: 'form_submit_requires_two_step_confirmation'
        };
      }

      // 3. Validate -> 4. Execute -> 5. Re-observe & Verify (no silent retry on consequential submit!)
      const baseline = this.verifier.captureBaseline(targetBtn);
      const execRes = await this.executor.click(targetBtn);
      this.invalidateCache();
      if (!execRes.ok) {
        baseline.stopObserver();
        return { status: 'FAILED', verified: false, reason: execRes.reason, targetLabel };
      }

      const navRes = await this.verifier.verifyNavigation(baseline, targetBtn, Object.assign({ timeoutMs: options.timeoutMs || 1500 }, options));
      this.observe(options.root || document, { force: true });
      return {
        status: 'SUCCESS',
        verified: true,
        action: 'submit_form',
        targetLabel,
        navigated: Boolean(navRes.verified),
        mutations: baseline.baseline.mutationCount,
        url: window.location.href
      };
    }

    async openMenuAndSelect(parentMenuQuery, subItemText, options = {}) {
      // 1. Observe
      this.observe(options.root || document);

      // Fast check: if submenu item is already visible under parentMenuQuery, click directly
      if (typeof parentMenuQuery === 'string' && typeof subItemText === 'string') {
        const directLoc = this.locate(subItemText, { section: parentMenuQuery });
        if (directLoc.status === 'FOUND' && directLoc.target) {
          return this.click(directLoc.target, Object.assign({ isNavigation: true }, options));
        }
      }

      // 2. Resolve expandable parent menu trigger
      let parentEl = null;
      if (typeof parentMenuQuery === 'string') {
        const loc = this.locate(parentMenuQuery);
        if (loc.status === 'AMBIGUOUS') {
          return { status: 'AMBIGUOUS', verified: false, candidates: loc.candidates, prompt: loc.prompt };
        }
        if (loc.status !== 'FOUND' || !loc.target) {
          return { status: 'FAILED', verified: false, reason: 'parent_menu_not_found' };
        }
        parentEl = loc.target;
      } else {
        parentEl = parentMenuQuery;
      }

      if (isConsequentialElement(parentEl) && options.userConfirmed !== true) {
        return { status: 'CONFIRMATION_REQUIRED', verified: false, consequential: true, reason: 'consequential_action_requires_explicit_user_confirmation' };
      }

      // 3. Validate -> 4. Execute -> 5. Re-observe & Verify
      const baseline = this.verifier.captureBaseline(parentEl);
      const res = await this.executor.openMenuAndSelect(parentEl, subItemText);
      this.invalidateCache();
      baseline.stopObserver();
      this.observe(options.root || document, { force: true });

      return {
        status: res.ok ? 'SUCCESS' : 'FAILED',
        verified: Boolean(res.ok),
        action: 'open_menu_and_select',
        parentMenu: typeof parentMenuQuery === 'string' ? parentMenuQuery : '',
        selectedItem: subItemText,
        reason: res.reason
      };
    }

    async switchTab(tabQuery, options = {}) {
      this.observe(options.root || document);
      if (typeof tabQuery === 'string') {
        let loc = this.locate(tabQuery, Object.assign({ role: 'tab' }, options));
        if (loc.status === 'NOT_FOUND') {
          const domTabs = Array.from((options.root || document).querySelectorAll('[role="tab"], .tab, .nav-tab, [data-tab]'));
          const qLow = tabQuery.toLowerCase().replace(/\s+tab$/i, '').trim();
          const hit = domTabs.find(t => ((t.textContent || '').trim().toLowerCase() === qLow || (t.textContent || '').trim().toLowerCase().includes(qLow)));
          if (hit) {
            const clickRes = await this.click(hit, Object.assign({ isTab: true }, options));
            this.observe(options.root || document, { force: true });
            return clickRes;
          }
        }
        if (loc.status === 'AMBIGUOUS') {
          return { status: 'AMBIGUOUS', verified: false, candidates: loc.candidates, prompt: loc.prompt };
        }
        if (loc.status === 'FOUND' && loc.target) {
          const clickRes = await this.click(loc.target, Object.assign({ isTab: true }, options));
          this.observe(options.root || document, { force: true });
          return clickRes;
        }
      }
      const clickRes = await this.click(tabQuery, Object.assign({ isTab: true }, options));
      this.observe(options.root || document, { force: true });
      return clickRes;
    }

    async toggleControl(targetOrQuery, options = {}) {
      // 1. Observe
      const obs = this.observe(options.root || document);
      let targetEl = null;
      let targetItem = null;

      // 2. Resolve
      if (targetOrQuery instanceof Element) {
        targetEl = targetOrQuery;
        targetItem = obs.elements.find(e => e.domNode === targetEl) || null;
      } else if (typeof targetOrQuery === 'string' && targetOrQuery.trim()) {
        const qLow = targetOrQuery.toLowerCase().replace(/[.,!?;:]+$/g, '').trim();
        const qTokens = qLow.split(/\s+/).filter(Boolean);
        let pool = obs.elements.filter(e =>
          e.states.visible && !e.states.disabled &&
          (e.role === 'checkbox' || e.role === 'radio' || e.role === 'switch')
        );
        if (options.section) {
          const secLow = String(options.section).toLowerCase();
          const secPool = pool.filter(e =>
            `${e.parentSection || ''} ${(e.domNode && e.domNode.name) || ''}`.toLowerCase().includes(secLow)
          );
          if (secPool.length > 0) pool = secPool;
        }
        const scored = [];
        for (const item of pool) {
          let score = 0;
          const nLow = (item.name || '').toLowerCase();
          if (nLow === qLow) score += 100;
          else if (nLow.includes(qLow)) score += 75;
          else if (qLow.includes(nLow) && nLow.length >= 3) score += 60;
          const matched = qTokens.filter(t => nLow.includes(t));
          if (qTokens.length > 0) score += (matched.length / qTokens.length) * 35;
          if (options.section && (item.parentSection || '').toLowerCase().includes(String(options.section).toLowerCase())) {
            score += 25;
          }
          if (score >= 45) scored.push({ item, score, element: item.domNode });
        }
        scored.sort((a, b) => b.score - a.score);
        if (scored.length === 0) {
          return { status: 'FAILED', verified: false, reason: 'checkbox_or_radio_not_found' };
        }
        const topScore = scored[0].score;
        const competing = scored.filter(s => (topScore - s.score) <= 10);
        if (competing.length >= 2) {
          return {
            status: 'AMBIGUOUS',
            verified: false,
            candidates: competing.map(c => ({
              id: c.item.id,
              name: c.item.name,
              label: c.item.name,
              role: c.item.role,
              section: c.item.parentSection,
              element: c.element
            })),
            prompt: `Multiple options match "${targetOrQuery}". Which one should I select?`
          };
        }
        targetEl = scored[0].element;
        targetItem = scored[0].item;
      }

      if (!targetEl || !targetEl.isConnected) {
        return { status: 'FAILED', verified: false, reason: 'checkbox_or_radio_not_found' };
      }

      const getChecked = (el) => {
        if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
          return Boolean(el.checked);
        }
        return el.getAttribute('aria-checked') === 'true';
      };

      const beforeChecked = getChecked(targetEl);
      const desired = options.desiredChecked;
      const label = (targetItem && targetItem.name) || sanitizeUntrustedLabel(this.observer.computeAccessibleName(targetEl), 80);
      const role = (targetItem && targetItem.role) || this.observer.computeRole(targetEl);

      if (desired !== undefined && desired !== null && beforeChecked === Boolean(desired)) {
        return {
          status: 'SUCCESS',
          verified: true,
          action: 'toggle_control',
          role,
          targetLabel: label,
          checked: beforeChecked,
          alreadyInState: true
        };
      }

      // 3. Validate -> 4. Execute
      const execRes = await this.executor.click(targetEl);
      this.invalidateCache();
      if (!execRes.ok) {
        return { status: 'FAILED', verified: false, reason: execRes.reason };
      }

      // 5. Re-observe & Verify
      const afterChecked = getChecked(targetEl);
      const verified = role === 'radio' ? afterChecked === true : afterChecked !== beforeChecked;
      this.observe(options.root || document, { force: true });

      return {
        status: verified ? 'SUCCESS' : 'FAILED',
        verified,
        action: 'toggle_control',
        role,
        targetLabel: label,
        checked: afterChecked,
        reason: verified ? '' : 'state_did_not_change'
      };
    }

    scroll(direction = 'down', options = {}) {
      // 1. Observe baseline scroll position
      const dir = String(direction || 'down').toLowerCase();
      const beforeY = window.scrollY;
      const vh = window.innerHeight || 800;
      const maxScroll = Math.max(0, (document.documentElement.scrollHeight || document.body.scrollHeight || 0) - vh);
      const step = options.amount === 'half' ? Math.round(vh * 0.45) : Math.round(vh * 0.8);

      // 2. Execute
      if (dir === 'top') {
        window.scrollTo({ top: 0, behavior: options.behavior || 'instant' });
      } else if (dir === 'bottom') {
        window.scrollTo({ top: maxScroll, behavior: options.behavior || 'instant' });
      } else if (dir === 'up') {
        window.scrollBy({ top: -step, behavior: options.behavior || 'instant' });
      } else {
        window.scrollBy({ top: step, behavior: options.behavior || 'instant' });
      }
      this.invalidateCache();

      // 3. Re-observe & Verify
      const afterY = window.scrollY;
      const atBoundary = (dir === 'up' || dir === 'top') ? beforeY <= 1 : beforeY >= (maxScroll - 2);
      const verified = Math.abs(afterY - beforeY) > 0 || atBoundary || maxScroll === 0;
      this.observe(options.root || document, { force: true });

      return {
        status: verified ? 'SUCCESS' : 'FAILED',
        verified,
        action: 'scroll',
        direction: dir,
        beforeY: Math.round(beforeY),
        afterY: Math.round(afterY),
        atBoundary
      };
    }

    async goToSection(sectionQuery, options = {}) {
      const qRaw = String(sectionQuery || '').replace(/\b(?:section|subsection|heading)\b/gi, '').replace(/[.,!?;:]+$/g, '').trim();
      const qLow = qRaw.toLowerCase();
      if (!qLow) {
        return { status: 'FAILED', verified: false, reason: 'empty_section_query' };
      }

      // 1. Observe & 2. Resolve headings and landmarks
      const root = options.root || document;
      const candidates = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], section[aria-label], nav[aria-label], main[aria-label], article[aria-label]'));
      const scored = [];
      for (const el of candidates) {
        if (!this.observer.isVisible(el)) continue;
        const label = sanitizeUntrustedLabel(
          el.getAttribute('aria-label') || this.observer._getCleanText(el),
          120
        );
        if (!label) continue;
        const lLow = label.toLowerCase();
        let score = 0;
        if (lLow === qLow) score += 100;
        else if (lLow.includes(qLow)) score += 75;
        else if (qLow.includes(lLow) && lLow.length >= 3) score += 60;
        const qToks = qLow.split(/\s+/).filter(Boolean);
        const matched = qToks.filter(t => lLow.includes(t));
        if (qToks.length > 0) score += (matched.length / qToks.length) * 35;
        if (/^H[1-6]$/.test(el.tagName)) score += 10;
        if (score >= 45) scored.push({ el, label, score });
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored.length === 0) {
        return { status: 'FAILED', verified: false, reason: 'section_not_found' };
      }

      const target = scored[0];
      const beforeY = window.scrollY;

      // 3. Validate & 4. Execute scroll
      const rect = target.el.getBoundingClientRect();
      const destY = Math.max(0, window.scrollY + rect.top - 80);
      window.scrollTo({ top: destY, behavior: options.behavior || 'instant' });
      this.invalidateCache();

      // 5. Re-observe & Verify
      const afterRect = target.el.getBoundingClientRect();
      const inViewport = afterRect.top >= -40 && afterRect.top <= (window.innerHeight || 800);
      const verified = inViewport || Math.abs(window.scrollY - beforeY) > 0;
      this.observe(root, { force: true });

      return {
        status: verified ? 'SUCCESS' : 'FAILED',
        verified,
        action: 'go_to_section',
        section: target.label,
        element: target.el,
        beforeY: Math.round(beforeY),
        afterY: Math.round(window.scrollY)
      };
    }

    async executeSearch(query, options = {}) {
      const cleanQ = String(query || '').trim();
      if (!cleanQ) {
        return { status: 'FAILED', verified: false, reason: 'empty_search_query' };
      }

      // 1. Observe
      const obs = this.observe(options.root || document);

      // 2. Resolve
      let targetEl = (options.chosenCandidate && options.chosenCandidate.element) || options.targetElement || null;
      let targetLabel = (options.chosenCandidate && options.chosenCandidate.label) || '';

      if (!targetEl) {
        const searchItems = obs.elements.filter((e) => {
          if (!e.states.visible || e.states.disabled || e.states.sensitive) return false;
          if (e.role === 'searchbox') return true;
          if (e.role === 'textbox' && e.domNode) {
            const meta = [
              e.name || '',
              e.parentSection || '',
              e.domNode.id || '',
              e.domNode.name || '',
              e.domNode.placeholder || '',
              (e.domNode.getAttribute && e.domNode.getAttribute('aria-label')) || ''
            ].join(' ');
            return /\b(?:search|find|query|filter|lookup|explore)\b/i.test(meta);
          }
          return false;
        });

        if (searchItems.length === 0) {
          return { status: 'FAILED', verified: false, reason: 'no_searchbox_found' };
        }

        if (searchItems.length === 1) {
          targetEl = searchItems[0].domNode;
          targetLabel = searchItems[0].name || searchItems[0].parentSection || 'Search';
        } else {
          // Score multiple search fields against scopeHint / fieldHint / rawCommand
          const hint = [options.scopeHint || '', options.fieldHint || '', options.siteHint || '', options.rawCommand || ''].join(' ').toLowerCase();
          const scored = searchItems.map((item) => {
            let score = item.role === 'searchbox' ? 50 : 35;
            const hay = `${item.name} ${item.parentSection} ${item.domNode.id || ''} ${item.domNode.name || ''} ${item.domNode.placeholder || ''}`.toLowerCase();
            const tokens = item.name.toLowerCase().split(/\s+/).filter(t => t.length >= 3 && t !== 'search');
            for (const tok of tokens) {
              if (hint.includes(tok)) score += 35;
            }
            if (options.scopeHint && hay.includes(String(options.scopeHint).toLowerCase())) {
              score += 45;
            }
            return { item, score, element: item.domNode };
          }).sort((a, b) => b.score - a.score);

          const topScore = scored[0].score;
          const competing = scored.filter(s => (topScore - s.score) <= 15);
          if (competing.length >= 2) {
            return {
              status: 'AMBIGUOUS',
              verified: false,
              query: cleanQ,
              candidates: competing.map(c => ({
                id: c.item.id,
                name: c.item.name || c.item.parentSection || 'Search',
                label: c.item.name || c.item.parentSection || 'Search',
                role: c.item.role,
                section: c.item.parentSection,
                element: c.element
              })),
              prompt: `Multiple search fields found (${competing.map(c => c.item.name || c.item.parentSection).join(', ')}). Which one should I use?`
            };
          }
          targetEl = scored[0].element;
          targetLabel = scored[0].item.name || scored[0].item.parentSection || 'Search';
        }
      }

      // 3. Validate -> 4. Execute -> 5. Re-observe & Verify
      const typeRes = await this.type(targetEl, cleanQ, Object.assign({ submit: true, clear: true }, options));
      const postObs = this.observe(options.root || document, { force: true });
      return {
        ...typeRes,
        action: 'search',
        query: cleanQ,
        targetLabel,
        postElementCount: postObs.elementCount
      };
    }
  }

  // Export to global scope for Manifest V3 content script isolation
  global.StagehandObserver = StagehandObserver;
  global.PlaywrightExecutor = PlaywrightExecutor;
  global.StateVerifier = StateVerifier;
  global.VisualFallback = VisualFallback;
  global.BrowserEngine = BrowserEngine;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      StagehandObserver,
      PlaywrightExecutor,
      StateVerifier,
      VisualFallback,
      BrowserEngine
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
