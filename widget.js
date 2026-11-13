/**
 * Sleepwalker - widget.js
 *
 * Responsibilities:
 * 1. Inject and manage the Shadow DOM side panel (about 360-380px wide).
 * 2. Render all accessible UI elements (mic button, live transcript, assistant feedback,
 *    quick buttons, language toggle, font-size and speech-rate controls, outline view).
 * 3. Coordinate between voice recognition (voice.js), page reader (reader.js),
 *    and outline/fuzzy matching (outline.js).
 * 4. Save and restore user preferences using chrome.storage.local.
 * 5. Provide real-time diagnostics and error tracking via window.__SLEEPWALKER_DIAG__().
 */

(function () {
  'use strict';

  if (window.SleepwalkerWidget) return;

  class SleepwalkerWidget {
    constructor() {
      this.isOpen = false;
      this.lang = 'en-IN';       // 'en-IN' or 'hi-IN'
      this.fontSize = 18;        // 18, 22, 26
      this.rate = 1.0;           // 0.8, 1.0, 1.2
      this.hostElement = null;
      this.shadowRoot = null;
      this.pill = null;
      this.glow = null;
      this._lastToggleTime = 0;
      this.errors = [];          // Last 10 errors for diagnostics

      // Sub-modules
      this.reader = null;
      this.outline = null;
      this.voice = null;

      this.init();
    }

    /**
     * Initialize DOM, submodules, and listeners.
     */
    async init() {
      this.createShadowDom();
      this.initModules();
      this.bindModuleEvents();
      this.bindUiEvents();
      await this.loadPreferences();

      // Initialize always-available floating pill (Phase 1)
      if (window.SleepwalkerPill) {
        this.pill = new window.SleepwalkerPill({
          shadowRoot: this.shadowRoot,
          widget: this
        });
      }

      // Initialize Full-Screen Prism Glow Overlay (Feature C)
      if (window.SleepwalkerGlow) {
        this.glow = new window.SleepwalkerGlow({
          shadowRoot: this.shadowRoot,
          widget: this
        });
      }

      // Register global console diagnostic hook
      window.__SLEEPWALKER_DIAG__ = () => this.runDiagnostics();
    }

    /**
     * Create isolated host element and attach open Shadow DOM.
     */
    createShadowDom() {
      let host = document.getElementById('sleepwalker-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'sleepwalker-host';
        const parent = document.body || document.documentElement;
        parent.appendChild(host);
      }

      // Host element covers viewport with pointer-events: none so page clicks pass through
      host.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        overflow: hidden !important;
      `;

      this.hostElement = host;
      this.shadowRoot = host.attachShadow({ mode: 'open' });

      // Link external widget.css
      const cssLink = document.createElement('link');
      cssLink.rel = 'stylesheet';
      cssLink.href = chrome.runtime.getURL('widget.css');
      this.shadowRoot.appendChild(cssLink);

      // Render main HTML template
      const template = document.createElement('div');
      template.className = 'sw-panel';
      template.id = 'sw-panel';
      template.setAttribute('role', 'region');
      template.setAttribute('aria-label', 'Sleepwalker Voice Assistant');
      template.innerHTML = this.getHtmlTemplate();
      this.shadowRoot.appendChild(template);
    }

    /**
     * UI HTML markup.
     */
    getHtmlTemplate() {
      return `
        <!-- Header -->
        <header class="sw-header">
          <div class="sw-brand">
            <span class="sw-brand-icon" aria-hidden="true">🌙</span>
            <h1 class="sw-brand-title">Sleepwalker</h1>
          </div>
          <div class="sw-header-actions">
            <button id="sw-btn-mic-setup" class="sw-lang-btn" aria-label="Open Microphone Setup and Hardware Diagnostics" title="Microphone Setup & Diagnostics">
              <span>🎙️ Setup</span>
            </button>
            <button id="sw-btn-lang" class="sw-lang-btn" aria-label="Current language English. Click to switch to Hindi.">
              <span id="sw-lang-label">🇮🇳 EN</span>
            </button>
            <button id="sw-btn-close" class="sw-close-btn" aria-label="Close Sleepwalker assistant (Press Escape)">
              ✕
            </button>
          </div>
        </header>

        <!-- Scrollable Body -->
        <main class="sw-body">
          <!-- One-Time Privacy Notice (Dismissible) -->
          <div id="sw-privacy-banner" class="sw-privacy-banner" style="display: none;" role="region" aria-label="Privacy disclosure">
            <strong>🔒 Privacy & Data Transparency</strong>
            <p>
              • Chrome's Web Speech API transmits audio to Google servers for transcription.<br>
              • Explain mode calls Gemini via your proxy, or local Ollama on your machine.<br>
              • Sleepwalker <em>never</em> captures, reads, or transmits passwords or form inputs.<br>
              • For 100% offline local privacy, enable <strong>Local-Only Mode</strong> in settings below.
            </p>
            <button type="button" id="sw-btn-dismiss-privacy" class="sw-privacy-dismiss-btn" aria-label="Dismiss privacy disclosure">
              ✓ Got It / Dismiss
            </button>
          </div>

          <!-- Voice Microphone Card -->
          <section class="sw-mic-card" aria-label="Voice input control">
            <button id="sw-btn-mic" class="sw-mic-btn" aria-label="Turn on microphone to speak a command" aria-pressed="false">
              <span id="sw-mic-icon" aria-hidden="true">🎤</span>
            </button>
            <p id="sw-mic-status-text" class="sw-mic-status-label">Tap Mic to Speak</p>
            <span id="sw-status-pill" class="sw-status-pill sw-status-idle">Idle</span>

            <!-- Live Spoken Transcript -->
            <div id="sw-transcript-box" class="sw-transcript-box sw-transcript-empty" aria-live="polite">
              Your spoken words will appear here...
            </div>
          </section>

          <!-- Assistant Response Box -->
          <section class="sw-assistant-card" role="status" aria-live="assertive">
            <span class="sw-assistant-card-label">Assistant Status</span>
            <p id="sw-assistant-text" class="sw-assistant-text">
              Welcome to Sleepwalker. Say <strong>"Read this page"</strong> or tap the yellow button below.
            </p>
          </section>

          <!-- Typed Input Box (Fallback when speech fails) -->
          <form id="sw-typed-form" class="sw-typed-form" aria-label="Type command if microphone fails">
            <input
              type="text"
              id="sw-typed-input"
              class="sw-typed-input"
              placeholder="Type command (e.g. read, outline)..."
              aria-label="Type a command or section name"
              autocomplete="off"
            />
            <button type="submit" class="sw-typed-btn" aria-label="Send typed command">Send</button>
          </form>

          <!-- Quick Action Buttons -->
          <section class="sw-quick-actions" aria-label="Quick actions">
            <button id="sw-btn-read" class="sw-btn sw-btn-read" aria-label="Read this entire page aloud">
              🔊 Read This Page
            </button>
            <button id="sw-btn-outline" class="sw-btn sw-btn-outline" aria-label="Extract and list page headings and sections">
              📑 Outline
            </button>
            <button id="sw-btn-pause" class="sw-btn sw-btn-pause" aria-label="Pause or resume reading">
              ⏸️ Pause
            </button>
            <button id="sw-btn-stop" class="sw-btn sw-btn-stop" aria-label="Stop reading aloud">
              ⏹️ Stop
            </button>
          </section>

          <!-- Font Size & Speech Rate Controls -->
          <section class="sw-settings-box" aria-label="Display and speech settings">
            <!-- Text Size -->
            <div class="sw-settings-row">
              <span class="sw-settings-label">Text Size:</span>
              <div class="sw-pill-group" role="radiogroup" aria-label="Widget text size">
                <button type="button" class="sw-pill-btn sw-active" data-size="18" aria-label="Standard 18px text">18px</button>
                <button type="button" class="sw-pill-btn" data-size="22" aria-label="Large 22px text">22px</button>
                <button type="button" class="sw-pill-btn" data-size="26" aria-label="Extra large 26px text">26px</button>
              </div>
            </div>

            <!-- Speech Speed -->
            <div class="sw-settings-row">
              <span class="sw-settings-label">Reading Speed:</span>
              <div class="sw-pill-group" role="radiogroup" aria-label="Speech reading speed">
                <button type="button" class="sw-pill-btn" data-rate="0.8" aria-label="Slow reading speed 0.8x">0.8x</button>
                <button type="button" class="sw-pill-btn sw-active" data-rate="1.0" aria-label="Normal reading speed 1.0x">1.0x</button>
                <button type="button" class="sw-pill-btn" data-rate="1.2" aria-label="Fast reading speed 1.2x">1.2x</button>
              </div>
            </div>
          </section>

          <!-- AI & Display Configuration (Phase 7 Settings) -->
          <section class="sw-ai-card" aria-label="AI and Display Settings">
            <h3 class="sw-ai-card-title">⚙️ AI & Prism Glow Settings</h3>

            <!-- Prism Glow Checkbox -->
            <label class="sw-checkbox-row">
              <input type="checkbox" id="sw-toggle-glow" checked>
              <span>Full-Screen Prism Glow Animation</span>
            </label>

            <!-- Local Only Mode Checkbox -->
            <label class="sw-checkbox-row">
              <input type="checkbox" id="sw-toggle-local-only">
              <span>Local-Only Mode (Skip Cloud Gemini; use Ollama/Offline)</span>
            </label>

            <!-- Gemini API Key -->
            <div class="sw-ai-field">
              <label for="sw-input-gemini-key" class="sw-ai-label">Direct Gemini API Key (Google AI Studio):</label>
              <input type="password" id="sw-input-gemini-key" class="sw-ai-input" placeholder="Enter Gemini API Key" autocomplete="off" spellcheck="false">
              <div style="font-size:12px;color:#889;margin-top:3px;">Pre-configured for instant zero-setup cloud AI.</div>
            </div>

            <!-- Cloud Proxy URL -->
            <div class="sw-ai-field">
              <label for="sw-input-proxy-url" class="sw-ai-label">Cloud Serverless Proxy URL (Optional):</label>
              <input type="text" id="sw-input-proxy-url" class="sw-ai-input" placeholder="e.g. https://sleepwalker-proxy.workers.dev" autocomplete="off" spellcheck="false">
            </div>

            <!-- Ollama URL & Model -->
            <div class="sw-ai-field">
              <label for="sw-input-ollama-url" class="sw-ai-label">Local Ollama URL:</label>
              <input type="text" id="sw-input-ollama-url" class="sw-ai-input" value="http://localhost:11434" autocomplete="off" spellcheck="false">
            </div>

            <div class="sw-ai-field">
              <label for="sw-input-ollama-model" class="sw-ai-label">Ollama Model Name:</label>
              <input type="text" id="sw-input-ollama-model" class="sw-ai-input" value="llama3.2:3b" autocomplete="off" spellcheck="false">
            </div>

            <!-- Connection Test Status Feedback -->
            <div id="sw-ai-test-status" class="sw-ai-test-result"></div>

            <div class="sw-ai-btn-row">
              <button type="button" id="sw-btn-test-ai" class="sw-btn-test-conn" aria-label="Test connection to Ollama or Proxy">
                🔌 Test Connection
              </button>
              <button type="button" id="sw-btn-save-ai" class="sw-btn-save-ai" aria-label="Save AI settings">
                💾 Save Settings
              </button>
            </div>
          </section>

          <!-- Outline Panel (Shown when Outline is requested) -->
          <section id="sw-outline-view" class="sw-outline-view" style="display: none;" aria-label="Page sections outline">
            <h2 class="sw-view-title">
              <span>Page Headings</span>
              <span id="sw-outline-count" class="sw-outline-badge">0 sections</span>
            </h2>
            <ul id="sw-outline-list" class="sw-outline-list" role="list"></ul>
          </section>

          <!-- Diagnostics Section -->
          <section class="sw-diag-section" aria-label="Extension diagnostics">
            <button type="button" id="sw-btn-diag" class="sw-btn-diag" aria-label="Open Diagnostics details">
              🛠️ Diagnostics & Audio Check
            </button>
            <div id="sw-diag-view" class="sw-diag-box" style="display: none;" aria-live="polite">
              <div class="sw-diag-header">
                <strong>System Health & Diagnostics</strong>
                <button type="button" id="sw-btn-test-speech" class="sw-outline-read-btn">🔊 Test Voice</button>
              </div>
              <div id="sw-diag-content">Loading diagnostics...</div>
            </div>
          </section>

          <!-- Voice Commands Help Accordion -->
          <details class="sw-help-box">
            <summary>📖 Voice Commands List</summary>
            <table>
              <thead>
                <tr><th>Command</th><th>What It Does</th></tr>
              </thead>
              <tbody>
                <tr><td><code>"Read this page"</code><br><code>"पेज पढ़ो"</code></td><td>Reads the entire main content.</td></tr>
                <tr><td><code>"Outline"</code><br><code>"आउटलाइन"</code></td><td>Lists all headings & sections.</td></tr>
                <tr><td><code>"Read the &lt;name&gt; section"</code><br><code>"&lt;name&gt; पढ़ो"</code></td><td>Fuzzy matches & reads that section (e.g. "fees").</td></tr>
                <tr><td><code>"Pause"</code> / <code>"Resume"</code><br><code>"रोको"</code> / <code>"आगे पढ़ो"</code></td><td>Pauses or continues speech.</td></tr>
                <tr><td><code>"Stop"</code><br><code>"बंद करो"</code></td><td>Stops speaking immediately.</td></tr>
                <tr><td><code>"Read it again"</code><br><code>"फिर से पढ़ो"</code></td><td>Repeats current reading from the beginning.</td></tr>
                <tr><td><code>"Help"</code><br><code>"मदद"</code></td><td>Explains available voice commands.</td></tr>
              </tbody>
            </table>
          </details>
        </main>
      `;
    }

    /**
     * Instantiate reader, outline, and voice modules.
     */
    initModules() {
      this.reader = new window.SleepwalkerReader();
      this.outline = new window.SleepwalkerOutline();
      this.voice = new window.SleepwalkerVoice();

      // Feature B: Explain This Page engine
      if (window.SleepwalkerExplainer) {
        this.explainer = new window.SleepwalkerExplainer(this);
      }

      this.reader.setLang(this.lang);
      this.reader.setRate(this.rate);
      this.voice.setLang(this.lang);
    }

    /**
     * Connect callbacks from reader and voice engines to the UI.
     */
    bindModuleEvents() {
      // 1. Voice transcript live stream
      this.voice.onTranscript = ({ text, isFinal }) => {
        const transcriptBox = this.shadowRoot.getElementById('sw-transcript-box');
        if (transcriptBox) {
          if (text) {
            transcriptBox.textContent = `"${text}"`;
            transcriptBox.classList.remove('sw-transcript-empty');
          } else {
            transcriptBox.textContent = 'Listening...';
          }
        }

        // Live streaming transcript inside the floating pill bubble!
        if (this.pill && this.pill.state === 'listening') {
          this.pill.setStatus(`"${text}"`);
        }
      };

      // 2. Voice command recognized
      this.voice.onCommand = (cmd) => {
        this.executeCommand(cmd);
      };

      // 3. Voice error handling
      this.voice.onError = ({ error, message, isPermissionDenied }) => {
        this.setAssistantReply(message);
        this.updateStatusPill('idle', 'Mic Error');
        this.recordError(`Microphone (${error}): ${message}`);
        const micBtn = this.shadowRoot.getElementById('sw-btn-mic');
        if (micBtn) {
          micBtn.classList.remove('sw-listening');
          micBtn.setAttribute('aria-pressed', 'false');
        }
        if (this.pill) {
          this.pill.setError(message);
        }
        if (this.glow) {
          this.glow.setError();
        }
      };

      // 4. Voice listening state changed
      this.voice.onStateChange = (isListening) => {
        const micBtn = this.shadowRoot.getElementById('sw-btn-mic');
        const micStatus = this.shadowRoot.getElementById('sw-mic-status-text');
        if (micBtn && micStatus) {
          if (isListening) {
            micBtn.classList.add('sw-listening');
            micBtn.setAttribute('aria-pressed', 'true');
            micStatus.textContent = this.lang === 'hi-IN' ? 'सुन रहा हूँ... बोलिए' : 'Listening... Speak now';
            this.updateStatusPill('listening', 'Listening');
          } else {
            micBtn.classList.remove('sw-listening');
            micBtn.setAttribute('aria-pressed', 'false');
            micStatus.textContent = this.lang === 'hi-IN' ? 'माइक दबाकर बोलें' : 'Tap Mic to Speak';
            if (!this.reader.isPlaying) {
              this.updateStatusPill('idle', 'Idle');
            }
          }
        }

        if (isListening) {
          if (this.pill && this.pill.state !== 'listening') {
            this.pill.setListening('Listening... Speak now');
          }
          if (this.glow) {
            this.glow.setListening();
          }
        } else {
          if (this.pill && this.pill.state === 'listening') {
            this.pill.setIdle('Ready • Type or speak a command');
          }
          if (this.glow && this.glow.state === 'listening') {
            this.glow.setOff();
          }
        }
      };

      // 5. Reader sentence change
      this.reader.onSentenceChange = ({ index, total, text }) => {
        if (total > 0) {
          this.setAssistantReply(`Reading sentence ${index} of ${total}:\n"${text}"`);
          if (this.pill) {
            const shortText = text.length > 50 ? text.substring(0, 48) + '...' : text;
            this.pill.setSpeaking(`Reading [${index}/${total}]: "${shortText}"`);
          }
        } else {
          this.setAssistantReply(text);
          if (this.pill) {
            this.pill.setStatus(text);
          }
        }
      };

      // 6. Reader status change
      this.reader.onStatusChange = ({ isPlaying, isPaused }) => {
        const pauseBtn = this.shadowRoot.getElementById('sw-btn-pause');

        if (isPlaying) {
          if (isPaused) {
            this.updateStatusPill('paused', 'Paused');
            if (pauseBtn) pauseBtn.textContent = '▶️ Resume';
            if (this.pill) {
              this.pill.setStatus('Reading paused. Press Resume or Stop.');
            }
          } else {
            this.updateStatusPill('reading', 'Reading');
            if (pauseBtn) pauseBtn.textContent = '⏸️ Pause';
            if (this.pill) {
              this.pill.setSpeaking();
            }
          }
        } else {
          if (!this.voice.isListening) {
            this.updateStatusPill('idle', 'Idle');
          }
          if (pauseBtn) pauseBtn.textContent = '⏸️ Pause';
          if (this.pill && this.pill.state === 'speaking') {
            this.pill.setIdle('Stopped.');
          }
        }
      };

      // 7. Reader error handling
      this.reader.onError = (errMsg) => {
        this.setAssistantReply(`⚠️ ${errMsg}`);
        this.updateStatusPill('idle', 'Speech Error');
        this.recordError(`Reader: ${errMsg}`);
        if (this.pill) {
          this.pill.setError(errMsg);
        }
      };

      // 8. Reader finished
      this.reader.onFinished = () => {
        this.setAssistantReply('Finished reading the page.');
        this.updateStatusPill('idle', 'Done');
        if (this.pill) {
          this.pill.setIdle('Finished reading the page.');
        }
        if (this.glow) {
          this.glow.setOff();
        }
      };
    }

    /**
     * Bind UI button clicks, keyboard shortcuts, and form submissions.
     */
    bindUiEvents() {
      const root = this.shadowRoot;

      root.getElementById('sw-btn-close').addEventListener('click', () => {
        this.close();
      });

      const micSetupBtn = root.getElementById('sw-btn-mic-setup');
      if (micSetupBtn) {
        micSetupBtn.addEventListener('click', () => {
          if (this.voice) {
            this.voice.openMicSetup();
          }
        });
      }

      root.getElementById('sw-btn-lang').addEventListener('click', () => {
        this.toggleLanguage();
      });

      root.getElementById('sw-btn-mic').addEventListener('click', () => {
        this.voice.toggleListening();
      });

      root.getElementById('sw-btn-read').addEventListener('click', () => {
        this.readPage();
      });

      root.getElementById('sw-btn-outline').addEventListener('click', () => {
        this.showOutline();
      });

      root.getElementById('sw-btn-pause').addEventListener('click', () => {
        if (this.reader.isPaused) {
          this.reader.resume();
        } else {
          this.reader.pause();
        }
      });

      root.getElementById('sw-btn-stop').addEventListener('click', () => {
        this.stopReading();
      });

      // Typed Input Form
      root.getElementById('sw-typed-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = root.getElementById('sw-typed-input');
        const text = (input.value || '').trim();
        if (!text) return;

        input.value = '';
        const transcriptBox = root.getElementById('sw-transcript-box');
        if (transcriptBox) {
          transcriptBox.textContent = `Typed: "${text}"`;
          transcriptBox.classList.remove('sw-transcript-empty');
        }

        const cmd = this.voice.parseCommand(text);
        this.executeCommand(cmd);
      });

      // Diagnostics button toggle
      root.getElementById('sw-btn-diag').addEventListener('click', async () => {
        const diagView = root.getElementById('sw-diag-view');
        if (diagView.style.display === 'none') {
          diagView.style.display = 'block';
          await this.renderDiagnostics();
        } else {
          diagView.style.display = 'none';
        }
      });

      // Test Speech Audio button inside Diagnostics
      root.getElementById('sw-btn-test-speech').addEventListener('click', () => {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance('Sleepwalker audio test. Speech synthesis is working correctly.');
          u.rate = this.rate;
          const v = this.reader ? this.reader.getBestVoice(this.lang) : null;
          if (v) u.voice = v;
          u.onend = () => this.setAssistantReply('Audio test succeeded! Voice output is working.');
          u.onerror = (e) => {
            const err = `Audio test failed (${e.error || 'unknown'})`;
            this.setAssistantReply(`⚠️ ${err}`);
            this.recordError(err);
          };
          window.speechSynthesis.speak(u);
          this.setAssistantReply('Playing audio test chime...');
        } else {
          const err = 'SpeechSynthesis not supported in this browser.';
          this.setAssistantReply(`⚠️ ${err}`);
          this.recordError(err);
        }
      });

      // Font size buttons
      root.querySelectorAll('[data-size]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sz = parseInt(btn.getAttribute('data-size'), 10);
          this.setFontSize(sz);
        });
      });

      // Speech rate buttons
      root.querySelectorAll('[data-rate]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const r = parseFloat(btn.getAttribute('data-rate'));
          this.setRate(r);
        });
      });

      // Privacy notice dismiss
      const dismissPrivacyBtn = root.getElementById('sw-btn-dismiss-privacy');
      if (dismissPrivacyBtn) {
        dismissPrivacyBtn.addEventListener('click', () => {
          const banner = root.getElementById('sw-privacy-banner');
          if (banner) banner.style.display = 'none';
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ sleepwalker_privacy_ack: true });
          }
        });
      }

      // AI Settings Test & Save
      const btnTestAi = root.getElementById('sw-btn-test-ai');
      if (btnTestAi) {
        btnTestAi.addEventListener('click', () => this.testAiConnection());
      }

      const btnSaveAi = root.getElementById('sw-btn-save-ai');
      if (btnSaveAi) {
        btnSaveAi.addEventListener('click', () => this.saveAiSettings());
      }

      // Prism Glow toggle immediate effect
      const glowToggle = root.getElementById('sw-toggle-glow');
      if (glowToggle) {
        glowToggle.addEventListener('change', (e) => {
          if (this.glow) {
            this.glow.setEnabled(e.target.checked);
          }
        });
      }

      // Global keyboard accessibility inside the widget
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (this.reader.isPlaying) {
            this.stopReading();
          } else {
            this.close();
          }
        }
      });
    }

    /**
     * Record a timestamped error message for the diagnostics log (keeps last 10).
     */
    recordError(msg) {
      if (!msg) return;
      const entry = {
        time: new Date().toLocaleTimeString(),
        message: String(msg)
      };
      this.errors.unshift(entry);
      if (this.errors.length > 10) {
        this.errors.pop();
      }
      console.warn('[Sleepwalker Error]', entry.time, entry.message);

      const diagView = this.shadowRoot && this.shadowRoot.getElementById('sw-diag-view');
      if (diagView && diagView.style.display !== 'none') {
        this.renderDiagnostics();
      }
    }

    /**
     * Gather comprehensive system diagnostics.
     */
    async runDiagnostics() {
      let micState = 'unknown';
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const p = await navigator.permissions.query({ name: 'microphone' });
          micState = p.state;
        }
      } catch (e) {
        micState = 'query-unsupported';
      }

      const restrictedPrefixes = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'view-source:', 'devtools://'];
      const isRestricted = restrictedPrefixes.some(p => location.href.startsWith(p)) ||
        location.href.includes('chrome.google.com/webstore') ||
        location.href.includes('chromewebstore.google.com');

      const voices = (this.reader && this.reader.voices && this.reader.voices.length > 0)
        ? this.reader.voices
        : ('speechSynthesis' in window ? window.speechSynthesis.getVoices() : []);

      const hasEnIn = voices.some(v => (v.lang || '').toLowerCase() === 'en-in' || (v.lang || '').toLowerCase().startsWith('en'));
      const hasHiIn = voices.some(v => (v.lang || '').toLowerCase().startsWith('hi'));

      const report = {
        extensionVersion: '1.0.0',
        pageUrl: window.location.href,
        isRestrictedPage: isRestricted,
        isFileUrl: window.location.protocol === 'file:',
        speechSynthesisSupported: 'speechSynthesis' in window,
        totalVoicesFound: voices.length,
        enInVoiceAvailable: hasEnIn,
        hiInVoiceAvailable: hasHiIn,
        speechRecognitionSupported: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
        microphonePermission: micState,
        last10Errors: [...this.errors]
      };

      console.group('🌙 Sleepwalker Diagnostics Report');
      console.table({
        'Extension Version': report.extensionVersion,
        'Page URL': report.pageUrl,
        'Is Restricted Page': report.isRestrictedPage,
        'Is Local File (file://)': report.isFileUrl,
        'SpeechSynthesis Supported': report.speechSynthesisSupported,
        'Total Voices Count': report.totalVoicesFound,
        'English Voice Available': report.enInVoiceAvailable,
        'Hindi Voice Available': report.hiInVoiceAvailable,
        'SpeechRecognition Supported': report.speechRecognitionSupported,
        'Microphone Permission': report.microphonePermission
      });
      if (this.errors.length > 0) {
        console.log('Recent Errors:', this.errors);
      } else {
        console.log('Recent Errors: None.');
      }
      console.groupEnd();

      return report;
    }

    /**
     * Render diagnostics data into the widget panel.
     */
    async renderDiagnostics() {
      const container = this.shadowRoot.getElementById('sw-diag-content');
      if (!container) return;

      const d = await this.runDiagnostics();

      const okBadge = (val) => val ? '<span style="color:#00E676;font-weight:bold;">✔ OK</span>' : '<span style="color:#FF5252;font-weight:bold;">✖ NO</span>';
      const micBadge = (state) => {
        if (state === 'granted') return '<span style="color:#00E676;font-weight:bold;">✔ Granted</span>';
        if (state === 'denied') return '<span style="color:#FF5252;font-weight:bold;">✖ Blocked / Denied</span>';
        return `<span style="color:#FFD600;font-weight:bold;">⏳ ${state}</span>`;
      };

      let errorsHtml = '<p style="color:#888;margin:4px 0;">No errors recorded.</p>';
      if (d.last10Errors.length > 0) {
        errorsHtml = '<ul style="margin:4px 0;padding-left:18px;color:#FF8A80;font-size:14px;">' +
          d.last10Errors.map(e => `<li><strong>${e.time}:</strong> ${e.message}</li>`).join('') +
          '</ul>';
      }

      container.innerHTML = `
        <div style="font-size:15px;line-height:1.6;">
          <div><strong>Version:</strong> v${d.extensionVersion} | <strong>Protocol:</strong> ${d.isFileUrl ? '<span style="color:#FFD600;">file:// (Needs "Allow file URLs")</span>' : 'Web (http/https)'}</div>
          <div><strong>Speech Synthesis:</strong> ${okBadge(d.speechSynthesisSupported)} (${d.totalVoicesFound} voices)</div>
          <div><strong>English Voice:</strong> ${okBadge(d.enInVoiceAvailable)} | <strong>Hindi Voice:</strong> ${okBadge(d.hiInVoiceAvailable)}</div>
          <div><strong>Speech Recognition:</strong> ${okBadge(d.speechRecognitionSupported)}</div>
          <div><strong>Mic Permission:</strong> ${micBadge(d.microphonePermission)}</div>
          <div style="margin-top:6px;border-top:1px solid #334;padding-top:6px;">
            <strong>Recent Errors (${d.last10Errors.length}):</strong>
            ${errorsHtml}
          </div>
        </div>
      `;
    }

    /**
     * Dispatch recognized voice or typed command to the appropriate action.
     */
    executeCommand(cmd) {
      console.log('[Sleepwalker] Executing command:', cmd);

      switch (cmd.type) {
        case 'READ_PAGE':
          this.readPage();
          break;

        case 'OUTLINE':
          this.showOutline();
          break;

        case 'EXPLAIN':
        case 'EXPLAIN_SECTION':
          this.explainPage(cmd.sectionQuery);
          break;

        case 'EXPLAIN_SOME_PART':
          this.explainSomePart();
          break;

        case 'NAVIGATE_SOME_PART':
          this.navigateSomePart();
          break;

        case 'NAVIGATE_SECTION':
          if (cmd.sectionQuery) {
            this.readSection(cmd.sectionQuery, true);
          } else {
            this.navigateSomePart();
          }
          break;

        case 'READ_SECTION':
        case 'QUERY_OR_SEARCH':
          if (cmd.sectionQuery) {
            this.readSection(cmd.sectionQuery, false);
          } else {
            this.setAssistantReply('Please specify a section name to read.');
          }
          break;

        case 'PAUSE':
          this.reader.pause();
          this.setAssistantReply('Reading paused.');
          break;

        case 'RESUME':
          this.reader.resume();
          this.setAssistantReply('Resuming reading...');
          break;

        case 'STOP':
          this.stopReading();
          break;

        case 'READ_AGAIN':
          this.setAssistantReply('Restarting from the beginning...');
          this.reader.readAgain();
          break;

        case 'HELP':
          this.setAssistantReply(
            this.lang === 'hi-IN'
              ? 'कमांड: "पेज पढ़ो", "आउटलाइन", "<सेक्शन> पढ़ो", "रोको", "जारी रखो", "फिर से पढ़ो"।'
              : 'Commands available: "Read this page", "Outline", "Read the <name> section", "Pause", "Resume", "Stop", "Read it again".'
          );
          const details = this.shadowRoot.querySelector('details.sw-help-box');
          if (details) details.open = true;
          break;

        default:
          const unknownMsg = `Command not recognized: "${cmd.raw}". Say "Help" for options.`;
          this.setAssistantReply(unknownMsg);
          this.recordError(unknownMsg);
      }
    }

    /**
     * Action: Read whole page.
     */
    readPage() {
      this.setAssistantReply('Extracting page content and starting to read...');
      const success = this.reader.readPage();
      if (!success) {
        const msg = 'No readable text found on this page.';
        this.setAssistantReply(msg);
        this.recordError(msg);
      }
    }

    /**
     * Action: Stop reading or explaining.
     */
    stopReading() {
      if (this.explainer) {
        this.explainer.abort();
      }
      this.reader.stop();
      this.setAssistantReply('Reading stopped.');
      if (this.glow) {
        this.glow.setOff();
      }
      if (this.pill && (this.pill.state === 'preparing' || this.pill.state === 'speaking')) {
        this.pill.setIdle('Stopped.');
      }
    }

    /**
     * Action: Show outline of headings and sections.
     */
    showOutline() {
      const items = this.outline.extractOutline();
      const outlineView = this.shadowRoot.getElementById('sw-outline-view');
      const outlineList = this.shadowRoot.getElementById('sw-outline-list');
      const outlineCount = this.shadowRoot.getElementById('sw-outline-count');

      if (!outlineView || !outlineList) return;

      outlineList.innerHTML = '';
      outlineCount.textContent = `${items.length} sections`;

      if (items.length === 0) {
        const msg = 'No headings or sections were detected on this page.';
        this.setAssistantReply(msg);
        this.recordError(msg);
        outlineView.style.display = 'none';
        return;
      }

      items.forEach((item) => {
        const li = document.createElement('li');
        li.className = 'sw-outline-item';
        li.setAttribute('role', 'listitem');

        const indentPx = Math.max(0, (item.level - 1) * 12);
        li.style.marginLeft = `${indentPx}px`;

        li.innerHTML = `
          <span class="sw-outline-badge">H${item.level}</span>
          <span class="sw-outline-item-title" title="${item.text}">${item.text}</span>
          <button type="button" class="sw-outline-read-btn" aria-label="Read section ${item.text}">
            🔊 Read
          </button>
        `;

        li.addEventListener('click', (e) => {
          if (e.target.closest('.sw-outline-read-btn')) return;
          this.outline.scrollToHeading(item);
          this.setAssistantReply(`Jumped to section: "${item.text}"`);
        });

        const readBtn = li.querySelector('.sw-outline-read-btn');
        readBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.outline.scrollToHeading(item);
          this.setAssistantReply(`Reading section: "${item.text}"`);
          this.reader.readElements(item.sectionElements, item.text);
        });

        outlineList.appendChild(li);
      });

      outlineView.style.display = 'flex';
      outlineView.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const outlineMsg = `Found ${items.length} sections. Say "Read the <name> section" or tap any heading.`;
      this.setAssistantReply(outlineMsg);
      if (this.pill) {
        this.pill.setStatus(`Found ${items.length} sections. Tap Full Panel or say "Read fees".`);
        this.pill.openBubble();
      }
    }

    /**
     * Action: Fuzzy match heading and jump to/read that section.
     */
    readSection(query, navigateOnly = false) {
      if (this.outline.items.length === 0) {
        this.outline.extractOutline();
      }

      const match = this.outline.fuzzyFindHeading(query);
      if (match) {
        this.outline.scrollToHeading(match);
        const actionPrefix = navigateOnly ? 'Jumped to section' : 'Found section';
        this.setAssistantReply(`${actionPrefix}: "${match.text}". Reading now...`);
        if (this.pill) {
          this.pill.setSpeaking(`"${match.text}"`);
        }
        this.reader.readElements(match.sectionElements, match.text);
      } else {
        const topSections = this.outline.items.slice(0, 3).map(i => `"${i.text}"`).join(', ');
        const msg = topSections
          ? `Could not find section "${query}". Available sections include: ${topSections}. Say "Outline" to see all.`
          : `Could not find section "${query}". Say "Outline" to view all sections.`;
        this.setAssistantReply(msg);
        this.recordError(msg);
        if (this.pill) {
          this.pill.setError(`Section "${query}" not found.`);
        }
        this.showOutline();
      }
    }

    /**
     * Action: Navigate to some part of the page (general request).
     */
    navigateSomePart() {
      if (this.outline.items.length === 0) {
        this.outline.extractOutline();
      }

      if (this.outline.items.length > 0) {
        const target = this.outline.items[0];
        this.outline.scrollToHeading(target);
        const topSections = this.outline.items.slice(0, 3).map(i => `"${i.text}"`).join(', ');
        const msg = `Navigated to "${target.text}". This page has ${this.outline.items.length} sections including ${topSections}. Say "take me to [name]" or "explain [name]" to navigate.`;
        this.setAssistantReply(msg);
        if (this.pill) {
          this.pill.setStatus(`Section: "${target.text}"`);
          this.pill.openBubble();
        }
        this.showOutline();
        this.reader.readElements(target.sectionElements, target.text);
      } else {
        this.setAssistantReply('This page does not have separate section headings. Reading from top of page...');
        this.readPage();
      }
    }

    /**
     * Action: Explain some part of the page (general request).
     */
    explainSomePart() {
      if (this.outline.items.length === 0) {
        this.outline.extractOutline();
      }

      if (this.outline.items.length > 0) {
        const target = this.outline.items[0];
        this.setAssistantReply(`Explaining main section: "${target.text}"...`);
        this.explainPage(target.text);
      } else {
        this.explainPage(null);
      }
    }

    /**
     * Action: Explain this page (Feature B signature feature).
     * Connects to SleepwalkerExplainer: safe extraction, background LLM cascade
     * (cache -> Gemini proxy -> local Ollama -> offline fallback), hallucination validation,
     * and reading aloud with prism glow coordination.
     */
    explainPage(sectionQuery = null) {
      if (this.explainer) {
        this.explainer.runExplainPipeline(sectionQuery);
      } else {
        const fallback = this.lang === 'hi-IN'
          ? 'पेज की जानकारी निकालने की कोशिश की जा रही है।'
          : 'Extracting page information and summary.';
        this.setAssistantReply(fallback);
        if (this.reader) {
          this.reader.readText(fallback);
        }
      }
    }

    /**
     * Start listening via Click-to-Talk on the floating pill.
     */
    startVoiceListening() {
      if (this.reader && this.reader.isPlaying) {
        this.reader.stop();
      }
      if (this.voice) {
        this.voice.startListening();
      }
      if (this.pill) {
        this.pill.setListening('Listening... Speak now');
      }
      if (this.glow) {
        this.glow.setListening();
      }
      this.setAssistantReply('Listening... Speak a command or pause 2s when finished.');
    }

    /**
     * Start listening via Hold-to-Talk (holding Alt+Z hotkey).
     */
    startHoldToTalk() {
      if (this.reader && this.reader.isPlaying) {
        this.reader.stop();
      }
      if (this.voice) {
        this.voice.startListening();
      }
      if (this.pill) {
        this.pill.setListening('Listening (holding Alt+Z)...');
      }
      if (this.glow) {
        this.glow.setListening();
      }
      this.setAssistantReply('Listening... Speak while holding Alt+Z, then release.');
    }

    /**
     * Stop listening and commit command upon hotkey release (Hold-to-Talk release).
     */
    stopHoldToTalk() {
      if (this.voice) {
        const committed = this.voice.stopListeningAndCommit();
        if (!committed && this.pill && this.pill.state === 'listening') {
          this.pill.setIdle('Ready • Type or speak a command');
          if (this.glow) this.glow.setOff();
        }
      }
    }

    /**
     * Language switch toggle between en-IN and hi-IN.
     */
    toggleLanguage() {
      const nextLang = this.lang === 'en-IN' ? 'hi-IN' : 'en-IN';
      this.setLanguage(nextLang);
    }

    /**
     * Set language and persist.
     */
    setLanguage(newLang) {
      this.lang = newLang;
      this.reader.setLang(newLang);
      this.voice.setLang(newLang);

      const label = this.shadowRoot.getElementById('sw-lang-label');
      const btn = this.shadowRoot.getElementById('sw-btn-lang');

      if (newLang === 'hi-IN') {
        if (label) label.textContent = '🇮🇳 HI';
        if (btn) btn.setAttribute('aria-label', 'वर्तमान भाषा हिंदी है। अंग्रेजी के लिए क्लिक करें।');
        this.setAssistantReply('भाषा हिंदी (hi-IN) पर सेट हो गई है।');
      } else {
        if (label) label.textContent = '🇮🇳 EN';
        if (btn) btn.setAttribute('aria-label', 'Current language English. Click to switch to Hindi.');
        this.setAssistantReply('Language set to English (en-IN).');
      }

      this.savePreferences();
    }

    /**
     * Set widget font size (18, 22, 26).
     */
    setFontSize(size) {
      this.fontSize = size;
      const panel = this.shadowRoot.getElementById('sw-panel');
      if (panel) {
        panel.style.setProperty('--sw-font-size', `${size}px`);
      }

      this.shadowRoot.querySelectorAll('[data-size]').forEach((b) => {
        b.classList.toggle('sw-active', parseInt(b.getAttribute('data-size'), 10) === size);
      });

      this.savePreferences();
    }

    /**
     * Set reader speech rate (0.8, 1.0, 1.2).
     */
    setRate(rate) {
      this.rate = rate;
      this.reader.setRate(rate);

      this.shadowRoot.querySelectorAll('[data-rate]').forEach((b) => {
        b.classList.toggle('sw-active', parseFloat(b.getAttribute('data-rate')) === rate);
      });

      this.setAssistantReply(`Reading speed set to ${rate}x.`);
      this.savePreferences();
    }

    /**
     * Update assistant text announcement.
     */
    setAssistantReply(text) {
      const el = this.shadowRoot.getElementById('sw-assistant-text');
      if (el) {
        el.textContent = text;
      }
    }

    /**
     * Update status pill styling and text.
     */
    updateStatusPill(state, label) {
      const pill = this.shadowRoot.getElementById('sw-status-pill');
      if (!pill) return;

      pill.className = `sw-status-pill sw-status-${state}`;
      pill.textContent = label;
    }

    /**
     * Open widget panel.
     */
    open() {
      const panel = this.shadowRoot.getElementById('sw-panel');
      if (panel) {
        panel.classList.add('sw-open');
        panel.style.transform = 'translateX(0)';
        this.isOpen = true;
        setTimeout(() => {
          const mic = this.shadowRoot.getElementById('sw-btn-mic');
          if (mic) mic.focus();
        }, 100);
      }
    }

    /**
     * Close widget panel.
     */
    close() {
      const panel = this.shadowRoot.getElementById('sw-panel');
      if (panel) {
        panel.classList.remove('sw-open');
        panel.style.transform = 'translateX(105%)';
        this.isOpen = false;
        this.voice.stopListening();
        this.reader.stop();
      }
    }

    /**
     * Toggle widget open/close with debounce protection.
     */
    toggle() {
      const now = Date.now();
      if (this._lastToggleTime && now - this._lastToggleTime < 350) {
        return;
      }
      this._lastToggleTime = now;

      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    }

    /**
     * Save user preferences to chrome.storage.local.
     */
    savePreferences() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          sleepwalker_lang: this.lang,
          sleepwalker_font_size: this.fontSize,
          sleepwalker_rate: this.rate
        });
      }
    }

    /**
     * Restore user preferences from chrome.storage.local.
     */
    async loadPreferences() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(
          [
            'sleepwalker_lang',
            'sleepwalker_font_size',
            'sleepwalker_rate',
            'sleepwalker_glow_enabled',
            'sleepwalker_local_only',
            'sleepwalker_gemini_api_key',
            'sleepwalker_proxy_url',
            'sleepwalker_ollama_url',
            'sleepwalker_ollama_model',
            'sleepwalker_privacy_ack'
          ],
          (data) => {
            if (data.sleepwalker_lang) {
              this.setLanguage(data.sleepwalker_lang);
            }
            if (data.sleepwalker_font_size) {
              this.setFontSize(data.sleepwalker_font_size);
            }
            if (data.sleepwalker_rate) {
              this.setRate(data.sleepwalker_rate);
            }

            const root = this.shadowRoot;
            if (!root) return;

            // Privacy disclosure banner
            const privacyBanner = root.getElementById('sw-privacy-banner');
            if (privacyBanner && !data.sleepwalker_privacy_ack) {
              privacyBanner.style.display = 'block';
            }

            // Glow toggle
            const glowToggle = root.getElementById('sw-toggle-glow');
            if (glowToggle) {
              glowToggle.checked = data.sleepwalker_glow_enabled !== false;
            }

            // Local only mode
            const localOnlyToggle = root.getElementById('sw-toggle-local-only');
            if (localOnlyToggle) {
              localOnlyToggle.checked = Boolean(data.sleepwalker_local_only);
            }

            // Gemini API key
            const geminiInput = root.getElementById('sw-input-gemini-key');
            if (geminiInput && data.sleepwalker_gemini_api_key) {
              geminiInput.value = data.sleepwalker_gemini_api_key;
            }

            // Cloud proxy URL
            const proxyInput = root.getElementById('sw-input-proxy-url');
            if (proxyInput && data.sleepwalker_proxy_url) {
              proxyInput.value = data.sleepwalker_proxy_url;
            }

            // Ollama URL
            const ollamaUrlInput = root.getElementById('sw-input-ollama-url');
            if (ollamaUrlInput && data.sleepwalker_ollama_url) {
              ollamaUrlInput.value = data.sleepwalker_ollama_url;
            }

            // Ollama Model
            const ollamaModelInput = root.getElementById('sw-input-ollama-model');
            if (ollamaModelInput && data.sleepwalker_ollama_model) {
              ollamaModelInput.value = data.sleepwalker_ollama_model;
            }
          }
        );
      }
    }

    /**
     * Save AI and display configuration to chrome.storage.local.
     */
    saveAiSettings() {
      const root = this.shadowRoot;
      if (!root) return;

      const glowToggle = root.getElementById('sw-toggle-glow');
      const localOnlyToggle = root.getElementById('sw-toggle-local-only');
      const geminiInput = root.getElementById('sw-input-gemini-key');
      const proxyInput = root.getElementById('sw-input-proxy-url');
      const ollamaUrlInput = root.getElementById('sw-input-ollama-url');
      const ollamaModelInput = root.getElementById('sw-input-ollama-model');
      const statusBox = root.getElementById('sw-ai-test-status');

      const glowEnabled = glowToggle ? glowToggle.checked : true;
      const localOnly = localOnlyToggle ? localOnlyToggle.checked : false;
      const geminiKey = geminiInput ? geminiInput.value.trim() : '';
      const proxyUrl = proxyInput ? proxyInput.value.trim() : '';
      const ollamaUrl = ollamaUrlInput ? (ollamaUrlInput.value.trim() || 'http://localhost:11434') : 'http://localhost:11434';
      const ollamaModel = ollamaModelInput ? (ollamaModelInput.value.trim() || 'llama3.2:3b') : 'llama3.2:3b';

      if (this.glow) {
        this.glow.setEnabled(glowEnabled);
      }

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          sleepwalker_glow_enabled: glowEnabled,
          sleepwalker_local_only: localOnly,
          sleepwalker_gemini_api_key: geminiKey,
          sleepwalker_proxy_url: proxyUrl,
          sleepwalker_ollama_url: ollamaUrl,
          sleepwalker_ollama_model: ollamaModel
        }, () => {
          if (statusBox) {
            statusBox.className = 'sw-ai-test-result sw-ai-test-success';
            statusBox.textContent = '✓ Settings saved successfully.';
            setTimeout(() => {
              if (statusBox && statusBox.textContent === '✓ Settings saved successfully.') {
                statusBox.className = 'sw-ai-test-result';
              }
            }, 3000);
          }
        });
      }
    }

    /**
     * Test reachability of configured Ollama or Cloud Proxy.
     * Dynamically requests optional_host_permissions at runtime if needed.
     */
    async testAiConnection() {
      const root = this.shadowRoot;
      if (!root) return;

      const statusBox = root.getElementById('sw-ai-test-status');
      const geminiInput = root.getElementById('sw-input-gemini-key');
      const proxyInput = root.getElementById('sw-input-proxy-url');
      const ollamaUrlInput = root.getElementById('sw-input-ollama-url');

      let geminiKey = geminiInput ? geminiInput.value.trim() : '';
      if (!geminiKey && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        geminiKey = await new Promise(r => chrome.storage.local.get(['sleepwalker_gemini_api_key'], d => r((d.sleepwalker_gemini_api_key || '').trim())));
      }
      const proxyUrl = proxyInput ? proxyInput.value.trim() : '';
      const ollamaUrl = ollamaUrlInput ? (ollamaUrlInput.value.trim() || 'http://localhost:11434') : 'http://localhost:11434';

      if (statusBox) {
        statusBox.className = 'sw-ai-test-result sw-ai-test-info';
        statusBox.textContent = 'Testing connection & verifying permissions...';
      }

      // Request optional host permissions if proxyUrl or ollama is specified
      const originsToRequest = [];
      if (proxyUrl) {
        try {
          const u = new URL(proxyUrl);
          originsToRequest.push(`${u.origin}/*`);
        } catch (e) {}
      }
      originsToRequest.push('http://localhost:11434/*');

      if (originsToRequest.length > 0 && typeof chrome !== 'undefined' && chrome.permissions && chrome.permissions.request) {
        try {
          await chrome.permissions.request({ origins: originsToRequest });
        } catch (e) {
          console.warn('[Sleepwalker Settings] Permissions request note:', e);
        }
      }

      // 1. Test Direct Gemini API
      if (geminiKey) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 6000);
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Ping' }] }]
            }),
            signal: controller.signal
          });
          clearTimeout(t);
          if (res.ok) {
            if (statusBox) {
              statusBox.className = 'sw-ai-test-result sw-ai-test-success';
              statusBox.textContent = '✅ Cloud Gemini API connected (Gemini Flash-Lite online)!';
            }
            return;
          }
        } catch (e) {
          console.warn('[Sleepwalker Settings] Gemini ping note:', e);
        }
      }

      // 2. Test Proxy if configured
      if (proxyUrl) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 4000);
          const res = await fetch(proxyUrl, {
            method: 'OPTIONS',
            signal: controller.signal
          });
          clearTimeout(t);
          if (res.ok || res.status === 204 || res.status === 405) {
            if (statusBox) {
              statusBox.className = 'sw-ai-test-result sw-ai-test-success';
              statusBox.textContent = `✅ Cloud Proxy reachable (${proxyUrl}).`;
            }
            return;
          }
        } catch (e) {
          console.warn('[Sleepwalker Settings] Proxy ping error:', e);
        }
      }

      // 3. Test Local Ollama
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
        clearTimeout(t);
        if (res.ok) {
          const data = await res.json();
          const models = (data.models || []).map(m => m.name).join(', ') || 'Connected';
          if (statusBox) {
            statusBox.className = 'sw-ai-test-result sw-ai-test-success';
            statusBox.textContent = `✅ Local Ollama online! Available models: ${models}`;
          }
          return;
        }
      } catch (e) {
        console.warn('[Sleepwalker Settings] Ollama ping error:', e);
      }

      // 4. Fallback info
      if (statusBox) {
        statusBox.className = 'sw-ai-test-result sw-ai-test-info';
        statusBox.textContent = 'ℹ️ Cloud AI and Ollama offline. Explain will use the built-in Offline Basic Summary (0ms, 100% private).';
      }
    }
  }

  window.SleepwalkerWidget = SleepwalkerWidget;
})();
