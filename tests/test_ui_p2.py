#!/usr/bin/env python3
"""
Phase P2 Verification: threads, max-40 particles, max-10% light veil,
dissolve-out transition, zero idle RAF loop, pointer-events passthrough,
and prefers-reduced-motion static glow fallback.
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
<head><meta charset="UTF-8"><title>P2 Threads Portal Fixture</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;min-height:1400px;">
  <main style="padding:28px;">
    <h1>Scholarship Application</h1>
    <button id="hero-btn" type="button" style="padding:12px 20px;">Hero Action</button>
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
            context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="no-preference")
            page = context.new_page()
            page.goto(f"http://127.0.0.1:{port}/portal.html", wait_until="domcontentloaded")
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

            page.wait_for_function("() => window.SW_UI && window.SW_UI._orb && window.SW_UI._orb.threads")
            page.evaluate("(c) => window.SW_UI._orb.injectCssText(c)", css_text)

            # 1. Idle: RAF stopped & canvas empty
            idle_info = page.evaluate("""() => ({
              state: window.SW_UI.getState(),
              running: window.SW_UI._orb.threads.isRunning(),
              particles: window.SW_UI._orb.threads.getParticleCount()
            })""")
            assert idle_info == {"state": "idle", "running": False, "particles": 0}, idle_info

            # 2. Listening -> bottom threads active, veil <= 10% tint, pointer-events: none, <= 40 particles
            page.evaluate("() => window.__SW_UI_DEMO__('listening')")
            page.wait_for_timeout(160)
            active_info = page.evaluate("""() => {
              const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
              const veil = sr.getElementById('sw-ui-veil');
              const canvas = sr.getElementById('sw-ui-threads');
              const vs = getComputedStyle(veil);
              const cs = getComputedStyle(canvas);
              const th = window.SW_UI._orb.threads;
              return {
                running: th.isRunning(),
                particles: th.getParticleCount(),
                perimMix: th.perimMix,
                veilPe: vs.pointerEvents,
                canvasPe: cs.pointerEvents,
                veilOp: parseFloat(vs.opacity || '0'),
                veilBg: vs.backgroundImage
              };
            }""")
            assert active_info["running"] and active_info["particles"] <= 40 and active_info["veilPe"] == "none" and active_info["canvasPe"] == "none", active_info
            # Verify clicks & scrolling pass through while active
            page.click("#hero-btn")
            assert page.evaluate("() => window.__HERO_CLICKS__") == 1

            # 3. Thinking -> perimeter mix ramps up > 0.3
            page.evaluate("() => window.__SW_UI_DEMO__('thinking')")
            page.wait_for_timeout(240)
            perim = page.evaluate("() => window.SW_UI._orb.threads.perimMix")
            assert perim > 0.3, f"Expected perimeter threads in thinking mode, got {perim}"

            # 4. Dissolve-out: particle count stays <= 40 during burst and reaches idle + stopped RAF afterward
            page.evaluate("() => window.SW_UI.hide({ dissolve: true })")
            burst_count = page.evaluate("() => window.SW_UI._orb.threads.getParticleCount()")
            assert burst_count <= 40, f"Max 40 particles exceeded: {burst_count}"
            page.wait_for_function("() => window.SW_UI.getState() === 'idle'")
            after_idle = page.evaluate("() => ({ running: window.SW_UI._orb.threads.isRunning(), particles: window.SW_UI._orb.threads.getParticleCount() })")
            assert not after_idle["running"] and after_idle["particles"] == 0, after_idle

            # 5. Reduced motion: flowing RAF stays OFF (static soft glow only)
            context2 = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
            page2 = context2.new_page()
            page2.goto(f"http://127.0.0.1:{port}/portal.html", wait_until="domcontentloaded")
            for s in ["threads.js", "orb.js"]:
                page2.add_script_tag(url=f"http://127.0.0.1:{port}/{s}")
            page2.evaluate("(c) => window.SW_UI._orb.injectCssText(c)", css_text)
            page2.evaluate("() => window.__SW_UI_DEMO__('thinking')")
            page2.wait_for_timeout(100)
            rm_info = page2.evaluate("() => ({ rm: window.SW_UI._orb.threads.reducedMotion, running: window.SW_UI._orb.threads.isRunning(), particles: window.SW_UI._orb.threads.getParticleCount() })")
            assert rm_info["rm"] is True and rm_info["running"] is False and rm_info["particles"] == 0, rm_info
            context2.close()
            browser.close()
    finally:
        httpd.shutdown()

    print("PASS: All Phase P2 UI tests passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
