/**
 * Sleepwalker - Cross-script phonetic matching unit tests (match.js).
 * Run: node tests/test_phonetic_nav.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const M = require(path.join(__dirname, '..', 'match.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

// Devanagari-rendered English link names (Chrome hi-IN recognizer style) -> Latin label
const PAIRS = [
  ['टुमारो शो', 'The Tomorrow Show'],
  ['विकिपीडिया', 'Wikipedia'],
  ['क्रिकेट', 'Cricket'],
  ['सर्च', 'Search'],
  ['लाइब्रेरी', 'Library'],
  ['सेटिंग्स', 'Settings'],
  ['प्रोफाइल', 'Profile'],
  ['हिस्ट्री', 'History'],
  ['साइंस', 'Science'],
  ['टेक्नोलॉजी', 'Technology'],
  ['फोटोग्राफी', 'Photography'],
  ['कंप्यूटर', 'Computer'],
  ['यूनिवर्सिटी', 'University'],
  ['फुटबॉल', 'Football'],
  ['टेलीविजन', 'Television'],
  ['हॉस्पिटल', 'Hospital'],
  ['गवर्नमेंट', 'Government'],
  ['स्कॉलरशिप', 'Scholarship'],
  ['डॉक्यूमेंट', 'Document'],
  ['नेक्स्ट पेज', 'Next Page'],
  ['कॉन्टैक्ट अस', 'Contact Us'],
  ['होम पेज', 'Home Page']
];

check('phoneticKey("टुमारो शो") === phoneticKey("Tomorrow Show")', () => {
  assert.strictEqual(M.phoneticKey('टुमारो शो'), M.phoneticKey('Tomorrow Show'));
  assert.strictEqual(M.phoneticKey('टुमारो शो'), M.phoneticKey('The Tomorrow Show'));
});

check('Command words stripped (EN / HI / Hinglish)', () => {
  const k = M.phoneticKey('Tomorrow Show');
  assert.strictEqual(M.phoneticKey('tomorrow show kholo'), k);
  assert.strictEqual(M.phoneticKey('tomorrow show ko open karo'), k);
  assert.strictEqual(M.phoneticKey('टुमारो शो लिंक पर क्लिक करो'), k);
  assert.strictEqual(M.phoneticKey('click the tomorrow show link'), k);
});

check('Hyphenated "To-Morrow" keeps its "to"', () => {
  assert.strictEqual(M.phoneticKey('To-Morrow (Chicago magazine)').startsWith(M.phoneticKey('tomorrow')), true);
});

const scored = [];
for (const [dev, latin] of PAIRS) {
  check(`Devanagari "${dev}" best-matches "${latin}" among all ${PAIRS.length} labels`, () => {
    const ranked = PAIRS.map(([, l]) => ({ l, s: M.scoreCandidate(dev, l) })).sort((a, b) => b.s - a.s);
    scored.push({ dev, latin, top: ranked[0].l, score: ranked[0].s, key: M.phoneticKey(dev), labelKey: M.phoneticKey(latin) });
    assert.strictEqual(ranked[0].l, latin, `got ${ranked[0].l} (${ranked[0].s}) keys ${M.phoneticKey(dev)} vs ${M.phoneticKey(latin)}`);
    assert.ok(ranked[0].s >= 80, `score too low: ${ranked[0].s}`);
    if (ranked[1]) assert.ok(ranked[0].s > ranked[1].s, `tie with ${ranked[1].l}`);
  });
}

check('Tomorrow fixture ranking', () => {
  const labels = ['The Tomorrow Show', 'Tomorrow (time)', 'To-Morrow (Chicago magazine)'];
  const top = (q) => labels.map((l) => ({ l, s: M.scoreCandidate(q, l) })).sort((a, b) => b.s - a.s);
  assert.strictEqual(top('टुमारो शो')[0].l, 'The Tomorrow Show');
  assert.strictEqual(top('tomorrow time link kholo')[0].l, 'Tomorrow (time)');
  const bare = top('टुमारो');
  assert.ok(bare[0].s - bare[1].s < 10, 'bare "टुमारो" must be ambiguous: ' + JSON.stringify(bare));
  const unrelated = top('weather forecast mumbai');
  assert.ok(unrelated[0].s < 60, 'unrelated must not match: ' + JSON.stringify(unrelated));
  assert.ok(M.scoreCandidate('secret password', 'Contact Us') < 60, '1-char skeleton token "s" must not false-match "secret password"');
});

check('parseOrdinalChoice (1/ek/एक/one, number 3/teen number/तीसरा)', () => {
  for (const t of ['1', 'ek', 'एक', 'one', 'first', 'पहला', '१']) assert.strictEqual(M.parseOrdinalChoice(t, 5), 1, t);
  for (const t of ['number 3', 'teen number', 'तीसरा', '3', 'three', 'तीन']) assert.strictEqual(M.parseOrdinalChoice(t, 5), 3, t);
  assert.strictEqual(M.parseOrdinalChoice('kar do', 5), null);
  assert.strictEqual(M.parseOrdinalChoice('6', 5), null);
  assert.strictEqual(M.parseOrdinalChoice('tomorrow show', 5), null);
});

const llm = require(path.join(__dirname, '..', 'llm.js'));
check('L5 buildLinkPickPrompt enforces <=15 candidates, "id | label | context (<=40)", and <=250 input tokens', () => {
  const many = Array.from({ length: 22 }, (_, i) => ({
    id: i + 1,
    label: `Link Candidate ${i + 1} Long Title`,
    context: 'Scholarship portal grant info summary exceeding forty chars limit here',
    extraSecret: 'PASSWORD_DO_NOT_LEAK',
    pageText: 'PAGE_BODY_DO_NOT_LEAK'
  }));
  const built = llm.buildLinkPickPrompt('watch news channel', many);
  assert.ok(built && built.userPrompt);
  const lines = built.userPrompt.split('\n').slice(1);
  assert.ok(lines.length <= 15, `expected <=15 lines, got ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /^\d+\s*\|\s*.+\s*\|\s*.+/);
    const ctxPart = line.split('|')[2].trim();
    assert.ok(ctxPart.length <= 40, `context exceeded 40 chars: ${ctxPart.length}`);
  }
  assert.ok(!built.userPrompt.includes('PASSWORD_DO_NOT_LEAK'));
  assert.ok(!built.userPrompt.includes('PAGE_BODY_DO_NOT_LEAK'));
  assert.ok(llm.estimateTokens(built.userPrompt) <= 250, 'prompt must stay <= 250 tokens');
});

async function runAsync() {
  llm.resetLlmStateForTests();
  global.chrome = {
    storage: {
      local: {
        get: (_k, cb) => cb({ sleepwalker_proxy_url: 'https://mock.proxy.local/explain', sleepwalker_local_only: false })
      }
    }
  };
  const origFetch = global.fetch;
  let capturedPrompt = '';
  let fetchCalls = 0;
  global.fetch = async (_url, opts) => {
    fetchCalls += 1;
    const body = JSON.parse(opts.body);
    capturedPrompt = JSON.stringify(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ answer: JSON.stringify({ action: 'CLICK', id: 2, confidence: 0.91 }), source: 'mock-proxy' })
    };
  };
  try {
    const res = await llm.handleLinkPickRequest({
      spokenText: 'televiz',
      pageHash: 'lh_test1',
      candidates: [
        { id: 1, label: 'Search', context: 'Top header search' },
        { id: 2, label: 'Television', context: 'Broadcast shows' }
      ],
      pageText: 'SECRET_PAGE_BODY',
      formValues: { pw: 'SecretPass' }
    });
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.action, 'CLICK');
    assert.strictEqual(res.id, 2);
    assert.strictEqual(res.confidence, 0.91);
    assert.strictEqual(fetchCalls, 1);
    assert.ok(!capturedPrompt.includes('SECRET_PAGE_BODY'));
    assert.ok(!capturedPrompt.includes('SecretPass'));

    // Second identical (pageHash, utterance) call MUST hit cache with 0 new fetch calls
    const cachedRes = await llm.handleLinkPickRequest({
      spokenText: 'televiz',
      pageHash: 'lh_test1',
      candidates: [{ id: 1, label: 'Search', context: 'Top header search' }, { id: 2, label: 'Television', context: 'Broadcast shows' }]
    });
    assert.strictEqual(cachedRes.cached, true);
    assert.strictEqual(fetchCalls, 1, 'Expected (pageHash, utterance) cache hit without second fetch');
    console.log('PASS  L5 handleLinkPickRequest returns {action, id, confidence}, caches by (pageHash, utterance), zero leaks');
    passed += 1;
  } catch (e) {
    failed += 1;
    console.log(`FAIL  L5 handleLinkPickRequest: ${e.message}`);
  } finally {
    global.fetch = origFetch;
  }

  console.log(`\nSummary: ${passed}/${passed + failed} phonetic checks passed.`);
  if (failed > 0) {
    console.log(JSON.stringify(scored.filter((s) => s.top !== s.latin), null, 1));
    process.exit(1);
  }
}
runAsync();
