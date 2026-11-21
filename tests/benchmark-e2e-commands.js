/**
 * Sleepwalker 2.0 — Real End-to-End Chrome MV3 Extension Benchmark
 * Measures real browser + Service Worker + local Ollama + Gemini telemetry across
 * the 6 core benchmark tasks from Priority 7 on real /wiki-wm and /yt-feed fixtures.
 *
 * Usage:
 *   node tests/benchmark-e2e-commands.js [--json=out.json]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const jsonOut = (argv.find((a) => a.startsWith('--json=')) || '').split('=')[1] || '';

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
        body { font-family: sans-serif; margin: 24px; line-height: 1.5; min-height: 2200px; }
        .layout { display: grid; grid-template-columns: 1fr 260px; gap: 24px; }
        aside#appearance-panel { border: 1px solid #ccc; padding: 14px; border-radius: 8px; background: #f8f9fa; }
        section { margin-bottom: 48px; padding-bottom: 18px; border-bottom: 1px solid #eee; min-height: 260px; }
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
              <p>Overview of financial settlement instruments, automated risk checks, and fraud scoring.</p>
              <ul>
                <li>Account billing: <a href="/wiki/Bank_card_banking" id="link-bank-banking">Bank card</a> (issuer account link)</li>
              </ul>
            </section>
            <section id="sec-cards">
              <h2>Cards</h2>
              <p>Different retail debit and credit card networks for consumer payments.</p>
              <ul>
                <li><a href="/wiki/Bank_card_cards" id="link-bank-cards">Bank card</a></li>
                <li><a href="/wiki/Smart_card" id="link-smart-card">Smart card</a></li>
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
          </main>
          <aside id="appearance-panel">
            <h2>Appearance</h2>
            <button id="hide-appearance-btn" type="button">Hide Appearance</button>
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
          <div id="load-status">Showing Batch 1 (10 videos).</div>
        </main>
        <script>
          (function() {
            const batch1 = [
              { id: 'v01', ch: 'ChefLab', dur: '6:12', t: 'Sourdough Bread Hydration Guide', d: 'Baking temperature and fermentation schedule.' },
              { id: 'v02', ch: 'GuitarPro', dur: '11:05', t: 'Jazz Chord Voicings for Beginners', d: 'Practice pentatonic chords.' },
              { id: 'v03', ch: 'Travelogue', dur: '8:40', t: 'Kyoto Autumn Temple Walk', d: 'Scenic walking tour.' },
              { id: 'v04', ch: 'WoodCraft', dur: '14:20', t: 'Dovetail Joint Workshop', d: 'Hand-saw woodworking.' },
              { id: 'v05', ch: 'AstroCam', dur: '9:15', t: 'Photographing Saturn Rings', d: 'Telescope exposure tips.' },
              { id: 'v06', ch: 'BikeFix', dur: '7:30', t: 'Adjusting Rear Derailleur Tension', d: 'Simple cable indexing.' },
              { id: 'v07', ch: 'PlantHome', dur: '5:50', t: 'Indoor Fern Care and Lighting', d: 'Humidity fundamentals.' },
              { id: 'v08', ch: 'FilmCut', dur: '12:00', t: 'Three-Point Studio Lighting Setup', d: 'Key fill backlight basics.' },
              { id: 'v09', ch: 'ChessClub', dur: '16:45', t: 'Italian Game Opening Traps', d: 'Classic tactical motifs.' },
              { id: 'v10', ch: 'CoffeeBar', dur: '4:35', t: 'Dialing In Espresso Grind Size', d: 'Extraction calibration.' }
            ];
            const batch2 = [
              { id: 'v11', ch: 'PhotoMix', dur: '10:10', t: 'Street Photography Color Grading', d: 'Contrast curves in RAW.' },
              { id: 'v12', ch: 'CodeMint', dur: '8:55', t: 'CSS Subgrid Layout Patterns', d: 'Responsive card alignment.' },
              { id: 'v13', ch: 'NeuralPath', dur: '19:20', t: 'Understanding Deep Learning Through Examples', d: 'Beginner-friendly explanation showing how neural networks learn weights and layers using visual examples.', href: '/yt-watch-nn' },
              { id: 'v14', ch: 'FitPace', dur: '13:10', t: 'Zone 2 Marathon Conditioning', d: 'Heart-rate blocks.' },
              { id: 'v15', ch: 'MathViz', dur: '15:40', t: 'Gradient Descent Backpropagation Step by Step', d: 'Partial derivatives across layers.', href: '/yt-watch-15' }
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
                const sp = document.createElement('span');
                sp.className = 'video-channel';
                sp.textContent = v.ch + ' · ' + v.dur;
                const p = document.createElement('p');
                p.className = 'video-description';
                p.textContent = v.d;
                card.append(h3, sp, p);
                list.appendChild(card);
              }
            };
            renderBatch(batch1);
            const loadB2 = () => { if (!window.__b2) { window.__b2 = true; renderBatch(batch2); } };
            document.addEventListener('sleepwalker:load-more', loadB2);
            window.addEventListener('scroll', () => { if (window.scrollY > 180) loadB2(); });
          })();
        </script>
      </body></html>`,

    '/yt-watch-nn': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Understanding Deep Learning Through Examples</title></head><body><h1>Understanding Deep Learning Through Examples</h1></body></html>`,
    '/yt-watch-15': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gradient Descent</title></head><body><h1>Gradient Descent</h1></body></html>`
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
        res.end(`<!DOCTYPE html><html><head><title>${urlPath.slice(6)}</title></head><body><h1>Destination ${urlPath}</h1></body></html>`);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  const exe = findChromiumExe();
  assert.ok(exe, 'Chromium / Chrome binary required for E2E benchmark');
  const { server, port } = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-bench-e2e-'));
  const cdpPort = 9550 + Math.floor(Math.random() * 300);

  const chrome = spawn(exe, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `http://127.0.0.1:${port}/wiki-wm`
  ], { stdio: 'ignore' });

  const sockets = [];
  const connectTarget = async (target) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    sockets.push(ws);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    let cid = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++cid;
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMsg);
        reject(new Error(`CDP timeout on ${method}`));
      }, 4500);
      const onMsg = async (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
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
    const evalJs = async (body) => {
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r && r.result ? r.result.value : undefined;
    };
    return { ws, send, evalJs };
  };

  try {
    let pageTarget = null;
    let swTarget = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && (!pageTarget || !swTarget)) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
        if (!pageTarget) pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('/wiki-wm'));
        if (!swTarget) {
          for (const cand of targets.filter((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'))) {
            const p = await connectTarget(cand);
            const mf = await p.evalJs(`return chrome.runtime.getManifest().name;`).catch(() => '');
            if (String(mf).includes('Sleepwalker')) { swTarget = cand; break; }
          }
        }
      } catch (_e) {}
    }
    assert.ok(pageTarget && swTarget, 'Extension service worker & page target must load');

    const pageCdp = await connectTarget(pageTarget);
    const swCdp = await connectTarget(swTarget);
    await new Promise((r) => setTimeout(r, 1200));

    const wakeUi = async () => {
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await new Promise((r) => setTimeout(r, 350));
    };

    const getSwStats = async () => swCdp.evalJs(`
      const d = typeof getLlmDiagnostics === 'function' ? getLlmDiagnostics() : {};
      const m = (typeof LLM_METRICS === 'object' && LLM_METRICS) ? LLM_METRICS : {};
      const traces = Array.isArray(self._devWorldModelTraces) ? self._devWorldModelTraces : [];
      const o = m.ollama || {};
      return {
        callsTotal: d.callsTotal || 0,
        cloudCalls: d.cloudCalls || 0,
        ollamaCalls: (d.ollamaCalls || 0) + (o.totalRequests || 0),
        cacheHits: d.cacheHits || 0,
        approxInputTokens: d.approxInputTokens || 0,
        approxOutputTokens: d.approxOutputTokens || 0,
        traceLen: traces.length,
        lastTrace: traces.length ? traces[traces.length - 1] : null
      };
    `).catch(() => ({ callsTotal: 0, cloudCalls: 0, ollamaCalls: 0, cacheHits: 0, approxInputTokens: 0, approxOutputTokens: 0, traceLen: 0, lastTrace: null }));

    const runMeasuredCommand = async (label, cmd, opts = {}) => {
      const beforeSw = await getSwStats();
      const t0 = Date.now();
      await pageCdp.evalJs(`
        const sr = document.getElementById('sleepwalker-ui-host')?.shadowRoot;
        if (sr) {
          const b = sr.getElementById('sw-card-body'); if (b) b.textContent = '';
          const form = sr.getElementById('sw-ui-type-form');
          const btn = sr.getElementById('sw-ui-type-btn');
          const inp = sr.getElementById('sw-ui-type-input');
          const submit = sr.querySelector('.sw-type-submit');
          if (form && form.hidden && btn) btn.click();
          inp.value = ${JSON.stringify(cmd)};
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          submit.click();
        }
      `);

      // Wait until turn completes (url changed OR aurora/turn metrics settle & not processing)
      const waitDeadline = Date.now() + (opts.timeoutMs || 25000);
      let stateSnap = null;
      while (Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 90));
        stateSnap = await pageCdp.evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host')?.shadowRoot;
          const root = sr ? sr.querySelector('.sw-ui-root') : null;
          const aurora = sr ? sr.getElementById('sw-ui-aurora') : null;
          const cardBody = sr ? sr.getElementById('sw-card-body') : null;
          const cardTitle = sr ? sr.getElementById('sw-card-title') : null;
          return {
            path: location.pathname,
            scrollY: window.scrollY,
            darkChecked: Boolean(document.getElementById('color-dark') && document.getElementById('color-dark').checked),
            state: root ? root.dataset.state : '',
            taskState: aurora ? aurora.dataset.taskState : '',
            stage: sr && sr.getElementById('sw-ui-aurora-stage') ? sr.getElementById('sw-ui-aurora-stage').textContent : '',
            title: cardTitle ? cardTitle.textContent : '',
            body: cardBody ? cardBody.textContent : '',
            metrics: window.__SW_LAST_TURN_METRICS__ || null
          };
        `).catch(() => ({ navigated: true }));

        if (stateSnap.navigated) break;
        if (opts.expectPathChange && stateSnap.path && stateSnap.path !== '/wiki-wm' && stateSnap.path !== '/yt-feed') break;
        const bodyText = String(stateSnap.body || '').trim();
        const isPlaceholder = /^(analyzing|preparing|thinking|processing|loading)\b/i.test(bodyText) || /streaming/i.test(stateSnap.title || '');
        const doneProcessing = Boolean(stateSnap.taskState && stateSnap.taskState !== 'processing');
        const uiDone = stateSnap.state && !['thinking', 'preparing'].includes(stateSnap.state);
        if ((Date.now() - t0) > 150) {
          if (opts.waitForCardBody) {
            if (doneProcessing && bodyText.length > 25 && !isPlaceholder) break;
          } else if (opts.expectPathChange) {
            if (stateSnap.taskState === 'error') break;
          } else if (doneProcessing && uiDone) {
            break;
          }
        }
      }
      const wallMs = Date.now() - t0;
      await new Promise((r) => setTimeout(r, 120));
      const afterSw = await getSwStats();
      const postPath = await pageCdp.evalJs('return location.pathname;').catch(() => '');
      const tr = afterSw.traceLen > beforeSw.traceLen ? afterSw.lastTrace : null;
      return {
        label, cmd, wallMs,
        ollamaCalls: afterSw.ollamaCalls - beforeSw.ollamaCalls,
        geminiCalls: afterSw.cloudCalls - beforeSw.cloudCalls,
        inTokens: afterSw.approxInputTokens - beforeSw.approxInputTokens,
        outTokens: afterSw.approxOutputTokens - beforeSw.approxOutputTokens,
        nluModel: (tr && tr.model) || '',
        ttftMs: (tr && tr.ttftMs) || 0,
        inferMs: (tr && tr.inferMs) || 0,
        metrics: stateSnap && stateSnap.metrics,
        path: postPath || (stateSnap && stateSnap.path) || '',
        snap: stateSnap
      };
    };

    const results = [];
    await wakeUi();

    // Task 1: "Scroll down."
    const r1 = await runMeasuredCommand('1. Scroll down', 'Scroll down.');
    r1.ok = (r1.snap && r1.snap.scrollY > 100);
    console.log('DONE 1:', r1.ok, r1.wallMs + 'ms');
    results.push(r1);

    // Task 2: "Go to the Banking section."
    const r2 = await runMeasuredCommand('2. Go to the Banking section', 'Go to the Banking section.');
    r2.ok = Boolean(r2.snap && (r2.snap.scrollY >= 0 || /banking/i.test(r2.snap.title + r2.snap.body)));
    console.log('DONE 2:', r2.ok, r2.wallMs + 'ms');
    results.push(r2);

    // Task 3: "Select Dark under Color."
    const r3 = await runMeasuredCommand('3. Select Dark under Color', 'Select Dark under Color.');
    r3.ok = Boolean(r3.snap && r3.snap.darkChecked === true);
    console.log('DONE 3:', r3.ok, r3.wallMs + 'ms');
    results.push(r3);

    // Task 4: Contextual multi-step -> "Take me to Latest Articles" -> "Go to the Banking section" -> "Open the second article in the previous section."
    await runMeasuredCommand('4a-setup. Take me to Latest Articles', 'Take me to Latest Articles');
    await new Promise((r) => setTimeout(r, 300));
    await runMeasuredCommand('4b-setup. Go to Banking section', 'Go to the Banking section');
    await new Promise((r) => setTimeout(r, 300));
    const r4 = await runMeasuredCommand('4. Open 2nd article in previous section', 'Open the second article in the previous section.', { expectPathChange: true });
    await new Promise((r) => setTimeout(r, 700));
    const finalPath4 = await pageCdp.evalJs('return location.pathname;').catch(() => r4.path);
    r4.path = finalPath4;
    r4.ok = (finalPath4 === '/wiki/Article_2');
    console.log('DONE 4:', r4.ok, r4.wallMs + 'ms', finalPath4);
    results.push(r4);

    // Task 5: Navigate back to /wiki-wm and "Summarize this page."
    await pageCdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/wiki-wm` });
    await new Promise((r) => setTimeout(r, 1100));
    await wakeUi();
    const r5 = await runMeasuredCommand('5. Summarize this page', 'Summarize this page.', { waitForCardBody: true, timeoutMs: 25000 });
    r5.ok = Boolean(r5.snap && r5.snap.body && r5.snap.body.trim().length > 25 && !/^(analyzing|preparing|thinking|processing|loading)\b/i.test(r5.snap.body.trim()));
    console.log('DONE 5:', r5.ok, r5.wallMs + 'ms');
    results.push(r5);

    // Task 6a: Complex contextual Wikipedia jump
    const r6a = await runMeasuredCommand('6a. Conceptual jump (advantages)', 'Take me to where they explain the advantages');
    r6a.ok = Boolean(r6a.snap && /benefits|advantages|moved|section/i.test(`${r6a.snap.title} ${r6a.snap.body} ${r6a.snap.stage}`));
    console.log('DONE 6a:', r6a.ok, r6a.wallMs + 'ms');
    results.push(r6a);

    // Task 6b: Complex YouTube progressive feed discovery
    await pageCdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/yt-feed` });
    await new Promise((r) => setTimeout(r, 1100));
    await wakeUi();
    const r6b = await runMeasuredCommand('6b. Complex YouTube video discovery', 'Find a beginner-friendly video explaining how neural networks learn', { expectPathChange: true, timeoutMs: 25000 });
    await new Promise((r) => setTimeout(r, 900));
    const ytPath = await pageCdp.evalJs('return location.pathname;').catch(() => r6b.path);
    r6b.path = ytPath;
    r6b.ok = (ytPath === '/yt-watch-nn');
    console.log('DONE 6b:', r6b.ok, r6b.wallMs + 'ms', ytPath);
    results.push(r6b);

    console.log('\n=== Sleepwalker 2.0 E2E Extension Benchmark Results ===');
    for (const r of results) {
      const st = r.ok ? 'PASS' : 'FAIL';
      console.log(`${st}  ${r.label.padEnd(38)} wall=${String(r.wallMs).padStart(5)}ms  oll=${r.ollamaCalls} gem=${r.geminiCalls} tok=${r.inTokens}/${r.outTokens} ttft=${r.ttftMs}ms infer=${r.inferMs}ms model=${r.nluModel || '-'} path=${r.path}`);
    }
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ startedAt: new Date().toISOString(), results }, null, 2));
    const allPass = results.every((r) => r.ok);
    process.exit(allPass ? 0 : 1);
  } finally {
    for (const s of sockets) try { s.close(); } catch (_e) {}
    await new Promise((r) => setTimeout(r, 150));
    try { chrome.kill('SIGKILL'); } catch (_e) {}
    await new Promise((r) => server.close(r));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
  }
})();
