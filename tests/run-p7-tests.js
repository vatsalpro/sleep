/**
 * Phase 7 Automated Test Suite (Multilingual Polish, Auto Retry, Diagnostics Telemetry, Demo Portal & Clean Model Config)
 * Run with: node tests/run-p7-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function loadModule(relPath) {
  const full = path.join(ROOT, relPath);
  delete require.cache[require.resolve(full)];
  return require(full);
}

let passedSuites = 0;
let failedSuites = 0;

async function runSuite(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passedSuites += 1;
  } catch (err) {
    console.error(`FAIL  ${name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
    failedSuites += 1;
  }
}

async function main() {
  console.log('=== Sleepwalker Phase 7 Test Suite ===\n');

  // Suite 1: Syntax validation across ALL extension JS files & zero stale Gemini 1.5 references
  await runSuite('All Extension JS Files Pass node --check & Zero Stale gemini-1.5 References', () => {
    const jsFiles = [
      'diagnostics.js', 'gemini-live.js', 'ai-comm.js', 'intent.js', 'confirm.js', 'digest.js', 'explain.js', 'llm.js', 'memory.js', 'task-planner.js',
      'link-index.js', 'match.js', 'link-intent.js', 'navigate.js',
      'form-index.js', 'form-fill.js', 'forms.js',
      'shelf-db.js', 'shelf.js', 'upload.js', 'camera.js', 'dialogue.js',
      'voice.js', 'reader.js', 'outline.js', 'threads.js', 'card.js',
      'orb.js', 'options.js', 'content.js', 'background.js', 'mic-setup.js', 'offscreen.js'
    ];
    for (const f of jsFiles) {
      execSync(`node --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' });
    }

    const filesToCheckStale = [
      'README.md', 'llm.js', 'intent.js', 'explain.js', 'content.js', 'options.js',
      'proxy/worker.js', 'proxy/api/explain.js'
    ];
    for (const rel of filesToCheckStale) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(!/gemini-1\.5-flash/i.test(content), `Found stale gemini-1.5-flash model string in ${rel}`);
    }
  });

  // Suite 2: Multilingual Support (8 Regional Indian Languages + Auto hi-IN -> en-IN single retry)
  await runSuite('Regional Indian Languages (ta, te, bn, mr, gu, kn, ml, pa) & Auto Single Retry', async () => {
    const win = {
      SpeechRecognition: class MockSR {
        constructor() { this.lang = 'en-IN'; }
        start() {}
        stop() {}
      },
      speechSynthesis: {
        getVoices: () => [
          { lang: 'en-IN', name: 'Ravi', default: true },
          { lang: 'hi-IN', name: 'Lekha', default: false },
          { lang: 'ta-IN', name: 'Valluvar', default: false },
          { lang: 'bn-IN', name: 'Bangla', default: false }
        ]
      }
    };
    global.window = win;
    global.chrome = { runtime: { onMessage: { addListener: () => {} }, getURL: (p) => p } };
    global.document = {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: () => {} },
      querySelectorAll: () => [],
      body: { textContent: '' },
      title: 'Test'
    };
    global.location = { href: 'https://example.edu/portal', origin: 'https://example.edu', pathname: '/portal' };

    loadModule('voice.js');
    loadModule('reader.js');
    const SleepwalkerVoice = win.SleepwalkerVoice;
    const SleepwalkerReader = win.SleepwalkerReader;
    const SleepwalkerIntent = loadModule('intent.js');
    const lexicon = JSON.parse(fs.readFileSync(path.join(ROOT, 'lexicon.json'), 'utf8'));

    // Auto mode defaults to hi-IN and allows ONE en-IN retry on low confidence
    const voice = new SleepwalkerVoice();
    voice.setLang('auto');
    assert.strictEqual(voice.mode, 'auto');
    assert.strictEqual(voice.getActiveLang(), 'hi-IN');
    assert.strictEqual(voice.shouldRetryWithEnIn(0.45), true);
    assert.strictEqual(voice.tryAutoEnInRetry(0.45, { restartListening: false }), true);
    assert.strictEqual(voice.getActiveLang(), 'en-IN');
    assert.strictEqual(voice.tryAutoEnInRetry(0.3, { restartListening: false }), false, 'Auto retry must happen at most ONCE per utterance/session');

    // All 8 regional languages accepted by voice & matched by reader.getBestVoice
    const regionalCodes = ['ta-IN', 'te-IN', 'bn-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN'];
    const reader = new SleepwalkerReader();
    reader.loadVoices();
    for (const code of regionalCodes) {
      voice.setLang(code);
      assert.strictEqual(voice.getActiveLang(), code);
      reader.setLang(code);
      assert.strictEqual(reader.lang, code);
    }
    assert.strictEqual(reader.getBestVoice('ta-IN').lang, 'ta-IN');
    assert.strictEqual(reader.getBestVoice('bn-IN').lang, 'bn-IN');

    // Intent Engine routes regional non-Devanagari scripts to LLM with concrete lang code
    let llmCalls = [];
    const engine = new SleepwalkerIntent({
      lexicon,
      llmCaller: async (payload) => {
        llmCalls.push(payload);
        return { intent: 'EXPLAIN', args: { mode: 'summary' }, lang: payload.lang, confidence: 0.91 };
      }
    });
    const resTamil = await engine.classify('இந்த பக்கத்தை விளக்கவும்', { lang: 'auto' });
    assert.strictEqual(resTamil.intent, 'EXPLAIN');
    assert.strictEqual(resTamil.lang, 'ta-IN');
    assert.strictEqual(resTamil.source, 'llm');
    assert.strictEqual(llmCalls.length, 1);

    // Language switch commands for regional languages work via zero-LLM rules
    const swTelugu = await engine.classify('switch to telugu');
    assert.strictEqual(swTelugu.intent, 'CONTROL');
    assert.strictEqual(swTelugu.args.action, 'language');
    assert.strictEqual(swTelugu.args.lang, 'te-IN');
    assert.strictEqual(swTelugu.source, 'rules');
  });

  // Suite 3: Explain & Widget Multilingual Speech Sync (sets reader.setLang to concrete reply lang)
  await runSuite('Explainer Sets Concrete Regional/Reply Speech Lang & Honors Local Answer Notice', async () => {
    const langSetLog = [];
    const spokenLog = [];
    const replies = [];
    const textNode = { nodeType: 3, textContent: 'Scholarship fee is 1200 INR. Apply by January 15, 2027.' };
    const pNode = {
      nodeType: 1,
      tagName: 'P',
      attributes: {},
      children: [],
      childNodes: [textNode],
      parentElement: null,
      textContent: textNode.textContent,
      innerText: textNode.textContent,
      getAttribute: () => null,
      closest: () => null
    };
    const bodyNode = {
      nodeType: 1,
      tagName: 'BODY',
      attributes: {},
      children: [pNode],
      childNodes: [pNode],
      parentElement: null,
      textContent: textNode.textContent,
      innerText: textNode.textContent,
      getAttribute: () => null,
      closest: () => null
    };
    pNode.parentElement = bodyNode;
    textNode.parentElement = pNode;

    global.document = {
      title: 'Scholarship Demo',
      body: bodyNode,
      querySelector: () => null,
      querySelectorAll: (sel) => (sel.includes('p') ? [pNode] : [])
    };
    global.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    };
    global.location = { href: 'https://example.edu/portal', origin: 'https://example.edu', pathname: '/portal' };
    global.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          if (msg.type === 'SLEEPWALKER_EXPLAIN_REQUEST') {
            cb({
              status: 'ok',
              source: 'Gemini Flash',
              answer: 'கட்டணம் 1200 INR ஆகும். விண்ணப்பிக்க கடைசி தேதி January 15, 2027.'
            });
          } else {
            cb({});
          }
        }
      }
    };

    global.SleepwalkerDigest = loadModule('digest.js');
    const { SleepwalkerExplainer } = loadModule('explain.js');

    const mockWidget = {
      lang: 'auto',
      voice: { activeLang: 'hi-IN' },
      reader: {
        setLang: (l) => langSetLog.push(l),
        readText: (t) => spokenLog.push(t)
      },
      pill: { setPreparing: () => {}, setStatus: () => {}, setSpeaking: () => {} },
      glow: { setPreparing: () => {}, setReady: () => {}, setSpeaking: () => {} },
      setAssistantReply: (t) => replies.push(t)
    };

    const explainer = new SleepwalkerExplainer(mockWidget);
    const out = await explainer.runExplainPipeline({ mode: 'summary', lang: 'ta-IN' });
    assert.ok(out && out.answer.includes('1200 INR'));

    // Wait slightly for the 600ms completeAnnouncement timer in explain.js
    await new Promise((r) => setTimeout(r, 700));
    assert.strictEqual(langSetLog[langSetLog.length - 1], 'ta-IN', 'Explainer must sync reader language to reply lang ta-IN');
    assert.ok(spokenLog.length === 1 && spokenLog[0].includes('1200 INR'));
  });

  // Suite 4: Diagnostics Telemetry (LLM Call Count + Approx Tokens + Language Mode + Auto Retry)
  await runSuite('Diagnostics Telemetry Captures Call Counts, Approx Tokens & Regional Language Status', async () => {
    global.chrome = { storage: { local: { get: (_k, cb) => cb({}), set: (_o, cb) => cb && cb() } } };
    const llmMod = loadModule('llm.js');
    llmMod.resetLlmStateForTests();

    // Simulate tracked explain call tokens via handleExplainRequest with mocked fetch -> proxy
    const originalFetch = global.fetch;
    global.chrome.storage.local.get = (_keys, cb) => cb({
      sleepwalker_proxy_url: 'https://mock.proxy.local/explain',
      sleepwalker_local_only: false
    });
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answer: JSON.stringify({ answer: 'Registration fee is 1200 INR.' }), source: 'cloud proxy' })
    });

    const explainRes = await llmMod.handleExplainRequest({
      urlClean: 'https://example.edu/demo',
      pageTextHash: 'hash_p7_diag',
      mode: 'summary',
      lang: 'en-IN',
      digestPrompt: 'TITLE: Scholarship Portal\nCONTENT: Fee is 1200 INR.'
    });
    assert.strictEqual(explainRes.status, 'ok');

    const diag = llmMod.getLlmDiagnostics();
    assert.strictEqual(diag.callsTotal, 1);
    assert.strictEqual(diag.explainCalls, 1);
    assert.ok(diag.approxInputTokens > 0 && diag.approxOutputTokens > 0, 'Diagnostics must track approx in/out tokens');

    // Verify widget.js diagnostics renderer includes Language Mode, Selected TTS, Approx tokens, Zero-LLM %
    const widgetSrc = fs.readFileSync(path.join(ROOT, 'widget.js'), 'utf8');
    assert.ok(widgetSrc.includes('resolveReplyLang'), 'widget.js must have resolveReplyLang helper');
    assert.ok(widgetSrc.includes('Selected TTS:') && widgetSrc.includes('Language Mode:'), 'renderDiagnostics must show language mode and selected TTS voice status');
    assert.ok(widgetSrc.includes('approxInputTokens') && widgetSrc.includes('approxOutputTokens'), 'renderDiagnostics must display approximate tokens');

    global.fetch = originalFetch;
  });

  // Suite 5: Demo Portal & README Test Checklist Verification
  await runSuite('Demo Portal Fixture Completeness & README Checklist / Honest Limits', () => {
    const portalHtml = fs.readFileSync(path.join(ROOT, 'demo-portal.html'), 'utf8');
    const requiredIds = [
      'btn-glow-underlay-check', 'btn-pay-fee', 'btn-logout',
      'f-name', 'f-email', 'f-phone', 'f-dob', 'f-state',
      'r-ug', 'r-pg', 'f-password', 'f-otp', 'f-aadhaar', 'f-pan', 'f-cvv', 'f-captcha',
      'up-photo', 'up-marksheet', 'up-income', 'dz-income', 'f-agree', 'btn-submit-app'
    ];
    for (const id of requiredIds) {
      assert.ok(portalHtml.includes(`id="${id}"`), `demo-portal.html missing #${id}`);
    }
    assert.ok(portalHtml.includes('SecretDemoPass#987') && portalHtml.includes('482910'), 'demo-portal.html must include sentinel password/OTP values for leak tests');

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes('Judge & Developer Test Checklist'), 'README.md must include Test Checklist section');
    assert.ok(readme.includes('ta-IN') && readme.includes('Auto'), 'README.md must document regional Indian languages & Auto mode');
    assert.ok(readme.includes('GEMINI_MODEL'), 'README.md must document GEMINI_MODEL env var');
  });

  // Suite 6: Root .env Config (Gemini + Ollama), Background Sync, Privacy & Settings Show/Hide UI
  await runSuite('Unified .env (Gemini + Ollama) Parsing, Fallbacks, Gitignore & Settings Show/Hide UI', async () => {
    global.chrome = { storage: { local: { get: (_k, cb) => cb({}), set: (_o, cb) => cb && cb() } } };
    const prevEnv = global.SLEEPWALKER_ENV;
    try {
      const llmMod = loadModule('llm.js');
      assert.strictEqual(typeof llmMod.parseDotEnv, 'function', 'llm.js must export parseDotEnv');

      const sampleParsed = llmMod.parseDotEnv(
        '# comment\nGEMINI_API_KEY="AIzaTest1234"\nexport GEMINI_MODEL=\'gemini-2.5-flash-lite\'\nOLLAMA_URL=http://localhost:11434\nOLLAMA_MODEL=llama3.2:3b\nLOCAL_ONLY=false\n'
      );
      assert.strictEqual(sampleParsed.GEMINI_API_KEY, 'AIzaTest1234');
      assert.strictEqual(sampleParsed.GEMINI_MODEL, 'gemini-2.5-flash-lite');
      assert.strictEqual(sampleParsed.OLLAMA_URL, 'http://localhost:11434');
      assert.strictEqual(sampleParsed.OLLAMA_MODEL, 'llama3.2:3b');
      assert.strictEqual(sampleParsed.LOCAL_ONLY, 'false');

      const envExampleSrc = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
      const exampleParsed = llmMod.parseDotEnv(envExampleSrc);
      assert.strictEqual(exampleParsed.GEMINI_MODEL, 'gemini-2.5-flash-lite');
      assert.strictEqual(exampleParsed.OLLAMA_URL, 'http://localhost:11434');
      assert.strictEqual(exampleParsed.OLLAMA_MODEL, 'llama3.2:3b');

      // Verify getLlmConfig() reads from self.SLEEPWALKER_ENV when chrome.storage.local is empty
      global.SLEEPWALKER_ENV = {
        GEMINI_API_KEY: 'AQ.EnvMockKey9999',
        GEMINI_MODEL: 'gemini-2.5-flash',
        OLLAMA_URL: 'http://127.0.0.1:11434',
        OLLAMA_MODEL: 'qwen2.5:3b',
        LOCAL_ONLY: 'false'
      };
      const cfgFromEnv = await llmMod.getLlmConfig();
      assert.strictEqual(cfgFromEnv.geminiApiKey, 'AQ.EnvMockKey9999');
      assert.strictEqual(cfgFromEnv.geminiModel, 'gemini-2.5-flash');
      assert.strictEqual(cfgFromEnv.ollamaUrl, 'http://127.0.0.1:11434');
      assert.strictEqual(cfgFromEnv.ollamaModel, 'qwen2.5:3b');

      // Check local .env if present (gitignored workspace file)
      const rootEnvPath = path.join(ROOT, '.env');
      if (fs.existsSync(rootEnvPath)) {
        const rootEnv = llmMod.parseDotEnv(fs.readFileSync(rootEnvPath, 'utf8'));
        assert.ok(rootEnv.GEMINI_API_KEY && rootEnv.GEMINI_API_KEY.length > 10, '.env must define GEMINI_API_KEY');
        assert.ok(rootEnv.GEMINI_MODEL, '.env must define GEMINI_MODEL');
        assert.ok(rootEnv.OLLAMA_URL && rootEnv.OLLAMA_MODEL, '.env must define OLLAMA_URL and OLLAMA_MODEL');
      }
    } finally {
      global.SLEEPWALKER_ENV = prevEnv;
    }

    // Verify background.js exposes env sync & reload messages without making .env web-accessible
    const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
    assert.ok(bgSrc.includes('syncEnvIntoStorage'), 'background.js must include syncEnvIntoStorage');
    assert.ok(bgSrc.includes("chrome.runtime.getURL('.env')"), 'background.js must read root .env privately');
    assert.ok(bgSrc.includes('SLEEPWALKER_GET_ENV_DEFAULTS') && bgSrc.includes('SLEEPWALKER_RELOAD_ENV'), 'background.js must serve env defaults and reload messages');

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const war = JSON.stringify(manifest.web_accessible_resources || []);
    assert.ok(!war.includes('.env') && !war.includes('config.local.js'), 'manifest.json must NEVER expose .env or config.local.js to web pages');

    // Verify widget.js Settings UI has Show/Hide toggle, Gemini Model input, and Load .env button
    const widgetSrc = fs.readFileSync(path.join(ROOT, 'widget.js'), 'utf8');
    for (const token of [
      'sw-btn-toggle-gemini-key',
      'sw-input-gemini-model',
      'sw-btn-reload-env',
      'sw-env-status-hint',
      'reloadEnvSettings',
      '_syncEnvFromBackground'
    ]) {
      assert.ok(widgetSrc.includes(token), `widget.js missing ${token}`);
    }

    const gitignoreSrc = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.ok(gitignoreSrc.includes('.env') && gitignoreSrc.includes('*.local.js'), '.gitignore must exclude .env and *.local.js');
  });

  console.log(`\nSummary: ${passedSuites}/${passedSuites + failedSuites} P7 suites passed.`);
  if (failedSuites > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
