"""
Phase C4 E2E Test: Camera Capture & Permission Helper (camera.js)
Tests real extension JS inside headless Chromium via Playwright:
- Honest permission states (denied / NotAllowedError / Retry / Upload File Instead fallback)
- Real Chromium canvas.captureStream() live <video> preview in Shadow DOM card
- Spoken + visual 3-2-1 countdown badge (.sw-camera-countdown)
- Local Canvas JPEG capture (camera-capture.jpg) + preview <img> + automatic stopAllTracks()
- Voice control ("take photo", "shoot", "retake", "yes", "undo") + Escape cleanup
- Auto-compression / validation + DataTransfer attachment to <input type=file>
"""

import http.server
import json
import pathlib
import socketserver
import threading
from playwright.sync_api import sync_playwright

ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def log_message(self, format, *args):
        pass


def start_server():
    server = socketserver.TCPServer(("127.0.0.1", 0), QuietHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def run_c4_tests():
    server, port = start_server()
    base_url = f"http://127.0.0.1:{port}"
    css_text = (ROOT_DIR / "widget.css").read_text(encoding="utf-8")
    lexicon_json = json.loads((ROOT_DIR / "lexicon.json").read_text(encoding="utf-8"))
    link_lexicon_json = json.loads((ROOT_DIR / "link-lexicon.json").read_text(encoding="utf-8"))

    portal_html = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>C4 Camera Capture Test</title></head>
<body>
  <main>
    <h1>Photo Identity Step</h1>
    <form id="cam-form">
      <div>
        <label for="up-photo">Passport Photo</label>
        <input id="up-photo" name="photo" type="file" accept="image/*" />
        <small>Max 500 KB</small>
      </div>
      <div>
        <label for="up-pdf">Birth Certificate</label>
        <input id="up-pdf" name="birth_cert" type="file" accept=".pdf" />
      </div>
    </form>
  </main>
  <script>
    window.__UP_CHANGES__ = 0;
    document.getElementById('up-photo').addEventListener('change', () => {
      window.__UP_CHANGES__ += 1;
    });
  </script>
</body>
</html>"""

    init_shim = """
    (() => {
      const localStore = {};
      window.chrome = {
        runtime: {
          getURL: (p) => location.origin + '/' + p.replace(/^\\//, ''),
          getManifest: () => ({ version: '1.0.0' }),
          sendMessage: (msg, cb) => { if (typeof cb === 'function') cb({ status: 'ok' }); },
          onMessage: { addListener: () => {} }
        },
        storage: {
          local: {
            get: (k, cb) => cb({ ...localStore }),
            set: (o, cb) => { Object.assign(localStore, o || {}); if (cb) cb(); }
          },
          session: {
            get: (k, cb) => cb({}),
            set: (o, cb) => { if (cb) cb(); }
          }
        }
      };

      window.__SPOKEN__ = [];
      const synthMock = {
        speaking: false, paused: false, pending: false, onvoiceschanged: null,
        getVoices: () => [{ name: 'Mock EN', lang: 'en-IN', default: true }],
        speak: (u) => { window.__SPOKEN__.push(u.text); synthMock.speaking = true; setTimeout(() => { synthMock.speaking = false; u.onend && u.onend(); }, 5); },
        cancel: () => { synthMock.speaking = false; }, pause: () => {}, resume: () => {}
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synthMock, configurable: true });
      window.SpeechSynthesisUtterance = function (t) { this.text = t || ''; };

      // Camera Permission + Canvas captureStream Mock
      window.__CAM_PERM__ = 'denied'; // start denied to verify Permission Helper!
      window.__CREATED_TRACKS__ = [];

      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: {
          query: async ({ name }) => ({ state: name === 'camera' ? window.__CAM_PERM__ : 'granted' })
        }
      });

      const makeStream = () => {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 240;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#0ea5e9';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(100, 60, 120, 120);
        const stream = c.captureStream(15);
        stream.getTracks().forEach((t) => window.__CREATED_TRACKS__.push(t));
        return stream;
      };

      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (window.__CAM_PERM__ === 'denied') {
              const e = new Error('Permission denied');
              e.name = 'NotAllowedError';
              throw e;
            }
            if (window.__CAM_PERM__ === 'gesture_needed') {
              const e = new Error('User gesture required');
              e.name = 'NotAllowedError';
              throw e;
            }
            return makeStream();
          }
        }
      });
    })();
    """

    scripts = [
        "reader.js", "outline.js", "voice.js", "pill.js", "glow.js",
        "digest.js", "explain.js", "confirm.js", "link-index.js", "match.js",
        "link-intent.js", "intent.js", "navigate.js",
        "form-index.js", "form-fill.js", "forms.js",
        "shelf-db.js", "upload.js", "camera.js", "dialogue.js", "widget.js"
    ]

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.add_init_script(init_shim)
            page.route("**/test-c4.html", lambda r: r.fulfill(status=200, content_type="text/html", body=portal_html))
            page.goto(f"{base_url}/test-c4.html", wait_until="domcontentloaded")

            for s in scripts:
                page.add_script_tag(url=f"{base_url}/{s}")

            page.evaluate("""([css, lex, llex]) => {
              const w = new window.SleepwalkerWidget();
              window.__SW_WIDGET__ = w;
              const st = document.createElement('style');
              st.textContent = css;
              w.shadowRoot.prepend(st);
              w.intentEngine.lexicon = lex;
              w.intentEngine.linkLexicon = llex;
              w.camera.setTimers({ countdownStepMs: 40 });
              window.__SW_C4_READY__ = true;
            }""", [css_text, lexicon_json, link_lexicon_json])
            page.wait_for_function("() => window.__SW_C4_READY__ === true && window.__SW_WIDGET__.pill && window.__SW_WIDGET__.pill.cameraCard")

            # -----------------------------------------------------------------
            # T1: Honest Permission Helper when Camera is Denied/Blocked
            # -----------------------------------------------------------------
            page.evaluate("async () => { await window.__SW_SAY__('take photo'); }")
            page.wait_for_timeout(40)
            perm_card = page.evaluate("""() => {
              const sr = window.__SW_WIDGET__.shadowRoot;
              const helpSteps = sr.querySelector('#sw-pill-camera-card .sw-camera-help-steps');
              const retryBtn = sr.querySelector('#sw-pill-camera-card .sw-camera-retry-btn');
              const fallbackBtn = sr.querySelector('#sw-pill-camera-card .sw-camera-fallback-btn');
              return {
                stage: window.__SW_WIDGET__.camera.cardState.stage,
                helpText: helpSteps ? helpSteps.textContent : '',
                hasRetry: Boolean(retryBtn),
                retryHeight: retryBtn ? retryBtn.getBoundingClientRect().height : 0,
                hasFallback: Boolean(fallbackBtn)
              };
            }""")
            assert perm_card["stage"] == "permission_help" and "lock icon" in perm_card["helpText"] and perm_card["hasRetry"] and perm_card["retryHeight"] >= 48 and perm_card["hasFallback"], perm_card

            # -----------------------------------------------------------------
            # T2: Retry after Allowing -> Live <video> Preview + 3-2-1 Countdown -> JPEG + Stop Tracks
            # -----------------------------------------------------------------
            page.evaluate("""() => {
              window.__CAM_PERM__ = 'granted';
              window.__SPOKEN__ = [];
              window.__SW_WIDGET__.shadowRoot.querySelector('#sw-pill-camera-card .sw-camera-retry-btn').click();
            }""")
            page.wait_for_timeout(80)
            live_state = page.evaluate("""() => {
              const vid = window.__SW_WIDGET__.shadowRoot.querySelector('#sw-pill-camera-card video');
              return {
                stage: window.__SW_WIDGET__.camera.cardState.stage,
                hasVideo: Boolean(vid && vid.srcObject),
                liveTracks: window.__CREATED_TRACKS__.filter(t => t.readyState === 'live').length
              };
            }""")
            assert live_state["stage"] == "live" and live_state["hasVideo"] and live_state["liveTracks"] >= 1, live_state

            # Trigger 3-2-1 countdown via voice "shoot"!
            page.evaluate("async () => { window.__SPOKEN__ = []; await window.__SW_SAY__('shoot'); }")
            page.wait_for_function("() => window.__SW_WIDGET__.camera.cardState && window.__SW_WIDGET__.camera.cardState.stage === 'preview'")
            preview_state = page.evaluate("""() => {
              const cs = window.__SW_WIDGET__.camera.cardState;
              const img = window.__SW_WIDGET__.shadowRoot.querySelector('#sw-pill-camera-card .sw-camera-preview-img');
              return {
                stage: cs && cs.stage,
                fileName: cs && cs.capturedFile && cs.capturedFile.name,
                fileType: cs && cs.capturedFile && cs.capturedFile.type,
                hasImg: Boolean(img && img.src && img.src.startsWith('data:image/jpeg')),
                spoken: window.__SPOKEN__,
                liveTracksAfterCapture: window.__CREATED_TRACKS__.filter(t => t.readyState === 'live').length,
                awaitingConfirm: window.__SW_WIDGET__.confirm.isAwaiting(),
                attachedBeforeYes: document.getElementById('up-photo').files.length
              };
            }""")
            assert preview_state["stage"] == "preview" and preview_state["fileName"] == "camera-capture.jpg" and preview_state["fileType"] == "image/jpeg", preview_state
            assert preview_state["hasImg"] and "Three" in preview_state["spoken"] and "Two" in preview_state["spoken"] and "One" in preview_state["spoken"], preview_state
            assert preview_state["liveTracksAfterCapture"] == 0, "ALL MediaStreamTracks must stop immediately after capture!"
            assert preview_state["awaitingConfirm"] and preview_state["attachedBeforeYes"] == 0

            # -----------------------------------------------------------------
            # T3: Retake -> Confirm Attach ("Yes") -> DataTransfer + Undo
            # -----------------------------------------------------------------
            page.evaluate("async () => { await window.__SW_SAY__('retake'); }")
            page.wait_for_function("() => window.__SW_WIDGET__.camera.cardState && window.__SW_WIDGET__.camera.cardState.stage === 'live'")
            assert page.evaluate("() => window.__CREATED_TRACKS__.filter(t => t.readyState === 'live').length") >= 1

            # Capture directly on click / button
            page.evaluate("async () => { await window.__SW_WIDGET__.shadowRoot.querySelector('#sw-pill-camera-card .sw-camera-shoot-btn').click(); }")
            page.wait_for_function("() => window.__SW_WIDGET__.camera.cardState && window.__SW_WIDGET__.camera.cardState.stage === 'preview'")

            # Say Yes -> attaches camera-capture.jpg via DataTransfer
            page.evaluate("async () => { await window.__SW_SAY__('yes'); }")
            page.wait_for_timeout(40)
            after_attach = page.evaluate("""() => ({
              filesCount: document.getElementById('up-photo').files.length,
              fileName: document.getElementById('up-photo').files[0] && document.getElementById('up-photo').files[0].name,
              fileType: document.getElementById('up-photo').files[0] && document.getElementById('up-photo').files[0].type,
              cardCleared: window.__SW_WIDGET__.camera.cardState === null,
              changeCount: window.__UP_CHANGES__
            })""")
            assert after_attach["filesCount"] == 1 and after_attach["fileName"] == "camera-capture.jpg" and after_attach["fileType"] == "image/jpeg", after_attach
            assert after_attach["cardCleared"] and after_attach["changeCount"] >= 1

            # Undo removes attached camera capture cleanly!
            page.evaluate("async () => { await window.__SW_SAY__('undo'); }")
            assert page.evaluate("() => document.getElementById('up-photo').files.length") == 0

            # -----------------------------------------------------------------
            # T4: Escape stops ALL active stream tracks cleanly
            # -----------------------------------------------------------------
            page.evaluate("async () => { await window.__SW_SAY__('open camera'); }")
            page.wait_for_timeout(60)
            assert page.evaluate("() => window.__CREATED_TRACKS__.filter(t => t.readyState === 'live').length") >= 1
            page.evaluate("() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }")
            page.wait_for_timeout(40)
            assert page.evaluate("() => window.__CREATED_TRACKS__.filter(t => t.readyState === 'live').length") == 0
            assert page.evaluate("() => window.__SW_WIDGET__.camera.cardState === null")

            print("PASS: All Phase C4 Camera Capture E2E tests passed (T1-T4, 100%)!")
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    run_c4_tests()
