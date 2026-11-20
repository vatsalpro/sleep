/**
 * Sleepwalker - element-select.js
 * Phase 4.1: Intelligent Webpage Element Selection & Interaction Engine
 *
 * Detects interactive controls across document, open Shadow DOM, and accessible same-origin iframes,
 * understands natural selection/toggle/cheapest/ordinal/follow-up intents, ranks candidates using
 * form/heading context, memory interaction context, and optional Ollama AI ranking, executes
 * control-specific interactions (native select, multi-select, custom/searchable dropdowns,
 * autocomplete, radio groups, checkboxes, switches, tabs, nested menus, range sliders, date pickers),
 * reacquires stale DOM controls safely, and verifies actual post-action DOM state.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerElementSelector = api.SleepwalkerElementSelector;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  function getFormIndexApi() {
    if (root && root.SleepwalkerFormIndex) return root.SleepwalkerFormIndex;
    if (typeof require === 'function') {
      try { return require('./form-index.js'); } catch (_e) { return null; }
    }
    return null;
  }

  function getFormFillApi() {
    if (root && root.SleepwalkerFormFill) return root.SleepwalkerFormFill;
    if (typeof require === 'function') {
      try { return require('./form-fill.js'); } catch (_e) { return null; }
    }
    return null;
  }

  function getPersonalIntelApi() {
    if (root && root.SleepwalkerPersonalIntel) return root.SleepwalkerPersonalIntel;
    if (typeof require === 'function') {
      try { return require('./personal-intel.js'); } catch (_e) { return null; }
    }
    return null;
  }

  function cleanText(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim();
  }

  function getAttr(el, name) {
    return (el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : '') || '';
  }

  function tokenize(str) {
    return cleanText(str)
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097f\s]/gi, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  }

  /**
   * Extract numeric price from option/card text for unambiguous cheapest comparison.
   * Returns { amount, currency, label } or null when no comparable price is present.
   */
  function parsePriceFromText(raw) {
    const text = cleanText(raw);
    if (!text) return null;
    const symMatch = text.match(/([$€£₹])\s*(\d[\d,]*(?:\.\d{1,2})?)/);
    if (symMatch) {
      const symMap = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };
      const amt = parseFloat(symMatch[2].replace(/,/g, ''));
      if (Number.isFinite(amt)) return { amount: amt, currency: symMap[symMatch[1]] || symMatch[1], text };
    }
    const codeMatch = text.match(/\b(USD|EUR|GBP|INR|RS\.?)\s*(\d[\d,]*(?:\.\d{1,2})?)\b/i)
      || text.match(/\b(\d[\d,]*(?:\.\d{1,2})?)\s*(USD|EUR|GBP|INR)\b/i);
    if (codeMatch) {
      const firstIsCode = /[a-z]/i.test(codeMatch[1]);
      const codeRaw = (firstIsCode ? codeMatch[1] : codeMatch[2]).toUpperCase().replace('.', '');
      const numRaw = firstIsCode ? codeMatch[2] : codeMatch[1];
      const amt = parseFloat(numRaw.replace(/,/g, ''));
      const cur = codeRaw === 'RS' ? 'INR' : codeRaw;
      if (Number.isFinite(amt)) return { amount: amt, currency: cur, text };
    }
    if (/^(?:free|free\s+plan|\$0)\b/i.test(text) || /\bfree\s+(?:plan|tier)\b/i.test(text)) {
      return { amount: 0, currency: 'GENERIC', text };
    }
    return null;
  }

  const ORDINAL_MAP = {
    first: 0, '1st': 0, one: 0, '1': 0,
    second: 1, '2nd': 1, two: 1, '2': 1,
    third: 2, '3rd': 2, three: 2, '3': 2,
    fourth: 3, '4th': 3, four: 3, '4': 3,
    fifth: 4, '5th': 4, five: 4, '5': 4,
    sixth: 5, '6th': 5, six: 5, '6': 5
  };

  class SleepwalkerElementSelector {
    constructor(widget = null, options = {}) {
      this.widget = widget || null;
      this.rankCaller = options.rankCaller || null;
      this.aiSearchEnabled = options.aiSearchEnabled !== undefined ? Boolean(options.aiSearchEnabled) : true;
      this._localInteractionContext = null;
      this._localUndoStack = [];
    }

    _getDoc() {
      return typeof document !== 'undefined' ? document : null;
    }

    _getInteractionContext(doc) {
      const url = (typeof window !== 'undefined' && window.location && window.location.href) || (doc && doc.URL) || '';
      if (this.widget && this.widget.memory && typeof this.widget.memory.getInteractionContext === 'function') {
        return this.widget.memory.getInteractionContext(url);
      }
      return this._localInteractionContext;
    }

    _updateInteractionContext(patch = {}) {
      if (this.widget && this.widget.memory && typeof this.widget.memory.updateInteractionContext === 'function') {
        return this.widget.memory.updateInteractionContext(patch);
      }
      const prev = this._localInteractionContext || { interactionStep: 0 };
      const formChanged = Boolean(patch.currentFormKey && prev.currentFormKey && patch.currentFormKey !== prev.currentFormKey);
      this._localInteractionContext = {
        ...prev,
        ...patch,
        interactionStep: formChanged ? 1 : (prev.interactionStep || 0) + 1,
        updatedAt: Date.now()
      };
      return this._localInteractionContext;
    }

    _notifyStatus(text, { state = 'preparing', title = 'Element Selection', openCard = false, cardType = 'answer' } = {}) {
      if (this.widget && typeof this.widget._setStatusChip === 'function') {
        this.widget._setStatusChip(text);
      }
      if (this.widget && typeof this.widget.setAssistantReply === 'function' && openCard) {
        this.widget.setAssistantReply(text);
      }
      if (typeof window !== 'undefined' && window.SW_UI) {
        if (state) window.SW_UI.setState(state);
        if (openCard) {
          window.SW_UI.showCard({ type: cardType, title, text });
        }
      }
      if (openCard && this.widget && this.widget.reader && typeof this.widget.reader.readText === 'function') {
        this.widget.reader.readText(text);
      }
    }

    /**
     * Disconnect any active scoped MutationObservers cleanly on tear-down.
     */
    destroy() {
      const ff = getFormFillApi();
      if (ff && typeof ff.disconnectAllObservers === 'function') {
        ff.disconnectAllObservers();
      }
    }

    /**
     * Parse natural-language element selection, toggle, cheapest plan, ordinal, slider, tab & menu commands.
     */
    parseSelectionCommand(rawText, intentArgs = {}) {
      const raw = cleanText(rawText);
      const args = intentArgs && typeof intentArgs === 'object' ? intentArgs : {};
      const strippedLead = raw.replace(/^(?:hey\s+|ok\s+|okay\s+|hi\s+)?sleepwalker\s*[,:-]*\s+/i, '')
        .replace(/^(?:now|then|please|also|next)\s+/i, '')
        .trim();
      const lower = strippedLead.toLowerCase();

      const followUp = Boolean(args.followUp || /^(?:now|then|also|next)\b/i.test(raw));
      const replaceExisting = /\b(?:only|replace|reset|clear\s+previous|instead)\b/i.test(lower);

      // Extract explicit section / form context hints ("... in the shipping section", "... under preferences")
      let sectionHint = '';
      let work = strippedLead;
      const sectionMatch = work.match(/\s+(?:in|under|inside|from|on)\s+(?:the\s+|my\s+)?([a-z0-9\s&-]{2,40}?)\s+(section|form|panel|dialog|modal|preferences|address|billing|shipping|footer|header|card)\b[.?!]*$/i);
      if (sectionMatch) {
        sectionHint = cleanText(`${sectionMatch[1]} ${sectionMatch[2]}`);
        work = work.slice(0, sectionMatch.index).trim();
      }

      let fieldHint = cleanText(args.field || '');
      if (!fieldHint) {
        const inFieldMatch = work.match(/\s+(?:in|from|under|for|on)\s+(?:the\s+|my\s+)?([a-z0-9\s&-]{2,38}?)(?:\s+(?:field|dropdown|select|box|menu|group|list|control))?[.?!]*$/i);
        if (inFieldMatch && !/^(?:terms\s+and\s+conditions|second|first|third)/i.test(inFieldMatch[1])) {
          fieldHint = cleanText(inFieldMatch[1]);
          work = work.slice(0, inFieldMatch.index).trim();
        }
      } else {
        fieldHint = fieldHint.replace(/\s+(?:field|dropdown|control|box|selector)$/i, '').trim();
      }

      // Clean trailing punctuation & verb prefixes
      const stripVerbAndChrome = (txt) => cleanText(txt)
        .replace(/[.?!]+$/, '')
        .replace(/^(?:tick|check|untick|uncheck|select|choose|pick|deselect|unselect|enable|disable|toggle|activate|switch\s+to|open|go\s+to)\s+/i, '')
        .replace(/^(?:the|an|a)\s+/i, '')
        .trim();

      let controlTypeHint = args.controlTypeHint || '';
      if (!controlTypeHint) {
        if (/\b(?:checkbox|check\s+box)\b/i.test(lower)) controlTypeHint = 'checkbox';
        else if (/\b(?:radio(?:\s+button)?)\b/i.test(lower)) controlTypeHint = 'radio';
        else if (/\b(?:dropdown|drop\s+down|select\s+box|combobox)\b/i.test(lower)) controlTypeHint = 'dropdown';
        else if (/\b(?:switch|toggle)\b/i.test(lower)) controlTypeHint = 'switch';
        else if (/\b(?:slider|range)\b/i.test(lower)) controlTypeHint = 'range';
        else if (/\b(?:tab)\b/i.test(lower)) controlTypeHint = 'tab';
        else if (/\b(?:menu|submenu)\b/i.test(lower)) controlTypeHint = 'menu';
      }

      // Check cheapest / lowest-price comparison intent
      if (/\b(?:cheapest|lowest\s+price|most\s+affordable|least\s+expensive|lowest\s+cost)\b/i.test(lower)) {
        const targetScope = cleanText(
          lower.replace(/^(?:select|choose|pick)\s+(?:the\s+)?/, '')
            .replace(/\b(?:cheapest|lowest\s+price|most\s+affordable|least\s+expensive|lowest\s+cost)\b/gi, '')
        ) || 'plan';
        return {
          raw,
          action: 'select_cheapest',
          targetOption: targetScope,
          fieldHint,
          sectionHint,
          controlTypeHint,
          followUp,
          replaceExisting
        };
      }

      // Check slider set command
      if (args.specialOp === 'slider' || /\b(?:slider|range)\b/i.test(lower)) {
        const valM = lower.match(/\bto\s+([a-z0-9.%-]+)\b/i);
        return {
          raw,
          action: 'set_value',
          targetOption: cleanText(args.value || (valM && valM[1]) || ''),
          fieldHint: fieldHint || stripVerbAndChrome(work).replace(/\b(?:slider|range)\b.*$/i, '').trim(),
          sectionHint,
          controlTypeHint: 'range',
          followUp,
          replaceExisting: true
        };
      }

      // Check binary tick / check / uncheck / switch
      if (args.specialOp === 'check' || args.specialOp === 'uncheck' || args.specialOp === 'switch' || /^(?:tick|check|untick|uncheck|deselect|unselect)\b/i.test(lower)) {
        const isUncheck = args.specialOp === 'uncheck' || /^(?:untick|uncheck|deselect|unselect)\b/i.test(lower) || (args.specialOp === 'switch' && args.value === 'off');
        const action = (args.specialOp === 'switch' && args.value === 'toggle') ? 'toggle' : (isUncheck ? 'uncheck' : 'check');
        const cleanedTarget = cleanText(args.value && !fieldHint ? args.value : stripVerbAndChrome(work))
          .replace(/\s+(?:checkbox|check\s+box|option|toggle|switch|field)$/i, '')
          .trim();
        return {
          raw,
          action,
          targetOption: cleanedTarget,
          multiValues: Array.isArray(args.multiValues)
            ? args.multiValues.map((m) => m.replace(/\s+(?:checkbox|option|switch)$/i, '').trim()).filter(Boolean)
            : [],
          fieldHint,
          sectionHint,
          controlTypeHint: controlTypeHint || (args.specialOp === 'switch' ? 'switch' : 'checkbox'),
          followUp,
          replaceExisting
        };
      }

      // Check explicit ordinal option ("select the second option", "choose the second one", "select the second university")
      const ordMatch = lower.match(/^(?:select|choose|pick|open)\s+(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th)\s+(one|option|choice|item|university|college|course|plan|result|menu|tab)\b/i)
        || lower.match(/^(?:select|choose|pick)\s+(?:option|choice|number)\s+([1-6])\b/i);
      if (ordMatch) {
        const w = (ordMatch[1] || '').toLowerCase();
        const noun = (ordMatch[2] || 'option').toLowerCase();
        const ordIdx = Object.prototype.hasOwnProperty.call(ORDINAL_MAP, w) ? ORDINAL_MAP[w] : -1;
        if (ordIdx >= 0) {
          return {
            raw,
            action: 'select_ordinal',
            ordinalIndex: ordIdx,
            ordinalNoun: noun,
            targetOption: ordMatch[0],
            fieldHint,
            sectionHint,
            controlTypeHint: noun === 'tab' ? 'tab' : controlTypeHint,
            followUp,
            replaceExisting
          };
        }
      }

      // Check explicit tab switch
      if (controlTypeHint === 'tab' || /\btab\b[.?!]*$/i.test(work)) {
        const cleanTab = stripVerbAndChrome(work).replace(/\s+tab$/i, '').trim();
        return {
          raw,
          action: 'activate_tab',
          targetOption: cleanTab,
          fieldHint,
          sectionHint,
          controlTypeHint: 'tab',
          followUp,
          replaceExisting: true
        };
      }

      // General selection: "Select India", "Choose Computer Science", "Choose Germany in country", "Now select Master's degree"
      const targetRaw = cleanText(args.value || stripVerbAndChrome(work))
        .replace(/\s+(?:option|choice|dropdown|field)$/i, '')
        .trim();

      // Check explicit multi-option selection ("Select Python and Java in skills" or "Select India, Germany")
      const hasMultiSep = /\s*(?:,|\band\b)\s*/i.test(targetRaw) && !/\b(?:terms\s+and\s+conditions|research\s+and\s+development|arts\s+and\s+humanities)\b/i.test(targetRaw);
      const multiParts = hasMultiSep ? targetRaw.split(/\s*(?:,|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean) : [];

      return {
        raw,
        action: multiParts.length >= 2 ? 'multi_select' : 'select_option',
        targetOption: targetRaw,
        multiValues: multiParts,
        fieldHint,
        sectionHint,
        controlTypeHint,
        followUp,
        replaceExisting
      };
    }

    /**
     * Build unified interactive candidate catalog reusing SleepwalkerFormIndex + tabs/menus/custom triggers/plan cards.
     */
    detectInteractiveCandidates(doc = this._getDoc(), options = {}) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return [];
      const fi = getFormIndexApi();
      const formFields = fi && typeof fi.buildFormIndex === 'function'
        ? fi.buildFormIndex(doc, { includeDisabled: true })
        : [];

      const consumed = new Set();
      const candidates = [];

      const enrichOptionsWithPrice = (opts = []) => (opts || []).map((o) => {
        const lbl = cleanText(o && (o.label || o.value || ''));
        const priceInfo = parsePriceFromText(lbl);
        return {
          ...o,
          label: lbl,
          value: o && o.value !== undefined ? String(o.value) : lbl,
          price: priceInfo ? priceInfo.amount : undefined,
          currency: priceInfo ? priceInfo.currency : undefined
        };
      });

      const addCandidate = (entry) => {
        const id = `elem_${candidates.length + 1}`;
        const normOpts = enrichOptionsWithPrice(entry.options || []);
        const el = entry.element || null;
        const formCtx = entry.formContext || (fi && fi.resolveFormContext && el ? fi.resolveFormContext(el) : { formId: '', formName: '', formLabel: '', formPurpose: 'generic', containerKey: 'page' });
        const heading = entry.nearbyHeading || (fi && fi.resolveNearbyHeading && el ? fi.resolveNearbyHeading(el) : '');
        const cand = {
          id,
          elementType: entry.elementType || 'control',
          tag: el ? String(el.tagName || '').toLowerCase() : (entry.tag || 'control'),
          role: entry.role || (el ? getAttr(el, 'role').toLowerCase() : ''),
          label: cleanText(entry.label || ''),
          accessibleName: cleanText(entry.accessibleName || entry.label || ''),
          ariaLabel: cleanText(el ? getAttr(el, 'aria-label') : ''),
          placeholder: cleanText(el ? getAttr(el, 'placeholder') : ''),
          visibleText: cleanText(entry.visibleText || (el ? (el.innerText || el.textContent || '') : '')).slice(0, 140),
          parentContainer: cleanText(entry.parentContainer || formCtx.formLabel || heading || ''),
          nearbyHeading: cleanText(heading),
          section: cleanText(entry.section || entry.group || heading || formCtx.formLabel || ''),
          formContext: cleanText(formCtx.formLabel || formCtx.formPurpose || formCtx.formId || ''),
          formKey: formCtx.containerKey || 'page',
          currentValue: entry.currentValue !== undefined ? String(entry.currentValue) : '',
          checked: Boolean(entry.checked),
          disabled: Boolean(entry.disabled),
          sensitive: Boolean(entry.sensitive),
          multiselect: Boolean(entry.multiselect),
          interactable: !entry.disabled,
          visible: true,
          rootType: entry.rootType || 'document',
          crossOriginFramesSkipped: entry.crossOriginFramesSkipped || 0,
          options: normOpts,
          descriptor: entry.descriptor || null,
          element: el,
          parentMenuTrigger: entry.parentMenuTrigger || null,
          priceInfo: entry.priceInfo || parsePriceFromText(`${entry.label || ''} ${entry.visibleText || ''}`)
        };
        candidates.push(cand);
      };

      // 1. Add all deep form controls from SleepwalkerFormIndex (including shadow roots & same-origin iframes)
      for (const f of formFields) {
        if (!f || !f.element) continue;
        consumed.add(f.element);
        if (Array.isArray(f.elements)) f.elements.forEach((n) => consumed.add(n));
        if (f.inputElement) consumed.add(f.inputElement);
        if (f.triggerElement) consumed.add(f.triggerElement);
        if (Array.isArray(f.options)) f.options.forEach((o) => { if (o && o.element) consumed.add(o.element); });

        let elementType = f.type || 'input';
        if (f.type === 'select') elementType = f.multiselect ? 'multiselect' : 'select';
        else if (f.type === 'combobox' || f.type === 'listbox') {
          if (f.multiselect) elementType = 'multiselect';
          else if (f.comboboxKind === 'autocomplete' || f.comboboxKind === 'datalist') elementType = 'autocomplete';
          else if (f.comboboxKind === 'filter') elementType = 'searchable_dropdown';
          else elementType = 'custom_dropdown';
        }

        addCandidate({
          elementType,
          role: getAttr(f.element, 'role').toLowerCase() || elementType,
          label: f.label,
          accessibleName: f.fullLabel || f.label,
          group: f.group,
          section: f.section,
          nearbyHeading: f.nearbyHeading,
          formContext: f.formContext,
          currentValue: f.sensitive ? '' : (f.value || f.stateText || ''),
          checked: Boolean(f.checked),
          disabled: Boolean(f.disabled),
          sensitive: Boolean(f.sensitive),
          multiselect: Boolean(f.multiselect),
          rootType: f.rootType || 'document',
          crossOriginFramesSkipped: f.crossOriginFramesSkipped || 0,
          options: f.sensitive ? [] : (f.options || []),
          descriptor: f,
          element: f.element
        });
      }

      // 2. Scan custom dropdown triggers, tabs, nested menu items, plan cards & non-submit buttons across accessible roots
      const rootMeta = { crossOriginFramesSkipped: 0 };
      const roots = fi && typeof fi.collectRoots === 'function'
        ? fi.collectRoots(doc, [], new Set(), rootMeta)
        : [{ rootNode: doc, rootType: 'document' }];

      const visCheck = (el) => fi && typeof fi.isElementVisuallyVisible === 'function'
        ? fi.isElementVisuallyVisible(el, { allowDisabled: true })
        : Boolean(el && !el.hidden);

      for (const rootEntry of roots) {
        const rDoc = rootEntry.rootNode;
        const rType = rootEntry.rootType || 'document';
        if (!rDoc || typeof rDoc.querySelectorAll !== 'function') continue;

        // Autocomplete text fields annotated via .autocomplete / data-autocomplete without aria-autocomplete
        const autoInputs = Array.from(rDoc.querySelectorAll('[data-autocomplete], .autocomplete input, input[class*="autocomplete" i]'));
        for (const aNode of autoInputs) {
          if (consumed.has(aNode) || !visCheck(aNode)) continue;
          consumed.add(aNode);
          const lbl = (fi && fi.resolveFieldLabel ? fi.resolveFieldLabel(aNode) : '') || getAttr(aNode, 'placeholder') || 'Autocomplete';
          const opts = fi && fi.resolveListboxOptions ? fi.resolveListboxOptions(aNode, rDoc, { includeDisabled: true }) : [];
          addCandidate({
            elementType: 'autocomplete',
            role: getAttr(aNode, 'role') || 'combobox',
            label: lbl,
            currentValue: cleanText(aNode.value),
            disabled: Boolean(aNode.disabled || getAttr(aNode, 'aria-disabled') === 'true'),
            rootType: rType,
            options: opts,
            descriptor: {
              type: 'combobox',
              comboboxKind: 'autocomplete',
              label: lbl,
              element: aNode,
              inputElement: aNode,
              triggerElement: aNode,
              disabled: Boolean(aNode.disabled),
              options: opts
            },
            element: aNode
          });
        }

        // Custom non-ARIA dropdown triggers ([aria-haspopup], [aria-expanded], .dropdown-trigger, .custom-select, .select-trigger)
        const customDropNodes = Array.from(rDoc.querySelectorAll(
          '[aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"], button[aria-expanded], .dropdown-trigger, .select-trigger, .custom-select-trigger, [data-dropdown-trigger]'
        ));
        for (const node of customDropNodes) {
          if (consumed.has(node) || !visCheck(node)) continue;
          consumed.add(node);
          const lbl = (fi && fi.resolveFieldLabel ? fi.resolveFieldLabel(node) : '') || cleanText(node.innerText || node.textContent) || 'Dropdown';
          const opts = fi && fi.resolveListboxOptions ? fi.resolveListboxOptions(node, rDoc, { includeDisabled: true }) : [];
          const wrap = node.closest && node.closest('[data-dropdown], .dropdown, .custom-select, .searchable-select');
          const hasSearchInput = Boolean(wrap && wrap.querySelector && wrap.querySelector('input[type="search"], input[type="text"], input:not([type])'));
          const desc = {
            type: 'combobox',
            comboboxKind: hasSearchInput ? 'filter' : 'click',
            label: lbl,
            element: node,
            triggerElement: node,
            inputElement: hasSearchInput ? wrap.querySelector('input') : null,
            disabled: Boolean(node.disabled || getAttr(node, 'aria-disabled') === 'true'),
            options: opts
          };
          addCandidate({
            elementType: hasSearchInput ? 'searchable_dropdown' : 'custom_dropdown',
            role: getAttr(node, 'role') || 'button',
            label: lbl,
            currentValue: cleanText(node.innerText || node.textContent || node.value),
            disabled: desc.disabled,
            rootType: rType,
            crossOriginFramesSkipped: rootMeta.crossOriginFramesSkipped,
            options: opts,
            descriptor: desc,
            element: node
          });
        }

        // Tabs ([role="tab"])
        const tabNodes = Array.from(rDoc.querySelectorAll('[role="tab"]'));
        for (const tNode of tabNodes) {
          if (consumed.has(tNode) || !visCheck(tNode)) continue;
          consumed.add(tNode);
          const lbl = cleanText(tNode.innerText || tNode.textContent || getAttr(tNode, 'aria-label'));
          if (!lbl) continue;
          addCandidate({
            elementType: 'tab',
            role: 'tab',
            label: lbl,
            currentValue: getAttr(tNode, 'aria-selected') === 'true' ? 'selected' : 'unselected',
            checked: getAttr(tNode, 'aria-selected') === 'true',
            disabled: Boolean(tNode.disabled || getAttr(tNode, 'aria-disabled') === 'true'),
            rootType: rType,
            element: tNode
          });
        }

        // Navigation & Nested Menu items (including items inside closed visible-parent submenu triggers!)
        const menuNodes = Array.from(rDoc.querySelectorAll('[role="menuitem"], nav a[href], nav button, .submenu-item, [data-submenu-item]'));
        for (const mNode of menuNodes) {
          if (consumed.has(mNode)) continue;
          const isVis = visCheck(mNode);
          let parentTrigger = null;
          if (!isVis && typeof mNode.closest === 'function') {
            const parentMenuHost = mNode.closest('[data-menu-group], .has-submenu, li.menu-item, [role="menu"]')?.parentElement;
            if (parentMenuHost) {
              const candTrig = parentMenuHost.querySelector('button, [role="menuitem"], a[href], [aria-haspopup]');
              if (candTrig && candTrig !== mNode && visCheck(candTrig)) parentTrigger = candTrig;
            }
          }
          if (!isVis && !parentTrigger) continue;
          const lbl = cleanText(mNode.innerText || mNode.textContent || getAttr(mNode, 'aria-label'));
          if (!lbl) continue;
          consumed.add(mNode);
          addCandidate({
            elementType: 'menu_item',
            role: getAttr(mNode, 'role') || 'menuitem',
            label: lbl,
            parentContainer: parentTrigger ? cleanText(parentTrigger.innerText || parentTrigger.textContent) : 'Menu',
            disabled: Boolean(mNode.disabled || getAttr(mNode, 'aria-disabled') === 'true'),
            rootType: rType,
            element: mNode,
            parentMenuTrigger: parentTrigger
          });
        }

        // Selectable Plan / Pricing cards (radios already added above; capture card-buttons like "Choose Plan")
        const planNodes = Array.from(rDoc.querySelectorAll('.plan-card, .pricing-card, [data-plan], [data-price]'));
        if (planNodes.length >= 2) {
          const planOpts = [];
          for (const pNode of planNodes) {
            if (!visCheck(pNode)) continue;
            const actionEl = pNode.querySelector('input[type="radio"], button, [role="button"], a[href]') || pNode;
            const lbl = cleanText(pNode.getAttribute('data-plan') || (pNode.querySelector('h2,h3,h4,.plan-name,.title')?.innerText || '') || pNode.innerText).slice(0, 90);
            const priceInfo = parsePriceFromText(`${pNode.getAttribute('data-price') || ''} ${pNode.innerText || ''}`);
            planOpts.push({
              element: actionEl,
              clickTarget: actionEl,
              cardElement: pNode,
              disabled: Boolean(actionEl.disabled || getAttr(actionEl, 'aria-disabled') === 'true'),
              selected: Boolean(actionEl.checked || (pNode.classList && pNode.classList.contains('selected')) || getAttr(pNode, 'aria-selected') === 'true'),
              value: lbl,
              label: cleanText(`${lbl}${priceInfo ? ` (${pNode.getAttribute('data-price') || priceInfo.amount})` : ''}`),
              price: priceInfo ? priceInfo.amount : undefined,
              currency: priceInfo ? priceInfo.currency : undefined
            });
          }
          if (planOpts.length >= 2) {
            addCandidate({
              elementType: 'plan_group',
              role: 'group',
              label: 'Plans & Pricing',
              section: fi && fi.resolveNearbyHeading ? fi.resolveNearbyHeading(planNodes[0]) : 'Plans',
              rootType: rType,
              options: planOpts,
              element: planNodes[0]
            });
          }
        }

        // Remaining visible action buttons (exclude submit/payment/reset buttons unless explicit button click)
        const btnNodes = Array.from(rDoc.querySelectorAll('button, input[type="button"], [role="button"]'));
        for (const bNode of btnNodes) {
          if (consumed.has(bNode) || !visCheck(bNode)) continue;
          const bType = getAttr(bNode, 'type').toLowerCase();
          if (bType === 'submit' || bType === 'reset') continue;
          const lbl = cleanText(bNode.innerText || bNode.textContent || bNode.value || getAttr(bNode, 'aria-label'));
          if (!lbl || lbl.length > 80) continue;
          if (/\b(?:submit|pay\s+now|checkout|place\s+order|complete\s+purchase|buy\s+now|delete\s+account)\b/i.test(lbl)) continue;
          consumed.add(bNode);
          addCandidate({
            elementType: 'button',
            role: 'button',
            label: lbl,
            disabled: Boolean(bNode.disabled || getAttr(bNode, 'aria-disabled') === 'true'),
            rootType: rType,
            element: bNode
          });
        }
      }

      return candidates;
    }

    /**
     * Evaluate "Choose the cheapest plan" unambiguously across plan groups, radio groups, or selects.
     */
    _resolveCheapestCandidate(candidates, parsedCmd) {
      const priceGroups = candidates.filter((c) => {
        if (!Array.isArray(c.options) || c.options.length < 2) return false;
        const priced = c.options.filter((o) => !o.disabled && typeof o.price === 'number');
        return priced.length >= 2;
      });

      if (priceGroups.length === 0) {
        return { action: 'not_found', message: 'I could not find comparable plan prices on this page.' };
      }

      // Prioritize plan/pricing/tier labeled groups or active section
      const scoredGroups = priceGroups.map((g) => {
        const hay = `${g.label} ${g.section} ${g.nearbyHeading} ${g.formContext}`.toLowerCase();
        let sc = /\b(?:plan|pricing|tier|package|subscription)\b/.test(hay) ? 50 : 10;
        if (g.elementType === 'plan_group') sc += 30;
        if (parsedCmd.sectionHint && hay.includes(parsedCmd.sectionHint.toLowerCase())) sc += 40;
        return { group: g, sc };
      }).sort((a, b) => b.sc - a.sc);

      const chosenGroup = scoredGroups[0].group;
      const pricedOpts = chosenGroup.options.filter((o) => !o.disabled && typeof o.price === 'number');
      const unpricedOpts = chosenGroup.options.filter((o) => !o.disabled && typeof o.price !== 'number');

      if (unpricedOpts.length > 0 && unpricedOpts.some((o) => /\b(?:custom|contact|quote)\b/i.test(o.label))) {
        // Custom/Enterprise tier without numeric price doesn't block numeric comparisons across standard plans
      } else if (pricedOpts.length < 2) {
        return { action: 'clarify', needsClarification: true, message: 'Some plans lack numeric prices, so I cannot confirm which is cheapest.' };
      }

      const currencies = new Set(pricedOpts.map((o) => o.currency).filter((c) => c && c !== 'GENERIC'));
      if (currencies.size > 1) {
        return {
          action: 'clarify',
          needsClarification: true,
          message: `The available plans use different currencies (${Array.from(currencies).join(', ')}). Which plan would you like me to select?`
        };
      }

      const sorted = pricedOpts.slice().sort((a, b) => a.price - b.price);
      if (sorted.length >= 2 && sorted[0].price === sorted[1].price) {
        const tied = sorted.filter((o) => o.price === sorted[0].price).map((o) => o.label);
        return {
          action: 'clarify',
          needsClarification: true,
          candidates: sorted.filter((o) => o.price === sorted[0].price),
          message: `Multiple plans tie at the lowest price (${tied.join(' and ')}). Which one should I select?`
        };
      }

      const cheapest = sorted[0];
      return {
        action: 'select',
        candidate: chosenGroup,
        targetOption: cheapest.label,
        matchedOptionObj: cheapest,
        confidence: 0.96,
        reason: `Lowest unambiguous price (${cheapest.label})`
      };
    }

    /**
     * Build compact sanitized payload for Ollama context-aware candidate ranking.
     */
    buildOllamaPayload(userCommand, candidates, interactionCtx, doc) {
      return {
        user_command: cleanText(userCommand).slice(0, 180),
        page_title: cleanText(doc && doc.title).slice(0, 80),
        page_category: 'interactive_page',
        interaction_context: interactionCtx || null,
        candidates: (candidates || []).slice(0, 16).map((c) => ({
          id: c.id,
          element_type: c.elementType,
          role: c.role,
          label: c.label,
          nearby_heading: c.nearbyHeading,
          section: c.section,
          form_context: c.formContext || c.formKey,
          current_value: c.currentValue,
          disabled: c.disabled,
          sensitive: c.sensitive,
          multiselect: c.multiselect,
          visible: c.visible,
          options: (c.options || []).slice(0, 12).map((o) => ({
            label: o.label,
            disabled: Boolean(o.disabled),
            price: typeof o.price === 'number' ? o.price : undefined
          }))
        }))
      };
    }

    async _requestOllamaRank(payload) {
      if (this.rankCaller) return await this.rankCaller(payload);
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ status: 'ollama_unavailable', message: 'Element ranking timed out.' }), 12000);
          try {
            chrome.runtime.sendMessage({ type: 'SLEEPWALKER_ELEMENT_SELECT_REQUEST', payload }, (res) => {
              clearTimeout(timer);
              if (chrome.runtime.lastError || !res) {
                resolve({ status: 'ollama_unavailable' });
              } else {
                resolve(res);
              }
            });
          } catch (_e) {
            clearTimeout(timer);
            resolve({ status: 'ollama_unavailable' });
          }
        });
      }
      return { status: 'ollama_unavailable' };
    }

    /**
     * Score candidates deterministically with section, form context, option matching, and interaction continuity.
     */
    rankCandidatesDeterministic(parsedCmd, candidates, interactionCtx = null) {
      const ff = getFormFillApi();
      const qOpt = String(parsedCmd.targetOption || '').trim();
      const qField = String(parsedCmd.fieldHint || '').trim();
      const qSec = String(parsedCmd.sectionHint || '').trim().toLowerCase();
      const optTokens = tokenize(qOpt);
      const fieldTokens = tokenize(qField);

      const scored = [];
      for (const c of candidates) {
        if (!c || c.sensitive) continue;
        let score = 0;
        let matchedOpt = null;
        let matchedOptDisabled = false;
        const cLabelLower = (c.label || '').toLowerCase();
        const cContextHay = `${c.label} ${c.nearbyHeading} ${c.section} ${c.formContext} ${c.parentContainer}`.toLowerCase();

        // Option matching inside candidate
        if (qOpt && Array.isArray(c.options) && c.options.length > 0 && !['checkbox', 'switch', 'tab', 'menu_item', 'button'].includes(c.elementType)) {
          if (ff && typeof ff.matchChoiceOption === 'function') {
            const m = ff.matchChoiceOption(c.options, qOpt);
            if (m.status === 'matched' && m.option) {
              matchedOpt = m.option;
              matchedOptDisabled = Boolean(m.option.disabled);
              score += Math.round((m.score || 0.85) * 100);
            } else if (m.status === 'ambiguous' && Array.isArray(m.candidates) && m.candidates.length > 0) {
              score += 72;
            }
          }
        }

        // Multi-option overlap score
        if (Array.isArray(parsedCmd.multiValues) && parsedCmd.multiValues.length >= 2 && Array.isArray(c.options) && c.options.length > 0) {
          let hits = 0;
          for (const mv of parsedCmd.multiValues) {
            const m = ff ? ff.matchChoiceOption(c.options, mv) : null;
            if (m && m.status === 'matched') hits += 1;
          }
          if (hits > 0) score += hits * 65 + (c.multiselect ? 20 : 0);
        }

        // Control label match ("Terms and Conditions checkbox", "Notification option", explicit fieldHint)
        const targetForLabel = qField || (['checkbox', 'switch', 'tab', 'menu_item', 'button', 'range'].includes(c.elementType) ? qOpt : '');
        const targetLblLower = targetForLabel.toLowerCase();
        if (targetLblLower) {
          if (cLabelLower === targetLblLower) score += 110;
          else if (cLabelLower.includes(targetLblLower) || targetLblLower.includes(cLabelLower) && cLabelLower.length >= 3) score += 82;
          else {
            const tks = tokenize(targetLblLower);
            const hits = tks.filter((t) => cContextHay.includes(t)).length;
            if (hits > 0) score += Math.round((hits / Math.max(tks.length, 1)) * 68);
          }
        }
        // Weak partial credit when selecting a standalone option directly by option text matching control
        if (score === 0 && optTokens.length > 0) {
          const hits = optTokens.filter((t) => cLabelLower.includes(t)).length;
          if (hits === optTokens.length) score += 65;
        }

        // Section / Heading / Group disambiguation match ("in billing section", "under Color", "in footer")
        if (qSec) {
          if (cContextHay.includes(qSec)) score += 55;
          else {
            const sToks = tokenize(qSec);
            const sHits = sToks.filter((t) => cContextHay.includes(t)).length;
            if (sHits > 0) score += sHits * 22;
            else if (score > 0) score -= 25;
          }
        }
        // When selecting an option under a field/group (e.g. "Select Dark under Color"), down-rank standalone buttons without options
        if (parsedCmd.action === 'select_option' && qField && c.elementType === 'button' && (!c.options || c.options.length === 0)) {
          score -= 45;
        }

        // Control type hint affinity
        if (parsedCmd.controlTypeHint) {
          const h = parsedCmd.controlTypeHint;
          if (
            (h === 'checkbox' && (c.elementType === 'checkbox' || c.elementType === 'checkbox_group' || c.elementType === 'switch')) ||
            (h === 'radio' && c.elementType === 'radio') ||
            (h === 'dropdown' && ['select', 'multiselect', 'custom_dropdown', 'searchable_dropdown', 'autocomplete'].includes(c.elementType)) ||
            (h === 'switch' && (c.elementType === 'switch' || c.elementType === 'checkbox')) ||
            (h === 'tab' && c.elementType === 'tab') ||
            (h === 'menu' && c.elementType === 'menu_item') ||
            (h === 'range' && c.elementType === 'range')
          ) {
            score += 22;
          }
        }

        // Action-type natural affinity
        if ((parsedCmd.action === 'check' || parsedCmd.action === 'uncheck' || parsedCmd.action === 'toggle') &&
            ['checkbox', 'checkbox_group', 'switch'].includes(c.elementType)) {
          score += 20;
        } else if (parsedCmd.action === 'activate_tab' && c.elementType === 'tab') {
          score += 35;
        } else if (parsedCmd.action === 'select_option' &&
            ['select', 'multiselect', 'custom_dropdown', 'searchable_dropdown', 'autocomplete', 'radio'].includes(c.elementType)) {
          score += 14;
        }

        // Same-form short-lived Interaction Context boost (e.g., "Choose Germany" -> "Now select Master's degree")
        if (interactionCtx && interactionCtx.currentFormKey && c.formKey === interactionCtx.currentFormKey) {
          score += 24;
          if (parsedCmd.followUp && interactionCtx.lastControlId && c.id === interactionCtx.lastControlId && !qField) {
            score -= 10; // Next step on same form typically targets another field on that form
          }
        }

        // Scoped adaptive control correction boost (Phase 5)
        const pi = getPersonalIntelApi();
        const memState = this.widget && this.widget.memory && this.widget.memory.state;
        if (pi && memState) {
          const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || 'page';
          const ov = pi.lookupControlOverride(memState, { host, formKey: c.formKey || 'default', spokenTarget: qField || qOpt });
          if (ov && ov.preferredLabel && cLabelLower === String(ov.preferredLabel).toLowerCase()) {
            score += 95;
          }
        }

        if (score >= 45) {
          scored.push({ candidate: c, score, matchedOpt, matchedOptDisabled });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored;
    }

    /**
     * Decide target candidate & action combining deterministic scoring, optional Ollama ranking,
     * duplicate-section ambiguity checks, ordinal context, and disabled guards.
     */
    async resolveCandidateDecision(rawText, candidates, parsedCmd, options = {}) {
      const doc = options.doc || this._getDoc();
      const interactionCtx = this._getInteractionContext(doc);

      // 1. Cheapest Plan comparison
      if (parsedCmd.action === 'select_cheapest') {
        return this._resolveCheapestCandidate(candidates, parsedCmd);
      }

      // 2. Ordinal Selection ("Select the second option", "Choose the second one", "Select the second university")
      if (parsedCmd.action === 'select_ordinal') {
        const idx = parsedCmd.ordinalIndex;
        const noun = parsedCmd.ordinalNoun || 'option';

        // Prioritize open custom dropdown, then last interacted control, then explicit fieldHint, then single option-bearing control
        let optionControls = candidates.filter((c) => !c.disabled && Array.isArray(c.options) && c.options.length > 0);
        if (noun === 'tab') {
          const tabs = candidates.filter((c) => c.elementType === 'tab' && !c.disabled);
          if (tabs[idx]) return { action: 'select', candidate: tabs[idx], targetOption: tabs[idx].label, confidence: 0.94, reason: 'Ordinal tab selection' };
        }
        if (/\b(?:university|college|course|school)\b/i.test(noun)) {
          // Match explicit control labeled with university/college/course (never just a parent form heading), else delegate to page result cards
          const uControl = optionControls.find((c) => /\b(?:university|college|course|school|institution)\b/i.test(c.label));
          if (uControl && uControl.options[idx]) {
            return { action: 'select', candidate: uControl, targetOption: uControl.options[idx].label, matchedOptionObj: uControl.options[idx], confidence: 0.93, reason: 'Matched university selector option' };
          }
          return { action: 'delegate_list_item', ordinalIndex: idx, noun };
        }

        if (parsedCmd.fieldHint) {
          const hintLower = parsedCmd.fieldHint.toLowerCase();
          const hinted = optionControls.find((c) => `${c.label} ${c.section}`.toLowerCase().includes(hintLower));
          if (hinted && hinted.options[idx]) {
            return { action: 'select', candidate: hinted, targetOption: hinted.options[idx].label, matchedOptionObj: hinted.options[idx], confidence: 0.95 };
          }
        }

        // Open expanded dropdown/listbox on page right now
        const openDrop = optionControls.find((c) => c.element && getAttr(c.element, 'aria-expanded') === 'true');
        if (openDrop && openDrop.options[idx]) {
          return { action: 'select', candidate: openDrop, targetOption: openDrop.options[idx].label, matchedOptionObj: openDrop.options[idx], confidence: 0.94, reason: 'Active expanded dropdown' };
        }

        // Short-lived interaction context control
        if (interactionCtx && interactionCtx.lastControlId) {
          const lastCtrl = optionControls.find((c) => c.id === interactionCtx.lastControlId || (interactionCtx.lastControlLabel && c.label === interactionCtx.lastControlLabel && c.formKey === interactionCtx.currentFormKey));
          if (lastCtrl && lastCtrl.options[idx]) {
            return { action: 'select', candidate: lastCtrl, targetOption: lastCtrl.options[idx].label, matchedOptionObj: lastCtrl.options[idx], confidence: 0.93, reason: 'Active control in interaction context' };
          }
        }

        if (optionControls.length === 1 && optionControls[0].options[idx]) {
          const only = optionControls[0];
          return { action: 'select', candidate: only, targetOption: only.options[idx].label, matchedOptionObj: only.options[idx], confidence: 0.92, reason: 'Single option control on page' };
        }

        if (optionControls.length > 1) {
          return {
            action: 'clarify',
            needsClarification: true,
            clarificationCandidates: optionControls.slice(0, 5),
            message: `Multiple option lists exist (${optionControls.slice(0, 4).map((c, i) => `${i + 1}. ${c.section && c.section !== c.label ? `${c.section} — ${c.label}` : c.label}`).join(', ')}). Which one should I pick option ${idx + 1} from?`
          };
        }
        return { action: 'not_found', message: `No option #${idx + 1} list is currently active on this page.` };
      }

      // 3. Deterministic Scoring + Duplicate-Section Ambiguity + Lazy Dropdown / Ollama Context Ranking
      const scored = this.rankCandidatesDeterministic(parsedCmd, candidates, interactionCtx);
      const top = scored[0] || null;
      const second = scored[1] || null;

      // Exact labels shared by independent controls require a section or field
      // cue; prior interaction context alone must not choose one silently.
      if (parsedCmd.action === 'select_option' && parsedCmd.targetOption && !parsedCmd.sectionHint && !parsedCmd.fieldHint) {
        const wanted = cleanText(parsedCmd.targetOption).toLowerCase();
        const exactOwners = candidates.filter((candidate) => !candidate.disabled && Array.isArray(candidate.options) &&
          candidate.options.some((option) => cleanText(option && (option.label || option.value)).toLowerCase() === wanted));
        if (exactOwners.length > 1) {
          const clarificationCandidates = exactOwners.slice(0, 5).map((candidate) => ({ ...candidate,
            _matchedOpt: candidate.options.find((option) => cleanText(option && (option.label || option.value)).toLowerCase() === wanted) || null
          }));
          const choices = clarificationCandidates.map((candidate) => candidate.section && candidate.section !== candidate.label
            ? `${candidate.section} — ${candidate.label}` : candidate.label);
          return {
            action: 'clarify',
            needsClarification: true,
            clarificationCandidates,
            message: `"${parsedCmd.targetOption}" appears in multiple controls: ${choices.map((choice, index) => `${index + 1}. ${choice}`).join('  ')}. Which one did you mean?`
          };
        }
      }

      // Duplicate control in DIFFERENT sections/forms (e.g., Shipping Country vs Billing Country, Account Subscribe vs Marketing Subscribe)
      if (top && second && Math.abs(top.score - second.score) <= 18) {
        const diffSection = (top.candidate.formKey !== second.candidate.formKey) || (top.candidate.section !== second.candidate.section);
        const sameLabel = top.candidate.label.toLowerCase() === second.candidate.label.toLowerCase()
          || (parsedCmd.targetOption && top.matchedOpt && second.matchedOpt);
        const sameFormBoostedOnlyOne = interactionCtx && interactionCtx.currentFormKey &&
          top.candidate.formKey === interactionCtx.currentFormKey && second.candidate.formKey !== interactionCtx.currentFormKey;

        if (!sameFormBoostedOnlyOne && !parsedCmd.sectionHint && !parsedCmd.fieldHint && (diffSection || sameLabel)) {
          const tieEntries = scored.filter((s) => top.score - s.score <= 18).slice(0, 4);
          const ties = tieEntries.map((s) => ({
            ...s.candidate,
            _matchedOpt: s.matchedOpt || null
          }));
          const descList = ties.map((c, i) => {
            const parentDesc = c.section && c.section !== c.label ? `${c.section} — ${c.label}` : c.label;
            return `${i + 1}. ${parentDesc}${c._matchedOpt ? ` (${c._matchedOpt.label})` : ''}`;
          }).join('  ');
          return {
            action: 'clarify',
            needsClarification: true,
            clarificationCandidates: ties,
            message: `Multiple matching controls exist in different sections: ${descList}. Which one did you mean?`
          };
        }
      }

      // Invoke Ollama AI candidate ranking when multiple candidates exist and deterministic certainty isn't overwhelming OR lazy/searchable dropdown needs semantic routing
      const hasLazyCustomOrSearchable = candidates.some((c) => ['custom_dropdown', 'searchable_dropdown', 'autocomplete'].includes(c.elementType) && (!c.options || c.options.length === 0));
      const aiEnabled = options.aiSearchEnabled !== undefined ? Boolean(options.aiSearchEnabled) : this.aiSearchEnabled;
      const shouldConsultAi = aiEnabled && candidates.length > 1 && (
        options.forceAiRanking ||
        (!top) ||
        (top && top.score < 95) ||
        (hasLazyCustomOrSearchable && (!top || !top.matchedOpt))
      );

      let aiDecision = null;
      if (shouldConsultAi) {
        const aiPayload = this.buildOllamaPayload(rawText, candidates, interactionCtx, doc);
        const aiRes = await this._requestOllamaRank(aiPayload);
        if (aiRes && aiRes.status === 'ok' && aiRes.selection) {
          aiDecision = aiRes.selection;
          if (aiDecision.needs_clarification || aiDecision.intended_action === 'clarify') {
            return {
              action: 'clarify',
              needsClarification: true,
              source: 'ollama',
              clarificationCandidates: scored.slice(0, 4).map((s) => s.candidate),
              message: aiDecision.clarification_question || 'Multiple controls match your request. Which one did you mean?'
            };
          }
          if (aiDecision.selected_candidate_id && aiDecision.confidence >= 0.6) {
            const aiCand = candidates.find((c) => c.id === aiDecision.selected_candidate_id);
            if (aiCand) {
              if (aiCand.disabled) {
                return { action: 'disabled', candidate: aiCand, source: 'ollama', message: `"${aiCand.label}" is currently disabled and cannot be changed.` };
              }
              return {
                action: 'select',
                candidate: aiCand,
                intendedAction: aiDecision.intended_action,
                targetOption: aiDecision.target_option || parsedCmd.targetOption,
                multiValues: (Array.isArray(aiDecision.multi_options) && aiDecision.multi_options.length > 0) ? aiDecision.multi_options : parsedCmd.multiValues,
                confidence: aiDecision.confidence,
                reason: aiDecision.reason || 'Selected by Ollama context ranking',
                source: 'ollama'
              };
            }
          }
        }
      }

      if (!top) {
        const unloadedDrops = candidates.filter((c) => !c.disabled && ['custom_dropdown', 'searchable_dropdown', 'autocomplete'].includes(c.elementType) && (!c.options || c.options.length === 0));
        if (unloadedDrops.length === 1 && parsedCmd.action === 'select_option' && parsedCmd.targetOption) {
          return {
            action: 'select',
            candidate: unloadedDrops[0],
            intendedAction: 'select_option',
            targetOption: parsedCmd.targetOption,
            confidence: 0.78,
            reason: 'Single lazy custom/searchable dropdown candidate',
            source: 'deterministic'
          };
        }
        return {
          action: 'not_found',
          message: `Could not find "${parsedCmd.targetOption || rawText}" on this page.`
        };
      }

      if (top.candidate.disabled) {
        return {
          action: 'disabled',
          candidate: top.candidate,
          message: `"${top.candidate.label}" is currently disabled and cannot be interacted with.`
        };
      }

      if (top.matchedOptDisabled) {
        return {
          action: 'disabled',
          candidate: top.candidate,
          message: `The option "${top.matchedOpt.label}" in "${top.candidate.label}" is disabled.`
        };
      }

      // Check sensitive field gate BEFORE executing
      const fi = getFormIndexApi();
      if (top.candidate.sensitive || (fi && fi.isSensitiveField && fi.isSensitiveField(top.candidate.element, top.candidate.label))) {
        return {
          action: 'sensitive',
          candidate: top.candidate,
          message: "I'll leave this one for you."
        };
      }

      return {
        action: 'select',
        candidate: top.candidate,
        intendedAction: parsedCmd.action,
        targetOption: parsedCmd.targetOption,
        multiValues: parsedCmd.multiValues,
        matchedOptionObj: top.matchedOpt,
        confidence: Math.min(0.98, top.score / 120),
        reason: aiDecision ? aiDecision.reason : 'Deterministic context-aware match',
        source: 'deterministic'
      };
    }

    /**
     * Reacquire a replaced DOM element safely after React/Vue/Angular re-render using semantic fingerprint.
     */
    _reacquireCandidate(oldCand, doc) {
      const freshList = this.detectInteractiveCandidates(doc);
      return freshList.find((c) =>
        c.element &&
        c.element.isConnected !== false &&
        c.label.toLowerCase() === (oldCand.label || '').toLowerCase() &&
        c.elementType === oldCand.elementType &&
        c.formKey === oldCand.formKey
      ) || freshList.find((c) =>
        c.element &&
        c.element.isConnected !== false &&
        c.label.toLowerCase() === (oldCand.label || '').toLowerCase()
      ) || null;
    }

    async _settleAfterDomAction(doc) {
      const navEng = (root && root.SleepwalkerNavEngine) || (typeof require === 'function' ? require('./nav-engine.js') : null);
      if (navEng && navEng.SleepwalkerWaitManager) {
        const wm = new navEng.SleepwalkerWaitManager({ doc });
        return wm.waitForDOMSettled({ doc, timeoutMs: 280, quietMs: 50 });
      }
      await new Promise((r) => setTimeout(r, 20));
      return { settled: true };
    }

    _getCandidateOverlay(doc) {
      const navEng = (root && root.SleepwalkerNavEngine) || (typeof require === 'function' ? require('./nav-engine.js') : null);
      if (!navEng || !navEng.SleepwalkerCandidateOverlay) return null;
      if (!this._candidateOverlay) {
        this._candidateOverlay = new navEng.SleepwalkerCandidateOverlay({ doc });
      }
      return this._candidateOverlay;
    }

    clearCandidateOverlay(doc = null) {
      if (this._candidateOverlay && typeof this._candidateOverlay.clear === 'function') {
        this._candidateOverlay.clear({ doc: doc || this._getDoc() });
      }
    }

    /**
     * Execute control-specific interaction and strictly verify resulting DOM state.
     */
    async executeAndVerifyCandidate(decision, parsedCmd, options = {}) {
      const doc = options.doc || this._getDoc();
      this.clearCandidateOverlay(doc);
      const ff = getFormFillApi();
      const fi = getFormIndexApi();
      let cand = decision.candidate;

      if (!cand || !cand.element) {
        return { ok: false, verified: false, status: 'not_found', message: 'Target control no longer available.' };
      }

      // Safe stale DOM element reacquisition before execution
      if (cand.element.isConnected === false) {
        const reacquired = this._reacquireCandidate(cand, doc);
        if (!reacquired) {
          return { ok: false, verified: false, status: 'stale_element', message: `"${cand.label}" was removed from the page.` };
        }
        cand = reacquired;
      }

      const el = cand.element;
      const targetOption = decision.targetOption || parsedCmd.targetOption;
      this._notifyStatus(`Updating "${cand.label}"...`, { state: 'preparing' });
      if (ff && typeof ff.highlightField === 'function') {
        ff.highlightField(el);
      }

      let execResult = null;
      const type = cand.elementType;

      try {
        if (type === 'select') {
          const opts = cand.options || [];
          const optRes = decision.matchedOptionObj
            ? { status: 'matched', option: decision.matchedOptionObj }
            : (ff ? ff.matchChoiceOption(opts, targetOption) : { status: 'none' });
          if (optRes.status === 'ambiguous') {
            return { ok: false, status: 'ambiguous', candidates: optRes.candidates, message: `Multiple options match "${targetOption}" in ${cand.label}.` };
          }
          if (optRes.status !== 'matched' || !optRes.option) {
            return { ok: false, status: 'option_not_found', verified: false, message: `Option "${targetOption}" is not available in ${cand.label}.` };
          }
          if (optRes.option.disabled) {
            return { ok: false, status: 'disabled', verified: false, message: `Option "${optRes.option.label}" in ${cand.label} is disabled.` };
          }
          if (ff && typeof ff.setNativeValue === 'function') ff.setNativeValue(el, optRes.option.value);
          else el.value = optRes.option.value;
          if (ff) ff.dispatchControlEvents(el);
          await new Promise((r) => setTimeout(r, 20));

          // Reacquire if DOM replaced on change (React/Vue conditional re-render)
          const checkEl = el.isConnected === false ? (this._reacquireCandidate(cand, doc)?.element || el) : el;
          const actualVal = String(checkEl.value || '');
          const verified = actualVal === String(optRes.option.value);
          execResult = {
            ok: verified,
            verified,
            appliedValue: optRes.option.label,
            message: verified
              ? `Selected "${optRes.option.label}" in ${cand.label}.`
              : `Tried selecting "${optRes.option.label}" in ${cand.label}, but page kept "${actualVal || 'empty'}".`
          };
        } else if (type === 'multiselect') {
          const wantedList = Array.isArray(decision.multiValues) && decision.multiValues.length > 0
            ? decision.multiValues
            : [targetOption];
          if (String(el.tagName || '').toUpperCase() === 'SELECT') {
            execResult = ff.setSelectMultiple(el, wantedList, { replace: Boolean(parsedCmd.replaceExisting) });
          } else {
            // ARIA multi-select listbox: preserve aria-selected="true" unless replaceExisting
            const listboxOpts = cand.options || [];
            const applied = [];
            for (const q of wantedList) {
              const m = ff ? ff.matchChoiceOption(listboxOpts, q) : { status: 'none' };
              if (m.status !== 'matched' || !m.option || !m.option.element) {
                return { ok: false, status: 'option_not_found', verified: false, message: `Option "${q}" not found in ${cand.label}.` };
              }
              if (m.option.disabled) {
                return { ok: false, status: 'disabled', verified: false, message: `Option "${m.option.label}" is disabled.` };
              }
              const isAlready = getAttr(m.option.element, 'aria-selected') === 'true';
              if (!isAlready) {
                if (typeof m.option.element.click === 'function') m.option.element.click();
                if (getAttr(m.option.element, 'aria-selected') !== 'true') {
                  m.option.element.setAttribute('aria-selected', 'true');
                }
              }
              applied.push(m.option.label);
            }
            const verifiedAll = applied.length > 0;
            execResult = { ok: verifiedAll, verified: verifiedAll, appliedValue: applied.join(', ') };
          }
          if (execResult.ok) execResult.message = `Selected "${execResult.appliedValue}" in ${cand.label}.`;
        } else if (['custom_dropdown', 'searchable_dropdown', 'autocomplete', 'combobox', 'listbox'].includes(type)) {
          const combDesc = cand.descriptor || { type: 'combobox', label: cand.label, element: el, triggerElement: el, options: cand.options };
          execResult = await ff.applyComboboxValue(combDesc, targetOption, { timeoutMs: options.timeoutMs || 850 });
          if (execResult && execResult.ok) {
            execResult.message = `Selected "${execResult.appliedValue}" in ${cand.label}.`;
          }
        } else if (type === 'radio' || type === 'plan_group') {
          const opts = cand.options || [];
          const optRes = decision.matchedOptionObj
            ? { status: 'matched', option: decision.matchedOptionObj }
            : (ff ? ff.matchChoiceOption(opts, targetOption) : { status: 'none' });
          if (optRes.status === 'ambiguous') {
            return { ok: false, status: 'ambiguous', candidates: optRes.candidates, message: `Multiple choices match "${targetOption}" in ${cand.label}.` };
          }
          if (optRes.status !== 'matched' || !optRes.option || !optRes.option.element) {
            return { ok: false, status: 'option_not_found', verified: false, message: `Choice "${targetOption}" not found in ${cand.label}.` };
          }
          if (optRes.option.disabled) {
            return { ok: false, status: 'disabled', verified: false, message: `"${optRes.option.label}" is disabled.` };
          }
          const opt = optRes.option;
          const clickNode = opt.clickTarget || opt.element;
          if (typeof clickNode.click === 'function') clickNode.click();
          if (type === 'radio') {
            if (opt.element.tagName === 'INPUT' && !opt.element.checked) {
              opt.element.checked = true;
            } else if (opt.element.tagName !== 'INPUT' && typeof opt.element.setAttribute === 'function') {
              opts.forEach((o) => o.element && o.element.setAttribute && o.element.setAttribute('aria-checked', o === opt ? 'true' : 'false'));
            }
          }
          if (ff) ff.dispatchControlEvents(opt.element, { includeClick: false });
          await new Promise((r) => setTimeout(r, 20));
          const verified = type === 'radio'
            ? (opt.element.tagName === 'INPUT' ? Boolean(opt.element.checked) : getAttr(opt.element, 'aria-checked') === 'true')
            : Boolean(opt.element.checked || (opt.cardElement && (opt.cardElement.classList.contains('selected') || getAttr(opt.cardElement, 'aria-selected') === 'true')));
          execResult = {
            ok: verified,
            verified,
            appliedValue: opt.label,
            message: verified ? `Selected "${opt.label}" in ${cand.label}.` : `Selection of "${opt.label}" did not stick in ${cand.label}.`
          };
        } else if (type === 'checkbox' || type === 'switch') {
          const isToggle = decision.intendedAction === 'toggle' || parsedCmd.action === 'toggle';
          const curChecked = el.tagName === 'INPUT' ? Boolean(el.checked) : getAttr(el, 'aria-checked') === 'true';
          const desired = isToggle ? !curChecked : (decision.intendedAction !== 'uncheck' && parsedCmd.action !== 'uncheck');

          if (curChecked === desired) {
            execResult = {
              ok: true,
              verified: true,
              alreadySet: true,
              appliedValue: desired ? 'checked' : 'unchecked',
              message: `"${cand.label}" is already ${desired ? (type === 'switch' ? 'on' : 'checked') : (type === 'switch' ? 'off' : 'unchecked')}.`
            };
          } else {
            const clickTgt = (cand.descriptor && cand.descriptor.clickTarget) || el;
            const actual = ff.toggleBinaryElement(el, clickTgt, desired);
            const verified = actual === desired;
            execResult = {
              ok: verified,
              verified,
              appliedValue: desired ? (type === 'switch' ? 'on' : 'checked') : (type === 'switch' ? 'off' : 'unchecked'),
              message: verified
                ? `${desired ? (type === 'switch' ? 'Turned on' : 'Checked') : (type === 'switch' ? 'Turned off' : 'Unchecked')} "${cand.label}".`
                : `Tried updating "${cand.label}", but page kept it ${actual ? 'checked' : 'unchecked'}.`
            };
          }
        } else if (type === 'checkbox_group') {
          const wanted = Array.isArray(decision.multiValues) && decision.multiValues.length > 0
            ? decision.multiValues
            : [targetOption];
          const desired = decision.intendedAction !== 'uncheck' && parsedCmd.action !== 'uncheck';
          const doneLabels = [];
          for (const q of wanted) {
            const m = ff.matchChoiceOption(cand.options, q);
            if (m.status !== 'matched' || !m.option || !m.option.element) {
              return { ok: false, status: 'option_not_found', verified: false, message: `Checkbox "${q}" not found in ${cand.label}.` };
            }
            if (m.option.disabled) {
              return { ok: false, status: 'disabled', verified: false, message: `Checkbox "${m.option.label}" is disabled.` };
            }
            const actual = ff.toggleBinaryElement(m.option.element, m.option.clickTarget || m.option.element, desired);
            if (actual !== desired) {
              return { ok: false, status: 'verification_failed', verified: false, message: `Failed to ${desired ? 'check' : 'uncheck'} "${m.option.label}".` };
            }
            doneLabels.push(m.option.label);
          }
          execResult = {
            ok: true,
            verified: true,
            appliedValue: doneLabels.join(', '),
            message: `${desired ? 'Checked' : 'Unchecked'} ${doneLabels.join(', ')} in ${cand.label}.`
          };
        } else if (type === 'tab') {
          if (typeof el.click === 'function') el.click();
          if (ff) ff.dispatchControlEvents(el, { includeClick: false });
          await new Promise((r) => setTimeout(r, 25));
          const verified = getAttr(el, 'aria-selected') === 'true' || (el.classList && (el.classList.contains('active') || el.classList.contains('selected')));
          execResult = {
            ok: verified,
            verified,
            appliedValue: cand.label,
            message: verified ? `Switched to "${cand.label}" tab.` : `Tab "${cand.label}" did not report active state after click.`
          };
        } else if (type === 'menu_item') {
          if (cand.parentMenuTrigger) {
            const trig = cand.parentMenuTrigger;
            if (typeof trig.dispatchEvent === 'function') ff.dispatchControlEvents(trig, { includeClick: true, includeBlur: false });
            if (typeof trig.click === 'function') trig.click();
            await ff.waitForDynamicDomChange(doc.body || doc, () => (fi.isElementVisuallyVisible(el) ? el : null), 500);
          }
          if (typeof el.click === 'function') el.click();
          if (ff) ff.dispatchControlEvents(el, { includeClick: false });
          await new Promise((r) => setTimeout(r, 25));
          execResult = {
            ok: true,
            verified: true,
            appliedValue: cand.label,
            message: `Selected menu item "${cand.label}".`
          };
        } else if (type === 'range') {
          execResult = ff.setRangeValue(el, targetOption);
          if (execResult.ok) execResult.message = `Set "${cand.label}" to ${execResult.appliedValue}.`;
        } else if (type === 'date' || type === 'datetime-local' || type === 'month') {
          const parsedDate = ff && ff.parseSpokenDate ? (ff.parseSpokenDate(targetOption, type) || targetOption) : targetOption;
          ff.setNativeValue(el, parsedDate);
          ff.dispatchControlEvents(el);
          const verified = String(el.value || '') === String(parsedDate);
          execResult = {
            ok: verified,
            verified,
            appliedValue: el.value || parsedDate,
            message: verified ? `Set "${cand.label}" to ${el.value}.` : `Date field kept "${el.value || 'empty'}".`
          };
        } else if (type === 'button') {
          if (typeof el.click === 'function') el.click();
          execResult = { ok: true, verified: true, appliedValue: cand.label, message: `Selected "${cand.label}".` };
        }
      } catch (err) {
        execResult = { ok: false, verified: false, error: err && err.message };
      }

      if (!execResult || !execResult.ok || execResult.verified === false) {
        const failMsg = (execResult && (execResult.error || execResult.message)) || `Failed to verify selection on "${cand.label}".`;
        this._notifyStatus(failMsg, { state: 'idle', title: 'Selection Failed', openCard: true, cardType: 'error' });
        return {
          ok: false,
          verified: false,
          status: (execResult && execResult.status) || 'verification_failed',
          controlLabel: cand.label,
          message: failMsg
        };
      }

      // Persist short-lived interaction context cleanly for multi-turn follow-ups ("Choose Germany" -> "Now select Master's degree")
      this._updateInteractionContext({
        currentFormKey: cand.formKey,
        currentFormLabel: cand.formContext || cand.section,
        lastControlId: cand.id,
        lastControlLabel: cand.label,
        lastControlType: cand.elementType,
        lastOptions: (cand.options || []).map((o) => ({ label: o.label, value: o.value })),
        lastSelectedValue: execResult.appliedValue || targetOption
      });

      // Track selection + learn dropdown correction within relevant host/form context if user corrected prior pick
      const pi = getPersonalIntelApi();
      const mem = this.widget && this.widget.memory;
      const host = (typeof window !== 'undefined' && window.location && window.location.hostname) || 'page';
      const spokenKey = parsedCmd.fieldHint || parsedCmd.targetOption || '';
      if (pi && mem && mem.state && options.isCorrection && this._lastSelectionMeta) {
        const lres = pi.recordControlCorrection(mem.state, {
          host,
          formKey: cand.formKey || 'default',
          spokenTarget: this._lastSelectionMeta.spokenTarget || spokenKey,
          wrongLabel: this._lastSelectionMeta.controlLabel,
          correctedLabel: cand.label,
          explicit: Boolean(options.explicitLearn)
        });
        if (lres && lres.learned && typeof mem.saveState === 'function') {
          void mem.saveState({ skipTabSync: true });
        }
      }
      this._lastSelectionMeta = {
        spokenTarget: spokenKey,
        controlLabel: cand.label,
        formKey: cand.formKey || 'default',
        ts: Date.now()
      };

      const okMsg = execResult.message || `Updated "${cand.label}" to "${execResult.appliedValue}".`;
      this._notifyStatus(okMsg, { state: 'speaking', title: cand.label, openCard: true, cardType: 'answer' });

      return {
        ok: true,
        verified: true,
        status: 'selected',
        controlId: cand.id,
        controlLabel: cand.label,
        controlType: cand.elementType,
        selectedValue: execResult.appliedValue || targetOption,
        alreadySet: Boolean(execResult.alreadySet),
        source: decision.source || 'deterministic',
        message: okMsg
      };
    }

    /**
     * Full Phase 4.1 entry point: parse -> detect candidates -> rank -> verify/clarify -> execute + verify DOM.
     */
    async handleCommand(rawText, options = {}) {
      const doc = options.doc || this._getDoc();
      const parsedCmd = this.parseSelectionCommand(rawText, options.intentArgs || {});
      const candidates = this.detectInteractiveCandidates(doc, options);

      const decision = await this.resolveCandidateDecision(rawText, candidates, parsedCmd, options);

      if (decision.action === 'delegate_list_item') {
        return { status: 'delegate_list_item', ordinalIndex: decision.ordinalIndex, noun: decision.noun };
      }

      if (decision.action === 'sensitive') {
        const el = decision.candidate && decision.candidate.element;
        if (el && typeof el.focus === 'function') el.focus();
        this._notifyStatus(decision.message, { state: 'idle', title: 'Protected Field', openCard: true });
        return { ok: false, status: 'sensitive_skipped', verified: false, message: decision.message };
      }

      if (decision.action === 'disabled') {
        this._notifyStatus(decision.message, { state: 'idle', title: 'Control Disabled', openCard: true, cardType: 'error' });
        return { ok: false, status: 'disabled', verified: false, message: decision.message };
      }

      if (decision.action === 'not_found') {
        this._notifyStatus(decision.message, { state: 'idle', title: 'Option Not Found', openCard: true, cardType: 'error' });
        return { ok: false, status: 'not_found', verified: false, message: decision.message };
      }

      if (decision.action === 'clarify' || decision.needsClarification) {
        const msg = decision.message || 'Which option or control did you mean?';
        const clCands = Array.isArray(decision.clarificationCandidates) ? decision.clarificationCandidates : [];
        const overlay = this._getCandidateOverlay(doc);
        let badgesShown = 0;
        if (overlay && clCands.length >= 2) {
          const highlightTargets = clCands.map((c) => ({
            label: c.label,
            element: (c._matchedOpt && (c._matchedOpt.clickTarget || c._matchedOpt.element)) || c.element
          }));
          const created = overlay.showCandidates(highlightTargets, { doc });
          badgesShown = created.length;
        }
        this._notifyStatus(msg, { state: 'confirm', title: 'Clarify Selection', openCard: true });
        if (this.widget && this.widget.dialogue && clCands.length >= 2) {
          this.widget.dialogue.setPendingPrompt({
            kind: 'choice',
            label: 'element_selection_clarification',
            askedText: msg,
            options: clCands.map((c) => `${c.section && c.section !== c.label ? `${c.section} — ${c.label}` : c.label}`),
            onClear: () => this.clearCandidateOverlay(doc),
            onAnswer: async (_picked, info) => {
              this.clearCandidateOverlay(doc);
              const idx = info && typeof info.index === 'number' ? info.index : 0;
              const pickedCand = clCands[idx];
              if (!pickedCand) return { status: 'cancelled' };
              if (pickedCand.options && parsedCmd.action === 'select_ordinal') {
                const chosenOpt = pickedCand.options[parsedCmd.ordinalIndex];
                if (!chosenOpt) return { status: 'not_found', message: `Option #${parsedCmd.ordinalIndex + 1} unavailable.` };
                return this.executeAndVerifyCandidate({ candidate: pickedCand, targetOption: chosenOpt.label, matchedOptionObj: chosenOpt }, parsedCmd, options);
              }
              return this.executeAndVerifyCandidate({
                candidate: pickedCand,
                targetOption: parsedCmd.targetOption,
                matchedOptionObj: pickedCand._matchedOpt || undefined,
                intendedAction: parsedCmd.action
              }, parsedCmd, options);
            }
          });
        }
        return {
          ok: false,
          verified: false,
          status: 'needs_clarification',
          ambiguityOverlay: badgesShown > 0,
          badgesShown,
          clarificationOptions: clCands.map((c) => c.label),
          message: msg
        };
      }

      return this.executeAndVerifyCandidate(decision, parsedCmd, options);
    }
  }

  return { SleepwalkerElementSelector, parsePriceFromText };
});
