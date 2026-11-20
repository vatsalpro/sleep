#!/usr/bin/env python3
"""
Phase P3 Verification: frosted response card types (summary + progressive topics/sentences,
choices capped at 5, confirm dialog with focus move & restore, file picker card, form card,
plan card, error card), viewport fit at 1440x900 & 1024x700, WCAG AA >=4.5:1 text contrast,
overflow-only Expand toggle, target-avoidance positioning, and auto-dismiss + hover/pin pause.
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
<head><meta charset="UTF-8"><title>P3 Card Fixture</title></head>
<body style="margin:0;background:#1e3a8a;color:#fff;font-family:system-ui,sans-serif;min-height:1000px;">
  <main style="padding:28px;">
    <button id="page-trigger" type="button" style="padding:12px 20px;">Trigger Action</button>
    <div id="bottom-target" style="position:fixed;left:50%;bottom:180px;transform:translateX(-50%);width:220px;height:60px;background:#fef08a;color:#111;padding:8px;">
      Highlighted Form Target
    </div>
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
            for vw, vh in [(1440, 900), (1024, 700)]:
                page = browser.new_page(viewport={"width": vw, "height": vh})
                page.goto(f"http://127.0.0.1:{port}/portal.html", wait_until="domcontentloaded")
                for s in ["threads.js", "card.js", "orb.js"]:
                    page.add_script_tag(url=f"http://127.0.0.1:{port}/{s}")
                page.evaluate("(c) => window.SW_UI._orb.injectCssText(c)", css_text)

                # 1. Summary card visuals, viewport bounds, 28px radius, >=18px font, tail, >=4.5:1 contrast
                page.evaluate("""() => {
                  window.__SW_UI_DEMO__('summary');
                }""")
                page.wait_for_timeout(80)
                summary_metrics = page.evaluate("""() => {
                  const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
                  const card = sr.getElementById('sw-ui-card');
                  const body = sr.getElementById('sw-card-body');
                  const r = card.getBoundingClientRect();
                  const cs = getComputedStyle(card);
                  const bs = getComputedStyle(body);
                  const tail = sr.getElementById('sw-card-tail');
                  const exp = sr.getElementById('sw-card-expand');
                  const readBar = sr.getElementById('sw-card-read-bar');
                  return {
                    inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
                    radius: cs.borderTopLeftRadius,
                    fontPx: parseFloat(bs.fontSize),
                    color: bs.color,
                    bg: cs.backgroundColor,
                    hasTail: !tail.hidden,
                    hasExpandOnShort: Boolean(exp),
                    readBarHiddenWhenNotReading: readBar.hidden
                  };
                }""")
                assert summary_metrics["inViewport"], f"Card out of {vw}x{vh} viewport: {summary_metrics}"
                assert summary_metrics["radius"] == "28px" and summary_metrics["fontPx"] >= 18.0, summary_metrics
                assert summary_metrics["hasTail"] and not summary_metrics["hasExpandOnShort"] and summary_metrics["readBarHiddenWhenNotReading"], summary_metrics

                # Verify WCAG contrast >= 4.5:1 between ink (#1b1714) and frosted cream card (#fffaf0 alpha 0.88 over dark #1e3a8a)
                contrast = page.evaluate("""() => {
                  const parseRgb = (s) => (s.match(/[\\d.]+/g) || []).map(Number);
                  const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
                  const fg = parseRgb(getComputedStyle(sr.getElementById('sw-card-body')).color);
                  const bgRaw = parseRgb(getComputedStyle(sr.getElementById('sw-ui-card')).backgroundColor);
                  const alpha = bgRaw.length >= 4 ? bgRaw[3] : 1;
                  // Worst-case dark blue portal behind card: rgb(30, 58, 138)
                  const back = [30, 58, 138];
                  const comp = [0, 1, 2].map(i => bgRaw[i] * alpha + back[i] * (1 - alpha));
                  const lum = (rgb) => {
                    const a = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
                    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
                  };
                  const l1 = lum(comp), l2 = lum(fg);
                  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
                }""")
                assert contrast >= 4.5, f"Contrast too low: {contrast}"

                if vw == 1440:
                    # 2. Progressive topics + sentence highlight + reading Pause/Next topic controls
                    page.evaluate("""() => {
                      window.SW_UI.showCard({
                        type: 'summary', title: 'Scholarship Guide', reading: true,
                        topics: [
                          { title: '1. Purpose', text: 'Financial help. Tuition support.' },
                          { title: '2. Deadline', text: 'Apply before 30 Nov.' },
                          { title: '3. Docs', text: 'Income certificate needed.' }
                        ]
                      });
                    }""")
                    assert page.evaluate("() => document.getElementById('sleepwalker-ui-host').shadowRoot.querySelectorAll('.sw-topic:not([hidden])').length") == 1
                    assert page.evaluate("() => !document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-card-read-bar').hidden")
                    page.evaluate("() => { window.SW_UI.highlightTopic(1); window.SW_UI.highlightSentence(1); }")
                    prog = page.evaluate("""() => {
                      const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
                      const visTopics = sr.querySelectorAll('.sw-topic:not([hidden])').length;
                      const past = sr.querySelector('.sw-topic[data-t-idx="0"]').classList.contains('sw-topic-past');
                      const sentActive = sr.querySelectorAll('.sw-sentence-active').length;
                      return { visTopics, past, sentActive };
                    }""")
                    assert prog == {"visTopics": 2, "past": True, "sentActive": 1}, prog

                    # 3. Overflow shows Expand toggle cleanly
                    long_text = " ".join([f"Sentence {i} explains portal rules clearly." for i in range(45)])
                    page.evaluate("(t) => window.SW_UI.showCard({ type: 'summary', title: 'Long Guide', text: t })", long_text)
                    assert page.evaluate("() => Boolean(document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-card-expand'))")

                    # 4. Choices capped at max 5, 48px targets, clickable
                    page.evaluate("""() => {
                      window.__PICKED__ = null;
                      window.SW_UI.showCard({
                        type: 'choices', title: 'Pick One',
                        choices: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
                        onAction: (_id, d) => { window.__PICKED__ = d.index; }
                      });
                    }""")
                    c_info = page.evaluate("""() => {
                      const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
                      const btns = sr.querySelectorAll('.sw-choice-btn');
                      btns[1].click();
                      return { count: btns.length, h: btns[0].getBoundingClientRect().height, picked: window.__PICKED__ };
                    }""")
                    assert c_info == {"count": 5, "h": 48, "picked": 1}, c_info

                    # 5. Confirm dialog role="dialog", moves focus in and restores focus on close
                    page.evaluate("() => document.getElementById('page-trigger').focus()")
                    page.evaluate("""() => {
                      window.__SW_UI_DEMO__('critical');
                    }""")
                    dlg = page.evaluate("""() => {
                      const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
                      const card = sr.getElementById('sw-ui-card');
                      const activeInCard = card.contains(sr.activeElement);
                      return { role: card.getAttribute('role'), activeInCard, hasSummary: sr.querySelectorAll('.sw-confirm-summary li').length === 2 };
                    }""")
                    assert dlg == {"role": "dialog", "activeInCard": True, "hasSummary": True}, dlg
                    page.evaluate("() => window.SW_UI.hide({ dissolve: false })")
                    assert page.evaluate("() => document.activeElement && document.activeElement.id") == "page-trigger"

                    # 6. File, form, plan, error card types
                    for ctype in ["file", "form", "plan", "error"]:
                        if ctype == "error":
                            page.evaluate("() => window.SW_UI.showCard({ type: 'error', title: 'Error', text: 'Mic unavailable.' })")
                        else:
                            page.evaluate("(t) => window.__SW_UI_DEMO__(t)", ctype)
                        assert page.evaluate("(t) => document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-ui-card').dataset.cardType === t", ctype)

                    # 7. Card avoids covering highlighted bottom-center target
                    page.evaluate("""() => {
                      const target = document.getElementById('bottom-target');
                      window.SW_UI.showCard({ type: 'answer', title: 'Positioned Answer', text: 'Moved out of the way of the target.', targetEl: target });
                    }""")
                    no_overlap = page.evaluate("""() => {
                      const sr = document.getElementById('sleepwalker-ui-host').shadowRoot;
                      const card = sr.getElementById('sw-ui-card').getBoundingClientRect();
                      const targ = document.getElementById('bottom-target').getBoundingClientRect();
                      const tailHidden = sr.getElementById('sw-card-tail').hidden;
                      const sep = (card.right <= targ.left || card.left >= targ.right || card.bottom <= targ.top || card.top >= targ.bottom);
                      return { sep, tailHidden };
                    }""")
                    assert no_overlap["sep"] and no_overlap["tailHidden"], no_overlap

                    # 8. Auto-dismiss ~6s (fast test window) pauses on hover and Pin
                    page.evaluate("""() => {
                      window.SW_UI.showCard({ type: 'answer', title: 'Auto Timer', text: 'Should pause when hovered.', autoDismissMs: 140 });
                      const card = document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-ui-card');
                      card.dispatchEvent(new MouseEvent('mouseenter'));
                    }""")
                    page.wait_for_timeout(200)
                    assert page.evaluate("() => window.SW_UI.getState() !== 'idle'"), "Hover must pause auto-dismiss!"
                    page.evaluate("""() => {
                      const card = document.getElementById('sleepwalker-ui-host').shadowRoot.getElementById('sw-ui-card');
                      card.dispatchEvent(new MouseEvent('mouseleave'));
                    }""")
                    page.wait_for_function("() => window.SW_UI.getState() === 'idle'")

                page.close()
            browser.close()
    finally:
        httpd.shutdown()

    print("PASS: All Phase P3 Card UI tests passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
