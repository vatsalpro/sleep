"""
Phase C3 E2E Test: File Upload Without OS Dialog
(Route A Document Shelf via shelf.html/shelf-db.js + Route B Honest One-Tap Fallback)
Tests real extension JS inside headless Chromium via Playwright:
- Route A shelf.html setup UI, IndexedDB schema lifecycle, permission states ('granted', 'prompt' reauth, disconnect)
- Voice matching ("upload my photo", "upload my marksheet", "upload my income certificate", "upload my resume")
- Route A single-match confirm + multi-match numbered disambiguation + DataTransfer attach & dropzone events
- Size/accept validation (parsed from nearby text "max 500 KB") + oversized image refuses & offers Compress
- Route A needs_reauth & not_connected -> honest notice + Open/Re-allow Shelf Setup + 48px Choose File (Route B)
- Honest verification when page blocks FileList assignment + Undo + strict filename privacy (no storage.local leak)
"""

import base64
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


def run_c3_tests():
    server, port = start_server()
    base_url = f"http://127.0.0.1:{port}"
    css_text = (ROOT_DIR / "widget.css").read_text(encoding="utf-8")
    lexicon_json = json.loads((ROOT_DIR / "lexicon.json").read_text(encoding="utf-8"))
    link_lexicon_json = json.loads((ROOT_DIR / "link-lexicon.json").read_text(encoding="utf-8"))

    portal_html = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>C3 Document Upload Portal</title></head>
<body>
  <main>
    <h1>Document Upload Step</h1>
    <form id="upload-form">
      <div>
        <label for="up-photo">Passport Photo</label>
        <input id="up-photo" name="photo" type="file" accept="image/*" />
        <small>Max 500 KB, JPG/PNG only</small>
      </div>

      <div id="dz-income" class="dropzone" data-dropzone="true" data-accept=".pdf">
        <label for="up-income">Income Certificate Dropzone (max 2 MB, PDF)</label>
        <input id="up-income" name="income_cert" type="file" accept=".pdf" />
      </div>

      <div>
        <label for="up-marksheet">10th Marksheet</label>
        <input id="up-marksheet" name="marksheet" type="file" accept=".pdf" />
      </div>

      <div>
        <label for="up-resume">Resume Upload</label>
        <input id="up-resume" name="resume" type="file" accept=".pdf,.docx" />
      </div>

      <div>
        <label for="up-locked">Locked Upload Field</label>
        <input id="up-locked" name="locked" type="file" accept=".pdf" />
      </div>
    </form>
  </main>
  <script>
    window.__C3_EVENTS__ = [];
    ['up-photo', 'up-income', 'up-marksheet', 'up-resume'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener('change', () => {
        window.__C3_EVENTS__.push({ id, type: 'change', count: el.files.length, name: el.files[0] ? el.files[0].name : '' });
      });
    });
    const dz = document.getElementById('dz-income');
    ['dragenter', 'dragover', 'drop'].forEach((evType) => {
      dz.addEventListener(evType, (e) => {
        e.preventDefault();
        window.__C3_EVENTS__.push({
          id: 'dz-income',
          type: evType,
          name: e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0] ? e.dataTransfer.files[0].name : ''
        });
      });
    });
  </script>
</body>
</html>"""

    init_shim = """
    (() => {
      const localStore = {};
      window.__LOCAL_STORE__ = localStore;
      window.__SHELF_MOCK_STATE__ = {
        mode: 'ok', // 'ok' | 'needs_reauth' | 'not_connected'
        folderName: 'My Scholarship Docs',
        files: {
          'passport_photo.jpg': { type: 'image/jpeg', bytes: [255, 216, 255, 224, 1, 2, 3, 4] },
          'income_certificate_2026.pdf': { type: 'application/pdf', bytes: [37, 80, 68, 70, 45, 49, 46, 52] },
          'resume_v1.pdf': { type: 'application/pdf', bytes: [37, 80, 68, 70, 49] },
          'resume_v2.pdf': { type: 'application/pdf', bytes: [37, 80, 68, 70, 50] },
          'huge_photo.jpg': { type: 'image/jpeg', sizeOverride: 900 * 1024 }
        },
        openedSetupCount: 0
      };

      const expandQuery = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9\\s]/g, ' ').split(/\\s+/).filter(Boolean);

      window.chrome = {
        runtime: {
          getURL: (p) => location.origin + '/' + p.replace(/^\\//, ''),
          getManifest: () => ({ version: '1.0.0' }),
          sendMessage: (msg, cb) => {
            const st = window.__SHELF_MOCK_STATE__;
            if (msg && msg.type === 'SLEEPWALKER_OPEN_SHELF_SETUP') {
              st.openedSetupCount += 1;
              if (cb) cb({ status: 'opened' });
              return;
            }
            if (msg && msg.type === 'SLEEPWALKER_SHELF_STATUS') {
              if (st.mode === 'not_connected') {
                if (cb) cb({ status: 'not_connected', connected: false });
              } else if (st.mode === 'needs_reauth') {
                if (cb) cb({ status: 'needs_reauth', connected: true, permission: 'prompt', folderName: st.folderName });
              } else {
                if (cb) cb({ status: 'ok', connected: true, permission: 'granted', folderName: st.folderName, count: Object.keys(st.files).length });
              }
              return;
            }
            if (msg && msg.type === 'SLEEPWALKER_SHELF_MATCH') {
              if (st.mode !== 'ok') {
                if (cb) cb({ status: st.mode, folderName: st.folderName });
                return;
              }
              const entries = Object.keys(st.files).map((name) => ({ name, path: name }));
              const ranked = window.SleepwalkerShelfDB.rankShelfEntries(entries, msg.query || '');
              if (cb) cb({ status: 'ok', folderName: st.folderName, matches: ranked });
              return;
            }
            if (msg && msg.type === 'SLEEPWALKER_SHELF_READ') {
              if (st.mode !== 'ok') {
                if (cb) cb({ ok: false, reason: st.mode, error: 'Shelf permission needs re-tap in Shelf Setup.' });
                return;
              }
              const entry = st.files[msg.name];
              if (!entry) {
                if (cb) cb({ ok: false, reason: 'not_found', error: 'Not found' });
                return;
              }
              const bytes = entry.sizeOverride ? new Array(entry.sizeOverride).fill(65) : entry.bytes;
              if (cb) cb({ ok: true, name: msg.name, path: msg.name, type: entry.type, size: bytes.length, lastModified: Date.now(), bytes });
              return;
            }
            if (typeof cb === 'function') cb({ status: 'ok' });
          },
          onMessage: { addListener: () => {} }
        },
        storage: {
          local: {
            get: (keys, cb) => cb({ ...localStore }),
            set: (obj, cb) => { Object.assign(localStore, obj || {}); if (cb) cb(); }
          },
          session: {
            get: (keys, cb) => cb({}),
            set: (obj, cb) => { if (cb) cb(); }
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
    })();
    """

    scripts = [
        "reader.js", "outline.js", "voice.js", "pill.js", "glow.js",
        "digest.js", "explain.js", "confirm.js", "link-index.js", "match.js",
        "link-intent.js", "intent.js", "navigate.js",
        "form-index.js", "form-fill.js", "forms.js",
        "shelf-db.js", "upload.js", "dialogue.js", "widget.js"
    ]

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()

            # -----------------------------------------------------------------
            # T1: Extension-origin shelf.html + IndexedDB store + permission reauth UI
            # -----------------------------------------------------------------
            shelf_page = context.new_page()
            shelf_page.add_init_script("""
              (() => {
                let permState = 'granted';
                const makeFile = (name) => ({ kind: 'file', name, getFile: async () => new File(['data'], name) });
                window.__MOCK_DIR_HANDLE__ = {
                  name: 'Documents',
                  values: async function* () {
                    yield makeFile('passport_photo.jpg');
                    yield makeFile('marksheet_10th.pdf');
                  },
                  queryPermission: async () => permState,
                  requestPermission: async () => { permState = 'granted'; return permState; }
                };
                window.__SET_PERM__ = (s) => { permState = s; };
                window.showDirectoryPicker = async () => window.__MOCK_DIR_HANDLE__;
              })();
            """)
            shelf_page.goto(f"{base_url}/shelf.html", wait_until="domcontentloaded")
            # Native IndexedDB store/read/clear check (with serializable plain record to confirm schema)
            idb_ok = shelf_page.evaluate("""async () => {
              const db = window.SleepwalkerShelfDB;
              await db.saveDirectoryHandle({ name: 'DocsTest' });
              const rec = await db.loadDirectoryRecord();
              await db.clearDirectoryHandle();
              const cleared = await db.loadDirectoryRecord();
              return Boolean(rec && rec.folderName === 'DocsTest' && !cleared);
            }""")
            assert idb_ok is True, "IndexedDB shelf store schema failed"

            # UI permission & listing flow on shelf.html (using memory handle fallback since plain mock obj lacks structured clone of functions)
            shelf_ui = shelf_page.evaluate("""async () => {
              const db = window.SleepwalkerShelfDB;
              // Stub load/save in page context so mock handle with async generators persists across refreshView
              let saved = null;
              db.saveDirectoryHandle = async (h) => { saved = { dirHandle: h, folderName: h.name }; return { ok: true }; };
              db.loadDirectoryRecord = async () => saved;
              db.clearDirectoryHandle = async () => { saved = null; return { ok: true }; };
              await window.SleepwalkerShelfPage.connectWithHandle(window.__MOCK_DIR_HANDLE__);
              const txt1 = document.getElementById('shelf-status-box').textContent;
              const count1 = document.getElementById('shelf-count').textContent;
              window.__SET_PERM__('prompt');
              await window.SleepwalkerShelfPage.refreshView();
              const txtReauth = document.getElementById('shelf-status-box').textContent;
              const reauthVisible = !document.getElementById('btn-reauth-shelf').hidden;
              document.getElementById('btn-reauth-shelf').click();
              await new Promise(r => setTimeout(r, 30));
              const txtAfter = document.getElementById('shelf-status-box').textContent;
              return { txt1, count1, txtReauth, reauthVisible, txtAfter };
            }""")
            assert "Connected" in shelf_ui["txt1"] and shelf_ui["count1"] == "2", shelf_ui
            assert "re-authorization" in shelf_ui["txtReauth"] and shelf_ui["reauthVisible"], shelf_ui
            assert "Connected" in shelf_ui["txtAfter"], shelf_ui
            shelf_page.close()

            # -----------------------------------------------------------------
            # T2: Portal Page — Route A Hands-Free Document Shelf Voice Upload + Dropzones + Ambiguity + Validation
            # -----------------------------------------------------------------
            page = context.new_page()
            page.add_init_script(init_shim)
            page.route("**/test-c3.html", lambda r: r.fulfill(status=200, content_type="text/html", body=portal_html))
            page.goto(f"{base_url}/test-c3.html", wait_until="domcontentloaded")
            for s in scripts:
                page.add_script_tag(url=f"{base_url}/{s}")

            page.evaluate("""([css, lex, llex]) => {
              const w = new window.SleepwalkerWidget();
              window.__SW_WIDGET__ = w;
              w.init().then(() => {
                const st = document.createElement('style');
                st.textContent = css;
                w.shadowRoot.prepend(st);
                w.intentEngine.lexicon = lex;
                w.intentEngine.linkLexicon = llex;
              });
            }""", [css_text, lexicon_json, link_lexicon_json])
            page.wait_for_function("() => window.__SW_WIDGET__ && window.__SW_WIDGET__.upload && window.__SW_WIDGET__.intentEngine.lexicon")

            # 2a. "upload my photo" -> Route A finds passport_photo.jpg -> confirms -> attaches via DataTransfer WITHOUT OS picker!
            page.evaluate("async () => { await window.__SW_SAY__('upload my photo'); }")
            page.wait_for_timeout(40)
            pre_attach = page.evaluate("""() => ({
              filesCount: document.getElementById('up-photo').files.length,
              awaiting: window.__SW_WIDGET__.confirm.isAwaiting(),
              title: window.__SW_WIDGET__.confirm.pending && window.__SW_WIDGET__.confirm.pending.title,
              msg: window.__SW_WIDGET__.confirm.pending && window.__SW_WIDGET__.confirm.pending.message
            })""")
            assert pre_attach["filesCount"] == 0 and pre_attach["awaiting"] and "passport_photo.jpg" in pre_attach["msg"], pre_attach

            page.evaluate("async () => { await window.__SW_SAY__('yes'); }")
            page.wait_for_timeout(40)
            post_photo = page.evaluate("""() => ({
              name: document.getElementById('up-photo').files[0] && document.getElementById('up-photo').files[0].name,
              events: window.__C3_EVENTS__.filter(e => e.id === 'up-photo')
            })""")
            assert post_photo["name"] == "passport_photo.jpg" and len(post_photo["events"]) >= 1, post_photo

            # 2b. "upload my income certificate" -> matches dropzone + attaches PDF + fires drop event!
            page.evaluate("async () => { await window.__SW_SAY__('upload my income certificate'); }")
            page.wait_for_timeout(40)
            assert "income_certificate_2026.pdf" in page.evaluate("() => window.__SW_WIDGET__.confirm.pending.message")
            page.evaluate("async () => { await window.__SW_SAY__('haan'); }")
            page.wait_for_timeout(40)
            post_dz = page.evaluate("""() => ({
              fileName: document.getElementById('up-income').files[0] && document.getElementById('up-income').files[0].name,
              dropTypes: window.__C3_EVENTS__.filter(e => e.id === 'dz-income').map(e => e.type)
            })""")
            assert post_dz["fileName"] == "income_certificate_2026.pdf" and "drop" in post_dz["dropTypes"], post_dz

            # 2c. Ambiguous shelf matches ("upload my resume" matches resume_v1.pdf & resume_v2.pdf) -> number 2 picks resume_v2.pdf
            page.evaluate("async () => { await window.__SW_SAY__('upload my resume'); }")
            page.wait_for_timeout(40)
            amb = page.evaluate("() => (window.__SW_WIDGET__.confirm.pending.options || []).map(o => o.label)")
            assert "resume_v1.pdf" in amb and "resume_v2.pdf" in amb, amb
            page.evaluate("async () => { await window.__SW_SAY__('number 2'); }")
            page.wait_for_timeout(40)
            assert page.evaluate("() => document.getElementById('up-resume').files[0] && document.getElementById('up-resume').files[0].name") == "resume_v2.pdf"

            # 2d. Oversized photo from shelf (> 500 KB max on #up-photo) refuses cleanly & offers Compress Photo
            page.evaluate("""() => {
              const target = window.__SW_WIDGET__.upload.detectUploadTargets().find(t => t.inputElement && t.inputElement.id === 'up-photo');
              return window.__SW_WIDGET__.upload.pickFromExtensionShelf({ name: 'huge_photo.jpg', path: 'huge_photo.jpg' }, target, { skipFinalConfirmIfValid: true });
            }""")
            page.wait_for_timeout(40)
            big_state = page.evaluate("""() => ({
              stage: window.__SW_WIDGET__.upload.pendingCardState.stage,
              canCompress: window.__SW_WIDGET__.upload.pendingCardState.canCompress,
              err: window.__SW_WIDGET__.upload.pendingCardState.error
            })""")
            assert big_state["stage"] == "validation_error" and big_state["canCompress"] is True and "500 KB" in big_state["err"], big_state

            # -----------------------------------------------------------------
            # T3: Route A needs_reauth Honest Reporting + Route B 48px Choose File + Undo + Honest Blocked FileList + Privacy
            # -----------------------------------------------------------------
            page.evaluate("() => { window.__SHELF_MOCK_STATE__.mode = 'needs_reauth'; }")
            page.evaluate("async () => { await window.__SW_SAY__('upload my marksheet'); }")
            page.wait_for_timeout(40)
            reauth_card = page.evaluate("""() => {
              const sr = window.__SW_WIDGET__.shadowRoot;
              const chooseBtn = sr.querySelector('#sw-pill-file-card .sw-choose-file-btn');
              const reallowBtn = sr.querySelector('#sw-pill-file-card .sw-open-shelf-setup-btn');
              const rect = chooseBtn ? chooseBtn.getBoundingClientRect() : null;
              return {
                needsReauth: window.__SW_WIDGET__.upload.pendingCardState.shelfNeedsReauth,
                note: window.__SW_WIDGET__.upload.pendingCardState.shelfNote,
                hasChoose: Boolean(chooseBtn),
                chooseHeight: rect ? rect.height : 0,
                hasReallow: Boolean(reallowBtn)
              };
            }""")
            assert reauth_card["needsReauth"] and "re-tap" in reauth_card["note"] and reauth_card["hasChoose"] and reauth_card["chooseHeight"] >= 48 and reauth_card["hasReallow"], reauth_card

            # Test clicking Re-allow Shelf opens Shelf Setup page via SW
            page.evaluate("() => { window.__SW_WIDGET__.shadowRoot.querySelector('#sw-pill-file-card .sw-open-shelf-setup-btn').click(); }")
            assert page.evaluate("() => window.__SHELF_MOCK_STATE__.openedSetupCount") == 1

            # Test Route B manual file selection on card + Final Yes -> Attached -> Undo clears files!
            page.evaluate("""() => {
              const pdf = new File(['%PDF-1.4'], 'tenth_marksheet_real.pdf', { type: 'application/pdf' });
              const cardInput = window.__SW_WIDGET__.shadowRoot.querySelector('#sw-pill-file-card input[type="file"]');
              const dt = new DataTransfer();
              dt.items.add(pdf);
              cardInput.files = dt.files;
              cardInput.dispatchEvent(new Event('change', { bubbles: true }));
            }""")
            assert page.evaluate("() => window.__SW_WIDGET__.confirm.isAwaiting() && document.getElementById('up-marksheet').files.length === 0")
            page.evaluate("async () => { await window.__SW_SAY__('yes'); }")
            assert page.evaluate("() => document.getElementById('up-marksheet').files[0].name") == "tenth_marksheet_real.pdf"

            page.evaluate("async () => { await window.__SW_SAY__('undo'); }")
            assert page.evaluate("() => document.getElementById('up-marksheet').files.length") == 0

            # Honest verification when locked input rejects programmatic FileList assignment
            honest_fail = page.evaluate("""() => {
              const locked = document.getElementById('up-locked');
              Object.defineProperty(locked, 'files', { get: () => [], set: () => {} });
              const target = window.__SW_WIDGET__.upload.detectUploadTargets().find(t => t.inputElement && t.inputElement.id === 'up-locked');
              return window.__SW_WIDGET__.upload.attachFileToTarget(new File(['%PDF'], 'test.pdf', { type: 'application/pdf' }), target);
            }""")
            assert honest_fail["ok"] is False and honest_fail["verified"] is False and "blocked" in honest_fail["error"].lower(), honest_fail

            # Strict Privacy: zero filenames leaked into chrome.storage.local
            local_dump = page.evaluate("() => JSON.stringify(window.__LOCAL_STORE__)")
            for fname in ["passport_photo.jpg", "income_certificate_2026.pdf", "resume_v2.pdf", "tenth_marksheet_real.pdf"]:
                assert fname not in local_dump, f"PRIVACY LEAK: filename {fname} found in chrome.storage.local!"

            print("PASS: All Phase C3 File Upload E2E tests passed (T1-T3, 100%)!")
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    run_c3_tests()
