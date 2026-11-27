'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');
const { buildVoiceCorpus } = require('./phrases.js');
const { runDynamicAndStressSuite } = require('./dynamic-and-stress.js');

const EXT_DIR = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(__dirname, '.pw-profile');
const REPORT_PATH = path.join(__dirname, 'report.md');
const PACE_MS = 1050; // Strict max 1 action/second on live sites

const TARGET_SITES = [
  { name: 'IRCTC', url: 'https://www.irctc.co.in/nget/train-search' },
  { name: 'Income Tax e-Filing', url: 'https://www.incometax.gov.in/iec/foportal/' },
  { name: 'Passport India', url: 'https://www.passportindia.gov.in/' },
  { name: 'EPFO Member Portal', url: 'https://unifiedportal-mem.epfindia.gov.in/memberinterface/' },
  { name: 'Amazon India', url: 'https://www.amazon.in/' },
  { name: 'MakeMyTrip', url: 'https://www.makemytrip.com/' }
];

// STRICT SAFETY RULES: Never click/submit/type anything matching these
const UNSAFE_RE = /\b(?:log\s*in|sign\s*in|signin|login|register|sign\s*up|signup|pay|payment|checkout|book\s*now|confirm\s*booking|buy\s*now|purchase|order|cart|cancel|delete|remove|logout|sign\s*out|submit|otp|password|pin\b|aadhaar|aadhar|pan\b|cvv|captcha|verify|proceed|add\s+to\s+cart|apply\s+now|file\s+now|e-?pay|claim|withdraw|transfer|reset|download)\b/i;
const UNSAFE_HREF_RE = /(?:login|signin|sign-in|signup|register|logout|signout|pay|payment|checkout|cart|book|cancel|delete|otp|password|captcha|\.(?:pdf|zip|exe|apk|docx?|xlsx?)(?:[?#]|$))/i;
const CAPTCHA_OR_BLOCK_RE = /\b(?:access\s+denied|verify\s+you\s+are\s+human|sorry,\s+you\s+have\s+been\s+blocked|bot\s+detection|enter\s+the\s+characters\s+you\s+see|robot\s+check|attention\s+required!\s*\|\s*cloudflare|service\s+unavailable\s+-\s+zero\s+size|request\s+blocked)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runVoicePhraseSuite() {
  const voiceSrc = fs.readFileSync(path.join(EXT_DIR, 'src/voice/voice.js'), 'utf8');
  const matchApi = require(path.join(EXT_DIR, 'src/engine/match.js'));
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    navigator: {},
    document: {},
    chrome: {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(voiceSrc, sandbox);
  const voice = new sandbox.window.SleepwalkerVoice();

  const corpus = buildVoiceCorpus();
  const byCat = {};
  const failures = [];
  let passed = 0;

  for (const row of corpus) {
    if (!byCat[row.cat]) byCat[row.cat] = { total: 0, passed: 0 };
    byCat[row.cat].total += 1;

    const parsed = voice.parseCommand(row.input);
    const ok = row.expectedTypes.includes(parsed.type);
    if (ok) {
      passed += 1;
      byCat[row.cat].passed += 1;
    } else {
      const fuzzy = matchApi.resolveFuzzyCommandAndAlternatives({ primaryText: row.input, inputSource: 'voice' });
      const parsedAfterFuzzy = fuzzy && fuzzy.changed ? voice.parseCommand(fuzzy.text) : null;
      failures.push({
        url: 'unit://voice.parseCommand',
        selector: `parseCommand[${row.cat}]`,
        input: row.input,
        expected: row.expectedTypes.join(' | '),
        actual: parsedAfterFuzzy ? `${parsed.type} (after fuzzy "${fuzzy.text}" -> ${parsedAfterFuzzy.type})` : parsed.type
      });
    }
  }
  return { total: corpus.length, passed, byCat, failures };
}

async function sendToTab(sw, tabId, payload, timeoutMs = 15000) {
  return sw.evaluate(async ({ tabId, payload, timeoutMs }) => {
    return new Promise((resolve) => {
      const tm = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
      chrome.tabs.sendMessage(tabId, payload, (res) => {
        clearTimeout(tm);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, error: 'empty_response' });
        }
      });
    });
  }, { tabId, payload, timeoutMs });
}

async function auditSite(page, sw, getTabId, site) {
  const tStart = Date.now();
  const summary = {
    name: site.name,
    url: site.url,
    finalUrl: site.url,
    status: 'OK',
    blockedReason: '',
    domFound: 0,
    swDetected: 0,
    coveragePct: 0,
    unclearLabels: 0,
    hiddenLeaks: 0,
    duplicateLeaks: 0,
    adCookieLeaks: 0,
    unreachableCount: 0,
    reachTested: 0,
    safeClicksAttempted: 0,
    safeClicksVerified: 0,
    wrongClicks: 0,
    whatCanIDoOk: false,
    whatCanIDoCount: 0,
    sayMoreOk: false,
    timingMs: 0,
    failures: []
  };

  let navResp = null;
  try {
    navResp = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (err) {
    summary.status = 'LOAD_ERROR';
    summary.blockedReason = (err && err.message || String(err)).slice(0, 120);
    summary.timingMs = Date.now() - tStart;
    summary.failures.push({ url: site.url, selector: 'document', input: 'page.goto', expected: 'Page loads', actual: summary.blockedReason });
    return summary;
  }

  await sleep(2600);
  summary.finalUrl = page.url();

  // Check HTTP block or Captcha / Access Denied immediately (strict no-bypass rule!)
  const httpStatus = navResp ? navResp.status() : 200;
  const blockCheck = await page.evaluate((reSrc) => {
    const title = document.title || '';
    const text = ((document.body && document.body.innerText) || '').slice(0, 2500);
    const hasCaptchaIframe = Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha'));
    const rx = new RegExp(reSrc, 'i');
    const matched = `${title}\n${text}`.match(rx);
    return {
      title,
      blockedText: matched ? matched[0] : '',
      hasCaptchaGate: hasCaptchaIframe && text.length < 700
    };
  }, CAPTCHA_OR_BLOCK_RE.source).catch(() => ({ title: '', blockedText: '', hasCaptchaGate: false }));

  if (httpStatus === 403 || httpStatus === 429 || httpStatus === 503 || blockCheck.blockedText || blockCheck.hasCaptchaGate) {
    summary.status = 'BLOCKED_OR_CAPTCHA';
    summary.blockedReason = `HTTP ${httpStatus}${blockCheck.blockedText ? ` — "${blockCheck.blockedText}"` : ''}${blockCheck.hasCaptchaGate ? ' (CAPTCHA gate)' : ''}`;
    summary.timingMs = Date.now() - tStart;
    return summary;
  }

  const tabId = await getTabId(summary.finalUrl);
  if (!tabId) {
    summary.status = 'NO_TAB_ID';
    summary.blockedReason = 'Could not resolve Chrome tabId';
    summary.timingMs = Date.now() - tStart;
    return summary;
  }

  // 1. SCAN: Ground-truth DOM scan (including open shadow DOM & same-origin iframes) vs Sleepwalker's scan
  const domTruth = await page.evaluate(() => {
    const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [aria-expanded], details > summary';
    const isSwUi = (el) => Boolean(el && el.closest && el.closest('#sleepwalker-ui-host, #sleepwalker-host, [data-sleepwalker-ui="1"]'));
    const isVis = (el) => {
      try {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      } catch (_e) { return false; }
    };
    const cssPath = (el) => {
      if (!el || !el.tagName) return 'unknown';
      const tag = el.tagName.toLowerCase();
      if (el.id) return `${tag}#${el.id}`;
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return cls ? `${tag}.${cls}` : tag;
    };
    const seen = new Set();
    const els = [];
    const walk = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      for (const el of root.querySelectorAll(sel)) {
        if (seen.has(el) || isSwUi(el) || !isVis(el)) continue;
        seen.add(el);
        els.push({
          selector: cssPath(el),
          label: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').replace(/\s+/g, ' ').trim().slice(0, 50)
        });
      }
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot && !isSwUi(node)) walk(node.shadowRoot);
      }
      for (const fr of root.querySelectorAll('iframe')) {
        try { if (fr.contentDocument) walk(fr.contentDocument); } catch (_e) {}
      }
    };
    walk(document);
    return { count: els.length, sample: els };
  });

  if (domTruth.count === 0) {
    summary.status = 'BLOCKED_OR_CAPTCHA';
    summary.blockedReason = 'Empty/anti-bot shell (0 visible interactive DOM elements after load)';
    summary.timingMs = Date.now() - tStart;
    return summary;
  }

  const swScan = await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_AUDIT_SNAPSHOT', mode: 'scan' });
  if (!swScan || !swScan.ok) {
    summary.status = 'NO_CONTENT_SCRIPT';
    summary.blockedReason = (swScan && swScan.error) || 'Content script did not respond';
    summary.timingMs = Date.now() - tStart;
    return summary;
  }

  const allSwItems = Array.isArray(swScan.items) ? swScan.items : [];
  const unclearRe = /^(?:$|[\W_]+|(?:btn|button|link|lnk|nav|ctl|item|opt|inp|txt|fld|el|img|icon)[-_]?\d+|[a-f0-9]{8,}|click\s*here|here|more)$/i;
  const adCookieRe = /\b(?:cookie|accept\s+all\s+cookies|manage\s+cookies|gdpr|advertisement|sponsored|adchoices)\b/i;

  const unclearList = [];
  let hiddenCount = 0;
  let adCookieCount = 0;
  const labelCounts = new Map();
  const swSelSet = new Set();

  for (const it of allSwItems) {
    swSelSet.add(it.selector);
    if (unclearRe.test(it.label) || it.label.length < 2) unclearList.push(it);
    if (!it.visible) hiddenCount += 1;
    if (adCookieRe.test(it.label)) adCookieCount += 1;
    const k = `${it.kind}:${it.label.toLowerCase()}:${it.href}`;
    labelCounts.set(k, (labelCounts.get(k) || 0) + 1);
  }
  let duplicateCount = 0;
  for (const cnt of labelCounts.values()) {
    if (cnt > 1) duplicateCount += (cnt - 1);
  }

  summary.domFound = domTruth.count;
  summary.swDetected = allSwItems.length;
  summary.coveragePct = domTruth.count > 0 ? Math.min(100, Math.round((allSwItems.length / domTruth.count) * 100)) : 0;
  summary.unclearLabels = unclearList.length;
  summary.hiddenLeaks = hiddenCount;
  summary.duplicateLeaks = duplicateCount;
  summary.adCookieLeaks = adCookieCount;

  for (const u of unclearList.slice(0, 4)) {
    summary.failures.push({ url: summary.finalUrl, selector: u.selector, input: 'SCAN label clarity', expected: 'Clear human-readable label', actual: `Unclear label: "${u.label}"` });
  }
  const missedSample = domTruth.sample.filter((d) => !swSelSet.has(d.selector)).slice(0, 3);
  for (const m of missedSample) {
    summary.failures.push({ url: summary.finalUrl, selector: m.selector, input: 'SCAN coverage', expected: 'Element detected by Sleepwalker', actual: `Missed visible element ("${m.label || 'unlabeled'}")` });
  }

  // 2. REACH: Test selection by number & by spoken name (EN + HI/Hinglish) on up to 10 diverse detected elements
  const samplePool = allSwItems
    .filter((it) => it.label && it.label.length >= 3 && it.label.length <= 45 && it.kind !== 'input')
    .slice(0, 10);

  if (samplePool.length > 0) {
    const reachRes = await sendToTab(sw, tabId, { action: 'SLEEPWALKER_SW_AUDIT_SNAPSHOT', mode: 'reach', samples: samplePool });
    const rows = (reachRes && Array.isArray(reachRes.out)) ? reachRes.out : [];
    summary.reachTested = rows.length;
    if (reachRes && !reachRes.ordOk) {
      summary.failures.push({ url: summary.finalUrl, selector: 'parseOrdinalChoice', input: '1..3 / पहला / दूसरा', expected: 'Ordinal index parsed', actual: 'Failed ordinal parse' });
    }
    for (const r of rows) {
      if (!r.enHit || !r.hiHit) {
        summary.unreachableCount += 1;
        summary.failures.push({
          url: summary.finalUrl,
          selector: r.selector,
          input: !r.enHit ? `open ${r.label}` : `${r.label} खोलो`,
          expected: 'Element reachable (act or disambiguate)',
          actual: `EN=${r.enOutcome}, HI=${r.hiOutcome}`
        });
      }
    }
  }

  // 3. SAFE CLICK: Strictly plain navigation links / tabs / accordions (NEVER unsafe, NEVER self-URL reload links!)
  const curUrlNoHash = summary.finalUrl.split('#')[0].replace(/\/+$/, '');
  const safeCandidates = allSwItems.filter((it) => {
    if (!it.label || it.label.length < 3 || it.label.length > 42) return false;
    if (it.kind === 'input') return false;
    if (/^(?:skip\s+to|home|slide\s+\d+|page\s+\d+|close)/i.test(it.label)) return false;
    if (UNSAFE_RE.test(it.label) || UNSAFE_HREF_RE.test(it.href)) return false;
    if (it.isAccordionOrTab) return true;
    if (it.tag === 'a' && it.href && /^https?:/i.test(it.href)) {
      try {
        const dest = new URL(it.href);
        const cur = new URL(summary.finalUrl);
        if (dest.hostname !== cur.hostname) return false;
        const destNoHash = it.href.split('#')[0].replace(/\/+$/, '');
        return destNoHash !== curUrlNoHash;
      } catch (_e) { return false; }
    }
    return false;
  });

  const pickedSafe = [];
  const seenSafe = new Set();
  for (const c of safeCandidates) {
    const k = c.label.toLowerCase();
    if (!seenSafe.has(k)) {
      seenSafe.add(k);
      pickedSafe.push(c);
      if (pickedSafe.length >= 2) break;
    }
  }

  for (const cand of pickedSafe) {
    await sleep(PACE_MS);
    summary.safeClicksAttempted += 1;
    const beforeUrl = page.url();
    const beforeExpanded = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return '';
      const li = el.closest('li');
      return `${el.getAttribute('aria-expanded') || ''}|${el.className || ''}|${li ? li.className : ''}`;
    }, cand.selector).catch(() => '');
    let frameNavigated = false;
    const onNav = (fr) => { if (fr === page.mainFrame()) frameNavigated = true; };
    page.on('framenavigated', onNav);
    const curTab = await getTabId(beforeUrl) || tabId;
    const clickRes = await sendToTab(sw, curTab, {
      action: 'SLEEPWALKER_SW_EXECUTE_COMMAND',
      text: `open ${cand.label}`,
      inputSource: 'voice'
    }, 12000).catch((e) => ({ ok: false, error: e.message }));

    await sleep(PACE_MS);
    page.off('framenavigated', onNav);
    const afterUrl = page.url();
    const afterExpanded = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return '';
      const li = el.closest('li');
      return `${el.getAttribute('aria-expanded') || ''}|${el.className || ''}|${li ? li.className : ''}`;
    }, cand.selector).catch(() => '');
    const navigated = frameNavigated || afterUrl !== beforeUrl;
    const stateToggled = Boolean(beforeExpanded && afterExpanded && afterExpanded !== beforeExpanded);
    const channelClosedByNav = Boolean(clickRes && /message channel closed before a response/i.test(String(clickRes.error || '')));
    const r = clickRes && clickRes.res;
    const execOk = Boolean(r && (
      r.ok || r.verified || r.verificationResult === 'verified' ||
      /^(?:navigated|clicked|completed|disambiguate|confirm|needs_confirmation)$/i.test(String(r.status || ''))
    ));

    if (navigated || stateToggled || channelClosedByNav || execOk) {
      summary.safeClicksVerified += 1;
      if (afterUrl !== beforeUrl) {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await sleep(PACE_MS);
      }
    } else {
      summary.wrongClicks += 1;
      summary.failures.push({
        url: beforeUrl,
        selector: cand.selector,
        input: `open ${cand.label}`,
        expected: 'Safe navigation/tab/accordion activated',
        actual: `No verified change (${JSON.stringify(clickRes && (clickRes.res || clickRes.error)).slice(0, 100)})`
      });
    }
  }

  // Highlight-only check on non-safe / input elements (DO NOT click!)
  const unsafeSample = allSwItems.find((it) => it.kind === 'input' || UNSAFE_RE.test(it.label));
  if (unsafeSample) {
    const hlOk = await page.evaluate((sel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return false;
        const prev = el.style.outline;
        el.style.outline = '2px solid #06b6d4';
        setTimeout(() => { el.style.outline = prev; }, 250);
        return true;
      } catch (_e) { return false; }
    }, unsafeSample.selector).catch(() => false);
    if (!hlOk) {
      summary.failures.push({
        url: summary.finalUrl,
        selector: unsafeSample.selector,
        input: 'Highlight non-safe/input element (no click)',
        expected: 'Element highlightable without clicking',
        actual: 'Selector not directly queryable'
      });
    }
  }

  // 4. "what can I do here" + "say more"
  await sleep(PACE_MS);
  const activeTab = await getTabId(page.url()) || tabId;
  await sendToTab(sw, activeTab, { action: 'SLEEPWALKER_SW_EXECUTE_COMMAND', text: 'what can I do here', inputSource: 'voice' }, 12000);
  await sleep(500);
  const wcidState = await sendToTab(sw, activeTab, { action: 'SLEEPWALKER_SW_GET_STATE' });
  const wcidCombined = `${(wcidState && wcidState.visibleCardText) || ''}\n${(wcidState && wcidState.lastSpokenUnifiedReply) || ''}`.trim();
  const numberedLines = (wcidCombined.match(/(?:^|\n|\s)\d+[.)]\s+\S/g) || []).length;
  const hasList = numberedLines >= 3;
  summary.whatCanIDoOk = hasList;
  summary.whatCanIDoCount = numberedLines;
  if (!hasList) {
    summary.failures.push({
      url: page.url(),
      selector: '#sw-ui-card',
      input: 'what can I do here',
      expected: 'Top 5-7 sensible actionable options listed',
      actual: `Got (${numberedLines} numbered items): "${(wcidCombined || 'empty').slice(0, 140)}"`
    });
  }

  await sleep(PACE_MS);
  await sendToTab(sw, activeTab, { action: 'SLEEPWALKER_SW_EXECUTE_COMMAND', text: 'say more', inputSource: 'voice' }, 12000);
  await sleep(500);
  const sayMoreState = await sendToTab(sw, activeTab, { action: 'SLEEPWALKER_SW_GET_STATE' });
  const nextCombined = `${(sayMoreState && sayMoreState.visibleCardText) || ''}\n${(sayMoreState && sayMoreState.lastSpokenUnifiedReply) || ''}`.trim();
  summary.sayMoreOk = Boolean(hasList && nextCombined && nextCombined !== wcidCombined);
  if (!summary.sayMoreOk) {
    summary.failures.push({
      url: page.url(),
      selector: '#sw-ui-card',
      input: 'say more',
      expected: 'Pages through next batch of options',
      actual: `Did not paginate cleanly: "${(nextCombined || 'no change').slice(0, 140)}"`
    });
  }

  summary.timingMs = Date.now() - tStart;
  return summary;
}

function buildTop10Problems(siteSummaries, voiceSuite, dynamicSuite) {
  const issues = [];
  const add = (impactScore, title, detail) => issues.push({ impactScore, title, detail });

  const okSites = siteSummaries.filter((s) => s.status === 'OK');
  const wcidFails = okSites.filter((s) => !s.whatCanIDoOk).length;
  const sayMoreFails = okSites.filter((s) => !s.sayMoreOk).length;
  const totalUnclear = okSites.reduce((a, s) => a + s.unclearLabels, 0);
  const totalDups = okSites.reduce((a, s) => a + s.duplicateLeaks, 0);
  const totalAds = okSites.reduce((a, s) => a + s.adCookieLeaks, 0);
  const totalHidden = okSites.reduce((a, s) => a + s.hiddenLeaks, 0);
  const totalUnreach = okSites.reduce((a, s) => a + s.unreachableCount, 0);
  const totalWrongClicks = okSites.reduce((a, s) => a + s.wrongClicks, 0);
  const avgCov = okSites.length ? Math.round(okSites.reduce((a, s) => a + s.coveragePct, 0) / okSites.length) : 0;

  if (wcidFails > 0 || sayMoreFails > 0) {
    add(100, '"What can I do here" / "Say more" pagination gap', `${wcidFails}/${okSites.length} accessible sites lacked a top 5–7 actionable list and ${sayMoreFails}/${okSites.length} failed "say more" pagination.`);
  }
  const kn = voiceSuite.byCat.kannada || { total: 0, passed: 0 };
  if (kn.total > kn.passed) {
    add(95, 'Kannada voice commands unsupported in parseCommand()', `Only ${kn.passed}/${kn.total} Kannada phrases parsed to expected command types; voice.js lacks Kannada patterns.`);
  }
  const ty = voiceSuite.byCat.typos || { total: 0, passed: 0 };
  if (ty.total > ty.passed) {
    add(90, 'ASR typos fail direct parseCommand() matching', `${ty.passed}/${ty.total} typo phrases passed parseCommand(); single-character ASR slips fall through to QUERY_OR_SEARCH.`);
  }
  const rh = voiceSuite.byCat.romanized_hindi || { total: 0, passed: 0 };
  if (rh.total > rh.passed) {
    add(88, 'Romanized Hindi missing from parseCommand() regexes', `${rh.passed}/${rh.total} romanized Hindi phrases matched (voice.js currently focuses on Devanagari script).`);
  }
  const hi = voiceSuite.byCat.hinglish || { total: 0, passed: 0 };
  if (hi.total > hi.passed) {
    add(85, 'Hinglish code-switched commands misclassified in parseCommand()', `${hi.passed}/${hi.total} Hinglish phrases parsed to expected command types.`);
  }
  if (totalWrongClicks > 0) {
    add(82, 'Safe navigation clicks failed verification on live portals', `${totalWrongClicks} safe click attempt(s) did not produce verified navigation/state change.`);
  }
  if (avgCov < 85 && okSites.length > 0) {
    add(80, `Incomplete actionable element coverage (${avgCov}% avg)`, `Some visible controls (custom widgets, cross-origin iframes, or icon-only controls) were missed during SCAN.`);
  }
  if (totalUnclear > 0) {
    add(76, `Unclear / cryptic spoken labels (${totalUnclear} detected)`, `Icon-only or cryptic ID labels reduce screen-reader/voice clarity.`);
  }
  if (totalDups > 0 || totalAds > 0 || totalHidden > 0) {
    add(72, `Index noise: ${totalDups} duplicates, ${totalAds} ad/cookie items, ${totalHidden} hidden leaks`, `Duplicate or cookie-banner items add clutter to voice disambiguation lists.`);
  }
  if (totalUnreach > 0) {
    add(70, `Unreachable elements via EN/HI spoken names (${totalUnreach})`, `Some scanned elements could not be resolved cleanly by spoken English or Hindi label queries.`);
  }
  for (const d of dynamicSuite.results.filter((r) => !r.ok)) {
    add(78, `Dynamic/Stress failure: ${d.name}`, d.detail);
  }
  const blocked = siteSummaries.filter((s) => s.status === 'BLOCKED_OR_CAPTCHA' || s.status === 'LOAD_ERROR');
  if (blocked.length > 0) {
    add(65, `Bot-protection / network blocks on ${blocked.length} target portal(s)`, blocked.map((b) => `${b.name}: ${b.blockedReason}`).join('; '));
  }

  return issues.sort((a, b) => b.impactScore - a.impactScore).slice(0, 10);
}

function writeReport(siteSummaries, voiceSuite, dynamicSuite) {
  const allFailures = [
    ...siteSummaries.flatMap((s) => s.failures),
    ...dynamicSuite.failures,
    ...voiceSuite.failures.slice(0, 80)
  ];
  const top10 = buildTop10Problems(siteSummaries, voiceSuite, dynamicSuite);

  const lines = [];
  lines.push('# Sleepwalker Automated E2E & Voice Audit Report');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Extension: \`${EXT_DIR}\` (MV3, Headed Chromium Persistent Profile, Pace <= 1 action/sec)`);
  lines.push('');

  lines.push('## 1. Per-Site Audit Summary');
  lines.push('| Site | Status | DOM Found | SW Detected | Coverage | Unclear Labels | Hidden/Dup/Ad Leaks | Unreachable (EN/HI) | Safe Clicks (OK/Try) | Wrong Clicks | "What can I do" / "Say more" | Time (ms) |');
  lines.push('|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|---:|');
  for (const s of siteSummaries) {
    const statusCell = s.status === 'OK' ? 'OK' : `${s.status} (${s.blockedReason})`;
    lines.push(`| ${s.name} | ${statusCell} | ${s.domFound} | ${s.swDetected} | ${s.coveragePct}% | ${s.unclearLabels} | ${s.hiddenLeaks} / ${s.duplicateLeaks} / ${s.adCookieLeaks} | ${s.unreachableCount}/${s.reachTested} | ${s.safeClicksVerified}/${s.safeClicksAttempted} | ${s.wrongClicks} | ${s.whatCanIDoOk ? 'PASS' : 'FAIL'} / ${s.sayMoreOk ? 'PASS' : 'FAIL'} | ${s.timingMs} |`);
  }
  lines.push('');

  lines.push('## 2. Dynamic Content & Stress Tests');
  lines.push('| Test | Result | Detail |');
  lines.push('|---|---|---|');
  for (const r of dynamicSuite.results) {
    lines.push(`| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${String(r.detail || '').replace(/\|/g, '/')} |`);
  }
  lines.push('');

  lines.push(`## 3. Voice Command Corpus (${voiceSuite.total} Phrases -> \`parseCommand()\`)`);
  lines.push(`Overall: **${voiceSuite.passed} / ${voiceSuite.total}** (${Math.round((voiceSuite.passed / Math.max(1, voiceSuite.total)) * 100)}%)`);
  lines.push('');
  lines.push('| Category | Passed | Total | Pass Rate |');
  lines.push('|---|---:|---:|---:|');
  for (const [cat, stat] of Object.entries(voiceSuite.byCat)) {
    lines.push(`| ${cat} | ${stat.passed} | ${stat.total} | ${Math.round((stat.passed / Math.max(1, stat.total)) * 100)}% |`);
  }
  lines.push('');

  lines.push('## 4. Top 10 Problems Ranked by User Impact');
  top10.forEach((item, i) => {
    lines.push(`${i + 1}. **${item.title}** — ${item.detail}`);
  });
  lines.push('');

  lines.push(`## 5. Failure Log (${allFailures.length} shown; total voice misses: ${voiceSuite.failures.length})`);
  lines.push('| URL | Element / Selector | Input | Expected | Actual |');
  lines.push('|---|---|---|---|---|');
  for (const f of allFailures) {
    const clean = (v) => String(v || '').replace(/\|/g, '/').replace(/\r?\n/g, ' ').slice(0, 120);
    lines.push(`| ${clean(f.url)} | \`${clean(f.selector)}\` | ${clean(f.input)} | ${clean(f.expected)} | ${clean(f.actual)} |`);
  }
  lines.push('');

  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
  return REPORT_PATH;
}

(async () => {
  console.log('[1/3] Running 350 voice-command phrase corpus...');
  const voiceSuite = runVoicePhraseSuite();
  console.log(`      Voice corpus: ${voiceSuite.passed}/${voiceSuite.total} passed.`);

  console.log('[2/3] Launching HEADED Chromium with unpacked Sleepwalker extension...');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  let executablePath;
  if (!fs.existsSync(chromium.executablePath())) {
    const cacheDir = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    if (fs.existsSync(cacheDir)) {
      const dirs = fs.readdirSync(cacheDir).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
      for (const d of dirs) {
        const cand = path.join(cacheDir, d, 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(cand)) { executablePath = cand; break; }
      }
    }
  }
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath,
    viewport: { width: 1366, height: 840 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  console.log(`      Extension service worker active: ${sw.url()}`);

  const getTabId = async (targetUrl) => {
    return sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      const exact = tabs.find((t) => t.url === u) || tabs.find((t) => t.active && !/^chrome-extension:/.test(t.url || ''));
      return exact ? exact.id : null;
    }, targetUrl);
  };

  const pages = context.pages();
  const page = pages.find((p) => !p.url().startsWith('chrome-extension://')) || await context.newPage();
  for (const p of context.pages()) {
    if (p !== page && p.url().startsWith('chrome-extension://')) {
      await p.close().catch(() => {});
    }
  }

  console.log('[2B/3] Running dynamic content & stress tests...');
  const dynamicSuite = await runDynamicAndStressSuite(page, sw, getTabId, sendToTab);
  console.log(`       Dynamic/Stress: ${dynamicSuite.results.filter((r) => r.ok).length}/${dynamicSuite.results.length} passed.`);

  console.log('[3/3] Auditing target sites (strict safety rules, <= 1 action/sec)...');
  const siteSummaries = [];
  for (const site of TARGET_SITES) {
    console.log(`      -> Auditing ${site.name} (${site.url})...`);
    const s = await auditSite(page, sw, getTabId, site);
    console.log(`         ${site.name}: ${s.status} | DOM=${s.domFound}, SW=${s.swDetected} (${s.coveragePct}%), unclear=${s.unclearLabels}, clicks=${s.safeClicksVerified}/${s.safeClicksAttempted}, ${s.timingMs}ms`);
    siteSummaries.push(s);
    await sleep(PACE_MS);
  }

  await context.close();

  const reportFile = writeReport(siteSummaries, voiceSuite, dynamicSuite);
  console.log(`\nReport written to: ${reportFile}`);
})().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
