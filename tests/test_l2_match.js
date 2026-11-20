/**
 * Sleepwalker Phase L2 Test Suite: match.js + 65+ phrase/target test table (0 LLM).
 * Run: node D:\sleep\tests\test_l2_match.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const M = require(path.join(__dirname, '..', 'match.js'));

function makeTarget(id, label, extra = {}) {
  return {
    id,
    label,
    ariaLabel: extra.ariaLabel || '',
    title: extra.title || '',
    hrefWords: extra.hrefWords || '',
    role: extra.role || 'link',
    area: extra.area || 'main',
    context: extra.context || '',
    contextHeading: extra.contextHeading || '',
    contextSnippet: extra.contextSnippet || '',
    position: {
      index: id - 1,
      areaIndex: extra.areaIndex ?? 0,
      rect: extra.rect || { top: 100 + id * 10, left: 40, width: 120, height: 32 },
      inViewport: extra.inViewport !== false,
      isTopRight: Boolean(extra.isTopRight)
    },
    flags: {
      external: Boolean(extra.external),
      download: Boolean(extra.download),
      newTab: Boolean(extra.newTab),
      risky: Boolean(extra.risky),
      inViewport: extra.inViewport !== false,
      inMain: extra.inMain !== false
    }
  };
}

// Rich multi-card + disambiguation + icon-only target fixture
const CATALOG = [
  makeTarget(1, 'Home', { area: 'nav', inMain: false, areaIndex: 0 }),
  makeTarget(2, 'The Tomorrow Show', { hrefWords: 'the tomorrow show', contextHeading: 'Broadcast' }),
  makeTarget(3, 'Tomorrow (time)', { hrefWords: 'tomorrow time', contextHeading: 'Concept' }),
  makeTarget(4, 'To-Morrow (Chicago magazine)', { hrefWords: 'to morrow chicago magazine', contextHeading: 'Publication' }),
  makeTarget(5, 'Read more', {
    area: 'card',
    contextHeading: 'National Scholarships',
    context: 'National Scholarships — Apply for tuition grants and stipend support before January 15.',
    hrefWords: 'scholarships overview'
  }),
  makeTarget(6, 'Learn more', {
    area: 'card',
    contextHeading: 'Hostel & Mess Facilities',
    context: 'Hostel & Mess Facilities — View campus housing rooms and dining timings.',
    hrefWords: 'hostel guide'
  }),
  makeTarget(7, 'Details', {
    area: 'card',
    contextHeading: 'Examination Schedule',
    context: 'Examination Schedule — Semester timetable and admit card dates.',
    hrefWords: 'exam timetable'
  }),
  makeTarget(8, 'Fees', { area: 'nav', inMain: false, areaIndex: 1, hrefWords: 'application fee structure' }),
  makeTarget(9, 'Contact Us', { area: 'footer', inMain: false, hrefWords: 'reach support helpline' }),
  makeTarget(10, 'Sign In', { area: 'header', inMain: false, isTopRight: true, hrefWords: 'user login portal' }),
  makeTarget(11, 'Register', { hrefWords: 'online student application' }),
  makeTarget(12, 'ABC', { hrefWords: 'abc index' }),
  makeTarget(13, 'FAQ', { hrefWords: 'frequently asked questions' }),
  makeTarget(14, 'Search Portal', { ariaLabel: 'Search Portal', title: 'Search Portal', role: 'button' }),
  makeTarget(15, 'Wikipedia', {}),
  makeTarget(16, 'Cricket', {}),
  makeTarget(17, 'Television', {}),
  makeTarget(18, 'Library', {}),
  makeTarget(19, 'Profile', {}),
  makeTarget(20, 'History', {}),
  makeTarget(21, 'Science', {}),
  makeTarget(22, 'Technology', {}),
  makeTarget(23, 'Photography', {}),
  makeTarget(24, 'Computer', {}),
  makeTarget(25, 'University', {}),
  makeTarget(26, 'Football', {}),
  makeTarget(27, 'Hospital', {}),
  makeTarget(28, 'Government', {}),
  makeTarget(29, 'Document', {}),
  makeTarget(30, 'Next Page', {}),
  makeTarget(31, 'Submit Application', { role: 'button', risky: true }),
  makeTarget(32, 'Download Brochure', { title: 'Annual PDF Brochure', hrefWords: 'annual brochure pdf' })
];

const TEST_CASES = [
  // Skeleton unit sanity
  { name: 'phoneticSkeleton exact Tomorrow Show == टुमारो शो ("t m r sh")', fn: () => {
    assert.strictEqual(M.phoneticSkeleton('The Tomorrow Show'), 't m r sh');
    assert.strictEqual(M.phoneticSkeleton('टुमारो शो'), 't m r sh');
  }},
  { name: 'edit distance <=1 on 4+ skeleton acts ("टुमारो श" ~ "Tomorrow Show")', query: 'टुमारो श', action: 'CLICK', outcome: 'act', label: 'The Tomorrow Show' },

  // Exact, Hinglish & Hindi commands -> The Tomorrow Show / Tomorrow (time)
  { query: 'टुमारो शो', action: 'CLICK', outcome: 'act', label: 'The Tomorrow Show' },
  { query: 'tomorrow show kholo', action: 'CLICK', outcome: 'act', label: 'The Tomorrow Show' },
  { query: 'tomorrow show par click karo', action: 'CLICK', outcome: 'act', label: 'The Tomorrow Show' },
  { query: 'open the tomorrow show link', action: 'CLICK', outcome: 'act', label: 'The Tomorrow Show' },
  { query: 'tomorrow time link kholo', action: 'CLICK', outcome: 'act', label: 'Tomorrow (time)' },
  { query: 'To-Morrow Chicago magazine', action: 'CLICK', outcome: 'act', label: 'To-Morrow (Chicago magazine)' },

  // Spelled-out letters ("a b c", "ए बी सी", "f a q")
  { query: 'a b c', action: 'CLICK', outcome: 'act', label: 'ABC' },
  { query: 'ए बी सी', action: 'CLICK', outcome: 'act', label: 'ABC' },
  { query: 'open a b c link', action: 'CLICK', outcome: 'act', label: 'ABC' },
  { query: 'f a q kholo', action: 'CLICK', outcome: 'act', label: 'FAQ' },
  { query: 'एफ ए क्यू', action: 'CLICK', outcome: 'act', label: 'FAQ' },

  // Light stemming & synonyms
  { query: 'fee', action: 'CLICK', outcome: 'act', label: 'Fees' },
  { query: 'fees', action: 'CLICK', outcome: 'act', label: 'Fees' },
  { query: 'reach us', action: 'CLICK', outcome: 'act', label: 'Contact Us' },
  { query: 'संपर्क', action: 'CLICK', outcome: 'act', label: 'Contact Us' },
  { query: 'login', action: 'CLICK', outcome: 'act', label: 'Sign In' },
  { query: 'लॉगिन', action: 'CLICK', outcome: 'act', label: 'Sign In' },
  { query: 'apply', action: 'CLICK', outcome: 'act', label: 'Register' },
  { query: 'आवेदन', action: 'CLICK', outcome: 'act', label: 'Register' },
  { query: 'submitted application', action: 'CLICK', outcome: 'act', label: 'Submit Application' },
  { query: 'downloading brochure', action: 'CLICK', outcome: 'act', label: 'Download Brochure' },

  // href-slug words & aria-label / title
  { query: 'annual brochure pdf', action: 'CLICK', outcome: 'act', label: 'Download Brochure' },
  { query: 'Search Portal', action: 'CLICK', outcome: 'act', label: 'Search Portal' },
  { query: 'search', action: 'CLICK', outcome: 'act', label: 'Search Portal' },
  { query: 'exam timetable', action: 'CLICK', outcome: 'act', label: 'Details' },

  // MORE_INFO contextual boosting on generic card links
  { query: 'scholarships', action: 'MORE_INFO', outcome: 'act', label: 'Read more' },
  { query: 'राष्ट्रीय स्कॉलरशिप', action: 'MORE_INFO', outcome: 'act', label: 'Read more' },
  { query: 'hostel', action: 'MORE_INFO', outcome: 'act', label: 'Learn more' },
  { query: 'examination schedule', action: 'MORE_INFO', outcome: 'act', label: 'Details' },
  { query: 'application fee', action: 'MORE_INFO', outcome: 'act', label: 'Fees' },

  // Devanagari-rendered English link phrases (22+ entries across languages/noise)
  { query: 'विकिपीडिया', action: 'CLICK', outcome: 'act', label: 'Wikipedia' },
  { query: 'क्रिकेट', action: 'CLICK', outcome: 'act', label: 'Cricket' },
  { query: 'टेलीविजन', action: 'CLICK', outcome: 'act', label: 'Television' },
  { query: 'लाइब्रेरी', action: 'CLICK', outcome: 'act', label: 'Library' },
  { query: 'प्रोफाइल', action: 'CLICK', outcome: 'act', label: 'Profile' },
  { query: 'हिस्ट्री', action: 'CLICK', outcome: 'act', label: 'History' },
  { query: 'साइंस', action: 'CLICK', outcome: 'act', label: 'Science' },
  { query: 'टेक्नोलॉजी', action: 'CLICK', outcome: 'act', label: 'Technology' },
  { query: 'फोटोग्राफी', action: 'CLICK', outcome: 'act', label: 'Photography' },
  { query: 'कंप्यूटर', action: 'CLICK', outcome: 'act', label: 'Computer' },
  { query: 'यूनिवर्सिटी', action: 'CLICK', outcome: 'act', label: 'University' },
  { query: 'फुटबॉल', action: 'CLICK', outcome: 'act', label: 'Football' },
  { query: 'हॉस्पिटल', action: 'CLICK', outcome: 'act', label: 'Hospital' },
  { query: 'गवर्नमेंट', action: 'CLICK', outcome: 'act', label: 'Government' },
  { query: 'डॉक्यूमेंट', action: 'CLICK', outcome: 'act', label: 'Document' },
  { query: 'नेक्स्ट पेज', action: 'CLICK', outcome: 'act', label: 'Next Page' },
  { query: 'यूनिवर्सिटी लिंक खोलो', action: 'CLICK', outcome: 'act', label: 'University' },
  { query: 'प्रोफाइल पर क्लिक करो', action: 'CLICK', outcome: 'act', label: 'Profile' },
  { query: 'डॉक्यूमेंट बटन दबाओ', action: 'CLICK', outcome: 'act', label: 'Document' },
  { query: 'गवर्नमेंट वाला लिंक खोलो', action: 'CLICK', outcome: 'act', label: 'Government' },
  { query: 'फोटोग्राफी दिखाओ', action: 'FIND', outcome: 'act', label: 'Photography' },
  { query: 'कंप्यूटर कहाँ है', action: 'FIND', outcome: 'act', label: 'Computer' },
  { query: 'कॉन्टैक्ट अस', action: 'CLICK', outcome: 'act', label: 'Contact Us' },

  // Positional / Area selectors
  { name: 'first link in menu -> Home', spec: { target: '', area: 'nav', roleHint: 'link', ordinal: 1 }, outcome: 'act', label: 'Home' },
  { name: 'second link in menu -> Fees', spec: { target: '', area: 'nav', roleHint: 'link', ordinal: 2 }, outcome: 'act', label: 'Fees' },
  { name: 'last button -> Submit Application', spec: { target: '', roleHint: 'button', positionHint: 'last' }, outcome: 'act', label: 'Submit Application' },
  { name: 'top right link -> Sign In', spec: { target: '', positionHint: 'top_right' }, outcome: 'act', label: 'Sign In' },

  // Ambiguous & disambiguation rules
  { name: 'bare "टुमारो" -> disambiguate across 3 Tomorrow links', query: 'टुमारो', action: 'CLICK', outcome: 'disambiguate', minOptions: 3, maxOptions: 5 },
  { name: 'bare "tomorrow" -> disambiguate across 3 Tomorrow links', query: 'tomorrow', action: 'CLICK', outcome: 'disambiguate', minOptions: 3, maxOptions: 5 },
  { name: 'equal tie across 2 "Settings" links -> never guess', fn: () => {
    const tied = [
      makeTarget(1, 'Settings', { area: 'header', inMain: false }),
      makeTarget(2, 'Settings', { area: 'main', inMain: true })
    ];
    const dec = M.decideMatch(tied, { target: 'Settings', action: 'CLICK' });
    assert.strictEqual(dec.outcome, 'disambiguate', 'Must NOT guess on equal ties');
    assert.strictEqual(dec.options.length, 2);
  }},
  { name: 'moderate single match (< 0.85, >= 0.4) -> does not auto-act without confirm/disambiguate', fn: () => {
    const partial = [makeTarget(1, 'Annual National Science Symposium', {})];
    const dec = M.decideMatch(partial, { target: 'science', action: 'CLICK' });
    assert.strictEqual(dec.outcome, 'disambiguate', `got ${dec.outcome} (${dec.best && dec.best.score})`);
  }},

  // Unrelated / Below 0.4 -> no_match with 3 nearest labels
  { query: 'banana space rocket', action: 'CLICK', outcome: 'no_match', expectNearest: 3 },
  { query: 'केला अंतरिक्ष यान', action: 'CLICK', outcome: 'no_match', expectNearest: 3 },
  { query: 'zzzz unknown widget', action: 'CLICK', outcome: 'no_match', expectNearest: 3 },

  // Ordinals check in L2 table
  { name: 'ordinals ("number 3", "teen number", "तीसरा", "ek", "एक")', fn: () => {
    assert.strictEqual(M.parseOrdinalChoice('number 3', 5), 3);
    assert.strictEqual(M.parseOrdinalChoice('teen number', 5), 3);
    assert.strictEqual(M.parseOrdinalChoice('तीसरा', 5), 3);
    assert.strictEqual(M.parseOrdinalChoice('ek', 5), 1);
    assert.strictEqual(M.parseOrdinalChoice('एक', 5), 1);
  }}
];

assert.ok(TEST_CASES.length >= 60, `Expected >= 60 test cases, found ${TEST_CASES.length}`);

let passed = 0;
let failed = 0;
for (const tc of TEST_CASES) {
  const label = tc.name || `"${tc.query}" [${tc.action}] -> ${tc.outcome}${tc.label ? ':' + tc.label : ''}`;
  try {
    if (tc.fn) {
      tc.fn();
    } else {
      const spec = tc.spec || { target: tc.query, action: tc.action || 'CLICK' };
      const dec = M.decideMatch(CATALOG, spec);
      assert.strictEqual(
        dec.outcome,
        tc.outcome,
        `expected outcome ${tc.outcome}, got ${dec.outcome} (top=${dec.best && dec.best.target.label}:${dec.best && dec.best.score})`
      );
      if (tc.label) {
        assert.ok(dec.best && dec.best.target, 'expected best target');
        assert.strictEqual(dec.best.target.label, tc.label, `expected ${tc.label}, got ${dec.best.target.label}`);
      }
      if (tc.minOptions) assert.ok(dec.options.length >= tc.minOptions, `options ${dec.options.length} < ${tc.minOptions}`);
      if (tc.maxOptions) assert.ok(dec.options.length <= tc.maxOptions, `options ${dec.options.length} > ${tc.maxOptions}`);
      if (tc.expectNearest) assert.strictEqual(dec.nearest.length, tc.expectNearest);
    }
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${label}: ${err.message}`);
  }
}

const rate = ((passed / TEST_CASES.length) * 100).toFixed(1);
console.log(`\nL2 Phrase/Target Match Pass Rate: ${passed}/${TEST_CASES.length} (${rate}%) — 0 LLM calls`);
if (failed > 0) process.exit(1);
