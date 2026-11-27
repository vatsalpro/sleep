'use strict';

const http = require('http');

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sleepwalker Dynamic Test Page</title></head>
<body style="font-family:sans-serif;padding:24px;min-height:2200px;">
  <main id="app">
    <h1>Dynamic &amp; Stress Fixture</h1>
    <p id="p1">First readable sentence on the dynamic test page. Second readable sentence for mid-read navigation verification.</p>
    <nav aria-label="Main Navigation">
      <a href="#about" id="nav-about">About Us</a>
      <a href="#faq" id="nav-faq">Frequently Asked Questions</a>
      <button type="button" id="open-modal-btn">Open Support Modal</button>
      <button type="button" id="spa-route-btn">Go To Profile View</button>
    </nav>
    <section id="shadow-host" style="margin-top:20px;"></section>
    <iframe id="same-origin-frame" src="/frame" style="width:360px;height:90px;border:1px solid #ccc;margin-top:16px;"></iframe>
    <div id="modal-root" role="dialog" aria-modal="true" style="display:none;padding:16px;border:2px solid #333;margin-top:16px;">
      <h2>Support Dialog</h2>
      <button type="button" id="modal-help-btn">Contact Support Team</button>
      <button type="button" id="modal-close-btn">Close Dialog</button>
    </div>
    <div id="spa-view" style="margin-top:16px;"></div>
    <div id="lazy-zone" style="margin-top:1200px;padding:16px;border:1px dashed #666;">Lazy zone</div>
  </main>
  <script>
    const sh = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
    sh.innerHTML = '<button type="button" id="shadow-btn">Shadow Preferences</button>';

    document.getElementById('open-modal-btn').addEventListener('click', () => {
      document.getElementById('modal-root').style.display = 'block';
    });
    document.getElementById('modal-close-btn').addEventListener('click', () => {
      document.getElementById('modal-root').style.display = 'none';
    });

    document.getElementById('spa-route-btn').addEventListener('click', () => {
      history.pushState({ view: 'profile' }, '', '/profile');
      document.getElementById('spa-view').innerHTML = '<h2>Profile Dashboard</h2><button id="spa-edit-btn">Edit Display Name</button>';
    });

    let lazyLoaded = false;
    window.addEventListener('scroll', () => {
      if (!lazyLoaded && window.scrollY > 500) {
        lazyLoaded = true;
        document.getElementById('lazy-zone').innerHTML = '<a href="#lazy-item" id="lazy-link">Lazy Loaded Documentation</a>';
      }
    });
  </script>
</body>
</html>`;

const FRAME_HTML = `<!doctype html><html><body><button type="button" id="iframe-btn">Iframe Help Guide</button></body></html>`;

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/frame') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FRAME_HTML);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

async function runDynamicAndStressSuite(page, sw, getTabId, sendToTab) {
  const { server, url } = await startFixtureServer();
  const results = [];
  const failures = [];

  const record = (name, ok, detail, extra = {}) => {
    results.push({ name, ok, detail, ...extra });
    if (!ok) {
      failures.push({
        url,
        selector: extra.selector || name,
        input: extra.input || name,
        expected: extra.expected || 'Pass',
        actual: detail
      });
    }
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1200);
    const tabId = await getTabId(url);

    // 1. Shadow DOM & Same-Origin Iframe Detection
    const initScan = await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_AUDIT_SNAPSHOT', mode: 'scan' });
    const initLabels = (initScan && initScan.items ? initScan.items : []).map((i) => i.label);
    record('Shadow DOM detection', initLabels.some((l) => /Shadow Preferences/i.test(l)), initLabels.some((l) => /Shadow Preferences/i.test(l)) ? 'Detected "Shadow Preferences"' : `Missing in ${JSON.stringify(initLabels.slice(0, 10))}`, { selector: '#shadow-host >>> #shadow-btn', expected: 'Shadow DOM button indexed' });
    record('Same-origin iframe detection', initLabels.some((l) => /Iframe Help Guide/i.test(l)), initLabels.some((l) => /Iframe Help Guide/i.test(l)) ? 'Detected "Iframe Help Guide"' : `Missing in ${JSON.stringify(initLabels.slice(0, 10))}`, { selector: '#same-origin-frame >>> #iframe-btn', expected: 'Iframe button indexed' });

    // 2. Dynamic Popup / Modal detection after DOM mutation
    await page.click('#open-modal-btn');
    await page.waitForTimeout(500);
    const modalScan = await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_AUDIT_SNAPSHOT', mode: 'scan' });
    const hasModal = (modalScan && modalScan.items ? modalScan.items : []).some((i) => /Contact Support Team/i.test(i.label));
    record('Dynamic modal detection', hasModal, hasModal ? 'Detected "Contact Support Team" inside opened modal' : 'Modal button not detected after reveal', { selector: '#modal-help-btn', expected: 'Modal controls detected' });
    await page.click('#modal-close-btn');
    await page.waitForTimeout(300);

    // 3. SPA route change (history.pushState)
    await page.click('#spa-route-btn');
    await page.waitForTimeout(600);
    const spaScan = await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_AUDIT_SNAPSHOT', mode: 'scan' });
    const hasSpaBtn = (spaScan && spaScan.items ? spaScan.items : []).some((i) => /Edit Display Name/i.test(i.label));
    const spaPath = new URL(page.url()).pathname;
    record('SPA pushState route update', spaPath === '/profile' && hasSpaBtn, hasSpaBtn ? 'Detected new SPA control "Edit Display Name" at /profile' : `Failed: path=${spaPath}, hasSpaBtn=${hasSpaBtn}`, { selector: '#spa-edit-btn', expected: 'SPA route control detected' });

    // 4. Scroll-triggered lazy loading
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(650);
    const lazyScan = await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_AUDIT_SNAPSHOT', mode: 'scan' });
    const hasLazy = (lazyScan && lazyScan.items ? lazyScan.items : []).some((i) => /Lazy Loaded Documentation/i.test(i.label));
    record('Lazy-loaded element detection', hasLazy, hasLazy ? 'Detected "Lazy Loaded Documentation" after scroll' : 'Lazy element missed after scroll', { selector: '#lazy-link', expected: 'Lazy link detected' });

    // 5. Echo of own TTS (EchoTracker suppression)
    const echoRes = await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_AUDIT_SNAPSHOT', mode: 'echo' });
    record('TTS Echo suppression', Boolean(echoRes && echoRes.ok), (echoRes && echoRes.detail) || 'Failed', { input: 'own TTS reverb vs user command', expected: 'Own phrase suppressed, real commands allowed' });

    // 6. Command spam (8 rapid consecutive commands in 120ms bursts)
    const cmds = ['outline', 'scroll down', 'scroll up', 'outline', 'scroll down', 'help', 'scroll up', 'outline'];
    let spamErrors = 0;
    for (const c of cmds) {
      await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_EXECUTE_COMMAND', text: c, inputSource: 'typed', fireAndForget: true }).catch(() => { spamErrors += 1; });
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(600);
    const afterSpam = await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_GET_STATE' });
    record('Command spam resilience (8 rapid cmds)', Boolean(spamErrors === 0 && afterSpam && afterSpam.ok), `errors=${spamErrors}, alive=${Boolean(afterSpam && afterSpam.ok)}, state=${afterSpam && afterSpam.taskLifecycleState}`, { input: '8 rapid burst commands', expected: 'Zero unhandled crashes, clean preemption' });

    // 7. Page changing mid-read
    const readStart = await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_AUDIT_SNAPSHOT', mode: 'read_start' });
    await page.goto(`${url}next-page`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(900);
    const tabIdAfter = await getTabId(`${url}next-page`);
    const afterNav = await sendToTab(sw, tabIdAfter, { action: 'SLEEPWALKER_SW_GET_STATE' });
    const danglingHl = await page.evaluate(() => document.querySelectorAll('.sleepwalker-active-sentence').length);
    const midOk = Boolean(readStart && readStart.started && afterNav && afterNav.ok && !afterNav.isSpeaking && danglingHl === 0);
    record('Page change mid-read cleanup', midOk, `started=${readStart && readStart.started}, speakingAfter=${afterNav && afterNav.isSpeaking}, danglingHl=${danglingHl}`, { input: 'navigate during readPage()', expected: 'Clean teardown, no stuck playing state or dangling highlights' });
  } finally {
    server.close();
  }

  return { results, failures };
}

module.exports = { runDynamicAndStressSuite };
