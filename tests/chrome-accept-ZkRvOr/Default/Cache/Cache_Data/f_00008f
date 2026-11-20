/**
 * Sleepwalker - upload.js
 * Phase 6: Accessible File Upload & Experimental Local Document Shelf
 *
 * Browser limits & safety rules (honest & privacy-first):
 * - Browsers do NOT allow picking local files by path or opening a native file dialog
 *   without a genuine user tap (user gesture). Sleepwalker highlights the target, shows
 *   a confirm card with a 48px "Choose File" button, validates accept/size, asks final Yes,
 *   then attaches via DataTransfer + change (and drop events for dropzones).
 * - NEVER reads arbitrary file contents and NEVER sends files or file names to any LLM or server.
 * - Undo cleanly clears the attached file input.
 * - Optional Document Shelf (window.showDirectoryPicker) is flagged experimental and degrades gracefully.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.SleepwalkerUpload = api.SleepwalkerUpload;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const SIZE_UNIT_MULT = {
    b: 1,
    byte: 1,
    bytes: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024
  };

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function parseSizeLimitFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/(?:max(?:imum)?(?:\s+size)?|up\s*to|under|limit|below|<=?)\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb|bytes?|b)\b/i)
      || text.match(/\b(\d+(?:\.\d+)?)\s*(kb|mb)\b/i);
    if (!match) return null;
    const val = parseFloat(match[1]);
    const unit = String(match[2] || '').toLowerCase();
    const mult = SIZE_UNIT_MULT[unit] || 1;
    return Number.isFinite(val) && val > 0 ? Math.round(val * mult) : null;
  }

  function parseMaxBytesAttr(el) {
    if (!el || typeof el.getAttribute !== 'function') return null;
    const attrBytes = el.getAttribute('data-max-size') || el.getAttribute('data-max-bytes');
    if (attrBytes && /^\d+$/.test(attrBytes.trim())) {
      return parseInt(attrBytes.trim(), 10);
    }
    const attrKb = el.getAttribute('data-max-kb');
    if (attrKb && /^\d+(?:\.\d+)?$/.test(attrKb.trim())) {
      return Math.round(parseFloat(attrKb.trim()) * 1024);
    }
    const attrMb = el.getAttribute('data-max-mb');
    if (attrMb && /^\d+(?:\.\d+)?$/.test(attrMb.trim())) {
      return Math.round(parseFloat(attrMb.trim()) * 1024 * 1024);
    }
    return null;
  }

  function getFileExtension(filename) {
    const name = String(filename || '').trim().toLowerCase();
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx) : '';
  }

  function isImageFile(file) {
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('image/')) return true;
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(getFileExtension(file.name));
  }

  function matchesAcceptRule(file, acceptStr) {
    const clean = String(acceptStr || '').trim();
    if (!clean || clean === '*/*') return true;

    const fileType = String((file && file.type) || '').toLowerCase();
    const fileExt = getFileExtension(file && file.name);
    const rules = clean.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
    if (rules.length === 0) return true;

    return rules.some((rule) => {
      if (rule === '*/*') return true;
      if (rule.startsWith('.')) {
        if (fileExt === rule) return true;
        if (rule === '.jpg' && (fileExt === '.jpeg' || fileType === 'image/jpeg')) return true;
        if (rule === '.jpeg' && (fileExt === '.jpg' || fileType === 'image/jpeg')) return true;
        return false;
      }
      if (rule.endsWith('/*')) {
        const prefix = rule.slice(0, -1); // e.g. "image/"
        if (fileType.startsWith(prefix)) return true;
        if (prefix === 'image/' && ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'].includes(fileExt)) return true;
        return false;
      }
      if (fileType === rule) return true;
      if (rule === 'application/pdf' && fileExt === '.pdf') return true;
      return false;
    });
  }

  class SleepwalkerUpload {
    constructor(widget, options = {}) {
      this.widget = widget || null;
      this.pendingCardState = null;
      this.uploadUndoStack = [];
      this.shelf = {
        directoryHandle: null,
        folderName: '',
        entries: [] // { name, fileHandle } held in memory ONLY, never sent to LLM
      };
      this.onCardChange = typeof options.onCardChange === 'function' ? options.onCardChange : null;
    }

    _getDoc() {
      return typeof document !== 'undefined' ? document : null;
    }

    _getWin() {
      return typeof window !== 'undefined' ? window : null;
    }

    _isInsideSleepwalker(el) {
      let cur = el;
      while (cur) {
        if (cur.id === 'sleepwalker-host') return true;
        cur = cur.parentElement;
      }
      return false;
    }

    _isVisiblyRendered(el) {
      if (!el || el.nodeType !== 1 || this._isInsideSleepwalker(el)) return false;
      if (el.disabled || el.hidden || (el.getAttribute && el.getAttribute('aria-hidden') === 'true')) return false;
      const win = this._getWin();
      if (win && typeof win.getComputedStyle === 'function') {
        const s = win.getComputedStyle(el);
        if (s && (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0')) return false;
      }
      return true;
    }

    _findAssociatedLabel(el, doc) {
      if (!el) return '';
      const attr = (n) => (typeof el.getAttribute === 'function' ? el.getAttribute(n) : '') || '';
      if (attr('aria-label').trim()) return attr('aria-label').trim();

      const id = attr('id') || el.id;
      if (id && doc && typeof doc.querySelectorAll === 'function') {
        const lbl = Array.from(doc.querySelectorAll('label[for]')).find((l) => l.getAttribute('for') === id);
        if (lbl) {
          const t = (lbl.innerText || lbl.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) return t;
        }
      }

      if (typeof el.closest === 'function') {
        const wrapLabel = el.closest('label');
        if (wrapLabel) {
          const t = (wrapLabel.innerText || wrapLabel.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) return t;
        }
        const dropZone = el.closest('[data-dropzone], .dropzone, .drop-zone, .upload-zone');
        if (dropZone && dropZone !== el) {
          const dzText = (dropZone.getAttribute && dropZone.getAttribute('aria-label'))
            || (dropZone.innerText || dropZone.textContent || '').replace(/\s+/g, ' ').trim();
          if (dzText) return dzText.slice(0, 90);
        }
      }

      const name = attr('name').replace(/[_-]+/g, ' ').trim();
      if (name) return name;
      return id ? id.replace(/[_-]+/g, ' ').trim() : '';
    }

    _collectHintContextText(el) {
      const chunks = [];
      if (!el) return '';
      const attr = (n) => (typeof el.getAttribute === 'function' ? el.getAttribute(n) : '') || '';
      chunks.push(attr('title'), attr('placeholder'), attr('aria-label'));
      const ownText = el.innerText || el.textContent || '';
      if (ownText) chunks.push(ownText);
      const parent = el.parentElement;
      const parentTag = parent && parent.tagName ? String(parent.tagName).toUpperCase() : '';
      if (parent && parentTag !== 'FORM' && parentTag !== 'BODY') {
        chunks.push(parent.innerText || parent.textContent || '');
      }
      return chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }

    /**
     * Detect visible file inputs (or custom styled dropzones wrapping file inputs).
     */
    detectUploadTargets(doc = this._getDoc()) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return [];

      const targets = [];
      const seenElements = new Set();

      // 1. All <input type="file"> on page
      const fileInputs = Array.from(doc.querySelectorAll('input[type="file"]'));
      for (const inp of fileInputs) {
        if (this._isInsideSleepwalker(inp) || inp.disabled) continue;

        const dropContainer = typeof inp.closest === 'function'
          ? inp.closest('[data-dropzone], .dropzone, .drop-zone, .upload-zone')
          : null;
        const wrapLabel = typeof inp.closest === 'function' ? inp.closest('label') : null;
        const visualEl = dropContainer || wrapLabel || inp;

        // Include if input itself OR its visual dropzone/label wrapper is visible
        const hasVisibleAnchor = this._isVisiblyRendered(inp) || this._isVisiblyRendered(visualEl);
        if (!hasVisibleAnchor) continue;

        seenElements.add(inp);
        if (dropContainer) seenElements.add(dropContainer);

        const label = this._findAssociatedLabel(inp, doc) || `Upload Field ${targets.length + 1}`;
        const hintText = this._collectHintContextText(visualEl);
        const accept = ((typeof inp.getAttribute === 'function' ? inp.getAttribute('accept') : '') || '').trim()
          || (dropContainer && dropContainer.getAttribute && dropContainer.getAttribute('data-accept')) || '';
        const maxBytes = parseMaxBytesAttr(inp)
          || parseMaxBytesAttr(dropContainer)
          || parseSizeLimitFromText(`${label} ${hintText}`);

        targets.push({
          id: `file_${targets.length + 1}`,
          kind: dropContainer ? 'dropzone' : 'file_input',
          label: label.slice(0, 90),
          name: (inp.getAttribute && inp.getAttribute('name')) || inp.id || '',
          accept,
          maxBytes,
          multiple: Boolean(inp.multiple),
          inputElement: inp,
          dropElement: dropContainer || null,
          visualElement: visualEl
        });
      }

      // 2. Standalone dropzones without nested <input type="file">
      const dropZones = Array.from(doc.querySelectorAll('[data-dropzone], .dropzone, .drop-zone, .upload-zone, [ondrop]'));
      for (const dz of dropZones) {
        if (seenElements.has(dz) || !this._isVisiblyRendered(dz)) continue;
        seenElements.add(dz);

        const label = ((dz.getAttribute && dz.getAttribute('aria-label'))
          || (dz.innerText || dz.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 90)
          || `Dropzone ${targets.length + 1}`;
        const accept = (dz.getAttribute && dz.getAttribute('data-accept')) || '';
        const maxBytes = parseMaxBytesAttr(dz) || parseSizeLimitFromText(label);

        targets.push({
          id: `dz_${targets.length + 1}`,
          kind: 'dropzone',
          label,
          name: dz.id || '',
          accept,
          maxBytes,
          multiple: Boolean(dz.getAttribute && dz.getAttribute('data-multiple') === 'true'),
          inputElement: null,
          dropElement: dz,
          visualElement: dz
        });
      }

      return targets;
    }

    /**
     * Fuzzy-match spoken upload target ("photo", "marksheet", "income certificate") against label + accept rules.
     */
    findMatchingUploadTargets(query = '') {
      const targets = this.detectUploadTargets();
      if (targets.length === 0) return [];

      const cleanQuery = String(query || '')
        .toLowerCase()
        .replace(/\b(?:upload|attach|select|choose|my|the|a|an|file|document|doc|karo|bhejo|lagao|अपलोड|करो)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!cleanQuery || cleanQuery === 'file') {
        return targets.map((t, idx) => ({ target: t, label: t.label, score: 65 - idx }));
      }

      const qTokens = cleanQuery.split(/\s+/).filter(Boolean);
      const wantsImage = qTokens.some((t) => ['photo', 'picture', 'image', 'selfie', 'passport', 'pic', 'तस्वीर', 'फोटो'].includes(t));
      const wantsPdf = qTokens.some((t) => ['pdf', 'certificate', 'marksheet', 'income', 'transcript', 'resume', 'cv', 'receipt', 'प्रमाणपत्र', 'मार्कशीट'].includes(t));

      const scored = targets.map((t) => {
        const cleanLabel = `${t.label} ${t.name}`.toLowerCase();
        const acceptLower = (t.accept || '').toLowerCase();
        let score = 0;

        if (cleanLabel === cleanQuery) score = 100;
        else if (cleanLabel.includes(cleanQuery)) score = 88;
        else {
          let hits = 0;
          for (const qt of qTokens) {
            if (cleanLabel.includes(qt)) hits += 1;
            else if (qt === 'photo' && /photo|image|pic|avatar|portrait/.test(cleanLabel)) hits += 0.9;
          }
          if (hits > 0) score = 48 + (hits / qTokens.length) * 36;
        }

        if (wantsImage && /image|\.(?:jpe?g|png|webp)/.test(acceptLower)) score += 18;
        if (wantsPdf && (/\.pdf|application\/pdf/.test(acceptLower))) score += 12;

        return { target: t, label: t.label, score: Math.round(score * 10) / 10 };
      });

      const strong = scored.filter((s) => s.score >= 45).sort((a, b) => b.score - a.score);
      if (strong.length > 0) return strong;
      return scored.sort((a, b) => b.score - a.score);
    }

    /**
     * Validate a user-chosen File against target accept and size rules WITHOUT reading contents.
     */
    validateSelectedFile(file, target) {
      if (!file) return { valid: false, reason: 'No file selected.' };
      const acceptOk = matchesAcceptRule(file, target && target.accept);
      if (!acceptOk) {
        return {
          valid: false,
          acceptOk: false,
          sizeOk: true,
          canCompress: false,
          reason: `"${file.name}" does not match accepted formats (${target.accept}).`
        };
      }

      const maxBytes = target && target.maxBytes;
      const sizeOk = !maxBytes || file.size <= maxBytes;
      if (!sizeOk) {
        const canCompress = isImageFile(file);
        return {
          valid: false,
          acceptOk: true,
          sizeOk: false,
          canCompress,
          reason: `"${file.name}" (${formatBytes(file.size)}) exceeds the ${formatBytes(maxBytes)} limit.`
        };
      }

      return { valid: true, acceptOk: true, sizeOk: true, canCompress: false, reason: '' };
    }

    /**
     * Optional client-side photo compression using canvas (in-memory only, never uploaded).
     */
    async compressImageToTargetLimit(file, maxBytes) {
      if (!isImageFile(file)) return null;
      const doc = this._getDoc();
      const win = this._getWin();
      if (!doc || !win || typeof win.URL === 'undefined' || typeof win.URL.createObjectURL !== 'function' || typeof Image === 'undefined') {
        return null;
      }

      const objectUrl = win.URL.createObjectURL(file);
      try {
        const img = await new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error('Image load failed during compression.'));
          el.src = objectUrl;
        });

        const canvas = doc.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        let scale = 1.0;
        let quality = 0.85;
        let bestBlob = null;

        for (let attempt = 0; attempt < 5; attempt++) {
          const w = Math.max(160, Math.round(img.width * scale));
          const h = Math.max(160, Math.round(img.height * scale));
          canvas.width = w;
          canvas.height = h;
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);

          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
          if (blob) {
            bestBlob = blob;
            if (!maxBytes || blob.size <= maxBytes) break;
          }
          scale *= 0.75;
          quality = Math.max(0.45, quality - 0.12);
        }

        if (!bestBlob) return null;
        const baseName = String(file.name || 'photo').replace(/\.[^.]+$/, '');
        return new File([bestBlob], `${baseName}-compressed.jpg`, {
          type: 'image/jpeg',
          lastModified: Date.now()
        });
      } finally {
        win.URL.revokeObjectURL(objectUrl);
      }
    }

    /**
     * Step 1: Voice/button entry -> locate target & show Confirm + "Choose File" gesture card.
     */
    requestUpload(query = '') {
      const ranked = this.findMatchingUploadTargets(query);
      if (ranked.length === 0) {
        const msg = 'No file upload fields or dropzones found on this page.';
        this._announce(msg, { openBubble: true, state: 'idle' });
        return { ok: false, reason: 'no_targets' };
      }

      const ambiguous = ranked.length > 1 && (ranked[0].score - ranked[1].score) < 15;
      const confirmMgr = this.widget && this.widget.confirm;
      if (ambiguous && confirmMgr) {
        const options = ranked.slice(0, 5).map((r) => ({ label: r.target.label, target: r.target }));
        const listStr = options.map((o, i) => `${i + 1}. ${o.label}`).join('  ');
        confirmMgr.request({
          id: `upload_pick_${Date.now()}`,
          risk: 'high',
          ambiguous: true,
          title: 'Choose Upload Field',
          message: `Multiple upload fields found. Say a number (1-${options.length}): ${listStr}`,
          options,
          onConfirm: ({ selectedOption } = {}) => {
            const chosenTarget = (selectedOption && selectedOption.target) || ranked[0].target;
            this._openChooseFileCard(chosenTarget);
          },
          onCancel: () => {
            this.clearFileCard();
            this._announce('File upload cancelled.', { state: 'idle' });
          }
        });
        return { ok: true, awaitingDisambiguation: true };
      }

      return this._openChooseFileCard(ranked[0].target, query);
    }

    _openChooseFileCard(target, spokenQuery = '') {
      // Guard against stale async shelf replies after card closes or switches
      const cardToken = `${Date.now()}_${Math.random()}`;
      if (target.visualElement && typeof target.visualElement.scrollIntoView === 'function') {
        target.visualElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      this._highlightTarget(target.visualElement || target.inputElement);

      const shelfMatch = this.matchShelfFile(spokenQuery || target.label, target.accept);

      this.pendingCardState = {
        stage: 'choose',
        token: cardToken,
        target,
        selectedFile: null,
        error: '',
        canCompress: false,
        shelfMatch,
        shelfNote: '',
        shelfNeedsReauth: false,
        shelfNotConnected: false
      };
      this._emitCardChange();

      const rulesNote = [
        target.accept ? `Accept: ${target.accept}` : '',
        target.maxBytes ? `Max: ${formatBytes(target.maxBytes)}` : ''
      ].filter(Boolean).join(' • ');

      const promptMsg = `Upload to "${target.label}"?${rulesNote ? ` (${rulesNote})` : ''} Tap "Choose File" to open your file picker.`;
      this._announce(promptMsg, { openBubble: true });

      // Non-blocking check for Route A Extension Document Shelf (IndexedDB handle)
      this._probeExtensionShelfMatch(target, spokenQuery || target.label, cardToken);
      return { ok: true, awaitingPickerTap: true, target };
    }

    _highlightTarget(el) {
      if (!el || !el.style) return;
      const prevOutline = el.style.outline;
      const prevOffset = el.style.outlineOffset;
      const prevShadow = el.style.boxShadow;
      el.style.outline = '3px solid #22D3EE';
      el.style.outlineOffset = '2px';
      el.style.boxShadow = '0 0 14px rgba(34, 211, 238, 0.55)';
      setTimeout(() => {
        if (el.style) {
          el.style.outline = prevOutline;
          el.style.outlineOffset = prevOffset;
          el.style.boxShadow = prevShadow;
        }
      }, 1050);
    }

    openShelfSetup() {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_OPEN_SHELF_SETUP' });
        return true;
      }
      return false;
    }

    getExtensionShelfStatus() {
      return new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve({ status: 'unavailable', connected: false });
          return;
        }
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_SHELF_STATUS' }, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve({ status: 'unavailable', connected: false });
            return;
          }
          resolve(res);
        });
      });
    }

    _probeExtensionShelfMatch(target, query, cardToken) {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      try {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_SHELF_MATCH', query }, (res) => {
          if (chrome.runtime && chrome.runtime.lastError) return;
          if (!res || !this.pendingCardState || this.pendingCardState.token !== cardToken || this.pendingCardState.stage !== 'choose') {
            return;
          }

          if (res.status === 'needs_reauth') {
            this.pendingCardState.shelfNeedsReauth = true;
            this.pendingCardState.shelfFolderName = res.folderName || 'Document Shelf';
            this.pendingCardState.shelfNote = `Document Shelf "${res.folderName || 'folder'}" needs permission re-tap in Shelf Setup, or use Choose File below.`;
            this._emitCardChange();
            this._announce(this.pendingCardState.shelfNote, { openBubble: true });
            return;
          }

          if (res.status === 'not_connected') {
            this.pendingCardState.shelfNotConnected = true;
            this.pendingCardState.shelfNote = 'Connect Document Shelf once for hands-free voice uploads, or tap Choose File below.';
            this._emitCardChange();
            return;
          }

          if (res.status === 'ok' && Array.isArray(res.matches)) {
            const validMatches = res.matches.filter((m) => !target.accept || matchesAcceptRule({ name: m.name, type: '' }, target.accept));
            if (validMatches.length === 0) {
              this.pendingCardState.shelfNote = 'No matching file in Document Shelf. Tap Choose File below.';
              this._emitCardChange();
              return;
            }

            const confirmMgr = this.widget && this.widget.confirm;
            const isAmbiguous = validMatches.length > 1 && ((validMatches[0].score - validMatches[1].score) < 1.5);

            if (isAmbiguous && confirmMgr) {
              const opts = validMatches.slice(0, 5).map((m) => ({ label: m.name, shelfEntry: m }));
              confirmMgr.request({
                id: `shelf_pick_${Date.now()}`,
                risk: 'high',
                ambiguous: true,
                title: `Choose File from Shelf (${target.label})`,
                message: `Multiple shelf files match for "${target.label}": ${opts.map((o, i) => `${i + 1}. ${o.label}`).join(', ')}. Which number?`,
                options: opts,
                onConfirm: ({ selectedOption } = {}) => {
                  const chosen = (selectedOption && selectedOption.shelfEntry) || validMatches[0];
                  this.pickFromExtensionShelf(chosen, target, { skipFinalConfirmIfValid: true });
                },
                onCancel: () => {
                  if (this.pendingCardState) {
                    this.pendingCardState.shelfNote = 'Shelf selection cancelled — you can still tap Choose File.';
                    this._emitCardChange();
                  }
                }
              });
              return;
            }

            const top = validMatches[0];
            this.pendingCardState.shelfMatch = top;
            this._emitCardChange();
            if (confirmMgr) {
              confirmMgr.request({
                id: `shelf_attach_${Date.now()}`,
                risk: 'high',
                title: 'Use Document Shelf File?',
                message: `Found "${top.name}" in Document Shelf. Attach it to "${target.label}"?`,
                summary: [
                  `Shelf file: ${top.name}`,
                  `Field: ${target.label}`,
                  'Privacy: Read locally on confirmation only; never sent to any AI.'
                ],
                onConfirm: () => {
                  this.pickFromExtensionShelf(top, target, { skipFinalConfirmIfValid: true });
                },
                onCancel: () => {
                  if (this.pendingCardState) {
                    this.pendingCardState.shelfNote = 'Skipped shelf file — tap Choose File anytime.';
                    this._emitCardChange();
                  }
                }
              });
            }
          }
        });
      } catch (_e) {}
    }

    async pickFromExtensionShelf(shelfItem, target, { skipFinalConfirmIfValid = false } = {}) {
      if (!shelfItem || !target) return { ok: false };
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        return { ok: false, error: 'Extension messaging unavailable.' };
      }
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'SLEEPWALKER_SHELF_READ', name: shelfItem.name, path: shelfItem.path },
          (r) => {
            if (chrome.runtime && chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(r || { ok: false, error: 'Empty response from Document Shelf.' });
            }
          }
        );
      });

      if (!res || !res.ok || !Array.isArray(res.bytes)) {
        const errMsg = (res && res.error) || `Could not read "${shelfItem.name}" from Document Shelf. Use Choose File instead.`;
        if (this.pendingCardState) {
          this.pendingCardState.shelfNeedsReauth = res && res.reason === 'needs_reauth';
          this.pendingCardState.shelfNote = errMsg;
          this._emitCardChange();
        }
        this._announce(errMsg, { openBubble: true, state: 'idle' });
        return { ok: false, error: errMsg };
      }

      const FileCtor = typeof File === 'function'
        ? File
        : function MockFile(parts, n, opts) { this.name = n; this.type = (opts && opts.type) || ''; this.size = res.size || 0; this.lastModified = (opts && opts.lastModified) || Date.now(); };
      const bytesArr = new Uint8Array(res.bytes);
      const file = new FileCtor([bytesArr], res.name, { type: res.type || '', lastModified: res.lastModified || Date.now() });

      const validation = this.validateSelectedFile(file, target);
      if (validation.valid && skipFinalConfirmIfValid) {
        return this.attachFileToTarget(file, target);
      }
      return this.handleSelectedFile(file, target);
    }

    /**
     * Step 2: Handle a File selected by user gesture (native picker or experimental shelf).
     */
    handleSelectedFile(file, target = (this.pendingCardState && this.pendingCardState.target)) {
      if (!file || !target) return { ok: false, reason: 'missing_target_or_file' };

      const validation = this.validateSelectedFile(file, target);
      if (!validation.valid) {
        this.pendingCardState = {
          stage: 'validation_error',
          target,
          selectedFile: file,
          error: validation.reason,
          canCompress: validation.canCompress,
          shelfMatch: null
        };
        this._emitCardChange();
        this._announce(validation.reason + (validation.canCompress ? ' Tap "Compress Photo" to shrink it client-side.' : ' Choose another file.'), { openBubble: true });
        return { ok: false, validation };
      }

      // Show selected filename for final explicit Yes confirm before attaching!
      this.pendingCardState = {
        stage: 'confirm_attach',
        target,
        selectedFile: file,
        error: '',
        canCompress: false,
        shelfMatch: null
      };
      this._emitCardChange();

      const confirmMgr = this.widget && this.widget.confirm;
      if (confirmMgr) {
        confirmMgr.request({
          id: `upload_attach_${Date.now()}`,
          risk: 'high',
          title: 'Confirm File Upload',
          message: `Attach "${file.name}" (${formatBytes(file.size)}) to "${target.label}"?`,
          summary: [
            `File: ${file.name} (${formatBytes(file.size)})`,
            `Field: ${target.label}`,
            'Privacy: File contents and filenames are never read or sent to any AI.'
          ],
          onConfirm: () => {
            this.attachFileToTarget(file, target);
          },
          onCancel: () => {
            this.clearFileCard();
            this._announce('File attachment cancelled.', { state: 'idle' });
          }
        });
      }
      return { ok: true, awaitingFinalConfirm: true, fileName: file.name };
    }

    /**
     * Step 3: Attach File cleanly using DataTransfer + input/change + optional drop events.
     */
    attachFileToTarget(file, target) {
      if (!file || !target) return { ok: false, error: 'Missing file or upload target.' };

      const DT = typeof DataTransfer === 'function'
        ? DataTransfer
        : function MockDataTransfer() {
            const itemsList = [];
            this.items = { add: (f) => itemsList.push(f) };
            Object.defineProperty(this, 'files', { get: () => itemsList });
          };

      const dt = new DT();
      dt.items.add(file);

      // Snapshot previous files for Undo
      const prevFiles = (target.inputElement && target.inputElement.files)
        ? Array.from(target.inputElement.files)
        : [];
      this.uploadUndoStack.push({ target, previousFiles: prevFiles });
      if (this.uploadUndoStack.length > 10) this.uploadUndoStack.shift();

      const Ev = typeof Event === 'function'
        ? Event
        : function MockEvent(type, opts) { this.type = type; this.bubbles = Boolean(opts && opts.bubbles); };

      if (target.inputElement) {
        try {
          target.inputElement.files = dt.files;
        } catch (_e) {}
        if (typeof target.inputElement.dispatchEvent === 'function') {
          target.inputElement.dispatchEvent(new Ev('input', { bubbles: true }));
          target.inputElement.dispatchEvent(new Ev('change', { bubbles: true }));
        }
      }

      if (target.dropElement && typeof target.dropElement.dispatchEvent === 'function') {
        const makeDragEvent = (type) => {
          if (typeof DragEvent === 'function') {
            try {
              return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
            } catch (_e) {
              // Fallback for stricter browsers where dataTransfer init is read-only
            }
          }
          const ev = new Ev(type, { bubbles: true });
          ev.cancelable = true;
          try {
            Object.defineProperty(ev, 'dataTransfer', { value: dt, enumerable: true });
          } catch (_e) {
            ev.dataTransfer = dt;
          }
          return ev;
        };

        target.dropElement.dispatchEvent(makeDragEvent('dragenter'));
        target.dropElement.dispatchEvent(makeDragEvent('dragover'));
        target.dropElement.dispatchEvent(makeDragEvent('drop'));
      }

      const attachedVerified = target.inputElement
        ? Boolean(target.inputElement.files && target.inputElement.files[0] && target.inputElement.files[0].name === file.name)
        : true;

      if (!attachedVerified) {
        this.pendingCardState = {
          stage: 'validation_error',
          target,
          selectedFile: file,
          error: `Tried attaching "${file.name}", but the browser or page blocked programmatic FileList assignment. Tap Choose File instead.`,
          canCompress: false,
          shelfMatch: null
        };
        this._emitCardChange();
        this._announce(this.pendingCardState.error, { openBubble: true, state: 'idle' });
        return { ok: false, verified: false, error: this.pendingCardState.error };
      }

      this.pendingCardState = {
        stage: 'attached',
        target,
        selectedFile: file,
        error: '',
        canCompress: false,
        shelfMatch: null
      };
      this._emitCardChange();

      const okMsg = `Attached "${file.name}" (${formatBytes(file.size)}) to "${target.label}". Say "Undo" to remove it.`;
      this._announce(okMsg, { openBubble: true, state: 'idle' });
      return { ok: true, verified: true, fileName: file.name, targetLabel: target.label };
    }

    /**
     * Undo clears attached file input safely.
     */
    undoLastUpload() {
      if (this.uploadUndoStack.length === 0) {
        return { ok: false, reason: 'empty' };
      }

      const { target, previousFiles } = this.uploadUndoStack.pop();
      const DT = typeof DataTransfer === 'function'
        ? DataTransfer
        : function MockDataTransfer() {
            const itemsList = [];
            this.items = { add: (f) => itemsList.push(f) };
            Object.defineProperty(this, 'files', { get: () => itemsList });
          };
      const dt = new DT();
      for (const f of previousFiles || []) {
        dt.items.add(f);
      }

      const Ev = typeof Event === 'function'
        ? Event
        : function MockEvent(type, opts) { this.type = type; this.bubbles = Boolean(opts && opts.bubbles); };

      if (target.inputElement) {
        target.inputElement.files = dt.files;
        if (dt.files.length === 0) {
          try { target.inputElement.value = ''; } catch (_e) {}
        }
        if (typeof target.inputElement.dispatchEvent === 'function') {
          target.inputElement.dispatchEvent(new Ev('change', { bubbles: true }));
        }
      }

      this.clearFileCard();
      const msg = `Cleared attachment on "${target.label}".`;
      this._announce(msg, { openBubble: true, state: 'idle' });
      return { ok: true, clearedTarget: target.label };
    }

    clearFileCard() {
      this.pendingCardState = null;
      this._emitCardChange();
    }

    _emitCardChange() {
      if (this.onCardChange) {
        this.onCardChange(this.pendingCardState);
      }
      if (this.widget && typeof this.widget.handleUploadCardChange === 'function') {
        this.widget.handleUploadCardChange(this.pendingCardState);
      }
    }

    /**
     * Experimental Stretch: Session-only Document Shelf (window.showDirectoryPicker).
     * Holds filenames and handles strictly in memory; never reads contents unprompted or sends to LLM.
     */
    isShelfSupported() {
      const win = this._getWin();
      return Boolean(win && typeof win.showDirectoryPicker === 'function');
    }

    async connectShelfFolder() {
      const win = this._getWin();
      if (!win || typeof win.showDirectoryPicker !== 'function') {
        return { ok: false, reason: 'unsupported', message: 'Experimental Document Shelf is not supported on this page or browser. Use Choose File instead.' };
      }

      try {
        const dirHandle = await win.showDirectoryPicker({ mode: 'read' });
        const entries = [];
        for await (const entry of dirHandle.values()) {
          if (entry && entry.kind === 'file') {
            entries.push({ name: entry.name, fileHandle: entry });
            if (entries.length >= 100) break;
          }
        }
        this.shelf = {
          directoryHandle: dirHandle,
          folderName: dirHandle.name || 'Selected Folder',
          entries
        };
        return { ok: true, folderName: this.shelf.folderName, count: entries.length };
      } catch (err) {
        return { ok: false, reason: 'cancelled_or_blocked', message: err.message || 'Folder selection cancelled or blocked.' };
      }
    }

    disconnectShelfFolder() {
      this.shelf = { directoryHandle: null, folderName: '', entries: [] };
    }

    matchShelfFile(query = '', acceptStr = '') {
      if (!this.shelf || !Array.isArray(this.shelf.entries) || this.shelf.entries.length === 0) return null;
      const tokens = String(query || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3);

      let best = null;
      let bestScore = 0;
      for (const item of this.shelf.entries) {
        const lower = item.name.toLowerCase();
        if (acceptStr && !matchesAcceptRule({ name: item.name, type: '' }, acceptStr)) continue;
        let score = 0;
        for (const tok of tokens) {
          if (lower.includes(tok)) score += 1;
        }
        if (score > bestScore) {
          bestScore = score;
          best = item;
        }
      }
      return bestScore > 0 ? best : null;
    }

    async pickFromShelfEntry(entry, target) {
      if (!entry || !entry.fileHandle) return { ok: false };
      try {
        const file = await entry.fileHandle.getFile();
        return this.handleSelectedFile(file, target);
      } catch (err) {
        this._announce(`Could not access "${entry.name}" from Document Shelf: ${err.message}`, { openBubble: true });
        return { ok: false, error: err.message };
      }
    }

    _announce(msg, { openBubble = false, state = 'status' } = {}) {
      if (!this.widget) return;
      if (typeof this.widget.setAssistantReply === 'function') {
        this.widget.setAssistantReply(msg);
      }
      if (typeof window !== 'undefined' && window.SW_UI) {
        if (!this.pendingCardState && (!this.widget.confirm || !this.widget.confirm.isAwaiting())) {
          window.SW_UI.showCard({
            type: state === 'error' ? 'error' : 'answer',
            title: 'File Upload',
            text: msg,
            reading: true
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
    SleepwalkerUpload,
    parseSizeLimitFromText,
    matchesAcceptRule,
    formatBytes,
    isImageFile
  };
});
