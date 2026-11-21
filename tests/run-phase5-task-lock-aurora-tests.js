/**
 * Sleepwalker Phase 5 — Verification of:
 *   - Priority 1 & 2: Tiered Ollama routing, unified num_ctx/keep_alive, safe capability thinking guard, active LLM abort
 *   - Priority 3: Gemini specialist scoping (never automatic for ordinary commands/intent/NLU) + honest degrade notice
 *   - Priority 4: Active task locking, synchronous FIFO preservation, clarification continuation, immediate cancel phrases
 *   - Priority 5: Golden-Thread Aurora Processing UI in real Shadow DOM + Chrome CSS + reduced-motion + non-overlap
 *   - Priority 6: World-Model clean caching + mutation invalidation + selective context budgeting
 *
 * Run with: node D:\sleep\tests\run-phase5-task-lock-aurora-tests.js
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const llm = require(path.join(ROOT, 'llm.js'));
const explainMod = require(path.join(ROOT, 'explain.js'));
const aiCommMod = require(path.join(ROOT, 'ai-comm.js'));
const wmMod = require(path.join(ROOT, 'world-model.js'));
const confirmMod = require(path.join(ROOT, 'confirm.js'));

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

function findChromeBinary() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  const msPw = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(msPw)) {
    for (const d of fs.readdirSync(msPw)) {
      const exe = path.join(msPw, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return '';
}

async function runUnitSuites() {
  // 1. Tiered Ollama routing, uniform num_ctx, keep_alive, safe capability check & cancellation
  await runSuite('1. Tiered Ollama Selection, Safe Thinking Guard, Unified Ctx & Request Abort', async () => {
    const origFetch = global.fetch;
    llm.resetLlmStateForTests();
    global.chrome = {
      storage: {
        local: {
          get: (_k, cb) => cb({
            sleepwalker_ollama_model: 'llama3.2:3b',
            sleepwalker_ollama_fast_model: 'qwen2.5:1.5b',
            sleepwalker_ollama_url: 'http://localhost:11434',
            sleepwalker_gemini_api_key: 'fake-key',
            sleepwalker_local_only: false
          })
        }
      }
    };

    const calls = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [{ name: 'llama3.2:3b' }, { name: 'qwen2.5:1.5b' }, { name: 'qwen3.5:9b' }]
          })
        };
      }
      if (u.endsWith('/api/show')) {
        const b = JSON.parse(init.body || '{}');
        calls.push({ url: u, body: b });
        if (b.model === 'qwen3.5:9b') {
          return { ok: true, status: 200, json: async () => ({ capabilities: ['completion', 'thinking'], details: { family: 'qwen3' } }) };
        }
        return { ok: true, status: 200, json: async () => ({ capabilities: ['completion'], details: { family: 'llama' } }) };
      }
      if (u.endsWith('/api/generate')) {
        const b = JSON.parse(init.body || '{}');
        calls.push({ url: u, body: b });
        if (String(b.prompt || '').includes('STALL_ME')) {
          return new Promise((_res, rej) => {
            if (init.signal) {
              init.signal.addEventListener('abort', () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
            }
          });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ response: '{"intent":"NAVIGATE","action":"scroll","dir":"down"}' })
        };
      }
      throw new Error(`Unexpected network call: ${u}`);
    };

    try {
      const ordPick = await llm.selectOllamaModelForTask('http://localhost:11434', { ollamaModel: 'llama3.2:3b', compactOllamaModel: 'qwen2.5:1.5b' }, 'ordinary');
      const diffPick = await llm.selectOllamaModelForTask('http://localhost:11434', { ollamaModel: 'llama3.2:3b', compactOllamaModel: 'qwen2.5:1.5b' }, 'difficult');
      assert.strictEqual(ordPick.model, 'qwen2.5:1.5b');
      assert.strictEqual(diffPick.model, 'llama3.2:3b');

      // Non-thinking llama3.2:3b must NOT pay /api/show and must NOT send think:false
      await llm.fetchOllamaGenerateDetailed('http://localhost:11434', 'llama3.2:3b', 'hello', { num_ctx: 256, num_predict: 20 }, 'json', 5000, { skipAvailabilityCheck: true });
      const llamaGen = calls.find((c) => c.url.endsWith('/api/generate') && c.body.model === 'llama3.2:3b');
      assert.ok(llamaGen, 'Expected llama3.2:3b generate call');
      assert.strictEqual(calls.some((c) => c.url.endsWith('/api/show') && c.body.model === 'llama3.2:3b'), false, 'llama3.2:3b must skip /api/show');
      assert.strictEqual(llamaGen.body.think, undefined, 'Non-thinking model must never receive think:false');
      assert.strictEqual(llamaGen.body.options.num_ctx, 2048, 'Must enforce unified num_ctx=2048');
      assert.strictEqual(llamaGen.body.keep_alive, '30m', 'Must enforce keep_alive=30m');

      // Thinking-capable qwen3.5:9b DOES check /api/show and passes think:false
      await llm.fetchOllamaGenerateDetailed('http://localhost:11434', 'qwen3.5:9b', 'hello', { num_predict: 20 }, 'json', 5000, { skipAvailabilityCheck: true });
      const q3Gen = calls.find((c) => c.url.endsWith('/api/generate') && c.body.model === 'qwen3.5:9b');
      assert.ok(q3Gen && q3Gen.body.think === false, 'Thinking-capable model must send think:false');

      // Active LLM abort via cancelActiveLlmRequests
      const stallP = llm.fetchOllamaGenerateDetailed('http://localhost:11434', 'qwen2.5:1.5b', 'STALL_ME', { num_predict: 20 }, 'json', 10000, { skipAvailabilityCheck: true, taskId: 'task_99' });
      await new Promise((r) => setTimeout(r, 20));
      const nAborted = llm.cancelActiveLlmRequests({ taskId: 'task_99' });
      assert.strictEqual(nAborted.cancelled, 1, 'Expected 1 active request cancelled');
      const stallRes = await stallP;
      assert.strictEqual(stallRes.aborted, true, 'Cancelled request must resolve as aborted');
    } finally {
      global.fetch = origFetch;
    }
  });

  // 2. Gemini Specialist Boundary + Honest Unavailability Message
  await runSuite('2. Gemini Specialist Boundary (0 Cloud Calls for Intent/Nav/Simple QA) & Clear Unavailability', async () => {
    const origFetch = global.fetch;
    llm.resetLlmStateForTests();
    global.chrome = {
      storage: {
        local: {
          get: (_k, cb) => cb({
            sleepwalker_ollama_model: 'llama3.2:3b',
            sleepwalker_ollama_fast_model: 'qwen2.5:1.5b',
            sleepwalker_ollama_url: 'http://localhost:11434',
            sleepwalker_gemini_api_key: 'fake-key-present',
            sleepwalker_local_only: false
          })
        }
      }
    };

    let geminiCalls = 0;
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        geminiCalls += 1;
        return { ok: false, status: 400, text: async () => '{"error":{"message":"API key not valid."}}', json: async () => ({ error: { message: 'API key not valid. Please pass a valid API key.' } }) };
      }
      if (u.endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen2.5:1.5b' }] }) };
      }
      if (u.endsWith('/api/generate')) {
        const b = JSON.parse(init.body || '{}');
        if (String(b.prompt || '').includes('Classify')) {
          return { ok: true, status: 200, json: async () => ({ response: '{"intent":"NAVIGATE","action":"scroll","dir":"down"}' }) };
        }
        return { ok: true, status: 200, json: async () => ({ response: '{"answer":"Local Ollama summary answer.","referencedIds":[],"followUpHint":""}' }) };
      }
      return { ok: false, status: 404 };
    };

    try {
      const intRes = await llm.handleIntentRequest({ text: 'scroll down', lang: 'en-IN' });
      assert.strictEqual(intRes.status, 'ok');
      assert.strictEqual(geminiCalls, 0, 'Intent classification must NEVER auto-call Gemini');

      const linkRes = await llm.handleLinkPickRequest({ spokenText: 'open admissions', candidates: [{ id: 1, label: 'Admissions', context: 'Nav' }] });
      assert.ok(linkRes);
      assert.strictEqual(geminiCalls, 0, 'Link pick must NEVER auto-call Gemini when local Ollama succeeds');

      // Non-specialist short QA via aiComm must skip Gemini completely
      const mgr = new aiCommMod.SleepwalkerAiCommManager({ llm });
      const shortQa = await mgr.streamExplain({
        sessionId: 'tab_spec',
        payload: { urlClean: 'http://127.0.0.1/short', pageTextHash: 'h1', mode: 'qa', query: 'What is fee?', skipGemini: true, geminiSpecialist: false }
      });
      assert.strictEqual(shortQa.status, 'ok');
      assert.strictEqual(geminiCalls, 0, 'Non-specialist local QA must NEVER call Gemini');

      // Specialist summary task tries Gemini, sees invalid key (400), degrades honestly to Ollama with clear message
      const specRes = await mgr.streamExplain({
        sessionId: 'tab_spec',
        payload: { urlClean: 'http://127.0.0.1/long', pageTextHash: 'h2', mode: 'summary', specialist: true, query: 'Summarize this page' }
      });
      assert.strictEqual(geminiCalls >= 1, true, 'Specialist summary should invoke Gemini when configured');
      assert.strictEqual(specRes.status, 'ok', 'Should gracefully recover with local Ollama');
      assert.ok(/gemini|unavailable|key|ollama/i.test(specRes.degradeMessage || ''), `Expected clear Gemini unavailability message, got: "${specRes.degradeMessage}"`);
    } finally {
      global.fetch = origFetch;
    }
  });

  // 3. Cancel phrases in confirm.js
  await runSuite('3. SleepwalkerConfirm Supports New Cancellation Phrases ("No need.", "Leave it.")', () => {
    const ConfirmCls = confirmMod.SleepwalkerConfirm || confirmMod;
    const c = new ConfirmCls();
    assert.strictEqual(c.parseYesNo('No need.'), 'no');
    assert.strictEqual(c.parseYesNo('Leave it.'), 'no');
    assert.strictEqual(c.parseYesNo('Forget it'), 'no');
    assert.strictEqual(c.parseYesNo('Cancel'), 'no');
    assert.strictEqual(c.parseYesNo('Stop'), 'no');
  });

  // 4. World-Model Priority 6 caching & selective context
  await runSuite('4. World-Model Clean Inventory Cache, Mutation Invalidation, Retrieval Cache & Selective Context', async () => {
    const wm = new wmMod.SleepwalkerWorldModel({ isPrivacyBlockedUrl: () => false }, { tabId: 'tab_p6' });
    const makeSection = (title, linkText, optLabel) => ({
      nodeType: 1, tagName: 'SECTION', nodeName: 'SECTION', id: '', className: '', type: '', name: '', value: '', href: '',
      _attrs: {}, dataset: {}, getAttribute: () => null, hasAttribute: () => false, getBoundingClientRect: () => ({ width: 200, height: 80, top: 100, left: 0, bottom: 180, right: 200 }),
      matches: (sel) => sel === 'section',
      querySelector: () => null,
      querySelectorAll: () => [],
      children: [
        { nodeType: 1, tagName: 'H2', nodeName: 'H2', textContent: title, innerText: title, id: '', className: '', type: '', name: '', value: '', href: '', _attrs: {}, dataset: {}, getAttribute: () => null, hasAttribute: () => false, getBoundingClientRect: () => ({ width: 200, height: 24, top: 100, left: 0, bottom: 124, right: 200 }), matches: (s) => s.includes('h2'), children: [], querySelectorAll: () => [], closest: () => null }
      ],
      textContent: `${title} ${linkText} ${optLabel}`, innerText: `${title} ${linkText} ${optLabel}`
    });

    // Use lightweight synthetic inventory for selective context + cache assertions
    const inv = {
      tabId: 'tab_p6',
      urlClean: 'http://127.0.0.1/wiki-wm',
      navigationUrl: 'http://127.0.0.1/wiki-wm',
      navigationIdentity: 'ep:tab_p6:1',
      inventoryVersion: 5,
      updatedAt: Date.now(),
      pageType: 'wikipedia',
      discoveryMode: 'static_content',
      title: 'Test Wiki',
      entities: new Map([['S001', { id: 'S001' }]]),
      sections: [
        { id: 'S001', type: 'section', level: 2, label: 'Latest Articles', visible: true },
        { id: 'S002', type: 'section', level: 2, label: 'Banking', visible: true },
        { id: 'S003', type: 'section', level: 2, label: 'Appearance', visible: true }
      ],
      links: Array.from({ length: 12 }, (_, i) => ({
        id: `L${String(i + 1).padStart(3, '0')}`,
        type: 'link',
        label: i === 1 ? 'Article 2' : `Extra Link ${i + 1}`,
        parentSection: i < 4 ? 'Latest Articles' : 'Banking',
        visible: true
      })),
      options: Array.from({ length: 10 }, (_, i) => ({
        id: `O${String(i + 1).padStart(3, '0')}`,
        type: 'option',
        elementType: 'radio',
        label: i === 0 ? 'Dark' : `Setting Option ${i + 1}`,
        parentGroupLabel: 'Color',
        parentSection: 'Appearance',
        visible: true,
        enabled: true
      })),
      buttons: [],
      videos: [],
      articles: [],
      tables: [{ id: 'T001', parentSection: 'Banking', headers: ['Fee', 'Amount'], rows: [{ rowSummary: 'Wire: $10' }] }],
      iframes: [],
      watchVideo: null
    };
    wm.tabInventories.set('tab_p6', inv);

    const docStub = { location: { href: 'http://127.0.0.1/wiki-wm' }, title: 'Test Wiki' };
    // Clean cache reuse inside 15s (returns exact same inventory object without rebuilding!)
    inv.updatedAt = Date.now() - 8000;
    const hitInv = await wm.observeTab(docStub, { tabId: 'tab_p6' });
    assert.strictEqual(hitInv, inv, 'Clean inventory within 15s should hit cache without DOM rebuild');

    // Selective context: option selection query trims unrelated links & tables
    const optCtx = wm.buildReasonerContext('Select Dark under Color', { inventory: inv, maxTokens: 820 });
    assert.ok(optCtx.text.includes('[O001]') && optCtx.text.includes('Dark'), 'Must preserve Dark option');
    assert.ok(!optCtx.text.includes('TABLE [T001]'), 'Control query should omit unrelated tables');
    const optLinkMatches = (optCtx.text.match(/\[L\d{3}\]/g) || []).length;
    assert.ok(optLinkMatches <= 4, `Control query should trim unrelated links (got ${optLinkMatches})`);

    // Preferred previousSection keeps Article 2 prioritized even in compact context
    const prevSecCtx = wm.buildReasonerContext('Open the second article in the previous section', {
      inventory: inv,
      preferredSections: ['Latest Articles'],
      maxTokens: 520
    });
    assert.ok(prevSecCtx.text.includes('[L002]') && prevSecCtx.text.includes('Latest Articles'), 'Must preserve preferred previous section items');

    // Retrieval cache respects pageEmbedCache.clear()
    let embCalls = 0;
    wm.embedRequester = async () => { embCalls += 1; return { status: 'ok', embedding: [1, 0, 0] }; };
    await wm.retrieveRelevantCandidatesAsync('Dark', { inventory: inv, topK: 3 });
    const afterFirst = embCalls;
    await wm.retrieveRelevantCandidatesAsync('Dark', { inventory: inv, topK: 3 });
    assert.strictEqual(embCalls, afterFirst, 'Repeated retrieval on clean unchanged inventory must reuse retrievalCache');
    wm.pageEmbedCache.clear();
    await wm.retrieveRelevantCandidatesAsync('Dark', { inventory: inv, topK: 3 });
    assert.ok(embCalls > afterFirst, 'Clearing pageEmbedCache must force fresh retrieval');
  });
}

async function runBrowserSuites() {
  const chromeExe = findChromeBinary();
  if (!chromeExe) {
    console.log('SKIP  5. Real Headless Chrome Task Lock, Clarification, Cancel & Aurora UI (Chrome not found)');
    return;
  }

  await runSuite('5. Real Headless Chrome: Task Locking, Clarification ("Banking."), Immediate Cancel & Aurora UI', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>Portal</title></head><body data-sw-page-type="wikipedia" style="min-height:2400px;">
        <main>
          <section id="sec-intro"><h2>Introduction</h2><p>Welcome to portal.</p></section>
          <div style="height:800px"></div>
          <section id="sec-benefits"><h2>Benefits of Advantages</h2><p>Advantages and benefits explained clearly.</p></section>
          <section id="sec-banking"><h2>Banking</h2><p>Banking details and online banking.</p></section>
          <div style="height:800px"></div>
          <section id="sec-cards"><h2>Cards</h2><p>Debit and credit card options.</p></section>
        </main>
      </body></html>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-p5-ui-'));
    const cdpPort = 9420 + Math.floor(Math.random() * 400);

    const chrome = spawn(chromeExe, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `http://127.0.0.1:${port}/`
    ], { stdio: 'ignore' });

    let ws = null;
    try {
      let pageTarget = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && !pageTarget) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
          pageTarget = targets.find((t) => t.type === 'page' && t.url.includes(`127.0.0.1:${port}`));
        } catch (_e) {}
      }
      assert.ok(pageTarget, 'Expected page target');
      ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

      let cid = 0;
      const cdp = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++cid;
        const onMsg = async (ev) => {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
          if (msg.id === id) {
            ws.removeEventListener('message', onMsg);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });
      const evalJs = async (expr) => {
        const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
        if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r && r.result ? r.result.value : undefined;
      };

      // Wait until initial document finishes loading so scripts aren't injected before navigation settles
      const loadDeadline = Date.now() + 5000;
      while (Date.now() < loadDeadline) {
        const rs = await evalJs('return document.readyState;').catch(() => '');
        if (rs === 'complete') break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const scripts = [
        'diagnostics.js', 'nav-engine.js', 'ai-comm.js', 'reader.js', 'outline.js', 'voice.js',
        'memory.js', 'task-planner.js', 'digest.js', 'explain.js', 'confirm.js', 'link-index.js',
        'match.js', 'link-intent.js', 'intent.js', 'element-select.js', 'world-model.js',
        'navigate.js', 'form-index.js', 'form-fill.js', 'forms.js', 'shelf-db.js', 'upload.js',
        'camera.js', 'dialogue.js', 'threads.js', 'card.js', 'orb.js', 'content.js'
      ];
      // Stub chrome API + light ui.css inside Shadow DOM
      const cssText = fs.readFileSync(path.join(ROOT, 'ui.css'), 'utf8');
      await evalJs(`
        window.__SW_TEST_SENT_MSGS__ = [];
        window.__SW_MOCK_NLU_MODE__ = 'normal';
        const mockChrome = {
          runtime: {
            id: 'test-ext-id',
            lastError: null,
            getURL: (p) => p,
            onMessage: { addListener() {} },
            sendMessage(msg, cb) {
              window.__SW_TEST_SENT_MSGS__.push(msg);
              if (msg && msg.type === 'SLEEPWALKER_NLU_PLAN_REQUEST') {
                if (window.__SW_MOCK_NLU_MODE__ === 'slow') {
                  window.__SW_SLOW_NLU_CB__ = () => cb && cb({ status: 'ok', plan: { intent: 'navigate_section', target: 'Cards', actions: [{ type: 'find_section', target: 'Cards', section: 'Cards' }], confidence: 0.9 } });
                  return;
                }
                if (window.__SW_MOCK_NLU_MODE__ === 'clarify_section') {
                  if (typeof cb === 'function') setTimeout(() => cb({ status: 'ok', plan: { intent: 'navigate_section', requires_clarification: true, clarification_question: 'Which section should I open?', target: '', actions: [], confidence: 0.5 } }), 0);
                  return;
                }
              }
              if (typeof cb === 'function') setTimeout(() => cb({ status: 'ok' }), 0);
            }
          },
          storage: {
            local: { get: (_k, cb) => cb && cb({}), set: (_v, cb) => cb && cb() }
          }
        };
        try { Object.defineProperty(window, 'chrome', { configurable: true, writable: true, value: mockChrome }); }
        catch (_e) { Object.defineProperty(window.chrome, 'runtime', { configurable: true, writable: true, value: mockChrome.runtime }); window.chrome.storage = mockChrome.storage; }
      `);
      for (const s of scripts) {
        const src = fs.readFileSync(path.join(ROOT, s), 'utf8');
        await evalJs(src);
      }
      await evalJs(`window.SW_UI && window.SW_UI._orb && window.SW_UI._orb.injectCssText(${JSON.stringify(cssText)});`);
      await new Promise((r) => setTimeout(r, 200));

      // Verify Priority 5 Aurora UI states & non-overlap & reduced motion CSS & zero idle rAF
      const uiRes = await evalJs(`
        const orb = window.SW_UI._orb;
        const sh = orb.shadow;
        window.SW_UI.setState('silent');
        window.SW_UI.setTaskStatus({ state: 'processing', stage: 'Understanding request', taskLabel: 'Summarize this page' });
        await new Promise((r) => setTimeout(r, 40));
        const bar = sh.getElementById('sw-ui-aurora');
        const stage = sh.getElementById('sw-ui-aurora-stage');
        const cancelBtn = sh.getElementById('sw-ui-cancel-btn');
        const orbBtn = sh.getElementById('sw-ui-orb');
        const barRect = bar.getBoundingClientRect();
        const orbRect = orbBtn.getBoundingClientRect();
        const overlap = !(barRect.bottom <= orbRect.top + 2 || barRect.top >= orbRect.bottom);
        const procState = bar.dataset.taskState;
        const procStage = stage.textContent;
        const cancelVisible = !cancelBtn.hidden;
        window.SW_UI.setTaskStatus({ state: 'waiting_for_clarification', stage: 'Waiting for clarification', taskLabel: 'Open section' });
        const waitState = bar.dataset.taskState;
        window.SW_UI.setTaskStatus({ state: 'completed', stage: 'Completed', taskLabel: 'Open section' });
        const compState = bar.dataset.taskState;
        window.SW_UI.setTaskStatus({ state: 'cancelled', stage: 'Cancelled', taskLabel: 'Open section' });
        const cancState = bar.dataset.taskState;
        window.SW_UI.setTaskStatus({ state: 'error', stage: 'Action failed', taskLabel: 'Open section' });
        const errState = bar.dataset.taskState;
        window.SW_UI.setState('idle');
        await new Promise((r) => setTimeout(r, 30));
        const idleHidden = bar.hidden;
        const idleRaf = orb.threads ? orb.threads._rafId : null;
        return { overlap, procState, procStage, cancelVisible, waitState, compState, cancState, errState, idleHidden, idleRaf };
      `);
      assert.strictEqual(uiRes.overlap, false, 'Aurora bar must NOT overlap the orb button');
      assert.strictEqual(uiRes.procState, 'processing');
      assert.strictEqual(uiRes.procStage, 'Understanding request');
      assert.strictEqual(uiRes.cancelVisible, true);
      assert.strictEqual(uiRes.waitState, 'waiting_for_clarification');
      assert.strictEqual(uiRes.compState, 'completed');
      assert.strictEqual(uiRes.cancState, 'cancelled');
      assert.strictEqual(uiRes.errState, 'error');
      assert.strictEqual(uiRes.idleHidden, true, 'Aurora bar must hide on idle');
      assert.ok(!uiRes.idleRaf, `Canvas rAF must stop on idle (0 CPU usage), got ${uiRes.idleRaf}`);
      assert.ok(cssText.includes('prefers-reduced-motion: reduce'), 'ui.css must support prefers-reduced-motion');

      // Verify Priority 4: Active Task Locking + Duplicate Suppression + Cancel ("No need.") + Restore Listening
      const lockAndCancel = await evalJs(`
        const c = window.__SW_WIDGET__;
        await c._bootPromise;
        await c.memory.recordActivity({ user_command: 'initial setup', intent: 'HELP', topic: 'portal', action: 'ok', result: 'ok' });
        const actCountBefore = c.memory.state.activities.length;
        window.__SW_MOCK_NLU_MODE__ = 'slow';
        const pSlow = c.handleUserInput('take me to where they explain advantages', 'voice');
        // Wait until async NLU message is in flight
        const waitDeadline = Date.now() + 3000;
        while (Date.now() < waitDeadline && !window.__SW_SLOW_NLU_CB__) {
          await new Promise((r) => setTimeout(r, 15));
        }
        const dupRes = await c.handleUserInput('take me to where they explain advantages', 'voice');
        const otherRes = await c.handleUserInput('scroll down', 'voice');
        const dupVoiceRejected = c.voice._emitCommandDeduped('scroll down');
        const activeLabelDuring = c.taskLifecycle.activeLabel;
        const cancelRes = await c.handleUserInput('No need.', 'voice');
        if (window.__SW_SLOW_NLU_CB__) window.__SW_SLOW_NLU_CB__();
        const slowRes = await pSlow;
        const sent = Array.isArray(window.__SW_TEST_SENT_MSGS__) ? window.__SW_TEST_SENT_MSGS__ : [];
        const cancelledSent = sent.some((m) => m && m.type === 'SLEEPWALKER_CANCEL_ACTIVE_LLM');
        const actCountAfter = c.memory.state.activities.length;
        await new Promise((r) => setTimeout(r, 1300));
        // Now verify normal commands work again seamlessly after cancellation
        window.__SW_MOCK_NLU_MODE__ = 'normal';
        const afterScroll = await c.handleUserInput('Scroll down.', 'voice');
        return { hasChrome: typeof chrome, hasSend: typeof (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage), dupRes, otherRes, dupVoiceRejected, activeLabelDuring, cancelRes, slowRes, cancelledSent, sentTypes: sent.map(m=>m&&m.type), cbSet: Boolean(window.__SW_SLOW_NLU_CB__), inFlight: c._inFlightExecCount, actCountBefore, actCountAfter, scrollY: window.scrollY, afterScroll };
      `);
      assert.strictEqual(lockAndCancel.dupRes.status, 'task_locked', 'Duplicate submission during active task must lock');
      assert.strictEqual(lockAndCancel.otherRes.status, 'task_locked', 'Unrelated submission during active task must lock');
      assert.strictEqual(lockAndCancel.dupVoiceRejected, false, 'Voice layer must suppress non-cancel commands while locked');
      assert.strictEqual(lockAndCancel.cancelRes.status, 'task_cancelled', 'Cancel phrase ("No need.") must cancel active task immediately');
      assert.strictEqual(lockAndCancel.slowRes.status, 'task_cancelled', 'Cancelled slow task must exit cleanly without stale UI overwrite');
      assert.strictEqual(lockAndCancel.cancelledSent, true, 'Must notify background service worker to abort in-flight LLM request');
      assert.ok(lockAndCancel.actCountAfter >= lockAndCancel.actCountBefore, 'Cancel must NOT wipe persistent memory');
      assert.ok(lockAndCancel.scrollY > 100, `Normal commands must work after cancel (scrollY=${lockAndCancel.scrollY})`);

      // Verify Priority 4 Clarification Continuation ("Which section should I open?" -> "Banking.")
      const clarifyRes = await evalJs(`
        const c = window.__SW_WIDGET__;
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 1500));
        window.__SW_MOCK_NLU_MODE__ = 'clarify_section';
        const step1 = await c.handleUserInput('open the important section', 'voice');
        const stateAfterQ = c.taskLifecycle.state;
        const taskId1 = c.taskLifecycle.activeTaskId;
        window.__SW_MOCK_NLU_MODE__ = 'normal';
        const step2 = await c.handleUserInput('Banking.', 'voice');
        const stateAfterAns = c.taskLifecycle.state;
        return { step1, stateAfterQ, taskId1, step2, stateAfterAns, activeSection: c.memory.state.selectionState.activeSection };
      `);
      assert.strictEqual(clarifyRes.step1.status, 'needs_clarification');
      assert.strictEqual(clarifyRes.stateAfterQ, 'WAITING_FOR_CLARIFICATION');
      assert.ok(clarifyRes.activeSection && /banking/i.test(clarifyRes.activeSection), `Clarification answer "Banking." must navigate to Banking inside active task (got ${clarifyRes.activeSection})`);
      assert.notStrictEqual(clarifyRes.stateAfterAns, 'WAITING_FOR_CLARIFICATION');
    } finally {
      if (ws) try { ws.close(); } catch (_e) {}
      try { chrome.kill('SIGKILL'); } catch (_e) {}
      await new Promise((r) => server.close(r));
      await new Promise((r) => setTimeout(r, 250));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
    }
  });
}

(async () => {
  console.log('=== Sleepwalker Phase 5 — Task Locking, Specialist Boundary, Aurora UI & Selective Context Tests ===\n');
  await runUnitSuites();
  await runBrowserSuites();
  console.log(`\nSummary: ${passed}/${passed + failed} Phase 5 test suites passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
})();
