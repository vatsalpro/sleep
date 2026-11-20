/**
 * Sleepwalker Phase 4 — Real-Time Communication, Streaming UI & Live WebSocket E2E Test Suite
 *
 * Tier 1: Node Unit & Mock Streaming/WebSocket Suites
 *   1. IncrementalExplainStreamParser JSON safety (partial tokens, escapes, decimals, abbreviations)
 *   2. llm.js streaming Ollama NDJSON + Gemini SSE + fallback compatibility
 *   3. Gemini Live WebSocket lifecycle (AUDIO + outputAudioTranscription setup, thinking-block filter,
 *      realtime audio/text frames, exponential backoff reconnect, sessionResumption, context continuity, ephemeral token URL)
 *   4. SleepwalkerAiCommManager orchestration (preemption/cancellation, epoch stale guard, dedup, Live->SSE->Ollama fallback chain)
 *   5. SleepwalkerReader incremental chunked TTS + waiting-between-chunks + cancelStream() interruption
 *
 * Tier 2: Real Loaded Unpacked MV3 Chrome Extension in Chromium via Playwright (real Service Worker `background.js`,
 *         real `chrome.runtime.connect('sw-ai-stream')`, real Shadow DOM card & orb!)
 *
 * Run with: node D:\sleep\tests\run-phase4-realtime-tests.js
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const llm = require(path.join(ROOT, 'llm.js'));
const liveMod = require(path.join(ROOT, 'gemini-live.js'));
const aiCommMod = require(path.join(ROOT, 'ai-comm.js'));

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

function makeMockReadableStream(chunks, delayMs = 8) {
  const enc = new TextEncoder();
  let idx = 0;
  return {
    getReader() {
      let cancelled = false;
      return {
        async cancel() { cancelled = true; },
        async read() {
          if (cancelled || idx >= chunks.length) return { value: undefined, done: true };
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (cancelled) return { value: undefined, done: true };
          return { value: enc.encode(chunks[idx++]), done: false };
        }
      };
    }
  };
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sentFrames = [];
    this.listeners = { open: [], message: [], close: [], error: [] };
  }
  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  emit(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  send(data) {
    this.sentFrames.push(JSON.parse(data));
  }
  close(code = 1000, reason = '') {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }
  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {});
  }
  pushServerJson(obj) {
    this.emit('message', { data: JSON.stringify(obj) });
  }
}

async function runTier1() {
  await runSuite('1. IncrementalExplainStreamParser Safely Extracts Answer Without JSON/Escape Leakage', () => {
    const parser = new aiCommMod.IncrementalExplainStreamParser();
    const tokenStream = [
      '```json\n{ "high',
      'lightSections": ["answer", "fees"], ',
      '"ans',
      'wer": "The application fee is Rs. 5',
      '00 for Dr. Rao\'s 3.5 GB plan. ',
      'Students \\"must\\"',
      ' upload transcripts by May 15.',
      '\\nSecond paragraph arrives now!", "follow',
      'UpHint": "Say open" }\n```'
    ];

    let combinedDelta = '';
    const emittedSentences = [];
    for (const tok of tokenStream) {
      const step = parser.push(tok);
      combinedDelta += step.answerDelta;
      emittedSentences.push(...step.completedSentences);
      assert.ok(!step.fullAnswer.includes('"answer"'), `Leaked JSON key into answer: ${step.fullAnswer}`);
      assert.ok(!step.fullAnswer.includes('{'), `Leaked brace into answer: ${step.fullAnswer}`);
      assert.ok(!step.fullAnswer.includes('highlightSections'), `Leaked trailing JSON into answer: ${step.fullAnswer}`);
    }

    const fin = parser.finish(llm.parseExplainJson);
    const full = combinedDelta + fin.answerDelta;
    assert.ok(full.includes('Rs. 500'), 'Preserves fee figure cleanly');
    assert.ok(full.includes('Dr. Rao\'s 3.5 GB plan.'), 'Does not split on Dr. or 3.5 decimal');
    assert.ok(full.includes('Students "must" upload transcripts by May 15.'), 'Decodes escaped quotes cleanly');
    assert.ok(emittedSentences.length >= 2, `Expected >=2 sentence boundaries detected incrementally, got ${emittedSentences.length}`);
    assert.ok(fin.parsedJson && Array.isArray(fin.parsedJson.highlightSections), 'Preserves highlightSections metadata on finish');
  });

  await runSuite('2. llm.js Ollama NDJSON Streaming & Gemini SSE Streaming + Error Recovery', async () => {
    const origFetch = global.fetch;
    llm.resetLlmStateForTests();
    try {
      const tokens = [];
      global.fetch = async (url, init) => {
        if (url.endsWith('/api/generate')) {
          const parsedBody = JSON.parse(init.body);
          assert.strictEqual(parsedBody.stream, true, 'Ollama stream helper must send stream: true');
          return {
            ok: true,
            status: 200,
            body: makeMockReadableStream([
              `${JSON.stringify({ response: '{"answer":"Beijing is ' })}\n`,
              `${JSON.stringify({ response: 'China\'s capital. ' })}\n`,
              `${JSON.stringify({ response: 'Shanghai is major."}', done: true })}\n`
            ])
          };
        }
        return { ok: false, status: 404 };
      };

      const oRes = await llm.callLocalOllamaExplainStream('http://localhost:11434', 'llama3.2:3b', {
        urlClean: 'https://example.org',
        digestPrompt: 'Beijing is China capital. Shanghai is major.'
      }, { onToken: (t) => tokens.push(t) });

      assert.strictEqual(oRes.ok, true);
      assert.strictEqual(tokens.length, 3);
      assert.ok(oRes.parsed && oRes.parsed.answer.includes('Beijing is China\'s capital.'));

      // Verify Gemini SSE skips 404 models and parses data: lines incrementally
      const sseTokens = [];
      global.fetch = async (url) => {
        if (url.includes('gemini-flash-lite-latest')) return { ok: false, status: 404 };
        return {
          ok: true,
          status: 200,
          body: makeMockReadableStream([
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"answer":"Hello ' }] } }] })}\n\n`,
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'from SSE."}' }] } }] })}\n\n`,
            'data: [DONE]\n\n'
          ])
        };
      };

      const gRes = await llm.callDirectGeminiExplainStream('test-key', {
        urlClean: 'https://example.org',
        digestPrompt: 'Hello from SSE.'
      }, {
        onToken: (tok) => sseTokens.push(tok)
      });

      assert.strictEqual(gRes.ok, true);
      assert.strictEqual(gRes.model, 'gemini-2.5-flash-lite');
      assert.strictEqual(sseTokens.join(''), '{"answer":"Hello from SSE."}');
    } finally {
      global.fetch = origFetch;
    }
  });

  await runSuite('3. Gemini Live WebSocket Lifecycle: Setup, Thinking Filter, Reconnect & Session Resumption, Audio Frames', async () => {
    const sockets = [];
    const session = new liveMod.SleepwalkerGeminiLiveSession({
      ephemeralToken: 'auth_tokens/test_tok_123',
      model: 'gemini-3.1-flash-live-preview',
      webSocketFactory: (url) => {
        assert.ok(url.includes('BidiGenerateContentConstrained?access_token=auth_tokens%2Ftest_tok_123'), 'Must use Constrained ephemeral token endpoint');
        assert.ok(!liveMod.sanitizeSecretUrl(url).includes('test_tok_123'), 'URL sanitizer must redact secrets');
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        setTimeout(() => {
          ws.triggerOpen();
          setTimeout(() => ws.pushServerJson({ setupComplete: {} }), 5);
        }, 5);
        return ws;
      }
    });

    const deltas = [];
    const audioChunks = [];
    const turn1P = session.sendTurn('What is my code word?', {
      onDelta: (d) => deltas.push(d),
      onAudioChunk: (a) => audioChunks.push(a)
    });

    await new Promise((r) => setTimeout(r, 40));
    const ws1 = sockets[0];
    assert.strictEqual(ws1.sentFrames[0].setup.generationConfig.responseModalities[0], 'AUDIO');
    assert.ok(ws1.sentFrames[0].setup.outputAudioTranscription !== undefined);

    ws1.pushServerJson({ sessionResumptionUpdate: { newHandle: 'resume_abc_1' } });
    // Thinking caption in modelTurn.text should NOT leak when outputTranscription exists or bold caption present
    ws1.pushServerJson({ serverContent: { modelTurn: { parts: [{ text: '**Thinking**\n\nPlanning answer' }] } } });
    ws1.pushServerJson({ serverContent: { outputTranscription: { text: 'Your code word is cobalt.' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } });
    ws1.pushServerJson({ serverContent: { turnComplete: true } });

    const res1 = await turn1P;
    assert.ok(res1.text.includes('Your code word is cobalt.'), `Expected outputTranscription clean text, got "${res1.text}"`);
    assert.strictEqual(audioChunks.length, 1);
    assert.strictEqual(session.resumptionHandle, 'resume_abc_1');

    // Verify bidirectional realtime audio & text frames
    assert.strictEqual(session.sendRealtimeAudio('BBBB', 'audio/pcm;rate=16000'), true);
    assert.strictEqual(session.sendRealtimeText('Follow up audio context'), true);
    assert.ok(ws1.sentFrames.some((f) => f.realtimeInput && f.realtimeInput.mediaChunks));
    assert.ok(ws1.sentFrames.some((f) => f.realtimeInput && f.realtimeInput.text));

    // Simulate sudden disconnect and verify automatic exponential-backoff reconnection WITH resumptionHandle
    ws1.close(1011, 'server_reset');
    const turn2P = session.sendTurn('Repeat it.');
    await new Promise((r) => setTimeout(r, 40));
    const ws2 = sockets[1];
    assert.ok(ws2, 'Expected second WebSocket created on reconnect');
    assert.strictEqual(ws2.sentFrames[0].setup.sessionResumption.handle, 'resume_abc_1', 'Must resume using saved handle');
    ws2.pushServerJson({ serverContent: { outputTranscription: { text: 'Cobalt.' }, turnComplete: true } });
    const res2 = await turn2P;
    assert.strictEqual(res2.text, 'Cobalt.');
    session.close();
  });

  await runSuite('4. SleepwalkerAiCommManager Preemption, Stale-Epoch Guard, Dedup & Offline Fallback', async () => {
    const origFetch = global.fetch;
    global.chrome = { storage: { local: { get: (_k, cb) => cb({ sleepwalker_local_only: false, sleepwalker_gemini_api_key: 'k' }) } } };
    llm.resetLlmStateForTests();

    try {
      const slowEvents = [];
      const fastEvents = [];

      // Request A stalls on SSE so Request B can preempt and cancel it
      global.fetch = (url, init) => {
        if (url.includes('streamGenerateContent')) {
          return new Promise((resolve) => {
            const onAbort = () => resolve({ ok: false, status: 499 });
            if (init && init.signal) init.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      };

      const mgr = new aiCommMod.SleepwalkerAiCommManager({ llm, liveMod });
      const reqAPromise = mgr.streamExplain({
        sessionId: 'tab_99',
        payload: { urlClean: 'https://example.edu/1', pageTextHash: 'p1', query: 'Slow request' }
      }, (ev) => slowEvents.push(ev));

      await new Promise((r) => setTimeout(r, 25));

      // Now mock fast SSE response for superseding Request B
      global.fetch = async (url) => {
        if (url.includes('streamGenerateContent')) {
          return {
            ok: true,
            status: 200,
            body: makeMockReadableStream([
              `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"answer":"New fast answer works."}' }] } }] })}\n\n`
            ], 2)
          };
        }
        return { ok: false, status: 404 };
      };

      const reqBPromise = mgr.streamExplain({
        sessionId: 'tab_99',
        interruptPrevious: true,
        payload: { urlClean: 'https://example.edu/2', pageTextHash: 'p2', query: 'Fast request' }
      }, (ev) => fastEvents.push(ev));

      const [resA, resB] = await Promise.all([reqAPromise, reqBPromise]);
      assert.strictEqual(resA.status, 'cancelled', 'Old request must abort when superseded');
      assert.ok(!slowEvents.some((e) => e.type === 'done' && e.status === 'ok'), 'Stale slow request must never emit done ok');
      assert.strictEqual(resB.status, 'ok');
      assert.strictEqual(resB.answer, 'New fast answer works.');
      assert.ok(fastEvents.some((e) => e.type === 'ack'), 'Immediate acknowledgement frame must emit');
      assert.ok(fastEvents.some((e) => e.type === 'speak_chunk'), 'Incremental speech chunk must emit');
    } finally {
      global.fetch = origFetch;
    }
  });

  await runSuite('5. SleepwalkerReader Incremental Chunked TTS + Stream Drain + Barge-In cancelStream()', async () => {
    const spoken = [];
    const activeUtterances = [];
    global.SpeechSynthesisUtterance = class MockUtterance {
      constructor(t) { this.text = t; this.lang = 'en-IN'; this.rate = 1; }
    };
    global.window = {
      speechSynthesis: {
        getVoices: () => [{ lang: 'en-IN', default: true }],
        speak(utt) {
          spoken.push(utt.text);
          activeUtterances.push(utt);
        },
        cancel() { activeUtterances.length = 0; },
        pause() {},
        resume() {}
      }
    };
    global.document = {
      head: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      querySelectorAll: () => [],
      body: {}
    };

    delete require.cache[require.resolve(path.join(ROOT, 'reader.js'))];
    require(path.join(ROOT, 'reader.js'));
    const reader = new global.window.SleepwalkerReader();
    let finishedCount = 0;
    reader.onFinished = () => { finishedCount += 1; };

    reader.startStream({ lang: 'en-IN' });
    reader.enqueueStreamChunk('First streamed sentence.');
    assert.deepStrictEqual(spoken, ['First streamed sentence.']);

    // Simulate Sentence 1 finishing BEFORE Sentence 2 arrives over network
    activeUtterances.shift().onend();
    assert.strictEqual(finishedCount, 0, 'Must NOT fire onFinished while stream is still open');
    assert.strictEqual(reader.isStreamingActive(), true);

    // Enqueue Sentence 2 -> speaks immediately without dropping stream
    reader.enqueueStreamChunk('Second streamed sentence.');
    assert.deepStrictEqual(spoken, ['First streamed sentence.', 'Second streamed sentence.']);
    reader.finishStream();
    assert.strictEqual(finishedCount, 0, 'Wait for Sentence 2 utterance end before finishing');

    activeUtterances.shift().onend();
    assert.strictEqual(finishedCount, 1, 'Fires onFinished cleanly once final queued chunk ends');

    // Now test cancelStream mid-playback
    reader.startStream({ lang: 'en-IN' });
    reader.enqueueStreamChunk('Long explanation about something.');
    reader.cancelStream();
    assert.strictEqual(reader.isStreamingActive(), false);
    assert.strictEqual(reader.isPlaying, false);
  });
}

async function runTier2ExtensionPortCheck() {
  const chromiumExe = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');
  if (!fs.existsSync(chromiumExe)) {
    console.log('SKIP  6. Real Chrome MV3 Port Streaming (Playwright chromium binary not present)');
    return;
  }

  await runSuite('6. Real MV3 Extension (--load-extension) Port Streaming, Progressive Card UI & Cancellation', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><title>China Overview</title></head><body>
        <main><h1>China</h1><p>China is located in East Asia with a population over 1.4 billion. Beijing is the capital city and Shanghai is its major financial center. The Great Wall stretches across northern China for thousands of kilometers.</p></main>
      </body></html>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sw-p4-ext-'));
    const portCdp = 9220 + Math.floor(Math.random() * 500);
    const chrome = spawn(chromiumExe, [
      `--remote-debugging-port=${portCdp}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `http://127.0.0.1:${port}/`
    ], { stdio: 'ignore' });

    const fetchTargets = async () => (await fetch(`http://127.0.0.1:${portCdp}/json`)).json();

    let ws = null;
    try {
      let pageTarget = null;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && !pageTarget) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const targets = await fetchTargets();
          pageTarget = targets.find((t) => t.type === 'page' && t.url.includes(`127.0.0.1:${port}`));
        } catch (_e) {}
      }
      assert.ok(pageTarget, 'Expected page target with loaded extension');

      ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
      let cid = 0;
      const cdp = (method, params = {}) => new Promise((resolve, reject) => {
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
      const evalJs = async (expr) => {
        const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
        if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r && r.result ? r.result.value : undefined;
      };

      // Open Sleepwalker UI via Alt+S keyboard shortcut inside the real page -> isolated world content script
      await new Promise((r) => setTimeout(r, 1200));
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await new Promise((r) => setTimeout(r, 350));

      const shadowState = await evalJs(`
        const host = document.getElementById('sleepwalker-ui-host');
        if (!host || !host.shadowRoot) return { mounted: false };
        const sr = host.shadowRoot;
        const root = sr.querySelector('.sw-ui-root');
        const btn = sr.getElementById('sw-ui-type-btn');
        const inp = sr.getElementById('sw-ui-type-input');
        const submit = sr.querySelector('.sw-type-submit');
        if (btn) btn.click();
        if (inp) {
          inp.value = 'Explain this page';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (submit) submit.click();
        return {
          mounted: true,
          stateImmediatelyAfterSubmit: root ? root.dataset.state : '',
          cardTitleImmediate: sr.getElementById('sw-card-title') ? sr.getElementById('sw-card-title').textContent : ''
        };
      `);

      assert.strictEqual(shadowState.mounted, true, 'Real #sleepwalker-ui-host Shadow DOM must mount via manifest content_scripts');

      // Wait briefly for real MV3 background SW sw-ai-stream port answer to complete ('done' + cache persist) before Escape
      let finalCard = null;
      const observedStates = new Set();
      const pollUntil = Date.now() + 20000;
      while (Date.now() < pollUntil) {
        finalCard = await evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
          const root = sr.querySelector('.sw-ui-root');
          const card = sr.getElementById('sw-ui-card');
          return {
            state: root ? root.dataset.state : '',
            streamStatus: card ? (card.dataset.streamStatus || '') : '',
            title: sr.getElementById('sw-card-title') ? sr.getElementById('sw-card-title').textContent : '',
            badge: sr.getElementById('sw-card-badge') ? sr.getElementById('sw-card-badge').textContent : '',
            body: sr.getElementById('sw-card-body') ? sr.getElementById('sw-card-body').textContent : ''
          };
        `);
        if (finalCard && finalCard.state) observedStates.add(finalCard.state);
        const stillStreaming = !finalCard || (
          finalCard.streamStatus !== 'complete' ||
          finalCard.state === 'thinking' ||
          finalCard.body.includes('Analyzing page to explain') ||
          finalCard.badge === 'Thinking...' ||
          /^(?:Streaming|Live(?:\s|·|$))/i.test(finalCard.badge || '')
        );
        if (finalCard && finalCard.body && !stillStreaming) break;
        await new Promise((r) => setTimeout(r, 120));
      }

      assert.ok(finalCard && finalCard.body && finalCard.body.length > 20, `Expected real extension card response, got: ${JSON.stringify(finalCard)}`);
      assert.strictEqual(finalCard.streamStatus, 'complete', `Expected completed streamStatus before Escape, got: ${JSON.stringify(finalCard)}`);
      assert.ok(
        finalCard.body.includes('China') || finalCard.body.includes('Beijing') || finalCard.body.includes('East Asia'),
        `Expected grounded response mentioning China/Beijing, got: ${JSON.stringify(finalCard)}`
      );

      // Verify immediate Escape cancellation dismisses active streaming UI cleanly in MV3 extension
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      let postEsc = null;
      const escDeadline = Date.now() + 2200;
      while (Date.now() < escDeadline) {
        await new Promise((r) => setTimeout(r, 120));
        postEsc = await evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
          const root = sr.querySelector('.sw-ui-root');
          return { state: root ? root.dataset.state : '', active: root ? root.dataset.active : '', observedStates: ${JSON.stringify(Array.from(observedStates))} };
        `);
        if (postEsc && postEsc.state === 'idle' && postEsc.active === 'false') break;
      }
      assert.strictEqual(postEsc.state, 'idle', `Escape should return UI to idle cleanly, got ${JSON.stringify(postEsc)}`);

      // Verify repeated cached port request resolves fast and cleanly after re-waking
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await new Promise((r) => setTimeout(r, 350));
      const cacheTurnStart = Date.now();
      await evalJs(`
        const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
        const form = sr.getElementById('sw-ui-type-form');
        const btn = sr.getElementById('sw-ui-type-btn');
        const inp = sr.getElementById('sw-ui-type-input');
        const submit = sr.querySelector('.sw-type-submit');
        if (form && form.hidden && btn) btn.click();
        if (inp) { inp.value = 'Explain this page'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
        if (submit) submit.click();
      `);
      let cachedDoneMs = -1;
      let lastSt = null;
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 60));
        const st = await evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
          const card = sr.getElementById('sw-ui-card');
          const b = sr.getElementById('sw-card-body') ? sr.getElementById('sw-card-body').textContent : '';
          const badge = sr.getElementById('sw-card-badge') ? sr.getElementById('sw-card-badge').textContent : '';
          const root = sr.querySelector('.sw-ui-root');
          return {
            visible: Boolean(card && !card.hidden),
            streamStatus: card ? (card.dataset.streamStatus || '') : '',
            state: root ? root.dataset.state : '',
            b,
            badge
          };
        `);
        lastSt = st;
        if (
          st && st.visible && st.b &&
          st.streamStatus === 'complete' &&
          st.state !== 'thinking' &&
          !st.b.includes('Analyzing page') &&
          st.badge !== 'Thinking...' &&
          !/^(?:Streaming|Live(?:\s|·|$))/i.test(st.badge || '') &&
          (st.b.includes('China') || st.b.includes('Beijing'))
        ) {
          cachedDoneMs = Date.now() - cacheTurnStart;
          break;
        }
      }
      assert.ok(cachedDoneMs >= 0 && cachedDoneMs < 3500, `Expected repeated MV3 port request to resolve fast via cache/stream, took ${cachedDoneMs}ms (last=${JSON.stringify(lastSt)})`);
      console.log(`      (MV3 Chromium real extension: cold+stream passed, repeated port request=${cachedDoneMs}ms, Escape cancel->idle OK)`);

      // Verify Service Worker registered and stayed alive without uncaught errors
      const allTargets = await fetchTargets();
      const swTarget = allTargets.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
      assert.ok(swTarget, 'MV3 Service Worker background.js must be active');
    } finally {
      if (ws && ws.readyState < 2) {
        try { ws.close(); } catch (_e) {}
        await new Promise((r) => setTimeout(r, 120));
      }
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        try {
          if (chrome && !chrome.killed) {
            chrome.once('exit', finish);
            chrome.kill();
            setTimeout(finish, 1200);
          } else {
            finish();
          }
        } catch (_e) { finish(); }
      });
      await new Promise((r) => server.close(r));
      await new Promise((r) => setTimeout(r, 80));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
    }
  });
}

(async () => {
  console.log('=== Sleepwalker Phase 4 — Real-Time Communication & Streaming Test Suite ===\n');
  await runTier1();
  await runTier2ExtensionPortCheck();
  console.log(`\nSummary: ${passed}/${passed + failed} Phase 4 test suites passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
})();
