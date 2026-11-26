/**
 * Sleepwalker - options.js (Phase P5)
 * Extension options page controller (options_ui open_in_tab).
 * Persists AI cascade settings, glow/barge-in/voice prefs & non-sensitive profile to chrome.storage.local.
 */
(function () {
  'use strict';

  const SENSITIVE_RE = /\b(?:password|passwd|pwd|otp|pin\b(?!code)|upi|cvv|cvc|card|aadhaar|aadhar|pan|bank|ifsc|secret|captcha)\b/i;
  const APPROVED_MODELS = new Set(['qwen2.5:1.5b', 'llama3.2:3b', 'qwen3-vl:2b', 'nomic-embed-text:latest']);
  const byId = (id) => document.getElementById(id);

  function normalizeApprovedModel(raw) {
    const clean = String(raw || '').trim();
    if (!clean) return 'llama3.2:3b';
    if (clean === 'nomic-embed-text') return 'nomic-embed-text:latest';
    return APPROVED_MODELS.has(clean) ? clean : null;
  }

  function sanitizeProfile(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const k of ['fullName', 'email', 'phone', 'city', 'state', 'pincode']) {
      const val = String(src[k] || '').trim();
      if (val && !SENSITIVE_RE.test(val)) out[k] = val.slice(0, 120);
    }
    return out;
  }

  function loadAll() {
    const keys = [
      'sleepwalker_proxy_url', 'sleepwalker_ollama_url', 'sleepwalker_ollama_model',
      'sleepwalker_gemini_model', 'sleepwalker_gemini_api_key', 'sleepwalker_local_only',
      'sleepwalker_ai_search_enabled', 'sleepwalker_live_ws',
      'sleepwalker_memory_paused', 'sleepwalker_disable_page_analysis',
      'sleepwalker_adaptive_learning_enabled', 'sleepwalker_proactive_enabled',
      'sleepwalker_lang', 'sleepwalker_rate', 'sleepwalker_font_size',
      'sleepwalker_voice_persona', 'sleepwalker_voice_uri',
      'sleepwalker_glow_enabled', 'sleepwalker_barge_in', 'sleepwalker_translit',
      'sleepwalker_profile_optin', 'sleepwalker_local_profile',
      'sleepwalker_enable_stagehand_adapter',
      'sleepwalker_use_rebuilt_browser_engine'
    ];
    chrome.storage.local.get(keys, (d) => {
      byId('opt-proxy-url').value = d.sleepwalker_proxy_url || '';
      byId('opt-ollama-url').value = d.sleepwalker_ollama_url || 'http://localhost:11434';
      byId('opt-ollama-model').value = normalizeApprovedModel(d.sleepwalker_ollama_model) || 'llama3.2:3b';
      byId('opt-gemini-model').value = d.sleepwalker_gemini_model || 'gemini-flash-latest';
      byId('opt-gemini-key').value = d.sleepwalker_gemini_api_key || '';
      if (byId('opt-ai-search-enabled')) {
        byId('opt-ai-search-enabled').checked = d.sleepwalker_ai_search_enabled !== false;
      }
      if (byId('opt-live-ws')) {
        byId('opt-live-ws').checked = Boolean(d.sleepwalker_live_ws);
      }
      if (byId('opt-memory-paused')) {
        byId('opt-memory-paused').checked = Boolean(d.sleepwalker_memory_paused);
      }
      if (byId('opt-disable-page-analysis')) {
        byId('opt-disable-page-analysis').checked = Boolean(d.sleepwalker_disable_page_analysis);
      }
      if (byId('opt-learning-enabled')) {
        byId('opt-learning-enabled').checked = d.sleepwalker_adaptive_learning_enabled !== false;
      }
      if (byId('opt-proactive-enabled')) {
        byId('opt-proactive-enabled').checked = d.sleepwalker_proactive_enabled !== false;
      }
      byId('opt-local-only').checked = d.sleepwalker_local_only !== false;
      if (byId('opt-stagehand-enabled')) {
        byId('opt-stagehand-enabled').checked = d.sleepwalker_enable_stagehand_adapter !== false;
      }
      if (byId('opt-rebuilt-browser-engine')) {
        byId('opt-rebuilt-browser-engine').checked = Boolean(d.sleepwalker_use_rebuilt_browser_engine === true);
      }
      byId('opt-lang').value = d.sleepwalker_lang || 'auto';
      byId('opt-rate').value = String(d.sleepwalker_rate || 1);
      byId('opt-font-size').value = String(d.sleepwalker_font_size || 18);
      if (byId('opt-voice-persona')) {
        byId('opt-voice-persona').value = d.sleepwalker_voice_persona || 'nova';
      }
      populateVoiceSelect(d.sleepwalker_voice_uri || '');
      byId('opt-glow-enabled').checked = d.sleepwalker_glow_enabled !== false;
      byId('opt-barge-in').checked = Boolean(d.sleepwalker_barge_in);
      byId('opt-translit').checked = d.sleepwalker_translit !== false;
      byId('opt-profile-optin').checked = Boolean(d.sleepwalker_profile_optin);
      const p = sanitizeProfile(d.sleepwalker_local_profile);
      byId('prof-name').value = p.fullName || '';
      byId('prof-email').value = p.email || '';
      byId('prof-phone').value = p.phone || '';
      byId('prof-city').value = p.city || '';
      byId('prof-state').value = p.state || '';
      byId('prof-pin').value = p.pincode || '';
    });
  }

  function populateVoiceSelect(selectedUri = '') {
    const sel = byId('opt-voice-uri');
    if (!sel || !('speechSynthesis' in window)) return;
    const render = () => {
      const voices = window.speechSynthesis.getVoices() || [];
      const curVal = selectedUri || sel.value || '';
      sel.innerHTML = '<option value="">Auto (Best Neural / Natural Match)</option>';
      const sorted = voices.slice().sort((a, b) => {
        const aNeural = /\b(?:natural|neural|online|google)\b/i.test(a.name || '') ? 0 : 1;
        const bNeural = /\b(?:natural|neural|online|google)\b/i.test(b.name || '') ? 0 : 1;
        if (aNeural !== bNeural) return aNeural - bNeural;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
      sorted.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.voiceURI || v.name;
        const tag = /\b(?:natural|neural|online|google)\b/i.test(v.name || '') ? ' ★' : '';
        opt.textContent = `${v.name} (${v.lang || 'default'})${tag}`;
        sel.appendChild(opt);
      });
      if (curVal) sel.value = curVal;
    };
    render();
    if (!window.__swOptVoicesBound) {
      window.__swOptVoicesBound = true;
      window.speechSynthesis.onvoiceschanged = () => render();
    }
  }

  function previewSelectedVoice() {
    if (!('speechSynthesis' in window)) {
      setStatus('SpeechSynthesis is not available in this browser.');
      return;
    }
    window.speechSynthesis.cancel();
    const persona = (byId('opt-voice-persona') && byId('opt-voice-persona').value) || 'nova';
    const explicitUri = (byId('opt-voice-uri') && byId('opt-voice-uri').value) || '';
    const rate = Number((byId('opt-rate') && byId('opt-rate').value) || 1.0) || 1.0;
    const personaMap = {
      nova: { name: 'Nova', pitch: 1.04, mul: 1.00, rx: /aria|jenny|neerja|natural|google us|google uk.*female/i },
      aria: { name: 'Aria', pitch: 1.11, mul: 1.04, rx: /sonia|natasha|clara|aria|google us|natural/i },
      orion: { name: 'Orion', pitch: 0.90, mul: 0.98, rx: /guy|ryan|christopher|prabhat|madhur|male|daniel/i },
      sage: { name: 'Sage', pitch: 0.98, mul: 0.96, rx: /libby|google uk|rishi|emily|natural/i },
      breeze: { name: 'Breeze', pitch: 1.07, mul: 1.08, rx: /google|online|neural|natural/i }
    };
    const cfg = personaMap[persona] || personaMap.nova;
    const voices = window.speechSynthesis.getVoices() || [];
    let chosen = explicitUri ? voices.find((v) => v.voiceURI === explicitUri || v.name === explicitUri) : null;
    if (!chosen) {
      const enPool = voices.filter((v) => /^en/i.test(v.lang || ''));
      const pool = enPool.length > 0 ? enPool : voices;
      chosen = pool.find((v) => cfg.rx.test(v.name || '') && !/\bdesktop\b/i.test(v.name || '')) ||
        pool.find((v) => /\b(?:natural|neural|online|google)\b/i.test(v.name || '')) ||
        pool[0] ||
        null;
    }
    const utt = new SpeechSynthesisUtterance(`Hi there! I'm ${cfg.name}, your Sleepwalker voice assistant. Ready whenever you are.`);
    utt.pitch = cfg.pitch;
    utt.rate = Math.max(0.65, Math.min(2.0, rate * cfg.mul));
    if (chosen) {
      utt.voice = chosen;
      if (chosen.lang) utt.lang = chosen.lang;
    }
    window.speechSynthesis.speak(utt);
    setStatus(`Previewing ${cfg.name}${chosen ? ` (${chosen.name})` : ''}...`);
  }

  function setStatus(msg) {
    const el = byId('opt-status');
    if (el) el.textContent = msg;
  }

  function saveAll() {
    const rawModel = byId('opt-ollama-model').value.trim() || 'llama3.2:3b';
    const validModel = normalizeApprovedModel(rawModel);
    if (!validModel) {
      const errEl = byId('opt-status');
      if (errEl) {
        errEl.style.color = '#991b1b';
        errEl.textContent = `Rejected unapproved model "${rawModel}". Choose one of: llama3.2:3b, qwen2.5:1.5b, qwen3-vl:2b, nomic-embed-text:latest.`;
      }
      return;
    }
    const statusEl = byId('opt-status');
    if (statusEl) statusEl.style.color = '#14532d';
    byId('opt-ollama-model').value = validModel;

    const next = {
      sleepwalker_proxy_url: byId('opt-proxy-url').value.trim(),
      sleepwalker_ollama_url: byId('opt-ollama-url').value.trim() || 'http://localhost:11434',
      sleepwalker_ollama_model: validModel,
      sleepwalker_gemini_model: byId('opt-gemini-model').value.trim() || 'gemini-flash-latest',
      sleepwalker_gemini_api_key: byId('opt-gemini-key').value.trim(),
      sleepwalker_gemini_manual_override: true,
      sleepwalker_ai_search_enabled: byId('opt-ai-search-enabled') ? byId('opt-ai-search-enabled').checked : true,
      sleepwalker_live_ws: byId('opt-live-ws') ? byId('opt-live-ws').checked : false,
      sleepwalker_memory_paused: byId('opt-memory-paused') ? byId('opt-memory-paused').checked : false,
      sleepwalker_disable_page_analysis: byId('opt-disable-page-analysis') ? byId('opt-disable-page-analysis').checked : false,
      sleepwalker_adaptive_learning_enabled: byId('opt-learning-enabled') ? byId('opt-learning-enabled').checked : true,
      sleepwalker_proactive_enabled: byId('opt-proactive-enabled') ? byId('opt-proactive-enabled').checked : true,
      sleepwalker_local_only: byId('opt-local-only').checked,
      sleepwalker_cloud_explicit_opt_in: !byId('opt-local-only').checked,
      sleepwalker_enable_stagehand_adapter: byId('opt-stagehand-enabled') ? Boolean(byId('opt-stagehand-enabled').checked) : false,
      sleepwalker_use_rebuilt_browser_engine: byId('opt-rebuilt-browser-engine') ? Boolean(byId('opt-rebuilt-browser-engine').checked) : false,
      sleepwalker_lang: byId('opt-lang').value || 'auto',
      sleepwalker_rate: Number(byId('opt-rate').value) || 1.0,
      sleepwalker_font_size: Number(byId('opt-font-size').value) || 18,
      sleepwalker_voice_persona: (byId('opt-voice-persona') && byId('opt-voice-persona').value) || 'nova',
      sleepwalker_voice_uri: (byId('opt-voice-uri') && byId('opt-voice-uri').value) || '',
      sleepwalker_glow_enabled: byId('opt-glow-enabled').checked,
      sleepwalker_barge_in: byId('opt-barge-in').checked,
      sleepwalker_translit: byId('opt-translit').checked,
      sleepwalker_profile_optin: byId('opt-profile-optin').checked,
      sleepwalker_local_profile: sanitizeProfile({
        fullName: byId('prof-name').value,
        email: byId('prof-email').value,
        phone: byId('prof-phone').value,
        city: byId('prof-city').value,
        state: byId('prof-state').value,
        pincode: byId('prof-pin').value
      })
    };
    chrome.storage.local.set(next, () => {
      setStatus('Settings saved cleanly.');
      refreshLiveHealth({ skipProbe: true });
    });
  }

  async function testOllama(checkModel = false) {
    const url = (byId('opt-ollama-url').value || 'http://localhost:11434').trim().replace(/\/+$/, '');
    const model = (byId('opt-ollama-model').value || 'llama3.2:3b').trim();
    const hint = byId('opt-ai-hint');
    hint.textContent = checkModel
      ? `Running live generation ("${model}") and embedding probes on ${url}...`
      : `Checking Ollama connectivity & origin policy on ${url}...`;
    chrome.runtime.sendMessage({
      type: 'SLEEPWALKER_CHECK_HEALTH',
      ollamaUrl: url,
      ollamaModel: model,
      geminiApiKey: (byId('opt-gemini-key').value || '').trim()
    }, (res) => {
      if (!res || res.status !== 'ok' || !res.connections) {
        hint.textContent = `Ollama check failed in service worker. Ensure Ollama is running ("ollama serve") and restart after setting OLLAMA_ORIGINS.`;
        return;
      }
      const o = res.connections.ollama || {};
      const e = res.connections.embeddings || {};
      setBadge('badge-ollama', 'detail-ollama', o);
      setBadge('badge-embed', 'detail-embed', e);
      if (o.status === 'origin_blocked' || e.status === 'origin_blocked') {
        const extOrig = res.extensionOrigin || (chrome.runtime && chrome.runtime.id ? `chrome-extension://${chrome.runtime.id}` : '');
        hint.textContent = `Blocked by Ollama origin policy (HTTP 403). Run in PowerShell: [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS','${extOrig}','User') and restart Ollama.`;
        return;
      }
      hint.textContent = o.generationOk
        ? `Verified live "${model}" generation (${o.latencyMs}ms) & embeddings=${e.status} (${e.detail || ''}).`
        : (o.detail || `Ollama probe failed (${o.status || 'unavailable'}).`);
    });
  }

  function setBadge(idBadge, idDetail, info = {}) {
    const b = byId(idBadge);
    const d = byId(idDetail);
    const stateMap = {
      connected: 'Connected',
      connecting: 'Connecting',
      reconnecting: 'Reconnecting',
      disconnected: 'Disconnected',
      unavailable: 'Error / Unavailable',
      error: 'Error'
    };
    const norm = stateMap[info.state] ? info.state : 'disconnected';
    if (b) {
      b.dataset.state = norm;
      b.textContent = stateMap[norm];
      b.style.color = norm === 'connected' ? '#14532d' : ((norm === 'unavailable' || norm === 'error') ? '#991b1b' : '#574f45');
    }
    if (d) d.textContent = info.detail || '';
  }

  function populateExtensionIdHelper(extIdOverride = '', regCmdOverride = '') {
    const extId = extIdOverride || (chrome.runtime && chrome.runtime.id) || '';
    const regCmd = regCmdOverride || (extId ? `.\\register-native-host.ps1 -ExtensionId ${extId}` : '.\\register-native-host.ps1');
    if (byId('opt-extension-id')) {
      byId('opt-extension-id').textContent = extId || 'unavailable';
    }
    if (byId('opt-native-reg-cmd')) {
      byId('opt-native-reg-cmd').value = regCmd;
    }
  }

  function refreshLiveHealth(opts = {}) {
    setBadge('badge-gemini-rest', 'detail-gemini-rest', { state: 'connecting', detail: 'Verifying...' });
    setBadge('badge-ollama', 'detail-ollama', { state: 'connecting', detail: 'Probing...' });
    setBadge('badge-embed', 'detail-embed', { state: 'connecting', detail: 'Probing...' });
    setBadge('badge-stagehand', 'detail-stagehand', { state: 'connecting', detail: 'Checking 127.0.0.1:4892...' });
    setBadge('badge-stagehand-cdp', 'detail-stagehand-cdp', { state: 'connecting', detail: 'Checking CDP session...' });
    setBadge('badge-native', 'detail-native', { state: 'connecting', detail: 'Checking native companion...' });
    const stagehandChecked = byId('opt-stagehand-enabled') ? Boolean(byId('opt-stagehand-enabled').checked) : false;
    chrome.runtime.sendMessage({
      type: 'SLEEPWALKER_CHECK_HEALTH',
      ollamaUrl: (byId('opt-ollama-url').value || 'http://localhost:11434').trim(),
      ollamaModel: (byId('opt-ollama-model').value || 'llama3.2:3b').trim(),
      geminiApiKey: (byId('opt-gemini-key').value || '').trim(),
      stagehandEnabled: stagehandChecked,
      skipProbe: Boolean(opts && opts.skipProbe)
    }, (res) => {
      if (!res || res.status !== 'ok') {
        setBadge('badge-gemini-rest', 'detail-gemini-rest', { state: 'error', detail: 'SW check failed' });
        setBadge('badge-ollama', 'detail-ollama', { state: 'error', detail: 'SW check failed' });
        setBadge('badge-stagehand', 'detail-stagehand', { state: 'error', detail: 'SW check failed' });
        setBadge('badge-native', 'detail-native', { state: 'error', detail: 'SW check failed' });
        return;
      }
      populateExtensionIdHelper(res.extensionId || '', res.nativeRegisterCommand || '');
      const c = res.connections || {};
      setBadge('badge-gemini-rest', 'detail-gemini-rest', c.geminiRest || {});
      setBadge('badge-gemini-ws', 'detail-gemini-ws', {
        state: (c.geminiLiveWs && c.geminiLiveWs.state) || 'disconnected',
        detail: c.geminiLiveWs && c.geminiLiveWs.enabled ? `Enabled (${c.geminiLiveWs.sessions.length} active)` : 'Disabled in Settings'
      });
      setBadge('badge-ollama', 'detail-ollama', c.ollama || {});
      setBadge('badge-embed', 'detail-embed', c.embeddings || {});

      const sh = c.stagehand || {};
      setBadge('badge-stagehand', 'detail-stagehand', {
        state: sh.state || 'disconnected',
        detail: sh.detail || ''
      });
      setBadge('badge-stagehand-cdp', 'detail-stagehand-cdp', {
        state: sh.cdpConnected ? 'connected' : (sh.available ? 'disconnected' : (sh.enabled ? 'unavailable' : 'disconnected')),
        detail: sh.cdpConnected
          ? `Connected to ${sh.cdpEndpoint || '127.0.0.1:9222'}`
          : (sh.available ? `Sidecar online (${sh.cdpEndpoint || '127.0.0.1:9222'} attaches per command)` : 'Sidecar offline')
      });

      const nat = c.nativeCompanion || {};
      setBadge('badge-native', 'detail-native', {
        state: nat.state || 'unavailable',
        detail: nat.detail || ''
      });
      const extOrigin = res.extensionOrigin || (chrome.runtime && chrome.runtime.id ? `chrome-extension://${chrome.runtime.id}` : '');
      if (byId('opt-ollama-origin-info')) {
        const ollamaStat = (c.ollama && c.ollama.status) || 'untested';
        const oStats = res.llmDiagnostics && res.llmDiagnostics.ollama;
        const countsStr = oStats ? ` | Live gen ok: ${oStats.liveModelSuccessCount || 0}, Fallback planner: ${oStats.fallbackPlannerCount || 0}, Origin 403s: ${oStats.originBlockedCount || 0}` : '';
        if (ollamaStat === 'origin_blocked' || (c.embeddings && c.embeddings.status === 'origin_blocked')) {
          byId('opt-ollama-origin-info').textContent = `Extension Origin Blocked (HTTP 403): Run in PowerShell -> [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS','${extOrigin}','User') then restart Ollama.${countsStr}`;
        } else {
          byId('opt-ollama-origin-info').textContent = `Extension Origin: ${extOrigin || 'unavailable'} (generationOk=${Boolean(c.ollama && c.ollama.generationOk)}, embeddingOk=${Boolean(c.embeddings && c.embeddings.embeddingOk)})${countsStr}`;
        }
      }
      if (byId('opt-mem-summary') && res.memorySummary) {
        const m = res.memorySummary;
        byId('opt-mem-summary').textContent = `Stored: ${m.activities} activities, ${m.tabContexts} tab contexts, ${m.recentTasks} recent tasks, ${m.compressedSummaries || 0} compressed summaries (~${m.approxBytes} bytes).`;
      }
      if (byId('opt-diag')) {
        byId('opt-diag').textContent = JSON.stringify({
          checkedAt: res.checkedAt,
          extensionOrigin: extOrigin,
          connections: res.connections,
          privacy: res.privacy,
          memorySummary: res.memorySummary,
          llmDiagnostics: res.llmDiagnostics,
          commTelemetry: res.commTelemetry,
          worldModelTraces: res.worldModelTraces || []
        }, null, 2);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    populateExtensionIdHelper();
    loadAll();
    setTimeout(() => refreshLiveHealth({ skipProbe: true }), 120);
    byId('opt-save').addEventListener('click', saveAll);
    byId('opt-test-ollama').addEventListener('click', () => refreshLiveHealth({ skipProbe: false }));
    if (byId('opt-copy-native-cmd')) {
      byId('opt-copy-native-cmd').addEventListener('click', async () => {
        const cmdVal = byId('opt-native-reg-cmd') ? byId('opt-native-reg-cmd').value : '';
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(cmdVal);
          } else if (byId('opt-native-reg-cmd')) {
            byId('opt-native-reg-cmd').select();
            document.execCommand('copy');
          }
          setStatus('Copied native host registration command to clipboard.');
        } catch (_e) {
          setStatus('Select and copy the command from the text box.');
        }
      });
    }
    if (byId('opt-test-ollama-model')) {
      byId('opt-test-ollama-model').addEventListener('click', () => testOllama(true));
    }
    byId('opt-toggle-key').addEventListener('click', () => {
      const inp = byId('opt-gemini-key');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      byId('opt-toggle-key').textContent = show ? 'Hide Key' : 'Show Key';
    });
    byId('opt-reload-env').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'SLEEPWALKER_RELOAD_ENV' }, (res) => {
        setStatus(res && res.status === 'ok' ? 'Reloaded .env defaults.' : 'No .env file found.');
        loadAll();
      });
    });
    if (byId('opt-clear-recent')) {
      byId('opt-clear-recent').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CLEAR_MEMORY', scope: 'recent' }, () => {
          setStatus('Recent activity cleared.');
          refreshLiveHealth();
        });
      });
    }
    if (byId('opt-clear-tasks')) {
      byId('opt-clear-tasks').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CLEAR_MEMORY', scope: 'tasks' }, () => {
          setStatus('Task history cleared.');
          refreshLiveHealth();
        });
      });
    }
    if (byId('opt-clear-personal')) {
      byId('opt-clear-personal').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CLEAR_MEMORY', scope: 'personal' }, () => {
          setStatus('Personal context cleared.');
          refreshLiveHealth();
        });
      });
    }
    if (byId('opt-reset-prefs')) {
      byId('opt-reset-prefs').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CLEAR_MEMORY', scope: 'preferences' }, () => {
          setStatus('Learned & stored preferences reset.');
          refreshLiveHealth();
        });
      });
    }
    if (byId('opt-clear-reminders')) {
      byId('opt-clear-reminders').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CLEAR_MEMORY', scope: 'reminders' }, () => {
          setStatus('All scheduled reminders cleared.');
          refreshLiveHealth();
        });
      });
    }
    if (byId('opt-clear-all-mem')) {
      byId('opt-clear-all-mem').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'SLEEPWALKER_CLEAR_MEMORY', scope: 'all' }, () => {
          setStatus('All stored Sleepwalker memory wiped cleanly.');
          refreshLiveHealth();
        });
      });
    }
    const refreshPersonalInspector = () => {
      const box = byId('opt-personal-inspector');
      if (!box) return;
      chrome.storage.local.get(['sleepwalker_persistent_memory_v1', 'sleepwalker_reminders_v1'], (d) => {
        const mem = d && d.sleepwalker_persistent_memory_v1;
        const rems = Array.isArray(d && d.sleepwalker_reminders_v1) ? d.sleepwalker_reminders_v1 : [];
        const pc = (mem && mem.personalContext) || {};
        const prefs = Object.entries(pc.preferences || {}).map(([k, v]) => `${k}=${JSON.stringify(v.value)} (${v.source})`);
        const projs = Object.values(pc.projects || {}).map((p) => `${p.title} [${p.domain}]`);
        const remLines = rems.filter((r) => r.status !== 'cancelled').map((r) => `[${r.status}] ${r.title} (${new Date(r.targetTimeMs).toLocaleString()})`);
        box.textContent = [
          `Preferences: ${prefs.length ? prefs.join('; ') : 'none'}`,
          `Projects: ${projs.length ? projs.join('; ') : 'none'}`,
          `Reminders: ${remLines.length ? remLines.join('; ') : 'none'}`
        ].join('  |  ');
      });
    };
    refreshPersonalInspector();
    if (byId('opt-save')) byId('opt-save').addEventListener('click', refreshPersonalInspector);
    if (byId('opt-load-diag')) byId('opt-load-diag').addEventListener('click', refreshPersonalInspector);

    const mutateSkillsStorage = (mutator) => {
      chrome.storage.local.get(['sleepwalker_persistent_memory_v1'], (d) => {
        const mem = (d && d.sleepwalker_persistent_memory_v1) || {};
        const skills = Array.isArray(mem.learnedSkills) ? mem.learnedSkills.slice() : [];
        const nextSkills = mutator(skills);
        const nextMem = { ...mem, learnedSkills: nextSkills };
        chrome.storage.local.set({ sleepwalker_persistent_memory_v1: nextMem }, () => renderSkillsList());
      });
    };

    const renderSkillsList = () => {
      const box = byId('opt-skills-list');
      if (!box) return;
      const filter = String((byId('opt-skills-search') && byId('opt-skills-search').value) || '').trim().toLowerCase();
      chrome.storage.local.get(['sleepwalker_persistent_memory_v1'], (d) => {
        const mem = (d && d.sleepwalker_persistent_memory_v1) || {};
        const all = Array.isArray(mem.learnedSkills) ? mem.learnedSkills : [];
        const matched = all.filter((sk) => {
          if (!sk) return false;
          if (!filter) return true;
          return `${sk.name || ''} ${sk.instruction || ''} ${sk.website || ''} ${(sk.variations || []).join(' ')}`.toLowerCase().includes(filter);
        });
        box.textContent = '';
        if (matched.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'note';
          empty.textContent = all.length === 0
            ? 'No learned skills yet. When Sleepwalker offers "Teach Sleepwalker" after a failed action, demonstrate the steps to save a skill here.'
            : 'No learned skills match your search filter.';
          box.appendChild(empty);
          return;
        }
        matched.forEach((sk) => {
          const card = document.createElement('div');
          card.style.cssText = 'padding:12px 14px;border-radius:14px;background:rgba(255,255,255,0.78);border:1px solid rgba(27,23,20,0.14);display:flex;flex-direction:column;gap:6px;';
          card.dataset.skillId = sk.id;

          const head = document.createElement('div');
          head.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;';
          const title = document.createElement('strong');
          title.textContent = `${sk.name || sk.instruction} (v${sk.version || 1})`;
          const badge = document.createElement('span');
          badge.className = 'note';
          badge.style.margin = '0';
          badge.textContent = `${sk.website || 'local'} · ${(sk.steps || []).length} step(s) · ${sk.enabled === false ? 'Disabled' : 'Auto-enabled'}`;
          head.append(title, badge);

          const meta = document.createElement('div');
          meta.className = 'note';
          meta.style.margin = '0';
          const lastOk = sk.lastSuccessAt ? new Date(sk.lastSuccessAt).toLocaleString() : 'Never';
          meta.textContent = `Instruction: "${sk.instruction}" · Last verified: ${lastOk}`;

          const actions = document.createElement('div');
          actions.className = 'row';
          actions.style.marginTop = '4px';

          const renameBtn = document.createElement('button');
          renameBtn.type = 'button';
          renameBtn.dataset.action = 'rename';
          renameBtn.textContent = 'Rename';
          renameBtn.addEventListener('click', () => {
            const proposed = prompt('Rename learned skill:', sk.name || sk.instruction);
            if (proposed && proposed.trim()) {
              mutateSkillsStorage((list) => list.map((it) => (it && it.id === sk.id ? { ...it, name: proposed.trim().slice(0, 90), updatedAt: Date.now() } : it)));
              setStatus('Skill renamed.');
            }
          });

          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.dataset.action = 'toggle';
          toggleBtn.textContent = sk.enabled === false ? 'Enable Auto-Use' : 'Disable Auto-Use';
          toggleBtn.addEventListener('click', () => {
            const nextEnabled = sk.enabled === false;
            mutateSkillsStorage((list) => list.map((it) => (it && it.id === sk.id ? { ...it, enabled: nextEnabled, updatedAt: Date.now() } : it)));
            setStatus(nextEnabled ? 'Skill enabled.' : 'Skill disabled.');
          });

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.dataset.action = 'delete';
          delBtn.textContent = 'Delete';
          delBtn.addEventListener('click', () => {
            mutateSkillsStorage((list) => list.filter((it) => it && it.id !== sk.id));
            setStatus('Skill deleted.');
          });

          actions.append(renameBtn, toggleBtn, delBtn);
          card.append(head, meta, actions);
          box.appendChild(card);
        });
      });
    };
    renderSkillsList();
    if (byId('opt-skills-search')) byId('opt-skills-search').addEventListener('input', renderSkillsList);
    if (byId('opt-skills-refresh')) byId('opt-skills-refresh').addEventListener('click', renderSkillsList);
    byId('opt-clear-profile').addEventListener('click', () => {
      ['prof-name', 'prof-email', 'prof-phone', 'prof-city', 'prof-state', 'prof-pin'].forEach((id) => { byId(id).value = ''; });
      chrome.storage.local.set({ sleepwalker_profile_optin: false, sleepwalker_local_profile: {} }, () => {
        byId('opt-profile-optin').checked = false;
        setStatus('Saved profile cleared.');
      });
    });
    byId('opt-open-shelf').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'SLEEPWALKER_OPEN_SHELF_SETUP' }));
    byId('opt-open-mic').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'SLEEPWALKER_OPEN_MIC_SETUP' }));
    if (byId('opt-preview-voice')) byId('opt-preview-voice').addEventListener('click', previewSelectedVoice);
    byId('opt-load-diag').addEventListener('click', refreshLiveHealth);
  });
})();
