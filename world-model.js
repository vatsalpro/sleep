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
      try { return require('./digest.js'); } catch (_e) { return null; }
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
      try { return require('./memory.js'); } catch (_e) { return null; }
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
      this._mutationObserver = null;
      this._observedDoc = null;
      this._mutationTimer = null;
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
      if (existing && !options.force && existing.urlClean === urlClean && existing.navigationUrl === navigationUrl && (Date.now() - existing.updatedAt) < 1200) {
        return existing;
      }
      const inv = await this.buildPageWorldModel(doc, { ...options, tabId });
      this._attachIncrementalObserver(doc, tabId);
      return inv;
    }

    _attachIncrementalObserver(doc, tabId) {
      if (!doc || typeof MutationObserver !== 'function') return;
      if (this._mutationObserver && this._observedDoc === doc) return;
      this.disconnectObserver();
      const targetRoot = doc.body || doc.documentElement;
      if (!targetRoot) return;

      this._observedDoc = doc;
      this._mutationObserver = new MutationObserver((mutations) => {
        let relevant = false;
        for (let i = 0; i < mutations.length; i++) {
          const t = mutations[i].target;
          if (!t || (t.nodeType === 1 && (t.id === 'sleepwalker-host' || t.id === 'sleepwalker-ui-host' || (t.closest && t.closest('#sleepwalker-host, #sleepwalker-ui-host'))))) {
            continue;
          }
          relevant = true;
          break;
        }
        if (!relevant) return;
        const curInv = this.tabInventories.get(tabId);
        if (curInv) curInv._staleSince = curInv._staleSince || Date.now();
        if (this._mutationTimer) clearTimeout(this._mutationTimer);
        this._mutationTimer = setTimeout(() => {
          this._mutationTimer = null;
          if (curInv && curInv.discoveryMode === DISCOVERY_MODES.DYNAMIC_APP) {
            this.buildPageWorldModel(doc, { tabId, incremental: true, prevVersion: curInv.inventoryVersion }).catch(() => {});
          }
        }, 350);
      });
      this._mutationObserver.observe(targetRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'aria-expanded', 'aria-selected', 'aria-checked', 'disabled']
      });
    }

    disconnectObserver() {
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
        // Do not collapse distinct buttons or skip non-href buttons; distinguish buttons vs links cleanly
        const isButton = t.role === 'button' && !t.href;
        const id = isButton ? padId('B', buttons.length + 1) : padId('L', links.length + 1);
        const secTitle = t.contextHeading || t.section || '';
        const secId = resolveSectionId(secTitle, t.sectionPath);
        const spatialAria = this._inspectElementSpatialAndAria(t.element, doc);
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
        if (!c || c.sensitive) continue;
        if (c.elementType === 'button') {
          // Register non-duplicate buttons cleanly into B### if not already indexed above
          const alreadyB = buttons.some((b) => b.element && c.element && b.element === c.element);
          if (!alreadyB && c.label && !SENSITIVE_TEXT_RE.test(c.label)) {
            const bid = padId('B', buttons.length + 1);
            const secId = resolveSectionId(c.section || c.nearbyHeading, []);
            const bSpatial = this._inspectElementSpatialAndAria(c.element, doc);
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
        let secTitle = c.section || c.nearbyHeading || c.formContext || '';
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
        const ctrlNode = {
          id: ctrlId,
          type: 'control',
          elementType: c.elementType,
          role: cSpatial.role || c.elementType,
          label: c.label,
          accessibleName: c.accessibleName || cSpatial.accessibleName || c.label,
          parentSection: secTitle || 'page',
          parentSectionId: secId,
          ancestorHeadings: Array.from(new Set([secTitle, c.nearbyHeading, c.section, c.formContext].filter(Boolean))),
          formKey: c.formKey || 'page',
          currentValue: c.currentValue || '',
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
            parentGroupLabel: c.section || c.label,
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

      // 4b. Traverse open Shadow DOM & same-origin iframes safely; note cross-origin iframes
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
        iframes: iframesInfo,
        searchFields: structured.searchFields || [],
        watchVideo: watchVideo || null,
        fullSafeText: structured.fullSafeText || '',
        pageTextHash: structured.pageTextHash || hashQuick(urlClean + sectionNodes.length)
      };

      // Every entity reference carries the page generation where it was indexed.
      // Routine re-observation of the same live DOM preserves that identity.
      for (const entity of entities.values()) {
        if (entity && typeof entity === 'object') entity.navigationIdentity = navigationIdentity;
      }

      this.tabInventories.set(tabId, inventory);
      this._syncTabInventorySummaryToMemory(inventory);
      return inventory;
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

      const collectOpenShadow = (searchDoc, depth = 0) => {
        if (!searchDoc || depth > 2 || typeof searchDoc.querySelectorAll !== 'function') return;
        const nodes = searchDoc.querySelectorAll('*');
        for (let i = 0; i < nodes.length && i < 600; i++) {
          const n = nodes[i];
          if (n && n.shadowRoot && !seenHosts.has(n)) {
            seenHosts.add(n);
            roots.push({ rootNode: n.shadowRoot, kind: 'shadow', label: getAttr(n, 'aria-label') || n.tagName.toLowerCase() });
          }
        }
      };
      collectOpenShadow(doc, 0);

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
        const items = r.rootNode.querySelectorAll('a[href], button, input, select, [role="button"], [role="link"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]');
        for (let j = 0; j < items.length && j < 40; j++) {
          const el = items[j];
          if (!el || existingEls.has(el)) continue;
          const lbl = cleanText(getAttr(el, 'aria-label') || el.innerText || el.textContent || el.value || '');
          if (!lbl || SENSITIVE_TEXT_RE.test(lbl)) continue;
          existingEls.add(el);

          const spatial = this._inspectElementSpatialAndAria(el, doc);
          const tag = String(el.tagName || '').toLowerCase();
          const role = getAttr(el, 'role').toLowerCase() || (tag === 'a' ? 'link' : (tag === 'button' ? 'button' : tag));
          const isLink = tag === 'a' && Boolean(getAttr(el, 'href'));
          const isBtn = role === 'button' || tag === 'button';
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
            visible: spatial.visibilityState !== 'hidden',
            visibilityState: spatial.visibilityState,
            inViewport: spatial.inViewport,
            quadrant: spatial.quadrant,
            covered: spatial.covered,
            enabled: !(el.disabled || getAttr(el, 'aria-disabled') === 'true'),
            selected: Boolean(el.checked || getAttr(el, 'aria-checked') === 'true' || getAttr(el, 'aria-selected') === 'true'),
            expanded: spatial.ariaExpanded,
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
            if (this.embedRequester) {
              r = await this.embedRequester({ text: txt.slice(0, 320), timeoutMs: options.timeoutMs || 1800 });
            } else if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
              r = await new Promise((resolve) => {
                let done = false;
                const t = setTimeout(() => { if (!done) { done = true; resolve({ status: 'timeout', embedding: null }); } }, options.timeoutMs || 2200);
                chrome.runtime.sendMessage({ type: 'SLEEPWALKER_EMBED_REQUEST', text: txt.slice(0, 320), timeoutMs: 1800 }, (res) => {
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
            } else if (r && r.status) {
              reqStatus = r.status;
              if (['origin_blocked', 'ollama_unavailable', 'embed_model_missing', 'unsupported_fallback'].includes(r.status)) {
                skipNeuralRemaining = true;
              }
            }
          } catch (_e) {
            reqStatus = 'embedding_failed';
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
      return scored.slice(0, topK);
    }

    /**
     * Component C + Reasoning Budgeter: Build clean hierarchical World Model representation
     * scoped cleanly to the current request for `llama3.2:3b` (<= ~820 tokens).
     */
    buildReasonerContext(query = '', options = {}) {
      const tabId = String(options.tabId || this._getTabId());
      const inv = options.inventory || this.tabInventories.get(tabId);
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

      if (inv.videos.length > 0) {
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
      const scoreEntityRelevance = (e) => {
        const hay = `${e.label || ''} ${e.parentSection || ''} ${e.parentGroupLabel || ''} ${e.listContext || ''} ${e.domain || ''}`.toLowerCase();
        let s = e.visible ? 1 : 0;
        for (const t of qToks) {
          if (hay.includes(t)) s += 10;
          else if (CONCEPT_EXPANSIONS[t] && CONCEPT_EXPANSIONS[t].some((syn) => hay.includes(syn))) s += 4;
        }
        return s;
      };

      const compactBudget = (Number(options.maxTokens) || 820) <= 550;
      const topControls = [...inv.options, ...inv.buttons]
        .map((e, i) => ({ e, s: scoreEntityRelevance(e), i }))
        .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.i - b.i))
        .slice(0, compactBudget ? 12 : 18)
        .map((x) => x.e);

      const topLinks = inv.links
        .map((e, i) => ({ e, s: scoreEntityRelevance(e), i }))
        .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.i - b.i))
        .slice(0, compactBudget ? 10 : 16)
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
            if (it.covered) stateBits.push('covered');
            else if (it.visibilityState && it.visibilityState !== 'in_viewport') stateBits.push(it.visibilityState);
            if (it.quadrant) stateBits.push(`pos:${it.quadrant}`);
            const stateTag = stateBits.length ? `,${stateBits.join(',')}` : '';
            if (it.type === 'option') {
              const grp = it.parentGroupLabel && it.parentGroupLabel !== secName ? `${it.parentGroupLabel} > ` : '';
              lines.push(`  ${grp}[${it.id}] (${it.elementType}${stateTag}) ${it.label}`);
            } else if (it.type === 'button') {
              lines.push(`  [${it.id}] (button${stateTag}) ${it.label}`);
            } else {
              const listHint = it.listContext ? ` | list:${it.listContext.slice(0, 28)}` : '';
              const tag = it.official ? 'official' : (it.category || it.domain || 'link');
              lines.push(`  [${it.id}] (${tag}${stateTag}) ${it.label}${listHint}`);
            }
          }
        }
      }
      if (Array.isArray(inv.iframes) && inv.iframes.some((f) => f && f.crossOrigin)) {
        const crossNotes = inv.iframes.filter((f) => f.crossOrigin).slice(0, 3).map((f) => `[Cross-Origin Iframe: ${f.title || f.src || 'embedded'}]`);
        lines.push(`IFRAMES: ${crossNotes.join(' ')}`);
      }
      if (inv.tables.length > 0) {
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
      if (String(entity.tabId) !== tabId) {
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
      return this.tabInventories.get(String(tabId)) || null;
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
  }

  return {
    SleepwalkerWorldModel,
    EDGE_TYPES,
    DISCOVERY_MODES,
    FEED_BATCH_SIZE,
    computeFallbackConceptVector
  };
});
