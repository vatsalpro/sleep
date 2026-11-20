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

  const SUPPORTED_LANGUAGES = {
    auto: { code: 'auto', shortCode: 'AUTO', name: 'Auto (Hinglish: HI -> EN retry)', speechLang: 'hi-IN' },
    'en-IN': { code: 'en-IN', shortCode: 'EN', name: 'English (India)', speechLang: 'en-IN' },
    'hi-IN': { code: 'hi-IN', shortCode: 'HI', name: 'Hindi', speechLang: 'hi-IN' },
    'ta-IN': { code: 'ta-IN', shortCode: 'TA', name: 'Tamil', speechLang: 'ta-IN' },
    'te-IN': { code: 'te-IN', shortCode: 'TE', name: 'Telugu', speechLang: 'te-IN' },
    'bn-IN': { code: 'bn-IN', shortCode: 'BN', name: 'Bengali', speechLang: 'bn-IN' },
    'mr-IN': { code: 'mr-IN', shortCode: 'MR', name: 'Marathi', speechLang: 'mr-IN' },
    'gu-IN': { code: 'gu-IN', shortCode: 'GU', name: 'Gujarati', speechLang: 'gu-IN' },
    'kn-IN': { code: 'kn-IN', shortCode: 'KN', name: 'Kannada', speechLang: 'kn-IN' },
    'ml-IN': { code: 'ml-IN', shortCode: 'ML', name: 'Malayalam', speechLang: 'ml-IN' },
    'pa-IN': { code: 'pa-IN', shortCode: 'PA', name: 'Punjabi', speechLang: 'pa-IN' }
  };

  const LANG_CYCLE_ORDER = ['en-IN', 'hi-IN', 'auto'];

  class SleepwalkerWidget {
    constructor() {
      this.isOpen = false;
      this.lang = 'en-IN';       // 'auto', 'en-IN', 'hi-IN', or regional code
      this.fontSize = 18;        // 18, 22, 26
      this.rate = 1.0;           // 0.6 to 1.5
      this.hostElement = null;
      this.shadowRoot = null;
      this.pill = null;
      this.glow = null;
      this._lastToggleTime = 0;
      this.errors = [];          // Last 10 errors for diagnostics
      this.lastExplainOptions = null;

      // Sub-modules
      this.reader = null;
      this.outline = null;
      this.voice = null;
      this.confirm = null;
      this.intentEngine = null;
      this.navigator = null;
      this.forms = null;
      this.upload = null;
      this.camera = null;
      this.dialogue = null;
      this.bargeIn = false;
      this.lastUndoableType = 'forms';
      this._isExplaining = false;
      this._initPromise = null;

      this.init();
    }

    /**
     * Initialize DOM, submodules, and listeners (idempotent).
     */
    init() {
      if (this._initPromise) return this._initPromise;
      this._initPromise = this._performInit();
      return this._initPromise;
    }

    async _performInit() {
      this.createShadowDom();
      this.initModules();
      this.bindModuleEvents();
      this.bindUiEvents();
      this.syncStopButton();
      await this.loadPreferences();

      // Initialize always-available floating pill (legacy; hidden immediately when P1 SW_UI is active)
      if (window.SleepwalkerPill) {
        this.pill = new window.SleepwalkerPill({
          shadowRoot: this.shadowRoot,
          widget: this
        });
        if (window.SW_UI || (this.isOpen && typeof this.pill.hide === 'function')) {
          this.pill.hide();
        }
      }
      if (window.SW_UI && typeof window.SW_UI.setHandlers === 'function') {
        window.SW_UI.setHandlers({
          onOrbClick: () => this.toggle({ startDialogue: true, source: 'orb' }),
          onSubmitText: (text) => this.handleUserInput(text, 'typed'),
          onDismiss: (reason) => this.dismissUi(reason || 'escape')
        });
      }
      this.syncStopButton();

      // Initialize Full-Screen Prism Glow Overlay (Feature C)
      if (window.SleepwalkerGlow) {
        this.glow = new window.SleepwalkerGlow({
          shadowRoot: this.shadowRoot,
          widget: this
        });
      }

      // Register global console diagnostic & test voice injection hooks
      window.__SLEEPWALKER_DIAG__ = () => this.runDiagnostics();
      window.__SW_SAY__ = (text, options = {}) => this.simulateVoiceInput(text, options);

      // Check chrome.storage.session for any cross-page resumable task
      if (this.navigator) {
        await this.navigator.checkSavedSessionOnBoot();
      }

      // Initialize Forms panel state & saved opt-in profile
      await this.initFormsPanel();

      // Initialize Files tab controls & upload card bindings
      this.initFilesPanel();
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

      // Inline Shadow DOM CSS safeguards so panel stays hidden when closed and SVGs never expand even if external CSS is absent
      const fallbackStyle = document.createElement('style');
      fallbackStyle.id = 'sw-widget-fallback-css';
      fallbackStyle.textContent = `
        :host {
          display: block !important;
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          z-index: 2147483647 !important;
          pointer-events: none !important;
          overflow: hidden !important;
        }
        .sw-panel {
          pointer-events: auto !important;
          position: fixed !important;
          top: 0 !important;
          right: 0 !important;
          width: 380px !important;
          max-width: 90vw !important;
          height: 100vh !important;
          background-color: #121214 !important;
          color: #FFFFFF !important;
          border-left: 3px solid #FFD600 !important;
          display: flex !important;
          flex-direction: column !important;
          transform: translateX(105%) !important;
          visibility: hidden !important;
          opacity: 0 !important;
          overflow: hidden !important;
          z-index: 2147483647 !important;
        }
        .sw-panel.sw-open {
          transform: translateX(0) !important;
          visibility: visible !important;
          opacity: 1 !important;
        }
        .sw-brand-badge {
          width: 24px;
          height: 24px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          overflow: hidden;
          color: #FFD600;
        }
        .sw-svg {
          width: 20px;
          height: 20px;
          min-width: 20px;
          min-height: 20px;
          max-width: 20px;
          max-height: 20px;
          display: inline-block;
          flex-shrink: 0;
          overflow: hidden;
        }
        svg {
          flex-shrink: 0;
        }
      `;
      this.shadowRoot.appendChild(fallbackStyle);

      // Link external stylesheet if available
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
        const cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';
        cssLink.href = chrome.runtime.getURL('ui.css');
        this.shadowRoot.appendChild(cssLink);
      }

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
     * Inline SVG icon helper (Shadow DOM safe, zero emojis/external fonts).
     * @param {string} name
     * @returns {string}
     */
    getSvgIcon(name) {
      const svgOpen = (sw = '2') => `<svg class="sw-svg" width="20" height="20" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">`;
      const icons = {
        moon: `${svgOpen()}<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
        mic: `${svgOpen()}<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`,
        globe: `${svgOpen()}<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
        close: `${svgOpen('2.2')}<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        talk: `${svgOpen()}<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
        page: `${svgOpen()}<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
        forms: `${svgOpen()}<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="13" y2="13"/></svg>`,
        files: `${svgOpen()}<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
        settings: `${svgOpen()}<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`,
        lock: `${svgOpen()}<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
        check: `${svgOpen('2.4')}<polyline points="20 6 9 17 4 12"/></svg>`,
        volume: `${svgOpen()}<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
        outline: `${svgOpen()}<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
        pause: `${svgOpen()}<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
        play: `${svgOpen()}<polygon points="5 3 19 12 5 21 5 3"/></svg>`,
        stop: `${svgOpen()}<rect x="5" y="5" width="14" height="14" rx="2"/></svg>`,
        wrench: `${svgOpen()}<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
        plug: `${svgOpen()}<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>`,
        book: `${svgOpen()}<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`
      };
      return icons[name] || '';
    }

    /**
     * UI HTML markup.
     */
    getHtmlTemplate() {
      return `
        <!-- Header -->
        <header class="sw-header">
          <div class="sw-brand">
            <span class="sw-brand-badge" aria-hidden="true">${this.getSvgIcon('moon')}</span>
            <h1 class="sw-brand-title">Sleepwalker</h1>
          </div>
          <div class="sw-header-actions">
            <button type="button" id="sw-btn-mic-setup" class="sw-lang-btn" aria-label="Open Microphone Setup and Hardware Diagnostics" title="Microphone Setup & Diagnostics">
              ${this.getSvgIcon('mic')}
              <span>Setup</span>
            </button>
            <button type="button" id="sw-btn-lang" class="sw-lang-btn" aria-label="Current language English. Click to cycle EN, HI, AUTO.">
              ${this.getSvgIcon('globe')}
              <span id="sw-lang-label">EN</span>
            </button>
            <button type="button" id="sw-btn-close" class="sw-close-btn" aria-label="Close Sleepwalker assistant (Press Escape)">
              ${this.getSvgIcon('close')}
            </button>
          </div>
        </header>

        <!-- 5-Tab Bar -->
        <nav class="sw-tabs" role="tablist" aria-label="Sleepwalker Sections">
          <button type="button" id="sw-tab-btn-talk" class="sw-tab-btn sw-tab-active" role="tab" aria-selected="true" aria-controls="sw-tab-talk" data-tab="talk">
            ${this.getSvgIcon('talk')}
            <span>Talk</span>
          </button>
          <button type="button" id="sw-tab-btn-page" class="sw-tab-btn" role="tab" aria-selected="false" aria-controls="sw-tab-page" data-tab="page" tabindex="-1">
            ${this.getSvgIcon('page')}
            <span>Page</span>
          </button>
          <button type="button" id="sw-tab-btn-forms" class="sw-tab-btn" role="tab" aria-selected="false" aria-controls="sw-tab-forms" data-tab="forms" tabindex="-1">
            ${this.getSvgIcon('forms')}
            <span>Forms</span>
          </button>
          <button type="button" id="sw-tab-btn-files" class="sw-tab-btn" role="tab" aria-selected="false" aria-controls="sw-tab-files" data-tab="files" tabindex="-1">
            ${this.getSvgIcon('files')}
            <span>Files</span>
          </button>
          <button type="button" id="sw-tab-btn-settings" class="sw-tab-btn" role="tab" aria-selected="false" aria-controls="sw-tab-settings" data-tab="settings" tabindex="-1">
            ${this.getSvgIcon('settings')}
            <span>Settings</span>
          </button>
        </nav>

        <!-- Scrollable Body -->
        <main class="sw-body">
          <!-- One-Time Privacy Notice (Dismissible) -->
          <div id="sw-privacy-banner" class="sw-privacy-banner" style="display: none;" role="region" aria-label="Privacy disclosure">
            <strong>${this.getSvgIcon('lock')}<span>Privacy & Data Transparency</span></strong>
            <p>
              • Chrome's Web Speech API transmits audio to Google servers for transcription.<br>
              • Explain mode calls Gemini via your proxy, or local Ollama on your machine.<br>
              • Sleepwalker <em>never</em> captures, reads, or transmits passwords or form inputs.<br>
              • For 100% offline local privacy, enable <strong>Local-Only Mode</strong> in Settings.
            </p>
            <button type="button" id="sw-btn-dismiss-privacy" class="sw-privacy-dismiss-btn" aria-label="Dismiss privacy disclosure">
              ${this.getSvgIcon('check')}
              <span>Got It / Dismiss</span>
            </button>
          </div>

          <!-- Tab Panel: TALK -->
          <div id="sw-tab-talk" class="sw-tab-panel" role="tabpanel" aria-labelledby="sw-tab-btn-talk" data-tab-panel="talk">
            <!-- Voice Microphone Card -->
            <section class="sw-mic-card" aria-label="Voice input control">
              <button type="button" id="sw-btn-mic" class="sw-mic-btn" aria-label="Turn on microphone to speak a command" aria-pressed="false">
                <span id="sw-mic-icon" aria-hidden="true">${this.getSvgIcon('mic')}</span>
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
                Welcome to Sleepwalker. Say <strong>"Read this page"</strong> or tap Read This Page below.
              </p>
            </section>

            <!-- Phase 2 Confirmation & Guided Plan Cards -->
            <section id="sw-panel-confirm-card" class="sw-bubble-card sw-card-confirm" role="alertdialog" aria-label="Action Confirmation" hidden></section>
            <section id="sw-panel-plan-card" class="sw-bubble-card sw-card-stepper" role="region" aria-label="Guided Plan Progress" hidden></section>

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
              <button type="button" id="sw-btn-read" class="sw-btn sw-btn-read" aria-label="Read this entire page aloud">
                ${this.getSvgIcon('volume')}
                <span>Read This Page</span>
              </button>
              <button type="button" id="sw-btn-outline" class="sw-btn sw-btn-outline" aria-label="Extract and list page headings and sections">
                ${this.getSvgIcon('outline')}
                <span>Outline</span>
              </button>
              <button type="button" id="sw-btn-pause" class="sw-btn sw-btn-pause" aria-label="Pause or resume reading">
                ${this.getSvgIcon('pause')}
                <span>Pause</span>
              </button>
              <button type="button" id="sw-btn-stop" class="sw-btn sw-btn-stop sw-stop-hidden" style="display:none !important;" hidden aria-label="Stop reading aloud">
                ${this.getSvgIcon('stop')}
                <span>Stop</span>
              </button>
            </section>

            <!-- Voice Commands Help Accordion -->
            <details class="sw-help-box">
              <summary>${this.getSvgIcon('book')}<span>Voice Commands List</span></summary>
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
          </div>

          <!-- Tab Panel: PAGE -->
          <div id="sw-tab-page" class="sw-tab-panel" role="tabpanel" aria-labelledby="sw-tab-btn-page" data-tab-panel="page" hidden>
            <section id="sw-page-shell-card" class="sw-card" aria-label="Page Digest Overview">
              <h2 class="sw-card-title">${this.getSvgIcon('page')}<span>Page Outline & Digest</span></h2>
              <p class="sw-muted-copy">
                Tap <strong>Outline</strong> in Talk or say <em>"Outline"</em> to list headings here and jump straight to any section.
              </p>
            </section>

            <!-- Outline Panel (Shown when Outline is requested) -->
            <section id="sw-outline-view" class="sw-outline-view" style="display: none;" aria-label="Page sections outline">
              <h2 class="sw-view-title">
                <span>Page Headings</span>
                <span id="sw-outline-count" class="sw-outline-badge">0 sections</span>
              </h2>
              <ul id="sw-outline-list" class="sw-outline-list" role="list"></ul>
            </section>
          </div>

          <!-- Tab Panel: FORMS -->
          <div id="sw-tab-forms" class="sw-tab-panel" role="tabpanel" aria-labelledby="sw-tab-btn-forms" data-tab-panel="forms" hidden>
            <section id="sw-forms-shell-card" class="sw-card" aria-label="Voice Forms Assistant">
              <h2 class="sw-card-title">${this.getSvgIcon('forms')}<span>Forms &amp; Voice Dictation</span></h2>
              <p class="sw-muted-copy" style="margin-bottom:10px;">
                Speak or type into fields cleanly, or walk step-by-step. Sensitive fields (passwords, OTPs, Aadhaar, PAN, cards) are never dictated or stored.
              </p>
              <div class="sw-actions-grid" style="margin-bottom:10px;">
                <button type="button" id="sw-btn-guided-fill" class="sw-btn sw-btn-primary">Guided Fill</button>
                <button type="button" id="sw-btn-profile-fill" class="sw-btn sw-btn-secondary">Fill My Details</button>
                <button type="button" id="sw-btn-form-undo" class="sw-btn sw-btn-outline">Undo Fill</button>
              </div>
              <label class="sw-toggle-row" for="sw-toggle-translit">
                <input type="checkbox" id="sw-toggle-translit" />
                <span>Transliterate Hindi speech to English letters (approximate)</span>
              </label>
            </section>

            <section class="sw-card" aria-label="Opt-in Local Profile">
              <h2 class="sw-card-title">${this.getSvgIcon('forms')}<span>Local Profile (Opt-In, Non-Sensitive)</span></h2>
              <label class="sw-toggle-row" for="sw-toggle-profile" style="margin-bottom:10px;">
                <input type="checkbox" id="sw-toggle-profile" />
                <span>Allow opt-in local profile autofill</span>
              </label>
              <div class="sw-ai-field">
                <label class="sw-ai-label" for="sw-prof-name">Full Name</label>
                <input type="text" id="sw-prof-name" class="sw-ai-input" placeholder="e.g., Vatsal Kumar" />
              </div>
              <div class="sw-ai-field">
                <label class="sw-ai-label" for="sw-prof-email">Email</label>
                <input type="email" id="sw-prof-email" class="sw-ai-input" placeholder="e.g., name@example.com" />
              </div>
              <div class="sw-ai-field">
                <label class="sw-ai-label" for="sw-prof-phone">Phone</label>
                <input type="tel" id="sw-prof-phone" class="sw-ai-input" placeholder="e.g., 9876543210" />
              </div>
              <div class="sw-ai-field">
                <label class="sw-ai-label" for="sw-prof-city">City / Address</label>
                <input type="text" id="sw-prof-city" class="sw-ai-input" placeholder="e.g., New Delhi" />
              </div>
              <div class="sw-ai-field">
                <label class="sw-ai-label" for="sw-prof-pincode">Pincode</label>
                <input type="text" id="sw-prof-pincode" class="sw-ai-input" placeholder="e.g., 110001" />
              </div>
              <div class="sw-ai-actions">
                <button type="button" id="sw-btn-save-profile" class="sw-btn sw-btn-primary">Save Profile</button>
                <button type="button" id="sw-btn-clear-profile" class="sw-btn sw-btn-outline">Clear</button>
              </div>
            </section>
          </div>

          <!-- Tab Panel: FILES -->
          <div id="sw-tab-files" class="sw-tab-panel" role="tabpanel" aria-labelledby="sw-tab-btn-files" data-tab-panel="files" hidden>
            <section id="sw-files-shell-card" class="sw-card" aria-label="File Upload Assistant">
              <h2 class="sw-card-title">${this.getSvgIcon('files')}<span>File Upload Assistant</span></h2>
              <p class="sw-muted-copy" style="margin-bottom:10px;">
                Match file inputs or dropzones by voice, check formats and size limits, and pick files via your own browser tap. File contents and names are never sent to any AI.
              </p>
              <div class="sw-actions-grid" style="margin-bottom:10px;">
                <button type="button" id="sw-btn-scan-files" class="sw-btn sw-btn-primary">Find Upload Fields</button>
                <button type="button" id="sw-btn-camera-photo" class="sw-btn sw-btn-secondary">Camera Photo</button>
                <button type="button" id="sw-btn-undo-upload" class="sw-btn sw-btn-outline">Undo Upload</button>
              </div>
              <div id="sw-files-target-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px;"></div>
              <div id="sw-panel-file-card" class="sw-bubble-card sw-card-file" hidden></div>
              <div id="sw-panel-camera-card" class="sw-bubble-card sw-card-file" hidden></div>
            </section>

            <section class="sw-card" aria-label="Document Shelf">
              <h2 class="sw-card-title">${this.getSvgIcon('files')}<span>Document Shelf (Hands-Free Setup)</span></h2>
              <p class="sw-muted-copy" style="margin-bottom:8px;">
                Route A (Preferred): Connect a folder once on Sleepwalker's extension page so voice upload works across sites without the OS file dialog.
              </p>
              <div class="sw-ai-actions" style="flex-wrap:wrap;gap:8px;">
                <button type="button" id="sw-btn-open-shelf-setup" class="sw-btn sw-btn-primary">Open Shelf Setup</button>
                <button type="button" id="sw-btn-connect-shelf" class="sw-btn sw-btn-secondary">Connect Folder</button>
                <button type="button" id="sw-btn-clear-shelf" class="sw-btn sw-btn-outline">Disconnect</button>
              </div>
              <p id="sw-shelf-status" class="sw-muted-copy" style="margin-top:8px;">No folder connected.</p>
            </section>
          </div>

          <!-- Tab Panel: SETTINGS -->
          <div id="sw-tab-settings" class="sw-tab-panel" role="tabpanel" aria-labelledby="sw-tab-btn-settings" data-tab-panel="settings" hidden>
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

              <!-- Speech & Assistant Language -->
              <div class="sw-ai-field">
                <label for="sw-select-lang" class="sw-settings-label">Speech &amp; Assistant Language:</label>
                <select id="sw-select-lang" class="sw-ai-input" aria-label="Select speech recognition and assistant language">
                  <option value="auto">Auto (Hinglish: HI -&gt; EN retry)</option>
                  <option value="en-IN" selected>English (India) — English</option>
                  <option value="hi-IN">Hindi — हिन्दी</option>
                  <option value="ta-IN">Tamil — தமிழ்</option>
                  <option value="te-IN">Telugu — తెలుగు</option>
                  <option value="bn-IN">Bengali — বাংলা</option>
                  <option value="mr-IN">Marathi — मराठी</option>
                  <option value="gu-IN">Gujarati — ગુજરાતી</option>
                  <option value="kn-IN">Kannada — ಕನ್ನಡ</option>
                  <option value="ml-IN">Malayalam — മലയാളം</option>
                  <option value="pa-IN">Punjabi — ਪੰਜਾਬੀ</option>
                </select>
                <div class="sw-ai-hint">Chrome Web Speech listens in one language per session (Auto defaults to hi-IN and retries en-IN once on low confidence).</div>
              </div>
            </section>

            <!-- AI & Display Configuration -->
            <section class="sw-ai-card" aria-label="AI and Display Settings">
              <h3 class="sw-ai-card-title">${this.getSvgIcon('settings')}<span>AI & Prism Glow Settings</span></h3>

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

              <!-- Barge-In Mode Checkbox -->
              <label class="sw-checkbox-row">
                <input type="checkbox" id="sw-toggle-barge-in">
                <span>Barge-in Mode (Interrupt speech by speaking — use headphones to avoid echo)</span>
              </label>

              <!-- Gemini API Key -->
              <div class="sw-ai-field">
                <label for="sw-input-gemini-key" class="sw-ai-label">Direct Gemini API Key (Google AI Studio):</label>
                <div class="sw-input-with-btn">
                  <input type="password" id="sw-input-gemini-key" class="sw-ai-input" placeholder="Enter Gemini API Key" autocomplete="off" spellcheck="false">
                  <button type="button" id="sw-btn-toggle-gemini-key" class="sw-btn-inline-toggle" aria-label="Show Gemini API key" aria-pressed="false">Show</button>
                </div>
                <div id="sw-env-status-hint" class="sw-ai-hint">Reads defaults from root .env (Gemini + Ollama). Click Show to reveal key.</div>
              </div>

              <!-- Direct Gemini Model -->
              <div class="sw-ai-field">
                <label for="sw-input-gemini-model" class="sw-ai-label">Gemini Model (.env: GEMINI_MODEL):</label>
                <input type="text" id="sw-input-gemini-model" class="sw-ai-input" value="gemini-2.5-flash-lite" autocomplete="off" spellcheck="false">
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
                <button type="button" id="sw-btn-reload-env" class="sw-btn-reload-env" aria-label="Load defaults from .env file">
                  ${this.getSvgIcon('settings')}
                  <span>Load .env</span>
                </button>
                <button type="button" id="sw-btn-test-ai" class="sw-btn-test-conn" aria-label="Test connection to Ollama or Proxy">
                  ${this.getSvgIcon('plug')}
                  <span>Test Connection</span>
                </button>
                <button type="button" id="sw-btn-save-ai" class="sw-btn-save-ai" aria-label="Save AI settings">
                  ${this.getSvgIcon('check')}
                  <span>Save Settings</span>
                </button>
              </div>
            </section>

            <!-- Diagnostics Section -->
            <section class="sw-diag-section" aria-label="Extension diagnostics">
              <button type="button" id="sw-btn-diag" class="sw-btn-diag" aria-label="Open Diagnostics details">
                ${this.getSvgIcon('wrench')}
                <span>Diagnostics & Audio Check</span>
              </button>
              <div id="sw-diag-view" class="sw-diag-box" style="display: none;" aria-live="polite">
                <div class="sw-diag-header">
                  <strong>System Health & Diagnostics</strong>
                  <button type="button" id="sw-btn-test-speech" class="sw-outline-read-btn">
                    ${this.getSvgIcon('volume')}
                    <span>Test Voice</span>
                  </button>
                </div>
                <div id="sw-diag-content">Loading diagnostics...</div>
              </div>
            </section>
          </div>
        </main>
      `;
    }

    /**
     * Instantiate reader, outline, voice, confirm, and intent engine modules.
     */
    initModules() {
      this.reader = new window.SleepwalkerReader();
      this.outline = new window.SleepwalkerOutline();
      this.voice = new window.SleepwalkerVoice();

      if (window.SleepwalkerConfirm) {
        this.confirm = new window.SleepwalkerConfirm({
          onChange: (state) => this.handleConfirmStateChange(state)
        });
      }

      if (window.SleepwalkerIntentEngine) {
        this.intentEngine = new window.SleepwalkerIntentEngine();
      }

      // Feature B: Explain This Page engine
      if (window.SleepwalkerExplainer) {
        this.explainer = new window.SleepwalkerExplainer(this);
      }

      if (window.SleepwalkerNavigator) {
        this.navigator = new window.SleepwalkerNavigator(this);
      }

      if (window.SleepwalkerForms) {
        this.forms = new window.SleepwalkerForms(this);
      }

      if (window.SleepwalkerUpload) {
        this.upload = new window.SleepwalkerUpload(this, {
          onCardChange: (cardState) => this.handleUploadCardChange(cardState)
        });
      }

      if (window.SleepwalkerCamera) {
        this.camera = new window.SleepwalkerCamera(this, {
          onCardChange: (cardState) => this.handleCameraCardChange(cardState)
        });
      }

      if (window.SleepwalkerDialogue) {
        this.dialogue = new window.SleepwalkerDialogue(this, {
          bargeIn: this.bargeIn
        });
      }

      this.reader.setLang(this.getEffectiveSpeechLang(this.lang));
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

        // Live streaming transcript inside the floating pill bubble & P1 SW_UI chip
        if (this.pill && this.pill.state === 'listening') {
          this.pill.setStatus(`"${text}"`);
        }
        if (window.SW_UI && (!this.dialogue || this.dialogue.isActive() || window.SW_UI.getState() === 'listening')) {
          window.SW_UI.setTranscript(text || '');
        }
      };

      // 2. Voice command recognized -> route through Phase 2 handleUserInput
      this.voice.onCommand = (cmd, meta = {}) => {
        const rawText = cmd && cmd.raw ? cmd.raw : '';
        if (!rawText) return;
        this.handleUserInput(rawText, 'voice', {
          asrConfidence: typeof meta.confidence === 'number'
            ? meta.confidence
            : (cmd && typeof cmd.confidence === 'number' ? cmd.confidence : null),
          activeLang: meta.activeLang || (cmd && cmd.activeLang) || (this.voice && this.voice.activeLang),
          mode: meta.mode || (cmd && cmd.mode) || (this.voice && this.voice.mode),
          legacyParsed: cmd
        });
      };

      // 2b. Voice live activity & pause sync (half-duplex + silence timers)
      this.voice.onActivity = () => {
        if (this.dialogue) {
          this.dialogue.noteSpeechActivity({ fromVoice: true });
        }
      };

      this.voice.onPauseChange = () => {
        if (this.dialogue) {
          this.dialogue._syncSessionIndicators();
        }
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
        if (window.SW_UI) {
          window.SW_UI.setState('error');
          window.SW_UI.setTranscript(message);
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
            if (this.lang === 'hi-IN') {
              micStatus.textContent = 'सुन रहा हूँ... बोलिए';
            } else if (this.lang === 'auto') {
              const active = this.voice ? this.voice.activeLang : 'hi-IN';
              micStatus.textContent = `Listening (Auto: ${active})... Speak now`;
            } else {
              micStatus.textContent = 'Listening... Speak now';
            }
            this.updateStatusPill('listening', 'Listening');
          } else {
            micBtn.classList.remove('sw-listening');
            micBtn.setAttribute('aria-pressed', 'false');
            if (this.lang === 'hi-IN') {
              micStatus.textContent = 'माइक दबाकर बोलें';
            } else if (this.lang === 'auto') {
              micStatus.textContent = 'Tap Mic to Speak (Auto)';
            } else {
              micStatus.textContent = 'Tap Mic to Speak';
            }
            if (!this.reader.isPlaying) {
              this.updateStatusPill('idle', 'Idle');
            }
          }
        }

        if (isListening) {
          if (window.SW_UI && (!this.dialogue || !this.dialogue.isPausedForSpeech())) {
            window.SW_UI.setState('listening');
          }
          if (!window.SW_UI && this.pill && this.pill.state !== 'listening' && (!this.dialogue || !this.dialogue.isPausedForSpeech())) {
            this.pill.setListening('Listening... Speak now');
          }
          if (!window.SW_UI && this.glow && (!this.dialogue || !this.dialogue.isPausedForSpeech())) {
            this.glow.setListening();
          }
        } else {
          if (window.SW_UI && this.dialogue && this.dialogue.isActive() && !this.dialogue.isPausedForSpeech() && window.SW_UI.getState() === 'listening') {
            window.SW_UI.setState('silent');
          }
          if (!window.SW_UI && this.pill && this.pill.state === 'listening' && (!this.dialogue || !this.dialogue.isActive())) {
            this.pill.setIdle('Ready • Type or speak a command');
          }
          if (!window.SW_UI && this.glow && this.glow.state === 'listening') {
            this.glow.setOff();
          }
        }
        if (this.dialogue) {
          this.dialogue._syncSessionIndicators();
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
            if (pauseBtn) {
              pauseBtn.innerHTML = `${this.getSvgIcon('play')}<span>Resume</span>`;
            }
            if (this.pill) {
              this.pill.setStatus('Reading paused. Press Resume or Stop.');
            }
          } else {
            this.updateStatusPill('reading', 'Reading');
            if (pauseBtn) {
              pauseBtn.innerHTML = `${this.getSvgIcon('pause')}<span>Pause</span>`;
            }
            if (this.pill) {
              this.pill.setSpeaking();
            }
          }
        } else {
          if (!this.voice.isListening) {
            this.updateStatusPill('idle', 'Idle');
          }
          if (pauseBtn) {
            pauseBtn.innerHTML = `${this.getSvgIcon('pause')}<span>Pause</span>`;
          }
          if (this.pill && this.pill.state === 'speaking' && (!this.dialogue || !this.dialogue.isActive())) {
            this.pill.setIdle('Stopped.');
          }
        }
        if (this.dialogue) {
          this.dialogue.onSpeechStatusChange({ isPlaying, isPaused });
        }
        this.syncStopButton();
      };

      // 7. Reader error handling
      this.reader.onError = (errMsg) => {
        this._isExplaining = false;
        this.setAssistantReply(`⚠️ ${errMsg}`);
        this.updateStatusPill('idle', 'Speech Error');
        this.recordError(`Reader: ${errMsg}`);
        if (this.pill) {
          this.pill.setError(errMsg);
        }
        if (this.dialogue) {
          this.dialogue.onSpeechStatusChange({ isPlaying: false, isPaused: false });
        }
        this.syncStopButton();
      };

      // 8. Reader finished
      this.reader.onFinished = (finishedMode) => {
        this._isExplaining = false;
        if (this.dialogue) {
          this.dialogue.onSpeechStatusChange({ isPlaying: false, isPaused: false });
        }
        if (finishedMode !== 'text') {
          this.setAssistantReply('Finished reading the page.');
          this.updateStatusPill('idle', 'Done');
          if (this.pill && (!this.dialogue || !this.dialogue.isActive())) {
            this.pill.setIdle('Finished reading the page.');
          }
        } else if (!this.dialogue || !this.dialogue.isActive()) {
          this.updateStatusPill('idle', 'Done');
        }
        if (this.glow && (!this.dialogue || !this.dialogue.isActive())) {
          this.glow.setOff();
        }
        this.syncStopButton();
      };
    }

    /**
     * Bind UI button clicks, keyboard shortcuts, and form submissions.
     */
    bindUiEvents() {
      const root = this.shadowRoot;

      const tabs = Array.from(root.querySelectorAll('.sw-tab-btn'));
      tabs.forEach((btn, idx) => {
        btn.addEventListener('click', () => {
          this.switchTab(btn.dataset.tab);
        });
        btn.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            let nextIdx = idx;
            if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') nextIdx = 0;
            else if (e.key === 'End') nextIdx = tabs.length - 1;
            const targetTab = tabs[nextIdx];
            if (targetTab) this.switchTab(targetTab.dataset.tab, true);
          }
        });
      });

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
        if (this.dialogue) {
          this.dialogue.toggleSession({ source: 'panel_mic' });
        } else {
          this.voice.toggleListening();
        }
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

      // Typed Input Form -> route through Phase 2 handleUserInput
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

        this.handleUserInput(text, 'typed');
      });

      // Settings language selector
      const selectLang = root.getElementById('sw-select-lang');
      if (selectLang) {
        selectLang.value = this.lang;
        selectLang.addEventListener('change', (e) => {
          this.setLanguage(e.target.value);
        });
      }

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
          const v = this.reader ? this.reader.getBestVoice(this.getEffectiveSpeechLang(this.lang)) : null;
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

      // AI Settings Show/Hide key, Load .env, Test & Save
      const btnToggleGeminiKey = root.getElementById('sw-btn-toggle-gemini-key');
      if (btnToggleGeminiKey) {
        btnToggleGeminiKey.addEventListener('click', () => {
          const geminiInput = root.getElementById('sw-input-gemini-key');
          if (!geminiInput) return;
          const reveal = geminiInput.type === 'password';
          geminiInput.type = reveal ? 'text' : 'password';
          btnToggleGeminiKey.textContent = reveal ? 'Hide' : 'Show';
          btnToggleGeminiKey.setAttribute('aria-pressed', reveal ? 'true' : 'false');
          btnToggleGeminiKey.setAttribute('aria-label', reveal ? 'Hide Gemini API key' : 'Show Gemini API key');
        });
      }

      const btnReloadEnv = root.getElementById('sw-btn-reload-env');
      if (btnReloadEnv) {
        btnReloadEnv.addEventListener('click', () => this.reloadEnvSettings());
      }

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

      // Barge-In Mode toggle immediate effect
      const bargeInToggle = root.getElementById('sw-toggle-barge-in');
      if (bargeInToggle) {
        bargeInToggle.addEventListener('change', (e) => {
          this.setBargeIn(e.target.checked);
        });
      }

      // Global keyboard accessibility inside the widget
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (this.camera && this.camera.isActive()) {
            this.camera.cancelCapture();
          }
          if (this.confirm && this.confirm.isAwaiting()) {
            this.confirm.cancel('user_escape');
          } else if (this.reader && this.reader.isPlaying && this.dialogue) {
            this.dialogue.interruptSpeech({ source: 'escape', resumeSession: this.dialogue.isActive() });
          } else if (this.forms && this.forms.isGuidedActive()) {
            this.forms.stopGuidedFill('cancelled');
          } else if (this.confirm && this.confirm.isPlanActive()) {
            this.confirm.cancelPlan('user_escape');
          } else if (this.reader.isPlaying) {
            this.stopReading();
          } else {
            if (this.dialogue && this.dialogue.isActive()) {
              this.dialogue.endSession({ reason: 'escape', quiet: true, force: true });
            }
            this.close();
          }
        }
      });
    }

    /**
     * Load saved opt-in local profile & bind Forms panel buttons cleanly.
     */
    async initFormsPanel() {
      if (!this.forms || !this.shadowRoot) return;
      const root = this.shadowRoot;

      const loaded = await this.forms.loadProfile();
      const optToggle = root.getElementById('sw-toggle-profile');
      const translitToggle = root.getElementById('sw-toggle-translit');
      const inpName = root.getElementById('sw-prof-name');
      const inpEmail = root.getElementById('sw-prof-email');
      const inpPhone = root.getElementById('sw-prof-phone');
      const inpCity = root.getElementById('sw-prof-city');
      const inpPin = root.getElementById('sw-prof-pincode');

      if (optToggle) optToggle.checked = Boolean(loaded.optIn);
      if (inpName) inpName.value = loaded.profile.fullName || '';
      if (inpEmail) inpEmail.value = loaded.profile.email || '';
      if (inpPhone) inpPhone.value = loaded.profile.phone || '';
      if (inpCity) inpCity.value = loaded.profile.city || '';
      if (inpPin) inpPin.value = loaded.profile.pincode || '';

      const guidedBtn = root.getElementById('sw-btn-guided-fill');
      if (guidedBtn) guidedBtn.addEventListener('click', () => this.forms.startGuidedFill());

      const profileBtn = root.getElementById('sw-btn-profile-fill');
      if (profileBtn) profileBtn.addEventListener('click', () => this.forms.fillFromProfile());

      const undoBtn = root.getElementById('sw-btn-form-undo');
      if (undoBtn) undoBtn.addEventListener('click', () => this.forms.undoLast());

      if (translitToggle) {
        translitToggle.addEventListener('change', (e) => {
          this.forms.transliterateHindiToEnglish = Boolean(e.target.checked);
        });
      }

      const saveBtn = root.getElementById('sw-btn-save-profile');
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          await this.forms.saveProfile({
            optIn: optToggle ? optToggle.checked : true,
            profile: {
              fullName: inpName ? inpName.value : '',
              email: inpEmail ? inpEmail.value : '',
              phone: inpPhone ? inpPhone.value : '',
              city: inpCity ? inpCity.value : '',
              pincode: inpPin ? inpPin.value : ''
            }
          });
          this.setAssistantReply('Local non-sensitive profile saved. Say "Fill my details" when ready.');
        });
      }

      const clearBtn = root.getElementById('sw-btn-clear-profile');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          if (optToggle) optToggle.checked = false;
          [inpName, inpEmail, inpPhone, inpCity, inpPin].forEach((i) => { if (i) i.value = ''; });
          await this.forms.saveProfile({ optIn: false, profile: {} });
          this.setAssistantReply('Local profile cleared.');
        });
      }
    }

    /**
     * Bind Files tab buttons & Experimental Document Shelf controls cleanly.
     */
    initFilesPanel() {
      if (!this.upload || !this.shadowRoot) return;
      const root = this.shadowRoot;

      const scanBtn = root.getElementById('sw-btn-scan-files');
      const listEl = root.getElementById('sw-files-target-list');
      const undoUploadBtn = root.getElementById('sw-btn-undo-upload');
      const openShelfSetupBtn = root.getElementById('sw-btn-open-shelf-setup');
      const connectBtn = root.getElementById('sw-btn-connect-shelf');
      const clearShelfBtn = root.getElementById('sw-btn-clear-shelf');
      const shelfStatus = root.getElementById('sw-shelf-status');

      if (openShelfSetupBtn) {
        openShelfSetupBtn.addEventListener('click', () => {
          this.upload.openShelfSetup();
        });
      }

      if (shelfStatus && typeof this.upload.getExtensionShelfStatus === 'function') {
        this.upload.getExtensionShelfStatus().then((st) => {
          if (!shelfStatus) return;
          if (st.status === 'ok' && st.connected) {
            shelfStatus.textContent = `Extension Shelf connected: "${st.folderName}" (${st.count} files ready across tabs).`;
          } else if (st.status === 'needs_reauth') {
            shelfStatus.textContent = `Extension Shelf ("${st.folderName}") needs permission re-tap in Open Shelf Setup.`;
          }
        });
      }

      if (scanBtn && listEl) {
        scanBtn.addEventListener('click', () => {
          const targets = this.upload.detectUploadTargets();
          listEl.textContent = '';
          if (targets.length === 0) {
            listEl.innerHTML = '<p class="sw-muted-copy">No file inputs or dropzones found on this page.</p>';
            return;
          }
          targets.forEach((t) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sw-btn sw-btn-secondary';
            btn.textContent = `Upload: ${t.label}${t.accept ? ` (${t.accept})` : ''}`;
            btn.addEventListener('click', () => this.upload._openChooseFileCard(t));
            listEl.appendChild(btn);
          });
        });
      }

      if (undoUploadBtn) {
        undoUploadBtn.addEventListener('click', () => this.upload.undoLastUpload());
      }

      const cameraPhotoBtn = root.getElementById('sw-btn-camera-photo');
      if (cameraPhotoBtn && this.camera) {
        cameraPhotoBtn.addEventListener('click', () => {
          this.camera.requestCapture('photo');
        });
      }

      if (shelfStatus && !this.upload.isShelfSupported()) {
        shelfStatus.textContent = 'Experimental Document Shelf is unavailable in this context; use Choose File above.';
      }

      if (connectBtn && shelfStatus) {
        connectBtn.addEventListener('click', async () => {
          const res = await this.upload.connectShelfFolder();
          shelfStatus.textContent = res.ok
            ? `Connected "${res.folderName}" (${res.count} files indexed in memory only).`
            : res.message;
        });
      }

      if (clearShelfBtn && shelfStatus) {
        clearShelfBtn.addEventListener('click', () => {
          this.upload.disconnectShelfFolder();
          shelfStatus.textContent = 'No folder connected.';
        });
      }
    }

    /**
     * Render interactive File Upload Card into both Pill Bubble and Panel Files tab.
     */
    handleUploadCardChange(cardState) {
      if (!this.upload) return;
      if (cardState && cardState.stage === 'attached') {
        this.lastUndoableType = 'upload';
      }

      const handlers = {
        onSelectFile: (file, target) => this.upload.handleSelectedFile(file, target),
        onCompress: async (file, target) => {
          const compressed = await this.upload.compressImageToTargetLimit(file, target.maxBytes);
          if (compressed) {
            this.upload.handleSelectedFile(compressed, target);
          } else {
            this.setAssistantReply('Could not compress that photo cleanly. Please choose a smaller image.');
          }
        },
        onUseShelf: (entry, target) => {
          if (entry && entry.fileHandle) {
            return this.upload.pickFromShelfEntry(entry, target);
          }
          return this.upload.pickFromExtensionShelf(entry, target);
        },
        onOpenShelfSetup: () => this.upload.openShelfSetup(),
        onUseCamera: (target) => {
          if (this.camera) {
            this.upload.clearFileCard();
            this.camera.requestCapture(target ? target.label : 'photo', target);
          }
        },
        onCancel: () => {
          this.upload.clearFileCard();
          this.setAssistantReply('File upload cancelled.');
        },
        onUndo: () => this.upload.undoLastUpload()
      };

      if (this.pill && typeof this.pill.renderFileCard === 'function') {
        this.pill.renderFileCard(cardState, handlers);
      }
      if (this.shadowRoot && this.pill && typeof this.pill.renderFileCardInto === 'function') {
        const panelFileCard = this.shadowRoot.getElementById('sw-panel-file-card');
        if (panelFileCard) {
          this.pill.renderFileCardInto(panelFileCard, cardState, handlers, false);
        }
      }
      if (this.isOpen && cardState && cardState.stage && cardState.stage !== 'idle') {
        this.switchTab('files');
      }
    }

    /**
     * Render interactive Camera Capture Card into both Pill Bubble and Panel Files tab.
     */
    handleCameraCardChange(cardState) {
      if (!this.camera) return;
      const handlers = {
        onCountdownCapture: () => this.camera.captureWithCountdown(3),
        onAttach: () => this.camera.confirmAttach(),
        onRetake: () => this.camera.retake(),
        onRetry: () => this.camera.cardState && this.camera.cardState.target && this.camera.startCamera(this.camera.cardState.target),
        onFallbackFile: () => {
          const target = this.camera.cardState && this.camera.cardState.target;
          this.camera.cancelCapture();
          if (this.upload && target) this.upload._openChooseFileCard(target);
        },
        onCancel: () => this.camera.cancelCapture()
      };

      if (this.pill && typeof this.pill.renderCameraCard === 'function') {
        this.pill.renderCameraCard(cardState, handlers);
      }
      if (this.shadowRoot && this.pill && typeof this.pill.renderCameraCardInto === 'function') {
        const panelCamCard = this.shadowRoot.getElementById('sw-panel-camera-card');
        if (panelCamCard) {
          this.pill.renderCameraCardInto(panelCamCard, cardState, handlers, false);
        }
      }
      if (this.isOpen && cardState && cardState.stage && cardState.stage !== 'idle') {
        this.switchTab('files');
      }
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
      const activeSpeechLang = this.getEffectiveSpeechLang(this.lang);
      const speechPrefix = activeSpeechLang.split('-')[0].toLowerCase();
      const hasSelectedLangVoice = voices.some(v => (v.lang || '').toLowerCase() === activeSpeechLang.toLowerCase() || (v.lang || '').toLowerCase().startsWith(speechPrefix));

      const report = {
        extensionVersion: '1.0.0',
        pageUrl: window.location.href,
        isRestrictedPage: isRestricted,
        isFileUrl: window.location.protocol === 'file:',
        selectedLanguage: this.lang,
        selectedLanguageName: this.getLanguageInfo(this.lang).name,
        voiceMode: this.voice ? this.voice.mode : this.lang,
        voiceActiveLang: this.voice ? this.voice.activeLang : activeSpeechLang,
        autoRetryUsed: Boolean(this.voice && this.voice._autoRetriedEn),
        speechSynthesisSupported: 'speechSynthesis' in window,
        totalVoicesFound: voices.length,
        enInVoiceAvailable: hasEnIn,
        hiInVoiceAvailable: hasHiIn,
        selectedLangVoiceAvailable: hasSelectedLangVoice,
        speechRecognitionSupported: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
        microphonePermission: micState,
        llm: await this._fetchLlmDiagnostics(),
        intentStats: (this.intentEngine && this.intentEngine.stats) ? { ...this.intentEngine.stats } : null,
        lastDigestStats: (this.explainer && this.explainer.lastDigest && this.explainer.lastDigest.stats)
          ? { ...this.explainer.lastDigest.stats }
          : null,
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
        'Microphone Permission': report.microphonePermission,
        'LLM Calls Total': report.llm ? report.llm.callsTotal : 0,
        'Approx Tokens (In/Out)': report.llm ? `${report.llm.approxInputTokens}/${report.llm.approxOutputTokens}` : '0/0'
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
     * Fetch LLM call count and approximate token stats from background service worker.
     */
    _fetchLlmDiagnostics() {
      return new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_GET_LLM_DIAGNOSTICS' }, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve(null);
          } else {
            resolve(res.diagnostics || null);
          }
        });
      });
    }

    /**
     * Update Page tab overview card with current privacy-safe Digest stats.
     */
    renderDigestOverview(digest) {
      const card = this.shadowRoot && this.shadowRoot.getElementById('sw-page-shell-card');
      if (!card || !digest) return;
      const stats = digest.stats || {};
      const safeTitle = String(digest.title || 'Page').replace(/[<>&"]/g, '');
      card.innerHTML = `
        <h2 class="sw-card-title">${this.getSvgIcon('page')}<span>Page Outline &amp; Digest</span></h2>
        <p class="sw-muted-copy" style="margin-bottom:6px;">
          <strong>${safeTitle}</strong>
        </p>
        <p class="sw-muted-copy">
          Headings: <strong>${stats.headingCount || 0}</strong> &bull;
          Interactive items: <strong>${stats.elementCount || 0}</strong> &bull;
          Chunks: <strong>${stats.chunkCount || 0}</strong> &bull;
          ~<strong>${stats.totalTextTokens || 0}</strong> page tokens (digest capped &le;1500 cloud / &le;800 local).
        </p>
      `;
    }

    /**
     * Render diagnostics data into the widget panel.
     */
    async renderDiagnostics() {
      const container = this.shadowRoot.getElementById('sw-diag-content');
      if (!container) return;

      const d = await this.runDiagnostics();

      const okBadge = (val) => val ? '<span style="color:var(--sw-success);font-weight:800;">OK</span>' : '<span style="color:var(--sw-danger);font-weight:800;">NO</span>';
      const micBadge = (state) => {
        if (state === 'granted') return '<span style="color:var(--sw-success);font-weight:800;">Granted</span>';
        if (state === 'denied') return '<span style="color:var(--sw-danger);font-weight:800;">Blocked / Denied</span>';
        return `<span style="color:var(--sw-warning);font-weight:800;">${state}</span>`;
      };

      const llm = d.llm || {
        callsTotal: 0, intentCalls: 0, explainCalls: 0, qaCalls: 0,
        cacheHits: 0, approxInputTokens: 0, approxOutputTokens: 0,
        geminiRpmUsed: 0, geminiRpmLimit: 12, rateLimitEvents: 0, lastDegradeReason: '', lastSource: 'none'
      };
      const intentStats = d.intentStats || { total: 0, ruleHits: 0, llmHits: 0 };
      const localPct = intentStats.total > 0 ? Math.round((intentStats.ruleHits / intentStats.total) * 100) : 100;

      let errorsHtml = '<p style="color:var(--sw-text-muted);margin:4px 0;">No errors recorded.</p>';
      if (d.last10Errors.length > 0) {
        errorsHtml = '<ul style="margin:4px 0;padding-left:18px;color:var(--sw-danger);font-size:18px;">' +
          d.last10Errors.map(e => `<li><strong>${e.time}:</strong> ${e.message}</li>`).join('') +
          '</ul>';
      }

      const digestRow = d.lastDigestStats
        ? `<div><strong>Last Digest:</strong> ${d.lastDigestStats.headingCount || 0} headings, ${d.lastDigestStats.elementCount || 0} items, ${d.lastDigestStats.chunkCount || 0} chunks (~${d.lastDigestStats.totalTextTokens || 0} page tokens)</div>`
        : '';

      const autoBadge = d.selectedLanguage === 'auto'
        ? (d.autoRetryUsed ? ' • EN retry active' : ' • HI → EN retry ready')
        : '';

      container.innerHTML = `
        <div style="font-size:18px;line-height:1.55;">
          <div><strong>Version:</strong> v${d.extensionVersion} | <strong>Protocol:</strong> ${d.isFileUrl ? '<span style="color:var(--sw-warning);">file:// (Needs "Allow file URLs")</span>' : 'Web (http/https)'}</div>
          <div><strong>Language Mode:</strong> ${d.selectedLanguageName} (${d.voiceActiveLang}${autoBadge})</div>
          <div><strong>Speech Synthesis:</strong> ${okBadge(d.speechSynthesisSupported)} (${d.totalVoicesFound} voices)</div>
          <div><strong>EN Voice:</strong> ${okBadge(d.enInVoiceAvailable)} | <strong>HI Voice:</strong> ${okBadge(d.hiInVoiceAvailable)} | <strong>Selected TTS:</strong> ${okBadge(d.selectedLangVoiceAvailable)}</div>
          <div><strong>Speech Recognition:</strong> ${okBadge(d.speechRecognitionSupported)} | <strong>Mic:</strong> ${micBadge(d.microphonePermission)}</div>
          ${digestRow}
          <div style="margin-top:6px;border-top:1px solid var(--sw-border);padding-top:6px;">
            <strong>LLM &amp; Token Budget:</strong>
            Calls: <strong>${llm.callsTotal}</strong> (Intent ${llm.intentCalls}, Explain ${llm.explainCalls}, Q&amp;A ${llm.qaCalls}) |
            Cache hits: <strong>${llm.cacheHits}</strong> |
            Approx tokens: <strong>${llm.approxInputTokens}</strong> in / <strong>${llm.approxOutputTokens}</strong> out |
            Gemini RPM: <strong>${llm.geminiRpmUsed}/${llm.geminiRpmLimit}</strong> |
            Zero-LLM commands: <strong>${localPct}%</strong> (${intentStats.ruleHits}/${intentStats.total})
            ${llm.lastDegradeReason ? `<div style="color:var(--sw-warning);"><strong>Notice:</strong> ${llm.lastDegradeReason}</div>` : ''}
          </div>
          <div style="margin-top:6px;border-top:1px solid var(--sw-border);padding-top:6px;">
            <strong>Recent Errors (${d.last10Errors.length}):</strong>
            ${errorsHtml}
          </div>
        </div>
      `;
    }

    /**
     * Look up language metadata from supported Indian languages table.
     */
    getLanguageInfo(langCode) {
      if (!langCode || typeof langCode !== 'string') return SUPPORTED_LANGUAGES['en-IN'];
      const trimmed = langCode.trim();
      if (SUPPORTED_LANGUAGES[trimmed]) return SUPPORTED_LANGUAGES[trimmed];
      const matchKey = Object.keys(SUPPORTED_LANGUAGES).find(
        (k) => k.toLowerCase() === trimmed.toLowerCase()
      );
      return matchKey ? SUPPORTED_LANGUAGES[matchKey] : SUPPORTED_LANGUAGES['en-IN'];
    }

    /**
     * Resolve concrete BCP-47 speech tag (Auto maps to hi-IN by default).
     */
    getEffectiveSpeechLang(langCode = this.lang) {
      return this.getLanguageInfo(langCode).speechLang;
    }

    /**
     * Resolve concrete reply language (explicit modifier, detected regional script, selected mode, or active ASR lang).
     */
    resolveReplyLang(classified = null) {
      const REGIONAL_SCRIPTS = new Set(['ta-IN', 'te-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN']);
      const argLang = classified && classified.args && classified.args.lang;
      if (argLang && argLang !== 'auto') return this.getLanguageInfo(argLang).code;
      const detLang = classified && classified.lang;
      if (detLang && REGIONAL_SCRIPTS.has(detLang)) return this.getLanguageInfo(detLang).code;
      if (this.lang && this.lang !== 'auto') return this.getLanguageInfo(this.lang).code;
      if (detLang && detLang !== 'auto') return this.getLanguageInfo(detLang).code;
      return (this.voice && this.voice.activeLang) || 'en-IN';
    }

    /**
     * Sync confirmation and guided-plan state changes to Pill and Side Panel cards.
     */
    handleConfirmStateChange({ pending, plan } = {}) {
      const onConfirm = (choiceIndex) => {
        if (!this.confirm) return;
        const res = this.confirm.confirm(choiceIndex);
        if (res && res.status === 'awaiting_second_confirm') {
          const stepMsg = 'Step 2 of 2: Say "Yes" / "Haan" again or click Yes to finalize.';
          this.setAssistantReply(stepMsg);
          if (this.pill) this.pill.setStatus(stepMsg);
        }
      };
      const onCancel = (reason) => {
        if (this.confirm) this.confirm.cancel(reason);
      };
      const onCancelPlan = (reason) => {
        if (this.confirm) this.confirm.cancelPlan(reason);
      };

      if (this.pill) {
        if (typeof this.pill.renderConfirmCard === 'function') {
          this.pill.renderConfirmCard(pending, onConfirm, onCancel);
        }
        if (typeof this.pill.renderPlanCard === 'function') {
          this.pill.renderPlanCard(plan, onCancelPlan);
        }
      }

      if (this.shadowRoot) {
        const panelConfirm = this.shadowRoot.getElementById('sw-panel-confirm-card');
        if (panelConfirm) {
          this._renderSafeConfirmCard(panelConfirm, pending, onConfirm, onCancel);
        }
        const panelPlan = this.shadowRoot.getElementById('sw-panel-plan-card');
        if (panelPlan) {
          this._renderSafePlanCard(panelPlan, plan, onCancelPlan);
        }
      }
    }

    /**
     * Render confirmation UI inside a shadow container using DOM APIs only.
     */
    _renderSafeConfirmCard(card, pending, onConfirm, onCancel) {
      card.textContent = '';
      if (!pending) {
        card.hidden = true;
        return;
      }

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px;';

      const titleEl = document.createElement('strong');
      titleEl.textContent = pending.title || 'Confirm action';
      titleEl.style.cssText = 'font-size:18px;font-weight:800;color:var(--sw-text);';
      header.appendChild(titleEl);

      const isCritical = pending.risk === 'critical';
      const isDouble = pending.requiredSteps > 1;
      const badge = document.createElement('span');
      badge.textContent = isDouble
        ? (pending.step >= 2 ? 'CRITICAL • STEP 2 OF 2' : 'CRITICAL • STEP 1 OF 2')
        : (pending.risk === 'high' ? 'HIGH RISK' : 'CONFIRM');
      badge.style.cssText = isCritical
        ? 'background:var(--sw-danger-solid);color:#FFFFFF;border-radius:6px;padding:3px 8px;font-size:18px;font-weight:800;'
        : 'background:var(--sw-accent);color:var(--sw-accent-fg);border:1px solid var(--sw-accent-border);border-radius:6px;padding:3px 8px;font-size:18px;font-weight:800;';
      header.appendChild(badge);
      card.appendChild(header);

      if (pending.message) {
        const msg = document.createElement('p');
        msg.textContent = String(pending.message);
        msg.style.cssText = 'margin:4px 0 8px 0;font-size:18px;line-height:1.45;color:var(--sw-text);';
        card.appendChild(msg);
      }

      if (Array.isArray(pending.summary) && pending.summary.length > 0) {
        const ul = document.createElement('ul');
        ul.style.cssText = 'margin:4px 0 10px 0;padding-left:20px;font-size:18px;line-height:1.45;color:var(--sw-text);';
        pending.summary.forEach((line) => {
          const li = document.createElement('li');
          li.textContent = String(line);
          ul.appendChild(li);
        });
        card.appendChild(ul);
      }

      if (Array.isArray(pending.options) && pending.options.length > 0) {
        const optsWrap = document.createElement('div');
        optsWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:8px 0;';
        pending.options.slice(0, 5).forEach((opt, idx) => {
          const label = typeof opt === 'string' ? opt : (opt && opt.label ? opt.label : `Option ${idx + 1}`);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = `${idx + 1}. ${label}`;
          btn.style.cssText = 'min-height:48px;min-width:48px;width:100%;text-align:left;padding:10px 12px;font-size:18px;font-weight:700;border-radius:10px;cursor:pointer;background:var(--sw-surface-2);color:var(--sw-text);border:2px solid var(--sw-info);';
          btn.addEventListener('click', () => onConfirm(idx));
          optsWrap.appendChild(btn);
        });
        card.appendChild(optsWrap);
      }

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
      if (!Array.isArray(pending.options) || pending.options.length === 0) {
        const yesBtn = document.createElement('button');
        yesBtn.type = 'button';
        yesBtn.textContent = isDouble && pending.step === 1
          ? 'Yes, Continue (1/2)'
          : (isDouble ? 'Yes, Confirm Final (2/2)' : 'Yes, Confirm');
        yesBtn.style.cssText = isCritical
          ? 'flex:1;min-height:48px;min-width:48px;padding:10px 12px;font-size:18px;font-weight:800;border-radius:10px;cursor:pointer;background:var(--sw-danger-solid);color:#FFFFFF;border:2px solid var(--sw-danger);'
          : 'flex:1;min-height:48px;min-width:48px;padding:10px 12px;font-size:18px;font-weight:800;border-radius:10px;cursor:pointer;background:var(--sw-accent);color:var(--sw-accent-fg);border:2px solid var(--sw-accent-border);';
        yesBtn.addEventListener('click', () => onConfirm());
        btnRow.appendChild(yesBtn);
      }

      const noBtn = document.createElement('button');
      noBtn.type = 'button';
      noBtn.textContent = 'No, Cancel';
      noBtn.style.cssText = 'flex:1;min-height:48px;min-width:48px;padding:10px 12px;font-size:18px;font-weight:800;border-radius:10px;cursor:pointer;background:var(--sw-surface-2);color:var(--sw-text);border:2px solid var(--sw-border-strong);';
      noBtn.addEventListener('click', () => onCancel('user_denied'));
      btnRow.appendChild(noBtn);

      card.appendChild(btnRow);
      card.hidden = false;
    }

    /**
     * Render multi-step guided plan UI inside a shadow container using DOM APIs only.
     */
    _renderSafePlanCard(card, plan, onCancel) {
      card.textContent = '';
      if (!plan || plan.status === 'cancelled') {
        card.hidden = true;
        return;
      }

      const steps = Array.isArray(plan.steps) ? plan.steps.slice(0, 5) : [];
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;';

      const titleEl = document.createElement('strong');
      titleEl.textContent = plan.title || 'Guided Plan';
      titleEl.style.cssText = 'font-size:18px;font-weight:800;color:var(--sw-info-text);';
      header.appendChild(titleEl);

      const badge = document.createElement('span');
      badge.textContent = plan.status === 'done'
        ? 'Done'
        : `Step ${Math.min((plan.currentIndex || 0) + 1, Math.max(1, steps.length))}/${steps.length}`;
      badge.style.cssText = 'background:var(--sw-info);color:var(--sw-info-fg);border-radius:6px;padding:3px 8px;font-size:18px;font-weight:800;';
      header.appendChild(badge);
      card.appendChild(header);

      if (steps.length > 0) {
        const ol = document.createElement('ol');
        ol.style.cssText = 'margin:6px 0 8px 0;padding-left:22px;font-size:18px;line-height:1.45;color:var(--sw-text);';
        steps.forEach((step, idx) => {
          const li = document.createElement('li');
          const tag = step.status === 'done' ? 'Done' : (step.status === 'active' ? 'Current' : 'Next');
          li.textContent = `[${tag}] ${step.label || `Step ${idx + 1}`}`;
          li.style.cssText = step.status === 'active'
            ? 'font-weight:800;color:var(--sw-text);margin:4px 0;'
            : 'color:var(--sw-text-muted);margin:4px 0;';
          ol.appendChild(li);
        });
        card.appendChild(ol);
      }

      if (plan.status !== 'done') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel Plan';
        cancelBtn.style.cssText = 'width:100%;min-height:48px;min-width:48px;padding:10px 12px;font-size:18px;font-weight:800;border-radius:10px;cursor:pointer;background:var(--sw-surface-2);color:var(--sw-text);border:2px solid var(--sw-border-strong);';
        cancelBtn.addEventListener('click', () => onCancel('user_cancel_plan'));
        card.appendChild(cancelBtn);
      } else {
        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.textContent = 'Dismiss Plan';
        dismissBtn.style.cssText = 'width:100%;min-height:48px;min-width:48px;padding:10px 12px;font-size:18px;font-weight:800;border-radius:10px;cursor:pointer;background:var(--sw-accent);color:var(--sw-accent-fg);border:2px solid var(--sw-accent-border);';
        dismissBtn.addEventListener('click', () => {
          card.hidden = true;
          card.textContent = '';
          if (this.confirm && typeof this.confirm.clearPlan === 'function') {
            this.confirm.clearPlan();
          }
        });
        card.appendChild(dismissBtn);
      }

      card.hidden = false;
    }

    /**
     * Trigger single en-IN retry hint once cleanly in Auto mode (hi-IN -> en-IN).
     */
    _triggerAutoEnInRetry(reason = 'low_confidence') {
      if (!this.voice || typeof this.voice.retryWithEnIn !== 'function') return false;
      const retried = this.voice.retryWithEnIn({ restartListening: true });
      if (!retried) return false;

      const hint = reason === 'low_asr'
        ? 'Low speech confidence in Auto (hi-IN). Retrying once in English (en-IN) — please repeat.'
        : 'Could not recognize command in Auto (hi-IN). Retrying once in English (en-IN) — please repeat.';

      this.setAssistantReply(hint);
      this.updateStatusPill('listening', 'Retry EN');
      if (this.pill) {
        this.pill.setListening(hint);
      }
      if (this.glow) {
        this.glow.setListening();
      }
      return true;
    }

    /**
     * Test hook for window.__SW_SAY__(text) to inject simulated transcripts into the voice/dialogue pipeline.
     */
    async simulateVoiceInput(text, options = {}) {
      const clean = typeof text === 'string' ? text.trim() : '';
      if (!clean) return null;

      if (this.dialogue) {
        this.dialogue.noteSpeechActivity({ fromVoice: true });
      }
      if (this.voice && typeof this.voice.onTranscript === 'function') {
        this.voice.onTranscript({
          text: clean,
          isFinal: true,
          confidence: typeof options.confidence === 'number' ? options.confidence : 0.98,
          activeLang: (this.voice && this.voice.activeLang) || this.getEffectiveSpeechLang(this.lang),
          mode: this.lang
        });
      }
      if (this.pill) {
        this.pill.setTranscript(clean, 'Heard');
      }

      return await this.handleUserInput(clean, options.source || 'voice', {
        simulated: true,
        asrConfidence: typeof options.confidence === 'number' ? options.confidence : 0.98,
        activeLang: options.activeLang || (this.voice && this.voice.activeLang),
        mode: this.lang
      });
    }

    /**
     * Phase 2 unified input router for voice transcripts, panel typed input, and pill typed input.
     */
    async handleUserInput(text, inputSource = 'voice', meta = {}) {
      const rawText = typeof text === 'string' ? text.trim() : '';
      if (!rawText) return null;

      const activeLang = meta.activeLang || (this.voice && this.voice.activeLang) || this.getEffectiveSpeechLang(this.lang);
      const inAutoHiVoice = Boolean(
        inputSource === 'voice' &&
        this.voice &&
        this.voice.mode === 'auto' &&
        activeLang === 'hi-IN'
      );
      const asrConfidence = typeof meta.asrConfidence === 'number' ? meta.asrConfidence : null;

      // Single-retry check for low ASR confidence in Auto (hi-IN) before acting on noisy audio
      if (inAutoHiVoice && asrConfidence !== null && asrConfidence > 0 && asrConfidence < 0.6) {
        if (this._triggerAutoEnInRetry('low_asr')) {
          return { status: 'retry_en_in', reason: 'low_asr' };
        }
      }

      // 0. Continuous Dialogue layer: END phrases, half-done form check, meta-commands, answer-first pending prompt
      if (this.dialogue) {
        const dlgRes = await this.dialogue.handleUtterance(rawText, inputSource, meta);
        if (dlgRes && dlgRes.handled) {
          return dlgRes.result || { status: 'dialogue_handled' };
        }
      }

      // 0c. Active camera capture controls ("retake", "take photo", "shoot", "cancel")
      if (this.camera && this.camera.isActive() && this.camera.handleVoiceCommand(rawText)) {
        if (this.dialogue) {
          this.dialogue.recordTurn({ user: rawText, action: 'camera_control', assistant: '' });
        }
        return { status: 'camera_handled' };
      }

      // 1. Check active confirmation first
      if (this.confirm && this.confirm.isAwaiting()) {
        const normText = this.intentEngine ? this.intentEngine.normalise(rawText).text : rawText;
        let confirmRes = this.confirm.handleResponse({ raw: rawText });
        if (!confirmRes.handled && normText && normText !== rawText) {
          confirmRes = this.confirm.handleResponse({ raw: normText });
        }

        if (!confirmRes.handled && this.intentEngine) {
          const classified = await this.intentEngine.classify(rawText, {
            lang: this.lang,
            hasPendingConfirm: true
          });
          confirmRes = this.confirm.handleResponse({
            ...classified,
            raw: classified.normalized || rawText
          });

          if (!confirmRes.handled && inAutoHiVoice && classified.confidence < 0.75) {
            if (this._triggerAutoEnInRetry('low_intent')) {
              return { status: 'retry_en_in', reason: 'low_intent', classified };
            }
          }
        }

        if (confirmRes.handled) {
          const result = confirmRes.result || {};
          if (result.status === 'switch_other' && this.navigator) {
            await this.navigator.chooseOther();
          } else if (result.status === 'awaiting_second_confirm') {
            const stepMsg = 'Step 2 of 2: Please say "Yes" / "Haan" again or click Yes to finalize.';
            this.setAssistantReply(stepMsg);
            if (this.pill) this.pill.setStatus(stepMsg);
          }
          if (this.dialogue) {
            this.dialogue.recordTurn({ user: rawText, action: `confirm:${result.status || 'handled'}`, assistant: '' });
          }
          return { status: 'confirm_handled', result };
        }

        const promptMsg = 'Confirmation is waiting: say "Yes" / "Haan" to confirm, or "No" / "Cancel" to abort.';
        this.setAssistantReply(promptMsg);
        if (this.pill) {
          this.pill.setStatus(promptMsg);
          this.pill.openBubble();
        }
        return { status: 'confirm_pending' };
      }

      // 1a. Route open long-text dictation directly until "that's all"
      if (this.forms && typeof this.forms.isDictatingLongText === 'function' && this.forms.isDictatingLongText()) {
        this.forms.handleLongDictationInput(rawText);
        if (this.dialogue) {
          this.dialogue.recordTurn({ user: rawText, action: 'long_dictation', assistant: '' });
        }
        return { status: 'long_dictation_handled' };
      }

      // 1b. Route spoken field value directly when Guided Form Fill is awaiting a value
      if (this.forms && this.forms.isGuidedActive() && this.forms.guidedState.awaitingValue) {
        const curField = this.forms.guidedState.fields && this.forms.guidedState.fields[this.forms.guidedState.index];
        const isSens = Boolean(curField && (curField.sensitive || (this.forms.isSensitiveField && this.forms.isSensitiveField(curField.element, curField.label))));
        this.forms.handleGuidedInput(rawText);
        if (this.dialogue) {
          this.dialogue.recordTurn({
            user: isSens ? '[protected]' : rawText,
            action: `guided_field:${curField ? curField.label : 'field'}`,
            assistant: '',
            meta: { sensitive: isSens }
          });
        }
        return { status: 'guided_field_handled' };
      }

      // 2. Classify command through Intent Engine (rules -> 1 compact LLM call if < 0.75)
      let classified = null;
      if (this.intentEngine) {
        const navChoiceCount = (this.navigator && Array.isArray(this.navigator.pendingChoices) && this.navigator.pendingChoices.length) || 0;
        const pageCandidates = (navChoiceCount === 0 && this.navigator && typeof this.navigator.getClickableCatalog === 'function')
          ? this.navigator.getClickableCatalog()
          : [];
        const activeEl = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
        const sensitiveFocused = Boolean(
          this.forms &&
          typeof this.forms.isSensitiveField === 'function' &&
          (
            (activeEl && this.forms.isSensitiveField(activeEl)) ||
            (this.forms.lastFocusedField && this.forms.isSensitiveField(this.forms.lastFocusedField))
          )
        );
        classified = await this.intentEngine.classify(rawText, {
          lang: this.lang,
          hasPendingConfirm: false,
          hasPendingNavChoice: navChoiceCount > 0,
          hasNumberedChoices: navChoiceCount > 0,
          maxChoices: navChoiceCount || 5,
          candidates: pageCandidates,
          sensitiveActive: sensitiveFocused
        });
      } else if (this.voice) {
        const legacy = meta.legacyParsed || this.voice.parseCommand(rawText);
        this.executeCommand(legacy);
        return { status: 'legacy_executed', cmd: legacy };
      }

      if (!classified) return null;

      // Single en-IN retry if Auto (hi-IN) had low intent confidence
      if (inAutoHiVoice && classified.confidence < 0.75) {
        if (this._triggerAutoEnInRetry('low_intent')) {
          return { status: 'retry_en_in', reason: 'low_intent', classified };
        }
      }

      await this.dispatchIntent(classified, rawText);
      if (this.dialogue) {
        const replyEl = this.shadowRoot && this.shadowRoot.getElementById('sw-assistant-text');
        this.dialogue.recordTurn({
          user: rawText,
          action: classified.intent || 'command',
          assistant: replyEl ? replyEl.textContent : ''
        });
      }
      return { status: 'dispatched', classified };
    }

    /**
     * Dispatch a classified Phase 2 intent object cleanly.
     */
    async dispatchIntent(classified, rawText = '') {
      const intent = classified && classified.intent ? classified.intent : 'HELP';
      const args = (classified && classified.args) || {};
      const confidence = typeof classified.confidence === 'number' ? classified.confidence : 0.8;

      switch (intent) {
        case 'READ':
          if (args.scope === 'section' && args.target) {
            if (this.pill) this.pill.setPreparing(`Looking for section: "${args.target}"...`);
            this.readSection(args.target, false);
          } else {
            if (this.pill) this.pill.setPreparing('Extracting page content...');
            this.readPage();
          }
          break;

        case 'EXPLAIN': {
          const replyLang = this.resolveReplyLang(classified);
          this.lastExplainOptions = {
            mode: args.mode || (args.target ? 'section' : 'summary'),
            level: args.level || 'standard'
          };
          if (args.mode === 'some_part') {
            this.explainSomePart();
          } else {
            if (this.pill) {
              this.pill.setPreparing(args.target ? `Analyzing "${args.target}"...` : 'Analyzing page content...');
            }
            this.explainPage({
              mode: this.lastExplainOptions.mode,
              level: this.lastExplainOptions.level,
              target: args.target || '',
              lang: replyLang,
              isFollowUp: Boolean(args.level && args.level !== 'standard')
            });
          }
          break;
        }

        case 'HELP': {
          const helpMsg = this.lang === 'hi-IN'
            ? 'कमांड: "पेज पढ़ो", "समझाओ", "आउटलाइन", "नीचे स्क्रॉल करो", "वापस जाओ", "धीरे पढ़ो", "तेज पढ़ो", "रोको", "फॉर्म भरो"। '
            : 'Commands: "Read this page", "Explain this page", "Outline", "Scroll down/up", "Go back", "Slower", "Faster", "Pause", "Stop", "Help me apply".';
          this.setAssistantReply(helpMsg);
          const details = this.shadowRoot && this.shadowRoot.querySelector('details.sw-help-box');
          if (details) details.open = true;
          if (this.pill) {
            this.pill.setStatus(helpMsg);
            this.pill.openBubble();
          }
          break;
        }

        case 'CONTROL': {
          const action = args.action;
          if (action === 'pause') {
            this.reader.pause();
            this.setAssistantReply('Reading paused.');
          } else if (action === 'resume') {
            if (this.reader && this.reader.isPaused) {
              this.reader.resume();
              this.setAssistantReply('Resuming reading...');
            } else if (this.navigator && await this.navigator.tryResumeSavedState()) {
              // Cross-page session task resumed
            } else {
              this.reader.resume();
              this.setAssistantReply('Resuming reading...');
            }
          } else if (action === 'stop') {
            this.stopReading();
          } else if (action === 'repeat') {
            this.setAssistantReply('Restarting from the beginning...');
            if (this.pill) this.pill.setPreparing('Restarting from beginning...');
            this.reader.readAgain();
          } else if (action === 'slower') {
            const nextRate = Math.max(0.6, Math.round((this.rate - 0.2) * 10) / 10);
            this.setRate(nextRate);
            if (this.pill) this.pill.setStatus(`Reading speed set to ${nextRate}x.`);
          } else if (action === 'faster') {
            const nextRate = Math.min(1.5, Math.round((this.rate + 0.2) * 10) / 10);
            this.setRate(nextRate);
            if (this.pill) this.pill.setStatus(`Reading speed set to ${nextRate}x.`);
          } else if (action === 'language') {
            this.setLanguage(args.lang || 'en-IN');
            const info = this.getLanguageInfo(this.lang);
            if (this.pill) this.pill.setStatus(`Language set to ${info.name}.`);
          }
          break;
        }

        case 'SEARCH':
        case 'NAVIGATE':
          await this._handleNavigateIntent(
            intent === 'SEARCH' ? { ...args, action: 'search' } : args,
            confidence,
            rawText
          );
          break;

        case 'ANSWER': {
          const query = args.query || rawText;
          const level = (this.lastExplainOptions && this.lastExplainOptions.level) || 'standard';
          const replyLang = this.resolveReplyLang(classified);
          if (this.pill) {
            this.pill.setPreparing(`Checking page for "${query}"...`);
            this.pill.openBubble();
          }
          this.explainPage({
            mode: 'qa',
            query,
            level,
            lang: replyLang
          });
          break;
        }

        case 'FILL_GUIDED':
          if (args.isPlan) {
            this._startSampleGuidedPlan();
          } else if (this.forms) {
            this.forms.startGuidedFill();
          } else {
            this.setAssistantReply('Forms module not loaded.');
          }
          break;

        case 'DICTATE':
          if (this.forms) {
            this.lastUndoableType = 'forms';
            await this.forms.handleDictateIntent(args, rawText);
          } else {
            this.setAssistantReply('Forms module not loaded.');
          }
          break;

        case 'FILL_PROFILE':
          if (this.forms) {
            this.lastUndoableType = 'forms';
            this.forms.fillFromProfile();
          } else {
            this.setAssistantReply('Forms module not loaded.');
          }
          break;

        case 'UPLOAD':
          if (args.mode === 'camera' && this.camera) {
            await this.camera.requestCapture(args.target || rawText);
          } else if (this.upload) {
            this.upload.requestUpload(args.target || rawText);
          } else {
            this.setAssistantReply('Upload module not loaded.');
          }
          break;

        case 'UNDO':
          if (this.lastUndoableType === 'upload' && this.upload && this.upload.uploadUndoStack.length > 0) {
            this.upload.undoLastUpload();
          } else if (this.forms && this.forms.undoStack.length > 0) {
            this.forms.undoLast();
          } else if (this.upload && this.upload.uploadUndoStack.length > 0) {
            this.upload.undoLastUpload();
          } else {
            this.setAssistantReply('Nothing to undo.');
          }
          break;

        case 'CONFIRM_YES':
        case 'CONFIRM_NO': {
          const noneMsg = 'Nothing is currently waiting for confirmation.';
          this.setAssistantReply(noneMsg);
          if (this.pill) {
            this.pill.setStatus(noneMsg);
            this.pill.openBubble();
          }
          break;
        }

        default: {
          const fallbackMsg = `Command not recognized: "${rawText}". Say "Help" for options.`;
          this.setAssistantReply(fallbackMsg);
          if (this.pill) this.pill.setError(fallbackMsg);
          break;
        }
      }
    }

    /**
     * Handle NAVIGATE sub-actions with risk-appropriate confirmation policies via SleepwalkerNavigator.
     */
    async _handleNavigateIntent(args = {}, confidence = 0.9, rawText = '') {
      const action = args.action;

      if (action === 'search' && this.navigator && typeof this.navigator.executeSearch === 'function') {
        return this.navigator.executeSearch(args.query || args.target || '', {
          confidence,
          rawText,
          siteHint: args.siteHint || ''
        });
      }

      if (action === 'outline') {
        this.showOutline();
        return;
      }

      if (action === 'section') {
        const target = (args.target || '').trim();
        if (!target || /^(?:some\s+part|a\s+part|part|some\s+section)$/i.test(target)) {
          this.navigateSomePart();
        } else if (this.navigator) {
          this.navigator.goToSection(target, { readAfter: true });
        } else {
          this.readSection(target, true);
        }
        return;
      }

      if (!this.navigator) {
        this.setAssistantReply('Navigation module not loaded on this page.');
        return;
      }

      if (action === 'scroll') {
        this.navigator.scroll(args.dir || 'down', confidence);
        return;
      }

      if (action === 'history') {
        this.navigator.historyAction(args.dir || 'back', confidence);
        return;
      }

      if (action === 'paginate') {
        this.navigator.paginate(args.dir === 'prev' ? 'prev' : 'next', confidence);
        return;
      }

      if (action === 'choose_ordinal') {
        await this.navigator.chooseOrdinal(args.choice);
        return;
      }

      if (action === 'list_links') {
        await this.navigator.handleLinkCommand({ action: 'LIST' }, { confidence, rawText });
        return;
      }

      if (action === 'choose_link') {
        await this.navigator.handleLinkCommand(
          args.linkIntent || { action: 'CHOOSE', ordinal: args.choice, chooseMode: args.chooseMode || 'ordinal' },
          { confidence, rawText }
        );
        return;
      }

      if (action === 'find_link') {
        await this.navigator.handleLinkCommand(
          args.linkIntent || { action: 'FIND', target: args.target || '' },
          { confidence, rawText }
        );
        return;
      }

      if (action === 'find_then_click') {
        await this.navigator.handleLinkCommand(
          args.linkIntent || { action: 'FIND_THEN_CLICK', target: args.target || '' },
          { confidence, rawText }
        );
        return;
      }

      if (action === 'more_info') {
        await this.navigator.handleLinkCommand(
          args.linkIntent || { action: 'MORE_INFO', target: args.target || '' },
          { confidence, rawText }
        );
        return;
      }

      if (action === 'click') {
        if (args.isSubmit && this.forms) {
          const fi = window.SleepwalkerFormIndex;
          const btns = fi && typeof fi.detectFormActionButtons === 'function'
            ? fi.detectFormActionButtons(document)
            : { nextButtons: [], submitButtons: [] };
          if (btns.submitButtons && btns.submitButtons.length > 0 && this.forms.detectFormFields().length > 0) {
            this.forms.reviewAndActOnStepOrSubmit('submit', btns.submitButtons[0].element);
            return;
          }
        }
        await this.navigator.executeClick(args.target || '', {
          confidence,
          rawText,
          linkIntent: args.linkIntent || null,
          explicitFlags: {
            isSubmit: Boolean(args.isSubmit),
            risk: args.risk || ''
          }
        });
      }
    }

    /**
     * Start a sample <= 5 step guided plan via SleepwalkerConfirm with session persistence.
     */
    _startSampleGuidedPlan() {
      if (!this.confirm) return;
      const steps = [
        { label: 'Review page instructions & eligibility', risk: 'medium', confidence: 0.75 },
        { label: 'Check required form fields (Phase 5 Forms)', risk: 'medium', confidence: 0.75 },
        { label: 'Verify required documents (Phase 6 Files)', risk: 'medium', confidence: 0.75 },
        { label: 'Final review before submit (always double-confirmed)', risk: 'medium', confidence: 0.75 }
      ];

      const planTitle = 'Guided Apply Plan (Preview)';
      if (this.navigator) {
        this.navigator.saveSessionState({
          active: true,
          kind: 'plan',
          planTitle,
          planSteps: steps,
          currentStepIndex: 0
        });
      }

      this.setAssistantReply('Started 4-step guided apply plan. Say "Yes" / "Haan" to advance each step or "Cancel" to stop.');
      this.confirm.startPlan({
        title: planTitle,
        steps,
        onExecuteStep: (step) => {
          const msg = `Completed step ${step.index + 1}: ${step.label}`;
          this.setAssistantReply(msg);
          if (this.pill) this.pill.setStatus(msg);
          if (this.navigator) {
            this.navigator.saveSessionState({
              active: true,
              kind: 'plan',
              planTitle,
              planSteps: steps,
              currentStepIndex: Math.min(step.index + 1, steps.length - 1)
            });
          }
          return true;
        },
        onComplete: () => {
          const doneMsg = 'Guided plan preview completed.';
          this.setAssistantReply(doneMsg);
          if (this.pill) this.pill.setIdle(doneMsg);
          if (this.navigator) this.navigator.clearSessionState();
        },
        onCancel: (reason) => {
          const cancelMsg = reason === 'timeout' ? 'Guided plan timed out and was cancelled.' : 'Guided plan cancelled.';
          this.setAssistantReply(cancelMsg);
          if (this.pill) this.pill.setIdle(cancelMsg);
          if (this.navigator) this.navigator.clearSessionState();
        }
      });
    }

    /**
     * Dispatch recognized voice or typed command to the appropriate action (P1 compatibility).
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
      this._isExplaining = false;
      if (this.explainer) {
        this.explainer.abort();
      }
      if (this.navigator) {
        this.navigator.cancelPendingHighlight();
      }
      this.reader.stop();
      this.setAssistantReply('Reading stopped.');
      if (this.glow) {
        this.glow.setOff();
      }
      if (this.pill && (this.pill.state === 'preparing' || this.pill.state === 'thinking' || this.pill.state === 'speaking')) {
        this.pill.setIdle('Stopped.');
      }
      this.syncStopButton();
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
            ${this.getSvgIcon('volume')}
            <span>Read</span>
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

      this.switchTab('page');
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
    explainPage(sectionQueryOrOptions = null) {
      if (this.explainer) {
        this._isExplaining = true;
        this.syncStopButton();
        Promise.resolve(this.explainer.runExplainPipeline(sectionQueryOrOptions))
          .catch(() => null)
          .finally(() => {
            this._isExplaining = false;
            this.syncStopButton();
          });
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
      if (window.SW_UI) {
        window.SW_UI.setState('listening');
        window.SW_UI.setTranscript('Listening (Hold Alt+Z)...');
      } else {
        if (this.pill) this.pill.setListening('Listening (holding Alt+Z)...');
        if (this.glow) this.glow.setListening();
      }
      this.setAssistantReply('Listening... Speak while holding Alt+Z, then release.');
    }

    /**
     * Stop listening and commit command upon hotkey release (Hold-to-Talk release).
     */
    stopHoldToTalk() {
      if (this.voice) {
        const committed = this.voice.stopListeningAndCommit();
        if (window.SW_UI) {
          if (committed) {
            window.SW_UI.setState('thinking');
          } else {
            window.SW_UI.hide({ dissolve: true });
          }
        } else if (!committed && this.pill && this.pill.state === 'listening') {
          this.pill.setIdle('Ready • Type or speak a command');
          if (this.glow) this.glow.setOff();
        }
      }
    }

    /**
     * Cycle header language button across EN -> HI -> AUTO -> EN.
     */
    toggleLanguage() {
      const idx = LANG_CYCLE_ORDER.indexOf(this.lang);
      const nextLang = idx === -1 ? 'en-IN' : LANG_CYCLE_ORDER[(idx + 1) % LANG_CYCLE_ORDER.length];
      this.setLanguage(nextLang);
    }

    /**
     * Set language/mode (auto, en-IN, hi-IN, or regional Indian code), sync UI & ASR/TTS, and persist.
     */
    setLanguage(newLang, options = {}) {
      const info = this.getLanguageInfo(newLang);
      this.lang = info.code;

      if (this.reader) {
        this.reader.setLang(info.speechLang);
      }
      if (this.voice) {
        this.voice.setLang(info.code);
      }

      const label = this.shadowRoot && this.shadowRoot.getElementById('sw-lang-label');
      const btn = this.shadowRoot && this.shadowRoot.getElementById('sw-btn-lang');
      const selectEl = this.shadowRoot && this.shadowRoot.getElementById('sw-select-lang');
      const micStatus = this.shadowRoot && this.shadowRoot.getElementById('sw-mic-status-text');

      if (label) label.textContent = info.shortCode;
      if (selectEl && selectEl.value !== info.code) {
        selectEl.value = info.code;
      }

      if (btn) {
        btn.setAttribute(
          'aria-label',
          `Current language ${info.name}. Click to cycle EN, HI, AUTO.`
        );
      }

      if (micStatus && (!this.voice || !this.voice.isListening)) {
        if (info.code === 'hi-IN') {
          micStatus.textContent = 'माइक दबाकर बोलें';
        } else if (info.code === 'auto') {
          micStatus.textContent = 'Tap Mic to Speak (Auto)';
        } else {
          micStatus.textContent = 'Tap Mic to Speak';
        }
      }

      if (!options.silent) {
        if (info.code === 'hi-IN') {
          this.setAssistantReply('भाषा हिंदी (hi-IN) पर सेट हो गई है।');
        } else if (info.code === 'auto') {
          this.setAssistantReply('Language set to Auto (Hinglish: hi-IN default with single en-IN retry).');
        } else {
          this.setAssistantReply(`Language set to ${info.name} (${info.code}).`);
        }
        this.savePreferences();
      }
    }

    /**
     * Set widget font size (18, 22, 26).
     */
    setFontSize(size, options = {}) {
      this.fontSize = size;
      const panel = this.shadowRoot.getElementById('sw-panel');
      if (panel) {
        panel.style.setProperty('--sw-font-size', `${size}px`);
      }

      this.shadowRoot.querySelectorAll('[data-size]').forEach((b) => {
        b.classList.toggle('sw-active', parseInt(b.getAttribute('data-size'), 10) === size);
      });

      if (!options.silent) {
        this.savePreferences();
      }
    }

    /**
     * Enable or disable Barge-In mode (headphones recommended).
     */
    setBargeIn(enabled, options = {}) {
      this.bargeIn = Boolean(enabled);
      if (this.dialogue) {
        this.dialogue.setBargeIn(this.bargeIn);
      }
      const root = this.shadowRoot;
      if (root) {
        const toggle = root.getElementById('sw-toggle-barge-in');
        if (toggle) toggle.checked = this.bargeIn;
      }
      if (!options.silent && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ sleepwalker_barge_in: this.bargeIn });
      }
    }

    /**
     * Set reader speech rate (0.6x to 1.5x).
     */
    setRate(rate, options = {}) {
      const clamped = Math.max(0.6, Math.min(1.5, Math.round((parseFloat(rate) || 1.0) * 10) / 10));
      this.rate = clamped;
      if (this.reader) {
        this.reader.setRate(clamped);
      }

      this.shadowRoot.querySelectorAll('[data-rate]').forEach((b) => {
        b.classList.toggle('sw-active', Math.abs(parseFloat(b.getAttribute('data-rate')) - clamped) < 0.01);
      });

      if (!options.silent) {
        this.setAssistantReply(`Reading speed set to ${clamped}x.`);
        this.savePreferences();
      }
    }

    /**
     * Update assistant text announcement.
     */
    setAssistantReply(text) {
      const el = this.shadowRoot.getElementById('sw-assistant-text');
      if (el) {
        el.textContent = text;
      }
      if (this.dialogue && text && !/^(?:Listening\.\.\.|Idle|Ready\b|Reading sentence \d+)/i.test(String(text))) {
        this.dialogue.lastSpokenText = String(text);
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
     * Show Stop Reading button (#sw-btn-stop & pill stop button) ONLY while reading or explaining.
     */
    syncStopButton() {
      const isReading = Boolean(this.reader && (this.reader.isPlaying || this.reader.isPaused));
      const isExplaining = Boolean(
        this._isExplaining ||
        (this.explainer && (this.explainer.isActive || this.explainer.isPreparing || this.explainer.isRunning)) ||
        (this.pill && (this.pill.state === 'preparing' || this.pill.state === 'thinking' || this.pill.state === 'speaking'))
      );
      const visible = isReading || isExplaining;

      if (this.shadowRoot) {
        const stopBtn = this.shadowRoot.getElementById('sw-btn-stop');
        if (stopBtn) {
          stopBtn.hidden = !visible;
          stopBtn.classList.toggle('sw-stop-hidden', !visible);
          stopBtn.style.setProperty('display', visible ? 'inline-flex' : 'none', 'important');
        }
      }

      if (this.pill && typeof this.pill.setStopButtonVisible === 'function') {
        this.pill.setStopButtonVisible(visible);
      }
    }

    /**
     * Open widget panel and hide the floating pill bubble while panel is open.
     */
    open() {
      const panel = this.shadowRoot.getElementById('sw-panel');
      if (panel) {
        panel.classList.add('sw-open');
        panel.style.transform = 'translateX(0)';
        this.isOpen = true;
        if (this.pill && typeof this.pill.hide === 'function') {
          this.pill.hide();
        }
        setTimeout(() => {
          const mic = this.shadowRoot.getElementById('sw-btn-mic');
          if (mic) mic.focus();
        }, 100);
      }
    }

    /**
     * Close widget panel and reveal the floating pill again.
     */
    close() {
      const panel = this.shadowRoot.getElementById('sw-panel');
      if (panel) {
        panel.classList.remove('sw-open');
        panel.style.transform = 'translateX(105%)';
        this.isOpen = false;
        this._isExplaining = false;
        if (this.explainer) {
          this.explainer.abort();
        }
        if (this.camera && this.camera.isActive()) {
          this.camera.cancelCapture();
        }
        if (this.dialogue && this.dialogue.isActive()) {
          this.dialogue.endSession({ reason: 'close', quiet: true, force: true });
        } else if (this.voice) {
          this.voice.stopListening();
        }
        if (this.reader) {
          this.reader.stop();
        }
        if (this.pill) {
          if (this.pill.state === 'preparing' || this.pill.state === 'thinking' || this.pill.state === 'speaking') {
            this.pill.setIdle('Stopped.');
          }
          if (typeof this.pill.show === 'function') {
            this.pill.show();
          }
        }
        this.syncStopButton();
      }
    }

    /**
     * Switch between the 5 side-panel tabs (Talk / Page / Forms / Files / Settings).
     * @param {string} tabName
     * @param {boolean} [moveFocus]
     */
    switchTab(tabName, moveFocus = false) {
      if (!this.shadowRoot || !tabName) return;

      this.shadowRoot.querySelectorAll('.sw-tab-btn').forEach((btn) => {
        const isActive = btn.dataset.tab === tabName;
        btn.classList.toggle('sw-tab-active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        btn.setAttribute('tabindex', isActive ? '0' : '-1');
        if (isActive && moveFocus) {
          btn.focus();
        }
      });

      this.shadowRoot.querySelectorAll('.sw-tab-panel').forEach((panel) => {
        panel.hidden = panel.dataset.tabPanel !== tabName;
      });

      if (tabName === 'settings') {
        const diagView = this.shadowRoot.getElementById('sw-diag-view');
        if (diagView && diagView.style.display !== 'none') {
          this.renderDiagnostics();
        }
        const geminiInput = this.shadowRoot.getElementById('sw-input-gemini-key');
        if (!this._envSyncedOnce || (geminiInput && !geminiInput.value.trim())) {
          this.loadPreferences();
        } else {
          this._syncEnvFromBackground(false);
        }
      }
    }

    /**
     * Dismiss all active interaction and dissolve orb UI back to idle.
     */
    dismissUi(reason = 'escape') {
      if (this.camera && this.camera.isActive()) this.camera.cancelCapture();
      if (this.confirm && this.confirm.isAwaiting()) this.confirm.cancel('user_escape');
      if (this.confirm && this.confirm.isPlanActive()) this.confirm.cancelPlan('user_escape');
      if (this.forms && this.forms.isGuidedActive()) this.forms.stopGuidedFill('cancelled');
      if (this.reader && this.reader.isPlaying) this.stopReading();
      if (this.explainer) this.explainer.abort();
      if (this.dialogue && this.dialogue.isActive()) {
        this.dialogue.endSession({ reason, quiet: true, force: true });
      } else if (this.voice) {
        this.voice.stopListening();
      }
      if (window.SW_UI) {
        window.SW_UI.hide({ dissolve: reason !== 'instant' });
      }
      if (this.isOpen) this.close();
    }

    /**
     * Toggle assistant summon/dismiss (P1 uses SW_UI bottom orb; legacy tests fall back to panel).
     */
    toggle(options = {}) {
      // Alt+S always interrupts active speech immediately without debounce delay
      if (this.reader && this.reader.isPlaying && !this.reader.isPaused && this.dialogue) {
        this.dialogue.interruptSpeech({
          source: options.source || 'alt_s',
          resumeSession: true
        });
        if (window.SW_UI) window.SW_UI.setState('listening');
        return;
      }

      const now = Date.now();
      if (this._lastToggleTime && now - this._lastToggleTime < 350) {
        return;
      }
      this._lastToggleTime = now;

      if (window.SW_UI) {
        const uiState = window.SW_UI.getState ? window.SW_UI.getState() : 'idle';
        if (uiState !== 'idle' || (this.dialogue && this.dialogue.isActive())) {
          this.dismissUi('toggle');
          return;
        }
        window.SW_UI.setState('listening');
        window.SW_UI.setTranscript('Listening...');
        if (this.dialogue) {
          this.dialogue.startSession({ source: options.source || 'alt_s' });
        } else if (this.voice) {
          this.voice.startListening();
        }
        return;
      }

      if (this.isOpen) {
        if (options.startDialogue && this.dialogue && !this.dialogue.isActive()) {
          this.dialogue.startSession({ source: options.source || 'alt_s' });
          return;
        }
        if (this.dialogue && this.dialogue.isActive()) {
          this.dialogue.endSession({ reason: 'toggle', quiet: true, force: true });
        }
        this.close();
      } else {
        this.open();
        if (options.startDialogue && this.dialogue && !this.dialogue.isActive()) {
          this.dialogue.startSession({ source: options.source || 'alt_s' });
        }
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
     * Format a short non-sensitive key summary for inline status hints.
     */
    _maskSecretKey(key) {
      const k = String(key || '').trim();
      if (!k) return 'none';
      if (k.length <= 10) return `${k.slice(0, 2)}…${k.slice(-2)} (${k.length} chars)`;
      return `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`;
    }

    /**
     * Apply `.env` defaults returned by the background worker to Settings inputs.
     */
    _applyAiEnvDefaults(envCfg, forceOverwrite = false) {
      const root = this.shadowRoot;
      if (!root || !envCfg) return;

      const geminiInput = root.getElementById('sw-input-gemini-key');
      const geminiModelInput = root.getElementById('sw-input-gemini-model');
      const proxyInput = root.getElementById('sw-input-proxy-url');
      const ollamaUrlInput = root.getElementById('sw-input-ollama-url');
      const ollamaModelInput = root.getElementById('sw-input-ollama-model');
      const localOnlyToggle = root.getElementById('sw-toggle-local-only');
      const envHint = root.getElementById('sw-env-status-hint');

      if (geminiInput && envCfg.geminiKey && (forceOverwrite || !geminiInput.value.trim())) {
        geminiInput.value = envCfg.geminiKey;
      }
      if (
        geminiModelInput &&
        envCfg.geminiModel &&
        (forceOverwrite || !geminiModelInput.value.trim() || geminiModelInput.value.trim() === 'gemini-2.5-flash-lite')
      ) {
        geminiModelInput.value = envCfg.geminiModel;
      }
      if (proxyInput && typeof envCfg.proxyUrl === 'string' && (forceOverwrite || (!proxyInput.value.trim() && envCfg.proxyUrl))) {
        proxyInput.value = envCfg.proxyUrl;
      }
      if (
        ollamaUrlInput &&
        envCfg.ollamaUrl &&
        (forceOverwrite || !ollamaUrlInput.value.trim() || ollamaUrlInput.value.trim() === 'http://localhost:11434')
      ) {
        ollamaUrlInput.value = envCfg.ollamaUrl;
      }
      if (
        ollamaModelInput &&
        envCfg.ollamaModel &&
        (forceOverwrite || !ollamaModelInput.value.trim() || ollamaModelInput.value.trim() === 'llama3.2:3b')
      ) {
        ollamaModelInput.value = envCfg.ollamaModel;
      }
      if (localOnlyToggle && forceOverwrite && typeof envCfg.localOnly === 'boolean') {
        localOnlyToggle.checked = envCfg.localOnly;
      }

      if (envHint) {
        if (envCfg.envLoaded) {
          envHint.textContent =
            `.env active — Gemini key: ${this._maskSecretKey(envCfg.geminiKey)} (${envCfg.geminiModel || 'gemini-2.5-flash-lite'}) · ` +
            `Ollama: ${envCfg.ollamaModel || 'llama3.2:3b'} @ ${envCfg.ollamaUrl || 'http://localhost:11434'}. Click Show to reveal.`;
        } else {
          const shownKey = geminiInput ? geminiInput.value.trim() : '';
          envHint.textContent = `Using stored settings (key: ${this._maskSecretKey(shownKey)}). Click Show to reveal or Load .env to sync.`;
        }
      }
    }

    /**
     * Fetch `.env` defaults (Gemini + Ollama) privately from the service worker.
     */
    _syncEnvFromBackground(forceReload = false) {
      return new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve(null);
          return;
        }
        try {
          chrome.runtime.sendMessage(
            { type: forceReload ? 'SLEEPWALKER_RELOAD_ENV' : 'SLEEPWALKER_GET_ENV_DEFAULTS' },
            (resp) => {
              if (chrome.runtime && chrome.runtime.lastError) {
                resolve(null);
                return;
              }
              if (resp && resp.status === 'ok') {
                this._envSyncedOnce = true;
                this._applyAiEnvDefaults(resp, forceReload);
                resolve(resp);
              } else {
                resolve(null);
              }
            }
          );
        } catch (e) {
          resolve(null);
        }
      });
    }

    /**
     * Force-reload `.env` defaults into chrome.storage and Settings inputs.
     */
    async reloadEnvSettings() {
      const statusBox = this.shadowRoot ? this.shadowRoot.getElementById('sw-ai-test-status') : null;
      if (statusBox) {
        statusBox.className = 'sw-ai-test-result sw-ai-test-info';
        statusBox.textContent = 'Reloading Gemini & Ollama settings from .env...';
      }

      const resp = await this._syncEnvFromBackground(true);
      if (!statusBox) return;

      if (resp && resp.status === 'ok') {
        statusBox.className = 'sw-ai-test-result sw-ai-test-success';
        statusBox.textContent = resp.envLoaded
          ? `✓ Loaded .env (Gemini: ${this._maskSecretKey(resp.geminiKey)} / ${resp.geminiModel}, Ollama: ${resp.ollamaModel}).`
          : '✓ Synced defaults (no active key in root .env).';
      } else {
        statusBox.className = 'sw-ai-test-result sw-ai-test-error';
        statusBox.textContent = 'Could not reach background worker to reload .env.';
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
            'sleepwalker_barge_in',
            'sleepwalker_gemini_api_key',
            'sleepwalker_gemini_model',
            'sleepwalker_proxy_url',
            'sleepwalker_ollama_url',
            'sleepwalker_ollama_model',
            'sleepwalker_privacy_ack'
          ],
          (data) => {
            if (data.sleepwalker_lang) {
              this.setLanguage(data.sleepwalker_lang, { silent: true });
            }
            if (data.sleepwalker_font_size) {
              this.setFontSize(data.sleepwalker_font_size, { silent: true });
            }
            if (data.sleepwalker_rate) {
              this.setRate(data.sleepwalker_rate, { silent: true });
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

            // Barge-In mode
            if (typeof data.sleepwalker_barge_in !== 'undefined') {
              this.setBargeIn(Boolean(data.sleepwalker_barge_in), { silent: true });
            } else {
              const bargeInToggle = root.getElementById('sw-toggle-barge-in');
              if (bargeInToggle) bargeInToggle.checked = Boolean(this.bargeIn);
            }

            // Gemini API key & Model
            const geminiInput = root.getElementById('sw-input-gemini-key');
            if (geminiInput && data.sleepwalker_gemini_api_key) {
              geminiInput.value = data.sleepwalker_gemini_api_key;
            }

            const geminiModelInput = root.getElementById('sw-input-gemini-model');
            if (geminiModelInput && data.sleepwalker_gemini_model) {
              geminiModelInput.value = data.sleepwalker_gemini_model;
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

            this._syncEnvFromBackground(false);
          }
        );
      } else {
        this._syncEnvFromBackground(false);
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
      const bargeInToggle = root.getElementById('sw-toggle-barge-in');
      const geminiInput = root.getElementById('sw-input-gemini-key');
      const geminiModelInput = root.getElementById('sw-input-gemini-model');
      const proxyInput = root.getElementById('sw-input-proxy-url');
      const ollamaUrlInput = root.getElementById('sw-input-ollama-url');
      const ollamaModelInput = root.getElementById('sw-input-ollama-model');
      const statusBox = root.getElementById('sw-ai-test-status');

      const glowEnabled = glowToggle ? glowToggle.checked : true;
      const localOnly = localOnlyToggle ? localOnlyToggle.checked : false;
      const bargeIn = bargeInToggle ? bargeInToggle.checked : false;
      const geminiKey = geminiInput ? geminiInput.value.trim() : '';
      const geminiModel = geminiModelInput ? (geminiModelInput.value.trim() || 'gemini-2.5-flash-lite') : 'gemini-2.5-flash-lite';
      const proxyUrl = proxyInput ? proxyInput.value.trim() : '';
      const ollamaUrl = ollamaUrlInput ? (ollamaUrlInput.value.trim() || 'http://localhost:11434') : 'http://localhost:11434';
      const ollamaModel = ollamaModelInput ? (ollamaModelInput.value.trim() || 'llama3.2:3b') : 'llama3.2:3b';

      if (this.glow) {
        this.glow.setEnabled(glowEnabled);
      }
      this.setBargeIn(bargeIn, { silent: true });

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          sleepwalker_glow_enabled: glowEnabled,
          sleepwalker_local_only: localOnly,
          sleepwalker_barge_in: bargeIn,
          sleepwalker_gemini_api_key: geminiKey,
          sleepwalker_gemini_model: geminiModel,
          sleepwalker_gemini_manual_override: Boolean(geminiKey),
          sleepwalker_proxy_url: proxyUrl,
          sleepwalker_ollama_url: ollamaUrl,
          sleepwalker_ollama_model: ollamaModel
        }, () => {
          const envHint = root.getElementById('sw-env-status-hint');
          if (envHint) {
            envHint.textContent = `Saved settings active (Gemini key: ${this._maskSecretKey(geminiKey)} · ${geminiModel} · Ollama: ${ollamaModel}).`;
          }
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
     * Test reachability of configured Gemini key, Cloud Proxy, or Local Ollama.
     * Dynamically requests optional_host_permissions at runtime if needed.
     */
    async testAiConnection() {
      const root = this.shadowRoot;
      if (!root) return;

      const statusBox = root.getElementById('sw-ai-test-status');
      const geminiInput = root.getElementById('sw-input-gemini-key');
      const geminiModelInput = root.getElementById('sw-input-gemini-model');
      const proxyInput = root.getElementById('sw-input-proxy-url');
      const ollamaUrlInput = root.getElementById('sw-input-ollama-url');

      let geminiKey = geminiInput ? geminiInput.value.trim() : '';
      let geminiModel = geminiModelInput ? (geminiModelInput.value.trim() || 'gemini-2.5-flash-lite') : 'gemini-2.5-flash-lite';
      if (!geminiKey && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const stored = await new Promise(r => chrome.storage.local.get(['sleepwalker_gemini_api_key', 'sleepwalker_gemini_model'], r));
        geminiKey = (stored.sleepwalker_gemini_api_key || '').trim();
        if (stored.sleepwalker_gemini_model) {
          geminiModel = stored.sleepwalker_gemini_model.trim() || geminiModel;
        }
      }
      if (!geminiKey) {
        const envResp = await this._syncEnvFromBackground(false);
        if (envResp && envResp.geminiKey) {
          geminiKey = envResp.geminiKey;
          if (envResp.geminiModel) geminiModel = envResp.geminiModel;
        }
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
      let geminiErrNote = '';
      if (geminiKey) {
        const modelsToTry = Array.from(new Set([geminiModel, 'gemini-flash-lite-latest'].filter(Boolean)));
        for (const modelId of modelsToTry) {
          try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [{ text: 'Ping' }] }]
                }),
                signal: controller.signal
              }
            );
            clearTimeout(t);
            if (res.ok) {
              if (statusBox) {
                statusBox.className = 'sw-ai-test-result sw-ai-test-success';
                statusBox.textContent = `✅ Cloud Gemini API connected (${modelId} online)!`;
              }
              return;
            }
            let detail = `HTTP ${res.status}`;
            try {
              const errJson = await res.json();
              if (errJson && errJson.error && errJson.error.message) {
                detail = `HTTP ${res.status}: ${errJson.error.message.slice(0, 90)}`;
              }
            } catch (parseErr) {}
            geminiErrNote = detail;
          } catch (e) {
            geminiErrNote = e && e.name === 'AbortError' ? 'timeout' : (e && e.message ? e.message : 'network error');
            console.warn('[Sleepwalker Settings] Gemini ping note:', e && e.message ? e.message : e);
          }
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
        if (geminiErrNote) {
          statusBox.className = 'sw-ai-test-result sw-ai-test-error';
          statusBox.textContent = `⚠️ Gemini test failed (${geminiErrNote}); Ollama/Proxy also offline. Explain will use Offline Basic Summary.`;
        } else {
          statusBox.className = 'sw-ai-test-result sw-ai-test-info';
          statusBox.textContent = 'ℹ️ Cloud AI and Ollama offline. Explain will use the built-in Offline Basic Summary (0ms, 100% private).';
        }
      }
    }
  }

  window.SleepwalkerWidget = SleepwalkerWidget;
})();
