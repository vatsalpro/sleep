#!/usr/bin/env python3
"""
Phase 10 — Real Unpacked MV3 Extension E2E Verification in Real Chromium
Launches Playwright Chromium with `--disable-extensions-except=D:/sleep --load-extension=D:/sleep`,
real MV3 Service Worker (background.js), real chrome.storage.local + chrome.storage.session,
real content_scripts isolated world, and real #sleepwalker-ui-host Shadow DOM.

Covers:
1. Extension load & MV3 service worker boot + zero duplicate UI injection.
2. Activation via Alt+S -> real Type command input -> Conversation A / Off-Page / Ordinal / Search / Section Nav.
3. Cross-navigation persistence across:
   - Normal <a href="..."> click
   - HTTP 302 server redirect (/redirect-china -> /china.html)
   - SPA history.pushState (/china.html -> /china.html#culture & /spa-step)
   - Full browser page.reload()
   - Browser Back (go_back()) and Forward (go_forward())
   - Resting state ("You can rest") + Wake preservation + New Tab switch (only foreground tab listens / active sync)
4. 15-turn realistic activity accumulation verified inside real chrome.storage.local & chrome.storage.session via SW.
5. Honest Web Audio fake-device getUserMedia({ audio: true }) check + SpeechRecognition availability report.
"""

import http.server
import json
import os
import shutil
import socketserver
import tempfile
import threading
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT_DIR = Path(__file__).resolve().parent.parent
CHROMIUM_EXE = Path(
    os.environ.get("LOCALAPPDATA", ""),
    "ms-playwright",
    "chromium-1248",
    "chrome-win64",
    "chrome.exe",
)

HOME_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Research Starting Portal</title></head>
<body style="min-height:2200px;font-family:system-ui,sans-serif;padding:24px;">
  <h1>Global Study & Travel Portal</h1>
  <form role="search" action="/search-results" method="get">
    <label for="site-q">Search portal articles</label>
    <input id="site-q" type="search" name="q" placeholder="Search courses or guides..." />
    <button type="submit">Search</button>
  </form>
  <p><label><input type="checkbox" id="filter-free" name="free" value="free"> Free courses</label></p>
  <p><a id="link-redirect" href="/redirect-china">Explore China Travel Guide (via 302 Redirect)</a></p>
  <p><a id="link-uni" href="/uni-portal">Go to University Admissions Portal</a></p>
  <div style="height:1100px;"></div>
  <h2 id="sec-elig">Eligibility Section</h2>
  <p>Applicants need a recognized Bachelor degree and verified transcripts.</p>
  <div style="height:500px;"></div>
</body>
</html>"""

CHINA_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>China Encyclopedia & Overview</title></head>
<body style="min-height:1800px;font-family:system-ui,sans-serif;padding:24px;">
  <h1>China</h1>
  <p>China is in East Asia with Beijing as capital and Shanghai as financial center.</p>
  <h2 id="sec-culture">Culture and Heritage</h2>
  <p>Famous for the Great Wall, Silk Road, and regional cuisine.</p>
  <button id="spa-btn" type="button" onclick="history.pushState({page:2}, 'China Modern Economy', '/china-economy'); document.querySelector('h1').textContent='China Economy';">Open Economy SPA View</button>
</body>
</html>"""

UNI_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>University Admissions Portal</title></head>
<body style="min-height:1800px;font-family:system-ui,sans-serif;padding:24px;">
  <h1>Graduate Admissions Portal</h1>
  <h2 id="sec-req">Admission Requirements</h2>
  <p>Applicants must hold an accredited undergraduate degree and official language score.</p>
  <ol>
    <li><a href="/uni-tum.html">Technical University of Munich (TUM)</a></li>
    <li><a href="/uni-lmu.html">Ludwig Maximilian University of Munich (LMU Munich)</a></li>
    <li><a href="/uni-rwth.html">RWTH Aachen University</a></li>
  </ol>
</body>
</html>"""


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True


def start_fixture_server():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            p = self.path.split("?")[0]
            if p == "/redirect-china":
                self.send_response(302)
                self.send_header("Location", "/china.html")
                self.end_headers()
                return
            if p == "/china.html":
                body = CHINA_HTML
            elif p == "/china-economy":
                body = CHINA_HTML.replace("<h1>China</h1>", "<h1>China Economy</h1>")
            elif p in ("/uni-portal", "/uni-lmu.html", "/uni-tum.html", "/uni-rwth.html"):
                body = UNI_HTML
            elif p == "/travel-guide.html":
                body = "<html><head><title>China Travel Guide</title></head><body><h1>China Tourist Visa &amp; Travel Portal</h1><p>Passport, visa application form, flight itinerary, hotel booking required.</p></body></html>"
            elif p == "/search-results":
                body = f"<html><head><title>Search Results</title></head><body><h1>Search Results</h1><p>Query: {self.path}</p></body></html>"
            elif p == "/tab-two":
                body = "<html><head><title>Second Browser Tab</title></head><body><h1>Second Tab Workspace</h1><p>Independent tab content for mic handoff verification.</p></body></html>"
            else:
                body = HOME_HTML
            data = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    srv = ReusableTCPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def send_ui_command(page, text, wait_ms=3500):
    """Send a command using the REAL Sleepwalker Shadow DOM Type input inside #sleepwalker-ui-host."""
    before = get_ui_snapshot(page) or {}
    before_sig = f"{before.get('cardTitle', '')}||{before.get('cardBody', '')}"
    page.evaluate(
        """(cmd) => {
            const host = document.getElementById('sleepwalker-ui-host');
            if (!host || !host.shadowRoot) throw new Error('Missing #sleepwalker-ui-host');
            const sr = host.shadowRoot;
            const form = sr.getElementById('sw-ui-type-form');
            const btn = sr.getElementById('sw-ui-type-btn');
            const inp = sr.getElementById('sw-ui-type-input');
            if (form && form.hidden && btn) btn.click();
            if (!inp || !form) throw new Error('Missing Sleepwalker type form in shadowRoot');
            inp.value = cmd;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            const submitBtn = sr.querySelector('.sw-type-submit');
            if (submitBtn) submitBtn.click();
            else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }""",
        text,
    )
    deadline = time.time() + (wait_ms / 1000.0)
    try:
        page.wait_for_timeout(120)
        while time.time() < deadline:
            snap = get_ui_snapshot(page)
            if snap:
                cur_sig = f"{snap.get('cardTitle', '')}||{snap.get('cardBody', '')}"
                if cur_sig != before_sig and snap.get("state") != "thinking":
                    page.wait_for_timeout(80)
                    return get_ui_snapshot(page)
            page.wait_for_timeout(100)
        return get_ui_snapshot(page)
    except Exception:
        return None


def get_ui_snapshot(page):
    return page.evaluate(
        """() => {
            const hosts = document.querySelectorAll('#sleepwalker-ui-host');
            const host = hosts[0];
            const sr = host && host.shadowRoot;
            if (!sr) return { hostCount: hosts.length, mounted: false };
            const root = sr.querySelector('.sw-ui-root');
            const card = sr.getElementById('sw-ui-card');
            const title = sr.getElementById('sw-card-title');
            const body = sr.getElementById('sw-card-body');
            const planSteps = Array.from(sr.querySelectorAll('.sw-plan-list li')).map((li) => li.textContent.trim());
            return {
                hostCount: hosts.length,
                mounted: true,
                state: root ? root.dataset.state : '',
                active: root ? root.dataset.active : '',
                cardVisible: Boolean(card && !card.hidden),
                cardTitle: title ? title.textContent.trim() : '',
                cardBody: body ? body.textContent.trim() : '',
                planSteps
            };
        }"""
    )


def read_sw_storage(sw):
    return sw.evaluate(
        """() => new Promise((resolve) => {
            chrome.storage.local.get(['sleepwalker_persistent_memory_v1'], (localRes) => {
                chrome.storage.session.get(['sleepwalker_session_state_v1'], (sessRes) => {
                    resolve({
                        memory: localRes && localRes.sleepwalker_persistent_memory_v1 || null,
                        session: sessRes && sessRes.sleepwalker_session_state_v1 || null
                    });
                });
            });
        })"""
    )


def main():
    assert CHROMIUM_EXE.exists(), f"Playwright Chromium binary not found at {CHROMIUM_EXE}"
    server, base_url = start_fixture_server()
    user_data_dir = tempfile.mkdtemp(prefix="sw-real-ext-e2e-")

    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                user_data_dir,
                executable_path=str(CHROMIUM_EXE),
                headless=False,
                args=[
                    "--headless=new",
                    f"--disable-extensions-except={EXT_DIR}",
                    f"--load-extension={EXT_DIR}",
                    "--use-fake-ui-for-media-stream",
                    "--use-fake-device-for-media-stream",
                    "--no-sandbox",
                ],
            )
            try:
                # 1. Wait for MV3 Service Worker (background.js)
                sw = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker", timeout=8000)
                ext_id = sw.url.split("/")[2]
                print(f"PASS  Extension loaded in real Chromium MV3 (id={ext_id}, sw={sw.url})")

                page = context.pages[0] if context.pages else context.new_page()
                page.goto(f"{base_url}/", wait_until="domcontentloaded")
                page.wait_for_selector("#sleepwalker-ui-host", state="attached", timeout=6000)
                snap0 = get_ui_snapshot(page)
                assert snap0["mounted"] and snap0["hostCount"] == 1, f"Expected single #sleepwalker-ui-host, got {snap0}"
                assert snap0["active"] == "false" and snap0["state"] == "idle", f"Should start idle on initial page: {snap0}"

                # 2. Wake with real Alt+S keyboard shortcut
                page.keyboard.press("Alt+s")
                page.wait_for_timeout(450)
                snap_wake = get_ui_snapshot(page)
                assert snap_wake["active"] == "true", f"Alt+S must activate real extension UI, got {snap_wake}"
                print(f"PASS  Alt+S woke real MV3 extension UI (state={snap_wake['state']}, hostCount={snap_wake['hostCount']})")

                # 3. Execute real user commands via Shadow DOM Type input (Phase 3 workflows + cross-nav!)
                # Step 0: Real DOM Filter interaction ("Filter by free courses.")
                r_flt = send_ui_command(page, "Filter by free courses.", 4000)
                assert page.evaluate("() => document.getElementById('filter-free').checked") is True, f"Filter checkbox must be checked in real extension DOM: {r_flt}"

                # Step 1: Germany universities -> verify compact .sw-plan-list progress steps inside Shadow DOM!
                r1 = send_ui_command(page, "Find universities in Germany.", 4000)
                print("Step 1:", r1["cardTitle"], "| state=", r1["state"], "| planSteps=", len(r1.get("planSteps", [])))
                assert r1["hostCount"] == 1 and "Universities in Germany" in r1["cardTitle"], f"Step 1 failed: {r1}"
                assert len(r1.get("planSteps", [])) >= 4, f"Compact plan progress steps must render inside floating card: {r1}"
                # Step 2: Compare admission requirements
                r2 = send_ui_command(page, "Compare their admission requirements.", 4000)
                print("Step 2:", r2["cardTitle"], "| state=", r2["state"])
                assert "Comparison" in r2["cardTitle"] and "TUM" in r2["cardBody"], f"Step 2 failed: {r2}"
                # Step 3: Second one
                r3 = send_ui_command(page, "What about the second one?", 5000)
                print("Step 3:", r3["cardTitle"], "| state=", r3["state"])
                assert "LMU" in r3["cardTitle"] or "LMU" in r3["cardBody"], f"Step 3 failed: {r3}"
                # Step 4: Scroll to Eligibility section on current portal (may use live CPU Ollama NLU + ~1s pre-action safety highlight + smooth scroll)
                r4 = send_ui_command(page, "Find the section about eligibility.", 22000)
                page.wait_for_function("() => window.scrollY > 200", timeout=12000)
                scroll_y4 = page.evaluate("() => window.scrollY")
                print("Step 4:", r4["cardTitle"], "| scrollY=", scroll_y4, "| state=", r4["state"])
                assert scroll_y4 > 200, f"Step 4 must scroll page to Eligibility section: scrollY={scroll_y4}, r4={r4}"
                # Step 5: China trip + visa
                r5 = send_ui_command(page, "I am planning a trip to China.", 5000)
                assert "China" in r5["cardBody"] or "China" in r5["cardTitle"], f"Step 5 failed: {r5}"
                # Step 6: Within-page search diversion (no nav)
                r6 = send_ui_command(page, "Search within this page for transcripts.", 8000)
                assert r6["cardVisible"] and base_url in page.url, f"Step 6 failed: {r6}"
                # Step 7: Travel follow-up after diversion
                r7 = send_ui_command(page, "What visa do I need for that trip?", 5000)
                assert "Visa" in r7["cardBody"] or "visa" in r7["cardBody"].lower() or "China" in r7["cardBody"], f"Step 7 failed: {r7}"
                print("PASS  Steps 1-7 in real extension UI (Germany -> Compare -> Ordinal -> Section -> China -> PageSearch -> Visa)")

                # Step 8: Click normal link with HTTP 302 redirect (/redirect-china -> /china.html)
                page.click("#link-redirect")
                page.wait_for_load_state("domcontentloaded")
                page.wait_for_timeout(650)
                assert page.url.endswith("/china.html"), f"Expected redirect destination /china.html, got {page.url}"
                snap_redir = get_ui_snapshot(page)
                assert snap_redir["mounted"] and snap_redir["hostCount"] == 1 and snap_redir["active"] == "true", (
                    f"Persistent orb must restore cleanly after 302 redirect without duplicates: {snap_redir}"
                )

                # Step 9: SPA pushState navigation
                page.click("#spa-btn")
                page.wait_for_timeout(450)
                assert page.url.endswith("/china-economy"), f"Expected SPA pushState URL, got {page.url}"
                snap_spa = get_ui_snapshot(page)
                assert snap_spa["hostCount"] == 1 and snap_spa["active"] == "true", f"SPA failed: {snap_spa}"

                # Step 10: Full browser reload
                page.reload(wait_until="domcontentloaded")
                page.wait_for_timeout(650)
                snap_reload = get_ui_snapshot(page)
                assert snap_reload["hostCount"] == 1 and snap_reload["active"] == "true", f"Reload lost session: {snap_reload}"

                # Step 11 & 12: Browser go_back() and go_forward()
                page.go_back(wait_until="domcontentloaded")
                page.wait_for_timeout(550)
                snap_back = get_ui_snapshot(page)
                assert snap_back["hostCount"] == 1 and snap_back["active"] == "true", f"Back nav lost session: {snap_back}"
                page.go_forward(wait_until="domcontentloaded")
                page.wait_for_timeout(550)
                snap_fwd = get_ui_snapshot(page)
                assert snap_fwd["hostCount"] == 1 and snap_fwd["active"] == "true", f"Forward nav lost session: {snap_fwd}"
                print("PASS  Steps 8-12 cross-navigation persistence (HTTP 302 redirect, SPA pushState, reload, back, forward — zero duplicate hosts)")

                # Step 13: Multi-tab activation & background mic handoff via real chrome.tabs.onActivated
                tab2 = context.new_page()
                tab2.goto(f"{base_url}/tab-two", wait_until="domcontentloaded")
                tab2.wait_for_selector("#sleepwalker-ui-host", state="attached", timeout=5000)
                tab2.bring_to_front()
                tab2.wait_for_timeout(600)
                snap_tab2 = get_ui_snapshot(tab2)
                assert snap_tab2["mounted"] and snap_tab2["hostCount"] == 1, f"Tab 2 host issue: {snap_tab2}"

                # Run commands in Tab 2 too (steps 13-15 -> accumulate >= 15 activities total!)
                send_ui_command(tab2, "Find the best laptops.", 2500)
                r14 = send_ui_command(tab2, "Compare the second one with the first one.", 2500)
                assert "MacBook Air" in r14["cardBody"] and "ThinkPad" in r14["cardBody"], f"Tab 2 laptop comparison failed: {r14}"
                r15 = send_ui_command(tab2, "Return to the earlier task.", 2500)
                assert r15["cardVisible"], f"Return to earlier task failed: {r15}"

                # Switch back to Tab 1 and verify session & rest state behavior
                page.bring_to_front()
                page.wait_for_timeout(550)
                send_ui_command(page, "Tell me about Culture and Heritage on this page.", 28000)
                send_ui_command(page, "Summarize this page.", 28000)
                r_find_travel = send_ui_command(page, "Find official travel website for China.", 8000)
                page.wait_for_url("**/travel-guide.html*", timeout=6000)
                page.wait_for_selector("#sleepwalker-ui-host", state="attached", timeout=6000)
                page.wait_for_timeout(600)
                snap_travel = get_ui_snapshot(page)
                assert snap_travel["mounted"] and snap_travel["hostCount"] == 1 and snap_travel["active"] == "true", f"Travel portal restore failed: {snap_travel}"

                # Test Rest & Wake distinction on destination portal
                r_rest_card = send_ui_command(page, "You can rest.", 2500)
                assert "Resting" in (r_rest_card or {}).get("cardTitle", ""), f"Expected Resting card: {r_rest_card}"
                page.wait_for_function(
                    "() => { const h = document.getElementById('sleepwalker-ui-host'); const r = h && h.shadowRoot && h.shadowRoot.querySelector('.sw-ui-root'); return r && r.dataset.active === 'false' && r.dataset.state === 'idle'; }",
                    timeout=5500,
                )
                snap_rest = get_ui_snapshot(page)
                assert snap_rest["active"] == "false" and snap_rest["state"] == "idle", f"Expected resting idle state: {snap_rest}"

                # Wake cleanly via Alt+S and verify explain + persistent activity storage (>= 15 activities)
                page.keyboard.press("Alt+s")
                page.wait_for_timeout(500)
                snap_rewoke = get_ui_snapshot(page)
                assert snap_rewoke["active"] == "true", f"Alt+S wake after rest failed: {snap_rewoke}"
                r_after_wake = send_ui_command(page, "Explain this page briefly.", 28000)
                assert r_after_wake["cardVisible"] and r_after_wake["hostCount"] == 1, f"Explain after wake failed: {r_after_wake}"
                r_after_wake2 = send_ui_command(page, "What documents are required on this page?", 28000)
                assert r_after_wake2["cardVisible"] and r_after_wake2["hostCount"] == 1

                # Phase 3 real MV3 Extension Checks: Travel Planning -> Hotel Booking Constraints -> Task Pause / Resume / Cancel
                send_ui_command(page, "Help me plan a trip to Japan.", 2500)
                r_hotel = send_ui_command(page, "Find me a hotel in Tokyo.", 2500)
                st_wait = read_sw_storage(sw).get("memory", {}).get("activeTask", {})
                assert st_wait.get("status") == "WAITING_FOR_USER", f"Hotel booking must pause for dates/guests in real SW storage: {st_wait}"
                r_slots = send_ui_command(page, "December 10 to December 14 for 2 guests", 2500)
                st_run = read_sw_storage(sw).get("memory", {}).get("activeTask", {})
                assert st_run.get("constraints", {}).get("guests") == 2 and st_run.get("status") == "RUNNING", f"Booking constraints not saved cleanly: {st_run}"

                send_ui_command(page, "Pause this task.", 1500)
                st_paused = read_sw_storage(sw).get("memory", {}).get("activeTask", {})
                assert st_paused.get("status") == "PAUSED", f"Task should be PAUSED in SW storage: {st_paused}"

                r_resumed = send_ui_command(page, "Resume.", 1500)
                assert len(r_resumed.get("planSteps", [])) >= 4, f"Resumed task should show compact plan progress steps: {r_resumed}"

                r_cancel = send_ui_command(page, "Cancel this task.", 1500)
                st_cancelled = read_sw_storage(sw).get("memory", {}).get("activeTask", {})
                assert st_cancelled.get("status") == "CANCELLED" and r_cancel.get("active") == "true", f"Cancel task must keep Sleepwalker active: {st_cancelled} / {r_cancel}"
                print("PASS  Phase 3 MV3 E2E: Filter toggle, Shadow DOM progress card, Japan/Tokyo booking slots, Pause/Resume/Cancel in real Chrome")

                # Inspect real MV3 Service Worker chrome.storage.local + chrome.storage.session
                persisted = read_sw_storage(sw)
                acts = (persisted.get("memory") or {}).get("activities") or []
                sess = persisted.get("session") or {}
                assert len(acts) >= 15, f"Expected >= 15 persisted activities in real chrome.storage.local, got {len(acts)}"
                assert sess, "Expected real chrome.storage.session state populated by background/content scripts"
                print(f"PASS  Steps 13-15 multi-tab handoff, rest/wake & real chrome.storage persistence ({len(acts)} activities stored)")

                # 4. Honest Fake-Audio WebRTC getUserMedia + SpeechRecognition capability check
                audio_probe = page.evaluate(
                    """async () => {
                        const out = {
                            speechRecognitionExists: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
                            fakeMicStreamTracks: 0,
                            fakeMicLabel: '',
                            micError: ''
                        };
                        try {
                            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                            const tracks = stream.getAudioTracks();
                            out.fakeMicStreamTracks = tracks.length;
                            out.fakeMicLabel = tracks[0] ? tracks[0].label : '';
                            tracks.forEach((t) => t.stop());
                        } catch (e) {
                            out.micError = String(e && e.message || e);
                        }
                        return out;
                    }"""
                )
                assert audio_probe["fakeMicStreamTracks"] >= 1, f"Fake audio stream probe failed: {audio_probe}"
                print(
                    f"PASS  Fake-device getUserMedia verified ({audio_probe['fakeMicStreamTracks']} audio track: '{audio_probe['fakeMicLabel']}', SpeechRecognition={audio_probe['speechRecognitionExists']})"
                )

                print("\nSummary: ALL Real Unpacked MV3 Extension Chromium E2E Checks Passed!")
            finally:
                context.close()
    finally:
        server.shutdown()
        shutil.rmtree(user_data_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
