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

      recognition.onstart = () => {
        isListening = true;
        console.log('[Sleepwalker Offscreen] Recognition started successfully');
        sendResponse({ status: 'started' });
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STATE_CHANGE', isListening: true });
      };

      recognition.onresult = (event) => {
        let interim = '';
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const t = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            final += t;
          } else {
            interim += t;
          }
        }

        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_TRANSCRIPT',
          interim: interim.trim(),
          final: final.trim()
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
