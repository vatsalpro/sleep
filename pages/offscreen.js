/**
 * Sleepwalker - offscreen.js
 * CodeQuest National Tech Hackathon 2026
 *
 * Evaluation of chrome.offscreen (reason: USER_MEDIA) for speech recognition.
 *
 * Responsibilities:
 * 1. Checks if webkitSpeechRecognition is supported in offscreen contexts.
 * 2. Attempts to run speech recognition using the extension's audio permissions.
 * 3. Reports transcript updates and exact error codes back to service worker.
 * 4. Enables honest evaluation of Chromium's offscreen speech recognition capabilities.
 */

(function () {
  'use strict';

  let recognition = null;
  let isListening = false;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  console.log('[Sleepwalker Offscreen] Initialized. SpeechRecognition available:', Boolean(SpeechRec));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    if (message.type === 'START_OFFSCREEN_SPEECH_RECOGNITION') {
      startOffscreenRecognition(message.lang || 'en-IN', sendResponse);
      return true; // Keep port open for async response
    }

    if (message.type === 'STOP_OFFSCREEN_SPEECH_RECOGNITION') {
      stopOffscreenRecognition(sendResponse);
      return true;
    }

    if (message.type === 'CHECK_OFFSCREEN_SUPPORT') {
      sendResponse({
        isSupported: Boolean(SpeechRec),
        userAgent: navigator.userAgent
      });
      return false;
    }
  });

  function startOffscreenRecognition(lang, sendResponse) {
    if (!SpeechRec) {
      console.warn('[Sleepwalker Offscreen] SpeechRecognition is undefined in this offscreen context.');
      sendResponse({
        status: 'unsupported',
        reason: 'SpeechRecognition API is not available in Chromium offscreen documents'
      });
      return;
    }

    try {
      if (recognition) {
        try { recognition.abort(); } catch (e) {}
      }

      recognition = new SpeechRec();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 4;

      recognition.onstart = () => {
        isListening = true;
        console.log('[Sleepwalker Offscreen] Recognition started successfully');
        sendResponse({ status: 'started' });
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STATE_CHANGE', isListening: true });
      };

      recognition.onresult = (event) => {
        let interim = '';
        let final = '';
        const finalSegs = [];
        const interimSegs = [];
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const res = event.results[i];
          const t = res[0].transcript;
          const segAlts = [];
          const len = Math.min(4, Number(res.length) || 1);
          for (let k = 0; k < len; k++) {
            if (res[k] && res[k].transcript) {
              segAlts.push({ transcript: String(res[k].transcript), confidence: typeof res[k].confidence === 'number' ? res[k].confidence : null });
            }
          }
          if (res.isFinal) {
            final += t;
            if (segAlts.length > 0) finalSegs.push(segAlts);
          } else {
            interim += t;
            if (segAlts.length > 0) interimSegs.push(segAlts);
          }
        }
        const activeSegs = finalSegs.length > 0 ? finalSegs : interimSegs;
        const alternatives = [];
        if (activeSegs.length > 0) {
          const maxK = Math.min(4, Math.max(...activeSegs.map((s) => s.length)));
          const seen = new Set();
          for (let k = 0; k < maxK; k++) {
            const joined = activeSegs.map((s) => s[Math.min(k, s.length - 1)].transcript).join('').trim();
            const norm = joined.toLowerCase().replace(/\s+/g, ' ');
            if (joined && !seen.has(norm)) {
              seen.add(norm);
              alternatives.push({ transcript: joined, confidence: activeSegs[0][Math.min(k, activeSegs[0].length - 1)].confidence, rank: k });
            }
          }
        }

        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_TRANSCRIPT',
          interim: interim.trim(),
          final: final.trim(),
          alternatives
        });
      };

      recognition.onerror = (event) => {
        console.warn('[Sleepwalker Offscreen] Recognition error in offscreen document:', event.error);
        isListening = false;
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_ERROR',
          error: event.error,
          message: `Offscreen recognition failed (${event.error})`
        });
      };

      recognition.onend = () => {
        isListening = false;
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STATE_CHANGE', isListening: false });
      };

      recognition.start();
    } catch (err) {
      console.warn('[Sleepwalker Offscreen] Exception starting recognition:', err);
      sendResponse({
        status: 'error',
        error: err.name,
        message: err.message
      });
    }
  }

  function stopOffscreenRecognition(sendResponse) {
    if (recognition && isListening) {
      try {
        recognition.stop();
      } catch (e) {}
    }
    isListening = false;
    sendResponse({ status: 'stopped' });
  }
})();
