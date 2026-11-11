/**
 * Sleepwalker - Vercel Serverless Function Proxy (/api/explain)
 * CodeQuest National Tech Hackathon 2026
 *
 * Node.js handler for deploying to Vercel.
 * Secures GEMINI_API_KEY, enforces CORS, applies rate limit, and returns clean answers.
 */

const RATE_LIMIT_MAP = new Map();
const RATE_WINDOW_MS = 60000;
const MAX_REQ_PER_WINDOW = 30;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = RATE_LIMIT_MAP.get(ip);
  if (!entry || now > entry.resetAt) {
    RATE_LIMIT_MAP.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  if (entry.count >= MAX_REQ_PER_WINDOW) {
    return true;
  }
  entry.count += 1;
  return false;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', origin.startsWith('chrome-extension://') ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anonymous';
  if (checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });
  }

  const { text, systemPrompt, lang } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid text field' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in Vercel environment' });
  }

  const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const defaultSystemPrompt = `Explain this page in simple words for someone with low vision or low literacy. Use short sentences, no markdown, no lists, no symbols, at most 120 words. Say what the page is for, the key facts such as fees, dates and documents, and what the user can do next. Use ONLY the page text provided. If something is not in the text, do not mention it. Reply in the user's language (English or Hindi).`;

  const requestBody = {
    system_instruction: {
      parts: [{ text: systemPrompt || defaultSystemPrompt }]
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: `Language requested: ${lang || 'en-IN'}\n\nPAGE TEXT:\n${text.substring(0, 7000)}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 250,
    }
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const geminiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: `Gemini API error: ${geminiRes.status}`, details: errText });
    }

    const data = await geminiRes.json();
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return res.status(200).json({
      answer: answer.trim(),
      source: 'cloud',
      model: modelName
    });
  } catch (err) {
    return res.status(504).json({ error: 'Upstream call timed out or failed', message: err.message });
  }
}
