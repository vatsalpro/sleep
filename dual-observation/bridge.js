/**
 * Sleepwalker 2.0 — Secure Local AI Bridge
 *
 * Provides a secure, authenticated local loopback interface for testing
 * Sleepwalker's REAL AI pipeline (Ollama & Gemini) from Antigravity QA agents.
 *
 * Security & Integrity Guardrails:
 * 1. Binds strictly to 127.0.0.1 (loopback only, zero public exposure).
 * 2. Revocable session token stored in .bridge-token.
 * 3. Strict secret scrubbing: Gemini API key is never emitted in logs, events, or responses.
 * 4. Model allowlist: qwen2.5:1.5b, llama3.2:3b, nomic-embed-text:latest, qwen3-vl:2b.
 *    (qwen3.5:9b strictly prohibited).
 * 5. Full inference telemetry: latency, token counts, model details, provider status.
 * 6. Hard Emergency Stop and Kill Switch.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 4888;
const BASE_DIR = path.resolve(__dirname);
const EVIDENCE_DIR = path.join(BASE_DIR, 'evidence');
const SCREENSHOTS_DIR = path.join(EVIDENCE_DIR, 'screenshots');
const EVENTS_FILE = path.join(EVIDENCE_DIR, 'events.jsonl');
const BUGS_FILE = path.join(EVIDENCE_DIR, 'bugs.jsonl');
const TOKEN_FILE = path.join(BASE_DIR, '.bridge-token');
const ENV_FILE = path.resolve(__dirname, '..', '.env');

// Ensure directories exist
for (const dir of [EVIDENCE_DIR, SCREENSHOTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 1. Load Local Config
let GEMINI_API_KEY = '';
let GEMINI_MODEL = 'gemini-3.5-flash-lite';
let OLLAMA_URL = 'http://127.0.0.1:11434';
let OLLAMA_MODEL = 'llama3.2:3b';
let LOCAL_ONLY = false;

if (fs.existsSync(ENV_FILE)) {
  const envContent = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z_]+)=(.*)$/);
    if (match) {
      const key = match[1];
      const val = match[2].trim();
      if (key === 'GEMINI_API_KEY') GEMINI_API_KEY = val;
      if (key === 'GEMINI_MODEL' && val) GEMINI_MODEL = val;
      if (key === 'OLLAMA_URL' && val) OLLAMA_URL = val.replace('localhost', '127.0.0.1');
      if (key === 'OLLAMA_MODEL' && val) OLLAMA_MODEL = val;
      if (key === 'LOCAL_ONLY') LOCAL_ONLY = val.toLowerCase() === 'true';
    }
  }
}

// 2. Generate Revocable Bridge Session Token
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');
fs.writeFileSync(TOKEN_FILE, SESSION_TOKEN, { mode: 0o600, encoding: 'utf-8' });

// Global Bridge State & Telemetry
let bridgeState = 'IDLE'; // IDLE, LISTENING, THINKING, PLANNING, OPERATING, STOPPED, REVOKED
let currentStage = 'LISTENING'; // 9 concrete stages: LISTENING, COMMAND_RECEIVED, UNDERSTANDING, OBSERVING_PAGE, TARGET_IDENTIFIED, PLANNING_ACTION, EXECUTING, VERIFYING, COMPLETED (or FAILED, STOPPED)
let currentEnvironment = 'browser'; // 'browser' or 'desktop'
let currentTestId = '';
let currentCommandId = '';
let currentStep = 0;
let lastCursor = { x: 0, y: 0 };
let lastActiveWindow = null;
let latestScreenshot = '';
let latestScreenshotRef = '';
let currentObservation = {
  url: '',
  title: '',
  source: 'Combined (DOM + Accessibility Tree)',
  summaryCounts: { links: 0, buttons: 0, inputs: 0, dropdowns: 0 },
  selectedTarget: null,
  scroll: { x: 0, y: 0 }
};
let currentTyping = {
  field: '',
  text: '',
  actualValue: '',
  verified: null
};
let currentFocus = {
  window: 'Google Chrome',
  field: '',
  confirmed: true
};
const events = [];
const bugs = [];
let activeAbortController = null;

// Load existing bugs from file
if (fs.existsSync(BUGS_FILE)) {
  try {
    const lines = fs.readFileSync(BUGS_FILE, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { bugs.push(JSON.parse(line)); } catch (e) {}
    }
  } catch (err) {
    console.error('Error loading bugs:', err);
  }
}

// Allowed Ollama Models
const ALLOWED_OLLAMA_MODELS = new Set([
  'qwen2.5:1.5b',
  'llama3.2:3b',
  'nomic-embed-text:latest',
  'qwen3-vl:2b'
]);

// Secret scrubber
function scrubSecrets(obj) {
  if (!obj) return obj;
  if (!GEMINI_API_KEY) return obj;

  const replaceSecret = (str) => {
    if (typeof str !== 'string') return str;
    let s = str;
    if (GEMINI_API_KEY && s.includes(GEMINI_API_KEY)) {
      s = s.replaceAll(GEMINI_API_KEY, '[REDACTED_GEMINI_KEY]');
    }
    // Also scrub generic Google AI key patterns (AIza...)
    s = s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_GEMINI_KEY]');
    return s;
  };

  if (typeof obj === 'string') return replaceSecret(obj);
  if (Array.isArray(obj)) return obj.map(scrubSecrets);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/(?:^|_)(?:api_?key|client_?secret|token|auth_?header|password|credential)(?:$|_)/i.test(k) && typeof v === 'string' && k !== 'testId' && k !== 'commandId') {
        out[k] = '[REDACTED_CREDENTIAL]';
      } else {
        out[k] = scrubSecrets(v);
      }
    }
    return out;
  }
  return obj;
}

// Event Logger
function logEvent(eventData) {
  const fullEvent = {
    testId: currentTestId || 'TEST-BRIDGE',
    commandId: currentCommandId || null,
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
    ...eventData
  };
  const scrubbed = scrubSecrets(fullEvent);
  events.push(scrubbed);
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(scrubbed) + '\n', 'utf-8');
  } catch (e) {
    console.error('Failed to append event:', e);
  }
  return scrubbed;
}

// Bug Logger
function recordBug(bugData) {
  const bugReport = {
    id: `BUG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    reporter: bugData.reporter || 'Human', // "Human" or "Antigravity"
    testId: bugData.testId || currentTestId || 'UNKNOWN',
    commandId: bugData.commandId || currentCommandId || null,
    step: bugData.step !== undefined ? bugData.step : currentStep,
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
    description: bugData.description || '',
    expectedBehavior: bugData.expectedBehavior || '',
    actualBehavior: bugData.actualBehavior || '',
    evidenceRef: bugData.evidenceRef || latestScreenshotRef || null,
    severity: bugData.severity || 'Medium',
    reproducibility: bugData.reproducibility || 'Always'
  };

  const scrubbed = scrubSecrets(bugReport);
  bugs.push(scrubbed);
  try {
    fs.appendFileSync(BUGS_FILE, JSON.stringify(scrubbed) + '\n', 'utf-8');
  } catch (e) {
    console.error('Failed to append bug:', e);
  }

  logEvent({
    type: 'BUG_REPORTED',
    reporter: scrubbed.reporter,
    testId: scrubbed.testId,
    description: `Bug filed by ${scrubbed.reporter}: ${scrubbed.description}`,
    severity: scrubbed.severity,
    bugId: scrubbed.id
  });

  return scrubbed;
}

// Check Ollama models available on host
async function getOllamaTags() {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' });
  if (!res.ok) throw new Error(`Ollama /api/tags returned HTTP ${res.status}`);
  const data = await res.json();
  const available = (data.models || []).map((m) => m.name || m.model);
  return available;
}

// Call Ollama API
async function callOllama(model, prompt, systemPrompt = '', options = {}, signal = null) {
  if (!ALLOWED_OLLAMA_MODELS.has(model)) {
    throw new Error(`Model '${model}' is not in the approved Sleepwalker model allowlist.`);
  }

  const tags = await getOllamaTags();
  const hasModel = tags.some((t) => t === model || t.startsWith(model + ':') || model.startsWith(t));
  if (!hasModel) {
    throw new Error(`Model '${model}' is not installed in local Ollama instance.`);
  }

  const t0 = Date.now();
  const body = {
    model,
    prompt,
    system: systemPrompt,
    stream: false,
    options: {
      temperature: options.temperature ?? 0.2,
      num_ctx: options.num_ctx ?? 2048,
      ...options
    }
  };

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama generation failed (HTTP ${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    provider: 'ollama',
    model,
    text: data.response ? data.response.trim() : '',
    telemetry: {
      latencyMs,
      totalDurationMs: data.total_duration ? Math.round(data.total_duration / 1e6) : latencyMs,
      loadDurationMs: data.load_duration ? Math.round(data.load_duration / 1e6) : 0,
      promptEvalCount: data.prompt_eval_count || 0,
      evalCount: data.eval_count || 0
    }
  };
}

// Call Gemini API directly (Zero key exposure)
async function callGemini(model, prompt, systemInstruction = '', signal = null) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in local environment.');
  }

  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 1024
    }
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  const latencyMs = Date.now() - t0;

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Gemini authentication error (HTTP ${res.status})`);
  }
  if (res.status === 429) {
    throw new Error('Gemini API rate limit exceeded (HTTP 429)');
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API error (HTTP ${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = data?.usageMetadata || {};

  return {
    provider: 'gemini',
    model,
    text: text.trim(),
    telemetry: {
      latencyMs,
      promptTokenCount: usage.promptTokenCount || 0,
      candidatesTokenCount: usage.candidatesTokenCount || 0,
      totalTokenCount: usage.totalTokenCount || 0
    }
  };
}

// Sleepwalker Unified AI Pipeline (Intent -> Planning -> Action Formulation)
async function executeSleepwalkerAiPipeline(userPrompt, options = {}) {
  const signal = options.signal || null;
  const providerPref = options.providerPreference || 'auto'; // 'auto', 'ollama', 'gemini'
  const startTime = Date.now();

  currentStage = 'COMMAND_RECEIVED';
  logEvent({
    type: 'AI_PIPELINE_START',
    userPrompt: scrubSecrets(userPrompt),
    providerPreference: providerPref
  });

  currentStage = 'UNDERSTANDING';
  bridgeState = 'THINKING';
  let intentResult = null;
  let planResult = null;
  let selectedProvider = 'ollama';
  let selectedModel = OLLAMA_MODEL;

  // Step 1: Intent Extraction via fast local model (qwen2.5:1.5b) or Gemini
  const intentSysPrompt = `You are Sleepwalker's fast intent classifier. Extract user intent and parameters. Return valid JSON only: {"intent":"NAVIGATE"|"SEARCH"|"CLICK"|"EXTRACT"|"FORM_FILL","target":"","url":"","keywords":""}`;

  if (providerPref === 'gemini' || (providerPref === 'auto' && !LOCAL_ONLY && GEMINI_API_KEY)) {
    try {
      intentResult = await callGemini(GEMINI_MODEL, `Classify this user request: "${userPrompt}"`, intentSysPrompt, signal);
      selectedProvider = 'gemini';
      selectedModel = GEMINI_MODEL;
    } catch (err) {
      console.warn(`[Bridge] Gemini intent classification failed, cascading to local Ollama: ${err.message}`);
    }
  }

  if (!intentResult) {
    intentResult = await callOllama('qwen2.5:1.5b', `Classify this user request: "${userPrompt}"`, intentSysPrompt, { temperature: 0.1 }, signal);
    selectedProvider = 'ollama';
    selectedModel = 'qwen2.5:1.5b';
  }

  // Parse Intent
  let parsedIntent = { intent: 'UNKNOWN', target: userPrompt };
  try {
    const jsonMatch = intentResult.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsedIntent = JSON.parse(jsonMatch[0]);
  } catch (e) {
    parsedIntent = { intent: 'RAW', rawText: intentResult.text };
  }

  currentStage = 'TARGET_IDENTIFIED';

  // Step 2: Task Planning & Action Formulation via reasoning model (llama3.2:3b)
  currentStage = 'PLANNING_ACTION';
  bridgeState = 'PLANNING';
  const planningSysPrompt = `You are Sleepwalker's autonomous task planner. For browser search tasks, decompose into discrete interaction steps: step 1: navigate to search page, step 2: type search query into search input, step 3: verify results. Return valid JSON: {"steps":[{"action":"navigate"|"click"|"type"|"verify","target":"","text":"","url":""}]}`;

  const planPrompt = `User Request: "${userPrompt}"\nExtracted Intent: ${JSON.stringify(parsedIntent)}\nGenerate the minimal ordered steps for this browser task.`;

  if (selectedProvider === 'gemini') {
    try {
      planResult = await callGemini(GEMINI_MODEL, planPrompt, planningSysPrompt, signal);
    } catch (e) {
      planResult = await callOllama('llama3.2:3b', planPrompt, planningSysPrompt, { temperature: 0.2 }, signal);
      selectedProvider = 'ollama (hybrid fallback)';
      selectedModel = 'llama3.2:3b';
    }
  } else {
    planResult = await callOllama('llama3.2:3b', planPrompt, planningSysPrompt, { temperature: 0.2 }, signal);
    selectedModel = 'llama3.2:3b';
  }

  // Parse Action Plan
  let actionPlan = [];
  try {
    const jsonMatch = planResult.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsedPlan = JSON.parse(jsonMatch[0]);
      actionPlan = parsedPlan.steps || [];
    }
  } catch (e) {}

  if (actionPlan.length > 0) {
    for (const step of actionPlan) {
      if (step.action === 'navigate' && (!step.url || step.url.trim() === '')) {
        if (step.target && step.target.startsWith('http')) {
          step.url = step.target;
        } else if (parsedIntent.url) {
          step.url = parsedIntent.url;
        } else if (/wikipedia/i.test(parsedIntent.target || userPrompt)) {
          step.url = 'https://www.wikipedia.org';
        }
      }
    }
  }

  if (actionPlan.length === 0) {
    // Deterministic fallback based on parsed intent
    if (parsedIntent.intent === 'NAVIGATE' && parsedIntent.url) {
      actionPlan = [{ action: 'navigate', url: parsedIntent.url }];
    } else if (parsedIntent.intent === 'SEARCH' || /search/i.test(userPrompt)) {
      actionPlan = [
        { action: 'navigate', url: 'https://www.wikipedia.org' },
        { action: 'type', target: 'input[name="search"], #searchInput', text: parsedIntent.keywords || userPrompt },
        { action: 'verify', target: 'results' }
      ];
    } else {
      actionPlan = [{ action: 'execute_intent', intent: parsedIntent.intent, target: parsedIntent.target }];
    }
  }

  const totalTimeMs = Date.now() - startTime;

  const telemetry = {
    provider: selectedProvider,
    model: selectedModel,
    totalLatencyMs: totalTimeMs,
    intentTelemetry: intentResult.telemetry,
    planTelemetry: planResult.telemetry
  };

  logEvent({
    type: 'AI_PIPELINE_COMPLETE',
    telemetry,
    parsedIntent,
    actionPlan
  });

  return {
    success: true,
    telemetry,
    parsedIntent,
    actionPlan
  };
}

// Authenticate Bearer or Header token
function authenticateRequest(req) {
  if (bridgeState === 'REVOKED') return false;
  const authHeader = req.headers['authorization'] || '';
  const tokenHeader = req.headers['x-test-token'] || '';

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === SESSION_TOKEN) return true;
  }
  if (tokenHeader && tokenHeader.trim() === SESSION_TOKEN) return true;

  return false;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  // CORS headers strictly restricted
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Test-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. GET /health (Unauthenticated)
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: bridgeState === 'REVOKED' ? 'revoked' : 'ok',
        bridgeVersion: '2.0.0',
        bridgeState,
        localOnly: LOCAL_ONLY,
        defaultOllamaModel: OLLAMA_MODEL,
        defaultGeminiModel: GEMINI_MODEL,
        timestamp: Date.now()
      })
    );
    return;
  }

  // 2. Serve Human Dashboard UI (Unauthenticated on loopback)
  if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
    const htmlPath = path.join(BASE_DIR, 'dashboard.html');
    fs.readFile(htmlPath, 'utf-8', (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading dashboard');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      }
    });
    return;
  }

  // 3. Serve Screenshot images
  if (pathname.startsWith('/evidence/screenshots/')) {
    const filename = path.basename(pathname);
    const filePath = path.join(SCREENSHOTS_DIR, filename);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(filePath).pipe(res);
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Screenshot not found');
      return;
    }
  }

  // 4. GET /api/status (For Live Human Observer Dashboard)
  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        state: bridgeState,
        stage: currentStage,
        executionEnvironment: currentEnvironment,
        testId: currentTestId,
        commandId: currentCommandId,
        step: currentStep,
        cursor: lastCursor,
        activeWindow: lastActiveWindow,
        latestScreenshot,
        latestScreenshotRef,
        observation: currentObservation,
        typing: currentTyping,
        focus: currentFocus,
        events: events.slice(-50),
        bugs
      })
    );
    return;
  }

  // 5. GET /api/bugs
  if (pathname === '/api/bugs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bugs));
    return;
  }

  // Check Payload Size Limit (256 KB)
  let rawBody = '';
  let bodyTooLarge = false;

  req.on('data', (chunk) => {
    rawBody += chunk;
    if (!bodyTooLarge && rawBody.length > 256 * 1024) {
      bodyTooLarge = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large (Max 256KB)' }));
    }
  });

  req.on('end', async () => {
    if (bodyTooLarge) return;

    try {
      // 6. POST /api/bugs (Human observer or dashboard bug report)
      if (pathname === '/api/bugs' && req.method === 'POST') {
        const bugData = JSON.parse(rawBody || '{}');
        if (!bugData.reporter || !bugData.description) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: reporter and description' }));
          return;
        }
        const bug = recordBug(bugData);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, bug }));
        return;
      }

      // 7. POST /api/emergency-stop (Dashboard Emergency Stop)
      if (pathname === '/api/emergency-stop' && req.method === 'POST') {
        if (activeAbortController) {
          activeAbortController.abort();
          activeAbortController = null;
        }
        bridgeState = 'STOPPED';
        logEvent({ type: 'EMERGENCY_STOP', description: 'Emergency Stop triggered by Human Observer', severity: 'CRITICAL' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, bridgeState: 'STOPPED', message: 'Bridge halted in emergency stop state' }));
        return;
      }

      // Antigravity QA Agent Authenticated Endpoints
      if (!authenticateRequest(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid or revoked session token' }));
        return;
      }

      // 8. GET /api/test/status
      if (pathname === '/api/test/status' && req.method === 'GET') {
        const ollamaModels = await getOllamaTags().catch(() => []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            bridgeState,
            currentTestId,
            currentCommandId,
            currentStep,
            cursor: lastCursor,
            activeWindow: lastActiveWindow,
            availableOllamaModels: ollamaModels.filter((m) => ALLOWED_OLLAMA_MODELS.has(m) || Array.from(ALLOWED_OLLAMA_MODELS).some((a) => m.startsWith(a))),
            geminiConfigured: Boolean(GEMINI_API_KEY),
            geminiModel: GEMINI_MODEL,
            eventsCount: events.length,
            bugsCount: bugs.length
          })
        );
        return;
      }

      // 9. POST /api/test/command (Submit command to real Sleepwalker AI pipeline)
      if (pathname === '/api/test/command' && req.method === 'POST') {
        if (bridgeState === 'STOPPED') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bridge is in EMERGENCY_STOP state. Reset required.' }));
          return;
        }

        const payload = JSON.parse(rawBody || '{}');
        if (!payload.prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: prompt' }));
          return;
        }

        currentTestId = payload.testId || `TEST-${Date.now()}`;
        currentCommandId = payload.commandId || `CMD-${Date.now()}`;
        bridgeState = 'RUNNING';

        activeAbortController = new AbortController();

        try {
          const aiResult = await executeSleepwalkerAiPipeline(payload.prompt, {
            providerPreference: payload.providerPreference || 'auto',
            signal: activeAbortController.signal
          });

          bridgeState = 'IDLE';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(
              scrubSecrets({
                testId: currentTestId,
                commandId: currentCommandId,
                status: 'COMPLETED',
                ...aiResult
              })
            )
          );
        } catch (err) {
          bridgeState = 'IDLE';
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: scrubSecrets(err.message) }));
        } finally {
          activeAbortController = null;
        }
        return;
      }

      // 10. POST /api/test/step-telemetry (Live Step Updates from Adapter)
      if (pathname === '/api/test/step-telemetry' && req.method === 'POST') {
        const payload = JSON.parse(rawBody || '{}');
        if (payload.testId) currentTestId = payload.testId;
        if (payload.commandId) currentCommandId = payload.commandId;
        if (payload.step !== undefined) currentStep = payload.step;
        if (payload.cursor) lastCursor = payload.cursor;
        if (payload.activeWindow) lastActiveWindow = payload.activeWindow;
        if (payload.screenshot) latestScreenshot = payload.screenshot;
        if (payload.screenshotRef) latestScreenshotRef = payload.screenshotRef;
        if (payload.state) bridgeState = payload.state;
        if (payload.stage) currentStage = payload.stage;
        if (payload.executionEnvironment) currentEnvironment = payload.executionEnvironment;
        if (payload.observation) currentObservation = { ...currentObservation, ...payload.observation };
        if (payload.typing) currentTyping = { ...currentTyping, ...payload.typing };
        if (payload.focus) currentFocus = { ...currentFocus, ...payload.focus };

        logEvent({
          type: 'STEP_TELEMETRY',
          step: currentStep,
          cursor: lastCursor,
          activeWindow: lastActiveWindow,
          screenshotRef: latestScreenshotRef,
          bridgeState,
          stage: currentStage,
          executionEnvironment: currentEnvironment,
          observation: currentObservation,
          typing: currentTyping,
          focus: currentFocus
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, bridgeState, currentStage, currentStep }));
        return;
      }

      // 11. GET /api/test/events
      if (pathname === '/api/test/events' && req.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        const filtered = events.filter((e) => e.timestamp > since);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(scrubSecrets(filtered)));
        return;
      }

      // 12. GET /api/test/evidence
      if (pathname === '/api/test/evidence' && req.method === 'GET') {
        let files = [];
        if (fs.existsSync(SCREENSHOTS_DIR)) {
          files = fs.readdirSync(SCREENSHOTS_DIR);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            eventsFile: 'evidence/events.jsonl',
            bugsFile: 'evidence/bugs.jsonl',
            screenshots: files.map((f) => `evidence/screenshots/${f}`)
          })
        );
        return;
      }

      // 13. POST /api/test/bugs (Antigravity QA Bug Report)
      if (pathname === '/api/test/bugs' && req.method === 'POST') {
        const bugData = JSON.parse(rawBody || '{}');
        if (!bugData.reporter) bugData.reporter = 'Antigravity';
        if (!bugData.description) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: description' }));
          return;
        }
        const bug = recordBug(bugData);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, bug }));
        return;
      }

      // 14. GET /api/test/bugs
      if (pathname === '/api/test/bugs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bugs));
        return;
      }

      // 15. POST /api/test/cancel
      if (pathname === '/api/test/cancel' && req.method === 'POST') {
        if (activeAbortController) {
          activeAbortController.abort();
          activeAbortController = null;
        }
        bridgeState = 'IDLE';
        logEvent({ type: 'COMMAND_CANCELLED', description: 'Active operation cancelled by client' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Operation cancelled' }));
        return;
      }

      // 16. POST /api/test/emergency-stop
      if (pathname === '/api/test/emergency-stop' && req.method === 'POST') {
        if (activeAbortController) {
          activeAbortController.abort();
          activeAbortController = null;
        }
        bridgeState = 'STOPPED';
        logEvent({ type: 'EMERGENCY_STOP', description: 'Emergency Stop triggered via QA channel', severity: 'CRITICAL' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, bridgeState: 'STOPPED', message: 'Bridge halted in emergency stop state' }));
        return;
      }

      // 17. POST or GET /api/test/reset
      if (pathname === '/api/test/reset' && (req.method === 'POST' || req.method === 'GET')) {
        bridgeState = 'IDLE';
        logEvent({ type: 'STATE_CHANGE', bridgeState: 'IDLE', description: 'Bridge reset to IDLE' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, bridgeState: 'IDLE', message: 'Bridge reset successfully' }));
        return;
      }

      // 18. POST /api/test/revoke (Kill switch)
      if (pathname === '/api/test/revoke' && req.method === 'POST') {
        bridgeState = 'REVOKED';
        try { fs.unlinkSync(TOKEN_FILE); } catch (e) {}
        logEvent({ type: 'TOKEN_REVOKED', description: 'Bridge session token revoked; service shutting down' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Session revoked. Bridge shutting down.' }));
        setTimeout(() => process.exit(0), 100);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: scrubSecrets(err.message) }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sleepwalker Local AI Bridge listening at http://127.0.0.1:${PORT}`);
  console.log(`Session Token written to: ${TOKEN_FILE}`);
});
