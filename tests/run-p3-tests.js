/**
 * Phase 3 Automated Test Suite (Digest, Token Budgets, Explain/Q&A Modes, Rate Limits, Telemetry)
 * Run with: node tests/run-p3-tests.js
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

/**
 * Minimal lightweight DOM mock supporting digest.js & explain.js node/attribute/selector walks.
 */
function createMockDom() {
  class MockNode {
    constructor(nodeType, tagName = '') {
      this.nodeType = nodeType;
      this.tagName = tagName ? tagName.toUpperCase() : '';
      this.attributes = {};
      this.children = [];
      this.childNodes = [];
      this.parentElement = null;
      this.id = '';
      this.hidden = false;
      this.required = false;
      this.value = '';
      this._text = '';
      this.classList = {
        _set: new Set(),
        add: (c) => this.classList._set.add(c),
        contains: (c) => this.classList._set.has(c)
      };
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'required') this.required = true;
    }
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    }
    appendChild(child) {
      child.parentElement = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    }
    closest(tag) {
      let cur = this.parentElement;
      const target = String(tag).toUpperCase();
      while (cur) {
        if (cur.tagName === target) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    get textContent() {
      if (this.nodeType === 3) return this._text;
      return this.childNodes.map((c) => c.textContent).join(' ');
    }
    set textContent(v) {
      this.childNodes = [];
      this.children = [];
      if (v) {
        const txt = new MockNode(3);
        txt._text = String(v);
        this.appendChild(txt);
      }
    }
    get innerText() {
      return this.textContent;
    }
    getClientRects() {
      return [{ top: 10, left: 10, width: 100, height: 20 }];
    }
  }

  function makeEl(tag, attrs = {}, text = '') {
    const el = new MockNode(1, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'value') el.value = v;
      else if (k === 'required') el.required = Boolean(v);
      else if (k === 'hidden') el.hidden = Boolean(v);
      else el.setAttribute(k, v);
    }
    if (text) el.textContent = text;
    return el;
  }

  const body = makeEl('body');
  const doc = {
    title: 'National Scholarship Portal - Application',
    cookie: 'sessionid=COOKIE_SECRET_VALUE',
    location: {
      protocol: 'https:',
      origin: 'https://scholarships.gov.in',
      pathname: '/apply',
      href: 'https://scholarships.gov.in/apply?token=QUERY_SECRET_123&utm=test#form'
    },
    body,
    defaultView: {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    },
    _all() {
      const list = [];
      const walk = (n) => {
        if (n.nodeType === 1) list.push(n);
        for (const ch of n.childNodes) walk(ch);
      };
      walk(body);
      return list;
    },
    getElementById(id) {
      return this._all().find((el) => el.id === id) || null;
    },
    querySelector(sel) {
      const all = this.querySelectorAll(sel);
      return all[0] || null;
    },
    querySelectorAll(sel) {
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
      const all = this._all();
      return all.filter((el) => parts.some((p) => {
        const tag = el.tagName.toLowerCase();
        if (p === 'main' || p === 'article') return tag === p;
        if (p === '[role="main"]') return el.getAttribute('role') === 'main';
        if (p === 'label[for]') return tag === 'label' && el.getAttribute('for') !== null;
        if (p === 'a[href]') return tag === 'a' && el.getAttribute('href') !== null;
        if (p === '[role="button"]') return el.getAttribute('role') === 'button';
        if (p === '[role="link"]') return el.getAttribute('role') === 'link';
        if (p === '[role="heading"]') return el.getAttribute('role') === 'heading';
        if (/^h[1-6]$/.test(p)) return tag === p;
        return tag === p;
      }));
    }
  };

  // Build rich realistic DOM
  const main = makeEl('main');
  body.appendChild(main);

  main.appendChild(makeEl('h1', {}, 'National Merit Scholarship 2026'));
  main.appendChild(makeEl('p', {}, 'This portal helps eligible college students apply for annual merit scholarships online.'));

  main.appendChild(makeEl('h2', {}, 'Eligibility and Deadlines'));
  main.appendChild(makeEl('p', {}, 'Applicants must score above 75 percent. The last date to submit is May 31, 2026.'));

  main.appendChild(makeEl('h2', {}, 'Fees & Payment'));
  main.appendChild(makeEl('p', {}, 'Application processing fee is Rs. 500 or ₹१५०० for late registration. No refunds after submission.'));

  main.appendChild(makeEl('h2', {}, 'Required Documents'));
  main.appendChild(makeEl('p', {}, 'Required documents: Aadhaar card copy, Income certificate, and previous marksheet PDF.'));

  const linkApply = makeEl('a', { href: '/start-application' }, 'Start Scholarship Application');
  const btnSubmit = makeEl('button', { type: 'submit' }, 'Submit Application');
  const labelName = makeEl('label', { for: 'applicant-name' }, 'Full Applicant Name');
  const inputName = makeEl('input', { id: 'applicant-name', type: 'text', value: 'TYPED_NAME_SECRET', required: true });
  const inputFile = makeEl('input', { id: 'income-doc', type: 'file', accept: '.pdf,.jpg', 'aria-label': 'Income Certificate PDF' });
  const selectState = makeEl('select', { id: 'state', 'aria-label': 'Home State' });
  const inputPassword = makeEl('input', { id: 'user-pass', type: 'password', value: 'PASSWORD_SECRET_VALUE', placeholder: 'Enter password' });
  const inputOtp = makeEl('input', { id: 'otp-code', type: 'text', value: '884422', placeholder: 'Enter OTP' });

  // Sleepwalker UI host that MUST be ignored
  const swHost = makeEl('div', { id: 'sleepwalker-host' });
  swHost.appendChild(makeEl('h2', {}, 'Sleepwalker Internal Heading'));
  swHost.appendChild(makeEl('button', {}, 'Internal Extension Button'));
  swHost.appendChild(makeEl('p', {}, 'Extension internal helper text that must never appear in digest.'));

  main.appendChild(linkApply);
  main.appendChild(labelName);
  main.appendChild(inputName);
  main.appendChild(inputFile);
  main.appendChild(selectState);
  main.appendChild(inputPassword);
  main.appendChild(inputOtp);
  main.appendChild(btnSubmit);
  body.appendChild(swHost);

  return { doc, makeEl, main };
}

function createChromeStorageStub(initialConfig = {}) {
  const cfg = {
    sleepwalker_gemini_api_key: '',
    sleepwalker_proxy_url: '',
    sleepwalker_ollama_url: 'http://localhost:11434',
    sleepwalker_ollama_model: 'llama3.2:3b',
    sleepwalker_local_only: false,
    ...initialConfig
  };
  global.chrome = {
    storage: {
      local: {
        get: (_keys, cb) => cb(cfg)
      }
    }
  };
}

async function main() {
  console.log('=== Sleepwalker Phase 3 Test Suite ===\n');

  // Suite 1: Syntax check all P3 JS files
  await runSuite('JS Syntax & JSON Validity', () => {
    const jsFiles = ['digest.js', 'llm.js', 'explain.js', 'background.js', 'widget.js'];
    for (const f of jsFiles) {
      execSync(`node --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' });
    }
    JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const scripts = manifest.content_scripts[0].js;
    const digestIdx = scripts.indexOf('digest.js');
    const explainIdx = scripts.indexOf('explain.js');
    assert.ok(digestIdx !== -1 && explainIdx !== -1 && digestIdx < explainIdx, 'digest.js must load before explain.js in manifest.json');
  });

  // Suite 2: Digest Privacy & Element Formatting [id|type|label]
  await runSuite('Digest Privacy (no values, passwords, OTP, cookies, query strings, CSS selectors)', () => {
    const digestMod = loadModule('digest.js');
    const { doc } = createMockDom();
    const digest = digestMod.buildDigest(doc);

    assert.strictEqual(digest.urlClean, 'https://scholarships.gov.in/apply', 'Query string and hash must be stripped');
    assert.ok(digest.headings.some((h) => h.text.includes('Fees & Payment')), 'Should include page headings');
    assert.ok(!digest.headings.some((h) => h.text.includes('Sleepwalker Internal')), 'Must exclude #sleepwalker-host');
    assert.ok(!digest.elements.some((e) => e.label.includes('Internal Extension Button')), 'Must exclude extension UI buttons');

    const promptStr = digestMod.formatDigestForPrompt(digest, { maxTokens: 1500 });
    assert.ok(promptStr.includes('[1|link|Start Scholarship Application]'), 'Elements must format as [id|type|label]');
    assert.ok(promptStr.includes('[2|field|Full Applicant Name]'), 'Should label text field safely from <label for>');
    assert.ok(promptStr.includes('[3|file|Income Certificate PDF]'), 'Should classify file input safely');
    assert.ok(promptStr.includes('[5|button|Submit Application]'), 'Should include submit button');

    // Privacy assertions
    for (const secret of ['TYPED_NAME_SECRET', 'PASSWORD_SECRET_VALUE', 'COOKIE_SECRET_VALUE', 'QUERY_SECRET_123', '884422', 'Enter password', 'Enter OTP']) {
      assert.ok(!promptStr.includes(secret), `Digest prompt must NOT contain secret/sensitive text: ${secret}`);
      assert.ok(!digest.fullSafeText.includes(secret), `fullSafeText must NOT contain secret/sensitive text: ${secret}`);
    }
  });

  // Suite 3: Top-K Keyword Chunk Scoring & Strict Token Budgets
  await runSuite('Digest Keyword Scoring (Top 2-3 Chunks) & Strict Token Budgets (<=1500 / <=800 / <=1200)', () => {
    const digestMod = loadModule('digest.js');
    const { doc, makeEl, main } = createMockDom();

    // Add 25 extra verbose sections to exceed 4000 tokens
    for (let i = 1; i <= 25; i++) {
      main.appendChild(makeEl('h2', {}, `Archive Notice Batch ${i}`));
      main.appendChild(makeEl('p', {}, `${'General portal maintenance notice details word '.repeat(45)}Batch ${i}.`));
    }

    const digest = digestMod.buildDigest(doc);
    assert.ok(digest.stats.totalTextTokens > 2500, 'Synthetic page should exceed cloud budget');

    const cloudPrompt = digestMod.formatDigestForPrompt(digest, { maxTokens: 1500 });
    const ollamaPrompt = digestMod.formatDigestForPrompt(digest, { maxTokens: 800 });
    assert.ok(digestMod.estimateTokens(cloudPrompt) <= 1500, `Cloud digest exceeded 1500 tokens: ${digestMod.estimateTokens(cloudPrompt)}`);
    assert.ok(digestMod.estimateTokens(ollamaPrompt) <= 800, `Ollama digest exceeded 800 tokens: ${digestMod.estimateTokens(ollamaPrompt)}`);

    const topFeeChunks = digestMod.selectTopChunks(digest, 'kitni fee payment rupees hai', {
      maxChunks: 3,
      maxTokens: 1200
    });
    assert.ok(topFeeChunks.length >= 1 && topFeeChunks.length <= 3, 'Should return at most 3 chunks');
    assert.strictEqual(topFeeChunks[0].section, 'Fees & Payment', 'Fees & Payment chunk should rank #1 for fee query');
    const combinedTokens = digestMod.estimateTokens(topFeeChunks.map((c) => c.text).join('\n'));
    assert.ok(combinedTokens <= 1200, `Top chunks exceeded 1200 tokens: ${combinedTokens}`);
  });

  // Suite 4: LLM Cache by pageTextHash + question, JSON-only parsing, <=120 words, Ollama <=800 cap
  await runSuite('LLM Cache (pageTextHash + question), JSON-only, <=120 words & Ollama <=800 cap', async () => {
    createChromeStorageStub({
      sleepwalker_gemini_api_key: 'fake-key-123',
      sleepwalker_ollama_url: 'http://localhost:11434',
      sleepwalker_local_only: false
    });

    const llm = loadModule('llm.js');
    llm.resetLlmStateForTests();

    const fetchCalls = [];
    const verboseWords = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ');
    global.fetch = async (url, init) => {
      fetchCalls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  answer: `**Scholarship** Fee is **Rs. 500**. ${verboseWords}`,
                  referencedIds: [5],
                  followUpHint: 'Ask about required documents next.'
                })
              }]
            }
          }]
        })
      };
    };

    const res1 = await llm.handleExplainRequest({
      urlClean: 'https://scholarships.gov.in/apply',
      pageTextHash: 'hash-abc-1',
      mode: 'qa',
      query: 'what is the fee',
      lang: 'en-IN',
      digestPrompt: 'TITLE: Portal\n[5|button|Submit]',
      chunksPrompt: '[c3|Fees & Payment] Application fee is Rs. 500.'
    });

    assert.strictEqual(res1.status, 'ok');
    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(!res1.answer.includes('**'), 'Markdown symbols must be stripped');
    const wordCount = res1.answer.trim().split(/\s+/).length;
    assert.ok(wordCount <= 120, `Answer exceeded 120 words: ${wordCount}`);
    assert.deepStrictEqual(res1.referencedIds, [5]);
    assert.strictEqual(fetchCalls[0].body.generationConfig.responseMimeType, 'application/json');
    assert.ok(fetchCalls[0].body.generationConfig.temperature <= 0.2);

    // Same hash + same question (even different query param URL) MUST hit cache without calling fetch
    const res2 = await llm.handleExplainRequest({
      urlClean: 'https://scholarships.gov.in/apply?differentQuery=1',
      pageTextHash: 'hash-abc-1',
      mode: 'qa',
      query: 'what is the fee',
      lang: 'en-IN',
      digestPrompt: 'TITLE: Portal',
      chunksPrompt: 'Fee is Rs. 500.'
    });
    assert.strictEqual(res2.source, 'cache');
    assert.strictEqual(fetchCalls.length, 1, 'Cache hit must not trigger new fetch');

    // Local Ollama test: verify digest truncated <= 800 tokens
    createChromeStorageStub({
      sleepwalker_local_only: true,
      sleepwalker_ollama_url: 'http://localhost:11434'
    });
    const ollamaBodies = [];
    global.fetch = async (url, init) => {
      if (url.endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: [] }) };
      }
      const parsed = JSON.parse(init.body);
      ollamaBodies.push(parsed);
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: '{"answer":"Fee is Rs 500 before May 31.","referencedIds":[1],"followUpHint":""}' })
      };
    };

    const giantDigest = 'word '.repeat(2200); // ~2750 tokens
    const resOllama = await llm.handleExplainRequest({
      pageTextHash: 'hash-ollama-1',
      mode: 'summary',
      lang: 'en-IN',
      digestPrompt: giantDigest
    });
    assert.strictEqual(resOllama.status, 'ok');
    assert.strictEqual(resOllama.source, 'local ollama');
    assert.strictEqual(ollamaBodies[0].format, 'json');
    // Prompt sent to Ollama contains EXPLAIN_JSON_SYSTEM_PROMPT (~45 tokens) + <=800 tokens safePromptText + JSON wrapper
    const sentPromptTokens = llm.estimateTokens(ollamaBodies[0].prompt);
    assert.ok(sentPromptTokens <= 900, `Ollama prompt bloated beyond budget: ${sentPromptTokens} tokens`);

    const diag = llm.getLlmDiagnostics();
    assert.strictEqual(diag.callsTotal, 2);
    assert.strictEqual(diag.cacheHits, 1);
    assert.ok(diag.approxInputTokens > 0 && diag.approxOutputTokens > 0, 'Diagnostics must track approx tokens');
  });

  // Suite 5: Gemini HTTP 429 & Per-Minute Rate Limit Graceful Degrade
  await runSuite('Gemini 429 & RPM Rate-Limit Graceful Degrade + 3-Turn Compact Memory', async () => {
    createChromeStorageStub({
      sleepwalker_gemini_api_key: 'fake-key-429',
      sleepwalker_proxy_url: 'https://proxy.example.com/explain',
      sleepwalker_ollama_url: 'http://localhost:11434',
      sleepwalker_local_only: false
    });
    const llm = loadModule('llm.js');
    llm.resetLlmStateForTests();

    global.fetch = async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return { ok: false, status: 429, json: async () => ({}) };
      }
      if (url.endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.endsWith('/api/generate')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ response: '{"answer":"Degraded safely to local Ollama.","referencedIds":[]}' })
        };
      }
      throw new Error(`Unexpected proxy call after 429 cooldown: ${url}`);
    };

    const res429 = await llm.handleExplainRequest({
      pageTextHash: 'hash-429',
      mode: 'summary',
      lang: 'en-IN',
      digestPrompt: 'Sample page digest text'
    });
    assert.strictEqual(res429.status, 'ok');
    assert.strictEqual(res429.source, 'local ollama');
    assert.strictEqual(res429.rateLimited, true);
    assert.ok(res429.degradeMessage.includes('429') || res429.degradeMessage.toLowerCase().includes('rate limit'));

    const diagAfter429 = llm.getLlmDiagnostics();
    assert.strictEqual(diagAfter429.rateLimitEvents, 1);

    // 3-turn compact memory truncation test
    const built = llm.buildStructuredPromptForProvider({
      mode: 'summary',
      level: 'simple',
      lang: 'en-IN',
      digestPrompt: 'TITLE: Demo',
      memory: [
        { query: 'turn 1', mode: 'summary', answerSnippet: 'ans 1' },
        { query: 'turn 2', mode: 'qa', answerSnippet: 'ans 2' },
        { query: 'turn 3', mode: 'qa', answerSnippet: 'ans 3' },
        { query: 'turn 4', mode: 'qa', answerSnippet: 'ans 4' }
      ]
    }, 1500);
    assert.ok(!built.includes('turn 1'), 'Memory must only keep the latest 3 turns');
    assert.ok(built.includes('turn 2') && built.includes('turn 4'), 'Memory must keep turns 2..4');
  });

  // Suite 6: Explainer Modes, Validation, 3-Turn Memory Reset & Offline Q&A/Action Fallbacks
  await runSuite('Explainer Modes (summary, action_steps, qa, simple/child), Validator & Offline Fallback', async () => {
    const digestMod = loadModule('digest.js');
    const explainMod = loadModule('explain.js');
    const { doc } = createMockDom();
    global.document = doc;
    global.window = { location: doc.location, getComputedStyle: doc.defaultView.getComputedStyle };
    global.SleepwalkerDigest = digestMod;

    // 1. Validate numbers/dates including Devanagari numeral normalization
    const dummyWidget = {
      lang: 'en-IN',
      outline: null,
      pill: { state: 'idle', setPreparing() {}, setStatus() {}, setSpeaking() {} },
      glow: { setPreparing() {}, setReady() {}, setSpeaking() {} },
      reader: { readText() {} },
      setAssistantReply() {},
      renderDigestOverview() {}
    };
    const explainer = new explainMod.SleepwalkerExplainer(dummyWidget);
    const validKeep = explainer.validateAnswer('The fee is Rs. 500 or ₹1500 before May 31, 2026. Fake number 99999 should drop.', digestMod.buildDigest(doc).fullSafeText);
    assert.ok(validKeep.includes('500') && validKeep.includes('1500'), 'Valid numbers (incl. Devanagari normalized 1500) must survive');
    assert.ok(!validKeep.includes('99999'), 'Hallucinated sentence with 99999 must be stripped');

    // 2. Offline Q&A fallback uses top keyword chunk
    const digest = digestMod.buildDigest(doc);
    const qaOffline = explainer.generateBasicSummary(digest.fullSafeText, { mode: 'qa', query: 'what are required documents?' }, 'en-IN', digest);
    assert.ok(qaOffline.includes('Required Documents') && qaOffline.includes('Aadhaar'), 'Offline QA should answer from top Required Documents chunk');

    // 3. Offline action_steps fallback mentions steps/fees/actions
    const stepsOffline = explainer.generateBasicSummary(digest.fullSafeText, { mode: 'action_steps' }, 'en-IN', digest);
    assert.ok(stepsOffline.includes('To act on') && stepsOffline.includes('500'), 'Offline action_steps must surface fees & next actions');

    // 4. Pipeline keeps 3-turn memory and clears on pageTextHash change
    let sentPayloads = [];
    explainer._sendToBackgroundCascade = async (payload) => {
      sentPayloads.push(payload);
      return {
        status: 'ok',
        source: 'mock-cloud',
        answer: 'Apply online before May 31, 2026 with fee Rs. 500.'
      };
    };

    await explainer.runExplainPipeline({ mode: 'action_steps', level: 'standard' });
    await explainer.runExplainPipeline({ mode: 'qa', query: 'fees?', level: 'standard' });
    await explainer.runExplainPipeline({ mode: 'summary', level: 'child' });
    await explainer.runExplainPipeline({ mode: 'summary', level: 'simple' });
    assert.strictEqual(explainer.turnMemory.length, 3, 'Turn memory must cap at 3 turns');
    assert.strictEqual(sentPayloads[3].memory.length, 3, '4th request should pass 3-turn compact memory');

    // Change page text so pageTextHash changes -> memory must reset
    doc.title = 'Different Portal Page';
    explainer.getPageDigest();
    assert.strictEqual(explainer.turnMemory.length, 0, 'Turn memory must reset when pageTextHash changes');
  });

  console.log(`\nSummary: ${passedSuites}/${passedSuites + failedSuites} P3 test suites passed.`);
  if (failedSuites > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
