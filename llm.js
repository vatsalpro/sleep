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

// Pre-configured default key (loaded from config.local.js or chrome.storage.local)
const DEFAULT_GEMINI_API_KEY = (typeof self !== 'undefined' && self.SLEEPWALKER_DEFAULT_KEY) || '';

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
    // 2. Step b1: Direct Gemini API Call (Highest speed & reliability)
    if (config.geminiApiKey) {
      const directResult = await callDirectGemini(config.geminiApiKey, pageText, lang, section);
      if (directResult && directResult.answer) {
        EXPLAIN_CACHE.set(cacheKey, { answer: directResult.answer, timestamp: Date.now() });
        return { status: 'ok', answer: directResult.answer, source: directResult.model || 'Gemini Flash' };
      }
    }

    // 2. Step b2: Cloud Gemini via Serverless Proxy (if configured)
    if (config.proxyUrl) {
      const proxyResult = await callGeminiProxy(config.proxyUrl, pageText, lang);
      if (proxyResult && proxyResult.answer) {
        EXPLAIN_CACHE.set(cacheKey, { answer: proxyResult.answer, timestamp: Date.now() });
        return { status: 'ok', answer: proxyResult.answer, source: 'cloud proxy' };
      }
    }
  }

  // 3. Step c: Local Ollama
  const ollamaResult = await callLocalOllama(config.ollamaUrl, config.ollamaModel, pageText, lang);
  if (ollamaResult && ollamaResult.answer) {
    EXPLAIN_CACHE.set(cacheKey, { answer: ollamaResult.answer, timestamp: Date.now() });
    return { status: 'ok', answer: ollamaResult.answer, source: 'local ollama' };
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
      [
        'sleepwalker_gemini_api_key',
        'sleepwalker_proxy_url',
        'sleepwalker_ollama_url',
        'sleepwalker_ollama_model',
        'sleepwalker_local_only'
      ],
      (data) => {
        resolve({
          geminiApiKey: (data.sleepwalker_gemini_api_key !== undefined ? data.sleepwalker_gemini_api_key : DEFAULT_GEMINI_API_KEY).trim(),
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
 * Call Google Gemini API directly from background service worker.
 * Uses high-availability models with automatic fallback.
 */
async function callDirectGemini(apiKey, pageText, lang, section = 'all') {
  if (!apiKey) return null;

  const isHindi = lang === 'hi-IN';
  const isSectionSpecific = section && section !== 'all';

  const systemInstruction = isSectionSpecific
    ? (isHindi
        ? `इस पेज के "${section}" भाग को सरल और आसान शब्दों में समझाएं। छोटे वाक्यों का उपयोग करें, कोई मार्कडाउन (*, #) या सूची नहीं, अधिकतम 100 शब्द। केवल पेज में दिए गए तथ्यों को बताएं।`
        : `Explain the "${section}" section of this page in simple words for someone with low vision. Use short clear sentences, no markdown, no bullet points, max 100 words. State key facts like fees, dates, or eligibility. Use ONLY the provided page text.`)
    : (isHindi
        ? `इस पेज को सरल और आसान शब्दों में समझाएं। छोटे वाक्यों का उपयोग करें, कोई मार्कडाउन या सूची नहीं, अधिकतम 120 शब्द। बताएं कि पेज किस बारे में है, मुख्य तारीखें, फीस और दस्तावेज। केवल दिए गए टेक्स्ट का उपयोग करें।`
        : `Explain this page in simple words for someone with low vision or low literacy. Use short sentences, no markdown, no lists, no symbols, at most 120 words. Say what the page is for, key facts such as fees, dates and documents, and what the user can do next. Use ONLY the page text provided.`);

  // Supported model tiers in order of speed and stability
  const models = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: `${systemInstruction}\n\nPAGE TEXT:\n${pageText.substring(0, 9000)}` }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 250
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[Sleepwalker LLM] Gemini ${model} HTTP status ${response.status}`);
        continue;
      }

      const data = await response.json();
      const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (answer && typeof answer === 'string' && answer.trim()) {
        const cleanAnswer = stripMarkdown(answer.trim());
        const modelName = model === 'gemini-flash-lite-latest'
          ? 'Gemini Flash-Lite'
          : (model === 'gemini-3.5-flash-lite' ? 'Gemini 3.5 Flash-Lite' : 'Gemini Flash');
        console.log(`[Sleepwalker LLM] Direct Gemini succeeded with model: ${model}`);
        return { answer: cleanAnswer, model: modelName };
      }
    } catch (err) {
      console.warn(`[Sleepwalker LLM] Direct Gemini error on ${model}:`, err.message);
    }
  }

  return null;
}

/**
 * Clean markdown symbols from AI responses so TTS reads naturally without symbol noise.
 */
function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•+]\s+/gm, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
