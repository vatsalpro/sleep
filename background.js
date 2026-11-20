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
  importScripts('config.local.js');
} catch (e) {
  // config.local.js not present in distribution builds
}

// Import LLM Cascade, Gemini Live WS client & Unified AI Comm Manager into the service worker
importScripts('llm.js');
try {
  importScripts('gemini-live.js');
} catch (e) {
  console.warn('[Sleepwalker SW] gemini-live.js unavailable:', e && e.message);
}
try {
  importScripts('ai-comm.js');
} catch (e) {
  console.warn('[Sleepwalker SW] ai-comm.js unavailable:', e && e.message);
}
try {
  importScripts('shelf-db.js');
} catch (e) {
  console.warn('[Sleepwalker SW] shelf-db.js unavailable:', e && e.message);
}
try {
  importScripts('personal-intel.js');
} catch (e) {
  console.warn('[Sleepwalker SW] personal-intel.js unavailable:', e && e.message);
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
        'sleepwalker_gemini_manual_override',
        'sleepwalker_last_env_gemini_key'
      ],
      (data) => {
        const storedKey = (data.sleepwalker_gemini_api_key || '').trim();
        const shouldSyncKey = Boolean(
          envObj.GEMINI_API_KEY &&
          (forceReload || !data.sleepwalker_gemini_manual_override || !storedKey || storedKey === data.sleepwalker_last_env_gemini_key)
        );

        const nextValues = {};
        if (shouldSyncKey) {
          nextValues.sleepwalker_gemini_api_key = envObj.GEMINI_API_KEY;
          nextValues.sleepwalker_last_env_gemini_key = envObj.GEMINI_API_KEY;
          if (forceReload) nextValues.sleepwalker_gemini_manual_override = false;
        }
        if (envObj.GEMINI_MODEL && (forceReload || !data.sleepwalker_gemini_model || !data.sleepwalker_gemini_manual_override)) {
          nextValues.sleepwalker_gemini_model = envObj.GEMINI_MODEL;
        }
        if (envObj.OLLAMA_URL && (forceReload || !data.sleepwalker_ollama_url || !data.sleepwalker_gemini_manual_override)) {
          nextValues.sleepwalker_ollama_url = envObj.OLLAMA_URL;
        }
        if (envObj.OLLAMA_MODEL && (forceReload || !data.sleepwalker_ollama_model || !data.sleepwalker_gemini_manual_override)) {
          nextValues.sleepwalker_ollama_model = envObj.OLLAMA_MODEL;
        }
        if (envObj.CLOUD_PROXY_URL !== undefined && (forceReload || !data.sleepwalker_proxy_url)) {
          nextValues.sleepwalker_proxy_url = envObj.CLOUD_PROXY_URL;
        }
        if (envObj.LOCAL_ONLY !== undefined && (forceReload || data.sleepwalker_local_only === undefined)) {
          nextValues.sleepwalker_local_only = String(envObj.LOCAL_ONLY).toLowerCase() === 'true';
        }

        const effective = {
          envLoaded,
          geminiKey: shouldSyncKey ? envObj.GEMINI_API_KEY : (storedKey || envObj.GEMINI_API_KEY || ''),
          geminiModel: nextValues.sleepwalker_gemini_model || data.sleepwalker_gemini_model || envObj.GEMINI_MODEL || 'gemini-2.5-flash-lite',
          ollamaUrl: nextValues.sleepwalker_ollama_url || data.sleepwalker_ollama_url || envObj.OLLAMA_URL || 'http://localhost:11434',
          ollamaModel: nextValues.sleepwalker_ollama_model || data.sleepwalker_ollama_model || envObj.OLLAMA_MODEL || 'llama3.2:3b',
          proxyUrl: nextValues.sleepwalker_proxy_url !== undefined ? nextValues.sleepwalker_proxy_url : (data.sleepwalker_proxy_url || envObj.CLOUD_PROXY_URL || ''),
          localOnly: nextValues.sleepwalker_local_only !== undefined ? nextValues.sleepwalker_local_only : Boolean(data.sleepwalker_local_only)
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
  'reader.js',
  'outline.js',
  'diagnostics.js',
  'ai-comm.js',
  'voice.js',
  'memory.js',
  'task-planner.js',
  'personal-intel.js',
  'digest.js',
  'explain.js',
  'confirm.js',
  'link-index.js',
  'match.js',
  'link-intent.js',
  'intent.js',
  'nav-engine.js',
  'navigate.js',
  'form-index.js',
  'form-fill.js',
  'forms.js',
  'element-select.js',
  'world-model.js',
  'shelf-db.js',
  'upload.js',
  'camera.js',
  'dialogue.js',
  'threads.js',
  'card.js',
  'orb.js',
  'content.js'
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
        if (oldMem && oldMem.tabContexts && typeof oldMem.tabContexts === 'object') {
          const mergedTabs = { ...oldMem.tabContexts };
          if (incoming.tabContexts && incoming.tabContexts[message.tabKey]) {
            mergedTabs[message.tabKey] = incoming.tabContexts[message.tabKey];
          }
          stateToSave = { ...incoming, tabContexts: mergedTabs };
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
        const [geminiHealth, ollamaEmbedHealth, memState] = await Promise.all([
          typeof verifyGeminiConnection === 'function' ? verifyGeminiConnection(message.geminiApiKey || '') : Promise.resolve({ state: 'unavailable', detail: 'Verifier unavailable' }),
          typeof verifyOllamaAndEmbedStatus === 'function' ? verifyOllamaAndEmbedStatus(message.ollamaUrl || '', message.ollamaModel || '', { skipProbe: Boolean(message.skipProbe) }) : Promise.resolve({ ollama: { state: 'unavailable' }, embeddings: { state: 'unavailable' } }),
          chrome.storage && chrome.storage.local
            ? new Promise((r) => chrome.storage.local.get(['sleepwalker_persistent_memory_v1', 'sleepwalker_memory_paused', 'sleepwalker_disable_page_analysis', 'sleepwalker_live_ws', 'sleepwalker_local_only'], (d) => r(d || {})))
            : Promise.resolve({})
        ]);
        const llmDiag = typeof getLlmDiagnostics === 'function' ? getLlmDiagnostics() : null;
        const commTelemetry = self.SLEEPWALKER_AI_COMM ? self.SLEEPWALKER_AI_COMM.getTelemetry() : null;
        const mem = memState.sleepwalker_persistent_memory_v1 || null;
        const extOrigin = typeof getExtensionOrigin === 'function' ? getExtensionOrigin() : (chrome.runtime && chrome.runtime.id ? `chrome-extension://${chrome.runtime.id}` : '');
        sendResponse({
          status: 'ok',
          checkedAt: new Date().toISOString(),
          extensionOrigin: extOrigin,
          connections: {
            geminiRest: geminiHealth,
            geminiLiveWs: {
              state: !memState.sleepwalker_live_ws ? 'disconnected' : (commTelemetry ? commTelemetry.liveWsState : 'disconnected'),
              enabled: Boolean(memState.sleepwalker_live_ws),
              sessions: (commTelemetry && commTelemetry.liveSessions) || []
            },
            ollama: ollamaEmbedHealth.ollama,
            embeddings: ollamaEmbedHealth.embeddings
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

  if (message.type === 'SLEEPWALKER_NLU_PLAN_REQUEST') {
    envReadyPromise
      .then(() => handleNluPlanRequest(message.payload || message))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ status: 'generation_failed', message: (err && err.message) || 'NLU request error.' }));
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
      sessionApi.get(['sleepwalker_active_tab_id'], (prev) => {
        const oldTabId = prev && prev.sleepwalker_active_tab_id;
        sessionApi.set({ sleepwalker_active_tab_id: tabId }, () => {
          if (oldTabId && oldTabId !== tabId && chrome.tabs && chrome.tabs.sendMessage) {
            chrome.tabs.sendMessage(oldTabId, { action: 'SLEEPWALKER_TAB_BACKGROUNDED' }, () => { void chrome.runtime.lastError; });
          }
          sendResponse({ status: 'ok', tabId });
        });
      });
      return true;
    }
    sendResponse({ status: 'ok' });
    return false;
  }

  // Open mic setup tab
  if (message.type === 'SLEEPWALKER_OPEN_MIC_SETUP') {
    chrome.tabs.create({ url: 'mic-setup.html' });
    sendResponse({ status: 'opened' });
    return false;
  }

  if (message.type === 'SLEEPWALKER_OPEN_OPTIONS') {
    if (chrome.runtime && typeof chrome.runtime.openOptionsPage === 'function') chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: 'options.html' });
    sendResponse({ status: 'opened' });
    return false;
  }

  // Open Document Shelf setup page (Route A extension-origin folder setup)
  if (message.type === 'SLEEPWALKER_OPEN_SHELF_SETUP') {
    chrome.tabs.create({ url: 'shelf.html' });
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

  // Start offscreen voice recording
  if (message.type === 'SLEEPWALKER_START_OFFSCREEN_VOICE') {
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

  // Relay offscreen events to active tab content script
  if (message.type === 'OFFSCREEN_TRANSCRIPT' || message.type === 'OFFSCREEN_ERROR' || message.type === 'OFFSCREEN_STATE_CHANGE') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
      }
    });
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
async function ensureOffscreenDocument() {
  if (typeof chrome.offscreen === 'undefined') {
    throw new Error('chrome.offscreen API not available in this browser version');
  }

  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Offscreen speech recognition evaluation for voice assistant'
  });
}

// Open onboarding mic setup page upon first extension install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'mic-setup.html' });
  }
});

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
      store.get(['sleepwalker_session_state_v1', 'sleepwalker_active_tab_id'], (data) => {
        const sess = data && data.sleepwalker_session_state_v1;
        const prevTabId = data && data.sleepwalker_active_tab_id;
        const activeModes = ['active_listening', 'active_not_listening', 'paused'];
        if (!sess || !activeModes.includes(sess.sessionMode)) return;

        if (prevTabId && prevTabId !== activeInfo.tabId) {
          chrome.tabs.sendMessage(prevTabId, { action: 'SLEEPWALKER_TAB_BACKGROUNDED' }, () => { void chrome.runtime.lastError; });
        }
        store.set({ sleepwalker_active_tab_id: activeInfo.tabId });
        chrome.tabs.sendMessage(activeInfo.tabId, { action: 'SLEEPWALKER_SYNC_SESSION', isForegroundTab: true }, () => {
          if (chrome.runtime.lastError) {
            recoverMissingContentScriptSync(activeInfo.tabId, true);
          }
        });
      });
    });
  }

  if (chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((removedTabId) => {
      const store = getSessionStore();
      if (!store) return;
      store.get(['sleepwalker_active_tab_id'], (data) => {
        if (data && data.sleepwalker_active_tab_id === removedTabId) {
          store.remove(['sleepwalker_active_tab_id'], () => { void chrome.runtime?.lastError; });
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
