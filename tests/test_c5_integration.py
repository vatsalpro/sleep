#!/usr/bin/env python3
"""
Phase C5 End-to-End Integration Test (Playwright Headless Chromium)
Verifies the complete Sleepwalker upgraded pipeline against a full unified Fixture form:
  - Continuous dialogue (Alt+S / window.__SW_SAY__, END mid-form guard, "thanks" close mic)
  - Guided fill across all control types (text, number, email, tel, date, textarea,
    native select, custom combobox, radio group, checkbox group, switch)
  - Answer-first interpretation ("Karnataka" after State prompt -> selects Karnataka)
  - Honest verification failure detection when a page control reverts/refuses edits
  - Password, OTP, CAPTCHA never indexed/read/stored/sent to LLM
  - Critical Submit double-confirm + "ruko" cancel
  - Route B photo upload (oversized noisy PNG > 2 MB compressed < 2 MB) + PDF dropzone upload
  - Camera permission states (denied / prompt / granted) + real fake-device MediaStream tracks stopped
  - Zero unauthorized outbound network requests except allowed LLM fallback
"""

import http.server
import json
import os
import socketserver
import struct
import sys
import tempfile
import threading
import zlib
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def make_noisy_png(width: int, height: int) -> bytes:
    """Create a valid RGBA PNG using random pixel data so its file size exceeds 2 MB."""
    # Each scanline: 1 filter byte (0) + width * 4 RGBA bytes (approx 2.6-3.0 MB for 900x800)
    row_bytes = width * 4
    raw = b"".join(b"\x00" + os.urandom(row_bytes) for _ in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=1)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


FIXTURE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Unified C5 Portal Fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; max-width: 820px; }
    .row { margin-bottom: 14px; }
    label { display: block; font-weight: 600; margin-bottom: 4px; }
    .inline-opts label { display: inline-block; margin-right: 12px; font-weight: 400; }
    [role="listbox"] { border: 1px solid #888; max-width: 240px; padding: 4px; background: #fff; }
    [role="option"] { padding: 4px 8px; cursor: pointer; }
    [role="option"][aria-selected="true"] { background: #dbeafe; }
    .dropzone { border: 2px dashed #64748b; padding: 14px; border-radius: 8px; margin-top: 8px; }
    [role="switch"] { padding: 6px 12px; border: 1px solid #444; cursor: pointer; }
    button { padding: 8px 14px; margin-right: 8px; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Scholarship Application Fixture</h1>
    <p>Fill all details carefully. Maximum photo upload size is 2 MB (JPG/PNG). Application fee ₹0.</p>
    <form id="app-form" novalidate>
      <div class="row">
        <label for="f-name">Full Name *</label>
        <input id="f-name" name="fullName" type="text" required>
      </div>
      <div class="row">
        <label for="f-age">Age</label>
        <input id="f-age" name="age" type="number">
      </div>
      <div class="row">
        <label for="f-email">Email</label>
        <input id="f-email" name="email" type="email">
      </div>
      <div class="row">
        <label for="f-phone">Phone Number</label>
        <input id="f-phone" name="phone" type="tel">
      </div>
      <div class="row">
        <label for="f-dob">Date of Birth</label>
        <input id="f-dob" name="dob" type="date">
      </div>
      <div class="row">
        <label for="f-notes">Address Notes</label>
        <textarea id="f-notes" name="notes" rows="2"></textarea>
      </div>
      <div class="row">
        <label for="f-state">State *</label>
        <select id="f-state" name="state" required>
          <option value="">-- Select State --</option>
          <option value="MH">Maharashtra</option>
          <option value="KA">Karnataka</option>
          <option value="KL">Kerala</option>
          <option value="TN">Tamil Nadu</option>
        </select>
      </div>
      <div class="row">
        <label id="lbl-city" for="f-city">District City</label>
        <input id="f-city" type="text" role="combobox" aria-labelledby="lbl-city" aria-expanded="false" aria-controls="city-list" value="">
        <div id="city-list" role="listbox" hidden>
          <div role="option" data-val="Mysuru">Mysuru</div>
          <div role="option" data-val="Bengaluru">Bengaluru</div>
          <div role="option" data-val="Pune">Pune</div>
        </div>
      </div>
      <fieldset class="row">
        <legend>Category</legend>
        <div class="inline-opts">
          <label><input type="radio" name="category" value="General"> General</label>
          <label><input type="radio" name="category" value="OBC"> OBC</label>
          <label><input type="radio" name="category" value="SC/ST"> SC/ST</label>
        </div>
      </fieldset>
      <fieldset class="row">
        <legend>Favorite Colors</legend>
        <div class="inline-opts">
          <label><input type="checkbox" name="colors" value="blue"> Blue</label>
          <label><input type="checkbox" name="colors" value="black"> Black</label>
          <label><input type="checkbox" name="colors" value="green"> Green</label>
        </div>
      </fieldset>
      <div class="row">
        <span id="lbl-sms">SMS Alerts</span>
        <button id="f-sms" type="button" role="switch" aria-checked="false" aria-labelledby="lbl-sms">Off</button>
      </div>
      <div class="row">
        <label for="f-password">Portal Password</label>
        <input id="f-password" name="password" type="password" value="SecretPass#99">
      </div>
      <div class="row">
        <label for="f-otp">One-Time OTP</label>
        <input id="f-otp" name="otp" type="text" autocomplete="one-time-code" value="482910">
      </div>
      <div class="row">
        <label for="f-captcha">CAPTCHA Verification Code</label>
        <input id="f-captcha" name="captcha" type="text" value="XK92P">
      </div>
      <div class="row">
        <label for="up-photo">Applicant Photo (max 2 MB, JPG/PNG)</label>
        <input id="up-photo" type="file" accept="image/*" capture="user">
        <div id="photo-status"></div>
      </div>
      <div class="row">
        <label for="up-pdf">Income Certificate PDF</label>
        <input id="up-pdf" type="file" accept=".pdf">
        <div id="dz-pdf" class="dropzone">Drop PDF Certificate here</div>
        <div id="pdf-status"></div>
      </div>
      <div class="row">
        <button id="btn-next-step" type="button">Next</button>
        <button id="btn-submit" type="submit">Submit</button>
      </div>
    </form>
    <div id="locked-zone" style="margin-top:16px;">
      <label for="f-locked">Verified Reference ID</label>
      <input id="f-locked" type="text" value="LOCKED">
    </div>
  </main>
  <script>
    window.__FORM_SUBMITTED__ = 0;
    window.__NEXT_CLICKED__ = 0;

    // Custom combobox wiring
    const cityInput = document.getElementById('f-city');
    const cityList = document.getElementById('city-list');
    cityInput.addEventListener('click', () => {
      cityList.hidden = false;
      cityInput.setAttribute('aria-expanded', 'true');
    });
    cityList.querySelectorAll('[role="option"]').forEach((opt) => {
      opt.addEventListener('click', () => {
        cityInput.value = opt.textContent.trim();
        cityList.hidden = true;
        cityInput.setAttribute('aria-expanded', 'false');
        cityInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    // Switch toggle
    const sw = document.getElementById('f-sms');
    sw.addEventListener('click', () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', next ? 'true' : 'false');
      sw.textContent = next ? 'On' : 'Off';
    });

    // File labels
    document.getElementById('up-photo').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      document.getElementById('photo-status').textContent = f ? (f.name + ' (' + f.size + ' bytes)') : '';
    });
    document.getElementById('up-pdf').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      document.getElementById('pdf-status').textContent = f ? f.name : '';
    });

    // Locked input deliberately refuses changes
    document.getElementById('f-locked').addEventListener('input', (e) => {
      e.target.value = 'LOCKED';
    });
    document.getElementById('f-locked').addEventListener('change', (e) => {
      e.target.value = 'LOCKED';
    });

    document.getElementById('btn-next-step').addEventListener('click', () => {
      window.__NEXT_CLICKED__ += 1;
    });
    document.getElementById('app-form').addEventListener('submit', (e) => {
      e.preventDefault();
      window.__FORM_SUBMITTED__ += 1;
    });
  </script>
</body>
</html>
"""


def main():
    llm_requests = []
    unexpected_external = []

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        oversized_png = tmp / "oversized-photo.png"
        # 900x800 noisy RGBA PNG ~ 2.7 MB (> 2 MB limit)
        png_bytes = make_noisy_png(900, 800)
        assert len(png_bytes) > 2 * 1024 * 1024, f"Expected >2MB PNG, got {len(png_bytes)}"
        oversized_png.write_bytes(png_bytes)

        sample_pdf = tmp / "income-certificate.pdf"
        sample_pdf.write_bytes(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")

        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(ROOT), **kwargs)

            def do_GET(self):
                if self.path == "/fixture.html":
                    body = FIXTURE_HTML.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                super().do_GET()

            def do_POST(self):
                if self.path == "/mock-llm-fallback":
                    length = int(self.headers.get("Content-Length", "0"))
                    raw_body = self.rfile.read(length).decode("utf-8", errors="replace")
                    llm_requests.append(raw_body)
                    resp = json.dumps({
                        "intent": "EXPLAIN",
                        "args": {"mode": "summary"},
                        "lang": "en-IN",
                        "confidence": 0.85
                    }).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(resp)))
                    self.end_headers()
                    self.wfile.write(resp)
                    return
                self.send_response(404)
                self.end_headers()

            def log_message(self, format, *args):
                pass

        httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()

        lexicon_data = json.loads((ROOT / "lexicon.json").read_text(encoding="utf-8"))
        link_lexicon = json.loads((ROOT / "link-lexicon.json").read_text(encoding="utf-8"))
        css_text = (ROOT / "widget.css").read_text(encoding="utf-8")

        script_names = [
            "reader.js", "outline.js", "voice.js", "pill.js", "glow.js", "digest.js",
            "explain.js", "confirm.js", "link-index.js", "match.js", "link-intent.js",
            "intent.js", "navigate.js", "form-index.js", "form-fill.js", "forms.js",
            "shelf-db.js", "upload.js", "camera.js", "dialogue.js", "widget.js",
        ]

        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(
                    headless=True,
                    args=[
                        "--use-fake-device-for-media-stream",
                        "--use-fake-ui-for-media-stream",
                    ],
                )
                context = browser.new_context(
                    viewport={"width": 1280, "height": 900},
                    permissions=["camera", "microphone"],
                )

                def route_guard(route):
                    url = route.request.url
                    if url.startswith(f"http://127.0.0.1:{port}/") or url.startswith("data:") or url.startswith("blob:"):
                        route.continue_()
                    else:
                        unexpected_external.append(url)
                        route.abort()

                context.route("**/*", route_guard)
                page = context.new_page()

                init_shim = f"""
                (() => {{
                  const localStore = {{}};
                  const sessionStore = {{}};
                  window.__SW_LLM_ENDPOINT__ = 'http://127.0.0.1:{port}/mock-llm-fallback';
                  window.chrome = {{
                    runtime: {{
                      getURL: (p) => location.origin + '/' + p.replace(/^\\//, ''),
                      getManifest: () => ({{ version: '1.0.0' }}),
                      sendMessage: (msg, cb) => {{
                        if (msg && msg.type === 'SLEEPWALKER_INTENT_REQUEST') {{
                          fetch(window.__SW_LLM_ENDPOINT__, {{
                            method: 'POST',
                            headers: {{ 'Content-Type': 'application/json' }},
                            body: JSON.stringify(msg.payload || {{}})
                          }})
                            .then((r) => r.json())
                            .then((data) => cb && cb({{ status: 'ok', ...data, source: 'mock_llm' }}))
                            .catch(() => cb && cb({{ status: 'fallback' }}));
                          return true;
                        }}
                        if (msg && msg.type === 'SLEEPWALKER_SHELF_STATUS') {{
                          if (typeof cb === 'function') cb({{ status: 'not_connected', count: 0 }});
                          return true;
                        }}
                        if (typeof cb === 'function') cb({{ status: 'ok' }});
                      }},
                      onMessage: {{ addListener: () => {{}} }}
                    }},
                    storage: {{
                      local: {{
                        get: (k, cb) => cb({{ ...localStore }}),
                        set: (o, cb) => {{ Object.assign(localStore, o || {{}}); if (cb) cb(); }}
                      }},
                      session: {{
                        get: (k, cb) => cb({{ ...sessionStore }}),
                        set: (o, cb) => {{ Object.assign(sessionStore, o || {{}}); if (cb) cb(); }}
                      }}
                    }}
                  }};

                  // Mock SpeechRecognition + SpeechSynthesis
                  window.__SR_INSTANCES__ = [];
                  window.SpeechRecognition = class MockSR {{
                    constructor() {{
                      this.lang = 'en-IN';
                      this.continuous = false;
                      this.interimResults = true;
                      this._started = false;
                      window.__SR_INSTANCES__.push(this);
                    }}
                    start() {{ this._started = true; }}
                    stop() {{ this._started = false; this.onend && this.onend(); }}
                    abort() {{ this._started = false; this.onend && this.onend(); }}
                  }};

                  window.__SPOKEN__ = [];
                  const synthMock = {{
                    speaking: false, paused: false, pending: false, onvoiceschanged: null,
                    getVoices: () => [{{ name: 'Mock EN-IN', lang: 'en-IN', default: true }}],
                    speak: (u) => {{
                      window.__SPOKEN__.push(u.text);
                      synthMock.speaking = true;
                      setTimeout(() => {{
                        synthMock.speaking = false;
                        u.onend && u.onend();
                      }}, 4);
                    }},
                    cancel: () => {{ synthMock.speaking = false; }},
                    pause: () => {{}},
                    resume: () => {{}}
                  }};
                  Object.defineProperty(window, 'speechSynthesis', {{ value: synthMock, configurable: true }});
                  window.SpeechSynthesisUtterance = function (t) {{ this.text = t || ''; }};

                  // Camera permission state switchable for denied / prompt / granted tests
                  window.__CAM_PERM__ = 'granted';
                  Object.defineProperty(navigator, 'permissions', {{
                    configurable: true,
                    value: {{
                      query: async ({{ name }}) => ({{ state: name === 'camera' ? window.__CAM_PERM__ : 'granted' }})
                    }}
                  }});

                  // Transparent spy around REAL Chromium fake-device getUserMedia
                  window.__REAL_GUM_TRACKS__ = [];
                  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {{
                    const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                    navigator.mediaDevices.getUserMedia = async (constraints) => {{
                      const stream = await origGum(constraints);
                      stream.getTracks().forEach((t) => window.__REAL_GUM_TRACKS__.push(t));
                      return stream;
                    }};
                  }}
                }})();
                """

                page.goto(f"http://127.0.0.1:{port}/fixture.html", wait_until="domcontentloaded")
                page.evaluate(init_shim)
                for sname in script_names:
                    page.add_script_tag(url=f"http://127.0.0.1:{port}/{sname}")

                page.evaluate(
                    "([lex, llex, css]) => { window.__L1 = lex; window.__L2 = llex; window.__CSS = css; const w = new window.SleepwalkerWidget(); window.__SW_WIDGET__ = w; }",
                    [lexicon_data, link_lexicon, css_text],
                )
                page.wait_for_function(
                    "() => window.__SW_WIDGET__ && window.__SW_WIDGET__.shadowRoot && window.__SW_WIDGET__.dialogue && window.__SW_WIDGET__.forms && window.__SW_WIDGET__.upload && window.__SW_WIDGET__.camera && typeof window.__SW_SAY__ === 'function'"
                )
                page.evaluate(
                    """() => {
                      const w = window.__SW_WIDGET__;
                      const st = document.createElement('style');
                      st.textContent = window.__CSS;
                      w.shadowRoot.prepend(st);
                      w.intentEngine.lexicon = window.__L1;
                      if (w.linkIntent) w.linkIntent.lexicon = window.__L2;
                      w.dialogue.setTimers({ resumeDelayMs: 10, silenceAskMs: 60000, silenceEndMs: 120000 });
                    }"""
                )

                # ================================================================
                # T1: Continuous Dialogue + Guided Form Fill + Mid-form END Guard
                #     + "Karnataka" as answer + "thanks" closes mic
                # ================================================================
                page.evaluate("() => window.__SW_WIDGET__.toggle({ startDialogue: true, source: 'alt_s' })")
                assert page.evaluate("() => window.__SW_WIDGET__.dialogue.active && window.__SW_WIDGET__.voice.isListening"), "Dialogue session should start active"

                await_say = "async (txt) => await window.__SW_SAY__(txt)"
                page.evaluate(await_say, "fill this form")
                page.wait_for_function("() => window.__SW_WIDGET__.forms.isGuidedActive()")

                # Fill first field (Full Name) so the form is genuinely half-done mid-fill
                page.evaluate(await_say, "aasha rao")
                page.evaluate(await_say, "yes")
                assert page.evaluate("() => document.getElementById('f-name').value") == "Aasha Rao"

                # Test END mid-form guard: asks before ending, and "no" keeps form session open
                page.evaluate(await_say, "thanks")
                last_spoken = page.evaluate("() => window.__SW_WIDGET__.dialogue.lastSpokenText || ''")
                assert "Stop now? Your form stays as it is." in last_spoken, f"Expected mid-form END guard, got: {last_spoken}"
                page.evaluate(await_say, "no")
                assert page.evaluate("() => window.__SW_WIDGET__.dialogue.active && window.__SW_WIDGET__.forms.isGuidedActive()"), "Guided fill should resume after declining END"

                # Walk remaining guided fields in page order
                guided_answers = {
                    "Full Name": "aasha rao",
                    "Age": "twenty two",
                    "Email": "aasha dot rao at gmail dot com",
                    "Phone Number": "nine eight four five zero one two three four five",
                    "Date of Birth": "fifteen August two thousand five",
                    "Address Notes": "flat twelve mg road",
                    "State": "Karnataka",
                    "District City": "Mysuru",
                    "Category": "OBC",
                    "Favorite Colors": "blue and black",
                    "SMS Alerts": "on",
                }
                seen_state_question = False
                seen_progress = False
                for _ in range(35):
                    state = page.evaluate("""() => {
                      const f = window.__SW_WIDGET__.forms;
                      if (!f.isGuidedActive()) return { done: true };
                      const field = f.guidedState.fields[f.guidedState.index];
                      return {
                        done: false,
                        idx: f.guidedState.index,
                        total: f.guidedState.fields.length,
                        label: field ? field.label : '',
                        sensitive: Boolean(field && field.sensitive),
                        awaitingSensitive: Boolean(f.guidedState.awaitingSensitiveDone)
                      };
                    }""")
                    if state["done"]:
                        break
                    lbl = state["label"]
                    last_reply = page.evaluate("() => window.__SW_WIDGET__.dialogue.lastSpokenText || ''")
                    if " of " in last_reply and "done" in last_reply:
                        seen_progress = True
                    if state["sensitive"] or state["awaitingSensitive"]:
                        assert "Please enter this one yourself" in last_reply, f"Expected sensitive warning for {lbl}, got: {last_reply}"
                        assert "SecretPass#99" not in last_reply and "482910" not in last_reply and "XK92P" not in last_reply
                        page.evaluate(await_say, "done")
                        continue
                    ans = None
                    for k, v in guided_answers.items():
                        if k.lower() in lbl.lower():
                            ans = v
                            break
                    if "State" in lbl:
                        seen_state_question = True
                    if ans is None:
                        page.evaluate(await_say, "skip")
                        continue
                    page.evaluate(await_say, ans)
                    awaiting_confirm = page.evaluate("() => Boolean(window.__SW_WIDGET__.confirm && window.__SW_WIDGET__.confirm.isAwaiting())")
                    if awaiting_confirm:
                        page.evaluate(await_say, "yes")
                        if "City" in lbl:
                            page.wait_for_timeout(180)

                assert seen_state_question, "Guided fill must visit State select"
                assert seen_progress, "Guided fill must announce progress ('X of Y done')"
                assert page.evaluate("() => !window.__SW_WIDGET__.forms.isGuidedActive()"), "Full guided fill must finish all fields"

                # Verify filled DOM values
                vals = page.evaluate("""() => ({
                  name: document.getElementById('f-name').value,
                  age: document.getElementById('f-age').value,
                  email: document.getElementById('f-email').value,
                  phone: document.getElementById('f-phone').value,
                  dob: document.getElementById('f-dob').value,
                  notes: document.getElementById('f-notes').value,
                  state: document.getElementById('f-state').value,
                  city: document.getElementById('f-city').value,
                  cat: Array.from(document.querySelectorAll('input[name="category"]')).find(r => r.checked)?.value,
                  colors: Array.from(document.querySelectorAll('input[name="colors"]:checked')).map(c => c.value),
                  sms: document.getElementById('f-sms').getAttribute('aria-checked')
                })""")
                assert vals["name"] == "Aasha Rao", f"Unexpected name: {vals}"
                assert vals["age"] == "22", f"Unexpected age: {vals}"
                assert vals["email"] == "aasha.rao@gmail.com", f"Unexpected email: {vals}"
                assert vals["phone"] == "9845012345", f"Unexpected phone: {vals}"
                assert vals["dob"] == "2005-08-15", f"Unexpected dob: {vals}"
                assert "flat" in vals["notes"].lower() and "mg road" in vals["notes"].lower(), f"Unexpected notes: {vals}"
                assert vals["state"] == "KA", f"Expected Karnataka ('KA') after State prompt, got: {vals}"
                assert vals["city"] == "Mysuru", f"Expected Mysuru combobox, got: {vals}"
                assert vals["cat"] == "OBC", f"Expected OBC radio, got: {vals}"
                assert vals["colors"] == ["blue", "black"], f"Expected blue & black checkboxes, got: {vals}"
                assert vals["sms"] == "true", f"Expected SMS switch on, got: {vals}"

                print("PASS  T1: Continuous dialogue, full guided fill, Karnataka answer, and mid-form END guard")

                # ================================================================
                # T2: Verification catches control that did not change (#f-locked)
                # ================================================================
                lock_res = page.evaluate("""() => {
                  const el = document.getElementById('f-locked');
                  return window.__SW_WIDGET__.forms.setControlValueSafe(
                    { element: el, type: 'text', label: 'Verified Reference ID', sensitive: false },
                    'NEWVALUE123'
                  );
                }""")
                assert lock_res["ok"] is False and lock_res.get("verified") is False, f"Verification must catch refused edit: {lock_res}"
                print("PASS  T2: Control state verification catches uncooperative/reverted input")

                # ================================================================
                # T3: Privacy Audit (Sensitive fields never indexed/read/stored/sent)
                #     & Allowed-Only LLM Fallback
                # ================================================================
                sw_index = page.evaluate("() => window.__SW_FORMS__()")
                for row in sw_index:
                    assert "SecretPass#99" not in json.dumps(row)
                    assert "482910" not in json.dumps(row)
                    assert "XK92P" not in json.dumps(row)

                # Focusing password field and speaking an ambiguous utterance must NOT call LLM
                llm_before = len(llm_requests)
                page.evaluate("""async () => {
                  const pwd = document.getElementById('f-password');
                  pwd.focus();
                  await window.__SW_SAY__('xyzzy blorf secret');
                }""")
                assert len(llm_requests) == llm_before, "LLM must NOT be called while a sensitive field is focused!"

                # Blurring sensitive field and speaking unclear phrase calls ONLY allowed mock LLM fallback
                page.evaluate("""async () => {
                  document.getElementById('f-password').blur();
                  document.getElementById('f-name').focus();
                  await window.__SW_SAY__('blorf gribbit summarize overview');
                }""")
                assert len(llm_requests) == llm_before + 1, "Unclear non-sensitive command should reach allowed LLM fallback"
                all_llm_text = "\n".join(llm_requests)
                for forbidden in ["SecretPass#99", "482910", "XK92P", "Aasha Rao", "aasha.rao@gmail.com", "9845012345"]:
                    assert forbidden not in all_llm_text, f"Privacy breach: {forbidden!r} sent to LLM!"

                mem_json = json.dumps(page.evaluate("() => window.__SW_WIDGET__.dialogue.getMemory()"))
                for forbidden in ["SecretPass#99", "482910", "XK92P"]:
                    assert forbidden not in mem_json, f"Privacy breach: {forbidden!r} stored in dialogue memory!"
                assert unexpected_external == [], f"Unexpected external network calls detected: {unexpected_external}"
                print("PASS  T3: Password/OTP/CAPTCHA never indexed, read, stored, or sent; only allowed LLM fallback runs")

                # ================================================================
                # T4: Critical Submit Double Confirmation + "ruko" Cancel
                # ================================================================
                page.evaluate("() => window.__SW_SAY__('submit form')")
                assert page.evaluate("() => window.__FORM_SUBMITTED__") == 0, "Submit must NOT fire before confirmation"
                assert page.evaluate("() => window.__SW_WIDGET__.confirm.isAwaiting()") is True

                page.evaluate("() => window.__SW_SAY__('ruko')")
                assert page.evaluate("() => window.__FORM_SUBMITTED__") == 0
                assert page.evaluate("() => !window.__SW_WIDGET__.confirm.isAwaiting()")

                page.evaluate("() => window.__SW_SAY__('submit form')")
                assert page.evaluate("() => window.__FORM_SUBMITTED__") == 0
                page.evaluate("() => window.__SW_SAY__('haan')")
                # After first confirm, MUST still wait at step 2 of 2!
                assert page.evaluate("() => window.__FORM_SUBMITTED__") == 0, "Critical submit must require double confirm"
                assert page.evaluate("() => window.__SW_WIDGET__.confirm.pending && window.__SW_WIDGET__.confirm.pending.step === 2")
                page.evaluate("() => window.__SW_SAY__('theek hai')")
                assert page.evaluate("() => window.__FORM_SUBMITTED__") == 1, "Submit button must click after 2nd confirm"

                # After submit completes (_submitted = true), "thanks" ends dialogue session immediately and closes mic
                page.evaluate("async () => await window.__SW_SAY__('thanks')")
                end_state = page.evaluate("""() => ({
                  active: window.__SW_WIDGET__.dialogue.active,
                  listening: window.__SW_WIDGET__.voice.isListening,
                  micAttr: window.__SW_WIDGET__.pill.pillBtn.dataset.micSession,
                  spoken: window.__SW_WIDGET__.dialogue.lastSpokenText || ''
                })""")
                assert end_state["active"] is False and end_state["listening"] is False, f"Mic must close on 'thanks': {end_state}"
                assert end_state["micAttr"] == "idle", f"Orb must reflect idle mic: {end_state}"
                assert "Goodbye" in end_state["spoken"], f"Expected short goodbye, got: {end_state}"
                print("PASS  T4: Critical Submit double confirmation ('haan' + 'theek hai'), 'ruko' cancel, and 'thanks' closes mic")

                # ================================================================
                # T5: Route B Photo Upload (>2 MB compression) + PDF Drop Zone
                # ================================================================
                page.evaluate("async () => await window.__SW_SAY__('upload photo')")
                page.wait_for_function("() => Boolean(window.__SW_WIDGET__.upload.pendingCardState && window.__SW_WIDGET__.shadowRoot.querySelector('#sw-panel-file-card .sw-choose-file-btn, #sw-pill-file-card .sw-choose-file-btn'))")
                with page.expect_file_chooser() as fc_info:
                    page.locator("#sw-panel-file-card .sw-choose-file-btn").click()
                fc_info.value.set_files(str(oversized_png))

                # Wait for validation error offering client-side compression -> click "Compress Photo" -> confirm Yes ("haan")
                page.wait_for_function("() => Boolean(window.__SW_WIDGET__.upload.pendingCardState && window.__SW_WIDGET__.upload.pendingCardState.canCompress)")
                page.evaluate("""() => {
                  const sr = window.__SW_WIDGET__.shadowRoot;
                  const compBtn = Array.from(sr.querySelectorAll('#sw-panel-file-card button, #sw-pill-file-card button')).find(b => b.textContent.includes('Compress Photo'));
                  if (!compBtn) throw new Error('Compress Photo button missing');
                  compBtn.click();
                }""")
                page.wait_for_function("() => Boolean(window.__SW_WIDGET__.confirm && window.__SW_WIDGET__.confirm.isAwaiting())")
                page.evaluate("async () => await window.__SW_SAY__('haan')")
                page.wait_for_function("() => { const i = document.getElementById('up-photo'); return i.files && i.files.length === 1; }")
                photo_meta = page.evaluate("() => { const f = document.getElementById('up-photo').files[0]; return { name: f.name, size: f.size, type: f.type }; }")
                assert photo_meta["size"] <= 2 * 1024 * 1024, f"Oversized PNG should compress <= 2 MB, got {photo_meta}"
                assert photo_meta["size"] > 0

                # PDF dropzone Route B attachment
                page.evaluate("async () => await window.__SW_SAY__('upload income certificate')")
                page.wait_for_function("() => Boolean(window.__SW_WIDGET__.upload.pendingCardState && window.__SW_WIDGET__.shadowRoot.querySelector('#sw-panel-file-card .sw-choose-file-btn, #sw-pill-file-card .sw-choose-file-btn'))")
                with page.expect_file_chooser() as fc_pdf:
                    page.locator("#sw-panel-file-card .sw-choose-file-btn").click()
                fc_pdf.value.set_files(str(sample_pdf))
                page.wait_for_function("() => Boolean(window.__SW_WIDGET__.confirm && window.__SW_WIDGET__.confirm.isAwaiting())")
                page.evaluate("async () => await window.__SW_SAY__('kar do')")
                page.wait_for_function("() => { const i = document.getElementById('up-pdf'); return i.files && i.files.length === 1; }")
                pdf_name = page.evaluate("() => document.getElementById('up-pdf').files[0].name")
                assert pdf_name == "income-certificate.pdf", f"Unexpected PDF filename: {pdf_name}"

                # Ensure filenames were never transmitted in any LLM request
                llm_after_upload = "\n".join(llm_requests)
                assert "oversized-photo.png" not in llm_after_upload and "income-certificate.pdf" not in llm_after_upload
                print(f"PASS  T5: Route B upload compressed >2 MB image to {photo_meta['size']} bytes + attached {pdf_name}")

                # ================================================================
                # T6: Camera Permission Helper (denied / prompt / granted)
                #     + Fake Media Device Capture & Track Stop Verification
                # ================================================================
                # 6a. Denied state -> unblock steps + "say ready"
                page.evaluate("() => { window.__CAM_PERM__ = 'denied'; window.__SW_WIDGET__.camera.setTimers({ countdownStepMs: 30 }); }")
                page.evaluate("async () => await window.__SW_SAY__('take a photo')")
                page.wait_for_function("() => window.__SW_WIDGET__.camera.cardState && window.__SW_WIDGET__.camera.cardState.stage === 'permission_help'")
                denied_msg = page.evaluate("() => window.__SW_WIDGET__.dialogue.lastSpokenText || ''")
                assert "Site settings" in denied_msg and "say ready" in denied_msg.lower(), f"Expected camera unblock guide, got: {denied_msg}"

                # 6b. Switch permission to prompt -> say "ready" -> speaks Allow guide then opens fake-device live stream
                page.evaluate("() => { window.__CAM_PERM__ = 'prompt'; window.__SPOKEN__ = []; }")
                page.evaluate("async () => await window.__SW_SAY__('ready')")
                page.wait_for_function("() => window.__SW_WIDGET__.camera.cardState && window.__SW_WIDGET__.camera.cardState.stage === 'live'")
                prompt_msgs = page.evaluate("() => window.__SPOKEN__.join(' | ')")
                assert "Click Allow near the address bar" in prompt_msgs, f"Expected prompt helper guidance, got: {prompt_msgs}"

                # Cancel before capture and verify real Chromium MediaStreamTrack stops immediately
                page.evaluate("async () => await window.__SW_SAY__('cancel')")
                page.wait_for_function("() => !window.__SW_WIDGET__.camera.cardState")
                assert page.evaluate("() => window.__REAL_GUM_TRACKS__.length >= 1 && window.__REAL_GUM_TRACKS__.every(t => t.readyState === 'ended')"), "Fake device tracks must stop on cancel"

                # 6c. Granted state -> live preview -> countdown capture -> confirm Use This -> verify attached + tracks ended
                page.evaluate("() => { window.__CAM_PERM__ = 'granted'; window.__REAL_GUM_TRACKS__.length = 0; }")
                page.evaluate("async () => await window.__SW_SAY__('use camera')")
                page.wait_for_function("() => window.__SW_WIDGET__.camera.cardState && window.__SW_WIDGET__.camera.cardState.stage === 'live'")
                cam_badge = page.evaluate("() => (window.__SW_WIDGET__.shadowRoot.getElementById('sw-panel-camera-card')?.textContent || window.__SW_WIDGET__.shadowRoot.getElementById('sw-pill-camera-card')?.textContent || '')")
                assert "Camera on" in cam_badge, f"Expected Camera on indicator, got: {cam_badge}"

                page.evaluate("async () => await window.__SW_SAY__('shoot')")
                page.wait_for_function("() => window.__SW_WIDGET__.camera.cardState && window.__SW_WIDGET__.camera.cardState.stage === 'preview'")
                assert page.evaluate("() => window.__REAL_GUM_TRACKS__.every(t => t.readyState === 'ended')"), "Tracks must stop right after frame capture"

                page.evaluate("async () => await window.__SW_SAY__('yes')")
                page.wait_for_function("() => document.getElementById('up-photo').files[0] && document.getElementById('up-photo').files[0].name === 'camera-capture.jpg'")
                cam_file = page.evaluate("() => { const f = document.getElementById('up-photo').files[0]; return { name: f.name, type: f.type, size: f.size }; }")
                assert cam_file["type"] == "image/jpeg" and cam_file["size"] > 0
                assert page.evaluate("() => window.__REAL_GUM_TRACKS__.every(t => t.readyState === 'ended')")
                print(f"PASS  T6: Camera helper (denied/prompt/granted), fake-device JPEG capture ({cam_file['size']} bytes), all tracks stopped")

                browser.close()
        finally:
            httpd.shutdown()

    print("\nPASS: All Phase C5 End-to-End Integration tests passed (T1-T6, 100%)!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
