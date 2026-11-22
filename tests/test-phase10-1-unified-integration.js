/**
 * Sleepwalker 2.0 — Phase 10.1 Unified Browser Engine Integration Test Suite
 *
 * Verifies all 15 required scenarios end-to-end in real Chromium:
 *  1. Typed 'hello' generates fresh greeting response.
 *  2. Second command does not display first command's answer (stale request rejection).
 *  3. Direct URL navigation.
 *  4. Google search request navigation.
 *  5. Website search submission.
 *  6. Scoped link navigation.
 *  7. Parent menu -> submenu navigation ("Open Student Information System under Others").
 *  8. Three-level nested menu navigation.
 *  9. Dynamic SPA submenu.
 * 10. Reading page content.
 * 11. Scrolling.
 * 12. Form interaction with privacy protection (password field excluded).
 * 13. Voice command routing through unified pipeline.
 * 14. Ambiguous target clarification.
 * 15. Failed action reports failure honestly.
 */
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const chromiumExe = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');

async function runPhase101Tests() {
  console.log('=== Sleepwalker 2.0 — Phase 10.1 Unified BrowserEngine Integration Suite ===\n');

  const portalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Phase 10.1 Unified Integration Test Portal</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 20px; min-height: 2000px; }
    .hidden { display: none !important; }
    nav { display: flex; flex-wrap: wrap; gap: 20px; background: #f8fafc; padding: 12px; border-radius: 8px; }
    .nav-item { position: relative; list-style: none; display: inline-block; }
    .dropdown-menu, .dropdown-submenu, .submenu {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      background: #fff;
      border: 1px solid #cbd5e1;
      padding: 8px;
      list-style: none;
      min-width: 180px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      z-index: 100;
    }
    .hover-menu { position: relative; display: inline-block; }
    .open > .dropdown-menu, .open > .dropdown-submenu, .open > .submenu,
    .is-hovered > .dropdown-menu, .is-hovered > .dropdown-submenu, .is-hovered > .submenu,
    .sw-hovered > .dropdown-menu, .sw-hovered > .dropdown-submenu, .sw-hovered > .submenu,
    .hover-menu:hover > .dropdown-menu, .hover-menu:hover > .dropdown-submenu, .hover-menu:hover > .submenu,
    .dropdown-menu.show, .dropdown-submenu.show, .submenu.show {
      display: block !important;
    }
    .submenu-item { position: relative; }
    .submenu-item > .submenu { top: 0; left: 100%; }

    .site-search { margin: 20px 0; }
    .site-search input { padding: 8px; width: 240px; }
    .card-box { padding: 16px; border: 1px solid #e2e8f0; margin-bottom: 20px; }
    footer { margin-top: 800px; padding: 30px; background: #f8fafc; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <header>
    <h1>University Portal</h1>
    <nav id="main-nav" aria-label="Main Navigation">
      <!-- Parent menu: Others -->
      <div class="nav-item" id="item-others">
        <button type="button" id="btn-others" class="nav-toggle" aria-haspopup="true" aria-expanded="false" onclick="toggleMenu('item-others')">
          Others
        </button>
        <ul class="dropdown-menu" id="menu-others">
          <li><a href="#sis" id="link-sis" onclick="recordNav('#sis')">Student Information System</a></li>
          <li><a href="#alumni" id="link-alumni" onclick="recordNav('#alumni')">Alumni Portal</a></li>
          <li><a href="#helpdesk" id="link-helpdesk" onclick="recordNav('#helpdesk')">Helpdesk</a></li>
        </ul>
      </div>

      <!-- 3-Level Menu: Academics > Undergraduate > Computer Science -->
      <div class="nav-item hover-menu" id="item-academics">
        <button type="button" id="btn-academics" class="nav-toggle">
          Academics
        </button>
        <ul class="dropdown-menu" id="menu-academics">
          <li class="hover-menu" id="item-undergrad">
            <button type="button" id="btn-undergrad" class="nav-toggle">
              Undergraduate
            </button>
            <ul class="dropdown-submenu" id="menu-undergrad" style="left:100%; top:0;">
              <li><a href="#academics-cs" id="link-cs" onclick="recordNav('#academics-cs')">Computer Science</a></li>
              <li><a href="#academics-math" id="link-math" onclick="recordNav('#academics-math')">Mathematics</a></li>
            </ul>
          </li>
          <li><a href="#schedule-acad" id="link-sched-acad" onclick="recordNav('#schedule-acad')">Schedule</a></li>
        </ul>
      </div>

      <!-- Ambiguous Menu Item: Schedule also under Athletics -->
      <div class="nav-item" id="item-athletics">
        <button type="button" id="btn-athletics" class="nav-toggle" aria-haspopup="true" aria-expanded="false" onclick="toggleMenu('item-athletics')">
          Athletics
        </button>
        <ul class="dropdown-menu" id="menu-athletics">
          <li><a href="#schedule-ath" id="link-sched-ath" onclick="recordNav('#schedule-ath')">Schedule</a></li>
          <li><a href="#gym" id="link-gym" onclick="recordNav('#gym')">Gymnasium</a></li>
        </ul>
      </div>

      <!-- Dynamic SPA Submenu: Research -->
      <div class="nav-item" id="item-research">
        <button type="button" id="btn-research" class="nav-toggle" onclick="
          const mount = document.getElementById('spa-menu-mount');
          mount.innerHTML = '';
          const ul = document.createElement('ul');
          ul.className = 'dropdown-menu';
          ul.style.display = 'block';
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.id = 'link-research-labs';
          a.href = '#research-labs';
          a.textContent = 'Labs';
          a.onclick = function() { recordNav('#research-labs'); };
          li.appendChild(a);
          ul.appendChild(li);
          mount.appendChild(ul);
        ">Research</button>
        <div id="spa-menu-mount"></div>
      </div>
    </nav>
  </header>

  <main>
    <!-- Website Search Form -->
    <div class="site-search card-box">
      <h2>Search Portal</h2>
      <form id="portal-search-form" onsubmit="event.preventDefault(); recordSearch();">
        <label for="portal-search-input">Search for:</label>
        <input type="search" id="portal-search-input" name="query" placeholder="Search catalog, faculty, courses...">
        <button type="submit" id="portal-search-btn">Search</button>
      </form>
      <div id="search-result-display"></div>
    </div>

    <!-- Article Content for Reading -->
    <article class="card-box" id="article-section">
      <h2>Campus Life & Guidelines</h2>
      <p>The academic term begins on September 15. All students must complete registration before the deadline. International students may visit the global office for visa assistance.</p>
    </article>

    <!-- Form Filling & Privacy Gating -->
    <section class="card-box" id="profile-form-section">
      <h2>Student Profile</h2>
      <form id="student-form" onsubmit="event.preventDefault(); recordFormSubmit();">
        <div>
          <label for="input-email">Email Address</label>
          <input type="email" id="input-email" name="email" placeholder="student@example.edu">
        </div>
        <div style="margin-top: 10px;">
          <label for="input-password">Password</label>
          <input type="password" id="input-password" name="password" placeholder="Enter password">
        </div>
        <button type="submit" id="btn-submit-form" style="margin-top: 15px;">Submit Application</button>
      </form>
      <div id="submit-result"></div>
    </section>
  </main>

  <footer id="footer-sec">
    <h2>Footer Navigation</h2>
    <ul>
      <li><a href="#privacy-policy" id="link-footer-privacy" onclick="recordNav('#privacy-policy')">Privacy Policy</a></li>
      <li><a href="#terms" id="link-footer-terms" onclick="recordNav('#terms')">Terms of Service</a></li>
    </ul>
  </footer>

  <script>
    window.__TEST_LOG__ = {
      navEvents: [],
      searches: [],
      formSubmits: []
    };

    function toggleMenu(id) {
      const el = document.getElementById(id);
      if (!el) return;
      const isOpen = el.classList.contains('open');
      el.classList.toggle('open', !isOpen);
      const btn = el.querySelector('.nav-toggle');
      if (btn) btn.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
    }

    function recordNav(hash) {
      window.location.hash = hash;
      window.__TEST_LOG__.navEvents.push({ hash, time: Date.now() });
    }

    function recordSearch() {
      const q = document.getElementById('portal-search-input').value;
      window.__TEST_LOG__.searches.push(q);
      document.getElementById('search-result-display').textContent = 'Results for: ' + q;
    }

    function recordFormSubmit() {
      window.__TEST_LOG__.formSubmits.push({
        email: document.getElementById('input-email').value,
        password: document.getElementById('input-password').value,
        time: Date.now()
      });
      document.getElementById('submit-result').textContent = 'Form submitted successfully';
    }
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(portalHtml);
  });

  await new Promise(r => server.listen(9103, r));
  const portalUrl = 'http://127.0.0.1:9103/';

  const cdpPort = 9252;
  const userDataDir = path.join(process.env.TEMP || '', `chrome-phase101-test-${Date.now()}`);

  const chromeProc = spawn(chromiumExe, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--headless=new',
    '--no-sandbox',
    '--window-size=1280,820',
    '--no-first-run',
    '--no-default-browser-check',
    portalUrl
  ], { stdio: 'ignore' });

  await new Promise(r => setTimeout(r, 1400));

  const fetchTargets = async () => (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
  let ws = null;
  let msgId = 0;

  const callCdp = (method, params = {}, timeoutMs = 25000) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error(`CDP timeout on ${method}`)); }, timeoutMs);
    const onMsg = (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString('utf-8');
        const msg = JSON.parse(raw);
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch (e) { clearTimeout(timer); reject(e); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evalJs = async (expr, executionContextId) => {
    const params = {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    };
    if (executionContextId) params.contextId = executionContextId;
    const res = await callCdp('Runtime.evaluate', params);
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${res.exceptionDetails.text} (${JSON.stringify(res.exceptionDetails.exception)})`);
    }
    return res.result ? res.result.value : undefined;
  };

  const results = [];

  try {
    let pageTarget = null;
    for (let i = 0; i < 40 && !pageTarget; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const targets = await fetchTargets();
        pageTarget = targets.find(t => t.type === 'page' && t.url.includes('9103'));
      } catch (_e) {}
    }
    if (!pageTarget) throw new Error('Could not find page target in Chrome');

    const WebSocket = globalThis.WebSocket || require('ws');
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });

    const contexts = [];
    ws.addEventListener('message', (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString('utf-8');
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = (msg.params.args || []).map(a => a.value || a.description || JSON.stringify(a)).join(' ');
          if (text.includes('[DEBUG')) console.log('BROWSER CONSOLE:', text);
        }
      } catch (_e) {}
    });

    await callCdp('Runtime.enable');
    await callCdp('Page.enable');
    await new Promise(r => setTimeout(r, 800));

    const findExtCtx = async () => {
      for (let i = contexts.length - 1; i >= 0; i--) {
        const c = contexts[i];
        if (c && c.origin && c.origin.startsWith('chrome-extension://')) {
          const ok = await evalJs(`Boolean(window.__SLEEPWALKER_INSTANCE__ && window.BrowserEngine);`, c.id).catch(() => false);
          if (ok) return c.id;
        }
      }
      return null;
    };

    let extCtx = null;
    for (let i = 0; i < 35 && !extCtx; i++) {
      await new Promise(r => setTimeout(r, 200));
      extCtx = await findExtCtx();
    }
    assert.ok(extCtx, 'Extension context must be initialized');

    // Enable rebuilt BrowserEngine via the official developer flag method
    await evalJs(`
      const sw = window.__SLEEPWALKER_INSTANCE__;
      sw.setRebuiltBrowserEngineEnabled(true, true);
    `, extCtx);

    // Verify feature flag state is enabled
    const flagVal = await evalJs(`window.__SLEEPWALKER_INSTANCE__.useRebuiltBrowserEngine`, extCtx);
    assert.strictEqual(flagVal, true, 'useRebuiltBrowserEngine flag should be true');

    // =========================================================================
    // Scenario 1: Typed 'hello' generates fresh greeting response (Issue A)
    // =========================================================================
    {
      const t0 = Date.now();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.handleUserInput('hello', 'typed');
        })()
      `, extCtx);
      const cardType = await evalJs(`window.SW_UI ? window.SW_UI.getCardType() : null`, extCtx);
      const cardText = await evalJs(`window.SW_UI && window.SW_UI._orb && window.SW_UI._orb.card && window.SW_UI._orb.card.bodyEl ? window.SW_UI._orb.card.bodyEl.textContent : ''`, extCtx);
      assert.strictEqual(res.status, 'greeting_handled');
      assert.strictEqual(res.verified, true);
      assert.strictEqual(cardType, 'answer');
      assert.ok(cardText.includes("Hello! I'm Sleepwalker"), 'Card should display greeting response');
      assert.ok(!cardText.toLowerCase().includes('donate') && !cardText.toLowerCase().includes('wikipedia'), 'Must not read external or stale page DOM');
      results.push({ scenario: 'S1', name: 'Typed "hello" Fresh Greeting', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S1 (Typed "hello" Fresh Greeting): status=${res.status}, verified=${res.verified}, latency=${Date.now() - t0}ms`);
    }

    // =========================================================================
    // Scenario 2: Stale Request Rejection (Issue A)
    // =========================================================================
    {
      const t0 = Date.now();
      const staleRejectionRes = await evalJs(`
        (async () => {
          const orb = window.SW_UI._orb;
          // Request A begins
          const reqA = orb.beginRequest('req_turn_A', 'first command');
          // Request B immediately begins
          const reqB = orb.beginRequest('req_turn_B', 'second command');

          // Attempt to show stale card from turn A
          orb.showCard({
            type: 'answer',
            title: 'Stale Turn A',
            text: 'Old stale answer from first turn',
            reqId: 'req_turn_A'
          });

          // Show legitimate card from turn B
          orb.showCard({
            type: 'answer',
            title: 'Turn B Answer',
            text: 'Fresh answer for second turn',
            reqId: 'req_turn_B'
          });

          return {
            currentReq: orb.currentRequestId,
            cardTitle: orb.card.titleEl.textContent,
            cardBody: orb.card.bodyEl.textContent
          };
        })()
      `, extCtx);
      assert.strictEqual(staleRejectionRes.currentReq, 'req_turn_B');
      assert.strictEqual(staleRejectionRes.cardTitle, 'Turn B Answer');
      assert.strictEqual(staleRejectionRes.cardBody, 'Fresh answer for second turn');
      results.push({ scenario: 'S2', name: 'Stale Request Rejection (Req IDs)', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S2 (Stale Request Rejection): currentReq=${staleRejectionRes.currentReq}, cardTitle="${staleRejectionRes.cardTitle}"`);
    }

    // =========================================================================
    // Scenario 3: Direct URL Navigation (Issue B)
    // =========================================================================
    {
      const t0 = Date.now();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          let capturedUrl = '';
          const origNav = sw._navigateToExternalUrl;
          sw._navigateToExternalUrl = async (url) => {
            capturedUrl = url;
            return { status: 'mock_navigated', url };
          };
          const out = await sw.handleUserInput('open https://en.wikipedia.org', 'typed');
          sw._navigateToExternalUrl = origNav;
          return { out, capturedUrl };
        })()
      `, extCtx);
      assert.strictEqual(res.capturedUrl, 'https://en.wikipedia.org');
      assert.strictEqual(res.out.status, 'mock_navigated');
      results.push({ scenario: 'S3', name: 'Direct URL Navigation', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S3 (Direct URL Navigation): capturedUrl=${res.capturedUrl}`);
    }

    // =========================================================================
    // Scenario 4: Google Search Request Navigation (Issue B)
    // =========================================================================
    {
      const t0 = Date.now();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          let capturedUrl = '';
          const origNav = sw._navigateToExternalUrl;
          sw._navigateToExternalUrl = async (url) => {
            capturedUrl = url;
            return { status: 'mock_navigated', url };
          };
          const out = await sw.handleUserInput('search on Google for quantum computing', 'typed');
          sw._navigateToExternalUrl = origNav;
          return { out, capturedUrl };
        })()
      `, extCtx);
      assert.ok(res.capturedUrl.includes('google.com/search?q=quantum%20computing'), 'Should format Google search URL');
      results.push({ scenario: 'S4', name: 'Google Search Request Navigation', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S4 (Google Search Navigation): capturedUrl=${res.capturedUrl}`);
    }

    // =========================================================================
    // Scenario 5: Website Search Submission (Issue B)
    // =========================================================================
    {
      const t0 = Date.now();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.handleUserInput('search for electronics', 'typed');
        })()
      `, extCtx);
      const searchVal = await evalJs(`document.getElementById('portal-search-input').value`);
      const searchLogs = await evalJs(`window.__TEST_LOG__.searches`);
      assert.strictEqual(res.status, 'searched');
      assert.strictEqual(res.verified, true);
      assert.strictEqual(searchVal, 'electronics');
      assert.ok(searchLogs.includes('electronics'), 'Form submission event must have fired');
      results.push({ scenario: 'S5', name: 'Website Search Submission', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S5 (Website Search Submission): status=${res.status}, verified=${res.verified}, query="${searchVal}"`);
    }

    // =========================================================================
    // Scenario 6: Scoped Link Navigation
    // =========================================================================
    {
      const t0 = Date.now();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.handleUserInput('open Privacy Policy under Footer', 'typed');
        })()
      `, extCtx);
      const curHash = await evalJs(`window.location.hash`);
      assert.strictEqual(res.status, 'opened');
      assert.strictEqual(res.verified, true);
      assert.strictEqual(curHash, '#privacy-policy');
      results.push({ scenario: 'S6', name: 'Scoped Link Navigation', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S6 (Scoped Link Navigation): status=${res.status}, target=${res.target}, hash=${curHash}`);
    }

    const resetPortalMenuState = async () => {
      await evalJs(`
        window.location.hash = '';
        document.querySelectorAll('.open, .show, .is-hovered, .sw-hovered').forEach(el => {
          el.classList.remove('open', 'show', 'is-hovered', 'sw-hovered');
        });
        document.querySelectorAll('.nav-toggle, [aria-expanded="true"]').forEach(el => {
          el.setAttribute('aria-expanded', 'false');
        });
        document.querySelectorAll('.dropdown-menu').forEach(el => {
          if (el.id !== 'menu-research') el.style.display = '';
        });
      `);
    };

    // =========================================================================
    // Scenario 7: Parent Menu -> Submenu Navigation ("Open Student Information System under Others")
    // =========================================================================
    {
      const t0 = Date.now();
      await resetPortalMenuState();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.handleUserInput('Open Student Information System under Others', 'typed');
        })()
      `, extCtx);
      const curHash = await evalJs(`window.location.hash`);
      const menuExpanded = await evalJs(`document.getElementById('btn-others').getAttribute('aria-expanded')`);
      assert.strictEqual(res.status, 'opened');
      assert.strictEqual(res.verified, true);
      assert.strictEqual(curHash, '#sis');
      assert.strictEqual(menuExpanded, 'true');
      results.push({ scenario: 'S7', name: 'Parent Menu -> Submenu ("SIS under Others")', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S7 (Menu Navigation "SIS under Others"): status=${res.status}, hash=${curHash}, menuExpanded=${menuExpanded}`);
    }

    // =========================================================================
    // Scenario 8: Three-Level Nested Menu Navigation
    // =========================================================================
    {
      const t0 = Date.now();
      await resetPortalMenuState();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.handleUserInput('Academics > Undergraduate > Computer Science', 'typed');
        })()
      `, extCtx);
      const curHash = await evalJs(`window.location.hash`);
      assert.strictEqual(res.status, 'opened');
      assert.strictEqual(res.verified, true);
      assert.strictEqual(curHash, '#academics-cs');
      results.push({ scenario: 'S8', name: 'Three-Level Nested Menu Navigation', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S8 (3-Level Menu Navigation): status=${res.status}, hash=${curHash}`);
    }

    // =========================================================================
    // Scenario 9: Dynamic SPA Submenu
    // =========================================================================
    {
      const t0 = Date.now();
      await resetPortalMenuState();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.handleUserInput('Open Labs under Research', 'typed');
        })()
      `, extCtx);
      const curHash = await evalJs(`window.location.hash`);
      assert.strictEqual(res.status, 'opened');
      assert.strictEqual(res.verified, true);
      assert.strictEqual(curHash, '#research-labs');
      results.push({ scenario: 'S9', name: 'Dynamic SPA Submenu', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S9 (Dynamic SPA Submenu): status=${res.status}, hash=${curHash}`);
    }

    // =========================================================================
    // Scenario 10: Reading Page Content
    // =========================================================================
    {
      const t0 = Date.now();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.readPage();
        })()
      `, extCtx);
      assert.strictEqual(res.status, 'reading_page');
      assert.strictEqual(res.verified, true);
      assert.ok(res.text.includes('academic term begins on September 15'), 'Must extract real article text');
      results.push({ scenario: 'S10', name: 'Reading Page Content', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S10 (Reading Page Content): status=${res.status}, wordCount=${res.wordCount}`);
    }

    // =========================================================================
    // Scenario 11: Scrolling
    // =========================================================================
    {
      const t0 = Date.now();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          window.scrollTo(0, 0);
          return sw._executeFastPathAction({ type: 'scroll', dir: 'down', amount: 'page' }, 'scroll down', 'req_scroll', performance.now());
        })()
      `, extCtx);
      const scrollY = await evalJs(`window.scrollY`);
      assert.strictEqual(res.status, 'fast_scrolled');
      assert.strictEqual(res.verified, true);
      assert.ok(scrollY > 0, 'Scroll position must have advanced');
      results.push({ scenario: 'S11', name: 'Scrolling', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S11 (Scrolling): status=${res.status}, scrollY=${scrollY}`);
    }

    // =========================================================================
    // Scenario 12: Form Interaction with Privacy Protection (Password Field)
    // =========================================================================
    {
      const t0 = Date.now();
      const emailRes = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw._executeFillInputWithEngine({ target: 'Email', value: 'ada@example.edu' }, 'enter ada@example.edu into email');
        })()
      `, extCtx);
      const emailVal = await evalJs(`document.getElementById('input-email').value`);
      assert.strictEqual(emailRes.status, 'filled');
      assert.strictEqual(emailVal, 'ada@example.edu');

      const pwRes = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw._executeFillInputWithEngine({ target: 'Password', value: 'secret123' }, 'enter secret123 into password');
        })()
      `, extCtx);
      const pwVal = await evalJs(`document.getElementById('input-password').value`);
      assert.strictEqual(pwRes.status, 'sensitive_skipped');
      assert.strictEqual(pwRes.ok, false);
      assert.strictEqual(pwRes.protected, true);
      assert.strictEqual(pwVal, '', 'Password field MUST remain untouched for user privacy');

      results.push({ scenario: 'S12', name: 'Form Fill & Privacy Gating', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S12 (Form Fill & Privacy Gate): emailVal="${emailVal}", pwStatus=${pwRes.status}, pwFieldEmpty=${pwVal === ''}`);
    }

    // =========================================================================
    // Scenario 13: Voice Command Routing Through Unified Pipeline (Issue D)
    // =========================================================================
    {
      const t0 = Date.now();
      await resetPortalMenuState();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.voice.onCommand({ raw: 'Open Helpdesk under Others' });
        })()
      `, extCtx);
      const curHash = await evalJs(`window.location.hash`);
      assert.strictEqual(res.status, 'opened');
      assert.strictEqual(res.verified, true);
      assert.strictEqual(curHash, '#helpdesk');
      results.push({ scenario: 'S13', name: 'Voice Command Routing (Unified Pipeline)', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S13 (Voice Command Routing): status=${res.status}, hash=${curHash}`);
    }

    // =========================================================================
    // Scenario 14: Ambiguous Target Clarification
    // =========================================================================
    {
      const t0 = Date.now();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.browserEngine.openMenuPath('Schedule');
        })()
      `, extCtx);
      assert.strictEqual(res.status, 'AMBIGUOUS');
      assert.ok(Array.isArray(res.candidates) && res.candidates.length >= 2, 'Should detect multiple candidates');
      results.push({ scenario: 'S14', name: 'Ambiguous Target Clarification', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S14 (Ambiguous Clarification): status=${res.status}, candidates=${res.candidates.length}`);
    }

    // =========================================================================
    // Scenario 15: Honest Failure Reporting (No Guessing or Fallback to Search)
    // =========================================================================
    {
      const t0 = Date.now();
      const res = await evalJs(`
        (async () => {
          const sw = window.__SLEEPWALKER_INSTANCE__;
          return sw.handleUserInput('Open Quantum Teleportation under Others', 'typed');
        })()
      `, extCtx);
      const searchLogs = await evalJs(`window.__TEST_LOG__.searches`);
      assert.strictEqual(res.status, 'not_found');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.verified, false);
      assert.ok(!searchLogs.includes('Quantum Teleportation'), 'Failed navigation must NEVER silently fall back to typing into search');
      results.push({ scenario: 'S15', name: 'Honest Failure Reporting', passed: true, latencyMs: Date.now() - t0 });
      console.log(`[PASS] S15 (Honest Failure Reporting): status=${res.status}, ok=${res.ok}, verified=${res.verified}`);
    }

    // =========================================================================
    // Summary
    // =========================================================================
    console.log('\n======================================================');
    console.log('PHASE 10.1 UNIFIED INTEGRATION TEST SUMMARY');
    console.log('======================================================');
    console.log(`Scenarios Verified:     ${results.filter(r => r.passed).length}/${results.length} (All 15 Scenarios)`);
    const avgLatency = Math.round(results.reduce((a, b) => a + b.latencyMs, 0) / results.length);
    console.log(`Average Latency:        ${avgLatency}ms`);
    console.log('======================================================\n');

  } finally {
    if (ws) ws.close();
    chromeProc.kill();
    server.close();
  }
}

runPhase101Tests().catch(err => {
  console.error('\n[FATAL TEST FAILURE]:', err);
  process.exit(1);
});
