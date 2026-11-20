/**
 * Phase 4 Automated Test Suite (Navigation, 1s Highlight, Disambiguation, Risk Confirmations, Session Resume)
 * Run with: node tests/run-p4-tests.js
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

function createNavMockDom() {
  const clickedIds = [];
  const scrolledIds = [];
  const scrollCalls = [];

  class MockEl {
    constructor(tag, attrs = {}, text = '') {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.attributes = { ...attrs };
      this.id = attrs.id || '';
      this.className = attrs.class || '';
      this._text = text;
      this.children = [];
      this.childNodes = [];
      this.parentElement = null;
      this.disabled = false;
      this.hidden = Boolean(attrs.hidden);
      this.style = { outline: '', outlineOffset: '', boxShadow: '' };
      this.classList = {
        _set: new Set(String(attrs.class || '').split(/\s+/).filter(Boolean)),
        add: (c) => this.classList._set.add(c),
        remove: (c) => this.classList._set.delete(c),
        contains: (c) => this.classList._set.has(c)
      };
    }
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    }
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k);
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
    }
    appendChild(child) {
      child.parentElement = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    }
    closest(sel) {
      let cur = this;
      const targetId = sel.startsWith('#') ? sel.slice(1) : null;
      while (cur) {
        if (targetId && cur.id === targetId) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelector() { return null; }
    get textContent() {
      if (this._text) return this._text;
      return this.childNodes.map((c) => c.textContent).join(' ');
    }
    set textContent(v) {
      this._text = String(v || '');
    }
    get innerText() { return this.textContent; }
    getBoundingClientRect() { return { top: 20, left: 20, width: 120, height: 32 }; }
    scrollIntoView(opts) {
      scrolledIds.push({ id: this.id || this.textContent, opts });
    }
    click() {
      clickedIds.push({ id: this.id || this.textContent, label: this.textContent, time: Date.now() });
    }
  }

  const head = new MockEl('head');
  const body = new MockEl('body');
  const main = new MockEl('main');
  body.appendChild(main);

  const elSameSite = new MockEl('a', { id: 'lnk-apply', href: '/scholarship-form' }, 'Scholarship Application Form');
  const elDownload1 = new MockEl('a', { id: 'lnk-dl-form', href: '/files/form.pdf', download: '' }, 'Download Form');
  const elDownload2 = new MockEl('a', { id: 'lnk-dl-rcpt', href: '/files/receipt.pdf', download: '' }, 'Download Receipt');
  const elExternal = new MockEl('a', { id: 'lnk-ext', href: 'https://external-partner.org/guide' }, 'Partner Portal');
  const elLogout = new MockEl('button', { id: 'btn-logout', type: 'button' }, 'Logout');
  const elDelete = new MockEl('button', { id: 'btn-delete', type: 'button' }, 'Delete Account');
  const elPay = new MockEl('button', { id: 'btn-pay', type: 'button' }, 'Pay Now');
  const elNextRel = new MockEl('a', { id: 'lnk-next', href: '/page-2', rel: 'next' }, 'Agla Page');
  const elPrevAria = new MockEl('button', { id: 'btn-prev', 'aria-label': 'Previous page' }, '‹');
  const elHeadingFees = new MockEl('h2', { id: 'sec-fees' }, 'Application Fees');
  const elSwHost = new MockEl('div', { id: 'sleepwalker-host' });
  const elInternalBtn = new MockEl('button', { id: 'sw-btn-internal' }, 'Scholarship Internal');
  elSwHost.appendChild(elInternalBtn);

  [elSameSite, elDownload1, elDownload2, elExternal, elLogout, elDelete, elPay, elNextRel, elPrevAria, elHeadingFees]
    .forEach((e) => main.appendChild(e));
  body.appendChild(elSwHost);

  const doc = {
    title: 'Scholarship Hub',
    head,
    body,
    documentElement: { scrollHeight: 2400 },
    defaultView: null,
    _all() {
      const out = [];
      const walk = (n) => {
        if (n.nodeType === 1) out.push(n);
        for (const ch of n.childNodes) walk(ch);
      };
      walk(head);
      walk(body);
      return out;
    },
    getElementById(id) {
      return this._all().find((el) => el.id === id) || null;
    },
    createElement(tag) {
      return new MockEl(tag);
    },
    querySelectorAll(sel) {
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
      const all = this._all();
      return all.filter((el) => parts.some((p) => {
        const tag = el.tagName.toLowerCase();
        if (p === 'a[href]') return tag === 'a' && el.hasAttribute('href');
        if (p === 'button') return tag === 'button';
        if (p === '[role="button"]') return el.getAttribute('role') === 'button';
        if (p === '[role="link"]') return el.getAttribute('role') === 'link';
        if (p === 'input[type="button"]') return tag === 'input' && el.getAttribute('type') === 'button';
        if (p === 'input[type="submit"]') return tag === 'input' && el.getAttribute('type') === 'submit';
        if (p === 'input[type="reset"]') return tag === 'input' && el.getAttribute('type') === 'reset';
        if (p.startsWith('a[rel~="')) {
          const val = p.match(/rel~="([^"]+)"/)[1];
          return tag === 'a' && String(el.getAttribute('rel') || '').split(/\s+/).includes(val);
        }
        if (p.startsWith('button[rel~="')) {
          const val = p.match(/rel~="([^"]+)"/)[1];
          return tag === 'button' && String(el.getAttribute('rel') || '').split(/\s+/).includes(val);
        }
        if (p.startsWith('link[rel~="')) {
          const val = p.match(/rel~="([^"]+)"/)[1];
          return tag === 'link' && String(el.getAttribute('rel') || '').split(/\s+/).includes(val);
        }
        return tag === p;
      }));
    }
  };

  const historyCalls = [];
  const win = {
    innerHeight: 800,
    location: {
      protocol: 'https:',
      origin: 'https://scholarships.gov.in',
      href: 'https://scholarships.gov.in/home',
      reload: () => historyCalls.push('reload'),
      assign: (url) => historyCalls.push(`assign:${url}`)
    },
    history: {
      back: () => historyCalls.push('back'),
      forward: () => historyCalls.push('forward')
    },
    scrollTo: (opts) => scrollCalls.push({ fn: 'scrollTo', opts }),
    scrollBy: (opts) => scrollCalls.push({ fn: 'scrollBy', opts }),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  };
  doc.defaultView = win;

  global.document = doc;
  global.window = win;

  return {
    doc,
    win,
    clickedIds,
    scrolledIds,
    scrollCalls,
    historyCalls,
    elements: { elSameSite, elDownload1, elDownload2, elExternal, elLogout, elDelete, elPay, elNextRel, elPrevAria, elHeadingFees }
  };
}

function setupSessionMessageMock() {
  const sessionStore = {};
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        if (msg.type === 'SLEEPWALKER_SESSION_STATE_SET') {
          sessionStore.sleepwalker_nav_task = msg.state;
          if (cb) cb({ status: 'ok' });
        } else if (msg.type === 'SLEEPWALKER_SESSION_STATE_GET') {
          if (cb) cb({ state: sessionStore.sleepwalker_nav_task || null });
        } else if (msg.type === 'SLEEPWALKER_SESSION_STATE_CLEAR') {
          delete sessionStore.sleepwalker_nav_task;
          if (cb) cb({ status: 'ok' });
        } else if (cb) {
          cb({});
        }
      }
    }
  };
  return sessionStore;
}

async function main() {
  console.log('=== Sleepwalker Phase 4 Test Suite ===\n');

  // Suite 1: Syntax & manifest order
  await runSuite('JS Syntax & Script Registration Order (navigate.js before content.js)', () => {
    for (const f of ['navigate.js', 'confirm.js', 'background.js', 'orb.js', 'content.js']) {
      execSync(`node --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' });
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const scripts = manifest.content_scripts[0].js;
    const navIdx = scripts.indexOf('navigate.js');
    const contentIdx = scripts.indexOf('content.js');
    assert.ok(navIdx !== -1 && contentIdx !== -1 && navIdx < contentIdx, 'navigate.js must precede content.js in manifest.json');

    const bgCode = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
    assert.ok(bgCode.includes("'navigate.js'") && bgCode.includes('SLEEPWALKER_SESSION_STATE_GET') && bgCode.includes('chrome.storage.session'));
  });

  // Suite 2: Fuzzy match on digest/DOM labels & ambiguity detection
  await runSuite('Fuzzy Clickable Match (typos, Hinglish fillers, host exclusion, ambiguity)', () => {
    createNavMockDom();
    const SleepwalkerConfirm = loadModule('confirm.js');
    const { SleepwalkerNavigator } = loadModule('navigate.js');
    const nav = new SleepwalkerNavigator({ confirm: new SleepwalkerConfirm() });

    const typoMatch = nav.findClickableTargets('open scolarship aplication wala link');
    assert.ok(typoMatch.length >= 1, 'Typo query should match Scholarship Application Form');
    assert.strictEqual(typoMatch[0].element.id, 'lnk-apply');
    assert.ok(!typoMatch.some((m) => m.element.id === 'sw-btn-internal'), 'Must exclude #sleepwalker-host');

    const multi = nav.findClickableTargets('download');
    assert.strictEqual(multi.length, 2);
    assert.strictEqual(nav.isAmbiguousMatch(multi), true, 'Multiple "Download" options must be flagged ambiguous');
  });

  // Suite 3: 1-second highlight BEFORE acting & cancel safety
  await runSuite('1-Second Highlight (outline + scrollIntoView) BEFORE Acting & Stop Cancel', async () => {
    const env = createNavMockDom();
    setupSessionMessageMock();
    const SleepwalkerConfirm = loadModule('confirm.js');
    const { SleepwalkerNavigator } = loadModule('navigate.js');

    const messages = [];
    const widget = {
      confirm: new SleepwalkerConfirm(),
      pill: { state: 'idle', setIdle: () => {}, setPreparing: () => {}, setStatus: () => {}, openBubble: () => {} },
      setAssistantReply: (m) => messages.push(m)
    };
    const nav = new SleepwalkerNavigator(widget, { highlightDurationMs: 1000 });

    const tStart = Date.now();
    await nav.executeClick('Scholarship Application Form', { confidence: 0.92 });

    // Immediately after trigger: scrolled & outlined, NOT clicked yet!
    assert.strictEqual(env.clickedIds.length, 0, 'Target must NOT be clicked immediately at 0ms');
    assert.ok(env.scrolledIds.some((s) => s.id === 'lnk-apply'), 'Target must scrollIntoView before acting');
    assert.ok(env.elements.elSameSite.classList.contains('sleepwalker-target-flash'), 'Target must receive flash highlight');
    assert.ok(env.elements.elSameSite.style.outline.includes('solid'), 'Target must have visible outline');

    // Check at ~400ms: still NOT clicked
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(env.clickedIds.length, 0, 'Target must still stay highlighted and unclicked before 1s elapses');

    // Wait remaining time past 1000ms
    await new Promise((r) => setTimeout(r, 750));
    assert.strictEqual(env.clickedIds.length, 1, 'Target should click after 1s highlight');
    assert.strictEqual(env.clickedIds[0].id, 'lnk-apply');
    assert.ok((env.clickedIds[0].time - tStart) >= 950, `Expected >=950ms delay, got ${env.clickedIds[0].time - tStart}ms`);
    assert.strictEqual(env.elements.elSameSite.style.outline, '', 'Inline outline should restore cleanly after acting');

    // Verify Stop / cancelPendingHighlight aborts before click fires
    env.clickedIds.length = 0;
    await nav.executeClick('Scholarship Application Form', { confidence: 0.92 });
    nav.cancelPendingHighlight();
    await new Promise((r) => setTimeout(r, 1100));
    assert.strictEqual(env.clickedIds.length, 0, 'Cancelled highlight must never click');
  });

  // Suite 4: Multiple match disambiguation via numbered options (including spoken words)
  await runSuite('Multiple Matches Ask ONE Short Numbered Question ("two" -> picks #2)', async () => {
    const env = createNavMockDom();
    setupSessionMessageMock();
    const SleepwalkerConfirm = loadModule('confirm.js');
    const { SleepwalkerNavigator } = loadModule('navigate.js');

    const confirm = new SleepwalkerConfirm();
    const nav = new SleepwalkerNavigator({
      confirm,
      setAssistantReply: () => {},
      pill: { setIdle: () => {}, setPreparing: () => {}, setStatus: () => {}, openBubble: () => {} }
    }, { highlightDurationMs: 40 });

    await nav.executeClick('download', { confidence: 0.9 });
    assert.strictEqual(confirm.isAwaiting(), true, 'Must ask disambiguation question');
    assert.strictEqual(confirm.pending.options.length, 2);
    assert.ok(confirm.pending.message.includes('1. Download Form') && confirm.pending.message.includes('2. Download Receipt'));
    assert.strictEqual(env.clickedIds.length, 0);

    // Pick option #2 using spoken word "two" -> chosen option #2 is a download link, so high-risk confirm triggers!
    const pickRes = confirm.handleResponse('two');
    assert.strictEqual(pickRes.handled, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(confirm.isAwaiting(), true, 'Chosen download option must require explicit high-risk confirm');

    // Confirm download -> waits highlight -> clicks ONLY Download Receipt (#2)
    confirm.handleResponse('haan');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(env.clickedIds.length, 1);
    assert.strictEqual(env.clickedIds[0].id, 'lnk-dl-rcpt');
  });

  // Suite 5: Risk assessments (leave site, download, logout, delete, pay)
  await runSuite('Safety Confirmations: Leave Site, Download, Logout (High) & Delete/Pay (Critical Double Confirm)', async () => {
    const env = createNavMockDom();
    setupSessionMessageMock();
    const SleepwalkerConfirm = loadModule('confirm.js');
    const { SleepwalkerNavigator } = loadModule('navigate.js');

    const confirm = new SleepwalkerConfirm();
    const nav = new SleepwalkerNavigator({ confirm, setAssistantReply: () => {} }, { highlightDurationMs: 25 });

    // Risk classifications
    assert.strictEqual(nav.assessTargetRisk(env.elements.elExternal, 'Partner Portal').risk, 'high');
    assert.strictEqual(nav.assessTargetRisk(env.elements.elDownload1, 'Download Form').risk, 'high');
    assert.strictEqual(nav.assessTargetRisk(env.elements.elLogout, 'Logout').risk, 'high');
    assert.strictEqual(nav.assessTargetRisk(env.elements.elDelete, 'Delete Account').risk, 'critical');
    assert.strictEqual(nav.assessTargetRisk(env.elements.elPay, 'Pay Now').risk, 'critical');
    assert.strictEqual(nav.assessTargetRisk(env.elements.elSameSite, 'Scholarship Application Form').risk, 'medium');

    // Verify leaving site requires explicit confirm even at confidence 0.99
    await nav.executeClick('Partner Portal', { confidence: 0.99 });
    assert.strictEqual(confirm.isAwaiting(), true);
    assert.strictEqual(confirm.pending.requiredSteps, 1);
    confirm.cancel();
    assert.strictEqual(env.clickedIds.length, 0);

    // Verify Pay Now requires critical double confirmation (step 1 -> step 2 -> execute)
    await nav.executeClick('Pay Now', { confidence: 0.99 });
    assert.strictEqual(confirm.isAwaiting(), true);
    assert.strictEqual(confirm.pending.requiredSteps, 2);
    confirm.handleResponse('yes');
    assert.strictEqual(confirm.isAwaiting(), true, 'Step 2 still required for Pay Now');
    assert.strictEqual(env.clickedIds.length, 0);
    confirm.handleResponse('confirm');
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(env.clickedIds.length, 1);
    assert.strictEqual(env.clickedIds[0].id, 'btn-pay');
  });

  // Suite 6: Pagination, Scroll, History & Section Navigation
  await runSuite('Pagination (rel="next", aria-label prev), Scroll, History & Section Highlight', async () => {
    const env = createNavMockDom();
    setupSessionMessageMock();
    const SleepwalkerConfirm = loadModule('confirm.js');
    const { SleepwalkerNavigator } = loadModule('navigate.js');

    const readSections = [];
    const outlineCalls = [];
    const confirm = new SleepwalkerConfirm();
    const widget = {
      confirm,
      outline: {
        items: [{ id: 'sec-fees', text: 'Application Fees', level: 2, element: env.elements.elHeadingFees }],
        extractOutline: () => {},
        scrollToHeading: (item) => outlineCalls.push(item.text)
      },
      readSection: (name) => readSections.push(name),
      setAssistantReply: () => {}
    };
    const nav = new SleepwalkerNavigator(widget, { highlightDurationMs: 25 });

    // Pagination next & prev
    const nextTargets = nav.findPaginationTarget('next');
    assert.strictEqual(nextTargets[0].element.id, 'lnk-next');
    const prevTargets = nav.findPaginationTarget('prev');
    assert.strictEqual(prevTargets[0].element.id, 'btn-prev');
    await nav.paginate('next', 0.95);
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(env.clickedIds[0].id, 'lnk-next');

    // Scroll
    nav.scroll('top');
    nav.scroll('bottom');
    assert.strictEqual(env.scrollCalls.length, 2);

    // Section go + highlight
    await nav.goToSection('fees', { readAfter: true });
    assert.ok(outlineCalls.includes('Application Fees'));
    assert.ok(readSections.includes('Application Fees'));

    // History requires high confirm
    nav.historyAction('back', 0.95);
    assert.strictEqual(confirm.isAwaiting(), true);
    confirm.handleResponse('yes');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(env.historyCalls.includes('back'));
  });

  // Suite 7: chrome.storage.session persistence across page loads + "continue" zero-LLM intent
  await runSuite('Session State Persistence & "continue" Resume Across Page Loads', async () => {
    createNavMockDom();
    const sessionStore = setupSessionMessageMock();
    const lexicon = JSON.parse(fs.readFileSync(path.join(ROOT, 'lexicon.json'), 'utf8'));
    const SleepwalkerIntentEngine = loadModule('intent.js');
    const SleepwalkerConfirm = loadModule('confirm.js');
    const { SleepwalkerNavigator } = loadModule('navigate.js');

    // Verify "continue" resolves locally as CONTROL(resume) with 0 LLM calls
    const engine = new SleepwalkerIntentEngine({ lexicon });
    const intentRes = await engine.classify('continue');
    assert.strictEqual(intentRes.intent, 'CONTROL');
    assert.strictEqual(intentRes.args.action, 'resume');
    assert.strictEqual(intentRes.source, 'rules');

    // Page 1 saves plan state in chrome.storage.session
    const nav1 = new SleepwalkerNavigator({ confirm: new SleepwalkerConfirm(), setAssistantReply: () => {} });
    await nav1.saveSessionState({
      active: true,
      kind: 'plan',
      planTitle: 'Scholarship Apply Plan',
      planSteps: [
        { label: 'Step 1 open link' },
        { label: 'Step 2 verify documents' },
        { label: 'Step 3 submit review' }
      ],
      currentStepIndex: 1
    });
    assert.ok(sessionStore.sleepwalker_nav_task && sessionStore.sleepwalker_nav_task.currentStepIndex === 1);

    // Simulate Page 2 fresh instance loading from chrome.storage.session
    const replies = [];
    const confirm2 = new SleepwalkerConfirm();
    const nav2 = new SleepwalkerNavigator({
      confirm: confirm2,
      setAssistantReply: (m) => replies.push(m),
      pill: { setStatus: () => {}, setIdle: () => {}, setPreparing: () => {}, openBubble: () => {} }
    });

    const bootedState = await nav2.checkSavedSessionOnBoot();
    assert.ok(bootedState && bootedState.active);
    assert.ok(replies.some((r) => r.includes('Continue')));

    const resumed = await nav2.tryResumeSavedState();
    assert.strictEqual(resumed, true);
    assert.strictEqual(confirm2.isPlanActive(), true, 'Saved multi-step plan should be active on Page 2');
    assert.strictEqual(confirm2.plan.currentIndex, 1, 'Resumed plan should start at saved step index 1');
  });

  // Suite 8: Website Search Bar Detection, Risk Classification (LOW vs CRITICAL) & Execution
  await runSuite('Website Search Detection, Low-Risk Search Submit Classification & Single Execution', async () => {
    const env = createNavMockDom();
    setupSessionMessageMock();
    const lexicon = JSON.parse(fs.readFileSync(path.join(ROOT, 'lexicon.json'), 'utf8'));
    const SleepwalkerIntentEngine = loadModule('intent.js');
    const SleepwalkerConfirm = loadModule('confirm.js');
    const { SleepwalkerNavigator } = loadModule('navigate.js');

    const engine = new SleepwalkerIntentEngine({ lexicon });

    // 1. Verify voice search commands classify as SEARCH (action: 'search') with 0 LLM calls
    const c1 = await engine.classify('Search for artificial intelligence.');
    assert.strictEqual(c1.intent, 'SEARCH');
    assert.strictEqual(c1.args.action, 'search');
    assert.strictEqual(c1.args.query, 'artificial intelligence');
    assert.strictEqual(c1.source, 'rules');

    const c2 = await engine.classify('Search Wikipedia for machine learning.');
    assert.strictEqual(c2.intent, 'SEARCH');
    assert.strictEqual(c2.args.action, 'search');
    assert.strictEqual(c2.args.query, 'machine learning');
    assert.strictEqual(c2.args.siteHint, 'Wikipedia');

    const c3 = await engine.classify('Look up Python programming.');
    assert.strictEqual(c3.intent, 'SEARCH');
    assert.strictEqual(c3.args.action, 'search');
    assert.strictEqual(c3.args.query, 'Python programming');

    const c4 = await engine.classify('Find information about neural networks.');
    assert.strictEqual(c4.intent, 'SEARCH');
    assert.strictEqual(c4.args.action, 'search');
    assert.strictEqual(c4.args.query, 'neural networks');

    const c5 = await engine.classify('search card in the search box');
    assert.strictEqual(c5.intent, 'SEARCH');
    assert.strictEqual(c5.args.action, 'search');
    assert.strictEqual(c5.args.query, 'card');

    const c6 = await engine.classify('type Python in the search box');
    assert.strictEqual(c6.intent, 'SEARCH');
    assert.strictEqual(c6.args.query, 'Python');

    const c7 = await engine.classify('explain this website to me');
    assert.strictEqual(c7.intent, 'EXPLAIN');
    assert.strictEqual(c7.args.mode, 'summary');
    assert.ok(!c7.args.target, 'explain this website to me must not set a fake section target');

    // 2. Verify search form submit button is classified as LOW risk, while application submit remains CRITICAL
    const searchForm = env.doc.createElement('form');
    searchForm.setAttribute('role', 'search');
    searchForm.setAttribute('action', '/search');
    const searchInput = env.doc.createElement('input');
    searchInput.setAttribute('type', 'search');
    searchInput.setAttribute('name', 'q');
    searchInput.setAttribute('placeholder', 'Search Wikipedia');
    searchInput.setAttribute('aria-label', 'Search Wikipedia');
    searchInput.value = '';
    const searchBtn = env.doc.createElement('button');
    searchBtn.setAttribute('type', 'submit');
    searchBtn.textContent = 'Search';
    searchForm.appendChild(searchInput);
    searchForm.appendChild(searchBtn);
    env.doc.body.appendChild(searchForm);

    const appSubmitBtn = env.doc.createElement('button');
    appSubmitBtn.setAttribute('type', 'submit');
    appSubmitBtn.textContent = 'Submit Application';
    env.doc.body.appendChild(appSubmitBtn);

    const confirm = new SleepwalkerConfirm();
    const nav = new SleepwalkerNavigator({ confirm, setAssistantReply: () => {} }, { highlightDurationMs: 10 });

    assert.strictEqual(nav.assessTargetRisk(searchBtn, 'Search').risk, 'low', 'Search submit button must be LOW risk');
    assert.strictEqual(nav.assessTargetRisk(appSubmitBtn, 'Submit Application').risk, 'critical', 'Application submit button must remain CRITICAL risk');
  });

  console.log(`\nSummary: ${passedSuites}/${passedSuites + failedSuites} P4 test suites passed.`);
  if (failedSuites > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
