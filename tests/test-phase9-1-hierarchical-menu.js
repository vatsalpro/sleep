/**
 * Sleepwalker 2.0 — Phase 9.1 Hierarchical Page Understanding and Menu Navigation Test Suite
 *
 * Verifies all 12 required scenarios end-to-end:
 *  1. Simple click-triggered dropdown
 *  2. CSS hover-triggered dropdown
 *  3. Nested hover submenu (Level 1 hover -> Level 2 hover -> Level 3 click)
 *  4. Click-triggered expandable submenu
 *  5. Split button (separate expansion arrow button + navigation link)
 *  6. Multiple menus with identical child labels ("Overview" under Products vs Company)
 *  7. Delayed submenu rendering (200ms delay/animation)
 *  8. SPA menu re-render (DOM nodes replaced on expansion)
 *  9. Disappearing menu (collapses if focus/hover leaves)
 * 10. Missing submenu item (honest failure reporting)
 * 11. Ambiguous parent menu (clarification reporting)
 * 12. Keyboard-accessible navigation menu (Enter/ArrowDown)
 */
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const chromiumExe = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');

async function runPhase91Tests() {
  console.log('=== Sleepwalker 2.0 — Phase 9.1 Hierarchical Menu Navigation Verification Suite ===\n');

  const portalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Phase 9.1 Hierarchical Menu Test Portal</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 20px; }
    .hidden { display: none !important; }
    .dropdown-menu, .dropdown-submenu {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      background: #fff;
      border: 1px solid #cbd5e1;
      padding: 8px;
      list-style: none;
      margin: 0;
      min-width: 170px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      z-index: 1000;
    }
    .open > .dropdown-menu, .open > .dropdown-submenu, .dropdown-menu.show { display: block !important; }

    /* CSS Hover rules for Scenarios 2 & 3 */
    .hover-menu { position: relative; display: inline-block; }
    .hover-menu:hover > .dropdown-menu,
    .hover-menu.is-hovered > .dropdown-menu,
    .hover-menu:hover > .dropdown-submenu,
    .hover-menu.is-hovered > .dropdown-submenu {
      display: block !important;
    }

    nav { display: flex; flex-wrap: wrap; gap: 20px; background: #f8fafc; padding: 12px; border-radius: 8px; }
    .nav-item { position: relative; list-style: none; }
    .btn-group { display: inline-flex; align-items: center; position: relative; }
    button, a { font-size: 14px; padding: 6px 10px; cursor: pointer; text-decoration: none; color: #0f172a; }
  </style>
</head>
<body>
  <h1>Phase 9.1 University Hierarchical Navigation</h1>

  <nav id="main-nav" aria-label="Main Navigation">
    <!-- 1. Simple Click Dropdown -->
    <div class="nav-item" id="item-simple">
      <button id="btn-simple" type="button" aria-expanded="false" onclick="
        const p = document.getElementById('item-simple');
        const isClosed = !p.classList.contains('open');
        p.classList.toggle('open');
        this.setAttribute('aria-expanded', isClosed ? 'true' : 'false');
      ">Academics</button>
      <ul id="sub-simple" class="dropdown-menu">
        <li><a id="link-courses" href="#academics/courses">Courses</a></li>
        <li><a id="link-faculty" href="#academics/faculty">Faculty Directory</a></li>
      </ul>
    </div>

    <!-- 2. CSS Hover Dropdown with Navigating Anchor -->
    <div class="nav-item hover-menu" id="item-hover">
      <a id="link-admissions-nav" href="#admissions-home" class="nav-link">Admissions</a>
      <ul id="sub-hover" class="dropdown-menu">
        <li><a id="link-undergrad" href="#admissions/undergrad">Undergraduate Programs</a></li>
        <li><a id="link-postgrad" href="#admissions/postgrad">Postgraduate Programs</a></li>
      </ul>
    </div>

    <!-- 3. Nested Hover Submenu (L1 -> L2 -> L3) -->
    <div class="nav-item hover-menu" id="item-departments">
      <button id="btn-dep">Departments</button>
      <ul id="sub-dep-l1" class="dropdown-menu">
        <li class="hover-menu" id="item-eng">
          <button id="btn-eng">Engineering</button>
          <ul id="sub-dep-l2" class="dropdown-submenu" style="left:100%; top:0;">
            <li><a id="link-cs" href="#departments/eng/cs">Computer Science</a></li>
            <li><a id="link-ee" href="#departments/eng/ee">Electrical Engineering</a></li>
          </ul>
        </li>
      </ul>
    </div>

    <!-- 4. Click-Triggered Expandable Submenu (L1 click -> L2 click -> L3 click) -->
    <div class="nav-item" id="item-research">
      <button id="btn-research" type="button" aria-expanded="false" onclick="
        const p = document.getElementById('item-research');
        const isClosed = !p.classList.contains('open');
        p.classList.toggle('open');
        this.setAttribute('aria-expanded', isClosed ? 'true' : 'false');
      ">Research</button>
      <ul id="sub-research" class="dropdown-menu">
        <li id="item-labs">
          <button id="btn-labs" type="button" aria-expanded="false" onclick="
            const p = document.getElementById('item-labs');
            const isClosed = !p.classList.contains('open');
            p.classList.toggle('open');
            this.setAttribute('aria-expanded', isClosed ? 'true' : 'false');
          ">Laboratories</button>
          <ul id="sub-labs" class="dropdown-submenu" style="left:100%; top:0;">
            <li><a id="link-ai-lab" href="#research/labs/ai">AI & Robotics Lab</a></li>
          </ul>
        </li>
      </ul>
    </div>

    <!-- 5. Split Button (Anchor + Separate Toggle Button) -->
    <div class="btn-group split-button" id="grp-products">
      <a id="link-prod-main" href="#products/main" class="main-link">Products</a>
      <button id="btn-prod-toggle" type="button" class="dropdown-toggle" aria-expanded="false" aria-haspopup="true" onclick="
        const p = document.getElementById('grp-products');
        const isClosed = !p.classList.contains('open');
        p.classList.toggle('open');
        this.setAttribute('aria-expanded', isClosed ? 'true' : 'false');
      ">▼</button>
      <ul id="sub-products" class="dropdown-menu">
        <li><a id="link-enterprise" href="#products/enterprise">Enterprise Suite</a></li>
        <li><a id="link-starter" href="#products/starter">Starter Pack</a></li>
      </ul>
    </div>

    <!-- 6. Multiple Menus with Identical Child Labels ("Overview") -->
    <div class="nav-item" id="grp-solutions">
      <button id="btn-solutions" type="button" onclick="document.getElementById('grp-solutions').classList.toggle('open');">Solutions</button>
      <ul id="sub-solutions" class="dropdown-menu">
        <li><a id="link-sol-overview" href="#solutions/overview">Overview</a></li>
      </ul>
    </div>
    <div class="nav-item" id="grp-company">
      <button id="btn-company" type="button" onclick="document.getElementById('grp-company').classList.toggle('open');">Company</button>
      <ul id="sub-company" class="dropdown-menu">
        <li><a id="link-comp-overview" href="#company/overview">Overview</a></li>
      </ul>
    </div>

    <!-- 7. Delayed Submenu Rendering (200ms animation / delay) -->
    <div class="nav-item" id="item-delayed">
      <button id="btn-delayed" type="button" onclick="
        clearTimeout(window.__delayedTimer);
        window.__delayedTimer = setTimeout(() => {
          document.getElementById('item-delayed').classList.add('open');
        }, 200);
      ">Library</button>
      <ul id="sub-delayed" class="dropdown-menu">
        <li><a id="link-catalog" href="#library/catalog">Digital Catalog</a></li>
      </ul>
    </div>

    <!-- 8. SPA Menu Re-render (DOM replaced on expansion) -->
    <div class="nav-item" id="item-spa">
      <button id="btn-spa" type="button" onclick="
        const mount = document.getElementById('spa-menu-mount');
        mount.innerHTML = '';
        const ul = document.createElement('ul');
        ul.className = 'dropdown-menu';
        ul.style.display = 'block';
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.id = 'link-housing';
        a.href = '#campus/housing';
        a.textContent = 'Housing';
        li.appendChild(a);
        ul.appendChild(li);
        mount.appendChild(ul);
      ">Campus Life</button>
      <div id="spa-menu-mount"></div>
    </div>

    <!-- 9. Disappearing Menu (Collapses if mouse leaves or focus lost) -->
    <div class="nav-item" id="item-transient" onmouseleave="document.getElementById('item-transient').classList.remove('open');">
      <button id="btn-transient" type="button" onmouseenter="document.getElementById('item-transient').classList.add('open');">Athletics</button>
      <ul id="sub-transient" class="dropdown-menu">
        <li><a id="link-gym" href="#athletics/gym">Fitness Center</a></li>
      </ul>
    </div>

    <!-- 11. Ambiguous Parent Menus (Two "Settings" menus in different toolbars) -->
    <div class="nav-item" id="tb-tools-1">
      <button id="btn-settings-1" class="menu-trigger" type="button" onclick="document.getElementById('tb-tools-1').classList.toggle('open');">Settings</button>
      <ul id="sub-set-1" class="dropdown-menu">
        <li><a id="link-account" href="#settings/account">Account Settings</a></li>
      </ul>
    </div>
    <div class="nav-item" id="tb-tools-2">
      <button id="btn-settings-2" class="menu-trigger" type="button" onclick="document.getElementById('tb-tools-2').classList.toggle('open');">Settings</button>
      <ul id="sub-set-2" class="dropdown-menu">
        <li><a id="link-privacy" href="#settings/privacy">Privacy Preferences</a></li>
      </ul>
    </div>

    <!-- 12. Keyboard-Accessible Navigation Menu (WAI-ARIA menubar) -->
    <div role="menubar" id="menubar-accessible" class="nav-item">
      <button role="menuitem" id="item-gov" aria-haspopup="menu" aria-expanded="false" tabindex="0" onkeydown="
        if (event.key === 'Enter' || event.key === 'ArrowDown') {
          event.preventDefault();
          const m = document.getElementById('menu-gov');
          m.classList.add('show');
          this.setAttribute('aria-expanded', 'true');
        }
      ">Governance</button>
      <div role="menu" id="menu-gov" class="dropdown-menu">
        <a role="menuitem" id="link-senate" href="#governance/senate">Academic Senate</a>
      </div>
    </div>
  </nav>

  <div id="view-result" style="margin-top: 40px; padding: 20px; background: #eee;">
    <p>Target view placeholder</p>
  </div>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(portalHtml);
  });

  await new Promise(r => server.listen(9102, r));
  const portalUrl = 'http://127.0.0.1:9102/';

  const cdpPort = 9251;
  const userDataDir = path.join(process.env.TEMP || '', `chrome-phase91-test-${Date.now()}`);

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

  await new Promise(r => setTimeout(r, 1200));

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
      expression: `(async () => {\n${expr}\n})()`,
      awaitPromise: true,
      returnByValue: true
    };
    if (executionContextId) params.contextId = executionContextId;
    const r = await callCdp('Runtime.evaluate', params);
    if (r && r.exceptionDetails) {
      throw new Error(JSON.stringify(r.exceptionDetails));
    }
    return r && r.result ? r.result.value : undefined;
  };

  try {
    let pageTarget = null;
    for (let i = 0; i < 40 && !pageTarget; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const targets = await fetchTargets();
        pageTarget = targets.find(t => t.type === 'page' && t.url.includes('9102'));
      } catch (_e) {}
    }
    assert(pageTarget, 'Test portal page target must be found');

    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

    const contexts = [];
    ws.addEventListener('message', (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString('utf-8');
        const msg = JSON.parse(raw);
        if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
      } catch (_e) {}
    });

    await callCdp('Runtime.enable');
    await callCdp('Page.enable');
    await new Promise(r => setTimeout(r, 800));

    const findExtCtx = async () => {
      for (let i = contexts.length - 1; i >= 0; i--) {
        const c = contexts[i];
        if (c && c.origin && c.origin.startsWith('chrome-extension://')) {
          const ok = await evalJs(`return Boolean(window.__SLEEPWALKER_INSTANCE__);`, c.id).catch(() => false);
          if (ok) return c.id;
        }
      }
      return null;
    };

    let extCtx = null;
    for (let i = 0; i < 25 && !extCtx; i++) {
      await new Promise(r => setTimeout(r, 200));
      extCtx = await findExtCtx();
    }
    assert(extCtx, 'Extension execution context must be discovered');

    // Enable Rebuilt BrowserEngine explicitly
    await evalJs(`window.__SLEEPWALKER_INSTANCE__.setRebuiltBrowserEngineEnabled(true);`, extCtx);

    const results = [];
    const runOp = async (scenarioId, label, fn) => {
      await evalJs(`
        clearTimeout(window.__delayedTimer);
        document.querySelectorAll('.open').forEach(el => el.classList.remove('open'));
        document.querySelectorAll('.show').forEach(el => el.classList.remove('show'));
        document.querySelectorAll('.is-hovered').forEach(el => el.classList.remove('is-hovered'));
      `);
      const t0 = performance.now();
      const info = await fn();
      const ms = Math.round(performance.now() - t0);
      results.push({ scenarioId, label, verified: info.verified, ms, detail: info.detail });
      console.log(`[PASS] ${scenarioId} (${label}): verified=${info.verified}, latency=${ms}ms — ${info.detail}`);
    };

    // =========================================================================
    // 1. Simple Click-Triggered Dropdown
    // =========================================================================
    await runOp('S1', 'Simple Click Dropdown', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuAndSelect('Academics', 'Courses');
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S1 must succeed');
      assert.strictEqual(hash, '#academics/courses', 'S1 must navigate to #academics/courses');
      return { verified: true, detail: `hash=${hash}` };
    });

    // =========================================================================
    // 2. CSS Hover-Triggered Dropdown
    // =========================================================================
    await runOp('S2', 'CSS Hover Dropdown (Navigation Protection)', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Admissions', 'Undergraduate Programs']);
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S2 must succeed');
      assert.notStrictEqual(hash, '#admissions-home', 'S2 must NOT navigate to admissions anchor href');
      assert.strictEqual(hash, '#admissions/undergrad', 'S2 must navigate to #admissions/undergrad');
      return { verified: true, detail: `hash=${hash} (parent href protected)` };
    });

    // =========================================================================
    // 3. Nested Hover Submenu (L1 Hover -> L2 Hover -> L3 Click)
    // =========================================================================
    await runOp('S3', 'Nested Hover Submenu (3-Depth)', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Departments', 'Engineering', 'Computer Science']);
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S3 must succeed');
      assert.strictEqual(hash, '#departments/eng/cs', 'S3 must navigate to #departments/eng/cs');
      return { verified: true, detail: `3-depth path verified: ${hash}` };
    });

    // =========================================================================
    // 4. Click-Triggered Expandable Submenu (L1 Click -> L2 Click -> L3 Click)
    // =========================================================================
    await runOp('S4', 'Click-Triggered Expandable Submenu', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Research', 'Laboratories', 'AI & Robotics Lab']);
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S4 must succeed');
      assert.strictEqual(hash, '#research/labs/ai', 'S4 must navigate to #research/labs/ai');
      return { verified: true, detail: `expandable path verified: ${hash}` };
    });

    // =========================================================================
    // 5. Split Button (Separate Expansion Arrow + Navigation Link)
    // =========================================================================
    await runOp('S5', 'Split Button Control', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Products', 'Enterprise Suite']);
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S5 must succeed');
      assert.notStrictEqual(hash, '#products/main', 'S5 must not click main anchor link');
      assert.strictEqual(hash, '#products/enterprise', 'S5 must select submenu item');
      return { verified: true, detail: `split toggle used; hash=${hash}` };
    });

    // =========================================================================
    // 6. Multiple Menus with Identical Child Labels ("Overview")
    // =========================================================================
    await runOp('S6', 'Scoped Child Search (Disambiguate Identical Labels)', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Company', 'Overview']);
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S6 must succeed');
      assert.notStrictEqual(hash, '#solutions/overview', 'S6 must NOT select Solutions overview');
      assert.strictEqual(hash, '#company/overview', 'S6 must strictly select Company overview');
      return { verified: true, detail: `scoped resolution verified: ${hash}` };
    });

    // =========================================================================
    // 7. Delayed Submenu Rendering (200ms Animation/Delay)
    // =========================================================================
    await runOp('S7', 'Delayed Submenu Rendering (Settlement Loop)', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Library', 'Digital Catalog'], { settleTimeoutMs: 700 });
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S7 must succeed');
      assert.strictEqual(hash, '#library/catalog', 'S7 must navigate to #library/catalog');
      return { verified: true, detail: `delayed element settled; hash=${hash}` };
    });

    // =========================================================================
    // 8. SPA Menu Re-render (DOM Replaced on Expansion)
    // =========================================================================
    await runOp('S8', 'SPA Menu Re-render (Dynamic Mount)', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Campus Life', 'Housing']);
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S8 must succeed');
      assert.strictEqual(hash, '#campus/housing', 'S8 must navigate to #campus/housing');
      return { verified: true, detail: `dynamically mounted node clicked; hash=${hash}` };
    });

    // =========================================================================
    // 9. Disappearing Menu (Collapses if Mouse Leaves)
    // =========================================================================
    await runOp('S9', 'Transient / Disappearing Menu Interaction', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Athletics', 'Fitness Center']);
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S9 must succeed');
      assert.strictEqual(hash, '#athletics/gym', 'S9 must navigate to #athletics/gym');
      return { verified: true, detail: `maintained active container; hash=${hash}` };
    });

    // =========================================================================
    // 10. Missing Submenu Item (Honest Failure Reporting)
    // =========================================================================
    await runOp('S10', 'Missing Submenu Item (Honest Failure)', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Academics', 'Nonexistent Major']);
      `, extCtx);
      assert.strictEqual(res.status, 'FAILED', 'S10 must fail');
      assert.strictEqual(res.verified, false, 'S10 verified must be false');
      assert.strictEqual(res.reason, 'child_not_found_under_parent', 'S10 reason must be honest');
      return { verified: true, detail: `reported honest failure: reason=${res.reason}` };
    });

    // =========================================================================
    // 11. Ambiguous Parent Menu (Clarification Reporting)
    // =========================================================================
    await runOp('S11', 'Ambiguous Parent Menu (Clarification)', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Settings', 'Account Settings']);
      `, extCtx);
      assert.strictEqual(res.status, 'AMBIGUOUS', 'S11 status must be AMBIGUOUS');
      assert.strictEqual(res.verified, false, 'S11 verified must be false');
      assert(res.candidates && res.candidates.length >= 2, 'S11 must report competing candidates');
      return { verified: true, detail: `ambiguity reported: ${res.candidates.length} candidates` };
    });

    // =========================================================================
    // 12. Keyboard-Accessible Navigation Menu (Enter/ArrowDown)
    // =========================================================================
    await runOp('S12', 'Keyboard-Accessible Navigation Menu', async () => {
      const res = await evalJs(`
        return await window.__SLEEPWALKER_INSTANCE__.browserEngine.openMenuPath(['Governance', 'Academic Senate']);
      `, extCtx);
      const hash = await evalJs(`return window.location.hash;`);
      assert.strictEqual(res.verified, true, 'S12 must succeed');
      assert.strictEqual(hash, '#governance/senate', 'S12 must navigate to #governance/senate');
      return { verified: true, detail: `keyboard activated; hash=${hash}` };
    });

    console.log('\n======================================================');
    console.log('PHASE 9.1 HIERARCHICAL MENU NAVIGATION SUMMARY');
    console.log('======================================================');
    console.log(`Scenarios Verified:     ${results.filter(r => r.verified).length}/${results.length} (All 12 Scenarios)`);
    console.log(`Average Latency:        ${Math.round(results.reduce((acc, r) => acc + r.ms, 0) / results.length)}ms`);
    console.log('======================================================\n');

  } finally {
    if (ws) try { ws.close(); } catch (_e) {}
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

runPhase91Tests().catch(err => {
  console.error('Phase 9.1 verification failed:', err);
  process.exit(1);
});
