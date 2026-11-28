/**
 * Sleepwalker - Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 * 1. Listen for toolbar icon clicks and the Alt+S shortcut (via _execute_action).
 * 2. Check for restricted browser pages (chrome://, Web Store, etc.) and inform user.
 * 3. Send toggle message to the active tab, dynamically injecting scripts if needed.
 * 4. Manage LLM Cascade (cache -> Gemini proxy -> local Ollama -> offline fallback).
 */

// Import local configuration if present (contains developer API key, ignored by git)
try {
  importScripts('/config.local.js');
} catch (e) {
  // config.local.js not present in distribution builds
}

// Import LLM Cascade, Gemini Live WS client & Unified AI Comm Manager into the service worker
importScripts('/src/background/llm.js');
try {
  importScripts('/src/background/gemini-live.js');
} catch (e) {
  console.warn('[Sleepwalker SW] gemini-live.js unavailable:', e && e.message);
}
try {
  importScripts('/src/background/ai-comm.js');
} catch (e) {
  console.warn('[Sleepwalker SW] ai-comm.js unavailable:', e && e.message);
}
try {
  importScripts('/src/forms/shelf-db.js');
} catch (e) {
  console.warn('[Sleepwalker SW] shelf-db.js unavailable:', e && e.message);
}
try {
  importScripts('/src/intelligence/personal-intel.js');
} catch (e) {
  console.warn('[Sleepwalker SW] personal-intel.js unavailable:', e && e.message);
}
try {
  importScripts('/src/background/cdp-ownership-manager.js');
} catch (e) {
  console.warn('[Sleepwalker SW] cdp-ownership-manager.js unavailable:', e && e.message);
}

self.SLEEPWALKER_ENV = self.SLEEPWALKER_ENV || {};
self.SLEEPWALKER_AI_COMM = (self.SleepwalkerAiComm && typeof self.SleepwalkerAiComm.SleepwalkerAiCommManager === 'function')
  ? new self.SleepwalkerAiComm.SleepwalkerAiCommManager({
      llm: self,
      liveMod: self.SleepwalkerLive || null
    })
  : null;

/**
 * Load .env from the extension root (readable only by the private background worker, never exposed in web_accessible_resources)
 * and sync GEMINI_API_KEY, GEMINI_MODEL, OLLAMA_URL, OLLAMA_MODEL, CLOUD_PROXY_URL, LOCAL_ONLY cleanly.
 */
async function syncEnvIntoStorage(forceReload = false) {
  let envObj = {};
  let envLoaded = false;

  try {
    const res = await fetch(chrome.runtime.getURL('.env'));
    if (res.ok) {
      const text = await res.text();
      if (typeof parseDotEnv === 'function') {
        envObj = parseDotEnv(text);
        envLoaded = true;
      }
    }
  } catch (_e) {
    // No .env file present in packaged build; fall back to config.local.js or Settings UI
  }

  if (!envObj.GEMINI_API_KEY && typeof self.SLEEPWALKER_DEFAULT_KEY === 'string' && self.SLEEPWALKER_DEFAULT_KEY.trim()) {
    envObj.GEMINI_API_KEY = self.SLEEPWALKER_DEFAULT_KEY.trim();
  }

  self.SLEEPWALKER_ENV = { ...envObj, _envLoaded: envLoaded };

  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'sleepwalker_gemini_api_key',
        'sleepwalker_gemini_model',
        'sleepwalker_ollama_url',
        'sleepwalker_ollama_model',
        'sleepwalker_proxy_url',
        'sleepwalker_local_only',
        'sleepwalker_cloud_explicit_opt_in',
        'sleepwalker_gemini_manual_override',
        'sleepwalker_last_env_gemini_key'
      ],
      (data) => {
        // P0 Security Policy: Local-Only mode is ALWAYS true by default.
        // Never silently disable local-only mode or auto-seed Gemini cloud keys from .env.
        const explicitCloudOptIn = data.sleepwalker_cloud_explicit_opt_in === true && data.sleepwalker_local_only === false;
        const effectiveLocalOnly = !explicitCloudOptIn;

        const nextValues = {};
        if (data.sleepwalker_local_only === undefined) {
          nextValues.sleepwalker_local_only = true;
        }
        if (envObj.OLLAMA_URL && (forceReload || !data.sleepwalker_ollama_url || !data.sleepwalker_gemini_manual_override)) {
          nextValues.sleepwalker_ollama_url = envObj.OLLAMA_URL;
        }
        if (envObj.OLLAMA_MODEL && (forceReload || !data.sleepwalker_ollama_model || !data.sleepwalker_gemini_manual_override)) {
          nextValues.sleepwalker_ollama_model = envObj.OLLAMA_MODEL;
        }
        if (envObj.OLLAMA_FAST_MODEL) {
          nextValues.sleepwalker_ollama_fast_model = envObj.OLLAMA_FAST_MODEL;
        }
        // Only sync optional cloud Gemini settings when user explicitly opted out of Local-Only mode
        if (!effectiveLocalOnly) {
          const storedKey = (data.sleepwalker_gemini_api_key || '').trim();
          const shouldSyncKey = Boolean(
            envObj.GEMINI_API_KEY &&
            (forceReload || !data.sleepwalker_gemini_manual_override || !storedKey || storedKey === data.sleepwalker_last_env_gemini_key)
          );
          if (shouldSyncKey) {
            nextValues.sleepwalker_gemini_api_key = envObj.GEMINI_API_KEY;
            nextValues.sleepwalker_last_env_gemini_key = envObj.GEMINI_API_KEY;
            if (forceReload) nextValues.sleepwalker_gemini_manual_override = false;
          }
          if (envObj.GEMINI_MODEL && (forceReload || !data.sleepwalker_gemini_model || !data.sleepwalker_gemini_manual_override)) {
            nextValues.sleepwalker_gemini_model = envObj.GEMINI_MODEL;
          }
          if (envObj.CLOUD_PROXY_URL !== undefined && (forceReload || !data.sleepwalker_proxy_url)) {
            nextValues.sleepwalker_proxy_url = envObj.CLOUD_PROXY_URL;
          }
        }

        const effective = {
          envLoaded,
          geminiKey: effectiveLocalOnly ? '' : ((nextValues.sleepwalker_gemini_api_key || data.sleepwalker_gemini_api_key || '').trim()),
          geminiModel: nextValues.sleepwalker_gemini_model || data.sleepwalker_gemini_model || envObj.GEMINI_MODEL || 'gemini-2.5-flash-lite',
          ollamaUrl: nextValues.sleepwalker_ollama_url || data.sleepwalker_ollama_url || envObj.OLLAMA_URL || 'http://localhost:11434',
          ollamaModel: nextValues.sleepwalker_ollama_model || data.sleepwalker_ollama_model || envObj.OLLAMA_MODEL || 'llama3.2:3b',
          proxyUrl: effectiveLocalOnly ? '' : (nextValues.sleepwalker_proxy_url !== undefined ? nextValues.sleepwalker_proxy_url : (data.sleepwalker_proxy_url || '')),
          localOnly: effectiveLocalOnly
        };

        if (Object.keys(nextValues).length > 0) {
          chrome.storage.local.set(nextValues, () => resolve(effective));
        } else {
          resolve(effective);
        }
      }
    );
  });
}

const envReadyPromise = syncEnvIntoStorage(false);

// List of URL prefixes and domains where extensions are forbidden to run by Chrome
const RESTRICTED_PATTERNS = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'view-source:',
  'devtools://',
  'chrome.google.com/webstore',
  'chromewebstore.google.com'
];

/**
 * Check if the given URL is restricted by Chrome's security model.
 * Important: If url is undefined or empty (because tabs permission is omitted),
 * do NOT assume restricted; let injection or messaging proceed.
 * @param {string} url - The URL to check.
 * @returns {boolean} True if restricted, false otherwise.
 */
function isRestrictedUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return RESTRICTED_PATTERNS.some(prefix => url.startsWith(prefix) || url.includes(prefix));
}

/**
 * Show a friendly visual notice when user attempts to run Sleepwalker on a restricted page.
 * @param {chrome.tabs.Tab} tab - The tab where the action was attempted.
 * @param {string} [extraDetail] - Optional detail or error message.
 */
function notifyRestrictedPage(tab, extraDetail = '') {
  const tabId = tab && tab.id;
  if (tabId) {
    chrome.action.setBadgeText({ tabId, text: '!' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#D32F2F' });
    chrome.action.setTitle({
      tabId,
      title: 'Sleepwalker cannot run on Chrome internal or Web Store pages. Please open any normal website.'
    });
  }

  const isFileUrl = tab && tab.url && tab.url.startsWith('file://');

  const noticeHtml = isFileUrl
    ? `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Sleepwalker - Local File Notice</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #121214; color: #FFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
        .card { max-width: 600px; background: #1E1E24; border: 3px solid #FFD600; border-radius: 16px; padding: 36px; text-align: center; }
        h1 { color: #FFD600; font-size: 26px; }
        p { font-size: 19px; line-height: 1.6; text-align: left; }
        .steps { background: #2A2A35; padding: 18px; border-radius: 8px; border-left: 4px solid #00E5FF; text-align: left; font-size: 18px; line-height: 1.7; }
        kbd { background: #333340; padding: 2px 7px; border-radius: 4px; color: #FFD600; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>📁 Testing on Local File (file://)?</h1>
        <p>By default, Chrome disables extensions on local <code>file:///</code> pages until enabled.</p>
        <div class="steps">
          <strong>To enable Sleepwalker on local HTML files:</strong><br>
          1. Go to <code>chrome://extensions</code>.<br>
          2. Click <strong>Details</strong> on the Sleepwalker card.<br>
          3. Turn ON <strong>"Allow access to file URLs"</strong>.<br>
          4. Return to your file and press <kbd>Alt+S</kbd>!
          <hr style="border:none;border-top:1px solid #444;margin:12px 0;">
          <em>Tip: Testing on any live website (like Wikipedia or BBC) works immediately with zero extra steps.</em>
        </div>
      </div>
    </body>
    </html>
    `
    : `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Sleepwalker - Notice</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #121214; color: #FFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
        .card { max-width: 580px; background: #1E1E24; border: 3px solid #FFD600; border-radius: 16px; padding: 36px; text-align: center; }
        h1 { font-size: 28px; color: #FFD600; margin-top: 0; }
        p { font-size: 20px; line-height: 1.6; color: #E0E0E0; margin-bottom: 24px; }
        .tip { background: #2A2A35; padding: 16px; border-radius: 8px; border-left: 4px solid #00E5FF; font-size: 18px; text-align: left; }
        kbd { background: #333340; padding: 3px 8px; border-radius: 4px; color: #FFD600; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>⚠️ Sleepwalker Cannot Run On This Page</h1>
        <p>
          Chrome blocks <strong>all</strong> browser extensions from running on internal system pages
          (like <code>chrome://</code>) and the <strong>Chrome Web Store</strong> for security reasons.
        </p>
        <div class="tip">
          <strong>What to do next:</strong><br>
          1. Open any regular website (e.g. Wikipedia, a news article, or any http/https site).<br>
          2. Click the Sleepwalker icon or press <kbd>Alt+S</kbd> to launch the voice assistant.
        </div>
      </div>
    </body>
    </html>
  `;

  chrome.tabs.create({
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(noticeHtml)
  });
}

/**
 * Toggle the Sleepwalker widget in the specified tab.
 * @param {chrome.tabs.Tab} tab - The tab to toggle.
 */
const CONTENT_SCRIPT_FILES = [
  'src/voice/reader.js',
  'src/intelligence/outline.js',
  'src/intelligence/diagnostics.js',
  'src/background/ai-comm.js',
  'src/voice/voice-pipeline.js',
  'src/voice/voice.js',
  'src/intelligence/memory.js',
  'src/intelligence/task-planner.js',
  'src/intelligence/personal-intel.js',
  'src/intelligence/digest.js',
  'src/intelligence/explain.js',
  'src/intelligence/confirm.js',
  'src/engine/link-index.js',
  'src/engine/match.js',
  'src/engine/link-intent.js',
  'src/engine/intent.js',
  'src/engine/nav-engine.js',
  'src/engine/navigate.js',
  'src/forms/form-index.js',
  'src/forms/form-fill.js',
  'src/forms/forms.js',
  'src/engine/element-select.js',
  'src/engine/world-model.js',
  'src/forms/shelf-db.js',
  'src/forms/upload.js',
  'src/forms/camera.js',
  'src/voice/dialogue.js',
  'src/ui/threads.js',
  'src/ui/card.js',
  'src/ui/orb-canvas.js',
  'src/ui/orb.js',
  'src/intelligence/teach.js',
  'src/engine/browser-engine.js',
  'src/engine/stagehand-browser-adapter.js',
  'src/engine/extension-intelligence.js',
  'src/engine/unified-task-contract.js',
  'src/engine/unified-orchestrator.js',
  'src/content.js'
];

function toggleSleepwalker(tab) {
  if (!tab || !tab.id) return;

  // If tab.url is visible and restricted, show notice
  if (tab.url && isRestrictedUrl(tab.url)) {
    notifyRestrictedPage(tab);
    return;
  }

  // Clear any existing error badge
  chrome.action.setBadgeText({ tabId: tab.id, text: '' });

  // First try sending toggle message to existing content script
  chrome.tabs.sendMessage(tab.id, { action: 'SLEEPWALKER_TOGGLE' }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script not yet running on this tab; inject it dynamically
      console.log('[Sleepwalker] Injecting content scripts into tab', tab.id);

      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: CONTENT_SCRIPT_FILES
      }).then(() => {
        chrome.tabs.sendMessage(tab.id, { action: 'SLEEPWALKER_TOGGLE' });
      }).catch((err) => {
        console.warn('[Sleepwalker] Cannot inject scripts on this tab:', err.message);
        notifyRestrictedPage(tab, err.message);
      });
    }
  });
}

// In Manifest V3 with _execute_action, clicking the action icon OR pressing Alt+S
// triggers chrome.action.onClicked automatically and grants activeTab!
chrome.action.onClicked.addListener((tab) => {
  toggleSleepwalker(tab);
});

// Attach unified streaming Chrome Port listener (`sw-ai-stream`) for progressive UI & low-latency TTS
if (self.SLEEPWALKER_AI_COMM) {
  self.SLEEPWALKER_AI_COMM.attachBackgroundPortListener(envReadyPromise);
}

/**
 * Handle incoming explanation and intent classification requests from content scripts.
 * Cascades: Direct Gemini -> Cloud Gemini Proxy -> Local Ollama -> Offline Fallback.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === 'SLEEPWALKER_EXPLAIN_REQUEST') {
    envReadyPromise
      .then(() => handleExplainRequest(message.payload))
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        console.warn('[Sleepwalker SW] Error handling explain request:', err);
        sendResponse({ status: 'fallback', source: 'basic summary' });
      });

    // Return true to keep the message communication port open for asynchronous response
    return true;
  }

  if (message.type === 'SLEEPWALKER_INTENT_REQUEST') {
    envReadyPromise
      .then(() => handleIntentRequest(message.payload))
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        console.warn('[Sleepwalker SW] Error handling intent request:', err);
        sendResponse({ status: 'fallback' });
      });

    return true;
  }

  if (message.type === 'SLEEPWALKER_PICK_LINK_REQUEST') {
    envReadyPromise
      .then(() => handleLinkPickRequest(message.payload))
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        console.warn('[Sleepwalker SW] Error handling link pick request:', err);
        sendResponse({ status: 'unavailable', id: null, confidence: 0 });
      });

    return true;
  }

  if (message.type === 'SLEEPWALKER_SEARCH_SELECT_REQUEST') {
    envReadyPromise
      .then(() => handleSearchSelectRequest(message.payload))
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        console.warn('[Sleepwalker SW] Error handling search select request:', err);
        sendResponse({ status: 'ollama_unavailable', message: (err && err.message) || 'Search selection failed.' });
      });

    return true;
  }

  if (message.type === 'SLEEPWALKER_ELEMENT_SELECT_REQUEST') {
    envReadyPromise
      .then(() => handleElementSelectRequest(message.payload))
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        console.warn('[Sleepwalker SW] Error handling element select request:', err);
        sendResponse({ status: 'ollama_unavailable', message: (err && err.message) || 'Element selection failed.' });
      });

    return true;
  }

  if (message.type === 'SLEEPWALKER_BROWSER_AI_UNDERSTAND') {
    envReadyPromise
      .then(() => handleCompoundBrowserPlanRequest(message.payload || {}))
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ status: 'error', message: (err && err.message) || 'Browser plan understanding failed.' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_COMPARE_SEARCH_RESULTS') {
    envReadyPromise
      .then(() => handleSearchResultsCompareRequest(message.payload || {}))
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ status: 'error', message: (err && err.message) || 'Search result comparison failed.' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_TEST_OLLAMA_STATUS') {
    envReadyPromise
      .then(() => getLlmConfig())
      .then((cfg) => checkOllamaModelStatus(
        (message && message.ollamaUrl) || cfg.ollamaUrl,
        (message && message.ollamaModel) || cfg.ollamaModel
      ))
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ status: 'error', available: false, message: (err && err.message) || 'Failed to check Ollama status.' }));

    return true;
  }

  if (message.type === 'SLEEPWALKER_GET_ENV_DEFAULTS') {
    envReadyPromise
      .then((effective) => sendResponse({ status: 'ok', ...effective }))
      .catch(() => sendResponse({ status: 'error' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_RELOAD_ENV') {
    syncEnvIntoStorage(true)
      .then((effective) => sendResponse({ status: 'ok', ...effective }))
      .catch((err) => sendResponse({ status: 'error', message: err.message }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_GET_LLM_DIAGNOSTICS') {
    const diagnostics = typeof getLlmDiagnostics === 'function' ? getLlmDiagnostics() : null;
    const commTelemetry = self.SLEEPWALKER_AI_COMM ? self.SLEEPWALKER_AI_COMM.getTelemetry() : null;
    sendResponse({ diagnostics, commTelemetry });
    return false;
  }

  // Persist cross-page navigation/task state in chrome.storage.session
  if (message.type === 'SLEEPWALKER_SESSION_STATE_SET') {
    const sessionApi = (chrome.storage && chrome.storage.session) || chrome.storage.local;
    if (sessionApi) {
      sessionApi.set({ sleepwalker_nav_task: message.state || null }, () => {
        sendResponse({ status: 'ok' });
      });
      return true;
    }
    sendResponse({ status: 'unavailable' });
    return false;
  }

  if (message.type === 'SLEEPWALKER_SESSION_STATE_GET') {
    const sessionApi = (chrome.storage && chrome.storage.session) || chrome.storage.local;
    if (sessionApi) {
      sessionApi.get(['sleepwalker_nav_task'], (data) => {
        sendResponse({ state: (data && data.sleepwalker_nav_task) || null });
      });
      return true;
    }
    sendResponse({ state: null });
    return false;
  }

  if (message.type === 'SLEEPWALKER_SESSION_STATE_CLEAR') {
    const sessionApi = (chrome.storage && chrome.storage.session) || chrome.storage.local;
    if (sessionApi) {
      sessionApi.remove(['sleepwalker_nav_task'], () => {
        sendResponse({ status: 'ok' });
      });
      return true;
    }
    sendResponse({ status: 'unavailable' });
    return false;
  }

  // Persistent Assistant Memory & Session State (chrome.storage.session + chrome.storage.local)
  if (message.type === 'SLEEPWALKER_MEMORY_GET') {
    const sessionApi = (chrome.storage && chrome.storage.session) || null;
    const localApi = (chrome.storage && chrome.storage.local) || null;
    (async () => {
      let localState = null;
      let sessionState = null;
      if (localApi) {
        localState = await new Promise((resolve) => {
          localApi.get(['sleepwalker_persistent_memory_v1'], (d) => resolve((d && d.sleepwalker_persistent_memory_v1) || null));
        });
      }
      if (sessionApi) {
        sessionState = await new Promise((resolve) => {
          sessionApi.get(['sleepwalker_persistent_memory_v1', 'sleepwalker_session_state_v1'], (d) => resolve(d || null));
        });
      }
      const browserRestarted = Boolean(localState && sessionApi && (!sessionState || (!sessionState.sleepwalker_persistent_memory_v1 && !sessionState.sleepwalker_session_state_v1)));
      let merged = (sessionState && sessionState.sleepwalker_persistent_memory_v1) || localState || null;
      if (merged && sessionState && sessionState.sleepwalker_session_state_v1 && sessionState.sleepwalker_session_state_v1.sessionMode) {
        merged = Object.assign({}, merged, {
          sessionMode: sessionState.sleepwalker_session_state_v1.sessionMode
        });
      }
      sendResponse({ status: 'ok', state: merged, browserRestarted });
    })().catch(() => {
      sendResponse({ status: 'error', state: null, browserRestarted: false });
    });
    return true;
  }

  if (message.type === 'SLEEPWALKER_MEMORY_SET') {
    const incoming = message.state && typeof message.state === 'object' ? message.state : null;
    const preserveTabs = Boolean(message.preserveOtherTabs && message.tabKey);
    const saveTasks = async () => {
      let stateToSave = incoming;
      if (preserveTabs && incoming && chrome.storage && chrome.storage.local) {
        const existingData = await new Promise((resolve) => {
          chrome.storage.local.get(['sleepwalker_persistent_memory_v1'], (d) => {
            void chrome.runtime?.lastError;
            resolve(d || {});
          });
        });
        const oldMem = existingData && existingData.sleepwalker_persistent_memory_v1;
        if (oldMem && typeof oldMem === 'object') {
          const mergedTabs = { ...(oldMem.tabContexts || {}) };
          if (incoming.tabContexts && incoming.tabContexts[message.tabKey]) {
            mergedTabs[message.tabKey] = incoming.tabContexts[message.tabKey];
          }
          let mergedSkills = Array.isArray(incoming.learnedSkills) ? incoming.learnedSkills : [];
          if (Array.isArray(oldMem.learnedSkills) && oldMem.learnedSkills.length > 0 && mergedSkills.length === 0 && !incoming._skillsModifiedExplicitly) {
            mergedSkills = oldMem.learnedSkills;
          }
          stateToSave = { ...incoming, tabContexts: mergedTabs, learnedSkills: mergedSkills };
        }
      }

      const sessionMeta = stateToSave
        ? {
            sessionMode: stateToSave.sessionMode || 'ended',
            currentTopic: stateToSave.currentTopic || '',
            activeTask: stateToSave.activeTask || null,
            activeTabId: (sender && sender.tab && sender.tab.id) || (stateToSave.shortTerm && stateToSave.shortTerm.activeTabId) || null,
            updatedAt: Date.now()
          }
        : null;
      const payload = {
        sleepwalker_persistent_memory_v1: stateToSave,
        sleepwalker_session_state_v1: sessionMeta
      };
      const tasks = [];
      if (chrome.storage && chrome.storage.local) {
        tasks.push(new Promise((resolve) => chrome.storage.local.set(payload, () => {
          void chrome.runtime?.lastError;
          resolve();
        })));
      }
      if (chrome.storage && chrome.storage.session) {
        tasks.push(new Promise((resolve) => chrome.storage.session.set(payload, () => {
          void chrome.runtime?.lastError;
          resolve();
        })));
      }
      await Promise.all(tasks);
    };

    saveTasks()
      .then(() => sendResponse({ status: 'ok' }))
      .catch(() => sendResponse({ status: 'error' }));
    return true;
  }

  // Multi-tab identity, focus & selective memory deletion handlers
  if (message.type === 'SLEEPWALKER_GET_TAB_IDENTITY') {
    sendResponse({
      tabId: (sender && sender.tab && typeof sender.tab.id === 'number') ? sender.tab.id : null,
      windowId: (sender && sender.tab && typeof sender.tab.windowId === 'number') ? sender.tab.windowId : null
    });
    return false;
  }

  if (message.type === 'SLEEPWALKER_FOCUS_TAB') {
    const targetTabId = Number(message.tabId);
    if (!Number.isInteger(targetTabId) || !chrome.tabs || !chrome.tabs.update) {
      sendResponse({ ok: false, error: 'Invalid or unavailable tabId' });
      return false;
    }
    chrome.tabs.update(targetTabId, { active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        sendResponse({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Tab no longer open' });
        return;
      }
      if (typeof tab.windowId === 'number' && chrome.windows && chrome.windows.update) {
        chrome.windows.update(tab.windowId, { focused: true }, () => { void chrome.runtime?.lastError; });
      }
      sendResponse({ ok: true, tabId: tab.id });
    });
    return true;
  }

  if (message.type === 'SLEEPWALKER_CLEAR_MEMORY') {
    const scope = String(message.scope || 'all');
    (async () => {
      if (scope === 'all') {
        if (chrome.alarms && typeof chrome.alarms.clearAll === 'function') {
          try { await chrome.alarms.clearAll(); } catch (_e) {}
        }
        if (chrome.storage && chrome.storage.local) {
          await new Promise((r) => chrome.storage.local.remove([
            'sleepwalker_persistent_memory_v1',
            'sleepwalker_embed_vectors_v1',
            'sleepwalker_session_state_v1',
            'sleepwalker_reminders_v1'
          ], () => { void chrome.runtime?.lastError; r(); }));
        }
        if (chrome.storage && chrome.storage.session) {
          await new Promise((r) => chrome.storage.session.remove(['sleepwalker_persistent_memory_v1', 'sleepwalker_session_state_v1'], () => { void chrome.runtime?.lastError; r(); }));
        }
      } else if (scope === 'reminders') {
        if (chrome.alarms && typeof chrome.alarms.clearAll === 'function') {
          try { await chrome.alarms.clearAll(); } catch (_e) {}
        }
        if (chrome.storage && chrome.storage.local) {
          await new Promise((r) => chrome.storage.local.remove(['sleepwalker_reminders_v1'], () => { void chrome.runtime?.lastError; r(); }));
        }
      } else if (chrome.storage && chrome.storage.local) {
        const d = await new Promise((r) => chrome.storage.local.get(['sleepwalker_persistent_memory_v1'], (items) => r(items || {})));
        const mem = d.sleepwalker_persistent_memory_v1;
        if (mem && typeof mem === 'object') {
          if (scope === 'recent') {
            mem.activities = [];
            mem.conversationTurns = [];
            mem.visitedPages = [];
            if (mem.shortTerm) {
              mem.shortTerm.recentCommands = [];
              mem.shortTerm.recentSearches = [];
              mem.shortTerm.currentPageSummary = '';
            }
          } else if (scope === 'tasks') {
            mem.activeTask = null;
            mem.recentTasks = [];
            if (mem.longTerm) mem.longTerm.completedTaskSummaries = [];
            if (mem.tabContexts) {
              for (const c of Object.values(mem.tabContexts)) { if (c) c.taskId = ''; }
            }
          } else if (scope === 'personal' || scope === 'preferences') {
            if (scope === 'preferences' && mem.personalContext) {
              mem.personalContext.preferences = {};
              mem.personalContext.learningSignals = {};
            } else if (self.SleepwalkerPersonalIntel) {
              mem.personalContext = self.SleepwalkerPersonalIntel.createDefaultPersonalContext();
            } else {
              mem.personalContext = {};
            }
            if (mem.longTerm) mem.longTerm.userPreferences = {};
          }
          await new Promise((r) => chrome.storage.local.set({ sleepwalker_persistent_memory_v1: mem }, () => { void chrome.runtime?.lastError; r(); }));
          if (chrome.storage.session) {
            await new Promise((r) => chrome.storage.session.set({ sleepwalker_persistent_memory_v1: mem }, () => { void chrome.runtime?.lastError; r(); }));
          }
        }
      }
      sendResponse({ ok: true, scope });
    })().catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }

  // Real chrome.alarms Reminder & Proactive Follow-Up Scheduling (Phase 5)
  if (message.type === 'SLEEPWALKER_REMINDER_SCHEDULE') {
    scheduleReminderAlarm(message.reminder || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || 'Schedule error' }));
    return true;
  }
  if (message.type === 'SLEEPWALKER_REMINDER_LIST') {
    reconcileReminderAlarms()
      .then((list) => sendResponse({ ok: true, reminders: list }))
      .catch((err) => sendResponse({ ok: false, reminders: [], error: (err && err.message) || 'List error' }));
    return true;
  }
  if (message.type === 'SLEEPWALKER_REMINDER_UPDATE') {
    updateReminderAlarm(message.id, message.patch || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || 'Update error' }));
    return true;
  }
  if (message.type === 'SLEEPWALKER_REMINDER_CANCEL' || message.type === 'SLEEPWALKER_REMINDER_COMPLETE') {
    const nextStatus = message.type === 'SLEEPWALKER_REMINDER_COMPLETE' ? 'completed' : 'cancelled';
    updateReminderStatus(message.id, message.query || '', nextStatus)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || 'Cancel/complete error' }));
    return true;
  }
  if (message.type === 'SLEEPWALKER_PERSONAL_CLASSIFY_REQUEST') {
    envReadyPromise
      .then(() => (typeof handlePersonalSignalRequest === 'function' ? handlePersonalSignalRequest(message.payload || message) : { status: 'fallback' }))
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ status: 'fallback' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_CHECK_HEALTH') {
    envReadyPromise
      .then(async () => {
        const [geminiHealth, ollamaEmbedHealth, stagehandHealth, nativeHealth, memState] = await Promise.all([
          typeof verifyGeminiConnection === 'function' ? verifyGeminiConnection(message.geminiApiKey || '') : Promise.resolve({ state: 'unavailable', detail: 'Verifier unavailable' }),
          typeof verifyOllamaAndEmbedStatus === 'function' ? verifyOllamaAndEmbedStatus(message.ollamaUrl || '', message.ollamaModel || '', { skipProbe: Boolean(message.skipProbe) }) : Promise.resolve({ ollama: { state: 'unavailable' }, embeddings: { state: 'unavailable' } }),
          checkStagehandBridgeHealth(message.stagehandBridgeUrl || STAGEHAND_DEFAULT_BRIDGE_URL).catch((err) => ({ ok: false, available: false, error: (err && err.message) || String(err) })),
          getNativeDesktopStatus().catch((err) => ({ available: false, error: (err && err.message) || String(err) })),
          chrome.storage && chrome.storage.local
            ? new Promise((r) => chrome.storage.local.get([
                'sleepwalker_persistent_memory_v1',
                'sleepwalker_memory_paused',
                'sleepwalker_disable_page_analysis',
                'sleepwalker_live_ws',
                'sleepwalker_local_only',
                'sleepwalker_enable_stagehand_adapter'
              ], (d) => r(d || {})))
            : Promise.resolve({})
        ]);
        const llmDiag = typeof getLlmDiagnostics === 'function' ? getLlmDiagnostics() : null;
        const commTelemetry = self.SLEEPWALKER_AI_COMM ? self.SLEEPWALKER_AI_COMM.getTelemetry() : null;
        const mem = memState.sleepwalker_persistent_memory_v1 || null;
        const extId = (chrome.runtime && chrome.runtime.id) || '';
        const extOrigin = typeof getExtensionOrigin === 'function' ? getExtensionOrigin() : (extId ? `chrome-extension://${extId}` : '');

        const stagehandEnabled = Boolean(
          message.stagehandEnabled !== undefined
            ? message.stagehandEnabled
            : memState.sleepwalker_enable_stagehand_adapter === true
        );
        const shAvailable = Boolean(stagehandHealth && (stagehandHealth.available === true || stagehandHealth.ok === true));
        const shRaw = (stagehandHealth && stagehandHealth.health) || stagehandHealth || {};
        const stagehandConn = {
          enabled: stagehandEnabled,
          available: shAvailable,
          state: shAvailable ? 'connected' : (stagehandEnabled ? 'unavailable' : 'disconnected'),
          bridgeUrl: message.stagehandBridgeUrl || STAGEHAND_DEFAULT_BRIDGE_URL,
          stagehandVersion: shRaw.stagehandVersion || null,
          cdpConnected: Boolean(shRaw.connected),
          cdpEndpoint: shRaw.cdpEndpoint || STAGEHAND_DEFAULT_CDP_URL,
          detail: shAvailable
            ? `Sidecar v${shRaw.stagehandVersion || '3.7.4'} ready (${shRaw.connected ? `CDP attached: ${shRaw.cdpEndpoint || '127.0.0.1:9222'}` : 'CDP idle until command'})`
            : (stagehandEnabled
                ? `Sidecar unreachable at ${ STAGEHAND_DEFAULT_BRIDGE_URL } (${stagehandHealth && stagehandHealth.error ? stagehandHealth.error : 'run start-sleepwalker.ps1 or node stagehand-bridge/server.mjs'})`
                : `Disabled in Options (${shAvailable ? 'sidecar online' : 'sidecar offline — fallback browser engine active'})`)
        };

        const natAvailable = Boolean(nativeHealth && nativeHealth.available === true);
        const natInfo = (nativeHealth && nativeHealth.result) || {};
        const nativeConn = {
          available: natAvailable,
          state: natAvailable ? 'connected' : 'unavailable',
          hostName: NATIVE_HOST_NAME,
          dpiAwareness: natInfo.dpiAwareness || null,
          detail: natAvailable
            ? `sleepwalker-native.exe connected (${natInfo.dpiAwareness || 'Win32 + UIA ready'})`
            : `Not connected (${(nativeHealth && nativeHealth.error) || 'run register-native-host.ps1 with current Extension ID'})`
        };

        sendResponse({
          status: 'ok',
          checkedAt: new Date().toISOString(),
          extensionId: extId,
          extensionOrigin: extOrigin,
          nativeRegisterCommand: extId
            ? `.\\register-native-host.ps1 -ExtensionId ${extId}`
            : '.\\register-native-host.ps1',
          connections: {
            geminiRest: geminiHealth,
            geminiLiveWs: {
              state: !memState.sleepwalker_live_ws ? 'disconnected' : (commTelemetry ? commTelemetry.liveWsState : 'disconnected'),
              enabled: Boolean(memState.sleepwalker_live_ws),
              sessions: (commTelemetry && commTelemetry.liveSessions) || []
            },
            ollama: ollamaEmbedHealth.ollama,
            embeddings: ollamaEmbedHealth.embeddings,
            stagehand: stagehandConn,
            nativeCompanion: nativeConn
          },
          privacy: {
            localOnly: Boolean(memState.sleepwalker_local_only),
            memoryPaused: Boolean(memState.sleepwalker_memory_paused),
            disablePageAnalysis: Boolean(memState.sleepwalker_disable_page_analysis)
          },
          memorySummary: mem ? {
            sessionMode: mem.sessionMode || 'ended',
            activities: (mem.activities || []).length,
            tabContexts: Object.keys(mem.tabContexts || {}).length,
            recentTasks: (mem.recentTasks || []).length,
            activeTask: mem.activeTask ? { id: mem.activeTask.id, objective: mem.activeTask.objective, status: mem.activeTask.status } : null,
            compressedSummaries: ((mem.longTerm && mem.longTerm.compressedSummaries) || []).length,
            approxBytes: JSON.stringify(mem).length
          } : { activities: 0, tabContexts: 0, recentTasks: 0, activeTask: null, approxBytes: 0 },
          llmDiagnostics: llmDiag,
          commTelemetry,
          worldModelTraces: Array.isArray(self._devWorldModelTraces) ? self._devWorldModelTraces.slice(-10) : []
        });
      })
      .catch((err) => sendResponse({ status: 'error', error: (err && err.message) || 'Health check failed' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_EMBED_REQUEST') {
    envReadyPromise
      .then(() => handleEmbedRequest(message))
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ status: 'unavailable', embedding: null }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_OFF_PAGE_RESEARCH_REQUEST') {
    envReadyPromise
      .then(() => handleOffPageResearchRequest(message.payload || message))
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ status: 'fallback' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_TASK_PLAN_REQUEST') {
    envReadyPromise
      .then(() => handleTaskPlanRequest(message.payload || message))
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ status: 'fallback', steps: [] }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_CANCEL_ACTIVE_LLM') {
    try {
      const taskId = message.taskId || (message.payload && message.payload.taskId) || '';
      const sessionId = (sender && sender.tab && sender.tab.id != null) ? `tab:${sender.tab.id}` : 'default';
      if (typeof cancelActiveLlmRequests === 'function') {
        cancelActiveLlmRequests(taskId ? { taskId } : {});
      }
      if (typeof SLEEPWALKER_AI_COMM !== 'undefined' && SLEEPWALKER_AI_COMM && typeof SLEEPWALKER_AI_COMM.cancelSession === 'function') {
        SLEEPWALKER_AI_COMM.cancelSession(sessionId, 'task_cancelled');
      }
      sendResponse({ ok: true, cancelled: true });
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || 'Cancel error' });
    }
    return true;
  }

  if (message.type === 'SLEEPWALKER_NLU_PLAN_REQUEST') {
    envReadyPromise
      .then(() => handleNluPlanRequest(message.payload || message))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ status: 'generation_failed', message: (err && err.message) || 'NLU request error.' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_UNIFIED_INTENT_REQUEST') {
    envReadyPromise
      .then(() => (typeof handleUnifiedIntentFallbackRequest === 'function'
        ? handleUnifiedIntentFallbackRequest(message.payload || message)
        : { status: 'unavailable', route: 'clarification' }))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ status: 'error', route: 'clarification', error: (err && err.message) || 'Intent fallback error' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_SUMMARIZE_PAGE') {
    envReadyPromise
      .then(() => (typeof handleWebpageSummaryRequest === 'function'
        ? handleWebpageSummaryRequest(message.payload || message)
        : { status: 'unavailable', summary: '' }))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ status: 'error', summary: '', error: (err && err.message) || 'Summary error' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_NLU_ESCALATE_REQUEST') {
    envReadyPromise
      .then(() => handleNluEscalationRequest(message.payload || message))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ status: 'generation_failed', message: (err && err.message) || 'NLU escalation error.' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_RECORD_DEV_TRACE' && message.trace) {
    self._devWorldModelTraces = self._devWorldModelTraces || [];
    self._devWorldModelTraces.push(message.trace);
    if (self._devWorldModelTraces.length > 20) self._devWorldModelTraces.shift();
    if (message.trace.usedFallbackPlanner && typeof recordOllamaOutcome === 'function') {
      recordOllamaOutcome('fallback_planner', 'fallback_planner', {
        detail: message.trace.ollamaErrorDetail || message.trace.ollamaStatus || 'Fallback planner used.'
      });
    }
    sendResponse({ status: 'ok', count: self._devWorldModelTraces.length });
    return false;
  }

  if (message.type === 'SLEEPWALKER_SET_ACTIVE_TAB') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId) {
      recordTabDirectoryEntry(tabId, {
        title: message.title || (sender.tab && sender.tab.title) || '',
        url: message.url || (sender.tab && sender.tab.url) || ''
      });
    }
    const sessionApi = (chrome.storage && chrome.storage.session) || chrome.storage.local;
    if (tabId && sessionApi) {
      activateSleepwalkerTabAndSleepOthers(tabId, sessionApi).then(() => {
        sendResponse({ status: 'ok', tabId });
      });
      return true;
    }
    sendResponse({ status: 'ok' });
    return false;
  }

  if (message.type === 'SLEEPWALKER_RETURN_TO_PREVIOUS_TAB') {
    const currentTabId = sender && sender.tab && sender.tab.id;
    const sessionApi = (chrome.storage && chrome.storage.session) || chrome.storage.local;
    if (!sessionApi || !chrome.tabs) {
      sendResponse({ ok: false, reason: 'unavailable' });
      return false;
    }
    sessionApi.get(['sleepwalker_prev_tab_stack'], async (data) => {
      const stack = Array.isArray(data && data.sleepwalker_prev_tab_stack)
        ? data.sleepwalker_prev_tab_stack.slice()
        : [];
      let targetTab = null;
      while (stack.length > 0) {
        const candId = Number(stack.pop());
        if (!Number.isInteger(candId) || candId === currentTabId) continue;
        const tabInfo = await new Promise((resolve) => {
          chrome.tabs.get(candId, (t) => {
            if (chrome.runtime?.lastError || !t || (t.url && isRestrictedUrl(t.url))) resolve(null);
            else resolve(t);
          });
        });
        if (tabInfo) {
          targetTab = tabInfo;
          break;
        }
      }
      if (!targetTab) {
        sessionApi.set({ sleepwalker_prev_tab_stack: stack }, () => { void chrome.runtime?.lastError; });
        sendResponse({ ok: false, reason: 'no_previous_tab' });
        return;
      }
      sessionApi.set({
        sleepwalker_active_tab_id: targetTab.id,
        sleepwalker_prev_tab_stack: stack
      }, () => {
        void chrome.runtime?.lastError;
        if (currentTabId && currentTabId !== targetTab.id) {
          chrome.tabs.sendMessage(currentTabId, { action: 'SLEEPWALKER_TAB_BACKGROUNDED', reason: 'returned_to_previous_tab' }, () => { void chrome.runtime?.lastError; });
        }
        chrome.tabs.update(targetTab.id, { active: true }, () => {
          void chrome.runtime?.lastError;
          if (typeof targetTab.windowId === 'number' && chrome.windows && chrome.windows.update) {
            chrome.windows.update(targetTab.windowId, { focused: true }, () => { void chrome.runtime?.lastError; });
          }
          chrome.tabs.sendMessage(targetTab.id, { action: 'SLEEPWALKER_SYNC_SESSION', isForegroundTab: true }, () => { void chrome.runtime?.lastError; });
          sendResponse({ ok: true, tabId: targetTab.id, title: targetTab.title || '', url: targetTab.url || '' });
        });
      });
    });
    return true;
  }

  // Open mic setup tab
  if (message.type === 'SLEEPWALKER_OPEN_MIC_SETUP') {
    chrome.tabs.create({ url: 'pages/mic-setup.html' });
    sendResponse({ status: 'opened' });
    return false;
  }

  if (message.type === 'SLEEPWALKER_OPEN_OPTIONS') {
    if (chrome.runtime && typeof chrome.runtime.openOptionsPage === 'function') chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: 'pages/options.html' });
    sendResponse({ status: 'opened' });
    return false;
  }

  // Open Document Shelf setup page (Route A extension-origin folder setup)
  if (message.type === 'SLEEPWALKER_OPEN_SHELF_SETUP') {
    chrome.tabs.create({ url: 'pages/shelf.html' });
    sendResponse({ status: 'opened' });
    return false;
  }

  // Inspect Route A Document Shelf status (IndexedDB handle)
  if (message.type === 'SLEEPWALKER_SHELF_STATUS') {
    const db = self.SleepwalkerShelfDB;
    if (!db) {
      sendResponse({ status: 'unavailable', connected: false });
      return false;
    }
    (async () => {
      const rec = await db.loadDirectoryRecord();
      if (!rec || !rec.dirHandle) {
        sendResponse({ status: 'not_connected', connected: false });
        return;
      }
      const permission = await db.checkHandlePermission(rec.dirHandle, { requestIfPrompt: false });
      if (permission !== 'granted') {
        sendResponse({ status: 'needs_reauth', connected: true, permission, folderName: rec.folderName || 'Document Shelf' });
        return;
      }
      const entries = await db.collectHandleFiles(rec.dirHandle, 200);
      sendResponse({ status: 'ok', connected: true, permission: 'granted', folderName: rec.folderName || 'Document Shelf', count: entries.length });
    })().catch((err) => {
      sendResponse({ status: 'error', connected: false, error: (err && err.message) || 'Shelf status error' });
    });
    return true;
  }

  // Match files inside Route A Document Shelf by voice query + accept filter
  if (message.type === 'SLEEPWALKER_SHELF_MATCH') {
    const db = self.SleepwalkerShelfDB;
    if (!db) {
      sendResponse({ status: 'unavailable' });
      return false;
    }
    (async () => {
      const rec = await db.loadDirectoryRecord();
      if (!rec || !rec.dirHandle) {
        sendResponse({ status: 'not_connected' });
        return;
      }
      const permission = await db.checkHandlePermission(rec.dirHandle, { requestIfPrompt: false });
      if (permission !== 'granted') {
        sendResponse({ status: 'needs_reauth', permission, folderName: rec.folderName || 'Document Shelf' });
        return;
      }
      const entries = await db.collectHandleFiles(rec.dirHandle, 200);
      const ranked = db.rankShelfEntries(entries, message.query || '', '', null);
      sendResponse({
        status: 'ok',
        folderName: rec.folderName || 'Document Shelf',
        matches: ranked.slice(0, 8).map((e) => ({ name: e.name, path: e.path, score: e.score }))
      });
    })().catch((err) => {
      sendResponse({ status: 'error', error: (err && err.message) || 'Shelf match error' });
    });
    return true;
  }

  // Read confirmed file bytes from Route A Document Shelf handle (user-confirmed only)
  if (message.type === 'SLEEPWALKER_SHELF_READ') {
    const db = self.SleepwalkerShelfDB;
    if (!db) {
      sendResponse({ ok: false, error: 'Shelf storage unavailable.' });
      return false;
    }
    (async () => {
      const rec = await db.loadDirectoryRecord();
      if (!rec || !rec.dirHandle) {
        sendResponse({ ok: false, reason: 'not_connected', error: 'No Document Shelf folder connected.' });
        return;
      }
      const permission = await db.checkHandlePermission(rec.dirHandle, { requestIfPrompt: false });
      if (permission !== 'granted') {
        sendResponse({ ok: false, reason: 'needs_reauth', error: 'Document Shelf permission needs re-tap in Setup.' });
        return;
      }
      const entries = await db.collectHandleFiles(rec.dirHandle, 200);
      const targetKey = String(message.path || message.name || '').toLowerCase();
      const hit = entries.find((e) => (e.path || e.name).toLowerCase() === targetKey || e.name.toLowerCase() === targetKey);
      if (!hit) {
        sendResponse({ ok: false, reason: 'not_found', error: `File "${message.name || targetKey}" not found in Document Shelf.` });
        return;
      }
      const payload = await db.readEntryTransferPayload(hit);
      sendResponse(payload);
    })().catch((err) => {
      sendResponse({ ok: false, error: (err && err.message) || 'Failed to read file from shelf.' });
    });
    return true;
  }

  // Top-level Extension Voice Relay Popup (Tier 2 fallback for Permissions-Policy: microphone=() & http:// sites)
  if (message.type === 'SLEEPWALKER_START_EXT_VOICE_RELAY') {
    const lang = message.lang || 'en-IN';
    if (sender && sender.tab && sender.tab.id) {
      self.__swVoiceRelayTargetTabId = sender.tab.id;
    }
    openOrControlVoiceRelayWindow('START', lang)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ status: 'error', message: (err && err.message) || 'Relay failed' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_PAUSE_EXT_VOICE_RELAY') {
    controlExistingVoiceRelay('PAUSE', message.lang)
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ status: 'paused' }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_STOP_EXT_VOICE_RELAY') {
    const closeWindow = Boolean(message.closeWindow);
    if (closeWindow && self.__swVoiceRelayWinId) {
      const winId = self.__swVoiceRelayWinId;
      self.__swVoiceRelayWinId = null;
      chrome.windows.remove(winId, () => { void chrome.runtime.lastError; });
      sendResponse({ status: 'closed' });
      return false;
    }
    controlExistingVoiceRelay('STOP', message.lang)
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ status: 'stopped' }));
    return true;
  }

  // Start offscreen voice recording
  if (message.type === 'SLEEPWALKER_START_OFFSCREEN_VOICE') {
    if (sender && sender.tab && sender.tab.id) {
      self.__swVoiceRelayTargetTabId = sender.tab.id;
    }
    ensureOffscreenDocument()
      .then(() => {
        chrome.runtime.sendMessage({
          type: 'START_OFFSCREEN_SPEECH_RECOGNITION',
          lang: message.lang || 'en-IN'
        }, (res) => {
          sendResponse(res || { status: 'started' });
        });
      })
      .catch((err) => {
        console.warn('[Sleepwalker SW] Failed to initialize offscreen doc:', err);
        sendResponse({ status: 'unsupported', reason: err.message });
      });
    return true;
  }

  // Stop offscreen voice recording
  if (message.type === 'SLEEPWALKER_STOP_OFFSCREEN_VOICE') {
    chrome.runtime.sendMessage({ type: 'STOP_OFFSCREEN_SPEECH_RECOGNITION' }, (res) => {
      sendResponse(res || { status: 'stopped' });
    });
    return true;
  }

  // Relay extension voice-relay / offscreen events directly to the target webpage tab (never to the popup window itself!)
  if (message.type === 'OFFSCREEN_TRANSCRIPT' || message.type === 'OFFSCREEN_ERROR' || message.type === 'OFFSCREEN_STATE_CHANGE') {
    const forwardToTab = (tabId) => {
      if (!tabId) return;
      chrome.tabs.sendMessage(tabId, message).catch(() => {});
    };
    if (self.__swVoiceRelayTargetTabId) {
      chrome.tabs.get(self.__swVoiceRelayTargetTabId, (tab) => {
        if (!chrome.runtime.lastError && tab && tab.id) {
          forwardToTab(tab.id);
        } else {
          self.__swVoiceRelayTargetTabId = null;
          chrome.tabs.query({ active: true, windowType: 'normal' }, (tabs) => {
            if (tabs && tabs[0] && tabs[0].id) forwardToTab(tabs[0].id);
          });
        }
      });
    } else {
      chrome.tabs.query({ active: true, windowType: 'normal' }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) forwardToTab(tabs[0].id);
      });
    }
    return false;
  }

  // Phase 4.4 Deterministic Tab & URL Fast-Path Operations (zero-LLM Chrome APIs)
  if (message.type === 'SLEEPWALKER_TAB_ACTION') {
    handleTabActionRequest(message.action || message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || 'Tab action failed.' }));
    return true;
  }

  // Phase 4.4 Navigation completion check on active/sender tab
  if (message.type === 'SLEEPWALKER_WAIT_TAB_READY') {
    waitForTabLoadComplete((sender && sender.tab && sender.tab.id) || message.tabId, message.timeoutMs || 3500)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, status: 'timeout' }));
    return true;
  }

  // Phase 4.4 Conditional Visual Fallback (captureVisibleTab preserving activeTab & hiding overlay)
  if (message.type === 'SLEEPWALKER_VISUAL_GROUND_REQUEST') {
    handleVisualGroundMessage(message.payload || message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ status: 'vision_failed', usedVision: false, error: (err && err.message) || 'Visual grounding failed.' }));
    return true;
  }

  // User-triggered clean tab screenshot ("take screenshot" / "take a picture")
  if (message.type === 'SLEEPWALKER_CAPTURE_SCREENSHOT') {
    handleUserScreenshotCapture(sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || 'Screenshot capture failed.' }));
    return true;
  }

  // Phase 12A: Genuine Browser-Level Input Bridge (Chrome Debugger Protocol)
  if (message.type === 'SLEEPWALKER_ATTACH_DEBUGGER') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    attachTabDebugger(tabId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_DETACH_DEBUGGER') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    detachTabDebugger(tabId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_CDP_INPUT') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    dispatchCdpInputAction(tabId, message.action || message.payload || {})
      .then((res) => sendResponse({ ok: true, result: res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_DEBUGGER_STATUS') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    sendResponse({
      ok: true,
      attached: attachedDebuggerTabs.has(tabId),
      ownership: cdpOwnershipManager ? cdpOwnershipManager.getState(tabId) : null
    });
    return true;
  }

  // Stage 2.1: Real Stagehand Sidecar Bridge + Deterministic CDP Single-Owner Handoff
  if (message.type === 'SLEEPWALKER_STAGEHAND_HEALTH') {
    checkStagehandBridgeHealth(message.bridgeUrl, { force: Boolean(message.force) })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, available: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_STAGEHAND_EXECUTE') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    const tabUrl = (sender && sender.tab && sender.tab.url) || message.url || null;
    executeStagehandOperation(tabId, { ...(message.payload || message), url: message.url || tabUrl })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
        code: (err && err.code) || 'STAGEHAND_EXECUTE_ERROR',
        ownership: cdpOwnershipManager ? cdpOwnershipManager.getState(tabId) : null
      }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_STAGEHAND_CANCEL') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    if (tabId) {
      pendingUnifiedNavByTab.delete(tabId);
      lastNavVerificationByTab.delete(tabId);
      persistTabNavRecordToSession(tabId, null).catch(() => {});
    }
    cancelStagehandOperation(tabId, message.commandId || null, message.bridgeUrl)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_CDP_OWNERSHIP_STATE') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    sendResponse({
      ok: true,
      state: cdpOwnershipManager ? cdpOwnershipManager.getState(tabId) : null,
      history: cdpOwnershipManager ? cdpOwnershipManager.getHistory(tabId) : [],
      lastStagehandResult: lastStagehandResultByTab.get(tabId) || null,
      lastNavVerification: lastNavVerificationByTab.get(tabId) || null
    });
    return true;
  }

  if (message.type === 'SLEEPWALKER_RECORD_PENDING_NAV') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    if (tabId) {
      const rec = {
        tabId,
        commandId: message.commandId || null,
        taskId: message.taskId || null,
        rawText: String(message.rawText || ''),
        intent: message.intent || null,
        action: message.action || null,
        expectedState: message.expectedState || null,
        intendedEngine: message.intendedEngine || 'existing_browser_engine',
        urlBefore: message.urlBefore || (sender && sender.tab && sender.tab.url) || null,
        continuation: (message.continuation && typeof message.continuation === 'object') ? message.continuation : null,
        ts: Date.now(),
        updatedAt: Date.now()
      };
      pendingUnifiedNavByTab.set(tabId, rec);
      persistTabNavRecordToSession(tabId, rec).catch(() => {});
    }
    sendResponse({ ok: true, tabId: tabId || null });
    return true;
  }

  if (message.type === 'SLEEPWALKER_CLEAR_PENDING_NAV') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    if (tabId) {
      const matchesCmd = (recCmd) => !message.commandId || !recCmd || recCmd === message.commandId || String(recCmd).startsWith(`${message.commandId}-`);
      const cur = pendingUnifiedNavByTab.get(tabId);
      if (!cur || matchesCmd(cur.commandId)) {
        pendingUnifiedNavByTab.delete(tabId);
      }
      const curVer = lastNavVerificationByTab.get(tabId);
      if (!curVer || matchesCmd(curVer.commandId)) {
        lastNavVerificationByTab.delete(tabId);
        persistTabNavRecordToSession(tabId, null).catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'SLEEPWALKER_CONSUME_NAV_VERIFICATION') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    (async () => {
      // If a Stagehand operation is still finishing atomic post-nav /verify on this tab, wait briefly so we merge its proof cleanly
      if (tabId && activeStagehandAbortByTab.has(tabId)) {
        const deadline = Date.now() + 2500;
        while (activeStagehandAbortByTab.has(tabId) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 45));
        }
      }
      const record = await consumeTabNavRecordFromSession(tabId);
      sendResponse({ ok: true, tabId: tabId || null, record });
    })().catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err), record: null }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_DESKTOP_EXECUTE') {
    executeNativeDesktopAction(message.request || message.payload || message)
      .then((res) => sendResponse(res))
      .catch((err) => {
        const req = message.request || message.payload || message || {};
        const cid = req.commandId || req.requestId || 'err';
        sendResponse({
          taskId: req.taskId || cid,
          commandId: cid,
          requestId: cid,
          success: false,
          status: 'FAILED',
          error: err.message,
          executionTimeMs: 0
        });
      });
    return true;
  }

  if (message.type === 'SLEEPWALKER_DESKTOP_CANCEL') {
    const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    if (tabId) {
      pendingUnifiedNavByTab.delete(tabId);
      lastNavVerificationByTab.delete(tabId);
      persistTabNavRecordToSession(tabId, null).catch(() => {});
    }
    executeNativeDesktopAction({
      taskId: message.taskId || `cancel-${Date.now()}`,
      commandId: `cancel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      action: 'cancel_command',
      target: {
        targetCommandId: message.targetCommandId || message.commandId || null,
        targetTaskId: message.targetTaskId || message.taskId || null
      },
      timeout: 3000
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, status: 'FAILED', error: err.message }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_DESKTOP_EMERGENCY_STOP') {
    // Purge all pending cross-page continuations immediately on Emergency Stop
    pendingUnifiedNavByTab.clear();
    lastNavVerificationByTab.clear();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
      chrome.storage.session.remove([SESSION_NAV_STORAGE_KEY]).catch(() => {});
    }
    executeNativeDesktopAction({
      taskId: message.taskId || `estop-${Date.now()}`,
      commandId: `estop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      action: 'emergency_stop',
      target: { text: message.reason || 'Emergency stop triggered from extension' },
      timeout: 3000
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, status: 'FAILED', error: err.message }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_DESKTOP_RESET_EMERGENCY_STOP') {
    (async () => {
      // Refuse reset if an active browser/Stagehand operation is still running
      if (activeStagehandAbortByTab.size > 0) {
        sendResponse({
          ok: false,
          success: false,
          status: 'UNSAFE_INPUT_IN_PROGRESS',
          error: 'Cannot reset Emergency Stop while a Stagehand browser operation is still in progress.'
        });
        return;
      }

      // Inspect native companion safety state first to ensure no active desktop input operation remains in progress
      const safetyProbe = await executeNativeDesktopAction({
        taskId: `safety-probe-${Date.now()}`,
        commandId: `safety-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        action: 'get_safety_state',
        target: {},
        timeout: 2500
      }).catch(() => null);

      const st = safetyProbe && safetyProbe.result ? safetyProbe.result : null;
      if (st && (Number(st.activeCommandCount) > 0 || st.inputLockBusy === true)) {
        sendResponse({
          ok: false,
          success: false,
          status: 'UNSAFE_INPUT_IN_PROGRESS',
          error: 'Cannot reset Emergency Stop while an active desktop input operation remains in progress.',
          safetyState: st
        });
        return;
      }

      const resetRes = await executeNativeDesktopAction({
        taskId: message.taskId || `reset-estop-${Date.now()}`,
        commandId: `reset-estop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        action: 'reset_emergency_stop',
        target: {},
        timeout: 3000
      }).catch((err) => ({ success: false, status: 'FAILED', error: err.message }));

      // Broadcast reset to open extension content scripts so every tab clears emergencyStopActive cleanly
      if (chrome.tabs && typeof chrome.tabs.query === 'function') {
        try {
          const tabs = await chrome.tabs.query({});
          for (const t of tabs) {
            if (t.id && !(t.url && t.url.startsWith('chrome-extension://'))) {
              chrome.tabs.sendMessage(t.id, { action: 'SLEEPWALKER_EMERGENCY_STOP_CLEARED' }, () => {
                void chrome.runtime?.lastError;
              });
            }
          }
        } catch (_e) {}
      }

      sendResponse({
        ok: true,
        success: resetRes.success !== false,
        status: resetRes.status || 'COMPLETED',
        nativeReset: resetRes
      });
    })().catch((err) => sendResponse({ ok: false, success: false, status: 'FAILED', error: (err && err.message) || String(err) }));
    return true;
  }

  if (message.type === 'SLEEPWALKER_DESKTOP_STATUS') {
    getNativeDesktopStatus()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ available: false, error: err.message }));
    return true;
  }
});

/**
 * Capture visible screenshot while hiding Sleepwalker UI overlay cleanly, then restore
 * in finally and evaluate via handleVisualGroundRequest (preserving activeTab constraints).
 */
async function handleVisualGroundMessage(payload = {}, sender = null) {
  let tabId = (sender && sender.tab && sender.tab.id) || payload.tabId || null;
  let windowId = (sender && sender.tab && sender.tab.windowId) || undefined;
  if (!tabId && chrome.tabs && typeof chrome.tabs.query === 'function') {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active) {
        tabId = active.id;
        windowId = active.windowId;
      }
    } catch (_e) {}
  }

  if (tabId && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
    await new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, { action: 'SLEEPWALKER_PREPARE_SCREENSHOT' }, () => {
          void chrome.runtime?.lastError;
          resolve();
        });
      } catch (_e) { resolve(); }
    });
    await new Promise((r) => setTimeout(r, 45));
  }

  let dataUrl = '';
  try {
    if (!chrome.tabs || typeof chrome.tabs.captureVisibleTab !== 'function') {
      return { status: 'capture_unavailable', usedVision: false, grounding: null };
    }
    dataUrl = windowId !== undefined
      ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      : await chrome.tabs.captureVisibleTab({ format: 'png' });
  } catch (err) {
    return {
      status: 'capture_blocked',
      usedVision: false,
      grounding: null,
      reason: (err && err.message) || 'activeTab capture permission not available for this tab.'
    };
  } finally {
    if (tabId && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
      try {
        chrome.tabs.sendMessage(tabId, { action: 'SLEEPWALKER_RESTORE_SCREENSHOT' }, () => {
          void chrome.runtime?.lastError;
        });
      } catch (_e) {}
    }
  }

  if (typeof handleVisualGroundRequest !== 'function') {
    return { status: 'vision_handler_missing', usedVision: false, grounding: null };
  }
  return handleVisualGroundRequest({
    ...payload,
    imageBase64: dataUrl,
    mimeType: 'image/png'
  });
}

/**
 * Capture a clean PNG screenshot of the active tab (temporarily hiding Sleepwalker's floating UI).
 */
async function handleUserScreenshotCapture(sender = null) {
  let tabId = (sender && sender.tab && sender.tab.id) || null;
  let windowId = (sender && sender.tab && sender.tab.windowId) || undefined;
  let tabTitle = (sender && sender.tab && sender.tab.title) || 'page';
  if (!tabId && chrome.tabs && typeof chrome.tabs.query === 'function') {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active) {
        tabId = active.id;
        windowId = active.windowId;
        tabTitle = active.title || tabTitle;
      }
    } catch (_e) {}
  }

  if (tabId && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
    await new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, { action: 'SLEEPWALKER_PREPARE_SCREENSHOT' }, () => {
          void chrome.runtime?.lastError;
          resolve();
        });
      } catch (_e) { resolve(); }
    });
    await new Promise((r) => setTimeout(r, 70));
  }

  let dataUrl = '';
  try {
    if (!chrome.tabs || typeof chrome.tabs.captureVisibleTab !== 'function') {
      return { ok: false, error: 'Tab screenshot capture is unavailable in this browser.' };
    }
    dataUrl = windowId !== undefined
      ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      : await chrome.tabs.captureVisibleTab({ format: 'png' });
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not capture this tab.' };
  } finally {
    if (tabId && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
      try {
        chrome.tabs.sendMessage(tabId, { action: 'SLEEPWALKER_RESTORE_SCREENSHOT' }, () => {
          void chrome.runtime?.lastError;
        });
      } catch (_e) {}
    }
  }

  const slug = String(tabTitle || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'page';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    ok: true,
    dataUrl,
    filename: `sleepwalker-${slug}-${stamp}.png`
  };
}

/**
 * Maintain lightweight tab metadata index for least-privilege (`activeTab`) tab switching.
 */
const swTabDirectory = new Map();

function recordTabDirectoryEntry(tabId, info = {}) {
  if (!tabId) return;
  const prev = swTabDirectory.get(tabId) || { tabId };
  swTabDirectory.set(tabId, {
    tabId,
    title: String(info.title || prev.title || '').trim(),
    url: String(info.url || prev.url || '').trim(),
    updatedAt: Date.now()
  });
}

async function resolveTabMetadata(tab) {
  if (!tab || !tab.id) return { tabId: tab && tab.id, title: '', url: '' };
  if (tab.title || tab.url) {
    recordTabDirectoryEntry(tab.id, { title: tab.title, url: tab.url });
    return { tabId: tab.id, title: tab.title || '', url: tab.url || '' };
  }
  const cached = swTabDirectory.get(tab.id);
  if (cached && (cached.title || cached.url)) return cached;

  // Fallback: query persistent memory tabContexts or ping content script inside tab
  if (chrome.storage && chrome.storage.local) {
    try {
      const memData = await new Promise((resolve) => {
        chrome.storage.local.get(['sleepwalker_persistent_memory_v1'], (d) => {
          void chrome.runtime?.lastError;
          resolve(d || {});
        });
      });
      const mem = memData && memData.sleepwalker_persistent_memory_v1;
      if (mem && mem.tabContexts && typeof mem.tabContexts === 'object') {
        for (const ctx of Object.values(mem.tabContexts)) {
          if (ctx && Number(ctx.tabId) === Number(tab.id) && (ctx.title || ctx.url)) {
            recordTabDirectoryEntry(tab.id, { title: ctx.title, url: ctx.url });
            return { tabId: tab.id, title: ctx.title || '', url: ctx.url || '' };
          }
        }
      }
    } catch (_e) {}
  }

  if (chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
    const pinged = await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 120);
      try {
        chrome.tabs.sendMessage(tab.id, { action: 'SLEEPWALKER_PING_TAB_INFO' }, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          void chrome.runtime?.lastError;
          resolve(res || null);
        });
      } catch (_e) {
        if (!done) { done = true; clearTimeout(timer); resolve(null); }
      }
    });
    if (pinged && (pinged.title || pinged.url)) {
      recordTabDirectoryEntry(tab.id, pinged);
      return { tabId: tab.id, title: pinged.title || '', url: pinged.url || '' };
    }
  }
  return { tabId: tab.id, title: '', url: '' };
}

/**
 * Phase 4.4: Deterministic Fast-Path Chrome tab operations (no LLM call).
 */
async function handleTabActionRequest(req = {}, sender = null) {
  const kind = String(req.type || '').toLowerCase();
  const senderTabId = (sender && sender.tab && sender.tab.id) || req.tabId || null;
  if (senderTabId && sender && sender.tab) {
    recordTabDirectoryEntry(senderTabId, { title: sender.tab.title, url: sender.tab.url });
  }

  if (kind === 'tab_new') {
    const createOpts = { active: true };
    if (req.url && /^https?:\/\//i.test(req.url)) createOpts.url = req.url;
    const created = await chrome.tabs.create(createOpts);
    return { ok: true, action: 'tab_new', tabId: created && created.id, url: (created && created.url) || createOpts.url || '' };
  }

  if (kind === 'open_url') {
    const targetUrl = String(req.url || '').trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      return { ok: false, action: 'open_url', error: 'Invalid URL scheme.' };
    }
    let tabId = senderTabId;
    if (!tabId) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = active && active.id;
    }
    if (!tabId) {
      const created = await chrome.tabs.create({ url: targetUrl, active: true });
      return { ok: true, action: 'open_url', tabId: created && created.id, url: targetUrl };
    }
    const updated = await chrome.tabs.update(tabId, { url: targetUrl });
    return { ok: true, action: 'open_url', tabId: (updated && updated.id) || tabId, url: targetUrl };
  }

  if (kind === 'tab_close') {
    let tabId = senderTabId;
    if (!tabId) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = active && active.id;
    }
    if (!tabId) return { ok: false, action: 'tab_close', error: 'No active tab to close.' };
    swTabDirectory.delete(tabId);
    // Resolve the sender's runtime message before closing its tab. Awaiting
    // removal first destroys the sending content-script context and can leave
    // its sendMessage callback pending forever.
    chrome.tabs.remove(tabId).catch(() => {});
    return { ok: true, action: 'tab_close', closedTabId: tabId };
  }

  if (kind === 'tab_step') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    if (!Array.isArray(tabs) || tabs.length < 2) {
      return { ok: false, action: 'tab_step', error: 'Only one tab is open in this window.' };
    }
    const curIdx = tabs.findIndex((t) => (senderTabId ? t.id === senderTabId : t.active));
    const delta = Number(req.delta) >= 0 ? 1 : -1;
    const nextIdx = ((curIdx >= 0 ? curIdx : 0) + delta + tabs.length) % tabs.length;
    const picked = tabs[nextIdx];
    await chrome.tabs.update(picked.id, { active: true });
    const meta = await resolveTabMetadata(picked);
    return { ok: true, action: 'tab_step', tabId: picked.id, title: meta.title || '', url: meta.url || '' };
  }

  if (kind === 'tab_switch') {
    const winTabs = await chrome.tabs.query({ currentWindow: true });
    const allTabs = winTabs.length > 0 ? winTabs : await chrome.tabs.query({});
    let targetTab = null;

    if (typeof req.index === 'number' && Number.isFinite(req.index)) {
      targetTab = winTabs[req.index] || allTabs[req.index] || null;
    } else if (req.query) {
      const q = String(req.query || '').trim().toLowerCase();
      const qToks = q.split(/\s+/).filter(Boolean);
      const searchPool = await chrome.tabs.query({});
      let bestScore = 0;
      for (const t of searchPool) {
        if (!t) continue;
        const meta = await resolveTabMetadata(t);
        const tTitle = String(meta.title || '').toLowerCase();
        const tUrl = String(meta.url || '').toLowerCase();
        const hay = `${tTitle} ${tUrl}`;
        let score = 0;
        if (tTitle === q) score += 100;
        else if (tTitle.includes(q)) score += 70;
        else if (tUrl.includes(q)) score += 60;
        else {
          for (const tok of qToks) {
            if (hay.includes(tok)) score += 20;
          }
        }
        if (senderTabId && t.id === senderTabId) score -= 5; // Prefer switching to a different matching tab
        if (score > bestScore) {
          bestScore = score;
          targetTab = { ...t, title: meta.title, url: meta.url };
        }
      }
      if (bestScore < 20) targetTab = null;
    }

    if (!targetTab) {
      return { ok: false, action: 'tab_switch', error: `Could not find an open tab matching "${req.query || req.index}".` };
    }
    await chrome.tabs.update(targetTab.id, { active: true });
    if (typeof targetTab.windowId === 'number' && chrome.windows && typeof chrome.windows.update === 'function') {
      try { await chrome.windows.update(targetTab.windowId, { focused: true }); } catch (_e) {}
    }
    return { ok: true, action: 'tab_switch', tabId: targetTab.id, title: targetTab.title || '', url: targetTab.url || '' };
  }

  if (kind === 'tab_list') {
    const winTabs = await chrome.tabs.query({ currentWindow: true });
    const tabs = [];
    for (const t of (winTabs || []).slice(0, 25)) {
      const meta = await resolveTabMetadata(t);
      tabs.push({ id: t.id, title: meta.title || t.title || '', url: meta.url || t.url || '', active: Boolean(t.active) });
    }
    return { ok: true, action: 'tab_list', count: tabs.length, tabs };
  }

  return { ok: false, action: kind, error: 'Unsupported tab action.' };
}

async function waitForTabLoadComplete(tabId, timeoutMs = 3500) {
  if (!tabId || !chrome.tabs || typeof chrome.tabs.get !== 'function') {
    return { ok: false, status: 'unavailable' };
  }
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 3500);
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === 'complete') {
        return { ok: true, status: 'complete', url: tab.url || '', title: tab.title || '' };
      }
    } catch (_e) {
      return { ok: false, status: 'tab_unavailable' };
    }
    await new Promise((r) => setTimeout(r, 70));
  }
  return { ok: false, status: 'timeout' };
}

/**
 * Ensure the offscreen document is created for USER_MEDIA reasons.
 */
async function controlExistingVoiceRelay(action, lang = 'en-IN') {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'EXT_RELAY_CONTROL', action, lang }, (res) => {
      void chrome.runtime.lastError;
      resolve(res || { ok: false });
    });
  });
}

async function openOrControlVoiceRelayWindow(action = 'START', lang = 'en-IN') {
  if (self.__swVoiceRelayWinId) {
    const exists = await new Promise((resolve) => {
      chrome.windows.get(self.__swVoiceRelayWinId, (win) => {
        if (chrome.runtime.lastError || !win) resolve(false);
        else resolve(true);
      });
    });
    if (exists) {
      await controlExistingVoiceRelay(action, lang);
      return { status: 'started', reused: true };
    }
    self.__swVoiceRelayWinId = null;
  }

  self.__swVoiceRelayOpening = true;
  let created;
  try {
    created = await new Promise((resolve, reject) => {
      chrome.windows.create(
        {
          url: `pages/voice-relay.html?lang=${encodeURIComponent(lang)}`,
          type: 'popup',
          width: 320,
          height: 145,
          focused: true
        },
        (win) => {
          if (chrome.runtime.lastError || !win) {
            reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Could not open voice relay window'));
          } else {
            resolve(win);
          }
        }
      );
    });
  } finally {
    self.__swVoiceRelayOpening = false;
  }
  self.__swVoiceRelayWinId = created.id;
  self.__swVoiceRelayTabId = (created.tabs && created.tabs[0] && created.tabs[0].id) || null;
  return { status: 'started', windowId: created.id };
}

if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((winId) => {
    if (self.__swVoiceRelayWinId === winId) {
      self.__swVoiceRelayWinId = null;
      self.__swVoiceRelayTabId = null;
    }
  });
}

async function ensureOffscreenDocument() {
  if (typeof chrome.offscreen === 'undefined') {
    throw new Error('chrome.offscreen API not available in this browser version');
  }

  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;

  await chrome.offscreen.createDocument({
    url: 'pages/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Offscreen speech recognition evaluation for voice assistant'
  });
}

// Open onboarding mic setup page upon first extension install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'pages/mic-setup.html' });
  }
});

async function activateSleepwalkerTabAndSleepOthers(activeTabId, storeOverride = null) {
  const store = storeOverride || ((chrome.storage && (chrome.storage.session || chrome.storage.local)) || null);
  if (!store || !Number.isInteger(activeTabId)) return;

  // Silently pre-warm the local Ollama model (keeping num_ctx: 16384) while user starts speaking
  if (typeof prewarmOllamaModel === 'function' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['ollamaUrl', 'ollamaModel'], (cfg) => {
      prewarmOllamaModel((cfg && cfg.ollamaUrl) || 'http://localhost:11434', (cfg && cfg.ollamaModel) || 'qwen2.5:1.5b').catch(() => {});
    });
  }

  const prev = await new Promise((resolve) => {
    store.get(['sleepwalker_active_tab_id', 'sleepwalker_prev_tab_stack'], (d) => {
      void chrome.runtime?.lastError;
      resolve(d || {});
    });
  });

  const oldTabId = prev && Number(prev.sleepwalker_active_tab_id);
  let stack = Array.isArray(prev && prev.sleepwalker_prev_tab_stack)
    ? prev.sleepwalker_prev_tab_stack.filter((id) => Number.isInteger(id) && id !== activeTabId)
    : [];
  if (Number.isInteger(oldTabId) && oldTabId !== activeTabId) {
    stack = stack.filter((id) => id !== oldTabId);
    stack.push(oldTabId);
    if (stack.length > 12) stack = stack.slice(-12);
  }

  await new Promise((resolve) => {
    store.set({
      sleepwalker_active_tab_id: activeTabId,
      sleepwalker_prev_tab_stack: stack
    }, () => {
      void chrome.runtime?.lastError;
      resolve();
    });
  });

  // Put ALL other webpage tabs' Sleepwalker instances calmly to sleep (without closing them!)
  if (chrome.tabs && typeof chrome.tabs.query === 'function') {
    chrome.tabs.query({}, (allTabs) => {
      void chrome.runtime?.lastError;
      for (const t of (allTabs || [])) {
        if (!t || !Number.isInteger(t.id) || t.id === activeTabId) continue;
        if (self.__swVoiceRelayTabId && t.id === self.__swVoiceRelayTabId) continue;
        if (t.url && isRestrictedUrl(t.url)) continue;
        chrome.tabs.sendMessage(t.id, { action: 'SLEEPWALKER_TAB_BACKGROUNDED', activeTabId }, () => {
          void chrome.runtime?.lastError;
        });
      }
    });
  } else if (Number.isInteger(oldTabId) && oldTabId !== activeTabId && chrome.tabs && chrome.tabs.sendMessage) {
    chrome.tabs.sendMessage(oldTabId, { action: 'SLEEPWALKER_TAB_BACKGROUNDED', activeTabId }, () => {
      void chrome.runtime?.lastError;
    });
  }
}

// Multi-tab microphone arbitration & cross-redirect / slow-page session sync
if (typeof chrome !== 'undefined' && chrome.tabs) {
  const getSessionStore = () => (chrome.storage && (chrome.storage.session || chrome.storage.local)) || null;

  const recoverMissingContentScriptSync = (tabId, isForegroundTab) => {
    if (!chrome.tabs || !chrome.scripting || !chrome.scripting.executeScript) return;
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime?.lastError || !tab || (tab.url && isRestrictedUrl(tab.url))) return;
      chrome.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPT_FILES
      }).then(() => {
        chrome.tabs.sendMessage(tabId, { action: 'SLEEPWALKER_SYNC_SESSION', isForegroundTab }, () => {
          void chrome.runtime?.lastError;
        });
      }).catch(() => {});
    });
  };

  if (chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener((activeInfo) => {
      const store = getSessionStore();
      if (!store || !activeInfo || !activeInfo.tabId) return;
      // Ignore extension popup/helper tabs (e.g. voice-relay.html, mic-setup.html) so they never background-pause the real webpage tab!
      if (
        self.__swVoiceRelayOpening ||
        (self.__swVoiceRelayWinId && activeInfo.windowId === self.__swVoiceRelayWinId) ||
        (self.__swVoiceRelayTabId && activeInfo.tabId === self.__swVoiceRelayTabId)
      ) {
        return;
      }
      chrome.tabs.get(activeInfo.tabId, (activatedTab) => {
        if (chrome.runtime?.lastError || !activatedTab || (activatedTab.url && isRestrictedUrl(activatedTab.url))) {
          return;
        }
        store.get(['sleepwalker_session_state_v1'], (data) => {
          const sess = data && data.sleepwalker_session_state_v1;
          const activeModes = ['active_listening', 'active_not_listening', 'paused'];
          if (!sess || !activeModes.includes(sess.sessionMode)) return;

          activateSleepwalkerTabAndSleepOthers(activeInfo.tabId, store).then(() => {
            chrome.tabs.sendMessage(activeInfo.tabId, { action: 'SLEEPWALKER_SYNC_SESSION', isForegroundTab: true }, () => {
              if (chrome.runtime.lastError) {
                recoverMissingContentScriptSync(activeInfo.tabId, true);
              }
            });
          });
        });
      });
    });
  }

  if (chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((removedTabId) => {
      const store = getSessionStore();
      if (!store) return;
      store.get(['sleepwalker_active_tab_id', 'sleepwalker_prev_tab_stack'], (data) => {
        const patch = {};
        if (data && data.sleepwalker_active_tab_id === removedTabId) {
          store.remove(['sleepwalker_active_tab_id'], () => { void chrome.runtime?.lastError; });
        }
        if (data && Array.isArray(data.sleepwalker_prev_tab_stack) && data.sleepwalker_prev_tab_stack.includes(removedTabId)) {
          patch.sleepwalker_prev_tab_stack = data.sleepwalker_prev_tab_stack.filter((id) => id !== removedTabId);
          store.set(patch, () => { void chrome.runtime?.lastError; });
        }
      });
    });
  }

  if (chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!changeInfo || changeInfo.status !== 'complete' || !tab) return;
      if (tab.url && isRestrictedUrl(tab.url)) return;
      const store = getSessionStore();
      if (!store) return;
      store.get(['sleepwalker_session_state_v1'], (data) => {
        const sess = data && data.sleepwalker_session_state_v1;
        const activeModes = ['active_listening', 'active_not_listening', 'paused'];
        if (!sess || !activeModes.includes(sess.sessionMode)) return;
        chrome.tabs.sendMessage(tabId, { action: 'SLEEPWALKER_SYNC_SESSION', isForegroundTab: Boolean(tab.active) }, () => {
          void chrome.runtime.lastError;
        });
      });
    });
  }
}

// ===== Phase 5: Real chrome.alarms Reminder & Scheduled Follow-Up Engine =====
const REMINDERS_STORAGE_KEY = 'sleepwalker_reminders_v1';
const REMINDER_ALARM_PREFIX = 'sw_rem_';

function loadReminders() {
  if (!chrome.storage || !chrome.storage.local) return Promise.resolve([]);
  return new Promise((resolve) => {
    chrome.storage.local.get([REMINDERS_STORAGE_KEY], (data) => {
      void chrome.runtime?.lastError;
      resolve(Array.isArray(data && data[REMINDERS_STORAGE_KEY]) ? data[REMINDERS_STORAGE_KEY] : []);
    });
  });
}

function saveReminders(list) {
  if (!chrome.storage || !chrome.storage.local) return Promise.resolve([]);
  const bounded = (Array.isArray(list) ? list : []).slice(-30);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [REMINDERS_STORAGE_KEY]: bounded }, () => {
      void chrome.runtime?.lastError;
      resolve(bounded);
    });
  });
}

async function syncReminderBadge(reminders) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  const dueCount = (reminders || []).filter((r) => r && r.status === 'due').length;
  try {
    chrome.action.setBadgeText({ text: dueCount > 0 ? String(dueCount) : '' });
    if (dueCount > 0 && chrome.action.setBadgeBackgroundColor) {
      chrome.action.setBadgeBackgroundColor({ color: '#d99b26' });
    }
  } catch (_e) {}
}

async function scheduleReminderAlarm(rawRem = {}) {
  const title = String(rawRem.title || '').trim().slice(0, 140);
  if (!title) return { ok: false, error: 'Missing reminder title.' };
  if (rawRem.authorized !== true) {
    return { ok: false, error: 'Explicit user authorization required before scheduling.' };
  }

  const now = Date.now();
  const targetTimeMs = Number(rawRem.targetTimeMs) || (now + 86400000);
  const when = Math.max(now + 1000, targetTimeMs);
  const id = String(rawRem.id || `rem_${now}_${Math.random().toString(36).slice(2, 6)}`);
  const rem = {
    id,
    title,
    checkType: rawRem.checkType === 'availability_recheck' ? 'availability_recheck' : 'reminder',
    url: String(rawRem.url || '').slice(0, 240),
    projectTopic: String(rawRem.projectTopic || '').slice(0, 80),
    taskId: String(rawRem.taskId || '').slice(0, 60),
    targetTimeMs: when,
    targetIso: new Date(when).toISOString(),
    status: 'scheduled',
    authorizationStatus: 'user_authorized',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  };

  const list = await loadReminders();
  const existingIdx = list.findIndex((r) => r.id === id);
  if (existingIdx !== -1) list[existingIdx] = rem;
  else list.push(rem);
  await saveReminders(list);

  if (chrome.alarms && typeof chrome.alarms.create === 'function') {
    await chrome.alarms.create(`${REMINDER_ALARM_PREFIX}${id}`, { when });
  }
  return { ok: true, reminder: rem };
}

async function updateReminderAlarm(id, patch = {}) {
  const list = await loadReminders();
  const rem = list.find((r) => r && r.id === id);
  if (!rem) return { ok: false, error: 'Reminder not found.' };
  if (patch.title) rem.title = String(patch.title).trim().slice(0, 140);
  if (patch.targetTimeMs) {
    const when = Math.max(Date.now() + 1000, Number(patch.targetTimeMs));
    rem.targetTimeMs = when;
    rem.targetIso = new Date(when).toISOString();
    rem.status = 'scheduled';
    if (chrome.alarms && typeof chrome.alarms.create === 'function') {
      await chrome.alarms.create(`${REMINDER_ALARM_PREFIX}${id}`, { when });
    }
  }
  rem.updatedAt = new Date().toISOString();
  await saveReminders(list);
  await syncReminderBadge(list);
  return { ok: true, reminder: rem };
}

async function updateReminderStatus(id, queryText = '', nextStatus = 'cancelled') {
  const list = await loadReminders();
  const qLower = String(queryText || '').toLowerCase();
  let rem = id ? list.find((r) => r && r.id === id) : null;
  if (!rem && qLower) {
    rem = list.slice().reverse().find((r) => r && r.status !== 'cancelled' && qLower.includes(String(r.title || '').toLowerCase()));
  }
  if (!rem && !id) {
    rem = list.slice().reverse().find((r) => r && (r.status === 'scheduled' || r.status === 'due'));
  }
  if (!rem) return { ok: false, error: 'No matching active reminder found.' };

  rem.status = nextStatus;
  rem.updatedAt = new Date().toISOString();
  if (chrome.alarms && typeof chrome.alarms.clear === 'function') {
    try { await chrome.alarms.clear(`${REMINDER_ALARM_PREFIX}${rem.id}`); } catch (_e) {}
  }
  await saveReminders(list);
  await syncReminderBadge(list);
  return { ok: true, reminder: rem };
}

async function reconcileReminderAlarms() {
  const list = await loadReminders();
  const now = Date.now();
  let changed = false;

  let activeAlarmNames = new Set();
  if (chrome.alarms && typeof chrome.alarms.getAll === 'function') {
    try {
      const alarms = await new Promise((resolve) => chrome.alarms.getAll((a) => resolve(Array.isArray(a) ? a : [])));
      activeAlarmNames = new Set(alarms.map((a) => a.name));
    } catch (_e) {}
  }

  for (const rem of list) {
    if (!rem || rem.status !== 'scheduled') continue;
    if (rem.targetTimeMs <= now) {
      rem.status = 'due';
      rem.firedAt = rem.firedAt || new Date().toISOString();
      changed = true;
    } else if (chrome.alarms && !activeAlarmNames.has(`${REMINDER_ALARM_PREFIX}${rem.id}`)) {
      try { await chrome.alarms.create(`${REMINDER_ALARM_PREFIX}${rem.id}`, { when: rem.targetTimeMs }); } catch (_e) {}
    }
  }
  if (changed) await saveReminders(list);
  await syncReminderBadge(list);
  return list;
}

if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || !alarm.name || !alarm.name.startsWith(REMINDER_ALARM_PREFIX)) return;
    const remId = alarm.name.slice(REMINDER_ALARM_PREFIX.length);
    loadReminders().then(async (list) => {
      const rem = list.find((r) => r && r.id === remId);
      if (!rem || rem.status === 'cancelled' || rem.status === 'completed') return;
      rem.status = 'due';
      rem.firedAt = new Date().toISOString();
      rem.updatedAt = rem.firedAt;
      await saveReminders(list);
      await syncReminderBadge(list);
      if (chrome.tabs && chrome.tabs.query) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs[0] && tabs[0].id) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'SLEEPWALKER_REMINDER_DUE', reminder: rem }, () => { void chrome.runtime?.lastError; });
          }
        });
      }
    }).catch(() => {});
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    reconcileReminderAlarms().catch(() => {});
  });
}
reconcileReminderAlarms().catch(() => {});

// =============================================================================
// Phase 12A + Stage 2.1: Genuine Browser-Level Input Bridge & CDP Single-Owner Lock
// Provides trusted Input.dispatchMouseEvent / Input.dispatchKeyEvent AND serialized
// single-owner handoff to the local @browserbasehq/stagehand Node.js sidecar.
// =============================================================================
const attachedDebuggerTabs = new Set();
const STAGEHAND_DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4892';
const STAGEHAND_DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const activeStagehandAbortByTab = new Map(); // tabId -> { commandId, controller }
const lastStagehandResultByTab = new Map(); // tabId -> last verified execution summary (survives full-page navigation)
const pendingUnifiedNavByTab = new Map(); // tabId -> pending unified nav metadata recorded before page unload
const lastNavVerificationByTab = new Map(); // tabId -> merged Stagehand + pending nav record for destination page verification
const SESSION_NAV_STORAGE_KEY = 'sleepwalker_nav_verification_by_tab';

async function persistTabNavRecordToSession(tabId, record) {
  if (!tabId) return;
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;
  try {
    const data = await chrome.storage.session.get([SESSION_NAV_STORAGE_KEY]);
    const map = (data && data[SESSION_NAV_STORAGE_KEY] && typeof data[SESSION_NAV_STORAGE_KEY] === 'object')
      ? { ...data[SESSION_NAV_STORAGE_KEY] }
      : {};
    if (record) {
      map[String(tabId)] = record;
    } else {
      delete map[String(tabId)];
    }
    await chrome.storage.session.set({ [SESSION_NAV_STORAGE_KEY]: map });
  } catch (_e) {}
}

async function consumeTabNavRecordFromSession(tabId) {
  if (!tabId) return null;
  const mem = lastNavVerificationByTab.get(tabId) || pendingUnifiedNavByTab.get(tabId) || null;
  lastNavVerificationByTab.delete(tabId);
  pendingUnifiedNavByTab.delete(tabId);
  let stored = null;
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
    try {
      const data = await chrome.storage.session.get([SESSION_NAV_STORAGE_KEY]);
      const map = (data && data[SESSION_NAV_STORAGE_KEY] && typeof data[SESSION_NAV_STORAGE_KEY] === 'object')
        ? { ...data[SESSION_NAV_STORAGE_KEY] }
        : {};
      stored = map[String(tabId)] || null;
      if (stored) {
        delete map[String(tabId)];
        await chrome.storage.session.set({ [SESSION_NAV_STORAGE_KEY]: map });
      }
    } catch (_e) {}
  }
  if (mem && stored) {
    return (Number(mem.updatedAt || mem.ts || 0) >= Number(stored.updatedAt || stored.ts || 0)) ? mem : stored;
  }
  return mem || stored || null;
}

function isLoopbackBridgeUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || STAGEHAND_DEFAULT_BRIDGE_URL).trim());
    if (u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch (_e) {
    return false;
  }
}

async function rawAttachChromeDebugger(tabId) {
  if (!tabId) throw new Error('Missing tabId for debugger attach');
  if (attachedDebuggerTabs.has(tabId)) {
    return { ok: true, attached: true, alreadyAttached: true };
  }
  if (!chrome.debugger || typeof chrome.debugger.attach !== 'function') {
    throw new Error('chrome.debugger API is not available (check manifest permissions)');
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn(`[Sleepwalker CDP] attach error on tab ${tabId}:`, err.message);
        return reject(new Error(err.message));
      }
      attachedDebuggerTabs.add(tabId);
      console.log(`[Sleepwalker CDP] Debugger attached successfully to tab ${tabId}`);
      resolve({ ok: true, attached: true });
    });
  });
}

async function rawDetachChromeDebugger(tabId) {
  if (!tabId || !attachedDebuggerTabs.has(tabId)) {
    return { ok: true, detached: false };
  }
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime?.lastError;
      attachedDebuggerTabs.delete(tabId);
      resolve({ ok: true, detached: true });
    });
  });
}

function rawSendChromeDebuggerCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!attachedDebuggerTabs.has(tabId)) {
      return reject(new Error(`Debugger is not attached to tab ${tabId}`));
    }
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        return reject(new Error(err.message));
      }
      resolve(result || {});
    });
  });
}

function verifyChromeDebuggerDetached(tabId) {
  return new Promise((resolve) => {
    if (!chrome.debugger || typeof chrome.debugger.getTargets !== 'function') {
      return resolve(!attachedDebuggerTabs.has(tabId));
    }
    chrome.debugger.getTargets((targets) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        return resolve(!attachedDebuggerTabs.has(tabId));
      }
      const match = Array.isArray(targets) ? targets.find((t) => t.tabId === tabId) : null;
      if (!match) return resolve(true);
      resolve(Boolean(!match.attached));
    });
  });
}

function resolveTabTargetId(tabId) {
  return new Promise((resolve) => {
    if (!chrome.debugger || typeof chrome.debugger.getTargets !== 'function') {
      return resolve(null);
    }
    chrome.debugger.getTargets((targets) => {
      if (chrome.runtime && chrome.runtime.lastError) return resolve(null);
      const match = Array.isArray(targets) ? targets.find((t) => t.tabId === tabId) : null;
      resolve(match ? match.id : null);
    });
  });
}

function verifyChromeTabExists(tabId) {
  return new Promise((resolve) => {
    if (!chrome.tabs || typeof chrome.tabs.get !== 'function') return resolve(true);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime && chrome.runtime.lastError) return resolve(false);
      resolve(Boolean(tab));
    });
  });
}

async function callStagehandBridge(bridgeUrl, path, method = 'POST', body = null, { timeoutMs = 15000, signal = null } = {}) {
  const base = String(bridgeUrl || STAGEHAND_DEFAULT_BRIDGE_URL).trim().replace(/\/+$/, '');
  if (!isLoopbackBridgeUrl(base)) {
    throw new Error('Rejected non-loopback Stagehand bridge URL');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Stagehand bridge ${path} timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason || 'cancelled');
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new Error('Stagehand bridge call cancelled before send');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const fetchOpts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal
    };
    if (body !== null && method !== 'GET') {
      fetchOpts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${base}${path}`, fetchOpts);
    const data = await resp.json().catch(() => ({ ok: false, error: `Invalid JSON (HTTP ${resp.status})` }));
    if (!resp.ok || data.ok === false) {
      const err = new Error(data.error || `Stagehand bridge HTTP ${resp.status}`);
      err.code = resp.status === 403 ? 'STAGEHAND_FORBIDDEN' : 'STAGEHAND_BRIDGE_ERROR';
      throw err;
    }
    return data;
  } catch (err) {
    if (err && (err.name === 'AbortError' || ctrl.signal.aborted)) {
      const abortErr = new Error((signal && signal.aborted) ? 'Stagehand operation cancelled' : `Stagehand bridge ${path} timed out`);
      abortErr.code = (signal && signal.aborted) ? 'CANCELLED' : 'TIMEOUT';
      throw abortErr;
    }
    if (err && !err.code) {
      err.code = 'STAGEHAND_UNAVAILABLE';
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const cdpOwnershipManager = (typeof self !== 'undefined' && typeof self.SleepwalkerCDPOwnershipManager === 'function')
  ? new self.SleepwalkerCDPOwnershipManager({
      attachExtensionDebugger: (tabId) => rawAttachChromeDebugger(tabId),
      detachExtensionDebugger: (tabId) => rawDetachChromeDebugger(tabId),
      verifyExtensionDetached: (tabId) => verifyChromeDebuggerDetached(tabId),
      sendExtensionDebuggerCommand: (tabId, method, params) => rawSendChromeDebuggerCommand(tabId, method, params),
      restoreExtensionListeners: async (_tabId) => true,
      verifyTabExists: (tabId) => verifyChromeTabExists(tabId),
      connectStagehand: async (tabId, ctx = {}) => {
        const targetId = ctx.targetId || await resolveTabTargetId(tabId);
        return callStagehandBridge(ctx.bridgeUrl || STAGEHAND_DEFAULT_BRIDGE_URL, '/connect', 'POST', {
          cdpUrl: ctx.cdpUrl || STAGEHAND_DEFAULT_CDP_URL,
          targetId,
          url: ctx.url || null,
          commandId: ctx.commandId || null,
          timeoutMs: 8000
        }, { timeoutMs: 10000, signal: ctx.signal || null });
      },
      disconnectStagehand: async (_tabId, ctx = {}) => {
        return callStagehandBridge(ctx.bridgeUrl || STAGEHAND_DEFAULT_BRIDGE_URL, '/disconnect', 'POST', {
          reason: ctx.reason || 'release'
        }, { timeoutMs: 4000 }).catch((e) => ({ ok: false, disconnected: false, error: e.message }));
      }
    })
  : null;

if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source && source.tabId) {
      attachedDebuggerTabs.delete(source.tabId);
      if (cdpOwnershipManager) {
        cdpOwnershipManager.onExtensionDetached(source.tabId, reason);
      }
      console.log(`[Sleepwalker CDP] Debugger detached from tab ${source.tabId}: ${reason}`);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedDebuggerTabs.delete(tabId);
    pendingUnifiedNavByTab.delete(tabId);
    lastNavVerificationByTab.delete(tabId);
    persistTabNavRecordToSession(tabId, null).catch(() => {});
    const active = activeStagehandAbortByTab.get(tabId);
    if (active) {
      try { active.controller.abort('tab_closed'); } catch (_e) {}
      activeStagehandAbortByTab.delete(tabId);
    }
    if (cdpOwnershipManager) {
      cdpOwnershipManager.onTabClosed(tabId);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo && changeInfo.url && cdpOwnershipManager) {
      cdpOwnershipManager.onTabNavigated(tabId, changeInfo.url);
    }
  });
}

async function attachTabDebugger(tabId) {
  if (cdpOwnershipManager) {
    return cdpOwnershipManager.acquireExtension(tabId, { commandId: `ext-attach-${Date.now()}` });
  }
  return rawAttachChromeDebugger(tabId);
}

async function detachTabDebugger(tabId) {
  if (cdpOwnershipManager) {
    const st = cdpOwnershipManager.getState(tabId);
    if (st && st.owner === 'EXTENSION' && st.lockToken) {
      return cdpOwnershipManager.releaseExtension(tabId, st.lockToken, { detach: true });
    }
    return { ok: true, detached: false };
  }
  return rawDetachChromeDebugger(tabId);
}

function sendDebuggerCommand(tabId, method, params = {}) {
  if (cdpOwnershipManager) {
    return cdpOwnershipManager.sendExtensionCommand(tabId, method, params);
  }
  return rawSendChromeDebuggerCommand(tabId, method, params);
}

const STAGEHAND_HEALTH_CACHE_TTL_MS = 10000;
const stagehandHealthCache = new Map();

async function checkStagehandBridgeHealth(bridgeUrl = STAGEHAND_DEFAULT_BRIDGE_URL, opts = {}) {
  const key = String(bridgeUrl || STAGEHAND_DEFAULT_BRIDGE_URL).trim();
  const cached = stagehandHealthCache.get(key);
  if (!opts.force && cached && (Date.now() - cached.ts) < STAGEHAND_HEALTH_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }
  try {
    const data = await callStagehandBridge(key, '/health', 'GET', null, { timeoutMs: 2500 });
    const result = { ok: true, available: true, ...data };
    stagehandHealthCache.set(key, { ts: Date.now(), value: result });
    return result;
  } catch (err) {
    stagehandHealthCache.delete(key);
    return { ok: false, available: false, error: err && err.message ? err.message : String(err), code: (err && err.code) || 'STAGEHAND_UNAVAILABLE' };
  }
}

async function cancelStagehandOperation(tabId, commandId = null, bridgeUrl = STAGEHAND_DEFAULT_BRIDGE_URL) {
  stagehandHealthCache.delete(String(bridgeUrl || STAGEHAND_DEFAULT_BRIDGE_URL).trim());
  // First instruct the Stagehand bridge to issue Page.stopLoading & abort in-flight work BEFORE releasing CDP lock
  const bridgeRes = await callStagehandBridge(bridgeUrl, '/cancel', 'POST', {
    commandId,
    forceDisconnect: true
  }, { timeoutMs: 3000 }).catch((err) => ({ ok: false, error: err.message }));

  const active = activeStagehandAbortByTab.get(tabId);
  if (active && (!commandId || active.commandId === commandId)) {
    try { active.controller.abort(`cancel:${commandId || active.commandId}`); } catch (_e) {}
    activeStagehandAbortByTab.delete(tabId);
  }

  if (cdpOwnershipManager && tabId) {
    await cdpOwnershipManager.onStagehandDisconnected(tabId, { reason: `cancelled:${commandId || 'any'}`, restorePreviousOwner: true }).catch(() => {});
  }
  return {
    ok: true,
    cancelled: true,
    commandId,
    bridgeRes,
    ownership: cdpOwnershipManager && tabId ? cdpOwnershipManager.getState(tabId) : null
  };
}

/**
 * Execute one atomic Stagehand operation with guaranteed CDP Single-Owner Handoff and release.
 */
async function executeStagehandOperation(tabId, payload = {}) {
  if (!tabId) throw new Error('Missing tabId for Stagehand execution');
  if (!cdpOwnershipManager) throw new Error('CDPOwnershipManager unavailable in background service worker');

  const bridgeUrl = payload.bridgeUrl || STAGEHAND_DEFAULT_BRIDGE_URL;
  const cdpUrl = payload.cdpUrl || STAGEHAND_DEFAULT_CDP_URL;
  const commandId = payload.commandId || `sw-sh-${Date.now()}`;
  const operation = String(payload.operation || '').toLowerCase().trim();
  const timeoutMs = Number(payload.timeoutMs || 18000);

  if (!['connect', 'observe', 'act', 'extract', 'verify', 'disconnect'].includes(operation)) {
    throw new Error(`Unsupported Stagehand atomic operation: ${operation}`);
  }

  // Preempt any stale Stagehand controller on the same tab
  const prevActive = activeStagehandAbortByTab.get(tabId);
  if (prevActive && prevActive.commandId !== commandId) {
    try { prevActive.controller.abort('superseded_by_newer_command'); } catch (_e) {}
    activeStagehandAbortByTab.delete(tabId);
  }

  const opController = new AbortController();
  activeStagehandAbortByTab.set(tabId, { commandId, controller: opController });

  const targetId = payload.targetId || await resolveTabTargetId(tabId);
  let handoff = null;

  try {
    handoff = await cdpOwnershipManager.handoffToStagehand(tabId, {
      commandId,
      targetId,
      url: payload.url || null,
      bridgeUrl,
      cdpUrl,
      signal: opController.signal,
      timeoutMs: Math.min(timeoutMs, 10000)
    });

    if (operation === 'connect') {
      return {
        ok: true,
        operation,
        commandId,
        connectInfo: handoff.connectInfo,
        ownership: cdpOwnershipManager.getState(tabId)
      };
    }

    if (operation === 'disconnect') {
      return {
        ok: true,
        operation,
        commandId,
        disconnected: true,
        ownership: cdpOwnershipManager.getState(tabId)
      };
    }

    const endpointMap = {
      observe: '/observe',
      act: '/act',
      extract: '/extract',
      verify: '/verify'
    };

    const reqBody = {
      ...(payload.params || {}),
      targetId: (handoff.connectInfo && handoff.connectInfo.targetId) || targetId,
      url: payload.url || null,
      commandId,
      timeoutMs
    };

    const result = await callStagehandBridge(bridgeUrl, endpointMap[operation], 'POST', reqBody, {
      timeoutMs,
      signal: opController.signal
    });

    // Optional atomic post-verification inside the same lock window (zero extra handoff churn!)
    let verification = null;
    if (operation === 'act' && payload.verifyAfter && typeof payload.verifyAfter === 'object') {
      verification = await callStagehandBridge(bridgeUrl, '/verify', 'POST', {
        expectedState: payload.verifyAfter,
        targetId: (handoff.connectInfo && handoff.connectInfo.targetId) || targetId,
        commandId
      }, { timeoutMs: 6000, signal: opController.signal }).catch((e) => ({ ok: false, verified: false, error: e.message }));
    }

    const finalPayload = {
      ok: true,
      operation,
      commandId,
      timestamp: new Date().toISOString(),
      stagehandVersion: result.stagehandVersion || null,
      result,
      verification,
      ownershipDuringOp: {
        lockToken: handoff.lockToken,
        targetId: handoff.targetId,
        priorOwner: handoff.priorOwner
      }
    };
    lastStagehandResultByTab.set(tabId, finalPayload);
    if (operation === 'act') {
      const pending = pendingUnifiedNavByTab.get(tabId) || {};
      const actType = String((payload.params && payload.params.actionType) || '').toLowerCase();
      if (result.navigated === true || actType === 'navigate' || actType === 'search' || actType === 'click') {
        const navRecord = {
          ...pending,
          tabId,
          commandId,
          engine: 'stagehand_adapter',
          fallbackUsed: false,
          actionType: actType,
          stagehandVersion: finalPayload.stagehandVersion,
          urlBefore: result.urlBefore || pending.urlBefore || null,
          urlAfter: result.urlAfter || null,
          titleAfter: result.titleAfter || null,
          matchedLabel: (result.details && (result.details.matchedLabel || (result.details.groundedMatch && result.details.groundedMatch.label))) || null,
          navigated: Boolean(result.navigated),
          visibleTextPreview: result.visibleTextPreview || '',
          stagehandVerification: verification || null,
          ownershipDuringOp: finalPayload.ownershipDuringOp,
          updatedAt: Date.now()
        };
        lastNavVerificationByTab.set(tabId, navRecord);
        persistTabNavRecordToSession(tabId, navRecord).catch(() => {});
      }
    }
    return finalPayload;
  } finally {
    const cur = activeStagehandAbortByTab.get(tabId);
    if (cur && cur.commandId === commandId) {
      activeStagehandAbortByTab.delete(tabId);
    }
    if (handoff && handoff.lockToken) {
      await cdpOwnershipManager.releaseStagehand(tabId, handoff.lockToken, {
        restorePreviousOwner: payload.restorePreviousOwner !== false,
        bridgeUrl,
        reason: opController.signal.aborted ? `cancel_op_${operation}_aborted` : `op_${operation}_finished`
      }).catch((relErr) => {
        console.warn('[Sleepwalker CDP] Stagehand release error:', relErr && relErr.message);
      });
    }
  }
}

function getKeyCodeInfo(key) {
  const map = {
    'Enter': { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    'Escape': { code: 'Escape', windowsVirtualKeyCode: 27 },
    'Tab': { code: 'Tab', windowsVirtualKeyCode: 9 },
    'ArrowDown': { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    'ArrowUp': { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    'ArrowLeft': { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    'ArrowRight': { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    'Backspace': { code: 'Backspace', windowsVirtualKeyCode: 8 },
    'Delete': { code: 'Delete', windowsVirtualKeyCode: 46 },
    'Space': { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    ' ': { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    '.': { code: 'Period', windowsVirtualKeyCode: 190, text: '.' },
    ',': { code: 'Comma', windowsVirtualKeyCode: 188, text: ',' },
    '/': { code: 'Slash', windowsVirtualKeyCode: 191, text: '/' },
    ';': { code: 'Semicolon', windowsVirtualKeyCode: 186, text: ';' },
    '=': { code: 'Equal', windowsVirtualKeyCode: 187, text: '=' },
    '-': { code: 'Minus', windowsVirtualKeyCode: 189, text: '-' },
    '[': { code: 'BracketLeft', windowsVirtualKeyCode: 219, text: '[' },
    ']': { code: 'BracketRight', windowsVirtualKeyCode: 221, text: ']' },
    '\'': { code: 'Quote', windowsVirtualKeyCode: 222, text: '\'' },
    '`': { code: 'Backquote', windowsVirtualKeyCode: 192, text: '`' },
    '\\': { code: 'Backslash', windowsVirtualKeyCode: 220, text: '\\' },
    '@': { code: 'Digit2', windowsVirtualKeyCode: 50, text: '@' }
  };
  if (map[key]) return map[key];
  if (key && key.length === 1) {
    const isAlpha = /^[a-zA-Z]$/.test(key);
    const isDigit = /^[0-9]$/.test(key);
    const code = isAlpha ? `Key${key.toUpperCase()}` : (isDigit ? `Digit${key}` : '');
    const windowsVirtualKeyCode = isAlpha ? key.toUpperCase().charCodeAt(0) : (isDigit ? key.charCodeAt(0) : 0);
    return { code, windowsVirtualKeyCode, text: key };
  }
  return { code: key, windowsVirtualKeyCode: 0 };
}

async function dispatchCdpInputAction(tabId, action = {}) {
  if (!attachedDebuggerTabs.has(tabId)) {
    await attachTabDebugger(tabId);
  }

  const type = action.type;
  const modifiers = Number(action.modifiers || 0);

  if (type === 'mouseMoved') {
    const x = Math.round(Number(action.x) || 0);
    const y = Math.round(Number(action.y) || 0);
    return sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      modifiers
    });
  }

  if (type === 'mousePressed') {
    const x = Math.round(Number(action.x) || 0);
    const y = Math.round(Number(action.y) || 0);
    const button = action.button || 'left';
    const clickCount = Number(action.clickCount) || 1;
    return sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
      modifiers
    });
  }

  if (type === 'mouseReleased') {
    const x = Math.round(Number(action.x) || 0);
    const y = Math.round(Number(action.y) || 0);
    const button = action.button || 'left';
    const clickCount = Number(action.clickCount) || 1;
    return sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
      modifiers
    });
  }

  if (type === 'mouseClick') {
    const x = Math.round(Number(action.x) || 0);
    const y = Math.round(Number(action.y) || 0);
    const button = action.button || 'left';
    const clickCount = Number(action.clickCount) || 1;
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, modifiers });
    await new Promise((r) => setTimeout(r, 40));
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, modifiers });
    return { ok: true };
  }

  if (type === 'mouseDoubleClick') {
    const x = Math.round(Number(action.x) || 0);
    const y = Math.round(Number(action.y) || 0);
    const button = action.button || 'left';
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1, modifiers });
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1, modifiers });
    await new Promise((r) => setTimeout(r, 40));
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 2, modifiers });
    await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 2, modifiers });
    return { ok: true };
  }

  if (type === 'mouseWheel') {
    const x = Math.round(Number(action.x) || 0);
    const y = Math.round(Number(action.y) || 0);
    const deltaX = Math.round(Number(action.deltaX) || 0);
    const deltaY = Math.round(Number(action.deltaY) || 0);
    return sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
      modifiers
    });
  }

  if (type === 'keyDown' || type === 'keyUp') {
    const key = action.key || '';
    const info = getKeyCodeInfo(key);
    const params = {
      type,
      key,
      code: action.code || info.code || key,
      windowsVirtualKeyCode: action.windowsVirtualKeyCode || info.windowsVirtualKeyCode || 0,
      nativeVirtualKeyCode: action.nativeVirtualKeyCode || info.windowsVirtualKeyCode || 0,
      modifiers
    };
    if (info.text && type === 'keyDown') params.text = info.text;
    return sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', params);
  }

  if (type === 'keyPress') {
    const key = action.key || '';
    const info = getKeyCodeInfo(key);
    const downParams = {
      type: 'keyDown',
      key,
      code: action.code || info.code || key,
      windowsVirtualKeyCode: action.windowsVirtualKeyCode || info.windowsVirtualKeyCode || 0,
      nativeVirtualKeyCode: action.nativeVirtualKeyCode || info.windowsVirtualKeyCode || 0,
      modifiers
    };
    if (info.text) downParams.text = info.text;
    await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', downParams);
    await new Promise((r) => setTimeout(r, 25));
    const upParams = {
      type: 'keyUp',
      key,
      code: action.code || info.code || key,
      windowsVirtualKeyCode: action.windowsVirtualKeyCode || info.windowsVirtualKeyCode || 0,
      nativeVirtualKeyCode: action.nativeVirtualKeyCode || info.windowsVirtualKeyCode || 0,
      modifiers
    };
    await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', upParams);
    return { ok: true };
  }

  if (type === 'insertText') {
    return sendDebuggerCommand(tabId, 'Input.insertText', { text: String(action.text || '') });
  }

  if (type === 'typeText') {
    const text = String(action.text || '');
    const delay = Math.max(10, Number(action.delayMs) || 30);
    for (const char of text) {
      const info = getKeyCodeInfo(char);
      await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: char,
        text: char,
        unmodifiedText: char,
        code: info.code,
        windowsVirtualKeyCode: info.windowsVirtualKeyCode,
        modifiers
      });
      await new Promise((r) => setTimeout(r, Math.round(delay / 2)));
      await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: char,
        code: info.code,
        windowsVirtualKeyCode: info.windowsVirtualKeyCode,
        modifiers
      });
      await new Promise((r) => setTimeout(r, Math.round(delay / 2)));
    }
    return { ok: true, charactersTyped: text.length };
  }

  throw new Error(`Unsupported CDP input action type: ${type}`);
}

// ============================================================================
// Sleepwalker Native Messaging Client (Windows Desktop Companion Host)
// Host: com.sleepwalker.native_host
// ============================================================================

const NATIVE_HOST_NAME = 'com.sleepwalker.native_host';
let nativeCompanionPort = null;
const pendingNativeRequests = new Map(); // requestId -> { resolve, reject, timer }

function getOrCreateNativePort() {
  if (nativeCompanionPort) return nativeCompanionPort;

  try {
    if (!chrome.runtime.connectNative) {
      console.warn('[Sleepwalker Native] chrome.runtime.connectNative is not available');
      return null;
    }

    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativeCompanionPort = port;

    port.onMessage.addListener((response) => {
      if (!response) return;
      const key = response.commandId || response.requestId;
      if (key && pendingNativeRequests.has(key)) {
        const { resolve, timer } = pendingNativeRequests.get(key);
        clearTimeout(timer);
        pendingNativeRequests.delete(key);
        resolve(response);
      } else if (response.requestId && pendingNativeRequests.has(response.requestId)) {
        const { resolve, timer } = pendingNativeRequests.get(response.requestId);
        clearTimeout(timer);
        pendingNativeRequests.delete(response.requestId);
        resolve(response);
      }
    });

    port.onDisconnect.addListener(() => {
      const lastErr = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Port disconnected';
      console.warn('[Sleepwalker Native] Native companion port disconnected:', lastErr);
      nativeCompanionPort = null;

      // Reject all pending requests
      for (const [reqId, { reject, timer }] of pendingNativeRequests.entries()) {
        clearTimeout(timer);
        reject(new Error(`Native companion disconnected: ${lastErr}`));
      }
      pendingNativeRequests.clear();
    });

    return port;
  } catch (err) {
    console.warn('[Sleepwalker Native] Failed to initialize native port:', err);
    nativeCompanionPort = null;
    return null;
  }
}

async function executeNativeDesktopAction(request = {}) {
  const commandId = request.commandId || request.requestId || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const taskId = request.taskId || commandId;
  const timeoutMs = Math.max(200, Number(request.timeout || request.timeoutMs) || 8000);
  const expectedWindow = request.expectedWindow || request.windowIdentity || null;

  const fullRequest = {
    taskId,
    commandId,
    requestId: commandId,
    action: request.action,
    target: request.target || {},
    parameters: request.parameters || null,
    expectedWindow,
    windowIdentity: expectedWindow,
    timeout: timeoutMs,
    timeoutMs,
    cancellationToken: request.cancellationToken || null
  };

  const port = getOrCreateNativePort();

  if (port) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingNativeRequests.delete(commandId);
        resolve({
          taskId,
          commandId,
          requestId: commandId,
          success: false,
          status: 'TIMEOUT',
          error: `Native companion timed out after ${timeoutMs}ms`,
          executionTimeMs: timeoutMs
        });
      }, timeoutMs + 800);

      pendingNativeRequests.set(commandId, { resolve, reject, timer });

      try {
        port.postMessage(fullRequest);
      } catch (err) {
        clearTimeout(timer);
        pendingNativeRequests.delete(commandId);
        reject(err);
      }
    });
  }

  // Fallback to one-shot sendNativeMessage if port is not available
  return new Promise((resolve, reject) => {
    if (!chrome.runtime.sendNativeMessage) {
      return reject(new Error('Native messaging is not supported in this browser context'));
    }

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({
          taskId,
          commandId,
          requestId: commandId,
          success: false,
          status: 'TIMEOUT',
          error: `Native companion timed out after ${timeoutMs}ms`,
          executionTimeMs: timeoutMs
        });
      }
    }, timeoutMs + 800);

    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, fullRequest, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve({
          taskId,
          commandId,
          requestId: commandId,
          success: false,
          status: 'FAILED',
          error: chrome.runtime.lastError.message,
          executionTimeMs: 0
        });
      } else {
        resolve(response || { taskId, commandId, requestId: commandId, success: true, status: 'COMPLETED' });
      }
    });
  });
}

async function getNativeDesktopStatus() {
  try {
    const res = await executeNativeDesktopAction({
      action: 'ping',
      timeoutMs: 1500
    });
    return {
      available: res.success === true,
      result: res.result || null,
      error: res.error || null
    };
  } catch (err) {
    return {
      available: false,
      error: err.message
    };
  }
}

// ===========================================================================
// Multi-Tab Navigation & Contextual Memory Handlers (Sleepwalker Unified SW)
// ===========================================================================
function summarizeExtensionTab(tab) {
  return {
    tabId: tab && tab.id != null ? tab.id : -1,
    windowId: tab ? tab.windowId : -1,
    url: (tab && tab.url) || '',
    title: (tab && tab.title) || '',
    active: Boolean(tab && tab.active)
  };
}

async function openTabAndWait(url, budgetMs = 15000) {
  const created = await chrome.tabs.create({ url: String(url || 'about:blank'), active: true });
  const tabId = created.id;
  await new Promise((resolve) => {
    const timer = setTimeout(done, budgetMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') done();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete' && t.url !== 'about:blank') done();
    }).catch(() => {});
  });
  return summarizeExtensionTab(await chrome.tabs.get(tabId));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'SLEEPWALKER_TABS_LIST') {
    chrome.tabs.query({}).then((tabs) => {
      sendResponse({ ok: true, tabs: tabs.filter((t) => t.id != null).map(summarizeExtensionTab) });
    }).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SLEEPWALKER_TABS_OPEN') {
    openTabAndWait(msg.url, Number(msg.timeoutMs) || 15000)
      .then((tab) => sendResponse({ ok: true, tab }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SLEEPWALKER_TABS_SWITCH') {
    const tabId = Number(msg.tabId);
    chrome.tabs.update(tabId, { active: true })
      .then((tab) => sendResponse({ ok: true, tab: summarizeExtensionTab(tab) }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SLEEPWALKER_TABS_CLOSE') {
    const tabId = Number(msg.tabId);
    chrome.tabs.remove(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});
