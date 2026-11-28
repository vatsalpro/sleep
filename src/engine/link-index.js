/**
 * Sleepwalker - link-index.js
 * Builds a clean, cached index of all visible interactive links/buttons on the page
 * (including open shadow roots and same-origin iframes) for phonetic + contextual matching.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerLinkIndex = api.SleepwalkerLinkIndex;
    root.SleepwalkerLinkIndexInstance = api.defaultInstance;
    root.__SW_LINKS__ = function () {
      return api.defaultInstance.debugTable();
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const MAX_TARGETS = 500;
  const MUTATION_DEBOUNCE_MS = 300;
  const CONTEXT_SNIPPET_MAX = 120;

  const TARGET_SELECTOR = [
    'a[href]',
    'a.nav-link',
    'a.dropdown-toggle',
    'a.dropdown-item',
    'a[data-toggle]',
    'a[data-bs-toggle]',
    'button',
    'details > summary',
    '[role="link"]',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[aria-expanded]',
    '[aria-haspopup]',
    '.dropdown-toggle',
    '.ui-tabs-tab',
    'input[type="submit"]',
    'input[type="button"]',
    'input[type="reset"]',
    '[onclick]',
    '[tabindex]'
  ].join(', ');

  const AD_OR_COOKIE_NOISE_RE = /\b(?:accept\s+all\s+cookies|manage\s+cookies|cookie(?:\s+(?:settings|preferences|policy|notice|consent))?|adchoices|sponsored(?:\s+ad)?|advertisement)\b/i;

  const LOGOUT_RE = /\b(?:log\s*out|sign\s*out|logout|signout|log\s*off|exit\s+account|लॉगआउट|लॉग\s*आउट)\b/i;
  const DELETE_RE = /\b(?:delete|remove|erase|destroy|deactivate\s+account|close\s+account|हटाएं|डिलीट)\b/i;
  const PAY_RE = /\b(?:pay\s+now|make\s+payment|proceed\s+to\s+pay|pay\b|payment|checkout|place\s+order|complete\s+purchase|buy\s+now|donate\s+now|transfer\s+money|भुगतान)\b/i;
  const SUBMIT_RE = /\b(?:submit|submit\s+form|send\s+application|final\s+submit|jama\s+karo|सबमिट)\b/i;
  const DOWNLOAD_EXT_RE = /\.(?:pdf|zip|rar|7z|tar|gz|doc|docx|xls|xlsx|ppt|pptx|csv|exe|apk|dmg|msi|iso|mp3|mp4|wav)(?:[?#]|$)/i;
  const DOWNLOAD_LABEL_RE = /\b(?:download|save\s+pdf|export\s+csv|export\s+pdf|डाउनलोड)\b/i;

  function cleanSpace(str) {
    return String(str || '').replace(/\s+/g, ' ').trim();
  }

  function isSleepwalkerUiNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const id = node.id || '';
    if (id === 'sleepwalker-host' || id === 'sleepwalker-ui-host' || id === 'sleepwalker-candidate-overlay-root') {
      return true;
    }
    return Boolean(typeof node.getAttribute === 'function' && node.getAttribute('data-sleepwalker-ui') === '1');
  }

  function isInsideSleepwalkerUi(node) {
    if (!node) return false;
    if (isSleepwalkerUiNode(node)) return true;
    if (typeof node.closest === 'function' && node.closest('#sleepwalker-host, #sleepwalker-ui-host, #sleepwalker-candidate-overlay-root, [data-sleepwalker-ui="1"]')) {
      return true;
    }
    const rootNode = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    if (rootNode && rootNode.host && isSleepwalkerUiNode(rootNode.host)) return true;
    return false;
  }

  function safeDecodeURIComponent(str) {
    try {
      return decodeURIComponent(str);
    } catch (_e) {
      return str;
    }
  }

  function extractHrefWords(rawHref) {
    const raw = String(rawHref || '').trim();
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return '';
    try {
      const base = (typeof window !== 'undefined' && window.location && window.location.href) || 'https://local.invalid/';
      const url = new URL(raw, base);
      // Use pathname + safe hash slug only; never read query strings (can carry tokens/secrets).
      const pathPart = safeDecodeURIComponent(url.pathname || '')
        .replace(/\.(?:html?|php|aspx?|jsp)$/i, '');
      const hashPart = url.hash && !url.hash.includes('=') ? safeDecodeURIComponent(url.hash.slice(1)) : '';
      const combined = `${pathPart} ${hashPart}`
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[\/_+\-.]+/g, ' ')
        .toLowerCase();
      return cleanSpace(combined);
    } catch (_e) {
      return '';
    }
  }

  function resolveUrlSafe(el, doc) {
    const raw = (el && typeof el.getAttribute === 'function' ? el.getAttribute('href') : '') || '';
    if (!raw) return '';
    try {
      const base = (doc && doc.location && doc.location.href)
        || (typeof window !== 'undefined' && window.location && window.location.href)
        || undefined;
      return new URL(raw, base).href;
    } catch (_e) {
      return raw;
    }
  }

  class SleepwalkerLinkIndex {
    constructor(options = {}) {
      this.maxTargets = Number.isFinite(options.maxTargets) ? options.maxTargets : MAX_TARGETS;
      this.debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : MUTATION_DEBOUNCE_MS;
      this._targets = [];
      this._dirty = true;
      this._pendingMutation = false;
      this._observer = null;
      this._debounceTimer = null;
      this._observedDoc = null;
      this._lastBuiltAt = 0;
    }

    _getDoc() {
      return typeof document !== 'undefined' ? document : null;
    }

    _getWin() {
      return typeof window !== 'undefined' ? window : null;
    }

    /**
     * Watch DOM mutations cleanly (debounced 300 ms while also marking pending dirty immediately
     * so rapid commands right after DOM changes never read stale targets).
     */
    attachObserver(doc = this._getDoc()) {
      if (!doc || typeof MutationObserver !== 'function') return;
      if (this._observer && this._observedDoc === doc) return;
      this.disconnectObserver();

      const targetRoot = doc.documentElement || doc.body;
      if (!targetRoot) return;

      const MEDIA_NOISE_SEL = 'ytd-player, .html5-video-player, .ytp-chrome-bottom, .ytp-progress-bar-container, .ytp-time-display, yt-live-chat-app, ytd-live-chat-frame, video, audio, canvas';
      this._observer = new MutationObserver((mutations) => {
        let relevant = false;
        for (let i = 0; i < mutations.length; i++) {
          const t = mutations[i].target;
          if (isInsideSleepwalkerUi(t)) continue;
          if (t && t.nodeType === 1 && typeof t.closest === 'function' && t.closest(MEDIA_NOISE_SEL)) continue;
          relevant = true;
          break;
        }
        if (!relevant) return;

        this._pendingMutation = true;
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          this._debounceTimer = null;
          this._dirty = true;
        }, this.debounceMs);
      });

      this._observer.observe(targetRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'hidden', 'style', 'class', 'disabled', 'aria-hidden', 'aria-label', 'aria-disabled', 'role', 'tabindex']
      });
      this._observedDoc = doc;
    }

    disconnectObserver() {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      this._observedDoc = null;
    }

    markDirty() {
      this._dirty = true;
      this._pendingMutation = true;
    }

    getTargets(forceRebuild = false) {
      const doc = this._getDoc();
      this.attachObserver(doc);
      if (forceRebuild || this._dirty || this._pendingMutation) {
        this.rebuild(doc);
      }
      return this._targets;
    }

    _isNativeInteractive(el, win) {
      if (!el || el.nodeType !== 1) return false;
      const tag = String(el.tagName || '').toLowerCase();
      const role = String((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
      if (tag === 'a' && (el.hasAttribute('href') || (el.classList && (el.classList.contains('dropdown-toggle') || el.classList.contains('nav-link') || el.classList.contains('dropdown-item'))) || el.hasAttribute('data-toggle') || el.hasAttribute('data-bs-toggle') || el.hasAttribute('aria-expanded') || el.hasAttribute('aria-haspopup'))) return true;
      if (tag === 'button' || tag === 'summary') return true;
      if (role === 'link' || role === 'button' || role === 'tab' || role === 'menuitem') return true;
      if (el.hasAttribute && (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-haspopup'))) return true;
      if (el.classList && (el.classList.contains('dropdown-toggle') || el.classList.contains('ui-tabs-tab'))) return true;
      if (tag === 'input') {
        const type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
        return type === 'submit' || type === 'button' || type === 'reset';
      }
      if (el.hasAttribute && el.hasAttribute('onclick')) return true;
      if (el.hasAttribute && el.hasAttribute('tabindex')) {
        const rawTi = String(el.getAttribute('tabindex') || '').trim();
        if (rawTi === '' || Number(rawTi) < 0) return false;
        if (win && typeof win.getComputedStyle === 'function') {
          const st = win.getComputedStyle(el);
          return Boolean(st && st.cursor === 'pointer');
        }
        return Boolean(el.style && el.style.cursor === 'pointer');
      }
      return false;
    }

    _getAdjustedRect(el, frameOffset) {
      if (!el || typeof el.getBoundingClientRect !== 'function') return null;
      const r = el.getBoundingClientRect();
      if (!r) return null;
      const ox = frameOffset ? frameOffset.left : 0;
      const oy = frameOffset ? frameOffset.top : 0;
      return {
        top: Math.round((r.top + oy) * 10) / 10,
        left: Math.round((r.left + ox) * 10) / 10,
        right: Math.round((r.right + ox) * 10) / 10,
        bottom: Math.round((r.bottom + oy) * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10
      };
    }

    _isVisibleAndValid(el, doc, win, topWin, rect) {
      if (!el || el.nodeType !== 1) return false;
      const tag = String(el.tagName || '').toLowerCase();
      const typeAttr = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();

      // Never index password or hidden form inputs, or anything disabled.
      if (tag === 'input' && (typeAttr === 'password' || typeAttr === 'hidden')) return false;
      if (el.disabled || (el.hasAttribute && el.hasAttribute('disabled'))) return false;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
      if (el.hidden || (el.hasAttribute && el.hasAttribute('hidden'))) return false;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;

      if (isInsideSleepwalkerUi(el)) return false;
      if (el.closest && el.closest('#sleepwalker-host, #sleepwalker-ui-host, #sleepwalker-candidate-overlay-root, [data-sleepwalker-ui="1"], [hidden], [aria-hidden="true"], [disabled], [aria-disabled="true"], input[type="password"]')) {
        return false;
      }

      // Walk across shadow/DOM ancestors for inline display/visibility/opacity/host exclusion.
      let isFixed = false;
      let cur = el;
      while (cur) {
        if (cur.nodeType === 1) {
          if (isSleepwalkerUiNode(cur)) return false;
          if (cur.hidden || (cur.hasAttribute && cur.hasAttribute('hidden'))) return false;
          if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
          if (cur.disabled || (cur.hasAttribute && cur.hasAttribute('disabled'))) return false;
          if (cur.getAttribute && cur.getAttribute('aria-disabled') === 'true') return false;
          if (win && typeof win.getComputedStyle === 'function') {
            const st = win.getComputedStyle(cur);
            if (st) {
              if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
              if (st.position === 'fixed') isFixed = true;
            }
          } else if (cur.style) {
            if (cur.style.display === 'none' || cur.style.visibility === 'hidden' || cur.style.opacity === '0') return false;
            if (cur.style.position === 'fixed') isFixed = true;
          }
          cur = cur.parentNode || (cur.getRootNode && cur.getRootNode().host) || null;
        } else if (cur.nodeType === 11 && cur.host) {
          cur = cur.host;
        } else {
          break;
        }
      }

      // Skip CSS visually-hidden / screen-reader-only traps (e.g. "Skip to main content" clipped to 1px)
      const clsStr = typeof el.className === 'string' ? el.className : '';
      if (/\b(?:visually-hidden|sr-only|screen-reader-text)\b/i.test(clsStr)) return false;
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          const ownSt = win.getComputedStyle(el);
          if (ownSt && (ownSt.clip === 'rect(0px, 0px, 0px, 0px)' || ownSt.clip === 'rect(1px, 1px, 1px, 1px)' || /^inset\(50%\)/.test(ownSt.clipPath || ''))) {
            return false;
          }
        } catch (_e) {}
      }

      if (rect) {
        if (rect.width <= 1 || rect.height <= 1) return false;
        const vw = (topWin && topWin.innerWidth) || 1280;
        const vh = (topWin && topWin.innerHeight) || 800;
        // Skip offscreen-fixed junk and clipped/screen-reader-only -9999px traps.
        if (isFixed && (rect.right <= 0 || rect.left >= vw || rect.bottom <= 0 || rect.top >= vh)) {
          return false;
        }
        if (rect.left < -1500 || rect.top < -1500) {
          return false;
        }
        if (rect.width <= 2 && rect.height <= 2 && rect.left < 0) {
          return false;
        }
      }
      return true;
    }

    _extractLabelInfo(el, doc) {
      const attr = (name) => (el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : '') || '';
      const ariaLabel = cleanSpace(attr('aria-label'));
      let labelledByText = '';
      const labelledByIds = attr('aria-labelledby');
      if (labelledByIds && doc && typeof doc.getElementById === 'function') {
        labelledByText = cleanSpace(
          labelledByIds
            .split(/\s+/)
            .map((id) => doc.getElementById(id))
            .filter(Boolean)
            .map((node) => node.innerText || node.textContent || '')
            .join(' ')
        );
      }
      const inner = cleanSpace(el.innerText || el.textContent || '');
      const title = cleanSpace(attr('title'));
      const tag = String(el.tagName || '').toLowerCase();
      const type = attr('type').toLowerCase();
      const valueCap = (tag === 'input' && ['submit', 'button', 'reset'].includes(type))
        ? cleanSpace(attr('value') || el.value || '')
        : '';

      let imgAlt = '';
      if (typeof el.querySelector === 'function') {
        const img = el.querySelector('img[alt]');
        if (img) imgAlt = cleanSpace(img.getAttribute('alt') || '');
      }

      let label = ariaLabel || labelledByText || inner || valueCap || imgAlt || title || '';
      // Strip decorative trailing menu chevrons/guillemets ("Company »" -> "Company") so spoken labels are clean
      label = label.replace(/\s*[»›▾▼⌄▸►]+\s*$/g, '').trim();

      // Enrich cryptic icon/1-char labels into clear human-readable spoken labels!
      const elId = String(el.id || '');
      const elCls = typeof el.className === 'string' ? el.className : '';
      if (/^[×✕✖✗x]$/i.test(label)) {
        label = title || (/close|dismiss|modal/i.test(`${elId} ${elCls}`) ? 'Close dialog' : 'Close');
      } else if (/^a[+-]?$/i.test(label)) {
        if (title) label = title;
        else if (/\+|inc|plus|large/i.test(`${label} ${elId}`)) label = 'Increase font size';
        else if (/-|dec|minus|small/i.test(`${label} ${elId}`)) label = 'Decrease font size';
        else if (/font|reset|text/i.test(`${elId} ${elCls}`)) label = 'Reset font size';
      } else if (/^\d{1,2}$/.test(label)) {
        const inCarousel = Boolean(el.closest && el.closest('.carousel, .carousel-indicators, .slick-dots, .owl-dots, .swiper-pagination, [data-slide-to], [data-bs-slide-to]')) ||
          Boolean(attr('data-slide-to') || attr('data-bs-slide-to'));
        if (title) label = title;
        else if (inCarousel) label = `Slide ${label}`;
        else label = `Page ${label}`;
      } else if (/^(?:click\s*here|here|read\s+more|learn\s+more|know\s+more|more|view|details)$/i.test(label)) {
        // Enrich generic links ("Click here", "Read more") with surrounding row/card/paragraph context
        const ctxEl = el.closest && el.closest('li, td, tr, p, .card, article, .alert, .notice, .banner');
        let ctxText = '';
        if (ctxEl) {
          ctxText = cleanSpace(ctxEl.innerText || ctxEl.textContent || '')
            .replace(new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), '')
            .replace(/^[\s:–—-]+|[\s:–—-]+$/g, '')
            .trim();
        }
        if (title && title.length > label.length) {
          label = title;
        } else if (ctxText && ctxText.length >= 4) {
          label = `${ctxText.slice(0, 46).trim()} (${label})`;
        } else {
          const hrefHint = extractHrefWords(attr('href'));
          if (hrefHint && hrefHint.length >= 3) label = `${hrefHint.slice(0, 36)} (${label})`;
        }
      }

      // Drop cookie-consent & sponsored-ad clutter from actionable voice targets
      if (AD_OR_COOKIE_NOISE_RE.test(label)) {
        return { label: '', ariaLabel: '', title: '' };
      }

      return { label, ariaLabel: ariaLabel || labelledByText, title };
    }

    _detectArea(el) {
      if (!el || typeof el.closest !== 'function') return { area: 'page', inMain: false };
      const inMain = Boolean(el.closest('main, [role="main"], article'));
      if (el.closest('nav, [role="navigation"], .nav, .navbar, .menu, [role="menu"], [role="menubar"]')) {
        return { area: 'nav', inMain };
      }
      if (el.closest('header, [role="banner"]')) {
        return { area: 'header', inMain };
      }
      if (el.closest('footer, [role="contentinfo"]')) {
        return { area: 'footer', inMain };
      }
      if (el.closest('.card, [class*="card"], [data-card], article')) {
        return { area: 'card', inMain };
      }
      if (el.closest('ul, ol, [role="list"]')) {
        return { area: 'list', inMain };
      }
      if (inMain) {
        return { area: 'main', inMain: true };
      }
      return { area: 'page', inMain: false };
    }

    _extractHeadingPath(el) {
      if (!el || typeof el.closest !== 'function') return [];
      const doc = el.ownerDocument || this._getDoc();
      const bodyNode = doc ? doc.body : null;
      const path = [];
      let cur = el.parentElement;
      // Check Wikipedia / structured section wrappers first, or walk enclosing sections backward
      while (cur && cur !== bodyNode) {
        if (cur.matches && cur.matches('section, article, [data-section], .mw-heading')) {
          const directH = cur.querySelector ? cur.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]') : null;
          if (directH) {
            const txt = cleanSpace(directH.innerText || directH.textContent || '');
            if (txt && !path.includes(txt)) path.unshift(txt.slice(0, 80));
          }
        }
        cur = cur.parentElement;
      }

      if (doc && typeof doc.querySelectorAll === 'function' && typeof el.compareDocumentPosition === 'function') {
        const heads = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
        const stack = [];
        for (let i = 0; i < heads.length; i++) {
          const h = heads[i];
          if (h.closest && h.closest('#sleepwalker-host, #sleepwalker-ui-host')) continue;
          const rel = h.compareDocumentPosition(el);
          // 4 = FOLLOWING, 16 = CONTAINS (el inside heading)
          if (h !== el && (rel & 4) === 0 && (rel & 16) === 0) break;
          const txt = cleanSpace(h.innerText || h.textContent || '');
          if (!txt) continue;
          const tag = String(h.tagName || '').toUpperCase();
          const lvl = /^H[1-6]$/.test(tag) ? Number(tag.slice(1)) : (Number(h.getAttribute('aria-level')) || 2);
          while (stack.length > 0 && stack[stack.length - 1].lvl >= lvl) stack.pop();
          stack.push({ lvl, txt: txt.slice(0, 80) });
        }
        if (stack.length > 0) {
          return stack.map((s) => s.txt);
        }
      }
      return path;
    }

    _extractListContext(el) {
      if (!el || typeof el.closest !== 'function') return '';
      const parts = [];
      let li = el.closest('li');
      let hops = 0;
      while (li && hops < 4) {
        hops += 1;
        // Collect direct bold/lead text or parent item label outside nested ul/ol
        let prefix = '';
        const kids = li.childNodes || [];
        for (let i = 0; i < kids.length; i++) {
          const k = kids[i];
          if (k.nodeType === 3) {
            prefix += ' ' + (k.nodeValue || '');
          } else if (k.nodeType === 1 && !/^(UL|OL|MENU)$/i.test(k.tagName)) {
            if (/^(STRONG|B|SPAN|P|A|H[1-6])$/i.test(k.tagName) && !k.contains(el)) {
              prefix += ' ' + (k.innerText || k.textContent || '');
            } else if (/^(STRONG|B)$/i.test(k.tagName)) {
              prefix += ' ' + (k.innerText || k.textContent || '');
            }
          }
        }
        const cleaned = cleanSpace(prefix).slice(0, 70);
        if (cleaned) parts.unshift(cleaned);
        li = li.parentElement ? li.parentElement.closest('li') : null;
      }

      const dd = el.closest('dd');
      if (dd && dd.previousElementSibling && /^DT$/i.test(dd.previousElementSibling.tagName)) {
        const dtTxt = cleanSpace(dd.previousElementSibling.innerText || dd.previousElementSibling.textContent || '').slice(0, 70);
        if (dtTxt) parts.unshift(dtTxt);
      }
      return parts.join(' > ');
    }

    _extractTableContext(el) {
      if (!el || typeof el.closest !== 'function') return null;
      const cell = el.closest('td, th');
      const row = cell ? cell.closest('tr') : null;
      const tbl = row ? row.closest('table') : null;
      if (!cell || !row || !tbl) return null;

      const capEl = tbl.querySelector ? tbl.querySelector('caption') : null;
      const caption = capEl ? cleanSpace(capEl.innerText || capEl.textContent || '').slice(0, 70) : '';
      const cellIndex = Array.from(row.children || []).indexOf(cell);
      let colHeader = '';
      if (cellIndex >= 0 && tbl.querySelectorAll) {
        const headerRow = tbl.querySelector('thead tr') || tbl.querySelector('tr');
        if (headerRow && headerRow.children && headerRow.children[cellIndex]) {
          colHeader = cleanSpace(headerRow.children[cellIndex].innerText || headerRow.children[cellIndex].textContent || '').slice(0, 50);
        }
      }
      const rowText = cleanSpace(row.innerText || row.textContent || '').slice(0, 110);
      return { caption, colHeader, rowText };
    }

    _extractContext(el) {
      if (!el || typeof el.closest !== 'function') {
        return { heading: '', sectionPath: [], sectionPathText: '', listContext: '', tableContext: null, snippet: '', text: '' };
      }
      const box = el.closest('.card, [class*="card"], article, li, tr, section, aside, div') || el.parentElement;
      const sectionPath = this._extractHeadingPath(el);
      let heading = sectionPath.length > 0 ? sectionPath[sectionPath.length - 1] : '';
      let snippet = '';

      if (box) {
        if (!heading) {
          const headingEl = typeof box.querySelector === 'function'
            ? box.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], .card-title, caption')
            : null;
          if (headingEl) {
            heading = cleanSpace(headingEl.innerText || headingEl.textContent || '');
          }
        }
        snippet = this._safeContainerText(box);
      }

      // If container has no heading, walk back across siblings/sections to find nearest preceding heading.
      if (!heading) {
        let probe = el.closest('section, article, div, main') || el;
        for (let step = 0; step < 5 && probe && !heading; step++) {
          let sib = probe.previousElementSibling;
          while (sib && !heading) {
            if (/^H[1-6]$/.test(sib.tagName) || (sib.getAttribute && sib.getAttribute('role') === 'heading')) {
              heading = cleanSpace(sib.innerText || sib.textContent || '');
              break;
            }
            if (sib.querySelector) {
              const innerH = sib.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
              if (innerH) {
                heading = cleanSpace(innerH.innerText || innerH.textContent || '');
                break;
              }
            }
            sib = sib.previousElementSibling;
          }
          probe = probe.parentElement;
        }
      }

      const listContext = this._extractListContext(el);
      const tableContext = this._extractTableContext(el);
      const finalPath = sectionPath.length > 0 ? sectionPath : (heading ? [heading] : []);
      const sectionPathText = finalPath.join(' > ');
      const clippedSnippet = snippet.slice(0, CONTEXT_SNIPPET_MAX).trim();
      const prefix = [sectionPathText || heading, listContext, tableContext && tableContext.rowText].filter(Boolean).join(' | ');
      const text = prefix
        ? (clippedSnippet && !clippedSnippet.toLowerCase().startsWith(prefix.toLowerCase())
          ? `${prefix} — ${clippedSnippet}`
          : clippedSnippet || prefix)
        : clippedSnippet;

      return {
        heading,
        sectionPath: finalPath,
        sectionPathText,
        listContext,
        tableContext,
        snippet: clippedSnippet,
        text
      };
    }

    _safeContainerText(container) {
      if (!container) return '';
      if (!container.childNodes || container.childNodes.length === 0) {
        return cleanSpace(container.innerText || container.textContent || '').slice(0, 260);
      }
      const chunks = [];
      let totalLen = 0;
      const walkText = (node) => {
        if (!node || totalLen >= 260) return;
        if (node.nodeType === 3) {
          const t = String(node.nodeValue || '').trim();
          if (t) {
            chunks.push(t);
            totalLen += t.length + 1;
          }
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = String(node.tagName || '').toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (isSleepwalkerUiNode(node) || node.hidden || (node.hasAttribute && node.hasAttribute('hidden'))) return;
        if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
        if (node.style && (node.style.display === 'none' || node.style.visibility === 'hidden')) return;
        const kids = node.childNodes || [];
        for (let i = 0; i < kids.length; i++) walkText(kids[i]);
      };
      walkText(container);
      return cleanSpace(chunks.join(' ')).slice(0, 260);
    }

    _detectFlags(el, doc, label, rawHref, resolvedHref, rect, topWin, inMain) {
      const vw = (topWin && topWin.innerWidth) || 1280;
      const vh = (topWin && topWin.innerHeight) || 800;
      const inViewport = rect
        ? (rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw)
        : true;

      const attr = (n) => (el && typeof el.getAttribute === 'function' ? el.getAttribute(n) : '') || '';
      const hasAttr = (n) => Boolean(el && typeof el.hasAttribute === 'function' && el.hasAttribute(n));
      const newTab = attr('target').toLowerCase() === '_blank';
      const download = hasAttr('download') || DOWNLOAD_EXT_RE.test(rawHref) || DOWNLOAD_LABEL_RE.test(label);

      let external = false;
      let domain = '';
      if (resolvedHref && rawHref && !rawHref.startsWith('#') && !/^javascript:/i.test(rawHref)) {
        try {
          const curHref = (topWin && topWin.location && topWin.location.href) || (doc && doc.location && doc.location.href) || '';
          const targetUrl = new URL(resolvedHref, curHref || 'https://local.invalid/');
          domain = targetUrl.hostname || '';
          if (curHref) {
            const curUrl = new URL(curHref);
            external =
              (curUrl.protocol.startsWith('http') && targetUrl.protocol.startsWith('http') && curUrl.origin !== targetUrl.origin) ||
              (curUrl.protocol === 'file:' && targetUrl.protocol.startsWith('http'));
          }
        } catch (_e) {}
      }

      const combinedMeta = `${label} ${rawHref} ${domain}`.toLowerCase();
      const isForumOrBlog = /(?:medium\.com|towardsdatascience|dev\.to|reddit\.com|quora\.com|stackoverflow\.com|w3schools|geeksforgeeks|tutorialspoint|blogger|substack|blog\.)/i.test(domain)
        || /\b(?:unofficial|blog\s*post|forum|community\s*guide|tutorial\s+series)\b/i.test(label);
      const isDocsOrOfficial = !isForumOrBlog && (
        /^(?:docs|documentation|developer|api)\.|pytorch\.org|python\.org|reactjs\.org|react\.dev|nodejs\.org|mozilla\.org|\.(?:gov|edu|ac\.[a-z]{2})(?:$|\.)/i.test(domain)
        || /\/(?:docs|documentation|reference|api|manual|official)(?:\/|$)/i.test(rawHref)
        || /\b(?:official\s+(?:site|website|docs|documentation)|api\s+reference|documentation)\b/i.test(label)
      );
      const isMedia = /\b(?:youtube\.com|youtu\.be|vimeo\.com)\b/i.test(domain) || Boolean(el.closest && el.closest('ytd-video-renderer, .video-card, [data-video-id]'));
      const category = download
        ? 'download'
        : isMedia
          ? 'media'
          : isDocsOrOfficial
            ? (/\/(?:docs|documentation|reference|api)\b/i.test(combinedMeta) ? 'documentation' : 'official')
            : (isForumOrBlog ? 'tutorial' : (external ? 'external' : 'article'));

      const typeAttr = attr('type').toLowerCase();
      const risky = Boolean(
        typeAttr === 'submit' ||
        LOGOUT_RE.test(label) || /\blogout\b|\bsignout\b/i.test(rawHref) ||
        DELETE_RE.test(label) || /\bdelete[-_]?account\b/i.test(rawHref) ||
        PAY_RE.test(label) || PAY_RE.test(rawHref) ||
        SUBMIT_RE.test(label)
      );

      return { external, download, newTab, risky, inViewport, inMain, official: isDocsOrOfficial, category, domain };
    }

    _detectRole(el) {
      const attrRole = String((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
      if (attrRole === 'link' || attrRole === 'button' || attrRole === 'tab' || attrRole === 'menuitem') {
        return attrRole;
      }
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'a') return 'link';
      return 'button';
    }

    _collectRoots(rootNode, topWin, doc, frameOffset, visitedEls, outEntries) {
      if (!rootNode) return;
      const win = doc && doc.defaultView ? doc.defaultView : topWin;

      // Traverse children in DOM order so reading order is preserved even across shadow roots & same-origin iframes.
      const walker = (parent) => {
        const children = parent.children || [];
        for (let i = 0; i < children.length; i++) {
          const el = children[i];
          if (isSleepwalkerUiNode(el)) continue;

          if (!visitedEls.has(el) && this._isNativeInteractive(el, win)) {
            visitedEls.add(el);
            const rect = this._getAdjustedRect(el, frameOffset);
            if (this._isVisibleAndValid(el, doc, win, topWin, rect)) {
              const labelInfo = this._extractLabelInfo(el, doc);
              if (labelInfo.label) {
                const rawHref = (el.getAttribute && el.getAttribute('href')) || '';
                const resolvedHref = resolveUrlSafe(el, doc);
                const areaInfo = this._detectArea(el);
                const contextInfo = this._extractContext(el);
                const flags = this._detectFlags(el, doc, labelInfo.label, rawHref, resolvedHref, rect, topWin, areaInfo.inMain);
                outEntries.push({
                  element: el,
                  label: labelInfo.label,
                  ariaLabel: labelInfo.ariaLabel,
                  title: labelInfo.title,
                  href: resolvedHref,
                  rawHref,
                  hrefWords: extractHrefWords(rawHref || resolvedHref),
                  role: this._detectRole(el),
                  area: areaInfo.area,
                  domain: flags.domain || '',
                  category: flags.category || 'article',
                  context: contextInfo.text,
                  contextHeading: contextInfo.heading,
                  sectionPath: contextInfo.sectionPath || [],
                  sectionPathText: contextInfo.sectionPathText || contextInfo.heading || '',
                  listContext: contextInfo.listContext || '',
                  tableContext: contextInfo.tableContext || null,
                  contextSnippet: contextInfo.snippet,
                  position: {
                    order: outEntries.length,
                    rect: rect || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
                    inViewport: flags.inViewport
                  },
                  flags
                });
              }
            }
          }

          if (el.shadowRoot && el.shadowRoot.mode === 'open') {
            this._collectRoots(el.shadowRoot, topWin, doc, frameOffset, visitedEls, outEntries);
          }

          if (String(el.tagName || '').toLowerCase() === 'iframe') {
            try {
              const idoc = el.contentDocument;
              if (idoc && idoc.documentElement && el.style.display !== 'none' && !el.hidden) {
                const fr = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
                const nextOffset = {
                  left: (frameOffset ? frameOffset.left : 0) + (fr ? fr.left : 0),
                  top: (frameOffset ? frameOffset.top : 0) + (fr ? fr.top : 0)
                };
                this._collectRoots(idoc.body || idoc.documentElement, topWin, idoc, nextOffset, visitedEls, outEntries);
              }
            } catch (_crossOrigin) {
              // Ignore cross-origin iframes safely.
            }
          }

          walker(el);
        }
      };

      // Fallback for mock DOMs without .children traversal support (querySelectorAll only)
      if (!rootNode.children && typeof rootNode.querySelectorAll === 'function') {
        const list = Array.from(rootNode.querySelectorAll(TARGET_SELECTOR));
        for (let i = 0; i < list.length; i++) {
          const el = list[i];
          if (visitedEls.has(el) || !this._isNativeInteractive(el, win)) continue;
          visitedEls.add(el);
          const rect = this._getAdjustedRect(el, frameOffset);
          if (!this._isVisibleAndValid(el, doc, win, topWin, rect)) continue;
          const labelInfo = this._extractLabelInfo(el, doc);
          if (!labelInfo.label) continue;
          const rawHref = (el.getAttribute && el.getAttribute('href')) || '';
          const resolvedHref = resolveUrlSafe(el, doc);
          const areaInfo = this._detectArea(el);
          const contextInfo = this._extractContext(el);
          const flags = this._detectFlags(el, doc, labelInfo.label, rawHref, resolvedHref, rect, topWin, areaInfo.inMain);
          outEntries.push({
            element: el,
            label: labelInfo.label,
            ariaLabel: labelInfo.ariaLabel,
            title: labelInfo.title,
            href: resolvedHref,
            rawHref,
            hrefWords: extractHrefWords(rawHref || resolvedHref),
            role: this._detectRole(el),
            area: areaInfo.area,
            domain: flags.domain || '',
            category: flags.category || 'article',
            context: contextInfo.text,
            contextHeading: contextInfo.heading,
            sectionPath: contextInfo.sectionPath || [],
            sectionPathText: contextInfo.sectionPathText || contextInfo.heading || '',
            listContext: contextInfo.listContext || '',
            tableContext: contextInfo.tableContext || null,
            contextSnippet: contextInfo.snippet,
            position: {
              order: outEntries.length,
              rect: rect || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
              inViewport: flags.inViewport
            },
            flags
          });
        }
        return;
      }

      walker(rootNode);
    }

    rebuild(doc = this._getDoc()) {
      const topWin = this._getWin();
      this._dirty = false;
      this._pendingMutation = false;
      if (!doc) {
        this._targets = [];
        return this._targets;
      }

      const rawEntries = [];
      const visitedEls = new Set();
      this._collectRoots(doc.body || doc.documentElement, topWin, doc, null, visitedEls, rawEntries);

      // Deduplicate identical (href + label) entries; keep distinct same-label buttons only when in distinct headings.
      const deduped = [];
      const seenKeys = new Set();
      for (let i = 0; i < rawEntries.length; i++) {
        const item = rawEntries[i];
        const normLabel = cleanSpace(item.label).toLowerCase();
        const key = `${item.role}|${normLabel}|${item.href || ''}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        deduped.push(item);
      }

      // Cap at 300 targets, preferring elements in viewport and main content.
      let selected = deduped;
      if (deduped.length > this.maxTargets) {
        const prioritized = deduped.slice().sort((a, b) => {
          const scoreA = (a.flags.inViewport ? 4 : 0) + (a.flags.inMain ? 2 : 0);
          const scoreB = (b.flags.inViewport ? 4 : 0) + (b.flags.inMain ? 2 : 0);
          if (scoreB !== scoreA) return scoreB - scoreA;
          return a.position.order - b.position.order;
        });
        selected = prioritized.slice(0, this.maxTargets).sort((a, b) => a.position.order - b.position.order);
      }

      const vw = (topWin && topWin.innerWidth) || 1280;
      const vh = (topWin && topWin.innerHeight) || 800;
      const areaCounters = Object.create(null);

      this._targets = selected.map((item, idx) => {
        areaCounters[item.area] = (areaCounters[item.area] || 0) + 1;
        const rect = item.position.rect;
        const isTopRight = rect.width > 0 && rect.top >= 0 && rect.top <= vh * 0.25 && rect.left >= vw * 0.65;
        return {
          id: idx + 1,
          element: item.element,
          label: item.label,
          ariaLabel: item.ariaLabel,
          title: item.title,
          href: item.href,
          hrefWords: item.hrefWords,
          role: item.role,
          area: item.area,
          domain: item.domain || '',
          category: item.category || 'article',
          context: item.context,
          contextHeading: item.contextHeading,
          sectionPath: item.sectionPath || [],
          sectionPathText: item.sectionPathText || item.contextHeading || '',
          listContext: item.listContext || '',
          tableContext: item.tableContext || null,
          contextSnippet: item.contextSnippet,
          position: {
            index: idx,
            areaIndex: areaCounters[item.area] - 1,
            rect,
            inViewport: item.flags.inViewport,
            isTopRight
          },
          flags: item.flags
        };
      });

      this._lastBuiltAt = Date.now();
      return this._targets;
    }

    /**
     * Debug helper exposed as window.__SW_LINKS__(): prints the index as a table and returns summary rows.
     */
    debugTable() {
      const list = this.getTargets(false);
      const rows = list.map((t) => ({
        id: t.id,
        label: t.label,
        role: t.role,
        area: t.area,
        hrefWords: t.hrefWords,
        context: t.context,
        viewport: t.flags.inViewport,
        flags: ['external', 'download', 'newTab', 'risky'].filter((k) => t.flags[k]).join(',') || '-'
      }));
      if (typeof console !== 'undefined' && typeof console.table === 'function') {
        console.table(rows);
      }
      return rows;
    }
  }

  const defaultInstance = new SleepwalkerLinkIndex();
  return { SleepwalkerLinkIndex, defaultInstance, extractHrefWords };
});
