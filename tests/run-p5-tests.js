/**
 * Phase 5 Automated Test Suite (Dictation, Guided Form Fill, Local Profile, Safety, Validation & Undo)
 * Run with: node tests/run-p5-tests.js
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

function createFormsMockDom() {
  const eventsLog = [];
  const focusLog = [];
  const storageData = { sleepwalker_profile_optin: false, sleepwalker_local_profile: {} };

  class MockControl {
    constructor(tag, attrs = {}, children = []) {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.attributes = { ...attrs };
      this.id = attrs.id || '';
      this.name = attrs.name || '';
      this.value = attrs.value || '';
      this.checked = Boolean(attrs.checked);
      this.required = Boolean(attrs.required);
      this.disabled = false;
      this.readOnly = false;
      this.hidden = false;
      this.selectedIndex = 0;
      this._text = attrs.text || '';
      this.children = [];
      this.childNodes = [];
      this.parentElement = null;
      this.options = [];
      this._customInvalid = null;
      children.forEach((c) => this.appendChild(c));
    }
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
    }
    appendChild(child) {
      child.parentElement = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) {
        this.children.push(child);
        if (child.tagName === 'OPTION') this.options.push(child);
      }
      return child;
    }
    closest(sel) {
      let cur = this;
      const idTarget = sel.startsWith('#') ? sel.slice(1) : null;
      const tagTarget = !idTarget ? sel.toUpperCase() : null;
      while (cur) {
        if (idTarget && cur.id === idTarget) return cur;
        if (tagTarget && cur.tagName === tagTarget) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
      const target = sel.trim().toLowerCase();
      return this.children.filter((c) => c.tagName.toLowerCase() === target || (target.startsWith('.') && String(c.attributes.class || '').includes(target.slice(1))));
    }
    get textContent() {
      return this._text || this.childNodes.map((c) => c.textContent).join(' ');
    }
    get innerText() { return this.textContent; }
    getBoundingClientRect() { return { top: 10, left: 10, width: 180, height: 34 }; }
    scrollIntoView() {}
    focus() {
      focusLog.push(this.id || this.name);
      doc.activeElement = this;
    }
    checkValidity() {
      if (typeof this._customInvalid === 'function') {
        const msg = this._customInvalid(this.value);
        this.validationMessage = msg || '';
        return !msg;
      }
      this.validationMessage = '';
      return true;
    }
    dispatchEvent(ev) {
      eventsLog.push({ id: this.id || this.name, type: ev.type, bubbles: ev.bubbles, value: this.value, checked: this.checked });
      return true;
    }
  }

  const form = new MockControl('form', { id: 'reg-form' });
  let formSubmitted = false;
  form.submit = () => { formSubmitted = true; };

  const lblName = new MockControl('label', { for: 'f-name', text: 'Full Name' });
  const inpName = new MockControl('input', { id: 'f-name', type: 'text', required: true });

  const lblEmail = new MockControl('label', { for: 'f-email', text: 'Email' });
  const inpEmail = new MockControl('input', { id: 'f-email', type: 'email', required: true });

  const lblPhone = new MockControl('label', { for: 'f-phone', text: 'Phone Number' });
  const inpPhone = new MockControl('input', { id: 'f-phone', type: 'tel' });
  inpPhone._customInvalid = (v) => (v && v.length < 10 ? 'Please enter at least 10 digits.' : '');

  const lblDob = new MockControl('label', { for: 'f-dob', text: 'Date of Birth' });
  const inpDob = new MockControl('input', { id: 'f-dob', type: 'date' });

  const lblState = new MockControl('label', { for: 'f-state', text: 'State' });
  const optEmpty = new MockControl('option', { value: '', text: '-- Select --' });
  const optDelhi = new MockControl('option', { value: 'DL', text: 'Delhi' });
  const optMaha = new MockControl('option', { value: 'MH', text: 'Maharashtra' });
  const selState = new MockControl('select', { id: 'f-state' }, [optEmpty, optDelhi, optMaha]);

  const lblR1 = new MockControl('label', { for: 'r-ug', text: 'Undergraduate' });
  const radUg = new MockControl('input', { id: 'r-ug', type: 'radio', name: 'level', value: 'ug', 'aria-label': 'Scholarship Level' });
  const lblR2 = new MockControl('label', { for: 'r-pg', text: 'Postgraduate' });
  const radPg = new MockControl('input', { id: 'r-pg', type: 'radio', name: 'level', value: 'pg', 'aria-label': 'Scholarship Level' });

  const lblAgree = new MockControl('label', { for: 'f-agree', text: 'I confirm details are accurate' });
  const chkAgree = new MockControl('input', { id: 'f-agree', type: 'checkbox' });

  // Sensitive controls that MUST NEVER be touched or stored
  const inpPass = new MockControl('input', { id: 'f-pass', type: 'password', placeholder: 'Password' });
  const inpOtp = new MockControl('input', { id: 'f-otp', type: 'text', placeholder: 'Enter OTP' });
  const inpAadhaar = new MockControl('input', { id: 'f-aadhaar', type: 'text', 'aria-label': 'Aadhaar Number' });
  const inpPan = new MockControl('input', { id: 'f-pan', type: 'text', placeholder: 'PAN Card Number' });
  const inpCvv = new MockControl('input', { id: 'f-cvv', type: 'text', autocomplete: 'cc-csc', placeholder: 'CVV' });
  const inpUpi = new MockControl('input', { id: 'f-upi', type: 'text', placeholder: 'UPI PIN' });
  const inpCaptcha = new MockControl('input', { id: 'f-captcha', type: 'text', placeholder: 'Enter CAPTCHA' });

  const btnSubmit = new MockControl('button', { id: 'btn-submit', type: 'submit', text: 'Submit Form' });
  btnSubmit.click = () => { formSubmitted = true; };

  [
    lblName, inpName, lblEmail, inpEmail, lblPhone, inpPhone, lblDob, inpDob,
    lblState, selState, lblR1, radUg, lblR2, radPg, lblAgree, chkAgree,
    inpPass, inpOtp, inpAadhaar, inpPan, inpCvv, inpUpi, inpCaptcha, btnSubmit
  ].forEach((c) => form.appendChild(c));

  const body = new MockControl('body', {}, [form]);
  const doc = {
    body,
    activeElement: null,
    addEventListener: () => {},
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
    querySelectorAll(sel) {
      const parts = sel.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const all = this._all();
      return all.filter((el) => parts.some((p) => {
        if (p === 'label[for]') return el.tagName === 'LABEL' && el.getAttribute('for') !== null;
        return el.tagName.toLowerCase() === p;
      }));
    }
  };

  global.document = doc;
  global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  global.chrome = {
    storage: {
      local: {
        get: (_keys, cb) => cb({ ...storageData }),
        set: (obj, cb) => {
          Object.assign(storageData, obj);
          if (cb) cb();
        }
      }
    }
  };

  return {
    doc,
    eventsLog,
    focusLog,
    storageData,
    isFormSubmitted: () => formSubmitted,
    controls: {
      inpName, inpEmail, inpPhone, inpDob, selState, radUg, radPg, chkAgree,
      inpPass, inpOtp, inpAadhaar, inpPan, inpCvv, inpUpi, inpCaptcha
    }
  };
}

async function main() {
  console.log('=== Sleepwalker Phase 5 Test Suite ===\n');

  // Suite 1: Syntax & manifest loading order
  await runSuite('JS Syntax & Manifest Registration Order (forms.js before content.js)', () => {
    for (const f of ['forms.js', 'content.js', 'options.js', 'background.js']) {
      execSync(`node --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' });
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const scripts = manifest.content_scripts[0].js;
    const formsIdx = scripts.indexOf('forms.js');
    const contentIdx = scripts.indexOf('content.js');
    assert.ok(formsIdx !== -1 && contentIdx !== -1 && formsIdx < contentIdx, 'forms.js must precede content.js in manifest.json');
  });

  // Suite 2: Dictation cleaning, spoken punctuation/emails/numbers/dates, Hindi transliteration & edit ops
  await runSuite('Wispr-Style Dictation Cleaner, Emails, Spoken Numbers/Dates, Transliteration & Edit Ops', () => {
    const env = createFormsMockDom();
    const {
      SleepwalkerForms,
      transliterateDevanagariToLatin,
      parseSpokenNumbers,
      parseSpokenDate,
      parseSpokenEmail
    } = loadModule('forms.js');

    assert.strictEqual(parseSpokenEmail('Vatsal dot Kumar at the rate gmail dot com'), 'vatsal.kumar@gmail.com');
    assert.strictEqual(parseSpokenNumbers('nine eight seven six five'), '98765');
    assert.strictEqual(parseSpokenNumbers('ek sau pachees', { strictNumericMode: true }), '125');
    assert.strictEqual(parseSpokenNumbers('९८७६५', { strictNumericMode: true }), '98765');
    assert.strictEqual(parseSpokenDate('15 August 2004', 'date'), '2004-08-15');
    assert.strictEqual(parseSpokenDate('15 agast 2004', 'text'), '15/08/2004');

    const latinName = transliterateDevanagariToLatin('वत्सल कुमार');
    assert.ok(/vatsal/i.test(latinName) && /kumar/i.test(latinName), `Expected approximate Latin name, got "${latinName}"`);

    const replies = [];
    const forms = new SleepwalkerForms({
      setAssistantReply: (m) => replies.push(m),
      pill: { setStatus: () => {}, setIdle: () => {}, openBubble: () => {} },
      reader: { readText: () => {} }
    });

    // Filler removal, punctuation, capitalization & Title Case for Name
    forms.handleDictateIntent({ field: 'Full Name', value: 'uh basically vatsal kumar' });
    assert.strictEqual(env.controls.inpName.value, 'Vatsal Kumar');

    // Approximate Hindi transliteration into English-only / toggled field with explicit notice
    forms.transliterateHindiToEnglish = true;
    const tRes = forms.handleDictateIntent({ field: 'Full Name', value: 'वत्सल कुमार' });
    assert.strictEqual(tRes.transliterated, true);
    assert.ok(replies[replies.length - 1].toLowerCase().includes('approximate'));

    // Email parsing
    forms.handleDictateIntent({ field: 'Email', value: 'vatsal underscore dev at the rate outlook dot com' });
    assert.strictEqual(env.controls.inpEmail.value, 'vatsal_dev@outlook.com');

    // Date parsing
    forms.handleDictateIntent({ field: 'Date of Birth', value: '15 August 2004' });
    assert.strictEqual(env.controls.inpDob.value, '2004-08-15');

    // Edit ops: new line, delete that, clear field, undo
    forms.handleDictateIntent({ field: 'Full Name', value: 'Vatsal Kumar Delhi' });
    forms.handleDictateIntent({ field: 'Full Name', specialOp: 'delete_last' });
    assert.strictEqual(env.controls.inpName.value, 'Vatsal Kumar');
    forms.handleDictateIntent({ field: 'Full Name', specialOp: 'clear' });
    assert.strictEqual(env.controls.inpName.value, '');
    forms.undoLast();
    assert.strictEqual(env.controls.inpName.value, 'Vatsal Kumar');
  });

  // Suite 3: Safety Guard for Sensitive Fields (never dictated, never stored, focused + "I'll leave this one for you.")
  await runSuite('Safety Guard: Sensitive Fields Refuse Dictation/Autofill & Focus Field ("I\'ll leave this one for you.")', () => {
    const env = createFormsMockDom();
    const { SleepwalkerForms, sanitizeProfileData } = loadModule('forms.js');

    const replies = [];
    const forms = new SleepwalkerForms({
      setAssistantReply: (m) => replies.push(m),
      pill: { setStatus: () => {}, setIdle: () => {}, openBubble: () => {} },
      reader: { readText: () => {} }
    });

    const sensitiveHints = ['Password', 'OTP', 'Aadhaar', 'PAN Card Number', 'CVV', 'UPI PIN', 'CAPTCHA'];
    const sensitiveCtrls = [
      env.controls.inpPass, env.controls.inpOtp, env.controls.inpAadhaar,
      env.controls.inpPan, env.controls.inpCvv, env.controls.inpUpi, env.controls.inpCaptcha
    ];

    sensitiveHints.forEach((hint, idx) => {
      const res = forms.handleDictateIntent({ field: hint, value: 'SECRET_1234' });
      assert.strictEqual(res.status, 'sensitive_skipped', `Sensitive field "${hint}" must be refused`);
      assert.strictEqual(sensitiveCtrls[idx].value, '', `Sensitive field "${hint}" must NEVER receive dictated value`);
    });
    assert.ok(replies.every((r) => r === "I'll leave this one for you."));
    assert.ok(env.focusLog.includes('f-pass') && env.focusLog.includes('f-otp') && env.focusLog.includes('f-captcha'));

    // Profile sanitizer rejects any sensitive fields
    const sanitized = sanitizeProfileData({
      fullName: 'Vatsal Kumar',
      email: 'v@example.com',
      password: 'BAD',
      otp: '9999',
      aadhaar: '1234',
      pan: 'ABCDE1234F',
      cvv: '123'
    });
    assert.deepStrictEqual(Object.keys(sanitized), ['fullName', 'email']);
    assert.strictEqual(env.isFormSubmitted(), false);
  });

  // Suite 4: Control Events (input/change/blur), Select/Radio/Checkbox, Validation Errors & Undo
  await runSuite('React/Angular Events, Select/Radio/Checkbox Controls, Validation Readout & Undo', () => {
    const env = createFormsMockDom();
    const { SleepwalkerForms } = loadModule('forms.js');
    const SleepwalkerConfirm = loadModule('confirm.js');

    const replies = [];
    const forms = new SleepwalkerForms({
      confirm: new SleepwalkerConfirm(),
      setAssistantReply: (m) => replies.push(m),
      pill: { setStatus: () => {}, setIdle: () => {}, openBubble: () => {} },
      reader: { readText: () => {} }
    });

    const fields = forms.detectFormFields();
    const stateField = fields.find((f) => f.label === 'State');
    const levelField = fields.find((f) => f.type === 'radio');
    const agreeField = fields.find((f) => f.type === 'checkbox');

    assert.ok(stateField && levelField && agreeField, 'Must detect select, grouped radio, and checkbox');
    assert.strictEqual(stateField.options.length, 2);
    assert.strictEqual(levelField.options.length, 2);

    forms.setControlValueSafe(stateField, 'Maharashtra');
    assert.strictEqual(env.controls.selState.value, 'MH');

    forms.setControlValueSafe(levelField, 'Postgraduate');
    assert.strictEqual(env.controls.radPg.checked, true);
    assert.strictEqual(env.controls.radUg.checked, false);

    forms.setControlValueSafe(agreeField, 'yes');
    assert.strictEqual(env.controls.chkAgree.checked, true);

    // Events emitted check
    const stateEvs = env.eventsLog.filter((e) => e.id === 'f-state').map((e) => e.type);
    assert.ok(stateEvs.includes('input') && stateEvs.includes('change') && stateEvs.includes('blur'));

    // Validation error check aloud
    forms.handleDictateIntent({ field: 'Phone Number', value: 'one two three' });
    assert.ok(replies[replies.length - 1].includes('at least 10 digits'), 'Validation error must be reported');

    // Undo restores checkbox
    forms.undoLast(); // undoes phone
    forms.undoLast(); // undoes agree
    assert.strictEqual(env.controls.chkAgree.checked, false);
  });

  // Suite 5: FILL_GUIDED (one field at a time, read back + confirm/change, skip sensitive, validation error hold, never submit)
  await runSuite('FILL_GUIDED Step-by-Step Read-Back, Validation Error Hold & Sensitive Skip', () => {
    const env = createFormsMockDom();
    const { SleepwalkerForms } = loadModule('forms.js');
    const SleepwalkerConfirm = loadModule('confirm.js');

    const replies = [];
    const confirm = new SleepwalkerConfirm();
    const forms = new SleepwalkerForms({
      confirm,
      setAssistantReply: (m) => replies.push(m),
      pill: { setStatus: () => {}, setIdle: () => {}, openBubble: () => {} },
      reader: { readText: () => {} }
    });

    const startRes = forms.startGuidedFill();
    assert.strictEqual(startRes.ok, true);
    assert.ok(replies[replies.length - 1].includes('Field 1'));

    // Enter value for field 1 (Full Name) -> read-back prompt awaits Yes/Change
    forms.handleGuidedInput('vatsal kumar');
    assert.strictEqual(confirm.isAwaiting(), true);
    assert.ok(confirm.pending.message.includes('Vatsal Kumar'));
    assert.strictEqual(env.controls.inpName.value, '', 'Value must wait for Yes confirmation');

    // Say No -> lets user change before advancing
    confirm.handleResponse('no');
    assert.strictEqual(env.controls.inpName.value, '');
    assert.strictEqual(forms.guidedState.index, 0, 'Cancel/change must stay on field 1');

    // Enter corrected name & say Yes -> fills & advances to field 2 (Email)
    forms.handleGuidedInput('Vatsal Verma');
    confirm.handleResponse('haan');
    assert.strictEqual(env.controls.inpName.value, 'Vatsal Verma');
    assert.strictEqual(forms.guidedState.index, 1);

    // Phone field validation failure keeps user on Phone until valid
    forms.handleGuidedInput('Skip'); // skips Email -> now on Phone (index 2)
    assert.strictEqual(forms.guidedState.index, 2);
    forms.handleGuidedInput('999');
    confirm.handleResponse('yes');
    assert.strictEqual(forms.guidedState.index, 2, 'Validation error must prevent advancing until corrected or skipped');
    assert.ok(replies[replies.length - 1].includes('Validation error'));

    forms.stopGuidedFill('cancelled');
    assert.strictEqual(env.isFormSubmitted(), false, 'Guided fill must NEVER auto-submit');
  });

  // Suite 6: Opt-in FILL_PROFILE (disabled by default, confirm summary before fill, batch undo, never submits)
  await runSuite('Opt-In Local Profile (Disabled Default, Confirm Summary, Non-Sensitive Only, Batch Undo, No Auto-Submit)', async () => {
    const env = createFormsMockDom();
    const { SleepwalkerForms } = loadModule('forms.js');
    const SleepwalkerConfirm = loadModule('confirm.js');

    const confirm = new SleepwalkerConfirm();
    const forms = new SleepwalkerForms({
      confirm,
      setAssistantReply: () => {},
      pill: { setStatus: () => {}, setIdle: () => {}, openBubble: () => {} },
      reader: { readText: () => {} }
    });

    // Disabled initially
    const disabledRes = await forms.fillFromProfile();
    assert.strictEqual(disabledRes.ok, false);
    assert.strictEqual(disabledRes.reason, 'opt_in_disabled');

    // Enable opt-in & save profile (attempting sneaky password key gets stripped)
    await forms.saveProfile({
      optIn: true,
      profile: {
        fullName: 'Asha Devi',
        email: 'asha@example.com',
        phone: '9876543210',
        password: 'MUST_NEVER_BE_SAVED'
      }
    });
    assert.strictEqual(env.storageData.sleepwalker_local_profile.password, undefined);

    // Fill from profile -> must show summary confirm card FIRST
    await forms.fillFromProfile();
    assert.strictEqual(confirm.isAwaiting(), true);
    assert.ok(confirm.pending.summary.some((line) => line.includes('Asha Devi')));
    assert.strictEqual(env.controls.inpName.value, '', 'Must NOT fill before summary confirm');

    // Confirm -> fills matched non-sensitive fields only
    confirm.handleResponse('yes');
    assert.strictEqual(env.controls.inpName.value, 'Asha Devi');
    assert.strictEqual(env.controls.inpEmail.value, 'asha@example.com');
    assert.strictEqual(env.controls.inpPhone.value, '9876543210');
    assert.strictEqual(env.controls.inpPass.value, '');
    assert.strictEqual(env.isFormSubmitted(), false);

    // Batch Undo reverts all 3 profile fields at once
    forms.undoLast();
    assert.strictEqual(env.controls.inpName.value, '');
    assert.strictEqual(env.controls.inpEmail.value, '');
    assert.strictEqual(env.controls.inpPhone.value, '');
  });

  console.log(`\nSummary: ${passedSuites}/${passedSuites + failedSuites} P5 test suites passed.`);
  if (failedSuites > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
