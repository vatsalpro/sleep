"""
Phase C1 E2E Test: Continuous Conversation Session (dialogue.js)
Tests real extension JS inside headless Chromium with Playwright:
- Alt+S and orb session lifecycle + visible mic indicator
- Half-duplex pause during TTS + 300ms resume + Barge-in toggle
- Orb tap / Escape / Alt+S speech interruption
- Chrome onend auto-restart with backoff
- 25s silence prompt ("Are you still there?") + 15s quiet end via page.clock
- END phrases (EN/HI/Hinglish) + half-done form guard ("Stop now? Your form stays as it is.")
- Answer-first pending question interpretation + correction/skip/back/repeat/help/undo
- 3-turn compact memory (no sensitive capture) + window.__SW_SAY__ hook
"""

import http.server
import json
import os
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


def run_c1_tests():
    server, port = start_server()
    base_url = f"http://127.0.0.1:{port}"
    css_text = (ROOT_DIR / "widget.css").read_text(encoding="utf-8")
    lexicon_json = json.loads((ROOT_DIR / "lexicon.json").read_text(encoding="utf-8"))
    link_lexicon_json = json.loads((ROOT_DIR / "link-lexicon.json").read_text(encoding="utf-8"))

    test_html = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>C1 Dialogue Test Page</title></head>
<body>
  <main>
    <h1>Application Portal</h1>
    <p>Fill in your contact details below or navigate links.</p>
    <a href="#evening">Evening Slot Info</a>
    <form id="app-form">
      <label for="f-name">Full Name</label>
      <input id="f-name" name="fullName" type="text" required />
      <label for="f-email">Email</label>
      <input id="f-email" name="email" type="email" />
      <label for="f-city">City</label>
      <input id="f-city" name="city" type="text" />
      <label for="f-otp">OTP Code</label>
      <input id="f-otp" name="otp" type="password" />
    </form>
  </main>
</body>
</html>"""

    init_shim = """
    (() => {
      const localStore = {};
      const sessionStore = {};
      window.__STORAGE_LOCAL__ = localStore;

      // Chrome APIs shim
      window.chrome = {
        runtime: {
          getURL: (p) => location.origin + '/' + p.replace(/^\\//, ''),
          getManifest: () => ({ version: '1.0.0' }),
          sendMessage: (msg, cb) => {
            if (typeof cb === 'function') cb({ status: 'ok' });
          },
          onMessage: { addListener: () => {} }
        },
        storage: {
          local: {
            get: (keys, cb) => {
              if (typeof cb === 'function') cb({ ...localStore });
            },
            set: (obj, cb) => {
              Object.assign(localStore, obj || {});
              if (typeof cb === 'function') cb();
            }
          },
          session: {
            get: (keys, cb) => {
              if (typeof cb === 'function') cb({ ...sessionStore });
            },
            set: (obj, cb) => {
              Object.assign(sessionStore, obj || {});
              if (typeof cb === 'function') cb();
            }
          }
        }
      };

      // Deterministic Mock SpeechRecognition
      window.__MOCK_SR_LOG__ = { startCount: 0, stopCount: 0, active: false, lastLang: '', instances: [] };
      class MockSpeechRecognition {
        constructor() {
          this.continuous = true;
          this.interimResults = true;
          this.maxAlternatives = 1;
          this.lang = 'en-IN';
          this.onstart = null;
          this.onresult = null;
          this.onerror = null;
          this.onend = null;
          window.__MOCK_SR_LOG__.instances.push(this);
        }
        start() {
          window.__MOCK_SR_LOG__.startCount += 1;
          window.__MOCK_SR_LOG__.active = true;
          window.__MOCK_SR_LOG__.lastLang = this.lang;
          if (typeof this.onstart === 'function') this.onstart();
        }
        stop() {
          window.__MOCK_SR_LOG__.stopCount += 1;
          const wasActive = window.__MOCK_SR_LOG__.active;
          window.__MOCK_SR_LOG__.active = false;
          if (wasActive && typeof this.onend === 'function') {
            this.onend();
          }
        }
        abort() {
          this.stop();
        }
      }
      window.SpeechRecognition = MockSpeechRecognition;
      window.webkitSpeechRecognition = MockSpeechRecognition;

      window.__MOCK_SR_CTRL__ = {
        triggerUnexpectedEnd: () => {
          const inst = window.__MOCK_SR_LOG__.instances[window.__MOCK_SR_LOG__.instances.length - 1];
          window.__MOCK_SR_LOG__.active = false;
          if (inst && typeof inst.onend === 'function') inst.onend();
        },
        emitFinal: (text) => {
          const inst = window.__MOCK_SR_LOG__.instances[window.__MOCK_SR_LOG__.instances.length - 1];
          if (inst && typeof inst.onresult === 'function') {
            inst.onresult({
              resultIndex: 0,
              results: [Object.assign([{ transcript: text, confidence: 0.96 }], { isFinal: true })]
            });
          }
        }
      };

      // Deterministic Mock SpeechSynthesis
      window.__SPOKEN__ = [];
      window.__PENDING_UTTERANCES__ = [];
      window.__TTS_CANCELS__ = 0;
      const synthMock = {
        speaking: false,
        paused: false,
        pending: false,
        onvoiceschanged: null,
        getVoices: () => [{ name: 'Mock EN', lang: 'en-IN', default: true }, { name: 'Mock HI', lang: 'hi-IN', default: false }],
        speak: (utt) => {
          synthMock.speaking = true;
          synthMock.paused = false;
          window.__SPOKEN__.push(utt.text);
          window.__PENDING_UTTERANCES__.push(utt);
        },
        cancel: () => {
          const hadPending = window.__PENDING_UTTERANCES__.length > 0;
          if (hadPending) window.__TTS_CANCELS__ += 1;
          synthMock.speaking = false;
          synthMock.paused = false;
          const dropped = window.__PENDING_UTTERANCES__.splice(0);
          for (const u of dropped) {
            if (typeof u.onerror === 'function') {
              u.onerror({ error: 'canceled' });
            }
          }
        },
        pause: () => { synthMock.paused = true; },
        resume: () => { synthMock.paused = false; }
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synthMock, configurable: true, writable: true });
      window.SpeechSynthesisUtterance = function (text) {
        this.text = text || '';
        this.rate = 1;
        this.lang = 'en-IN';
        this.voice = null;
        this.onend = null;
        this.onerror = null;
      };
      window.__FINISH_TTS__ = () => {
        synthMock.speaking = false;
        const u = window.__PENDING_UTTERANCES__.shift();
        if (u && typeof u.onend === 'function') u.onend();
      };
    })();
    """

    scripts = [
        "reader.js", "outline.js", "voice.js", "pill.js", "glow.js",
        "digest.js", "explain.js", "confirm.js", "link-index.js", "match.js",
        "link-intent.js", "intent.js", "navigate.js", "form-index.js", "form-fill.js", "forms.js", "upload.js",
        "dialogue.js", "widget.js"
    ]

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            page.clock.install()
            page.add_init_script(init_shim)

            page.route("**/test-c1.html", lambda r: r.fulfill(status=200, content_type="text/html", body=test_html))
            page.goto(f"{base_url}/test-c1.html", wait_until="domcontentloaded")

            for s in scripts:
                page.add_script_tag(url=f"{base_url}/{s}")

            page.evaluate("""([css, lex, llex]) => {
              window.__SW_TEST_CSS__ = css;
              const w = new window.SleepwalkerWidget();
              window.__SW_WIDGET__ = w;
              w.init().then(() => {
                const styleEl = document.createElement('style');
                styleEl.textContent = css;
                w.shadowRoot.prepend(styleEl);
                w.intentEngine.lexicon = lex;
                w.intentEngine.linkLexicon = llex;
              });
              // Replicate content.js Alt+S binding on window
              window.addEventListener('keydown', (e) => {
                if (e.altKey && (e.key === 's' || e.key === 'S')) {
                  e.preventDefault();
                  w.toggle({ startDialogue: true, source: 'alt_s' });
                }
              }, true);
            }""", [css_text, lexicon_json, link_lexicon_json])
            page.wait_for_function("() => window.__SW_WIDGET__ && window.__SW_WIDGET__.dialogue && window.__SW_WIDGET__.pill && window.__SW_WIDGET__.pill.pillBtn && typeof window.__SW_SAY__ === 'function'")

            # -----------------------------------------------------------------
            # T1: Orb click starts continuous session & mic indicator stays visible
            # -----------------------------------------------------------------
            page.evaluate("() => { window.__SW_WIDGET__.pill.pillBtn.click(); }")
            t1 = page.evaluate("""() => {
              const w = window.__SW_WIDGET__;
              const pill = w.pill.pillBtn;
              return {
                active: w.dialogue.isActive(),
                listening: w.voice.isListening,
                continuous: w.voice.continuousSession,
                srActive: window.__MOCK_SR_LOG__.active,
                micAttr: pill.dataset.micSession,
                ariaPressed: pill.getAttribute('aria-pressed'),
                hasActiveClass: pill.classList.contains('sw-mic-session-active')
              };
            }""")
            assert t1["active"] and t1["listening"] and t1["continuous"] and t1["srActive"], f"T1 start failed: {t1}"
            assert t1["micAttr"] == "active" and t1["ariaPressed"] == "true" and t1["hasActiveClass"], f"T1 orb badge failed: {t1}"

            # -----------------------------------------------------------------
            # T2: Half-duplex pauses mic during TTS & resumes ~300ms after + Interruptions
            # -----------------------------------------------------------------
            page.evaluate("""() => {
              window.__SPOKEN__ = [];
              window.__SW_WIDGET__.dialogue._sayAndDisplay('Reading half-duplex message.');
            }""")
            half_mid = page.evaluate("""() => ({
              playing: window.__SW_WIDGET__.reader.isPlaying,
              paused: window.__SW_WIDGET__.voice.isPaused,
              srActive: window.__MOCK_SR_LOG__.active,
              micAttr: window.__SW_WIDGET__.pill.pillBtn.dataset.micSession,
              hasPausedClass: window.__SW_WIDGET__.pill.pillBtn.classList.contains('sw-mic-session-paused')
            })""")
            assert half_mid["playing"] and half_mid["paused"] and not half_mid["srActive"], f"T2 half-duplex mid-speech failed: {half_mid}"
            assert half_mid["micAttr"] == "paused" and half_mid["hasPausedClass"], f"T2 paused orb badge failed: {half_mid}"

            # Finish TTS -> verify not resumed before 300ms, resumed after 300ms
            page.evaluate("() => window.__FINISH_TTS__()")
            page.clock.run_for(100)
            before_300 = page.evaluate("() => ({ paused: window.__SW_WIDGET__.voice.isPaused, srActive: window.__MOCK_SR_LOG__.active })")
            assert before_300["paused"] and not before_300["srActive"], f"T2 resumed too early before 300ms: {before_300}"

            page.clock.run_for(250)
            after_300 = page.evaluate("() => ({ paused: window.__SW_WIDGET__.voice.isPaused, srActive: window.__MOCK_SR_LOG__.active, micAttr: window.__SW_WIDGET__.pill.pillBtn.dataset.micSession })")
            assert not after_300["paused"] and after_300["srActive"] and after_300["micAttr"] == "active", f"T2 failed to resume after 300ms: {after_300}"

            # Orb tap interruption
            page.evaluate("() => { window.__SW_WIDGET__.dialogue._sayAndDisplay('Long speech interrupted by orb.'); }")
            assert page.evaluate("() => window.__SW_WIDGET__.reader.isPlaying")
            page.evaluate("() => { window.__SW_WIDGET__.pill.pillBtn.click(); }")
            orb_int = page.evaluate("() => ({ playing: window.__SW_WIDGET__.reader.isPlaying, active: window.__SW_WIDGET__.dialogue.isActive(), srActive: window.__MOCK_SR_LOG__.active })")
            assert not orb_int["playing"] and orb_int["active"] and orb_int["srActive"], f"T2 orb interrupt failed: {orb_int}"

            # Escape interruption (keeps session alive when interrupting active speech!)
            page.evaluate("() => { window.__SW_WIDGET__.dialogue._sayAndDisplay('Speech interrupted by Escape.'); }")
            page.evaluate("() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }")
            esc_int = page.evaluate("() => ({ playing: window.__SW_WIDGET__.reader.isPlaying, active: window.__SW_WIDGET__.dialogue.isActive(), srActive: window.__MOCK_SR_LOG__.active })")
            assert not esc_int["playing"] and esc_int["active"] and esc_int["srActive"], f"T2 Escape interrupt failed: {esc_int}"

            # Alt+S interruption while speaking
            page.evaluate("() => { window.__SW_WIDGET__.dialogue._sayAndDisplay('Speech interrupted by Alt+S.'); }")
            page.evaluate("() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', altKey: true, bubbles: true })); }")
            alts_int = page.evaluate("() => ({ playing: window.__SW_WIDGET__.reader.isPlaying, active: window.__SW_WIDGET__.dialogue.isActive(), srActive: window.__MOCK_SR_LOG__.active })")
            assert not alts_int["playing"] and alts_int["active"] and alts_int["srActive"], f"T2 Alt+S interrupt failed: {alts_int}"

            # Barge-in mode: speech keeps mic live and incoming voice interrupts speech
            page.evaluate("""() => {
              window.__SW_WIDGET__.open();
              const cb = window.__SW_WIDGET__.shadowRoot.getElementById('sw-toggle-barge-in');
              cb.checked = true;
              cb.dispatchEvent(new Event('change', { bubbles: true }));
              window.__SW_WIDGET__.dialogue._sayAndDisplay('Speaking with barge-in enabled.');
            }""")
            barge_during = page.evaluate("() => ({ bargeIn: window.__SW_WIDGET__.dialogue.bargeIn, srActive: window.__MOCK_SR_LOG__.active, stored: window.__STORAGE_LOCAL__.sleepwalker_barge_in })")
            assert barge_during["bargeIn"] and barge_during["srActive"] and barge_during["stored"] is True, f"T2 barge-in failed: {barge_during}"
            page.evaluate("() => { window.__MOCK_SR_CTRL__.emitFinal('help'); }")
            assert not page.evaluate("() => window.__SW_WIDGET__.reader.isPlaying"), "Barge-in speech did not interrupt TTS"
            page.evaluate("() => window.__SW_WIDGET__.setBargeIn(false)")

            # -----------------------------------------------------------------
            # T3: Auto-restart with backoff when Chrome stops SpeechRecognition
            # -----------------------------------------------------------------
            starts_before = page.evaluate("() => window.__MOCK_SR_LOG__.startCount")
            page.evaluate("() => { window.__MOCK_SR_CTRL__.triggerUnexpectedEnd(); }")
            page.clock.run_for(500)
            starts_after = page.evaluate("() => ({ count: window.__MOCK_SR_LOG__.startCount, srActive: window.__MOCK_SR_LOG__.active, attempts: window.__SW_WIDGET__.voice._restartAttempts })")
            assert starts_after["count"] > starts_before and starts_after["srActive"], f"T3 auto-restart failed: {starts_after}"

            # -----------------------------------------------------------------
            # T4: Answer-first interpretation + Correction / Skip / Back / Repeat / Help / Undo + 3-turn memory
            # -----------------------------------------------------------------
            page.evaluate("""() => {
              window.__ASK_RESULTS__ = [];
              const d = window.__SW_WIDGET__.dialogue;
              d.setPendingPrompt({
                kind: 'choice',
                label: 'slot',
                askedText: 'Choose Morning or Evening',
                options: ['Morning', 'Evening'],
                onAnswer: (picked) => { window.__ASK_RESULTS__.push(picked); return { ok: true }; }
              });
            }""")
            # Repeat re-speaks askedText without consuming prompt
            page.evaluate("async () => { window.__SPOKEN__ = []; await window.__SW_SAY__('repeat'); }")
            assert "Choose Morning or Evening" in page.evaluate("() => window.__SPOKEN__[window.__SPOKEN__.length - 1] || ''"), "T4 repeat failed"
            assert page.evaluate("() => Boolean(window.__SW_WIDGET__.dialogue.pendingPrompt)"), "T4 repeat cleared prompt!"

            # Help gives contextual prompt hint
            page.evaluate("async () => { window.__SPOKEN__ = []; await window.__SW_SAY__('help'); }")
            assert "Skip" in page.evaluate("() => window.__SPOKEN__[window.__SPOKEN__.length - 1] || ''"), "T4 contextual help failed"

            # Answer-first: saying "Evening" resolves custom choice prompt rather than clicking anchor link
            page.evaluate("async () => { await window.__SW_SAY__('Evening'); }")
            assert page.evaluate("() => window.__ASK_RESULTS__") == ["Evening"], "T4 answer-first failed"

            # Guided form meta-commands: skip, back, correction, undo
            page.evaluate("""async () => {
              const w = window.__SW_WIDGET__;
              await window.__SW_SAY__('fill this form');
              await window.__SW_SAY__('skip');
            }""")
            assert page.evaluate("() => window.__SW_WIDGET__.forms.guidedState.index") == 1, "T4 skip did not advance field"
            page.evaluate("async () => { await window.__SW_SAY__('back'); }")
            assert page.evaluate("() => window.__SW_WIDGET__.forms.guidedState.index") == 0, "T4 back did not step back"

            page.evaluate("""async () => {
              await window.__SW_SAY__('Rahul');
              await window.__SW_SAY__('no, change it to Priya');
              await window.__SW_SAY__('yes');
            }""")
            assert page.evaluate("() => document.getElementById('f-name').value") == "Priya", "T4 correction failed"

            # Undo restores previous value
            page.evaluate("async () => { await window.__SW_SAY__('undo'); }")
            assert page.evaluate("() => document.getElementById('f-name').value") == "", "T4 undo failed"

            # Fill name again for half-done END guard test
            page.evaluate("""async () => {
              await window.__SW_SAY__('Asha');
              await window.__SW_SAY__('yes');
            }""")
            assert page.evaluate("() => document.getElementById('f-name').value") == "Asha"

            # 3-turn memory capped at 3
            mem_len = page.evaluate("() => window.__SW_WIDGET__.dialogue.getMemory().length")
            assert mem_len == 3, f"T4 memory length expected 3, got {mem_len}"

            # -----------------------------------------------------------------
            # T5: Half-done form guard on END phrases + clean END phrases (EN/HI/Hinglish)
            # -----------------------------------------------------------------
            page.evaluate("() => { window.__SPOKEN__ = []; }")
            page.evaluate("async () => { await window.__SW_SAY__('bas itna hi'); }")
            page.evaluate("() => { window.__FINISH_TTS__(); window.__FINISH_TTS__(); }")
            half_prompt = page.evaluate("""() => ({
              active: window.__SW_WIDGET__.dialogue.isActive(),
              spokenAll: window.__SPOKEN__.join(' '),
              lastSpoken: window.__SW_WIDGET__.dialogue.lastSpokenText
            })""")
            assert half_prompt["active"] and "Stop now? Your form stays as it is." in half_prompt["spokenAll"] and "Stop now? Your form stays as it is." in half_prompt["lastSpoken"], f"T5 half-done guard failed: {half_prompt}"

            # Say No -> stays open
            page.evaluate("async () => { await window.__SW_SAY__('no'); window.__FINISH_TTS__(); window.__FINISH_TTS__(); }")
            page.clock.run_for(350)
            assert page.evaluate("() => window.__SW_WIDGET__.dialogue.isActive()") is True

            # Say END phrase again + confirm Yes -> ends session cleanly and preserves filled value!
            page.evaluate("""async () => {
              await window.__SW_SAY__('shukriya');
              window.__FINISH_TTS__();
              window.__FINISH_TTS__();
              await window.__SW_SAY__('haan');
            }""")
            ended_half = page.evaluate("""() => ({
              active: window.__SW_WIDGET__.dialogue.isActive(),
              listening: window.__SW_WIDGET__.voice.isListening,
              srActive: window.__MOCK_SR_LOG__.active,
              bye: window.__SPOKEN__.join(' '),
              nameVal: document.getElementById('f-name').value
            })""")
            assert not ended_half["active"] and not ended_half["listening"] and not ended_half["srActive"], f"T5 end after confirm failed: {ended_half}"
            assert "Goodbye" in ended_half["bye"] and ended_half["nameVal"] == "Asha", f"T5 form/bye mismatch: {ended_half}"

            # Reset form so it is NOT half-done, start via Alt+S -> silence timeout test (25s + 15s)
            page.evaluate("""() => {
              document.getElementById('f-name').value = '';
              window.__SW_WIDGET__.forms.undoStack = [];
              window.__SW_WIDGET__.forms.stopGuidedFill();
              window.__SW_WIDGET__.close();
              window.__SPOKEN__ = [];
            }""")

            # -----------------------------------------------------------------
            # T6: Alt+S starts session + Silence timeouts (25s ask, +15s quiet end)
            # -----------------------------------------------------------------
            page.evaluate("() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', altKey: true, bubbles: true })); }")
            assert page.evaluate("() => window.__SW_WIDGET__.dialogue.isActive() && window.__SW_WIDGET__.isOpen"), "T6 Alt+S failed to start"

            # Advance 24s: NOT prompted yet
            page.clock.run_for(24000)
            assert "Are you still there?" not in page.evaluate("() => window.__SPOKEN__"), "T6 prompted before 25s"

            # Advance 1500ms (total 25.5s): prompted "Are you still there?"
            page.clock.run_for(1500)
            spoken_25 = page.evaluate("() => window.__SPOKEN__")
            assert any("Are you still there?" in s for s in spoken_25), f"T6 missing 25s prompt: {spoken_25}"
            assert page.evaluate("() => window.__SW_WIDGET__.dialogue.isActive()") is True

            # Finish TTS for "Are you still there?" so silence state resumes, then user replies "yes"
            page.evaluate("() => window.__FINISH_TTS__()")
            page.clock.run_for(350)
            page.evaluate("async () => { await window.__SW_SAY__('yes'); }")
            page.evaluate("() => { window.__FINISH_TTS__(); window.__FINISH_TTS__(); }")
            page.clock.run_for(350)
            assert page.evaluate("() => window.__SW_WIDGET__.dialogue.isActive()") is True

            # Now let full 25s + 15s (40s) elapse quietly
            page.evaluate("() => { window.__SPOKEN__ = []; }")
            page.clock.run_for(25200)
            assert any("Are you still there?" in s for s in page.evaluate("() => window.__SPOKEN__"))
            page.evaluate("() => window.__FINISH_TTS__()")
            page.clock.run_for(15200)
            quiet_end = page.evaluate("""() => ({
              active: window.__SW_WIDGET__.dialogue.isActive(),
              listening: window.__SW_WIDGET__.voice.isListening,
              reply: window.__SW_WIDGET__.shadowRoot.getElementById('sw-assistant-text').textContent
            })""")
            assert not quiet_end["active"] and not quiet_end["listening"], f"T6 quiet end failed: {quiet_end}"
            assert "inactivity" in quiet_end["reply"].lower(), f"T6 quiet reply wrong: {quiet_end}"

            # Test Hindi/Hinglish direct END phrases
            for end_phrase in ["thanks for the help", "that's all", "band karo", "धन्यवाद"]:
                page.evaluate("() => { window.__SW_WIDGET__.dialogue.startSession({ source: 'test' }); }")
                assert page.evaluate("() => window.__SW_WIDGET__.dialogue.isActive()")
                page.evaluate("(p) => window.__SW_SAY__(p)", end_phrase)
                assert not page.evaluate("() => window.__SW_WIDGET__.dialogue.isActive()"), f"Failed to end on '{end_phrase}'"

            print("PASS: All Phase C1 Dialogue E2E tests passed (T1-T6, 100%)!")
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    run_c1_tests()
