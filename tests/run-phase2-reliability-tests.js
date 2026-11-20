/**
 * Sleepwalker 2.0 Phase 2 — Reliability, Voice Queueing, Conversations A/B/C,
 * Intent Routing, Dead-Model Caching & Privacy Diagnostics Suite.
 *
 * Tier 1: Pure Node checks (diagnostics scrubbing, LLM 404 dead-model cache, embed 60s skip).
 * Tier 2: Real Headless Chrome via CDP running ALL real extension scripts on a local portal.
 *
 * Run with: node D:\sleep\tests\run-phase2-reliability-tests.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function findChromeBinary() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe')
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('No Chrome/Chromium binary found for CDP suite');
}

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

const PORTAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>University Admissions &amp; Course Portal</title></head>
<body style="min-height:2400px;font-family:system-ui,sans-serif;">
  <main style="padding:24px;max-width:860px;margin:auto;">
    <h1>Graduate Admissions &amp; Course Catalog</h1>
    <form role="search" action="/search" method="get" id="site-search-form" onsubmit="event.preventDefault(); window.__LAST_SITE_SEARCH__ = document.getElementById('portal-search').value;">
      <label for="portal-search">Search courses and programs</label>
      <input id="portal-search" type="search" name="q" placeholder="Search courses on this website..." />
      <button type="submit" id="portal-search-btn">Search</button>
    </form>
    <p>Explore engineering programs, Python courses, and admissions guides.</p>
    <div style="height:550px;"></div>
    <section id="sec-elig">
      <h2>Eligibility Requirements</h2>
      <p>Applicants must hold a recognized Bachelor degree in computer science or engineering with official academic transcripts and language proficiency documentation.</p>
    </section>
    <div style="height:550px;"></div>
    <section id="sec-apply">
      <h2>Application Instructions</h2>
      <p>Prepare your statement of purpose, letters of recommendation, and verify deadlines on the official application website.</p>
      <a href="/apply-portal">Official Application Portal</a>
    </section>
  </main>
</body>
</html>`;

async function runNodeUnitChecks() {
  console.log('--- Tier 1: Node Unit & Caching Checks ---');

  // Ensure globals for browser modules in Node
  global.window = global;
  global.self = global;
  if (!global.navigator) {
    Object.defineProperty(global, 'navigator', { value: { language: 'en-IN' }, configurable: true });
  }
  const diagMod = require(path.join(ROOT, 'diagnostics.js'));
  const llm = require(path.join(ROOT, 'llm.js'));

  // 1. Diagnostics privacy scrubber
  const scrubbed = diagMod.scrubText(
    'My password is SuperSecret99 and OTP 482910 token Bearer eyJhbGciOi.123 card 4111 2222 3333 4444 PAN ABCDE1234F Aadhaar 1234 5678 9012'
  );
  assert.strictEqual(/SuperSecret99|482910|eyJhbGciOi|4111 2222|ABCDE1234F|1234 5678 9012/.test(scrubbed), false, `Sensitive values leaked in scrubText: ${scrubbed}`);
  assert.ok(scrubbed.includes('[REDACTED]'), 'Scrubber should replace sensitive tokens with [REDACTED]');
  console.log('PASS  Tier 1.1: Diagnostics scrubText redacts passwords, OTPs, tokens, cards, PAN & Aadhaar');

  // 2. Gemini 404 DEAD_GEMINI_MODELS caching & 60s embed skip
  const origFetch = global.fetch;
  llm.resetLlmStateForTests();
  const hitUrls = [];
  global.chrome = {
    storage: {
      local: {
        get(_keys, cb) { cb({ sleepwalker_gemini_api_key: 'AIzaTestKey123456', sleepwalker_gemini_model: 'gemini-2.5-flash-lite' }); },
        set(_obj, cb) { if (cb) cb(); }
      },
      session: {
        get(_keys, cb) { cb({}); },
        set(_obj, cb) { if (cb) cb(); }
      }
    }
  };
  global.fetch = async (url, _opts) => {
    const u = String(url);
    hitUrls.push(u);
    if (u.includes('gemini-2.5-flash-lite')) {
      return { ok: false, status: 404, async text() { return 'Model not found'; } };
    }
    if (u.includes('gemini-flash-lite-latest')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: 'Grounded local portal answer.' }) }] } }] };
        }
      };
    }
    throw new Error('ECONNREFUSED');
  };

  try {
    await llm.handleExplainRequest({
      mode: 'qa',
      query: 'What is the requirement?',
      pageDigest: { pageTextHash: 'h1', url: 'https://example.org', title: 'Test', wordCount: 50, headings: [], chunks: [{ section: 'Intro', text: 'Bachelor degree required.' }] }
    });
    const firstCall404Count = hitUrls.filter((u) => u.includes('gemini-2.5-flash-lite')).length;
    assert.strictEqual(firstCall404Count, 1, 'First call should hit dead model once');

    hitUrls.length = 0;
    await llm.handleExplainRequest({
      mode: 'qa',
      query: 'How to apply here?',
      pageDigest: { pageTextHash: 'h2', url: 'https://example.org', title: 'Test', wordCount: 50, headings: [], chunks: [{ section: 'Apply', text: 'Submit application online.' }] }
    });
    const secondCall404Count = hitUrls.filter((u) => u.includes('gemini-2.5-flash-lite')).length;
    assert.strictEqual(secondCall404Count, 0, 'DEAD_GEMINI_MODELS must skip previously 404d model on subsequent calls!');

    // Test 60s embed unavailability cache
    hitUrls.length = 0;
    const emb1 = await llm.handleEmbedRequest({ text: 'test embed unavailable', ollamaUrl: 'http://127.0.0.1:59999' });
    const tagsAfter1 = hitUrls.length;
    const tEmb0 = Date.now();
    const emb2 = await llm.handleEmbedRequest({ text: 'second embed check', ollamaUrl: 'http://127.0.0.1:59999' });
    const emb2Ms = Date.now() - tEmb0;
    assert.strictEqual(emb1.status, 'ollama_unavailable');
    assert.strictEqual(emb2.status, 'ollama_unavailable');
    assert.strictEqual(hitUrls.length, tagsAfter1, 'Second embed call within 60s must NOT re-poll /api/tags');
    assert.ok(emb2Ms < 20, `Cached unavailable check should return immediately, took ${emb2Ms}ms`);
    console.log(`PASS  Tier 1.2: DEAD_GEMINI_MODELS skips 404 model (0 wasted fetches) & embed unavailability cache returns in ${emb2Ms}ms`);
  } finally {
    global.fetch = origFetch;
  }
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
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
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
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (res.exceptionDetails) {
      throw new Error('Eval exception: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result ? res.result.value : undefined;
  }
  close() { if (this.ws) this.ws.close(); }
}

function buildPreloadBootstrap(baseUrl) {
  return `
    (function () {
      const BASE = ${JSON.stringify(baseUrl)};
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
          if (window.__SW_SR_LOG__.active) throw new Error('InvalidStateError: already started');
          window.__SW_SR_LOG__.active = true;
          if (typeof this.onstart === 'function') this.onstart();
        }
        stop() {
          window.__SW_SR_LOG__.stopCalls += 1;
          const wasActive = window.__SW_SR_LOG__.active;
          window.__SW_SR_LOG__.active = false;
          if (wasActive && typeof this.onend === 'function') this.onend();
        }
        emitError(errName) {
          window.__SW_SR_LOG__.active = false;
          if (typeof this.onerror === 'function') this.onerror({ error: errName });
          if (typeof this.onend === 'function') this.onend();
        }
        emitResult(transcript, isFinal = true, confidence = 0.96) {
          if (typeof this.onresult !== 'function') return;
          const results = [{ isFinal, length: 1, 0: { transcript, confidence } }];
          this.onresult({ resultIndex: 0, results });
        }
      }
      window.SpeechRecognition = MockSR;
      window.webkitSpeechRecognition = MockSR;

      window.__SW_SPOKEN__ = [];
      try {
        window.speechSynthesis.cancel = () => {};
        window.speechSynthesis.speak = (u) => {
          window.__SW_SPOKEN__.push(String(u && u.text || ''));
          setTimeout(() => { if (u && typeof u.onend === 'function') u.onend(); }, 5);
        };
      } catch (_e) {}

      async function bridgeCall(path, payload) {
        const r = await fetch(BASE + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {})
        });
        return r.json();
      }
      window.chrome = window.chrome || {};
      window.chrome.runtime = {
        lastError: null,
        getURL: (p) => BASE + '/ext/' + String(p || '').replace(/^\\/+/, ''),
        onMessage: { addListener() {} },
        sendMessage(msg, cb) {
          const reply = (res) => { if (typeof cb === 'function') setTimeout(() => cb(res), 0); };
          if (!msg || !msg.type) return reply(null);
          if (msg.type === 'SLEEPWALKER_MEMORY_GET') { bridgeCall('/api/mem_get', msg).then(reply); return true; }
          if (msg.type === 'SLEEPWALKER_MEMORY_SET') { bridgeCall('/api/mem_set', msg).then(reply); return true; }
          if (msg.type === 'SLEEPWALKER_EMBED_REQUEST') { bridgeCall('/api/embed', msg).then(reply); return true; }
          if (msg.type === 'SLEEPWALKER_OFF_PAGE_RESEARCH_REQUEST') { reply({ status: 'offline' }); return true; }
          if (msg.type === 'SLEEPWALKER_INTENT_REQUEST') { reply({ status: 'fallback' }); return true; }
          if (msg.type === 'SLEEPWALKER_EXPLAIN_REQUEST') { reply({ status: 'fallback_needed', reason: 'test_local_fast' }); return true; }
          if (msg.type === 'SLEEPWALKER_PICK_LINK_REQUEST' || msg.type === 'SLEEPWALKER_SEARCH_SELECT') { reply({ status: 'fallback' }); return true; }
          reply({ status: 'ok' });
          return false;
        }
      };
      window.chrome.storage = {
        local: {
          get(keys, cb) {
            bridgeCall('/api/storage_get', { scope: 'local', keys }).then((d) => cb(d.data || {}));
          },
          set(obj, cb) {
            bridgeCall('/api/storage_set', { scope: 'local', items: obj }).then(() => { if (cb) cb(); });
          }
        },
        session: {
          get(keys, cb) {
            bridgeCall('/api/storage_get', { scope: 'session', keys }).then((d) => cb(d.data || {}));
          },
          set(obj, cb) {
            bridgeCall('/api/storage_set', { scope: 'session', items: obj }).then(() => { if (cb) cb(); });
          }
        },
        onChanged: { addListener() {} }
      };
    })();
  `;
}

async function runChromeReliabilitySuites() {
  console.log('\n--- Tier 2: Real Headless Chrome CDP Reliability Suites ---');

  const store = { local: {}, session: {} };
  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && reqPath.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const parsed = body ? JSON.parse(body) : {};
        res.setHeader('Content-Type', 'application/json');
        if (reqPath === '/api/mem_get') {
          res.end(JSON.stringify({ memoryState: store.local.sleepwalker_persistent_memory_v1 || null, sessionState: store.session.sleepwalker_session_state_v1 || null }));
          return;
        }
        if (reqPath === '/api/mem_set') {
          if (parsed.memoryState) store.local.sleepwalker_persistent_memory_v1 = parsed.memoryState;
          if (parsed.sessionState) store.session.sleepwalker_session_state_v1 = parsed.sessionState;
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        if (reqPath === '/api/storage_get') {
          const bag = store[parsed.scope || 'local'] || {};
          const keys = parsed.keys;
          const out = {};
          if (!keys) Object.assign(out, bag);
          else if (typeof keys === 'string') { if (bag[keys] !== undefined) out[keys] = bag[keys]; }
          else if (Array.isArray(keys)) keys.forEach((k) => { if (bag[k] !== undefined) out[k] = bag[k]; });
          else Object.keys(keys).forEach((k) => { out[k] = bag[k] !== undefined ? bag[k] : keys[k]; });
          res.end(JSON.stringify({ data: out }));
          return;
        }
        if (reqPath === '/api/storage_set') {
          const bag = store[parsed.scope || 'local'] || (store[parsed.scope || 'local'] = {});
          Object.assign(bag, parsed.items || {});
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        res.end(JSON.stringify({ status: 'unavailable' }));
      });
      return;
    }
    if (reqPath === '/apply-portal') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Application Portal</title></head><body><h1>Official Application Portal</h1></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PORTAL_HTML);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-phase2-cdp-'));
  const chromeBin = findChromeBinary();

  let proc = null;
  let cdp = null;
  try {
    proc = spawn(chromeBin, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank'
    ]);

    const wsUrl = await new Promise((resolve, reject) => {
      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) resolve(m[1]);
      });
      proc.on('error', reject);
      setTimeout(() => reject(new Error('Chrome startup timeout: ' + stderr)), 12000);
    });

    cdp = new CDPClient(wsUrl);
    await cdp.connect();
    const { targetId } = await cdp.send('Target.createTarget', { url: `${baseUrl}/` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await new Promise((r) => setTimeout(r, 350));

    async function injectAll() {
      await cdp.eval(sessionId, buildPreloadBootstrap(baseUrl));
      for (const file of EXTENSION_SCRIPTS) {
        const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
        await cdp.eval(sessionId, code);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await injectAll();

    // --------------------------------------------------------------
    // Suite 1: Voice Reliability — Wake Prefix, FIFO Queue, Error Cap & Tab Handoff
    // --------------------------------------------------------------
    const voiceChecks = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      const v = ctrl.voice;

      // 1a. Wake-word prefix stripping
      const stripped1 = v.stripWakePrefix('Sleepwalker, find information about Germany.');
      const stripped2 = v.stripWakePrefix('Hey Sleepwalker search for Python');

      // 1b. Concurrent rapid commands queued strictly FIFO
      const p1 = ctrl.handleUserInput('Find universities in Germany.', 'voice');
      const p2 = ctrl.handleUserInput('Compare their admission requirements.', 'voice');
      const p3 = ctrl.handleUserInput('What about the second one?', 'voice');
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      // 1c. SpeechRecognition error recovery cap & recreation
      const beforeInstances = window.__SW_SR_LOG__.instances.length;
      v.startListening(); // start listening
      await new Promise((r) => setTimeout(r, 80));
      const sr1 = window.__SW_SR_LOG__.instances[window.__SW_SR_LOG__.instances.length - 1];
      sr1.emitError('aborted');
      await new Promise((r) => setTimeout(r, 320));
      const sr2 = window.__SW_SR_LOG__.instances[window.__SW_SR_LOG__.instances.length - 1];
      sr2.emitError('aborted');
      await new Promise((r) => setTimeout(r, 550));
      const afterRecreateInstances = window.__SW_SR_LOG__.instances.length;

      // Tab switch pause & resume
      const pausedOk = v.pauseForTabSwitch();
      const pausedState = v.lifecycleState;
      const pausedFlag = v._pausedForTab;
      await new Promise((r) => setTimeout(r, 60));
      const resumedOk = v.resumeForTabSwitch();
      await new Promise((r) => setTimeout(r, 120));
      const resumedState = v.lifecycleState;
      const resumedFlag = v._pausedForTab;
      v.stopListening();

      return {
        stripped1,
        stripped2,
        r1Topic: r1 && r1.topic,
        r1Ans: r1 && r1.answer,
        r2Ans: r2 && r2.answer,
        r3Focus: ctrl.memory.state.currentEntities && ctrl.memory.state.currentEntities.focusedEntity,
        r3PickedIdx: ctrl.memory.state.currentEntities && ctrl.memory.state.currentEntities.lastPickedIndex,
        r3Ans: r3 && r3.answer,
        beforeInstances,
        afterRecreateInstances,
        pausedOk,
        pausedState,
        pausedFlag,
        resumedOk,
        resumedState,
        resumedFlag
      };
    })()`);

    assert.strictEqual(voiceChecks.stripped1.toLowerCase(), 'find information about germany.');
    assert.strictEqual(voiceChecks.stripped2.toLowerCase(), 'search for python');
    assert.ok(/Germany/i.test(voiceChecks.r1Topic), `Expected Germany topic, got ${voiceChecks.r1Topic}`);
    assert.ok(/Technical University of Munich/i.test(voiceChecks.r1Ans) && /LMU Munich/i.test(voiceChecks.r1Ans), 'Should return German universities list');
    assert.ok(/LMU Munich|Ludwig Maximilian/i.test(voiceChecks.r3Focus), `FIFO queue must leave focus on #2 LMU Munich, got: ${voiceChecks.r3Focus}`);
    assert.ok(voiceChecks.afterRecreateInstances > voiceChecks.beforeInstances, 'Repeated aborted errors should trigger _recreateRecognition()');
    assert.strictEqual(voiceChecks.pausedOk, true);
    assert.strictEqual(voiceChecks.pausedState, 'paused');
    assert.strictEqual(voiceChecks.pausedFlag, true);
    assert.strictEqual(voiceChecks.resumedOk, true);
    assert.strictEqual(voiceChecks.resumedState, 'listening');
    assert.strictEqual(voiceChecks.resumedFlag, false);
    console.log('PASS  Tier 2.1: Wake-word stripping, FIFO rapid-command queue, SR recreation & tab-switch mic handoff');

    // --------------------------------------------------------------
    // Suite 2: Conversation A ("Open its official website."), Ambiguity Gate, Conversation B & C
    // --------------------------------------------------------------
    const convRes = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;

      // Finish Conversation A: "Open its official website." -> intercept navigation before 150ms redirect closes test target
      let capturedUrl = '';
      const origNav = ctrl._navigateToExternalUrl.bind(ctrl);
      ctrl._navigateToExternalUrl = async (url, title, topic) => {
        capturedUrl = url;
        return { status: 'navigating_external', url, title, topic };
      };
      const convA4 = await ctrl.handleUserInput('Open its official website.', 'voice');
      ctrl._navigateToExternalUrl = origNav;

      // Ambiguity check: reset focus & lastPickedIndex while keeping >= 2 list items
      ctrl.memory.state.currentEntities.focusedEntity = '';
      ctrl.memory.state.currentEntities.lastPickedIndex = -1;
      ctrl.memory.state.currentEntities.listItems = [
        { title: 'Technical University of Munich (TUM)', officialUrl: 'https://www.tum.de/en/' },
        { title: 'Ludwig Maximilian University of Munich (LMU Munich)', officialUrl: 'https://www.lmu.de/en/' }
      ];
      const ambigRes = await ctrl.handleUserInput('Open its official website.', 'voice');

      // Conversation B: China trip -> unrelated quick diversion -> visa for that trip
      const b1 = await ctrl.handleUserInput('I am planning a trip to China.', 'voice');
      const b2Diversion = await ctrl.handleUserInput('Search within this page for eligibility.', 'voice');
      const b3 = await ctrl.handleUserInput('What visa do I need for that trip?', 'voice');

      // Conversation C: Laptops -> Compare the second one with the first one
      const c1 = await ctrl.handleUserInput('Find the best laptops.', 'voice');
      const c2 = await ctrl.handleUserInput('Compare the second one with the first one.', 'voice');

      // Return to earlier task (China trip from before Laptops diversion)
      const b4 = await ctrl.handleUserInput('Return to the earlier task.', 'voice');

      return {
        convA4Url: capturedUrl || (convA4 && convA4.url),
        ambigStatus: ambigRes && ambigRes.status,
        b1,
        b2Diversion,
        b3,
        b4,
        b4Topic: (b4 && b4.topic) || (ctrl.memory.state.activeTask && ctrl.memory.state.activeTask.topic),
        c1Ans: c1 && c1.answer,
        c2Ans: c2 && c2.answer,
        c2Central: c2 && c2.centralIntent
      };
    })()`);

    assert.ok(/uni-lmu|lmu\.de/i.test(convRes.convA4Url), `Possessive "its official website" after #2 must open LMU Munich, got: ${convRes.convA4Url}`);
    assert.strictEqual(convRes.ambigStatus, 'needs_clarification', `Expected needs_clarification when focus ambiguous, got ${convRes.ambigStatus}`);
    assert.strictEqual(convRes.b2Diversion && convRes.b2Diversion.status, 'found_in_page');
    assert.ok(/China|Tourist.*Visa|L Visa/i.test(String(convRes.b3 && convRes.b3.answer)), `Conversation B must recall China trip after brief page search diversion, got b1=${JSON.stringify(convRes.b1)} b3=${JSON.stringify(convRes.b3)}`);
    assert.ok(/China/i.test(convRes.b4Topic || ''), `Returning to earlier task must preserve/restore China topic, got b4=${JSON.stringify(convRes.b4)} b4Topic=${convRes.b4Topic}`);
    assert.strictEqual(convRes.c2Central, 'MULTI_STEP_TASK', `Conversation C must route to MULTI_STEP_TASK, got ${convRes.c2Central}`);
    assert.strictEqual(/could not find clear information/i.test(convRes.c2Ans), false, `Conversation C must genuinely compare options, not say not found: ${convRes.c2Ans}`);
    assert.ok(/ThinkPad X1 Carbon/i.test(convRes.c2Ans) && /MacBook Air/i.test(convRes.c2Ans), `Conversation C must resolve BOTH ordinals ("second one" & "first one"), got: ${convRes.c2Ans}`);
    assert.strictEqual(/\$\d|€\d{3,}/.test(convRes.c1Ans + ' ' + convRes.c2Ans), false, 'Must NOT invent laptop prices!');
    console.log('PASS  Tier 2.2: Conversations A, B, C, multi-ordinal coreference, diversion preservation & ambiguity gate');

    // --------------------------------------------------------------
    // Suite 3: Page Understanding, Section Nav, Fast QA, Privacy Diagnostics & Website Search Form Navigation
    // --------------------------------------------------------------
    const pageNavRes = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;

      const rSec = await ctrl.handleUserInput('Find the section about eligibility.', 'voice');
      await new Promise((r) => setTimeout(r, 120));
      const scrolledY = window.scrollY;

      const tQa0 = performance.now();
      const rExplain = await ctrl.handleUserInput('Explain the requirements on this page.', 'voice');
      const qaMs = Math.round(performance.now() - tQa0);

      // Privacy diagnostic check with sensitive phrase
      await ctrl.handleUserInput('Remember my OTP 771122 please', 'voice');
      const diagReport = ctrl.getDiagnostics();

      return {
        rSecIntent: rSec && rSec.centralIntent,
        scrolledY,
        rExplainAnswer: rExplain && (rExplain.answer || (window.SW_UI && window.SW_UI.lastCard && window.SW_UI.lastCard.text) || ''),
        qaMs,
        diagReport
      };
    })()`);

    assert.strictEqual(pageNavRes.rSecIntent, 'PAGE_NAVIGATION');
    assert.ok(pageNavRes.scrolledY > 200, `Section navigation must scroll to #sec-elig, scrollY=${pageNavRes.scrolledY}`);
    assert.ok(pageNavRes.qaMs < 350, `Explain QA should be fast without 600ms lag (took ${pageNavRes.qaMs}ms)`);
    assert.ok(pageNavRes.diagReport && pageNavRes.diagReport.perf && pageNavRes.diagReport.perf.count >= 6, 'Diagnostics should record turn traces');
    assert.strictEqual(JSON.stringify(pageNavRes.diagReport).includes('771122'), false, 'Diagnostics report must NEVER leak raw OTPs');

    // Now test real Website Search form submission ("Search for Python courses on this website.") -> triggers real browser navigation!
    await cdp.eval(sessionId, `(() => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      setTimeout(() => { ctrl.handleUserInput('Search for Python courses on this website.', 'voice'); }, 30);
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 850));
    const navigatedUrl = await cdp.eval(sessionId, `window.location.href`);

    assert.ok(/\/search\?q=Python/i.test(navigatedUrl), `Real form submission should navigate to /search?q=Python..., got "${navigatedUrl}"`);
    console.log(`PASS  Tier 2.3: Website Search (${navigatedUrl}), Section Nav (scrollY=${Math.round(pageNavRes.scrolledY)}), Fast QA (${pageNavRes.qaMs}ms) & Privacy Diagnostics (avgTotalMs=${pageNavRes.diagReport.perf.avgTotalMs}ms)`);

    console.log('\nSummary: All Phase 2 Node + Headless Chrome CDP Reliability Suites Passed!');
  } finally {
    if (cdp) cdp.close();
    if (proc) {
      try { proc.kill('SIGKILL'); } catch (_e) {}
    }
    server.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
  }
}

async function main() {
  await runNodeUnitChecks();
  await runChromeReliabilitySuites();
}

main().catch((err) => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
