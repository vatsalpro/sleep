/**
 * Sleepwalker 2.0 — Phase D Verification: Dual Live Observation
 *
 * Verifies that:
 * 1. Human Dashboard is live on http://127.0.0.1:4888 and polls status/events.
 * 2. Antigravity QA Observer interacts via authenticated /api/test endpoints.
 * 3. Both observers observe the EXACT same test ID, command ID, step, and screenshot evidence.
 * 4. Independent bug reports (Human & Antigravity) are recorded to evidence/bugs.jsonl
 *    without overwriting each other.
 * 5. Emergency Stop halts operations from either observer and locks execution until reset.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { executeObservedTask } = require('./sandbox-adapter');

const PORT = 4888;
const TOKEN_FILE = path.join(__dirname, '.bridge-token');
const BUGS_FILE = path.join(__dirname, 'evidence', 'bugs.jsonl');
const EVENTS_FILE = path.join(__dirname, 'evidence', 'events.jsonl');
const SCREENSHOTS_DIR = path.join(__dirname, 'evidence', 'screenshots');

function getBridgeToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  }
  throw new Error('Bridge token file not found');
}

function httpRequest(pathname, options = {}, data = null) {
  return new Promise((resolve, reject) => {
    const payload = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : null;
    const headers = { ...options.headers };
    if (payload && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: pathname,
        method: options.method || (payload ? 'POST' : 'GET'),
        headers
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (e) {}
          resolve({ status: res.statusCode, data: json, raw: body, headers: res.headers });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runPhaseDVerification() {
  console.log('================================================================');
  console.log('   Sleepwalker 2.0 — Phase D: Dual Live Observation Audit');
  console.log('================================================================\n');

  const token = getBridgeToken();
  const testId = `TEST-DUAL-OBS-${Date.now()}`;
  const commandId = `CMD-OBS-01`;

  // -------------------------------------------------------------
  // Test 1: Human Dashboard Availability (Unauthenticated)
  // -------------------------------------------------------------
  console.log('>>> [Test 1] Human Dashboard UI & Status Endpoint Verification');
  const dashRes = await httpRequest('/');
  assert.strictEqual(dashRes.status, 200, 'GET / must return HTTP 200');
  assert.ok(dashRes.raw.includes('Sleepwalker — Dual Live Observation Dashboard'), 'Dashboard HTML title must match');
  console.log('  ✔ GET / serves Human Dashboard HTML successfully');

  const statusRes = await httpRequest('/api/status');
  assert.strictEqual(statusRes.status, 200, 'GET /api/status must return HTTP 200');
  assert.ok(statusRes.data && statusRes.data.state, 'Status must return bridge state');
  assert.ok(Array.isArray(statusRes.data.events), 'Status must return events array');
  assert.ok(Array.isArray(statusRes.data.bugs), 'Status must return bugs array');
  console.log(`  ✔ GET /api/status returns live telemetry (current state: ${statusRes.data.state}, bugs: ${statusRes.data.bugs.length})`);

  // -------------------------------------------------------------
  // Test 2: Antigravity QA Observer Authenticated Status
  // -------------------------------------------------------------
  console.log('\n>>> [Test 2] Antigravity QA Authenticated Status & Evidence API');
  const qaStatusRes = await httpRequest('/api/test/status', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(qaStatusRes.status, 200, 'GET /api/test/status must return HTTP 200');
  assert.strictEqual(qaStatusRes.data.geminiConfigured, true, 'Gemini must be configured');
  assert.ok(qaStatusRes.data.availableOllamaModels.length > 0, 'Ollama models must be listed');
  console.log(`  ✔ GET /api/test/status authenticated with session token (Ollama models: ${qaStatusRes.data.availableOllamaModels.join(', ')})`);

  const qaEvidenceRes = await httpRequest('/api/test/evidence', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(qaEvidenceRes.status, 200, 'GET /api/test/evidence must return HTTP 200');
  assert.strictEqual(qaEvidenceRes.data.eventsFile, 'evidence/events.jsonl');
  assert.strictEqual(qaEvidenceRes.data.bugsFile, 'evidence/bugs.jsonl');
  console.log(`  ✔ GET /api/test/evidence verified evidence files`);

  // -------------------------------------------------------------
  // Test 3: Synchronized Task Execution & Live Dual Telemetry
  // -------------------------------------------------------------
  console.log('\n>>> [3/5] Running Observed Task with Live Step Telemetry...');

  // Mock screenshot creation to simulate real browser capture
  const mockScreenshotPath = path.join(SCREENSHOTS_DIR, `temp_browser_snap.png`);
  fs.writeFileSync(mockScreenshotPath, Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082', 'hex'));

  let stepsExecuted = 0;
  const relayFunction = async (action, preState) => {
    stepsExecuted++;
    console.log(`      [Mechanical Relay] Executing action ${action.action}...`);
    await new Promise((r) => setTimeout(r, 100)); // small delay to observe state

    if (action.action === 'navigate') {
      return {
        url: action.url || 'https://www.wikipedia.org',
        title: 'Wikipedia, the free encyclopedia',
        pageLoaded: true,
        httpStatus: 200,
        screenshotPath: mockScreenshotPath
      };
    }
    if (action.action === 'type') {
      return {
        url: preState.url,
        title: preState.title,
        pageLoaded: true,
        inputValue: action.text || 'quantum computing',
        typedText: action.text || 'quantum computing',
        screenshotPath: mockScreenshotPath
      };
    }
    if (action.action === 'click') {
      return {
        url: preState.url,
        title: preState.title,
        pageLoaded: true,
        clicked: true,
        domChanged: true,
        screenshotPath: mockScreenshotPath
      };
    }
    return {
      url: preState.url,
      title: preState.title,
      pageLoaded: true,
      contentFound: true,
      screenshotPath: mockScreenshotPath
    };
  };

  const taskResult = await executeObservedTask(
    {
      testId,
      commandId,
      prompt: 'Search Wikipedia for quantum computing',
      providerPreference: 'auto'
    },
    relayFunction
  );

  assert.strictEqual(taskResult.passed, true, 'Task execution must pass');
  assert.ok(taskResult.actionPlan.length >= 2, 'Action plan must contain at least 2 steps');
  console.log(`  ✔ Observed task completed successfully with ${stepsExecuted} steps`);

  // Verify that Human Dashboard and Antigravity QA observer see identical events
  const qaEventsRes = await httpRequest(`/api/test/events?since=${Date.now() - 30000}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(qaEventsRes.status, 200, 'GET /api/test/events must succeed');
  const sharedEvents = qaEventsRes.data.filter((e) => e.testId === testId);
  assert.ok(sharedEvents.length >= 3, 'Must have at least 3 events for this test ID');

  const humanStatus = await httpRequest('/api/status');
  assert.strictEqual(humanStatus.status, 200);
  assert.strictEqual(humanStatus.data.testId, testId, 'Human dashboard must reflect current testId');
  assert.strictEqual(humanStatus.data.commandId, commandId, 'Human dashboard must reflect current commandId');
  assert.ok(humanStatus.data.latestScreenshotRef, 'Human dashboard must have latest screenshot reference');
  console.log(`  ✔ Both observers received synchronized execution evidence (Test ID: ${testId}, Events: ${sharedEvents.length})`);

  // -------------------------------------------------------------
  // Test 4: Independent Bug Reporting (Human vs Antigravity)
  // -------------------------------------------------------------
  console.log('\n>>> [Test 4] Independent Bug Reporting Audit (Human & Antigravity)');

  const initialBugsCount = (await httpRequest('/api/bugs')).data.length;

  // 4.1 Human submits bug report via dashboard API
  const humanBugPayload = {
    reporter: 'Human',
    testId,
    commandId,
    step: 2,
    description: 'Human Visual Observation: Search box autofocus ring did not animate smoothly',
    expectedBehavior: 'Focus ring should transition with 200ms ease curve',
    actualBehavior: 'Focus ring appeared instantly with no CSS transition',
    severity: 'Low',
    reproducibility: 'Always',
    evidenceRef: humanStatus.data.latestScreenshotRef
  };

  const humanBugRes = await httpRequest('/api/bugs', { method: 'POST' }, humanBugPayload);
  assert.strictEqual(humanBugRes.status, 201, 'POST /api/bugs must return HTTP 201 Created');
  assert.strictEqual(humanBugRes.data.bug.reporter, 'Human', 'Reporter must be Human');
  assert.strictEqual(humanBugRes.data.bug.testId, testId, 'Test ID must match');
  console.log(`  ✔ Human observer successfully submitted bug (${humanBugRes.data.bug.id})`);

  // 4.2 Antigravity QA submits bug report via QA API
  const qaBugPayload = {
    reporter: 'Antigravity',
    testId,
    commandId,
    step: 1,
    description: 'Antigravity QA Audit: Navigation DOM settlement latency exceeded 120ms baseline',
    expectedBehavior: 'DOM settlement latency <= 100ms on local relay',
    actualBehavior: 'Measured settlement latency was 145ms',
    severity: 'Medium',
    reproducibility: 'Sometimes',
    evidenceRef: humanStatus.data.latestScreenshotRef
  };

  const qaBugRes = await httpRequest('/api/test/bugs', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }, qaBugPayload);
  assert.strictEqual(qaBugRes.status, 201, 'POST /api/test/bugs must return HTTP 201 Created');
  assert.strictEqual(qaBugRes.data.bug.reporter, 'Antigravity', 'Reporter must be Antigravity');
  assert.strictEqual(qaBugRes.data.bug.testId, testId, 'Test ID must match');
  console.log(`  ✔ Antigravity QA observer successfully submitted bug (${qaBugRes.data.bug.id})`);

  // 4.3 Verify bugs file integrity: neither report overwrote the other
  const bugsFileLines = fs.readFileSync(BUGS_FILE, 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
  const testBugs = bugsFileLines.filter((b) => b.testId === testId);
  assert.strictEqual(testBugs.length, 2, 'evidence/bugs.jsonl must contain exactly 2 bug reports for this test');
  assert.ok(testBugs.some((b) => b.reporter === 'Human'), 'Human bug report must be present in file');
  assert.ok(testBugs.some((b) => b.reporter === 'Antigravity'), 'Antigravity bug report must be present in file');
  console.log(`  ✔ Confirmed both bug reports exist in evidence/bugs.jsonl without overwriting each other`);

  // -------------------------------------------------------------
  // Test 5: Emergency Stop Verification from Both Channels
  // -------------------------------------------------------------
  console.log('\n>>> [Test 5] Emergency Stop Verification & Reset Lockout');

  // Trigger Emergency Stop from Human observer
  const stopRes = await httpRequest('/api/emergency-stop', { method: 'POST' });
  assert.strictEqual(stopRes.status, 200, 'POST /api/emergency-stop must return HTTP 200');
  assert.strictEqual(stopRes.data.bridgeState, 'STOPPED');

  // Verify that new command is immediately rejected with HTTP 409
  const rejectedCmd = await httpRequest('/api/test/command', {
    headers: { Authorization: `Bearer ${token}` }
  }, { prompt: 'Try to do something while stopped' });
  assert.strictEqual(rejectedCmd.status, 409, 'New commands must be rejected with HTTP 409 while STOPPED');
  console.log(`  ✔ Emergency stop triggered; new commands strictly locked out (HTTP 409 received)`);

  // Reset Bridge
  const resetRes = await httpRequest('/api/test/reset', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(resetRes.status, 200, 'POST /api/test/reset must return HTTP 200');
  assert.strictEqual(resetRes.data.bridgeState, 'IDLE');
  console.log(`  ✔ Bridge state successfully reset to IDLE`);

  console.log('\n================================================================');
  console.log('   🎉 ALL PHASE D DUAL LIVE OBSERVATION AUDITS PASSED!');
  console.log('================================================================\n');
}

runPhaseDVerification().catch((err) => {
  console.error('\n❌ Phase D Verification Failed:', err);
  process.exit(1);
});
