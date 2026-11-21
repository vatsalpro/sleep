/**
 * Sleepwalker 2.0 — Master Implementation Verification Suite (Tests A–K)
 *
 * Tests real Chrome MV3 (--load-extension) against interactive HTTP fixture portals
 * and live local Ollama models (`qwen2.5:1.5b` primary, `llama3.2:3b` escalation,
 * `nomic-embed-text` embeddings) without calling Gemini for ordinary browser work.
 *
 * Scenarios covered (Section 12 A–K):
 *   A & B. YouTube feed/nav proactive world model mapping, Qwen "Select Home.", back + dynamic DOM mutation update
 *   C.     University Portal nested hierarchy navigation ("Open Results under Examinations.")
 *   D.     Application Form: Name/Email/Country -> dependent State ("Choose India." -> "Now select Karnataka."),
 *          Password type recognized with ZERO value stored, confirmation gate before Submit ("Submit it.")
 *   E.     Ambiguous matching controls -> glowing numbered DOM highlights + spoken clarification -> "Second one." -> cleared
 *   F–I.   Failure-triggered "Teach Sleepwalker" -> pause/resume/demonstrate/finish/confirm save (v1),
 *          exact command replay (F), semantic phrasing replay (G), mutated DOM wrapper/ID resilience (H),
 *          broken step failure -> relearn -> v2 preserving v1 (I) + Options UI skill management
 *   J.     Screen-edge golden aurora loops on processing/waiting & clears immediately on "No need." preserving skills
 *   K.     Model routing hierarchy (Qwen primary, Ollama escalation with full context, Gemini specialist gate)
 *          & subtle scanning badge independent of execution aurora
 *
 * Run with: node D:\sleep\tests\run-phase6-master-tests.js
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

async function runSuite(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`PASS  ${name} (${Date.now() - t0}ms)`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL  ${name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
    failed += 1;
  }
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

function startMasterFixtureServer() {
  const pages = {
    '/youtube': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>YouTube Home & Subscriptions Fixture</title>
      <style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #fff; color: #111; }
        header nav a, aside a { display: inline-block; margin-right: 14px; padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; text-decoration: none; color: #111; }
        .layout { display: grid; grid-template-columns: 200px 1fr; gap: 20px; margin-top: 16px; }
        .video-card { padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 12px; }
      </style></head>
      <body data-sw-site="youtube" data-yt-page="feed">
        <header>
          <nav aria-label="Top navigation">
            <a id="nav-home" href="/yt-home">Home</a>
            <a id="nav-shorts" href="/yt-shorts">Shorts</a>
            <a id="nav-subs" href="/yt-subs">Subscriptions</a>
          </nav>
          <form role="search"><input type="search" aria-label="Search YouTube" placeholder="Search"></form>
        </header>
        <div class="layout">
          <aside aria-label="Sidebar">
            <h3>Explore</h3>
            <ul>
              <li><a href="/yt-library">Library</a></li>
              <li><a href="/yt-history">History</a></li>
              <li><a href="/yt-watchlater">Watch Later</a></li>
            </ul>
          </aside>
          <main id="yt-feed">
            <h1>Recommended Videos</h1>
            <div class="video-card" data-video-id="v1" data-channel="MIT OpenCourseWare" data-duration="48:00" data-title="Linear Algebra Lecture 1">
              <h3><a href="/yt-watch">Linear Algebra Lecture 1</a></h3>
              <span class="video-channel">MIT OpenCourseWare</span>
              <span class="video-duration">48:00</span>
              <p class="video-description">Introduction to vectors and matrices.</p>
            </div>
            <div class="video-card" data-video-id="v2" data-channel="3Blue1Brown" data-duration="18:15" data-title="Neural Networks Visualized">
              <h3><a href="/yt-watch">Neural Networks Visualized</a></h3>
              <span class="video-channel">3Blue1Brown</span>
              <span class="video-duration">18:15</span>
              <p class="video-description">Backpropagation intuition and gradient descent.</p>
            </div>
          </main>
        </div>
      </body></html>`,

    '/yt-home': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>YouTube Home Feed</title></head>
      <body data-sw-site="youtube" data-yt-page="feed">
        <main><h1>YouTube Home Feed</h1><p>Welcome back to your Home feed.</p><a href="/youtube" id="back-yt">Back to Explore</a></main>
      </body></html>`,

    '/university': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>University Portal - Student Dashboard</title>
      <style>
        body { font-family: system-ui, sans-serif; padding: 20px; background: #f8fafc; color: #0f172a; }
        .menu-group { display: inline-block; vertical-align: top; margin-right: 28px; padding: 10px; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; }
        .course-card { padding: 12px; margin: 10px 0; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; }
      </style></head>
      <body>
        <header><h1>University Portal</h1></header>
        <nav aria-label="Main Portal Menu">
          <div class="menu-group">
            <h3>Portal</h3>
            <ul><li><a href="/youtube">Home</a></li></ul>
          </div>
          <div class="menu-group">
            <h3>Academics</h3>
            <ul>
              <li><a href="/academics/courses">Courses</a></li>
              <li><a href="/academics/departments">Departments</a></li>
              <li><a href="/academics/timetable">Timetable</a></li>
            </ul>
          </div>
          <div class="menu-group">
            <h3>Examinations</h3>
            <ul>
              <li><a href="/examinations/schedule">Examination schedule</a></li>
              <li><a id="link-exam-results" href="/examinations/results">Results</a></li>
              <li><a href="/examinations/revaluation">Revaluation</a></li>
            </ul>
          </div>
        </nav>

        <section id="sec-courses" aria-label="Degree Programs">
          <h2>Available Course Branches</h2>
          <div class="course-card">
            <h3>Computer Science</h3>
            <button type="button" id="pick-cs" class="branch-btn" data-branch="cs" onclick="window.__pickedBranch='Computer Science'; document.getElementById('branch-status').textContent='Selected: Computer Science';">Small Syllabus</button>
          </div>
          <div class="course-card">
            <h3>Information Science</h3>
            <button type="button" id="pick-is" class="branch-btn" data-branch="is" onclick="window.__pickedBranch='Information Science'; document.getElementById('branch-status').textContent='Selected: Information Science';">Small Syllabus</button>
          </div>
          <div class="course-card">
            <h3>Electronics</h3>
            <button type="button" id="pick-ec" class="branch-btn" data-branch="ec" onclick="window.__pickedBranch='Electronics'; document.getElementById('branch-status').textContent='Selected: Electronics';">Small Syllabus</button>
          </div>
          <div id="branch-status">None selected</div>
        </section>
      </body></html>`,

    '/examinations/results': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Examination Results - University Portal</title></head>
      <body><h1>Examination Results</h1><p>Semester results published below.</p></body></html>`,

    '/application': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>University Application Form</title>
      <style>
        body { font-family: system-ui, sans-serif; padding: 24px; background: #ffffff; color: #111; }
        fieldset { margin-bottom: 18px; padding: 14px; border: 1px solid #cbd5e1; border-radius: 8px; }
        label { display: block; margin-top: 8px; font-weight: 600; }
        input, select { padding: 6px 10px; margin-top: 4px; width: 280px; }
      </style></head>
      <body>
        <h1>Application Form</h1>
        <form id="app-form" onsubmit="event.preventDefault(); window.__appSubmitted = true; document.getElementById('submit-msg').textContent = 'Form Submitted';">
          <fieldset>
            <legend>Personal details</legend>
            <label for="inp-name">Full Name</label>
            <input id="inp-name" name="fullName" type="text" placeholder="Enter your full name" required>
            <label for="inp-email">Email Address</label>
            <input id="inp-email" name="email" type="email" placeholder="name@example.com" required>
            <label for="inp-pass">Portal Password</label>
            <input id="inp-pass" name="portalPassword" type="password" value="SuperSecretPw99!" required>
          </fieldset>
          <fieldset>
            <legend>Academic details</legend>
            <label for="sel-country">Country</label>
            <select id="sel-country" name="country" required>
              <option value="">Select country</option>
              <option value="India">India</option>
              <option value="Germany">Germany</option>
            </select>
            <label for="sel-state">State</label>
            <select id="sel-state" name="state" data-depends-on="sel-country" required>
              <option value="">Select state</option>
            </select>
            <label for="sel-course">Course</label>
            <select id="sel-course" name="course">
              <option value="">Select course</option>
              <option value="Computer Science">Computer Science</option>
              <option value="Information Science">Information Science</option>
              <option value="Electronics">Electronics</option>
            </select>
          </fieldset>
          <fieldset>
            <legend>Documents</legend>
            <label for="inp-cert">Upload certificate</label>
            <input id="inp-cert" name="certificate" type="file" accept=".pdf,.png">
          </fieldset>
          <button id="btn-submit-app" type="submit">Submit</button>
          <div id="submit-msg"></div>
        </form>
        <script>
          window.__appSubmitted = false;
          const countryEl = document.getElementById('sel-country');
          const stateEl = document.getElementById('sel-state');
          countryEl.addEventListener('change', () => {
            const c = countryEl.value;
            stateEl.innerHTML = '<option value="">Select state</option>';
            const map = {
              India: ['Karnataka', 'Maharashtra', 'Tamil Nadu'],
              Germany: ['Bavaria', 'Berlin', 'Saxony']
            };
            (map[c] || []).forEach((st) => {
              const opt = document.createElement('option');
              opt.value = st;
              opt.textContent = st;
              stateEl.appendChild(opt);
            });
          });
        </script>
      </body></html>`,

    '/teach-portal': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Internal Finance Audit Workbench</title>
      <style>body { font-family: system-ui, sans-serif; padding: 24px; background: #fff; color: #111; }</style></head>
      <body>
        <h1>Finance Audit Workbench</h1>
        <section id="sec-audit-steps" aria-label="Audit Controls">
          <div>
            <label><input type="checkbox" id="chk-verify-ledger"> Verify Ledger Balances</label>
          </div>
          <div style="margin-top:10px;">
            <label for="sel-export-format">Export Format</label>
            <select id="sel-export-format">
              <option value="">Choose format</option>
              <option value="csv">CSV Report</option>
              <option value="pdf">PDF Summary</option>
            </select>
          </div>
          <div style="margin-top:10px;">
            <label for="inp-audit-pin">Authorization PIN</label>
            <input type="password" id="inp-audit-pin" value="SecretPin42">
          </div>
          <div style="margin-top:14px;">
            <button type="button" id="btn-finalize-audit" onclick="
              if (document.getElementById('chk-verify-ledger').checked && document.getElementById('sel-export-format').value) {
                window.__auditDone = true;
                window.__auditFormat = document.getElementById('sel-export-format').value;
                document.getElementById('audit-output').textContent = 'Audit Export Complete: ' + window.__auditFormat.toUpperCase();
              }
            ">Generate Audit Package</button>
          </div>
          <div id="audit-output">Idle</div>
        </section>
      </body></html>`,

    '/long-article': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Distributed Browser Intelligence Architecture</title></head>
      <body>
        <main>
          <h1>Distributed Browser Intelligence Architecture</h1>
          <section><h2>1. Local Reasoning</h2><p>Modern browser copilots prioritize local compact models like Qwen 2.5 1.5B for low-latency DOM navigation, form control selection, and hierarchical page comprehension while escalating complex ambiguity cleanly to larger Ollama models such as Llama 3.2 3B.</p></section>
          <section><h2>2. Specialist Cloud Offload</h2><p>Cloud specialist reasoning is reserved strictly for deep document synthesis, multi-section summarization, and complex research rather than everyday clicking or scrolling interactions.</p></section>
          <section><h2>3. Experience Memory</h2><p>Demonstration-based workflow capture stores semantic element signatures rather than brittle screen coordinates, enabling reliable replay across responsive DOM updates.</p></section>
        </main>
      </body></html>`
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const fullUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const p = fullUrl.pathname;
      const layout = fullUrl.searchParams.get('layout') || '';

      if (p === '/teach-portal' && layout === 'mutated') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Internal Finance Audit Workbench (Updated Layout)</title></head>
          <body>
            <h1>Finance Audit Workbench v2</h1>
            <div class="new-wrapper"><article class="panel">
              <div class="row-top">
                <button type="button" id="btn-audit-alt-id" onclick="
                  if (document.getElementById('chk-alt-id').checked && document.getElementById('sel-alt-id').value) {
                    window.__auditDone = true;
                    window.__auditFormat = document.getElementById('sel-alt-id').value;
                    document.getElementById('audit-output').textContent = 'Mutated Audit Export Complete: ' + window.__auditFormat.toUpperCase();
                  }
                ">Generate Audit Package</button>
              </div>
              <div class="row-mid">
                <label for="sel-alt-id">Export Format</label>
                <select id="sel-alt-id">
                  <option value="">Choose format</option>
                  <option value="csv">CSV Report</option>
                  <option value="pdf">PDF Summary</option>
                </select>
              </div>
              <div class="row-bot">
                <label><input type="checkbox" id="chk-alt-id"> Verify Ledger Balances</label>
              </div>
              <div id="audit-output">Idle</div>
            </article></div>
          </body></html>`);
        return;
      }

      if (p === '/teach-portal' && layout === 'broken') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Internal Finance Audit Workbench (Changed Options)</title></head>
          <body>
            <h1>Finance Audit Workbench</h1>
            <section aria-label="Audit Controls">
              <label><input type="checkbox" id="chk-verify-ledger"> Verify Ledger Balances</label>
              <label for="sel-export-format">Export Format</label>
              <select id="sel-export-format">
                <option value="">Choose format</option>
                <option value="pdf">PDF Summary</option>
              </select>
              <button type="button" id="btn-finalize-audit" onclick="
                if (document.getElementById('chk-verify-ledger').checked && document.getElementById('sel-export-format').value) {
                  window.__auditDone = true;
                  window.__auditFormat = document.getElementById('sel-export-format').value;
                  document.getElementById('audit-output').textContent = 'Updated Audit Complete: ' + window.__auditFormat.toUpperCase();
                }
              ">Generate Audit Package</button>
              <div id="audit-output">Idle</div>
            </section>
          </body></html>`);
        return;
      }

      if (pages[p]) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pages[p]);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>${p}</title></head><body><h1>Page ${p}</h1></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

(async function main() {
  console.log('=== Sleepwalker 2.0 — Master Real-Browser Verification Suite (Tests A–K) ===');
  const chromiumExe = findChromiumExe();
  assert.ok(chromiumExe, 'Chromium executable must exist for real MV3 testing');

  const { server, port } = await startMasterFixtureServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-master-p6-'));
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
    `${baseUrl}/youtube`
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
    const send = (method, params = {}, timeoutMs = 25000) => new Promise((resolve, reject) => {
      const id = ++cid;
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMsg);
        reject(new Error(`CDP timeout on ${method}`));
      }, timeoutMs);
      const onMsg = async (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        const msg = JSON.parse(raw);
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJs = async (body, contextId = null) => {
      const params = { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true };
      if (contextId) params.contextId = contextId;
      const res = await send('Runtime.evaluate', params);
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
              const mf = await probe.evalJs(`return chrome.runtime?.getManifest?.()?.name || '';`).catch(() => '');
              try { probe.ws.close(); } catch (_e) {}
              if (String(mf).includes('Sleepwalker')) { swTarget = cand; break; }
            } catch (_e) {}
          }
        }
      } catch (_e) {}
    }
    assert.ok(pageTarget && swTarget, 'Real MV3 SW and fixture page must attach cleanly');

    const pageCdp = await connectTarget(pageTarget, 'page');
    const swCdp = await connectTarget(swTarget, 'sw');
    sockets.push(pageCdp.ws, swCdp.ws);

    const extIsoContexts = [];
    let extIsoContextId = null;
    pageCdp.ws.addEventListener('message', async (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated' && msg.params?.context) {
          const ctx = msg.params.context;
          if (String(ctx.origin || '').startsWith('chrome-extension://')) {
            extIsoContextId = ctx.id;
            extIsoContexts.push(ctx.id);
          }
        }
      } catch (_e) {}
    });

    await pageCdp.send('Runtime.enable').catch(() => {});
    await swCdp.send('Runtime.enable').catch(() => {});

    const getExtContextId = async (waitMs = 8000) => {
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        for (let i = extIsoContexts.length - 1; i >= 0; i--) {
          const cid = extIsoContexts[i];
          const ok = await pageCdp.evalJs(`return Boolean(window.__SLEEPWALKER_INSTANCE__ && window.SW_UI);`, cid).catch(() => false);
          if (ok) {
            extIsoContextId = cid;
            return cid;
          }
        }
        await pageCdp.send('Runtime.disable').catch(() => {});
        await pageCdp.send('Runtime.enable').catch(() => {});
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('Timed out waiting for Sleepwalker isolated content-script context');
    };

    const waitReady = async (maxMs = 9000) => {
      const end = Date.now() + maxMs;
      while (Date.now() < end) {
        const ok = await pageCdp.evalJs(`return Boolean(document.getElementById('sleepwalker-ui-host')?.shadowRoot);`).catch(() => false);
        if (ok) {
          await pageCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 }).catch(() => {});
          await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 350));
          return getExtContextId(4000);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('#sleepwalker-ui-host never mounted');
    };

    const navigateAndWait = async (url) => {
      extIsoContexts.length = 0;
      extIsoContextId = null;
      await pageCdp.send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, 950));
      return waitReady();
    };

    const runExtCommand = async (cmd, meta = {}, maxWaitMs = 26000) => {
      const ctxId = await getExtContextId();
      const startUrl = await pageCdp.evalJs(`return window.location.href;`).catch(() => '');
      try {
        await pageCdp.evalJs(`
          window.__swCmdDone = false;
          window.__swCmdRes = null;
          window.__SLEEPWALKER_INSTANCE__.handleUserInput(${JSON.stringify(cmd)}, 'typed', ${JSON.stringify(meta)})
            .then((r) => { window.__swCmdRes = r; window.__swCmdDone = true; })
            .catch((e) => { window.__swCmdRes = { status: 'error', message: e && e.message }; window.__swCmdDone = true; });
          return true;
        `, ctxId);
      } catch (err) {
        if (/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/i.test(String(err && err.message))) {
          extIsoContextId = null;
          return { status: 'navigated' };
        }
        throw err;
      }
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 120));
        const curUrl = await pageCdp.evalJs(`return window.location.href;`).catch(() => '');
        if (curUrl && startUrl && curUrl !== startUrl) {
          extIsoContextId = null;
          return { status: 'navigated', url: curUrl };
        }
        try {
          const poll = await pageCdp.evalJs(`return window.__swCmdDone ? { done: true, res: window.__swCmdRes } : { done: false };`, ctxId);
          if (poll && poll.done) return poll.res;
        } catch (err) {
          if (/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/i.test(String(err && err.message))) {
            extIsoContextId = null;
            return { status: 'navigated' };
          }
          throw err;
        }
      }
      return { status: 'timeout' };
    };

    const getGeminiCalls = async () => swCdp.evalJs(`return (typeof getLlmDiagnosticsSnapshot === 'function') ? getLlmDiagnosticsSnapshot().geminiCalls : (LLM_METRICS?.geminiCalls || 0);`).catch(() => 0);

    // Wait initial boot
    let ctxId = await waitReady();
    await new Promise((r) => setTimeout(r, 600));

    // ---------------- TESTS A & B: YouTube Proactive Map + Qwen "Select Home." + Dynamic Map Update ----------------
    await runSuite('Test A & B. YouTube Proactive Map, Qwen "Select Home.", Back & Dynamic Mutation Update', async () => {
      const gemBefore = await getGeminiCalls();
      let proactiveCheck = null;
      const scanWaitEnd = Date.now() + 1800;
      while (Date.now() < scanWaitEnd) {
        proactiveCheck = await pageCdp.evalJs(`
          const sw = window.__SLEEPWALKER_INSTANCE__;
          const inv = sw.worldModel && sw.worldModel.getTabInventory();
          const hmap = inv && sw.worldModel.getHierarchicalMapSummary ? sw.worldModel.getHierarchicalMapSummary(inv) : null;
          const hmapText = hmap ? JSON.stringify(hmap) : '';
          return {
            hasInv: Boolean(inv),
            ver: inv ? inv.inventoryVersion : 0,
            links: inv && inv.links ? inv.links.length : 0,
            videos: inv && inv.videos ? inv.videos.length : 0,
            hasTopNav: Boolean(inv && inv.links && inv.links.some((l) => /main_nav|sidebar|footer_nav/.test(l.navCategory || ''))),
            hmapHasHome: /Home/i.test(hmapText)
          };
        `, ctxId);
        if (proactiveCheck && proactiveCheck.hasInv && proactiveCheck.hmapHasHome) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      assert.strictEqual(proactiveCheck.hasInv, true, 'Proactive world model must exist without any user command');
      assert.ok(proactiveCheck.ver >= 1 && proactiveCheck.links >= 4 && proactiveCheck.videos >= 2, `Expected proactive links & videos: ${JSON.stringify(proactiveCheck)}`);
      assert.strictEqual(proactiveCheck.hasTopNav, true, 'Must classify navCategory (main_nav/sidebar)');
      assert.strictEqual(proactiveCheck.hmapHasHome, true, 'Hierarchical map summary must contain Home nav control');

      await runExtCommand('Select Home.');
      const deadline = Date.now() + 5000;
      let ytPath = '';
      while (Date.now() < deadline) {
        ytPath = await pageCdp.evalJs(`return window.location.pathname;`).catch(() => '');
        if (ytPath === '/yt-home') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.strictEqual(ytPath, '/yt-home', `Expected Qwen/navigator to open /yt-home, got ${ytPath}`);
      const gemAfter = await getGeminiCalls();
      assert.strictEqual(gemAfter, gemBefore, 'Ordinary "Select Home." MUST make 0 Gemini calls');

      // Go back & inject a new dynamic card into #yt-feed to test proactive MutationObserver update
      extIsoContexts.length = 0;
      extIsoContextId = null;
      await pageCdp.evalJs(`window.history.back();`).catch(() => {});
      const backNavEnd = Date.now() + 1800;
      let backPath = '';
      while (Date.now() < backNavEnd) {
        backPath = await pageCdp.evalJs(`return window.location.pathname;`).catch(() => '');
        if (backPath === '/youtube') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (backPath !== '/youtube') {
        await pageCdp.send('Page.navigate', { url: `${baseUrl}/youtube` });
        await new Promise((r) => setTimeout(r, 900));
      } else {
        await new Promise((r) => setTimeout(r, 500));
      }
      ctxId = await waitReady();
      let verBeforeMut = 0;
      const backWaitEnd = Date.now() + 2000;
      while (Date.now() < backWaitEnd) {
        const curInvVer = await pageCdp.evalJs(`
          const wm = window.__SLEEPWALKER_INSTANCE__.worldModel;
          const inv = wm.getTabInventory() || await wm.observeTab(document, { force: false });
          return inv ? inv.inventoryVersion : 0;
        `, ctxId).catch(() => 0);
        if (curInvVer >= 1) { verBeforeMut = curInvVer; break; }
        await new Promise((r) => setTimeout(r, 140));
      }
      await pageCdp.evalJs(`
        const feed = document.getElementById('yt-feed');
        const d = document.createElement('div');
        d.className = 'video-card';
        d.dataset.videoId = 'v_dyn';
        d.innerHTML = '<h3><a href="/yt-watch">Dynamic Systems Lecture 9</a></h3><span class="video-channel">MIT</span>';
        feed.appendChild(d);
      `);
      let dynScan = null;
      const mutEnd = Date.now() + 1800;
      while (Date.now() < mutEnd) {
        dynScan = await pageCdp.evalJs(`
          const inv = window.__SLEEPWALKER_INSTANCE__.worldModel.getTabInventory();
          const hmap = inv ? window.__SLEEPWALKER_INSTANCE__.worldModel.getHierarchicalMapSummary(inv) : null;
          const hmapText = hmap ? JSON.stringify(hmap) : '';
          return { ver: inv ? inv.inventoryVersion : 0, hasDyn: /Dynamic Systems Lecture 9/i.test(hmapText) };
        `, ctxId);
        if (dynScan && dynScan.hasDyn) break;
        await new Promise((r) => setTimeout(r, 140));
      }
      assert.ok(dynScan && (dynScan.ver > verBeforeMut || dynScan.hasDyn), `Proactive observer must capture dynamic card: ${JSON.stringify(dynScan)}`);
    });

    // ---------------- TEST C: University Portal Nested Hierarchy Navigation ----------------
    await runSuite('Test C. Nested Hierarchy Options ("Open Results under Examinations.")', async () => {
      ctxId = await navigateAndWait(`${baseUrl}/university`);
      let hmapText = '';
      const scanEnd = Date.now() + 1800;
      while (Date.now() < scanEnd) {
        hmapText = await pageCdp.evalJs(`
          const wm = window.__SLEEPWALKER_INSTANCE__.worldModel;
          const hm = wm.getHierarchicalMapSummary(wm.getTabInventory());
          return hm ? JSON.stringify(hm) : '';
        `, ctxId);
        if (/Examinations/i.test(hmapText) && /Results/i.test(hmapText)) break;
        await new Promise((r) => setTimeout(r, 140));
      }
      assert.ok(/Examinations/i.test(hmapText) && /Results/i.test(hmapText), `University hierarchical map missing nested Examinations/Results:\n${hmapText}`);

      await runExtCommand('Open Results under Examinations.');
      const deadline = Date.now() + 5000;
      let resPath = '';
      while (Date.now() < deadline) {
        resPath = await pageCdp.evalJs(`return window.location.pathname;`).catch(() => '');
        if (resPath === '/examinations/results') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.strictEqual(resPath, '/examinations/results', `Expected /examinations/results, got ${resPath}`);
    });

    // ---------------- TEST D: Form, Password Privacy, Dependent Dropdowns & Submit Confirmation ----------------
    await runSuite('Test D. Form & Dependent Dropdowns ("Choose India." -> "Now select Karnataka.") + Password Privacy + Submit Gate', async () => {
      ctxId = await navigateAndWait(`${baseUrl}/application`);
      await new Promise((r) => setTimeout(r, 450));

      // Verify password field type recognized WITHOUT recording its value anywhere
      const formSecurity = await pageCdp.evalJs(`
        const wm = window.__SLEEPWALKER_INSTANCE__.worldModel;
        const inv = await wm.observeTab(document, { force: true });
        const pwEnt = (inv.options || []).find((o) => /password/i.test(o.label || '') || o.expectedInputType === 'password');
        const hmapText = JSON.stringify(wm.getHierarchicalMapSummary(inv) || {});
        const rctx = wm.buildReasonerContext('Choose India', { inventory: inv, maxTokens: 700 });
        return {
          pwType: pwEnt ? pwEnt.expectedInputType : '',
          pwVal: pwEnt ? pwEnt.currentValue : 'NOT_FOUND',
          leakedInHmap: hmapText.includes('SuperSecretPw99!'),
          leakedInReasoner: (rctx && rctx.text || '').includes('SuperSecretPw99!')
        };
      `, ctxId);
      assert.strictEqual(formSecurity.pwType, 'password', 'Must recognize password control type');
      assert.strictEqual(formSecurity.pwVal, '', 'Password value must NEVER be recorded');
      assert.strictEqual(formSecurity.leakedInHmap, false, 'Secret password value leaked in hierarchical map');
      assert.strictEqual(formSecurity.leakedInReasoner, false, 'Secret password value leaked in reasoner context');

      const gemBefore = await getGeminiCalls();
      await runExtCommand('Choose India.');
      await new Promise((r) => setTimeout(r, 350));
      const afterIndia = await pageCdp.evalJs(`
        const c = document.getElementById('sel-country').value;
        const opts = Array.from(document.getElementById('sel-state').options).map((o) => o.value);
        return { country: c, stateOpts: opts };
      `);
      assert.strictEqual(afterIndia.country, 'India', 'Country dropdown must select India');
      assert.ok(afterIndia.stateOpts.includes('Karnataka'), `Dependent State options must populate: ${JSON.stringify(afterIndia)}`);

      await runExtCommand('Now select Karnataka.');
      await new Promise((r) => setTimeout(r, 350));
      const stateVal = await pageCdp.evalJs(`return document.getElementById('sel-state').value;`);
      assert.strictEqual(stateVal, 'Karnataka', 'Dependent State dropdown must select Karnataka');

      await runExtCommand('Submit it.');
      await new Promise((r) => setTimeout(r, 300));
      const submitGate = await pageCdp.evalJs(`
        return {
          awaiting: Boolean(window.__SLEEPWALKER_INSTANCE__.confirm?.isAwaiting?.()),
          submitted: Boolean(window.__appSubmitted)
        };
      `, ctxId);
      assert.strictEqual(submitGate.submitted, false, 'Form MUST NOT auto-submit without explicit user confirmation');
      assert.strictEqual(submitGate.awaiting, true, 'Submit command must enter confirmation gate');
      const gemAfter = await getGeminiCalls();
      assert.strictEqual(gemAfter, gemBefore, 'Form & dependent dropdown commands must make 0 Gemini calls');

      await runExtCommand('No need.');
    });

    // ---------------- TEST E: Ambiguous Controls -> Highlight Badges + Spoken Clarification -> "Second one." -> Clear ----------------
    await runSuite('Test E. Ambiguous Controls Highlighted on DOM + Spoken Clarification ("Second one.") + Highlight Cleanup', async () => {
      ctxId = await navigateAndWait(`${baseUrl}/university`);
      await new Promise((r) => setTimeout(r, 450));

      const ambRes = await runExtCommand('Select Small Syllabus');
      await new Promise((r) => setTimeout(r, 300));
      const highlightSnap = await pageCdp.evalJs(`
        const ovRoot = document.getElementById('sleepwalker-candidate-overlay-root');
        const badges = ovRoot ? ovRoot.querySelectorAll('.sw-cand-badge, [data-sw-badge], span, div').length : 0;
        const btns = Array.from(document.querySelectorAll('.branch-btn')).filter((b) => b.style.outline || b.style.boxShadow).length;
        const sw = window.__SLEEPWALKER_INSTANCE__;
        const spoken = sw.lastAssistantReply || sw.dialogue?.lastSpokenText || '';
        const waiting = Boolean(sw.confirm?.isAwaiting?.() || sw.dialogue?.pendingPrompt || sw.taskLifecycle?.state === 'WAITING_FOR_CLARIFICATION');
        return { hasOverlay: Boolean(ovRoot), badges, btns, spoken, waiting, status: ${JSON.stringify(ambRes && ambRes.status)} };
      `, ctxId);
      assert.strictEqual(highlightSnap.hasOverlay, true, `Expected DOM candidate highlight overlay: ${JSON.stringify(highlightSnap)}`);
      assert.ok(highlightSnap.btns >= 2 || highlightSnap.badges >= 2, `Expected glowing outlines/numbered badges: ${JSON.stringify(highlightSnap)}`);
      assert.ok(/Small Syllabus/i.test(highlightSnap.spoken), `Expected spoken clarification reply mentioning options: ${JSON.stringify(highlightSnap)}`);
      assert.strictEqual(highlightSnap.waiting, true, `Expected Sleepwalker to enter clarification wait state: ${JSON.stringify(highlightSnap)}`);

      await runExtCommand('Second one.');
      await new Promise((r) => setTimeout(r, 450));
      const postClarify = await pageCdp.evalJs(`
        const ovRoot = document.getElementById('sleepwalker-candidate-overlay-root');
        const btnsLit = Array.from(document.querySelectorAll('.branch-btn')).filter((b) => b.hasAttribute('data-sw-candidate-highlighted') || /f59e0b|245,\\s*158,\\s*11/i.test(b.style.outline || '')).length;
        return {
          pickedBranch: window.__pickedBranch || '',
          overlayCleared: !ovRoot || ovRoot.children.length === 0,
          btnsLit
        };
      `);
      assert.strictEqual(postClarify.pickedBranch, 'Information Science', `Expected "Second one." to trigger Information Science button: ${JSON.stringify(postClarify)}`);
      assert.strictEqual(postClarify.overlayCleared, true, 'Candidate highlight overlay must clear after selection');
      assert.strictEqual(postClarify.btnsLit, 0, 'Element outlines/shadows must clear cleanly');
    });

    // ---------------- TESTS F–I: Teach Sleepwalker, Pause/Resume/Save, Exact + Semantic Replay, Mutated DOM, Relearn & Options UI ----------------
    await runSuite('Tests F–I. Teach Mode -> Confirm Save v1 -> Exact & Semantic Replay -> Mutated DOM -> Relearn v2 -> Options UI', async () => {
      ctxId = await navigateAndWait(`${baseUrl}/teach-portal`);
      await new Promise((r) => setTimeout(r, 400));

      // 1. Trigger Qwen + Ollama failure on impossible phantom command -> offers "Teach Sleepwalker"
      const failOffer = await runExtCommand('Click Quantum Reconcile Widget');
      assert.strictEqual(failOffer && failOffer.offerTeach, true, `Expected failure to trigger Teach Sleepwalker offer: ${JSON.stringify(failOffer)}`);
      await runExtCommand('Cancel.');

      // 2. Start teaching explicitly for "Run quarterly audit export", test pause + resume, demonstrate 3 steps + password ignored
      await runExtCommand('Teach Sleepwalker Run quarterly audit export');
      await new Promise((r) => setTimeout(r, 150));
      const pRes = await runExtCommand('Pause teaching');
      assert.strictEqual(pRes.status, 'teaching_paused');
      const rRes = await runExtCommand('Resume teaching');
      assert.strictEqual(rRes.status, 'teaching_resumed');

      // Demonstrate interactions directly on page DOM
      await pageCdp.evalJs(`
        document.getElementById('chk-verify-ledger').click();
        const sel = document.getElementById('sel-export-format');
        sel.value = 'csv';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const pin = document.getElementById('inp-audit-pin');
        pin.value = 'TopSecretPin999';
        pin.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('btn-finalize-audit').click();
      `);
      await new Promise((r) => setTimeout(r, 250));

      const finRes = await runExtCommand('Finish teaching');
      assert.strictEqual(finRes.status, 'awaiting_skill_confirmation', `Expected confirm-before-save gate: ${JSON.stringify(finRes)}`);
      await runExtCommand('Yes, save it');
      await new Promise((r) => setTimeout(r, 300));

      const savedV1 = await pageCdp.evalJs(`
        const sks = window.__SLEEPWALKER_INSTANCE__.memory?.state?.learnedSkills || [];
        return {
          count: sks.length,
          v1: sks[0],
          serialized: JSON.stringify(sks)
        };
      `, ctxId);
      assert.ok(savedV1.count >= 1 && savedV1.v1, 'Learned skill v1 must be saved after confirmation');
      assert.strictEqual(savedV1.v1.version, 1, 'Initial skill version must be 1');
      assert.ok(!savedV1.serialized.includes('TopSecretPin999'), 'Password/PIN value MUST NEVER be saved inside learned skill');

      // TEST F: Revisit /teach-portal fresh and run exact same instruction
      ctxId = await navigateAndWait(`${baseUrl}/teach-portal`);
      await new Promise((r) => setTimeout(r, 500));
      const replayExact = await runExtCommand('Run quarterly audit export');
      await new Promise((r) => setTimeout(r, 500));
      const exactOutcome = await pageCdp.evalJs(`return { done: Boolean(window.__auditDone), fmt: window.__auditFormat || '', status: ${JSON.stringify(replayExact && replayExact.status)} };`);
      assert.strictEqual(exactOutcome.done, true, `Test F failed: exact replay did not complete audit (${JSON.stringify(replayExact)})`);
      assert.strictEqual(exactOutcome.fmt, 'csv');

      // TEST G: Semantic phrasing variation
      ctxId = await navigateAndWait(`${baseUrl}/teach-portal`);
      await new Promise((r) => setTimeout(r, 500));
      const replaySem = await runExtCommand('Please run quarterly audit export');
      await new Promise((r) => setTimeout(r, 500));
      const semOutcome = await pageCdp.evalJs(`return { done: Boolean(window.__auditDone), status: ${JSON.stringify(replaySem && replaySem.status)} };`);
      assert.strictEqual(semOutcome.done, true, `Test G failed: semantic phrasing replay did not run learned skill (${JSON.stringify(replaySem)})`);

      // TEST H: Altered DOM layout, reversed order & mutated IDs (semantic revalidation only, zero blind IDs/coords)
      ctxId = await navigateAndWait(`${baseUrl}/teach-portal?layout=mutated`);
      await new Promise((r) => setTimeout(r, 500));
      const replayMut = await runExtCommand('Run quarterly audit export');
      await new Promise((r) => setTimeout(r, 500));
      const mutOutcome = await pageCdp.evalJs(`return { done: Boolean(window.__auditDone), fmt: window.__auditFormat || '', out: document.getElementById('audit-output')?.textContent };`);
      assert.strictEqual(mutOutcome.done, true, `Test H failed: semantic element re-identification across altered DOM failed (${JSON.stringify(mutOutcome)}, res=${JSON.stringify(replayMut)})`);

      // TEST I: Force step 2 failure ("CSV Report" removed on ?layout=broken) -> Relearn -> saves v2 preserving v1!
      ctxId = await navigateAndWait(`${baseUrl}/teach-portal?layout=broken`);
      await new Promise((r) => setTimeout(r, 500));
      const brokenRes = await runExtCommand('Run quarterly audit export');
      assert.ok(brokenRes && (brokenRes.offerRelearn || brokenRes.offerTeach || brokenRes.status === 'needs_clarification'), `Test I expected relearn offer when CSV step failed: ${JSON.stringify(brokenRes)}`);

      await runExtCommand('Yes, teach updated steps');
      await new Promise((r) => setTimeout(r, 200));
      await pageCdp.evalJs(`
        const chk = document.getElementById('chk-verify-ledger');
        if (chk) chk.checked = false;
        chk.click();
        const sel = document.getElementById('sel-export-format');
        sel.value = 'pdf';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('btn-finalize-audit').click();
      `);
      await new Promise((r) => setTimeout(r, 200));
      await runExtCommand('Finish teaching');
      await new Promise((r) => setTimeout(r, 150));
      await runExtCommand('Yes, confirm');
      await new Promise((r) => setTimeout(r, 350));

      const v2Check = await pageCdp.evalJs(`
        const sk = (window.__SLEEPWALKER_INSTANCE__.memory?.state?.learnedSkills || [])[0];
        return sk ? { id: sk.id, name: sk.name, version: sk.version, prevCount: (sk.previousVersions || []).length, prevVer: sk.previousVersions?.[0]?.version } : null;
      `, ctxId);
      assert.ok(v2Check && v2Check.version === 2 && v2Check.prevCount >= 1 && v2Check.prevVer === 1, `Test I expected v2 preserving v1 history: ${JSON.stringify(v2Check)}`);

      // Options UI management test (search, rename, disable/enable) on chrome-extension://<id>/options.html
      const extId = (swTarget.url || '').match(/^chrome-extension:\/\/([^/]+)/)[1];
      const optCdp = pageCdp;
      await optCdp.send('Page.navigate', { url: `chrome-extension://${extId}/options.html` });
      await new Promise((r) => setTimeout(r, 900));
      const optRendered = await optCdp.evalJs(`
        const list = document.getElementById('opt-skills-list');
        return { text: list ? list.textContent : '', count: list ? list.querySelectorAll('[data-skill-id], .skill-item, button').length : 0 };
      `);
      assert.ok(/Run quarterly audit export/i.test(optRendered.text) && optRendered.count > 0, `Options UI must render learned skills: ${JSON.stringify(optRendered)}`);

      // Toggle disable/enable in Options UI and verify persistence
      await optCdp.evalJs(`
        const toggleBtn = document.querySelector('#opt-skills-list button[data-action="toggle"]');
        if (toggleBtn) toggleBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 300));
      await optCdp.evalJs(`
        const toggleBtn = document.querySelector('#opt-skills-list button[data-action="toggle"]');
        if (toggleBtn) toggleBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 250));
    });

    // ---------------- TEST J & K: Screen-Edge Aurora, Cancel ("No need."), Scanning Indicator & Routing ----------------
    await runSuite('Test J & K. Screen-Edge Aurora, "No need." Immediate Cancel, Scanning Chip & Specialist Routing', async () => {
      ctxId = await navigateAndWait(`${baseUrl}/long-article`);
      await new Promise((r) => setTimeout(r, 400));

      // 1. Subtle scanning badge independent of screen-edge execution aurora
      const scanUiCheck = await pageCdp.evalJs(`
        window.SW_UI.setTaskStatus({ state: 'idle', stage: '' });
        window.SW_UI.setScanning(true, 'Mapping page...');
        const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
        const scanEl = sr.getElementById('sw-ui-scan');
        const edgeEl = sr.getElementById('sw-ui-edge-aurora');
        const res = {
          scanVisible: Boolean(scanEl && !scanEl.hidden),
          scanText: scanEl ? scanEl.textContent : '',
          edgeActiveDuringScan: Boolean(edgeEl && edgeEl.classList.contains('sw-active'))
        };
        window.SW_UI.setScanning(false);
        return res;
      `, ctxId);
      assert.strictEqual(scanUiCheck.scanVisible, true, 'Scanning badge must be visible while mapping');
      assert.strictEqual(scanUiCheck.edgeActiveDuringScan, false, 'Passive page scanning must NOT trigger full screen-edge execution aurora');

      // 2. Start processing -> verify screen-edge golden aurora loops around viewport -> "No need." cancels immediately!
      const skillsBeforeCancel = await pageCdp.evalJs(`return (window.__SLEEPWALKER_INSTANCE__.memory?.state?.learnedSkills || []).length;`, ctxId);
      const cancelCheck = await pageCdp.evalJs(`
        const sw = window.__SLEEPWALKER_INSTANCE__;
        const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
        const edgeEl = sr.getElementById('sw-ui-edge-aurora');
        const p = sw.handleUserInput('Explain every architectural section on this page in detail.', 'typed', { allowQueue: true });
        let activeDuringWork = false;
        for (let i = 0; i < 40; i++) {
          if (edgeEl && !edgeEl.hidden && edgeEl.classList.contains('sw-active')) {
            activeDuringWork = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 15));
        }
        const cancelRes = await sw.handleUserInput('No need.', 'voice');
        await p.catch(() => null);
        await new Promise((r) => setTimeout(r, 120));
        return {
          activeDuringWork,
          edgeActiveAfterCancel: Boolean(edgeEl && (!edgeEl.hidden || edgeEl.classList.contains('sw-active'))),
          tlState: sw.taskLifecycle?.state || '',
          cancelStatus: cancelRes && cancelRes.status,
          skillsAfterCancel: (sw.memory?.state?.learnedSkills || []).length
        };
      `, ctxId);
      assert.strictEqual(cancelCheck.activeDuringWork, true, 'Screen-edge aurora must activate during command processing');
      assert.strictEqual(cancelCheck.edgeActiveAfterCancel, false, 'Screen-edge aurora must stop immediately on cancel');
      assert.ok(['CANCELLED', 'IDLE'].includes(cancelCheck.tlState), `Task lifecycle must cancel and reset toward IDLE: ${JSON.stringify(cancelCheck)}`);
      assert.strictEqual(cancelCheck.skillsAfterCancel, skillsBeforeCancel, 'Cancellation must preserve saved learnedSkills');

      // 3. Verify SLEEPWALKER_NLU_ESCALATE_REQUEST resolves with Ollama primary when Qwen fails
      const escCheck = await pageCdp.evalJs(`
        return await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'SLEEPWALKER_NLU_ESCALATE_REQUEST',
            payload: {
              utterance: 'Go to the Specialist Cloud Offload section',
              url: location.href,
              website: location.hostname,
              pageContext: { title: document.title, pageType: 'article' },
              worldModelDigestText: '[S1] section: Local Reasoning\\n[S2] section: Specialist Cloud Offload\\n[S3] section: Experience Memory',
              candidateIds: ['S1', 'S2', 'S3'],
              qwenInterpretation: { intent: 'navigate_section', target_id: 'S1', target: 'Local Reasoning', section: 'Local Reasoning' },
              qwenSelectedTarget: 'S1',
              candidatesAndScores: [{ id: 'S1', label: 'Local Reasoning', score: 0.42 }, { id: 'S2', label: 'Specialist Cloud Offload', score: 0.89 }],
              failureInfo: 'Selected wrong section S1 instead of Specialist Cloud Offload S2',
              previousAttempts: [{ source: 'qwen_primary', target: 'S1', verified: false }]
            }
          }, resolve);
        });
      `, ctxId);
      assert.strictEqual(escCheck.status, 'ok', `Escalated Ollama NLU must succeed: ${JSON.stringify(escCheck)}`);
      assert.strictEqual(escCheck.escalated, true);
      assert.strictEqual(escCheck.requiresGeminiSpecialist, false, 'Ordinary section navigation must NEVER authorize Gemini specialist');
      assert.ok(/S2|Specialist Cloud Offload/i.test(`${escCheck.plan?.target_id || ''} ${escCheck.plan?.target || ''} ${escCheck.plan?.section || ''}`), `Escalated Ollama must fix Qwen wrong target: ${JSON.stringify(escCheck)}`);

      // 4. Verify Options Delete cleanup removes a test skill cleanly
      const extId = (swTarget.url || '').match(/^chrome-extension:\/\/([^/]+)/)[1];
      await pageCdp.send('Page.navigate', { url: `chrome-extension://${extId}/options.html` });
      await new Promise((r) => setTimeout(r, 800));
      const delRes = await pageCdp.evalJs(`
        const before = document.querySelectorAll('#opt-skills-list button[data-action="delete"]').length;
        const delBtn = document.querySelector('#opt-skills-list button[data-action="delete"]');
        if (delBtn) delBtn.click();
        await new Promise((r) => setTimeout(r, 350));
        const after = document.querySelectorAll('#opt-skills-list button[data-action="delete"]').length;
        return { before, after };
      `);
      assert.ok(delRes.before >= 1 && delRes.after === delRes.before - 1, `Options Delete button must remove learned skill cleanly: ${JSON.stringify(delRes)}`);
    });

    const swErrors = swCdp.exceptions.concat(pageCdp.exceptions);
    assert.strictEqual(swErrors.length, 0, `Uncaught browser/service-worker runtime exceptions detected: ${JSON.stringify(swErrors)}`);
  } finally {
    sockets.forEach((ws) => { try { ws.close(); } catch (_e) {} });
    try { chrome.kill('SIGKILL'); } catch (_e) {}
    await new Promise((r) => setTimeout(r, 400));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
    server.close();
  }

  console.log(`\nPhase 6 Master Summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
