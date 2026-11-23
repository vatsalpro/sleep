const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4888;
const BASE_DIR = path.resolve(__dirname);
const EVIDENCE_DIR = path.join(BASE_DIR, 'evidence');
const SCREENSHOTS_DIR = path.join(EVIDENCE_DIR, 'screenshots');
const EVENTS_FILE = path.join(EVIDENCE_DIR, 'events.jsonl');
const BUGS_FILE = path.join(EVIDENCE_DIR, 'bugs.jsonl');

const NATIVE_EXE = path.resolve(
  __dirname,
  '..',
  'sleepwalker-native',
  'bin',
  'Release',
  'net8.0-windows',
  'sleepwalker-native.exe'
);

// Ensure directories exist
for (const dir of [EVIDENCE_DIR, SCREENSHOTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Global state
let state = 'IDLE'; // IDLE, LISTENING, THINKING, PLANNING, OPERATING, STOPPED
let currentTestId = '';
let currentCommandId = '';
let currentStep = 0;
let lastCursor = { x: 0, y: 0 };
let lastActiveWindow = null;
let latestScreenshot = '';
let latestScreenshotRef = '';
const events = [];
const bugs = [];

// Load existing bugs from file if present
if (fs.existsSync(BUGS_FILE)) {
  try {
    const lines = fs.readFileSync(BUGS_FILE, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      bugs.push(JSON.parse(line));
    }
  } catch (err) {
    console.error('Error reading bugs file:', err);
  }
}

// Native Host Client implementing 4-byte framing
class NativeClient {
  constructor(exePath) {
    this.exePath = exePath;
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.exePath, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._processBuffer();
    });

    this.proc.on('exit', (code) => {
      console.log(`Native client process exited with code ${code}`);
      this.proc = null;
      for (const [id, req] of this.pending.entries()) {
        req.reject(new Error(`Native process exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  _processBuffer() {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      const messageBytes = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        const response = JSON.parse(messageBytes.toString('utf-8'));
        const id = response.requestId;
        if (this.pending.has(id)) {
          const { resolve, timer } = this.pending.get(id);
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(response);
        }
      } catch (err) {
        console.error('Failed to parse response payload:', err);
      }
    }
  }

  send(request) {
    if (!this.proc) this.start();
    return new Promise((resolve, reject) => {
      const requestId = request.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      request.requestId = requestId;

      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(`Native host timed out after ${request.timeoutMs || 5000}ms`));
        }
      }, (request.timeoutMs || 5000) + 1000);

      this.pending.set(requestId, { resolve, reject, timer });

      const jsonStr = JSON.stringify(request);
      const jsonBuf = Buffer.from(jsonStr, 'utf-8');
      const headerBuf = Buffer.alloc(4);
      headerBuf.writeUInt32LE(jsonBuf.length, 0);

      this.proc.stdin.write(Buffer.concat([headerBuf, jsonBuf]));
    });
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch (e) {}
      this.proc = null;
    }
  }
}

const nativeClient = new NativeClient(NATIVE_EXE);
nativeClient.start();

// Helper to capture desktop screenshot via native host CLI or action
async function captureDesktopScreenshot(filename) {
  const outputPath = path.join(SCREENSHOTS_DIR, filename);
  try {
    const res = await nativeClient.send({
      action: 'capture_screenshot',
      target: { text: outputPath },
      timeoutMs: 3000
    });
    if (res.success && fs.existsSync(outputPath)) {
      return {
        path: outputPath,
        url: `/evidence/screenshots/${filename}`,
        ref: `evidence/screenshots/${filename}`,
        width: res.result?.width || 1920,
        height: res.result?.height || 1200
      };
    }
  } catch (err) {
    console.error('Screenshot capture failed via native client:', err);
  }
  return null;
}

// Record structured event
function emitEvent(eventObj) {
  const fullEvent = {
    testId: currentTestId,
    commandId: currentCommandId,
    step: currentStep,
    timestamp: Date.now(),
    isoTime: new Date().toISOString(),
    ...eventObj
  };
  events.push(fullEvent);
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(fullEvent) + '\n', 'utf-8');
  } catch (e) {
    console.error('Failed to append event:', e);
  }
  return fullEvent;
}

// Emergency stop handler
async function handleEmergencyStop(reason = 'User clicked Emergency Stop') {
  state = 'STOPPED';
  try {
    await nativeClient.send({ action: 'emergency_stop', timeoutMs: 1000 });
  } catch (e) {}
  emitEvent({
    type: 'EMERGENCY_STOP',
    description: `Emergency Stop Triggered: ${reason}`,
    severity: 'CRITICAL'
  });
}

// Execute a high-level test command with dual observation lifecycle
async function executeObservedCommand(cmd) {
  if (state === 'STOPPED') {
    throw new Error('System is in EMERGENCY_STOP state. Reset required.');
  }

  currentTestId = cmd.testId || currentTestId || `TEST-${Date.now()}`;
  currentCommandId = cmd.commandId || `CMD-${Date.now()}`;
  currentStep = cmd.step !== undefined ? cmd.step : currentStep + 1;

  // 1. LISTENING
  state = 'LISTENING';
  emitEvent({
    type: 'STATE_CHANGE',
    state: 'LISTENING',
    description: `Received test command: ${cmd.action} (${cmd.description || ''})`
  });
  await new Promise((r) => setTimeout(r, 80));

  // 2. THINKING
  state = 'THINKING';
  emitEvent({
    type: 'STATE_CHANGE',
    state: 'THINKING',
    description: `Analyzing execution requirements for action: ${cmd.action}`
  });
  await new Promise((r) => setTimeout(r, 80));

  // 3. PLANNING
  state = 'PLANNING';
  // Query telemetry before action
  let preWindow = null;
  try {
    const winRes = await nativeClient.send({ action: 'get_active_window', timeoutMs: 1500 });
    preWindow = winRes.result || null;
    lastActiveWindow = preWindow;
  } catch (e) {}

  // Capture before screenshot
  const beforeShotName = `${currentTestId}_step${currentStep}_before.png`;
  const beforeShot = await captureDesktopScreenshot(beforeShotName);
  if (beforeShot) {
    latestScreenshot = beforeShot.url;
    latestScreenshotRef = beforeShot.ref;
  }

  emitEvent({
    type: 'STATE_CHANGE',
    state: 'PLANNING',
    description: `Planned execution for ${cmd.action}. Pre-state captured.`,
    activeWindow: preWindow ? `${preWindow.processName} (${preWindow.hwnd})` : 'None',
    screenshotRef: beforeShot?.ref || null
  });
  await new Promise((r) => setTimeout(r, 80));

  // 4. OPERATING (Executing physical Windows action)
  state = 'OPERATING';
  emitEvent({
    type: 'ACTION_START',
    state: 'OPERATING',
    action: cmd.action,
    target: cmd.target || {},
    description: `Executing physical desktop action: ${cmd.action}`
  });

  const startTime = Date.now();
  let actionResult = null;
  let actionError = null;

  try {
    actionResult = await nativeClient.send({
      action: cmd.action,
      target: cmd.target || {},
      windowIdentity: cmd.windowIdentity || null,
      timeoutMs: cmd.timeoutMs || 8000
    });
  } catch (err) {
    actionError = err.message;
  }

  const durationMs = Date.now() - startTime;

  // Post-action telemetry & capture
  let postWindow = null;
  let postCursor = { x: 0, y: 0 };
  try {
    const winRes = await nativeClient.send({ action: 'get_active_window', timeoutMs: 1500 });
    postWindow = winRes.result || null;
    lastActiveWindow = postWindow;

    const pingRes = await nativeClient.send({ action: 'ping', timeoutMs: 1500 });
    if (pingRes.result?.cursor) {
      postCursor = pingRes.result.cursor;
      lastCursor = postCursor;
    }
  } catch (e) {}

  const afterShotName = `${currentTestId}_step${currentStep}_after.png`;
  const afterShot = await captureDesktopScreenshot(afterShotName);
  if (afterShot) {
    latestScreenshot = afterShot.url;
    latestScreenshotRef = afterShot.ref;
  }

  // 5. IDLE (Completed)
  state = 'IDLE';
  emitEvent({
    type: 'ACTION_COMPLETE',
    state: 'IDLE',
    action: cmd.action,
    success: !actionError && actionResult?.success === true,
    error: actionError || actionResult?.error || null,
    durationMs,
    cursor: postCursor,
    window: postWindow ? `${postWindow.processName} (${postWindow.hwnd}) - "${postWindow.title}"` : 'None',
    screenshotRef: afterShot?.ref || null,
    description: `Completed ${cmd.action} in ${durationMs}ms. Success: ${!actionError && actionResult?.success === true}`
  });

  return {
    testId: currentTestId,
    commandId: currentCommandId,
    step: currentStep,
    action: cmd.action,
    success: !actionError && actionResult?.success === true,
    error: actionError || actionResult?.error || null,
    durationMs,
    cursor: postCursor,
    activeWindow: postWindow,
    beforeScreenshot: beforeShot?.ref || null,
    afterScreenshot: afterShot?.ref || null,
    result: actionResult?.result || null
  };
}

// HTTP Server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve Dashboard UI
  if (pathname === '/' || pathname === '/index.html') {
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

  // Serve Screenshot images
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

  // API: Get Status
  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        state,
        testId: currentTestId,
        commandId: currentCommandId,
        step: currentStep,
        cursor: lastCursor,
        activeWindow: lastActiveWindow,
        latestScreenshot,
        latestScreenshotRef,
        events: events.slice(-50),
        bugs
      })
    );
    return;
  }

  // API: Get Events
  if (pathname === '/api/events' && req.method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const filtered = events.filter((e) => e.timestamp > since);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(filtered));
    return;
  }

  // API: Get Bugs
  if (pathname === '/api/bugs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bugs));
    return;
  }

  // API: Submit Bug Report
  if (pathname === '/api/bugs' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const bugData = JSON.parse(body);
        if (!bugData.reporter || !bugData.description) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'reporter and description are required' }));
          return;
        }

        const bugReport = {
          id: `BUG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          reporter: bugData.reporter, // "Human" or "Antigravity"
          testId: bugData.testId || currentTestId || 'UNKNOWN',
          commandId: bugData.commandId || currentCommandId || null,
          step: bugData.step !== undefined ? bugData.step : currentStep,
          timestamp: Date.now(),
          isoTime: new Date().toISOString(),
          description: bugData.description,
          expectedBehavior: bugData.expectedBehavior || '',
          actualBehavior: bugData.actualBehavior || '',
          evidenceRef: bugData.evidenceRef || latestScreenshotRef || null,
          severity: bugData.severity || 'Medium',
          reproducibility: bugData.reproducibility || 'Always'
        };

        bugs.push(bugReport);
        fs.appendFileSync(BUGS_FILE, JSON.stringify(bugReport) + '\n', 'utf-8');

        emitEvent({
          type: 'BUG_REPORTED',
          reporter: bugReport.reporter,
          testId: bugReport.testId,
          description: `Bug filed by ${bugReport.reporter}: ${bugReport.description}`,
          severity: bugReport.severity
        });

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, bug: bugReport }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Submit Test Command
  if (pathname === '/api/test/command' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body);
        const result = await executeObservedCommand(cmd);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Emergency Stop
  if (pathname === '/api/emergency-stop' && req.method === 'POST') {
    handleEmergencyStop('Emergency stop API called').then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, state: 'STOPPED', message: 'Emergency stop activated' }));
    });
    return;
  }

  // API: Reset Emergency Stop
  if (pathname === '/api/reset' && req.method === 'POST') {
    state = 'IDLE';
    emitEvent({ type: 'STATE_CHANGE', state: 'IDLE', description: 'System reset from emergency stop' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, state: 'IDLE' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sleepwalker Dual Observation Hub running at http://127.0.0.1:${PORT}`);
});
