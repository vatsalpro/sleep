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
      let cur = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
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

        // Check enclosing submenu / dropdown parent trigger
        if (cur.matches && cur.matches('[role="menu"], [role="menubar"], ul.submenu, .dropdown-menu, .submenu, .menu-group, [class*="dropdown-menu"]')) {
          const parentItem = cur.closest('li, .nav-item, .dropdown, [role="menuitem"], [role="none"]') || cur.parentElement;
          if (parentItem) {
            const trigger = parentItem.querySelector(':scope > a, :scope > button, :scope > [role="button"], :scope > [role="menuitem"], :scope > summary');
            if (trigger && trigger !== el && !trigger.contains(el)) {
              const tText = this._getCleanText(trigger);
              if (tText) return tText;
            }
          }
        }

        const role = cur.getAttribute('role');
        if (role && ['navigation', 'main', 'region', 'form', 'banner', 'complementary'].includes(role)) {
          return cur.getAttribute('aria-label') || cur.id || role;
        }
        if (['NAV', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'FORM', 'HEADER'].includes(cur.tagName)) {
          if (cur.id) return cur.id;
        }

        cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
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
          if (
            node.id === 'sleepwalker-ui-host' ||
            node.id === 'sleepwalker-host' ||
            node.id === 'sleepwalker-candidate-overlay-root' ||
            node.getAttribute('data-sleepwalker-ui') === '1'
          ) {
            continue;
          }
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
          const isSwUi = Boolean(
            (hit.id && /sleepwalker|^sw-/i.test(hit.id)) ||
            (typeof hit.className === 'string' && /sleepwalker|\bsw-/i.test(hit.className)) ||
            (hit.closest && hit.closest('#sleepwalker-ui-host, #sleepwalker-host, [data-sleepwalker-ui="1"]'))
          );
          if (hitStyle.pointerEvents !== 'none' && !isSwUi) {
            return { ok: false, reason: 'hit_test_obstructed_by_' + hit.tagName.toLowerCase(), obstructedBy: (hit.id ? '#' + hit.id : hit.tagName) + ' ' + (hit.textContent || '').slice(0, 40) };
          }
        }
      }

      return { ok: true };
    }

    async scrollIntoViewIfNeeded(el) {
      if (!el || !el.isConnected) return;
      const rect = el.getBoundingClientRect();
      const inView = (rect.top >= this.options.scrollOffsetTop || (window.scrollY === 0 && rect.top >= 0)) &&
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

      const targetY = Math.max(0, window.scrollY + rect.top - topClearance - 20);
      if (Math.abs(targetY - window.scrollY) < 5) return;
      window.scrollTo({
        top: targetY,
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
      if (typeof el.click === 'function') {
        try { el.click(); } catch (_e) { el.dispatchEvent(new MouseEvent('click', eventInit)); }
      } else {
        el.dispatchEvent(new MouseEvent('click', eventInit));
      }
    }

    async click(el, options = {}) {
      await this.scrollIntoViewIfNeeded(el);
      const gate = await this.validateActionability(el);
      if (!gate.ok) {
        return { ok: false, reason: gate.reason };
      }

      const rect = el.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);

      let mechanism = 'synthetic_events_and_dom_methods';
      if (!options.syntheticOnly && typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_input === 'function') {
        try {
          await window.__sleepwalker_cdp_input({ type: 'mouseClick', x: clientX, y: clientY, button: 'left', clickCount: 1 });
          mechanism = 'cdp_browser_level_input';
          await new Promise((r) => setTimeout(r, this.options.settleDelayMs));
          return { ok: true, clientX, clientY, mechanism };
        } catch (_e) {}
      }

      this.dispatchGestureTrain(el);
      await new Promise((r) => setTimeout(r, this.options.settleDelayMs));
      return { ok: true, clientX, clientY, mechanism };
    }

    async hover(el, options = {}) {
      if (!el || !el.isConnected) return { ok: false, reason: 'element_null' };
      await this.scrollIntoViewIfNeeded(el);

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
        screenX: clientX,
        screenY: clientY,
        buttons: 0
      };

      el.dispatchEvent(new PointerEvent('pointerover', eventInit));
      el.dispatchEvent(new MouseEvent('mouseover', eventInit));
      el.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, eventInit, { bubbles: false })));
      el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, eventInit, { bubbles: false })));
      el.dispatchEvent(new PointerEvent('pointermove', eventInit));
      el.dispatchEvent(new MouseEvent('mousemove', eventInit));

      const parentContainer = el.closest('li, .nav-item, .dropdown, [role="menuitem"], [role="none"]');
      if (parentContainer && parentContainer !== el) {
        parentContainer.dispatchEvent(new PointerEvent('pointerover', eventInit));
        parentContainer.dispatchEvent(new MouseEvent('mouseover', eventInit));
        parentContainer.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, eventInit, { bubbles: false })));
        parentContainer.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, eventInit, { bubbles: false })));
      }

      if (!options.pureHoverOnly) {
        try {
          el.classList.add('is-hovered', 'sw-hovered');
          if (parentContainer) parentContainer.classList.add('is-hovered', 'sw-hovered', 'open');
        } catch (_e) {}
      }

      let mechanism = 'synthetic_dom_events';
      if (!options.syntheticOnly && typeof window !== 'undefined') {
        if (typeof window.__sleepwalker_cdp_input === 'function') {
          try {
            await window.__sleepwalker_cdp_input({ type: 'mouseMoved', x: clientX, y: clientY });
            mechanism = 'cdp_browser_level_input';
          } catch (_e) {}
        } else if (typeof window.__sleepwalker_cdp_hover === 'function') {
          try {
            await window.__sleepwalker_cdp_hover(clientX, clientY);
            mechanism = 'cdp_browser_level_input';
          } catch (_e) {}
        }
      }

      await new Promise(r => setTimeout(r, options.settleDelayMs || this.options.settleDelayMs || 60));
      const nativeHoverMatched = Boolean(
        (el.matches && el.matches(':hover')) ||
        (parentContainer && parentContainer.matches && parentContainer.matches(':hover'))
      );
      return { ok: true, clientX, clientY, mechanism, nativeHoverMatched };
    }

    async keyboardActivate(el, key = 'Enter', options = {}) {
      if (!el || !el.isConnected) return { ok: false, reason: 'element_null' };
      await this.scrollIntoViewIfNeeded(el);
      if (typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }); } catch (_e) {}
      }

      const keyCode = key === 'Enter' ? 13 : (key === 'ArrowDown' ? 40 : (key === ' ' || key === 'Space' ? 32 : (key === 'ArrowRight' ? 39 : 0)));
      const keyInit = {
        key,
        code: key === ' ' ? 'Space' : key,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      };

      el.dispatchEvent(new KeyboardEvent('keydown', keyInit));
      el.dispatchEvent(new KeyboardEvent('keypress', keyInit));
      el.dispatchEvent(new KeyboardEvent('keyup', keyInit));

      await new Promise(r => setTimeout(r, options.settleDelayMs || this.options.settleDelayMs || 60));
      return { ok: true, key };
    }

    async unhover(el, options = {}) {
      if (!el || !el.isConnected) return { ok: false, reason: 'element_null' };
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
        screenX: clientX,
        screenY: clientY,
        buttons: 0
      };

      el.dispatchEvent(new PointerEvent('pointerout', eventInit));
      el.dispatchEvent(new MouseEvent('mouseout', eventInit));
      el.dispatchEvent(new PointerEvent('pointerleave', Object.assign({}, eventInit, { bubbles: false })));
      el.dispatchEvent(new MouseEvent('mouseleave', Object.assign({}, eventInit, { bubbles: false })));

      const parentContainer = el.closest('li, .nav-item, .dropdown, [role="menuitem"], [role="none"]');
      if (parentContainer && parentContainer !== el) {
        parentContainer.dispatchEvent(new PointerEvent('pointerleave', Object.assign({}, eventInit, { bubbles: false })));
        parentContainer.dispatchEvent(new MouseEvent('mouseleave', Object.assign({}, eventInit, { bubbles: false })));
      }

      try {
        el.classList.remove('is-hovered', 'sw-hovered');
        if (parentContainer) parentContainer.classList.remove('is-hovered', 'sw-hovered', 'open');
      } catch (_e) {}

      await new Promise(r => setTimeout(r, options.settleDelayMs || this.options.settleDelayMs || 40));
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
        const allItems = Array.from(root.querySelectorAll('a, button, [role="menuitem"], [role="treeitem"]'));
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

    findVisualSubmenu(triggerEl) {
      if (!triggerEl || !triggerEl.isConnected) return null;
      const tRect = triggerEl.getBoundingClientRect();
      if (tRect.width === 0 && tRect.height === 0) return null;

      const potentialContainers = Array.from(document.querySelectorAll('[role="menu"], ul, ol, .dropdown-menu, .submenu, [class*="dropdown-menu"], [class*="submenu"]'));
      let best = null;
      let minDistance = Infinity;

      potentialContainers.forEach(c => {
        if (c === triggerEl || c.contains(triggerEl) || triggerEl.contains(c)) return;
        const style = window.getComputedStyle(c);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
        const cRect = c.getBoundingClientRect();
        if (cRect.width < 10 || cRect.height < 10) return;

        const isBelow = cRect.top >= (tRect.bottom - 15) && cRect.top <= (tRect.bottom + 80) &&
                        cRect.left <= (tRect.right + 25) && cRect.right >= (tRect.left - 25);
        if (isBelow) {
          const dist = Math.hypot(cRect.left - tRect.left, cRect.top - tRect.bottom);
          if (dist < minDistance) {
            minDistance = dist;
            best = c;
          }
        }
      });

      return best;
    }

    findVisualExpansionControl(containerOrTrigger) {
      if (!containerOrTrigger || !containerOrTrigger.isConnected) return null;
      const iconSelectors = 'button, [role="button"], .caret, .chevron, [class*="chevron"], [class*="arrow"], [class*="caret"], svg, i, span.dropdown-toggle';
      const hits = Array.from(containerOrTrigger.querySelectorAll(iconSelectors));
      if (hits.length > 0) {
        const toggle = hits.find(h => h.getAttribute('aria-expanded') !== null || h.getAttribute('aria-haspopup') !== null || (h.className && String(h.className).includes('dropdown-toggle')));
        return toggle || hits[hits.length - 1];
      }
      return null;
    }

    groundVisualCandidate(container, textOrIcon) {
      if (!container) return null;
      const norm = String(textOrIcon || '').toLowerCase().trim();
      const items = Array.from(container.querySelectorAll('a, button, [role="menuitem"], [role="button"], li, span'));
      for (const item of items) {
        const text = (item.innerText || item.textContent || item.getAttribute('aria-label') || '').toLowerCase().trim();
        if (text && (text === norm || text.includes(norm))) {
          const rect = item.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return item;
          }
        }
      }
      return null;
    }
  }

  // ===========================================================================
  // 5. PageCapabilityMap (Hierarchical Menu & Capability Engine)
  // ===========================================================================
  class PageCapabilityMap {
    constructor(options = {}) {
      this.options = Object.assign({
        maxDepth: 10,
        settleTimeoutMs: 600,
        pollIntervalMs: 50
      }, options);
      this.nodes = [];
      this.landmarks = [];
    }

    getNodeName(el) {
      if (!el) return '';
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const ref = document.getElementById(labelledBy);
        if (ref) return (ref.textContent || '').trim();
      }
      const clone = el.cloneNode(true);
      const toRemove = clone.querySelectorAll('script, style, noscript, [hidden], [aria-hidden="true"], .caret, .chevron, [class*="caret"], [class*="chevron"], [class*="arrow"], svg, [role="menu"]');
      toRemove.forEach(r => r.remove());
      return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    detectSplitButton(container, trigger) {
      if (!container) return null;
      // An expansion trigger's split link must be at the same level, NOT inside a nested submenu container!
      const links = Array.from(container.querySelectorAll('a[href]')).filter(a => {
        return !a.closest('ul, ol, [role="menu"], .dropdown-menu, .submenu, .submenu-hidden, [class*="submenu"]');
      });
      const toggles = Array.from(container.querySelectorAll('button, [role="button"], .dropdown-toggle, [aria-expanded], [aria-haspopup], .caret, .chevron, [data-toggle="dropdown"], [data-bs-toggle="dropdown"]')).filter(t => {
        return !t.closest('ul, ol, [role="menu"], .dropdown-menu, .submenu, .submenu-hidden, [class*="submenu"]');
      });
      if (links.length > 0 && toggles.length > 0) {
        const mainLink = links[0];
        const expansionToggle = toggles.find(t => t !== mainLink) || toggles[0];
        if (mainLink && expansionToggle && mainLink !== expansionToggle) {
          return { mainLink, expansionToggle };
        }
      }
      return null;
    }

    detectInteractionMethod(triggerEl, container, submenuEl) {
      if (!triggerEl) return 'click';

      const split = this.detectSplitButton(container, triggerEl);
      if (split && split.expansionToggle) return 'split';

      const isNavAnchor = triggerEl.tagName === 'A' &&
        triggerEl.hasAttribute('href') &&
        !/^#|^javascript:|^$/i.test(triggerEl.getAttribute('href') || '');

      const hasHover = this.hasHoverBehavior(triggerEl, container, submenuEl);
      if (hasHover) {
        return 'hover';
      }

      if (triggerEl.getAttribute('role') === 'menubar' || (container && container.getAttribute('role') === 'menubar') || triggerEl.hasAttribute('data-keyboard-menu') || triggerEl.getAttribute('role') === 'menuitem') {
        if (typeof triggerEl.onkeydown === 'function' || triggerEl.hasAttribute('onkeydown') || (container && container.hasAttribute('onkeydown')) || triggerEl.hasAttribute('data-keyboard-menu') || (container && container.getAttribute('role') === 'menubar')) {
          return 'keyboard';
        }
      }

      if (isNavAnchor && (submenuEl || triggerEl.getAttribute('aria-haspopup'))) {
        return 'hover';
      }

      return 'click';
    }

    hasHoverBehavior(triggerEl, container, submenuEl) {
      if (!triggerEl) return false;
      if (triggerEl.hasAttribute('data-hover') || (container && container.hasAttribute('data-hover'))) return true;
      if (triggerEl.getAttribute('data-trigger') === 'hover' || (container && container.getAttribute('data-trigger') === 'hover')) return true;

      const classStr = `${triggerEl.className || ''} ${(container && container.className) || ''}`.toLowerCase();
      if (/\b(?:hover-dropdown|hover-menu|dropdown-hover|hoverable|has-hover)\b/.test(classStr)) {
        return true;
      }

      if (typeof triggerEl.onmouseenter === 'function' || typeof triggerEl.onmouseover === 'function' || triggerEl.hasAttribute('onmouseenter') || triggerEl.hasAttribute('onmouseover')) return true;
      if (container && (typeof container.onmouseenter === 'function' || typeof container.onmouseover === 'function' || container.hasAttribute('onmouseenter') || container.hasAttribute('onmouseover'))) return true;

      try {
        const sheets = Array.from(document.styleSheets || []);
        for (const sheet of sheets) {
          try {
            const rules = Array.from(sheet.cssRules || sheet.rules || []);
            for (const rule of rules) {
              if (rule.selectorText && rule.selectorText.includes(':hover')) {
                const m = rule.selectorText.match(/^([^{,]+):hover(?:\s+|>)\s*([^{,]+)$/);
                if (m) {
                  const parentSel = m[1].trim();
                  const childSel = m[2].trim();
                  const matchesParent = (container && container.matches && container.matches(parentSel)) ||
                                        (triggerEl && triggerEl.matches && triggerEl.matches(parentSel));
                  if (matchesParent && submenuEl && submenuEl.matches && submenuEl.matches(childSel)) {
                    return true;
                  }
                }
              }
            }
          } catch (_e) {}
        }
      } catch (_e) {}

      return false;
    }

    findSubmenuContainer(triggerEl, container) {
      if (!triggerEl) return null;

      const controlsId = triggerEl.getAttribute('aria-controls');
      if (controlsId) {
        const el = document.getElementById(controlsId);
        if (el) return el;
      }

      const ownsId = triggerEl.getAttribute('aria-owns');
      if (ownsId) {
        const el = document.getElementById(ownsId);
        if (el) return el;
      }

      if (container) {
        const sub = container.querySelector('ul, ol, [role="menu"], [role="group"], .dropdown-menu, .submenu, .submenu-hidden, [class*="submenu"], [class*="dropdown-menu"]');
        if (sub && sub !== triggerEl && !sub.contains(triggerEl)) {
          return sub;
        }
      }

      let next = triggerEl.nextElementSibling;
      while (next) {
        if (next.matches && next.matches('ul, ol, [role="menu"], [role="group"], .dropdown-menu, .submenu, [class*="dropdown"], [class*="submenu"]')) {
          return next;
        }
        next = next.nextElementSibling;
      }

      if (triggerEl.id) {
        const labelled = document.querySelector(`[aria-labelledby="${triggerEl.id}"]`);
        if (labelled && labelled !== triggerEl) return labelled;
      }

      return null;
    }

    isNodeExpanded(triggerEl, container, submenuEl) {
      if (!triggerEl) return false;
      if (triggerEl.getAttribute('aria-expanded') === 'true') return true;
      if (container && container.getAttribute('aria-expanded') === 'true') return true;

      const cNames = `${triggerEl.className || ''} ${(container && container.className) || ''} ${(submenuEl && submenuEl.className) || ''}`.toLowerCase();
      if (/\b(?:open|show|is-active|active|expanded)\b/.test(cNames)) {
        if (submenuEl) {
          const style = window.getComputedStyle(submenuEl);
          if (style.display !== 'none' && style.visibility !== 'hidden' && submenuEl.offsetWidth > 0) {
            return true;
          }
        } else {
          return true;
        }
      }

      if (submenuEl) {
        try {
          const style = window.getComputedStyle(submenuEl);
          if (style.display !== 'none' && style.visibility !== 'hidden' && submenuEl.offsetWidth > 0 && submenuEl.offsetHeight > 0) {
            return true;
          }
        } catch (_e) {}
      }

      return false;
    }

    build(root = document) {
      this.nodes = [];
      this.landmarks = [];
      let seq = 0;

      // Collect root + accessible open ShadowRoots (excluding Sleepwalker's own UI hosts)
      const queryRoots = [root];
      const collectShadowRoots = (startNode) => {
        if (!startNode) return;
        const stack = [startNode];
        while (stack.length > 0) {
          const n = stack.pop();
          if (!n) continue;
          if (n.nodeType === 1) {
            if (
              n.id === 'sleepwalker-ui-host' ||
              n.id === 'sleepwalker-host' ||
              n.id === 'sleepwalker-candidate-overlay-root' ||
              n.getAttribute('data-sleepwalker-ui') === '1'
            ) {
              continue;
            }
            if (n.shadowRoot && !queryRoots.includes(n.shadowRoot)) {
              queryRoots.push(n.shadowRoot);
              stack.push(n.shadowRoot);
            }
          }
          if (n.children) {
            for (let i = n.children.length - 1; i >= 0; i--) {
              stack.push(n.children[i]);
            }
          }
        }
      };
      collectShadowRoots(root === document ? document.body : root);

      const landmarkEls = [];
      queryRoots.forEach(qr => {
        if (qr && typeof qr.querySelectorAll === 'function') {
          landmarkEls.push(...Array.from(qr.querySelectorAll('nav, [role="navigation"], header, [role="banner"], [role="menubar"]')));
        }
      });
      landmarkEls.forEach(lEl => {
        const name = this.getNodeName(lEl);
        this.landmarks.push({
          element: lEl,
          role: lEl.getAttribute('role') || lEl.tagName.toLowerCase(),
          name,
          inShadowDom: Boolean(lEl.getRootNode && lEl.getRootNode() !== document)
        });
      });

      const parseContainer = (containerEl, parentNode = null, depth = 0) => {
        if (!containerEl || depth > this.options.maxDepth) return [];

        let items = [];
        if (containerEl.matches && containerEl.matches('ul, ol, [role="menubar"], [role="menu"]')) {
          items = Array.from(containerEl.children).filter(c => c.tagName === 'LI' || c.matches('[role="menuitem"], [role="none"], .nav-item, .menu-group'));
          if (items.length === 0) items = Array.from(containerEl.children);
        } else {
          items = Array.from(containerEl.children);
        }

        const nodeList = [];

        items.forEach(itemEl => {
          const trigger = itemEl.matches('a, button, [role="button"], [role="menuitem"], summary')
            ? itemEl
            : itemEl.querySelector(':scope > a, :scope > button, :scope > [role="button"], :scope > [role="menuitem"], :scope > summary') ||
              itemEl.querySelector('a, button, [role="button"], [role="menuitem"], summary') ||
              itemEl;

          if (this.nodes.some(n => n.element === trigger)) return;

          const name = this.getNodeName(trigger) || this.getNodeName(itemEl);
          if (!name && !trigger.hasAttribute('aria-label')) return;

          const submenuEl = this.findSubmenuContainer(trigger, itemEl);
          const split = this.detectSplitButton(itemEl, trigger);
          const hasSubmenu = Boolean(submenuEl || trigger.getAttribute('aria-haspopup') || trigger.hasAttribute('aria-expanded'));
          const interactionMethod = this.detectInteractionMethod(trigger, itemEl, submenuEl);
          const isExpanded = this.isNodeExpanded(trigger, itemEl, submenuEl);

          const rect = (trigger.getBoundingClientRect ? trigger.getBoundingClientRect() : itemEl.getBoundingClientRect());

          const node = {
            id: `menu-node-${++seq}`,
            name: name.toLowerCase().trim(),
            rawName: name,
            element: trigger,
            container: itemEl,
            role: trigger.getAttribute('role') || trigger.tagName.toLowerCase(),
            parent: parentNode,
            depth,
            hasSubmenu,
            submenuElement: submenuEl,
            expansionControl: split ? split.expansionToggle : trigger,
            navigationLink: split ? split.mainLink : (trigger.tagName === 'A' ? trigger : null),
            interactionMethod,
            isExpanded,
            inShadowDom: Boolean(trigger.getRootNode && trigger.getRootNode() !== document),
            boundingBox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            },
            children: []
          };

          if (submenuEl && (isExpanded || depth < this.options.maxDepth)) {
            node.children = parseContainer(submenuEl, node, depth + 1);
          }

          nodeList.push(node);
          this.nodes.push(node);
        });

        return nodeList;
      };

      const allContainers = [];
      queryRoots.forEach(qr => {
        if (qr && typeof qr.querySelectorAll === 'function') {
          allContainers.push(...Array.from(qr.querySelectorAll('nav, [role="navigation"], [role="menubar"], [role="menu"], .navbar, .menu-group')));
        }
      });
      const menuContainers = allContainers.filter(mc => !allContainers.some(other => other !== mc && other.contains(mc)));
      if (menuContainers.length > 0) {
        menuContainers.forEach(mc => {
          parseContainer(mc, null, 0);
        });
      } else {
        parseContainer(root === document ? document.body : root, null, 0);
      }

      this.url = (typeof window !== 'undefined' && window.location) ? window.location.href : '';
      this.title = (root && root.title) || (typeof document !== 'undefined' ? document.title : '');
      this.timestamp = Date.now();
      this.buildVersion = (this.buildVersion || 0) + 1;
      this.shadowRootCount = Math.max(0, queryRoots.length - 1);

      return this.nodes;
    }
  }

  // ===========================================================================
  // 5.5 BrowserInputController (Mode C - Computer-Use Browser Operator)
  // Provides clean, realistic mouse/pointer and keyboard automation abstractions
  // ===========================================================================
  class BrowserInputController {
    constructor(engine = null, options = {}) {
      this.engine = engine;
      this.executor = (engine && engine.executor) || new PlaywrightExecutor(options);
      this.options = Object.assign({
        pointerSettleMs: 50,
        keyDelayMs: 30,
        moveSteps: 6,
        stepDelayMs: 15
      }, options);
      this.currentPointer = (typeof window !== 'undefined' && window.__sleepwalker_pointer)
        ? { x: window.__sleepwalker_pointer.x, y: window.__sleepwalker_pointer.y }
        : { x: 0, y: 0 };
      this.operationHistory = [];
      this.interrupted = false;
    }

    interrupt() {
      this.interrupted = true;
      this._hidePointerIndicator();
    }

    resetInterrupt() {
      this.interrupted = false;
    }

    _ensurePointerIndicator() {
      if (typeof document === 'undefined') return null;
      let indicator = document.getElementById('sleepwalker-pointer-indicator');
      if (!indicator && document.body) {
        indicator = document.createElement('div');
        indicator.id = 'sleepwalker-pointer-indicator';
        indicator.className = 'sleepwalker-pointer-cursor';
        indicator.setAttribute('aria-hidden', 'true');
        indicator.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none !important;z-index:2147483647;display:none;will-change:left,top,transform;transform:translate(-2px,-2px);';
        indicator.innerHTML = `
          <svg viewBox="0 0 24 24" class="sw-pointer-svg" width="28" height="28" style="pointer-events:none;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.45));">
            <path d="M4 2 L20 10 L12 13 L8 21 Z" fill="#ffd700" stroke="#1b1714" stroke-width="1.8" stroke-linejoin="round"/>
          </svg>
          <span class="sw-pointer-pulse" style="pointer-events:none;"></span>
          <span class="sw-pointer-label" style="pointer-events:none;display:none;"></span>
        `;
        document.documentElement.appendChild(indicator);
      }
      return indicator;
    }

    _updatePointerIndicator(x, y, label = null, clicking = false) {
      if (typeof document === 'undefined') return;
      const indicator = this._ensurePointerIndicator();
      if (!indicator) return;
      indicator.style.display = 'block';
      indicator.style.left = `${Math.round(x)}px`;
      indicator.style.top = `${Math.round(y)}px`;
      if (clicking) {
        indicator.classList.add('sw-pointer-clicking');
      } else {
        indicator.classList.remove('sw-pointer-clicking');
      }
      const lbl = indicator.querySelector('.sw-pointer-label');
      if (lbl) {
        if (label) {
          lbl.textContent = label;
          lbl.style.display = 'inline-block';
        } else {
          lbl.style.display = 'none';
        }
      }
    }

    _hidePointerIndicator() {
      if (typeof document === 'undefined') return;
      const indicator = document.getElementById('sleepwalker-pointer-indicator');
      if (indicator) {
        indicator.style.display = 'none';
        indicator.classList.remove('sw-pointer-clicking');
      }
    }

    inspectMechanisms() {
      const hasCdpInput = Boolean(typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_input === 'function');
      const hasCdpHover = Boolean(typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_hover === 'function');
      return {
        cdpInputBridgeActive: hasCdpInput,
        cdpHoverBridgeActive: hasCdpHover,
        operations: {
          movePointer: {
            contentScriptDefault: 'DOM getBoundingClientRect + scrollIntoViewIfNeeded + synthetic PointerEvent("pointermove") & MouseEvent("mousemove")',
            cdpWhenAttached: 'CDP Input.dispatchMouseEvent({ type: "mouseMoved", x, y }) with coordinate-aligned visual pointer indicator',
            activeMode: hasCdpInput ? 'cdp_browser_level_input' : 'synthetic_dom_events'
          },
          hover: {
            contentScriptDefault: 'DOM scrollIntoViewIfNeeded + synthetic pointerover/mouseover/pointerenter/mouseenter/pointermove/mousemove + CSS class fallback (.is-hovered, .sw-hovered, .open)',
            cdpWhenAttached: 'CDP Input.dispatchMouseEvent({ type: "mouseMoved", x, y }) triggering native CSS :hover pseudo-class',
            activeMode: (hasCdpInput || hasCdpHover) ? 'cdp_browser_level_input' : 'synthetic_dom_events'
          },
          click: {
            contentScriptDefault: 'DOM scrollIntoViewIfNeeded + validateActionability + synthetic pointerover/mouseover/pointerdown/mousedown/pointerup/mouseup + DOM el.focus() & el.click()',
            cdpWhenAttached: 'CDP Input.dispatchMouseEvent(mouseMoved + mousePressed + mouseReleased) with visual click pulse',
            activeMode: hasCdpInput ? 'cdp_browser_level_input' : 'synthetic_events_and_dom_methods'
          },
          doubleClick: {
            contentScriptDefault: 'dispatchGestureTrain + synthetic pointerdown/mousedown/pointerup/mouseup/click/dblclick (detail=2)',
            cdpWhenAttached: 'CDP Input.dispatchMouseEvent (clickCount=1, clickCount=2) + synthetic dblclick',
            activeMode: hasCdpInput ? 'cdp_browser_level_input' : 'synthetic_events_and_dom_methods'
          },
          rightClick: {
            contentScriptDefault: 'Synthetic pointerdown/mousedown/pointerup/mouseup/contextmenu (button=2, buttons=2)',
            cdpWhenAttached: 'CDP Input.dispatchMouseEvent (button="right") + synthetic contextmenu',
            activeMode: hasCdpInput ? 'cdp_browser_level_input' : 'synthetic_dom_events'
          },
          focus: {
            contentScriptDefault: 'DOM el.focus()',
            cdpWhenAttached: 'DOM el.focus()',
            activeMode: 'dom_method'
          },
          typeText: {
            contentScriptDefault: 'DOM el.focus() + el.value assignment + synthetic FocusEvent("focus"), InputEvent("beforeinput"), InputEvent("input"), Event("change"), form.requestSubmit()',
            cdpWhenAttached: 'DOM focus + CDP Input.dispatchKeyEvent (char-by-char) / Input.insertText + DOM value verification',
            activeMode: hasCdpInput ? 'cdp_browser_level_input' : 'synthetic_events_and_dom_methods'
          },
          pressKey: {
            contentScriptDefault: 'Synthetic KeyboardEvent("keydown"), KeyboardEvent("keypress"), KeyboardEvent("keyup") on document.activeElement',
            cdpWhenAttached: 'CDP Input.dispatchKeyEvent({ type: "keyDown" / "keyUp", key, windowsVirtualKeyCode })',
            activeMode: hasCdpInput ? 'cdp_browser_level_input' : 'synthetic_dom_events'
          },
          keyboardNavigate: {
            contentScriptDefault: 'DOM el.focus() + synthetic KeyboardEvents for arrow keys & Enter',
            cdpWhenAttached: 'DOM el.focus() + CDP Input.dispatchKeyEvent for arrow keys & Enter with accessible feedback',
            activeMode: hasCdpInput ? 'cdp_browser_level_input' : 'accessible_keyboard_navigation'
          },
          scroll: {
            contentScriptDefault: 'DOM window.scrollBy / element.scrollBy ({ behavior: "instant" })',
            cdpWhenAttached: 'CDP Input.dispatchMouseEvent({ type: "mouseWheel", deltaX, deltaY }) or DOM scrollBy',
            activeMode: hasCdpInput ? 'cdp_browser_level_input' : 'dom_method'
          }
        }
      };
    }

    _recordOp(op, details) {
      const entry = Object.assign({ op, timestamp: Date.now() }, details);
      this.operationHistory.push(entry);
      if (this.operationHistory.length > 50) this.operationHistory.shift();
      return entry;
    }

    _resolveTargetElement(target) {
      if (!target) return null;
      if (typeof target === 'object' && target.nodeType === 1) return target;
      if (typeof target === 'string') {
        try {
          const el = document.querySelector(target);
          if (el) return el;
        } catch (_e) {}
        if (this.engine && typeof this.engine.locate === 'function') {
          const loc = this.engine.locate(target);
          if (loc && loc.target) {
            return loc.target;
          }
          if (loc && loc.candidate && loc.candidate.domNode) {
            return loc.candidate.domNode;
          }
        }
      }
      return null;
    }

    async movePointer(target, options = {}) {
      if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
      let targetX = 0, targetY = 0;
      if (typeof target === 'object' && typeof target.x === 'number' && typeof target.y === 'number') {
        targetX = target.x;
        targetY = target.y;
      } else {
        const el = this._resolveTargetElement(target);
        if (!el) return { ok: false, reason: 'target_not_found' };
        await this.executor.scrollIntoViewIfNeeded(el);
        const rect = el.getBoundingClientRect();
        targetX = Math.round(rect.left + rect.width / 2);
        targetY = Math.round(rect.top + rect.height / 2);
      }

      const startX = (this.currentPointer && typeof this.currentPointer.x === 'number') ? this.currentPointer.x : targetX;
      const startY = (this.currentPointer && typeof this.currentPointer.y === 'number') ? this.currentPointer.y : targetY;
      const hasCdp = !options.syntheticOnly && typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_input === 'function';
      let mechanism = hasCdp ? 'cdp_browser_level_input' : 'synthetic_dom_events';
      const steps = hasCdp
        ? Math.max(1, Math.min(options.steps || this.options.moveSteps || 6, 20))
        : Math.max(1, Math.min(options.steps || 1, 2));
      const stepDelayMs = hasCdp
        ? Math.max(2, options.stepDelayMs || this.options.stepDelayMs || 15)
        : 0;

      for (let i = 1; i <= steps; i++) {
        if (this.interrupted) {
          this._hidePointerIndicator();
          return { ok: false, reason: 'interrupted', cancelled: true };
        }
        const progress = i / steps;
        const ease = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
        const curX = Math.round(startX + (targetX - startX) * ease);
        const curY = Math.round(startY + (targetY - startY) * ease);

        this.currentPointer = { x: curX, y: curY };
        if (typeof window !== 'undefined') window.__sleepwalker_pointer = this.currentPointer;
        this._updatePointerIndicator(curX, curY, options.label || null, false);

        if (hasCdp) {
          try {
            await window.__sleepwalker_cdp_input({ type: 'mouseMoved', x: curX, y: curY });
          } catch (_e) {}
        } else {
          const eventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: curX,
            clientY: curY,
            screenX: curX,
            screenY: curY,
            buttons: 0
          };
          const hit = (typeof document !== 'undefined' && typeof document.elementFromPoint === 'function')
            ? document.elementFromPoint(curX, curY) || document.body
            : null;
          if (hit) {
            hit.dispatchEvent(new PointerEvent('pointermove', eventInit));
            hit.dispatchEvent(new MouseEvent('mousemove', eventInit));
          }
        }

        if (stepDelayMs > 0 && i < steps) {
          await new Promise((r) => setTimeout(r, stepDelayMs));
        }
      }

      if (options.settleMs) await new Promise((r) => setTimeout(r, options.settleMs));
      this._recordOp('movePointer', { x: targetX, y: targetY, mechanism });
      return { ok: true, x: targetX, y: targetY, mechanism };
    }

    async hover(target, options = {}) {
      if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
      const el = this._resolveTargetElement(target);
      if (!el) return { ok: false, reason: 'target_not_found' };

      await this.movePointer(el, { steps: options.steps || 4, label: options.label || 'Hovering...' });
      const res = await this.executor.hover(el, options);
      if (res && res.ok) {
        this.currentPointer = { x: res.clientX, y: res.clientY };
        if (typeof window !== 'undefined') window.__sleepwalker_pointer = this.currentPointer;
        this._updatePointerIndicator(res.clientX, res.clientY, options.label || 'Hovering...', false);
      }
      this._recordOp('hover', {
        x: res && res.clientX,
        y: res && res.clientY,
        mechanism: (res && res.mechanism) || 'synthetic_dom_events',
        nativeHoverMatched: Boolean(res && res.nativeHoverMatched)
      });
      return res;
    }

    async click(target, options = {}) {
      if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
      const el = this._resolveTargetElement(target);
      if (!el) return { ok: false, reason: 'target_not_found' };
      await this.executor.scrollIntoViewIfNeeded(el);
      const gate = await this.executor.validateActionability(el);
      if (!gate.ok) return { ok: false, reason: gate.reason };

      const rect = el.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);
      this.currentPointer = { x: clientX, y: clientY };
      if (typeof window !== 'undefined') window.__sleepwalker_pointer = this.currentPointer;
      this._updatePointerIndicator(clientX, clientY, options.label || 'Clicking...', true);

      let mechanism = 'synthetic_events_and_dom_methods';
      const hasCdp = !options.syntheticOnly && typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_input === 'function';

      if (hasCdp) {
        try {
          await window.__sleepwalker_cdp_input({ type: 'mouseClick', x: clientX, y: clientY, button: 'left', clickCount: 1 });
          mechanism = 'cdp_browser_level_input';
        } catch (_e) {}
      }

      if (mechanism !== 'cdp_browser_level_input') {
        this.executor.dispatchGestureTrain(el);
      }

      await new Promise((r) => setTimeout(r, this.executor.options.settleDelayMs || 60));
      this._updatePointerIndicator(clientX, clientY, null, false);
      this._recordOp('click', { x: clientX, y: clientY, mechanism });
      return { ok: true, clientX, clientY, mechanism };
    }

    async doubleClick(target, options = {}) {
      if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
      const el = this._resolveTargetElement(target);
      if (!el) return { ok: false, reason: 'target_not_found' };
      await this.executor.scrollIntoViewIfNeeded(el);
      const gate = await this.executor.validateActionability(el);
      if (!gate.ok) return { ok: false, reason: gate.reason };

      const moveRes = await this.movePointer(el, { steps: 5, label: 'Double Clicking...' });
      if (!moveRes.ok) return moveRes;

      const { x: clientX, y: clientY } = this.currentPointer;
      this._updatePointerIndicator(clientX, clientY, 'Double Clicking...', true);

      let mechanism = 'synthetic_events_and_dom_methods';
      const hasCdp = !options.syntheticOnly && typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_input === 'function';

      if (hasCdp) {
        try {
          await window.__sleepwalker_cdp_input({ type: 'mouseDoubleClick', x: clientX, y: clientY, button: 'left' });
          mechanism = 'cdp_browser_level_input';
        } catch (_e) {}
      }

      if (mechanism !== 'cdp_browser_level_input') {
        const eventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX,
          clientY,
          detail: 1,
          button: 0,
          buttons: 1
        };
        this.executor.dispatchGestureTrain(el);
        const dblInit = Object.assign({}, eventInit, { detail: 2 });
        el.dispatchEvent(new PointerEvent('pointerdown', dblInit));
        el.dispatchEvent(new MouseEvent('mousedown', dblInit));
        el.dispatchEvent(new PointerEvent('pointerup', dblInit));
        el.dispatchEvent(new MouseEvent('mouseup', dblInit));
        el.dispatchEvent(new MouseEvent('click', dblInit));
        el.dispatchEvent(new MouseEvent('dblclick', dblInit));
      }

      await new Promise((r) => setTimeout(r, this.executor.options.settleDelayMs || 60));
      this._updatePointerIndicator(clientX, clientY, null, false);
      this._recordOp('doubleClick', { x: clientX, y: clientY, mechanism });
      return { ok: true, clientX, clientY, mechanism };
    }

    async rightClick(target, options = {}) {
      if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
      const el = this._resolveTargetElement(target);
      if (!el) return { ok: false, reason: 'target_not_found' };
      await this.executor.scrollIntoViewIfNeeded(el);
      const gate = await this.executor.validateActionability(el);
      if (!gate.ok) return { ok: false, reason: gate.reason };

      const moveRes = await this.movePointer(el, { steps: 5, label: 'Right Clicking...' });
      if (!moveRes.ok) return moveRes;

      const { x: clientX, y: clientY } = this.currentPointer;
      this._updatePointerIndicator(clientX, clientY, 'Right Clicking...', true);

      let mechanism = 'synthetic_dom_events';
      const hasCdp = !options.syntheticOnly && typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_input === 'function';

      if (hasCdp) {
        try {
          await window.__sleepwalker_cdp_input({ type: 'mouseClick', x: clientX, y: clientY, button: 'right', clickCount: 1 });
          mechanism = 'cdp_browser_level_input';
        } catch (_e) {}
      }

      if (mechanism !== 'cdp_browser_level_input') {
        const eventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX,
          clientY,
          button: 2,
          buttons: 2
        };
        el.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        el.dispatchEvent(new MouseEvent('mousedown', eventInit));
        el.dispatchEvent(new PointerEvent('pointerup', eventInit));
        el.dispatchEvent(new MouseEvent('mouseup', eventInit));
        el.dispatchEvent(new MouseEvent('contextmenu', eventInit));
      }

      await new Promise((r) => setTimeout(r, this.executor.options.settleDelayMs || 60));
      this._updatePointerIndicator(clientX, clientY, null, false);
      this._recordOp('rightClick', { x: clientX, y: clientY, mechanism });
      return { ok: true, clientX, clientY, mechanism };
    }

    async focus(target) {
      const el = this._resolveTargetElement(target);
      if (!el) return { ok: false, reason: 'target_not_found' };
      if (typeof el.focus === 'function') {
        el.focus();
        this._recordOp('focus', { mechanism: 'dom_method' });
        return { ok: true, mechanism: 'dom_method' };
      }
      return { ok: false, reason: 'focus_not_supported' };
    }

    async typeText(target, text, options = {}) {
      if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
      const el = this._resolveTargetElement(target);
      if (!el) return { ok: false, reason: 'target_not_found' };
      await this.executor.scrollIntoViewIfNeeded(el);

      const str = String(text != null ? text : '');
      const hasCdp = !options.syntheticOnly && typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_input === 'function';
      let mechanism = 'synthetic_events_and_dom_methods';

      if (hasCdp) {
        const clickRes = await this.click(el, { steps: 4, label: 'Focusing input...' });
        if (!clickRes.ok && clickRes.cancelled) return clickRes;
        if (typeof el.focus === 'function') el.focus();

        try {
          const keyDelay = Math.max(10, options.keyDelayMs || this.options.keyDelayMs || 25);
          for (const char of str) {
            if (this.interrupted) {
              this._hidePointerIndicator();
              return { ok: false, reason: 'interrupted', cancelled: true };
            }
            this._updatePointerIndicator(this.currentPointer.x, this.currentPointer.y, `Typing: ${char}`);
            await window.__sleepwalker_cdp_input({ type: 'keyPress', key: char });
            await new Promise((r) => setTimeout(r, keyDelay));
          }
          mechanism = 'cdp_browser_level_input';
        } catch (_e) {}

        if (el.value !== undefined && !el.value.includes(str)) {
          try {
            el.value = '';
            await window.__sleepwalker_cdp_input({ type: 'insertText', text: str });
          } catch (_e) {}
        }
      }

      if (el.value !== undefined && !el.value.includes(str)) {
        await this.executor.type(el, str, options);
      } else if (!hasCdp) {
        await this.executor.type(el, str, options);
      }

      this._updatePointerIndicator(this.currentPointer.x, this.currentPointer.y, null, false);
      this._recordOp('typeText', { textLength: str.length, mechanism, ok: true });
      return { ok: true, text: str, mechanism };
    }

    async pressKey(key, options = {}) {
      if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
      const activeEl = (typeof document !== 'undefined' && document.activeElement && document.activeElement !== document.body)
        ? document.activeElement
        : (typeof document !== 'undefined' ? document.body : null);
      if (!activeEl) return { ok: false, reason: 'no_active_element' };

      let mechanism = 'synthetic_dom_events';
      const hasCdp = !options.syntheticOnly && typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_input === 'function';

      if (hasCdp) {
        try {
          this._updatePointerIndicator(this.currentPointer.x, this.currentPointer.y, `Key: ${key}`);
          await window.__sleepwalker_cdp_input({ type: 'keyPress', key });
          mechanism = 'cdp_browser_level_input';
          await new Promise((r) => setTimeout(r, 30));
          this._updatePointerIndicator(this.currentPointer.x, this.currentPointer.y, null, false);
        } catch (_e) {}
      }

      if (mechanism !== 'cdp_browser_level_input') {
        const keyInit = {
          key,
          code: key,
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          ctrlKey: Boolean(options.ctrlKey || options.ctrl),
          altKey: Boolean(options.altKey || options.alt),
          shiftKey: Boolean(options.shiftKey || options.shift),
          metaKey: Boolean(options.metaKey || options.meta)
        };
        activeEl.dispatchEvent(new KeyboardEvent('keydown', keyInit));
        activeEl.dispatchEvent(new KeyboardEvent('keypress', keyInit));
        activeEl.dispatchEvent(new KeyboardEvent('keyup', keyInit));
      }

      this._recordOp('pressKey', { key, mechanism });
      return { ok: true, key, mechanism };
    }

    async keyboardNavigate(target, keys = ['ArrowDown', 'Enter'], options = {}) {
      if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
      const el = this._resolveTargetElement(target);
      if (!el) return { ok: false, reason: 'target_not_found' };
      await this.executor.scrollIntoViewIfNeeded(el);
      if (typeof el.focus === 'function') el.focus();

      let lastMech = 'accessible_keyboard_navigation';
      for (const k of keys) {
        if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
        const res = await this.pressKey(k, options);
        if (res && res.mechanism === 'cdp_browser_level_input') {
          lastMech = 'cdp_browser_level_input';
        }
        await new Promise((r) => setTimeout(r, options.keyDelayMs || 50));
      }
      this._recordOp('keyboardNavigate', { keys, mechanism: lastMech });
      return { ok: true, keys, mechanism: lastMech };
    }

    async scroll(direction = 'down', options = {}) {
      if (this.interrupted) return { ok: false, reason: 'interrupted', cancelled: true };
      const dy = direction === 'up' ? -400 : 400;
      let mechanism = 'dom_method';
      const hasCdp = !options.syntheticOnly && typeof window !== 'undefined' && typeof window.__sleepwalker_cdp_input === 'function';

      if (hasCdp) {
        try {
          const { x, y } = this.currentPointer;
          await window.__sleepwalker_cdp_input({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
          mechanism = 'cdp_browser_level_input';
        } catch (_e) {}
      }

      if (mechanism !== 'cdp_browser_level_input') {
        if (this.engine && typeof this.engine.scroll === 'function') {
          const res = this.engine.scroll(direction, options);
          this._recordOp('scroll', { dir: direction, mechanism });
          return Object.assign({}, res, { mechanism });
        }
        if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
          window.scrollBy({ top: dy, behavior: 'instant' });
        }
      }

      this._recordOp('scroll', { dir: direction, mechanism });
      return { ok: true, dir: direction, mechanism };
    }
  }

  // ===========================================================================
  // 6. BrowserEngine (Unified Facade)
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
      this.capabilityMap = new PageCapabilityMap(options.capabilityMap);
      this.inputController = new BrowserInputController(this, options.inputController);
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
      if (this.capabilityMap && typeof this.capabilityMap.build === 'function') {
        this.capabilityMap.build(root);
        this.capabilityMap.actionableCount = result.elementCount;
        if (opts.navigationIdentity) this.capabilityMap.navigationIdentity = opts.navigationIdentity;
        if (opts.tabId) this.capabilityMap.tabId = opts.tabId;
      }
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

        if (options.isInput && (item.role === 'textbox' || item.role === 'searchbox' || (item.role === 'combobox' && item.tag === 'INPUT'))) {
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
        const qTrim = targetOrQuery.trim();
        if (/^[#.\[]/.test(qTrim)) {
          try {
            targetEl = (options.root || document).querySelector(qTrim);
          } catch (_e) {}
        }
        if (!targetEl) {
          const located = this.locate(targetOrQuery, options);
          if (located.status === 'AMBIGUOUS') {
            return { status: 'AMBIGUOUS', verified: false, candidates: located.candidates, prompt: located.prompt };
          }
          if (located.status !== 'FOUND' || !located.target) {
            return { status: 'FAILED', verified: false, reason: 'element_not_found', query: targetOrQuery };
          }
          targetEl = located.target;
        }
      } else if (targetOrQuery instanceof Element) {
        targetEl = targetOrQuery;
        if (!targetEl.isConnected) {
          this.invalidateCache();
          const staleId = targetEl.id;
          const staleLabel = this.observer.computeAccessibleName(targetEl) || (targetEl.textContent || '').trim();
          const root = options.root || document;
          if (staleId && root.getElementById && root.getElementById(staleId)) {
            targetEl = root.getElementById(staleId);
          } else if (staleLabel) {
            const reloc = this.locate(staleLabel, Object.assign({}, options, { force: true }));
            if (reloc.status === 'FOUND' && reloc.target && reloc.target.isConnected) {
              targetEl = reloc.target;
            }
          }
        }
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

      if (this.inputController && typeof this.inputController.resetInterrupt === 'function') {
        this.inputController.resetInterrupt();
      }
      const baseline = this.verifier.captureBaseline(targetEl);

      const execResult = (this.inputController && typeof this.inputController.click === 'function' && !options.syntheticOnly)
        ? await this.inputController.click(targetEl, options)
        : await this.executor.click(targetEl, options);
      this.invalidateCache();
      if (!execResult.ok) {
        baseline.stopObserver();
        return { status: 'FAILED', verified: false, reason: execResult.reason };
      }

      let res;
      if (options.isNavigation || targetEl.tagName === 'A' || targetEl.closest('a')) {
        res = await this.verifier.verifyNavigation(baseline, targetEl, options);
      } else if (options.isTab || targetEl.getAttribute('role') === 'tab') {
        res = await this.verifier.verifyTabSwitch(baseline, targetEl, options);
      } else if (options.isMenu || targetEl.hasAttribute('aria-expanded')) {
        res = await this.verifier.verifyMenuExpanded(baseline, targetEl, options);
      } else {
        baseline.stopObserver();
        res = {
          status: 'SUCCESS',
          verified: true,
          action: 'click',
          targetTag: targetEl.tagName,
          mutations: baseline.baseline.mutationCount
        };
      }
      if (execResult && execResult.mechanism) {
        res.mechanism = execResult.mechanism;
      }
      return res;
    }

    async type(targetOrQuery, text, options = {}) {
      let targetEl = null;

      if (typeof targetOrQuery === 'string' && SENSITIVE_FIELD_RE.test(targetOrQuery) && !options.allowPassword) {
        return { status: 'SENSITIVE_SKIPPED', verified: false, reason: 'sensitive_field_privacy_gate' };
      }

      if (typeof targetOrQuery === 'string' && targetOrQuery.trim()) {
        const qTrim = targetOrQuery.trim();
        if (/^[#.\[]/.test(qTrim)) {
          try {
            targetEl = (options.root || document).querySelector(qTrim);
          } catch (_e) {}
        }
        if (!targetEl) {
          const located = this.locate(targetOrQuery, Object.assign({ isInput: true }, options));
          if (located.status === 'AMBIGUOUS') {
            return { status: 'AMBIGUOUS', verified: false, candidates: located.candidates, prompt: located.prompt };
          }
          if (located.status !== 'FOUND' || !located.target) {
            return { status: 'FAILED', verified: false, reason: 'input_field_not_found', query: targetOrQuery };
          }
          targetEl = located.target;
        }
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

      if (this.inputController && typeof this.inputController.resetInterrupt === 'function') {
        this.inputController.resetInterrupt();
      }
      const baseline = this.verifier.captureBaseline(targetEl);
      const execResult = (this.inputController && typeof this.inputController.typeText === 'function' && !options.syntheticOnly)
        ? await this.inputController.typeText(targetEl, text, options)
        : await this.executor.type(targetEl, text, options);
      this.invalidateCache();
      if (!execResult.ok) {
        baseline.stopObserver();
        return { status: 'FAILED', verified: false, reason: execResult.reason };
      }

      if (options.submit) {
        if (this.inputController && execResult.mechanism === 'cdp_browser_level_input') {
          await this.inputController.pressKey('Enter');
        }
        const navRes = await this.verifier.verifyNavigation(baseline, targetEl, Object.assign({ timeoutMs: options.timeoutMs || 1800 }, options));
        if (navRes.verified || String(targetEl.value || '') === String(text || '')) {
          return {
            status: 'SUCCESS',
            verified: true,
            action: 'type_and_submit',
            value: String(targetEl.value || text || ''),
            navigated: Boolean(navRes.verified),
            url: window.location.href,
            mechanism: execResult.mechanism || 'synthetic_events_and_dom_methods',
            details: navRes.verified ? navRes.details : 'Input value committed and submitted.'
          };
        }
        if (execResult.mechanism) navRes.mechanism = execResult.mechanism;
        return navRes;
      }

      const verifyRes = await this.verifier.verifyInputFill(baseline, targetEl, text);
      this.observe(options.root || document, { force: true });
      return {
        ...verifyRes,
        mechanism: execResult.mechanism || 'synthetic_events_and_dom_methods',
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
        const submitCands = obs.elements.filter(e =>
          e.states.visible && !e.states.disabled &&
          e.role === 'button' && e.domNode &&
          !/^search$/i.test((e.name || '').trim()) &&
          ((e.domNode.getAttribute && (e.domNode.getAttribute('type') || '').toLowerCase() === 'submit') ||
           /\b(?:submit|send|apply|register|complete|finish|place\s+order|pay)\b/i.test(e.name))
        );
        const explicitSubmit = submitCands.find(e => /\b(?:submit|apply|send|register|complete|finish)\b/i.test(e.name)) || submitCands[0];
        if (explicitSubmit) {
          targetBtn = explicitSubmit.domNode;
          targetLabel = explicitSubmit.name;
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

    normalizeMenuPath(input) {
      if (Array.isArray(input)) {
        const segments = [];
        for (const item of input) {
          const s = String(item || '').trim();
          if (!s) continue;
          if (s.includes('>') || s.includes('->') || s.includes('/')) {
            segments.push(...this.normalizeMenuPath(s));
          } else {
            segments.push(s);
          }
        }
        return segments;
      }
      const str = String(input || '').trim();
      if (!str) return [];

      const underMatch = str.match(/^(?:(?:please|can\s+you|could\s+you)\s+)?(?:open|click|select|choose|go\s+to)\s+(?:the\s+)?(.+?)\s+(?:under|inside|below|in\s+the)\s+(.+?)(?:\s+(?:menu|section|navigation))?[.?!]*$/i);
      if (underMatch) {
        const child = underMatch[1].trim();
        const parentPart = underMatch[2].trim();
        const parentSegments = this.normalizeMenuPath(parentPart);
        return parentSegments.concat([child]);
      }

      const underFirstMatch = str.match(/^(?:under|inside|in\s+the)\s+(.+?),\s*(?:open|click|select|choose|go\s+to)\s+(.+?)[.?!]*$/i);
      if (underFirstMatch) {
        const parentSegments = this.normalizeMenuPath(underFirstMatch[1].trim());
        return parentSegments.concat([underFirstMatch[2].trim()]);
      }

      if (str.includes('>') || str.includes('->') || str.includes('/')) {
        return str.split(/(?:\s*->\s*|\s*>\s*|\s*\/\s*)/).map(s => s.trim()).filter(Boolean);
      }

      const andMatch = str.match(/^(?:(?:please\s+)?(?:open|expand|click)\s+)?(.+?)\s+and\s+(?:then\s+)?(?:select|choose|click|open)\s+(.+?)[.?!]*$/i);
      if (andMatch) {
        return [andMatch[1].trim(), andMatch[2].trim()];
      }

      return [str];
    }

    findMenuCandidates(stepQuery, parentNode, currentContainer, options = {}) {
      const normQuery = String(stepQuery || '').toLowerCase().trim();
      const queryTokens = normQuery.split(/\s+/).filter(Boolean);
      if (!normQuery) return [];

      const candidates = [];

      if (!parentNode) {
        if (options.directParentElement && options.directParentElement.isConnected) {
          const directNode = this.capabilityMap.nodes.find(n => n.element === options.directParentElement || n.container === options.directParentElement);
          return [{
            score: 100,
            element: options.directParentElement,
            node: directNode || null
          }];
        }

        const topNodes = this.capabilityMap.nodes.filter(n => n.depth === 0 || !n.parent);
        for (const node of topNodes) {
          let score = 0;
          const normName = node.name.toLowerCase();
          if (normName === normQuery) {
            score += 100;
          } else if (normName.includes(normQuery)) {
            score += 70;
          } else if (normQuery.includes(normName) && normName.length >= 3) {
            score += 55;
          }
          const matchedTokens = queryTokens.filter(t => normName.includes(t));
          score += (matchedTokens.length / queryTokens.length) * 35;
          if (node.hasSubmenu) score += 20;

          if (score >= this.options.minMatchScore) {
            candidates.push({ score, element: node.element, node });
          }
        }

        if (candidates.length === 0) {
          const root = options.root || document;
          const triggers = Array.from(root.querySelectorAll('nav button, nav a, [role="navigation"] button, [role="navigation"] a, [role="menubar"] [role="menuitem"], .menu-group button, .menu-group h3, .dropdown-toggle, [aria-haspopup], [aria-expanded]'));
          for (const el of triggers) {
            const name = this.capabilityMap.getNodeName(el).toLowerCase();
            let score = 0;
            if (name === normQuery) score += 100;
            else if (name.includes(normQuery)) score += 70;
            else if (normQuery.includes(name) && name.length >= 3) score += 55;
            const matchedTokens = queryTokens.filter(t => name.includes(t));
            score += (matchedTokens.length / queryTokens.length) * 35;
            if (score >= this.options.minMatchScore) {
              const matchedNode = this.capabilityMap.nodes.find(n => n.element === el || n.container === el || (n.container && n.container.contains(el)));
              candidates.push({ score, element: el, node: matchedNode || null });
            }
          }
        }
      } else {
        const container = parentNode.submenuElement || currentContainer;
        if (!container) return [];

        const elements = Array.from(container.querySelectorAll('a, button, [role="menuitem"], [role="button"], [role="treeitem"], li, summary'));
        for (const el of elements) {
          if (!this.observer.isVisible(el)) {
            continue;
          }

          const rawText = this.capabilityMap.getNodeName(el);
          const normName = rawText.toLowerCase();
          if (!normName) continue;

          let score = 0;
          if (normName === normQuery) {
            score += 100;
          } else if (normName.includes(normQuery)) {
            score += 70;
          } else if (normQuery.includes(normName) && normName.length >= 3) {
            score += 55;
          }
          const matchedTokens = queryTokens.filter(t => normName.includes(t));
          score += (matchedTokens.length / queryTokens.length) * 35;

          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          if (role === 'menuitem' || role === 'a' || role === 'button') score += 15;

          if (score >= this.options.minMatchScore) {
            const matchedNode = this.capabilityMap.nodes.find(n => n.element === el || n.container === el);
            candidates.push({ score, element: el, node: matchedNode || null });
          }
        }

        if (candidates.length === 0) {
          const visualEl = this.visual.groundVisualCandidate(container, stepQuery);
          if (visualEl) {
            candidates.push({ score: 65, element: visualEl, node: null });
          }
        }
      }

      const unique = [];
      const seen = new Set();
      for (const cand of candidates) {
        if (!seen.has(cand.element)) {
          seen.add(cand.element);
          unique.push(cand);
        }
      }
      unique.sort((a, b) => b.score - a.score);
      return unique;
    }

    async openMenuPath(pathInput, options = {}) {
      const path = this.normalizeMenuPath(pathInput);
      if (!path || path.length === 0) {
        return { status: 'FAILED', verified: false, reason: 'empty_menu_path' };
      }

      if (path.length === 2) {
        const directLoc = this.locate(path[1], { section: path[0] });
        if (directLoc.status === 'FOUND' && directLoc.target) {
          return this.click(directLoc.target, Object.assign({ isNavigation: true }, options));
        }
      }

      this.capabilityMap.build(options.root || document);

      let currentContainer = options.root || document;
      let currentParentNode = null;

      for (let stepIndex = 0; stepIndex < path.length; stepIndex++) {
        const stepQuery = path[stepIndex];
        const isLeaf = stepIndex === path.length - 1;

        const candidates = this.findMenuCandidates(stepQuery, currentParentNode, currentContainer, options);

        if (candidates.length === 0) {
          const parentSubmenu = currentParentNode && currentParentNode.submenuElement;
          let parentFailedToOpen = false;
          if (stepIndex > 0 && parentSubmenu && parentSubmenu.isConnected) {
            try {
              const st = window.getComputedStyle(parentSubmenu);
              if (st.display === 'none' || st.visibility === 'hidden' || parentSubmenu.offsetWidth === 0) {
                parentFailedToOpen = true;
              }
            } catch (_e) {}
          }
          return {
            status: 'FAILED',
            verified: false,
            reason: stepIndex === 0 ? 'parent_menu_not_found' : 'child_not_found_under_parent',
            parentMenuFailedToOpen: parentFailedToOpen,
            failedStep: stepQuery,
            parent: currentParentNode ? currentParentNode.rawName : null,
            path: path.slice(0, stepIndex + 1)
          };
        }

        const topScore = candidates[0].score;
        const competing = candidates.filter(c => (topScore - c.score) <= 10);
        if (competing.length >= this.options.ambiguityThreshold) {
          return {
            status: 'AMBIGUOUS',
            verified: false,
            candidates: competing.map(c => ({
              name: c.node ? c.node.rawName : this.capabilityMap.getNodeName(c.element),
              role: c.node ? c.node.role : c.element.tagName.toLowerCase(),
              element: c.element
            })),
            prompt: `I found ${competing.length} matching menus (${competing.map(c => c.node ? c.node.rawName : this.capabilityMap.getNodeName(c.element)).join(', ')}). Which one would you like to open?`
          };
        }

        const matched = candidates[0];
        const targetEl = matched.element;
        const targetNode = matched.node;

        if (isConsequentialElement(targetEl) && options.userConfirmed !== true) {
          return {
            status: 'CONFIRMATION_REQUIRED',
            verified: false,
            consequential: true,
            reason: 'consequential_action_requires_explicit_user_confirmation'
          };
        }

        if (isLeaf) {
          const clickRes = await this.click(targetEl, Object.assign({ isNavigation: true }, options));
          return {
            status: clickRes.status || (clickRes.ok ? 'SUCCESS' : 'FAILED'),
            verified: Boolean(clickRes.verified || clickRes.ok),
            action: 'open_menu_path',
            path,
            target: targetEl,
            selectedItem: stepQuery,
            details: clickRes.details || clickRes.reason
          };
        }

        let isAlreadyExpanded = targetNode ? targetNode.isExpanded : false;
        let submenuEl = (targetNode && targetNode.submenuElement) ||
                        this.capabilityMap.findSubmenuContainer(targetEl, targetEl.parentElement) ||
                        this.visual.findVisualSubmenu(targetEl);

        if (submenuEl && submenuEl.isConnected) {
          try {
            const style = window.getComputedStyle(submenuEl);
            if (style.display !== 'none' && style.visibility !== 'hidden' && submenuEl.offsetWidth > 0) {
              isAlreadyExpanded = true;
            }
          } catch (_e) {}
        }

        if (!isAlreadyExpanded) {
          const method = (targetNode && targetNode.interactionMethod) ||
                         this.capabilityMap.detectInteractionMethod(targetEl, targetEl.parentElement, submenuEl);
          const controlToActivate = (targetNode && targetNode.expansionControl) || targetEl;

          if (method === 'split') {
            const expRes = await this.executor.click(controlToActivate);
            if (!expRes.ok) console.warn('[Sleepwalker] Split expansion click failed:', expRes.reason, controlToActivate);
          } else if (method === 'hover') {
            await this.executor.hover(controlToActivate);
          } else if (method === 'keyboard') {
            await this.executor.keyboardActivate(controlToActivate, 'Enter');
            await new Promise(r => setTimeout(r, 60));
            await this.executor.keyboardActivate(controlToActivate, 'ArrowDown');
          } else {
            await this.executor.click(controlToActivate);
          }

          const settleLimit = options.settleTimeoutMs || 600;
          const t0 = performance.now();
          let opened = false;

          while ((performance.now() - t0) < settleLimit) {
            await new Promise(r => setTimeout(r, 40));

            if (!submenuEl || !submenuEl.isConnected) {
              submenuEl = this.capabilityMap.findSubmenuContainer(controlToActivate, controlToActivate.parentElement) ||
                          this.visual.findVisualSubmenu(controlToActivate);
            }

            if (submenuEl && submenuEl.isConnected) {
              try {
                const style = window.getComputedStyle(submenuEl);
                if (style.display !== 'none' && style.visibility !== 'hidden' && submenuEl.offsetWidth > 0) {
                  opened = true;
                  break;
                }
              } catch (_e) {}
            }

            if (controlToActivate.getAttribute('aria-expanded') === 'true') {
              opened = true;
              break;
            }
          }

          if (!opened) {
            if (method === 'hover') {
              await this.executor.click(controlToActivate);
            } else if (method === 'click' && controlToActivate.tagName !== 'A') {
              await this.executor.hover(controlToActivate);
              await new Promise(r => setTimeout(r, 40));
              await this.executor.keyboardActivate(controlToActivate, 'Enter');
              await this.executor.keyboardActivate(controlToActivate, 'ArrowDown');
            } else if (method === 'keyboard') {
              await this.executor.click(controlToActivate);
            }
            await new Promise(r => setTimeout(r, 80));
          }
        }

        this.invalidateCache();
        this.capabilityMap.build(options.root || document);

        const freshParentNode = this.capabilityMap.nodes.find(n => n.element === targetEl || n.container === targetEl.parentElement);
        submenuEl = (freshParentNode && freshParentNode.submenuElement) ||
                    this.capabilityMap.findSubmenuContainer(targetEl, targetEl.parentElement) ||
                    this.visual.findVisualSubmenu(targetEl);

        currentContainer = submenuEl || (freshParentNode && freshParentNode.container) || targetEl.parentElement;
        currentParentNode = freshParentNode || {
          name: stepQuery.toLowerCase().trim(),
          rawName: stepQuery,
          element: targetEl,
          submenuElement: currentContainer
        };
        if (submenuEl) {
          currentParentNode.submenuElement = submenuEl;
        }
      }

      return { status: 'FAILED', verified: false, reason: 'unknown_failure' };
    }

    async openMenuAndSelect(parentMenuQuery, subItemText, options = {}) {
      if (typeof parentMenuQuery === 'string' && typeof subItemText === 'string') {
        const res = await this.openMenuPath([parentMenuQuery, subItemText], options);
        return Object.assign({ parentMenu: parentMenuQuery, selectedItem: subItemText }, res);
      }
      if (parentMenuQuery && parentMenuQuery.nodeType === 1 && typeof subItemText === 'string') {
        const pName = this.capabilityMap.getNodeName(parentMenuQuery);
        const res = await this.openMenuPath([pName || 'parent', subItemText], Object.assign({ directParentElement: parentMenuQuery }, options));
        return Object.assign({ parentMenu: pName || 'parent', selectedItem: subItemText }, res);
      }
      const res = await this.openMenuPath([String(parentMenuQuery || ''), String(subItemText || '')], options);
      return Object.assign({ parentMenu: String(parentMenuQuery || ''), selectedItem: String(subItemText || '') }, res);
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
          if ((e.role === 'textbox' || (e.role === 'combobox' && e.tag === 'INPUT')) && e.domNode) {
            const meta = [
              e.name || '',
              e.parentSection || '',
              e.domNode.id || '',
              e.domNode.name || '',
              e.domNode.placeholder || '',
              (e.domNode.getAttribute && e.domNode.getAttribute('type')) || '',
              (e.domNode.getAttribute && e.domNode.getAttribute('aria-label')) || ''
            ].join(' ');
            return /\b(?:search|find|query|filter|lookup|explore)\b|search_query/i.test(meta);
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

    // =========================================================================
    // Mode A: Goal-Based Autonomous Agent Pipeline
    // Observe -> Plan -> Check Permissions -> Act -> Wait -> Verify -> Recover
    // =========================================================================
    async executeGoal(goalText, options = {}) {
      if (this.inputController && typeof this.inputController.resetInterrupt === 'function') {
        this.inputController.resetInterrupt();
      }
      const maxSteps = options.maxSteps || 6;
      const stepLog = [];
      const intermediateStates = [];
      const actualInputs = [];
      const verificationEvidence = [];
      const goal = String(goalText || '').trim();
      if (!goal) return { status: 'ERROR', ok: false, reason: 'empty_goal' };

      const isCancelled = () => {
        if (options.signal && options.signal.aborted) return true;
        if (typeof options.isCancelled === 'function' && options.isCancelled()) return true;
        if (this.inputController && this.inputController.interrupted) return true;
        if (typeof window !== 'undefined' && window.__SLEEPWALKER_INSTANCE__ && window.__SLEEPWALKER_INSTANCE__.taskLifecycle && window.__SLEEPWALKER_INSTANCE__.taskLifecycle.state === 'CANCELLED') {
          return true;
        }
        return false;
      };

      // 1. Observe current page state
      const root = options.root || document;
      let obs = this.observe(root, { force: true });
      let capMap = this.capabilityMap ? this.capabilityMap.nodes : [];
      const initialUrl = (typeof window !== 'undefined' && window.location) ? window.location.href : '';
      const initialObservation = {
        url: obs.url,
        title: obs.title,
        elementCount: obs.elementCount,
        capabilityNodeCount: Array.isArray(capMap) ? capMap.length : 0,
        timestamp: obs.timestamp
      };

      // 2. High-level goal planning / step decomposition
      const planSteps = this._decomposeGoal(goal, { obs, capMap, options });
      const plannedActions = planSteps.map((s, idx) => ({
        step: idx + 1,
        action: s.action,
        target: s.target || s.query || (Array.isArray(s.path) ? s.path.join(' > ') : ''),
        value: s.value
      }));

      let stepIndex = 0;
      let lastExtractedText = '';

      for (const step of planSteps) {
        if (stepIndex >= maxSteps) break;
        if (isCancelled()) {
          return {
            status: 'CANCELLED',
            ok: false,
            verified: false,
            goal,
            reason: 'task_cancelled',
            stepsExecuted: stepIndex,
            initialObservation,
            plannedActions,
            actualInputs,
            intermediateStates,
            verificationEvidence,
            stepLog
          };
        }
        stepIndex++;

        // Closed loop: Check Permissions / Consequential safety
        if (this._isConsequentialAction(step) && options.userConfirmed !== true) {
          return {
            status: 'CONFIRMATION_REQUIRED',
            verified: false,
            goal,
            stepIndex,
            pendingStep: step,
            reason: `Action "${step.action} ${step.target || ''}" requires user confirmation.`,
            initialObservation,
            plannedActions,
            actualInputs,
            intermediateStates,
            verificationEvidence,
            stepLog
          };
        }

        // Act
        let stepRes = await this._executeGoalStep(step, { obs, capMap, options, isCancelled });
        if (stepRes && stepRes.text) {
          lastExtractedText = stepRes.text;
        }
        let verified = Boolean(stepRes && (stepRes.verified || stepRes.ok || stepRes.status === 'SUCCESS' || stepRes.status === 'SENSITIVE_SKIPPED'));

        if (isCancelled()) {
          return {
            status: 'CANCELLED',
            ok: false,
            verified: false,
            goal,
            reason: 'task_cancelled',
            stepsExecuted: stepIndex,
            initialObservation,
            plannedActions,
            actualInputs,
            intermediateStates,
            verificationEvidence,
            stepLog
          };
        }

        // Recovery if step failed
        if (!verified) {
          if (stepRes && stepRes.status === 'CONFIRMATION_REQUIRED') {
            return {
              status: 'CONFIRMATION_REQUIRED',
              verified: false,
              goal,
              stepIndex,
              pendingStep: step,
              reason: stepRes.reason || 'Consequential action requires confirmation.',
              initialObservation,
              plannedActions,
              actualInputs,
              intermediateStates,
              verificationEvidence,
              stepLog
            };
          }

          const recRes = await this._recoverGoalStep(step, stepRes, { obs, capMap, options, initialUrl, isCancelled });
          if (recRes && recRes.status === 'CANCELLED') {
            return {
              status: 'CANCELLED',
              ok: false,
              verified: false,
              goal,
              reason: 'task_cancelled',
              stepsExecuted: stepIndex,
              initialObservation,
              plannedActions,
              actualInputs,
              intermediateStates,
              verificationEvidence,
              stepLog
            };
          }
          if (recRes && (recRes.verified || recRes.ok || recRes.status === 'SUCCESS')) {
            stepRes = recRes;
            if (stepRes.text) lastExtractedText = stepRes.text;
            verified = true;
            actualInputs.push({
              step: stepIndex,
              action: step.action,
              target: step.target || step.query || (Array.isArray(step.path) ? step.path.join(' > ') : ''),
              recovered: true,
              strategy: recRes.recoveryStrategy || 'reobserve_and_retry'
            });
            verificationEvidence.push({
              step: stepIndex,
              verified: true,
              recovered: true,
              details: recRes.details || recRes.status || 'recovered_and_verified',
              url: (typeof window !== 'undefined' && window.location) ? window.location.href : ''
            });
            stepLog.push({
              step: stepIndex,
              action: step.action,
              target: step.target || step.query || (Array.isArray(step.path) ? step.path.join(' > ') : ''),
              outcome: 'RECOVERED',
              recoveryStrategy: recRes.recoveryStrategy || 'reobserve_and_retry',
              verified: true
            });
          } else {
            const failReason = (recRes && recRes.reason && recRes.reason !== 'recovery_exhausted')
              ? recRes.reason
              : ((stepRes && stepRes.reason) || 'execution_failed');
            stepLog.push({
              step: stepIndex,
              action: step.action,
              target: step.target || step.query || (Array.isArray(step.path) ? step.path.join(' > ') : ''),
              outcome: 'FAILED',
              reason: failReason,
              verified: false
            });
            verificationEvidence.push({
              step: stepIndex,
              verified: false,
              reason: failReason,
              url: (typeof window !== 'undefined' && window.location) ? window.location.href : ''
            });
            return {
              status: 'FAILED',
              ok: false,
              verified: false,
              goal,
              failedStep: step,
              reason: failReason,
              initialObservation,
              plannedActions,
              actualInputs,
              intermediateStates,
              verificationEvidence,
              stepLog
            };
          }
        } else {
          actualInputs.push({
            step: stepIndex,
            action: step.action,
            target: step.target || step.query || (Array.isArray(step.path) ? step.path.join(' > ') : ''),
            value: step.value,
            status: stepRes.status || 'SUCCESS'
          });
          verificationEvidence.push({
            step: stepIndex,
            verified: true,
            status: stepRes.status || 'SUCCESS',
            details: stepRes.details || (stepRes.text ? `read_${stepRes.text.length}_chars` : 'verified'),
            url: (typeof window !== 'undefined' && window.location) ? window.location.href : ''
          });
          stepLog.push({
            step: stepIndex,
            action: step.action,
            target: step.target || step.query || (Array.isArray(step.path) ? step.path.join(' > ') : ''),
            outcome: stepRes.status || 'SUCCESS',
            verified: true
          });
        }

        // Wait & Settle
        await new Promise(r => setTimeout(r, options.settleDelayMs || 60));
        obs = this.observe(root, { force: true });
        capMap = this.capabilityMap ? this.capabilityMap.nodes : [];
        intermediateStates.push({
          afterStep: stepIndex,
          url: obs.url,
          title: obs.title,
          elementCount: obs.elementCount,
          capabilityNodeCount: Array.isArray(capMap) ? capMap.length : 0
        });
      }

      return {
        status: 'SUCCESS',
        ok: true,
        goal,
        stepsExecuted: stepIndex,
        initialObservation,
        plannedActions,
        actualInputs,
        intermediateStates,
        verificationEvidence,
        finalResult: {
          url: obs.url,
          title: obs.title,
          extractedText: lastExtractedText || undefined
        },
        stepLog,
        verified: true
      };
    }

    _decomposeGoal(goal, ctx = {}) {
      const g = goal.toLowerCase().trim();
      const steps = [];
      const opts = (ctx && ctx.options) || {};

      // Explicit structured fields passed in options.fields (e.g. form filling goal)
      if (Array.isArray(opts.fields) && opts.fields.length > 0) {
        for (const f of opts.fields) {
          if (f.type === 'select') {
            steps.push({ action: 'select', target: f.label || f.target, value: f.value });
          } else {
            steps.push({ action: 'type', target: f.label || f.target, value: f.value });
          }
        }
        return steps;
      }

      // Consequential actions: delete, pay, purchase
      if (/\b(?:delete|destroy|terminate|close|erase)\s+(?:(?:my|the|this)\s+)?(?:account|data|profile|records?)\b/i.test(g) || /\b(?:pay\s+now|purchase|buy\s+now|transfer\s+funds)\b/i.test(g)) {
        steps.push({ action: 'delete', target: goal });
        return steps;
      }

      // Hierarchical / Nested Menu Path ("Open X under Y", "Navigate to A > B > C")
      const menuPath = this.normalizeMenuPath(goal);
      if (Array.isArray(menuPath) && menuPath.length >= 2) {
        steps.push({ action: 'menu', path: menuPath, target: menuPath.join(' > ') });
        return steps;
      }

      // Multi-field or single-field form filling ("Fill Full Name with Ada Lovelace and Email with ada@example.edu")
      if (/^(?:fill|enter|type|populate)\b/i.test(g) && /\b(?:with|as|into|in)\b/i.test(g)) {
        const clauses = goal.replace(/^(?:please\s+)?(?:fill(?:\s+out|\s+in)?(?:\s+the\s+form)?(?:\s+with)?)\s*/i, '').split(/\s*(?:,\s*and\s+|\s+and\s+|,\s*)\s*/i);
        for (const clause of clauses) {
          const withM = clause.match(/^(?:fill\s+)?(.+?)\s+(?:with|as|=|:)\s+(.+)$/i);
          const intoM = clause.match(/^(?:enter|type)\s+(.+?)\s+(?:into|in)\s+(.+)$/i);
          if (withM) {
            steps.push({ action: 'type', target: withM[1].trim().replace(/^["']|["']$/g, ''), value: withM[2].trim().replace(/^["']|["']$/g, '') });
          } else if (intoM) {
            steps.push({ action: 'type', target: intoM[2].trim().replace(/^["']|["']$/g, ''), value: intoM[1].trim().replace(/^["']|["']$/g, '') });
          }
        }
        if (steps.length > 0) return steps;
      }

      // E.g. "search [site?] for [X] and click [Y]"
      const searchAndClickM = goal.match(/^(?:search|find)\s+(?:(?:on|in)\s+)?(?:(?:wikipedia|youtube|github|google)\s+)?(?:for\s+)?(.+?)\s+(?:and\s+(?:then\s+)?(?:click|open|select)\s+)(.+)$/i);
      if (searchAndClickM) {
        steps.push({ action: 'search', query: searchAndClickM[1].trim() });
        steps.push({ action: 'click', target: searchAndClickM[2].trim() });
        return steps;
      }

      // E.g. "Search Wikipedia for artificial intelligence" or "Search for [X]"
      const siteSearchM = goal.match(/^(?:search|look\s+up)\s+(?:(?:on|in)\s+)?(?:wikipedia|youtube|github|google)\s+(?:for\s+)(.+)$/i);
      if (siteSearchM) {
        steps.push({ action: 'search', query: siteSearchM[1].trim() });
        return steps;
      }

      const searchM = goal.match(/^(?:search\s+(?:for\s+)?)(.+)$/i);
      if (searchM && !/\band\b/i.test(searchM[1])) {
        steps.push({ action: 'search', query: searchM[1].trim() });
        return steps;
      }

      // E.g. "Find a repository on GitHub: [X]" or "Find repository [X] on GitHub" or "Find YouTube video [X]"
      const findRepoOrVideoM = goal.match(/^(?:find|locate|look\s+for)\s+(?:a\s+|the\s+|particular\s+)?(?:(?:github\s+)?(?:repository|repo)|(?:youtube\s+)?video)\s*(?:called|named|for|about|on|:)?\s*(.+?)(?:\s+on\s+(?:github|youtube))?$/i);
      if (findRepoOrVideoM) {
        const targetQuery = findRepoOrVideoM[1].replace(/\s+on\s+(?:github|youtube)$/i, '').trim();
        const loc = this.locate(targetQuery);
        if (loc && loc.status === 'FOUND' && loc.target) {
          steps.push({ action: 'click', target: targetQuery });
        } else {
          steps.push({ action: 'search', query: targetQuery });
          steps.push({ action: 'click', target: targetQuery });
        }
        return steps;
      }

      // E.g. "check my attendance" / "retrieve information from [X]"
      if (/\b(?:check|view|see)\s+(?:my\s+)?attendance\b/i.test(g)) {
        steps.push({ action: 'click', target: 'attendance' });
        steps.push({ action: 'read', target: 'attendance', scope: 'section' });
        return steps;
      }

      const retrieveM = goal.match(/^(?:retrieve|get|extract|find)\s+(?:the\s+)?(?:information|details|data|text|records?)\s+(?:from|about|on|in|for)\s+(?:the\s+)?(.+)$/i);
      if (retrieveM) {
        const topic = retrieveM[1].replace(/\s+(?:section|portal|page)$/i, '').trim();
        const loc = this.locate(topic);
        if (loc && loc.status === 'FOUND' && loc.target) {
          steps.push({ action: 'click', target: topic });
        }
        steps.push({ action: 'read', target: topic, scope: 'section' });
        return steps;
      }

      // E.g. "find the latest issue in my github repo" / "view issues"
      if (/\b(?:find|view|open|check)\s+(?:the\s+)?(?:latest\s+)?issues?\b/i.test(g)) {
        steps.push({ action: 'click', target: 'Issues' });
        steps.push({ action: 'read', scope: 'page' });
        return steps;
      }

      // E.g. "click [X]" / "open [X]" / "navigate to [X]"
      const clickM = goal.match(/^(?:click(?:\s+on)?|open|select|press|navigate\s+to|go\s+to)\s+(?:the\s+)?(.+)$/i);
      if (clickM) {
        steps.push({ action: 'click', target: clickM[1].trim() });
        return steps;
      }

      // E.g. "read [X]" / "read this page" / "summarize"
      const readSecM = goal.match(/^(?:read|summarize|explain)\s+(?:the\s+)?(.+?)(?:\s+section)?$/i);
      if (readSecM) {
        const sec = readSecM[1].trim();
        const isWholePage = /^(?:this\s+page|the\s+page|page|everything)$/i.test(sec);
        steps.push({ action: 'read', target: isWholePage ? 'page' : sec, scope: isWholePage ? 'page' : 'section' });
        return steps;
      }

      // Generic single-action fallback
      steps.push({ action: 'navigate', target: goal });
      return steps;
    }

    _isConsequentialAction(step) {
      if (!step) return false;
      const act = String(step.action || '').toLowerCase();
      const target = String(step.target || step.query || '').toLowerCase();
      if (act === 'delete' || act === 'pay' || act === 'submit' || act === 'purchase') {
        return true;
      }
      if (/\b(?:delete\s+(?:(?:my|the|this)\s+)?account|purchase|pay\s+now|checkout|buy\s+now|confirm\s+order|transfer\s+funds|password)\b/i.test(target)) {
        return true;
      }
      return false;
    }

    async navigate(targetOrQuery, options = {}) {
      return this.click(targetOrQuery, Object.assign({ isNavigation: true }, options));
    }

    async _executeGoalStep(step, ctx = {}) {
      const act = String(step.action || '').toLowerCase();
      const opts = (ctx && ctx.options) || {};
      if (act === 'menu') {
        return this.openMenuPath(step.path || step.target, opts);
      }
      if (act === 'click' || act === 'navigate') {
        return this.click(step.target, Object.assign({ isNavigation: true }, opts));
      }
      if (act === 'search') {
        return this.executeSearch(step.query || step.target, opts);
      }
      if (act === 'read') {
        let rc = this.readContent(step.target || 'page', opts);
        if (!rc.verified && step.target && step.target !== 'page') {
          rc = this.readContent('page', opts);
        }
        return { ok: rc.verified, verified: rc.verified, status: rc.verified ? 'READ_COMPLETE' : 'FAILED', text: rc.text, heading: rc.heading, reason: rc.reason };
      }
      if (act === 'type' || act === 'fill') {
        return this.type(step.target, step.value || '', opts);
      }
      if (act === 'select') {
        return this.select(step.target, step.value || '', opts);
      }
      if (act === 'scroll') {
        return this.scroll(step.direction || 'down', opts);
      }
      if (act === 'key' || act === 'press') {
        return this.inputController ? this.inputController.pressKey(step.key || 'Enter', opts) : { ok: true };
      }
      return { ok: false, reason: 'unrecognized_goal_action' };
    }

    async _recoverGoalStep(step, previousFailure, ctx = {}) {
      const isCancelled = ctx.isCancelled || (() => false);
      if (isCancelled()) return { ok: false, status: 'CANCELLED', reason: 'task_cancelled' };

      const root = (ctx.options && ctx.options.root) || document;
      const act = String(step.action || '').toLowerCase();
      const prevReason = (previousFailure && previousFailure.reason) || '';

      // 1. Check for unexpected navigation away from expected origin/context
      const currentUrl = (typeof window !== 'undefined' && window.location) ? window.location.href : '';
      if (ctx.initialUrl && currentUrl !== ctx.initialUrl) {
        try {
          const u1 = new URL(ctx.initialUrl);
          const u2 = new URL(currentUrl);
          if (u1.origin !== u2.origin || /error|404|unexpected/i.test(u2.pathname + u2.hash)) {
            this.invalidateCache();
            this.observe(root, { force: true });
            const checkLoc = step.target ? this.locate(step.target, { root }) : { status: 'NOT_FOUND' };
            if (checkLoc.status !== 'FOUND') {
              return { ok: false, verified: false, status: 'FAILED', reason: 'unexpected_navigation_target_missing', unexpectedUrl: currentUrl };
            }
          }
        } catch (_e) {}
      }

      // 2. If click failed due to obstruction (modal/toast/sticky overlay), try pressing Escape and scrolling into view
      if (prevReason.startsWith('hit_test_obstructed_by_')) {
        try {
          if (this.inputController) {
            await this.inputController.pressKey('Escape');
          }
          // Also check for close/dismiss button on blocking overlay
          const dismissBtn = root.querySelector('[data-dismiss], .modal-close, .toast-close, .overlay-close, button[aria-label*="close" i], button[aria-label*="dismiss" i]');
          if (dismissBtn && typeof dismissBtn.click === 'function') {
            dismissBtn.click();
          }
        } catch (_e) {}
        await new Promise(r => setTimeout(r, 80));
        this.invalidateCache();
        this.observe(root, { force: true });
        const retryObstructed = await this._executeGoalStep(step, ctx);
        if (retryObstructed && (retryObstructed.verified || retryObstructed.ok || retryObstructed.status === 'SUCCESS')) {
          return Object.assign({}, retryObstructed, { ok: true, verified: true, recoveryStrategy: 'dismiss_obstruction_and_retry' });
        }
      }

      // 3. Poll for delayed / slow-loading DOM settlement (e.g. async SPA rendering)
      const waitBudgetMs = (ctx.options && ctx.options.recoveryTimeoutMs) || 700;
      const pollIntervalMs = 100;
      let elapsed = 0;

      while (elapsed < waitBudgetMs) {
        if (isCancelled()) return { ok: false, status: 'CANCELLED', reason: 'task_cancelled' };
        await new Promise(r => setTimeout(r, pollIntervalMs));
        elapsed += pollIntervalMs;

        this.invalidateCache();
        this.observe(root, { force: true });

        if (act === 'click' || act === 'navigate') {
          const loc = this.locate(step.target, { root });
          if (loc.status === 'FOUND' && loc.target && loc.target.isConnected) {
            const retryRes = await this.click(loc.target, Object.assign({ isNavigation: true }, ctx.options));
            if (retryRes && (retryRes.verified || retryRes.status === 'SUCCESS')) {
              return Object.assign({}, retryRes, { ok: true, verified: true, recoveryStrategy: 'delayed_dom_settlement_retry' });
            }
          }
        } else if (act === 'search' || act === 'type' || act === 'fill' || act === 'menu') {
          const retryRes = await this._executeGoalStep(step, ctx);
          if (retryRes && (retryRes.verified || retryRes.ok || retryRes.status === 'SUCCESS')) {
            return Object.assign({}, retryRes, { ok: true, verified: true, recoveryStrategy: 'delayed_dom_settlement_retry' });
          }
        }
      }

      return { ok: false, verified: false, status: 'FAILED', reason: prevReason || 'recovery_exhausted' };
    }
  }

  // Export to global scope for Manifest V3 content script isolation
  global.StagehandObserver = StagehandObserver;
  global.PlaywrightExecutor = PlaywrightExecutor;
  global.StateVerifier = StateVerifier;
  global.VisualFallback = VisualFallback;
  global.PageCapabilityMap = PageCapabilityMap;
  global.BrowserInputController = BrowserInputController;
  global.BrowserEngine = BrowserEngine;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      StagehandObserver,
      PlaywrightExecutor,
      StateVerifier,
      VisualFallback,
      PageCapabilityMap,
      BrowserInputController,
      BrowserEngine
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
