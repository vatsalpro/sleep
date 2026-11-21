/**
 * Sleepwalker - form-index.js
 * Phase C2: Deep Accessible Form Control & Multi-Step Button Indexer
 *
 * Indexes visible controls across document, open shadow roots, and same-origin iframes:
 * - text, textarea, number, email, tel, date, search, url
 * - native <select>, <input list> datalist
 * - custom [role=combobox] / [role=listbox] (click-to-open vs type-to-filter)
 * - radio groups (native & [role=radiogroup]/[role=radio])
 * - checkbox groups & standalone checkboxes (including custom checkboxes with hidden inputs + visible label)
 * - switches ([role=switch])
 * - contenteditable regions
 *
 * Skips hidden/disabled controls (except custom checkboxes/radios paired with a visible label).
 * Resolves labels from label[for], wrapping label, aria-label, aria-labelledby, adjacent text,
 * plus group headers (fieldset legend, [role=group] label, row/section headers).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerFormIndex = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const SENSITIVE_RE = /\b(?:password|passwd|pwd|otp|one[-_\s]?time|passcode|pin\b(?!code)|upi[-_\s]?pin|upi|cvv|cvc|security[-_\s]?code|card[-_\s]?(?:number|no|num)|credit[-_\s]?card|debit[-_\s]?card|expiry|aadhaar|aadhar|uidai|pan[-_\s]?(?:card|number|no)?|bank[-_\s]?account|account[-_\s]?(?:number|no)|ifsc|routing[-_\s]?number|ssn|social[-_\s]?security|captcha|verification[-_\s]?code)\b/i;

  const SENSITIVE_AUTOCOMPLETE = new Set([
    'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'
  ]);

  const NEXT_STEP_RE = /^(?:next(?:\s+step|\s+section|\s+page)?|continue|proceed(?:\s+to\s+next)?|save\s*(?:&|and)\s*(?:continue|next)|step\s*\d+|आगे\s+बढ़ें|अगला\s+चरण|सेव\s+और\s+आगे)$/i;
  const SUBMIT_ACTION_RE = /\b(?:submit|apply(?:\s+now)?|search|register|send\s+application|finish|complete\s+order|place\s+order|checkout|confirm\s+booking|pay\s+now|सबमिट|आवेदन\s+करें|खोजें|जमा\s+करें)\b/i;

  function cleanText(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim();
  }

  function getAttr(el, name) {
    return (el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : '') || '';
  }

  function isSleepwalkerNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const id = node.id || '';
    if (id === 'sleepwalker-host' || id === 'sleepwalker-ui-host' || id === 'sleepwalker-candidate-overlay-root') {
      return true;
    }
    return getAttr(node, 'data-sleepwalker-ui') === '1';
  }

  function isInsideSleepwalker(el) {
    if (!el) return false;
    if (isSleepwalkerNode(el)) return true;
    if (typeof el.closest === 'function' && el.closest('#sleepwalker-host, #sleepwalker-ui-host, #sleepwalker-candidate-overlay-root, [data-sleepwalker-ui="1"]')) return true;
    let cur = el;
    while (cur) {
      if (isSleepwalkerNode(cur)) return true;
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
    }
    return false;
  }

  function hasHiddenAncestor(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (isSleepwalkerNode(cur)) return true;
      if (cur.hidden || getAttr(cur, 'hidden') !== '' && cur.hasAttribute && cur.hasAttribute('hidden')) return true;
      if (getAttr(cur, 'aria-hidden') === 'true') return true;
      const win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : (typeof window !== 'undefined' ? window : null);
      if (win && typeof win.getComputedStyle === 'function') {
        const st = win.getComputedStyle(cur);
        if (st && (st.display === 'none' || st.visibility === 'hidden')) return true;
      } else if (cur.style && (cur.style.display === 'none' || cur.style.visibility === 'hidden')) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function isElementVisuallyVisible(el, { allowDisabled = false } = {}) {
    if (!el || el.nodeType !== 1) return false;
    if (isInsideSleepwalker(el)) return false;
    if ((!allowDisabled && (el.disabled || getAttr(el, 'aria-disabled') === 'true')) || el.hidden || getAttr(el, 'aria-hidden') === 'true') {
      return false;
    }
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (win && typeof win.getComputedStyle === 'function') {
      const st = win.getComputedStyle(el);
      if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) {
        return false;
      }
    } else if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden' || el.style.opacity === '0')) {
      return false;
    }
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width === 0 && rect.height === 0) return false;
    }
    // Check ancestors in case parent panel/step is hidden
    let p = el.parentElement;
    while (p && p.nodeType === 1) {
      if (p.hidden || getAttr(p, 'aria-hidden') === 'true') return false;
      if (win && typeof win.getComputedStyle === 'function') {
        const pst = win.getComputedStyle(p);
        if (pst && (pst.display === 'none' || pst.visibility === 'hidden' || pst.opacity === '0')) return false;
      }
      p = p.parentElement;
    }
    return true;
  }

  function getDocLabelFor(doc, id) {
    if (!id || !doc || typeof doc.querySelectorAll !== 'function') return null;
    const labels = doc.querySelectorAll('label[for]');
    for (let i = 0; i < labels.length; i += 1) {
      if (labels[i].getAttribute('for') === id) return labels[i];
    }
    return null;
  }

  /**
   * Resolve a visible wrapping or label[for] element paired with a custom-styled hidden checkbox/radio.
   */
  function findVisibleCustomLabelForInput(el) {
    if (!el) return null;
    const rootNode = (el.getRootNode && el.getRootNode()) || el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const id = getAttr(el, 'id') || el.id;
    if (id && rootNode) {
      const forLbl = getDocLabelFor(rootNode, id);
      if (forLbl && isElementVisuallyVisible(forLbl)) return forLbl;
    }
    if (typeof el.closest === 'function') {
      const wrap = el.closest('label');
      if (wrap && isElementVisuallyVisible(wrap)) return wrap;
    }
    return null;
  }

  function getOwnNonControlText(container) {
    if (!container) return '';
    const kids = container.childNodes || [];
    if (kids.length === 0) {
      return cleanText(container.innerText || container.textContent);
    }
    let buf = '';
    for (let i = 0; i < kids.length; i += 1) {
      const c = kids[i];
      if (c.nodeType === 3) {
        buf += ' ' + (c.nodeValue || c.textContent || '');
      } else if (c.nodeType === 1 && !/^(INPUT|SELECT|TEXTAREA|OPTION|DATALIST)$/i.test(c.tagName)) {
        buf += ' ' + (c.innerText || c.textContent || '');
      }
    }
    return cleanText(buf) || cleanText(container.innerText || container.textContent);
  }

  function resolveAriaLabelledBy(el) {
    const idsRaw = getAttr(el, 'aria-labelledby');
    if (!idsRaw) return '';
    const rootNode = (el.getRootNode && el.getRootNode()) || el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!rootNode) return '';
    const parts = [];
    for (const id of idsRaw.trim().split(/\s+/)) {
      if (!id) continue;
      let target = null;
      if (typeof rootNode.getElementById === 'function') {
        target = rootNode.getElementById(id);
      } else if (typeof rootNode.querySelector === 'function') {
        try {
          const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
          target = rootNode.querySelector(`#${escaped}`);
        } catch (_e) {}
      }
      if (target) {
        const txt = getOwnNonControlText(target) || cleanText(target.innerText || target.textContent);
        if (txt) parts.push(txt);
      }
    }
    return cleanText(parts.join(' '));
  }

  function resolveAdjacentText(el) {
    if (!el) return '';
    let prev = el.previousSibling;
    let steps = 0;
    while (prev && steps < 4) {
      if (prev.nodeType === 3) {
        const t = cleanText(prev.nodeValue || prev.textContent);
        if (t && t.length <= 60) return t.replace(/[:*]+$/, '').trim();
      } else if (prev.nodeType === 1) {
        if (/^(LABEL|SPAN|STRONG|B|DIV|P|TH|TD|DT)$/i.test(prev.tagName) && !prev.querySelector('input,select,textarea')) {
          const t = cleanText(prev.innerText || prev.textContent);
          if (t && t.length <= 70) return t.replace(/[:*]+$/, '').trim();
        }
        break;
      }
      prev = prev.previousSibling;
      steps += 1;
    }

    // Check table cell layout: <td>Label</td><td><input></td> or <th>Label</th><td><input></td>
    if (typeof el.closest === 'function') {
      const td = el.closest('td');
      if (td && td.previousElementSibling) {
        const t = cleanText(td.previousElementSibling.innerText || td.previousElementSibling.textContent);
        if (t && t.length <= 70) return t.replace(/[:*]+$/, '').trim();
      }
    }
    return '';
  }

  function resolveFieldLabel(el) {
    if (!el) return '';
    const rootNode = (el.getRootNode && el.getRootNode()) || el.ownerDocument || (typeof document !== 'undefined' ? document : null);

    const ariaLabel = cleanText(getAttr(el, 'aria-label'));
    if (ariaLabel) return ariaLabel;

    const labelledBy = resolveAriaLabelledBy(el);
    if (labelledBy) return labelledBy;

    const id = getAttr(el, 'id') || el.id;
    if (id && rootNode) {
      const forLbl = getDocLabelFor(rootNode, id);
      if (forLbl) {
        const t = getOwnNonControlText(forLbl);
        if (t) return t;
      }
    }

    if (typeof el.closest === 'function') {
      const wrap = el.closest('label');
      if (wrap) {
        const t = getOwnNonControlText(wrap);
        if (t) return t;
      }
    }

    const adj = resolveAdjacentText(el);
    if (adj) return adj;

    const placeholder = cleanText(getAttr(el, 'placeholder'));
    if (placeholder) return placeholder;

    const title = cleanText(getAttr(el, 'title'));
    if (title) return title;

    const name = cleanText(getAttr(el, 'name'));
    if (name) return name.replace(/[_-]+/g, ' ');

    return id ? cleanText(id.replace(/[_-]+/g, ' ')) : '';
  }

  function resolveGroupHeader(el) {
    if (!el || typeof el.closest !== 'function') return '';
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) {
        const t = cleanText(legend.innerText || legend.textContent);
        if (t) return t;
      }
    }
    const roleGroup = el.closest('[role="group"], [role="radiogroup"]');
    if (roleGroup) {
      const gLabel = cleanText(getAttr(roleGroup, 'aria-label')) || resolveAriaLabelledBy(roleGroup);
      if (gLabel) return gLabel;
      const heading = roleGroup.querySelector(':scope > .group-title, :scope > .row-title, :scope > h2, :scope > h3, :scope > h4, :scope > legend');
      if (heading && !heading.contains(el)) {
        const t = cleanText(heading.innerText || heading.textContent);
        if (t) return t;
      }
    }
    const row = el.closest('.form-row, .field-row, .form-group-row, tr');
    if (row) {
      const titleEl = row.querySelector('.row-title, .group-label, :scope > th');
      if (titleEl && !titleEl.contains(el)) {
        const t = cleanText(titleEl.innerText || titleEl.textContent);
        if (t && t.length <= 60) return t.replace(/[:*]+$/, '').trim();
      }
    }
    return '';
  }

  function resolveNearbyHeading(el) {
    if (!el) return '';
    const scopeSelectors = 'section, article, [role="dialog"], [role="tabpanel"], [role="region"], form, .card, .panel, .section, .form-section, fieldset';
    let cur = el.parentElement;
    let depth = 0;
    while (cur && depth < 7) {
      if (typeof cur.querySelector === 'function') {
        const h = cur.querySelector('h1, h2, h3, h4, h5, h6, legend, [role="heading"], .section-title, .card-title, .modal-title');
        if (h && !h.contains(el)) {
          const txt = cleanText(h.innerText || h.textContent);
          if (txt && txt.length <= 100) return txt;
        }
      }
      if (typeof cur.matches === 'function' && cur.matches(scopeSelectors)) {
        const aria = cleanText(getAttr(cur, 'aria-label'));
        if (aria && aria.length <= 100) return aria;
      }
      cur = cur.parentElement;
      depth += 1;
    }
    return '';
  }

  function resolveFormContext(el) {
    if (!el || typeof el.closest !== 'function') {
      return { formId: '', formName: '', formLabel: '', formPurpose: 'generic', containerKey: '' };
    }
    const form = el.closest('form, [role="form"]');
    const section = el.closest('section, [role="dialog"], [role="tabpanel"], fieldset, [role="group"]');
    if (!form && !section) {
      return { formId: '', formName: '', formLabel: '', formPurpose: 'generic', containerKey: 'page' };
    }
    const host = form || section;
    const formId = cleanText(getAttr(host, 'id') || host.id);
    const formName = cleanText(getAttr(host, 'name'));
    const heading = resolveNearbyHeading(el);
    const formLabel = cleanText(getAttr(host, 'aria-label')) || resolveAriaLabelledBy(host) || heading || formName || formId || '';
    const txt = `${formId} ${formName} ${getAttr(host, 'action')} ${formLabel}`.toLowerCase();
    let formPurpose = 'generic';
    if (host.querySelector && host.querySelector('input[type="password"]')) formPurpose = 'login';
    else if (getAttr(host, 'role') === 'search') formPurpose = 'search';
    else if (/\b(?:shipping|delivery|billing|address|checkout|payment)\b/.test(txt)) formPurpose = /\bbilling\b/.test(txt) ? 'billing' : (/\bshipping|delivery\b/.test(txt) ? 'shipping' : 'checkout');
    else if (/\b(?:apply|application|admission|university|course|enroll|degree)\b/.test(txt)) formPurpose = 'application';
    else if (/\b(?:plan|pricing|subscription|tier)\b/.test(txt)) formPurpose = 'pricing';
    else if (/\b(?:preference|notification|setting|consent|terms)\b/.test(txt)) formPurpose = 'preferences';
    const containerKey = formId ? `form#${formId}` : (formName ? `form:${formName}` : (formLabel ? `sec:${formLabel.toLowerCase().slice(0, 48)}` : 'form'));
    return { formId, formName, formLabel, formPurpose, containerKey };
  }

  function isSensitiveField(el, explicitLabel = '', groupLabel = '') {
    if (!el) return false;
    const type = getAttr(el, 'type').toLowerCase();
    if (type === 'password') return true;
    const ac = getAttr(el, 'autocomplete').toLowerCase().trim();
    if (ac && SENSITIVE_AUTOCOMPLETE.has(ac)) return true;

    const fingerprint = [
      getAttr(el, 'id'),
      getAttr(el, 'name'),
      getAttr(el, 'placeholder'),
      getAttr(el, 'aria-label'),
      groupLabel,
      explicitLabel || resolveFieldLabel(el)
    ].join(' ');
    return SENSITIVE_RE.test(fingerprint);
  }

  function collectRoots(entryDoc, out = [], seen = new Set(), meta = { crossOriginFramesSkipped: 0 }, rootType = 'document') {
    if (!entryDoc || seen.has(entryDoc)) return out;
    seen.add(entryDoc);
    out.push({ rootNode: entryDoc, rootType });

    const all = typeof entryDoc.querySelectorAll === 'function' ? entryDoc.querySelectorAll('*') : [];
    for (let i = 0; i < all.length; i += 1) {
      const node = all[i];
      if (!node || isSleepwalkerNode(node)) continue;
      if (node.shadowRoot && !seen.has(node.shadowRoot)) {
        collectRoots(node.shadowRoot, out, seen, meta, 'shadow_dom');
      }
      if (String(node.tagName || '').toUpperCase() === 'IFRAME') {
        try {
          if (node.contentDocument && !seen.has(node.contentDocument)) {
            collectRoots(node.contentDocument, out, seen, meta, 'same_origin_iframe');
          }
        } catch (_e) {
          meta.crossOriginFramesSkipped += 1;
        }
      }
    }
    return out;
  }

  function resolveListboxOptions(el, rootDoc, { includeDisabled = false } = {}) {
    const options = [];
    const listId = getAttr(el, 'list');
    if (listId && rootDoc && typeof rootDoc.getElementById === 'function') {
      const datalist = rootDoc.getElementById(listId);
      if (datalist) {
        const opts = datalist.querySelectorAll('option');
        for (let i = 0; i < opts.length; i += 1) {
          const val = cleanText(opts[i].value || opts[i].textContent);
          if (val) options.push({ value: val, label: cleanText(opts[i].textContent) || val, element: opts[i], disabled: Boolean(opts[i].disabled) });
        }
        return options;
      }
    }

    const controlledId = getAttr(el, 'aria-controls') || getAttr(el, 'aria-owns');
    let listbox = null;
    if (controlledId && rootDoc) {
      for (const id of controlledId.trim().split(/\s+/)) {
        listbox = (typeof rootDoc.getElementById === 'function' && rootDoc.getElementById(id)) || null;
        if (listbox) break;
      }
    }
    if (!listbox && getAttr(el, 'role') === 'listbox') {
      listbox = el;
    }
    if (!listbox && el && typeof el.closest === 'function') {
      const wrap = el.closest('[data-dropdown], .dropdown, .custom-select, .select-wrapper, .searchable-select, .autocomplete-wrapper');
      if (wrap && typeof wrap.querySelector === 'function') {
        listbox = wrap.querySelector('[role="listbox"], [role="menu"], .dropdown-menu, .dropdown-options, .select-options, .options-list, ul.suggestions');
      }
    }
    if (listbox) {
      const optEls = listbox.querySelectorAll('[role="option"], [role="menuitem"], li[data-value], option, .dropdown-item, .select-option, .option-item, .autocomplete-item');
      for (let i = 0; i < optEls.length; i += 1) {
        const o = optEls[i];
        const isDisabled = Boolean(o.disabled || getAttr(o, 'aria-disabled') === 'true' || (o.classList && o.classList.contains('disabled')));
        if (isDisabled && !includeDisabled) continue;
        const lbl = cleanText(o.innerText || o.textContent || getAttr(o, 'aria-label'));
        const val = getAttr(o, 'data-value') || getAttr(o, 'value') || lbl;
        if (lbl) {
          options.push({
            element: o,
            value: val,
            label: lbl,
            disabled: isDisabled,
            selected: getAttr(o, 'aria-selected') === 'true' || (o.classList && o.classList.contains('selected'))
          });
        }
      }
    }
    return options;
  }

  function computeFieldState(descriptor) {
    if (!descriptor) return { empty: true, done: false, stateText: 'empty' };
    if (descriptor.sensitive) {
      const el = descriptor.element;
      const nonEmpty = Boolean(el && typeof el.value === 'string' && el.value.length > 0);
      return { empty: !nonEmpty, done: nonEmpty, stateText: nonEmpty ? 'entered' : 'empty' };
    }

    const el = descriptor.element;
    if (descriptor.type === 'switch') {
      const isOn = el.tagName === 'INPUT' ? Boolean(el.checked) : getAttr(el, 'aria-checked') === 'true';
      return { empty: false, done: true, checked: isOn, value: isOn ? 'on' : 'off', stateText: isOn ? 'on' : 'off' };
    }
    if (descriptor.type === 'checkbox') {
      const isChecked = el.tagName === 'INPUT' ? Boolean(el.checked) : getAttr(el, 'aria-checked') === 'true';
      return { empty: !isChecked, done: isChecked, checked: isChecked, value: isChecked ? 'checked' : '', stateText: isChecked ? 'checked' : 'unchecked' };
    }
    if (descriptor.type === 'checkbox_group') {
      const checkedLabels = (descriptor.options || [])
        .filter((o) => o.element && (o.element.tagName === 'INPUT' ? o.element.checked : getAttr(o.element, 'aria-checked') === 'true'))
        .map((o) => o.label);
      return {
        empty: checkedLabels.length === 0,
        done: checkedLabels.length > 0,
        selectedLabels: checkedLabels,
        value: checkedLabels.join(', '),
        stateText: checkedLabels.length > 0 ? checkedLabels.join(', ') : 'none selected'
      };
    }
    if (descriptor.type === 'radio') {
      const sel = (descriptor.options || []).find((o) =>
        o.element && (o.element.tagName === 'INPUT' ? o.element.checked : getAttr(o.element, 'aria-checked') === 'true')
      );
      return {
        empty: !sel,
        done: Boolean(sel),
        value: sel ? sel.label : '',
        stateText: sel ? sel.label : 'not selected'
      };
    }
    if (descriptor.type === 'select') {
      if (el.multiple) {
        const selOpts = Array.from(el.selectedOptions || (el.options ? Array.from(el.options).filter((o) => o.selected) : []));
        const selectedLabels = selOpts.map((o) => cleanText(o.textContent || o.label || o.value)).filter(Boolean);
        const selectedValues = selOpts.map((o) => String(o.value || '')).filter(Boolean);
        const empty = selectedValues.length === 0;
        return {
          empty,
          done: !empty,
          value: selectedLabels.join(', '),
          selectedValues,
          selectedLabels,
          stateText: empty ? 'empty' : selectedLabels.join(', ')
        };
      }
      const idx = typeof el.selectedIndex === 'number' ? el.selectedIndex : -1;
      const opt = idx >= 0 && el.options ? el.options[idx] : null;
      const val = String(el.value || '');
      const lbl = opt ? cleanText(opt.textContent || opt.label || val) : val;
      const empty = !val;
      return { empty, done: !empty, value: val, selectedLabel: lbl, stateText: empty ? 'empty' : lbl };
    }
    if (descriptor.type === 'range') {
      const val = el.tagName === 'INPUT'
        ? String(el.value !== undefined ? el.value : '')
        : String(getAttr(el, 'aria-valuetext') || getAttr(el, 'aria-valuenow') || '');
      return { empty: val === '', done: val !== '', value: val, stateText: val || 'unset' };
    }
    if (descriptor.type === 'combobox' || descriptor.type === 'listbox') {
      let val = '';
      if (descriptor.inputElement) {
        val = cleanText(descriptor.inputElement.value);
      } else if (getAttr(el, 'role') === 'listbox') {
        const sel = (descriptor.options || []).find((o) => o.selected || getAttr(o.element, 'aria-selected') === 'true');
        val = sel ? sel.label : '';
      } else {
        const placeholder = getAttr(el, 'data-placeholder') || getAttr(el, 'placeholder');
        const txt = cleanText(el.innerText || el.textContent || el.value);
        if (txt && txt.toLowerCase() !== placeholder.toLowerCase() && !/^select\b/i.test(txt)) {
          val = txt;
        }
      }
      return { empty: !val, done: Boolean(val), value: val, stateText: val || 'empty' };
    }
    if (descriptor.type === 'contenteditable') {
      const txt = cleanText(el.innerText || el.textContent);
      return { empty: !txt, done: Boolean(txt), value: txt, stateText: txt ? `${txt.slice(0, 40)}${txt.length > 40 ? '...' : ''}` : 'empty' };
    }

    const v = String(el && typeof el.value === 'string' ? el.value : '').trim();
    return { empty: !v, done: Boolean(v), value: v, stateText: v || 'empty' };
  }

  function resolveChoiceItemLabel(item, rootDoc, fallbackTarget = null) {
    if (!item) return '';
    const id = getAttr(item, 'id') || item.id;
    if (id && rootDoc) {
      const forLbl = getDocLabelFor(rootDoc, id);
      if (forLbl) {
        const t = getOwnNonControlText(forLbl);
        if (t) return t;
      }
    }
    if (typeof item.closest === 'function') {
      const wrap = item.closest('label');
      if (wrap) {
        const t = getOwnNonControlText(wrap);
        if (t) return t;
      }
    }
    return resolveFieldLabel(item) ||
      cleanText(fallbackTarget && (fallbackTarget.innerText || fallbackTarget.textContent)) ||
      cleanText(item.value) ||
      'Option';
  }

  /**
   * Build ordered index of visible form controls across document + shadow roots + same-origin iframes.
   */
  function buildFormIndex(entryDoc = (typeof document !== 'undefined' ? document : null), indexOpts = {}) {
    if (!entryDoc || typeof entryDoc.querySelectorAll !== 'function') return [];

    const includeDisabled = Boolean(indexOpts && indexOpts.includeDisabled);
    const visOpts = { allowDisabled: includeDisabled };
    const rootMeta = { crossOriginFramesSkipped: 0 };
    const roots = collectRoots(entryDoc, [], new Set(), rootMeta);
    const fields = [];
    const consumedEls = new Set();

    const addField = (desc, curRootType = 'document') => {
      const state = computeFieldState(desc);
      desc.value = state.value || '';
      desc.checked = Boolean(state.checked);
      desc.selectedLabels = state.selectedLabels || [];
      desc.selectedValues = state.selectedValues || [];
      desc.done = state.done;
      desc.empty = state.empty;
      desc.stateText = state.stateText;
      desc.disabled = Boolean(
        desc.disabled ||
        (desc.element && (desc.element.disabled || getAttr(desc.element, 'aria-disabled') === 'true'))
      );
      desc.nearbyHeading = desc.nearbyHeading || resolveNearbyHeading(desc.element);
      desc.formContext = desc.formContext || resolveFormContext(desc.element);
      desc.section = desc.group || desc.nearbyHeading || (desc.formContext && desc.formContext.formLabel) || '';
      desc.rootType = curRootType;
      desc.crossOriginFramesSkipped = rootMeta.crossOriginFramesSkipped;
      desc.rect = desc.element && typeof desc.element.getBoundingClientRect === 'function'
        ? desc.element.getBoundingClientRect()
        : { top: 0, left: 0, width: 0, height: 0 };
      desc.fullLabel = desc.group && !desc.label.toLowerCase().includes(desc.group.toLowerCase())
        ? `${desc.group} - ${desc.label}`
        : desc.label;
      desc.id = `sw_f_${fields.length}`;
      desc.index = fields.length;
      fields.push(desc);
    };

    for (const rootEntry of roots) {
      const rDoc = rootEntry.rootNode;
      const curRootType = rootEntry.rootType || 'document';
      // 1. Collect candidate nodes in DOM order inside each root
      const candidates = Array.from(rDoc.querySelectorAll(
        'input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="listbox"], [role="radiogroup"], [role="switch"], [role="checkbox"], [role="slider"], fieldset, [role="group"]'
      ));

      for (const node of candidates) {
        if (consumedEls.has(node) || isInsideSleepwalker(node)) continue;
        const tag = String(node.tagName || '').toUpperCase();
        const role = getAttr(node, 'role').toLowerCase();

        // A. ARIA Radio Group
        if (role === 'radiogroup') {
          if (!isElementVisuallyVisible(node, visOpts)) continue;
          const radioItems = Array.from(node.querySelectorAll('[role="radio"], input[type="radio"]')).filter((r) => !consumedEls.has(r));
          if (radioItems.length === 0) continue;
          const options = [];
          for (const r of radioItems) {
            const optDisabled = Boolean(r.disabled || getAttr(r, 'aria-disabled') === 'true');
            if (optDisabled && !includeDisabled) continue;
            const clickTarget = r.tagName === 'INPUT' ? (findVisibleCustomLabelForInput(r) || r) : r;
            if (!isElementVisuallyVisible(clickTarget, visOpts)) continue;
            consumedEls.add(r);
            options.push({
              element: r,
              clickTarget,
              disabled: optDisabled,
              value: getAttr(r, 'data-value') || getAttr(r, 'value') || resolveFieldLabel(r) || 'Option',
              label: resolveFieldLabel(r) || cleanText(r.innerText || r.textContent) || cleanText(clickTarget.innerText || clickTarget.textContent) || 'Option'
            });
          }
          if (options.length === 0) continue;
          consumedEls.add(node);
          const gHeader = resolveGroupHeader(options[0].element) || '';
          const label = cleanText(getAttr(node, 'aria-label')) || resolveAriaLabelledBy(node) || gHeader || 'Choice';
          const sensitive = isSensitiveField(node, label, gHeader);
          addField({
            type: 'radio',
            name: getAttr(node, 'name') || node.id || label,
            label,
            group: gHeader,
            disabled: Boolean(node.disabled || getAttr(node, 'aria-disabled') === 'true' || options.every((o) => o.disabled)),
            required: getAttr(node, 'aria-required') === 'true' || options.some((o) => Boolean(o.element.required)),
            sensitive,
            element: options[0].element,
            elements: options.map((o) => o.element),
            options
          }, curRootType);
          continue;
        }

        // B. Checkbox Group inside fieldset or [role=group] (2+ checkboxes)
        if (tag === 'FIELDSET' || role === 'group') {
          if (!isElementVisuallyVisible(node, visOpts)) continue;
          const groupCbs = Array.from(node.querySelectorAll('input[type="checkbox"]:not([role="switch"]), [role="checkbox"]'))
            .filter((cb) => !consumedEls.has(cb) && !hasHiddenAncestor(cb.parentElement));
          if (groupCbs.length >= 2) {
            const options = [];
            for (const cb of groupCbs) {
              const cbDisabled = Boolean(cb.disabled || getAttr(cb, 'aria-disabled') === 'true');
              if (cbDisabled && !includeDisabled) continue;
              const vis = isElementVisuallyVisible(cb, visOpts);
              const lblTarget = cb.tagName === 'INPUT' ? findVisibleCustomLabelForInput(cb) : null;
              if (!vis && !lblTarget) continue;
              consumedEls.add(cb);
              const optLabel = resolveFieldLabel(cb) || cleanText(lblTarget && (lblTarget.innerText || lblTarget.textContent)) || 'Option';
              options.push({
                element: cb,
                clickTarget: vis ? cb : lblTarget,
                hiddenInput: !vis,
                disabled: cbDisabled,
                value: getAttr(cb, 'value') || optLabel,
                label: optLabel
              });
            }
            if (options.length >= 2) {
              const gHeader = resolveGroupHeader(options[0].element) ||
                cleanText(getAttr(node, 'aria-label')) ||
                resolveAriaLabelledBy(node) ||
                'Options';
              addField({
                type: 'checkbox_group',
                name: getAttr(options[0].element, 'name') || node.id || gHeader,
                label: gHeader,
                group: gHeader,
                required: options.some((o) => Boolean(o.element.required || getAttr(o.element, 'aria-required') === 'true')),
                sensitive: isSensitiveField(node, gHeader, gHeader),
                element: options[0].element,
                elements: options.map((o) => o.element),
                options
              }, curRootType);
              continue;
            }
          }
          continue;
        }

        // C. Native Input / Select / Textarea
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          const isCtrlDisabled = Boolean(node.disabled || getAttr(node, 'aria-disabled') === 'true');
          if (isCtrlDisabled && !includeDisabled) continue;
          const type = tag === 'INPUT' ? (getAttr(node, 'type') || 'text').toLowerCase() : tag.toLowerCase();
          if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
          if (node.readOnly && !getAttr(node, 'role') && !getAttr(node, 'list')) continue;

          // Switch (role="switch" on checkbox)
          if (role === 'switch') {
            const lblTarget = findVisibleCustomLabelForInput(node);
            const vis = isElementVisuallyVisible(node, visOpts);
            if (!vis && !lblTarget) continue;
            consumedEls.add(node);
            const gHeader = resolveGroupHeader(node);
            const label = resolveFieldLabel(node) || 'Toggle';
            addField({
              type: 'switch',
              name: getAttr(node, 'name') || node.id || '',
              label,
              group: gHeader,
              disabled: isCtrlDisabled,
              required: Boolean(node.required || getAttr(node, 'aria-required') === 'true'),
              sensitive: isSensitiveField(node, label, gHeader),
              hiddenInput: !vis,
              element: node,
              clickTarget: vis ? node : lblTarget,
              elements: [node],
              options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }]
            }, curRootType);
            continue;
          }

          // Native Radio Group (grouped by name)
          if (type === 'radio') {
            const gName = getAttr(node, 'name') || node.id || `radio_${fields.length}`;
            const siblings = Array.from(rDoc.querySelectorAll('input')).filter(
              (r) => !consumedEls.has(r) && (includeDisabled || !r.disabled) && (getAttr(r, 'type') || 'text').toLowerCase() === 'radio' && ((getAttr(r, 'name') || r.id) === gName)
            );
            const options = [];
            for (const r of siblings) {
              const vis = isElementVisuallyVisible(r, visOpts);
              const lblTarget = findVisibleCustomLabelForInput(r);
              if (!vis && !lblTarget) continue;
              consumedEls.add(r);
              const rLabel = resolveChoiceItemLabel(r, rDoc, lblTarget);
              options.push({
                element: r,
                clickTarget: vis ? r : lblTarget,
                hiddenInput: !vis,
                disabled: Boolean(r.disabled || getAttr(r, 'aria-disabled') === 'true'),
                value: r.value || getAttr(r, 'value') || rLabel,
                label: rLabel
              });
            }
            if (options.length === 0) continue;
            const gHeader = resolveGroupHeader(options[0].element);
            const firstAria = cleanText(getAttr(options[0].element, 'aria-label'));
            const groupLabel = gHeader || firstAria || gName.replace(/[_-]+/g, ' ');
            addField({
              type: 'radio',
              name: gName,
              label: groupLabel,
              group: gHeader,
              disabled: options.every((o) => o.disabled),
              required: options.some((o) => Boolean(o.element.required || getAttr(o.element, 'aria-required') === 'true')),
              sensitive: isSensitiveField(node, groupLabel, gHeader),
              element: options[0].element,
              elements: options.map((o) => o.element),
              options
            }, curRootType);
            continue;
          }

          // Native Checkbox (grouped by shared name when 2+, else standalone checkbox)
          if (type === 'checkbox') {
            const gName = getAttr(node, 'name');
            if (gName) {
              const sameName = Array.from(rDoc.querySelectorAll('input')).filter(
                (cb) => !consumedEls.has(cb) && (includeDisabled || !cb.disabled) && (getAttr(cb, 'type') || 'text').toLowerCase() === 'checkbox' && getAttr(cb, 'name') === gName
              );
              if (sameName.length >= 2) {
                const options = [];
                for (const cb of sameName) {
                  const vis = isElementVisuallyVisible(cb, visOpts);
                  const lblTarget = findVisibleCustomLabelForInput(cb);
                  if (!vis && !lblTarget) continue;
                  consumedEls.add(cb);
                  const cbLabel = resolveChoiceItemLabel(cb, rDoc, lblTarget);
                  options.push({
                    element: cb,
                    clickTarget: vis ? cb : lblTarget,
                    hiddenInput: !vis,
                    disabled: Boolean(cb.disabled || getAttr(cb, 'aria-disabled') === 'true'),
                    value: cb.value || getAttr(cb, 'value') || cbLabel,
                    label: cbLabel
                  });
                }
                if (options.length >= 2) {
                  const gHeader = resolveGroupHeader(options[0].element) || gName.replace(/[_-]+/g, ' ');
                  addField({
                    type: 'checkbox_group',
                    name: gName,
                    label: gHeader,
                    group: gHeader,
                    disabled: options.every((o) => o.disabled),
                    required: options.some((o) => Boolean(o.element.required || getAttr(o.element, 'aria-required') === 'true')),
                    sensitive: isSensitiveField(node, gHeader, gHeader),
                    element: options[0].element,
                    elements: options.map((o) => o.element),
                    options
                  }, curRootType);
                  continue;
                }
              }
            }

            // Standalone checkbox (supports hidden input + visible label!)
            const vis = isElementVisuallyVisible(node, visOpts);
            const lblTarget = findVisibleCustomLabelForInput(node);
            if (!vis && !lblTarget) continue;
            consumedEls.add(node);
            const gHeader = resolveGroupHeader(node);
            const label = resolveFieldLabel(node) || cleanText(lblTarget && (lblTarget.innerText || lblTarget.textContent)) || `Checkbox ${fields.length + 1}`;
            addField({
              type: 'checkbox',
              name: gName || node.id || '',
              label,
              group: gHeader,
              disabled: isCtrlDisabled,
              required: Boolean(node.required || getAttr(node, 'aria-required') === 'true'),
              sensitive: isSensitiveField(node, label, gHeader),
              hiddenInput: !vis,
              element: node,
              clickTarget: vis ? node : lblTarget,
              elements: [node],
              options: []
            }, curRootType);
            continue;
          }

          // Visible text / select / datalist / combobox-input / autocomplete / range
          if (!isElementVisuallyVisible(node, visOpts)) continue;
          consumedEls.add(node);
          const gHeader = resolveGroupHeader(node);
          const label = resolveFieldLabel(node) || `Field ${fields.length + 1}`;
          const sensitive = isSensitiveField(node, label, gHeader);
          const ariaAutocomplete = getAttr(node, 'aria-autocomplete').toLowerCase();
          const isDatalistOrAriaCombo = role === 'combobox' || Boolean(getAttr(node, 'list')) || Boolean(ariaAutocomplete && ariaAutocomplete !== 'none');

          if (tag === 'SELECT') {
            const rawOpts = Array.from(node.options || node.querySelectorAll('option') || [])
              .filter((o) => String(o.value || '').trim() !== '')
              .map((o) => ({
                element: o,
                value: o.value,
                label: cleanText(o.textContent || o.label || o.value),
                disabled: Boolean(o.disabled || getAttr(o, 'aria-disabled') === 'true'),
                selected: Boolean(o.selected)
              }));
            const options = includeDisabled ? rawOpts : rawOpts.filter((o) => !o.disabled);
            addField({
              type: 'select',
              multiselect: Boolean(node.multiple),
              name: getAttr(node, 'name') || node.id || '',
              label,
              group: gHeader,
              disabled: isCtrlDisabled,
              required: Boolean(node.required || getAttr(node, 'aria-required') === 'true'),
              sensitive,
              element: node,
              elements: [node],
              options
            }, curRootType);
            continue;
          }

          if (type === 'range') {
            addField({
              type: 'range',
              min: getAttr(node, 'min') || '0',
              max: getAttr(node, 'max') || '100',
              step: getAttr(node, 'step') || '1',
              name: getAttr(node, 'name') || node.id || '',
              label,
              group: gHeader,
              disabled: isCtrlDisabled,
              required: Boolean(node.required || getAttr(node, 'aria-required') === 'true'),
              sensitive,
              element: node,
              elements: [node],
              options: []
            }, curRootType);
            continue;
          }

          if (isDatalistOrAriaCombo) {
            const options = resolveListboxOptions(node, rDoc, { includeDisabled });
            const cKind = getAttr(node, 'list') ? 'datalist' : (ariaAutocomplete ? 'autocomplete' : 'filter');
            addField({
              type: 'combobox',
              comboboxKind: cKind,
              ariaAutocomplete,
              multiselect: getAttr(node, 'aria-multiselectable') === 'true',
              name: getAttr(node, 'name') || node.id || '',
              label,
              group: gHeader,
              disabled: isCtrlDisabled,
              required: Boolean(node.required || getAttr(node, 'aria-required') === 'true'),
              sensitive,
              element: node,
              inputElement: node,
              triggerElement: node,
              elements: [node],
              options
            }, curRootType);
            continue;
          }

          addField({
            type,
            name: getAttr(node, 'name') || node.id || '',
            label,
            group: gHeader,
            disabled: isCtrlDisabled,
            required: Boolean(node.required || getAttr(node, 'aria-required') === 'true'),
            sensitive,
            element: node,
            elements: [node],
            options: []
          }, curRootType);
          continue;
        }

        // D. Custom ARIA Combobox / Listbox (click-to-open button/div or wrapper with filter input)
        if (role === 'combobox' || role === 'listbox') {
          if (!isElementVisuallyVisible(node, visOpts)) continue;
          // If wrapper contains an inner input[role=combobox], skip outer to avoid double indexing
          const innerInput = node.querySelector('input[role="combobox"], input[type="text"], input:not([type])');
          if (innerInput && consumedEls.has(innerInput)) continue;
          consumedEls.add(node);
          if (innerInput) consumedEls.add(innerInput);
          const gHeader = resolveGroupHeader(node);
          const label = resolveFieldLabel(node) || (innerInput && resolveFieldLabel(innerInput)) || `Dropdown ${fields.length + 1}`;
          const options = resolveListboxOptions(node, rDoc, { includeDisabled });
          const comboKind = innerInput ? 'filter' : 'click';
          addField({
            type: role,
            comboboxKind: comboKind,
            multiselect: getAttr(node, 'aria-multiselectable') === 'true',
            disabled: Boolean(node.disabled || getAttr(node, 'aria-disabled') === 'true'),
            name: getAttr(node, 'name') || node.id || '',
            label,
            group: gHeader,
            required: getAttr(node, 'aria-required') === 'true',
            sensitive: isSensitiveField(node, label, gHeader),
            element: node,
            inputElement: innerInput || null,
            triggerElement: node,
            elements: [node],
            options
          }, curRootType);
          continue;
        }

        // E. ARIA Switch
        if (role === 'switch') {
          if (!isElementVisuallyVisible(node, visOpts)) continue;
          consumedEls.add(node);
          const gHeader = resolveGroupHeader(node);
          const label = resolveFieldLabel(node) || cleanText(node.innerText || node.textContent) || 'Switch';
          addField({
            type: 'switch',
            disabled: Boolean(node.disabled || getAttr(node, 'aria-disabled') === 'true'),
            name: getAttr(node, 'name') || node.id || '',
            label,
            group: gHeader,
            required: getAttr(node, 'aria-required') === 'true',
            sensitive: isSensitiveField(node, label, gHeader),
            element: node,
            clickTarget: node,
            elements: [node],
            options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }]
          }, curRootType);
          continue;
        }

        // F. ARIA Checkbox
        if (role === 'checkbox') {
          if (!isElementVisuallyVisible(node, visOpts)) continue;
          consumedEls.add(node);
          const gHeader = resolveGroupHeader(node);
          const label = resolveFieldLabel(node) || cleanText(node.innerText || node.textContent) || 'Checkbox';
          addField({
            type: 'checkbox',
            disabled: Boolean(node.disabled || getAttr(node, 'aria-disabled') === 'true'),
            name: getAttr(node, 'name') || node.id || '',
            label,
            group: gHeader,
            required: getAttr(node, 'aria-required') === 'true',
            sensitive: isSensitiveField(node, label, gHeader),
            element: node,
            clickTarget: node,
            elements: [node],
            options: []
          }, curRootType);
          continue;
        }

        // F2. ARIA Slider
        if (role === 'slider') {
          if (!isElementVisuallyVisible(node, visOpts)) continue;
          consumedEls.add(node);
          const gHeader = resolveGroupHeader(node);
          const label = resolveFieldLabel(node) || 'Slider';
          addField({
            type: 'range',
            min: getAttr(node, 'aria-valuemin') || '0',
            max: getAttr(node, 'aria-valuemax') || '100',
            step: getAttr(node, 'data-step') || '1',
            disabled: Boolean(node.disabled || getAttr(node, 'aria-disabled') === 'true'),
            name: getAttr(node, 'name') || node.id || '',
            label,
            group: gHeader,
            required: getAttr(node, 'aria-required') === 'true',
            sensitive: isSensitiveField(node, label, gHeader),
            element: node,
            elements: [node],
            options: []
          }, curRootType);
          continue;
        }

        // G. ContentEditable
        if (node.isContentEditable || (getAttr(node, 'contenteditable') && getAttr(node, 'contenteditable') !== 'false')) {
          if (!isElementVisuallyVisible(node, visOpts)) continue;
          // Skip nested child inside already-indexed contenteditable ancestor
          if (node.parentElement && node.parentElement.isContentEditable) continue;
          consumedEls.add(node);
          const gHeader = resolveGroupHeader(node);
          const label = resolveFieldLabel(node) || 'Rich text box';
          addField({
            type: 'contenteditable',
            name: getAttr(node, 'name') || node.id || '',
            label,
            group: gHeader,
            required: getAttr(node, 'aria-required') === 'true',
            sensitive: isSensitiveField(node, label, gHeader),
            element: node,
            elements: [node],
            options: []
          }, curRootType);
        }
      }
    }

    return fields;
  }

  /**
   * Detect visible Next/Continue/Save-and-Next and Submit/Apply/Search buttons inside active forms.
   */
  function detectFormActionButtons(entryDoc = (typeof document !== 'undefined' ? document : null)) {
    if (!entryDoc || typeof entryDoc.querySelectorAll !== 'function') return { nextButtons: [], submitButtons: [] };
    const nextButtons = [];
    const submitButtons = [];
    const btns = Array.from(entryDoc.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'));
    for (const b of btns) {
      if (!isElementVisuallyVisible(b)) continue;
      const lbl = cleanText(b.innerText || b.textContent || b.value || getAttr(b, 'aria-label'));
      if (!lbl) continue;
      if (NEXT_STEP_RE.test(lbl)) {
        nextButtons.push({ element: b, label: lbl });
      } else if (getAttr(b, 'type').toLowerCase() === 'submit' || SUBMIT_ACTION_RE.test(lbl)) {
        submitButtons.push({ element: b, label: lbl });
      }
    }
    return { nextButtons, submitButtons };
  }

  if (typeof window !== 'undefined') {
    window.__SW_FORMS__ = () => {
      const list = buildFormIndex(document).map((f) => ({
        index: f.index,
        type: f.type,
        group: f.group || '',
        label: f.label,
        required: f.required,
        sensitive: f.sensitive,
        state: f.sensitive ? '[protected]' : f.stateText,
        optionsCount: (f.options || []).length
      }));
      if (console && typeof console.table === 'function') console.table(list);
      return list;
    };
  }

  return {
    buildFormIndex,
    collectRoots,
    detectFormActionButtons,
    computeFieldState,
    resolveFieldLabel,
    resolveGroupHeader,
    resolveNearbyHeading,
    resolveFormContext,
    isSensitiveField,
    isElementVisuallyVisible,
    findVisibleCustomLabelForInput,
    resolveListboxOptions
  };
});
