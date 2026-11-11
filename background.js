/**
 * Sleepwalker - Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 * 1. Listen for toolbar icon clicks and the Alt+S shortcut (via _execute_action).
 * 2. Check for restricted browser pages (chrome://, Web Store, etc.) and inform user.
 * 3. Send toggle message to the active tab, dynamically injecting scripts if needed.
 * 4. Manage LLM Cascade (cache -> Gemini proxy -> local Ollama -> offline fallback).
 */

// Import LLM Cascade handler into the service worker
importScripts('llm.js');

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
        files: [
          'reader.js',
          'outline.js',
          'voice.js',
          'pill.js',
          'glow.js',
          'explain.js',
          'widget.js',
          'content.js'
        ]
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

/**
 * Handle incoming explanation requests from content scripts.
 * Cascades: In-memory Cache -> Cloud Gemini Proxy -> Local Ollama -> Offline Fallback.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === 'SLEEPWALKER_EXPLAIN_REQUEST') {
    handleExplainRequest(message.payload)
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

  // Open mic setup tab
  if (message.type === 'SLEEPWALKER_OPEN_MIC_SETUP') {
    chrome.tabs.create({ url: 'mic-setup.html' });
    sendResponse({ status: 'opened' });
    return false;
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
});

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
