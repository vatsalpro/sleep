/**
 * Sleepwalker - mic-setup.js
 * CodeQuest National Tech Hackathon 2026
 *
 * Extension Onboarding & Microphone Verification:
 * 1. Requests audio input permission on the extension origin (getUserMedia).
 * 2. Visualizes live audio frequency/amplitude using Web Audio AnalyserNode.
 * 3. Tests Web Speech API recognition in English and Hindi.
 * 4. Enumerates connected microphone hardware devices.
 * 5. Saves setup completion state in chrome.storage.local.
 */

(function () {
  'use strict';

  let activeStream = null;
  let audioContext = null;
  let analyser = null;
  let animFrameId = null;
  let testRecognition = null;

  // DOM Elements
  const permBadge = document.getElementById('perm-badge');
  const btnRequestPerm = document.getElementById('btn-request-perm');
  const meterCard = document.getElementById('meter-card');
  const meterFill = document.getElementById('meter-fill');
  const meterDb = document.getElementById('meter-db');
  const btnTestRec = document.getElementById('btn-test-recognition');
  const selectTestLang = document.getElementById('select-test-lang');
  const testTranscript = document.getElementById('test-transcript');
  const devicesContainer = document.getElementById('devices-container');
  const btnDone = document.getElementById('btn-done');

  // Check initial permission state if Permissions API supported
  checkInitialPermission();

  async function checkInitialPermission() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: 'microphone' });
        updatePermissionBadge(status.state);
        status.onchange = () => updatePermissionBadge(status.state);
      }
    } catch (e) {
      console.log('[Sleepwalker Setup] Permissions query not supported for microphone');
    }
  }

  function updatePermissionBadge(state) {
    permBadge.className = 'status-badge';
    if (state === 'granted') {
      permBadge.classList.add('badge-granted');
      permBadge.textContent = 'Granted ✅';
      btnRequestPerm.textContent = '🎙️ Microphone Access Granted';
    } else if (state === 'denied') {
      permBadge.classList.add('badge-denied');
      permBadge.textContent = 'Denied ❌';
    } else {
      permBadge.classList.add('badge-pending');
      permBadge.textContent = 'Not Yet Granted';
    }
  }

  // Step 1: Request Microphone Access & Setup Audio Meter
  btnRequestPerm.addEventListener('click', async () => {
    try {
      btnRequestPerm.disabled = true;
      btnRequestPerm.textContent = 'Requesting access...';

      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      updatePermissionBadge('granted');

      // Persist status
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          sleepwalker_mic_setup_done: true,
          sleepwalker_mic_permission: 'granted'
        });
      }

      // Initialize live volume level meter
      startAudioMeter(activeStream);

      // Enumerate connected microphones
      await listAudioDevices();
    } catch (err) {
      console.warn('[Sleepwalker Setup] getUserMedia error:', err);
      updatePermissionBadge('denied');
      alert(`Microphone permission error: ${err.message}. Please click the lock/sliders icon in the address bar to allow microphone access.`);
      btnRequestPerm.disabled = false;
      btnRequestPerm.textContent = '🎙️ Retry Microphone Access';
    }
  });

  // Start live Web Audio Analyser meter
  function startAudioMeter(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      audioContext = new AudioCtx();
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      meterCard.style.display = 'block';

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function updateMeter() {
        analyser.getByteFrequencyData(dataArray);

        // Calculate average amplitude
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const percent = Math.min(100, Math.round((avg / 128) * 100));

        meterFill.style.width = `${percent}%`;

        if (percent > 15) {
          meterDb.textContent = `Speaking detected: ${percent}%`;
          meterDb.style.color = '#00E676';
        } else {
          meterDb.textContent = 'Speak into your mic to test level';
          meterDb.style.color = '#A0A0B0';
        }

        animFrameId = requestAnimationFrame(updateMeter);
      }

      updateMeter();
    } catch (e) {
      console.warn('[Sleepwalker Setup] Audio visualizer error:', e);
    }
  }

  // Step 2: Enumerate connected audio devices
  async function listAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');

      if (audioInputs.length === 0) {
        devicesContainer.innerHTML = '<p style="color: #FF5252;">No microphone inputs found.</p>';
        return;
      }

      let html = '<table class="device-table"><thead><tr><th>Microphone Name</th><th>Device ID</th></tr></thead><tbody>';
      audioInputs.forEach((dev, idx) => {
        const label = dev.label || `Microphone ${idx + 1} (Default)`;
        const idSnippet = dev.deviceId ? `${dev.deviceId.substring(0, 12)}...` : 'default';
        html += `<tr><td>🎤 ${label}</td><td><code>${idSnippet}</code></td></tr>`;
      });
      html += '</tbody></table>';

      devicesContainer.innerHTML = html;
    } catch (e) {
      devicesContainer.innerHTML = `<p style="color: #FF5252;">Could not enumerate devices: ${e.message}</p>`;
    }
  }

  // Step 3: Test Web Speech API recognition
  btnTestRec.addEventListener('click', () => {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      testTranscript.textContent = 'SpeechRecognition is not supported in this browser build.';
      testTranscript.classList.remove('empty');
      return;
    }

    if (testRecognition) {
      try { testRecognition.abort(); } catch (e) {}
    }

    testRecognition = new SpeechRec();
    testRecognition.lang = selectTestLang.value || 'en-IN';
    testRecognition.interimResults = true;
    testRecognition.continuous = false;

    btnTestRec.textContent = '🔴 Listening... Speak now';
    testTranscript.textContent = 'Listening... Say something like "Explain this page" or "नमस्ते"...';
    testTranscript.classList.remove('empty');

    testRecognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      testTranscript.textContent = final ? `Recognized: "${final}"` : `Listening: "${interim}"`;
    };

    testRecognition.onerror = (event) => {
      testTranscript.textContent = `Recognition error: ${event.error}`;
      btnTestRec.textContent = '🎤 Start Voice Test';
    };

    testRecognition.onend = () => {
      btnTestRec.textContent = '🎤 Start Voice Test';
      if (!testTranscript.textContent.startsWith('Recognized')) {
        testTranscript.textContent += ' (Voice test finished)';
      }
    };

    try {
      testRecognition.start();
    } catch (e) {
      testTranscript.textContent = `Could not start recognition: ${e.message}`;
      btnTestRec.textContent = '🎤 Start Voice Test';
    }
  });

  // Step 4: Done / Close Tab
  btnDone.addEventListener('click', () => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (activeStream) {
      activeStream.getTracks().forEach(t => t.stop());
    }
    if (audioContext) {
      audioContext.close();
    }
    window.close();
  });
})();
