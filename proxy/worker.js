/**
 * Sleepwalker - Cloudflare Worker Serverless Proxy
 * CodeQuest National Tech Hackathon 2026
 *
 * Responsibilities:
 * 1. Secures Gemini API Key server-side: Never exposes keys to client extension.
 * 2. CORS: Accepts requests from chrome-extension:// origins.
 * 3. Rate Limiting: In-memory sliding counter per IP to prevent quota abuse.
 * 4. Zero Logging: Never writes page text or user content to logs.
 * 5. Calls Google Gemini Flash API with strict temperature and formatting.
 */

// Rate limiter: Map<ip, { count: number, resetAt: number }>
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30; // Max 30 requests per minute per IP

function isRateLimited(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }

  record.count += 1;
  return false;
}

// Clean up expired rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}, 300000);

export default {
  async fetch(request, env) {
    // 1. CORS Preflight
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': origin.startsWith('chrome-extension://') ? origin : '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Rate Limiting Check
    const clientIp = request.headers.get('CF-Connecting-IP') || 'anonymous';
    if (isRateLimited(clientIp)) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Please wait a moment.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Parse Request Payload
    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { text, systemPrompt, lang } = payload || {};
    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing or invalid text field' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY is not configured in worker environment' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const modelName = env.GEMINI_MODEL || 'gemini-1.5-flash-latest';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const defaultSystemPrompt = `Explain this page in simple words for someone with low vision or low literacy. Use short sentences, no markdown, no lists, no symbols, at most 120 words. Say what the page is for, the key facts such as fees, dates and documents, and what the user can do next. Use ONLY the page text provided. If something is not in the text, do not mention it. Reply in the user's language (English or Hindi).`;

    const effectiveSystemPrompt = systemPrompt || defaultSystemPrompt;

    const requestBody = {
      system_instruction: {
        parts: [{ text: effectiveSystemPrompt }]
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
      // 8-second timeout for upstream Gemini call
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
        const errorText = await geminiRes.text();
        return new Response(
          JSON.stringify({ error: `Gemini API error: ${geminiRes.status}`, details: errorText }),
          { status: geminiRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const geminiData = await geminiRes.json();
      const answerCandidate = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Return clean answer without logging content
      return new Response(
        JSON.stringify({
          answer: answerCandidate.trim(),
          source: 'cloud',
          model: modelName
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Upstream call timed out or failed', message: err.message }),
        { status: 504, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }
};
