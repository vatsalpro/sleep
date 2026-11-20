'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SleepwalkerIntentEngine = require(path.join(ROOT, 'intent.js'));
const SleepwalkerConfirm = require(path.join(ROOT, 'confirm.js'));
const lexicon = JSON.parse(fs.readFileSync(path.join(ROOT, 'lexicon.json'), 'utf8'));
const phrasesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'phrases.json'), 'utf8'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const results = [];

  async function test(name, fn) {
    try {
      await fn();
      results.push({ name, passed: true });
      console.log(`PASS  ${name}`);
    } catch (err) {
      results.push({ name, passed: false, error: err });
      console.error(`FAIL  ${name}`);
      console.error(`      ${err && err.stack ? err.stack : err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Phrase table structural & coverage checks
  // ---------------------------------------------------------------------------
  await test('phrases.json has >= 65 phrases covering all 13 intents, EN/HI/Hinglish, and required prompt examples', () => {
    const phrases = phrasesData.phrases;
    assert(Array.isArray(phrases), 'phrases.json must have a phrases array');
    assert(phrases.length >= 65, `Expected >= 65 phrases, got ${phrases.length}`);

    const requiredPromptExamples = [
      'make me understand this',
      'mujhe samjhao ye page kya hai',
      'इसमें फीस कितनी है',
      'scholarship wala link kholo',
      'form bharo',
      'mera naam Vatsal Kumar likho',
      'photo upload karo',
      'submit kar do',
      'wapas jao',
      'neeche scroll karo',
      'dheere padho',
      'धारा २ पढ़ो',
      'um basically please read this page',
      'mujhe samjhaao'
    ];

    const phraseTexts = new Set(phrases.map((p) => p.phrase));
    for (const ex of requiredPromptExamples) {
      assert(phraseTexts.has(ex), `Missing required example in phrases.json: "${ex}"`);
    }

    const intentsSeen = new Set();
    const langsByIntent = new Map();
    const tagsSeen = new Set();

    for (const item of phrases) {
      assert(item.id && item.phrase && item.expectedIntent, `Invalid phrase entry: ${JSON.stringify(item)}`);
      assert(
        SleepwalkerIntentEngine.VALID_INTENTS.includes(item.expectedIntent),
        `Unknown expectedIntent "${item.expectedIntent}" in ${item.id}`
      );
      intentsSeen.add(item.expectedIntent);
      if (!langsByIntent.has(item.expectedIntent)) langsByIntent.set(item.expectedIntent, new Set());
      langsByIntent.get(item.expectedIntent).add(item.lang);
      if (Array.isArray(item.tags)) {
        item.tags.forEach((t) => tagsSeen.add(t));
      }
    }

    for (const intent of SleepwalkerIntentEngine.VALID_INTENTS) {
      assert(intentsSeen.has(intent), `Missing intent in phrases.json: ${intent}`);
      const langs = langsByIntent.get(intent);
      assert(langs.has('en-IN'), `Intent ${intent} missing en-IN example`);
      assert(langs.has('hi-IN'), `Intent ${intent} missing hi-IN Devanagari example`);
      assert(langs.has('hinglish'), `Intent ${intent} missing hinglish example`);
    }

    assert(tagsSeen.has('devanagari-digits'), 'Missing devanagari-digits tag');
    assert(tagsSeen.has('noisy-filler'), 'Missing noisy-filler tag');
    assert(tagsSeen.has('hinglish-variant'), 'Missing hinglish-variant tag');
    assert(tagsSeen.has('regional-fallback'), 'Missing regional-fallback tag');
  });

  // ---------------------------------------------------------------------------
  // 2. Normaliser checks
  // ---------------------------------------------------------------------------
  await test('Normaliser converts Devanagari digits to ASCII', () => {
    const engine = new SleepwalkerIntentEngine({ lexicon });
    assert.strictEqual(engine.normalise('धारा २ पढ़ो').text, 'धारा 2 पढ़ो');
    assert.strictEqual(engine.normalise('पिनकोड ११०००१ लिखो').caseClean, 'पिनकोड 110001 लिखो');
    assert.strictEqual(engine.normalise('०१२३४५६७८९').text, '0123456789');
  });

  await test('Normaliser strips noisy fillers while keeping standalone "ok" and "haan" intact', () => {
    const engine = new SleepwalkerIntentEngine({ lexicon });

    const noisy = engine.normalise('um basically please read this page');
    assert.strictEqual(noisy.text, 'read this page');
    assert(noisy.strippedFillers.includes('um'));
    assert(noisy.strippedFillers.includes('basically'));
    assert(noisy.strippedFillers.includes('please'));

    const hiNoisy = engine.normalise('arey bhai suno form bharo');
    assert.strictEqual(hiNoisy.text, 'form bharo');

    for (const word of ['ok', 'okay', 'yes', 'no', 'haan', 'nahi', 'theek hai', 'हाँ', 'नहीं']) {
      const norm = engine.normalise(word);
      assert.strictEqual(norm.text, word, `Protected word "${word}" was altered to "${norm.text}"`);
      assert.strictEqual(norm.strippedFillers.length, 0, `Protected word "${word}" had fillers stripped`);
    }
  });

  await test('Normaliser normalizes Hinglish spelling variants and preserves dictation case', async () => {
    const engine = new SleepwalkerIntentEngine({ lexicon });

    assert.strictEqual(engine.normalise('mujhe samjhaao').text, 'mujhe samjhao');
    assert.strictEqual(engine.normalise('page parho').text, 'page padho');
    assert.strictEqual(engine.normalise('vaapas jao').text, 'wapas jao');
    assert.strictEqual(engine.normalise('dubara padho').text, 'dobara padho');
    assert.strictEqual(engine.normalise('thk hai').text, 'theek hai');

    const dictNorm = engine.normalise('mera naam Vatsal Kumar likho');
    assert.strictEqual(dictNorm.caseClean, 'mera naam Vatsal Kumar likho');
    assert.strictEqual(dictNorm.text, 'mera naam vatsal kumar likho');

    const res = await engine.classify('mera naam Vatsal Kumar likho');
    assert.strictEqual(res.intent, 'DICTATE');
    assert.strictEqual(res.args.field, 'naam');
    assert.strictEqual(res.args.value, 'Vatsal Kumar');
    assert.strictEqual(res.source, 'rules');
  });

  // ---------------------------------------------------------------------------
  // 3. Full phrases.json classification + >=70% rule resolution with 0 LLM calls
  // ---------------------------------------------------------------------------
  await test('All phrases in phrases.json classify accurately and >= 70% resolve via rules with 0 LLM calls', async () => {
    const expectedMap = new Map(phrasesData.phrases.map((p) => [p.phrase, p]));
    const normProbe = new SleepwalkerIntentEngine({ lexicon });
    const normalizedMap = new Map(
      phrasesData.phrases.map((p) => [normProbe.normalise(p.phrase).text, p])
    );
    const llmLookups = [];

    const mockLlmCaller = async (payload) => {
      const compactInput = payload.text || payload.normalized || '';
      assert(typeof compactInput === 'string' && compactInput.length > 0, 'LLM payload must contain text or normalized');
      assert(compactInput.length <= 220, 'LLM payload input must be <= 220 chars');
      if (typeof payload.text === 'string') assert(payload.text.length <= 220, 'LLM payload text must be <= 220 chars');
      if (typeof payload.normalized === 'string') assert(payload.normalized.length <= 220, 'LLM payload normalized must be <= 220 chars');
      llmLookups.push(payload);
      const entry = expectedMap.get(compactInput) || normalizedMap.get(compactInput);
      if (!entry) return null;
      return {
        status: 'ok',
        intent: entry.expectedIntent,
        args: entry.expectedArgs || {},
        lang: entry.lang,
        confidence: 0.84,
        source: 'mock-llm'
      };
    };

    const engine = new SleepwalkerIntentEngine({ lexicon, llmCaller: mockLlmCaller });
    let expectedLlmCount = 0;

    for (const entry of phrasesData.phrases) {
      const beforeLlmCalls = engine.stats.llmCalls;
      const out = await engine.classify(entry.phrase, entry.context || {});

      assert.strictEqual(
        out.intent,
        entry.expectedIntent,
        `[${entry.id}] "${entry.phrase}" -> expected ${entry.expectedIntent}, got ${out.intent} (ruleId=${out.ruleId || out.source})`
      );

      assert.strictEqual(
        out.source,
        entry.expectSource,
        `[${entry.id}] "${entry.phrase}" -> expected source "${entry.expectSource}", got "${out.source}"`
      );

      if (entry.expectSource === 'rules') {
        assert.strictEqual(
          engine.stats.llmCalls,
          beforeLlmCalls,
          `[${entry.id}] "${entry.phrase}" unexpectedly triggered an LLM call`
        );
      } else {
        expectedLlmCount += 1;
        assert.strictEqual(
          engine.stats.llmCalls,
          beforeLlmCalls + 1,
          `[${entry.id}] "${entry.phrase}" did not route to LLM as expected`
        );
      }

      if (entry.expectedArgs) {
        for (const [k, v] of Object.entries(entry.expectedArgs)) {
          assert.strictEqual(
            out.args && out.args[k],
            v,
            `[${entry.id}] "${entry.phrase}" arg "${k}" expected "${v}", got "${out.args && out.args[k]}"`
          );
        }
      }
    }

    const total = phrasesData.phrases.length;
    const ruleRatio = engine.stats.ruleHits / total;
    console.log(
      `      Stats: ${engine.stats.ruleHits}/${total} (${(ruleRatio * 100).toFixed(1)}%) rule hits, ${engine.stats.llmCalls} LLM calls`
    );

    assert(ruleRatio >= 0.70, `Expected >= 70% rule hits, got ${(ruleRatio * 100).toFixed(1)}%`);
    assert.strictEqual(engine.stats.llmCalls, expectedLlmCount);
    assert.strictEqual(llmLookups.length, expectedLlmCount);
  });

  await test('IntentEngine pending-confirm context and LLM fallback resilience', async () => {
    const engine = new SleepwalkerIntentEngine({
      lexicon,
      llmCaller: async () => {
        throw new Error('Network down');
      }
    });

    const pauseNoPending = await engine.classify('ruko', { hasPendingConfirm: false });
    assert.strictEqual(pauseNoPending.intent, 'CONTROL');
    assert.strictEqual(pauseNoPending.args.action, 'pause');

    const denyPending = await engine.classify('ruko', { hasPendingConfirm: true });
    assert.strictEqual(denyPending.intent, 'CONFIRM_NO');

    const yesPending = await engine.classify('haan', { hasPendingConfirm: true });
    assert.strictEqual(yesPending.intent, 'CONFIRM_YES');

    const fallbackOut = await engine.classify('இந்தப் பக்கத்தை எனக்கு விளக்குங்கள்');
    assert.strictEqual(fallbackOut.source, 'fallback');
    assert.strictEqual(fallbackOut.intent, 'ANSWER');
  });

  // ---------------------------------------------------------------------------
  // 4. SleepwalkerConfirm tests
  // ---------------------------------------------------------------------------
  await test('SleepwalkerConfirm risk policy steps (low, medium threshold/ambiguous, high, critical)', () => {
    const c = new SleepwalkerConfirm();
    assert.strictEqual(c.getRequiredConfirmSteps({ risk: 'low' }), 0);
    assert.strictEqual(c.getRequiredConfirmSteps({ risk: 'medium', confidence: 0.8 }), 0);
    assert.strictEqual(c.getRequiredConfirmSteps({ risk: 'medium', confidence: 0.95 }), 0);
    assert.strictEqual(c.getRequiredConfirmSteps({ risk: 'medium', confidence: 0.79 }), 1);
    assert.strictEqual(c.getRequiredConfirmSteps({ risk: 'medium', confidence: 0.95, ambiguous: true }), 1);
    assert.strictEqual(c.getRequiredConfirmSteps({ risk: 'high' }), 1);
    assert.strictEqual(c.getRequiredConfirmSteps({ risk: 'critical' }), 2);

    let lowRan = false;
    const lowRes = c.request({
      risk: 'low',
      onConfirm: (info) => {
        lowRan = info.autoApproved === true;
      }
    });
    assert.deepStrictEqual(lowRes, { awaiting: false, executed: true, requiredSteps: 0 });
    assert.strictEqual(lowRan, true);
    assert.strictEqual(c.isAwaiting(), false);

    let medHighConfRan = false;
    const medHighRes = c.request({
      risk: 'medium',
      confidence: 0.85,
      onConfirm: () => {
        medHighConfRan = true;
      }
    });
    assert.strictEqual(medHighRes.executed, true);
    assert.strictEqual(medHighConfRan, true);

    let medLowConfRan = false;
    const medLowRes = c.request({
      risk: 'medium',
      confidence: 0.7,
      onConfirm: () => {
        medLowConfRan = true;
      }
    });
    assert.deepStrictEqual(medLowRes, { awaiting: true, executed: false, requiredSteps: 1 });
    assert.strictEqual(medLowConfRan, false);
    assert.strictEqual(c.isAwaiting(), true);
    c.confirm();
    assert.strictEqual(medLowConfRan, true);

    let medAmbRan = false;
    const medAmbRes = c.request({
      risk: 'medium',
      confidence: 0.99,
      ambiguous: true,
      onConfirm: () => {
        medAmbRan = true;
      }
    });
    assert.deepStrictEqual(medAmbRes, { awaiting: true, executed: false, requiredSteps: 1 });
    c.confirm();
    assert.strictEqual(medAmbRan, true);

    let highRan = false;
    const highRes = c.request({
      risk: 'high',
      onConfirm: () => {
        highRan = true;
      }
    });
    assert.deepStrictEqual(highRes, { awaiting: true, executed: false, requiredSteps: 1 });
    assert.strictEqual(highRan, false);
    c.handleResponse('haan');
    assert.strictEqual(highRan, true);
  });

  await test('SleepwalkerConfirm critical double-confirm (step 1 -> step 2 -> execute, NO on step 2 cancels)', () => {
    const c = new SleepwalkerConfirm();
    let confirmPayload = null;
    let cancelReason = null;

    const req1 = c.request({
      risk: 'critical',
      title: 'Submit Application',
      summary: ['Name: Vatsal Kumar'],
      onConfirm: (info) => {
        confirmPayload = info;
      },
      onCancel: (reason) => {
        cancelReason = reason;
      }
    });
    assert.deepStrictEqual(req1, { awaiting: true, executed: false, requiredSteps: 2 });
    assert.strictEqual(c.pending.step, 1);

    const step1Out = c.handleResponse('yes');
    assert.strictEqual(step1Out.handled, true);
    assert.deepStrictEqual(step1Out.result, { status: 'awaiting_second_confirm', step: 2, requiredSteps: 2 });
    assert.strictEqual(confirmPayload, null, 'Critical action must NOT execute on step 1');
    assert.strictEqual(c.isAwaiting(), true);

    const step2Out = c.handleResponse('haan');
    assert.strictEqual(step2Out.handled, true);
    assert.deepStrictEqual(step2Out.result, { status: 'confirmed', stepCount: 2 });
    assert.deepStrictEqual(confirmPayload, { autoApproved: false, selectedOption: null, stepCount: 2 });
    assert.strictEqual(cancelReason, null);
    assert.strictEqual(c.isAwaiting(), false);

    // Now test NO on step 2 cancels cleanly without executing
    let confirmed2 = false;
    let cancelled2Reason = null;
    c.request({
      risk: 'critical',
      onConfirm: () => {
        confirmed2 = true;
      },
      onCancel: (reason) => {
        cancelled2Reason = reason;
      }
    });

    assert.strictEqual(c.handleResponse('ok').result.status, 'awaiting_second_confirm');
    const denyStep2 = c.handleResponse('nahi');
    assert.strictEqual(denyStep2.handled, true);
    assert.deepStrictEqual(denyStep2.result, { status: 'cancelled', reason: 'user_denied' });
    assert.strictEqual(confirmed2, false);
    assert.strictEqual(cancelled2Reason, 'user_denied');
    assert.strictEqual(c.isAwaiting(), false);
  });

  await test('SleepwalkerConfirm timeout auto-cancel (including step 2 timeout)', async () => {
    const c = new SleepwalkerConfirm({ timeoutMs: 40 });
    let cancelledReason = null;
    let confirmed = false;

    c.request({
      risk: 'high',
      timeoutMs: 40,
      onConfirm: () => {
        confirmed = true;
      },
      onCancel: (reason) => {
        cancelledReason = reason;
      }
    });
    assert.strictEqual(c.isAwaiting(), true);
    await sleep(110);
    assert.strictEqual(c.isAwaiting(), false);
    assert.strictEqual(confirmed, false);
    assert.strictEqual(cancelledReason, 'timeout');

    // Critical step 1 confirmed, then step 2 times out
    let criticalCancelled = null;
    let criticalConfirmed = false;
    c.request({
      risk: 'critical',
      timeoutMs: 40,
      onConfirm: () => {
        criticalConfirmed = true;
      },
      onCancel: (reason) => {
        criticalCancelled = reason;
      }
    });
    assert.strictEqual(c.handleResponse('yes').result.status, 'awaiting_second_confirm');
    await sleep(110);
    assert.strictEqual(c.isAwaiting(), false);
    assert.strictEqual(criticalConfirmed, false);
    assert.strictEqual(criticalCancelled, 'timeout');
  });

  await test('SleepwalkerConfirm EN/HI/Hinglish yes/no parsing & disambiguation options', () => {
    const c = new SleepwalkerConfirm();

    for (const y of ['yes', 'ok', 'okay', 'confirm', 'haan', 'theek hai', 'kar do', 'हां', 'हाँ', 'ठीक है', 'जी हां']) {
      assert.strictEqual(c.parseYesNo(y), 'yes', `Expected "${y}" to parse as yes`);
    }
    for (const n of ['no', 'cancel', 'nahi', 'mat karo', 'rehne do', 'ruko', 'नहीं', 'मत करो', 'रद्द करो']) {
      assert.strictEqual(c.parseYesNo(n), 'no', `Expected "${n}" to parse as no`);
    }
    assert.strictEqual(c.parseYesNo('what is the fee'), null);

    let chosen = null;
    c.request({
      risk: 'high',
      options: ['Scholarship Form', 'Fee Receipt'],
      onConfirm: (info) => {
        chosen = info.selectedOption;
      }
    });
    const pick = c.handleResponse({ intent: 'ANSWER', raw: '2' });
    assert.strictEqual(pick.handled, true);
    assert.strictEqual(chosen, 'Fee Receipt');
  });

  await test('SleepwalkerConfirm plan stepper capped at max 5 steps and completes/cancels cleanly', async () => {
    assert.strictEqual(SleepwalkerConfirm.MAX_PLAN_STEPS, 5);
    const c = new SleepwalkerConfirm({ timeoutMs: 2000 });

    const executedLabels = [];
    let completedPlan = null;

    const sevenSteps = [
      { label: 'Step 1: Name', risk: 'medium', confidence: 0.7 },
      { label: 'Step 2: Email', risk: 'medium', confidence: 0.7 },
      { label: 'Step 3: Phone', risk: 'medium', confidence: 0.7 },
      { label: 'Step 4: Upload Photo', risk: 'high' },
      { label: 'Step 5: Submit Form', risk: 'critical' },
      { label: 'Step 6: Should Be Truncated', risk: 'low' },
      { label: 'Step 7: Should Be Truncated', risk: 'low' }
    ];

    const plan = c.startPlan({
      title: 'Apply Guided Plan',
      steps: sevenSteps,
      onExecuteStep: async (step) => {
        executedLabels.push(step.label);
        return true;
      },
      onComplete: (p) => {
        completedPlan = p;
      }
    });

    assert.strictEqual(plan.steps.length, 5, 'Plan must be capped at 5 steps');
    assert.strictEqual(c.isPlanActive(), true);

    // Step 1..4 require 1 confirm each
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(c.isAwaiting(), true);
      c.handleResponse('yes');
      await sleep(10);
    }

    // Step 5 is critical -> requires 2 confirms
    assert.strictEqual(c.isAwaiting(), true);
    assert.strictEqual(c.pending.requiredSteps, 2);
    assert.strictEqual(c.handleResponse('yes').result.status, 'awaiting_second_confirm');
    assert.strictEqual(c.handleResponse('haan').result.status, 'confirmed');
    await sleep(15);

    assert.strictEqual(executedLabels.length, 5);
    assert.strictEqual(plan.status, 'done');
    assert.strictEqual(c.isPlanActive(), false);
    assert(completedPlan, 'onComplete must be invoked after step 5');

    // Cancellation mid-plan
    let planCancelledReason = null;
    c.startPlan({
      title: 'Cancelable Plan',
      steps: [
        { label: 'Step A', risk: 'high' },
        { label: 'Step B', risk: 'high' }
      ],
      onCancel: (reason) => {
        planCancelledReason = reason;
      }
    });
    c.handleResponse('nahi');
    assert.strictEqual(c.plan.status, 'cancelled');
    assert.strictEqual(planCancelledReason, 'user_denied');
    assert.strictEqual(c.isPlanActive(), false);
  });

  // ---------------------------------------------------------------------------
  // 5. Proxy checks (NO gemini-1.5-flash-latest + HTTP 500 without GEMINI_MODEL)
  // ---------------------------------------------------------------------------
  await test('proxy/worker.js and proxy/api/explain.js contain NO "gemini-1.5-flash-latest"', () => {
    const workerSrc = fs.readFileSync(path.join(ROOT, 'proxy', 'worker.js'), 'utf8');
    const explainSrc = fs.readFileSync(path.join(ROOT, 'proxy', 'api', 'explain.js'), 'utf8');

    assert(
      !workerSrc.includes('gemini-1.5-flash-latest'),
      'proxy/worker.js still contains retired "gemini-1.5-flash-latest"'
    );
    assert(
      !explainSrc.includes('gemini-1.5-flash-latest'),
      'proxy/api/explain.js still contains retired "gemini-1.5-flash-latest"'
    );
  });

  await test('proxy/worker.js default.fetch returns HTTP 500 when env.GEMINI_MODEL is missing or blank', async () => {
    const workerMod = await import(pathToFileURL(path.join(ROOT, 'proxy', 'worker.js')).href);
    const worker = workerMod.default;
    assert(worker && typeof worker.fetch === 'function', 'worker.js must export default.fetch');

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('Upstream fetch must not be called when GEMINI_MODEL is missing');
    };

    try {
      for (const env of [{ GEMINI_API_KEY: 'dummy-key' }, { GEMINI_API_KEY: 'dummy-key', GEMINI_MODEL: '   ' }]) {
        const req = new Request('https://sleepwalker-proxy.test/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'chrome-extension://sleepwalker-test',
            'CF-Connecting-IP': `10.0.0.${Math.floor(Math.random() * 200) + 1}`
          },
          body: JSON.stringify({ text: 'Sample scholarship page text', lang: 'en-IN' })
        });

        const res = await worker.fetch(req, env);
        assert.strictEqual(res.status, 500, `Expected HTTP 500, got ${res.status}`);
        assert(res.headers.get('Access-Control-Allow-Origin'), 'Missing CORS header on 500 response');
        const body = await res.json();
        assert(body && /GEMINI_MODEL/i.test(body.error || ''), `Expected error mentioning GEMINI_MODEL, got ${JSON.stringify(body)}`);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test('proxy/api/explain.js handler returns HTTP 500 when process.env.GEMINI_MODEL is missing or blank', async () => {
    const explainMod = await import(pathToFileURL(path.join(ROOT, 'proxy', 'api', 'explain.js')).href);
    const handler = explainMod.default;
    assert.strictEqual(typeof handler, 'function', 'proxy/api/explain.js must export default handler');

    const origFetch = globalThis.fetch;
    const prevKey = process.env.GEMINI_API_KEY;
    const prevModel = process.env.GEMINI_MODEL;

    globalThis.fetch = async () => {
      throw new Error('Upstream fetch must not be called when GEMINI_MODEL is missing');
    };

    try {
      process.env.GEMINI_API_KEY = 'dummy-key';

      for (const modelVal of [undefined, '   ']) {
        if (modelVal === undefined) {
          delete process.env.GEMINI_MODEL;
        } else {
          process.env.GEMINI_MODEL = modelVal;
        }

        const resState = { statusCode: null, headers: {}, body: null, ended: false };
        const req = {
          method: 'POST',
          headers: {
            origin: 'chrome-extension://sleepwalker-test',
            'x-forwarded-for': `10.0.1.${Math.floor(Math.random() * 200) + 1}`
          },
          socket: { remoteAddress: '127.0.0.1' },
          body: { text: 'Sample scholarship page text', lang: 'en-IN' }
        };
        const res = {
          setHeader(k, v) {
            resState.headers[k] = v;
          },
          status(code) {
            resState.statusCode = code;
            return this;
          },
          json(obj) {
            resState.body = obj;
            resState.ended = true;
            return this;
          },
          end() {
            resState.ended = true;
            return this;
          }
        };

        await handler(req, res);
        assert.strictEqual(resState.statusCode, 500, `Expected HTTP 500, got ${resState.statusCode}`);
        assert(resState.headers['Access-Control-Allow-Origin'], 'Missing CORS header on 500 response');
        assert(
          resState.body && /GEMINI_MODEL/i.test(resState.body.error || ''),
          `Expected error mentioning GEMINI_MODEL, got ${JSON.stringify(resState.body)}`
        );
      }
    } finally {
      globalThis.fetch = origFetch;
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
      if (prevModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = prevModel;
    }
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\nSummary: ${passed}/${results.length} test suites passed, ${failed} failed.`);

  // Explicit exit avoids hanging on proxy/worker.js module-level rate-limit cleanup setInterval.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
