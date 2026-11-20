/**
 * Sleepwalker 2.0 Phase 3 — Autonomous Browsing, Task Planning, Web Interaction & Control E2E Suite
 *
 * Tier 1: Node Unit checks (SleepwalkerTaskPlanner statuses/simple-command restraint, llm.handleTaskPlanRequest routing)
 * Tier 2: Real Headless Chrome via CDP testing Scenarios A, B, C, D, E, F across multi-page navigation & HTTP 302 redirects
 *         (using MockSR for voice event triggers and local multi-site HTTP fixture server).
 *
 * Run with: node D:\sleep\tests\run-phase3-task-tests.js
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

const PORTAL_HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Academic &amp; Tech Discovery Portal</title></head>
<body style="min-height:1800px;font-family:system-ui,sans-serif;padding:24px;">
  <header>
    <nav aria-label="Main Navigation">
      <a href="/">Home</a>
      <a href="/pricing.html" id="nav-pricing">Pricing</a>
      <a href="/contact.html" id="nav-contact">Contact Us</a>
    </nav>
    <form id="login-form" action="/login">
      <label for="login-user">Username</label>
      <input id="login-user" type="text" name="username" />
      <label for="login-pass">Password</label>
      <input id="login-pass" type="password" name="password" />
    </form>
  </header>
  <main>
    <h1>University, Course &amp; Tech Research Hub</h1>
    <form role="search" id="course-search-form" action="/courses.html" method="get">
      <label for="course-search-input">Search AI &amp; Tech Courses</label>
      <input id="course-search-input" type="search" name="q" placeholder="Search courses..." />
      <button type="submit">Search Courses</button>
    </form>
    <section id="filters" aria-label="Course filters">
      <label><input type="checkbox" id="filter-free" name="free" value="free"> Free courses</label>
      <label><input type="checkbox" id="filter-cert" name="cert" value="cert"> Verified certificate</label>
    </section>
    <section id="results">
      <article class="course-card" data-result-item>
        <h2>AI Foundations</h2>
        <p>Free open audit track; optional verified certificate.</p>
        <a href="/course-ai.html">View AI Foundations</a>
      </article>
      <article class="course-card" data-result-item>
        <h2>Systems Engineering</h2>
        <p>Tuition-free modules; project certification available.</p>
        <a href="/course-sys.html">View Systems Engineering</a>
      </article>
    </section>
  </main>
</body>
</html>`;

const LMU_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>LMU Munich — Official University Portal</title></head>
<body style="min-height:1600px;font-family:system-ui,sans-serif;padding:24px;">
  <header>
    <nav>
      <a href="/academics">Academics</a>
      <a href="/lmu-apply.html" id="lmu-apply-link">Apply Online Now</a>
    </nav>
  </header>
  <main>
    <h1>LMU Munich</h1>
    <p>Welcome to Ludwig Maximilian University of Munich.</p>
    <h2>Admission Overview</h2>
    <p>Verify degree prerequisites and International Office deadlines directly on official program portals.</p>
  </main>
</body>
</html>`;

const APPLICATION_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>University Application Form</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;">
  <h1>Online Student Application</h1>
  <form id="app-form" action="/submitted" method="post" onsubmit="event.preventDefault(); window.__APP_SUBMITTED__ = true;">
    <div>
      <label for="app-name">Full Name</label>
      <input id="app-name" type="text" required />
    </div>
    <div>
      <label for="app-email">Email Address</label>
      <input id="app-email" type="email" required />
    </div>
    <div>
      <label for="app-pwd">Create Portal Password</label>
      <input id="app-pwd" type="password" required />
    </div>
    <button type="submit" id="app-submit-btn">Submit Application</button>
  </form>
</body>
</html>`;

const CAPTCHA_GATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Verification Gate</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;">
  <h1>Security Verification</h1>
  <div class="g-recaptcha" data-sitekey="demo-key">Please verify you are human</div>
  <form id="gated-form">
    <label for="gated-name">Name</label>
    <input id="gated-name" type="text" required />
  </form>
</body>
</html>`;

async function runNodeUnitChecks() {
  console.log('--- Tier 1: Node Task Planner & Model Routing Checks ---');
  global.window = global;
  global.self = global;
  if (!global.navigator) {
    Object.defineProperty(global, 'navigator', { value: { language: 'en-IN', onLine: true }, configurable: true });
  }
  require(path.join(ROOT, 'diagnostics.js'));
  const llm = require(path.join(ROOT, 'llm.js'));
  const { SleepwalkerTaskPlanner, TASK_STATUSES } = require(path.join(ROOT, 'task-planner.js'));

  const planner = new SleepwalkerTaskPlanner(null);
  assert.strictEqual(Object.keys(TASK_STATUSES).length, 9, 'Must define all 9 lifecycle task statuses');
  assert.strictEqual(planner.isMultiStepObjective('Scroll down'), false, 'Simple commands must NOT become multi-step plans');
  assert.strictEqual(planner.isMultiStepObjective('Search within this page for eligibility', {}, { category: 'PAGE_SEARCH' }), false);
  assert.strictEqual(planner.isMultiStepObjective('Help me plan a trip to Japan.'), true);

  const japanPlan = planner.buildPlanTemplate('Help me plan a trip to Japan.', {});
  assert.strictEqual(japanPlan.plannedSteps.length, 7, 'Japan travel plan should produce structured 7-step travel plan');
  assert.strictEqual(japanPlan.domain, 'travel_planning');

  const hotelPlan = planner.buildPlanTemplate('Find me a hotel in Tokyo.', {});
  assert.strictEqual(hotelPlan.status, TASK_STATUSES.WAITING_FOR_USER, 'Booking without dates/guests must ask missing requirements cleanly');
  const constraints = planner.extractConstraints('December 10 to December 14 for 2 guests budget affordable');
  assert.strictEqual(constraints.guests, 2);
  assert.ok(/December 10/i.test(constraints.dates));
  assert.strictEqual(constraints.budget, 'affordable');

  // Verify Gemini/Ollama cascade in handleTaskPlanRequest
  const origFetch = global.fetch;
  llm.resetLlmStateForTests();
  global.chrome = {
    storage: {
      local: { get(_k, cb) { cb({ sleepwalker_gemini_api_key: 'AIzaTest', sleepwalker_gemini_model: 'gemini-flash-lite-latest' }); }, set(_o, cb) { if (cb) cb(); } },
      session: { get(_k, cb) { cb({}); }, set(_o, cb) { if (cb) cb(); } }
    }
  };
  global.fetch = async (url) => {
    if (String(url).includes('generativelanguage')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{
              content: {
                parts: [{ text: JSON.stringify({ interpretedObjective: 'Research grant eligibility', steps: [{ id: 's1', label: 'Find official grant portal', requiresConfirm: false }, { id: 's2', label: 'Review eligibility', requiresConfirm: false }, { id: 's3', label: 'Confirm application submit', requiresConfirm: true }] }) }]
              }
            }]
          };
        }
      };
    }
    throw new Error('offline');
  };
  try {
    const planRes = await llm.handleTaskPlanRequest({ objective: 'Research international fellowship grants and apply' });
    assert.strictEqual(planRes.status, 'ok');
    assert.strictEqual(planRes.steps.length, 3);
    assert.strictEqual(planRes.steps[2].requiresConfirm, true);
  } finally {
    global.fetch = origFetch;
  }

  console.log('PASS  Tier 1: Task statuses, simple-command restraint, slot extraction & Gemini task plan routing');
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
          this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this.lang = 'en-IN';
          this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null;
          window.__SW_SR_LOG__.instances.push(this);
        }
        start() {
          window.__SW_SR_LOG__.startCalls += 1;
          window.__SW_SR_LOG__.active = true;
          if (typeof this.onstart === 'function') this.onstart();
        }
        stop() {
          window.__SW_SR_LOG__.stopCalls += 1;
          window.__SW_SR_LOG__.active = false;
          if (typeof this.onend === 'function') this.onend();
        }
      }
      window.SpeechRecognition = MockSR;
      window.webkitSpeechRecognition = MockSR;
      try {
        window.speechSynthesis.cancel = () => {};
        window.speechSynthesis.speak = (u) => {
          setTimeout(() => { if (u && typeof u.onend === 'function') u.onend(); }, 5);
        };
      } catch (_e) {}

      async function bridgeCall(p, payload) {
        const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
        return r.json();
      }
      window.chrome = {
        runtime: {
          lastError: null,
          getURL: (p) => BASE + '/ext/' + String(p || '').replace(/^\\/+/, ''),
          onMessage: { addListener() {} },
          sendMessage(msg, cb) {
            const reply = (res) => { if (typeof cb === 'function') setTimeout(() => cb(res), 0); };
            if (!msg || !msg.type) return reply(null);
            if (msg.type === 'SLEEPWALKER_MEMORY_GET') { bridgeCall('/api/mem_get', msg).then(reply); return true; }
            if (msg.type === 'SLEEPWALKER_MEMORY_SET') { bridgeCall('/api/mem_set', msg).then(reply); return true; }
            if (msg.type === 'SLEEPWALKER_OFF_PAGE_RESEARCH_REQUEST') { reply({ status: 'offline' }); return true; }
            if (msg.type === 'SLEEPWALKER_INTENT_REQUEST') { reply({ status: 'fallback' }); return true; }
            if (msg.type === 'SLEEPWALKER_EXPLAIN_REQUEST') { reply({ status: 'fallback_needed' }); return true; }
            if (msg.type === 'SLEEPWALKER_PICK_LINK_REQUEST' || msg.type === 'SLEEPWALKER_SEARCH_SELECT') { reply({ status: 'fallback' }); return true; }
            reply({ status: 'ok' });
            return false;
          }
        },
        storage: {
          local: {
            get(keys, cb) { bridgeCall('/api/storage_get', { scope: 'local', keys }).then((d) => cb(d.data || {})); },
            set(obj, cb) { bridgeCall('/api/storage_set', { scope: 'local', items: obj }).then(() => { if (cb) cb(); }); }
          },
          session: {
            get(keys, cb) { bridgeCall('/api/storage_get', { scope: 'session', keys }).then((d) => cb(d.data || {})); },
            set(obj, cb) { bridgeCall('/api/storage_set', { scope: 'session', items: obj }).then(() => { if (cb) cb(); }); }
          },
          onChanged: { addListener() {} }
        }
      };
    })();
  `;
}

async function runChromePhase3Scenarios() {
  console.log('\n--- Tier 2: Real Headless Chrome CDP Scenarios A–F ---');

  const store = { local: {}, session: {} };
  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && reqPath.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        res.setHeader('Content-Type', 'application/json');
        if (reqPath === '/api/mem_get') {
          res.end(JSON.stringify({ state: store.local.sleepwalker_persistent_memory_v1 || null }));
          return;
        }
        if (reqPath === '/api/mem_set') {
          if (parsed.state) store.local.sleepwalker_persistent_memory_v1 = parsed.state;
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        if (reqPath === '/api/storage_get') {
          const bag = store[parsed.scope || 'local'] || {};
          const out = {};
          const keys = parsed.keys;
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

    if (reqPath === '/redirect-china') {
      res.writeHead(302, { Location: '/travel-guide.html?destination=China' });
      res.end();
      return;
    }
    if (reqPath === '/missing-uni-404') {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1><p>Page unavailable.</p></body></html>');
      return;
    }
    if (reqPath === '/uni-lmu.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(LMU_HTML);
      return;
    }
    if (reqPath === '/pricing.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Pricing Plans</title></head><body><h1>Pricing</h1><p>Transparent open-access plans.</p></body></html>');
      return;
    }
    if (reqPath === '/contact.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Contact Information</title></head><body><h1>Contact Us</h1><p>Email support portal.</p></body></html>');
      return;
    }
    if (reqPath === '/product-macbook.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Apple MacBook Air Product Page</title></head><body><h1>Apple MacBook Air</h1><p>Fanless M-series Apple Silicon ultrabook.</p></body></html>');
      return;
    }
    if (reqPath === '/travel-guide.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>China Official Travel &amp; Visa Guide</title></head><body><h1>China Tourist Visa (L Visa)</h1><p>Passport, visa application form, flight itinerary required.</p></body></html>');
      return;
    }
    if (reqPath === '/app-form.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(APPLICATION_FORM_HTML);
      return;
    }
    if (reqPath === '/captcha-gate.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(CAPTCHA_GATE_HTML);
      return;
    }
    if (reqPath === '/courses.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>AI Course Search Results</title></head><body><h1>AI Courses</h1></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PORTAL_HOME_HTML);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-phase3-cdp-'));
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
      proc.stderr.on('data', (c) => {
        stderr += String(c);
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
        await cdp.eval(sessionId, fs.readFileSync(path.join(ROOT, file), 'utf8'));
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    async function navigateAndInject(url) {
      await cdp.send('Page.navigate', { url }, sessionId);
      await new Promise((r) => setTimeout(r, 450));
      await injectAll();
    }

    await injectAll();

    // --------------------------------------------------------------
    // SCENARIO A: University research -> Compare -> Open 2nd university application page (cross-website nav!) -> Return earlier site
    // --------------------------------------------------------------
    const scA1 = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      ctrl.toggle({ startDialogue: true, source: 'test' });
      await ctrl.handleUserInput('Find good universities in Germany.', 'voice');
      await ctrl.handleUserInput('Compare their admission requirements.', 'voice');
      const taskBeforeNav = JSON.parse(JSON.stringify(ctrl.memory.state.activeTask));

      // Dispatch "Open the second university's application page." (triggers /uni-lmu.html navigation)
      setTimeout(() => { ctrl.handleUserInput("Open the second university's application page.", 'voice'); }, 30);
      return { taskBeforeNav };
    })()`);
    assert.strictEqual(scA1.taskBeforeNav.topic, 'Germany');
    assert.ok(scA1.taskBeforeNav.plannedSteps.length >= 4, 'University research should create structured plannedSteps');
    assert.strictEqual(scA1.taskBeforeNav.status, 'RUNNING');

    // Wait for browser navigation to /uni-lmu.html to finish, then re-inject extension on destination site
    await new Promise((r) => setTimeout(r, 650));
    const urlAfterA = await cdp.eval(sessionId, `window.location.href`);
    assert.ok(urlAfterA.endsWith('/uni-lmu.html'), `Expected navigation to /uni-lmu.html, got ${urlAfterA}`);
    await injectAll();

    const scA2 = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      await ctrl._bootPromise;
      const task = ctrl.memory.state.activeTask;
      const cardText = document.getElementById('sleepwalker-ui-host') && document.getElementById('sleepwalker-ui-host').shadowRoot
        ? (document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-card-body') || {}).textContent || ''
        : '';

      // Test returning to earlier website
      setTimeout(() => { ctrl.handleUserInput('Return to the website we were using earlier.', 'voice'); }, 30);
      return { task, cardText };
    })()`);
    assert.strictEqual(scA2.task.topic, 'Germany', 'Active Germany task must survive cross-website navigation');
    assert.ok(scA2.cardText.includes('Apply Online Now'), `Post-nav verification must auto-locate LMU application link: ${scA2.cardText}`);

    await new Promise((r) => setTimeout(r, 650));
    const urlReturned = await cdp.eval(sessionId, `window.location.href`);
    assert.strictEqual(urlReturned, `${baseUrl}/`, `Expected return to earlier website (${baseUrl}/), got ${urlReturned}`);
    await injectAll();
    console.log('PASS  Scenario A: University multi-website workflow, cross-site app link discovery & return to earlier site');

    // --------------------------------------------------------------
    // SCENARIO B: Travel Planning (Japan) + Booking Constraint Collection (Tokyo Hotel) + Redirect Preservation (China)
    // --------------------------------------------------------------
    const scB1 = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      await ctrl.handleUserInput('Help me plan a trip to Japan.', 'voice');
      const japanTask = JSON.parse(JSON.stringify(ctrl.memory.state.activeTask));

      const hotel1 = await ctrl.handleUserInput('Find me a hotel in Tokyo.', 'voice');
      const waitingTask = JSON.parse(JSON.stringify(ctrl.memory.state.activeTask));

      // Supply missing constraints naturally
      const hotel2 = await ctrl.handleUserInput('December 10 to December 14 for 2 guests', 'voice');
      const runningHotelTask = JSON.parse(JSON.stringify(ctrl.memory.state.activeTask));

      // Consequential booking action requires CRITICAL confirmation & does NOT claim completed
      const bookAttempt = ctrl.handleUserInput('Book a flight to Tokyo now', 'voice');
      await new Promise((r) => setTimeout(r, 100));
      const awaitingConfirm = ctrl.confirm.isAwaiting();
      ctrl.confirm.cancel('user_denied');
      await bookAttempt;

      return { japanTask, waitingTask, runningHotelTask, hotel2Status: hotel2 && hotel2.status, awaitingConfirm };
    })()`);

    assert.strictEqual(scB1.japanTask.plannedSteps.length, 7);
    assert.strictEqual(scB1.waitingTask.status, 'WAITING_FOR_USER', 'Hotel booking without dates/guests should ask constraints safely');
    assert.strictEqual(scB1.runningHotelTask.constraints.guests, 2);
    assert.strictEqual(scB1.runningHotelTask.status, 'RUNNING');
    assert.strictEqual(scB1.awaitingConfirm, true, 'Booking action must stop for explicit confirmation');

    // Redirect preservation check (/redirect-china -> /travel-guide.html?destination=China)
    await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      await ctrl.handleUserInput('I am planning a trip to China.', 'voice');
    })()`);
    await navigateAndInject(`${baseUrl}/redirect-china`);
    const scBRedir = await cdp.eval(sessionId, `(() => ({
      href: window.location.href,
      topic: window.__SLEEPWALKER_INSTANCE__.memory.state.activeTask && window.__SLEEPWALKER_INSTANCE__.memory.state.activeTask.topic
    }))()`);
    assert.ok(scBRedir.href.includes('/travel-guide.html'), `Expected 302 redirect target, got ${scBRedir.href}`);
    assert.strictEqual(scBRedir.topic, 'China', 'China trip task must survive HTTP 302 redirect');
    console.log('PASS  Scenario B: 7-step travel planning, Tokyo hotel slot collection, critical booking confirm & 302 redirect preservation');

    // --------------------------------------------------------------
    // SCENARIO C: Semantic Element Classification, Course Filter, Search, Pricing/Contact & Product Comparison
    // --------------------------------------------------------------
    await navigateAndInject(`${baseUrl}/`);
    const scC1 = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      const analyzed = ctrl.navigator.analyzeInteractiveElements(document);
      const extractedDom = ctrl.navigator.extractPageResults(document);

      // Filter by free courses
      const filterRes = await ctrl.handleUserInput('Filter by free courses.', 'voice');
      const freeChecked = document.getElementById('filter-free').checked;

      // Semantic destination lookup (pricing / contact) without hardcoding click 0
      const pricingHit = ctrl.navigator.findSemanticDestinationLink('pricing', document);
      const contactHit = ctrl.navigator.findSemanticDestinationLink('contact', document);

      // Product workflow
      await ctrl.handleUserInput('Find laptops.', 'voice');
      const specCmp = await ctrl.handleUserInput('Compare specifications.', 'voice');
      const twoCmp = await ctrl.handleUserInput('Compare the second one with the first one.', 'voice');
      await ctrl.handleUserInput('What about the second one?', 'voice');
      setTimeout(() => { ctrl.handleUserInput('Open its product page.', 'voice'); }, 30);

      return {
        searchCount: analyzed.searchFields.length,
        loginCount: analyzed.loginFields.length,
        filterCount: analyzed.filters.length,
        extractedDomCount: extractedDom.length,
        filterRes,
        freeChecked,
        pricingHref: pricingHit && pricingHit.href,
        contactHref: contactHit && contactHit.href,
        specCmpAns: specCmp && specCmp.answer,
        twoCmpAns: twoCmp && twoCmp.answer
      };
    })()`);

    assert.strictEqual(scC1.searchCount, 1, 'Must isolate the 1 search field cleanly away from login username/password fields');
    assert.strictEqual(scC1.loginCount, 1);
    assert.ok(scC1.filterCount >= 2);
    assert.strictEqual(scC1.extractedDomCount, 2);
    assert.strictEqual(scC1.filterRes.status, 'filter_applied');
    assert.strictEqual(scC1.freeChecked, true, 'Filter command must toggle the actual Free courses checkbox');
    assert.ok(scC1.pricingHref.includes('/pricing.html'));
    assert.ok(scC1.contactHref.includes('/contact.html'));
    assert.ok(/ThinkPad/i.test(scC1.twoCmpAns) && /MacBook Air/i.test(scC1.twoCmpAns));

    await new Promise((r) => setTimeout(r, 650));
    const urlProd = await cdp.eval(sessionId, `window.location.href`);
    assert.ok(urlProd.endsWith('/product-macbook.html'), `Expected MacBook product page navigation, got ${urlProd}`);
    await injectAll();
    console.log('PASS  Scenario C: Semantic element classification, free filter execution, specs & product comparison');

    // --------------------------------------------------------------
    // SCENARIO D: Form Identification, Validation, Sensitive Guard, Critical Confirm & Security Gate Refusal
    // --------------------------------------------------------------
    await navigateAndInject(`${baseUrl}/app-form.html`);
    const scD = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      const inspect1 = await ctrl.handleUserInput('Identify form fields.', 'voice');

      // Fill only Full Name -> validate missing fields should catch Email + Password
      document.getElementById('app-name').value = 'Asha Rao';
      const val1 = await ctrl.handleUserInput('Validate missing fields.', 'voice');

      // Fill Email + Password, request Submit -> must require double confirm and respect cancel
      document.getElementById('app-email').value = 'asha@example.edu';
      document.getElementById('app-pwd').value = 'DemoSecret!1';
      ctrl.forms.reviewAndActOnStepOrSubmit('submit');
      const confirm1Required = ctrl.confirm.isAwaiting() && ctrl.confirm.pending.requiredSteps === 2;
      ctrl.confirm.confirm(); // Step 1 of 2
      const confirm2StillWaiting = ctrl.confirm.isAwaiting();
      const submittedBeforeStep2 = Boolean(window.__APP_SUBMITTED__);
      ctrl.confirm.cancel('user_denied'); // Cancel at Step 2
      const submittedAfterCancel = Boolean(window.__APP_SUBMITTED__);

      return { inspect1, val1, confirm1Required, confirm2StillWaiting, submittedBeforeStep2, submittedAfterCancel };
    })()`);

    assert.strictEqual(scD.inspect1.status, 'form_inspected');
    assert.ok(/sensitive/i.test(scD.inspect1.message), 'Must mark password field sensitive without reading/collecting value');
    assert.strictEqual(scD.val1.valid, false);
    assert.ok(scD.val1.missingRequired.some((x) => /email/i.test(x)));
    assert.strictEqual(scD.confirm1Required, true, 'Form submission must require 2-step critical confirmation');
    assert.strictEqual(scD.confirm2StillWaiting, true);
    assert.strictEqual(scD.submittedBeforeStep2, false);
    assert.strictEqual(scD.submittedAfterCancel, false, 'Cancelling confirmation MUST prevent submission');

    // Verify CAPTCHA/security gate never bypassed
    await navigateAndInject(`${baseUrl}/captcha-gate.html`);
    const scDGate = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      const res = await ctrl.handleUserInput('Identify form fields.', 'voice');
      return { res, taskStatus: ctrl.memory.state.activeTask && ctrl.memory.state.activeTask.status };
    })()`);
    assert.strictEqual(scDGate.res.status, 'waiting_for_user');
    assert.strictEqual(scDGate.res.gateType, 'captcha');
    assert.strictEqual(scDGate.taskStatus, 'WAITING_FOR_USER');
    console.log('PASS  Scenario D: Form identification, missing-field validation, critical double-confirm & CAPTCHA refusal');

    // --------------------------------------------------------------
    // SCENARIO E & F: Failure Recovery (404 / Bad URL / Missing Element) + Pause / Resume / Skip / Cancel Task Control
    // --------------------------------------------------------------
    await navigateAndInject(`${baseUrl}/`);
    const scEF = await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      await ctrl.handleUserInput('Find good universities in Germany.', 'voice');

      // E1: Invalid URL -> record failure + RECOVERING
      const badNav = await ctrl._navigateToExternalUrl('javascript:alert(1)', 'Bad Target', 'Germany');
      const taskAfterBadNav = JSON.parse(JSON.stringify(ctrl.memory.state.activeTask));

      // E2: Missing section -> record failure cleanly
      const missingSec = await ctrl.handleUserInput('Go to the non existent quantum flux section.', 'voice');

      // F1: Voice control commands on active task
      const explained = await ctrl.handleUserInput("Explain what you're doing.", 'voice');
      const paused = await ctrl.handleUserInput('Pause this task.', 'voice');
      const statusPaused = ctrl.memory.state.activeTask.status;
      const resumed = await ctrl.handleUserInput('Resume.', 'voice');
      const statusResumed = ctrl.memory.state.activeTask.status;
      const resultsShown = await ctrl.handleUserInput('Show me the results.', 'voice');
      const skipped = await ctrl.handleUserInput('Skip this step.', 'voice');
      const cancelled = await ctrl.handleUserInput('Cancel this task.', 'voice');
      const statusCancelled = ctrl.memory.state.activeTask.status;
      const sessionStillAlive = ctrl.dialogue.isActive();

      return {
        badNavStatus: badNav.status,
        taskAfterBadNavStatus: taskAfterBadNav.status,
        failedCount: taskAfterBadNav.failedSteps.length,
        explainedAns: explained && explained.answer,
        pausedStatus: statusPaused,
        resumedStatus: statusResumed,
        resultsAns: resultsShown && resultsShown.answer,
        skippedStatus: skipped && skipped.status,
        cancelledStatus: statusCancelled,
        sessionStillAlive
      };
    })()`);

    assert.strictEqual(scEF.badNavStatus, 'navigation_failed');
    assert.strictEqual(scEF.taskAfterBadNavStatus, 'RECOVERING');
    assert.ok(scEF.failedCount >= 1);
    assert.ok(/Completed|Status|Germany/i.test(scEF.explainedAns));
    assert.strictEqual(scEF.pausedStatus, 'PAUSED');
    assert.strictEqual(scEF.resumedStatus, 'RUNNING');
    assert.ok(/TUM|Technical University of Munich/i.test(scEF.resultsAns));
    assert.strictEqual(scEF.skippedStatus, 'step_skipped');
    assert.strictEqual(scEF.cancelledStatus, 'CANCELLED');
    assert.strictEqual(scEF.sessionStillAlive, true, 'Cancelling a task MUST keep Sleepwalker voice session active!');

    // E3: Simulate 404 unavailable page during real navigation boot verification
    await cdp.eval(sessionId, `(async () => {
      const ctrl = window.__SLEEPWALKER_INSTANCE__;
      await ctrl.handleUserInput('Find good universities in Germany.', 'voice');
      ctrl.memory.state.pendingActions = [{ type: 'verify_navigation_and_continue', url: '${baseUrl}/missing-uni-404', title: 'Unavailable University', topic: 'Germany' }];
      await ctrl.memory.saveState();
    })()`);
    await navigateAndInject(`${baseUrl}/missing-uni-404`);
    const sc404 = await cdp.eval(sessionId, `(async () => {
      await window.__SLEEPWALKER_INSTANCE__._bootPromise;
      return window.__SLEEPWALKER_INSTANCE__.memory.state.activeTask;
    })()`);
    assert.strictEqual(sc404.status, 'RECOVERING', `404 destination must put task in RECOVERING status, got ${sc404.status}`);
    assert.ok(sc404.failedSteps.length >= 1, '404 destination must append failedSteps entry');
    console.log('PASS  Scenarios E & F: Failure recovery (invalid URL, missing element, 404 page) & pause/resume/skip/cancel without ending session');

    console.log('\nSummary: ALL Phase 3 Node + Headless Chrome CDP Scenarios A–F Passed!');
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
  await runChromePhase3Scenarios();
}

main().catch((err) => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
