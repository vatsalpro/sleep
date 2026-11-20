/**
 * Sleepwalker Phase L3 Test Suite: link-intent.js (65+ sentences, 0 LLM calls).
 * Run: node D:\sleep\tests\test_l3_link_intent.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { SleepwalkerLinkIntent } = require(path.join(__dirname, '..', 'link-intent.js'));

const parser = new SleepwalkerLinkIntent();

const CASES = [
  // CLICK (EN / HI / Hinglish / bare phonetic)
  { input: 'click on link abc', expect: { action: 'CLICK', target: 'abc' } },
  { input: 'open abc', expect: { action: 'CLICK', target: 'abc' } },
  { input: 'press the abc button', expect: { action: 'CLICK', target: 'abc' } },
  { input: 'abc kholo', expect: { action: 'CLICK', target: 'abc' } },
  { input: 'abc par click karo', expect: { action: 'CLICK', target: 'abc' } },
  { input: 'please can you open the fees link', expect: { action: 'CLICK', target: 'fees' } },
  { input: 'tap on submit button', expect: { action: 'CLICK', target: 'submit' } },
  { input: 'go to admissions', expect: { action: 'CLICK', target: 'admissions' } },
  { input: 'take me to login', expect: { action: 'CLICK', target: 'login' } },
  { input: 'visit help desk', expect: { action: 'CLICK', target: 'help desk' } },
  { input: 'scholarship wala link kholo', expect: { action: 'CLICK', target: 'scholarship' } },
  { input: 'fees ko dabao', expect: { action: 'CLICK', target: 'fees' } },
  { input: 'portal par jao', expect: { action: 'CLICK', target: 'portal' } },
  { input: 'form par le chalo', expect: { action: 'CLICK', target: 'form' } },
  { input: 'zara ek download button dabao', expect: { action: 'CLICK', target: 'download' } },
  { input: 'टुमारो शो खोलो', expect: { action: 'CLICK', target: 'टुमारो शो' } },
  { input: 'टुमारो शो', expect: { action: 'CLICK', target: 'टुमारो शो' } },
  { input: 'टुमारो शो लिंक पर क्लिक करो', expect: { action: 'CLICK', target: 'टुमारो शो' } },
  { input: 'tomorrow show ko open karo', expect: { action: 'CLICK', target: 'tomorrow show' } },
  { input: 'open the tomorrow show', expect: { action: 'CLICK', target: 'tomorrow show' } },
  { input: 'tomorrow time link kholo', expect: { action: 'CLICK', target: 'tomorrow time' } },

  // Spelled-out letters ("a b c" <-> "abc", "ए बी सी" <-> "abc")
  { input: 'a b c', expect: { action: 'CLICK', target: 'abc' } },
  { input: 'click on a b c', expect: { action: 'CLICK', target: 'abc' } },
  { input: 'ए बी सी', expect: { action: 'CLICK', target: 'abc' } },
  { input: 'ए बी सी खोलो', expect: { action: 'CLICK', target: 'abc' } },
  { input: 'open f a q link', expect: { action: 'CLICK', target: 'faq' } },
  { input: 'एफ ए क्यू लिंक दबाओ', expect: { action: 'CLICK', target: 'faq' } },

  // FIND (highlight and locate)
  { input: 'find link abc', expect: { action: 'FIND', target: 'abc' } },
  { input: 'where is abc', expect: { action: 'FIND', target: 'abc' } },
  { input: 'abc dikhao', expect: { action: 'FIND', target: 'abc' } },
  { input: 'locate login button', expect: { action: 'FIND', target: 'login' } },
  { input: 'show me scholarships', expect: { action: 'FIND', target: 'scholarships' } },
  { input: 'fees dhundo', expect: { action: 'FIND', target: 'fees' } },
  { input: 'eligibility kahan hai', expect: { action: 'FIND', target: 'eligibility' } },
  { input: 'कंप्यूटर कहाँ है', expect: { action: 'FIND', target: 'कंप्यूटर' } },
  { input: 'फोटोग्राफी दिखाओ', expect: { action: 'FIND', target: 'फोटोग्राफी' } },
  { input: 'यूनिवर्सिटी ढूंढो', expect: { action: 'FIND', target: 'यूनिवर्सिटी' } },

  // FIND_THEN_CLICK (compound commands)
  { input: 'find link abc and click on it', expect: { action: 'FIND_THEN_CLICK', target: 'abc' } },
  { input: 'abc dhundo aur kholo', expect: { action: 'FIND_THEN_CLICK', target: 'abc' } },
  { input: 'find link tomorrow show and click it', expect: { action: 'FIND_THEN_CLICK', target: 'tomorrow show' } },
  { input: 'find and open contact us', expect: { action: 'FIND_THEN_CLICK', target: 'contact us' } },
  { input: 'fees dhundho aur click karo', expect: { action: 'FIND_THEN_CLICK', target: 'fees' } },
  { input: 'टुमारो शो ढूंढो और खोलो', expect: { action: 'FIND_THEN_CLICK', target: 'टुमारो शो' } },
  { input: 'locate fees and open it', expect: { action: 'FIND_THEN_CLICK', target: 'fees' } },

  // MORE_INFO (EN / HI / Hinglish)
  { input: 'I want more info on abc', expect: { action: 'MORE_INFO', target: 'abc' } },
  { input: 'tell me more about abc', expect: { action: 'MORE_INFO', target: 'abc' } },
  { input: 'abc ke baare mein aur batao', expect: { action: 'MORE_INFO', target: 'abc' } },
  { input: 'abc ki jaankari chahiye', expect: { action: 'MORE_INFO', target: 'abc' } },
  { input: 'I want more info on scholarships', expect: { action: 'MORE_INFO', target: 'scholarships' } },
  { input: 'learn more about hostel facilities', expect: { action: 'MORE_INFO', target: 'hostel facilities' } },
  { input: 'details about exam dates', expect: { action: 'MORE_INFO', target: 'exam dates' } },
  { input: 'स्कॉलरशिप के बारे में और बताओ', expect: { action: 'MORE_INFO', target: 'स्कॉलरशिप' } },
  { input: 'फीस की जानकारी चाहिए', expect: { action: 'MORE_INFO', target: 'फीस' } },

  // LIST
  { input: 'what links are there', expect: { action: 'LIST', target: '' } },
  { input: 'read the links', expect: { action: 'LIST', target: '' } },
  { input: 'kaun se links hain', expect: { action: 'LIST', target: '' } },
  { input: 'लिंक्स बताओ', expect: { action: 'LIST', target: '' } },
  { input: 'show all links', expect: { action: 'LIST', target: '' } },

  // CHOOSE & follow-ups
  { input: 'the second one', expect: { action: 'CHOOSE', target: '', ordinal: 2 } },
  { input: 'number 3', expect: { action: 'CHOOSE', target: '', ordinal: 3 } },
  { input: 'teesra wala', expect: { action: 'CHOOSE', target: '', ordinal: 3 } },
  { input: 'wo wala', expect: { action: 'CHOOSE', target: '', ordinal: 1, chooseMode: 'it' } },
  { input: 'no, the other one', expect: { action: 'CHOOSE', target: '', chooseMode: 'other' } },
  { input: 'तीसरा वाला', expect: { action: 'CHOOSE', target: '', ordinal: 3 } },
  { input: '३', context: { hasPendingNavChoice: true }, expect: { action: 'CHOOSE', target: '', ordinal: 3 } },
  { input: 'ek', context: { hasPendingNavChoice: true }, expect: { action: 'CHOOSE', target: '', ordinal: 1 } },
  { input: 'click it', expect: { action: 'CLICK', target: '', useLastTarget: true } },

  // CANCEL
  { input: 'cancel', expect: { action: 'CANCEL', target: '' } },
  { input: 'rehne do', expect: { action: 'CANCEL', target: '' } },
  { input: 'नहीं मत करो', expect: { action: 'CANCEL', target: '' } },

  // Positional + Area
  { input: 'the first link in the menu', expect: { action: 'CLICK', target: '', ordinal: 1, area: 'nav', roleHint: 'link', positionHint: 'first' } },
  { input: 'the last button', expect: { action: 'CLICK', target: '', roleHint: 'button', positionHint: 'last' } },
  { input: 'top right link', expect: { action: 'CLICK', target: '', roleHint: 'link', positionHint: 'top_right' } },
  { input: 'open home in the footer', expect: { action: 'CLICK', target: 'home', area: 'footer' } }
];

assert.ok(CASES.length >= 60, `Expected >= 60 test cases, found ${CASES.length}`);

let passed = 0;
let failed = 0;
for (const tc of CASES) {
  try {
    const res = parser.parse(tc.input, tc.context || {});
    for (const [k, v] of Object.entries(tc.expect)) {
      assert.strictEqual(res[k], v, `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(res[k])} (full=${JSON.stringify(res)})`);
    }
    passed += 1;
    console.log(`PASS  "${tc.input}" -> ${res.action}${res.target ? `("${res.target}")` : ''}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  "${tc.input}": ${err.message}`);
  }
}

console.log(`\nL3 Intent Parse Pass Rate: ${passed}/${CASES.length} (${((passed / CASES.length) * 100).toFixed(1)}%) — 0 LLM calls`);
if (failed > 0) process.exit(1);
