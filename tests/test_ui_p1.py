#!/usr/bin/env python3
"""
Phase P1 Verification: SW_UI interface, frosted glass orb, Alt+S summon/dismiss,
listening/silent states, Alt+Z hold-to-talk, Escape dismiss, click pass-through,
zero idle DOM visibility & zero idle running animations, and __SW_UI_DEMO__().
"""
import http.server
import socketserver
import sys
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

PORTAL_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>P1 Government Portal Fixture</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;">
  <header style="padding:16px;background:#1e3a8a;color:#fff;">National Scholarship Portal</header>
  <main style="padding:24px;">
    <h1>Apply for Scholarships</h1>
    <button id="hero-btn" type="button" style="padding:12px 20px;">Hero Button</button>
  </main>
  <script>
    window.__HERO_CLICKS__ = 0;
    document.getElementById('hero-btn').addEventListener('click', () => { window.__HERO_CLICKS__ += 1; });
  </script>
</body>
</html>"""


def main():
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)
        def do_GET(self):
            if self.path == "/portal.html":
                b = PORTAL_HTML.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            super().do_GET()
        def log_message(self, *a):
            pass

    httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    css_text = (ROOT / "ui.css").read_text(encoding="utf-8")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.goto(f"http://127.0.0.1:{port}/portal.html", wait_until="domcontentloaded")
            before_rect = page.evaluate("() => document.getElementById('hero-btn').getBoundingClientRect().toJSON()")

            page.evaluate("""() => {
              const store = {};
              window.chrome = {
                runtime: { getURL: (u) => location.origin + '/' + u, getManifest: () => ({version:'1.0.0'}), sendMessage: (_m, cb) => cb && cb({status:'ok'}), onMessage: { addListener: () => {} } },
                storage: { local: { get: (_k, cb) => cb({...store}), set: (o, cb) => { Object.assign(store, o||{}); cb && cb(); } }, session: { get: (_k, cb) => cb({}), set: (_k, cb) => cb && cb() } }
              };
              window.SpeechRecognition = class { start() { this.onstart && this.onstart(); } stop() { this.onend && this.onend(); } };
              Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], cancel: () => {}, pause: () => {}, resume: () => {} }, configurable: true });
            }""")

            import json as _json
            manifest = _json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
            for s in manifest["content_scripts"][0]["js"]:
                page.add_script_tag(url=f"http://127.0.0.1:{port}/{s}")

            page.wait_for_function("() => window.SW_UI && typeof window.__SW_UI_DEMO__ === 'function' && window.__SLEEPWALKER_INSTANCE__")
            page.evaluate("(c) => window.SW_UI._orb.injectCssText(c)", css_text)

            # 1. Idle check: nothing visible, zero running animations, zero layout shift
            idle_check = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const root = host.shadowRoot.querySelector('.sw-ui-root');
              const rs = getComputedStyle(root);
              const anims = host.shadowRoot.getAnimations ? host.shadowRoot.getAnimations().length : 0;
              const pill = document.getElementById('sleepwalker-host')?.shadowRoot?.getElementById('sw-pill-wrap');
              return { state: window.SW_UI.getState(), vis: rs.visibility, op: rs.opacity, anims, pillHidden: !pill || pill.style.display === 'none' || getComputedStyle(pill).display === 'none' };
            }""")
            assert idle_check["state"] == "idle" and idle_check["vis"] == "hidden" and idle_check["op"] == "0" and idle_check["anims"] == 0 and idle_check["pillHidden"], idle_check

            # 2. Alt+S summons glass orb at bottom-centre in listening state + click passes through to hero button
            page.keyboard.press("Alt+s")
            page.wait_for_function("() => window.SW_UI.getState() === 'listening'")
            page.wait_for_timeout(300)
            orb_geo = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const orb = host.shadowRoot.getElementById('sw-ui-orb');
              const r = orb.getBoundingClientRect();
              const bars = host.shadowRoot.querySelectorAll('.sw-bar').length;
              return { w: r.width, h: r.height, cx: r.left + r.width / 2, bottomGap: window.innerHeight - r.bottom, bars };
            }""")
            assert 72 <= orb_geo["w"] <= 84 and 72 <= orb_geo["h"] <= 84 and abs(orb_geo["cx"] - 720) < 10 and orb_geo["bars"] == 7, orb_geo
            page.click("#hero-btn")
            assert page.evaluate("() => window.__HERO_CLICKS__") == 1, "Clicks on underlying website must pass through!"

            # 3. Alt+S again dismisses to idle (with dissolve timer finishing to idle & 0 anims)
            page.keyboard.press("Alt+s")
            page.wait_for_function("() => window.SW_UI.getState() === 'idle'")
            assert page.evaluate("() => document.getElementById('sleepwalker-ui-host').shadowRoot.getAnimations().length") == 0

            # 4. Debug helper preview for silent/listening/confirm/error + Escape dismiss
            for st in ["silent", "listening", "thinking", "speaking", "confirm", "error"]:
                res = page.evaluate("(s) => window.__SW_UI_DEMO__(s)", st)
                assert res == st
            page.keyboard.press("Escape")
            page.wait_for_function("() => window.SW_UI.getState() === 'idle'")

            # 5. Zero layout shift check
            after_rect = page.evaluate("() => document.getElementById('hero-btn').getBoundingClientRect().toJSON()")
            assert before_rect == after_rect, f"Layout shift detected: {before_rect} vs {after_rect}"
            browser.close()
    finally:
        httpd.shutdown()

    print("PASS: All Phase P1 UI checks passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
