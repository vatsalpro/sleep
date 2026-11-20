/**
 * Final Acceptance Test & Full Persistent Context/Memory E2E Suite
 * Tests Phases 1-6 + the complete 18-Step China Scenario in Real Headless Google Chrome via CDP,
 * connected to Real Local Ollama (if online) for hybrid embeddings & research.
 *
 * Run with: node tests/run-acceptance-persistence-tests.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHROME_BIN = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const llmMod = require(path.join(ROOT, 'llm.js'));

const EXTENSION_SCRIPTS = [
  'diagnostics.js',
  'ai-comm.js',
  'reader.js',
  'outline.js',
  'voice.js',
  'memory.js',
  'task-planner.js',
  'digest.js',
  'explain.js',
  'confirm.js',
  'link-index.js',
  'match.js',
  'link-intent.js',
  'intent.js',
  'navigate.js',
  'form-index.js',
  'form-fill.js',
  'forms.js',
  'shelf-db.js',
  'upload.js',
  'camera.js',
  'dialogue.js',
  'threads.js',
  'card.js',
  'orb.js',
  'content.js'
];

const CHINA_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>China - Encyclopedia Overview</title></head>
<body>
  <main style="padding:24px;max-width:860px;margin:auto;font-family:system-ui,sans-serif;">
    <h1>China</h1>
    <p>China, officially the People's Republic of China, is a country in East Asia with a population exceeding 1.4 billion people. Beijing is the national capital, while Shanghai is the largest financial center.</p>
    <h2>Geography</h2>
    <p>China's landscape is vast and diverse, ranging from the Gobi and Taklamakan Deserts in the north to subtropical forests in the south, and the Himalayan mountain range along its southwestern border.</p>
    <h2>Culture and History</h2>
    <p>China has over four millennia of recorded history, famous for the Silk Road, the Great Wall, classical literature, calligraphy, and culinary traditions across Sichuan, Cantonese, and Beijing cuisines.</p>
    <h2>Economy</h2>
    <p>China is the world's second-largest economy by nominal GDP and a global hub for manufacturing, clean energy technology, and high-speed rail infrastructure.</p>
  </main>
</body>
</html>`;

const TRAVEL_GUIDE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>China Travel &amp; Visa Guide - Official Visitor Information</title></head>
<body>
  <main style="padding:24px;max-width:860px;margin:auto;font-family:system-ui,sans-serif;">
    <h1>China Travel &amp; Tourist Visa Guide</h1>
    <p>Plan your trip to China safely with official entry rules, flight hubs, and visitor visa documentation guidelines.</p>
    <h2>Required Documents</h2>
    <p>To apply for a Chinese Tourist Visa (L Visa), applicants need a passport valid for at least 6 months, completed COVA application form, recent passport photograph, confirmed round-trip flight itinerary, and hotel reservation or invitation letter.</p>
    <h2>Visa Fees and Processing Time</h2>
    <p>Standard tourist visa processing takes 4 business days. Typical visa fees range from 140 USD for US citizens or around 3900 INR single-entry fee depending on nationality and service center charges.</p>
    <h2>Major Arrival Airports</h2>
    <p>International travelers typically arrive through Beijing Capital (PEK), Beijing Daxing (PKX), Shanghai Pudong (PVG), or Guangzhou Baiyun (CAN).</p>
  </main>
</body>
</html>`;

const UNIVERSITY_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Global Tech University - Admissions Portal</title></head>
<body style="min-height:2000px;font-family:system-ui,sans-serif;">
  <main style="padding:24px;max-width:860px;margin:auto;">
    <h1>Graduate Admissions 2027</h1>
    <p>Welcome to the Global Tech University admissions portal for international and domestic applicants.</p>
    <div style="height:400px;"></div>
    <h2 id="sec-elig">Eligibility Criteria</h2>
    <p>Applicants must hold a recognized Bachelor's degree with a minimum GPA of 3.0 or 65 percent aggregate marks in a related field.</p>
    <div style="height:400px;"></div>
    <h2 id="sec-req">Admission Requirements</h2>
    <p>Required admission documents include official university transcripts, two academic recommendation letters, statement of purpose, and English proficiency score (IELTS 6.5 or TOEFL 90).</p>
    <div style="height:400px;"></div>
    <h2 id="sec-app">Application Process</h2>
    <p>Complete the online application form, upload scanned PDF documents before May 15, and pay the non-refundable 50 USD application fee.</p>
  </main>
</body>
</html>`;

const LAPTOPS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Best Laptops 2026 - Tech Review</title></head>
<body>
  <main style="padding:24px;max-width:860px;margin:auto;font-family:system-ui,sans-serif;">
    <h1>Best Ultrabook Laptops</h1>
    <article data-result-item="1"><h2>ThinkPad X1 Carbon Gen 13</h2><p>Light carbon chassis, top keyboard, 18 hour battery.</p></article>
    <article data-result-item="2"><h2>MacBook Air M4 15-inch</h2><p>Fanless design, Apple M4 silicon, 20 hour battery life.</p></article>
    <article data-result-item="3"><h2>Dell XPS 14 OLED</h2><p>Vivid OLED touch screen and compact CNC aluminum body.</p></article>
  </main>
</body>
</html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      if (urlPath === '/china.html' || urlPath === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(CHINA_HTML);
        return;
      }
      if (urlPath === '/travel-guide.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(TRAVEL_GUIDE_HTML);
        return;
      }
      if (urlPath === '/university.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(UNIVERSITY_HTML);
        return;
      }
      if (urlPath === '/laptops.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LAPTOPS_HTML);
        return;
      }

      if (urlPath === '/sw-message' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const msg = JSON.parse(body || '{}');
            if (msg.type === 'SLEEPWALKER_EMBED_REQUEST') {
              const out = await llmMod.handleEmbedRequest(msg);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(out));
              return;
            }
            if (msg.type === 'SLEEPWALKER_OFF_PAGE_RESEARCH_REQUEST') {
              const out = await llmMod.handleOffPageResearchRequest(msg.payload || msg);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(out));
              return;
            }
            if (msg.type === 'SLEEPWALKER_EXPLAIN_REQUEST') {
              const out = await llmMod.handleExplainRequest(msg.payload || {});
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(out));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'fallback' }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: err.message }));
          }
        });
        return;
      }

      // Serve extension assets directly
      const safeRel = urlPath.replace(/^\/+/, '');
      const fullPath = path.join(ROOT, safeRel);
      if (safeRel && fullPath.startsWith(ROOT) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const mime = ext === '.css' ? 'text/css; charset=utf-8'
          : ext === '.json' ? 'application/json; charset=utf-8'
          : 'application/javascript; charset=utf-8';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(fs.readFileSync(fullPath));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function launchChrome(userDataDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CHROME_BIN, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1440,900',
      'about:blank'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const m = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
      if (m) resolve({ proc, wsUrl: m[1] });
    });
    proc.on('error', reject);
    setTimeout(() => reject(new Error('Chrome launch timeout: ' + stderr)), 12000);
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(e));
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      });
    });
  }
  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(payload));
    });
  }
  async eval(sessionId, expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sessionId);
    if (res.exceptionDetails) {
      throw new Error('Eval exception: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result ? res.result.value : undefined;
  }
  close() {
    if (this.ws) this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildPreloadBootstrap(baseUrl) {
  return `
    (function () {
      const BASE = ${JSON.stringify(baseUrl)};
      // Realistic MockSpeechRecognition + Mock SpeechSynthesis for deterministic real-browser E2E testing
      window.__SW_SR_LOG__ = { startCalls: 0, stopCalls: 0, active: false, instances: [] };
      class MockSR {
        constructor() {
          this.continuous = false;
          this.interimResults = false;
          this.maxAlternatives = 1;
          this.lang = 'en-IN';
          this.onstart = null;
          this.onresult = null;
          this.onerror = null;
          this.onend = null;
          window.__SW_SR_LOG__.instances.push(this);
        }
        start() {
          window.__SW_SR_LOG__.startCalls += 1;
          if (window.__SW_SR_LOG__.active) {
            throw new Error('InvalidStateError: recognition already started');
          }
          window.__SW_SR_LOG__.active = true;
          if (typeof this.onstart === 'function') this.onstart();
        }
        stop() {
          window.__SW_SR_LOG__.stopCalls += 1;
          const wasActive = window.__SW_SR_LOG__.active;
          window.__SW_SR_LOG__.active = false;
          if (wasActive && typeof this.onend === 'function') {
            this.onend();
          }
        }
        emitResult(transcript, isFinal = true, confidence = 0.96, index = 0) {
          if (typeof this.onresult !== 'function') return;
          const results = [];
          for (let i = 0; i <= index; i++) {
            results.push({
              isFinal: i === index ? isFinal : true,
              length: 1,
              0: { transcript: i === index ? transcript : 'prev', confidence }
            });
          }
          this.onresult({ resultIndex: index, results });
        }
        emitError(errorName) {
          if (typeof this.onerror === 'function') this.onerror({ error: errorName });
        }
        emitEnd() {
          window.__SW_SR_LOG__.active = false;
          if (typeof this.onend === 'function') this.onend();
        }
      }
      window.SpeechRecognition = MockSR;
      window.webkitSpeechRecognition = MockSR;

      window.__SW_SPOKEN__ = [];
      try {
        window.SpeechSynthesisUtterance = class MockUtterance {
          constructor(text = '') {
            this.text = text;
            this.lang = 'en-IN';
            this.rate = 1.0;
            this.voice = null;
            this.onstart = null;
            this.onend = null;
            this.onerror = null;
            this.onboundary = null;
          }
        };
        const mockSynth = {
          speaking: false,
          paused: false,
          getVoices: () => [{ lang: 'en-IN', name: 'Ravi', default: true }],
          speak: (u) => {
            window.__SW_SPOKEN__.push((u && u.text) || '');
            mockSynth.speaking = true;
            setTimeout(() => { if (u && typeof u.onstart === 'function') u.onstart(); }, 10);
            setTimeout(() => {
              mockSynth.speaking = false;
              if (u && typeof u.onend === 'function') u.onend();
            }, 60);
          },
          cancel: () => { mockSynth.speaking = false; },
          pause: () => { mockSynth.paused = true; },
          resume: () => { mockSynth.paused = false; },
          addEventListener: () => {}
        };
        Object.defineProperty(window, 'speechSynthesis', {
          configurable: true,
          get: () => mockSynth
        });
      } catch (_e) {}

      // Persistent chrome.storage bridge across navigations in the origin
      const readStore = (prefix, keys) => {
        const out = {};
        const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
        for (const k of keyList) {
          try {
            const raw = localStorage.getItem(prefix + k);
            if (raw !== null) out[k] = JSON.parse(raw);
          } catch (_e) {}
        }
        return out;
      };
      const writeStore = (prefix, obj) => {
        for (const [k, v] of Object.entries(obj || {})) {
          try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch (_e) {}
        }
      };

      window.chrome = {
        runtime: {
          lastError: null,
          getURL: (rel) => BASE + '/' + String(rel || '').replace(/^\\/+/, ''),
          onMessage: { addListener: () => {} },
          sendMessage: (msg, cb) => {
            if (!msg) { if (cb) cb({}); return; }
            if (msg.type === 'SLEEPWALKER_MEMORY_SET') {
              if (msg.state) {
                writeStore('sw_local_', { sleepwalker_persistent_memory_v1: msg.state });
                writeStore('sw_session_', {
                  sleepwalker_persistent_memory_v1: msg.state,
                  sleepwalker_session_state_v1: {
                    sessionMode: msg.state.sessionMode,
                    currentTopic: msg.state.currentTopic,
                    activeTask: msg.state.activeTask
                  }
                });
              }
              if (cb) setTimeout(() => cb({ status: 'ok' }), 5);
              return;
            }
            if (msg.type === 'SLEEPWALKER_MEMORY_GET') {
              const s = readStore('sw_session_', ['sleepwalker_persistent_memory_v1', 'sleepwalker_session_state_v1']);
              const l = readStore('sw_local_', ['sleepwalker_persistent_memory_v1']);
              const merged = s.sleepwalker_persistent_memory_v1 || l.sleepwalker_persistent_memory_v1 || null;
              if (cb) setTimeout(() => cb({ status: 'ok', state: merged }), 5);
              return;
            }
            if (msg.type === 'SLEEPWALKER_SESSION_STATE_SET') {
              writeStore('sw_session_', { sleepwalker_nav_task: msg.state || null });
              if (cb) cb({ status: 'ok' });
              return;
            }
            if (msg.type === 'SLEEPWALKER_SESSION_STATE_GET') {
              const s = readStore('sw_session_', ['sleepwalker_nav_task']);
              if (cb) cb({ state: s.sleepwalker_nav_task || null });
              return;
            }
            if (msg.type === 'SLEEPWALKER_SESSION_STATE_CLEAR') {
              try { localStorage.removeItem('sw_session_sleepwalker_nav_task'); } catch (_e) {}
              if (cb) cb({ status: 'ok' });
              return;
            }
            fetch(BASE + '/sw-message', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(msg)
            })
              .then((r) => r.json())
              .then((data) => { if (cb) cb(data); })
              .catch(() => { if (cb) cb({ status: 'fallback' }); });
          }
        },
        storage: {
          local: {
            get: (keys, cb) => {
              const out = readStore('sw_local_', keys);
              if (cb) cb(out);
            },
            set: (obj, cb) => {
              writeStore('sw_local_', obj);
              if (cb) cb();
            }
          },
          session: {
            get: (keys, cb) => {
              const out = readStore('sw_session_', keys);
              if (cb) cb(out);
            },
            set: (obj, cb) => {
              writeStore('sw_session_', obj);
              if (cb) cb();
            }
          },
          onChanged: { addListener: () => {} }
        }
      };

      // Automatically inject extension scripts + ui.css once DOM is ready, mimicking MV3 content script lifecycle
      async function bootExtensionScripts() {
        const errors = [];
        const scripts = ${JSON.stringify(EXTENSION_SCRIPTS)};
        for (const src of scripts) {
          await new Promise((res) => {
            const s = document.createElement('script');
            s.src = BASE + '/' + src;
            s.async = false;
            s.onload = () => res();
            s.onerror = () => { errors.push(src); res(); };
            (document.head || document.documentElement).appendChild(s);
          });
        }
        window.__SW_LOAD_ERRORS__ = errors;
        try {
          const cssText = await fetch(BASE + '/ui.css').then((r) => r.text());
          if (window.SW_UI && window.SW_UI._orb) {
            window.SW_UI._orb.injectCssText(cssText);
          }
        } catch (_e) {}
        if (window.__SLEEPWALKER_INSTANCE__ && window.__SLEEPWALKER_INSTANCE__._bootPromise) {
          await window.__SLEEPWALKER_INSTANCE__._bootPromise;
        }
        window.__SW_TEST_BOOTED__ = true;
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { bootExtensionScripts(); });
      } else {
        bootExtensionScripts();
      }
    })();
  `;
}

async function waitForExtensionBoot(cdp, sid, expectedUrlSub = '') {
  for (let i = 0; i < 80; i++) {
    const info = await cdp.eval(sid, `({
      booted: Boolean(window.__SW_TEST_BOOTED__),
      hasInst: Boolean(window.__SLEEPWALKER_INSTANCE__),
      href: window.location.href,
      errs: window.__SW_LOAD_ERRORS__ || []
    })`).catch(() => null);
    if (info && info.booted && (!expectedUrlSub || info.href.includes(expectedUrlSub))) {
      if (!info.hasInst) {
        throw new Error('Scripts booted without Sleepwalker instance! Load errors: ' + JSON.stringify(info.errs));
      }
      return true;
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for Sleepwalker extension scripts to boot');
}

async function runTests() {
  console.log('=== Sleepwalker Acceptance & Persistence E2E Test Suite ===\n');

  if (!fs.existsSync(CHROME_BIN)) {
    throw new Error(`Google Chrome not found at ${CHROME_BIN}`);
  }

  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const userDataDir = fs.mkdtempSync(path.join(__dirname, 'chrome-accept-'));
  let proc = null;
  let cdp = null;

  try {
    const launched = await launchChrome(userDataDir);
    proc = launched.proc;
    cdp = new CDPClient(launched.wsUrl);
    await cdp.connect();

    const targetRes = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const targetId = targetRes.targetId;
    const attachRes = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sid = attachRes.sessionId;

    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: buildPreloadBootstrap(baseUrl)
    }, sid);

    // Clear storage first on china.html
    await cdp.send('Page.navigate', { url: `${baseUrl}/china.html` }, sid);
    await waitForExtensionBoot(cdp, sid, '/china.html');
    await cdp.eval(sid, `localStorage.clear(); window.__SW_TEST_BOOTED__ = false;`);
    await cdp.send('Page.reload', {}, sid);
    await waitForExtensionBoot(cdp, sid, '/china.html');

    // ------------------------------------------------------------------
    // SUITE 1: Voice Reliability State Machine (Phase 1)
    // ------------------------------------------------------------------
    const voiceReliability = await cdp.eval(sid, `(async () => {
      const v = window.__SLEEPWALKER_INSTANCE__.voice;
      const beforeStarts = window.__SW_SR_LOG__.startCalls;

      // 1. Single instance guard on repeated startListening() calls
      v.startListening();
      v.startListening();
      const afterDoubleStart = window.__SW_SR_LOG__.startCalls;

      // 2. Duplicate command suppression within 1200ms
      let cmdCount = 0;
      const origOnCmd = v.onCommand;
      const seen = [];
      v.onCommand = (parsed) => { cmdCount += 1; seen.push(parsed.raw); };
      v._emitCommandDeduped('explain this page', { confidence: 0.9 });
      v._emitCommandDeduped('Explain this page!', { confidence: 0.9 });
      const dedupCount = cmdCount;

      // 3. Uncommitted interim preserved across unexpected onend()
      v.lastInterim = 'search for quantum';
      v._intentionalStop = false;
      v.isPaused = false;
      v.isListening = true;
      v.recognition.emitEnd();
      const interimCommitted = seen.includes('search for quantum');

      // 4. Recoverable error ('network') sets lifecycle 'recovering' without crashing
      v.onCommand = origOnCmd;
      v._restartAttempts = 0;
      v.isListening = true;
      v.recognition.emitError('network');
      const stateAfterNet = v.lifecycleState;

      v.stopListening();
      return {
        singleStartGuarded: (afterDoubleStart - beforeStarts) === 1,
        dedupCount,
        interimCommitted,
        stateAfterNet
      };
    })()`);

    assert.strictEqual(voiceReliability.singleStartGuarded, true, 'Duplicate startListening() must not call recognition.start() twice');
    assert.strictEqual(voiceReliability.dedupCount, 1, 'Duplicate command within 1200ms must be deduplicated');
    assert.strictEqual(voiceReliability.interimCommitted, true, 'Interim speech must commit on unexpected recognition end');
    assert.strictEqual(voiceReliability.stateAfterNet, 'recovering', 'Recoverable network error must transition cleanly to recovering');
    console.log('PASS  Suite 1: Voice State Machine, Single-Instance Guard, Deduplication, Interim Commit & Error Recovery');

    // Reset clean for Final Acceptance Scenario
    await cdp.eval(sid, `localStorage.clear(); window.__SW_TEST_BOOTED__ = false;`);
    await cdp.send('Page.reload', {}, sid);
    await waitForExtensionBoot(cdp, sid, '/china.html');

    // ------------------------------------------------------------------
    // SUITE 2: 18-Step Final Acceptance Test (China Scenario Across Navigation & Rest/Wake)
    // ------------------------------------------------------------------
    // Step 1-2: Idle initially, then press real Alt+S
    const beforeWake = await cdp.eval(sid, `({ uiState: window.SW_UI.getState(), url: window.location.pathname })`);
    assert.strictEqual(beforeWake.uiState, 'idle');

    await cdp.eval(sid, `(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', altKey: true, bubbles: true, cancelable: true }));
    })()`);
    await sleep(120);
    const afterWake = await cdp.eval(sid, `({
      uiState: window.SW_UI.getState(),
      active: window.__SLEEPWALKER_INSTANCE__.dialogue.isActive(),
      sessionMode: window.__SLEEPWALKER_INSTANCE__.memory.getSessionMode()
    })`);
    assert.strictEqual(afterWake.uiState, 'listening', 'Alt+S must wake Sleepwalker into listening state');
    assert.strictEqual(afterWake.active, true);
    assert.strictEqual(afterWake.sessionMode, 'active_listening');

    // Step 3-4: Ask "Tell me about China."
    const chinaAns = await cdp.eval(sid, `window.__SW_SAY__('Tell me about China.')`);
    await sleep(750);
    assert.ok(chinaAns && chinaAns.answer && /China|East Asia|Beijing/i.test(chinaAns.answer), `Expected China overview answer, got: ${JSON.stringify(chinaAns)}`);
    const chinaTopicState = await cdp.eval(sid, `({
      topic: window.__SLEEPWALKER_INSTANCE__.memory.state.currentTopic,
      place: window.__SLEEPWALKER_INSTANCE__.memory.state.currentEntities.place
    })`);
    assert.strictEqual(chinaTopicState.place, 'China');

    // Step 5-9: Ask "How can I travel there?" -> resolves "there" = "China" -> triggers OFF_PAGE_RESEARCH
    const travelRes = await cdp.eval(sid, `window.__SW_SAY__('How can I travel there?')`);
    await sleep(300);
    assert.strictEqual(travelRes.centralIntent, 'OFF_PAGE_RESEARCH', `Expected OFF_PAGE_RESEARCH, got: ${JSON.stringify(travelRes)}`);
    assert.ok(travelRes.resolvedContext && travelRes.resolvedContext.resolvedEntity === 'China', 'Coreference "there" must resolve to China');
    assert.ok(/China/i.test(travelRes.answer) && /visa|flight|travel/i.test(travelRes.answer), 'Off-page research must synthesize travel & visa guidance for China');
    assert.ok(Array.isArray(travelRes.recommendedUrls) && travelRes.recommendedUrls.length >= 1, 'Off-page research must recommend official/travel URLs');

    // Step 10-12: User asks to open relevant travel website -> Chrome navigates to /travel-guide.html & auto-restores orb!
    const navRes = await cdp.eval(sid, `window.__SW_SAY__('Open the travel website')`);
    assert.strictEqual(navRes.centralIntent, 'EXTERNAL_NAVIGATION');
    assert.strictEqual(navRes.status, 'navigating_external');

    // Wait for real navigation to complete in Chromium
    let onTravelPage = false;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const curPath = await cdp.eval(sid, `window.location.pathname`).catch(() => '');
      if (curPath === '/travel-guide.html') {
        onTravelPage = true;
        break;
      }
    }
    assert.strictEqual(onTravelPage, true, 'Browser must navigate to /travel-guide.html?destination=China');
    await waitForExtensionBoot(cdp, sid, '/travel-guide.html');
    await sleep(150);

    const postNavState = await cdp.eval(sid, `({
      href: window.location.href,
      uiState: window.SW_UI.getState(),
      dialogueActive: window.__SLEEPWALKER_INSTANCE__.dialogue.isActive(),
      sessionMode: window.__SLEEPWALKER_INSTANCE__.memory.getSessionMode(),
      topic: window.__SLEEPWALKER_INSTANCE__.memory.state.currentTopic,
      cardType: window.SW_UI.getCardType()
    })`);
    assert.notStrictEqual(postNavState.uiState, 'idle', 'Orb/UI MUST auto-restore automatically after cross-page navigation!');
    assert.strictEqual(postNavState.dialogueActive, true, 'Dialogue session MUST remain active across navigation!');
    assert.strictEqual(postNavState.sessionMode, 'active_listening');
    assert.strictEqual(postNavState.topic, 'China');

    // Step 13-14: Ask follow-up question on the NEW website
    const followUpRes = await cdp.eval(sid, `window.__SW_SAY__('What documents do I need?')`);
    await sleep(750);
    assert.ok(followUpRes.resolvedContext && followUpRes.resolvedContext.isFollowUp, 'Follow-up on new page must inherit China travel context');
    assert.ok(/China/i.test(followUpRes.resolvedContext.resolvedText), `Resolved follow-up should include China: ${followUpRes.resolvedContext.resolvedText}`);
    assert.ok(followUpRes.answer && /passport|visa|round-trip|hotel/i.test(followUpRes.answer), `Expected visa document answer on new page, got: ${followUpRes.answer}`);

    // Step 15: User says "Thank you, you can rest." -> enters resting state (preserving memory & task)
    const restRes = await cdp.eval(sid, `window.__SW_SAY__('Thank you, you can rest.')`);
    assert.strictEqual(restRes.status, 'session_resting');
    const restingState = await cdp.eval(sid, `({
      active: window.__SLEEPWALKER_INSTANCE__.dialogue.isActive(),
      resting: window.__SLEEPWALKER_INSTANCE__.dialogue.resting,
      mode: window.__SLEEPWALKER_INSTANCE__.memory.getSessionMode(),
      hasTask: Boolean(window.__SLEEPWALKER_INSTANCE__.memory.state.activeTask)
    })`);
    assert.strictEqual(restingState.active, false);
    assert.strictEqual(restingState.resting, true);
    assert.strictEqual(restingState.mode, 'resting');
    assert.strictEqual(restingState.hasTask, true, 'Resting state MUST preserve activeTask in memory');

    // Wait past rest dissolve & reload page to verify cold reload wake from resting state!
    await cdp.eval(sid, `window.__SW_TEST_BOOTED__ = false;`);
    await cdp.send('Page.reload', {}, sid);
    await waitForExtensionBoot(cdp, sid, '/travel-guide.html');

    // Step 16-18: Press Alt+S later -> wakes up remembering China task -> "Continue where we left off." -> resumes naturally!
    await cdp.eval(sid, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', altKey: true, bubbles: true, cancelable: true }));`);
    await sleep(150);
    const wakeUpState = await cdp.eval(sid, `({
      uiState: window.SW_UI.getState(),
      lastReply: window.__SLEEPWALKER_INSTANCE__.dialogue.lastSpokenText,
      pendingLabel: window.__SLEEPWALKER_INSTANCE__.dialogue.pendingPrompt && window.__SLEEPWALKER_INSTANCE__.dialogue.pendingPrompt.label
    })`);
    assert.ok(['speaking', 'listening'].includes(wakeUpState.uiState), `Expected active speaking or listening UI on wake, got: ${wakeUpState.uiState}`);
    assert.ok(/Welcome back/i.test(wakeUpState.lastReply) && /China/i.test(wakeUpState.lastReply), `Wake greeting should recall China task, got: "${wakeUpState.lastReply}"`);

    const resumeRes = await cdp.eval(sid, `window.__SW_SAY__('Continue where we left off.')`);
    assert.strictEqual(resumeRes.status, 'resumed_task');
    assert.ok(resumeRes.res && resumeRes.res.status === 'resumed' && /China/i.test(resumeRes.res.message));

    console.log('PASS  Suite 2: Full 18-Step Final Acceptance Scenario (China -> Travel Off-Page Research -> Cross-Page Auto-Restore -> Follow-Up -> Rest -> Reload -> Alt+S Wake -> Continue)');

    // ------------------------------------------------------------------
    // SUITE 3: Section Navigation & Page Understanding on University Portal
    // ------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `${baseUrl}/university.html` }, sid);
    await waitForExtensionBoot(cdp, sid, '/university.html');

    const uniEligibility = await cdp.eval(sid, `window.__SW_SAY__('Find the section about eligibility')`);
    assert.strictEqual(uniEligibility.centralIntent, 'PAGE_NAVIGATION');
    assert.ok(/Eligibility/i.test(uniEligibility.section || ''), `Expected Eligibility section, got: ${JSON.stringify(uniEligibility)}`);
    const uniApp = await cdp.eval(sid, `window.__SW_SAY__('Go to the application section')`);
    assert.strictEqual(uniApp.centralIntent, 'PAGE_NAVIGATION');
    assert.ok(/Application/i.test(uniApp.section || ''), `Expected Application Process section, got: ${JSON.stringify(uniApp)}`);
    const uniReq = await cdp.eval(sid, `window.__SW_SAY__('What does this page say about admission requirements?')`);
    await sleep(750);
    assert.ok(uniReq.answer && /transcripts|IELTS|TOEFL/i.test(uniReq.answer), `Expected admission requirements from page, got: ${uniReq.answer}`);
    console.log('PASS  Suite 3: Section Navigation ("eligibility", "application") & Page-Grounded Q&A ("admission requirements")');

    // ------------------------------------------------------------------
    // SUITE 4: Ordinal Coreference Comparison & Critical Confirmation Gate
    // ------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `${baseUrl}/laptops.html` }, sid);
    await waitForExtensionBoot(cdp, sid, '/laptops.html');

    const cmpRes = await cdp.eval(sid, `window.__SW_SAY__('Compare the second one with this')`);
    assert.strictEqual(cmpRes.centralIntent, 'MULTI_STEP_TASK');
    assert.ok(/MacBook Air M4/i.test(cmpRes.answer), `Expected ordinal "the second one" -> "MacBook Air M4", got: ${cmpRes.answer}`);

    const bookSafety = await cdp.eval(sid, `(async () => {
      const p = window.__SW_SAY__('Help me book flights to China');
      await new Promise((r) => setTimeout(r, 80));
      const awaiting = window.__SLEEPWALKER_INSTANCE__.confirm.isAwaiting();
      if (awaiting) window.__SLEEPWALKER_INSTANCE__.confirm.cancel('user_denied');
      await p;
      return { awaiting };
    })()`);
    assert.strictEqual(bookSafety.awaiting, true, 'Booking/payment requests MUST pause and require explicit user confirmation');
    console.log('PASS  Suite 4: Ordinal Coreference ("the second one" -> MacBook Air M4) & Explicit Safety Confirmation');

    // ------------------------------------------------------------------
    // SUITE 5: 10+ Meaningful Activities Persistence, Real Hybrid Embeddings & Privacy Filter
    // ------------------------------------------------------------------
    const memoryAudit = await cdp.eval(sid, `(async () => {
      const m = window.__SLEEPWALKER_INSTANCE__.memory;
      // Add extra queries so we exceed 10+ persisted meaningful activities
      await window.__SW_SAY__('What are the visa fees for China?');
      await window.__SW_SAY__('Compare ThinkPad with MacBook');
      await window.__SW_SAY__('My password is SecretDemoPass#987 and OTP is 482910');
      await new Promise((r) => setTimeout(r, 150));

      const acts = m.state.activities;
      const retrievedTravel = m.retrieveRelevantMemories('tourist visa flights for Beijing China', { topK: 3 });

      // Test live Ollama /api/embed (gracefully falls back if nomic-embed-text missing or offline)
      const embRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_EMBED_REQUEST', text: 'China travel visa requirements' }, resolve);
      });

      return {
        activityCount: acts.length,
        hasSecretLeak: JSON.stringify(m.state).includes('SecretDemoPass#987') || JSON.stringify(m.state).includes('482910'),
        topRetrievedTopic: retrievedTravel[0] && retrievedTravel[0].activity ? retrievedTravel[0].activity.topic : '',
        topScore: retrievedTravel[0] ? retrievedTravel[0].score : 0,
        visitedCount: m.state.visitedPages.length,
        embedStatus: embRes ? embRes.status : 'none',
        embedDim: embRes && Array.isArray(embRes.embedding) ? embRes.embedding.length : 0
      };
    })()`);

    assert.ok(memoryAudit.activityCount >= 10, `Expected >= 10 persisted activities, got ${memoryAudit.activityCount}`);
    assert.strictEqual(memoryAudit.hasSecretLeak, false, 'Sensitive passwords/OTPs must NEVER be stored in memory!');
    assert.ok(memoryAudit.visitedCount >= 3, `Expected >= 3 visited pages tracked across navigations, got ${memoryAudit.visitedCount}`);
    assert.ok(/China/i.test(memoryAudit.topRetrievedTopic), `Hybrid semantic retrieval should surface China memory first, got topic: ${memoryAudit.topRetrievedTopic}`);
    console.log(`PASS  Suite 5: 10+ Activities (${memoryAudit.activityCount} stored), Hybrid Semantic Retrieval (score=${memoryAudit.topScore}, ollamaEmbed=${memoryAudit.embedStatus}/${memoryAudit.embedDim}d) & Privacy Guard`);

    console.log('\nSummary: 5/5 Acceptance & Persistence E2E suites passed in real Google Chrome!');
  } finally {
    if (cdp) cdp.close();
    if (proc) {
      try { proc.kill('SIGKILL'); } catch (_e) {}
    }
    server.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_e) {}
  }
}

runTests().catch((err) => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
