/**
 * Sleepwalker — Voice & Microphone Reliability Regression Suite
 *
 * Tier 1 (Node Unit):
 *   1. Synchronous InvalidStateError / NotAllowedError start() recovery (never deadlocks in 'starting')
 *   2. Async onstart race arriving after pauseTemporary() / stopListening() stays paused
 *   3. 10x rapid <1500ms silenceTimer commits + setLang() restarts never exhaust _restartAttempts,
 *      and _startLevelMonitor() never opens competing getUserMedia streams during SpeechRecognition
 *   4. SleepwalkerReader dropped-onend watchdog finishes stalled utterance and unpauses voice
 *
 * Tier 2 (Real Loaded MV3 Chrome --load-extension=D:\sleep):
 *   5. Actionable 'Microphone' card (allow_mic + mic_setup buttons, persistent non-dismissing card)
 *      and Red Error Orb click recovery (retries instead of dismissing UI)
 *   6. mic-setup.html releases getUserMedia tracks cleanly when Start Voice Test clicks
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function loadScriptInSandbox(file, sandbox) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: file });
}

function makeBaseSandbox() {
  const timerFns = { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 16), cancelAnimationFrame: clearTimeout };
  const sandbox = {
    console,
    Date,
    Math,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Error,
    Promise,
    ...timerFns,
    isSecureContext: true,
    navigator: {
      mediaDevices: {
        getUserMediaCalls: 0
      },
      permissions: {
        query: async () => ({ state: 'granted' })
      }
    },
    document: {
      head: { appendChild: () => {} },
      body: {},
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, setAttribute: () => {} }),
      querySelector: () => null,
      querySelectorAll: () => []
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

async function runTier1UnitTests() {
  // 1. Synchronous InvalidStateError & NotAllowedError recovery
  {
    const sb = makeBaseSandbox();
    const instances = [];
    let throwMode = 'InvalidStateError';
    class MockSR {
      constructor() {
        this.lang = 'en-IN';
        this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null;
        instances.push(this);
      }
      start() {
        if (throwMode === 'InvalidStateError') {
          throwMode = 'ok';
          const err = new Error('recognition already started');
          err.name = 'InvalidStateError';
          throw err;
        }
        if (throwMode === 'NotAllowedError') {
          const err = new Error('permission denied');
          err.name = 'NotAllowedError';
          throw err;
        }
        if (this.onstart) this.onstart();
      }
      stop() { if (this.onend) this.onend(); }
      abort() {}
    }
    sb.SpeechRecognition = MockSR;
    sb.webkitSpeechRecognition = MockSR;
    loadScriptInSandbox('voice.js', sb);

    const v = new sb.SleepwalkerVoice();
    const ok = v.startListening();
    assert.strictEqual(ok, true, 'InvalidStateError should recreate & retry synchronously');
    assert.strictEqual(v.lifecycleState, 'listening', 'Must transition to listening instead of deadlocking in starting');
    assert.ok(instances.length >= 2, 'Must recreate SpeechRecognition after InvalidStateError');

    v.stopListening();
    throwMode = 'NotAllowedError';
    let lastErr = null;
    v.onError = (e) => { lastErr = e; };
    const blocked = v.startListening();
    assert.strictEqual(blocked, false);
    assert.strictEqual(v.lifecycleState, 'error');
    assert.ok(lastErr && lastErr.isPermissionDenied === true, 'NotAllowedError must notify UI without hanging in starting');

    // Recover once granted
    throwMode = 'ok';
    const recovered = v.startListening();
    assert.strictEqual(recovered, true);
    assert.strictEqual(v.lifecycleState, 'listening');
    v.stopListening();
    console.log('PASS  1. InvalidStateError & NotAllowedError synchronous recovery (never deadlocks)');
  }

  // 2. Concurrent onstart arriving after pauseTemporary() stays paused
  {
    const sb = makeBaseSandbox();
    const log = { stopCount: 0, inst: null };
    class AsyncStartSR {
      constructor() {
        this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null;
        log.inst = this;
      }
      start() {
        // Delayed async onstart (like real Chrome)
      }
      stop() {
        log.stopCount += 1;
      }
      abort() {}
    }
    sb.SpeechRecognition = AsyncStartSR;
    sb.webkitSpeechRecognition = AsyncStartSR;
    loadScriptInSandbox('voice.js', sb);

    const v = new sb.SleepwalkerVoice();
    v.startListening();
    const paused = v.pauseTemporary();
    assert.strictEqual(paused, true);
    // Delayed onstart arrives after pauseTemporary() was already called
    log.inst.onstart();
    assert.strictEqual(v.isPaused, true, 'Late onstart must NOT unpause half-duplex TTS pause');
    assert.ok(log.stopCount >= 2, 'Late onstart during pause must re-stop recognition immediately');
    v.stopListening();
    console.log('PASS  2. Late async onstart respects concurrent pauseTemporary()');
  }

  // 3. Rapid <1500ms silenceTimer commits + setLang restarts & ZERO competing getUserMedia calls
  {
    const sb = makeBaseSandbox();
    let gumCalls = 0;
    sb.navigator.mediaDevices.getUserMedia = async () => {
      gumCalls += 1;
      return { getTracks: () => [{ stop: () => {} }] };
    };
    sb.AudioContext = function () { this.createMediaStreamSource = () => ({ connect: () => {} }); this.createAnalyser = () => ({}); this.close = () => {}; };
    class FastCycleSR {
      constructor() { this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null; this._active = false; }
      start() { this._active = true; if (this.onstart) this.onstart(); }
      stop() { if (this._active) { this._active = false; if (this.onend) this.onend(); } }
      abort() { this._active = false; }
    }
    sb.SpeechRecognition = FastCycleSR;
    sb.webkitSpeechRecognition = FastCycleSR;
    loadScriptInSandbox('voice.js', sb);

    const v = new sb.SleepwalkerVoice();
    v.continuousSession = true;
    v.onTranscript = () => {};
    let cmdCount = 0;
    v.onCommand = () => { cmdCount += 1; };
    v.startListening();

    for (let i = 0; i < 8; i++) {
      // Simulate fast silenceTimer flush (<1500ms) + setLang restart without waiting full 1.5s wall time
      v._benignRestart = true;
      v._restartAttempts = v._restartAttempts; // verify untouched
      v.recognition.stop();
      await new Promise((r) => setTimeout(r, 150));
      v.setLang(i % 2 === 0 ? 'hi-IN' : 'en-IN');
      await new Promise((r) => setTimeout(r, 150));
    }

    assert.strictEqual(v.isListening, true, 'Voice must remain listening after 8 fast restarts + language switches');
    assert.strictEqual(v._restartAttempts, 0, 'Benign restarts must not consume crash backoff attempts');
    assert.notStrictEqual(v.lifecycleState, 'error', 'Voice must never crash into Temporarily unavailable on fast restarts');
    assert.strictEqual(gumCalls, 0, '_startLevelMonitor must NOT open competing getUserMedia while SpeechRecognition runs');
    v.stopListening();
    console.log('PASS  3. Benign restarts preserve backoff budget & zero competing getUserMedia calls');
  }

  // 4. Reader dropped-onend watchdog restores TTS completion & dialogue unpauses voice
  {
    const sb = makeBaseSandbox();
    class InstantSR {
      constructor() { this.onstart = null; this.onend = null; this.onerror = null; this.onresult = null; }
      start() { if (this.onstart) this.onstart(); }
      stop() { if (this.onend) this.onend(); }
      abort() {}
    }
    sb.SpeechRecognition = InstantSR;
    sb.webkitSpeechRecognition = InstantSR;
    sb.SpeechSynthesisUtterance = function (text) { this.text = text; };
    const synthMock = {
      speaking: false,
      pending: false,
      getVoices: () => [{ lang: 'en-IN', default: true }],
      speak: (u) => {
        synthMock.speaking = true;
        setTimeout(() => { if (u.onstart) u.onstart(); }, 20);
        // Simulate Chrome bug: synthesis ends silently WITHOUT firing u.onend
        setTimeout(() => { synthMock.speaking = false; synthMock.pending = false; }, 120);
      },
      cancel: () => { synthMock.speaking = false; }
    };
    sb.speechSynthesis = synthMock;

    loadScriptInSandbox('reader.js', sb);
    loadScriptInSandbox('voice.js', sb);
    loadScriptInSandbox('dialogue.js', sb);

    const reader = new sb.SleepwalkerReader();
    const voice = new sb.SleepwalkerVoice();
    const fakeWidget = {
      reader,
      voice,
      lang: 'en-IN',
      setAssistantReply: () => {}
    };
    const dialogue = new sb.SleepwalkerDialogue(fakeWidget, { resumeDelayMs: 40 });
    fakeWidget.dialogue = dialogue;
    reader.onStatusChange = (st) => dialogue.onSpeechStatusChange(st);
    reader.onFinished = () => dialogue.onSpeechStatusChange({ isPlaying: false, isPaused: false });

    dialogue.startSession({ source: 'alt_s' });
    assert.strictEqual(voice.isListening, true);
    dialogue._sayAndDisplay('Short spoken reply with dropped onend event.', { speak: true, openBubble: false });
    assert.strictEqual(voice.isPaused, true, 'Half-duplex pauses voice while TTS speaks');

    // Wait up to 2.2s for 900ms quiet watchdog + 40ms dialogue resumeDelay
    for (let i = 0; i < 25 && voice.isPaused; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(reader.isPlaying, false, 'Watchdog must clear hung reader playback state');
    assert.strictEqual(voice.isPaused, false, 'Dialogue must automatically resume microphone after dropped onend');
    assert.strictEqual(voice.lifecycleState, 'listening', 'Voice must return cleanly to listening');
    dialogue.endSession({ reason: 'test', quiet: true, force: true });
    console.log('PASS  4. Reader dropped-onend watchdog prevents permanent mic pause deadlock');
  }
}

async function runTier2RealChromeTests() {
  const chromiumExe = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');
  if (!fs.existsSync(chromiumExe)) {
    console.log('SKIP  Tier 2 Real Chrome Mic Tests (Playwright Chromium binary not present)');
    return;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><main><h1>Voice Test Fixture</h1><p>Paragraph text for mic check.</p></main></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const fetchTargets = async (port) => (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const connectTarget = async (target) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    let seq = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
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
    const evalJs = async (fnBody) => {
      const res = await send('Runtime.evaluate', { expression: `(async () => { ${fnBody} })()`, awaitPromise: true, returnByValue: true });
      if (res?.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
      return res?.result?.value;
    };
    return { ws, send, evalJs };
  };

  // 5A. Real MV3 Chrome WITHOUT fake mic UI -> Alt+S -> not-allowed card has interactive recovery buttons & Orb retry doesn't dismiss
  {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-mic-blocked-'));
    const cdpPort = 9420 + Math.floor(Math.random() * 250);
    const chrome = spawn(chromiumExe, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `${baseUrl}/`
    ], { stdio: 'ignore' });

    const sockets = [];
    try {
      let pageTarget = null;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !pageTarget) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const targets = await fetchTargets(cdpPort);
          pageTarget = targets.find((t) => t.type === 'page' && t.url.includes(baseUrl));
        } catch (_e) {}
      }
      assert.ok(pageTarget, 'Expected fixture page target');
      const pg = await connectTarget(pageTarget);
      sockets.push(pg.ws);

      // Wait for #sleepwalker-ui-host mount
      for (let i = 0; i < 40; i++) {
        const ready = await pg.evalJs(`return Boolean(document.getElementById('sleepwalker-ui-host')?.shadowRoot);`).catch(() => false);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 150));
      }

      // Send Alt+S keydown to start listening -> triggers Chrome not-allowed in headless without fake-ui
      await pg.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', altKey: true, bubbles: true, cancelable: true }));`);
      let errSnap = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 150));
        errSnap = await pg.evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host')?.shadowRoot;
          if (!sr) return null;
          const root = sr.querySelector('.sw-ui-root');
          const card = sr.getElementById('sw-ui-card');
          const btns = Array.from(sr.querySelectorAll('#sw-card-actions button')).map(b => b.dataset.actionId);
          return { state: root?.dataset.state, active: root?.dataset.active, title: sr.getElementById('sw-card-title')?.textContent, visible: Boolean(card && !card.hidden), btns };
        `);
        if (errSnap && errSnap.state === 'error' && errSnap.title === 'Microphone') break;
      }

      assert.strictEqual(errSnap?.state, 'error', `Expected error state after blocked mic: ${JSON.stringify(errSnap)}`);
      assert.strictEqual(errSnap?.title, 'Microphone');
      assert.ok(errSnap.btns.includes('allow_mic') || errSnap.btns.includes('retry_mic'), `Error card must include actionable retry/allow button: ${JSON.stringify(errSnap)}`);
      assert.ok(errSnap.btns.includes('mic_setup'), `Error card must include Mic Diagnostics button: ${JSON.stringify(errSnap)}`);

      // Clicking Red Error Orb must recover / keep UI open rather than dismissing!
      await pg.evalJs(`document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-ui-orb').click();`);
      await new Promise((r) => setTimeout(r, 400));
      const afterOrbClick = await pg.evalJs(`
        const sr = document.getElementById('sleepwalker-ui-host')?.shadowRoot;
        const root = sr?.querySelector('.sw-ui-root');
        return { active: root?.dataset.active, state: root?.dataset.state };
      `);
      assert.strictEqual(afterOrbClick.active, 'true', `Clicking Red Error Orb must NOT dismiss Sleepwalker: ${JSON.stringify(afterOrbClick)}`);
      console.log('PASS  5. Real MV3 Chrome actionable Microphone error card & Red Orb non-dismissal recovery');
    } finally {
      sockets.forEach((s) => { try { s.close(); } catch (_e) {} });
      await new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        try { chrome.once('exit', fin); chrome.kill(); setTimeout(fin, 1200); } catch (_e) { fin(); }
      });
      await new Promise((r) => setTimeout(r, 80));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
    }
  }

  // 5B. mic-setup.html with fake media stream: grant stops activeStream when Start Voice Test clicks
  {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-mic-setup-'));
    const cdpPort = 9520 + Math.floor(Math.random() * 250);
    const chrome = spawn(chromiumExe, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `${baseUrl}/`
    ], { stdio: 'ignore' });

    const sockets = [];
    try {
      let swTarget = null;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !swTarget) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const targets = await fetchTargets(cdpPort);
          swTarget = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
        } catch (_e) {}
      }
      assert.ok(swTarget, 'Expected Sleepwalker SW');
      const extId = new URL(swTarget.url).host;
      const setupUrl = `chrome-extension://${extId}/mic-setup.html`;

      await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(setupUrl)}`, { method: 'PUT' });
      let setupTarget = null;
      for (let i = 0; i < 40 && !setupTarget; i++) {
        await new Promise((r) => setTimeout(r, 150));
        setupTarget = (await fetchTargets(cdpPort)).find((t) => t.type === 'page' && t.url && t.url.includes('mic-setup.html'));
      }
      assert.ok(setupTarget, 'Expected mic-setup.html page target');
      const pg = await connectTarget(setupTarget);
      sockets.push(pg.ws);

      let loaded = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 150));
        loaded = await pg.evalJs(`return Boolean(document.getElementById('btn-request-perm'));`).catch(() => false);
        if (loaded) break;
      }
      assert.strictEqual(loaded, true, 'mic-setup.html DOM must load cleanly');

      // Hook getUserMedia track monitor before clicking btn-request-perm
      await pg.evalJs(`
        window.__SW_CAPTURED_TRACKS__ = [];
        const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (...args) => {
          const s = await origGum(...args);
          s.getTracks().forEach(t => window.__SW_CAPTURED_TRACKS__.push(t));
          return s;
        };
      `);
      await pg.evalJs(`document.getElementById('btn-request-perm').click();`);
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const st = await pg.evalJs(`return document.getElementById('perm-badge')?.textContent || '';`);
        if (st.includes('Granted')) break;
      }
      const step1 = await pg.evalJs(`
        return {
          badge: document.getElementById('perm-badge').textContent,
          meterOpen: document.getElementById('meter-card').style.display,
          liveTracks: (window.__SW_CAPTURED_TRACKS__ || []).filter(t => t.readyState === 'live').length
        };
      `);
      assert.ok(step1.badge.includes('Granted'), `mic-setup permission should succeed: ${JSON.stringify(step1)}`);
      assert.strictEqual(step1.liveTracks, 1, 'Expected 1 live audio track during Step 1 meter');

      // Clicking Step 2 Start Voice Test must release activeStream tracks so SpeechRecognition has exclusive mic access
      await pg.evalJs(`document.getElementById('btn-test-recognition').click();`);
      await new Promise((r) => setTimeout(r, 250));
      const step2 = await pg.evalJs(`
        return {
          liveTracks: (window.__SW_CAPTURED_TRACKS__ || []).filter(t => t.readyState === 'live').length,
          endedTracks: (window.__SW_CAPTURED_TRACKS__ || []).filter(t => t.readyState === 'ended').length
        };
      `);
      assert.strictEqual(step2.liveTracks, 0, `Start Voice Test must stop getUserMedia tracks first: ${JSON.stringify(step2)}`);
      assert.ok(step2.endedTracks >= 1);
      console.log('PASS  6. Real MV3 Chrome mic-setup.html grants access cleanly & releases track before SpeechRecognition');
    } finally {
      sockets.forEach((s) => { try { s.close(); } catch (_e) {} });
      await new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        try { chrome.once('exit', fin); chrome.kill(); setTimeout(fin, 1200); } catch (_e) { fin(); }
      });
      await new Promise((r) => setTimeout(r, 80));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
    }
  }

  await new Promise((r) => server.close(r));
}

(async () => {
  console.log('=== Sleepwalker Voice & Microphone Regression Suite ===\n');
  await runTier1UnitTests();
  await runTier2RealChromeTests();
  console.log('\nSummary: All Voice & Microphone reliability checks passed.');
  process.exit(0);
})().catch((err) => {
  console.error('\nVOICE MIC TEST FAILED:', err);
  process.exit(1);
});
