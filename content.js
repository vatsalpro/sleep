/**
 * Sleepwalker - content.js
 * CodeQuest National Tech Hackathon 2026
 *
 * Responsibilities:
 * 1. Ensure top-frame-only execution (never inject inside subframes or iframes).
 * 2. Initialize SleepwalkerWidget singleton (which boots the floating pill and glow inside Shadow DOM).
 * 3. Listen for toggle and unhide messages from background service worker.
 * 4. Handle in-page Alt+S keyboard shortcut to toggle side panel.
 * 5. Handle in-page Alt+Z Hold-to-Talk push-to-talk (keydown to listen, keyup to execute).
 *    (Note: As required by hackathon spec, page-level key listeners work while the webpage has focus).
 */

(function () {
  'use strict';

  // Wispr-Flow requirement: Top frame only (never in iframes)
  if (window !== window.top) {
    return;
  }

  if (window.__SLEEPWALKER_INITIALIZED__) {
    if (window.__SLEEPWALKER_INSTANCE__) {
      window.__SLEEPWALKER_INSTANCE__.toggle();
    }
    return;
  }

  window.__SLEEPWALKER_INITIALIZED__ = true;

  const widget = new window.SleepwalkerWidget();
  window.__SLEEPWALKER_INSTANCE__ = widget;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request) return;

    if (request.action === 'SLEEPWALKER_TOGGLE') {
      widget.toggle();
      sendResponse({ status: 'ok', isOpen: widget.isOpen });
    } else if (request.action === 'SLEEPWALKER_UNHIDE_PILL') {
      if (widget.pill) {
        widget.pill.unhideForThisSite();
      }
      sendResponse({ status: 'ok', isHidden: false });
    }
    return true;
  });

  let holdToTalkActive = false;

  // Keydown listener for Alt+S (toggle panel) and Alt+Z (start hold-to-talk)
  window.addEventListener('keydown', (e) => {
    // 1. Alt+S: Toggle assistant side panel
    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      widget.toggle();
      return;
    }

    // 2. Alt+Z: Hold-to-Talk (Hold to listen, release to run command)
    if (e.altKey && (e.key === 'z' || e.key === 'Z')) {
      if (e.repeat) return; // Ignore repeat events fired by OS while holding key
      e.preventDefault();
      holdToTalkActive = true;
      if (widget && widget.startHoldToTalk) {
        widget.startHoldToTalk();
      }
    }
  }, true);

  // Keyup listener: detect when Alt+Z is released to execute the voice command
  window.addEventListener('keyup', (e) => {
    if ((e.key === 'z' || e.key === 'Z') && holdToTalkActive) {
      e.preventDefault();
      holdToTalkActive = false;
      if (widget && widget.stopHoldToTalk) {
        widget.stopHoldToTalk();
      }
    }
  }, true);

  console.log('[Sleepwalker] Initialized successfully. Floating pill active; Alt+S toggles panel; Alt+Z for Hold-to-Talk.');
})();
