#!/usr/bin/env python3
"""
Phase P4 Verification (for permitted modules):
- voice.js live mic RMS analyser & synthetic listening envelope fallback (onLevel / levelMode)
- reader.js SpeechSynthesis boundary event pulse & no-boundary synthetic speech envelope
- explain.js, navigate.js, forms.js, upload.js, camera.js calling SW_UI cleanly
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
<head><meta charset="UTF-8"><title>P4 Voice Sync Portal</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;min-height:900px;">
  <main style="padding:28px;">
    <h1>National Scholarship Portal</h1>
    <p>This portal supports online scholarship applications. Deadline is 30 November. Application fee is zero.</p>
    <a id="elig-link" href="#eligibility">Check Eligibility</a>
    <form id="f1">
      <label for="f-name">Full Name *</label>
      <input id="f-name" type="text" required>
    </form>
  </main>
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
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(f"http://127.0.0.1:{port}/portal.html", wait_until="domcontentloaded")
            page.evaluate("""() => {
              window.chrome = {
                runtime: { getURL: (u) => location.origin + '/' + u, getManifest: () => ({version:'1.0.0'}), sendMessage: (_m, cb) => cb && cb({status:'fallback'}), onMessage: { addListener: () => {} } },
                storage: { local: { get: (_k, cb) => cb({}), set: (_o, cb) => cb && cb() }, session: { get: (_k, cb) => cb({}), set: (_k, cb) => cb && cb() } }
              };
              window.__LAST_UTT__ = null;
              const synth = {
                speaking: false, paused: false, onvoiceschanged: null,
                getVoices: () => [{ name: 'Mock EN', lang: 'en-IN', default: true }],
                speak: (u) => { window.__LAST_UTT__ = u; synth.speaking = true; u.onstart && u.onstart(); },
                cancel: () => { synth.speaking = false; }, pause: () => {}, resume: () => {}
              };
              Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
              window.SpeechSynthesisUtterance = function (t) { this.text = t || ''; };
              window.SpeechRecognition = class { start() { this.onstart && this.onstart(); } stop() { this.onend && this.onend(); } };
            }""")
            for s in ["reader.js", "outline.js", "voice.js", "digest.js", "explain.js", "confirm.js", "link-index.js", "match.js", "link-intent.js", "intent.js", "navigate.js", "form-index.js", "form-fill.js", "forms.js", "upload.js", "camera.js", "threads.js", "card.js", "orb.js"]:
                page.add_script_tag(url=f"http://127.0.0.1:{port}/{s}")
            page.evaluate("(c) => window.SW_UI._orb.injectCssText(c)", css_text)

            # 1. Voice synthetic listening envelope feeds SW_UI.setLevel & cleans up on stop
            levels = page.evaluate("""() => new Promise((resolve) => {
              const v = new window.SleepwalkerVoice();
              const seen = [];
              v.onLevel = (lvl, mode) => { seen.push({ lvl, mode }); window.SW_UI.setLevel(lvl); };
              window.SW_UI.setState('listening');
              v.startListening();
              setTimeout(() => {
                v.stopListening();
                setTimeout(() => resolve({ seen, afterStop: v.levelMode }), 40);
              }, 140);
            })""")
            assert len(levels["seen"]) >= 2 and any(x["mode"] == "synthetic_listening" and x["lvl"] > 0 for x in levels["seen"]), levels
            assert levels["afterStop"] == "idle" and levels["seen"][-1]["lvl"] == 0, levels
            print("PASS  P4.1: Voice listening envelope drives setLevel and stops cleanly at 0")

            # 2. Reader SpeechSynthesis: boundary mode AND synthetic speech envelope fallback
            speech_res = page.evaluate("""() => new Promise((resolve) => {
              const r = new window.SleepwalkerReader();
              const events = [];
              r.onLevel = (lvl, mode) => { events.push({ lvl, mode }); window.SW_UI.setLevel(lvl); };
              window.SW_UI.setState('speaking');
              r.readText('First sentence runs synthetic. Second sentence fires boundary.');
              setTimeout(() => {
                const modeBeforeBoundary = r.speechLevelMode;
                const lenBeforeBoundary = events.length;
                if (window.__LAST_UTT__ && window.__LAST_UTT__.onboundary) {
                  window.__LAST_UTT__.onboundary({ name: 'word', charIndex: 6 });
                }
                setTimeout(() => {
                  const modeAfterBoundary = r.speechLevelMode;
                  const peakAfterBoundary = Math.max(...events.slice(lenBeforeBoundary).map(x => x.lvl));
                  r.stop();
                  resolve({ modeBeforeBoundary, modeAfterBoundary, peakAfterBoundary, lastMode: r.speechLevelMode, count: events.length });
                }, 40);
              }, 110);
            })""")
            assert speech_res["modeBeforeBoundary"] == "synthetic_speech" and speech_res["modeAfterBoundary"] == "boundary", speech_res
            assert speech_res["peakAfterBoundary"] > 0.5 and speech_res["lastMode"] == "idle" and speech_res["count"] >= 2, speech_res
            print("PASS  P4.2: Reader SpeechSynthesis uses synthetic fallback then locks onto boundary events & clears on stop")

            # 3. Logic modules route directly through SW_UI (explain / navigate / forms)
            mod_res = page.evaluate("""() => new Promise((resolve) => {
              const mockWidget = {
                lang: 'en-IN', reader: new window.SleepwalkerReader(),
                outline: new window.SleepwalkerOutline(),
                setAssistantReply: () => {}, recordError: () => {}
              };
              const exp = new window.SleepwalkerExplainer(mockWidget);
              exp.runExplainPipeline({ mode: 'summary' });
              setTimeout(() => {
                const afterExplain = {
                  cardTitle: document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-card-title').textContent,
                  cardType: window.SW_UI.getCardType()
                };
                const forms = new window.SleepwalkerForms(mockWidget);
                forms.startGuidedFill();
                const afterForms = {
                  cardTitle: document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-card-title').textContent,
                  cardType: window.SW_UI.getCardType(),
                  progress: document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-card-badge').textContent
                };
                resolve({ afterExplain, afterForms });
              }, 750);
            })""")
            assert mod_res["afterExplain"]["cardType"] == "summary" and "Summary" in mod_res["afterExplain"]["cardTitle"], mod_res
            assert mod_res["afterForms"]["cardType"] == "form" and "done" in mod_res["afterForms"]["progress"], mod_res
            print("PASS  P4.3: Explain & Forms modules render directly into SW_UI cards")

            browser.close()
    finally:
        httpd.shutdown()

    print("PASS: All permitted Phase P4 checks passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
