"""
Headless Chromium + Playwright End-to-End Verification Suite for Sleepwalker
Run with: python tests/playwright_e2e.py
"""

import json
import os
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def make_handler(root_dir: Path, captured_llm_requests: list):
    class DemoHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root_dir), **kwargs)

        def log_message(self, format, *args):
            return

        def do_POST(self):
            parsed = urlparse(self.path)
            if parsed.path != "/mock-llm":
                self.send_response(404)
                self.end_headers()
                return

            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8", errors="replace")
            try:
                body = json.loads(raw_body)
            except Exception:
                body = {"raw": raw_body}

            captured_llm_requests.append(body)

            if body.get("kind") == "intent":
                text = str(body.get("text", "")).lower()
                intent = "EXPLAIN"
                args = {"mode": "summary"}
                if "fee" in text or "kitni" in text:
                    intent = "ANSWER"
                    args = {"query": body.get("text", "")}
                elif "link" in text or "scroll" in text or "jao" in text or "back" in text:
                    intent = "NAVIGATE"
                    args = {"action": "click", "target": text}
                elif "upload" in text:
                    intent = "UPLOAD"
                    args = {"target": text}
                reply = {
                    "status": "ok",
                    "intent": intent,
                    "args": args,
                    "lang": body.get("lang", "en-IN"),
                    "confidence": 0.88,
                }
            else:
                reply = {
                    "status": "ok",
                    "source": "mock-gemini-proxy",
                    "answer": (
                        "National Scholarship Portal 2026 covers tuition and stipend. "
                        "Registration fee is 1,200 INR for General and 600 INR for SC/ST. "
                        "Submit Passport Photo, Marksheet, and Income Certificate before January 15, 2027."
                    ),
                }

            payload = json.dumps(reply).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return DemoHandler


def main():
    captured_llm_requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(ROOT, captured_llm_requests))
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    css_text = (ROOT / "widget.css").read_text(encoding="utf-8")
    phrases_data = json.loads((ROOT / "tests" / "phrases.json").read_text(encoding="utf-8"))
    lexicon_data = json.loads((ROOT / "lexicon.json").read_text(encoding="utf-8"))

    # Runtime script order matching manifest.json (skipping content.js auto-boot so test initializes deterministically)
    script_names = [
        "reader.js",
        "outline.js",
        "voice.js",
        "pill.js",
        "glow.js",
        "digest.js",
        "explain.js",
        "confirm.js",
        "link-index.js",
        "match.js",
        "link-intent.js",
        "intent.js",
        "navigate.js",
        "form-index.js",
        "form-fill.js",
        "forms.js",
        "shelf-db.js",
        "upload.js",
        "camera.js",
        "dialogue.js",
        "widget.js",
    ]

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()

            # Provide lightweight Chrome extension API bridge inside the demo page
            init_shim = f"""
            (() => {{
              const localStore = {{
                sleepwalker_proxy_url: "http://127.0.0.1:{port}/mock-llm",
                sleepwalker_gemini_api_key: "",
                sleepwalker_local_only: false
              }};
              const sessionStore = {{}};
              window.__SW_TEST_CSS__ = {json.dumps(css_text)};
              window.chrome = {{
                runtime: {{
                  lastError: null,
                  getURL: (p) => `http://127.0.0.1:{port}/` + String(p).replace(/^\\/+/, ""),
                  sendMessage: (msg, cb) => {{
                    if (!msg || typeof cb !== "function") return;
                    if (msg.type === "SLEEPWALKER_EXPLAIN_REQUEST") {{
                      fetch(`http://127.0.0.1:{port}/mock-llm`, {{
                        method: "POST",
                        headers: {{ "Content-Type": "application/json" }},
                        body: JSON.stringify({{ kind: "explain", ...(msg.payload || {{}}) }})
                      }})
                        .then((r) => r.json())
                        .then((data) => cb(data))
                        .catch((err) => cb({{ status: "fallback", error: err.message }}));
                    }} else if (msg.type === "SLEEPWALKER_INTENT_REQUEST") {{
                      fetch(`http://127.0.0.1:{port}/mock-llm`, {{
                        method: "POST",
                        headers: {{ "Content-Type": "application/json" }},
                        body: JSON.stringify({{ kind: "intent", ...(msg.payload || {{}}) }})
                      }})
                        .then((r) => r.json())
                        .then((data) => cb(data))
                        .catch(() => cb(null));
                    }} else if (msg.type === "SLEEPWALKER_GET_LLM_DIAGNOSTICS") {{
                      cb({{
                        diagnostics: {{
                          callsTotal: 1, intentCalls: 0, explainCalls: 1, qaCalls: 0,
                          cacheHits: 0, approxInputTokens: 280, approxOutputTokens: 45,
                          geminiRpmUsed: 1, geminiRpmLimit: 12, rateLimitEvents: 0
                        }}
                      }});
                    }} else if (msg.type === "SLEEPWALKER_GET_ENV_DEFAULTS" || msg.type === "SLEEPWALKER_RELOAD_ENV") {{
                      cb({{
                        status: "ok",
                        envLoaded: true,
                        geminiKey: "AIza_MOCK_ENV_KEY_1234",
                        geminiModel: "gemini-2.5-flash-lite",
                        ollamaUrl: "http://localhost:11434",
                        ollamaModel: "llama3.2:3b",
                        proxyUrl: "",
                        localOnly: false
                      }});
                    }} else {{
                      cb({{ status: "ok" }});
                    }}
                  }},
                  onMessage: {{ addListener: () => {{}} }}
                }},
                storage: {{
                  local: {{
                    get: (keys, cb) => {{
                      if (typeof cb === "function") cb({{ ...localStore }});
                    }},
                    set: (obj, cb) => {{
                      Object.assign(localStore, obj || {{}});
                      if (typeof cb === "function") cb();
                    }}
                  }},
                  session: {{
                    get: (keys, cb) => {{
                      if (typeof cb === "function") cb({{ ...sessionStore }});
                    }},
                    set: (obj, cb) => {{
                      Object.assign(sessionStore, obj || {{}});
                      if (typeof cb === "function") cb();
                    }}
                  }}
                }}
              }};
            }})();
            """
            page.add_init_script(init_shim)
            page.goto(f"http://127.0.0.1:{port}/demo-portal.html?token=secret_query_should_never_leak", wait_until="domcontentloaded")

            # Inject real extension modules & patch widget CSS loader inside Shadow DOM
            for sname in script_names:
                page.add_script_tag(url=f"http://127.0.0.1:{port}/{sname}")

            # Instantiate real SleepwalkerWidget inside Shadow DOM with local widget.css
            page.evaluate("""() => {
              const origFetch = window.fetch.bind(window);
              window.fetch = (url, opts) => origFetch(url, opts);
              const w = new window.SleepwalkerWidget();
              window.__SW_WIDGET__ = w;
              w.init().then(() => {
                // Ensure loaded CSS applies cleanly inside shadowRoot even without chrome-extension:// origin
                const styleEl = document.createElement('style');
                styleEl.textContent = window.__SW_TEST_CSS__;
                w.shadowRoot.prepend(styleEl);
              });
            }""")
            page.wait_for_function("() => window.__SW_WIDGET__ && window.__SW_WIDGET__.shadowRoot && window.__SW_WIDGET__.intentEngine && window.__SW_WIDGET__.intentEngine.lexicon")
            # Wait for widget async init & stylesheet injection
            page.wait_for_function("() => window.__SW_WIDGET__.confirm && window.__SW_WIDGET__.forms && window.__SW_WIDGET__.upload && window.__SW_WIDGET__.glow")

            # -----------------------------------------------------------------
            # Assertion 1: Full phrase table passes in live Chromium JS engine (>=70% 0-LLM)
            # -----------------------------------------------------------------
            phrase_report = page.evaluate("""async (phrases) => {
              const engine = new window.SleepwalkerIntentEngine({
                lexicon: window.__SW_WIDGET__.intentEngine.lexicon,
                llmCaller: async (payload) => {
                  const res = await fetch(location.origin + '/mock-llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kind: 'intent', ...payload })
                  });
                  return res.json();
                }
              });
              // Evaluate rule resolution vs LLM fallback
              let passed = 0;
              let failures = [];
              for (const entry of phrases) {
                const res = await engine.classify(entry.phrase, entry.context || {});
                if (entry.expectSource === 'rules') {
                  if (res.intent === entry.expectedIntent && res.source === 'rules') {
                    passed += 1;
                  } else {
                    failures.push({ id: entry.id, phrase: entry.phrase, got: res });
                  }
                } else {
                  if (res && res.intent) passed += 1;
                  else failures.push({ id: entry.id, phrase: entry.phrase, got: res });
                }
              }
              return { total: phrases.length, passed, ruleHits: engine.stats.ruleHits, failures };
            }""", phrases_data["phrases"])
            assert phrase_report["passed"] == phrase_report["total"], f"Phrase table failures: {phrase_report['failures']}"
            rule_pct = (phrase_report["ruleHits"] / phrase_report["total"]) * 100
            assert rule_pct >= 70.0, f"Expected >=70% 0-LLM rule resolution, got {rule_pct:.1f}%"
            print(f"PASS  Playwright Phrase Table in Chromium ({phrase_report['passed']}/{phrase_report['total']}, {rule_pct:.1f}% zero-LLM rules)")

            # -----------------------------------------------------------------
            # Assertion 2: Passwords / OTP / query string NEVER in digest or LLM requests
            # -----------------------------------------------------------------
            captured_llm_requests.clear()
            digest_json = page.evaluate("""async () => {
              const d = window.SleepwalkerDigest.buildDigest(document);
              await window.__SW_WIDGET__.handleUserInput('explain this page', 'typed');
              await new Promise((r) => setTimeout(r, 850));
              return JSON.stringify(d);
            }""")
            assert "SecretDemoPass#987" not in digest_json, "Password leaked in digest!"
            assert "482910" not in digest_json, "OTP leaked in digest!"
            assert "secret_query_should_never_leak" not in digest_json, "URL query string leaked in digest!"

            explain_reqs = [r for r in captured_llm_requests if r.get("kind") == "explain"]
            assert len(explain_reqs) >= 1, "Mocked LLM should receive explain request"
            all_llm_dump = json.dumps(captured_llm_requests)
            assert "SecretDemoPass#987" not in all_llm_dump, "Password leaked in LLM request!"
            assert "482910" not in all_llm_dump, "OTP leaked in LLM request!"
            assert "secret_query_should_never_leak" not in all_llm_dump, "URL query string leaked in LLM request!"
            print("PASS  Playwright Privacy: Password, OTP & query string never enter Digest or LLM requests")

            # -----------------------------------------------------------------
            # Assertion 3: Forms (text, email, select, radio, date) + sensitive skip + Submit Double-Confirm
            # -----------------------------------------------------------------
            form_result = page.evaluate("""async () => {
              const w = window.__SW_WIDGET__;
              await w.handleUserInput('mera naam Vatsal Kumar likho', 'typed');
              await w.handleUserInput('enter email vatsal at the rate gmail dot com', 'typed');
              await w.handleUserInput('enter date of birth 15 August 2004', 'typed');
              w.forms.handleDictateIntent({ field: 'Home State', value: 'Maharashtra' });
              w.forms.handleDictateIntent({ field: 'Course Level', value: 'Undergraduate' });
              const passRes = w.forms.handleDictateIntent({ field: 'Portal Password', value: 'MyBadPass' });
              const otpRes = w.forms.handleDictateIntent({ field: 'One-Time Password', value: '999999' });

              // Trigger submit via natural voice command -> MUST require critical double confirm
              await w.handleUserInput('submit kar do', 'typed');
              const afterRequestSubmitted = window.__demoPortalState.submittedCount;

              await w.handleUserInput('yes', 'typed');
              const afterFirstConfirmSubmitted = window.__demoPortalState.submittedCount;

              await w.handleUserInput('haan', 'typed');
              // Wait up to 2.5s for 1s highlight delay + DOM click submit event
              for (let i = 0; i < 25; i++) {
                if (window.__demoPortalState.submittedCount >= 1) break;
                await new Promise((r) => setTimeout(r, 100));
              }
              const afterSecondConfirmSubmitted = window.__demoPortalState.submittedCount;

              return {
                nameVal: document.getElementById('f-name').value,
                emailVal: document.getElementById('f-email').value,
                dobVal: document.getElementById('f-dob').value,
                stateVal: document.getElementById('f-state').value,
                ugChecked: document.getElementById('r-ug').checked,
                passVal: document.getElementById('f-password').value,
                otpVal: document.getElementById('f-otp').value,
                passBlocked: passRes && passRes.status === 'sensitive_skipped',
                otpBlocked: otpRes && otpRes.status === 'sensitive_skipped',
                afterRequestSubmitted,
                afterFirstConfirmSubmitted,
                afterSecondConfirmSubmitted
              };
            }""")
            assert form_result["nameVal"] == "Vatsal Kumar", form_result
            assert form_result["emailVal"] == "vatsal@gmail.com", form_result
            assert form_result["dobVal"] == "2004-08-15", form_result
            assert form_result["stateVal"] == "MH", form_result
            assert form_result["ugChecked"] is True, form_result
            assert form_result["passBlocked"] is True and form_result["passVal"] == "SecretDemoPass#987", form_result
            assert form_result["otpBlocked"] is True and form_result["otpVal"] == "482910", form_result
            assert form_result["afterRequestSubmitted"] == 0, "Submit fired without confirmation!"
            assert form_result["afterFirstConfirmSubmitted"] == 0, "Submit fired after only 1 confirmation (must require double confirm)!"
            assert form_result["afterSecondConfirmSubmitted"] == 1, "Submit did not fire after 2nd confirm!"
            print("PASS  Playwright Forms & Double Confirm: Text/Select/Radio/Date, Sensitive Skip & Submit Guard")

            # -----------------------------------------------------------------
            # Assertion 4: Fake file attaches cleanly via file-input AND dropzone paths
            # -----------------------------------------------------------------
            upload_result = page.evaluate("""async () => {
              const w = window.__SW_WIDGET__;
              // Photo file input path
              await w.handleUserInput('upload my passport photo', 'typed');
              const beforePickCount = document.getElementById('up-photo').files.length;
              const fakePhoto = new File(['jpegdata'], 'fake-photo.jpg', { type: 'image/jpeg' });
              const photoTarget = w.upload.detectUploadTargets(document).find((t) => t.inputElement && t.inputElement.id === 'up-photo');
              w.upload.handleSelectedFile(fakePhoto, photoTarget);
              const beforeFinalYesCount = document.getElementById('up-photo').files.length;
              await w.handleUserInput('yes', 'typed');
              const afterYesName = document.getElementById('up-photo').files[0] ? document.getElementById('up-photo').files[0].name : '';

              // Dropzone path (Income Certificate)
              await w.handleUserInput('upload my income certificate', 'typed');
              const fakePdf = new File(['%PDF-1.4'], 'income-proof.pdf', { type: 'application/pdf' });
              const incomeTarget = w.upload.detectUploadTargets(document).find((t) => t.inputElement && t.inputElement.id === 'up-income');
              w.upload.handleSelectedFile(fakePdf, incomeTarget);
              await w.handleUserInput('haan kar do', 'typed');

              return {
                beforePickCount,
                beforeFinalYesCount,
                afterYesName,
                dzStatusText: document.getElementById('dz-income-status').textContent,
                droppedNames: window.__demoPortalState.droppedFiles
              };
            }""")
            assert upload_result["beforePickCount"] == 0
            assert upload_result["beforeFinalYesCount"] == 0
            assert upload_result["afterYesName"] == "fake-photo.jpg", upload_result
            assert "income-proof.pdf" in upload_result["dzStatusText"], upload_result
            assert "income-proof.pdf" in upload_result["droppedNames"], upload_result
            print("PASS  Playwright File Upload: Fake file attached via file-input and dropzone ONLY after Final Yes")

            # -----------------------------------------------------------------
            # Assertion 5: Prism Glow active NEVER blocks clicks on page controls underneath
            # -----------------------------------------------------------------
            page.evaluate("""() => {
              window.__SW_WIDGET__.glow.setListening();
            }""")
            glow_info = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-host');
              const sr = window.__SW_WIDGET__.shadowRoot;
              const container = sr.getElementById('sw-glow-container');
              const ring = sr.getElementById('sw-glow-ring');
              return {
                hostPe: host ? window.getComputedStyle(host).pointerEvents : 'missing',
                containerPe: container ? window.getComputedStyle(container).pointerEvents : 'missing',
                ringPe: ring ? window.getComputedStyle(ring).pointerEvents : 'missing'
              };
            }""")
            assert glow_info["hostPe"] == "none", glow_info
            assert glow_info["containerPe"] == "none", glow_info
            assert glow_info["ringPe"] == "none", glow_info
            page.click("#btn-glow-underlay-check")
            underlay_clicks = page.evaluate("() => window.__demoPortalState.underlayClicks")
            assert underlay_clicks == 1, f"Glow blocked real click under overlay! clicks={underlay_clicks}"
            page.evaluate("""() => {
              window.__SW_WIDGET__.glow.setSpeaking();
            }""")
            page.click("#btn-glow-underlay-check")
            underlay_clicks_2 = page.evaluate("() => window.__demoPortalState.underlayClicks")
            assert underlay_clicks_2 == 2, f"Speaking glow blocked real click! clicks={underlay_clicks_2}"
            print("PASS  Playwright Prism Glow: pointer-events=none & underlying page clicks succeed while glow active")

            # -----------------------------------------------------------------
            # Assertion 6: Settings UI shows .env Gemini + Ollama defaults, Show/Hide reveals key, Load .env reloads
            # -----------------------------------------------------------------
            page.evaluate("""() => {
              window.__SW_WIDGET__.open();
              window.__SW_WIDGET__.switchTab('settings');
            }""")
            page.wait_for_function("""() => {
              const sr = window.__SW_WIDGET__.shadowRoot;
              const el = sr && sr.getElementById('sw-input-gemini-key');
              return Boolean(el && el.value === 'AIza_MOCK_ENV_KEY_1234');
            }""")
            settings_check = page.evaluate("""async () => {
              const sr = window.__SW_WIDGET__.shadowRoot;
              const keyEl = sr.getElementById('sw-input-gemini-key');
              const modelEl = sr.getElementById('sw-input-gemini-model');
              const ollamaUrlEl = sr.getElementById('sw-input-ollama-url');
              const ollamaModelEl = sr.getElementById('sw-input-ollama-model');
              const toggleBtn = sr.getElementById('sw-btn-toggle-gemini-key');
              const reloadBtn = sr.getElementById('sw-btn-reload-env');
              const hintEl = sr.getElementById('sw-env-status-hint');
              const statusEl = sr.getElementById('sw-ai-test-status');

              const initialType = keyEl.type;
              const initialBtnText = toggleBtn.textContent.trim();
              toggleBtn.click();
              const revealedType = keyEl.type;
              const revealedBtnText = toggleBtn.textContent.trim();
              const revealedPressed = toggleBtn.getAttribute('aria-pressed');
              toggleBtn.click();
              const rehiddenType = keyEl.type;

              keyEl.value = 'TEMP_USER_VALUE';
              reloadBtn.click();
              await new Promise((r) => setTimeout(r, 80));

              return {
                initialType,
                initialBtnText,
                revealedType,
                revealedBtnText,
                revealedPressed,
                rehiddenType,
                reloadedKey: keyEl.value,
                geminiModel: modelEl.value,
                ollamaUrl: ollamaUrlEl.value,
                ollamaModel: ollamaModelEl.value,
                hintText: hintEl ? hintEl.textContent : '',
                statusText: statusEl ? statusEl.textContent : ''
              };
            }""")
            assert settings_check["initialType"] == "password", settings_check
            assert settings_check["initialBtnText"] == "Show", settings_check
            assert settings_check["revealedType"] == "text", settings_check
            assert settings_check["revealedBtnText"] == "Hide", settings_check
            assert settings_check["revealedPressed"] == "true", settings_check
            assert settings_check["rehiddenType"] == "password", settings_check
            assert settings_check["reloadedKey"] == "AIza_MOCK_ENV_KEY_1234", settings_check
            assert settings_check["geminiModel"] == "gemini-2.5-flash-lite", settings_check
            assert settings_check["ollamaUrl"] == "http://localhost:11434", settings_check
            assert settings_check["ollamaModel"] == "llama3.2:3b", settings_check
            assert ".env active" in settings_check["hintText"], settings_check
            assert "Loaded .env" in settings_check["statusText"], settings_check
            print("PASS  Playwright Settings UI: .env Gemini + Ollama loaded, Show/Hide key toggle & Load .env work")

            browser.close()
    finally:
        server.shutdown()

    print("\nALL PLAYWRIGHT HEADLESS CHROMIUM E2E ASSERTIONS PASSED (6/6).")


if __name__ == "__main__":
    main()
