/**
 * Sleepwalker - voice-relay.js
 * Tier 2 Top-Level Extension Voice Relay (chrome-extension://<id>/pages/voice-relay.html).
 * Completely independent of any website's Permissions-Policy: microphone=() header or http:// origin.
 * Streams live interim & final transcripts to the active browser tab via background.js.
 */
(function () {
  'use strict';

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const dotEl = document.getElementById('dot');
  const statusEl = document.getElementById('status');
  const transcriptEl = document.getElementById('transcript');
  const allowBtn = document.getElementById('allow-btn');

  const params = new URLSearchParams(window.location.search);
  let currentLang = params.get('lang') || 'en-IN';
  let recognition = null;
  let shouldListen = true;
  let paused = false;
  let restartTimer = null;

  function setUi(mode, title, sub, showAllow = false) {
    if (dotEl) {
      dotEl.className = 'dot' + (mode === 'paused' ? ' paused' : (mode === 'error' ? ' error' : ''));
    }
    if (statusEl && title) statusEl.textContent = title;
    if (transcriptEl && sub !== undefined) transcriptEl.textContent = sub;
    if (allowBtn) allowBtn.hidden = !showAllow;
  }

  function stopRecognitionInternal() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (recognition) {
      try {
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.stop();
      } catch (_e) {}
      recognition = null;
    }
  }

  function startRecognition() {
    if (!SpeechRec) {
      setUi('error', 'Speech Unavailable', 'Web Speech API not supported in this browser.');
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: 'not-supported', message: 'Web Speech not supported' });
      return;
    }
    stopRecognitionInternal();
    shouldListen = true;
    paused = false;

    recognition = new SpeechRec();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 4;
    recognition.lang = currentLang;

    recognition.onstart = () => {
      setUi('listening', 'Sleepwalker Mic Active', 'Speak anytime — relaying to active tab...');
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STATE_CHANGE', isListening: true });
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';
      let confidence = null;
      const finalSegs = [];
      const interimSegs = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const alt = res && res[0];
        if (!alt) continue;
        const segAlts = [];
        const len = Math.min(4, Number(res.length) || 1);
        for (let k = 0; k < len; k++) {
          if (res[k] && res[k].transcript) {
            segAlts.push({ transcript: String(res[k].transcript), confidence: typeof res[k].confidence === 'number' ? res[k].confidence : null });
          }
        }
        if (res.isFinal) {
          finalText += alt.transcript || '';
          if (typeof alt.confidence === 'number') confidence = alt.confidence;
          if (segAlts.length > 0) finalSegs.push(segAlts);
        } else {
          interim += alt.transcript || '';
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
      const preview = (finalText || interim).trim();
      if (preview) {
        setUi('listening', 'Sleepwalker Mic Active', `"${preview}"`);
      }
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_TRANSCRIPT',
        interim: interim.trim(),
        final: finalText.trim(),
        confidence,
        alternatives
      });
    };

    recognition.onerror = (event) => {
      const err = (event && event.error) || 'unknown';
      if (err === 'no-speech' || (err === 'aborted' && (!shouldListen || paused))) return;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        shouldListen = false;
        setUi('error', 'Microphone Permission Needed', 'Click Allow Microphone once for Sleepwalker.', true);
        return;
      }
      if (err === 'audio-capture') {
        shouldListen = false;
        setUi('error', 'No Microphone Found', 'Connect a microphone and retry.', true);
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: err, message: 'No microphone found' });
      }
    };

    recognition.onend = () => {
      if (shouldListen && !paused) {
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (shouldListen && !paused) startRecognition();
        }, 150);
        return;
      }
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STATE_CHANGE', isListening: false });
    };

    try {
      recognition.start();
    } catch (_e) {
      setUi('error', 'Microphone Permission Needed', 'Click Allow Microphone once for Sleepwalker.', true);
    }
  }

  if (allowBtn) {
    allowBtn.addEventListener('click', async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_e) {} });
        if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ sleepwalker_mic_setup_done: true, sleepwalker_mic_permission: 'granted' });
        }
        startRecognition();
      } catch (err) {
        setUi('error', 'Permission Blocked', (err && err.message) || 'Allow mic in Chrome address bar icon.', true);
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'EXT_RELAY_CONTROL') return false;
    if (msg.lang) currentLang = msg.lang;
    if (msg.action === 'START' || msg.action === 'RESUME') {
      paused = false;
      shouldListen = true;
      startRecognition();
      sendResponse({ ok: true, status: 'started' });
    } else if (msg.action === 'PAUSE') {
      paused = true;
      stopRecognitionInternal();
      setUi('paused', 'Sleepwalker Speaking...', 'Mic paused while speaking');
      sendResponse({ ok: true, status: 'paused' });
    } else if (msg.action === 'STOP') {
      shouldListen = false;
      paused = false;
      stopRecognitionInternal();
      setUi('paused', 'Sleepwalker Mic Idle', 'Waiting...');
      sendResponse({ ok: true, status: 'stopped' });
    } else if (msg.action === 'SET_LANG') {
      if (shouldListen && !paused) startRecognition();
      sendResponse({ ok: true });
    }
    return false;
  });

  startRecognition();
})();
