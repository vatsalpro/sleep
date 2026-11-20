/**
 * Sleepwalker Phase 4.3 — Hybrid Browser World Model Test Suite
 *
 * Tier 1: Node Unit & Integration Tests + Live Local Ollama (`llama3.2:3b` & `nomic-embed-text`)
 *   - WM1: Unified IDs, Hierarchical Parent-Child Relationships & Entity-Relationship Graph
 *   - WM2: 3-Mode Adaptive Discovery (static_content, progressive_feed Batch 1->2 ID stability, dynamic_app)
 *   - WM3: Semantic Page Retrieval (nomic-embed-text + concept fallback) & Strict <=820 Token Context
 *   - WM4: Strict NLU Validation (Cross-Tab rejection, Stale inventoryVersion, Element-Type mismatch, Unsafe selectors)
 *   - WM5: Live Ollama World Model Reasoning, Conversation Memory (previousSection / similarTo) & Dev Diagnostics Redaction
 *
 * Tier 2: Real Loaded Unpacked MV3 Chrome Extension (`--load-extension=D:\sleep`) via CDP
 *   - Tests A–J against realistic local HTTP fixtures (Wikipedia + Appearance Panel, Infinite-Scroll YouTube Feed,
 *     YouTube Watch Captions / No-Captions, Semantic Section Jump, Multi-Tab Isolation, Options Dev Trace Viewer)
 *
 * Run with: node D:\sleep\tests\run-phase4-3-world-model-tests.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const wmMod = require(path.join(ROOT, 'world-model.js'));
const llm = require(path.join(ROOT, 'llm.js'));
const SleepwalkerMemory = require(path.join(ROOT, 'memory.js'));
const SleepwalkerDiagnostics = require(path.join(ROOT, 'diagnostics.js'));

let passed = 0;
let failed = 0;

async function runSuite(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL  ${name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
    failed += 1;
  }
}

function makeFakeChrome() {
  const local = {};
  const session = {};
  return {
    runtime: {
      id: 'ext_phase4_3_test',
      lastError: null,
      sendMessage(msg, cb) {
        if (msg && msg.type === 'SLEEPWALKER_MEMORY_SET' && msg.state) {
          local.sleepwalker_persistent_memory_v1 = JSON.parse(JSON.stringify(msg.state));
          session.sleepwalker_persistent_memory_v1 = JSON.parse(JSON.stringify(msg.state));
          if (cb) cb({ status: 'ok' });
          return;
        }
        if (msg && msg.type === 'SLEEPWALKER_MEMORY_GET') {
          const merged = session.sleepwalker_persistent_memory_v1 || local.sleepwalker_persistent_memory_v1 || null;
          if (cb) cb({ status: 'ok', state: merged ? JSON.parse(JSON.stringify(merged)) : null });
          return;
        }
        if (cb) cb({ status: 'ok' });
      }
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const ks = Array.isArray(keys) ? keys : Object.keys(local);
          for (const k of ks) out[k] = local[k];
          if (cb) cb(out);
        },
        set(obj, cb) {
          Object.assign(local, JSON.parse(JSON.stringify(obj || {})));
          if (cb) cb();
        },
        remove(keys, cb) {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete local[k];
          if (cb) cb();
        }
      },
      session: {
        get(keys, cb) {
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : Object.keys(session))) out[k] = session[k];
          if (cb) cb(out);
        },
        set(obj, cb) {
          Object.assign(session, JSON.parse(JSON.stringify(obj || {})));
          if (cb) cb();
        }
      }
    }
  };
}

/**
 * Lightweight mock DOM node supporting querySelectorAll, closest, attributes,
 * textContent and hierarchy traversal for Tier 1 World Model unit checks.
 */
function makeEl(tag, attrs = {}, textContent = '', children = []) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    id: attrs.id || '',
    className: attrs.class || '',
    type: attrs.type || '',
    name: attrs.name || '',
    value: attrs.value || '',
    href: attrs.href || '',
    disabled: Boolean(attrs.disabled),
    checked: Boolean(attrs.checked),
    hidden: Boolean(attrs.hidden),
    textContent,
    innerText: textContent,
    parentElement: null,
    parentNode: null,
    children: [],
    dataset: { ...(attrs.dataset || {}) },
    _attrs: { ...attrs },
    _rect: attrs._rect || { width: 140, height: 28, top: 120, left: 20, bottom: 148, right: 160 },
    getAttribute(k) {
      if (k in this._attrs) return String(this._attrs[k]);
      if (k === 'id' && this.id) return this.id;
      if (k === 'href' && this.href) return this.href;
      if (k === 'role' && this._attrs.role) return this._attrs.role;
      return null;
    },
    hasAttribute(k) {
      return k in this._attrs || (k === 'disabled' && this.disabled);
    },
    getBoundingClientRect() { return { ...this._rect }; },
    matches(sel) {
      const parts = String(sel || '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (p === this.tagName.toLowerCase()) return true;
        if (p.startsWith('.') && this.className.split(/\s+/).includes(p.slice(1))) return true;
        if (p === '[role="radiogroup"]' && this._attrs.role === 'radiogroup') return true;
        if (p === '[role="radio"]' && this._attrs.role === 'radio') return true;
        if (p === '[role="combobox"]' && this._attrs.role === 'combobox') return true;
        if (p === '[role="tablist"]' && this._attrs.role === 'tablist') return true;
        if (p === '[role="button"]' && this._attrs.role === 'button') return true;
        if (p === '[role="checkbox"]' && this._attrs.role === 'checkbox') return true;
        if (p === '[role="switch"]' && this._attrs.role === 'switch') return true;
        if (p === '[role="heading"]' && this._attrs.role === 'heading') return true;
        if (p === '[data-video-id]' && (this._attrs['data-video-id'] || this.dataset.videoId)) return true;
        if (p === 'input[type="radio"]' && this.tagName === 'INPUT' && this.type === 'radio') return true;
        if (p === 'input[type="checkbox"]' && this.tagName === 'INPUT' && this.type === 'checkbox') return true;
        if (p === 'a[href]' && this.tagName === 'A' && Boolean(this.href)) return true;
      }
      return false;
    },
    contains(target) {
      if (!target) return false;
      if (target === this) return true;
      return (this.children || []).some((ch) => typeof ch.contains === 'function' && ch.contains(target));
    },
    compareDocumentPosition(other) {
      if (!other || other === this) return 0;
      let root = this;
      while (root.parentElement) root = root.parentElement;
      const order = [];
      const walk = (n) => { order.push(n); (n.children || []).forEach(walk); };
      walk(root);
      const ia = order.indexOf(this);
      const ib = order.indexOf(other);
      if (ia === -1 || ib === -1) return 0;
      return ib > ia ? 4 : 2;
    },
    previousElementSibling: null,
    nextElementSibling: null,
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      const visit = (node) => {
        for (const ch of (node.children || [])) {
          if (ch.matches && ch.matches(sel)) out.push(ch);
          visit(ch);
        }
      };
      visit(this);
      return out;
    }
  };
  for (const ch of children) {
    ch.parentElement = el;
    ch.parentNode = el;
    el.children.push(ch);
  }
  if (!textContent && children.length > 0) {
    const agg = (n) => (n._ownText || n.textContent || '') + ' ' + (n.children || []).map(agg).join(' ');
    el._ownText = '';
    Object.defineProperty(el, 'innerText', {
      get() { return (this._ownText + ' ' + this.children.map((c) => c.innerText).join(' ')).replace(/\s+/g, ' ').trim(); }
    });
    Object.defineProperty(el, 'textContent', {
      get() { return (this._ownText + ' ' + this.children.map((c) => c.textContent).join(' ')).replace(/\s+/g, ' ').trim(); }
    });
  }
  return el;
}

function makeFakeDoc({ title, url, pageType, children }) {
  const rootBody = makeEl('body', { 'data-sw-page-type': pageType || 'general', dataset: { swPageType: pageType || 'general' } }, '', children);
  return {
    title,
    location: { href: url },
    body: rootBody,
    documentElement: rootBody,
    querySelector(sel) {
      if (sel === 'main, article, [role="main"], .mw-parser-output, #mw-content-text, #content') return rootBody;
      return rootBody.querySelector(sel);
    },
    querySelectorAll(sel) {
      return rootBody.querySelectorAll(sel);
    },
    dispatchEvent() {}
  };
}

function findChromiumExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  const msPw = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(msPw)) {
    for (const dir of fs.readdirSync(msPw)) {
      if (dir.startsWith('chromium-')) {
        const exe = path.join(msPw, dir, 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return '';
}

function startFixtureServer() {
  const pages = {
    '/wiki-wm': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Artificial Neural Network - Wikipedia Fixture</title>
      <style>
        body { font-family: sans-serif; margin: 24px; line-height: 1.5; }
        .layout { display: grid; grid-template-columns: 1fr 260px; gap: 24px; }
        aside#appearance-panel { border: 1px solid #ccc; padding: 14px; border-radius: 8px; background: #f8f9fa; }
        section { margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #eee; }
      </style></head>
      <body data-sw-page-type="wikipedia">
        <header><h1 id="firstHeading">Artificial neural network</h1></header>
        <div class="layout">
          <main class="mw-parser-output">
            <section id="sec-intro">
              <h2>Introduction</h2>
              <p>An artificial neural network learns patterns directly from labeled and unlabeled datasets across digital systems.</p>
            </section>
            <section id="sec-banking">
              <h2>Banking</h2>
              <p>Overview of financial settlement instruments and fraud scoring.</p>
              <ul>
                <li>Account billing: <a href="/wiki/Bank_card_banking" id="link-bank-banking">Bank card</a> (issuer account link)</li>
              </ul>
            </section>
            <section id="sec-cards">
              <h2>Cards</h2>
              <p>Different retail debit and credit card networks for consumer payments.</p>
              <ul>
                <li>Card categories:
                  <ul>
                    <li><a href="/wiki/Bank_card_cards" id="link-bank-cards">Bank card</a> (card types directory)</li>
                    <li><a href="/wiki/Smart_card" id="link-smart-card">Smart card</a></li>
                  </ul>
                </li>
              </ul>
            </section>
            <section id="sec-benefits">
              <h2>Benefits of Neural Networks</h2>
              <p>Key practical pros, strengths, and helpful properties include automatic feature extraction, non-linear modeling, fault tolerance, and scaling across multimodal tasks.</p>
            </section>
            <section id="sec-articles">
              <h2>Latest Articles</h2>
              <ul>
                <li><a href="/wiki/Article_1" id="art-1">Distributed Gradient Scaling in 2026</a></li>
                <li><a href="/wiki/Article_2" id="art-2">Sparse Mixture-of-Experts Benchmarks</a></li>
                <li><a href="/wiki/Article_3" id="art-3">Quantized Inference on Consumer GPUs</a></li>
              </ul>
            </section>
            <section id="sec-resources">
              <h2>Resources</h2>
              <ul>
                <li><a href="https://example.medium.com/pytorch-unofficial" id="link-blog-pytorch">PyTorch Blog Post</a></li>
                <li><a href="https://docs.pytorch.org/docs/stable/index.html" id="link-official-pytorch">PyTorch Official Docs</a></li>
              </ul>
            </section>
          </main>
          <aside id="appearance-panel">
            <h2>Appearance</h2>
            <button id="hide-appearance-btn" type="button" onclick="window.__hideAppearanceClicks = (window.__hideAppearanceClicks||0)+1; this.dataset.clicked='true';">Hide Appearance</button>
            <fieldset id="color-group">
              <legend>Color</legend>
              <label><input type="radio" id="color-light" name="wm-color" value="light" checked> Light</label><br>
              <label><input type="radio" id="color-dark" name="wm-color" value="dark"> Dark</label><br>
              <label><input type="radio" id="color-auto" name="wm-color" value="automatic"> Automatic</label>
            </fieldset>
          </aside>
        </div>
      </body></html>`,

    '/yt-feed': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>neural networks - YouTube</title>
      <style>
        body { font-family: sans-serif; margin: 24px; }
        .video-card { border: 1px solid #ddd; padding: 14px; margin: 16px 0; min-height: 90px; }
      </style></head>
      <body data-sw-site="youtube" data-yt-page="search">
        <main>
          <h1>Feed results</h1>
          <div id="feed-list"></div>
          <div id="load-status" style="padding:18px; color:#555;">Showing Batch 1 (10 videos). Scroll or load more for Batch 2.</div>
        </main>
        <script>
          (function() {
            const batch1 = [
              { id: 'v01', ch: 'ChefLab', dur: '6:12', t: 'Sourdough Bread Hydration Guide', d: 'Baking temperature and fermentation schedule.' },
              { id: 'v02', ch: 'GuitarPro', dur: '11:05', t: 'Jazz Chord Voicings for Beginners', d: 'Practice pentatonic and seventh chords cleanly.' },
              { id: 'v03', ch: 'Travelogue', dur: '8:40', t: 'Kyoto Autumn Temple Walk', d: 'Scenic walking tour through Kyoto gardens.' },
              { id: 'v04', ch: 'WoodCraft', dur: '14:20', t: 'Dovetail Joint Workshop', d: 'Hand-saw woodworking joinery tips.' },
              { id: 'v05', ch: 'AstroCam', dur: '9:15', t: 'Photographing Saturn Rings', d: 'Telescope exposure and stacking workflow.' },
              { id: 'v06', ch: 'BikeFix', dur: '7:30', t: 'Adjusting Rear Derailleur Tension', d: 'Simple cable indexing steps at home.' },
              { id: 'v07', ch: 'PlantHome', dur: '5:50', t: 'Indoor Fern Care and Lighting', d: 'Humidity and soil drainage fundamentals.' },
              { id: 'v08', ch: 'FilmCut', dur: '12:00', t: 'Three-Point Studio Lighting Setup', d: 'Key, fill, and backlight placement basics.' },
              { id: 'v09', ch: 'ChessClub', dur: '16:45', t: 'Italian Game Opening Traps', d: 'Classic tactical motifs for rapid games.' },
              { id: 'v10', ch: 'CoffeeBar', dur: '4:35', t: 'Dialing In Espresso Grind Size', d: 'Extraction ratio and burr calibration.' }
            ];
            const batch2 = [
              { id: 'v11', ch: 'PhotoMix', dur: '10:10', t: 'Street Photography Color Grading', d: 'Presets and contrast curves in RAW.' },
              { id: 'v12', ch: 'CodeMint', dur: '8:55', t: 'CSS Subgrid Layout Patterns', d: 'Responsive card alignment techniques.' },
              { id: 'v13', ch: 'NeuralPath', dur: '19:20', t: 'Understanding Deep Learning Through Examples', d: 'Beginner-friendly explanation showing how neural networks learn weights and layers using visual examples.' , href: '/yt-watch-nn' },
              { id: 'v14', ch: 'FitPace', dur: '13:10', t: 'Zone 2 Marathon Conditioning', d: 'Heart-rate training blocks for runners.' },
              { id: 'v15', ch: 'MathViz', dur: '15:40', t: 'Gradient Descent Backpropagation Step by Step', d: 'Visualizing partial derivatives across network layers.', href: '/yt-watch-15' },
              { id: 'v16', ch: 'DockerOps', dur: '11:30', t: 'Multi-Stage Container Builds', d: 'Reducing image footprint in production.' },
              { id: 'v17', ch: 'SoundDesign', dur: '9:05', t: 'Analog Synth Envelope Shaping', d: 'Attack, decay, sustain, and release curves.' },
              { id: 'v18', ch: 'HomeSolar', dur: '17:00', t: 'LiFePO4 Battery Sizing Calculation', d: 'Watt-hour inverter planning for cabins.' },
              { id: 'v19', ch: 'RustByte', dur: '21:15', t: 'Ownership and Lifetimes Explained', d: 'Borrow checker mental models.' },
              { id: 'v20', ch: 'TeaHouse', dur: '7:05', t: 'Gongfu Oolong Brewing Ritual', d: 'Steep timing and clay pot preparation.' }
            ];
            const list = document.getElementById('feed-list');
            const renderBatch = (items) => {
              for (const v of items) {
                if (document.querySelector('[data-video-id="' + v.id + '"]')) continue;
                const card = document.createElement('div');
                card.className = 'video-card';
                card.dataset.videoId = v.id;
                card.dataset.channel = v.ch;
                card.dataset.duration = v.dur;
                card.dataset.title = v.t;
                card.dataset.description = v.d;
                const h3 = document.createElement('h3');
                const a = document.createElement('a');
                a.href = v.href || ('/yt-watch-generic?v=' + v.id);
                a.textContent = v.t;
                h3.appendChild(a);
                const spCh = document.createElement('span');
                spCh.className = 'video-channel';
                spCh.textContent = v.ch;
                const spDur = document.createElement('span');
                spDur.className = 'video-duration';
                spDur.textContent = ' ' + v.dur;
                const p = document.createElement('p');
                p.className = 'video-description';
                p.textContent = v.d;
                card.append(h3, spCh, spDur, p);
                list.appendChild(card);
              }
            };
            renderBatch(batch1);
            window.__batch2Loaded = false;
            const loadBatch2 = () => {
              if (window.__batch2Loaded) return;
              window.__batch2Loaded = true;
              renderBatch(batch2);
              document.getElementById('load-status').textContent = 'Loaded Batch 2 (20 videos total)';
            };
            document.addEventListener('sleepwalker:load-more', loadBatch2);
            window.addEventListener('scroll', () => {
              if (window.scrollY > 180) loadBatch2();
            });
          })();
        </script>
      </body></html>`,

    '/yt-watch-nn': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Understanding Deep Learning Through Examples - YouTube</title></head>
      <body data-sw-site="youtube" data-yt-page="watch" data-duration="19:20">
        <main>
          <h1 data-watch-title>Understanding Deep Learning Through Examples</h1>
          <div class="watch-channel" data-watch-channel>NeuralPath</div>
          <video id="movie-player-nn" data-video-id="v13" data-video-title="Understanding Deep Learning Through Examples" data-channel="NeuralPath" data-duration="19:20" width="480" height="270" controls loop muted autoplay></video>
          <p class="watch-description" data-watch-description>Beginner-friendly explanation showing how neural networks learn weights and layers using visual examples.</p>
          <section id="transcript-panel">
            <h2>Transcript</h2>
            <div class="transcript-segment" data-start-sec="0" data-timestamp="0:00">We begin by feeding handwritten digit pixels into simple artificial neurons.</div>
            <div class="transcript-segment" data-start-sec="110" data-timestamp="1:50">Each connection multiplies inputs by learnable weights before adding a bias term.</div>
            <div class="transcript-segment" data-start-sec="250" data-timestamp="4:10">Loss gradients adjust those weights backward so predictions improve each epoch.</div>
            <div class="transcript-segment" data-start-sec="460" data-timestamp="7:40">Later at seven minutes we compare transformers against convolutional blocks.</div>
          </section>
        </main>
      </body></html>`,

    '/yt-watch-15': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Gradient Descent Backpropagation Step by Step - YouTube</title></head>
      <body data-sw-site="youtube" data-yt-page="watch" data-duration="15:40">
        <main><h1 data-watch-title>Gradient Descent Backpropagation Step by Step</h1><div data-watch-channel>MathViz</div></main>
      </body></html>`,

    '/yt-watch-nocaptions': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Acoustic Field Recording - YouTube</title></head>
      <body data-sw-site="youtube" data-yt-page="watch" data-duration="5:12">
        <main>
          <h1 data-watch-title>Acoustic Field Recording</h1>
          <div class="watch-channel" data-watch-channel>FieldAudio</div>
          <video id="movie-player-nc" data-video-id="vnc" data-video-title="Acoustic Field Recording" data-channel="FieldAudio" data-duration="5:12" width="480" height="270" controls></video>
          <p class="watch-description" data-watch-description>Ambient microphone recording session without spoken commentary.</p>
        </main>
      </body></html>`
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (pages[urlPath]) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pages[urlPath]);
        return;
      }
      if (urlPath.startsWith('/wiki/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>${urlPath.slice(6)}</title></head><body><h1>Destination ${urlPath}</h1><p>Opened destination successfully.</p></body></html>`);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

(async function main() {
  console.log('=== Sleepwalker Phase 4.3 Hybrid Browser World Model Test Suite ===');
  const prevChrome = global.chrome;
  global.chrome = makeFakeChrome();

  // ---------------- TIER 1: UNIT, INTEGRATION & LIVE OLLAMA WORLD MODEL CHECKS ----------------
  await runSuite('WM1. Unified IDs, Parent-Child Hierarchy & Relationship Graph (Appearance > Color > Dark vs Hide Button)', async () => {
    const btnHide = makeEl('button', { id: 'hide-app' }, 'Hide Appearance');
    const rLight = makeEl('input', { type: 'radio', id: 'c-light', name: 'color', value: 'light', checked: true });
    const lLight = makeEl('label', {}, 'Light', [rLight]);
    const rDark = makeEl('input', { type: 'radio', id: 'c-dark', name: 'color', value: 'dark' });
    const lDark = makeEl('label', {}, 'Dark', [rDark]);
    const fsColor = makeEl('fieldset', { id: 'fs-color' }, '', [
      makeEl('legend', {}, 'Color'),
      lLight,
      lDark
    ]);
    const secApp = makeEl('section', { id: 'app-sec' }, '', [
      makeEl('h2', {}, 'Appearance'),
      btnHide,
      fsColor
    ]);
    const secLatest = makeEl('section', { id: 'latest-sec' }, '', [
      makeEl('h2', {}, 'Latest Articles'),
      makeEl('a', { href: 'https://example.org/a1' }, 'First Neural Paper'),
      makeEl('a', { href: 'https://example.org/a2' }, 'Second Neural Paper'),
      makeEl('a', { href: 'https://example.org/a3' }, 'Third Neural Paper')
    ]);
    const doc = makeFakeDoc({
      title: 'Neural Network - Wikipedia',
      url: 'https://en.wikipedia.org/wiki/Neural_network',
      pageType: 'wikipedia',
      children: [makeEl('h1', {}, 'Neural Network'), secLatest, secApp]
    });

    const controller = { isPrivacyBlockedUrl: () => false, memory: null };
    const wm = new wmMod.SleepwalkerWorldModel(controller, { tabId: 'tab_u1' });
    const inv = await wm.buildPageWorldModel(doc, { tabId: 'tab_u1' });

    assert.ok(inv.sections.length >= 2, 'Must extract sections');
    assert.ok(inv.controls.length >= 1, 'Must extract Color control group');
    assert.ok(inv.options.length >= 2, 'Must extract Light & Dark radio options');
    assert.ok(inv.buttons.some((b) => /hide appearance/i.test(b.label)), 'Must distinguish Hide Appearance as B### button');

    const darkOpt = wm.findOptionByHierarchy('Dark', 'Color', 'tab_u1');
    assert.ok(darkOpt, 'Must locate Dark under Color');
    assert.ok(/^O\d+$/i.test(darkOpt.id), `Dark must have O### option ID, got ${darkOpt.id}`);
    assert.strictEqual(darkOpt.elementType, 'radio');
    assert.strictEqual(darkOpt.parentGroupLabel, 'Color');
    assert.strictEqual(darkOpt.parentSection, 'Appearance');

    const childEdge = inv.edges.find((e) => e.type === wmMod.EDGE_TYPES.CHILD_OF && e.from === darkOpt.id);
    assert.ok(childEdge, 'Must create CHILD_OF relationship edge from Dark option to Color control');

    const secondArt = wm.findEntityInSectionByOrdinal('Latest Articles', 2, 'tab_u1');
    assert.ok(secondArt && /Second Neural Paper/.test(secondArt.label), 'Section ordinal lookup must pick #2 article in Latest Articles');
    const nextEdge = inv.edges.find((e) => e.type === wmMod.EDGE_TYPES.NEXT_ITEM);
    assert.ok(nextEdge, 'Must create NEXT_ITEM sequence edges across ordered items');
  });

  await runSuite('WM2. 3-Mode Adaptive Discovery (static_content, progressive_feed Batch 1->2 Stability, dynamic_app)', async () => {
    const controller = { isPrivacyBlockedUrl: () => false };
    const wm = new wmMod.SleepwalkerWorldModel(controller, { tabId: 'tab_m2' });

    assert.strictEqual(wm.detectDiscoveryMode(null, 'wikipedia'), wmMod.DISCOVERY_MODES.STATIC);

    const cards = [];
    for (let i = 1; i <= 15; i++) {
      cards.push(makeEl('div', {
        class: 'video-card',
        'data-video-id': `vid_${i}`,
        'data-channel': `Chan${i}`,
        'data-duration': `${i}:00`,
        'data-title': `Video Title ${i}`,
        'data-description': `Description for video ${i}`,
        dataset: { videoId: `vid_${i}`, channel: `Chan${i}`, duration: `${i}:00`, title: `Video Title ${i}`, description: `Description for video ${i}` }
      }, '', [
        makeEl('a', { href: `/watch?v=vid_${i}` }, `Video Title ${i}`)
      ]));
    }
    const ytDoc = makeFakeDoc({
      title: 'YouTube Feed',
      url: 'https://www.youtube.com/results?search_query=ml',
      pageType: 'youtube_search',
      children: cards
    });

    const inv1 = await wm.buildPageWorldModel(ytDoc, { tabId: 'tab_m2' });
    assert.strictEqual(inv1.discoveryMode, wmMod.DISCOVERY_MODES.PROGRESSIVE_FEED);
    assert.strictEqual(inv1.videos.length, 10, 'Batch 1 must cap at 10 initial feed items');
    assert.strictEqual(inv1.hasMoreFeedInDom, true, 'Must know Batch 2 exists in DOM');
    const id1Snapshot = inv1.videos.slice(0, 10).map((v) => `${v.id}:${v.videoId}`);

    const exp = await wm.discoverMoreCandidates({ doc: ytDoc, tabId: 'tab_m2', targetOrdinal: 15, settleMs: 30 });
    assert.strictEqual(exp.total, 15, 'Progressive discovery must expand through video #15');
    assert.strictEqual(exp.discovered, 5);
    assert.deepStrictEqual(exp.inventory.videos.slice(0, 10).map((v) => `${v.id}:${v.videoId}`), id1Snapshot, 'Batch 1 IDs/order must stay unchanged');
    assert.strictEqual(exp.inventory.videos[14].id, 'V015');
    assert.strictEqual(exp.inventory.videos[14].batchNumber, 2);

    const appDoc = makeFakeDoc({
      title: 'Workspace App',
      url: 'https://app.example.com/board',
      pageType: 'general',
      children: [
        makeEl('div', { role: 'radiogroup' }, 'Theme'),
        makeEl('div', { role: 'tablist' }, 'Views'),
        makeEl('div', { role: 'combobox' }, 'Filter'),
        makeEl('select', { name: 'sort' }, 'Sort')
      ]
    });
    assert.strictEqual(wm.detectDiscoveryMode(appDoc, 'general'), wmMod.DISCOVERY_MODES.DYNAMIC_APP);
  });

  await runSuite('WM3. Semantic Page Retrieval (Live nomic-embed-text + Offline Fallback) & Strict Context Budget', async () => {
    const cards = [
      makeEl('div', { class: 'video-card', 'data-video-id': 'va', dataset: { videoId: 'va', channel: 'ChefLab', title: 'Sourdough Bread Baking', description: 'Flour water yeast dough.' } }, '', [makeEl('a', { href: '/va' }, 'Sourdough Bread Baking')]),
      makeEl('div', { class: 'video-card', 'data-video-id': 'vb', dataset: { videoId: 'vb', channel: 'NeuralPath', title: 'Understanding Deep Learning Through Examples', description: 'Beginner introduction explaining how neural networks learn step by step.' } }, '', [makeEl('a', { href: '/vb' }, 'Understanding Deep Learning Through Examples')]),
      makeEl('div', { class: 'video-card', 'data-video-id': 'vc', dataset: { videoId: 'vc', channel: 'GuitarPro', title: 'Acoustic Fingerpicking Arpeggios', description: 'Guitar practice patterns.' } }, '', [makeEl('a', { href: '/vc' }, 'Acoustic Fingerpicking Arpeggios')])
    ];
    const doc = makeFakeDoc({ title: 'Feed', url: 'http://127.0.0.1/feed', pageType: 'youtube_search', children: cards });
    const wm = new wmMod.SleepwalkerWorldModel(
      { isPrivacyBlockedUrl: () => false },
      { tabId: 'tab_sem', embedRequester: (payload) => llm.handleEmbedRequest(payload) }
    );
    const inv = await wm.buildPageWorldModel(doc, { tabId: 'tab_sem' });

    const offlineMatches = await wm.retrieveRelevantCandidatesAsync('Find a video explaining how neural networks learn', {
      topK: 3, inventory: inv, offlineOnly: true
    });
    assert.ok(offlineMatches.length >= 1);
    assert.strictEqual(offlineMatches[0].entity.title, 'Understanding Deep Learning Through Examples');
    assert.strictEqual(offlineMatches[0].vectorModel, 'concept-semantic-64d');

    const st = await llm.verifyOllamaAndEmbedStatus();
    if (st.embeddings && st.embeddings.state === 'connected') {
      wm.pageEmbedCache.clear();
      const liveMatches = await wm.retrieveRelevantCandidatesAsync('Find a video explaining how neural networks learn', {
        topK: 3, inventory: inv
      });
      assert.strictEqual(liveMatches[0].entity.title, 'Understanding Deep Learning Through Examples');
      assert.strictEqual(liveMatches[0].vectorModel, 'nomic-embed-text');
    }

    const ctx = wm.buildReasonerContext('Explain how neural networks learn', { inventory: inv, maxTokens: 820 });
    assert.ok(ctx.text.includes('[V002]'), 'Budgeted context must include hierarchical typed IDs');
    assert.ok(ctx.validIds.has('V002'));
    assert.ok(Math.ceil(ctx.text.length / 4) <= 840, 'Reasoner context must stay tightly budgeted around <=820 tokens');
  });

  await runSuite('WM4. Strict NLU Validation Rejects Cross-Tab IDs, Stale InventoryVersion & Incompatible Target Types', async () => {
    const allowed = new Set(['L001', 'L002', 'O008', 'B001']);
    const meta = { expectedTabId: 'tab_A', expectedInventoryVersion: 4 };

    // Cross-tab ID must reject
    const crossTab = JSON.stringify({
      intent: 'select_option', target_id: 'O008', action: 'select_radio',
      tab_id: 'tab_B', inventory_version: 4,
      actions: [{ type: 'select_radio', candidate_id: 'O008', target: 'Dark' }], confidence: 0.9
    });
    assert.strictEqual(llm.parseNluPlanJson(crossTab, allowed, meta), null, 'Cross-tab tab_id must be rejected');

    // Stale inventory version must reject
    const staleVer = JSON.stringify({
      intent: 'select_option', target_id: 'O008', action: 'select_radio',
      tab_id: 'tab_A', inventory_version: 2,
      actions: [{ type: 'select_radio', candidate_id: 'O008', target: 'Dark' }], confidence: 0.9
    });
    assert.strictEqual(llm.parseNluPlanJson(staleVer, allowed, meta), null, 'Stale inventory_version must be rejected');

    // Selecting radio action against a hyperlink ID L001 must reject
    const badType = JSON.stringify({
      intent: 'select_option', target_id: 'L001', action: 'select_radio',
      tab_id: 'tab_A', inventory_version: 4,
      actions: [{ type: 'select_radio', candidate_id: 'L001', target: 'Bank card' }], confidence: 0.9
    });
    assert.strictEqual(llm.parseNluPlanJson(badType, allowed, meta), null, 'select_radio against hyperlink L001 must be rejected');

    // Valid matched action passes
    const valid = JSON.stringify({
      intent: 'select_option', target_id: 'O008', parent_section: 'Color', action: 'select_radio',
      tab_id: 'tab_A', inventory_version: 4,
      actions: [{ type: 'select_radio', candidate_id: 'O008', target: 'Dark', section: 'Color' }], confidence: 0.95
    });
    const okPlan = llm.parseNluPlanJson(valid, allowed, meta);
    assert.ok(okPlan && okPlan.target_id === 'O008' && okPlan.parent_section === 'Color');
  });

  await runSuite('WM5. Live Ollama World Model Reasoning, Conversation Memory (previousSection/similarTo) & Redacted Diagnostics', async () => {
    const st = await llm.verifyOllamaAndEmbedStatus();
    assert.strictEqual(st.ollama.state, 'connected', `Expected live Ollama llama3.2:3b online; got ${st.ollama.detail}`);

    const nluRes = await llm.handleNluPlanRequest({
      utterance: 'Select Dark under Color',
      tabId: 'tab_1',
      inventoryVersion: 1,
      candidateIds: ['S001', 'B001', 'C001', 'O001', 'O002'],
      worldModelDigestText: [
        'TAB_ID: tab_1 | INV_VER: 1 | PAGE_TYPE: wikipedia | MODE: static_content | TITLE: Neural Network',
        '[S001] SECTION: "Appearance"',
        '  [B001] BUTTON: "Hide Appearance" (section: Appearance)',
        '  [C001] CONTROL_GROUP (radio): "Color" (section: Appearance) -> options: [O001] Light | [O002] Dark'
      ].join('\n'),
      maxContextTokens: 820,
      skipCache: true
    });
    assert.strictEqual(nluRes.status, 'ok', `Live Ollama NLU failed: ${JSON.stringify(nluRes)}`);
    assert.ok(nluRes.diag && Number.isFinite(nluRes.diag.latencyMs), 'NLU must report diag telemetry');
    assert.ok(['select_option', 'clarify'].includes(nluRes.plan.intent), `Unexpected intent: ${nluRes.plan.intent}`);

    // Memory previousSection + similarTo resolution
    const mem = new SleepwalkerMemory({ tabId: 'tab_m' });
    mem.setActiveUiFocus({ activeSection: 'Latest Articles', activeDomain: 'wikipedia.org', urlClean: 'https://en.wikipedia.org/wiki/NN' });
    mem.setActiveUiFocus({ activeSection: 'Benefits of Neural Networks', activeDomain: 'wikipedia.org', urlClean: 'https://en.wikipedia.org/wiki/NN' });
    const prevSec = mem.resolveContextualReferences('Find the second article in the previous section', { url: 'https://en.wikipedia.org/wiki/NN' });
    assert.strictEqual(prevSec.resolvedSection, 'Latest Articles', 'Must resolve "previous section" accurately');

    mem.recordSelection({ id: 'V013', title: 'Understanding Deep Learning Through Examples', channel: 'NeuralPath', entityType: 'video', url: '/yt-watch-nn' });
    const sim = mem.resolveContextualReferences('Find another one like this', { url: 'https://www.youtube.com' });
    assert.ok(sim.resolvedSimilarTo && /Understanding Deep Learning/.test(sim.resolvedSimilarTo.title));

    // Diagnostics secret redaction
    const diag = new SleepwalkerDiagnostics.SleepwalkerDiagnostics();
    const rec = diag.recordWorldModelTrace({
      speech: 'Bearer sk-test-secret-123456',
      url: 'https://example.com/watch?token=abc123&v=1',
      tabId: 'tab_m',
      pageType: 'youtube_search',
      inventoryVersion: 2,
      candidateCount: 18,
      contextSentTokens: 610,
      ollamaLatencyMs: nluRes.diag.latencyMs,
      browserExecution: 'selected_video',
      verificationResult: 'verified'
    });
    assert.ok(!rec.speech.includes('sk-test-secret'), 'Secret tokens must be scrubbed from traces');
    assert.ok(!rec.url.includes('token=abc123'), 'URL query secrets must be stripped');
    assert.strictEqual(diag.getReport().worldModelTraces.length, 1);
  });

  // ---------------- TIER 2: REAL CHROME MV3 EXTENSION E2E TESTS A–J ----------------
  const chromiumExe = findChromiumExe();
  assert.ok(chromiumExe, 'Chromium executable must exist for Tier 2 real MV3 E2E');
  const { server, port } = await startFixtureServer();

  await runSuite('Tests A–J. Real Chrome MV3 Extension E2E (Scoped Links, Appearance Radio, Feed Batch 1->2, Semantic Discovery, YouTube Captions/Honesty, Section Jump, Multi-Tab & Options Trace)', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-p43-ext-'));
    const cdpPort = 9710 + Math.floor(Math.random() * 200);

    const chrome = spawn(chromiumExe, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--headless=new',
      '--no-sandbox',
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check',
      `http://127.0.0.1:${port}/wiki-wm`
    ], { stdio: 'ignore' });

    const fetchTargets = async () => (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const connectTarget = async (t, label = '') => {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
      const exceptions = [];
      let cid = 0;
      ws.addEventListener('message', async (ev) => {
        try {
          const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
          const msg = JSON.parse(raw);
          if (msg.method === 'Runtime.exceptionThrown') {
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
      const evalJs = async (body) => {
        const res = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
        if (res && res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
        return res && res.result ? res.result.value : undefined;
      };
      return { ws, send, evalJs, exceptions, label };
    };

    const sockets = [];
    try {
      let pageTarget = null;
      let swTarget = null;
      const deadline = Date.now() + 16000;
      while (Date.now() < deadline && (!pageTarget || !swTarget)) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const targets = await fetchTargets();
          if (!pageTarget) pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
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
      assert.ok(pageTarget && swTarget, 'Real MV3 SW and /wiki-wm page must attach cleanly');

      const pageCdp = await connectTarget(pageTarget, 'page');
      const swCdp = await connectTarget(swTarget, 'sw');
      sockets.push(pageCdp.ws, swCdp.ws);
      await pageCdp.send('Runtime.enable').catch(() => {});
      await swCdp.send('Runtime.enable').catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));

      const waitForUiHost = async (cdp = pageCdp, maxWaitMs = 9000) => {
        const tEnd = Date.now() + maxWaitMs;
        while (Date.now() < tEnd) {
          const ok = await cdp.evalJs(`return Boolean(document.getElementById('sleepwalker-ui-host')?.shadowRoot);`).catch(() => false);
          if (ok) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error(`#sleepwalker-ui-host never mounted on ${await cdp.evalJs('return location.href').catch(() => '?')}`);
      };

      const wakeSleepwalker = async (cdp = pageCdp) => {
        await waitForUiHost(cdp, 9000);
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
        await new Promise((r) => setTimeout(r, 500));
      };

      const runCmdAndSnap = async (cmd, waitMs = 26000, cdp = pageCdp) => {
        const beforeSig = await cdp.evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host')?.shadowRoot;
          return sr ? ((sr.getElementById('sw-card-title')?.textContent || '') + '||' + (sr.getElementById('sw-card-body')?.textContent || '')) : '';
        `);
        await cdp.evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
          const form = sr.getElementById('sw-ui-type-form');
          const btn = sr.getElementById('sw-ui-type-btn');
          const inp = sr.getElementById('sw-ui-type-input');
          const sub = sr.querySelector('.sw-type-submit');
          if (form && form.hidden && btn) btn.click();
          inp.focus();
          inp.value = ${JSON.stringify(cmd)};
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          sub.click();
        `);
        const end = Date.now() + waitMs;
        let last = null;
        while (Date.now() < end) {
          await new Promise((r) => setTimeout(r, 300));
          const cur = await cdp.evalJs(`
            const sr = document.getElementById('sleepwalker-ui-host')?.shadowRoot;
            if (!sr) return null;
            const dock = sr.querySelector('.sw-dock');
            return {
              url: location.href,
              cardHidden: Boolean(sr.getElementById('sw-ui-card')?.hidden),
              streamStatus: sr.getElementById('sw-ui-card')?.dataset?.streamStatus || '',
              cardTitle: sr.getElementById('sw-card-title')?.textContent || '',
              cardBody: sr.getElementById('sw-card-body')?.textContent || '',
              dockState: dock ? dock.getAttribute('data-state') : '',
              darkChecked: Boolean(document.getElementById('color-dark')?.checked),
              hideClicks: Number(window.__hideAppearanceClicks || 0)
            };
          `).catch(() => ({ url: 'navigated' }));
          last = cur;
          if (!cur || cur.url === 'navigated') return cur;
          const sig = `${cur.cardTitle}||${cur.cardBody}`;
          const busy = /working|thinking|preparing/i.test(cur.dockState || '')
            || cur.streamStatus === 'thinking'
            || cur.streamStatus === 'streaming'
            || /^(?:Highlighting|Finding answer|Analyzing|Preparing|Explaining|Summarizing)\b/i.test(cur.cardBody || '')
            || /\.\.\.$/.test((cur.cardBody || '').trim());
          if (!cur.cardHidden && sig !== beforeSig && cur.cardBody && !busy) {
            return cur;
          }
        }
        return last;
      };

      // 1. Test B: Wikipedia Appearance Panel ("Select Dark under Color" vs "Hide Appearance" button) + Command Bar Geometry
      await wakeSleepwalker();
      const uiGeom = await pageCdp.evalJs(`
        const sr = document.getElementById('sleepwalker-ui-host')?.shadowRoot;
        const typeBtn = sr && sr.getElementById('sw-ui-type-btn');
        if (sr && sr.getElementById('sw-ui-type-form')?.hidden && typeBtn) typeBtn.click();
        const form = sr && sr.getElementById('sw-ui-type-form');
        const orb = sr && sr.querySelector('.sw-orb-btn');
        if (!form || !orb) return null;
        const fr = form.getBoundingClientRect();
        const or = orb.getBoundingClientRect();
        const overlap = !(fr.right <= or.left || fr.left >= or.right || fr.bottom <= or.top || fr.top >= or.bottom);
        return { formWidth: fr.width, overlap };
      `);
      assert.ok(uiGeom && uiGeom.formWidth > 100 && !uiGeom.overlap, `Command bar must not overlap orb button: ${JSON.stringify(uiGeom)}`);

      const sDark = await runCmdAndSnap('Select Dark under Color');
      const wikiChecks = await pageCdp.evalJs(`return { dark: document.getElementById('color-dark').checked, light: document.getElementById('color-light').checked, hideClicks: window.__hideAppearanceClicks || 0 };`);
      assert.strictEqual(wikiChecks.dark, true, `Test B failed: Dark radio not checked; snap=${JSON.stringify(sDark)}`);
      assert.strictEqual(wikiChecks.light, false, 'Light radio should now be unchecked');
      assert.strictEqual(wikiChecks.hideClicks, 0, 'Hide Appearance button must NOT have been clicked!');

      // 2. Test F: Conceptual Semantic Section Jump ("Take me to where they explain the advantages")
      const sAdv = await runCmdAndSnap('Take me to where they explain the advantages');
      if (!sAdv || !/Benefits of Neural Networks|section|jumped|moved/i.test(`${sAdv.cardTitle} ${sAdv.cardBody}`)) {
        const fTraces = await swCdp.evalJs(`return (self._devWorldModelTraces || []).slice(-5);`).catch(() => []);
        console.error('[Test F DEBUG traces]:', JSON.stringify(fTraces));
      }
      assert.ok(sAdv && /Benefits of Neural Networks|section|jumped|moved/i.test(`${sAdv.cardTitle} ${sAdv.cardBody}`), `Test F failed: expected jump to Benefits section; got ${JSON.stringify(sAdv)}`);

      // 3. Test G: Navigate to Latest Articles -> move to Banking -> "Open the second article in the previous section"
      await runCmdAndSnap('Take me to Latest Articles');
      await new Promise((r) => setTimeout(r, 1100));
      await runCmdAndSnap('Go to the Banking section');
      await new Promise((r) => setTimeout(r, 1100));
      await runCmdAndSnap('Open the second article in the previous section');
      await new Promise((r) => setTimeout(r, 1600));
      const artUrl = await pageCdp.evalJs(`return location.pathname;`).catch(() => '');
      if (artUrl !== '/wiki/Article_2') {
        const gTraces = await swCdp.evalJs(`return (self._devWorldModelTraces || []).slice(-5);`).catch(() => []);
        console.error('[Test G DEBUG traces]:', JSON.stringify(gTraces));
      }
      assert.strictEqual(artUrl, '/wiki/Article_2', `Test G failed: expected Article_2 from previous section Latest Articles; got ${artUrl}`);

      // 4. Test A: Scoped Wikipedia Link ("Select Bank card under Cards")
      await pageCdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/wiki-wm` });
      await new Promise((r) => setTimeout(r, 1100));
      await wakeSleepwalker();
      await runCmdAndSnap('Select Bank card under Cards');
      await new Promise((r) => setTimeout(r, 1400));
      const cardUrl = await pageCdp.evalJs(`return location.pathname;`).catch(() => '');
      assert.strictEqual(cardUrl, '/wiki/Bank_card_cards', `Test A failed: expected /wiki/Bank_card_cards, got ${cardUrl}`);

      // 5. Test C: YouTube Infinite Scroll Progressive Batch Discovery ("Open the 15th video")
      await pageCdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/yt-feed` });
      await new Promise((r) => setTimeout(r, 1100));
      await wakeSleepwalker();
      await runCmdAndSnap('Open the 15th video');
      await new Promise((r) => setTimeout(r, 1100));
      const v15Path = await pageCdp.evalJs(`return location.pathname;`).catch(() => '');
      assert.strictEqual(v15Path, '/yt-watch-15', `Test C failed: expected /yt-watch-15 (Batch 2 #15), got ${v15Path}`);

      // 6. Test D: YouTube Semantic Discovery ("Find a beginner-friendly video explaining how neural networks learn")
      await pageCdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/yt-feed` });
      await new Promise((r) => setTimeout(r, 1100));
      await wakeSleepwalker();
      await runCmdAndSnap('Find a beginner-friendly video explaining how neural networks learn');
      await new Promise((r) => setTimeout(r, 1100));
      const nnPath = await pageCdp.evalJs(`return location.pathname;`).catch(() => '');
      assert.strictEqual(nnPath, '/yt-watch-nn', `Test D failed: expected /yt-watch-nn semantic Batch 2 hit, got ${nnPath}`);

      // 7. Test E1: Watch Captions Bounded Explanation + Playback Pause
      await wakeSleepwalker();
      const sFive = await runCmdAndSnap('Explain the first five minutes', 42000);
      assert.ok(sFive && /weight|pixel|neuron|gradient|0:00|1:50|4:10/i.test(sFive.cardBody), `Test E1 failed: ${JSON.stringify(sFive)}`);
      assert.ok(!/transformer/i.test(sFive.cardBody), 'Should exclude 7:40 transformer segment past 5 minutes');
      await runCmdAndSnap('Pause the video');
      const isPaused = await pageCdp.evalJs(`return Boolean(document.querySelector('video')?.paused);`);
      assert.strictEqual(isPaused, true, 'Video should be paused');

      // 8. Test E2: No-Captions Honesty
      await pageCdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/yt-watch-nocaptions` });
      await new Promise((r) => setTimeout(r, 1000));
      await wakeSleepwalker();
      const sNoCap = await runCmdAndSnap('What is the speaker teaching?');
      assert.ok(sNoCap && /caption|transcript|not available|aren't available|cannot verify/i.test(sNoCap.cardBody), `Test E2 failed: ${JSON.stringify(sNoCap)}`);

      // 9. Test I: Multi-Tab Isolation (Open second tab on /wiki-wm while Tab 1 stays on /yt-watch-nocaptions)
      const tab2TargetRes = await swCdp.evalJs(`
        return await new Promise((resolve) => {
          chrome.tabs.create({ url: 'http://127.0.0.1:${port}/wiki-wm', active: true }, (tab) => resolve(tab ? tab.id : null));
        });
      `);
      assert.ok(tab2TargetRes, 'Must create real second browser tab');
      await new Promise((r) => setTimeout(r, 1200));
      const targets2 = await fetchTargets();
      const tab2Info = targets2.find((t) => t.type === 'page' && t.url.includes('/wiki-wm') && t.id !== pageTarget.id);
      assert.ok(tab2Info, 'Tab 2 page target must be reachable via CDP');
      const tab2Cdp = await connectTarget(tab2Info, 'tab2');
      sockets.push(tab2Cdp.ws);
      await tab2Cdp.send('Runtime.enable').catch(() => {});
      await wakeSleepwalker(tab2Cdp);
      await runCmdAndSnap('Select Automatic under Color', 26000, tab2Cdp);
      const autoChecked = await tab2Cdp.evalJs(`return Boolean(document.getElementById('color-auto')?.checked);`);
      assert.strictEqual(autoChecked, true, 'Test I failed: Tab 2 must operate independently on its own /wiki-wm world model');

      // 10. Test J: Dev World Model Traces recorded in SW & viewable in Options Dev Inspector
      const swHealth = await swCdp.evalJs(`return { traceCount: Array.isArray(self._devWorldModelTraces) ? self._devWorldModelTraces.length : 0, sample: (self._devWorldModelTraces || [])[0] || null };`);
      assert.ok(swHealth.traceCount >= 3, `Test J failed: expected >= 3 recorded World Model traces in SW, got ${swHealth.traceCount}`);

      const extIdMatch = (swTarget.url || '').match(/^chrome-extension:\/\/([^/]+)/);
      assert.ok(extIdMatch, 'Must resolve extension ID from SW URL');
      await tab2Cdp.send('Page.navigate', { url: `chrome-extension://${extIdMatch[1]}/options.html` });
      await new Promise((r) => setTimeout(r, 900));
      await tab2Cdp.evalJs(`document.getElementById('opt-load-diag')?.click();`);
      let optDiagText = '';
      const optEnd = Date.now() + 14000;
      while (Date.now() < optEnd) {
        await new Promise((r) => setTimeout(r, 350));
        optDiagText = await tab2Cdp.evalJs(`return document.getElementById('opt-diag')?.textContent || '';`).catch(() => '');
        if (optDiagText.includes('worldModelTraces')) break;
      }
      assert.ok(optDiagText.includes('worldModelTraces'), `Test J failed: Options dev inspector must expose worldModelTraces (got len=${optDiagText.length})`);
    } finally {
      sockets.forEach((ws) => { try { ws.close(); } catch (_e) {} });
      try { chrome.kill('SIGKILL'); } catch (_e) {}
      await new Promise((r) => setTimeout(r, 400));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  server.close();
  global.chrome = prevChrome;
  console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
