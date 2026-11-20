"""
Headless Chromium + Playwright verification for Phase L4 (acting, 1s highlight, confirmations,
FIND / LIST / MORE_INFO / CHOOSE / CANCEL, pointer fallback, and session state across reloads).
Run with: python tests/test_l4_acting.py
"""

import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

FIXTURE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sleepwalker L4 Acting Fixture</title>
  <style>.card { border: 1px solid #aaa; padding: 10px; margin: 10px 0; }</style>
</head>
<body>
  <header>
    <nav aria-label="Main Menu">
      <a id="nav-home" href="#home" onclick="event.preventDefault(); window.__rec(this.id, 'Home')">Home</a>
      <a id="nav-fees" href="#fees" onclick="event.preventDefault(); window.__rec(this.id, 'Fees')">Fees</a>
      <a id="nav-logout" href="#logout" onclick="event.preventDefault(); window.__rec(this.id, 'Log out')">Log out</a>
    </nav>
    <a id="top-signin" href="#signin" style="position:absolute;top:8px;right:16px;" onclick="event.preventDefault(); window.__rec(this.id, 'Sign In')">Sign In</a>
  </header>

  <main>
    <p>Main page guide describing hostel mess menus and library hours only.</p>
    <section class="card">
      <h2>Scholarships</h2>
      <p>Apply for merit scholarship grants and tuition waivers.</p>
      <a id="card-schol-more" href="#schol-details" onclick="event.preventDefault(); window.__rec(this.id, 'Read more')">Read more</a>
    </section>
    <section class="card">
      <h2>Hostel Facilities</h2>
      <p>Campus rooms and dining information.</p>
      <a id="card-hostel-more" href="#hostel-details" onclick="event.preventDefault(); window.__rec(this.id, 'Learn more')">Learn more</a>
    </section>

    <ul id="wiki-links">
      <li><a id="link-tomorrow-show" href="#tshow" onclick="event.preventDefault(); window.__rec(this.id, 'The Tomorrow Show')">The Tomorrow Show</a></li>
      <li><a id="link-tomorrow-time" href="#ttime" onclick="event.preventDefault(); window.__rec(this.id, 'Tomorrow (time)')">Tomorrow (time)</a></li>
      <li><a id="link-tomorrow-mag" href="#tmag" onclick="event.preventDefault(); window.__rec(this.id, 'To-Morrow (Chicago magazine)')">To-Morrow (Chicago magazine)</a></li>
    </ul>

    <div id="more-targets">
      <a id="link-abc" href="#abc" onclick="event.preventDefault(); window.__rec(this.id, 'ABC')">ABC</a>
      <a id="link-ext" href="https://example.org/docs" target="_blank" onclick="event.preventDefault(); window.__rec(this.id, 'Partner Guide')">Partner Guide</a>
      <a id="link-dl" href="/brochure.pdf" download onclick="event.preventDefault(); window.__rec(this.id, 'Brochure PDF')">Brochure PDF</a>
      <a id="link-pay" href="#pay" onclick="event.preventDefault(); window.__rec(this.id, 'Pay Now')">Pay Now</a>
      <div id="custom-pointer-tile" tabindex="0" style="cursor:pointer;display:inline-block;padding:6px;" onclick="window.__rec(this.id, 'Custom Action Tile')">Custom Action Tile</div>
    </div>

    <input id="pw-box" type="password" value="Secret999" aria-label="Portal Password" onclick="window.__rec(this.id, 'Portal Password')">
    <a id="hidden-link" href="#hidden" style="display:none" onclick="event.preventDefault(); window.__rec(this.id, 'Secret Hidden Link')">Secret Hidden Link</a>
  </main>

  <script>
    window.__CLICKS = [];
    window.__rec = function (id, label) {
      window.__CLICKS.push({ id, label, ts: Date.now() });
    };
  </script>
</body>
</html>"""


def make_handler(root_dir: Path, explain_calls: list):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root_dir), **kwargs)

        def log_message(self, format, *args):
            return

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/l4-fixture.html":
                data = FIXTURE_HTML.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            super().do_GET()

        def do_POST(self):
            if urlparse(self.path).path != "/mock-llm":
                self.send_response(404)
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8", errors="replace") or "{}")
            explain_calls.append(body)
            reply = {"status": "ok", "source": "mock", "answer": "This page describes hostel mess and library hours."}
            raw = json.dumps(reply).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    return Handler


def main():
    explain_calls = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(ROOT, explain_calls))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    css_text = (ROOT / "widget.css").read_text(encoding="utf-8")
    lexicon_data = json.loads((ROOT / "lexicon.json").read_text(encoding="utf-8"))
    link_lexicon = json.loads((ROOT / "link-lexicon.json").read_text(encoding="utf-8"))
    script_names = [
        "reader.js", "outline.js", "voice.js", "pill.js", "glow.js", "digest.js",
        "explain.js", "confirm.js", "link-index.js", "match.js", "link-intent.js",
        "intent.js", "navigate.js", "form-index.js", "form-fill.js", "forms.js",
        "shelf-db.js", "upload.js", "camera.js", "dialogue.js", "widget.js",
    ]

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})

            session_store = {}
            def boot_page():
                page.goto(f"http://127.0.0.1:{port}/l4-fixture.html", wait_until="load")
                page.evaluate("""([css, store]) => {
                  window.__SESSION_MEM = store || {};
                  window.chrome = {
                    runtime: {
                      lastError: null,
                      getURL: (p) => location.origin + '/' + String(p).replace(/^\\/+/, ''),
                      sendMessage: (msg, cb) => {
                        if (!msg || typeof cb !== 'function') return;
                        if (msg.type === 'SLEEPWALKER_SESSION_STATE_SET') {
                          window.__SESSION_MEM.state = msg.state;
                          cb({ ok: true });
                        } else if (msg.type === 'SLEEPWALKER_SESSION_STATE_GET') {
                          cb({ state: window.__SESSION_MEM.state || null });
                        } else if (msg.type === 'SLEEPWALKER_SESSION_STATE_CLEAR') {
                          window.__SESSION_MEM.state = null;
                          cb({ ok: true });
                        } else if (msg.type === 'SLEEPWALKER_EXPLAIN_REQUEST') {
                          fetch('/mock-llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg.payload || {}) })
                            .then((r) => r.json()).then(cb).catch(() => cb({ status: 'fallback' }));
                        } else if (msg.type === 'SLEEPWALKER_PICK_LINK_REQUEST') {
                          cb({ status: 'unavailable', id: null, confidence: 0 });
                        } else {
                          cb({ status: 'ok' });
                        }
                      },
                      onMessage: { addListener: () => {} }
                    },
                    storage: {
                      local: {
                        get: (_k, cb) => cb({ sleepwalker_proxy_url: location.origin + '/mock-llm', sleepwalker_local_only: false }),
                        set: (_o, cb) => cb && cb()
                      },
                      session: {
                        get: (_k, cb) => cb({ ...window.__SESSION_MEM }),
                        set: (obj, cb) => { Object.assign(window.__SESSION_MEM, obj || {}); cb && cb(); }
                      }
                    }
                  };
                  window.__SW_TEST_CSS__ = css;
                }""", [css_text, session_store])
                for sname in script_names:
                    page.add_script_tag(url=f"http://127.0.0.1:{port}/{sname}")
                page.evaluate("([lex, llex]) => { window.__L1 = lex; window.__L2 = llex; const w = new window.SleepwalkerWidget(); window.__SW_WIDGET__ = w; w.init().then(() => { const st = document.createElement('style'); st.textContent = window.__SW_TEST_CSS__; w.shadowRoot.prepend(st); }); }", [lexicon_data, link_lexicon])
                page.wait_for_function("() => window.__SW_WIDGET__ && window.__SW_WIDGET__.shadowRoot && window.__SW_WIDGET__.navigator && window.__SW_WIDGET__.intentEngine.lexicon")
                page.evaluate("() => { window.__SW_WIDGET__.intentEngine.lexicon = window.__L1; window.__SW_WIDGET__.navigator.highlightDurationMs = 90; }")

            boot_page()

            # 1. Announcement before acting + internal high-confidence click without confirm
            page.evaluate("() => { window.__CLICKS = []; window.__SW_WIDGET__.handleUserInput('टुमारो शो', 'voice'); }")
            page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
            status_after_open = page.evaluate("() => ({ c: window.__CLICKS[0], msg: window.__SW_WIDGET__.pill.statusText.textContent })")
            assert status_after_open["c"]["id"] == "link-tomorrow-show"
            print("PASS  High-confidence internal click opens 'The Tomorrow Show' with 0 confirmations")

            # 2. Spelled letters ("a b c") + custom pointer fallback (<div tabindex=0>)
            for phrase, expected_id in [("a b c", "link-abc"), ("press custom action tile button", "custom-pointer-tile")]:
                page.evaluate("() => { window.__CLICKS = []; }")
                page.evaluate("(p) => window.__SW_WIDGET__.handleUserInput(p, 'voice')", phrase)
                page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
                assert page.evaluate("() => window.__CLICKS[0].id") == expected_id
            print("PASS  'a b c' clicks ABC & pointer/div target clicks cleanly")

            # 3. FIND ("where is Fees") highlights, announces location ("in the main menu, second item"), asks "Shall I open it?"
            page.evaluate("() => { window.__CLICKS = []; }")
            find_info = page.evaluate("""async () => {
              await window.__SW_WIDGET__.handleUserInput('where is Fees', 'voice');
              return {
                clicks: window.__CLICKS.length,
                msg: window.__SW_WIDGET__.pill.statusText.textContent,
                awaiting: window.__SW_WIDGET__.confirm.isAwaiting()
              };
            }""")
            assert find_info["clicks"] == 0 and find_info["awaiting"], find_info
            assert "main menu" in find_info["msg"] and "Shall I open it?" in find_info["msg"], find_info
            page.evaluate("() => window.__SW_WIDGET__.handleUserInput('haan', 'voice')")
            page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
            assert page.evaluate("() => window.__CLICKS[0].id") == "nav-fees"
            print("PASS  FIND says location ('in the main menu, second item') & 'Shall I open it?'; 'haan' opens")

            # 4. FIND_THEN_CLICK ("find link tomorrow show and click it")
            page.evaluate("() => { window.__CLICKS = []; window.__SW_WIDGET__.handleUserInput('find link tomorrow show and click it', 'voice'); }")
            page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
            assert page.evaluate("() => window.__CLICKS[0].id") == "link-tomorrow-show"
            print("PASS  FIND_THEN_CLICK finds, highlights, and clicks The Tomorrow Show")

            # 5. LIST ("what links are there") + follow-up "number 2"
            page.evaluate("() => { window.__CLICKS = []; }")
            list_res = page.evaluate("""async () => {
              await window.__SW_WIDGET__.handleUserInput('what links are there', 'voice');
              return { msg: window.__SW_WIDGET__.pill.statusText.textContent, n: window.__SW_WIDGET__.navigator.pendingChoices.length };
            }""")
            assert list_res["n"] == 10 and "1. Home" in list_res["msg"] and "2. Fees" in list_res["msg"], list_res
            page.evaluate("() => window.__SW_WIDGET__.handleUserInput('number 2', 'voice')")
            page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
            assert page.evaluate("() => window.__CLICKS[0].id") == "nav-fees"
            print("PASS  LIST reads top 10 links & 'number 2' picks item #2")

            # 6. Disambiguation: name ("Tomorrow (time)"), "no, the other one", & cross-reload session ("click it" & "no, the other one")
            page.evaluate("() => { window.__CLICKS = []; }")
            page.evaluate("() => window.__SW_WIDGET__.handleUserInput('tomorrow', 'voice')")
            page.wait_for_timeout(80)
            ambig_state = page.evaluate("() => ({ clicks: window.__CLICKS.length, awaiting: window.__SW_WIDGET__.confirm.isAwaiting(), pending: window.__SW_WIDGET__.confirm.pending && { title: window.__SW_WIDGET__.confirm.pending.title, opts: (window.__SW_WIDGET__.confirm.pending.options||[]).map(o=>o.label) } })")
            assert ambig_state["clicks"] == 0 and ambig_state["awaiting"], ambig_state
            res_name = page.evaluate("async () => { const r = await window.__SW_WIDGET__.handleUserInput('Tomorrow time', 'voice'); return { r, clicks: window.__CLICKS, msg: window.__SW_WIDGET__.pill.statusText.textContent }; }")
            try:
                page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
            except Exception as exc:
                raise AssertionError(f"Name pick failed! ambig={ambig_state}, res_name={res_name}") from exc
            assert page.evaluate("() => window.__CLICKS[0].id") == "link-tomorrow-time"

            # Trigger ambiguous again, then "no, the other one" picks option 2
            page.evaluate("() => { window.__CLICKS = []; }")
            page.evaluate("() => window.__SW_WIDGET__.handleUserInput('tomorrow', 'voice')")
            page.wait_for_timeout(60)
            page.evaluate("() => window.__SW_WIDGET__.handleUserInput('no, the other one', 'voice')")
            page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
            session_saved = page.evaluate("() => window.__SESSION_MEM")
            assert session_saved.get("state") and session_saved["state"].get("lastTargetLabel")
            print("PASS  Disambiguation accepts candidate name ('Tomorrow time') & 'no, the other one' and stores session")

            # Reload page with persisted session_store -> "click it" re-clicks remembered link!
            session_store.update(session_saved)
            boot_page()
            page.evaluate("() => { window.__CLICKS = []; window.__SW_WIDGET__.handleUserInput('click it', 'voice'); }")
            page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
            assert page.evaluate("() => window.__CLICKS[0].label") == session_saved["state"]["lastTargetLabel"]
            print("PASS  Session state survives reload so 'click it' re-opens last target")

            # 7. MORE_INFO matches card "Read more" for scholarships + falls back to explain offer when topic missing
            page.evaluate("() => { window.__CLICKS = []; window.__SW_WIDGET__.handleUserInput('I want more info on scholarships', 'voice'); }")
            page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
            assert page.evaluate("() => window.__CLICKS[0].id") == "card-schol-more"

            explain_calls.clear()
            miss_res = page.evaluate("""async () => {
              window.__CLICKS = [];
              await window.__SW_WIDGET__.handleUserInput('tell me more about quantum refunds', 'voice');
              return { msg: window.__SW_WIDGET__.pill.statusText.textContent, awaiting: window.__SW_WIDGET__.confirm.isAwaiting() };
            }""")
            assert "could not find a page about quantum refunds" in miss_res["msg"].lower() and miss_res["awaiting"], miss_res
            page.evaluate("() => window.__SW_WIDGET__.handleUserInput('yes', 'voice')")
            page.wait_for_function("() => true")
            page.wait_for_timeout(200)
            assert len(explain_calls) == 1, explain_calls
            print("PASS  MORE_INFO opens Scholarships 'Read more' & missing topic offers Explain fallback")

            # 8. Confirmation policy: external/newTab (target=_blank announces new tab!), download, logout, Pay Now double confirm, never password/hidden
            for phrase, expected_id, need_steps, expect_newtab in [
                ("open Partner Guide", "link-ext", 1, True),
                ("open Brochure PDF", "link-dl", 1, False),
                ("open Log out", "nav-logout", 1, False),
                ("open Pay Now", "link-pay", 2, False),
            ]:
                page.evaluate("() => { window.__CLICKS = []; }")
                page.evaluate("(p) => window.__SW_WIDGET__.handleUserInput(p, 'voice')", phrase)
                page.wait_for_timeout(60)
                assert page.evaluate("() => window.__CLICKS.length") == 0 and page.evaluate("() => window.__SW_WIDGET__.confirm.isAwaiting()"), phrase
                page.evaluate("() => window.__SW_WIDGET__.handleUserInput('yes', 'voice')")
                if need_steps == 2:
                    page.wait_for_timeout(40)
                    assert page.evaluate("() => window.__CLICKS.length") == 0 and page.evaluate("() => window.__SW_WIDGET__.confirm.isAwaiting()")
                    page.evaluate("() => window.__SW_WIDGET__.handleUserInput('haan', 'voice')")
                page.wait_for_function("() => window.__CLICKS.length === 1", timeout=3000)
                assert page.evaluate("() => window.__CLICKS[0].id") == expected_id
                if expect_newtab:
                    msg = page.evaluate("() => window.__SW_WIDGET__.pill.statusText.textContent")
                    assert "new tab" in msg.lower(), msg

            for bad in ["open Portal Password", "open Secret Hidden Link"]:
                page.evaluate("() => { window.__CLICKS = []; }")
                page.evaluate("(p) => window.__SW_WIDGET__.handleUserInput(p, 'voice')", bad)
                page.wait_for_timeout(120)
                assert page.evaluate("() => window.__CLICKS.length") == 0
            print("PASS  Confirm policy (external/newTab/download/logout 1x, Pay double, password/hidden never clicked)")

            browser.close()
    finally:
        server.shutdown()

    print("\nALL L4 ACTING & CONFIRMATION ASSERTIONS PASSED (8/8).")


if __name__ == "__main__":
    main()
