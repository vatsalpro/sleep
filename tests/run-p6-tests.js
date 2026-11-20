/**
 * Phase 6 Automated Test Suite (File Upload: Matching, Validation, Honest Picker + Confirm, Dropzones, Compression, Undo, Privacy & Experimental Shelf)
 * Run with: node tests/run-p6-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function loadModule(relPath) {
  const full = path.join(ROOT, relPath);
  delete require.cache[require.resolve(full)];
  return require(full);
}

let passedSuites = 0;
let failedSuites = 0;

async function runSuite(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passedSuites += 1;
  } catch (err) {
    console.error(`FAIL  ${name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
    failedSuites += 1;
  }
}

function createUploadMockDom(options = {}) {
  const eventsLog = [];
  const fileReadCalls = [];
  const storageLocal = {};

  class MockFile {
    constructor(parts, name, opts = {}) {
      this._parts = Array.isArray(parts) ? parts : [parts];
      this.name = String(name || 'file.bin');
      this.type = String(opts.type || '');
      this.lastModified = opts.lastModified || Date.now();
      if (typeof opts.size === 'number') {
        this.size = opts.size;
      } else {
        this.size = this._parts.reduce((acc, p) => {
          if (typeof p === 'string') return acc + Buffer.byteLength(p);
          if (p && typeof p.byteLength === 'number') return acc + p.byteLength;
          return acc;
        }, 0);
      }
    }
    text() {
      fileReadCalls.push({ method: 'text', name: this.name });
      return Promise.resolve('');
    }
    arrayBuffer() {
      fileReadCalls.push({ method: 'arrayBuffer', name: this.name });
      return Promise.resolve(new ArrayBuffer(0));
    }
  }

  class MockDataTransfer {
    constructor() {
      const list = [];
      this._list = list;
      this.items = {
        add: (f) => {
          list.push(f);
          syncIndices();
        }
      };
      const filesObj = {
        get length() { return list.length; },
        item: (i) => list[i] || null,
        [Symbol.iterator]: () => list[Symbol.iterator]()
      };
      function syncIndices() {
        for (let i = 0; i < list.length; i += 1) {
          filesObj[i] = list[i];
        }
      }
      this.files = filesObj;
    }
  }

  class MockEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.dataTransfer = init.dataTransfer || null;
      this.defaultPrevented = false;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
  }

  class MockElement {
    constructor(tag, attrs = {}, children = []) {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.attributes = { ...attrs };
      this.id = attrs.id || '';
      this.name = attrs.name || '';
      this.type = attrs.type || '';
      this.accept = attrs.accept || '';
      this.multiple = Boolean(attrs.multiple);
      this.value = attrs.value || '';
      this.disabled = false;
      this.hidden = Boolean(attrs.hidden);
      this._text = attrs.text || '';
      this._style = { ...(attrs.style || {}) };
      this._rect = attrs.rect || { top: 20, left: 20, width: 220, height: 48 };
      this._files = { length: 0, item: () => null };
      this.children = [];
      this.childNodes = [];
      this.parentElement = null;
      this._listeners = {};
      children.forEach((c) => this.appendChild(c));
    }
    get files() {
      return this._files;
    }
    set files(val) {
      this._files = val || { length: 0, item: () => null };
      if (this._files.length > 0 && this._files[0]) {
        this.value = `C:\\fakepath\\${this._files[0].name}`;
      } else {
        this.value = '';
      }
    }
    get className() {
      return String(this.attributes.class || '');
    }
    set className(v) {
      this.attributes.class = String(v);
    }
    getAttribute(k) {
      if (k === 'id' && this.id) return this.id;
      if (k === 'name' && this.name) return this.name;
      if (k === 'type' && this.type) return this.type;
      if (k === 'accept' && this.accept) return this.accept;
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'accept') this.accept = String(v);
      if (k === 'type') this.type = String(v);
    }
    appendChild(child) {
      child.parentElement = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    }
    addEventListener(type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    }
    matchesSingle(rawSel) {
      const sel = rawSel.trim();
      if (!sel) return false;
      if (sel === '*') return true;
      // Extract parts: tag, #id, .class, [attr], [attr="val"]
      let rest = sel;
      const attrMatches = [];
      rest = rest.replace(/\[([^\]=]+)(?:=["']?([^"'\]]*)["']?)?\]/g, (_m, k, v) => {
        attrMatches.push({ key: k.trim(), val: v });
        return '';
      });
      const classMatches = [];
      rest = rest.replace(/\.([a-zA-Z0-9_-]+)/g, (_m, c) => {
        classMatches.push(c);
        return '';
      });
      let idMatch = null;
      rest = rest.replace(/#([a-zA-Z0-9_-]+)/g, (_m, id) => {
        idMatch = id;
        return '';
      });
      const tagMatch = rest.trim().toLowerCase();

      if (tagMatch && this.tagName.toLowerCase() !== tagMatch) return false;
      if (idMatch && this.id !== idMatch) return false;
      for (const cls of classMatches) {
        const list = this.className.split(/\s+/).filter(Boolean);
        if (!list.includes(cls)) return false;
      }
      for (const am of attrMatches) {
        const got = this.getAttribute(am.key);
        if (got === null) return false;
        if (am.val !== undefined && String(got).toLowerCase() !== String(am.val).toLowerCase()) {
          return false;
        }
      }
      return true;
    }
    matches(selectorList) {
      return String(selectorList)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .some((s) => this.matchesSingle(s));
    }
    closest(selectorList) {
      let cur = this;
      while (cur) {
        if (cur.matches && cur.matches(selectorList)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      const results = [];
      const walk = (n) => {
        for (const ch of n.children) {
          if (ch.matches(sel)) results.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return results;
    }
    get textContent() {
      return this._text || this.childNodes.map((c) => c.textContent).join(' ');
    }
    get innerText() {
      return this.textContent;
    }
    getBoundingClientRect() {
      return this._rect;
    }
    scrollIntoView() {}
    focus() {}
    dispatchEvent(ev) {
      const filesCount = this._files ? this._files.length : 0;
      const firstFile = filesCount > 0 && this._files[0] ? this._files[0].name : null;
      const dtFile = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length > 0
        ? ev.dataTransfer.files[0].name
        : null;
      eventsLog.push({
        targetId: this.id || this.name || this.className || this.tagName,
        type: ev.type,
        bubbles: Boolean(ev.bubbles),
        filesCount,
        firstFile,
        dtFile
      });
      const handlers = this._listeners[ev.type] || [];
      for (const fn of handlers) fn.call(this, ev);
      return true;
    }
  }

  // Build test portal form with file inputs & dropzones + widget host
  const form = new MockElement('form', { id: 'scholarship-form' });

  // 1. Passport Photo (<label for> + size hint)
  const lblPhoto = new MockElement('label', { for: 'up-photo', text: 'Passport Photo (JPG/PNG, Max 500 KB)' });
  const inpPhoto = new MockElement('input', {
    id: 'up-photo',
    name: 'photo',
    type: 'file',
    accept: 'image/jpeg,image/png',
    'data-max-kb': '500'
  });

  // 2. Marksheet (<label> wrapping input)
  const inpMarksheet = new MockElement('input', {
    id: 'up-marksheet',
    name: 'marksheet',
    type: 'file',
    accept: '.pdf,.jpg,.jpeg'
  });
  const lblMarksheet = new MockElement('label', { text: '10th / 12th Marksheet (Max 2 MB)' }, [inpMarksheet]);

  // 3. Income Certificate dropzone with visually-hidden <input type="file">
  const inpIncome = new MockElement('input', {
    id: 'up-income',
    name: 'income_cert',
    type: 'file',
    accept: 'application/pdf,.pdf,image/*',
    rect: { top: 20, left: 20, width: 1, height: 1 },
    style: { display: 'block', visibility: 'visible', opacity: '0' }
  });
  const dzIncomeText = new MockElement('p', { text: 'Drop Income Certificate here (PDF or Image, Max 2 MB)' });
  const dzIncome = new MockElement('div', {
    id: 'dz-income',
    class: 'dropzone upload-box',
    'data-dropzone': 'true',
    'aria-label': 'Income Certificate'
  }, [dzIncomeText, inpIncome]);

  // 4. Ambiguous second certificate for disambiguation tests (only enabled when option set)
  const lblCaste = new MockElement('label', { for: 'up-caste', text: 'Caste Certificate (PDF, Max 2 MB)' });
  const inpCaste = new MockElement('input', {
    id: 'up-caste',
    name: 'caste_cert',
    type: 'file',
    accept: '.pdf'
  });

  // 5. Standalone dropzone without inner input (for drop-only testing)
  const dzExtra = new MockElement('div', {
    id: 'dz-extra',
    class: 'dropzone',
    'data-dropzone': 'true',
    'aria-label': 'Residence Proof Dropzone',
    text: 'Drag Residence Proof PDF here (Max 1 MB)'
  });

  // 6. Sleepwalker's own Shadow host (MUST be ignored!)
  const swInternalInput = new MockElement('input', {
    id: 'sw-hidden-file-picker',
    type: 'file',
    accept: '*/*'
  });
  const swHost = new MockElement('div', { id: 'sleepwalker-host' }, [swInternalInput]);

  form.appendChild(lblPhoto);
  form.appendChild(inpPhoto);
  form.appendChild(lblMarksheet);
  form.appendChild(dzIncome);
  if (options.includeAmbiguousCertificate) {
    form.appendChild(lblCaste);
    form.appendChild(inpCaste);
  }
  if (options.includeStandaloneDropzone) {
    form.appendChild(dzExtra);
  }

  const body = new MockElement('body', {}, [form, swHost]);
  const doc = {
    title: 'Scholarship Upload Portal',
    body,
    activeElement: null,
    getElementById(id) {
      return body.querySelectorAll('*').find((el) => el.id === id) || null;
    },
    querySelectorAll(sel) {
      return body.querySelectorAll(sel);
    },
    querySelector(sel) {
      return body.querySelector(sel);
    },
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas' && options.mockCanvas) {
        return options.mockCanvas();
      }
      return new MockElement(tag);
    }
  };

  class SpyFileReader {
    readAsArrayBuffer() { fileReadCalls.push({ method: 'FileReader.readAsArrayBuffer' }); }
    readAsText() { fileReadCalls.push({ method: 'FileReader.readAsText' }); }
    readAsDataURL() { fileReadCalls.push({ method: 'FileReader.readAsDataURL' }); }
    readAsBinaryString() { fileReadCalls.push({ method: 'FileReader.readAsBinaryString' }); }
  }

  global.document = doc;
  global.File = MockFile;
  global.FileReader = SpyFileReader;
  global.DataTransfer = MockDataTransfer;
  global.Event = MockEvent;
  global.DragEvent = MockEvent;
  global.HTMLElement = MockElement;
  global.location = { href: 'https://portal.example.gov.in/scholarship/upload', origin: 'https://portal.example.gov.in' };
  global.window = {
    location: global.location,
    getComputedStyle: (el) => ({
      display: (el && el._style && el._style.display) || 'block',
      visibility: (el && el._style && el._style.visibility) || 'visible',
      opacity: (el && el._style && el._style.opacity) || '1'
    }),
    showDirectoryPicker: options.showDirectoryPicker
  };
  global.chrome = {
    storage: {
      local: {
        get: (_k, cb) => cb({ ...storageLocal }),
        set: (obj, cb) => {
          Object.assign(storageLocal, obj);
          if (cb) cb();
        }
      }
    }
  };

  return {
    doc,
    MockFile,
    eventsLog,
    fileReadCalls,
    storageLocal,
    controls: { inpPhoto, inpMarksheet, inpIncome, dzIncome, inpCaste, dzExtra, swInternalInput }
  };
}

function createMockWidget(SleepwalkerConfirm) {
  const replies = [];
  const spoken = [];
  const confirm = new SleepwalkerConfirm({ timeoutMs: 20000 });
  return {
    replies,
    spoken,
    confirm,
    setAssistantReply: (m) => replies.push(m),
    showConfirmCard: () => {},
    reader: { readText: (t) => spoken.push(t) },
    pill: {
      status: 'idle',
      setStatus: function (s) { this.status = s; },
      setIdle: function () { this.status = 'idle'; },
      openBubble: () => {},
      renderFileCard: () => {},
      clearFileCard: () => {}
    }
  };
}

async function main() {
  console.log('=== Sleepwalker Phase 6 Test Suite ===\n');

  // Suite 1: Syntax, manifest & background order, UI hook checks
  await runSuite('JS Syntax, Script Order & Upload UI Hooks', () => {
    for (const f of ['upload.js', 'card.js', 'orb.js', 'content.js', 'background.js']) {
      execSync(`node --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' });
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const scripts = manifest.content_scripts[0].js;
    const uploadIdx = scripts.indexOf('upload.js');
    const contentIdx = scripts.indexOf('content.js');
    assert.ok(uploadIdx !== -1 && contentIdx !== -1 && uploadIdx < contentIdx, 'upload.js must precede content.js in manifest.json');

    const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
    const bgUpload = bgSrc.indexOf("'upload.js'");
    const bgContent = bgSrc.indexOf("'content.js'");
    assert.ok(bgUpload !== -1 && bgContent !== -1 && bgUpload < bgContent, "background.js must inject 'upload.js' before 'content.js'");

    const cardSrc = fs.readFileSync(path.join(ROOT, 'card.js'), 'utf8');
    const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    assert.ok(cardSrc.includes('sw-card-file-input') && cardSrc.includes('Choose File'), 'card.js must render file upload card');
    assert.ok(contentSrc.includes('handleUploadCardChange') && contentSrc.includes('undoLastUpload'), 'content.js must wire file upload & undo controls');
  });

  // Suite 2: Target detection, label/size/accept parsing & #sleepwalker-host exclusion
  await runSuite('Upload Target Detection, Size Parsing & #sleepwalker-host Exclusion', () => {
    const env = createUploadMockDom({ includeStandaloneDropzone: true });
    const {
      SleepwalkerUpload,
      parseSizeLimitFromText,
      matchesAcceptRule,
      formatBytes,
      isImageFile
    } = loadModule('upload.js');
    const SleepwalkerConfirm = loadModule('confirm.js');

    assert.strictEqual(parseSizeLimitFromText('Max 2 MB'), 2 * 1024 * 1024);
    assert.strictEqual(parseSizeLimitFromText('under 500 KB'), 500 * 1024);
    assert.strictEqual(parseSizeLimitFromText('Limit: 1.5MB'), Math.round(1.5 * 1024 * 1024));
    assert.strictEqual(formatBytes(512 * 1024), '512 KB');
    assert.strictEqual(formatBytes(2 * 1024 * 1024), '2.0 MB');
    assert.strictEqual(isImageFile(new env.MockFile(['x'], 'photo.jpg', { type: 'image/jpeg' })), true);
    assert.strictEqual(isImageFile(new env.MockFile(['x'], 'doc.pdf', { type: 'application/pdf' })), false);

    assert.strictEqual(matchesAcceptRule(new env.MockFile(['x'], 'p.jpg', { type: 'image/jpeg' }), 'image/*'), true);
    assert.strictEqual(matchesAcceptRule(new env.MockFile(['x'], 'p.pdf', { type: 'application/pdf' }), 'image/jpeg,.png'), false);

    const widget = createMockWidget(SleepwalkerConfirm);
    const uploader = new SleepwalkerUpload(widget);
    const targets = uploader.detectUploadTargets(env.doc);

    assert.strictEqual(targets.length, 4, `Expected 4 portal targets, got ${targets.length}`);
    assert.ok(!targets.some((t) => t.id === 'sw-hidden-file-picker'), '#sleepwalker-host file input must be excluded');

    const photoTarget = targets.find((t) => t.inputElement && t.inputElement.id === 'up-photo');
    assert.ok(photoTarget && photoTarget.maxBytes === 500 * 1024, 'Photo maxBytes should parse 500 KB');

    const incomeTarget = targets.find((t) => t.inputElement && t.inputElement.id === 'up-income');
    assert.ok(incomeTarget && incomeTarget.dropElement === env.controls.dzIncome && incomeTarget.maxBytes === 2 * 1024 * 1024, 'Hidden file input inside dropzone must link dropElement & 2 MB cap');
  });

  // Suite 3: Voice fuzzy matching, disambiguation, accept/size validation & optional image compression
  await runSuite('Fuzzy Voice Matching, Disambiguation, Validation & Image Compression', async () => {
    let drawnW = 0;
    let drawnH = 0;
    const mockCanvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect: () => {},
        drawImage: (_img, _x, _y, w, h) => { drawnW = w; drawnH = h; }
      }),
      toBlob: (cb, mime, quality) => {
        const len = quality > 0.7 ? 700 * 1024 : 180 * 1024;
        cb({ size: len, type: mime });
      }
    });

    const env = createUploadMockDom({ includeAmbiguousCertificate: true, mockCanvas });
    global.window.URL = {
      createObjectURL: () => 'blob:mock-photo',
      revokeObjectURL: () => {}
    };
    global.Image = class MockImage {
      constructor() {
        this.width = 2000;
        this.height = 1500;
        this.onload = null;
        this.onerror = null;
      }
      set src(_val) {
        if (typeof this.onload === 'function') {
          setTimeout(() => this.onload(), 0);
        }
      }
    };

    const { SleepwalkerUpload } = loadModule('upload.js');
    const SleepwalkerConfirm = loadModule('confirm.js');

    const cards = [];
    const widget = createMockWidget(SleepwalkerConfirm);
    const uploader = new SleepwalkerUpload(widget, { onCardChange: (c) => cards.push(c) });

    // Unambiguous matches
    const resPhoto = uploader.requestUpload('upload my passport photo');
    assert.strictEqual(resPhoto.ok, true);
    assert.strictEqual(resPhoto.awaitingPickerTap, true);
    assert.strictEqual(resPhoto.target.inputElement.id, 'up-photo');

    const resMark = uploader.requestUpload('marksheet upload');
    assert.strictEqual(resMark.ok, true);
    assert.strictEqual(resMark.target.inputElement.id, 'up-marksheet');

    // Ambiguous query ("certificate" matches both Income Certificate & Caste Certificate)
    const resAmb = uploader.requestUpload('certificate');
    assert.strictEqual(resAmb.ok, true);
    assert.strictEqual(resAmb.awaitingDisambiguation, true);
    assert.strictEqual(widget.confirm.isAwaiting(), true);
    assert.ok(widget.confirm.pending.options && widget.confirm.pending.options.length >= 2, 'Ambiguous match must ask numbered options');

    // Selecting option 1 (Income Certificate) moves cleanly to choose-file card
    const opt1Target = widget.confirm.pending.options[0].target;
    widget.confirm.handleResponse('1');
    assert.strictEqual(cards[cards.length - 1].stage, 'choose');
    assert.strictEqual(cards[cards.length - 1].target.id, opt1Target.id);

    // Validation failures: wrong file type + oversized image flags canCompress: true
    const allTargets = uploader.detectUploadTargets(env.doc);
    const photoTarget = allTargets.find((t) => t.inputElement && t.inputElement.id === 'up-photo');
    const badExe = new env.MockFile(['MZ'], 'virus.exe', { type: 'application/x-msdownload', size: 1000 });
    const resBadType = uploader.handleSelectedFile(badExe, photoTarget);
    assert.strictEqual(resBadType.ok, false);
    assert.strictEqual(resBadType.validation.acceptOk, false);
    assert.strictEqual(cards[cards.length - 1].stage, 'validation_error');

    const hugePhoto = new env.MockFile(['jpegdata'], 'selfie.jpg', { type: 'image/jpeg', size: 1800 * 1024 });
    const resBigImg = uploader.handleSelectedFile(hugePhoto, photoTarget);
    assert.strictEqual(resBigImg.ok, false);
    assert.strictEqual(resBigImg.validation.sizeOk, false);
    assert.strictEqual(resBigImg.validation.canCompress, true);

    const compressed = await uploader.compressImageToTargetLimit(hugePhoto, photoTarget.maxBytes);
    assert.ok(compressed && compressed.size <= photoTarget.maxBytes && drawnW > 0 && drawnH > 0, 'Client-side compression should shrink image below maxBytes');

    // Huge PDF cannot be image-compressed
    const incomeTarget = allTargets.find((t) => t.inputElement && t.inputElement.id === 'up-income');
    const hugePdf = new env.MockFile(['pdf'], 'big.pdf', { type: 'application/pdf', size: 6 * 1024 * 1024 });
    const resBigPdf = uploader.validateSelectedFile(hugePdf, incomeTarget);
    assert.strictEqual(resBigPdf.sizeOk, false);
    assert.strictEqual(resBigPdf.canCompress, false);

    delete global.Image;
  });

  // Suite 4: Honest Picker Flow -> Final Yes Confirm -> DataTransfer Attach (input + dropzone) -> Undo
  await runSuite('Honest Picker -> Final Yes Confirm -> DataTransfer + Dropzone Events -> Undo', () => {
    const env = createUploadMockDom();
    const { SleepwalkerUpload } = loadModule('upload.js');
    const SleepwalkerConfirm = loadModule('confirm.js');

    const cards = [];
    const widget = createMockWidget(SleepwalkerConfirm);
    const uploader = new SleepwalkerUpload(widget, { onCardChange: (c) => cards.push(c ? { ...c } : null) });

    // Step 1: Voice command opens Choose card (never auto-attaches!)
    const startRes = uploader.requestUpload('income certificate');
    assert.strictEqual(startRes.awaitingPickerTap, true);
    assert.strictEqual(cards[cards.length - 1].stage, 'choose');
    assert.strictEqual(env.controls.inpIncome.files.length, 0);

    // Step 2: Simulate user picking file via native dialog -> final confirmation required
    const incomeFile = new env.MockFile(['%PDF-1.4 mock'], 'income_cert.pdf', { type: 'application/pdf', size: 420 * 1024 });
    const pickRes = uploader.handleSelectedFile(incomeFile, startRes.target);
    assert.strictEqual(pickRes.ok, true);
    assert.strictEqual(pickRes.awaitingFinalConfirm, true);
    assert.strictEqual(cards[cards.length - 1].stage, 'confirm_attach');
    assert.strictEqual(env.controls.inpIncome.files.length, 0, 'File must NOT attach before final Yes confirm');

    // Step 3: Deny first -> remains unattached
    widget.confirm.handleResponse('nahi');
    assert.strictEqual(env.controls.inpIncome.files.length, 0, 'Cancelling final confirm must leave file input empty');

    // Step 4: Re-select & say Hindi/Hinglish YES ("haan kar do") -> attaches with DataTransfer + input/change + dropzone events
    uploader.handleSelectedFile(incomeFile, startRes.target);
    const yesRes = widget.confirm.handleResponse('haan kar do');
    assert.strictEqual(yesRes.handled, true);
    assert.strictEqual(env.controls.inpIncome.files.length, 1);
    assert.strictEqual(env.controls.inpIncome.files[0].name, 'income_cert.pdf');
    assert.strictEqual(cards[cards.length - 1].stage, 'attached');

    const eventTypesOnInput = env.eventsLog.filter((e) => e.targetId === 'up-income').map((e) => e.type);
    const eventTypesOnDz = env.eventsLog.filter((e) => e.targetId === 'dz-income').map((e) => e.type);
    assert.ok(eventTypesOnInput.includes('input') && eventTypesOnInput.includes('change'), 'Must fire input and change on file input');
    assert.ok(
      eventTypesOnDz.includes('dragenter') && eventTypesOnDz.includes('dragover') && eventTypesOnDz.includes('drop'),
      'Must fire dragenter, dragover and drop on dropzone'
    );
    const dropEv = env.eventsLog.find((e) => e.targetId === 'dz-income' && e.type === 'drop');
    assert.strictEqual(dropEv.dtFile, 'income_cert.pdf', 'Drop event DataTransfer must contain selected file');

    // Step 5: Undo clears attached file and fires change event
    const undoRes = uploader.undoLastUpload();
    assert.strictEqual(undoRes.ok, true);
    assert.strictEqual(env.controls.inpIncome.files.length, 0, 'Undo must clear attached files');
    assert.strictEqual(env.controls.inpIncome.value, '');
    assert.strictEqual(cards[cards.length - 1], null, 'Undo should clear upload card');
  });

  // Suite 5: Intent Engine Routing & Strict Privacy (No File Content Read / No Filename in Digest)
  await runSuite('Intent Engine UPLOAD/UNDO Routing & Strict File Privacy', async () => {
    const env = createUploadMockDom();
    const { SleepwalkerUpload } = loadModule('upload.js');
    const SleepwalkerConfirm = loadModule('confirm.js');
    const SleepwalkerIntent = loadModule('intent.js');
    const { buildDigest } = loadModule('digest.js');
    const lexicon = JSON.parse(fs.readFileSync(path.join(ROOT, 'lexicon.json'), 'utf8'));

    const intentEngine = new SleepwalkerIntent({ lexicon });
    const r1 = await intentEngine.classify('photo upload karo');
    const r2 = await intentEngine.classify('upload my income certificate');
    const r3 = await intentEngine.classify('marksheet upload karni hai');
    const rUndo = await intentEngine.classify('undo');
    assert.strictEqual(r1.intent, 'UPLOAD');
    assert.strictEqual(r2.intent, 'UPLOAD');
    assert.strictEqual(r3.intent, 'UPLOAD');
    assert.strictEqual(rUndo.intent, 'UNDO');

    const widget = createMockWidget(SleepwalkerConfirm);
    const uploader = new SleepwalkerUpload(widget);

    const startRes = uploader.requestUpload(r2.args.target || 'income certificate');
    const secretFile = new env.MockFile(['TOP SECRET INCOME CONTENT'], 'secret_tax_return_2026.pdf', {
      type: 'application/pdf',
      size: 120 * 1024
    });
    uploader.handleSelectedFile(secretFile, startRes.target);
    widget.confirm.handleResponse('yes');

    assert.strictEqual(env.fileReadCalls.length, 0, 'Upload workflow must NEVER read file contents (.text/.arrayBuffer/FileReader)');
    assert.strictEqual(Object.keys(env.storageLocal).length, 0, 'Upload workflow must NEVER persist filenames in chrome.storage.local');

    // Digest must NEVER include selected filename or C:\fakepath value
    const digest = buildDigest(env.doc);
    const digestJson = JSON.stringify(digest);
    assert.ok(!digestJson.includes('secret_tax_return_2026'), 'Page digest must NEVER leak uploaded filename');
    assert.ok(!digestJson.toLowerCase().includes('fakepath'), 'Page digest must NEVER leak input fakepath value');
  });

  // Suite 6: Experimental Document Shelf (Graceful Unsupported + Mocked DirectoryPicker Flow)
  await runSuite('Experimental Document Shelf (Unsupported Fallback & Mocked Folder Handle)', async () => {
    // Part A: Unavailable API
    createUploadMockDom({ showDirectoryPicker: undefined });
    const { SleepwalkerUpload } = loadModule('upload.js');
    const SleepwalkerConfirm = loadModule('confirm.js');
    const widgetA = createMockWidget(SleepwalkerConfirm);
    const uploaderA = new SleepwalkerUpload(widgetA);

    assert.strictEqual(uploaderA.isShelfSupported(), false);
    const resUnsupported = await uploaderA.connectShelfFolder();
    assert.strictEqual(resUnsupported.ok, false);
    assert.strictEqual(resUnsupported.reason, 'unsupported');

    // Part B: Supported File System Access API
    const makeHandle = (name, size, type) => ({
      kind: 'file',
      name,
      getFile: async () => new global.File(['data'], name, { size, type })
    });
    const handles = [
      makeHandle('passport_photo.jpg', 140 * 1024, 'image/jpeg'),
      makeHandle('income_certificate_2026.pdf', 310 * 1024, 'application/pdf'),
      makeHandle('readme.txt', 200, 'text/plain')
    ];
    const env = createUploadMockDom({
      showDirectoryPicker: async () => ({
        name: 'ScholarshipDocs',
        values: async function* () {
          for (const h of handles) yield h;
        }
      })
    });

    const widgetB = createMockWidget(SleepwalkerConfirm);
    const uploaderB = new SleepwalkerUpload(widgetB);
    assert.strictEqual(uploaderB.isShelfSupported(), true);

    const conn = await uploaderB.connectShelfFolder();
    assert.strictEqual(conn.ok, true);
    assert.strictEqual(conn.folderName, 'ScholarshipDocs');
    assert.strictEqual(conn.count, 3);
    assert.strictEqual(Object.keys(env.storageLocal).length, 0, 'Shelf metadata stays in memory only, never persisted to chrome.storage.local');

    const bestMatch = uploaderB.matchShelfFile('income certificate', '.pdf,image/*');
    assert.ok(bestMatch && bestMatch.name === 'income_certificate_2026.pdf', 'Shelf fuzzy matcher should rank income_certificate_2026.pdf first');

    // Picking from shelf STILL requires final Yes confirmation before attaching
    const incomeTarget = uploaderB.detectUploadTargets(env.doc).find((t) => t.inputElement && t.inputElement.id === 'up-income');
    const picked = await uploaderB.pickFromShelfEntry(bestMatch, incomeTarget);
    assert.strictEqual(picked.ok, true);
    assert.strictEqual(picked.awaitingFinalConfirm, true);
    assert.strictEqual(env.controls.inpIncome.files.length, 0, 'Shelf pick must still require final Yes before attaching');

    widgetB.confirm.handleResponse('haan');
    assert.strictEqual(env.controls.inpIncome.files.length, 1);
    assert.strictEqual(env.controls.inpIncome.files[0].name, 'income_certificate_2026.pdf');

    uploaderB.disconnectShelfFolder();
    assert.strictEqual(uploaderB.shelf.entries.length, 0);
  });

  console.log(`\nSummary: ${passedSuites}/${passedSuites + failedSuites} P6 suites passed.`);
  if (failedSuites > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
