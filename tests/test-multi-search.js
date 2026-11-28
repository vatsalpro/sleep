const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { buildVoiceCorpus } = require('./phrases');
const { runDynamicAndStressSuite } = require('./dynamic-and-stress');

const EXT_DIR = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(__dirname, '.pw-profile-multisearch');

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      const exe = path.join(base, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

function runVoiceCorpus(flagOn) {
  const vm = require('vm');
  const voiceCode = fs.readFileSync(path.join(EXT_DIR, 'src/voice/voice.js'), 'utf8');
  const sandbox = {
    window: { __SW_SMART_MULTI_SEARCH__: flagOn },
    document: { addEventListener: () => {} },
    navigator: {},
    chrome: undefined,
    console, setTimeout, clearTimeout
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(voiceCode, sandbox);
  const voice = new sandbox.window.SleepwalkerVoice();
  const corpus = buildVoiceCorpus();
  let passed = 0;
  for (const row of corpus) {
    const res = voice.parseCommand(row.input);
    if ((row.expectedTypes || []).includes(res.type)) passed += 1;
  }
  return { passed, total: corpus.length };
}

async function runMultiSearchFixtureTests(browser) {
  const html = fs.readFileSync(path.join(__dirname, 'multi-search-test.html'), 'utf8');
  const navCode = fs.readFileSync(path.join(EXT_DIR, 'src/engine/navigate.js'), 'utf8');
  const matchCode = fs.readFileSync(path.join(EXT_DIR, 'src/engine/match.js'), 'utf8');

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(html);
  await page.addScriptTag({ content: matchCode });
  await page.addScriptTag({ content: navCode });

  const results = await page.evaluate(async () => {
    const out = {};
    let llmCalls = 0;
    let lastLlmPayload = null;
    const nav = new window.SleepwalkerNavigator(null, {
      highlightDurationMs: 0,
      smartMultiSearchEnabled: true,
      ollamaSearchCaller: async (payload) => {
        llmCalls += 1;
        lastLlmPayload = payload;
        return { status: 'ollama_unavailable', message: 'mocked' };
      }
    });

    // Test 1: Generic search with autofocused overlay "Search languages", table filter, mobile dup, and comment trap
    // Must pick #header-search deterministically with 0 LLM calls!
    const r1 = await nav.executeSearch('quantum physics', { rawCommand: 'search quantum physics', smartMultiSearchEnabled: true });
    out.t1 = { status: r1.status, elementId: r1.elementId, source: r1.selectionSource, llmCalls, resultText: document.getElementById('search-results').textContent };

    // Test 2: Explicit scope match ("in 70 languages search hindi") must pick #lang-search
    document.getElementById('search-results').textContent = '';
    const r2 = await nav.executeSearch('hindi', { rawCommand: 'in 70 languages search hindi', scopeHint: '70 languages', smartMultiSearchEnabled: true });
    out.t2 = { status: r2.status, elementId: r2.elementId, source: r2.selectionSource, resultText: document.getElementById('search-results').textContent };

    // Test 3: Explicit table filter qualifier ("filter table rows for alpha") must pick #table-filter
    document.getElementById('search-results').textContent = '';
    const r3 = await nav.executeSearch('alpha', { rawCommand: 'filter table rows for alpha', smartMultiSearchEnabled: true });
    out.t3 = { status: r3.status, elementId: r3.elementId, source: r3.selectionSource, resultText: document.getElementById('search-results').textContent };

    // Test 4: Explicit qualifier "top search" picks #header-search
    document.getElementById('search-results').textContent = '';
    const r4 = await nav.executeSearch('mars', { rawCommand: 'use top search for mars', smartMultiSearchEnabled: true });
    out.t4 = { status: r4.status, elementId: r4.elementId, source: r4.selectionSource };

    // Test 5: Comment box must be heavily penalized (lowest score)
    const cands = nav.findSearchCandidates(document, '', { preserveDomOrder: true });
    const scored = nav._scoreMultiSearchCandidates(cands, document, { userCommand: 'search planets', query: 'planets' }).scored;
    const commentEntry = scored.find((s) => s.candidate.element.id === 'comment-box');
    const headerEntry = scored.find((s) => s.candidate.element.id === 'header-search');
    const langEntry = scored.find((s) => s.candidate.element.id === 'lang-search');
    out.t5 = {
      headerScore: headerEntry && headerEntry.smartScore,
      langScore: langEntry && langEntry.smartScore,
      commentScore: commentEntry ? commentEntry.smartScore : 'excluded',
      langInOverlay: langEntry && langEntry.inOverlay
    };

    // Test 6: 2 equally-scored candidates -> ask by voice naming them, NEVER call LLM!
    const twoPage = document.createElement('div');
    document.body.innerHTML = `
      <main style="display:flex;gap:20px;padding:40px;">
        <form><input id="boxA" type="search" placeholder="Search Books" aria-label="Search Books" style="width:240px;height:36px;"></form>
        <form><input id="boxB" type="search" placeholder="Search Authors" aria-label="Search Authors" style="width:240px;height:36px;"></form>
      </main>`;
    llmCalls = 0;
    const r6 = await nav.executeSearch('tolkien', { rawCommand: 'search tolkien', smartMultiSearchEnabled: true });
    out.t6 = { status: r6.status, question: r6.clarificationQuestion, source: r6.selectionSource, llmCalls };

    // Test 7: Remembered per-site choice after user picks boxB, then re-runs "search dune"
    const bCand = nav.findSearchCandidates(document, '', { preserveDomOrder: true }).find((c) => c.element.id === 'boxB');
    document.getElementById('boxB').form.addEventListener('submit', (e) => { e.preventDefault(); });
    await nav.executeSearch('tolkien', { chosenCandidate: bCand, smartMultiSearchEnabled: true, rememberChoice: true });
    const r7 = await nav.executeSearch('dune', { rawCommand: 'search dune', smartMultiSearchEnabled: true });
    out.t7 = { status: r7.status, elementId: r7.elementId, source: r7.selectionSource };

    // Test 8: Single-candidate page follows old code path unchanged
    document.body.innerHTML = `<form id="sf"><input id="only-search" type="search" placeholder="Search"><button type="submit">Go</button></form>`;
    document.getElementById('sf').addEventListener('submit', (e) => e.preventDefault());
    const r8 = await nav.executeSearch('hello', { rawCommand: 'search hello', smartMultiSearchEnabled: true });
    out.t8 = { status: r8.status, elementId: r8.elementId, source: r8.selectionSource };

    // Test 9: 3 equally-scored ambiguous candidates -> LLM receives ONLY top 3
    document.body.innerHTML = `
      <main style="display:flex;gap:12px;padding:40px;">
        <input id="c1" type="search" placeholder="Search Docs" aria-label="Search Docs" style="width:200px;height:32px;">
        <input id="c2" type="search" placeholder="Search Issues" aria-label="Search Issues" style="width:200px;height:32px;">
        <input id="c3" type="search" placeholder="Search Pulls" aria-label="Search Pulls" style="width:200px;height:32px;">
        <input id="c4" type="search" placeholder="Search Releases" aria-label="Search Releases" style="width:200px;height:32px;">
      </main>`;
    nav._siteSearchMemory.clear();
    try { localStorage.removeItem('sw_multi_search_pref_v1'); } catch (_e) {}
    llmCalls = 0;
    lastLlmPayload = null;
    const r9 = await nav.executeSearch('hooks', { rawCommand: 'search hooks', smartMultiSearchEnabled: true });
    out.t9 = {
      status: r9.status,
      source: r9.selectionSource,
      llmCalls,
      sentCandidateCount: lastLlmPayload && lastLlmPayload.candidates ? lastLlmPayload.candidates.length : 0,
      shownCount: r9.candidates ? r9.candidates.length : 0
    };

    return out;
  });

  await page.close();
  return results;
}

async function runDynamicWithFlag(flagOn) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR + (flagOn ? '-on' : '-off'), {
    executablePath: findChromium(),
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const sendToTab = (worker, tabId, msg, timeoutMs = 12000) =>
    worker.evaluate(async ({ tabId, msg, timeoutMs }) => {
      return await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
          clearTimeout(t);
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(resp || { ok: false, error: 'empty' });
        });
      });
    }, { tabId, msg, timeoutMs });
  const getTabId = (url) => sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => t.url && t.url.startsWith(u.split('#')[0])) || tabs.find((t) => t.active);
    return hit ? hit.id : null;
  }, url);

  const page = await ctx.newPage();
  if (flagOn) {
    await page.addInitScript(() => { window.__SW_SMART_MULTI_SEARCH__ = true; });
  }
  const dyn = await runDynamicAndStressSuite(page, sw, getTabId, sendToTab);
  await ctx.close();
  return dyn;
}

(async () => {
  console.log('=== 1. Multi-Search Fixture Tests (Flag ON) ===');
  const headlessBrowser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const fx = await runMultiSearchFixtureTests(headlessBrowser);
  await headlessBrowser.close();
  console.log(JSON.stringify(fx, null, 2));

  assert.strictEqual(fx.t1.elementId, 'header-search', 'T1 must pick header-search over autofocused lang-search');
  assert.strictEqual(fx.t1.llmCalls, 0, 'T1 must NOT call LLM');
  assert.strictEqual(fx.t2.elementId, 'lang-search', 'T2 must pick lang-search on explicit scope');
  assert.strictEqual(fx.t3.elementId, 'table-filter', 'T3 must pick table-filter on explicit scope');
  assert.strictEqual(fx.t4.elementId, 'header-search', 'T4 top search qualifier must pick header-search');
  assert.ok(fx.t5.langInOverlay === true && fx.t5.headerScore > fx.t5.langScore, 'T5 overlay lang-search penalized below header-search');
  assert.strictEqual(fx.t6.status, 'ambiguous', 'T6 2 equal candidates must clarify');
  assert.strictEqual(fx.t6.llmCalls, 0, 'T6 must NOT call LLM for 2 candidates');
  assert.ok(/Search Books or Search Authors\?/i.test(fx.t6.question), 'T6 must name both candidates');
  assert.strictEqual(fx.t7.elementId, 'boxB', 'T7 must reuse remembered per-site choice boxB');
  assert.strictEqual(fx.t7.source, 'remembered_site_choice', 'T7 source must be remembered_site_choice');
  assert.strictEqual(fx.t8.source, 'single_candidate', 'T8 single-candidate must follow old path unchanged');
  assert.strictEqual(fx.t9.sentCandidateCount, 3, 'T9 must send ONLY top 3 candidates to LLM');
  assert.strictEqual(fx.t9.shownCount, 3, 'T9 must show numbered labels on top 3');
  console.log('PASS: All 9 multi-search fixture assertions passed!');

  console.log('\n=== 2. 350-Phrase Voice Corpus (Flag OFF vs ON) ===');
  const vcOff = runVoiceCorpus(false);
  const vcOn = runVoiceCorpus(true);
  console.log(`Voice Corpus Flag OFF: ${vcOff.passed}/${vcOff.total}`);
  console.log(`Voice Corpus Flag ON : ${vcOn.passed}/${vcOn.total}`);
  assert.strictEqual(vcOff.passed, vcOn.passed, 'Voice corpus must have zero regressions');

  console.log('\n=== 3. Dynamic & Stress Suite (Flag OFF vs ON) ===');
  const dynOff = await runDynamicWithFlag(false);
  const dynOn = await runDynamicWithFlag(true);
  const passOff = dynOff.results.filter((r) => r.ok).length;
  const passOn = dynOn.results.filter((r) => r.ok).length;
  console.log(`Dynamic/Stress Flag OFF: ${passOff}/${dynOff.results.length}`);
  if (dynOff.failures.length) console.log('OFF failures:', dynOff.failures);
  console.log(`Dynamic/Stress Flag ON : ${passOn}/${dynOn.results.length}`);
  if (dynOn.failures.length) console.log('ON failures:', dynOn.failures);
  assert.strictEqual(passOff, dynOff.results.length, 'Dynamic/Stress Flag OFF must pass 100%');
  assert.strictEqual(passOn, dynOn.results.length, 'Dynamic/Stress Flag ON must pass 100%');
  console.log('\nALL MULTI-SEARCH + FLAG OFF/ON COMPARISON TESTS PASSED!');
})();
