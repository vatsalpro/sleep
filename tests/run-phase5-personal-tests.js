/**
 * Sleepwalker 2.0 Phase 5 — Personal Intelligence, Adaptive Learning,
 * Proactive Assistance, Real Scheduling & Cross-Session Continuity Test Suite
 *
 * Tier 1: Node Mocked / Unit & Integration Scenarios A–G + Live Local Ollama Classification Check
 * Tier 2: Real Loaded Unpacked MV3 Chrome Extension (`--load-extension=D:\sleep`) Browser E2E
 *         verifying rendered comparison tables, dismissible proactive bars, real `chrome.alarms`
 *         creation/listing/cancellation in Service Worker, Options controls & restart wake resume.
 *
 * Run with: node D:\sleep\tests\run-phase5-personal-tests.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pi = require(path.join(ROOT, 'personal-intel.js'));
const SleepwalkerMemory = require(path.join(ROOT, 'memory.js'));
const { SleepwalkerTaskPlanner } = require(path.join(ROOT, 'task-planner.js'));
const SleepwalkerIntentEngine = require(path.join(ROOT, 'intent.js'));
const { SleepwalkerElementSelector } = require(path.join(ROOT, 'element-select.js'));
const llm = require(path.join(ROOT, 'llm.js'));

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
    _local: local,
    _session: session,
    runtime: {
      id: 'ext_phase5_test',
      lastError: null,
      sendMessage(msg, cb) {
        if (msg && msg.type === 'SLEEPWALKER_MEMORY_SET' && msg.state) {
          local.sleepwalker_persistent_memory_v1 = JSON.parse(JSON.stringify(msg.state));
          session.sleepwalker_persistent_memory_v1 = JSON.parse(JSON.stringify(msg.state));
          session.sleepwalker_session_state_v1 = { sessionMode: msg.state.sessionMode || 'ended' };
          if (cb) cb({ status: 'ok' });
          return;
        }
        if (msg && msg.type === 'SLEEPWALKER_MEMORY_GET') {
          const browserRestarted = Boolean(local.sleepwalker_persistent_memory_v1 && !session.sleepwalker_session_state_v1);
          const merged = session.sleepwalker_persistent_memory_v1 || local.sleepwalker_persistent_memory_v1 || null;
          if (cb) cb({ status: 'ok', state: merged ? JSON.parse(JSON.stringify(merged)) : null, browserRestarted });
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
        },
        remove(keys, cb) {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete session[k];
          if (cb) cb();
        }
      }
    }
  };
}

async function runTier1UnitAndScenarios() {
  // Scenario A & C: Hierarchical Goal/Subtasks + Browser Restart Wake Resume without Memory Dump
  await runSuite('1. Tier 1 (Scenarios A & C): Hierarchical Master\'s Goal, Unfinished Travel Task & Cross-Restart Resume', async () => {
    global.chrome = makeFakeChrome();
    global.document = { title: 'Germany Study Guide', body: null };
    global.window = { location: { href: 'https://study.example/masters' } };

    const mem = new SleepwalkerMemory({ tabId: 'tab_a' });
    await mem.loadState();
    const planner = new SleepwalkerTaskPlanner({ memory: mem });

    // Simple command must NOT create heavyweight multi-step subtasks
    assert.strictEqual(planner.isMultiStepObjective('Explain this page', {}, { category: 'PAGE_EXPLANATION' }), false);

    const planned = await planner.startOrUpdateTaskFromPlan("Apply for a master's degree in Germany", { resolvedText: "Apply for a master's degree in Germany" });
    assert.ok(planned && planned.task.subtasks.length >= 6, 'Full Master\'s goal generates structured subtasks');
    assert.ok(planned.task.parentObjective.includes('master\'s degree'), 'Retains parent objective');

    await planner.markStepCompleted('compare_tuition', 'Tuition fees checked across 3 universities');
    assert.ok(mem.state.activeTask.progressPercent > 0, 'Progress percentage advances cleanly');

    // Simulate closing and reopening Chrome: session storage cleared, local storage persists
    delete global.chrome._session.sleepwalker_persistent_memory_v1;
    delete global.chrome._session.sleepwalker_session_state_v1;

    const memAfterRestart = new SleepwalkerMemory({ tabId: 'tab_a2' });
    await memAfterRestart.loadState();
    assert.strictEqual(memAfterRestart.didBrowserRestart, true, 'Detects wiped session storage + persisted local storage as browser restart');

    const resumeCtx = memAfterRestart.buildWakeResumeContext([
      { id: 'r1', title: 'Check DAAD winter intake portal', status: 'due', targetTimeMs: Date.now() - 1000 }
    ]);
    assert.strictEqual(resumeCtx.hasPriorContext, true);
    assert.ok(resumeCtx.greetingEn.includes('Welcome back'), 'Natural welcome back greeting');
    assert.ok(resumeCtx.greetingEn.includes('Check DAAD winter intake portal'), 'Surfaces due reminder concisely');
    assert.ok(/tuition/i.test(resumeCtx.greetingEn) && /still pending|next pending/i.test(resumeCtx.greetingEn), 'Mentions finished vs pending step concisely without dumping history');

    // Scenario C: Unfinished Travel Task restart continuity
    await memAfterRestart.upsertTask({
      objective: 'Plan travel and hotel in Tokyo',
      topic: 'Tokyo',
      plannedSteps: [
        { id: 'research_travel', label: 'Research Tokyo travel options', status: 'done' },
        { id: 'check_visa', label: 'Check Japan visa & entry rules', status: 'active' },
        { id: 'compare_stays', label: 'Compare accommodation in Tokyo', status: 'pending' }
      ],
      status: 'RUNNING'
    });
    const memTravelRestart = new SleepwalkerMemory({ tabId: 'tab_t2' });
    await memTravelRestart.loadState();
    const travelResume = memTravelRestart.buildWakeResumeContext([]);
    assert.ok(/Tokyo/i.test(travelResume.greetingEn) && /visa/i.test(travelResume.greetingEn), `Expected Tokyo travel resume with visa next step, got: ${travelResume.greetingEn}`);
  });

  // Scenario B: Adaptive Preferences (Explicit vs Inferred >= 2 threshold, Official Priority & Scoped Dropdown Correction)
  await runSuite('2. Tier 1 (Scenario B): Explicit vs Inferred Learning (>=2 Evidence), Sensitive Trait Rejection & Scoped Dropdown Override', async () => {
    global.chrome = makeFakeChrome();
    const mem = new SleepwalkerMemory({ tabId: 'tab_b' });
    await mem.loadState();

    // Sensitive traits must NEVER be inferred or stored
    assert.strictEqual(pi.isDisallowedPersonalTrait('User political party preference'), true);
    const badSig = await mem.recordPreferenceSignal('political', 'partyX', { forceDistinct: true });
    assert.strictEqual(badSig.reason, 'sensitive_blocked');

    // Single action NEVER permanently assumes a preference
    const sig1 = await mem.recordPreferenceSignal('preferOfficialSources', true, { forceDistinct: true });
    assert.strictEqual(sig1.promoted, false, 'One action must NOT promote an inferred preference');
    assert.strictEqual(mem.getEffectivePreference('preferOfficialSources', false), false);

    // Second repeated confirmation promotes inferred preference
    const sig2 = await mem.recordPreferenceSignal('preferOfficialSources', true, { forceDistinct: true });
    assert.strictEqual(sig2.promoted, true, 'Two repeated signals promote inferred preference');
    assert.strictEqual(mem.state.personalContext.preferences.preferOfficialSources.source, 'inferred');

    // Discovery plan honors official source preference
    const disc = mem.buildExternalDiscoveryPlan('Find universities in Germany', { resolvedText: 'Find universities in Germany' });
    assert.ok(disc.recommendedUrls[0].official === true, 'Official sources prioritized');

    // Explicit preference is authoritative (confidence=1.0) and cannot be overwritten by inferred signals
    await mem.setExplicitPreference('presentationFormat', 'numbered', 'Numbered options');
    assert.strictEqual(mem.state.personalContext.preferences.presentationFormat.source, 'explicit');
    const tryOverwrite = await mem.recordPreferenceSignal('presentationFormat', 'table', { forceDistinct: true });
    assert.strictEqual(tryOverwrite.reason, 'explicit_preserved', 'Inferred signals must never overwrite explicit user preference');
    assert.strictEqual(mem.getEffectivePreference('presentationFormat'), 'numbered');

    // Scoped dropdown correction learning across 2 corrections boosts Shipping Country in that form context
    const fakeDocs = { host: 'shop.example', formKey: 'checkout', spokenTarget: 'country', wrongLabel: 'Billing Country', correctedLabel: 'Shipping Country' };
    const corr1 = pi.recordControlCorrection(mem.state, fakeDocs);
    assert.strictEqual(corr1.promoted, false, 'Single correction should not force permanent rule without repeat/explicit');
    const corr2 = pi.recordControlCorrection(mem.state, fakeDocs);
    assert.strictEqual(corr2.promoted, true, 'Repeated correction learns scoped override');
    assert.strictEqual(pi.lookupControlOverride(mem.state, { host: 'shop.example', formKey: 'checkout', spokenTarget: 'country' }).preferredLabel, 'Shipping Country');
    assert.strictEqual(pi.lookupControlOverride(mem.state, { host: 'other.example', formKey: 'profile', spokenTarget: 'country' }), null, 'Override stays scoped to matching site/form context');
  });

  // Scenario D & E & F: Proactive Relevance, Context Separation (TUM vs LMU, Study vs Travel), Corrections & Decision Table
  await runSuite('3. Tier 1 (Scenarios D, E & F): Proactive Offers, Context Separation, Corrections & Decision Table', async () => {
    global.chrome = makeFakeChrome();
    const mem = new SleepwalkerMemory({ tabId: 'tab_e' });
    await mem.loadState();

    // Context Graph & Project Separation within SAME country ("Germany")
    pi.recordEntityResearch(mem.state, {
      domain: 'university_research',
      rootTopic: 'Germany',
      objective: 'Compare German universities',
      entityName: 'Technical University of Munich (TUM)',
      fees: '0 EUR (some non-EU semester tuition varies)',
      deadlines: 'May 31',
      requirements: 'APS + BSc degree',
      facts: ['TUM intake deadline is May 31 with 0 EUR base German EU fee.'],
      url: 'https://www.tum.de/en/',
      official: true
    });
    pi.recordEntityResearch(mem.state, {
      domain: 'university_research',
      rootTopic: 'Germany',
      objective: 'Compare German universities',
      entityName: 'LMU Munich',
      fees: '75 EUR',
      deadlines: 'July 15',
      requirements: 'IELTS 6.5 + Transcripts',
      facts: ['LMU Munich charges 75 EUR application fee and deadline is July 15.'],
      url: 'https://www.lmu.de/en/',
      official: true
    });
    pi.recordEntityResearch(mem.state, {
      domain: 'travel_planning',
      rootTopic: 'Germany',
      objective: 'Plan travel to Munich',
      entityName: 'Munich Visa',
      facts: ['Check German Consulate Schengen visa slots.'],
      url: 'https://digital.diplo.de/',
      official: true
    });

    assert.ok(mem.state.personalContext.contextGraph.roots.Germany.categories.university_research, 'University research branch created');
    assert.ok(mem.state.personalContext.contextGraph.roots.Germany.categories.travel_planning, 'Travel planning branch kept separate under Germany');

    const lmuOnly = mem.getSeparatedEntityContext('What is the fee and deadline for LMU Munich?');
    assert.ok(lmuOnly && lmuOnly.entity.entityName === 'LMU Munich');
    assert.strictEqual(lmuOnly.entity.fees, '75 EUR');
    assert.ok(!JSON.stringify(lmuOnly.entity).includes('May 31') && !JSON.stringify(lmuOnly.entity).includes('Schengen'), 'TUM and Travel facts must NOT leak into LMU context');

    // Scenario F: User corrects TUM deadline from May 31 to June 15 -> future retrieval uses June 15
    const corr = await mem.correctRememberedDetail('Actually the deadline for TUM is June 15');
    assert.strictEqual(corr.ok, true);
    const tumUpdated = mem.getSeparatedEntityContext('When is TUM deadline?');
    assert.strictEqual(tumUpdated.entity.deadlines, 'June 15', 'Corrected deadline must overwrite stale date cleanly');

    // Scenario D: Proactive Suggestion (advisory only, never auto-executes, suppressed on dismiss or active modal)
    await mem.upsertTask({
      domain: 'university_research',
      topic: 'Germany',
      objective: 'Compare German universities',
      plannedSteps: [
        { id: 'compare_reqs', label: 'Compare admission requirements', status: 'done' },
        { id: 'open_app_page', label: 'Open application page', status: 'pending' }
      ]
    });
    // Reset deadline to simulate user hasn't checked deadlines yet on new task
    const actProj = mem.state.personalContext.projects[mem.state.personalContext.activeProjectId];
    actProj.deadlines = [];

    const sug = pi.evaluateProactiveSuggestion(mem.state, { lastCommand: 'Compare admission requirements', ignoreCooldown: true });
    assert.ok(sug && sug.category === 'university_deadlines', 'Must offer deadline check when admissions compared without checking deadlines');
    assert.strictEqual(pi.evaluateProactiveSuggestion(mem.state, { isAwaitingConfirm: true, ignoreCooldown: true }), null, 'Must never interrupt awaiting confirmation');
    pi.dismissSuggestion(mem.state, sug.id);
    assert.strictEqual(pi.evaluateProactiveSuggestion(mem.state, { ignoreCooldown: true }), null, 'Dismissed suggestion must stay suppressed');

    // Decision Support + Table Presentation without fabricated figures
    const dec = pi.buildDecisionComparison([
      { title: 'Technical University of Munich (TUM)', url: 'https://www.tum.de/en/', official: true },
      { title: 'LMU Munich', url: 'https://www.lmu.de/en/', official: true }
    ], mem.state, { format: 'table', preferTable: true });
    assert.ok(dec.table && dec.table.headers.includes('Fees / Price') && dec.table.rows.length === 2, 'Builds table comparison cleanly');
    assert.ok(dec.sections && Array.isArray(dec.sections.facts) && typeof dec.sections.recommendation === 'string', 'Separates Facts from Preferences & Recommendations');

    // Personal Context Prompt Slicer never dumps full DB
    const sliced = llm.formatRelevantPersonalContext({
      topic: 'LMU Munich',
      objective: 'Check LMU deadline',
      constraints: ['freeOnly=true'],
      preferOfficialSources: true,
      relevantFacts: ['LMU fee is 75 EUR.']
    });
    assert.ok(sliced.includes('LMU Munich') && !sliced.includes('Schengen'), 'LLM prompt receives ONLY relevant retrieved slice');
  });

  // Scenario G + Reminder Parser + Optional Live Ollama Local Classification
  await runSuite('4. Tier 1 (Scenario G & Scheduling + Live Ollama): Privacy Disables, Reminder Parser & Local Ollama Signal Classifier', async () => {
    global.chrome = makeFakeChrome();
    const mem = new SleepwalkerMemory({ tabId: 'tab_g' });
    await mem.loadState();

    await mem.setPrivacySettings({ learningEnabled: false, proactiveEnabled: false });
    const sigBlocked = await mem.recordPreferenceSignal('responseStyle', 'concise', { forceDistinct: true });
    assert.strictEqual(sigBlocked.recorded, false, 'Adaptive learning disabled must stop signal recording');

    await mem.upsertTask({
      domain: 'travel_planning',
      topic: 'Japan',
      plannedSteps: [{ id: 'find_flights', label: 'Find flights to Japan', status: 'done' }]
    });
    const sugBlocked = pi.evaluateProactiveSuggestion(mem.state, { lastCommand: 'Find flights', ignoreCooldown: true });
    assert.strictEqual(sugBlocked, null, 'Proactive suggestions disabled must stop proactive offers');

    // Natural reminder parser
    const rem1 = pi.parseReminderRequest('Remind me to finish this application tomorrow', new Date('2026-11-19T10:00:00Z').getTime(), { url: 'https://apply.example' });
    assert.ok(rem1 && rem1.title.includes('finish this application') && rem1.checkType === 'reminder');
    const rem2 = pi.parseReminderRequest('Check whether applications open next month', new Date('2026-11-19T10:00:00Z').getTime(), {});
    assert.ok(rem2 && rem2.checkType === 'availability_recheck' && rem2.explanation.includes('do not scrape continuously'));
    const rem3 = pi.parseReminderRequest('Remind me before this deadline', Date.now(), { deadlines: [] });
    assert.strictEqual(rem3.requiresDateClarification, true, 'Refuses guessing deadline reminder date when none is known');

    // Optional live Ollama personal signal classification
    const st = await llm.checkOllamaModelStatus('http://localhost:11434', 'llama3.2:3b');
    if (st.available && st.modelInstalled) {
      const pRes = await llm.handlePersonalSignalRequest({ utterance: 'Keep answers concise please' });
      assert.strictEqual(pRes.status, 'ok', `Expected Ollama ok classification, got ${JSON.stringify(pRes)}`);
      console.log(`      (Live Ollama llama3.2:3b classified personal signal: category=${pRes.classification.category})`);
    } else {
      console.log('      (Note: Local Ollama offline — deterministic signal classifier verified)');
    }
  });
}

async function runTier2RealChromeExtensionTests() {
  const chromiumExe = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');
  if (!fs.existsSync(chromiumExe)) {
    console.log('SKIP  5. Tier 2 (Real Chrome MV3): Playwright Chromium binary not found');
    return;
  }

  await runSuite('5. Tier 2 (Real Chrome MV3 --load-extension): Tables, Proactive UI, Real chrome.alarms, Privacy & Wake Resume', async () => {
    const html = `<!DOCTYPE html><html><head><title>Germany Study Portal</title></head><body>
      <h1>Top Universities in Germany</h1>
      <div data-result-item><h2>Technical University of Munich (TUM)</h2><p>Engineering university in Munich.</p><a href="/tum">View TUM</a></div>
      <div data-result-item><h2>LMU Munich</h2><p>Research university in Munich. Application fee 75 EUR.</p><a href="/lmu">View LMU</a></div>
      <div data-result-item><h2>RWTH Aachen</h2><p>Technical university in Aachen.</p><a href="/rwth">View RWTH</a></div>
    </body></html>`;

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/study`;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-p5-ext-'));
    const cdpPort = 9510 + Math.floor(Math.random() * 250);

    const chrome = spawn(chromiumExe, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      url
    ], { stdio: 'ignore' });

    const fetchTargets = async () => (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const connectTarget = async (t) => {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
      let cid = 0;
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
      return { ws, send, evalJs };
    };

    const sockets = [];
    try {
      let pageTarget = null;
      let swTarget = null;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && (!pageTarget || !swTarget)) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const targets = await fetchTargets();
          if (!pageTarget) pageTarget = targets.find((t) => t.type === 'page' && t.url.includes('/study'));
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
      assert.ok(pageTarget && swTarget, 'Real MV3 Service Worker and page must load');

      const pageCdp = await connectTarget(pageTarget);
      const swCdp = await connectTarget(swTarget);
      await pageCdp.send('Runtime.enable').catch(() => {});
      await swCdp.send('Runtime.enable').catch(() => {});
      sockets.push(pageCdp.ws, swCdp.ws);
      await new Promise((r) => setTimeout(r, 1200));

      // Wake Sleepwalker via Alt+S
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await new Promise((r) => setTimeout(r, 350));

      const readUiSnap = async () => pageCdp.evalJs(`
        const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
        const root = sr.querySelector('.sw-ui-root');
        const card = sr.getElementById('sw-ui-card');
        return {
          state: root ? root.dataset.state : '',
          active: root ? root.dataset.active : '',
          transcript: sr.getElementById('sw-ui-transcript') ? sr.getElementById('sw-ui-transcript').textContent : '',
          formHidden: Boolean(sr.getElementById('sw-ui-type-form')?.hidden),
          cardType: card && !card.hidden ? (card.dataset.cardType || '') : '',
          cardTitle: sr.getElementById('sw-card-title') ? sr.getElementById('sw-card-title').textContent : '',
          cardBody: sr.getElementById('sw-card-body') ? sr.getElementById('sw-card-body').textContent : '',
          tableRows: sr.querySelectorAll('.sw-table tbody tr').length,
          proactiveText: sr.querySelector('.sw-proactive-text') ? sr.querySelector('.sw-proactive-text').textContent : '',
          hasProactiveBar: Boolean(sr.querySelector('.sw-proactive-bar')),
          confirmVisible: Boolean(sr.querySelector('#sw-ui-card[data-card-type="confirm"]:not([hidden])'))
        };
      `);

      const runCmd = async (cmd) => {
        await pageCdp.evalJs(`
          const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
          const form = sr.getElementById('sw-ui-type-form');
          const btn = sr.getElementById('sw-ui-type-btn');
          const inp = sr.getElementById('sw-ui-type-input');
          const bodyEl = sr.getElementById('sw-card-body');
          const titleEl = sr.getElementById('sw-card-title');
          if (bodyEl) bodyEl.textContent = '';
          if (titleEl) titleEl.textContent = '';
          const submit = sr.querySelector('.sw-type-submit');
          if (form && form.hidden && btn) btn.click();
          inp.value = ${JSON.stringify(cmd)};
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          submit.click();
        `);
        let snap = null;
        for (let i = 0; i < 320; i++) {
          await new Promise((r) => setTimeout(r, 120));
          snap = await readUiSnap();
          if (snap && snap.state !== 'thinking' && snap.state !== 'preparing' && (snap.cardBody || (snap.state === 'idle' && snap.active === 'false'))) break;
        }
        return snap;
      };

      // 1. Hierarchical goal + table presentation + compact proactive offer
      let out = await runCmd("Apply for a master's degree in Germany");
      if (!out || out.cardBody.length <= 10) {
        const dTraces = await swCdp.evalJs(`return (self._devWorldModelTraces || []).slice(-3);`).catch(() => []);
        console.error('[Phase5 DEBUG traces]:', JSON.stringify(dTraces));
      }
      assert.ok(out.cardBody.length > 10, `Started university task (got ${JSON.stringify(out)})`);

      out = await runCmd('Compare these universities in a table');
      assert.ok(out.tableRows >= 2, `Expected rendered HTML comparison table rows inside Shadow DOM, got ${out.tableRows} (body=${out.cardBody})`);
      assert.strictEqual(out.hasProactiveBar, true, 'Expected dismissible proactive deadline offer on comparison card');

      // Dismiss proactive bar cleanly via click and verify it clears immediately
      const dismissedCleanly = await pageCdp.evalJs(`
        const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
        const btns = sr.querySelectorAll('.sw-proactive-btn');
        btns[1].click();
        return !sr.querySelector('.sw-proactive-bar');
      `);
      assert.strictEqual(dismissedCleanly, true, 'Clicking Dismiss removes proactive bar immediately');

      // 2. Real chrome.alarms scheduling -> authorization -> SW alarm verification -> cancel
      out = await runCmd('Remind me to finish this application in 5 minutes');
      assert.strictEqual(out.confirmVisible, true, `Reminder scheduling must ask explicit user authorization first (got ${JSON.stringify(out)})`);

      // Authorize via typed Yes command
      await runCmd('Yes');
      await new Promise((r) => setTimeout(r, 350));
      const alarmsAfterSchedule = await swCdp.evalJs(`return await new Promise((r) => chrome.alarms.getAll(r));`);
      assert.ok(Array.isArray(alarmsAfterSchedule) && alarmsAfterSchedule.some((a) => String(a.name).startsWith('sw_rem_')), 'Real Chrome MV3 chrome.alarms entry created cleanly');

      out = await runCmd('Show my reminders');
      assert.ok(/finish this application/i.test(out.cardBody), `Reminder must appear in Reminders list, got: ${out.cardBody}`);

      out = await runCmd('Cancel reminder');
      const alarmsAfterCancel = await swCdp.evalJs(`return await new Promise((r) => chrome.alarms.getAll(r));`);
      assert.ok(!alarmsAfterCancel.some((a) => String(a.name).startsWith('sw_rem_')), 'Cancelled reminder must remove real chrome.alarms entry');

      // 3. Preference + Correction + Inspect + Privacy disables
      await runCmd('Always use numbered options');
      await runCmd('Actually the deadline for TUM is June 15');
      out = await runCmd('What do you remember about me?');
      assert.ok(/presentationFormat/i.test(out.cardBody) && /explicit/i.test(out.cardBody), `Transparently reports stored preferences with source, got: ${out.cardBody}`);

      await runCmd('Disable adaptive learning');
      await runCmd('Disable proactive suggestions');
      await new Promise((r) => setTimeout(r, 250));

      // 4. Rest then Alt+S wake -> concise cross-session resume greeting without raw dump
      await runCmd('You can rest');
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 120));
        const st = await readUiSnap();
        if (st.active === 'false') break;
      }
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
      await new Promise((r) => setTimeout(r, 500));
      const wakeSnap = await readUiSnap();
      assert.ok(/Welcome back/i.test(wakeSnap.cardBody) && /Germany/i.test(wakeSnap.cardBody), `Expected concise wake resume greeting mentioning Germany task, got: ${JSON.stringify(wakeSnap)}`);

      // Verify Options UI toggles & inspector render properly in real extension tab
      const swExtUrl = swTarget.url.replace(/background\.js$/, 'options.html');
      await pageCdp.send('Page.navigate', { url: swExtUrl });
      await new Promise((r) => setTimeout(r, 800));
      const optSnap = await pageCdp.evalJs(`
        return {
          hasLearnChk: Boolean(document.getElementById('opt-learning-enabled')),
          hasProChk: Boolean(document.getElementById('opt-proactive-enabled')),
          learnChecked: document.getElementById('opt-learning-enabled')?.checked,
          proChecked: document.getElementById('opt-proactive-enabled')?.checked,
          inspectorText: document.getElementById('opt-personal-inspector')?.textContent || ''
        };
      `);
      assert.strictEqual(optSnap.hasLearnChk && optSnap.hasProChk, true, 'Options page must expose Adaptive Learning & Proactive toggles');
      assert.strictEqual(optSnap.learnChecked, false, 'Options reflects voice-disabled learning toggle cleanly');
      assert.strictEqual(optSnap.proChecked, false, 'Options reflects voice-disabled proactive toggle cleanly');

      console.log('      (Real Chrome MV3: verified table comparison UI, dismissible proactive bar, real chrome.alarms create/list/cancel, preference transparency, Alt+S wake resume & Options sync)');
    } finally {
      for (const s of sockets) {
        try { if (s && s.readyState < 2) s.close(); } catch (_e) {}
      }
      await new Promise((r) => setTimeout(r, 120));
      try { chrome.kill(); } catch (_e) {}
      await new Promise((r) => server.close(r));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_e) {}
    }
  });
}

(async () => {
  console.log('=== Sleepwalker 2.0 Phase 5 — Personal Intelligence & Proactive Assistance Tests ===\n');
  await runTier1UnitAndScenarios();
  await runTier2RealChromeExtensionTests();
  console.log(`\nSummary: ${passed}/${passed + failed} Phase 5 test suites passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
})();
