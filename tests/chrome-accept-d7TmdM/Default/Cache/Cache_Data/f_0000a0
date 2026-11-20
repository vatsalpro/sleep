/**
 * Sleepwalker - forms.js
 * Phase 5: Wispr-Style Dictation, Guided Form Fill, Opt-in Local Profile & Undo
 *
 * Non-negotiable safety rules:
 * - NEVER dictate, read existing values from, store, log, or send to any LLM:
 *   password, OTP, Aadhaar, PAN, card/CVV, bank account, UPI PIN, or CAPTCHA fields.
 *   Focus them and say: "I'll leave this one for you."
 * - NEVER auto-submit forms; submission requires double confirmation elsewhere.
 * - Use React/Angular-safe native value setters + input/change/blur events + Undo stack.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerForms = api.SleepwalkerForms;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const SENSITIVE_RE = /\b(?:password|passwd|pwd|otp|one[-_\s]?time|passcode|pin\b(?!code)|upi[-_\s]?pin|upi|cvv|cvc|security[-_\s]?code|card[-_\s]?(?:number|no|num)|credit[-_\s]?card|debit[-_\s]?card|expiry|aadhaar|aadhar|uidai|pan[-_\s]?(?:card|number|no)?|bank[-_\s]?account|account[-_\s]?(?:number|no)|ifsc|routing[-_\s]?number|ssn|social[-_\s]?security|captcha|verification[-_\s]?code)\b/i;

  const SENSITIVE_AUTOCOMPLETE = new Set([
    'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'
  ]);

  const ALLOWED_PROFILE_KEYS = ['fullName', 'email', 'phone', 'dob', 'address', 'city', 'state', 'pincode'];

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

  const DEVANAGARI_DIGITS = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
  };

  function hasDevanagari(str) {
    return /[\u0900-\u097F]/.test(String(str || ''));
  }

  function transliterateDevanagariToLatin(text) {
    const ff = getFormFillApi();
    if (ff && typeof ff.transliterateDevanagariToLatin === 'function') {
      return ff.transliterateDevanagariToLatin(text);
    }
    return String(text || '').replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] || d);
  }

  function parseSpokenNumbers(text, opts = {}) {
    const ff = getFormFillApi();
    if (ff && typeof ff.parseSpokenNumbers === 'function') {
      return ff.parseSpokenNumbers(text, opts);
    }
    let normalized = String(text || '').replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] || d);
    return normalized.trim();
  }

  function parseSpokenDate(text, outputType = 'date', nowDate = null) {
    const ff = getFormFillApi();
    if (ff && typeof ff.parseSpokenDate === 'function') {
      return ff.parseSpokenDate(text, outputType, nowDate);
    }
    return null;
  }

  function parseSpokenEmail(text) {
    const ff = getFormFillApi();
    if (ff && typeof ff.parseSpokenEmail === 'function') {
      return ff.parseSpokenEmail(text);
    }
    return String(text || '').toLowerCase().replace(/\s+/g, '');
  }

  function sanitizeProfileData(rawProfile) {
    const clean = {};
    if (!rawProfile || typeof rawProfile !== 'object') return clean;
    for (const key of ALLOWED_PROFILE_KEYS) {
      if (typeof rawProfile[key] === 'string' && rawProfile[key].trim()) {
        clean[key] = rawProfile[key].trim().slice(0, 140);
      }
    }
    return clean;
  }

  class SleepwalkerForms {
    constructor(widget, options = {}) {
      this.widget = widget || null;
      this.undoStack = [];
      this.lastFocusedField = null;
      this.lastFilledField = null;
      this.guidedState = null;
      this.manualTakeoverState = null;
      this.longDictationState = null;
      this._submitted = false;
      this.transliterateHindiToEnglish = Boolean(options.transliterateHindiToEnglish);
      this.profileOptIn = false;
      this.localProfile = {};
      this._focusListenerBound = false;
      this.bindFocusTracker();
    }

    isHalfDone() {
      if (this._submitted) return false;
      if (this.undoStack.length > 0) return true;
      if (this.isGuidedActive() && this.guidedState && this.guidedState.index > 0) return true;
      return Boolean(this.manualTakeoverState && this.manualTakeoverState.active);
    }

    isDictatingLongText() {
      return Boolean(this.longDictationState && this.longDictationState.active);
    }

    isAwaitingManualDone() {
      return Boolean(
        (this.manualTakeoverState && this.manualTakeoverState.active) ||
        (this.guidedState && this.guidedState.active && this.guidedState.awaitingSensitiveDone)
      );
    }

    _getDoc() {
      return typeof document !== 'undefined' ? document : null;
    }

    bindFocusTracker() {
      const doc = this._getDoc();
      if (!doc || typeof doc.addEventListener !== 'function' || this._focusListenerBound) return;
      this._focusListenerBound = true;
      doc.addEventListener('focusin', (e) => {
        const target = e && e.target;
        if (this._isEditablePageControl(target)) {
          this.lastFocusedField = target;
        }
      }, true);
    }

    _isInsideSleepwalker(el) {
      if (!el) return false;
      if (typeof el.closest === 'function' && el.closest('#sleepwalker-host')) return true;
      let cur = el;
      while (cur) {
        if (cur.id === 'sleepwalker-host') return true;
        cur = cur.parentElement;
      }
      return false;
    }

    _isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      if (this._isInsideSleepwalker(el)) return false;
      if (el.disabled || el.hidden || (el.getAttribute && el.getAttribute('aria-hidden') === 'true')) return false;
      const win = typeof window !== 'undefined' ? window : null;
      if (win && typeof win.getComputedStyle === 'function') {
        const s = win.getComputedStyle(el);
        if (s && (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0')) return false;
      }
      if (typeof el.getBoundingClientRect === 'function') {
        const rect = el.getBoundingClientRect();
        if (rect && rect.width === 0 && rect.height === 0) return false;
      }
      return true;
    }

    _isEditablePageControl(el) {
      if (!el || el.nodeType !== 1 || this._isInsideSleepwalker(el)) return false;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'select') return !el.readOnly && !el.disabled;
      if (tag === 'input') {
        const type = String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
        return !el.readOnly && !el.disabled;
      }
      return Boolean(el.isContentEditable);
    }

    resolveFieldLabel(el) {
      if (!el) return '';
      const doc = this._getDoc();
      const attr = (name) => (typeof el.getAttribute === 'function' ? el.getAttribute(name) : '') || '';

      const ariaLabel = attr('aria-label').trim();
      if (ariaLabel) return ariaLabel;

      const id = attr('id') || el.id;
      if (id && doc && typeof doc.querySelectorAll === 'function') {
        const labels = doc.querySelectorAll('label[for]');
        for (let i = 0; i < labels.length; i++) {
          if (labels[i].getAttribute('for') === id) {
            const text = (labels[i].innerText || labels[i].textContent || '').replace(/\s+/g, ' ').trim();
            if (text) return text;
          }
        }
      }

      if (typeof el.closest === 'function') {
        const wrap = el.closest('label');
        if (wrap) {
          let buf = '';
          const kids = wrap.childNodes || [];
          for (let i = 0; i < kids.length; i++) {
            const c = kids[i];
            if (c.nodeType === 3) buf += ' ' + (c.nodeValue || c.textContent || '');
            else if (c.nodeType === 1 && !/^(INPUT|SELECT|TEXTAREA)$/i.test(c.tagName)) {
              buf += ' ' + (c.innerText || c.textContent || '');
            }
          }
          const clean = buf.replace(/\s+/g, ' ').trim();
          if (clean) return clean;
        }
      }

      const placeholder = attr('placeholder').trim();
      if (placeholder) return placeholder;

      const title = attr('title').trim();
      if (title) return title;

      const name = attr('name').trim();
      if (name) return name.replace(/[_-]+/g, ' ');

      return id ? id.replace(/[_-]+/g, ' ') : '';
    }

    isSensitiveField(el, explicitLabel = '') {
      if (!el) return false;
      const attr = (name) => (typeof el.getAttribute === 'function' ? el.getAttribute(name) : '') || '';
      const type = attr('type').toLowerCase();
      if (type === 'password') return true;

      const ac = attr('autocomplete').toLowerCase().trim();
      if (ac && SENSITIVE_AUTOCOMPLETE.has(ac)) return true;

      const fingerprint = [
        attr('id'),
        attr('name'),
        attr('placeholder'),
        attr('aria-label'),
        explicitLabel || this.resolveFieldLabel(el)
      ].join(' ');
      return SENSITIVE_RE.test(fingerprint);
    }

    _fieldRequiresEnglishOnly(el) {
      if (!el) return false;
      const attr = (n) => (typeof el.getAttribute === 'function' ? el.getAttribute(n) : '') || '';
      const type = attr('type').toLowerCase();
      if (['email', 'url', 'tel', 'number', 'date'].includes(type)) return true;
      const pattern = attr('pattern');
      if (pattern && /\[a-z/i.test(pattern)) return true;
      return attr('data-ascii-only') === 'true';
    }

    /**
     * Detect all visible fields on page cleanly, grouping radio buttons sharing the same `name`.
     */
    detectFormFields(doc = this._getDoc()) {
      const fi = getFormIndexApi();
      if (fi && typeof fi.buildFormIndex === 'function') {
        return fi.buildFormIndex(doc);
      }
      if (!doc || typeof doc.querySelectorAll !== 'function') return [];
      const raw = Array.from(doc.querySelectorAll('input, select, textarea'));
      const fields = [];
      const seenRadioGroups = new Set();

      for (const el of raw) {
        if (!this._isVisible(el) || !this._isEditablePageControl(el)) continue;
        const tag = String(el.tagName || '').toLowerCase();
        const type = tag === 'input'
          ? String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase()
          : tag;
        if (type === 'file') continue; // Handled in Phase 6 Files

        if (type === 'radio') {
          const groupName = (el.getAttribute && el.getAttribute('name')) || el.id || `radio_${fields.length}`;
          if (seenRadioGroups.has(groupName)) continue;
          seenRadioGroups.add(groupName);

          const groupRadios = raw.filter((r) =>
            String(r.tagName || '').toLowerCase() === 'input' &&
            String((r.getAttribute && r.getAttribute('type')) || '').toLowerCase() === 'radio' &&
            ((r.getAttribute && r.getAttribute('name')) || r.id) === groupName &&
            this._isVisible(r)
          );
          const options = groupRadios.map((r) => {
            const rid = (typeof r.getAttribute === 'function' ? r.getAttribute('id') : '') || r.id;
            let optLabel = '';
            if (rid && doc && typeof doc.querySelectorAll === 'function') {
              const lbl = Array.from(doc.querySelectorAll('label[for]')).find((l) => l.getAttribute('for') === rid);
              if (lbl) optLabel = (lbl.innerText || lbl.textContent || '').replace(/\s+/g, ' ').trim();
            }
            if (!optLabel && typeof r.closest === 'function') {
              const wrap = r.closest('label');
              if (wrap) optLabel = (wrap.innerText || wrap.textContent || '').replace(/\s+/g, ' ').trim();
            }
            return {
              element: r,
              value: r.value || (r.getAttribute && r.getAttribute('value')) || '',
              label: optLabel || this.resolveFieldLabel(r) || r.value || 'Option'
            };
          });
          const groupLabel = (groupRadios[0] && groupRadios[0].getAttribute && groupRadios[0].getAttribute('aria-label')) ||
            groupName.replace(/[_-]+/g, ' ');
          const sensitive = this.isSensitiveField(el, groupLabel);

          fields.push({
            index: fields.length,
            type: 'radio',
            name: groupName,
            label: groupLabel,
            required: groupRadios.some((r) => Boolean(r.required || (r.getAttribute && r.getAttribute('aria-required') === 'true'))),
            sensitive,
            element: groupRadios[0],
            elements: groupRadios,
            options
          });
          continue;
        }

        const label = this.resolveFieldLabel(el) || `Field ${fields.length + 1}`;
        const sensitive = this.isSensitiveField(el, label);
        const options = tag === 'select'
          ? Array.from(el.options || el.querySelectorAll('option') || [])
              .filter((o) => String(o.value || '').trim() !== '')
              .map((o) => ({
                value: o.value,
                label: (o.textContent || o.label || o.value || '').trim()
              }))
          : [];

        fields.push({
          index: fields.length,
          type,
          name: (el.getAttribute && el.getAttribute('name')) || el.id || '',
          label,
          required: Boolean(el.required || (el.getAttribute && el.getAttribute('aria-required') === 'true')),
          sensitive,
          element: el,
          elements: [el],
          options
        });
      }

      return fields;
    }

    findTargetField(fieldHint = '') {
      const fields = this.detectFormFields();
      const doc = this._getDoc();
      const FIELD_ALIASES = {
        naam: 'name',
        नाम: 'name',
        pata: 'address',
        पता: 'address',
        shehar: 'city',
        शहर: 'city',
        rajya: 'state',
        राज्य: 'state',
        janam: 'birth',
        tarikh: 'date',
        tithi: 'date',
        fon: 'phone',
        mobile: 'phone',
        मोबाइल: 'phone',
        फ़ोन: 'phone',
        फोन: 'phone',
        ईमेल: 'email',
        पिनकोड: 'pincode',
        उम्र: 'age'
      };
      const rawHint = String(fieldHint || '')
        .toLowerCase()
        .replace(/\b(?:field|box|input|wala|mein|me|the|address)\b/g, (m) => (m === 'address' ? 'address' : ' '))
        .replace(/\s+/g, ' ')
        .trim();
      const cleanHint = rawHint
        .split(/\s+/)
        .map((tok) => FIELD_ALIASES[tok] || tok)
        .join(' ')
        .trim();

      if (cleanHint === '__last__') {
        if (this.lastFilledField) return this.lastFilledField;
        if (this.lastFocusedField && this._isEditablePageControl(this.lastFocusedField)) {
          return fields.find((f) => f.element === this.lastFocusedField) || this._descriptorFromElement(this.lastFocusedField);
        }
      }

      if (cleanHint) {
        let best = null;
        let bestScore = 0;
        for (const f of fields) {
          const cleanLabel = f.label.toLowerCase();
          const cleanFull = String(f.fullLabel || f.label).toLowerCase();
          const cleanName = String(f.name || '').toLowerCase();
          let score = 0;
          if (cleanLabel === cleanHint || cleanName === cleanHint || cleanFull === cleanHint) score = 100;
          else if (cleanLabel.includes(cleanHint) || cleanFull.includes(cleanHint) || cleanName.includes(cleanHint)) score = 80;
          else {
            const qTokens = cleanHint.split(/\s+/).filter(Boolean);
            const hits = qTokens.filter((qt) => cleanLabel.includes(qt) || cleanFull.includes(qt) || cleanName.includes(qt)).length;
            if (hits > 0) score = 50 + (hits / qTokens.length) * 25;
          }
          if (score > bestScore) {
            bestScore = score;
            best = f;
          }
        }
        if (best && bestScore >= 50) return best;
      }

      // Fall back to currently active element or last focused page field
      const activeEl = doc && doc.activeElement;
      if (this._isEditablePageControl(activeEl)) {
        const match = fields.find((f) => f.element === activeEl || (f.elements && f.elements.includes(activeEl)));
        if (match) return match;
        return {
          type: String((activeEl.getAttribute && activeEl.getAttribute('type')) || activeEl.tagName || 'text').toLowerCase(),
          label: this.resolveFieldLabel(activeEl) || 'Focused field',
          sensitive: this.isSensitiveField(activeEl),
          element: activeEl,
          elements: [activeEl],
          options: []
        };
      }

      if (this.lastFocusedField && this._isEditablePageControl(this.lastFocusedField)) {
        const match = fields.find((f) => f.element === this.lastFocusedField);
        if (match) return match;
        return {
          type: String((this.lastFocusedField.getAttribute && this.lastFocusedField.getAttribute('type')) || 'text').toLowerCase(),
          label: this.resolveFieldLabel(this.lastFocusedField) || 'Focused field',
          sensitive: this.isSensitiveField(this.lastFocusedField),
          element: this.lastFocusedField,
          elements: [this.lastFocusedField],
          options: []
        };
      }

      return null;
    }

    _handleSensitiveField(fieldDescriptor) {
      const el = fieldDescriptor && fieldDescriptor.element;
      if (el) {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (typeof el.focus === 'function') {
          el.focus();
        }
      }
      const msg = "I'll leave this one for you.";
      this._announce(msg, { openBubble: true, state: 'idle' });
      return { status: 'sensitive_skipped', message: msg };
    }

    /**
     * Format dictated text (fillers, punctuation, capitalisation, spoken numbers/dates/emails, Hindi transliteration).
     */
    formatDictation(rawText, fieldDescriptor = {}, options = {}) {
      let text = String(rawText || '').trim();
      const fieldType = String(fieldDescriptor.type || 'text').toLowerCase();
      const fieldLabel = String(fieldDescriptor.label || '').toLowerCase();
      let approxTranslit = false;

      // Strip conversational filler noises
      text = text
        .replace(/\b(?:uh+|um+|erm+|hmm+|basically|actually|matlab)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) return { text: '', transliterated: false };

      // Check approximate Hindi -> English Latin transliteration
      const el = fieldDescriptor.element;
      const shouldTransliterate = hasDevanagari(text) && (
        Boolean(options.transliterate) ||
        this.transliterateHindiToEnglish ||
        this._fieldRequiresEnglishOnly(el) ||
        fieldType === 'email'
      );

      if (shouldTransliterate) {
        text = transliterateDevanagariToLatin(text);
        approxTranslit = true;
      }

      if (fieldType === 'email' || /\be[-\s]?mail\b/i.test(fieldLabel)) {
        return { text: parseSpokenEmail(text), transliterated: approxTranslit };
      }

      if (fieldType === 'date' || /\b(?:date\s+of\s+birth|dob|birth\s*date|deadline)\b/i.test(fieldLabel)) {
        const parsedDate = parseSpokenDate(text, fieldType === 'date' ? 'date' : 'text');
        if (parsedDate) {
          return { text: parsedDate, transliterated: approxTranslit };
        }
      }

      if (fieldType === 'tel' || fieldType === 'number' || /\b(?:phone|mobile|pincode|pin\s*code|zip|age|fee|amount|marks|percent)\b/i.test(fieldLabel)) {
        const parsedNum = parseSpokenNumbers(text, { strictNumericMode: true });
        return {
          text: fieldType === 'tel' ? parsedNum.replace(/\s+/g, '') : parsedNum,
          transliterated: approxTranslit
        };
      }

      // Spoken formatting tokens for general text / textarea
      text = text
        .replace(/\b(?:new\s+line|next\s+line|naya\s+line)\b/gi, '\n')
        .replace(/\bcomma\b/gi, ',')
        .replace(/\b(?:full\s+stop|period|poorn\s+viram)\b/gi, '.')
        .replace(/\bquestion\s+mark\b/gi, '?')
        .replace(/\bexclamation\s+mark\b/gi, '!')
        .replace(/\bcolon\b/gi, ':')
        .replace(/\s+([,.;!?])/g, '$1')
        .replace(/ *\n */g, '\n');

      text = parseSpokenNumbers(text, { strictNumericMode: false });

      // Capitalize sentences (and Title Case for Name / City fields)
      if (/\b(?:name|city|state|district)\b/i.test(fieldLabel)) {
        text = text.replace(/\b([a-z])/g, (_, ch) => ch.toUpperCase());
      } else {
        text = text.replace(/(^|[.!?]\s+|\n)([a-z])/g, (_, prefix, ch) => prefix + ch.toUpperCase());
      }

      return { text: text.trim(), transliterated: approxTranslit };
    }

    _descriptorFromElement(el) {
      if (!el) return null;
      return {
        type: String((el.getAttribute && el.getAttribute('type')) || el.tagName || 'text').toLowerCase(),
        label: this.resolveFieldLabel(el) || 'Focused field',
        sensitive: this.isSensitiveField(el),
        element: el,
        elements: [el],
        options: []
      };
    }

    _captureSnapshot(fieldDescriptor) {
      if (!fieldDescriptor || this.isSensitiveField(fieldDescriptor.element, fieldDescriptor.label)) return null;
      const el = fieldDescriptor.element;
      if (!el) return null;

      if (fieldDescriptor.type === 'radio' && Array.isArray(fieldDescriptor.elements)) {
        return {
          kind: 'radio',
          label: fieldDescriptor.label,
          elements: fieldDescriptor.elements,
          states: fieldDescriptor.elements.map((r) => Boolean(r.checked || (r.getAttribute && r.getAttribute('aria-checked') === 'true')))
        };
      }
      if (fieldDescriptor.type === 'checkbox_group' && Array.isArray(fieldDescriptor.options)) {
        return {
          kind: 'checkbox_group',
          label: fieldDescriptor.label,
          descriptor: fieldDescriptor,
          options: fieldDescriptor.options,
          states: fieldDescriptor.options.map((o) => Boolean(
            o.element && (o.element.tagName === 'INPUT' ? o.element.checked : (o.element.getAttribute && o.element.getAttribute('aria-checked') === 'true'))
          ))
        };
      }
      if (fieldDescriptor.type === 'checkbox' || fieldDescriptor.type === 'switch') {
        const isChecked = el.tagName === 'INPUT'
          ? Boolean(el.checked)
          : Boolean(el.getAttribute && el.getAttribute('aria-checked') === 'true');
        return { kind: fieldDescriptor.type, label: fieldDescriptor.label, element: el, clickTarget: fieldDescriptor.clickTarget, checked: isChecked };
      }
      if (fieldDescriptor.type === 'select') {
        return {
          kind: 'select',
          label: fieldDescriptor.label,
          element: el,
          selectedIndex: typeof el.selectedIndex === 'number' ? el.selectedIndex : -1,
          value: String(el.value || '')
        };
      }
      if (fieldDescriptor.type === 'contenteditable') {
        return { kind: 'contenteditable', label: fieldDescriptor.label, element: el, value: String(el.textContent || '') };
      }
      return { kind: 'value', label: fieldDescriptor.label, element: el, value: String(el.value || '') };
    }

    _dispatchControlEvents(el, { includeClick = false, includeBlur = true } = {}) {
      if (!el || typeof el.dispatchEvent !== 'function') return;
      const Ev = (typeof Event === 'function')
        ? Event
        : function MockEvent(type, opts) { this.type = type; this.bubbles = Boolean(opts && opts.bubbles); };
      if (includeClick) {
        el.dispatchEvent(new Ev('click', { bubbles: true }));
      }
      el.dispatchEvent(new Ev('input', { bubbles: true }));
      el.dispatchEvent(new Ev('change', { bubbles: true }));
      if (includeBlur) {
        el.dispatchEvent(new Ev('blur', { bubbles: true }));
      }
    }

    /**
     * React / Angular-safe DOM control writer with highlight + state verification.
     */
    setControlValueSafe(fieldDescriptor, rawInputValue, { recordUndo = true, undoGroup = null, uncheck = false } = {}) {
      if (!fieldDescriptor || !fieldDescriptor.element) {
        return { ok: false, error: 'Target field not found.' };
      }
      if (fieldDescriptor.disabled || (fieldDescriptor.element && (fieldDescriptor.element.disabled || (fieldDescriptor.element.getAttribute && fieldDescriptor.element.getAttribute('aria-disabled') === 'true')))) {
        return { ok: false, status: 'disabled', verified: false, error: `"${fieldDescriptor.label}" is currently disabled.` };
      }
      if (this.isSensitiveField(fieldDescriptor.element, fieldDescriptor.label)) {
        return this._handleSensitiveField(fieldDescriptor);
      }

      const ff = getFormFillApi();
      const fi = getFormIndexApi();
      if (ff && typeof ff.highlightField === 'function') {
        ff.highlightField(fieldDescriptor.clickTarget || fieldDescriptor.element);
      }

      const snapshot = recordUndo ? this._captureSnapshot(fieldDescriptor) : null;
      const el = fieldDescriptor.element;
      const type = String(fieldDescriptor.type || 'text').toLowerCase();
      let appliedLabel = '';
      let verified = true;

      if (type === 'checkbox' || type === 'switch') {
        const s = String(rawInputValue || '').toLowerCase().trim();
        const checked = uncheck ? false : !/^(?:no|false|off|uncheck|untick|disable|remove|nahi|नहीं|0)$/i.test(s);
        const actual = ff && typeof ff.toggleBinaryElement === 'function'
          ? ff.toggleBinaryElement(el, fieldDescriptor.clickTarget, checked)
          : (() => { el.checked = checked; this._dispatchControlEvents(el, { includeClick: true }); return Boolean(el.checked); })();
        verified = (actual === checked);
        if (!verified) {
          return {
            ok: false,
            verified: false,
            error: `Tried to set "${fieldDescriptor.label}" to ${checked ? 'checked' : 'unchecked'}, but page kept it ${actual ? 'checked' : 'unchecked'}.`
          };
        }
        appliedLabel = type === 'switch' ? (actual ? 'on' : 'off') : (actual ? 'checked' : 'unchecked');
      } else if (type === 'checkbox_group' && Array.isArray(fieldDescriptor.options)) {
        const items = Array.isArray(rawInputValue)
          ? rawInputValue
          : String(rawInputValue || '').split(/\s*(?:,|&|\band\b|\baur\b|और)\s*/i).map((x) => x.trim()).filter(Boolean);
        const matchedLabels = [];
        for (const q of items) {
          const optRes = ff && typeof ff.matchChoiceOption === 'function'
            ? ff.matchChoiceOption(fieldDescriptor.options, q)
            : { status: 'matched', option: this._matchOption(fieldDescriptor.options, q) };
          if (optRes.status === 'ambiguous') {
            return { ok: false, status: 'ambiguous', candidates: optRes.candidates, error: `Multiple options match "${q}".` };
          }
          if (optRes.status !== 'matched' || !optRes.option || !optRes.option.element) {
            return { ok: false, error: `Could not find checkbox option "${q}" in ${fieldDescriptor.label}.` };
          }
          const opt = optRes.option;
          const desired = !uncheck;
          const actual = ff && typeof ff.toggleBinaryElement === 'function'
            ? ff.toggleBinaryElement(opt.element, opt.clickTarget, desired)
            : (() => { opt.element.checked = desired; this._dispatchControlEvents(opt.element, { includeClick: true }); return Boolean(opt.element.checked); })();
          if (actual !== desired) {
            return { ok: false, verified: false, error: `Could not ${desired ? 'tick' : 'untick'} "${opt.label}" — page kept it unchanged.` };
          }
          matchedLabels.push(opt.label);
        }
        appliedLabel = matchedLabels.join(', ');
      } else if (type === 'radio' && Array.isArray(fieldDescriptor.options)) {
        const q = String(rawInputValue || '').toLowerCase().trim();
        const optRes = ff && typeof ff.matchChoiceOption === 'function'
          ? ff.matchChoiceOption(fieldDescriptor.options, q)
          : { status: 'matched', option: this._matchOption(fieldDescriptor.options, q) };
        if (optRes.status === 'ambiguous') {
          return { ok: false, status: 'ambiguous', candidates: optRes.candidates, error: `Multiple options match "${rawInputValue}" in ${fieldDescriptor.label}.` };
        }
        const opt = optRes.option || this._matchOption(fieldDescriptor.options, q);
        if (!opt || !opt.element) {
          return { ok: false, error: `Could not match option "${rawInputValue}" for ${fieldDescriptor.label}.` };
        }
        if (opt.clickTarget && opt.clickTarget !== opt.element && typeof opt.clickTarget.click === 'function') {
          opt.clickTarget.click();
        }
        (fieldDescriptor.elements || []).forEach((r) => {
          if (r.tagName === 'INPUT') r.checked = (r === opt.element);
          else if (typeof r.setAttribute === 'function') r.setAttribute('aria-checked', r === opt.element ? 'true' : 'false');
        });
        this._dispatchControlEvents(opt.element, { includeClick: true });
        appliedLabel = opt.label || opt.value;
      } else if (type === 'select') {
        if (el.multiple && ff && typeof ff.setSelectMultiple === 'function') {
          const msRes = ff.setSelectMultiple(el, rawInputValue, { replace: false });
          if (!msRes.ok) return msRes;
          appliedLabel = msRes.appliedValue;
        } else {
          const opts = fieldDescriptor.options || [];
          const optRes = ff && typeof ff.matchChoiceOption === 'function'
            ? ff.matchChoiceOption(opts, String(rawInputValue || ''))
            : { status: 'matched', option: this._matchOption(opts, String(rawInputValue || '')) };
          if (optRes.status === 'ambiguous') {
            return { ok: false, status: 'ambiguous', candidates: optRes.candidates, error: `Multiple options match "${rawInputValue}" in ${fieldDescriptor.label}.` };
          }
          const opt = optRes.option;
          if (!opt) {
            return { ok: false, status: 'option_not_found', error: `Could not find option "${rawInputValue}" in ${fieldDescriptor.label}.` };
          }
          if (opt.disabled) {
            return { ok: false, status: 'disabled', verified: false, error: `Option "${opt.label}" in ${fieldDescriptor.label} is disabled.` };
          }
          if (ff && typeof ff.setNativeValue === 'function') {
            ff.setNativeValue(el, opt.value);
          } else {
            el.value = opt.value;
          }
          this._dispatchControlEvents(el);
          if (String(el.value || '') !== String(opt.value || '')) {
            verified = false;
            return {
              ok: false,
              verified: false,
              error: `Tried selecting "${opt.label}" in ${fieldDescriptor.label}, but page kept "${el.value || 'empty'}".`
            };
          }
          appliedLabel = opt.label || opt.value;
        }
      } else if (type === 'range') {
        const rangeRes = ff && typeof ff.setRangeValue === 'function'
          ? ff.setRangeValue(el, rawInputValue)
          : { ok: false, error: 'Range helper unavailable.' };
        if (!rangeRes.ok) return rangeRes;
        appliedLabel = rangeRes.appliedValue;
      } else if (type === 'contenteditable') {
        const valueStr = String(rawInputValue === undefined || rawInputValue === null ? '' : rawInputValue);
        el.textContent = valueStr;
        this._dispatchControlEvents(el);
        const actualText = String(el.textContent || '');
        verified = actualText.trim() === valueStr.trim();
        if (!verified) {
          return { ok: false, verified: false, error: `Tried updating "${fieldDescriptor.label}", but page changed it back.` };
        }
        appliedLabel = valueStr;
      } else {
        const valueStr = String(rawInputValue === undefined || rawInputValue === null ? '' : rawInputValue);
        if (ff && typeof ff.setNativeValue === 'function') {
          ff.setNativeValue(el, valueStr);
        } else {
          el.value = valueStr;
        }
        this._dispatchControlEvents(el);
        const actualVal = String(el.value || '');
        if (valueStr === '' && actualVal !== '') {
          verified = false;
        } else if (valueStr !== '' && actualVal !== valueStr) {
          // Date / number inputs may canonicalize formatting only; detect complete rejection/empty
          verified = Boolean(actualVal && (actualVal === valueStr || actualVal.toLowerCase() === valueStr.toLowerCase()));
        }
        if (!verified) {
          return {
            ok: false,
            verified: false,
            error: `Tried setting "${fieldDescriptor.label}" to "${valueStr}", but page shows "${actualVal || 'empty'}".`
          };
        }
        appliedLabel = valueStr;
      }

      if (recordUndo) {
        this.lastFilledField = fieldDescriptor;
        if (snapshot) {
          if (undoGroup) undoGroup.push(snapshot);
          else this.undoStack.push([snapshot]);
          if (this.undoStack.length > 20) this.undoStack.shift();
        }
      }

      const validationErrors = this.collectFieldValidationErrors(fieldDescriptor);
      const postState = fi && typeof fi.computeFieldState === 'function' ? fi.computeFieldState(fieldDescriptor) : null;
      return {
        ok: true,
        verified,
        appliedValue: appliedLabel,
        actualState: postState,
        validationErrors
      };
    }

    async setControlValueAsync(fieldDescriptor, rawInputValue, options = {}) {
      if (fieldDescriptor && (fieldDescriptor.type === 'combobox' || fieldDescriptor.type === 'listbox')) {
        if (this.isSensitiveField(fieldDescriptor.element, fieldDescriptor.label)) {
          return this._handleSensitiveField(fieldDescriptor);
        }
        const ff = getFormFillApi();
        const prevState = ff ? { kind: 'combobox', label: fieldDescriptor.label, element: fieldDescriptor.element, value: fieldDescriptor.value } : null;
        const res = await ff.applyComboboxValue(fieldDescriptor, rawInputValue);
        if (res && res.ok && options.recordUndo !== false) {
          this.lastFilledField = fieldDescriptor;
          if (prevState) {
            this.undoStack.push([prevState]);
            if (this.undoStack.length > 20) this.undoStack.shift();
          }
        }
        return res;
      }
      return this.setControlValueSafe(fieldDescriptor, rawInputValue, options);
    }

    _matchOption(options, query) {
      const q = String(query || '').toLowerCase().trim();
      if (!q || !Array.isArray(options) || options.length === 0) return null;

      // Support numeric choice 1..N
      if (/^[1-9]$/.test(q)) {
        const idx = parseInt(q, 10) - 1;
        if (idx >= 0 && idx < options.length) return options[idx];
      }

      return options.find((o) => String(o.label).toLowerCase() === q || String(o.value).toLowerCase() === q)
        || options.find((o) => String(o.label).toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q))
        || null;
    }

    /**
     * Collect native HTML5 + accessible DOM validation errors after filling a field.
     */
    collectFieldValidationErrors(fieldDescriptor) {
      const ff = getFormFillApi();
      if (ff && typeof ff.collectFieldValidationErrors === 'function') {
        return ff.collectFieldValidationErrors(fieldDescriptor, this._getDoc());
      }
      const el = fieldDescriptor && fieldDescriptor.element;
      if (!el || this.isSensitiveField(el, fieldDescriptor.label)) return [];
      return [];
    }

    /**
     * Find best field (and group/checkbox option fallback) for Free Mode commands.
     */
    _findFieldForFreeCommand(args = {}) {
      if (args.field) {
        const direct = this.findTargetField(args.field);
        if (direct) return direct;
      }
      if ((args.specialOp === 'check' || args.specialOp === 'uncheck') && (args.value || (args.multiValues && args.multiValues.length))) {
        const wanted = args.multiValues || String(args.value || '').split(/\s*(?:,|&|\band\b|\baur\b|और)\s*/i).filter(Boolean);
        const fields = this.detectFormFields();
        const ff = getFormFillApi();
        // Prefer checkbox_group matching any requested option label
        for (const f of fields) {
          if (f.type === 'checkbox_group' && Array.isArray(f.options)) {
            const anyHit = wanted.some((w) => {
              const m = ff ? ff.matchChoiceOption(f.options, w) : null;
              return m && m.status === 'matched';
            });
            if (anyHit) return f;
          }
        }
        // Fallback: individual matching checkboxes across form
        const matchedStandalone = [];
        for (const w of wanted) {
          const single = fields.find((f) => (f.type === 'checkbox' || f.type === 'switch') && (
            f.label.toLowerCase().includes(w.toLowerCase()) ||
            (ff && ff.matchChoiceOption([{ label: f.label, value: f.label }], w).status === 'matched')
          ));
          if (single) matchedStandalone.push(single);
        }
        if (matchedStandalone.length > 0) {
          return { __multiCheckTargets: matchedStandalone, label: matchedStandalone.map((m) => m.label).join(', '), sensitive: false };
        }
      }
      return this.findTargetField(args.field || '');
    }

    /**
     * Handle DICTATE intent (free-mode text/select/radio/checkbox-group/switch/combobox/clear/manual/long-dictation).
     */
    handleDictateIntent(args = {}, rawText = '') {
      const op = args.specialOp || '';

      if (op === 'manual_takeover') {
        const target = this.findTargetField(args.field || (this.isGuidedActive() ? this.guidedState.fields[this.guidedState.index].label : ''));
        return this.startManualTakeover(target || (this.isGuidedActive() ? this.guidedState.fields[this.guidedState.index] : null));
      }

      if (op === 'start_long_dictation') {
        const target = this.findTargetField(args.field || '');
        return this.startLongDictation(target);
      }

      if (op === 'submit_review' || op === 'next_step_review') {
        return this.reviewAndActOnStepOrSubmit(op === 'next_step_review' ? 'next_step' : 'submit');
      }

      const target = this._findFieldForFreeCommand(args);
      if (!target) {
        const noFieldMsg = 'Focus an input field or say its field name (e.g., "name field John") first.';
        this._announce(noFieldMsg, { openBubble: true, state: 'idle' });
        return { ok: false, message: noFieldMsg };
      }

      // Multi standalone checkbox matching (e.g. "tick blue and black")
      if (target.__multiCheckTargets) {
        const uncheck = op === 'uncheck';
        const doneNames = [];
        const batch = [];
        for (const subField of target.__multiCheckTargets) {
          if (subField.sensitive) continue;
          const r = this.setControlValueSafe(subField, uncheck ? 'no' : 'yes', { recordUndo: true, undoGroup: batch, uncheck });
          if (!r.ok) {
            this._announce(r.error, { openBubble: true, state: 'idle' });
            return r;
          }
          doneNames.push(subField.label);
        }
        if (batch.length > 0) this.undoStack.push(batch);
        const msg = `${uncheck ? 'Unchecked' : 'Checked'} ${doneNames.join(', ')}.`;
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: true, value: doneNames.join(', '), verified: true };
      }

      if (target.sensitive || this.isSensitiveField(target.element, target.label)) {
        return this._handleSensitiveField(target);
      }

      const el = target.element;

      if (op === 'clear') {
        const res = this.setControlValueSafe(target, '');
        const msg = res.ok ? `Cleared "${target.label}". Say "Undo" to restore.` : (res.error || 'Could not clear field.');
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: res.ok, message: msg };
      }

      if (op === 'delete_last') {
        const current = String(target.type === 'contenteditable' ? (el.textContent || '') : (el.value || ''));
        const trimmed = current.trimEnd();
        const cutIdx = Math.max(trimmed.lastIndexOf('\n'), trimmed.lastIndexOf('. '), trimmed.lastIndexOf(' '));
        const nextVal = cutIdx > 0 ? trimmed.slice(0, cutIdx).trimEnd() : '';
        this.setControlValueSafe(target, nextVal);
        const msg = `Removed last phrase from "${target.label}".`;
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: true, message: msg };
      }

      if (op === 'newline') {
        const current = String(target.type === 'contenteditable' ? (el.textContent || '') : (el.value || ''));
        this.setControlValueSafe(target, current + '\n');
        const msg = `Added new line in "${target.label}".`;
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: true, message: msg };
      }

      if (op === 'switch') {
        let desired = args.value;
        if (desired === 'toggle') {
          const fi = getFormIndexApi();
          const cur = fi ? fi.computeFieldState(target) : { checked: Boolean(el.checked) };
          desired = cur.checked ? 'off' : 'on';
        }
        const res = this.setControlValueSafe(target, desired, { uncheck: desired === 'off' });
        const msg = res.ok ? `Turned "${target.label}" ${res.appliedValue}.` : res.error;
        this._announce(msg, { openBubble: true, state: 'idle' });
        return res;
      }

      const uncheck = op === 'uncheck';
      const isChoiceOrToggle = ['select', 'radio', 'checkbox', 'checkbox_group', 'switch', 'combobox', 'listbox'].includes(target.type);
      const spokenVal = args.multiValues ? args.multiValues : (args.value || rawText);
      const formatted = isChoiceOrToggle
        ? { text: spokenVal, transliterated: false }
        : this.formatDictation(spokenVal, target);

      if (!formatted.text || (Array.isArray(formatted.text) && formatted.text.length === 0)) {
        this._announce(`No text heard to write into "${target.label}".`, { openBubble: true });
        return { ok: false };
      }

      // Popup ARIA combobox/listbox uses async click -> wait -> option select -> verify flow
      if (target.type === 'combobox' || target.type === 'listbox') {
        return this.setControlValueAsync(target, formatted.text).then((result) => this._reportApplyResult(target, result, formatted));
      }

      const result = this.setControlValueSafe(target, formatted.text, { uncheck });
      return this._reportApplyResult(target, result, formatted);
    }

    _reportApplyResult(target, result, formatted = { transliterated: false }) {
      if (!result) return { ok: false };
      if (result.status === 'ambiguous' && Array.isArray(result.candidates) && result.candidates.length > 0) {
        return this._askDisambiguatedChoice(target, result.candidates, (pickedOpt) => {
          const retryRes = target.type === 'combobox' || target.type === 'listbox'
            ? this.setControlValueAsync(target, pickedOpt.label || pickedOpt.value)
            : Promise.resolve(this.setControlValueSafe(target, pickedOpt.label || pickedOpt.value));
          Promise.resolve(retryRes).then((r2) => this._reportApplyResult(target, r2, { transliterated: false }));
        });
      }
      if (!result.ok) {
        this._announce(result.error, { openBubble: true, state: 'idle' });
        return result;
      }

      const ff = getFormFillApi();
      const spokenDisplay = target.type === 'tel' && ff
        ? ff.formatPhoneReadback(result.appliedValue)
        : result.appliedValue;
      let msg = formatted.transliterated
        ? `Filled "${target.label}" with approximate Hindi-to-English transliteration: "${spokenDisplay}".`
        : `Filled "${target.label}" with "${spokenDisplay}".`;

      if (result.validationErrors && result.validationErrors.length > 0) {
        msg += ` Validation warning: ${result.validationErrors.join(' ')}`;
      }
      this._announce(msg, { openBubble: true, state: 'idle' });
      return {
        ok: true,
        verified: result.verified !== false,
        value: result.appliedValue,
        transliterated: formatted.transliterated,
        validationErrors: result.validationErrors
      };
    }

    _askDisambiguatedChoice(fieldDescriptor, candidates, onPicked) {
      const topOpts = candidates.slice(0, 5);
      const listText = topOpts.map((c, idx) => `${idx + 1}. ${c.label}`).join(', ');
      const promptMsg = `Multiple matches for ${fieldDescriptor.label}: ${listText}. Which number or name?`;
      const confirmMgr = this.widget && this.widget.confirm;
      if (confirmMgr) {
        confirmMgr.request({
          id: `form_choice_${Date.now()}`,
          risk: 'medium',
          ambiguous: true,
          title: `Choose "${fieldDescriptor.label}"`,
          message: promptMsg,
          options: topOpts.map((c) => ({ label: c.label, value: c.value, raw: c })),
          onConfirm: ({ selectedOption } = {}) => {
            const picked = (selectedOption && selectedOption.raw) || topOpts[0];
            if (typeof onPicked === 'function') onPicked(picked);
          },
          onCancel: () => {
            if (this.isGuidedActive() && this.guidedState) {
              this.guidedState.awaitingValue = true;
            }
            this._announce(`Cancelled selection for ${fieldDescriptor.label}.`, { state: 'idle' });
          }
        });
      } else {
        this._announce(promptMsg, { openBubble: true });
      }
      return { ok: false, status: 'ambiguous', candidates: topOpts };
    }

    /**
     * Undo last dictated or auto-filled field (or batch).
     */
    undoLast() {
      if (this.undoStack.length === 0) {
        const msg = 'Nothing to undo yet.';
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: false, message: msg };
      }

      const batch = this.undoStack.pop();
      const restoredLabels = [];
      for (const snap of batch) {
        if (!snap) continue;
        if (snap.kind === 'radio' && Array.isArray(snap.elements)) {
          snap.elements.forEach((r, idx) => {
            if (r.tagName === 'INPUT') r.checked = Boolean(snap.states[idx]);
            else if (typeof r.setAttribute === 'function') r.setAttribute('aria-checked', snap.states[idx] ? 'true' : 'false');
          });
          if (snap.elements[0]) this._dispatchControlEvents(snap.elements[0], { includeClick: true });
        } else if (snap.kind === 'checkbox_group' && Array.isArray(snap.options)) {
          snap.options.forEach((opt, idx) => {
            if (!opt || !opt.element) return;
            const prevChecked = Boolean(snap.states[idx]);
            if (opt.element.tagName === 'INPUT') opt.element.checked = prevChecked;
            else if (typeof opt.element.setAttribute === 'function') opt.element.setAttribute('aria-checked', prevChecked ? 'true' : 'false');
            this._dispatchControlEvents(opt.element, { includeClick: false });
          });
        } else if ((snap.kind === 'checkbox' || snap.kind === 'switch') && snap.element) {
          if (snap.element.tagName === 'INPUT') snap.element.checked = snap.checked;
          else if (typeof snap.element.setAttribute === 'function') snap.element.setAttribute('aria-checked', snap.checked ? 'true' : 'false');
          this._dispatchControlEvents(snap.element, { includeClick: true });
        } else if (snap.kind === 'select' && snap.element) {
          snap.element.selectedIndex = snap.selectedIndex;
          snap.element.value = snap.value;
          this._dispatchControlEvents(snap.element);
        } else if (snap.kind === 'contenteditable' && snap.element) {
          snap.element.textContent = snap.value;
          this._dispatchControlEvents(snap.element);
        } else if (snap.element) {
          this.setControlValueSafe({ element: snap.element, type: 'text', label: snap.label }, snap.value, { recordUndo: false });
        }
        restoredLabels.push(snap.label);
      }

      const msg = `Undid changes to: ${restoredLabels.join(', ')}.`;
      this._announce(msg, { openBubble: true, state: 'idle' });
      return { ok: true, restored: restoredLabels };
    }

    /* ------------------------------------------------------------------ *
     * Manual Takeover & Long Text Dictation
     * ------------------------------------------------------------------ */

    startManualTakeover(fieldDescriptor) {
      const f = fieldDescriptor || (this.isGuidedActive() ? this.guidedState.fields[this.guidedState.index] : null) || this.findTargetField('');
      if (f && f.element) {
        if (typeof f.element.scrollIntoView === 'function') f.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (typeof f.element.focus === 'function') f.element.focus();
      }
      this.manualTakeoverState = {
        active: true,
        field: f || null,
        returnToGuided: this.isGuidedActive()
      };
      const label = f ? f.label : 'this field';
      const msg = `I'll pause here for "${label}". Please enter it yourself and tell me when done.`;
      this._announce(msg, { openBubble: true, state: 'idle' });
      return { ok: true, status: 'manual_takeover', field: label };
    }

    startLongDictation(fieldDescriptor) {
      const target = fieldDescriptor || this.findTargetField('');
      if (!target) {
        const msg = 'Focus a text area or box first to dictate.';
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: false, message: msg };
      }
      if (target.sensitive || this.isSensitiveField(target.element, target.label)) {
        return this._handleSensitiveField(target);
      }
      this.longDictationState = {
        active: true,
        field: target,
        returnToGuided: this.isGuidedActive()
      };
      const msg = `Dictating into "${target.label}". Keep speaking; say "that's all" when finished.`;
      this._announce(msg, { openBubble: true });
      return { ok: true, status: 'long_dictation_started' };
    }

    handleLongDictationInput(rawText) {
      if (!this.isDictatingLongText()) return false;
      const clean = String(rawText || '').trim();
      const target = this.longDictationState.field;
      const returnToGuided = this.longDictationState.returnToGuided;

      if (/^(?:that'?s\s+all|thats\s+all|done\s+dictating|stop\s+dictating|finish\s+dictating|bas\s+itna\s+hi|बस\s+इतना\s+ही)$/i.test(clean)) {
        this.longDictationState = null;
        if (returnToGuided && this.isGuidedActive()) {
          this.guidedState.index += 1;
          this._promptCurrentGuidedField();
        } else {
          this._announce(`Finished dictating into "${target.label}".`, { openBubble: true, state: 'idle' });
        }
        return true;
      }

      const formatted = this.formatDictation(clean, target);
      if (formatted.text) {
        const existing = String(target.type === 'contenteditable' ? (target.element.textContent || '') : (target.element.value || '')).trim();
        const combined = existing ? `${existing} ${formatted.text}` : formatted.text;
        this.setControlValueSafe(target, combined);
        this._announce(`Added to "${target.label}". Say more, or say "that's all" when finished.`, { openBubble: true });
      }
      return true;
    }

    handleManualOrSensitiveInput(rawText) {
      const clean = String(rawText || '').trim().toLowerCase();
      const isDone = /^(?:done|finished|finish|i'?m\s+done|complete|completed|ho\s+gaya|ready|next|हो\s+गया)$/i.test(clean);
      const isSkip = /^(?:skip|chhodo|छोड़ो)$/i.test(clean);

      // 1. Sensitive field guided wait
      if (this.isGuidedActive() && this.guidedState.awaitingSensitiveDone) {
        const f = this.guidedState.fields[this.guidedState.index];
        if (isSkip) {
          this.guidedState.awaitingSensitiveDone = false;
          this.guidedState.index += 1;
          this._promptCurrentGuidedField();
          return true;
        }
        if (isDone) {
          const nonEmpty = Boolean(f && f.element && typeof f.element.value === 'string' && f.element.value.length > 0);
          if (!nonEmpty) {
            this._announce('It still looks empty. Please enter this one yourself, then say "done" when finished (or "Skip").', { openBubble: true, state: 'idle' });
            return true;
          }
          this.guidedState.awaitingSensitiveDone = false;
          this._announce(`Verified entry in "${f.label}" without reading it.`, { openBubble: true });
          this.guidedState.index += 1;
          this._promptCurrentGuidedField();
          return true;
        }
        return false;
      }

      // 2. Manual takeover wait
      if (this.manualTakeoverState && this.manualTakeoverState.active) {
        const { field, returnToGuided } = this.manualTakeoverState;
        if (isSkip) {
          this.manualTakeoverState = null;
          if (returnToGuided && this.isGuidedActive()) {
            this.guidedState.index += 1;
            this._promptCurrentGuidedField();
          } else {
            this._announce('Skipped manual field.', { openBubble: true, state: 'idle' });
          }
          return true;
        }
        if (isDone) {
          const fi = getFormIndexApi();
          const st = field && fi ? fi.computeFieldState(field) : null;
          this.manualTakeoverState = null;
          if (field && (field.sensitive || this.isSensitiveField(field.element, field.label))) {
            const okSens = Boolean(field.element && typeof field.element.value === 'string' && field.element.value.length > 0);
            this._announce(okSens ? `Verified "${field.label}" is filled (kept private).` : `Moving on from "${field.label}".`, { openBubble: true });
          } else if (st && st.done) {
            this._announce(`Verified "${field.label}" is now "${st.stateText}".`, { openBubble: true });
          } else if (field) {
            this._announce(`Continuing — "${field.label}" appears empty.`, { openBubble: true });
          }
          if (returnToGuided && this.isGuidedActive()) {
            this.guidedState.index += 1;
            this._promptCurrentGuidedField();
          }
          return true;
        }
        this._announce('Take your time — say "done" when finished, or "skip".', { openBubble: true, state: 'idle' });
        return true;
      }
      return false;
    }

    /**
     * Guided step-by-step form filling (with progress, 6-option paging, phonetic choice matching,
     * sensitive verify-without-reading, manual takeover, multi-step resume, and double-confirm submit).
     */
    isGuidedActive() {
      return Boolean(this.guidedState && this.guidedState.active);
    }

    _countCompletedFields(fields = []) {
      const fi = getFormIndexApi();
      let done = 0;
      for (const f of fields) {
        if (!f) continue;
        if (fi && typeof fi.computeFieldState === 'function') {
          if (fi.computeFieldState(f).done) done += 1;
        } else if (f.element) {
          if (f.type === 'checkbox' && f.element.checked) done += 1;
          else if (f.element.value && String(f.element.value).trim()) done += 1;
        }
      }
      return done;
    }

    startGuidedFill(options = {}) {
      const fields = this.detectFormFields();
      if (fields.length === 0) {
        const msg = 'No fillable form fields found on this page.';
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: false, message: msg };
      }

      const startIdx = Math.min(Math.max(0, Number(options.startIndex) || 0), fields.length - 1);
      this.guidedState = {
        active: true,
        fields,
        index: startIdx,
        optionOffset: 0,
        awaitingValue: false,
        awaitingSensitiveDone: false,
        stepNumber: Number(options.stepNumber) || 1
      };
      this._promptCurrentGuidedField();
      return { ok: true, totalFields: fields.length };
    }

    stopGuidedFill(reason = 'stopped') {
      if (!this.guidedState) return;
      const fields = this.guidedState.fields || [];
      this.guidedState.active = false;
      this.guidedState = null;
      if (reason === 'completed') {
        const fi = getFormIndexApi();
        const doneCount = this._countCompletedFields(fields);
        const btns = fi ? fi.detectFormActionButtons(this._getDoc()) : { nextButtons: [], submitButtons: [] };
        if (btns.nextButtons.length > 0) {
          this._announce(`Finished ${doneCount} of ${fields.length} done. Say "Next step" to continue to the next page or "Submit" to review.`, { openBubble: true, state: 'idle' });
        } else {
          this._announce(`Guided form filling finished (${doneCount} of ${fields.length} done). Say "Submit" to review and confirm submission.`, { openBubble: true, state: 'idle' });
        }
      } else {
        this._announce('Guided form filling stopped.', { openBubble: true, state: 'idle' });
      }
    }

    _promptCurrentGuidedField() {
      if (!this.guidedState || !this.guidedState.active) return;
      const { fields, index } = this.guidedState;
      if (index >= fields.length) {
        this.stopGuidedFill('completed');
        return;
      }

      const f = fields[index];
      this.guidedState.optionOffset = 0;
      const doneCount = this._countCompletedFields(fields);
      const progressTag = `${doneCount} of ${fields.length} done.`;
      const ff = getFormFillApi();
      if (ff && typeof ff.highlightField === 'function') {
        ff.highlightField(f.clickTarget || f.element);
      }
      this._lastHighlightedEl = f.clickTarget || f.element;
      if (f.element && typeof f.element.focus === 'function') {
        f.element.focus();
      }

      if (f.sensitive || this.isSensitiveField(f.element, f.label)) {
        this.guidedState.awaitingValue = true;
        this.guidedState.awaitingSensitiveDone = true;
        this._announce(`Progress: ${progressTag} Field ${index + 1} of ${fields.length} (${f.label}): Please enter this one yourself. Say done when finished.`, { openBubble: true, state: 'idle' });
        return;
      }

      this.guidedState.awaitingSensitiveDone = false;
      this.guidedState.awaitingValue = true;
      const reqTag = f.required ? ' (required)' : '';
      const groupPrefix = f.group && !f.label.toLowerCase().includes(f.group.toLowerCase()) ? `${f.group} — ` : '';
      const extra = this._formatGuidedOptionsPrompt(f, 0);
      this._announce(`Progress: ${progressTag} Field ${index + 1} of ${fields.length}: ${groupPrefix}${f.label}${reqTag}.${extra} Speak your value (or say "Skip", "I'll do this one", or "Stop").`, { openBubble: true });
    }

    _formatGuidedOptionsPrompt(f, offset = 0) {
      if (f.type === 'checkbox') {
        return ' Say Yes to check or No to uncheck.';
      }
      if (f.type === 'switch') {
        return ' Say On or Off.';
      }
      const opts = Array.isArray(f.options) ? f.options : [];
      if (opts.length === 0) {
        if (f.type === 'combobox' || f.type === 'listbox') {
          return ' Speak the option name to select it.';
        }
        return '';
      }
      const slice = opts.slice(offset, offset + 6);
      const listStr = slice.map((o, idx) => `${offset + idx + 1}. ${o.label}`).join(', ');
      const hasMore = offset + 6 < opts.length;
      if (opts.length > 12 && offset === 0) {
        return ` ${opts.length} options (${listStr}). Speak any name or say "more" for the rest.`;
      }
      return ` Options: ${listStr}.${hasMore ? ' Say "more" for the rest.' : ''}`;
    }

    handleGuidedInput(rawText) {
      if (!this.isGuidedActive()) return false;
      const clean = String(rawText || '').trim();
      const lower = clean.toLowerCase();
      const { fields, index } = this.guidedState;
      const f = fields[index];

      if (f.sensitive || this.isSensitiveField(f.element, f.label)) {
        if (this.handleManualOrSensitiveInput(clean)) return true;
        this._handleSensitiveField(f);
        return true;
      }

      if (/^(?:stop|cancel|exit|band karo|रुको)$/i.test(lower)) {
        this.stopGuidedFill('cancelled');
        return true;
      }
      if (/^(?:next|skip|chhodo|aage|अगला|छोड़ो)$/i.test(lower)) {
        this.guidedState.index += 1;
        this._promptCurrentGuidedField();
        return true;
      }
      if (/^(?:i'?ll\s+do\s+this\s+one|i\s+will\s+do\s+this\s+one|i'?ll\s+fill\s+this|manual|manual\s+takeover)$/i.test(lower)) {
        this.startManualTakeover(f);
        return true;
      }
      if (/^(?:more|say\s+more|more\s+options|next\s+options|aur\s+dikhao|और\s+दिखाओ)$/i.test(lower)) {
        const opts = Array.isArray(f.options) ? f.options : [];
        if (opts.length === 0) {
          this._announce(`No option list for ${f.label}. Speak the value or say "Skip".`, { openBubble: true });
          return true;
        }
        const nextOff = (this.guidedState.optionOffset || 0) + 6;
        if (nextOff >= opts.length) {
          this.guidedState.optionOffset = 0;
          this._announce(`Reached end of options; wrapping to start.${this._formatGuidedOptionsPrompt(f, 0)}`, { openBubble: true });
        } else {
          this.guidedState.optionOffset = nextOff;
          this._announce(`${this._formatGuidedOptionsPrompt(f, nextOff)}`, { openBubble: true });
        }
        return true;
      }

      const ff = getFormFillApi();
      const isChoiceControl = ['select', 'radio', 'checkbox', 'checkbox_group', 'switch', 'combobox', 'listbox'].includes(f.type);

      // Phonetic choice matching for choice fields before confirmation
      let candidateValue = '';
      let formatted = { text: clean, transliterated: false };

      if (isChoiceControl && Array.isArray(f.options) && f.options.length > 0 && f.type !== 'checkbox_group') {
        const matchRes = ff ? ff.matchChoiceOption(f.options, clean) : null;
        if (matchRes && matchRes.status === 'ambiguous') {
          this.guidedState.awaitingValue = false;
          this._askDisambiguatedChoice(f, matchRes.candidates, (pickedOpt) => {
            this._confirmAndApplyGuidedValue(f, pickedOpt.label || pickedOpt.value, { transliterated: false });
          });
          return true;
        }
        candidateValue = matchRes && matchRes.status === 'matched'
          ? (matchRes.option.label || matchRes.option.value)
          : clean;
      } else if (isChoiceControl) {
        candidateValue = clean;
      } else {
        formatted = this.formatDictation(clean, f);
        candidateValue = formatted.text;
      }

      if (!candidateValue) {
        this._announce(`Could not hear a value for ${f.label}. Try again or say "Skip".`, { openBubble: true });
        return true;
      }

      return this._confirmAndApplyGuidedValue(f, candidateValue, formatted);
    }

    _confirmAndApplyGuidedValue(f, candidateValue, formatted = { transliterated: false }) {
      const ff = getFormFillApi();
      const confirmMgr = this.widget && this.widget.confirm;
      const index = this.guidedState ? this.guidedState.index : 0;

      const finishApply = (res) => {
        if (res && res.status === 'ambiguous' && Array.isArray(res.candidates)) {
          this.guidedState.awaitingValue = false;
          this._askDisambiguatedChoice(f, res.candidates, (pickedOpt) => {
            this._confirmAndApplyGuidedValue(f, pickedOpt.label || pickedOpt.value, { transliterated: false });
          });
          return;
        }
        if (!res || !res.ok) {
          this._announce((res && res.error) || `Could not update ${f.label}.`, { openBubble: true });
          if (this.guidedState) this.guidedState.awaitingValue = true;
          return;
        }
        if (res.validationErrors && res.validationErrors.length > 0) {
          this._announce(`Validation error on ${f.label}: ${res.validationErrors.join(' ')} Say a corrected value or "Skip".`, { openBubble: true });
          if (this.guidedState) this.guidedState.awaitingValue = true;
          return;
        }
        if (this.guidedState) {
          this.guidedState.index += 1;
          this._promptCurrentGuidedField();
        }
      };

      const applyNow = () => {
        if (f.type === 'combobox' || f.type === 'listbox') {
          this.setControlValueAsync(f, candidateValue).then(finishApply);
        } else {
          finishApply(this.setControlValueSafe(f, candidateValue));
        }
      };

      if (!confirmMgr) {
        applyNow();
        return true;
      }

      let displayVal = candidateValue;
      if (f.type === 'tel' && ff) {
        displayVal = ff.formatPhoneReadback(candidateValue);
      } else if (formatted.transliterated) {
        displayVal = `${candidateValue} (approximate English letters)`;
      }

      if (this.guidedState) this.guidedState.awaitingValue = false;

      confirmMgr.request({
        id: `guided_field_${index}_${Date.now()}`,
        risk: 'high',
        title: `Confirm "${f.label}"`,
        message: `Set ${f.label} to "${displayVal}"? Say Yes to fill, or No to change.`,
        onConfirm: applyNow,
        onCancel: (reason) => {
          if (reason === 'replaced') return;
          if (this.guidedState) {
            this.guidedState.awaitingValue = true;
          }
          this._announce(`Okay, tell me the new value for ${f.label} (or say "Skip").`, { openBubble: true });
        }
      });
      return true;
    }

    /**
     * Review summary card + spoken summary before multi-step Next or final Submit/Apply/Search.
     * NEVER auto-submits; requires explicit confirmation (and double confirm for critical submit).
     */
    reviewAndActOnStepOrSubmit(kind = 'submit', explicitButton = null) {
      const doc = this._getDoc();
      const fi = getFormIndexApi();
      const ff = getFormFillApi();
      const fields = this.detectFormFields(doc);
      const summary = ff ? ff.buildNonSensitiveSummary(fields) : { totalCount: fields.length, filledCount: 0, requiredMissing: [], lines: [] };
      const btns = fi ? fi.detectFormActionButtons(doc) : { nextButtons: [], submitButtons: [] };

      const targetBtn = explicitButton || (kind === 'next_step'
        ? (btns.nextButtons[0] && btns.nextButtons[0].element)
        : (btns.submitButtons[0] && btns.submitButtons[0].element));
      const targetLabel = (explicitButton && (explicitButton.innerText || explicitButton.value)) ||
        (kind === 'next_step' ? ((btns.nextButtons[0] && btns.nextButtons[0].label) || 'Next') : ((btns.submitButtons[0] && btns.submitButtons[0].label) || 'Submit'));

      if (!targetBtn) {
        const msg = `No "${kind === 'next_step' ? 'Next' : 'Submit'}" button found on this form.`;
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: false, message: msg };
      }

      const missingNote = summary.requiredMissing.length > 0
        ? ` Missing required: ${summary.requiredMissing.join(', ')}.`
        : '';
      const spokenSummary = `Form summary (${summary.filledCount} of ${summary.totalCount} filled).${missingNote}`;
      const confirmMgr = this.widget && this.widget.confirm;
      if (!confirmMgr) {
        this._announce(`${spokenSummary} Say Yes to proceed with ${targetLabel}.`, { openBubble: true });
        return { ok: false, awaitingConfirm: true, summary };
      }

      const doClick = async () => {
        if (kind === 'next_step') {
          await this.saveMultiStepSession({
            stepNumber: ((this.guidedState && this.guidedState.stepNumber) || 1) + 1,
            lastTargetLabel: targetLabel,
            summaryLines: summary.lines
          });
        } else {
          this._submitted = true;
          if (this.widget && this.widget.navigator) {
            await this.widget.navigator.clearSessionState();
          }
        }
        targetBtn.click();
        this._announce(kind === 'next_step' ? `Moving to next step via "${targetLabel}".` : `Submitted via "${targetLabel}".`, { openBubble: true, state: 'idle' });
      };

      return confirmMgr.request({
        id: `form_${kind}_${Date.now()}`,
        risk: kind === 'next_step' ? 'high' : 'critical',
        title: kind === 'next_step' ? `Continue to Next Step ("${targetLabel}")` : `Confirm Final Action: "${targetLabel}"`,
        message: `${spokenSummary} ${kind === 'next_step' ? 'Continue to the next step?' : 'Submit form now? Please confirm twice.'}`,
        summary: summary.lines.length > 0 ? summary.lines : ['No non-sensitive values entered yet.'],
        onConfirm: doClick,
        onCancel: (reason) => {
          if (reason !== 'replaced') {
            this._announce('Cancelled. Your form values stay as they are.', { openBubble: true, state: 'idle' });
          }
        }
      });
    }

    saveMultiStepSession(payload = {}) {
      const state = {
        active: true,
        kind: 'multistep_form',
        stepNumber: payload.stepNumber || 2,
        lastTargetLabel: payload.lastTargetLabel || 'Next Form Step',
        summaryLines: Array.isArray(payload.summaryLines) ? payload.summaryLines : [],
        updatedAt: Date.now()
      };
      if (this.widget && this.widget.navigator && typeof this.widget.navigator.saveSessionState === 'function') {
        return this.widget.navigator.saveSessionState(state);
      }
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
          chrome.storage.session.set({ sleepwalker_session_task: state }, () => resolve(true));
        } else {
          resolve(false);
        }
      });
    }

    resumeMultiStepForm(state = {}) {
      const fields = this.detectFormFields();
      if (fields.length === 0) return false;
      const stepNum = state.stepNumber || 2;
      this.startGuidedFill({ startIndex: 0, stepNumber: stepNum });
      return true;
    }

    /**
     * Opt-in local profile (non-sensitive fields only) in chrome.storage.local.
     */
    loadProfile() {
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(['sleepwalker_profile_optin', 'sleepwalker_local_profile'], (data) => {
            this.profileOptIn = Boolean(data.sleepwalker_profile_optin);
            this.localProfile = sanitizeProfileData(data.sleepwalker_local_profile);
            resolve({ optIn: this.profileOptIn, profile: this.localProfile });
          });
        } else {
          resolve({ optIn: this.profileOptIn, profile: this.localProfile });
        }
      });
    }

    saveProfile({ optIn, profile }) {
      this.profileOptIn = Boolean(optIn);
      this.localProfile = sanitizeProfileData(profile);
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({
            sleepwalker_profile_optin: this.profileOptIn,
            sleepwalker_local_profile: this.localProfile
          }, () => resolve({ ok: true, profile: this.localProfile }));
        } else {
          resolve({ ok: true, profile: this.localProfile });
        }
      });
    }

    async fillFromProfile() {
      await this.loadProfile();
      if (!this.profileOptIn) {
        const msg = 'Local profile autofill is turned off. Turn on Opt-in Profile inside the Forms tab and save non-sensitive details first.';
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: false, reason: 'opt_in_disabled' };
      }

      const fields = this.detectFormFields();
      const matches = [];
      for (const f of fields) {
        if (f.sensitive || this.isSensitiveField(f.element, f.label)) continue;
        const val = this._matchProfileValue(f, this.localProfile);
        if (val) {
          matches.push({ field: f, value: val });
        }
      }

      if (matches.length === 0) {
        const msg = 'No matching non-sensitive fields found for your saved profile.';
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: false, reason: 'no_matches' };
      }

      const summaryLines = matches.map((m) => `${m.field.label}: ${m.value}`);
      const applyAll = () => {
        const undoBatch = [];
        const errors = [];
        for (const m of matches) {
          const res = this.setControlValueSafe(m.field, m.value, { recordUndo: true, undoGroup: undoBatch });
          if (res.validationErrors && res.validationErrors.length > 0) {
            errors.push(`${m.field.label}: ${res.validationErrors.join(' ')}`);
          }
        }
        if (undoBatch.length > 0) this.undoStack.push(undoBatch);
        let msg = `Filled ${matches.length} fields from your local profile. Never auto-submitted; say "Undo" to revert.`;
        if (errors.length > 0) msg += ` Validation notices: ${errors.join(' ')}`;
        this._announce(msg, { openBubble: true, state: 'idle' });
      };

      const confirmMgr = this.widget && this.widget.confirm;
      if (!confirmMgr) {
        applyAll();
        return { ok: true, count: matches.length };
      }

      return confirmMgr.request({
        id: `fill_profile_${Date.now()}`,
        risk: 'high',
        title: 'Fill Saved Details?',
        message: `Review ${matches.length} non-sensitive fields before filling (never auto-submits):`,
        summary: summaryLines,
        onConfirm: applyAll,
        onCancel: (reason) => {
          if (reason !== 'replaced') {
            this._announce('Profile autofill cancelled.', { state: 'idle' });
          }
        }
      });
    }

    _matchProfileValue(field, profile) {
      const fingerprint = `${field.label} ${field.name} ${field.type}`.toLowerCase();
      if (/\be[-\s]?mail\b/.test(fingerprint) && profile.email) return profile.email;
      if (/\b(?:phone|mobile|tel|contact)\b/.test(fingerprint) && profile.phone) return profile.phone;
      if (/\b(?:dob|birth)\b/.test(fingerprint) && profile.dob) return profile.dob;
      if (/\b(?:pin\s*code|pincode|postal|zip)\b/.test(fingerprint) && profile.pincode) return profile.pincode;
      if (/\bcity|town\b/.test(fingerprint) && profile.city) return profile.city;
      if (/\bstate|province\b/.test(fingerprint) && profile.state) return profile.state;
      if (/\baddress|street\b/.test(fingerprint) && profile.address) return profile.address;
      if (/\b(?:full\s*name|applicant\s*name|your\s*name|naam|name)\b/.test(fingerprint) && profile.fullName) return profile.fullName;
      return '';
    }

    /**
     * Identify visible form fields, explain each field's purpose & required status cleanly
     * without ever reading or collecting sensitive credentials.
     */
    inspectAndSummarizeForm(doc = this._getDoc()) {
      const fields = this.detectFormFields(doc);
      if (fields.length === 0) {
        const msg = 'No interactive form fields were found on this page.';
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { status: 'no_form', totalCount: 0, fields: [], missingRequired: [], invalidFields: [], message: msg };
      }

      const fi = getFormIndexApi();
      const missingRequired = [];
      const invalidFields = [];
      const items = fields.map((f) => {
        const sensitive = Boolean(f.sensitive || this.isSensitiveField(f.element, f.label));
        const st = fi && typeof fi.computeFieldState === 'function' ? fi.computeFieldState(f) : { done: Boolean(f.element && f.element.value) };
        const req = Boolean(f.required || (f.element && (f.element.required || (f.element.getAttribute && f.element.getAttribute('aria-required') === 'true'))));
        const valErr = !sensitive && typeof this.checkValidationError === 'function' ? this.checkValidationError(f) : '';

        if (req && !st.done) missingRequired.push(f.label);
        if (valErr) invalidFields.push({ label: f.label, error: valErr });

        const stateNote = sensitive
          ? 'sensitive (you enter directly)'
          : (valErr ? `needs fix: ${valErr}` : (st.done ? 'filled' : (req ? 'missing, required' : 'optional, empty')));
        return {
          label: f.label,
          type: f.type,
          required: req,
          sensitive,
          filled: Boolean(st.done),
          validationError: valErr,
          summaryLine: `${f.label} (${stateNote})`
        };
      });

      const msg =
        `Found ${fields.length} form field${fields.length === 1 ? '' : 's'}: ` +
        items.slice(0, 6).map((x) => x.summaryLine).join('; ') +
        (missingRequired.length > 0 ? `. Missing required: ${missingRequired.join(', ')}.` : '. Say "Fill this form" to begin.');
      this._announce(msg, { openBubble: true, state: 'speaking' });
      return {
        status: 'form_inspected',
        totalCount: fields.length,
        fields: items,
        missingRequired,
        invalidFields,
        message: msg
      };
    }

    /**
     * Validate required fields and HTML5 constraints before any form submission or step advance.
     */
    validateFormFields(doc = this._getDoc()) {
      const fields = this.detectFormFields(doc);
      if (fields.length === 0) {
        const msg = 'No form fields to validate on this page.';
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { valid: true, missingRequired: [], invalidFields: [], message: msg };
      }

      const fi = getFormIndexApi();
      const missingRequired = [];
      const invalidFields = [];
      for (const f of fields) {
        const sensitive = Boolean(f.sensitive || this.isSensitiveField(f.element, f.label));
        const st = fi && typeof fi.computeFieldState === 'function' ? fi.computeFieldState(f) : { done: Boolean(f.element && f.element.value) };
        const req = Boolean(f.required || (f.element && (f.element.required || (f.element.getAttribute && f.element.getAttribute('aria-required') === 'true'))));
        if (req && !st.done) missingRequired.push(f.label);
        if (!sensitive && typeof this.checkValidationError === 'function') {
          const err = this.checkValidationError(f);
          if (err) invalidFields.push({ label: f.label, error: err });
        }
      }

      const valid = missingRequired.length === 0 && invalidFields.length === 0;
      const msg = valid
        ? `All ${fields.length} form checks look ready. Say "Submit" to review and confirm.`
        : `Form needs attention — ${[
            missingRequired.length ? `missing required: ${missingRequired.join(', ')}` : '',
            invalidFields.length ? `invalid: ${invalidFields.map((x) => `${x.label} (${x.error})`).join(', ')}` : ''
          ].filter(Boolean).join('; ')}.`;
      this._announce(msg, { openBubble: true, state: valid ? 'speaking' : 'error' });
      return { valid, missingRequired, invalidFields, message: msg };
    }

    _announce(msg, { openBubble = false, state = 'status' } = {}) {
      if (!this.widget) return;
      if (typeof this.widget.setAssistantReply === 'function') {
        this.widget.setAssistantReply(msg);
      }
      if (typeof window !== 'undefined' && window.SW_UI) {
        const confirmPending = this.widget.confirm && this.widget.confirm.isAwaiting();
        if (!confirmPending) {
          const f = this.isGuidedActive() ? this.guidedState.fields[this.guidedState.index] : null;
          const total = this.isGuidedActive() ? this.guidedState.fields.length : 0;
          const done = this.isGuidedActive() ? this._countCompletedFields(this.guidedState.fields) : 0;
          window.SW_UI.showCard({
            type: 'form',
            title: 'Form Assistant',
            progress: total ? `${done} of ${total} done` : '',
            fieldLabel: f ? f.label : '',
            text: msg,
            targetEl: this._lastHighlightedEl || (f && (f.clickTarget || f.element)) || null,
            reading: true,
            actions: f ? [{ id: 'skip', label: 'Skip' }, { id: 'stop', label: 'Stop' }] : [],
            onAction: (id) => {
              if (id === 'skip') this.handleGuidedInput('skip');
              else if (id === 'stop') this.stopGuidedFill('cancelled');
            }
          });
        }
      } else if (this.widget.pill) {
        if (state === 'idle' && typeof this.widget.pill.setIdle === 'function') this.widget.pill.setIdle(msg);
        else if (typeof this.widget.pill.setStatus === 'function') this.widget.pill.setStatus(msg);
        if (openBubble && typeof this.widget.pill.openBubble === 'function') this.widget.pill.openBubble();
      }
      if (this.widget.reader && typeof this.widget.reader.readText === 'function') {
        this.widget.reader.readText(msg);
      }
    }
  }

  return {
    SleepwalkerForms,
    transliterateDevanagariToLatin,
    parseSpokenNumbers,
    parseSpokenDate,
    parseSpokenEmail,
    sanitizeProfileData,
    SENSITIVE_RE
  };
});
