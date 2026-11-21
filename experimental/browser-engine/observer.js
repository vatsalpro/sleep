/**
 * Sleepwalker Rebuilt Browser Engine — Stagehand-Inspired Observer
 *
 * Implements:
 * - W3C Accessible Name (accName) computation without DOM modification.
 * - ARIA role derivation (native elements + explicit role attributes).
 * - Deep open Shadow DOM piercing.
 * - Parent section / landmark hierarchy tagging.
 * - State tracking (visible, enabled, expanded, selected, checked, value).
 * - Actionable element candidate harvesting.
 */
(function (global) {
  'use strict';

  class StagehandObserver {
    constructor(options = {}) {
      this.options = Object.assign({
        maxElements: 80,
        includeInvisible: false,
        skipHiddenInputs: true
      }, options);
    }

    /**
     * Compute accessible name for any DOM element following W3C AccName guidelines.
     * @param {Element} el
     * @returns {string}
     */
    computeAccessibleName(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

      // 1. aria-labelledby
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = labelledBy.split(/\s+/).map(id => {
          const ref = document.getElementById(id);
          return ref ? (ref.textContent || '').trim() : '';
        }).filter(Boolean);
        if (parts.length > 0) return parts.join(' ');
      }

      // 2. aria-label
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

      // 3. Form input associated label
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        // Label with 'for' attribute
        if (el.id) {
          const rootNode = el.getRootNode ? el.getRootNode() : document;
          const lbl = rootNode.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) {
            const lblText = this._getCleanText(lbl);
            if (lblText) return lblText;
          }
        }
        // Wrapping label
        const wrappingLabel = el.closest('label');
        if (wrappingLabel) {
          // Clone to remove input text itself
          const clone = wrappingLabel.cloneNode(true);
          const childInputs = clone.querySelectorAll('input, select, textarea');
          childInputs.forEach(i => i.remove());
          const txt = (clone.textContent || '').trim();
          if (txt) return txt;
        }
        // Placeholder
        if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();
        // Title or Name
        if (el.title && el.title.trim()) return el.title.trim();
        if (el.name && el.name.trim()) return el.name.trim();
      }

      // 4. Image alt text
      if (el instanceof HTMLImageElement) {
        if (el.alt && el.alt.trim()) return el.alt.trim();
        if (el.title && el.title.trim()) return el.title.trim();
      }

      // 5. Button or Link text
      if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab') {
        const cleanText = this._getCleanText(el);
        if (cleanText) return cleanText;
        if (el.title && el.title.trim()) return el.title.trim();
      }

      // 6. Generic visible text fallback
      const directText = this._getCleanText(el);
      if (directText) return directText;

      return el.getAttribute('title') || el.getAttribute('name') || '';
    }

    /**
     * Compute ARIA role (explicit or implicit HTML5 semantic role).
     * @param {Element} el
     * @returns {string}
     */
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

    /**
     * Determine if an element is actionable (interactive control).
     * @param {Element} el
     * @param {string} role
     * @returns {boolean}
     */
    isActionable(el, role) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

      // Sleepwalker internal UI exclusion
      if (el.closest && (el.closest('#sleepwalker-ui-host') || el.closest('#sleepwalker-host') || el.closest('[data-sleepwalker-ui="1"]'))) {
        return false;
      }

      const actionableRoles = new Set([
        'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
        'combobox', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch',
        'slider', 'option'
      ]);

      if (actionableRoles.has(role)) return true;

      // Common interactive patterns
      const tag = el.tagName.toUpperCase();
      if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
      if (tag === 'INPUT' && (el.type || '').toLowerCase() !== 'hidden') return true;

      if (el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.getAttribute('contenteditable') === 'true') {
        return true;
      }

      // Check cursor style
      try {
        const style = window.getComputedStyle(el);
        if (style && style.cursor === 'pointer' && !['BODY', 'HTML'].includes(tag)) {
          return true;
        }
      } catch (_e) {}

      return false;
    }

    /**
     * Determine nearest parent landmark or heading section name.
     * @param {Element} el
     * @returns {string}
     */
    computeParentSection(el) {
      if (!el) return '';
      let cur = el.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        // Section with aria-label or heading
        if (cur.getAttribute('aria-label')) return cur.getAttribute('aria-label').trim();
        const labelledBy = cur.getAttribute('aria-labelledby');
        if (labelledBy) {
          const ref = document.getElementById(labelledBy);
          if (ref) return (ref.textContent || '').trim();
        }

        // Check if container has a preceding heading
        const heading = cur.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
        if (heading && heading !== el && !heading.contains(el)) {
          const hText = this._getCleanText(heading);
          if (hText) return hText;
        }

        // Landmarks
        const role = cur.getAttribute('role');
        if (role && ['navigation', 'main', 'region', 'form', 'banner', 'complementary'].includes(role)) {
          const label = cur.getAttribute('aria-label') || cur.id || role;
          return label;
        }
        if (['NAV', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'FORM', 'HEADER'].includes(cur.tagName)) {
          if (cur.id) return cur.id;
        }

        cur = cur.parentElement;
      }
      return '';
    }

    /**
     * Check element visibility in viewport/DOM.
     * @param {Element} el
     * @returns {boolean}
     */
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

    /**
     * Traverse DOM including open Shadow DOM roots.
     * @param {Node} root
     * @param {Function} callback
     */
    traverseTree(root, callback) {
      if (!root) return;
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.nodeType === Node.ELEMENT_NODE) {
          callback(node);
          // Pierce open shadow roots
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

    /**
     * Generate complete Page Observation Snapshot.
     * @param {Element|Document} root
     * @returns {Object} Observation snapshot
     */
    observe(root = document) {
      const actionable = [];
      let seq = 0;

      this.traverseTree(root === document ? document.body : root, (node) => {
        const role = this.computeRole(node);
        if (!this.isActionable(node, role)) return;

        const visible = this.isVisible(node);
        if (!visible && !this.options.includeInvisible) return;

        const name = this.computeAccessibleName(node);
        const rect = node.getBoundingClientRect();
        const parentSec = this.computeParentSection(node);

        const states = {
          visible,
          disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
          expanded: node.hasAttribute('aria-expanded') ? node.getAttribute('aria-expanded') === 'true' : undefined,
          selected: node.hasAttribute('aria-selected') ? node.getAttribute('aria-selected') === 'true' : undefined,
          checked: node.hasAttribute('aria-checked')
            ? node.getAttribute('aria-checked') === 'true'
            : (node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type) ? node.checked : undefined),
          value: (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement)
            ? (node.type === 'password' ? '[REDACTED]' : node.value)
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

      // Build compact token representation for LLM context
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
      // Exclude script, style, and sleepwalker elements
      const clone = el.cloneNode(true);
      const toRemove = clone.querySelectorAll('script, style, noscript, [aria-hidden="true"], #sleepwalker-ui-host');
      toRemove.forEach(r => r.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StagehandObserver };
  } else {
    global.StagehandObserver = StagehandObserver;
  }
})(typeof window !== 'undefined' ? window : globalThis);
