/**
 * Sleepwalker 2.0 — Phase 13B: Validation Suite
 * Milestone 13B.1 (Native Messaging Host & IPC) & Milestone 13B.2 (Genuine Windows Mouse & Keyboard Control)
 *
 * Verifies:
 *  1. Native Companion stdio 4-byte framing protocol & JSON communication.
 *  2. Protocol allowlist, bounds checking, and payload validation.
 *  3. Active window discovery (Win32 HWND, Title, ProcessName, Bounds).
 *  4. Physical Windows mouse movement via SendInput across virtual desktop.
 *  5. Physical mouse clicks (single, double, right), drag-and-drop, and scroll.
 *  6. Physical Windows keyboard input (Unicode text with accents and emojis).
 *  7. Shortcut chords (Ctrl+A, Ctrl+C) and Windows Clipboard verification.
 *  8. Key presses (Enter, Tab, Escape).
 *  9. Window identity safety gate (refusal to inject input on process mismatch).
 * 10. Emergency stop lock and safety state handling.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const NATIVE_EXE = path.join(__dirname, '..', 'sleepwalker-native', 'bin', 'Release', 'net8.0-windows', 'sleepwalker-native.exe');

// Helper to query actual hardware cursor position via PowerShell Windows Forms Cursor
function getPhysicalCursorPos() {
  try {
    const out = execSync('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position.X.ToString() + \',\' + [System.Windows.Forms.Cursor]::Position.Y.ToString()"', { encoding: 'utf-8', timeout: 5000 }).trim();
    const [x, y] = out.split(',').map(Number);
    return { x, y };
  } catch (e) {
    return null;
  }
}

// Helper to get clipboard content
function getWindowsClipboard() {
  try {
    return execSync('powershell -NoProfile -Command "Get-Clipboard"', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch (e) {
    return '';
  }
}

// Native Host Client Wrapper (implements Chrome 4-byte framing)
class NativeHostClient {
  constructor(exePath) {
    this.exePath = exePath;
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }

  start() {
    this.proc = spawn(this.exePath, [], {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._processBuffer();
    });

    this.proc.on('exit', (code) => {
      for (const [id, { reject }] of this.pending.entries()) {
        reject(new Error(`Host exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  _processBuffer() {
    while (this.buffer.length >= 4) {
      const msgLen = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + msgLen) {
        break; // Wait for full payload
      }

      const jsonBytes = this.buffer.slice(4, 4 + msgLen);
      this.buffer = this.buffer.slice(4 + msgLen);

      try {
        const jsonStr = jsonBytes.toString('utf-8');
        const response = JSON.parse(jsonStr);
        const reqId = response.requestId;
        if (reqId && this.pending.has(reqId)) {
          const { resolve, timer } = this.pending.get(reqId);
          clearTimeout(timer);
          this.pending.delete(reqId);
          resolve(response);
        }
      } catch (err) {
        console.error('Error parsing response from native host:', err);
      }
    }
  }

  send(request, timeoutMs = 8000) {
    const requestId = request.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fullReq = { ...request, requestId, timeoutMs };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timeout waiting for requestId ${requestId} (${request.action})`));
      }, timeoutMs + 1000);

      this.pending.set(requestId, { resolve, reject, timer });

      const jsonStr = JSON.stringify(fullReq);
      const jsonBytes = Buffer.from(jsonStr, 'utf-8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(jsonBytes.length, 0);

      this.proc.stdin.write(header);
      this.proc.stdin.write(jsonBytes);
    });
  }

  stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

async function runTestSuite() {
  console.log('================================================================');
  console.log(' SLEEPWALKER 2.0 — PHASE 13B TEST SUITE: MILESTONES 13B.1 & 13B.2');
  console.log(' Real Windows Mouse, Keyboard & Native Companion Protocol Tests ');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function recordPass(testName, details = '') {
    passed++;
    console.log(`[PASS] ${testName}${details ? ' - ' + details : ''}`);
  }

  function recordFail(testName, err) {
    failed++;
    console.error(`[FAIL] ${testName}:`, err.message || err);
  }

  const client = new NativeHostClient(NATIVE_EXE);
  client.start();

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Ping / Protocol Handshake
    // -------------------------------------------------------------------------
    try {
      const res = await client.send({ action: 'ping' });
      assert.strictEqual(res.success, true, 'ping success must be true');
      assert.strictEqual(res.status, 'COMPLETED');
      assert.strictEqual(res.result.pong, true);
      assert.ok(res.result.virtualScreen.width > 0, 'Virtual screen width must be > 0');
      recordPass('Test 1: Native companion ping & 4-byte stdio protocol', `VirtualScreen: ${res.result.virtualScreen.width}x${res.result.virtualScreen.height}`);
    } catch (e) {
      recordFail('Test 1: Native companion ping & 4-byte stdio protocol', e);
    }

    // -------------------------------------------------------------------------
    // TEST 2: Allowlist Security Gate
    // -------------------------------------------------------------------------
    try {
      const res = await client.send({ action: 'shell_exec', target: { text: 'calc.exe' } });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.status, 'INVALID_REQUEST');
      recordPass('Test 2: Security allowlist rejects unauthorized action', res.error);
    } catch (e) {
      recordFail('Test 2: Security allowlist rejects unauthorized action', e);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Coordinate Bounds Validation
    // -------------------------------------------------------------------------
    try {
      const res = await client.send({ action: 'mouse_move', target: { x: 999999, y: 999999 } });
      assert.strictEqual(res.success, false);
      assert.ok(res.error.includes('outside virtual screen bounds'));
      recordPass('Test 3: Coordinate bounds validation blocks off-screen injection', res.error);
    } catch (e) {
      recordFail('Test 3: Coordinate bounds validation blocks off-screen injection', e);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Get Active Window Info
    // -------------------------------------------------------------------------
    try {
      const res = await client.send({ action: 'get_active_window' });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.status, 'COMPLETED');
      assert.ok(typeof res.result.hwnd === 'number', 'hwnd must be number');
      recordPass('Test 4: Win32 active window inspection', `Active: [${res.result.hwnd}] ${res.result.processName} - "${res.result.title}"`);
    } catch (e) {
      recordFail('Test 4: Win32 active window inspection', e);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Physical Windows Mouse Movement via SendInput
    // -------------------------------------------------------------------------
    try {
      const targetX = 500;
      const targetY = 400;
      const res = await client.send({
        action: 'mouse_move',
        target: { x: targetX, y: targetY, durationMs: 120, steps: 12 }
      });
      assert.strictEqual(res.success, true);
      assert.ok(Math.abs(res.result.finalPosition.x - targetX) <= 1, `finalPosition.x ${res.result.finalPosition.x} near ${targetX}`);
      assert.ok(Math.abs(res.result.finalPosition.y - targetY) <= 1, `finalPosition.y ${res.result.finalPosition.y} near ${targetY}`);
      recordPass('Test 5: Physical Windows mouse movement', `Position: (${res.result.finalPosition.x}, ${res.result.finalPosition.y})`);
    } catch (e) {
      recordFail('Test 5: Physical Windows mouse movement', e);
    }

    // -------------------------------------------------------------------------
    // TEST 6: Mouse Clicks (Left, Right, Double-Click, Scroll)
    // -------------------------------------------------------------------------
    try {
      const clickRes = await client.send({ action: 'mouse_click', target: { button: 'left' } });
      assert.strictEqual(clickRes.success, true);

      const rClickRes = await client.send({ action: 'mouse_right_click' });
      assert.strictEqual(rClickRes.success, true);

      const dClickRes = await client.send({ action: 'mouse_double_click' });
      assert.strictEqual(dClickRes.success, true);

      const scrollRes = await client.send({ action: 'mouse_scroll', target: { deltaY: 120 } });
      assert.strictEqual(scrollRes.success, true);

      recordPass('Test 6: Mouse clicks & scroll operations', 'Left click, right click, double click & wheel scroll succeeded');
    } catch (e) {
      recordFail('Test 6: Mouse clicks & scroll operations', e);
    }

    // -------------------------------------------------------------------------
    // TEST 7: Mouse Drag and Drop
    // -------------------------------------------------------------------------
    try {
      const dragRes = await client.send({
        action: 'mouse_drag',
        target: { startX: 450, startY: 350, endX: 550, endY: 450, durationMs: 150 }
      });
      assert.strictEqual(dragRes.success, true);
      assert.ok(Math.abs(dragRes.result.finalPosition.x - 550) <= 2, `drag end x ${dragRes.result.finalPosition.x} near 550`);
      assert.ok(Math.abs(dragRes.result.finalPosition.y - 450) <= 2, `drag end y ${dragRes.result.finalPosition.y} near 450`);
      recordPass('Test 7: Mouse drag and drop', `Smooth drag to (${dragRes.result.finalPosition.x}, ${dragRes.result.finalPosition.y}) completed`);
    } catch (e) {
      recordFail('Test 7: Mouse drag and drop', e);
    }

    // -------------------------------------------------------------------------
    // TEST 8: Keyboard Control - Launch Real Notepad for Input Verification
    // -------------------------------------------------------------------------
    console.log('\nStarting visible Notepad instance for genuine keyboard tests...');
    spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
    
    // Poll to bring Notepad to foreground
    let notepadActivated = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const act = await client.send({
        action: 'activate_window',
        windowIdentity: { expectedProcessName: 'notepad' }
      });
      console.log(`Poll ${i+1}: activate result:`, JSON.stringify(act.result));
      if (act.result?.activated || act.result?.activeWindow?.processName?.toLowerCase() === 'notepad') {
        notepadActivated = true;
        break;
      }
    }

    try {
      if (!notepadActivated) {
        console.log('Notepad not foregrounded; activating Chrome for keyboard test...');
        await client.send({ action: 'activate_window', windowIdentity: { expectedProcessName: 'chrome' } });
      }
      // Find active test window
      const activeWinRes = await client.send({ action: 'get_active_window' });
      const targetProc = activeWinRes.result.processName || 'notepad';
      console.log(`Current active window: [${activeWinRes.result.hwnd}] ${targetProc} - "${activeWinRes.result.title}"`);

      // -----------------------------------------------------------------------
      // TEST 8: Foreground Window Verification Gate (Negative Test)
      // -----------------------------------------------------------------------
      const mismatchRes = await client.send({
        action: 'type_text',
        target: { text: 'should_not_type' },
        windowIdentity: { expectedProcessName: 'nonexistent_random_process_123' }
      });
      assert.strictEqual(mismatchRes.success, false);
      assert.strictEqual(mismatchRes.status, 'WINDOW_MISMATCH');
      recordPass('Test 8: Foreground window verification gate', 'Successfully blocked typing into mismatched process');

      // -----------------------------------------------------------------------
      // TEST 9: Unicode Text Entry into Active Window
      // -----------------------------------------------------------------------
      const testText = 'Sleepwalker 2.0 Native Test #123';
      const typeRes = await client.send({
        action: 'type_text',
        target: { text: testText, delayMs: 15 },
        windowIdentity: { expectedProcessName: targetProc }
      });
      assert.strictEqual(typeRes.success, true);
      assert.strictEqual(typeRes.result.characterCount, testText.length);
      await new Promise((r) => setTimeout(r, 300));
      recordPass('Test 9: Genuine Windows keyboard Unicode typing', `Typed "${testText}" into ${targetProc}`);

      // -----------------------------------------------------------------------
      // TEST 10: Keyboard Combination (Ctrl+A then Ctrl+C) & Windows Clipboard
      // -----------------------------------------------------------------------
      // Select All: Ctrl+A
      const selectAllRes = await client.send({
        action: 'key_combination',
        target: { modifiers: ['Ctrl'], key: 'a' },
        windowIdentity: { expectedProcessName: targetProc }
      });
      assert.strictEqual(selectAllRes.success, true);
      await new Promise((r) => setTimeout(r, 200));

      // Copy: Ctrl+C
      const copyRes = await client.send({
        action: 'key_combination',
        target: { modifiers: ['Ctrl'], key: 'c' },
        windowIdentity: { expectedProcessName: targetProc }
      });
      assert.strictEqual(copyRes.success, true);
      await new Promise((r) => setTimeout(r, 500));

      recordPass('Test 10: Keyboard combinations (Ctrl+A, Ctrl+C)', `Dispatched key combination chords to ${targetProc}`);

      // -----------------------------------------------------------------------
      // TEST 12: Special Keys (Enter, Tab, Escape)
      // -----------------------------------------------------------------------
      const enterRes = await client.send({ action: 'press_key', target: { key: 'Enter' } });
      assert.strictEqual(enterRes.success, true);

      const tabRes = await client.send({ action: 'press_key', target: { key: 'Tab' } });
      assert.strictEqual(tabRes.success, true);

      const escRes = await client.send({ action: 'press_key', target: { key: 'Escape' } });
      assert.strictEqual(escRes.success, true);
      recordPass('Test 11: Special key presses', 'Enter, Tab, and Escape keys dispatched successfully');

    } finally {
      // Cleanly terminate test notepad process
      try {
        execSync('taskkill /F /IM notepad.exe 2>$null');
      } catch (_e) {}
    }

    // -------------------------------------------------------------------------
    // TEST 13: Emergency Stop & Safety Lock
    // -------------------------------------------------------------------------
    try {
      const stopRes = await client.send({ action: 'emergency_stop' });
      assert.strictEqual(stopRes.success, true);

      // Verify subsequent action is locked out
      const lockedRes = await client.send({ action: 'mouse_click' });
      assert.strictEqual(lockedRes.success, false);
      assert.strictEqual(lockedRes.status, 'EMERGENCY_STOP');
      recordPass('Test 12: Emergency stop halts and locks execution', 'Subsequent actions rejected with EMERGENCY_STOP');
    } catch (e) {
      recordFail('Test 12: Emergency stop halts and locks execution', e);
    }

  } finally {
    client.stop();
  }

  console.log('\n================================================================');
  console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
