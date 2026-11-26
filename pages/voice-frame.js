/**
 * Sleepwalker - voice-frame.js
 * Tier 1 Extension-Origin Hidden Iframe Speech Bridge.
 * Runs Web Speech API under chrome-extension://<id> origin so per-site mic blocks
 * or ungranted site origins do not block Sleepwalker once extension mic access is granted.
 * If top-level page enforces Permissions-Policy: microphone=(), reports not-allowed
 * immediately so host escalates cleanly to Tier 2 (voice-relay popup).
 */
(function () {
  'use strict';

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let active = false;
  let intentionalStop = false;
  let currentLang = 'en-IN';
  let restartTimer = null;

  function postToHost(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'sleepwalker-voice-frame', ...payload }, '*');
      }
    } catch (_e) {}
  }

  function stopRec() {
    active = false;
    intentionalStop = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (recognition) {
      try { recognition.stop(); } catch (_e) {}
    }
  }

  function startRec(lang) {
    currentLang = lang || currentLang || 'en-IN';
    if (!SpeechRec) {
      postToHost({ kind: 'error', error: 'not-supported' });
      return;
    }
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    active = true;
    intentionalStop = false;

    if (recognition) {
      try {
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.abort();
      } catch (_e) {}
      recognition = null;
    }

    recognition = new SpeechRec();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 4;
    recognition.lang = currentLang;

    recognition.onstart = () => {
      postToHost({ kind: 'start' });
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';
      let conf = null;
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
          if (typeof alt.confidence === 'number') conf = alt.confidence;
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
      postToHost({
        kind: 'result',
        interim: interim.trim(),
        final: finalText.trim(),
        confidence: conf,
        alternatives
      });
    };

    recognition.onerror = (event) => {
      const code = (event && event.error) || 'unknown';
      if (code === 'no-speech') return;
      if (code === 'aborted' && intentionalStop) return;
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
        active = false;
      }
      postToHost({ kind: 'error', error: code });
    };

    recognition.onend = () => {
      if (active && !intentionalStop) {
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (active && !intentionalStop) startRec(currentLang);
        }, 140);
        return;
      }
      postToHost({ kind: 'end' });
    };

    try {
      recognition.start();
    } catch (err) {
      const name = (err && (err.name || err.message)) || 'unknown';
      if (/NotAllowed|Security/i.test(name)) {
        active = false;
        postToHost({ kind: 'error', error: 'not-allowed' });
      } else {
        postToHost({ kind: 'error', error: name });
      }
    }
  }

  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (!data || data.source !== 'sleepwalker-host-voice') return;
    if (data.action === 'START') {
      startRec(data.lang);
    } else if (data.action === 'STOP') {
      stopRec();
    } else if (data.action === 'SET_LANG') {
      currentLang = data.lang || 'en-IN';
      if (active && recognition) {
        startRec(currentLang);
      }
    }
  });

  postToHost({ kind: 'ready' });
})();
