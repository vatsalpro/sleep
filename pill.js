/**
 * Sleepwalker - pill.js
 * CodeQuest National Tech Hackathon 2026
 *
 * Responsibilities (Phase 2):
 * 1. Render an always-available floating round pill (~56px) inside the Shadow DOM.
 * 2. Visual state machine:
 *    - 'idle': mic icon, clean border.
 *    - 'listening': pulsing ring + transcript bubble.
 *    - 'preparing': animated equalizer bars (amber).
 *    - 'speaking': animated equalizer bars (green) + Stop button.
 *    - 'error': red outline + auto-hiding error message bubble (~6s timer).
 * 3. Companion bubble with:
 *    - Live status/result text ("6 sections found", "Reading: Fees").
 *    - Compact typed-command input ("read fees", "outline", "help", "pause", "resume", "stop").
 *    - Quick "Explain" button.
 *    - Prominent Stop button when speaking.
 *    - Expand button to open the full side panel.
 * 4. Keyboard support: Escape cancels any active reading/action and returns to idle.
 * 5. Viewport-clamped dragging and per-hostname hiding persisted in chrome.storage.local.
 */

(function () {
  'use strict';

  if (window.SleepwalkerPill) return;

  class SleepwalkerPill {
    /**
     * @param {Object} options
     * @param {ShadowRoot} options.shadowRoot - The extension's Shadow DOM root.
     * @param {SleepwalkerWidget} options.widget - The main widget controller instance.
     */
    constructor(options = {}) {
      this.shadowRoot = options.shadowRoot;
      this.widget = options.widget;

      // DOM Elements
      this.container = null;
      this.pillBtn = null;
      this.bubble = null;
      this.statusText = null;
      this.stopBtn = null;
      this.explainBtn = null;
      this.expandBtn = null;
      this.hideBtn = null;
      this.typedForm = null;
      this.typedInput = null;

      // State
      this.state = 'idle'; // 'idle', 'listening', 'preparing', 'speaking', 'error'
      this._errorTimeout = null;
      this.isDragging = false;
      this.dragMoved = false;
      this.startX = 0;
      this.startY = 0;
      this.startLeft = 0;
      this.startTop = 0;
      this.currentLeft = null;
      this.currentTop = null;
      this.isSiteHidden = false;
      this.hostname = window.location.hostname || 'local';

      this.init();
    }

    /**
     * Initialize pill UI, load stored state, and bind events.
     */
    async init() {
      // 1. Check if the user previously hid Sleepwalker for this hostname
      await this.checkSiteHidden();

      // 2. Render pill markup inside the shared Shadow Root
      this.render();

      // 3. Restore persisted position (or default to bottom-right)
      await this.restorePosition();

      // 4. Attach drag, click, and keyboard listeners
      this.bindEvents();

      // 5. If hidden for this site, apply initial hidden state
      if (this.isSiteHidden) {
        this.container.style.display = 'none';
      }
    }

    /**
     * Query chrome.storage.local for the list of hidden hostnames.
     */
    async checkSiteHidden() {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        return;
      }
      return new Promise((resolve) => {
        chrome.storage.local.get(['sleepwalker_hidden_sites'], (data) => {
          const sites = data.sleepwalker_hidden_sites || [];
          this.isSiteHidden = sites.includes(this.hostname);
          resolve(this.isSiteHidden);
        });
      });
    }

    /**
     * Render the pill and companion bubble inside the Shadow DOM.
     */
    render() {
      if (!this.shadowRoot) return;

      const container = document.createElement('div');
      container.id = 'sw-pill-container';
      container.className = 'sw-pill-container';
      container.style.right = '24px';
      container.style.bottom = '24px';
      container.setAttribute('role', 'region');
      container.setAttribute('aria-label', 'Sleepwalker Quick Assistant');

      container.innerHTML = `
        <!-- Companion Result & Quick Action Bubble -->
        <div id="sw-pill-bubble" class="sw-pill-bubble" role="dialog" aria-label="Sleepwalker Quick Controls">
          <div class="sw-pill-bubble-header">
            <span class="sw-pill-bubble-title">🌙 Sleepwalker</span>
            <button type="button" id="sw-pill-hide-btn" class="sw-pill-icon-btn" title="Hide on ${this.hostname}" aria-label="Hide Sleepwalker on this website">✕</button>
          </div>

          <!-- Live Status / Result Announcement -->
          <div id="sw-pill-status" class="sw-pill-status-text" role="status" aria-live="polite">
            Ready • Type or speak a command
          </div>

          <!-- Stop Button (Visible during speech or preparing) -->
          <button type="button" id="sw-pill-btn-stop" class="sw-pill-stop-btn" style="display:none;" aria-label="Stop reading aloud">
            ⏹️ Stop Reading
          </button>

          <!-- Quick Action Buttons -->
          <div class="sw-pill-actions">
            <button type="button" id="sw-pill-btn-explain" class="sw-pill-action-btn sw-pill-btn-explain" title="Explain this page in simple words" aria-label="Explain this page">
              💡 Explain
            </button>
            <button type="button" id="sw-pill-expand-btn" class="sw-pill-action-btn sw-pill-btn-expand" title="Open full assistant panel" aria-label="Open full assistant side panel (Alt+S)">
              ⛶ Full Panel
            </button>
          </div>

          <!-- Compact Typed Command Input Form -->
          <form id="sw-pill-typed-form" class="sw-pill-typed-form" aria-label="Quick Command Input">
            <input type="text" id="sw-pill-typed-input" class="sw-pill-input" placeholder="Type command (e.g. read fees, help)" aria-label="Type a command" />
            <button type="submit" id="sw-pill-typed-submit" class="sw-pill-btn-submit" aria-label="Execute command">Go</button>
          </form>
        </div>

        <!-- Floating Round Pill Button (~56px) -->
        <button type="button" id="sw-pill-btn" class="sw-pill-btn sw-state-idle" aria-label="Sleepwalker Voice Assistant Pill" title="Sleepwalker Assistant (Click to open, drag to move)">
          <!-- Idle Icon -->
          <span id="sw-pill-icon" class="sw-pill-icon" aria-hidden="true">🎙️</span>

          <!-- Animated Sound Equalizer Bars (Preparing & Speaking) -->
          <div id="sw-pill-bars" class="sw-pill-bars" aria-hidden="true">
            <span class="sw-bar sw-bar-1"></span>
            <span class="sw-bar sw-bar-2"></span>
            <span class="sw-bar sw-bar-3"></span>
            <span class="sw-bar sw-bar-4"></span>
          </div>

          <!-- Listening Pulse Ring -->
          <span class="sw-pill-pulse-ring" aria-hidden="true"></span>
        </button>
      `;

      this.shadowRoot.appendChild(container);

      // Cache DOM references
      this.container = container;
      this.pillBtn = container.querySelector('#sw-pill-btn');
      this.bubble = container.querySelector('#sw-pill-bubble');
      this.statusText = container.querySelector('#sw-pill-status');
      this.stopBtn = container.querySelector('#sw-pill-btn-stop');
      this.explainBtn = container.querySelector('#sw-pill-btn-explain');
      this.expandBtn = container.querySelector('#sw-pill-expand-btn');
      this.hideBtn = container.querySelector('#sw-pill-hide-btn');
      this.typedForm = container.querySelector('#sw-pill-typed-form');
      this.typedInput = container.querySelector('#sw-pill-typed-input');
    }

    /**
     * Restore saved (left, top) coordinates from storage or position at bottom-right.
     */
    async restorePosition() {
      if (!this.container) return;

      const defaultRight = 24;
      const defaultBottom = 24;
      const pillSize = 56;

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['sleepwalker_pill_pos'], (data) => {
          const pos = data.sleepwalker_pill_pos;
          if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
            const maxLeft = Math.max(10, window.innerWidth - pillSize - 10);
            const maxTop = Math.max(10, window.innerHeight - pillSize - 10);
            const left = Math.min(Math.max(10, pos.left), maxLeft);
            const top = Math.min(Math.max(10, pos.top), maxTop);

            this.currentLeft = left;
            this.currentTop = top;
            this.container.style.left = `${left}px`;
            this.container.style.top = `${top}px`;
            this.container.style.right = 'auto';
            this.container.style.bottom = 'auto';
            return;
          }

          this.container.style.right = `${defaultRight}px`;
          this.container.style.bottom = `${defaultBottom}px`;
          this.container.style.left = 'auto';
          this.container.style.top = 'auto';
        });
      } else {
        this.container.style.right = `${defaultRight}px`;
        this.container.style.bottom = `${defaultBottom}px`;
      }
    }

    /**
     * Save current pill position to chrome.storage.local.
     */
    savePosition(left, top) {
      this.currentLeft = left;
      this.currentTop = top;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          sleepwalker_pill_pos: { left, top }
        });
      }
    }

    /**
     * Hide pill for current hostname and persist in storage.
     */
    hideForThisSite() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['sleepwalker_hidden_sites'], (data) => {
          const sites = data.sleepwalker_hidden_sites || [];
          if (!sites.includes(this.hostname)) {
            sites.push(this.hostname);
            chrome.storage.local.set({ sleepwalker_hidden_sites: sites });
          }
        });
      }

      this.isSiteHidden = true;
      this.container.style.display = 'none';

      console.log(`[Sleepwalker] Pill hidden on ${this.hostname}. Press Alt+S anytime to open the assistant.`);
      if (this.widget && this.widget.setAssistantReply) {
        this.widget.setAssistantReply(`Pill hidden for ${this.hostname}. Press Alt+S or click the toolbar icon to reopen.`);
      }
    }

    /**
     * Unhide pill for current hostname.
     */
    unhideForThisSite() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['sleepwalker_hidden_sites'], (data) => {
          let sites = data.sleepwalker_hidden_sites || [];
          sites = sites.filter(s => s !== this.hostname);
          chrome.storage.local.set({ sleepwalker_hidden_sites: sites });
        });
      }

      this.isSiteHidden = false;
      if (this.container) {
        this.container.style.display = 'flex';
      }
      console.log(`[Sleepwalker] Pill restored on ${this.hostname}.`);
    }

    /**
     * Bind dragging, clicking, keyboard shortcuts, and typed-command handlers.
     */
    bindEvents() {
      if (!this.pillBtn) return;

      // 1. Mouse Drag Handlers
      const onMouseDown = (e) => {
        if (e.button !== 0) return;

        this.isDragging = true;
        this.dragMoved = false;
        this.startX = e.clientX;
        this.startY = e.clientY;

        const rect = this.container.getBoundingClientRect();
        this.startLeft = rect.left;
        this.startTop = rect.top;

        this.container.classList.add('sw-dragging');

        window.addEventListener('mousemove', onMouseMove, { passive: false });
        window.addEventListener('mouseup', onMouseUp, { passive: false });
        e.preventDefault();
      };

      const onMouseMove = (e) => {
        if (!this.isDragging) return;

        const dx = e.clientX - this.startX;
        const dy = e.clientY - this.startY;

        if (!this.dragMoved && Math.hypot(dx, dy) > 5) {
          this.dragMoved = true;
        }

        if (this.dragMoved) {
          const pillWidth = 56;
          const pillHeight = 56;
          const maxLeft = Math.max(10, window.innerWidth - pillWidth - 10);
          const maxTop = Math.max(10, window.innerHeight - pillHeight - 10);

          let newLeft = this.startLeft + dx;
          let newTop = this.startTop + dy;

          newLeft = Math.min(Math.max(10, newLeft), maxLeft);
          newTop = Math.min(Math.max(10, newTop), maxTop);

          this.container.style.left = `${newLeft}px`;
          this.container.style.top = `${newTop}px`;
          this.container.style.right = 'auto';
          this.container.style.bottom = 'auto';

          this.currentLeft = newLeft;
          this.currentTop = newTop;
        }
      };

      const onMouseUp = () => {
        if (!this.isDragging) return;

        this.isDragging = false;
        this.container.classList.remove('sw-dragging');

        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);

        if (this.dragMoved && this.currentLeft !== null && this.currentTop !== null) {
          this.savePosition(this.currentLeft, this.currentTop);
        }
      };

      this.pillBtn.addEventListener('mousedown', onMouseDown);

      // 2. Pill Button Click: Click-to-Talk or Fast Stop
      this.pillBtn.addEventListener('click', (e) => {
        if (this.dragMoved) {
          e.stopPropagation();
          return;
        }

        // If speaking, clicking the pill acts as a fast stop toggle
        if (this.state === 'speaking') {
          this.stop();
          return;
        }

        // If listening, clicking the pill stops listening and executes current transcript
        if (this.state === 'listening') {
          if (this.widget && this.widget.voice) {
            this.widget.voice.stopListeningAndCommit();
          }
          return;
        }

        // If idle: Click-to-Talk starts voice listening immediately with transcript bubble!
        if (this.widget && this.widget.startVoiceListening) {
          this.widget.startVoiceListening();
        } else {
          this.toggleBubble();
        }
      });

      // 3. Stop Button Click
      if (this.stopBtn) {
        this.stopBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.stop();
        });
      }

      // 4. Quick "Explain" Button Click
      if (this.explainBtn) {
        this.explainBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handleTypedCommand('explain this page');
        });
      }

      // 5. Expand Button: Open full Sleepwalker side panel
      if (this.expandBtn) {
        this.expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.widget) {
            this.widget.open();
          }
        });
      }

      // 6. Hide Button: Hide pill on current website
      if (this.hideBtn) {
        this.hideBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hideForThisSite();
        });
      }

      // 7. Typed Command Form Submission
      if (this.typedForm) {
        this.typedForm.addEventListener('submit', (e) => {
          e.preventDefault();
          const text = (this.typedInput ? this.typedInput.value : '').trim();
          if (!text) return;
          this.typedInput.value = '';
          this.handleTypedCommand(text);
        });
      }

      // 8. Viewport Resize Protection
      window.addEventListener('resize', () => {
        if (this.currentLeft !== null && this.currentTop !== null) {
          const pillSize = 56;
          const maxLeft = Math.max(10, window.innerWidth - pillSize - 10);
          const maxTop = Math.max(10, window.innerHeight - pillSize - 10);
          const left = Math.min(Math.max(10, this.currentLeft), maxLeft);
          const top = Math.min(Math.max(10, this.currentTop), maxTop);
          this.container.style.left = `${left}px`;
          this.container.style.top = `${top}px`;
        }
      });

      // 9. Keyboard Escape Key (Cancels, Stops Speech, Closes Bubble, Fades Glow)
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (this.widget && this.widget.reader && this.widget.reader.isPlaying) {
            this.widget.reader.stop();
          }
          if (this.widget && this.widget.voice && this.widget.voice.isListening) {
            this.widget.voice.stopListening();
          }
          if (this.widget && this.widget.glow) {
            this.widget.glow.setOff();
          }
          this.setIdle('Action cancelled.');
          this.closeBubble();
        }
      });
    }

    /**
     * Dispatch typed commands through voice.js command parser to the widget controller.
     * @param {string} text - User command string.
     */
    handleTypedCommand(text) {
      if (!this.widget) return;

      const voiceParser = this.widget.voice;
      const cmd = voiceParser ? voiceParser.parseCommand(text) : { type: 'UNKNOWN', raw: text };

      console.log('[Sleepwalker Pill] Handling typed command:', cmd);

      switch (cmd.type) {
        case 'STOP':
          this.stop();
          break;

        case 'PAUSE':
          if (this.widget.reader) {
            this.widget.reader.pause();
          }
          this.setStatus('Reading paused. Press Resume or Stop.');
          break;

        case 'RESUME':
          if (this.widget.reader) {
            this.widget.reader.resume();
          }
          this.setSpeaking('Resuming reading...');
          break;

        case 'READ_PAGE':
          this.setPreparing('Extracting page content...');
          this.widget.readPage();
          break;

        case 'OUTLINE':
          this.widget.showOutline();
          break;

        case 'READ_SECTION':
        case 'QUERY_OR_SEARCH':
          if (cmd.sectionQuery) {
            this.setPreparing(`Looking for section: "${cmd.sectionQuery}"...`);
            this.widget.readSection(cmd.sectionQuery);
          } else {
            this.setError('Please specify a section name to read.');
          }
          break;

        case 'EXPLAIN':
        case 'EXPLAIN_SECTION':
          this.setPreparing(cmd.sectionQuery ? `Analyzing "${cmd.sectionQuery}"...` : 'Analyzing page content...');
          this.widget.explainPage(cmd.sectionQuery);
          break;

        case 'READ_AGAIN':
          this.setPreparing('Restarting from beginning...');
          if (this.widget.reader) {
            this.widget.reader.readAgain();
          }
          break;

        case 'HELP':
          this.setStatus('Commands: read this page, outline, read <section>, pause, resume, stop, explain.');
          break;

        default:
          this.setError(`Command not recognized: "${text}". Say "help" for options.`);
          break;
      }
    }

    /**
     * Stop active reading and reset state.
     */
    stop() {
      if (this.widget && this.widget.reader) {
        this.widget.reader.stop();
      }
      if (this.widget && this.widget.voice && this.widget.voice.isListening) {
        this.widget.voice.stopListening();
      }
      if (this.widget && this.widget.glow) {
        this.widget.glow.setOff();
      }
      this.setIdle('Stopped.');
    }

    /**
     * Visual State Transition: IDLE
     */
    setIdle(message = 'Ready • Type or speak a command') {
      if (this._errorTimeout) {
        clearTimeout(this._errorTimeout);
        this._errorTimeout = null;
      }
      this.state = 'idle';
      this.setState('idle');
      this.setStatus(message);
      if (this.stopBtn) {
        this.stopBtn.style.display = 'none';
      }
    }

    /**
     * Visual State Transition: LISTENING
     */
    setListening(transcript = '') {
      if (this._errorTimeout) {
        clearTimeout(this._errorTimeout);
        this._errorTimeout = null;
      }
      this.state = 'listening';
      this.setState('listening');
      this.setStatus(transcript ? `"${transcript}"` : 'Listening... Speak now');
      this.openBubble();
    }

    /**
     * Visual State Transition: PREPARING (animated sound bars, amber)
     */
    setPreparing(message = 'Processing command...') {
      if (this._errorTimeout) {
        clearTimeout(this._errorTimeout);
        this._errorTimeout = null;
      }
      this.state = 'preparing';
      this.setState('preparing');
      this.setStatus(message);
      if (this.stopBtn) {
        this.stopBtn.style.display = 'flex';
      }
      this.openBubble();
    }

    /**
     * Visual State Transition: SPEAKING (animated sound bars, green + stop button)
     */
    setSpeaking(message = 'Reading aloud...') {
      if (this._errorTimeout) {
        clearTimeout(this._errorTimeout);
        this._errorTimeout = null;
      }
      this.state = 'speaking';
      this.setState('speaking');
      if (message) {
        this.setStatus(message);
      }
      if (this.stopBtn) {
        this.stopBtn.style.display = 'flex';
      }
      this.openBubble();
    }

    /**
     * Visual State Transition: ERROR (red outline + 6s auto-fade)
     */
    setError(errorMessage) {
      if (this._errorTimeout) {
        clearTimeout(this._errorTimeout);
        this._errorTimeout = null;
      }
      this.state = 'error';
      this.setState('error');
      this.setStatus(`⚠️ ${errorMessage}`);
      if (this.stopBtn) {
        this.stopBtn.style.display = 'none';
      }
      if (this.widget && this.widget.glow) {
        this.widget.glow.setError();
      }
      this.openBubble();

      // Auto-hide error state after ~6 seconds
      this._errorTimeout = setTimeout(() => {
        if (this.state === 'error') {
          this.setIdle();
          this.closeBubble();
        }
      }, 6000);
    }

    /**
     * Update visual class on pill button.
     * @param {'idle'|'listening'|'preparing'|'speaking'|'error'} stateName
     */
    setState(stateName) {
      if (!this.pillBtn) return;
      this.state = stateName;
      this.pillBtn.className = `sw-pill-btn sw-state-${stateName}`;

      const icon = this.container.querySelector('#sw-pill-icon');
      if (icon) {
        if (stateName === 'error') {
          icon.textContent = '⚠️';
        } else if (stateName === 'listening') {
          icon.textContent = '🔴';
        } else {
          icon.textContent = '🎙️';
        }
      }
    }

    /**
     * Update companion bubble text.
     * @param {string} text
     */
    setStatus(text) {
      if (this.statusText) {
        this.statusText.textContent = text;
      }
    }

    toggleBubble() {
      if (this.bubble.classList.contains('sw-bubble-open')) {
        this.closeBubble();
      } else {
        this.openBubble();
      }
    }

    openBubble() {
      this.bubble.classList.add('sw-bubble-open');
    }

    closeBubble() {
      this.bubble.classList.remove('sw-bubble-open');
    }
  }

  window.SleepwalkerPill = SleepwalkerPill;
})();
