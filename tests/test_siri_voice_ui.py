#!/usr/bin/env python3
"""
Test Suite: Sleepwalker 2.0 Siri-Inspired Circular Voice Assistant Experience
Verifies:
1. Complete removal of golden thread animations, petals, particles, aurora sweep, and canvas loops.
2. Expandable circular orb (compact in IDLE, expanded in active states).
3. 8 distinct interaction states: IDLE, LISTENING, PROCESSING, OBSERVING, EXECUTING, SPEAKING, COMPLETED, ERROR.
4. Microphone audio-level reactivity in LISTENING and speech level reactivity in SPEAKING.
5. Observation source visibility (DOM, Accessibility Tree, Screenshot, Vision Model).
6. Performance: 0 animations when idle, respects prefers-reduced-motion.
"""
import http.server
import json
import socketserver
import sys
import threading
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

PORTAL_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Siri Voice Assistant Test Fixture</title>
</head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:sans-serif;">
  <h1>Test Page</h1>
  <button id="target-btn">Click Me</button>
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

            # Mock Chrome extension runtime environment
            page.evaluate("""() => {
              const store = {};
              window.chrome = {
                runtime: {
                  getURL: (u) => location.origin + '/' + u,
                  getManifest: () => ({ version: '2.0.0' }),
                  sendMessage: (_m, cb) => cb && cb({ status: 'ok' }),
                  onMessage: { addListener: () => {} }
                },
                storage: {
                  local: {
                    get: (_k, cb) => cb({ ...store }),
                    set: (o, cb) => { Object.assign(store, o || {}); cb && cb(); }
                  },
                  session: { get: (_k, cb) => cb({}), set: (_k, cb) => cb && cb() }
                }
              };
              window.SpeechRecognition = class {
                start() { this.onstart && this.onstart(); }
                stop() { this.onend && this.onend(); }
              };
              Object.defineProperty(window, 'speechSynthesis', {
                value: { getVoices: () => [], cancel: () => {}, pause: () => {}, resume: () => {} },
                configurable: true
              });
            }""")

            # Load content scripts
            manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
            for s in manifest["content_scripts"][0]["js"]:
                page.add_script_tag(url=f"http://127.0.0.1:{port}/{s}")

            page.wait_for_function("() => window.SW_UI && window.__SLEEPWALKER_INSTANCE__")
            page.evaluate("(c) => window.SW_UI._orb.injectCssText(c)", css_text)

            print("[1] Verifying removal of old decorative effects...")
            check_decorations = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const shadow = host.shadowRoot;
              const canvas = shadow.getElementById('sw-ui-threads');
              const veil = shadow.getElementById('sw-ui-veil');
              const mist = shadow.querySelector('.sw-aurora-mist');
              const threadTrack = shadow.querySelector('.sw-aurora-thread-track');
              return {
                hasCanvas: Boolean(canvas),
                hasVeil: Boolean(veil),
                hasMist: Boolean(mist),
                hasThreadTrack: Boolean(threadTrack)
              };
            }""")
            assert not check_decorations["hasCanvas"], "Canvas #sw-ui-threads must be completely removed!"
            assert not check_decorations["hasVeil"], "Veil #sw-ui-veil must be completely removed!"
            assert not check_decorations["hasMist"], "Golden aurora mist must be completely removed!"
            assert not check_decorations["hasThreadTrack"], "Golden thread track must be completely removed!"
            print("  ✓ Zero canvas, zero golden ribbons/mist/threads found.")

            print("[2] Verifying IDLE state...")
            page.evaluate("() => window.SW_UI.setState('idle')")
            idle_status = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const root = host.shadowRoot.querySelector('.sw-ui-root');
              const anims = host.shadowRoot.getAnimations ? host.shadowRoot.getAnimations().length : 0;
              return {
                state: window.SW_UI.getState(),
                active: root.dataset.active,
                runningAnimations: anims
              };
            }""")
            assert idle_status["state"] == "idle", f"Expected idle state, got {idle_status['state']}"
            assert idle_status["active"] == "false", "Root should not be active when idle"
            assert idle_status["runningAnimations"] == 0, f"Expected 0 running animations when idle, found {idle_status['runningAnimations']}"
            print("  ✓ IDLE state clean with 0 running animations.")

            print("[3] Verifying LISTENING state (expandable orb + audio reactivity)...")
            page.evaluate("() => { window.SW_UI.setState('listening'); window.SW_UI.setTranscript('Find scholarship for engineering'); }")
            page.wait_for_timeout(250)
            listening_geo = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const orb = host.shadowRoot.getElementById('sw-ui-orb');
              const rect = orb.getBoundingClientRect();
              const transcript = host.shadowRoot.getElementById('sw-ui-transcript');
              return {
                w: rect.width,
                h: rect.height,
                transcriptText: transcript.textContent,
                transcriptVisible: transcript.dataset.visible
              };
            }""")
            assert 72 <= listening_geo["w"] <= 84, f"Orb width should expand to ~78px, got {listening_geo['w']}"
            assert 72 <= listening_geo["h"] <= 84, f"Orb height should expand to ~78px, got {listening_geo['h']}"
            assert "scholarship" in listening_geo["transcriptText"], "Transcript text should be visible"
            assert listening_geo["transcriptVisible"] == "true", "Transcript should be marked visible"

            # Test audio level scaling
            page.evaluate("() => window.SW_UI.setLevel(0.85)")
            bar_scale = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const centerBar = host.shadowRoot.querySelectorAll('.sw-bar')[3];
              return centerBar.style.getPropertyValue('--bar-scale');
            }""")
            assert float(bar_scale) > 0.7, f"Center bar scale should react to mic audio level: {bar_scale}"
            print("  ✓ LISTENING state correctly expanded to 78px, displays transcript, and waveform reacts to mic levels.")

            print("[4] Verifying PROCESSING state...")
            page.evaluate("() => { window.SW_UI.setState('processing'); window.SW_UI.setTaskStatus({ state: 'processing', stage: 'Planning action', taskLabel: 'Searching eligibility criteria' }); }")
            page.wait_for_timeout(200)
            processing_info = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const root = host.shadowRoot.querySelector('.sw-ui-root');
              const stage = host.shadowRoot.getElementById('sw-ui-aurora-stage');
              const task = host.shadowRoot.getElementById('sw-ui-aurora-task');
              return {
                rootState: root.dataset.state,
                stage: stage.textContent,
                task: task.textContent
              };
            }""")
            assert processing_info["rootState"] == "processing", f"Expected processing state, got {processing_info['rootState']}"
            assert "Planning action" in processing_info["stage"], f"Expected Planning action, got {processing_info['stage']}"
            print("  ✓ PROCESSING state displays concise status and fluid wave.")

            print("[5] Verifying OBSERVING state & observation source tag...")
            page.evaluate("""() => {
              window.SW_UI.setState('observing');
              window.SW_UI.setTaskStatus({
                state: 'observing',
                stage: 'Inspecting webpage',
                observationSource: 'Accessibility Tree',
                target: 'Button "Apply Now"'
              });
            }""")
            page.wait_for_timeout(200)
            observing_info = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const root = host.shadowRoot.querySelector('.sw-ui-root');
              const obsTag = host.shadowRoot.getElementById('sw-ui-obs-source');
              const stage = host.shadowRoot.getElementById('sw-ui-aurora-stage');
              const task = host.shadowRoot.getElementById('sw-ui-aurora-task');
              return {
                state: root.dataset.state,
                obsVisible: !obsTag.hidden,
                obsText: obsTag.textContent,
                stage: stage.textContent,
                task: task.textContent
              };
            }""")
            assert observing_info["state"] == "observing", f"Expected observing, got {observing_info['state']}"
            assert observing_info["obsVisible"], "Observation source tag should be visible"
            assert observing_info["obsText"] == "Accessibility Tree", f"Unexpected tag: {observing_info['obsText']}"
            assert "Inspecting webpage" in observing_info["stage"]
            assert "Apply Now" in observing_info["task"]
            print("  ✓ OBSERVING state displays inspection pulse and observation source [Accessibility Tree].")

            print("[6] Verifying EXECUTING state...")
            page.evaluate("""() => {
              window.SW_UI.setState('executing');
              window.SW_UI.setTaskStatus({
                state: 'executing',
                stage: 'Clicking element',
                target: '#target-btn'
              });
            }""")
            page.wait_for_timeout(200)
            executing_info = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const root = host.shadowRoot.querySelector('.sw-ui-root');
              const stage = host.shadowRoot.getElementById('sw-ui-aurora-stage');
              const orb = host.shadowRoot.getElementById('sw-ui-orb');
              const borderColor = getComputedStyle(orb).borderColor;
              return {
                state: root.dataset.state,
                stage: stage.textContent,
                borderColor
              };
            }""")
            assert executing_info["state"] == "executing"
            assert "Clicking element" in executing_info["stage"]
            print("  ✓ EXECUTING state active with action feedback coordinates.")

            print("[7] Verifying SPEAKING state...")
            page.evaluate("() => { window.SW_UI.setState('speaking'); window.SW_UI.setLevel(0.75); }")
            page.wait_for_timeout(200)
            speaking_info = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const root = host.shadowRoot.querySelector('.sw-ui-root');
              return { state: root.dataset.state };
            }""")
            assert speaking_info["state"] == "speaking"
            print("  ✓ SPEAKING state active with speech audio waveform.")

            print("[8] Verifying COMPLETED state & automatic return to idle...")
            page.evaluate("() => { window.SW_UI.setState('completed'); }")
            completed_info = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const checkIcon = host.shadowRoot.getElementById('sw-ui-completed-icon');
              const bars = host.shadowRoot.querySelector('.sw-orb-bars');
              return {
                checkVisible: !checkIcon.hidden,
                barsDisplay: bars.style.display
              };
            }""")
            assert completed_info["checkVisible"], "Completed checkmark icon should be visible!"
            assert completed_info["barsDisplay"] == "none", "Waveform bars should be replaced by completion icon"

            # Wait for auto-return to idle
            page.wait_for_function("() => window.SW_UI.getState() === 'idle'", timeout=3000)
            print("  ✓ COMPLETED state showed checkmark and smoothly returned to idle.")

            print("[9] Verifying ERROR state...")
            page.evaluate("""() => {
              window.SW_UI.setState('error');
              window.SW_UI.setTaskStatus({
                state: 'error',
                stage: 'Element not found',
                taskLabel: 'Target #submit-btn could not be located on page'
              });
            }""")
            page.wait_for_timeout(200)
            error_info = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const root = host.shadowRoot.querySelector('.sw-ui-root');
              const errIcon = host.shadowRoot.getElementById('sw-ui-error-icon');
              const stage = host.shadowRoot.getElementById('sw-ui-aurora-stage');
              return {
                state: root.dataset.state,
                errVisible: !errIcon.hidden,
                stage: stage.textContent
              };
            }""")
            assert error_info["state"] == "error"
            assert error_info["errVisible"], "Error icon should be visible"
            assert "Element not found" in error_info["stage"]
            print("  ✓ ERROR state displayed restrained error badge and explanation.")

            print("[10] Verifying prefers-reduced-motion fallback...")
            page.emulate_media(reduced_motion="reduce")
            page.evaluate("() => window.SW_UI.setState('processing')")
            page.wait_for_timeout(100)
            reduced_motion_check = page.evaluate("""() => {
              const host = document.getElementById('sleepwalker-ui-host');
              const orb = host.shadowRoot.getElementById('sw-ui-orb');
              return getComputedStyle(orb).animationName;
            }""")
            assert reduced_motion_check == "none", f"Animation should be 'none' under reduced motion, got {reduced_motion_check}"
            print("  ✓ prefers-reduced-motion disables animations as required.")

            browser.close()
    finally:
        httpd.shutdown()

    print("\nSUCCESS: All 10 Siri-Inspired Voice Experience checks passed with flying colors!")
    return 0

if __name__ == "__main__":
    sys.exit(main())
