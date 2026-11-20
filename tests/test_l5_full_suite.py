r"""
Full Headless Chromium + Playwright L5 Verification Suite across 3 fixtures (Mock LLM):
1. Wikipedia-style disambiguation page ("The Tomorrow Show", "Tomorrow (time)", "To-Morrow (Chicago magazine)")
2. Government-style page (nav, "Fees" link, and multiple cards each with "Read more")
3. Icon-only links page (aria-label only)

Run with: python D:\sleep\tests\test_l5_full_suite.py
"""

import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

WIKI_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Tomorrow - Wikipedia Disambiguation</title></head>
<body>
  <main>
    <h1>Tomorrow</h1>
    <p id="body-secret">WIKI_BODY_TEXT_NEVER_LEAK Tomorrow may refer to several media programs and works.</p>
    <ul>
      <li><a id="wiki-tshow" href="/wiki/The_Tomorrow_Show?secretQuery=tok123" onclick="event.preventDefault(); window.__rec(this.id, 'The Tomorrow Show')">The Tomorrow Show</a>, a late-night talk television series</li>
      <li><a id="wiki-ttime" href="/wiki/Tomorrow_(time)" onclick="event.preventDefault(); window.__rec(this.id, 'Tomorrow (time)')">Tomorrow (time)</a>, the day after today</li>
      <li><a id="wiki-tmag" href="/wiki/To-Morrow_(Chicago_magazine)" onclick="event.preventDefault(); window.__rec(this.id, 'To-Morrow (Chicago magazine)')">To-Morrow (Chicago magazine)</a>, a 1905 periodical</li>
      <li><a id="wiki-abc" href="/wiki/ABC" onclick="event.preventDefault(); window.__rec(this.id, 'ABC')">ABC</a>, American Broadcasting Company</li>
      <li><a id="wiki-logout" href="/logout" onclick="event.preventDefault(); window.__rec(this.id, 'Log out')">Log out</a></li>
    </ul>
    <section aria-label="Hidden & Restricted">
      <input id="wiki-pw" type="password" value="WikiSecretPass" aria-label="Portal Password" onclick="window.__rec(this.id, 'Portal Password')">
      <a id="wiki-hidden" href="/secret-hidden" style="display:none" onclick="event.preventDefault(); window.__rec(this.id, 'Secret Hidden Link')">Secret Hidden Link</a>
      <button id="wiki-disabled" type="button" disabled onclick="window.__rec(this.id, 'Disabled Action')">Disabled Action</button>
    </section>
  </main>
  <script>window.__CLICKS = []; window.__rec = (id, label) => window.__CLICKS.push({ id, label, ts: Date.now() });</script>
</body>
</html>"""

GOV_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>National Citizen Portal</title>
<style>.card { border: 1px solid #999; padding: 10px; margin: 10px 0; }</style></head>
<body>
  <header>
    <nav aria-label="Main Menu">
      <a id="gov-home" href="#home" onclick="event.preventDefault(); window.__rec(this.id, 'Home')">Home</a>
      <a id="gov-fees" href="/fees-schedule" onclick="event.preventDefault(); window.__rec(this.id, 'Fees')">Fees</a>
      <a id="gov-pay" href="/pay-fees" onclick="event.preventDefault(); window.__rec(this.id, 'Pay Fees')">Pay Fees</a>
      <button id="gov-submit" type="submit" onclick="event.preventDefault(); window.__rec(this.id, 'Submit Application')">Submit Application</button>
    </nav>
  </header>
  <main>
    <p>GOV_BODY_TEXT_DO_NOT_LEAK Citizen welfare portal instructions.</p>
    <section class="card">
      <h2>Scholarships</h2>
      <p>Merit scholarship awards and college grant stipends for students.</p>
      <a id="card-schol-read" href="/scholarships" onclick="event.preventDefault(); window.__rec(this.id, 'Read more')">Read more</a>
    </section>
    <section class="card">
      <h2>Hostel Facilities</h2>
      <p>Campus dormitory rooms and dining mess rules.</p>
      <a id="card-hostel-read" href="/hostel" onclick="event.preventDefault(); window.__rec(this.id, 'Read more')">Read more</a>
    </section>
    <section class="card">
      <h2>Digital Library</h2>
      <p>Borrow journals and reference books online.</p>
      <a id="card-lib-read" href="/library" onclick="event.preventDefault(); window.__rec(this.id, 'Read more')">Read more</a>
    </section>
    <input id="gov-pw" type="password" value="GovSecretPin" aria-label="Security PIN" onclick="window.__rec(this.id, 'Security PIN')">
  </main>
  <script>window.__CLICKS = []; window.__rec = (id, label) => window.__CLICKS.push({ id, label, ts: Date.now() });</script>
</body>
</html>"""

ICONS_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Icon Only Controls</title></head>
<body>
  <main>
    <p>Icon toolbar without visible link text.</p>
    <a id="icon-home" href="#dash" aria-label="Dashboard Home" style="display:inline-flex;width:44px;height:44px;" onclick="event.preventDefault(); window.__rec(this.id, 'Dashboard Home')"><svg width="24" height="24"></svg></a>
    <button id="icon-help" type="button" aria-label="Open Help Desk" style="display:inline-flex;width:44px;height:44px;" onclick="window.__rec(this.id, 'Open Help Desk')"><svg width="24" height="24"></svg></button>
    <a id="icon-settings" href="#settings" aria-label="Account Settings" style="display:inline-flex;width:44px;height:44px;" onclick="event.preventDefault(); window.__rec(this.id, 'Account Settings')"><svg width="24" height="24"></svg></a>
  </main>
  <script>window.__CLICKS = []; window.__rec = (id, label) => window.__CLICKS.push({ id, label, ts: Date.now() });</script>
</body>
</html>"""


def make_handler(root_dir: Path, llm_requests: list, pick_cache: dict):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root_dir), **kwargs)

        def log_message(self, format, *args):
            return

        def do_GET(self):
            p = urlparse(self.path).path
            html = {"/wiki.html": WIKI_HTML, "/gov.html": GOV_HTML, "/icons.html": ICONS_HTML}.get(p)
            if html is not None:
                data = html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            super().do_GET()

        def do_POST(self):
            p = urlparse(self.path).path
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8", errors="replace") or "{}")

            if p == "/mock-pick-link":
                key = f"{body.get('pageHash', '')}::{str(body.get('spokenText', '')).lower()}"
                if key in pick_cache:
                    reply = {**pick_cache[key], "cached": True}
                else:
                    llm_requests.append(body)
                    spoken = str(body.get("spokenText", "")).lower()
                    cands = body.get("candidates") or []
                    reply = {"status": "ok", "action": "NONE", "id": None, "confidence": 0.1, "source": "mock-llm"}
                    if "talk host" in spoken or "late night television broadcast" in spoken:
                        for c in cands:
                            if "tomorrow show" in str(c.get("label", "")).lower():
                                reply = {"status": "ok", "action": "CLICK", "id": c["id"], "confidence": 0.91, "source": "mock-llm"}
                                break
                    elif "uncertain guess" in spoken:
                        if cands:
                            reply = {"status": "ok", "action": "CLICK", "id": cands[0]["id"], "confidence": 0.30, "source": "mock-llm"}
                    pick_cache[key] = reply
            elif p == "/mock-llm":
                llm_requests.append(body)
                reply = {"status": "ok", "intent": "ANSWER", "args": {"query": body.get("text", "")}, "confidence": 0.4, "source": "mock-llm"}
            else:
                self.send_response(404)
                self.end_headers()
                return

            raw = json.dumps(reply).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    return Handler


def main():
    llm_requests = []
    pick_cache = {}
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(ROOT, llm_requests, pick_cache))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    css_text = (ROOT / "widget.css").read_text(encoding="utf-8")
    lexicon_data = json.loads((ROOT / "lexicon.json").read_text(encoding="utf-8"))
    link_lexicon = json.loads((ROOT / "link-lexicon.json").read_text(encoding="utf-8"))
    script_names = [
        "reader.js", "outline.js", "voice.js", "pill.js", "glow.js", "digest.js",
        "explain.js", "confirm.js", "link-index.js", "match.js", "link-intent.js",
        "intent.js", "navigate.js", "form-index.js", "form-fill.js", "forms.js", "upload.js", "dialogue.js", "widget.js",
    ]

    passed = 0
    total = 0

    def record(name, fn):
        nonlocal passed, total
        total += 1
        fn()
        passed += 1
        print(f"PASS  {name}")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})

            def load_fixture(path_name):
                page.goto(f"http://127.0.0.1:{port}{path_name}", wait_until="load")
                page.evaluate("""(css) => {
                  window.chrome = {
                    runtime: {
                      lastError: null,
                      getURL: (u) => location.origin + '/' + String(u).replace(/^\\/+/, ''),
                      sendMessage: (msg, cb) => {
                        if (!msg || typeof cb !== 'function') return;
                        if (msg.type === 'SLEEPWALKER_PICK_LINK_REQUEST') {
                          fetch('/mock-pick-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg.payload || {}) })
                            .then((r) => r.json()).then(cb).catch(() => cb({ status: 'unavailable', action: 'NONE', id: null, confidence: 0 }));
                        } else if (msg.type === 'SLEEPWALKER_INTENT_REQUEST') {
                          fetch('/mock-llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'intent', ...(msg.payload || {}) }) })
                            .then((r) => r.json()).then(cb).catch(() => cb(null));
                        } else {
                          cb({ status: 'ok' });
                        }
                      },
                      onMessage: { addListener: () => {} }
                    },
                    storage: {
                      local: { get: (_k, cb) => cb({ sleepwalker_proxy_url: location.origin + '/mock-llm', sleepwalker_local_only: false }), set: (_o, cb) => cb && cb() },
                      session: { get: (_k, cb) => cb({}), set: (_o, cb) => cb && cb() }
                    }
                  };
                  window.__SW_TEST_CSS__ = css;
                }""", css_text)
                for sname in script_names:
                    page.add_script_tag(url=f"http://127.0.0.1:{port}/{sname}")
                page.evaluate("([lex, llex]) => { window.__L1 = lex; window.__L2 = llex; const w = new window.SleepwalkerWidget(); window.__SW_WIDGET__ = w; w.init().then(() => { const st = document.createElement('style'); st.textContent = window.__SW_TEST_CSS__; w.shadowRoot.prepend(st); }); }", [lexicon_data, link_lexicon])
                page.wait_for_function("() => window.__SW_WIDGET__ && window.__SW_WIDGET__.shadowRoot && window.__SW_WIDGET__.navigator && window.__SW_WIDGET__.intentEngine.lexicon")
                page.evaluate("() => { window.__SW_WIDGET__.intentEngine.lexicon = window.__L1; if (window.__SW_WIDGET__.intentEngine) window.__SW_WIDGET__.navigator.highlightDurationMs = 70; }")

            # === FIXTURE 1: Wikipedia Disambiguation ===
            load_fixture("/wiki.html")
            llm_requests.clear()

            def run_and_expect_click(phrase, expected_id):
                page.evaluate("() => { window.__CLICKS = []; }")
                page.evaluate("(p) => window.__SW_WIDGET__.handleUserInput(p, 'voice')", phrase)
                page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
                assert page.evaluate("() => window.__CLICKS[0].id") == expected_id, f"{phrase} -> {page.evaluate('() => window.__CLICKS[0]')}"

            record("'टुमारो शो' opens The Tomorrow Show (0 LLM)", lambda: run_and_expect_click("टुमारो शो", "wiki-tshow"))
            record("'tomorrow show kholo' opens The Tomorrow Show (0 LLM)", lambda: run_and_expect_click("tomorrow show kholo", "wiki-tshow"))
            record("'find link tomorrow show and click it' opens The Tomorrow Show (0 LLM)", lambda: run_and_expect_click("find link tomorrow show and click it", "wiki-tshow"))
            record("'a b c' and 'ए बी सी' click ABC (0 LLM)", lambda: (run_and_expect_click("a b c", "wiki-abc"), run_and_expect_click("ए बी सी", "wiki-abc")))

            def test_tomorrow_numbered():
                page.evaluate("() => { window.__CLICKS = []; }")
                page.evaluate("() => window.__SW_WIDGET__.handleUserInput('tomorrow', 'voice')")
                page.wait_for_timeout(50)
                assert page.evaluate("() => window.__CLICKS.length") == 0
                assert page.evaluate("() => window.__SW_WIDGET__.confirm.isAwaiting()")
                run_and_expect_click("number 2", "wiki-ttime")
            record("'tomorrow' alone asks numbered question; 'number 2' clicks second (0 LLM)", test_tomorrow_numbered)

            def test_dom_rebuild():
                page.evaluate("""() => {
                  const a = document.createElement('a');
                  a.id = 'wiki-dynamic';
                  a.href = '#gazette';
                  a.textContent = 'Late Added Gazette';
                  a.onclick = (e) => { e.preventDefault(); window.__rec(a.id, a.textContent); };
                  document.querySelector('ul').appendChild(a);
                }""")
                run_and_expect_click("open late added gazette", "wiki-dynamic")
            record("Index rebuilds cleanly after DOM changes", test_dom_rebuild)

            assert len(llm_requests) == 0, f"Expected ZERO network/LLM requests for rule hits, got {llm_requests}"
            record("Zero LLM network requests made across all deterministic/phonetic tests", lambda: None)

            def test_skips_and_risk():
                for bad in ["open Portal Password", "open Secret Hidden Link", "open Disabled Action"]:
                    page.evaluate("() => { window.__CLICKS = []; }")
                    page.evaluate("(p) => window.__SW_WIDGET__.handleUserInput(p, 'voice')", bad)
                    page.wait_for_timeout(120)
                    assert page.evaluate("() => window.__CLICKS.length") == 0, bad
                # Verify password/hidden/disabled labels NEVER entered any candidate list sent to LLM
                dump_after_skips = json.dumps(llm_requests)
                for forbidden in ["WikiSecretPass", "Portal Password", "Secret Hidden Link", "Disabled Action"]:
                    assert forbidden not in dump_after_skips, f"Forbidden label {forbidden} leaked!"
                llm_requests.clear()
                pick_cache.clear()
                page.evaluate("() => { window.__CLICKS = []; window.__SW_WIDGET__.handleUserInput('open Log out', 'voice'); }")
                page.wait_for_timeout(60)
                assert page.evaluate("() => window.__CLICKS.length") == 0 and page.evaluate("() => window.__SW_WIDGET__.confirm.isAwaiting()")
                page.evaluate("() => window.__SW_WIDGET__.handleUserInput('yes', 'voice')")
                page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
                assert page.evaluate("() => window.__CLICKS[0].id") == "wiki-logout"
                assert len(llm_requests) == 0
            record("Hidden, disabled, and password never clicked or leaked; risky Log out asks first", test_skips_and_risk)

            # LLM fallback tests (privacy + <=15 + context<=40 + cache + low-conf fallback)
            def test_llm_fallback():
                page.evaluate("() => { window.__CLICKS = []; }")
                page.evaluate("() => window.__SW_WIDGET__.handleUserInput('open talk host', 'voice')")
                page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
                assert page.evaluate("() => window.__CLICKS[0].id") == "wiki-tshow"
                assert len(llm_requests) == 1
                req = llm_requests[0]
                dump = json.dumps(req)
                assert "WIKI_BODY_TEXT_NEVER_LEAK" not in dump
                assert "WikiSecretPass" not in dump
                assert "secretQuery" not in dump and "tok123" not in dump
                assert 1 <= len(req["candidates"]) <= 15
                for c in req["candidates"]:
                    assert len(str(c.get("context", ""))) <= 40

                # Identical utterance on same page hits (pageHash, utterance) cache -> still 1 network request
                page.evaluate("() => { window.__CLICKS = []; }")
                page.evaluate("() => window.__SW_WIDGET__.handleUserInput('open talk host', 'voice')")
                page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
                assert len(llm_requests) == 1, f"Expected cache hit, got {len(llm_requests)} requests"

                # Low confidence LLM response -> falls back to numbered question instead of guessing
                page.evaluate("() => { window.__CLICKS = []; }")
                page.evaluate("() => window.__SW_WIDGET__.handleUserInput('open uncertain guess', 'voice')")
                page.wait_for_timeout(120)
                assert page.evaluate("() => window.__CLICKS.length") == 0
                assert page.evaluate("() => window.__SW_WIDGET__.confirm.isAwaiting()")
                page.evaluate("() => window.__SW_WIDGET__.handleUserInput('cancel', 'voice')")
            record("L5 LLM fallback enforces privacy/context<=40, cache, and low-conf numbered fallback", test_llm_fallback)

            # === FIXTURE 2: Government Page ===
            load_fixture("/gov.html")
            before_gov_reqs = len(llm_requests)

            record("'I want more info on scholarships' clicks Scholarships 'Read more'", lambda: run_and_expect_click("I want more info on scholarships", "card-schol-read"))
            record("Government nav 'Fees' & 'first link in menu' click accurately", lambda: (run_and_expect_click("open Fees", "gov-fees"), run_and_expect_click("the first link in the menu", "gov-home")))

            def test_gov_risky():
                page.evaluate("() => { window.__CLICKS = []; window.__SW_WIDGET__.handleUserInput('open Pay Fees', 'voice'); }")
                page.wait_for_timeout(60)
                assert page.evaluate("() => window.__CLICKS.length") == 0 and page.evaluate("() => window.__SW_WIDGET__.confirm.isAwaiting()")
                page.evaluate("() => window.__SW_WIDGET__.handleUserInput('yes', 'voice')")
                page.wait_for_timeout(50)
                page.evaluate("() => window.__SW_WIDGET__.handleUserInput('haan', 'voice')")
                page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
                assert page.evaluate("() => window.__CLICKS[0].id") == "gov-pay"
            record("Government risky link ('Pay Fees') requires confirmation before click", test_gov_risky)
            assert len(llm_requests) == before_gov_reqs

            # === FIXTURE 3: Icon-Only aria-label Page ===
            load_fixture("/icons.html")
            before_icon_reqs = len(llm_requests)
            record("Icon-only aria-label links ('Dashboard Home', 'ओपन हेल्प डेस्क', 'Account Settings') click via voice", lambda: (
                run_and_expect_click("open Dashboard Home", "icon-home"),
                run_and_expect_click("ओपन हेल्प डेस्क", "icon-help"),
                run_and_expect_click("Account Settings kholo", "icon-settings")
            ))
            assert len(llm_requests) == before_icon_reqs

            browser.close()
    finally:
        server.shutdown()

    pct = (passed / total) * 100 if total else 0.0
    print(f"\nL5 Full Playwright Suite Pass Rate: {passed}/{total} ({pct:.1f}%)")


if __name__ == "__main__":
    main()
