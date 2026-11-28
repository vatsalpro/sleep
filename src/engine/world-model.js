/**
 * Sleepwalker - world-model.js
 * Phase 4.3: Hybrid Browser World Model
 *
 * Unifies:
 * A. Browser Observation Engine (navigation, controls, options, headings, lists, tables, media, forms)
 * B. Adaptive Discovery Engine (Mode 1: static_content, Mode 2: progressive_feed Batch 1..N, Mode 3: dynamic_app incremental updates)
 * C. Page World Model & Lightweight Entity-Relationship Graph (CONTAINS, CHILD_OF, LINKED_TO, DESCRIBES, BELONGS_TO, NEXT_ITEM, PREVIOUS_ITEM, RECOMMENDED_WITH, SELECTED_AS, LOCATED_IN_SECTION)
 * D. Semantic Page Retrieval (`nomic-embed-text` cached per-page entity retrieval, strictly separated from conversation memory)
 * E. Per-Tab Inventory Isolation, Candidate Reacquisition & Verification
 *
 * Security / Privacy guarantees:
 * - Never reads password, OTP, CVV, payment, hidden, or user-typed sensitive input values.
 * - Never includes sensitive inputs in prompts, graph edges, or embeddings.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerWorldModel = api.SleepwalkerWorldModel;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const EDGE_TYPES = {
    CONTAINS: 'CONTAINS',
    CHILD_OF: 'CHILD_OF',
    CONTROLS: 'CONTROLS',
    EXPANDS: 'EXPANDS',
    LINKED_TO: 'LINKED_TO',
    DESCRIBES: 'DESCRIBES',
    BELONGS_TO: 'BELONGS_TO',
    NEXT_ITEM: 'NEXT_ITEM',
    PREVIOUS_ITEM: 'PREVIOUS_ITEM',
    RECOMMENDED_WITH: 'RECOMMENDED_WITH',
    SELECTED_AS: 'SELECTED_AS',
    LOCATED_IN_SECTION: 'LOCATED_IN_SECTION'
  };

  const DISCOVERY_MODES = {
    STATIC: 'static_content',
    PROGRESSIVE_FEED: 'progressive_feed',
    DYNAMIC_APP: 'dynamic_app'
  };

  const FEED_BATCH_SIZE = 10;
  const MAX_FEED_BATCH_ITEMS = 60;
  const SENSITIVE_TEXT_RE = /\b(?:password|passwd|pwd|otp|one[-_\s]?time|passcode|pin|cvv|cvc|card\s*number|aadhaar|aadhar|pan\s*card|secret|ssn|captcha|bearer|token)\b/i;

  function cleanText(raw) {
    return String(raw || '').replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }

  function hashQuick(str) {
    const input = String(str || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${(h >>> 0).toString(16).padStart(8, '0')}-${input.length}`;
  }

  function getAttr(el, name) {
    return (el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : '') || '';
  }

  function padId(prefix, num) {
    return `${prefix}${String(num).padStart(3, '0')}`;
  }

  function getDigestApi() {
    if (root && root.SleepwalkerDigest) return root.SleepwalkerDigest;
    if (typeof require === 'function') {
      try { return require('../intelligence/digest.js'); } catch (_e) { return null; }
    }
    return null;
  }

  function getLinkIndexApi() {
    if (root && root.SleepwalkerLinkIndexInstance) return root.SleepwalkerLinkIndexInstance;
    if (typeof require === 'function') {
      try {
        const mod = require('./link-index.js');
        return mod && mod.defaultInstance ? mod.defaultInstance : null;
      } catch (_e) { return null; }
    }
    return null;
  }

  function getMemoryClass() {
    if (root && root.SleepwalkerMemory) return root.SleepwalkerMemory;
    if (typeof require === 'function') {
      try { return require('../intelligence/memory.js'); } catch (_e) { return null; }
    }
    return null;
  }

  // Domain-free concept synonym expansions for offline deterministic fallback alongside nomic-embed-text
  const CONCEPT_EXPANSIONS = {
    neural: ['deep', 'learning', 'perceptron', 'backpropagation', 'network', 'ai', 'ml', 'layer', 'activation'],
    networks: ['neural', 'deep', 'learning', 'architecture', 'layers', 'weights'],
    beginner: ['intro', 'introduction', 'crash', 'basics', 'fundamentals', '101', 'explained', 'examples', 'started'],
    decorators: ['wrapper', 'function', 'python', 'closure'],
    tutorial: ['guide', 'walkthrough', 'lesson', 'course', 'examples', 'explained'],
    advantages: ['benefits', 'pros', 'strengths', 'merits', 'value', 'why'],
    disadvantages: ['drawbacks', 'cons', 'limitations', 'risks', 'challenges'],
    documentation: ['docs', 'reference', 'manual', 'api', 'guide', 'official'],
    privacy: ['security', 'confidential', 'data', 'protection']
  };

  function computeFallbackConceptVector(text) {
    const clean = cleanText(text).toLowerCase().replace(/[^a-z0-9\u0900-\u097f\s]/gi, ' ');
    const tokens = clean.split(/\s+/).filter((t) => t.length >= 2);
    const expanded = new Set(tokens);
    for (const tok of tokens) {
      if (CONCEPT_EXPANSIONS[tok]) {
        for (const syn of CONCEPT_EXPANSIONS[tok]) expanded.add(syn);
      }
      if (tok.length >= 4) expanded.add(tok.slice(0, 4));
    }
    const vec = new Array(64).fill(0);
    for (const tok of expanded) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = (h >>> 0) % 64;
      const sign = ((h >>> 8) & 1) ? 1 : -1;
      vec[idx] += sign * (tokens.includes(tok) ? 1.4 : 0.75);
    }
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
    return norm > 0 ? vec.map((v) => v / norm) : vec;
  }

  function cosineSim(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? dot / denom : 0;
  }

  class SleepwalkerWorldModel {
    constructor(controller = null, options = {}) {
      this.controller = controller || null;
      this.tabInventories = new Map(); // tabId -> PageWorldInventory
      this.pageEmbedCache = new Map(); // `${urlClean}::${contentHash}` -> vector (strictly separate from conversation memory)
      this.retrievalCache = new Map(); // `${tabId}::${invVer}::${navId}::${mode}::${q}` -> topK candidates while DOM stays clean
      this._mutationObserver = null;
      this._observedDoc = null;
      this._mutationTimer = null;
      this._proactiveScanTimer = null;
      this._scanning = false;
      this.onScanStateChange = typeof options.onScanStateChange === 'function' ? options.onScanStateChange : null;
      // Candidate identities are scoped to this content-script lifetime and advance
      // independently per tab. A random epoch prevents collisions after reload or
      // content-script recreation (including while the MV3 worker is suspended).
      this._navigationEpoch = (root.crypto && typeof root.crypto.randomUUID === 'function')
        ? root.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      this._navigationGenerations = new Map();
      this.embedRequester = typeof options.embedRequester === 'function' ? options.embedRequester : null;
      this._lastDevSnapshot = null;
    }

    _getTabId() {
      if (this.controller && this.controller.memory && this.controller.memory.tabId) {
        return String(this.controller.memory.tabId);
      }
      return 'default';
    }

    _getDoc(explicitDoc = null) {
      return explicitDoc || (typeof document !== 'undefined' ? document : null);
    }

    _getUrlClean(doc) {
      const digestApi = getDigestApi();
      if (digestApi && typeof digestApi.getCleanUrl === 'function') {
        return digestApi.getCleanUrl(doc);
      }
      try {
        const href = (doc && doc.location && doc.location.href) || (typeof window !== 'undefined' && window.location && window.location.href) || 'unknown';
        return String(href).split(/[?#]/)[0];
      } catch (_e) {
        return 'unknown';
      }
    }

    _getNavigationUrl(doc) {
      try {
        return String((doc && doc.location && doc.location.href) || (typeof window !== 'undefined' && window.location && window.location.href) || 'unknown');
      } catch (_e) {
        return 'unknown';
      }
    }

    _advanceNavigationIdentity(tabId, inv) {
      const generation = Math.max(this._navigationGenerations.get(tabId) || 0, inv.navigationGeneration || 0) + 1;
      this._navigationGenerations.set(tabId, generation);
      inv.navigationGeneration = generation;
      inv.navigationIdentity = `${this._navigationEpoch}:${tabId}:${generation}`;
    }

    _isPrivacyBlocked() {
      const priv = this.controller && this.controller.memory && this.controller.memory.privacy;
      return Boolean(priv && priv.disablePageAnalysis);
    }

    /**
     * Component B — Adaptive Discovery Mode Selection (Section 5)
     * Classifies page into static_content | progressive_feed | dynamic_app.
     */
    detectDiscoveryMode(doc = this._getDoc(), pageType = 'general') {
      const pt = String(pageType || '').toLowerCase();
      if (pt === 'youtube_search' || pt === 'youtube_feed') {
        return DISCOVERY_MODES.PROGRESSIVE_FEED;
      }
      if (doc && typeof doc.querySelector === 'function') {
        const host = ((doc.location && doc.location.hostname) || '').toLowerCase();
        const explicitMode = cleanText(getAttr(doc.body || doc.documentElement, 'data-sw-discovery-mode')).toLowerCase();
        if (explicitMode && Object.values(DISCOVERY_MODES).includes(explicitMode)) {
          return explicitMode;
        }
        const feedSelector = 'ytd-rich-item-renderer, ytd-video-renderer, shreddit-feed, [data-feed], [data-video-id], .video-card[data-channel], .feed-list';
        if (/(?:youtube\.com|reddit\.com|instagram\.com|x\.com|twitter\.com|amazon\.)/i.test(host) ||
            (pt !== 'youtube_watch' && pt !== 'wikipedia' && doc.querySelectorAll(feedSelector).length >= 2)) {
          return DISCOVERY_MODES.PROGRESSIVE_FEED;
        }
        if (pt === 'wikipedia' || pt === 'documentation' || pt === 'article') {
          return DISCOVERY_MODES.STATIC;
        }
        const interactiveCount = doc.querySelectorAll('select, [role="combobox"], [role="radiogroup"], [role="tablist"], [aria-haspopup], input[type="radio"], input[type="checkbox"]').length;
        if (interactiveCount >= 3 || pt === 'form') {
          return DISCOVERY_MODES.DYNAMIC_APP;
        }
      }
      return DISCOVERY_MODES.STATIC;
    }

    /**
     * Start observing active tab and attach Mode 3 incremental MutationObserver.
     */
    async observeTab(doc = this._getDoc(), options = {}) {
      if (this._isPrivacyBlocked() || !doc) return null;
      const tabId = String(options.tabId || this._getTabId());
      const urlClean = this._getUrlClean(doc);
      const navigationUrl = this._getNavigationUrl(doc);
      const existing = this.tabInventories.get(tabId);
      if (existing && !options.force && !existing._staleSince && existing.urlClean === urlClean && existing.navigationUrl === navigationUrl && (Date.now() - existing.updatedAt) < 15000) {
        this._attachIncrementalObserver(doc, tabId);
        return existing;
      }
      this._emitScanState(true, options.scanLabel || 'Mapping page...');
      try {
        const inv = await this.buildPageWorldModel(doc, { ...options, tabId });
        this._attachIncrementalObserver(doc, tabId);
        return inv;
      } finally {
        this._emitScanState(false, '');
      }
    }

    _emitScanState(active, label = '') {
      this._scanning = Boolean(active);
      if (typeof this.onScanStateChange === 'function') {
        try { this.onScanStateChange(this._scanning, label); } catch (_e) {}
      }
    }

    /**
     * Proactive background scan: runs asynchronously without blocking browsing,
     * keeping the hierarchical page map fresh after page load, SPA nav, and DOM mutations.
     */
    scheduleProactiveScan(doc = this._getDoc(), options = {}) {
      if (this._isPrivacyBlocked() || !doc) return;
      if (this._proactiveScanTimer) {
        clearTimeout(this._proactiveScanTimer);
        this._proactiveScanTimer = null;
      }
      const runScan = () => {
        this._proactiveScanTimer = null;
        if (this._isPrivacyBlocked()) return;
        const tabId = String(options.tabId || this._getTabId());
        const curInv = this.tabInventories.get(tabId);
        if (curInv && options.incremental) {
          this._emitScanState(true, 'Updating page map...');
          this.buildPageWorldModel(doc, { tabId, incremental: true, prevVersion: curInv.inventoryVersion })
            .catch(() => null)
            .finally(() => this._emitScanState(false, ''));
        } else {
          this.observeTab(doc, { force: Boolean(options.force), scanLabel: options.scanLabel || 'Mapping page...' }).catch(() => null);
        }
      };
      const ric = root && typeof root.requestIdleCallback === 'function' ? root.requestIdleCallback : null;
      if (ric && !options.immediate) {
        this._proactiveScanTimer = setTimeout(() => {
          try { ric(runScan, { timeout: 450 }); } catch (_e) { runScan(); }
        }, Number(options.delayMs) >= 0 ? Number(options.delayMs) : 60);
      } else {
        this._proactiveScanTimer = setTimeout(runScan, Number(options.delayMs) >= 0 ? Number(options.delayMs) : 85);
      }
    }

    _attachIncrementalObserver(doc, tabId) {
      if (!doc || typeof MutationObserver !== 'function') return;
      if (this._mutationObserver && this._observedDoc === doc) return;
      this.disconnectObserver();
      const targetRoot = doc.body || doc.documentElement;
      if (!targetRoot) return;

      this._observedDoc = doc;
      this._lastIncrementalScanAt = this._lastIncrementalScanAt || 0;
      const MEDIA_NOISE_SEL = 'ytd-player, .html5-video-player, .ytp-chrome-bottom, .ytp-progress-bar-container, .ytp-time-display, yt-live-chat-app, ytd-live-chat-frame, video, audio, canvas, svg';
      this._mutationObserver = new MutationObserver((mutations) => {
        let relevant = false;
        for (let i = 0; i < mutations.length; i++) {
          const t = mutations[i].target;
          if (!t || (t.nodeType === 1 && (
            t.id === 'sleepwalker-host' ||
            t.id === 'sleepwalker-ui-host' ||
            t.id === 'sleepwalker-candidate-overlay-root' ||
            t.getAttribute?.('data-sleepwalker-ui') === '1' ||
            (t.closest && (
              t.closest('#sleepwalker-host, #sleepwalker-ui-host, #sleepwalker-candidate-overlay-root, [data-sleepwalker-ui="1"]') ||
              t.closest(MEDIA_NOISE_SEL)
            ))
          ))) {
            continue;
          }
          relevant = true;
          break;
        }
        if (!relevant) return;
        const curInv = this.tabInventories.get(tabId);
        if (curInv) curInv._staleSince = curInv._staleSince || Date.now();
        if (this._mutationTimer) clearTimeout(this._mutationTimer);
        const now = Date.now();
        const cooldownLeft = Math.max(0, 2500 - (now - (this._lastIncrementalScanAt || 0)));
        const delayMs = Math.max(450, cooldownLeft);
        this._mutationTimer = setTimeout(() => {
          this._mutationTimer = null;
          if (this._isPrivacyBlocked()) return;
          const runScan = () => {
            this._lastIncrementalScanAt = Date.now();
            this._emitScanState(true, 'Updating page map...');
            this.buildPageWorldModel(doc, { tabId, incremental: true, prevVersion: curInv ? curInv.inventoryVersion : 0 })
              .catch(() => null)
              .finally(() => this._emitScanState(false, ''));
          };
          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(runScan, { timeout: 1500 });
          } else {
            runScan();
          }
        }, delayMs);
      });
      this._mutationObserver.observe(targetRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'aria-expanded', 'aria-selected', 'aria-checked', 'disabled']
      });
    }

    disconnectObserver() {
      if (this._proactiveScanTimer) {
        clearTimeout(this._proactiveScanTimer);
        this._proactiveScanTimer = null;
      }
      if (this._mutationTimer) {
        clearTimeout(this._mutationTimer);
        this._mutationTimer = null;
      }
      if (this._mutationObserver) {
        this._mutationObserver.disconnect();
        this._mutationObserver = null;
      }
      this._observedDoc = null;
    }

    /**
     * Component A + C: Observe full hierarchical DOM -> build entities, typed IDs,
     * relationship graph, and Mode 1/2/3 adaptive batches cleanly.
     */
    async buildPageWorldModel(doc = this._getDoc(), options = {}) {
      if (this._isPrivacyBlocked() || !doc) return null;
      const digestApi = getDigestApi();
      const linkIndex = getLinkIndexApi();
      const tabId = String(options.tabId || this._getTabId());
      const prevInv = this.tabInventories.get(tabId);
      const urlClean = this._getUrlClean(doc);
      const navigationUrl = this._getNavigationUrl(doc);
      const sameUrl = Boolean(prevInv && prevInv.urlClean === urlClean);
      const nextVersion = sameUrl ? (prevInv.inventoryVersion + 1) : 1;

      const structured = (digestApi && typeof digestApi.buildStructuredPageContext === 'function')
        ? digestApi.buildStructuredPageContext(doc)
        : { title: cleanText(doc.title), urlClean, website: 'local', pageType: 'general', sections: [], links: [], tables: [], videos: [], watchVideo: null, searchFields: [], chunks: [] };

      const pageType = structured.pageType || 'general';
      const discoveryMode = this.detectDiscoveryMode(doc, pageType);
      const now = Date.now();

      const entities = new Map();
      const edges = [];
      const addEdge = (from, type, to) => {
        if (!from || !to) return;
        edges.push({ from, type, to });
      };

      const pageNodeId = 'PAGE_ROOT';
      entities.set(pageNodeId, {
        id: pageNodeId,
        type: 'page',
        title: structured.title || cleanText(doc.title) || 'Untitled',
        urlClean,
        website: structured.website || 'local',
        pageType,
        tabId,
        inventoryVersion: nextVersion
      });

      // 1. Section Hierarchy Nodes (S001...)
      const sectionNodes = [];
      const sectionByTitle = new Map();
      const rawSections = Array.isArray(structured.sections) ? structured.sections : [];
      for (let i = 0; i < rawSections.length; i++) {
        const s = rawSections[i];
        const sid = padId('S', i + 1);
        const parentNode = s.parentSection ? sectionByTitle.get(s.parentSection.toLowerCase()) : null;
        const node = {
          id: sid,
          type: 'section',
          label: s.text,
          level: s.level || 2,
          parentSectionId: parentNode ? parentNode.id : pageNodeId,
          parentSection: s.parentSection || '',
          ancestorHeadings: Array.isArray(s.sectionPath) ? s.sectionPath.slice() : [s.text],
          subsectionIndex: s.subsectionIndex || 1,
          position: i + 1,
          tabId,
          inventoryVersion: nextVersion,
          discoveredAt: now
        };
        entities.set(sid, node);
        sectionNodes.push(node);
        if (!sectionByTitle.has(s.text.toLowerCase())) {
          sectionByTitle.set(s.text.toLowerCase(), node);
        }
        addEdge(parentNode ? parentNode.id : pageNodeId, EDGE_TYPES.CONTAINS, sid);
        addEdge(sid, EDGE_TYPES.CHILD_OF, parentNode ? parentNode.id : pageNodeId);
        if (i > 0) {
          addEdge(sectionNodes[i - 1].id, EDGE_TYPES.NEXT_ITEM, sid);
          addEdge(sid, EDGE_TYPES.PREVIOUS_ITEM, sectionNodes[i - 1].id);
        }
      }

      const resolveSectionId = (secName = '', secPath = []) => {
        if (secName && sectionByTitle.has(secName.toLowerCase())) {
          return sectionByTitle.get(secName.toLowerCase()).id;
        }
        if (Array.isArray(secPath) && secPath.length > 0) {
          for (let i = secPath.length - 1; i >= 0; i--) {
            const hit = sectionByTitle.get(String(secPath[i] || '').toLowerCase());
            if (hit) return hit.id;
          }
        }
        return pageNodeId;
      };

      // 2. Navigation Links (L001...) & Buttons (B001...)
      const links = [];
      const buttons = [];
      let rawLinks = [];
      if (linkIndex && typeof linkIndex.getTargets === 'function') {
        rawLinks = linkIndex.getTargets(Boolean(options.force || options.incremental)) || [];
      }
      if (rawLinks.length === 0 && Array.isArray(structured.links)) {
        rawLinks = structured.links;
      }

      const rawFeedCardTitles = discoveryMode === DISCOVERY_MODES.PROGRESSIVE_FEED
        ? new Set(this._extractExtendedFeedCards(doc, MAX_FEED_BATCH_ITEMS, digestApi).map((v) => cleanText(v.title).toLowerCase()).filter(Boolean))
        : null;

      for (let i = 0; i < rawLinks.length && (links.length + buttons.length) < 450; i++) {
        const t = rawLinks[i];
        if (!t || !t.label || SENSITIVE_TEXT_RE.test(t.label)) continue;
        if (rawFeedCardTitles && rawFeedCardTitles.has(cleanText(t.label).toLowerCase())) continue;
        if (t.element && typeof t.element.closest === 'function' && t.element.closest('.video-card, [data-video-id], ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer')) {
          continue;
        }
        // Skip non-href tabs/menuitems from links so they remain distinct controls/options instead of fake links
        if ((t.role === 'tab' || t.role === 'menuitem') && !t.href) continue;
        // Do not collapse distinct buttons or skip non-href buttons; distinguish buttons vs links cleanly
        const isButton = t.role === 'button' && !t.href;
        const id = isButton ? padId('B', buttons.length + 1) : padId('L', links.length + 1);
        const secTitle = t.contextHeading || t.section || '';
        const secId = resolveSectionId(secTitle, t.sectionPath);
        const spatialAria = this._inspectElementSpatialAndAria(t.element, doc);
        const navMeta = this._classifyNavigationContext(t.element, t.area || 'page');
        const item = {
          id,
          type: isButton ? 'button' : 'link',
          role: t.role || (isButton ? 'button' : 'link'),
          label: t.label,
          visibleText: t.label,
          accessibleName: t.ariaLabel || spatialAria.accessibleName || t.label,
          parentSection: secTitle || (t.area || 'page'),
          parentSectionId: secId,
          ancestorHeadings: Array.isArray(t.sectionPath) ? t.sectionPath : (secTitle ? [secTitle] : []),
          listContext: t.listContext || '',
          nearbyText: t.contextSnippet || t.context || '',
          destinationUrl: t.href || '',
          domain: t.domain || '',
          category: t.category || (t.flags && t.flags.category) || 'article',
          navCategory: navMeta.navCategory,
          parentMenuLabel: navMeta.parentMenuLabel || t.listContext || '',
          expandable: Boolean(spatialAria.hasPopup || spatialAria.ariaExpanded !== null || navMeta.nestedMenu),
          clickableCard: navMeta.clickableCard,
          official: Boolean((t.flags && t.flags.official) || t.official),
          external: Boolean(t.flags && t.flags.external),
          visible: spatialAria.visibilityState !== 'hidden' && (t.flags ? t.flags.inViewport !== false : true),
          visibilityState: spatialAria.visibilityState,
          inViewport: spatialAria.inViewport,
          quadrant: spatialAria.quadrant,
          covered: spatialAria.covered,
          enabled: !(t.element && (t.element.disabled || getAttr(t.element, 'aria-disabled') === 'true')),
          selected: Boolean(t.element && (getAttr(t.element, 'aria-current') || getAttr(t.element, 'aria-selected') === 'true')),
          expanded: spatialAria.ariaExpanded,
          hasPopup: spatialAria.hasPopup,
          focused: spatialAria.focused,
          inShadowRoot: Boolean(t.inShadowRoot || spatialAria.inShadowRoot),
          inIframe: Boolean(t.inIframe || spatialAria.inIframe),
          area: t.area || 'page',
          position: (links.length + buttons.length) + 1,
          discoveredAt: now,
          inventoryVersion: nextVersion,
          tabId,
          element: t.element || null
        };
        entities.set(id, item);
        if (isButton) buttons.push(item);
        else links.push(item);
        addEdge(id, EDGE_TYPES.LOCATED_IN_SECTION, secId);
        addEdge(secId, EDGE_TYPES.CONTAINS, id);
        if (item.destinationUrl) addEdge(id, EDGE_TYPES.LINKED_TO, item.destinationUrl);
      }

      // 3. Interactive Controls & Option Hierarchy (O001... grouped under Control/Section & B### fallback)
      const optionsList = [];
      const controlsList = [];
      let selectorInst = (this.controller && this.controller.elementSelector) ||
        (root && root.SleepwalkerElementSelector ? new root.SleepwalkerElementSelector(this.controller) : null);
      if (!selectorInst && typeof require === 'function') {
        try {
          const esMod = require('./element-select.js');
          if (esMod && esMod.SleepwalkerElementSelector) selectorInst = new esMod.SleepwalkerElementSelector(this.controller);
        } catch (_e) {}
      }

      const rawCands = selectorInst && typeof selectorInst.detectInteractiveCandidates === 'function'
        ? selectorInst.detectInteractiveCandidates(doc)
        : [];

      for (let i = 0; i < rawCands.length; i++) {
        const c = rawCands[i];
        const rawElType = c && c.element ? String(getAttr(c.element, 'type') || c.element.type || '').toLowerCase() : '';
        const isPasswordCtrl = Boolean(c && (rawElType === 'password' || /\bpassword\b/i.test(c.label || '')));
        if (!c || (c.sensitive && !isPasswordCtrl)) continue;
        if (c.elementType === 'button') {
          // Register non-duplicate buttons cleanly into B### if not already indexed above
          const alreadyB = buttons.some((b) => b.element && c.element && b.element === c.element);
          if (!alreadyB && c.label && !SENSITIVE_TEXT_RE.test(c.label)) {
            const bid = padId('B', buttons.length + 1);
            const secId = resolveSectionId(c.section || c.nearbyHeading, []);
            const bSpatial = this._inspectElementSpatialAndAria(c.element, doc);
            const bNav = this._classifyNavigationContext(c.element, 'page');
            const bItem = {
              id: bid,
              type: 'button',
              role: 'button',
              label: c.label,
              visibleText: c.visibleText || c.label,
              accessibleName: c.accessibleName || bSpatial.accessibleName || c.label,
              parentSection: c.section || c.nearbyHeading || c.formContext || 'page',
              parentSectionId: secId,
              ancestorHeadings: [c.nearbyHeading, c.section].filter(Boolean),
              nearbyText: c.parentContainer || '',
              navCategory: bNav.navCategory,
              expandable: Boolean(bSpatial.hasPopup || bSpatial.ariaExpanded !== null),
              visible: bSpatial.visibilityState !== 'hidden' && c.visible !== false,
              visibilityState: bSpatial.visibilityState,
              inViewport: bSpatial.inViewport,
              quadrant: bSpatial.quadrant,
              covered: bSpatial.covered,
              enabled: !c.disabled,
              selected: Boolean(c.checked || bSpatial.ariaSelected === 'true' || bSpatial.ariaPressed === 'true'),
              expanded: bSpatial.ariaExpanded,
              hasPopup: bSpatial.hasPopup,
              focused: bSpatial.focused,
              position: buttons.length + 1,
              discoveredAt: now,
              inventoryVersion: nextVersion,
              tabId,
              underlyingCandidateId: c.id,
              element: c.element || null
            };
            entities.set(bid, bItem);
            buttons.push(bItem);
            addEdge(bid, EDGE_TYPES.LOCATED_IN_SECTION, secId);
            addEdge(secId, EDGE_TYPES.CONTAINS, bid);
          }
          continue;
        }

        const ctrlId = padId('C', controlsList.length + 1);
        let secTitle = c.parentContainer || c.section || c.nearbyHeading || c.formContext || '';
        if ((!secTitle || secTitle.toLowerCase() === String(c.label || '').toLowerCase()) && c.element && typeof c.element.closest === 'function') {
          const outerRegion = c.element.closest('section, article, aside, [role="region"]');
          if (outerRegion && typeof outerRegion.querySelector === 'function') {
            const outerH = outerRegion.querySelector('h1, h2, h3, h4, [role="heading"]');
            const outerTxt = outerH ? cleanText(outerH.innerText || outerH.textContent) : '';
            if (outerTxt && outerTxt.toLowerCase() !== String(c.label || '').toLowerCase()) {
              secTitle = outerTxt;
            }
          }
        }
        const secId = resolveSectionId(secTitle, []);
        const cSpatial = this._inspectElementSpatialAndAria(c.element, doc);
        const tagLower = String(c.tag || (c.element && c.element.tagName) || '').toLowerCase();
        const expectedInputType = isPasswordCtrl
          ? 'password'
          : (tagLower === 'textarea' ? 'textarea' : (tagLower === 'select' ? 'select' : (rawElType || c.elementType || 'text')));
        const isReq = Boolean(c.element && (c.element.required || getAttr(c.element, 'aria-required') === 'true'));
        const valParts = [];
        if (c.element) {
          const pat = getAttr(c.element, 'pattern');
          const minAttr = getAttr(c.element, 'min');
          const maxAttr = getAttr(c.element, 'max');
          const accAttr = getAttr(c.element, 'accept');
          if (pat) valParts.push(`pattern:${pat.slice(0, 24)}`);
          if (minAttr) valParts.push(`min:${minAttr}`);
          if (maxAttr) valParts.push(`max:${maxAttr}`);
          if (accAttr) valParts.push(`accept:${accAttr.slice(0, 24)}`);
        }
        const prevSelectCtrl = (['select', 'custom_dropdown', 'searchable_dropdown'].includes(c.elementType))
          ? [...controlsList].reverse().find((pc) => pc.formKey === (c.formKey || 'page') && ['select', 'custom_dropdown', 'searchable_dropdown'].includes(pc.elementType))
          : null;
        const explicitDep = c.element ? cleanText(getAttr(c.element, 'data-depends-on') || getAttr(c.element, 'data-parent-field')) : '';
        const dependentOf = explicitDep || ((prevSelectCtrl && /\b(?:state|province|city|district|course|department|university)\b/i.test(c.label || '')) ? prevSelectCtrl.label : '');
        const ctrlNode = {
          id: ctrlId,
          type: 'control',
          elementType: c.elementType,
          expectedInputType,
          required: isReq,
          validationHint: valParts.join(' '),
          dependentOf,
          sensitive: isPasswordCtrl,
          role: cSpatial.role || c.elementType,
          label: c.label,
          accessibleName: c.accessibleName || cSpatial.accessibleName || c.label,
          parentSection: secTitle || 'page',
          parentSectionId: secId,
          ancestorHeadings: Array.from(new Set([secTitle, c.nearbyHeading, c.section, c.formContext].filter(Boolean))),
          formKey: c.formKey || 'page',
          currentValue: isPasswordCtrl ? '' : (c.currentValue || ''),
          availableValues: (!isPasswordCtrl && Array.isArray(c.options)) ? c.options.slice(0, 12).map((o) => o && o.label).filter(Boolean) : [],
          enabled: !c.disabled,
          visible: cSpatial.visibilityState !== 'hidden' && c.visible !== false,
          visibilityState: cSpatial.visibilityState,
          inViewport: cSpatial.inViewport,
          quadrant: cSpatial.quadrant,
          covered: cSpatial.covered,
          selected: Boolean(c.checked || cSpatial.ariaSelected === 'true'),
          expanded: cSpatial.ariaExpanded,
          hasPopup: cSpatial.hasPopup,
          focused: cSpatial.focused,
          position: controlsList.length + 1,
          discoveredAt: now,
          inventoryVersion: nextVersion,
          tabId,
          underlyingCandidateId: c.id,
          element: c.element || null
        };
        entities.set(ctrlId, ctrlNode);
        controlsList.push(ctrlNode);
        addEdge(ctrlId, EDGE_TYPES.LOCATED_IN_SECTION, secId);
        addEdge(secId, EDGE_TYPES.CONTAINS, ctrlId);

        // Expose individual selectable options (O001...) with parent control & section relationships!
        if (Array.isArray(c.options) && c.options.length > 0) {
          for (let oi = 0; oi < c.options.length; oi++) {
            const opt = c.options[oi];
            if (!opt || !opt.label || SENSITIVE_TEXT_RE.test(opt.label)) continue;
            const oid = padId('O', optionsList.length + 1);
            const oSpatial = this._inspectElementSpatialAndAria(opt.element || c.element, doc);
            const optNode = {
              id: oid,
              type: 'option',
              elementType: c.elementType,
              role: oSpatial.role || c.elementType,
              label: opt.label,
              visibleText: opt.label,
              accessibleName: opt.label,
              value: opt.value !== undefined ? String(opt.value) : opt.label,
              parentGroupLabel: c.label,
              parentControlId: ctrlId,
              parentSection: secTitle || c.label,
              parentSectionId: secId,
              ancestorHeadings: [c.nearbyHeading, c.section, c.label].filter(Boolean),
              nearbyText: `${c.label} (${c.elementType})`,
              enabled: !c.disabled && !opt.disabled,
              visible: oSpatial.visibilityState !== 'hidden' && c.visible !== false,
              visibilityState: oSpatial.visibilityState,
              inViewport: oSpatial.inViewport,
              quadrant: oSpatial.quadrant,
              covered: oSpatial.covered,
              selected: Boolean(opt.selected || (opt.element && (opt.element.checked || getAttr(opt.element, 'aria-checked') === 'true' || getAttr(opt.element, 'aria-selected') === 'true'))),
              price: opt.price,
              position: oi + 1,
              discoveredAt: now,
              inventoryVersion: nextVersion,
              tabId,
              underlyingCandidateId: c.id,
              controlCandidate: c,
              optionDescriptor: opt,
              element: opt.element || c.element || null
            };
            entities.set(oid, optNode);
            optionsList.push(optNode);
            addEdge(oid, EDGE_TYPES.CHILD_OF, ctrlId);
            addEdge(ctrlId, EDGE_TYPES.CONTAINS, oid);
            addEdge(oid, EDGE_TYPES.BELONGS_TO, ctrlId);
            addEdge(oid, EDGE_TYPES.LOCATED_IN_SECTION, secId);
            if (optNode.selected) addEdge(oid, EDGE_TYPES.SELECTED_AS, ctrlId);
          }
        } else {
          // Single-node control (checkbox, switch, range slider, text field, tab, dropdown trigger without preloaded options)
          const oid = padId('O', optionsList.length + 1);
          const singleNode = {
            ...ctrlNode,
            id: oid,
            type: 'option',
            parentGroupLabel: cleanText(c.parentContainer || c.section || c.nearbyHeading || c.label || ''),
            parentControlId: ctrlId,
            optionDescriptor: null,
            controlCandidate: c
          };
          entities.set(oid, singleNode);
          optionsList.push(singleNode);
          addEdge(oid, EDGE_TYPES.CHILD_OF, ctrlId);
          addEdge(ctrlId, EDGE_TYPES.CONTAINS, oid);
        }
      }

      // 4. Content Snippets / Articles (A001...) & Tables (T001...)
      const articles = [];
      const chunks = Array.isArray(structured.chunks) ? structured.chunks : [];
      for (let i = 0; i < chunks.length && i < 24; i++) {
        const ch = chunks[i];
        if (!ch || !ch.text || SENSITIVE_TEXT_RE.test(ch.text)) continue;
        const aid = padId('A', articles.length + 1);
        const secId = resolveSectionId(ch.section, []);
        const art = {
          id: aid,
          type: 'content',
          label: ch.section || `Section ${i + 1}`,
          text: ch.text.slice(0, 500),
          parentSection: ch.section || 'Overview',
          parentSectionId: secId,
          position: i + 1,
          discoveredAt: now,
          inventoryVersion: nextVersion,
          tabId
        };
        entities.set(aid, art);
        articles.push(art);
        addEdge(aid, EDGE_TYPES.DESCRIBES, secId);
        addEdge(aid, EDGE_TYPES.LOCATED_IN_SECTION, secId);
      }

      const tables = [];
      const rawTables = Array.isArray(structured.tables) ? structured.tables : [];
      for (let i = 0; i < rawTables.length; i++) {
        const tbl = rawTables[i];
        const tid = padId('T', tables.length + 1);
        const secId = resolveSectionId(tbl.section, tbl.sectionPath);
        const tNode = {
          id: tid,
          type: 'table',
          label: tbl.caption || tbl.section || `Table ${i + 1}`,
          parentSection: tbl.section || '',
          parentSectionId: secId,
          headers: tbl.headers || [],
          rows: tbl.rows || [],
          discoveredAt: now,
          inventoryVersion: nextVersion,
          tabId
        };
        entities.set(tid, tNode);
        tables.push(tNode);
        addEdge(tid, EDGE_TYPES.LOCATED_IN_SECTION, secId);
        addEdge(secId, EDGE_TYPES.CONTAINS, tid);
      }

      // 5. Media / Progressive Feed Items (V001...)
      // In progressive_feed mode: cap Batch 1 to 10 (or preserve previously discovered batches + add up to batchLimit)
      const videoBatchCap = discoveryMode === DISCOVERY_MODES.PROGRESSIVE_FEED
        ? Math.min(MAX_FEED_BATCH_ITEMS, Number(options.feedLimit) || (sameUrl && prevInv ? Math.max(FEED_BATCH_SIZE, prevInv.discoveredFeedLimit || FEED_BATCH_SIZE) : FEED_BATCH_SIZE))
        : 20;

      const { videos, hasMoreFeedInDom, watchVideo } = this._collectFeedAndWatchMedia(doc, structured, {
        limit: videoBatchCap,
        sameUrl,
        prevVideos: sameUrl && prevInv ? prevInv.videos : [],
        tabId,
        inventoryVersion: nextVersion,
        now
      });

      for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        entities.set(v.id, v);
        addEdge(pageNodeId, EDGE_TYPES.CONTAINS, v.id);
        if (i > 0) {
          addEdge(videos[i - 1].id, EDGE_TYPES.NEXT_ITEM, v.id);
          addEdge(v.id, EDGE_TYPES.PREVIOUS_ITEM, videos[i - 1].id);
        }
        if (structured.pageType === 'youtube_watch' && structured.watchVideo) {
          addEdge(v.id, EDGE_TYPES.RECOMMENDED_WITH, 'WATCH_ACTIVE');
        }
      }

      // 4b. Traverse open Shadow DOM (recursively) & same-origin iframes safely; note cross-origin iframes
      const iframesInfo = [];
      this._discoverShadowAndIframeInteractive(doc, {
        links,
        buttons,
        controlsList,
        optionsList,
        entities,
        iframesInfo,
        resolveSectionId,
        addEdge,
        tabId,
        nextVersion,
        now
      });

      // 4c. Discover hierarchical triggers (accordions, <details>/<summary>, custom dropdowns,
      //     tabs, nested menus, aria-controls panels) and link parent->child CONTROLS/EXPANDS/CHILD_OF edges
      const scrollableRegions = this._discoverScrollableRegions(doc);
      this._linkHierarchicalRelationships(doc, {
        links,
        buttons,
        controlsList,
        optionsList,
        entities,
        resolveSectionId,
        addEdge,
        tabId,
        nextVersion,
        now
      });

      let nextNavigationGeneration = this._navigationGenerations.get(tabId) || 0;
      let navigationChanged = !prevInv || prevInv.urlClean !== urlClean || prevInv.navigationUrl !== navigationUrl || prevInv.document !== doc;
      if (!navigationChanged && prevInv && prevInv.entities) {
        for (const previous of prevInv.entities.values()) {
          if (!previous || !previous.element || !['link', 'button', 'control', 'option'].includes(previous.type)) continue;
          const current = entities.get(previous.id);
          if (previous.element.isConnected === false || !current || current.element !== previous.element ||
              current.label !== previous.label || current.role !== previous.role) {
            navigationChanged = true;
            break;
          }
        }
      }
      if (navigationChanged || nextNavigationGeneration === 0) nextNavigationGeneration += 1;
      this._navigationGenerations.set(tabId, nextNavigationGeneration);
      const navigationIdentity = `${this._navigationEpoch}:${tabId}:${nextNavigationGeneration}`;

      const mediaImages = this._collectVisibleImages(doc);
      const inventory = {
        tabId,
        urlClean,
        navigationUrl,
        document: doc,
        navigationGeneration: nextNavigationGeneration,
        navigationIdentity,
        title: structured.title || cleanText(doc.title) || 'Page',
        website: structured.website || 'local',
        pageType,
        discoveryMode,
        inventoryVersion: nextVersion,
        updatedAt: now,
        discoveredFeedLimit: videoBatchCap,
        batchCount: videos.length > 0 ? Math.max(...videos.map((v) => v.batchNumber || 1)) : 1,
        hasMoreFeedInDom,
        entities,
        edges,
        sections: sectionNodes,
        links,
        buttons,
        options: optionsList,
        controls: controlsList,
        articles,
        tables,
        videos,
        images: mediaImages,
        iframes: iframesInfo,
        scrollableRegions,
        searchFields: structured.searchFields || [],
        watchVideo: watchVideo || null,
        fullSafeText: structured.fullSafeText || '',
        pageTextHash: structured.pageTextHash || hashQuick(urlClean + sectionNodes.length)
      };
      inventory.hierarchicalMap = this.getHierarchicalMapSummary(inventory);

      // Every entity reference carries the page generation where it was indexed.
      // Routine re-observation of the same live DOM preserves that identity.
      for (const entity of entities.values()) {
        if (entity && typeof entity === 'object') entity.navigationIdentity = navigationIdentity;
      }

      this.tabInventories.set(tabId, inventory);
      this._syncTabInventorySummaryToMemory(inventory);
      if (this.controller && this.controller.browserEngine) {
        try {
          this.controller.browserEngine.invalidateCache();
          this.controller.browserEngine.observe(doc, {
            force: true,
            tabId,
            navigationIdentity
          });
        } catch (_e) {}
      }
      return inventory;
    }

    _classifyNavigationContext(el, fallbackArea = 'page') {
      const out = { navCategory: fallbackArea === 'nav' ? 'main_nav' : 'content', parentMenuLabel: '', nestedMenu: false, clickableCard: false };
      if (!el || typeof el.closest !== 'function') return out;
      const role = getAttr(el, 'role').toLowerCase();
      if (role === 'tab' || el.closest('[role="tablist"], .tabs, [data-tabs]')) {
        out.navCategory = 'tabs';
      } else if (el.closest('nav[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, [role="navigation"][aria-label*="breadcrumb" i]')) {
        out.navCategory = 'breadcrumb';
      } else if (el.closest('aside, [role="complementary"], .sidebar, ytd-guide-renderer, ytd-mini-guide-renderer')) {
        out.navCategory = 'sidebar';
      } else if (el.closest('[role="menu"], ul ul, .dropdown-menu, .submenu')) {
        out.navCategory = 'nested_menu';
        out.nestedMenu = true;
      } else if (el.closest('footer, [role="contentinfo"]')) {
        out.navCategory = 'footer_nav';
      } else if (el.closest('nav, header, [role="navigation"]')) {
        out.navCategory = 'main_nav';
      }
      if (el.closest('[role="menu"], li')) {
        const parentLi = el.closest('ul')?.closest('li');
        const parentTrigger = parentLi && parentLi.querySelector ? parentLi.querySelector(':scope > a, :scope > button, :scope > [role="menuitem"]') : null;
        if (parentTrigger && parentTrigger !== el) {
          out.parentMenuLabel = cleanText(parentTrigger.innerText || parentTrigger.textContent || getAttr(parentTrigger, 'aria-label')).slice(0, 60);
          out.nestedMenu = true;
        }
      }
      if (el.closest('.card, [data-card], article, [role="article"]') && (el.tagName === 'DIV' || el.tagName === 'ARTICLE' || el.tagName === 'A')) {
        out.clickableCard = Boolean(el.classList && /card/i.test(el.className || ''));
      }
      return out;
    }

    _collectVisibleImages(doc) {
      const out = [];
      if (!doc || typeof doc.querySelectorAll !== 'function') return out;
      const imgs = doc.querySelectorAll('img[alt]');
      for (let i = 0; i < imgs.length && out.length < 15; i++) {
        const img = imgs[i];
        const alt = cleanText(getAttr(img, 'alt')).slice(0, 100);
        if (!alt || alt.length < 3 || SENSITIVE_TEXT_RE.test(alt)) continue;
        if (img.closest && img.closest('#sleepwalker-ui-host, #sleepwalker-host')) continue;
        out.push({ id: `IMG${out.length + 1}`, alt });
      }
      return out;
    }

    getHierarchicalMapSummary(inv = null) {
      const targetInv = inv || this.getTabInventory();
      if (!targetInv) return null;
      const navGroups = {};
      for (const l of [...(targetInv.links || []), ...(targetInv.buttons || [])]) {
        const k = l.navCategory || 'content';
        if (!navGroups[k]) navGroups[k] = [];
        if (navGroups[k].length < 25) {
          navGroups[k].push({ id: l.id, label: l.label, parentMenu: l.parentMenuLabel || l.parentSection || '', expandable: Boolean(l.expandable) });
        }
      }
      const forms = [];
      for (const c of (targetInv.controls || [])) {
        forms.push({
          id: c.id,
          label: c.label,
          expectedInputType: c.expectedInputType || c.elementType,
          required: Boolean(c.required),
          dependentOf: c.dependentOf || '',
          currentValue: c.sensitive ? '' : (c.currentValue || ''),
          availableValuesCount: Array.isArray(c.availableValues) ? c.availableValues.length : 0,
          disabled: !c.enabled
        });
      }
      return {
        urlClean: targetInv.urlClean,
        pageType: targetInv.pageType,
        inventoryVersion: targetInv.inventoryVersion,
        navigation: navGroups,
        sections: (targetInv.sections || []).map((s) => ({ id: s.id, label: s.label, level: s.level, parentSection: s.parentSection })),
        forms,
        scrollableRegions: Array.isArray(targetInv.scrollableRegions) ? targetInv.scrollableRegions : [],
        expandableTriggers: [...(targetInv.buttons || []), ...(targetInv.controls || []), ...(targetInv.links || [])]
          .filter((x) => x && (x.expanded !== null && x.expanded !== undefined || x.hasPopup || x.isAccordionTrigger))
          .slice(0, 30)
          .map((x) => ({
            id: x.id,
            label: x.label,
            role: x.role,
            expanded: x.expanded,
            hasPopup: x.hasPopup || null,
            parentSection: x.parentSection || '',
            controlsIds: Array.isArray(x.controlsEntityIds) ? x.controlsEntityIds.slice(0, 12) : []
          })),
        tablesCount: (targetInv.tables || []).length,
        videosCount: (targetInv.videos || []).length,
        imagesCount: (targetInv.images || []).length
      };
    }

    /**
     * Compute accessibility name excluding nested combobox listboxes (OpenSidekick pattern),
     * ARIA flags, and 9-quadrant viewport/covered geometry.
     */
    _inspectElementSpatialAndAria(el, doc) {
      const fallback = {
        accessibleName: '',
        role: '',
        ariaExpanded: null,
        ariaSelected: null,
        ariaPressed: null,
        ariaDisabled: null,
        hasPopup: null,
        focused: false,
        quadrant: 'center',
        visibilityState: 'in_viewport',
        inViewport: true,
        covered: false,
        inShadowRoot: false,
        inIframe: false
      };
      if (!el || typeof el.getAttribute !== 'function') return fallback;

      const ownerDoc = el.ownerDocument || doc;
      const win = (ownerDoc && ownerDoc.defaultView) || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
      const role = getAttr(el, 'role').toLowerCase() || String(el.tagName || '').toLowerCase();
      const ariaLabel = getAttr(el, 'aria-label');
      let accName = ariaLabel;
      if (!accName && doc && typeof doc.getElementById === 'function') {
        const lby = getAttr(el, 'aria-labelledby');
        if (lby) {
          accName = cleanText(lby.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map((n) => n.innerText || n.textContent || '').join(' '));
        }
      }
      if (!accName) {
        // For combobox/select triggers with nested popup lists, exclude [role="listbox"]/[role="menu"] child text
        if (role === 'combobox' && typeof el.cloneNode === 'function' && typeof el.querySelector === 'function') {
          try {
            const hasNestedPopup = el.querySelector('[role="listbox"], [role="menu"], ul[role="listbox"]');
            if (hasNestedPopup) {
              const cloned = el.cloneNode(true);
              cloned.querySelectorAll('[role="listbox"], [role="menu"]').forEach((p) => p.remove());
              accName = cleanText(cloned.innerText || cloned.textContent || '');
            }
          } catch (_e) {}
        }
        if (!accName) accName = cleanText(el.innerText || el.textContent || el.value || '');
        if (!accName && typeof el.querySelector === 'function') {
          const innerImg = el.querySelector('img[alt], svg[aria-label], [title]');
          if (innerImg) accName = cleanText(getAttr(innerImg, 'alt') || getAttr(innerImg, 'aria-label') || getAttr(innerImg, 'title'));
        }
      }

      const vw = (win && win.innerWidth) || 1280;
      const vh = (win && win.innerHeight) || 768;
      let quadrant = 'center';
      let visibilityState = 'in_viewport';
      let inViewport = true;
      let covered = false;

      if (typeof el.getBoundingClientRect === 'function') {
        try {
          const rect = el.getBoundingClientRect();
          const hasBox = (rect.width || 0) > 0 || (rect.height || 0) > 0;
          if (!hasBox) {
            visibilityState = 'hidden';
            inViewport = false;
          } else {
            const cx = (rect.left || 0) + (rect.width || 0) / 2;
            const cy = (rect.top || 0) + (rect.height || 0) / 2;
            const hZone = cx < vw * 0.33 ? 'left' : (cx > vw * 0.67 ? 'right' : 'center');
            const vZone = cy < vh * 0.33 ? 'top' : (cy > vh * 0.67 ? 'bottom' : 'center');
            quadrant = (vZone === 'center' && hZone === 'center') ? 'center' : `${vZone}-${hZone}`;

            if (rect.bottom <= 0) {
              visibilityState = 'above_viewport';
              inViewport = false;
            } else if (rect.top >= vh) {
              visibilityState = 'below_viewport';
              inViewport = false;
            } else if (rect.top < 0 || rect.bottom > vh || rect.left < 0 || rect.right > vw) {
              visibilityState = 'partially_visible';
              inViewport = true;
            } else {
              visibilityState = 'in_viewport';
              inViewport = true;
            }

            const elementRoot = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
            const shadowRoot = elementRoot && elementRoot.host ? elementRoot : null;
            const hitTestRoot = shadowRoot && typeof shadowRoot.elementsFromPoint === 'function'
              ? elementRoot
              : ownerDoc;
            let owningFrame = null;
            if (ownerDoc && doc && ownerDoc !== doc && typeof doc.querySelectorAll === 'function') {
              try {
                owningFrame = Array.from(doc.querySelectorAll('iframe, frame')).find((frame) => frame.contentDocument === ownerDoc) || null;
              } catch (_e) {
                owningFrame = null;
              }
            }
            const validShadowHost = !shadowRoot || Boolean(shadowRoot.host && shadowRoot.host.ownerDocument === ownerDoc && shadowRoot.host.isConnected !== false);
            const validFrameOwner = ownerDoc === doc || Boolean(owningFrame && owningFrame.isConnected !== false);
            const isSleepwalkerUiNode = (node) => {
              if (!node) return false;
              if (node.id && /^sleepwalker-/i.test(node.id)) return true;
              return typeof node.closest === 'function' && Boolean(node.closest('#sleepwalker-floating-ui, #sleepwalker-candidate-overlay-root, [data-sleepwalker-ui="1"]'));
            };
            if ((!validShadowHost || !validFrameOwner) && inViewport) {
              covered = true;
              visibilityState = 'covered';
            } else if (inViewport && hitTestRoot && typeof hitTestRoot.elementsFromPoint === 'function' && cy >= 0 && cy <= vh && cx >= 0 && cx <= vw) {
              const stack = hitTestRoot.elementsFromPoint(cx, cy) || [];
              let rootTargetHit = false;
              for (let i = 0; i < stack.length; i++) {
                const topNode = stack[i];
                if (!topNode) continue;
                if (isSleepwalkerUiNode(topNode)) continue;
                rootTargetHit = topNode === el || (typeof el.contains === 'function' && el.contains(topNode)) || (typeof topNode.contains === 'function' && topNode.contains(el));
                if (!rootTargetHit) {
                  covered = true;
                  visibilityState = 'covered';
                }
                break;
              }
              if (stack.length === 0) rootTargetHit = false;

              // Nested-root hit testing confirms the target itself; a second
              // composed-page hit test confirms its shadow host or iframe is not
              // hidden behind an unrelated overlay.
              if (rootTargetHit && shadowRoot && doc && typeof doc.elementsFromPoint === 'function') {
                const outerTop = (doc.elementsFromPoint(cx, cy) || []).find((node) => node && !isSleepwalkerUiNode(node));
                const outerRoot = outerTop && typeof outerTop.getRootNode === 'function' ? outerTop.getRootNode() : null;
                const outerHitBelongsToTargetRoot = outerTop === el || outerRoot === shadowRoot;
                if (outerTop !== shadowRoot.host && !outerHitBelongsToTargetRoot) {
                  covered = true;
                  visibilityState = 'covered';
                }
              } else if (rootTargetHit && owningFrame && doc && typeof doc.elementsFromPoint === 'function') {
                const frameRect = owningFrame.getBoundingClientRect();
                const frameWidth = (owningFrame.contentWindow && owningFrame.contentWindow.innerWidth) || vw;
                const frameHeight = (owningFrame.contentWindow && owningFrame.contentWindow.innerHeight) || vh;
                const outerX = frameRect.left + (cx / frameWidth) * frameRect.width;
                const outerY = frameRect.top + (cy / frameHeight) * frameRect.height;
                const outerTop = (doc.elementsFromPoint(outerX, outerY) || []).find((node) => node && !isSleepwalkerUiNode(node));
                if (outerTop !== owningFrame) {
                  covered = true;
                  visibilityState = 'covered';
                }
              }
            }
          }
        } catch (_e) {}
      }

      const inShadowRoot = Boolean(typeof el.getRootNode === 'function' && el.getRootNode() && el.getRootNode().host);
      return {
        accessibleName: cleanText(accName).slice(0, 140),
        role,
        ariaExpanded: getAttr(el, 'aria-expanded') || null,
        ariaSelected: getAttr(el, 'aria-selected') || null,
        ariaPressed: getAttr(el, 'aria-pressed') || null,
        ariaDisabled: getAttr(el, 'aria-disabled') || null,
        hasPopup: getAttr(el, 'aria-haspopup') || null,
        focused: Boolean(doc && doc.activeElement === el),
        quadrant,
        visibilityState,
        inViewport,
        covered,
        inShadowRoot,
        inIframe: Boolean(doc && el.ownerDocument && el.ownerDocument !== doc)
      };
    }

    /**
     * Traverse open shadow roots & same-origin iframes (noting cross-origin iframes cleanly).
     */
    _discoverShadowAndIframeInteractive(doc, ctx) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return;
      const roots = [];
      const seenHosts = new Set();

      const collectOpenShadow = (searchDoc, depth = 0, parentLabel = '') => {
        if (!searchDoc || depth > 6 || typeof searchDoc.querySelectorAll !== 'function') return;
        const nodes = searchDoc.querySelectorAll('*');
        for (let i = 0; i < nodes.length && i < 800; i++) {
          const n = nodes[i];
          if (!n || n.id === 'sleepwalker-host' || n.id === 'sleepwalker-ui-host' || n.id === 'sleepwalker-candidate-overlay-root' || getAttr(n, 'data-sleepwalker-ui') === '1') {
            continue;
          }
          if (n.shadowRoot && !seenHosts.has(n)) {
            seenHosts.add(n);
            const heading = n.shadowRoot.querySelector && n.shadowRoot.querySelector('h1, h2, h3, h4, legend');
            const ownLabel = cleanText(getAttr(n, 'aria-label') || (heading && (heading.innerText || heading.textContent)) || n.tagName.toLowerCase());
            const combinedLabel = parentLabel && ownLabel && ownLabel !== parentLabel ? `${parentLabel} > ${ownLabel}` : (ownLabel || parentLabel);
            roots.push({ rootNode: n.shadowRoot, kind: 'shadow', label: combinedLabel, hostEl: n });
            collectOpenShadow(n.shadowRoot, depth + 1, combinedLabel);
          }
        }
      };
      collectOpenShadow(doc, 0, '');

      const iframes = doc.querySelectorAll('iframe');
      for (let i = 0; i < iframes.length && i < 8; i++) {
        const frame = iframes[i];
        const src = getAttr(frame, 'src') || '';
        const title = getAttr(frame, 'title') || getAttr(frame, 'aria-label') || '';
        try {
          const fDoc = frame.contentDocument;
          if (fDoc && fDoc.body) {
            ctx.iframesInfo.push({ index: i + 1, title, src, crossOrigin: false });
            roots.push({ rootNode: fDoc, kind: 'iframe', label: title || `iframe-${i + 1}` });
          } else {
            ctx.iframesInfo.push({ index: i + 1, title, src, crossOrigin: true });
          }
        } catch (_sec) {
          ctx.iframesInfo.push({ index: i + 1, title, src, crossOrigin: true });
        }
      }

      const existingEls = new Set([
        ...ctx.links.map((x) => x.element).filter(Boolean),
        ...ctx.buttons.map((x) => x.element).filter(Boolean),
        ...ctx.optionsList.map((x) => x.element).filter(Boolean)
      ]);

      for (const r of roots) {
        if (!r.rootNode || typeof r.rootNode.querySelectorAll !== 'function') continue;
        const items = r.rootNode.querySelectorAll('a[href], button, summary, input, select, textarea, [role="button"], [role="link"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="combobox"], [role="option"], [aria-expanded], [aria-haspopup]');
        for (let j = 0; j < items.length && j < 60; j++) {
          const el = items[j];
          if (!el || existingEls.has(el)) continue;
          const lbl = cleanText(
            getAttr(el, 'aria-label') ||
            (el.id && r.rootNode.querySelector && (r.rootNode.querySelector(`label[for="${el.id}"]`)?.innerText || '')) ||
            (el.closest && el.closest('label') && el.closest('label').innerText) ||
            el.innerText || el.textContent || getAttr(el, 'placeholder') || getAttr(el, 'name') || el.value || ''
          );
          if (!lbl || SENSITIVE_TEXT_RE.test(lbl)) continue;
          existingEls.add(el);

          const spatial = this._inspectElementSpatialAndAria(el, doc);
          const tag = String(el.tagName || '').toLowerCase();
          const inputType = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
          const role = getAttr(el, 'role').toLowerCase() || (tag === 'a' ? 'link' : (tag === 'button' || tag === 'summary' ? 'button' : (inputType || tag)));
          const isLink = tag === 'a' && Boolean(getAttr(el, 'href'));
          const isBtn = (role === 'button' || tag === 'button' || tag === 'summary') && !getAttr(el, 'aria-haspopup');
          const id = isLink ? padId('L', ctx.links.length + 1) : (isBtn ? padId('B', ctx.buttons.length + 1) : padId('O', ctx.optionsList.length + 1));
          const secId = ctx.resolveSectionId(r.label, []);
          const nodeObj = {
            id,
            type: isLink ? 'link' : (isBtn ? 'button' : 'option'),
            elementType: role,
            role,
            label: lbl,
            visibleText: lbl,
            accessibleName: spatial.accessibleName || lbl,
            parentSection: r.label || 'Embedded Component',
            parentGroupLabel: r.label || 'Embedded Component',
            parentSectionId: secId,
            ancestorHeadings: r.label ? [r.label] : [],
            destinationUrl: isLink ? (el.href || getAttr(el, 'href') || '') : '',
            currentValue: (tag === 'input' || tag === 'select' || tag === 'textarea') ? String(el.value || '') : '',
            visible: spatial.visibilityState !== 'hidden',
            visibilityState: spatial.visibilityState,
            inViewport: spatial.inViewport,
            quadrant: spatial.quadrant,
            covered: spatial.covered,
            enabled: !(el.disabled || getAttr(el, 'aria-disabled') === 'true'),
            selected: Boolean(el.checked || getAttr(el, 'aria-checked') === 'true' || getAttr(el, 'aria-selected') === 'true' || getAttr(el, 'aria-pressed') === 'true'),
            expanded: tag === 'summary' && el.parentElement && el.parentElement.tagName === 'DETAILS' ? String(Boolean(el.parentElement.open)) : spatial.ariaExpanded,
            hasPopup: spatial.hasPopup,
            isAccordionTrigger: tag === 'summary' || spatial.ariaExpanded !== null,
            inShadowRoot: r.kind === 'shadow',
            inIframe: r.kind === 'iframe',
            position: j + 1,
            discoveredAt: ctx.now,
            inventoryVersion: ctx.nextVersion,
            tabId: ctx.tabId,
            element: el
          };
          ctx.entities.set(id, nodeObj);
          if (nodeObj.type === 'link') ctx.links.push(nodeObj);
          else if (nodeObj.type === 'button') ctx.buttons.push(nodeObj);
          else ctx.optionsList.push(nodeObj);
          ctx.addEdge(id, EDGE_TYPES.LOCATED_IN_SECTION, secId);
          ctx.addEdge(secId, EDGE_TYPES.CONTAINS, id);
        }
      }
    }

    _discoverScrollableRegions(doc) {
      const regions = [];
      if (!doc || typeof doc.querySelectorAll !== 'function') return regions;
      const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
      if (!win || typeof win.getComputedStyle !== 'function') return regions;
      const candidates = doc.querySelectorAll('main, aside, nav, section, div[role="region"], div[role="listbox"], div[role="menu"], [data-scrollable], .sidebar, .filters');
      for (let i = 0; i < candidates.length && regions.length < 12; i++) {
        const el = candidates[i];
        if (!el || (el.closest && el.closest('#sleepwalker-host, #sleepwalker-ui-host'))) continue;
        try {
          const st = win.getComputedStyle(el);
          if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 24) {
            const h = el.querySelector && el.querySelector('h1, h2, h3, h4, [role="heading"]');
            regions.push({
              label: cleanText(getAttr(el, 'aria-label') || (h && (h.innerText || h.textContent)) || el.id || el.tagName.toLowerCase()).slice(0, 60),
              scrollTop: el.scrollTop,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              element: el
            });
          }
        } catch (_e) {}
      }
      return regions;
    }

    _linkHierarchicalRelationships(doc, ctx) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return;
      const elToEntity = new Map();
      for (const ent of ctx.entities.values()) {
        if (ent && ent.element) elToEntity.set(ent.element, ent);
      }

      // 1. Discover <summary> accordion triggers and [aria-expanded] / [aria-haspopup] / [role="tab"] / [role="menuitem"] triggers not yet indexed
      const triggers = doc.querySelectorAll('summary, [aria-expanded], [aria-controls], [aria-haspopup], [role="tab"], [role="menuitem"], [role="combobox"]');
      for (let i = 0; i < triggers.length && i < 120; i++) {
        const trig = triggers[i];
        if (!trig || (trig.closest && trig.closest('#sleepwalker-host, #sleepwalker-ui-host, [data-sleepwalker-ui="1"]'))) continue;
        let trigEnt = elToEntity.get(trig);
        const tag = String(trig.tagName || '').toLowerCase();
        const spatial = this._inspectElementSpatialAndAria(trig, doc);
        const expandedVal = (tag === 'summary' && trig.parentElement && trig.parentElement.tagName === 'DETAILS')
          ? String(Boolean(trig.parentElement.open))
          : spatial.ariaExpanded;

        if (!trigEnt) {
          const lbl = cleanText(spatial.accessibleName || trig.innerText || trig.textContent || getAttr(trig, 'aria-label') || '');
          if (!lbl || SENSITIVE_TEXT_RE.test(lbl)) continue;
          const id = padId('B', ctx.buttons.length + 1);
          const secId = ctx.resolveSectionId(lbl, []);
          trigEnt = {
            id,
            type: 'button',
            elementType: spatial.role || tag,
            role: spatial.role || tag,
            label: lbl.slice(0, 120),
            visibleText: lbl.slice(0, 120),
            accessibleName: (spatial.accessibleName || lbl).slice(0, 120),
            parentSection: lbl.slice(0, 60),
            parentSectionId: secId,
            ancestorHeadings: [lbl.slice(0, 60)],
            visible: spatial.visibilityState !== 'hidden',
            visibilityState: spatial.visibilityState,
            inViewport: spatial.inViewport,
            quadrant: spatial.quadrant,
            covered: spatial.covered,
            enabled: !(trig.disabled || getAttr(trig, 'aria-disabled') === 'true'),
            selected: Boolean(spatial.ariaSelected === 'true' || spatial.ariaPressed === 'true'),
            expanded: expandedVal,
            hasPopup: spatial.hasPopup,
            isAccordionTrigger: tag === 'summary' || expandedVal !== null,
            position: ctx.buttons.length + 1,
            discoveredAt: ctx.now,
            inventoryVersion: ctx.nextVersion,
            tabId: ctx.tabId,
            element: trig
          };
          ctx.entities.set(id, trigEnt);
          ctx.buttons.push(trigEnt);
          elToEntity.set(trig, trigEnt);
          ctx.addEdge(id, EDGE_TYPES.LOCATED_IN_SECTION, secId);
          ctx.addEdge(secId, EDGE_TYPES.CONTAINS, id);
        } else {
          trigEnt.expanded = expandedVal;
          trigEnt.hasPopup = spatial.hasPopup || trigEnt.hasPopup || null;
          trigEnt.isAccordionTrigger = Boolean(trigEnt.isAccordionTrigger || tag === 'summary' || expandedVal !== null);
        }

        // Resolve controlled/child container via aria-controls, <details>, or parent menu <li>
        let panel = null;
        const controlsId = getAttr(trig, 'aria-controls') || getAttr(trig, 'aria-owns');
        if (controlsId) {
          const rootNode = (trig.getRootNode && trig.getRootNode()) || doc;
          panel = (rootNode.getElementById && rootNode.getElementById(controlsId)) || (doc.getElementById && doc.getElementById(controlsId)) || null;
        }
        if (!panel && tag === 'summary' && trig.parentElement && trig.parentElement.tagName === 'DETAILS') {
          panel = trig.parentElement;
        }
        if (!panel && trig.parentElement) {
          const sib = trig.nextElementSibling;
          if (sib && (sib.matches?.('[role="menu"], [role="listbox"], [role="region"], ul, .submenu, .dropdown-menu, .accordion-panel, .filter-group-body'))) {
            panel = sib;
          }
        }
        if (panel && typeof panel.querySelectorAll === 'function') {
          trigEnt.controlsEntityIds = trigEnt.controlsEntityIds || [];
          const children = panel.querySelectorAll('a[href], button, input, select, [role="option"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="combobox"]');
          for (let ci = 0; ci < children.length && ci < 40; ci++) {
            const chEl = children[ci];
            if (chEl === trig) continue;
            let chEnt = elToEntity.get(chEl);
            if (!chEnt) {
              const chTag = String(chEl.tagName || '').toLowerCase();
              const chSpatial = this._inspectElementSpatialAndAria(chEl, doc);
              const wrapLbl = chEl.closest ? chEl.closest('label') : null;
              const chLbl = cleanText(
                chSpatial.accessibleName ||
                (wrapLbl && (wrapLbl.innerText || wrapLbl.textContent)) ||
                chEl.innerText ||
                chEl.textContent ||
                getAttr(chEl, 'aria-label') ||
                getAttr(chEl, 'value') ||
                ''
              );
              if (!chLbl || SENSITIVE_TEXT_RE.test(chLbl)) continue;
              const chId = padId('O', ctx.optionsList.length + 1);
              const chRole = chSpatial.role || (chTag === 'input' ? (getAttr(chEl, 'type') || 'input') : chTag);
              chEnt = {
                id: chId,
                type: 'option',
                elementType: chRole,
                role: chRole,
                label: chLbl.slice(0, 120),
                visibleText: chLbl.slice(0, 120),
                accessibleName: (chSpatial.accessibleName || chLbl).slice(0, 120),
                parentSection: trigEnt.parentSection || trigEnt.label,
                parentSectionId: trigEnt.parentSectionId || null,
                parentGroupLabel: trigEnt.label,
                parentTriggerId: trigEnt.id,
                parentTriggerLabel: trigEnt.label,
                ancestorHeadings: Array.isArray(trigEnt.ancestorHeadings) ? trigEnt.ancestorHeadings.slice() : [trigEnt.label],
                visible: chSpatial.visibilityState !== 'hidden',
                visibilityState: chSpatial.visibilityState,
                inViewport: chSpatial.inViewport,
                quadrant: chSpatial.quadrant,
                covered: chSpatial.covered,
                enabled: !(chEl.disabled || getAttr(chEl, 'aria-disabled') === 'true'),
                selected: Boolean(chEl.checked || chSpatial.ariaSelected === 'true' || chSpatial.ariaChecked === 'true'),
                position: ctx.optionsList.length + 1,
                discoveredAt: ctx.now,
                inventoryVersion: ctx.nextVersion,
                tabId: ctx.tabId,
                element: chEl
              };
              ctx.entities.set(chId, chEnt);
              ctx.optionsList.push(chEnt);
              elToEntity.set(chEl, chEnt);
            }
            if (!trigEnt.controlsEntityIds.includes(chEnt.id)) {
              trigEnt.controlsEntityIds.push(chEnt.id);
            }
            if (!chEnt.parentTriggerId) {
              chEnt.parentTriggerId = trigEnt.id;
              chEnt.parentTriggerLabel = trigEnt.label;
            }
            if (!chEnt.parentGroupLabel || chEnt.parentGroupLabel === 'page') {
              chEnt.parentGroupLabel = trigEnt.label;
            }
            ctx.addEdge(trigEnt.id, EDGE_TYPES.CONTROLS, chEnt.id);
            ctx.addEdge(trigEnt.id, EDGE_TYPES.EXPANDS, chEnt.id);
            ctx.addEdge(chEnt.id, EDGE_TYPES.CHILD_OF, trigEnt.id);
          }
        }
      }
    }

    _collectFeedAndWatchMedia(doc, structured, opts = {}) {
      const limit = opts.limit || FEED_BATCH_SIZE;
      const prevVideos = Array.isArray(opts.prevVideos) ? opts.prevVideos : [];
      const seen = new Set();
      const videos = [];

      const digestApi = getDigestApi();
      // Preserve previously discovered video IDs/positions when extending progressive batches
      for (let i = 0; i < prevVideos.length && videos.length < limit; i++) {
        const pv = prevVideos[i];
        if (!pv) continue;
        const key = (pv.videoId || pv.url || `${pv.title}::${pv.channel}`).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        videos.push({ ...pv, inventoryVersion: opts.inventoryVersion });
      }

      // Extract fresh DOM cards (bypassing 15-item cap when progressive batches expand!)
      const rawDomVideos = this._extractExtendedFeedCards(doc, MAX_FEED_BATCH_ITEMS, digestApi);
      const batchNo = Math.max(1, Math.ceil((videos.length + 1) / FEED_BATCH_SIZE));
      let extraAvailable = false;

      for (let i = 0; i < rawDomVideos.length; i++) {
        const rv = rawDomVideos[i];
        const key = (rv.videoId || rv.url || `${rv.title}::${rv.channel}`).toLowerCase();
        if (seen.has(key)) {
          // Refresh live DOM element handle for existing batch item!
          const matchPrev = videos.find((x) => (x.videoId || x.url || `${x.title}::${x.channel}`).toLowerCase() === key);
          if (matchPrev && rv.element) matchPrev.element = rv.element;
          continue;
        }
        if (videos.length >= limit) {
          extraAvailable = true;
          break;
        }
        seen.add(key);
        const feedPos = videos.length + 1;
        videos.push({
          ...rv,
          id: padId('V', feedPos),
          label: rv.title,
          index: feedPos,
          feedPosition: feedPos,
          batchNumber: Math.max(batchNo, Math.ceil(feedPos / FEED_BATCH_SIZE)),
          discoveredAt: opts.now || Date.now(),
          inventoryVersion: opts.inventoryVersion,
          tabId: opts.tabId,
          type: 'video',
          entityType: 'video',
          transcriptAvailable: null // Unknown until watch page captions are inspected
        });
      }

      return {
        videos,
        hasMoreFeedInDom: extraAvailable,
        watchVideo: structured.watchVideo || null
      };
    }

    _extractExtendedFeedCards(doc, maxItems = 60, digestApi = null) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return [];
      const cards = doc.querySelectorAll(
        'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, .yt-lockup-view-model, [data-video-card], .video-card, article[data-video-id], [data-video-id], .feed-item[data-title]'
      );
      const out = [];
      const seenKeys = new Set();
      for (let i = 0; i < cards.length && out.length < maxItems; i++) {
        const card = cards[i];
        if (!card || (card.closest && card.closest('#sleepwalker-host, #sleepwalker-ui-host'))) continue;
        if (card.hidden || getAttr(card, 'aria-hidden') === 'true') continue;
        const titleEl = (card.querySelector && card.querySelector('#video-title, h3 a, h3, .video-title, [data-video-title], a[title]')) || card;
        const linkEl = (card.querySelector && card.querySelector('a#video-title[href], a#thumbnail[href], a[href*="watch"], a[href]')) || (card.tagName === 'A' ? card : null);
        const title = cleanText(
          getAttr(card, 'data-title') ||
          (titleEl && (getAttr(titleEl, 'title') || getAttr(titleEl, 'aria-label'))) ||
          (titleEl && (titleEl.innerText || titleEl.textContent)) || ''
        ).slice(0, 140);
        if (!title || title.length < 2) continue;

        const chEl = card.querySelector && card.querySelector('ytd-channel-name #text, ytd-channel-name a, #channel-name a, #channel-name, [data-channel], .video-channel, .channel-name');
        const channel = cleanText(getAttr(card, 'data-channel') || (chEl && (chEl.innerText || chEl.textContent)) || '').slice(0, 70);
        const durEl = card.querySelector && card.querySelector('ytd-thumbnail-overlay-time-status-renderer #text, .yt-badge-shape__text, [data-duration], .video-duration, .duration');
        const duration = cleanText(getAttr(card, 'data-duration') || (durEl && (durEl.innerText || durEl.textContent)) || '').slice(0, 24);
        const descEl = card.querySelector && card.querySelector('#description-text, .metadata-snippet-text, [data-description], .video-description, p');
        const description = cleanText(getAttr(card, 'data-description') || (descEl && (descEl.innerText || descEl.textContent)) || '').slice(0, 200);
        const imgEl = card.querySelector && card.querySelector('img[src]');
        const thumbnail = imgEl ? getAttr(imgEl, 'src') : '';
        const href = linkEl ? (getAttr(linkEl, 'href') || linkEl.href || '') : '';
        const vidAttr = getAttr(card, 'data-video-id');
        const vMatch = String(href || '').match(/[?&]v=([A-Za-z0-9_-]{6,})/);
        const videoId = vidAttr || (vMatch && vMatch[1]) || `vid_${out.length + 1}`;
        const dedupKey = `${videoId}::${title.toLowerCase()}::${channel.toLowerCase()}`;
        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);

        const durSec = digestApi && typeof digestApi.parseDurationToSeconds === 'function'
          ? digestApi.parseDurationToSeconds(duration)
          : null;

        out.push({
          videoId,
          title,
          label: title,
          channel,
          duration,
          durationSeconds: durSec,
          description,
          thumbnail: thumbnail && !/^data:text/i.test(thumbnail) ? thumbnail.slice(0, 180) : '',
          url: href,
          href,
          element: linkEl || titleEl || card
        });
      }
      return out;
    }

    /**
     * Mode 2 Progressive Feed Expansion:
     * Discovers next batch (Batch 2: 11-20, Batch 3: 21-30, ...) via DOM/scroll without losing earlier IDs.
     */
    async discoverMoreCandidates(options = {}) {
      const doc = this._getDoc(options.doc);
      if (!doc || this._isPrivacyBlocked()) return { discovered: 0, total: 0, inventory: null };
      const tabId = String(options.tabId || this._getTabId());
      let inv = this.tabInventories.get(tabId);
      if (!inv) {
        inv = await this.buildPageWorldModel(doc, { tabId });
      }
      if (!inv) return { discovered: 0, total: 0, inventory: null };

      const beforeCount = inv.videos.length;
      const desiredTotal = Math.min(
        MAX_FEED_BATCH_ITEMS,
        Math.max(beforeCount + FEED_BATCH_SIZE, Number(options.targetOrdinal) || (beforeCount + FEED_BATCH_SIZE))
      );

      // Try incremental scroll+settle cycles if more DOM items aren't already rendered yet
      const isLiveYt = typeof window !== 'undefined' && window.location && /youtube\.com/i.test(window.location.hostname || '');
      const maxAttempts = isLiveYt ? 3 : 2;
      const defaultSettle = isLiveYt ? 950 : 320;
      let attempts = 0;
      while (attempts < maxAttempts) {
        inv = await this.buildPageWorldModel(doc, { tabId, force: true, feedLimit: desiredTotal });
        if (inv.videos.length >= desiredTotal || inv.videos.length > beforeCount) {
          break;
        }
        attempts += 1;
        if (typeof window !== 'undefined') {
          if (isLiveYt && typeof window.scrollTo === 'function' && doc.documentElement) {
            try { window.scrollTo({ top: Math.max(0, doc.documentElement.scrollHeight - (window.innerHeight || 720)), behavior: 'auto' }); } catch (_e) {}
          } else if (typeof window.scrollBy === 'function') {
            try { window.scrollBy({ top: Math.round((window.innerHeight || 720) * 1.15), behavior: 'auto' }); } catch (_e) {
              try { window.scrollBy(0, 720); } catch (_e2) {}
            }
          }
        }
        if (typeof doc.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          try { doc.dispatchEvent(new CustomEvent('sleepwalker:load-more', { detail: { desiredTotal } })); } catch (_e) {}
        }
        await new Promise((r) => setTimeout(r, Number(options.settleMs) || defaultSettle));
        inv = await this.buildPageWorldModel(doc, { tabId, force: true, feedLimit: desiredTotal });
        if (inv.videos.length > beforeCount) break;
      }

      return {
        discovered: Math.max(0, inv.videos.length - beforeCount),
        beforeCount,
        total: inv.videos.length,
        batchNumber: inv.batchCount,
        inventory: inv
      };
    }

    /**
     * Component D — Semantic Page Retrieval using cached `nomic-embed-text` + concept fallback.
     * Logically separated from conversation memory (`pageEmbedCache`).
     */
    async retrieveRelevantCandidatesAsync(query, options = {}) {
      const q = cleanText(query);
      const tabId = String(options.tabId || this._getTabId());
      const inv = options.inventory || this.tabInventories.get(tabId);
      if (!q || !inv) return [];

      const topK = Math.max(1, Math.min(12, Number(options.topK) || 6));
      const rMode = options.offlineOnly ? 'offline' : 'neural';
      const rKey = `${tabId}::${inv.inventoryVersion || 0}::${inv.navigationIdentity || ''}::${inv.urlClean || ''}::${rMode}::${topK}::${q.toLowerCase()}`;
      if (!options.force && !inv._staleSince && this.retrievalCache && (rMode === 'offline' || this.pageEmbedCache.size > 0)) {
        const hit = this.retrievalCache.get(rKey);
        if (hit && (Date.now() - hit.ts) < 30000) {
          inv.lastEmbedStatus = hit.lastEmbedStatus;
          inv.lastEmbedModel = hit.lastEmbedModel;
          return hit.items.slice(0, topK);
        }
      }
      const pool = [
        ...inv.videos,
        ...inv.options,
        ...inv.links,
        ...inv.sections,
        ...inv.articles
      ].filter((e) => e && !SENSITIVE_TEXT_RE.test(`${e.label || ''} ${e.description || ''} ${e.text || ''}`));

      if (pool.length === 0) return [];

      let observedEmbedStatus = options.offlineOnly ? 'offline_only' : 'fallback_64d';
      let skipNeuralRemaining = Boolean(options.offlineOnly);

      const embedText = async (txt) => {
        const key = `${inv.urlClean}::${hashQuick(txt)}`;
        const prevEntry = this.pageEmbedCache.get(key);
        if (prevEntry && (prevEntry.model === 'nomic-embed-text' || skipNeuralRemaining)) {
          return prevEntry;
        }
        let neuralVec = null;
        let reqStatus = skipNeuralRemaining ? 'fallback_64d' : 'unavailable';
        if (!skipNeuralRemaining) {
          try {
            let r = null;
            const singleTimeout = Math.min(Number(options.timeoutMs) || 800, 800);
            if (this.embedRequester) {
              r = await this.embedRequester({ text: txt.slice(0, 320), timeoutMs: singleTimeout });
            } else if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
              r = await new Promise((resolve) => {
                let done = false;
                const t = setTimeout(() => { if (!done) { done = true; resolve({ status: 'timeout', embedding: null }); } }, singleTimeout);
                chrome.runtime.sendMessage({ type: 'SLEEPWALKER_EMBED_REQUEST', text: txt.slice(0, 320), timeoutMs: singleTimeout }, (res) => {
                  if (done) return;
                  done = true;
                  clearTimeout(t);
                  resolve(res || { status: 'unavailable', embedding: null });
                });
              });
            }
            if (r && r.status === 'ok' && Array.isArray(r.embedding)) {
              neuralVec = r.embedding;
              reqStatus = 'ok';
            } else {
              reqStatus = (r && r.status) || 'unavailable';
              skipNeuralRemaining = true;
            }
          } catch (_e) {
            reqStatus = 'embedding_failed';
            skipNeuralRemaining = true;
          }
        }
        if (reqStatus && reqStatus !== 'unavailable') observedEmbedStatus = reqStatus;
        const entry = neuralVec
          ? { vec: neuralVec, model: 'nomic-embed-text', status: 'ok' }
          : { vec: computeFallbackConceptVector(txt), model: 'concept-semantic-64d', status: reqStatus || 'fallback_64d' };
        if (this.pageEmbedCache.size >= 240) {
          const oldest = this.pageEmbedCache.keys().next().value;
          if (oldest) this.pageEmbedCache.delete(oldest);
        }
        // Cache live neural embeddings persistently; cache fallback vectors cleanly for current pass
        this.pageEmbedCache.set(key, entry);
        return entry;
      };

      const qEmb = await embedText(q);
      // Lexical-prioritized shortlist + bounded semantic embeds (<= 14 entities to guarantee low latency!)
      const qToks = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
      const preRanked = pool.map((entity, idx) => {
        const textRep = cleanText(`${entity.parentSection || ''} ${entity.parentGroupLabel || ''} ${entity.label || ''} ${entity.channel || ''} ${entity.description || ''} ${entity.text || ''}`).slice(0, 260);
        const hay = textRep.toLowerCase();
        let lex = 0;
        for (const tok of qToks) {
          if (hay.includes(tok)) lex += 0.28;
          else if (CONCEPT_EXPANSIONS[tok] && CONCEPT_EXPANSIONS[tok].some((syn) => hay.includes(syn))) lex += 0.16;
        }
        return { entity, textRep, lex: Math.min(1, lex), idx };
      }).sort((a, b) => (b.lex !== a.lex ? b.lex - a.lex : a.idx - b.idx));

      // Keep top 14 candidates plus all videos in Batch 1/2 up to 16
      const shortlisted = preRanked.slice(0, 16);
      const scored = [];
      for (const item of shortlisted) {
        const candEmb = await embedText(item.textRep);
        let sim = 0;
        if (candEmb.vec.length === qEmb.vec.length) {
          sim = Math.max(0, cosineSim(qEmb.vec, candEmb.vec));
        } else {
          sim = Math.max(0, cosineSim(computeFallbackConceptVector(q), computeFallbackConceptVector(item.textRep)));
        }
        const combined = Math.round((0.68 * sim + 0.32 * item.lex) * 1000) / 1000;
        scored.push({
          entity: item.entity,
          semanticScore: Math.round(sim * 1000) / 1000,
          lexicalScore: Math.round(item.lex * 1000) / 1000,
          score: combined,
          vectorModel: candEmb.model === qEmb.model ? candEmb.model : 'concept-semantic-64d',
          vectorStatus: candEmb.model === 'nomic-embed-text' && qEmb.model === 'nomic-embed-text' ? 'ok' : observedEmbedStatus
        });
      }
      inv.lastEmbedStatus = qEmb.model === 'nomic-embed-text' ? 'ok' : observedEmbedStatus;
      inv.lastEmbedModel = qEmb.model === 'nomic-embed-text' ? 'nomic-embed-text' : 'concept-semantic-64d';
      scored.sort((a, b) => b.score - a.score);
      const out = scored.slice(0, topK);
      if (this.retrievalCache && !inv._staleSince) {
        if (this.retrievalCache.size >= 120) {
          const oldestKey = this.retrievalCache.keys().next().value;
          if (oldestKey) this.retrievalCache.delete(oldestKey);
        }
        this.retrievalCache.set(rKey, {
          items: out,
          lastEmbedStatus: inv.lastEmbedStatus,
          lastEmbedModel: inv.lastEmbedModel,
          ts: Date.now()
        });
      }
      return out;
    }

    /**
     * Component C + Reasoning Budgeter: Build clean hierarchical World Model representation
     * scoped cleanly to the current request for `llama3.2:3b` (<= ~820 tokens).
     */
    buildReasonerContext(query = '', options = {}) {
      const tabId = String(options.tabId || this._getTabId());
      const rawOptInv = (options.inventory && typeof options.inventory.then !== 'function') ? options.inventory : null;
      const inv = rawOptInv || this.getTabInventory(tabId);
      if (!inv) return { text: '', validIds: new Set(), inventoryVersion: 0, tabId };

      const qLower = cleanText(query).toLowerCase();
      const qToks = qLower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
      const validIds = new Set();
      const lines = [
        `TAB: ${inv.tabId} | INV_VER: ${inv.inventoryVersion} | MODE: ${inv.discoveryMode} | PAGE_TYPE: ${inv.pageType}`,
        `PAGE: ${inv.title} (${inv.urlClean})`
      ];

      if (inv.watchVideo) {
        const w = inv.watchVideo;
        lines.push(`ACTIVE_VIDEO: "${w.title}" | ch:${w.channel || '-'} | dur:${w.duration || '-'} | paused:${w.paused} | captions:${w.captionsAvailable ? 'available' : 'unavailable'}`);
      }

      if (Array.isArray(inv.videos) && inv.videos.length > 0) {
        lines.push(`FEED_VIDEOS (${inv.videos.length} discovered${inv.hasMoreFeedInDom ? ', more available' : ''}):`);
        for (const v of inv.videos.slice(0, 14)) {
          validIds.add(v.id);
          lines.push(`  [${v.id}] #${v.feedPosition} ${v.title} | ch:${v.channel || '-'} | dur:${v.duration || '-'} | ${(v.description || '').slice(0, 75)}`);
        }
      }

      // Include semantic retrieval hints when provided
      if (Array.isArray(options.semanticMatches) && options.semanticMatches.length > 0) {
        lines.push('SEMANTIC_TOP_MATCHES:');
        for (const m of options.semanticMatches.slice(0, 5)) {
          if (m && m.entity && m.entity.id) {
            validIds.add(m.entity.id);
            lines.push(`  [${m.entity.id}] (${m.entity.type}, score:${m.score}) ${m.entity.label} | sec:${m.entity.parentSection || '-'}`);
          }
        }
      }

      // Group top relevant Links, Options, and Buttons hierarchically under Sections!
      const preferredSecs = (Array.isArray(options.preferredSections) ? options.preferredSections : [])
        .map((s) => cleanText(s).toLowerCase())
        .filter(Boolean);
      const scoreEntityRelevance = (e) => {
        const hay = `${e.label || ''} ${e.parentSection || ''} ${e.parentGroupLabel || ''} ${e.listContext || ''} ${e.domain || ''}`.toLowerCase();
        let s = e.visible ? 1 : 0;
        const secLow = cleanText(e.parentSection || e.label || '').toLowerCase();
        if (preferredSecs.some((ps) => secLow === ps || secLow.includes(ps))) s += 16;
        for (const t of qToks) {
          if (hay.includes(t)) s += 10;
          else if (CONCEPT_EXPANSIONS[t] && CONCEPT_EXPANSIONS[t].some((syn) => hay.includes(syn))) s += 4;
        }
        return s;
      };

      const isControlQuery = /\b(?:select|choose|pick|set|toggle|check|uncheck|enable|disable|dropdown|option|radio|theme|mode|color|size|sort|filter|switch|tab|under|button|click|press)\b/.test(qLower);
      const isSectionOrLinkQuery = /\b(?:go\s+to|take\s+me|navigate|jump|open|section|heading|article|link|visit|previous|first|second|third|fourth|fifth|next|last)\b/.test(qLower);
      const isVideoQuery = inv.pageType === 'youtube_search' || inv.pageType === 'youtube_feed' || /\b(?:video|watch|clip|tutorial|channel)\b/.test(qLower);
      const isTableQuery = /\b(?:table|row|column|price|pricing|fee|deadline|date|schedule|compare|list)\b/.test(qLower);

      const compactBudget = (Number(options.maxTokens) || 820) <= 550;
      const controlLimit = (isControlQuery || !isSectionOrLinkQuery)
        ? (compactBudget ? 12 : 18)
        : 4;
      const linkLimit = (isSectionOrLinkQuery || !isControlQuery || isVideoQuery)
        ? (compactBudget ? 10 : 16)
        : 4;

      const topControls = [...inv.options, ...inv.buttons]
        .map((e, i) => ({ e, s: scoreEntityRelevance(e), i }))
        .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.i - b.i))
        .slice(0, controlLimit)
        .map((x) => x.e);

      const topLinks = isVideoQuery
        ? []
        : inv.links
            .map((e, i) => ({ e, s: scoreEntityRelevance(e), i }))
            .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.i - b.i))
            .slice(0, linkLimit)
            .map((x) => x.e);

      const bySection = new Map();
      const pushToSec = (item) => {
        const secKey = item.parentSection || 'Page';
        if (!bySection.has(secKey)) bySection.set(secKey, []);
        bySection.get(secKey).push(item);
        validIds.add(item.id);
      };
      topLinks.forEach(pushToSec);
      topControls.forEach(pushToSec);

      if (inv.sections.length > 0) {
        const rankedSecs = inv.sections
          .map((s, i) => ({ s, sc: scoreEntityRelevance(s), i }))
          .sort((a, b) => (b.sc !== a.sc ? b.sc - a.sc : a.i - b.i))
          .slice(0, compactBudget ? 10 : 12)
          .map((x) => x.s);
        lines.push(`SECTIONS: ${rankedSecs.map((s) => { validIds.add(s.id); return `[${s.id}] H${s.level}:${s.label}`; }).join(' | ')}`);
      }
      if (Array.isArray(options.learnedSkills) && options.learnedSkills.length > 0) {
        lines.push('LEARNED_SKILLS:');
        for (const sk of options.learnedSkills.slice(0, 3)) {
          if (sk && sk.instruction) {
            const stepsDesc = Array.isArray(sk.steps) ? sk.steps.slice(0, 4).map((s) => s.label || s.action).join(' > ') : '';
            lines.push(`  [${sk.id || 'SKILL'}] "${sk.name || sk.instruction}" (${sk.instruction}) -> ${stepsDesc}`);
          }
        }
      }
      if (bySection.size > 0) {
        lines.push('HIERARCHY:');
        for (const [secName, items] of bySection.entries()) {
          lines.push(`SECTION: ${secName}`);
          for (const it of items.slice(0, 8)) {
            const stateBits = [];
            if (it.selected) stateBits.push('selected');
            if (it.expanded === 'true') stateBits.push('expanded');
            else if (it.expanded === 'false') stateBits.push('collapsed');
            if (!it.enabled) stateBits.push('disabled');
            if (it.required) stateBits.push('required');
            if (it.dependentOf) stateBits.push(`dep:${it.dependentOf.slice(0, 24)}`);
            if (it.covered) stateBits.push('covered');
            else if (it.visibilityState && it.visibilityState !== 'in_viewport') stateBits.push(it.visibilityState);
            if (it.quadrant) stateBits.push(`pos:${it.quadrant}`);
            const stateTag = stateBits.length ? `,${stateBits.join(',')}` : '';
            if (it.type === 'option') {
              const grp = it.parentGroupLabel && it.parentGroupLabel !== secName ? `${it.parentGroupLabel} > ` : '';
              const typeLabel = it.expectedInputType && it.expectedInputType !== it.elementType ? `${it.elementType}:${it.expectedInputType}` : it.elementType;
              lines.push(`  ${grp}[${it.id}] (${typeLabel}${stateTag}) ${it.label}`);
            } else if (it.type === 'button') {
              const navTag = it.navCategory && it.navCategory !== 'content' ? `,${it.navCategory}` : '';
              lines.push(`  [${it.id}] (button${navTag}${stateTag}) ${it.label}`);
            } else {
              const listHint = it.parentMenuLabel ? ` | menu:${it.parentMenuLabel.slice(0, 28)}` : (it.listContext ? ` | list:${it.listContext.slice(0, 28)}` : '');
              const navTag = it.navCategory && it.navCategory !== 'content' ? `${it.navCategory}:` : '';
              const tag = `${navTag}${it.official ? 'official' : (it.category || it.domain || 'link')}`;
              lines.push(`  [${it.id}] (${tag}${stateTag}) ${it.label}${listHint}`);
            }
          }
        }
      }
      if (Array.isArray(inv.iframes) && inv.iframes.some((f) => f && f.crossOrigin)) {
        const crossNotes = inv.iframes.filter((f) => f.crossOrigin).slice(0, 3).map((f) => `[Cross-Origin Iframe: ${f.title || f.src || 'embedded'}]`);
        lines.push(`IFRAMES: ${crossNotes.join(' ')}`);
      }
      if (inv.tables.length > 0 && (isTableQuery || !isControlQuery || qToks.length <= 2)) {
        for (const t of inv.tables.slice(0, 2)) {
          validIds.add(t.id);
          lines.push(`TABLE [${t.id}] (${t.parentSection}): cols=[${(t.headers || []).join(',')}] rows=${(t.rows || []).slice(0, 4).map((r) => r.rowSummary).join(' ; ')}`);
        }
      }

      const maxChars = (Number(options.maxTokens) || 820) * 4;
      let text = lines.join('\n');
      if (text.length > maxChars) {
        text = text.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';
      }
      return { text, validIds, inventoryVersion: inv.inventoryVersion, navigationIdentity: inv.navigationIdentity, tabId: inv.tabId, candidateCount: inv.entities.size };
    }

    /**
     * Validate & reacquire DOM entity strictly checking tabId, inventoryVersion, connection, identity & enabled state.
     */
    resolveAndValidateCandidate(candidateId, expectedTabId = this._getTabId(), options = {}) {
      const tabId = String(expectedTabId || this._getTabId());
      const inv = this.tabInventories.get(tabId);
      if (!inv) return { ok: false, reason: 'No active inventory for this tab.' };
      // A SPA can update the live URL before the asynchronous navigation watcher
      // has rebuilt this tab's inventory. Invalidate the cached identity at the
      // validation boundary so an old candidate cannot pass during that window.
      if (inv.document && this._getNavigationUrl(inv.document) !== (inv.navigationUrl || inv.urlClean)) {
        this._advanceNavigationIdentity(tabId, inv);
        return { ok: false, reason: 'Candidate belongs to a stale navigation or DOM observation.', stale: true };
      }
      if (!options.expectedNavigationIdentity) {
        return { ok: false, reason: 'Candidate validation requires its originating navigation identity.', stale: true };
      }
      if (options.expectedNavigationIdentity && inv.navigationIdentity !== options.expectedNavigationIdentity) {
        return { ok: false, reason: 'Candidate belongs to a stale navigation or DOM observation.', stale: true };
      }
      if (options.expectedVersion && inv.inventoryVersion !== options.expectedVersion) {
        return { ok: false, reason: `Stale inventory version ${options.expectedVersion} (current ${inv.inventoryVersion}).` };
      }
      const entity = inv.entities.get(String(candidateId || ''));
      if (!entity) {
        return { ok: false, reason: `Candidate "${candidateId}" does not exist in tab ${tabId}.` };
      }
      if (entity.tabId && String(entity.tabId) !== 'default' && String(entity.tabId) !== tabId) {
        return { ok: false, reason: `Rejected cross-tab candidate "${candidateId}".` };
      }
      if (entity.element && entity.element.isConnected === false) {
        this._advanceNavigationIdentity(tabId, inv);
        return { ok: false, reason: 'Candidate element was detached by a DOM replacement; observe the page again before acting.', stale: true };
      }
      if (entity.navigationIdentity && entity.navigationIdentity !== inv.navigationIdentity) {
        return { ok: false, reason: 'Candidate belongs to a stale navigation or DOM observation.', stale: true };
      }
      if (options.expectLabel) {
        const exp = cleanText(options.expectLabel).toLowerCase();
        const got = cleanText(entity.label || entity.accessibleName || '').toLowerCase();
        if (exp && got && !got.includes(exp) && !exp.includes(got)) {
          return { ok: false, reason: `Target identity mismatch: expected "${options.expectLabel}" but ref held "${entity.label}".` };
        }
      }
      if (options.expectRole && entity.role && !String(entity.role).toLowerCase().includes(String(options.expectRole).toLowerCase())) {
        return { ok: false, reason: `Role mismatch: expected "${options.expectRole}", got "${entity.role}".` };
      }
      if (entity.enabled === false) {
        return { ok: false, reason: `"${entity.label}" is disabled.` };
      }

      // Reacquire disconnected DOM handle cleanly within current document
      let el = entity.element;
      let reacquired = false;
      if (el && el.isConnected === false) {
        const doc = this._getDoc();
        if (doc && typeof doc.querySelectorAll === 'function') {
          const pool = Array.from(doc.querySelectorAll('a[href], button, input, select, [role="radio"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"]'));
          const targetNorm = cleanText(entity.label).toLowerCase();
          el = pool.find((n) => n && n.isConnected !== false && cleanText(n.innerText || n.textContent || getAttr(n, 'aria-label') || n.value).toLowerCase() === targetNorm) || null;
          entity.element = el;
          reacquired = Boolean(el);
        }
        if (!el) {
          return { ok: false, reason: `"${entity.label}" became detached and could not be reacquired.`, stale: true };
        }
      }
      return { ok: true, entity, element: el, inventory: inv, reacquired };
    }

    /**
     * Phase 4.4: Locate all distinct entities sharing a label across different parent groups/sections
     * so ambiguous commands like "Choose Small" trigger contextual disambiguation.
     */
    findAmbiguousEntitiesByLabel(labelQuery, tabId = this._getTabId()) {
      const inv = this.getTabInventory(tabId);
      const q = cleanText(labelQuery).toLowerCase();
      if (!inv || !q) return [];
      const matches = [];
      const seenContextKeys = new Set();
      const pool = [...inv.options, ...inv.buttons, ...inv.links];
      for (const e of pool) {
        if (!e || e.enabled === false) continue;
        const lbl = cleanText(e.label).toLowerCase();
        if (lbl !== q && !(q.length >= 3 && lbl.split(/\s+/).includes(q))) continue;
        const parentKey = `${cleanText(e.parentGroupLabel || e.parentSection || '').toLowerCase()}::${e.type}::${lbl}`;
        if (seenContextKeys.has(parentKey)) continue;
        seenContextKeys.add(parentKey);
        matches.push(e);
      }
      return matches;
    }

    _syncTabInventorySummaryToMemory(inv) {
      const mem = this.controller && this.controller.memory;
      if (!mem || !mem.state || !inv) return;
      if (!mem.state.worldTabInventories || typeof mem.state.worldTabInventories !== 'object') {
        mem.state.worldTabInventories = {};
      }
      mem.state.worldTabInventories[inv.tabId] = {
        tabId: inv.tabId,
        urlClean: inv.urlClean,
        title: inv.title,
        pageType: inv.pageType,
        discoveryMode: inv.discoveryMode,
        inventoryVersion: inv.inventoryVersion,
        candidateCount: inv.entities ? inv.entities.size : 0,
        videoCount: Array.isArray(inv.videos) ? inv.videos.length : 0,
        candidateIds: Array.from(inv.entities ? inv.entities.keys() : []).slice(0, 40),
        updatedAt: inv.updatedAt
      };
    }

    getTabInventory(tabId = this._getTabId()) {
      const key = String(tabId);
      const found = this.tabInventories.get(key);
      if (found) return found;
      if (key !== 'default' && key === this._getTabId()) {
        const defInv = this.tabInventories.get('default');
        if (defInv && defInv.document === this._getDoc()) {
          defInv.tabId = key;
          if (defInv.entities && typeof defInv.entities.values === 'function') {
            for (const ent of defInv.entities.values()) {
              if (ent && (ent.tabId === 'default' || !ent.tabId)) ent.tabId = key;
            }
          }
          this.tabInventories.set(key, defInv);
          this.tabInventories.delete('default');
          return defInv;
        }
      }
      return null;
    }

    clearTabInventory(tabId = this._getTabId()) {
      this.tabInventories.delete(String(tabId));
    }

    /**
     * Traverse graph CONTAINS/LOCATED_IN_SECTION edges to find the Nth link/article in a target or previous section.
     */
    findEntityInSectionByOrdinal(sectionName = '', ordinal = 1, tabId = this._getTabId()) {
      const inv = this.getTabInventory(tabId);
      if (!inv) return null;
      const cleanSec = cleanText(sectionName).toLowerCase();
      const targetSec = cleanSec
        ? inv.sections.find((s) => s.label.toLowerCase() === cleanSec || s.label.toLowerCase().includes(cleanSec))
        : null;
      const pool = inv.links.filter((l) => {
        if (!l || l.area === 'nav' || l.area === 'footer') return false;
        if (targetSec) return l.parentSectionId === targetSec.id;
        return cleanSec ? (l.parentSection || '').toLowerCase().includes(cleanSec) : true;
      });
      const idx = Math.max(0, (Number(ordinal) || 1) - 1);
      return pool[idx] || null;
    }

    /**
     * Locate best matching option/control using parent group & section hierarchy
     * (e.g. "Select Dark under Color" -> O008 radio inside Color group, excluding "Hide Appearance").
     */
    findOptionByHierarchy(optionTarget, groupOrSectionHint = '', tabId = this._getTabId()) {
      const inv = this.getTabInventory(tabId);
      if (!inv || !optionTarget) return null;
      const optQ = cleanText(optionTarget).toLowerCase();
      const grpQ = cleanText(groupOrSectionHint).toLowerCase();

      const scored = [];
      for (const o of inv.options) {
        if (!o || o.type !== 'option') continue;
        const lbl = cleanText(o.label).toLowerCase();
        const grp = cleanText(o.parentGroupLabel || '').toLowerCase();
        const sec = cleanText(o.parentSection || '').toLowerCase();
        const anc = (o.ancestorHeadings || []).join(' ').toLowerCase();

        let score = 0;
        if (lbl === optQ) score += 100;
        else if (lbl.includes(optQ) || (lbl.length >= 3 && optQ.includes(lbl))) score += 65;
        if (score === 0) continue;

        if (grpQ) {
          if (grp === grpQ) score += 95;
          else if (grp.includes(grpQ) || sec === grpQ || sec.includes(grpQ) || anc.includes(grpQ)) score += 65;
          else score -= 45;
        }
        if (o.enabled) score += 10;
        scored.push({ option: o, score });
      }
      scored.sort((a, b) => b.score - a.score);
      if (!scored[0] || scored[0].score < 60) return null;
      return scored[0].option;
    }

    /**
     * Resolve a hierarchical webpage control or option (menu item, tab, accordion, native select,
     * custom combobox/listbox, radio, checkbox, switch, range slider, or numeric filter input)
     * using live WorldModel entities + parent/child edges.
     * Returns { entity, score, needsParentExpand, parentTrigger } or null.
     */
    findHierarchicalTarget(spec = {}, tabId = this._getTabId()) {
      const inv = this.getTabInventory(tabId);
      if (!inv) return null;

      const wantLabel = cleanText(spec.targetLabel || spec.label || '').toLowerCase();
      const wantParent = cleanText(spec.parentHint || spec.sectionHint || '').toLowerCase();
      const actionKind = String(spec.actionKind || 'select').toLowerCase();
      const wantTokens = wantLabel.split(/\s+/).filter((t) => t.length > 1);
      const parentTokens = wantParent.split(/\s+/).filter((t) => t.length > 1);

      const pool = [
        ...(inv.options || []),
        ...(inv.controls || []),
        ...(inv.buttons || []),
        ...(inv.links || [])
      ];

      const scored = [];
      for (const ent of pool) {
        if (!ent || !ent.element || ent.element.isConnected === false) continue;
        if (ent.enabled === false) continue;

        const lbl = cleanText(ent.label || ent.accessibleName || '').toLowerCase();
        const grp = cleanText(ent.parentGroupLabel || ent.parentTriggerLabel || ent.parentMenuLabel || '').toLowerCase();
        const sec = cleanText(ent.parentSection || '').toLowerCase();
        const anc = (ent.ancestorHeadings || []).join(' ').toLowerCase();
        const role = String(ent.role || ent.elementType || '').toLowerCase();
        const ctxHay = `${grp} ${sec} ${anc}`.trim();

        let score = 0;

        // Special handling for numeric/price threshold controls (range slider, max-price input, or price bucket option)
        if (actionKind === 'set_threshold') {
          const isNumericInput = ent.element && (
            (ent.element.tagName === 'INPUT' && ['range', 'number', 'text'].includes(String(ent.element.type || 'text').toLowerCase())) ||
            role === 'slider' || role === 'spinbutton'
          );
          const isPriceCue = /\b(?:price|budget|cost|max|under|below|amount|₹|rs|inr|\$)\b/i.test(`${lbl} ${ctxHay} ${getAttr(ent.element, 'name')} ${getAttr(ent.element, 'id')} ${getAttr(ent.element, 'placeholder')}`);
          if (isNumericInput && isPriceCue) {
            score += 130;
            if (/\b(?:max|upper|below|under|limit|ceiling)\b/i.test(`${lbl} ${getAttr(ent.element, 'name')} ${getAttr(ent.element, 'id')} ${getAttr(ent.element, 'placeholder')}`)) score += 40;
            if (ent.element.type === 'range') score += 20;
          } else if (spec.numericValue && /\b(?:under|below|up\s*to|<=|less\s+than)\b/i.test(lbl) && lbl.replace(/[,₹$\s]/g, '').includes(String(spec.numericValue))) {
            score += 145;
          } else {
            continue;
          }
        } else {
          if (!wantLabel) continue;
          if (lbl === wantLabel) score += 120;
          else if (lbl.includes(wantLabel)) score += 92;
          else if (wantLabel.length >= 4 && wantLabel.includes(lbl) && lbl.length >= 3) score += 72;
          else if (wantTokens.length > 0 && wantTokens.every((t) => lbl.includes(t))) score += 84;
          else if (wantTokens.length > 1) {
            const hits = wantTokens.filter((t) => `${lbl} ${ctxHay}`.includes(t)).length;
            if (hits / wantTokens.length >= 0.75) score += 62;
          }
          // Check availableValues on native <select> (including live <option> nodes) or custom dropdown trigger
          if (score < 70) {
            const avail = Array.isArray(ent.availableValues) && ent.availableValues.length > 0
              ? ent.availableValues
              : (ent.element && ent.element.tagName === 'SELECT'
                ? Array.from(ent.element.options || []).map((o) => cleanText(`${o.text || ''} ${o.value || ''}`))
                : []);
            if (avail.length > 0) {
              const hasOpt = avail.some((v) => {
                const vl = cleanText(v).toLowerCase();
                return vl === wantLabel || vl.includes(wantLabel) || (wantTokens.length > 0 && wantTokens.every((t) => vl.includes(t)));
              });
              if (hasOpt) score = Math.max(score, 115);
            }
          }
          if (score === 0) continue;
        }

        // Disambiguate similar controls using parent group, section, and ancestor hierarchy (with singular/plural stem matching)!
        const stemMatch = (hay, tok) => {
          if (!tok) return false;
          if (hay.includes(tok)) return true;
          if (tok.endsWith('y') && tok.length > 3 && hay.includes(tok.slice(0, -1) + 'ies')) return true;
          if (tok.endsWith('ies') && tok.length > 4 && hay.includes(tok.slice(0, -3) + 'y')) return true;
          if (tok.endsWith('s') && tok.length > 3 && hay.includes(tok.slice(0, -1))) return true;
          return false;
        };
        const isInsideOpenPopup = Boolean(
          ent.element && ent.element.closest && ent.element.closest(
            'tp-yt-iron-dropdown, ytd-popup-container, ytd-multi-page-menu-renderer, [role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], .MuiPopover-root, .MuiMenu-root, .ant-dropdown, details[open]'
          )
        );
        if (parentTokens.length > 0) {
          const pHits = parentTokens.filter((t) => stemMatch(ctxHay, t) || stemMatch(lbl, t)).length;
          if (pHits === parentTokens.length) score += 85;
          else if (pHits > 0) score += 45;
          else if (isInsideOpenPopup && ent.visible) {
            // Detached portal popups (e.g., YouTube <ytd-popup-container> <tp-yt-iron-dropdown>, React/Radix/MUI portals)
            // do not repeat the trigger's label ("Account") in their DOM ancestors — boost visible open-menu items instead of penalizing!
            score += 45;
          } else {
            score -= 35;
          }
        } else if (isInsideOpenPopup && ent.visible) {
          score += 35;
        }

        // Prefer matching control types for specific actions
        if (actionKind === 'open_category') {
          if (role === 'menuitem' || (ent.element && ent.element.closest && ent.element.closest('nav, [role="menu"], [role="navigation"]'))) score += 55;
          if (ent.element && ent.element.closest && ent.element.closest('[data-product-card], .product-card, article')) score -= 65;
        }
        if ((actionKind === 'switch_tab' || actionKind === 'tab') && role === 'tab') score += 40;
        if ((actionKind === 'expand_menu' || actionKind === 'expand') && (ent.expanded !== null || ent.hasPopup || ent.isAccordionTrigger || role === 'menuitem')) score += 35;
        if ((actionKind === 'filter_or_select' || actionKind === 'filter' || actionKind === 'select') && ['checkbox', 'radio', 'option', 'select', 'custom_dropdown', 'switch'].includes(role)) score += 25;
        if (ent.visible) score += 12;

        // Check if this entity belongs to a collapsed parent trigger
        const parentTrig = ent.parentTriggerId ? inv.entities.get(ent.parentTriggerId) : null;
        const needsParentExpand = Boolean(parentTrig && parentTrig.expanded === 'false');
        scored.push({ entity: ent, score, needsParentExpand, parentTrigger: parentTrig });
      }

      scored.sort((a, b) => b.score - a.score);
      if (scored.length > 0 && scored[0].score >= 65) {
        return scored[0];
      }

      // If child option wasn't found yet (e.g., lazy-rendered dropdown/menu/accordion), locate collapsed parent trigger!
      // Include named buttons/avatars/icons matching wantParent even if framework omitted aria-haspopup / aria-expanded (e.g. YouTube #avatar-btn).
      const collapsedTriggers = [...(inv.buttons || []), ...(inv.controls || []), ...(inv.links || [])].filter((t) => {
        if (!t || !t.element || t.element.isConnected === false || t.enabled === false) return false;
        if (t.expanded === 'false' || Boolean(t.hasPopup) || Boolean(t.isAccordionTrigger)) return true;
        if (wantParent) {
          const tLbl = cleanText(t.label || t.accessibleName || '').toLowerCase();
          return Boolean(tLbl && (tLbl === wantParent || tLbl.includes(wantParent) || parentTokens.every((pt) => tLbl.includes(pt))));
        }
        return false;
      });
      let bestTrig = null;
      let bestTrigScore = 0;
      const cueTokens = Array.from(new Set([...parentTokens, ...wantTokens]));
      for (const tr of collapsedTriggers) {
        const hay = `${tr.label} ${tr.parentSection || ''} ${(tr.ancestorHeadings || []).join(' ')}`.toLowerCase();
        let ts = 0;
        if (wantParent && hay.includes(wantParent)) ts += 100;
        for (const tok of cueTokens) {
          if (hay.includes(tok)) ts += 30;
        }
        // Generic semantic category cues (OS -> Windows/macOS/Linux; RAM/Memory -> GB; Category/Menu -> Laptops)
        if (/\b(?:windows|macos|linux|ubuntu|os)\b/i.test(wantLabel) && /\b(?:os|operating\s*system|platform|system)\b/i.test(hay)) ts += 85;
        if (/\b(?:gb|tb|ram|memory|ssd)\b/i.test(wantLabel) && /\b(?:ram|memory|storage|spec|filter)\b/i.test(hay)) ts += 85;
        if (/\b(?:price|budget|₹|\$|rs)\b/i.test(`${wantLabel} ${wantParent}`) && /\b(?:price|budget|cost|filter)\b/i.test(hay)) ts += 85;
        if (ts > bestTrigScore) {
          bestTrigScore = ts;
          bestTrig = tr;
        }
      }
      if (bestTrig && bestTrigScore >= 55) {
        return { entity: null, score: bestTrigScore, needsParentExpand: true, parentTrigger: bestTrig };
      }
      return null;
    }
  }

  return {
    SleepwalkerWorldModel,
    EDGE_TYPES,
    DISCOVERY_MODES,
    FEED_BATCH_SIZE,
    computeFallbackConceptVector
  };
});
