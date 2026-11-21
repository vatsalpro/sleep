/**
 * Sleepwalker Phase 4.2 — Intelligent NLU, Contextual Reasoning, YouTube/Wikipedia Hierarchy,
 * Action Verification/Recovery & Non-Overlapping Command Bar Test Suite
 *
 * Tier 1: Node Unit & Integration Tests + Live Ollama (`llama3.2:3b` & `nomic-embed-text`) Checks
 * Tier 2: Real Loaded Unpacked MV3 Chrome Extension (`--load-extension=D:\sleep`) E2E against
 *         realistic Wikipedia, Official Docs, YouTube Search, YouTube Watch (with/without captions)
 *         fixtures AND real Shadow DOM Command Bar layout geometry verification.
 *
 * Run with: node D:\sleep\tests\run-phase4-2-nlu-tests.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const digest = require(path.join(ROOT, 'digest.js'));
const match = require(path.join(ROOT, 'match.js'));
const linkIntent = require(path.join(ROOT, 'link-intent.js'));
const SleepwalkerMemory = require(path.join(ROOT, 'memory.js'));
const llm = require(path.join(ROOT, 'llm.js'));
const aiComm = require(path.join(ROOT, 'ai-comm.js'));
const geminiLive = require(path.join(ROOT, 'gemini-live.js'));

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

function makeFakeChrome() {
  const local = {};
  const session = {};
  return {
    runtime: {
      id: 'ext_phase4_2_test',
      lastError: null,
      sendMessage(msg, cb) {
        if (msg && msg.type === 'SLEEPWALKER_MEMORY_SET' && msg.state) {
          local.sleepwalker_persistent_memory_v1 = JSON.parse(JSON.stringify(msg.state));
          session.sleepwalker_persistent_memory_v1 = JSON.parse(JSON.stringify(msg.state));
          if (cb) cb({ status: 'ok' });
          return;
        }
        if (msg && msg.type === 'SLEEPWALKER_MEMORY_GET') {
          const merged = session.sleepwalker_persistent_memory_v1 || local.sleepwalker_persistent_memory_v1 || null;
          if (cb) cb({ status: 'ok', state: merged ? JSON.parse(JSON.stringify(merged)) : null });
          return;
        }
        if (cb) cb({ status: 'ok' });
      }
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const ks = Array.isArray(keys) ? keys : Object.keys(local);
          for (const k of ks) out[k] = local[k];
          if (cb) cb(out);
        },
        set(obj, cb) {
          Object.assign(local, JSON.parse(JSON.stringify(obj || {})));
          if (cb) cb();
        },
        remove(keys, cb) {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete local[k];
          if (cb) cb();
        }
      },
      session: {
        get(keys, cb) {
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : Object.keys(session))) out[k] = session[k];
          if (cb) cb(out);
        },
        set(obj, cb) {
          Object.assign(session, JSON.parse(JSON.stringify(obj || {})));
          if (cb) cb();
        }
      }
    }
  };
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

function startFixtureServer() {
  const pages = {
    '/wiki': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Payment Card - Wikipedia Fixture</title></head>
      <body data-sw-page-type="wikipedia">
        <h1 id="firstHeading">Payment card</h1>
        <div class="mw-parser-output">
          <p>A payment card is part of an electronic payment system issued by financial institutions.</p>
          <h2>Banking</h2>
          <p>Overview of banking instruments and fraud risks in financial accounts.</p>
          <ul>
            <li>Financial services: <a href="/wiki/Bank_card_banking" id="link-bank-banking">Bank card</a> (issuer account link)</li>
          </ul>
          <h2>Cards</h2>
          <p>Different payment cards serve retail debit and credit transactions.</p>
          <ul>
            <li>Card categories:
              <ul>
                <li><a href="/wiki/Bank_card_cards" id="link-bank-cards">Bank card</a> (card types directory)</li>
                <li><a href="/wiki/Smart_card" id="link-smart-card">Smart card</a></li>
              </ul>
            </li>
          </ul>
          <h2>Applications</h2>
          <p>Common protocol and commerce applications using card tokens.</p>
          <h3>Retail checkout</h3>
          <p>Point-of-sale chip and PIN verification at retail counters.</p>
          <h3>Online gateways</h3>
          <p>Tokenized browser and API payment flows for e-commerce merchants.</p>
          <h2>Transport layer</h2>
          <p>TCP ensures reliable ordered delivery of encrypted payment packets across ports 443 and 8443.</p>
          <h2>Protocols</h2>
          <table id="proto-table">
            <caption>Network Protocols Table</caption>
            <thead><tr><th>Protocol</th><th>Port</th><th>Layer</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td>TCP</td><td>80 / 443</td><td>Transport</td><td>Active</td></tr>
              <tr><td>UDP</td><td>53 / 443</td><td>Transport</td><td>QUIC Support</td></tr>
            </tbody>
          </table>
          <h2>Resources</h2>
          <ul>
            <li><a href="https://example.medium.com/pytorch-unofficial-blog" id="link-unofficial-pytorch">PyTorch Tutorial Blog</a></li>
            <li><a href="https://docs.pytorch.org/docs/stable/index.html" id="link-official-pytorch">PyTorch Documentation</a></li>
            <li><a href="https://www.reddit.com/r/pytorch/" id="link-reddit-pytorch">PyTorch Forum</a></li>
          </ul>
        </div>
      </body></html>`,

    '/yt-search': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>python tutorial - YouTube</title></head>
      <body data-sw-site="youtube" data-yt-page="search">
        <main>
          <h1>Search results for python tutorial</h1>
          <div class="video-card" data-video-id="vid1" data-channel="Fireship" data-duration="4:10" data-title="Python in 100 Seconds" data-description="Fast overview of Python syntax and ecosystem">
            <h3><a href="/yt-watch-captions" id="video-link-1">Python in 100 Seconds</a></h3>
            <span class="video-channel">Fireship</span>
            <span class="video-duration">4:10</span>
            <p class="video-description">Fast coding overview of Python syntax and ecosystem</p>
          </div>
          <div class="video-card" data-video-id="vid2" data-channel="FreeCodeCamp" data-duration="24:30" data-title="Python Full Beginner Tutorial" data-description="Complete beginner coding tutorial for Python fundamentals">
            <h3><a href="/yt-watch-captions" id="video-link-2">Python Full Beginner Tutorial</a></h3>
            <span class="video-channel">FreeCodeCamp</span>
            <span class="video-duration">24:30</span>
            <p class="video-description">Complete beginner coding tutorial for Python fundamentals</p>
          </div>
          <div class="video-card" data-video-id="vid3" data-channel="TechWithTim" data-duration="14:00" data-title="Python OOP Deep Dive" data-description="Classes and objects in Python coding">
            <h3><a href="/yt-watch-captions" id="video-link-3">Python OOP Deep Dive</a></h3>
            <span class="video-channel">TechWithTim</span>
            <span class="video-duration">14:00</span>
            <p class="video-description">Classes and objects in Python coding</p>
          </div>
        </main>
      </body></html>`,

    '/yt-watch-captions': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Python Full Beginner Tutorial - YouTube</title></head>
      <body data-sw-site="youtube" data-yt-page="watch" data-duration="24:30">
        <main>
          <h1 data-watch-title>Python Full Beginner Tutorial</h1>
          <div class="watch-channel" data-watch-channel>FreeCodeCamp</div>
          <video id="movie-player-video" data-video-id="vid2" data-video-title="Python Full Beginner Tutorial" data-channel="FreeCodeCamp" data-duration="24:30" width="480" height="270" controls loop muted autoplay></video>
          <p class="watch-description" data-watch-description>Learn variables, loops, and functions in Python.</p>
          <section id="transcript-panel">
            <h2>Transcript</h2>
            <div class="transcript-segment" data-start-sec="0" data-timestamp="0:00">Welcome to the Python beginner tutorial. Today we start with installing Python 3.</div>
            <div class="transcript-segment" data-start-sec="95" data-timestamp="1:35">Next, we declare variables for integers, floats, and strings in a clean script.</div>
            <div class="transcript-segment" data-start-sec="210" data-timestamp="3:30">Then we write basic for loops and if statements to control program flow.</div>
            <div class="transcript-segment" data-start-sec="420" data-timestamp="7:00">Later section at 7 minutes covers classes, inheritance, and unit testing.</div>
          </section>
        </main>
      </body></html>`,

    '/yt-watch-nocaptions': `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Instrumental Piano Demo - YouTube</title></head>
      <body data-sw-site="youtube" data-yt-page="watch" data-duration="6:00">
        <main>
          <h1 data-watch-title>Instrumental Piano Demo</h1>
          <div class="watch-channel" data-watch-channel>StudioAudio</div>
          <video id="movie-player-nocap" data-video-id="vid_nocap" data-video-title="Instrumental Piano Demo" data-channel="StudioAudio" data-duration="6:00" width="480" height="270" controls></video>
          <p class="watch-description" data-watch-description>Acoustic piano studio recording session in 4K.</p>
        </main>
      </body></html>`
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
        res.end(`<!DOCTYPE html><html><head><title>${urlPath.slice(6)}</title></head><body><h1>Visited ${urlPath}</h1><p>Opened destination successfully.</p></body></html>`);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

(async function main() {
  console.log('=== Sleepwalker Phase 4.2 Test Suite ===');
  const prevChrome = global.chrome;
  global.chrome = makeFakeChrome();

  // ---------------- TIER 1: UNIT, CONTEXTUAL, OLLAMA NLU, YOUTUBE/WIKIPEDIA & REGRESSION ----------------
  await runSuite('A1. NLU JSON repair + strict allowlist validator rejects unsafe selectors', async () => {
    const validIds = new Set(['link_1', 'link_2', 'video_1']);
    const broken = '```json\n{"intent":"open_link","goal":"Open Bank card","target":"Bank card","context":{"section":"Cards","candidate_id":"link_2",},"actions":[{"type":"open_link","candidate_id":"link_2","target":"Bank card",}],"confidence":0.94';
    const parsed = llm.parseNluPlanJson(broken, validIds);
    assert.ok(parsed, 'Broken trailing-comma / unclosed NLU JSON should repair cleanly');
    assert.strictEqual(parsed.intent, 'open_link');
    assert.strictEqual(parsed.context.section, 'Cards');
    assert.strictEqual(parsed.context.candidate_id, 'link_2');

    // Reject CSS selector / JS injection attempt
    const unsafe = '{"intent":"open_link","context":{"candidate_id":"div.card > a:nth-child(2)"},"actions":[{"type":"open_link","candidate_id":"document.querySelector(\'a\')"}]}';
    const rejected = llm.parseNluPlanJson(unsafe, validIds);
    assert.strictEqual(rejected, null, 'CSS selectors or JS snippets in candidate_id must be rejected');
  });

  await runSuite('B1. Memory Candidate Registry, Channel Contrast, Coreference & Task Separation', async () => {
    const mem = new SleepwalkerMemory({ tabId: 'tab_42' });
    mem.state.activities = [
      { id: 'a1', user_command: 'Find visa requirements for China', intent: 'OFF_PAGE_RESEARCH', topic: 'China', entities: ['China'], result: 'China tourist visa required', timestamp: new Date().toISOString(), related_task_id: 'task_china' }
    ];
    mem.state.activeTask = { id: 'task_china', topic: 'China', objective: 'Travel visa for China' };

    const sep = mem.retrieveRelevantMemories('How do I learn Chinese programming syntax tutorial?', { topK: 3 });
    assert.ok(!sep[0] || sep[0].score < 0.45, `Cross-domain China visa vs Chinese programming leaked score=${sep[0] && sep[0].score}`);

    mem.registerCandidateList('youtube_videos', [
      { id: 'video_1', title: 'Python in 100 Seconds', channel: 'Fireship', duration: '4:10', durationSeconds: 250, url: '/v1' },
      { id: 'video_2', title: 'Python Full Beginner Tutorial', channel: 'FreeCodeCamp', duration: '24:30', durationSeconds: 1470, url: '/v2' }
    ], { urlClean: 'http://127.0.0.1/yt-search' });
    mem.recordSelection({ id: 'video_1', title: 'Python in 100 Seconds', channel: 'Fireship', entityType: 'video', url: '/v1' });

    const rSecond = mem.resolveContextualReferences('Open the second one', { url: 'http://127.0.0.1/yt-search' });
    assert.ok(rSecond.resolvedCandidate && rSecond.resolvedCandidate.id === 'video_2', 'Ordinal "second one" must pick video_2');

    const rOtherChan = mem.resolveContextualReferences('No, I meant the one from the other channel', { url: 'http://127.0.0.1/yt-search' });
    assert.ok(rOtherChan.resolvedCandidate && rOtherChan.resolvedCandidate.channel === 'FreeCodeCamp', 'Channel contrast must pick FreeCodeCamp');

    const rSameChan = mem.resolveContextualReferences('Play another video from the same channel', { url: 'http://127.0.0.1/yt-search' });
    assert.strictEqual(rSameChan.resolvedChannel, 'Fireship');

    const rShorter = mem.resolveContextualReferences('Open the shorter video', { url: 'http://127.0.0.1/yt-search' });
    assert.ok(rShorter.resolvedCandidate && rShorter.resolvedCandidate.id === 'video_1');
  });

  await runSuite('C1 + E1. Scoped Section Matching ("Bank card under Cards") & Official Docs Ranking', async () => {
    const bankTargets = [
      { id: 1, element: {}, label: 'Bank card', href: 'https://example.org/wiki/Bank_card_banking', contextHeading: 'Banking', sectionPath: ['Payment card', 'Banking'], sectionPathText: 'Payment card > Banking', category: 'article', flags: { inMain: true, inViewport: true } },
      { id: 2, element: {}, label: 'Bank card', href: 'https://example.org/wiki/Bank_card_cards', contextHeading: 'Cards', sectionPath: ['Payment card', 'Cards'], sectionPathText: 'Payment card > Cards', listContext: 'Card categories', category: 'article', flags: { inMain: true, inViewport: true } }
    ];
    const decCards = match.decideMatch(bankTargets, { action: 'CLICK', target: 'select Bank card under Cards' });
    assert.strictEqual(decCards.outcome, 'act', 'Section-scoped "Bank card under Cards" must resolve unambiguously');
    assert.strictEqual(decCards.best.target.id, 2);

    const decBanking = match.decideMatch(bankTargets, { action: 'CLICK', target: 'Bank card', section: 'Banking' });
    assert.strictEqual(decBanking.outcome, 'act');
    assert.strictEqual(decBanking.best.target.id, 1);

    const docTargets = [
      { id: 10, element: {}, label: 'PyTorch Tutorial Blog', domain: 'example.medium.com', href: 'https://example.medium.com/pytorch', hrefWords: 'pytorch', category: 'tutorial', flags: { official: false, inMain: true, inViewport: true } },
      { id: 11, element: {}, label: 'PyTorch Documentation', domain: 'docs.pytorch.org', href: 'https://docs.pytorch.org/docs/stable/index.html', hrefWords: 'pytorch docs stable index', category: 'documentation', flags: { official: true, inMain: true, inViewport: true } }
    ];
    const decOfficial = match.decideMatch(docTargets, { action: 'CLICK', target: 'official PyTorch docs' });
    assert.strictEqual(decOfficial.outcome, 'act', 'Official PyTorch docs must decisively beat unofficial blog');
    assert.strictEqual(decOfficial.best.target.id, 11);
  });

  await runSuite('D1. YouTube Transcript Timestamp Slicing & Grounded Topic Grouping', async () => {
    const segs = [
      { startSec: 0, timestamp: '0:00', text: 'Intro and setup.' },
      { startSec: 120, timestamp: '2:00', text: 'Variables and loops.' },
      { startSec: 280, timestamp: '4:40', text: 'Functions basics.' },
      { startSec: 450, timestamp: '7:30', text: 'Advanced metaclasses.' }
    ];
    const sliced = digest.sliceAndGroupTranscript(segs, { maxMinutes: 5 });
    assert.strictEqual(sliced.segments.length, 3, 'Only segments <= 5 minutes must be included');
    assert.ok(!sliced.combinedText.includes('metaclasses'), 'Content past 5 minutes must be excluded');
    assert.ok(sliced.topics.length >= 1 && sliced.topics[0].title.includes('0:00'));
  });

  await runSuite('F1. Offline Ollama Fallback + G1. WebSocket/Streaming Modules Intact', async () => {
    llm.resetLlmStateForTests();
    const offlineNlu = await llm.handleNluPlanRequest({
      utterance: 'Open the second video',
      ollamaUrl: 'http://127.0.0.1:19999',
      ollamaModel: 'llama3.2:3b',
      skipCache: true
    });
    assert.strictEqual(offlineNlu.status, 'ollama_unavailable', 'Offline NLU must report unavailability cleanly without crashing');
    assert.strictEqual(typeof geminiLive.SleepwalkerGeminiLiveSession, 'function');
    assert.strictEqual(typeof aiComm.SleepwalkerAiCommManager, 'function');
    assert.strictEqual(typeof aiComm.IncrementalExplainStreamParser, 'function');
  });

  await runSuite('A2 + F2. Live Local Ollama (llama3.2:3b + nomic-embed-text) NLU & Embedding Verification', async () => {
    const status = await llm.verifyOllamaAndEmbedStatus();
    if (status.ollama.state !== 'connected') {
      throw new Error(`Expected live Ollama llama3.2:3b online; got ${status.ollama.detail}`);
    }
    const pageCtx = {
      title: 'Payment card - Wikipedia',
      pageType: 'wikipedia',
      pageTextHash: 'test_hash_p42',
      links: [
        { id: 'link_1', label: 'Bank card', section: 'Banking', sectionPathText: 'Banking', official: false },
        { id: 'link_2', label: 'Bank card', section: 'Cards', sectionPathText: 'Cards', official: false },
        { id: 'link_3', label: 'PyTorch Documentation', section: 'Resources', sectionPathText: 'Resources', domain: 'docs.pytorch.org', official: true },
        { id: 'link_4', label: 'PyTorch Tutorial Blog', section: 'Resources', sectionPathText: 'Resources', domain: 'medium.com', official: false }
      ],
      tables: [{ id: 'table_1', section: 'Protocols', headers: ['Protocol', 'Port', 'Layer'], rows: [{ rowIndex: 1, rowSummary: 'Protocol: TCP, Port: 80/443, Layer: Transport' }] }]
    };

    const resWiki = await llm.handleNluPlanRequest({
      utterance: 'Can you open Bank card under Cards please?',
      pageContext: pageCtx,
      structuredDigestText: digest.formatStructuredContextForNlu(pageCtx, { maxTokens: 650 }),
      skipCache: true
    });
    assert.strictEqual(resWiki.status, 'ok', `Live Ollama NLU failed: ${JSON.stringify(resWiki)}`);
    assert.strictEqual(resWiki.plan.intent, 'open_link');
    assert.ok(/cards/i.test(resWiki.plan.context.section || resWiki.plan.actions?.[0]?.section || '') || resWiki.plan.context.candidate_id === 'link_2');

    const resDocs = await llm.handleNluPlanRequest({
      utterance: 'Click the official PyTorch docs link',
      pageContext: pageCtx,
      structuredDigestText: digest.formatStructuredContextForNlu(pageCtx, { maxTokens: 650 }),
      skipCache: true
    });
    assert.strictEqual(resDocs.status, 'ok');
    assert.strictEqual(resDocs.plan.intent, 'open_link');

    const embRes = await llm.handleEmbedRequest({ text: 'TCP protocol on port 443' });
    assert.strictEqual(embRes.status, 'ok', `Expected nomic-embed-text online; got ${JSON.stringify(embRes)}`);
    assert.ok(Array.isArray(embRes.embedding) && embRes.embedding.length > 64);
  });

  // ---------------- TIER 2: REAL CHROME MV3 EXTENSION E2E + UI COMMAND BAR NON-OVERLAP ----------------
  const chromiumExe = findChromiumExe();
  assert.ok(chromiumExe, 'Chromium executable must exist for Tier 2 real MV3 E2E');
  const { server, port } = await startFixtureServer();

  await runSuite('H1 + I1 + C2 + D2 + E2. Real MV3 Chrome E2E: Wikipedia, YouTube Captions/NoCaptions, Player Control & Command Bar Layering', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-p42-ext-'));
    const cdpPort = 9610 + Math.floor(Math.random() * 250);

    const chrome = spawn(chromiumExe, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--headless=new',
      '--no-sandbox',
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check',
      `http://127.0.0.1:${port}/wiki`
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
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++cid;
        const onMsg = async (ev) => {
          const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
          const msg = JSON.parse(raw);
          if (msg.id === id) {
            ws.removeEventListener('message', onMsg);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });
      const evalJs = async (body) => {
        const res = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
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
                const mf = await probe.evalJs(`return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : '';`).catch(() => '');
                try { probe.ws.close(); } catch (_e) {}
                if (String(mf).includes('Sleepwalker')) { swTarget = cand; break; }
              } catch (_e) {}
            }
          }
        } catch (_e) {}
      }
      assert.ok(pageTarget && swTarget, 'Real MV3 SW and /wiki page must attach cleanly');

      const pageCdp = await connectTarget(pageTarget, 'page');
      const swCdp = await connectTarget(swTarget, 'sw');
      sockets.push(pageCdp.ws, swCdp.ws);
      await pageCdp.send('Runtime.enable').catch(() => {});
      await swCdp.send('Runtime.enable').catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));

      const waitForUiHost = async (maxWaitMs = 8000) => {
        const tEnd = Date.now() + maxWaitMs;
        while (Date.now() < tEnd) {
          const ok = await pageCdp.evalJs(`return Boolean(document.getElementById('sleepwalker-ui-host')?.shadowRoot);`).catch(() => false);
          if (ok) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error(`#sleepwalker-ui-host never mounted on ${await pageCdp.evalJs('return location.href').catch(() => '?')}; pageEx=${JSON.stringify(pageCdp.exceptions)} swEx=${JSON.stringify(swCdp.exceptions)}`);
      };

      const wakeSleepwalker = async () => {
        await waitForUiHost(8000);
        await pageCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
        await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
        await new Promise((r) => setTimeout(r, 450));
      };

      const runCmdAndSnap = async (cmd, waitMs = 42000) => {
        const beforeSig = await pageCdp.evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host')?.shadowRoot;
          return sr ? ((sr.getElementById('sw-card-title')?.textContent || '') + '||' + (sr.getElementById('sw-card-body')?.textContent || '')) : '';
        `);
        await pageCdp.evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
          const form = sr.getElementById('sw-ui-type-form');
          const btn = sr.getElementById('sw-ui-type-btn');
          const inp = sr.getElementById('sw-ui-type-input');
          const sub = sr.querySelector('.sw-type-submit');
          if (form && form.hidden && btn) btn.click();
          inp.focus();
          inp.value = ${JSON.stringify(cmd)};
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          sub.click();
        `);
        const tEnd = Date.now() + waitMs;
        let snap = null;
        while (Date.now() < tEnd) {
          await new Promise((r) => setTimeout(r, 160));
          snap = await pageCdp.evalJs(`
            const sr = document.getElementById('sleepwalker-ui-host')?.shadowRoot;
            if (!sr) return null;
            const root = sr.querySelector('.sw-ui-root');
            const card = sr.getElementById('sw-ui-card');
            const form = sr.getElementById('sw-ui-type-form');
            const inp = sr.getElementById('sw-ui-type-input');
            const btn = sr.getElementById('sw-ui-type-btn');
            const cardRect = card && !card.hidden ? card.getBoundingClientRect() : null;
            const formRect = form && !form.hidden ? form.getBoundingClientRect() : null;
            const btnRect = btn ? btn.getBoundingClientRect() : null;
            return {
              url: window.location.pathname,
              state: root ? root.dataset.state : '',
              active: root ? root.dataset.active : '',
              formHidden: form ? form.hidden : true,
              cardVisible: Boolean(card && !card.hidden),
              streamStatus: card ? (card.dataset.streamStatus || '') : '',
              cardTitle: sr.getElementById('sw-card-title')?.textContent || '',
              cardBody: sr.getElementById('sw-card-body')?.textContent || '',
              cardBottom: cardRect ? Math.round(cardRect.bottom) : null,
              cardTop: cardRect ? Math.round(cardRect.top) : null,
              formTop: formRect ? Math.round(formRect.top) : null,
              btnTop: btnRect ? Math.round(btnRect.top) : null,
              inpFocusedOk: Boolean(inp && !form?.hidden)
            };
          `).catch(() => ({ url: 'navigated' }));
          if (snap && snap.url === 'navigated') break;
          const curSig = snap ? `${snap.cardTitle}||${snap.cardBody}` : '';
          const busy = snap && (
            snap.state === 'thinking'
            || snap.streamStatus === 'thinking'
            || snap.streamStatus === 'streaming'
            || /^(?:Highlighting|Finding answer|Analyzing|Preparing|Explaining|Summarizing)\b/i.test(snap.cardBody || '')
            || /\.\.\.$/.test((snap.cardBody || '').trim())
          );
          if (snap && !busy && curSig && curSig !== beforeSig) break;
        }
        return snap;
      };

      // 1. /wiki checks: wake, open type bar, find TCP in table, verify non-overlapping command bar!
      await wakeSleepwalker();
      const sTable = await runCmdAndSnap('Find TCP entry in the table');
      assert.ok(sTable && sTable.cardBody.includes('80 / 443'), `Expected TCP row in card; got: ${JSON.stringify(sTable)}`);
      assert.strictEqual(sTable.formHidden, false, 'Command bar must stay open & accessible after submission');
      assert.ok(sTable.cardBottom <= sTable.formTop, `Command bar overlapped! cardBottom=${sTable.cardBottom} > formTop=${sTable.formTop}`);

      // Verify user can type a SECOND command WHILE response card is open & even on narrow viewport!
      const sPara = await runCmdAndSnap('Explain the paragraph below Transport layer');
      assert.ok(sPara && /443|8443|ordered|TCP/i.test(sPara.cardBody), `Expected Transport layer paragraph explanation; got: ${sPara && sPara.cardBody}`);
      assert.ok(sPara.cardBottom <= sPara.formTop, `Card overlapped command bar on second open card: ${sPara.cardBottom} vs ${sPara.formTop}`);

      // Expand card (if overflow) & test narrow viewport clearance
      await pageCdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 600, deviceScaleFactor: 1, mobile: false });
      await new Promise((r) => setTimeout(r, 250));
      const narrowCheck = await pageCdp.evalJs(`
        const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
        const card = sr.getElementById('sw-ui-card');
        const form = sr.getElementById('sw-ui-type-form');
        const inp = sr.getElementById('sw-ui-type-input');
        const cr = card.getBoundingClientRect();
        const fr = form.getBoundingClientRect();
        inp.focus();
        const rootEl = sr.querySelector('.sw-ui-root');
        return {
          state: rootEl ? rootEl.dataset.state : '',
          active: rootEl ? rootEl.dataset.active : '',
          rootVis: rootEl ? getComputedStyle(rootEl).visibility : '',
          cardBottom: Math.round(cr.bottom),
          formTop: Math.round(fr.top),
          fr: { l: Math.round(fr.left), t: Math.round(fr.top), w: Math.round(fr.width), h: Math.round(fr.height) },
          formHidden: Boolean(form.hidden),
          inpDisabled: Boolean(inp.disabled),
          docFocus: document.hasFocus(),
          activeId: sr.activeElement ? sr.activeElement.id : '',
          hitTag: sr.elementFromPoint(Math.round(fr.left + fr.width / 2), Math.round(fr.top + fr.height / 2))?.tagName || '',
          hitId: sr.elementFromPoint(Math.round(fr.left + fr.width / 2), Math.round(fr.top + fr.height / 2))?.id || ''
        };
      `);
      assert.ok(narrowCheck.cardBottom <= narrowCheck.formTop, `Narrow viewport overlap: ${JSON.stringify(narrowCheck)}`);
      assert.strictEqual(narrowCheck.activeId, 'sw-ui-type-input', `Command bar input must be focusable while card is open: ${JSON.stringify(narrowCheck)}`);
      await pageCdp.send('Emulation.clearDeviceMetricsOverride');

      // Test expanded overflowing card STILL leaves command bar uncovered & clickable by hit-test!
      const expCheck = await pageCdp.evalJs(`
        const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
        const body = sr.getElementById('sw-card-body');
        if (body) body.textContent = Array.from({ length: 45 }, (_, i) => 'Detailed explanation paragraph line ' + (i + 1) + ' explaining web protocol layers cleanly.').join(' ');
        const card = sr.getElementById('sw-ui-card');
        if (card) card.classList.add('sw-expanded');
        if (window.SW_UI && window.SW_UI._orb) window.SW_UI._orb.syncLayout();
        const form = sr.getElementById('sw-ui-type-form');
        const cr = card.getBoundingClientRect();
        const fr = form.getBoundingClientRect();
        const hitEl = sr.elementFromPoint(Math.round(fr.left + fr.width / 2), Math.round(fr.top + fr.height / 2));
        return {
          cardBottom: Math.round(cr.bottom),
          formTop: Math.round(fr.top),
          hitInsideForm: Boolean(hitEl && (hitEl === form || form.contains(hitEl)))
        };
      `);
      assert.ok(expCheck.cardBottom <= expCheck.formTop, `Expanded card overlapped command bar: ${JSON.stringify(expCheck)}`);
      assert.strictEqual(expCheck.hitInsideForm, true, `Hit-test at command bar landed outside form: ${JSON.stringify(expCheck)}`);

      // Test Wikipedia nested subsection navigation: "Scroll to the second subsection under Applications" -> "Online gateways"
      const sSub = await runCmdAndSnap('Scroll to the second subsection under Applications');
      assert.ok(sSub && /Online gateways/i.test(`${sSub.cardTitle} ${sSub.cardBody}`), `Expected second subsection "Online gateways"; got: ${JSON.stringify(sSub)}`);

      // Test Official vs Tutorial Docs Disambiguation on /wiki ("Click the official PyTorch docs link" -> confirm/open docs.pytorch.org)
      const sDocs = await runCmdAndSnap('Click the official PyTorch docs link');
      assert.ok(sDocs && /PyTorch Documentation/i.test(`${sDocs.cardTitle} ${sDocs.cardBody}`), `Expected official PyTorch Documentation match; got: ${JSON.stringify(sDocs)}`);
      await runCmdAndSnap('no');

      // Test scoped Wikipedia selection: "Select Bank card under Cards" must open /wiki/Bank_card_cards (NOT Bank_card_banking!)
      const sBankCards = await runCmdAndSnap('Select Bank card under Cards');
      await new Promise((r) => setTimeout(r, 1500));
      const wikiPathAfterBank = await pageCdp.evalJs(`return window.location.pathname;`);
      assert.strictEqual(wikiPathAfterBank, '/wiki/Bank_card_cards', `Expected /wiki/Bank_card_cards; got ${wikiPathAfterBank} (${JSON.stringify(sBankCards)})`);

      // Navigate to /yt-search and test YouTube discovery + channel selection -> /yt-watch-captions
      await pageCdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/yt-search` });
      await new Promise((r) => setTimeout(r, 1300));
      await wakeSleepwalker();

      const sYtPick = await runCmdAndSnap('Open the beginner video from FreeCodeCamp');
      await new Promise((r) => setTimeout(r, 1500));
      const ytNavPath = await pageCdp.evalJs(`return window.location.pathname;`);
      assert.strictEqual(ytNavPath, '/yt-watch-captions', `Expected navigation to /yt-watch-captions from FreeCodeCamp pick; got ${ytNavPath} (${JSON.stringify(sYtPick)})`);

      // On /yt-watch-captions, test transcript slice + real video pause/play verification
      await wakeSleepwalker();

      const sYtExp = await runCmdAndSnap('Explain the first five minutes');
      assert.ok(sYtExp && /variable|loop|install|python|0:00|3:30/i.test(sYtExp.cardBody), `Expected grounded first-5-min explanation; got: ${sYtExp && sYtExp.cardBody}`);
      assert.ok(!/metaclass/i.test(sYtExp.cardBody), 'Should not include minute-7 metaclass segment in first 5 minutes');

      const sPause = await runCmdAndSnap('Pause the video');
      const vidPaused = await pageCdp.evalJs(`return Boolean(document.querySelector('video')?.paused);`);
      assert.strictEqual(vidPaused, true, `Expected real <video>.paused === true after pause command; snap=${JSON.stringify(sPause)}`);

      // 3. Navigate to /yt-watch-nocaptions and verify honest unavailable message (no fabrication!)
      await pageCdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/yt-watch-nocaptions` });
      await new Promise((r) => setTimeout(r, 1200));
      await wakeSleepwalker();

      const sNoCap = await runCmdAndSnap('What is the speaker teaching?');
      assert.ok(sNoCap && /caption|transcript|not available|aren't available|cannot verify/i.test(sNoCap.cardBody), `Expected honest missing-caption disclosure; got: ${JSON.stringify(sNoCap)}`);
    } finally {
      sockets.forEach((ws) => { try { ws.close(); } catch (_e) {} });
      try { chrome.kill('SIGKILL'); } catch (_e) {}
      await new Promise((r) => setTimeout(r, 400));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  server.close();
  global.chrome = prevChrome;
  console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
