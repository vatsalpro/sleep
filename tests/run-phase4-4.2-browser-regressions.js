'use strict';

// Native browser regressions for Phase 4.4.2. Uses the locally installed
// Playwright Chromium executable, but drives it directly through Chrome DevTools.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) return null;
  for (const version of fs.readdirSync(base).filter((name) => name.startsWith('chromium-')).reverse()) {
    for (const candidate of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const full = path.join(base, version, candidate);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function fixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/main' });
      res.end();
      return;
    }
    if (url.pathname === '/frame') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><button id="frame-target">Frame policy link</button><script>document.getElementById("frame-target").addEventListener("click",e=>e.currentTarget.dataset.selected="true")</script></body></html>');
      return;
    }
    if (url.pathname === '/main' || url.pathname.startsWith('/spa/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Sleepwalker Phase 4.4.2 Browser Regression</title>
        <style>
          body { margin: 24px; font: 16px Arial; }
          #cover-wrap { position: relative; width: 220px; height: 48px; margin-top: 20px; }
          #covered-target, #cover-blocker { position:absolute; inset:0; }
          #cover-blocker { z-index: 5; background:rgba(0,0,0,.25); }
          iframe { width: 480px; height: 100px; margin-top: 16px; }
        </style></head><body>
        <main id="app">
          <button id="route-target">Route One Target</button>
          <div id="shadow-host"></div>
          <div id="cover-wrap"><button id="covered-target">Genuinely Covered Target</button><div id="cover-blocker"></div></div>
          <iframe title="Same origin policy frame" src="/frame"></iframe>
          <button id="go-route-two">Go to route two</button>
        </main>
        <script>
          const root = document.getElementById('shadow-host').attachShadow({mode:'open'});
          root.innerHTML = '<button id="shadow-target">Shadow visible target</button>';
          root.getElementById('shadow-target').addEventListener('click', e => e.currentTarget.dataset.selected = 'true');
          document.getElementById('go-route-two').addEventListener('click', () => {
            history.pushState({view:2}, '', '/spa/two');
            document.getElementById('app').innerHTML = '<button id="route-target">Route Two Target</button><div id="shadow-host"></div><iframe title="Same origin policy frame" src="/frame"></iframe>';
            document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML = '<button>New route shadow target</button>';
          });
        </script></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const contexts = new Map();
    const pending = new Map();
    let nextId = 0;
    ws.addEventListener('open', () => resolve({
      ws,
      contexts,
      send(method, params = {}) {
        const id = ++nextId;
        return new Promise((done, fail) => {
          pending.set(id, { done, fail });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      eval(expression, contextId) {
        return this.send('Runtime.evaluate', {
          expression: `(async () => (${expression}))()`,
          awaitPromise: true,
          returnByValue: true,
          contextId
        }).then((result) => {
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
          return result.result && result.result.value;
        });
      }
    }), { once: true });
    ws.addEventListener('error', reject, { once: true });
    ws.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
        if (message.method === 'Runtime.executionContextCreated') {
          const ctx = message.params.context;
          contexts.set(ctx.id, { name: ctx.name || '', auxData: ctx.auxData || {} });
        } else if (message.method === 'Runtime.executionContextDestroyed') {
          contexts.delete(message.params.executionContextId);
        } else if (message.method === 'Runtime.executionContextsCleared') {
          contexts.clear();
        } else if (message.id && pending.has(message.id)) {
          const req = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) req.fail(new Error(message.error.message));
          else req.done(message.result || {});
        }
      } catch (_error) {}
    });
  });
}

async function waitForExtensionContext(cdp, timeoutMs = 15000) {
  await cdp.send('Runtime.enable');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const [id, context] of cdp.contexts) {
      if (context.auxData.type !== 'isolated') continue;
      try {
        const ready = await cdp.eval('Boolean(window.__SLEEPWALKER_INSTANCE__?.worldModel)', id);
        if (ready) return id;
      } catch (_error) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Sleepwalker isolated content-script context not found. Contexts: ${JSON.stringify(Array.from(cdp.contexts.values()))}`);
}

async function pageTarget(port, match) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const found = targets.find((target) => target.type === 'page' && match(target));
      if (found) return found;
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Chromium page target.');
}

async function main() {
  const executable = findChromium();
  if (!executable) throw new Error('Playwright Chromium executable is unavailable.');
  const { server, port } = await fixtureServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sleepwalker-p442-chromium-'));
  const debugPort = 10100 + Math.floor(Math.random() * 500);
  const browser = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `http://127.0.0.1:${port}/main`
  ], { stdio: 'ignore' });
  const sockets = [];
  try {
    const firstTarget = await pageTarget(debugPort, (target) => target.url.includes('/main'));
    const first = await connect(firstTarget.webSocketDebuggerUrl);
    sockets.push(first.ws);
    await first.send('Page.enable');
    const firstContext = await waitForExtensionContext(first);
    const initial = await first.eval(`(async () => {
      const c = window.__SLEEPWALKER_INSTANCE__;
      const inv = await c.worldModel.buildPageWorldModel(document, {tabId:'browser-tab-a', force:true});
      const shadow = [...inv.buttons, ...inv.links, ...inv.controls].find((e) => /Shadow visible target/.test(e.label || e.accessibleName || ''));
      const frame = [...inv.buttons, ...inv.links, ...inv.controls].find((e) => /Frame policy link/.test(e.label || e.accessibleName || ''));
      const covered = [...inv.buttons, ...inv.links, ...inv.controls].find((e) => /Genuinely Covered Target/.test(e.label || e.accessibleName || ''));
      const route = [...inv.buttons, ...inv.links, ...inv.controls].find((e) => /Route One Target/.test(e.label || e.accessibleName || ''));
      return { identity: inv.navigationIdentity, generation: inv.navigationGeneration,
        shadow: shadow && {id:shadow.id, inShadowRoot:shadow.inShadowRoot, covered:shadow.covered},
        frame: frame && {id:frame.id, inIframe:frame.inIframe, covered:frame.covered},
        coveredTarget: covered && {id:covered.id, covered:covered.covered},
        route: route && {id:route.id}, inventoryVersion:inv.inventoryVersion,
        tabId: inv.tabId };
    })()`, firstContext);
    assert.ok(initial.shadow && initial.shadow.inShadowRoot, `Open shadow target not indexed: ${JSON.stringify(initial)}`);
    assert.strictEqual(initial.shadow.covered, false, 'Visible open-shadow target must not be covered');
    assert.ok(initial.frame && initial.frame.inIframe, `Same-origin iframe target not indexed: ${JSON.stringify(initial)}`);
    assert.strictEqual(initial.frame.covered, false, 'Visible same-origin iframe target must not be covered');
    assert.ok(initial.coveredTarget && initial.coveredTarget.covered, `Genuinely obscured target must remain covered: ${JSON.stringify(initial)}`);
    assert.ok(initial.route && initial.identity, 'Initial route candidate and navigation identity must exist');
    assert.strictEqual(initial.inventoryVersion, 1, 'The first observed route must begin at inventory version 1');
    const nestedSelection = await first.eval(`(async () => {
      const c = window.__SLEEPWALKER_INSTANCE__;
      const shadowResult = await c.elementSelector.handleCommand('Click Shadow visible target', {doc:document});
      const frameResult = await c.elementSelector.handleCommand('Click Frame policy link', {doc:document});
      return {shadow:{result:shadowResult, selected:document.querySelector('#shadow-host').shadowRoot.getElementById('shadow-target').dataset.selected},
        frame:{result:frameResult, selected:document.querySelector('iframe').contentDocument.getElementById('frame-target').dataset.selected}};
    })()`, firstContext);
    assert.strictEqual(nestedSelection.shadow.result.verified, true, `Shadow DOM selection must verify: ${JSON.stringify(nestedSelection.shadow.result)}`);
    assert.strictEqual(nestedSelection.shadow.selected, 'true', 'Shadow DOM button handler must run');
    assert.strictEqual(nestedSelection.frame.result.verified, true, `Same-origin iframe selection must verify: ${JSON.stringify(nestedSelection.frame.result)}`);
    assert.strictEqual(nestedSelection.frame.selected, 'true', 'Same-origin iframe button handler must run');
    console.log('PASS Browser nested-root selection and verification (Playwright Chromium)');
    const routineRefresh = await first.eval(`(async () => {
      const c = window.__SLEEPWALKER_INSTANCE__;
      const inv = await c.worldModel.buildPageWorldModel(document, {tabId:'browser-tab-a', force:true});
      const valid = c.worldModel.resolveAndValidateCandidate(${JSON.stringify(initial.route.id)}, 'browser-tab-a', {expectedNavigationIdentity:${JSON.stringify(initial.identity)}});
      return {identity:inv.navigationIdentity, valid};
    })()`, firstContext);
    assert.strictEqual(routineRefresh.identity, initial.identity, 'Re-observing the same live page must preserve its navigation identity');
    assert.strictEqual(routineRefresh.valid.ok, true, 'A live candidate from the current page must remain valid across routine observation');
    console.log('PASS Browser shadow/iframe/covered-target checks (Playwright Chromium)');

    const browserRepairs = await first.eval(`(async () => {
      const c = window.__SLEEPWALKER_INSTANCE__;
      document.body.style.minHeight = '2400px';
      window.scrollTo(0, 0);
      const scrollBefore = window.scrollY;
      const scrollResult = await c._executeFastPathAction({type:'scroll', dir:'down', amount:'page'}, 'Scroll down', null, performance.now());
      const scrollAfter = window.scrollY;

      document.body.innerHTML = '<main><h1>Navigation repair fixture</h1><div style="height:1200px"></div><section><h2 id="repair-heading">Banking Regulations</h2><p>Section destination.</p></section></main>';
      c.outline.items = [];
      c.outline.extractOutline();
      c.navigator.highlightDurationMs = 0;
      window.scrollTo(0, 0);
      const sectionResult = await c.navigator.goToSection('section discussing banking regulations', {readAfter:false});
      const sectionRect = document.getElementById('repair-heading').getBoundingClientRect();

      document.body.innerHTML = '<fieldset><legend>Product Size</legend><label><input type="radio" name="product" value="small"> Small</label></fieldset><fieldset><legend>Text Size</legend><label><input type="radio" name="text" value="small"> Small</label></fieldset>';
      c.elementSelector.aiSearchEnabled = false;
      const ambiguous = await c.elementSelector.handleCommand('Choose Small', {doc:document});

      document.body.innerHTML = '<button id="load-delayed">Load</button><div id="delayed-zone"></div>';
      document.getElementById('load-delayed').addEventListener('click', () => setTimeout(() => {
        const button = document.createElement('button'); button.id = 'late-target'; button.textContent = 'Late target'; document.getElementById('delayed-zone').appendChild(button);
      }, 100));
      document.getElementById('load-delayed').click();
      const late = await c.waitManager.waitForElement((d) => d.getElementById('late-target'), {doc:document, timeoutMs:1200});

      document.body.innerHTML = '<h1>Silent Architecture Demo</h1><div id="description-inner">No captions are present.</div><video></video>';
      document.body.setAttribute('data-yt-page', 'watch');
      document.body.setAttribute('data-sw-site', 'youtube');
      const structured = window.SleepwalkerDigest.buildStructuredPageContext(document);
      const captionResult = await c._explainYouTubeWatch({actions:[{type:'explain'}]}, 'Explain what the speaker is teaching', structured);
      document.body.innerHTML = '<main id="app"><button id="route-target">Route One Target</button><div id="shadow-host"></div></main>';
      return {scroll:{result:scrollResult, before:scrollBefore, after:scrollAfter}, section:{result:sectionResult, y:window.scrollY, top:sectionRect.top, bottom:sectionRect.bottom, viewport:innerHeight},
        ambiguity:{status:ambiguous.status, verified:ambiguous.verified}, delayedFound:Boolean(late), pageType:structured.pageType, captionResult};
    })()`, firstContext);
    assert.strictEqual(browserRepairs.scroll.result.verified, true, `Fast-path scroll must verify after synchronous scroll completes: ${JSON.stringify(browserRepairs.scroll)}`);
    assert.ok(browserRepairs.scroll.after > browserRepairs.scroll.before, `Fast-path scroll must move the actual viewport: ${JSON.stringify(browserRepairs.scroll)}`);
    assert.strictEqual(browserRepairs.section.result.verified, true, `Section navigation must verify the target in view: ${JSON.stringify(browserRepairs.section)}`);
    assert.ok(browserRepairs.section.y > 0 && browserRepairs.section.top < browserRepairs.section.viewport && browserRepairs.section.bottom > 0, `Section target must be in the viewport after navigation: ${JSON.stringify(browserRepairs.section)}`);
    assert.strictEqual(browserRepairs.ambiguity.status, 'needs_clarification', `Duplicate exact option labels require clarification: ${JSON.stringify(browserRepairs.ambiguity)}`);
    assert.strictEqual(browserRepairs.delayedFound, true, 'Mutation-observed WaitManager must return the inserted target');
    assert.strictEqual(browserRepairs.pageType, 'youtube_watch', 'No-caption fixture must be identified as a YouTube watch page');
    assert.strictEqual(browserRepairs.captionResult.captionsAvailable, false, 'Unavailable captions must return an explicit false value');
    console.log('PASS Browser fast scroll, section navigation, ambiguity, delayed element and captions regressions (Playwright Chromium)');

    const routeTwo = await first.eval(`(async () => {
      const c = window.__SLEEPWALKER_INSTANCE__;
      history.pushState({view:2}, '', '/spa/two');
      const staleBeforeObservation = c.worldModel.resolveAndValidateCandidate(${JSON.stringify(initial.route.id)}, 'browser-tab-a', {expectedNavigationIdentity:${JSON.stringify(initial.identity)}});
      document.getElementById('app').innerHTML = '<button id="route-target">Route Two Target</button><div id="shadow-host"></div>';
      const inv = await c.worldModel.buildPageWorldModel(document, {tabId:'browser-tab-a', force:true});
      const stale = c.worldModel.resolveAndValidateCandidate(${JSON.stringify(initial.route.id)}, 'browser-tab-a', {expectedNavigationIdentity:${JSON.stringify(initial.identity)}});
      const fresh = [...inv.buttons].find((e) => /Route Two Target/.test(e.label || ''));
      const freshCheck = fresh && c.worldModel.resolveAndValidateCandidate(fresh.id, 'browser-tab-a', {expectedNavigationIdentity:inv.navigationIdentity});
      return {identity:inv.navigationIdentity, generation:inv.navigationGeneration, inventoryVersion:inv.inventoryVersion, staleBeforeObservation, stale, freshCheck};
    })()`, firstContext);
    assert.strictEqual(routeTwo.staleBeforeObservation.ok, false, 'Candidate must reject immediately after SPA route change, before a new observation');
    assert.strictEqual(routeTwo.staleBeforeObservation.stale, true, 'Immediate SPA rejection must identify stale navigation');
    assert.strictEqual(routeTwo.inventoryVersion, 1, 'A different SPA route may restart inventoryVersion at 1');
    assert.notStrictEqual(routeTwo.identity, initial.identity, 'SPA route navigation must change candidate identity');
    assert.ok(routeTwo.generation > initial.generation, 'SPA route navigation generation must increase');
    assert.strictEqual(routeTwo.stale.ok, false, 'SPA route-one candidate must be rejected on route two');
    assert.strictEqual(routeTwo.freshCheck.ok, true, 'A newly observed candidate on route two must be accepted');
    console.log('PASS Browser SPA stale-candidate rejection (Playwright Chromium)');

    const replaced = await first.eval(`(async () => {
      const c = window.__SLEEPWALKER_INSTANCE__;
      const before = await c.worldModel.buildPageWorldModel(document, {tabId:'browser-tab-a', force:true});
      const candidate = [...before.buttons, ...before.links].find((e) => /Route Two Target/.test(e.label || ''));
      document.getElementById('app').innerHTML = '<button id="replacement">Replacement target</button>';
      const staleBeforeObservation = c.worldModel.resolveAndValidateCandidate(candidate.id, 'browser-tab-a', {expectedNavigationIdentity:before.navigationIdentity});
      const after = await c.worldModel.buildPageWorldModel(document, {tabId:'browser-tab-a', force:true});
      const stale = c.worldModel.resolveAndValidateCandidate(candidate.id, 'browser-tab-a', {expectedNavigationIdentity:before.navigationIdentity});
      return {before:before.navigationIdentity, after:after.navigationIdentity, staleBeforeObservation, stale};
    })()`, firstContext);
    assert.strictEqual(replaced.staleBeforeObservation.ok, false, 'Detached candidate must be rejected immediately after same-URL DOM replacement');
    assert.strictEqual(replaced.staleBeforeObservation.stale, true, 'Pre-observation DOM replacement rejection must identify stale candidate');
    assert.notStrictEqual(replaced.before, replaced.after, 'Same-URL replacement observation must get a new candidate identity');
    assert.strictEqual(replaced.stale.ok, false, 'Pre-replacement candidate must be rejected');
    console.log('PASS Browser same-URL DOM-replacement stale-candidate rejection (Playwright Chromium)');

    const staleVisual = await first.eval(`(async () => {
      const c = window.__SLEEPWALKER_INSTANCE__;
      const wm = c.worldModel;
      const source = wm.getTabInventory('browser-tab-a');
      const oldCandidate = [...source.buttons, ...source.links].find((e) => /Replacement target/.test(e.label || ''));
      const originalSend = chrome.runtime.sendMessage;
      let stubInstalled = false;
      try {
        chrome.runtime.sendMessage = (_message, callback) => {
          stubInstalled = true;
          setTimeout(async () => {
            document.getElementById('app').innerHTML = '<button id="new-visual-target">New page target</button>';
            await wm.buildPageWorldModel(document, {tabId:'browser-tab-a', force:true});
            const rect = document.getElementById('new-visual-target').getBoundingClientRect();
            callback({status:'ok', grounding:{candidate_id:oldCandidate.id,
              normalized_x:Math.round(((rect.left + rect.width / 2) / innerWidth) * 1000),
              normalized_y:Math.round(((rect.top + rect.height / 2) / innerHeight) * 1000)}});
          }, 20);
        };
        const result = await c._requestVisualGroundFallback('Click the replacement target', 'test_pending_visual', source);
        return {stubInstalled, status:result.status, targetId:result.validatedElement && result.validatedElement.id};
      } finally {
        chrome.runtime.sendMessage = originalSend;
      }
    })()`, firstContext);
    assert.strictEqual(staleVisual.stubInstalled, true, 'Browser test must delay the visual reply while replacing the DOM');
    assert.strictEqual(staleVisual.status, 'stale_navigation', 'Delayed visual result from the prior DOM must be rejected');
    assert.strictEqual(staleVisual.targetId, null, 'Stale visual coordinates must not resolve to the replacement page target');
    console.log('PASS Browser delayed visual response cannot fall back onto a newer DOM');

    // Open a real second tab. A snapshot identity captured in tab A must not
    // validate in the independent content-script world running in tab B.
    const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    const browserCdp = await connect(version.webSocketDebuggerUrl);
    sockets.push(browserCdp.ws);
    await browserCdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/main` });
    const secondTarget = await pageTarget(debugPort, (target) => target.url.includes('/main') && target.id !== firstTarget.id);
    const second = await connect(secondTarget.webSocketDebuggerUrl);
    sockets.push(second.ws);
    const secondContext = await waitForExtensionContext(second);
    const tabCheck = await second.eval(`(async () => {
      const c = window.__SLEEPWALKER_INSTANCE__;
      const inv = await c.worldModel.buildPageWorldModel(document, {tabId:'browser-tab-b', force:true});
      const check = c.worldModel.resolveAndValidateCandidate('B001', 'browser-tab-b', {expectedNavigationIdentity:${JSON.stringify(initial.identity)}});
      return {identity:inv.navigationIdentity, check};
    })()`, secondContext);
    assert.notStrictEqual(tabCheck.identity, initial.identity, 'Real browser tabs must have isolated content-script identities');
    assert.strictEqual(tabCheck.check.ok, false, 'Candidate identity from tab A must be rejected in tab B');
    console.log('PASS Browser cross-tab candidate identity isolation (Playwright Chromium)');

    await first.send('Page.navigate', { url: `http://127.0.0.1:${port}/redirect` });
    const reloadedContext = await waitForExtensionContext(first);
    const reloadCheck = await first.eval(`(async () => {
      const c = window.__SLEEPWALKER_INSTANCE__;
      const inv = await c.worldModel.buildPageWorldModel(document, {tabId:'browser-tab-a', force:true});
      const check = c.worldModel.resolveAndValidateCandidate(${JSON.stringify(initial.route.id)}, 'browser-tab-a', {expectedNavigationIdentity:${JSON.stringify(initial.identity)}});
      return {url:location.pathname, identity:inv.navigationIdentity, check};
    })()`, reloadedContext);
    assert.strictEqual(reloadCheck.url, '/main', 'Full navigation redirect must land on the final destination');
    assert.notStrictEqual(reloadCheck.identity, initial.identity, 'Reload/redirect must establish a collision-resistant identity');
    assert.strictEqual(reloadCheck.check.ok, false, 'Pre-reload candidate identity must be rejected after redirect');
    console.log('PASS Browser full-navigation/redirect candidate isolation (Playwright Chromium)');
  } finally {
    for (const socket of sockets) { try { socket.close(); } catch (_error) {} }
    try { browser.kill(); } catch (_error) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_error) {}
    try { server.close(); } catch (_error) {}
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
