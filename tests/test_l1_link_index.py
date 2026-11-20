"""
Headless Chromium + Playwright verification for Phase L1 (link-index.js + window.__SW_LINKS__).
Run with: python tests/test_l1_link_index.py
"""

import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

IFRAME_HTML = """<!DOCTYPE html>
<html><body>
  <h2>Inside Same-Origin Frame</h2>
  <a id="iframe-link" href="/frame-details">Iframe Details Link</a>
</body></html>"""

MAIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sleepwalker L1 Index Test</title>
  <style>
    .offscreen-junk { position: fixed; top: -500px; left: -500px; width: 40px; height: 20px; }
    .zero-box { width: 0; height: 0; padding: 0; border: 0; overflow: hidden; display: inline-block; }
    .pointer-tab { cursor: pointer; display: inline-block; padding: 4px; }
    .card { border: 1px solid #ccc; padding: 8px; margin: 8px 0; }
  </style>
</head>
<body>
  <header>
    <nav aria-label="Main Menu">
      <a id="nav-home" href="/home-portal">Home</a>
      <a id="nav-ext" href="https://example.org/docs" target="_blank">External Docs</a>
      <a id="nav-dl" href="/files/brochure.pdf" download>Brochure</a>
      <a id="nav-logout" href="/logout">Log out</a>
    </nav>
  </header>

  <main>
    <section class="card" aria-label="Scholarships">
      <h2>Scholarships 2026</h2>
      <p>Apply for merit scholarship grants before deadline.</p>
      <input type="password" value="SecretPassL1" aria-label="Secret Field">
      <input type="hidden" value="HiddenToken99">
      <a id="card-readmore" href="/tomorrow-show?token=secretQuery">Read more</a>
    </section>

    <div class="actions">
      <button id="btn-img" type="button"><img src="" alt="Download Receipt"></button>
      <span id="role-tab" role="tab">Eligibility Tab</span>
      <span id="onclick-span" onclick="window.__clicked = true">Quick Action</span>
      <div id="pointer-div" tabindex="0" class="pointer-tab">Custom Pointer Tile</div>
      <div id="nonpointer-div" tabindex="0">Passive Tabindex Box</div>
      <input id="input-submit" type="submit" value="Submit Form">
      <button id="aria-icon" type="button" aria-label="Search Portal"></button>
    </div>

    <div id="shadow-host"></div>
    <iframe id="same-origin-frame" src="/iframe.html" width="300" height="80"></iframe>

    <!-- Duplicates & Forbidden Elements -->
    <footer>
      <a id="dup-home" href="/home-portal">Home</a>
      <a id="hidden-link" href="/secret-a" style="display:none">Hidden Display Link</a>
      <a id="attr-hidden" href="/secret-b" hidden>Hidden Attribute Link</a>
      <button id="zero-btn" class="zero-box" type="button">Zero Size</button>
      <button id="disabled-btn" type="button" disabled>Disabled Button</button>
      <a id="aria-hidden-link" href="/secret-c" aria-hidden="true">Aria Hidden Link</a>
      <a id="offscreen-fixed" href="/junk" class="offscreen-junk">Offscreen Junk</a>
    </footer>
  </main>

  <div id="sleepwalker-host"><button type="button">Internal Widget Button</button></div>

  <script>
    const host = document.getElementById('shadow-host');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<button id="shadow-btn" type="button">Shadow Action Button</button>';
  </script>
</body>
</html>"""


def make_handler(root_dir: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root_dir), **kwargs)

        def log_message(self, format, *args):
            return

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/l1-fixture.html":
                data = MAIN_HTML.encode("utf-8")
            elif path == "/iframe.html":
                data = IFRAME_HTML.encode("utf-8")
            else:
                return super().do_GET()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(ROOT))
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 720})
            page.goto(f"http://127.0.0.1:{port}/l1-fixture.html", wait_until="load")
            page.add_script_tag(url=f"http://127.0.0.1:{port}/link-index.js")

            report = page.evaluate("""() => {
              const rows = window.__SW_LINKS__();
              const targets = window.SleepwalkerLinkIndexInstance.getTargets();
              const byLabel = Object.fromEntries(targets.map((t) => [t.label, t]));
              return {
                count: targets.length,
                rowCount: rows.length,
                labels: targets.map((t) => t.label),
                allContext: targets.map((t) => t.context).join(' | '),
                readMore: {
                  area: byLabel['Read more'] && byLabel['Read more'].area,
                  hrefWords: byLabel['Read more'] && byLabel['Read more'].hrefWords,
                  context: byLabel['Read more'] && byLabel['Read more'].context,
                  snippetLen: byLabel['Read more'] ? byLabel['Read more'].contextSnippet.length : -1,
                },
                extFlags: byLabel['External Docs'] && byLabel['External Docs'].flags,
                dlFlags: byLabel['Brochure'] && byLabel['Brochure'].flags,
                logoutFlags: byLabel['Log out'] && byLabel['Log out'].flags,
                submitFlags: byLabel['Submit Form'] && byLabel['Submit Form'].flags,
                roleTab: byLabel['Eligibility Tab'] && byLabel['Eligibility Tab'].role,
                homeArea: byLabel['Home'] && byLabel['Home'].area,
              };
            }""")

            labels = report["labels"]
            for expected in [
                "Home", "External Docs", "Brochure", "Log out",
                "Read more", "Download Receipt", "Eligibility Tab", "Quick Action",
                "Custom Pointer Tile", "Submit Form", "Search Portal",
                "Shadow Action Button", "Iframe Details Link"
            ]:
                assert expected in labels, f"Missing expected target {expected} in {labels}"

            for forbidden in [
                "Secret Field", "Hidden Display Link", "Hidden Attribute Link",
                "Zero Size", "Disabled Button", "Aria Hidden Link",
                "Offscreen Junk", "Passive Tabindex Box", "Internal Widget Button"
            ]:
                assert forbidden not in labels, f"Forbidden element indexed: {forbidden}"

            assert labels.count("Home") == 1, f"Duplicate Home not deduped: {labels}"
            assert "SecretPassL1" not in report["allContext"] and "HiddenToken99" not in report["allContext"]
            assert "secretQuery" not in report["readMore"]["hrefWords"], report["readMore"]
            assert report["readMore"]["hrefWords"] == "tomorrow show", report["readMore"]
            assert report["readMore"]["area"] == "card", report["readMore"]
            assert "Scholarships 2026" in report["readMore"]["context"], report["readMore"]
            assert report["readMore"]["snippetLen"] <= 120, report["readMore"]
            assert report["extFlags"]["external"] and report["extFlags"]["newTab"], report["extFlags"]
            assert report["dlFlags"]["download"], report["dlFlags"]
            assert report["logoutFlags"]["risky"], report["logoutFlags"]
            assert report["submitFlags"]["risky"], report["submitFlags"]
            assert report["roleTab"] == "tab", report["roleTab"]
            assert report["homeArea"] == "nav", report["homeArea"]
            print("PASS  L1 scan (shadows, same-origin iframe, skips, dedupe, hrefWords, context<=120, flags)")

            # Lazy mutation rebuild check (MutationObserver + 300ms debounce / dirty flag)
            page.evaluate("""() => {
              const a = document.createElement('a');
              a.id = 'late-link';
              a.href = '/added-later';
              a.textContent = 'Added Dynamic Link';
              document.querySelector('main').appendChild(a);
            }""")
            after_mut = page.evaluate("() => window.__SW_LINKS__().map((r) => r.label)")
            assert "Added Dynamic Link" in after_mut, "Index must rebuild after DOM mutation"
            print("PASS  L1 lazy DOM mutation rebuild & __SW_LINKS__() table")

            # 300-target cap preferring viewport & main content
            cap_check = page.evaluate("""() => {
              const container = document.createElement('div');
              container.style.marginTop = '3000px';
              for (let i = 0; i < 340; i++) {
                const a = document.createElement('a');
                a.href = '/bulk-' + i;
                a.textContent = 'Bulk Link ' + i;
                container.appendChild(a);
              }
              document.body.appendChild(container);
              const targets = window.SleepwalkerLinkIndexInstance.getTargets(true);
              const labels = targets.map((t) => t.label);
              return {
                count: targets.length,
                hasInViewportMain: labels.includes('Read more') && labels.includes('Submit Form'),
                hasFooterBulk: labels.filter((l) => l.startsWith('Bulk Link ')).length
              };
            }""")
            assert cap_check["count"] == 300, cap_check
            assert cap_check["hasInViewportMain"], cap_check
            print("PASS  L1 300-target cap prefers viewport & main content")

            browser.close()
    finally:
        server.shutdown()

    print("\nALL L1 LINK-INDEX ASSERTIONS PASSED (3/3).")


if __name__ == "__main__":
    main()
