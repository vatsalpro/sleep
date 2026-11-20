"""
Headless Chromium + Playwright verification for cross-script phonetic nav,
<=150-token LLM link-pick fallback, and FIX 3 UI checks.
Run with: python tests/test_bugfix_nav.py
"""

import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

EXTRA_20_LINKS = [
    ("विकिपीडिया", "Wikipedia"),
    ("क्रिकेट", "Cricket"),
    ("टेलीविजन", "Television"),
    ("सर्च", "Search"),
    ("लाइब्रेरी", "Library"),
    ("सेटिंग्स", "Settings"),
    ("प्रोफाइल", "Profile"),
    ("हिस्ट्री", "History"),
    ("साइंस", "Science"),
    ("टेक्नोलॉजी", "Technology"),
    ("फोटोग्राफी", "Photography"),
    ("कंप्यूटर", "Computer"),
    ("यूनिवर्सिटी", "University"),
    ("फुटबॉल", "Football"),
    ("हॉस्पिटल", "Hospital"),
    ("गवर्नमेंट", "Government"),
    ("स्कॉलरशिप", "Scholarship"),
    ("डॉक्यूमेंट", "Document"),
    ("नेक्स्ट पेज", "Next Page"),
    ("कॉन्टैक्ट अस", "Contact Us"),
]


def build_fixture_html():
    extra_html = "\n".join(
        f'<li><a id="extra-{idx}" href="#extra-{idx}" onclick="event.preventDefault(); window.__recordClick(this.id, this.textContent)">{label}</a></li>'
        for idx, (_, label) in enumerate(EXTRA_20_LINKS)
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Tomorrow Show - Fixture</title></head>
<body>
  <main>
    <h1>Wikipedia Disambiguation Fixture</h1>
    <p id="body-sentinel">UNIQUE_BODY_SECRET_TEXT_998877 Sleepwalker page paragraph for explain & read checks. Never send this body text to link-pick LLM.</p>
    <p>Second readable sentence for speech synthesis and stop button state verification.</p>
    <ul id="fixture-links">
      <li><a id="link-tomorrow-show" href="#tomorrow-show" onclick="event.preventDefault(); window.__recordClick(this.id, this.textContent)">The Tomorrow Show</a></li>
      <li><a id="link-tomorrow-time" href="#tomorrow-time" onclick="event.preventDefault(); window.__recordClick(this.id, this.textContent)">Tomorrow (time)</a></li>
      <li><a id="link-tomorrow-mag" href="#tomorrow-mag" onclick="event.preventDefault(); window.__recordClick(this.id, this.textContent)">To-Morrow (Chicago magazine)</a></li>
    </ul>
    <ul id="extra-links">
      {extra_html}
    </ul>
    <section aria-label="Security & Hidden Elements">
      <input id="pw-secret" type="password" value="SecretPass#999" aria-label="Portal Password" onclick="window.__recordClick(this.id, 'Portal Password')">
      <a id="hidden-display" href="#h1" style="display:none" onclick="event.preventDefault(); window.__recordClick(this.id, this.textContent)">Secret Vault Entry</a>
      <a id="hidden-attr" href="#h2" hidden onclick="event.preventDefault(); window.__recordClick(this.id, this.textContent)">Hidden Archive Door</a>
      <button id="hidden-aria" type="button" aria-hidden="true" onclick="window.__recordClick(this.id, this.textContent)">Invisible Admin Button</button>
    </section>
  </main>
  <script>
    window.__CLICK_LOG = [];
    window.__recordClick = function(id, label) {{
      window.__CLICK_LOG.push({{ id, label: String(label || '').trim(), ts: Date.now() }});
    }};
  </script>
</body>
</html>"""


def make_handler(root_dir: Path, captured_pick_requests: list, fixture_html: str):
    class FixtureHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root_dir), **kwargs)

        def log_message(self, format, *args):
            return

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/fixture.html":
                data = fixture_html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            super().do_GET()

        def do_POST(self):
            parsed = urlparse(self.path)
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8", errors="replace")
            try:
                body = json.loads(raw_body)
            except Exception:
                body = {"raw": raw_body}

            if parsed.path == "/mock-pick-link":
                captured_pick_requests.append(body)
                spoken = str(body.get("spokenText", "")).lower()
                cands = body.get("candidates") or []
                reply = {"status": "ok", "id": None, "confidence": 0.1, "source": "mock-pick-llm"}
                if "late night broadcast" in spoken or "television" in spoken:
                    for c in cands:
                        if str(c.get("label", "")).lower() == "television":
                            reply = {"status": "ok", "id": c["id"], "confidence": 0.92, "source": "mock-pick-llm"}
                            break
                payload = json.dumps(reply).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            if parsed.path == "/mock-llm":
                if body.get("kind") == "intent":
                    reply = {"status": "ok", "intent": "ANSWER", "args": {"query": body.get("text", "")}, "confidence": 0.85}
                else:
                    reply = {
                        "status": "ok",
                        "source": "mock-llm",
                        "answer": "Wikipedia Disambiguation Fixture lists The Tomorrow Show and related links.",
                    }
                payload = json.dumps(reply).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            self.send_response(404)
            self.end_headers()

    return FixtureHandler


def main():
    captured_pick_requests = []
    fixture_html = build_fixture_html()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(ROOT, captured_pick_requests, fixture_html))
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    css_text = (ROOT / "widget.css").read_text(encoding="utf-8")
    lexicon_data = json.loads((ROOT / "lexicon.json").read_text(encoding="utf-8"))
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
            context = browser.new_context(viewport={"width": 1280, "height": 720})
            page = context.new_page()

            init_shim = f"""
            (() => {{
              const localStore = {{
                sleepwalker_proxy_url: "http://127.0.0.1:{port}/mock-llm",
                sleepwalker_gemini_api_key: "",
                sleepwalker_local_only: false
              }};
              window.__SW_TEST_CSS__ = {json.dumps(css_text)};
              window.chrome = {{
                runtime: {{
                  lastError: null,
                  getURL: (p) => `http://127.0.0.1:{port}/` + String(p).replace(/^\\/+/, ""),
                  sendMessage: (msg, cb) => {{
                    if (!msg || typeof cb !== "function") return;
                    if (msg.type === "SLEEPWALKER_PICK_LINK_REQUEST") {{
                      fetch(`http://127.0.0.1:{port}/mock-pick-link`, {{
                        method: "POST",
                        headers: {{ "Content-Type": "application/json" }},
                        body: JSON.stringify(msg.payload || {{}})
                      }})
                        .then((r) => r.json())
                        .then((data) => cb(data))
                        .catch(() => cb({{ status: "unavailable", id: null, confidence: 0 }}));
                    }} else if (msg.type === "SLEEPWALKER_EXPLAIN_REQUEST") {{
                      setTimeout(() => {{
                        fetch(`http://127.0.0.1:{port}/mock-llm`, {{
                          method: "POST",
                          headers: {{ "Content-Type": "application/json" }},
                          body: JSON.stringify({{ kind: "explain", ...(msg.payload || {{}}) }})
                        }})
                          .then((r) => r.json())
                          .then((data) => cb(data))
                          .catch((err) => cb({{ status: "fallback", error: err.message }}));
                      }}, 250);
                    }} else if (msg.type === "SLEEPWALKER_INTENT_REQUEST") {{
                      fetch(`http://127.0.0.1:{port}/mock-llm`, {{
                        method: "POST",
                        headers: {{ "Content-Type": "application/json" }},
                        body: JSON.stringify({{ kind: "intent", ...(msg.payload || {{}}) }})
                      }})
                        .then((r) => r.json())
                        .then((data) => cb(data))
                        .catch(() => cb(null));
                    }} else if (msg.type === "SLEEPWALKER_GET_ENV_DEFAULTS") {{
                      cb({{ status: "ok", envLoaded: false }});
                    }} else {{
                      cb({{ status: "ok" }});
                    }}
                  }},
                  onMessage: {{ addListener: () => {{}} }}
                }},
                storage: {{
                  local: {{
                    get: (_k, cb) => typeof cb === "function" && cb({{ ...localStore }}),
                    set: (obj, cb) => {{ Object.assign(localStore, obj || {{}}); if (typeof cb === "function") cb(); }}
                  }},
                  session: {{
                    get: (_k, cb) => typeof cb === "function" && cb({{}}),
                    set: (_o, cb) => typeof cb === "function" && cb()
                  }}
                }}
              }};
            }})();
            """
            page.add_init_script(init_shim)
            page.goto(f"http://127.0.0.1:{port}/fixture.html", wait_until="domcontentloaded")
            for sname in script_names:
                page.add_script_tag(url=f"http://127.0.0.1:{port}/{sname}")

            page.evaluate("""() => {
              const w = new window.SleepwalkerWidget();
              window.__SW_WIDGET__ = w;
              w.init().then(() => {
                const styleEl = document.createElement('style');
                styleEl.textContent = window.__SW_TEST_CSS__;
                w.shadowRoot.prepend(styleEl);
              });
            }""")
            page.wait_for_function("() => window.__SW_WIDGET__ && window.__SW_WIDGET__.shadowRoot && window.__SW_WIDGET__.navigator && window.__SW_WIDGET__.pill && window.__SW_WIDGET__.intentEngine.lexicon")
            page.evaluate("(lex) => { window.__SW_WIDGET__.intentEngine.lexicon = lex; }", lexicon_data)

            # 1. "टुमारो शो" -> highlights 1s (~1000ms), does NOT click early, then clicks "The Tomorrow Show"
            t0 = page.evaluate("""async () => {
              window.__CLICK_LOG = [];
              const start = Date.now();
              await window.__SW_WIDGET__.handleUserInput('टुमारो शो', 'voice');
              return start;
            }""")
            page.wait_for_timeout(450)
            early = page.evaluate("() => window.__CLICK_LOG.length")
            assert early == 0, f"Must highlight ~1s BEFORE clicking! Clicked early ({early})"
            page.wait_for_function("() => window.__CLICK_LOG.length === 1", timeout=4000)
            click1 = page.evaluate("() => window.__CLICK_LOG[0]")
            assert click1["id"] == "link-tomorrow-show", click1
            elapsed = click1["ts"] - t0
            assert elapsed >= 850, f"Highlight wait should be ~1s, got {elapsed}ms"
            print(f"PASS  'टुमारो शो' highlighted {elapsed}ms then clicked 'The Tomorrow Show'")

            # Accelerate highlight for remaining bulk link tests while still async highlight->click
            page.evaluate("() => { window.__SW_WIDGET__.navigator.highlightDurationMs = 80; }")

            # 2. "tomorrow show kholo", "tomorrow show ko open karo", "tomorrow time link kholo"
            for cmd, expected_id in [
                ("tomorrow show kholo", "link-tomorrow-show"),
                ("tomorrow show ko open karo", "link-tomorrow-show"),
                ("tomorrow time link kholo", "link-tomorrow-time"),
            ]:
                page.evaluate("() => { window.__CLICK_LOG = []; }")
                page.evaluate("(c) => window.__SW_WIDGET__.handleUserInput(c, 'voice')", cmd)
                page.wait_for_function("() => window.__CLICK_LOG.length === 1", timeout=3000)
                hit = page.evaluate("() => window.__CLICK_LOG[0]")
                assert hit["id"] == expected_id, f"{cmd} -> {hit}"
            print("PASS  'tomorrow show kholo', 'tomorrow show ko open karo' & 'tomorrow time link kholo'")

            # 3. "टुमारो" alone -> ambiguous numbered list (max 5), then "1", "ek", "एक", "one", "number 3", "teen number", "तीसरा"
            for reply_text, expected_id in [
                ("1", "link-tomorrow-show"),
                ("ek", "link-tomorrow-show"),
                ("एक", "link-tomorrow-show"),
                ("one", "link-tomorrow-show"),
                ("number 3", "link-tomorrow-mag"),
                ("teen number", "link-tomorrow-mag"),
                ("तीसरा", "link-tomorrow-mag"),
            ]:
                page.evaluate("() => { window.__CLICK_LOG = []; }")
                ask = page.evaluate("""async () => {
                  await window.__SW_WIDGET__.handleUserInput('टुमारो', 'voice');
                  return {
                    clicks: window.__CLICK_LOG.length,
                    pendingLen: window.__SW_WIDGET__.navigator.pendingChoices ? window.__SW_WIDGET__.navigator.pendingChoices.length : 0,
                    confirmPending: Boolean(window.__SW_WIDGET__.confirm.pending && window.__SW_WIDGET__.confirm.pending.options),
                    bubbleStatus: (window.__SW_WIDGET__.pill.statusText ? window.__SW_WIDGET__.pill.statusText.textContent : '') + ' ' +
                                  (window.__SW_WIDGET__.pill.confirmCard ? window.__SW_WIDGET__.pill.confirmCard.textContent : '')
                  };
                }""")
                assert ask["clicks"] == 0, ask
                assert ask["confirmPending"] and 2 <= ask["pendingLen"] <= 5, ask
                assert "1." in ask["bubbleStatus"] and "2." in ask["bubbleStatus"], ask
                page.evaluate("(r) => window.__SW_WIDGET__.handleUserInput(r, 'voice')", reply_text)
                page.wait_for_function("() => window.__CLICK_LOG.length === 1", timeout=3000)
                picked = page.evaluate("() => window.__CLICK_LOG[0]")
                assert picked["id"] == expected_id, f"{reply_text} -> {picked}"
            print("PASS  'टुमारो' alone shows numbered list (max 5) and resolves 1/ek/एक/one & number 3/teen number/तीसरा")

            # 4. Unrelated text -> no click, says what was heard & 3 nearest labels; + FIX 2 LLM fallback privacy/tokens
            captured_pick_requests.clear()
            no_match = page.evaluate("""async () => {
              window.__CLICK_LOG = [];
              await window.__SW_WIDGET__.handleUserInput('open banana potato', 'voice');
              return {
                clicks: window.__CLICK_LOG.length,
                reply: window.__SW_WIDGET__.pill.statusText ? window.__SW_WIDGET__.pill.statusText.textContent : ''
              };
            }""")
            assert no_match["clicks"] == 0, no_match
            assert "banana potato" in no_match["reply"].lower() and "1." in no_match["reply"] and "3." in no_match["reply"], no_match
            assert len(captured_pick_requests) == 1, captured_pick_requests
            req_dump = json.dumps(captured_pick_requests[0])
            assert "UNIQUE_BODY_SECRET_TEXT_998877" not in req_dump
            assert "SecretPass#999" not in req_dump
            assert len(captured_pick_requests[0]["candidates"]) <= 15

            # Valid LLM pick fallback when user speaks English paraphrase that has no phonetic match
            page.evaluate("() => { window.__CLICK_LOG = []; }")
            page.evaluate("() => window.__SW_WIDGET__.handleUserInput('open late night broadcast', 'voice')")
            page.wait_for_function("() => window.__CLICK_LOG.length === 1", timeout=3000)
            llm_hit = page.evaluate("() => window.__CLICK_LOG[0]")
            assert llm_hit["label"] == "Television", llm_hit
            print("PASS  Unrelated text -> no click + heard + 3 nearest; FIX 2 LLM fallback respects <=15 & privacy")

            # 5. Never click password inputs or hidden links
            for forbidden in ["open portal password", "open secret vault entry", "open hidden archive door", "open invisible admin button"]:
                page.evaluate("() => { window.__CLICK_LOG = []; }")
                page.evaluate("(c) => window.__SW_WIDGET__.handleUserInput(c, 'voice')", forbidden)
                page.wait_for_timeout(180)
                cnt = page.evaluate("() => window.__CLICK_LOG.length")
                assert cnt == 0, f"Forbidden element clicked for {forbidden}!"
            print("PASS  Password inputs & hidden/aria-hidden elements are NEVER clicked")

            # 6. All 20 additional Devanagari-rendered English link names click correctly
            for idx, (dev, latin) in enumerate(EXTRA_20_LINKS):
                page.evaluate("() => { window.__CLICK_LOG = []; }")
                page.evaluate("(c) => window.__SW_WIDGET__.handleUserInput(c, 'voice')", dev)
                page.wait_for_function("() => window.__CLICK_LOG.length === 1", timeout=3000)
                hit = page.evaluate("() => window.__CLICK_LOG[0]")
                assert hit["id"] == f"extra-{idx}" and hit["label"] == latin, f"{dev} -> {hit} (expected {latin})"
            print(f"PASS  All {len(EXTRA_20_LINKS)} Devanagari-rendered English links resolved and clicked accurately")

            # 7. FIX 3 UI: Pill <-> Side Panel mutual visibility + Stop Reading only during read/explain + Viewport fit
            ui_idle = page.evaluate("""() => {
              const sr = window.__SW_WIDGET__.shadowRoot;
              const pill = sr.getElementById('sw-pill-container');
              const pillStop = sr.getElementById('sw-pill-btn-stop');
              const panelStop = sr.getElementById('sw-btn-stop');
              return {
                pillDisplay: getComputedStyle(pill).display,
                pillStopDisplay: getComputedStyle(pillStop).display,
                panelStopDisplay: getComputedStyle(panelStop).display
              };
            }""")
            assert ui_idle["pillDisplay"] != "none", ui_idle
            assert ui_idle["pillStopDisplay"] == "none" and ui_idle["panelStopDisplay"] == "none", ui_idle

            # While explaining -> Stop Reading becomes visible
            page.evaluate("() => { window.__SW_WIDGET__.explainPage({ mode: 'summary', lang: 'en-IN' }); }")
            page.wait_for_timeout(60)
            stop_while_explaining = page.evaluate("""() => {
              const sr = window.__SW_WIDGET__.shadowRoot;
              return {
                pillStop: getComputedStyle(sr.getElementById('sw-pill-btn-stop')).display,
                panelStop: getComputedStyle(sr.getElementById('sw-btn-stop')).display
              };
            }""")
            assert stop_while_explaining["pillStop"] != "none" and stop_while_explaining["panelStop"] != "none", stop_while_explaining

            page.evaluate("() => { window.__SW_WIDGET__.stopReading(); }")
            page.wait_for_timeout(40)
            stop_after_stop = page.evaluate("""() => {
              const sr = window.__SW_WIDGET__.shadowRoot;
              return {
                pillStop: getComputedStyle(sr.getElementById('sw-pill-btn-stop')).display,
                panelStop: getComputedStyle(sr.getElementById('sw-btn-stop')).display
              };
            }""")
            assert stop_after_stop["pillStop"] == "none" and stop_after_stop["panelStop"] == "none", stop_after_stop

            # Open side panel -> Pill hides; test viewport fit at 1280x720, 1024x600, 400x620
            page.evaluate("() => { window.__SW_WIDGET__.open(); }")
            page.wait_for_timeout(320)
            pill_when_open = page.evaluate("() => getComputedStyle(window.__SW_WIDGET__.shadowRoot.getElementById('sw-pill-container')).display")
            assert pill_when_open == "none", f"Pill must be hidden while side panel open, got {pill_when_open}"

            for vw, vh in [(1280, 720), (1024, 600), (400, 620)]:
                page.set_viewport_size({"width": vw, "height": vh})
                page.wait_for_timeout(120)
                boxes = page.evaluate("""() => {
                  const sr = window.__SW_WIDGET__.shadowRoot;
                  const panel = sr.getElementById('sw-panel').getBoundingClientRect();
                  const closeBtn = sr.getElementById('sw-btn-close').getBoundingClientRect();
                  const tabs = Array.from(sr.querySelectorAll('.sw-tab-btn')).map((b) => ({
                    tab: b.dataset.tab,
                    r: b.getBoundingClientRect().toJSON()
                  }));
                  return { panel: panel.toJSON(), closeBtn: closeBtn.toJSON(), tabs, vw: window.innerWidth, vh: window.innerHeight };
                }""")
                for name, r in [("panel", boxes["panel"]), ("closeBtn", boxes["closeBtn"])] + [(f"tab-{t['tab']}", t["r"]) for t in boxes["tabs"]]:
                    assert r["width"] > 0 and r["height"] > 0, (vw, vh, name, r)
                    assert r["left"] >= -1 and r["top"] >= -1 and r["right"] <= boxes["vw"] + 1 and r["bottom"] <= boxes["vh"] + 1, (vw, vh, name, r)

            page.evaluate("() => { window.__SW_WIDGET__.close(); }")
            page.wait_for_timeout(320)
            pill_after_close = page.evaluate("() => getComputedStyle(window.__SW_WIDGET__.shadowRoot.getElementById('sw-pill-container')).display")
            assert pill_after_close != "none", f"Pill must show when side panel closes, got {pill_after_close}"
            print("PASS  FIX 3 UI: Pill <-> Panel toggle, Stop Reading visibility & viewport fit (1280x720, 1024x600, 400x620)")

            browser.close()
    finally:
        server.shutdown()

    print("\nALL BUGFIX PLAYWRIGHT TESTS PASSED.")


if __name__ == "__main__":
    main()
