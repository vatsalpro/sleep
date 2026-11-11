/**
 * Sleepwalker - llm.js
 * CodeQuest National Tech Hackathon 2026
 *
 * Background Service Worker LLM Cascade
 *
 * Responsibilities:
 * 1. Step a: In-memory cache keyed by page URL (without query string) + section + language.
 * 2. Step b: Cloud serverless proxy (Gemini Flash / Flash-Lite).
 *    - Uses user-configured proxy URL stored in chrome.storage.local.
 *    - 8-second timeout, 60-second circuit breaker on failure.
 * 3. Step c: Local Ollama (http://localhost:11434, llama3.2:3b, num_ctx 4096, temp 0.2).
 *    - Caches /api/tags availability for 60 seconds.
 * 4. Step d: Signals offline fallback if both are unavailable.
 * 5. Strict System Prompt enforced across all providers.
 */

const SYSTEM_PROMPT = `Explain this page in simple words for someone with low vision or low literacy. Use short sentences, no markdown, no lists, no symbols, at most 120 words. Say what the page is for, the key facts such as fees, dates and documents, and what the user can do next. Use ONLY the page text provided. If something is not in the text, do not mention it. Reply in the user's language (English or Hindi).`;

// 1. In-memory cache: Map<key, { answer: string, timestamp: number }>
const EXPLAIN_CACHE = new Map();

// Circuit breakers & status caches
let lastGeminiFailureTimestamp = 0;
let cachedOllamaAvailable = null;
let lastOllamaCheckTimestamp = 0;

/**
 * Handle incoming explanation request from content script.
 * @param {Object} payload
 * @param {string} payload.urlClean - URL without query string
 * @param {string} payload.section - Section name or 'all'
 * @param {string} payload.lang - 'en-IN' or 'hi-IN'
 * @param {string} payload.pageText - Clean extracted text
 * @returns {Promise<{ status: string, answer?: string, source?: string }>}
 */
async function handleExplainRequest(payload) {
  const { urlClean, section, lang, pageText } = payload;
  const cacheKey = `${urlClean}::${section || 'all'}::${lang || 'en-IN'}`;

  // 1. Step a: Check In-Memory Cache
  const cached = EXPLAIN_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 3600000) { // 1 hour TTL
    console.log('[Sleepwalker LLM] Cache hit for:', cacheKey);
    return { status: 'ok', answer: cached.answer, source: 'cache' };
  }

  // Read user configuration from storage
  const config = await getLlmConfig();

  // If user enabled "Local Only" mode, skip Cloud Gemini completely
  if (!config.localOnly) {
    // 2. Step b: Cloud Gemini via Serverless Proxy
    const proxyResult = await callGeminiProxy(config.proxyUrl, pageText, lang);
    if (proxyResult && proxyResult.answer) {
      EXPLAIN_CACHE.set(cacheKey, { answer: proxyResult.answer, timestamp: Date.now() });
      return { status: 'ok', answer: proxyResult.answer, source: 'cloud' };
    }
  }

  // 3. Step c: Local Ollama
  const ollamaResult = await callLocalOllama(config.ollamaUrl, config.ollamaModel, pageText, lang);
  if (ollamaResult && ollamaResult.answer) {
    EXPLAIN_CACHE.set(cacheKey, { answer: ollamaResult.answer, timestamp: Date.now() });
    return { status: 'ok', answer: ollamaResult.answer, source: 'local' };
  }

  // 4. Step d: Offline Fallback
  console.log('[Sleepwalker LLM] Cascade exhausted; triggering offline extractive fallback.');
  return { status: 'fallback', source: 'basic summary' };
}

/**
 * Read LLM settings from chrome.storage.local with safe defaults.
 */
function getLlmConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['sleepwalker_proxy_url', 'sleepwalker_ollama_url', 'sleepwalker_ollama_model', 'sleepwalker_local_only'],
      (data) => {
        resolve({
          proxyUrl: (data.sleepwalker_proxy_url || '').trim(),
          ollamaUrl: (data.sleepwalker_ollama_url || 'http://localhost:11434').trim(),
          ollamaModel: (data.sleepwalker_ollama_model || 'llama3.2:3b').trim(),
          localOnly: Boolean(data.sleepwalker_local_only)
        });
      }
    );
  });
}

/**
 * Call serverless proxy (Gemini API).
 * Implements 8s timeout and 60s circuit breaker.
 */
async function callGeminiProxy(proxyUrl, pageText, lang) {
  if (!proxyUrl) {
    return null; // No proxy configured by user yet
  }

  // Circuit breaker: skip Gemini if failed within last 60 seconds
  const now = Date.now();
  if (now - lastGeminiFailureTimestamp < 60000) {
    console.log('[Sleepwalker LLM] Circuit breaker open for Gemini proxy (cooldown active). Skipping.');
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: pageText,
        systemPrompt: SYSTEM_PROMPT,
        lang: lang || 'en-IN'
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[Sleepwalker LLM] Gemini proxy returned status: ${response.status}`);
      lastGeminiFailureTimestamp = Date.now(); // Trip circuit breaker
      return null;
    }

    const data = await response.json();
    if (data && data.answer && typeof data.answer === 'string') {
      return { answer: data.answer.trim() };
    }

    lastGeminiFailureTimestamp = Date.now();
    return null;
  } catch (err) {
    console.warn('[Sleepwalker LLM] Gemini proxy call failed:', err.message);
    lastGeminiFailureTimestamp = Date.now();
    return null;
  }
}

/**
 * Check if local Ollama server is running (cached ping for 60s).
 */
async function isOllamaAvailable(ollamaUrl) {
  const now = Date.now();
  if (cachedOllamaAvailable !== null && now - lastOllamaCheckTimestamp < 60000) {
    return cachedOllamaAvailable;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s quick ping
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeoutId);

    cachedOllamaAvailable = res.ok;
    lastOllamaCheckTimestamp = now;
    return cachedOllamaAvailable;
  } catch (e) {
    cachedOllamaAvailable = false;
    lastOllamaCheckTimestamp = now;
    return false;
  }
}

/**
 * Call local Ollama instance (http://localhost:11434).
 */
async function callLocalOllama(ollamaUrl, modelName, pageText, lang) {
  const available = await isOllamaAvailable(ollamaUrl);
  if (!available) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

    const prompt = `${SYSTEM_PROMPT}\n\nPAGE CONTENT:\n${pageText}\n\nEXPLANATION:`;

    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName || 'llama3.2:3b',
        prompt,
        stream: false,
        options: {
          num_ctx: 4096,
          temperature: 0.2
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[Sleepwalker LLM] Ollama returned status: ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (data && data.response) {
      return { answer: data.response.trim() };
    }
    return null;
  } catch (err) {
    console.warn('[Sleepwalker LLM] Ollama generation failed:', err.message);
    return null;
  }
}
