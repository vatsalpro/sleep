"""
Phase C2 E2E Test: Complete Voice Form-Filling Engine (form-index.js, form-fill.js, forms.js)
Tests real extension JS inside headless Chromium via Playwright:
- Form indexing (text, textarea, number, email, tel, date, select, click-to-open combobox,
  type-to-filter combobox, radio group + fieldset legend, checkbox group, custom hidden checkbox,
  role=switch, contenteditable, aria-labelledby, hidden/disabled skipped)
- Parsing (spoken dates w/ words & Hindi months & kal/aaj, digit-by-digit phone readback,
  spelled emails, EN/HI spoken numbers, Title Case names, Hindi->Latin approximate flag)
- Free Mode ("select Karnataka in state", phonetic "कर्नाटक", "set gender to female",
  "tick blue and black", "turn on notifications", "write my city as Mysuru", "clear that", "undo")
- Honest DOM verification when site rejects an update
- Guided Mode (progress "X of Y done", 6-option paging + "say more", phonetic long-list match,
  validation errors, sensitive wait/verify-without-reading, manual takeover, long dictation)
- Multi-step chrome.storage.session resume + critical double-confirm Submit with summary card
"""

import http.server
import json
import pathlib
import socketserver
import threading
from playwright.sync_api import sync_playwright

ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def log_message(self, format, *args):
        pass


def start_server():
    server = socketserver.TCPServer(("127.0.0.1", 0), QuietHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


STATES_20 = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
    "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
    "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra",
    "Odisha", "Punjab", "Rajasthan", "Tamil Nadu", "Uttar Pradesh"
]


def run_c2_tests():
    server, port = start_server()
    base_url = f"http://127.0.0.1:{port}"
    css_text = (ROOT_DIR / "widget.css").read_text(encoding="utf-8")
    lexicon_json = json.loads((ROOT_DIR / "lexicon.json").read_text(encoding="utf-8"))
    link_lexicon_json = json.loads((ROOT_DIR / "link-lexicon.json").read_text(encoding="utf-8"))

    states_opts = "\n".join(f'<option value="{s[:2].upper()}_{i}">{s}</option>' for i, s in enumerate(STATES_20))

    test_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>C2 Comprehensive Voice Form Test</title>
  <style>
    .sr-only-input {{ display: none; }}
    .hidden-section {{ display: none; }}
  </style>
</head>
<body>
  <main>
    <h1>Scholarship Application Form</h1>
    <form id="main-form">
      <div>
        <label for="f-name">Full Name</label>
        <input id="f-name" name="fullName" type="text" required />
      </div>

      <div>
        <span id="lbl-email-prefix">Contact</span>
        <span id="lbl-email-main">Email Address</span>
        <input id="f-email" name="email" type="email" aria-labelledby="lbl-email-prefix lbl-email-main" aria-describedby="f-email-err" required />
        <div id="f-email-err" class="error"></div>
      </div>

      <div>
        <label for="f-phone">Phone Number</label>
        <input id="f-phone" name="phone" type="tel" />
      </div>

      <div>
        <label for="f-age">Age</label>
        <input id="f-age" name="age" type="number" />
      </div>

      <div>
        <label for="f-dob">Date of Birth</label>
        <input id="f-dob" name="dob" type="date" />
      </div>

      <div>
        <label for="f-city">City</label>
        <input id="f-city" name="city" type="text" />
      </div>

      <div>
        <label for="f-state">State</label>
        <select id="f-state" name="state" required>
          <option value="">-- Choose State --</option>
          {states_opts}
        </select>
      </div>

      <!-- Custom click-to-open combobox -->
      <div>
        <span id="lbl-dept">Department</span>
        <button type="button" id="combo-dept" role="combobox" aria-labelledby="lbl-dept" aria-expanded="false" aria-controls="lb-dept">Select Department</button>
        <ul id="lb-dept" role="listbox" style="display:none;">
          <li role="option" data-value="eng">Engineering</li>
          <li role="option" data-value="fin">Finance</li>
          <li role="option" data-value="ops">Operations</li>
        </ul>
      </div>

      <!-- Custom type-to-filter combobox -->
      <div>
        <label for="combo-fw">Framework</label>
        <input id="combo-fw" type="text" role="combobox" aria-expanded="false" aria-controls="lb-fw" autocomplete="off" />
        <ul id="lb-fw" role="listbox" style="display:none;">
          <li role="option" data-value="react">React JS</li>
          <li role="option" data-value="vue">Vue JS</li>
          <li role="option" data-value="svelte">Svelte</li>
        </ul>
      </div>

      <fieldset>
        <legend>Gender</legend>
        <label><input type="radio" name="gender" value="male" /> Male</label>
        <label><input type="radio" name="gender" value="female" /> Female</label>
        <label><input type="radio" name="gender" value="other" /> Other</label>
      </fieldset>

      <fieldset>
        <legend>Favorite Colors</legend>
        <label><input type="checkbox" name="colors" value="red" /> Red</label>
        <label><input type="checkbox" name="colors" value="blue" /> Blue</label>
        <label><input type="checkbox" name="colors" value="black" /> Black</label>
      </fieldset>

      <!-- Custom checkbox with hidden real input + visible label -->
      <div>
        <input id="f-hidden-custom-cb" type="checkbox" class="sr-only-input" />
        <label for="f-hidden-custom-cb">Accept Terms</label>
      </div>

      <!-- ARIA Switch -->
      <div>
        <span id="lbl-notif">Email Notifications</span>
        <button type="button" id="sw-notif" role="switch" aria-labelledby="lbl-notif" aria-checked="false">Off</button>
      </div>

      <!-- Rich Text ContentEditable + Textarea -->
      <div>
        <label for="f-notes">Notes</label>
        <textarea id="f-notes" name="notes"></textarea>
      </div>

      <div>
        <span id="lbl-bio">Bio Statement</span>
        <div id="f-bio" contenteditable="true" aria-labelledby="lbl-bio"></div>
      </div>

      <!-- Stubborn control to test honest verification failure -->
      <div>
        <label for="f-stubborn">Verified Code</label>
        <input id="f-stubborn" name="stubborn" type="text" />
      </div>

      <!-- Sensitive field: never read/logged/filled -->
      <div>
        <label for="f-otp">OTP Code</label>
        <input id="f-otp" name="otp" type="text" />
      </div>

      <!-- Hidden and disabled fields MUST be skipped -->
      <div class="hidden-section">
        <label for="f-secret-hidden">Hidden Field</label>
        <input id="f-secret-hidden" type="text" />
      </div>
      <div>
        <label for="f-disabled">Locked Field</label>
        <input id="f-disabled" type="text" disabled />
      </div>

      <button type="button" id="btn-next-step">Save &amp; Continue</button>
      <button type="submit" id="btn-submit">Submit Form</button>
    </form>
  </main>

  <script>
    window.__C2_STATE__ = {{ submittedCount: 0, nextClicks: 0 }};

    document.getElementById('main-form').addEventListener('submit', (e) => {{
      e.preventDefault();
      window.__C2_STATE__.submittedCount += 1;
    }});
    document.getElementById('btn-submit').addEventListener('click', (e) => {{
      e.preventDefault();
      window.__C2_STATE__.submittedCount += 1;
    }});
    document.getElementById('btn-next-step').addEventListener('click', () => {{
      window.__C2_STATE__.nextClicks += 1;
    }});

    // Email custom validation message
    const emailEl = document.getElementById('f-email');
    const emailErr = document.getElementById('f-email-err');
    emailEl.addEventListener('input', () => {{
      if (emailEl.value && !emailEl.value.includes('@')) {{
        emailEl.setAttribute('aria-invalid', 'true');
        emailErr.textContent = 'Enter a valid email containing @.';
      }} else {{
        emailEl.removeAttribute('aria-invalid');
        emailErr.textContent = '';
      }}
    }});

    // Click-to-open combobox behavior
    const comboDept = document.getElementById('combo-dept');
    const lbDept = document.getElementById('lb-dept');
    comboDept.addEventListener('click', () => {{
      const open = lbDept.style.display !== 'none';
      lbDept.style.display = open ? 'none' : 'block';
      comboDept.setAttribute('aria-expanded', open ? 'false' : 'true');
    }});
    lbDept.querySelectorAll('[role="option"]').forEach((opt) => {{
      opt.addEventListener('click', () => {{
        comboDept.textContent = opt.textContent;
        lbDept.style.display = 'none';
        comboDept.setAttribute('aria-expanded', 'false');
      }});
    }});

    // Type-to-filter combobox behavior
    const comboFw = document.getElementById('combo-fw');
    const lbFw = document.getElementById('lb-fw');
    const allFwOpts = Array.from(lbFw.querySelectorAll('[role="option"]'));
    comboFw.addEventListener('click', () => {{ lbFw.style.display = 'block'; }});
    comboFw.addEventListener('input', () => {{
      lbFw.style.display = 'block';
      const q = comboFw.value.toLowerCase();
      allFwOpts.forEach((o) => {{
        o.style.display = !q || o.textContent.toLowerCase().includes(q) ? 'block' : 'none';
      }});
    }});
    allFwOpts.forEach((o) => {{
      o.addEventListener('click', () => {{
        comboFw.value = o.textContent;
        o.setAttribute('aria-selected', 'true');
        lbFw.style.display = 'none';
      }});
    }});

    // ARIA switch
    const swNotif = document.getElementById('sw-notif');
    swNotif.addEventListener('click', () => {{
      const cur = swNotif.getAttribute('aria-checked') === 'true';
      swNotif.setAttribute('aria-checked', cur ? 'false' : 'true');
      swNotif.textContent = cur ? 'Off' : 'On';
    }});

    // Stubborn field rejects 'Reject me' back to 'LOCKED_ORIG'
    const stubborn = document.getElementById('f-stubborn');
    stubborn.value = 'LOCKED_ORIG';
    stubborn.addEventListener('change', () => {{
      if (stubborn.value && stubborn.value.toLowerCase().includes('reject')) {{
        stubborn.value = 'LOCKED_ORIG';
      }}
    }});
  </script>
</body>
</html>"""

    init_shim = """
    (() => {
      const localStore = {};
      const sessionStore = {};
      window.__SESSION_STORE__ = sessionStore;
      window.chrome = {
        runtime: {
          getURL: (p) => location.origin + '/' + p.replace(/^\\//, ''),
          getManifest: () => ({ version: '1.0.0' }),
          sendMessage: (msg, cb) => {
            if (msg && msg.type === 'SLEEPWALKER_SESSION_STATE_SET') {
              sessionStore.sleepwalker_session_task = msg.state;
              if (cb) cb({ ok: true });
              return;
            }
            if (msg && msg.type === 'SLEEPWALKER_SESSION_STATE_GET') {
              if (cb) cb({ state: sessionStore.sleepwalker_session_task || null });
              return;
            }
            if (msg && msg.type === 'SLEEPWALKER_SESSION_STATE_CLEAR') {
              delete sessionStore.sleepwalker_session_task;
              if (cb) cb({ ok: true });
              return;
            }
            if (typeof cb === 'function') cb({ status: 'ok' });
          },
          onMessage: { addListener: () => {} }
        },
        storage: {
          local: {
            get: (keys, cb) => cb({ ...localStore }),
            set: (obj, cb) => { Object.assign(localStore, obj || {}); if (cb) cb(); }
          },
          session: {
            get: (keys, cb) => cb({ ...sessionStore }),
            set: (obj, cb) => { Object.assign(sessionStore, obj || {}); if (cb) cb(); }
          }
        }
      };

      window.__SPOKEN__ = [];
      const synthMock = {
        speaking: false, paused: false, pending: false, onvoiceschanged: null,
        getVoices: () => [{ name: 'Mock EN', lang: 'en-IN', default: true }],
        speak: (utt) => {
          window.__SPOKEN__.push(utt.text);
          synthMock.speaking = true;
          setTimeout(() => { synthMock.speaking = false; if (utt.onend) utt.onend(); }, 5);
        },
        cancel: () => { synthMock.speaking = false; },
        pause: () => {}, resume: () => {}
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synthMock, configurable: true });
      window.SpeechSynthesisUtterance = function (text) {
        this.text = text || '';
        this.rate = 1; this.lang = 'en-IN';
      };
    })();
    """

    scripts = [
        "reader.js", "outline.js", "voice.js", "pill.js", "glow.js",
        "digest.js", "explain.js", "confirm.js", "link-index.js", "match.js",
        "link-intent.js", "intent.js", "navigate.js",
        "form-index.js", "form-fill.js", "forms.js",
        "upload.js", "dialogue.js", "widget.js"
    ]

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.add_init_script(init_shim)
            page.route("**/test-c2.html", lambda r: r.fulfill(status=200, content_type="text/html", body=test_html))
            page.goto(f"{base_url}/test-c2.html", wait_until="domcontentloaded")

            for s in scripts:
                page.add_script_tag(url=f"{base_url}/{s}")

            page.evaluate("""([css, lex, llex]) => {
              const w = new window.SleepwalkerWidget();
              window.__SW_WIDGET__ = w;
              w.init().then(() => {
                const st = document.createElement('style');
                st.textContent = css;
                w.shadowRoot.prepend(st);
                w.intentEngine.lexicon = lex;
                w.intentEngine.linkLexicon = llex;
              });
            }""", [css_text, lexicon_json, link_lexicon_json])
            page.wait_for_function("() => window.__SW_WIDGET__ && window.__SW_WIDGET__.forms && window.__SW_WIDGET__.dialogue && window.__SW_WIDGET__.intentEngine.lexicon && typeof window.__SW_FORMS__ === 'function'")

            # -----------------------------------------------------------------
            # T1: Form Indexing + Group/Label/Hidden/Disabled/Debug Helper
            # -----------------------------------------------------------------
            idx = page.evaluate("""() => {
              const fields = window.__SW_WIDGET__.forms.detectFormFields();
              const dbg = window.__SW_FORMS__();
              return { fields: fields.map(f => ({ id: f.id, type: f.type, label: f.label, group: f.group, req: f.required, sens: f.sensitive, hiddenInput: Boolean(f.hiddenInput), opts: (f.options||[]).length })), dbg };
            }""")
            types = [f["type"] for f in idx["fields"]]
            labels = [f["label"] for f in idx["fields"]]
            assert "text" in types and "email" in types and "tel" in types and "number" in types and "date" in types
            assert "select" in types and "combobox" in types and "radio" in types and "checkbox_group" in types
            assert "checkbox" in types and "switch" in types and "textarea" in types and "contenteditable" in types
            assert "Hidden Field" not in labels and "Locked Field" not in labels, f"Skipped controls leaked: {labels}"
            assert any(f["label"] == "Accept Terms" and f["hiddenInput"] for f in idx["fields"]), "Hidden custom checkbox not indexed with hiddenInput=true"
            assert any(f["label"] == "Contact Email Address" for f in idx["fields"]), f"aria-labelledby multi-ID failed: {labels}"
            assert any(f["label"] == "OTP Code" and f["sens"] for f in idx["fields"]), "Sensitive OTP not flagged"
            otp_dbg = [d for d in idx["dbg"] if d["label"] == "OTP Code"][0]
            assert otp_dbg["state"] == "[protected]", f"Debug table leaked OTP state: {otp_dbg}"

            # -----------------------------------------------------------------
            # T2: Spoken Date, Email, Numbers, Phone Readback, Hindi->Latin
            # -----------------------------------------------------------------
            parsed = page.evaluate("""() => {
              const ff = window.SleepwalkerFormFill;
              const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
              const tomStr = (() => { const d = new Date(); d.setDate(d.getDate()+1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
              return {
                date1: ff.parseSpokenDate('fifteen August two thousand five', 'date'),
                dateHindi: ff.parseSpokenDate('15 अगस्त 2005', 'date'),
                dateAaj: ff.parseSpokenDate('aaj', 'date'),
                dateKal: ff.parseSpokenDate('kal', 'date'),
                todayStr, tomStr,
                email1: ff.parseSpokenEmail('a b c dot one at the rate gmail dot com'),
                email2: ff.parseSpokenEmail('vatsal_dev at the rate outlook dot com'),
                numDec: ff.parseSpokenNumbers('twenty five point five', { strictNumericMode: true }),
                numHi: ff.parseSpokenNumbers('pachees', { strictNumericMode: true }),
                phoneRead: ff.formatPhoneReadback('9876543210')
              };
            }""")
            assert parsed["date1"] == "2005-08-15", parsed
            assert parsed["dateHindi"] == "2005-08-15", parsed
            assert parsed["dateAaj"] == parsed["todayStr"], parsed
            assert parsed["dateKal"] == parsed["tomStr"], parsed
            assert parsed["email1"] == "abc.1@gmail.com", parsed
            assert parsed["numDec"] == "25.5" and parsed["numHi"] == "25", parsed
            assert parsed["phoneRead"] == "9 8 7 6 5 4 3 2 1 0", parsed

            # -----------------------------------------------------------------
            # T3: Free Mode Commands (Select, Phonetic Select, Radio, Multi-Checkbox, Hidden CB, Switch, Comboboxes, City, Clear, Undo, Verification)
            # -----------------------------------------------------------------
            page.evaluate("() => { window.__SW_WIDGET__.dialogue.startSession({ source: 'test' }); }")

            # Free select with exact & phonetic Devanagari Karnataka -> Karnataka
            page.evaluate("async () => { await window.__SW_SAY__('select Karnataka in state'); }")
            assert "Karnataka" in page.evaluate("() => document.getElementById('f-state').selectedOptions[0].textContent")

            page.evaluate("""async () => {
              document.getElementById('f-state').value = '';
              await window.__SW_SAY__('select कर्नाटक in state');
            }""")
            assert "Karnataka" in page.evaluate("() => document.getElementById('f-state').selectedOptions[0].textContent"), "Phonetic Devanagari State match failed"

            # Free radio, multi-checkbox ("tick blue and black"), custom hidden checkbox, switch, city, contenteditable
            page.evaluate("""async () => {
              await window.__SW_SAY__('set gender to female');
              await window.__SW_SAY__('tick blue and black');
              await window.__SW_SAY__('check accept terms');
              await window.__SW_SAY__('turn on email notifications');
              await window.__SW_SAY__('write my city as Mysuru');
              await window.__SW_SAY__('set bio statement to Hello world');
            }""")
            free_state = page.evaluate("""() => ({
              femaleChecked: document.querySelector('input[name="gender"][value="female"]').checked,
              red: document.querySelector('input[value="red"]').checked,
              blue: document.querySelector('input[value="blue"]').checked,
              black: document.querySelector('input[value="black"]').checked,
              hiddenCustomCb: document.getElementById('f-hidden-custom-cb').checked,
              swChecked: document.getElementById('sw-notif').getAttribute('aria-checked'),
              city: document.getElementById('f-city').value,
              bio: document.getElementById('f-bio').textContent
            })""")
            assert free_state["femaleChecked"] is True, free_state
            assert not free_state["red"] and free_state["blue"] and free_state["black"], f"tick blue and black failed: {free_state}"
            assert free_state["hiddenCustomCb"] is True, "Custom hidden checkbox label toggle failed"
            assert free_state["swChecked"] == "true", f"Switch toggle failed: {free_state}"
            assert free_state["city"] == "Mysuru" and free_state["bio"] == "Hello World" or free_state["bio"] == "Hello world", free_state

            # Custom click-to-open & type-to-filter comboboxes
            page.evaluate("async () => { await window.__SW_SAY__('select Finance in department'); }")
            assert page.evaluate("() => document.getElementById('combo-dept').textContent.trim()") == "Finance"

            page.evaluate("async () => { await window.__SW_SAY__('select React JS in framework'); }")
            assert page.evaluate("() => document.getElementById('combo-fw').value") == "React JS"

            # Clear that & Undo on City
            page.evaluate("async () => { await window.__SW_SAY__('write my city as Bengaluru'); await window.__SW_SAY__('clear that'); }")
            assert page.evaluate("() => document.getElementById('f-city').value") == ""
            page.evaluate("async () => { await window.__SW_SAY__('undo'); }")
            assert page.evaluate("() => document.getElementById('f-city').value") == "Bengaluru"

            # Honest verification failure when site reverts value
            page.evaluate("async () => { await window.__SW_SAY__('set verified code to reject me'); }")
            stubborn_reply = page.evaluate("() => window.__SW_WIDGET__.shadowRoot.getElementById('sw-assistant-text').textContent")
            assert "LOCKED_ORIG" in stubborn_reply or "pageshows" in stubborn_reply.lower() or "page shows" in stubborn_reply.lower(), f"Expected honest verification warning, got: {stubborn_reply}"

            # Long dictation until "that's all" WITHOUT ending dialogue session!
            page.evaluate("""async () => {
              await window.__SW_SAY__('dictate into notes');
              await window.__SW_SAY__('First sentence about experience.');
              await window.__SW_SAY__('Second sentence about awards.');
              await window.__SW_SAY__("that's all");
            }""")
            long_res = page.evaluate("() => ({ notes: document.getElementById('f-notes').value, active: window.__SW_WIDGET__.dialogue.isActive() })")
            assert "First sentence" in long_res["notes"] and "Second sentence" in long_res["notes"] and long_res["active"], f"Long dictation failed: {long_res}"

            # -----------------------------------------------------------------
            # T4: Guided Mode: Progress, 6-option Paging ("say more"), Digit Phone Readback, Validation Hold, Manual Takeover, Sensitive Verify-Without-Reading
            # -----------------------------------------------------------------
            page.evaluate("() => { window.__SPOKEN__ = []; }")
            page.evaluate("async () => { await window.__SW_SAY__('fill this form'); }")
            page.wait_for_timeout(50)
            g1 = page.evaluate("() => window.__SW_WIDGET__.dialogue.lastSpokenText + ' || ' + window.__SPOKEN__.join(' ')")
            assert "of" in g1 and "done" in g1 and "Full Name" in g1 and "required" in g1, f"Guided prompt 1 wrong: {g1}"

            # Fill Full Name with confirm
            page.evaluate("async () => { await window.__SW_SAY__('Asha Devi'); await window.__SW_SAY__('yes'); }")
            assert page.evaluate("() => document.getElementById('f-name').value") == "Asha Devi"

            # Email validation error hold -> fix
            page.evaluate("async () => { window.__SPOKEN__ = []; await window.__SW_SAY__('bad-email'); await window.__SW_SAY__('yes'); }")
            page.wait_for_timeout(50)
            err_msg = page.evaluate("() => ({ idx: window.__SW_WIDGET__.forms.guidedState.index, txt: window.__SW_WIDGET__.dialogue.lastSpokenText + ' || ' + window.__SPOKEN__.join(' ') })")
            assert err_msg["idx"] == 1 and "Validation error" in err_msg["txt"], f"Validation hold failed: {err_msg}"
            page.evaluate("async () => { await window.__SW_SAY__('a s h a at the rate example dot com'); await window.__SW_SAY__('yes'); }")
            assert page.evaluate("() => document.getElementById('f-email').value") == "asha@example.com"

            # Phone digit-by-digit confirmation readback!
            page.evaluate("""async () => {
              window.__SPOKEN__ = [];
              await window.__SW_SAY__('nine eight seven six five four three two one zero');
            }""")
            confirm_phone = page.evaluate("() => window.__SW_WIDGET__.confirm.pending.message")
            assert "9 8 7 6 5 4 3 2 1 0" in confirm_phone, f"Phone not read digit-by-digit: {confirm_phone}"
            page.evaluate("async () => { await window.__SW_SAY__('yes'); }")
            assert page.evaluate("() => document.getElementById('f-phone').value") == "9876543210"

            # Jump guided index to State (20 options) to test 6-option paging + "say more"!
            page.evaluate("""() => {
              window.__SPOKEN__ = [];
              const gs = window.__SW_WIDGET__.forms.guidedState;
              gs.index = gs.fields.findIndex(f => f.label === 'State');
              window.__SW_WIDGET__.forms._promptCurrentGuidedField();
            }""")
            page.wait_for_timeout(50)
            st_prompt1 = page.evaluate("() => window.__SW_WIDGET__.dialogue.lastSpokenText + ' || ' + window.__SPOKEN__.join(' ')")
            assert "1. Andhra Pradesh" in st_prompt1 and "6. Delhi" in st_prompt1 and "7. Goa" not in st_prompt1 and "more" in st_prompt1.lower(), f"6-option paging failed: {st_prompt1}"
            page.evaluate("async () => { window.__SPOKEN__ = []; await window.__SW_SAY__('more'); }")
            page.wait_for_timeout(50)
            st_prompt2 = page.evaluate("() => window.__SW_WIDGET__.dialogue.lastSpokenText + ' || ' + window.__SPOKEN__.join(' ')")
            assert "7. Goa" in st_prompt2 and "12. Karnataka" in st_prompt2, f"Say more paging failed: {st_prompt2}"

            # Manual takeover ("I'll do this one") on State -> waits -> "done" verifies & advances
            page.evaluate("async () => { await window.__SW_SAY__(\"I'll do this one\"); }")
            assert page.evaluate("() => window.__SW_WIDGET__.forms.manualTakeoverState.active") is True
            page.evaluate("""async () => {
              document.getElementById('f-state').value = 'MH_14';
              await window.__SW_SAY__('done');
            }""")
            assert page.evaluate("() => window.__SW_WIDGET__.forms.manualTakeoverState === null && window.__SW_WIDGET__.forms.guidedState.index > 6")

            # Sensitive field check: jump to OTP Code -> "Please enter this one yourself. Say done when finished." -> verify boolean only!
            page.evaluate("""() => {
              window.__SPOKEN__ = [];
              const gs = window.__SW_WIDGET__.forms.guidedState;
              gs.index = gs.fields.findIndex(f => f.label === 'OTP Code');
              window.__SW_WIDGET__.forms._promptCurrentGuidedField();
            }""")
            page.wait_for_timeout(50)
            otp_prompt = page.evaluate("() => window.__SW_WIDGET__.dialogue.lastSpokenText + ' || ' + window.__SPOKEN__.join(' ')")
            assert "Please enter this one yourself. Say done when finished" in otp_prompt, f"Sensitive prompt wrong: {otp_prompt}"
            # While empty, "done" refuses and stays
            page.evaluate("async () => { await window.__SW_SAY__('done'); }")
            assert page.evaluate("() => window.__SW_WIDGET__.forms.guidedState.awaitingSensitiveDone") is True
            # Fill manually -> say "done" -> advances WITHOUT ever leaking OTP digits anywhere!
            page.evaluate("""async () => {
              document.getElementById('f-otp').value = '994411';
              await window.__SW_SAY__('done');
            }""")
            otp_mem = page.evaluate("() => JSON.stringify(window.__SW_WIDGET__.dialogue.getMemory()) + window.__SPOKEN__.join(' ')")
            assert "994411" not in otp_mem, "CRITICAL LEAK: Sensitive OTP value appeared in dialogue memory or speech!"
            assert page.evaluate("() => !window.__SW_WIDGET__.forms.isGuidedActive() || window.__SW_WIDGET__.forms.guidedState.awaitingSensitiveDone === false")

            # -----------------------------------------------------------------
            # T5: Multi-step Save & Continue (chrome.storage.session) + Double-Confirm Submit Summary
            # -----------------------------------------------------------------
            page.evaluate("""async () => {
              window.__SW_WIDGET__.forms.stopGuidedFill();
              await window.__SW_SAY__('next step');
            }""")
            assert page.evaluate("() => window.__C2_STATE__.nextClicks == 0 && window.__SW_WIDGET__.confirm.isAwaiting()")
            page.evaluate("async () => { await window.__SW_SAY__('yes'); }")
            assert page.evaluate("() => window.__C2_STATE__.nextClicks == 1")
            assert page.evaluate("() => window.__SESSION_STORE__.sleepwalker_session_task && window.__SESSION_STORE__.sleepwalker_session_task.kind === 'multistep_form'")

            # Simulate next page boot resume via navigator
            resumed = page.evaluate("async () => await window.__SW_WIDGET__.navigator.tryResumeSavedState()")
            assert resumed is True and page.evaluate("() => window.__SW_WIDGET__.forms.isGuidedActive()")
            page.evaluate("() => window.__SW_WIDGET__.forms.stopGuidedFill()")

            # Submit review: summary card + spoken summary + explicit yes + critical 2nd confirm (NEVER auto-submit)
            page.evaluate("async () => { await window.__SW_SAY__('submit form'); }")
            sub_info = page.evaluate("""() => ({
              submitted: window.__C2_STATE__.submittedCount,
              awaiting: window.__SW_WIDGET__.confirm.isAwaiting(),
              summary: window.__SW_WIDGET__.confirm.pending && window.__SW_WIDGET__.confirm.pending.summary,
              risk: window.__SW_WIDGET__.confirm.pending && window.__SW_WIDGET__.confirm.pending.risk
            })""")
            assert sub_info["submitted"] == 0 and sub_info["awaiting"] and sub_info["risk"] == "critical"
            summary_joined = " ".join(sub_info["summary"] or [])
            assert "Asha Devi" in summary_joined and "994411" not in summary_joined, f"Submit summary leak or missing field: {summary_joined}"

            # 1st Yes -> STILL NOT submitted
            page.evaluate("async () => { await window.__SW_SAY__('yes'); }")
            assert page.evaluate("() => window.__C2_STATE__.submittedCount") == 0

            # 2nd Yes -> submits!
            page.evaluate("async () => { await window.__SW_SAY__('yes'); }")
            assert page.evaluate("() => window.__C2_STATE__.submittedCount") == 1

            print("PASS: All Phase C2 Form Engine E2E tests passed (T1-T5, 100%)!")
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    run_c2_tests()
