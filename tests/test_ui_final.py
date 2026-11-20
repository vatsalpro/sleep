#!/usr/bin/env python3
"""
Phase P5 Final UI E2E Verification (Playwright Chromium):
Runs on a Government Portal fixture (navbar, hero, info cards, form) without pill.js/glow.js/widget.js.
Screenshots every orb state and card type at 1440x900 and 1024x700 into artifact scratch dir,
and asserts: zero idle visibility & animations, click/scroll passthrough, viewport bounds,
target non-overlap, >=4.5:1 text contrast, Escape dismiss, auto-dismiss + hover pause,
reduced-motion static glow, zero layout shift, live content.js controller flow, and options.html.
"""
import http.server
import json
import socketserver
import sys
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOT_DIR = Path(r"C:\Users\Vatsal Kumar\.gemini\antigravity-cli\brain\164cb7e0-bda0-4781-8f0b-2d4c7e9896ee\scratch\ui-screenshots")

GOV_PORTAL_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>National Scholarship Portal — Mock Fixture</title>
  <style>
    body { margin:0; font-family:system-ui,-apple-system,sans-serif; background:#eef2f7; color:#111827; }
    header { background:#102a5c; color:#fff; padding:16px 32px; display:flex; justify-content:space-between; align-items:center; }
    nav a { color:#fff; margin-left:18px; text-decoration:none; font-weight:600; }
    .hero { background:linear-gradient(120deg,#1d4ed8,#1e3a8a); color:#fff; padding:42px 32px; }
    .cards { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; padding:24px 32px; }
    .portal-card { background:#fff; padding:18px; border-radius:12px; border:1px solid #d1d5db; }
    .form-wrap { padding:18px 32px 680px; }
    input, select, button { font-size:16px; padding:10px 14px; }
  </style>
</head>
<body>
  <header>
    <div><strong>National Scholarship Portal</strong></div>
    <nav aria-label="Primary navigation">
      <a href="#home">Home</a><a href="#schemes">Schemes</a><a href="#docs">Documents</a>
    </nav>
  </header>
  <section class="hero">
    <h1>Apply for Government Scholarships</h1>
    <p>Financial support for meritorious and underprivileged students. Application fee is ₹0. Deadline 30 November.</p>
    <button id="hero-cta" type="button">Apply Now</button>
  </section>
  <section class="cards">
    <div class="portal-card"><h3>Eligibility Criteria</h3><p>Annual family income below ₹2,50,000.</p></div>
    <div class="portal-card"><h3>Required Documents</h3><p>Income certificate, marksheet, applicant photo.</p></div>
    <div class="portal-card"><h3>Application Fees</h3><p>Zero fee for portal registration.</p></div>
    <div class="portal-card"><h3>Apply Online</h3><p>Submit online before 30 November.</p></div>
  </section>
  <section class="form-wrap">
    <h2>Quick Eligibility Check</h2>
    <form id="gov-form">
      <label for="g-name">Student Name *</label>
      <input id="g-name" type="text" required>
      <button id="bottom-highlight-target" type="button" style="position:fixed;left:50%;bottom:175px;transform:translateX(-50%);background:#fde047;border:2px solid #854d0e;">Highlighted Button</button>
    </form>
  </section>
  <script>
    window.__HERO_CLICKS__ = 0;
    document.getElementById('hero-cta').addEventListener('click', () => { window.__HERO_CLICKS__ += 1; });
  </script>
</body>
</html>"""


def main():
    SHOT_DIR.mkdir(parents=True, exist_ok=True)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)
        def do_GET(self):
            if self.path == "/gov-portal.html":
                b = GOV_PORTAL_HTML.encode("utf-8")
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
    lex = json.loads((ROOT / "lexicon.json").read_text(encoding="utf-8"))
    llex = json.loads((ROOT / "link-lexicon.json").read_text(encoding="utf-8"))

    # Inject exact production content_scripts order (without obsolete pill/glow/widget)
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    scripts = manifest["content_scripts"][0]["js"]
    assert "pill.js" not in scripts and "glow.js" not in scripts and "widget.js" not in scripts, scripts
    assert "options_ui" in manifest and manifest["options_ui"].get("open_in_tab") is True, manifest

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for vw, vh in [(1440, 900), (1024, 700)]:
                page = browser.new_page(viewport={"width": vw, "height": vh})
                page.goto(f"http://127.0.0.1:{port}/gov-portal.html", wait_until="domcontentloaded")
                before_rects = page.evaluate("""() => ({
                  nav: document.querySelector('header').getBoundingClientRect().toJSON(),
                  hero: document.querySelector('.hero').getBoundingClientRect().toJSON(),
                  cards: document.querySelector('.cards').getBoundingClientRect().toJSON(),
                  form: document.querySelector('.form-wrap').getBoundingClientRect().toJSON()
                })""")

                page.evaluate("""() => {
                  const store = { sleepwalker_glow_enabled: true };
                  window.__MEM_STORE__ = store;
                  window.chrome = {
                    runtime: { getURL: (u) => location.origin + '/' + u, getManifest: () => ({version:'1.0.0'}), sendMessage: (_m, cb) => cb && cb({status:'fallback'}), onMessage: { addListener: () => {} } },
                    storage: {
                      local: { get: (_k, cb) => cb({...store}), set: (o, cb) => { Object.assign(store, o||{}); cb && cb(); } },
                      session: { get: (_k, cb) => cb({}), set: (_k, cb) => cb && cb() },
                      onChanged: { addListener: () => {} }
                    }
                  };
                  window.SpeechRecognition = class { start() { this.onstart && this.onstart(); } stop() { this.onend && this.onend(); } };
                  const synth = { speaking: false, getVoices: () => [{ name: 'Mock EN', lang: 'en-IN', default: true }], speak: (u) => { synth.speaking = true; u.onstart && u.onstart(); setTimeout(() => { synth.speaking = false; u.onend && u.onend(); }, 30); }, cancel: () => { synth.speaking = false; }, pause: () => {}, resume: () => {} };
                  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
                  window.SpeechSynthesisUtterance = function (t) { this.text = t || ''; };
                }""")

                for s in scripts:
                    page.add_script_tag(url=f"http://127.0.0.1:{port}/{s}")
                page.wait_for_function("() => window.SW_UI && window.__SLEEPWALKER_INSTANCE__")
                page.evaluate("([c, l1, l2]) => { window.SW_UI._orb.injectCssText(c); window.__SLEEPWALKER_INSTANCE__.intentEngine.lexicon = l1; window.__SLEEPWALKER_INSTANCE__.linkIntent.lexicon = l2; }", [css_text, lex, llex])

                # 1. Idle check: nothing visible, 0 animations, 0 RAF
                idle = page.evaluate("""() => {
                  const host = document.getElementById('sleepwalker-ui-host');
                  const root = host.shadowRoot.querySelector('.sw-ui-root');
                  const rs = getComputedStyle(root);
                  return {
                    vis: rs.visibility, op: rs.opacity,
                    anims: host.shadowRoot.getAnimations().length,
                    raf: window.SW_UI._orb.threads.isRunning()
                  };
                }""")
                assert idle == {"vis": "hidden", "op": "0", "anims": 0, "raf": False}, f"Idle violation at {vw}x{vh}: {idle}"
                page.screenshot(path=str(SHOT_DIR / f"{vw}x{vh}_state_idle.png"))

                # 2. Screenshot all orb states + verify clicks & scroll passthrough while active
                for st in ["silent", "listening", "thinking", "speaking", "confirm", "error"]:
                    page.evaluate("(s) => window.__SW_UI_DEMO__(s)", st)
                    page.wait_for_timeout(180)
                    page.screenshot(path=str(SHOT_DIR / f"{vw}x{vh}_state_{st}.png"))

                page.click("#hero-cta")
                assert page.evaluate("() => window.__HERO_CLICKS__") == 1, "Clicks blocked while UI active"
                page.mouse.move(vw / 2, vh / 2)
                page.mouse.wheel(0, 220)
                page.wait_for_timeout(80)
                assert page.evaluate("() => window.scrollY") >= 100, "Scrolling blocked while UI active"
                page.evaluate("() => window.scrollTo(0, 0)")

                # 3. Screenshot all card types + assert viewport bounds & >= 4.5:1 contrast
                for ct in ["summary", "topics", "choices", "confirm", "critical", "file", "form", "plan"]:
                    page.evaluate("(t) => window.__SW_UI_DEMO__(t)", ct)
                    page.wait_for_timeout(120)
                    box = page.evaluate("""() => {
                      const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
                      const card = sr.getElementById('sw-ui-card');
                      const r = card.getBoundingClientRect();
                      const fg = (getComputedStyle(sr.getElementById('sw-card-body')).color.match(/[\\d.]+/g) || []).map(Number);
                      const bgRaw = (getComputedStyle(card).backgroundColor.match(/[\\d.]+/g) || []).map(Number);
                      const a = bgRaw.length >= 4 ? bgRaw[3] : 1;
                      const comp = [0,1,2].map(i => bgRaw[i]*a + 16*(1-a));
                      const lum = (rgb) => { const x = rgb.map(v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*x[0]+0.7152*x[1]+0.0722*x[2]; };
                      const c = (Math.max(lum(comp), lum(fg)) + 0.05) / (Math.min(lum(comp), lum(fg)) + 0.05);
                      return { inVp: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight, contrast: c };
                    }""")
                    assert box["inVp"] and box["contrast"] >= 4.5, f"{ct} @ {vw}x{vh}: {box}"
                    page.screenshot(path=str(SHOT_DIR / f"{vw}x{vh}_card_{ct}.png"))

                # 4. Never covers highlighted bottom-center target
                page.evaluate("() => window.SW_UI.showCard({ type: 'answer', title: 'Target Check', text: 'Shifted away cleanly.', targetEl: document.getElementById('bottom-highlight-target') })")
                sep = page.evaluate("""() => {
                  const c = document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-ui-card').getBoundingClientRect();
                  const t = document.getElementById('bottom-highlight-target').getBoundingClientRect();
                  return (c.right <= t.left || c.left >= t.right || c.bottom <= t.top || c.top >= t.bottom);
                }""")
                assert sep, f"Card overlapped highlighted target at {vw}x{vh}"

                # 5. Escape dismisses cleanly & stops all animation + zero layout shift
                page.keyboard.press("Escape")
                page.wait_for_function("() => window.SW_UI.getState() === 'idle'")
                idle_after = page.evaluate("() => ({ anims: document.getElementById('sleepwalker-ui-host').shadowRoot.getAnimations().length, raf: window.SW_UI._orb.threads.isRunning() })")
                assert idle_after == {"anims": 0, "raf": False}, idle_after

                after_rects = page.evaluate("""() => ({
                  nav: document.querySelector('header').getBoundingClientRect().toJSON(),
                  hero: document.querySelector('.hero').getBoundingClientRect().toJSON(),
                  cards: document.querySelector('.cards').getBoundingClientRect().toJSON(),
                  form: document.querySelector('.form-wrap').getBoundingClientRect().toJSON()
                })""")
                assert before_rects == after_rects, f"Layout shift at {vw}x{vh}: {before_rects} vs {after_rects}"

                # 6. Auto-dismiss respects hover & live content.js __SW_SAY__ works end-to-end
                if vw == 1440:
                    page.evaluate("""() => {
                      window.SW_UI.showCard({ type: 'answer', title: 'Auto-Hide', text: 'Wait for timer.', autoDismissMs: 120 });
                      document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-ui-card').dispatchEvent(new MouseEvent('mouseenter'));
                    }""")
                    page.wait_for_timeout(180)
                    assert page.evaluate("() => window.SW_UI.getState() !== 'idle'")
                    page.evaluate("() => document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-ui-card').dispatchEvent(new MouseEvent('mouseleave'))")
                    page.wait_for_function("() => window.SW_UI.getState() === 'idle'")

                    # Test live SleepwalkerController voice pipeline via __SW_SAY__
                    page.keyboard.press("Alt+s")
                    page.wait_for_function("() => window.SW_UI.getState() === 'listening'")
                    page.evaluate("async () => await window.__SW_SAY__('explain this page')")
                    page.wait_for_function("() => window.SW_UI.getCardType() === 'summary'")
                    page.keyboard.press("Escape")
                    page.wait_for_function("() => window.SW_UI.getState() === 'idle'")

                page.close()

            # 7. Verify reduced-motion stops flowing animation
            rm_ctx = browser.new_context(viewport={"width": 1280, "height": 800}, reduced_motion="reduce")
            rm_page = rm_ctx.new_page()
            rm_page.goto(f"http://127.0.0.1:{port}/gov-portal.html", wait_until="domcontentloaded")
            for s in ["threads.js", "card.js", "orb.js"]:
                rm_page.add_script_tag(url=f"http://127.0.0.1:{port}/{s}")
            rm_page.evaluate("(c) => window.SW_UI._orb.injectCssText(c)", css_text)
            rm_page.evaluate("() => window.__SW_UI_DEMO__('thinking')")
            rm_page.wait_for_timeout(180)
            rm_res = rm_page.evaluate("() => ({ rm: window.SW_UI._orb.threads.reducedMotion, raf: window.SW_UI._orb.threads.isRunning(), anims: document.getElementById('sleepwalker-ui-host').shadowRoot.getAnimations().length })")
            assert rm_res["rm"] and not rm_res["raf"] and rm_res["anims"] == 0, rm_res
            rm_ctx.close()

            # 8. Verify options.html + options.js loads and persists storage cleanly
            opt_page = browser.new_page(viewport={"width": 1280, "height": 800})
            opt_page.add_init_script("""(() => {
              window.__OPT_STORE__ = { sleepwalker_glow_enabled: true, sleepwalker_ollama_model: 'llama3.2:3b' };
              window.chrome = {
                runtime: { sendMessage: (_m, cb) => cb && cb({ status: 'ok' }) },
                storage: { local: { get: (_k, cb) => cb({...window.__OPT_STORE__}), set: (o, cb) => { Object.assign(window.__OPT_STORE__, o||{}); cb && cb(); } } }
              };
            })();""")
            opt_page.goto(f"http://127.0.0.1:{port}/options.html", wait_until="domcontentloaded")
            opt_page.fill("#opt-proxy-url", "https://proxy.example.edu/explain")
            opt_page.uncheck("#opt-glow-enabled")
            opt_page.check("#opt-local-only")
            opt_page.fill("#prof-name", "Aasha Rao")
            opt_page.click("#opt-save")
            saved = opt_page.evaluate("() => ({ store: window.__OPT_STORE__, status: document.getElementById('opt-status').textContent })")
            assert saved["store"]["sleepwalker_proxy_url"] == "https://proxy.example.edu/explain" and saved["store"]["sleepwalker_glow_enabled"] is False and saved["store"]["sleepwalker_local_profile"]["fullName"] == "Aasha Rao" and "saved" in saved["status"].lower(), saved
            opt_page.close()

            browser.close()
    finally:
        httpd.shutdown()

    print(f"PASS: All Phase P5 Final UI E2E checks & screenshots ({len(list(SHOT_DIR.glob('*.png')))} images) passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
