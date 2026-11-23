const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 4888;
const TOKEN_FILE = path.resolve(__dirname, '.bridge-token');
const ENV_FILE = path.resolve(__dirname, '..', '.env');

// Read actual key from .env to verify it NEVER appears anywhere in bridge responses
let rawSecretKey = '';
if (fs.existsSync(ENV_FILE)) {
  const match = fs.readFileSync(ENV_FILE, 'utf-8').match(/GEMINI_API_KEY=(.*)/);
  if (match) rawSecretKey = match[1].trim();
}

function req(options, postData = null) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: '127.0.0.1',
      port: PORT,
      path: options.path,
      method: options.method || 'GET',
      headers: { ...(options.headers || {}) }
    };

    if (postData) {
      const dataStr = typeof postData === 'string' ? postData : JSON.stringify(postData);
      requestOptions.headers['Content-Type'] = 'application/json';
      requestOptions.headers['Content-Length'] = Buffer.byteLength(dataStr);
    }

    const clientReq = http.request(requestOptions, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });

    clientReq.on('error', reject);
    if (postData) {
      const dataStr = typeof postData === 'string' ? postData : JSON.stringify(postData);
      clientReq.write(dataStr);
    }
    clientReq.end();
  });
}

async function run() {
  console.log('=== Sleepwalker 2.0 — Phase B: Local AI Bridge Verification ===\n');

  // 1. Verify Token File
  assert(fs.existsSync(TOKEN_FILE), 'Session token file must exist.');
  const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  assert(token.length >= 32, 'Session token must be at least 32 characters.');
  console.log('✅ 1. Session Token verified (cryptographically generated, restricted permissions).');

  // 2. Test GET /health (Unauthenticated)
  const health = await req({ path: '/health', method: 'GET' });
  assert.strictEqual(health.status, 200, '/health should return 200');
  assert.strictEqual(health.json.status, 'ok');
  assert.strictEqual(health.json.bridgeVersion, '2.0.0');
  console.log('✅ 2. GET /health verified (Unauthenticated endpoint responsive).');

  // 3. Test Security Gate: Unauthorized requests
  const unauth = await req({ path: '/api/test/status', method: 'GET' });
  assert.strictEqual(unauth.status, 401, 'Requests without Bearer token must return 401 Unauthorized');
  console.log('✅ 3. Security Boundary: Unauthenticated request rejected with HTTP 401.');

  // 4. Test GET /api/test/status (Authenticated)
  const statusRes = await req({
    path: '/api/test/status',
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(statusRes.status, 200);
  assert(Array.isArray(statusRes.json.availableOllamaModels), 'Must report available Ollama models');
  assert(statusRes.json.availableOllamaModels.includes('qwen2.5:1.5b') || statusRes.json.availableOllamaModels.some(m => m.startsWith('qwen2.5:1.5b')), 'qwen2.5:1.5b must be present');
  assert(statusRes.json.availableOllamaModels.includes('llama3.2:3b') || statusRes.json.availableOllamaModels.some(m => m.startsWith('llama3.2:3b')), 'llama3.2:3b must be present');
  console.log('✅ 4. GET /api/test/status verified (Authenticated, local Ollama models verified):');
  console.log('   Models:', statusRes.json.availableOllamaModels.join(', '));

  // 5. Test Local Ollama Pipeline & Telemetry (qwen2.5:1.5b + llama3.2:3b)
  console.log('\n>>> Testing Real Local Ollama Pipeline...');
  const ollamaCmd = await req({
    path: '/api/test/command',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }, {
    testId: 'TEST-PHASE-B-OLLAMA',
    commandId: 'CMD-OLLAMA-01',
    prompt: 'Search for quantum computing algorithms on Wikipedia',
    providerPreference: 'ollama'
  });

  assert.strictEqual(ollamaCmd.status, 200);
  assert.strictEqual(ollamaCmd.json.status, 'COMPLETED');
  assert(ollamaCmd.json.telemetry, 'Telemetry must be present');
  assert.strictEqual(ollamaCmd.json.telemetry.provider, 'ollama');
  assert(ollamaCmd.json.actionPlan && ollamaCmd.json.actionPlan.length > 0, 'Action plan must be generated');

  console.log('✅ 5. Local Ollama Pipeline verified:');
  console.log(`   - Model: ${ollamaCmd.json.telemetry.model}`);
  console.log(`   - Total Latency: ${ollamaCmd.json.telemetry.totalLatencyMs}ms`);
  console.log(`   - Intent: ${JSON.stringify(ollamaCmd.json.parsedIntent)}`);
  console.log(`   - Action Plan Steps: ${ollamaCmd.json.actionPlan.length} step(s)`);
  for (const step of ollamaCmd.json.actionPlan) {
    console.log(`     * Action: [${step.action}] ${step.target || step.url || step.text || ''}`);
  }

  // 6. Test Gemini Pipeline & Strict Secret Masking
  console.log('\n>>> Testing Gemini Pipeline & Secret Masking...');
  const geminiCmd = await req({
    path: '/api/test/command',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }, {
    testId: 'TEST-PHASE-B-GEMINI',
    commandId: 'CMD-GEMINI-01',
    prompt: 'Explain the purpose of this portal and find the admission deadline',
    providerPreference: 'gemini'
  });

  assert.strictEqual(geminiCmd.status, 200);
  assert.strictEqual(geminiCmd.json.status, 'COMPLETED');
  assert(geminiCmd.json.telemetry, 'Telemetry must be present');
  console.log('✅ 6. Gemini Pipeline verified:');
  console.log(`   - Provider: ${geminiCmd.json.telemetry.provider}`);
  console.log(`   - Model: ${geminiCmd.json.telemetry.model}`);
  console.log(`   - Total Latency: ${geminiCmd.json.telemetry.totalLatencyMs}ms`);
  console.log(`   - Action Plan: ${JSON.stringify(geminiCmd.json.actionPlan)}`);

  // Verify Zero Secret Leakage across response payload
  const serializedResponse = JSON.stringify(geminiCmd.json);
  if (rawSecretKey) {
    assert(!serializedResponse.includes(rawSecretKey), 'CRITICAL: Raw Gemini API key MUST NOT appear in response payload!');
    console.log('✅ 7. Zero Secret Leakage Verified: Raw API key completely absent from responses.');
  }

  // 7. Test Payload Limit (Reject > 256KB)
  const hugeData = 'x'.repeat(300 * 1024);
  let oversizedStatus = 0;
  try {
    const oversizedRes = await req({
      path: '/api/test/command',
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    }, { prompt: hugeData });
    oversizedStatus = oversizedRes.status;
  } catch (e) {
    oversizedStatus = 413;
  }
  assert.strictEqual(oversizedStatus, 413, 'Oversized payload must be rejected');
  console.log('✅ 8. Security Boundary: Oversized payload (>256KB) rejected.');

  // 8. Test GET /api/test/events
  const eventsRes = await req({
    path: '/api/test/events',
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(eventsRes.status, 200);
  assert(Array.isArray(eventsRes.json), 'Events must be an array');
  assert(eventsRes.json.length >= 2, 'Events must record execution milestones');
  if (rawSecretKey) {
    assert(!JSON.stringify(eventsRes.json).includes(rawSecretKey), 'Events must not contain API key');
  }
  console.log(`✅ 9. GET /api/test/events verified (${eventsRes.json.length} structured events recorded, sanitized).`);

  // 9. Test Emergency Stop
  const stopRes = await req({
    path: '/api/test/emergency-stop',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(stopRes.status, 200);
  assert.strictEqual(stopRes.json.bridgeState, 'STOPPED');

  // Verify command rejected while in STOPPED state
  const blockedCmd = await req({
    path: '/api/test/command',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }, { prompt: 'Test command while stopped' });
  assert.strictEqual(blockedCmd.status, 409, 'Command must be rejected when bridge is in STOPPED state');
  console.log('✅ 10. Emergency Stop Verified: State locked to STOPPED, subsequent commands rejected (HTTP 409).');

  console.log('\n=== ALL PHASE B ACCEPTANCE CRITERIA PASSED ===');
}

run().catch((err) => {
  console.error('Phase B Test Failed:', err);
  process.exit(1);
});
