/**
 * Sleepwalker Phase 4.4 — Advanced Browser Navigation Engine Test Suite
 * Tests:
 * - Tier 1 (Unit & Mock DOM): Fast-Path Router & Contextual Guard, Accessibility + Spatial World Model,
 *   Candidate Disambiguation & Non-Occluding Numbered Overlays, Wait Manager + Animation Noise Filter,
 *   Action Verifier + Loop/Concurrency FSM Isolation, Conditional Visual Grounding.
 * - Tier 2 (Real Chrome MV3 --load-extension): Full Tests A–G (Fast Path, Scoped/Duplicate/Replaced Links,
 *   Multi-Group Options & Contextual Follow-up, Section & Topic Scrolling, YouTube Progressive Feed & Watch Honesty,
 *   Delayed DOM / Modal Obstruction Recovery / Custom Dropdown / SPA Route, Multi-Tab Management).
 * - Optional Tier 3 (--live-web): Live en.wikipedia.org & youtube.com validation with per-stage timing breakdown.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const navEngine = require(path.join(ROOT, 'nav-engine.js'));
const wmMod = require(path.join(ROOT, 'world-model.js'));
const esMod = require(path.join(ROOT, 'element-select.js'));
const llmMod = require(path.join(ROOT, 'llm.js'));

const passedSuites = [];
const failedSuites = [];

async function runSuite(name, fn) {
  const t0 = Date.now();
  console.log(`RUN   ${name}`);
  try {
    await fn();
    passedSuites.push(name);
    console.log(`PASS  ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failedSuites.push({ name, err });
    console.error(`FAIL  ${name}: ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.error(err.stack);
  }
}

function findChromiumExe() {
  const pwRoot = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const candidates = [];
  if (fs.existsSync(pwRoot)) {
    for (const dir of fs.readdirSync(pwRoot)) {
      if (dir.startsWith('chromium-')) {
        candidates.push(path.join(pwRoot, dir, 'chrome-win64', 'chrome.exe'));
        candidates.push(path.join(pwRoot, dir, 'chrome-win', 'chrome.exe'));
      }
    }
  }
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function loadGlobalScript(filePath, envGlobals = {}) {
  Object.assign(global, envGlobals);
  delete require.cache[require.resolve(filePath)];
  return require(filePath);
}

function createMockDomEnv(url = 'https://shop.example.org/item') {
  const mutQueues = [];
  class MockMutationObserver {
    constructor(cb) { this.cb = cb; this.active = false; }
    observe() { this.active = true; mutQueues.push(this); }
    disconnect() { this.active = false; }
  }
  function emitMut(rec) {
    for (const obs of mutQueues) {
      if (obs.active) obs.cb([rec]);
    }
  }

  function matchSingleSelector(el, sel) {
    if (!el || el.nodeType !== 1 || !sel) return false;
    const s = sel.trim();
    if (!s || s === '*') return true;
    const parts = s.split(/\s+/);
    const leaf = parts[parts.length - 1];
    // Handle chained tag/attr like input[type="radio"] or ul[role="listbox"]
    let rem = leaf;
    const tagM = rem.match(/^([a-zA-Z0-9_-]+)/);
    if (tagM) {
      if (el.tagName.toLowerCase() !== tagM[1].toLowerCase()) return false;
      rem = rem.slice(tagM[1].length);
    }
    const idM = rem.match(/#([a-zA-Z0-9_-]+)/);
    if (idM) {
      if (el.id !== idM[1]) return false;
      rem = rem.replace(idM[0], '');
    }
    const clsM = rem.match(/\.([a-zA-Z0-9_-]+)/);
    if (clsM) {
      if (!el.classList.contains(clsM[1])) return false;
      rem = rem.replace(clsM[0], '');
    }
    const attrMatches = [...rem.matchAll(/\[([^\]=*~^$|]+)(?:([*^$~|]?=)"?([^"\]]*)"?)?\]/g)];
    for (const am of attrMatches) {
      const k = am[1].trim();
      const op = am[2] || '';
      const val = am[3] || '';
      const got = el.getAttribute(k);
      if (!op) {
        if (!el.hasAttribute(k) && !got) return false;
      } else if (op === '=') {
        if (String(got || '') !== val) return false;
      } else if (op === '*=') {
        if (!String(got || '').includes(val)) return false;
      }
    }
    return true;
  }

  function matchesSelector(el, selGroup) {
    return String(selGroup || '').split(',').some((s) => matchSingleSelector(el, s));
  }

  function makeNode(tag, opts = {}, children = []) {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const classes = new Set(String(opts.className || '').split(/\s+/).filter(Boolean));
    let _text = opts.text || '';
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || '',
      name: opts.name || '',
      type: opts.type || '',
      value: opts.value !== undefined ? String(opts.value) : '',
      href: opts.href || '',
      checked: Boolean(opts.checked),
      selected: Boolean(opts.selected),
      disabled: Boolean(opts.disabled),
      hidden: Boolean(opts.hidden),
      isConnected: opts.isConnected !== false,
      children: [],
      childNodes: [],
      parentElement: null,
      parentNode: null,
      ownerDocument: null,
      style: opts.style ? { ...opts.style } : {},
      dataset: opts.dataset ? { ...opts.dataset } : {},
      shadowRoot: null,
      contentDocument: null,
      _rect: opts.rect || { left: 10, top: 10, right: 130, bottom: 42, width: 120, height: 32 },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c)
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) {
        const oldVal = Array.from(classes).join(' ');
        classes.clear();
        String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
        emitMut({ type: 'attributes', target: el, attributeName: 'class', oldValue: oldVal });
      },
      get innerText() {
        return _text || el.children.map((c) => c.innerText || '').filter(Boolean).join(' ');
      },
      set innerText(v) { _text = String(v || ''); },
      get textContent() {
        return _text || el.children.map((c) => c.textContent || '').filter(Boolean).join(' ');
      },
      set textContent(v) { _text = String(v || ''); },
      getAttribute(k) {
        if (k === 'id' && el.id) return el.id;
        if (k === 'name' && el.name) return el.name;
        if (k === 'type' && el.type) return el.type;
        if (k === 'href' && el.href) return el.href;
        if (k === 'role' && opts.role) return opts.role;
        if (k === 'aria-label' && opts.ariaLabel) return opts.ariaLabel;
        if (k === 'aria-expanded' && attrs.has('aria-expanded')) return attrs.get('aria-expanded');
        if (k === 'alt' && opts.alt) return opts.alt;
        if (k === 'class') return el.className;
        if (k === 'hidden') return el.hidden ? '' : null;
        return attrs.has(k) ? attrs.get(k) : '';
      },
      setAttribute(k, v) {
        const oldVal = attrs.has(k) ? attrs.get(k) : null;
        if (k === 'id') el.id = String(v);
        if (k === 'class') el.className = String(v);
        attrs.set(k, String(v));
        emitMut({ type: 'attributes', target: el, attributeName: k, oldValue: oldVal });
      },
      hasAttribute(k) {
        if (k === 'hidden') return Boolean(el.hidden);
        return attrs.has(k) || Boolean(el.getAttribute(k));
      },
      appendChild(c) {
        c.parentElement = el;
        c.parentNode = el;
        c.ownerDocument = el.ownerDocument;
        c.isConnected = el.isConnected;
        el.children.push(c);
        el.childNodes.push(c);
        emitMut({ type: 'childList', target: el, addedNodes: [c], removedNodes: [] });
        return c;
      },
      removeChild(c) {
        el.children = el.children.filter((x) => x !== c);
        el.childNodes = el.childNodes.filter((x) => x !== c);
        c.parentElement = null;
        c.parentNode = null;
        c.isConnected = false;
        emitMut({ type: 'childList', target: el, addedNodes: [], removedNodes: [c] });
      },
      remove() {
        if (el.parentNode && typeof el.parentNode.removeChild === 'function') {
          el.parentNode.removeChild(el);
        } else {
          el.isConnected = false;
        }
      },
      cloneNode(deep = false) {
        const cloned = makeNode(tag, { ...opts, text: _text, attrs: Object.fromEntries(attrs), rect: { ...el._rect } }, []);
        if (deep) {
          el.children.forEach((c) => cloned.appendChild(c.cloneNode(true)));
        }
        return cloned;
      },
      contains(other) {
        let cur = other;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      getBoundingClientRect() { return { ...el._rect }; },
      getRootNode() { return el._rootNode || doc; },
      attachShadow() {
        const host = el;
        const sh = makeNode('div', { id: 'shadow-root-sim' }, []);
        sh.host = host;
        sh.ownerDocument = el.ownerDocument;
        sh._markRoot = (n) => {
          n._rootNode = sh;
          (n.children || []).forEach((ch) => sh._markRoot(ch));
        };
        const origAppend = sh.appendChild;
        sh.appendChild = (c) => { sh._markRoot(c); return origAppend.call(sh, c); };
        el.shadowRoot = sh;
        return sh;
      },
      addEventListener(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(fn);
      },
      removeEventListener(ev, fn) {
        if (!listeners.has(ev)) return;
        listeners.set(ev, listeners.get(ev).filter((f) => f !== fn));
      },
      dispatchEvent(ev) {
        const list = listeners.get(ev.type) || [];
        list.forEach((fn) => fn(ev));
      },
      click() {
        if (el.tagName === 'INPUT' && el.type === 'radio' && el.name) {
          doc.querySelectorAll('input').forEach((inp) => {
            if (inp.type === 'radio' && inp.name === el.name) inp.checked = (inp === el);
          });
        }
        el.dispatchEvent({ type: 'click', target: el, bubbles: true });
      },
      focus() { doc.activeElement = el; },
      scrollIntoView() {},
      closest(sel) {
        let cur = el;
        while (cur) {
          if (matchesSelector(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const res = [];
        const walk = (node) => {
          for (const ch of node.children || []) {
            if (matchesSelector(ch, sel)) res.push(ch);
            walk(ch);
          }
        };
        walk(el);
        return res;
      },
      querySelector(sel) { return el.querySelectorAll(sel)[0] || null; }
    };
    if (attrs.has('role')) opts.role = attrs.get('role');
    children.forEach((c) => el.appendChild(c));
    return el;
  }

  const body = makeNode('body', {}, []);
  const htmlEl = makeNode('html', {}, [body]);
  const docListeners = new Map();
  const doc = {
    title: 'Unit Mock Page',
    readyState: 'complete',
    location: { href: url },
    body,
    documentElement: htmlEl,
    activeElement: body,
    createElement: (tag) => { const n = makeNode(tag); n.ownerDocument = doc; return n; },
    getElementById: (id) => htmlEl.querySelector(`#${id}`),
    querySelectorAll: (sel) => htmlEl.querySelectorAll(sel),
    querySelector: (sel) => htmlEl.querySelector(sel),
    elementsFromPoint: () => [body],
    addEventListener: (ev, fn) => {
      if (!docListeners.has(ev)) docListeners.set(ev, []);
      docListeners.get(ev).push(fn);
    },
    removeEventListener: (ev, fn) => {
      if (docListeners.has(ev)) docListeners.set(ev, docListeners.get(ev).filter((f) => f !== fn));
    },
    dispatchEvent: (ev) => {
      (docListeners.get(ev.type) || []).forEach((fn) => fn(ev));
    }
  };
  body.ownerDocument = doc;
  htmlEl.ownerDocument = doc;

  const win = {
    location: { href: url },
    innerWidth: 1280,
    innerHeight: 768,
    scrollY: 0,
    scrollX: 0,
    MutationObserver: MockMutationObserver,
    KeyboardEvent: class MockKeyboardEvent { constructor(type, init = {}) { this.type = type; this.key = init.key || ''; this.bubbles = Boolean(init.bubbles); } }
  };
  doc.defaultView = win;
  return { window: win, document: doc, makeNode, MockMutationObserver };
}

/**
 * Focused accessibility fixture. It uses the shared mock's element primitives but
 * constructs the DOM explicitly so it does not claim to parse HTML, implement a
 * browser accessibility tree, or emulate layout. Geometry is supplied by each
 * fixture element; open shadow roots and same-origin frame documents are modeled
 * as separate query roots, as the production observer traverses them.
 */
function createAccessibilityFixture(url = 'https://shop.example.org/item') {
  const dom = createMockDomEnv(url);
  const { document, window, makeNode } = dom;
  const el = (tag, opts = {}, children = []) => makeNode(tag, opts, children);
  const main = el('main', {}, [
    el('h1', { text: 'Storefront' }),
    el('section', {}, [
      el('h2', { text: 'Filters' }),
      el('div', { id: 'combo-country', attrs: { role: 'combobox', 'aria-expanded': 'false', 'aria-haspopup': 'listbox' } }, [
        el('span', { className: 'label', text: 'Country' }),
        el('ul', { attrs: { role: 'listbox', hidden: '' }, hidden: true }, [
          el('li', { attrs: { role: 'option' }, text: 'India' }),
          el('li', { attrs: { role: 'option' }, text: 'Germany' }),
          el('li', { attrs: { role: 'option' }, text: 'Japan' })
        ])
      ]),
      el('label', { attrs: { for: 'region-filter' }, text: 'Region filter' }),
      el('input', { id: 'region-filter', type: 'text', attrs: { type: 'text' } }),
      el('button', { id: 'icon-only-btn', attrs: { type: 'button' }, rect: { left: 50, top: 900, right: 120, bottom: 940, width: 70, height: 40 } }, [
        el('img', { attrs: { alt: 'Settings Gear', src: 'gear.png' } })
      ]),
      el('a', { id: 'top-right-link', href: '/help', attrs: { href: '/help' }, text: 'Help Desk', rect: { left: 1050, top: 40, right: 1180, bottom: 75, width: 130, height: 35 } }),
      el('div', { id: 'shadow-host' }),
      el('iframe', { id: 'same-origin-frame', attrs: { title: 'Policy frame', src: '/frame' } })
    ])
  ]);
  document.body.appendChild(main);

  const assignOwnerDocument = (node, ownerDocument) => {
    node.ownerDocument = ownerDocument;
    node.isConnected = true;
    for (const child of node.children || []) assignOwnerDocument(child, ownerDocument);
  };
  assignOwnerDocument(document.documentElement, document);

  const shadowHost = document.getElementById('shadow-host');
  const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
  // Native ShadowRoot exposes its mode; the shared lightweight mock does not.
  shadowRoot.mode = 'open';
  const shadowButton = el('button', { id: 'sh-btn', attrs: { type: 'button' }, text: 'Shadow Checkout' });
  shadowRoot.appendChild(shadowButton);
  shadowRoot.elementsFromPoint = () => [shadowButton];
  assignOwnerDocument(shadowButton, document);
  shadowButton._rootNode = shadowRoot;

  const frame = document.getElementById('same-origin-frame');
  frame._rect = { left: 600, top: 180, right: 1080, bottom: 380, width: 480, height: 200 };
  const frameDom = createMockDomEnv('https://shop.example.org/frame');
  const frameLink = el('a', { id: 'frame-link', href: '/frame-terms', attrs: { href: '/frame-terms' }, text: 'Iframe Policy Link' });
  frameDom.document.body.appendChild(frameLink);
  assignOwnerDocument(frameDom.document.documentElement, frameDom.document);
  frameDom.document.elementsFromPoint = () => [frameLink];
  frame.contentDocument = frameDom.document;
  document.elementsFromPoint = (x, y) => {
    if (x >= 600 && x <= 1080 && y >= 180 && y <= 380) return [frame];
    if (x < 200 && y < 100) return [shadowHost];
    return [document.body];
  };

  return { ...dom, elements: { comboCountry: document.getElementById('combo-country'), iconButton: document.getElementById('icon-only-btn'), topRightLink: document.getElementById('top-right-link'), shadowButton, frame, frameLink, regionInput: document.getElementById('region-filter') } };
}

async function startPhase44FixtureServer() {
  const pages = {
    '/nav-main': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Banking & Cards Guide - Sleepwalker Test</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; line-height: 1.5; }
    section { margin: 28px 0; padding: 16px; border: 1px solid #ddd; }
    .spacer { height: 700px; }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 900; }
    .modal-overlay[hidden] { display: none; }
    .dropdown-menu[hidden] { display: none; }
    .covered-wrap { position: relative; display: inline-block; padding: 12px; }
    .blocker-shield { position: absolute; inset: 0; z-index: 10; background: rgba(255,200,200,0.35); }
  </style>
</head>
<body>
  <nav aria-label="Main Menu">
    <a href="/about" id="nav-about">About</a>
    <a href="/cards-overview" id="nav-cards">Overview</a>
  </nav>
  <main>
    <h1>Banking & Cards Encyclopedia</h1>

    <section id="sec-intro">
      <h2>Introduction</h2>
      <p>Payment cards connect consumers to payment networks.</p>
      <a href="/wiki/Credit_card" id="intro-cc">Credit card</a>
    </section>

    <section id="sec-cards">
      <h2>Cards</h2>
      <ul>
        <li><a href="/cards/bank" id="link-bank-card">Bank card</a> — Issued by regulated banks.</li>
        <li><a href="/cards/smart" id="link-smart-card">Smart card</a> — Embedded EMV chip.</li>
      </ul>
      <div class="sidebar-dup">
        <a href="/apply/bank-sidebar" id="dup-apply-nav">Learn More</a>
      </div>
    </section>

    <section id="sec-latest">
      <h2>Latest Articles</h2>
      <ol>
        <li><a href="/articles/first-emv" id="art-1">EMV Security Basics</a></li>
        <li><a href="/articles/second-settlement" id="art-2">Settlement Clearing Rules</a></li>
        <li><a href="/articles/third-fraud" id="art-3">Fraud Prevention Metrics</a></li>
      </ol>
      <p>More <a href="/articles/more" id="dup-learn-main">Learn More</a> details.</p>
    </section>

    <section id="sec-options">
      <h2>Configuration Options</h2>
      <fieldset id="fs-prod-size">
        <legend>Product Size</legend>
        <label><input type="radio" name="product_size" value="small" id="opt-prod-small" /> Small</label>
        <label><input type="radio" name="product_size" value="medium" id="opt-prod-medium" checked /> Medium</label>
        <label><input type="radio" name="product_size" value="large" id="opt-prod-large" /> Large</label>
      </fieldset>

      <fieldset id="fs-app-text">
        <legend>Appearance</legend>
        <button type="button" id="btn-hide-appearance">Hide Appearance</button>
        <div role="radiogroup" aria-label="Color">
          <span>Color</span>
          <label><input type="radio" name="color_pref" value="light" id="opt-color-light" checked /> Light</label>
          <label><input type="radio" name="color_pref" value="dark" id="opt-color-dark" /> Dark</label>
        </div>
        <div role="radiogroup" aria-label="Text">
          <span>Text</span>
          <label><input type="radio" name="text_size" value="small" id="opt-app-small" /> Small</label>
          <label><input type="radio" name="text_size" value="standard" id="opt-app-std" checked /> Standard</label>
        </div>
      </fieldset>

      <div id="custom-dd-wrap">
        <label id="lbl-country-custom">Country Selector</label>
        <button type="button" id="btn-country-dd" aria-haspopup="listbox" aria-expanded="false">Choose Country</button>
        <div id="list-country-dd" role="listbox" class="dropdown-menu" hidden>
          <div role="option" data-val="de" tabindex="0">Germany</div>
          <div role="option" data-val="in" tabindex="0">India</div>
          <div role="option" data-val="jp" tabindex="0">Japan</div>
        </div>
      </div>

      <div style="margin-top:16px">
        <button type="button" id="btn-load-delayed">Load Delayed Actions</button>
        <div id="delayed-zone"></div>
      </div>

      <div style="margin-top:16px">
        <button type="button" id="btn-open-modal">Open Modal Dialog</button>
      </div>

      <div class="covered-wrap" style="margin-top:16px">
        <button type="button" id="btn-shielded">Shielded Action</button>
        <div class="blocker-shield" id="shield-overlay" aria-label="Close banner" role="dialog">
          <button type="button" class="modal-close" aria-label="Close" onclick="document.getElementById('shield-overlay').remove()">X</button>
        </div>
      </div>
    </section>

    <div class="spacer"></div>

    <section id="sec-reg">
      <h2>Regulatory Framework</h2>
      <p id="p-banking-reg">Central banks enforce strict banking regulations governing reserve ratios, anti-money laundering audits, and consumer liability limits.</p>
    </section>

    <section id="sec-end">
      <h2>Summary Notes</h2>
      <p>End of guide.</p>
    </section>
  </main>

  <div id="demo-modal" class="modal-overlay" role="dialog" aria-modal="true" hidden>
    <div style="background:#fff;padding:20px;border-radius:8px;min-width:260px;">
      <h3>Confirm Action Modal</h3>
      <button type="button" id="modal-confirm-btn">Approve Notice</button>
      <button type="button" class="modal-close" aria-label="Close" id="modal-close-btn">Close</button>
    </div>
  </div>

  <script>
    window.__clickedShielded = 0;
    window.__approvedModal = 0;
    window.__delayedClicked = 0;

    document.getElementById('btn-shielded').addEventListener('click', () => {
      window.__clickedShielded += 1;
    });
    document.getElementById('btn-open-modal').addEventListener('click', () => {
      document.getElementById('demo-modal').hidden = false;
    });
    document.getElementById('modal-close-btn').addEventListener('click', () => {
      document.getElementById('demo-modal').hidden = true;
    });
    document.getElementById('modal-confirm-btn').addEventListener('click', () => {
      window.__approvedModal += 1;
      document.getElementById('demo-modal').hidden = true;
    });

    const ddBtn = document.getElementById('btn-country-dd');
    const ddList = document.getElementById('list-country-dd');
    ddBtn.addEventListener('click', () => {
      setTimeout(() => {
        const exp = ddBtn.getAttribute('aria-expanded') === 'true';
        ddBtn.setAttribute('aria-expanded', exp ? 'false' : 'true');
        ddList.hidden = exp;
      }, 90);
    });
    ddList.querySelectorAll('[role="option"]').forEach((opt) => {
      opt.addEventListener('click', () => {
        ddBtn.textContent = opt.textContent;
        ddBtn.setAttribute('data-selected', opt.getAttribute('data-val'));
        ddBtn.setAttribute('aria-expanded', 'false');
        ddList.hidden = true;
      });
    });

    document.getElementById('btn-load-delayed').addEventListener('click', () => {
      setTimeout(() => {
        const z = document.getElementById('delayed-zone');
        z.innerHTML = '<button type="button" id="btn-dynamic-apply">Apply Online Now</button>';
        document.getElementById('btn-dynamic-apply').addEventListener('click', () => {
          window.__delayedClicked += 1;
          z.setAttribute('data-applied', 'true');
        });
      }, 150);
    });
  </script>
</body>
</html>`,

    '/spa': `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>SPA Navigation Test</title></head>
<body>
  <h1 id="spa-heading">SPA Home View</h1>
  <nav>
    <a href="#pricing" id="spa-link-pricing">Pricing</a>
    <button type="button" id="spa-btn-rerender">Re-render Dynamic List</button>
  </nav>
  <div id="spa-content"><p>Initial content.</p></div>
  <script>
    document.getElementById('spa-link-pricing').addEventListener('click', (e) => {
      e.preventDefault();
      history.pushState({ view: 'pricing' }, '', '/spa/pricing');
      setTimeout(() => {
        document.getElementById('spa-heading').textContent = 'SPA Pricing View';
        document.getElementById('spa-content').innerHTML = '<p>Monthly Plan: $19</p><a href="/checkout" id="spa-checkout-link">Proceed to Checkout</a>';
      }, 90);
    });
    document.getElementById('spa-btn-rerender').addEventListener('click', () => {
      const wrap = document.getElementById('spa-content');
      wrap.innerHTML = '<button type="button" id="spa-replaced-btn">Continue Setup</button>';
      document.getElementById('spa-replaced-btn').addEventListener('click', () => {
        wrap.setAttribute('data-continued', '1');
      });
    });
  </script>
</body>
</html>`,

    '/yt-feed': `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>YouTube - Neural Networks Search</title></head>
<body>
  <header>
    <input type="search" id="search" placeholder="Search YouTube" value="neural networks" />
  </header>
  <main id="contents">
    ${Array.from({ length: 15 }, (_, idx) => {
      const n = idx + 1;
      const titles = {
        3: 'Complete Neural Networks for Absolute Beginners',
        5: 'Gradient Descent Visually Explained',
        12: 'Backpropagation Math Deep Dive',
        15: 'Transformers and Attention Architecture'
      };
      const channels = {
        3: '3BlueCoding',
        5: 'CodeBasics Lab',
        12: '3BlueCoding',
        15: 'DeepAI Academy'
      };
      const t = titles[n] || `Neural Networks Lesson #${n}`;
      const ch = channels[n] || `AI Channel ${((n - 1) % 4) + 1}`;
      const dur = n === 3 ? '18:20' : (n === 5 ? '8:10' : `${6 + n}:00`);
      return `
      <div class="video-card" data-video-id="vid_${n}" data-title="${t}" data-channel="${ch}" data-duration="${dur}" data-description="Educational walkthrough #${n}">
        <a href="/watch?v=vid_${n}" id="vid-link-${n}"><h3>${t}</h3></a>
        <span class="channel">${ch}</span>
        <span class="duration">${dur}</span>
      </div>`;
    }).join('\n')}
  </main>
</body>
</html>`,

    '/watch': `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>Silent Architecture Demo - YouTube</title></head>
<body data-yt-page="watch" data-sw-site="youtube">
  <div id="above-the-fold">
    <h1><yt-formatted-string>Silent Architecture Demo</yt-formatted-string></h1>
    <div id="channel-name"><a href="/channel/demo">CodeBasics Lab</a></div>
    <div id="description-inner">Visual walkthrough without spoken subtitles or captions.</div>
  </div>
  <video src=""></video>
</body>
</html>`,

    '/tab-second': `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>Second Research Tab - MIT Portal</title></head>
<body>
  <h1>MIT Admissions Portal</h1>
  <p>Application Fee: $75 for international applicants.</p>
</body>
</html>`
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (pages[urlPath]) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pages[urlPath]);
        return;
      }
      if (urlPath.startsWith('/wiki/') || urlPath.startsWith('/cards/') || urlPath.startsWith('/articles/') || urlPath.startsWith('/spa/') || urlPath === '/checkout' || urlPath === '/about') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>${urlPath.replace(/\//g, ' ').trim()}</title></head><body><h1>Destination ${urlPath}</h1><p>Navigated cleanly.</p></body></html>`);
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function runTier1UnitSuites() {
  // Suite U1: Three-Path Command Router & Contextual Guard
  await runSuite('U1. Three-Path Router (Fast Path A vs Contextual Path B vs Multi-Step Path C)', async () => {
    const router = new navEngine.SleepwalkerFastPathRouter();

    const fastCmds = [
      ['Scroll down', 'scroll', 'down'],
      ['Scroll up a little', 'scroll', 'up'],
      ['Go to top', 'scroll', 'top'],
      ['Scroll to the bottom', 'scroll', 'bottom'],
      ['Scroll left', 'scroll', 'left'],
      ['Scroll right', 'scroll', 'right'],
      ['Stop scrolling', 'stop_scroll', undefined],
      ['Go back', 'history', 'back'],
      ['Go forward', 'history', 'forward'],
      ['Reload page', 'history', 'refresh'],
      ['Open new tab', 'tab_new', undefined],
      ['Close current tab', 'tab_close', undefined],
      ['Switch to Wikipedia tab', 'tab_switch', undefined],
      ['Open https://en.wikipedia.org', 'open_url', undefined],
      ['Press Escape', 'press_escape', undefined],
      ['Stop current action', 'stop_action', undefined]
    ];

    const t0 = performance.now();
    for (const [phrase, expectedType, expectedDir] of fastCmds) {
      const r = router.classify(phrase);
      assert.strictEqual(r.path, 'A', `"${phrase}" must route to Path A, got ${r.path} (${r.reason})`);
      assert.ok(r.fastAction && r.fastAction.type === expectedType, `"${phrase}" expected action=${expectedType}, got ${r.fastAction && r.fastAction.type}`);
      if (expectedDir) {
        assert.strictEqual(r.fastAction.dir, expectedDir, `"${phrase}" expected dir=${expectedDir}`);
      }
    }
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 50, `All 16 fast-path routes must execute in < 50ms total (took ${elapsed.toFixed(2)}ms)`);

    // CRITICAL CONTEXTUAL GUARD: Must NOT hijack contextual section queries into Path A!
    const nonFastContextual = [
      'Scroll to the section discussing banking regulations',
      'Go back to the previous section',
      'Take me to where they explain the advantages',
      'Open Bank card under Cards',
      'Open neural networks video'
    ];
    for (const phrase of nonFastContextual) {
      const r = router.classify(phrase);
      assert.strictEqual(r.path, 'B', `"${phrase}" MUST go to Path B, NOT Path A (got ${r.path})`);
    }

    // Path C multi-step objective
    const cRes = router.classify('Compare tuition fees across Germany universities and summarize');
    assert.strictEqual(cRes.path, 'C', 'Multi-tab comparison must route to Path C');
  });

  // Suite U2: Accessibility-first + Spatial Observation (Shadow DOM, Same-Origin Iframe, Combobox Exclusion, Quadrants, Stale)
  await runSuite('U2. Accessibility + Spatial Observation (Combobox Exclusion, Icon Alt, Shadow DOM, Iframe, Quadrants)', async () => {
    const dom = createAccessibilityFixture();
    const { window, document, elements } = dom;

    const prevWin = global.window;
    const prevDoc = global.document;
    global.window = window;
    global.document = document;
    try {
      assert.ok(document.querySelectorAll('*').includes(document.getElementById('shadow-host')), 'Fixture must expose the open-shadow host in the document tree');
      assert.strictEqual(elements.shadowButton.getRootNode().host, document.getElementById('shadow-host'), 'Fixture shadow button must belong to its host shadow root');
      const wm = new wmMod.SleepwalkerWorldModel({ isPrivacyBlockedUrl: () => false }, { tabId: 'tab_u2' });
      const inv = await wm.buildPageWorldModel(document, { tabId: 'tab_u2', force: true });

      const topRightLink = inv.links.find((l) => /help desk/i.test(l.label));
      assert.ok(topRightLink, 'Help Desk link must be indexed');
      assert.strictEqual(topRightLink.quadrant, 'top-right', `Expected top-right quadrant, got ${topRightLink.quadrant}`);
      assert.strictEqual(topRightLink.visibilityState, 'in_viewport');
      assert.strictEqual(topRightLink.tabId, 'tab_u2');
      assert.strictEqual(topRightLink.inventoryVersion, inv.inventoryVersion);
      assert.strictEqual(topRightLink.navigationIdentity, inv.navigationIdentity, 'Indexed candidates must carry their originating navigation identity');
      assert.strictEqual(wm.resolveAndValidateCandidate(topRightLink.id, 'tab_u2').ok, false, 'Candidate validation without its originating identity must fail closed');

      const iconBtn = inv.buttons.find((b) => /settings gear/i.test(b.accessibleName));
      assert.ok(iconBtn, 'Icon-only button must derive accessibleName from inner img[alt]');
      assert.strictEqual(iconBtn.visibilityState, 'below_viewport');

      const shBtn = inv.buttons.find((b) => /shadow checkout/i.test(b.label));
      assert.ok(shBtn && shBtn.inShadowRoot, `Open Shadow DOM button must be discovered with inShadowRoot=true (fixture shadow buttons: ${elements.shadowButton.getRootNode().querySelectorAll('button').length}, indexed: ${inv.buttons.map((b) => b.label).join(', ')})`);
      assert.strictEqual(shBtn.covered, false, 'Visible open-shadow interactive element must not be classified as covered');

      const frameLnk = inv.links.find((l) => /iframe policy link/i.test(l.label));
      assert.ok(frameLnk && frameLnk.inIframe, 'Same-origin iframe link must be discovered with inIframe=true');
      assert.strictEqual(frameLnk.covered, false, 'Visible same-origin iframe interactive element must not be classified as covered');

      const comboSpatial = wm._inspectElementSpatialAndAria(elements.comboCountry, document);
      assert.strictEqual(comboSpatial.accessibleName, 'Country', `Combobox accessibleName must exclude nested listbox options, got "${comboSpatial.accessibleName}"`);
      assert.strictEqual(comboSpatial.role, 'combobox');
      assert.strictEqual(comboSpatial.ariaExpanded, 'false');
      assert.strictEqual(comboSpatial.hasPopup, 'listbox');

      const labelledControl = inv.controls.find((control) => control.element === elements.regionInput);
      assert.ok(labelledControl, 'Associated-label text input must be indexed as a control');
      assert.strictEqual(labelledControl.accessibleName, 'Region filter', 'Associated label must supply the control accessible name');

      // Identity, tab, and inventory-version guards reject stale or mismatched references.
      const badIdentity = wm.resolveAndValidateCandidate(topRightLink.id, 'tab_u2', { expectedNavigationIdentity: inv.navigationIdentity, expectLabel: 'Billing Portal' });
      assert.strictEqual(badIdentity.ok, false, 'Identity mismatch must fail strict validation');
      const wrongTab = wm.resolveAndValidateCandidate(topRightLink.id, 'tab_other', { expectedNavigationIdentity: inv.navigationIdentity });
      assert.strictEqual(wrongTab.ok, false, 'Candidate references must not resolve from another tab');
      const staleVersion = wm.resolveAndValidateCandidate(topRightLink.id, 'tab_u2', { expectedNavigationIdentity: inv.navigationIdentity, expectedVersion: inv.inventoryVersion + 1 });
      assert.strictEqual(staleVersion.ok, false, 'Candidate references must reject a stale inventory version');

      // Detached element rejection after removal
      topRightLink.element.remove();
      const detachedRes = wm.resolveAndValidateCandidate(topRightLink.id, 'tab_u2', { expectedNavigationIdentity: inv.navigationIdentity });
      assert.strictEqual(detachedRes.ok, false, 'Detached element must be rejected when not re-acquirable');

      const blocker = dom.makeNode('div', { id: 'real-blocker' });
      document.elementsFromPoint = () => [blocker];
      const obscured = wm._inspectElementSpatialAndAria(elements.regionInput, document);
      assert.strictEqual(obscured.covered, true, 'A different topmost element in the target root must remain classified as covered');
      document.elementsFromPoint = () => [document.body];

      const routeOne = wm.getTabInventory('tab_u2');
      document.location.href = 'https://shop.example.org/spa/route-two';
      window.location.href = document.location.href;
      const routeTwo = await wm.buildPageWorldModel(document, { tabId: 'tab_u2', force: true });
      assert.ok(routeTwo.navigationGeneration > routeOne.navigationGeneration, 'SPA route navigation generation must increase monotonically');
      assert.notStrictEqual(routeTwo.navigationIdentity, routeOne.navigationIdentity, 'SPA route must receive a distinct candidate identity');
      const staleSpaCandidate = wm.resolveAndValidateCandidate(topRightLink.id, 'tab_u2', { expectedNavigationIdentity: routeOne.navigationIdentity });
      assert.strictEqual(staleSpaCandidate.ok, false, 'Candidate from SPA route one must be rejected on route two');

      const beforeDomReplacement = routeTwo;
      const oldShadowCandidate = beforeDomReplacement.buttons.find((button) => /shadow checkout/i.test(button.label));
      const shadowRoot = elements.shadowButton.getRootNode();
      elements.shadowButton.remove();
      shadowRoot.appendChild(dom.makeNode('button', { id: 'sh-btn-replacement', attrs: { type: 'button' }, text: 'Shadow Checkout' }));
      const afterDomReplacement = await wm.buildPageWorldModel(document, { tabId: 'tab_u2', force: true });
      assert.ok(afterDomReplacement.navigationGeneration > beforeDomReplacement.navigationGeneration, 'Same-URL DOM re-observation must advance candidate generation');
      const staleDomCandidate = wm.resolveAndValidateCandidate(oldShadowCandidate.id, 'tab_u2', { expectedNavigationIdentity: beforeDomReplacement.navigationIdentity });
      assert.strictEqual(staleDomCandidate.ok, false, 'Candidate from before same-URL DOM replacement/re-observation must be rejected');

      const otherTab = await wm.buildPageWorldModel(document, { tabId: 'tab_other', force: true });
      const crossTabCandidate = wm.resolveAndValidateCandidate('L001', 'tab_other', { expectedNavigationIdentity: afterDomReplacement.navigationIdentity });
      assert.strictEqual(crossTabCandidate.ok, false, 'Candidate identity from one tab must not validate in another tab');
      assert.notStrictEqual(otherTab.navigationIdentity, afterDomReplacement.navigationIdentity, 'Tabs must have isolated candidate identities');
    } finally {
      global.window = prevWin;
      global.document = prevDoc;
    }
  });

  // Suite U3: Numbered non-occluding candidate overlay + contextual follow-up resolution + cleanup
  await runSuite('U3. Candidate Overlay (Numbered, pointer-events:none, Escape/Clear) + Dialogue Follow-Up ("one under Appearance")', async () => {
    const dom = createMockDomEnv('https://shop.example.org/item');
    const { window, document, makeNode } = dom;
    const pSmall = makeNode('label', { id: 'p-small-lbl', text: 'Small', rect: { left: 300, top: 200, right: 360, bottom: 222, width: 60, height: 22 } });
    const aSmall = makeNode('label', { id: 'a-small-lbl', text: 'Small', rect: { left: 300, top: 420, right: 360, bottom: 442, width: 60, height: 22 } });
    document.body.appendChild(pSmall);
    document.body.appendChild(aSmall);

    const prevKbd = global.KeyboardEvent;
    global.KeyboardEvent = window.KeyboardEvent;
    try {
      const overlay = new navEngine.SleepwalkerCandidateOverlay({ doc: document, win: window });
      const badges = overlay.showCandidates([
        { label: 'Product Size — Small', element: pSmall },
        { label: 'Appearance — Small', element: aSmall }
      ], { doc: document, win: window });
      assert.strictEqual(badges.length, 2, 'Must render 2 numbered badges');
      assert.strictEqual(document.querySelectorAll('.sw-candidate-badge').length, 2);
      const rootEl = document.getElementById('sleepwalker-candidate-overlay-root');
      assert.ok(rootEl, 'Overlay root must exist');
      assert.strictEqual(rootEl.style.pointerEvents, 'none', 'Overlay root must never intercept clicks');
      const b1Left = parseInt(badges[0].badge.style.left, 10);
      assert.ok(b1Left < 300, `Badge must be offset beside (not over) candidate text, got left=${b1Left}`);

      // Escape clears overlay + restores outlines
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.strictEqual(document.querySelectorAll('.sw-candidate-badge').length, 0, 'Escape must clear badges');
      assert.strictEqual(pSmall.style.outline, '', 'Original outline must be restored');

      // Dialogue choice prompt: contextual follow-up resolves correct parent & triggers onClear
      const prevWinG = global.window;
      global.window = {};
      loadGlobalScript(path.join(ROOT, 'dialogue.js'), {});
      const DialogueCtor = global.window.SleepwalkerDialogue;
      global.window = prevWinG;
      const dlg = new DialogueCtor();
      overlay.showCandidates([{ label: 'A', element: pSmall }, { label: 'B', element: aSmall }], { doc: document, win: window });
      let pickedIdx = -1;
      let cleared = false;
      const opts = ['Product Size — Small', 'Appearance — Small'];
      dlg.setPendingPrompt({
        kind: 'choice',
        label: 'element_selection_clarification',
        askedText: 'Which Small?',
        options: opts,
        onClear: () => { cleared = true; overlay.clear({ doc: document }); },
        onAnswer: async (_p, info) => { pickedIdx = info.index; return { status: 'ok' }; }
      });
      const m1 = dlg._matchChoiceOption('one under appearance', 'one under Appearance', opts);
      assert.strictEqual(m1 && m1.index, 1, '"one under Appearance" must resolve to option #2');
      const m2 = dlg._matchChoiceOption('the product size', 'the product size', opts);
      assert.strictEqual(m2 && m2.index, 0, '"the product size" must resolve to option #1');
      const m3 = dlg._matchChoiceOption('first', 'first', opts);
      assert.strictEqual(m3 && m3.index, 0, '"first" must resolve to option #1');
      const m4 = dlg._matchChoiceOption('2', '2', opts);
      assert.strictEqual(m4 && m4.index, 1, '"2" must resolve to option #2');
      // Replacing the pending prompt must fire onClear (badges removed)
      dlg.setPendingPrompt(null);
      assert.strictEqual(cleared, true, 'onClear must fire when prompt is cleared/replaced');
      assert.strictEqual(document.querySelectorAll('.sw-candidate-badge').length, 0, 'Badges must be cleared after resolution');
      assert.strictEqual(pickedIdx, -1);
    } finally {
      global.KeyboardEvent = prevKbd;
    }
  });

  // Suite U4: Action Verifier & Animation Noise Filtering WaitManager
  await runSuite('U4. WaitManager Animation-Noise Filter & Strict Post-Action Verifier', async () => {
    const dom = createMockDomEnv('https://shop.example.org/item');
    const { window, document, makeNode } = dom;
    const swUi = makeNode('div', { id: 'sleepwalker-floating-ui', attrs: { 'data-sleepwalker-ui': '1' } });
    const ripple = makeNode('div', { id: 'ripple', className: 'ripple-start' });
    const deadBtn = makeNode('button', { id: 'dead-btn', text: 'No-Op Button' });
    const realBtn = makeNode('button', { id: 'real-btn', text: 'Open Panel' });
    const panel = makeNode('div', { id: 'panel', hidden: true, text: 'Details' });
    [swUi, ripple, deadBtn, realBtn, panel].forEach((n) => document.body.appendChild(n));

    const wm = new navEngine.SleepwalkerWaitManager({ doc: document, win: window });
    const verifier = new navEngine.SleepwalkerActionVerifier();

    // 1. CSS animation class change & Sleepwalker UI mutations must be filtered as noise
    const harvest = wm.startMutationHarvest(document.body, { doc: document });
    swUi.setAttribute('data-state', 'listening');
    ripple.className = 'ripple-fade animate';
    await wm.waitForDOMSettled({ doc: document, timeoutMs: 220, quietMs: 40 });
    const noisyStats = harvest.stop();
    assert.strictEqual(noisyStats.meaningfulMutations, 0, `CSS animation/Sleepwalker UI mutations must be ignored as noise (got ${noisyStats.meaningfulMutations})`);
    assert.ok(noisyStats.filteredNoise >= 2, `Noise mutations must be counted as filtered (got ${noisyStats.filteredNoise})`);

    // 2. Dead no-op button MUST FAIL verification
    const b1 = verifier.captureState(document, deadBtn, { win: window });
    deadBtn.click();
    const a1 = verifier.captureState(document, deadBtn, { win: window });
    const verDead = verifier.verify('click_button', b1, a1, { meaningfulMutations: 0 });
    assert.strictEqual(verDead.verified, false, 'No-op button click must NOT falsely verify as success');

    // 3. Real state-changing button MUST PASS verification
    const harvest2 = wm.startMutationHarvest(document.body, { doc: document });
    const b2 = verifier.captureState(document, realBtn, { win: window });
    realBtn.setAttribute('aria-expanded', 'true');
    panel.setAttribute('hidden', 'false');
    await wm.waitForDOMSettled({ doc: document, timeoutMs: 250, quietMs: 40 });
    const stats2 = harvest2.stop();
    const a2 = verifier.captureState(document, realBtn, { win: window });
    const verReal = verifier.verify('click_button', b2, a2, stats2);
    assert.strictEqual(verReal.verified, true, 'Real aria-expanded/panel state change must pass verification');
    assert.strictEqual(verReal.changeReport.expandedChanged, true);

    // 4. Scroll verification: unchanged scroll must fail, moved scroll must pass
    const sB = { scrollY: 0, scrollX: 0, viewportHeight: 768, scrollHeight: 3000 };
    assert.strictEqual(verifier.verify('scroll', sB, { ...sB }, null, { dir: 'down' }).verified, false, 'Unchanged scroll must fail');
    assert.strictEqual(verifier.verify('scroll', sB, { ...sB, scrollY: 576 }, null, { dir: 'down' }).verified, true, 'Moved scroll must pass');
  });

  // Suite U5: Agent FSM Turn Isolation & Conditional Visual Grounding Contract
  await runSuite('U5. Agent State Machine Turn Isolation + Conditional Visual Fallback Parsing & Privacy', async () => {
    const fsm = new navEngine.SleepwalkerAgentStateMachine();
    const t1 = fsm.beginTurn({ tabId: 'tab_1', command: 'Click Pricing', inventoryVersion: 3 });
    fsm.transition('CLASSIFYING', { requestId: t1.requestId });
    fsm.transition('OBSERVING', { requestId: t1.requestId });

    // Rapid second voice command supersedes t1 immediately
    const t2 = fsm.beginTurn({ tabId: 'tab_1', command: 'Scroll down', inventoryVersion: 4 });
    assert.strictEqual(t1.superseded, true, 'Previous turn must be marked superseded when newer command arrives');
    assert.strictEqual(t1.signal.aborted, true, 'Previous turn AbortController must abort automatically');
    assert.strictEqual(fsm.assertTurnCurrent(t1.requestId).ok, false, 'Stale turn assertTurnCurrent must reject');
    assert.strictEqual(fsm.assertTurnCurrent(t2.requestId, { tabId: 'tab_1', requireInventoryVersion: 4 }).ok, true);
    assert.strictEqual(fsm.assertTurnCurrent(t2.requestId, { tabId: 'tab_2' }).ok, false, 'Cross-tab assertion must reject');

    fsm.recordStageTiming(t2.requestId, 'routing', 4);
    fsm.recordStageTiming(t2.requestId, 'execution', 7);
    const doneMetrics = fsm.finishTurn(t2.requestId, 'IDLE', { status: 'fast_scrolled' });
    assert.strictEqual(doneMetrics.routingMs, 4);
    assert.strictEqual(doneMetrics.executionMs, 7);

    // Visual grounding parser + Local-Only privacy check
    const parsedVis = llmMod.parseVisualGroundJson('```json\n{"target_label":"Shielded Action","candidate_id":"B004","quadrant":"center-left","normalized_x":240,"normalized_y":510,"action":"click","confidence":0.91,"explanation":"Blue action button"}\n```');
    assert.ok(parsedVis && parsedVis.target_label === 'Shielded Action' && parsedVis.normalized_x === 240 && parsedVis.candidate_id === 'B004');

    const localBlocked = await llmMod.handleVisualGroundRequest({
      query: 'Click Settings icon',
      imageBase64: 'data:image/png;base64,iVBORw0KGgo=',
      localOnly: true
    });
    assert.strictEqual(localBlocked.usedVision, false);
    assert.strictEqual(localBlocked.status, 'vision_unavailable_local_only');
  });
}

async function runTier2RealChromeTests() {
  const chromiumExe = findChromiumExe();
  if (!chromiumExe) {
    throw new Error('Chromium executable not found for Real Chrome MV3 E2E suite');
  }

  const { server, port } = await startPhase44FixtureServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-p44-ext-'));
  const cdpPort = 9820 + Math.floor(Math.random() * 140);

  const chrome = spawn(chromiumExe, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--headless=new',
    '--no-sandbox',
    '--window-size=1280,820',
    '--no-first-run',
    '--no-default-browser-check',
    `${baseUrl}/nav-main`
  ], { stdio: 'ignore' });

  const sockets = [];
  const connectTarget = async (t) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    sockets.push(ws);
    const exceptions = [];
    const executionContexts = new Map();
    let cid = 0;
    ws.addEventListener('message', async (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') {
          const context = msg.params.context;
          executionContexts.set(context.id, { name: context.name || '', auxData: context.auxData || {} });
        } else if (msg.method === 'Runtime.executionContextDestroyed') {
          executionContexts.delete(msg.params.executionContextId);
        } else if (msg.method === 'Runtime.executionContextsCleared') {
          executionContexts.clear();
        } else if (msg.method === 'Runtime.exceptionThrown') {
          exceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || JSON.stringify(msg.params));
        }
      } catch (_e) {}
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++cid;
      const onMsg = async (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        const msg = JSON.parse(raw);
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (body, contextId) => {
      const params = { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true };
      if (contextId !== undefined && contextId !== null) params.contextId = contextId;
      const res = await send('Runtime.evaluate', params);
      if (res && res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
      return res && res.result ? res.result.value : undefined;
    };
    const cdp = {
      ws,
      send,
      executionContexts,
      evalContextId: null,
      evalJs(body) { return evaluate(body, this.evalContextId); },
      evalMainJs(body) { return evaluate(body, null); },
      exceptions
    };
    return cdp;
  };

  try {
    let pageTarget = null;
    let swTarget = null;
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline && (!pageTarget || !swTarget)) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
        if (!pageTarget) pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('/nav-main'));
        if (!swTarget) {
          for (const cand of targets.filter((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'))) {
            try {
              const probe = await connectTarget(cand);
              const mf = await probe.evalJs(`return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : '';`).catch(() => '');
              try { probe.ws.close(); } catch (_e) {}
              if (String(mf).includes('Sleepwalker')) { swTarget = cand; break; }
            } catch (_e) {}
          }
        }
      } catch (_e) {}
    }
    assert.ok(pageTarget && swTarget, 'Real Chrome MV3 page and Sleepwalker SW must attach');

    const pageCdp = await connectTarget(pageTarget);
    const swCdp = await connectTarget(swTarget);
    await pageCdp.send('Runtime.enable');
    await swCdp.send('Runtime.enable');

    // Wait for Sleepwalker content script bootstrap & set highlightDurationMs = 40ms + disable Ollama long wait during fixture speed tests
    const waitReady = async (cdp = pageCdp) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        for (const [contextId, context] of cdp.executionContexts) {
          if (context.auxData.type !== 'isolated') continue;
          const extensionReady = await (async () => {
            const res = await cdp.send('Runtime.evaluate', {
              expression: `Boolean(window.__SLEEPWALKER_INSTANCE__ && typeof window.__SW_SAY__ === 'function')`,
              contextId,
              returnByValue: true
            }).catch(() => null);
            return Boolean(res && res.result && res.result.value);
          })();
          if (extensionReady) {
            cdp.evalContextId = contextId;
            await cdp.evalJs(`
            const c = window.__SLEEPWALKER_INSTANCE__;
            if (c.navigator) c.navigator.highlightDurationMs = 30;
          `);
            return true;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('Sleepwalker content script did not initialize within timeout');
    };
    await waitReady(pageCdp);

    // TEST A1: Deterministic scroll must complete and verify before returning.
    await runSuite('Test A1. Real Chrome Fast-Path Scroll Completion', async () => {
      const scrollRes = await pageCdp.evalJs(`
        window.scrollTo(0, 0);
        const y0 = window.scrollY;
        const r = await window.__SW_SAY__('Scroll down', { isVoice: true });
        await new Promise(res => setTimeout(res, 120));
        return { r, y0, metrics: window.__SLEEPWALKER_INSTANCE__.getNavigationMetrics() };
      `);
      scrollRes.y1 = await pageCdp.evalMainJs(`return window.scrollY;`);
      assert.strictEqual(scrollRes.r.status, 'fast_scrolled');
      assert.strictEqual(scrollRes.r.usedLlm, false);
      assert.ok(scrollRes.y1 > scrollRes.y0, `Scroll down must advance window.scrollY (was ${scrollRes.y0}, now ${scrollRes.y1})`);

      await pageCdp.evalJs(`await window.__SW_SAY__('Go to top');`);
      await pageCdp.evalJs(`await window.__SW_SAY__('Press Escape');`);
    });

    // TEST A2: Multi-tab Fast-Path via SW chrome.tabs APIs.
    await runSuite('Test A2. Real Chrome Tab New/Switch/Close Fast Path', async () => {
      // Open second tab -> Switch back by title -> Close second tab!
      const newTabRes = await pageCdp.evalJs(`
        return await window.__SW_SAY__('Open ${baseUrl}/tab-second in new tab');
      `);
      console.log(`      tab_new response: ${JSON.stringify(newTabRes)}`);
      assert.strictEqual(newTabRes.ok, true, `Expected new tab to open cleanly, got ${JSON.stringify(newTabRes)}`);
      await new Promise((r) => setTimeout(r, 500));

      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      const tab2Target = targets.find((t) => t.type === 'page' && t.url.includes('/tab-second'));
      assert.ok(tab2Target, 'Second tab must actually exist in Chromium targets');
      console.log(`      tab target ready: ${tab2Target.url}`);
      const tab2Cdp = await connectTarget(tab2Target);
      await tab2Cdp.send('Runtime.enable');
      await waitReady(tab2Cdp);
      console.log('      second-tab content script ready');

      // Register tab metadata explicitly via SET_ACTIVE_TAB & test tab_switch back to Banking & Cards Guide
      const switchRes = await tab2Cdp.evalJs(`
        return await window.__SW_SAY__('Switch to Banking & Cards Guide tab');
      `);
      console.log(`      tab_switch response: ${JSON.stringify(switchRes)}`);
      assert.strictEqual(switchRes.ok, true, `Switch tab by title must succeed: ${JSON.stringify(switchRes)}`);
      assert.ok(String(switchRes.title || '').includes('Banking'), `Must switch to Banking tab, got ${switchRes.title}`);

      // Cleanly close second tab via SW fast path
      const closeRes = await tab2Cdp.evalJs(`return await window.__SW_SAY__('Close current tab');`);
      console.log(`      tab_close response: ${JSON.stringify(closeRes)}`);
      assert.strictEqual(closeRes.ok, true, 'Close current tab must succeed');
      await new Promise((r) => setTimeout(r, 250));
      const afterCloseTargets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      assert.ok(!afterCloseTargets.some((target) => target.id === tab2Target.id), 'Closed tab must be absent from Chromium targets');
    });

    // TEST D & Section Topic Scroll: "Scroll to the section discussing banking regulations" + "Go to second article in Latest Articles"
    await runSuite('Test D. Section Jump & Contextual Topic Scroll ("section discussing banking regulations" -> in viewport)', async () => {
      const secRes = await pageCdp.evalJs(`
        window.scrollTo(0, 0);
        const r = await window.__SW_SAY__('Scroll to the section discussing banking regulations');
        await new Promise(res => setTimeout(res, 150));
        const pRect = document.getElementById('p-banking-reg').getBoundingClientRect();
        return { r, pTop: pRect.top, pBottom: pRect.bottom, vh: window.innerHeight };
      `);
      secRes.scrollY = await pageCdp.evalMainJs(`return window.scrollY;`);
      assert.ok(secRes.scrollY > 400, `Expected page to scroll down to banking regulations section, got ${JSON.stringify(secRes)}`);
      assert.ok(secRes.pTop < secRes.vh && secRes.pBottom > 0, `Target banking regulations paragraph must enter viewport (top=${secRes.pTop}, bottom=${secRes.pBottom})`);

      // Previous section check ("Go to Summary Notes section" -> "Go back to the previous section")
      await pageCdp.evalJs(`await window.__SW_SAY__('Go to Summary Notes section');`);
      const prevRes = await pageCdp.evalJs(`return await window.__SW_SAY__('Go back to the previous section');`);
      assert.ok(prevRes && prevRes.verified, `Returning to previous section must verify cleanly: ${JSON.stringify(prevRes)}`);
    });

    // TEST C: Option Selection (Dark under Color + Ambiguous "Choose Small" + Follow-up) & Custom Lazy Dropdown
    await runSuite('Test C. Hierarchic Option Selection (Dark under Color, Ambiguous Small + Badge Overlay, Custom Lazy Dropdown)', async () => {
      const darkRes = await pageCdp.evalJs(`
        const r = await window.__SW_SAY__('Select Dark under Color');
        return { r, darkChecked: document.getElementById('opt-color-dark').checked, lightChecked: document.getElementById('opt-color-light').checked };
      `);
      assert.strictEqual(darkRes.darkChecked, true, 'Dark radio under Color must become checked');
      assert.strictEqual(darkRes.lightChecked, false, 'Light radio must become unchecked');

      // Ambiguous "Choose Small" -> badge overlay + "one under Appearance" -> clears badges & selects Appearance > Small!
      const ambRes = await pageCdp.evalJs(`
        const es = window.__SLEEPWALKER_INSTANCE__.elementSelector;
        const r1 = await es.handleCommand('Choose Small', { doc: document });
        const badgeCountDuring = document.querySelectorAll('.sw-candidate-badge').length;
        const r2 = await window.__SW_SAY__('one under Appearance');
        const badgeCountAfter = document.querySelectorAll('.sw-candidate-badge').length;
        return {
          r1Status: r1.status,
          badgeCountDuring,
          r2Status: r2 && r2.status,
          badgeCountAfter,
          appSmall: document.getElementById('opt-app-small').checked,
          prodSmall: document.getElementById('opt-prod-small').checked
        };
      `);
      assert.strictEqual(ambRes.r1Status, 'needs_clarification');
      assert.strictEqual(ambRes.badgeCountDuring, 2, 'Two numbered non-occluding badges must be visible during disambiguation');
      assert.strictEqual(ambRes.appSmall, true, 'Follow-up "one under Appearance" must check Appearance > Small');
      assert.strictEqual(ambRes.prodSmall, false, 'Product Size > Small must stay unchecked');
      assert.strictEqual(ambRes.badgeCountAfter, 0, 'Temporary candidate badges must clean up completely after resolution');

      // Delayed custom dropdown selection ("Select India from Country Selector")
      const ddRes = await pageCdp.evalJs(`
        const es = window.__SLEEPWALKER_INSTANCE__.elementSelector;
        const r = await es.handleCommand('Select India under Country Selector', { doc: document });
        return { r, selected: document.getElementById('btn-country-dd').getAttribute('data-selected'), text: document.getElementById('btn-country-dd').textContent };
      `);
      assert.strictEqual(ddRes.r.verified, true, `Custom delayed dropdown selection must succeed: ${JSON.stringify(ddRes)}`);
      assert.strictEqual(ddRes.selected, 'in', 'Country dropdown data-selected must be India (in)');
    });

    // TEST F: Delayed DOM Appearance, Covered Overlay Obstruction Recovery, Modal Dismissal, SPA PushState
    await runSuite('Test F & B. Delayed DOM, Covered Modal/Overlay Dismissal Recovery & SPA Navigation', async () => {
      // Trigger delayed button injection ("Apply Online Now" appears 150ms after button click)
      const dynRes = await pageCdp.evalJs(`
        document.getElementById('btn-load-delayed').click();
        const wmWait = window.__SLEEPWALKER_INSTANCE__.waitManager;
        const btn = await wmWait.waitForElement((d) => d.getElementById('btn-dynamic-apply'), { doc: document, timeoutMs: 1200 });
        if (!btn) return { found: false, injected: Boolean(document.getElementById('btn-dynamic-apply')), zoneHtml: document.getElementById('delayed-zone').innerHTML };
        const res = await window.__SW_SAY__('Click Apply Online Now');
        return { found: true, res, appliedAttr: document.getElementById('delayed-zone').getAttribute('data-applied') };
      `);
      dynRes.clicks = await pageCdp.evalMainJs(`return window.__delayedClicked;`);
      assert.strictEqual(dynRes.found, true, `WaitManager must resolve dynamically injected button: ${JSON.stringify(dynRes)}`);
      assert.strictEqual(dynRes.clicks >= 1, true, `Delayed button must actually be clicked; response=${JSON.stringify(dynRes)}`);

      // Obscured target button ("Shielded Action" covered by dialog with Close button): Sleepwalker navigator dismisses obstruction cleanly!
      const shieldRes = await pageCdp.evalJs(`
        document.getElementById('btn-shielded').scrollIntoView({ block: 'center' });
        const nav = window.__SLEEPWALKER_INSTANCE__.navigator;
        const targetEl = document.getElementById('btn-shielded');
        await nav._performClickWithHighlight({ label: 'Shielded Action', element: targetEl }, Date.now(), { verifyEffect: true });
        return { overlayGone: !document.getElementById('shield-overlay') };
      `);
      shieldRes.clicks = await pageCdp.evalMainJs(`return window.__clickedShielded;`);
      assert.strictEqual(shieldRes.overlayGone, true, 'Covering shield dialog must be dismissed cleanly');

      // Navigate to /nav-main link -> /cards/bank ("Select Bank card under Cards")
      // Do not await the content-script command in the old document's CDP
      // execution context: a successful full navigation destroys that context
      // before Runtime.evaluate can return its promise value.
      await pageCdp.evalJs(`window.__bankSelectPromise = window.__SW_SAY__('Select Bank card under Cards'); return true;`);
      let bankSelectRes = null;
      try {
        bankSelectRes = await pageCdp.evalJs(`return await window.__bankSelectPromise;`);
      } catch (err) {
        if (!/Inspected target navigated or closed|Execution context was destroyed/i.test(String(err && err.message))) throw err;
        bankSelectRes = { navigationInterruptedEvaluation: true };
      }
      let curMain = null;
      const bankNavDeadline = Date.now() + 5000;
      while (Date.now() < bankNavDeadline) {
        const postBankTargets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
        curMain = postBankTargets.find((t) => t.id === pageTarget.id) || postBankTargets.find((t) => t.type === 'page');
        if (curMain && curMain.url.includes('/cards/bank')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(curMain && curMain.url.includes('/cards/bank'), `Scoped link click must navigate cleanly to /cards/bank, result=${JSON.stringify(bankSelectRes)}, got ${curMain && curMain.url}`);

      // Navigate to SPA page and test SPA pushState URL + dynamic DOM change
      await pageCdp.send('Page.navigate', { url: `${baseUrl}/spa` });
      await new Promise((r) => setTimeout(r, 800));
      await waitReady(pageCdp);

      const spaRes = await pageCdp.evalJs(`
        const wmWait = window.__SLEEPWALKER_INSTANCE__.waitManager;
        const verifier = window.__SLEEPWALKER_INSTANCE__.actionVerifier;
        const b = verifier.captureState(document, document.getElementById('spa-link-pricing'));
        const navPromise = wmWait.waitForNavigation({ urlBefore: window.location.href, doc: document, win: window, timeoutMs: 1200 });
        document.getElementById('spa-link-pricing').click();
        const navWaitRes = await navPromise;
        const a = verifier.captureState(document);
        return { navWaitRes, urlNow: window.location.href, headingNow: document.getElementById('spa-heading').textContent };
      `);
      assert.strictEqual(spaRes.navWaitRes.urlChanged, true, 'WaitManager must detect SPA pushState navigation');
      assert.ok(spaRes.urlNow.includes('/spa/pricing'), `SPA URL must update to /spa/pricing, got ${spaRes.urlNow}`);
      assert.strictEqual(spaRes.headingNow, 'SPA Pricing View', 'SPA settle must wait for delayed view render');
    });

    // TEST E: YouTube Progressive Feed (Batch 1 -> Batch 2), Ordinal 5th/15th, Title Match & Watch No-Captions Honesty
    await runSuite('Test E. Progressive Feed (5th, 15th, Title, Batch Stability) & Watch Honesty', async () => {
      await pageCdp.send('Page.navigate', { url: `${baseUrl}/yt-feed` });
      await new Promise((r) => setTimeout(r, 800));
      await waitReady(pageCdp);

      const ytRes = await pageCdp.evalJs(`
        const wm = window.__SLEEPWALKER_INSTANCE__.worldModel;
        const b1 = await wm.observeTab(document, { force: true });
        const b1Count = b1.videos.length;
        const v5 = b1.videos[4] ? b1.videos[4].title : '';
        const b2 = await wm.discoverMoreCandidates({ doc: document });
        const b2Videos = b2 && b2.inventory ? b2.inventory.videos : [];
        const b2Count = b2Videos.length;
        const v15 = b2Videos[14] ? b2Videos[14].title : '';
        return { b1Count, v5, b2Count, v15 };
      `);
      assert.strictEqual(ytRes.b1Count, 10, `Batch 1 must cap at 10 videos cleanly, got ${ytRes.b1Count}`);
      assert.ok(/Gradient Descent Visually Explained/i.test(ytRes.v5), `5th video must match Gradient Descent, got ${ytRes.v5}`);
      assert.strictEqual(ytRes.b2Count, 15, `Batch 2 progressive expand must reach 15 videos, got ${ytRes.b2Count}`);
      assert.ok(/Transformers and Attention Architecture/i.test(ytRes.v15), `15th video must match Transformers, got ${ytRes.v15}`);

      // Watch page without captions must NEVER fabricate speech
      await pageCdp.send('Page.navigate', { url: `${baseUrl}/watch` });
      await new Promise((r) => setTimeout(r, 800));
      await waitReady(pageCdp);
      const watchRes = await pageCdp.evalJs(`
        return await window.__SW_SAY__('Explain what the speaker is teaching');
      `);
      assert.strictEqual(watchRes.captionsAvailable, false);
      assert.ok(/captions|transcript/i.test(watchRes.answer || ''), 'Watch honesty must state captions are unavailable');
    });

    assert.strictEqual(pageCdp.exceptions.length, 0, `Zero Runtime exceptions allowed on page; got ${pageCdp.exceptions.join(' | ')}`);
    assert.strictEqual(swCdp.exceptions.length, 0, `Zero Runtime exceptions allowed in SW; got ${swCdp.exceptions.join(' | ')}`);
  } finally {
    for (const ws of sockets) {
      try { ws.close(); } catch (_e) {}
    }
    try { chrome.kill('SIGKILL'); } catch (_e) {}
    try { server.close(); } catch (_e) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
  }
}

async function runLivePublicWebValidation() {
  const chromiumExe = findChromiumExe();
  if (!chromiumExe) throw new Error('Chromium executable required for --live-web');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-p44-live-'));
  const cdpPort = 9920 + Math.floor(Math.random() * 80);
  const chrome = spawn(chromiumExe, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--headless=new',
    '--no-sandbox',
    '--window-size=1280,820',
    '--no-first-run',
    '--no-default-browser-check',
    'https://en.wikipedia.org/wiki/Credit_card'
  ], { stdio: 'ignore' });

  const sockets = [];
  const connectTarget = async (t) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    sockets.push(ws);
    const executionContexts = new Map();
    ws.addEventListener('message', async (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') {
          const context = msg.params.context;
          executionContexts.set(context.id, { name: context.name || '', auxData: context.auxData || {} });
        } else if (msg.method === 'Runtime.executionContextDestroyed') {
          executionContexts.delete(msg.params.executionContextId);
        } else if (msg.method === 'Runtime.executionContextsCleared') {
          executionContexts.clear();
        }
      } catch (_e) {}
    });
    let cid = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++cid;
      const onMsg = async (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        const msg = JSON.parse(raw);
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJs = async (body) => {
      const params = { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true };
      if (evalJs.contextId !== undefined && evalJs.contextId !== null) params.contextId = evalJs.contextId;
      const res = await send('Runtime.evaluate', params);
      if (res && res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
      return res && res.result ? res.result.value : undefined;
    };
    return { ws, send, evalJs, executionContexts };
  };

  try {
    let pageTarget = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !pageTarget) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
        pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('wikipedia.org'));
      } catch (_e) {}
    }
    assert.ok(pageTarget, 'Live Wikipedia page target must attach');
    const cdp = await connectTarget(pageTarget);
    await cdp.send('Runtime.enable');
    const waitReady = async () => {
      const end = Date.now() + 12000;
      while (Date.now() < end) {
        for (const [contextId, context] of cdp.executionContexts) {
          if (context.auxData.type !== 'isolated') continue;
          const response = await cdp.send('Runtime.evaluate', {
            expression: `Boolean(window.__SLEEPWALKER_INSTANCE__ && typeof window.__SW_SAY__ === 'function')`,
            contextId,
            returnByValue: true
          }).catch(() => null);
          if (response && response.result && response.result.value) {
            cdp.evalJs.contextId = contextId;
          await cdp.evalJs(`if (window.__SLEEPWALKER_INSTANCE__.navigator) window.__SLEEPWALKER_INSTANCE__.navigator.highlightDurationMs = 40;`);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('Sleepwalker did not attach on Wikipedia');
    };
    await waitReady();

    await runSuite('Live Public Web 1: en.wikipedia.org/wiki/Credit_card (Observation, Fast Scroll, Section Jump, Dark Radio)', async () => {
      const res = await cdp.evalJs(`
        const c = window.__SLEEPWALKER_INSTANCE__;
        const tObs0 = performance.now();
        const inv = await c.worldModel.observeTab(document, { force: true });
        const obsMs = Math.round(performance.now() - tObs0);

        const rFast = await window.__SW_SAY__('Scroll down');
        const mFast = c.getNavigationMetrics();
        const rSec = await window.__SW_SAY__('Go to History section');
        const darkRes = await c.elementSelector.handleCommand('Select Dark under Color', { doc: document });
        return {
          title: document.title,
          linksCount: inv.links.length,
          sectionsCount: inv.sections.length,
          optionsCount: inv.options.length,
          obsMs,
          fastStatus: rFast.status,
          fastMetrics: mFast,
          secStatus: rSec && rSec.status,
          darkStatus: darkRes && darkRes.status,
          darkVerified: darkRes && darkRes.verified
        };
      `);
      console.log('      [Live Wikipedia Telemetry]', JSON.stringify(res));
      assert.ok(res.linksCount > 50 && res.sectionsCount >= 4, 'Wikipedia Credit card must extract real links and sections');
      assert.strictEqual(res.fastStatus, 'fast_scrolled');
      assert.strictEqual(res.fastMetrics.usedLlm, undefined); // fastMetrics keys: routingMs, executionMs, etc.
      assert.ok(res.secStatus === 'moved', `Expected section jump moved, got ${res.secStatus}`);
    });

    await runSuite('Live Public Web 2: youtube.com/results?search_query=neural+networks (Feed Observation + Fast Scroll)', async () => {
      await cdp.send('Page.navigate', { url: 'https://www.youtube.com/results?search_query=neural+networks' });
      await new Promise((r) => setTimeout(r, 4500));
      await waitReady();
      const ytLive = await cdp.evalJs(`
        const c = window.__SLEEPWALKER_INSTANCE__;
        const t0 = performance.now();
        const inv = await c.worldModel.observeTab(document, { force: true });
        const obsMs = Math.round(performance.now() - t0);
        const fast = await window.__SW_SAY__('Scroll down');
        return {
          url: window.location.href,
          mode: inv.discoveryMode,
          videoCount: inv.videos.length,
          firstTitle: inv.videos[0] && inv.videos[0].title,
          obsMs,
          fastStatus: fast.status
        };
      `);
      console.log('      [Live YouTube Telemetry]', JSON.stringify(ytLive));
      assert.strictEqual(ytLive.fastStatus, 'fast_scrolled');
      assert.strictEqual(ytLive.mode, 'progressive_feed');
      assert.ok(ytLive.videoCount >= 1, `Expected real YouTube feed videos discovered on results page, got ${ytLive.videoCount}`);
    });
  } finally {
    for (const ws of sockets) {
      try { ws.close(); } catch (_e) {}
    }
    try { chrome.kill('SIGKILL'); } catch (_e) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
  }
}

(async function main() {
  const args = process.argv.slice(2);
  const unitOnly = args.includes('--unit-only');
  const liveWeb = args.includes('--live-web');

  console.log('=== Sleepwalker Phase 4.4 — Advanced Browser Navigation Engine Test Suite ===');
  await runTier1UnitSuites();

  if (!unitOnly) {
    await runTier2RealChromeTests();
  }
  if (liveWeb) {
    await runLivePublicWebValidation();
  }

  console.log(`\nPhase 4.4 Summary: ${passedSuites.length} passed, ${failedSuites.length} failed.`);
  if (failedSuites.length > 0) process.exit(1);
})();
