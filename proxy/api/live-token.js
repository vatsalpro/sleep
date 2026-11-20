/**
 * Vercel Serverless Function - /api/live-token
 * Mints short-lived constrained Gemini Live API ephemeral tokens (`v1alpha/auth_tokens`)
 * so browser/client WebSockets never receive the raw GEMINI_API_KEY.
 */
export default async function handler(req, res) {
  const origin = req.headers?.origin || '';
  if (origin && origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in server environment' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const uses = Math.max(1, Math.min(5, Number(body.uses) || 1));
  const expireTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 2 * 60 * 1000).toISOString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uses, expireTime, newSessionExpireTime }),
      signal: controller.signal
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok || !data || !data.name) {
      return res.status(upstream.status || 502).json({
        error: (data && data.error && data.error.message) || 'Failed to mint ephemeral Live token'
      });
    }
    return res.status(200).json({
      name: data.name,
      expireTime,
      ephemeral: true
    });
  } catch (err) {
    return res.status(504).json({ error: 'Ephemeral token request timed out', message: err.message });
  } finally {
    clearTimeout(timer);
  }
}
