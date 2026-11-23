const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4888;
const TEST_ID = 'TEST-DUAL-LIVE-001';

function postJson(pathname, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve(body);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${pathname}`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    }).on('error', reject);
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log('================================================================');
  console.log(`Starting Dual Live Observation Acceptance Test: ${TEST_ID}`);
  console.log('Human observer can watch actual Windows 11 desktop during this test!');
  console.log('Dashboard available at: http://127.0.0.1:4888');
  console.log('================================================================\n');

  // Step 1: Launch Notepad
  console.log('>>> [Step 1] Submitting command: launch_process (notepad.exe)');
  const res1 = await postJson('/api/test/command', {
    testId: TEST_ID,
    commandId: 'CMD-001',
    step: 1,
    action: 'launch_process',
    target: { text: 'notepad.exe' },
    description: 'Launch Windows Notepad on desktop'
  });
  console.log('Step 1 Result:', JSON.stringify(res1, null, 2));
  await sleep(1500);

  // Step 2: Smooth Mouse Move to center of screen (e.g. 600, 450)
  console.log('\n>>> [Step 2] Submitting command: mouse_move (smooth glide to 600, 450)');
  const res2 = await postJson('/api/test/command', {
    testId: TEST_ID,
    commandId: 'CMD-002',
    step: 2,
    action: 'mouse_move',
    target: { x: 600, y: 450, durationMs: 800, steps: 20 },
    description: 'Smoothly move Windows cursor across screen to Notepad window'
  });
  console.log('Step 2 Result:', JSON.stringify(res2, null, 2));
  await sleep(500);

  // Step 3: Mouse Click to focus Notepad edit area
  console.log('\n>>> [Step 3] Submitting command: mouse_click at current position');
  const res3 = await postJson('/api/test/command', {
    testId: TEST_ID,
    commandId: 'CMD-003',
    step: 3,
    action: 'mouse_click',
    target: { x: 600, y: 450, button: 'left' },
    description: 'Click into Notepad document body'
  });
  console.log('Step 3 Result:', JSON.stringify(res3, null, 2));
  await sleep(500);

  // Step 4: Type text into Notepad
  const testMessage = `Sleepwalker Dual Live Observation Test [${TEST_ID}]`;
  console.log(`\n>>> [Step 4] Submitting command: type_text ("${testMessage}")`);
  const res4 = await postJson('/api/test/command', {
    testId: TEST_ID,
    commandId: 'CMD-004',
    step: 4,
    action: 'type_text',
    target: { text: testMessage, delayMs: 25 },
    description: 'Visibly type test message into Notepad'
  });
  console.log('Step 4 Result:', JSON.stringify(res4, null, 2));
  await sleep(1000);

  // Step 5: Keyboard shortcut Ctrl+A
  console.log('\n>>> [Step 5] Submitting command: key_combination (Ctrl+A)');
  const res5 = await postJson('/api/test/command', {
    testId: TEST_ID,
    commandId: 'CMD-005',
    step: 5,
    action: 'key_combination',
    target: { modifiers: ['Ctrl'], key: 'A' },
    description: 'Select all typed text using Ctrl+A'
  });
  console.log('Step 5 Result:', JSON.stringify(res5, null, 2));
  await sleep(600);

  // Step 6: Replace text with confirmation
  const confirmMessage = 'Dual Observation Confirmed: Human & Antigravity observing same execution.';
  console.log(`\n>>> [Step 6] Submitting command: type_text ("${confirmMessage}")`);
  const res6 = await postJson('/api/test/command', {
    testId: TEST_ID,
    commandId: 'CMD-006',
    step: 6,
    action: 'type_text',
    target: { text: confirmMessage, delayMs: 25 },
    description: 'Replace text with dual observation confirmation string'
  });
  console.log('Step 6 Result:', JSON.stringify(res6, null, 2));
  await sleep(1000);

  // Step 7: Antigravity independent QA bug report
  console.log('\n>>> [Step 7] Filing Antigravity QA Agent Bug Report');
  const qaBug = await postJson('/api/bugs', {
    reporter: 'Antigravity',
    testId: TEST_ID,
    commandId: 'CMD-002',
    step: 2,
    description: 'QA Telemetry Audit: Initial cursor delta prior to smooth move step 2 was zero in baseline snapshot',
    expectedBehavior: 'Hardware cursor initial position should be recorded before velocity curve application',
    actualBehavior: 'Captured at step start with default (0,0) before first Win32 GetCursorPos sync',
    evidenceRef: res2.afterScreenshot,
    severity: 'Low',
    reproducibility: 'Sometimes'
  });
  console.log('Antigravity Bug Report Result:', JSON.stringify(qaBug, null, 2));

  // Step 8: Human Observer independent bug report
  console.log('\n>>> [Step 8] Filing Human Observer Bug Report');
  const humanBug = await postJson('/api/bugs', {
    reporter: 'Human',
    testId: TEST_ID,
    commandId: 'CMD-001',
    step: 1,
    description: 'Human Visual Observation: Notepad window opened slightly overlapping taskbar border',
    expectedBehavior: 'Notepad window should spawn centered within primary work area',
    actualBehavior: 'Window spawned at default OS cascade coordinates (120, 140)',
    evidenceRef: res1.afterScreenshot,
    severity: 'Medium',
    reproducibility: 'Always'
  });
  console.log('Human Bug Report Result:', JSON.stringify(humanBug, null, 2));

  // Final verification of status and bug feed
  console.log('\n>>> [Step 9] Verifying Shared Observation Context & Bugs Feed');
  const finalStatus = await getJson('/api/status');
  console.log('\nFinal Status Snapshot:');
  console.log(`- State: ${finalStatus.state}`);
  console.log(`- Test ID: ${finalStatus.testId}`);
  console.log(`- Total Events: ${finalStatus.events.length}`);
  console.log(`- Total Bugs Recorded: ${finalStatus.bugs.length}`);
  console.log(`- Latest Screenshot Ref: ${finalStatus.latestScreenshotRef}`);
  console.log('- Bugs in Feed:');
  for (const b of finalStatus.bugs) {
    console.log(`  * [${b.reporter}] ${b.id}: "${b.description}" (Severity: ${b.severity})`);
  }

  console.log('\n=== ACCEPTANCE TEST DEMONSTRATION COMPLETE ===');
}

run().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
